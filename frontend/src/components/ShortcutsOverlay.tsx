import { useTranslation } from "react-i18next";
import { ACTION_DEFS, CATEGORIES, formatKey, getBinding, useKeybindings } from "../keybindings";
import { useStore } from "../store";

export function ShortcutsOverlay() {
  const { t } = useTranslation();
  useKeybindings(); // reflète les raccourcis personnalisés
  const setUI = useStore((s) => s.setUI);
  const setView = useStore((s) => s.setView);
  return (
    <div className="modal-backdrop" onClick={() => setUI({ showHelp: false })}>
      <div className="modal shortcuts-modal" onClick={(ev) => ev.stopPropagation()}>
        <header>
          <h2>{t("shortcuts.title")}</h2>
          <button className="mini-btn" onClick={() => setUI({ showHelp: false })}>✕</button>
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
            ⚙ {t("shortcuts.customize")}
          </button>
        </footer>
      </div>
    </div>
  );
}
