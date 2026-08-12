import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { EditSlider } from "../components/EditSlider";
import { PanelSection } from "../components/PanelSection";
import { useStore } from "../store";
import { BAND_COLORS, HSL_BANDS, defaultEdits } from "../types";

const MODES = [["h", "hue"], ["s", "saturation"], ["l", "luminance"]] as const;

export function HSLPanel() {
  const { t } = useTranslation();
  const hasEdits = useStore((s) => s.edits !== null);
  const updateEdits = useStore((s) => s.updateEdits);
  const activeTool = useStore((s) => s.activeTool);
  const setUI = useStore((s) => s.setUI);
  const pickedBand = useStore((s) => s.hslPickedBand);
  const pickSeq = useStore((s) => s.hslPickSeq);
  const [mode, setMode] = useState<"h" | "s" | "l">("s");
  const rowRefs = useRef<Partial<Record<string, HTMLDivElement>>>({});

  // Amène la bande désignée par la pipette (ImageViewer) dans le viewport et l'efface après un
  // court instant : c'est un raccourci pour trouver la bande, pas un état persistant à afficher.
  useEffect(() => {
    if (!pickedBand) return;
    rowRefs.current[pickedBand]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const timer = window.setTimeout(() => setUI({ hslPickedBand: null }), 2000);
    return () => window.clearTimeout(timer);
    // `pickSeq` (pas seulement `pickedBand`) dans les deps : deux pipettes rapprochées sur la MÊME
    // bande avant l'expiration du timer précédent ne changent pas `pickedBand`, donc ne
    // redéclencheraient pas cet effet sans `pickSeq` — le surlignage pourrait disparaître avant que
    // l'utilisateur n'ait vu le second clic (audit1108.md, L11).
  }, [pickedBand, pickSeq, setUI]);

  if (!hasEdits) return null;

  return (
    <PanelSection
      title={t("hsl.title")}
      defaultOpen={false}
      storageKey="hsl"
      onReset={() => updateEdits((e) => { e.hsl = defaultEdits().hsl; })}
    >
      <div className="hsl-tabs">
        {MODES.map(([m, key]) => (
          <button key={m} className={"tab" + (mode === m ? " active" : "")} onClick={() => setMode(m)}>
            {t(`hsl.${key}`)}
          </button>
        ))}
        <button
          className={"pipette-btn" + (activeTool === "hsl" ? " active" : "")}
          title={t("hsl.pipette")}
          aria-label={t("hsl.pipetteAria")}
          onClick={() => setUI({ activeTool: activeTool === "hsl" ? "none" : "hsl" })}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
            strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m2 22 1-1h3l9-9" />
            <path d="M3 21v-3l9-9" />
            <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z" />
          </svg>
        </button>
      </div>
      {HSL_BANDS.map((band) => (
        <div key={band} ref={(el) => { rowRefs.current[band] = el ?? undefined; }}
          className={"hsl-row" + (pickedBand === band ? " picked" : "")}
          style={{ ["--band-color" as any]: BAND_COLORS[band] }}>
          <EditSlider
            label={t(`hsl.band.${band}`)}
            get={(e) => e.hsl[band][mode]}
            min={-100}
            max={100}
            apply={(e, v) => { e.hsl[band][mode] = v; }}
          />
        </div>
      ))}
    </PanelSection>
  );
}
