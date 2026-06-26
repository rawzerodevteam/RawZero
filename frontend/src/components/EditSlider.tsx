import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "../store";
import type { EditState } from "../types";

interface Props {
  label: string;
  /** Sélecteur de la valeur dans l'état : abonnement granulaire — ce slider ne se re-rend que
   *  quand SA valeur change (pas quand un autre réglage bouge). */
  get: (e: EditState) => number;
  min: number;
  max: number;
  step?: number;
  reset?: number;
  fmt?: (v: number) => string;
  apply: (e: EditState, v: number) => void;
}

/** Slider lié au store : drag = mises à jour continues, relâchement = point d'historique.
 *  Double-clic sur le libellé = retour à la valeur par défaut.
 *  Clic sur la valeur = saisie numérique directe.
 *
 *  Abonnement granulaire : chaque slider lit son propre scalaire via `get`. Pendant un drag,
 *  seul le slider tiré se re-rend (les panneaux ne s'abonnent plus à l'objet `edits` entier),
 *  ce qui supprime la réconciliation des dizaines d'autres sliders à chaque frame. */
export function EditSlider({ label, get, min, max, step = 1, reset = 0, fmt, apply }: Props) {
  const { t } = useTranslation();
  const value = useStore((s) => (s.edits ? get(s.edits) : 0));
  const updateEdits = useStore((s) => s.updateEdits);
  const updateEditsLive = useStore((s) => s.updateEditsLive);
  const startDrag = useStore((s) => s.startDrag);
  const endDrag = useStore((s) => s.endDrag);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Valeur d'affichage pendant un drag. Sur le chemin GPU découplé, `edits` est muté EN PLACE sans
  // setState → le store ne notifie pas, `value` resterait figé. On tient donc localement la valeur
  // courante (curseur + nombre) le temps du drag, puis on repasse à `value` (committé) au relâchement.
  const [liveValue, setLiveValue] = useState<number | null>(null);
  const shown = liveValue ?? value;

  const endDragHandler = () => { endDrag(); setLiveValue(null); };

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
      <span className="slider-label" onDoubleClick={doReset} title={t("slider.resetHint")}>
        {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        onPointerDown={startDrag}
        onKeyDown={startDrag}
        onChange={(ev) => { const v = Number(ev.target.value); setLiveValue(v); updateEditsLive((e) => apply(e, v)); }}
        onPointerUp={endDragHandler}
        onKeyUp={endDragHandler}
        onBlur={endDragHandler}
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
        <span className="slider-value" onClick={beginEdit} title={t("slider.enterValue")}>
          {fmt ? fmt(shown) : (Math.round(shown * 100) / 100).toString()}
        </span>
      )}
    </div>
  );
}
