import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Filmstrip } from "../components/Filmstrip";
import { Histogram } from "../components/Histogram";
import { ImageViewer } from "../components/ImageViewer";
import { StarRating } from "../components/StarRating";
import { GpuDiffDialog } from "../components/GpuDiffDialog";
import { ModeTabs } from "../components/ModeTabs";
import { useStore } from "../store";
import { useMaskSuppressed } from "../lib/useMaskSuppressed";
import { BasicPanel } from "../panels/BasicPanel";
import { CurvePanel } from "../panels/CurvePanel";
import { DetailPanel } from "../panels/DetailPanel";
import { EffectsPanel } from "../panels/EffectsPanel";
import { GeometryPanel } from "../panels/GeometryPanel";
import { HSLPanel } from "../panels/HSLPanel";
import { LocalPanel } from "../panels/LocalPanel";
import { HistoryPanel } from "../panels/HistoryPanel";
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
  // Pendant le réglage (et un court instant après), on ne cuit pas l'overlay du masque dans le
  // JPEG serveur : on voit l'effet du réglage. Le « linger » couvre les clics rapides.
  const maskSuppressed = useMaskSuppressed();
  const cropEdit = useStore((s) => s.activeTool === "crop");
  const [src, setSrc] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number>();

  // Au changement de photo : afficher tout de suite la preview JPEG en cache (instantanée)
  // pendant que la base RAW décode côté serveur (~plusieurs secondes au 1er accès). Le rendu
  // HD ci-dessous la remplace dès qu'il est prêt. Volontairement déclenché par le seul
  // `currentId` (pas par les edits) pour ne pas écraser le rendu courant pendant le réglage.
  useEffect(() => {
    if (currentId === null) return;
    const v = useStore.getState().editsVersion[currentId] ?? 0;
    const placeholder = api.previewUrl(currentId, v);
    setSrc((old) => { if (old?.startsWith("blob:")) URL.revokeObjectURL(old); return placeholder; });
  }, [currentId]);

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
        showMask: showMaskOverlay && selectedLocalId && !maskSuppressed ? selectedLocalId : undefined,
        cropEdit, // en mode recadrage : on affiche l'image entière, l'overlay dessine le cadre
        signal: ctrl.signal,
      })
        .then((url) => setSrc((old) => { if (old?.startsWith("blob:")) URL.revokeObjectURL(old); return url; }))
        .catch((e) => { if ((e as Error).name !== "AbortError") console.error(e); });
    }, delay);
    return () => window.clearTimeout(timerRef.current);
  }, [currentId, edits, beforeAfter, showMaskOverlay, selectedLocalId, isDragging, maskSuppressed, cropEdit]);

  // libération de la dernière URL au démontage
  useEffect(() => () => {
    abortRef.current?.abort();
    setSrc((old) => { if (old?.startsWith("blob:")) URL.revokeObjectURL(old); return null; });
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
  const setUI = useStore((s) => s.setUI);
  const setRating = useStore((s) => s.setRating);
  const copyEdits = useStore((s) => s.copyEdits);
  const pasteEdits = useStore((s) => s.pasteEdits);
  const resetEdits = useStore((s) => s.resetEdits);
  const [gpuPreview, setGpuPreview] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const src = useRenderedImage();

  if (!photo) return <div className="empty-state"><p>Aucune photo sélectionnée.</p></div>;

  return (
    <div className="develop">
      <div className="develop-main">
        <div className="toolbar">
          <ModeTabs />
          <span className="name">{photo.filename}</span>
          {dirty && <span className="dim" title="Sauvegarde automatique en cours">●</span>}
          {(photo.edited || dirty) && <span className="edited-chip" title="Photo retouchée">Modifiée</span>}
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
          <button className={"btn small" + (gpuPreview ? " active" : "")}
            title="Aperçu GPU temps réel (WB, expo, HL/ombres, blancs/noirs, contraste, courbe, HSL, vibrance/sat, clarté, dehaze, réduction de bruit, netteté, vignette)"
            onClick={() => setGpuPreview((v) => !v)}>⚡ GPU</button>
          <button className="btn small" title="Mesurer l'écart aperçu GPU ↔ rendu Python"
            onClick={() => setShowDiff(true)}>Δ</button>
          <button className="btn small" title="Exporter (Ctrl+E)" onClick={() => setUI({ showExport: true })}>⤒</button>
        </div>
        <div className="develop-viewer">
          {edits ? <ImageViewer src={src} interactive gpu={gpuPreview} /> : <div className="viewer-empty">Chargement…</div>}
          {beforeAfter && <div className="before-badge">AVANT</div>}
          {showInfo && <ExifOverlay />}
          <CropBar />
        </div>
        <Filmstrip />
      </div>
      {showDiff && <GpuDiffDialog onClose={() => setShowDiff(false)} />}
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
        <HistoryPanel />
        <MetaPanel />
      </aside>
    </div>
  );
}

const CROP_ASPECTS: [string, number | null][] = [
  ["Libre", null], ["1:1", 1], ["3:2", 3 / 2], ["4:3", 4 / 3], ["16:9", 16 / 9], ["9:16", 9 / 16],
];

/** Barre flottante de ratios de recadrage, visible uniquement quand l'outil crop est actif. */
function CropBar() {
  const activeTool = useStore((s) => s.activeTool);
  const cropAspect = useStore((s) => s.cropAspect);
  const setCropAspect = useStore((s) => s.setCropAspect);
  const setUI = useStore((s) => s.setUI);
  if (activeTool !== "crop") return null;
  return (
    <div className="crop-toolbar">
      <span className="dim">Ratio</span>
      {CROP_ASPECTS.map(([label, ratio]) => (
        <button
          key={label}
          className={"btn small" + (cropAspect === ratio ? " active" : "")}
          onClick={() => setCropAspect(ratio)}
        >
          {label}
        </button>
      ))}
      <button className="btn small primary" onClick={() => setUI({ activeTool: "none" })}>Terminer</button>
    </div>
  );
}
