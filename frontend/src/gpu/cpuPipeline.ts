/**
 * Port CPU (scalaire) de la math des shaders GLSL — pour la régression visuelle (#9).
 *
 * Chaque fonction reproduit *à l'identique* la math d'un étage per-pixel des fragments
 * de `gpu/pipeline.ts`, mais sur un seul pixel en pur JS. Le test `tests/parity.test.ts`
 * la rejoue sur les pixels du golden Python (`tests/fixtures/parity.json`, produit par
 * `backend/tests/test_parity.py`) et vérifie l'accord à ~2/255 près. Toute divergence
 * GLSL↔Python silencieuse casse alors un test.
 *
 * NB : seuls les étages SANS voisinage sont portés (cf. test_parity.py). Les helpers
 * partagés (`wbGains`, `buildCurveTexture`) sont réutilisés tels quels pour éviter toute
 * réimplémentation.
 */
import { wbGains } from "./pipeline";
import { buildCurveTexture } from "./curveLut";

export type RGB = [number, number, number];

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// transferts sRGB↔linéaire — miroir du PRELUDE GLSL (s2l / l2s)
function s2l(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function l2s(c: number): number {
  c = clamp01(c);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
function luma([r, g, b]: RGB): number {
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

// rgb2hsv / hsv2rgb — miroir du PRELUDE GLSL (H en degrés, S/V dans [0,1])
function rgb2hsv([r, g, b]: RGB): RGB {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-10) {
    if (mx === r) h = (((g - b) / d) % 6 + 6) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, mx <= 0 ? 0 : d / mx, mx];
}
function hsv2rgb(h: number, s: number, v: number): RGB {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r: RGB;
  if (h < 60) r = [c, x, 0]; else if (h < 120) r = [x, c, 0];
  else if (h < 180) r = [0, c, x]; else if (h < 240) r = [0, x, c];
  else if (h < 300) r = [x, 0, c]; else r = [c, 0, x];
  return [r[0] + m, r[1] + m, r[2] + m];
}

// 1) linéaire : WB + exposition — miroir de F_LINEAR
function linearStage(px: RGB, p: { temp: number; tint: number; exposure: number }): RGB {
  const [wr, wg, wb] = wbGains(p.temp, p.tint);
  const e = Math.pow(2, p.exposure);
  return [
    l2s(s2l(px[0]) * wr * e),
    l2s(s2l(px[1]) * wg * e),
    l2s(s2l(px[2]) * wb * e),
  ];
}

// 2) blancs / noirs — miroir de F_TONE (étape blancs/noirs, sans clamp)
function whitesBlacks(px: RGB, p: { whites: number; blacks: number }): RGB {
  const wp = 1 - 0.25 * (p.whites / 100);
  const bp = -0.2 * (p.blacks / 100);
  const d = Math.max(wp - bp, 0.05);
  return [(px[0] - bp) / d, (px[1] - bp) / d, (px[2] - bp) / d];
}

// 3) contraste — miroir de contrast1() dans F_TONE (entrée clampée)
function contrast1(xv: number, k: number): number {
  xv = clamp01(xv);
  if (k > 0) { const s = xv * xv * (3 - 2 * xv); return xv + k * (s - xv); }
  return xv + (-k) * ((0.5 + (xv - 0.5) * 0.6) - xv);
}
function contrast(px: RGB, p: { contrast: number }): RGB {
  const k = p.contrast / 100;
  return [contrast1(px[0], k), contrast1(px[1], k), contrast1(px[2], k)];
}

interface Curve { points: [number, number][]; r: [number, number][]; g: [number, number][]; b: [number, number][]; }

// 4) courbe — échantillonne la texture pré-composée comme le filtre LINEAR du GPU
function curve(px: RGB, p: { curve: Curve }): RGB {
  const tex = buildCurveTexture(p.curve);
  if (!tex) return px;
  const n = tex.length / 4;
  const sample = (v: number, ch: number): number => {
    const t = clamp01(v) * n - 0.5;            // centres de texels en (i+0.5)/n
    const i0 = Math.floor(t), f = t - i0;
    const a = Math.min(Math.max(i0, 0), n - 1);
    const b = Math.min(Math.max(i0 + 1, 0), n - 1);
    return (tex[a * 4 + ch] * (1 - f) + tex[b * 4 + ch] * f) / 255;
  };
  return [sample(px[0], 0), sample(px[1], 1), sample(px[2], 2)];
}

// 5) couleur : HSL 8 bandes + vibrance + saturation — miroir de F_TONE (section couleur)
const CENTERS = [0, 30, 60, 120, 180, 240, 280, 320];
const BANDS = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"] as const;
function bandW(hue: number, center: number): number {
  const dist = Math.abs((((hue - center) + 180) % 360 + 360) % 360 - 180);
  return 0.5 * (1 + Math.cos(Math.PI * Math.min(dist / 45, 1)));
}
interface HslBand { h: number; s: number; l: number; }
function color(px: RGB, p: { hsl: Record<string, HslBand>; vibrance: number; saturation: number }): RGB {
  let [h, s, v] = rgb2hsv([clamp01(px[0]), clamp01(px[1]), clamp01(px[2])]);
  const hasHsl = BANDS.some((b) => { const x = p.hsl[b]; return x && (x.h || x.s || x.l); });
  if (hasHsl) {
    let hShift = 0, sMul = 1, vMul = 1;
    BANDS.forEach((name, i) => {
      const b = p.hsl[name];
      if (!b || (!b.h && !b.s && !b.l)) return;
      const w = bandW(h, CENTERS[i]) * Math.min(s * 4, 1);
      hShift += w * (b.h / 100) * 30;
      sMul *= 1 + w * (b.s / 100);
      vMul *= 1 + w * (b.l / 100) * 0.65;
    });
    h = (((h + hShift) % 360) + 360) % 360;
    s *= Math.max(sMul, 0);
    v *= Math.max(vMul, 0);
  }
  if (p.vibrance) {
    const vib = p.vibrance / 100;
    s = vib > 0 ? s * (1 + vib * (1 - s) * 1.2) : s * (1 + vib * 0.85);
  }
  if (p.saturation) s *= 1 + p.saturation / 100;
  return hsv2rgb(h, clamp01(s), clamp01(v));
}

/** Applique l'étage nommé à un pixel (dispatch utilisé par le test de parité). */
export function applyStage(stage: string, px: RGB, params: any): RGB {
  switch (stage) {
    case "linear": return linearStage(px, params);
    case "whitesBlacks": return whitesBlacks(px, params);
    case "contrast": return contrast(px, params);
    case "curve": return curve(px, params);
    case "color": return color(px, params);
    default: throw new Error(`étage inconnu : ${stage}`);
  }
}
