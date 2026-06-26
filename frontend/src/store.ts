import { create } from "zustand";
import { api, type PhotoFilters, type PhotoFacets } from "./api";
import { ALL_PHOTOS_ID, defaultEdits, mergeEdits, type Album, type EditState, type HistoryData, type HistoryStep, type Photo, type Project } from "./types";
import { describeEditChange } from "./lib/historyLabel";
import i18n from "./i18n";

// Libellé de l'étape « origine » de l'historique, dans la langue courante.
const originLabel = () => i18n.t("history.origin");

// Nom du projet par défaut créé côté backend (db.py) : on le ré-étiquette à l'affichage selon
// la langue. Un projet renommé par l'utilisateur ne correspond plus et garde son nom.
const DEFAULT_PROJECT_NAME = "Projet par défaut";

/** Reconstruit la timeline d'historique (chronologique) à partir des piles undo/redo + libellés. */
export function historyTimeline(s: Pick<Store,
  "undoStack" | "undoLabels" | "edits" | "currentLabel" | "redoStack" | "redoLabels">): HistoryData {
  if (!s.edits) return { steps: [], index: 0 };
  const steps: HistoryStep[] = s.undoStack.map((edits, i) => ({ label: s.undoLabels[i] ?? i18n.t("history.change"), edits }));
  steps.push({ label: s.currentLabel, edits: s.edits });
  for (let k = s.redoStack.length - 1; k >= 0; k--)
    steps.push({ label: s.redoLabels[k] ?? i18n.t("history.change"), edits: s.redoStack[k] });
  return { steps, index: s.undoStack.length };
}

interface HistoryParts {
  edits: EditState; currentLabel: string;
  undoStack: EditState[]; undoLabels: string[]; redoStack: EditState[]; redoLabels: string[];
}

/** Restaure les piles d'historique depuis la forme persistée ; repli sur une étape unique. */
function loadHistory(raw: any, fallbackEdits: EditState): HistoryParts {
  const steps = Array.isArray(raw?.steps) ? raw.steps : null;
  const index = raw?.index;
  if (steps && steps.length && typeof index === "number" && index >= 0 && index < steps.length) {
    const norm: HistoryStep[] = steps.map((s: any) => ({ label: String(s?.label ?? i18n.t("history.change")), edits: mergeEdits(s?.edits) }));
    return {
      edits: structuredClone(norm[index].edits),
      currentLabel: norm[index].label,
      undoStack: norm.slice(0, index).map((s) => s.edits),
      undoLabels: norm.slice(0, index).map((s) => s.label),
      redoStack: norm.slice(index + 1).map((s) => s.edits).reverse(),
      redoLabels: norm.slice(index + 1).map((s) => s.label).reverse(),
    };
  }
  return { edits: fallbackEdits, currentLabel: originLabel(), undoStack: [], undoLabels: [], redoStack: [], redoLabels: [] };
}

export type View = "home" | "grid" | "loupe" | "develop" | "settings";
export type Tool = "none" | "crop" | "linear" | "radial" | "brush" | "wb" | "pointmask";

let saveTimer: number | undefined;

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

// Persistance de la dernière session (projet / photo / vue) pour rouvrir l'app où on l'a laissée.
const SESSION_KEY = "rs.session";
interface Session { projectId: number | null; photoId: number | null; view: View; }

function readSession(): Session {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "{}");
    return {
      projectId: typeof s.projectId === "number" ? s.projectId : null,
      photoId: typeof s.photoId === "number" ? s.photoId : null,
      view: s.view === "loupe" || s.view === "develop" ? s.view : "grid",
    };
  } catch {
    return { projectId: null, photoId: null, view: "grid" };
  }
}

function writeSession(s: Session) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* quota/private mode */ }
}

interface Store {
  projects: Project[];
  currentProjectId: number | null;
  albums: Album[];
  currentAlbumId: number | null;   // si défini, la grille liste cet album (prime sur le projet)
  photos: Photo[];
  filters: PhotoFilters;
  facets: PhotoFacets;
  currentId: number | null;
  view: View;
  previousView: View;

  selection: number[];            // multi-sélection (Ctrl/Maj+clic) pour les actions par lot
  exportIds: number[] | null;     // si défini, l'export porte sur ces ids (sinon courante/toutes)
  contextMenu: { x: number; y: number } | null;

