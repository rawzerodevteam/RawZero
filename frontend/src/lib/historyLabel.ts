import i18n from "../i18n";
import { type Band, type EditState } from "../types";

const sign = (v: number) => (v > 0 ? "+" : "") + (Math.round(v * 100) / 100);
const t = (k: string) => i18n.t(k);

/**
 * Décrit le (premier) changement entre deux états de réglages, pour libeller une étape
 * d'historique (langue courante). Pour une modification de slider isolée (cas courant) c'est
 * exact ; pour un changement groupé (preset, collage, auto…) on passe plutôt un libellé explicite.
 */
export function describeEditChange(a: EditState, b: EditState): string {
  if (a.wb.temp !== b.wb.temp) return `${t("adj.temperature")} ${sign(b.wb.temp)}`;
  if (a.wb.tint !== b.wb.tint) return `${t("adj.tint")} ${sign(b.wb.tint)}`;

  const tone: [keyof EditState["tone"], string][] = [
    ["exposure", "adj.exposure"], ["contrast", "adj.contrast"], ["highlights", "adj.highlights"],
    ["shadows", "adj.shadows"], ["whites", "adj.whites"], ["blacks", "adj.blacks"],
  ];
  for (const [k, key] of tone) if (a.tone[k] !== b.tone[k]) return `${t(key)} ${sign(b.tone[k])}`;

  const pres: [keyof EditState["presence"], string][] = [
    ["clarity", "adj.clarity"], ["dehaze", "adj.dehaze"], ["vibrance", "adj.vibrance"], ["saturation", "adj.saturation"],
  ];
  for (const [k, key] of pres) if (a.presence[k] !== b.presence[k]) return `${t(key)} ${sign(b.presence[k])}`;

  const det: [keyof EditState["detail"], string][] = [
    ["sharpen_amount", "history.label.sharpen"], ["sharpen_radius", "history.label.sharpenRadius"],
    ["nr_luma", "history.label.nrLuma"], ["nr_color", "history.label.nrColor"],
    ["nr_ai", "history.label.nrAi"], ["defringe_purple", "history.label.defringePurple"],
    ["defringe_green", "history.label.defringeGreen"],
  ];
  for (const [k, key] of det) if (a.detail[k] !== b.detail[k]) return `${t(key)} ${sign(b.detail[k])}`;

  if (a.effects.vignette !== b.effects.vignette) return `${t("history.label.vignette")} ${sign(b.effects.vignette)}`;
  if (a.effects.grain !== b.effects.grain) return `${t("history.label.grain")} ${sign(b.effects.grain)}`;

  if (a.geometry.rotate !== b.geometry.rotate) return t("history.label.rotate");
  if (a.geometry.flip_h !== b.geometry.flip_h || a.geometry.flip_v !== b.geometry.flip_v) return t("history.label.flip");
  if (a.geometry.straighten !== b.geometry.straighten) return `${t("history.label.straighten")} ${sign(b.geometry.straighten)}`;
  if (JSON.stringify(a.geometry.crop) !== JSON.stringify(b.geometry.crop)) return t("history.label.crop");

  const curveKey: Record<string, string> = {
    points: "history.label.curve", r: "history.label.curveR", g: "history.label.curveG", b: "history.label.curveB",
  };
  for (const ch of ["points", "r", "g", "b"] as const)
    if (JSON.stringify(a.curve[ch]) !== JSON.stringify(b.curve[ch])) return t(curveKey[ch]);

  for (const band of Object.keys(a.hsl) as Band[]) {
    const x = a.hsl[band], y = b.hsl[band];
    const name = t(`hsl.band.${band}`);
    if (x.h !== y.h) return `${t("history.label.hsl")} ${name} — ${t("hsl.hue")}`;
    if (x.s !== y.s) return `${t("history.label.hsl")} ${name} — ${t("hsl.saturation")}`;
    if (x.l !== y.l) return `${t("history.label.hsl")} ${name} — ${t("hsl.luminance")}`;
  }

  if (b.locals.length > a.locals.length) return t("history.label.maskAdded");
  if (b.locals.length < a.locals.length) return t("history.label.maskRemoved");
  if (JSON.stringify(a.locals) !== JSON.stringify(b.locals)) return t("history.label.mask");

  return t("history.change");
}
