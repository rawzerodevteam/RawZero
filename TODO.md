# RawZero — TODO

> Liste consolidée des tâches restantes, réunies depuis les anciens documents d'audit/analyse
> (`AMELIORATION.md`, `auditbug.md`, `audituxui.md`, `transfert_rust.md`, `Notes`), désormais
> archivés dans `CLAUDE.md §12`. Coche au fur et à mesure ; garde ce fichier comme unique backlog
> à jour (ne pas recréer de docs d'audit séparés).

## Bugs confirmés (ex-`auditbug.md`)

- [x] 🔴 `offsetParams` (copier/coller d'un masque pinceau) traite les points comme `{x,y}` au lieu
      de `[x,y]` → `NaN`/`null`, plante le rendu et l'export. **Fix** : `frontend/src/lib/localMask.ts`,
      décale `p[0]`/`p[1]` au lieu de `p.x`/`p.y`.
- [x] 🔴 `pasteEditsToSelection` (coller les réglages en lot depuis la grille) ne pousse pas
      `history` → à la réouverture de la photo, `loadHistory` restaure l'ancien état et écrase le
      collage en lot au prochain save. **Fix** : `frontend/src/store.ts`, construit une `HistoryData`
      (historique existant de la photo + étape « collé ») et la passe à `api.saveEdits`.
- [x] 🟠 Le grain n'apparaît jamais dans l'aperçu GPU. **Fix** : passe de bruit (hash procédural,
      seed par photo) ajoutée à la passe finale de `frontend/src/gpu/pipeline.ts` ; seed branché
      depuis `currentId` dans `useGpuPreview.ts`.
- [x] 🟠 Masque « plage de luminance » avec Min > Max : le swap `lo`/`hi` existe côté Python
      (`masks.py`) mais pas dans le shader GLSL. **Fix** : swap ajouté dans `computeMask` (GLSL,
      `frontend/src/gpu/pipeline.ts`), utilisé par `lblend` et `maskovl`.
- [x] 🟠 Export sans EXIF/ICC, TIFF forcé en 8 bits (`backend/app/routers/export.py`, `cv2.imwrite`
      brut). **Fix** : JPEG/PNG écrits via Pillow avec profil ICC sRGB + EXIF reconstruit depuis le
      catalogue ; TIFF écrit via `tifffile` en 16 bits réels (nouvelle dépendance légère, pure
      Python) avec le même profil ICC. `pipeline.render_array` accepte désormais `bit_depth=16`.
- [x] 🟡 Masque IA copié sur une autre photo référence le PNG source (`params.ref` non réécrit au
      collage) — cassé silencieusement si la photo source est supprimée. **Fix** : côté serveur
      (`backend/app/routers/edits.py::_localize_ai_masks`, appelé par `save_edits`), tout masque IA
      dont le `ref` pointe vers une autre photo est copié sous la photo courante et `ref` réécrit —
      couvre tous les chemins de collage (masque seul, coller réglages, collage en lot) sans devoir
      dupliquer la logique côté client.
- [x] 🔴 `merge_edits` (`backend/app/pipeline.py`) ne validait pas le type des sections objet
      (`tone`/`wb`/`presence`/`detail`/`effects`/`geometry`) : une valeur scalaire/`None` reçue à
      la place d'un sous-dict (JSON corrompu en base, appel API mal formé) remplaçait le sous-dict
      par défaut au lieu d'être ignorée, et `apply_pipeline` plantait (`TypeError` non attrapée) à
      chaque rendu/export suivant de la photo. **Fix** : `merge()` retombe sur `default` dès que
      `default` est un dict et que `value` n'en est pas un ; test de régression ajouté
      (`test_malformed_section_falls_back_to_default`).
- [x] 🟠 Régénération asynchrone des thumbs/previews (`backend/app/previews.py::schedule_preview_refresh`) :
      la coalescence libère son drapeau `_refresh_pending` **au démarrage** du job (pour permettre
      la relecture des edits les plus récents), mais avec 2 workers (`ThreadPoolExecutor`) un job
      parti avec des edits périmés peut finir **après** un job plus récent et écraser sur disque
      son résultat plus frais — la grille affiche alors une vignette obsolète jusqu'à la prochaine
      sauvegarde. **Fix** : compteur de séquence par photo (`_refresh_seq`/`_refresh_written`),
      un job ne peut écrire que si son n° de séquence est ≥ celui du dernier job ayant déjà écrit ;
      tests de régression `backend/tests/test_previews.py`.
- [x] 🔴 Raccourcis chiffres (notes 0-5, labels couleur 6-9) inutilisables sur clavier AZERTY (et
      layouts similaires) : `frontend/src/keybindings.ts::normalizeEvent` ignorait Maj implicite
      sur la ponctuation (`?`) mais pas sur les chiffres — or sur AZERTY la rangée de chiffres ne
      produit le chiffre qu'**avec** Maj (touche physique « 1 » → `&` sans Maj, `1` avec Maj), donc
      aucune combinaison physique ne matchait `rate-1`..`rate-5`/`color-red`..`color-blue` par
      défaut. **Fix** : le garde « Maj ignoré » couvre désormais tout caractère simple non-lettre
      (ponctuation **et** chiffres), les lettres gardent Maj (ex. `Ctrl+Maj+C`) ; test de
      régression `frontend/tests/keybindings.test.ts`.
- [x] 🟠 Fuite de ressources GPU à chaque bascule de l'aperçu GPU (`frontend/src/gpu/useGpuPreview.ts`,
      effet `[active, canvasRef]`) : le `<canvas>` reste monté quand on désactive/réactive l'aperçu
      GPU (bouton dans `AdvancedMenu`), donc `canvas.getContext("webgl2")` renvoie le **même**
      contexte à chaque réactivation, et `new GpuPipeline(gl)` recrée un plein jeu de programmes/
      textures/FBO sans jamais libérer l'ancien jeu (`GpuPipeline` n'avait aucune méthode
      `dispose`). Désactiver/réactiver répétitivement épuise la mémoire GPU (peut aller jusqu'à la
      perte de contexte sur GPU modestes). **Fix** : `GpuPipeline.dispose()` (supprime programmes,
      textures dont RT/masques pinceau/IA, FBO, buffer du quad) appelé dans le nettoyage de l'effet
      avant de réinitialiser `pipeRef.current`.
