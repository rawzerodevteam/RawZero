"""Régression : un job de regénération preview parti avec des edits périmés ne doit
jamais écraser sur disque le résultat d'un job plus récent (cf. TODO.md)."""
import numpy as np

from app import previews, segment


def test_stale_refresh_job_does_not_clobber_fresher_write(monkeypatch, tmp_path):
    photo_id = 999001
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

    # Simule : un job plus récent (seq 2) a déjà écrit sur disque avant que ce job-ci
    # (seq 1, parti avec des edits plus anciens mais fini en dernier) ne termine son rendu.
    previews._refresh_seq[photo_id] = 0
    previews._refresh_written[photo_id] = 2

    previews._refresh_previews_job(photo_id)  # assigne seq=1 en interne

    assert written == [], "un job périmé (seq 1) n'aurait pas dû écrire après un job plus récent (seq 2)"
    assert previews._refresh_written[photo_id] == 2  # inchangé


def test_fresh_refresh_job_writes_and_bumps_written_seq(monkeypatch, tmp_path):
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

    previews._refresh_seq[photo_id] = 0
    previews._refresh_written[photo_id] = 0

    previews._refresh_previews_job(photo_id)  # assigne seq=1, aucun job plus récent connu

    assert len(written) == 2  # preview + thumb
    assert previews._refresh_written[photo_id] == 1


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
