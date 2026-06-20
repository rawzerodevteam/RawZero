import { useMemo } from "react";
import { PanelSection } from "../components/PanelSection";
import { historyTimeline, useStore } from "../store";

/** Panneau « Historique » façon Lightroom : liste cliquable des étapes de développement.
 *  La timeline est dérivée des piles undo/redo (cf. historyTimeline) ; cliquer rejoue
 *  undo/redo jusqu'à l'étape voulue. L'étape la plus récente est en haut. */
export function HistoryPanel() {
  const undoStack = useStore((s) => s.undoStack);
  const redoStack = useStore((s) => s.redoStack);
  const undoLabels = useStore((s) => s.undoLabels);
  const redoLabels = useStore((s) => s.redoLabels);
  const currentLabel = useStore((s) => s.currentLabel);
  const edits = useStore((s) => s.edits);
  const jumpHistory = useStore((s) => s.jumpHistory);

  const { steps, index } = useMemo(
    () => historyTimeline({ undoStack, undoLabels, edits, currentLabel, redoStack, redoLabels }),
    [undoStack, undoLabels, edits, currentLabel, redoStack, redoLabels],
  );

  if (!edits) return null;

  return (
    <PanelSection title="Historique" defaultOpen={false}>
      {steps.length <= 1 ? (
        <p className="hint">Aucune modification pour l'instant.</p>
      ) : (
        <ul className="local-list history-list">
          {steps.map((step, i) => i).reverse().map((i) => (
            <li
              key={i}
              className={i === index ? "selected" : (i > index ? "future" : "")}
              title={i === index ? "Étape courante" : "Revenir à cette étape"}
              onClick={() => jumpHistory(i)}
            >
              <span className="step-label">{steps[i].label}</span>
              <span className="tag">{i + 1}</span>
            </li>
          ))}
        </ul>
      )}
    </PanelSection>
  );
}
