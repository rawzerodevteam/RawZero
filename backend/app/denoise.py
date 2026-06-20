"""Réduction de bruit par IA (FFDNet) via ONNX Runtime (CPU).

Moteur : modèle FFDNet couleur (`data/models/ffdnet_color.onnx`, déposé manuellement).
Comme `segment.py`, tout est en chargement paresseux et **dégrade proprement** : si
`onnxruntime` ou le modèle est absent, `available()` renvoie False et `denoise` lève une
`DenoiseUnavailable` (le reste de l'app continue de tourner).

Principe (cf. plan) : on débruite la base **une seule fois** à une force de référence fixe
(`REF_SIGMA`) ; la modulation fine se fait ailleurs par un simple mélange linéaire
bruité↔débruité. L'inférence est **tuilée** (recouvrement + fondu) pour borner la mémoire et
accepter n'importe quelle résolution (jusqu'à l'export pleine réso).
"""
import logging
import threading
from typing import Optional

import numpy as np

from . import config

log = logging.getLogger(__name__)

# Force de référence à laquelle on précalcule la base débruitée (sigma normalisé 0..1).
# Le modèle expose sigma en entrée runtime → cette valeur se règle ici sans reconvertir l'ONNX.
# Calée pour les hauts ISO (le cas d'usage réel) ; le slider « Force » module vers le bas.
REF_SIGMA = 40.0 / 255.0

# Tuilage : tuile carrée + recouvrement fondu (rampe linéaire) entre tuiles voisines.
_TILE = 512
_OVERLAP = 32

_session = None
_layout: Optional[dict] = None      # {"img": name, "sigma": name|None, "concat": bool}
_lock = threading.Lock()
_load_failed = False


class DenoiseUnavailable(RuntimeError):
    """Levée quand le moteur ou le modèle de débruitage n'est pas disponible."""


def model_path():
    return config.MODELS_DIR / "ffdnet_color.onnx"


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
    global _session, _layout, _load_failed
    if _session is not None:
        return _session, _layout
    with _lock:
        if _session is not None:
            return _session, _layout
        try:
            import onnxruntime as ort
        except Exception as e:
            _load_failed = True
            raise DenoiseUnavailable("onnxruntime n'est pas installé") from e
        path = model_path()
        if not path.exists():
            raise DenoiseUnavailable(f"Modèle introuvable : {path}")
        try:
            so = ort.SessionOptions()
            so.intra_op_num_threads = 0  # auto
            sess = ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])
        except Exception as e:
            _load_failed = True
            raise DenoiseUnavailable(f"Chargement du modèle impossible : {e}") from e
        _session = sess
        _layout = _detect_layout(sess)
        log.info("Modèle de débruitage chargé : %s (%s)", path.name, _layout)
    return _session, _layout


def _detect_layout(sess) -> dict:
    """Déduit comment alimenter le réseau selon ses entrées déclarées.

    Gère les exports FFDNet courants : image (3 canaux) + carte de bruit (1 canal) séparées,
    ou un unique tenseur concaténé (4 canaux), ou une seule entrée image (sigma fixe)."""
    inputs = sess.get_inputs()

    def ch(inp):
        s = inp.shape
        return s[1] if len(s) == 4 and isinstance(s[1], int) else None

    if len(inputs) >= 2:
        img = next((i.name for i in inputs if ch(i) == 3), inputs[0].name)
        sig_inp = next((i for i in inputs if ch(i) == 1), None)
        if sig_inp is None:
            sig_inp = next((i for i in inputs if i.name != img), None)
        # sigma « scalaire » (export FFDNet natif : forme [N,1,1,1]) vs carte pleine [N,1,H,W].
        s = sig_inp.shape if sig_inp is not None else []
        scalar = len(s) == 4 and s[2] == 1 and s[3] == 1
        return {"img": img, "sigma": sig_inp.name if sig_inp else None,
                "concat": False, "sigma_scalar": scalar}
    only = inputs[0]
    return {"img": only.name, "sigma": None, "concat": ch(only) == 4, "sigma_scalar": False}


def _run_tile(sess, layout, tile: np.ndarray, sigma: float) -> np.ndarray:
    """tile : HWC float32 RGB 0..1. Renvoie le débruité aux mêmes dimensions.
    FFDNet sous-échantillonne ×2 → on complète à des dimensions paires (réflexion)."""
    h, w = tile.shape[:2]
    ph, pw = h % 2, w % 2
    if ph or pw:
        tile = np.pad(tile, ((0, ph), (0, pw), (0, 0)), mode="reflect")
    H, W = tile.shape[:2]
    x = np.transpose(tile, (2, 0, 1))[None].astype(np.float32)   # 1,3,H,W
    if layout["concat"]:
        smap = np.full((1, 1, H, W), sigma, np.float32)
        feeds = {layout["img"]: np.concatenate([x, smap], axis=1)}
    else:
        feeds = {layout["img"]: x}
        if layout["sigma"] is not None:
            shape = (1, 1, 1, 1) if layout.get("sigma_scalar") else (1, 1, H, W)
            feeds[layout["sigma"]] = np.full(shape, sigma, np.float32)
    out = np.asarray(sess.run(None, feeds)[0])[0]               # 3,H,W
    out = np.transpose(out, (1, 2, 0))
    return out[:h, :w]


def _ramp(n: int, lo: int, hi: int) -> np.ndarray:
    """Fenêtre de fondu 1D : rampe montante sur les `lo` premiers px, descendante sur les
    `hi` derniers (0 aux bords recouvrants, 1 au centre). Évite les coutures entre tuiles."""
    w = np.ones(n, np.float32)
    if lo > 0:
        w[:lo] = np.linspace(0.0, 1.0, lo, endpoint=False, dtype=np.float32)
    if hi > 0:
        w[n - hi:] = np.linspace(1.0, 0.0, hi, endpoint=False, dtype=np.float32)
    return w


def denoise(img: np.ndarray, sigma: float = REF_SIGMA) -> np.ndarray:
    """Débruite `img` (float32 RGB 0..1) par tuilage fondu. Renvoie float32 0..1, même forme."""
    sess, layout = _get_session()
    img = np.clip(img, 0.0, 1.0).astype(np.float32)
    h, w = img.shape[:2]
    step = _TILE - _OVERLAP
    acc = np.zeros_like(img)
    wsum = np.zeros((h, w, 1), np.float32)
    ys = list(range(0, max(h - _OVERLAP, 1), step))
    xs = list(range(0, max(w - _OVERLAP, 1), step))
    for y in ys:
        y1 = min(y + _TILE, h)
        for x in xs:
            x1 = min(x + _TILE, w)
            out = _run_tile(sess, layout, img[y:y1, x:x1], sigma)
            wy = _ramp(y1 - y, _OVERLAP if y > 0 else 0, _OVERLAP if y1 < h else 0)
            wx = _ramp(x1 - x, _OVERLAP if x > 0 else 0, _OVERLAP if x1 < w else 0)
            win = (wy[:, None] * wx[None, :])[..., None]
            acc[y:y1, x:x1] += out * win
            wsum[y:y1, x:x1] += win
    np.maximum(wsum, 1e-6, out=wsum)
    return np.clip(acc / wsum, 0.0, 1.0)
