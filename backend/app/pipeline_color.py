"""HSL 8 bandes + vibrance + saturation — extrait de `pipeline.py` (TODO N11). Dépend seulement
de `cv2`/`np`/`rsfast` (pas des autres modules `pipeline_*`) ; `pipeline_detail.py` (dehaze) et
`pipeline.py` en dépendent (sens unique, pas de cycle)."""
import cv2
import numpy as np

from . import rsfast

HSL_BANDS = [("red", 0.0), ("orange", 30.0), ("yellow", 60.0), ("green", 120.0),
             ("aqua", 180.0), ("blue", 240.0), ("purple", 280.0), ("magenta", 320.0)]


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
