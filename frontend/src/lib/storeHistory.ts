import { mergeEdits, type EditState, type HistoryData, type HistoryStep } from "../types";
import i18n from "../i18n";

/** Reconstruction/restauration de la timeline d'historique (panneau « Historique ») — extrait de
 *  `store.ts` (TODO N11) : pures fonctions de (dé)sérialisation, aucune dépendance sur le store. */

// Libellé de l'étape « origine » de l'historique, dans la langue courante.
export const originLabel = () => i18n.t("history.origin");

interface HistorySourceState {
  edits: EditState | null;
  currentLabel: string;
  undoStack: EditState[]; undoLabels: string[];
  redoStack: EditState[]; redoLabels: string[];
}

/** Reconstruit la timeline d'historique (chronologique) à partir des piles undo/redo + libellés. */
export function historyTimeline(s: HistorySourceState): HistoryData {
  if (!s.edits) return { steps: [], index: 0 };
  const steps: HistoryStep[] = s.undoStack.map((edits, i) => ({ label: s.undoLabels[i] ?? i18n.t("history.change"), edits }));
  steps.push({ label: s.currentLabel, edits: s.edits });
  for (let k = s.redoStack.length - 1; k >= 0; k--)
    steps.push({ label: s.redoLabels[k] ?? i18n.t("history.change"), edits: s.redoStack[k] });
  return { steps, index: s.undoStack.length };
}

export interface HistoryParts {
  edits: EditState; currentLabel: string;
  undoStack: EditState[]; undoLabels: string[]; redoStack: EditState[]; redoLabels: string[];
}

/** Restaure les piles d'historique depuis la forme persistée ; repli sur une étape unique. */
export function loadHistory(raw: any, fallbackEdits: EditState): HistoryParts {
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
