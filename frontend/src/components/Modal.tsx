import { useEffect, type CSSProperties, type ReactNode } from "react";
import { useFocusTrap } from "../lib/useFocusTrap";

/** Wrapper de modale générique : backdrop + `role="dialog"`/`aria-modal`, focus-trap et
 *  restitution du focus au déclencheur (cf. audit UX §11.5). Remplace le markup
 *  `modal-backdrop`/`modal` que chaque dialogue dupliquait auparavant. Ferme aussi au clavier
 *  (Échap) directement ici : certaines modales (GpuDiffDialog, RelinkDialog) ne passent pas par
 *  l'état du store géré centralement dans `shortcuts.ts`. */
export function Modal({ onClose, className = "", labelledBy, closeOnBackdrop = true, style, children }: {
  onClose?: () => void;
  className?: string;
  labelledBy?: string;
  closeOnBackdrop?: boolean;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const ref = useFocusTrap<HTMLDivElement>(true);

  useEffect(() => {
    if (!closeOnBackdrop || !onClose) return;
    const onKeyDown = (ev: KeyboardEvent) => { if (ev.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeOnBackdrop, onClose]);

  return (
    <div className="modal-backdrop" onClick={closeOnBackdrop ? onClose : undefined}>
      <div
        ref={ref}
        className={"modal " + className}
        onClick={(ev) => ev.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        style={style}
      >
        {children}
      </div>
    </div>
  );
}
