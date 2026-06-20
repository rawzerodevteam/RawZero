import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Filmstrip } from "../components/Filmstrip";
import { ImageViewer } from "../components/ImageViewer";
import { ModeTabs } from "../components/ModeTabs";
import { ProjectMenu } from "../components/ProjectMenu";
import { StarRating } from "../components/StarRating";
import { useThumbSelection } from "../components/useThumbSelection";
import { setDragIds, parseDragIds, hasDragIds } from "../lib/dragPhotos";
import { useStore } from "../store";
import { COLOR_HEX, COLOR_VALUES, FLAG_LABELS } from "../types";

export function LibraryView() {
  const view = useStore((s) => s.view);
  return (
    <div className="library">
      <Toolbar />
      <div className="library-body">
        <LeftRail />
        <Collections />
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
  const photos = useStore((s) => s.photos);
  const setView = useStore((s) => s.setView);
  const selectPhoto = useStore((s) => s.selectPhoto);
  const setUI = useStore((s) => s.setUI);
  const showAlbums = useStore((s) => s.showAlbums);
  const zoomTarget = currentId ?? photos[0]?.id ?? null;
  return (
    <nav className="left-rail">
      <button className={"rail-btn" + (view === "grid" ? " active" : "")}
        onClick={() => setView("grid")} title="Grille (G)">▦<span>Grille</span></button>
      <button className={"rail-btn" + (view === "loupe" ? " active" : "")} disabled={zoomTarget === null}
        onClick={() => { if (zoomTarget !== null) { if (currentId === null) selectPhoto(zoomTarget); setView("loupe"); } }}
        title="Zoom (E)">⊙<span>Zoom</span></button>
      <button className={"rail-btn" + (showAlbums ? " active" : "")}
        onClick={() => setUI({ showAlbums: !showAlbums })} title="Albums (collections)">📚<span>Albums</span></button>
      <span className="rail-spacer" />
      <button className="rail-btn" onClick={() => setUI({ showImport: true })} title="Importer">⤓<span>Importer</span></button>
      <button className="rail-btn export" onClick={() => setUI({ showExport: true })}
        title="Exporter (Ctrl+E)">⤒<span>Exporter</span></button>
    </nav>
  );
}

/** Panneau latéral « Collections » : liste des albums, navigation, DnD, renommage/suppression. */
function Collections() {
  const showAlbums = useStore((s) => s.showAlbums);
  const albums = useStore((s) => s.albums);
  const currentAlbumId = useStore((s) => s.currentAlbumId);
  const projects = useStore((s) => s.projects);
  const currentProjectId = useStore((s) => s.currentProjectId);
  const setAlbum = useStore((s) => s.setAlbum);
  const createAlbum = useStore((s) => s.createAlbum);
  const renameAlbum = useStore((s) => s.renameAlbum);
  const deleteAlbum = useStore((s) => s.deleteAlbum);
  const addToAlbum = useStore((s) => s.addToAlbum);
  const [dropId, setDropId] = useState<number | null>(null);

  if (!showAlbums) return null;
  const projectName = projects.find((p) => p.id === currentProjectId)?.name ?? "Projet";

  const create = () => {
    const name = window.prompt("Nom du nouvel album ?", "Nouvel album");
    if (name && name.trim()) void createAlbum(name.trim()).then((id) => { if (id) void setAlbum(id); });
  };
  const rename = (id: number, cur: string) => {
    const name = window.prompt("Renommer l'album", cur);
    if (name && name.trim() && name.trim() !== cur) void renameAlbum(id, name.trim());
  };
  const remove = (id: number, name: string) => {
    if (window.confirm(`Supprimer l'album « ${name} » ? (les photos restent dans le catalogue)`))
      void deleteAlbum(id);
  };
  const onDrop = (id: number) => (ev: React.DragEvent) => {
    ev.preventDefault();
    setDropId(null);
    const ids = parseDragIds(ev);
    if (ids.length) void addToAlbum(id, ids);
  };

  return (
    <aside className="collections">
      <div className="collections-head">
        <span>Collections</span>
        <button className="coll-add" title="Nouvel album" onClick={create}>＋</button>
      </div>
      <button
        className={"coll-item source" + (currentAlbumId === null ? " active" : "")}
        onClick={() => void setAlbum(null)}
        title="Revenir au projet courant"
      >
        <span className="coll-name">📁 {projectName}</span>
      </button>
      <div className="coll-sep" />
      {albums.length === 0 && <p className="coll-empty">Aucun album. Créez-en un puis glissez-y des photos.</p>}
      {albums.map((a) => (
        <div
          key={a.id}
          className={"coll-item" + (currentAlbumId === a.id ? " active" : "") + (dropId === a.id ? " drop-target" : "")}
          onClick={() => void setAlbum(a.id)}
          onDragOver={(ev) => { if (hasDragIds(ev)) { ev.preventDefault(); setDropId(a.id); } }}
          onDragLeave={() => setDropId((d) => (d === a.id ? null : d))}
          onDrop={onDrop(a.id)}
        >
          <span className="coll-name" title={a.name}>📚 {a.name}</span>
          <span className="coll-count">{a.count ?? 0}</span>
          <span className="coll-actions">
            <button title="Renommer" onClick={(e) => { e.stopPropagation(); rename(a.id, a.name); }}>✎</button>
            <button title="Supprimer" onClick={(e) => { e.stopPropagation(); remove(a.id, a.name); }}>🗑</button>
          </span>
        </div>
      ))}
    </aside>
  );
}

function Toolbar() {
  const filters = useStore((s) => s.filters);
  const setFilters = useStore((s) => s.setFilters);
  const resetFilters = useStore((s) => s.resetFilters);
  const facets = useStore((s) => s.facets);
  const photos = useStore((s) => s.photos);
  const view = useStore((s) => s.view);
  const gridSize = useStore((s) => s.gridSize);
  const setUI = useStore((s) => s.setUI);
  const albums = useStore((s) => s.albums);
  const currentAlbumId = useStore((s) => s.currentAlbumId);
  const setAlbum = useStore((s) => s.setAlbum);
  const currentAlbum = albums.find((a) => a.id === currentAlbumId);
  const [showExif, setShowExif] = useState(false);
  const exifActive = !!(filters.camera || filters.lens || filters.isoMin || filters.isoMax
    || filters.dateFrom || filters.dateTo);
  return (
    <div className="toolbar">
      <strong className="brand">RawStudio</strong>
      <ProjectMenu />
      <ModeTabs />
      {currentAlbum && (
        <span className="album-chip" title="Album affiché">
          📚 {currentAlbum.name}
          <button title="Quitter l'album" onClick={() => void setAlbum(null)}>✕</button>
        </span>
      )}
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
      <span className="exif-filter">
        <button
          className={"btn" + (exifActive ? " active" : "")}
          title="Filtres EXIF (caméra, objectif, ISO, dates)"
          onClick={() => setShowExif((v) => !v)}
        >
          ⚲ EXIF{exifActive ? " •" : ""}
        </button>
        {showExif && (
          <div className="exif-filter-pop" onPointerDown={(e) => e.stopPropagation()}>
            <label>Caméra</label>
            <select value={filters.camera} onChange={(ev) => setFilters({ camera: ev.target.value })}>
              <option value="">Toutes</option>
              {facets.cameras.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <label>Objectif</label>
            <select value={filters.lens} onChange={(ev) => setFilters({ lens: ev.target.value })}>
              <option value="">Tous</option>
              {facets.lenses.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <label>ISO</label>
            <div className="exif-range">
              <input type="number" min={0} placeholder="min" value={filters.isoMin || ""}
                onChange={(ev) => setFilters({ isoMin: Number(ev.target.value) || 0 })} />
              <span>–</span>
              <input type="number" min={0} placeholder="max" value={filters.isoMax || ""}
                onChange={(ev) => setFilters({ isoMax: Number(ev.target.value) || 0 })} />
            </div>
            <label>Dates de capture</label>
            <div className="exif-range">
              <input type="date" value={filters.dateFrom}
                onChange={(ev) => setFilters({ dateFrom: ev.target.value })} />
              <span>–</span>
              <input type="date" value={filters.dateTo}
                onChange={(ev) => setFilters({ dateTo: ev.target.value })} />
            </div>
            {exifActive && (
              <button className="btn exif-reset" onClick={() => resetFilters()}>Réinitialiser les filtres</button>
            )}
          </div>
        )}
      </span>
      <span className="spacer" />
      {view === "grid" && (
        <label className="grid-size" title="Taille des vignettes">
          ▦
          <input type="range" min={140} max={460} step={10} value={gridSize}
            onChange={(ev) => setUI({ gridSize: Number(ev.target.value) })} />
        </label>
      )}
      <button className="btn" onClick={() => setUI({ showImport: true })}>⤓ Importer</button>
      <button className="btn" onClick={() => setUI({ showExport: true })}>⤒ Exporter</button>
      <button className="btn" title="Raccourcis (?)" onClick={() => setUI({ showHelp: true })}>?</button>
    </div>
  );
}

function Grid() {
  const photos = useStore((s) => s.photos);
  const currentId = useStore((s) => s.currentId);
  const selection = useStore((s) => s.selection);
  const versions = useStore((s) => s.editsVersion);
  const selectPhoto = useStore((s) => s.selectPhoto);
  const setSelection = useStore((s) => s.setSelection);
  const setView = useStore((s) => s.setView);
  const setRating = useStore((s) => s.setRating);
  const setUI = useStore((s) => s.setUI);
  const gridSize = useStore((s) => s.gridSize);
  const { onClick, onContextMenu } = useThumbSelection();
  const ref = useRef<HTMLDivElement>(null);

  // Rectangle de sélection (marquee), comme l'explorateur de fichiers : glisser sur le fond
  // de la grille dessine un cadre qui sélectionne toutes les vignettes qu'il recouvre.
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const drag = useRef<{ x: number; y: number; base: number[]; additive: boolean; moved: boolean } | null>(null);

  const onPointerDown = (ev: React.PointerEvent) => {
    if (ev.button !== 0) return;
    if ((ev.target as HTMLElement).closest(".cell")) return; // démarré sur une vignette → clic normal
    const additive = ev.ctrlKey || ev.metaKey || ev.shiftKey;
    drag.current = { x: ev.clientX, y: ev.clientY, base: additive ? [...selection] : [], additive, moved: false };
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
  };

  const onPointerMove = (ev: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const x = Math.min(d.x, ev.clientX), y = Math.min(d.y, ev.clientY);
    const w = Math.abs(ev.clientX - d.x), h = Math.abs(ev.clientY - d.y);
    if (!d.moved && w < 5 && h < 5) return; // sous le seuil : pas encore un glissement
    d.moved = true;
    setMarquee({ x, y, w, h });
    const hit: number[] = [];
    ref.current?.querySelectorAll<HTMLElement>(".cell").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.left < x + w && r.right > x && r.top < y + h && r.bottom > y) {
        const id = Number(el.dataset.id);
        if (!Number.isNaN(id)) hit.push(id);
      }
    });
    setSelection(d.additive ? Array.from(new Set([...d.base, ...hit])) : hit);
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    setMarquee(null);
    if (d && !d.moved && !d.additive) setSelection([]); // clic dans le vide → tout désélectionner
  };

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
    <div className="grid" ref={ref}
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${gridSize}px, 1fr))` }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={onPointerUp} onPointerLeave={onPointerUp}>
      {marquee && (
        <div className="marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />
      )}
      {photos.map((p) => (
        <div
          key={p.id}
          data-id={p.id}
          className={"cell" + (p.id === currentId ? " current" : "") +
            (selection.includes(p.id) ? " selected" : "") + (p.flag === "reject" ? " rejected" : "")}
          draggable
          onDragStart={(ev) => {
            // glisse la sélection si la vignette en fait partie, sinon juste celle-ci.
            const ids = selection.includes(p.id) ? selection : [p.id];
            if (!selection.includes(p.id)) setSelection([p.id]);
            setDragIds(ev, ids);
          }}
          onClick={(ev) => onClick(ev, p.id)}
          onContextMenu={(ev) => onContextMenu(ev, p.id)}
          onDoubleClick={() => { selectPhoto(p.id); setView("loupe"); }}
        >
          <div className="cell-img">
            <img src={api.thumbUrl(p.id, versions[p.id] ?? 0)} alt={p.filename} loading="lazy" draggable={false} />
            {selection.includes(p.id) && <span className="badge select">✓</span>}
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