- [x] 🟠 Molette de réglage fin sur les sliders d'édition (documentée comme faite dans CLAUDE.md
      §8 depuis le commit initial, mais jamais réellement codée : `frontend/src/components/EditSlider.tsx`
      n'avait aucun `onWheel`/listener `wheel`). Vérifié dans l'historique git (`git log -p` sur ce
      fichier depuis `66aa4ae`, aucune occurrence de "wheel" à aucune revision) : pas une régression,
      la fonctionnalité n'a jamais existé — le point de la checklist était faux depuis le début.
      **Fix** : listener natif non-passif sur l'input `range` (même pattern que le zoom molette de
      `ImageViewer.tsx`), un cran = un pas (`step`), coalescé en un seul point d'historique par
      geste via `startDrag`/`updateEditsLive`/`endDrag` différé (250 ms d'inactivité) — même
      mécanique que le drag à la souris, nettoyage au démontage pour ne jamais laisser un
      `dragBaseline` orphelin. `tsc`/`vite build`/suite de tests (85) verts ; **non vérifié
      visuellement en navigateur** (pas de Playwright/testing-library disponible dans cet
      environnement) — à confirmer manuellement à l'occasion.
- [x] 🟠 `frontend/src/lib/dialog.tsx` (`confirmDialog`/`promptDialog`, remplace `window.confirm`/
      `prompt`) : slot unique (`current`), pas une file — une 2ᵉ requête pendant qu'un dialogue est
      déjà affiché écrasait la 1ʳᵉ sans jamais résoudre sa promesse, bloquant l'appelant sur `await`
      indéfiniment (ex. `PresetsPanel::saveCurrent` qui ne créait alors jamais le preset, sans
      erreur visible ; ou Suppr appuyé deux fois vite via `shortcuts.ts`). **Fix** : vraie file
      (`queue: DialogRequest[]`), traitement FIFO, `advance()` au lieu d'un simple reset à `null`.
      `tsc`/`vite build`/suite de tests (85) verts.
- [x] 🟡 Piège de focus cassé quand la file de dialogues (`dialog.tsx`, cf. fix ci-dessus) enchaîne
      deux requêtes de nature différente sans démonter `DialogHost` (ex. un `promptDialog` de
      renommage suivi d'un `confirmDialog` de suppression mis en file) : `useFocusTrap` était
      appelé avec `req !== null` — ce booléen reste `true` d'une requête à l'autre, donc son effet
      (deps `[active]`) ne se rejoue pas : le focus initial n'est jamais reposé sur le nouveau
      contenu, et si l'`&lt;input&gt;` du prompt disparaît (bascule vers un confirm sans champ), le
      focus retombe sur `&lt;body&gt;` et le Tab s'échappe vers la page derrière la modale (régression
      clavier/accessibilité). **Fix** : `useFocusTrap` accepte désormais n'importe quelle valeur
      (pas seulement un booléen) et `DialogHost` lui passe l'objet-requête lui-même — son identité
      change à chaque nouvelle requête (même de même nature), ce qui force l'effet à se rejouer.
      `tsc`/`vite build`/suite de tests (85) verts.
- [x] 🟠 `src-tauri/src/lib.rs::run` (repéré par un audit précédent comme observation à confirmer) :
      si le sidecar backend (uvicorn empaqueté) ne répond pas dans les 20 s de `wait_for_port`,
      l'erreur n'était que **loguée** — la fenêtre webview s'ouvrait quand même sur une URL morte,
      laissant l'utilisateur face à une page blanche/erreur réseau sans explication, avec le
      sidecar potentiellement orphelin en arrière-plan. **Fix** : le process sidecar est tué
      explicitement, un dialogue natif d'erreur (`tauri_plugin_dialog`) explique le problème, puis
      l'app quitte proprement (`std::process::exit(1)`) au lieu d'ouvrir une fenêtre condamnée.
      Vérifié par `cargo check` (compile sans erreur) — pas de build Tauri complet effectué (pas
      testé en conditions réelles de sidecar en échec).
- [x] 🔴 Ctrl+Z/Ctrl+Maj+Z pendant un drag en cours (poignée de masque, crop, slider) corrompait le
      geste : `undo()`/`redo()` (`frontend/src/store.ts`) rétablissaient `edits` à un état antérieur
      et remettaient `dragBaseline` à `null` **pendant** que le drag continuait de muter `edits` par
      dessus cet état rétabli (via `updateEdits(fn, false)`, sauvegardé côté serveur à chaque
      mutation) — au relâchement, `endDrag()` ne trouvait plus de `dragBaseline` et ne posait donc
      **aucun** point d'historique pour tout le geste, tout en ayant déjà persisté l'état corrompu.
      **Fix** : `undo()`/`redo()` ignorent silencieusement l'appel tant qu'un drag est en cours
      (`dragBaseline !== null`) — le geste garde la responsabilité de son propre point d'historique.
      Test de régression `frontend/tests/store.test.ts`.
- [x] 🟡 Cache d'embedding EdgeSAM (masque IA au clic) périmé après relink : `segment._emb_cache`
      est clé par `geo_key(photo_id, geometry)` (géométrie, pas contenu du fichier). Après
      `PATCH /photos/{id}/relink` vers un fichier au contenu différent mais à la géométrie
      inchangée, un clic masque IA suivant réutilisait l'embedding calculé sur l'**ancien** contenu
      de l'image → masque positionné/formé pour la mauvaise image, sans erreur visible.
      **Fix** : `segment.invalidate(photo_id)` (purge toutes les clés `"{photo_id}:*"`) appelé
      depuis `previews.invalidate` (déjà déclenché par `relink`/suppression). Test de régression
      `backend/tests/test_previews.py`.
- [x] 🔴 Perte silencieuse d'une édition en attente (débounce 800 ms) en changeant de projet/album
      juste après une retouche : `saveNow()` (`frontend/src/store.ts`) abandonne si `currentId`
      est déjà `null` — or `setProject`/`setAlbum`/`deleteProject` (branche « projet courant
      supprimé ») remettaient `currentId` à `null` **sans** flusher d'abord une sauvegarde en
      attente (contrairement à `openDevelop`, qui le fait déjà). Retoucher un curseur puis changer
      de projet/album avant les 800 ms perdait la modification sans aucune erreur visible (`dirty`
      restait vrai indéfiniment). **Fix** : `await get().saveNow()` ajouté en tête de ces trois
      chemins, comme dans `openDevelop`. Tests de régression `frontend/tests/store.test.ts`.
- [x] 🟠 Masque pinceau : un point de coordonnée NaN/Infinity (edits corrompus en amont, bug côté
      client, édition manuelle de la DB) faisait planter `_brush_mask` (`backend/app/masks.py`) —
      `int(round(nan))` lève `ValueError`, `int(round(inf))` lève `OverflowError` — remontant en
      erreur 500 non gérée dans `/render` et `/export` : la photo devenait développement/export
      impossible en permanence, sans recours côté UI. **Fix** : helper `_finite()` coercit toute
      coordonnée/rayon non fini vers une valeur par défaut avant conversion en entier. Test de
      régression `backend/tests/test_pipeline.py::test_brush_handles_non_finite_points`.
- [x] 🟠 Double Suppr rapproché (2e dialogue mis en file pendant que la 1ʳᵉ suppression est encore
      en vol, cf. le fix de la file de dialogues ci-dessus) pouvait supprimer la **mauvaise** photo :
      `removeCurrent` (`frontend/src/store.ts`) relisait `currentId` **à la résolution** du
      dialogue plutôt qu'au moment de la demande, et `shortcuts.ts` ne figeait pas non plus la
      photo visée. Si la 1ʳᵉ suppression avait déjà avancé `currentId` vers la photo suivante
      quand l'utilisateur confirmait le 2e dialogue (texte identique, aucune indication du
      changement), le 2e `removeCurrent` supprimait cette photo suivante jamais distinctement
      confirmée ; sinon (1ʳᵉ suppression encore en vol) un 2e `DELETE` inutile partait pour la même
      photo. **Fix** : `removeCurrent(deleteFile, targetId)` accepte désormais l'id figé au moment
      de la demande (`shortcuts.ts` le capture avant `confirmDialog`), garde `removingIds` contre
      une suppression déjà en cours pour cet id, no-op si la photo visée a déjà disparu de la
      liste, et attrape l'erreur de `deletePhoto` (notification au lieu d'un rejet non géré).
      Tests de régression `frontend/tests/store.test.ts`.
