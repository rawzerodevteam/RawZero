import { create } from "zustand";
import { api, type PhotoFilters } from "./api";
import { defaultEdits, mergeEdits, type EditState, type Photo, type Project } from "./types";

export type View = "grid" | "loupe" | "develop";
export type Tool = "none" | "crop" | "linear" | "radial" | "brush" | "wb" | "pointmask";

let saveTimer: number | undefined;

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
  photos: Photo[];
  filters: PhotoFilters;
  currentId: number | null;
  view: View;

  selection: number[];            // multi-sélection (Ctrl/Maj+clic) pour les actions par lot
  exportIds: number[] | null;     // si défini, l'export porte sur ces ids (sinon courante/toutes)
  contextMenu: { x: number; y: number } | null;

  edits: EditState | null;        // état de développement de la photo courante
  dirty: boolean;
  undoStack: EditState[];
  redoStack: EditState[];
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
  activeTool: Tool;
  selectedLocalId: string | null;
  showMaskOverlay: boolean;
  brushSize: number;
  brushErase: boolean;
  cropAspect: number | null;
  aiSubjectAvailable: boolean;    // modèle « sujet » (U²-Net) présent
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
  loadPhotos(): Promise<void>;
  setFilters(p: Partial<PhotoFilters>): void;
  setView(v: View): void;
  selectPhoto(id: number | null): void;
  toggleSelect(id: number): void;
  selectRange(id: number): void;
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
  updateEdits(fn: (e: EditState) => void, commit?: boolean): void;
  startDrag(): void;
  endDrag(): void;
  undo(): void;
  redo(): void;
  resetEdits(): void;
  applyPartial(settings: Partial<EditState>): void;
  copyEdits(): void;
  pasteEdits(): void;
  setCropAspect(ratio: number | null): void;
  saveNow(): Promise<void>;
  bumpVersion(id: number): void;

  setUI(p: Partial<Pick<Store, "beforeAfter" | "showClipping" | "showInfo" | "showHelp" |
    "showImport" | "showExport" | "activeTool" | "selectedLocalId" | "showMaskOverlay" |
    "brushSize" | "brushErase" | "cropAspect" | "gridSize">>): void;
  notify(msg: string): void;
}

