import { useTranslation } from "react-i18next";
import { useStore } from "../store";

/** Pile de notifications empilables (succès/erreur/info), avec fermeture manuelle et action
 * optionnelle (ex. « Annuler »). Remplace l'ancien toast unique qui écrasait le précédent
 * (cf. audit UX §13.1). */
export function ToastStack() {
  const { t } = useTranslation();
  const toasts = useStore((s) => s.toasts);
  const dismissToast = useStore((s) => s.dismissToast);
  if (!toasts.length) return null;
  return (
    <div className="toast-stack">
      {toasts.map((tst) => (
        <div key={tst.id} className={"toast toast-" + tst.type}>
          <span className="toast-msg">{tst.msg}</span>
          {tst.action && (
            <button className="toast-action" onClick={() => { tst.action!.onClick(); dismissToast(tst.id); }}>
              {tst.action.label}
            </button>
          )}
          <button className="toast-close" title={t("common.close")} aria-label={t("common.close")}
            onClick={() => dismissToast(tst.id)}>✕</button>
        </div>
      ))}
    </div>
  );
}
