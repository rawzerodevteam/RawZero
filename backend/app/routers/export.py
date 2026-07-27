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
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from fractions import Fraction
from pathlib import Path
from typing import Optional

import tifffile
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from PIL import Image, ImageCms
from pydantic import BaseModel

from .. import config, db, denoise, pipeline, raw_loader
from .photos import require_original

router = APIRouter()
log = logging.getLogger(__name__)

FORMATS = {"jpeg": ".jpg", "png": ".png", "tiff": ".tif"}

# Profil ICC sRGB embarqué dans les exports (le pipeline travaille en sRGB, cf. CLAUDE.md §5) :
# sans profil, certains éditeurs/visionneuses (Photoshop, navigateurs stricts) supposent un
# espace non managé et peuvent afficher des couleurs légèrement différentes.
_SRGB_ICC = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()


def _exif_rational(value) -> Optional[tuple[int, int]]:
    """Convertit un nombre (ou une fraction texte type '1/200') en rationnel EXIF (num, den)."""
    try:
        s = str(value).strip()
        if "/" in s:
            num, den = s.split("/", 1)
            return (int(num), int(den))
        f = Fraction(float(value)).limit_denominator(100000)
        return (f.numerator, max(f.denominator, 1))
    except (ValueError, ZeroDivisionError):
        return None


def _build_exif(row: dict) -> bytes:
    """Reconstruit un minimum d'EXIF (IFD0 + Exif) depuis les métadonnées du catalogue,
    embarqué dans les exports JPEG/PNG (perdu sinon : cv2.imwrite n'écrit aucune métadonnée)."""
    exif = Image.Exif()
    if row.get("camera"):
        exif[0x0110] = str(row["camera"])                       # Model
    if row.get("lens"):
        exif[0xA434] = str(row["lens"])                         # LensModel
    captured_at = row.get("captured_at")
    if captured_at:
        try:
            dt = datetime.fromisoformat(str(captured_at))
            exif[0x9003] = dt.strftime("%Y:%m:%d %H:%M:%S")     # DateTimeOriginal
        except ValueError:
            pass
    if row.get("iso"):
        try:
            exif[0x8827] = int(row["iso"])                      # ISOSpeedRatings
        except (TypeError, ValueError):
            pass
    if row.get("aperture"):
        r = _exif_rational(row["aperture"])
        if r:
            exif[0x829D] = r                                    # FNumber
    if row.get("shutter"):
        r = _exif_rational(row["shutter"])
        if r:
            exif[0x829A] = r                                    # ExposureTime
    if row.get("focal"):
        r = _exif_rational(row["focal"])
        if r:
            exif[0x920A] = r                                    # FocalLength
    return exif.tobytes()

# Nombre de photos exportées en parallèle. Borné : chaque worker tient une image pleine
# résolution en mémoire. Surchageable via la variable d'environnement EXPORT_WORKERS.
EXPORT_WORKERS = int(os.environ.get("EXPORT_WORKERS", 0)) or min((os.cpu_count() or 2), 4)

_name_lock = threading.Lock()   # réservation atomique des noms de fichiers (export parallèle)

# Rétention des dossiers d'export sous data/exports/ (en jours). Chaque export y dépose des copies
# pleine résolution ; sans purge, le disque se remplit indéfiniment (l'utilisateur récupère déjà ses
# fichiers ailleurs via l'écriture directe navigateur). Purge appelée au démarrage. 0 = jamais purger.
EXPORT_RETENTION_DAYS = float(os.environ.get("RAWZERO_EXPORT_RETENTION_DAYS", "7"))


def purge_old_exports() -> int:
    """Supprime les dossiers d'export plus vieux que EXPORT_RETENTION_DAYS. Retourne le nombre purgé."""
    if EXPORT_RETENTION_DAYS <= 0 or not config.EXPORTS_DIR.is_dir():
        return 0
    cutoff = time.time() - EXPORT_RETENTION_DAYS * 86400
    purged = 0
    for d in config.EXPORTS_DIR.iterdir():
        try:
            if d.is_dir() and d.stat().st_mtime < cutoff:
                shutil.rmtree(d, ignore_errors=True)
                purged += 1
        except OSError:
            log.warning("Purge de l'export %s impossible", d, exc_info=True)
    if purged:
        log.info("Purge des exports : %d dossier(s) supprimé(s) (> %g j)", purged, EXPORT_RETENTION_DAYS)
    return purged


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
    original = require_original(row)
    base = raw_loader.decode_full(original)
    edits = json.loads(row.get("edits") or "{}")
    # Débruitage IA pleine résolution (tuilé) — chemin lent, seulement si le réglage est actif.
    denoised = None
    if float(edits.get("detail", {}).get("nr_ai", 0.0)) > 0.0 and denoise.available():
        try:
            denoised = denoise.denoise(base)
        except Exception as e:
            log.warning("Débruitage IA export échoué #%s : %s", row.get("id"), e)
    # TIFF exporte en pleine dynamique 16 bits (JPEG/PNG restent 8 bits : JPEG l'impose, PNG 16
    # bits multi-canal n'est pas fiable en écriture avec les bibliothèques disponibles ici).
    bit_depth = 16 if req.format == "tiff" else 8
    arr = pipeline.render_array(base, edits, req.max_size or 0,
                                max(base.shape[:2]), denoised_base=denoised,
                                seed=int(row.get("id") or 0), bit_depth=bit_depth)
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
    if req.format == "jpeg":
        Image.fromarray(arr, "RGB").save(
            str(dest), format="JPEG", quality=int(max(1, min(100, req.quality))),
            icc_profile=_SRGB_ICC, exif=_build_exif(row))
    elif req.format == "png":
        Image.fromarray(arr, "RGB").save(
            str(dest), format="PNG", compress_level=6,
            icc_profile=_SRGB_ICC, exif=_build_exif(row))
    else:
        tifffile.imwrite(str(dest), arr, photometric="rgb", iccprofile=_SRGB_ICC,
                         compression="adobe_deflate")
    return {"id": row["id"], "name": dest.name,
            "url": f"/exports/{out_dir.name}/{dest.name}",
            "width": int(arr.shape[1]), "height": int(arr.shape[0]),
            "ms": round((time.perf_counter() - t0) * 1000)}
