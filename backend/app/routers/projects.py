"""Projets : dossiers d'import. Chaque photo appartient à un projet."""
from datetime import datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import db, previews

router = APIRouter()


@router.get("/projects")
def list_projects():
    rows = db.query(
        """SELECT p.id, p.name, p.created_at, COUNT(ph.id) AS count
           FROM projects p LEFT JOIN photos ph ON ph.project_id = p.id
           GROUP BY p.id ORDER BY p.created_at ASC, p.id ASC""")
    return {"projects": [dict(r) for r in rows]}


class ProjectIn(BaseModel):
    name: str = "Projet"


@router.post("/projects")
def create_project(body: ProjectIn):
    name = body.name.strip() or "Projet"
    pid = db.execute("INSERT INTO projects (name, created_at) VALUES (?, ?)",
                     (name, datetime.now().isoformat()))
    return {"id": pid, "name": name, "count": 0}


@router.patch("/projects/{project_id}")
def rename_project(project_id: int, body: ProjectIn):
    if db.query_one("SELECT id FROM projects WHERE id=?", (project_id,)) is None:
        raise HTTPException(404, "Projet introuvable")
    name = body.name.strip() or "Projet"
    db.execute("UPDATE projects SET name=? WHERE id=?", (name, project_id))
    return {"id": project_id, "name": name}


@router.delete("/projects/{project_id}")
def delete_project(project_id: int, delete_files: bool = False):
    if db.query_one("SELECT id FROM projects WHERE id=?", (project_id,)) is None:
        raise HTTPException(404, "Projet introuvable")
    if (db.query_one("SELECT COUNT(*) AS n FROM projects") or {"n": 0})["n"] <= 1:
        raise HTTPException(422, "Impossible de supprimer le dernier projet")
    # retire les photos du projet (cache invalidé ; fichiers conservés sauf demande explicite)
    from .. import config
    for ph in db.query("SELECT id, relpath FROM photos WHERE project_id=?", (project_id,)):
        previews.invalidate(ph["id"])
        if delete_files:
            (config.ORIGINALS_DIR / ph["relpath"]).unlink(missing_ok=True)
    db.execute("DELETE FROM photos WHERE project_id=?", (project_id,))
    db.execute("DELETE FROM projects WHERE id=?", (project_id,))
    return {"ok": True}