- [x] 🟠 Même classe de bug que le masque pinceau (ci-dessus), étendue aux autres types de masque :
      un paramètre NaN/Infinity dans `linear`/`radial`/`lumrange`/`colorrange` (`backend/app/masks.py`)
      ne fait pas planter (pas d'`int()`/`round()` dans ces fonctions), mais se propage
      **silencieusement** — `np.clip(nan, ...)` reste `nan` — jusqu'au masque puis à l'image finale
      composée, produisant des pixels corrompus sans aucune erreur. **Fix** : les quatre fonctions
      utilisent désormais `_finite()` (le même helper ajouté pour le pinceau) sur chaque paramètre
      scalaire avant tout calcul. Test de régression
      `backend/tests/test_pipeline.py::test_linear_radial_lumrange_colorrange_handle_non_finite_params`.
- [x] 🟡 Feathering du pinceau : flou gaussien OpenCV (serveur) vs `blur()` CSS Canvas2D (GPU) —
      léger écart visuel possible sur gros traits/feather élevé, dépendant de l'implémentation
      navigateur de `filter:blur()` (parfois approximée par boîtes glissantes). **Fix (2026-07-29)** :
      `brushTexture` (`frontend/src/gpu/pipeline.ts`) rasterise désormais les traits non floutés sur
      Canvas2D, les upload en texture brute (`brushRawTex`, par id de masque), puis applique le même
      flou gaussien séparable GPU que le reste du pipeline (`this.blur()`, downscale=1 pour rester à
      pleine résolution) au lieu de `ctx.filter = blur()`. Toujours pas pixel-exact vs
      `cv2.GaussianBlur` (aucune des deux implémentations ne l'est), mais cohérence inter-navigateurs
      gagnée et même famille d'implémentation que le reste de l'aperçu GPU. `clearMaskTextures` ajusté
      pour ne plus supprimer directement une texture appartenant au pool de RT partagé (`this.rts`)
      quand `feather>0`, ce qui aurait cassé sa réutilisation par clé au flou suivant.
      `tsc`/`vitest` (90) et suite backend (87) verts.
- [x] 🟢 Arrondi géométrie straighten+crop : troncature Python (`int(...)`, `backend/app/pipeline.py`
      `apply_geometry:171-175`) vs `Math.round` GPU (`frontend/src/gpu/pipeline.ts`) — écart de
      l'ordre du pixel pouvant désaligner les masques locaux (coordonnées normalisées sur l'image
      recadrée) entre aperçu GPU et rendu serveur. **Fix (2026-07-29)** : `applyGeometry` calcule
      désormais `gw`/`gh` par troncature des bornes de recadrage (`x0`/`y0`/`x1`/`y1` en pixels,
      même formule que `apply_geometry`) au lieu d'un `Math.round` indépendant sur la largeur/hauteur
      fractionnaire ; le rectangle inscrit du redressement (`largestRotatedRect`) est également
      tronqué en entier (`Math.trunc`) avant d'servir de base au recadrage, comme `int(wr)`/`int(hr)`
      côté Python. `wrwh` (fenêtre d'échantillonnage UV) reste calculé sur les dimensions continues
      (fidélité du redressement), seule la dimension de sortie en pixels est désormais alignée.
      `tsc`/`vitest` (90) et suite backend (87) verts — pas de test de parité pixel dédié à la
      géométrie (`test_parity.py` ne couvre pas encore les ops à voisinage/géométrie, cf. N12),
      vérifié par lecture croisée des deux implémentations.
- [x] 🟠 Issue GitHub #40 « Espace pour se déplacer ne marche pas avec certains outils, notamment
      les masques » : `isTyping()` (`frontend/src/components/ImageViewer.tsx` et `shortcuts.ts`,
      deux copies dupliquées) traitait **tout** `<input>` focalisé comme de la saisie de texte —
      y compris les sliders (`type="range"`) omniprésents dans le panneau Local (taille de pinceau,
      feather…). Le focus reste sur le slider après un glisser ; Espace était donc avalé par
      `if (isTyping()) return;` tant qu'on n'avait pas recliqué ailleurs. **Fix** : `isTyping()`
      n'exclut plus que les vrais champs de saisie (texte/textarea/select/contentEditable) —
      liste blanche des types `<input>` non textuels (`range`, `checkbox`, `radio`, `button`,
      `color`, `file`, `submit`, `reset`) qui ne comptent plus comme « en train de taper ».
- [x] 🟠 Issue GitHub #43 « Masque prend trop le pas sur le reste, devrait être désélectionné si on
      va ailleurs » : `selectedLocalId` (surimpression rouge + poignées dans `ImageViewer`) restait
      actif indéfiniment une fois un masque sélectionné — même après avoir fermé l'accordéon
      « Local » pour retoucher un autre panneau, ou quitté le mode développement pour la
      bibliothèque. **Fix** : `PanelSection` accepte désormais un `onToggle(open)`, câblé dans
      `LocalPanel` pour désélectionner (`selectedLocalId: null, activeTool: "none"`) à la fermeture
      de la section ; `store.ts::setView` désélectionne également en quittant le développement.
- [x] 🔴 Issue GitHub #38 « Les paramètres ne persistent pas au redémarrage de l'app (thème,
      raccourcis clavier…) » : tous les réglages front (`rs.theme`, `rs.keybindings`, `rs.accent`…)
      sont bien écrits en `localStorage`, mais dans l'app Tauri empaquetée le sidecar backend
      démarre sur un **port TCP choisi au hasard** à chaque lancement (`pick_free_port()`,
      `src-tauri/src/lib.rs`) et la webview charge `http://127.0.0.1:{port}/` — `localStorage`
      étant scopé par origine (port compris), un port différent à chaque redémarrage repartait
      d'un stockage vide à chaque fois. **Fix** : `pick_port()` tente d'abord un port fixe
      (`PREFERRED_PORT = 47863`), et ne retombe sur `pick_free_port()` (aléatoire) que si ce port
      est indisponible (ex. une autre instance tourne déjà) — l'origine reste stable d'une session
      à l'autre dans le cas normal (une seule instance). `cargo check` vert.
- [x] Issue GitHub #32 « Harden local sidecar API surface (CORS, SPA path traversal) » : déjà
      corrigé antérieurement (`allow_origins` restreint + `guard_host` anti DNS-rebinding + garde
      `resolve()`/`is_relative_to` sur la route SPA catch-all dans `backend/app/main.py`) — vérifié
      et fermé le 2026-08-05, rien à coder.
- [x] Issue GitHub #23 « Inconsistent version numbers » : `frontend/package.json` (`1.0.0`) aligné
      sur `tauri.conf.json`/`Cargo.toml` (`0.1.0`, source de vérité — c'est lui qui pilote les tags
      de release `v*`).
- [x] Issue GitHub #22 « CI: actions forced onto deprecated Node 20 runtime » : `.github/workflows/
      release.yml` mis à jour vers les dernières majors (`actions/checkout@v7`,
      `actions/setup-node@v7` + `node-version: 24`, `actions/setup-python@v7`).
- [x] Issue GitHub #21 « Cargo build cache breaks when project folder is moved/renamed » : flag
      `-Clean`/`--clean` ajouté à `scripts/build-desktop.ps1`/`.sh` (purge ciblée de
      `src-tauri/target/{debug,release}/build/{tauri-*,app-*}`, chemins absolus périmés après un
      déplacement de dossier), documenté dans le README.

## Perf & robustesse backend (ex-`AMELIORATION.md` §6)

- [x] 🟡 N4 — Masques locaux : limiter le pipeline local à la **boîte englobante** du masque au lieu
      de traiter l'image entière par masque (`pipeline.py::_apply_local`). **Fait** : boîte
      englobante du masque (`_mask_bbox`) + halo ~3σ (HL/ombres, clarté, netteté — pour que le
      recadrage voie les mêmes pixels voisins que la pleine image) ; `_apply_hl_shadows`/
      `_apply_clarity` acceptent désormais `ref_long_edge` pour garder le même rayon de flou que
      sur l'image complète. Vérifié numériquement équivalent (écart ~1e-6, bruit float32).
- [x] 🟡 N5 — `_apply_color` : court-circuite désormais la conversion HSV quand seules
      saturation/vibrance sont utilisées (pas de bande HSL) — identité HSV à V et teinte fixes
      (`c' = c·r + V·(1-r)`), sans passer par `cv2.cvtColor` dans un sens ni l'autre. Bénéficie à
      chaque retouche locale (toujours `hsl={}`) et à `_apply_dehaze`. Golden de parité régénéré
      (écart ~1e-6, sous le seuil de test relâché ; comportement mathématiquement identique).
- [x] 🟡 N6 — **Export 16 bits** pour TIFF (PNG reste 8 bits : pas de writer RGB 16 bits fiable
      disponible sans dépendance lourde supplémentaire) — fait avec le point EXIF/ICC ci-dessus.
- [x] 🟢 N7 — Éviter le `deepcopy(DEFAULT_EDITS)` à chaque rendu (`merge_edits`). **Fait** : `merge()`
      reconstruit déjà récursivement chaque dict traversé (dict comprehension) — le deepcopy était
      inutile (aucune mutation en place des feuilles partagées ailleurs dans le pipeline).
- [x] 🟢 N8 — Mémoïser la LUT de courbe composée (`chan(master(x))`) au lieu de la recalculer à
      chaque rendu. **Fait** : `_composed_curve_luts` (lru_cache) mémoïse la composition complète
      par combinaison de courbes (maître + r/g/b).
- [x] 🟢 N9 — Cacher sur disque la base débruitée IA à l'export (évite de ré-inférer FFDNet à
      chaque export répété de la même photo). **Fait** : `previews.get_export_denoised_base`
      (cache disque `{id}.dnfull.npy`, distinct du cache aperçu dev qui est à `BASE_SIZE`),
      invalidé par `previews.invalidate` (relink/suppression) comme les autres caches.
