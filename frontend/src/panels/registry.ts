import type { ComponentType } from "react";
import { BasicPanel } from "./BasicPanel";
import { CurvePanel } from "./CurvePanel";
import { DetailPanel } from "./DetailPanel";
import { EffectsPanel } from "./EffectsPanel";
import { GeometryPanel } from "./GeometryPanel";
import { HSLPanel } from "./HSLPanel";
import { HistoryPanel } from "./HistoryPanel";
import { LocalPanel } from "./LocalPanel";
import { MetaPanel } from "./MetaPanel";
import { PresetsPanel } from "./PresetsPanel";

export interface PanelDef {
  key: string;
  Component: ComponentType;
}

// Ordre par défaut suivant le flux de travail (cf. audit UX §8.1) : Géométrie (recadrage) remonte
// avant Local/Presets, contrairement à l'ancien ordre statique qui la plaçait après Détail/Effets.
// L'Histogramme reste hors de cette liste : lecture passive, pas un panneau d'édition, fixé en
// tête dans `DevelopView`.
export const PANEL_DEFS: PanelDef[] = [
  { key: "basic", Component: BasicPanel },
  { key: "curve", Component: CurvePanel },
  { key: "hsl", Component: HSLPanel },
  { key: "detail", Component: DetailPanel },
  { key: "effects", Component: EffectsPanel },
  { key: "geometry", Component: GeometryPanel },
  { key: "local", Component: LocalPanel },
  { key: "presets", Component: PresetsPanel },
  { key: "history", Component: HistoryPanel },
  { key: "meta", Component: MetaPanel },
];

export const DEFAULT_PANEL_ORDER = PANEL_DEFS.map((p) => p.key);

/** Résout un ordre personnalisé (persisté, potentiellement partiel/périmé) contre la liste
 *  réelle des panneaux : clés inconnues ignorées, panneaux manquants ajoutés à la fin. */
export function resolvePanelOrder(order: string[]): PanelDef[] {
  const byKey = new Map(PANEL_DEFS.map((p) => [p.key, p]));
  const seen = new Set<string>();
  const result: PanelDef[] = [];
  for (const key of order) {
    const def = byKey.get(key);
    if (def && !seen.has(key)) { result.push(def); seen.add(key); }
  }
  for (const def of PANEL_DEFS) {
    if (!seen.has(def.key)) result.push(def);
  }
  return result;
}
