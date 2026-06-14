import { useEffect } from "react";
import { useStore } from "./store";

export const SHORTCUTS: [string, string][] = [
  ["← / →", "Photo précédente / suivante"],
  ["0 – 5", "Note en étoiles"],
  ["P / X / U", "Drapeau : retenue / rejetée / neutre"],
  ["6 / 7 / 8 / 9", "Label couleur : rouge / jaune / vert / bleu"],
  ["G", "Grille (bibliothèque)"],
  ["E", "Zoom (tri rapide)"],
  ["D", "Mode développement"],
  ["Ctrl/Maj + clic", "Sélection multiple (clic droit pour exporter…)"],
  ["Espace ou Z", "Zoom ajusté ↔ 100 % (glisser pour naviguer)"],
  ["\\", "Avant / après"],
  ["J", "Alertes d'écrêtage"],
  ["R", "Outil recadrage"],
  ["O", "Afficher le masque local sélectionné"],
  ["Ctrl+Z / Ctrl+Shift+Z", "Annuler / rétablir"],
  ["Ctrl+Shift+C / Ctrl+Shift+V", "Copier / coller les réglages"],
  ["Ctrl+E", "Exporter"],
  ["I", "Infos EXIF"],
  ["Suppr", "Retirer du catalogue"],
  ["Échap", "Fermer / quitter l'outil"],
  ["?", "Cette aide"],
];

function isTyping(): boolean {
  const el = document.activeElement;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" ||
    (el as HTMLElement).isContentEditable);
}

/** Handler global exporté pour être testable sans monter de composant React. */
export function handleGlobalKey(ev: KeyboardEvent) {
  if (ev.repeat) return;
  const s = useStore.getState();
  if (isTyping()) return;
  const k = ev.key;

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
    case "ArrowRight": ev.preventDefault(); s.navigate(1); return;
    case "ArrowLeft": ev.preventDefault(); s.navigate(-1); return;
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
          window.confirm("Retirer cette photo du catalogue ? (le fichier importé sera conservé sur le disque)")) {
        void s.removeCurrent(false);
      }
      return;
    case "?": s.setUI({ showHelp: !s.showHelp }); return;
    case "\\":
      if (s.view === "develop") { ev.preventDefault(); s.setUI({ beforeAfter: !s.beforeAfter }); }
      return;
  }

  if (k >= "0" && k <= "5") { s.setRating(Number(k)); return; }
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
  // Espace et Z sont gérés par le visualiseur (zoom), via les événements du composant.
}

export function useGlobalShortcuts() {
  useEffect(() => {
    window.addEventListener("keydown", handleGlobalKey);
    return () => window.removeEventListener("keydown", handleGlobalKey);
  }, []);
}