- [x] 🟡 N10 — Test de parité automatisé rsfast (Rust) ↔ NumPy, étage par étage. **Fait** :
      `backend/tests/test_rsfast_parity.py`, 10 étages comparés directement (Rust vs NumPy, pas
      via le golden qui force `rsfast` hors-ligne) ; skip proprement si le binaire n'est pas
      compilé. Écarts mesurés ~1e-7 (epsilon float32) sur toutes les étages testées.
- [x] 🔴 N11 — Découper les gros fichiers. **Fait (2026-07-30)**, par extraction mécanique de blocs
      autonomes (constantes de données pures, types, sous-composants sans fermeture sur l'état du
      parent) — pas de réécriture d'architecture, zéro changement de comportement voulu, vérifié à
      chaque étape (`tsc`/pytest/vitest/`vite build` verts, taille du bundle JS identique au octet
      près avant/après : 428.59 kB). Découpages :
      - `gpu/pipeline.ts` (1096→725 lignes) : sources GLSL extraites vers `gpu/shaders.ts` (aucune
        dépendance sur l'état de `GpuPipeline`).
      - `store.ts` (994→811) : types (`interface Store`, `View`/`Tool`/`ToastType`) vers
        `storeTypes.ts`, historique (`historyTimeline`/`loadHistory`) vers `lib/storeHistory.ts`,
        session (`readSession`/`writeSession`) vers `lib/session.ts` — tous réexportés depuis
        `store.ts`, aucun appelant à toucher. Le corps du store (slice unique `create()`, closures
        partagées `liveRaf`/`removingIds`/`dragBaseline`) volontairement **pas** éclaté en slices
        multiples : trop de closures inter-actions pour un découpage sûr sans le chantier structurant
        que ce point de la checklist voulait justement éviter.
      - `backend/app/pipeline.py` (771→474) : primitives de fond (`luma`/`gauss`/`srgb_to_linear`/
        `_smoothstep`/`_wb_gains`) vers `pipeline_core.py`, géométrie vers `pipeline_geometry.py`,
        HSL/vibrance/saturation vers `pipeline_color.py`, clarté/dehaze/NR/défrange/netteté/
        vignettage/grain vers `pipeline_detail.py` — dépendances à sens unique (core ← color/geometry
        ← detail ← pipeline.py orchestrateur), pas de cycle d'import. Tout réexporté depuis
        `pipeline.py` (`pipeline.gauss`, `pipeline._apply_clarity`… utilisés tels quels par les tests
        de parité).
      - `ImageViewer.tsx` (623→389) : `ShapeOutline`/`MaskHandles`/`ClippingOverlay`/`CropOverlay`
        (sous-composants déjà autonomes, props uniquement) vers `ImageViewerOverlays.tsx`.
      - `LibraryView.tsx` (569→399) : `Collections`/`SelectionBar`/`Loupe`/`ExifOverlay` vers
        `LibraryPanels.tsx` (`ExifOverlay` réexporté, partagé avec `DevelopView.tsx`).
      Reste volontairement gros (pas retouché) : le corps du store et la classe `GpuPipeline`
      elle-même (état GL partagé, cache de RT par clé) — le risque de régression silencieuse sur ces
      parties reste réel, cf. l'avertissement initial de ce point.
- [x] N12 — Parité GPU↔Python sur les ops à voisinage. **Fait (2026-07-30)** : port CPU JS du flou
      GPU (`GpuPipeline.blur()` : downscale bilinéaire à facteur FIXE par site d'appel, bord CLAMP)
      dans `frontend/src/gpu/cpuNeighborhood.ts`, réutilisant `gaussianWeights` (exportée depuis
      `gpu/pipeline.ts`, pas réimplémentée) — couvre HL/ombres, clarté, netteté, défrange, NR chroma
      (dehaze et NR luminance/bilatéral restent hors périmètre, cf. ci-dessous). Golden Python
      (`backend/tests/test_parity_neighborhood.py`, champ synthétique déterministe recalculé
      identiquement des deux côtés — aucune donnée d'image sérialisée, seuls les résultats réduits
      par moyenne de blocs le sont, fixture ~230 Ko) comparé au port JS
      (`frontend/tests/parityNeighborhood.test.ts`, 11 cas). **Confirmé** : `pipeline.gauss()`
      (downscale par un facteur k dérivé du sigma, bord REFLECT) et le flou GPU (downscale fixe par
      site d'appel, bord CLAMP) sont deux approximations indépendantes, pas deux ports du même
      algorithme — écart mesuré 0.01–0.076 (pire cas : primitif de flou seul à σ=25, régime où
      Python choisit k=3 mais le GPU downscale toujours ×4) — divergence de **stratégie**
      d'approximation, pas un bug. **Reste hors périmètre** : dehaze (dark channel + érosion +
      percentile — pas juste un flou gaussien) et NR luminance (filtre bilatéral, noyau 2D pondéré
      par la différence de couleur — pas séparable comme le reste) ; les deux nécessiteraient un
      port dédié bien au-delà du flou gaussien partagé couvert ici. `tsc`/pytest (94)/vitest
      (105)/`vite build` verts.
- [x] ◑ B6 — Pagination de `GET /api/photos`. **Fait partiellement (2026-07-29)** : `limit`/`offset`
      optionnels ajoutés à `list_photos` (`backend/app/routers/photos.py`), **rétro-compatibles**
      (`limit=0` par défaut renvoie tout, comme avant, pas de clé `total` dans la réponse — le
      frontend actuel n'est pas touché). Avec `limit>0` : `COUNT(*)` sur la requête filtrée (avant
      `LIMIT`/`OFFSET`) renvoyé en `total`, pour qu'un futur frontend paginé n'ait pas besoin d'un
      second aller-retour. Index déjà en place côté DB (`idx_photos_captured`,
      `idx_photos_project_captured`). Test de régression `backend/tests/test_api.py::test_list_pagination`
      (page bornée, offset hors limites, cohérence page-par-page vs liste complète). **Reste
      différé** : le frontend continue de charger la liste complète (modèle de navigation — marquee,
      flèches, filmstrip — non repensé) ; c'est le refacto coordonné qui reste hors périmètre, pas
      la disponibilité backend.

## UX/UI (ex-`audituxui.md`, plan d'action condensé)

### Lot A — quick wins
**Ré-audit 2026-07-29 : tous les points de ce lot étaient déjà implémentés dans le code, la
checklist n'avait simplement pas été mise à jour au moment du travail. Vérifié fichier par fichier,
rien de restant ici.**
- [x] Focus clavier `:focus-visible` global — `frontend/src/styles.css:21-25`.
- [x] Icônes Copier vs Coller distinctes — `IconCopy`/`IconPaste` séparées, ex. `ContextMenu.tsx`.
- [x] `Δ`/`⚡ GPU` sortis vers le menu « Avancé » (debug), plus dans la barre principale —
      `DevelopView.tsx` (menu regroupant les outils de QA GPU↔Python).
- [x] Pas de duplication Import/Export : plus de « rail gauche » dans l'UI actuelle, un seul bouton
      par contexte (`HomeView`, toolbar bibliothèque, menu contextuel, bandeau sélection).
- [x] `title`/`aria-label` déjà posés sur puces couleur (`LibraryView.tsx`, `ContextMenu.tsx`) et
      boutons icône (undo/redo, reset section, paramètres…).
- [x] Ratios de recadrage unifiés dans `frontend/src/lib/cropAspects.ts` (source unique, utilisée
      par `CropBar` et `GeometryPanel`).
- [x] Indicateur de zoom cliquable (menu Ajusté/100 %/…) — `ImageViewer.tsx` (`zoom-indicator`/`zoom-menu`).
- [x] État ouvert/fermé des sections de panneau persisté en `localStorage` —
      `frontend/src/components/PanelSection.tsx` (`storageKey`, `rs.panelOpen.*`).

### Lot B — chantiers structurants
**Ré-audit 2026-07-29 : idem, déjà fait sauf mention contraire.**
- [x] Composant `Dialog`/`Prompt`/`Confirm` maison (`frontend/src/lib/dialog.tsx`, file FIFO) —
      plus aucun `window.prompt`/`confirm` ailleurs dans `frontend/src` (vérifié par recherche).
- [x] Toolbar bibliothèque : bouton « Filtres » qui regroupe note/drapeau/couleur/EXIF
      (`LibraryView.tsx`, `library.filtersTitle`), `flex-wrap` + media queries à 1100px/860px
      dans `styles.css`.
- [x] Boutons Undo/Redo visibles dans la toolbar développement (`DevelopView.tsx`) + bandeau
      d'actions sur sélection multiple dans la grille (`LibraryView.tsx::SelectionBar`).
- [x] Toasts empilables typés — `frontend/src/components/ToastStack.tsx`.
- [x] « Coller les réglages » + note/couleur déjà dans le menu contextuel de la grille
      (`ContextMenu.tsx` : `pasteEditsToSelection`, sous-menus rating/color/flag).
- [x] Accessibilité clavier des étoiles (`StarRating.tsx` : `role="button"`, `tabIndex`,
      Entrée/Espace, `aria-label`/`aria-pressed`).

### Lot C — cohérence & profondeur (moyen/long terme)
- [x] ◑ Set d'icônes SVG unifié (aujourd'hui mélange emoji / glyphes Unicode / SVG) + système de
      boutons rationalisé. **Avancé (2026-07-30)** : les glyphes `✕`/`✓` restants dans
      les vraies boîtes de dialogue/toasts (`Coachmark.tsx`, `GpuDiffDialog.tsx`, `ToastStack.tsx`,
      `ExportDialog.tsx`, `ModelsDialog.tsx`) remplacés par les composants `IconClose`/`IconCheck`
      déjà existants dans `frontend/src/icons/index.tsx` (même convention que `RelinkDialog`/
      `ImportPanel`/`ShortcutsOverlay`, qui utilisaient déjà ces icônes). **Complété (2026-08-06)** :
      les glyphes de boutons de toolbar restants (`⋯`/`❮❯`/`⛶`/`⚲`/`⚑`/`←`/`↑`) remplacés par de
      nouveaux composants SVG (`IconMore`, `IconChevron` + classe CSS `.chevron-flip` pour le
      replier de panneaux, `IconFullscreen`, `IconFilter`, `IconFlag`, `IconArrowLeft`,
      `IconArrowUp`) dans `DevelopView.tsx`, `LibraryView.tsx`, `LibraryPanels.tsx`,
      `SettingsView.tsx`, `ImportPanel.tsx`, `RelinkDialog.tsx`, `ContextMenu.tsx`. `tsc`/`vitest`
      (108)/`vite build` verts — pas de vérification visuelle en navigateur (pas de Chromium/
      Playwright disponible dans cet environnement), à confirmer manuellement à l'occasion.
      **Volontairement pas touché** : les badges superposés sur miniature
      (`★`/`⚑`/`✓`/`✎`/`⚠` dans `Filmstrip.tsx`/`LibraryView.tsx`) — positionnement/taille
      probablement calés sur la métrique du glyphe texte (font-size, text-shadow), et les glyphes
      de `DevOverlay.tsx` (panneau de profilage dev-only, F9, jamais vu par un utilisateur normal,
      hors périmètre d'un audit UX). Système de boutons rationalisé : non entamé.
- [ ] Réordonnancement des panneaux (Géométrie trop bas, Presets trop bas) + interrupteur
      d'activation par module (façon Darktable).
- [x] Onboarding/coach-marks (viewer, sélection multiple) + états vides harmonisés. **Déjà fait** :
      `frontend/src/components/Coachmark.tsx` (indice dismissible, persisté par clé en localStorage)
      utilisé dans `DevelopView.tsx` (`develop-viewer-controls`) et `LibraryView.tsx`
      (`library-multiselect`) ; `frontend/src/components/EmptyState.tsx` harmonisé (pas de photo,
      pas de résultat de recherche) dans les deux vues. La checklist n'avait simplement pas été
      mise à jour au moment du travail (commit `5ed461b`, « fix ergo »).
- [x] Écrêtage cliquable depuis l'histogramme : les deux puces d'écrêtage (`clip-dot`, ombres/hautes
      lumières) de `frontend/src/components/Histogram.tsx` sont désormais de vrais boutons qui
      basculent `showClipping` (même état que le raccourci `J`), au lieu d'être des indicateurs
      passifs — `aria-pressed`/anneau visuel quand actif. `tsc`/`vitest` (90) verts.
- [x] Plein écran (masquer les panneaux) : raccourci `F` (rebindable, registre `keybindings.ts`)
      + bouton toolbar (`DevelopView.tsx`), masque toolbar/bandeau manquant/filmstrip/colonne de
      panneaux, ne garde que le viewer (bouton flottant discret + Échap pour sortir, prioritaire
      sur l'outil actif). État transitoire (pas persisté, contrairement à `panelsCollapsed`).
      Test de régression `frontend/tests/shortcuts.test.ts`. `tsc`/`vite build`/tests (91) verts.
- [x] Recherche catalogue par nom de fichier : champ dans la toolbar bibliothèque (`filters.search`,
      client uniquement — pas de colonne indexée backend, la liste est déjà en mémoire côté
      frontend), filtre la grille, survit à « Réinitialiser les filtres » (comme le tri) mais se
      vide au changement de projet/album (comme les filtres EXIF). État vide dédié si 0 résultat.
      Tests de régression `frontend/tests/store.test.ts`. `tsc`/`vite build`/tests (92) verts.
- [x] Modèle de nommage à l'export : jetons `{name}`/`{seq}`/`{date}`/`{id}` (`ExportRequest.name_template`,
      `backend/app/routers/export.py::_render_name`), rétro-compatible (vide → comportement
      historique stem+suffix). `{seq}` suit l'ordre de la requête (pas l'ordre de complétion des
      workers parallèles de `/export/stream`, déterminé par `enumerate(rows, start=1)` avant le
      dispatch). Câblé dans `ExportDialog.tsx` (remplace le suffixe quand renseigné). Test de
      régression `backend/tests/test_api.py::test_export_name_template`. Suites backend (89) et
      frontend (92) + `vite build` verts.
- [x] Pipette HSL sur l'image : `POST /photos/{id}/hsl_pick` (`pipeline.hsl_band_from_point`,
      échantillonne le pipeline complet rendu, teinte la plus proche d'un centre de `HSL_BANDS`
      par distance circulaire) + bouton pipette dans `HSLPanel.tsx` (même style que la pipette WB),
      la bande désignée défile en vue et se surligne 2 s. N'applique rien elle-même (contrairement
      à la pipette WB), juste un raccourci pour trouver la bande. Tests de régression
      `backend/tests/test_pipeline.py`. Suites backend (91)/frontend (92) + `vite build` verts.
