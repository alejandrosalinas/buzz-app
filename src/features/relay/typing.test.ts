import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTyping } from "./typing";
import { keypair, message, signed } from "./testing";

const agent = keypair(),
  viewer = keypair();
const epoch = 1_800_000_000;
function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(epoch * 1000);
  const owner = createTyping(
    viewer.pubkey,
    (id) => id === "a",
    (fn) => fn(),
  );
  return { owner, snapshot: owner.capability.snapshot };
}
function pulse(tags = [["h", "a"]], at = epoch, key = agent) {
  return signed(key, { kind: 20002, content: "", tags, created_at: at });
}
afterEach(() => vi.useRealTimers());
it("expires at signed time, ignores duplicates/out-of-order pulses and uses one timer", () => {
  const { owner, snapshot } = setup();
  owner.accept([pulse()], true);
  expect(snapshot()).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(3000);
  owner.accept([pulse(), pulse(undefined, epoch - 1)], true);
  vi.advanceTimersByTime(4999);
  expect(snapshot()).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(snapshot()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
it("rejects finite, expired, future, self, denied and malformed channel/thread scope", () => {
  const { owner, snapshot } = setup();
  owner.accept([pulse()]);
  owner.accept(
    [
      pulse(undefined, epoch - 8),
      pulse(undefined, epoch + 1),
      pulse(undefined, epoch, viewer),
      pulse([]),
      pulse([["h", "denied"]]),
      pulse([
        ["h", "a"],
        ["h", "a"],
      ]),
      pulse([
        ["h", "a"],
        ["e", "bad", "", "reply"],
      ]),
      pulse([
        ["h", "a"],
        ["e", "a".repeat(64), "", "root"],
      ]),
      pulse([
        ["h", "a"],
        ["e", "a".repeat(64)],
      ]),
      pulse([
        ["h", "a"],
        ["e", "a".repeat(64), "", "mention"],
      ]),
      pulse([
        ["h", "a"],
        ["e", "a".repeat(64), "", "root"],
        ["e", "b".repeat(64), "", "reply"],
        ["e", "c".repeat(64), "", "mention"],
      ]),
    ],
    true,
  );
  expect(snapshot()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
it("separates channel, canonical threads, nested roots and multiple signers", () => {
  const { owner, snapshot } = setup();
  const root = "a".repeat(64),
    parent = "b".repeat(64);
  owner.accept(
    [
      pulse(),
      pulse([
        ["h", "a"],
        ["e", root, "", "reply"],
      ]),
      pulse(undefined, epoch, keypair()),
    ],
    true,
  );
  expect(snapshot()).toHaveLength(3);
  owner.accept(
    [
      pulse([
        ["h", "a"],
        ["e", root, "", "root"],
        ["e", parent, "", "reply"],
      ]),
    ],
    true,
  );
  expect(snapshot()).toHaveLength(3);
  expect(snapshot().filter((e) => e.threadRootId === root)).toHaveLength(1);
  owner.dispose();
  expect(snapshot()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
it("messages win a batch, suppress late pulses for two seconds and retain timestamp watermarks", () => {
  const { owner, snapshot } = setup();
  owner.accept([pulse(), message(agent, "a", "fixture", epoch)], true);
  expect(snapshot()).toEqual([]);
  vi.advanceTimersByTime(1000);
  owner.accept([pulse(undefined, epoch + 1)], true);
  expect(snapshot()).toEqual([]);
  vi.advanceTimersByTime(1000);
  owner.accept([pulse(), pulse(undefined, epoch + 2)], true);
  expect(snapshot()).toHaveLength(1);
  // Duplicate history cannot extend suppression or remove newer activity.
  owner.accept([message(agent, "a", "old", epoch)]);
  expect(snapshot()).toHaveLength(1);
  vi.advanceTimersByTime(8000);
  expect(snapshot()).toEqual([]);
});
for (const kind of [9]) {
  it(`kind ${kind} quiet suppression remembers replayed pulses without deferring activity or extending quiet`, () => {
    const { owner, snapshot } = setup();
    owner.accept([
      signed(agent, {
        kind,
        tags: [["h", "a"]],
        content: "complete",
        created_at: epoch,
      }),
    ]);
    vi.advanceTimersByTime(1000);
    const suppressed = pulse(undefined, epoch + 1);
    owner.accept([suppressed], true);
    expect(snapshot()).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(snapshot()).toEqual([]); // Quiet ending never reveals a dropped pulse.
    owner.accept([suppressed], true);
    expect(snapshot()).toEqual([]);
    // Suppression did not move the original two-second quiet deadline.
    owner.accept([pulse(undefined, epoch + 2)], true);
    expect(snapshot()).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    owner.accept([suppressed], true);
    expect(snapshot()).toHaveLength(1);
    vi.advanceTimersByTime(6999);
    expect(snapshot()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(snapshot()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
}

it("message suppression is signer/thread scoped and clears only older activity", () => {
  const { owner, snapshot } = setup();
  const tags = [
    ["h", "a"],
    ["e", "a".repeat(64), "", "reply"],
  ];
  owner.accept([pulse(), pulse(tags)], true);
  owner.accept([message(agent, "a", "channel", epoch)]);
  expect(snapshot()).toHaveLength(1);
  expect(snapshot()[0]?.threadRootId).toBe("a".repeat(64));
  owner.accept([
    signed(agent, { kind: 40002, tags, content: "{}", created_at: epoch }),
  ]);
  expect(snapshot()).toEqual([]);
});
it("a thread reply also ends and briefly quiets the signer's channel-level typing, but not other threads", () => {
  const { owner, snapshot } = setup();
  const thread = (root: string) => [
    ["h", "a"],
    ["e", root, "", "reply"],
  ];
  const sibling = "b".repeat(64);
  owner.accept([pulse(), pulse(thread(sibling))], true);
  owner.accept([
    message(agent, "a", "reply", epoch, [["e", "a".repeat(64), "", "reply"]]),
  ]);
  expect(snapshot().map((e) => e.threadRootId)).toEqual([sibling]);
  // A channel-level pulse stamped with the reply but delivered after it.
  vi.advanceTimersByTime(1000);
  owner.accept([pulse()], true);
  expect(snapshot().map((e) => e.threadRootId)).toEqual([sibling]);
  vi.advanceTimersByTime(1000);
  owner.accept([pulse(undefined, epoch + 2)], true);
  expect(snapshot()).toHaveLength(2);
});
describe("activity capacity", () => {
  let pulses: ReturnType<typeof pulse>[];
  beforeAll(() => {
    // Prepare real signed input outside the behavior check. Signing speed is
    // not the capacity contract; keep all 1025 distinct scopes.
    pulses = Array.from({ length: 1025 }, (_, i) =>
      pulse([
        ["h", "a"],
        ["e", i.toString(16).padStart(64, "0"), "", "reply"],
      ]),
    );
  });
  it("bounds active and suppression records without eviction; teardown fences retained callbacks", () => {
    const { owner, snapshot } = setup();
    owner.accept(pulses, true);
    expect(snapshot()).toHaveLength(1024);
    expect(vi.getTimerCount()).toBe(1);
    const listener = vi.fn();
    const stop = owner.capability.subscribe(listener);
    owner.clear();
    expect(snapshot()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    owner.accept([pulse()], true);
    expect(listener).toHaveBeenCalledTimes(1);
    owner.dispose();
    owner.accept([pulse()], true);
    expect(snapshot()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("a thread reply with no room for its own scope still ends channel-level typing", () => {
    const { owner, snapshot } = setup();
    owner.accept([pulse(), ...pulses.slice(0, 1023)], true);
    expect(snapshot()).toHaveLength(1024);
    owner.accept([
      message(agent, "a", "reply", epoch, [["e", "f".repeat(64), "", "reply"]]),
    ]);
    expect(snapshot()).toHaveLength(1023);
    expect(snapshot().some((e) => !e.threadRootId)).toBe(false);
    owner.dispose();
  });
});

for (const kind of [9]) {
  for (const scope of ["mention", "quote", "reply", "nested"] as const) {
    it(`kind ${kind} ${scope} content clears and suppresses its authoritative scope`, () => {
      const { owner, snapshot } = setup();
      const root = "a".repeat(64);
      const threadTags = [
        ["h", "a"],
        ["e", root, "", "reply"],
      ];
      const references =
        scope === "mention"
          ? [["e", "b".repeat(64), "", "mention"]]
          : scope === "quote"
            ? [["e", "b".repeat(64)]]
            : [
                ...(scope === "nested" ? [["e", root, "", "root"]] : []),
                ["e", scope === "nested" ? "c".repeat(64) : root, "", "reply"],
                ["e", "b".repeat(64), "", "mention"],
                ["e", "d".repeat(64)],
              ];
      const threaded = scope === "reply" || scope === "nested";
      const sibling = "f".repeat(64);
      const target = pulse(threaded ? threadTags : undefined);
      // A thread reply also ends channel-level typing, so its survivor is
      // another thread's.
      const other = pulse(
        threaded
          ? [
              ["h", "a"],
              ["e", sibling, "", "reply"],
            ]
          : threadTags,
      );
      owner.accept([target, other], true);
      owner.accept([
        signed(agent, {
          kind,
          content: "fixture",
          created_at: epoch,
          tags: [["h", "a"], ...references],
        }),
      ]);
      expect(snapshot()).toHaveLength(1);
      expect(snapshot()[0]?.threadRootId).toBe(threaded ? sibling : root);
      // Same-second replay and a newer pulse during the quiet period both lose.
      owner.accept([target], true);
      vi.advanceTimersByTime(1000);
      owner.accept([pulse(threaded ? threadTags : undefined, epoch + 1)], true);
      expect(snapshot()).toHaveLength(1);
      vi.advanceTimersByTime(1000);
      owner.accept([pulse(threaded ? threadTags : undefined, epoch + 2)], true);
      expect(snapshot()).toHaveLength(2);
      owner.dispose();
    });
  }
}

it("stays visible across three-second heartbeats, then expires eight seconds after the last signed pulse", () => {
  const { owner, snapshot } = setup();
  owner.accept([pulse()], true);
  for (const seconds of [3, 6, 9]) {
    vi.advanceTimersByTime(3000);
    expect(snapshot()).toHaveLength(1);
    owner.accept([pulse(undefined, epoch + seconds)], true);
  }
  // One missed scheduled heartbeat does not flicker; a second exhausts the margin.
  vi.advanceTimersByTime(7999);
  expect(snapshot()).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(snapshot()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects delayed pre-message activity after the quiet period, but admits genuinely newer activity", () => {
  const { owner, snapshot } = setup();
  owner.accept([message(agent, "a", "complete", epoch)]);
  vi.advanceTimersByTime(3000);
  owner.accept([pulse(undefined, epoch - 1), pulse()], true);
  expect(snapshot()).toEqual([]);
  owner.accept([pulse(undefined, epoch + 3)], true);
  expect(snapshot()).toHaveLength(1);
  // A previously unseen older completion must not clear this newer activity.
  owner.accept([message(agent, "a", "delayed completion", epoch + 1)]);
  expect(snapshot()).toHaveLength(1);
  vi.advanceTimersByTime(8000);
  expect(snapshot()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

describe("completion capacity", () => {
  let messages: ReturnType<typeof signed>[];
  beforeAll(() => {
    messages = Array.from({ length: 1024 }, (_, i) =>
      signed(agent, {
        kind: 9,
        content: "complete",
        created_at: epoch,
        tags: [
          ["h", "a"],
          ["e", i.toString(16).padStart(64, "0"), "", "reply"],
        ],
      }),
    );
  });
  it("retains completion evidence at capacity until stale pulses have expired", () => {
    const { owner, snapshot } = setup();
    // A scope the full table has no room for.
    const fresh = [
      ["h", "a"],
      ["e", "f".repeat(64), "", "reply"],
    ];
    owner.accept(messages);
    vi.advanceTimersByTime(3000);
    owner.accept([pulse(fresh, epoch + 3)], true);
    expect(snapshot()).toEqual([]);
    vi.advanceTimersByTime(5000);
    owner.accept([pulse(fresh, epoch + 8)], true);
    expect(snapshot()).toHaveLength(1);
    owner.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
