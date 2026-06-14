import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { ImportResult } from "../types";

type Tab = "upload" | "folder";

const STATUS_LABELS: Record<ImportResult["status"], string> = {
  imported: "importée", duplicate: "doublon ignoré", ignored: "format non géré",
  error: "erreur", pending: "en attente", uploading: "envoi…",
};

export function ImportPanel() {
  const setUI = useStore((s) => s.setUI);
  const loadPhotos = useStore((s) => s.loadPhotos);
  const loadProjects = useStore((s) => s.loadProjects);
  const project = useStore((s) => s.projects.find((p) => p.id === s.currentProjectId));
  const [tab, setTab] = useState<Tab>("upload");
  const [results, setResults] = useState<ImportResult[]>([]);
  const [busy, setBusy] = useState(false);
  const close = () => setUI({ showImport: false });
  const afterImport = async () => { await loadPhotos(); await loadProjects(); };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : close}>
      <div className="modal import-modal" onClick={(ev) => ev.stopPropagation()}>
        <header>
          <h2>Importer dans « {project?.name ?? "Projet"} »</h2>
          <button className="mini-btn" onClick={close} disabled={busy}>✕</button>
        </header>
        <div className="hsl-tabs">
          <button className={"tab" + (tab === "upload" ? " active" : "")} onClick={() => setTab("upload")}>
            Depuis cet ordinateur
          </button>
          <button className={"tab" + (tab === "folder" ? " active" : "")} onClick={() => setTab("folder")}>
            Dossier /import
          </button>
        </div>
        {tab === "upload"
          ? <UploadTab busy={busy} setBusy={setBusy} setResults={setResults} onDone={afterImport} />
          : <FolderTab busy={busy} setBusy={setBusy} setResults={setResults} onDone={afterImport} />}
        {results.length > 0 && (
          <ul className="import-results">
            {results.map((r, i) => (
              <li key={i} className={"st-" + r.status}>
                <span className="name">{r.filename}</span>
                <span className="status">{STATUS_LABELS[r.status]}{r.reason ? ` (${r.reason})` : ""}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface TabProps {
  busy: boolean;
  setBusy: (b: boolean) => void;
  setResults: React.Dispatch<React.SetStateAction<ImportResult[]>>;
  onDone: () => Promise<void>;
}

function UploadTab({ busy, setBusy, setResults, onDone }: TabProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const projectId = useStore((s) => s.currentProjectId);

  const importFiles = async (files: File[]) => {
    if (!files.length || busy) return;
    setBusy(true);
    setResults(files.map((f) => ({ filename: f.name, status: "pending" })));
    for (let i = 0; i < files.length; i++) {
      setResults((rs) => rs.map((r, j) => (j === i ? { ...r, status: "uploading" } : r)));
      let res: ImportResult;
      try {
        res = await api.uploadFile(files[i], projectId);
      } catch (e) {
        res = { filename: files[i].name, status: "error", reason: String(e) };
      }
      setResults((rs) => rs.map((r, j) => (j === i ? { ...res, filename: files[i].name } : r)));
    }
    await onDone();
    setBusy(false);
  };

  return (
    <div
      className={"dropzone" + (dragOver ? " over" : "")}
      onDragOver={(ev) => { ev.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(ev) => {
        ev.preventDefault();
        setDragOver(false);
        void importFiles(Array.from(ev.dataTransfer.files));
      }}
      onClick={() => !busy && inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".cr2,.cr3,.nef,.arw,.raf,.orf,.rw2,.dng,.pef,.srw,.jpg,.jpeg,.png,.tif,.tiff"
        style={{ display: "none" }}
        onChange={(ev) => {
          void importFiles(Array.from(ev.target.files ?? []));
          ev.target.value = "";
        }}
      />
      <p>{busy ? "Import en cours…" : "Déposer des fichiers ici ou cliquer pour choisir"}</p>
      <p className="hint">RAW (CR2/CR3, NEF, ARW, RAF, ORF, RW2, DNG…) ou JPEG / PNG / TIFF</p>
    </div>
  );
}

function FolderTab({ busy, setBusy, setResults, onDone }: TabProps) {
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<Awaited<ReturnType<typeof api.browseImport>> | null>(null);
  const [error, setError] = useState("");
  const projectId = useStore((s) => s.currentProjectId);

  const browse = (p: string) => {
    api.browseImport(p)
      .then((l) => { setListing(l); setPath(l.path); setError(""); })
      .catch((e) => setError(String(e)));
  };
  useEffect(() => { browse(""); }, []);

  const importPaths = async (paths: string[]) => {
    if (!paths.length || busy) return;
    setBusy(true);
    setResults(paths.map((p) => ({ filename: p.split("/").pop() ?? p, status: "pending" })));
    try {
      const res = await api.importFolder(paths, projectId);
      setResults(res);
      await onDone();
    } catch (e) {
      setResults([{ filename: "import", status: "error", reason: String(e) }]);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p className="error">{error}</p>;
  if (!listing) return <p className="hint">Chargement…</p>;
  if (!listing.available) {
    return (
      <p className="hint">
        Aucun dossier d'import monté. Déposez vos fichiers dans <code>./import</code> à côté du
        docker-compose.yml (monté en lecture seule dans le conteneur), puis rouvrez cet onglet.
      </p>
    );
  }

  return (
    <div className="folder-browser">
      <div className="row-actions">
        <button className="btn small" disabled={!path} onClick={() => browse(path.split("/").slice(0, -1).join("/"))}>
          ↑ Dossier parent
        </button>
        <span className="dim">/{path}</span>
        <button
          className="btn primary small"
          disabled={busy || !listing.files.length}
          onClick={() => void importPaths(listing.files.map((f) => f.path))}
        >
          Tout importer ({listing.files.length})
        </button>
      </div>
      <ul className="browser-list">
        {listing.dirs.map((d) => (
          <li key={d.path} className="dir" onClick={() => browse(d.path)}>📁 {d.name}</li>
        ))}
        {listing.files.map((f) => (
          <li key={f.path} className="file" onClick={() => void importPaths([f.path])} title="Cliquer pour importer">
            🖼 {f.name} <span className="dim">{(f.size / 1024 / 1024).toFixed(1)} Mo</span>
          </li>
        ))}
        {!listing.dirs.length && !listing.files.length && <li className="dim">Dossier vide</li>}
      </ul>
    </div>
  );
}
