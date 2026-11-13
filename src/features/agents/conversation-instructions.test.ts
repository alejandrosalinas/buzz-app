import { describe, expect, it, vi } from "vitest";
import {
  conversationInstructions,
  forgetConversationInstructions,
  setConversationInstructions,
} from "./conversation-instructions";
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

describe("conversation instructions", () => {
  it("are replaced, and cleared to empty text, per scope, agent and conversation", async () => {
    const store = memory();
    const get = (conversation: string, agent = "agent", scope = "scope") =>
      conversationInstructions(store, scope, agent, conversation);
    await setConversationInstructions(
      store,
      "scope",
      "agent",
      "c/r",
      "a",
      "One",
    );
    await setConversationInstructions(
      store,
      "scope",
      "agent",
      "c/r",
      "b",
      "Two",
    );
    expect(get("c/r")).toEqual({ plugin: "b", text: "Two" });
    expect(get("c")).toBeUndefined();
    expect(get("c/r", "other")).toBeUndefined();
    expect(get("c/r", "agent", "elsewhere")).toBeUndefined();
    // Cleared, it says so; another clear changes nothing.
    await setConversationInstructions(store, "scope", "agent", "c/r", "b", "");
    expect(get("c/r")).toEqual({ plugin: "b", text: "" });
    await setConversationInstructions(store, "scope", "agent", "c/r", "a", "");
    expect(get("c/r")).toEqual({ plugin: "b", text: "" });
    // Clearing a conversation that never had any keeps nothing.
    await setConversationInstructions(store, "scope", "agent", "c", "a", "");
    expect(get("c")).toBeUndefined();
    expect(store.keys()).toHaveLength(1);
  });

  it("are all dropped for one agent, in every scope", async () => {
    const store = memory();
    await setConversationInstructions(store, "one", "agent", "c", "p", "A");
    await setConversationInstructions(store, "two", "agent", "d/r", "p", "B");
    await setConversationInstructions(store, "one", "other", "c", "p", "C");
    await store.set("unrelated", "kept");
    await forgetConversationInstructions(store, "agent");
    expect(
      conversationInstructions(store, "one", "agent", "c"),
    ).toBeUndefined();
    expect(
      conversationInstructions(store, "two", "agent", "d/r"),
    ).toBeUndefined();
    expect(conversationInstructions(store, "one", "other", "c")?.text).toBe(
      "C",
    );
    expect(store.get("unrelated")).toBe("kept");
  });

  it("read as none when the saved value is unreadable", async () => {
    const store = memory();
    const key = `buzz.agents.conversation-instructions.v1:${JSON.stringify(["scope", "agent", "c"])}`;
    for (const saved of ["{", "{}", JSON.stringify({ plugin: 1, text: "A" })]) {
      await store.set(key, saved);
      expect(
        conversationInstructions(store, "scope", "agent", "c"),
      ).toBeUndefined();
    }
  });

  it("only warn when they cannot be dropped", async () => {
    const store = memory();
    await setConversationInstructions(store, "one", "agent", "c", "p", "A");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = {
      ...store,
      set: async () => {
        throw new Error("Storage is full");
      },
    };
    await expect(
      forgetConversationInstructions(failing, "agent"),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "Conversation instructions were not removed",
      expect.any(Error),
    );
    warn.mockRestore();
  });
});
