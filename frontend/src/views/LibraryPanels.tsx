import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { Filmstrip } from "../components/Filmstrip";
import { ImageViewer } from "../components/ImageViewer";
import { EmptyState } from "../components/EmptyState";
import { StarRating } from "../components/StarRating";
import { IconAlbum, IconClose, IconEdit, IconExport, IconFlag, IconFolder, IconPlus, IconTrash } from "../icons";
import { parseDragIds, hasDragIds } from "../lib/dragPhotos";
import { confirmDialog, promptDialog } from "../lib/dialog";
import { useStore } from "../store";

/** Panneaux annexes de la bibliothèque (Collections, bandeau de sélection multiple, Loupe,
 *  surimpression EXIF) — extrait de `LibraryView.tsx` (TODO N11) : sous-composants autonomes,
 *  chacun lit son propre état via `useStore`. `ExifOverlay` reste exporté (partagé avec
 *  `DevelopView.tsx`). */

export function Collections() {
  const { t } = useTranslation();
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
  const projectName = projects.find((p) => p.id === currentProjectId)?.name ?? t("import.defaultProject");

  const create = () => {
    void promptDialog(t("home.promptAlbumName"), t("home.newAlbum")).then((name) => {
      if (name) void createAlbum(name).then((id) => { if (id) void setAlbum(id); });
    });
  };
  const rename = (id: number, cur: string) => {
    void promptDialog(t("library.renameAlbumPrompt"), cur).then((name) => {
      if (name && name !== cur) void renameAlbum(id, name);
    });
  };
  const remove = (id: number, name: string) => {
    void confirmDialog(t("library.confirmDeleteAlbum", { name }), { danger: true }).then((ok) => {
      if (ok) void deleteAlbum(id);
    });
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
        <span>{t("library.collections")}</span>
        <button className="coll-add" title={t("home.newAlbum")} aria-label={t("home.newAlbum")} onClick={create}><IconPlus size={13} /></button>
      </div>
      <button
        className={"coll-item source" + (currentAlbumId === null ? " active" : "")}
        onClick={() => void setAlbum(null)}
        title={t("library.backToProject")}
      >
        <span className="coll-name"><IconFolder size={14} /> {projectName}</span>
      </button>
      <div className="coll-sep" />
      {albums.length === 0 && <p className="coll-empty">{t("library.noAlbums")}</p>}
      {albums.map((a) => (
        <div
          key={a.id}
          className={"coll-item" + (currentAlbumId === a.id ? " active" : "") + (dropId === a.id ? " drop-target" : "")}
          role="button"
          tabIndex={0}
          aria-current={currentAlbumId === a.id}
          onClick={() => void setAlbum(a.id)}
          onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); void setAlbum(a.id); } }}
          onDragOver={(ev) => { if (hasDragIds(ev)) { ev.preventDefault(); setDropId(a.id); } }}
          onDragLeave={() => setDropId((d) => (d === a.id ? null : d))}
          onDrop={onDrop(a.id)}
        >
          <span className="coll-name" title={a.name}><IconAlbum size={14} /> {a.name}</span>
          <span className="coll-count">{a.count ?? 0}</span>
          <span className="coll-actions">
            <button title={t("project.rename")} aria-label={t("project.rename")} onClick={(e) => { e.stopPropagation(); rename(a.id, a.name); }}><IconEdit size={13} /></button>
            <button title={t("common.delete")} aria-label={t("common.delete")} onClick={(e) => { e.stopPropagation(); remove(a.id, a.name); }}><IconTrash size={13} /></button>
          </span>
        </div>
      ))}
    </aside>
  );
}

export function SelectionBar() {
  const { t } = useTranslation();
  const selection = useStore((s) => s.selection);
  const setSelection = useStore((s) => s.setSelection);
  const patchSelection = useStore((s) => s.patchSelection);
  const setExportIds = useStore((s) => s.setExportIds);
  const setUI = useStore((s) => s.setUI);
  const albums = useStore((s) => s.albums);
  const addToAlbum = useStore((s) => s.addToAlbum);
  const [albumOpen, setAlbumOpen] = useState(false);
  if (selection.length < 2) return null;
  return (
    <div className="selection-bar">
      <span className="selection-count">{t("home.photoCount", { count: selection.length })}</span>
      <button className="btn small" onClick={() => { setExportIds(selection); setUI({ showExport: true }); }}>
        <IconExport size={13} /> {t("export.title")}
      </button>
      <button className="btn small" onClick={() => patchSelection({ flag: "pick" })}><IconFlag size={13} /> {t("ctx.pick")}</button>
      <button className="btn small" onClick={() => patchSelection({ flag: "reject" })}><IconClose size={11} /> {t("ctx.reject")}</button>
      <span className="selection-album">
        <button className="btn small" onClick={() => setAlbumOpen((v) => !v)}><IconAlbum size={13} /> {t("ctx.addToAlbum")}</button>
        {albumOpen && (
          <div className="selection-album-pop">
            {albums.length === 0 && <p className="hint">{t("library.noAlbums")}</p>}
            {albums.map((a) => (
              <button key={a.id} onClick={() => { void addToAlbum(a.id, selection); setAlbumOpen(false); }}>{a.name}</button>
            ))}
          </div>
        )}
      </span>
      <span className="spacer" />
      <button className="btn small" onClick={() => setSelection([])}><IconClose size={11} /> {t("common.close")}</button>
    </div>
  );
}

export function Loupe() {
  const { t } = useTranslation();
  const photo = useStore((s) => s.photos.find((p) => p.id === s.currentId));
  const versions = useStore((s) => s.editsVersion);
  const showInfo = useStore((s) => s.showInfo);
  const setRating = useStore((s) => s.setRating);
  const setFlag = useStore((s) => s.setFlag);
  const openDevelop = useStore((s) => s.openDevelop);

  if (!photo) return <EmptyState message={t("develop.noPhoto")} />;

  return (
    <div className="loupe">
      <div className="loupe-main">
        {/* Viewer partagé avec le mode développement : molette = zoom centré curseur,
            Espace + glisser = déplacement, Z / double-clic = ajusté ↔ 100 %. */}
        <ImageViewer src={api.previewUrl(photo.id, versions[photo.id] ?? 0)} />
        {showInfo && <ExifOverlay />}
        <div className="loupe-bar">
          <span className="name">{photo.filename}</span>
          {photo.edited && <span className="edited-chip" title={t("develop.editedTitle")}>{t("develop.edited")}</span>}
          <StarRating value={photo.rating} onChange={setRating} />
          <span className="flag-state">{t(`library.flagState.${photo.flag}`)}</span>
          <button className="btn small" onClick={() => setFlag("pick")}><IconFlag size={13} /> P</button>
          <button className="btn small" onClick={() => setFlag("reject")}>✕ X</button>
          <button className="btn small" onClick={() => void openDevelop(photo.id)}>{t("library.developBtn")}</button>
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
      {photo.captured_at && <span>{new Date(photo.captured_at).toLocaleString()}</span>}
    </div>
  );
}
