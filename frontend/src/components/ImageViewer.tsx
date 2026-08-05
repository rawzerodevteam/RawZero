import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { actionForEvent } from "../keybindings";
import { useStore } from "../store";
import { useGpuPreview } from "../gpu/useGpuPreview";
import { useMaskSuppressed } from "../lib/useMaskSuppressed";
import { defaultLocalAdjust, type LocalAdjust } from "../types";
import { ClippingOverlay, CropOverlay, MaskHandles, ShapeOutline } from "./ImageViewerOverlays";

interface Props {
  src: string | null;
  interactive?: boolean;      // outils de développement (masques, crop)
  gpu?: boolean;              // affiche le canvas WebGL (aperçu GPU) au lieu du <img> serveur
  onGpuError?: () => void;    // le contexte GPU a échoué à l'exécution → repli silencieux conseillé
}

interface Box { left: number; top: number; w: number; h: number }

function isTyping(): boolean {
  const el = document.activeElement;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
}

export function ImageViewer({ src, interactive = false, gpu = false, onGpuError }: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [cont, setCont] = useState({ w: 0, h: 0 });
  const [zoomScale, setZoomScale] = useState(1); // 1 = ajusté ; >1 = agrandi (molette)
  const [pan, setPan] = useState({ x: 0, y: 0 });
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
      : l.type === "inpaint"
      ? `${l.id}:${l.type}:${p.strokes?.length ?? 0}:${p.ref}`
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
  // "inpaint" n'est pas un masque de réglage (pas de fondu de valeurs à visualiser, juste une
  // zone remplacée) : la surimpression rouge n'a pas de sens dessus.
  const selectedType = useStore((s) => s.edits?.locals.find((l) => l.id === s.selectedLocalId)?.type);

  // Aperçu GPU : rend dans glCanvasRef ; outil crop actif → image entière (le cadre se dessine par-dessus)
  const maskOverlayId = showMaskOverlay && selectedLocalId && !maskSuppressed && selectedType !== "inpaint" ? selectedLocalId : null;
  const gpuState = useGpuPreview(glCanvasRef, gpu, activeTool === "crop", beforeAfter, showClipping, maskOverlayId);
  const nat = gpu ? gpuState.dims : natural;

  // Repli automatique vers le rendu serveur si le contexte GPU échoue à l'exécution (rare, mais
  // réel maintenant que le GPU est le chemin par défaut pour tout le monde, pas seulement les
  // utilisateurs l'activant sciemment via le menu Avancé).
  useEffect(() => {
    if (gpu && gpuState.error) onGpuError?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpu, gpuState.error]);

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

  // Inverse de toImg pour une DISTANCE (pas un point) : normalisé → pixels écran. Sert à seuiller
  // des gestes (ex. échantillonnage du pinceau) avec une sensibilité constante quel que soit le zoom.
  const toScreenDist = useCallback((dnx: number, dny: number) => Math.hypot(dnx * box.w, dny * box.h), [box.w, box.h]);

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
    // pinceau/correcteur IA : l'outil reste actif pour enchaîner les coups de pinceau sur le
    // même masque sans avoir à le réactiver après chaque trait.
    setUI({ selectedLocalId: local.id, activeTool: local.type === "brush" || local.type === "inpaint" ? local.type : "none" });
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

  // Pipette HSL : désigne la bande la plus proche de la teinte du point cliqué (n'applique
  // rien elle-même, contrairement à la pipette WB — juste un raccourci pour trouver la bande).
  const pickHslBand = async (nx: number, ny: number) => {
    const { currentId, edits, notify } = useStore.getState();
    if (currentId === null || !edits) return;
    setUI({ activeTool: "none" });
    try {
      const { band } = await api.pickHslBand(currentId, edits, nx, ny);
      setUI({ hslPickedBand: band });
      notify(t("viewer.hslPickDone", { band: t(`hsl.band.${band}`) }), "success");
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
    } else if (activeTool === "hsl") {
      void pickHslBand(nx, ny);
    } else if (activeTool === "pointmask") {
      void useStore.getState().createPointMask(nx, ny);
    } else if (activeTool === "linear" || activeTool === "radial") {
      mode.current = "shape";
      setTempShape({ type: activeTool, x0: nx, y0: ny, x1: nx, y1: ny });
    } else if (activeTool === "brush" || activeTool === "inpaint") {
      // Correcteur IA : même geste de peinture que le pinceau de retouche locale (arbitraire,
      // pas de cercle fixe) — la zone peinte est envoyée telle quelle à l'IA au relâchement.
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
    if (mode.current === "shape" && tempShape) {
      setTempShape({ ...tempShape, x1: nx, y1: ny });
    } else if (mode.current === "brush") {
      const last = stroke.current[stroke.current.length - 1];
      // Seuil en pixels ÉCRAN (pas en coordonnées normalisées) : sinon le pas entre deux points
      // du trait grandit avec le zoom (jusqu'à des dizaines de px à 1600 %), et le pinceau devient
      // saccadé/moins précis plus on est zoomé. 2 px écran donne une sensibilité constante.
      if (toScreenDist(nx - last[0], ny - last[1]) > 2) {
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
      const isInpaint = activeTool === "inpaint";
      const newStroke = { points: stroke.current, size: brushSize, erase: brushErase };
      const selected = useStore.getState().edits?.locals.find((l) => l.id === selectedLocalId);
      const kind = isInpaint ? "inpaint" : "brush";
      let targetId = selected && selected.type === kind ? selected.id : "";
      if (targetId) {
        updateEdits((e) => {
          const loc = e.locals.find((l) => l.id === targetId);
          if (loc) (loc.params.strokes = loc.params.strokes ?? []).push(newStroke);
        });
      } else {
        targetId = "loc-" + Date.now().toString(36);
        createLocal({
          id: targetId,
          type: kind,
          params: isInpaint ? { feather: 0.4, opacity: 1, strokes: [newStroke] } : { feather: 0.4, strokes: [newStroke] },
          invert: false,
          adjust: defaultLocalAdjust(),
        });
      }
      stroke.current = [];
      // Correcteur IA : chaque trait relâché redéclenche le calcul (le patch précédent, s'il
      // existe, ne couvre plus la zone peinte étendue).
      if (isInpaint) void useStore.getState().runInpaint(targetId);
    }
    mode.current = "none";
  };

  void selSig; // déclenche le re-rendu quand la géométrie du masque sélectionné change
  const selectedLocal = useStore.getState().edits?.locals.find((l) => l.id === selectedLocalId);

  return (
    <div
      ref={containerRef}
      className={"viewer tool-" + activeTool + (spaceHeld ? " space-pan" : "")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
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
            {!tempShape && selectedLocal &&
              (selectedLocal.type === "linear" || selectedLocal.type === "radial") && (
              <ShapeOutline
                shape={{
                  type: selectedLocal.type === "linear" ? "linear" : "radial",
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
            {/* Poignées d'édition du masque sélectionné (déplacer / redimensionner) — pas pour
                "brush"/"inpaint" (forme libre au pinceau, pas de géométrie paramétrique). */}
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
