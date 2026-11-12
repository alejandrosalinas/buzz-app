import { beforeEach, expect, it, vi } from "vitest";
import type { HostProcessOptions } from "../../features/host/service";
import { ClaudeAuth } from "./auth";
import { ENV, type Spawn } from "./claude";

const KEY = "sk-ant-api03-saved";

/** Native's key store (`claude_key.rs`): whether a key is saved, the asks
 * and saves it took, and a refusal to answer the next save with. */
const state = vi.hoisted(() => ({
  saved: true,
  asked: 0,
  saves: [] as string[],
  clears: 0,
  refusals: [] as string[],
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: async (command: string, args?: { value: string }) => {
    if (command === "claude_api_key_status") {
      state.asked += 1;
      return state.saved;
    }
    if (command === "claude_api_key_clear") {
      state.clears++;
      const refusal = state.refusals.shift();
      if (refusal) throw refusal;
      state.saved = false;
      return null;
    }
    if (command !== "claude_api_key_set" || !args) return null;
    const refusal = state.refusals.shift();
    if (refusal) throw refusal;
    state.saves.push(args.value);
    state.saved = true;
    return null;
  },
}));
/** Starts with a key saved or not. */
function store(saved = true) {
  Object.assign(state, {
    saved,
    asked: 0,
    saves: [],
    clears: 0,
    refusals: [],
  });
}
beforeEach(() => void store());

/** A host whose `claude.sh review` prints a review folder; every start is
 * recorded. */
function host() {
  const started: { id: string; options: HostProcessOptions | undefined }[] = [];
  const spawn: Spawn = async (id, options) => {
    started.push({ id, options });
    if (id === "review")
      queueMicrotask(() => options?.onStdout?.("/Users/me/review\n"));
    return {
      write: async () => undefined,
      end: async () => undefined,
      kill: async () => undefined,
      exited: Promise.resolve(0),
    };
  };
  return { spawn, started };
}

it("asks native code to start every claude, the protected release included, with the key", async () => {
  const { spawn, started } = host();
  const auth = new ClaudeAuth(spawn);
  const authorized = auth.authorize(spawn, true);
  for (const id of ["claude", "claude-protected-arm64"])
    await authorized(id, { args: ["--verbose"], env: { ...ENV, A: "1" } });
  await authorized("platform", { env: { ...ENV } });
  expect(started.map(({ id }) => id)).toEqual([
    "claude",
    "claude-protected-arm64",
    "platform",
  ]);
  for (const { options } of started.slice(0, 2)) {
    expect(options).toEqual({
      args: ["--verbose"],
      env: { ...ENV, A: "1" },
      secrets: ["anthropic-api-key"],
    });
    // Process launches never read or forward the key through JavaScript.
    expect(JSON.stringify(options)).not.toContain("sk-ant-");
  }
  expect(started[2]?.options).toEqual({ env: { ...ENV } });
});

it("refuses a turn's claude without a key, but lets setup run its checks", async () => {
  const { spawn, started } = host();
  store(false);
  const auth = new ClaudeAuth(spawn);
  await expect(
    auth.authorize(spawn, true)("claude", { env: ENV }),
  ).rejects.toThrow("Claude needs an Anthropic API key.");
  expect(started).toEqual([]);
  await auth.authorize(spawn)("claude", { args: ["--version"], env: ENV });
  expect(started.at(-1)).toEqual({
    id: "claude",
    options: {
      args: ["--version"],
      env: ENV,
      secrets: ["anthropic-api-key"],
    },
  });
});

it("asks again until a key is saved, then once until it is saved or checked", async () => {
  const { spawn } = host();
  store(false);
  const auth = new ClaudeAuth(spawn);
  await expect(auth.check()).resolves.toBeUndefined();
  // No key is not kept: another Buzz on this computer may save one.
  state.saved = true;
  await auth.authorize(spawn, true)("claude");
  expect(state.asked).toBe(2);
  // A key is kept until it is checked or saved.
  state.saved = false;
  await auth.authorize(spawn, true)("claude");
  expect(state.asked).toBe(2);
  await expect(auth.check()).resolves.toBeUndefined();
  state.saved = true;
  await expect(auth.check()).resolves.toEqual({});
  await auth.save(KEY);
  await auth.authorize(spawn, true)("claude");
  expect(state.asked).toBe(5);
});

