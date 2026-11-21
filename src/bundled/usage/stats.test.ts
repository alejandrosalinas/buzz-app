import { beforeAll, expect, it } from "vitest";
import type {
  Agent,
  SessionUsage,
  UsageObservation,
} from "../../features/agents/service";
import { estimateCost, loadPrices } from "./pricing";
import { dayStart, merge, modelName, since, stats } from "./stats";

beforeAll(loadPrices);

const HOUR = 3_600_000;
const now = new Date(2026, 9, 16, 15).getTime();
const today = dayStart(now);
const agent = (name: string) =>
  ({ pubkey: name.padEnd(64, "0"), name, type: "x/claude" }) as Agent;
const seen = (
  at: number,
  tokens: UsageObservation["tokens"],
  model = "claude-opus-5-5",
  usd?: number,
): UsageObservation => ({
  at,
  model,
  tokens,
  ...(usd === undefined ? {} : { cost: { usd, source: "estimated" } }),
});
const full = (input: number, more = {}) => ({
  input,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  ...more,
});
const session = (
  id: string,
  observations: UsageObservation[],
  more: Partial<SessionUsage> = {},
): SessionUsage => ({
  id,
  revision: id,
  gaps: [],
  startedAt: observations[0]?.at ?? today,
  lastAt: observations.at(-1)?.at ?? today,
  observations,
  ...more,
});

it("prices cache writes by how long they are kept, and dated snapshots", () => {
  // 1M of each at Opus 5.5: $4 in, $20 out, $0.20 read; writes 1.25× and 2×.
  expect(
    estimateCost("claude-opus-5-5", {
      input: 1e6,
      output: 1e6,
      cacheRead: 1e6,
      cacheWrite: 2e6,
      cacheWrite1h: 1e6,
    }),
  ).toEqual({ usd: expect.closeTo(4 + 20 + 0.2 + 5 + 8), partial: false });
  expect(estimateCost("claude-haiku-4-5-20251001", full(1e6))?.usd).toBeCloseTo(
    1,
  );
  expect(
    estimateCost("global.anthropic.claude-opus-5-5", full(1e6))?.usd,
  ).toBeCloseTo(4);
  // An unknown count is not priced as zero tokens.
  expect(estimateCost("claude-opus-5-5", { input: 1e6 })).toEqual({
    usd: expect.closeTo(4),
    partial: true,
  });
  // With no count known there is nothing to price, not $0.
  expect(estimateCost("claude-opus-5-5", {})).toEqual({ partial: true });
  expect(estimateCost("claude-opus-9-9", full(1e6))).toBeUndefined();
  expect(estimateCost("acme-1", full(1e6))).toBeUndefined();
});

it("prices OpenAI models, at their long-prompt rates past 272K tokens", () => {
  // GPT-6.1 Sol: $2 in, $10 out, $0.10 read, $2.50 write per million.
  expect(
    estimateCost("gpt-6.1-sol", {
      input: 1e5,
      output: 1e5,
      cacheRead: 1e5,
      cacheWrite: 0,
    }),
  ).toEqual({ usd: expect.closeTo(0.2 + 1 + 0.01), partial: false });
  // A 300K prompt: 2× input and cache rates, 1.5× output, for the request.
  expect(
    estimateCost("gpt-6.1-sol", {
      input: 1e5,
      output: 1e6,
      cacheRead: 2e5,
      cacheWrite: 0,
    })?.usd,
  ).toBeCloseTo(0.4 + 15 + 0.04);
  // Codex's coding snapshot is priced as its base model.
  expect(estimateCost("gpt-5.2-codex", full(1e6))?.usd).toBeCloseTo(1.75);
});

