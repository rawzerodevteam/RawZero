import { EditSlider } from "../components/EditSlider";
import { PanelSection } from "../components/PanelSection";
import { useStore } from "../store";
import { defaultEdits } from "../types";

const ASPECTS: [string, number | null][] = [
  ["Libre", null], ["1:1", 1], ["3:2", 3 / 2], ["4:3", 4 / 3], ["16:9", 16 / 9],
];

export function GeometryPanel() {
  const edits = useStore((s) => s.edits);
  const updateEdits = useStore((s) => s.updateEdits);
  const activeTool = useStore((s) => s.activeTool);
  const cropAspect = useStore((s) => s.cropAspect);
  const setUI = useStore((s) => s.setUI);
  if (!edits) return null;
  const g = edits.geometry;

  return (
    <PanelSection
      title="Géométrie"
      defaultOpen={false}
      onReset={() => {
        updateEdits((e) => { e.geometry = defaultEdits().geometry; });
        setUI({ activeTool: "none", cropAspect: null });
      }}
    >
      <div className="row-actions">
        <button className="btn" title="Rotation 90° anti-horaire"
          onClick={() => updateEdits((e) => { e.geometry.rotate = (e.geometry.rotate + 270) % 360; })}>
          ⟲ 90°
        </button>
        <button className="btn" title="Rotation 90° horaire"
          onClick={() => updateEdits((e) => { e.geometry.rotate = (e.geometry.rotate + 90) % 360; })}>
          ⟳ 90°
        </button>
        <button className={"btn" + (g.flip_h ? " active" : "")} title="Miroir horizontal"
          onClick={() => updateEdits((e) => { e.geometry.flip_h = !e.geometry.flip_h; })}>
          ⇋ H
        </button>
        <button className={"btn" + (g.flip_v ? " active" : "")} title="Miroir vertical"
          onClick={() => updateEdits((e) => { e.geometry.flip_v = !e.geometry.flip_v; })}>
          ⇵ V
        </button>
      </div>
      <EditSlider label="Redresser" value={g.straighten} min={-10} max={10} step={0.1}
        fmt={(v) => v.toFixed(1) + "°"} apply={(e, v) => { e.geometry.straighten = v; }} />
      <h4>Recadrage</h4>
      <div className="row-actions">
        <button
          className={"btn" + (activeTool === "crop" ? " active" : "")}
          onClick={() => setUI({ activeTool: activeTool === "crop" ? "none" : "crop" })}
        >
          {activeTool === "crop" ? "Terminer (R)" : "Recadrer (R)"}
        </button>
        <button className="btn"
          onClick={() => updateEdits((e) => { e.geometry.crop = { x: 0, y: 0, w: 1, h: 1 }; })}>
          Annuler le recadrage
        </button>
      </div>
      {activeTool === "crop" && (
        <div className="row-actions">
          {ASPECTS.map(([label, ratio]) => (
            <button
              key={label}
              className={"btn small" + (cropAspect === ratio ? " active" : "")}
              onClick={() => setUI({ cropAspect: ratio })}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </PanelSection>
  );
}
