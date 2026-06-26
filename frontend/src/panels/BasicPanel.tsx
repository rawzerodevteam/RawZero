import { useTranslation } from "react-i18next";
import { api } from "../api";
import { EditSlider } from "../components/EditSlider";
import { PanelSection } from "../components/PanelSection";
import { useStore } from "../store";
import { defaultEdits, mergeEdits } from "../types";

export function BasicPanel() {
  const { t } = useTranslation();
  // Abonnement à l'EXISTENCE des edits (pas à leur contenu) → ce panneau ne se re-rend pas à
  // chaque tick de slider ; chaque EditSlider lit son propre scalaire (cf. EditSlider).
  const hasEdits = useStore((s) => s.edits !== null);
  const currentId = useStore((s) => s.currentId);
  const updateEdits = useStore((s) => s.updateEdits);
  const notify = useStore((s) => s.notify);
  const activeTool = useStore((s) => s.activeTool);
  const setUI = useStore((s) => s.setUI);
  if (!hasEdits) return null;
  const d = defaultEdits();

  const auto = async () => {
    if (currentId === null) return;
    try {
      const edits = useStore.getState().edits;
      if (!edits) return;
      const suggested = await api.autoAdjust(currentId, edits);
      updateEdits((e) => {
        e.tone.exposure = suggested.tone.exposure;
        e.wb.temp = suggested.wb.temp;
        e.wb.tint = suggested.wb.tint;
      });
      notify(t("basic.autoDone"));
    } catch (err) {
      notify(t("basic.autoFailed", { error: String(err) }));
    }
  };

  return (
    <PanelSection
      title={t("basic.title")}
      onReset={() => updateEdits((e) => { e.wb = d.wb; e.tone = d.tone; e.presence = d.presence; })}
    >
      <div className="row-actions">
        <button className="btn" onClick={() => void auto()}>{t("basic.auto")}</button>
        <button
          className="btn"
          onClick={() => updateEdits((e) => { e.presence.saturation = e.presence.saturation <= -100 ? 0 : -100; })}
        >
          {t("basic.bw")}
        </button>
      </div>
      <h4 className="h4-row">
        {t("basic.wb")}
        <button
          className={"pipette-btn" + (activeTool === "wb" ? " active" : "")}
          title={t("basic.wbPipette")}
          aria-label={t("basic.wbPipetteAria")}
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
      <EditSlider label={t("adj.temperature")} get={(e) => e.wb.temp} min={-100} max={100} apply={(e, v) => { e.wb.temp = v; }} />
      <EditSlider label={t("adj.tint")} get={(e) => e.wb.tint} min={-100} max={100} apply={(e, v) => { e.wb.tint = v; }} />
      <h4>{t("basic.tone")}</h4>
      <EditSlider label={t("adj.exposure")} get={(e) => e.tone.exposure} min={-5} max={5} step={0.05}
        fmt={(v) => (v > 0 ? "+" : "") + v.toFixed(2)} apply={(e, v) => { e.tone.exposure = v; }} />
      <EditSlider label={t("adj.contrast")} get={(e) => e.tone.contrast} min={-100} max={100} apply={(e, v) => { e.tone.contrast = v; }} />
      <EditSlider label={t("adj.highlights")} get={(e) => e.tone.highlights} min={-100} max={100} apply={(e, v) => { e.tone.highlights = v; }} />
      <EditSlider label={t("adj.shadows")} get={(e) => e.tone.shadows} min={-100} max={100} apply={(e, v) => { e.tone.shadows = v; }} />
      <EditSlider label={t("adj.whites")} get={(e) => e.tone.whites} min={-100} max={100} apply={(e, v) => { e.tone.whites = v; }} />
      <EditSlider label={t("adj.blacks")} get={(e) => e.tone.blacks} min={-100} max={100} apply={(e, v) => { e.tone.blacks = v; }} />
      <h4>{t("basic.presence")}</h4>
      <EditSlider label={t("adj.clarity")} get={(e) => e.presence.clarity} min={-100} max={100} apply={(e, v) => { e.presence.clarity = v; }} />
      <EditSlider label={t("adj.dehaze")} get={(e) => e.presence.dehaze} min={-100} max={100} apply={(e, v) => { e.presence.dehaze = v; }} />
      <EditSlider label={t("adj.vibrance")} get={(e) => e.presence.vibrance} min={-100} max={100} apply={(e, v) => { e.presence.vibrance = v; }} />
      <EditSlider label={t("adj.saturation")} get={(e) => e.presence.saturation} min={-100} max={100} apply={(e, v) => { e.presence.saturation = v; }} />
    </PanelSection>
  );
}
