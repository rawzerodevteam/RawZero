import { api } from "../api";
import { EditSlider } from "../components/EditSlider";
import { PanelSection } from "../components/PanelSection";
import { useStore } from "../store";
import { defaultEdits, mergeEdits } from "../types";

export function BasicPanel() {
  const edits = useStore((s) => s.edits);
  const currentId = useStore((s) => s.currentId);
  const updateEdits = useStore((s) => s.updateEdits);
  const notify = useStore((s) => s.notify);
  const activeTool = useStore((s) => s.activeTool);
  const setUI = useStore((s) => s.setUI);
  if (!edits) return null;
  const d = defaultEdits();

  const auto = async () => {
    if (currentId === null) return;
    try {
      const suggested = await api.autoAdjust(currentId, edits);
      updateEdits((e) => {
        e.tone.exposure = suggested.tone.exposure;
        e.wb.temp = suggested.wb.temp;
        e.wb.tint = suggested.wb.tint;
      });
      notify("Auto : exposition et balance des blancs ajustées");
    } catch (err) {
      notify(`Auto impossible : ${err}`);
    }
  };

  return (
    <PanelSection
      title="Basique"
      onReset={() => updateEdits((e) => { e.wb = d.wb; e.tone = d.tone; e.presence = d.presence; })}
    >
      <div className="row-actions">
        <button className="btn" onClick={() => void auto()}>Auto</button>
        <button
          className="btn"
          onClick={() => updateEdits((e) => { e.presence.saturation = e.presence.saturation <= -100 ? 0 : -100; })}
        >
          N&B
        </button>
      </div>
      <h4 className="h4-row">
        Balance des blancs
        <button
          className={"pipette-btn" + (activeTool === "wb" ? " active" : "")}
          title="Pipette : cliquer une zone neutre (grise) de l'image"
          aria-label="Pipette balance des blancs"
          onClick={() => setUI({ activeTool: activeTool === "wb" ? "none" : "wb" })}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
            strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m2 22 1-1h3l9-9" />
            <path d="M3 21v-3l9-9" />
            <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z" />
          </svg>
        </button>
      </h4>
      <EditSlider label="Température" value={edits.wb.temp} min={-100} max={100} apply={(e, v) => { e.wb.temp = v; }} />
      <EditSlider label="Teinte" value={edits.wb.tint} min={-100} max={100} apply={(e, v) => { e.wb.tint = v; }} />
      <h4>Tonalité</h4>
      <EditSlider label="Exposition" value={edits.tone.exposure} min={-5} max={5} step={0.05}
        fmt={(v) => (v > 0 ? "+" : "") + v.toFixed(2)} apply={(e, v) => { e.tone.exposure = v; }} />
      <EditSlider label="Contraste" value={edits.tone.contrast} min={-100} max={100} apply={(e, v) => { e.tone.contrast = v; }} />
      <EditSlider label="Hautes lumières" value={edits.tone.highlights} min={-100} max={100} apply={(e, v) => { e.tone.highlights = v; }} />
      <EditSlider label="Ombres" value={edits.tone.shadows} min={-100} max={100} apply={(e, v) => { e.tone.shadows = v; }} />
      <EditSlider label="Blancs" value={edits.tone.whites} min={-100} max={100} apply={(e, v) => { e.tone.whites = v; }} />
      <EditSlider label="Noirs" value={edits.tone.blacks} min={-100} max={100} apply={(e, v) => { e.tone.blacks = v; }} />
      <h4>Présence</h4>
      <EditSlider label="Clarté" value={edits.presence.clarity} min={-100} max={100} apply={(e, v) => { e.presence.clarity = v; }} />
      <EditSlider label="Dehaze" value={edits.presence.dehaze} min={-100} max={100} apply={(e, v) => { e.presence.dehaze = v; }} />
      <EditSlider label="Vibrance" value={edits.presence.vibrance} min={-100} max={100} apply={(e, v) => { e.presence.vibrance = v; }} />
      <EditSlider label="Saturation" value={edits.presence.saturation} min={-100} max={100} apply={(e, v) => { e.presence.saturation = v; }} />
    </PanelSection>
  );
}
