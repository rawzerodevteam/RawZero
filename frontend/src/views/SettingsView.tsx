import { useState } from "react";
import { useTranslation } from "react-i18next";
import { isTauri } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import {
  ACTION_DEFS, CATEGORIES, clearBinding, formatKey, getBinding,
  normalizeEvent, resetAllBindings, resetBinding, setBinding, useKeybindings,
} from "../keybindings";
import {
  ACCENT_PRESETS, DEFAULT_ACCENT, THEMES, getAccent, getCustomBg, getThemeId, paletteFromBg,
  resetAccent, setAccent, setCustomBg, setTheme,
} from "../theme";
import { useStore } from "../store";

// Icônes SVG (currentColor) : évite le rendu 2 couleurs (franges ClearType) des glyphes texte ✕/↺.
const IconReset = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5V6h-3.5" strokeLinejoin="round" />
  </svg>
);
const IconClose = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="M2 2l12 12M14 2L2 14" />
  </svg>
);

/** Onglet « Paramètres » : apparence (langue, couleur d'accent) + raccourcis clavier. */
export function SettingsView() {
  const { t } = useTranslation();
  useKeybindings(); // re-rendu quand une touche change
  const setView = useStore((s) => s.setView);
  const [capturing, setCapturing] = useState<string | null>(null);
  const [accent, setAccentState] = useState(getAccent());
  const [themeId, setThemeId] = useState(getThemeId());
  const [customBg, setCustomBgState] = useState(getCustomBg());
  const [updateStatus, setUpdateStatus] =
    useState<"idle" | "checking" | "none" | "available" | "installing" | "ready" | "error">("idle");
  const [updateInfo, setUpdateInfo] = useState<Update | null>(null);

  const checkForUpdate = async () => {
    setUpdateStatus("checking");
    try {
      const update = await check();
      setUpdateInfo(update);
      setUpdateStatus(update ? "available" : "none");
    } catch {
      setUpdateStatus("error");
    }
  };

  const installUpdate = async () => {
    if (!updateInfo) return;
    setUpdateStatus("installing");
    try {
      await updateInfo.downloadAndInstall();
      setUpdateStatus("ready");
    } catch {
      setUpdateStatus("error");
    }
  };

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
                  title={t(th.name)}
                  onClick={() => { setTheme(th.id); setThemeId(th.id); }}
                >
                  <span className="theme-preview" style={{ background: th.vars["--bg"] }}>
                    <span className="theme-preview-bar"
                      style={{ background: th.vars["--bg-panel"], borderBottom: `1px solid ${th.vars["--border"]}` }} />
                    <span className="theme-preview-line" style={{ background: th.vars["--text-dim"] }} />
                    <span className="theme-preview-dot" />
                  </span>
                  <span className="theme-name">{t(th.name)}</span>
                </button>
              ))}
              {(() => {
                const cv = paletteFromBg(customBg);
                return (
                  <button
                    className={"theme-card" + (themeId === "custom" ? " active" : "")}
                    title={t("settings.themeCustom")}
                    onClick={() => { setTheme("custom"); setThemeId("custom"); }}
                  >
                    <span className="theme-preview" style={{ background: cv["--bg"] }}>
                      <span className="theme-preview-bar"
                        style={{ background: cv["--bg-panel"], borderBottom: `1px solid ${cv["--border"]}` }} />
                      <span className="theme-preview-line" style={{ background: cv["--text-dim"] }} />
                    </span>
                    <span className="theme-name">{t("settings.themeCustom")}</span>
                  </button>
                );
              })()}
            </div>
          </div>
          {themeId === "custom" && (
            <div className="settings-field">
              <span className="settings-label">{t("settings.themeCustomPick")}</span>
              <div className="accent-picker">
                <input
                  type="color"
                  value={customBg}
                  title={t("settings.themeCustomPick")}
                  onChange={(e) => {
                    setCustomBgState(e.target.value);
                    setCustomBg(e.target.value);
                  }}
                />
                <code className="settings-hex">{customBg}</code>
              </div>
            </div>
          )}
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
                onClick={() => { resetAccent(); setAccentState(DEFAULT_ACCENT); }}><IconReset /></button>
            </div>
          </div>
        </section>

        {isTauri() && (
          <section className="settings-section">
            <h2>{t("settings.updates")}</h2>
            <div className="settings-field">
              {updateStatus === "ready" ? (
                <button className="btn" onClick={() => relaunch()}>{t("settings.updateRestart")}</button>
              ) : updateStatus === "available" ? (
                <button className="btn" onClick={installUpdate}>
                  {t("settings.updateInstall", { version: updateInfo?.version })}
                </button>
              ) : (
                <button className="btn" disabled={updateStatus === "checking" || updateStatus === "installing"}
                  onClick={checkForUpdate}>
                  {t("settings.updateCheck")}
                </button>
              )}
              {updateStatus === "checking" && <span className="settings-hint">{t("settings.updateChecking")}</span>}
              {updateStatus === "none" && <span className="settings-hint">{t("settings.updateNone")}</span>}
              {updateStatus === "installing" && <span className="settings-hint">{t("settings.updateInstalling")}</span>}
              {updateStatus === "error" && <span className="settings-hint">{t("settings.updateError")}</span>}
            </div>
          </section>
        )}

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
                          onClick={() => resetBinding(a.id)}><IconReset /></button>
                        <button className="mini-btn" title={t("settings.unassign")} disabled={!cur}
                          onClick={() => clearBinding(a.id)}><IconClose /></button>
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
