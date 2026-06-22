import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { PanelSection } from "../components/PanelSection";
import { useStore } from "../store";
import type { EditState, Preset } from "../types";
import {
  downloadTextFile, parsePresetFile, presetSlug, presetToEntry, serializePresets, uniquePresetName,
} from "../lib/presetFile";

export function PresetsPanel() {
  const { t } = useTranslation();
  const edits = useStore((s) => s.edits);
  const applyPartial = useStore((s) => s.applyPartial);
  const notify = useStore((s) => s.notify);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [query, setQuery] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const reload = () => api.listPresets().then(setPresets).catch(() => setPresets([]));
  useEffect(() => { void reload(); }, []);

  const saveCurrent = async () => {
    if (!edits) return;
    const name = window.prompt(t("presets.namePrompt"));
    if (!name?.trim()) return;
    // Un preset ne porte que le rendu : la géométrie et les masques restent propres à chaque photo.
    const { geometry: _g, locals: _l, ...settings } = structuredClone(edits) as EditState;
    try {
      await api.createPreset(name.trim(), settings);
      notify(t("presets.saved", { name: name.trim() }));
      void reload();
    } catch (e) {
      notify(t("presets.saveFailed", { error: String(e) }));
    }
  };

  const remove = async (p: Preset) => {
    if (!window.confirm(t("presets.confirmDelete", { name: p.name }))) return;
    try {
      await api.deletePreset(p.id);
      void reload();
    } catch (e) {
      notify(t("presets.deleteFailed", { error: String(e) }));
    }
  };

  const exportOne = (p: Preset) =>
    downloadTextFile(`${presetSlug(p.name)}.rsp`, serializePresets([presetToEntry(p)]));

  const exportAll = () => {
    const customs = presets.filter((p) => !p.builtin);
    if (customs.length === 0) return;
    downloadTextFile("mes-presets.rsp", serializePresets(customs.map(presetToEntry)));
  };

  const onImportFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const names = new Set(presets.map((p) => p.name)); // collisions résolues au fil de l'eau
    let imported = 0;
    const errors: string[] = [];
    for (const file of Array.from(files)) {
      try {
        for (const entry of parsePresetFile(await file.text())) {
          const name = uniquePresetName(entry.name, names);
          await api.createPreset(name, entry.settings);
          names.add(name);
          imported++;
        }
      } catch {
        errors.push(file.name);
      }
    }
    if (imported) notify(t("presets.imported", { count: imported }));
    if (errors.length) notify(t("presets.invalidFile", { files: errors.join(", ") }));
    void reload();
  };

  const visible = presets.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()));
  const builtins = visible.filter((p) => p.builtin);
  const customs = visible.filter((p) => !p.builtin);
  const hasCustoms = presets.some((p) => !p.builtin);

  return (
    <PanelSection title={t("presets.title")} defaultOpen={false}>
      <input
        ref={fileInput} type="file" accept=".rsp,application/json" multiple hidden
        onChange={(e) => { void onImportFiles(e.target.files); e.target.value = ""; }}
      />
      <input
        className="preset-search" type="search" value={query} placeholder={t("presets.search")}
        onChange={(e) => setQuery(e.target.value)}
      />
      {[["builtin", builtins], ["custom", customs]].map(([label, list]) =>
        (list as Preset[]).length > 0 && (
          <div key={label as string}>
            <h4>{t("presets." + (label as string))}</h4>
            <ul className="preset-list">
              {(list as Preset[]).map((p) => (
                <li key={p.id}>
                  <button
                    className="preset-apply"
                    disabled={!edits}
                    onClick={() => { applyPartial(p.settings); }}
                  >
                    {p.name}
                  </button>
                  <button className="mini-btn" title={t("presets.export")} onClick={() => exportOne(p)}>⬇</button>
                  {!p.builtin && (
                    <button className="mini-btn" title={t("common.delete")} onClick={() => void remove(p)}>✕</button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      <div className="row-actions">
        <button className="btn" disabled={!edits} onClick={() => void saveCurrent()}>
          + {t("presets.saveCurrent")}
        </button>
        <button className="btn" onClick={() => fileInput.current?.click()}>⬆ {t("presets.import")}</button>
        <button className="btn" disabled={!hasCustoms} onClick={exportAll}>⬇ {t("presets.exportAll")}</button>
      </div>
    </PanelSection>
  );
}
