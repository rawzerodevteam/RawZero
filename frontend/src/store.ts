import { create } from "zustand";
import { api } from "./api";
import { ALL_PHOTOS_ID, defaultEdits, mergeEdits, type EditState, type Photo, type Project } from "./types";
import { describeEditChange } from "./lib/historyLabel";
import { cloneLocalMask } from "./lib/localMask";
import { historyTimeline, loadHistory, originLabel } from "./lib/storeHistory";
import { readSession, writeSession } from "./lib/session";
import type { Store, View } from "./storeTypes";
import i18n from "./i18n";

export { historyTimeline };
export * from "./storeTypes";

let nextToastId = 1;

// Nom du projet par défaut créé côté backend (db.py) : on le ré-étiquette à l'affichage selon
// la langue. Un projet renommé par l'utilisateur ne correspond plus et garde son nom.
const DEFAULT_PROJECT_NAME = "Projet par défaut";

let saveTimer: number | undefined;

// Suppressions en cours (par id) : empêche une double confirmation rapprochée (deux Suppr avant
// que la 1ʳᵉ boîte de dialogue ne se ferme, cf. la file de `dialog.tsx`) de déclencher un second
// DELETE pour la même photo, ou — pire — de supprimer la photo suivante si `currentId` a déjà
// avancé pendant que la 1ʳᵉ suppression était encore en vol.
const removingIds = new Set<number>();

// Coalescing des mises à jour « live » d'un drag de slider sur une frame d'animation.
// onChange d'un <input range> peut tirer plusieurs fois par frame (souris haute fréquence) ;
// chaque appel ferait un structuredClone(edits) + set Zustand → re-rendu de TOUS les panneaux.
// On ne garde que la dernière mutation et on l'applique une fois par rAF (aligné sur le rendu GPU).
let liveRaf: number | undefined;
let liveFn: ((e: EditState) => void) | null = null;

// Découplage total GPU↔store pendant un drag de slider. Quand l'aperçu GPU est actif, il enregistre
// ici une fonction de rendu IMPÉRATIF. Pendant un drag, on mute alors `edits` EN PLACE (zéro clone,
// zéro setState → React reste figé) et on rend directement le canvas via ce callback. Hors aperçu
// GPU (mode serveur), `liveRender` reste null → on retombe sur le chemin clone+setState (le rendu
// serveur débouncé a besoin que `edits` change pour rafraîchir l'aperçu pendant le drag).
let liveRender: ((e: EditState) => void) | null = null;
/** Branché par useGpuPreview quand l'aperçu GPU est actif ; débranché sinon (passe null). */
export function registerLiveRender(fn: ((e: EditState) => void) | null) { liveRender = fn; }

