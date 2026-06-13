import { useState, type ReactNode } from "react";

interface Props {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  onReset?: () => void;
}

export function PanelSection({ title, children, defaultOpen = true, onReset }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="panel-section">
      <header onClick={() => setOpen(!open)}>
        <span className={"chev" + (open ? " open" : "")}>▸</span>
        <h3>{title}</h3>
        {onReset && (
          <button
            className="mini-btn"
            title="Réinitialiser la section"
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
