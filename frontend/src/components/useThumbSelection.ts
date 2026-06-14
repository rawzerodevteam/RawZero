import { useStore } from "../store";

/** Gestion commune du clic sur une vignette (grille / filmstrip) :
 *  Ctrl/⌘ = (dé)sélection, Maj = plage, clic simple = sélection (ou ouvre le dev), clic droit = menu. */
export function useThumbSelection() {
  const view = useStore((s) => s.view);
  const selectPhoto = useStore((s) => s.selectPhoto);
  const toggleSelect = useStore((s) => s.toggleSelect);
  const selectRange = useStore((s) => s.selectRange);
  const openDevelop = useStore((s) => s.openDevelop);
  const openContextMenu = useStore((s) => s.openContextMenu);

  const onClick = (ev: React.MouseEvent, id: number) => {
    if (ev.ctrlKey || ev.metaKey) toggleSelect(id);
    else if (ev.shiftKey) selectRange(id);
    else if (view === "develop") void openDevelop(id);
    else selectPhoto(id);
  };

  const onContextMenu = (ev: React.MouseEvent, id: number) => {
    ev.preventDefault();
    openContextMenu(id, ev.clientX, ev.clientY);
  };

  return { onClick, onContextMenu };
}
