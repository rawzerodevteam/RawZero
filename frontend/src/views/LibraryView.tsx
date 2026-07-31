import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { ModeTabs } from "../components/ModeTabs";
import { ProjectMenu } from "../components/ProjectMenu";
import { StarRating } from "../components/StarRating";
import { useThumbSelection } from "../components/useThumbSelection";
import { EmptyState } from "../components/EmptyState";
import { Coachmark } from "../components/Coachmark";
import { IconAlbum, IconClose, IconEdit, IconExport, IconGrid, IconImport, IconPlus, IconSettings, IconCheck } from "../icons";
import { setDragIds, parseDragIds, hasDragIds } from "../lib/dragPhotos";
import { useStore } from "../store";
import { COLOR_HEX, COLOR_VALUES, type Photo } from "../types";
import logoMark from "../assets/logo-mark.png";
import { Collections, ExifOverlay, Loupe, SelectionBar } from "./LibraryPanels";

export { ExifOverlay };

/** Filtre client (nom de fichier, insensible à la casse) : pas de colonne indexée dédiée côté
 * backend pour une recherche texte, et la liste est déjà entièrement en mémoire côté frontend. */
function filterBySearch(photos: Photo[], search: string): Photo[] {
  if (!search.trim()) return photos;
  const q = search.trim().toLowerCase();
  return photos.filter((p) => p.filename.toLowerCase().includes(q));
}

function visiblePhotoCount(photos: Photo[], search: string): number {
  return filterBySearch(photos, search).length;
}

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
  const { t } = useTranslation();
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const setUI = useStore((s) => s.setUI);
  const showAlbums = useStore((s) => s.showAlbums);
  return (
    <nav className="left-rail">
      <button className={"rail-btn" + (view === "grid" ? " active" : "")}
        onClick={() => setView("grid")} title={t("library.gridTitle")}><IconGrid size={18} /><span>{t("library.grid")}</span></button>
      <button className={"rail-btn" + (showAlbums ? " active" : "")}
        onClick={() => setUI({ showAlbums: !showAlbums })} title={t("library.albumsTitle")}><IconAlbum size={18} /><span>{t("home.albums")}</span></button>
    </nav>
  );
}