export const useStore = create<Store>((set, get) => ({
  projects: [],
  currentProjectId: null,
  photos: [],
  filters: { minRating: 0, flag: "", color: "", sort: "captured_asc" },
  currentId: null,
  view: "grid",

  selection: [],
  exportIds: null,
  contextMenu: null,

  edits: null,
  dirty: false,
  undoStack: [],
  redoStack: [],
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
  activeTool: "none",
  selectedLocalId: null,
  showMaskOverlay: true,
  brushSize: 0.08,
  brushErase: false,
  cropAspect: null,
  aiSubjectAvailable: false,
  aiPointAvailable: false,
  aiDenoiseAvailable: false,
  aiMaskBusy: false,
  toast: "",

  // Au démarrage : restaure la dernière session (projet/photo/vue), puis charge projets et photos.
  async init() {
    const saved = readSession();
    if (saved.projectId !== null) set({ currentProjectId: saved.projectId });
    await get().loadProjects();
    await get().loadPhotos();
    // Rouvre l'app là où on l'a laissée (si la photo existe toujours dans le projet courant).
    if (saved.photoId !== null && get().photos.some((p) => p.id === saved.photoId)) {
      if (saved.view === "develop") {
        await get().openDevelop(saved.photoId);
      } else {
        set({ currentId: saved.photoId, selection: [saved.photoId], view: saved.view });
      }
    }
    void api.autoMaskAvailable().then((a) =>
      set({ aiSubjectAvailable: a.subject, aiPointAvailable: a.point, aiDenoiseAvailable: a.denoise }));
  },

  async loadProjects() {
    const projects = await api.listProjects();
    let cur = get().currentProjectId;
    if (cur === null || !projects.some((p) => p.id === cur)) cur = projects[0]?.id ?? null;
    set({ projects, currentProjectId: cur });
  },

  async setProject(id) {
    if (id === get().currentProjectId) return;
    set({ currentProjectId: id, currentId: null, selection: [], view: "grid" });
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
    const photos = await api.listPhotos(get().filters, get().currentProjectId);
    const ids = new Set(photos.map((p) => p.id));
    set({ photos, selection: get().selection.filter((id) => ids.has(id)) });
    const { currentId } = get();
    if (currentId !== null && !ids.has(currentId)) {
      set({ currentId: photos.length ? photos[0].id : null });
    }
  },

  setFilters(p) {
    set({ filters: { ...get().filters, ...p } });
    void get().loadPhotos();
  },

  setView(v) {
    if (v !== "develop") set({ activeTool: "none", beforeAfter: false });
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
    set({ currentId: id, view: "develop", edits: null, undoStack: [], redoStack: [],
          activeTool: "none", selectedLocalId: null, beforeAfter: false });
    try {
      const p = await api.getPhoto(id);
      if (get().currentId === id) set({ edits: mergeEdits(p.edits), dirty: false });
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
      get().updateEdits((e) => { e.locals.push(local); });
      set({ selectedLocalId: local.id, activeTool: "none", showMaskOverlay: true });
      get().notify("Masque « sujet » créé");
    } catch (err) {
      get().notify(`Masque IA impossible : ${err}`);
    } finally {
      set({ aiMaskBusy: false });
    }
  },

  // Segmentation au clic : segmente l'élément pointé (x, y normalisés) via EdgeSAM.
  async createPointMask(x, y) {
    const { currentId, edits, aiMaskBusy } = get();
    if (currentId === null || !edits || aiMaskBusy) return;
    set({ aiMaskBusy: true });
    try {
      const local = await api.clickMask(currentId, edits, x, y);
      get().updateEdits((e) => { e.locals.push(local); });
      set({ selectedLocalId: local.id, activeTool: "none", showMaskOverlay: true });
      get().notify("Masque créé (clic)");
    } catch (err) {
      get().notify(`Segmentation impossible : ${err}`);
    } finally {
      set({ aiMaskBusy: false });
    }
  },

  updateEdits(fn, commit = true) {
    const cur = get().edits;
    if (!cur) return;
    if (commit && !get().dragBaseline) {
      set({ undoStack: [...get().undoStack.slice(-49), structuredClone(cur)], redoStack: [] });
    }
    const next = structuredClone(cur);
    fn(next);
    set({ edits: next, dirty: true });
    scheduleSave();
  },

  startDrag() {
    const cur = get().edits;
    if (cur && !get().dragBaseline) set({ dragBaseline: structuredClone(cur) });
  },

  endDrag() {
    const base = get().dragBaseline;
    if (base) {
      set({ undoStack: [...get().undoStack.slice(-49), base], redoStack: [], dragBaseline: null });
      scheduleSave();
    }
  },

  undo() {
    const { undoStack, edits } = get();
    if (!undoStack.length || !edits) return;
    const prev = undoStack[undoStack.length - 1];
    set({
      edits: prev,
      undoStack: undoStack.slice(0, -1),
      redoStack: [...get().redoStack, structuredClone(edits)],
      dirty: true,
      dragBaseline: null,
    });
    scheduleSave();
  },

  redo() {
    const { redoStack, edits } = get();
    if (!redoStack.length || !edits) return;
    const next = redoStack[redoStack.length - 1];
    set({
      edits: next,
      redoStack: redoStack.slice(0, -1),
      undoStack: [...get().undoStack, structuredClone(edits)],
      dirty: true,
    });
    scheduleSave();
  },

  resetEdits() {
    get().updateEdits((e) => Object.assign(e, defaultEdits()));
    get().notify("Réglages réinitialisés");
  },

  applyPartial(settings) {
    get().updateEdits((e) => {
      const merged = mergeEdits({ ...structuredClone(e), ...structuredClone(settings) });
      Object.assign(e, merged);
    });
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
    });
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
      await api.saveEdits(currentId, edits);
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

// Mémorise projet/photo/vue à chaque changement pour rouvrir l'app dans le même état.
useStore.subscribe((s, prev) => {
  if (s.currentProjectId !== prev.currentProjectId || s.currentId !== prev.currentId || s.view !== prev.view) {
    writeSession({ projectId: s.currentProjectId, photoId: s.currentId, view: s.view });
  }
});

/** Sauvegarde de secours à la fermeture de l'onglet. */
window.addEventListener("pagehide", () => {
  const { dirty, edits, currentId } = useStore.getState();
  if (dirty && edits && currentId !== null) {
    void fetch(`/api/photos/${currentId}/edits`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edits }),
      keepalive: true,
    });
  }
});
