"""B4 / D3 — régression d'orientation sur de VRAIS RAW (opt-in).

Le mode tri affiche le JPEG embarqué (orienté via le tag EXIF) ; après la 1ʳᵉ édition la
preview vient de la base décodée par LibRaw (qui auto-oriente). Si ces deux chemins divergent
pour un boîtier, la vignette « bascule » à la première retouche (B4).

Ce test compare les deux chemins sur un échantillon de RAW réels. Il est **ignoré** par défaut
(le catalogue de test est vide) ; pour l'activer, pointer un dossier de RAW :

    RAWZERO_REAL_RAW_DIR=/chemin/vers/originals  pytest backend/tests/test_raw_orientation.py

Aucun fichier RAW n'est committé (trop volumineux, data/ gitignoré) — cf. D3.
"""
import os
from pathlib import Path

import numpy as np
import pytest

from app import config, raw_loader

_MAX = 15  # borne le coût (chaque RAW = un décodage demi-résolution)


def _sample_raws() -> list[Path]:
    root = Path(os.environ.get("RAWZERO_REAL_RAW_DIR") or config.ORIGINALS_DIR)
    if not root.exists():
        return []
    found: list[Path] = []
    for p in sorted(root.rglob("*")):
        if p.suffix.lower() in config.RAW_EXTS:
            found.append(p)
    # Échantillon réparti (début/milieu/fin) pour varier les orientations.
    if len(found) <= _MAX:
        return found
    step = len(found) / _MAX
    return [found[int(i * step)] for i in range(_MAX)]


_RAWS = _sample_raws()


@pytest.mark.skipif(not _RAWS, reason="aucun RAW réel (définir RAWZERO_REAL_RAW_DIR)")
@pytest.mark.parametrize("path", _RAWS, ids=lambda p: p.name)
def test_embedded_and_decoded_orientation_agree(path: Path):
    """Le JPEG embarqué orienté et la base LibRaw doivent avoir la même orientation
    (paysage ↔ portrait) ET le même contenu (pas de 180°/miroir caché)."""
    emb = raw_loader.extract_embedded_jpeg(path)
    if emb is None:
        pytest.skip(f"{path.name} : pas de JPEG embarqué")
    base = raw_loader.decode_full(path, half_size=True)

    # 1) Orientation grossière (rotations 90°) via le ratio.
    emb_landscape = emb.width >= emb.height
    base_landscape = base.shape[1] >= base.shape[0]
    assert emb_landscape == base_landscape, (
        f"{path.name}: embarqué {emb.width}x{emb.height} vs base "
        f"{base.shape[1]}x{base.shape[0]} — orientation 90° divergente")

    # 2) Contenu : la base doit ressembler au JPEG embarqué tel quel, pas à sa
    #    version tournée de 180° (sinon divergence invisible au ratio).
    import cv2

    def g48(arr: np.ndarray) -> np.ndarray:
        gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
        gray = cv2.resize(gray.astype(np.float32), (48, 48), interpolation=cv2.INTER_AREA)
        return (gray - gray.mean()) / (gray.std() + 1e-6)

    a = g48(np.asarray(emb.convert("RGB")))
    b = g48((np.clip(base, 0, 1) * 255).astype(np.uint8))
    d_align = float(np.mean(np.abs(a - b)))
    d_180 = float(np.mean(np.abs(a - np.rot90(b, 2))))
    assert d_align < d_180, (
        f"{path.name}: contenu mieux aligné après rotation 180° "
        f"(align={d_align:.3f} >= 180={d_180:.3f}) — orientation divergente")
