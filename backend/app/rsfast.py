"""Accélérateur natif (Rust) des étages pur-NumPy du pipeline.

Charge `backend/rsfast/target/release/rsfast.{dll,so,dylib}` via ctypes (pas de
maturin/PyO3). **Dégrade proprement** : si la lib n'est pas compilée, `available()`
renvoie False et `pipeline.py` retombe sur le chemin NumPy d'origine.

Parité mesurée vs NumPy : contrast/curve bit-exacts, linear ≤ 0.035/255 (ULP des LUT
sRGB), whites/vignette ~0 — bien sous le seuil de 2/255 du filet de régression GPU↔Python.

Désactivable par `RSFAST=0` (force le repli NumPy).
"""
import ctypes as C
import logging
import os
from pathlib import Path
from typing import Optional

import numpy as np

log = logging.getLogger(__name__)

_F32P = C.POINTER(C.c_float)
_lib: Optional[C.CDLL] = None
_loaded = False


def _dll_path() -> Optional[Path]:
    root = Path(__file__).resolve().parent.parent / "rsfast" / "target" / "release"
    for name in ("rsfast.dll", "librsfast.so", "librsfast.dylib"):
        if (root / name).exists():
            return root / name
    return None


def _load() -> Optional[C.CDLL]:
    global _lib, _loaded
    if _loaded:
        return _lib
    _loaded = True
    if os.environ.get("RSFAST", "1") == "0":
        log.info("rsfast désactivé (RSFAST=0) → pipeline NumPy")
        return None
    path = _dll_path()
    if path is None:
        log.info("rsfast non compilé → pipeline NumPy (build : cargo build --release dans backend/rsfast)")
        return None
    try:
        lib = C.CDLL(str(path))
        lib.rs_linear_stage.argtypes = [_F32P, C.c_size_t, C.c_float, C.c_float, C.c_float]
        lib.rs_whites_blacks.argtypes = [_F32P, C.c_size_t, C.c_float, C.c_float]
        lib.rs_contrast.argtypes = [_F32P, C.c_size_t, C.c_float]
        lib.rs_curve.argtypes = [_F32P, C.c_size_t, _F32P, _F32P, _F32P, C.c_size_t]
        lib.rs_hsl.argtypes = [_F32P, C.c_size_t, _F32P, _F32P, _F32P, _F32P,
                               C.c_size_t, C.c_float, C.c_float]
        lib.rs_vignette.argtypes = [_F32P, C.c_size_t, C.c_size_t, C.c_size_t, C.c_float]
        _lib = lib
        log.info("rsfast chargé : %s", path.name)
    except Exception as e:
        log.warning("rsfast illisible (%s) → pipeline NumPy", e)
        _lib = None
    return _lib


def available() -> bool:
    return _load() is not None


def _buf(img: np.ndarray) -> np.ndarray:
    """Copie C-contiguë float32 (les étages Rust écrivent en place)."""
    return np.ascontiguousarray(img, dtype=np.float32).copy()


def _ptr(a: Optional[np.ndarray]):
    return a.ctypes.data_as(_F32P) if a is not None else None


# ----------------------------------------------------------------- étages

def linear_stage(img: np.ndarray, rg_ev: float, gg_ev: float, bg_ev: float) -> np.ndarray:
    a = _buf(img)
    _lib.rs_linear_stage(_ptr(a), a.shape[0] * a.shape[1], rg_ev, gg_ev, bg_ev)
    return a


def whites_blacks(img: np.ndarray, bp: float, denom: float) -> np.ndarray:
    a = _buf(img)
    _lib.rs_whites_blacks(_ptr(a), a.shape[0] * a.shape[1], bp, denom)
    return a


def contrast(img: np.ndarray, c: float) -> np.ndarray:
    a = _buf(img)
    _lib.rs_contrast(_ptr(a), a.shape[0] * a.shape[1], c)
    return a


def curve(img: np.ndarray, luts: list) -> np.ndarray:
    """`luts` = [lut_r, lut_g, lut_b], chacun np.ndarray float32 len 1024 ou None."""
    a = _buf(img)
    held = [np.ascontiguousarray(l, dtype=np.float32) if l is not None else None for l in luts]
    n = next((len(l) for l in held if l is not None), 1024)
    _lib.rs_curve(_ptr(a), a.shape[0] * a.shape[1],
                  _ptr(held[0]), _ptr(held[1]), _ptr(held[2]), n)
    return a


def hsl(hsv: np.ndarray, centers: np.ndarray, bh: np.ndarray, bs: np.ndarray,
        bl: np.ndarray, vibrance: float, saturation: float) -> None:
    """Modifie **en place** un buffer HSV entrelacé (issu de cv2.cvtColor, déjà contigu f32)."""
    n = hsv.shape[0] * hsv.shape[1]
    _lib.rs_hsl(_ptr(hsv), n, _ptr(centers), _ptr(bh), _ptr(bs), _ptr(bl),
                len(centers), vibrance, saturation)


def vignette(img: np.ndarray, v: float) -> np.ndarray:
    a = _buf(img)
    h, w = a.shape[:2]
    _lib.rs_vignette(_ptr(a), h * w, w, h, v)
    return a
