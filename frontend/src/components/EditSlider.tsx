import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "../store";
import type { EditState } from "../types";

// Délai d'inactivité (ms) après le dernier cran de molette avant de figer le point d'historique :
// un geste de molette envoie de nombreux events rapprochés, à coalescer en une seule entrée
// d'historique (comme un drag), pas une par cran.
const WHEEL_IDLE_MS = 250;

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

  // Molette de réglage fin (cf. CLAUDE.md §8) : un cran = un pas, coalescé en un seul point
  // d'historique par geste (comme un drag). Ref-based pour ne pas réabonner le listener non-passif
  // à chaque tick (nécessaire pour que preventDefault empêche le défilement du panneau).
  const inputRef = useRef<HTMLInputElement>(null);
  const stateRef = useRef({ value, min, max, step, apply, liveValue });
  stateRef.current = { value, min, max, step, apply, liveValue };
  const wheelIdleRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const { value: v, min: lo, max: hi, step: st, apply: ap, liveValue: lv } = stateRef.current;
      const base = lv ?? v;
      const dir = ev.deltaY < 0 ? 1 : -1;
      const clamped = Math.min(hi, Math.max(lo, base + dir * st));
      const next = Math.round(clamped * 1e6) / 1e6; // évite la dérive flottante cumulative
      if (wheelIdleRef.current === undefined) startDrag();
      else window.clearTimeout(wheelIdleRef.current);
      setLiveValue(next);
      updateEditsLive((e) => ap(e, next));
      wheelIdleRef.current = window.setTimeout(() => {
        endDrag();
        setLiveValue(null);
        wheelIdleRef.current = undefined;
      }, WHEEL_IDLE_MS);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (wheelIdleRef.current !== undefined) {
        window.clearTimeout(wheelIdleRef.current);
        wheelIdleRef.current = undefined;
        endDrag();
        setLiveValue(null);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        ref={inputRef}
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
