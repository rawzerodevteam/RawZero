import { describe, expect, it } from "vitest";
import { blurPlane, clarity, defringe, hlShadows, nrChroma, sharpen, type Image } from "../src/gpu/cpuNeighborhood";
import fixtureJson from "./fixtures/parityNeighborhood.json";

/**
 * Régression visuelle GPU↔Python — opérations À VOISINAGE (TODO N12), complète `parity.test.ts`
 * (per-pixel uniquement). Le golden (`backend/tests/test_parity_neighborhood.py` →
 * `fixtures/parityNeighborhood.json`) est produit par le vrai pipeline Python ; ce test rejoue le
 * port JS du flou GPU (`gpu/cpuNeighborhood.ts`, downscale FIXE + bord CLAMP) sur les MÊMES champs
 * synthétiques déterministes (recalculés ici depuis la formule miroir de `_synth_plane`, aucune
 * donnée d'entrée sérialisée) et compare les résultats réduits par bloc.
 *
 * Tolérance volontairement large (0.10, ~25/255) : `pipeline.gauss()` (downscale par un facteur k
 * dérivé du sigma, bord REFLECT) et `GpuPipeline.blur()` (downscale FIXE par site d'appel, bord
 * CLAMP) sont deux approximations INDÉPENDANTES du même flou gaussien plein, pas deux ports d'un
 * seul algorithme — cf. commentaire de `pipeline.gauss` et de `cpuNeighborhood.ts`. Ce test mesure
 * l'écart, il ne prouve pas l'exactitude pixel à pixel (cf. TODO.md N12). Écarts mesurés (marge
 * ~30 % au-dessus dans TOL) : primitif de flou seul 0.016–0.076 (pire cas à σ=25, régime où
 * Python choisit k=3 mais le GPU downscale toujours ×4 — la divergence de STRATÉGIE de downscale,
 * pas une erreur de port) ; HL/ombres/clarté/défrange/netteté ≤ 0.013 ; NR chroma 0.046.
 */

function synthPlane(w: number, h: number, phase = 0): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ny = y / h;
    for (let x = 0; x < w; x++) {
      const nx = x / w;
      let val = 0.5 + 0.35 * Math.sin(nx * 23.0 + phase) * Math.cos(ny * 17.0 + phase * 0.5);
      const dist = Math.hypot(nx - 0.5, ny - 0.5);
      if (dist < 0.15) val += 0.2;
      out[y * w + x] = Math.min(1, Math.max(0, val));
    }
  }
  return out;
}

function synthImage(w: number, h: number): Image {
  const r = synthPlane(w, h, 0), g = synthPlane(w, h, 2.1), b = synthPlane(w, h, 4.2);
  const data = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { data[i * 3] = r[i]; data[i * 3 + 1] = g[i]; data[i * 3 + 2] = b[i]; }
  return { data, w, h };
}

/** Miroir exact de `_block_avg` (Python) : moyenne par blocs n×n, ordre (by, bx[, c]). */
function blockAvgPlane(src: Float32Array, w: number, h: number, n: number): number[] {
  const bh = h / n, bw = w / n;
  const out: number[] = [];
  for (let by = 0; by < n; by++) for (let bx = 0; bx < n; bx++) {
    let sum = 0;
    for (let y = by * bh; y < (by + 1) * bh; y++) for (let x = bx * bw; x < (bx + 1) * bw; x++) sum += src[y * w + x];
    out.push(sum / (bh * bw));
  }
  return out;
}

function blockAvgImage(src: Float32Array, w: number, h: number, n: number): number[] {
  const bh = h / n, bw = w / n;
  const out: number[] = [];
  for (let by = 0; by < n; by++) for (let bx = 0; bx < n; bx++) for (let c = 0; c < 3; c++) {
    let sum = 0;
    for (let y = by * bh; y < (by + 1) * bh; y++) for (let x = bx * bw; x < (bx + 1) * bw; x++) sum += src[(y * w + x) * 3 + c];
    out.push(sum / (bh * bw));
  }
  return out;
}

function flatten(a: any): number[] {
  return Array.isArray(a) ? a.flatMap(flatten) : [a];
}

interface Case { kind: string; name: string; size: number; down: number; output: number[]; sigma?: number; params?: any; }
const fixture = fixtureJson as unknown as { cases: Case[] };
const TOL = 0.1;

describe("régression visuelle GPU↔Python — opérations à voisinage (TODO N12)", () => {
  it("la fixture est présente et non vide", () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  const REF = 2560;
  const img96 = synthImage(96, 96);
  const plane256 = synthPlane(256, 256);

  for (const c of fixture.cases) {
    it(`${c.kind} — ${c.name} concorde avec Python (Δ < ${TOL})`, () => {
      const expected = flatten(c.output);
      let got: number[];
      switch (c.kind) {
        case "blur":
          got = blockAvgPlane(blurPlane(plane256, 256, 256, c.sigma!, 4), 256, 256, c.down);
          break;
        case "hlShadows": {
          const p = c.params;
          const out = hlShadows(img96, p.highlights, p.shadows, REF * 0.02, 4);
          got = blockAvgImage(out, 96, 96, c.down);
          break;
        }
        case "clarity": {
          const out = clarity(img96, c.params.clarity, Math.max(8, REF * 0.012), 4);
          got = blockAvgImage(out, 96, 96, c.down);
          break;
        }
        case "sharpen": {
          const p = c.params;
          const out = sharpen(img96, p.amount, Math.max(p.radius * p.scale, 0.4), 1);
          got = blockAvgImage(out, 96, 96, c.down);
          break;
        }
        case "defringe": {
          const p = c.params;
          const out = defringe(img96, p.purple, p.green, Math.max(1.5 * p.scale, 0.6), 1);
          got = blockAvgImage(out, 96, 96, c.down);
          break;
        }
        case "nrChroma": {
          const p = c.params;
          const sigma = (1 + 7 * p.nr_color / 100) * Math.max(p.scale, 0.25);
          const out = nrChroma(img96, sigma, 1);
          got = blockAvgImage(out, 96, 96, c.down);
          break;
        }
        default:
          throw new Error(`kind inconnu : ${c.kind}`);
      }
      expect(got.length).toBe(expected.length);
      let maxDiff = 0;
      for (let i = 0; i < got.length; i++) maxDiff = Math.max(maxDiff, Math.abs(got[i] - expected[i]));
      expect(maxDiff).toBeLessThan(TOL);
    });
  }
});
