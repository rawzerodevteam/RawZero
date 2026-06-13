# Plan d'amélioration RawStudio

> État des lieux (juin 2026) : code sain (~4 000 lignes, aucun TODO/FIXME en suspens,
> 49 tests backend verts). Ce plan vise l'évolution du produit plutôt que du rattrapage
> technique.

## Axe 1 — Consolidation (faire confiance à ce qui existe)

1. **Valider le lancement `start.ps1` sur une machine tierce** — vérifier que le script
   guide correctement un utilisateur qui n'a pas encore `.tools/` configuré.
2. ~~**Tests frontend**~~ ✅ **Fait (10 juin 2026)** — Vitest + jsdom, 43 tests dans
   `frontend/tests/` (store : undo/redo, drag, copier/coller, navigation, sauvegarde
   différée ; raccourcis clavier ; `mergeEdits`). A révélé et corrigé un bug :
   une courbe à moins de 2 points n'était pas rejetée par `mergeEdits`.
   Lancer : `npm test` dans `frontend/`.
3. **Jeu d'essai RAW réel** — ajouter quelques RAW de marques différentes (CR3, NEF,
   ARW, fichier corrompu, RAW sans JPEG embarqué) dans une suite de tests d'intégration
   optionnelle, pour couvrir les cas que les tests synthétiques ne voient pas.

## Axe 2 — Qualité d'image (différenciant pour un éditeur RAW)

4. **Correction d'objectif (lensfun)** — distorsion, vignettage et aberrations
   chromatiques automatiques d'après l'EXIF. C'est la fonctionnalité la plus attendue
   qui manque face à Lightroom/Darktable.
5. **Courbes par canal RGB** — extension naturelle du `CurveEditor` existant
   (la spline PCHIP est déjà là, il faut surtout l'UI de sélection de canal).
6. **Masques par plage de luminance/couleur** — complète les masques géométriques
   actuels ; s'insère dans `masks.py` et le mini-pipeline local existant.
7. **Espace de travail couleur** — aujourd'hui tout le pipeline opère en sRGB ;
   passer le cœur en linéaire/ProPhoto avec conversion finale améliorerait les hautes
   lumières et les dégradés (chantier plus lourd, à planifier en dernier de cet axe).

## Axe 3 — Organisation de la bibliothèque

8. **Albums/collections** — 🚧 **En cours (arrêté le 10 juin 2026 au soir)**.
   Fait : schéma DB (`albums`, `album_photos` avec FK `ON DELETE CASCADE`,
   `PRAGMA foreign_keys=ON`, helper `db.executemany`) — 49 tests backend toujours verts.
   Reste à faire, dans l'ordre :
   1. `backend/app/routers/albums.py` : GET/POST/PATCH/DELETE `/api/albums`,
      POST `/api/albums/{id}/photos` {ids} (ajout, INSERT OR IGNORE),
      DELETE `/api/albums/{id}/photos/{photo_id}` ; enregistrer le router dans `main.py`.
   2. Filtre `album_id` sur GET `/api/photos` (JOIN `album_photos`).
   3. Frontend : `api.ts` (CRUD albums), store (liste + filtre album courant),
      sélecteur d'album dans la Toolbar de `LibraryView` + action "ajouter à l'album".
   4. Tests backend (CRUD album, filtre, cascade à la suppression de photo).
9. **Recherche/filtres EXIF** — filtrer par boîtier, objectif, plage ISO/focale/date ;
   les colonnes existent déjà en base, il manque les paramètres d'API et l'UI.
10. **Copies virtuelles** — plusieurs jeux d'edits pour un même fichier (variante N&B
    + couleur). Le modèle non-destructif actuel s'y prête bien : une ligne `photos`
    supplémentaire pointant vers le même hash/fichier.

## Axe 4 — Performance et robustesse

11. **Rendu interactif progressif** — pendant le mouvement d'un slider, rendre à
    ~1280px puis raffiner à 2560px au relâchement, pour passer sous les 100 ms perçus.
12. **File d'import avec progression** — l'import de gros dossiers gagnerait une
    progression par fichier (SSE ou polling) et une reprise sur erreur, plutôt qu'une
    requête bloquante.
13. **Historique persistant des étapes** — journal des edits en base (au-delà de
    l'undo/redo en mémoire), qui survit au rechargement de la page.

## Axe 5 — Finitions UX

14. **Avant/après côte à côte** (en plus du basculement `\`), comparaison de deux
    photos en loupe (mode "survey").
15. **Export enrichi** — filigrane, renommage par motif, profil de sortie
    (sRGB/AdobeRGB) ; extensions simples de `export.py` + `ExportDialog`.
16. **Écrêtage par canal** dans l'histogramme (actuellement luma + RGB globaux).

## Où on en est (10 juin 2026, soir)

- ✅ Item 2 (tests frontend) : terminé, 43 tests Vitest verts + bug `mergeEdits` corrigé.
- ⏸ Items 1 et 3 : bloqués (machine tierce / vrais fichiers RAW à fournir).
- 🚧 Item 8 (albums) : schéma DB fait, **reprendre au routeur API** (détail dans l'item 8).
- Ensuite, dans l'ordre demandé : item 9 (filtres EXIF), puis item 15 (export enrichi).

## Ordre suggéré

| Priorité | Items | Pourquoi d'abord |
|---|---|---|
| 1 | Docker (1), tests frontend (2) | Sécuriser l'existant avant d'empiler |
| 2 | Albums (8), filtres EXIF (9), export enrichi (15) | Gains rapides, peu de risque |
| 3 | Lensfun (4), courbes RGB (5), masques luminance (6) | Cœur métier, valeur différenciante |
| 4 | Copies virtuelles (10), rendu progressif (11), historique (13) | Plus structurants, à faire sur une base testée |
| 5 | Espace couleur élargi (7) | Le plus invasif, à isoler |

## Point d'attention transversal

`pipeline.py` (463 lignes) et `ImageViewer.tsx` (386 lignes) sont les deux plus gros
fichiers et concentreront la plupart de ces chantiers. Si les axes 2 et 4 sont lancés,
prévoir de les découper avant (par ex. `pipeline/` en modules tonalité/couleur/détail,
et extraire la logique crop/masques du viewer).
