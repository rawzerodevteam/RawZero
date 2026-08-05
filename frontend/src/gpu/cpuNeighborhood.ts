/**
 * Port CPU (JS pur, sur image complète) des étages du pipeline GPU qui dépendent d'un flou
 * gaussien (« opérations à voisinage » — cf. TODO.md N12) : HL/ombres, clarté, netteté,
 * défrange, réduction de bruit chroma. Complète `cpuPipeline.ts` (qui ne couvre que les étages
 * per-pixel SANS voisinage) pour permettre un test de parité GPU↔Python sur ces étages.
 *
 * Le flou lui-même (`blurPlane`) mirrore `GpuPipeline.blur()` (méthode privée, non testable
 * directement) : downscale par un facteur FIXE (filtre bilinéaire, comme le sampler LINEAR
 * WebGL), flou séparable avec `gaussianWeights` — réutilisé tel quel depuis `pipeline.ts`, pas
 * réimplémenté — puis upscale bilinéaire. Le bord est géré en CLAMP_TO_EDGE (comme les
 * textures GPU, cf. `pipeline.ts` `gl.CLAMP_TO_EDGE`), à la différence du côté Python qui
 * utilise `cv2.BORDER_REFLECT` — une divergence de bord attendue, pas une erreur de port.
 *
 * Ce n'est PAS une reproduction pixel-exacte de `pipeline.gauss()` (qui downscale par un facteur
 * k dérivé du sigma, alors que le GPU downscale par un facteur fixe par site d'appel) : les deux
 * sont des approximations indépendantes du même flou gaussien plein (cf. commentaire de
 * `pipeline.gauss` côté Python). Le test de parité mesure l'écart entre les deux, il ne vise pas
 * l'égalité stricte.
 */
import { gaussianWeights } from "./pipeline";

export interface Plane { data: Float32Array; w: number; h: number } // 1 canal, row-major
export interface Image { data: Float32Array; w: number; h: number } // 3 canaux RGB entrelacés

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (x: number) => clamp(x, 0, 1);

/** Échantillonnage bilinéaire, bord CLAMP_TO_EDGE (comme les textures GPU), sur un plan mono-canal. */
function sampleBilinear(src: Float32Array, sw: number, sh: number, u: number, v: number): number {
  const x = clamp(u * sw - 0.5, 0, sw - 1);
  const y = clamp(v * sh - 0.5, 0, sh - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
  const fx = x - x0, fy = y - y0;
  const a = src[y0 * sw + x0], b = src[y0 * sw + x1];
  const c = src[y1 * sw + x0], d = src[y1 * sw + x1];
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/** Redimensionne un plan mono-canal par filtrage bilinéaire (mirroir du sampler LINEAR WebGL
 *  utilisé par la passe de downscale/upscale neutre de `GpuPipeline.blur()`). */
function resizePlane(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const v = (y + 0.5) / dh;
    for (let x = 0; x < dw; x++) {
      out[y * dw + x] = sampleBilinear(src, sw, sh, (x + 0.5) / dw, v);
    }
  }
  return out;
}

/** Flou séparable (poids `gaussianWeights`, bord CLAMP_TO_EDGE) sur un plan à résolution fixe. */
function separableBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const { weights, radius } = gaussianWeights(sigma);
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = src[y * w + x] * weights[0];
      for (let i = 1; i <= radius; i++) {
        const xl = clamp(x - i, 0, w - 1), xr = clamp(x + i, 0, w - 1);
        sum += (src[y * w + xl] + src[y * w + xr]) * weights[i];
      }
      tmp[y * w + x] = sum;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = tmp[y * w + x] * weights[0];
      for (let i = 1; i <= radius; i++) {
        const yt = clamp(y - i, 0, h - 1), yb = clamp(y + i, 0, h - 1);
        sum += (tmp[yt * w + x] + tmp[yb * w + x]) * weights[i];
      }
      out[y * w + x] = sum;
    }
  }
  return out;
}

/** Mirroir de `GpuPipeline.blur()` : downscale bilinéaire → flou séparable → upscale bilinéaire. */
export function blurPlane(src: Float32Array, w: number, h: number, sigmaPx: number, downscale: number): Float32Array {
  const dw = Math.max(1, Math.round(w / downscale));
  const dh = Math.max(1, Math.round(h / downscale));
  const sigma = Math.max(sigmaPx / downscale, 0.6);
  const small = downscale === 1 ? src : resizePlane(src, w, h, dw, dh);
  const blurred = separableBlur(small, dw, dh, sigma);
  return downscale === 1 ? blurred : resizePlane(blurred, dw, dh, w, h);
}

export function blurImage(src: Float32Array, w: number, h: number, sigmaPx: number, downscale: number): Float32Array {
  const out = new Float32Array(src.length);
  for (let ch = 0; ch < 3; ch++) {
    const plane = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) plane[i] = src[i * 3 + ch];
    const blurred = blurPlane(plane, w, h, sigmaPx, downscale);
    for (let i = 0; i < w * h; i++) out[i * 3 + ch] = blurred[i];
  }
  return out;
}

const luma3 = (r: number, g: number, b: number) => r * 0.2126 + g * 0.7152 + b * 0.0722;

