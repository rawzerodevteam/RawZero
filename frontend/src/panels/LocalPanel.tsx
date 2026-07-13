import { useTranslation } from "react-i18next";
import { EditSlider } from "../components/EditSlider";
import { PanelSection } from "../components/PanelSection";
import { useStore, type Tool } from "../store";
import { defaultLocalAdjust, type LocalAdjustValues } from "../types";

const RANGE_DEFAULTS: Record<string, Record<string, number>> = {
  lumrange: { lo: 0.25, hi: 0.75, smooth: 0.1 },
  colorrange: { hue: 0, range: 30, smooth: 15, sat_min: 0.15 },
};

// label/hint = clés i18n (cf. local.tool.*) ; icon reste littéral.
const TOOLS: { tool: Tool; icon: string; label: string; hint: string }[] = [
  { tool: "linear", icon: "▤", label: "local.tool.linear", hint: "local.tool.linearHint" },
  { tool: "radial", icon: "◎", label: "local.tool.radial", hint: "local.tool.radialHint" },
  { tool: "brush", icon: "✎", label: "local.tool.brush", hint: "local.tool.brushHint" },
];

export function LocalPanel() {
  const { t } = useTranslation();
  const hasEdits = useStore((s) => s.edits !== null);
  // Signature de STRUCTURE de la liste de masques (pas des valeurs) : ce panneau ne se re-rend
  // que quand la structure change (ajout/suppression/type/invert/sélection), pas à chaque tick
  // d'un slider local — ceux-ci lisent leur propre scalaire via `get` (cf. LocalSlider/ParamSlider).
  const localsSig = useStore((s) =>
    s.edits ? s.edits.locals.map((l) => `${l.id}:${l.type}:${l.params.kind ?? ""}:${l.invert ? 1 : 0}`).join("|") : "");
  const updateEdits = useStore((s) => s.updateEdits);
  const activeTool = useStore((s) => s.activeTool);
  const selectedLocalId = useStore((s) => s.selectedLocalId);
  const showMaskOverlay = useStore((s) => s.showMaskOverlay);
  const brushSize = useStore((s) => s.brushSize);
  const brushErase = useStore((s) => s.brushErase);
  const setUI = useStore((s) => s.setUI);
  const aiSubjectAvailable = useStore((s) => s.aiSubjectAvailable);
  const aiSkyAvailable = useStore((s) => s.aiSkyAvailable);
  const aiPointAvailable = useStore((s) => s.aiPointAvailable);
  const aiMaskBusy = useStore((s) => s.aiMaskBusy);
  const createAutoMask = useStore((s) => s.createAutoMask);
  if (!hasEdits) return null;
  void localsSig; // déclenche le re-rendu sur changement de structure ; la lecture se fait via getState

  // Lu au rendu : la réactivité vient de localsSig (structure) et selectedLocalId. Seules des
  // données STRUCTURELLES (type/invert/kind/id) en sont tirées — les valeurs passent par `get`.
  const allLocals = useStore.getState().edits!.locals;
  const selected = allLocals.find((l) => l.id === selectedLocalId) ?? null;

  const removeSelected = () => {
    if (!selected) return;
    updateEdits((e) => { e.locals = e.locals.filter((l) => l.id !== selected.id); });
    setUI({ selectedLocalId: null, activeTool: "none" });
  };

  // Masques par plage : pas d'interaction spatiale, on crée directement le masque + on le sélectionne.
  const addRangeMask = (type: "lumrange" | "colorrange") => {
    const id = Math.random().toString(36).slice(2);
    updateEdits((e) => {
      e.locals.push({ id, type, params: { ...RANGE_DEFAULTS[type] }, invert: false, adjust: defaultLocalAdjust() });
    });
    setUI({ selectedLocalId: id, activeTool: "none", showMaskOverlay: true });
  };

  return (
    <PanelSection title={t("local.title")} defaultOpen={false} storageKey="local">
      <div className="row-actions">
        {TOOLS.map(({ tool, icon, label, hint }) => (
          <button
            key={tool}
            className={"btn" + (activeTool === tool ? " active" : "")}
            title={t(hint)}
            onClick={() => setUI({ activeTool: activeTool === tool ? "none" : tool })}
          >
            {icon} {t(label)}
          </button>
        ))}
      </div>
      {TOOLS.some((x) => x.tool === activeTool) && (
        <p className="hint">{t(TOOLS.find((x) => x.tool === activeTool)!.hint)}</p>
      )}
      {(aiSubjectAvailable || aiSkyAvailable || aiPointAvailable) && (
        <div className="row-actions ai-actions">
          {aiPointAvailable && (
            <button
              className={"btn ai-mask" + (activeTool === "pointmask" ? " active" : "") + (aiMaskBusy ? " busy" : "")}
              disabled={aiMaskBusy}
              title={t("local.pointTitle")}
              onClick={() => setUI({ activeTool: activeTool === "pointmask" ? "none" : "pointmask" })}
            >
              {aiMaskBusy ? t("local.computing") : t("local.manualSelect")}
            </button>
          )}
          {aiSubjectAvailable && (
            <button
              className={"btn ai-mask" + (aiMaskBusy ? " busy" : "")}
              disabled={aiMaskBusy}
              title={t("local.subjectTitle")}
              onClick={() => void createAutoMask("subject")}
            >
              {aiMaskBusy ? t("local.computing") : t("local.autoSelect")}
            </button>
          )}
          {aiSkyAvailable && (
            <button
              className={"btn ai-mask" + (aiMaskBusy ? " busy" : "")}
              disabled={aiMaskBusy}
              title={t("local.skyTitle")}
              onClick={() => void createAutoMask("sky")}
            >
              {aiMaskBusy ? t("local.computing") : t("local.skySelect")}
            </button>
          )}
        </div>
      )}
      <div className="row-actions">
        <button className="btn" title={t("local.lumRangeTitle")}
          onClick={() => addRangeMask("lumrange")}>◐ {t("local.lumRange")}</button>
        <button className="btn" title={t("local.colorRangeTitle")}
          onClick={() => addRangeMask("colorrange")}>◑ {t("local.colorRange")}</button>
      </div>
      {activeTool === "pointmask" && (
        <p className="hint">
          {selected?.type === "ai" ? t("local.pointAddHint") : t("local.pointHint")}
        </p>
      )}
      {activeTool === "brush" && (
        <>
          <div className="slider-row">
            <span className="slider-label">{t("local.brushSize")}</span>
            <input
              type="range" min={1} max={30} value={Math.round(brushSize * 100)}
              onChange={(ev) => setUI({ brushSize: Number(ev.target.value) / 100 })}
            />
            <span className="slider-value">{Math.round(brushSize * 100)}</span>
          </div>
          <div className="row-actions">
            <button
              className={"btn small" + (brushErase ? " active" : "")}
              onClick={() => setUI({ brushErase: !brushErase })}
            >
              {t("local.eraser")}
            </button>
          </div>
        </>
      )}

      {allLocals.length > 0 && (
        <ul className="local-list">
          {allLocals.map((l, i) => (
            <li
              key={l.id}
              className={l.id === selectedLocalId ? "selected" : ""}
              role="button"
              tabIndex={0}
              aria-pressed={l.id === selectedLocalId}
              onClick={() => setUI({
                selectedLocalId: l.id === selectedLocalId ? null : l.id,
                activeTool: l.type === "brush" && l.id !== selectedLocalId ? "brush" : "none",
              })}
              onKeyDown={(ev) => {
                if (ev.key !== "Enter" && ev.key !== " ") return;
                ev.preventDefault();
                setUI({
                  selectedLocalId: l.id === selectedLocalId ? null : l.id,
                  activeTool: l.type === "brush" && l.id !== selectedLocalId ? "brush" : "none",
                });
              }}
            >
              <span>{i + 1}. {t(l.type === "ai" && l.params.kind === "sky" ? "local.type.sky" : `local.type.${l.type}`)}</span>
              {l.invert && <span className="tag">{t("local.invTag")}</span>}
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <div className="local-adjust">
          <div className="row-actions">
            <button
              className={"btn small" + (selected.invert ? " active" : "")}
              onClick={() => updateEdits((e) => {
                const loc = e.locals.find((l) => l.id === selected.id);
                if (loc) loc.invert = !loc.invert;
              })}
            >
              {t("local.invert")}
            </button>
            <button
              className={"btn small" + (showMaskOverlay ? " active" : "")}
              title={t("local.showMaskTitle")}
              onClick={() => setUI({ showMaskOverlay: !showMaskOverlay })}
            >
              {t("local.maskToggle")}
            </button>
            <button className="btn small danger" onClick={removeSelected}>{t("common.delete")}</button>
          </div>
          <p className="hint">{t("local.copyPasteHint")}</p>
          {(selected.type === "radial" || selected.type === "brush") && (
            <EditSlider label={t("local.feather")}
              get={(e) => ((e.locals.find((l) => l.id === selected.id)?.params.feather ?? 0.5) * 100)}
              min={0} max={100} reset={50}
              apply={(e, v) => {
                const loc = e.locals.find((l) => l.id === selected.id);
                if (loc) loc.params.feather = v / 100;
              }} />
          )}
          {selected.type === "ai" && (
            <EditSlider label={t("local.hardness")}
              get={(e) => (e.locals.find((l) => l.id === selected.id)?.params.hardness ?? 0)}
              min={0} max={100} reset={0}
              apply={(e, v) => {
                const loc = e.locals.find((l) => l.id === selected.id);
                if (loc) loc.params.hardness = v;
              }} />
          )}
          {selected.type === "lumrange" && (
            <>
              <ParamSlider id={selected.id} label={t("local.min")} pk="lo"
                min={0} max={1} step={0.01} reset={0.25} fmt={(v) => v.toFixed(2)} />
              <ParamSlider id={selected.id} label={t("local.max")} pk="hi"
                min={0} max={1} step={0.01} reset={0.75} fmt={(v) => v.toFixed(2)} />
              <ParamSlider id={selected.id} label={t("local.transition")} pk="smooth"
                min={0.01} max={0.5} step={0.01} reset={0.1} fmt={(v) => v.toFixed(2)} />
            </>
          )}
          {selected.type === "colorrange" && (
            <>
              <ParamSlider id={selected.id} label={t("hsl.hue")} pk="hue"
                min={0} max={360} step={1} reset={0} fmt={(v) => `${Math.round(v)}°`} />
              <ParamSlider id={selected.id} label={t("local.range")} pk="range"
                min={0} max={120} step={1} reset={30} fmt={(v) => `${Math.round(v)}°`} />
              <ParamSlider id={selected.id} label={t("local.transition")} pk="smooth"
                min={1} max={60} step={1} reset={15} fmt={(v) => `${Math.round(v)}°`} />
              <ParamSlider id={selected.id} label={t("local.satMin")} pk="sat_min"
                min={0} max={1} step={0.01} reset={0.15} fmt={(v) => v.toFixed(2)} />
            </>
          )}
          <LocalSlider id={selected.id} label={t("adj.exposure")} k="exposure" min={-3} max={3} step={0.05}
            fmt={(v) => (v > 0 ? "+" : "") + v.toFixed(2)} />
          <LocalSlider id={selected.id} label={t("adj.contrast")} k="contrast" />
          <LocalSlider id={selected.id} label={t("adj.highlights")} k="highlights" />
          <LocalSlider id={selected.id} label={t("adj.shadows")} k="shadows" />
          <LocalSlider id={selected.id} label={t("adj.temperature")} k="temp" />
          <LocalSlider id={selected.id} label={t("adj.tint")} k="tint" />
          <LocalSlider id={selected.id} label={t("adj.saturation")} k="saturation" />
          <LocalSlider id={selected.id} label={t("adj.clarity")} k="clarity" />
          <LocalSlider id={selected.id} label={t("local.sharpness")} k="sharpness" />
          <div className="row-actions">
            <button className="btn small" onClick={() => updateEdits((e) => {
              const loc = e.locals.find((l) => l.id === selected.id);
              if (loc) loc.adjust = defaultLocalAdjust();
            })}>
              {t("local.resetAdjust")}
            </button>
          </div>
        </div>
      )}
    </PanelSection>
  );
}

/** Slider agissant sur un paramètre de masque (loc.params[pk]) — masques par plage.
 *  Abonnement granulaire : lit son scalaire via `get` (défaut = reset si le param est absent). */
function ParamSlider({ id, label, pk, min, max, step, reset, fmt }: {
  id: string; label: string; pk: string;
  min: number; max: number; step: number; reset: number; fmt: (v: number) => string;
}) {
  return (
    <EditSlider
      label={label} min={min} max={max} step={step} reset={reset} fmt={fmt}
      get={(e) => { const v = e.locals.find((l) => l.id === id)?.params[pk]; return typeof v === "number" ? v : reset; }}
      apply={(e, v) => {
        const loc = e.locals.find((l) => l.id === id);
        if (loc) loc.params[pk] = v;
      }}
    />
  );
}

function LocalSlider({ id, label, k, min = -100, max = 100, step = 1, fmt }: {
  id: string; label: string; k: keyof LocalAdjustValues;
  min?: number; max?: number; step?: number; fmt?: (v: number) => string;
}) {
  return (
    <EditSlider
      label={label} min={min} max={max} step={step} fmt={fmt}
      get={(e) => e.locals.find((l) => l.id === id)?.adjust[k] ?? 0}
      apply={(e, v) => {
        const loc = e.locals.find((l) => l.id === id);
        if (loc) loc.adjust[k] = v;
      }}
    />
  );
}
