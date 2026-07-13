# Audit UX / UI — RawZero

> Audit ergonomique complet, détail par détail, du point de vue utilisateur.
> Basé sur une lecture du code réel de l'interface (`frontend/src`), pas sur des suppositions.
> Chaque constat porte une **sévérité** et une **recommandation actionnable**.
>
> Légende de sévérité :
> - 🔴 **Haute** — bloque ou frustre régulièrement l'utilisateur, ou casse une convention forte du domaine.
> - 🟠 **Moyenne** — friction notable, incohérence, ou standard manquant.
> - 🟢 **Faible** — finition, polish, confort.
> - 💡 **Idée** — fonctionnalité manquante (standard Lightroom/Darktable) à considérer.

---

## 0. Méthode & périmètre

Périmètre audité (fichiers réellement lus) :
- Vues : `HomeView`, `LibraryView` (Toolbar, LeftRail, Collections, Grid, Loupe), `DevelopView`, `SettingsView`.
- Composants : `ImageViewer`, `Filmstrip`, `ModeTabs`, `ProjectMenu`, `ContextMenu`, `ExportDialog`, `ImportPanel`, `ShortcutsOverlay`, `ModelsDialog`, `EditSlider`, `PanelSection`, `StarRating`.
- Panneaux : `BasicPanel`, `HSLPanel`, `DetailPanel`, `GeometryPanel`, `LocalPanel`, `PresetsPanel`, `HistoryPanel`.
- Transverse : `styles.css` (focus, media queries), `shortcuts.ts`, `keybindings.ts`, i18n.

Axes d'analyse : architecture de l'information & navigation, densité et placement, découvrabilité, feedback & états, cohérence du système visuel, accessibilité, adaptation à l'écran, prévention d'erreur, et fonctionnalités manquantes du domaine.

**Constat global** : l'application est fonctionnellement très riche et le code UI est soigné (abonnements granulaires, gestion fine du zoom/pan, i18n, thèmes). Les faiblesses sont surtout **ergonomiques et de finition** : densité mal maîtrisée, dépendance aux dialogues natifs, accessibilité clavier quasi absente, absence de responsive, et découvrabilité reposant trop sur l'aide clavier.

---

## 1. Architecture de l'information & navigation

### 1.1 🔴 Dépendance massive aux dialogues natifs `window.prompt` / `window.confirm`
Utilisés pour : créer/renommer un projet (`ProjectMenu`, `HomeView`), créer/renommer un album (`HomeView`, `Collections`, `ContextMenu`), nommer un preset (`PresetsPanel`), toutes les confirmations de suppression (projet, album, photos, raccourcis).

Problèmes :
- Rupture visuelle totale : boîte système grise non thématisée, en pleine app sombre soignée.
- Non traduisible finement, pas de validation en direct (nom vide/doublon détecté après coup), pas de placeholder riche, pas d'aperçu.
- Bloque le thread, impossible d'annuler proprement au clavier de façon cohérente.
- Impossible sur certains environnements embarqués / kiosque.

**Reco** : un composant `<Prompt>` / `<ConfirmDialog>` maison réutilisant le style `.modal` déjà présent (cf. `ExportDialog`, `ImportPanel`). Un seul hook `useDialog()` centralisé remplace les ~10 `window.prompt/confirm`. Gain de cohérence énorme pour un coût modéré.

### 1.2 🟠 Deux points d'entrée concurrents pour les albums
Les albums existent : (a) en cartes sur l'accueil (`HomeView`), (b) via le rail gauche `📚 Albums` qui ouvre le panneau `Collections`. Le modèle mental est flou : « où vivent mes albums ? ». En plus, `Collections` affiche `📁 projet courant` en tête comme s'il était un album.

**Reco** : clarifier la hiérarchie. Soit l'accueil est le hub (projets + albums), soit le rail latéral. Éviter que le projet apparaisse dans la liste des collections sans séparation typographique claire (aujourd'hui `coll-item source` + un simple `coll-sep`).

### 1.3 🟠 Bouton Accueil (🏠) dupliqué et incohérent selon la vue
- En bibliothèque : le 🏠 est dans `ProjectMenu` (`project-home`).
- En développement : un 🏠 séparé dans la toolbar (`DevelopView`).
- Sur l'accueil : pas de 🏠 (logique) mais la marque « RawZero » n'est pas cliquable pour revenir/rafraîchir.

**Reco** : rendre la marque « RawZero » (présente dans 3 toolbars) systématiquement cliquable → retour accueil. Supprimer les 🏠 redondants ou les uniformiser (même position, gauche).

### 1.4 🟠 `ModeTabs` n'expose que 2 modes alors qu'il en existe 3
`ModeTabs` = *Bibliothèque* / *Développement*. Or la Loupe (E) est un 3ᵉ mode réel avec sa propre vue. L'utilisateur bascule Grille↔Loupe uniquement via le rail (▦) ou double-clic ou raccourci. La relation Grille/Loupe/Développement n'est jamais montrée d'un coup.

