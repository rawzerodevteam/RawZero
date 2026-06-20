import { EditSlider } from "../components/EditSlider";
import { PanelSection } from "../components/PanelSection";
import { useStore } from "../store";
import { defaultEdits } from "../types";

/** Force de débruitage IA suggérée d'après l'ISO : 0 sous ~800 ISO, ~18/octave au-delà. */
function suggestNrAi(iso: number): number {
  if (!iso || iso <= 800) return 0;
  return Math.round(Math.min(Math.max(Math.log2(iso / 800) * 18, 0), 80));
}

export function DetailPanel() {
  const edits = useStore((s) => s.edits);
  const updateEdits = useStore((s) => s.updateEdits);
  const denoiseAvailable = useStore((s) => s.aiDenoiseAvailable);
  const currentId = useStore((s) => s.currentId);
  const iso = useStore((s) => s.photos.find((p) => p.id === currentId)?.iso ?? 0);
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
      <h4 className="h4-row">
        Réduction de bruit IA
        {denoiseAvailable && (
          <button className="btn small" title="Suggérer la force d'après l'ISO"
            onClick={() => updateEdits((e) => { e.detail.nr_ai = suggestNrAi(iso); })}>
            Auto
          </button>
        )}
      </h4>
      {denoiseAvailable ? (
        <EditSlider label="Force" value={edits.detail.nr_ai} min={0} max={100}
          apply={(e, v) => { e.detail.nr_ai = v; }} />
      ) : (
        <p className="dim hint">Modèle absent (déposer <code>ffdnet_color.onnx</code> dans <code>data/models/</code>).</p>
      )}
      <h4>Défrange (aberration chromatique)</h4>
      <EditSlider label="Pourpre" value={edits.detail.defringe_purple} min={0} max={100}
        apply={(e, v) => { e.detail.defringe_purple = v; }} />
      <EditSlider label="Vert" value={edits.detail.defringe_green} min={0} max={100}
        apply={(e, v) => { e.detail.defringe_green = v; }} />
    </PanelSection>
  );
}
