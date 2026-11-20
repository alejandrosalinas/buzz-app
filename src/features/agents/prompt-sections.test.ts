import { describe, expect, it, vi } from "vitest";
import type { Section } from "../agent-harness/sections";
import { hash } from "../agent-harness/sections/choices";
import {
  defaultHash,
  ownerChoices,
  ownerSections,
  PROMPT_SECTIONS_KEY,
  saveOwnerSections,
} from "./prompt-sections";
import { fileStore, isAgentKey } from "./state";
import { localStore } from "./store";

const memory = () => {
  const values = new Map<string, string>();
  return localStore({
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
  });
};
const saved = (global: unknown, version = 1) => {
  const store = memory();
  void store.set(PROMPT_SECTIONS_KEY, JSON.stringify({ version, global }));
  return store;
};

describe("the owner's choices for the base prompt's sections", () => {
  it("are kept in agent storage, which the agent host shares", () => {
    expect(isAgentKey(PROMPT_SECTIONS_KEY)).toBe(true);
  });

  it("are saved with the default each was made on, and read back", async () => {
    const store = memory();
    expect(ownerSections(store)).toEqual({ choices: {}, unused: {} });
    expect(ownerChoices(store)).toEqual({});
    await saveOwnerSections(store, {
      progress: { mode: "off" },
      etiquette: { mode: "custom", text: "  Be brief.\n" },
      memory: { mode: "custom", text: "Mine.", basedOn: "an-older-default" },
    });
    const { choices } = ownerSections(store);
    expect(choices).toEqual({
      progress: {
        mode: "off",
        basedOn: expect.stringMatching(/^[0-9a-f]{16}$/),
      },
      etiquette: {
        mode: "custom",
        text: "Be brief.",
        basedOn: expect.stringMatching(/^[0-9a-f]{16}$/),
      },
      // Kept, so Settings still says the default changed since.
      memory: { mode: "custom", text: "Mine.", basedOn: "an-older-default" },
    });
    expect(choices.progress?.basedOn).not.toBe(choices.etiquette?.basedOn);
    // The builder takes the choice alone.
    expect(ownerChoices(store)).toEqual({
      progress: { mode: "off" },
      etiquette: { mode: "custom", text: "Be brief." },
      memory: { mode: "custom", text: "Mine." },
    });
    expect(JSON.parse(store.get(PROMPT_SECTIONS_KEY) ?? "")).toMatchObject({
      version: 1,
      global: { progress: { mode: "off" } },
    });
    // A missing id is the default again; with none left, nothing is kept.
    await saveOwnerSections(store, { progress: { mode: "off" } });
    expect(Object.keys(ownerSections(store).choices)).toEqual(["progress"]);
    await saveOwnerSections(store, {});
    expect(store.get(PROMPT_SECTIONS_KEY)).toBeNull();
  });

  it("reach turns only once they are saved", async () => {
    // A native store shows a write at once, and puts the saved value back
    // when the write fails.
    const writes: ((error?: Error) => void)[] = [];
    const store = fileStore(
      new Map(),
      () =>
        new Promise<void>((resolve, reject) => {
          writes.push((error) => (error ? reject(error) : resolve()));
        }),
    );
    const off = { progress: { mode: "off" as const } };
    const failed = saveOwnerSections(store, off);
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(ownerSections(store).choices).toHaveProperty("progress");
    expect(ownerChoices(store)).toEqual({});
    writes[0]?.(new Error("disk full"));
    await expect(failed).rejects.toThrow("disk full");
    expect(ownerChoices(store)).toEqual({});
    const saved = saveOwnerSections(store, off);
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(ownerChoices(store)).toEqual({});
    writes[1]?.();
    await saved;
    expect(ownerChoices(store)).toEqual({ progress: { mode: "off" } });
  });

  it("are refused for a section the owner cannot configure, and for a text that cannot be used", async () => {
    const store = memory();
    await saveOwnerSections(store, { progress: { mode: "off" } });
    for (const id of ["trust", "session-model", "working-location", "nope"])
      await expect(
        saveOwnerSections(store, { [id]: { mode: "off" } }),
      ).rejects.toThrow(`no section "${id}"`);
    await expect(
      saveOwnerSections(store, { etiquette: { mode: "custom", text: " " } }),
    ).rejects.toThrow("Etiquette: Enter the instructions");
    await expect(
      saveOwnerSections(store, {
        etiquette: { mode: "custom", text: "é".repeat(2049) },
      }),
    ).rejects.toThrow("Etiquette: Keep the instructions within 4 KiB.");
    await expect(
      saveOwnerSections(store, {
        etiquette: { mode: "custom", text: "bell\u0007" },
      }),
    ).rejects.toThrow("control characters");
    // A refused save changes nothing.
    expect(ownerChoices(store)).toEqual({ progress: { mode: "off" } });
  });

  it("drop what a hand-edited value says for a section the owner cannot configure, or says badly", () => {
    const store = saved({
      trust: { mode: "off", basedOn: "x" },
      "working-location": { mode: "custom", text: "Anywhere.", basedOn: "x" },
      progress: { mode: "off" },
      etiquette: { mode: "custom", text: "", basedOn: "x" },
      memory: { mode: "on", basedOn: "x" },
      engineering: "off",
      autonomy: { mode: "off", basedOn: "x" },
    });
    expect(ownerSections(store)).toEqual({
      choices: { autonomy: { mode: "off", basedOn: "x" } },
      unused: {},
    });
  });

  it("give every section its default when the saved value cannot be read", () => {
    for (const store of [
      saved([]),
      saved("progress"),
      saved({ progress: { mode: "off", basedOn: "x" } }, 2),
    ])
      expect(ownerSections(store)).toEqual({
        choices: {},
        unused: {},
        unreadable: true,
      });
    const store = memory();
    void store.set(PROMPT_SECTIONS_KEY, "{not json");
    expect(ownerSections(store).unreadable).toBe(true);
    expect(ownerChoices(store)).toEqual({});
  });

  describe("when the sections change in a later release", () => {
    const off = { mode: "off", basedOn: "x" } as const;
    const mine = { mode: "custom", text: "Mine.", basedOn: "x" } as const;
    const updates: Section = {
      id: "updates",
      aliases: ["progress"],
      title: "Updates",
      owner: true,
      text: "Report.",
    };
    const manners: Section = {
      id: "manners",
      title: "Manners",
      owner: true,
      text: " Be kind.\n",
    };
    const sections = [{ id: "intro", text: "Intro." }, updates, manners];

    it("a choice follows its section to a new id", () => {
      expect(
        ownerSections(saved({ progress: mine }), sections).choices,
      ).toEqual({ updates: mine });
      // One saved under the current id wins, in either order.
      for (const global of [
        { progress: mine, updates: off },
        { updates: off, progress: mine },
      ])
        expect(ownerSections(saved(global), sections).choices).toEqual({
          updates: off,
        });
    });

    it("a choice for a section that is gone is kept, and not used", async () => {
      const store = saved({ etiquette: mine, manners: off });
      expect(ownerSections(store, sections)).toEqual({
        choices: { manners: off },
        unused: { etiquette: mine },
      });
      await saveOwnerSections(store, { updates: { mode: "off" } }, sections);
      expect(ownerSections(store, sections)).toEqual({
        choices: { updates: { mode: "off", basedOn: hash("Report.") } },
        unused: { etiquette: mine },
      });
    });

    it("a choice names the default it was made on", () => {
      expect(defaultHash(manners)).toBe(hash("Be kind."));
      expect(defaultHash(manners)).not.toBe(defaultHash(updates));
    });
  });
});
