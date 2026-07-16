import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { actionForEvent } from "../keybindings";
import { useStore } from "../store";
import { useGpuPreview } from "../gpu/useGpuPreview";
import { useMaskSuppressed } from "../lib/useMaskSuppressed";
import { defaultLocalAdjust, type LocalAdjust } from "../types";

interface Props {
  src: string | null;
  interactive?: boolean; // outils de développement (masques, crop)
  gpu?: boolean;         // affiche le canvas WebGL (aperçu GPU) au lieu du <img> serveur
}

interface Box { left: number; top: number; w: number; h: number }

function isTyping(): boolean {
  const el = document.activeElement;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
}

export function ImageViewer({ src, interactive = false, gpu = false }: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [cont, setCont] = useState({ w: 0, h: 0 });
  const [zoomScale, setZoomScale] = useState(1); // 1 = ajusté ; >1 = agrandi (molette)
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [tempShape, setTempShape] = useState<{ type: "linear" | "radial"; x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [, setTick] = useState(0);
  const [spaceHeld, setSpaceHeld] = useState(false); // Espace maintenu → déplacement (Krita/Photoshop)
  const spaceRef = useRef(false);                     // lu dans les handlers pointeur (toujours à jour)
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false);
  const zoomMenuRef = useRef<HTMLDivElement>(null);

  const activeTool = useStore((s) => (interactive ? s.activeTool : "none"));
  const showClipping = useStore((s) => interactive && s.showClipping);
  const brushSize = useStore((s) => s.brushSize);
  const brushErase = useStore((s) => s.brushErase);
  const selectedLocalId = useStore((s) => s.selectedLocalId);
  const showMaskOverlay = useStore((s) => interactive && s.showMaskOverlay);
  // Ne PAS s'abonner au tableau `locals` (nouvelle référence à chaque structuredClone → re-render
  // du viewer à chaque tick de slider). On s'abonne uniquement à une SIGNATURE du masque
  // sélectionné (type + géométrie du contour/poignées) : le viewer ne se re-rend que quand ce
  // masque change vraiment (drag d'une poignée), pas pendant un drag de réglage global.
  const selSig = useStore((s) => {
    const l = s.edits?.locals.find((x) => x.id === s.selectedLocalId);
    if (!l) return "";
    const p = l.params;
    return l.type === "linear" || l.type === "radial"
      ? `${l.id}:${l.type}:${p.x0}:${p.y0}:${p.x1}:${p.y1}:${p.cx}:${p.cy}:${p.rx}:${p.ry}:${p.angle}`
      : `${l.id}:${l.type}`;
  });
  const updateEdits = useStore((s) => s.updateEdits);
  const startDrag = useStore((s) => s.startDrag);
  const endDrag = useStore((s) => s.endDrag);
  const setUI = useStore((s) => s.setUI);
  const beforeAfter = useStore((s) => s.beforeAfter);
  // Pendant le drag d'un slider (et un court instant après), on masque l'overlay rouge pour
  // voir l'effet du réglage ; le « linger » couvre aussi les clics rapides.
  const maskSuppressed = useMaskSuppressed();

  // Aperçu GPU : rend dans glCanvasRef ; outil crop actif → image entière (le cadre se dessine par-dessus)
  const maskOverlayId = showMaskOverlay && selectedLocalId && !maskSuppressed ? selectedLocalId : null;
  const gpuState = useGpuPreview(glCanvasRef, gpu, activeTool === "crop", beforeAfter, showClipping, maskOverlayId);
  const nat = gpu ? gpuState.dims : natural;

  const lastPointer = useRef({ x: 0, y: 0 });
  const mode = useRef<"none" | "pan" | "shape" | "brush">("none");
  const panStart = useRef({ x: 0, y: 0, px: 0, py: 0 });
  const stroke = useRef<[number, number][]>([]);

  // Suivi de la taille du conteneur
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCont({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setCont({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Dimensions naturelles du rendu courant (côté serveur ; en GPU elles viennent du canvas)
  useEffect(() => {
    if (gpu || !src) return;
    const img = new Image();
    img.onload = () => setNatural((n) => (n.w !== img.width || n.h !== img.height ? { w: img.width, h: img.height } : n));
    img.src = src;
  }, [src, gpu]);

  // Garde sur les 4 dimensions : si la hauteur du conteneur est momentanément 0 (mesure pas
  // encore faite), cont.h/nat.h vaudrait 0 et l'image collapserait à 0×0 (aperçu « cassé »).
  const fitScale = nat.w && nat.h && cont.w && cont.h
    ? Math.min(cont.w / nat.w, cont.h / nat.h, 3)
    : 1;
  const s = fitScale * zoomScale;
  const dispW = nat.w * s, dispH = nat.h * s;
  const maxPanX = Math.max(0, (dispW - cont.w) / 2);
  const maxPanY = Math.max(0, (dispH - cont.h) / 2);
  const px = Math.min(Math.max(pan.x, -maxPanX), maxPanX);
  const py = Math.min(Math.max(pan.y, -maxPanY), maxPanY);
  const box: Box = { left: (cont.w - dispW) / 2 + px, top: (cont.h - dispH) / 2 + py, w: dispW, h: dispH };

  const toImg = useCallback((clientX: number, clientY: number): [number, number] => {
    const r = containerRef.current!.getBoundingClientRect();
    return [
      Math.min(Math.max((clientX - r.left - box.left) / Math.max(box.w, 1), 0), 1),
      Math.min(Math.max((clientY - r.top - box.top) / Math.max(box.h, 1), 0), 1),
    ];
  }, [box.left, box.top, box.w, box.h]);

  // Zoom centré sur un point écran (cx,cy). targetZoom = facteur relatif à l'ajusté.
  const zoomAt = useCallback((targetZoom: number, clientX?: number, clientY?: number) => {
    if (!nat.w || !cont.w) return;
    const nz = Math.min(Math.max(targetZoom, 1), 16);
    const r = containerRef.current!.getBoundingClientRect();
    const cx = clientX ?? r.left + r.width / 2;
    const cy = clientY ?? r.top + r.height / 2;
    const [nx, ny] = toImg(cx, cy);
    const newS = fitScale * nz;
    const dW = nat.w * newS, dH = nat.h * newS;
    setZoomScale(nz);
    setPan({
      x: (cx - r.left) - nx * dW - (cont.w - dW) / 2,
      y: (cy - r.top) - ny * dH - (cont.h - dH) / 2,
    });
  }, [nat, cont, fitScale, toImg]);

  // Espace / Z / double-clic : bascule ajusté ↔ 100 %
  const toggleZoom = useCallback((clientX?: number, clientY?: number) => {
    const target = zoomScale > 1.001 ? 1 : 1 / Math.max(fitScale, 1e-3);
    zoomAt(target, clientX, clientY);
  }, [zoomScale, fitScale, zoomAt]);

  // Z : bascule de zoom (ajusté ↔ 100 %). Espace (maintenu) : déplacement à la souris,
  // comme dans Krita/Photoshop — Espace + glisser fait défiler l'image, quel que soit l'outil.
  useEffect(() => {
    const setSpace = (on: boolean) => { spaceRef.current = on; setSpaceHeld(on); };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (isTyping()) return;
      const action = actionForEvent(ev);
      if (action === "pan") {
        ev.preventDefault();        // pas de scroll de page ni d'activation d'un bouton focalisé
        if (!ev.repeat) setSpace(true);
      } else if (action === "zoom-toggle") {
        ev.preventDefault();
        toggleZoom(lastPointer.current.x, lastPointer.current.y);
      }
    };
    const onKeyUp = (ev: KeyboardEvent) => { if (actionForEvent(ev) === "pan") setSpace(false); };
    const onBlur = () => setSpace(false); // évite un état « Espace bloqué » si le focus part
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [toggleZoom]);

  // Molette : zoom continu centré sur le curseur (listener natif non-passif)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      if (activeTool === "crop") return; // ne pas gêner le recadrage
      ev.preventDefault();
      zoomAt(zoomScale * Math.exp(-ev.deltaY * 0.0015), ev.clientX, ev.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomScale, activeTool, zoomAt]);

  // Menu de niveaux de zoom : fermeture au clic extérieur / Échap.
  useEffect(() => {
    if (!zoomMenuOpen) return;
    const onDown = (ev: MouseEvent) => { if (zoomMenuRef.current && !zoomMenuRef.current.contains(ev.target as Node)) setZoomMenuOpen(false); };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") setZoomMenuOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [zoomMenuOpen]);

  const createLocal = (local: LocalAdjust) => {
    updateEdits((e) => { e.locals.push(local); });
    setUI({ selectedLocalId: local.id, activeTool: local.type === "brush" ? "brush" : "none" });
  };

  // Pipette balance des blancs : échantillonne le point cliqué côté serveur et applique temp/teinte.
  const pickWhiteBalance = async (nx: number, ny: number) => {
    const { currentId, edits, notify } = useStore.getState();
    if (currentId === null || !edits) return;
    setUI({ activeTool: "none" });
    try {
      const { temp, tint } = await api.pickWhiteBalance(currentId, edits, nx, ny);
      updateEdits((e) => { e.wb.temp = temp; e.wb.tint = tint; }, true, t("viewer.wbHistory"));
      notify(t("viewer.wbDone", {
        temp: `${temp >= 0 ? "+" : ""}${temp}`, tint: `${tint >= 0 ? "+" : ""}${tint}`,
      }), "success");
    } catch (err) {
      notify(t("viewer.wbFailed", { error: String(err) }), "error");
    }
  };

  const onPointerDown = (ev: React.PointerEvent) => {
    if (ev.button !== 0) return;
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
    const [nx, ny] = toImg(ev.clientX, ev.clientY);
    if (spaceRef.current) {
      // Espace maintenu : déplacement prioritaire, peu importe l'outil sélectionné
      mode.current = "pan";
      panStart.current = { x: pan.x, y: pan.y, px: ev.clientX, py: ev.clientY };
    } else if (activeTool === "wb") {
      void pickWhiteBalance(nx, ny);
    } else if (activeTool === "pointmask") {
      void useStore.getState().createPointMask(nx, ny);
    } else if (activeTool === "linear" || activeTool === "radial") {
      mode.current = "shape";
      setTempShape({ type: activeTool, x0: nx, y0: ny, x1: nx, y1: ny });
    } else if (activeTool === "brush") {
      mode.current = "brush";
      stroke.current = [[nx, ny]];
      setTick((t) => t + 1);
    } else if (activeTool !== "crop") {
      mode.current = "pan";
      panStart.current = { x: pan.x, y: pan.y, px: ev.clientX, py: ev.clientY };
    }
  };

  const onPointerMove = (ev: React.PointerEvent) => {
    lastPointer.current = { x: ev.clientX, y: ev.clientY };
    const [nx, ny] = toImg(ev.clientX, ev.clientY);
    setCursor({ x: nx, y: ny });
    if (mode.current === "shape" && tempShape) {
      setTempShape({ ...tempShape, x1: nx, y1: ny });
    } else if (mode.current === "brush") {
      const last = stroke.current[stroke.current.length - 1];
      if (Math.hypot(nx - last[0], ny - last[1]) > 0.004) {
        stroke.current.push([nx, ny]);
        setTick((t) => t + 1);
      }
    } else if (mode.current === "pan") {
      setPan({
        x: panStart.current.x + (ev.clientX - panStart.current.px),
        y: panStart.current.y + (ev.clientY - panStart.current.py),
      });
    }
  };

  const onPointerUp = () => {
    if (mode.current === "shape" && tempShape) {
      const { type, x0, y0, x1, y1 } = tempShape;
      const dist = Math.hypot(x1 - x0, y1 - y0);
      if (dist > 0.01) {
        const id = "loc-" + Date.now().toString(36);
        const params = type === "linear"
          ? { x0, y0, x1, y1 }
          : { cx: x0, cy: y0, rx: Math.max(Math.abs(x1 - x0), 0.04), ry: Math.max(Math.abs(y1 - y0), 0.04), angle: 0, feather: 0.5 };
        createLocal({ id, type, params, invert: false, adjust: defaultLocalAdjust() });
      }
      setTempShape(null);
    } else if (mode.current === "brush" && stroke.current.length) {
      const newStroke = { points: stroke.current, size: brushSize, erase: brushErase };
      const selected = useStore.getState().edits?.locals.find((l) => l.id === selectedLocalId);
      if (selected && selected.type === "brush") {
        updateEdits((e) => {
          const loc = e.locals.find((l) => l.id === selectedLocalId);
          if (loc) (loc.params.strokes = loc.params.strokes ?? []).push(newStroke);
        });
      } else {
        createLocal({
          id: "loc-" + Date.now().toString(36),
          type: "brush",
          params: { feather: 0.4, strokes: [newStroke] },
          invert: false,
          adjust: defaultLocalAdjust(),
        });
      }
      stroke.current = [];
    }
    mode.current = "none";
  };

  void selSig; // déclenche le re-rendu quand la géométrie du masque sélectionné change
  const selectedLocal = useStore.getState().edits?.locals.find((l) => l.id === selectedLocalId);
  const brushCursorR = brushSize * 0.5 * Math.max(dispW, dispH);

  return (
    <div
      ref={containerRef}
      className={"viewer tool-" + activeTool + (spaceHeld ? " space-pan" : "")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => { setCursor(null); onPointerUp(); }}
      onDoubleClick={(ev) => activeTool === "none" && toggleZoom(ev.clientX, ev.clientY)}
    >
      {(gpu || (src && natural.w > 0)) && (
        <div className="viewer-box" style={{ left: box.left, top: box.top, width: box.w, height: box.h }}>
          {gpu
            ? <canvas ref={glCanvasRef} className="gl-canvas" style={{ width: "100%", height: "100%", display: "block" }} />
            : <img src={src!} alt="" draggable={false} style={{ width: "100%", height: "100%" }} />}
          {!gpu && showClipping && src && <ClippingOverlay src={src} />}
          <svg className="viewer-overlay" viewBox={`0 0 ${box.w} ${box.h}`} preserveAspectRatio="none">
            <ShapeOutline shape={tempShape} w={box.w} h={box.h} />
            {!tempShape && selectedLocal && (selectedLocal.type === "linear" || selectedLocal.type === "radial") && (
              <ShapeOutline
                shape={{
                  type: selectedLocal.type,
                  x0: selectedLocal.params.x0 ?? selectedLocal.params.cx ?? 0.5,
                  y0: selectedLocal.params.y0 ?? selectedLocal.params.cy ?? 0.5,
                  x1: selectedLocal.params.x1 ?? 0,
                  y1: selectedLocal.params.y1 ?? 0,
                }}
                params={selectedLocal.params}
                w={box.w}
                h={box.h}
              />
            )}
            {/* Poignées d'édition du masque sélectionné (déplacer / redimensionner) */}
            {!tempShape && activeTool === "none" && selectedLocal &&
              (selectedLocal.type === "linear" || selectedLocal.type === "radial") && (
              <MaskHandles
                key={selectedLocal.id}
                localId={selectedLocal.id}
                kind={selectedLocal.type}
                params={selectedLocal.params}
                w={box.w} h={box.h}
                toImg={toImg}
                updateEdits={updateEdits}
                startDrag={startDrag}
                endDrag={endDrag}
              />
            )}
            {mode.current === "brush" && stroke.current.length > 1 && (
              <polyline
                className="stroke-preview"
                points={stroke.current.map((p) => `${p[0] * box.w},${p[1] * box.h}`).join(" ")}
                strokeWidth={brushSize * Math.max(box.w, box.h)}
              />
            )}
          </svg>
          {activeTool === "crop" && <CropOverlay w={box.w} h={box.h} />}
          {activeTool === "brush" && cursor && (
            <div
              className="brush-cursor"
              style={{
                left: cursor.x * box.w - brushCursorR,
                top: cursor.y * box.h - brushCursorR,
                width: brushCursorR * 2,
                height: brushCursorR * 2,
              }}
            />
          )}
        </div>
      )}
      {gpu && gpuState.error && <div className="viewer-empty">{t("viewer.gpuUnavailable", { error: gpuState.error })}</div>}
      {gpu && !gpuState.error && !gpuState.ready && <div className="viewer-empty">{t("viewer.loadingBase")}</div>}
      {!gpu && !src && <div className="viewer-empty">{t("common.loading")}</div>}
      <div className="zoom-indicator" ref={zoomMenuRef}>
        <button onClick={(ev) => { ev.stopPropagation(); setZoomMenuOpen((v) => !v); }}>
          {zoomScale <= 1.001 ? t("viewer.fitted") : Math.round(s * 100) + " %"}
        </button>
        {zoomMenuOpen && (
          <div className="zoom-menu" onPointerDown={(ev) => ev.stopPropagation()}>
            <button onClick={() => { zoomAt(1); setZoomMenuOpen(false); }}>{t("viewer.fitted")}</button>
            <button onClick={() => { zoomAt(1 / Math.max(fitScale, 1e-3)); setZoomMenuOpen(false); }}>100 %</button>
            <button onClick={() => { zoomAt(2 / Math.max(fitScale, 1e-3)); setZoomMenuOpen(false); }}>200 %</button>
          </div>
        )}
      </div>
    </div>
  );
}

function ShapeOutline({ shape, params, w, h }: {
  shape: { type: "linear" | "radial"; x0: number; y0: number; x1: number; y1: number } | null;
  params?: Record<string, any>;
  w: number; h: number;
}) {
  if (!shape) return null;
  if (shape.type === "radial") {
    const rx = (params?.rx ?? Math.max(Math.abs(shape.x1 - shape.x0), 0.04)) * w;
    const ry = (params?.ry ?? Math.max(Math.abs(shape.y1 - shape.y0), 0.04)) * h;
    return <ellipse className="mask-outline" cx={shape.x0 * w} cy={shape.y0 * h} rx={rx} ry={ry} />;
  }
  const x0 = shape.x0 * w, y0 = shape.y0 * h, x1 = shape.x1 * w, y1 = shape.y1 * h;
  let dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  const px = -dy * 4000, py = dx * 4000;
  return (
    <g>
      <line className="mask-outline" x1={x0 - px} y1={y0 - py} x2={x0 + px} y2={y0 + py} />
      <line className="mask-outline dashed" x1={x1 - px} y1={y1 - py} x2={x1 + px} y2={y1 + py} />
      <line className="mask-outline thin" x1={x0} y1={y0} x2={x1} y2={y1} />
    </g>
  );
}

/** Poignées interactives pour déplacer / redimensionner un masque linéaire ou radial.
 *  Rendu dans le <svg> d'overlay (pointer-events réactivés par .mask-handle en CSS). */
function MaskHandles({ localId, kind, params, w, h, toImg, updateEdits, startDrag, endDrag }: {
  localId: string;
  kind: "linear" | "radial";
  params: Record<string, any>;
  w: number; h: number;
  toImg: (cx: number, cy: number) => [number, number];
  updateEdits: (fn: (e: any) => void, commit?: boolean) => void;
  startDrag: () => void;
  endDrag: () => void;
}) {
  const dragKind = useRef<string | null>(null);

  const apply = (part: string, nx: number, ny: number) => {
    updateEdits((e: any) => {
      const loc = e.locals.find((l: any) => l.id === localId);
      if (!loc) return;
      const p = loc.params;
      if (kind === "linear") {
        if (part === "p0") { p.x0 = nx; p.y0 = ny; }
        else { p.x1 = nx; p.y1 = ny; }
      } else {
        const cx = p.cx ?? 0.5, cy = p.cy ?? 0.5;
        if (part === "center") { p.cx = nx; p.cy = ny; }
        else if (part === "rx") p.rx = Math.max(Math.abs(nx - cx), 0.02);
        else if (part === "ry") p.ry = Math.max(Math.abs(ny - cy), 0.02);
      }
    }, false);
  };

  const onDown = (part: string) => (ev: React.PointerEvent) => {
    ev.stopPropagation();
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
    dragKind.current = part;
    startDrag();
  };
  const onMove = (ev: React.PointerEvent) => {
    if (!dragKind.current) return;
    ev.stopPropagation();
    const [nx, ny] = toImg(ev.clientX, ev.clientY);
    apply(dragKind.current, nx, ny);
  };
  const onUp = (ev: React.PointerEvent) => {
    if (!dragKind.current) return;
    ev.stopPropagation();
    dragKind.current = null;
    endDrag();
  };

  // Points de manipulation en coordonnées écran.
  let handles: { part: string; x: number; y: number }[];
  if (kind === "linear") {
    const x0 = (params.x0 ?? 0.5) * w, y0 = (params.y0 ?? 0.2) * h;
    const x1 = (params.x1 ?? 0.5) * w, y1 = (params.y1 ?? 0.8) * h;
    handles = [{ part: "p0", x: x0, y: y0 }, { part: "p1", x: x1, y: y1 }];
  } else {
    const cx = (params.cx ?? 0.5), cy = (params.cy ?? 0.5);
    const rx = params.rx ?? 0.25, ry = params.ry ?? 0.25;
    handles = [
      { part: "center", x: cx * w, y: cy * h },
      { part: "rx", x: (cx + rx) * w, y: cy * h },
      { part: "ry", x: cx * w, y: (cy + ry) * h },
    ];
  }

  return (
    <g onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
      {handles.map((hd) => (
        <circle
          key={hd.part}
          className={"mask-handle" + (hd.part === "center" || hd.part.startsWith("p") ? " move" : "")}
          cx={hd.x} cy={hd.y} r={7}
          onPointerDown={onDown(hd.part)}
        />
      ))}
    </g>
  );
}

/** Surimpression rouge/bleu des pixels écrêtés (hautes lumières / ombres). */
function ClippingOverlay({ src }: { src: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const cv = ref.current;
      if (!cv) return;
      cv.width = img.width;
      cv.height = img.height;
      const ctx = cv.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      const id = ctx.getImageData(0, 0, cv.width, cv.height);
      const d = id.data;
      // Écrêtage PAR CANAL (comme Lightroom) : un pixel saturé sur un seul canal (rouge cramé,
      // typique) est signalé, pas seulement le blanc pur. Code couleur = canaux écrêtés
      // (rouge/vert/bleu → primaires, combinaisons → jaune/magenta/cyan, les trois → blanc).
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const hi = (r >= 254 ? 4 : 0) | (g >= 254 ? 2 : 0) | (b >= 254 ? 1 : 0);
        const lo = r <= 1 || g <= 1 || b <= 1;   // écrêtage ombres : au moins un canal à zéro
        if (hi) {
          // masque de canaux → couleur d'alerte hautes lumières
          d[i] = hi & 4 ? 255 : 40;
          d[i + 1] = hi & 2 ? 255 : 40;
          d[i + 2] = hi & 1 ? 255 : 40;
          d[i + 3] = 255;
        } else if (lo) { d[i] = 50; d[i + 1] = 90; d[i + 2] = 235; d[i + 3] = 255; }
        else d[i + 3] = 0;
      }
      ctx.putImageData(id, 0, 0);
    };
    img.src = src;
  }, [src]);
  return <canvas ref={ref} className="clip-canvas" />;
}

/** Outil de recadrage : rectangle + poignées + règle des tiers. */
function CropOverlay({ w, h }: { w: number; h: number }) {
  const crop = useStore((s) => s.edits?.geometry.crop) ?? { x: 0, y: 0, w: 1, h: 1 };
  const cropAspect = useStore((s) => s.cropAspect);
  const updateEdits = useStore((s) => s.updateEdits);
  const startDrag = useStore((s) => s.startDrag);
  const endDrag = useStore((s) => s.endDrag);
  const drag = useRef<{ kind: string; sx: number; sy: number; c: typeof crop } | null>(null);

  const onDown = (kind: string) => (ev: React.PointerEvent) => {
    ev.stopPropagation();
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
    startDrag();
    drag.current = { kind, sx: ev.clientX, sy: ev.clientY, c: { ...crop } };
  };

  const onMove = (ev: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    ev.stopPropagation();
    const dx = (ev.clientX - d.sx) / w;
    const dy = (ev.clientY - d.sy) / h;
    updateEdits((e) => {
      const c = e.geometry.crop;
      const MIN = 0.05;
      let { x, y, w: cw, h: ch } = d.c;
      if (d.kind === "move") {
        x = Math.min(Math.max(x + dx, 0), 1 - cw);
        y = Math.min(Math.max(y + dy, 0), 1 - ch);
      } else {
        if (d.kind.includes("e")) cw = Math.min(Math.max(cw + dx, MIN), 1 - x);
        if (d.kind.includes("s")) ch = Math.min(Math.max(ch + dy, MIN), 1 - y);
        if (d.kind.includes("w")) {
          const nx = Math.min(Math.max(x + dx, 0), x + cw - MIN);
          cw = cw + (x - nx); x = nx;
        }
        if (d.kind.includes("n")) {
          const ny = Math.min(Math.max(y + dy, 0), y + ch - MIN);
          ch = ch + (y - ny); y = ny;
        }
        if (cropAspect) { // verrouillage du ratio (en pixels affichés)
          const targetH = (cw * w) / cropAspect / h;
          if (y + targetH <= 1 && targetH >= MIN) ch = targetH;
          else { ch = Math.min(1 - y, ch); cw = (ch * h * cropAspect) / w; }
        }
      }
      Object.assign(c, { x, y, w: cw, h: ch });
    }, false);
  };

  const onUp = (ev: React.PointerEvent) => {
    if (drag.current) { ev.stopPropagation(); endDrag(); }
    drag.current = null;
  };

  const X = crop.x * w, Y = crop.y * h, CW = crop.w * w, CH = crop.h * h;
  const handles: [string, number, number][] = [
    ["nw", X, Y], ["n", X + CW / 2, Y], ["ne", X + CW, Y],
    ["e", X + CW, Y + CH / 2], ["se", X + CW, Y + CH],
    ["s", X + CW / 2, Y + CH], ["sw", X, Y + CH], ["w", X, Y + CH / 2],
  ];
  return (
    <div className="crop-overlay" onPointerMove={onMove} onPointerUp={onUp}>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <path
          className="crop-shade"
          fillRule="evenodd"
          d={`M0,0H${w}V${h}H0Z M${X},${Y}H${X + CW}V${Y + CH}H${X}Z`}
        />
        <rect className="crop-rect" x={X} y={Y} width={CW} height={CH} onPointerDown={onDown("move")} />
        {[1, 2].map((i) => (
          <g key={i} className="crop-thirds">
            <line x1={X + (CW * i) / 3} y1={Y} x2={X + (CW * i) / 3} y2={Y + CH} />
            <line x1={X} y1={Y + (CH * i) / 3} x2={X + CW} y2={Y + (CH * i) / 3} />
          </g>
        ))}
        {handles.map(([k, hx, hy]) => (
          <rect
            key={k}
            className="crop-handle"
            x={hx - 6}
            y={hy - 6}
            width={12}
            height={12}
            style={{ cursor: `${k}-resize` }}
            onPointerDown={onDown(k)}
          />
        ))}
      </svg>
    </div>
  );
}
