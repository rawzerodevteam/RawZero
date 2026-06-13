import { useEffect, useRef } from "react";
import { api } from "../api";
import { Filmstrip } from "../components/Filmstrip";
import { ImageViewer } from "../components/ImageViewer";
import { StarRating } from "../components/StarRating";
import { useStore } from "../store";
import { COLOR_HEX, COLOR_VALUES, FLAG_LABELS } from "../types";

export function LibraryView() {
  const view = useStore((s) => s.view);
  return (
    <div className="library">
      <Toolbar />
      <div className="library-body">
        <LeftRail />
        <div className="library-content">
          {view === "grid" ? <Grid /> : <Loupe />}
        </div>
      </div>
    </div>
  );
}

function LeftRail() {
  const view = useStore((s) => s.view);
  const currentId = useStore((s) => s.currentId);
  const setView = useStore((s) => s.setView);
  const openDevelop = useStore((s) => s.openDevelop);
  const setUI = useStore((s) => s.setUI);
  return (
    <nav className="left-rail">
      <button className={"rail-btn" + (view === "grid" ? " active" : "")}
        onClick={() => setView("grid")} title="Grille (G)">▦<span>Grille</span></button>
      <button className={"rail-btn" + (view === "loupe" ? " active" : "")} disabled={currentId === null}
        onClick={() => setView("loupe")} title="Loupe (E)">⊙<span>Loupe</span></button>
      <button className="rail-btn" disabled={currentId === null}
        onClick={() => currentId !== null && void openDevelop(currentId)} title="Développer (D)">✎<span>Développer</span></button>
      <span className="rail-spacer" />
      <button className="rail-btn" onClick={() => setUI({ showImport: true })} title="Importer">⤓<span>Importer</span></button>
      <button className="rail-btn export" onClick={() => setUI({ showExport: true })}
        title="Exporter (Ctrl+E)">⤒<span>Exporter</span></button>
    </nav>
  );
}

function Toolbar() {
  const filters = useStore((s) => s.filters);
  const setFilters = useStore((s) => s.setFilters);
  const photos = useStore((s) => s.photos);
  const setUI = useStore((s) => s.setUI);
  return (
    <div className="toolbar">
      <strong className="brand">RawStudio</strong>
      <span className="dim">{photos.length} photo{photos.length > 1 ? "s" : ""}</span>
      <span className="sep" />
      <label>Note ≥</label>
      <StarRating small value={filters.minRating} onChange={(v) => setFilters({ minRating: v })} />
      <label>Drapeau</label>
      <select value={filters.flag} onChange={(ev) => setFilters({ flag: ev.target.value })}>
        <option value="">Tous</option>
        <option value="pick">Retenues</option>
        <option value="reject">Rejetées</option>
        <option value="none">Sans drapeau</option>
      </select>
      <label>Label</label>
      <div className="color-filter">
        {COLOR_VALUES.map((c) => (
          <span
            key={c}
            className={"color-dot" + (filters.color === c ? " active" : "")}
            style={{ background: COLOR_HEX[c] }}
            onClick={() => setFilters({ color: filters.color === c ? "" : c })}
          />
        ))}
      </div>
      <label>Tri</label>
      <select value={filters.sort} onChange={(ev) => setFilters({ sort: ev.target.value })}>
        <option value="captured_asc">Date de capture ↑</option>
        <option value="captured_desc">Date de capture ↓</option>
        <option value="imported_desc">Import récent</option>
        <option value="rating_desc">Note ↓</option>
        <option value="filename">Nom de fichier</option>
      </select>
      <span className="spacer" />
      <button className="btn" onClick={() => setUI({ showImport: true })}>⤓ Importer</button>
      <button className="btn" onClick={() => setUI({ showExport: true })}>⤒ Exporter</button>
      <button className="btn" title="Raccourcis (?)" onClick={() => setUI({ showHelp: true })}>?</button>
    </div>
  );
}

