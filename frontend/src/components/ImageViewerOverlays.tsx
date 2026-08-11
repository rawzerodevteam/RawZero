import { useEffect, useRef } from "react";
import { useStore } from "../store";

/** Overlays SVG/Canvas du visualiseur de développement — extrait de `ImageViewer.tsx` (TODO N11) :
 *  sous-composants autonomes (props uniquement, pas de fermeture sur l'état local du viewer). */

export function ShapeOutline({ shape, params, w, h }: {
  shape: { type: "linear" | "radial" | "light"; x0: number; y0: number; x1: number; y1: number } | null;
  params?: Record<string, any>;
  w: number; h: number;
}) {
  if (!shape) return null;
  if (shape.type === "radial" || shape.type === "light") {
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
export function MaskHandles({ localId, kind, params, w, h, toImg, updateEdits, startDrag, endDrag }: {
  localId: string;
  kind: "linear" | "radial" | "light" | "inpaint";
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
export function ClippingOverlay({ src }: { src: string }) {
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
export function CropOverlay({ w, h }: { w: number; h: number }) {
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
