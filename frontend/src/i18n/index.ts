import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

// Scalable : chaque locales/<code>.json est enregistré automatiquement (glob Vite).
// Ajouter une langue = déposer un fichier (ex. de.json, es.json). Rien d'autre à toucher.
const modules = import.meta.glob<{ default: Record<string, unknown> }>(
  "./locales/*.json",
  { eager: true },
);
const resources: Record<string, { translation: Record<string, unknown> }> = {};
for (const path in modules) {
  const code = path.match(/([a-z-]+)\.json$/)?.[1];
  if (code) resources[code] = { translation: modules[path].default };
}

export const LANGS = Object.keys(resources).sort();

/** Nom d'une langue dans sa propre langue (ex. "Français", "English"). */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "fr",
    supportedLngs: LANGS,
    interpolation: { escapeValue: false },
    detection: { order: ["localStorage", "navigator"], caches: ["localStorage"] },
  });

export default i18n;