**Reco** : soit un fil d'ariane à 3 segments (Grille · Loupe · Développement), soit rendre explicite que la Loupe est un sous-mode de la Bibliothèque (elle l'est dans le code). Aujourd'hui c'est implicite.

### 1.5 🟢 Pas de « fil d'Ariane » projet → album → photo
En développement, on voit le nom de fichier mais on perd le contexte (quel projet/album, position X/N). Lightroom affiche « 12 sur 340 ».

**Reco** : ajouter un compteur de position `n / total` près du nom de fichier dans la toolbar développement et la barre loupe.

---

## 2. Écran d'accueil (`HomeView`)

### 2.1 🟠 Header d'accueil : ordre et libellés des actions
Ordre actuel : `⚙ Paramètres` · `Modèles` · `⤓ Importer`. L'action primaire (Importer) est à droite, la moins primaire (Paramètres) à gauche. « Modèles » (téléchargement modèles IA) est une action rare exposée au même niveau que l'import.

**Reco** : hiérarchiser — *Importer* en bouton primaire (accent), *Paramètres* et *Modèles* regroupés à droite dans un menu « … » ou en icônes discrètes. Réserver la couleur d'accent à l'action primaire.

### 2.2 🟠 Création de projet/album via `window.prompt` (cf. 1.1) + carte « ＋ »
Les cartes « ＋ Nouveau projet / album » sont bien placées (fin de grille, pattern connu), mais l'action ouvre un prompt natif. La carte album « ＋ » et la carte projet « ＋ » sont visuellement identiques → risque de confusion sur ce qu'on crée.

**Reco** : dialogue maison ; différencier légèrement les deux cartes (icône 📁 vs 📚 en filigrane).

### 2.3 🟢 Pas de tri / recherche des projets et albums
Avec beaucoup de projets, l'accueil devient un mur d'icônes sans tri (récent, alphabétique, nb de photos) ni recherche.

**Reco** : barre de recherche + tri sur l'accueil dès que `projects.length` dépasse ~12.

### 2.4 🟢 « Toutes les photos » (🗂) noyé parmi les projets
Le projet virtuel « Toutes les photos » a la même carte que les autres. C'est une entrée spéciale (agrégat).

**Reco** : l'épingler en tête avec un traitement visuel distinct (bordure/accent), ou une rangée « Accès rapide ».

### 2.5 💡 Aucune indication d'état vide sur un tout premier lancement
Si aucun projet réel n'existe encore, l'accueil montre juste « Toutes les photos » (0) + « Nouveau ». Pas d'onboarding (« Importez vos premières photos pour commencer »).

**Reco** : état vide pédagogique avec un CTA d'import unique et 1 phrase d'explication.

---

## 3. Barre d'outils Bibliothèque (`LibraryView > Toolbar`)

### 3.1 🔴 Surcharge et absence de responsive → débordement / troncature
La toolbar aligne sur **une seule ligne** : marque, `ProjectMenu`, `ModeTabs`, puce album, compteur, filtre note (5 étoiles), select drapeau, select label (5 puces couleur), select tri, bouton EXIF (+popover), spacer, slider taille de vignette, Importer, Exporter, Aide (?), Paramètres (⚙). C'est **~15 groupes** sur une rangée.

Aucune media query dans `styles.css` (vérifié : 0 `@media` de layout). Sous ~1300 px de large, les éléments se compriment/chevauchent ou sortent du cadre selon la règle flex.

**Reco** (🔴 prioritaire) :
- Regrouper les filtres (note, drapeau, couleur, tri, EXIF) dans **un seul bouton « Filtres »** ouvrant un panneau/segment, avec un badge « • » quand des filtres sont actifs (le bouton EXIF le fait déjà — généraliser).
- Passer la toolbar en `flex-wrap` avec un point de rupture, ou déplacer les actions Import/Export/Aide dans le rail gauche (où Import/Export existent déjà en double !).
- **Doublon confirmé** : Import et Export sont présents **à la fois** dans le `LeftRail` et dans la `Toolbar`. Choisir un seul emplacement.

### 3.2 🟠 Filtre couleur : puces sans libellé ni état « aucune »
Les puces couleur (`color-dot`) sont des `<span>` cliquables de ~12 px, sans `title`, sans nom. Difficile de savoir quelle couleur correspond à quoi, et la sélection se désélectionne par re-clic (non signalé).

**Reco** : `title`/`aria-label` par couleur, un léger état actif plus visible (anneau), et une puce « ✕ / aucune » explicite.

### 3.3 🟠 Popover EXIF : fermeture et empilement
Le popover EXIF (`exif-filter-pop`) s'ouvre sous le bouton mais rien n'indique comment le fermer sinon re-cliquer le bouton ; pas de clic-extérieur géré (contrairement à `ProjectMenu` qui gère `mousedown` extérieur). Sur petit écran il peut sortir de l'écran.

**Reco** : fermeture au clic extérieur + à Échap, positionnement contraint dans le viewport (comme `ContextMenu` le fait déjà avec `Math.min`).

### 3.4 🟢 Le compteur de photos et la puce album se perdent
`<span className="dim">{count} photos</span>` au milieu de la barre est peu lisible. La puce album (`album-chip`) apparaît/disparaît, décalant tout le reste (layout shift).

