import { describe, expect, it, vi } from "vitest";
import {
  agentFolders,
  assignConversationFolder,
  conversationFolder,
  conversationKey,
  existingFolder,
} from "./conversation-folders";
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

describe("conversation folders", () => {
  it("are set once per scope, agent and conversation", async () => {
    const store = memory();
    const thread = conversationKey("channel", "root");
    expect(thread).toBe("channel/root");
    await expect(
      assignConversationFolder(store, "scope", "agent", thread, "/work/a"),
    ).resolves.toBe("/work/a");
    // The same folder again is a no-op.
    await expect(
      assignConversationFolder(store, "scope", "agent", thread, "/work/a"),
    ).resolves.toBe("/work/a");
    await expect(
      assignConversationFolder(store, "scope", "agent", thread, "/work/b"),
    ).rejects.toThrow("This conversation already works in /work/a");
    expect(conversationFolder(store, "scope", "agent", thread)).toBe("/work/a");
    expect(
      conversationFolder(store, "scope", "agent", "channel"),
    ).toBeUndefined();
    expect(conversationFolder(store, "other", "agent", thread)).toBeUndefined();
    expect(conversationFolder(store, "scope", "other", thread)).toBeUndefined();
  });

  it("lists every folder one agent's conversations were given", async () => {
    const store = memory();
    await assignConversationFolder(store, "s", "agent", "c/r", "/work/a");
    await assignConversationFolder(store, "s", "agent", "d", "/work/b");
    await assignConversationFolder(store, "s", "agent-2", "e", "/work/c");
    await assignConversationFolder(store, "t", "agent", "f", "/work/d");
    expect(agentFolders(store, "s", "agent")).toEqual(
      new Map([
        ["c/r", "/work/a"],
        ["d", "/work/b"],
      ]),
    );
  });

  it("check a folder still exists without creating it", async () => {
    const resolve = vi.fn(async (path: string) => `${path}-real`);
    await expect(existingFolder(resolve, "/work/a")).resolves.toBe(
      "/work/a-real",
    );
    expect(resolve).toHaveBeenCalledWith("/work/a", { create: false });
    resolve.mockRejectedValueOnce(new Error("Could not find /work/a"));
    await expect(existingFolder(resolve, "/work/a")).rejects.toThrow(
      "This conversation's folder /work/a no longer exists",
    );
    resolve.mockRejectedValueOnce(new Error("/work/a is not a directory"));
    await expect(existingFolder(resolve, "/work/a")).rejects.toThrow(
      "no longer exists",
    );
    // A passing failure is not reported as a missing folder.
    resolve.mockRejectedValueOnce(new Error("Too many file operations"));
    await expect(existingFolder(resolve, "/work/a")).rejects.toThrow(
      "Too many file operations",
    );
    await expect(existingFolder(undefined, "/work/a")).rejects.toThrow(
      "desktop app",
    );
  });
});
