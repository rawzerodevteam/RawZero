"""Géométrie (rotation/miroirs/redressement/recadrage) — extrait de `pipeline.py` (TODO N11) :
aucune dépendance sur le reste du pipeline (cv2/np/math seulement)."""
import math

import cv2
import numpy as np


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
