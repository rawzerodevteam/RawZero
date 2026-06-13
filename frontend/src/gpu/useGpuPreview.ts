import { useEffect, useRef, useState, type RefObject } from "react";
import { api } from "../api";
import { GpuPipeline } from "./pipeline";
import { useStore } from "../store";
import { defaultEdits } from "../types";

interface GpuState {
  ready: boolean;
  error: string | null;
  dims: { w: number; h: number };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = url;
  });
}

/**
 * Pilote un GpuPipeline qui rend dans le canvas fourni (aperçu temps réel sans réseau).
 * Charge UNE fois la base neutre (serveur, ≤1600 px), puis rejoue le pipeline à chaque édition.
 * Le cycle de vie est lié à `active` : le contexte est (re)créé quand l'aperçu GPU est allumé.
 *
 * @param skipCrop  outil de recadrage actif → rendre l'image entière (le cadre est dessiné par-dessus)
 * @param beforeAfter  afficher la base neutre (réglages par défaut) au lieu de l'image éditée
 */
export function useGpuPreview(
  canvasRef: RefObject<HTMLCanvasElement>,
  active: boolean,
  skipCrop: boolean,
  beforeAfter: boolean,
  showClip: boolean,
): GpuState {
  const pipeRef = useRef<GpuPipeline | null>(null);
  const ctxFailed = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [dims, setDims] = useState({ w: 0, h: 0 });

  const currentId = useStore((s) => s.currentId);
  const edits = useStore((s) => s.edits);
  const fullLong = useStore((s) => {
    const p = s.photos.find((ph) => ph.id === s.currentId);
    return p ? Math.max(p.width, p.height) : 1;
  });

  // (Re)création du contexte + moteur quand l'aperçu GPU est activé
  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    ctxFailed.current = false; setError(null); setReady(false);
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: false });
    if (!gl) { ctxFailed.current = true; setError("WebGL2 indisponible dans ce navigateur."); return; }
    try {
      pipeRef.current = new GpuPipeline(gl);
    } catch (e) {
      ctxFailed.current = true; setError(String(e));
    }
    return () => { pipeRef.current = null; };
  }, [active, canvasRef]);

  // (Re)chargement de la base neutre (annulable) à l'activation / au changement de photo
  useEffect(() => {
    if (!active || currentId === null || ctxFailed.current) return;
    const ctrl = new AbortController();
    let url: string | null = null;
    setReady(false);
    api.render(currentId, useStore.getState().edits ?? ({} as any),
               { before: true, maxSize: 1600, signal: ctrl.signal })
      .then((u) => { url = u; return loadImage(u); })
      .then((img) => {
        if (ctrl.signal.aborted || !pipeRef.current) return;
        pipeRef.current.setBase(img, fullLong);
        setReady(true);
      })
      .catch((e) => { if ((e as Error).name !== "AbortError") setError(String(e)); });
    return () => { ctrl.abort(); if (url) URL.revokeObjectURL(url); };
  }, [active, currentId]);

  // Rendu à chaque changement de réglage / d'état (synchrone, sans réseau)
  useEffect(() => {
    if (!active || !pipeRef.current || !ready || !edits) return;
    pipeRef.current.render(beforeAfter ? defaultEdits() : edits, skipCrop, showClip);
    const c = canvasRef.current;
    if (c) setDims((d) => (d.w !== c.width || d.h !== c.height ? { w: c.width, h: c.height } : d));
  }, [active, edits, ready, skipCrop, beforeAfter, showClip, canvasRef]);

  return { ready, error, dims };
}
