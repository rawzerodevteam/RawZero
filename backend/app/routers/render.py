"""Rendu interactif (edits → JPEG) + fichiers cache (thumb/preview) + original."""
import logging
from typing import Any, Optional

from fastapi import APIRouter, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import config, db, pipeline, previews
from .photos import get_photo_row

router = APIRouter()
log = logging.getLogger(__name__)


class RenderRequest(BaseModel):
    edits: dict[str, Any] = {}


@router.post("/photos/{photo_id}/render")
def render(photo_id: int, req: RenderRequest, max_size: int = config.PREVIEW_SIZE,
           show_mask: str = "", before: bool = False, crop_edit: bool = False):
    row = get_photo_row(photo_id)
    original = config.ORIGINALS_DIR / row["relpath"]
    base = previews.get_base(photo_id, original)
    edits = {} if before else req.edits
    denoised = None
    if not before and float(edits.get("detail", {}).get("nr_ai", 0.0)) > 0.0:
        denoised = previews.get_denoised_base(photo_id, original)
    arr = pipeline.render_array(base, edits, min(max_size, config.BASE_SIZE),
                                previews.full_long_edge(dict(row)), show_mask=show_mask,
                                skip_crop=crop_edit, denoised_base=denoised)
    return Response(content=pipeline.encode_jpeg(arr, 90), media_type="image/jpeg",
                    headers={"Cache-Control": "no-store"})


@router.get("/photos/{photo_id}/denoised")
def denoised(photo_id: int, max_size: int = 1600):
    """Base **neutre débruitée** (JPEG) pour la texture GPU — miroir du chemin `before:true`.
    503 si le modèle de débruitage est absent (le client masque alors le réglage)."""
    row = get_photo_row(photo_id)
    original = config.ORIGINALS_DIR / row["relpath"]
    dn = previews.get_denoised_base(photo_id, original)
    if dn is None:
        return Response(status_code=503)
    arr = pipeline.render_array(dn, {}, min(max_size, config.BASE_SIZE),
                                previews.full_long_edge(dict(row)))
    return Response(content=pipeline.encode_jpeg(arr, 90), media_type="image/jpeg",
                    headers={"Cache-Control": "no-store"})


def _cached_file(photo_id: int, path, fallback_quality: int) -> Response:
    if not path.exists():
        row = get_photo_row(photo_id)
        try:
            previews.generate_initial_previews(photo_id, config.ORIGINALS_DIR / row["relpath"])
        except Exception as e:
            log.warning("Génération preview à la volée échouée #%s : %s", photo_id, e)
    if path.exists():
        return FileResponse(path, media_type="image/jpeg",
                            headers={"Cache-Control": "no-cache"})
    return Response(content=previews.placeholder_jpeg(), media_type="image/jpeg")


@router.get("/photos/{photo_id}/thumb")
def thumb(photo_id: int, v: Optional[str] = None):
    return _cached_file(photo_id, previews.thumb_path(photo_id), 82)


@router.get("/photos/{photo_id}/preview")
def preview(photo_id: int, v: Optional[str] = None):
    return _cached_file(photo_id, previews.preview_path(photo_id), 88)


@router.get("/photos/{photo_id}/original")
def original(photo_id: int):
    row = get_photo_row(photo_id)
    path = config.ORIGINALS_DIR / row["relpath"]
    return FileResponse(path, filename=row["filename"])
