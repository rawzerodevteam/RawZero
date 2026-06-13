# RawStudio — Éditeur photo RAW (type Lightroom / Darktable)

> Ce fichier est la source de vérité du projet : architecture, décisions, état d'avancement.
> Il est mis à jour au fur et à mesure du développement.

## 1. Vision

Application web locale de retouche photo RAW, non-destructive :
- **Mode Bibliothèque / Tri** : grille + loupe rapide (previews JPEG pré-générés, jamais de décodage RAW à la volée), notation par étoiles, drapeaux, labels couleur, filtres.
- **Mode Développement** : pipeline de retouche complet (exposition, balance des blancs, courbes, HSL, netteté, réduction de bruit, vignettage, recadrage…) + **retouches locales** par masques (dégradé linéaire, radial, pinceau).
- **Import** propre (upload navigateur ou dossier local), stockage local dans l'app, **export** JPEG / PNG / TIFF pleine résolution.
- Raccourcis clavier standards des logiciels photo.
- Lancement via `start.ps1` (outillage portable `.tools/`, pas de Docker requis).

## 2. Stack technique (décisions)

| Composant | Choix | Pourquoi |
|---|---|---|
| Backend | Python 3.12 + FastAPI | Écosystème image inégalé en Python |
| Décodage RAW | `rawpy` (bindings LibRaw) | Supporte CR2/CR3/NEF/ARW/RAF/ORF/RW2/DNG…, wheels précompilés |
| Traitement | NumPy + OpenCV (headless) + Pillow | Pipeline vectorisé float32, rapide sur preview 2560px |
| EXIF | `exifread` + Pillow | Métadonnées des RAW TIFF-based et JPEG |
| Base de données | SQLite (WAL) | Catalogue local, zéro service externe |
| Frontend | React 18 + TypeScript + Vite + Zustand | SPA réactive, store simple |
| UI | CSS custom, thème sombre | Look Lightroom, pas de lib UI lourde |
| Lancement | `start.ps1` (portable, outillage dans `.tools/`) | FastAPI sert l'API **et** le frontend buildé → un seul port (8000) |

**Principe clé de performance** (le "point bonus") : le RAW n'est décodé en pleine résolution **qu'à l'import (preview) et à l'export**.
- À l'import : extraction du JPEG embarqué du RAW (quasi instantané) → vignette 320px + preview 2048px. Le mode tri n'affiche que ces JPEG.
- En développement : décodage RAW une fois → cache disque "base de développement" 2560px en float16 (`.npy`) + cache mémoire LRU. Chaque mouvement de slider ne fait que rejouer le pipeline NumPy sur cette base (~100-300 ms).
- À l'export : décodage pleine résolution + même pipeline → fidélité garantie (les rayons de netteté/flou sont mis à l'échelle).

## 3. Arborescence

```
rawstudio/
├── CLAUDE.md                  # Ce fichier
├── README.md                  # Doc utilisateur
├── start.ps1                  # Lancement local (portable, sans Docker)
├── .gitignore
├── backend/
│   ├── requirements.txt
│   ├── app/
│   │   ├── main.py            # App FastAPI, montage routers + statiques
│   │   ├── config.py          # Chemins (DATA_DIR, IMPORT_DIR) via env
│   │   ├── db.py              # SQLite : schéma, helpers, lock écriture
│   │   ├── raw_loader.py      # Décodage RAW/JPEG/PNG/TIFF, thumb embarqué, EXIF
│   │   ├── pipeline.py        # LE cœur : tous les réglages, ordre des opérations
│   │   ├── masks.py           # Rasterisation masques locaux (linéaire/radial/pinceau)
│   │   ├── previews.py        # Génération thumbs/previews + cache base npy + regen async
│   │   └── routers/
│   │       ├── photos.py      # Liste, méta, note/drapeau/label, suppression
│   │       ├── imports.py     # Upload multipart + import depuis /import monté
│   │       ├── render.py      # Rendu interactif (edits → JPEG), thumb, preview, original
│   │       ├── edits.py       # Sauvegarde edits, auto-réglages, presets
│   │       └── export.py      # Export JPEG/PNG/TIFF pleine résolution
│   └── tests/
│       ├── test_pipeline.py   # Neutralité, bornes, monotonie, masques
│       └── test_api.py        # Import → edit → render → export bout en bout
├── frontend/
│   ├── package.json / tsconfig.json / vite.config.ts / vitest.config.ts / index.html
│   ├── tests/                 # Vitest (jsdom) : store, raccourcis, mergeEdits
│   └── src/
│       ├── main.tsx, App.tsx  # Bascule de vue par état Zustand (grid/loupe/develop) + raccourcis globaux
│       ├── api.ts             # Client HTTP typé
│       ├── types.ts           # EditState, Photo, défauts
│       ├── store.ts           # Zustand : photos, filtres, edits, undo/redo, UI
│       ├── shortcuts.ts       # Gestion clavier centralisée
│       ├── styles.css         # Thème sombre complet
│       ├── components/        # Slider, Histogram, Filmstrip, ImageViewer (zoom/pan/crop/masques),
│       │                      # CurveEditor, StarRating, ExportDialog, ImportPanel, ShortcutsOverlay…
│       ├── views/             # LibraryView (grille + loupe), DevelopView
│       └── panels/            # Basic, ToneCurve, HSL, Detail, Effects, Geometry, Local, Meta
└── data/                      # originals/, cache/{thumbs,previews,base}/, exports/, catalog.db
```

