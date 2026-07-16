# Audit RawZero — pistes d'amélioration

> Rapport d'audit indépendant réalisé par relecture intégrale du code (backend Python/FastAPI,
> frontend React/TS, pipeline image, config Tauri). Chaque piste est classée par **gravité**
> (🟢 Faible · 🟡 Moyen · 🟠 Élevé · 🔴 Critique) avec une estimation de **l'ampleur** (nombre de
> modifications) et de **l'impact** (sécurité, fidélité photo, UX, perf, maintenabilité).
>
> Périmètre relu : `backend/app/*` (pipeline, db, previews, masks, config, main, denoise, models,
> routers), `frontend/src/*` (store, api, ImageViewer, LibraryView, DevelopView, styles.css),
> `src-tauri/` (conf, capabilities, lib.rs), `package.json`.
>
> Méthode de lecture du tableau : « ampleur » = effort de dev estimé ; « impact » = conséquence si
> non traité. Les deux ensemble donnent la priorité.

---

## Synthèse — top priorités

| # | Piste | Classe | Gravité | Ampleur | Impact |
|---|-------|--------|---------|---------|--------|
| S1 | CORS `*` + navigation disque complète sans auth | Sécurité | 🟠 Élevé | Faible | Exfiltration/altération de fichiers via page web malveillante |
| P1 | Export sans EXIF / sans profil ICC / TIFF 8-bit | Photo | 🟠 Élevé | Moyenne | Perte de métadonnées & précision inacceptable pour un usage pro |
| S2 | Tauri `csp: null` (aucune CSP) | Sécurité | 🟡 Moyen | Faible | Surface XSS dans l'app packagée |
| B1 | `data/exports/` jamais purgé | Backend | 🟡 Moyen | Faible | Le disque se remplit indéfiniment |
| V1 | Chaînes non internationalisées dans le store | Visuel/UX | 🟡 Moyen | Faible | Textes FR figés en anglais/autre langue |
| A1 | Accessibilité : focus, aria-live, contraste | Visuel/UX | 🟡 Moyen | Moyenne | Inutilisable au clavier/lecteur d'écran |
| P2 | Récupération des hautes lumières RAW impossible | Photo | 🟡 Moyen | Moyenne | Le curseur HL ne « rattrape » pas les blancs cramés |

---

## 1. Sécurité

