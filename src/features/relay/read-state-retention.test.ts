import { expect, it } from "vitest";
import {
  retainLocalRead,
  READ_RESERVE_KEYS,
  READ_RESERVE_BYTES,
  retainRead,
  retainReadState,
} from "./read-state-retention";
import {
  effectiveFrontier,
  overrideActive,
  READ_STATE_PLAINTEXT_BYTES,
} from "./read-state-model";

it("prunes only expendable frontiers and never loses floors or ancestry that makes a child override inactive", () => {
  const state = {
    frontiers: {
      room: 20,
      "thread:root": 30,
      "msg:child": 1,
      ...Object.fromEntries(
        Array.from({ length: 300 }, (_, n) => [`msg:${n}`, 100]),
      ),
    },
    overrides: {
      "msg:child": { set: 4, clear: 0, baseline: 15 },
      other: { set: 0, clear: 9, baseline: 0 },
    },
  };
  const kept = retainReadState([state], {}, "fixture", 512);
  expect(kept.overrides).toEqual(state.overrides);
  expect(kept.frontiers.room).toBe(20);
  expect(kept.frontiers["thread:root"]).toBe(30);
  expect(kept.frontiers["msg:child"]).toBe(1);
  expect(
    overrideActive(
      kept.overrides["msg:child"],
      effectiveFrontier(kept, "msg:child", "room", "root"),
    ),
  ).toBe(false);
  expect(() => retainReadState([state], {}, "fixture", 50)).toThrow("capacity");
});
it("a recent local read of old history outranks remote event age, without inventing a channel prefix", () => {
  const state = {
    frontiers: {
      "msg:old": 1,
      ...Object.fromEntries(
        Array.from({ length: 300 }, (_, n) => [`msg:${n}`, 100]),
      ),
    },
    overrides: {},
  };
  const kept = retainReadState([state], { "msg:old": 1 }, "fixture", 128);
  expect(kept.frontiers["msg:old"]).toBe(1);
  expect(
    Object.keys(kept.frontiers).every((key) => key.startsWith("msg:")),
  ).toBe(true);
  expect(kept).toEqual(
    retainReadState([kept, state], { "msg:old": 1 }, "fixture", 128),
  );
});
it("keeps an old channel mark when newer message reads fill the budget", () => {
  const thread = `thread:${"a".repeat(64)}`;
  const flood = Object.fromEntries(
    Array.from({ length: 2000 }, (_, n) => [
      `msg:${n.toString(16).padStart(64, "0")}`,
      1000 + n,
    ]),
  );
  const state = {
    frontiers: { quiet: 50, "activity:other": 40, [thread]: 30, ...flood },
    overrides: {},
  };
  // Every message read is more recent than the channel and thread reads.
  const recent = Object.fromEntries(
    Object.keys(flood).map((key, n) => [key, 10 + n]),
  );
  for (const budget of [undefined, READ_STATE_PLAINTEXT_BYTES]) {
    const kept = retainReadState([state], recent, "fixture", budget);
    expect(kept.frontiers).toMatchObject({
      quiet: 50,
      "activity:other": 40,
      [thread]: 30,
    });
    expect(Object.keys(kept.frontiers).length).toBeLessThan(2003);
  }
});
it("at the synced limit, recent catch-up never pushes out a quiet channel's mark", () => {
  const id = (prefix: string, n: number) =>
    `${prefix}${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
  // Logan's Sep 28 state had 295 channel marks. Every channel and thread
  // mark is older and less recently used than every catch-up mark.
  const channels = Array.from({ length: 300 }, (_, n) => id("", n));
  const threads = Array.from(
    { length: 100 },
    (_, n) => `thread:${n.toString(16).padStart(64, "0")}`,
  );
  const activity = Array.from({ length: 600 }, (_, n) =>
    id("activity:", 1000 + n),
  );
  const state = {
    frontiers: Object.fromEntries([
      ...channels.map((key) => [key, 10] as const),
      ...threads.map((key) => [key, 20] as const),
      ...activity.map((key, n) => [key, 1000 + n] as const),
    ]),
    overrides: {},
  };
  const recent = Object.fromEntries(activity.map((key, n) => [key, 100 + n]));
  const kept = retainReadState(
    [state],
    recent,
    "fixture",
    READ_STATE_PLAINTEXT_BYTES,
  );
  const keys = Object.keys(kept.frontiers);
  // The budget is genuinely full: some catch-up marks did not fit.
  expect(keys.filter((key) => key.startsWith("activity:")).length).toBeLessThan(
    activity.length,
  );
  for (const key of [...channels, ...threads])
    expect(kept.frontiers[key]).toBe(state.frontiers[key]);
});
it("row seen marks go last and are never override ancestry", () => {
  const seen = Array.from({ length: 300 }, (_, n) => [`seen:room${n}`, 100]);
  const state = {
    frontiers: { room: 20, "msg:a": 5, ...Object.fromEntries(seen) },
    overrides: { "msg:child": { set: 4, clear: 0, baseline: 15 } },
  };
  // Ancestry would need every seen mark kept, which cannot fit.
  const kept = retainReadState([state], {}, "fixture", 512);
  expect(kept.overrides).toEqual(state.overrides);
  expect(kept.frontiers.room).toBe(20);
  expect(kept.frontiers["msg:a"]).toBe(5);
  const rows = Object.keys(kept.frontiers).filter((key) =>
    key.startsWith("seen:"),
  );
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.length).toBeLessThan(seen.length);
});
it("row receipts never crowd out read receipts in the local reserve", () => {
  const hex = (n: number) => n.toString(16).padStart(64, "0");
  const marks = (prefix: string, from: number, count: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, n) => [
        `${prefix}${hex(from + n)}`,
        100,
      ]),
    );
  // An override makes inherited floors protected; row receipts are not floors.
  const before = retainLocalRead(
    [
      {
        frontiers: marks("msg:", 0, 6500),
        overrides: { room: { set: 1, clear: 0, baseline: 0 } },
      },
    ],
    {},
    "fixture",
  );
  const after = retainLocalRead(
    [
      before.state,
      { frontiers: marks("seen:msg:", 10000, 1000), overrides: {} },
    ],
    before.recent,
    "fixture",
    before.reserve,
  );
  const reads = (kept: typeof before) =>
    Object.keys({ ...kept.state.frontiers, ...kept.reserve }).filter((key) =>
      key.startsWith("msg:"),
    ).length;
  expect(reads(after)).toBe(reads(before));
});
it("old broad marks never crowd out the newest read", () => {
  const hex = (n: number) => n.toString(16).padStart(64, "0");
  const uuid = (n: number) =>
    `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const fresh = `msg:${"f".repeat(64)}`;
  const cases = [
    // Stale thread catch-up marks alone exceed the local budget.
    {
      budget: undefined,
      old: Array.from({ length: 1300 }, (_, n) => `thread-activity:${hex(n)}`),
      kept: [] as string[],
    },
    // Stale channel catch-up marks fill the synced budget.
    {
      budget: READ_STATE_PLAINTEXT_BYTES,
      old: Array.from({ length: 900 }, (_, n) => `activity:${uuid(n)}`),
      kept: [] as string[],
    },
    // The Sep 28 state: 295 channel marks and 459 thread marks.
    {
      budget: READ_STATE_PLAINTEXT_BYTES,
      old: [
        ...Array.from({ length: 295 }, (_, n) => uuid(n)),
        ...Array.from({ length: 459 }, (_, n) => `thread:${hex(n)}`),
      ],
      kept: Array.from({ length: 295 }, (_, n) => uuid(n)),
    },
  ];
  for (const { budget, old, kept: quiet } of cases) {
    const state = {
      frontiers: {
        ...Object.fromEntries(old.map((key, n) => [key, 100 + n])),
        [fresh]: 50,
      },
      overrides: {},
    };
    const recent = {
      ...Object.fromEntries(old.map((key, n) => [key, 10 + n])),
      [fresh]: 100_000,
    };
    const kept = retainReadState([state], recent, "fixture", budget);
    // The budget is genuinely full.
    expect(Object.keys(kept.frontiers).length).toBeLessThan(old.length + 1);
    expect(kept.frontiers[fresh]).toBe(50);
    // Quiet channel marks still fit in the broad share.
    for (const key of quiet)
      expect(kept.frontiers[key]).toBe(state.frontiers[key]);
  }
});
it("drops covered marks, unless overrides need ancestry", () => {
  const state = {
    frontiers: { room: 20, "msg:covered": 10, "msg:other": 30 },
    overrides: {},
  };
  const covered = (
    key: string,
    frontier: (key: string) => number | undefined,
  ) =>
    key === "msg:covered" && (frontier("room") ?? -1) >= 10
      ? "room"
      : undefined;
  expect(
    retainReadState([state], {}, "fixture", undefined, covered).frontiers,
  ).toEqual({ room: 20, "msg:other": 30 });
  const withOverride = {
    ...state,
    overrides: { other: { set: 0, clear: 9, baseline: 0 } },
  };
  expect(
    retainReadState([withOverride], {}, "fixture", undefined, covered)
      .frontiers,
  ).toEqual(state.frontiers);
});
// A thread mark with no local use, as merged from another device, and a fresh
// catch-up read it covers. Twenty more recently used thread marks compete.
function coveredRead() {
  const thread = (n: number) => `thread:${n.toString(16).padStart(64, "0")}`;
  const cover = thread(999);
  const read = `thread-activity:${"9".repeat(61)}3e7`;
  const others = Array.from({ length: 20 }, (_, n) => thread(n));
  const covered = (
    key: string,
    frontier: (key: string) => number | undefined,
  ) =>
    key === read && (frontier(cover) ?? -1) >= (frontier(read) ?? 0)
      ? cover
      : undefined;
  return {
    cover,
    read,
    covered,
    state: {
      frontiers: {
        ...Object.fromEntries(others.map((key, n) => [key, 100 + n])),
        [cover]: 60,
        [read]: 50,
      },
      overrides: {},
    },
    recent: {
      ...Object.fromEntries(others.map((key, n) => [key, 10 + n])),
      [read]: 1000,
    },
  };
}
/** The read stays read when it or its cover survives at its own value. */
const stillRead = (
  kept: { frontiers: Readonly<Record<string, number>> },
  { cover, read }: { cover: string; read: string },
) => (kept.frontiers[read] ?? 0) >= 50 || (kept.frontiers[cover] ?? 0) >= 50;
it("a cover that does not fit never replaces a fresh read", () => {
  const { state, recent, covered, ...marks } = coveredRead();
  const kept = retainReadState([state], recent, "fixture", 600, covered);
  // The budget is genuinely full.
  expect(Object.keys(kept.frontiers).length).toBeLessThan(10);
  expect(stillRead(kept, marks)).toBe(true);
});
it("a cover that replaces a fresh read keeps its recency at the synced limit", () => {
  const { state, recent, covered, ...marks } = coveredRead();
  const local = retainRead([state], recent, "fixture", undefined, covered);
  // Locally there is room, so the cover replaces the read and takes its use.
  expect(local.state.frontiers[marks.read]).toBeUndefined();
  expect(local.state.frontiers[marks.cover]).toBe(60);
  expect(local.recent[marks.cover]).toBe(1000);
  // The smaller publication budget still protects it as a fresh read.
  const published = retainReadState(
    [local.state],
    local.recent,
    "fixture",
    600,
    covered,
  );
  expect(Object.keys(published.frontiers).length).toBeLessThan(10);
  expect(stillRead(published, marks)).toBe(true);
});

