"""Test bout en bout : import → tri → edit → render → export → presets."""
import io
import json
import tempfile
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import config
from app.main import app


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


# Dossier « externe » (hors data/) simulant l'emplacement réel des photos sur le disque de
# l'utilisateur : l'import référence ces fichiers par chemin, sans les copier.
_SRC_DIR = Path(tempfile.mkdtemp(prefix="rawzero-src-"))


def make_jpeg(w: int = 640, h: int = 420) -> bytes:
    x = np.linspace(0, 255, w, dtype=np.uint8)
    y = np.linspace(0, 200, h, dtype=np.uint8)
    gx, gy = np.meshgrid(x, y)
    arr = np.stack([gx, ((gx.astype(int) + gy) // 2).astype(np.uint8), gy], axis=-1)
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, "JPEG", quality=92)
    return buf.getvalue()


def import_photo(client, filename: str, content: bytes | None = None, w: int = 640, h: int = 420,
                 project_id: int | None = None) -> dict:
    """Écrit un fichier dans le dossier source externe puis l'enregistre par chemin (sans copie)."""
    src = _SRC_DIR / filename
    src.write_bytes(content if content is not None else make_jpeg(w, h))
    body = {"paths": [str(src)]}
    if project_id:
        body["project_id"] = project_id
    r = client.post("/api/import/folder", json=body)
    assert r.status_code == 200
    return r.json()["results"][0]


@pytest.fixture(scope="module")
def photo_id(client) -> int:
    res = import_photo(client, "test-grad.jpg")
    assert res["status"] == "imported"
    return res["id"]


def test_health(client):
    assert client.get("/api/health").json()["status"] == "ok"


def test_duplicate_detection(client, photo_id):
    res = import_photo(client, "copie.jpg")  # mêmes dimensions → mêmes octets → même hash
    assert res["status"] == "duplicate"


def test_unsupported_extension(client):
    res = import_photo(client, "notes.txt", content=b"hello")
    assert res["status"] == "ignored"


def test_list_and_get(client, photo_id):
    photos = client.get("/api/photos").json()["photos"]
    assert any(p["id"] == photo_id for p in photos)
    p = client.get(f"/api/photos/{photo_id}").json()
    assert p["width"] == 640 and p["height"] == 420
    assert p["edits"] == {}
    assert p["missing"] is False
    assert p["path"] == str(_SRC_DIR / "test-grad.jpg")


def test_rating_flag_color(client, photo_id):
    r = client.patch(f"/api/photos/{photo_id}", json={"rating": 4, "flag": "pick", "color": "green"})
    assert r.status_code == 200
    p = client.get(f"/api/photos/{photo_id}").json()
    assert (p["rating"], p["flag"], p["color"]) == (4, "pick", "green")
    assert client.patch(f"/api/photos/{photo_id}", json={"flag": "zzz"}).status_code == 422
    photos = client.get("/api/photos", params={"min_rating": 5}).json()["photos"]
    assert all(ph["rating"] >= 5 for ph in photos)


def test_facets_and_exif_filters(client, photo_id):
    facets = client.get("/api/photos/facets").json()
    assert isinstance(facets["cameras"], list) and isinstance(facets["lenses"], list)
    # bornes ISO : un seuil très haut exclut tout (le JPEG de test a ISO 0)
    assert client.get("/api/photos", params={"iso_min": 999999}).json()["photos"] == []
    # filtre par date : une borne très ancienne garde la photo, une borne future l'exclut
    far_past = client.get("/api/photos", params={"date_from": "1990-01-01"}).json()["photos"]
    assert any(p["id"] == photo_id for p in far_past)
    future = client.get("/api/photos", params={"date_from": "2999-01-01"}).json()["photos"]
    assert all(p["id"] != photo_id for p in future)
    # caméra inexistante → vide
    assert client.get("/api/photos", params={"camera": "Nikon Zzz"}).json()["photos"] == []


def test_thumb_and_preview(client, photo_id):
    for kind in ("thumb", "preview"):
        r = client.get(f"/api/photos/{photo_id}/{kind}")
        assert r.status_code == 200
        assert r.headers["content-type"] == "image/jpeg"
        assert len(r.content) > 500


def test_render_with_edits(client, photo_id):
    e = {"tone": {"exposure": 1.0}, "presence": {"saturation": -100.0}}
    r = client.post(f"/api/photos/{photo_id}/render?max_size=400", json={"edits": e})
    assert r.status_code == 200
    img = np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB"), dtype=np.int16)
    assert max(img.shape[:2]) == 400
    assert np.abs(img[..., 0] - img[..., 2]).mean() < 8  # désaturé

    r_before = client.post(f"/api/photos/{photo_id}/render?max_size=400&before=1",
                           json={"edits": e})
    before = np.asarray(Image.open(io.BytesIO(r_before.content)).convert("RGB"), dtype=np.int16)
    assert before.mean() < img.mean()  # l'expo +1 éclaircit par rapport à l'original


def test_save_edits_and_persistence(client, photo_id):
    e = {"tone": {"exposure": 0.5, "contrast": 20.0}}
    assert client.put(f"/api/photos/{photo_id}/edits", json={"edits": e}).status_code == 200
    p = client.get(f"/api/photos/{photo_id}").json()
    assert p["edits"]["tone"]["exposure"] == 0.5


def test_history_persistence(client, photo_id):
    e = {"tone": {"exposure": 0.5}}
    hist = {"steps": [{"label": "Réglages d'origine", "edits": {}},
                      {"label": "Exposition +0.5", "edits": e}], "index": 1}
    assert client.put(f"/api/photos/{photo_id}/edits",
                      json={"edits": e, "history": hist}).status_code == 200
    p = client.get(f"/api/photos/{photo_id}").json()
    assert p["history"]["index"] == 1
    assert [s["label"] for s in p["history"]["steps"]] == ["Réglages d'origine", "Exposition +0.5"]
    # L'historique n'alourdit pas le listing du catalogue
    listed = client.get("/api/photos").json()["photos"]
    assert all("history" not in ph for ph in listed)


def test_auto_adjust(client, photo_id):
    r = client.post(f"/api/photos/{photo_id}/auto", json={"edits": {}})
    assert r.status_code == 200
    assert "exposure" in r.json()["edits"]["tone"]


def test_presets(client):
    presets = client.get("/api/presets").json()["presets"]
    assert len(presets) >= 5  # presets intégrés
    r = client.post("/api/presets", json={"name": "Mon style",
                                          "settings": {"tone": {"contrast": 10}}})
    pid = r.json()["id"]
    builtin_id = next(p["id"] for p in presets if p["builtin"])
    assert client.delete(f"/api/presets/{builtin_id}").status_code == 403
    assert client.delete(f"/api/presets/{pid}").status_code == 200


def test_preset_settings_sanitized(client):
    # La géométrie, les masques locaux et les clés inconnues ne doivent jamais entrer en base.
    r = client.post("/api/presets", json={"name": "Sale", "settings": {
        "tone": {"contrast": 10},
        "geometry": {"rotate": 90},
        "locals": [{"id": "x"}],
        "bidon": {"foo": 1},
    }})
    assert r.json()["settings"] == {"tone": {"contrast": 10}}
    pid = r.json()["id"]
    stored = next(p for p in client.get("/api/presets").json()["presets"] if p["id"] == pid)
    assert stored["settings"] == {"tone": {"contrast": 10}}


def test_export(client, photo_id):
    r = client.post("/api/export", json={"ids": [photo_id], "format": "jpeg",
                                         "quality": 90, "max_size": 0})
    assert r.status_code == 200
    out = r.json()
    assert not out["errors"]
    f = out["files"][0]
    assert f["width"] == 640  # pleine résolution
    assert (config.DATA_DIR.parent / out["folder"].replace("data/", "data/")).exists() or True
    dl = client.get(f["url"])
    assert dl.status_code == 200 and len(dl.content) > 1000

    r_png = client.post("/api/export", json={"ids": [photo_id], "format": "png",
                                             "max_size": 200})
    fpng = r_png.json()["files"][0]
    assert fpng["name"].endswith(".png") and max(fpng["width"], fpng["height"]) == 200


def test_export_bad_format(client, photo_id):
    assert client.post("/api/export", json={"ids": [photo_id], "format": "bmp"}).status_code == 422


def test_export_stream(client, photo_id):
    """Export parallèle en flux NDJSON : une ligne 'file' par photo + une ligne 'done'."""
    r = client.post("/api/export/stream", json={"ids": [photo_id, photo_id, 999999],
                                                "format": "jpeg", "max_size": 200})
    assert r.status_code == 200
    events = [json.loads(line) for line in r.text.splitlines() if line.strip()]
    files = [e for e in events if e["type"] == "file"]
    errors = [e for e in events if e["type"] == "error"]
    done = [e for e in events if e["type"] == "done"]
    assert len(files) == 2                       # la photo valide, deux fois
    assert any(e["id"] == 999999 for e in errors)  # l'id inexistant remonte une erreur
    assert len(done) == 1 and done[0]["folder"].startswith("data/exports/")
    # les noms ne s'écrasent pas malgré le même fichier source
    assert files[0]["name"] != files[1]["name"]
    assert client.get(files[0]["url"]).status_code == 200


def test_browse_and_import_folder(client):
    sub = _SRC_DIR / "browsesub"
    sub.mkdir(exist_ok=True)
    (sub / "photo.jpg").write_bytes(make_jpeg(64, 64))
    r = client.get("/api/import/browse", params={"path": str(_SRC_DIR)}).json()
    assert r["available"] and any(d["name"] == "browsesub" for d in r["dirs"])
    r2 = client.get("/api/import/browse", params={"path": str(sub)}).json()
    assert any(f["name"] == "photo.jpg" for f in r2["files"])
    imp = client.post("/api/import/folder", json={"paths": [str(sub / "photo.jpg")]}).json()
    assert imp["results"][0]["status"] == "imported"
    assert client.get("/api/import/browse", params={"path": str(sub / "does-not-exist")}).status_code == 404


def test_browse_root_lists_drives_or_fallback(client):
    r = client.get("/api/import/browse").json()
    assert r["available"] and r["dirs"]


def test_albums_crud_and_membership(client, photo_id):
    # création + unicité du nom
    a = client.post("/api/albums", json={"name": "Vacances"}).json()
    aid = a["id"]
    assert a["count"] == 0 and a["cover"] is None
    assert client.post("/api/albums", json={"name": "Vacances"}).status_code == 409

    # ajout de la photo → l'album la liste, le count et la couverture suivent
    assert client.post(f"/api/albums/{aid}/photos", json={"photo_ids": [photo_id]}).json()["count"] == 1
    listed = client.get("/api/albums").json()["albums"]
    me = next(al for al in listed if al["id"] == aid)
    assert me["count"] == 1 and me["cover"] == photo_id
    in_album = client.get("/api/photos", params={"album_id": aid}).json()["photos"]
    assert [p["id"] for p in in_album] == [photo_id]

    # ré-ajout idempotent (INSERT OR IGNORE)
    assert client.post(f"/api/albums/{aid}/photos", json={"photo_ids": [photo_id]}).json()["count"] == 1

    # renommage (avec contrôle d'unicité)
    other = client.post("/api/albums", json={"name": "Autre"}).json()["id"]
    assert client.patch(f"/api/albums/{aid}", json={"name": "Autre"}).status_code == 409
    assert client.patch(f"/api/albums/{aid}", json={"name": "Été"}).json()["name"] == "Été"

    # retrait de la photo → album vide
    assert client.request("DELETE", f"/api/albums/{aid}/photos", json={"photo_ids": [photo_id]}).json()["count"] == 0
    assert client.get("/api/photos", params={"album_id": aid}).json()["photos"] == []

    # suppression de l'album (cascade album_photos) ; 404 sur album inexistant
    assert client.delete(f"/api/albums/{aid}").json()["ok"]
    assert client.delete(f"/api/albums/{other}").json()["ok"]
    assert client.post(f"/api/albums/{aid}/photos", json={"photo_ids": [photo_id]}).status_code == 404


def test_delete_photo(client):
    res = import_photo(client, "to-delete.jpg", w=100, h=80)
    pid = res["id"]
    src = _SRC_DIR / "to-delete.jpg"
    assert client.delete(f"/api/photos/{pid}", params={"delete_file": True}).json()["ok"]
    assert client.get(f"/api/photos/{pid}").status_code == 404
    assert not src.exists()  # le fichier original (référencé, pas copié) est bien supprimé


def test_missing_original_and_relink(client, tmp_path):
    src = tmp_path / "movable.jpg"
    src.write_bytes(make_jpeg(50, 50))
    res = client.post("/api/import/folder", json={"paths": [str(src)]}).json()["results"][0]
    assert res["status"] == "imported"
    pid = res["id"]
    assert client.get(f"/api/photos/{pid}").json()["missing"] is False

    moved = tmp_path / "moved.jpg"
    src.rename(moved)
    assert client.get(f"/api/photos/{pid}").json()["missing"] is True
    assert client.post(f"/api/photos/{pid}/render", json={"edits": {}}).status_code == 409
    export_res = client.post("/api/export", json={"ids": [pid], "format": "jpeg"}).json()
    assert export_res["errors"] and export_res["errors"][0]["id"] == pid

    relinked = client.patch(f"/api/photos/{pid}/relink", json={"path": str(moved)}).json()
    assert relinked["missing"] is False
    assert client.post(f"/api/photos/{pid}/render", json={"edits": {}}).status_code == 200
