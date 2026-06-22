import { useSyncExternalStore } from "react";
import i18n from "./i18n";

// Registre central des raccourcis clavier. Chaque « action » a un id stable, une clé i18n de
// libellé, une clé i18n de catégorie et une touche par défaut. Les surcharges utilisateur sont
// persistées en localStorage et consultées par le gestionnaire global (shortcuts.ts) et le
// visualiseur (ImageViewer) — source unique de vérité, modifiable depuis l'onglet « Paramètres ».
export interface ActionDef {
  id: string;
  label: string;     // clé i18n
  category: string;  // clé i18n
  defaultKey: string;
}

export const ACTION_DEFS: ActionDef[] = [
  { id: "nav-prev", label: "kb.action.navPrev", category: "kb.cat.nav", defaultKey: "arrowleft" },
  { id: "nav-next", label: "kb.action.navNext", category: "kb.cat.nav", defaultKey: "arrowright" },
  { id: "view-grid", label: "kb.action.viewGrid", category: "kb.cat.nav", defaultKey: "g" },
  { id: "view-loupe", label: "kb.action.viewLoupe", category: "kb.cat.nav", defaultKey: "e" },
  { id: "view-develop", label: "kb.action.viewDevelop", category: "kb.cat.nav", defaultKey: "d" },
  { id: "rate-0", label: "kb.action.rate0", category: "kb.cat.rating", defaultKey: "0" },
  { id: "rate-1", label: "kb.action.rate1", category: "kb.cat.rating", defaultKey: "1" },
  { id: "rate-2", label: "kb.action.rate2", category: "kb.cat.rating", defaultKey: "2" },
  { id: "rate-3", label: "kb.action.rate3", category: "kb.cat.rating", defaultKey: "3" },
  { id: "rate-4", label: "kb.action.rate4", category: "kb.cat.rating", defaultKey: "4" },
  { id: "rate-5", label: "kb.action.rate5", category: "kb.cat.rating", defaultKey: "5" },
  { id: "flag-pick", label: "kb.action.flagPick", category: "kb.cat.rating", defaultKey: "p" },
  { id: "flag-reject", label: "kb.action.flagReject", category: "kb.cat.rating", defaultKey: "x" },
  { id: "flag-none", label: "kb.action.flagNone", category: "kb.cat.rating", defaultKey: "u" },
  { id: "color-red", label: "kb.action.colorRed", category: "kb.cat.rating", defaultKey: "6" },
  { id: "color-yellow", label: "kb.action.colorYellow", category: "kb.cat.rating", defaultKey: "7" },
  { id: "color-green", label: "kb.action.colorGreen", category: "kb.cat.rating", defaultKey: "8" },
  { id: "color-blue", label: "kb.action.colorBlue", category: "kb.cat.rating", defaultKey: "9" },
  { id: "zoom-toggle", label: "kb.action.zoomToggle", category: "kb.cat.develop", defaultKey: "z" },
  { id: "pan", label: "kb.action.pan", category: "kb.cat.develop", defaultKey: "space" },
  { id: "before-after", label: "kb.action.beforeAfter", category: "kb.cat.develop", defaultKey: "\\" },
  { id: "clipping", label: "kb.action.clipping", category: "kb.cat.develop", defaultKey: "j" },
  { id: "crop", label: "kb.action.crop", category: "kb.cat.develop", defaultKey: "r" },
  { id: "mask-overlay", label: "kb.action.maskOverlay", category: "kb.cat.develop", defaultKey: "o" },
  { id: "info", label: "kb.action.info", category: "kb.cat.develop", defaultKey: "i" },
  { id: "undo", label: "kb.action.undo", category: "kb.cat.edit", defaultKey: "ctrl+z" },
  { id: "redo", label: "kb.action.redo", category: "kb.cat.edit", defaultKey: "ctrl+shift+z" },
  { id: "copy", label: "kb.action.copy", category: "kb.cat.edit", defaultKey: "ctrl+shift+c" },
  { id: "paste", label: "kb.action.paste", category: "kb.cat.edit", defaultKey: "ctrl+shift+v" },
  { id: "export", label: "kb.action.export", category: "kb.cat.edit", defaultKey: "ctrl+e" },
  { id: "remove", label: "kb.action.remove", category: "kb.cat.general", defaultKey: "delete" },
  { id: "help", label: "kb.action.help", category: "kb.cat.general", defaultKey: "?" },
];

