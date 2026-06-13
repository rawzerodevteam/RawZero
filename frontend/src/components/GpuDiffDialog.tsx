import { useEffect, useState } from "react";
import { useStore } from "../store";
import { measureDivergence, type DiffStats } from "../gpu/diff";

/** Outil de diagnostic : compare numériquement l'aperçu GPU au rendu Python (référence)
 *  sur la photo et les réglages courants. Sert à décider si l'export peut rester côté Python. */
export function GpuDiffDialog({ onClose }: { onClose: () => void }) {
  const photo = useStore((s) => s.photos.find((p) => p.id === s.currentId));
  const edits = useStore((s) => s.edits);
  const [stats, setStats] = useState<DiffStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = () => {
    if (!photo || !edits) { setError("Aucune photo sélectionnée."); return; }
    setBusy(true); setError(null); setStats(null);
    measureDivergence(photo, edits)
      .then((s) => setStats(s))
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  useEffect(run, []); // lance la mesure à l'ouverture

  const verdict = stats && (stats.mean < 2 && stats.pctOver10 < 1
    ? { txt: "Écart négligeable — l'aperçu GPU est fidèle au pipeline Python.", cls: "ok" }
    : stats.mean < 5
      ? { txt: "Écart modéré — visible sur certains réglages, acceptable.", cls: "warn" }
      : { txt: "Écart notable — un export GPU vaudrait le coup.", cls: "bad" });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(ev) => ev.stopPropagation()} style={{ minWidth: 380 }}>
        <header>
          <h2>Écart aperçu GPU ↔ rendu Python</h2>
          <button className="mini-btn" onClick={onClose}>✕</button>
        </header>

        {busy && <p className="dim">Mesure en cours…</p>}
        {error && <p className="error-text">{error}</p>}

        {stats && (
          <>
            <p className="dim">Comparaison sur {stats.w}×{stats.h} px, photo + réglages courants (écart en niveaux 0–255).</p>
            <table className="diff-table">
              <tbody>
                <tr><td>Écart moyen R / V / B</td><td>{stats.meanR.toFixed(2)} / {stats.meanG.toFixed(2)} / {stats.meanB.toFixed(2)}</td></tr>
                <tr><td>Écart moyen global</td><td>{stats.mean.toFixed(2)}</td></tr>
                <tr><td>Écart max</td><td>{stats.max}</td></tr>
                <tr><td>Pixels &gt; 5</td><td>{stats.pctOver5.toFixed(2)} %</td></tr>
                <tr><td>Pixels &gt; 10</td><td>{stats.pctOver10.toFixed(2)} %</td></tr>
              </tbody>
            </table>
            {verdict && <p className={"diff-verdict " + verdict.cls}>{verdict.txt}</p>}
          </>
        )}

        <div className="row-actions" style={{ marginTop: 12 }}>
          <button className="btn" onClick={run} disabled={busy}>Relancer</button>
          <button className="btn" onClick={onClose}>Fermer</button>
        </div>
      </div>
    </div>
  );
}
