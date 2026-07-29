import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "../store";

/** Histogramme RGB + luminance calculé côté client depuis le rendu courant. */
export function Histogram({ src }: { src: string | null }) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [clip, setClip] = useState({ lo: false, hi: false });
  const showClipping = useStore((s) => s.showClipping);
  const setUI = useStore((s) => s.setUI);

  useEffect(() => {
    if (!src || !canvasRef.current) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled || !canvasRef.current) return;
      const w = 256;
      const h = Math.max(Math.round((img.height / img.width) * w), 1);
      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const octx = off.getContext("2d", { willReadFrequently: true })!;
      octx.drawImage(img, 0, 0, w, h);
      const data = octx.getImageData(0, 0, w, h).data;
      const hr = new Float64Array(256), hg = new Float64Array(256),
            hb = new Float64Array(256), hl = new Float64Array(256);
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        hr[r]++; hg[g]++; hb[b]++;
        hl[Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)]++;
      }
      const total = data.length / 4;
      setClip({
        lo: (hr[0] + hg[0] + hb[0]) / (3 * total) > 0.003,
        hi: (hr[255] + hg[255] + hb[255]) / (3 * total) > 0.003,
      });
      const cv = canvasRef.current;
      const W = cv.width, H = cv.height;
      const ctx = cv.getContext("2d")!;
      ctx.clearRect(0, 0, W, H);
      const peak = Math.max(...hl, ...hr, ...hg, ...hb, 1);
      const scaleY = (v: number) => H - (Math.sqrt(v / peak)) * (H - 4);
      const drawCurve = (hist: Float64Array, color: string, fill: boolean) => {
        ctx.beginPath();
        ctx.moveTo(0, H);
        for (let x = 0; x < 256; x++) ctx.lineTo((x / 255) * W, scaleY(hist[x]));
        ctx.lineTo(W, H);
        if (fill) { ctx.fillStyle = color; ctx.fill(); }
        else { ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke(); }
      };
      drawCurve(hl, "rgba(190,190,190,0.35)", true);
      ctx.globalCompositeOperation = "screen";
      drawCurve(hr, "rgba(235,80,80,0.9)", false);
      drawCurve(hg, "rgba(90,210,120,0.9)", false);
      drawCurve(hb, "rgba(90,140,255,0.9)", false);
      ctx.globalCompositeOperation = "source-over";
    };
    img.src = src;
    return () => { cancelled = true; };
  }, [src]);

  return (
    <div className="histogram">
      <canvas ref={canvasRef} width={280} height={110} />
      <button type="button"
        className={"clip-dot left" + (clip.lo ? " on" : "") + (showClipping ? " active" : "")}
        title={t("histogram.clipLow")} aria-label={t("histogram.clipLow")} aria-pressed={showClipping}
        onClick={() => setUI({ showClipping: !showClipping })} />
      <button type="button"
        className={"clip-dot right" + (clip.hi ? " on" : "") + (showClipping ? " active" : "")}
        title={t("histogram.clipHigh")} aria-label={t("histogram.clipHigh")} aria-pressed={showClipping}
        onClick={() => setUI({ showClipping: !showClipping })} />
    </div>
  );
}