## 4. Modèle de données (SQLite)

```sql
photos(
  id INTEGER PK, filename, relpath, hash UNIQUE,        -- déduplication à l'import
  ext, is_raw, width, height,
  captured_at, imported_at,
  camera, lens, iso, aperture, shutter, focal,          -- EXIF
  rating INT 0-5, flag TEXT 'none'|'pick'|'reject',
  color TEXT ''|red|yellow|green|blue|purple,
  edits TEXT JSON                                        -- état de développement non-destructif
)
presets(id PK, name, settings JSON, builtin INT)
albums(id PK, name UNIQUE, created_at)                   -- collections (en cours, item 8 AMELIORATION.md)
album_photos(album_id FK CASCADE, photo_id FK CASCADE, PK(album_id, photo_id))
```

`PRAGMA foreign_keys=ON` est activé sur la connexion (cascades album_photos).

Les edits ne touchent **jamais** l'original (édition non-destructive, comme les sidecars XMP).

## 5. Pipeline de traitement (ordre des opérations)

Entrée : float32 RGB 0..1 (sRGB) issu du décodage. `scale` = ratio rendu/pleine-résolution
(pour adapter les rayons de netteté/clarté/NR).

1. **Géométrie** : rotation 90°, miroirs, redressement (angle fin + auto-crop), recadrage.
   → Tout le reste opère dans l'espace "affiché" ; les masques locaux sont en coordonnées normalisées de l'image recadrée.
2. **Espace linéaire** : balance des blancs (température/teinte), **exposition** (2^EV).
3. **Tonalité** : hautes lumières / ombres (masques de luminance floutés → pas de halos),
   blancs / noirs (points blanc/noir), contraste, **courbe de tonalité** (spline monotone PCHIP → LUT).
4. **Couleur** : HSL 8 bandes (rouge, orange, jaune, vert, aqua, bleu, violet, magenta — teinte/sat/luminance par bande), vibrance (protège les tons déjà saturés), saturation.
5. **Présence** : clarté (contraste local sur luminance), dehaze (dark channel prior simplifié).
6. **Retouches locales** : pour chaque masque (linéaire / radial / pinceau, inversible, feather)
   → mini-pipeline (expo, contraste, HL/ombres, temp/teinte, saturation, clarté, netteté) fondu par le masque.
7. **Détail** : réduction de bruit (bilatéral luminance + lissage chroma), **netteté** (masque flou, amount/radius).
8. **Effets** : vignettage (post-crop), grain.
9. Clip → uint8 / JPEG.

## 6. API REST

```
GET    /api/photos?min_rating=&flag=&color=&sort=        liste filtrée
GET    /api/photos/{id}                                  méta + edits
PATCH  /api/photos/{id}            {rating|flag|color}
DELETE /api/photos/{id}?delete_file=
POST   /api/import/upload          multipart             import navigateur
GET    /api/import/browse?path=                          parcourir /import monté
POST   /api/import/folder          {paths}               import depuis le montage
GET    /api/photos/{id}/thumb|preview|original           JPEG cache / fichier source
POST   /api/photos/{id}/render?max_size=&show_mask=      edits → JPEG (interactif)
PUT    /api/photos/{id}/edits                            sauvegarde + regen thumbs async
POST   /api/photos/{id}/auto                             auto exposition + auto WB
GET/POST/DELETE /api/presets                             presets (filtres globaux)
POST   /api/export                 {ids, format, quality, max_size} → fichiers dans data/exports + URLs
GET    /api/version, /api/health
```

## 7. UI & Raccourcis clavier

Trois modes : **Grille (G)** → **Loupe/Tri (E)** → **Développement (D)**.

