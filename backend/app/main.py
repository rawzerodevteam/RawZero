"""RawStudio — application FastAPI : API + frontend statique + exports."""
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config, db
from .routers import edits, export, imports, photos, projects, render

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    config.ensure_dirs()
    db.get_conn()
    edits.seed_presets()
    yield


app = FastAPI(title="RawStudio", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # application locale ; le serveur Vite de dev tourne sur un autre port
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Server-Timing"],  # lisible par le panneau de profilage dev
)

for r in (photos.router, imports.router, render.router, edits.router, export.router, projects.router):
    app.include_router(r, prefix="/api")


@app.get("/api/health")
def health():
    return {"status": "ok", "app": "RawStudio", "version": "1.0.0"}


app.mount("/exports", StaticFiles(directory=str(config.EXPORTS_DIR), check_dir=False),
          name="exports")

_static = Path(config.STATIC_DIR) if config.STATIC_DIR else None
if _static and _static.is_dir():
    app.mount("/assets", StaticFiles(directory=str(_static / "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        candidate = _static / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(_static / "index.html")
else:
    @app.get("/", include_in_schema=False)
    def root():
        return JSONResponse({"app": "RawStudio API",
                             "hint": "frontend non buildé : utiliser le serveur Vite (npm run dev)"})
