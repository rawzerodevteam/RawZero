import { useEffect } from "react";
import { ContextMenu } from "./components/ContextMenu";
import { DevOverlay } from "./components/DevOverlay";
import { ExportDialog } from "./components/ExportDialog";
import { ImportPanel } from "./components/ImportPanel";
import { ModelsDialog } from "./components/ModelsDialog";
import { RelinkDialog } from "./components/RelinkDialog";
import { ShortcutsOverlay } from "./components/ShortcutsOverlay";
import { ToastStack } from "./components/ToastStack";
import { DialogHost } from "./lib/dialog";
import { useGlobalShortcuts } from "./shortcuts";
import i18n from "./i18n";
import { useStore } from "./store";
import { DevelopView } from "./views/DevelopView";
import { HomeView } from "./views/HomeView";
import { LibraryView } from "./views/LibraryView";
import { SettingsView } from "./views/SettingsView";

export function App() {
  const view = useStore((s) => s.view);
  const showHelp = useStore((s) => s.showHelp);
  const showImport = useStore((s) => s.showImport);
  const showExport = useStore((s) => s.showExport);
  const showModels = useStore((s) => s.showModels);
  const init = useStore((s) => s.init);
  const loadProjects = useStore((s) => s.loadProjects);
  useGlobalShortcuts();

  useEffect(() => { void init(); }, [init]);

  // Les noms virtuels « Toutes les photos » / « Projet par défaut » sont localisés dans
  // loadProjects → on recharge la liste quand la langue change pour les mettre à jour.
  useEffect(() => {
    const onLang = () => { void loadProjects(); };
    i18n.on("languageChanged", onLang);
    return () => { i18n.off("languageChanged", onLang); };
  }, [loadProjects]);

  return (
    <div className="app">
      {view === "home" ? <HomeView /> : view === "settings" ? <SettingsView /> : view === "develop" ? <DevelopView /> : <LibraryView />}
      {showImport && <ImportPanel />}
      {showExport && <ExportDialog />}
      {showModels && <ModelsDialog />}
      {showHelp && <ShortcutsOverlay />}
      <RelinkDialog />
      <ContextMenu />
      <ToastStack />
      <DialogHost />
      <DevOverlay />
    </div>
  );
}
