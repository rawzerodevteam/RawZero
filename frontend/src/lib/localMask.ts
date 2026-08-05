import type { LocalAdjust } from "../types";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// Décale la copie d'un masque géométrique pour qu'elle ne tombe pas exactement sur l'original
// (sinon invisible tant qu'on ne l'a pas bougée) ; les masques par plage/IA n'ont pas de position.
function offsetParams(type: LocalAdjust["type"], params: Record<string, any>): Record<string, any> {
  const OFFSET = 0.06;
  if (type === "linear") {
    return { ...params,
      x0: clamp01((params.x0 ?? 0.5) + OFFSET), y0: clamp01((params.y0 ?? 0.2) + OFFSET),
      x1: clamp01((params.x1 ?? 0.5) + OFFSET), y1: clamp01((params.y1 ?? 0.8) + OFFSET) };
  }
  if (type === "radial") {
    return { ...params, cx: clamp01((params.cx ?? 0.5) + OFFSET), cy: clamp01((params.cy ?? 0.5) + OFFSET) };
  }
  if (type === "brush" || type === "inpaint") {
    const strokes = (params.strokes ?? []).map((s: any) => ({
      ...s, points: (s.points ?? []).map((p: any) => [clamp01(p[0] + OFFSET), clamp01(p[1] + OFFSET)]),
    }));
    if (type === "inpaint") {
      // décale les traits ; le patch précalculé (ref) ne vaut plus pour ce nouvel emplacement —
      // supprimé, la copie apparaît vide jusqu'à régénération (bouton « Regénérer », panneau Local).
      const { ref: _ref, rect: _rect, ...rest } = params;
      return { ...rest, strokes };
    }
    return { ...params, strokes };
  }
  return { ...params };
}

/** Clone un masque local (nouvel id, copie décalée) — utilisé par le copier/coller (Ctrl+C/Ctrl+V). */
export function cloneLocalMask(source: LocalAdjust): LocalAdjust {
  const id = "loc-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  return {
    id, type: source.type, invert: source.invert,
    params: offsetParams(source.type, structuredClone(source.params)),
    adjust: structuredClone(source.adjust),
  };
}
