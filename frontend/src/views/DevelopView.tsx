import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Filmstrip } from "../components/Filmstrip";
import { Histogram } from "../components/Histogram";
import { ImageViewer } from "../components/ImageViewer";
import { StarRating } from "../components/StarRating";
import { useStore } from "../store";
import { BasicPanel } from "../panels/BasicPanel";
import { CurvePanel } from "../panels/CurvePanel";
import { DetailPanel } from "../panels/DetailPanel";
import { EffectsPanel } from "../panels/EffectsPanel";
import { GeometryPanel } from "../panels/GeometryPanel";
import { HSLPanel } from "../panels/HSLPanel";
import { LocalPanel } from "../panels/LocalPanel";
import { MetaPanel } from "../panels/MetaPanel";
import { PresetsPanel } from "../panels/PresetsPanel";
import { ExifOverlay } from "./LibraryView";

const RENDER_DRAG_MS = 50;
const RENDER_DRAG_SIZE = 768;
const RENDER_IDLE_MS = 150;
const RENDER_IDLE_SIZE = 2048;

/** Rendu interactif : deux vitesses (drag rapide 768px, idle haute qualité 2048px). */
function useRenderedImage(): string | null {
  const currentId = useStore((s) => s.currentId);
  const edits = useStore((s) => s.edits);
  const beforeAfter = useStore((s) => s.beforeAfter);
  const showMaskOverlay = useStore((s) => s.showMaskOverlay);
  const selectedLocalId = useStore((s) => s.selectedLocalId);
  const isDragging = useStore((s) => s.dragBaseline !== null);
  const [src, setSrc] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number>();

  useEffect(() => {
    if (currentId === null || !edits) { setSrc(null); return; }
    window.clearTimeout(timerRef.current);
    const delay = isDragging ? RENDER_DRAG_MS : RENDER_IDLE_MS;
    const maxSize = isDragging ? RENDER_DRAG_SIZE : RENDER_IDLE_SIZE;
    timerRef.current = window.setTimeout(() => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      api.render(currentId, edits, {
        maxSize,
        before: beforeAfter,
        showMask: showMaskOverlay && selectedLocalId ? selectedLocalId : undefined,
        signal: ctrl.signal,
      })
        .then((url) => setSrc((old) => { if (old) URL.revokeObjectURL(old); return url; }))
        .catch((e) => { if ((e as Error).name !== "AbortError") console.error(e); });
    }, delay);
    return () => window.clearTimeout(timerRef.current);
  }, [currentId, edits, beforeAfter, showMaskOverlay, selectedLocalId, isDragging]);

  // libération de la dernière URL au démontage
  useEffect(() => () => {
    abortRef.current?.abort();
    setSrc((old) => { if (old) URL.revokeObjectURL(old); return null; });
  }, []);

  return src;
}

export function DevelopView() {
  const photo = useStore((s) => s.photos.find((p) => p.id === s.currentId));
  const edits = useStore((s) => s.edits);
  const dirty = useStore((s) => s.dirty);
  const beforeAfter = useStore((s) => s.beforeAfter);
  const showClipping = useStore((s) => s.showClipping);
  const showInfo = useStore((s) => s.showInfo);
  const setView = useStore((s) => s.setView);
  const setUI = useStore((s) => s.setUI);
  const setRating = useStore((s) => s.setRating);
  const copyEdits = useStore((s) => s.copyEdits);
  const pasteEdits = useStore((s) => s.pasteEdits);
  const resetEdits = useStore((s) => s.resetEdits);
  const src = useRenderedImage();

  if (!photo) return <div className="empty-state"><p>Aucune photo sélectionnée.</p></div>;

  return (
    <div className="develop">
      <div className="develop-main">
        <div className="toolbar">
          <button className="btn" onClick={() => setView("grid")}>← Bibliothèque (G)</button>
          <span className="name">{photo.filename}</span>
          {dirty && <span className="dim" title="Sauvegarde automatique en cours">●</span>}
          <span className="spacer" />
          <StarRating small value={photo.rating} onChange={setRating} />
          <button className={"btn small" + (beforeAfter ? " active" : "")}
            title="Avant / après (\\)" onClick={() => setUI({ beforeAfter: !beforeAfter })}>
            {beforeAfter ? "Avant" : "Après"}
          </button>
          <button className={"btn small" + (showClipping ? " active" : "")}
            title="Alertes d'écrêtage (J)" onClick={() => setUI({ showClipping: !showClipping })}>
            ▲▼
          </button>
          <button className="btn small" title="Copier les réglages (Ctrl+Maj+C)" onClick={copyEdits}>⧉ Copier</button>
          <button className="btn small" title="Coller les réglages (Ctrl+Maj+V)" onClick={pasteEdits}>⧉ Coller</button>
          <button className="btn small" title="Tout réinitialiser" onClick={resetEdits}>↺</button>
          <button className="btn small" title="Exporter (Ctrl+E)" onClick={() => setUI({ showExport: true })}>⤒</button>
        </div>
        <div className="develop-viewer">
          {edits ? <ImageViewer src={src} interactive /> : <div className="viewer-empty">Chargement…</div>}
          {beforeAfter && <div className="before-badge">AVANT</div>}
          {showInfo && <ExifOverlay />}
        </div>
        <Filmstrip />
      </div>
      <aside className="develop-panels">
        <Histogram src={src} />
        <BasicPanel />
        <CurvePanel />
        <HSLPanel />
        <DetailPanel />
        <EffectsPanel />
        <GeometryPanel />
        <LocalPanel />
        <PresetsPanel />
        <MetaPanel />
      </aside>
    </div>
  );
}