  edits: EditState | null;        // état de développement de la photo courante
  dirty: boolean;
  undoStack: EditState[];
  redoStack: EditState[];
  undoLabels: string[];           // libellés parallèles aux snapshots (historique)
  redoLabels: string[];
  currentLabel: string;           // libellé de l'étape courante (edits)
  dragBaseline: EditState | null; // snapshot avant un drag de slider
  clipboard: EditState | null;
  editsVersion: Record<number, number>; // cache-busting des thumbs/previews

  gridSize: number;               // taille des vignettes de la grille (px), réglable
  beforeAfter: boolean;
  showClipping: boolean;
  showInfo: boolean;
  showHelp: boolean;
  showImport: boolean;
  showExport: boolean;
  showModels: boolean;            // dialog « Modèles IA » (téléchargement à la demande)
  showAlbums: boolean;            // panneau latéral Collections (grille)
  activeTool: Tool;
  selectedLocalId: string | null;
  showMaskOverlay: boolean;
  brushSize: number;
  brushErase: boolean;
  cropAspect: number | null;
  aiSubjectAvailable: boolean;    // modèle « sujet » (U²-Net) présent
  aiSkyAvailable: boolean;        // détection de ciel heuristique (toujours dispo)
  aiPointAvailable: boolean;      // modèle « clic » (EdgeSAM) présent
  aiDenoiseAvailable: boolean;    // modèle de débruitage IA (FFDNet) présent
  aiMaskBusy: boolean;            // calcul d'un masque IA en cours
  toast: string;

  init(): Promise<void>;
  loadProjects(): Promise<void>;
  setProject(id: number): Promise<void>;
  createProject(name: string): Promise<void>;
  renameProject(id: number, name: string): Promise<void>;
  deleteProject(id: number): Promise<void>;
  loadAlbums(): Promise<void>;
  setAlbum(id: number | null): Promise<void>;
  createAlbum(name: string): Promise<number | null>;
  renameAlbum(id: number, name: string): Promise<void>;
  deleteAlbum(id: number): Promise<void>;
  addToAlbum(id: number, photoIds: number[]): Promise<void>;
  removeFromAlbum(id: number, photoIds: number[]): Promise<void>;
  loadPhotos(): Promise<void>;
  setFilters(p: Partial<PhotoFilters>): void;
  resetFilters(): void;
  loadFacets(): Promise<void>;
  setView(v: View): void;
  selectPhoto(id: number | null): void;
  toggleSelect(id: number): void;
  selectRange(id: number): void;
  setSelection(ids: number[]): void;
  openContextMenu(id: number, x: number, y: number): void;
  closeContextMenu(): void;
  setExportIds(ids: number[] | null): void;
  openDevelop(id: number): Promise<void>;
  navigate(delta: number): void;
  setRating(rating: number): void;
  setFlag(flag: "none" | "pick" | "reject"): void;
  setColor(color: string): void;
  patchSelection(patch: Partial<Pick<Photo, "rating" | "flag" | "color">>): void;
  removeCurrent(deleteFile: boolean): Promise<void>;
  removeSelection(deleteFile: boolean): Promise<void>;

  createAutoMask(kind: string): Promise<void>;
  createPointMask(x: number, y: number): Promise<void>;
  updateEdits(fn: (e: EditState) => void, commit?: boolean, label?: string): void;
  updateEditsLive(fn: (e: EditState) => void): void;
  startDrag(): void;
  endDrag(): void;
  undo(): void;
  redo(): void;
  jumpHistory(index: number): void;
  resetEdits(): void;
  applyPartial(settings: Partial<EditState>): void;
  copyEdits(): void;
  pasteEdits(): void;
  setCropAspect(ratio: number | null): void;
  saveNow(): Promise<void>;
  bumpVersion(id: number): void;

  setUI(p: Partial<Pick<Store, "beforeAfter" | "showClipping" | "showInfo" | "showHelp" |
    "showImport" | "showExport" | "showModels" | "showAlbums" | "activeTool" | "selectedLocalId" | "showMaskOverlay" |
    "brushSize" | "brushErase" | "cropAspect" | "gridSize">>): void;
  notify(msg: string): void;
  refreshAiAvailability(): Promise<void>;
}

