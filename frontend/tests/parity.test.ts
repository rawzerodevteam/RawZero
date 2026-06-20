import { describe, expect, it } from "vitest";
import { applyStage, type RGB } from "../src/gpu/cpuPipeline";
import parityFixture from "./fixtures/parity.json";

/**
 * Régression visuelle GPU↔Python (#9) : le port CPU des shaders (`gpu/cpuPipeline.ts`)
 * doit reproduire, à ~2/255 près, le golden produit par le vrai pipeline Python
 * (`backend/tests/test_parity.py` → `fixtures/parity.json`).
 *
 * Tolérance 0.02 (~5/255) : marge confortable au-dessus de la divergence connue
 * (~2.3/255), dominée par la double quantification 8 bits de la LUT de courbe (filtre
 * LINEAR du GPU) face à la LUT float échantillonnée au plus proche côté Python.
 */
interface Case { name: string; stage: string; params: any; output: number[][]; }
interface Fixture { pixels: RGB[]; cases: Case[]; }

const fixture = parityFixture as unknown as Fixture;
const TOL = 0.02;

describe("régression visuelle GPU↔Python (#9)", () => {
  it("la fixture est présente et non vide", () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
    expect(fixture.pixels.length).toBeGreaterThan(0);
  });

  for (const c of fixture.cases) {
    it(`${c.stage} — ${c.name} concorde avec Python (Δ < ${TOL})`, () => {
      let maxDiff = 0;
      fixture.pixels.forEach((px, i) => {
        const got = applyStage(c.stage, px, c.params);
        const exp = c.output[i];
        for (let k = 0; k < 3; k++) maxDiff = Math.max(maxDiff, Math.abs(got[k] - exp[k]));
      });
      expect(maxDiff).toBeLessThan(TOL);
    });
  }
});
