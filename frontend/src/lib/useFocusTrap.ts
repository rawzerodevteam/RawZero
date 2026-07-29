import { useEffect, useRef } from "react";

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Piège le focus clavier (Tab/Maj+Tab) à l'intérieur du conteneur retourné, focus le premier
 *  élément focusable à l'ouverture, et restitue le focus à l'élément déclencheur au démontage
 *  (cf. audit UX §11.5 : aucune des modales de l'app ne le faisait). */
// `resetKey` : quand un hôte de dialogue persistant enchaîne plusieurs requêtes sans démonter le
// composant (ex. `DialogHost`, file d'attente), passer l'objet-requête (identité différente à
// chaque nouvelle requête, même de même nature) force l'effet à se rejouer — sinon le focus
// initial ne serait jamais reposé à l'ouverture de la requête suivante (`active` resterait `true`
// en continu). Séparé de `active` pour garder ce dernier strictement booléen.
export function useFocusTrap<T extends HTMLElement>(active: boolean, resetKey?: unknown) {
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute("disabled"));

    // Ne vole pas le focus si un `autoFocus` interne (input, bouton primaire…) l'a déjà posé.
    if (!container.contains(document.activeElement)) {
      (focusables()[0] ?? container).focus();
    }

    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    };
    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [active, resetKey]);

  return ref;
}
