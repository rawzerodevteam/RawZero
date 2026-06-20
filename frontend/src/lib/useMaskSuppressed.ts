import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";

const LINGER_MS = 350;

/**
 * Vrai pendant qu'on manipule un slider (`dragBaseline != null`) ET un court instant après
 * le relâchement. Sert à masquer l'overlay rouge du masque local pendant le réglage, pour
 * voir l'effet ; le « linger » garantit une fenêtre sans overlay même sur un clic rapide,
 * où pointerdown/pointerup sont trop proches pour qu'une frame sans masque soit peinte.
 */
export function useMaskSuppressed(): boolean {
  const dragging = useStore((s) => s.dragBaseline != null);
  const [suppressed, setSuppressed] = useState(dragging);
  const timer = useRef<number>();
  useEffect(() => {
    window.clearTimeout(timer.current);
    if (dragging) { setSuppressed(true); return; }
    timer.current = window.setTimeout(() => setSuppressed(false), LINGER_MS);
    return () => window.clearTimeout(timer.current);
  }, [dragging]);
  return suppressed;
}
