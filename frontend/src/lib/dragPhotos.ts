/** Transfert d'ids de photos par glisser-déposer (grille → album). */
import type { DragEvent } from "react";

const MIME = "application/x-rawzero-photos";

export function setDragIds(ev: DragEvent, ids: number[]): void {
  ev.dataTransfer.setData(MIME, JSON.stringify(ids));
  ev.dataTransfer.setData("text/plain", String(ids.length));
  ev.dataTransfer.effectAllowed = "copy";
}

export function parseDragIds(ev: DragEvent): number[] {
  try {
    const raw = ev.dataTransfer.getData(MIME);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((n) => Number.isFinite(n)) : [];
  } catch {
    return [];
  }
}

export function hasDragIds(ev: DragEvent): boolean {
  return ev.dataTransfer.types.includes(MIME);
}
