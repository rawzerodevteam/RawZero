"""Albums (collections) : regroupements de photos transverses aux projets (relation M:N).

Une photo appartient à un seul projet (dossier d'import) mais peut figurer dans plusieurs
albums. Le schéma `albums`/`album_photos` (cascades) est défini dans db.py."""
from datetime import datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import db

router = APIRouter()


@router.get("/albums")
def list_albums():
    rows = db.query(
        """SELECT a.id, a.name, a.created_at, COUNT(ap.photo_id) AS count,
                  (SELECT photo_id FROM album_photos WHERE album_id = a.id
                   ORDER BY rowid DESC LIMIT 1) AS cover
           FROM albums a LEFT JOIN album_photos ap ON ap.album_id = a.id
           GROUP BY a.id ORDER BY a.name COLLATE NOCASE ASC""")
    return {"albums": [dict(r) for r in rows]}


class AlbumIn(BaseModel):
    name: str = "Album"


def _get_album(album_id: int):
    if db.query_one("SELECT id FROM albums WHERE id=?", (album_id,)) is None:
        raise HTTPException(404, "Album introuvable")


@router.post("/albums")
def create_album(body: AlbumIn):
    name = body.name.strip() or "Album"
    if db.query_one("SELECT id FROM albums WHERE name=?", (name,)):
        raise HTTPException(409, "Un album porte déjà ce nom")
    aid = db.execute("INSERT INTO albums (name, created_at) VALUES (?, ?)",
                     (name, datetime.now().isoformat()))
    return {"id": aid, "name": name, "count": 0, "cover": None}


@router.patch("/albums/{album_id}")
def rename_album(album_id: int, body: AlbumIn):
    _get_album(album_id)
    name = body.name.strip() or "Album"
    clash = db.query_one("SELECT id FROM albums WHERE name=? AND id!=?", (name, album_id))
    if clash:
        raise HTTPException(409, "Un album porte déjà ce nom")
    db.execute("UPDATE albums SET name=? WHERE id=?", (name, album_id))
    return {"id": album_id, "name": name}


@router.delete("/albums/{album_id}")
def delete_album(album_id: int):
    _get_album(album_id)
    db.execute("DELETE FROM albums WHERE id=?", (album_id,))  # cascade album_photos
    return {"ok": True}


class AlbumPhotos(BaseModel):
    photo_ids: list[int] = []


@router.post("/albums/{album_id}/photos")
def add_photos(album_id: int, body: AlbumPhotos):
    _get_album(album_id)
    # Nouvelles photos ajoutées à la fin de l'ordre manuel courant (position croissante) ;
    # `OR IGNORE` laisse la position d'une photo déjà présente inchangée.
    start = (db.query_one("SELECT COALESCE(MAX(position), -1) AS m FROM album_photos WHERE album_id=?",
                          (album_id,)) or {"m": -1})["m"] + 1
    db.executemany("INSERT OR IGNORE INTO album_photos (album_id, photo_id, position) VALUES (?, ?, ?)",
                   [(album_id, pid, start + i) for i, pid in enumerate(body.photo_ids)])
    n = (db.query_one("SELECT COUNT(*) AS n FROM album_photos WHERE album_id=?",
                      (album_id,)) or {"n": 0})["n"]
    return {"ok": True, "count": n}


@router.delete("/albums/{album_id}/photos")
def remove_photos(album_id: int, body: AlbumPhotos):
    _get_album(album_id)
    db.executemany("DELETE FROM album_photos WHERE album_id=? AND photo_id=?",
                   [(album_id, pid) for pid in body.photo_ids])
    n = (db.query_one("SELECT COUNT(*) AS n FROM album_photos WHERE album_id=?",
                      (album_id,)) or {"n": 0})["n"]
    return {"ok": True, "count": n}


@router.patch("/albums/{album_id}/reorder")
def reorder_photos(album_id: int, body: AlbumPhotos):
    """Ordre manuel (glisser-déposer dans la grille) : `photo_ids` est l'ordre complet voulu.
    Toute photo de l'album absente de la liste garde sa position actuelle (pas de suppression)."""
    _get_album(album_id)
    db.executemany("UPDATE album_photos SET position=? WHERE album_id=? AND photo_id=?",
                   [(i, album_id, pid) for i, pid in enumerate(body.photo_ids)])
    return {"ok": True}
