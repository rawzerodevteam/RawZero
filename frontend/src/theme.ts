// Personnalisation de la couleur d'accent (variable CSS --accent), persistée en localStorage.
// Point d'ancrage minimal du thème (cf. issue #4) : surcharge --accent / --accent-soft sur :root.
const KEY = "rs.accent";
export const DEFAULT_ACCENT = "#7aa2ff";
export const ACCENT_PRESETS = ["#7aa2ff", "#5bb98b", "#e5a35b", "#e253a8", "#9d7bea", "#e5484d"];

/** "#rrggbb" → "rgba(r, g, b, 0.18)" (teinte douce utilisée pour les fonds actifs). */
function softFrom(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return "rgba(122, 162, 255, 0.18)";
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.18)`;
}

export function getAccent(): string {
  return localStorage.getItem(KEY) || DEFAULT_ACCENT;
}

export function applyAccent(hex: string): void {
  const root = document.documentElement.style;
  root.setProperty("--accent", hex);
  root.setProperty("--accent-soft", softFrom(hex));
}

export function setAccent(hex: string): void {
  try { localStorage.setItem(KEY, hex); } catch { /* mode privé / quota */ }
  applyAccent(hex);
}

export function resetAccent(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  applyAccent(DEFAULT_ACCENT);
}
