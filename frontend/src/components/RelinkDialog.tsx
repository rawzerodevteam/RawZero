import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { nativeDialogAvailable, pickFile } from "../lib/nativeDialog";
import { useStore } from "../store";

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
    const filePath = await pickFile();
    if (filePath) await pick(filePath);
  };

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal import-modal" onClick={(ev) => ev.stopPropagation()}>
        <header>
          <h2>{t("relink.title", { name: photo?.filename ?? "" })}</h2>
          <button className="mini-btn" onClick={close} disabled={busy}>✕</button>
        </header>
        <p className="hint">{t("relink.hint")}</p>
        {nativeDialogAvailable ? (
          <div className="row-actions">
            <button className="btn primary" disabled={busy} onClick={() => void pickNative()}>
              🖼 {t("relink.action")}
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
                  ↑ {t("import.parentDir")}
                </button>
                <span className="dim">{path || t("import.parentDir")}</span>
              </div>
              <ul className="browser-list">
                {listing.dirs.map((d) => (
                  <li key={d.path} className="dir" onClick={() => !busy && browse(d.path)}>📁 {d.name}</li>
                ))}
                {listing.files.map((f) => (
                  <li key={f.path} className="file" onClick={() => !busy && void pick(f.path)}
                      title={t("relink.action")}>
                    🖼 {f.name} <span className="dim">{t("common.sizeMb", { mb: (f.size / 1024 / 1024).toFixed(1) })}</span>
                  </li>
                ))}
                {!listing.dirs.length && !listing.files.length && <li className="dim">{t("import.emptyFolder")}</li>}
              </ul>
            </div>
          )}
      </div>
    </div>
  );
}
