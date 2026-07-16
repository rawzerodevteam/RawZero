"""RawZero — application FastAPI : API + frontend statique + exports."""
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config, db
from .routers import albums, edits, export, imports, models, photos, projects, render

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

# Origines autorisées. L'app est purement locale : le frontend buildé est servi par ce même
# serveur (:8000) et, en dev, par Vite (:5173). Toute autre origine (page web tierce ouverte
# dans le navigateur) est rejetée — cf. S1 de l'audit : sans ça, `allow_origins=["*"]` laisse
# n'importe quel site lire /import/browse (cartographie du disque) ou déclencher import/suppression.
# Surchargeable par RAWZERO_ALLOWED_ORIGINS (liste séparée par des virgules) pour un port custom.
_DEFAULT_ORIGINS = [
    "http://localhost:8000", "http://127.0.0.1:8000",
    "http://localhost:5173", "http://127.0.0.1:5173",
    "tauri://localhost", "http://tauri.localhost",  # webview Tauri (selon plateforme)
]
ALLOWED_ORIGINS = [
    o.strip() for o in os.environ.get("RAWZERO_ALLOWED_ORIGINS", "").split(",") if o.strip()
] or _DEFAULT_ORIGINS

# Hôtes acceptés dans l'en-tête Host (défense anti DNS-rebinding : un nom de domaine attaquant
# résolu vers 127.0.0.1 arrive avec un Host inattendu → rejeté avant d'atteindre les routes).
_ALLOWED_HOSTS = {"localhost", "127.0.0.1", "[::1]", "tauri.localhost"}


@asynccontextmanager
async def lifespan(_: FastAPI):
    config.ensure_dirs()
    db.get_conn()
    edits.seed_presets()
    export.purge_old_exports()  # B1 : évite la croissance illimitée de data/exports/
    yield


app = FastAPI(title="RawZero", version="1.0.0", lifespan=lifespan)


@app.middleware("http")
async def guard_host(request: Request, call_next):
    """Rejette les requêtes dont l'en-tête Host n'est pas local (anti DNS-rebinding).

    Le serveur n'écoute que sur 127.0.0.1, mais une page web piégée peut résoudre un domaine
    qu'elle contrôle vers 127.0.0.1 et viser localhost:8000 ; le Host porte alors ce domaine,
    pas « localhost ». On coupe ici, avant CORS et les routes disque."""
    host = (request.headers.get("host") or "").rsplit(":", 1)[0]
    if host and host not in _ALLOWED_HOSTS:
        return JSONResponse({"detail": "Hôte non autorisé"}, status_code=403)
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Server-Timing"],  # lisible par le panneau de profilage dev
)

for r in (photos.router, imports.router, render.router, edits.router, export.router,
          projects.router, albums.router, models.router):
    app.include_router(r, prefix="/api")


@app.get("/api/health")
def health():
    return {"status": "ok", "app": "RawZero", "version": "1.0.0"}


app.mount("/exports", StaticFiles(directory=str(config.EXPORTS_DIR), check_dir=False),
          name="exports")

_static = Path(config.STATIC_DIR) if config.STATIC_DIR else None
if _static and _static.is_dir():
    app.mount("/assets", StaticFiles(directory=str(_static / "assets")), name="assets")

    _static_root = _static.resolve()

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        # Confinement (cf. durcissement import/masques) : `is_file()` seul suivrait un
        # `../../…` hors du dossier statique → on exige que la cible reste sous _static.
        candidate = (_static / full_path).resolve()
        if full_path and candidate.is_file() and candidate.is_relative_to(_static_root):
            return FileResponse(candidate)
        return FileResponse(_static / "index.html")
else:
    @app.get("/", include_in_schema=False)
    def root():
        return JSONResponse({"app": "RawZero API",
                             "hint": "frontend non buildé : utiliser le serveur Vite (npm run dev)"})
