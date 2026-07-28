import { describe, expect, it } from "vitest";

import { actionForEvent, normalizeEvent } from "../src/keybindings";

function key(k: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: k, ...mods });
}

describe("normalizeEvent", () => {
  it("ignore Maj sur la ponctuation (ex. « ? »)", () => {
    expect(normalizeEvent(key("?", { shiftKey: true }))).toBe("?");
  });

  it("ignore Maj sur un chiffre (AZERTY : la rangée de chiffres exige Maj)", () => {
    // Sur AZERTY, la touche physique "1" ne produit "1" qu'avec Maj enfoncée.
    expect(normalizeEvent(key("1", { shiftKey: true }))).toBe("1");
    expect(actionForEvent(key("1", { shiftKey: true }))).toBe("rate-1");
  });

  it("garde Maj sur une lettre (ex. Ctrl+Maj+C)", () => {
    expect(normalizeEvent(key("C", { ctrlKey: true, shiftKey: true }))).toBe("ctrl+shift+c");
  });
});
