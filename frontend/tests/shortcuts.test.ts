import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({
  api: {
    listPhotos: vi.fn(async () => []),
    getPhoto: vi.fn(async (id: number) => ({ id, edits: {} })),
    patchPhoto: vi.fn(async () => ({})),
    deletePhoto: vi.fn(async () => undefined),
    saveEdits: vi.fn(async () => undefined),
  },
}));

vi.mock("../src/lib/dialog", () => ({
  confirmDialog: vi.fn(async () => true),
  promptDialog: vi.fn(async () => null),
}));

import { api } from "../src/api";
import { confirmDialog } from "../src/lib/dialog";
import { handleGlobalKey } from "../src/shortcuts";
import { useStore } from "../src/store";
import { defaultEdits, type Photo } from "../src/types";

const initialState = useStore.getState();

function photo(id: number): Photo {
  return {
    id, filename: `p${id}.cr2`, path: `/photos/p${id}.cr2`, missing: false,
    ext: "cr2", is_raw: 1, width: 6000, height: 4000,
    captured_at: "", imported_at: "", camera: "", lens: "", iso: 100,
    aperture: 2.8, shutter: "1/100", focal: 50, rating: 0, flag: "none", color: "", edited: false,
  };
}

function press(key: string, mods: Partial<KeyboardEvent> = {}) {
  const ev = new KeyboardEvent("keydown", { key, cancelable: true, ...mods });
  handleGlobalKey(ev);
  return ev;
}

