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
 *  Double-clic sur le libellé = retour à la valeur par défaut. */
export function EditSlider({ label, value, min, max, step = 1, reset = 0, fmt, apply }: Props) {
  const updateEdits = useStore((s) => s.updateEdits);
  const startDrag = useStore((s) => s.startDrag);
  const endDrag = useStore((s) => s.endDrag);

  const doReset = () => {
    startDrag();
    updateEdits((e) => apply(e, reset), false);
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
        onChange={(ev) => updateEdits((e) => apply(e, Number(ev.target.value)), false)}
        onPointerUp={endDrag}
        onKeyUp={endDrag}
        onBlur={endDrag}
      />
      <span className="slider-value" onDoubleClick={doReset}>
        {fmt ? fmt(value) : (Math.round(value * 100) / 100).toString()}
      </span>
    </div>
  );
}
