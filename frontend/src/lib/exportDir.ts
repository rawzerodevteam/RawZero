/** Mémorisation du dossier d'export (File System Access) entre les sessions.
 *  Le handle de dossier est stocké dans IndexedDB : on choisit le dossier une fois,
 *  et l'app le réutilise ensuite sans redemander à chaque export. */

const DB_NAME = "rawstudio";
const STORE = "handles";
const KEY = "exportDir";

export const fsAccessSupported = "showDirectoryPicker" in window;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(): Promise<any> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

async function idbSet(value: any): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch { /* indisponible (mode privé…) */ }
}

/** Récupère le dossier mémorisé (sans redemander la permission). */
export async function loadExportDir(): Promise<any | null> {
  return fsAccessSupported ? idbGet() : null;
}

/** Ouvre le sélecteur natif et mémorise le dossier choisi. */
export async function chooseExportDir(): Promise<any | null> {
  const dir = await (window as any).showDirectoryPicker({ id: "rawstudio-export", mode: "readwrite" });
  await idbSet(dir);
  return dir;
}

/** Vérifie/obtient la permission d'écriture, en ne demandant que si nécessaire. */
export async function ensureWritable(dir: any): Promise<boolean> {
  if (!dir?.queryPermission) return true;
  const opts = { mode: "readwrite" } as const;
  if ((await dir.queryPermission(opts)) === "granted") return true;
  return (await dir.requestPermission(opts)) === "granted";
}

/** Écrit un blob dans le dossier, sans écraser un homonyme déjà écrit dans le même lot. */
export async function writeFile(dir: any, name: string, blob: Blob, used: Set<string>): Promise<void> {
  let final = name;
  if (used.has(final)) {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let i = 1;
    while (used.has(final)) { final = `${stem}-${i}${ext}`; i++; }
  }
  used.add(final);
  const fh = await dir.getFileHandle(final, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
}
