import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { useStore } from "../store";
import { useGpuPreview } from "../gpu/useGpuPreview";

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

  const beforeGpu = useGpuPreview(beforeCanvasRef, gpu, false, true, false, null);
  const afterGpu = useGpuPreview(afterCanvasRef, gpu, false, false, false, null);

  useEffect(() => {
    if (gpu && (beforeGpu.error || afterGpu.error)) onGpuError?.(beforeGpu.error ?? afterGpu.error ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpu, beforeGpu.error, afterGpu.error]);

  // Repli serveur : l'image « après » est déjà fournie par le viewer normal (`srcAfter`) ; il ne
  // manque que l'image « avant » (réglages par défaut), chargée ici quand la comparaison est active.
  const [srcBefore, setSrcBefore] = useState<string | null>(null);
  useEffect(() => {
    if (gpu || currentId === null || !edits) return;
    const ctrl = new AbortController();
    let url: string | null = null;
    api.render(currentId, edits, { maxSize: 2048, before: true, signal: ctrl.signal })
      .then((u) => { url = u; setSrcBefore((old) => { if (old?.startsWith("blob:")) URL.revokeObjectURL(old); return u; }); })
      .catch((e) => { if ((e as Error).name !== "AbortError") console.error(e); });
    return () => { ctrl.abort(); if (url) URL.revokeObjectURL(url); };
  }, [gpu, currentId, edits]);
  useEffect(() => () => { setSrcBefore((old) => { if (old?.startsWith("blob:")) URL.revokeObjectURL(old); return null; }); }, []);

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

  const ready = gpu ? beforeGpu.ready && afterGpu.ready : !!(srcBefore && srcAfter);
  const split = mode === "split";

  return (
    <div
      className={"compare-viewer " + (split ? "compare-split" : "compare-side")}
      ref={stageRef}
      onPointerMove={split ? onSplitMove : undefined}
      onPointerUp={split ? onSplitUp : undefined}
      onPointerLeave={split ? onSplitUp : undefined}
    >
      <div className="compare-slot compare-slot-before">
        <span className="compare-label compare-label-left">{t("develop.before")}</span>
        {gpu
          ? <canvas ref={beforeCanvasRef} className="compare-img" />
          : (srcBefore && <img className="compare-img" src={srcBefore} alt="" draggable={false} />)}
      </div>
      <div
        className="compare-slot compare-slot-after"
        style={split ? { clipPath: `inset(0 0 0 ${splitPos * 100}%)` } : undefined}
      >
        <span className="compare-label compare-label-right">{t("develop.after")}</span>
        {gpu
          ? <canvas ref={afterCanvasRef} className="compare-img" />
          : (srcAfter && <img className="compare-img" src={srcAfter} alt="" draggable={false} />)}
      </div>
      {split && (
        <div
          className="compare-split-handle"
          style={{ left: `${splitPos * 100}%` }}
          onPointerDown={onSplitDown}
          onPointerMove={onSplitMove}
          onPointerUp={onSplitUp}
        >
          <span className="compare-split-line" />
          <span className="compare-split-grip" />
        </div>
      )}
      {!ready && <div className="viewer-empty">{t("common.loading")}</div>}
    </div>
  );
}
