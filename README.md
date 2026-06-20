# RawStudio

A local, non-destructive **RAW photo editor** in the browser — inspired by Lightroom / Darktable.  
Runs via a single PowerShell script (Windows, no Docker) **or** as a container (Podman / Docker).

## Quick start

```powershell
.\start.ps1
```

Then open **http://localhost:8000**.

### Run with Podman (or Docker)

A multi-stage `Containerfile` builds the frontend and serves API + UI on one port.

```bash
# build + run with compose
podman compose up --build -d        # or: docker compose up --build -d

# …or build and run by hand
podman build -t rawstudio .
podman run -d --name rawstudio -p 8000:8000 \
  -v ./data:/data:Z -v ./import:/import:Z rawstudio
```

Then open **http://localhost:8000**. The catalog/caches/exports live in `./data`
and importable files go in `./import` (both bind-mounted, so they persist).
AI models (subject/click masks, denoise) go in `./data/models` — without them
those features are simply hidden.

- The catalog, imported originals, caches, and exports are stored in `./data`.
- To import large folders without going through the browser: drop your files into `./import`,
  then use **Import → /import folder** in the app.

### Options

| Flag | Effect |
|---|---|
| `-Dev` | Backend with `--reload` + Vite hot reload on `:5173` |
| `-Rebuild` | Force a frontend rebuild before serving |

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
# Backend (49 tests)
.\.tools\python\python.exe -m pytest backend/tests

# Frontend (43 tests)
cd frontend && node ..\\.tools\node\node.exe ..\\.tools\node_modules\.bin\vitest run
```
