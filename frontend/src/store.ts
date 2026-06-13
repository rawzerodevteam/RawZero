import { create } from "zustand";
import { api, type PhotoFilters } from "./api";
import { defaultEdits, mergeEdits, type EditState, type Photo } from "./types";

export type View = "grid" | "loupe" | "develop";
export type Tool = "none" | "crop" | "linear" | "radial" | "brush";

let saveTimer: number | undefined;

interface Store {
  photos: Photo[];
  filters: PhotoFilters;
  currentId: number | null;
  view: View;

  edits: EditState | null;        // état de développement de la photo courante
  dirty: boolean;
  undoStack: EditState[];
  redoStack: EditState[];
  dragBaseline: EditState | null; // snapshot avant un drag de slider
  clipboard: EditState | null;
  editsVersion: Record<number, number>; // cache-busting des thumbs/previews

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
  toast: string;

  loadPhotos(): Promise<void>;
  setFilters(p: Partial<PhotoFilters>): void;
  setView(v: View): void;
  selectPhoto(id: number | null): void;
  openDevelop(id: number): Promise<void>;
  navigate(delta: number): void;
  setRating(rating: number): void;
  setFlag(flag: "none" | "pick" | "reject"): void;
  setColor(color: string): void;
  removeCurrent(deleteFile: boolean): Promise<void>;

  updateEdits(fn: (e: EditState) => void, commit?: boolean): void;
  startDrag(): void;
  endDrag(): void;
  undo(): void;
  redo(): void;
  resetEdits(): void;
  applyPartial(settings: Partial<EditState>): void;
  copyEdits(): void;
  pasteEdits(): void;
  saveNow(): Promise<void>;
  bumpVersion(id: number): void;

  setUI(p: Partial<Pick<Store, "beforeAfter" | "showClipping" | "showInfo" | "showHelp" |
    "showImport" | "showExport" | "activeTool" | "selectedLocalId" | "showMaskOverlay" |
    "brushSize" | "brushErase" | "cropAspect">>): void;
  notify(msg: string): void;
}

export const useStore = create<Store>((set, get) => ({
  photos: [],
  filters: { minRating: 0, flag: "", color: "", sort: "captured_asc" },
  currentId: null,
  view: "grid",

  edits: null,
  dirty: false,
  undoStack: [],
  redoStack: [],
  dragBaseline: null,
  clipboard: null,
  editsVersion: {},

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
  toast: "",

  async loadPhotos() {
    const photos = await api.listPhotos(get().filters);
    set({ photos });
    const { currentId } = get();
    if (currentId !== null && !photos.some((p) => p.id === currentId)) {
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
    set({ currentId: id });
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
    else set({ currentId: next.id });
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

  async removeCurrent(deleteFile) {
    const { currentId, photos } = get();
    if (currentId === null) return;
    const idx = photos.findIndex((p) => p.id === currentId);
    await api.deletePhoto(currentId, deleteFile);
    const rest = photos.filter((p) => p.id !== currentId);
    set({ photos: rest, currentId: rest.length ? rest[Math.min(idx, rest.length - 1)].id : null });
    if (!rest.length) set({ view: "grid" });
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

  async saveNow() {
    if (saveTimer) { window.clearTimeout(saveTimer); saveTimer = undefined; }
    const { dirty, edits, currentId } = get();
    if (!dirty || !edits || currentId === null) return;
    try {
      await api.saveEdits(currentId, edits);
      set({ dirty: false });
      const id = currentId;
      window.setTimeout(() => get().bumpVersion(id), 2500); // les previews regénèrent en fond
    } catch (e) {
      get().notify(`Sauvegarde impossible : ${e}`);
    }
  },

  bumpVersion(id) {
    set({ editsVersion: { ...get().editsVersion, [id]: (get().editsVersion[id] ?? 0) + 1 } });
  },

  setUI(p) {
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
