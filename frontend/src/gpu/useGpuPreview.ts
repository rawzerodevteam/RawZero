import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { api } from "../api";
import { GpuPipeline } from "./pipeline";
import { useStore, registerLiveRender } from "../store";
import { defaultEdits, type EditState } from "../types";

interface GpuState {
  ready: boolean;
  error: string | null;
  dims: { w: number; h: number };
}

// Délai d'immobilité du curseur (drag toujours enfoncé) avant le re-rendu pleine qualité.
const SETTLE_MS = 90;

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
  maskOverlayId: string | null,
): GpuState {
  const pipeRef = useRef<GpuPipeline | null>(null);
  const ctxFailed = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [asyncTick, setAsyncTick] = useState(0); // re-rendu quand un bitmap de masque IA est chargé

  const currentId = useStore((s) => s.currentId);
  const edits = useStore((s) => s.edits);
  const isDragging = useStore((s) => s.dragBaseline !== null);
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
      pipeRef.current.requestRerender = () => setAsyncTick((t) => t + 1);
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

  // Base débruitée IA : chargée à la demande (réseau) quand le réglage NR IA devient actif,
  // une seule fois par photo. Le slider ne fait ensuite qu'un mélange GPU temps réel.
  const nrAi = edits?.detail?.nr_ai ?? 0;
  const dnLoadedFor = useRef<number | null>(null);
  useEffect(() => {
    if (!active || !ready || currentId === null || ctxFailed.current) return;
    if (nrAi <= 0 || dnLoadedFor.current === currentId) return;
    const ctrl = new AbortController();
    let url: string | null = null;
    api.denoisedBase(currentId, { maxSize: 1600, signal: ctrl.signal })
      .then((u) => { url = u; return u ? loadImage(u) : null; })
      .then((img) => {
        if (ctrl.signal.aborted || !pipeRef.current || !img) return;
        pipeRef.current.setDenoiseBase(img);
        dnLoadedFor.current = currentId;
        setAsyncTick((t) => t + 1);
      })
      .catch((e) => { if ((e as Error).name !== "AbortError") setError(String(e)); });
    return () => { ctrl.abort(); if (url) URL.revokeObjectURL(url); };
  }, [active, ready, currentId, nrAi]);

  // Fonction de rendu impérative, réassignée à chaque rendu pour capturer les derniers paramètres
  // (active/ready/skipCrop/beforeAfter/showClip/maskOverlayId). Appelée par le store PENDANT un drag
  // de slider (chemin découplé) : il mute `edits` en place puis nous demande de peindre, sans passer
  // par un setState/re-render React. quality=0.6 → gain quadratique pendant le drag.
  const renderImperative = useRef<(e: EditState) => void>();
  const settleRef = useRef<number>();
  renderImperative.current = (e) => {
    const pipe = pipeRef.current;
    if (!active || !pipe || !ready) return;
    const ovl = beforeAfter || skipCrop ? null : maskOverlayId;
    const paint = (src: EditState, q: number) => {
      pipe.render(beforeAfter ? defaultEdits() : src, skipCrop, showClip, ovl, q);
      const c = canvasRef.current;
      if (c) setDims((d) => (d.w !== c.width || d.h !== c.height ? { w: c.width, h: c.height } : d));
    };
    paint(e, 0.6); // draft pendant le mouvement
    // Raffinement progressif : si le curseur se stabilise ~90 ms TOUT EN restant enfoncé (pas de
    // nouveau draft entre-temps), on repeint en pleine qualité sans attendre le relâchement. Si le
    // slider est relâché avant, le chemin de release (useLayoutEffect, isDragging→false) rend déjà
    // en HD → le timer s'auto-annule via la garde dragBaseline.
    if (settleRef.current !== undefined) clearTimeout(settleRef.current);
    settleRef.current = window.setTimeout(() => {
      settleRef.current = undefined;
      const st = useStore.getState();
      if (!pipeRef.current || st.dragBaseline === null || !st.edits) return;
      paint(st.edits, 1);
    }, SETTLE_MS);
  };
  // Branché UNIQUEMENT quand l'aperçu GPU est actif : c'est la présence de ce callback qui dit au
  // store d'emprunter le chemin découplé (en place) plutôt que clone+setState (cf. flushLiveEdit).
  useEffect(() => {
    if (!active) return;
    registerLiveRender((e) => renderImperative.current?.(e));
    return () => { registerLiveRender(null); if (settleRef.current) clearTimeout(settleRef.current); };
  }, [active]);

  // Rendu à chaque changement de réglage / d'état (sans réseau). En useLayoutEffect SYNCHRONE :
  // le canvas se peint dans LA MÊME frame que le commit React. Pendant un drag, le store ne passe
  // PLUS par ici (mutation en place → pas de changement de `edits`) : c'est `renderImperative` qui
  // peint. Ce useLayoutEffect couvre les changements hors drag ET le rendu HD au relâchement
  // (isDragging repasse à false → quality 1).
  useLayoutEffect(() => {
    if (!active || !pipeRef.current || !ready || !edits) return;
    const pipe = pipeRef.current;
    const ovl = beforeAfter || skipCrop ? null : maskOverlayId;
    pipe.render(beforeAfter ? defaultEdits() : edits, skipCrop, showClip, ovl, isDragging ? 0.6 : 1);
    const c = canvasRef.current;
    if (c) setDims((d) => (d.w !== c.width || d.h !== c.height ? { w: c.width, h: c.height } : d));
  }, [active, edits, ready, skipCrop, beforeAfter, showClip, maskOverlayId, isDragging, canvasRef, asyncTick]);

  return { ready, error, dims };
}
