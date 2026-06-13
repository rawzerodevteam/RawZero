import { useState } from "react";
import { api } from "../api";
import { useStore } from "../store";

type Scope = "current" | "all";

interface Result {
  files: { id: number; name: string; url: string; width: number; height: number }[];
  errors: { id: number; error: string }[];
}

export function ExportDialog() {
  const photos = useStore((s) => s.photos);
  const currentId = useStore((s) => s.currentId);
  const saveNow = useStore((s) => s.saveNow);
  const setUI = useStore((s) => s.setUI);

  const [scope, setScope] = useState<Scope>("current");
  const [format, setFormat] = useState("jpeg");
  const [quality, setQuality] = useState(90);
  const [maxSize, setMaxSize] = useState(0); // 0 = pleine résolution
  const [suffix, setSuffix] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const ids = scope === "current"
    ? (currentId !== null ? [currentId] : [])
    : photos.filter((p) => p.flag !== "reject").map((p) => p.id);

  const run = async () => {
    if (!ids.length) return;
    setBusy(true);
    setResult(null);
    try {
      await saveNow(); // les derniers réglages doivent être en base avant l'export
      const out = await api.exportPhotos({ ids, format, quality, max_size: maxSize, suffix });
      setResult({ files: out.files, errors: out.errors });
    } catch (e) {
      setResult({ files: [], errors: [{ id: -1, error: String(e) }] });
    } finally {
      setBusy(false);
    }
  };

  const close = () => setUI({ showExport: false });

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal export-modal" onClick={(ev) => ev.stopPropagation()}>
        <header>
          <h2>Exporter</h2>
          <button className="mini-btn" onClick={close}>✕</button>
        </header>

        <div className="form-row">
          <label>Photos</label>
          <select value={scope} onChange={(ev) => setScope(ev.target.value as Scope)}>
            <option value="current">Photo courante</option>
            <option value="all">Toutes les photos affichées (sauf rejetées) — {photos.filter((p) => p.flag !== "reject").length}</option>
          </select>
        </div>
        <div className="form-row">
          <label>Format</label>
          <select value={format} onChange={(ev) => setFormat(ev.target.value)}>
            <option value="jpeg">JPEG</option>
            <option value="png">PNG</option>
            <option value="tiff">TIFF</option>
          </select>
        </div>
        {format === "jpeg" && (
          <div className="form-row">
            <label>Qualité</label>
            <input type="range" min={50} max={100} value={quality}
              onChange={(ev) => setQuality(Number(ev.target.value))} />
            <span className="slider-value">{quality}</span>
          </div>
        )}
        <div className="form-row">
          <label>Taille max.</label>
          <select value={maxSize} onChange={(ev) => setMaxSize(Number(ev.target.value))}>
            <option value={0}>Pleine résolution</option>
            <option value={4096}>4096 px</option>
            <option value={2560}>2560 px</option>
            <option value={2048}>2048 px</option>
            <option value={1280}>1280 px</option>
          </select>
        </div>
        <div className="form-row">
          <label>Suffixe</label>
          <input type="text" value={suffix} placeholder="-web (optionnel)"
            onChange={(ev) => setSuffix(ev.target.value)} />
        </div>

        <div className="row-actions modal-actions">
          <button className="btn primary" disabled={busy || !ids.length} onClick={() => void run()}>
            {busy ? "Export en cours…" : `Exporter ${ids.length} photo${ids.length > 1 ? "s" : ""}`}
          </button>
          <button className="btn" onClick={close}>Fermer</button>
        </div>

        {result && (
          <div className="export-result">
            {result.files.length > 0 && (
              <>
                <h4>{result.files.length} fichier{result.files.length > 1 ? "s" : ""} exporté{result.files.length > 1 ? "s" : ""} (dossier data/exports)</h4>
                <ul>
                  {result.files.map((f) => (
                    <li key={f.url}>
                      <a href={f.url} download target="_blank" rel="noreferrer">{f.name}</a>
                      <span className="dim"> — {f.width} × {f.height}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {result.errors.length > 0 && (
              <p className="error">
                {result.errors.map((e) => (e.id >= 0 ? `#${e.id} : ` : "") + e.error).join(" · ")}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
