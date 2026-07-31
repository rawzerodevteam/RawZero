import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type ModelStatus } from "../api";
import { useStore } from "../store";
import { Modal } from "./Modal";
import { IconCheck } from "../icons";

const FEATURES = ["subject", "point", "denoise"] as const;

/** Dialog « Modèles IA » : statut par feature + téléchargement à la demande avec progression. */
export function ModelsDialog() {
  const { t } = useTranslation();
  const setUI = useStore((s) => s.setUI);
  const refreshAi = useStore((s) => s.refreshAiAvailability);
  const [status, setStatus] = useState<Record<string, ModelStatus>>({});

  const refresh = useCallback(() => { void api.modelsStatus().then(setStatus).catch(() => {}); }, []);
  useEffect(() => { refresh(); }, [refresh]);  // statut initial à l'ouverture

  // Poll seulement pendant un téléchargement ; à la fin, rafraîchit la dispo IA du store sinon
  // les boutons sujet/clic/débruitage resteraient cachés jusqu'au redémarrage.
  const anyDownloading = Object.values(status).some((s) => s.downloading);
  const wasDownloading = useRef(false);
  useEffect(() => {
    if (anyDownloading) {
      wasDownloading.current = true;
      const id = window.setInterval(refresh, 1000);
      return () => window.clearInterval(id);
    }
    if (wasDownloading.current) { wasDownloading.current = false; void refreshAi(); }
  }, [anyDownloading, refresh, refreshAi]);

  const download = (f: string) => { void api.modelsDownload(f).then(refresh).catch(() => {}); };

  const close = () => setUI({ showModels: false });
  const titleId = useId();

  return (
    <Modal className="models-modal" labelledBy={titleId} onClose={close}>
      <header>
        <h2 id={titleId}>{t("models.title")}</h2>
        <button className="btn" onClick={close}>{t("common.close")}</button>
      </header>
        <p className="models-intro">{t("models.intro")}</p>
        <ul className="models-list">
          {FEATURES.map((f) => {
            const s = status[f];
            const pct = s?.total ? Math.round((s.received / s.total) * 100) : 0;
            return (
              <li key={f} className="model-row">
                <div className="model-info">
                  <span className="model-name">{t(`models.${f}`)}</span>
                  <span className="model-desc">{t(`models.${f}Desc`)}</span>
                  {s?.error && <span className="model-err">{t("models.downloadFailed", { error: s.error })}</span>}
                </div>
                <div className="model-action">
                  {s?.available ? (
                    <span className="model-ok"><IconCheck size={12} /> {t("models.installed")}</span>
                  ) : s?.downloading ? (
                    <span className="model-busy">{t("models.downloading", { percent: pct })}</span>
                  ) : s?.configured ? (
                    <button className="btn" onClick={() => download(f)}>
                      {t("common.download")}
                      {s.size ? ` · ${t("common.sizeMb", { mb: (s.size / 1e6).toFixed(1) })}` : ""}
                    </button>
                  ) : (
                    <span className="model-na">{t("models.notConfigured")}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
    </Modal>
  );
}