### 🟠 S1 — CORS grand ouvert + endpoints de navigation/écriture disque sans authentification
**Fichiers** : [`backend/app/main.py:27-33`](backend/app/main.py#L27-L33), [`backend/app/routers/imports.py:94-128`](backend/app/routers/imports.py#L94-L128)

Le serveur autorise **toutes** les origines (`allow_origins=["*"]`, `allow_methods=["*"]`) et
n'a aucune authentification. Or il expose :
- `GET /api/import/browse?path=C:\` → **arborescence complète du disque** de l'utilisateur ;
- `POST /api/import/folder` → référence/importe des chemins arbitraires ;
- `DELETE /api/photos/{id}?delete_file=true` → **supprime des fichiers** de l'original ;
- `POST /api/export` → **écrit des fichiers** dans `data/exports`.

Le serveur écoute sur `127.0.0.1` (uvicorn par défaut, confirmé dans `start.ps1` et
`src-tauri/src/lib.rs:13`), ce qui **bloque l'accès distant** — c'est la circonstance atténuante
qui fait passer ceci d'« Critique » à « Élevé ». Mais tant que l'app tourne, **n'importe quelle
page web** ouverte dans le navigateur peut faire `fetch("http://localhost:8000/api/import/browse?path=C:\\Users")`
et, grâce à `allow_origins=["*"]`, **lire la réponse** (cartographie du disque → repérage de
documents sensibles), voire déclencher import/suppression. C'est un vecteur classique de
*drive-by localhost* / DNS-rebinding.

**Correctifs (par ordre de robustesse)** :
1. Restreindre `allow_origins` à l'origine réelle (`http://localhost:8000` en prod, `:5173` en dev via env) au lieu de `*`.
2. Vérifier l'en-tête `Host`/`Origin` dans un middleware (rejeter tout ce qui n'est pas localhost/l'origine attendue) — protège aussi contre le DNS-rebinding.
3. Jeton de session partagé entre le sidecar et le frontend (le Tauri `lib.rs` peut le générer et l'injecter), exigé sur les routes d'écriture/navigation.

**Ampleur** : faible (≈ 20 lignes, 1 middleware). **Impact** : élevé.

### 🟡 S2 — Aucune Content-Security-Policy dans l'app Tauri
**Fichier** : [`src-tauri/tauri.conf.json:12-13`](src-tauri/tauri.conf.json#L12-L13) (`"csp": null`)

Tauri recommande explicitement de définir une CSP. À `null`, la webview n'a aucune restriction
sur les sources de scripts/styles/connexions. Dans une app qui charge des `blob:` (rendus JPEG) et
appelle une API locale, une CSP stricte est possible :
```
default-src 'self'; img-src 'self' blob: data:; connect-src 'self' http://localhost:8000; style-src 'self' 'unsafe-inline'
```
**Ampleur** : faible (1 champ). **Impact** : moyen (défense en profondeur XSS).

### 🟡 S3 — Téléchargement de modèles sans timeout réseau
**Fichier** : [`backend/app/routers/models.py:90`](backend/app/routers/models.py#L90)

`urllib.request.urlopen(url)` sans `timeout` : une connexion qui « pend » bloque le thread daemon
indéfiniment, laisse `downloading: true` de façon permanente, et **empêche tout re-téléchargement**
(le garde `409 Téléchargement déjà en cours` reste actif à vie). Le reste est **très bien fait**
(SHA-256 + taille épinglés, `.part` + rename atomique). Ajouter `timeout=30` + un moyen de
réinitialiser un téléchargement bloqué.
**Ampleur** : très faible. **Impact** : faible (robustesse).

### 🟢 S4 — Confinements de chemins : bien traités, à surveiller
Les points sensibles (`main.py:54-61` SPA fallback, `masks.py:124-125`, `edits.py:141-142/175-176`)
vérifient correctement `is_relative_to` / `MASKS_DIR in parents`. RAS, mais toute nouvelle route
servant un fichier doit reproduire ce garde. Documenté comme convention.

---

## 2. Photographie (fidélité & attentes métier)

### 🟠 P1 — Export : perte totale des métadonnées, aucun profil couleur, TIFF 8 bits
**Fichier** : [`backend/app/routers/export.py:137-146`](backend/app/routers/export.py#L137-L146)

L'export passe par `cv2.imwrite`, qui :
- **n'écrit aucun EXIF/IPTC/XMP** → le fichier exporté perd date de prise de vue, appareil,
  objectif, **droits d'auteur/copyright**, géolocalisation. Rédhibitoire pour un livrable pro.
- **n'incorpore aucun profil ICC** → les fichiers sont sRGB implicite mais non tagués ; ouverts
  dans un logiciel *color-managed*, les couleurs peuvent dériver.
- **TIFF en 8 bits** (`bgr` est `uint8`) : un TIFF est justement attendu **16 bits** pour de la
  retouche ultérieure. Ici il n'apporte rien de plus qu'un PNG.

**Correctifs** :
- Réinjecter l'EXIF de l'original (via `piexif`/`exiftool`, ou passer par Pillow avec `exif=`),
  au minimum date + appareil + objectif + copyright.
- Taguer le profil sRGB (ICC) dans le JPEG/TIFF.
- Sortir le TIFF en 16 bits (le pipeline travaille déjà en float32 → `(*65535).astype(uint16)`).
- Bonus : option de **redimensionnement respectant le ratio de crop** (déjà géré) + choix de
  l'espace de sortie (sRGB / AdobeRGB) pour l'impression.

**Ampleur** : moyenne (1 dépendance EXIF + branche 16 bits). **Impact** : élevé (usage pro).

### 🟡 P2 — Récupération des hautes lumières RAW impossible (blancs déjà écrêtés)
**Fichiers** : [`backend/app/raw_loader.py:29-37`](backend/app/raw_loader.py#L29-L37), [`pipeline.py:197-212`](backend/app/pipeline.py#L197-L212)

`rawpy.postprocess(no_auto_bright=True, output_bps=16)` sort une image **déjà bornée à blanc** ;
le pipeline travaille ensuite en 0..1 (`np.clip` partout). Conséquence : le curseur *Highlights −100*
ne peut **pas** récupérer d'information au-dessus du blanc, contrairement à Lightroom/Darktable qui
exploitent la marge du capteur (highlight headroom). Les blancs cramés restent cramés.

**Pistes** :
- Décoder en linéaire non borné (`no_auto_bright=True`, `highlight_mode`, ou travailler sur les
  données `raw.raw_image` avec le point blanc capteur) pour conserver la marge > 1.0, et ne clipper
  qu'en toute fin de pipeline.
- Au minimum, un mode de *highlight reconstruction* de LibRaw (`highlight_mode=2` reconstruction).

**Ampleur** : moyenne à forte (touche au décodage et à l'ordre du pipeline). **Impact** : moyen
(qualité perçue sur photos à forte dynamique).

### 🟡 P3 — Espace de travail incohérent : la plupart des opérations en sRGB-gamma
**Fichier** : [`backend/app/pipeline.py:511-545`](backend/app/pipeline.py#L511-L545)

Seuls WB et exposition passent en linéaire (`_apply_linear_stage`). Contraste, courbe, HL/ombres,
clarté, **HSL** (via `cv2.COLOR_RGB2HSV`), vignettage opèrent en **sRGB-gamma**. C'est un choix
pragmatique (rapide, « à la Lightroom process 2003 »), mais :
- le HSV d'OpenCV n'est pas perceptuellement uniforme → glissements de teinte visibles en forte
  saturation ;
- le contraste/vignettage en gamma assombrit différemment qu'en linéaire (halos possibles).

Ce n'est pas un bug — c'est une **limite de fidélité** à assumer et documenter. Une V2 pourrait
offrir un « working profile » linéaire optionnel pour les étages tonaux.
**Ampleur** : forte. **Impact** : moyen (fidélité fine).

### 🟡 P4 — Balance des blancs non calibrée en Kelvin
**Fichiers** : [`pipeline.py:176-180`](backend/app/pipeline.py#L176-L180), panneau Basic

`temp`/`tint` sont des gains synthétiques (`2^(0.5·t)`), pas des Kelvin. Un photographe attend un
**affichage en K** (« 5500 K ») et un point de départ « As Shot ». La base utilise `use_camera_wb=True`
(donc temp=0 ≈ tel que pris, ce qui est correct), mais il manque la lecture/écriture d'une valeur
Kelvin réelle. À défaut, afficher au moins « relatif » clairement dans l'UI.
**Ampleur** : moyenne. **Impact** : moyen (attente métier, non-régression fonctionnelle).

### 🟢 P5 — Base de dev en demi-résolution : écart net/bruit preview↔export
**Fichier** : [`previews.py:169-182`](backend/app/previews.py#L169-L182)

`decode_full(half_size=True)` pour la base : excellent pour la vitesse, mais le dématriçage
demi-résolution ne produit **pas les mêmes micro-textures/artefacts** que le plein export. Le
réglage de netteté/NR au développement peut donc légèrement différer du rendu final. Les rayons
sont mis à l'échelle (bien), mais le *contenu* haute fréquence diffère. Acceptable ; à documenter
pour l'utilisateur exigeant (ou proposer un « aperçu 100 % pleine réso » à la demande sur la zone
visible).
**Ampleur** : forte si corrigé. **Impact** : faible.

### 🟢 P6 — Détection d'écrêtage à seuils fixes ≠ histogramme
**Fichier** : [`ImageViewer.tsx:499-503`](frontend/src/components/ImageViewer.tsx#L499-L503)

L'overlay d'écrêtage teste `r>=250 && g>=250 && b>=250` (et ≤4). Un pixel écrêté sur **un seul**
canal (ex. rouge saturé) n'est pas signalé, alors que c'est justement le cas fréquent. Les pros
attendent un écrêtage **par canal**. Passer à « au moins un canal ≥ 254 » (HL) et « au moins un ≤ 1 »
(ombres), avec code couleur par canal comme Lightroom.
**Ampleur** : faible. **Impact** : faible-moyen (précision de l'aide au tri).

---

## 3. Backend (correction, robustesse, perf)

### 🟡 B1 — `data/exports/` n'est jamais nettoyé
**Fichier** : [`backend/app/routers/export.py:47-51`](backend/app/routers/export.py#L47-L51)

Chaque export crée `data/exports/AAAAMMJJ-HHMMSS/` avec des **copies pleine résolution**. Rien ne
purge jamais ces dossiers → croissance illimitée du disque (l'utilisateur exporte déjà « ailleurs »
via File System Access côté client). Pistes : purge des exports > N jours au démarrage, ou bouton
« vider les exports », ou ne pas conserver du tout si l'écriture directe navigateur a réussi.
**Ampleur** : faible. **Impact** : moyen (saturation disque à terme).

### 🟡 B2 — `photo_facets` : construction SQL fragile
**Fichier** : [`backend/app/routers/photos.py:89-91`](backend/app/routers/photos.py#L89-L91)

```python
db.query(f"SELECT DISTINCT photos.{col} AS v FROM {src} AND photos.{col} != ''", args)
```
`col` provient d'un littéral (`"camera"`/`"lens"`) → **pas d'injection**, mais le motif repose sur
le fait que `src` finit toujours par un `WHERE …` pour que le `AND …` colle. C'est un couplage
implicite qui casserait au moindre refactor de `src`. Rendre explicite (construire la clause WHERE
proprement, ou `WHERE 1=1 AND …`). **Ampleur** : très faible. **Impact** : faible (dette).

### 🟡 B3 — Robustesse : chaînes vides EXIF surdétectées, filtrage caméra/objectif partiel
**Fichier** : [`raw_loader.py:107-118`](backend/app/raw_loader.py#L107-L118)

- `meta["camera"]` : `model.startswith(make)` peut mal concaténer certains couples (ex. make
  « NIKON CORPORATION », model « NIKON D750 » → « NIKON CORPORATION NIKON D750 »). Normaliser les
  doublons de marque. **Ampleur** : faible.
- CR3/HEIF non TIFF-based : EXIF « best effort », souvent vide (documenté). Envisager `exiftool`
  optionnel comme *fallback* si présent. **Ampleur** : moyenne.

### 🟢 B4 — Concurrence DB : lecture par thread jamais fermée hors reset
**Fichier** : [`backend/app/db.py:140-158`](backend/app/db.py#L140-L158)

Une connexion SQLite est ouverte **par thread** et conservée dans `_read_conns`. Le pool de threads
FastAPI/anyio est borné → nombre de connexions borné, donc **pas de fuite réelle** en pratique. À
surveiller si un jour des threads ad-hoc (hors pool) lisent la DB. RAS aujourd'hui.

### 🟢 B5 — `apply_geometry` : `straighten` recadre puis `crop` re-recadre
**Fichier** : [`pipeline.py:144-171`](backend/app/pipeline.py#L144-L171)

Le redressement fait un auto-crop du plus grand rectangle inscrit **avant** l'application du crop
utilisateur, en coordonnées normalisées relatives à l'image déjà rognée par le redressement. C'est
cohérent, mais le crop utilisateur s'applique à une image dont les bords ont bougé → l'aperçu du
cadre de crop peut « sauter » quand on ajuste l'angle. Vérifier l'alignement UI↔backend du crop
lors d'un redressement fin. **Ampleur** : moyenne (si à corriger). **Impact** : faible (ergonomie de niche).

### 🟢 B6 — `_export_one` sérialise l'écriture derrière `_name_lock` pour la réservation de nom
**Fichier** : [`export.py:130-136`](backend/app/routers/export.py#L130-L136)

Correct (évite les collisions de noms en parallèle), mais `dest.touch()` puis l'encodage se font
hors du lock → une seconde photo peut choisir le nom `foo-1` alors que `foo` n'est qu'un fichier
vide de 0 octet. Fonctionne (le nom est réservé), juste noté pour la clarté. RAS.

### 🟢 B7 — Endpoints CPU-lourds en `def` synchrone
`render`, `export` sont des `def` (donc exécutés dans le threadpool anyio) — c'est **le bon choix**
(ne bloque pas la boucle asyncio). Les libs relâchent le GIL. RAS, bien vu.

---

## 4. Visuel / UX / Accessibilité

### 🟡 V1 — Fuite d'internationalisation dans le store
**Fichier** : [`frontend/src/store.ts`](frontend/src/store.ts) — lignes 499, 594, 617, 621, 625, 723, 737, 749, 845

L'app a un système i18n complet (react-i18next), mais plusieurs `notify(...)` sont **codés en dur
en français** :
- `"Élément ajouté au masque"` (617), `"Masque créé (clic)"` (621),
- `"Réglages réinitialisés"` (723), `"Réglages copiés"` (737), `"Réglages collés"` (749),
- gabarits d'erreur `"Chargement impossible : …"` (499), `"Masque IA impossible : …"` (594),
  `"Segmentation impossible : …"` (625), `"Sauvegarde impossible : …"` (845).

En anglais (ou toute autre langue), ces toasts restent en français. Les remplacer par des clés
`i18n.t(...)` (le reste du fichier le fait déjà : `i18n.t("local.maskCopied")` etc.). **Ampleur** :
faible (≈ 10 chaînes + clés). **Impact** : moyen (cohérence, crédibilité multilingue).

### 🟡 A1 — Accessibilité clavier / lecteurs d'écran
**Fichier** : [`frontend/src/styles.css`](frontend/src/styles.css) (3 règles `:focus` sur 1392 lignes), toasts

- **Focus visible** quasi absent : hors quelques `outline` sur `.theme-card`/`.cell`, la plupart
  des `<button>` n'ont pas de style `:focus-visible` distinct → navigation clavier illisible.
- **Toasts sans `aria-live`** ([`store.ts:859-863`](frontend/src/store.ts#L859-L863) / ToastStack) :
  un lecteur d'écran n'annonce ni succès ni erreur. Ajouter `role="status"`/`aria-live="polite"`
  (et `assertive` pour les erreurs).
- **Statuts par la seule couleur** : badges drapeau/label (`LibraryView.tsx:401-407`) et pastilles
  couleur sont différenciés uniquement par la couleur → problème pour daltoniens (déjà des icônes
  pour pick/reject, bien ; mais le label couleur est pur chroma). Ajouter un motif/lettre.
- **Contraste** : thème sombre — vérifier les `--dim` / textes secondaires contre AA (4.5:1).

**Ampleur** : moyenne (CSS + quelques attributs ARIA). **Impact** : moyen-élevé (accessibilité,
conformité).

### 🟢 A2 — Toasts : auto-dismiss 4,2 s sans pause au survol
**Fichier** : [`store.ts:859-863`](frontend/src/store.ts#L859-L863)

Le toast disparaît après 4200 ms quoi qu'il arrive. Un message d'erreur important (ex. « Sauvegarde
impossible ») peut être manqué. Ajouter pause au survol/focus et bouton de fermeture explicite pour
les erreurs. **Ampleur** : faible. **Impact** : faible.

### 🟢 A3 — `ClippingOverlay` : `getImageData` sur le thread principal à chaque source
**Fichier** : [`ImageViewer.tsx:486-509`](frontend/src/components/ImageViewer.tsx#L486-L509)

À chaque changement de `src` avec l'écrêtage actif, on décode l'image, `getImageData` sur toute la
preview (jusqu'à 2048px) et on boucle pixel par pixel **sur le thread principal** → micro-freeze
pendant le réglage. En mode GPU c'est doublement dommage (le shader pourrait le faire). Piste :
calculer l'écrêtage dans le shader WebGL (déjà disponible), ou en OffscreenCanvas/worker.
**Ampleur** : moyenne. **Impact** : faible (fluidité).

### 🟢 A4 — Responsive limité à 2 points de rupture
**Fichier** : [`styles.css`](frontend/src/styles.css) (`@media` à 1100px et 860px)

App desktop → acceptable, mais en dessous de ~860px la colonne de panneaux + viewer + filmstrip
devient très serrée, sans disposition de repli pensée (le bouton « replier les panneaux » aide).
Sur tablette, l'expérience est dégradée. **Ampleur** : moyenne. **Impact** : faible (cible desktop).

### 🟢 A5 — `jumpHistory` rejoue undo/redo un par un
**Fichier** : [`store.ts:714-719`](frontend/src/store.ts#L714-L719)

Sauter de l'étape 20 à l'étape 1 appelle `undo()` 19 fois, chacun faisant un `set()` + `scheduleSave()`.
19 re-rendus + 19 (re)programmations de sauvegarde. Fonctionne, mais un saut direct (recalcul d'un
seul état cible + un seul `set`) serait plus propre. **Ampleur** : faible. **Impact** : faible (perf/UX
sur historique long).

### 🟢 A6 — Cohérence des micro-interactions
- Double-clic slider = reset, molette = réglage fin : très bon (documenté).
- Le rectangle de sélection (marquee) et le drag natif des cellules cohabitent via un contournement
  pointeur ([`LibraryView.tsx:329-344`](frontend/src/views/LibraryView.tsx#L329-L344)) — fragile mais
  bien commenté. Couvrir par un test d'intégration (Playwright) pour éviter les régressions.
**Ampleur** : moyenne (tests). **Impact** : faible.

---

## 5. Qualité, tests, dette

### 🟡 Q1 — Couverture de tests : bon socle, angles morts
Présents : `test_pipeline`, `test_api`, `test_parity` (GPU↔Python), `test_raw_orientation` côté
backend ; `store`, `shortcuts`, `curveLut`, `parity`, `presetFile`, `types` côté frontend. **Solide.**
Manques :
- Aucun test d'intégration UI (marquee, drag albums, crop) → régressions faciles.
- La parité GPU↔Python **ne couvre pas les opérations à voisinage** (flou : clarté, netteté, NR,
  vignette) — explicitement noté dans `CLAUDE.md §8`. C'est le plus gros risque de divergence
  aperçu↔export.
- Pas de test de non-régression sur l'export (EXIF, dimensions, ratio de crop).
**Ampleur** : moyenne-forte. **Impact** : moyen (fiabilité à long terme).

### 🟢 Q2 — `console.error` résiduels & gestion d'erreurs hétérogène
[`DevelopView.tsx:80`](frontend/src/views/DevelopView.tsx#L80) log en console ; ailleurs on `notify`.
Uniformiser (toast utilisateur vs. log dev). **Ampleur** : faible.

### 🟢 Q3 — `git status` : beaucoup d'icônes/binaires modifiés + `frontend/public/` non suivi
Le dépôt a de nombreux `src-tauri/icons/*.png` modifiés et `frontend/public/`, `frontend/src/assets/`
non suivis. Vérifier que les assets définitifs sont commités et que rien de généré ne traîne.
**Ampleur** : faible. **Impact** : faible (hygiène de dépôt).

### 🟢 Q4 — Dépendances : à jour, surface raisonnable
Front léger (react, zustand, i18next, tauri). RAS de vulnérabilité évidente. Mettre en place un
`npm audit` / `pip-audit` en CI. **Ampleur** : faible.

---

## 6. Points forts (à préserver)

Pour équilibrer : le projet est remarquablement solide sur plusieurs axes, à **ne pas casser** en
corrigeant ce qui précède :
- **Architecture perf** exemplaire : JPEG embarqué à l'import, base 2560px float16 + cache chaud/froid
  + verrous de décodage par photo, coalescence des rendus, `content-visibility`, export parallèle
  multi-cœurs NDJSON.
- **Import par référence** (pas de copie) propre, avec relink et badge « fichier introuvable ».
- **Téléchargement de modèles** durci (SHA-256 + taille + rename atomique).
- **Confinement des chemins** systématique sur les routes servant des fichiers.
- **Parité GPU↔Python** testée automatiquement (fixtures golden) — rare et précieux.
- **i18n, raccourcis personnalisables, historique persistant** : maturité UX au-dessus de la moyenne.

---

## 7. Plan d'action recommandé (ordonné)

1. **S1** (CORS/Origin) + **S2** (CSP) — sécurité, effort faible, à faire en premier.
2. **P1** (EXIF/ICC/TIFF 16 bits à l'export) — crédibilité photo, effort moyen.
3. **B1** (purge exports) + **V1** (i18n store) + **S3** (timeout download) — quick wins.
4. **A1** (accessibilité : focus, aria-live) — effort moyen, impact large.
5. **P2** (récupération HL RAW) + **Q1** (parité des ops à voisinage) — chantiers de fond, à planifier.
6. Reste (P3–P6, B2–B5, A2–A6, Q2–Q4) — au fil de l'eau.
</content>
</invoke>
