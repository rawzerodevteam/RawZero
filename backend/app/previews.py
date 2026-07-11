"""Vignettes, previews de tri et cache de la base de développement.

Stratégie performance :
- import   → JPEG embarqué du RAW (rapide) → thumb 360 + preview 2048 ;
- develop  → décodage RAW unique → base 2560px float16 (.npy) + LRU mémoire ;
- sauvegarde d'edits → regénération thumb/preview EN ARRIÈRE-PLAN depuis la base,
  pour que la grille et le mode tri reflètent les retouches sans décodage RAW.
"""
import json
import logging
import shutil
import threading
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from . import config, db, denoise, pipeline, raw_loader

log = logging.getLogger(__name__)
executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="rawstudio-bg")

# Cache « froid » : float16, borne la RAM sur un grand nombre de photos (cf. O2).
# Cache « chaud » : float32 de la/les photo(s) en cours d'édition, pour que les rendus
# répétés (drag de slider) NE reconvertissent PAS float16→float32 à chaque fois (~24 ms +
# 52 Mo alloués par appel sinon — get_base est sur le chemin chaud de chaque rendu).
_base_cache: "OrderedDict[int, np.ndarray]" = OrderedDict()   # float16
_base_hot: "OrderedDict[int, np.ndarray]" = OrderedDict()     # float32
_base_lock = threading.Lock()
_BASE_CACHE_MAX = 8
_BASE_HOT_MAX = 2

_dn_cache: "OrderedDict[int, np.ndarray]" = OrderedDict()     # float16
_dn_hot: "OrderedDict[int, np.ndarray]" = OrderedDict()       # float32
_dn_lock = threading.Lock()
_DN_CACHE_MAX = 4
_DN_HOT_MAX = 2


def _hot_put(hot: "OrderedDict[int, np.ndarray]", photo_id: int, arr: np.ndarray, cap: int) -> np.ndarray:
    hot[photo_id] = arr
    hot.move_to_end(photo_id)
    while len(hot) > cap:
        hot.popitem(last=False)
    return arr

# B2 — un verrou de décodage par photo : deux requêtes concurrentes sur une base
# non cachée (navigation rapide en mode Dev, le client coupe mais l'endpoint sync
# continue) ne doivent décoder LibRaw qu'une seule fois ; la 2ᵉ attend la 1ʳᵉ.
# N2 — tables LRU bornées : sans éviction, une session parcourant des milliers de
# photos accumulait un Lock par photo (fuite mémoire non bornée). Évincer un verrou
# inutilisé est sûr : au pire deux décodages concurrents pour une photo dont le verrou
# vient de disparaître (exactement la situation d'avant B2, tolérable et rarissime).
_decode_locks: "OrderedDict[int, threading.Lock]" = OrderedDict()
_dn_decode_locks: "OrderedDict[int, threading.Lock]" = OrderedDict()
_decode_locks_guard = threading.Lock()
_DECODE_LOCKS_MAX = 64


def _keyed_lock(table: "OrderedDict[int, threading.Lock]", photo_id: int) -> threading.Lock:
    with _decode_locks_guard:
        lk = table.get(photo_id)
        if lk is None:
            lk = threading.Lock()
            table[photo_id] = lk
        table.move_to_end(photo_id)
        while len(table) > _DECODE_LOCKS_MAX:
            table.popitem(last=False)
        return lk


def _photo_decode_lock(photo_id: int) -> threading.Lock:
    return _keyed_lock(_decode_locks, photo_id)


def _photo_denoise_lock(photo_id: int) -> threading.Lock:
    # Verrou distinct du décodage : get_denoised_base appelle get_base à l'intérieur
    # de sa section critique → un verrou partagé (non réentrant) interbloquerait.
    return _keyed_lock(_dn_decode_locks, photo_id)


def thumb_path(photo_id: int) -> Path:
    return config.THUMBS_DIR / f"{photo_id}.jpg"


def preview_path(photo_id: int) -> Path:
    return config.PREVIEWS_DIR / f"{photo_id}.jpg"


def base_path(photo_id: int) -> Path:
    return config.BASE_DIR / f"{photo_id}.npy"


def denoised_base_path(photo_id: int) -> Path:
    return config.BASE_DIR / f"{photo_id}.dn.npy"


def _resize_long_edge(arr: np.ndarray, size: int) -> np.ndarray:
    h, w = arr.shape[:2]
    long_edge = max(h, w)
    if long_edge <= size:
        return arr
    f = size / long_edge
    return cv2.resize(arr, (max(int(w * f), 1), max(int(h * f), 1)), interpolation=cv2.INTER_AREA)


