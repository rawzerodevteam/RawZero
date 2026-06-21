import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "../store";

const W = 252, H = 200, PAD = 8;

/** Interpolation monotone (Fritsch–Carlson), miroir du backend pour l'aperçu. */
function pchipSample(points: [number, number][], n = 120): [number, number][] {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) return [[0, 0], [1, 1]];
  const x = pts.map((p) => p[0]), y = pts.map((p) => p[1]);
  const m = pts.length - 1;
  const h: number[] = [], slope: number[] = [];
  for (let i = 0; i < m; i++) {
    h.push(Math.max(x[i + 1] - x[i], 1e-6));
    slope.push((y[i + 1] - y[i]) / Math.max(x[i + 1] - x[i], 1e-6));
  }
  const d = new Array(pts.length).fill(0);
  d[0] = slope[0];
  d[m] = slope[m - 1];
  for (let i = 1; i < m; i++) {
    if (slope[i - 1] * slope[i] <= 0) d[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
      d[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
    }
  }
  const out: [number, number][] = [];
  for (let k = 0; k <= n; k++) {
    const xv = k / n;
    let i = 0;
    while (i < m - 1 && xv > x[i + 1]) i++;
    const t = Math.min(Math.max((xv - x[i]) / h[i], 0), 1);
    const t2 = t * t, t3 = t2 * t;
    const yv = (2 * t3 - 3 * t2 + 1) * y[i] + (t3 - 2 * t2 + t) * h[i] * d[i] +
               (-2 * t3 + 3 * t2) * y[i + 1] + (t3 - t2) * h[i] * d[i + 1];
    out.push([xv, Math.min(Math.max(yv, 0), 1)]);
  }
  return out;
}

const toSvg = (p: [number, number]): [number, number] =>
  [PAD + p[0] * (W - 2 * PAD), H - PAD - p[1] * (H - 2 * PAD)];
const fromSvg = (sx: number, sy: number): [number, number] => [
  Math.min(Math.max((sx - PAD) / (W - 2 * PAD), 0), 1),
  Math.min(Math.max((H - PAD - sy) / (H - 2 * PAD), 0), 1),
];

const CHANNELS = [
  { key: "points", label: "curve.ch.rgb", color: "#d8d8d8" },
  { key: "r", label: "curve.ch.r", color: "#e5484d" },
  { key: "g", label: "curve.ch.g", color: "#5bb98b" },
  { key: "b", label: "curve.ch.b", color: "#5b8def" },
] as const;
type ChannelKey = (typeof CHANNELS)[number]["key"];

export function CurveEditor() {
  const { t } = useTranslation();
  const [channel, setChannel] = useState<ChannelKey>("points");
  const points = useStore((s) => s.edits?.curve[channel]) ?? [[0, 0], [1, 1]] as [number, number][];
  const updateEdits = useStore((s) => s.updateEdits);
  const startDrag = useStore((s) => s.startDrag);
  const endDrag = useStore((s) => s.endDrag);
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const color = CHANNELS.find((c) => c.key === channel)!.color;

  const svgPoint = (ev: React.PointerEvent): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    return fromSvg(((ev.clientX - r.left) / r.width) * W, ((ev.clientY - r.top) / r.height) * H);
  };

  const setPoint = (idx: number, p: [number, number]) => {
    updateEdits((e) => {
      const pts = e.curve[channel];
      const lo = idx > 0 ? pts[idx - 1][0] + 0.02 : 0;
      const hi = idx < pts.length - 1 ? pts[idx + 1][0] - 0.02 : 1;
      const x = idx === 0 ? 0 : idx === pts.length - 1 ? 1 : Math.min(Math.max(p[0], lo), hi);
      pts[idx] = [x, p[1]];
    }, false);
  };

  const onDown = (ev: React.PointerEvent) => {
    ev.preventDefault();
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    const p = svgPoint(ev);
    const hitIdx = points.findIndex((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.05);
    startDrag();
    if (hitIdx >= 0) {
      setDragIdx(hitIdx);
    } else if (points.length < 12) {
      const idx = points.findIndex((q) => q[0] > p[0]);
      const at = idx < 0 ? points.length - 1 : idx;
      updateEdits((e) => { e.curve[channel].splice(at, 0, p); }, false);
      setDragIdx(at);
    }
  };

  const onMove = (ev: React.PointerEvent) => {
    if (dragIdx === null) return;
    setPoint(dragIdx, svgPoint(ev));
  };

  const onUp = () => {
    if (dragIdx !== null) endDrag();
    setDragIdx(null);
  };

  const removePoint = (idx: number) => {
    if (idx === 0 || idx === points.length - 1) return;
    startDrag();
    updateEdits((e) => { e.curve[channel].splice(idx, 1); }, false);
    endDrag();
  };

  const path = pchipSample(points as [number, number][])
    .map((p, i) => `${i ? "L" : "M"}${toSvg(p)[0].toFixed(1)},${toSvg(p)[1].toFixed(1)}`)
    .join(" ");

  return (
    <>
    <div className="curve-channels">
      {CHANNELS.map((c) => (
        <button
          key={c.key}
          className={"curve-chan" + (channel === c.key ? " active" : "")}
          style={channel === c.key ? { color: c.color, borderColor: c.color } : undefined}
          onClick={() => { setChannel(c.key); setDragIdx(null); }}
        >
          {t(c.label)}
        </button>
      ))}
    </div>
    <svg
      ref={svgRef}
      className="curve-editor"
      viewBox={`0 0 ${W} ${H}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={onUp}
    >
      {[0.25, 0.5, 0.75].map((g) => (
        <g key={g} className="curve-grid">
          <line x1={toSvg([g, 0])[0]} y1={PAD} x2={toSvg([g, 0])[0]} y2={H - PAD} />
          <line x1={PAD} y1={toSvg([0, g])[1]} x2={W - PAD} y2={toSvg([0, g])[1]} />
        </g>
      ))}
      <line className="curve-diag" x1={toSvg([0, 0])[0]} y1={toSvg([0, 0])[1]} x2={toSvg([1, 1])[0]} y2={toSvg([1, 1])[1]} />
      <path className="curve-path" d={path} style={{ stroke: color }} />
      {points.map((p, i) => {
        const [sx, sy] = toSvg(p as [number, number]);
        return (
          <circle
            key={i}
            cx={sx}
            cy={sy}
            r={5}
            className={"curve-pt" + (dragIdx === i ? " drag" : "")}
            style={{ fill: color }}
            onDoubleClick={(ev) => { ev.stopPropagation(); removePoint(i); }}
          />
        );
      })}
    </svg>
    </>
  );
}