/** Catégories (clés i18n) dans l'ordre d'affichage, dédupliquées. */
export const CATEGORIES: string[] = ACTION_DEFS.reduce<string[]>((acc, d) => {
  if (!acc.includes(d.category)) acc.push(d.category);
  return acc;
}, []);

const DEFAULTS: Record<string, string> = Object.fromEntries(ACTION_DEFS.map((d) => [d.id, d.defaultKey]));
const STORE_KEY = "rs.keybindings";

function load(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

// Surcharges : valeur absente → touche par défaut ; valeur "" → explicitement non assigné.
let overrides: Record<string, string> = load();
let lookup: Map<string, string> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function resolve(id: string, ov: Record<string, string>): string {
  return ov[id] !== undefined ? ov[id] : (DEFAULTS[id] ?? "");
}

function commit(next: Record<string, string>): void {
  overrides = next;
  lookup = null;
  version++;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(overrides)); } catch { /* quota / private mode */ }
  listeners.forEach((l) => l());
}

/** Touche actuellement assignée à une action ("" si non assignée). */
export function getBinding(id: string): string {
  return resolve(id, overrides);
}

/** Assigne une touche à une action ; toute autre action utilisant cette touche est libérée. */
export function setBinding(id: string, key: string): void {
  const next = { ...overrides };
  if (key) {
    for (const def of ACTION_DEFS) {
      if (def.id !== id && resolve(def.id, next) === key) next[def.id] = "";
    }
  }
  next[id] = key;
  commit(next);
}

/** Retire l'assignation d'une action (laisse la touche libre). */
export function clearBinding(id: string): void {
  setBinding(id, "");
}

/** Restaure la touche par défaut d'une action. */
export function resetBinding(id: string): void {
  const next = { ...overrides };
  delete next[id];
  commit(next);
}

/** Restaure toutes les touches par défaut. */
export function resetAllBindings(): void {
  commit({});
}

function getLookup(): Map<string, string> {
  if (!lookup) {
    lookup = new Map();
    for (const def of ACTION_DEFS) {
      const k = getBinding(def.id);
      if (k && !lookup.has(k)) lookup.set(k, def.id);
    }
  }
  return lookup;
}

/** Normalise un événement clavier en chaîne canonique (ex. "ctrl+shift+c", "g", "\\", "arrowright"). */
export function normalizeEvent(ev: KeyboardEvent | React.KeyboardEvent): string {
  const k = ev.key;
  if (k === "Control" || k === "Shift" || k === "Alt" || k === "Meta") return "";
  const main = k === " " ? "space" : k.toLowerCase();
  // Maj implicite sur la ponctuation (ex. « ? » nécessite Maj sur bien des claviers) → ignorée.
  const isPunct = k.length === 1 && !/[a-z0-9]/i.test(k);
  const parts: string[] = [];
  if (ev.ctrlKey || ev.metaKey) parts.push("ctrl");
  if (ev.shiftKey && !isPunct && main !== "space") parts.push("shift");
  if (ev.altKey) parts.push("alt");
  parts.push(main);
  return parts.join("+");
}

/** Action liée à un événement clavier, ou null. */
export function actionForEvent(ev: KeyboardEvent | React.KeyboardEvent): string | null {
  const k = normalizeEvent(ev);
  return k ? (getLookup().get(k) ?? null) : null;
}

// Tokens dont le libellé dépend de la langue ; les symboles (flèches) restent littéraux.
const KEY_I18N: Record<string, string> = {
  ctrl: "kb.key.ctrl", shift: "kb.key.shift", alt: "kb.key.alt", space: "kb.key.space",
  delete: "kb.key.delete", backspace: "kb.key.backspace", escape: "kb.key.escape",
  enter: "kb.key.enter", tab: "kb.key.tab",
};
const KEY_SYM: Record<string, string> = { arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓" };

/** Affichage lisible d'une touche normalisée ("ctrl+shift+c" → "Ctrl+Maj+C"). */
export function formatKey(binding: string): string {
  if (!binding) return "—";
  return binding.split("+").map((p) =>
    KEY_I18N[p] ? i18n.t(KEY_I18N[p]) : (KEY_SYM[p] ?? (p.length === 1 ? p.toUpperCase() : p)),
  ).join("+");
}

/** Abonnement React : force un rendu quand les raccourcis changent. */
export function useKeybindings(): number {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => version,
  );
}