function Toolbar() {
  const { t } = useTranslation();
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
  const setView = useStore((s) => s.setView);
  const currentAlbum = albums.find((a) => a.id === currentAlbumId);
  const [showFilters, setShowFilters] = useState(false);
  const filtersRef = useRef<HTMLDivElement>(null);
  const exifActive = !!(filters.camera || filters.lens || filters.isoMin || filters.isoMax
    || filters.dateFrom || filters.dateTo);
  const filtersActive = filters.minRating > 0 || !!filters.flag || !!filters.color || exifActive;

  useEffect(() => {
    if (!showFilters) return;
    const onDown = (ev: MouseEvent) => { if (filtersRef.current && !filtersRef.current.contains(ev.target as Node)) setShowFilters(false); };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") setShowFilters(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [showFilters]);

  return (
    <div className="toolbar">
      <button className="brand-btn" title={t("project.homeTitle")} aria-label={t("project.homeTitle")} onClick={() => setView("home")}>
        <img src={logoMark} alt="" className="brand-mark" />
      </button>
      <ProjectMenu />
      <ModeTabs />
      {currentAlbum && (
        <span className="album-chip" title={t("library.albumShown")}>
          <IconAlbum size={13} /> {currentAlbum.name}
          <button title={t("library.leaveAlbum")} aria-label={t("library.leaveAlbum")} onClick={() => void setAlbum(null)}><IconClose size={11} /></button>
        </span>
      )}
      <span className="dim">{t("home.photoCount", { count: visiblePhotoCount(photos, filters.search) })}</span>
      <span className="sep" />
      <span className="catalog-search">
        <input type="text" value={filters.search} placeholder={t("library.searchPlaceholder")}
          aria-label={t("library.searchPlaceholder")}
          onChange={(ev) => setFilters({ search: ev.target.value })} />
        {filters.search && (
          <button className="mini-btn" title={t("library.searchClear")} aria-label={t("library.searchClear")}
            onClick={() => setFilters({ search: "" })}><IconClose size={10} /></button>
        )}
      </span>
      <span className="sep" />
      <span className="exif-filter" ref={filtersRef}>
        <button
          className={"btn" + (filtersActive ? " active" : "")}
          title={t("library.filtersTitle")}
          onClick={() => setShowFilters((v) => !v)}
        >
          ⚲ {t("library.filters")}{filtersActive ? " •" : ""}
        </button>
        {showFilters && (
          <div className="exif-filter-pop filters-pop" onPointerDown={(e) => e.stopPropagation()}>
            <label>{t("library.ratingGte")}</label>
            <StarRating small value={filters.minRating} onChange={(v) => setFilters({ minRating: v })} />
            <label>{t("library.flag")}</label>
            <select value={filters.flag} onChange={(ev) => setFilters({ flag: ev.target.value })}>
              <option value="">{t("library.flagAll")}</option>
              <option value="pick">{t("library.flagPick")}</option>
              <option value="reject">{t("library.flagReject")}</option>
              <option value="none">{t("library.flagNone")}</option>
            </select>
            <label>{t("library.label")}</label>
            <div className="color-filter">
              {COLOR_VALUES.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={"color-dot" + (filters.color === c ? " active" : "")}
                  style={{ background: COLOR_HEX[c] }}
                  title={t(`library.colorName.${c}`)}
                  aria-label={t(`library.colorName.${c}`)}
                  aria-pressed={filters.color === c}
                  onClick={() => setFilters({ color: filters.color === c ? "" : c })}
                />
              ))}
              {filters.color && (
                <button type="button" className="color-dot none" title={t("library.colorNone")}
                  aria-label={t("library.colorNone")} onClick={() => setFilters({ color: "" })}>✕</button>
              )}
            </div>
            <label>{t("library.sort")}</label>
            <select value={filters.sort} onChange={(ev) => setFilters({ sort: ev.target.value })}>
              <option value="captured_asc">{t("library.sortCapturedAsc")}</option>
              <option value="captured_desc">{t("library.sortCapturedDesc")}</option>
              <option value="imported_desc">{t("library.sortImportedDesc")}</option>
              <option value="rating_desc">{t("library.sortRatingDesc")}</option>
              <option value="name_asc">{t("library.sortFilename")}</option>
              {currentAlbumId !== null && <option value="custom">{t("library.sortCustom")}</option>}
            </select>
            <label>{t("meta.camera")}</label>
            <select value={filters.camera} onChange={(ev) => setFilters({ camera: ev.target.value })}>
              <option value="">{t("library.allFem")}</option>
              {facets.cameras.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <label>{t("meta.lens")}</label>
            <select value={filters.lens} onChange={(ev) => setFilters({ lens: ev.target.value })}>
              <option value="">{t("library.flagAll")}</option>
              {facets.lenses.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <label>ISO</label>
            <div className="exif-range">
              <input type="number" min={0} placeholder={t("library.minPh")} value={filters.isoMin || ""}
                onChange={(ev) => setFilters({ isoMin: Number(ev.target.value) || 0 })} />
              <span>–</span>
              <input type="number" min={0} placeholder={t("library.maxPh")} value={filters.isoMax || ""}
                onChange={(ev) => setFilters({ isoMax: Number(ev.target.value) || 0 })} />
            </div>
            <label>{t("library.captureDates")}</label>
            <div className="exif-range">
              <input type="date" value={filters.dateFrom}
                onChange={(ev) => setFilters({ dateFrom: ev.target.value })} />
              <span>–</span>
              <input type="date" value={filters.dateTo}
                onChange={(ev) => setFilters({ dateTo: ev.target.value })} />
            </div>
            {filtersActive && (
              <button className="btn exif-reset" onClick={() => resetFilters()}>{t("library.resetFilters")}</button>
            )}
          </div>
        )}
      </span>
      <span className="spacer" />
      {view === "grid" && (
        <label className="grid-size" title={t("library.thumbSize")}>
          <IconGrid size={14} />
          <input type="range" min={140} max={460} step={10} value={gridSize}
            onChange={(ev) => setUI({ gridSize: Number(ev.target.value) })} />
        </label>
      )}
      <button className="btn" onClick={() => setUI({ showImport: true })}><IconImport size={14} /> <span className="btn-label">{t("home.import")}</span></button>
      <button className="btn" onClick={() => setUI({ showExport: true })}><IconExport size={14} /> <span className="btn-label">{t("export.title")}</span></button>
      <button className="btn" title={t("library.shortcutsTitle")} onClick={() => setUI({ showHelp: true })}>?</button>
      <button className="btn small" title={t("settings.title")} aria-label={t("settings.title")} onClick={() => setView("settings")}><IconSettings size={14} /></button>
    </div>
  );
}

function Grid() {
  const { t } = useTranslation();
  const photos = useStore((s) => s.photos);
  const search = useStore((s) => s.filters.search);
  const visible = filterBySearch(photos, search);
  const currentId = useStore((s) => s.currentId);
  const currentAlbumId = useStore((s) => s.currentAlbumId);
  const selection = useStore((s) => s.selection);
  const versions = useStore((s) => s.editsVersion);
  const selectPhoto = useStore((s) => s.selectPhoto);
  const setSelection = useStore((s) => s.setSelection);
  const toggleSelect = useStore((s) => s.toggleSelect);
  const setView = useStore((s) => s.setView);
  const setRating = useStore((s) => s.setRating);
  const setUI = useStore((s) => s.setUI);
  const reorderAlbumPhotos = useStore((s) => s.reorderAlbumPhotos);
  const [reorderTargetId, setReorderTargetId] = useState<number | null>(null);

  // Glisser-réordonner dans un album : n'a de sens qu'en album (l'ordre manuel n'existe que là,
  // cf. store.ts/photos.py "custom"), et seulement sur la liste non filtrée par la recherche
  // (l'ordre visuel doit correspondre à la liste complète réordonnée, pas à un sous-ensemble).
  const canReorder = currentAlbumId !== null && !search.trim();
  const onCellDragOver = (id: number) => (ev: React.DragEvent) => {
    if (!canReorder || !hasDragIds(ev)) return;
    ev.preventDefault();
    setReorderTargetId(id);
  };
  const onCellDrop = (targetId: number) => (ev: React.DragEvent) => {
    setReorderTargetId(null);
    if (!canReorder) return;
    const dragged = parseDragIds(ev);
    if (!dragged.length) return;
    const remaining = photos.map((p) => p.id).filter((id) => !dragged.includes(id));
    const at = remaining.indexOf(targetId);
    if (at === -1) return; // la cible faisait partie du glissement : rien à faire
    remaining.splice(at, 0, ...dragged);
    void reorderAlbumPhotos(remaining);
  };
  const gridSize = useStore((s) => s.gridSize);
  const markHintSeen = useStore((s) => s.markHintSeen);
  const { onClick, onContextMenu } = useThumbSelection();
  const ref = useRef<HTMLDivElement>(null);

  // Le coach-mark de sélection multiple n'a plus lieu d'être une fois le geste découvert.
  useEffect(() => { if (selection.length > 1) markHintSeen("library-multiselect"); }, [selection.length, markHintSeen]);

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

  // Sélection au clic sur une vignette gérée via les événements POINTEUR (pas `onClick`) :
  // les cellules sont `draggable`, donc un léger mouvement déclenche un drag natif qui *avale*
  // le `click` — on se retrouvait avec tout en bleu, impossible à désélectionner. Le pointerup,
  // lui, est toujours émis pour un vrai clic (et pas pour un glissement → pas de fausse sélection).
  const cellDown = useRef<{ id: number; x: number; y: number } | null>(null);
  const onCellPointerDown = (ev: React.PointerEvent, id: number) => {
    if (ev.button !== 0) return;
    cellDown.current = { id, x: ev.clientX, y: ev.clientY };
  };
  const onCellPointerUp = (ev: React.PointerEvent, id: number) => {
    const d = cellDown.current;
    cellDown.current = null;
    if (!d || d.id !== id) return;
    if (Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 6) return; // c'était un glissement
    onClick(ev as unknown as React.MouseEvent, id);
  };

  // garde la photo courante visible quand on navigue au clavier
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(`[data-id="${currentId}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [currentId]);

  if (!photos.length) {
    return (
      <EmptyState
        message={t("library.emptyCatalog")}
        cta={{ label: t("library.importPhotos"), onClick: () => setUI({ showImport: true }) }}
      />
    );
  }
  if (!visible.length) {
    return <EmptyState message={t("library.noSearchMatch")} />;
  }

  return (
    <>
      <SelectionBar />
      <div className="grid-coachmark">
        <Coachmark hintKey="library-multiselect" message={t("library.multiSelectHint")} />
      </div>
      <div className="grid" ref={ref} role="listbox" aria-multiselectable="true"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${gridSize}px, 1fr))` }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={onPointerUp} onPointerLeave={onPointerUp}>
      {marquee && (
        <div className="marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />
      )}
      {visible.map((p) => (
        <div
          key={p.id}
          data-id={p.id}
          className={"cell" + (p.id === currentId ? " current" : "") +
            (selection.includes(p.id) ? " selected" : "") + (p.flag === "reject" ? " rejected" : "") +
            (reorderTargetId === p.id ? " reorder-target" : "")}
          draggable
          role="option"
          aria-selected={selection.includes(p.id)}
          tabIndex={p.id === currentId ? 0 : -1}
          onDragStart={(ev) => {
            // glisse la sélection si la vignette en fait partie, sinon juste celle-ci.
            const ids = selection.includes(p.id) ? selection : [p.id];
            if (!selection.includes(p.id)) setSelection([p.id]);
            setDragIds(ev, ids);
          }}
          onDragOver={onCellDragOver(p.id)}
          onDragLeave={() => setReorderTargetId((id) => (id === p.id ? null : id))}
          onDrop={onCellDrop(p.id)}
          onPointerDown={(ev) => onCellPointerDown(ev, p.id)}
          onPointerUp={(ev) => onCellPointerUp(ev, p.id)}
          onContextMenu={(ev) => onContextMenu(ev, p.id)}
          onDoubleClick={() => { selectPhoto(p.id); setView("loupe"); }}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") { ev.preventDefault(); selectPhoto(p.id); setView("loupe"); }
            else if (ev.key === " ") { ev.preventDefault(); toggleSelect(p.id); }
          }}
        >
          <div className="cell-img">
            <img src={api.thumbUrl(p.id, versions[p.id] ?? 0)} alt={p.filename} loading="lazy" draggable={false} />
            {selection.includes(p.id) && <span className="badge select"><IconCheck size={11} /></span>}
            {p.flag === "pick" && <span className="badge pick">⚑</span>}
            {p.flag === "reject" && <span className="badge reject"><IconClose size={10} /></span>}
            {p.color && <span className="badge color" style={{ background: COLOR_HEX[p.color] }} />}
            {!!p.is_raw && <span className="badge raw">RAW</span>}
            {p.edited && <span className="badge edited" title={t("develop.editedTitle")}><IconEdit size={10} /></span>}
            {p.missing && <span className="badge missing" title={t("relink.missingBadge")}>⚠</span>}
          </div>
          <div className="cell-meta">
            <span className="name" title={p.filename}>
              {p.edited && <span className="edited-dot" title={t("develop.editedTitle")} />}
              {p.filename}
            </span>
            <StarRating small value={p.rating}
              onChange={(v) => { selectPhoto(p.id); setRating(v); }} />
          </div>
        </div>
      ))}
      </div>
    </>
  );
}

