import type { PhotoFacets, PhotoFilters } from "./api";
import type { Album, EditState, LocalAdjust, Photo, Project } from "./types";

/** Types du store Zustand — extrait de `store.ts` (TODO N11) : déclarations pures, aucune
 *  dépendance sur `create()`/`set`/`get`. Réexporté depuis `store.ts` pour ne rien casser côté
 *  appelants (`import { Tool } from "./store"` etc. restent valides). */

export type View = "home" | "grid" | "loupe" | "develop" | "settings";
export type Tool = "none" | "crop" | "linear" | "radial" | "brush" | "inpaint" | "wb" | "hsl" | "pointmask";

export type ToastType = "info" | "success" | "error";
export interface ToastItem { id: number; msg: string; type: ToastType; action?: { label: string; onClick: () => void } }

export interface Store {
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
  localClipboard: LocalAdjust | null; // masque local copié (Ctrl+C/Ctrl+V) — collable sur n'importe quelle photo
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
  panelsCollapsed: boolean;       // colonne de panneaux droite masquée (développement, écrans étroits)
  fullScreen: boolean;            // mode plein écran développement (masque toolbar/panneaux/filmstrip)
  hslPickedBand: string | null;   // dernière bande HSL désignée par la pipette (surlignage HSLPanel)
  relinkTargetId: number | null;  // id de la photo en cours de reliage (dialog « Relier »)
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
  aiInpaintAvailable: boolean;    // modèle de correction de taches IA (MI-GAN) présent
  aiMaskBusy: boolean;            // calcul d'un masque IA en cours
  inpaintBusy: boolean;           // calcul d'un correcteur de taches IA en cours
  toasts: ToastItem[];
  seenHints: Record<string, boolean>; // coach-marks déjà vus (persisté), cf. audit UX §7.2/§4.2
  panelOrder: string[];            // ordre personnalisé des panneaux de développement (persisté)

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
  reorderAlbumPhotos(orderedIds: number[]): Promise<void>;
  loadPhotos(): Promise<void>;
  setFilters(p: Partial<PhotoFilters>): void;
  resetFilters(): void;
  loadFacets(): Promise<void>;
  setView(v: View): void;
  selectPhoto(id: number | null): void;
  toggleSelect(id: number): void;
  selectRange(id: number): void;
  setSelection(ids: number[]): void;
  selectAll(): void;
  openContextMenu(id: number, x: number, y: number): void;
  closeContextMenu(): void;
  setExportIds(ids: number[] | null): void;
  openDevelop(id: number): Promise<void>;
  navigate(delta: number): void;
  setRating(rating: number): void;
  setFlag(flag: "none" | "pick" | "reject"): void;
  setColor(color: string): void;
  patchSelection(patch: Partial<Pick<Photo, "rating" | "flag" | "color">>): void;
  removeCurrent(deleteFile: boolean, targetId?: number): Promise<void>;
  removeSelection(deleteFile: boolean): Promise<void>;
  openRelink(id: number): void;
  closeRelink(): void;
  relinkPhoto(path: string): Promise<void>;

  createAutoMask(kind: string): Promise<void>;
  createPointMask(x: number, y: number): Promise<void>;
  runInpaint(localId: string): Promise<void>;
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
  pasteEditsToSelection(ids: number[]): Promise<void>;
  copyLocalMask(): void;
  cutLocalMask(): void;
  pasteLocalMask(): void;
  setCropAspect(ratio: number | null): void;
  saveNow(): Promise<void>;
  bumpVersion(id: number): void;

  setUI(p: Partial<Pick<Store, "beforeAfter" | "showClipping" | "showInfo" | "showHelp" |
    "showImport" | "showExport" | "showModels" | "showAlbums" | "activeTool" | "selectedLocalId" | "showMaskOverlay" |
    "brushSize" | "brushErase" | "cropAspect" | "gridSize" | "panelsCollapsed" | "fullScreen" | "hslPickedBand">>): void;
  notify(msg: string, type?: ToastType, action?: { label: string; onClick: () => void }): void;
  dismissToast(id: number): void;
  markHintSeen(key: string): void;
  reorderPanels(order: string[]): void;
  refreshAiAvailability(): Promise<void>;
}