**Reco** : réserver une zone stable pour le contexte (album + compteur) à un endroit fixe (ex. sous la toolbar, ou aligné à gauche near ProjectMenu).

---

## 4. Grille (`LibraryView > Grid`)

Points forts : marquee de sélection soignée (gestion pointer vs drag natif, seuils), `content-visibility` pour la perf, badges d'état (sélection ✓, pick ⚑, reject ✕, couleur, RAW, édité ✎), étoiles cliquables, taille ajustable.

### 4.1 🟠 Densité de badges sur la vignette
Jusqu'à 6 marqueurs peuvent s'empiler (✓ select, ⚑/✕ flag, puce couleur, RAW, ✎ édité) + étoiles + nom + point édité. Sur petites vignettes (min 140 px) ça sature le coin.

**Reco** : hiérarchiser (ex. RAW en discret coin opposé, fusionner « ✎ badge » et « edited-dot » qui font doublon), permettre de masquer certains overlays (option « affichage épuré »).

### 4.2 🟠 Découvrabilité de la sélection multiple
Ctrl/Maj+clic et le rectangle de sélection ne sont indiqués nulle part dans l'UI (seulement dans l'aide `?`). Un nouvel utilisateur ne sait pas qu'il peut sélectionner plusieurs photos pour exporter/noter en lot.

**Reco** : micro-indice contextuel (ex. tooltip au survol prolongé, ou une ligne d'aide « Astuce : glissez pour sélectionner, clic droit pour agir »). Afficher un bandeau d'actions quand `selection.length > 1` (« 5 sélectionnées · Exporter · Noter · Album »).

### 4.3 🟢 Double-clic ouvre la Loupe, pas le Développement
`onDoubleClick` → Loupe. Beaucoup d'utilisateurs Lightroom attendent la Loupe au double-clic depuis la grille (cohérent), mais rien ne l'indique. Le passage Loupe→Développement demande encore une action.

**Reco** : OK de garder, mais afficher au survol un mini-bouton « Développer » (comme la barre loupe le propose).

### 4.4 🟢 Étoiles dans la cellule : cible tactile / clic accidentel
Cliquer une étoile sélectionne la photo ET note (`selectPhoto` puis `setRating`). Fin, mais les étoiles `stars-small` sont petites ; risque de mauvaise note au survol/scroll.

**Reco** : agrandir la zone cliquable, ne révéler les étoiles qu'au survol de la cellule (pattern courant) pour désencombrer.

### 4.5 💡 Pas de tri « manuel » ni de glisser-réordonner dans un album
Les albums sont des collections mais l'ordre n'est pas éditable (pas de tri custom / drag-reorder), alors que c'est un usage clé des collections.

---

## 5. Loupe (`LibraryView > Loupe`) & Filmstrip

### 5.1 🟠 Barre loupe : actions incomplètes vs grille
La `loupe-bar` propose étoiles, drapeau P/X, « Développer ». Mais **pas de label couleur** ni de drapeau « neutre/reset ». L'utilisateur qui trie en loupe doit connaître les raccourcis 6-9 pour la couleur.

**Reco** : ajouter les puces couleur et un bouton « U » (neutre) dans la barre loupe pour un tri complet à la souris.

### 5.2 🟠 Filmstrip : incohérence des marqueurs avec la grille
Le filmstrip montre : étoiles (texte ★★★), ⚑ pick, ✎ édité, ✓ sélection (ajouté récemment), bordure couleur. Mais **pas** le drapeau reject en badge (seulement via classe `.rejected`), et le rendu des étoiles en texte diffère du composant `StarRating` de la grille → deux langages visuels pour la même info.

**Reco** : unifier la représentation note/flag/couleur entre grille et filmstrip (même mini-composant).

### 5.3 🟢 Filmstrip : pas de séparateur clair sélection courante vs multi-sélection
« current » (bordure accent) et « selected » (badge ✓ + bordure) coexistent ; la distinction reste subtile sur des vignettes de ~60 px.

**Reco** : renforcer le contraste de l'état « courant » (barre supérieure accent, par ex.).

### 5.4 💡 Pas de navigation/position dans le filmstrip
Pas de compteur, pas de saut rapide, pas de zoom du filmstrip. OK pour un MVP.

---

## 6. Barre d'outils Développement (`DevelopView`)

Ordre actuel : `🏠` · `ModeTabs` · nom fichier · `●` (autosave) · chip « édité » · spacer · étoiles · `Avant/Après` · `▲▼` (écrêtage) · `⧉ Copier` · `⧉ Coller` · `↺` reset · `⚡ GPU` · `Δ` (diff) · `⤒` export · `⚙`.

### 6.1 🔴 Copier / Coller partagent la même icône `⧉`
`⧉ Copier` et `⧉ Coller` utilisent le **même glyphe**. Visuellement indistinguables ; seul le libellé texte les sépare (et en icon-only ce serait ambigu).

**Reco** : icônes distinctes (ex. copier = deux carrets, coller = presse-papier), ou libellés systématiques.

### 6.2 🟠 Fonctions de debug/dev exposées dans la barre principale : `⚡ GPU` et `Δ`
`Δ` ouvre `GpuDiffDialog` (comparaison per-pixel GPU↔serveur) : c'est un **outil de développement/QA**, pas une fonction utilisateur. `⚡ GPU` bascule le moteur d'aperçu : utile mais technique.

**Reco** : déplacer `Δ` (et idéalement `⚡ GPU`) dans les Paramètres ou un menu « Avancé »/dev, masqué par défaut. La barre principale doit rester orientée tâche photo.

### 6.3 🟠 Écrêtage `▲▼` : icône obscure
`▲▼` pour « alertes d'écrêtage hautes lumières/ombres » n'est pas parlant. Lightroom utilise deux triangles colorés dans les coins de l'histogramme.

**Reco** : rendre les toggles d'écrêtage cliquables **depuis l'histogramme** (coins), pattern standard et découvrable ; garder un libellé texte si conservé en toolbar.

### 6.4 🟠 Pas de boutons Annuler / Rétablir visibles
Undo/redo n'existent qu'au clavier (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y) et via le panneau Historique. Aucune affordance visuelle dans la toolbar.

**Reco** : ajouter ↶ / ↷ dans la toolbar développement (désactivés si piles vides), avec tooltip du prochain libellé d'étape (les libellés existent déjà via `historyTimeline`).

### 6.5 🟢 Indicateur d'autosave `●` trop discret
Un point `dim` avec `title="autosaving"`. L'utilisateur ne sait pas quand ses réglages sont réellement persistés vs en cours.

**Reco** : micro-état textuel « Enregistré ✓ / Enregistrement… » ou animation du point ; c'est rassurant sur une app d'édition.

### 6.6 🟢 Reset `↺` global sans confirmation ni portée claire
Le `↺` de la toolbar appelle `resetEdits` (tout remettre à zéro). C'est destructif et proche du bouton copier/coller. Pas de confirmation.

**Reco** : soit confirmation légère, soit s'appuyer sur undo (déjà le cas) mais l'indiquer (« réinitialisé — Ctrl+Z pour annuler »).

---

## 7. Viewer (`ImageViewer`)

Points forts : zoom molette centré curseur, Espace+glisser (Krita/PS), Z bascule ajusté↔100 %, indicateur de zoom, overlays masques/poignées/crop/écrêtage, curseur de pinceau. Techniquement excellent.

### 7.1 🟠 Contrôles de zoom uniquement clavier/molette
Aucun contrôle **cliquable** : pas de boutons +/−, pas de menu de niveaux (Ajusté / 100 % / 200 %), pas de slider. L'indicateur `zoom-indicator` est en lecture seule.

**Reco** : rendre l'indicateur de zoom cliquable → menu de niveaux ; optionnel : petits boutons +/− au survol. Essentiel pour la souris/tablette.

### 7.2 🟠 Découvrabilité des interactions du viewer
Espace+glisser, double-clic zoom, molette : rien à l'écran. Le nouvel utilisateur clique et « il ne se passe rien » (ou ça pan sans qu'il comprenne).

