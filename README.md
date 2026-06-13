# RawStudio

Éditeur photo **RAW** local, non destructif, dans le navigateur — façon Lightroom / Darktable.
Une seule dépendance : **Docker**.

## Démarrage rapide

```bash
docker compose up -d --build
```

Puis ouvrir **http://localhost:8000**.

- Le catalogue, les originaux importés, les caches et les exports sont persistés dans `./data`.
- Pour importer de gros dossiers sans passer par le navigateur : déposez vos fichiers dans
  `./import` (monté en lecture seule), puis dans l'app **Importer → Dossier /import**.
  Le chemin est surchargeable : `IMPORT_PATH=/mes/photos docker compose up -d`.

## Fonctionnalités

**Bibliothèque / tri**
- Grille et loupe rapides (previews JPEG pré-générés — jamais de décodage RAW à la volée)
- Notes ★, drapeaux retenue/rejet, labels couleur, filtres et tris
- Import par glisser-déposer (déduplication par hash) ; formats RAW courants
  (CR2/CR3, NEF, ARW, RAF, ORF, RW2, DNG…) et JPEG/PNG/TIFF

**Développement (non destructif)**
- Balance des blancs, exposition, contraste, hautes lumières/ombres, blancs/noirs
- Courbe de tonalité, HSL 8 bandes, vibrance/saturation, clarté, dehaze
- Netteté, réduction de bruit, vignettage, grain
- Recadrage, redressement, rotation, miroirs
- **Retouches locales** : dégradé linéaire, filtre radial, pinceau (inversibles, contour progressif)
- Histogramme temps réel, alertes d'écrêtage, avant/après, copier/coller de réglages,
  undo/redo, presets intégrés et personnels, auto-réglages

**Export**
- JPEG / PNG / TIFF, pleine résolution ou redimensionné, par lot
- Les fichiers exportés sont aussi écrits dans `./data/exports`

## Raccourcis clavier (principaux)

| Touche | Action |
|---|---|
| G / E / D | Grille / Loupe / Développement |
| ← / → | Photo précédente / suivante |
| 0–5 · P/X/U · 6–9 | Note · drapeau · label couleur |
| Espace ou Z | Zoom ajusté ↔ 100 % |
| \\ | Avant / après |
| R · O · J | Recadrage · masque · écrêtage |
| Ctrl+Z / Ctrl+Shift+Z | Annuler / rétablir |
| Ctrl+E | Exporter |
| ? | Aide complète |

## Développement (sans Docker)

```bash
# backend
cd backend
pip install -r requirements-dev.txt
uvicorn app.main:app --reload --port 8000

# frontend (autre terminal)
cd frontend
npm install
npm run dev          # http://localhost:5173, proxy API vers :8000
```

Tests backend : `cd backend && pytest`.

## Architecture (résumé)

- **FastAPI + SQLite** : catalogue et API ; le conteneur sert aussi le frontend buildé (un seul port).
- **rawpy (LibRaw) + NumPy/OpenCV** : le RAW n'est décodé en pleine résolution qu'à l'import
  (extraction du JPEG embarqué pour les vignettes) et à l'export. En développement, le pipeline
  rejoue les réglages sur une base 2560 px mise en cache (~100–300 ms par mouvement de slider).
- **React + Zustand** : édition non destructive, les réglages sont un JSON par photo en base.

Détails complets dans [CLAUDE.md](CLAUDE.md).
