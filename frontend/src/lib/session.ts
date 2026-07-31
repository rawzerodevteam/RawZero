import type { View } from "../store";

/** Persistance de la dernière session (projet / photo / vue) pour rouvrir l'app où on l'a
 *  laissée — extrait de `store.ts` (TODO N11) : self-contained, aucune dépendance sur le store. */
const SESSION_KEY = "rs.session";

export interface Session { projectId: number | null; photoId: number | null; view: View; }

export function readSession(): Session {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "{}");
    return {
      projectId: typeof s.projectId === "number" ? s.projectId : null,
      photoId: typeof s.photoId === "number" ? s.photoId : null,
      view: s.view === "loupe" || s.view === "develop" ? s.view : "grid",
    };
  } catch {
    return { projectId: null, photoId: null, view: "grid" };
  }
}

export function writeSession(s: Session) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* quota/private mode */ }
}
