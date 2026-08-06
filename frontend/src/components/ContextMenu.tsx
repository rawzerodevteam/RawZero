import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { confirmDialog, promptDialog } from "../lib/dialog";
import { useStore } from "../store";
import { COLOR_HEX, COLOR_VALUES } from "../types";
import { StarRating } from "./StarRating";
import { IconAlbum, IconChevron, IconClose, IconEdit, IconExport, IconFlag, IconPalette, IconPaste, IconPlus, IconTrash } from "../icons";

type Sub = "album" | "rating" | "color" | null;

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
  const clipboard = useStore((s) => s.clipboard);
  const pasteEditsToSelection = useStore((s) => s.pasteEditsToSelection);
  const [sub, setSub] = useState<Sub>(null);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, close]);

  useEffect(() => { setSub(null); }, [menu]);

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
        <button onClick={act(() => { setExportIds(ids); setUI({ showExport: true }); })}><IconExport size={13} /> {t("export.title")}{count > 1 ? ` (${count})` : ""}</button>
        <button disabled={target === null} onClick={act(() => { if (target !== null) void openDevelop(target); })}><IconEdit size={13} /> {t("ctx.develop")}</button>
        <button disabled={!clipboard} onClick={act(() => void pasteEditsToSelection(ids))}><IconPaste size={13} /> {t("ctx.pasteSettings")}</button>
        <div className="ctx-sep" />
        <button onClick={() => setSub(sub === "album" ? null : "album")}><IconAlbum size={13} /> {t("ctx.addToAlbum")} <IconChevron size={9} className={"chev" + (sub === "album" ? " open" : "")} /></button>
        {sub === "album" && (
          <div className="ctx-sub">
            {albums.map((a) => (
              <button key={a.id} onClick={act(() => void addToAlbum(a.id, ids))}>{a.name}</button>
            ))}
            <button className="ctx-new" onClick={act(() => {
              void promptDialog(t("home.promptAlbumName"), t("home.newAlbum")).then((name) => {
                if (name) void createAlbum(name).then((id) => { if (id) void addToAlbum(id, ids); });
              });
            })}><IconPlus size={11} /> {t("ctx.newAlbum")}</button>
          </div>
        )}
        {currentAlbumId !== null && (
          <button onClick={act(() => void removeFromAlbum(currentAlbumId, ids))}><IconAlbum size={13} /> {t("ctx.removeFromAlbum")}</button>
        )}
        <div className="ctx-sep" />
        <button onClick={() => setSub(sub === "rating" ? null : "rating")}>★ {t("ctx.rating")} <IconChevron size={9} className={"chev" + (sub === "rating" ? " open" : "")} /></button>
        {sub === "rating" && (
          <div className="ctx-sub ctx-sub-rating">
            <StarRating value={0} onChange={(v) => { patchSelection({ rating: v }); close(); }} />
          </div>
        )}
        <button onClick={() => setSub(sub === "color" ? null : "color")}><IconPalette size={13} /> {t("ctx.color")} <IconChevron size={9} className={"chev" + (sub === "color" ? " open" : "")} /></button>
        {sub === "color" && (
          <div className="ctx-sub ctx-sub-color">
            <button className="ctx-color-clear" onClick={act(() => patchSelection({ color: "" }))}>{t("ctx.colorClear")}</button>
            {COLOR_VALUES.map((c) => (
              <button key={c} className="ctx-color-dot" style={{ background: COLOR_HEX[c] }}
                title={t(`library.colorName.${c}`)} aria-label={t(`library.colorName.${c}`)}
                onClick={act(() => patchSelection({ color: c }))} />
            ))}
          </div>
        )}
        <div className="ctx-sep" />
        <button onClick={act(() => patchSelection({ flag: "pick" }))}><IconFlag size={14} /> {t("ctx.pick")}</button>
        <button onClick={act(() => patchSelection({ flag: "reject" }))}><IconClose size={12} /> {t("ctx.reject")}</button>
        <button onClick={act(() => patchSelection({ flag: "none" }))}>○ {t("ctx.neutral")}</button>
        <div className="ctx-sep" />
        <button className="danger" onClick={act(() => {
          void confirmDialog(t("ctx.confirmRemove", { count }), { danger: true }).then((ok) => {
            if (ok) void removeSelection(false);
          });
        })}><IconTrash size={13} /> {t("ctx.removeFromCatalog")}</button>
      </div>
    </div>
  );
}
