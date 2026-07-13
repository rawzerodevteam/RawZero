"""Catalogue : liste, métadonnées, note/drapeau/label, suppression."""
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import db, previews

router = APIRouter()

SORTS = {
    "captured_desc": "captured_at DESC, id DESC",
    "captured_asc": "captured_at ASC, id ASC",
    "imported_desc": "imported_at DESC, id DESC",
    "rating_desc": "rating DESC, captured_at DESC",
    "name_asc": "filename COLLATE NOCASE ASC",
}

# Colonnes servies au listing : tout SAUF les blobs TEXT `edits`/`history` (volumineux et
# aussitôt jetés par photo_to_dict en mode listing) et hash (retiré de la sortie).
# `path` est inclus : nécessaire pour le badge « fichier introuvable » dans la grille.
# Évite de lire ces blobs pour chaque photo à chaque changement de filtre/tri.
LIST_COLS = ("id", "filename", "path", "ext", "is_raw", "width", "height", "captured_at",
             "imported_at", "camera", "lens", "iso", "aperture", "shutter", "focal",
             "rating", "flag", "color", "edited", "project_id")


@router.get("/photos")
def list_photos(min_rating: int = 0, flag: str = "", color: str = "",
                sort: str = "captured_asc", project_id: int = 0, album_id: int = 0,
                camera: str = "", lens: str = "", iso_min: int = 0, iso_max: int = 0,
                date_from: str = "", date_to: str = ""):
    # Un album est transverse aux projets : s'il est demandé, il prime sur project_id.
    if album_id:
        cols = ", ".join("photos." + c for c in LIST_COLS)
        sql = (f"SELECT {cols} FROM photos "
               "JOIN album_photos ON album_photos.photo_id = photos.id "
               "WHERE album_photos.album_id = ? AND photos.rating >= ?")
        params: list = [album_id, min_rating]
    else:
        sql = f"SELECT {', '.join(LIST_COLS)} FROM photos WHERE rating >= ?"
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


def require_original(row) -> Path:
    """Chemin de l'original, garanti présent sur disque (409 sinon).

    L'import référence le fichier à son emplacement d'origine (pas de copie) : il peut
    avoir été déplacé/supprimé hors de RawZero depuis l'import."""
    path = Path(row["path"])
    if not path.is_file():
        raise HTTPException(409, f"Fichier original introuvable : {path}")
    return path


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
    sets: list[str] = []
    params: list = []
    if patch.rating is not None:
        sets.append("rating=?")
        params.append(max(0, min(5, patch.rating)))
    if patch.flag is not None:
        if patch.flag not in ("none", "pick", "reject"):
            raise HTTPException(422, "flag invalide")
        sets.append("flag=?")
        params.append(patch.flag)
    if patch.color is not None:
        if patch.color not in ("", "red", "yellow", "green", "blue", "purple"):
            raise HTTPException(422, "couleur invalide")
        sets.append("color=?")
        params.append(patch.color)
    if sets:                                  # un seul UPDATE même quand plusieurs champs changent
        params.append(photo_id)
        db.execute(f"UPDATE photos SET {', '.join(sets)} WHERE id=?", tuple(params))
    return db.photo_to_dict(get_photo_row(photo_id))


@router.delete("/photos/{photo_id}")
def delete_photo(photo_id: int, delete_file: bool = False):
    row = get_photo_row(photo_id)
    previews.invalidate(photo_id)
    if delete_file:
        Path(row["path"]).unlink(missing_ok=True)
    db.execute("DELETE FROM photos WHERE id=?", (photo_id,))
    return {"ok": True}
