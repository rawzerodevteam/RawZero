"""Segmentation par IA pour les masques automatiques (« Sélectionner le sujet »).

Moteur : ONNX Runtime (CPU), modèle U²-Net d'objet saillant (`data/models/u2netp.onnx`).
Tout est en chargement paresseux et **dégrade proprement** : si `onnxruntime` n'est pas
installé ou si le modèle est absent, `available()` renvoie False et `subject_mask` lève
une `SegmentationUnavailable` (le reste de l'app continue de tourner).
"""
import hashlib
import json
import logging
import threading
from collections import OrderedDict
from typing import Optional

import cv2
import numpy as np

from . import config

log = logging.getLogger(__name__)

# Prétraitement U²-Net (cf. dépôt d'origine / rembg) : 320², normalisation ImageNet.
_INPUT = 320
_MEAN = np.array([0.485, 0.456, 0.406], np.float32)
_STD = np.array([0.229, 0.224, 0.225], np.float32)

_session = None
_input_name: Optional[str] = None
_lock = threading.Lock()
_load_failed = False

# --- EdgeSAM (segmentation guidée par point) : encodeur 1024², décodeur prompté.
_SAM_INPUT = 1024
_SAM_MEAN = np.array([123.675, 116.28, 103.53], np.float32)   # normalisation SAM (sur 0..255)
_SAM_STD = np.array([58.395, 57.12, 57.375], np.float32)
_sam_enc = None
_sam_dec = None
_sam_lock = threading.Lock()
_sam_failed = False
_emb_cache: "OrderedDict[str, tuple]" = OrderedDict()   # embedding par (photo, géométrie)
_EMB_CACHE_MAX = 4


class SegmentationUnavailable(RuntimeError):
    """Levée quand le moteur ou le modèle de segmentation n'est pas disponible."""


def model_path():
    return config.MODELS_DIR / "u2netp.onnx"


def available() -> bool:
    """True si l'inférence est possible (onnxruntime importable + fichier modèle présent)."""
    if _load_failed:
        return False
    try:
        import onnxruntime  # noqa: F401
    except Exception:
        return False
    return model_path().exists()


def _get_session():
    global _session, _input_name, _load_failed
    if _session is not None:
        return _session
    with _lock:
        if _session is not None:
            return _session
        try:
            import onnxruntime as ort
        except Exception as e:
            _load_failed = True
            raise SegmentationUnavailable(
                "onnxruntime n'est pas installé (pip install onnxruntime)") from e
        path = model_path()
        if not path.exists():
            raise SegmentationUnavailable(f"Modèle introuvable : {path}")
        try:
            so = ort.SessionOptions()
            so.intra_op_num_threads = 0  # auto
            sess = ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])
        except Exception as e:
            _load_failed = True
            raise SegmentationUnavailable(f"Chargement du modèle impossible : {e}") from e
        _session = sess
        _input_name = sess.get_inputs()[0].name
        log.info("Modèle de segmentation chargé : %s", path.name)
    return _session


def subject_mask(img: np.ndarray) -> np.ndarray:
    """Masque d'objet saillant pour `img` (float32 RGB 0..1). Renvoie float32 (h, w) dans 0..1
    aux dimensions de `img`."""
    sess = _get_session()
    h, w = img.shape[:2]
    x = cv2.resize(np.clip(img, 0.0, 1.0).astype(np.float32), (_INPUT, _INPUT),
                   interpolation=cv2.INTER_AREA)
    x = (x - _MEAN) / _STD
    x = np.transpose(x, (2, 0, 1))[None].astype(np.float32)  # NCHW
    out = sess.run(None, {_input_name: x})[0]
    pred = np.asarray(out)[0, 0]                              # (320, 320)
    mi, ma = float(pred.min()), float(pred.max())
    pred = (pred - mi) / (ma - mi) if ma > mi else np.zeros_like(pred)
    return cv2.resize(pred.astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR)


# ------------------------------------------------------------- Ciel (heuristique)

