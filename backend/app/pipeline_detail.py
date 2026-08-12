"""Clarté, dehaze, réduction de bruit, défrange, netteté, vignettage, grain — extrait de
`pipeline.py` (TODO N11). Dépend de `pipeline_core` (luma/gauss/_smoothstep) et de
`pipeline_color` (_apply_color, pour la compensation du dehaze) — sens unique, pas de cycle avec
`pipeline.py`, qui réexpose ces fonctions (`pipeline._apply_clarity` etc., utilisées par les tests
de parité)."""
import math
from collections import OrderedDict
from typing import Optional

import cv2
import numpy as np

from . import rsfast
from .pipeline_core import gauss, luma, _smoothstep
from .pipeline_color import _apply_color


def _apply_clarity(img: np.ndarray, clarity: float, scale: float,
                   ref_long_edge: Optional[int] = None) -> np.ndarray:
    """`ref_long_edge` : cf. `_apply_hl_shadows` (même besoin pour une retouche locale recadrée)."""
    if not clarity:
        return img
    amt = clarity / 100.0
    l = luma(img)
    sigma = max(8.0, (ref_long_edge or max(img.shape[:2])) * 0.012)
    blur_l = gauss(l, sigma)
    if rsfast.available():
        return rsfast.clarity(img, blur_l, amt)
    detail = l - blur_l
    midtone_w = 1.0 - np.abs(2.0 * np.clip(l, 0, 1) - 1.0) ** 2
    return img + (amt * 0.9 * detail * midtone_w)[..., None]


def _apply_dehaze(img: np.ndarray, dehaze: float) -> np.ndarray:
    if not dehaze:
        return img
    amt = dehaze / 100.0
    x = np.clip(img, 0.0, 1.0)
    if amt < 0:  # voile artistique
        return x * (1.0 + amt * 0.35) + (-amt) * 0.35 * 0.92
    dark = cv2.erode(x.min(axis=2), np.ones((9, 9), np.uint8))
    # Lumière atmosphérique : percentile global (statistique très robuste) estimé sur un
    # sous-échantillon (~16× moins de pixels) — résultat quasi identique, ~7× plus rapide.
    a = float(np.percentile(x[::4, ::4], 99.5))
    a = max(a, 0.5)
    t = 1.0 - 0.85 * amt * gauss(dark, max(img.shape[:2]) * 0.01) / a
    t = np.clip(t, 0.25, 1.0)[..., None]
    out = (x - a) / t + a
    # le dehaze assombrit : légère compensation d'exposition et de saturation
    return _apply_color(np.clip(out, 0.0, 1.0) * (1.0 + 0.1 * amt), {}, vibrance=12.0 * amt, saturation=0.0)


def _apply_nr(img: np.ndarray, nr_luma: float, nr_color: float, scale: float) -> np.ndarray:
    if nr_color > 0:
        ycc = cv2.cvtColor(np.clip(img, 0.0, 1.0), cv2.COLOR_RGB2YCrCb)
        sigma = (1.0 + 7.0 * nr_color / 100.0) * max(scale, 0.25)
        ycc[..., 1] = gauss(ycc[..., 1], sigma)
        ycc[..., 2] = gauss(ycc[..., 2], sigma)
        img = cv2.cvtColor(ycc, cv2.COLOR_YCrCb2RGB)
    if nr_luma > 0:
        amt = nr_luma / 100.0
        smoothed = cv2.bilateralFilter(np.clip(img, 0.0, 1.0), d=0,
                                       sigmaColor=0.03 + 0.12 * amt,
                                       sigmaSpace=2.0 + 5.0 * amt * max(scale, 0.25))
        img = img + (smoothed - img) * min(amt * 1.4, 1.0)
    return img


