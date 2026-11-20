import { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SeenService } from "./service";

const key = "example.plugin/welcome";
const storageKey = `buzz.seen.v1:alice:${key}`;
const roots: Context[] = [];
const disk = new Map<string, string>();
const windowEvents = new EventTarget();
const read = vi.fn((key: string) => disk.get(key) ?? null);
const write = vi.fn((key: string, value: string) => disk.set(key, value));

function windowFor(viewer?: string) {
  const root = new Context();
  roots.push(root);
  const listeners = new Set<() => void>();
  const seen = new SeenService(root, {
    snapshot: () => (viewer ? { viewer } : {}),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  return {
    seen,
    dispose: () => root.fiber.dispose(),
    identify(next?: string) {
      viewer = next;
      for (const listener of listeners) listener();
    },
  };
}

function storageChanged(key: string | null) {
  windowEvents.dispatchEvent(
    Object.assign(new Event("storage"), { key, storageArea: localStorage }),
  );
}

beforeEach(() => {
  disk.clear();
  read.mockClear();
  write.mockClear();
  vi.stubGlobal("window", windowEvents);
  vi.stubGlobal("localStorage", { getItem: read, setItem: write });
});

afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose();
  vi.unstubAllGlobals();
});

it("isolates each identity and restores its marks", () => {
  const { seen, identify } = windowFor();
  expect(seen.has(key)).toBeUndefined();
  seen.mark(key);
  expect(write).not.toHaveBeenCalled();

  identify("alice");
  expect(seen.has(key)).toBe(false);
  seen.mark(key);
  seen.mark(key);
  expect(seen.has(key)).toBe(true);
  expect(write).toHaveBeenCalledExactlyOnceWith(storageKey, "1");

  identify("bob");
  expect(seen.has(key)).toBe(false);
  identify();
  expect(seen.has(key)).toBeUndefined();
  identify("alice");
  expect(seen.has(key)).toBe(true);
  expect(windowFor("alice").seen.has(key)).toBe(true);
});

it("updates subscribers for the active identity when another window saves", () => {
  const { seen } = windowFor("alice");
  const changes = vi.fn(() => seen.has(key));
  const stop = seen.subscribe(changes);
  const peer = windowFor("alice").seen;
  peer.mark(key);
  storageChanged(`buzz.seen.v1:bob:${key}`);
  expect(changes).not.toHaveBeenCalled();
  storageChanged(storageKey);
  expect(changes).toHaveReturnedWith(true);

  stop();
  disk.clear();
  storageChanged(null);
  expect(changes).toHaveBeenCalledOnce();
  expect(seen.has(key)).toBe(false);
});

it("persists independent marks immediately even before window teardown", async () => {
  const first = windowFor("alice");
  const second = windowFor("alice");
  const other = "example.plugin/another";
  expect(first.seen.has(other)).toBe(false);
  expect(second.seen.has(key)).toBe(false);
  first.seen.mark(key);
  second.seen.mark(other);
  expect(disk.get(storageKey)).toBe("1");
  expect(disk.get(`buzz.seen.v1:alice:${other}`)).toBe("1");
  await first.dispose();
  await second.dispose();
  const reopened = windowFor("alice").seen;
  expect(reopened.has(key)).toBe(true);
  expect(reopened.has(other)).toBe(true);
});

it("keeps absence unknown when storage fails and retries unsaved marks", () => {
  read.mockImplementationOnce(() => {
    throw new Error("Denied");
  });
  const { seen } = windowFor("alice");
  expect(seen.has(key)).toBeUndefined();
  write.mockImplementationOnce(() => {
    throw new Error("Quota exceeded");
  });
  seen.mark(key);
  expect(seen.has(key)).toBe(true);
  expect(disk.has(storageKey)).toBe(false);
  seen.mark(key);
  expect(windowFor("alice").seen.has(key)).toBe(true);
});

it("lets plugins activate on a host without Seen", async () => {
  const root = new Context();
  roots.push(root);
  const activation = vi.fn();
  const plugin = root.plugin((ctx) => activation(ctx.reflect.get("seen")));
  await plugin.await();
  expect(activation).toHaveBeenCalledExactlyOnceWith(undefined);
});

it("stops notifying for storage and identity changes after teardown", async () => {
  const { seen, identify, dispose } = windowFor("alice");
  const changes = vi.fn();
  seen.subscribe(changes);
  storageChanged(storageKey);
  expect(changes).toHaveBeenCalledOnce();

  await dispose();
  changes.mockClear();
  storageChanged(storageKey);
  identify("bob");
  expect(changes).not.toHaveBeenCalled();
  expect(seen.has(key)).toBeUndefined();
});

it("does not carry a failed-write mark to another identity", () => {
  const { seen, identify } = windowFor("alice");
  write.mockImplementationOnce(() => {
    throw new Error("Quota exceeded");
  });
  seen.mark(key);
  expect(seen.has(key)).toBe(true);
  expect(disk.has(storageKey)).toBe(false);

  identify("bob");
  expect(seen.has(key)).toBe(false);
});

it("accepts open names up to 96 characters", () => {
  const { seen } = windowFor("alice");
  const longest = `example.plugin/${"💡".repeat(81)}`;
  const tooLong = `${longest}!`;
  for (const invalid of [
    "unnamespaced",
    "example.plugin/",
    "example.plugin/\ud800",
    tooLong,
  ]) {
    seen.mark(invalid);
    expect(seen.has(invalid)).toBeUndefined();
  }
  expect(write).not.toHaveBeenCalled();
  seen.mark(longest);
  expect(seen.has(longest)).toBe(true);
});
