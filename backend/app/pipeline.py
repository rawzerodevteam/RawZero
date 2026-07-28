"""Pipeline de développement non-destructif.

Toutes les opérations travaillent sur du float32 RGB 0..1 (sRGB).
`scale` = bord long du rendu / bord long pleine résolution : il sert à mettre à
l'échelle les rayons (netteté, clarté, NR) pour que preview et export concordent.

Ordre : géométrie → (linéaire) WB + exposition → tons (HL/ombres, blancs/noirs,
contraste, courbe) → HSL/vibrance/saturation → clarté/dehaze → retouches locales
→ réduction de bruit → netteté → vignettage/grain.
"""
import functools
import math
from typing import Any, Optional

import cv2
import numpy as np

from . import rsfast
from .masks import build_mask

# ---------------------------------------------------------------- état par défaut

DEFAULT_EDITS: dict[str, Any] = {
    "version": 1,
    "wb": {"temp": 0.0, "tint": 0.0},
    "tone": {"exposure": 0.0, "contrast": 0.0, "highlights": 0.0,
             "shadows": 0.0, "whites": 0.0, "blacks": 0.0},
    "presence": {"clarity": 0.0, "dehaze": 0.0, "vibrance": 0.0, "saturation": 0.0},
    "curve": {"points": [[0.0, 0.0], [1.0, 1.0]],
              "r": [[0.0, 0.0], [1.0, 1.0]],
              "g": [[0.0, 0.0], [1.0, 1.0]],
              "b": [[0.0, 0.0], [1.0, 1.0]]},
    "hsl": {b: {"h": 0.0, "s": 0.0, "l": 0.0}
            for b in ("red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta")},
    "detail": {"sharpen_amount": 25.0, "sharpen_radius": 1.0,
               "nr_luma": 0.0, "nr_color": 0.0, "nr_ai": 0.0,
               "defringe_purple": 0.0, "defringe_green": 0.0},
    "effects": {"vignette": 0.0, "grain": 0.0},
    "geometry": {"rotate": 0, "flip_h": False, "flip_v": False, "straighten": 0.0,
                 "crop": {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}},
    "locals": [],
}

LOCAL_ADJUST_DEFAULTS = {"exposure": 0.0, "contrast": 0.0, "highlights": 0.0,
                         "shadows": 0.0, "temp": 0.0, "tint": 0.0,
                         "saturation": 0.0, "clarity": 0.0, "sharpness": 0.0}

HSL_BANDS = [("red", 0.0), ("orange", 30.0), ("yellow", 60.0), ("green", 120.0),
             ("aqua", 180.0), ("blue", 240.0), ("purple", 280.0), ("magenta", 320.0)]


def merge_edits(edits: Optional[dict]) -> dict:
    """Fusion récursive avec les valeurs par défaut (tolère un état partiel)."""
    def merge(default: Any, value: Any) -> Any:
        if isinstance(default, dict) and isinstance(value, dict):
            return {k: merge(v, value.get(k, v)) for k, v in default.items()}
        return value if value is not None else default

    # merge() reconstruit récursivement chaque dict traversé (dict comprehension) : la seule
    # aliasing possible est sur les feuilles non-dict laissées à leur défaut (ex. les listes de
    # points de courbe quand `edits` ne les fournit pas), jamais mutées en place ailleurs dans le
    # pipeline → pas besoin de deepcopy(DEFAULT_EDITS) à chaque appel (chemin chaud du rendu).
    out = merge(DEFAULT_EDITS, edits or {})
    out["locals"] = [
        {"id": loc.get("id", ""), "type": loc.get("type", "radial"),
         "params": loc.get("params", {}), "invert": bool(loc.get("invert", False)),
         "adjust": {**LOCAL_ADJUST_DEFAULTS, **loc.get("adjust", {})}}
        for loc in (edits or {}).get("locals", [])
    ]
    return out


def edits_meaningful(edits: Optional[dict]) -> bool:
    """True si l'état de développement diffère des valeurs par défaut (photo retouchée)."""
    if not edits:
        return False
    return merge_edits(edits) != DEFAULT_EDITS


# ---------------------------------------------------------------- utilitaires

