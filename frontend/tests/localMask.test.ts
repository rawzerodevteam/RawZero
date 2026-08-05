import { describe, expect, it } from "vitest";
import { cloneLocalMask } from "../src/lib/localMask";
import { defaultLocalAdjust, type LocalAdjust } from "../src/types";

function makeInpaint(overrides: Record<string, any> = {}): LocalAdjust {
  return {
    id: "loc-1", type: "inpaint", invert: false, adjust: defaultLocalAdjust(),
    params: {
      feather: 0.4, opacity: 1,
      strokes: [{ points: [[0.3, 0.4], [0.32, 0.41]], size: 0.05 }],
      ref: "1/inpaint-abc.png", rect: [0.1, 0.2, 0.5, 0.6],
      ...overrides,
    },
  };
}

describe("cloneLocalMask — masque inpaint", () => {
  it("décale les traits et efface le patch précalculé (ref/rect)", () => {
    const clone = cloneLocalMask(makeInpaint());
    expect(clone.id).not.toBe("loc-1");
    expect(clone.type).toBe("inpaint");
    expect(clone.params.strokes[0].points[0]).not.toEqual([0.3, 0.4]);
    expect(clone.params.ref).toBeUndefined();
    expect(clone.params.rect).toBeUndefined();
  });

  it("clampe les coordonnées décalées à [0, 1]", () => {
    const clone = cloneLocalMask(makeInpaint({
      strokes: [{ points: [[0.98, 0.98]], size: 0.05 }],
    }));
    const [x, y] = clone.params.strokes[0].points[0];
    expect(x).toBeLessThanOrEqual(1);
    expect(y).toBeLessThanOrEqual(1);
  });

  it("ne partage pas de référence avec la source (copie profonde des params)", () => {
    const src = makeInpaint();
    const clone = cloneLocalMask(src);
    clone.params.strokes[0].points[0][0] = 0.9;
    expect(src.params.strokes[0].points[0][0]).toBe(0.3);
  });
});