it("bounds the local reserve by entries and bytes, dropping oldest receipts deterministically and raising the floor over them", () => {
  for (const width of [64, 240]) {
    const frontiers = Object.fromEntries(
      Array.from({ length: 8000 }, (_, n) => [
        `msg:${n.toString(16).padStart(width, "0")}`,
        n + 1,
      ]),
    );
    const kept = retainLocalRead([{ frontiers, overrides: {} }], {}, "fixture");
    expect(Object.keys(kept.reserve).length).toBeLessThanOrEqual(
      READ_RESERVE_KEYS,
    );
    expect(
      new TextEncoder().encode(JSON.stringify(kept.reserve)).length,
    ).toBeLessThanOrEqual(READ_RESERVE_BYTES);
    expect(Object.keys(kept.reserve).length).toBeGreaterThan(1900);
    expect(Object.values(kept.reserve)).not.toContain(1);
    for (const [key, value] of Object.entries(kept.reserve)) {
      expect(frontiers[key]).toBe(value);
      expect(kept.state.frontiers[key]).toBeUndefined();
    }
    // Every dropped receipt is at or below the floor, so it stays read.
    const local = { ...kept.reserve, ...kept.state.frontiers };
    const dropped = Object.entries(frontiers).filter(
      ([key]) => !(key in local),
    );
    expect(dropped.length).toBeGreaterThan(0);
    expect(kept.floor).toBe(Math.max(...dropped.map(([, value]) => value)));
    expect(Math.min(...Object.values(kept.reserve))).toBe(kept.floor + 1);
    expect(
      retainLocalRead(
        [kept.state],
        kept.recent,
        "fixture",
        kept.reserve,
        undefined,
        kept.floor,
      ),
    ).toEqual(kept);
  }
});
it("keeps a tied covering receipt in the reserve's last slot without raising the floor", () => {
  const reserve = {
    ...Object.fromEntries(
      Array.from({ length: READ_RESERVE_KEYS - 1 }, (_, n) => [
        `msg:${n}`,
        200,
      ]),
    ),
    "thread-activity:root": 100,
    "thread:root": 100,
  };
  const kept = retainLocalRead([], {}, "fixture", reserve, (key, frontier) =>
    key === "thread-activity:root" &&
    (frontier("thread:root") ?? -1) >= (frontier(key) ?? 0)
      ? "thread:root"
      : undefined,
  );
  expect(Object.keys(kept.reserve)).toHaveLength(READ_RESERVE_KEYS);
  expect(kept.reserve["thread:root"]).toBe(100);
  expect(kept.reserve["thread-activity:root"]).toBeUndefined();
  expect(kept.floor).toBe(0);
});
it("never advances the floor when protected ancestry fills the reserve ahead of newer messages", () => {
  const reserve = Object.fromEntries(
    Array.from({ length: READ_RESERVE_KEYS }, (_, n) => [
      `thread:${n}`,
      1_000_000 + n,
    ]),
  );
  const kept = retainLocalRead(
    [
      {
        frontiers: Object.fromEntries(
          Array.from({ length: 8000 }, (_, n) => [`msg:${n}`, 2_000_000 + n]),
        ),
        overrides: { child: { set: 1, clear: 0, baseline: 0 } },
      },
    ],
    {},
    "fixture",
    reserve,
    undefined,
    10,
  );
  expect(kept.reserve).toEqual(reserve);
  expect(kept.floor).toBe(10);
});
it("reports protected ancestry overflow rather than dropping inherited floors", () => {
  const reserve = Object.fromEntries(
    Array.from({ length: READ_RESERVE_KEYS + 10 }, (_, n) => [
      `thread:${n}`,
      1_000_000 + n,
    ]),
  );
  expect(() =>
    retainLocalRead(
      [
        {
          frontiers: {},
          overrides: { child: { set: 1, clear: 0, baseline: 0 } },
        },
      ],
      {},
      "fixture",
      reserve,
    ),
  ).toThrow("Read override ancestry capacity reached; saved floors retained");
});
it("returning journal keys keep their highest archived frontier", () => {
  const kept = retainLocalRead(
    [{ frontiers: { "msg:old": 5 }, overrides: {} }],
    { "msg:old": 1 },
    "fixture",
    { "msg:old": 20, "msg:other": 30 },
  );
  expect(kept.state.frontiers).toEqual({ "msg:old": 20 });
  expect(kept.reserve).toEqual({ "msg:other": 30 });
});
it("promotes archived override floors before reserve pressure can reactivate them", () => {
  const reserve = { "msg:direct": 20, room: 30, "thread:root": 40 };
  const overrides = {
    "msg:direct": { set: 1, clear: 0, baseline: 10 },
    "msg:inherited": { set: 2, clear: 0, baseline: 10 },
    "msg:cleared": { set: 1, clear: 2, baseline: 100 },
  };
  const kept = retainLocalRead(
    [
      {
        frontiers: Object.fromEntries(
          Array.from({ length: 8000 }, (_, n) => [`msg:${n}`, 100 + n]),
        ),
        overrides,
      },
    ],
    {},
    "fixture",
    reserve,
  );
  expect({ ...kept.reserve, ...kept.state.frontiers }).toMatchObject(reserve);
  expect(kept.state.overrides).toEqual(overrides);
  for (const [key, value] of Object.entries(overrides))
    expect(
      overrideActive(
        value,
        effectiveFrontier(
          {
            ...kept.state,
            frontiers: { ...kept.reserve, ...kept.state.frontiers },
          },
          key,
          "room",
          "root",
        ),
      ),
    ).toBe(false);
});

