import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { confirmDialog, promptDialog } from "../lib/dialog";
import { useStore } from "../store";
import { ALL_PHOTOS_ID } from "../types";

/** Sélecteur de projet (dossier d'import) en haut à gauche : changer / créer / renommer / supprimer. */
export function ProjectMenu() {
  const { t } = useTranslation();
  const projects = useStore((s) => s.projects);
  const currentProjectId = useStore((s) => s.currentProjectId);
  const setProject = useStore((s) => s.setProject);
  const createProject = useStore((s) => s.createProject);
  const renameProject = useStore((s) => s.renameProject);
  const deleteProject = useStore((s) => s.deleteProject);
  const setView = useStore((s) => s.setView);
  const notify = useStore((s) => s.notify);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const current = projects.find((p) => p.id === currentProjectId);
  const isReal = !!current && current.id !== ALL_PHOTOS_ID;   // « Toutes les photos » : pas de renommage/suppression
  const realCount = projects.filter((p) => p.id !== ALL_PHOTOS_ID).length;

  const create = () => {
    setOpen(false);
    void promptDialog(t("home.promptProjectName"), t("home.newProject")).then((name) => {
      if (name) void createProject(name);
    });
  };
  const rename = () => {
    if (!current || !isReal) return;
    setOpen(false);
    void promptDialog(t("project.renamePrompt"), current.name).then((name) => {
      if (name) void renameProject(current.id, name);
    });
  };
  const remove = () => {
    if (!current || !isReal) return;
    setOpen(false);
    if (realCount <= 1) { notify(t("project.cantDeleteLast")); return; }
    void confirmDialog(t("project.confirmDelete", { name: current.name }), { danger: true }).then((ok) => {
      if (ok) void deleteProject(current.id);
    });
  };

  return (
    <div className="project-menu" ref={ref}>
      <button className="project-home" title={t("project.homeTitle")} aria-label={t("project.homeTitle")} onClick={() => setView("home")}>🏠</button>
      <button className="project-trigger" onClick={() => setOpen((v) => !v)} title={t("project.triggerTitle")}>
        📁 <span className="pm-name">{current?.name ?? t("import.defaultProject")}</span> ▾
      </button>
      {open && (
        <div className="project-dropdown">
          <div className="pm-head">{t("home.projects")}</div>
          {projects.map((p) => (
            <button key={p.id} className={"pm-item" + (p.id === currentProjectId ? " active" : "")}
              onClick={() => { void setProject(p.id); setOpen(false); }}>
              <span className="pm-item-name">{p.name}</span>
              <span className="pm-count">{p.count ?? 0}</span>
            </button>
          ))}
          <div className="pm-sep" />
          <button className="pm-item" onClick={create}>＋ {t("home.newProject")}</button>
          <button className="pm-item" onClick={rename} disabled={!isReal}>✎ {t("project.rename")}</button>
          <button className="pm-item danger" onClick={remove} disabled={!isReal || realCount <= 1}>🗑 {t("common.delete")}</button>
        </div>
      )}
    </div>
  );
}
