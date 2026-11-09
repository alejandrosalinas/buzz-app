import { expect, it, vi } from "vitest";
import {
  executionStorage,
  fileStore,
  loadAgentStorage,
  MOVED_KEY,
} from "./state";
import { memoryStorage } from "./test-fakes";
import { SyncedTeams, teamSources } from "./team-config";
import { TeamMoves } from "./team-migration";

const files = (items: Record<string, string> = {}) => {
  const saved = new Map(Object.entries(items));
  return {
    saved,
    load: vi.fn(async () => Object.fromEntries(saved)),
    set: vi.fn(async (key: string, value: string | null) => {
      if (value === null) saved.delete(key);
      else saved.set(key, value);
    }),
  };
};

it("moves agent state from localStorage, which replaces what agent storage has", async () => {
  const local = memoryStorage();
  local.setItem("buzz.agents.v1", "records");
  local.setItem("buzz.agents.teams.v1", "new teams");
  local.setItem("buzz.claude-code.sessions.v1", "sessions");
  local.setItem("buzz.codex.sessions.v4:scope:ab", "codex");
  local.setItem("buzz.codex.provider-defaults.v1", "codex defaults");
  local.setItem("buzz.claude-code.provider-defaults.v1", "claude defaults");
  local.setItem("buzz.agents.archive-unchecked.v1", "unchecked");
  local.setItem("buzz.agents.catch-up.v1", "checkpoints");
  local.setItem("buzz.agents.catch-up.v1:aa", "agent checkpoints");
  local.setItem("buzz.agent.execution.v1:aa", "binding");
  local.setItem("buzz.theme", "dark");
  const native = files({
    "buzz.agents.teams.v1": "stale teams",
    "buzz.agent.v1:aa": "kept",
  });
  const storage = await loadAgentStorage(local, native);
  expect(Object.fromEntries(native.saved)).toEqual({
    "buzz.agents.v1": "records",
    "buzz.agents.teams.v1": "new teams",
    "buzz.agent.v1:aa": "kept",
    "buzz.claude-code.sessions.v1": "sessions",
    "buzz.codex.sessions.v4:scope:ab": "codex",
    "buzz.codex.provider-defaults.v1": "codex defaults",
    "buzz.claude-code.provider-defaults.v1": "claude defaults",
    "buzz.agents.archive-unchecked.v1": "unchecked",
    "buzz.agents.catch-up.v1": "checkpoints",
    "buzz.agents.catch-up.v1:aa": "agent checkpoints",
    "buzz.agent.execution.v1:aa": "binding",
    [MOVED_KEY]: "1",
  });
  expect(storage.get("buzz.agents.teams.v1")).toBe("new teams");
  // Moved keys leave localStorage; other keys stay.
  expect(local.length).toBe(1);
  expect(local.getItem("buzz.theme")).toBe("dark");
});

