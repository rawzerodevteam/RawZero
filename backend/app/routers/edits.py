"""Sauvegarde des edits, auto-réglages, presets (filtres globaux)."""
import json
import uuid
from typing import Any

import cv2
import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from pydantic import BaseModel

from .. import config, db, denoise, pipeline, previews, segment
from .photos import get_photo_row

router = APIRouter()


class EditsBody(BaseModel):
    edits: dict[str, Any]


@router.put("/photos/{photo_id}/edits")
def save_edits(photo_id: int, body: EditsBody):
    get_photo_row(photo_id)
    db.execute("UPDATE photos SET edits=? WHERE id=?",
               (json.dumps(body.edits), photo_id))
    previews.schedule_preview_refresh(photo_id)
    return {"ok": True}


@router.post("/photos/{photo_id}/auto")
def auto(photo_id: int, body: EditsBody):
    row = get_photo_row(photo_id)
    base = previews.get_base(photo_id, config.ORIGINALS_DIR / row["relpath"])
    return {"edits": pipeline.auto_adjust(base, body.edits)}


class WbPickBody(EditsBody):
    x: float
    y: float


@router.post("/photos/{photo_id}/wb_pick")
def wb_pick(photo_id: int, body: WbPickBody):
    """Pipette WB : renvoie {temp, tint} neutralisant le point (x, y) cliqué."""
    row = get_photo_row(photo_id)
    base = previews.get_base(photo_id, config.ORIGINALS_DIR / row["relpath"])
    return pipeline.wb_from_point(base, body.edits, body.x, body.y)


# ------------------------------------------------------------- masques IA

# Borne de stockage du masque (bord long) : assez fin pour un upscale propre, fichier léger.
_MASK_STORE_SIZE = 1024


@router.get("/automask/available")
def automask_available():
    """Indique au client quelles fonctions IA sont utilisables (modèles présents)."""
    return {"subject": segment.available(), "point": segment.point_available(),
            "denoise": denoise.available()}


class AutoMaskBody(EditsBody):
    kind: str = "subject"


@router.post("/photos/{photo_id}/automask")
def automask(photo_id: int, body: AutoMaskBody):
    """Calcule un masque IA, le stocke (PNG), et renvoie le descripteur `local` à ajouter aux edits.

    Le masque est calculé sur l'image *géométrie appliquée* (recadrée) pour s'aligner sur
    l'espace des autres masques, puis stocké normalisé sous MASKS_DIR/{photo}/{id}.png."""
    if body.kind != "subject":
        raise HTTPException(422, "Type de masque IA non pris en charge")
    if not segment.available():
        raise HTTPException(503, "Masque IA indisponible (onnxruntime ou modèle absent)")
    row = get_photo_row(photo_id)
    base = previews.get_base(photo_id, config.ORIGINALS_DIR / row["relpath"])
    e = pipeline.merge_edits(body.edits)
    img = pipeline.apply_geometry(base.astype(np.float32, copy=True), e["geometry"])
    small = _resize_long_edge(img, _MASK_STORE_SIZE)
    try:
        mask = segment.subject_mask(small)
    except segment.SegmentationUnavailable as ex:
        raise HTTPException(503, str(ex))
    if float(mask.max()) < 1e-3:
        raise HTTPException(422, "Aucun sujet détecté")
    return _store_mask(photo_id, mask, body.kind)


class ClickMaskBody(EditsBody):
    x: float
    y: float
    kind: str = "point"


@router.post("/photos/{photo_id}/clickmask")
def clickmask(photo_id: int, body: ClickMaskBody):
    """Segmentation au clic (EdgeSAM) : segmente l'élément sous le point (x, y) normalisé."""
    if not segment.point_available():
        raise HTTPException(503, "Segmentation au clic indisponible (modèle EdgeSAM absent)")
    row = get_photo_row(photo_id)
    base = previews.get_base(photo_id, config.ORIGINALS_DIR / row["relpath"])
    e = pipeline.merge_edits(body.edits)
    img = pipeline.apply_geometry(base.astype(np.float32, copy=True), e["geometry"])
    small = _resize_long_edge(img, _MASK_STORE_SIZE)
    try:
        mask = segment.point_mask(small, body.x, body.y, segment.geo_key(photo_id, e["geometry"]))
    except segment.SegmentationUnavailable as ex:
        raise HTTPException(503, str(ex))
    if float(mask.max()) < 1e-3:
        raise HTTPException(422, "Rien à segmenter à cet endroit")
    return _store_mask(photo_id, mask, body.kind)


