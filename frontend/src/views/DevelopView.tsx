import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { Filmstrip } from "../components/Filmstrip";
import { Histogram } from "../components/Histogram";
import { ImageViewer } from "../components/ImageViewer";
import { StarRating } from "../components/StarRating";
import { GpuDiffDialog } from "../components/GpuDiffDialog";
import { ModeTabs } from "../components/ModeTabs";
import { useStore } from "../store";
import { useMaskSuppressed } from "../lib/useMaskSuppressed";
import { CROP_ASPECTS } from "../lib/cropAspects";
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

/** Rendu interactif : deux vitesses (drag rapide 768px, idle haute qualité 2048px).
 *
 * `gpuActive` : en mode GPU, le canvas WebGL donne déjà le retour live → inutile de cuire un
 * JPEG serveur À CHAQUE tick. Pire : chaque rendu terminé recharge une image + recalcule
 * l'histogramme (getImageData + boucle ~43k px + décodage JPEG) sur le thread principal, en
 * boucle pendant le drag → ~80 % CPU navigateur. On saute donc le rendu serveur PENDANT le
 * drag en mode GPU ; il repart au relâchement (l'histogramme et le rendu HD se mettent à jour
 * quand on lâche le slider). En mode serveur (GPU off), comportement inchangé. */
function useRenderedImage(gpuActive: boolean): string | null {
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
    // Mode GPU : pas de rendu serveur pendant le drag (le canvas WebGL suffit). On annule un
    // éventuel rendu en vol et on attend le relâchement (isDragging repassera à false → effet
    // relancé) pour rafraîchir histogramme + image HD.
    if (gpuActive && isDragging) { window.clearTimeout(timerRef.current); abortRef.current?.abort(); return; }
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
  }, [currentId, edits, beforeAfter, showMaskOverlay, selectedLocalId, isDragging, maskSuppressed, cropEdit, gpuActive]);

  // libération de la dernière URL au démontage
  useEffect(() => () => {
    abortRef.current?.abort();
    setSrc((old) => { if (old?.startsWith("blob:")) URL.revokeObjectURL(old); return null; });
  }, []);

  return src;
}

