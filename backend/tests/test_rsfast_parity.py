"""Parité rsfast (Rust) ↔ NumPy, étage par étage (N10 du backlog perf/robustesse).

`pipeline.py` bascule chaque étage pur-pixel (et certaines étapes à voisinage dont le flou
reste calculé côté NumPy/cv2, cf. commentaires `rsfast.available()`) vers l'implémentation
Rust quand elle est compilée. Le golden de `test_parity.py` force `rsfast.available()=False`
pour rester stable indépendamment de l'accélérateur — ce qui laisse le chemin Rust sans
filet : une régression silencieuse du binaire ne casserait aucun test si `rsfast` est présent
en CI. Ce fichier compare directement les deux chemins, étage par étage, sur une image
aléatoire ; ignoré (skip) si le binaire n'est pas compilé (`backend/rsfast/target/release/`).
"""
import numpy as np
import pytest

from app import pipeline as P
from app import rsfast

# Force le chargement de la lib une fois (le monkeypatch ci-dessous ne touche que
# `pipeline.rsfast.available`, pas le chargement paresseux interne de `rsfast._lib`).
_RSFAST_ON = rsfast.available()

pytestmark = pytest.mark.skipif(not _RSFAST_ON, reason="rsfast non compilé (backend/rsfast)")

# Marge généreuse au-dessus des écarts mesurés (≤ ~1.2e-7, epsilon float32) et bien en
# dessous du seuil de régression GPU↔Python (2/255 ≈ 7.8e-3, cf. test_parity.py).
_TIGHT = 1e-4     # étages documentés "bit-exact" (contraste, courbe)
_LOOSE = 2e-3     # étages documentés "≤ 0.035/255" ou "combinaison per-pixel" (le reste)


def _img() -> np.ndarray:
    rng = np.random.default_rng(42)
    return rng.random((48, 64, 3), dtype=np.float32)


def _compare(monkeypatch, fn, tol: float, *args, **kwargs) -> None:
    monkeypatch.setattr(P.rsfast, "available", lambda: True)
    rust = fn(_img(), *args, **kwargs)
    monkeypatch.setattr(P.rsfast, "available", lambda: False)
    numpy_ = fn(_img(), *args, **kwargs)
    diff = float(np.abs(rust - numpy_).max())
    assert diff < tol, f"{fn.__name__} : écart rsfast/NumPy {diff:.2e} ≥ {tol:.0e}"


def test_linear_stage(monkeypatch):
    _compare(monkeypatch, P._apply_linear_stage, _LOOSE, 40.0, -20.0, 0.6)


def test_whites_blacks(monkeypatch):
    _compare(monkeypatch, P._apply_whites_blacks, _LOOSE, 50.0, -40.0)


def test_contrast(monkeypatch):
    _compare(monkeypatch, P._apply_contrast, _TIGHT, 55.0)


def test_curve(monkeypatch):
    curve = {"points": [[0.0, 0.0], [0.3, 0.15], [0.7, 0.9], [1.0, 1.0]],
             "r": [[0.0, 0.0], [1.0, 1.0]], "g": [[0.0, 0.0], [1.0, 1.0]], "b": [[0.0, 0.0], [1.0, 1.0]]}

    def clipped_curve(img, c):
        return P._apply_curve(np.clip(img, 0.0, 1.0), c)

    _compare(monkeypatch, clipped_curve, _TIGHT, curve)


def test_color_hsl_vibrance_saturation(monkeypatch):
    hsl = {b: {"h": 0.0, "s": 0.0, "l": 0.0}
           for b in ("red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta")}
    hsl["red"] = {"h": 20.0, "s": -30.0, "l": 10.0}
    _compare(monkeypatch, P._apply_color, _LOOSE, hsl, 30.0, 20.0)


def test_hl_shadows(monkeypatch):
    _compare(monkeypatch, P._apply_hl_shadows, _LOOSE, 40.0, -30.0)


def test_clarity(monkeypatch):
    _compare(monkeypatch, P._apply_clarity, _LOOSE, 50.0, 1.0)


def test_defringe(monkeypatch):
    _compare(monkeypatch, P._apply_defringe, _LOOSE, 60.0, 40.0, 1.0)


def test_sharpen(monkeypatch):
    _compare(monkeypatch, P._apply_sharpen, _LOOSE, 50.0, 1.2, 1.0)


def test_vignette(monkeypatch):
    _compare(monkeypatch, P._apply_vignette, _LOOSE, -40.0)
