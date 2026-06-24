"""Import : upload navigateur + dossier monté (/import en Docker)."""
import hashlib
import logging
import re
import shutil
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Form, HTTPException, UploadFile
from pydantic import BaseModel

from .. import config, db, previews, raw_loader

router = APIRouter()
log = logging.getLogger(__name__)

ALLOWED_EXTS = config.RAW_EXTS | config.IMG_EXTS


def _safe_name(name: str) -> str:
    name = Path(name).name
    return re.sub(r"[^A-Za-z0-9._\-éèêëàâäôöûüçÉÈÀÔ ]+", "_", name) or "photo"


def _resolve_project(project_id: int | None) -> int:
    """Retourne un project_id valide : celui demandé, sinon le premier projet (la « maison »)."""
    if project_id:
        row = db.query_one("SELECT id FROM projects WHERE id=?", (project_id,))
        if row:
            return row["id"]
    row = db.query_one("SELECT id FROM projects ORDER BY id LIMIT 1")
    return row["id"] if row else 0


def import_bytes_or_file(filename: str, src: Path | None = None,
                         data: bytes | None = None, project_id: int | None = None) -> dict:
    """Copie dans la bibliothèque, déduplique par hash, indexe, génère les previews."""
    project_id = _resolve_project(project_id)
    filename = _safe_name(filename)
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXTS:
        return {"filename": filename, "status": "ignored", "reason": "format non supporté"}

    sha = hashlib.sha1()
    if src is not None:
        with open(src, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                sha.update(chunk)
    else:
        sha.update(data or b"")
    digest = sha.hexdigest()

    existing = db.query_one("SELECT id FROM photos WHERE hash=?", (digest,))
    if existing:
        return {"filename": filename, "status": "duplicate", "id": existing["id"]}

    now = datetime.now()
    sub = Path(f"{now:%Y}/{now:%m}")
    dest_dir = config.ORIGINALS_DIR / sub
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / filename
    i = 1
    while dest.exists():
        dest = dest_dir / f"{Path(filename).stem}-{i}{ext}"
        i += 1
    if src is not None:
        shutil.copy2(src, dest)
    else:
        dest.write_bytes(data or b"")

    meta = raw_loader.read_exif(dest)
    width, height = raw_loader.image_dimensions(dest)
    photo_id = db.execute(
        """INSERT INTO photos (filename, relpath, hash, ext, is_raw, width, height,
           captured_at, imported_at, camera, lens, iso, aperture, shutter, focal, project_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (dest.name, str(sub / dest.name).replace("\\", "/"), digest, ext,
         int(raw_loader.is_raw(dest)), width, height,
         meta["captured_at"], now.isoformat(), meta["camera"], meta["lens"],
         meta["iso"], meta["aperture"], meta["shutter"], meta["focal"], project_id))
    try:
        previews.generate_initial_previews(photo_id, dest, meta.get("_orientation"))
    except Exception as e:
        log.warning("Previews initiaux impossibles pour %s : %s", dest.name, e)
    row = db.query_one("SELECT * FROM photos WHERE id=?", (photo_id,))
    return {"filename": dest.name, "status": "imported",
            "photo": db.photo_to_dict(row) if row else None, "id": photo_id}


@router.post("/import/upload")
async def import_upload(files: list[UploadFile], project_id: int = Form(0)):
    results = []
    for f in files:
        data = await f.read()
        try:
            results.append(import_bytes_or_file(f.filename or "photo", data=data, project_id=project_id))
        except Exception as e:
            log.exception("Import upload échoué : %s", f.filename)
            results.append({"filename": f.filename, "status": "error", "reason": str(e)})
    return {"results": results}


def _resolve_import_path(rel: str) -> Path:
    base = config.IMPORT_DIR.resolve()
    target = (base / rel.lstrip("/\\")).resolve()
    # is_relative_to (vs startswith de chaîne) : « /import_evil » ne passe plus pour base « /import ».
    if target != base and not target.is_relative_to(base):
        raise HTTPException(403, "Chemin hors du dossier d'import")
    return target


@router.get("/import/browse")
def browse(path: str = ""):
    if not config.IMPORT_DIR.exists():
        return {"available": False, "path": path, "dirs": [], "files": []}
    target = _resolve_import_path(path)
    if not target.is_dir():
        raise HTTPException(404, "Dossier introuvable")
    dirs, files = [], []
    for entry in sorted(target.iterdir(), key=lambda p: p.name.lower()):
        if entry.name.startswith("."):
            continue
        rel = str(entry.relative_to(config.IMPORT_DIR)).replace("\\", "/")
        if entry.is_dir():
            dirs.append({"name": entry.name, "path": rel})
        elif entry.suffix.lower() in ALLOWED_EXTS:
            files.append({"name": entry.name, "path": rel, "size": entry.stat().st_size})
    return {"available": True, "path": path, "dirs": dirs, "files": files}


class FolderImport(BaseModel):
    paths: list[str]
    project_id: int = 0


@router.post("/import/folder")
def import_from_folder(req: FolderImport):
    results = []
    for rel in req.paths:
        target = _resolve_import_path(rel)
        if not target.is_file():
            results.append({"filename": rel, "status": "error", "reason": "introuvable"})
            continue
        try:
            results.append(import_bytes_or_file(target.name, src=target, project_id=req.project_id))
        except Exception as e:
            log.exception("Import dossier échoué : %s", rel)
            results.append({"filename": rel, "status": "error", "reason": str(e)})
    return {"results": results}
