import { EditSlider } from "../components/EditSlider";
import { PanelSection } from "../components/PanelSection";
import { useStore } from "../store";
import { defaultEdits } from "../types";

export function DetailPanel() {
  const edits = useStore((s) => s.edits);
  const updateEdits = useStore((s) => s.updateEdits);
  if (!edits) return null;
  return (
    <PanelSection
      title="Détail"
      defaultOpen={false}
      onReset={() => updateEdits((e) => { e.detail = defaultEdits().detail; })}
    >
      <h4>Netteté</h4>
      <EditSlider label="Gain" value={edits.detail.sharpen_amount} min={0} max={150} reset={25}
        apply={(e, v) => { e.detail.sharpen_amount = v; }} />
      <EditSlider label="Rayon" value={edits.detail.sharpen_radius} min={0.5} max={3} step={0.1} reset={1}
        fmt={(v) => v.toFixed(1)} apply={(e, v) => { e.detail.sharpen_radius = v; }} />
      <h4>Réduction de bruit</h4>
      <EditSlider label="Luminance" value={edits.detail.nr_luma} min={0} max={100}
        apply={(e, v) => { e.detail.nr_luma = v; }} />
      <EditSlider label="Couleur" value={edits.detail.nr_color} min={0} max={100}
        apply={(e, v) => { e.detail.nr_color = v; }} />
    </PanelSection>
  );
}
