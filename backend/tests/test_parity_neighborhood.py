"""Régression visuelle GPU↔Python (#9 / TODO N12) — opérations À VOISINAGE (flou gaussien) :
HL/ombres, clarté, netteté, défrange, réduction de bruit chroma.

Complète ``test_parity.py`` (qui ne couvre que les étages *per-pixel* sans flou). Le port JS
correspondant (``frontend/src/gpu/cpuNeighborhood.ts``) mirrore le flou du GPU
(``GpuPipeline.blur()`` : downscale bilinéaire par un facteur FIXE par site d'appel, borne CLAMP,
poids ``gaussianWeights`` réutilisés tels quels) — DIFFÉRENT de ``pipeline.gauss()`` (downscale
par un facteur ``k`` dérivé du sigma, borne REFLECT). Ce ne sont pas deux implémentations du même
algorithme mais deux approximations indépendantes du même flou plein ; ce test mesure l'écart
entre les deux, il ne vise pas l'égalité stricte (cf. commentaire de ``pipeline.gauss``).

Deux volets, comme ``cpuNeighborhood.ts`` :
  1) ``blur`` — le primitif de flou seul (``pipeline.gauss`` vs le port JS de
     ``GpuPipeline.blur()``), à des sigmas EXPLICITEMENT représentatifs de la production (2 à 60 px,
     cf. `_apply_hl_shadows`/`_apply_clarity` sur un preview ~2560 px), sur un plan luma synthétique
     256×256 — assez grand pour ne pas être dominé par les effets de bord.
  2) les 5 opérations couvertes (HL/ombres, clarté, netteté, défrange, NR chroma) bout en bout,
     avec ``ref_long_edge=2560`` forcé (magnitude production) même si l'image de test est petite
     (96×96) — le résultat sature/s'aplatit fortement (rayon de flou >> image), ce qui est
     attendu et reste un signal valide : les deux implémentations doivent converger vers le même
     aplatissement.

Fixture compacte : les résultats (plans/images potentiellement grands) sont réduits par moyenne de
blocs (``_block_avg``) avant sérialisation — même réduction recalculée côté JS sur son propre
résultat avant comparaison, donc pas de perte d'information pertinente pour le test.
"""
import json
import os
from pathlib import Path

import numpy as np

from app import pipeline

FIXTURE = (Path(__file__).resolve().parents[2]
           / "frontend" / "tests" / "fixtures" / "parityNeighborhood.json")


def _synth_plane(w: int, h: int, phase: float = 0.0) -> np.ndarray:
    """Champ synthétique déterministe (gradients + disque net) — formule MIROIR exacte de
    `synthPlane` dans `frontend/tests/parityNeighborhood.test.ts` (aucune donnée sérialisée pour
    l'entrée : les deux côtés la recalculent indépendamment depuis la même formule)."""
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    nx, ny = x / w, y / h
    val = 0.5 + 0.35 * np.sin(nx * 23.0 + phase) * np.cos(ny * 17.0 + phase * 0.5)
    dist = np.sqrt((nx - 0.5) ** 2 + (ny - 0.5) ** 2)
    val = val + 0.2 * (dist < 0.15).astype(np.float32)
    return np.clip(val, 0.0, 1.0).astype(np.float32)


def _synth_image(w: int, h: int) -> np.ndarray:
    r, g, b = _synth_plane(w, h, 0.0), _synth_plane(w, h, 2.1), _synth_plane(w, h, 4.2)
    return np.stack([r, g, b], axis=-1)


def _block_avg(arr: np.ndarray, n: int) -> np.ndarray:
    """Réduit `arr` (h,w[,c]) à une grille n×n par moyenne de blocs — h et w doivent être
    multiples de n (vrai pour les tailles choisies ci-dessous)."""
    h, w = arr.shape[:2]
    bh, bw = h // n, w // n
    if arr.ndim == 2:
        return arr.reshape(n, bh, n, bw).mean(axis=(1, 3))
    c = arr.shape[2]
    return arr.reshape(n, bh, n, bw, c).mean(axis=(1, 3))


PLANE_SIZE = 256
PLANE_DOWN = 32
IMG_SIZE = 96
IMG_DOWN = 12