| Touche | Action |
|---|---|
| ← / → | Photo précédente / suivante (partout) |
| 0–5 | Note en étoiles |
| P / X / U | Drapeau retenue / rejet / neutre |
| 6 7 8 9 | Label couleur (rouge, jaune, vert, bleu) |
| G / E / D | Grille / Loupe / Développement |
| Espace ou Z | Zoom ajusté ↔ 100 % (puis glisser pour naviguer dans l'image) |
| \ | Avant / Après |
| J | Alertes d'écrêtage (hautes lumières / ombres) |
| R | Outil recadrage |
| O | Afficher le masque local sélectionné |
| Ctrl+Z / Ctrl+Shift+Z | Annuler / Rétablir |
| Ctrl+Shift+C / Ctrl+Shift+V | Copier / coller les réglages |
| Ctrl+E | Export |
| I | Infos EXIF en surimpression |
| ? | Aide raccourcis |
| Suppr | Retirer du catalogue (confirmation) |

Panneau droit (développement) : Histogramme (RGB + luma, écrêtage), Basique (WB, expo, contraste, HL, ombres, blancs, noirs, clarté, dehaze, vibrance, saturation), Courbe, HSL, Détail, Effets, Géométrie, Local, Presets, EXIF.

## 8. Fonctionnalités bonus (non demandées mais standards du domaine)

- [x] Histogramme temps réel + alertes d'écrêtage
- [x] Avant/après, copier/coller de réglages entre photos, réinitialisation par section
- [x] Undo/redo complet par photo
- [x] **Presets** ("filtres" globaux) : intégrés (N&B contrasté, Vivid, Film doux, …) + presets utilisateur
- [x] Auto-réglages (exposition + balance des blancs en un clic)
- [x] Déduplication à l'import (hash), classement par date EXIF
- [x] Double-clic sur un slider = reset ; molette de réglage fin
- [x] Filtres de tri : note minimale, drapeau, label, ordre
- [x] Panneau EXIF complet
- [x] Export par lot avec redimensionnement et qualité
- Pistes futures (non implémenté) : albums/collections, copies virtuelles, correction d'objectif (lensfun), courbes par canal RGB, tethering, géolocalisation, masques par plage de luminance/couleur, historique persistant des étapes.

## 9. Lancement local

- Outillage portable dans `.tools/` : uv + Python 3.12 isolé, Node 22 zip.
- Variables d'environnement : `DATA_DIR` (défaut `./data`), `IMPORT_DIR` (défaut `./import`).
- Démarrage : `.\start.ps1` → http://localhost:8000
  - `-Dev` : backend `--reload` + Vite hot reload sur :5173
  - `-Rebuild` : force le rebuild du frontend avant de servir

## 10. État d'avancement

- [x] Plan & architecture
- [x] Backend : config, DB, chargeur RAW, previews
- [x] Backend : pipeline de traitement complet
- [x] Backend : masques locaux
- [x] Backend : routes API (photos, import, render, edits, presets, export)
- [x] Backend : tests (pipeline + API bout en bout) — 49 tests verts
- [x] Frontend : socle (Vite/TS, store, API, vues par état Zustand, raccourcis, thème)
- [x] Frontend : Bibliothèque (grille, loupe, tri, filtres, import upload + dossier /import)
- [x] Frontend : Développement (viewer zoom/pan, panneaux, courbe, HSL, crop, masques locaux)
- [x] Frontend : histogramme, avant/après, écrêtage, export, presets, aide
- [x] Frontend : tests Vitest (store, raccourcis, mergeEdits) — 43 tests verts ;
      a révélé et corrigé un bug mergeEdits (courbe < 2 points non rejetée)
- [x] Vérification : 49 tests backend verts, build frontend OK (tsc + vite),
      smoke test serveur réel (health, SPA statique, import → render → export → thumb)
- [ ] **En cours — plan AMELIORATION.md, priorité 2** (albums → filtres EXIF → export
      enrichi, dans cet ordre). Albums : schéma DB fait (tables + FK + executemany),
      **reprendre à `routers/albums.py`** ; détail des étapes restantes dans
      AMELIORATION.md item 8.

## 11. Notes de développement

- Poste de dev sans Python/Node système → outillage **portable** dans `.tools/`
  (uv + Python isolé, Node zip) ; ce dossier est jetable et ignoré par git.
- Le rendu interactif renvoie le JPEG du pipeline ; le client annule les requêtes
  obsolètes (AbortController) et débounce les sliders (~120 ms).
- Les thumbs/previews sont régénérés en tâche de fond après sauvegarde des edits,
  pour que la grille reflète les retouches.
- `rawpy.postprocess(use_camera_wb=True, no_auto_bright=True, output_bps=16)` comme base neutre.
- Fichiers non-RAW (JPEG/PNG/TIFF) acceptés à l'import : même pipeline, base = fichier décodé.
