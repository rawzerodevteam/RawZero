"""Estimation de profondeur monoculaire par IA (masque local « plage de profondeur »).

Moteur : ONNX Runtime (CPU), modèle Depth Anything V2 Small quantifié
(`data/models/depth_anything_v2_small.onnx`). Même dégradation propre que `segment.py` : si
`onnxruntime` n'est pas installé ou si le modèle est absent, `available()` renvoie False et
`depth_map` lève `DepthUnavailable` (le reste de l'app continue de tourner).
"""
import logging
import threading
from typing import Optional

import cv2
import numpy as np

from . import config

log = logging.getLogger(__name__)

# Prétraitement DPT/Depth Anything (cf. preprocessor_config.json du modèle) : normalisation
# ImageNet, entrée carrée 518 (le modèle exige un multiple de 14 ; on ignore le ratio d'aspect,
# comme le fait déjà segment.py pour U²-Net à 320² — simplification acceptée pour ce cas d'usage).
_INPUT = 518
_MEAN = np.array([0.485, 0.456, 0.406], np.float32)
_STD = np.array([0.229, 0.224, 0.225], np.float32)

_session = None
_input_name: Optional[str] = None
_lock = threading.Lock()
_load_failed = False


class DepthUnavailable(RuntimeError):
    """Levée quand le moteur ou le modèle d'estimation de profondeur n'est pas disponible."""


def model_path():
    return config.MODELS_DIR / "depth_anything_v2_small.onnx"


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
            raise DepthUnavailable(
                "onnxruntime n'est pas installé (pip install onnxruntime)") from e
        path = model_path()
        if not path.exists():
            raise DepthUnavailable(f"Modèle introuvable : {path}")
        try:
            so = ort.SessionOptions()
            so.intra_op_num_threads = 0  # auto
            sess = ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])
        except Exception as e:
            _load_failed = True
            raise DepthUnavailable(f"Chargement du modèle impossible : {e}") from e
        _session = sess
        _input_name = sess.get_inputs()[0].name
        log.info("Modèle de profondeur chargé : %s", path.name)
    return _session


def depth_map(img: np.ndarray) -> np.ndarray:
    """Carte de profondeur relative pour `img` (float32 RGB 0..1). Renvoie float32 (h, w) dans
    0..1, normalisée par image : **1.0 = le plus proche, 0.0 = le plus lointain**."""
    sess = _get_session()
    h, w = img.shape[:2]
    x = cv2.resize(np.clip(img, 0.0, 1.0).astype(np.float32), (_INPUT, _INPUT),
                   interpolation=cv2.INTER_AREA)
    x = (x - _MEAN) / _STD
    x = np.transpose(x, (2, 0, 1))[None].astype(np.float32)  # NCHW
    out = sess.run(None, {_input_name: x})[0]
    pred = np.asarray(out)[0].astype(np.float32)              # (518, 518), grand = proche
    mi, ma = float(pred.min()), float(pred.max())
    pred = (pred - mi) / (ma - mi) if ma > mi else np.zeros_like(pred)
    return cv2.resize(pred, (w, h), interpolation=cv2.INTER_LINEAR)
