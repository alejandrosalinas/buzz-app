import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultSkinTone,
  rememberSkinTone,
  savedSkinTone,
  skinToneUnchosen,
} from "./skin-tone";

const storage = (getItem: (key: string) => string | null) =>
  vi.stubGlobal("localStorage", { getItem });

describe("skin tone storage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is unchosen until a tone is saved", () => {
    storage(() => null);
    expect(skinToneUnchosen()).toBe(true);
    expect(savedSkinTone()).toBeUndefined();
    expect(defaultSkinTone()).toBe(1);
    storage(() => "4");
    expect(skinToneUnchosen()).toBe(false);
    expect(savedSkinTone()).toBe(4);
  });

  it("never asks when storage cannot keep the choice", () => {
    storage(() => {
      throw new Error("blocked");
    });
    expect(skinToneUnchosen()).toBe(false);
    expect(defaultSkinTone()).toBe(1);
  });

  // Runs last: the remembered tone lasts for the rest of the session.
  it("remembers a chosen tone that storage could not keep", () => {
    storage(() => null);
    rememberSkinTone(4);
    expect(skinToneUnchosen()).toBe(false);
    expect(savedSkinTone()).toBe(4);
    expect(defaultSkinTone()).toBe(4);
  });
});
