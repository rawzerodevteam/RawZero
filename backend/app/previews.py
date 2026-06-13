"""Vignettes, previews de tri et cache de la base de développement.

Stratégie performance :
- import   → JPEG embarqué du RAW (rapide) → thumb 360 + preview 2048 ;
- develop  → décodage RAW unique → base 2560px float16 (.npy) + LRU mémoire ;
- sauvegarde d'edits → regénération thumb/preview EN ARRIÈRE-PLAN depuis la base,
  pour que la grille et le mode tri reflètent les retouches sans décodage RAW.
"""
import json
import logging
import threading
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from . import config, db, pipeline, raw_loader

log = logging.getLogger(__name__)
executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="rawstudio-bg")

_base_cache: "OrderedDict[int, np.ndarray]" = OrderedDict()
_base_lock = threading.Lock()
_BASE_CACHE_MAX = 8


def thumb_path(photo_id: int) -> Path:
    return config.THUMBS_DIR / f"{photo_id}.jpg"


def preview_path(photo_id: int) -> Path:
    return config.PREVIEWS_DIR / f"{photo_id}.jpg"


def base_path(photo_id: int) -> Path:
    return config.BASE_DIR / f"{photo_id}.npy"


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


def generate_initial_previews(photo_id: int, original: Path) -> None:
    """À l'import : préférer le JPEG embarqué (pas de décodage RAW complet)."""
    img = raw_loader.extract_embedded_jpeg(original)
    if img is not None:
        arr = np.asarray(img.convert("RGB"))
    else:
        full = raw_loader.decode_full(original)
        arr = (np.clip(_resize_long_edge(full, config.PREVIEW_SIZE), 0, 1) * 255).astype(np.uint8)
    _save_jpeg_u8(_resize_long_edge(arr, config.PREVIEW_SIZE), preview_path(photo_id), 88)
    _save_jpeg_u8(_resize_long_edge(arr, config.THUMB_SIZE), thumb_path(photo_id), 82)


def get_base(photo_id: int, original: Path) -> np.ndarray:
    """Base de développement float32 (≤ BASE_SIZE), cache mémoire + disque."""
    with _base_lock:
        if photo_id in _base_cache:
            _base_cache.move_to_end(photo_id)
            return _base_cache[photo_id]
    npy = base_path(photo_id)
    arr: np.ndarray
    if npy.exists():
        try:
            arr = np.load(npy).astype(np.float32)
        except Exception:
            npy.unlink(missing_ok=True)
            arr = _decode_base(photo_id, original)
    else:
        arr = _decode_base(photo_id, original)
    with _base_lock:
        _base_cache[photo_id] = arr
        _base_cache.move_to_end(photo_id)
        while len(_base_cache) > _BASE_CACHE_MAX:
            _base_cache.popitem(last=False)
    return arr


def _decode_base(photo_id: int, original: Path) -> np.ndarray:
    full = raw_loader.decode_full(original)
    arr = _resize_long_edge(full, config.BASE_SIZE)
    del full
    try:
        base_path(photo_id).parent.mkdir(parents=True, exist_ok=True)
        np.save(base_path(photo_id), arr.astype(np.float16))
    except Exception as e:
        log.warning("Cache base impossible pour #%s : %s", photo_id, e)
    return arr.astype(np.float32)


def invalidate(photo_id: int) -> None:
    with _base_lock:
        _base_cache.pop(photo_id, None)
    for p in (thumb_path(photo_id), preview_path(photo_id), base_path(photo_id)):
        p.unlink(missing_ok=True)


def full_long_edge(row: dict) -> int:
    return max(int(row.get("width") or 0), int(row.get("height") or 0)) or config.BASE_SIZE


def schedule_preview_refresh(photo_id: int) -> None:
    """Après sauvegarde d'edits : thumb + preview re-rendus depuis la base, en fond."""
    executor.submit(_refresh_previews_job, photo_id)


def _refresh_previews_job(photo_id: int) -> None:
    try:
        row = db.query_one("SELECT * FROM photos WHERE id=?", (photo_id,))
        if row is None:
            return
        original = config.ORIGINALS_DIR / row["relpath"]
        edits = json.loads(row["edits"] or "{}")
        base = get_base(photo_id, original)
        rendered = pipeline.render_array(base, edits, config.PREVIEW_SIZE,
                                         full_long_edge(dict(row)))
        _save_jpeg_u8(rendered, preview_path(photo_id), 88)
        _save_jpeg_u8(_resize_long_edge(rendered, config.THUMB_SIZE), thumb_path(photo_id), 82)
    except Exception as e:
        log.warning("Refresh preview #%s échoué : %s", photo_id, e)


def placeholder_jpeg() -> bytes:
    arr = np.full((90, 120, 3), 38, np.uint8)
    return pipeline.encode_jpeg(arr, 70)
