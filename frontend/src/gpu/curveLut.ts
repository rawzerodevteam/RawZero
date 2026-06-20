/**
 * Portage JS exact de pipeline._curve_lut (PCHIP monotone, Fritsch–Carlson).
 * Renvoie une LUT 8 bits (0..255) de longueur `n`, ou null pour la courbe identité.
 */
export function buildCurveLut(points: [number, number][], n = 1024): Uint8Array | null {
  // dédup + arrondi x à 5 décimales + tri (comme côté Python)
  const map = new Map<number, number>();
  for (const p of points) map.set(Math.round(p[0] * 1e5) / 1e5, p[1]);
  const pts = [...map.entries()].sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) return null;

  const x = pts.map((p) => p[0]);
  const y = pts.map((p) => Math.min(1, Math.max(0, p[1])));
  if (pts.length === 2 &&
      Math.abs(y[0]) < 1e-6 && Math.abs(y[1] - 1) < 1e-6 &&
      Math.abs(x[0]) < 1e-6 && Math.abs(x[1] - 1) < 1e-6) {
    return null; // identité
  }

  const k = x.length;
  const h = new Array(k - 1), m = new Array(k - 1);
  for (let i = 0; i < k - 1; i++) {
    h[i] = Math.max(x[i + 1] - x[i], 1e-6);
    m[i] = (y[i + 1] - y[i]) / h[i];
  }
  const d = new Array(k).fill(0);
  d[0] = m[0];
  d[k - 1] = m[k - 2];
  for (let i = 1; i < k - 1; i++) {
    if (m[i - 1] * m[i] <= 0) {
      d[i] = 0;
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      d[i] = (w1 + w2) / (w1 / m[i - 1] + w2 / m[i]);
    }
  }

  const lut = new Uint8Array(n);
  for (let j = 0; j < n; j++) {
    const xs = j / (n - 1);
    let ss = 0;
    while (ss < k && x[ss] < xs) ss++;          // np.searchsorted(side='left')
    const idx = Math.min(Math.max(ss - 1, 0), k - 2);
    const t = (xs - x[idx]) / h[idx];
    let val: number;
    if (xs <= x[0]) val = y[0];
    else if (xs >= x[k - 1]) val = y[k - 1];
    else {
      const h00 = (1 + 2 * t) * (1 - t) ** 2;
      const h10 = t * (1 - t) ** 2;
      const h01 = t * t * (3 - 2 * t);
      const h11 = t * t * (t - 1);
      val = h00 * y[idx] + h10 * h[idx] * d[idx] + h01 * y[idx + 1] + h11 * h[idx] * d[idx + 1];
    }
    lut[j] = Math.round(Math.min(1, Math.max(0, val)) * 255);
  }
  return lut;
}

/**
 * Texture RGBA (largeur n) des courbes pré-composées : pour chaque canal,
 * composed(x) = chan(master(x)). Renvoie null si maître + R/G/B sont tous identité.
 * Strictement aligné sur pipeline._apply_curve (même composition, même ordre).
 */
export function buildCurveTexture(
  curve: { points: [number, number][]; r: [number, number][]; g: [number, number][]; b: [number, number][] },
  n = 1024,
): Uint8Array | null {
  const master = buildCurveLut(curve.points, n);
  const chans = [buildCurveLut(curve.r, n), buildCurveLut(curve.g, n), buildCurveLut(curve.b, n)];
  if (!master && chans.every((c) => !c)) return null;

  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const mv = master ? master[i] / 255 : i / (n - 1);   // maître appliqué (ou identité)
    for (let c = 0; c < 3; c++) {
      const chan = chans[c];
      const out = chan ? chan[Math.round(mv * (n - 1))] / 255 : mv;
      data[i * 4 + c] = Math.round(Math.min(1, Math.max(0, out)) * 255);
    }
    data[i * 4 + 3] = 255;
  }
  return data;
}
