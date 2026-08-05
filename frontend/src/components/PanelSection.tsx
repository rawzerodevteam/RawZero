import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IconChevron, IconReset } from "../icons";

interface Props {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  onReset?: () => void;
  /** Identifiant stable (indépendant de la langue) pour mémoriser l'état ouvert/fermé entre
   * sessions (localStorage). Sans lui, la section retombe sur `defaultOpen` à chaque montage. */
  storageKey?: string;
  /** Appelé quand la section s'ouvre/se ferme (ex. désélectionner le masque local à la
   * fermeture du panneau Local — issue #43). */
  onToggle?: (open: boolean) => void;
}

function loadOpen(key: string | undefined, fallback: boolean): boolean {
  if (!key) return fallback;
  try {
    const raw = localStorage.getItem(`rs.panelOpen.${key}`);
    return raw === null ? fallback : raw === "1";
  } catch { return fallback; }
}

export function PanelSection({ title, children, defaultOpen = true, onReset, storageKey, onToggle }: Props) {
  const { t } = useTranslation();
  const [open, setOpenState] = useState(() => loadOpen(storageKey, defaultOpen));
  const setOpen = (v: boolean) => {
    setOpenState(v);
    if (storageKey) { try { localStorage.setItem(`rs.panelOpen.${storageKey}`, v ? "1" : "0"); } catch { /* ignore */ } }
    onToggle?.(v);
  };
  return (
    <section className="panel-section" data-panel-key={storageKey}>
      <header
        onClick={() => setOpen(!open)}
        draggable={!!storageKey}
        onDragStart={(ev) => { if (storageKey) ev.dataTransfer.setData("text/rs-panel-key", storageKey); }}
      >
        <IconChevron size={9} className={"chev" + (open ? " open" : "")} />
        <h3>{title}</h3>
        {onReset && (
          <button
            className="mini-btn"
            title={t("section.reset")}
            aria-label={t("section.reset")}
            onClick={(ev) => { ev.stopPropagation(); onReset(); }}
          >
            <IconReset size={12} />
          </button>
        )}
      </header>
      {open && <div className="panel-body">{children}</div>}
    </section>
  );
}