def _smoothstep01(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / max(e1 - e0, 1e-6), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def sky_mask(img: np.ndarray) -> np.ndarray:
    """Masque de ciel **heuristique** (sans modèle, toujours disponible).

    `img` : float32 RGB 0..1. Renvoie float32 (h, w) dans 0..1.
    Combine trois indices : couleur (bleu franc *ou* clair/désaturé, type couvert ou brume),
    a priori vertical (le ciel est plutôt en haut) et connexité au bord supérieur (écarte
    les objets bleus ou clairs du bas de l'image), puis adoucit les bords.
    """
    img = np.clip(img, 0.0, 1.0).astype(np.float32)
    h, w = img.shape[:2]
    hsv = cv2.cvtColor(img, cv2.COLOR_RGB2HSV)              # H:0..360  S:0..1  V:0..1
    H, S, V = hsv[..., 0], hsv[..., 1], hsv[..., 2]

    # Ciel bleu : teinte proche du cyan-bleu (~205°), saturation et clarté correctes.
    hue_dist = np.abs(H - 205.0)
    blue = ((1.0 - _smoothstep01(35.0, 80.0, hue_dist))
            * _smoothstep01(0.08, 0.25, S) * _smoothstep01(0.35, 0.6, V))
    # Ciel clair / couvert / brumeux : très lumineux et peu saturé.
    bright = _smoothstep01(0.62, 0.85, V) * (1.0 - _smoothstep01(0.18, 0.40, S))
    color = np.maximum(blue, bright)

    # A priori vertical : ~1 en haut, décroît vers le bas (sans tuer complètement le bas).
    yy = np.linspace(0.0, 1.0, h, dtype=np.float32)[:, None]
    yprior = 0.25 + 0.75 * (1.0 - _smoothstep01(0.45, 0.95, yy))
    score = color * yprior

    # Connexité : ne garder que les régions de ciel raccordées au bord supérieur de l'image,
    # ce qui élimine les murs clairs, l'eau ou les vêtements bleus situés plus bas.
    binary = (score > 0.35).astype(np.uint8)
    k = max(3, (min(h, w) // 200) | 1)
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
    n, labels = cv2.connectedComponents(binary)
    top_band = labels[0:max(1, h // 50), :]
    top_labels = [int(v) for v in np.unique(top_band) if v != 0]
    if top_labels:
        keep = np.isin(labels, top_labels).astype(np.float32)
    else:
        keep = (score > 0.5).astype(np.float32)            # repli : pas de ciel au bord haut

    soft = score * keep
    soft = cv2.GaussianBlur(soft, (0, 0), max(min(h, w) * 0.004, 0.6))
    return np.clip(soft, 0.0, 1.0).astype(np.float32)


# ------------------------------------------------------------- EdgeSAM (clic)

def sam_encoder_path():
    return config.MODELS_DIR / "edge_sam_3x_encoder.onnx"


def sam_decoder_path():
    return config.MODELS_DIR / "edge_sam_3x_decoder.onnx"


def point_available() -> bool:
    """True si la segmentation au clic (EdgeSAM) est utilisable."""
    if _sam_failed:
        return False
    try:
        import onnxruntime  # noqa: F401
    except Exception:
        return False
    return sam_encoder_path().exists() and sam_decoder_path().exists()


def _get_sam():
    global _sam_enc, _sam_dec, _sam_failed
    if _sam_enc is not None:
        return _sam_enc, _sam_dec
    with _sam_lock:
        if _sam_enc is not None:
            return _sam_enc, _sam_dec
        try:
            import onnxruntime as ort
        except Exception as e:
            _sam_failed = True
            raise SegmentationUnavailable("onnxruntime n'est pas installé") from e
        if not (sam_encoder_path().exists() and sam_decoder_path().exists()):
            raise SegmentationUnavailable("Modèle EdgeSAM introuvable")
        try:
            _sam_enc = ort.InferenceSession(str(sam_encoder_path()), providers=["CPUExecutionProvider"])
            _sam_dec = ort.InferenceSession(str(sam_decoder_path()), providers=["CPUExecutionProvider"])
        except Exception as e:
            _sam_failed = True
            raise SegmentationUnavailable(f"Chargement EdgeSAM impossible : {e}") from e
        log.info("Modèle EdgeSAM chargé")
    return _sam_enc, _sam_dec


def _encode(img: np.ndarray) -> tuple:
    """Encode `img` (float32 RGB 0..1) → (embedding, scale, nh, nw, h, w).
    Resize côté long à 1024 (façon SAM) puis padding à 1024², normalisation SAM."""
    enc, _ = _get_sam()
    h, w = img.shape[:2]
    scale = _SAM_INPUT / max(h, w)
    nh, nw = max(round(h * scale), 1), max(round(w * scale), 1)
    rs = cv2.resize(np.clip(img, 0.0, 1.0) * 255.0, (nw, nh), interpolation=cv2.INTER_LINEAR)
    x = (rs.astype(np.float32) - _SAM_MEAN) / _SAM_STD
    padded = np.zeros((_SAM_INPUT, _SAM_INPUT, 3), np.float32)
    padded[:nh, :nw] = x
    inp = np.transpose(padded, (2, 0, 1))[None]
    emb = enc.run(None, {"image": inp})[0]
    return emb, scale, nh, nw, h, w


def point_mask(img: np.ndarray, x: float, y: float, cache_key: str = "") -> np.ndarray:
    """Masque EdgeSAM pour le point (x, y) normalisé. Renvoie float32 (h, w) dans 0..1.
    `cache_key` (photo+géométrie) évite de ré-encoder l'image à chaque clic."""
    _, dec = _get_sam()
    cached = _emb_cache.get(cache_key) if cache_key else None
    if cached is None:
        cached = _encode(img)
        if cache_key:
            _emb_cache[cache_key] = cached
            _emb_cache.move_to_end(cache_key)
            while len(_emb_cache) > _EMB_CACHE_MAX:
                _emb_cache.popitem(last=False)
    emb, scale, nh, nw, h, w = cached

    px = float(np.clip(x, 0.0, 1.0)) * (w - 1) * scale
    py = float(np.clip(y, 0.0, 1.0)) * (h - 1) * scale
    coords = np.array([[[px, py]]], np.float32)             # espace 1024
    labels = np.array([[1.0]], np.float32)                  # 1 = avant-plan
    scores, masks = dec.run(None, {"image_embeddings": emb,
                                   "point_coords": coords, "point_labels": labels})
    masks = np.asarray(masks).reshape(-1, masks.shape[-2], masks.shape[-1])
    scores = np.asarray(scores).reshape(-1)
    # SAM renvoie plusieurs granularités (sous-partie / partie / objet entier) ; le meilleur
    # *score* est souvent une partie (ex. le corps sans les vêtements). On garde donc l'objet
    # le PLUS GRAND parmi les candidats à score correct → tend vers l'objet entier.
    areas = (masks > 0).reshape(masks.shape[0], -1).mean(axis=1)
    keep = scores >= max(float(scores.max()) - 0.2, 0.5)
    cand = np.where(keep)[0]
    best = int(cand[areas[cand].argmax()]) if len(cand) else int(scores.argmax())
    logit = cv2.resize(masks[best], (_SAM_INPUT, _SAM_INPUT), interpolation=cv2.INTER_LINEAR)
    logit = logit[:nh, :nw]                                 # retire le padding
    logit = cv2.resize(logit, (w, h), interpolation=cv2.INTER_LINEAR)
    return (1.0 / (1.0 + np.exp(-logit))).astype(np.float32)  # sigmoïde → 0..1


def geo_key(photo_id: int, geometry: dict) -> str:
    h = hashlib.sha1(json.dumps(geometry, sort_keys=True).encode()).hexdigest()[:12]
    return f"{photo_id}:{h}"


def invalidate(photo_id: int) -> None:
    """Purge l'embedding EdgeSAM en cache pour cette photo (toutes géométries confondues).

    `_emb_cache` est clé par (photo_id, géométrie) via `geo_key`, pas par le contenu du fichier :
    si l'original est relié à un nouveau fichier (`relink`) sans changement de géométrie, un clic
    masque IA suivant réutiliserait sinon l'embedding calculé sur l'ANCIEN contenu de l'image."""
    for k in [k for k in _emb_cache if k.startswith(f"{photo_id}:")]:
        _emb_cache.pop(k, None)