it("drops archived quiet-channel catch-up before newer message churn, under the floor", () => {
  const frontiers = Object.fromEntries(
    Array.from({ length: 8000 }, (_, n) => [
      `msg:${n.toString(16).padStart(64, "0")}`,
      100 + n,
    ]),
  );
  const kept = retainLocalRead([{ frontiers, overrides: {} }], {}, "fixture", {
    "activity:quiet": 1,
  });
  expect(kept.reserve["activity:quiet"]).toBeUndefined();
  expect(kept.state.frontiers["activity:quiet"]).toBeUndefined();
  expect(kept.floor).toBeGreaterThanOrEqual(100);
  expect(Object.keys(kept.reserve)).toHaveLength(READ_RESERVE_KEYS);
});
it("drops marks at or below the floor, unless overrides make them load-bearing", () => {
  const state = { frontiers: { room: 10, "msg:new": 30 }, overrides: {} };
  const kept = retainLocalRead(
    [state],
    {},
    "fixture",
    { "msg:old": 20 },
    undefined,
    20,
  );
  expect(kept.state.frontiers).toEqual({ "msg:new": 30 });
  expect(kept.reserve).toEqual({});
  expect(kept.floor).toBe(20);
  const overrides = { "msg:child": { set: 1, clear: 0, baseline: 0 } };
  const guarded = retainLocalRead(
    [{ ...state, overrides }],
    {},
    "fixture",
    { "msg:old": 20 },
    undefined,
    20,
  );
  expect({ ...guarded.reserve, ...guarded.state.frontiers }).toEqual({
    room: 10,
    "msg:new": 30,
    "msg:old": 20,
  });
});
it("a large inherited reserve does not overflow the journal on remote override ingest", () => {
  const reserve = Object.fromEntries(
    Array.from({ length: 2000 }, (_, n) => [
      `thread-activity:${n.toString(16).padStart(64, "0")}`,
      1,
    ]),
  );
  const kept = retainLocalRead(
    [
      {
        frontiers: { room: 2 },
        overrides: { "msg:child": { set: 1, clear: 0, baseline: 0 } },
      },
    ],
    {},
    "fixture",
    reserve,
  );
  expect(kept.reserve).toEqual(reserve);
  expect(kept.state.frontiers).toEqual({ room: 2 });
});

