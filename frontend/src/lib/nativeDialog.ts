import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

/** Vrai uniquement dans l'app Tauri empaquetée : un onglet de navigateur classique (npm run
 * dev, ou l'app ouverte dans Chrome) ne peut jamais afficher le sélecteur natif de l'OS. */
export const nativeDialogAvailable = isTauri();

// Miroir de RAW_EXTS/IMG_EXTS (backend/app/config.py) : filtre du sélecteur natif.
const FILTER_EXTENSIONS = [
  "cr2", "cr3", "nef", "nrw", "arw", "srf", "sr2", "raf", "orf",
  "rw2", "dng", "pef", "srw", "x3f", "3fr", "fff", "iiq", "kdc",
  "mrw", "raw", "rwl", "erf", "mef", "mos",
  "jpg", "jpeg", "png", "tif", "tiff", "webp", "bmp",
];

/** Sélecteur natif multi-fichiers (dialogue Windows/macOS/Linux) : renvoie des chemins absolus. */
export async function pickFiles(): Promise<string[] | null> {
  const res = await open({ multiple: true, directory: false,
    filters: [{ name: "Photos", extensions: FILTER_EXTENSIONS }] });
  if (!res) return null;
  return Array.isArray(res) ? res : [res];
}

/** Sélecteur natif d'un unique fichier (reliage d'une photo déplacée). */
export async function pickFile(): Promise<string | null> {
  const res = await open({ multiple: false, directory: false,
    filters: [{ name: "Photos", extensions: FILTER_EXTENSIONS }] });
  if (!res) return null;
  return Array.isArray(res) ? res[0] ?? null : res;
}

/** Sélecteur natif de dossier : renvoie son chemin absolu. */
export async function pickFolder(): Promise<string | null> {
  const res = await open({ multiple: false, directory: true });
  if (!res) return null;
  return Array.isArray(res) ? res[0] ?? null : res;
}
