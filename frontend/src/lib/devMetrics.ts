/** Métriques de profilage (dev uniquement). Petit observable lu par le panneau de profilage (F9).
 *  En build de production, `import.meta.env.DEV` est false → on n'enregistre jamais rien. */
import { useSyncExternalStore } from "react";

export interface RenderMetric {
  clientMs: number;          // aller-retour réseau complet côté navigateur
  serverMs: number | null;   // « total » du Server-Timing serveur
  parts: string;             // détail brut du Server-Timing (base/pipeline/encode)
  maxSize: number;           // taille demandée
  bytes: number;             // poids du JPEG reçu
  before: boolean;           // rendu « avant » (base neutre) ?
  at: number;                // horodatage (performance.now)
}

let last: RenderMetric | null = null;
const subs = new Set<() => void>();

/** Parse l'en-tête Server-Timing (« total;dur=123, pipeline;dur=80 ») → ms du total. */
function parseTotal(header: string | null): number | null {
  if (!header) return null;
  const m = /total;dur=([\d.]+)/.exec(header);
  return m ? Math.round(Number(m[1])) : null;
}

export function recordRender(opts: {
  clientMs: number; serverTiming: string | null; maxSize: number; bytes: number; before: boolean;
}): void {
  last = {
    clientMs: Math.round(opts.clientMs),
    serverMs: parseTotal(opts.serverTiming),
    parts: opts.serverTiming ?? "",
    maxSize: opts.maxSize,
    bytes: opts.bytes,
    before: opts.before,
    at: performance.now(),
  };
  subs.forEach((f) => f());
}

function subscribe(f: () => void): () => void {
  subs.add(f);
  return () => subs.delete(f);
}

/** Hook React : renvoie la dernière métrique de rendu (ou null). */
export function useRenderMetric(): RenderMetric | null {
  return useSyncExternalStore(subscribe, () => last, () => last);
}