def _build_fixture() -> dict:
    cases: list[dict] = []

    # 1) le primitif de flou seul, à des sigmas représentatifs de la production.
    plane = _synth_plane(PLANE_SIZE, PLANE_SIZE)
    for sigma in (2.0, 10.0, 25.0, 60.0):
        blurred = pipeline.gauss(plane, sigma)
        cases.append({
            "kind": "blur", "name": f"blur_sigma{sigma}", "sigma": sigma,
            "size": PLANE_SIZE, "down": PLANE_DOWN,
            "output": np.round(_block_avg(blurred, PLANE_DOWN), 6).tolist(),
        })

    # 2) opérations bout en bout, magnitude de sigma production (ref_long_edge=2560) sur une
    #    petite image de test (le flou sature — signal valide, cf. docstring du module).
    img = _synth_image(IMG_SIZE, IMG_SIZE)
    REF = 2560

    out = pipeline._apply_hl_shadows(img, 60.0, 0.0, ref_long_edge=REF)
    cases.append({"kind": "hlShadows", "name": "hl_highlights", "params": {"highlights": 60.0, "shadows": 0.0, "ref_long_edge": REF},
                  "size": IMG_SIZE, "down": IMG_DOWN, "output": np.round(_block_avg(out, IMG_DOWN), 6).tolist()})
    out = pipeline._apply_hl_shadows(img, 0.0, 60.0, ref_long_edge=REF)
    cases.append({"kind": "hlShadows", "name": "hl_shadows", "params": {"highlights": 0.0, "shadows": 60.0, "ref_long_edge": REF},
                  "size": IMG_SIZE, "down": IMG_DOWN, "output": np.round(_block_avg(out, IMG_DOWN), 6).tolist()})

    out = pipeline._apply_clarity(img, 70.0, 1.0, ref_long_edge=REF)
    cases.append({"kind": "clarity", "name": "clarity_pos", "params": {"clarity": 70.0, "ref_long_edge": REF},
                  "size": IMG_SIZE, "down": IMG_DOWN, "output": np.round(_block_avg(out, IMG_DOWN), 6).tolist()})

    out = pipeline._apply_sharpen(img, 80.0, 1.0, 1.0)
    cases.append({"kind": "sharpen", "name": "sharpen", "params": {"amount": 80.0, "radius": 1.0, "scale": 1.0},
                  "size": IMG_SIZE, "down": IMG_DOWN, "output": np.round(_block_avg(out, IMG_DOWN), 6).tolist()})

    out = pipeline._apply_defringe(img, 80.0, 80.0, 1.0)
    cases.append({"kind": "defringe", "name": "defringe", "params": {"purple": 80.0, "green": 80.0, "scale": 1.0},
                  "size": IMG_SIZE, "down": IMG_DOWN, "output": np.round(_block_avg(out, IMG_DOWN), 6).tolist()})

    out = pipeline._apply_nr(img, 0.0, 70.0, 1.0)
    cases.append({"kind": "nrChroma", "name": "nr_chroma", "params": {"nr_color": 70.0, "scale": 1.0},
                  "size": IMG_SIZE, "down": IMG_DOWN, "output": np.round(_block_avg(out, IMG_DOWN), 6).tolist()})

    return {"cases": cases}


def test_parity_neighborhood_fixture_matches_pipeline(monkeypatch):
    """Le golden commité reflète le pipeline courant (régénérer si ça casse) — même protocole que
    `test_parity.py` (rsfast forcé hors-ligne, oracle = chemin NumPy canonique)."""
    monkeypatch.setattr(pipeline.rsfast, "available", lambda: False)
    fresh = _build_fixture()
    if os.environ.get("RAWZERO_WRITE_FIXTURES"):
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(json.dumps(fresh, indent=2) + "\n", encoding="utf-8")

    assert FIXTURE.exists(), (
        "fixture absente — générer avec RAWZERO_WRITE_FIXTURES=1 pytest tests/test_parity_neighborhood.py")
    committed = json.loads(FIXTURE.read_text(encoding="utf-8"))

    assert [c["name"] for c in committed["cases"]] == [c["name"] for c in fresh["cases"]]
    for a, b in zip(committed["cases"], fresh["cases"]):
        assert a["kind"] == b["kind"]
        diff = np.abs(np.array(a["output"]) - np.array(b["output"])).max()
        assert diff < 1e-5, (
            f"golden périmé pour {a['name']} (Δ={diff:.2e}) — "
            "régénérer avec RAWZERO_WRITE_FIXTURES=1")
