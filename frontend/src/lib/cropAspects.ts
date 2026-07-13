/** Source unique de vérité pour les ratios de recadrage (CropBar flottante + GeometryPanel),
 * pour éviter que les deux UI divergent (cf. audit UX §7.3). */
export const CROP_ASPECTS: [string, number | null][] = [
  ["Libre", null], ["1:1", 1], ["3:2", 3 / 2], ["4:3", 4 / 3], ["16:9", 16 / 9], ["9:16", 9 / 16],
];
