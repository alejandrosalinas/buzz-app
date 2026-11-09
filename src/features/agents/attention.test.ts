import { describe, expect, it } from "vitest";
import type { EventData } from "../relay/events";
import {
  addressedTo,
  timerSpent,
  timerState,
  validateObject,
  watchMatches,
  type EventWatch,
  type TimerWatch,
} from "./attention";

const agent = "a".repeat(64);
const channel = "0b8e2a3c-1d4f-4a5b-8c6d-7e8f9a0b1c2d";
const event = (patch: Partial<EventData> = {}): EventData => ({
  id: "e".repeat(64),
  pubkey: "b".repeat(64),
  created_at: 100,
  kind: 9,
  content: "hi",
  tags: [["h", channel]],
  ...patch,
});
const watch: EventWatch = {
  type: "event",
  interest_id: "default",
  enabled: true,
  since: 50,
  channels: [channel],
  kinds: [9],
};

describe("validateObject", () => {
  it("accepts each spec value at a matching slug", () => {
    expect(
      validateObject("interest/default", {
        type: "interest",
        instructions: "x",
      }),
    ).toBeUndefined();
    expect(
      validateObject("interest/default", {
        type: "interest",
        instructions: "x",
        paused: true,
      }),
    ).toBeUndefined();
    expect(
      validateObject("interest/default", {
        type: "interest",
        instructions: "x",
        paused: "yes",
      }),
    ).toMatch(/paused must be/);
    expect(validateObject("watch/w", watch)).toBeUndefined();
    expect(
      validateObject("watch/t", {
        type: "timer",
        interest_id: "default",
        prompt: "tick",
        enabled: true,
        interval_secs: 60,
        armed_at: 0,
        max_occurrences: null,
        expires_at: null,
      }),
    ).toBeUndefined();
  });
  it("refuses wrong slugs, unknown or missing fields and bad values", () => {
    expect(validateObject("other/x", watch)).toMatch(/slug/);
    expect(validateObject("interest/x", watch)).toMatch(/interest/);
    expect(validateObject("watch/w", { ...watch, extra: 1 })).toMatch(
      /Unknown/,
    );
    const { since: _, ...missing } = watch;
    expect(validateObject("watch/w", missing)).toMatch(/Missing/);
    expect(validateObject("watch/w", { ...watch, channels: ["c1"] })).toMatch(
      /channels/,
    );
    expect(validateObject("watch/w", { ...watch, tags: { h: ["x"] } })).toMatch(
      /other than h/,
    );
    // The old grammar is gone; startup converts stored ones (migrate-filter).
    expect(validateObject("watch/w", { ...watch, filter: "true" })).toMatch(
      /Unknown field: filter/,
    );
    expect(validateObject("watch/w", { ...watch, authors: ["B"] })).toMatch(
      /authors/,
    );
    expect(
      validateObject("watch/w", { ...watch, exclude_authors: [] }),
    ).toMatch(/exclude_authors/);
    expect(
      validateObject("watch/w", {
        ...watch,
        authors: ["b".repeat(64)],
        exclude_authors: ["c".repeat(64)],
      }),
    ).toMatch(/both/);
    expect(validateObject("watch/w", { ...watch, is_reply: "yes" })).toMatch(
      /is_reply/,
    );
  });
  it("accepts an Interest's optional title and summary, but not empty or multiline titles", () => {
    const interest = { type: "interest", instructions: "x" };
    expect(
      validateObject("interest/x", {
        ...interest,
        title: "Release checks",
        summary: "Wakes on CI.\nReports failures to John.",
      }),
    ).toBeUndefined();
    expect(validateObject("interest/x", { ...interest, title: " " })).toMatch(
      /title is empty/,
    );
    expect(
      validateObject("interest/x", { ...interest, title: "Two\nlines" }),
    ).toMatch(/single line/);
    expect(validateObject("interest/x", { ...interest, summary: "" })).toMatch(
      /summary is empty/,
    );
    expect(
      validateObject("interest/x", { ...interest, summary: "x".repeat(1025) }),
    ).toMatch(/1,024 bytes/);
  });
  it("refuses values over the spec's limits", () => {
    expect(
      validateObject("interest/x", {
        type: "interest",
        instructions: "x".repeat(16_385),
      }),
    ).toMatch(/16,384 bytes/);
    expect(
      validateObject("watch/w", {
        ...watch,
        authors: Array.from({ length: 101 }, (_, n) =>
          n.toString(16).padStart(64, "0"),
        ),
      }),
    ).toMatch(/1 to 100/);
    expect(
      validateObject("watch/w", {
        ...watch,
        kinds: Array.from({ length: 101 }, (_, kind) => kind),
      }),
    ).toMatch(/kinds/);
    const question = { question: "q", threshold: 0.5 };
    // As in Janet, only the question is required.
    expect(
      validateObject("watch/w", {
        ...watch,
        classifier: { questions: { a: { question: "q" } } },
      }),
    ).toBeUndefined();
    expect(
      validateObject("watch/w", {
        ...watch,
        classifier: { questions: { a: {} } },
      }),
    ).toMatch(/Missing field: question/);
    expect(
      validateObject("watch/w", {
        ...watch,
        classifier: { questions: { a: { ...question, threshold: 1 } } },
      }),
    ).toMatch(/threshold/);
    expect(
      validateObject("watch/w", {
        ...watch,
        classifier: {
          questions: { a: { ...question, true: "y", false: "n" } },
        },
      }),
    ).toBeUndefined();
  });
});

