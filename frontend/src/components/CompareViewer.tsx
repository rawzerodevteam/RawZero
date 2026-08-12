import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { useStore } from "../store";
import { useGpuPreview } from "../gpu/useGpuPreview";

function revokeBlobUrl(url: string | null) {
  if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
}

interface Props {
  mode: "side" | "split";
  gpu: boolean;
  srcAfter: string | null;   // rendu serveur « après » déjà utilisé par le viewer normal (repli sans GPU)
  onGpuError?: (message: string) => void;
}

/** Comparaison avant/après visible simultanément (complète le simple bouton « Avant/après » qui
 * bascule l'affichage) : « side » = les deux images côte à côte, « split » = superposées avec un
 * curseur vertical déplaçable qui révèle l'après à droite du trait. Pas d'outils interactifs ici
 * (masques/crop) — un pur aperçu de comparaison, façon Lightroom.
 * En GPU : deux pipelines indépendants via `useGpuPreview` (avant = base neutre figée, après =
 * réglages courants avec mise à jour live pendant un drag de slider). En repli serveur : deux
 * <img> (le rendu « après » déjà géré ailleurs, plus un rendu « avant » dédié).
 * IMPORTANT : les deux modes partagent LA MÊME structure DOM (mêmes <canvas>, seule la mise en
 * page CSS change) — `useGpuPreview` initialise son contexte WebGL une fois sur le nœud canvas et
 * ne le détecte pas s'il est remplacé par un remount ; changer d'arborescence entre les deux
 * modes laisserait le pipeline peindre dans un canvas détaché (écran noir au changement de mode). */
export function CompareViewer({ mode, gpu, srcAfter, onGpuError }: Props) {
  const { t } = useTranslation();
  const stageRef = useRef<HTMLDivElement>(null);
  const beforeCanvasRef = useRef<HTMLCanvasElement>(null);
  const afterCanvasRef = useRef<HTMLCanvasElement>(null);
  const currentId = useStore((s) => s.currentId);
  const edits = useStore((s) => s.edits);
  const [splitPos, setSplitPos] = useState(0.5); // 0..1, position du curseur
  const draggingSplit = useRef(false);

  // Deux pipelines GPU indépendants tournent ici en parallèle (cf. commentaire de composant) : la
  // base "avant" (réglages neutres, purement une référence visuelle statique) est chargée à une
  // résolution réduite pour limiter la VRAM cumulée des deux pipelines (audit1108.md, M5) — la
  // base "après" garde la pleine résolution habituelle, c'est elle qui reflète les retouches.
  const beforeGpu = useGpuPreview(beforeCanvasRef, gpu, false, true, false, null, 1024);
  const afterGpu = useGpuPreview(afterCanvasRef, gpu, false, false, false, null);

  useEffect(() => {
    if (gpu && (beforeGpu.error || afterGpu.error)) onGpuError?.(beforeGpu.error ?? afterGpu.error ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpu, beforeGpu.error, afterGpu.error]);

  // Repli serveur : l'image « après » est déjà fournie par le viewer normal (`srcAfter`) ; il ne
  // manque que l'image « avant » (réglages par défaut par serveur, indépendante des edits — pas
  // besoin de la refaire à chaque réglage), chargée ici quand la comparaison est active.
  const [srcBefore, setSrcBefore] = useState<string | null>(null);
  useEffect(() => {
    if (gpu || currentId === null || !edits) return;
    const ctrl = new AbortController();
    let url: string | null = null;
    api.render(currentId, edits, { maxSize: 2048, before: true, signal: ctrl.signal })
      .then((u) => { url = u; setSrcBefore((old) => { revokeBlobUrl(old); return u; }); })
      .catch((e) => { if ((e as Error).name !== "AbortError") console.error(e); });
    return () => { ctrl.abort(); if (url) URL.revokeObjectURL(url); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rendu "avant" indépendant des edits (before:true)
  }, [gpu, currentId]);
  useEffect(() => () => setSrcBefore((old) => { revokeBlobUrl(old); return null; }), []);

  const onSplitDown = (ev: React.PointerEvent) => {
    draggingSplit.current = true;
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
  };
  const onSplitMove = (ev: React.PointerEvent) => {
    if (!draggingSplit.current || !stageRef.current) return;
    const r = stageRef.current.getBoundingClientRect();
    setSplitPos(Math.min(Math.max((ev.clientX - r.left) / Math.max(r.width, 1), 0.02), 0.98));
  };
  const onSplitUp = () => { draggingSplit.current = false; };
  // Curseur jusque-là uniquement pilotable à la souris/tactile (audit1108.md, L8) : flèches
  // gauche/droite (pas fin), Home/End pour aller aux extrémités — usage clavier standard d'un slider.
  const onSplitKeyDown = (ev: React.KeyboardEvent) => {
    const step = ev.shiftKey ? 0.1 : 0.02;
    if (ev.key === "ArrowLeft") setSplitPos((p) => Math.max(p - step, 0.02));
    else if (ev.key === "ArrowRight") setSplitPos((p) => Math.min(p + step, 0.98));
    else if (ev.key === "Home") setSplitPos(0.02);
    else if (ev.key === "End") setSplitPos(0.98);
    else return;
    ev.preventDefault();
    // Le raccourci global de navigation photo (shortcuts.ts) écoute aussi ArrowLeft/ArrowRight sur
    // `window`, indépendamment de l'élément focalisé — sans stopPropagation, l'événement continue
    // de bouillonner et changeait de photo EN PLUS de déplacer le curseur (ce qui quitte le mode
    // comparaison, cf. `openDevelop`). Repéré en testant le fix L8 lui-même.
    ev.stopPropagation();
  };

  const ready = gpu ? beforeGpu.ready && afterGpu.ready : !!(srcBefore && srcAfter);
  const split = mode === "split";

  return (
    <div
      className={"compare-viewer " + (split ? "compare-split" : "compare-side")}
      ref={stageRef}
    >
      <div className="compare-slot compare-slot-before">
        {gpu
          ? <canvas ref={beforeCanvasRef} className="compare-img" />
          : (srcBefore && <img className="compare-img" src={srcBefore} alt="" draggable={false} />)}
      </div>
      <div
        className="compare-slot compare-slot-after"
        style={split ? { clipPath: `inset(0 0 0 ${splitPos * 100}%)` } : undefined}
      >
        {gpu
          ? <canvas ref={afterCanvasRef} className="compare-img" />
          : (srcAfter && <img className="compare-img" src={srcAfter} alt="" draggable={false} />)}
      </div>
      {/* Étiquettes en enfants directs du conteneur (pas des slots) : peintes APRÈS les deux slots
          dans l'ordre du DOM, donc toujours au-dessus — en mode split, le slot "après" (opaque)
          recouvrait sinon l'étiquette "avant" dès que le curseur approchait du bord gauche
          (audit1108.md, L7). */}
      <span className="compare-label compare-label-left">{t("develop.before")}</span>
      <span className="compare-label compare-label-right">{t("develop.after")}</span>
      {split && (
        <div
          className="compare-split-handle"
          style={{ left: `${splitPos * 100}%` }}
          role="slider"
          tabIndex={0}
          aria-label={t("develop.compareSplitTitle")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(splitPos * 100)}
          onPointerDown={onSplitDown}
          onPointerMove={onSplitMove}
          onPointerUp={onSplitUp}
          onKeyDown={onSplitKeyDown}
        >
          <span className="compare-split-line" />
          <span className="compare-split-grip" />
        </div>
      )}
      {!ready && <div className="viewer-empty">{t("common.loading")}</div>}
    </div>
  );
}
