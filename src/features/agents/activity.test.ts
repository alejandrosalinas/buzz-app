import { afterEach, expect, it, vi } from "vitest";
import {
  ACTIVITY_BYTE_LIMIT,
  ACTIVITY_RECORD_LIMIT,
  ACTIVITY_TURN_LIMIT,
  createAgentActivity,
} from "./activity";
import type { LiveSnapshot } from "../relay/live";
import { requestWork } from "./request-work";
const agent = "a".repeat(64);
const connected: LiveSnapshot = {
  status: "connected",
  routes: [{ id: "observer", status: "live", replay: "unknown" }],
};
function fixture(findMessage?: Parameters<typeof createAgentActivity>[4]) {
  vi.useFakeTimers();
  vi.setSystemTime(1800000000000);
  const observe = vi.fn();
  let denied = false;
  const activity = createAgentActivity(
    true,
    observe,
    (channel) => !(denied && channel === "a"),
    undefined,
    findMessage,
  );
  const release = activity.queries.activate();
  activity.state(connected);
  let serial = 0;
  const generation = () => observe.mock.lastCall?.[0] as number;
  const make = (raw: unknown) => ({
    id: (++serial).toString(16).padStart(64, "0"),
    agent,
    createdAt: Math.floor(Date.now() / 1000),
    plaintext: JSON.stringify(raw),
  });
  const item = (kind: string, turnId = "one", extra = {}) => ({
    kind,
    turnId,
    channelId: "a",
    sessionId: null,
    seq: 1,
    timestamp: new Date().toISOString(),
    payload: {},
    ...extra,
  });
  const send = (raw: unknown) => activity.receive(make(raw), generation());
  return {
    activity,
    release,
    observe,
    make,
    send,
    item,
    generation,
    snapshot: activity.queries.snapshot,
    deny: () => {
      denied = true;
      activity.clear();
    },
  };
}
afterEach(() => vi.useRealTimers());
it("does not settle an aggregate after its other linked lifecycle turn was evicted", () => {
  const f = fixture();
  const request = "1".repeat(64);
  f.send(
    f.item("turn_started", "older", {
      timestamp: new Date(Date.now() - 10000).toISOString(),
      payload: { triggeringEventIds: [request] },
    }),
  );
  f.send(
    f.item("turn_started", "retained", {
      payload: { triggeringEventIds: [request] },
    }),
  );
  f.send(f.item("turn_completed", "retained", { seq: 2 }));
  for (let i = 0; i < ACTIVITY_TURN_LIMIT - 1; i++)
    f.send(f.item("turn_liveness", `unrelated-${i}`));
  expect(f.snapshot().turns.some((turn) => turn.turnId === "older")).toBe(
    false,
  );
  expect(f.snapshot().turnsTrimmed).toBe(true);
  const work = requestWork(f.snapshot(), "a", request);
  expect(work[0]?.state).toBe("unknown");
  f.activity.clear();
  expect(f.snapshot().turnsTrimmed).toBe(false);
  f.activity.dispose();
});
it.each([
  [undefined, "ended"],
  ["completed", "ended"],
  ["failed", "error"],
  ["terminated", "error"],
  ["cancelled", "stopped"],
  ["future-outcome", "unknown"],
])(
  "retains the exact request outcome %s through silence, trimming and reconnect",
  (outcome, expected) => {
    const f = fixture();
    const request = "1".repeat(64);
    const read = () => requestWork(f.snapshot(), "a", request);
    f.send(
      f.item("turn_started", "one", {
        payload: { triggeringEventIds: [request] },
      }),
    );
    vi.advanceTimersByTime(31000);
    expect(read()[0]?.state).toBe("unknown");
    f.send(f.item("turn_completed", "one", { seq: 2, payload: { outcome } }));
    expect(read()[0]?.state).toBe(expected);
    // Evict both the start and end from raw records, keeping the bounded lifecycle.
    for (let i = 0; i <= ACTIVITY_RECORD_LIMIT; i++)
      f.send(f.item("acp_read", "unrelated", { seq: i }));
    expect(f.snapshot().trimmed).toBeGreaterThan(0);
    expect(read()[0]?.state).toBe(expected);
    expect(requestWork(f.snapshot(), "a", "2".repeat(64))).toEqual([]);
    expect(requestWork(f.snapshot(), "other-channel", request)).toEqual([]);
    f.activity.state({ status: "retrying", routes: [] });
    f.activity.state(connected);
    f.send(f.item("turn_liveness", "one", { seq: 1 }));
    vi.advanceTimersByTime(31000);
    expect(read()[0]?.state).toBe(expected);
    f.activity.dispose();
  },
);
it("folds each mixed-turn batch child; resolution is not completion; null-session completion ends only its turn", () => {
  const f = fixture();
  f.send(f.item("turn_started"));
  f.send(f.item("session_resolved", "one", { sessionId: "S" }));
  expect(f.snapshot().turns[0]?.state).toBe("working");
  f.send(
    f.item("batch", "two", {
      payload: {
        events: [f.item("turn_completed"), f.item("turn_started", "two")],
      },
    }),
  );
  expect(f.snapshot().turns.map((turn) => [turn.turnId, turn.state])).toEqual([
    ["one", "ended"],
    ["two", "working"],
  ]);
  f.send(f.item("turn_liveness", "one", { seq: 0 }));
  expect(f.snapshot().turns[0]?.state).toBe("ended");
  f.send(f.item("acp_read", "three", { channelId: "b", seq: 0 }));
  expect(f.snapshot().turns[2]?.state).toBe("working");
  f.release();
  expect(vi.getTimerCount()).toBe(0);
});
it("late attachment learns from liveness; silence and disconnect mean unknown, not ended; future/unknown data stays raw", async () => {
  const f = fixture();
  f.send(f.item("turn_liveness"));
  await vi.advanceTimersByTimeAsync(31000);
  expect(f.snapshot().turns[0]?.state).toBe("unknown");
  f.send(f.item("turn_liveness"));
  expect(f.snapshot().turns[0]?.state).toBe("working");
  f.activity.state({ status: "retrying", routes: [] });
  f.activity.state(connected);
  expect(f.snapshot().turns[0]?.state).toBe("unknown");
  f.send(f.item("mystery", "new"));
  f.send(
    f.item("turn_started", "future", {
      timestamp: new Date(Date.now() + 60000).toISOString(),
    }),
  );
  expect(f.snapshot().turns).toHaveLength(1);
  expect(f.snapshot().records).toHaveLength(4);
  f.activity.dispose();
});
it("clears on disable/access/cache/dispose and fences late frames by generation; batches cannot leak denied children", () => {
  const f = fixture();
  const initial = f.generation();
  f.send(f.item("acp_read"));
  f.activity.clear();
  f.activity.receive(f.make(f.item("acp_read")), initial);
  expect(f.snapshot().records).toHaveLength(0);
  f.send(f.item("acp_read"));
  expect(f.snapshot().records).toHaveLength(1);
  f.deny();
  f.send(
    f.item("batch", "two", {
      channelId: "b",
      payload: { events: [f.item("acp_read")] },
    }),
  );
  expect(f.snapshot().records).toHaveLength(0);
  f.release();
  expect(f.snapshot().status).toBe("disabled");
  f.activity.receive(f.make(f.item("acp_read")), f.generation());
  expect(f.snapshot().records).toHaveLength(0);
  f.activity.dispose();
  expect(f.snapshot().status).toBe("unavailable");
});
it("keeps terminal evidence monotonic across clock rollback, eviction and delayed liveness", () => {
  const f = fixture();
  const liveness = f.item("turn_liveness", "retired", {
    timestamp: new Date(Date.now() - 5000).toISOString(),
  });
  f.send(liveness);
  f.send(
    f.item("turn_completed", "retired", {
      timestamp: new Date(Date.now() - 15000).toISOString(),
    }),
  );
  expect(f.snapshot().turns[0]?.state).toBe("ended");
  for (let i = 0; i < ACTIVITY_TURN_LIMIT; i++)
    f.send(
      f.item("turn_liveness", String(i), {
        timestamp: new Date(Date.now() - 10000).toISOString(),
      }),
    );
  f.send(liveness);
  expect(
    f.snapshot().turns.find((turn) => turn.turnId === "retired")?.state,
  ).toBe("ended");
  // Newer evidence eventually evicts the terminal entry, but not its watermark.
  for (let i = 0; i < ACTIVITY_TURN_LIMIT; i++)
    f.send(f.item("turn_liveness", `new-${i}`));
  expect(f.snapshot().turns.some((turn) => turn.turnId === "retired")).toBe(
    false,
  );
  f.send(liveness);
  expect(f.snapshot().turns.some((turn) => turn.turnId === "retired")).toBe(
    false,
  );
  f.activity.dispose();
});
it("bounds records, UTF-8 bytes, turn state and immutable snapshots; dedups IDs, not process-local sequence", () => {
  const f = fixture();
  const first = f.make(
    f.item("turn_started", "one", {
      payload: { triggeringEventIds: ["1".repeat(64)] },
    }),
  );
  f.activity.receive(first, f.generation());
  const old = f.snapshot();
  f.activity.receive(first, f.generation());
  expect(f.snapshot()).toBe(old);
  for (let i = 0; i < ACTIVITY_RECORD_LIMIT + 1; i++)
    f.send(f.item("unknown", String(i)));
  expect(f.snapshot().records).toHaveLength(ACTIVITY_RECORD_LIMIT);
  expect(old.records).toHaveLength(1);
  for (let i = 0; i < 40; i++)
    f.send(f.item("unknown", String(i), { payload: "é".repeat(30000) }));
  expect(
    f
      .snapshot()
      .records.reduce(
        (size, row) => size + new TextEncoder().encode(row.plaintext).length,
        0,
      ),
  ).toBeLessThanOrEqual(ACTIVITY_BYTE_LIMIT);
  f.activity.clear();
  for (let i = 0; i < ACTIVITY_TURN_LIMIT + 10; i++) {
    vi.setSystemTime(Date.now() + 1);
    f.send(f.item("turn_completed", String(i)));
  }
  expect(f.snapshot().turns).toHaveLength(ACTIVITY_TURN_LIMIT);
  expect(f.snapshot().trimmed).toBeGreaterThan(0);
  f.send(
    f.item("acp_read", "0", {
      timestamp: new Date(1800000000000).toISOString(),
    }),
  );
  expect(f.snapshot().turns.some((turn) => turn.turnId === "0")).toBe(false);
  f.activity.dispose();
});