it("retains every protected inherited floor at the exact serialized reserve cap", () => {
  const reserve = Object.fromEntries(
    Array.from({ length: 5000 }, (_, n) => [String(n).padStart(98, "x"), 1]),
  );
  const missing =
    READ_RESERVE_BYTES -
    new TextEncoder().encode(JSON.stringify(reserve)).length;
  // Spread padding over keys without crossing the 256-byte context limit.
  let extra = missing;
  for (const key of Object.keys(reserve)) {
    const padding = Math.min(extra, 256 - key.length);
    if (!padding) break;
    delete reserve[key];
    reserve[key + "y".repeat(padding)] = 1;
    extra -= padding;
  }
  expect(extra).toBe(0);
  expect(new TextEncoder().encode(JSON.stringify(reserve)).length).toBe(
    READ_RESERVE_BYTES,
  );
  const kept = retainLocalRead(
    [
      {
        frontiers: {},
        overrides: { child: { set: 1, clear: 0, baseline: 0 } },
      },
    ],
    {},
    "fixture",
    reserve,
  );
  expect(kept.reserve).toEqual(reserve);
});
it("refilling a full budget with covered marks scans each mark a bounded number of times", () => {
  // Thread catch-up marks nearly fill the budget, and a merge brings many
  // message marks that the kept channel mark already covers.
  const hex = (prefix: string, n: number) =>
    `${prefix}${n.toString(16).padStart(64, "0")}`;
  // 1,115 of these leave room for one more message mark at the local limit.
  const activity = Array.from({ length: 1115 }, (_, n) =>
    hex("thread-activity:", n),
  );
  const messages = Array.from({ length: 480 }, (_, n) => hex("msg:", n));
  const state = {
    frontiers: {
      room: 1000,
      ...Object.fromEntries(activity.map((key, n) => [key, 2000 + n])),
      ...Object.fromEntries(messages.map((key, n) => [key, 100 + n])),
    },
    overrides: {},
  };
  let calls = 0;
  const covered = (
    key: string,
    frontier: (key: string) => number | undefined,
  ) => {
    calls++;
    return key.startsWith("msg:") &&
      (frontier("room") ?? -1) >= (frontier(key) ?? 0)
      ? "room"
      : undefined;
  };
  // The catch-up marks are local; the message marks arrive from a peer.
  const recent = Object.fromEntries(activity.map((key, n) => [key, 5000 + n]));
  const kept = retainRead([state], recent, "fixture", undefined, covered);
  const marks = Object.keys(state.frontiers).length;
  expect(calls).toBeLessThan(4 * marks);
  expect(kept.state.frontiers.room).toBe(1000);
  for (const key of messages) expect(kept.state.frontiers[key]).toBeUndefined();
  // The freed space went to the catch-up marks.
  expect(
    activity.filter((key) => kept.state.frontiers[key] !== undefined).length,
  ).toBeGreaterThan(1000);
});
it("covered marks hold their share until pruning, so recent message reads keep their space", () => {
  // At the real publication limit, covered catch-up marks rank first in their
  // scope, and recent message reads compete for the rest.
  const hex = (prefix: string, n: number) =>
    `${prefix}${n.toString(16).padStart(64, "0")}`;
  const channels = [0, 1, 2].map(
    (n) => `0000000${n}-0000-4000-8000-000000000000`,
  );
  const threads = Array.from({ length: 500 }, (_, n) =>
    hex("thread-activity:", n),
  );
  const messages = Array.from({ length: 500 }, (_, n) => hex("msg:", n));
  const state = {
    frontiers: {
      ...Object.fromEntries(channels.map((key) => [key, 1000])),
      ...Object.fromEntries(channels.map((key) => [`activity:${key}`, 100])),
      ...Object.fromEntries(threads.map((key) => [key, 200])),
      ...Object.fromEntries(messages.map((key) => [key, 100])),
    },
    overrides: {},
  };
  const recent = {
    ...Object.fromEntries(channels.map((key) => [`activity:${key}`, 9000])),
    ...Object.fromEntries(threads.map((key, n) => [key, 1000 + n])),
    ...Object.fromEntries(messages.map((key, n) => [key, 5000 + n])),
  };
  const covered = (
    key: string,
    frontier: (key: string) => number | undefined,
  ) => {
    const channel = key.startsWith("activity:") ? key.slice(9) : undefined;
    return channel !== undefined &&
      (frontier(channel) ?? -1) >= (frontier(key) ?? 0)
      ? channel
      : undefined;
  };
  const kept = retainRead(
    [state],
    recent,
    "c".repeat(36),
    READ_STATE_PLAINTEXT_BYTES,
    covered,
  );
  const frontiers = kept.state.frontiers;
  for (const key of channels) {
    expect(frontiers[key]).toBe(1000);
    expect(frontiers[`activity:${key}`]).toBeUndefined();
    // The dropped catch-up mark gives its recency to its channel.
    expect(kept.recent[key]).toBe(9000);
  }
  // The most recent reads are the ones kept.
  const keptThreads = threads.filter((key) => frontiers[key] !== undefined);
  const keptMessages = messages.filter((key) => frontiers[key] !== undefined);
  expect(keptThreads).toEqual(threads.slice(-348));
  expect(keptMessages).toEqual(messages.slice(-139));
});
it("a cover admitted on refill drops the marks it covers", () => {
  // `thread:a` does not fit at first, so `thread-activity:a` is first found
  // uncovered. Pruning the channel-covered messages makes room for
  // `thread:a`; the catch-up mark must then be asked again, so its space
  // goes to `msg:b`.
  const room = "x".repeat(50);
  const state = {
    frontiers: {
      [room]: 500,
      "msg:c0": 100,
      "msg:c1": 100,
      "thread-activity:a": 300,
      "thread:a": 300,
      "msg:b": 600,
    },
    overrides: {},
  };
  const recent = {
    "msg:c0": 9000,
    "msg:c1": 8999,
    "thread-activity:a": 8000,
    "thread:a": 7000,
    "msg:b": 6000,
  };
  const covered = (
    key: string,
    frontier: (key: string) => number | undefined,
  ) => {
    const cover = key.startsWith("msg:")
      ? room
      : key.startsWith("thread-activity:")
        ? `thread:${key.slice(16)}`
        : undefined;
    return cover !== undefined &&
      (frontier(cover) ?? -1) >= (frontier(key) ?? 0)
      ? cover
      : undefined;
  };
  const kept = retainRead([state], recent, "fixture", 150, covered);
  expect(kept.state.frontiers).toEqual({
    [room]: 500,
    "thread:a": 300,
    "msg:b": 600,
  });
  expect(kept.recent["thread:a"]).toBe(8000);
});

