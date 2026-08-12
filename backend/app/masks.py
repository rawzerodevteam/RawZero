"""Rasterisation des masques de retouche locale.

Coordonnées normalisées 0..1 relatives à l'image AFFICHÉE (après géométrie/crop),
x sur la largeur, y sur la hauteur. Renvoie un float32 (h, w) dans 0..1.
"""
from typing import Optional

import cv2
import numpy as np

from . import config


def _finite(v, default: float = 0.0) -> float:
    """Coerce en float fini : une valeur NaN/Infinity dans des edits corrompus (bug amont, edition
    manuelle de la DB…) ferait planter `int(round(...))` en aval (ValueError/OverflowError) et
    rendrait la photo définitivement impossible à développer/exporter (500) sans recours en UI."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if np.isfinite(f) else default


def _finite_clip(v, default: float, lo: float, hi: float) -> float:
    return float(np.clip(_finite(v, default), lo, hi))


def _grid(h: int, w: int) -> tuple[np.ndarray, np.ndarray]:
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    return x / max(w - 1, 1), y / max(h - 1, 1)


def _smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / max(e1 - e0, 1e-6), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _luma(img: np.ndarray) -> np.ndarray:
    return img[..., 0] * 0.2126 + img[..., 1] * 0.7152 + img[..., 2] * 0.0722


def _lumrange_mask(params: dict, img: Optional[np.ndarray]) -> Optional[np.ndarray]:
    """Masque par plage de luminance : 1 dans [lo, hi], adouci de `smooth` aux bords."""
    if img is None:
        return None
    lo = _finite_clip(params.get("lo", 0.25), 0.25, 0.0, 1.0)
    hi = _finite_clip(params.get("hi", 0.75), 0.75, 0.0, 1.0)
    if hi < lo:
        lo, hi = hi, lo
    sm = _finite_clip(params.get("smooth", 0.1), 0.1, 1e-3, 0.5)
    l = _luma(img)
    m = _smoothstep(lo - sm, lo, l) * (1.0 - _smoothstep(hi, hi + sm, l))
    return m.astype(np.float32)


def _colorrange_mask(params: dict, img: Optional[np.ndarray]) -> Optional[np.ndarray]:
    """Masque par plage de couleur : proximité de teinte (± `range`, adoucie de `smooth`),
    pondérée par la saturation (au-dessus de `sat_min`)."""
    if img is None:
        return None
    hue = _finite(params.get("hue", 0.0), 0.0)
    rng = max(_finite(params.get("range", 30.0), 30.0), 0.0)
    sm = max(_finite(params.get("smooth", 15.0), 15.0), 1e-3)
    sat_min = max(_finite(params.get("sat_min", 0.15), 0.15), 1e-3)
    hsv = cv2.cvtColor(np.clip(img, 0.0, 1.0), cv2.COLOR_RGB2HSV)
    h, s = hsv[..., 0], hsv[..., 1]
    hd = np.abs(((h - hue) + 180.0) % 360.0 - 180.0)
    hue_w = 1.0 - _smoothstep(rng, rng + sm, hd)
    sat_w = _smoothstep(0.0, sat_min, s)
    return (hue_w * sat_w).astype(np.float32)


def _linear_mask(params: dict, h: int, w: int) -> np.ndarray:
    """Dégradé : 1 du côté du point de départ, 0 après le point d'arrivée."""
    x0, y0 = _finite(params.get("x0", 0.5), 0.5), _finite(params.get("y0", 0.2), 0.2)
    x1, y1 = _finite(params.get("x1", 0.5), 0.5), _finite(params.get("y1", 0.8), 0.8)
    dx, dy = x1 - x0, y1 - y0
    norm2 = dx * dx + dy * dy
    if norm2 < 1e-8:
        return np.ones((h, w), np.float32)
    gx, gy = _grid(h, w)
    t = ((gx - x0) * dx + (gy - y0) * dy) / norm2
    return (1.0 - _smoothstep(0.0, 1.0, t)).astype(np.float32)


