import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import {
  ACTION_DEFS, CATEGORIES, clearBinding, formatKey, getBinding,
  normalizeEvent, resetAllBindings, resetBinding, setBinding, useKeybindings,
} from "../keybindings";
import {
  ACCENT_PRESETS, DEFAULT_ACCENT, THEMES, getAccent, getThemeId, resetAccent, setAccent, setTheme,
} from "../theme";
import { useStore } from "../store";

/** Onglet « Paramètres » : apparence (langue, couleur d'accent) + raccourcis clavier. */
export function SettingsView() {
  const { t } = useTranslation();
  useKeybindings(); // re-rendu quand une touche change
  const setView = useStore((s) => s.setView);
  const [capturing, setCapturing] = useState<string | null>(null);
  const [accent, setAccentState] = useState(getAccent());
  const [themeId, setThemeId] = useState(getThemeId());

  const onCapture = (id: string) => (ev: React.KeyboardEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.key === "Escape") { setCapturing(null); return; }   // annule la capture
    const key = normalizeEvent(ev);
    if (!key) return;                                          // modificateur seul : on attend
    setBinding(id, key);
    setCapturing(null);
  };

  const pickAccent = (hex: string) => { setAccent(hex); setAccentState(hex); };

  return (
    <div className="settings">
      <header className="settings-header">
        <button className="btn" onClick={() => setView("grid")}>← {t("settings.back")}</button>
        <strong className="brand">{t("settings.title")}</strong>
        <span className="spacer" />
        <button className="btn" onClick={() => {
          if (window.confirm(t("settings.confirmResetShortcuts"))) resetAllBindings();
        }}>{t("settings.resetShortcuts")}</button>
      </header>

      <div className="settings-body">
        <section className="settings-section">
          <h2>{t("settings.appearance")}</h2>
          <div className="settings-field">
            <span className="settings-label">{t("settings.language")}</span>
            <LanguageSwitcher />
          </div>
          <div className="settings-field">
            <span className="settings-label">{t("settings.theme")}</span>
            <div className="theme-picker">
              {THEMES.map((th) => (
                <button
                  key={th.id}
                  className={"theme-card" + (themeId === th.id ? " active" : "")}
                  title={th.name}
                  onClick={() => { setTheme(th.id); setThemeId(th.id); }}
                >
                  <span className="theme-preview" style={{ background: th.vars["--bg"] }}>
                    <span className="theme-preview-bar"
                      style={{ background: th.vars["--bg-panel"], borderBottom: `1px solid ${th.vars["--border"]}` }} />
                    <span className="theme-preview-line" style={{ background: th.vars["--text-dim"] }} />
                    <span className="theme-preview-dot" />
                  </span>
                  <span className="theme-name">{th.name}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="settings-field">
            <span className="settings-label">{t("settings.accent")}</span>
            <div className="accent-picker">
              {ACCENT_PRESETS.map((c) => (
                <button
                  key={c}
                  className={"accent-swatch" + (accent.toLowerCase() === c.toLowerCase() ? " active" : "")}
                  style={{ background: c }}
                  title={c}
                  onClick={() => pickAccent(c)}
                />
              ))}
              <input type="color" value={accent} title={t("settings.accentCustom")}
                onChange={(e) => pickAccent(e.target.value)} />
              <button className="mini-btn" title={t("settings.resetDefault")}
                disabled={accent.toLowerCase() === DEFAULT_ACCENT}
                onClick={() => { resetAccent(); setAccentState(DEFAULT_ACCENT); }}>↺</button>
            </div>
          </div>
        </section>

        <section className="settings-section">
          <h2>{t("settings.shortcuts")}</h2>
          <p className="settings-hint">{t("settings.shortcutsHint")}</p>
          {CATEGORIES.map((cat) => (
            <div key={cat} className="keybind-cat">
              <h3>{t(cat)}</h3>
              <div className="keybind-grid">
                {ACTION_DEFS.filter((a) => a.category === cat).map((a) => {
                  const cur = getBinding(a.id);
                  const overridden = cur !== a.defaultKey;
                  return (
                    <div key={a.id} className="keybind-row">
                      <span className="keybind-label">{t(a.label)}</span>
                      <button
                        className={"keybind-key" + (capturing === a.id ? " capturing" : "") + (!cur ? " unset" : "")}
                        onClick={(e) => { setCapturing(a.id); e.currentTarget.focus(); }}
                        onKeyDown={capturing === a.id ? onCapture(a.id) : undefined}
                        onBlur={() => setCapturing((c) => (c === a.id ? null : c))}
                        title={t("settings.captureHint")}
                      >
                        {capturing === a.id ? t("settings.pressKey") : <kbd>{formatKey(cur)}</kbd>}
                      </button>
                      <span className="keybind-actions">
                        <button className="mini-btn" title={t("settings.resetDefault")} disabled={!overridden}
                          onClick={() => resetBinding(a.id)}>↺</button>
                        <button className="mini-btn" title={t("settings.unassign")} disabled={!cur}
                          onClick={() => clearBinding(a.id)}>✕</button>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
