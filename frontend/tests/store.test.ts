import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Photo } from "../src/types";

vi.mock("../src/api", () => ({
  api: {
    listPhotos: vi.fn(async () => []),
    getPhoto: vi.fn(async (id: number) => ({ id, edits: {} })),
    patchPhoto: vi.fn(async () => ({})),
    deletePhoto: vi.fn(async () => undefined),
    saveEdits: vi.fn(async () => undefined),
  },
}));

import { api } from "../src/api";
import { useStore } from "../src/store";
import { defaultEdits } from "../src/types";

const initialState = useStore.getState();

function photo(id: number, extra: Partial<Photo> = {}): Photo {
  return {
    id, filename: `p${id}.cr2`, ext: "cr2", is_raw: 1, width: 6000, height: 4000,
    captured_at: "", imported_at: "", camera: "", lens: "", iso: 100,
    aperture: 2.8, shutter: "1/100", focal: 50, rating: 0, flag: "none", color: "",
    ...extra,
  };
}

beforeEach(() => {
  useStore.setState(initialState, true);
  vi.clearAllMocks();
  vi.useFakeTimers();
});

describe("notation, drapeaux, labels (mise à jour optimiste)", () => {
  beforeEach(() => {
    useStore.setState({ photos: [photo(1), photo(2)], currentId: 1 });
  });

  it("setRating met à jour localement et appelle l'API", () => {
    useStore.getState().setRating(4);
    expect(useStore.getState().photos[0].rating).toBe(4);
    expect(useStore.getState().photos[1].rating).toBe(0);
    expect(api.patchPhoto).toHaveBeenCalledWith(1, { rating: 4 });
  });

  it("setFlag ne fait rien sans photo courante", () => {
    useStore.setState({ currentId: null });
    useStore.getState().setFlag("pick");
    expect(api.patchPhoto).not.toHaveBeenCalled();
  });

  it("setColor sur le même label l'enlève (toggle)", () => {
    useStore.getState().setColor("red");
    expect(useStore.getState().photos[0].color).toBe("red");
    useStore.getState().setColor("red");
    expect(useStore.getState().photos[0].color).toBe("");
  });
});

describe("navigation", () => {
  beforeEach(() => {
    useStore.setState({ photos: [photo(1), photo(2), photo(3)], currentId: 2, view: "grid" });
  });

  it("avance et recule", () => {
    useStore.getState().navigate(1);
    expect(useStore.getState().currentId).toBe(3);
    useStore.getState().navigate(-1);
    expect(useStore.getState().currentId).toBe(2);
  });

  it("est bornée aux extrémités", () => {
    useStore.setState({ currentId: 3 });
    useStore.getState().navigate(1);
    expect(useStore.getState().currentId).toBe(3);
    useStore.setState({ currentId: 1 });
    useStore.getState().navigate(-1);
    expect(useStore.getState().currentId).toBe(1);
  });

  it("ne fait rien sur une liste vide", () => {
    useStore.setState({ photos: [], currentId: null });
    useStore.getState().navigate(1);
    expect(useStore.getState().currentId).toBe(null);
  });
});

describe("undo / redo", () => {
  beforeEach(() => {
    useStore.setState({ currentId: 1, edits: defaultEdits(), view: "develop" });
  });

  it("updateEdits empile l'état précédent et vide le redo", () => {
    const s = useStore.getState();
    s.updateEdits((e) => { e.tone.exposure = 1; });
    expect(useStore.getState().edits!.tone.exposure).toBe(1);
    expect(useStore.getState().undoStack).toHaveLength(1);
    expect(useStore.getState().redoStack).toHaveLength(0);
  });

  it("undo puis redo restaurent les états", () => {
    const s = useStore.getState();
    s.updateEdits((e) => { e.tone.exposure = 1; });
    s.updateEdits((e) => { e.tone.exposure = 2; });
    s.undo();
    expect(useStore.getState().edits!.tone.exposure).toBe(1);
    s.undo();
    expect(useStore.getState().edits!.tone.exposure).toBe(0);
    s.undo(); // pile vide → no-op
    expect(useStore.getState().edits!.tone.exposure).toBe(0);
    s.redo();
    s.redo();
    expect(useStore.getState().edits!.tone.exposure).toBe(2);
  });

  it("la pile d'undo est plafonnée à 50", () => {
    const s = useStore.getState();
    for (let i = 0; i < 60; i++) s.updateEdits((e) => { e.tone.exposure = i / 10; });
    expect(useStore.getState().undoStack.length).toBeLessThanOrEqual(50);
  });

  it("un drag de slider ne crée qu'une seule entrée d'undo", () => {
    const s = useStore.getState();
    s.startDrag();
    s.updateEdits((e) => { e.tone.exposure = 0.5; });
    s.updateEdits((e) => { e.tone.exposure = 1.0; });
    s.updateEdits((e) => { e.tone.exposure = 1.5; });
    s.endDrag();
    expect(useStore.getState().undoStack).toHaveLength(1);
    s.undo();
    expect(useStore.getState().edits!.tone.exposure).toBe(0); // retour à l'état d'avant le drag
  });
});

