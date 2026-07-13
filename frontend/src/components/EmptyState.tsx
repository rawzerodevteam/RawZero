import type { ReactNode } from "react";

/** État vide générique (cf. audit UX §2.5/§13.3) : remplace les blocs `.empty-state` ad-hoc
 *  dupliqués dans chaque vue par un seul composant, avec CTA optionnel. */
export function EmptyState({ icon, title, message, cta }: {
  icon?: ReactNode;
  title?: string;
  message: string;
  cta?: { label: string; onClick: () => void };
}) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-state-icon">{icon}</div>}
      {title && <h3>{title}</h3>}
      <p>{message}</p>
      {cta && <button className="btn primary" onClick={cta.onClick}>{cta.label}</button>}
    </div>
  );
}
