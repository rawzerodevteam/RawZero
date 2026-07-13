# RawZero

A local, non-destructive **RAW photo editor** — inspired by Lightroom / Darktable.
Ships as a **desktop app** (Tauri) and runs as a **web app** (Podman / Docker).

> Architecture: a **FastAPI backend** + a **React/Vite frontend**. In the desktop app the
> backend runs as an embedded sidecar; in Docker it serves the built frontend on one port.
> The Tauri shell only wraps the same web app — so you develop in the browser.

## Development (hot reload)

### Without Docker — recommended (Windows, zero prerequisites)

One-time setup from a fresh clone. `bootstrap.ps1` installs a self-contained toolchain into
`.tools\` (uv + Python 3.12 + venv + backend deps, portable Node, frontend `node_modules`) —
nothing touches the system or the global PATH:

```powershell
.\bootstrap.ps1          # one-time install (re-run with -Force to rebuild from scratch)
.\start.ps1 -Dev         # backend (uvicorn --reload) + Vite dev server, both hot-reloading
```

Open **http://localhost:5173**. Edit a `.tsx` or `.py` → it reloads instantly. Rust/Tauri are
not involved. `.\start.ps1` (no `-Dev`) instead builds the frontend and serves API + UI on a
single port (**http://localhost:8000**), like the Docker image.

### With Docker

Backend (`uvicorn --reload`) + Vite dev server, code bind-mounted, both hot-reloading:

```bash
docker compose -f deploy/compose.dev.yaml up --build   # or: podman compose -f deploy/compose.dev.yaml up --build
```

Open **http://localhost:5173**. `./data` (catalog, caches, exports, and `./data/models` for AI
models) and `./import` are bind-mounted, so they persist. Vite proxies `/api` and `/exports` to
the backend on `:8000` (override with `VITE_API_PROXY`).

To import large folders without the browser: drop files into `./import`, then use
**Import → /import folder** in the app.

## Build

### Desktop installers (Tauri)

Bundles the PyInstaller backend sidecar + the Vite frontend into a native installer.
Prerequisites (Windows), install once then reopen the terminal:
- `.\bootstrap.ps1` (dev toolchain)
- **Rust**: `winget install Rustlang.Rustup`
- **MSVC C++ build tools** (provides `link.exe` + Windows SDK, required by Rust's msvc target):
  `winget install Microsoft.VisualStudio.2022.BuildTools --override "--passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`

PyInstaller is installed automatically into `.tools\venv` on first run.

```powershell
.\scripts\build-desktop.ps1      # Windows -> src-tauri\target\release\bundle\nsis\*.exe
./scripts/build-desktop.sh       # Linux   -> .deb / .rpm
```

All targets at once (Windows `.exe` + Linux `.deb`/`.rpm`): push a `v*` tag — GitHub Actions
(`.github/workflows/release.yml`) builds them per-OS and attaches them to a draft Release.

### Web app image (Docker — production)

Multi-stage `deploy/Containerfile` builds the frontend and serves API + UI on a single port:

```bash
docker compose -f deploy/compose.yaml up --build -d   # or: podman compose -f deploy/compose.yaml up --build -d
```

Then open **http://localhost:8000**.

## Features

**Library / culling**
- Grid and loupe views (pre-generated JPEG previews — RAW is never decoded on the fly)
- Star ratings, pick/reject flags, color labels, filters, and sort orders
- Drag-and-drop import with hash-based deduplication; supports CR2/CR3, NEF, ARW, RAF, ORF, RW2, DNG and JPEG/PNG/TIFF

**Development (non-destructive)**
- White balance, exposure, contrast, highlights/shadows, whites/blacks
- Tone curve, 8-band HSL, vibrance/saturation, clarity, dehaze
- Sharpening, noise reduction, vignette, grain
- Crop, straighten, rotation, flip
- **Local adjustments**: linear gradient, radial filter, brush (with invert and feather)
- Real-time histogram, clipping warnings, before/after toggle, copy/paste settings,
  undo/redo, built-in and custom presets, auto adjustments

**Export**
- JPEG / PNG / TIFF, full resolution or resized, batch export
- Exported files are written to `./data/exports`

## Keyboard shortcuts

| Key | Action |
|---|---|
| G / E / D | Grid / Loupe / Develop |
| ← / → | Previous / next photo |
| 0–5 · P/X/U · 6–9 | Rating · flag · color label |
| Space or Z | Fit ↔ 100 % zoom |
| `\` | Before / after |
| R · O · J | Crop tool · mask overlay · clipping |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| Ctrl+E | Export |
| ? | Full shortcut help |

## Architecture

- **FastAPI + SQLite**: catalog and REST API; FastAPI also serves the built frontend (single port).
- **rawpy (LibRaw) + NumPy/OpenCV**: RAW is decoded at full resolution only on import
  (embedded JPEG extracted for thumbnails) and on export. During development, the pipeline
  replays adjustments on a cached 2560 px base (~100–300 ms per slider move).
- **React + Zustand**: non-destructive editing — settings are stored as JSON per photo in the database.

## Running tests

```powershell
# Backend
.tools\venv\Scripts\python.exe -m pytest backend/tests

# Frontend
.tools\node\npm.cmd --prefix frontend test
```
