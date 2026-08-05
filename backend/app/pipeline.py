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

from . import config, rsfast
from .masks import build_mask, _finite, _finite_clip
from .pipeline_core import gauss, luma, srgb_to_linear, linear_to_srgb, _smoothstep, _wb_gains
from .pipeline_geometry import apply_geometry
from .pipeline_color import HSL_BANDS, _apply_color
from .pipeline_detail import (
    _apply_clarity, _apply_dehaze, _apply_nr, _apply_defringe, _apply_sharpen,
    _apply_vignette, _apply_grain,
)

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

def merge_edits(edits: Optional[dict]) -> dict:
    """Fusion récursive avec les valeurs par défaut (tolère un état partiel)."""
    def merge(default: Any, value: Any) -> Any:
        if isinstance(default, dict):
            if not isinstance(value, dict):
                return default
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


# ---------------------------------------------------------------- opérations
# (primitives de fond luma/gauss/srgb↔linéaire et géométrie : cf. pipeline_core.py /
# pipeline_geometry.py, importées ci-dessus et réexposées ici — TODO N11)


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


def _apply_inpaint(img: np.ndarray, local: dict) -> np.ndarray:
    """Correcteur de taches IA : fond un patch précalculé (`params.ref`, PNG RGB produit par
    `inpaint.inpaint()` côté endpoint `/photos/{id}/inpaint`) dans la zone destination (forme
    radiale), pondéré par le masque feathered × opacity. Contrairement à `_apply_local` (réglages
    tonaux modulés par un masque), c'est une composition de pixels — pas de mini-pipeline
    exposition/contraste/etc. Le calcul du patch lui-même (inférence IA) n'a lieu qu'une fois, à
    la création/au déplacement du masque côté client — ici on ne fait que le repositionner/
    redimensionner à la résolution courante (preview ↔ export) et le fondre, comme `_ai_mask`
    le fait déjà pour les masques IA sujet/clic (mais en RGB, pas juste un canal de masque).

    Le PNG stocké ne couvre PAS la bbox du masque : c'est le rectangle de contexte (avec halo)
    capturé au moment du calcul IA, `params.rect` (coordonnées image normalisées, mêmes
    conventions que `_grid`). Il faut reprojeter chaque pixel de la bbox du masque dans l'espace
    UV du patch via ce rectangle — exactement le mapping affine du shader GPU F_INPAINTBLEND
    (`u_rect`) — plutôt que d'étirer bêtement le patch entier dans la bbox du masque (bug : les
    deux rectangles ont des tailles différentes, ce qui déforme/décale le résultat)."""
    h, w = img.shape[:2]
    mask = build_mask(local, h, w, img)
    if mask is None or float(mask.max()) < 1e-4:
        return img
    bbox = _mask_bbox(mask, 1e-4)
    if bbox is None:
        return img
    params = local.get("params") or {}
    ref = str(params.get("ref", ""))
    if not ref:
        return img
    path = (config.MASKS_DIR / ref).resolve()
    if config.MASKS_DIR.resolve() not in path.parents or not path.exists():
        return img
    raw = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if raw is None:
        return img
    patch = cv2.cvtColor(raw, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    ph, pw = patch.shape[:2]

    rect = params.get("rect")
    if not (isinstance(rect, (list, tuple)) and len(rect) == 4):
        rect = [0.0, 0.0, 1.0, 1.0]
    rx0, ry0, rx1, ry1 = (_finite(v, d) for v, d in zip(rect, (0.0, 0.0, 1.0, 1.0)))
    ww, hh = max(w - 1, 1), max(h - 1, 1)
    denom_x, denom_y = max(rx1 - rx0, 1e-4), max(ry1 - ry0, 1e-4)

    y0, y1, x0, x1 = bbox
    opacity = _finite_clip(params.get("opacity", 1.0), 1.0, 0.0, 1.0)

    # Reprojection affine bbox masque → UV patch (identique à u_rect côté shader) ; clamp = même
    # comportement de bord que le `clamp()` GLSL (répète le pixel de bord hors du rectangle).
    gx, gy = np.meshgrid(np.arange(x0, x1, dtype=np.float32), np.arange(y0, y1, dtype=np.float32))
    u = np.clip((gx / ww - rx0) / denom_x, 0.0, 1.0) * (pw - 1)
    v = np.clip((gy / hh - ry0) / denom_y, 0.0, 1.0) * (ph - 1)
    sampled = cv2.remap(patch, u, v, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

    sub_dst, sub_mask = img[y0:y1, x0:x1], mask[y0:y1, x0:x1]
    blend = (sub_mask * opacity)[..., None]
    blended = sub_dst * (1.0 - blend) + sampled * blend
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
        if local.get("type") == "inpaint":
            img = _apply_inpaint(img, local)
        else:
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


_HSL_SAMPLE_SIZE = 640  # patch pris sur une version réduite : la couleur ne dépend pas de la
                        # résolution, seul le rayon des opérations à voisinage en dépendrait


def hsl_band_from_point(base: np.ndarray, edits: dict, x: float, y: float,
                        radius: float = 0.02) -> dict:
    """Pipette HSL : bande (`HSL_BANDS`) la plus proche de la teinte du point (x, y) cliqué,
    sur l'image *telle qu'affichée* (pipeline complet appliqué avec les réglages courants,
    y compris HSL actuel) — pour indiquer au client quelle bande régler, pas une valeur
    d'édition à appliquer directement (contrairement à `wb_from_point`)."""
    h0, w0 = base.shape[:2]
    long_edge = max(h0, w0)
    if long_edge > _HSL_SAMPLE_SIZE:
        f = _HSL_SAMPLE_SIZE / long_edge
        working = cv2.resize(base, (max(int(w0 * f), 1), max(int(h0 * f), 1)), interpolation=cv2.INTER_AREA)
    else:
        working = base
    img = apply_pipeline(working, edits, scale=1.0)
    h, w = img.shape[:2]
    cx = int(np.clip(x, 0.0, 1.0) * (w - 1))
    cy = int(np.clip(y, 0.0, 1.0) * (h - 1))
    r = max(1, int(round(radius * max(w, h))))
    patch = img[max(0, cy - r):cy + r + 1, max(0, cx - r):cx + r + 1]
    rr, gg, bb = [float(patch[..., i].mean()) for i in range(3)]
    mx, mn = max(rr, gg, bb), min(rr, gg, bb)
    d = mx - mn
    if d < 1e-4:
        # Gris/neutre : aucune bande dominante, retombe sur la 1ʳᵉ par convention plutôt que
        # de renvoyer une teinte arbitraire (division par ~0 dans le calcul de teinte).
        hue, sat = 0.0, 0.0
    else:
        if mx == rr:
            hue = 60.0 * (((gg - bb) / d) % 6.0)
        elif mx == gg:
            hue = 60.0 * (((bb - rr) / d) + 2.0)
        else:
            hue = 60.0 * (((rr - gg) / d) + 4.0)
        sat = d / max(mx, 1e-6)
    band = min(HSL_BANDS, key=lambda c: min(abs(hue - c[1]), 360.0 - abs(hue - c[1])))[0]
    return {"band": band, "hue": round(hue, 1), "saturation": round(sat, 3)}
