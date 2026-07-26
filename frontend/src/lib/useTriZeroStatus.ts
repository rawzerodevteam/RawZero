import { useEffect, useState } from "react";

/** URL de TriZero, extension de tri intelligent totalement optionnelle et séparée
 * de RawZero (voir ajout_ext.md) : process/port/base de données distincts. */
export const TRIZERO_URL = "http://localhost:8010";
export const TRIZERO_REPO_URL = "https://github.com/IIsalSaili/TriZero";

const HEALTH_URL = `${TRIZERO_URL}/api/health`;
const POLL_MS = 20_000;

export type TriZeroStatus = "checking" | "available" | "unavailable";

/** Sonde /api/health de TriZero pour savoir si l'extension tourne, sans jamais
 * bloquer RawZero si elle n'est pas lancée (ou pas installée du tout). */
export function useTriZeroStatus(): TriZeroStatus {
  const [status, setStatus] = useState<TriZeroStatus>("checking");

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      fetch(HEALTH_URL, { signal: AbortSignal.timeout(1500) })
        .then((res) => { if (!cancelled) setStatus(res.ok ? "available" : "unavailable"); })
        .catch(() => { if (!cancelled) setStatus("unavailable"); });
    };
    check();
    const id = setInterval(check, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return status;
}