- [x] Glisser-réordonner dans un album : colonne `album_photos.position` (migrée, backfill à
      l'ordre d'insertion), `PATCH /albums/{id}/reorder`, tri `"custom"` (n'a de sens qu'avec
      `album_id`, ignoré sinon). Zones de dépose sur les cellules de la grille actives seulement
      en vue album et sans recherche active (n'entre pas en conflit avec le glisser-déposer
      existant vers la sidebar des albums — cibles DOM distinctes). Optimiste côté client, recharge
      depuis le serveur si l'appel échoue. Tests de régression backend
      (`test_api.py::test_album_manual_reorder`) et frontend (`store.test.ts`). Suites backend (93)
      /frontend (94) + `vite build` verts.
- [ ] 💡 Fonctionnalité manquante à considérer : avant/après côte à côte (split).
      **Lot C 💡 : tous les autres points ont été traités (2026-07-29) ; celui-ci reste le seul
      encore ouvert — non tenté car il demanderait de faire cohabiter deux rendus simultanés
      (avant + après) dans `ImageViewer`/`GpuPipeline`, alors que l'architecture actuelle ne
      produit qu'un seul flux affiché à la fois (bascule, pas rendu double) ; chantier à part
      entière, pas un quick win.**
- [x] Passe responsive complète (laptop 1280×800) + `prefers-reduced-motion` + focus-trap sur les
      modales. **Ré-audit 2026-07-30** : `prefers-reduced-motion: reduce` déjà géré
      (`frontend/src/styles.css:26` et `:1077`) ; focus-trap déjà en place sur toutes les vraies
      modales via le composant partagé `Modal.tsx`/`useFocusTrap` (`ExportDialog`, `ImportPanel`,
      `ModelsDialog`, `RelinkDialog`, `ShortcutsOverlay`, `GpuDiffDialog`, `DialogHost`) — les menus
      contextuels (`ContextMenu`/`ProjectMenu`, popups transitoires fermés au clic extérieur) en
      sont volontairement exclus, ce ne sont pas des dialogues modaux. Pour le seuil 1280×800 :
      toolbars déjà `flex-wrap` (`styles.css:100`), colonne de panneaux développement (308px) +
      rail (66px) laissent ~900px au viewer à 1280px de large (le repli en recouvrement ne se
      déclenche qu'en dessous de 1100px, volontairement sous la cible) ; grilles bibliothèque/accueil
      en `grid`/`auto-fill` donc déjà fluides sans media query dédiée. **Vérifié par lecture du CSS
      uniquement** (pas d'outil de capture de navigateur disponible dans cet environnement) — à
      confirmer visuellement à l'occasion sur un vrai poste 1280×800.

## Roadmap infra/produit (voir `docs/infra-architecture.md`, tenu à jour séparément avec son diagramme)

- [x] #1 — Correcteur de taches, **en inpainting IA (MI-GAN)** — pas un tampon de clonage
      classique (une première version en tampon de clonage a été livrée puis jugée insuffisante
      visuellement, retirée). **Fait (2026-08-02)**, **réimplémenté (2026-08-05, issue #41 : le
      premier commit avait supprimé la feature)** avec deux corrections trouvées à la
      réimplémentation :
      1. **Outil pinceau, plus un cercle fixe au clic** : le masque `inpaint` utilise désormais la
         même forme que le masque `brush` (traits/rayon peints à la souris, `masks.py::build_mask`
         appelle `_brush_mask`) au lieu d'un cercle radial de taille fixe posé au clic — on peint
         la zone à effacer, forme libre, comme un vrai correcteur (`ImageViewer.tsx`, mode "brush"
         partagé entre pinceau de retouche locale et correcteur IA ; côté GPU, `maskKind` route
         "inpaint" vers le même chemin texture-pinceau que "brush", `pipeline.ts`/`shaders.ts`).
      2. **Bug corrigé : artefact blanc délavé sur la zone corrigée** (« rond blanc », signalé par
         l'utilisateur, reproduit et diagnostiqué visuellement). Cause identifiée empiriquement par
         comparaison directe des sorties du modèle ONNX : un masque au bord adouci (feather, valeurs
         intermédiaires 0..1) fait sortir MI-GAN en mode dégradé malgré la documentation du modèle
         affirmant gérer un fondu en interne — un masque binaire (0/1) donne un résultat propre.
         **Fix** : `routers/edits.py::inpaint_spot` binarise le masque (seuil 0.5) avant l'appel à
         `inpaint.inpaint()` ; le fondu du bord reste appliqué séparément au compositing
         (`pipeline._apply_inpaint`, masque feathered rebâti depuis les mêmes traits). Inférence
         faite sur l'image de travail ENTIÈRE (pas un recadrage serré autour du trait comme avant —
         MI-GAN gère déjà son propre contexte/padding interne), seule une zone paddée du résultat
         est stockée en PNG. Test de régression `backend/tests/test_api.py::test_inpaint_binarizes_mask_before_inference`
         (mock du moteur, vérifie que le masque reçu est binaire malgré un feather=0.8 en entrée).
         Suites backend (100) et frontend (108) + `tsc`/`vite build` verts.
      Détails d'origine (2026-08-02), toujours valables : masque local `inpaint`, l'IA devine le
      contenu (pas de point source manuel), `backend/app/inpaint.py` (ONNX CPU, calqué sur
      `segment.py`/`denoise.py`, dégrade proprement si le modèle est absent), endpoint
      `POST /photos/{id}/inpaint` (calcule le patch une fois, le stocke en PNG, rejoué tel quel à
      chaque rendu — même principe que les masques IA sujet/clic), aperçu GPU temps réel, câblage
      `ModelsDialog`/`/automask/available`. Modèle : export ONNX officiel `migan.onnx`
      (`andraniksargsyan/migan` sur Hugging Face, dépôt `Picsart-AI-Research/MI-GAN`, ICCV 2023)
      — signature réelle introspectée (image/masque uint8, résolution dynamique, contexte géré en
      interne par le pipeline officiel) et testée en local avant mise en ligne. **Hébergé** sur
      `RawZeroModelsDownload` (taille/SHA-256 épinglés dans `models.py`) — la feature est
      utilisable dès que l'utilisateur le télécharge via `ModelsDialog`.
- [x] #5 — Finalisation des liens de téléchargement des modèles IA. **Fait et fermé sur GitHub** :
      `backend/app/routers/models.py::FEATURES` a bien les 4 features (subject/point/denoise/inpaint)
      avec taille + SHA-256, hébergées sur le repo dédié `RawZeroModelsDownload`. Vérifié 2026-08-05.
- [x] #6 — Export en un clic. **Fermée sur GitHub** ; le code garde une modale à chaque export (seul
      le dossier de destination est mémorisé), donc pas littéralement "un clic sans modale" — l'écart
      a été relevé et le choix (2026-08-05) est de **laisser fermée telle quelle**, le confort actuel
      (dossier mémorisé + export streamé) est jugé suffisant. Ne pas rouvrir sans nouvelle demande
      explicite.
- [ ] #3 — `licensing.can()`, cache de licence hors-ligne, plans/capabilities (paiement explicitement
      hors scope).
