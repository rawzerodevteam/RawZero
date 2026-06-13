import { PanelSection } from "../components/PanelSection";
import { useStore } from "../store";

function fmtDate(s: string): string {
  if (!s) return "—";
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString("fr-FR");
}

export function MetaPanel() {
  const photo = useStore((s) => s.photos.find((p) => p.id === s.currentId));
  if (!photo) return null;

  const rows: [string, string][] = [
    ["Fichier", photo.filename],
    ["Dimensions", photo.width && photo.height ? `${photo.width} × ${photo.height}` : "—"],
    ["Capturée le", fmtDate(photo.captured_at)],
    ["Importée le", fmtDate(photo.imported_at)],
    ["Boîtier", photo.camera || "—"],
    ["Objectif", photo.lens || "—"],
    ["ISO", photo.iso ? String(photo.iso) : "—"],
    ["Ouverture", photo.aperture ? `f/${photo.aperture}` : "—"],
    ["Vitesse", photo.shutter || "—"],
    ["Focale", photo.focal ? `${photo.focal} mm` : "—"],
  ];

  return (
    <PanelSection title="EXIF" defaultOpen={false}>
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
