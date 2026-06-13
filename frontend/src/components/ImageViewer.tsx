import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { defaultLocalAdjust, type LocalAdjust } from "../types";

interface Props {
  src: string | null;
  interactive?: boolean; // outils de développement (masques, crop)
}

interface Box { left: number; top: number; w: number; h: number }

function isTyping(): boolean {
  const el = document.activeElement;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
}

export function ImageViewer({ src, interactive = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [cont, setCont] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState<"fit" | "100">("fit");
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [tempShape, setTempShape] = useState<{ type: "linear" | "radial"; x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [, setTick] = useState(0);

  const activeTool = useStore((s) => (interactive ? s.activeTool : "none"));
  const showClipping = useStore((s) => interactive && s.showClipping);
  const brushSize = useStore((s) => s.brushSize);
  const brushErase = useStore((s) => s.brushErase);
  const selectedLocalId = useStore((s) => s.selectedLocalId);
  const locals = useStore((s) => s.edits?.locals);
  const updateEdits = useStore((s) => s.updateEdits);
  const setUI = useStore((s) => s.setUI);

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

  // Dimensions naturelles du rendu courant
  useEffect(() => {
    if (!src) return;
    const img = new Image();
    img.onload = () => setNatural((n) => (n.w !== img.width || n.h !== img.height ? { w: img.width, h: img.height } : n));
    img.src = src;
  }, [src]);

  const fitScale = natural.w && cont.w
    ? Math.min(cont.w / natural.w, cont.h / natural.h, 3)
    : 1;
  const s = zoom === "fit" ? fitScale : 1;
  const dispW = natural.w * s, dispH = natural.h * s;
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

  const toggleZoom = useCallback((clientX?: number, clientY?: number) => {
    if (zoom === "100") { setZoom("fit"); setPan({ x: 0, y: 0 }); return; }
    if (!natural.w) return;
    const r = containerRef.current!.getBoundingClientRect();
    const cx = clientX ?? r.left + r.width / 2;
    const cy = clientY ?? r.top + r.height / 2;
    const [nx, ny] = toImg(cx, cy);
    const relX = cx - r.left, relY = cy - r.top;
    setZoom("100");
    setPan({
      x: relX - nx * natural.w - (cont.w - natural.w) / 2,
      y: relY - ny * natural.h - (cont.h - natural.h) / 2,
    });
  }, [zoom, natural, cont, toImg]);

  // Espace / Z : bascule de zoom (navigation dans l'image)
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (isTyping()) return;
      if (ev.key === " " || ev.key.toLowerCase() === "z") {
        ev.preventDefault();
        toggleZoom(lastPointer.current.x, lastPointer.current.y);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleZoom]);

  const createLocal = (local: LocalAdjust) => {
    updateEdits((e) => { e.locals.push(local); });
    setUI({ selectedLocalId: local.id, activeTool: local.type === "brush" ? "brush" : "none" });
  };

  const onPointerDown = (ev: React.PointerEvent) => {
    if (ev.button !== 0) return;
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
    const [nx, ny] = toImg(ev.clientX, ev.clientY);
    if (activeTool === "linear" || activeTool === "radial") {
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
      const selected = locals?.find((l) => l.id === selectedLocalId);
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

  const selectedLocal = locals?.find((l) => l.id === selectedLocalId);
  const brushCursorR = brushSize * 0.5 * Math.max(dispW, dispH);

  return (
    <div
      ref={containerRef}
      className={"viewer tool-" + activeTool}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => { setCursor(null); onPointerUp(); }}
      onDoubleClick={(ev) => activeTool === "none" && toggleZoom(ev.clientX, ev.clientY)}
    >
      {src && natural.w > 0 && (
        <div className="viewer-box" style={{ left: box.left, top: box.top, width: box.w, height: box.h }}>
          <img src={src} alt="" draggable={false} style={{ width: "100%", height: "100%" }} />
          {showClipping && <ClippingOverlay src={src} />}
          <svg className="viewer-overlay" viewBox={`0 0 ${box.w} ${box.h}`} preserveAspectRatio="none">
            <ShapeOutline shape={tempShape} w={box.w} h={box.h} />
            {!tempShape && selectedLocal && selectedLocal.type !== "brush" && (
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
      {!src && <div className="viewer-empty">Chargement…</div>}
      <div className="zoom-indicator">{zoom === "fit" ? "Ajusté" : "100 %"}</div>
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
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (r >= 250 && g >= 250 && b >= 250) { d[i] = 235; d[i + 1] = 40; d[i + 2] = 40; d[i + 3] = 255; }
        else if (r <= 4 && g <= 4 && b <= 4) { d[i] = 50; d[i + 1] = 90; d[i + 2] = 235; d[i + 3] = 255; }
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