it("totals the period, compares the previous one and ranks agents and sessions", () => {
  const pixel = agent("pixel");
  const relay = agent("relay");
  const result = stats(
    [
      {
        agent: pixel,
        harness: "x/claude",
        sessions: [
          session("big", [
            seen(
              today + 9 * HOUR,
              full(1e6, { cacheRead: 3e6, cacheWrite: 1e5 }),
            ),
            seen(
              today + 10 * HOUR,
              { ...full(0), output: 1e5 },
              "claude-sonnet-5-5",
            ),
          ]),
          // Only the previous period: compared, not counted.
          session("old", [seen(dayStart(now, 9), full(5e5))]),
        ],
      },
      {
        agent: relay,
        harness: "x/codex",
        sessions: [
          session("recorded", [
            seen(dayStart(now, 2), full(10), "acme-1", 1.5),
            seen(dayStart(now, 2) + HOUR, full(10), "acme-1"),
          ]),
        ],
      },
    ],
    now,
    7,
  );
  // Pixel: $4 + $0.60 cache reads + $0.50 cache writes + $1 Sonnet output.
  // Relay: its recorded $1.50, and a reply from a model with no rates, not counted.
  expect(result.cost).toEqual({ value: expect.closeTo(7.6), partial: true });
  expect(result.previousCost).toEqual({
    value: expect.closeTo(2),
    partial: false,
  });
  expect(result.sessions).toBe(2);
  expect(result.tokens).toEqual({
    value: 1e6 + 3e6 + 1e5 + 1e5 + 20,
    partial: false,
  });
  expect(result.output).toEqual({ value: 1e5, partial: false });
  expect(result.cacheHit).toEqual({
    value: expect.closeTo(3e6 / (4e6 + 20 + 1e5)),
    partial: false,
  });
  expect(
    result.agents.map((entry) => [entry.agent.name, entry.model, entry.cost]),
  ).toEqual([
    [
      "pixel",
      "claude-opus-5-5",
      { value: expect.closeTo(6.1), partial: false },
    ],
    ["relay", "acme-1", { value: 1.5, partial: true }],
  ]);
  expect(result.costliest.map((entry) => entry.session.id)).toEqual([
    "big",
    "recorded",
  ]);
  expect(result.days).toHaveLength(7);
  expect(result.days.at(-1)).toMatchObject({ start: today });
  expect(result.days.at(-1)?.costs.get("x/claude")).toEqual({
    value: expect.closeTo(6.1),
    partial: false,
  });
  // The day's unpriced reply leaves its cost partial, not complete.
  expect(result.days.at(-3)?.costs.get("x/codex")).toEqual({
    value: 1.5,
    partial: true,
  });
  // Every period reads the same 30 days; only 7 days' previous period is in
  // them, so 30 days are not compared.
  expect(since(now)).toBe(dayStart(now, 29));
  expect(stats([], now, 30).previousCost).toBeUndefined();
});

it("keeps unknown usage unknown, and counts sessions without any", () => {
  const result = stats(
    [
      {
        agent: agent("sol"),
        harness: "x/codex",
        sessions: [
          // Recorded no usage at all.
          session("quiet", [], { startedAt: today, lastAt: today + HOUR }),
          session("priced-nowhere", [seen(today, { output: 5 }, "acme-1")]),
        ],
      },
    ],
    now,
    7,
  );
  expect(result.sessions).toBe(2);
  expect(result.agents).toHaveLength(1);
  expect(result.cost).toEqual({ partial: true });
  expect(result.tokens).toEqual({ value: 5, partial: true });
  expect(result.output).toEqual({ value: 5, partial: false });
  expect(result.cacheHit).toEqual({ partial: true });
  // No usage in the period is a true zero, not an unknown.
  const empty = stats(
    [{ agent: agent("sol"), harness: "x/codex", sessions: [] }],
    now,
    7,
  );
  expect(empty.cost).toEqual({ value: 0, partial: false });
  expect(empty.cacheHit).toBeUndefined();
});

it("marks the totals of a session it could not fully read as partial", () => {
  const result = stats(
    [
      {
        agent: agent("pixel"),
        harness: "x/claude",
        sessions: [
          session("whole", [seen(today, full(1e6))]),
          session("gapped", [seen(today, full(1e6))], {
            gaps: ["A subagent’s transcript is gone"],
            startedAt: dayStart(now, 2) + HOUR,
          }),
        ],
      },
    ],
    now,
    7,
  );
  expect(result.cost).toEqual({ value: expect.closeTo(8), partial: true });
  expect(result.tokens.partial).toBe(true);
  expect(
    result.costliest.map((entry) => [entry.session.id, entry.cost.partial]),
  ).toEqual([
    ["whole", false],
    ["gapped", true],
  ]);
  // What it missed may be on any day since the session started.
  expect(result.days.map((day) => day.costs.get("x/claude"))).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
    { partial: true },
    { partial: true },
    { value: expect.closeTo(8), partial: true },
  ]);
});

it("marks the previous period partial when a gapped session began in it", () => {
  const result = stats(
    [
      {
        agent: agent("pixel"),
        harness: "x/claude",
        sessions: [
          session("earlier", [seen(dayStart(now, 9), full(1e6))]),
          session("gapped", [seen(today, full(1e6))], {
            gaps: ["A subagent’s transcript is gone"],
            startedAt: dayStart(now, 10),
          }),
        ],
      },
    ],
    now,
    7,
  );
  expect(result.previousCost).toEqual({
    value: expect.closeTo(4),
    partial: true,
  });
});

