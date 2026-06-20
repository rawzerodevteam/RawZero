"""Catalogue : liste, métadonnées, note/drapeau/label, suppression."""
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config, db, previews

router = APIRouter()

SORTS = {
    "captured_desc": "captured_at DESC, id DESC",
    "captured_asc": "captured_at ASC, id ASC",
    "imported_desc": "imported_at DESC, id DESC",
    "rating_desc": "rating DESC, captured_at DESC",
    "name_asc": "filename COLLATE NOCASE ASC",
}


@router.get("/photos")
def list_photos(min_rating: int = 0, flag: str = "", color: str = "",
                sort: str = "captured_asc", project_id: int = 0, album_id: int = 0,
                camera: str = "", lens: str = "", iso_min: int = 0, iso_max: int = 0,
                date_from: str = "", date_to: str = ""):
    # Un album est transverse aux projets : s'il est demandé, il prime sur project_id.
    if album_id:
        sql = ("SELECT photos.* FROM photos "
               "JOIN album_photos ON album_photos.photo_id = photos.id "
               "WHERE album_photos.album_id = ? AND photos.rating >= ?")
        params: list = [album_id, min_rating]
    else:
        sql = "SELECT * FROM photos WHERE rating >= ?"
        params = [min_rating]
        if project_id:
            sql += " AND project_id = ?"
            params.append(project_id)
    if flag:
        sql += " AND flag = ?"
        params.append(flag)
    if color:
        sql += " AND color = ?"
        params.append(color)
    if camera:
        sql += " AND camera = ?"
        params.append(camera)
    if lens:
        sql += " AND lens = ?"
        params.append(lens)
    if iso_min > 0:
        sql += " AND iso >= ?"
        params.append(iso_min)
    if iso_max > 0:
        sql += " AND iso <= ?"
        params.append(iso_max)
    if date_from:
        sql += " AND captured_at >= ?"
        params.append(date_from)
    if date_to:
        sql += " AND captured_at <= ?"
        params.append(date_to + "T23:59:59")   # captured_at en ISO → borne inclusive du jour
    sql += f" ORDER BY {SORTS.get(sort, SORTS['captured_asc'])}"
    rows = db.query(sql, tuple(params))
    return {"photos": [db.photo_to_dict(r) for r in rows]}


@router.get("/photos/facets")
def photo_facets(project_id: int = 0, album_id: int = 0):
    """Valeurs distinctes (caméra, objectif) pour peupler les filtres, restreintes au
    contexte courant (album si fourni, sinon projet, sinon tout le catalogue)."""
    if album_id:
        src = ("photos JOIN album_photos ON album_photos.photo_id = photos.id "
               "WHERE album_photos.album_id = ?")
        args: tuple = (album_id,)
    elif project_id:
        src, args = "photos WHERE project_id = ?", (project_id,)
    else:
        src, args = "photos WHERE 1=1", ()

    def distinct(col: str) -> list[str]:
        rows = db.query(f"SELECT DISTINCT photos.{col} AS v FROM {src} AND photos.{col} != ''", args)
        return sorted((r["v"] for r in rows), key=str.lower)

    return {"cameras": distinct("camera"), "lenses": distinct("lens")}


def get_photo_row(photo_id: int):
    row = db.query_one("SELECT * FROM photos WHERE id=?", (photo_id,))
    if row is None:
        raise HTTPException(404, "Photo introuvable")
    return row


@router.get("/photos/{photo_id}")
def get_photo(photo_id: int):
    return db.photo_to_dict(get_photo_row(photo_id), with_edits=True)


class PhotoPatch(BaseModel):
    rating: Optional[int] = None
    flag: Optional[str] = None
    color: Optional[str] = None


@router.patch("/photos/{photo_id}")
def patch_photo(photo_id: int, patch: PhotoPatch):
    get_photo_row(photo_id)
    if patch.rating is not None:
        db.execute("UPDATE photos SET rating=? WHERE id=?",
                   (max(0, min(5, patch.rating)), photo_id))
    if patch.flag is not None:
        if patch.flag not in ("none", "pick", "reject"):
            raise HTTPException(422, "flag invalide")
        db.execute("UPDATE photos SET flag=? WHERE id=?", (patch.flag, photo_id))
    if patch.color is not None:
        if patch.color not in ("", "red", "yellow", "green", "blue", "purple"):
            raise HTTPException(422, "couleur invalide")
        db.execute("UPDATE photos SET color=? WHERE id=?", (patch.color, photo_id))
    return db.photo_to_dict(get_photo_row(photo_id))


@router.delete("/photos/{photo_id}")
def delete_photo(photo_id: int, delete_file: bool = False):
    row = get_photo_row(photo_id)
    previews.invalidate(photo_id)
    if delete_file:
        (config.ORIGINALS_DIR / row["relpath"]).unlink(missing_ok=True)
    db.execute("DELETE FROM photos WHERE id=?", (photo_id,))
    return {"ok": True}
