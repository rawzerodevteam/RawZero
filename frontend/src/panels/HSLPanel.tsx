import { useState } from "react";
import { EditSlider } from "../components/EditSlider";
import { PanelSection } from "../components/PanelSection";
import { useStore } from "../store";
import { BAND_COLORS, BAND_LABELS, HSL_BANDS, defaultEdits } from "../types";

const MODES = [["h", "Teinte"], ["s", "Saturation"], ["l", "Luminance"]] as const;

export function HSLPanel() {
  const edits = useStore((s) => s.edits);
  const updateEdits = useStore((s) => s.updateEdits);
  const [mode, setMode] = useState<"h" | "s" | "l">("s");
  if (!edits) return null;

  return (
    <PanelSection
      title="HSL / Couleur"
      defaultOpen={false}
      onReset={() => updateEdits((e) => { e.hsl = defaultEdits().hsl; })}
    >
      <div className="hsl-tabs">
        {MODES.map(([m, label]) => (
          <button key={m} className={"tab" + (mode === m ? " active" : "")} onClick={() => setMode(m)}>
            {label}
          </button>
        ))}
      </div>
      {HSL_BANDS.map((band) => (
        <div key={band} className="hsl-row" style={{ ["--band-color" as any]: BAND_COLORS[band] }}>
          <EditSlider
            label={BAND_LABELS[band]}
            value={edits.hsl[band][mode]}
            min={-100}
            max={100}
            apply={(e, v) => { e.hsl[band][mode] = v; }}
          />
        </div>
      ))}
    </PanelSection>
  );
}
