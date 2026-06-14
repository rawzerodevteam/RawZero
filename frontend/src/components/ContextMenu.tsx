import { useEffect } from "react";
import { useStore } from "../store";

/** Menu contextuel (clic droit sur une vignette) : actions par lot sur la sélection. */
export function ContextMenu() {
  const menu = useStore((s) => s.contextMenu);
  const selection = useStore((s) => s.selection);
  const currentId = useStore((s) => s.currentId);
  const close = useStore((s) => s.closeContextMenu);
  const openDevelop = useStore((s) => s.openDevelop);
  const patchSelection = useStore((s) => s.patchSelection);
  const removeSelection = useStore((s) => s.removeSelection);
  const setExportIds = useStore((s) => s.setExportIds);
  const setUI = useStore((s) => s.setUI);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, close]);

  if (!menu) return null;
  const ids = selection.length ? selection : (currentId !== null ? [currentId] : []);
  const count = ids.length;
  const target = ids[0] ?? null;
  const act = (fn: () => void) => () => { fn(); close(); };

  // décalage si le menu déborde à droite/en bas (approximatif, suffisant)
  const left = Math.min(menu.x, window.innerWidth - 230);
  const top = Math.min(menu.y, window.innerHeight - 260);

  return (
    <div className="ctx-backdrop" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }}>
      <div className="context-menu" style={{ left, top }} onClick={(e) => e.stopPropagation()}>
        <div className="ctx-head">{count} photo{count > 1 ? "s" : ""}</div>
        <button onClick={act(() => { setExportIds(ids); setUI({ showExport: true }); })}>⤒ Exporter{count > 1 ? ` (${count})` : ""}</button>
        <button disabled={target === null} onClick={act(() => { if (target !== null) void openDevelop(target); })}>✎ Développer</button>
        <div className="ctx-sep" />
        <button onClick={act(() => patchSelection({ flag: "pick" }))}>⚑ Retenir</button>
        <button onClick={act(() => patchSelection({ flag: "reject" }))}>✕ Rejeter</button>
        <button onClick={act(() => patchSelection({ flag: "none" }))}>○ Neutre</button>
        <div className="ctx-sep" />
        <button className="danger" onClick={act(() => {
          if (window.confirm(`Retirer ${count} photo${count > 1 ? "s" : ""} du catalogue ? (les fichiers importés sont conservés)`))
            void removeSelection(false);
        })}>🗑 Retirer du catalogue</button>
      </div>
    </div>
  );
}
