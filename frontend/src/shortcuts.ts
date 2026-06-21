import { useEffect } from "react";
import i18n from "./i18n";
import { useStore } from "./store";

// [touches littérales, clé i18n de la description]
export const SHORTCUTS: [string, string][] = [
  ["← / →", "shortcuts.list.prevNext"],
  ["0 – 5", "shortcuts.list.rating"],
  ["P / X / U", "shortcuts.list.flags"],
  ["6 / 7 / 8 / 9", "shortcuts.list.colorLabels"],
  ["G", "shortcuts.list.grid"],
  ["E", "shortcuts.list.loupe"],
  ["D", "shortcuts.list.develop"],
  ["Ctrl/Maj + clic", "shortcuts.list.multiSelect"],
  ["Z", "shortcuts.list.zoomToggle"],
  ["Espace + glisser", "shortcuts.list.pan"],
  ["\\", "shortcuts.list.beforeAfter"],
  ["J", "shortcuts.list.clipping"],
  ["R", "shortcuts.list.cropTool"],
  ["O", "shortcuts.list.showMask"],
  ["Ctrl+Z / Ctrl+Shift+Z", "shortcuts.list.undoRedo"],
  ["Ctrl+Shift+C / Ctrl+Shift+V", "shortcuts.list.copyPaste"],
  ["Ctrl+E", "shortcuts.list.export"],
  ["I", "shortcuts.list.exif"],
  ["Suppr", "shortcuts.list.removeCatalog"],
  ["Échap", "shortcuts.list.escape"],
  ["?", "shortcuts.list.help"],
];

function isTyping(): boolean {
  const el = document.activeElement;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" ||
    (el as HTMLElement).isContentEditable);
}

// Auto-répétition des flèches : maintenir une flèche fait défiler les photos, puis accélère
// après 1 s. Cadencé par les événements « repeat » de l'OS (pas de timer en arrière-plan)
// et throttlé : ~220 ms au début, ~55 ms passé 1 s (défilement rapide).
let arrowKey = "";
let arrowStart = 0;
let arrowLastNav = 0;

function handleArrow(k: string): void {
  const dir = k === "ArrowRight" ? 1 : -1;
  const now = performance.now();
  if (arrowKey !== k) {            // premier appui : on navigue tout de suite
    arrowKey = k;
    arrowStart = now;
    arrowLastNav = now;
    useStore.getState().navigate(dir);
    return;
  }
  const interval = now - arrowStart > 1000 ? 55 : 220;
  if (now - arrowLastNav >= interval) {
    arrowLastNav = now;
    useStore.getState().navigate(dir);
  }
}

/** Handler global exporté pour être testable sans monter de composant React. */
export function handleGlobalKey(ev: KeyboardEvent) {
  const s = useStore.getState();
  if (isTyping()) return;
  const k = ev.key;

  // Flèches : auto-répétition throttlée (on traite aussi les événements « repeat »).
  if ((k === "ArrowRight" || k === "ArrowLeft") && !ev.ctrlKey && !ev.metaKey) {
    ev.preventDefault();
    handleArrow(k);
    return;
  }
  if (ev.repeat) return;

  if (ev.ctrlKey || ev.metaKey) {
    const lower = k.toLowerCase();
    if (lower === "z" && !ev.shiftKey) { ev.preventDefault(); s.undo(); }
    else if ((lower === "z" && ev.shiftKey) || lower === "y") { ev.preventDefault(); s.redo(); }
    else if (lower === "c" && ev.shiftKey) { ev.preventDefault(); s.copyEdits(); }
    else if (lower === "v" && ev.shiftKey) { ev.preventDefault(); s.pasteEdits(); }
    else if (lower === "e") { ev.preventDefault(); s.setUI({ showExport: true }); }
    return;
  }

  switch (k) {
    case "Escape":
      if (s.showHelp || s.showImport || s.showExport) {
        s.setUI({ showHelp: false, showImport: false, showExport: false });
      } else if (s.activeTool !== "none") {
        s.setUI({ activeTool: "none" });
      } else if (s.view !== "grid") {
        s.setView("grid");
      }
      return;
    case "Delete": case "Backspace":
      if (s.currentId !== null &&
          window.confirm(i18n.t("shortcuts.confirmRemoveCurrent"))) {
        void s.removeCurrent(false);
      }
      return;
    case "?": s.setUI({ showHelp: !s.showHelp }); return;
    case "\\":
      if (s.view === "develop") { ev.preventDefault(); s.setUI({ beforeAfter: !s.beforeAfter }); }
      return;
  }

  if (k >= "0" && k <= "5") {
    s.setRating(Number(k));
    // Pendant le tri (grille / loupe), noter fait passer à la photo suivante.
    if (s.view !== "develop") s.navigate(1);
    return;
  }
  const colorKeys: Record<string, string> = { "6": "red", "7": "yellow", "8": "green", "9": "blue" };
  if (colorKeys[k]) { s.setColor(colorKeys[k]); return; }

  switch (k.toLowerCase()) {
    case "p": s.setFlag("pick"); break;
    case "x": s.setFlag("reject"); break;
    case "u": s.setFlag("none"); break;
    case "g": s.setView("grid"); break;
    case "e": {
      const t = s.currentId ?? s.photos[0]?.id ?? null;
      if (t !== null) { if (s.currentId === null) s.selectPhoto(t); s.setView("loupe"); }
      break;
    }
    case "d": {
      const t = s.currentId ?? s.photos[0]?.id ?? null;
      if (t !== null) void s.openDevelop(t);
      break;
    }
    case "j":
      if (s.view === "develop") s.setUI({ showClipping: !s.showClipping });
      break;
    case "r":
      if (s.view === "develop") s.setUI({ activeTool: s.activeTool === "crop" ? "none" : "crop" });
      break;
    case "o":
      if (s.view === "develop") s.setUI({ showMaskOverlay: !s.showMaskOverlay });
      break;
    case "i":
      s.setUI({ showInfo: !s.showInfo });
      break;
  }
  // Espace (déplacement) et Z (zoom) sont gérés par le visualiseur, via ses propres événements.
}

function resetArrowRepeat() { arrowKey = ""; }

function handleGlobalKeyUp(ev: KeyboardEvent) {
  if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") resetArrowRepeat();
}

export function useGlobalShortcuts() {
  useEffect(() => {
    window.addEventListener("keydown", handleGlobalKey);
    window.addEventListener("keyup", handleGlobalKeyUp);
    // Sécurité : si l'onglet perd le focus, on coupe l'auto-répétition (pas de keyup reçu).
    window.addEventListener("blur", resetArrowRepeat);
    return () => {
      window.removeEventListener("keydown", handleGlobalKey);
      window.removeEventListener("keyup", handleGlobalKeyUp);
      window.removeEventListener("blur", resetArrowRepeat);
    };
  }, []);
}
