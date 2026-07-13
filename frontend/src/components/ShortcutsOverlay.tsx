import { useId } from "react";
import { useTranslation } from "react-i18next";
import { ACTION_DEFS, CATEGORIES, formatKey, getBinding, useKeybindings } from "../keybindings";
import { useStore } from "../store";
import { Modal } from "./Modal";
import { IconClose, IconSettings } from "../icons";

export function ShortcutsOverlay() {
  const { t } = useTranslation();
  useKeybindings(); // reflète les raccourcis personnalisés
  const setUI = useStore((s) => s.setUI);
  const setView = useStore((s) => s.setView);
  const titleId = useId();
  return (
    <Modal className="shortcuts-modal" labelledBy={titleId} onClose={() => setUI({ showHelp: false })}>
      <header>
        <h2 id={titleId}>{t("shortcuts.title")}</h2>
        <button className="mini-btn" onClick={() => setUI({ showHelp: false })} aria-label={t("common.close")}><IconClose size={12} /></button>
      </header>
        <div className="shortcuts-body">
          {CATEGORIES.map((cat) => (
            <div key={cat} className="shortcuts-cat">
              <h3>{t(cat)}</h3>
              <div className="shortcuts-grid">
                {ACTION_DEFS.filter((a) => a.category === cat).map((a) => (
                  <div key={a.id} className="shortcut-row">
                    <kbd>{formatKey(getBinding(a.id))}</kbd>
                    <span>{t(a.label)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="shortcuts-cat">
            <h3>{t("shortcuts.other")}</h3>
            <div className="shortcuts-grid">
              <div className="shortcut-row"><kbd>{t("kb.key.escape")}</kbd><span>{t("shortcuts.escapeDesc")}</span></div>
              <div className="shortcut-row"><kbd>{t("shortcuts.multiSelectKeys")}</kbd><span>{t("shortcuts.multiSelect")}</span></div>
            </div>
          </div>
        </div>
        <footer className="shortcuts-foot">
          <button className="btn" onClick={() => { setUI({ showHelp: false }); setView("settings"); }}>
            <IconSettings size={14} /> {t("shortcuts.customize")}
          </button>
        </footer>
    </Modal>
  );
}
