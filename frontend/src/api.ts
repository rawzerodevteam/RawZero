import type { EditState, ImportResult, LocalAdjust, Photo, Preset, Project } from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail ?? detail; } catch { /* ignore */ }
    throw new Error(detail);
  }
  return res.json();
}

export interface PhotoFilters {
  minRating: number;
  flag: string;
  color: string;
  sort: string;
}

/** Évènement du flux d'export (NDJSON) : une photo terminée, une erreur, ou la fin. */
export type ExportEvent =
  | { type: "file"; id: number; name: string; url: string; width: number; height: number }
  | { type: "error"; id: number; error: string }
  | { type: "done"; folder: string };

export const api = {
  async listProjects(): Promise<Project[]> {
    return (await json<{ projects: Project[] }>(await fetch("/api/projects"))).projects;
  },

  async createProject(name: string): Promise<Project> {
    return json(await fetch("/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }));
  },

  async renameProject(id: number, name: string): Promise<Project> {
    return json(await fetch(`/api/projects/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }));
  },

  async deleteProject(id: number): Promise<void> {
    await json(await fetch(`/api/projects/${id}`, { method: "DELETE" }));
  },

  async listPhotos(f: PhotoFilters, projectId?: number | null): Promise<Photo[]> {
    const q = new URLSearchParams({
      min_rating: String(f.minRating), flag: f.flag, color: f.color, sort: f.sort,
    });
    if (projectId) q.set("project_id", String(projectId));
    return (await json<{ photos: Photo[] }>(await fetch(`/api/photos?${q}`))).photos;
  },

  async getPhoto(id: number): Promise<Photo & { edits: Partial<EditState> }> {
    return json(await fetch(`/api/photos/${id}`));
  },

  async patchPhoto(id: number, patch: Partial<Pick<Photo, "rating" | "flag" | "color">>): Promise<Photo> {
    return json(await fetch(`/api/photos/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }));
  },

  async deletePhoto(id: number, deleteFile: boolean): Promise<void> {
    await json(await fetch(`/api/photos/${id}?delete_file=${deleteFile}`, { method: "DELETE" }));
  },

  async uploadFile(file: File, projectId?: number | null): Promise<ImportResult> {
    const fd = new FormData();
    fd.append("files", file, file.name);
    if (projectId) fd.append("project_id", String(projectId));
    const out = await json<{ results: ImportResult[] }>(
      await fetch("/api/import/upload", { method: "POST", body: fd }));
    return out.results[0];
  },

  async browseImport(path: string): Promise<{
    available: boolean; path: string;
    dirs: { name: string; path: string }[];
    files: { name: string; path: string; size: number }[];
  }> {
    return json(await fetch(`/api/import/browse?path=${encodeURIComponent(path)}`));
  },

  async importFolder(paths: string[], projectId?: number | null): Promise<ImportResult[]> {
    const out = await json<{ results: ImportResult[] }>(
      await fetch("/api/import/folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths, project_id: projectId ?? 0 }),
      }));
    return out.results;
  },

  /** Rendu interactif : renvoie un object URL de JPEG (à révoquer par l'appelant). */
  async render(id: number, edits: EditState, opts: {
    maxSize?: number; before?: boolean; showMask?: string; cropEdit?: boolean; signal?: AbortSignal;
  } = {}): Promise<string> {
    const q = new URLSearchParams({ max_size: String(opts.maxSize ?? 2048) });
    if (opts.before) q.set("before", "1");
    if (opts.showMask) q.set("show_mask", opts.showMask);
    if (opts.cropEdit) q.set("crop_edit", "1");
    const t0 = performance.now();
    const res = await fetch(`/api/photos/${id}/render?${q}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edits }),
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`render: ${res.status}`);
    const blob = await res.blob();
    void import("./lib/devMetrics").then((m) => m.recordRender({
      clientMs: performance.now() - t0,
      serverTiming: res.headers.get("Server-Timing"),
      maxSize: opts.maxSize ?? 2048,
      bytes: blob.size,
      before: !!opts.before,
    }));
    return URL.createObjectURL(blob);
  },

  /** Base neutre débruitée par IA : object URL de JPEG (à révoquer), ou null si indisponible. */
  async denoisedBase(id: number, opts: { maxSize?: number; signal?: AbortSignal } = {}): Promise<string | null> {
    const q = new URLSearchParams({ max_size: String(opts.maxSize ?? 1600) });
    const res = await fetch(`/api/photos/${id}/denoised?${q}`, { signal: opts.signal });
    if (res.status === 503) return null;        // modèle de débruitage absent
    if (!res.ok) throw new Error(`denoised: ${res.status}`);
    return URL.createObjectURL(await res.blob());
  },

  async saveEdits(id: number, edits: EditState): Promise<void> {
    await json(await fetch(`/api/photos/${id}/edits`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edits }),
    }));
  },

  async autoAdjust(id: number, edits: EditState): Promise<EditState> {
    return (await json<{ edits: EditState }>(await fetch(`/api/photos/${id}/auto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edits }),
    }))).edits;
  },

  async pickWhiteBalance(id: number, edits: EditState, x: number, y: number): Promise<{ temp: number; tint: number }> {
    return json(await fetch(`/api/photos/${id}/wb_pick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edits, x, y }),
    }));
  },

  async autoMaskAvailable(): Promise<{ subject: boolean; point: boolean; denoise: boolean }> {
    try {
      return await json(await fetch("/api/automask/available"));
    } catch {
      return { subject: false, point: false, denoise: false };
    }
  },

  async autoMask(id: number, edits: EditState, kind: string): Promise<LocalAdjust> {
    return json(await fetch(`/api/photos/${id}/automask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edits, kind }),
    }));
  },

  async clickMask(id: number, edits: EditState, x: number, y: number, addRef = ""): Promise<LocalAdjust> {
    return json(await fetch(`/api/photos/${id}/clickmask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edits, x, y, add_ref: addRef }),
    }));
  },

  maskUrl(ref: string): string {
    return `/api/masks/${ref}`;
  },

  async listPresets(): Promise<Preset[]> {
    return (await json<{ presets: Preset[] }>(await fetch("/api/presets"))).presets;
  },

  async createPreset(name: string, settings: Partial<EditState>): Promise<Preset> {
    return json(await fetch("/api/presets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, settings }),
    }));
  },

  async deletePreset(id: number): Promise<void> {
    await json(await fetch(`/api/presets/${id}`, { method: "DELETE" }));
  },

  async exportPhotos(req: { ids: number[]; format: string; quality: number; max_size: number; suffix: string }): Promise<{
    folder: string;
    files: { id: number; name: string; url: string; width: number; height: number }[];
    errors: { id: number; error: string }[];
  }> {
    return json(await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    }));
  },

  /** Export parallèle avec progression : lit le flux NDJSON et appelle `onEvent` par évènement. */
  async exportStream(
    req: { ids: number[]; format: string; quality: number; max_size: number; suffix: string },
    onEvent: (ev: ExportEvent) => void | Promise<void>,
  ): Promise<void> {
    const res = await fetch("/api/export/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok || !res.body) throw new Error(`export: ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) await onEvent(JSON.parse(line) as ExportEvent);
      }
    }
    const tail = buf.trim();
    if (tail) await onEvent(JSON.parse(tail) as ExportEvent);
  },

  thumbUrl: (id: number, v: number) => `/api/photos/${id}/thumb?v=${v}`,
  previewUrl: (id: number, v: number) => `/api/photos/${id}/preview?v=${v}`,
  originalUrl: (id: number) => `/api/photos/${id}/original`,
};
