import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { nativeDialogAvailable, pickFiles, pickFolder } from "../lib/nativeDialog";
import { useStore } from "../store";
import type { ImportResult } from "../types";
import { Modal } from "./Modal";
import { IconClose, IconFolder, IconImage } from "../icons";

export function ImportPanel() {
  const { t } = useTranslation();
  const setUI = useStore((s) => s.setUI);
  const loadPhotos = useStore((s) => s.loadPhotos);
  const loadProjects = useStore((s) => s.loadProjects);
  const project = useStore((s) => s.projects.find((p) => p.id === s.currentProjectId));
  const projectId = useStore((s) => s.currentProjectId);
  const [results, setResults] = useState<ImportResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<Awaited<ReturnType<typeof api.browseImport>> | null>(null);
  const [error, setError] = useState("");
  const close = () => setUI({ showImport: false });
  const titleId = useId();

  const browse = (p: string) => {
    api.browseImport(p)
      .then((l) => { setListing(l); setPath(l.path); setError(""); })
      .catch((e) => setError(String(e)));
  };
  useEffect(() => { if (!nativeDialogAvailable) browse(""); }, []);

  const importPaths = async (paths: string[]) => {
    if (!paths.length || busy) return;
    setBusy(true);
    setResults(paths.map((p) => ({ filename: p.split(/[/\\]/).pop() ?? p, status: "pending" })));
    try {
      const res = await api.importFolder(paths, projectId);
      setResults(res);
      await loadPhotos();
      await loadProjects();
    } catch (e) {
      setResults([{ filename: "import", status: "error", reason: String(e) }]);
    } finally {
      setBusy(false);
    }
  };

  const pickAndImportFiles = async () => {
    try {
      const paths = await pickFiles();
      if (paths) await importPaths(paths);
    } catch (e) {
      setResults([{ filename: "import", status: "error", reason: String(e) }]);
    }
  };

  const pickAndImportFolder = async () => {
    try {
      const folder = await pickFolder();
      if (!folder) return;
      const l = await api.browseImport(folder);
      await importPaths(l.files.map((f) => f.path));
    } catch (e) {
      setResults([{ filename: "import", status: "error", reason: String(e) }]);
    }
  };

  return (
    <Modal className="import-modal" labelledBy={titleId} onClose={close} closeOnBackdrop={!busy}>
      <header>
        <h2 id={titleId}>{t("import.title", { name: project?.name ?? t("import.defaultProject") })}</h2>
        <button className="mini-btn" onClick={close} disabled={busy} aria-label={t("common.close")}><IconClose size={12} /></button>
      </header>
        <p className="hint">{t("import.referenceHint")}</p>
        {nativeDialogAvailable ? (
          <div className="row-actions">
            <button className="btn primary" disabled={busy} onClick={() => void pickAndImportFiles()}>
              <IconImage size={14} /> {t("import.pickFiles")}
            </button>
            <button className="btn" disabled={busy} onClick={() => void pickAndImportFolder()}>
              <IconFolder size={14} /> {t("import.pickFolder")}
            </button>
          </div>
        ) : error ? <p className="error">{error}</p>
          : !listing ? <p className="hint">{t("common.loading")}</p>
          : !listing.available ? <p className="hint">{t("import.noFolder")}</p>
          : (
            <div className="folder-browser">
              <div className="row-actions">
                <button className="btn small" disabled={!path || !listing.parent}
                        onClick={() => browse(listing.parent ?? "")}>
                  ↑ {t("import.parentDir")}
                </button>
                <span className="dim">{path || t("import.parentDir")}</span>
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
                  <li key={d.path} className="dir" onClick={() => browse(d.path)}><IconFolder size={13} /> {d.name}</li>
                ))}
                {listing.files.map((f) => (
                  <li key={f.path} className="file" onClick={() => void importPaths([f.path])} title={t("import.clickToImport")}>
                    <IconImage size={13} /> {f.name} <span className="dim">{t("common.sizeMb", { mb: (f.size / 1024 / 1024).toFixed(1) })}</span>
                  </li>
                ))}
                {!listing.dirs.length && !listing.files.length && <li className="dim">{t("import.emptyFolder")}</li>}
              </ul>
            </div>
          )}
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
    </Modal>
  );
}
