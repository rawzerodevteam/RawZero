import { describe, expect, it } from "vitest";
import { defaultEdits, mergeEdits, HSL_BANDS } from "../src/types";

describe("defaultEdits", () => {
  it("est neutre (toutes les valeurs à zéro sauf la netteté de base)", () => {
    const e = defaultEdits();
    expect(e.wb).toEqual({ temp: 0, tint: 0 });
    expect(e.tone).toEqual({ exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 });
    expect(e.curve.points).toEqual([[0, 0], [1, 1]]);
    expect(e.geometry.crop).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(e.locals).toEqual([]);
    for (const b of HSL_BANDS) expect(e.hsl[b]).toEqual({ h: 0, s: 0, l: 0 });
  });

  it("renvoie un nouvel objet à chaque appel (pas d'état partagé)", () => {
    const a = defaultEdits();
    const b = defaultEdits();
    a.tone.exposure = 2;
    expect(b.tone.exposure).toBe(0);
  });
});

describe("mergeEdits", () => {
  it("renvoie les défauts pour une entrée vide ou invalide", () => {
    expect(mergeEdits(null)).toEqual(defaultEdits());
    expect(mergeEdits(undefined)).toEqual(defaultEdits());
    expect(mergeEdits("garbage")).toEqual(defaultEdits());
    expect(mergeEdits({})).toEqual(defaultEdits());
  });

  it("fusionne un état partiel sans toucher au reste", () => {
    const e = mergeEdits({ tone: { exposure: 1.5 }, wb: { temp: 20 } });
    expect(e.tone.exposure).toBe(1.5);
    expect(e.tone.contrast).toBe(0);
    expect(e.wb.temp).toBe(20);
    expect(e.wb.tint).toBe(0);
    expect(e.presence).toEqual(defaultEdits().presence);
  });

  it("ignore les clés inconnues", () => {
    const e = mergeEdits({ inconnue: 42, tone: { exposure: 1 } }) as any;
    expect(e.inconnue).toBeUndefined();
    expect(e.tone.exposure).toBe(1);
  });

  it("reprend les points de courbe valides", () => {
    const e = mergeEdits({ curve: { points: [[0, 0.1], [0.5, 0.6], [1, 0.9]] } });
    expect(e.curve.points).toEqual([[0, 0.1], [0.5, 0.6], [1, 0.9]]);
  });

  it("garde la courbe par défaut si moins de 2 points", () => {
    const e = mergeEdits({ curve: { points: [[0.5, 0.5]] } });
    expect(e.curve.points).toEqual([[0, 0], [1, 1]]);
  });

  it("normalise les masques locaux (id, invert, adjust complétés)", () => {
    const e = mergeEdits({ locals: [{ type: "linear", adjust: { exposure: 0.5 } }] });
    expect(e.locals).toHaveLength(1);
    const l = e.locals[0];
    expect(typeof l.id).toBe("string");
    expect(l.id.length).toBeGreaterThan(0);
    expect(l.type).toBe("linear");
    expect(l.invert).toBe(false);
    expect(l.adjust.exposure).toBe(0.5);
    expect(l.adjust.contrast).toBe(0); // complété par les défauts
  });

  it("remplace un locals non-tableau par un tableau vide", () => {
    expect(mergeEdits({ locals: "oops" }).locals).toEqual([]);
  });

  it("normalise un masque \"light\" (falloff conservé)", () => {
    const e = mergeEdits({
      locals: [{ type: "light", params: { cx: 0.3, cy: 0.2, falloff: 2.5 } }],
    });
    expect(e.locals[0].type).toBe("light");
    expect(e.locals[0].params.falloff).toBe(2.5);
  });

  it("normalise un masque \"depthrange\" (ref/near/far conservés)", () => {
    const e = mergeEdits({
      locals: [{ type: "depthrange", params: { ref: "7/depth-x.png", near: 0.2, far: 0.8, smooth: 0.1 } }],
    });
    expect(e.locals[0].type).toBe("depthrange");
    expect(e.locals[0].params.ref).toBe("7/depth-x.png");
    expect(e.locals[0].params.near).toBe(0.2);
    expect(e.locals[0].params.far).toBe(0.8);
  });
});
