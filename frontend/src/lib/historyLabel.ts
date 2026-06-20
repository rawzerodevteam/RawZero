import { BAND_LABELS, type Band, type EditState } from "../types";

const sign = (v: number) => (v > 0 ? "+" : "") + (Math.round(v * 100) / 100);

/**
 * Décrit en français le (premier) changement entre deux états de réglages, pour libeller une
 * étape d'historique. Pour une modification de slider isolée (le cas courant), c'est exact ;
 * pour un changement groupé (preset, collage, auto…) on passe plutôt un libellé explicite.
 */
export function describeEditChange(a: EditState, b: EditState): string {
  if (a.wb.temp !== b.wb.temp) return `Température ${sign(b.wb.temp)}`;
  if (a.wb.tint !== b.wb.tint) return `Teinte WB ${sign(b.wb.tint)}`;

  const tone: [keyof EditState["tone"], string][] = [
    ["exposure", "Exposition"], ["contrast", "Contraste"], ["highlights", "Hautes lumières"],
    ["shadows", "Ombres"], ["whites", "Blancs"], ["blacks", "Noirs"],
  ];
  for (const [k, lbl] of tone) if (a.tone[k] !== b.tone[k]) return `${lbl} ${sign(b.tone[k])}`;

  const pres: [keyof EditState["presence"], string][] = [
    ["clarity", "Clarté"], ["dehaze", "Dehaze"], ["vibrance", "Vibrance"], ["saturation", "Saturation"],
  ];
  for (const [k, lbl] of pres) if (a.presence[k] !== b.presence[k]) return `${lbl} ${sign(b.presence[k])}`;

  const det: [keyof EditState["detail"], string][] = [
    ["sharpen_amount", "Netteté"], ["sharpen_radius", "Rayon de netteté"], ["nr_luma", "Réduction de bruit"],
    ["nr_color", "Bruit couleur"], ["nr_ai", "Débruitage IA"], ["defringe_purple", "Défrange pourpre"],
    ["defringe_green", "Défrange vert"],
  ];
  for (const [k, lbl] of det) if (a.detail[k] !== b.detail[k]) return `${lbl} ${sign(b.detail[k])}`;

  if (a.effects.vignette !== b.effects.vignette) return `Vignettage ${sign(b.effects.vignette)}`;
  if (a.effects.grain !== b.effects.grain) return `Grain ${sign(b.effects.grain)}`;

  if (a.geometry.rotate !== b.geometry.rotate) return "Rotation";
  if (a.geometry.flip_h !== b.geometry.flip_h || a.geometry.flip_v !== b.geometry.flip_v) return "Miroir";
  if (a.geometry.straighten !== b.geometry.straighten) return `Redressement ${sign(b.geometry.straighten)}`;
  if (JSON.stringify(a.geometry.crop) !== JSON.stringify(b.geometry.crop)) return "Recadrage";

  const curveLbl: Record<string, string> = { points: "Courbe", r: "Courbe rouge", g: "Courbe verte", b: "Courbe bleue" };
  for (const ch of ["points", "r", "g", "b"] as const)
    if (JSON.stringify(a.curve[ch]) !== JSON.stringify(b.curve[ch])) return curveLbl[ch];

  for (const band of Object.keys(a.hsl) as Band[]) {
    const x = a.hsl[band], y = b.hsl[band];
    if (x.h !== y.h) return `TSL ${BAND_LABELS[band]} — teinte`;
    if (x.s !== y.s) return `TSL ${BAND_LABELS[band]} — saturation`;
    if (x.l !== y.l) return `TSL ${BAND_LABELS[band]} — luminance`;
  }

  if (b.locals.length > a.locals.length) return "Masque local ajouté";
  if (b.locals.length < a.locals.length) return "Masque local supprimé";
  if (JSON.stringify(a.locals) !== JSON.stringify(b.locals)) return "Masque local";

  return "Modification";
}
