import { useEffect, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useFocusTrap } from "./useFocusTrap";

type DialogRequest =
  | { kind: "confirm"; message: string; danger?: boolean; resolve: (v: boolean) => void }
  | { kind: "prompt"; message: string; defaultValue: string; resolve: (v: string | null) => void };

let current: DialogRequest | null = null;
let setter: ((r: DialogRequest | null) => void) | null = null;

function push(req: DialogRequest) {
  current = req;
  setter?.(req);
}

/** Remplace `window.confirm` par un dialogue thématisé (cf. audit UX §1.1). Utilisable partout,
 * y compris hors composant React (ex. `shortcuts.ts`). */
export function confirmDialog(message: string, opts?: { danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => push({ kind: "confirm", message, danger: opts?.danger, resolve }));
}

/** Remplace `window.prompt`. Renvoie `null` si annulé ou si la saisie est vide après trim. */
export function promptDialog(message: string, defaultValue = ""): Promise<string | null> {
  return new Promise((resolve) => push({ kind: "prompt", message, defaultValue, resolve }));
}

/** Monté une seule fois (App.tsx) : affiche le dialogue courant, s'il y en a un. */
export function DialogHost() {
  const { t } = useTranslation();
  const [req, setReq] = useState<DialogRequest | null>(current);
  const [value, setValue] = useState("");
  const trapRef = useFocusTrap<HTMLDivElement>(req !== null);

  useEffect(() => {
    setter = setReq;
    return () => { setter = null; };
  }, []);

  useEffect(() => {
    if (req?.kind === "prompt") setValue(req.defaultValue);
  }, [req]);

  if (!req) return null;

  const cancelValue = req.kind === "confirm" ? false : null;
  const finish = (result: boolean | string | null) => {
    if (req.kind === "confirm") req.resolve(result as boolean);
    else req.resolve(result as string | null);
    current = null;
    setReq(null);
  };
  const confirmValue = () => (req.kind === "confirm" ? true : (value.trim() ? value.trim() : null));

  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") { ev.preventDefault(); finish(cancelValue); }
    else if (ev.key === "Enter" && req.kind === "prompt") { ev.preventDefault(); finish(confirmValue()); }
  };

  return (
    <div className="modal-backdrop" onClick={() => finish(cancelValue)}>
      <div
        ref={trapRef}
        className="modal dialog-modal"
        onClick={(ev) => ev.stopPropagation()}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label={req.message}
        tabIndex={-1}
      >
        <p className="dialog-message">{req.message}</p>
        {req.kind === "prompt" && (
          // eslint-disable-next-line jsx-a11y/no-autofocus
          <input type="text" autoFocus value={value} onChange={(ev) => setValue(ev.target.value)} />
        )}
        <div className="dialog-actions">
          <button className="btn" onClick={() => finish(cancelValue)}>{t("common.cancel")}</button>
          <button
            className={"btn primary" + (req.kind === "confirm" && req.danger ? " danger" : "")}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus={req.kind === "confirm"}
            onClick={() => finish(confirmValue())}
          >
            {req.kind === "confirm" ? t("common.confirm") : t("common.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}