def _apply_defringe(img: np.ndarray, purple: float, green: float, scale: float) -> np.ndarray:
    """Défrange : désature les franges pourpres / vertes le long des bords à fort contraste
    (symptôme de l'aberration chromatique latérale). Désaturation locale vers la luminance,
    pondérée par la force du bord et par la « couleur de frange » du pixel."""
    if not (purple or green):
        return img
    sigma = max(1.5 * scale, 0.6)
    blur_luma = luma(gauss(img, sigma))
    if rsfast.available():   # math per-pixel exacte, multi-cœur ; flou (petit σ) laissé à cv2
        return rsfast.defringe(img, blur_luma, purple, green)
    l = luma(img)
    edge = np.clip(np.abs(l - blur_luma) * 8.0, 0.0, 1.0)  # bords haute fréquence
    r, g, b = img[..., 0], img[..., 1], img[..., 2]
    pm = np.clip(np.minimum(r, b) - g, 0.0, 1.0)   # pourpre/magenta : R,B hauts, V bas
    gm = np.clip(g - np.maximum(r, b), 0.0, 1.0)    # vert : V haut, R,B bas
    fp = np.clip(pm * edge * (purple / 100.0) * 4.0, 0.0, 1.0)
    fg = np.clip(gm * edge * (green / 100.0) * 4.0, 0.0, 1.0)
    f = np.maximum(fp, fg)[..., None]
    return img + (l[..., None] - img) * f


def _apply_sharpen(img: np.ndarray, amount: float, radius: float, scale: float) -> np.ndarray:
    if amount <= 0:
        return img
    sigma = max(radius * scale, 0.4)
    blur_luma = luma(gauss(img, sigma))
    if rsfast.available():
        return rsfast.sharpen(img, blur_luma, amount)
    detail = luma(img) - blur_luma
    return img + (amount / 100.0) * detail[..., None]


# Borné en LRU (même motif que les caches de previews.py) : sans ça, chaque couple (h, w) de rendu
# rencontré (catalogue aux résolutions/orientations variées) ajoutait une entrée jamais évincée,
# accumulée pour toute la durée du process serveur (audit1108.md, M1).
_VIGNETTE_CACHE_MAX = 16
_vignette_r_cache: "OrderedDict[tuple[int, int], np.ndarray]" = OrderedDict()

def _apply_vignette(img: np.ndarray, vignette: float) -> np.ndarray:
    if not vignette:
        return img
    if rsfast.available():   # r calculé par pixel (même formule), multi-cœur
        return rsfast.vignette(img, vignette / 100.0)
    h, w = img.shape[:2]
    key = (h, w)
    if key in _vignette_r_cache:
        _vignette_r_cache.move_to_end(key)
    else:
        ny, nx = np.mgrid[0:h, 0:w].astype(np.float32)
        nx = nx / max(w - 1, 1) * 2.0 - 1.0
        ny = ny / max(h - 1, 1) * 2.0 - 1.0
        _vignette_r_cache[key] = np.sqrt(nx * nx + ny * ny) / math.sqrt(2.0)
        while len(_vignette_r_cache) > _VIGNETTE_CACHE_MAX:
            _vignette_r_cache.popitem(last=False)
    r = _vignette_r_cache[key]
    v = vignette / 100.0
    gain = 2.0 ** (v * 1.3 * _smoothstep(0.3, 1.0, r))
    return img * gain[..., None]


_GRAIN_MAX = 1400  # bord long max de la grille de grain : borne le coût et fixe la « taille réelle »

def _apply_grain(img: np.ndarray, grain: float, scale: float, seed: int) -> np.ndarray:
    if grain <= 0:
        return img
    g = grain / 100.0
    h, w = img.shape[:2]
    long_edge = max(h, w)
    # Grille de grain à résolution « pleine image » (≈ bord long / scale), bornée à _GRAIN_MAX.
    # À seed égal, preview et export dérivent la MÊME grille (puis la redimensionnent) → grain
    # d'apparence identique, indépendant de la taille de rendu (fini le motif fixe + la fréquence
    # qui variait avec scale). La graine vient du photo_id ⇒ motif différent par photo.
    gl = min(max(int(round(long_edge / max(scale, 1e-3))), 8), _GRAIN_MAX)
    if long_edge == h:
        gh, gw = gl, max(int(round(gl * w / h)), 1)
    else:
        gw, gh = gl, max(int(round(gl * h / w)), 1)
    rng = np.random.default_rng((int(seed) & 0xFFFFFFFF) or 1234)
    noise = rng.standard_normal((gh, gw)).astype(np.float32)
    if (gh, gw) != (h, w):
        noise = cv2.resize(noise, (w, h), interpolation=cv2.INTER_LINEAR)
    return img + noise[..., None] * (0.05 * g)
