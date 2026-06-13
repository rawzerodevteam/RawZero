import { api } from "../api";
import { GpuPipeline } from "./pipeline";
import type { EditState, Photo } from "../types";

export interface DiffStats {
  w: number; h: number;
  meanR: number; meanG: number; meanB: number;  // écart absolu moyen par canal (0..255)
  mean: number; max: number;                     // moyen global, max
  pctOver5: number; pctOver10: number;           // % de pixels dont l'écart max dépasse 5 / 10
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
 * Mesure l'écart aperçu-GPU ↔ pipeline-Python pour une photo et ses réglages, à `maxSize`.
 * Les deux partent de la MÊME base neutre serveur (≤ maxSize) puis appliquent leur pipeline,
 * donc l'écart isole bien la différence d'implémentation GPU/CPU (hors quantification 8 bits).
 */
export async function measureDivergence(photo: Photo, edits: EditState, maxSize = 1600): Promise<DiffStats> {
  const fullLong = Math.max(photo.width, photo.height) || 1;
  const baseUrl = await api.render(photo.id, {} as EditState, { before: true, maxSize });
  let pyUrl = "";
  try {
    // 1) sortie GPU (rendue dans un canvas jetable, lue en arrière → flip vertical)
    const baseImg = await loadImage(baseUrl);
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 indisponible");
    const pipe = new GpuPipeline(gl);
    pipe.setBase(baseImg, fullLong);
    pipe.render(edits);
    const gw = canvas.width, gh = canvas.height;
    const gpu = new Uint8Array(gw * gh * 4);
    gl.readPixels(0, 0, gw, gh, gl.RGBA, gl.UNSIGNED_BYTE, gpu);

    // 2) sortie Python à la même taille, redimensionnée aux dims GPU (aligne l'arrondi ±1 px)
    pyUrl = await api.render(photo.id, edits, { maxSize });
    const pyImg = await loadImage(pyUrl);
    const c2 = document.createElement("canvas");
    c2.width = gw; c2.height = gh;
    const ctx = c2.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(pyImg, 0, 0, gw, gh);
    const py = ctx.getImageData(0, 0, gw, gh).data;

    let sR = 0, sG = 0, sB = 0, max = 0, over5 = 0, over10 = 0;
    const N = gw * gh;
    for (let y = 0; y < gh; y++) {
      const gRow = (gh - 1 - y) * gw * 4;  // GPU : origine en bas
      const pRow = y * gw * 4;
      for (let x = 0; x < gw; x++) {
        const gi = gRow + x * 4, pi = pRow + x * 4;
        const dr = Math.abs(gpu[gi] - py[pi]);
        const dg = Math.abs(gpu[gi + 1] - py[pi + 1]);
        const db = Math.abs(gpu[gi + 2] - py[pi + 2]);
        sR += dr; sG += dg; sB += db;
        const m = Math.max(dr, dg, db);
        if (m > max) max = m;
        if (m > 5) over5++;
        if (m > 10) over10++;
      }
    }
    gl.getExtension("WEBGL_lose_context")?.loseContext(); // libère le contexte jetable
    return {
      w: gw, h: gh,
      meanR: sR / N, meanG: sG / N, meanB: sB / N, mean: (sR + sG + sB) / (3 * N),
      max, pctOver5: (100 * over5) / N, pctOver10: (100 * over10) / N,
    };
  } finally {
    URL.revokeObjectURL(baseUrl);
    if (pyUrl) URL.revokeObjectURL(pyUrl);
  }
}
