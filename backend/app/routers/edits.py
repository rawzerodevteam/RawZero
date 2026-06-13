"""Sauvegarde des edits, auto-réglages, presets (filtres globaux)."""
import json
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config, db, pipeline, previews
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
