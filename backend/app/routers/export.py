"""Export pleine résolution : décodage RAW complet + pipeline + JPEG/PNG/TIFF.

Deux endpoints :
- `POST /export`        : synchrone, séquentiel (réponse unique) — simple, utilisé par les tests.
- `POST /export/stream` : parallèle (ThreadPoolExecutor) + flux NDJSON de progression.
  Le décodage RAW (LibRaw) et le pipeline (OpenCV/NumPy) relâchent le GIL → les threads
  exploitent plusieurs cœurs. Une ligne JSON est émise par photo terminée (file/error),
  puis une ligne « done ».
"""
import json
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

import cv2
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import config, db, denoise, pipeline, raw_loader

router = APIRouter()
log = logging.getLogger(__name__)

FORMATS = {"jpeg": ".jpg", "png": ".png", "tiff": ".tif"}

# Nombre de photos exportées en parallèle. Borné : chaque worker tient une image pleine
# résolution en mémoire. Surchageable via la variable d'environnement EXPORT_WORKERS.
EXPORT_WORKERS = int(os.environ.get("EXPORT_WORKERS", 0)) or min((os.cpu_count() or 2), 4)

_name_lock = threading.Lock()   # réservation atomique des noms de fichiers (export parallèle)


class ExportRequest(BaseModel):
    ids: list[int]
    format: str = "jpeg"
    quality: int = 92
    max_size: int = 0          # 0 = pleine résolution
    suffix: str = ""


def _new_export_dir() -> tuple[Path, str]:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = config.EXPORTS_DIR / stamp
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir, stamp


@router.post("/export")
def export(req: ExportRequest):
    if req.format not in FORMATS:
        raise HTTPException(422, f"Format inconnu : {req.format}")
    if not req.ids:
        raise HTTPException(422, "Aucune photo sélectionnée")
    out_dir, stamp = _new_export_dir()
    files, errors = [], []
    for photo_id in req.ids:
        row = db.query_one("SELECT * FROM photos WHERE id=?", (photo_id,))
        if row is None:
            errors.append({"id": photo_id, "error": "introuvable"})
            continue
        try:
            files.append(_export_one(dict(row), out_dir, req))
        except Exception as e:
            log.exception("Export échoué #%s", photo_id)
            errors.append({"id": photo_id, "error": str(e)})
    return {"folder": f"data/exports/{stamp}", "files": files, "errors": errors}


@router.post("/export/stream")
def export_stream(req: ExportRequest):
    """Export parallèle avec progression : flux NDJSON (une ligne JSON par évènement)."""
    if req.format not in FORMATS:
        raise HTTPException(422, f"Format inconnu : {req.format}")
    if not req.ids:
        raise HTTPException(422, "Aucune photo sélectionnée")
    out_dir, stamp = _new_export_dir()
    folder = f"data/exports/{stamp}"

    # Accès DB dans le thread de la requête, avant de lancer les workers (qui ne touchent pas la DB).
    rows, missing = [], []
    for photo_id in req.ids:
        row = db.query_one("SELECT * FROM photos WHERE id=?", (photo_id,))
        (rows.append(dict(row)) if row is not None else missing.append(photo_id))

    def gen():
        for photo_id in missing:
            yield json.dumps({"type": "error", "id": photo_id, "error": "introuvable"}) + "\n"
        if rows:
            workers = max(1, min(EXPORT_WORKERS, len(rows)))
            with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="rs-export") as pool:
                futs = {pool.submit(_export_one, r, out_dir, req): r for r in rows}
                for fut in as_completed(futs):
                    r = futs[fut]
                    try:
                        yield json.dumps({"type": "file", **fut.result()}) + "\n"
                    except Exception as e:
                        log.exception("Export échoué #%s", r.get("id"))
                        yield json.dumps({"type": "error", "id": r.get("id"), "error": str(e)}) + "\n"
        yield json.dumps({"type": "done", "folder": folder}) + "\n"

    return StreamingResponse(gen(), media_type="application/x-ndjson")


def _export_one(row: dict, out_dir: Path, req: ExportRequest) -> dict:
    t0 = time.perf_counter()
    original = config.ORIGINALS_DIR / row["relpath"]
    base = raw_loader.decode_full(original)
    edits = json.loads(row.get("edits") or "{}")
    # Débruitage IA pleine résolution (tuilé) — chemin lent, seulement si le réglage est actif.
    denoised = None
    if float(edits.get("detail", {}).get("nr_ai", 0.0)) > 0.0 and denoise.available():
        try:
            denoised = denoise.denoise(base)
        except Exception as e:
            log.warning("Débruitage IA export échoué #%s : %s", row.get("id"), e)
    arr = pipeline.render_array(base, edits, req.max_size or 0,
                                max(base.shape[:2]), denoised_base=denoised,
                                seed=int(row.get("id") or 0))
    del base, denoised
    stem = Path(row["filename"]).stem + (req.suffix or "")
    ext = FORMATS[req.format]
    # Réservation atomique du nom (l'export parallèle peut viser des noms identiques) :
    # on choisit un nom libre ET on le réserve par un fichier vide, sous verrou.
    with _name_lock:
        dest = out_dir / f"{stem}{ext}"
        i = 1
        while dest.exists():
            dest = out_dir / f"{stem}-{i}{ext}"
            i += 1
        dest.touch()
    bgr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
    if req.format == "jpeg":
        ok = cv2.imwrite(str(dest), bgr,
                         [int(cv2.IMWRITE_JPEG_QUALITY), int(max(1, min(100, req.quality)))])
    elif req.format == "png":
        ok = cv2.imwrite(str(dest), bgr, [int(cv2.IMWRITE_PNG_COMPRESSION), 6])
    else:
        ok = cv2.imwrite(str(dest), bgr)
    if not ok:
        raise RuntimeError("écriture du fichier impossible")
    return {"id": row["id"], "name": dest.name,
            "url": f"/exports/{out_dir.name}/{dest.name}",
            "width": int(arr.shape[1]), "height": int(arr.shape[0]),
            "ms": round((time.perf_counter() - t0) * 1000)}
