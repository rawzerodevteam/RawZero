// Personnalisation du thème : palette de base + couleur d'accent, persistées en localStorage,
// appliquées en surchargeant les variables CSS de :root. 4 presets (dark/light/warm/cold) +
// « custom » (palette dérivée d'une couleur de fond choisie, texte auto-contrasté).
const ACCENT_KEY = "rs.accent";
const THEME_KEY = "rs.theme";
const CUSTOM_BG_KEY = "rs.customBg";

export const DEFAULT_ACCENT = "#7aa2ff";
export const ACCENT_PRESETS = ["#7aa2ff", "#5bb98b", "#e5a35b", "#e253a8", "#9d7bea", "#e5484d"];
export const DEFAULT_THEME = "dark";
export const DEFAULT_CUSTOM_BG = "#242a36";

export type ThemeVars = {
  "--bg": string; "--bg-deep": string; "--bg-panel": string; "--bg-raised": string;
  "--border": string; "--text": string; "--text-dim": string;
};
export interface ThemeDef { id: string; name: string; vars: ThemeVars; }

// name = clé i18n (traduite au rendu). Presets choisis à la main pour un rendu net et distinct.
export const THEMES: ThemeDef[] = [
  { id: "dark", name: "settings.themeDark", vars: {
    "--bg": "#1c1d22", "--bg-deep": "#141519", "--bg-panel": "#232429", "--bg-raised": "#2b2d33",
    "--border": "#34363d", "--text": "#d8d9de", "--text-dim": "#8b8d96" } },
  { id: "light", name: "settings.themeLight", vars: {
    "--bg": "#f5f6f8", "--bg-deep": "#e9ebef", "--bg-panel": "#ffffff", "--bg-raised": "#eef0f3",
    "--border": "#d3d7df", "--text": "#20242b", "--text-dim": "#6a7180" } },
  { id: "warm", name: "settings.themeWarm", vars: {
    "--bg": "#221d18", "--bg-deep": "#181410", "--bg-panel": "#2c2620", "--bg-raised": "#362f27",
    "--border": "#423a30", "--text": "#ece2d4", "--text-dim": "#a99a86" } },
  { id: "cold", name: "settings.themeCold", vars: {
    "--bg": "#181c24", "--bg-deep": "#11141b", "--bg-panel": "#1f2530", "--bg-raised": "#28303d",
    "--border": "#333d4d", "--text": "#d6deea", "--text-dim": "#8794a8" } },
];

// ---- Utilitaires couleur ----
function parse(hex: string): [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0x242a36;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function toHex([r, g, b]: number[]): string {
  const h = (x: number) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
function mix(a: number[], b: number[], t: number): number[] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function luminance([r, g, b]: number[]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Palette cohérente dérivée d'une couleur de fond (surfaces nuancées + texte auto-contrasté). */
export function paletteFromBg(bg: string): ThemeVars {
  const c = parse(bg);
  const dark = luminance(c) < 140;
  const white = [255, 255, 255], black = [0, 0, 0];
  const lighten = (t: number) => toHex(mix(c, white, t));
  const darken = (t: number) => toHex(mix(c, black, t));
  const text = dark ? [222, 224, 230] : [32, 36, 43];
  return {
    "--bg": toHex(c),
    "--bg-deep": dark ? darken(0.35) : darken(0.05),
    "--bg-panel": dark ? lighten(0.06) : lighten(0.55),
    "--bg-raised": dark ? lighten(0.12) : lighten(0.4),
    "--border": dark ? lighten(0.22) : darken(0.12),
    "--text": toHex(text),
    "--text-dim": toHex(mix(text, c, 0.45)),
  };
}

function softFrom(hex: string): string {
  const [r, g, b] = parse(hex);
  return `rgba(${r}, ${g}, ${b}, 0.18)`;
}

// ---- Accent ----
export function getAccent(): string { return localStorage.getItem(ACCENT_KEY) || DEFAULT_ACCENT; }
export function applyAccent(hex: string): void {
  const r = document.documentElement.style;
  r.setProperty("--accent", hex);
  r.setProperty("--accent-soft", softFrom(hex));
}
export function setAccent(hex: string): void {
  try { localStorage.setItem(ACCENT_KEY, hex); } catch { /* mode privé */ }
  applyAccent(hex);
}
export function resetAccent(): void {
  try { localStorage.removeItem(ACCENT_KEY); } catch { /* ignore */ }
  applyAccent(DEFAULT_ACCENT);
}

// ---- Thème (preset ou custom) ----
export function getThemeId(): string { return localStorage.getItem(THEME_KEY) || DEFAULT_THEME; }
export function getCustomBg(): string { return localStorage.getItem(CUSTOM_BG_KEY) || DEFAULT_CUSTOM_BG; }

/** Variables du thème courant (preset connu, sinon palette custom dérivée du fond). */
export function themeVars(id: string): ThemeVars {
  if (id === "custom") return paletteFromBg(getCustomBg());
  return (THEMES.find((t) => t.id === id) ?? THEMES[0]).vars;
}
export function applyTheme(id: string): void {
  const r = document.documentElement.style;
  for (const [k, v] of Object.entries(themeVars(id))) r.setProperty(k, v);
}
export function setTheme(id: string): void {
  try { localStorage.setItem(THEME_KEY, id); } catch { /* mode privé */ }
  applyTheme(id);
}
export function setCustomBg(hex: string): void {
  try { localStorage.setItem(CUSTOM_BG_KEY, hex); } catch { /* mode privé */ }
  applyTheme("custom");
}