it("marks every day of a harness whose read failed as partial", () => {
  const result = stats(
    [
      {
        agent: agent("pixel"),
        harness: "x/claude",
        sessions: [session("s", [seen(today, full(1e6))])],
      },
    ],
    now,
    7,
    new Set(["x/codex"]),
  );
  expect(result.cost).toEqual({ value: expect.closeTo(4), partial: true });
  expect(result.days.at(-1)?.costs.get("x/claude")).toEqual({
    value: expect.closeTo(4),
    partial: false,
  });
  expect(result.days.map((day) => day.costs.get("x/codex"))).toEqual(
    Array(7).fill({ partial: true }),
  );
});

it("replaces a session's snapshot only with a complete one, and keeps sessions a read missed", () => {
  const kept = [
    session("a", [seen(today, full(1))]),
    session("b", [seen(today, full(2))]),
    session("c", [seen(today, full(3))]),
  ];
  const gap = ["A subagent’s transcript is gone"];
  const merged = merge(kept, [
    session("a", [seen(today, full(10))], { revision: "a2" }),
    session("b", [seen(today, full(20))], { revision: "b2", gaps: gap }),
    session("d", [seen(today, full(4))], { gaps: gap }),
  ]);
  expect(
    merged.map((entry) => [
      entry.id,
      entry.revision,
      entry.observations[0]?.tokens.input,
      entry.gaps,
    ]),
  ).toEqual([
    ["a", "a2", 10, []],
    // The earlier snapshot stands, with the gap reported.
    ["b", "b", 2, gap],
    ["c", "c", 3, []],
    ["d", "d", 4, gap],
  ]);
});

it("names Claude models", () => {
  expect(modelName("claude-opus-5-5")).toBe("Claude Opus 5.5");
  expect(modelName("claude-haiku-4-5-20251001")).toBe("Claude Haiku 4.5");
  expect(modelName("claude-sonnet-5")).toBe("Claude Sonnet 5");
  expect(modelName("databricks-claude-sonnet-5-5")).toBe("Claude Sonnet 5.5");
  expect(modelName("global.anthropic.claude-opus-4-8")).toBe("Claude Opus 4.8");
  expect(modelName("gpt-6.1-sol")).toBe("gpt-6.1-sol");
});

it("keeps costs unknown when nothing priced was known, on each day too", () => {
  const result = stats(
    [
      {
        agent: agent("pixel"),
        harness: "x/claude",
        sessions: [session("counts unknown", [seen(today + HOUR, {})])],
      },
      {
        agent: agent("relay"),
        harness: "x/codex",
        sessions: [
          session("unpriced", [seen(dayStart(now, 1), full(10), "acme-1")]),
        ],
      },
    ],
    now,
    7,
  );
  expect(result.cost).toEqual({ partial: true });
  expect(result.days.at(-1)?.costs.get("x/claude")).toEqual({ partial: true });
  expect(result.days.at(-2)?.costs.get("x/codex")).toEqual({ partial: true });
  // A day without sessions spent nothing.
  expect(result.days.at(-3)?.costs.size).toBe(0);
});

it("groups the period's cost by the timer or watch that started each session, the rest under Other", () => {
  const pixel = agent("pixel");
  const relay = agent("relay");
  const priced = (id: string, usd: number, more: Partial<SessionUsage> = {}) =>
    session(id, [seen(today + 9 * HOUR, full(1), "acme-1", usd)], more);
  const result = stats(
    [
      {
        agent: pixel,
        harness: "x/claude",
        sessions: [
          priced("a", 1, { wake: "timer/daily" }),
          priced("b", 2, { wake: "timer/daily" }),
          priced("c", 10, { wake: "watch/pulls" }),
          priced("d", 4),
          // Before the period: not counted in it.
          session("e", [seen(dayStart(now, 9), full(1), "acme-1", 100)], {
            wake: "timer/daily",
          }),
        ],
      },
      {
        // A harness that does not say which turn started its sessions.
        agent: relay,
        harness: "x/codex",
        sessions: [priced("f", 3)],
      },
    ],
    now,
    7,
  );
  expect(result.routines).toEqual([
    {
      agent: pixel,
      wake: "watch/pulls",
      cost: { value: 10, partial: false },
      sessions: 1,
    },
    {
      agent: pixel,
      wake: "timer/daily",
      cost: { value: 3, partial: false },
      sessions: 2,
    },
    { cost: { value: 7, partial: false }, sessions: 2 },
  ]);
  expect(result.cost.value).toBe(20);
});

