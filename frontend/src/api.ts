import type { EditState, ImportResult, Photo, Preset } from "./types";

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

export const api = {
  async listPhotos(f: PhotoFilters): Promise<Photo[]> {
    const q = new URLSearchParams({
      min_rating: String(f.minRating), flag: f.flag, color: f.color, sort: f.sort,
    });
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

  async uploadFile(file: File): Promise<ImportResult> {
    const fd = new FormData();
    fd.append("files", file, file.name);
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

  async importFolder(paths: string[]): Promise<ImportResult[]> {
    const out = await json<{ results: ImportResult[] }>(
      await fetch("/api/import/folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths }),
      }));
    return out.results;
  },

  /** Rendu interactif : renvoie un object URL de JPEG (à révoquer par l'appelant). */
  async render(id: number, edits: EditState, opts: {
    maxSize?: number; before?: boolean; showMask?: string; signal?: AbortSignal;
  } = {}): Promise<string> {
    const q = new URLSearchParams({ max_size: String(opts.maxSize ?? 2048) });
    if (opts.before) q.set("before", "1");
    if (opts.showMask) q.set("show_mask", opts.showMask);
    const res = await fetch(`/api/photos/${id}/render?${q}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edits }),
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`render: ${res.status}`);
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

  thumbUrl: (id: number, v: number) => `/api/photos/${id}/thumb?v=${v}`,
  previewUrl: (id: number, v: number) => `/api/photos/${id}/preview?v=${v}`,
  originalUrl: (id: number) => `/api/photos/${id}/original`,
};