export const useStore = create<Store>((set, get) => ({
  projects: [],
  currentProjectId: null,
  albums: [],
  currentAlbumId: null,
  photos: [],
  filters: { minRating: 0, flag: "", color: "", sort: "captured_asc",
             camera: "", lens: "", isoMin: 0, isoMax: 0, dateFrom: "", dateTo: "", search: "" },
  facets: { cameras: [], lenses: [] },
  currentId: null,
  view: "grid",
  previousView: "home" as View,

  selection: [],
  exportIds: null,
  contextMenu: null,

  edits: null,
  dirty: false,
  undoStack: [],
  redoStack: [],
  undoLabels: [],
  redoLabels: [],
  currentLabel: originLabel(),
  dragBaseline: null,
  clipboard: null,
  localClipboard: null,
  editsVersion: {},

  gridSize: (() => { const v = Number(localStorage.getItem("rs.gridSize")); return v >= 120 && v <= 520 ? v : 260; })(),
  beforeAfter: false,
  showClipping: false,
  showInfo: false,
  showHelp: false,
  showImport: false,
  showExport: false,
  showModels: false,
  showAlbums: false,
  panelsCollapsed: localStorage.getItem("rs.panelsCollapsed") === "1",
  fullScreen: false,
  hslPickedBand: null,
  relinkTargetId: null,
  activeTool: "none",
  selectedLocalId: null,
  showMaskOverlay: true,
  brushSize: 0.08,
  brushErase: false,
  cropAspect: null,
  aiSubjectAvailable: false,
  aiSkyAvailable: false,
  aiPointAvailable: false,
  aiDenoiseAvailable: false,
  aiInpaintAvailable: false,
  aiMaskBusy: false,
  inpaintBusy: false,
  toasts: [],
  seenHints: (() => {
    try { return JSON.parse(localStorage.getItem("rs.seenHints") || "{}"); } catch { return {}; }
  })(),
  panelOrder: (() => {
    try { return JSON.parse(localStorage.getItem("rs.panelOrder") || "[]"); } catch { return []; }
  })(),

  // Au démarrage : page d'accueil (projets) par défaut, ou reprise de la dernière session.
  async init() {
    const saved = readSession();
    if (saved.projectId !== null) set({ currentProjectId: saved.projectId });
    await get().loadProjects();
    await get().loadAlbums();
    await get().loadPhotos();
    // Rouvre l'app là où on l'a laissée (si la photo existe toujours dans le projet courant).
    if (saved.photoId !== null && get().photos.some((p) => p.id === saved.photoId)) {
      if (saved.view === "develop") {
        await get().openDevelop(saved.photoId);
      } else {
        set({ currentId: saved.photoId, selection: [saved.photoId], view: saved.view === "home" ? "grid" : saved.view });
      }
    } else {
      // Pas de photo à rouvrir → écran d'accueil listant les projets.
      set({ view: "home" });
    }
    void get().refreshAiAvailability();
  },

  async refreshAiAvailability() {
    const a = await api.autoMaskAvailable();
    set({ aiSubjectAvailable: a.subject, aiSkyAvailable: a.sky,
          aiPointAvailable: a.point, aiDenoiseAvailable: a.denoise,
          aiInpaintAvailable: a.inpaint });
  },

  async loadProjects() {
    const real = (await api.listProjects()).map((p) =>
      p.name === DEFAULT_PROJECT_NAME ? { ...p, name: i18n.t("library.defaultProject") } : p);
    // Projet virtuel « Toutes les photos » : regroupe tout le catalogue (project_id = 0 côté API).
    const total = real.reduce((n, p) => n + (p.count ?? 0), 0);
    const cover = real.find((p) => p.cover)?.cover ?? null;
    const all: Project = { id: ALL_PHOTOS_ID, name: i18n.t("library.allPhotos"), count: total, cover };
    const projects = [all, ...real];
    let cur = get().currentProjectId;
    if (cur === null || !projects.some((p) => p.id === cur)) cur = ALL_PHOTOS_ID;
    set({ projects, currentProjectId: cur });
  },

  async setProject(id) {
    if (id === get().currentProjectId && get().currentAlbumId === null) return;
    await get().saveNow(); // flush toute édition en attente (débounce 800 ms) avant de perdre currentId
    set({
      currentProjectId: id, currentAlbumId: null, currentId: null, selection: [], view: "grid",
      filters: { ...get().filters, camera: "", lens: "", isoMin: 0, isoMax: 0, dateFrom: "", dateTo: "", search: "" },
    });
    await get().loadPhotos();
  },

  async createProject(name) {
    const p = await api.createProject(name);
    await get().loadProjects();
    await get().setProject(p.id);
  },

  async renameProject(id, name) {
    await api.renameProject(id, name);
    set({ projects: get().projects.map((p) => (p.id === id ? { ...p, name } : p)) });
  },

  async deleteProject(id) {
    const wasCurrent = get().currentProjectId === id;
    if (wasCurrent) await get().saveNow(); // flush avant de perdre currentId (cf. setProject)
    await api.deleteProject(id);
    await get().loadProjects();
    if (wasCurrent) {
      const next = get().projects[0]?.id ?? null;
      set({ currentProjectId: next, currentId: null, selection: [], view: "grid" });
      await get().loadPhotos();
    }
  },

  async loadPhotos() {
    const photos = await api.listPhotos(get().filters, get().currentProjectId, get().currentAlbumId);
    const ids = new Set(photos.map((p) => p.id));
    set({ photos, selection: get().selection.filter((id) => ids.has(id)) });
    const { currentId } = get();
    if (currentId !== null && !ids.has(currentId)) {
      set({ currentId: photos.length ? photos[0].id : null });
    }
    void get().loadFacets();   // valeurs distinctes caméra/objectif du contexte (refresh post-import)
  },

  async loadFacets() {
    try {
      set({ facets: await api.getFacets(get().currentProjectId, get().currentAlbumId) });
    } catch { /* non bloquant */ }
  },

  async loadAlbums() {
    try {
      set({ albums: await api.listAlbums() });
    } catch { /* non bloquant */ }
  },

  async setAlbum(id) {
    await get().saveNow(); // cf. setProject : ne pas perdre une édition en attente
    set({
      currentAlbumId: id, currentId: null, selection: [], view: "grid",
      filters: { ...get().filters, camera: "", lens: "", isoMin: 0, isoMax: 0, dateFrom: "", dateTo: "", search: "" },
    });
    await get().loadPhotos();
  },

  async createAlbum(name) {
    try {
      const a = await api.createAlbum(name);
      await get().loadAlbums();
      return a.id;
    } catch (e) {
      get().notify(e instanceof Error ? e.message : "Échec de création de l'album", "error");
      return null;
    }
  },

  async renameAlbum(id, name) {
    try {
      await api.renameAlbum(id, name);
      await get().loadAlbums();
    } catch (e) {
      get().notify(e instanceof Error ? e.message : "Échec du renommage", "error");
    }
  },

  async deleteAlbum(id) {
    await api.deleteAlbum(id);
    if (get().currentAlbumId === id) { set({ currentAlbumId: null }); await get().loadPhotos(); }
    await get().loadAlbums();
  },

  async addToAlbum(id, photoIds) {
    if (!photoIds.length) return;
    const res = await api.addToAlbum(id, photoIds);
    await get().loadAlbums();
    const album = get().albums.find((a) => a.id === id);
    get().notify(`${photoIds.length} photo${photoIds.length > 1 ? "s" : ""} ajoutée${photoIds.length > 1 ? "s" : ""} à « ${album?.name ?? "album"} » (${res.count})`);
  },

  async removeFromAlbum(id, photoIds) {
    if (!photoIds.length) return;
    await api.removeFromAlbum(id, photoIds);
    await get().loadAlbums();
    if (get().currentAlbumId === id) await get().loadPhotos();
  },

  async reorderAlbumPhotos(orderedIds) {
    const albumId = get().currentAlbumId;
    if (albumId === null) return;
    // Optimiste : réordonne la liste affichée tout de suite (et bascule sur le tri "custom",
    // seul capable de refléter l'ordre manuel — cf. photos.py) sans attendre le round-trip.
    const byId = new Map(get().photos.map((p) => [p.id, p]));
    const reordered = orderedIds.map((id) => byId.get(id)).filter((p): p is Photo => !!p);
    set({ photos: reordered, filters: { ...get().filters, sort: "custom" } });
    try {
      await api.reorderAlbum(albumId, orderedIds);
    } catch (err) {
      get().notify(i18n.t("notify.reorderFailed", { error: String(err) }), "error");
      await get().loadPhotos(); // revient à l'ordre serveur en cas d'échec
    }
  },

  setFilters(p) {
    set({ filters: { ...get().filters, ...p } });
    void get().loadPhotos();
  },

  resetFilters() {
    set({ filters: { minRating: 0, flag: "", color: "", sort: get().filters.sort,
                     camera: "", lens: "", isoMin: 0, isoMax: 0, dateFrom: "", dateTo: "",
                     search: get().filters.search } });
    void get().loadPhotos();
  },

  setView(v) {
    // issue #43 : un masque local sélectionné (surimpression rouge, poignées) ne doit pas
    // rester actif quand on quitte le développement — il « prend le pas » sur la bibliothèque.
    if (v !== "develop") set({ activeTool: "none", beforeAfter: false, selectedLocalId: null });
    if (v === "settings") set({ previousView: get().view });
    set({ view: v });
  },

  selectPhoto(id) {
    set({ currentId: id, selection: id === null ? [] : [id] });
  },

  // Ctrl/⌘+clic : (dé)sélectionne sans changer la photo active (pas de rechargement du dev)
  toggleSelect(id) {
    const sel = get().selection;
    set({ selection: sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id] });
  },

  // Sélection directe d'un ensemble d'ids (rectangle de sélection de la grille).
  setSelection(ids) {
    set({ selection: ids });
  },

  // Ctrl+A : sélectionne toutes les photos actuellement listées (respecte les filtres actifs),
  // y compris depuis le mode développement (la photo ouverte reste active, `selection` sert
  // seulement aux actions par lot : notation, export…). Un second Ctrl+A (tout déjà sélectionné)
  // désélectionne tout, comme un bascule.
  selectAll() {
    const { photos, selection } = get();
    const allIds = photos.map((p) => p.id);
    const allSelected = allIds.length > 0 && allIds.every((id) => selection.includes(id));
    set({ selection: allSelected ? [] : allIds });
  },

  // Maj+clic : plage de la photo active jusqu'à la cliquée (dans l'ordre affiché)
  selectRange(id) {
    const { photos, currentId } = get();
    const a = photos.findIndex((p) => p.id === currentId);
    const b = photos.findIndex((p) => p.id === id);
    if (a < 0 || b < 0) { get().selectPhoto(id); return; }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    set({ selection: photos.slice(lo, hi + 1).map((p) => p.id) });
  },

  openContextMenu(id, x, y) {
    if (!get().selection.includes(id)) set({ selection: [id] });
    set({ contextMenu: { x, y } });
  },

  closeContextMenu() {
    set({ contextMenu: null });
  },

  setExportIds(ids) {
    set({ exportIds: ids });
  },

  async openDevelop(id) {
    await get().saveNow();
    set({ currentId: id, view: "develop", edits: null,
          undoStack: [], redoStack: [], undoLabels: [], redoLabels: [], currentLabel: originLabel(),
          activeTool: "none", selectedLocalId: null, beforeAfter: false });
    try {
      const p = await api.getPhoto(id);
      if (get().currentId === id) {
        const h = loadHistory((p as any).history, mergeEdits(p.edits));
        set({ edits: h.edits, currentLabel: h.currentLabel, dirty: false,
              undoStack: h.undoStack, undoLabels: h.undoLabels, redoStack: h.redoStack, redoLabels: h.redoLabels });
      }
    } catch (e) {
      get().notify(i18n.t("notify.loadFailed", { error: String(e) }), "error");
    }
  },

  navigate(delta) {
    const { photos, currentId, view } = get();
    if (!photos.length) return;
    const idx = photos.findIndex((p) => p.id === currentId);
    const next = photos[Math.max(0, Math.min(photos.length - 1, (idx < 0 ? 0 : idx + delta)))];
    if (!next || next.id === currentId) return;
    if (view === "develop") void get().openDevelop(next.id);
    else set({ currentId: next.id, selection: [next.id] });
  },

  setRating(rating) {
    const { currentId, photos } = get();
    if (currentId === null) return;
    set({ photos: photos.map((p) => (p.id === currentId ? { ...p, rating } : p)) });
    void api.patchPhoto(currentId, { rating }).catch(() => get().loadPhotos());
  },

  setFlag(flag) {
    const { currentId, photos } = get();
    if (currentId === null) return;
    set({ photos: photos.map((p) => (p.id === currentId ? { ...p, flag } : p)) });
    void api.patchPhoto(currentId, { flag }).catch(() => get().loadPhotos());
  },

  setColor(color) {
    const { currentId, photos } = get();
    if (currentId === null) return;
    const cur = photos.find((p) => p.id === currentId);
    const next = cur?.color === color ? "" : color; // re-cliquer enlève le label
    set({ photos: photos.map((p) => (p.id === currentId ? { ...p, color: next } : p)) });
    void api.patchPhoto(currentId, { color: next }).catch(() => get().loadPhotos());
  },

  // Applique une note/drapeau/label à toute la sélection (clic droit), optimiste.
  patchSelection(patch) {
    const { selection, currentId, photos } = get();
    const ids = selection.length ? selection : (currentId !== null ? [currentId] : []);
    if (!ids.length) return;
    const idSet = new Set(ids);
    set({ photos: photos.map((p) => (idSet.has(p.id) ? { ...p, ...patch } : p)) });
    ids.forEach((id) => void api.patchPhoto(id, patch).catch(() => get().loadPhotos()));
  },

  async removeSelection(deleteFile) {
    const { selection, currentId, photos } = get();
    const ids = selection.length ? selection : (currentId !== null ? [currentId] : []);
    if (!ids.length) return;
    const idSet = new Set(ids);
    await Promise.all(ids.map((id) => api.deletePhoto(id, deleteFile).catch(() => {})));
    const rest = photos.filter((p) => !idSet.has(p.id));
    const nextCur = rest.length ? (rest.find((p) => p.id === currentId)?.id ?? rest[0].id) : null;
    set({ photos: rest, currentId: nextCur, selection: nextCur !== null ? [nextCur] : [] });
    if (!rest.length) set({ view: "grid" });
    void get().loadAlbums();   // les photos retirées quittent aussi leurs albums (cascade)
  },

  async removeCurrent(deleteFile, targetId) {
    // `targetId` fige la photo visée au moment où la confirmation a été DEMANDÉE (cf. shortcuts.ts)
    // plutôt que de relire `currentId` à la résolution : sinon, deux Suppr rapprochés (2e dialogue
    // en file pendant que la 1ʳᵉ suppression est encore en vol) pourraient viser la photo suivante
    // une fois `currentId` déjà avancé, sans que l'utilisateur l'ait distinctement confirmé.
    const id = targetId ?? get().currentId;
    if (id === null) return;
    if (removingIds.has(id)) return; // déjà en cours (double confirmation) : no-op
    const { photos } = get();
    if (!photos.some((p) => p.id === id)) return; // déjà supprimée entre-temps
    removingIds.add(id);
    try {
      const idx = photos.findIndex((p) => p.id === id);
      await api.deletePhoto(id, deleteFile);
      const rest = get().photos.filter((p) => p.id !== id);
      const patch: Partial<Store> = { photos: rest };
      if (get().currentId === id) {
        patch.currentId = rest.length ? rest[Math.min(idx, rest.length - 1)].id : null;
        if (!rest.length) patch.view = "grid";
      }
      set(patch);
    } catch (e) {
      get().notify(i18n.t("notify.deleteFailed", { error: String(e) }), "error");
    } finally {
      removingIds.delete(id);
    }
  },

  openRelink(id) { set({ relinkTargetId: id }); },
  closeRelink() { set({ relinkTargetId: null }); },

  async relinkPhoto(path) {
    const id = get().relinkTargetId;
    if (id === null) return;
    const updated = await api.relinkPhoto(id, path);
    set({ photos: get().photos.map((p) => (p.id === id ? { ...p, missing: updated.missing } : p)),
          relinkTargetId: null });
    if (updated.warning) get().notify(updated.warning);
    if (get().currentId === id && get().view === "develop") void get().openDevelop(id);
  },

  // Masque IA : calcule côté serveur puis ajoute le masque retourné aux retouches locales.
  async createAutoMask(kind) {
    const { currentId, edits, aiMaskBusy } = get();
    if (currentId === null || !edits || aiMaskBusy) return;
    set({ aiMaskBusy: true });
    try {
      const local = await api.autoMask(currentId, edits, kind);
      const label = i18n.t(kind === "sky" ? "history.skyMask" : "history.subjectMask");
      get().updateEdits((e) => { e.locals.push(local); }, true, label);
      set({ selectedLocalId: local.id, activeTool: "none", showMaskOverlay: true });
      get().notify(i18n.t(kind === "sky" ? "local.skyCreated" : "local.subjectCreated"), "success");
    } catch (err) {
      get().notify(i18n.t("notify.aiMaskFailed", { error: String(err) }), "error");
    } finally {
      set({ aiMaskBusy: false });
    }
  },

  // Segmentation au clic : segmente l'élément pointé (x, y normalisés) via EdgeSAM.
  // Si un masque IA est déjà sélectionné, l'élément cliqué y est ajouté (union) au lieu
  // d'en créer un nouveau — on peut ainsi sélectionner plusieurs éléments dans un masque.
  async createPointMask(x, y) {
    const { currentId, edits, aiMaskBusy, selectedLocalId } = get();
    if (currentId === null || !edits || aiMaskBusy) return;
    const target = edits.locals.find((l) => l.id === selectedLocalId && l.type === "ai");
    set({ aiMaskBusy: true });
    try {
      const addRef = target ? String(target.params.ref ?? "") : "";
      const local = await api.clickMask(currentId, edits, x, y, addRef);
      if (target) {
        // Fusion : on garde le masque sélectionné (id, réglages) et on bascule sur le nouveau bitmap.
        get().updateEdits((e) => {
          const loc = e.locals.find((l) => l.id === target.id);
          if (loc) loc.params = { ...loc.params, ref: local.params.ref };
        }, true, i18n.t("history.maskElementAdded"));
        get().notify(i18n.t("notify.maskElementAdded"));
      } else {
        get().updateEdits((e) => { e.locals.push(local); }, true, i18n.t("history.clickMask"));
        set({ selectedLocalId: local.id, showMaskOverlay: true });
        get().notify(i18n.t("notify.clickCreated"));
      }
      set({ activeTool: "pointmask" }); // reste actif pour enchaîner les ajouts
    } catch (err) {
      get().notify(i18n.t("notify.pointMaskFailed", { error: String(err) }), "error");
    } finally {
      set({ aiMaskBusy: false });
    }
  },

  // Correcteur de taches IA : (re)calcule le patch d'un masque "inpaint" déjà présent dans les
  // edits (créé/complété par `createLocal`/onPointerUp côté ImageViewer au fil des coups de
  // pinceau) — met à jour params.ref/rect au succès, ne crée jamais le local lui-même
  // (contrairement à `createAutoMask`/`createPointMask` qui créent ET calculent en un seul appel).
  async runInpaint(localId) {
    const { currentId, edits, inpaintBusy } = get();
    if (currentId === null || !edits || inpaintBusy) return;
    const loc = edits.locals.find((l) => l.id === localId && l.type === "inpaint");
    if (!loc || !loc.params.strokes?.length) return;
    const { strokes, feather } = loc.params;
    set({ inpaintBusy: true });
    try {
      const result = await api.inpaint(currentId, edits, {
        strokes: strokes.map((s: any) => ({ points: s.points, size: s.size, erase: !!s.erase })),
        feather: feather ?? 0.4,
      });
      get().updateEdits((e) => {
        const l = e.locals.find((x) => x.id === localId);
        if (l) l.params = { ...l.params, ref: result.params.ref, rect: result.params.rect };
      }, true, i18n.t("history.inpaint"));
    } catch (err) {
      get().notify(i18n.t("notify.inpaintFailed", { error: String(err) }), "error");
    } finally {
      set({ inpaintBusy: false });
    }
  },

  updateEdits(fn, commit = true, label) {
    const cur = get().edits;
    if (!cur) return;
    const next = structuredClone(cur);
    fn(next);
    if (commit && !get().dragBaseline) {
      set({
        undoStack: [...get().undoStack.slice(-49), structuredClone(cur)],
        undoLabels: [...get().undoLabels.slice(-49), get().currentLabel],
        redoStack: [], redoLabels: [],
        currentLabel: label ?? describeEditChange(cur, next),
      });
    }
    set({ edits: next, dirty: true });
    scheduleSave();
  },

  // Mise à jour pendant un drag de slider : coalescée sur une frame (un seul clone + un seul
  // re-rendu React par frame, quelle que soit la fréquence des events). Pas de bookkeeping undo
  // ici (le point d'historique est posé une fois par startDrag/endDrag).
  updateEditsLive(fn) {
    liveFn = fn;
    if (liveRaf !== undefined) return;
    liveRaf = requestAnimationFrame(() => flushLiveEdit());
  },

  startDrag() {
    const cur = get().edits;
    if (cur && !get().dragBaseline) set({ dragBaseline: structuredClone(cur) });
  },

  endDrag() {
    flushLiveEdit(); // applique la dernière valeur en attente avant de figer la baseline
    const base = get().dragBaseline;
    const cur = get().edits;
    if (base && cur) {
      // `dirty: true` explicite : sur le chemin GPU découplé, le drag mute `edits` en place sans
      // jamais passer par set() — c'est ce relâchement qui marque l'état à sauvegarder. Le set()
      // qui suit (dragBaseline → null) débloque aussi le rendu HD (isDragging repasse à false).
      set({
        undoStack: [...get().undoStack.slice(-49), base],
        undoLabels: [...get().undoLabels.slice(-49), get().currentLabel],
        redoStack: [], redoLabels: [],
        currentLabel: describeEditChange(base, cur),
        dragBaseline: null,
        dirty: true,
      });
      scheduleSave();
    }
  },

  undo() {
    const { undoStack, undoLabels, edits, currentLabel, dragBaseline } = get();
    // Un drag en cours (poignée de masque, crop, slider) possède déjà son propre point
    // d'historique en attente (posé par endDrag au relâchement) : annuler pendant ce drag
    // désynchroniserait `dragBaseline` de `edits` (la suite du geste continuerait de muter
    // l'état par-dessus l'ancien edits rétabli) et le geste ne serait jamais réconcilié avec la
    // pile d'annulation. On ignore silencieusement Ctrl+Z tant qu'un drag est en cours.
    if (dragBaseline) return;
    if (!undoStack.length || !edits) return;
    set({
      edits: undoStack[undoStack.length - 1],
      undoStack: undoStack.slice(0, -1),
      undoLabels: undoLabels.slice(0, -1),
      redoStack: [...get().redoStack, structuredClone(edits)],
      redoLabels: [...get().redoLabels, currentLabel],
      currentLabel: undoLabels[undoLabels.length - 1] ?? originLabel(),
      dirty: true,
      dragBaseline: null,
    });
    scheduleSave();
  },

  redo() {
    const { redoStack, redoLabels, edits, currentLabel, dragBaseline } = get();
    if (dragBaseline) return; // cf. undo() : ne pas interférer avec un drag en cours
    if (!redoStack.length || !edits) return;
    set({
      edits: redoStack[redoStack.length - 1],
      redoStack: redoStack.slice(0, -1),
      redoLabels: redoLabels.slice(0, -1),
      undoStack: [...get().undoStack, structuredClone(edits)],
      undoLabels: [...get().undoLabels, currentLabel],
      currentLabel: redoLabels[redoLabels.length - 1] ?? i18n.t("history.change"),
      dirty: true,
    });
    scheduleSave();
  },

  // Saut direct à une étape de la timeline (panneau Historique) : rejoue undo/redo.
  jumpHistory(index) {
    const cur = get().undoStack.length; // index courant dans la timeline
    const delta = index - cur;
    for (let i = 0; i < -delta; i++) get().undo();
    for (let i = 0; i < delta; i++) get().redo();
  },

  resetEdits() {
    get().updateEdits((e) => Object.assign(e, defaultEdits()), true, i18n.t("history.reset"));
    get().notify(i18n.t("notify.reset"));
  },

  applyPartial(settings) {
    get().updateEdits((e) => {
      const merged = mergeEdits({ ...structuredClone(e), ...structuredClone(settings) });
      Object.assign(e, merged);
    }, true, i18n.t("history.presetApplied"));
  },

  copyEdits() {
    const e = get().edits;
    if (e) {
      set({ clipboard: structuredClone(e) });
      get().notify(i18n.t("notify.copied"));
    }
  },

  pasteEdits() {
    const c = get().clipboard;
    if (!c) return;
    get().updateEdits((e) => {
      const keep = e.geometry; // le recadrage reste propre à chaque photo
      Object.assign(e, structuredClone(c));
      e.geometry = keep;
    }, true, i18n.t("history.pasted"));
    get().notify(i18n.t("notify.pasted"));
  },

  // Colle les réglages copiés sur un lot de photos (menu contextuel de la grille), sans les
  // ouvrir en développement : lecture/écriture directes via l'API, une par une.
  async pasteEditsToSelection(ids) {
    const c = get().clipboard;
    if (!c || !ids.length) return;
    let ok = 0;
    await Promise.all(ids.map(async (id) => {
      try {
        const photo = await api.getPhoto(id);
        const before = mergeEdits(photo.edits);
        const merged = structuredClone(before);
        const keep = merged.geometry;
        Object.assign(merged, structuredClone(c));
        merged.geometry = keep;
        const prior = loadHistory(photo.history, before);
        const history = historyTimeline({
          edits: merged,
          currentLabel: i18n.t("history.pasted"),
          undoStack: [...prior.undoStack, prior.edits],
          undoLabels: [...prior.undoLabels, prior.currentLabel],
          redoStack: [], redoLabels: [],
        });
        await api.saveEdits(id, merged, history);
        get().bumpVersion(id);
        ok++;
      } catch { /* on continue les autres photos malgré un échec isolé */ }
    }));
    set({ photos: get().photos.map((p) => (ids.includes(p.id) ? { ...p, edited: true } : p)) });
    get().notify(i18n.t("ctx.pastedToN", { count: ok }), ok === ids.length ? "success" : "error");
  },

  // Copie/colle UN masque local (Ctrl+C/Ctrl+V) — distinct de copyEdits/pasteEdits (tous les
  // réglages). Colle sur la photo courante (la même ou une autre, selon où on est au moment du
  // Ctrl+V) : ajoute une copie légèrement décalée, l'original ne bouge pas.
  copyLocalMask() {
    const { edits, selectedLocalId } = get();
    const local = edits?.locals.find((l) => l.id === selectedLocalId);
    if (!local) return;
    set({ localClipboard: structuredClone(local) });
    get().notify(i18n.t("local.maskCopied"));
  },

  // Ctrl+X : coupe le masque sélectionné (copie + retrait de la photo courante) pour le recoller
  // ailleurs (même photo ou une autre) via Ctrl+V.
  cutLocalMask() {
    const { edits, selectedLocalId } = get();
    const local = edits?.locals.find((l) => l.id === selectedLocalId);
    if (!local) return;
    set({ localClipboard: structuredClone(local) });
    get().updateEdits((e) => { e.locals = e.locals.filter((l) => l.id !== selectedLocalId); },
      true, i18n.t("history.localCut"));
    set({ selectedLocalId: null });
    get().notify(i18n.t("local.maskCut"));
  },

  pasteLocalMask() {
    const source = get().localClipboard;
    if (!source) return;
    const clone = cloneLocalMask(source);
    get().updateEdits((e) => { e.locals.push(clone); }, true, i18n.t("history.localDuplicated"));
    set({ selectedLocalId: clone.id, activeTool: "none", showMaskOverlay: true });
    get().notify(i18n.t("local.maskPasted"));
  },

  setCropAspect(ratio) {
    set({ cropAspect: ratio });
    if (ratio === null) return;
    const { currentId, photos } = get();
    const photo = photos.find((p) => p.id === currentId);
    if (!photo || !photo.width || !photo.height) return;
    get().updateEdits((e) => {
      const rot = ((e.geometry.rotate % 360) + 360) % 360;
      let iw = photo.width, ih = photo.height;
      if (rot === 90 || rot === 270) [iw, ih] = [ih, iw];
      const a = iw / ih; // ratio en pixels de l'image affichée
      const c = e.geometry.crop;
      const ccx = c.x + c.w / 2, ccy = c.y + c.h / 2;
      // ratio = (cw·iw)/(ch·ih) ⇒ ch = cw·a/ratio
      let cw = c.w, ch = (cw * a) / ratio;
      if (ch > 1) { ch = 1; cw = (ratio / a); }
      if (cw > 1) { cw = 1; ch = (a / ratio); }
      e.geometry.crop = {
        x: Math.min(Math.max(ccx - cw / 2, 0), 1 - cw),
        y: Math.min(Math.max(ccy - ch / 2, 0), 1 - ch),
        w: cw, h: ch,
      };
    });
  },

  async saveNow() {
    if (saveTimer) { window.clearTimeout(saveTimer); saveTimer = undefined; }
    const { dirty, edits, currentId } = get();
    if (!dirty || !edits || currentId === null) return;
    try {
      await api.saveEdits(currentId, edits, historyTimeline(get()));
      const id = currentId;
      set({
        dirty: false,
        photos: get().photos.map((p) => (p.id === id ? { ...p, edited: true } : p)),
      });
      window.setTimeout(() => get().bumpVersion(id), 2500); // les previews regénèrent en fond
    } catch (e) {
      get().notify(i18n.t("notify.saveFailed", { error: String(e) }), "error");
    }
  },

  bumpVersion(id) {
    set({ editsVersion: { ...get().editsVersion, [id]: (get().editsVersion[id] ?? 0) + 1 } });
  },

  setUI(p) {
    if (p.gridSize !== undefined) localStorage.setItem("rs.gridSize", String(p.gridSize));
    if (p.panelsCollapsed !== undefined) localStorage.setItem("rs.panelsCollapsed", p.panelsCollapsed ? "1" : "0");
    set(p);
  },

  notify(msg, type = "info", action) {
    const id = nextToastId++;
    set({ toasts: [...get().toasts, { id, msg, type, action }] });
    window.setTimeout(() => get().dismissToast(id), 4200);
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  markHintSeen(key) {
    const seenHints = { ...get().seenHints, [key]: true };
    try { localStorage.setItem("rs.seenHints", JSON.stringify(seenHints)); } catch { /* quota/private mode */ }
    set({ seenHints });
  },

  reorderPanels(order) {
    try { localStorage.setItem("rs.panelOrder", JSON.stringify(order)); } catch { /* quota/private mode */ }
    set({ panelOrder: order });
  },
}));

