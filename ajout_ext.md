# Extension « Tri intelligent » — plan d'implémentation (sidecar, pas une fusion)

> Document préparé depuis une session Claude sur le repo **TriZero** (`C:\Users\ilias\TriZero`),
> qui contient une implémentation de référence complète et déjà vérifiée en direct (backend lancé,
> endpoints testés au curl, UI pilotée au navigateur). Aucune ligne de RawZero n'a été modifiée
> pour produire ce plan.

## Principe : une extension, pas une fusion

Une première version de ce document proposait de monter des routeurs dans `main.py`, d'ajouter des
colonnes à `catalog.db` et une vue dans `store.ts`. **Ce n'est pas une extension, c'est inclure la
feature dans le logiciel de base.** Corrigé ici.

Une vraie extension est un **processus séparé** :
- **Zéro fichier de RawZero modifié.** Ni `main.py`, ni `db.py`, ni `store.ts`, ni aucun autre.
- Elle tourne sur **son propre port**, avec **sa propre base de données**.
- Elle **lit** le `catalog.db` et les previews JPEG de RawZero, elle n'y **écrit jamais**.
- Elle s'ouvre comme une appli à part (lien/raccourci vers son port), pas comme une vue injectée.

C'est exactement la philosophie que TriZero décrit lui-même dans son propre `CLAUDE.md` depuis le
départ (« en extension de RawStudio : lit directement le catalog.db et les previews JPEG de
RawStudio ») — TriZero **est déjà conçu pour ça**. Le portage consiste donc surtout à **repointer**
TriZero sur les données de RawZero, pas à réécrire ses features dans le code de RawZero.

## Architecture

```
RawZero (inchangé)                    TriZero-extension (nouveau process, nouveau port ex. :8010)
├── data/catalog.db          <──lecture── config DATA_SOURCE pointé ici
│     table photos (id, path, hash,        │
│     rating, flag, color, captured_at…)   │  lit : id, path, hash, captured_at, rating/flag/color
├── data/cache/previews/{id}.jpg <──lecture─┤  (jamais régénérées, jamais recalculées)
├── data/models/u2netp.onnx  <──lecture─────┘  (même fichier de poids, chargé indépendamment —
│                                                pas d'import du code segment.py de RawZero)
└── (aucun fichier touché)

                                        └── data/triage.db (NOUVEAU, propre à l'extension)
                                              table photo_triage(photo_id PK, blur_score, blur_basis,
                                              phash, entropy, subject_frac, is_empty)
                                              — jointure par photo_id à la volée, JAMAIS d'ALTER
                                              TABLE sur catalog.db
```

### Pourquoi une base séparée (`triage.db`) plutôt que des colonnes dans `catalog.db`

Ajouter des colonnes à `catalog.db`, même « juste des colonnes en plus », c'est déjà coupler les
deux projets : une migration RawZero future qui recrée la table, un `SELECT *` quelque part dans
RawZero qui verrait apparaître des colonnes inconnues, etc. Avec `triage.db` séparée, RawZero ne
sait même pas que l'extension existe. La jointure `photo_id` se fait côté extension, en mémoire ou
via `ATTACH DATABASE` SQLite en lecture.

### Pourquoi lecture seule sur `catalog.db`

RawZero n'a **pas** de corbeille réversible — `DELETE /api/photos/{id}` supprime la ligne (et
optionnellement le fichier) directement, sans repli. C'est une différence de philosophie avec
TriZero (qui a une corbeille non-destructive). En v1, l'extension ne doit **jamais** écrire dans
`catalog.db` : elle affiche des suggestions (« ces 4 photos sont quasi-identiques, garde la plus
nette », « ces 6 sont floues »), et c'est l'utilisateur qui applique note/flag/suppression **dans
RawZero lui-même**. Aucun risque de corrompre le catalogue de RawZero depuis l'extension.
(Une écriture optionnelle vers `rating`/`flag`/`color` — colonnes déjà compatibles avec le schéma
TriZero — pourrait être envisagée en v2, avec le consentement explicite de l'utilisateur à chaque
action, jamais en masse.)

## Ce que l'extension réutilise de TriZero (quasi tel quel)

TriZero est déjà un service autonome avec sa propre base et son propre pipeline d'analyse — la
plupart de son code n'a **pas besoin d'être réécrit**, juste reconfiguré :

- `C:\Users\ilias\TriZero\backend\app\near_dup.py` — BK-tree + union-find, autonome, copiable tel
  quel dans l'extension.