_LUT_N = 4096
_lin_lut = None
_srgb_lut = None


def _luts() -> tuple[np.ndarray, np.ndarray]:
    global _lin_lut, _srgb_lut
    if _lin_lut is None:
        x = np.linspace(0.0, 1.0, _LUT_N, dtype=np.float32)
        _lin_lut = np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4).astype(np.float32)
        _srgb_lut = np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055).astype(np.float32)
    return _lin_lut, _srgb_lut


def _apply_lut(img: np.ndarray, lut: np.ndarray) -> np.ndarray:
    idx = np.clip(img * (_LUT_N - 1), 0, _LUT_N - 1).astype(np.int32)
    return lut[idx]


def srgb_to_linear(img: np.ndarray) -> np.ndarray:
    return _apply_lut(np.clip(img, 0.0, 1.0), _luts()[0])


def linear_to_srgb(img: np.ndarray) -> np.ndarray:
    return _apply_lut(np.clip(img, 0.0, 1.0), _luts()[1])


def luma(img: np.ndarray) -> np.ndarray:
    return img[..., 0] * 0.2126 + img[..., 1] * 0.7152 + img[..., 2] * 0.0722


def gauss(img: np.ndarray, sigma: float) -> np.ndarray:
    sigma = max(float(sigma), 0.3)
    # Grand sigma : un flou gaussien à pleine résolution construit un noyau énorme
    # (ksize ≈ 8σ) → coût prohibitif (~4 s à σ≈116 sur 22 Mpx). Le résultat étant
    # basse fréquence, on floute une version réduite d'un facteur k puis on ré-agrandit :
    # 50–85× plus rapide, écart ≤ 0.06/255 vs le flou plein (k borné à 4, conservateur).
    # Les petits σ (netteté, défrange) gardent k=1 → flou OpenCV strictement identique.
    k = max(1, min(4, int(sigma / 8)))
    if k > 1:
        h, w = img.shape[:2]
        small = cv2.resize(img, (max(w // k, 1), max(h // k, 1)), interpolation=cv2.INTER_AREA)
        small = cv2.GaussianBlur(small, (0, 0), sigmaX=sigma / k, sigmaY=sigma / k,
                                 borderType=cv2.BORDER_REFLECT)
        return cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)
    return cv2.GaussianBlur(img, (0, 0), sigmaX=sigma, sigmaY=sigma,
                            borderType=cv2.BORDER_REFLECT)


def _smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


# ---------------------------------------------------------------- géométrie

def _largest_rotated_rect(w: int, h: int, angle_rad: float) -> tuple[float, float]:
    """Plus grand rectangle de même aspect inscrit dans l'image redressée."""
    if w <= 0 or h <= 0:
        return 0.0, 0.0
    sin_a, cos_a = abs(math.sin(angle_rad)), abs(math.cos(angle_rad))
    k = min(w / (w * cos_a + h * sin_a), h / (w * sin_a + h * cos_a))
    return w * k, h * k


def apply_geometry(img: np.ndarray, geo: dict, skip_crop: bool = False) -> np.ndarray:
    rot = int(geo.get("rotate", 0)) % 360
    if rot:
        img = np.rot90(img, k=rot // 90)
    if geo.get("flip_h"):
        img = img[:, ::-1]
    if geo.get("flip_v"):
        img = img[::-1]
    angle = float(geo.get("straighten", 0.0))
    if abs(angle) > 0.01:
        h, w = img.shape[:2]
        m = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), angle, 1.0)
        img = cv2.warpAffine(img, m, (w, h), flags=cv2.INTER_LINEAR,
                             borderMode=cv2.BORDER_REFLECT)
        wr, hr = _largest_rotated_rect(w, h, math.radians(angle))
        x0, y0 = int((w - wr) / 2), int((h - hr) / 2)
        img = img[y0:max(y0 + int(hr), y0 + 1), x0:max(x0 + int(wr), x0 + 1)]
    crop = geo.get("crop") or {}
    cx, cy = float(crop.get("x", 0)), float(crop.get("y", 0))
    cw, ch = float(crop.get("w", 1)), float(crop.get("h", 1))
    if not skip_crop and (cw < 0.999 or ch < 0.999 or cx > 0.001 or cy > 0.001):
        h, w = img.shape[:2]
        x0 = int(np.clip(cx, 0, 0.98) * w)
        y0 = int(np.clip(cy, 0, 0.98) * h)
        x1 = int(np.clip(cx + cw, 0.02, 1.0) * w)
        y1 = int(np.clip(cy + ch, 0.02, 1.0) * h)
        img = img[y0:max(y1, y0 + 8), x0:max(x1, x0 + 8)]
    return np.ascontiguousarray(img)


# ---------------------------------------------------------------- opérations

def _wb_gains(temp: float, tint: float) -> tuple[float, float, float]:
    t, g = temp / 100.0, tint / 100.0
    return (2.0 ** (0.5 * t + 0.15 * g),
            2.0 ** (-0.3 * g),
            2.0 ** (-0.5 * t + 0.15 * g))


def _apply_linear_stage(img: np.ndarray, temp: float, tint: float, exposure: float) -> np.ndarray:
    if not (temp or tint or exposure):
        return img
    rg, gg, bg = _wb_gains(temp, tint)
    ev = 2.0 ** float(exposure)
    if rsfast.available():   # même math (LUT sRGB 4096), multi-cœur
        return rsfast.linear_stage(img, rg * ev, gg * ev, bg * ev)
    lin = srgb_to_linear(img)
    lin[..., 0] *= rg * ev
    lin[..., 1] *= gg * ev
    lin[..., 2] *= bg * ev
    return linear_to_srgb(lin)


def _apply_hl_shadows(img: np.ndarray, highlights: float, shadows: float,
                      ref_long_edge: Optional[int] = None) -> np.ndarray:
    """`ref_long_edge` : bord long de référence pour le sigma du flou (défaut : celui de `img`).
    À fournir explicitement quand `img` est un recadrage (retouche locale sur boîte englobante,
    cf. `_apply_local`), pour que le rayon reste celui de l'image complète."""
    if not (highlights or shadows):
        return img
    hl, sh = highlights / 100.0, shadows / 100.0
    l = luma(img)
    lb = gauss(l, (ref_long_edge or max(img.shape[:2])) * 0.02)
    if rsfast.available():   # combinaison per-pixel (gain) multi-cœur ; flou laissé à cv2
        return rsfast.hl_shadows(img, lb, hl, sh)
    gain = np.ones_like(lb)
    if hl:
        w_h = _smoothstep(0.35, 0.95, lb) ** 1.2
        gain *= 2.0 ** (hl * 0.9 * w_h)
    if sh:
        w_s = (1.0 - _smoothstep(0.05, 0.65, lb)) ** 1.2
        gain *= 2.0 ** (sh * 0.9 * w_s)
    return img * gain[..., None]


def _apply_whites_blacks(img: np.ndarray, whites: float, blacks: float) -> np.ndarray:
    if not (whites or blacks):
        return img
    wp = 1.0 - 0.25 * (whites / 100.0)
    bp = -0.20 * (blacks / 100.0)
    denom = max(wp - bp, 0.05)
    if rsfast.available():
        return rsfast.whites_blacks(img, bp, denom)
    return (img - bp) / denom


def _apply_contrast(img: np.ndarray, contrast: float) -> np.ndarray:
    if not contrast:
        return img
    c = contrast / 100.0
    if rsfast.available():
        return rsfast.contrast(img, c)
    x = np.clip(img, 0.0, 1.0)
    if c > 0:  # fondu vers une courbe en S douce (pas d'écrêtage brutal)
        s = x * x * (3.0 - 2.0 * x)
        return x + c * (s - x)
    return x + (-c) * ((0.5 + (x - 0.5) * 0.6) - x)


@functools.lru_cache(maxsize=128)
def _curve_lut(pts_key: tuple, n: int = 1024) -> Optional[np.ndarray]:
    """LUT par interpolation monotone PCHIP (Fritsch–Carlson). pts_key est un tuple immutable de points."""
    pts = sorted(pts_key)
    if len(pts) < 2:
        return None
    x = np.array([p[0] for p in pts], dtype=np.float64)
    y = np.clip([p[1] for p in pts], 0.0, 1.0).astype(np.float64)
    if len(pts) == 2 and abs(y[0]) < 1e-6 and abs(y[1] - 1.0) < 1e-6 \
            and abs(x[0]) < 1e-6 and abs(x[1] - 1.0) < 1e-6:
        return None  # courbe identité
    h = np.diff(x)
    h[h < 1e-6] = 1e-6
    m = np.diff(y) / h
    d = np.zeros_like(x)
    d[0], d[-1] = m[0], m[-1]
    for i in range(1, len(x) - 1):
        if m[i - 1] * m[i] <= 0:
            d[i] = 0.0
        else:
            w1 = 2 * h[i] + h[i - 1]
            w2 = h[i] + 2 * h[i - 1]
            d[i] = (w1 + w2) / (w1 / m[i - 1] + w2 / m[i])
    xs = np.linspace(0.0, 1.0, n)
    idx = np.clip(np.searchsorted(x, xs) - 1, 0, len(x) - 2)
    t = (xs - x[idx]) / h[idx]
    h00 = (1 + 2 * t) * (1 - t) ** 2
    h10 = t * (1 - t) ** 2
    h01 = t * t * (3 - 2 * t)
    h11 = t * t * (t - 1)
    lut = h00 * y[idx] + h10 * h[idx] * d[idx] + h01 * y[idx + 1] + h11 * h[idx] * d[idx + 1]
    lut[xs <= x[0]] = y[0]
    lut[xs >= x[-1]] = y[-1]
    return np.clip(lut, 0.0, 1.0).astype(np.float32)


def _pts_key(points: list) -> tuple:
    # x ET y arrondis : sinon un drag de courbe génère une clé inédite à chaque frame et la
    # lru_cache de `_curve_lut` rate (recalcul PCHIP). 1e-5 reste imperceptible sur une LUT 1024.
    return tuple(sorted({(round(float(p[0]), 5), round(float(p[1]), 5)) for p in (points or [])}))


def _eval_lut(lut: np.ndarray, x: np.ndarray) -> np.ndarray:
    idx = np.clip(x * (len(lut) - 1), 0, len(lut) - 1).astype(np.int32)
    return lut[idx]


@functools.lru_cache(maxsize=64)
def _composed_curve_luts(points_key: tuple, r_key: tuple, g_key: tuple,
                         b_key: tuple) -> Optional[tuple]:
    """LUT composée par canal — composed(x) = chan(master(x)) —, mémoïsée par combinaison de
    courbes (maître + r/g/b) : un drag de slider hors courbe (expo, contraste…) rejoue le
    pipeline sans recalculer cette composition. `None` si la courbe est l'identité partout."""
    master = _curve_lut(points_key)
    n = 1024
    xs = np.linspace(0.0, 1.0, n, dtype=np.float32)
    base = _eval_lut(master, xs) if master is not None else xs  # maître appliqué (ou identité)
    luts: list[Optional[np.ndarray]] = []
    changed = master is not None
    for key in (r_key, g_key, b_key):
        chan = _curve_lut(key)
        if master is None and chan is None:
            luts.append(None)
            continue
        luts.append((_eval_lut(chan, base) if chan is not None else base).astype(np.float32))
        changed = True
    return tuple(luts) if changed else None


def _apply_curve(img: np.ndarray, curve: dict) -> np.ndarray:
    """Courbe maître (`points`, appliquée aux 3 canaux) puis courbes par canal (`r`/`g`/`b`),
    pré-composées en une seule LUT par canal (identique au GPU : un seul échantillonnage)."""
    luts = _composed_curve_luts(_pts_key(curve.get("points")), _pts_key(curve.get("r")),
                                _pts_key(curve.get("g")), _pts_key(curve.get("b")))
    if luts is None:
        return img
    if rsfast.available():   # lookup LUT par canal (LUT composées ci-dessus), multi-cœur
        return rsfast.curve(img, luts)
    out = img.copy()
    for ci, lut in enumerate(luts):
        if lut is not None:
            out[..., ci] = _eval_lut(lut, img[..., ci])
    return out


def _band_weight(hue: np.ndarray, center: float, half_width: float = 45.0) -> np.ndarray:
    dist = np.abs(((hue - center) + 180.0) % 360.0 - 180.0)
    w = 0.5 * (1.0 + np.cos(np.pi * np.minimum(dist / half_width, 1.0)))
    return w.astype(np.float32)


def _saturation_ratio(s: np.ndarray, vibrance: float, saturation: float) -> np.ndarray:
    """Ratio multiplicatif appliqué à S (HSV) par vibrance puis saturation — mêmes formules que
    la branche pleine HSV ci-dessous. `s` = saturation HSV d'origine (utile à la branche
    vibrance>0 seulement, qui pondère par 1-s)."""
    ratio = np.ones_like(s)
    if vibrance:
        vib = vibrance / 100.0
        ratio = ratio * ((1.0 + vib * (1.0 - s) * 1.2) if vib > 0 else (1.0 + vib * 0.85))
    if saturation:
        ratio = ratio * (1.0 + saturation / 100.0)
    return ratio


def _apply_color(img: np.ndarray, hsl: dict, vibrance: float, saturation: float) -> np.ndarray:
    has_hsl = any(any(abs(v) > 1e-6 for v in band.values()) for band in hsl.values())
    if not (has_hsl or vibrance or saturation):
        return img
    if not has_hsl:
        # Pas de bande HSL (teinte/luminance par bande) à appliquer : vibrance/saturation seules
        # ne dépendent pas de la teinte → on évite l'aller-retour complet cv2.cvtColor RGB<->HSV
        # (coûteux en pleine résolution, appelé aussi par chaque retouche locale et par le dehaze).
        # Identité HSV à V et teinte fixes : c' = c·r + V·(1-r), r = S'/S (clampé sur [0,1]).
        x = np.clip(img, 0.0, 1.0)
        v = x.max(axis=-1, keepdims=True)
        mn = x.min(axis=-1, keepdims=True)
        s = np.where(v > 1e-6, (v - mn) / np.maximum(v, 1e-6), 0.0)
        ratio = _saturation_ratio(s[..., 0], vibrance, saturation)[..., None]
        s_new = np.clip(s * ratio, 0.0, 1.0)
        eff = np.where(s > 1e-6, s_new / np.maximum(s, 1e-6), 1.0)
        return x * eff + v * (1.0 - eff)
    hsv = cv2.cvtColor(np.clip(img, 0.0, 1.0), cv2.COLOR_RGB2HSV)
    if rsfast.available():   # math 8 bandes + vibrance/sat en place (multi-cœur), cvtColor laissé à OpenCV
        centers = np.array([c for _, c in HSL_BANDS], dtype=np.float32)
        bh = np.array([float((hsl.get(n) or {}).get("h", 0)) for n, _ in HSL_BANDS], dtype=np.float32)
        bs = np.array([float((hsl.get(n) or {}).get("s", 0)) for n, _ in HSL_BANDS], dtype=np.float32)
        bl = np.array([float((hsl.get(n) or {}).get("l", 0)) for n, _ in HSL_BANDS], dtype=np.float32)
        rsfast.hsl(hsv, centers, bh, bs, bl, float(vibrance), float(saturation))
        return cv2.cvtColor(hsv, cv2.COLOR_HSV2RGB)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    if has_hsl:
        h_shift = np.zeros_like(h)
        s_mult = np.ones_like(h)
        v_mult = np.ones_like(h)
        for name, center in HSL_BANDS:
            band = hsl.get(name) or {}
            bh, bs, bl = float(band.get("h", 0)), float(band.get("s", 0)), float(band.get("l", 0))
            if not (bh or bs or bl):
                continue
            w = _band_weight(h, center) * np.minimum(s * 4.0, 1.0)  # pas d'effet sur les gris
            h_shift += w * (bh / 100.0) * 30.0
            s_mult *= 1.0 + w * (bs / 100.0)        # -100 → désaturation totale de la bande
            v_mult *= 1.0 + w * (bl / 100.0) * 0.65
        h = (h + h_shift) % 360.0
        s = s * np.maximum(s_mult, 0.0)
        v = v * np.maximum(v_mult, 0.0)
    if vibrance:
        vib = vibrance / 100.0
        s = s * (1.0 + vib * (1.0 - s) * 1.2) if vib > 0 else s * (1.0 + vib * 0.85)
    if saturation:
        s = s * (1.0 + saturation / 100.0)
    hsv[..., 0] = h
    hsv[..., 1] = np.clip(s, 0.0, 1.0)
    hsv[..., 2] = np.clip(v, 0.0, 1.0)
    return cv2.cvtColor(hsv, cv2.COLOR_HSV2RGB)


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


_vignette_r_cache: dict[tuple[int, int], np.ndarray] = {}

def _apply_vignette(img: np.ndarray, vignette: float) -> np.ndarray:
    if not vignette:
        return img
    if rsfast.available():   # r calculé par pixel (même formule), multi-cœur
        return rsfast.vignette(img, vignette / 100.0)
    h, w = img.shape[:2]
    key = (h, w)
    if key not in _vignette_r_cache:
        ny, nx = np.mgrid[0:h, 0:w].astype(np.float32)
        nx = nx / max(w - 1, 1) * 2.0 - 1.0
        ny = ny / max(h - 1, 1) * 2.0 - 1.0
        _vignette_r_cache[key] = np.sqrt(nx * nx + ny * ny) / math.sqrt(2.0)
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


# ---------------------------------------------------------------- retouches locales

def _mask_bbox(mask: np.ndarray, eps: float) -> Optional[tuple[int, int, int, int]]:
    """(y0, y1, x0, x1) exclusif englobant `mask > eps`, ou None si vide."""
    rows = np.any(mask > eps, axis=1)
    cols = np.any(mask > eps, axis=0)
    if not rows.any():
        return None
    y0, y1 = np.flatnonzero(rows)[[0, -1]]
    x0, x1 = np.flatnonzero(cols)[[0, -1]]
    return int(y0), int(y1) + 1, int(x0), int(x1) + 1


def _apply_local(img: np.ndarray, local: dict, scale: float) -> np.ndarray:
    adj = local["adjust"]
    if not any(abs(float(v)) > 1e-6 for v in adj.values()):
        return img
    h, w = img.shape[:2]
    mask = build_mask(local, h, w, img)   # les masques par plage dépendent du contenu (img)
    if mask is None or float(mask.max()) < 1e-4:
        return img
    bbox = _mask_bbox(mask, 1e-4)
    if bbox is None:
        return img
    long_edge = max(h, w)
    # Halo autour de la boîte englobante = ~3σ des flous de la mini-pipeline (HL/ombres, clarté,
    # netteté), pour que le recadrage voie les mêmes pixels voisins que la pleine image et que le
    # résultat soit inchangé là où le masque est nul (d'où l'absence d'écart de rendu).
    halo = 0.0
    if adj["highlights"] or adj["shadows"]:
        halo = max(halo, 3.0 * long_edge * 0.02)
    if adj["clarity"]:
        halo = max(halo, 3.0 * max(8.0, long_edge * 0.012))
    if adj["sharpness"]:
        halo = max(halo, 3.0 * max(1.2 * scale, 0.4))
    pad = int(math.ceil(halo))
    y0, y1, x0, x1 = bbox
    y0, x0 = max(y0 - pad, 0), max(x0 - pad, 0)
    y1, x1 = min(y1 + pad, h), min(x1 + pad, w)

    sub_img, sub_mask = img[y0:y1, x0:x1], mask[y0:y1, x0:x1]
    out = sub_img
    out = _apply_linear_stage(out, float(adj["temp"]), float(adj["tint"]), float(adj["exposure"]))
    out = _apply_hl_shadows(out, float(adj["highlights"]), float(adj["shadows"]), ref_long_edge=long_edge)
    out = _apply_contrast(out, float(adj["contrast"]))
    if adj["saturation"]:
        out = _apply_color(out, {}, vibrance=0.0, saturation=float(adj["saturation"]))
    out = _apply_clarity(out, float(adj["clarity"]), scale, ref_long_edge=long_edge)
    if adj["sharpness"]:
        out = _apply_sharpen(out, float(adj["sharpness"]), 1.2, scale)
    m = sub_mask[..., None]
    blended = sub_img * (1.0 - m) + out * m
    if (y0, y1, x0, x1) == (0, h, 0, w):
        return blended
    result = img.copy()
    result[y0:y1, x0:x1] = blended
    return result


# ---------------------------------------------------------------- pipeline complet

def apply_pipeline(base: np.ndarray, edits: dict, scale: float = 1.0,
                   skip_crop: bool = False,
                   denoised_base: Optional[np.ndarray] = None,
                   seed: int = 0) -> np.ndarray:
    """base : float32 RGB 0..1 pleine image (avant géométrie). Renvoie float32 0..1.

    `denoised_base` : version débruitée par IA de `base` (mêmes dimensions). Si fournie et
    `detail.nr_ai > 0`, on mélange bruité↔débruité **tôt** (avant WB) pour que tout le reste
    du pipeline opère sur des données plus propres."""
    e = merge_edits(edits)
    img = apply_geometry(base.astype(np.float32, copy=True), e["geometry"], skip_crop=skip_crop)

    wb, tone, pres, det, fx = e["wb"], e["tone"], e["presence"], e["detail"], e["effects"]
    nr_ai = float(det.get("nr_ai", 0.0))
    if nr_ai > 0.0 and denoised_base is not None and denoised_base.shape == base.shape:
        dn = apply_geometry(denoised_base.astype(np.float32, copy=True), e["geometry"],
                            skip_crop=skip_crop)
        img = img + (nr_ai / 100.0) * (dn - img)
    img = _apply_linear_stage(img, float(wb["temp"]), float(wb["tint"]), float(tone["exposure"]))
    img = _apply_hl_shadows(img, float(tone["highlights"]), float(tone["shadows"]))
    img = _apply_whites_blacks(img, float(tone["whites"]), float(tone["blacks"]))
    img = _apply_contrast(img, float(tone["contrast"]))
    img = _apply_curve(np.clip(img, 0.0, 1.0), e["curve"])
    img = _apply_color(img, e["hsl"], float(pres["vibrance"]), float(pres["saturation"]))
    img = _apply_clarity(img, float(pres["clarity"]), scale)
    img = _apply_dehaze(img, float(pres["dehaze"]))
    for local in e["locals"]:
        img = _apply_local(img, local, scale)
    img = _apply_nr(img, float(det["nr_luma"]), float(det["nr_color"]), scale)
    img = _apply_defringe(img, float(det.get("defringe_purple", 0.0)),
                          float(det.get("defringe_green", 0.0)), scale)
    img = _apply_sharpen(img, float(det["sharpen_amount"]), float(det["sharpen_radius"]), scale)
    img = _apply_vignette(img, float(fx["vignette"]))
    img = _apply_grain(img, float(fx["grain"]), scale, seed)
    return np.clip(img, 0.0, 1.0)


def render_array(base: np.ndarray, edits: dict, max_size: int, full_long_edge: int,
                 show_mask: str = "", skip_crop: bool = False,
                 denoised_base: Optional[np.ndarray] = None, seed: int = 0,
                 bit_depth: int = 8) -> np.ndarray:
    """Pipeline + redimensionnement final ; renvoie RGB uint8 (bit_depth=8, défaut) ou uint16
    (bit_depth=16, pour l'export TIFF pleine dynamique)."""
    h, w = base.shape[:2]
    long_edge = max(h, w)

    # Pré-downscale : si max_size << long_edge, traiter une image réduite pour gagner du temps
    if max_size and long_edge > max_size:
        f = max_size / long_edge
        size = (max(int(w * f), 1), max(int(h * f), 1))
        working = cv2.resize(base, size, interpolation=cv2.INTER_AREA)
        # La base débruitée doit subir EXACTEMENT le même redimensionnement pour rester alignée.
        if denoised_base is not None and denoised_base.shape == base.shape:
            denoised_base = cv2.resize(denoised_base, size, interpolation=cv2.INTER_AREA)
    else:
        working = base

    scale = max(working.shape[:2]) / max(full_long_edge, 1)
    out = apply_pipeline(working, edits, scale=scale, skip_crop=skip_crop,
                         denoised_base=denoised_base, seed=seed)
    if show_mask:
        out = _overlay_mask(out, edits, show_mask)

    # Resize final (souvent un no-op si on a déjà pré-downscalé)
    oh, ow = out.shape[:2]
    if max_size and max(oh, ow) > max_size:
        f = max_size / max(oh, ow)
        out = cv2.resize(out, (max(int(ow * f), 1), max(int(oh * f), 1)),
                         interpolation=cv2.INTER_AREA)

    if bit_depth == 16:
        return (np.clip(out, 0.0, 1.0) * 65535.0 + 0.5).astype(np.uint16)
    return (np.clip(out, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)


def _overlay_mask(img: np.ndarray, edits: dict, local_id: str) -> np.ndarray:
    for local in merge_edits(edits)["locals"]:
        if str(local.get("id")) == str(local_id):
            mask = build_mask(local, img.shape[0], img.shape[1], img)
            if mask is None:
                return img
            m = (mask * 0.6)[..., None]
            red = np.array([1.0, 0.15, 0.15], dtype=np.float32)
            return img * (1.0 - m) + red * m
    return img


def encode_jpeg(arr: np.ndarray, quality: int = 88) -> bytes:
    ok, buf = cv2.imencode(".jpg", cv2.cvtColor(arr, cv2.COLOR_RGB2BGR),
                           [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
    if not ok:
        raise RuntimeError("Échec d'encodage JPEG")
    return buf.tobytes()


# ---------------------------------------------------------------- auto-réglages

def auto_adjust(base: np.ndarray, edits: dict) -> dict:
    """Suggère exposition + balance des blancs à partir de l'image (espace linéaire)."""
    e = merge_edits(edits)
    img = apply_geometry(base.astype(np.float32, copy=True), e["geometry"])
    small = cv2.resize(img, (256, max(int(256 * img.shape[0] / max(img.shape[1], 1)), 1)),
                       interpolation=cv2.INTER_AREA)
    lin = srgb_to_linear(small)
    med = float(np.median(luma(lin)))
    exposure = float(np.clip(math.log2(0.18 / max(med, 1e-4)), -2.5, 2.5))
    mr, mg, mb = [max(float(lin[..., i].mean()), 1e-4) for i in range(3)]
    rm, bm = math.log2(mg / mr), math.log2(mg / mb)
    temp = float(np.clip(100.0 * (rm - bm), -100.0, 100.0))
    tint = float(np.clip(100.0 * (rm + bm) / 0.9, -100.0, 100.0))
    e["tone"]["exposure"] = round(exposure, 2)
    e["wb"]["temp"] = round(temp, 1)
    e["wb"]["tint"] = round(tint, 1)
    return e


def wb_from_point(base: np.ndarray, edits: dict, x: float, y: float,
                  radius: float = 0.02) -> dict:
    """Pipette balance des blancs : température/teinte qui neutralisent le point (x, y).

    (x, y) sont normalisés (0..1) dans l'image *affichée* (recadrée). On échantillonne
    un petit patch de la base neutre (géométrie appliquée, sans WB) et on résout les
    gains qui égalisent les canaux en linéaire — même math que `auto_adjust`, donc le
    résultat est une valeur absolue indépendante des réglages WB courants."""
    e = merge_edits(edits)
    img = apply_geometry(base.astype(np.float32, copy=True), e["geometry"])
    h, w = img.shape[:2]
    cx = int(np.clip(x, 0.0, 1.0) * (w - 1))
    cy = int(np.clip(y, 0.0, 1.0) * (h - 1))
    r = max(1, int(round(radius * max(w, h))))
    patch = img[max(0, cy - r):cy + r + 1, max(0, cx - r):cx + r + 1]
    lin = srgb_to_linear(patch)
    mr, mg, mb = [max(float(lin[..., i].mean()), 1e-4) for i in range(3)]
    rm, bm = math.log2(mg / mr), math.log2(mg / mb)
    temp = float(np.clip(100.0 * (rm - bm), -100.0, 100.0))
    tint = float(np.clip(100.0 * (rm + bm) / 0.9, -100.0, 100.0))
    return {"temp": round(temp, 1), "tint": round(tint, 1)}
