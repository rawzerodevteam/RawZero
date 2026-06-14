import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";

/** Sélecteur de projet (dossier d'import) en haut à gauche : changer / créer / renommer / supprimer. */
export function ProjectMenu() {
  const projects = useStore((s) => s.projects);
  const currentProjectId = useStore((s) => s.currentProjectId);
  const setProject = useStore((s) => s.setProject);
  const createProject = useStore((s) => s.createProject);
  const renameProject = useStore((s) => s.renameProject);
  const deleteProject = useStore((s) => s.deleteProject);
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

  const create = () => {
    const name = window.prompt("Nom du nouveau projet ?", "Nouveau projet");
    if (name && name.trim()) void createProject(name.trim());
    setOpen(false);
  };
  const rename = () => {
    if (!current) return;
    const name = window.prompt("Renommer le projet", current.name);
    if (name && name.trim()) void renameProject(current.id, name.trim());
    setOpen(false);
  };
  const remove = () => {
    if (!current) return;
    if (projects.length <= 1) { notify("Impossible de supprimer le dernier projet"); setOpen(false); return; }
    if (window.confirm(`Supprimer le projet « ${current.name} » et toutes ses photos du catalogue ? (les fichiers importés sont conservés)`))
      void deleteProject(current.id);
    setOpen(false);
  };

  return (
    <div className="project-menu" ref={ref}>
      <button className="project-trigger" onClick={() => setOpen((v) => !v)} title="Projet (dossier d'import)">
        📁 <span className="pm-name">{current?.name ?? "Projet"}</span> ▾
      </button>
      {open && (
        <div className="project-dropdown">
          <div className="pm-head">Projets</div>
          {projects.map((p) => (
            <button key={p.id} className={"pm-item" + (p.id === currentProjectId ? " active" : "")}
              onClick={() => { void setProject(p.id); setOpen(false); }}>
              <span className="pm-item-name">{p.name}</span>
              <span className="pm-count">{p.count ?? 0}</span>
            </button>
          ))}
          <div className="pm-sep" />
          <button className="pm-item" onClick={create}>＋ Nouveau projet</button>
          <button className="pm-item" onClick={rename} disabled={!current}>✎ Renommer</button>
          <button className="pm-item danger" onClick={remove} disabled={!current || projects.length <= 1}>🗑 Supprimer</button>
        </div>
      )}
    </div>
  );
}