it("covered marks leave the reserve as well as the journal", () => {
  // `msg:<channel>.<n>` belongs to `<channel>`, read through its event time.
  const covered = (
    key: string,
    frontier: (key: string) => number | undefined,
  ) => {
    const [, channel, time] = /^msg:(\w+)\.(\d+)$/.exec(key) ?? [];
    if (!channel) return undefined;
    return (frontier(channel) ?? -1) >= Number(time) ? channel : undefined;
  };
  // The journal drops `msg:room.10`; it must not move to the reserve.
  const kept = retainLocalRead(
    [{ frontiers: { room: 20, "msg:room.10": 10 }, overrides: {} }],
    {},
    "fixture",
    {
      // Already archived, and covered by the journal's channel mark.
      "msg:room.5": 5,
      // Covered by an archived channel mark.
      quiet: 50,
      "msg:quiet.40": 40,
      // Not covered: later than its channel mark, or no channel mark at all.
      "msg:room.30": 30,
      "msg:loose.1": 1,
    },
    covered,
  );
  expect(kept.state.frontiers).toEqual({ room: 20 });
  expect(kept.reserve).toEqual({
    quiet: 50,
    "msg:room.30": 30,
    "msg:loose.1": 1,
  });
  // With an override, ancestry is load-bearing, so nothing is pruned.
  const withOverride = retainLocalRead(
    [
      {
        frontiers: { room: 20 },
        overrides: { other: { set: 0, clear: 9, baseline: 0 } },
      },
    ],
    {},
    "fixture",
    { "msg:room.5": 5 },
    covered,
  );
  expect(withOverride.reserve).toEqual({ "msg:room.5": 5 });
});

it("dropping row hints never raises the local read floor or displaces read receipts", () => {
  const marks = (prefix: string, count: number, value: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        `${prefix}${i.toString(16).padStart(64, "0")}`,
        value,
      ]),
    );
  const before = retainLocalRead(
    [{ frontiers: marks("msg:", 6000, 10), overrides: {} }],
    {},
    "fixture",
  );
  const after = retainLocalRead(
    [before.state, { frontiers: marks("seen:msg:", 7000, 100), overrides: {} }],
    before.recent,
    "fixture",
    before.reserve,
  );
  expect(after.floor).toBe(0);
  const reads = (kept: typeof before) =>
    Object.keys({
      ...kept.state.frontiers,
      ...kept.reserve,
    }).filter((key) => key.startsWith("msg:")).length;
  expect(reads(after)).toBe(reads(before));
});
