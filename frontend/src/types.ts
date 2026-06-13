export interface Photo {
  id: number;
  filename: string;
  ext: string;
  is_raw: number;
  width: number;
  height: number;
  captured_at: string;
  imported_at: string;
  camera: string;
  lens: string;
  iso: number;
  aperture: number;
  shutter: string;
  focal: number;
  rating: number;
  flag: "none" | "pick" | "reject";
  color: string;
  edited: boolean;
}

export const HSL_BANDS = [
  "red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta",
] as const;
export type Band = (typeof HSL_BANDS)[number];

export const BAND_LABELS: Record<Band, string> = {
  red: "Rouge", orange: "Orange", yellow: "Jaune", green: "Vert",
  aqua: "Aqua", blue: "Bleu", purple: "Violet", magenta: "Magenta",
};

export const BAND_COLORS: Record<Band, string> = {
  red: "#e5484d", orange: "#f1903d", yellow: "#e8c84b", green: "#5bb98b",
  aqua: "#4ccce6", blue: "#5b8def", purple: "#9d7bea", magenta: "#e253a8",
};

export interface LocalAdjustValues {
  exposure: number; contrast: number; highlights: number; shadows: number;
  temp: number; tint: number; saturation: number; clarity: number; sharpness: number;
}

export interface LocalAdjust {
  id: string;
  type: "linear" | "radial" | "brush";
  params: Record<string, any>;
  invert: boolean;
  adjust: LocalAdjustValues;
}

export interface EditState {
  version: number;
  wb: { temp: number; tint: number };
  tone: { exposure: number; contrast: number; highlights: number; shadows: number; whites: number; blacks: number };
  presence: { clarity: number; dehaze: number; vibrance: number; saturation: number };
  curve: { points: [number, number][] };
  hsl: Record<Band, { h: number; s: number; l: number }>;
  detail: { sharpen_amount: number; sharpen_radius: number; nr_luma: number; nr_color: number };
  effects: { vignette: number; grain: number };
  geometry: {
    rotate: number; flip_h: boolean; flip_v: boolean; straighten: number;
    crop: { x: number; y: number; w: number; h: number };
  };
  locals: LocalAdjust[];
}

export function defaultEdits(): EditState {
  const hsl = {} as EditState["hsl"];
  for (const b of HSL_BANDS) hsl[b] = { h: 0, s: 0, l: 0 };
  return {
    version: 1,
    wb: { temp: 0, tint: 0 },
    tone: { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 },
    presence: { clarity: 0, dehaze: 0, vibrance: 0, saturation: 0 },
    curve: { points: [[0, 0], [1, 1]] },
    hsl,
    detail: { sharpen_amount: 25, sharpen_radius: 1, nr_luma: 0, nr_color: 0 },
    effects: { vignette: 0, grain: 0 },
    geometry: { rotate: 0, flip_h: false, flip_v: false, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } },
    locals: [],
  };
}

export function defaultLocalAdjust(): LocalAdjustValues {
  return { exposure: 0, contrast: 0, highlights: 0, shadows: 0, temp: 0, tint: 0, saturation: 0, clarity: 0, sharpness: 0 };
}

/** Fusionne un état partiel (preset / DB) avec les valeurs par défaut. */
export function mergeEdits(partial: any): EditState {
  const base: any = defaultEdits();
  if (!partial || typeof partial !== "object") return base;
  const deep = (dst: any, src: any) => {
    for (const k of Object.keys(dst)) {
      if (src?.[k] === undefined) continue;
      if (dst[k] && typeof dst[k] === "object" && !Array.isArray(dst[k])) deep(dst[k], src[k]);
      else dst[k] = src[k];
    }
  };
  deep(base, partial);
  base.curve.points = Array.isArray(partial.curve?.points) && partial.curve.points.length >= 2
    ? partial.curve.points.map((p: number[]) => [p[0], p[1]])
    : [[0, 0], [1, 1]];
  base.locals = Array.isArray(partial.locals)
    ? partial.locals.map((l: any) => ({
        id: String(l.id ?? Math.random().toString(36).slice(2)),
        type: l.type ?? "radial",
        params: l.params ?? {},
        invert: Boolean(l.invert),
        adjust: { ...defaultLocalAdjust(), ...(l.adjust ?? {}) },
      }))
    : [];
  return base as EditState;
}

export interface Preset {
  id: number;
  name: string;
  builtin: boolean;
  settings: Partial<EditState>;
}

export interface ImportResult {
  filename: string;
  status: "imported" | "duplicate" | "ignored" | "error" | "pending" | "uploading";
  reason?: string;
  id?: number;
}

export const FLAG_LABELS: Record<string, string> = { none: "—", pick: "Retenue", reject: "Rejetée" };
export const COLOR_VALUES = ["red", "yellow", "green", "blue", "purple"] as const;
export const COLOR_HEX: Record<string, string> = {
  red: "#e5484d", yellow: "#e8c84b", green: "#5bb98b", blue: "#5b8def", purple: "#9d7bea",
};
