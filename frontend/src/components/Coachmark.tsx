import { useStore } from "../store";

/** Bandeau discret non-bloquant, affiché une seule fois par indice (cf. audit UX §7.2/§4.2) :
 *  contrairement à `Modal`, ne capture pas le focus ni ne bloque l'interaction avec le reste
 *  de l'UI — juste un indice refermable, mémorisé pour ne plus reparaître ensuite. */
export function Coachmark({ hintKey, message }: { hintKey: string; message: string }) {
  const seen = useStore((s) => s.seenHints[hintKey]);
  const markHintSeen = useStore((s) => s.markHintSeen);
  if (seen) return null;
  return (
    <div className="coachmark" role="status">
      <span>{message}</span>
      <button className="mini-btn" title="OK" aria-label="OK" onClick={() => markHintSeen(hintKey)}>✕</button>
    </div>
  );
}
