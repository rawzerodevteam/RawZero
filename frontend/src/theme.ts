// Personnalisation du thème : palette de base (presets) + couleur d'accent. Surcharge les
// variables CSS de :root, persistée en localStorage. Les presets restent tous sombres pour
// garder l'UI cohérente (cf. issue #4 : thèmes prédéfinis + accent personnalisable).
const ACCENT_KEY = "rs.accent";
const THEME_KEY = "rs.theme";

export const DEFAULT_ACCENT = "#7aa2ff";
export const ACCENT_PRESETS = ["#7aa2ff", "#5bb98b", "#e5a35b", "#e253a8", "#9d7bea", "#e5484d"];

export interface ThemeDef {
  id: string;
  name: string;
  vars: {
    "--bg": string; "--bg-deep": string; "--bg-panel": string; "--bg-raised": string;
    "--border": string; "--text": string; "--text-dim": string;
  };
}

export const THEMES: ThemeDef[] = [
  { id: "slate", name: "Slate", vars: {
    "--bg": "#1c1d22", "--bg-deep": "#141519", "--bg-panel": "#232429", "--bg-raised": "#2b2d33",
    "--border": "#34363d", "--text": "#d8d9de", "--text-dim": "#8b8d96" } },
  { id: "light", name: "Light", vars: {
    "--bg": "#f4f5f7", "--bg-deep": "#e8eaee", "--bg-panel": "#ffffff", "--bg-raised": "#eceef2",
    "--border": "#d4d8e0", "--text": "#1f2329", "--text-dim": "#697084" } },
  { id: "nord", name: "Nord", vars: {
    "--bg": "#2e3440", "--bg-deep": "#272c36", "--bg-panel": "#3b4252", "--bg-raised": "#434c5e",
    "--border": "#4c566a", "--text": "#e5e9f0", "--text-dim": "#9aa3b5" } },
  { id: "midnight", name: "Midnight", vars: {
    "--bg": "#0e1016", "--bg-deep": "#08090f", "--bg-panel": "#161922", "--bg-raised": "#1f2330",
    "--border": "#2a2f3d", "--text": "#e3e6ef", "--text-dim": "#828aa0" } },
  { id: "graphite", name: "Graphite", vars: {
    "--bg": "#1e1e1e", "--bg-deep": "#151515", "--bg-panel": "#262626", "--bg-raised": "#2f2f2f",
    "--border": "#3a3a3a", "--text": "#dadada", "--text-dim": "#8c8c8c" } },
  { id: "warm", name: "Warm", vars: {
    "--bg": "#211e1b", "--bg-deep": "#181513", "--bg-panel": "#2a2521", "--bg-raised": "#332d28",
    "--border": "#3e3833", "--text": "#e6dfd4", "--text-dim": "#a59a8c" } },
];
export const DEFAULT_THEME = "slate";

/** "#rrggbb" → "rgba(r, g, b, 0.18)" (teinte douce des fonds actifs). */
function softFrom(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return "rgba(122, 162, 255, 0.18)";
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.18)`;
}

// ---- Accent ----
export function getAccent(): string {
  return localStorage.getItem(ACCENT_KEY) || DEFAULT_ACCENT;
}
export function applyAccent(hex: string): void {
  const r = document.documentElement.style;
  r.setProperty("--accent", hex);
  r.setProperty("--accent-soft", softFrom(hex));
}
export function setAccent(hex: string): void {
  try { localStorage.setItem(ACCENT_KEY, hex); } catch { /* mode privé / quota */ }
  applyAccent(hex);
}
export function resetAccent(): void {
  try { localStorage.removeItem(ACCENT_KEY); } catch { /* ignore */ }
  applyAccent(DEFAULT_ACCENT);
}

// ---- Palette (preset) ----
export function getThemeId(): string {
  return localStorage.getItem(THEME_KEY) || DEFAULT_THEME;
}
export function applyTheme(id: string): void {
  const def = THEMES.find((t) => t.id === id) ?? THEMES[0];
  const r = document.documentElement.style;
  for (const [k, v] of Object.entries(def.vars)) r.setProperty(k, v);
}
export function setTheme(id: string): void {
  try { localStorage.setItem(THEME_KEY, id); } catch { /* mode privé / quota */ }
  applyTheme(id);
}