describe("matching", () => {
  it("rejects the removed keywords selector", () => {
    expect(
      validateObject("watch/w", { ...watch, keywords: ["build failed"] }),
    ).toBe("Unknown field: keywords");
  });
  it("matches enabled watches by since, channel, kind and tags", () => {
    expect(watchMatches(watch, event())).toBe(true);
    expect(watchMatches({ ...watch, enabled: false }, event())).toBe(false);
    expect(watchMatches(watch, event({ created_at: 10 }))).toBe(false);
    expect(watchMatches(watch, event({ tags: [] }))).toBe(false);
    expect(watchMatches(watch, event({ kind: 7 }))).toBe(false);
    expect(watchMatches({ ...watch, tags: { t: ["x"] } }, event())).toBe(false);
  });
  it("matches authors, exclude_authors and is_reply", () => {
    const author = "b".repeat(64);
    expect(watchMatches({ ...watch, authors: [author] }, event())).toBe(true);
    expect(watchMatches({ ...watch, authors: [agent] }, event())).toBe(false);
    expect(watchMatches({ ...watch, exclude_authors: [author] }, event())).toBe(
      false,
    );
    expect(watchMatches({ ...watch, exclude_authors: [agent] }, event())).toBe(
      true,
    );
    const id = "f".repeat(64);
    const reply = event({
      tags: [
        ["h", channel],
        ["e", id, "", "reply"],
      ],
    });
    // The relay's NIP-10 rule: a lone root, or an unmarked e tag, is top-level.
    const loneRoot = event({
      tags: [
        ["h", channel],
        ["e", id, "", "root"],
      ],
    });
    const unmarked = event({
      tags: [
        ["h", channel],
        ["e", id],
      ],
    });
    for (const [input, isReply] of [
      [reply, true],
      [loneRoot, false],
      [unmarked, false],
      [event(), false],
    ] as const) {
      expect(watchMatches({ ...watch, is_reply: true }, input)).toBe(isReply);
      expect(watchMatches({ ...watch, is_reply: false }, input)).toBe(!isReply);
    }
  });
  it("treats mentions and DMs to the agent, not replies or reactions, as addressed", () => {
    expect(addressedTo(event({ tags: [["p", agent]] }), agent)).toBe(true);
    expect(addressedTo(event({ kind: 1, tags: [["p", agent]] }), agent)).toBe(
      false,
    );
    expect(
      addressedTo(event({ pubkey: agent, tags: [["p", agent]] }), agent),
    ).toBe(false);
    expect(addressedTo(event({ kind: 4, tags: [["p", agent]] }), agent)).toBe(
      true,
    );
    // A reply in its thread is not addressed unless it names the agent; only a
    // watch can wake it for one.
    expect(
      addressedTo(event({ tags: [["e", "mine", "", "reply"]] }), agent),
    ).toBe(false);
    // Nor is a reaction to its message: only a watch hears one.
    expect(addressedTo(event({ kind: 7, tags: [["e", "mine"]] }), agent)).toBe(
      false,
    );
    expect(addressedTo(event({ kind: 7, tags: [["p", agent]] }), agent)).toBe(
      false,
    );
  });
  it("counts what was already due when a timer has no state, and spends it", () => {
    const timer: TimerWatch = {
      type: "timer",
      interest_id: "default",
      prompt: "tick",
      enabled: true,
      interval_secs: 10,
      armed_at: 100,
      max_occurrences: 1,
      expires_at: null,
    };
    const state = timerState(timer, undefined, 100);
    expect(state).toEqual({ armedAt: 100, nextDue: 110, used: 0 });
    expect(timerState(timer, { ...state, used: 1 }, 500).used).toBe(1);
    // No saved state at 135: occurrences at 110, 120 and 130 count as used.
    expect(timerState(timer, undefined, 135)).toEqual({
      armedAt: 100,
      nextDue: 140,
      used: 3,
    });
    expect(timerState({ ...timer, armed_at: 200 }, state, 200).nextDue).toBe(
      210,
    );
    expect(timerSpent(timer, { ...state, used: 1 }, 0)).toBe(true);
    expect(timerSpent({ ...timer, expires_at: 50 }, state, 50)).toBe(true);
  });
});

it("validates delivery addresses independently of subscription selectors", () => {
  const subscriptions = [
    watch,
    {
      type: "timer",
      interest_id: "default",
      enabled: true,
      prompt: "tick",
      armed_at: 0,
      interval_secs: 60,
      max_occurrences: 1,
      expires_at: null,
    },
    {
      type: "source",
      interest_id: "default",
      enabled: true,
      provider: "example/check",
      config: {},
    },
  ];
  for (const subscription of subscriptions) {
    expect(validateObject("watch/delivery", subscription)).toBeUndefined();
    expect(
      validateObject("watch/delivery", { ...subscription, channel }),
    ).toBeUndefined();
    expect(
      validateObject("watch/delivery", {
        ...subscription,
        channel,
        root: "e".repeat(64),
      }),
    ).toBeUndefined();
    expect(
      validateObject("watch/delivery", {
        ...subscription,
        root: "e".repeat(64),
      }),
    ).toMatch(/requires a channel/);
    expect(
      validateObject("watch/delivery", { ...subscription, channel: "invalid" }),
    ).toMatch(/channel/);
    expect(
      validateObject("watch/delivery", {
        ...subscription,
        channel,
        root: "invalid",
      }),
    ).toMatch(/root/);
  }
});
