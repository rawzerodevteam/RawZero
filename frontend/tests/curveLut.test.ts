import { describe, expect, it } from "vitest";
import { buildCurveLut } from "../src/gpu/curveLut";

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
