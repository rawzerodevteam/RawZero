import { EditSlider } from "../components/EditSlider";
import { PanelSection } from "../components/PanelSection";
import { useStore } from "../store";

export function EffectsPanel() {
  const edits = useStore((s) => s.edits);
  const updateEdits = useStore((s) => s.updateEdits);
  if (!edits) return null;
  return (
    <PanelSection
      title="Effets"
      defaultOpen={false}
      onReset={() => updateEdits((e) => { e.effects = { vignette: 0, grain: 0 }; })}
    >
      <EditSlider label="Vignettage" value={edits.effects.vignette} min={-100} max={100}
        apply={(e, v) => { e.effects.vignette = v; }} />
      <EditSlider label="Grain" value={edits.effects.grain} min={0} max={100}
        apply={(e, v) => { e.effects.grain = v; }} />
    </PanelSection>
  );
}
