import { useEffect, useState } from "react";
import { api } from "../api";
import { PanelSection } from "../components/PanelSection";
import { useStore } from "../store";
import type { EditState, Preset } from "../types";

export function PresetsPanel() {
  const edits = useStore((s) => s.edits);
  const applyPartial = useStore((s) => s.applyPartial);
  const notify = useStore((s) => s.notify);
  const [presets, setPresets] = useState<Preset[]>([]);

  const reload = () => api.listPresets().then(setPresets).catch(() => setPresets([]));
  useEffect(() => { void reload(); }, []);

  const saveCurrent = async () => {
    if (!edits) return;
    const name = window.prompt("Nom du preset :");
    if (!name?.trim()) return;
    // Un preset ne porte que le rendu : la géométrie et les masques restent propres à chaque photo.
    const { geometry: _g, locals: _l, ...settings } = structuredClone(edits) as EditState;
    try {
      await api.createPreset(name.trim(), settings);
      notify(`Preset « ${name.trim()} » enregistré`);
      void reload();
    } catch (e) {
      notify(`Enregistrement impossible : ${e}`);
    }
  };

  const remove = async (p: Preset) => {
    if (!window.confirm(`Supprimer le preset « ${p.name} » ?`)) return;
    try {
      await api.deletePreset(p.id);
      void reload();
    } catch (e) {
      notify(`Suppression impossible : ${e}`);
    }
  };

  const builtins = presets.filter((p) => p.builtin);
  const customs = presets.filter((p) => !p.builtin);

  return (
    <PanelSection title="Presets" defaultOpen={false}>
      {[["Intégrés", builtins], ["Personnels", customs]].map(([label, list]) =>
        (list as Preset[]).length > 0 && (
          <div key={label as string}>
            <h4>{label as string}</h4>
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
                  {!p.builtin && (
                    <button className="mini-btn" title="Supprimer" onClick={() => void remove(p)}>✕</button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      <div className="row-actions">
        <button className="btn" disabled={!edits} onClick={() => void saveCurrent()}>
          + Enregistrer les réglages actuels
        </button>
      </div>
    </PanelSection>
  );
}
