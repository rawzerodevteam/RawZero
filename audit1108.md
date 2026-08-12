# Audit RawZero — 2026-08-11

> Audit global (backend, frontend, GPU, UX) mené par revue de code en 5 volets parallèles :
> pipeline de traitement backend, routers API/sécurité, état frontend (Zustand), composants/UX,
> pipeline de rendu GPU (WebGL2). Chaque point ci-dessous a été localisé précisément (fichier:ligne)
> et, pour les plus critiques, revérifié manuellement sur le code actuel avant publication.
>
> Portée : bugs et failles réels ou risques concrets. Le style de code, la simplification et les
> questions de performance pure sont hors périmètre (voir plutôt une revue `/code-review` ou
> `/simplify` pour ça).
>
> Classement : **Critique** → **Élevé** → **Moyen** → **Faible**, du plus au moins urgent à traiter.

## Résumé exécutif

| Sévérité | Nombre | Thème dominant |
|---|---|---|
| 🔴 Critique | 2 | Corruption/perte de données silencieuse, fuite mémoire GPU non bornée |
| 🟠 Élevé | 7 | Crashs de rendu, écritures hors périmètre, actions destructives sans garde-fou |
| 🟡 Moyen | 9 | Races d'état, fuites mémoire modérées, écrasements silencieux |
| 🟢 Faible | 11 | Cosmétique, accessibilité, robustesse en marge, cas d'usage rares |
| **Total** | **29** | |

**Priorités immédiates recommandées** (les 4 points qui combinent probabilité d'occurrence réelle
en usage normal et impact sur les données de l'utilisateur) :
1. **C2** — suppression de la photo courante en développement peut écraser les réglages de la
   photo suivante.
2. **C1** — fuite de VRAM non bornée à chaque masque pinceau/correcteur de taches créé.
3. **H1** — path traversal dans le nommage d'export (peut écrire un fichier hors du dossier choisi).
4. **H2/H3** — un champ de masque à `null` rend une photo définitivement impossible à développer.

---

## 🔴 Critique

### C1 — Fuite non bornée de VRAM (render targets) à chaque masque pinceau/correcteur de taches
- **Domaine** : GPU (rendu temps réel)
- **Fichiers** : `frontend/src/gpu/pipeline.ts:166-183` (`rt()`), `:198` (`setBase()`),
  `:122-132` (`clearMaskTextures()`), `:249-292` (`brushTexture()`, `blur()` avec clés
  `` `brushA_${loc.id}` ``/`` `brushB_${loc.id}` ``)
- **Description** : `rt(key, w, h)` met en cache les render targets (texture + FBO) dans la Map
  d'instance `this.rts`, et ne libère une entrée que si la **même clé** est redemandée avec une
  taille différente. Or `brushTexture()` génère les deux RT du flou d'un masque pinceau/correcteur
  de taches avec une clé dérivée de `loc.id` (identifiant unique par masque). Une fois le masque
  supprimé — ou la photo changée —, plus personne ne redemande cette clé exacte : les deux RT
  (jusqu'à ~1600 px, RGBA16F, ~20 Mo chacune) restent alloués **pour toujours**. `setBase()` est
  appelé à chaque changement de photo et vide bien `brushTex`/`brushRawTex`/`aiTex` via
  `clearMaskTextures()`, mais **jamais `this.rts`**.
- **Scénario** : session de retouche normale — peindre quelques masques pinceau ou correcteurs de
  taches sur plusieurs photos successives (aperçu GPU actif, mode par défaut). Chaque masque créé,
  même supprimé ensuite, laisse ~40 Mo de VRAM orpheline. Sur une carte modeste ou une longue
  session, accumulation jusqu'à épuisement mémoire GPU / perte de contexte / ralentissement massif,
  sans qu'aucune action utilisateur normale (changer de photo, supprimer un masque) ne le résolve —
  seule la désactivation puis réactivation du rendu GPU (`dispose()`) purge le cache.
- **Pourquoi critique** : croissance non bornée, invisible pour l'utilisateur, proportionnelle à
  l'usage normal de la fonctionnalité phare de retouche locale, sans recours dans l'UI existante.

### C2 — Supprimer la photo courante en développement peut écraser les réglages de la photo suivante
- **Domaine** : État frontend (Zustand)
- **Fichiers** : `frontend/src/store.ts:408-419` (`removeSelection`), `:421-447` (`removeCurrent`),
  `:779-790` (`saveNow`), `:828-831` (`scheduleSave`)
- **Description** : `removeCurrent`/`removeSelection` mettent à jour `photos`/`currentId` (et
  `view` si le catalogue devient vide) mais **ne réinitialisent jamais `edits`/`dirty`**, contrairement
  à `openDevelop()` qui, lui, recharge `edits` proprement depuis le serveur. `saveNow()` relit
  `dirty`/`edits`/`currentId` **depuis le store au moment de son exécution**, sans lien avec la
  photo pour laquelle `dirty` avait été positionné.
- **Scénario concret** : en développement, l'utilisateur retouche la photo A (glisse un slider →
  `dirty=true`, sauvegarde différée programmée à 800 ms). Il décide que la photo est ratée, appuie
  sur Suppr et confirme avant l'échéance des 800 ms. La photo A est supprimée côté serveur,
  `currentId` avance vers la photo B suivante — mais `edits` reste l'objet de A, `dirty` reste
  `true`. Le `saveTimer` déjà programmé se déclenche : `saveNow()` appelle
  `api.saveEdits(currentId=B, edits=A, ...)`. **Les réglages de la photo B sont silencieusement
  écrasés par ceux de la photo A supprimée.**
- **Pourquoi critique** : perte de données réelle et silencieuse (aucune erreur, aucun message),
  sur un enchaînement d'actions ordinaire (retoucher → constater que la photo est mauvaise →
  supprimer), sans qu'aucun indice n'alerte l'utilisateur que B a été altérée.

