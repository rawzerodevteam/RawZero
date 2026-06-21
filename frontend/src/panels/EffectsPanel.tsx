import { useTranslation } from "react-i18next";
import { EditSlider } from "../components/EditSlider";
import { PanelSection } from "../components/PanelSection";
import { useStore } from "../store";

export function EffectsPanel() {
  const { t } = useTranslation();
  const edits = useStore((s) => s.edits);
  const updateEdits = useStore((s) => s.updateEdits);
  if (!edits) return null;
  return (
    <PanelSection
      title={t("effects.title")}
      defaultOpen={false}
      onReset={() => updateEdits((e) => { e.effects = { vignette: 0, grain: 0 }; })}
    >
      <EditSlider label={t("effects.vignette")} value={edits.effects.vignette} min={-100} max={100}
        apply={(e, v) => { e.effects.vignette = v; }} />
      <EditSlider label={t("effects.grain")} value={edits.effects.grain} min={0} max={100}
        apply={(e, v) => { e.effects.grain = v; }} />
    </PanelSection>
  );
}
