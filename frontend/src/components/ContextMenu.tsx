import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "../store";

/** Menu contextuel (clic droit sur une vignette) : actions par lot sur la sélection. */
export function ContextMenu() {
  const { t } = useTranslation();
  const menu = useStore((s) => s.contextMenu);
  const selection = useStore((s) => s.selection);
  const currentId = useStore((s) => s.currentId);
  const close = useStore((s) => s.closeContextMenu);
  const openDevelop = useStore((s) => s.openDevelop);
  const patchSelection = useStore((s) => s.patchSelection);
  const removeSelection = useStore((s) => s.removeSelection);
  const setExportIds = useStore((s) => s.setExportIds);
  const setUI = useStore((s) => s.setUI);
  const albums = useStore((s) => s.albums);
  const currentAlbumId = useStore((s) => s.currentAlbumId);
  const addToAlbum = useStore((s) => s.addToAlbum);
  const removeFromAlbum = useStore((s) => s.removeFromAlbum);
  const createAlbum = useStore((s) => s.createAlbum);
  const [albumOpen, setAlbumOpen] = useState(false);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, close]);

  useEffect(() => { setAlbumOpen(false); }, [menu]);

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
        <div className="ctx-head">{t("home.photoCount", { count })}</div>
        <button onClick={act(() => { setExportIds(ids); setUI({ showExport: true }); })}>⤒ {t("export.title")}{count > 1 ? ` (${count})` : ""}</button>
        <button disabled={target === null} onClick={act(() => { if (target !== null) void openDevelop(target); })}>✎ {t("ctx.develop")}</button>
        <div className="ctx-sep" />
        <button onClick={() => setAlbumOpen((v) => !v)}>📚 {t("ctx.addToAlbum")} {albumOpen ? "▾" : "▸"}</button>
        {albumOpen && (
          <div className="ctx-sub">
            {albums.map((a) => (
              <button key={a.id} onClick={act(() => void addToAlbum(a.id, ids))}>{a.name}</button>
            ))}
            <button className="ctx-new" onClick={act(() => {
              const name = window.prompt(t("home.promptAlbumName"), t("home.newAlbum"));
              if (name && name.trim()) void createAlbum(name.trim()).then((id) => { if (id) void addToAlbum(id, ids); });
            })}>＋ {t("ctx.newAlbum")}</button>
          </div>
        )}
        {currentAlbumId !== null && (
          <button onClick={act(() => void removeFromAlbum(currentAlbumId, ids))}>📕 {t("ctx.removeFromAlbum")}</button>
        )}
        <div className="ctx-sep" />
        <button onClick={act(() => patchSelection({ flag: "pick" }))}>⚑ {t("ctx.pick")}</button>
        <button onClick={act(() => patchSelection({ flag: "reject" }))}>✕ {t("ctx.reject")}</button>
        <button onClick={act(() => patchSelection({ flag: "none" }))}>○ {t("ctx.neutral")}</button>
        <div className="ctx-sep" />
        <button className="danger" onClick={act(() => {
          if (window.confirm(t("ctx.confirmRemove", { count })))
            void removeSelection(false);
        })}>🗑 {t("ctx.removeFromCatalog")}</button>
      </div>
    </div>
  );
}