def _radial_mask(params: dict, h: int, w: int) -> np.ndarray:
    cx, cy = _finite(params.get("cx", 0.5), 0.5), _finite(params.get("cy", 0.5), 0.5)
    rx = max(_finite(params.get("rx", 0.25), 0.25), 1e-3)
    ry = max(_finite(params.get("ry", 0.25), 0.25), 1e-3)
    angle = _finite(params.get("angle", 0.0), 0.0) * np.pi / 180.0
    feather = _finite_clip(params.get("feather", 0.5), 0.5, 0.0, 1.0)
    gx, gy = _grid(h, w)
    # espace isotrope (corrige l'aspect) puis rotation de l'ellipse
    ar = w / max(h, 1)
    px, py = (gx - cx) * ar, (gy - cy)
    if abs(angle) > 1e-4:
        ca, sa = np.cos(angle), np.sin(angle)
        px, py = px * ca + py * sa, -px * sa + py * ca
    d = np.sqrt((px / (rx * ar)) ** 2 + (py / ry) ** 2)
    inner = max(1.0 - feather, 0.0)
    return (1.0 - _smoothstep(inner, 1.0 + 0.25 * feather, d)).astype(np.float32)


def _light_mask(params: dict, h: int, w: int) -> np.ndarray:
    """Source de lumière artificielle : même géométrie ellipse que le filtre radial (centre/rayons/
    angle), mais falloff **photométrique** (1/(1+(falloff·distance)²)) à l'intérieur au lieu d'un
    simple smoothstep — pic d'intensité franc au centre puis décroissance qui rappelle une vraie
    source ponctuelle, avant le fondu de bord (`feather`) qui referme le masque comme pour le radial.
    `falloff` (défaut 1.8) : plus grand = source plus concentrée (spot), plus petit = plus diffuse."""
    cx, cy = _finite(params.get("cx", 0.5), 0.5), _finite(params.get("cy", 0.5), 0.5)
    rx = max(_finite(params.get("rx", 0.25), 0.25), 1e-3)
    ry = max(_finite(params.get("ry", 0.25), 0.25), 1e-3)
    angle = _finite(params.get("angle", 0.0), 0.0) * np.pi / 180.0
    feather = _finite_clip(params.get("feather", 0.5), 0.5, 0.0, 1.0)
    falloff = max(_finite(params.get("falloff", 1.8), 1.8), 0.1)
    gx, gy = _grid(h, w)
    ar = w / max(h, 1)
    px, py = (gx - cx) * ar, (gy - cy)
    if abs(angle) > 1e-4:
        ca, sa = np.cos(angle), np.sin(angle)
        px, py = px * ca + py * sa, -px * sa + py * ca
    d = np.sqrt((px / (rx * ar)) ** 2 + (py / ry) ** 2)
    energy = 1.0 / (1.0 + (falloff * d) ** 2)
    inner = max(1.0 - feather, 0.0)
    edge = 1.0 - _smoothstep(inner, 1.0 + 0.25 * feather, d)
    return (energy * edge).astype(np.float32)


def _brush_mask(params: dict, h: int, w: int) -> np.ndarray:
    mask = np.zeros((h, w), np.float32)
    long_edge = max(h, w)
    feather = _finite_clip(params.get("feather"), 0.5, 0.0, 1.0)
    max_radius = 1.0
    for stroke in params.get("strokes", []):
        pts = stroke.get("points") or []
        if not pts:
            continue
        radius = max(_finite(stroke.get("size", 0.05), 0.05) * long_edge * 0.5, 1.0)
        max_radius = max(max_radius, radius)
        value = 0.0 if stroke.get("erase") else 1.0
        px = [(int(round(np.clip(_finite(p[0]), 0.0, 1.0) * (w - 1))),
               int(round(np.clip(_finite(p[1]), 0.0, 1.0) * (h - 1)))) for p in pts]
        r = int(round(radius))
        if len(px) == 1:
            cv2.circle(mask, px[0], r, value, -1, lineType=cv2.LINE_AA)
        for a, b in zip(px[:-1], px[1:]):
            cv2.line(mask, a, b, value, thickness=max(2 * r, 1), lineType=cv2.LINE_AA)
            cv2.circle(mask, b, r, value, -1, lineType=cv2.LINE_AA)
        cv2.circle(mask, px[0], r, value, -1, lineType=cv2.LINE_AA)
    if feather > 0:
        sigma = max(max_radius * feather * 0.6, 0.5)
        mask = cv2.GaussianBlur(mask, (0, 0), sigma)
    return np.clip(mask, 0.0, 1.0)


