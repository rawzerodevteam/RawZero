import { useEffect } from "react";
import i18n from "./i18n";
import { actionForEvent } from "./keybindings";
import { confirmDialog } from "./lib/dialog";
import { useStore } from "./store";

// Types de <input> qui ne sont pas de la saisie de texte (sliders notamment) : le focus y reste
// après un glisser, il ne doit pas bloquer les raccourcis clavier globaux (issue #40).
const _NON_TEXT_INPUT = new Set(["range", "checkbox", "radio", "button", "color", "file", "submit", "reset"]);
function isTyping(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el as HTMLElement).isContentEditable) return true;
  if (el.tagName === "INPUT") return !_NON_TEXT_INPUT.has((el as HTMLInputElement).type);
  return false;
}

// Auto-répétition des flèches : maintenir une flèche fait défiler les photos, puis accélère
// après 1 s. Cadencé par les événements « repeat » de l'OS (pas de timer en arrière-plan)
// et throttlé : ~220 ms au début, ~55 ms passé 1 s (défilement rapide).
let arrowAction = "";
let arrowStart = 0;
let arrowLastNav = 0;

function handleArrow(action: string, dir: number): void {
  const now = performance.now();
  if (arrowAction !== action) {       // premier appui : on navigue tout de suite
    arrowAction = action;
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

/** Exécute une action (résolue depuis le registre de raccourcis), selon le contexte courant. */
function dispatch(action: string, s: ReturnType<typeof useStore.getState>, ev: KeyboardEvent): void {
  if (action.startsWith("rate-")) {
    s.setRating(Number(action.slice(5)));
    // Pendant le tri (grille / loupe), noter fait passer à la photo suivante.
    if (s.view !== "develop") s.navigate(1);
    return;
  }
  switch (action) {
    case "flag-pick": s.setFlag("pick"); return;
    case "flag-reject": s.setFlag("reject"); return;
    case "flag-none": s.setFlag("none"); return;
    case "color-red": s.setColor("red"); return;
    case "color-yellow": s.setColor("yellow"); return;
    case "color-green": s.setColor("green"); return;
    case "color-blue": s.setColor("blue"); return;
    case "view-grid": s.setView("grid"); return;
    case "view-loupe": {
      const t = s.currentId ?? s.photos[0]?.id ?? null;
      if (t !== null) { if (s.currentId === null) s.selectPhoto(t); s.setView("loupe"); }
      return;
    }
    case "view-develop": {
      const t = s.currentId ?? s.photos[0]?.id ?? null;
      if (t !== null) void s.openDevelop(t);
      return;
    }
    case "before-after":
      if (s.view === "develop") { ev.preventDefault(); s.setUI({ beforeAfter: !s.beforeAfter }); }
      return;
    case "clipping":
      if (s.view === "develop") s.setUI({ showClipping: !s.showClipping });
      return;
    case "crop":
      if (s.view === "develop") s.setUI({ activeTool: s.activeTool === "crop" ? "none" : "crop" });
      return;
    case "mask-overlay":
      if (s.view === "develop") s.setUI({ showMaskOverlay: !s.showMaskOverlay });
      return;
    case "info": s.setUI({ showInfo: !s.showInfo }); return;
    case "fullscreen":
      if (s.view === "develop") s.setUI({ fullScreen: !s.fullScreen });
      return;
    case "undo": ev.preventDefault(); s.undo(); return;
    case "redo": ev.preventDefault(); s.redo(); return;
    case "select-all": ev.preventDefault(); s.selectAll(); return;
    case "copy": ev.preventDefault(); s.copyEdits(); return;
    case "paste": ev.preventDefault(); s.pasteEdits(); return;
    case "copy-mask":
      if (s.view === "develop" && s.selectedLocalId) { ev.preventDefault(); s.copyLocalMask(); }
      return;
    case "cut-mask":
      if (s.view === "develop" && s.selectedLocalId) { ev.preventDefault(); s.cutLocalMask(); }
      return;
    case "paste-mask":
      if (s.view === "develop" && s.localClipboard) { ev.preventDefault(); s.pasteLocalMask(); }
      return;
    case "export": ev.preventDefault(); s.setUI({ showExport: true }); return;
    case "remove":
      if (s.currentId !== null) {
        // Fige la photo visée au moment de la demande (pas à la résolution) : cf. store.ts
        // removeCurrent, un 2e Suppr avant fermeture du 1er dialogue ne doit pas dériver vers
        // la photo suivante si currentId a déjà avancé pendant la 1ʳᵉ suppression.
        const id = s.currentId;
        void confirmDialog(i18n.t("shortcuts.confirmRemoveCurrent"), { danger: true })
          .then((ok) => { if (ok) void s.removeCurrent(false, id); });
      }
      return;
    case "help": s.setUI({ showHelp: !s.showHelp }); return;
    // "zoom-toggle" et "pan" sont gérés par le visualiseur (ils dépendent de la souris).
  }
}

/** Handler global exporté pour être testable sans monter de composant React. */
export function handleGlobalKey(ev: KeyboardEvent) {
  const s = useStore.getState();
  if (isTyping()) return;
  const action = actionForEvent(ev);

  // Flèches : auto-répétition throttlée (on traite aussi les événements « repeat »).
  if (action === "nav-prev" || action === "nav-next") {
    ev.preventDefault();
    handleArrow(action, action === "nav-next" ? 1 : -1);
    return;
  }
  if (ev.repeat) return;

  // Échap : fermeture universelle (non rebindable), prioritaire.
  if (ev.key === "Escape") {
    if (s.showHelp || s.showImport || s.showExport || s.showModels) {
      s.setUI({ showHelp: false, showImport: false, showExport: false, showModels: false });
    } else if (s.fullScreen) {
      s.setUI({ fullScreen: false });
    } else if (s.view === "settings") {
      s.setView("grid");
    } else if (s.activeTool !== "none") {
      s.setUI({ activeTool: "none" });
    } else if (s.view === "grid" && s.selection.length) {
      s.setSelection([]); // filet de sécurité : Échap vide la sélection (sortir du « tout bleu »)
    } else if (s.view !== "grid") {
      s.setView("grid");
    }
    return;
  }

  // Dans l'onglet Paramètres, on neutralise les raccourcis (sauf Échap, déjà traité ci-dessus)
  // pour ne pas naviguer par mégarde pendant la capture/lecture des touches.
  if (s.view === "settings") return;

  // Alias hérité : Ctrl+Y = rétablir.
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "y") { ev.preventDefault(); s.redo(); return; }

  if (action) dispatch(action, s, ev);
}

function resetArrowRepeat() { arrowAction = ""; }

function handleGlobalKeyUp(ev: KeyboardEvent) {
  const action = actionForEvent(ev);
  if (action === "nav-prev" || action === "nav-next") resetArrowRepeat();
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
