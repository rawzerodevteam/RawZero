"""Régression visuelle GPU↔Python (#9) — accord per-pixel des étages du pipeline.

Idée : chaque étage *per-pixel* du pipeline (sans voisinage) est exécuté ici par le
vrai code Python sur un jeu de pixels représentatifs ; le résultat (« golden ») est
sérialisé dans ``frontend/tests/fixtures/parity.json``. Le test front
(``frontend/tests/parity.test.ts``) rejoue la math des shaders GLSL via un port CPU
(``gpu/cpuPipeline.ts``) sur les mêmes entrées et vérifie l'accord à ~2/255 près.

Filet à deux faces :
  - si ``pipeline.py`` change, le golden commité ne correspond plus → ce test Python
    casse → on régénère (``RAWSTUDIO_WRITE_FIXTURES=1``) ;
  - si la régénération change le golden mais que le GLSL/port CPU n'a pas suivi, le
    test front casse à son tour.

Étages couverts (tous purement per-pixel, ordre du pipeline) : WB+exposition (linéaire),
blancs/noirs, contraste, courbe (maître + canal), couleur (HSL/vibrance/saturation).
Les opérations à voisinage (HL/ombres, clarté, dehaze, NR, défrange, netteté, vignettage)
ne sont pas couvertes ici : elles dépendent d'un flou gaussien qu'un port scalaire ne
reproduit pas fidèlement.
"""
import json
import os
from pathlib import Path

import numpy as np

from app import pipeline

FIXTURE = (Path(__file__).resolve().parents[2]
           / "frontend" / "tests" / "fixtures" / "parity.json")

# Pixels représentatifs (RGB sRGB 0..1) : gris étagés, primaires, pastels, voile coloré.
PIXELS = [
    [0.05, 0.05, 0.05], [0.20, 0.20, 0.20], [0.50, 0.50, 0.50],
    [0.80, 0.80, 0.80], [0.95, 0.95, 0.95],
    [0.80, 0.20, 0.20], [0.20, 0.70, 0.30], [0.20, 0.30, 0.80],
    [0.90, 0.80, 0.20], [0.60, 0.30, 0.70],
    [0.48, 0.50, 0.55], [0.90, 0.50, 0.30], [0.30, 0.60, 0.60],
    [0.15, 0.40, 0.70], [0.70, 0.70, 0.40],
]

_ID = [[0.0, 0.0], [1.0, 1.0]]
_HSL0 = {b: {"h": 0.0, "s": 0.0, "l": 0.0}
         for b in ("red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta")}


def _img() -> np.ndarray:
    return np.array(PIXELS, np.float32).reshape(-1, 1, 3)


def _build_fixture() -> dict:
    """Calcule chaque étage avec le vrai pipeline Python → dict sérialisable."""
    cases: list[dict] = []

    def add(name: str, stage: str, params: dict, arr: np.ndarray) -> None:
        cases.append({
            "name": name, "stage": stage, "params": params,
            "output": np.round(arr.reshape(-1, 3), 6).tolist(),
        })

    # 1) linéaire : balance des blancs + exposition
    add("linear_warm", "linear", {"temp": 60.0, "tint": 0.0, "exposure": 0.0},
        pipeline._apply_linear_stage(_img(), 60.0, 0.0, 0.0))
    add("linear_expo", "linear", {"temp": 0.0, "tint": 0.0, "exposure": 1.0},
        pipeline._apply_linear_stage(_img(), 0.0, 0.0, 1.0))
    add("linear_tint_cool", "linear", {"temp": -40.0, "tint": 50.0, "exposure": -0.5},
        pipeline._apply_linear_stage(_img(), -40.0, 50.0, -0.5))

    # 2) blancs / noirs
    add("whites_up", "whitesBlacks", {"whites": 60.0, "blacks": 0.0},
        pipeline._apply_whites_blacks(_img(), 60.0, 0.0))
    add("blacks_up", "whitesBlacks", {"whites": 0.0, "blacks": 60.0},
        pipeline._apply_whites_blacks(_img(), 0.0, 60.0))

    # 3) contraste
    add("contrast_pos", "contrast", {"contrast": 60.0},
        pipeline._apply_contrast(_img(), 60.0))
    add("contrast_neg", "contrast", {"contrast": -60.0},
        pipeline._apply_contrast(_img(), -60.0))

    # 4) courbe (maître + canal), entrée clampée comme dans le pipeline
    curve_master = {"points": [[0.0, 0.0], [0.25, 0.15], [0.75, 0.9], [1.0, 1.0]],
                    "r": _ID, "g": _ID, "b": _ID}
    add("curve_master", "curve", {"curve": curve_master},
        pipeline._apply_curve(np.clip(_img(), 0.0, 1.0), curve_master))
    curve_chan = {"points": _ID, "r": [[0.0, 0.0], [0.5, 0.3], [1.0, 1.0]],
                  "g": _ID, "b": _ID}
    add("curve_channel_r", "curve", {"curve": curve_chan},
        pipeline._apply_curve(np.clip(_img(), 0.0, 1.0), curve_chan))

    # 5) couleur : saturation, vibrance, HSL ciblé
    add("color_saturation", "color", {"hsl": _HSL0, "vibrance": 0.0, "saturation": 50.0},
        pipeline._apply_color(_img(), _HSL0, 0.0, 50.0))
    add("color_vibrance", "color", {"hsl": _HSL0, "vibrance": 60.0, "saturation": 0.0},
        pipeline._apply_color(_img(), _HSL0, 60.0, 0.0))
    hsl_red = {**_HSL0, "red": {"h": 0.0, "s": -80.0, "l": 0.0}}
    add("color_hsl_red_desat", "color", {"hsl": hsl_red, "vibrance": 0.0, "saturation": 0.0},
        pipeline._apply_color(_img(), hsl_red, 0.0, 0.0))

    return {"pixels": PIXELS, "cases": cases}


def test_parity_fixture_matches_pipeline(monkeypatch):
    """Le golden commité reflète le pipeline courant (régénérer si ça casse).

    Le golden est l'oracle de parité du GPU : on le calcule sur le chemin NumPy
    **canonique** (rsfast forcé hors-ligne), pour qu'il soit stable que l'accélérateur
    natif soit compilé ou non. rsfast reproduit cette math à ≤ 0.035/255 (sous le 2/255 GPU)."""
    monkeypatch.setattr(pipeline.rsfast, "available", lambda: False)
    fresh = _build_fixture()
    if os.environ.get("RAWSTUDIO_WRITE_FIXTURES"):
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(json.dumps(fresh, indent=2) + "\n", encoding="utf-8")

    assert FIXTURE.exists(), (
        "fixture absente — générer avec RAWSTUDIO_WRITE_FIXTURES=1 pytest tests/test_parity.py")
    committed = json.loads(FIXTURE.read_text(encoding="utf-8"))

    assert committed["pixels"] == fresh["pixels"]
    assert [c["name"] for c in committed["cases"]] == [c["name"] for c in fresh["cases"]]
    for a, b in zip(committed["cases"], fresh["cases"]):
        assert a["stage"] == b["stage"] and a["params"] == b["params"]
        diff = np.abs(np.array(a["output"]) - np.array(b["output"])).max()
        assert diff < 1e-6, (
            f"golden périmé pour {a['name']} (Δ={diff:.2e}) — "
            "régénérer avec RAWSTUDIO_WRITE_FIXTURES=1")
