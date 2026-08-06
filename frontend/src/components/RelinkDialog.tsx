import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { nativeDialogAvailable, pickFile } from "../lib/nativeDialog";
import { useStore } from "../store";
import { Modal } from "./Modal";
import { IconArrowUp, IconClose, IconFolder, IconImage } from "../icons";

/** Reliage d'une photo dont l'original a été déplacé/supprimé : même navigateur de fichiers
 * que l'import, mais sélection d'un unique fichier de remplacement. */
export function RelinkDialog() {
  const { t } = useTranslation();
  const targetId = useStore((s) => s.relinkTargetId);
  const photo = useStore((s) => s.photos.find((p) => p.id === s.relinkTargetId));
  const closeRelink = useStore((s) => s.closeRelink);
  const relinkPhoto = useStore((s) => s.relinkPhoto);
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<Awaited<ReturnType<typeof api.browseImport>> | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const browse = (p: string) => {
    api.browseImport(p)
      .then((l) => { setListing(l); setPath(l.path); setError(""); })
      .catch((e) => setError(String(e)));
  };
  useEffect(() => { if (targetId !== null && !nativeDialogAvailable) browse(""); }, [targetId]);
  const titleId = useId();

  if (targetId === null) return null;
  const close = () => !busy && closeRelink();

  const pick = async (filePath: string) => {
    setBusy(true);
    try {
      await relinkPhoto(filePath);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const pickNative = async () => {
    try {
      const filePath = await pickFile();
      if (filePath) await pick(filePath);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Modal className="import-modal" labelledBy={titleId} onClose={close} closeOnBackdrop={!busy}>
      <header>
        <h2 id={titleId}>{t("relink.title", { name: photo?.filename ?? "" })}</h2>
        <button className="mini-btn" onClick={close} disabled={busy} aria-label={t("common.close")}><IconClose size={12} /></button>
      </header>
        <p className="hint">{t("relink.hint")}</p>
        {nativeDialogAvailable ? (
          <div className="row-actions">
            <button className="btn primary" disabled={busy} onClick={() => void pickNative()}>
              <IconImage size={14} /> {t("relink.action")}
            </button>
            {error && <p className="error">{error}</p>}
          </div>
        ) : error ? <p className="error">{error}</p>
          : !listing ? <p className="hint">{t("common.loading")}</p>
          : !listing.available ? <p className="hint">{t("import.noFolder")}</p>
          : (
            <div className="folder-browser">
              <div className="row-actions">
                <button className="btn small" disabled={busy || !path || !listing.parent}
                        onClick={() => browse(listing.parent ?? "")}>
                  <IconArrowUp size={13} /> {t("import.parentDir")}
                </button>
                <span className="dim">{path || t("import.parentDir")}</span>
              </div>
              <ul className="browser-list">
                {listing.dirs.map((d) => (
                  <li key={d.path} className="dir" onClick={() => !busy && browse(d.path)}><IconFolder size={13} /> {d.name}</li>
                ))}
                {listing.files.map((f) => (
                  <li key={f.path} className="file" onClick={() => !busy && void pick(f.path)}
                      title={t("relink.action")}>
                    <IconImage size={13} /> {f.name} <span className="dim">{t("common.sizeMb", { mb: (f.size / 1024 / 1024).toFixed(1) })}</span>
                  </li>
                ))}
                {!listing.dirs.length && !listing.files.length && <li className="dim">{t("import.emptyFolder")}</li>}
              </ul>
            </div>
          )}
    </Modal>
  );
}
