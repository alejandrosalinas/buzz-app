// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createPresenceActivity } from "./activity";
import { createPresence } from "./presence";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("observes editor input before stopped bubbling and wakes on foreground return", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("BroadcastChannel", undefined);
  let shown = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => shown as DocumentVisibilityState,
  );
  const activity = createPresenceActivity();
  const editor = document.createElement("input");
  document.body.append(editor);
  editor.addEventListener("keydown", (event) => event.stopPropagation());
  editor.addEventListener("input", (event) => event.stopPropagation());
  try {
    await vi.advanceTimersByTimeAsync(600000);
    expect(activity.status()).toBe("away");
    editor.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true }),
    );
    expect(activity.status()).toBe("online");
    await vi.advanceTimersByTimeAsync(600000);
    editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(activity.status()).toBe("online");
    shown = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(600000);
    expect(activity.status()).toBe("away");
    shown = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(activity.status()).toBe("online");
    await vi.advanceTimersByTimeAsync(600000);
    window.dispatchEvent(new Event("focus"));
    expect(activity.status()).toBe("online");
  } finally {
    activity.dispose();
  }
  await vi.advanceTimersByTimeAsync(600000);
  editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
  window.dispatchEvent(new Event("focus"));
  expect(vi.getTimerCount()).toBe(0);
});

it("publishes the real activity transition and latest editor input through the presence owner", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _name: string,
        _options: unknown,
        work: () => Promise<void>,
      ) => work(),
    },
  });
  const activity = createPresenceActivity();
  const publish = vi.fn(async () => true);
  const presence = createPresence(
    {
      viewer: "a".repeat(64),
      relayAuthor: "b".repeat(64),
      query: async () => [],
      media: () => undefined,
      presenceSnapshot: async () => new Map(),
    },
    activity,
    publish,
    (listener) => listener(),
  );
  const editor = document.createElement("input");
  document.body.append(editor);
  editor.addEventListener("keydown", (event) => event.stopPropagation());
  try {
    presence.connected(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(publish).toHaveBeenLastCalledWith("online", expect.any(AbortSignal));
    await vi.advanceTimersByTimeAsync(600000);
    expect(publish).toHaveBeenLastCalledWith("away", expect.any(AbortSignal));
    editor.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true }),
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(publish).toHaveBeenLastCalledWith("online", expect.any(AbortSignal));
    const count = publish.mock.calls.length;
    for (let i = 0; i < 100; i++)
      editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(publish).toHaveBeenCalledTimes(count);
  } finally {
    presence.dispose();
    activity.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it.each([null, "auto", "unrecognized"])(
  "preserves internal automatic behavior for saved preference %s without rewriting storage",
  async (saved) => {
    vi.useFakeTimers();
    vi.stubGlobal("BroadcastChannel", undefined);
    const viewer = "c".repeat(64);
    const key = `buzz-presence.v1:${viewer}`;
    if (saved === null) localStorage.removeItem(key);
    else localStorage.setItem(key, saved);
    const activity = createPresenceActivity();
    try {
      activity.setViewer(viewer);
      expect(activity.snapshot().preference).toBe("auto");
      expect(activity.status()).toBe("online");
      await vi.advanceTimersByTimeAsync(599999);
      expect(activity.status()).toBe("online");
      await vi.advanceTimersByTimeAsync(1);
      expect(activity.status()).toBe("away");
      document.dispatchEvent(new Event("input", { bubbles: true }));
      expect(activity.status()).toBe("online");
      expect(localStorage.getItem(key)).toBe(saved);
    } finally {
      activity.dispose();
      localStorage.removeItem(key);
    }
  },
);

it("persists viewer-local manual choices, isolates identities, follows storage changes and reports denied storage", () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  localStorage.clear();
  const activity = createPresenceActivity();
  const viewer = "a".repeat(64),
    other = "b".repeat(64);
  const key = `buzz-presence.v1:${viewer}`;
  try {
    activity.setViewer(viewer);
    activity.setPreference("offline");
    expect(activity.status()).toBe("offline");
    expect(localStorage.getItem(key)).toBe("offline");
    document.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("focus"));
    expect(activity.status()).toBe("offline");
    activity.setViewer(other);
    expect(activity.status()).toBe("online");
    activity.setViewer(viewer);
    expect(activity.status()).toBe("offline");
    localStorage.setItem(key, "away");
    window.dispatchEvent(new StorageEvent("storage", { key }));
    expect(activity.snapshot().preference).toBe("away");
    localStorage.setItem(key, "garbage");
    window.dispatchEvent(new StorageEvent("storage", { key }));
    expect(activity.snapshot().preference).toBe("auto");
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    activity.setPreference("away");
    expect(activity.status()).toBe("away");
    expect(activity.snapshot().error).toBe(
      "Could not save your availability. It applies to this window until you close it.",
    );
    write.mockRestore();
    activity.setPreference("away");
    expect(activity.snapshot().error).toBeUndefined();
    expect(localStorage.getItem(key)).toBe("away");
    const read = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    window.dispatchEvent(new StorageEvent("storage", { key }));
    expect(activity.snapshot().error).toBe(
      "Could not read your saved availability. Changes apply to this window.",
    );
    read.mockRestore();
  } finally {
    activity.dispose();
    localStorage.clear();
  }
});

it.each([null, false, "error", true] as const)(
  "retries a failed Offline clear (%s), then stops renewal until Automatic or reconnect",
  async (result) => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal("BroadcastChannel", undefined);
    vi.stubGlobal("navigator", {
      locks: {
        request: async (
          _name: string,
          _options: unknown,
          work: () => Promise<void>,
        ) => work(),
      },
    });
    localStorage.clear();
    const activity = createPresenceActivity();
    activity.setViewer("a".repeat(64));
    activity.setPreference("offline");
    const publish = vi.fn(async (): Promise<boolean | null> => true);
    publish.mockImplementationOnce(async () => {
      if (result === "error") throw new Error("failed");
      return result;
    });
    const presence = createPresence(
      {
        viewer: "a".repeat(64),
        relayAuthor: "b".repeat(64),
        query: async () => [],
        media: () => undefined,
        presenceSnapshot: async () => new Map(),
      },
      activity,
      publish,
      (fn) => fn(),
    );
    try {
      presence.connected(true);
      await vi.advanceTimersByTimeAsync(250);
      expect(publish).toHaveBeenLastCalledWith(
        "offline",
        expect.any(AbortSignal),
      );
      expect(activity.status()).toBe("offline");
      await vi.advanceTimersByTimeAsync(180000);
      expect(publish).toHaveBeenCalledTimes(result === true ? 1 : 2);
      const count = publish.mock.calls.length;
      document.dispatchEvent(new Event("keydown"));
      await vi.advanceTimersByTimeAsync(600000);
      expect(publish).toHaveBeenCalledTimes(count);
      presence.connected(false);
      presence.connected(true);
      await vi.advanceTimersByTimeAsync(250);
      expect(publish).toHaveBeenCalledTimes(count + 1);
      activity.setPreference("auto");
      await vi.advanceTimersByTimeAsync(250);
      expect(activity.status()).toBe("online");
      expect(publish).toHaveBeenLastCalledWith(
        "online",
        expect.any(AbortSignal),
      );
    } finally {
      presence.dispose();
      activity.dispose();
      localStorage.clear();
    }
  },
);