it("indexes every recognized channel in a raw batch without rewriting or assigning unscoped records", () => {
  const f = fixture();
  const raw = f.item("batch", "last", {
    channelId: "b",
    payload: {
      events: [
        f.item("acp_read", "first"),
        f.item("acp_read", "last", { channelId: "b" }),
      ],
    },
  });
  f.send(raw);
  f.send(f.item("acp_read", "unscoped", { channelId: null }));
  expect(f.snapshot().records[0]?.channelIds).toEqual(["b", "a"]);
  expect(f.snapshot().records[0]?.plaintext).toBe(JSON.stringify(raw));
  expect(Object.isFrozen(f.snapshot().records[0]?.channelIds)).toBe(true);
  expect(f.snapshot().records[1]?.channelIds).toEqual([]);
  f.activity.dispose();
});

const typingEvent = (root?: string, extra = {}) => ({
  id: "e".repeat(64),
  pubkey: agent,
  kind: 20002,
  content: "",
  created_at: Math.floor(Date.now() / 1000),
  tags: [
    ["h", "a"],
    ...(root
      ? [
          ["e", root, "", "root"],
          ["e", root, "", "reply"],
        ]
      : []),
  ],
  ...extra,
});
it("typing requires observer recognition, retains exact scopes, and expires on its own clock", async () => {
  const f = fixture();
  const root = "b".repeat(64),
    sibling = "c".repeat(64);
  f.activity.channelEvents([typingEvent(root)]);
  expect(f.snapshot().typing).toEqual([]);
  f.send(f.item("turn_completed")); // Recognition is not the turn's working state.
  f.activity.channelEvents([
    typingEvent(root),
    typingEvent(sibling),
    typingEvent(),
  ]);
  expect(f.snapshot().typing.map((entry) => entry.threadRootId)).toEqual([
    root,
    sibling,
    undefined,
  ]);
  const before = f.snapshot();
  await vi.advanceTimersByTimeAsync(4000);
  f.activity.channelEvents([
    typingEvent(root, { created_at: Date.now() / 1000 - 5 }),
  ]);
  expect(f.snapshot()).toBe(before); // Older typing cannot shorten or refresh evidence.
  f.send(f.item("turn_liveness", "new"));
  await vi.advanceTimersByTimeAsync(4000);
  expect(f.snapshot().typing).toEqual([]); // Observer did not refresh the typing clock.
  expect(before.typing).toHaveLength(3);
  f.activity.dispose();
});
it("keeps the first working time through typing refreshes and resets it after stopping", async () => {
  const f = fixture();
  f.send(f.item("turn_liveness"));
  f.activity.channelEvents([typingEvent()]);
  const startedAt = f.snapshot().typing[0]?.startedAt;
  expect(startedAt).toBe(Date.now());
  await vi.advanceTimersByTimeAsync(3000);
  f.activity.channelEvents([typingEvent()]);
  expect(f.snapshot().typing[0]?.startedAt).toBe(startedAt);
  f.activity.channelEvents([{ ...typingEvent(), kind: 9 }]);
  await vi.advanceTimersByTimeAsync(3000);
  f.activity.channelEvents([typingEvent()]);
  expect(f.snapshot().typing[0]?.startedAt).toBe(Date.now());
  f.activity.dispose();
});
it("messages clear only their typing scope and suppress delayed typing, while fresh work can resume", async () => {
  const f = fixture();
  const root = "b".repeat(64),
    sibling = "c".repeat(64);
  f.send(f.item("turn_liveness"));
  const first = typingEvent(root);
  f.activity.channelEvents([first, typingEvent(sibling)]);
  f.activity.channelEvents([{ ...first, kind: 9 }]);
  f.activity.channelEvents([first]);
  expect(f.snapshot().typing.map((entry) => entry.threadRootId)).toEqual([
    sibling,
  ]);
  await vi.advanceTimersByTimeAsync(3000);
  f.activity.channelEvents([typingEvent(root)]);
  expect(f.snapshot().typing).toHaveLength(2);
  f.activity.dispose();
});
it("invalid, stale, unknown-agent and ambiguous channel/thread typing cannot create a channel fallback", () => {
  const f = fixture();
  f.send(f.item("turn_liveness"));
  f.activity.channelEvents([
    typingEvent(undefined, { pubkey: "d".repeat(64) }),
    typingEvent(undefined, { created_at: Date.now() / 1000 - 8 }),
    typingEvent(undefined, { created_at: Date.now() / 1000 + 6 }),
    typingEvent(undefined, {
      tags: [
        ["h", "a"],
        ["h", "b"],
      ],
    }),
    typingEvent(undefined, {
      tags: [
        ["h", "a"],
        ["e", "bogus", "", "reply"],
      ],
    }),
    typingEvent(undefined, { tags: [] }),
  ]);
  expect(f.snapshot().typing).toEqual([]);
  f.activity.dispose();
});
it("typing clears on route failure, disconnect, disable, access reset and disposal without reconnect resurrection", () => {
  const f = fixture();
  f.send(f.item("turn_liveness"));
  const send = () => f.activity.channelEvents([typingEvent("b".repeat(64))]);
  send();
  f.activity.state({
    ...connected,
    routes: [
      ...connected.routes,
      { id: "channel:a", channelId: "a", status: "error", replay: "unknown" },
    ],
  });
  expect(f.snapshot().typing).toEqual([]);
  f.activity.state(connected);
  send();
  f.activity.state({ status: "retrying", routes: [] });
  send();
  f.activity.state(connected);
  expect(f.snapshot().typing).toEqual([]);
  send();
  f.deny();
  f.activity.state(connected);
  send();
  expect(f.snapshot().typing).toEqual([]);
  f.release();
  send();
  expect(f.snapshot().typing).toEqual([]);
  f.activity.dispose();
});
it("typing state is bounded by the existing activity budget", () => {
  const f = fixture();
  f.send(f.item("turn_liveness"));
  f.activity.channelEvents(
    Array.from({ length: ACTIVITY_TURN_LIMIT + 20 }, (_, i) =>
      typingEvent(i.toString(16).padStart(64, "0")),
    ),
  );
  expect(f.snapshot().typing).toHaveLength(ACTIVITY_TURN_LIMIT);
  f.activity.dispose();
});

