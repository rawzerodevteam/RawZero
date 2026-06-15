import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { useRenderMetric } from "../lib/devMetrics";

/** Panneau de profilage (diagnostic). Bascule avec F9 (touche libre, aucun conflit).
 *  Caché par défaut : un utilisateur normal ne le voit jamais.
 *  Affiche état du store, dernier rendu (client/serveur), FPS et mémoire JS. */
export function DevOverlay() {
  const [open, setOpen] = useState(false);
  const [fps, setFps] = useState(0);
  const [heap, setHeap] = useState(0);

  const view = useStore((s) => s.view);
  const photosCount = useStore((s) => s.photos.length);
  const selectionCount = useStore((s) => s.selection.length);
  const currentId = useStore((s) => s.currentId);
  const projectsCount = useStore((s) => s.projects.length);
  const dirty = useStore((s) => s.dirty);
  const metric = useRenderMetric();

  // Bascule clavier : F9 (touche libre, ne sert ni dans l'app ni dans le navigateur).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F9") { e.preventDefault(); setOpen((v) => !v); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Compteur de FPS + mémoire, actif seulement quand le panneau est ouvert.
  const frames = useRef(0);
  const lastT = useRef(performance.now());
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const loop = () => {
      frames.current++;
      const now = performance.now();
      if (now - lastT.current >= 500) {
        setFps(Math.round((frames.current * 1000) / (now - lastT.current)));
        frames.current = 0;
        lastT.current = now;
        const mem = (performance as any).memory?.usedJSHeapSize;
        if (mem) setHeap(Math.round(mem / 1048576));
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [open]);

  if (!open) return null;

  const kb = metric ? Math.round(metric.bytes / 1024) : 0;

  return (
    <div className="dev-overlay">
      <div className="dev-head">
        ⚙ Profilage <span className="dev-dim">F9</span>
        <button className="dev-close" onClick={() => setOpen(false)}>✕</button>
      </div>
      <Row k="Vue" v={view} />
      <Row k="Photos / projets" v={`${photosCount} / ${projectsCount}`} />
      <Row k="Sélection" v={String(selectionCount)} />
      <Row k="Photo courante" v={currentId === null ? "—" : `#${currentId}`} />
      <Row k="Edits non sauvés" v={dirty ? "oui" : "non"} />
      <div className="dev-sep" />
      <Row k="FPS" v={String(fps)} />
      {heap > 0 && <Row k="Heap JS" v={`${heap} Mo`} />}
      <div className="dev-sep" />
      {metric ? (
        <>
          <Row k="Dernier rendu" v={metric.before ? "base neutre" : "édité"} />
          <Row k="Client (aller-retour)" v={`${metric.clientMs} ms`} />
          <Row k="Serveur (total)" v={metric.serverMs !== null ? `${metric.serverMs} ms` : "—"} />
          {metric.parts && <div className="dev-parts">{metric.parts}</div>}
          <Row k="Taille / poids" v={`${metric.maxSize}px · ${kb} Ko`} />
        </>
      ) : (
        <div className="dev-dim">Aucun rendu encore mesuré.</div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="dev-row">
      <span className="dev-k">{k}</span>
      <span className="dev-v">{v}</span>
    </div>
  );
}