def _save_jpeg_u8(arr: np.ndarray, path: Path, quality: int = 86) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(path), cv2.cvtColor(arr, cv2.COLOR_RGB2BGR),
                [int(cv2.IMWRITE_JPEG_QUALITY), quality])


def generate_initial_previews(photo_id: int, original: Path, orientation: "int | None" = None) -> None:
    """À l'import : préférer le JPEG embarqué (pas de décodage RAW complet).

    `orientation` : valeur EXIF déjà connue à l'import, transmise pour ne pas re-lire l'EXIF."""
    img = raw_loader.extract_embedded_jpeg(original, orientation)
    if img is not None:
        arr = np.asarray(img.convert("RGB"))
    else:
        full = raw_loader.decode_full(original)
        arr = (np.clip(_resize_long_edge(full, config.PREVIEW_SIZE), 0, 1) * 255).astype(np.uint8)
    _save_jpeg_u8(_resize_long_edge(arr, config.PREVIEW_SIZE), preview_path(photo_id), 88)
    _save_jpeg_u8(_resize_long_edge(arr, config.THUMB_SIZE), thumb_path(photo_id), 82)


def get_base(photo_id: int, original: Path) -> np.ndarray:
    """Base de développement float32 (≤ BASE_SIZE), cache mémoire + disque.

    O2 — le cache froid stocke des float16 (comme le disque) pour borner la RAM ; un petit
    cache chaud garde la version float32 de la photo active pour ne pas reconvertir à chaque
    rendu. La précision est déjà celle de float16 dès qu'une session recharge depuis le `.npy`,
    donc aucune perte de fidélité nouvelle vs le rechargement disque."""
    with _base_lock:
        if photo_id in _base_hot:                       # chemin chaud : float32 prêt, 0 conversion
            _base_hot.move_to_end(photo_id)
            return _base_hot[photo_id]
        if photo_id in _base_cache:
            _base_cache.move_to_end(photo_id)
            return _hot_put(_base_hot, photo_id, _base_cache[photo_id].astype(np.float32), _BASE_HOT_MAX)
    with _photo_decode_lock(photo_id):
        # Re-vérif sous le verrou de décodage : une requête concurrente a pu
        # remplir le cache pendant qu'on l'attendait → on évite un 2ᵉ décodage.
        with _base_lock:
            if photo_id in _base_hot:
                _base_hot.move_to_end(photo_id)
                return _base_hot[photo_id]
        npy = base_path(photo_id)
        arr16: np.ndarray  # float16 (cache mémoire et disque)
        if npy.exists():
            try:
                arr16 = np.load(npy).astype(np.float16)
            except Exception:
                npy.unlink(missing_ok=True)
                arr16 = _decode_base(photo_id, original)
        else:
            arr16 = _decode_base(photo_id, original)
        with _base_lock:
            _base_cache[photo_id] = arr16
            _base_cache.move_to_end(photo_id)
            while len(_base_cache) > _BASE_CACHE_MAX:
                _base_cache.popitem(last=False)
            return _hot_put(_base_hot, photo_id, arr16.astype(np.float32), _BASE_HOT_MAX)


def _decode_base(photo_id: int, original: Path) -> np.ndarray:
    # La base est bornée à BASE_SIZE (2560) : un dématriçage demi-résolution suffit largement
    # pour les RAW modernes (≥ 5000 px → ≥ 2500 px) et divise ~par 2 le temps de décodage.
    # L'export, lui, décode toujours en pleine résolution.
    # Renvoie du float16 (cache mémoire + disque, cf. O2) ; get_base upcast au renvoi.
    full = raw_loader.decode_full(original, half_size=True)
    arr16 = _resize_long_edge(full, config.BASE_SIZE).astype(np.float16)
    del full
    try:
        base_path(photo_id).parent.mkdir(parents=True, exist_ok=True)
        np.save(base_path(photo_id), arr16)
    except Exception as e:
        log.warning("Cache base impossible pour #%s : %s", photo_id, e)
    return arr16


