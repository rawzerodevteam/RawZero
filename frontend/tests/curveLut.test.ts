import { describe, expect, it } from "vitest";
import { buildCurveLut, buildCurveTexture } from "../src/gpu/curveLut";

const ID = [[0, 0], [1, 1]] as [number, number][];

describe("buildCurveLut (portage PCHIP)", () => {
  it("renvoie null pour la courbe identité", () => {
    expect(buildCurveLut([[0, 0], [1, 1]])).toBeNull();
  });

  it("renvoie null si moins de 2 points", () => {
    expect(buildCurveLut([[0.5, 0.5]])).toBeNull();
  });

  it("produit une LUT monotone croissante pour une courbe en S", () => {
    const lut = buildCurveLut([[0, 0], [0.25, 0.15], [0.75, 0.9], [1, 1]]);
    expect(lut).not.toBeNull();
    expect(lut!.length).toBe(1024);
    for (let i = 1; i < lut!.length; i++) {
      expect(lut![i]).toBeGreaterThanOrEqual(lut![i - 1]);
    }
  });

  it("respecte les extrémités (clamp aux bornes)", () => {
    const lut = buildCurveLut([[0, 0.1], [1, 0.9]])!;
    expect(lut[0]).toBe(Math.round(0.1 * 255));
    expect(lut[lut.length - 1]).toBe(Math.round(0.9 * 255));
  });

  it("une courbe qui assombrit produit des valeurs < entrée au milieu", () => {
    const lut = buildCurveLut([[0, 0], [0.5, 0.3], [1, 1]])!;
    const mid = lut[Math.floor(lut.length / 2)];
    expect(mid).toBeLessThan(128); // 0.3 attendu au point milieu, < 0.5
  });
});

describe("buildCurveTexture (courbes RVB par canal)", () => {
  it("renvoie null quand maître + R/V/B sont identité", () => {
    expect(buildCurveTexture({ points: ID, r: ID, g: ID, b: ID })).toBeNull();
  });

  it("courbe rouge seule n'affecte que le canal R", () => {
    const tex = buildCurveTexture({ points: ID, r: [[0, 0], [0.5, 0.25], [1, 1]], g: ID, b: ID })!;
    expect(tex).not.toBeNull();
    const mid = (tex.length / 4) >> 1;
    expect(tex[mid * 4]).toBeLessThan(128);        // R abaissé au milieu
    expect(tex[mid * 4 + 1]).toBe(Math.round((mid / (tex.length / 4 - 1)) * 255)); // V identité
    expect(tex[mid * 4 + 2]).toBe(Math.round((mid / (tex.length / 4 - 1)) * 255)); // B identité
  });

  it("compose le maître avant la courbe de canal (composed = chan(master(x)))", () => {
    // maître = +0.1 partout (clampé), canal R = identité → R ≈ master
    const tex = buildCurveTexture({ points: [[0, 0.1], [1, 1]], r: ID, g: ID, b: ID })!;
    expect(tex[0]).toBe(Math.round(0.1 * 255));    // x=0 → master(0)=0.1
  });
});