def _store_mask(photo_id: int, mask: np.ndarray, kind: str) -> dict:
    """Écrit le bitmap du masque et renvoie le descripteur `local` (type 'ai')."""
    mask_id = "ai-" + uuid.uuid4().hex[:8]
    ref = f"{photo_id}/{mask_id}.png"
    out = config.MASKS_DIR / ref
    out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out), (np.clip(mask, 0.0, 1.0) * 255).astype(np.uint8))
    return {
        "id": mask_id, "type": "ai",
        "params": {"ref": ref, "kind": kind, "hardness": 0.0},
        "invert": False, "adjust": dict(pipeline.LOCAL_ADJUST_DEFAULTS),
    }


def _resize_long_edge(arr: np.ndarray, size: int) -> np.ndarray:
    h, w = arr.shape[:2]
    if max(h, w) <= size:
        return arr
    f = size / max(h, w)
    return cv2.resize(arr, (max(int(w * f), 1), max(int(h * f), 1)), interpolation=cv2.INTER_AREA)


@router.get("/masks/{photo_id}/{name}")
def get_mask_png(photo_id: int, name: str):
    """Sert le bitmap d'un masque IA (consommé par l'aperçu GPU côté navigateur)."""
    if "/" in name or "\\" in name or ".." in name:
        raise HTTPException(400, "Nom invalide")
    path = (config.MASKS_DIR / str(photo_id) / name).resolve()
    if config.MASKS_DIR.resolve() not in path.parents or not path.exists():
        raise HTTPException(404, "Masque introuvable")
    return FileResponse(path, media_type="image/png")


BUILTIN_PRESETS: list[tuple[str, dict]] = [
    ("Noir & blanc classique", {
        "presence": {"saturation": -100.0, "clarity": 12.0},
        "tone": {"contrast": 22.0}}),
    ("Noir & blanc punchy", {
        "presence": {"saturation": -100.0, "clarity": 30.0},
        "tone": {"contrast": 45.0, "blacks": -18.0, "whites": 12.0},
        "effects": {"grain": 18.0}}),
    ("Vivid", {
        "presence": {"vibrance": 35.0, "saturation": 8.0, "clarity": 10.0},
        "tone": {"contrast": 14.0}}),
    ("Film doux", {
        "tone": {"contrast": -12.0},
        "curve": {"points": [[0.0, 0.06], [0.5, 0.5], [1.0, 0.95]]},
        "presence": {"vibrance": 10.0},
        "effects": {"grain": 22.0}}),
    ("Chaud doré", {
        "wb": {"temp": 24.0},
        "presence": {"vibrance": 14.0},
        "tone": {"shadows": 10.0}}),
    ("Froid cinéma", {
        "wb": {"temp": -20.0, "tint": 6.0},
        "tone": {"contrast": 10.0, "blacks": -8.0},
        "presence": {"saturation": -10.0}}),
    ("Paysage net", {
        "presence": {"clarity": 22.0, "dehaze": 18.0, "vibrance": 22.0},
        "detail": {"sharpen_amount": 55.0, "sharpen_radius": 1.0}}),
]


def seed_presets() -> None:
    if db.query_one("SELECT id FROM presets LIMIT 1") is None:
        for name, settings in BUILTIN_PRESETS:
            db.execute("INSERT INTO presets (name, settings, builtin) VALUES (?,?,1)",
                       (name, json.dumps(settings)))


@router.get("/presets")
def list_presets():
    rows = db.query("SELECT * FROM presets ORDER BY builtin DESC, name COLLATE NOCASE")
    return {"presets": [{"id": r["id"], "name": r["name"], "builtin": bool(r["builtin"]),
                         "settings": json.loads(r["settings"])} for r in rows]}


class PresetBody(BaseModel):
    name: str
    settings: dict[str, Any]


@router.post("/presets")
def create_preset(body: PresetBody):
    name = body.name.strip()[:60] or "Preset"
    pid = db.execute("INSERT INTO presets (name, settings, builtin) VALUES (?,?,0)",
                     (name, json.dumps(body.settings)))
    return {"id": pid, "name": name, "builtin": False, "settings": body.settings}


@router.delete("/presets/{preset_id}")
def delete_preset(preset_id: int):
    row = db.query_one("SELECT builtin FROM presets WHERE id=?", (preset_id,))
    if row is None:
        raise HTTPException(404, "Preset introuvable")
    if row["builtin"]:
        raise HTTPException(403, "Les presets intégrés ne peuvent pas être supprimés")
    db.execute("DELETE FROM presets WHERE id=?", (preset_id,))
    return {"ok": True}
