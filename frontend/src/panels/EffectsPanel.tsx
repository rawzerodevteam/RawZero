import { useTranslation } from "react-i18next";
import { EditSlider } from "../components/EditSlider";
import { PanelSection } from "../components/PanelSection";
import { useStore } from "../store";

export function EffectsPanel() {
  const { t } = useTranslation();
  const hasEdits = useStore((s) => s.edits !== null);
  const updateEdits = useStore((s) => s.updateEdits);
  if (!hasEdits) return null;
  return (
    <PanelSection
      title={t("effects.title")}
      defaultOpen={false}
      storageKey="effects"
      onReset={() => updateEdits((e) => { e.effects = { vignette: 0, grain: 0 }; })}
    >
      <EditSlider label={t("effects.vignette")} get={(e) => e.effects.vignette} min={-100} max={100}
        apply={(e, v) => { e.effects.vignette = v; }} />
      <EditSlider label={t("effects.grain")} get={(e) => e.effects.grain} min={0} max={100}
        apply={(e, v) => { e.effects.grain = v; }} />
    </PanelSection>
  );
}