**Reco** : premier lancement en développement → petit coach-mark éphémère (« Molette : zoom · Espace+glisser : déplacer · Z : 100 % »), refermable et non répété.

### 7.3 🟠 Deux barres de ratio de recadrage concurrentes et divergentes
- `CropBar` flottante (`DevelopView`) : Libre, 1:1, 3:2, 4:3, 16:9, **9:16**.
- `GeometryPanel` : Libre, 1:1, 3:2, 4:3, 16:9 (**pas de 9:16**).

Deux UI pour la même chose, avec des listes différentes → incohérence et confusion.

**Reco** : une seule source de vérité pour les ratios (constante partagée), un seul emplacement principal (la barre flottante contextuelle est le bon), le panneau Géométrie pointant dessus.

### 7.4 🟢 Poignées de masque et crop : cibles petites (r=7 / 12 px)
À la souris ça passe ; au trackpad/tablette c'est fin. Pas de zone de saisie élargie.

**Reco** : `hit-area` invisible plus large autour des poignées (cercle transparent r≈14 capturant le pointeur).

### 7.5 🟢 Pas de retour visuel quand une action masque n'aboutit pas
Ex. tracé trop court (`dist < 0.01`) → rien ne se crée, sans message. L'utilisateur croit à un bug.

**Reco** : micro-toast « Tracé trop court » ou ignorer silencieusement mais garder le curseur outil actif clairement.

---

## 8. Panneaux de développement (colonne droite)

Ordre : Histogramme · Basique · Courbe · TSL(HSL) · Détail · Effets · Géométrie · Local · Presets · Historique · Meta.