beforeEach(() => {
  useStore.setState(initialState, true);
  useStore.setState({ photos: [photo(1), photo(2)], currentId: 1 });
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("garde de saisie", () => {
  it("ignore les raccourcis quand un champ texte a le focus", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    press("3");
    expect(useStore.getState().photos[0].rating).toBe(0);
    expect(api.patchPhoto).not.toHaveBeenCalled();
  });
});

describe("notes, drapeaux, labels", () => {
  it("0–5 notent la photo courante", () => {
    // Hors développement, noter fait aussi avancer à la photo suivante (cf. CLAUDE.md) :
    // la 2e pression note donc la photo devenue courante, pas la première.
    press("3");
    expect(useStore.getState().photos[0].rating).toBe(3);
    expect(useStore.getState().currentId).toBe(2);
    press("0");
    expect(useStore.getState().photos[1].rating).toBe(0);
  });

  it("P / X / U posent les drapeaux", () => {
    press("p");
    expect(useStore.getState().photos[0].flag).toBe("pick");
    press("x");
    expect(useStore.getState().photos[0].flag).toBe("reject");
    press("u");
    expect(useStore.getState().photos[0].flag).toBe("none");
  });

  it("6–9 posent les labels couleur", () => {
    press("6");
    expect(useStore.getState().photos[0].color).toBe("red");
    press("9");
    expect(useStore.getState().photos[0].color).toBe("blue");
  });
});

describe("navigation et vues", () => {
  it("flèches gauche/droite naviguent", () => {
    press("ArrowRight");
    expect(useStore.getState().currentId).toBe(2);
    press("ArrowLeft");
    expect(useStore.getState().currentId).toBe(1);
  });

  it("G / E changent de vue", () => {
    press("e");
    expect(useStore.getState().view).toBe("loupe");
    press("g");
    expect(useStore.getState().view).toBe("grid");
  });

  it("E sans photo courante ouvre la 1ʳᵉ photo en zoom", () => {
    useStore.setState({ currentId: null });
    press("e");
    expect(useStore.getState().view).toBe("loupe");
    expect(useStore.getState().currentId).toBe(1);
  });

  it("E sans aucune photo ne change pas de vue", () => {
    useStore.setState({ photos: [], currentId: null });
    press("e");
    expect(useStore.getState().view).toBe("grid");
  });

  it("D ouvre le développement (charge les edits)", async () => {
    press("d");
    await vi.waitFor(() => expect(useStore.getState().edits).not.toBe(null));
    expect(useStore.getState().view).toBe("develop");
    expect(api.getPhoto).toHaveBeenCalledWith(1);
  });
});

describe("Échap (priorités)", () => {
  it("ferme d'abord les dialogues, puis l'outil, puis revient à la grille", () => {
    useStore.setState({ view: "develop", showExport: true, activeTool: "crop" });
    press("Escape");
    expect(useStore.getState().showExport).toBe(false);
    expect(useStore.getState().activeTool).toBe("crop"); // l'outil reste
    press("Escape");
    expect(useStore.getState().activeTool).toBe("none");
    expect(useStore.getState().view).toBe("develop");
    press("Escape");
    expect(useStore.getState().view).toBe("grid");
  });
});

describe("raccourcis Ctrl", () => {
  beforeEach(() => {
    useStore.setState({ view: "develop", edits: defaultEdits() });
  });

  it("Ctrl+Z / Ctrl+Shift+Z annulent et rétablissent", () => {
    useStore.getState().updateEdits((e) => { e.tone.exposure = 1; });
    press("z", { ctrlKey: true });
    expect(useStore.getState().edits!.tone.exposure).toBe(0);
    press("Z", { ctrlKey: true, shiftKey: true });
    expect(useStore.getState().edits!.tone.exposure).toBe(1);
  });

  it("Ctrl+Shift+C / V copient et collent", () => {
    useStore.getState().updateEdits((e) => { e.tone.contrast = 25; });
    press("C", { ctrlKey: true, shiftKey: true });
    useStore.setState({ edits: defaultEdits() });
    press("V", { ctrlKey: true, shiftKey: true });
    expect(useStore.getState().edits!.tone.contrast).toBe(25);
  });

  it("Ctrl+E ouvre l'export et bloque le raccourci navigateur", () => {
    const ev = press("e", { ctrlKey: true });
    expect(useStore.getState().showExport).toBe(true);
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe("bascules du mode développement", () => {
  it("\\ , J, R n'agissent qu'en développement", () => {
    press("\\");
    press("j");
    press("r");
    expect(useStore.getState().beforeAfter).toBe(false);
    expect(useStore.getState().showClipping).toBe(false);
    expect(useStore.getState().activeTool).toBe("none");

    useStore.setState({ view: "develop" });
    press("\\");
    press("j");
    press("r");
    expect(useStore.getState().beforeAfter).toBe(true);
    expect(useStore.getState().showClipping).toBe(true);
    expect(useStore.getState().activeTool).toBe("crop");
    press("r"); // toggle
    expect(useStore.getState().activeTool).toBe("none");
  });

  it("O déclenche un aperçu ponctuel du masque sélectionné (pas une bascule collante)", () => {
    vi.useFakeTimers();
    try {
      press("o"); // hors développement : aucun effet
      expect(useStore.getState().flashLocalId).toBeNull();

      useStore.setState({ view: "develop" });
      press("o"); // aucun masque sélectionné : aucun effet
      expect(useStore.getState().flashLocalId).toBeNull();

      useStore.setState({ selectedLocalId: "loc-1" });
      press("o");
      expect(useStore.getState().flashLocalId).toBe("loc-1");
      vi.advanceTimersByTime(900);
      expect(useStore.getState().flashLocalId).toBeNull(); // disparaît tout seul, pas de bascule à refaire
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("plein écran", () => {
  it("F ne bascule qu'en développement, Échap le referme en priorité", () => {
    press("f");
    expect(useStore.getState().fullScreen).toBe(false);

    useStore.setState({ view: "develop" });
    press("f");
    expect(useStore.getState().fullScreen).toBe(true);
    press("Escape");
    expect(useStore.getState().fullScreen).toBe(false);
    expect(useStore.getState().view).toBe("develop"); // Échap ne fait que sortir du plein écran

    press("f");
    useStore.setState({ activeTool: "crop" });
    press("Escape"); // plein écran prioritaire sur l'outil actif
    expect(useStore.getState().fullScreen).toBe(false);
    expect(useStore.getState().activeTool).toBe("crop");
  });
});

describe("suppression", () => {
  it("Suppr demande confirmation avant de retirer", async () => {
    (confirmDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    press("Delete");
    await vi.waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(api.deletePhoto).not.toHaveBeenCalled();
  });

  it("Suppr confirmée retire la photo", async () => {
    press("Delete");
    await vi.waitFor(() => expect(api.deletePhoto).toHaveBeenCalledWith(1, false));
  });
});
