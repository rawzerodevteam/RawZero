import { api } from "../api";
import { useStore } from "../store";
import { ALL_PHOTOS_ID } from "../types";

/** Écran d'accueil : tous les projets affichés en grandes icônes (couverture + nom + compte). */
export function HomeView() {
  const projects = useStore((s) => s.projects);
  const versions = useStore((s) => s.editsVersion);
  const setProject = useStore((s) => s.setProject);
  const setView = useStore((s) => s.setView);
  const createProject = useStore((s) => s.createProject);
  const setUI = useStore((s) => s.setUI);

  const open = (id: number) => { void setProject(id); setView("grid"); };

  const create = () => {
    const name = window.prompt("Nom du nouveau projet ?", "Nouveau projet");
    if (name && name.trim()) void createProject(name.trim());
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
      </div>
    </div>
  );
}
