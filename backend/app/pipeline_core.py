"""Primitives partagées du pipeline (LUT sRGB↔linéaire, luma, flou gaussien, gains WB) —
extrait de `pipeline.py` (TODO N11) : fonctions de fond sans dépendance sur le reste du pipeline,
réutilisées par `pipeline.py`, `pipeline_color.py` et `pipeline_detail.py`. Réexportées par
`pipeline.py` (`from .pipeline_core import ...`) pour ne rien casser côté appelants
(`pipeline.gauss`, `pipeline.luma`, etc. restent valides — utilisés par les tests de parité)."""
import cv2
import numpy as np

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
    # Garde contre e1==e0 (latent aujourd'hui : tous les appels actuels utilisent des bornes
    # constantes non nulles — mais l'équivalent dans masks.py/segment.py se protège déjà, cf.
    # audit1108.md L5 : toute future utilisation avec des bornes dérivées de réglages utilisateur
    # sinon un inf/nan silencieux propagé dans le rendu).
    t = np.clip((x - e0) / max(e1 - e0, 1e-6), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _wb_gains(temp: float, tint: float) -> tuple[float, float, float]:
    t, g = temp / 100.0, tint / 100.0
    return (2.0 ** (0.5 * t + 0.15 * g),
            2.0 ** (-0.3 * g),
            2.0 ** (-0.5 * t + 0.15 * g))