export const useStore = create<Store>((set, get) => ({
  projects: [],
  currentProjectId: null,
  albums: [],
  currentAlbumId: null,
  photos: [],
  filters: { minRating: 0, flag: "", color: "", sort: "captured_asc",
             camera: "", lens: "", isoMin: 0, isoMax: 0, dateFrom: "", dateTo: "" },
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
  aiMaskBusy: false,
  toast: "",

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
          aiPointAvailable: a.point, aiDenoiseAvailable: a.denoise });
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
    set({
      currentProjectId: id, currentAlbumId: null, currentId: null, selection: [], view: "grid",
      filters: { ...get().filters, camera: "", lens: "", isoMin: 0, isoMax: 0, dateFrom: "", dateTo: "" },
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
    await api.deleteProject(id);
    const wasCurrent = get().currentProjectId === id;
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
    set({
      currentAlbumId: id, currentId: null, selection: [], view: "grid",
      filters: { ...get().filters, camera: "", lens: "", isoMin: 0, isoMax: 0, dateFrom: "", dateTo: "" },
    });
    await get().loadPhotos();
  },

  async createAlbum(name) {
    try {
      const a = await api.createAlbum(name);
      await get().loadAlbums();
      return a.id;
    } catch (e) {
      get().notify(e instanceof Error ? e.message : "Échec de création de l'album");
      return null;
    }
  },

  async renameAlbum(id, name) {
    try {
      await api.renameAlbum(id, name);
      await get().loadAlbums();
    } catch (e) {
      get().notify(e instanceof Error ? e.message : "Échec du renommage");
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

  setFilters(p) {
    set({ filters: { ...get().filters, ...p } });
    void get().loadPhotos();
  },

  resetFilters() {
    set({ filters: { minRating: 0, flag: "", color: "", sort: get().filters.sort,
                     camera: "", lens: "", isoMin: 0, isoMax: 0, dateFrom: "", dateTo: "" } });
    void get().loadPhotos();
  },

  setView(v) {
    if (v !== "develop") set({ activeTool: "none", beforeAfter: false });
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
      get().notify(`Chargement impossible : ${e}`);
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

  async removeCurrent(deleteFile) {
    const { currentId, photos } = get();
    if (currentId === null) return;
    const idx = photos.findIndex((p) => p.id === currentId);
    await api.deletePhoto(currentId, deleteFile);
    const rest = photos.filter((p) => p.id !== currentId);
    set({ photos: rest, currentId: rest.length ? rest[Math.min(idx, rest.length - 1)].id : null });
    if (!rest.length) set({ view: "grid" });
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
      get().notify(i18n.t(kind === "sky" ? "local.skyCreated" : "local.subjectCreated"));
    } catch (err) {
      get().notify(`Masque IA impossible : ${err}`);
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
        get().notify("Élément ajouté au masque");
      } else {
        get().updateEdits((e) => { e.locals.push(local); }, true, i18n.t("history.clickMask"));
        set({ selectedLocalId: local.id, showMaskOverlay: true });
        get().notify("Masque créé (clic)");
      }
      set({ activeTool: "pointmask" }); // reste actif pour enchaîner les ajouts
    } catch (err) {
      get().notify(`Segmentation impossible : ${err}`);
    } finally {
      set({ aiMaskBusy: false });
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
    const { undoStack, undoLabels, edits, currentLabel } = get();
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
    const { redoStack, redoLabels, edits, currentLabel } = get();
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
    get().notify("Réglages réinitialisés");
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
      get().notify("Réglages copiés");
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
    get().notify("Réglages collés");
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
      get().notify(`Sauvegarde impossible : ${e}`);
    }
  },

  bumpVersion(id) {
    set({ editsVersion: { ...get().editsVersion, [id]: (get().editsVersion[id] ?? 0) + 1 } });
  },

  setUI(p) {
    if (p.gridSize !== undefined) localStorage.setItem("rs.gridSize", String(p.gridSize));
    set(p);
  },

  notify(msg) {
    set({ toast: msg });
    window.setTimeout(() => { if (get().toast === msg) set({ toast: "" }); }, 2600);
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