### 8.1 🟠 Ordre des panneaux vs flux de travail
La **Géométrie/Recadrage** est en 6ᵉ position, alors que recadrer/redresser est souvent la **première** étape. Les **Presets** (point de départ d'un rendu) sont en 8ᵉ. Le **Local** (masques) est avant Presets. Lightroom place Recadrage tout en haut.

**Reco** : proposer un ordre plus proche du flux : *Basique → Courbe → TSL → Détail → Effets → **Géométrie (ou en tête)** → Local → Presets → Historique → Meta*. Idéalement : **panneaux réordonnables** et pliage mémorisé (localStorage).

### 8.2 🟠 Tous repliés sauf Basique → beaucoup de clics
Chaque section est `defaultOpen={false}` sauf Basique. Pour atteindre Local ou Detail, il faut scroller + déplier à chaque photo (l'état d'ouverture n'est pas persistant entre sessions).

**Reco** : mémoriser l'état ouvert/fermé par section (localStorage), et/ou un mode « accordéon » (une seule ouverte) optionnel.

### 8.3 🟠 Pas de « solo/aperçu de section » ni d'interrupteur d'activation par module
Impossible de désactiver temporairement un module (ex. couper le HSL pour comparer) sans tout reset. Standard Darktable (interrupteur par module).

**Reco (💡)** : ajouter une case d'activation par section (œil/toggle) qui n'efface pas les valeurs.

### 8.4 🟢 En-tête de section : pastille reset `↺` peu visible, pas d'indicateur « modifié »
Rien n'indique quelles sections contiennent des réglages non neutres. L'utilisateur ne repère pas d'un coup d'œil où il a agi.

**Reco** : point/États « modifié » sur l'en-tête des sections actives (comme le badge EXIF actif). Réutilise la logique `edits_meaningful` déjà côté data.

### 8.5 🟠 LocalPanel : densité et hiérarchie
Beaucoup de contrôles empilés : 3 outils géométriques + IA (sujet/ciel/point) + 2 masques par plage + taille pinceau + gomme + liste + réglages du masque (jusqu'à ~15 sliders). C'est le panneau le plus chargé, sans sous-regroupement.

**Reco** : séparer visuellement « Créer un masque » (outils) de « Ajuster le masque sélectionné » (sliders), éventuellement en deux sous-sections. Les sliders d'ajustement local répètent la liste globale — envisager de les regrouper sous un intitulé « Effet du masque ».

### 8.6 🟢 HSL : 8 bandes × 3 modes = navigation par onglets H/S/L
Bon choix (onglets), mais on ne voit qu'un mode à la fois ; pas de vue « toutes bandes, mode courant » colorée au-delà du liseré `--band-color`.

**Reco** : OK ; éventuellement un mode « point sur l'image » (cliquer une couleur dans la photo cible la bande) — standard et très apprécié.

### 8.7 🟢 Historique : numérotation `tag` peut prêter à confusion
La liste inverse l'ordre (récent en haut) et affiche un `tag` = `i+1`. L'index croissant en bas + affichage inversé peut désorienter.

**Reco** : libellé « Étape n » explicite, ou horodatage relatif. Marquer clairement l'état courant (déjà `selected`) et les étapes « futures » (redo) — déjà géré via classe `future`, bien.

---

## 9. Modales

### 9.1 Export (`ExportDialog`) — plutôt bon
Points forts : portée (sélection/courante/toutes), destination FS Access mémorisée, progression NDJSON, gestion d'erreurs par photo.

- 🟠 **Nommage limité** : uniquement un `suffixe`. Pas de modèle (préfixe, numérotation, date, nom d'origine + séquence). Standard export.
  **Reco** : petit moteur de template `{nom}_{seq}` optionnel.
- 🟢 Le choix « Toutes les affichées » exclut les rejetées silencieusement (bon défaut) mais ne le dit pas clairement à côté du select.
  **Reco** : libellé « Toutes (hors rejetées) — N ».
- 🟢 Pas d'« ouvrir le dossier après export » ni de récap cliquable.
- 🟢 Qualité JPEG en slider 50–100 sans repères (« web » / « impression »).

### 9.2 Import (`ImportPanel`) — corrections utiles
- 🟠 **Upload sans barre de progression globale** : statut par fichier (pending/uploading/…) mais pas de « 3/40 ». Sur gros lots, on ne sait pas où on en est.
  **Reco** : barre de progression agrégée comme à l'export.
- 🟠 **Drag & drop seulement sur l'onglet Upload** : l'onglet Dossier n'accepte pas le drop de dossier ; formats acceptés listés seulement en upload.
- 🟢 Le navigateur de dossiers (`FolderTab`) importe au **clic sur un fichier** (`onClick` → import immédiat) : risque d'import involontaire en voulant juste explorer. Le `title` prévient, mais l'action est trop « chaude ».
  **Reco** : sélection multiple + bouton « Importer la sélection », ou double-clic pour importer un item isolé.
- 🟢 Pas de choix du projet cible **dans** la modale d'import (utilise le projet courant) — à rendre explicite (« Importer dans : Projet X ▾ »).

### 9.3 Menu contextuel (`ContextMenu`) — bon, quelques manques
- 🟠 **Pas de « Coller les réglages »** ni « Copier les réglages » dans le menu contextuel de la grille (le copier/coller de réglages n'existe qu'en développement). Or appliquer un rendu à une sélection depuis la grille est un usage majeur.
  **Reco** : ajouter « Coller les réglages » (depuis le dernier copié) sur la sélection.
- 🟠 **Pas d'accès note/couleur** dans le menu contextuel (seulement drapeaux P/X/neutre). Incohérent avec le tri.
  **Reco** : sous-menus « Note ▸ » et « Couleur ▸ ».
- 🟢 Positionnement : décalage approximatif codé en dur (`230/260 px`). Peut mal tomber selon le contenu (sous-menu album ouvert).

### 9.4 Aide raccourcis (`ShortcutsOverlay`) — correcte
- 🟢 C'est aujourd'hui **le seul endroit** où l'utilisateur découvre les interactions clés (Espace, molette, marquee…). Trop de fonctionnalités reposent sur ce panneau `?`.
  **Reco** : compléter par des indices in-context (cf. 4.2, 7.2) plutôt que tout renvoyer à l'aide.

---

## 10. Paramètres (`SettingsView`)

Points forts : personnalisation complète des raccourcis (capture, reset, unassign, conflits), thèmes + accent, langue, icônes SVG propres (anti-fringing ClearType, bonne attention au détail).

- 🟠 **Un seul niveau « Paramètres »** mélange apparence et raccourcis, mais **aucun réglage applicatif** : pas d'options pour dossier data, comportement autosave, taille cache, unités, langue par défaut au-delà de l'UI, réinitialisation catalogue.
  **Reco** : sections « Général / Rendu / Stockage » à terme.
- 🟢 Retour via « ← Retour » vers `previousView` : bien. Mais on entre en Paramètres depuis 4 endroits (accueil, biblio, développement, aide) — cohérent, garder.
- 🟢 Capture de touche : bon, mais pas d'indication des **conflits potentiels** avant validation (le code libère l'ancienne liaison, à confirmer côté message utilisateur).

---

## 11. Accessibilité (transverse) 🔴

C'est le point faible le plus systémique.

### 11.1 🔴 Focus clavier invisible
`styles.css` : `outline: none` global (ligne ~45) et seuls `select:focus` / `input[type=text]:focus` reçoivent une bordure accent. **Les boutons, onglets, cartes, cellules, items de liste n'ont aucun anneau de focus.** Naviguer au clavier est quasi impossible à suivre visuellement.

**Reco (🔴)** : ajouter un style `:focus-visible` global cohérent (anneau accent 2 px, offset), sans réintroduire l'anneau au clic souris. C'est un correctif court à fort impact.

### 11.2 🔴 Éléments interactifs non natifs sans rôle ni clavier
Nombreux `<div>`/`<li>`/`<span>` cliquables **sans** `role`, `tabIndex`, ni gestion clavier :
- Cellules de grille (`.cell`), items Collections (`.coll-item`), items masques (`.local-list li`), items historique, puces couleur (`.color-dot`), lignes de fichiers d'import.
- `StarRating` : `role="button"` posé sur chaque étoile mais **pas focusable**, **pas de `onKeyDown`**, **pas d'`aria-label`** (« noter 3 étoiles »).

**Reco** : au minimum rendre focusables et activables au clavier (Enter/Espace) les listes principales (grille, masques, presets, historique) et les étoiles ; ajouter `aria-label` sur les contrôles icône/puce.

### 11.3 🟠 Boutons icône : libellé accessible
Beaucoup de boutons n'ont qu'un glyphe + `title`. Le `title` aide la souris mais le contenu accessible est l'emoji (« maison », « livre »…), pas l'action. Certains ont `aria-label` (pipette) — bien, mais c'est l'exception.

**Reco** : `aria-label` systématique sur les boutons icône (pattern déjà présent, à généraliser).

### 11.4 🟠 Contraste & tailles de cible
- Puces couleur ~12 px, poignées 7–12 px, `mini-btn`, `dim` text (texte grisé sur fond sombre) : sous les seuils WCAG (contraste texte `--text-dim`, cibles < 24 px).
- Beaucoup d'infos reposent sur la **couleur seule** (labels couleur, drapeaux via classe).

**Reco** : viser 24×24 px de cible minimale sur les contrôles fréquents, vérifier le contraste de `--text-dim`, doubler la couleur d'une forme/texte.

### 11.5 🟢 Structure sémantique
`nav`/`aside` présents (bien). Manque : landmarks `main`, `header` cohérents, titres de section pour lecteurs d'écran, gestion du focus à l'ouverture des modales (piéger le focus, le rendre au déclencheur à la fermeture).

**Reco** : focus-trap + restitution du focus sur `.modal` ; `aria-modal="true"`, `role="dialog"`, `aria-labelledby` sur le `<h2>`.

### 11.6 🟢 Pas de `prefers-reduced-motion`
Le filmstrip fait du `scroll behavior:smooth`, transitions diverses. Aucune prise en compte de la réduction de mouvement.

**Reco** : neutraliser animations sous `@media (prefers-reduced-motion: reduce)`.

---

## 12. Adaptation à l'écran / responsive 🟠

- **0 media query de layout** dans `styles.css`. L'app suppose un grand écran large. En dessous d'une certaine largeur : toolbar bibliothèque (§3.1) et toolbar développement débordent ; la colonne de panneaux (`develop-panels`) et le viewer se disputent l'espace sans point de rupture.
- Cibles tactiles trop petites (§11.4) pour un usage tablette.

**Reco** :
- Au minimum, `flex-wrap` + priorité de masquage (overflow menu « … ») sur les toolbars.
- Largeur minimale gérée (colonne panneaux repliable en développement — un bouton pour masquer/afficher le panneau droit gagnerait de l'espace sur laptop 13").
- Ce n'est pas une app mobile, mais « laptop 1280×800 » est un cas réel à ne pas casser.

---

## 13. Feedback, états & micro-interactions

### 13.1 🟠 Toasts : un seul à la fois, non empilable, sans type
`App` affiche `toast` (chaîne unique). Pas de file d'attente, pas de couleur succès/erreur, pas de bouton de fermeture ni d'action (« Annuler »). Une seconde notif écrase la première.

**Reco** : système de toasts empilables avec type (succès/erreur/info), auto-dismiss réglable, et action optionnelle (« Annuler la suppression »).

### 13.2 🟠 États de chargement lacunaires
- Changement de projet / premier chargement de la grille : pas d'indicateur clair (grille vide un instant).
- Développement : `viewer-empty` = « chargement… » texte simple ; décodage RAW initial peut durer plusieurs secondes sans barre/estimation.
- `aiMaskBusy` → libellé « calcul… » bien géré (bon exemple à généraliser).

**Reco** : skeletons/spinners cohérents ; sur le décodage base RAW long, un message « Préparation du RAW… » explicite.

### 13.3 🟢 États vides inégaux
Grille vide : bon (message + CTA import). Loupe/Développement sans photo : « Aucune photo » minimal. Collections vides : « Aucun album » (ok). Accueil premier lancement : rien (§2.5).

**Reco** : harmoniser les états vides (illustration légère + CTA).

### 13.4 🟢 Prévention d'erreur / actions destructives
Suppressions confirmées via `window.confirm` (à moderniser, §1.1). Mais reset global (§6.6) et « vider le recadrage », « supprimer masque » sont immédiats. Pas d'« Annuler » proposé dans un toast.

**Reco** : privilégier l'annulation post-action (toast « Annuler ») plutôt que la confirmation systématique, plus fluide et plus sûr.

---

## 14. Cohérence du système visuel 🟠

### 14.1 🟠 Trois langages d'icônes mélangés
- **Emoji** : 🏠 📁 📚 🗂 🖼 ⤓ ⤒ ⚙ ⚡ ⬇ ⬆.
- **Glyphes Unicode** : ▦ ◎ ▤ ✎ ↺ ▸ ▲▼ ⧉ ◐ ◑ ⟲ ⟳ ⇋ ⇵ Δ ✕ ＋.
- **SVG** (pipette, reset/close des Paramètres).

Rendu, poids, alignement et couleur (les emoji ignorent `currentColor`, d'où le passage SVG déjà amorcé dans Settings) varient. Incohérence visuelle et problèmes de teinte/thème (emoji restent colorés en thème clair/sombre).

**Reco** : adopter **un seul set d'icônes SVG monochrome** (`currentColor`) pour toute l'UI de contrôle, réserver l'emoji éventuellement aux contenus (dossiers/albums) mais idéalement les remplacer aussi. Chantier de fond à fort gain de cohérence.

### 14.2 🟢 Multiplicité des variantes de boutons
`.btn`, `.btn small`, `.btn primary`, `.btn danger`, `.mini-btn`, `.rail-btn`, `.mode-tab`, `.tab`, `.pipette-btn`, `.coll-add`, `.ctx *`. Beaucoup de styles proches.

**Reco** : rationaliser en un petit système (`Button` avec variantes `primary|ghost|danger|icon` + tailles) pour garantir cohérence des paddings/hauteurs/états.

### 14.3 🟢 « Reset » représenté de 2 façons
`↺` (glyphe) dans les panneaux/toolbar, `IconReset` (SVG) dans Settings. Même sémantique, deux rendus.

**Reco** : une seule icône reset partout (le SVG).

---

## 15. Terminologie & libellés 🟢

- Mélange attendu FR/EN via i18n (bien). Vérifier la cohérence des termes : « Développement » vs onglet « Develop », « TSL » (fr) vs « HSL » (code), « Bibliothèque » vs « Library ».
- « Modèles » (bouton accueil) est ambigu (modèles IA à télécharger). Préciser « Modèles IA ».
- `Δ` et `⚡ GPU` n'ont pas de libellé texte → jargon (§6.2).
- Ratios de crop : « Libre » traduit, les autres littéraux — OK.

**Reco** : passe de relecture terminologique ; libeller les fonctions techniques ou les cacher.

---

## 16. Fonctionnalités ergonomiques manquantes (standards du domaine) 💡

Classées par valeur/usage :

1. 💡 **Coller les réglages sur une sélection depuis la grille** (batch develop) — très demandé (cf. 9.3).
2. 💡 **Boutons Undo/Redo visibles** (cf. 6.4).
3. 💡 **Contrôles de zoom cliquables** (Ajusté/100 %/200 %) (cf. 7.1).
4. 💡 **Recherche** (par nom de fichier, dans le catalogue/projet) — absente partout.
5. 💡 **Interrupteur d'activation par module** de développement (cf. 8.3).
6. 💡 **Réordonner / mémoriser l'état des panneaux** (cf. 8.1/8.2).
7. 💡 **Avant/après côte à côte** (split), en plus du toggle plein cadre.
8. 💡 **Pipette de couleur HSL sur l'image** (cf. 8.6).
9. 💡 **Écrêtage cliquable depuis l'histogramme** (cf. 6.3).
10. 💡 **Modèle de nommage à l'export** (cf. 9.1).
11. 💡 **Copies virtuelles / instantanés (snapshots)** — déjà listé « piste future » dans CLAUDE.md.
12. 💡 **Plein écran / masquer les panneaux** (F, Tab) pour maximiser l'image.
13. 💡 **Réordonner les photos dans un album** (drag) (cf. 4.5).
14. 💡 **Édition de métadonnées / renommage de fichier**.
15. 💡 **Guides de composition** dans le viewer hors recadrage (grille, nombre d'or).

---

## 17. Points forts à préserver ✅

- Marquee de sélection robuste (gestion pointer vs drag natif).
- Abonnements store granulaires → aucun re-render inutile pendant le drag des sliders.
- `EditSlider` : double-clic libellé = reset, clic valeur = saisie directe, drag = live + point d'historique. Excellent, à documenter/signposter davantage.
- Zoom/pan viewer très complet (molette centrée, Espace+glisser, Z).
- Personnalisation complète des raccourcis + thèmes + accent + i18n.
- Masques locaux riches (géométriques, IA sujet/ciel/point, plages lum/couleur) avec poignées.
- Export parallèle avec destination mémorisée et progression.
- Soin technique (anti-fringing SVG, `content-visibility`, annulation de requêtes).

---

## 18. Plan d'action priorisé

### Lot A — Quick wins (fort impact, faible coût)
1. 🔴 **Focus `:focus-visible` global** (§11.1) — quelques lignes CSS.
2. 🔴 **Icônes Copier vs Coller distinctes** (§6.1) + libellés.
3. 🟠 **Sortir `Δ` / `⚡ GPU` de la barre principale** (§6.2) vers Paramètres/Avancé.
4. 🟠 **Dédupliquer Import/Export** (rail vs toolbar) (§3.1).
5. 🟠 **`title`/`aria-label` sur puces couleur et boutons icône** (§3.2, 11.3).
6. 🟠 **Unifier la liste des ratios de recadrage** (une constante) (§7.3).
7. 🟢 **Rendre l'indicateur de zoom cliquable** (menu niveaux) (§7.1).
8. 🟢 **Mémoriser l'ouverture des sections de panneaux** (§8.2).

### Lot B — Chantiers structurants (fort impact, coût moyen)
9. 🔴 **Composant `Dialog`/`Prompt`/`Confirm` maison** remplaçant `window.prompt/confirm` (§1.1).
10. 🔴 **Rendre la toolbar bibliothèque responsive** : regrouper les filtres sous un bouton « Filtres », `flex-wrap`/overflow (§3.1).
11. 🟠 **Boutons Undo/Redo + bandeau d'actions sur sélection multiple** (§6.4, 4.2).
12. 🟠 **Système de toasts empilables + « Annuler »** (§13.1, 13.4).
13. 🟠 **Coller les réglages / note / couleur dans le menu contextuel** (§9.3).
14. 🟠 **Accessibilité clavier des listes et étoiles** (rôles, tabIndex, Enter/Espace) (§11.2).

### Lot C — Cohérence & profondeur (moyen/long terme)
15. 🟠 **Set d'icônes SVG unifié** + système de boutons rationalisé (§14).
16. 🟠 **Réordonnancement des panneaux + interrupteur d'activation par module** (§8.1, 8.3).
17. 🟠 **Onboarding / coach-marks** (viewer, sélection multiple) + états vides harmonisés (§7.2, 4.2, 13.3).
18. 💡 **Recherche catalogue, modèle de nommage export, avant/après split, plein écran** (§16).
19. 🟢 **Passe responsive complète + `prefers-reduced-motion` + focus-trap modales** (§12, 11.5, 11.6).

---

## 19. Synthèse

RawZero a un **cœur fonctionnel de niveau professionnel** et une **ingénierie front soignée**. Les gains UX les plus élevés viennent aujourd'hui de :

1. **Accessibilité clavier** (focus visible + éléments non natifs) — dette la plus systémique.
2. **Maîtrise de la densité** (toolbars responsives, filtres regroupés, fonctions dev cachées).
3. **Modernisation des dialogues natifs** (prompt/confirm → composants thématisés).
4. **Découvrabilité** (rendre visibles les interactions puissantes déjà codées : zoom, sélection, copier/coller, undo).
5. **Cohérence visuelle** (unifier icônes et boutons).

Aucune de ces améliorations ne remet en cause l'architecture : ce sont des couches d'ergonomie posées sur des fondations déjà solides.
