import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Photo } from "../src/types";

vi.mock("../src/api", () => ({
  api: {
    listPhotos: vi.fn(async () => []),
    getPhoto: vi.fn(async (id: number) => ({ id, edits: {} })),
    patchPhoto: vi.fn(async () => ({})),
    deletePhoto: vi.fn(async () => undefined),
    saveEdits: vi.fn(async () => undefined),
    getFacets: vi.fn(async () => ({ cameras: [], lenses: [] })),
    listAlbums: vi.fn(async () => []),
    createAlbum: vi.fn(async (name: string) => ({ id: 7, name, count: 0, cover: null })),
    renameAlbum: vi.fn(async () => ({})),
    deleteAlbum: vi.fn(async () => undefined),
    addToAlbum: vi.fn(async () => ({ count: 1 })),
    removeFromAlbum: vi.fn(async () => ({ count: 0 })),
  },
}));

import { api } from "../src/api";
import { historyTimeline, useStore } from "../src/store";
import { defaultEdits } from "../src/types";

const initialState = useStore.getState();

function photo(id: number, extra: Partial<Photo> = {}): Photo {
  return {
    id, filename: `p${id}.cr2`, path: `/photos/p${id}.cr2`, missing: false,
    ext: "cr2", is_raw: 1, width: 6000, height: 4000,
    captured_at: "", imported_at: "", camera: "", lens: "", iso: 100,
    aperture: 2.8, shutter: "1/100", focal: 50, rating: 0, flag: "none", color: "", edited: false,
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

  it("Ctrl+Z pendant un drag en cours est ignoré (ne corrompt pas dragBaseline)", () => {
    // cf. TODO.md : annuler pendant un drag de poignée de masque/crop désynchronisait
    // dragBaseline de edits, et le geste ne posait ensuite plus aucun point d'historique.
    const s = useStore.getState();
    s.updateEdits((e) => { e.tone.exposure = 1; }); // état antérieur, dans undoStack
    s.startDrag(); // ex. drag d'une poignée de masque en cours
    s.updateEdits((e) => { e.tone.contrast = 10; });
    s.undo(); // devrait être un no-op tant que le drag est en cours
    expect(useStore.getState().edits!.tone.exposure).toBe(1); // pas rétabli
    expect(useStore.getState().edits!.tone.contrast).toBe(10); // pas annulé
    expect(useStore.getState().dragBaseline).not.toBeNull(); // toujours intact
    s.endDrag();
    expect(useStore.getState().undoStack).toHaveLength(2); // le drag a bien posé son point
    s.undo();
    expect(useStore.getState().edits!.tone.contrast).toBe(0); // undo fonctionne à nouveau après endDrag
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

describe("historique", () => {
  beforeEach(() => {
    useStore.setState({ currentId: 1, edits: defaultEdits(), view: "develop" });
  });

  const timeline = () => historyTimeline(useStore.getState());

  it("chaque modification ajoute une étape libellée, l'étape d'origine en tête", () => {
    const s = useStore.getState();
    s.updateEdits((e) => { e.tone.exposure = 1; });
    s.updateEdits((e) => { e.presence.clarity = 20; });
    const { steps, index } = timeline();
    expect(steps).toHaveLength(3);            // origine + 2 modifications
    expect(index).toBe(2);                    // étape courante = dernière
    expect(steps[0].label).toBe("Réglages d'origine");
    expect(steps[1].label).toBe("Exposition +1");
    expect(steps[2].label).toBe("Clarté +20");
  });

  it("un drag de slider produit une étape unique avec la valeur finale", () => {
    const s = useStore.getState();
    s.startDrag();
    s.updateEdits((e) => { e.tone.exposure = 0.5; }, false);
    s.updateEdits((e) => { e.tone.exposure = 1.5; }, false);
    s.endDrag();
    const { steps } = timeline();
    expect(steps).toHaveLength(2);
    expect(steps[1].label).toBe("Exposition +1.5");
  });

  it("jumpHistory restaure l'état d'une étape antérieure", () => {
    const s = useStore.getState();
    s.updateEdits((e) => { e.tone.exposure = 1; });
    s.updateEdits((e) => { e.tone.exposure = 2; });
    s.jumpHistory(0);
    expect(useStore.getState().edits!.tone.exposure).toBe(0);
    expect(timeline().index).toBe(0);
    s.jumpHistory(2); // rétablir jusqu'au bout
    expect(useStore.getState().edits!.tone.exposure).toBe(2);
  });

  it("modifier après un retour arrière tronque les étapes suivantes", () => {
    const s = useStore.getState();
    s.updateEdits((e) => { e.tone.exposure = 1; });
    s.updateEdits((e) => { e.tone.exposure = 2; });
    s.jumpHistory(1);                                  // revient à expo +1
    s.updateEdits((e) => { e.tone.contrast = 30; });   // nouvelle branche
    const { steps, index } = timeline();
    expect(steps).toHaveLength(3);                     // origine + expo + contraste (le « +2 » est tombé)
    expect(index).toBe(2);
    expect(steps[2].label).toBe("Contraste +30");
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

  it("setProject flushe une édition en attente avant de perdre currentId (pas de perte silencieuse)", async () => {
    // cf. TODO.md : une édition modifiée puis un changement de projet avant les 800 ms de
    // debounce faisait échouer silencieusement le save différé (currentId déjà à null).
    useStore.setState({ currentId: 1, edits: defaultEdits(), photos: [photo(1)] });
    useStore.getState().updateEdits((e) => { e.tone.exposure = 1; });
    expect(api.saveEdits).not.toHaveBeenCalled();
    await useStore.getState().setProject(2);
    expect(api.saveEdits).toHaveBeenCalledWith(1, expect.objectContaining({ tone: expect.objectContaining({ exposure: 1 }) }), expect.anything());
    expect(useStore.getState().currentId).toBe(null);
  });

  it("setAlbum flushe une édition en attente avant de perdre currentId", async () => {
    useStore.setState({ currentId: 1, edits: defaultEdits(), photos: [photo(1)] });
    useStore.getState().updateEdits((e) => { e.tone.contrast = 20; });
    await useStore.getState().setAlbum(5);
    expect(api.saveEdits).toHaveBeenCalledWith(1, expect.objectContaining({ tone: expect.objectContaining({ contrast: 20 }) }), expect.anything());
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

  it("un 2e Suppr rapproché sur la même photo ne déclenche pas un 2e DELETE (déjà en cours)", async () => {
    // cf. TODO.md : deux confirmations rapprochées (file de dialogues) ne doivent pas doubler
    // la suppression de la même photo pendant que la 1ʳᵉ requête est encore en vol.
    let resolveDelete!: () => void;
    (api.deletePhoto as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise<void>((res) => { resolveDelete = res; }),
    );
    useStore.setState({ photos: [photo(1), photo(2)], currentId: 1 });
    const first = useStore.getState().removeCurrent(false, 1);
    const second = useStore.getState().removeCurrent(false, 1); // dialogue 2, même photo, en vol
    resolveDelete();
    await Promise.all([first, second]);
    expect(api.deletePhoto).toHaveBeenCalledTimes(1);
  });

  it("removeCurrent(id figé) ne dérive pas vers la photo suivante si currentId a déjà avancé", async () => {
    // cf. TODO.md : le 2e dialogue en file vise la photo confirmée AU MOMENT DE LA DEMANDE,
    // pas celle devenue courante entre-temps.
    useStore.setState({ photos: [photo(1), photo(2), photo(3)], currentId: 1 });
    await useStore.getState().removeCurrent(false, 1); // 1ʳᵉ suppression déjà résolue, currentId → 2
    expect(useStore.getState().currentId).toBe(2);
    await useStore.getState().removeCurrent(false, 1); // id figé obsolète : photo déjà absente, no-op
    expect(api.deletePhoto).toHaveBeenCalledTimes(1);
    expect(useStore.getState().photos.map((p) => p.id)).toEqual([2, 3]);
  });
});

describe("filtres", () => {
  it("setFilters fusionne et recharge la liste", () => {
    useStore.getState().setFilters({ minRating: 3 });
    expect(useStore.getState().filters.minRating).toBe(3);
    expect(useStore.getState().filters.sort).toBe("captured_asc"); // inchangé
    expect(api.listPhotos).toHaveBeenCalledWith(expect.objectContaining({ minRating: 3 }), null, null);
  });

  it("recherche par nom de fichier : survit à resetFilters (comme le tri), pas à un changement d'album", async () => {
    useStore.getState().setFilters({ search: "img_1", minRating: 4 });
    useStore.getState().resetFilters();
    expect(useStore.getState().filters.minRating).toBe(0);
    expect(useStore.getState().filters.search).toBe("img_1"); // pas effacée par « Réinitialiser les filtres »

    await useStore.getState().setAlbum(5);
    expect(useStore.getState().filters.search).toBe(""); // effacée au changement de portée du catalogue
  });
});

describe("albums", () => {
  it("setAlbum liste par album et réinitialise les filtres EXIF", async () => {
    useStore.setState({ filters: { ...useStore.getState().filters, camera: "X100", isoMin: 800 } });
    await useStore.getState().setAlbum(5);
    expect(useStore.getState().currentAlbumId).toBe(5);
    expect(useStore.getState().filters.camera).toBe("");
    expect(useStore.getState().filters.isoMin).toBe(0);
    expect(api.listPhotos).toHaveBeenCalledWith(expect.anything(), null, 5);
  });

  it("setAlbum(null) revient au projet (album_id non transmis)", async () => {
    await useStore.getState().setAlbum(3);
    vi.clearAllMocks();
    await useStore.getState().setAlbum(null);
    expect(useStore.getState().currentAlbumId).toBe(null);
    expect(api.listPhotos).toHaveBeenCalledWith(expect.anything(), null, null);
  });

  it("addToAlbum appelle l'API puis recharge les albums", async () => {
    await useStore.getState().addToAlbum(2, [10, 11]);
    expect(api.addToAlbum).toHaveBeenCalledWith(2, [10, 11]);
    expect(api.listAlbums).toHaveBeenCalled();
  });
});
