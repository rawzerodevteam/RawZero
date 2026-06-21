import { useState } from "react";
import { useTranslation } from "react-i18next";
import { EditSlider } from "../components/EditSlider";
import { PanelSection } from "../components/PanelSection";
import { useStore } from "../store";
import { BAND_COLORS, HSL_BANDS, defaultEdits } from "../types";

const MODES = [["h", "hue"], ["s", "saturation"], ["l", "luminance"]] as const;

export function HSLPanel() {
  const { t } = useTranslation();
  const edits = useStore((s) => s.edits);
  const updateEdits = useStore((s) => s.updateEdits);
  const [mode, setMode] = useState<"h" | "s" | "l">("s");
  if (!edits) return null;

  return (
    <PanelSection
      title={t("hsl.title")}
      defaultOpen={false}
      onReset={() => updateEdits((e) => { e.hsl = defaultEdits().hsl; })}
    >
      <div className="hsl-tabs">
        {MODES.map(([m, key]) => (
          <button key={m} className={"tab" + (mode === m ? " active" : "")} onClick={() => setMode(m)}>
            {t(`hsl.${key}`)}
          </button>
        ))}
      </div>
      {HSL_BANDS.map((band) => (
        <div key={band} className="hsl-row" style={{ ["--band-color" as any]: BAND_COLORS[band] }}>
          <EditSlider
            label={t(`hsl.band.${band}`)}
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
