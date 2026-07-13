import { useTranslation } from "react-i18next";
import { EditSlider } from "../components/EditSlider";
import { PanelSection } from "../components/PanelSection";
import { CROP_ASPECTS as ASPECTS } from "../lib/cropAspects";
import { useStore } from "../store";
import { defaultEdits } from "../types";
import { IconFlipH, IconFlipV, IconRotateLeft, IconRotateRight } from "../icons";

export function GeometryPanel() {
  const { t } = useTranslation();
  const hasEdits = useStore((s) => s.edits !== null);
  const flipH = useStore((s) => s.edits?.geometry.flip_h ?? false);
  const flipV = useStore((s) => s.edits?.geometry.flip_v ?? false);
  const updateEdits = useStore((s) => s.updateEdits);
  const activeTool = useStore((s) => s.activeTool);
  const cropAspect = useStore((s) => s.cropAspect);
  const setCropAspect = useStore((s) => s.setCropAspect);
  const setUI = useStore((s) => s.setUI);
  if (!hasEdits) return null;

  return (
    <PanelSection
      title={t("geometry.title")}
      defaultOpen={false}
      storageKey="geometry"
      onReset={() => {
        updateEdits((e) => { e.geometry = defaultEdits().geometry; });
        setUI({ activeTool: "none", cropAspect: null });
      }}
    >
      <div className="row-actions">
        <button className="btn" title={t("geometry.rotateCcw")}
          onClick={() => updateEdits((e) => { e.geometry.rotate = (e.geometry.rotate + 270) % 360; })}>
          <IconRotateLeft size={14} /> 90°
        </button>
        <button className="btn" title={t("geometry.rotateCw")}
          onClick={() => updateEdits((e) => { e.geometry.rotate = (e.geometry.rotate + 90) % 360; })}>
          <IconRotateRight size={14} /> 90°
        </button>
        <button className={"btn" + (flipH ? " active" : "")} title={t("geometry.flipH")}
          onClick={() => updateEdits((e) => { e.geometry.flip_h = !e.geometry.flip_h; })}>
          <IconFlipH size={14} /> H
        </button>
        <button className={"btn" + (flipV ? " active" : "")} title={t("geometry.flipV")}
          onClick={() => updateEdits((e) => { e.geometry.flip_v = !e.geometry.flip_v; })}>
          <IconFlipV size={14} /> V
        </button>
      </div>
      <EditSlider label={t("geometry.straighten")} get={(e) => e.geometry.straighten} min={-10} max={10} step={0.1}
        fmt={(v) => v.toFixed(1) + "°"} apply={(e, v) => { e.geometry.straighten = v; }} />
      <h4>{t("geometry.crop")}</h4>
      <div className="row-actions">
        <button
          className={"btn" + (activeTool === "crop" ? " active" : "")}
          onClick={() => setUI({ activeTool: activeTool === "crop" ? "none" : "crop" })}
        >
          {activeTool === "crop" ? t("geometry.cropDone") : t("geometry.cropStart")}
        </button>
        <button className="btn"
          onClick={() => updateEdits((e) => { e.geometry.crop = { x: 0, y: 0, w: 1, h: 1 }; })}>
          {t("geometry.cropClear")}
        </button>
      </div>
      {activeTool === "crop" && (
        <div className="row-actions">
          {ASPECTS.map(([label, ratio]) => (
            <button
              key={label}
              className={"btn small" + (cropAspect === ratio ? " active" : "")}
              onClick={() => setCropAspect(ratio)}
            >
              {label === "Libre" ? t("crop.free") : label}
            </button>
          ))}
        </div>
      )}
    </PanelSection>
  );
}