function Grid() {
  const photos = useStore((s) => s.photos);
  const currentId = useStore((s) => s.currentId);
  const versions = useStore((s) => s.editsVersion);
  const selectPhoto = useStore((s) => s.selectPhoto);
  const setView = useStore((s) => s.setView);
  const setRating = useStore((s) => s.setRating);
  const setUI = useStore((s) => s.setUI);
  const ref = useRef<HTMLDivElement>(null);

  // garde la photo courante visible quand on navigue au clavier
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(`[data-id="${currentId}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [currentId]);

  if (!photos.length) {
    return (
      <div className="empty-state">
        <p>Aucune photo dans le catalogue (ou aucune ne passe les filtres).</p>
        <button className="btn primary" onClick={() => setUI({ showImport: true })}>
          Importer des photos
        </button>
      </div>
    );
  }

  return (
    <div className="grid" ref={ref}>
      {photos.map((p) => (
        <div
          key={p.id}
          data-id={p.id}
          className={"cell" + (p.id === currentId ? " current" : "") + (p.flag === "reject" ? " rejected" : "")}
          onClick={() => selectPhoto(p.id)}
          onDoubleClick={() => { selectPhoto(p.id); setView("loupe"); }}
        >
          <div className="cell-img">
            <img src={api.thumbUrl(p.id, versions[p.id] ?? 0)} alt={p.filename} loading="lazy" draggable={false} />
            {p.flag === "pick" && <span className="badge pick">⚑</span>}
            {p.flag === "reject" && <span className="badge reject">✕</span>}
            {p.color && <span className="badge color" style={{ background: COLOR_HEX[p.color] }} />}
            {!!p.is_raw && <span className="badge raw">RAW</span>}
            {p.edited && <span className="badge edited" title="Photo retouchée">✎</span>}
          </div>
          <div className="cell-meta">
            <span className="name" title={p.filename}>
              {p.edited && <span className="edited-dot" title="Photo retouchée" />}
              {p.filename}
            </span>
            <StarRating small value={p.rating}
              onChange={(v) => { selectPhoto(p.id); setRating(v); }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Loupe() {
  const photo = useStore((s) => s.photos.find((p) => p.id === s.currentId));
  const versions = useStore((s) => s.editsVersion);
  const showInfo = useStore((s) => s.showInfo);
  const setRating = useStore((s) => s.setRating);
  const setFlag = useStore((s) => s.setFlag);
  const openDevelop = useStore((s) => s.openDevelop);

  if (!photo) return <div className="empty-state"><p>Aucune photo sélectionnée.</p></div>;

  return (
    <div className="loupe">
      <div className="loupe-main">
        <ImageViewer src={api.previewUrl(photo.id, versions[photo.id] ?? 0)} />
        {showInfo && <ExifOverlay />}
        <div className="loupe-bar">
          <span className="name">{photo.filename}</span>
          {photo.edited && <span className="edited-chip" title="Photo retouchée">Modifiée</span>}
          <StarRating value={photo.rating} onChange={setRating} />
          <span className="flag-state">{FLAG_LABELS[photo.flag]}</span>
          <button className="btn small" onClick={() => setFlag("pick")}>⚑ P</button>
          <button className="btn small" onClick={() => setFlag("reject")}>✕ X</button>
          <button className="btn small" onClick={() => void openDevelop(photo.id)}>Développer (D)</button>
        </div>
      </div>
      <Filmstrip />
    </div>
  );
}

/** Surimpression EXIF (touche I), partagée loupe / développement. */
export function ExifOverlay() {
  const photo = useStore((s) => s.photos.find((p) => p.id === s.currentId));
  if (!photo) return null;
  const parts = [
    photo.camera, photo.lens,
    photo.iso ? `ISO ${photo.iso}` : "",
    photo.aperture ? `f/${photo.aperture}` : "",
    photo.shutter, photo.focal ? `${photo.focal} mm` : "",
  ].filter(Boolean);
  return (
    <div className="exif-overlay">
      <strong>{photo.filename}</strong>
      {photo.width > 0 && <span>{photo.width} × {photo.height}</span>}
      {parts.map((p) => <span key={p}>{p}</span>)}
      {photo.captured_at && <span>{new Date(photo.captured_at).toLocaleString("fr-FR")}</span>}
    </div>
  );
}
