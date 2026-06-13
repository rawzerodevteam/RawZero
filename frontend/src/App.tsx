import { useEffect } from "react";
import { ExportDialog } from "./components/ExportDialog";
import { ImportPanel } from "./components/ImportPanel";
import { ShortcutsOverlay } from "./components/ShortcutsOverlay";
import { useGlobalShortcuts } from "./shortcuts";
import { useStore } from "./store";
import { DevelopView } from "./views/DevelopView";
import { LibraryView } from "./views/LibraryView";

export function App() {
  const view = useStore((s) => s.view);
  const showHelp = useStore((s) => s.showHelp);
  const showImport = useStore((s) => s.showImport);
  const showExport = useStore((s) => s.showExport);
  const toast = useStore((s) => s.toast);
  const loadPhotos = useStore((s) => s.loadPhotos);
  useGlobalShortcuts();

  useEffect(() => { void loadPhotos(); }, [loadPhotos]);

  return (
    <div className="app">
      {view === "develop" ? <DevelopView /> : <LibraryView />}
      {showImport && <ImportPanel />}
      {showExport && <ExportDialog />}
      {showHelp && <ShortcutsOverlay />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