export function DevelopView() {
  const { t } = useTranslation();
  const photo = useStore((s) => s.photos.find((p) => p.id === s.currentId));
  const edits = useStore((s) => s.edits);
  const dirty = useStore((s) => s.dirty);
  const beforeAfter = useStore((s) => s.beforeAfter);
  const showClipping = useStore((s) => s.showClipping);
  const showInfo = useStore((s) => s.showInfo);
  const setUI = useStore((s) => s.setUI);
  const setView = useStore((s) => s.setView);
  const setRating = useStore((s) => s.setRating);
  const copyEdits = useStore((s) => s.copyEdits);
  const pasteEdits = useStore((s) => s.pasteEdits);
  const resetEdits = useStore((s) => s.resetEdits);
  const openRelink = useStore((s) => s.openRelink);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.undoStack.length > 0);
  const canRedo = useStore((s) => s.redoStack.length > 0);
  const [gpuPreview, setGpuPreview] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const photos = useStore((s) => s.photos);
  const src = useRenderedImage(gpuPreview);

  if (!photo) return <div className="empty-state"><p>{t("develop.noPhoto")}</p></div>;

  const photoIndex = photos.findIndex((p) => p.id === photo.id);
  const photoTotal = photos.length;

  return (
    <div className="develop">
      <div className="develop-main">
        <div className="toolbar">
          <button className="btn small" title={t("project.homeTitle")} aria-label={t("project.homeTitle")} onClick={() => setView("home")}>🏠</button>
          <ModeTabs />
          <span className="name">{photo.filename}</span>
          {dirty && <span className="dim" title={t("develop.autosaving")}>●</span>}
          {(photo.edited || dirty) && <span className="edited-chip" title={t("develop.editedTitle")}>{t("develop.edited")}</span>}
          <span className="name-index">{photoIndex >= 0 ? t("develop.positionOf", { n: photoIndex + 1, total: photoTotal }) : ""}</span>
          <span className="spacer" />
          <StarRating small value={photo.rating} onChange={setRating} />
          <button className={"btn small" + (beforeAfter ? " active" : "")}
            title={t("develop.beforeAfterTitle")} onClick={() => setUI({ beforeAfter: !beforeAfter })}>
            {beforeAfter ? t("develop.before") : t("develop.after")}
          </button>
          <button className={"btn small" + (showClipping ? " active" : "")}
            title={t("develop.clippingTitle")} aria-label={t("develop.clippingTitle")} onClick={() => setUI({ showClipping: !showClipping })}>
            ▲▼
          </button>
          <button className="btn small" title={t("develop.undoTitle")} aria-label={t("develop.undoTitle")} disabled={!canUndo} onClick={undo}>↶</button>
          <button className="btn small" title={t("develop.redoTitle")} aria-label={t("develop.redoTitle")} disabled={!canRedo} onClick={redo}>↷</button>
          <button className="btn small" title={t("develop.copyTitle")} onClick={copyEdits}>⧉ {t("develop.copy")}</button>
          <button className="btn small" title={t("develop.pasteTitle")} onClick={pasteEdits}>📋 {t("develop.paste")}</button>
          <button className="btn small" title={t("develop.resetTitle")} aria-label={t("develop.resetTitle")} onClick={resetEdits}>↺</button>
          <AdvancedMenu
            show={showAdvanced} setShow={setShowAdvanced}
            gpuPreview={gpuPreview} setGpuPreview={setGpuPreview}
            onDiff={() => { setShowDiff(true); setShowAdvanced(false); }}
          />
          <button className="btn small" title={t("develop.exportTitle")} onClick={() => setUI({ showExport: true })}>⤒</button>
          <button className="btn small" title={t("settings.title")} onClick={() => setView("settings")}>⚙</button>
        </div>
        {photo.missing && (
          <div className="missing-banner">
            <span>{t("relink.developBanner")}</span>
            <button className="btn small" onClick={() => openRelink(photo.id)}>{t("relink.action")}</button>
          </div>
        )}
        <div className="develop-viewer">
          {edits ? <ImageViewer src={src} interactive gpu={gpuPreview} /> : <div className="viewer-empty">{t("common.loading")}</div>}
          {beforeAfter && <div className="before-badge">{t("develop.beforeBadge")}</div>}
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

/** Menu « Avancé » : regroupe les outils de débogage/QA (aperçu GPU, écart GPU↔Python) hors de
 * la barre principale, qui doit rester orientée tâche photo (cf. audit UX §6.2). */
function AdvancedMenu({ show, setShow, gpuPreview, setGpuPreview, onDiff }: {
  show: boolean; setShow: (v: boolean) => void;
  gpuPreview: boolean; setGpuPreview: (fn: (v: boolean) => boolean) => void;
  onDiff: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!show) return;
    const onDown = (ev: MouseEvent) => { if (ref.current && !ref.current.contains(ev.target as Node)) setShow(false); };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") setShow(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [show, setShow]);
  return (
    <div className="advanced-menu" ref={ref}>
      <button className={"btn small" + (show ? " active" : "")} title={t("develop.advancedTitle")}
        onClick={() => setShow(!show)}>⋯</button>
      {show && (
        <div className="advanced-menu-pop">
          <button className={gpuPreview ? "active" : ""} onClick={() => setGpuPreview((v) => !v)}>
            ⚡ {t("develop.gpuLabel")}
          </button>
          <button onClick={onDiff}>Δ {t("develop.diffLabel")}</button>
        </div>
      )}
    </div>
  );
}

/** Barre flottante de ratios de recadrage, visible uniquement quand l'outil crop est actif. */
function CropBar() {
  const { t } = useTranslation();
  const activeTool = useStore((s) => s.activeTool);
  const cropAspect = useStore((s) => s.cropAspect);
  const setCropAspect = useStore((s) => s.setCropAspect);
  const setUI = useStore((s) => s.setUI);
  if (activeTool !== "crop") return null;
  return (
    <div className="crop-toolbar">
      <span className="dim">{t("crop.ratio")}</span>
      {CROP_ASPECTS.map(([label, ratio]) => (
        <button
          key={label}
          className={"btn small" + (cropAspect === ratio ? " active" : "")}
          onClick={() => setCropAspect(ratio)}
        >
          {label === "Libre" ? t("crop.free") : label}
        </button>
      ))}
      <button className="btn small primary" onClick={() => setUI({ activeTool: "none" })}>{t("crop.done")}</button>
    </div>
  );
}