it("accepted future clock skew cannot extend typing beyond eight seconds from receipt", async () => {
  const f = fixture();
  f.send(f.item("turn_liveness"));
  f.activity.channelEvents([
    typingEvent(undefined, { created_at: Date.now() / 1000 + 5 }),
  ]);
  expect(f.snapshot().typing).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(8000);
  expect(f.snapshot().typing).toEqual([]);
  f.activity.dispose();
});

it("notifies the working-channel subscriber only on set changes, including timer expiry", async () => {
  const f = fixture();
  const listener = vi.fn();
  const unsubscribe = f.activity.queries.subscribeWorking(listener);
  expect(f.activity.queries.workingSnapshot()).toBe("[]");
  f.send(f.item("mystery")); // Recognize the agent without working evidence.
  f.activity.channelEvents([typingEvent()]);
  expect(f.activity.queries.workingSnapshot()).toBe('["a"]');
  expect(listener).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  f.activity.channelEvents([typingEvent()]); // Timestamp and expiry refresh only.
  f.send(f.item("mystery", "two")); // Observer record identity changes only.
  expect(listener).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(7000);
  expect(f.activity.queries.workingSnapshot()).toBe('["a"]');
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.activity.queries.workingSnapshot()).toBe("[]");
  expect(listener).toHaveBeenCalledTimes(2);
  f.send(f.item("turn_started"));
  expect(f.activity.queries.workingSnapshot()).toBe('["a"]');
  f.send(f.item("acp_read", "two"));
  expect(listener).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(31000);
  expect(f.activity.queries.workingSnapshot()).toBe("[]");
  expect(listener).toHaveBeenCalledTimes(4);
  unsubscribe();
  f.release();
});
it("does not notify snapshot subscribers when typing pulses only refresh an unchanged typer set", async () => {
  const f = fixture();
  f.send(f.item("mystery")); // Recognize the agent without working evidence.
  const channel = (id: string) => ({ tags: [["h", id]] });
  f.activity.channelEvents([
    typingEvent(),
    typingEvent(undefined, channel("b")),
  ]);
  const listener = vi.fn();
  const unsubscribe = f.activity.queries.subscribe(listener);
  const before = f.snapshot();
  for (const id of ["a", "b", "a"]) {
    await vi.advanceTimersByTimeAsync(3000);
    f.activity.channelEvents([typingEvent(undefined, channel(id))]);
  }
  expect(listener).not.toHaveBeenCalled();
  expect(f.snapshot().typing).toBe(before.typing);
  await vi.advanceTimersByTimeAsync(8000);
  expect(f.snapshot().typing).toEqual([]);
  expect(listener).toHaveBeenCalledTimes(2); // Each scope expires on its own.
  unsubscribe();
  f.release();
});
it("keeps agent-management requests out of activity", () => {
  const f = fixture();
  f.send(
    f.item("agent_management_request", "draft", {
      channelId: "34aeaccc-c83b-4422-beac-a4b8661f9f59",
      payload: { type: "agent_management_request", action: "update" },
    }),
  );
  expect(f.snapshot().records).toEqual([]);
  f.activity.dispose();
});
it("associates lifecycle with retained signed triggers and preserves it through completion", () => {
  const root = "b".repeat(64),
    request = "c".repeat(64);
  const message = {
    id: request,
    pubkey: agent,
    kind: 9,
    created_at: 1800000000,
    content: "work",
    tags: [
      ["h", "a"],
      ["e", root, "", "reply"],
    ],
  };
  let retained = false;
  const f = fixture((id) => (retained && id === request ? message : undefined));
  f.send(
    f.item("turn_started", "one", {
      payload: { triggeringEventIds: [request] },
    }),
  );
  expect(f.snapshot().turns[0]?.requests).toEqual([]);
  retained = true;
  f.activity.messagesChanged([message]);
  expect(f.snapshot().turns[0]?.requests).toEqual([
    { messageId: request, threadRootId: root },
  ]);
  f.send(f.item("turn_completed"));
  expect(f.snapshot().turns[0]).toMatchObject({
    state: "ended",
    requests: [{ messageId: request, threadRootId: root }],
  });
  f.send(
    f.item("turn_started", "other", {
      channelId: "b",
      payload: { triggeringEventIds: [request] },
    }),
  );
  expect(f.snapshot().turns[1]?.requests).toEqual([]);
  f.release();
});
it("skips the snapshot comparison for channel traffic that changes no typing", () => {
  const f = fixture();
  f.send(f.item("turn_liveness"));
  const stringify = vi.spyOn(JSON, "stringify");
  try {
    f.activity.channelEvents([
      { ...typingEvent(), pubkey: "b".repeat(64), kind: 9 },
    ]);
    expect(stringify).not.toHaveBeenCalled();
    f.activity.channelEvents([typingEvent()]);
    expect(f.snapshot().typing).toHaveLength(1);
  } finally {
    stringify.mockRestore();
    f.activity.dispose();
  }
});
