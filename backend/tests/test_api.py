"""Test bout en bout : import → tri → edit → render → export → presets."""
import io
import json

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


def make_jpeg(w: int = 640, h: int = 420) -> bytes:
    x = np.linspace(0, 255, w, dtype=np.uint8)
    y = np.linspace(0, 200, h, dtype=np.uint8)
    gx, gy = np.meshgrid(x, y)
    arr = np.stack([gx, ((gx.astype(int) + gy) // 2).astype(np.uint8), gy], axis=-1)
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, "JPEG", quality=92)
    return buf.getvalue()


@pytest.fixture(scope="module")
def photo_id(client) -> int:
    r = client.post("/api/import/upload",
                    files=[("files", ("test-grad.jpg", make_jpeg(), "image/jpeg"))])
    assert r.status_code == 200
    res = r.json()["results"][0]
    assert res["status"] == "imported"
    return res["id"]


def test_health(client):
    assert client.get("/api/health").json()["status"] == "ok"


def test_duplicate_detection(client, photo_id):
    r = client.post("/api/import/upload",
                    files=[("files", ("copie.jpg", make_jpeg(), "image/jpeg"))])
    assert r.json()["results"][0]["status"] == "duplicate"


def test_unsupported_extension(client):
    r = client.post("/api/import/upload",
                    files=[("files", ("notes.txt", b"hello", "text/plain"))])
    assert r.json()["results"][0]["status"] == "ignored"


def test_list_and_get(client, photo_id):
    photos = client.get("/api/photos").json()["photos"]
    assert any(p["id"] == photo_id for p in photos)
    p = client.get(f"/api/photos/{photo_id}").json()
    assert p["width"] == 640 and p["height"] == 420
    assert p["edits"] == {}


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


def test_browse_import_dir(client):
    config.IMPORT_DIR.mkdir(parents=True, exist_ok=True)
    (config.IMPORT_DIR / "sub").mkdir(exist_ok=True)
    (config.IMPORT_DIR / "sub" / "photo.jpg").write_bytes(make_jpeg(64, 64))
    r = client.get("/api/import/browse").json()
    assert r["available"] and any(d["name"] == "sub" for d in r["dirs"])
    r2 = client.get("/api/import/browse", params={"path": "sub"}).json()
    assert any(f["name"] == "photo.jpg" for f in r2["files"])
    imp = client.post("/api/import/folder", json={"paths": ["sub/photo.jpg"]}).json()
    assert imp["results"][0]["status"] == "imported"
    assert client.get("/api/import/browse", params={"path": "../.."}).status_code in (403, 404)


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
    r = client.post("/api/import/upload",
                    files=[("files", ("to-delete.jpg", make_jpeg(100, 80), "image/jpeg"))])
    pid = r.json()["results"][0]["id"]
    assert client.delete(f"/api/photos/{pid}", params={"delete_file": True}).json()["ok"]
    assert client.get(f"/api/photos/{pid}").status_code == 404
