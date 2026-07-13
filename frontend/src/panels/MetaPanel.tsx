import { useTranslation } from "react-i18next";
import { PanelSection } from "../components/PanelSection";
import { useStore } from "../store";

function fmtDate(s: string): string {
  if (!s) return "—";
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString();
}

export function MetaPanel() {
  const { t } = useTranslation();
  const photo = useStore((s) => s.photos.find((p) => p.id === s.currentId));
  if (!photo) return null;

  const rows: [string, string][] = [
    [t("meta.file"), photo.filename],
    [t("meta.dimensions"), photo.width && photo.height ? `${photo.width} × ${photo.height}` : "—"],
    [t("meta.captured"), fmtDate(photo.captured_at)],
    [t("meta.imported"), fmtDate(photo.imported_at)],
    [t("meta.camera"), photo.camera || "—"],
    [t("meta.lens"), photo.lens || "—"],
    ["ISO", photo.iso ? String(photo.iso) : "—"],
    [t("meta.aperture"), photo.aperture ? `f/${photo.aperture}` : "—"],
    [t("meta.shutter"), photo.shutter || "—"],
    [t("meta.focal"), photo.focal ? `${photo.focal} mm` : "—"],
  ];

  return (
    <PanelSection title="EXIF" defaultOpen={false} storageKey="meta">
      <table className="meta-table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td title={v}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </PanelSection>
  );
}