- `C:\Users\ilias\TriZero\backend\app\previews.py` — `_get_face_cascade`, `_get_u2net_session`,
  `_saliency_map`, `_blur_from`, `_entropy`, `_empty_from`, `analyze_photo`, `compute_phash`.
  **Gardés tels quels** (y compris son propre chargeur ONNX — pas d'import de `segment.py` de
  RawZero, l'extension est un process séparé). Seul changement : `U2NET_PATH` pointe vers
  `<data RawZero>/models/u2netp.onnx` au lieu de télécharger son propre exemplaire — même fichier
  de poids, lu en lecture seule, zéro couplage de code.
- `C:\Users\ilias\TriZero\backend\app\routers\near_duplicates.py` — logique burst/similar,
  dismiss, analyze : reprise telle quelle, adaptée pour lire `photos.path`/`photos.hash` de
  RawZero au lieu de ses propres colonnes `relpath`.
- `C:\Users\ilias\TriZero\frontend\src\components\BlurPanel.tsx`, `NearDuplicatesPanel.tsx`,
  `EmptyPanel.tsx` — UI de référence, réutilisable presque telle quelle (l'extension a son propre
  frontend, servi sur son propre port).
- Mémoires TriZero (même compte) : `blur-subject-based`, `near-duplicates-design`,
  `empty-photos-design` — le raisonnement design derrière les seuils déjà tranchés.

Ce qui change par rapport à TriZero autonome : au lieu de son propre `POST /import/folder` qui
scanne un dossier et copie/catalogue les photos, l'extension **lit directement** la table `photos`
existante de `catalog.db` (RawZero fait déjà l'import, le hachage, l'EXIF, les previews — aucune
raison de dupliquer ce travail).

## Plan concret

### Nouveau repo/dossier (hors de `rawzero/`, ou sous-dossier clairement séparé type `rawzero-triage/`)

- `config.py` : `RAWZERO_DATA_DIR` (env, obligatoire) → dérive `RAWZERO_CATALOG_DB`,
  `RAWZERO_PREVIEWS_DIR`, `RAWZERO_MODELS_DIR`. `TRIAGE_DB_PATH` (propre à l'extension, ex.
  `<data>/triage.db` ou un dossier séparé au choix).
- `db.py` : ouvre `catalog.db` de RawZero **en lecture seule** (`sqlite3.connect(f"file:{path}?
  mode=ro", uri=True)` — refuse toute écriture même par erreur de code) + `triage.db` en
  lecture/écriture pour ses propres colonnes.
- `previews.py`, `near_dup.py` : quasi copie de TriZero (voir ci-dessus).
- `routers/triage.py` :
  - `POST /api/analyze` — pour chaque `photo_id` de `catalog.db` sans ligne dans `photo_triage`,
    calcule blur/phash/empty à partir de la preview déjà là, insère dans `triage.db`.
  - `GET /api/near-duplicates?threshold=`, `POST /api/near-duplicates/dismiss`,
    `GET /api/blurry?threshold=`, `GET /api/empty` — mêmes contrats que la version autonome de
    TriZero, mais les métadonnées (filename, path, captured_at, rating actuel…) viennent d'un
    `JOIN` en mémoire entre `catalog.db` (lecture seule) et `triage.db`.
  - Chaque item retourné inclut le `photo_id` RawZero — l'UI peut proposer un lien/deep-link vers
    `rawzero://...` ou juste afficher l'info pour que l'utilisateur aille agir dans RawZero.
- `requirements.txt` : `fastapi`, `uvicorn`, `opencv-python-headless`, `numpy`, `pillow`,
  `imagehash`, `onnxruntime` — indépendant de celui de RawZero (pas de version à synchroniser).
- Frontend : petite SPA React/Vite autonome (ou même juste les 3 panels + un shell minimal),
  servie sur son propre port (ex. `:8010` back, `:5180` dev front) — pas de dépendance au frontend
  RawZero.
- Lancement : son propre `start.ps1` (ou juste `uvicorn app.main:app --port 8010`), avec
  `RAWZERO_DATA_DIR` pointé vers le dossier `data/` de l'installation RawZero locale.

### Intégration UI (optionnelle, la plus légère possible)

Pas nécessaire pour que ça fonctionne — les deux apps sont indépendantes, ouvrables dans deux
onglets. Si une intégration est souhaitée plus tard, la plus légère possible : **un seul lien**
quelque part dans RawZero (menu ou aide) qui ouvre `http://localhost:8010` dans un nouvel onglet.
Une ligne de JSX, zéro dépendance côté RawZero à l'extension elle-même — si l'extension n'est pas
lancée, le lien échoue simplement (dégradation propre).

## Ordre d'implémentation suggéré

1. **Squelette** : `config.py`/`db.py` qui lit `catalog.db` de RawZero en lecture seule + liste les
   photos (vérifier que la lecture cross-process pendant que RawZero tourne fonctionne bien en
   WAL — normalement oui, SQLite WAL autorise plusieurs lecteurs concurrents).
2. **Quasi-doublons + rafales** — la feature la plus autonome, aucune dépendance au modèle U²-Net.
3. **Flou basé sujet** — nécessite de charger `u2netp.onnx` depuis le dossier `models/` de RawZero ;
   vérifier d'abord qu'il y est déjà (normalement oui, RawZero l'utilise pour ses masques IA).
4. **Photos vides** — réutilise la même carte de saillance que (3).

## Hors périmètre pour cette itération

Qualité (exposition/yeux fermés), regroupement par visage, carte GPS, recherche sémantique CLIP,
écriture vers `catalog.db` (rating/flag automatique) : à reprendre seulement sur demande explicite,
une fois le sidecar en lecture seule validé à l'usage.

## Vérification attendue avant de considérer la branche prête

Lancer réellement les deux apps en parallèle (RawZero sur :8000, l'extension sur :8010) et vérifier
au curl que la lecture de `catalog.db` en lecture seule fonctionne pendant que RawZero écrit dedans
(éditer une photo dans RawZero, relancer `POST /api/analyze` côté extension, confirmer qu'aucun
verrou/erreur n'apparaît). Ne pas se fier à la seule relecture du code — sur TriZero, deux bugs
réels (un type numpy non casté corrompant une colonne SQLite, un mauvais placeholder SQL
`IN (...)`) n'ont été trouvés qu'en testant en direct.
