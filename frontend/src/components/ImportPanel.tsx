import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { useStore } from "../store";
import type { ImportResult } from "../types";

type Tab = "upload" | "folder";

export function ImportPanel() {
  const { t } = useTranslation();
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
          <h2>{t("import.title", { name: project?.name ?? t("import.defaultProject") })}</h2>
          <button className="mini-btn" onClick={close} disabled={busy}>✕</button>
        </header>
        <div className="hsl-tabs">
          <button className={"tab" + (tab === "upload" ? " active" : "")} onClick={() => setTab("upload")}>
            {t("import.fromComputer")}
          </button>
          <button className={"tab" + (tab === "folder" ? " active" : "")} onClick={() => setTab("folder")}>
            {t("import.folderTab")}
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
                <span className="status">{t(`import.status.${r.status}`)}{r.reason ? ` (${r.reason})` : ""}</span>
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
  const { t } = useTranslation();
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
      <p>{busy ? t("import.uploading") : t("import.dropzone")}</p>
      <p className="hint">{t("import.formats")}</p>
    </div>
  );
}

function FolderTab({ busy, setBusy, setResults, onDone }: TabProps) {
  const { t } = useTranslation();
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
  if (!listing) return <p className="hint">{t("common.loading")}</p>;
  if (!listing.available) {
    return <p className="hint">{t("import.noFolder")}</p>;
  }

  return (
    <div className="folder-browser">
      <div className="row-actions">
        <button className="btn small" disabled={!path} onClick={() => browse(path.split("/").slice(0, -1).join("/"))}>
          ↑ {t("import.parentDir")}
        </button>
        <span className="dim">/{path}</span>
        <button
          className="btn primary small"
          disabled={busy || !listing.files.length}
          onClick={() => void importPaths(listing.files.map((f) => f.path))}
        >
          {t("import.importAll", { count: listing.files.length })}
        </button>
      </div>
      <ul className="browser-list">
        {listing.dirs.map((d) => (
          <li key={d.path} className="dir" onClick={() => browse(d.path)}>📁 {d.name}</li>
        ))}
        {listing.files.map((f) => (
          <li key={f.path} className="file" onClick={() => void importPaths([f.path])} title={t("import.clickToImport")}>
            🖼 {f.name} <span className="dim">{t("common.sizeMb", { mb: (f.size / 1024 / 1024).toFixed(1) })}</span>
          </li>
        ))}
        {!listing.dirs.length && !listing.files.length && <li className="dim">{t("import.emptyFolder")}</li>}
      </ul>
    </div>
  );
}
