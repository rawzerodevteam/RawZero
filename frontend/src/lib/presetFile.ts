/** Lecture / écriture des fichiers de presets `.rsp` (JSON).
 *
 *  Format bundle (1..N presets) :
 *    { "format": "rawzero-preset", "version": 1,
 *      "presets": [ { "name": "...", "settings": { ...Partial<EditState> } } ] }
 *
 *  L'import tolère aussi la forme « preset unique » : { format, version, name, settings },
 *  ainsi que l'ancien en-tête `PRESET_FORMAT_LEGACY` (fichiers `.rsp` exportés avant le
 *  renommage du projet RawStudio → RawZero, cf. mémoire rawstudio-project-name).
 *  Les `settings` sont assainis : un preset ne porte que le rendu (pas de géométrie ni de
 *  masques locaux), cf. PresetsPanel (sauvegarde) et le backend (assainissement serveur). */
import type { EditState, Preset } from "../types";

export const PRESET_FORMAT = "rawzero-preset";
const PRESET_FORMAT_LEGACY = "rawstudio-preset";
export const PRESET_FILE_VERSION = 1;

/** Sections de rendu conservées dans un preset (tout le reste est jeté). */
const ALLOWED_SECTIONS = ["wb", "tone", "presence", "curve", "hsl", "detail", "effects"] as const;

export interface PresetFileEntry {
  name: string;
  settings: Partial<EditState>;
}

/** Ne garde que les sections de rendu connues ; supprime geometry/locals/version/clés inconnues. */
export function sanitizeSettings(raw: any): Partial<EditState> {
  const out: Record<string, any> = {};
  if (raw && typeof raw === "object") {
    for (const k of ALLOWED_SECTIONS) {
      if (raw[k] && typeof raw[k] === "object") out[k] = raw[k];
    }
  }
  return out as Partial<EditState>;
}

/** Sérialise des presets en JSON bundle `.rsp`. */
export function serializePresets(items: PresetFileEntry[]): string {
  const presets = items.map((p) => ({ name: p.name, settings: sanitizeSettings(p.settings) }));
  return JSON.stringify({ format: PRESET_FORMAT, version: PRESET_FILE_VERSION, presets }, null, 2);
}

/** Parse le contenu d'un fichier `.rsp`. Lève une erreur lisible si invalide. */
export function parsePresetFile(text: string): PresetFileEntry[] {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("invalid-json");
  }
  if (!data || typeof data !== "object" ||
      (data.format !== PRESET_FORMAT && data.format !== PRESET_FORMAT_LEGACY)) {
    throw new Error("invalid-format");
  }
  // Bundle (presets[]) ou preset unique (name + settings).
  const rawList: any[] = Array.isArray(data.presets)
    ? data.presets
    : data.name !== undefined || data.settings !== undefined
      ? [{ name: data.name, settings: data.settings }]
      : [];
  const out = rawList
    .map((p) => ({ name: String(p?.name ?? "").trim(), settings: sanitizeSettings(p?.settings) }))
    .filter((p) => p.name.length > 0);
  if (out.length === 0) throw new Error("empty");
  return out;
}

/** Construit un nom unique parmi `existing` en suffixant « (2) », « (3) »… si besoin. */
export function uniquePresetName(name: string, existing: Iterable<string>): string {
  const taken = new Set(Array.from(existing, (n) => n.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const candidate = `${name} (${i})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Nom de fichier sûr dérivé d'un nom de preset. */
export function presetSlug(name: string): string {
  const slug = name.normalize("NFKD").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return slug || "preset";
}

/** Déclenche le téléchargement d'un fichier texte côté navigateur. */
export function downloadTextFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Convertit un Preset (DB) en entrée de fichier. */
export function presetToEntry(p: Preset): PresetFileEntry {
  return { name: p.name, settings: p.settings };
}
