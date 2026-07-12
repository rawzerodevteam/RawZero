"""Import par référence de chemin (style Lightroom « Add ») : pas de copie disque.

Le fichier reste à son emplacement d'origine ; on enregistre son chemin absolu, on le
hache pour la déduplication et on génère thumb/preview. Voir aussi `PATCH /photos/{id}/relink`
pour relier une photo à un nouvel emplacement si le fichier a été déplacé."""
import hashlib
import logging
import os
import sqlite3
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config, db, previews, raw_loader
from .photos import get_photo_row

router = APIRouter()
log = logging.getLogger(__name__)

ALLOWED_EXTS = config.RAW_EXTS | config.IMG_EXTS


def _resolve_project(project_id: int | None) -> int:
    """Retourne un project_id valide : celui demandé, sinon le premier projet (la « maison »)."""
    if project_id:
        row = db.query_one("SELECT id FROM projects WHERE id=?", (project_id,))
        if row:
            return row["id"]
    row = db.query_one("SELECT id FROM projects ORDER BY id LIMIT 1")
    return row["id"] if row else 0


def _hash_file(path: Path) -> str:
    sha = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            sha.update(chunk)
    return sha.hexdigest()


def register_path(src: Path, project_id: int | None = None) -> dict:
    """Référence `src` dans la bibliothèque (aucune copie), déduplique par hash, indexe."""
    project_id = _resolve_project(project_id)
    ext = src.suffix.lower()
    if ext not in ALLOWED_EXTS:
        return {"filename": src.name, "status": "ignored", "reason": "format non supporté"}
    if not src.is_file():
        return {"filename": src.name, "status": "error", "reason": "fichier introuvable"}

    digest = _hash_file(src)
    existing = db.query_one("SELECT id FROM photos WHERE hash=?", (digest,))
    if existing:
        return {"filename": src.name, "status": "duplicate", "id": existing["id"]}

    abs_path = str(src.resolve())
    meta = raw_loader.read_exif(src)
    width, height = raw_loader.image_dimensions(src)
    now = datetime.now()
    try:
        photo_id = db.execute(
            """INSERT INTO photos (filename, path, hash, ext, is_raw, width, height,
               captured_at, imported_at, camera, lens, iso, aperture, shutter, focal, project_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (src.name, abs_path, digest, ext,
             int(raw_loader.is_raw(src)), width, height,
             meta["captured_at"], now.isoformat(), meta["camera"], meta["lens"],
             meta["iso"], meta["aperture"], meta["shutter"], meta["focal"], project_id))
    except sqlite3.IntegrityError:
        # Course TOCTOU : un import concurrent du même fichier a gagné la course
        # (le check `existing` plus haut puis l'INSERT ne sont pas atomiques).
        row = db.query_one("SELECT id FROM photos WHERE hash=?", (digest,))
        return {"filename": src.name, "status": "duplicate",
                "id": row["id"] if row else None}
    try:
        previews.generate_initial_previews(photo_id, src, meta.get("_orientation"))
    except Exception as e:
        log.warning("Previews initiaux impossibles pour %s : %s", src.name, e)
    row = db.query_one("SELECT * FROM photos WHERE id=?", (photo_id,))
    return {"filename": src.name, "status": "imported",
            "photo": db.photo_to_dict(row) if row else None, "id": photo_id}


def _resolve_browse_path(raw: str) -> Path:
    if not raw:
        raise HTTPException(422, "Chemin vide")
    target = Path(raw).resolve()
    if not target.exists():
        raise HTTPException(404, "Dossier introuvable")
    return target


@router.get("/import/browse")
def browse(path: str = ""):
    """Parcourt le disque local : racine (lecteurs) si `path` vide, sinon le dossier demandé.

    Chemins absolus en entrée/sortie (app locale mono-utilisateur, accès disque complet
    côté serveur — pas de bac à sable façon dossier monté)."""
    if not path:
        dirs = []
        try:
            for drive in os.listdrives():  # Windows uniquement (Python 3.12+)
                dirs.append({"name": drive, "path": drive})
        except (AttributeError, OSError):
            dirs.append({"name": "/", "path": "/"})
        return {"available": True, "path": "", "dirs": dirs, "files": []}

    target = _resolve_browse_path(path)
    if not target.is_dir():
        raise HTTPException(404, "Dossier introuvable")
    dirs, files = [], []
    try:
        entries = sorted(target.iterdir(), key=lambda p: p.name.lower())
    except OSError as e:
        raise HTTPException(403, f"Dossier inaccessible : {e}")
    for entry in entries:
        if entry.name.startswith("."):
            continue
        try:
            if entry.is_dir():
                dirs.append({"name": entry.name, "path": str(entry)})
            elif entry.suffix.lower() in ALLOWED_EXTS:
                files.append({"name": entry.name, "path": str(entry), "size": entry.stat().st_size})
        except OSError:
            continue  # lien mort, permission refusée…
    parent = str(target.parent) if target.parent != target else ""
    return {"available": True, "path": str(target), "parent": parent, "dirs": dirs, "files": files}


class FolderImport(BaseModel):
    paths: list[str]
    project_id: int = 0


@router.post("/import/folder")
def import_from_folder(req: FolderImport):
    results = []
    for raw in req.paths:
        target = Path(raw)
        if not target.is_file():
            results.append({"filename": raw, "status": "error", "reason": "introuvable"})
            continue
        try:
            results.append(register_path(target, project_id=req.project_id))
        except Exception as e:
            log.exception("Import dossier échoué : %s", raw)
            results.append({"filename": target.name, "status": "error", "reason": str(e)})
    return {"results": results}


class RelinkBody(BaseModel):
    path: str


@router.patch("/photos/{photo_id}/relink")
def relink(photo_id: int, body: RelinkBody):
    """Relie une photo à un nouvel emplacement disque (fichier déplacé/renommé).

    Si le hash diffère de l'original enregistré (contenu différent), on relie quand même
    mais on prévient le client — évite un rejet strict qui bloquerait un usage légitime
    (ex. fichier ré-exporté par un autre outil sous le même nom)."""
    row = get_photo_row(photo_id)
    target = Path(body.path)
    if not target.is_file():
        raise HTTPException(404, "Fichier introuvable")
    new_hash = _hash_file(target)
    warning = None
    if new_hash != row["hash"]:
        conflict = db.query_one("SELECT id FROM photos WHERE hash=? AND id!=?", (new_hash, photo_id))
        if conflict:
            raise HTTPException(409, "Ce fichier est déjà catalogué sous une autre photo")
        warning = "Le contenu du fichier diffère de l'original catalogué"
    db.execute("UPDATE photos SET path=?, hash=? WHERE id=?",
               (str(target.resolve()), new_hash, photo_id))
    if new_hash != row["hash"]:
        previews.invalidate(photo_id)
        try:
            previews.generate_initial_previews(photo_id, target)
        except Exception as e:
            log.warning("Previews impossibles après relink #%s : %s", photo_id, e)
    updated = db.query_one("SELECT * FROM photos WHERE id=?", (photo_id,))
    result = db.photo_to_dict(updated, with_edits=False)
    if warning:
        result["warning"] = warning
    return result
