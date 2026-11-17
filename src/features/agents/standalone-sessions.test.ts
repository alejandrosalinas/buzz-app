// @vitest-environment node
import { expect, it, vi } from "vitest";
import { PROMPTS_BUDGET, sessionPrompts } from "./session-prompts";
import {
  removeStandaloneSessions,
  STANDALONE_DAYS,
  STANDALONE_PREFIX,
  standaloneSessions,
} from "./standalone-sessions";
import { localStore } from "./store";

const AGENT = "a".repeat(64);
const OTHER = "b".repeat(64);
const DAY = 86_400_000;
const memory = () => {
  const items = new Map<string, string>();
  return localStore({
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    clear: () => items.clear(),
  });
};

it("keeps each one-off turn's session once, with when it started", async () => {
  const storage = memory();
  let now = 1_000;
  const sessions = standaloneSessions(storage, "pi", AGENT, () => now);
  await sessions.add("s1");
  now = 2_000;
  await sessions.add("s2");
  await sessions.add("s1");
  expect(sessions.list()).toEqual([
    { id: "s1", at: 1_000 },
    { id: "s2", at: 2_000 },
  ]);
  // Each agent type and agent keeps its own.
  expect(standaloneSessions(storage, "claude-code", AGENT).list()).toEqual([]);
  expect(standaloneSessions(storage, "pi", OTHER).list()).toEqual([]);
});

it("outlasts the saved prompts dropping its sessions", async () => {
  const storage = memory();
  const prompts = sessionPrompts(storage, "pi", AGENT);
  await prompts.save("once", [], { at: 1, title: "", conversation: null });
  await standaloneSessions(storage, "pi", AGENT).add("once");
  for (const later of ["l1", "l2", "l3"])
    await prompts.save(later, [
      { label: "", text: later.repeat(PROMPTS_BUDGET / 6) },
    ]);
  expect(prompts.sessions().map(({ id }) => id)).not.toContain("once");
  expect(
    standaloneSessions(storage, "pi", AGENT)
      .list()
      .map(({ id }) => id),
  ).toEqual(["once"]);
});

it("keeps a session for as long as Usage reads back, then drops its day", async () => {
  const storage = memory();
  let now = 0;
  const sessions = standaloneSessions(storage, "pi", AGENT, () => now);
  await sessions.add("old");
  now = STANDALONE_DAYS * DAY;
  expect(sessions.list().map(({ id }) => id)).toEqual(["old"]);
  now += 1;
  expect(sessions.list()).toEqual([]);
  // Its day's value stays until all of that day is past keeping.
  await sessions.add("late");
  expect(storage.get(`${STANDALONE_PREFIX}pi:${AGENT}:0`)).not.toBeNull();
  now = (STANDALONE_DAYS + 1) * DAY;
  await sessions.add("new");
  expect(storage.get(`${STANDALONE_PREFIX}pi:${AGENT}:0`)).toBeNull();
  expect(
    JSON.parse(
      storage.get(`${STANDALONE_PREFIX}pi:${AGENT}:${STANDALONE_DAYS + 1}`) ??
        "",
    ),
  ).toEqual({ version: 1, sessions: [["new", now]] });
  expect(sessions.list().map(({ id }) => id)).toEqual(["late", "new"]);
});

it("keeps every session in the window, however often turns run", async () => {
  // One timer at its shortest interval, a minute, for 30 days: far past any
  // fixed count, and its oldest start must still be counted.
  const storage = memory();
  const start = 100 * DAY;
  const minutes = 30 * 1_440;
  for (let day = 0; day < 30; day += 1)
    await storage.set(
      `${STANDALONE_PREFIX}pi:${AGENT}:${100 + day}`,
      JSON.stringify({
        version: 1,
        sessions: Array.from({ length: 1_440 }, (_, minute) => [
          `s${day * 1_440 + minute}`,
          start + (day * 1_440 + minute) * 60_000,
        ]),
      }),
    );
  const sessions = standaloneSessions(
    storage,
    "pi",
    AGENT,
    () => start + minutes * 60_000,
  );
  await sessions.add("newest");
  const ids = sessions.list().map(({ id }) => id);
  expect(ids).toHaveLength(minutes + 1);
  expect(ids[0]).toBe("s0");
  expect(ids.at(-1)).toBe("newest");
  // Each turn rewrites only its own day's value.
  for (const key of storage.keys())
    expect(storage.get(key)?.length ?? 0).toBeLessThan(200_000);
});

it("keeps entries with more fields than it reads", async () => {
  const storage = memory();
  let now = 5 * DAY;
  const key = `${STANDALONE_PREFIX}pi:${AGENT}:5`;
  await storage.set(
    key,
    JSON.stringify({ version: 1, sessions: [["s1", now, "timer/daily"]] }),
  );
  const sessions = standaloneSessions(storage, "pi", AGENT, () => now);
  now += 1;
  await sessions.add("s2");
  expect(sessions.list()).toEqual([
    { id: "s1", at: 5 * DAY },
    { id: "s2", at: now },
  ]);
  expect(JSON.parse(storage.get(key) ?? "").sessions[0]).toEqual([
    "s1",
    5 * DAY,
    "timer/daily",
  ]);
});

it("drops damaged entries and reads a damaged value or key as none", async () => {
  const storage = memory();
  const now = Date.now();
  const key = `${STANDALONE_PREFIX}pi:${AGENT}:${Math.floor(now / DAY)}`;
  await storage.set(
    `${STANDALONE_PREFIX}pi:${AGENT}:soon`,
    JSON.stringify({ version: 1, sessions: [["bad key", now]] }),
  );
  await storage.set(
    key,
    JSON.stringify({
      version: 1,
      sessions: [
        ["ok", now],
        ["", 1],
        ["x".repeat(257), 1],
        [3, 1],
        ["t", "soon"],
      ],
    }),
  );
  expect(
    standaloneSessions(storage, "pi", AGENT)
      .list()
      .map(({ id }) => id),
  ).toEqual(["ok"]);
  await storage.set(key, "{");
  expect(standaloneSessions(storage, "pi", AGENT).list()).toEqual([]);
});

it("logs a failed save rather than throwing", async () => {
  const storage = memory();
  const failing = {
    ...storage,
    set: async () => {
      throw new Error("full");
    },
  };
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(
      standaloneSessions(failing, "pi", AGENT).add("s"),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  } finally {
    error.mockRestore();
  }
});

it("removes a membership's sessions of every agent type, and only its", async () => {
  const storage = memory();
  await standaloneSessions(storage, "pi", AGENT).add("p");
  await standaloneSessions(storage, "claude-code", AGENT).add("c");
  await standaloneSessions(storage, "pi", OTHER).add("o");
  await removeStandaloneSessions(storage, AGENT);
  expect(standaloneSessions(storage, "pi", AGENT).list()).toEqual([]);
  expect(standaloneSessions(storage, "claude-code", AGENT).list()).toEqual([]);
  expect(
    standaloneSessions(storage, "pi", OTHER)
      .list()
      .map(({ id }) => id),
  ).toEqual(["o"]);
});