function lumaPlane(img: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = luma3(img[i * 3], img[i * 3 + 1], img[i * 3 + 2]);
  return out;
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** HL/ombres — miroir de F_TONE (bloc `u_hasHL`) / `_apply_hl_shadows`. */
export function hlShadows(img: Image, highlights: number, shadows: number, sigmaPx: number, downscale = 4): Float32Array {
  const { data, w, h } = img;
  if (!highlights && !shadows) return data;
  const lb = blurPlane(lumaPlane(data, w, h), w, h, sigmaPx, downscale);
  const out = new Float32Array(data.length);
  for (let i = 0; i < w * h; i++) {
    let gain = 1;
    if (highlights) gain *= 2 ** (highlights / 100 * 0.9 * smoothstep(0.35, 0.95, lb[i]) ** 1.2);
    if (shadows) gain *= 2 ** (shadows / 100 * 0.9 * (1 - smoothstep(0.05, 0.65, lb[i])) ** 1.2);
    out[i * 3] = data[i * 3] * gain;
    out[i * 3 + 1] = data[i * 3 + 1] * gain;
    out[i * 3 + 2] = data[i * 3 + 2] * gain;
  }
  return out;
}

/** Clarté — miroir de F_CLARITY / `_apply_clarity`. */
export function clarity(img: Image, amount: number, sigmaPx: number, downscale = 4): Float32Array {
  const { data, w, h } = img;
  if (!amount) return data;
  const l = lumaPlane(data, w, h);
  const lb = blurPlane(l, w, h, sigmaPx, downscale);
  const out = new Float32Array(data.length);
  for (let i = 0; i < w * h; i++) {
    const detail = l[i] - lb[i];
    const mid = 1 - Math.abs(2 * clamp01(l[i]) - 1) ** 2;
    const add = (amount / 100) * 0.9 * detail * mid;
    out[i * 3] = data[i * 3] + add;
    out[i * 3 + 1] = data[i * 3 + 1] + add;
    out[i * 3 + 2] = data[i * 3 + 2] + add;
  }
  return out;
}

/** Netteté (masque flou) — miroir de F_FINAL (bloc `u_sharpen`) / `_apply_sharpen`. */
export function sharpen(img: Image, amount: number, sigmaPx: number, downscale = 1): Float32Array {
  const { data, w, h } = img;
  if (amount <= 0) return data;
  const l = lumaPlane(data, w, h);
  const lb = blurPlane(l, w, h, sigmaPx, downscale);
  const out = new Float32Array(data.length);
  for (let i = 0; i < w * h; i++) {
    const add = (amount / 100) * (l[i] - lb[i]);
    out[i * 3] = data[i * 3] + add;
    out[i * 3 + 1] = data[i * 3 + 1] + add;
    out[i * 3 + 2] = data[i * 3 + 2] + add;
  }
  return out;
}

/** Défrange — miroir de F_DEFRINGE / `_apply_defringe`. */
export function defringe(img: Image, purple: number, green: number, sigmaPx: number, downscale = 1): Float32Array {
  const { data, w, h } = img;
  if (!purple && !green) return data;
  const blurred = blurImage(data, w, h, sigmaPx, downscale);
  const out = new Float32Array(data.length);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
    const l = luma3(r, g, b);
    const bl = luma3(blurred[i * 3], blurred[i * 3 + 1], blurred[i * 3 + 2]);
    const edge = clamp01(Math.abs(l - bl) * 8);
    const pm = clamp01(Math.min(r, b) - g);
    const gm = clamp01(g - Math.max(r, b));
    const fp = clamp01(pm * edge * (purple / 100) * 4);
    const fg = clamp01(gm * edge * (green / 100) * 4);
    const f = Math.max(fp, fg);
    out[i * 3] = r + (l - r) * f;
    out[i * 3 + 1] = g + (l - g) * f;
    out[i * 3 + 2] = b + (l - b) * f;
  }
  return out;
}

/** Réduction de bruit chroma (Cr/Cb lissés en YCrCb, BT.601 delta 0.5) — miroir de F_YCC/F_CHROMA
 *  (`_apply_nr`, branche `nr_color`). */
export function nrChroma(img: Image, sigmaPx: number, downscale = 1): Float32Array {
  const { data, w, h } = img;
  const ycc = new Float32Array(data.length);
  for (let i = 0; i < w * h; i++) {
    const r = clamp01(data[i * 3]), g = clamp01(data[i * 3 + 1]), b = clamp01(data[i * 3 + 2]);
    const y = r * 0.299 + g * 0.587 + b * 0.114;
    ycc[i * 3] = y;
    ycc[i * 3 + 1] = (r - y) * 0.713 + 0.5;
    ycc[i * 3 + 2] = (b - y) * 0.564 + 0.5;
  }
  const blurred = blurImage(ycc, w, h, sigmaPx, downscale);
  const out = new Float32Array(data.length);
  for (let i = 0; i < w * h; i++) {
    const Y = ycc[i * 3];
    const cr = blurred[i * 3 + 1] - 0.5, cb = blurred[i * 3 + 2] - 0.5;
    out[i * 3] = Y + 1.403 * cr;
    out[i * 3 + 1] = Y - 0.714 * cr - 0.344 * cb;
    out[i * 3 + 2] = Y + 1.773 * cb;
  }
  return out;
}
