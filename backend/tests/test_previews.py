"""Régression : un job de regénération preview parti avec des edits périmés ne doit
jamais écraser sur disque le résultat d'un job plus récent (cf. TODO.md)."""
import numpy as np

from app import previews, segment


def test_stale_refresh_job_does_not_clobber_fresher_write(monkeypatch, tmp_path):
    photo_id = 999001
    written = []

    monkeypatch.setattr(previews, "_save_jpeg_u8", lambda arr, path, quality=86: written.append(path))
    monkeypatch.setattr(previews, "get_base", lambda pid, original: np.zeros((4, 4, 3), np.float32))

    def render_and_supersede(base, edits, size, long_edge, seed=None):
        # Simule un 2e job démarrant (et avançant `_refresh_seq`) pendant que celui-ci rend.
        previews._refresh_seq[photo_id] = previews._refresh_seq.get(photo_id, 0) + 1
        return base
    monkeypatch.setattr(previews.pipeline, "render_array", render_and_supersede)
    monkeypatch.setattr(previews, "full_long_edge", lambda row: 100)

    src = tmp_path / "orig.jpg"
    src.write_bytes(b"x")
    row = {"path": str(src), "width": 100, "height": 100, "edits": "{}"}
    monkeypatch.setattr(previews.db, "query_one", lambda *a, **k: row)

    previews._refresh_previews_job(photo_id)

    assert written == [], "un job périmé n'aurait pas dû écrire après qu'un job plus récent a démarré"
    assert photo_id not in previews._refresh_seq  # purgé : plus aucun job actif pour cette photo


def test_fresh_refresh_job_writes_and_purges_seq(monkeypatch, tmp_path):
    photo_id = 999002
    written = []

    monkeypatch.setattr(previews, "_save_jpeg_u8", lambda arr, path, quality=86: written.append(path))
    monkeypatch.setattr(previews, "get_base", lambda pid, original: np.zeros((4, 4, 3), np.float32))
    monkeypatch.setattr(previews.pipeline, "render_array",
                        lambda base, edits, size, long_edge, seed=None: base)
    monkeypatch.setattr(previews, "full_long_edge", lambda row: 100)

    src = tmp_path / "orig.jpg"
    src.write_bytes(b"x")
    row = {"path": str(src), "width": 100, "height": 100, "edits": "{}"}
    monkeypatch.setattr(previews.db, "query_one", lambda *a, **k: row)

    previews._refresh_previews_job(photo_id)  # aucun job concurrent : écrit normalement

    assert len(written) == 2  # preview + thumb
    assert photo_id not in previews._refresh_seq  # plus aucun job actif : bookkeeping purgé


def test_invalidate_purges_stale_click_mask_embedding(monkeypatch, tmp_path):
    """Après relink (contenu remplacé), l'embedding EdgeSAM en cache (clé par géométrie, pas par
    contenu de fichier) ne doit pas survivre : sinon un clic masque IA suivant réutiliserait
    l'embedding calculé sur l'ANCIEN contenu de l'image (cf. TODO.md)."""
    photo_id = 999003
    other_id = 999004
    segment._emb_cache.clear()
    segment._emb_cache[segment.geo_key(photo_id, {})] = ("dummy-embedding",)
    segment._emb_cache[segment.geo_key(other_id, {})] = ("other-embedding",)

    monkeypatch.setattr(previews.config, "MASKS_DIR", tmp_path)

    previews.invalidate(photo_id)

    assert not any(k.startswith(f"{photo_id}:") for k in segment._emb_cache)
    assert segment.geo_key(other_id, {}) in segment._emb_cache  # autre photo non affectée