it("counts a watch's catch-up turns under that watch", () => {
  const pixel = agent("pixel");
  const priced = (id: string, usd: number, wake: string) =>
    session(id, [seen(today + 9 * HOUR, full(1), "acme-1", usd)], { wake });
  const result = stats(
    [
      {
        agent: pixel,
        harness: "x/claude",
        sessions: [
          priced("live", 2, "watch/pulls"),
          // What the watch matched while the agent was offline.
          priced("missed", 5, "catch-up/pulls"),
        ],
      },
    ],
    now,
    7,
  );
  expect(result.routines).toEqual([
    {
      agent: pixel,
      wake: "watch/pulls",
      cost: { value: 7, partial: false },
      sessions: 2,
    },
  ]);
});

it("keeps each agent's routines apart when two agents name a timer alike", () => {
  const pixel = agent("pixel");
  const relay = agent("relay");
  const daily = (id: string, usd: number) =>
    session(id, [seen(today + 9 * HOUR, full(1), "acme-1", usd)], {
      wake: "timer/daily",
    });
  const result = stats(
    [
      { agent: pixel, harness: "x/claude", sessions: [daily("a", 3)] },
      { agent: relay, harness: "x/claude", sessions: [daily("b", 7)] },
    ],
    now,
    7,
  );
  expect(result.routines).toEqual([
    {
      agent: relay,
      wake: "timer/daily",
      cost: { value: 7, partial: false },
      sessions: 1,
    },
    {
      agent: pixel,
      wake: "timer/daily",
      cost: { value: 3, partial: false },
      sessions: 1,
    },
  ]);
});

it("counts a community-session agent's timers and watches under Other, with the total still right", () => {
  const pixel = agent("pixel");
  const shared = agent("shared");
  const at = (hour: number, usd: number) =>
    seen(today + hour * HOUR, full(1), "acme-1", usd);
  const result = stats(
    [
      {
        agent: pixel,
        harness: "x/claude",
        sessions: [session("a", [at(9, 2)], { wake: "timer/daily" })],
      },
      {
        // One session per community: its timer and watch turns run in the
        // shared session, among its conversations, so none says which started.
        agent: shared,
        harness: "x/pi",
        sessions: [session("community", [at(9, 4), at(10, 5), at(11, 1)])],
      },
    ],
    now,
    7,
  );
  expect(result.routines).toEqual([
    {
      agent: pixel,
      wake: "timer/daily",
      cost: { value: 2, partial: false },
      sessions: 1,
    },
    { cost: { value: 10, partial: false }, sessions: 1 },
  ]);
  expect(result.cost.value).toBe(12);
  expect(
    result.routines.reduce((sum, { cost }) => sum + (cost.value ?? 0), 0),
  ).toBe(result.cost.value);
  expect(result.agents.map(({ agent, cost }) => [agent, cost.value])).toEqual([
    [shared, 10],
    [pixel, 2],
  ]);
});

it("shows no routines when no session says which timer or watch started it", () => {
  const result = stats(
    [
      {
        agent: agent("pixel"),
        harness: "x/codex",
        sessions: [
          session("a", [seen(today + 9 * HOUR, full(1), "acme-1", 1)]),
        ],
      },
    ],
    now,
    7,
  );
  expect(result.routines).toEqual([]);
});

it("marks a routine's cost partial when its session was not fully read or a read failed", () => {
  const priced = (id: string, more: Partial<SessionUsage>) =>
    session(id, [seen(today + 9 * HOUR, full(1), "acme-1", 1)], more);
  const usage = [
    {
      agent: agent("pixel"),
      harness: "x/claude",
      sessions: [
        priced("a", { wake: "timer/daily", gaps: ["a subagent's file"] }),
        priced("b", { wake: "timer/hourly" }),
        priced("c", {}),
      ],
    },
  ];
  expect(
    stats(usage, now, 7).routines.map(({ wake, cost }) => [wake, cost.partial]),
  ).toEqual([
    ["timer/daily", true],
    ["timer/hourly", false],
    [undefined, false],
  ]);
  expect(
    stats(usage, now, 7, new Set(["x/claude"])).routines.map(
      ({ cost }) => cost.partial,
    ),
  ).toEqual([true, true, true]);
});
