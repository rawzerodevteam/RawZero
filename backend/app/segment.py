"""Segmentation par IA pour les masques automatiques (« Sélectionner le sujet »).

Moteur : ONNX Runtime (CPU), modèle U²-Net d'objet saillant (`data/models/u2netp.onnx`).
Tout est en chargement paresseux et **dégrade proprement** : si `onnxruntime` n'est pas
installé ou si le modèle est absent, `available()` renvoie False et `subject_mask` lève
une `SegmentationUnavailable` (le reste de l'app continue de tourner).
"""
import logging
import threading
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