it("uses localStorage for a start where a copy fails, and keeps its state through a later move", async () => {
  const local = memoryStorage();
  local.setItem("buzz.agents.v1", "records");
  local.setItem("buzz.agents.teams.v1", "teams");
  const native = files();
  // The records copy is saved; the teams copy fails.
  native.set.mockResolvedValueOnce(undefined);
  native.set.mockRejectedValueOnce(new Error("disk full"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const first = await loadAgentStorage(local, native);
  error.mockRestore();
  expect(first.get("buzz.agents.v1")).toBe("records");
  expect(first.get("buzz.agents.teams.v1")).toBe("teams");
  // The owner saves while the app uses localStorage.
  await first.set("buzz.agents.v1", "saved records");
  expect(local.getItem("buzz.agents.v1")).toBe("saved records");

  // The disk recovers: the next start moves everything, the newer records too.
  const second = await loadAgentStorage(local, native);
  expect(local.getItem("buzz.agents.v1")).toBeNull();
  await second.set("buzz.agent.v1:aa", "saved again");
  expect(native.saved.get("buzz.agent.v1:aa")).toBe("saved again");
  expect(local.getItem("buzz.agent.v1:aa")).toBeNull();

  const third = await loadAgentStorage(local, native);
  expect(third.get("buzz.agents.teams.v1")).toBe("teams");
  expect(third.get("buzz.agents.v1")).toBe("saved records");
  expect(third.get("buzz.agent.v1:aa")).toBe("saved again");
});

it("keeps the moved state when a later start without agent storage saves", async () => {
  const local = memoryStorage();
  local.setItem("buzz.agents.v1", "all records");
  local.setItem("buzz.claude-code.sessions.v1", "all sessions");
  const native = files();
  await loadAgentStorage(local, native);
  expect(local.length).toBe(0);

  // A start that cannot read agent storage begins with no agent state.
  native.load.mockRejectedValueOnce(new Error("denied"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const fallback = await loadAgentStorage(local, native);
  error.mockRestore();
  await fallback.set("buzz.claude-code.sessions.v1", "one new session");
  await fallback.set("buzz.agent.v1:bb", "new agent");
  expect(local.getItem("buzz.agent.v1:bb")).toBe("new agent");

  // The next start keeps the full copy, and adds only the new key.
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const next = await loadAgentStorage(local, native);
  warn.mockRestore();
  expect(next.get("buzz.agents.v1")).toBe("all records");
  expect(next.get("buzz.claude-code.sessions.v1")).toBe("all sessions");
  expect(next.get("buzz.agent.v1:bb")).toBe("new agent");
  expect(native.saved.get("buzz.claude-code.sessions.v1")).toBe("all sessions");
  expect(local.length).toBe(0);
});

it("keeps synced team rosters a start without agent storage saved", async () => {
  const local = memoryStorage();
  const native = files();
  await loadAgentStorage(local, native);

  native.load.mockRejectedValueOnce(new Error("denied"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const fallback = await loadAgentStorage(local, native);
  error.mockRestore();
  new SyncedTeams(fallback).set("o", "wss://home", [
    { id: "crew", channel: "ch", archived: false, members: ["a"] },
  ]);
  await vi.waitFor(() =>
    expect(local.getItem("buzz.agents.teams.synced.v1")).not.toBeNull(),
  );

  // Agent storage is back; the home community isn't reachable yet.
  const next = await loadAgentStorage(local, native);
  expect(
    teamSources(new SyncedTeams(next), "o", "a").map((team) => team.id),
  ).toEqual(["crew"]);
  expect(local.length).toBe(0);
});

it("keeps a partial team move a start without agent storage saved, so Delete still finds its relay copy", async () => {
  const local = memoryStorage();
  const native = files();
  await loadAgentStorage(local, native);

  native.load.mockRejectedValueOnce(new Error("denied"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const fallback = await loadAgentStorage(local, native);
  error.mockRestore();
  await new TeamMoves(fallback).set("local-1", {
    community: "wss://home",
    failed: true,
    created: true,
  });

  const next = await loadAgentStorage(local, native);
  expect(new TeamMoves(next).get("local-1")).toEqual({
    community: "wss://home",
    failed: true,
    created: true,
  });
  expect(local.length).toBe(0);
});

it("uses localStorage when agent storage cannot be read", async () => {
  const local = memoryStorage();
  const native = files();
  native.load.mockRejectedValueOnce(new Error("denied"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  for (const storage of [
    await loadAgentStorage(local, native),
    await loadAgentStorage(local, undefined),
  ]) {
    await storage.set("buzz.agents.v1", "here");
    expect(local.getItem("buzz.agents.v1")).toBe("here");
  }
  expect(native.set).not.toHaveBeenCalled();
  error.mockRestore();
});

it("uses localStorage when agent storage does not answer, and leaves it as it was", async () => {
  vi.useFakeTimers();
  const local = memoryStorage();
  local.setItem("buzz.agents.v1", "records");
  const native = files();
  let answer = () => {};
  native.load.mockImplementationOnce(
    () => new Promise((resolve) => (answer = () => resolve({}))),
  );
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const started = loadAgentStorage(local, native, 1_000);
  await vi.advanceTimersByTimeAsync(1_000);
  const storage = await started;
  expect(storage.get("buzz.agents.v1")).toBe("records");
  // A late answer moves nothing: the app is using localStorage.
  answer();
  await vi.runAllTimersAsync();
  error.mockRestore();
  vi.useRealTimers();
  expect(local.getItem("buzz.agents.v1")).toBe("records");
  expect(native.saved.has(MOVED_KEY)).toBe(false);
});

it("saves each write in order, and a failed write does not stop later ones", async () => {
  const native = files();
  const storage = fileStore(new Map(), native.set);
  native.set.mockRejectedValueOnce(new Error("busy"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const writes = [
    storage.set("a", "1"),
    storage.set("a", "2"),
    storage.set("b", "3"),
    storage.set("b", null),
  ];
  await expect(writes[0]).rejects.toThrow("busy");
  await Promise.all(writes.slice(1));
  error.mockRestore();
  expect(native.set.mock.calls).toEqual([
    ["a", "1"],
    ["a", "2"],
    ["b", "3"],
    ["b", null],
  ]);
  expect(Object.fromEntries(native.saved)).toEqual({ a: "2" });
  expect(storage.get("a")).toBe("2");
  expect(storage.keys()).toEqual(["a"]);
});

it("puts back a key whose write failed, so it is not taken as saved and can be set again", async () => {
  const native = files({ a: "old" });
  const storage = fileStore(new Map([["a", "old"]]), native.set);
  native.set.mockRejectedValueOnce(new Error("disk full"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const a = storage.set("a", "new");
  const b = storage.set("b", "kept");
  expect(storage.get("a")).toBe("new");
  await expect(a).rejects.toThrow("disk full");
  await expect(b).resolves.toBeUndefined();
  error.mockRestore();
  expect(storage.get("a")).toBe("old");
  // The same value again is a new write, not a no-op.
  await storage.set("a", "new");
  expect(native.saved.get("a")).toBe("new");
  expect(storage.get("a")).toBe("new");
});

it("rejects native execution when native state cannot be read", async () => {
  vi.stubGlobal("isTauri", true);
  const local = memoryStorage();
  const native = files();
  native.load.mockRejectedValueOnce(new Error("denied"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const fallback = await loadAgentStorage(local, native);
    await expect(
      executionStorage(fallback).read("buzz.agent.execution.v1:aa"),
    ).rejects.toThrow("Native agent storage is unavailable");
    await expect(
      executionStorage(fallback).add("buzz.agent.execution.v1:aa", '"local"'),
    ).rejects.toThrow("Native agent storage is unavailable");
  } finally {
    error.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("scans saved entries beyond the startup copy after its pending writes", async () => {
  const prefix = "buzz.codex.sessions.v4:agent:";
  const native = files();
  const storage = await loadAgentStorage(memoryStorage(), native);
  native.saved.set(`${prefix}other-window`, "remote");
  native.saved.set("another-prefix", "private");
  expect(storage.get(`${prefix}other-window`)).toBeNull();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const save = native.set.getMockImplementation();
  native.set.mockImplementationOnce(async (key, value) => {
    await held;
    await save?.(key, value);
  });
  const saving = storage.set(`${prefix}this-window`, "saved");
  const scanning = storage.scan(prefix);
  release();
  await saving;
  expect(await scanning).toEqual({
    [`${prefix}other-window`]: "remote",
    [`${prefix}this-window`]: "saved",
  });
  expect(storage.get(`${prefix}other-window`)).toBeNull();
  expect(storage.keys()).not.toContain(`${prefix}other-window`);
  native.load.mockRejectedValueOnce(new Error("Storage denied"));
  await expect(storage.scan(prefix)).rejects.toThrow("Storage denied");
});
