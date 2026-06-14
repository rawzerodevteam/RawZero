import { useStore } from "../store";

/** Deux onglets principaux : Bibliothèque (grille/zoom) et Développement. */
export function ModeTabs({ className = "" }: { className?: string }) {
  const view = useStore((s) => s.view);
  const currentId = useStore((s) => s.currentId);
  const photos = useStore((s) => s.photos);
  const setView = useStore((s) => s.setView);
  const openDevelop = useStore((s) => s.openDevelop);
  const inLibrary = view !== "develop";
  // si rien n'est sélectionné, le développement ouvre la 1ʳᵉ photo du projet
  const devTarget = currentId ?? photos[0]?.id ?? null;

  return (
    <div className={"mode-tabs " + className}>
      <button className={"mode-tab" + (inLibrary ? " active" : "")}
        onClick={() => { if (!inLibrary) setView("grid"); }}>Bibliothèque</button>
      <button className={"mode-tab" + (!inLibrary ? " active" : "")} disabled={devTarget === null}
        onClick={() => { if (devTarget !== null) void openDevelop(devTarget); }}>Développement</button>
    </div>
  );
}