- [ ] #8–#11 — Site marketing (identité visuelle → site → hébergement), rien de construit.
- [ ] #12 — Mise en place du serveur de licensing (dépend de #3).
- [ ] #13 — Installeur macOS (.dmg) : ajouter une cible `dmg`/`app` dans `src-tauri/tauri.conf.json`
      (aujourd'hui seulement `nsis`/`deb`/`rpm`), build/signature/notarization, publication CI.
- [ ] #16 — Mettre en place des runners self-hosted (local) + définir les cas d'usage (vs runners
      GitHub hébergés).
- [ ] #18 — Page de connexion obligatoire (compte + emplacement de stockage) — dépend de #3/#12.
- [ ] #27 — Import de preset visuel global / thème custom pour l'appli (aujourd'hui seulement 4
      thèmes intégrés en dur dans `frontend/src/theme.ts` : dark/light/warm/cold).
- [ ] #28 — Fondations infra Cloudflare (Workers, D1, R2, KV, Pages) — prérequis des chantiers
      Phase 2 (#12, #11, #29, #31).
- [ ] #29 — Service de version/update (remplace GitHub Releases, bloqué par le repo privé pour les
      clients finaux).
- [ ] #30 — Vérification d'entitlement hors-ligne côté Rust/Tauri (Ed25519) + empreinte machine +
      keychain (le sidecar Python seul est contournable).