---

## 🟠 Élevé

### H1 — Path traversal dans le nommage des fichiers d'export
- **Domaine** : Backend / sécurité
- **Fichiers** : `backend/app/routers/export.py:119-139` (`ExportRequest.suffix`/`name_template`),
  `:230-242` (`_export_one`)
- **Description** : `suffix` et `name_template` sont des chaînes libres reçues du corps JSON sans
  filtrage des séparateurs de chemin (`/`, `\`) ni de `..`. Le nom résultant est utilisé
  directement dans `out_dir / f"{stem}{ext}"` — `pathlib` interprète les séparateurs comme de vrais
  composants de chemin. Une valeur comme `suffix = "..\\..\\..\\Startup\\evil"` fait sortir la
  destination du dossier `data/exports/{stamp}/` prévu. Aucune vérification
  `dest.resolve().is_relative_to(out_dir)` n'est faite, alors que ce motif de défense est déjà
  utilisé ailleurs dans le repo (`MASKS_DIR`, `_static`).
- **Scénario** : le champ « suffixe » de `ExportDialog.tsx` n'est pas assaini côté client non plus
  — une valeur collée/tapée par erreur contenant `\..\..\`, ou tout appel direct à l'API (extension
  navigateur compromise, script tiers), écrit un fichier image à un emplacement arbitraire du
  disque de l'utilisateur, potentiellement un dossier de démarrage Windows (persistance).
- **Sévérité réelle** : app locale mono-utilisateur (pas d'escalade de privilège, CORS bloque la
  voie réseau externe), mais reste un vrai défaut de validation d'entrée exploitable par
  l'utilisateur lui-même ou par du code tiers dans le même contexte que le frontend.

### H2 — `masks.py` : `feather` non protégé sur les masques pinceau/inpaint → crash du développement
- **Domaine** : Backend / pipeline
- **Fichier** : `backend/app/masks.py:133` (`_brush_mask`)
- **Description** : `float(np.clip(params.get("feather", 0.5), 0.0, 1.0))` — contrairement à
  `_finite`/`_finite_clip` utilisés systématiquement ailleurs dans ce même fichier (précisément
  pour éviter qu'un `edits` corrompu rende une photo « impossible à développer »), ce champ n'est
  pas protégé. Si `params["feather"]` vaut `None` (JSON `null`) ou une chaîne, `np.clip` lève un
  `TypeError` non rattrapé.
- **Scénario** : un masque pinceau (ou correcteur de taches, qui réutilise `_brush_mask`) avec
  `feather=null` en base → chaque rendu/export/refresh de preview pour cette photo lève une
  exception 500 en boucle, y compris le job de refresh en arrière-plan.
- **Sévérité** : casse complètement le développement de la photo concernée sans recours utilisateur
  visible — exactement le scénario que `_finite` avait été introduit pour prévenir, mais l'oubli
  laisse le trou ouvert sur ce champ précis.

### H3 — `masks.py` : `hardness` non protégé sur les masques IA → même crash
- **Domaine** : Backend / pipeline
- **Fichier** : `backend/app/masks.py:182` (`_ai_mask`)
- **Description** : même défaut que H2 —
  `hardness = float(np.clip(params.get("hardness", 0.0), 0.0, 100.0))` non gardé contre `None`/non
  numérique.
- **Scénario** : masque IA (sujet/clic) avec `hardness=null` → `TypeError` → 500 sur toute photo
  utilisant ce masque.
- **Sévérité** : identique à H2.

### H4 — Aucune gestion de la perte de contexte WebGL
- **Domaine** : GPU
- **Fichiers** : `frontend/src/gpu/useGpuPreview.ts` (ensemble du fichier),
  `frontend/src/gpu/pipeline.ts` — aucune occurrence de `webglcontextlost` dans le code source.
- **Description** : `error`/`ready` ne sont positionnés qu'à la création initiale du contexte ou à
  l'échec de chargement de l'image de base. Si le contexte GPU est perdu en cours de session
  (réinitialisation pilote/TDR Windows, bascule GPU intégré↔dédié, sortie de veille, ou
  conséquence de la fuite C1), les appels `gl.*` deviennent des no-ops silencieux selon la
  spécification WebGL — aucune exception, `error` jamais mis à jour, aucun écouteur pour
  déclencher une recréation du contexte ou un repli vers le rendu serveur (qui existe pourtant et
  est déjà câblé pour d'autres échecs GPU).
- **Scénario** : un pilote graphique se réinitialise (fréquent sur portables avec bascule GPU)
  pendant une session d'édition active.
- **Sévérité** : pas de crash JS, mais le canevas reste figé/noir indéfiniment sans message
  d'erreur ni repli automatique — l'utilisateur croit l'application bloquée.

### H5 — Masque IA/correcteur de taches appliqué à la mauvaise photo si navigation pendant le calcul
- **Domaine** : État frontend
- **Fichier** : `frontend/src/store.ts:474-549` (`createAutoMask`, `createPointMask`, `runInpaint`)
- **Description** : chaque fonction capture `currentId`/`edits` avant l'appel réseau IA
  (potentiellement plusieurs secondes), mais après résolution appelle `updateEdits(...)` sans
  revérifier que `currentId` est resté le même. `aiMaskBusy`/`inpaintBusy` sont des flags globaux
  (pas par photo) : rien n'empêche de naviguer entre-temps.
- **Scénario** : lancer un masque « Sujet » sur la photo A, puis appuyer sur → avant la fin du
  calcul. Le résultat est poussé dans les `edits` **actuels**, désormais ceux de B → un masque
  calculé pour l'image A (géométrie/contenu différents) est ajouté à B, sans erreur ni avertissement.
- **Sévérité** : corruption silencieuse d'édition sur un flux d'usage plausible (navigation rapide
  entre photos pendant un calcul IA en tâche de fond).

### H6 — Navigation clavier rapide peut faire revenir l'état à une photo plus ancienne
- **Domaine** : État frontend
- **Fichiers** : `frontend/src/store.ts:365-373` (`navigate`), `:348-363` (`openDevelop`) ;
  `frontend/src/shortcuts.ts:25-39` (répétition accélérée des flèches, jusqu'à ~55 ms/cran,
  fonctionnalité documentée en CLAUDE.md §7)
- **Description** : `navigate()` appelle `openDevelop(next.id)` en fire-and-forget. Chaque
  `openDevelop` fait `await saveNow()` puis un `set({ currentId, edits: null, ... })` **non gardé**
  contre un appel concurrent plus récent (seul le `getPhoto` qui suit vérifie
  `currentId === id`, pas ce premier `set`). Si deux appels `openDevelop` se chevauchent
  (répétition rapide des flèches) et que le `saveNow()` de l'appel le plus ancien se résout
  **après** celui du plus récent, son `set` s'exécute en dernier et écrase l'état avec une photo
  plus ancienne.
- **Scénario** : maintenir → en développement pendant la phase accélérée, sur une machine avec
  latence disque/réseau variable (1ʳᵉ décode RAW en cours). L'app « recule » d'une photo par
  rapport à la demande de l'utilisateur.
- **Sévérité** : élevée mais fenêtre étroite — dépend de la variance de latence entre deux appels
  successifs.

### H7 — « Coller les réglages » en lot sans confirmation
- **Domaine** : UX
- **Fichier** : `frontend/src/components/ContextMenu.tsx:57`
- **Description** : `pasteEditsToSelection(ids)` s'exécute immédiatement au clic, sans passer par
  `confirmDialog` — contrairement à « Retirer du catalogue » (même fichier, ligne 98-102) qui, lui,
  confirme. L'action écrase tous les réglages de développement de toute la sélection en un clic,
  sans aperçu, sans annulation groupée dans l'UI (seul un undo par photo existe côté historique
  individuel).
- **Scénario** : sélection de 50 photos dans la grille, clic droit → « Coller les réglages » par
  erreur (double-clic accidentel, ou presse-papiers oublié) — tous les réglages précédents sont
  remplacés instantanément.
- **Sévérité** : action destructive en lot sans garde-fou, alors que le reste de l'app applique
  systématiquement `confirmDialog` pour ce type d'opération (suppression, presets).

---

## 🟡 Moyen

### M1 — Cache de vignettage non borné (fuite mémoire progressive)
- **Domaine** : Backend / pipeline
- **Fichier** : `backend/app/pipeline_detail.py:100-117` (`_vignette_r_cache`)
- **Description** : cache global jamais purgé ni borné (contrairement aux caches LRU de
  `previews.py`, explicitement bornés). Chaque entrée est un tableau `float32` de la taille du
  rendu. Peuplé uniquement sur le repli NumPy pur (si l'extension Rust `rsfast` n'est pas
  compilée — cas courant).
- **Scénario** : catalogue avec photos de résolutions/orientations variées + vignettage actif
  (y compris via preset) → chaque couple `(h, w)` de rendu ajoute une entrée jamais évincée
  pendant toute la durée du process serveur.
- **Sévérité** : croissance mémoire progressive (potentiellement des centaines de Mo sur un grand
  catalogue), pas de crash immédiat, mais contredit la discipline de bornage appliquée partout
  ailleurs dans le code.

### M2 — Race entre `invalidate()` et un décodage RAW en vol
- **Domaine** : Backend / pipeline
- **Fichier** : `backend/app/previews.py:269-283` (`invalidate()`)
- **Description** : `invalidate()` prend `_base_lock`/`_dn_lock` pour vider les caches mémoire et
  supprimer les fichiers `.npy`/masques, mais **pas** `_photo_decode_lock(photo_id)`. Si un
  `get_base()` est en cours au moment de l'invalidation, le décodage se termine après coup et
  « ressuscite » une base potentiellement issue de l'ancien fichier.
- **Scénario** : relier (`relink`) une photo à un nouveau fichier pendant qu'un rendu de fond est
  en cours sur l'ancien original.
- **Sévérité** : fenêtre de course étroite (décodage RAW généralement < 1 s), mais silencieuse et
  difficile à diagnostiquer (« l'aperçu ne se met pas à jour »).

### M3 — Changement de photo pendant un drag GPU peut corrompre les réglages persistés de la photo suivante
- **Domaine** : GPU / état frontend
- **Fichiers** : `frontend/src/store.ts:348-352` (`openDevelop`), `:835-856` (`flushLiveEdit`),
  `:577-600` (`startDrag`/`endDrag`)
- **Description** : le chemin GPU « découplé » mute `edits` en place tant que `dragBaseline` est
  non-nul. `openDevelop()` réinitialise `currentId`/`edits`/undo-redo mais **n'inclut pas
  `dragBaseline`** dans son `set()`. Si un drag est en cours (slider/poignée de masque maintenus)
  au moment d'un changement de photo, `dragBaseline` reste l'ancien clone : un `flushLiveEdit`/
  `endDrag` tardif mute alors les `edits` de la **nouvelle** photo, puis les pousse dans
  l'historique et les marque `dirty` → sauvegarde serveur de la mauvaise valeur sur la nouvelle
  photo.
- **Scénario** : maintenir le clic sur un slider ou une poignée de masque, puis naviguer vers la
  photo suivante (flèche ou clic filmstrip) sans relâcher.
- **Sévérité** : peu fréquent (chevauchement précis requis), mais impact réel et persisté côté
  serveur.

### M4 — Fuite des textures de masque pinceau/IA à la suppression d'un masque sans changer de photo
- **Domaine** : GPU
- **Fichiers** : `frontend/src/store.ts:728` (`e.locals = e.locals.filter(...)`),
  `frontend/src/gpu/pipeline.ts:53-56, 122-132`
- **Description** : la suppression d'un masque local retire l'entrée côté store mais rien
  n'informe `GpuPipeline` — les entrées `brushTex`/`brushRawTex`/`aiTex` correspondantes restent en
  mémoire (texture GPU comprise) jusqu'au prochain changement de photo. Combiné à C1 (les RT du
  flou ne sont de toute façon jamais nettoyées), c'est une fuite composée.
- **Sévérité** : accumulation plus lente que C1 mais dans le même sens ; se cumule sur une session
  de retouche avec créations/suppressions répétées de masques sur une même photo.

### M5 — Le mode comparaison double la consommation mémoire GPU
- **Domaine** : GPU
- **Fichier** : `frontend/src/components/CompareViewer.tsx:39-40`
- **Description** : les deux instances `useGpuPreview` (avant/après) créent chacune un
  `GpuPipeline` complet et indépendant. L'instance « avant » (réglages neutres) limite son
  empreinte réelle (branches à voisinage sautées), mais dès que l'instance « après » a des
  retouches locales/NR/dehaze/clarté actifs, elle alloue en parallèle un jeu complet de render
  targets pleine résolution de travail — en plus de l'accumulation potentielle de C1 côté « après »
  si des masques y ont été peints.
- **Sévérité** : facteur aggravant de C1 en mode comparaison, pas un bug isolé — déjà partiellement
  anticipé dans le code (commentaire explicite sur ce compromis) mais pas mitigé.

### M6 — Fermeture d'onglet pendant un drag GPU (avant relâchement) perd la dernière modification
- **Domaine** : État frontend / GPU
- **Fichiers** : `frontend/src/store.ts:835-856` (`flushLiveEdit`), `:865-876` (listener `pagehide`)
- **Description** : sur le chemin GPU découplé, `flushLiveEdit` mute `edits` en place sans jamais
  appeler `set()` — `dirty` n'est mis à `true` que dans `endDrag()`. Le handler `pagehide` ne
  sauvegarde que si `dirty` est vrai.
- **Scénario** : glisser un slider (aperçu GPU actif, mode par défaut) puis fermer l'onglet/l'app
  **avant** de relâcher (avant `endDrag`). `edits` contient déjà la valeur mutée, mais `dirty` est
  encore `false` → `pagehide` ne déclenche aucune sauvegarde, la modification en cours est perdue
  sans avertissement.
- **Sévérité** : perte de données silencieuse sur un geste courant (fermer l'app en plein réglage).

### M7 — « Coller les réglages » (lot) peut être écrasé par une sauvegarde différée en attente
- **Domaine** : État frontend
- **Fichiers** : `frontend/src/store.ts:681-708` (`pasteEditsToSelection`), `:828-831`
  (`scheduleSave`/`saveTimer`, timer global unique)
- **Description** : cette action relit les edits depuis le serveur et sauvegarde directement, sans
  jamais appeler `saveNow()` ni annuler le `saveTimer` en attente. Si la photo courante en
  développement (dirty, dans la fenêtre du debounce 800 ms) fait partie de la sélection ciblée, le
  `saveTimer` déjà programmé reste actif et se déclenche indépendamment.
- **Scénario** : retoucher un curseur en développement, quitter rapidement vers la grille avant les
  800 ms, sélectionner plusieurs photos incluant celle-ci, et « Coller les réglages ». Le collage
  est écrit côté serveur, puis le `saveTimer` en vol (toujours sur l'ancien `edits`/`currentId` en
  mémoire) se déclenche et réécrit par-dessus avec l'état antérieur au collage → le collage est
  silencieusement annulé.
- **Sévérité** : combine avec H7 (même fonctionnalité) — fenêtre de déclenchement précise mais
  plausible en usage réel (aller-retour rapide grille/développement).

### M8 — L'export écrase silencieusement des fichiers déjà présents dans le dossier mémorisé
- **Domaine** : UX
- **Fichiers** : `frontend/src/lib/exportDir.ts:64-78` (`writeFile`),
  `frontend/src/components/ExportDialog.tsx:88-105`
- **Description** : `writeFile` ne dédoublonne que par rapport au `Set` du lot d'export **en
  cours** ; aucune vérification qu'un fichier du même nom existe déjà dans le dossier choisi
  (mémorisé entre sessions via IndexedDB). `dir.getFileHandle(name, { create: true })` écrase
  directement.
- **Scénario** : ré-exporter les mêmes photos (même nom, sans suffixe) vers le dossier déjà
  mémorisé d'une session précédente — les fichiers précédemment exportés sont remplacés sans aucun
  avertissement.
- **Sévérité** : perte de données silencieuse sur une action non perçue comme destructive par
  l'utilisateur.

### M9 — `segment.py` : cache d'embeddings EdgeSAM muté sans verrou
- **Domaine** : Backend / IA
- **Fichier** : `backend/app/segment.py:220-231` (`_emb_cache`)
- **Description** : `_sam_lock` protège uniquement le chargement du modèle, pas les opérations sur
  `_emb_cache` (un `OrderedDict` non thread-safe pour une séquence get/move_to_end/popitem).
- **Scénario** : deux clics rapprochés (ou deux masques IA en parallèle) sur la même photo avant la
  fin du premier encodage déclenchent des mutations entrelacées du même dict — au minimum un
  travail redondant coûteux, au pire un `KeyError` par fenêtre de course entre le test de capacité
  et le `popitem`.
- **Sévérité** : fenêtre de course étroite, usage mono-utilisateur, mais présente concrètement à
  chaque double-clic rapide sur l'outil « masque au clic ».

---

## 🟢 Faible

### L1 — Divulgation de chemin système dans les messages d'erreur
- **Domaine** : Backend / sécurité
- **Fichier** : `backend/app/routers/photos.py:125-133` (`require_original`)
- **Description** : le chemin absolu complet de l'original est renvoyé tel quel au client
  (`HTTPException(409, f"Fichier original introuvable : {path}")`).
- **Sévérité** : pas de fuite vers un tiers (app locale), mais si un message d'erreur est un jour
  partagé (capture d'écran, ticket support), expose l'arborescence disque de l'utilisateur.

### L2 — Téléchargement de modèles non borné en taille/durée pendant le streaming
- **Domaine** : Backend
- **Fichier** : `backend/app/routers/models.py:99-124`
- **Description** : le SHA-256 et la taille exacte sont vérifiés **après** écriture complète du
  fichier `.part`. Le timeout (30 s) s'applique par opération socket, pas à la durée totale : une
  source qui dribble lentement peut faire traîner le téléchargement indéfiniment, remplissant le
  disque au passage.
- **Sévérité** : n'est exploitable que si la source de modèles (`RAWZERO_MODELS_URL`) est
  compromise ou modifiée par l'utilisateur lui-même — le hash final protège contre l'installation
  d'un modèle altéré ; seul le remplissage disque temporaire n'est pas borné.

### L3 — `ids`/`max_size` non bornés à l'export (auto-DoS)
- **Domaine** : Backend
- **Fichier** : `backend/app/routers/export.py:119-124` (`ExportRequest`)
- **Description** : aucune limite de taille sur `ids`, `max_size` non clampé (contrairement à
  `quality`). Une requête avec des milliers d'`ids` lance autant de décodages RAW pleine résolution
  en parallèle — épuisement mémoire possible.
- **Sévérité** : app locale, seul l'utilisateur (ou son propre frontend) peut appeler cette route —
  auto-DoS accidentel, pas un risque tiers.

### L4 — SHA-1 pour la déduplication d'import
- **Domaine** : Backend
- **Fichiers** : `backend/app/routers/imports.py:35-40` (`_hash_file`), `:167` (`relink`)
- **Description** : SHA-1 est cryptographiquement cassé pour la résistance aux collisions, mais
  l'usage ici est uniquement de la déduplication locale, pas une vérification d'intégrité contre un
  tiers (contrairement au SHA-256 utilisé pour les modèles IA).
- **Sévérité** : non exploitable en pratique dans ce contexte — signalé par cohérence seulement.

### L5 — `_smoothstep` sans garde de division par zéro (latent)
- **Domaine** : Backend / pipeline
- **Fichier** : `backend/app/pipeline_core.py:58-60`
- **Description** : `t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)` sans protection, contrairement à
  l'équivalent dans `masks.py` (`max(e1 - e0, 1e-6)`). Tous les appels actuels utilisent des bornes
  constantes non nulles — pas d'exploitation actuelle.
- **Sévérité** : latent — toute future utilisation avec des bornes dérivées de réglages
  utilisateur déclencherait un `inf`/`nan` silencieux propagé dans le rendu.

### L6 — Conversion CMYK→RGB silencieusement fausse à l'import
- **Domaine** : Backend
- **Fichier** : `backend/app/raw_loader.py:38-44`
- **Description** : les images CMJN (TIFF pro) passent par `convert("RGB")` de Pillow — conversion
  naïve sans profil ICC, couleurs visiblement fausses sans erreur ni avertissement.
- **Sévérité** : cas d'usage marginal, mais dégrade silencieusement la fidélité colorimétrique pour
  un format que l'app prétend accepter.

### L7 — Label « avant » recouvert en mode comparaison split près du bord
- **Domaine** : UX
- **Fichiers** : `frontend/src/components/CompareViewer.tsx:82-87`, `frontend/src/styles.css:593-606`
- **Description** : le badge `compare-label-left` est un enfant du slot « avant », jamais clippé,
  peint sous le slot « après » (opaque) dans l'empilement DOM. Si le curseur de split est proche du
  bord gauche, la zone visible du « avant » devient plus étroite que le badge.
- **Scénario** : glisser le curseur de comparaison presque jusqu'au bord gauche.
- **Sévérité** : purement cosmétique, reproductible à coup sûr.

### L8 — Curseur de comparaison split non accessible au clavier
- **Domaine** : UX / accessibilité
- **Fichier** : `frontend/src/components/CompareViewer.tsx:97-108`
- **Description** : la poignée `.compare-split-handle` n'a ni `role`, ni `tabIndex`, ni gestionnaire
  clavier — seuls les événements pointeur sont câblés.
- **Sévérité** : cohérent avec le constat déjà connu « accessibilité clavier quasi absente »
  (cf. audit UX archivé), confirmé sur ce composant récent.

### L9 — `ClippingOverlay` : race condition sur changement rapide d'image
- **Domaine** : UX
- **Fichier** : `frontend/src/components/ImageViewerOverlays.tsx:113-147`
- **Description** : l'`onload` de l'`Image()` recréée à chaque `src` ne vérifie jamais que `img.src`
  correspond toujours au `src` courant, et il n'y a pas de flag d'annulation (contrairement à
  `Histogram.tsx` qui en utilise un).
- **Scénario** : glisser un slider avec « Alertes d'écrêtage » actif, en repli serveur (sans GPU) —
  l'overlay peut clignoter avec une carte d'écrêtage obsolète pendant une fraction de seconde.
- **Sévérité** : visuel transitoire, peut induire en erreur sur la lecture des hautes
  lumières/ombres pendant un réglage actif.

### L10 — Échec réseau du téléchargement de modèle silencieusement avalé
- **Domaine** : UX
- **Fichier** : `frontend/src/components/ModelsDialog.tsx:33` (`download`)
- **Description** : `api.modelsDownload(f).then(refresh).catch(() => {})` — si l'appel échoue avant
  même que le serveur ne démarre le téléchargement (réseau coupé, backend indisponible), aucune
  notification n'est affichée.
- **Sévérité** : pas de perte de données, mais échec silencieux déroutant (le bouton redevient
  cliquable sans explication).

### L11 — La pipette HSL ne remet pas en évidence la même bande si cliquée deux fois rapidement
- **Domaine** : UX
- **Fichier** : `frontend/src/panels/HSLPanel.tsx:22-27`
- **Description** : si deux clics pipette consécutifs tombent sur la même bande HSL avant
  l'expiration du timer de highlight (2 s), `setUI({ hslPickedBand: "red" })` ne change pas la
  valeur → React ne redéclenche pas l'effet, ni le `scrollIntoView` ni le nouveau timer ne repartent.
- **Sévérité** : cosmétique, découverte utilisateur uniquement.

---

## Points vérifiés sans anomalie (pour référence, non re-testés à l'avenir)

- CORS/réseau : origines restreintes, garde anti-DNS-rebinding, bind par défaut sur `127.0.0.1`.
- Injection SQL : toutes les requêtes paramétrées, colonnes dynamiques issues de listes fermées.
- Confinement des chemins sur `/masks`, `/static`, suppression de fichiers : correct (`resolve()` +
  `is_relative_to`, y compris contre les liens symboliques).
- Fidélité GPU↔Python des formules de tonalité/couleur/courbe : vérifiée ligne à ligne, cohérente.
- `dispose()` du pipeline GPU et son appel au démontage : correct.
- Garde `registerLiveRender` entre les deux instances de `CompareViewer` (évite qu'elles s'écrasent
  mutuellement) : vérifiée correcte.
- Bugs déjà corrigés et donc non re-signalés : Ctrl+Z pendant un drag, double-Suppr rapproché,
  perte d'édition au changement de projet/album, masque IA copié référençant la photo source,
  copier/coller de masque pinceau → NaN (voir `TODO.md` pour l'historique).
