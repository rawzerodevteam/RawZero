import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

interface Props {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  onReset?: () => void;
  /** Identifiant stable (indépendant de la langue) pour mémoriser l'état ouvert/fermé entre
   * sessions (localStorage). Sans lui, la section retombe sur `defaultOpen` à chaque montage. */
  storageKey?: string;
}

function loadOpen(key: string | undefined, fallback: boolean): boolean {
  if (!key) return fallback;
  try {
    const raw = localStorage.getItem(`rs.panelOpen.${key}`);
    return raw === null ? fallback : raw === "1";
  } catch { return fallback; }
}

export function PanelSection({ title, children, defaultOpen = true, onReset, storageKey }: Props) {
  const { t } = useTranslation();
  const [open, setOpenState] = useState(() => loadOpen(storageKey, defaultOpen));
  const setOpen = (v: boolean) => {
    setOpenState(v);
    if (storageKey) { try { localStorage.setItem(`rs.panelOpen.${storageKey}`, v ? "1" : "0"); } catch { /* ignore */ } }
  };
  return (
    <section className="panel-section">
      <header onClick={() => setOpen(!open)}>
        <span className={"chev" + (open ? " open" : "")}>▸</span>
        <h3>{title}</h3>
        {onReset && (
          <button
            className="mini-btn"
            title={t("section.reset")}
            onClick={(ev) => { ev.stopPropagation(); onReset(); }}
          >
            ↺
          </button>
        )}
      </header>
      {open && <div className="panel-body">{children}</div>}
    </section>
  );
}
