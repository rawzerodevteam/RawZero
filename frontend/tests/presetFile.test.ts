import { describe, expect, it } from "vitest";
import {
  parsePresetFile, sanitizeSettings, serializePresets, uniquePresetName, presetSlug,
} from "../src/lib/presetFile";

describe("sanitizeSettings", () => {
  it("ne garde que les sections de rendu connues", () => {
    const out = sanitizeSettings({
      presence: { vibrance: 35 },
      tone: { contrast: 14 },
      geometry: { rotate: 90 },     // jeté
      locals: [{ id: "x" }],        // jeté
      version: 1,                   // jeté
      bidon: { foo: 1 },            // jeté
    });
    expect(out).toEqual({ presence: { vibrance: 35 }, tone: { contrast: 14 } });
  });

  it("préserve les tableaux de courbe", () => {
    const curve = { points: [[0, 0.06], [1, 0.95]] };
    expect(sanitizeSettings({ curve }).curve).toEqual(curve);
  });
});

describe("serialize/parse round-trip", () => {
  it("sérialise puis reparse en préservant noms + settings", () => {
    const items = [
      { name: "Vivid", settings: { presence: { vibrance: 35 } } },
      { name: "N&B", settings: { presence: { saturation: -100 } } },
    ];
    const parsed = parsePresetFile(serializePresets(items));
    expect(parsed).toEqual(items);
  });

  it("accepte la forme preset unique (name + settings)", () => {
    const text = JSON.stringify({
      format: "rawstudio-preset", version: 1,
      name: "Solo", settings: { tone: { contrast: 10 } },
    });
    expect(parsePresetFile(text)).toEqual([{ name: "Solo", settings: { tone: { contrast: 10 } } }]);
  });
});

describe("parse — rejets", () => {
  it("rejette un JSON invalide", () => {
    expect(() => parsePresetFile("{pas du json")).toThrow();
  });
  it("rejette un en-tête de format manquant ou faux", () => {
    expect(() => parsePresetFile(JSON.stringify({ presets: [] }))).toThrow();
    expect(() => parsePresetFile(JSON.stringify({ format: "autre", presets: [] }))).toThrow();
  });
  it("rejette un bundle sans preset nommé valide", () => {
    const text = JSON.stringify({ format: "rawstudio-preset", version: 1, presets: [{ settings: {} }] });
    expect(() => parsePresetFile(text)).toThrow();
  });
});

describe("uniquePresetName", () => {
  it("suffixe en cas de collision (insensible à la casse)", () => {
    expect(uniquePresetName("Vivid", [])).toBe("Vivid");
    expect(uniquePresetName("Vivid", ["vivid"])).toBe("Vivid (2)");
    expect(uniquePresetName("Vivid", ["Vivid", "Vivid (2)"])).toBe("Vivid (3)");
  });
});

describe("presetSlug", () => {
  it("produit un nom de fichier sûr", () => {
    expect(presetSlug("Noir & Blanc punchy")).toBe("noir-blanc-punchy");
    expect(presetSlug("???")).toBe("preset");
  });
});