- [ ] #31 — Portail compte sur le site (login, licences, appareils).
- [ ] #35 — Outil de tri de photos externe importable dans l'app (TriZero — dépôt séparé, hors de
      ce repo, cf. CLAUDE.md §8 pour le lien déjà câblé côté RawZero).
- [ ] #42 — Rajouter les extensions (TriZero…) en téléchargement optionnel dès l'installateur.

**Note** : #28–#31 et #18 référencent `docs/phase2-design.md` / `docs/phase2-architecture.md`,
absents de ce repo au 2026-08-05 (pas encore committés ou détenus ailleurs) — à récupérer avant de
démarrer ce cluster.

## UX des masques locaux (2026-08-10)

- [x] **Overlay rouge des masques locaux, refondu** — l'utilisateur trouvait le lavis rouge
  (`mix(img, red, m*0.6)`) présent en continu dès qu'un masque était sélectionné, obscurcissant
  l'image l'essentiel du temps (il ne disparaissait que pendant le drag d'un slider + 350 ms).
  Cause identifiée dans le code : `showMaskOverlay` était une bascule collante, remise à `true`
  **de force** à chaque création de masque (IA, plage, dupliqué/collé), donc même le raccourci O
  ne « tenait » pas dans la durée. Recherche rapide sur Lightroom Classic (touche O = bascule,
  Maj+O = couleur, préférence « Automatically Toggle Overlay » = survol de l'icône du masque dans
  le panneau) et Capture One (masque visible **seulement pendant qu'on le dessine**, rappelable
  par M, + vue niveaux de gris séparée Alt+M) : aucun des deux ne laisse le lavis collé à la
  sélection. Direction retenue avec l'utilisateur : **survol de la liste = aperçu, disparition
  automatique**.
  **Fait** : `showMaskOverlay` (booléen collant) remplacé par `hoveredLocalId` (survol d'une
  ligne de `LocalPanel::local-list`, disparaît dès qu'on quitte la ligne — `onMouseEnter`/`Leave`
  + `onFocus`/`Blur` pour le clavier) et `flashLocalId` (aperçu ponctuel auto-masqué après 900 ms,
  `store.ts::flashMaskOverlay`, déclenché à la création/collage d'un masque et par la touche O
  repensée en aperçu au lieu de bascule, `shortcuts.ts`). Le bouton « Aperçu (O) » du panneau Local
  déclenche le même flash. `ImageViewer.tsx`/`DevelopView.tsx` calculent `maskOverlayId` à partir
  de `hoveredLocalId ?? flashLocalId` (plus jamais un état qui reste affiché en continu). Le hook
  `useMaskSuppressed` (suppression pendant le drag d'un slider) n'avait plus de raison d'être dans
  ce nouveau modèle — supprimé (`frontend/src/lib/useMaskSuppressed.ts`). Indicateur visuel discret
  (liseré rouge) sur la ligne survolée dans la liste (`styles.css::.local-list li.previewing`).
  Tests : `frontend/tests/store.test.ts` (`flashMaskOverlay`), `frontend/tests/shortcuts.test.ts`
  (touche O). Suites vertes (114 frontend, 106 backend + 1 skip), `tsc`/`vite build` OK.
  **Pas fait, à discuter séparément si besoin** : la vue « masque seul en niveaux de gris »
  façon Capture One (Alt+M) — utile pour vérifier la couverture exacte d'un masque IA/pinceau
  complexe sans lavis coloré, mais nécessiterait un mode de rendu GPU dédié (pas juste un
  changement d'état UI) ; non demandé explicitement, à envisager si le nouveau système d'aperçu
  s'avère encore insuffisant pour ce cas d'usage précis.

## Idées annexes

### Masques additionnels & sources de lumière artificielle (recherche 2026-08-06)

Piste demandée par l'utilisateur : enrichir les retouches locales (`backend/app/masks.py`,
`frontend/src/panels/LocalPanel.tsx`, `frontend/src/gpu/pipeline.ts`) au-delà de l'existant
(linéaire, radial, pinceau, IA sujet/ciel/clic, plages luminance/couleur, inpainting IA). **Phase
recherche/planification seulement — rien à implémenter tant que non explicitement demandé.**

**État de l'art (comparatif marché)** :
- Lightroom Classic : en plus de l'existant RawZero, propose des masques **Personnes** détaillés
  (sous-parties : peau visage/corps, sourcils, sclère, iris, lèvres, dents, cheveux) et un masque
  par **plage de profondeur** (carte IA monoculaire type Sensei, exploitable même sans capteur de
  profondeur natif).
- DxO PhotoLab : **Control Points / U Point** (technologie Nik) — un clic pose un point, extension
  de la sélection par similarité couleur/texture/luminance locale, pas de masque à dessiner
  explicitement.
- Luminar Neo : **Relight AI / Light Depth** — carte 3D de la scène, sliders *Brightness Near/Far*
  + curseur de transition de profondeur (relighting basé profondeur, pas une vraie source
  ponctuelle positionnable). Outil séparé **Sunrays** : effet génératif de rayons de soleil
  100 % procédural (position cliquée, longueur/nombre de rayons, rayon du glow, chaleur en
  kelvin, *pénétration* = occlusion par les objets de la scène).
- Affinity Photo : dégradés multi-stops / mesh gradient (plutôt design vectoriel, faible valeur
  pour du RAW photo).

Sources : [Adobe – Masking Lightroom Classic](https://helpx.adobe.com/lightroom-classic/help/masking.html),
[People masks](https://thelenslounge.com/how-to-mask-in-lightroom-classic/),
[DxO U Point](https://www.dxo.com/dxo-photolab/u-point/),
[Skylum Relight AI / Light Depth](https://manual.skylum.com/neo/en/topic/relight-ai-tool),
[Skylum Sunrays](https://support.skylum.com/editing-tools/landscape-tools/sunrays),
[Depth Anything V2 ONNX (benchmarks CPU)](https://github.com/fabio-sim/Depth-Anything-ONNX/issues/26),
[Affinity mesh gradients](https://www.affinity.studio/help/clr-gradient-mesh/).

**Pistes concrètes, classées par effort croissant** :

1. [x] **Source de lumière artificielle « physique »** (nouveau type de masque `light`) — **fait
   (2026-08-09)**, aucun nouveau modèle IA. `masks.py::_light_mask` réutilise la géométrie ellipse
   du radial (`cx/cy/rx/ry/angle/feather`) mais avec un falloff photométrique
   `1/(1+(falloff·distance)²)` au lieu d'un simple smoothstep (nouveau paramètre `falloff`,
   défaut 1.8), pic d'intensité franc au centre façon vraie source ponctuelle. Équivalent GLSL
   dans `gpu/shaders.ts` (`MASK_GLSL`, `u_kind==6`) + `gpu/pipeline.ts` (`maskKind`, uniform
   `u_lightFalloff` sur `lblend`/`maskovl`). Outil dans `LocalPanel` (glisser comme le radial,
   réutilise `MaskHandles`/`ShapeOutline` sans duplication), démarre avec un préréglage utile
   (exposition +1 EV, température +20 = plus chaud) au lieu d'un masque neutre. Slider
   « Concentration » (falloff, 0.2–5) ajouté au panneau. Tests : `backend/tests/test_pipeline.py`
   (`TestMasks::test_light_*`, falloff/non-finite), `frontend/tests/types.test.ts` (normalisation
   du type `light` par `mergeEdits`).
2. [x] ~~Effet « rayons de soleil » cliquable~~ — **implémenté puis supprimé (2026-08-09)**, à la
   demande explicite de l'utilisateur après essai (rendu jugé mauvais visuellement — « immonde »,
   a dégoûté de l'idée). Tout le code a été retiré (`pipeline_detail.py::_apply_sunrays`,
   `effects.sunrays` dans `EditState`/`DEFAULT_EDITS`, uniforms GPU dans `F_FINAL`, panneau
   Effets, tests). **Ne pas réintroduire cette implémentation telle quelle** si l'idée revient un
   jour — repartir d'un nouveau design (l'approximation d'occlusion par luminance seule, sans
   vraie carte de profondeur, est probablement ce qui rendait le rendu peu convaincant).
3. [x] **Masque par plage de profondeur** (`depthrange`) — **fait (2026-08-09)**, modèle poussé sur
   `RawZeroModelsDownload` (commit `102d2cb`, https://github.com/rawzerodevteam/RawZeroModelsDownload)
   après confirmation explicite de l'utilisateur — vérifié en ligne (taille + SHA-256 identiques au
   fichier local). Utilisable dès que l'utilisateur le télécharge via `ModelsDialog`.
   Modèle : Depth Anything V2 Small quantifié, licence Apache-2.0, ~26 Mo,
   `onnx-community/depth-anything-v2-small` sur Hugging Face — téléchargé et vérifié en local
   (charge + infère via `onnxruntime`/CPU, ~300-480 ms/image, testé sur une vraie photo du
   catalogue avec un résultat de profondeur cohérent visuellement), SHA-256
   `fcf51f1b230362b28690bb9d1809bf0431f29cad20534e3f589bd7285547f20d`.
   Implémenté : `backend/app/depth.py` (mêmes conventions que `segment.py` : `available()`,
   `model_path()`, dégrade proprement si le modèle est absent), `masks.py::_depthrange_mask`
   (seuillage lissé near/far/smooth sur la carte cachée, même pattern que `_lumrange_mask` — bitmap
   PNG rechargé via un nouveau helper partagé `_load_ref_png`, factorisé avec `_ai_mask`),
   `routers/edits.py` (`automask?kind=depth`, `_store_depth_mask`, `_localize_ai_masks` étendu à
   `depthrange` pour le copier/coller entre photos), `routers/models.py` (feature `depth` dans le
   manifest de téléchargement). Frontend : bouton « Profondeur » dans `LocalPanel` (à côté de
   Sujet/Ciel), sliders Proche/Lointain/Transition, masque GPU `u_kind==7` dans
   `gpu/shaders.ts`/`pipeline.ts` (réutilise la texture IA + les uniforms `u_lr` de `lumrange`),
   `ModelsDialog`, i18n complet. Tests : `backend/tests/test_pipeline.py`
   (`test_depthrange_*`), `frontend/tests/types.test.ts`. Suites vertes : 106 tests backend + 1
   skip, 110 frontend, `tsc`/`vite build` OK.
4. [ ] **Relight par profondeur** façon Luminar Light Depth — effort faible maintenant que la
   piste 3 est en place : un outil « Brightness proche/lointain » n'est jamais qu'un masque
   `depthrange` avec `exposure` ajusté sur le mini-pipeline déjà existant des retouches locales
   (`LocalAdjust.adjust`) — utilisable dès aujourd'hui sans code supplémentaire (créer un masque
   profondeur, ajuster son exposition). Un vrai outil dédié à deux plages simultanées
   (proche + lointain d'un coup, façon Luminar) resterait un **plus** mais n'est plus bloquant.
5. [ ] **Masques « Personnes » détaillés** (peau, cheveux, vêtements par sous-partie) — effort le
   plus élevé, pas commencé. Nécessite un modèle de human-parsing dédié (type SCHP/CIHP), plus
   lourd et multi-classes que U²-Net (déjà utilisé pour le masque sujet générique). À réserver
   pour une itération ultérieure si l'usage portrait le justifie clairement.
6. [x] **Dégradé réfléchi / mesh gradient** (façon Affinity) — écarté, faible valeur pour un usage
   RAW photo (surtout pertinent en design vectoriel). Décision finale, pas une tâche restante.

## Portage Rust — pas de todo actif

`transfert_rust.md` (archivé, cf. `CLAUDE.md §12`) concluait à **ne pas réécrire le backend en
Rust intégralement** : le chemin chaud est déjà GPU/C (WebGL2, OpenCV, LibRaw, ONNX), le gain net
serait modéré face au coût de revalidation pixel-exacte du pipeline. Si un besoin de performance
précis et mesuré apparaît un jour, revoir l'option ciblée (extension Rust via PyO3/maturin sur un
hot spot précis) plutôt que rouvrir ce chantier en l'état.