describe("copier / coller / reset", () => {
  beforeEach(() => {
    useStore.setState({ currentId: 1, edits: defaultEdits(), view: "develop" });
  });

  it("pasteEdits applique tout sauf la géométrie", () => {
    const s = useStore.getState();
    s.updateEdits((e) => {
      e.tone.exposure = 1.2;
      e.geometry.crop = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
    });
    s.copyEdits();
    // photo suivante : crop différent
    useStore.setState({ edits: defaultEdits(), undoStack: [], redoStack: [] });
    useStore.getState().updateEdits((e) => { e.geometry.crop = { x: 0, y: 0, w: 0.5, h: 0.5 }; });
    useStore.getState().pasteEdits();
    const e = useStore.getState().edits!;
    expect(e.tone.exposure).toBe(1.2);
    expect(e.geometry.crop).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 }); // géométrie conservée
  });

  it("pasteEdits sans presse-papiers est un no-op", () => {
    useStore.getState().pasteEdits();
    expect(useStore.getState().edits).toEqual(defaultEdits());
  });

  it("resetEdits revient aux défauts mais reste annulable", () => {
    const s = useStore.getState();
    s.updateEdits((e) => { e.tone.exposure = 1; });
    s.resetEdits();
    expect(useStore.getState().edits).toEqual(defaultEdits());
    s.undo();
    expect(useStore.getState().edits!.tone.exposure).toBe(1);
  });

  it("applyPartial fusionne un preset partiel", () => {
    useStore.getState().applyPartial({ presence: { clarity: 30, dehaze: 0, vibrance: 10, saturation: 0 } });
    const e = useStore.getState().edits!;
    expect(e.presence.clarity).toBe(30);
    expect(e.tone).toEqual(defaultEdits().tone);
  });
});

describe("sauvegarde différée", () => {
  it("updateEdits déclenche saveEdits après le debounce", async () => {
    useStore.setState({ currentId: 1, edits: defaultEdits() });
    useStore.getState().updateEdits((e) => { e.tone.exposure = 1; });
    expect(api.saveEdits).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(900);
    expect(api.saveEdits).toHaveBeenCalledTimes(1);
    expect(useStore.getState().dirty).toBe(false);
  });

  it("saveNow sans modification n'appelle pas l'API", async () => {
    useStore.setState({ currentId: 1, edits: defaultEdits(), dirty: false });
    await useStore.getState().saveNow();
    expect(api.saveEdits).not.toHaveBeenCalled();
  });
});

describe("suppression", () => {
  it("removeCurrent sélectionne la photo suivante", async () => {
    useStore.setState({ photos: [photo(1), photo(2), photo(3)], currentId: 2 });
    await useStore.getState().removeCurrent(false);
    expect(api.deletePhoto).toHaveBeenCalledWith(2, false);
    expect(useStore.getState().photos.map((p) => p.id)).toEqual([1, 3]);
    expect(useStore.getState().currentId).toBe(3);
  });

  it("la dernière photo supprimée ramène à la grille", async () => {
    useStore.setState({ photos: [photo(1)], currentId: 1, view: "loupe" });
    await useStore.getState().removeCurrent(false);
    expect(useStore.getState().currentId).toBe(null);
    expect(useStore.getState().view).toBe("grid");
  });
});

describe("filtres", () => {
  it("setFilters fusionne et recharge la liste", () => {
    useStore.getState().setFilters({ minRating: 3 });
    expect(useStore.getState().filters.minRating).toBe(3);
    expect(useStore.getState().filters.sort).toBe("captured_asc"); // inchangé
    expect(api.listPhotos).toHaveBeenCalledWith(expect.objectContaining({ minRating: 3 }));
  });
});