def get_denoised_base(photo_id: int, original: Path) -> "np.ndarray | None":
    """Base de développement débruitée par IA (force de référence fixe), cache mémoire + disque.

    Calculée une seule fois (inférence FFDNet tuilée) ; le slider ne fait ensuite qu'un mélange
    linéaire bruité↔débruité. Renvoie None si le moteur/modèle est indisponible."""
    if not denoise.available():
        return None
    with _dn_lock:
        if photo_id in _dn_hot:
            _dn_hot.move_to_end(photo_id)
            return _dn_hot[photo_id]
        if photo_id in _dn_cache:
            _dn_cache.move_to_end(photo_id)
            return _hot_put(_dn_hot, photo_id, _dn_cache[photo_id].astype(np.float32), _DN_HOT_MAX)
    with _photo_denoise_lock(photo_id):
        # Re-vérif sous verrou : une requête concurrente a pu finir l'inférence
        # FFDNet (coûteuse) pendant qu'on l'attendait.
        with _dn_lock:
            if photo_id in _dn_hot:
                _dn_hot.move_to_end(photo_id)
                return _dn_hot[photo_id]
        npy = denoised_base_path(photo_id)
        arr16: "np.ndarray | None"  # float16 (cache mémoire + disque, cf. O2)
        if npy.exists():
            try:
                arr16 = np.load(npy).astype(np.float16)
            except Exception:
                npy.unlink(missing_ok=True)
                arr16 = None
        else:
            arr16 = None
        if arr16 is None:
            try:
                arr16 = denoise.denoise(get_base(photo_id, original)).astype(np.float16)
            except denoise.DenoiseUnavailable:
                return None
            except Exception as e:
                log.warning("Débruitage IA échoué pour #%s : %s", photo_id, e)
                return None
            try:
                npy.parent.mkdir(parents=True, exist_ok=True)
                np.save(npy, arr16)
            except Exception as e:
                log.warning("Cache base débruitée impossible pour #%s : %s", photo_id, e)
        with _dn_lock:
            _dn_cache[photo_id] = arr16
            _dn_cache.move_to_end(photo_id)
            while len(_dn_cache) > _DN_CACHE_MAX:
                _dn_cache.popitem(last=False)
            return _hot_put(_dn_hot, photo_id, arr16.astype(np.float32), _DN_HOT_MAX)


def invalidate(photo_id: int) -> None:
    with _base_lock:
        _base_cache.pop(photo_id, None)
        _base_hot.pop(photo_id, None)
    with _dn_lock:
        _dn_cache.pop(photo_id, None)
        _dn_hot.pop(photo_id, None)
    for p in (thumb_path(photo_id), preview_path(photo_id), base_path(photo_id),
              denoised_base_path(photo_id)):
        p.unlink(missing_ok=True)
    mask_dir = config.MASKS_DIR / str(photo_id)
    if mask_dir.exists():
        shutil.rmtree(mask_dir, ignore_errors=True)


def full_long_edge(row: dict) -> int:
    return max(int(row.get("width") or 0), int(row.get("height") or 0)) or config.BASE_SIZE


_refresh_pending: "set[int]" = set()
_refresh_guard = threading.Lock()


def schedule_preview_refresh(photo_id: int) -> None:
    """Après sauvegarde d'edits : thumb + preview re-rendus depuis la base, en fond.

    B3 — coalescence : des sauvegardes rapprochées (drag de slider) ne doivent pas
    empiler des rendus redondants. Si un job est déjà en attente pour cette photo, on
    ne réenfile rien : le job lira de toute façon les edits **les plus récents** depuis
    la DB à son démarrage (la DB est écrite avant cet appel)."""
    with _refresh_guard:
        if photo_id in _refresh_pending:
            return
        _refresh_pending.add(photo_id)
    executor.submit(_refresh_previews_job, photo_id)


def _refresh_previews_job(photo_id: int) -> None:
    # Libérer le drapeau au démarrage : toute sauvegarde survenant après ce point
    # (donc avec des edits potentiellement plus récents) réenfilera son propre job.
    with _refresh_guard:
        _refresh_pending.discard(photo_id)
    try:
        row = db.query_one("SELECT * FROM photos WHERE id=?", (photo_id,))
        if row is None:
            return
        original = config.ORIGINALS_DIR / row["relpath"]
        edits = json.loads(row["edits"] or "{}")
        base = get_base(photo_id, original)
        rendered = pipeline.render_array(base, edits, config.PREVIEW_SIZE,
                                         full_long_edge(dict(row)), seed=photo_id)
        _save_jpeg_u8(rendered, preview_path(photo_id), 88)
        _save_jpeg_u8(_resize_long_edge(rendered, config.THUMB_SIZE), thumb_path(photo_id), 82)
    except Exception as e:
        log.warning("Refresh preview #%s échoué : %s", photo_id, e)


def placeholder_jpeg() -> bytes:
    arr = np.full((90, 120, 3), 38, np.uint8)
    return pipeline.encode_jpeg(arr, 70)
