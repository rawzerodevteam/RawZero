import { useTranslation } from "react-i18next";
import { CurveEditor } from "../components/CurveEditor";
import { PanelSection } from "../components/PanelSection";
import { useStore } from "../store";

export function CurvePanel() {
  const { t } = useTranslation();
  const edits = useStore((s) => s.edits);
  const updateEdits = useStore((s) => s.updateEdits);
  if (!edits) return null;
  return (
    <PanelSection
      title={t("curve.title")}
      defaultOpen={false}
      storageKey="curve"
      onReset={() => updateEdits((e) => {
        e.curve.points = [[0, 0], [1, 1]];
        e.curve.r = [[0, 0], [1, 1]];
        e.curve.g = [[0, 0], [1, 1]];
        e.curve.b = [[0, 0], [1, 1]];
      })}
    >
      <CurveEditor />
      <p className="hint">{t("curve.hint")}</p>
    </PanelSection>
  );
}
