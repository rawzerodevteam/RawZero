import { useState } from "react";
import { useStore } from "../store";
import type { EditState } from "../types";

interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  reset?: number;
  fmt?: (v: number) => string;
  apply: (e: EditState, v: number) => void;
}

/** Slider lié au store : drag = mises à jour continues, relâchement = point d'historique.
 *  Double-clic sur le libellé = retour à la valeur par défaut.
 *  Clic sur la valeur = saisie numérique directe. */
export function EditSlider({ label, value, min, max, step = 1, reset = 0, fmt, apply }: Props) {
  const updateEdits = useStore((s) => s.updateEdits);
  const startDrag = useStore((s) => s.startDrag);
  const endDrag = useStore((s) => s.endDrag);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const doReset = () => {
    startDrag();
    updateEdits((e) => apply(e, reset), false);
    endDrag();
  };

  const beginEdit = () => {
    setDraft((Math.round(value * 100) / 100).toString());
    setEditing(true);
  };

  const commitEdit = () => {
    setEditing(false);
    const parsed = Number(draft.replace(",", "."));
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(max, Math.max(min, parsed));
    if (clamped === value) return;
    startDrag();
    updateEdits((e) => apply(e, clamped), false);
    endDrag();
  };

  return (
    <div className="slider-row">
      <span className="slider-label" onDoubleClick={doReset} title="Double-clic : réinitialiser">
        {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={startDrag}
        onKeyDown={startDrag}
        onChange={(ev) => updateEdits((e) => apply(e, Number(ev.target.value)), false)}
        onPointerUp={endDrag}
        onKeyUp={endDrag}
        onBlur={endDrag}
      />
      {editing ? (
        <input
          className="slider-value-input"
          type="text"
          inputMode="decimal"
          autoFocus
          value={draft}
          onChange={(ev) => setDraft(ev.target.value)}
          onBlur={commitEdit}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") (ev.target as HTMLInputElement).blur();
            else if (ev.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <span className="slider-value" onClick={beginEdit} title="Cliquer pour saisir une valeur">
          {fmt ? fmt(value) : (Math.round(value * 100) / 100).toString()}
        </span>
      )}
    </div>
  );
}
