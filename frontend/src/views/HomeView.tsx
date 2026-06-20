import { useState } from "react";
import { api } from "../api";
import { parseDragIds, hasDragIds } from "../lib/dragPhotos";
import { useStore } from "../store";
import { ALL_PHOTOS_ID } from "../types";

/** Écran d'accueil : tous les projets affichés en grandes icônes (couverture + nom + compte). */
export function HomeView() {
  const projects = useStore((s) => s.projects);
  const albums = useStore((s) => s.albums);
  const versions = useStore((s) => s.editsVersion);
  const setProject = useStore((s) => s.setProject);
  const setAlbum = useStore((s) => s.setAlbum);
  const setView = useStore((s) => s.setView);
  const createProject = useStore((s) => s.createProject);
  const createAlbum = useStore((s) => s.createAlbum);
  const addToAlbum = useStore((s) => s.addToAlbum);
  const setUI = useStore((s) => s.setUI);
  const [dropId, setDropId] = useState<number | null>(null);

  const open = (id: number) => { void setProject(id); setView("grid"); };
  const openAlbum = (id: number) => { void setAlbum(id); };

  const create = () => {
    const name = window.prompt("Nom du nouveau projet ?", "Nouveau projet");
    if (name && name.trim()) void createProject(name.trim());
  };

  const createAlb = () => {
    const name = window.prompt("Nom du nouvel album ?", "Nouvel album");
    if (name && name.trim()) void createAlbum(name.trim());
  };

  // Glisser-déposer de photos (depuis la grille) sur une carte d'album.
  const onDrop = (albumId: number) => (ev: React.DragEvent) => {
    ev.preventDefault();
    setDropId(null);
    const ids = parseDragIds(ev);
    if (ids.length) void addToAlbum(albumId, ids);
  };

  return (
    <div className="home">
      <header className="home-header">
        <strong className="brand">RawStudio</strong>
        <span className="spacer" />
        <button className="btn" onClick={() => setUI({ showImport: true })}>⤓ Importer</button>
      </header>
      <div className="home-body">
        <h1 className="home-title">Projets</h1>
        <div className="project-grid">
          {projects.map((p) => (
            <button key={p.id} className="project-card" onClick={() => open(p.id)}>
              <div className="project-cover">
                {p.cover
                  ? <img src={api.thumbUrl(p.cover, versions[p.cover] ?? 0)} alt="" draggable={false} />
                  : <span className="project-cover-empty">{p.id === ALL_PHOTOS_ID ? "🗂" : "📁"}</span>}
              </div>
              <div className="project-card-meta">
                <span className="project-card-name" title={p.name}>{p.name}</span>
                <span className="project-card-count">{p.count ?? 0} photo{(p.count ?? 0) > 1 ? "s" : ""}</span>
              </div>
            </button>
          ))}
          <button className="project-card new" onClick={create}>
            <div className="project-cover"><span className="project-cover-empty">＋</span></div>
            <div className="project-card-meta">
              <span className="project-card-name">Nouveau projet</span>
            </div>
          </button>
        </div>

        <h1 className="home-title">Albums</h1>
        <p className="home-hint">Collections transverses aux projets — glissez-y des photos depuis la grille.</p>
        <div className="project-grid">
          {albums.map((a) => (
            <button
              key={a.id}
              className={"project-card album" + (dropId === a.id ? " drop-target" : "")}
              onClick={() => openAlbum(a.id)}
              onDragOver={(ev) => { if (hasDragIds(ev)) { ev.preventDefault(); setDropId(a.id); } }}
              onDragLeave={() => setDropId((d) => (d === a.id ? null : d))}
              onDrop={onDrop(a.id)}
            >
              <div className="project-cover">
                {a.cover
                  ? <img src={api.thumbUrl(a.cover, versions[a.cover] ?? 0)} alt="" draggable={false} />
                  : <span className="project-cover-empty">📚</span>}
              </div>
              <div className="project-card-meta">
                <span className="project-card-name" title={a.name}>{a.name}</span>
                <span className="project-card-count">{a.count ?? 0} photo{(a.count ?? 0) > 1 ? "s" : ""}</span>
              </div>
            </button>
          ))}
          <button className="project-card new" onClick={createAlb}>
            <div className="project-cover"><span className="project-cover-empty">＋</span></div>
            <div className="project-card-meta">
              <span className="project-card-name">Nouvel album</span>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
