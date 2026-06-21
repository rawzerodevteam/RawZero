import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "../store";
import { measureDivergence, type DiffStats } from "../gpu/diff";

/** Outil de diagnostic : compare numériquement l'aperçu GPU au rendu Python (référence)
 *  sur la photo et les réglages courants. Sert à décider si l'export peut rester côté Python. */
export function GpuDiffDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const photo = useStore((s) => s.photos.find((p) => p.id === s.currentId));
  const edits = useStore((s) => s.edits);
  const [stats, setStats] = useState<DiffStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = () => {
    if (!photo || !edits) { setError(t("develop.noPhoto")); return; }
    setBusy(true); setError(null); setStats(null);
    measureDivergence(photo, edits)
      .then((s) => setStats(s))
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  useEffect(run, []); // lance la mesure à l'ouverture

  const verdict = stats && (stats.mean < 2 && stats.pctOver10 < 1
    ? { txt: t("gpuDiff.verdictOk"), cls: "ok" }
    : stats.mean < 5
      ? { txt: t("gpuDiff.verdictWarn"), cls: "warn" }
      : { txt: t("gpuDiff.verdictBad"), cls: "bad" });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(ev) => ev.stopPropagation()} style={{ minWidth: 380 }}>
        <header>
          <h2>{t("gpuDiff.title")}</h2>
          <button className="mini-btn" onClick={onClose}>✕</button>
        </header>

        {busy && <p className="dim">{t("gpuDiff.measuring")}</p>}
        {error && <p className="error-text">{error}</p>}

        {stats && (
          <>
            <p className="dim">{t("gpuDiff.comparison", { w: stats.w, h: stats.h })}</p>
            <table className="diff-table">
              <tbody>
                <tr><td>{t("gpuDiff.meanRGB")}</td><td>{stats.meanR.toFixed(2)} / {stats.meanG.toFixed(2)} / {stats.meanB.toFixed(2)}</td></tr>
                <tr><td>{t("gpuDiff.meanGlobal")}</td><td>{stats.mean.toFixed(2)}</td></tr>
                <tr><td>{t("gpuDiff.max")}</td><td>{stats.max}</td></tr>
                <tr><td>{t("gpuDiff.pixelsOver", { n: 5 })}</td><td>{stats.pctOver5.toFixed(2)} %</td></tr>
                <tr><td>{t("gpuDiff.pixelsOver", { n: 10 })}</td><td>{stats.pctOver10.toFixed(2)} %</td></tr>
              </tbody>
            </table>
            {verdict && <p className={"diff-verdict " + verdict.cls}>{verdict.txt}</p>}
          </>
        )}

        <div className="row-actions" style={{ marginTop: 12 }}>
          <button className="btn" onClick={run} disabled={busy}>{t("gpuDiff.rerun")}</button>
          <button className="btn" onClick={onClose}>{t("common.close")}</button>
        </div>
      </div>
    </div>
  );
}
