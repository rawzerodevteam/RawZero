import { EditSlider } from "../components/EditSlider";
import { PanelSection } from "../components/PanelSection";
import { useStore, type Tool } from "../store";
import { defaultLocalAdjust, type LocalAdjustValues } from "../types";

const TYPE_LABELS: Record<string, string> = {
  linear: "Dégradé linéaire", radial: "Filtre radial", brush: "Pinceau", ai: "Sujet (IA)",
  lumrange: "Plage de luminance", colorrange: "Plage de couleur",
};

const RANGE_DEFAULTS: Record<string, Record<string, number>> = {
  lumrange: { lo: 0.25, hi: 0.75, smooth: 0.1 },
  colorrange: { hue: 0, range: 30, smooth: 15, sat_min: 0.15 },
};

const TOOLS: { tool: Tool; label: string; hint: string }[] = [
  { tool: "linear", label: "▤ Linéaire", hint: "Glisser sur l'image pour tracer le dégradé" },
  { tool: "radial", label: "◎ Radial", hint: "Glisser depuis le centre de l'ellipse" },
  { tool: "brush", label: "✎ Pinceau", hint: "Peindre directement sur l'image" },
];

export function LocalPanel() {
  const edits = useStore((s) => s.edits);
  const updateEdits = useStore((s) => s.updateEdits);
  const activeTool = useStore((s) => s.activeTool);
  const selectedLocalId = useStore((s) => s.selectedLocalId);
  const showMaskOverlay = useStore((s) => s.showMaskOverlay);
  const brushSize = useStore((s) => s.brushSize);
  const brushErase = useStore((s) => s.brushErase);
  const setUI = useStore((s) => s.setUI);
  const aiSubjectAvailable = useStore((s) => s.aiSubjectAvailable);
  const aiPointAvailable = useStore((s) => s.aiPointAvailable);
  const aiMaskBusy = useStore((s) => s.aiMaskBusy);
  const createAutoMask = useStore((s) => s.createAutoMask);
  if (!edits) return null;

  const selected = edits.locals.find((l) => l.id === selectedLocalId) ?? null;

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
    <PanelSection title="Retouches locales" defaultOpen={false}>
      <div className="row-actions">
        {TOOLS.map(({ tool, label, hint }) => (
          <button
            key={tool}
            className={"btn" + (activeTool === tool ? " active" : "")}
            title={hint}
            onClick={() => setUI({ activeTool: activeTool === tool ? "none" : tool })}
          >
            {label}
          </button>
        ))}
      </div>
      {activeTool !== "none" && activeTool !== "crop" && (
        <p className="hint">{TOOLS.find((t) => t.tool === activeTool)?.hint}</p>
      )}
      {(aiSubjectAvailable || aiPointAvailable) && (
        <div className="row-actions ai-actions">
          {aiPointAvailable && (
            <button
              className={"btn ai-mask" + (activeTool === "pointmask" ? " active" : "") + (aiMaskBusy ? " busy" : "")}
              disabled={aiMaskBusy}
              title="Cliquez ensuite sur l'élément à sélectionner dans l'image"
              onClick={() => setUI({ activeTool: activeTool === "pointmask" ? "none" : "pointmask" })}
            >
              {aiMaskBusy ? "Calcul…" : "Sélection manuelle"}
            </button>
          )}
          {aiSubjectAvailable && (
            <button
              className={"btn ai-mask" + (aiMaskBusy ? " busy" : "")}
              disabled={aiMaskBusy}
              title="Détecte automatiquement le sujet principal et crée un masque"
              onClick={() => void createAutoMask("subject")}
            >
              {aiMaskBusy ? "Calcul…" : "Sélection automatique"}
            </button>
          )}
        </div>
      )}
      <div className="row-actions">
        <button className="btn" title="Cible une plage de luminosité (ombres, tons moyens, hautes lumières)"
          onClick={() => addRangeMask("lumrange")}>◐ Plage luminance</button>
        <button className="btn" title="Cible une plage de couleur (par teinte)"
          onClick={() => addRangeMask("colorrange")}>◑ Plage couleur</button>
      </div>
      {activeTool === "pointmask" && (
        <p className="hint">
          {selected?.type === "ai"
            ? "Cliquez d'autres éléments pour les ajouter à ce masque. Échap pour terminer."
            : "Cliquez sur l'élément à sélectionner. Un masque déjà sélectionné reçoit les clics suivants."}
        </p>
      )}
      {activeTool === "brush" && (
        <>
          <div className="slider-row">
            <span className="slider-label">Taille</span>
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
              Gomme
            </button>
          </div>
        </>
      )}

      {edits.locals.length > 0 && (
        <ul className="local-list">
          {edits.locals.map((l, i) => (
            <li
              key={l.id}
              className={l.id === selectedLocalId ? "selected" : ""}
              onClick={() => setUI({
                selectedLocalId: l.id === selectedLocalId ? null : l.id,
                activeTool: l.type === "brush" && l.id !== selectedLocalId ? "brush" : "none",
              })}
            >
              <span>{i + 1}. {TYPE_LABELS[l.type]}</span>
              {l.invert && <span className="tag">inv.</span>}
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
              Inverser
            </button>
            <button
              className={"btn small" + (showMaskOverlay ? " active" : "")}
              title="Afficher le masque (O)"
              onClick={() => setUI({ showMaskOverlay: !showMaskOverlay })}
            >
              Masque (O)
            </button>
            <button className="btn small danger" onClick={removeSelected}>Supprimer</button>
          </div>
          {(selected.type === "radial" || selected.type === "brush") && (
            <EditSlider label="Contour progressif" value={(selected.params.feather ?? 0.5) * 100}
              min={0} max={100} reset={50}
              apply={(e, v) => {
                const loc = e.locals.find((l) => l.id === selected.id);
                if (loc) loc.params.feather = v / 100;
              }} />
          )}
          {selected.type === "ai" && (
            <EditSlider label="Dureté" value={selected.params.hardness ?? 0}
              min={0} max={100} reset={0}
              apply={(e, v) => {
                const loc = e.locals.find((l) => l.id === selected.id);
                if (loc) loc.params.hardness = v;
              }} />
          )}
          {selected.type === "lumrange" && (
            <>
              <ParamSlider id={selected.id} label="Min" pk="lo" value={selected.params.lo ?? 0.25}
                min={0} max={1} step={0.01} reset={0.25} fmt={(v) => v.toFixed(2)} />
              <ParamSlider id={selected.id} label="Max" pk="hi" value={selected.params.hi ?? 0.75}
                min={0} max={1} step={0.01} reset={0.75} fmt={(v) => v.toFixed(2)} />
              <ParamSlider id={selected.id} label="Transition" pk="smooth" value={selected.params.smooth ?? 0.1}
                min={0.01} max={0.5} step={0.01} reset={0.1} fmt={(v) => v.toFixed(2)} />
            </>
          )}
          {selected.type === "colorrange" && (
            <>
              <ParamSlider id={selected.id} label="Teinte" pk="hue" value={selected.params.hue ?? 0}
                min={0} max={360} step={1} reset={0} fmt={(v) => `${Math.round(v)}°`} />
              <ParamSlider id={selected.id} label="Plage" pk="range" value={selected.params.range ?? 30}
                min={0} max={120} step={1} reset={30} fmt={(v) => `${Math.round(v)}°`} />
              <ParamSlider id={selected.id} label="Transition" pk="smooth" value={selected.params.smooth ?? 15}
                min={1} max={60} step={1} reset={15} fmt={(v) => `${Math.round(v)}°`} />
              <ParamSlider id={selected.id} label="Saturation min" pk="sat_min" value={selected.params.sat_min ?? 0.15}
                min={0} max={1} step={0.01} reset={0.15} fmt={(v) => v.toFixed(2)} />
            </>
          )}
          <LocalSlider id={selected.id} label="Exposition" k="exposure" min={-3} max={3} step={0.05}
            fmt={(v) => (v > 0 ? "+" : "") + v.toFixed(2)} value={selected.adjust.exposure} />
          <LocalSlider id={selected.id} label="Contraste" k="contrast" value={selected.adjust.contrast} />
          <LocalSlider id={selected.id} label="Hautes lumières" k="highlights" value={selected.adjust.highlights} />
          <LocalSlider id={selected.id} label="Ombres" k="shadows" value={selected.adjust.shadows} />
          <LocalSlider id={selected.id} label="Température" k="temp" value={selected.adjust.temp} />
          <LocalSlider id={selected.id} label="Teinte" k="tint" value={selected.adjust.tint} />
          <LocalSlider id={selected.id} label="Saturation" k="saturation" value={selected.adjust.saturation} />
          <LocalSlider id={selected.id} label="Clarté" k="clarity" value={selected.adjust.clarity} />
          <LocalSlider id={selected.id} label="Netteté" k="sharpness" value={selected.adjust.sharpness} />
          <div className="row-actions">
            <button className="btn small" onClick={() => updateEdits((e) => {
              const loc = e.locals.find((l) => l.id === selected.id);
              if (loc) loc.adjust = defaultLocalAdjust();
            })}>
              Réinitialiser les réglages
            </button>
          </div>
        </div>
      )}
    </PanelSection>
  );
}

/** Slider agissant sur un paramètre de masque (loc.params[pk]) — masques par plage. */
function ParamSlider({ id, label, pk, value, min, max, step, reset, fmt }: {
  id: string; label: string; pk: string;
  value: number; min: number; max: number; step: number; reset: number; fmt: (v: number) => string;
}) {
  return (
    <EditSlider
      label={label} value={value} min={min} max={max} step={step} reset={reset} fmt={fmt}
      apply={(e, v) => {
        const loc = e.locals.find((l) => l.id === id);
        if (loc) loc.params[pk] = v;
      }}
    />
  );
}

function LocalSlider({ id, label, k, value, min = -100, max = 100, step = 1, fmt }: {
  id: string; label: string; k: keyof LocalAdjustValues;
  value: number; min?: number; max?: number; step?: number; fmt?: (v: number) => string;
}) {
  return (
    <EditSlider
      label={label} value={value} min={min} max={max} step={step} fmt={fmt}
      apply={(e, v) => {
        const loc = e.locals.find((l) => l.id === id);
        if (loc) loc.adjust[k] = v;
      }}
    />
  );
}
