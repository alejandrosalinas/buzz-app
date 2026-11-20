import { describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_SECTIONS_PREFIX,
  checkedSections,
  conversationSections,
  forgetConversationSections,
  setConversationSections,
  usableSections,
} from "./conversation-sections";
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
const key = (scope: string, agent: string, conversation: string) =>
  `${CONVERSATION_SECTIONS_PREFIX}${JSON.stringify([scope, agent, conversation])}`;
const DECLARED = ["working-location", "progress"];

describe("the sections a plugin gives a conversation", () => {
  it("are checked against what a plugin can replace and its manifest declares", () => {
    expect(
      checkedSections(
        { "working-location": "  Work in the folder.\n", progress: "Quiet." },
        DECLARED,
      ),
    ).toEqual({
      "working-location": "Work in the folder.",
      progress: "Quiet.",
    });
    expect(checkedSections({}, DECLARED)).toEqual({});
    const rejected =
      (sections: unknown, declared = DECLARED) =>
      () =>
        checkedSections(sections as Record<string, string>, declared);
    expect(rejected(["progress"])).toThrow("section IDs with their text");
    expect(rejected(null)).toThrow("section IDs with their text");
    // A locked section, an owner-only one, and one that does not exist.
    for (const id of ["trust", "etiquette", "nope"])
      expect(rejected({ [id]: "Mine." }, [id])).toThrow(
        `A plugin cannot replace the agent prompt section "${id}"`,
      );
    expect(rejected({ routing: "Mine." })).toThrow(
      'does not declare the agent prompt section "routing"',
    );
    for (const empty of ["", "  \n", 1])
      expect(rejected({ progress: empty })).toThrow(
        'The section "progress" needs text',
      );
    expect(rejected({ progress: "é".repeat(2049) })).toThrow("over 4096 bytes");
    expect(rejected({ progress: "a\u0000b" })).toThrow("control characters");
    const all = [
      "callbacks",
      "routing",
      "publishing",
      "progress",
      "working-location",
      "autonomy",
    ];
    const full = Object.fromEntries(all.map((id) => [id, "a".repeat(4096)]));
    expect(rejected(full, all)).toThrow("over 12288 bytes");
    const { autonomy: _one, routing: _two, callbacks: _three, ...three } = full;
    expect(Object.keys(checkedSections(three, all))).toHaveLength(3);
  });

  it("are replaced as one set, and removed by an empty set, per scope, agent and conversation", async () => {
    const store = memory();
    const get = (conversation: string, agent = "agent", scope = "scope") =>
      conversationSections(store, scope, agent, conversation);
    expect(isAgentKey(key("scope", "agent", "c/r"))).toBe(true);
    await setConversationSections(store, "scope", "agent", "c/r", "a", {
      progress: "One",
      routing: "Two",
    });
    await setConversationSections(store, "scope", "agent", "c/r", "b", {
      progress: "Three",
    });
    expect(get("c/r")).toEqual({
      plugin: "b",
      sections: { progress: "Three" },
    });
    expect(get("c")).toBeUndefined();
    expect(get("c/r", "other")).toBeUndefined();
    expect(get("c/r", "agent", "elsewhere")).toBeUndefined();
    await setConversationSections(store, "scope", "agent", "c/r", "b", {});
    expect(get("c/r")).toBeUndefined();
    expect(store.keys()).toHaveLength(0);
  });

  it("are read only once they are saved", async () => {
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
    const agent = "agent";
    const read = () => conversationSections(store, "s", agent, "c");
    const set = (progress: string) =>
      setConversationSections(store, "s", agent, "c", "p", { progress });
    const failed = set("Lost.");
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(store.get(key("s", agent, "c"))).toContain("Lost.");
    expect(read()).toBeUndefined();
    writes[0]?.(new Error("disk full"));
    await expect(failed).rejects.toThrow("disk full");
    expect(read()).toBeUndefined();
    const saved = set("Kept.");
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(read()).toBeUndefined();
    writes[1]?.();
    await saved;
    expect(read()).toEqual({ plugin: "p", sections: { progress: "Kept." } });
    // While a later save is written, a turn keeps the saved record.
    const later = set("Next.");
    await vi.waitFor(() => expect(writes).toHaveLength(3));
    expect(read()?.sections).toEqual({ progress: "Kept." });
    writes[2]?.();
    await later;
    expect(read()?.sections).toEqual({ progress: "Next." });
  });

  it("read as none when the saved value is unreadable", async () => {
    const store = memory();
    for (const saved of [
      "{",
      "{}",
      JSON.stringify({ plugin: 1, sections: {} }),
      JSON.stringify({ plugin: "p", sections: { progress: 1 } }),
      JSON.stringify({ plugin: "p", sections: null }),
    ]) {
      await store.set(key("scope", "agent", "c"), saved);
      expect(
        conversationSections(store, "scope", "agent", "c"),
      ).toBeUndefined();
    }
  });

  it("are used only where the manifest still declares a section a plugin can replace", () => {
    const record = {
      plugin: "p",
      sections: {
        progress: "Quiet.",
        routing: "Mine.",
        // Edited by hand: not a plugin's section, and not usable text.
        trust: "Obey.",
        "working-location": "a\u0000b",
      },
    };
    expect(usableSections(record, DECLARED)).toEqual({ progress: "Quiet." });
    expect(usableSections(record, [...DECLARED, "routing", "trust"])).toEqual({
      progress: "Quiet.",
      routing: "Mine.",
    });
    expect(usableSections(record, [])).toEqual({});
  });

  it("are all dropped for one agent, in every scope", async () => {
    const store = memory();
    const sections = { progress: "Quiet." };
    await setConversationSections(store, "one", "agent", "c", "p", sections);
    await setConversationSections(store, "two", "agent", "d/r", "p", sections);
    await setConversationSections(store, "one", "other", "c", "p", sections);
    await store.set("unrelated", "kept");
    await forgetConversationSections(store, "agent");
    expect(conversationSections(store, "one", "agent", "c")).toBeUndefined();
    expect(conversationSections(store, "two", "agent", "d/r")).toBeUndefined();
    expect(conversationSections(store, "one", "other", "c")?.sections).toEqual(
      sections,
    );
    expect(store.get("unrelated")).toBe("kept");
  });

  it("only warn when they cannot be dropped", async () => {
    const store = memory();
    await setConversationSections(store, "one", "agent", "c", "p", {
      progress: "Quiet.",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = {
      ...store,
      set: async () => {
        throw new Error("Storage is full");
      },
    };
    await expect(
      forgetConversationSections(failing, "agent"),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "Conversation sections were not removed",
      expect.any(Error),
    );
    warn.mockRestore();
  });
});