function scheduleSave() {
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void useStore.getState().saveNow(), 800);
}

/** Applique immédiatement la mutation « live » en attente (un drag de slider) et annule le rAF.
 *  Appelé par le rAF lui-même ou par endDrag pour ne pas perdre la valeur finale. */
function flushLiveEdit() {
  if (liveRaf !== undefined) { cancelAnimationFrame(liveRaf); liveRaf = undefined; }
  const fn = liveFn; liveFn = null;
  if (!fn) return;
  const st = useStore.getState();
  const cur = st.edits;
  if (!cur) return;
  if (st.dragBaseline && liveRender) {
    // Chemin découplé (aperçu GPU actif, drag en cours) : mutation EN PLACE, aucun re-render React,
    // rendu GPU impératif. La baseline d'historique (dragBaseline) est un clone indépendant pris au
    // startDrag, donc muter `cur` ici est sûr. endDrag posera le point d'historique + marquera dirty.
    fn(cur);
    liveRender(cur);
  } else {
    // Chemin classique (mode serveur, ou hors drag) : clone + setState → l'aperçu serveur débouncé
    // se rafraîchit, et React reflète l'état.
    const next = structuredClone(cur);
    fn(next);
    useStore.setState({ edits: next, dirty: true });
    scheduleSave();
  }
}

// Mémorise projet/photo/vue à chaque changement pour rouvrir l'app dans le même état.
useStore.subscribe((s, prev) => {
  if (s.currentProjectId !== prev.currentProjectId || s.currentId !== prev.currentId || s.view !== prev.view) {
    writeSession({ projectId: s.currentProjectId, photoId: s.currentId, view: s.view });
  }
});

/** Sauvegarde de secours à la fermeture de l'onglet. */
window.addEventListener("pagehide", () => {
  const s = useStore.getState();
  if (s.dirty && s.edits && s.currentId !== null) {
    void fetch(`/api/photos/${s.currentId}/edits`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edits: s.edits, history: historyTimeline(s) }),
      keepalive: true,
    });
  }
});
