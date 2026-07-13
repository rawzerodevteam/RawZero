import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  const hasEdits = useStore((s) => s.edits !== null);
  const updateEdits = useStore((s) => s.updateEdits);
  const denoiseAvailable = useStore((s) => s.aiDenoiseAvailable);
  const currentId = useStore((s) => s.currentId);
  const iso = useStore((s) => s.photos.find((p) => p.id === currentId)?.iso ?? 0);
  if (!hasEdits) return null;
  return (
    <PanelSection
      title={t("detail.title")}
      defaultOpen={false}
      storageKey="detail"
      onReset={() => updateEdits((e) => { e.detail = defaultEdits().detail; })}
    >
      <h4>{t("detail.sharpen")}</h4>
      <EditSlider label={t("detail.gain")} get={(e) => e.detail.sharpen_amount} min={0} max={150} reset={25}
        apply={(e, v) => { e.detail.sharpen_amount = v; }} />
      <EditSlider label={t("detail.radius")} get={(e) => e.detail.sharpen_radius} min={0.5} max={3} step={0.1} reset={1}
        fmt={(v) => v.toFixed(1)} apply={(e, v) => { e.detail.sharpen_radius = v; }} />
      <h4>{t("detail.nr")}</h4>
      <EditSlider label={t("detail.luminance")} get={(e) => e.detail.nr_luma} min={0} max={100}
        apply={(e, v) => { e.detail.nr_luma = v; }} />
      <EditSlider label={t("detail.color")} get={(e) => e.detail.nr_color} min={0} max={100}
        apply={(e, v) => { e.detail.nr_color = v; }} />
      <h4 className="h4-row">
        {t("detail.nrAi")}
        {denoiseAvailable && (
          <button className="btn small" title={t("detail.nrAiAutoTitle")}
            onClick={() => updateEdits((e) => { e.detail.nr_ai = suggestNrAi(iso); })}>
            {t("basic.auto")}
          </button>
        )}
      </h4>
      {denoiseAvailable ? (
        <EditSlider label={t("detail.force")} get={(e) => e.detail.nr_ai} min={0} max={100}
          apply={(e, v) => { e.detail.nr_ai = v; }} />
      ) : (
        <p className="dim hint">{t("detail.modelMissing")}</p>
      )}
      <h4>{t("detail.defringe")}</h4>
      <EditSlider label={t("detail.defringePurple")} get={(e) => e.detail.defringe_purple} min={0} max={100}
        apply={(e, v) => { e.detail.defringe_purple = v; }} />
      <EditSlider label={t("detail.defringeGreen")} get={(e) => e.detail.defringe_green} min={0} max={100}
        apply={(e, v) => { e.detail.defringe_green = v; }} />
    </PanelSection>
  );
}