it("saves the key with native code alone and tells listeners, but not of a refused one", async () => {
  const { spawn, started } = host();
  store(false);
  state.refusals.push("That is not an Anthropic API key.");
  const auth = new ClaudeAuth(spawn);
  const told = vi.fn();
  auth.subscribe(told);
  await expect(auth.save("nope")).rejects.toBe(
    "That is not an Anthropic API key.",
  );
  expect(told).not.toHaveBeenCalled();
  await expect(auth.save(KEY)).resolves.toBe("Saved the Anthropic API key.");
  expect(told).toHaveBeenCalledTimes(1);
  expect(state.saves).toEqual([KEY]);
  expect(started).toEqual([]);
  // A save stopped before it reaches the store saves nothing.
  const stopped = new AbortController();
  stopped.abort();
  await expect(auth.save(KEY, stopped.signal)).rejects.toThrow();
  expect(state.saves).toEqual([KEY]);
});

it("gives a review its own folder, the key coming from native code", async () => {
  const { spawn } = host();
  await expect(new ClaudeAuth(spawn).review()).resolves.toEqual({
    home: "/Users/me/review",
    env: {},
  });
  store(false);
  await expect(new ClaudeAuth(spawn).review()).rejects.toThrow(
    "Claude needs an Anthropic API key.",
  );
});

it("clears the native key, invalidates cached authorization, and notifies sessions", async () => {
  const { spawn, started } = host();
  const auth = new ClaudeAuth(spawn);
  const told = vi.fn();
  auth.subscribe(told);
  await auth.authorize(spawn, true)("claude");
  await auth.clear();
  expect(state.clears).toBe(1);
  expect(told).toHaveBeenCalledOnce();
  await expect(auth.authorize(spawn, true)("claude")).rejects.toThrow(
    "Claude needs an Anthropic API key.",
  );
  await expect(auth.review()).rejects.toThrow(
    "Claude needs an Anthropic API key.",
  );
  expect(started).toHaveLength(1);
  await auth.save(KEY);
  await auth.authorize(spawn, true)("claude");
  expect(started).toHaveLength(2);
});

it("preserves authorization on a failed removal and notifies only after retry succeeds", async () => {
  const { spawn } = host();
  const auth = new ClaudeAuth(spawn);
  const told = vi.fn();
  auth.subscribe(told);
  state.refusals.push("Keychain access was denied.");
  await expect(auth.clear()).rejects.toBe("Keychain access was denied.");
  expect(told).not.toHaveBeenCalled();
  await expect(auth.check()).resolves.toEqual({});
  await auth.clear();
  expect(told).toHaveBeenCalledOnce();
  await expect(auth.check()).resolves.toBeUndefined();
});

it("links a turn that failed for want of a working key to Settings", async () => {
  const auth = new ClaudeAuth(undefined);
  const settings = "buzz://settings?section=agents";
  const missing = await auth
    .authorize(async () => {
      throw new Error("unreachable");
    }, true)("claude")
    .then(
      () => "",
      (error: unknown) => String(error),
    );
  expect(auth.explainTurn(missing, settings)).toBe(
    `Claude is missing an API key. Head to [Settings](${settings}) to add one.`,
  );
  expect(
    auth.explainTurn("Invalid API key · Fix external API key", settings),
  ).toBe(
    `Anthropic rejected Claude's API key. It may have been revoked or run out of credit. Head to [Settings](${settings}) to replace it.`,
  );
  expect(auth.explainTurn("Error: overloaded", settings)).toBe(
    "Error: overloaded",
  );
});
