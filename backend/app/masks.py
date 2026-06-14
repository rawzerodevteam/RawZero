"""Rasterisation des masques de retouche locale.

Coordonnées normalisées 0..1 relatives à l'image AFFICHÉE (après géométrie/crop),
x sur la largeur, y sur la hauteur. Renvoie un float32 (h, w) dans 0..1.
"""
from typing import Optional

import cv2
import numpy as np

from . import config


def _grid(h: int, w: int) -> tuple[np.ndarray, np.ndarray]:
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    return x / max(w - 1, 1), y / max(h - 1, 1)


def _smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / max(e1 - e0, 1e-6), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _linear_mask(params: dict, h: int, w: int) -> np.ndarray:
    """Dégradé : 1 du côté du point de départ, 0 après le point d'arrivée."""
    x0, y0 = float(params.get("x0", 0.5)), float(params.get("y0", 0.2))
    x1, y1 = float(params.get("x1", 0.5)), float(params.get("y1", 0.8))
    dx, dy = x1 - x0, y1 - y0
    norm2 = dx * dx + dy * dy
    if norm2 < 1e-8:
        return np.ones((h, w), np.float32)
    gx, gy = _grid(h, w)
    t = ((gx - x0) * dx + (gy - y0) * dy) / norm2
    return (1.0 - _smoothstep(0.0, 1.0, t)).astype(np.float32)


def _radial_mask(params: dict, h: int, w: int) -> np.ndarray:
    cx, cy = float(params.get("cx", 0.5)), float(params.get("cy", 0.5))
    rx = max(float(params.get("rx", 0.25)), 1e-3)
    ry = max(float(params.get("ry", 0.25)), 1e-3)
    angle = float(params.get("angle", 0.0)) * np.pi / 180.0
    feather = float(np.clip(params.get("feather", 0.5), 0.0, 1.0))
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


def _brush_mask(params: dict, h: int, w: int) -> np.ndarray:
    mask = np.zeros((h, w), np.float32)
    long_edge = max(h, w)
    feather = float(np.clip(params.get("feather", 0.5), 0.0, 1.0))
    max_radius = 1.0
    for stroke in params.get("strokes", []):
        pts = stroke.get("points") or []
        if not pts:
            continue
        radius = max(float(stroke.get("size", 0.05)) * long_edge * 0.5, 1.0)
        max_radius = max(max_radius, radius)
        value = 0.0 if stroke.get("erase") else 1.0
        px = [(int(round(float(p[0]) * (w - 1))), int(round(float(p[1]) * (h - 1)))) for p in pts]
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


def _ai_mask(params: dict, h: int, w: int) -> Optional[np.ndarray]:
    """Masque IA : recharge le bitmap stocké (PNG mono-canal) et le redimensionne à (h, w).

    `params['ref']` est un chemin relatif sous MASKS_DIR (« {photo_id}/{mask_id}.png »).
    Un feather optionnel adoucit les bords après agrandissement (utile au full-res export)."""
    ref = str(params.get("ref", ""))
    if not ref:
        return None
    path = (config.MASKS_DIR / ref).resolve()
    if config.MASKS_DIR.resolve() not in path.parents or not path.exists():
        return None
    raw = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if raw is None:
        return None
    mask = cv2.resize(raw.astype(np.float32) / 255.0, (w, h), interpolation=cv2.INTER_LINEAR)
    # Dureté : contraste autour de 0.5 (identité à 0, quasi binaire à 100) — durcit les bords
    # et écarte les zones de faible confiance (cf. dureté côté GPU, shader lblend).
    hardness = float(np.clip(params.get("hardness", 0.0), 0.0, 100.0))
    if hardness > 0:
        k = 1.0 + (hardness / 100.0) * 12.0
        mask = np.clip((mask - 0.5) * k + 0.5, 0.0, 1.0)
    return mask.astype(np.float32)


def build_mask(local: dict, h: int, w: int) -> Optional[np.ndarray]:
    kind = local.get("type", "")
    params = local.get("params") or {}
    if kind == "linear":
        mask = _linear_mask(params, h, w)
    elif kind == "radial":
        mask = _radial_mask(params, h, w)
    elif kind == "brush":
        mask = _brush_mask(params, h, w)
    elif kind == "ai":
        mask = _ai_mask(params, h, w)
    else:
        return None
    if mask is None:
        return None
    if local.get("invert"):
        mask = 1.0 - mask
    return mask
