import { describe, expect, it, vi } from "vitest";
import {
  agentFolders,
  assignConversationFolder,
  conversationFolder,
  conversationKey,
  existingFolder,
  startingFolder,
} from "./conversation-folders";
import { fileStore } from "./state";
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

  it("refuse a folder once the conversation started in the workspace", async () => {
    const store = memory();
    await expect(
      startingFolder(store, "s", "agent", "c"),
    ).resolves.toBeUndefined();
    // Starting again is idempotent, and the record is no folder.
    await expect(
      startingFolder(store, "s", "agent", "c"),
    ).resolves.toBeUndefined();
    expect(conversationFolder(store, "s", "agent", "c")).toBeUndefined();
    expect(agentFolders(store, "s", "agent")).toEqual(new Map());
    await expect(
      assignConversationFolder(store, "s", "agent", "c", "/work/a"),
    ).rejects.toThrow("already started in the agent's workspace");
    // Another conversation is unaffected, and starts in the folder it has.
    await assignConversationFolder(store, "s", "agent", "d", "/work/a");
    await expect(startingFolder(store, "s", "agent", "d")).resolves.toBe(
      "/work/a",
    );
  });

  it("order the first start and an assignment by whichever saves first", async () => {
    // Each save waits for the test, so both sides are in flight at once.
    const saves: Array<() => void> = [];
    const store = fileStore(
      new Map(),
      async () => {},
      (_key, _value) =>
        new Promise<string | null>((resolve) =>
          saves.push(() => resolve(null)),
        ),
    );
    const start = startingFolder(store, "s", "agent", "c");
    const assign = assignConversationFolder(
      store,
      "s",
      "agent",
      "c",
      "/work/a",
    );
    const refused = expect(assign).rejects.toThrow(
      "already started in the agent's workspace",
    );
    // Neither is decided while the start's save is pending.
    await Promise.resolve();
    expect(saves).toHaveLength(1);
    saves[0]?.();
    await expect(start).resolves.toBeUndefined();
    await refused;
    expect(conversationFolder(store, "s", "agent", "c")).toBeUndefined();
  });

  it("refuse a folder while the start's save is pending, also when it then fails", async () => {
    let fail: ((error: Error) => void) | undefined;
    const store = fileStore(
      new Map(),
      async () => {},
      () =>
        new Promise<string | null>((_resolve, reject) => {
          fail = reject;
        }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const start = startingFolder(store, "s", "agent", "c");
    const assign = assignConversationFolder(
      store,
      "s",
      "agent",
      "c",
      "/work/a",
    );
    const settled = Promise.allSettled([start, assign]);
    await vi.waitFor(() => expect(fail).toBeDefined());
    fail?.(new Error("disk full"));
    const [started, assigned] = await settled;
    // The turn does not start without its record, and no folder is given.
    expect(started).toMatchObject({ status: "rejected" });
    expect(assigned).toMatchObject({ status: "rejected" });
    expect(conversationFolder(store, "s", "agent", "c")).toBeUndefined();
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
