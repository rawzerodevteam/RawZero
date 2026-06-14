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
                sort: str = "captured_asc", project_id: int = 0):
    sql = "SELECT * FROM photos WHERE rating >= ?"
    params: list = [min_rating]
    if project_id:
        sql += " AND project_id = ?"
        params.append(project_id)
    if flag:
        sql += " AND flag = ?"
        params.append(flag)
    if color:
        sql += " AND color = ?"
        params.append(color)
    sql += f" ORDER BY {SORTS.get(sort, SORTS['captured_asc'])}"
    rows = db.query(sql, tuple(params))
    return {"photos": [db.photo_to_dict(r) for r in rows]}


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
