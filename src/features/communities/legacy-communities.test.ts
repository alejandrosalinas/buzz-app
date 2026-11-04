import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import { createCommunities } from "./service";
import {
  importLegacyCommunities,
  legacyImportPending,
} from "./legacy-communities";
import { flush } from "../relay/testing";

const viewer = "a".repeat(64);

function setup() {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  const root = new Context();
  const communities = createCommunities(
    root,
    false,
    undefined,
    "",
    undefined,
    Promise.resolve(viewer),
  );
  return { storage, root, communities };
}

it("imports once and only after consent", async () => {
  const { storage, root, communities } = setup();
  let answer!: (approved: boolean) => void;
  const pending = new Promise<boolean>((resolve) => {
    answer = resolve;
  });
  const confirm = vi.fn(() => pending);
  const read = vi.fn(async () => [
    { relayUrl: "wss://old.example", pubkey: viewer },
  ]);
  const dispose = importLegacyCommunities(communities, confirm, read);
  try {
    await flush();
    expect(confirm).toHaveBeenCalledWith(["https://old.example"]);
    expect(communities.snapshot().memberships).toEqual([]);
    expect(storage.size).toBe(0);
    expect(legacyImportPending()).toBe(true);
    answer(true);
    await flush();
    expect(legacyImportPending()).toBe(false);
    expect(communities.snapshot().memberships).toEqual([
      { id: "https://old.example", name: "old.example" },
    ]);
    expect(communities.snapshot().sync.outbox).toEqual([
      { url: "wss://old.example", removed: false },
    ]);
    expect(storage.get(`buzz-legacy-communities.v1:${viewer}`)).toBe("1");
    dispose();
    importLegacyCommunities(communities, confirm, read)();
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    dispose();
    answer(false);
    await root.fiber.dispose();
    vi.unstubAllGlobals();
  }
});

it("a failed read is no longer pending and is retried on the next launch", async () => {
  const { storage, root, communities } = setup();
  const confirm = vi.fn(async () => true);
  const read = vi.fn(async () => {
    throw new Error("Old Buzz's storage is locked");
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const dispose = importLegacyCommunities(communities, confirm, read);
  try {
    await flush();
    expect(read).toHaveBeenCalledOnce();
    expect(legacyImportPending()).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(storage.size).toBe(0);
  } finally {
    dispose();
    warn.mockRestore();
    await root.fiber.dispose();
    vi.unstubAllGlobals();
  }
});