def _load_ref_png(ref: str, h: int, w: int) -> Optional[np.ndarray]:
    """Recharge un bitmap mono-canal stocké sous MASKS_DIR (« {photo_id}/{mask_id}.png ») et le
    redimensionne à (h, w). Partagé par les masques IA (`ai`) et par plage de profondeur
    (`depthrange`) — seul le post-traitement diffère entre les deux."""
    if not ref:
        return None
    path = (config.MASKS_DIR / ref).resolve()
    if config.MASKS_DIR.resolve() not in path.parents or not path.exists():
        return None
    raw = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if raw is None:
        return None
    return cv2.resize(raw.astype(np.float32) / 255.0, (w, h), interpolation=cv2.INTER_LINEAR)


def _ai_mask(params: dict, h: int, w: int) -> Optional[np.ndarray]:
    """Masque IA : recharge le bitmap stocké (PNG mono-canal) et le redimensionne à (h, w).

    `params['ref']` est un chemin relatif sous MASKS_DIR (« {photo_id}/{mask_id}.png »).
    Un feather optionnel adoucit les bords après agrandissement (utile au full-res export)."""
    mask = _load_ref_png(str(params.get("ref", "")), h, w)
    if mask is None:
        return None
    # Dureté : contraste autour de 0.5 (identité à 0, quasi binaire à 100) — durcit les bords
    # et écarte les zones de faible confiance (cf. dureté côté GPU, shader lblend).
    hardness = _finite_clip(params.get("hardness"), 0.0, 0.0, 100.0)
    if hardness > 0:
        k = 1.0 + (hardness / 100.0) * 12.0
        mask = np.clip((mask - 0.5) * k + 0.5, 0.0, 1.0)
    return mask.astype(np.float32)


def _depthrange_mask(params: dict, h: int, w: int) -> Optional[np.ndarray]:
    """Masque par plage de profondeur : recharge la carte de profondeur précalculée (PNG, 1.0 =
    proche, 0.0 = lointain — cf. `depth.depth_map`) et applique un seuillage lissé [near, far],
    exactement comme `_lumrange_mask` mais sur la profondeur au lieu de la luminance."""
    mask = _load_ref_png(str(params.get("ref", "")), h, w)
    if mask is None:
        return None
    near = _finite_clip(params.get("near", 0.0), 0.0, 0.0, 1.0)
    far = _finite_clip(params.get("far", 1.0), 1.0, 0.0, 1.0)
    if far < near:
        near, far = far, near
    sm = _finite_clip(params.get("smooth", 0.15), 0.15, 1e-3, 0.5)
    return (_smoothstep(near - sm, near, mask) * (1.0 - _smoothstep(far, far + sm, mask))).astype(np.float32)


def build_mask(local: dict, h: int, w: int, img: Optional[np.ndarray] = None) -> Optional[np.ndarray]:
    """`img` (float32 RGB 0..1 de l'image affichée) n'est requis que par les masques
    par plage (luminance/couleur) qui dépendent du contenu ; None sinon."""
    kind = local.get("type", "")
    params = local.get("params") or {}
    if kind == "linear":
        mask = _linear_mask(params, h, w)
    elif kind == "radial":
        mask = _radial_mask(params, h, w)
    elif kind == "light":
        mask = _light_mask(params, h, w)
    elif kind == "inpaint":
        # Forme en traits de pinceau (mêmes points/rayon que le masque "brush") : la zone peinte
        # définit ce qui doit être effacé/regénéré. Le patch IA précalculé et `opacity` (force du
        # blend) ne concernent pas la forme, lus par _apply_inpaint.
        mask = _brush_mask(params, h, w)
    elif kind == "brush":
        mask = _brush_mask(params, h, w)
    elif kind == "ai":
        mask = _ai_mask(params, h, w)
    elif kind == "lumrange":
        mask = _lumrange_mask(params, img)
    elif kind == "depthrange":
        mask = _depthrange_mask(params, h, w)
    elif kind == "colorrange":
        mask = _colorrange_mask(params, img)
    else:
        return None
    if mask is None:
        return None
    if local.get("invert"):
        mask = 1.0 - mask
    return mask
