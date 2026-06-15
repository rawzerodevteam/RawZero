import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { chooseExportDir, ensureWritable, fsAccessSupported, loadExportDir, writeFile } from "../lib/exportDir";

type Scope = "selection" | "current" | "all";

/** Repli (navigateurs sans File System Access) : télécharge un fichier via une ancre invisible. */
function triggerDownload(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function ExportDialog() {
  const photos = useStore((s) => s.photos);
  const currentId = useStore((s) => s.currentId);
  const exportIds = useStore((s) => s.exportIds);
  const selection = useStore((s) => s.selection);
  const setExportIds = useStore((s) => s.setExportIds);
  const saveNow = useStore((s) => s.saveNow);
  const setUI = useStore((s) => s.setUI);
  const notify = useStore((s) => s.notify);

  // La sélection vient du menu contextuel (exportIds) ou, à défaut, de la sélection multiple de la grille.
  const selectionIds = exportIds && exportIds.length ? exportIds : selection;
  const hasSelection = selectionIds.length > 0;

  const [scope, setScope] = useState<Scope>(hasSelection ? "selection" : "current");
  const [format, setFormat] = useState("jpeg");
  const [quality, setQuality] = useState(90);
  const [maxSize, setMaxSize] = useState(0); // 0 = pleine résolution
  const [suffix, setSuffix] = useState("");
  const [dir, setDir] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [errors, setErrors] = useState<{ id: number; error: string }[]>([]);
  const [doneCount, setDoneCount] = useState(0);

  // Restaure le dossier d'export mémorisé (choisi lors d'une session précédente).
  useEffect(() => { void loadExportDir().then((d) => { if (d) setDir(d); }); }, []);

  const dirName = dir?.name ?? "";

  const ids = scope === "selection"
    ? selectionIds
    : scope === "current"
      ? (currentId !== null ? [currentId] : [])
      : photos.filter((p) => p.flag !== "reject").map((p) => p.id);

  const pickFolder = async () => {
    try {
      const d = await chooseExportDir();
      if (d) setDir(d);
    } catch { /* l'utilisateur a annulé le sélecteur */ }
  };

  const run = async () => {
    if (!ids.length) return;
    let target = dir;
    if (fsAccessSupported) {
      if (!target) {                       // pas encore de dossier : on le demande maintenant
        try { target = await chooseExportDir(); } catch { return; }
        if (!target) return;
        setDir(target);
      }
      if (!(await ensureWritable(target))) { notify("Accès au dossier refusé"); return; }
    }
    setBusy(true);
    setErrors([]);
    setDoneCount(0);
    setProgress({ done: 0, total: ids.length });
    await saveNow(); // les derniers réglages doivent être en base avant l'export
    const errs: { id: number; error: string }[] = [];
    const used = new Set<string>();
    let ok = 0, done = 0;
    // Export parallèle côté serveur (multi-cœurs) : on reçoit chaque photo terminée au fil
    // de l'eau et on l'enregistre aussitôt dans le dossier choisi.
    try {
      await api.exportStream({ ids, format, quality, max_size: maxSize, suffix }, async (ev) => {
        if (ev.type === "file") {
          if (fsAccessSupported && target) {
            const blob = await (await fetch(ev.url)).blob();
            await writeFile(target, ev.name, blob, used);
          } else {
            triggerDownload(ev.url, ev.name);
          }
          ok++; done++; setProgress({ done, total: ids.length });
        } else if (ev.type === "error") {
          errs.push({ id: ev.id, error: ev.error });
          done++; setProgress({ done, total: ids.length });
        }
      });
    } catch (e) {
      errs.push({ id: -1, error: String(e) });
    }
    setErrors(errs);
    setDoneCount(ok);
    setBusy(false);
    if (ok > 0 && !errs.length) {
      notify(`${ok} photo${ok > 1 ? "s" : ""} exportée${ok > 1 ? "s" : ""}` + (dirName ? ` → ${dirName}` : ""));
      close();
    }
  };

  const close = () => { setExportIds(null); setUI({ showExport: false }); };

  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : close}>
      <div className="modal export-modal" onClick={(ev) => ev.stopPropagation()}>
        <header>
          <h2>Exporter</h2>
          <button className="mini-btn" onClick={close} disabled={busy}>✕</button>
        </header>

        <div className="form-row">
          <label>Photos</label>
          <select value={scope} onChange={(ev) => setScope(ev.target.value as Scope)} disabled={busy}>
            {hasSelection && <option value="selection">Sélection — {selectionIds.length}</option>}
            <option value="current">Photo courante</option>
            <option value="all">Toutes les photos affichées (sauf rejetées) — {photos.filter((p) => p.flag !== "reject").length}</option>
          </select>
        </div>

        {fsAccessSupported && (
          <div className="form-row">
            <label>Destination</label>
            <button className="btn" onClick={() => void pickFolder()} disabled={busy}>📁 {dirName ? "Changer…" : "Choisir…"}</button>
            <span className="dim folder-name">{dirName || "Demandé à l'export"}</span>
          </div>
        )}

        <div className="form-row">
          <label>Format</label>
          <select value={format} onChange={(ev) => setFormat(ev.target.value)} disabled={busy}>
            <option value="jpeg">JPEG</option>
            <option value="png">PNG</option>
            <option value="tiff">TIFF</option>
          </select>
        </div>
        {format === "jpeg" && (
          <div className="form-row">
            <label>Qualité</label>
            <input type="range" min={50} max={100} value={quality} disabled={busy}
              onChange={(ev) => setQuality(Number(ev.target.value))} />
            <span className="slider-value">{quality}</span>
          </div>
        )}
        <div className="form-row">
          <label>Taille max.</label>
          <select value={maxSize} onChange={(ev) => setMaxSize(Number(ev.target.value))} disabled={busy}>
            <option value={0}>Pleine résolution</option>
            <option value={4096}>4096 px</option>
            <option value={2560}>2560 px</option>
            <option value={2048}>2048 px</option>
            <option value={1280}>1280 px</option>
          </select>
        </div>
        <div className="form-row">
          <label>Suffixe</label>
          <input type="text" value={suffix} placeholder="-web (optionnel)" disabled={busy}
            onChange={(ev) => setSuffix(ev.target.value)} />
        </div>

        {busy && (
          <div className="export-progress">
            <div className="progress-track"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
            <span className="dim">{progress.done} / {progress.total} — {pct}%</span>
          </div>
        )}

        <div className="row-actions modal-actions">
          <button className="btn primary" disabled={busy || !ids.length} onClick={() => void run()}>
            {busy ? "Export en cours…" : `Exporter ${ids.length} photo${ids.length > 1 ? "s" : ""}`}
          </button>
          {!busy && <button className="btn" onClick={close}>Fermer</button>}
        </div>

        {!busy && doneCount > 0 && (
          <p className="export-done">✓ {doneCount} fichier{doneCount > 1 ? "s" : ""} exporté{doneCount > 1 ? "s" : ""}{dirName ? ` dans « ${dirName} »` : ""}.</p>
        )}
        {errors.length > 0 && (
          <p className="error">
            {errors.map((e) => (e.id >= 0 ? `#${e.id} : ` : "") + e.error).join(" · ")}
          </p>
        )}
      </div>
    </div>
  );
}
