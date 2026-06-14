"""Export pleine résolution : décodage RAW complet + pipeline + JPEG/PNG/TIFF."""
import json
import logging
from datetime import datetime
from pathlib import Path

import cv2
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config, db, denoise, pipeline, raw_loader

router = APIRouter()
log = logging.getLogger(__name__)

FORMATS = {"jpeg": ".jpg", "png": ".png", "tiff": ".tif"}


class ExportRequest(BaseModel):
    ids: list[int]
    format: str = "jpeg"
    quality: int = 92
    max_size: int = 0          # 0 = pleine résolution
    suffix: str = ""


@router.post("/export")
def export(req: ExportRequest):
    if req.format not in FORMATS:
        raise HTTPException(422, f"Format inconnu : {req.format}")
    if not req.ids:
        raise HTTPException(422, "Aucune photo sélectionnée")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = config.EXPORTS_DIR / stamp
    out_dir.mkdir(parents=True, exist_ok=True)
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


def _export_one(row: dict, out_dir: Path, req: ExportRequest) -> dict:
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
                                max(base.shape[:2]), denoised_base=denoised)
    del base, denoised
    stem = Path(row["filename"]).stem + (req.suffix or "")
    ext = FORMATS[req.format]
    dest = out_dir / f"{stem}{ext}"
    i = 1
    while dest.exists():
        dest = out_dir / f"{stem}-{i}{ext}"
        i += 1
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
            "width": int(arr.shape[1]), "height": int(arr.shape[0])}
