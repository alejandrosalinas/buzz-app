import { expect, it } from "vitest";
import {
  capture,
  EMPTY_FOLLOW_SYNC,
  type FollowHead,
  type FollowSyncState,
  hydrate,
  journal,
  mergeFollows,
  observe,
  outranks,
  ownChoices,
  parseFollowPayload,
  plaintext,
  tap,
} from "./follow-sync";

const SLOT = "a".repeat(32);
const CLIENT = "desk";
const K = `room:${"1".repeat(64)}`;
const A = `room:${"2".repeat(64)}`;
const B = `room:${"3".repeat(64)}`;
const id = (n: number, digit = "") =>
  digit ? digit.repeat(64) : n.toString(16).padStart(64, "0");

function head(
  created_at: number,
  threads: Record<string, { follow: boolean; at: number }>,
  digit = "8",
): FollowHead {
  return {
    id: id(created_at, digit),
    created_at,
    payload: { clientId: CLIENT, threads },
  };
}
/** Capture, sign (synthetic ID) and journal, as the manager does. */
function send(state: FollowSyncState, now: number) {
  const frozen = capture(state, SLOT, CLIENT, now);
  if (!frozen) throw new Error("nothing to send");
  const [reserved, candidate] = frozen;
  const signed = {
    id: id(candidate.created_at),
    created_at: candidate.created_at,
  };
  const next = journal(reserved, SLOT, signed, candidate);
  if (!next) throw new Error("stale basis");
  const echo: FollowHead = { ...signed, payload: candidate.payload };
  return [next, echo] as const;
}
const recovered = (h: FollowHead) =>
  hydrate(observe(EMPTY_FOLLOW_SYNC, SLOT, h));
const choice = (state: FollowSyncState, key: string) =>
  ownChoices(state, CLIENT).get(key);

it("W1: an accepted backward-clock unfollow survives restoring an older backup", () => {
  let w = recovered(head(100, { [K]: { follow: true, at: 100 } }));
  const backup = structuredClone(w);
  w = tap(w, SLOT, K, false, 90); // clock went back: reservation 101
  const [sent, packet] = send(w, 90);
  expect(packet.created_at).toBe(102);
  w = observe(sent, SLOT, packet);
  // Restore the old journal; recovery fetches the relay's own head.
  const restored = observe(hydrate(backup), SLOT, packet);
  for (const state of [w, restored]) {
    expect(state.edits).toEqual({});
    expect(state.packets).toEqual({});
    expect(choice(state, K)).toEqual({ follow: false, at: 90 });
  }
  // A fresh reader of the relay head agrees.
  expect(recovered(packet).heads[SLOT]?.payload?.threads[K]).toEqual({
    follow: false,
    at: 90,
  });
});

it("W2: a late echo of an earlier follow cannot erase a same-second unfollow", () => {
  let w = recovered(head(100, {}));
  w = tap(w, SLOT, K, true, 100); // edit 101
  const [first, p] = send(w, 100); // packet 102
  w = tap(first, SLOT, K, false, 100); // edit 103, same second
  w = observe(w, SLOT, p); // old echo / send callback
  expect(w.edits[K]?.r).toBe(103);
  expect(choice(w, K)).toEqual({ follow: false, at: 100 });
  const [second, q] = send(w, 100); // packet 104
  w = observe(second, SLOT, p); // duplicate old callback after successor
  expect(Object.keys(w.packets)).toEqual([q.id]);
  expect(w.edits[K]?.r).toBe(103);
  w = observe(observe(w, SLOT, q), SLOT, p);
  expect(w.heads[SLOT]?.id).toBe(q.id);
  expect(w.edits).toEqual({});
  expect(choice(w, K)).toEqual({ follow: false, at: 100 });
  expect(recovered(q).heads[SLOT]?.payload?.threads[K]?.follow).toBe(false);
});

it("no omission: a successor carries captured-but-unacknowledged edits", () => {
  let w = recovered(head(100, {}));
  w = tap(w, SLOT, A, true, 100); // 101
  const [first, p] = send(w, 100); // 102 captures A
  w = tap(first, SLOT, B, true, 100); // 103
  // The successor waits for the unresolved packet, so force the race the
  // rules forbid from losing A: resolve p as superseded-unknown by ID only.
  expect(capture(w, SLOT, CLIENT, 100)).toBeUndefined();
  const withoutP = { ...w, packets: {} };
  const [second, q] = send(withoutP, 100); // 104
  expect(Object.keys(q.payload?.threads ?? {}).sort()).toEqual([A, B].sort());
  w = observe(observe(second, SLOT, q), SLOT, p); // successor arrives first
  expect(w.heads[SLOT]?.id).toBe(q.id);
  expect([...ownChoices(w, CLIENT).keys()].sort()).toEqual([A, B].sort());
});

it("full order: a created_at tie goes to the lower event ID, and only an identical ID acknowledges", () => {
  const low = head(300, { [K]: { follow: true, at: 1 } }, "1");
  const high = head(300, { [K]: { follow: false, at: 1 } }, "e");
  expect(outranks(low, high)).toBe(true);
  expect(outranks(high, low)).toBe(false);
  for (const order of [
    [low, high],
    [high, low],
  ])
    expect(
      order.reduce((s, h) => observe(s, SLOT, h), EMPTY_FOLLOW_SYNC).heads[SLOT]
        ?.id,
    ).toBe(low.id);
  // Our pending packet at the same second but a different ID is not acknowledged.
  let w = recovered(head(298, {}));
  w = tap(w, SLOT, K, false, 298); // 299
  const frozen = capture(w, SLOT, CLIENT, 298);
  if (!frozen) throw new Error("nothing to send");
  const ours = journal(
    frozen[0],
    SLOT,
    { id: id(0, "f"), created_at: 300 },
    frozen[1],
  );
  if (!ours) throw new Error("stale basis");
  w = observe(ours, SLOT, low);
  expect(w.heads[SLOT]?.id).toBe(low.id);
  expect(w.packets).toEqual({}); // superseded by full order, not acknowledged
});

it("keeps edits and packets behind an unreadable own head and refuses new taps", () => {
  let w = recovered(head(100, {}));
  w = tap(w, SLOT, K, true, 100);
  const [sent] = send(w, 100);
  const unreadable = observe(sent, SLOT, {
    id: id(0, "9"),
    created_at: 200,
    payload: undefined,
  });
  expect(Object.keys(unreadable.edits)).toEqual([K]);
  expect(Object.keys(unreadable.packets)).toHaveLength(1);
  expect(() => tap(unreadable, SLOT, K, false, 201)).toThrow("unreadable");
});

it("reserves past every retained edit and packet on hydrate, never reusing a token", () => {
  const state = hydrate({
    ...EMPTY_FOLLOW_SYNC,
    reserved: 5,
    edits: {
      [K]: {
        slot: SLOT,
        entry: { follow: true, at: 1 },
        r: 400,
        origin: "explicit",
        basis: "empty",
      },
    },
  });
  expect(tap(state, SLOT, A, true, 10).edits[A]?.r).toBe(401);
});

it("round-trips unknown top-level and entry fields unchanged", () => {
  const raw = {
    v: 1,
    client_id: CLIENT,
    future: [1],
    threads: { [K]: { follow: true, at: 3, note: "x" } },
  };
  const payload = parseFollowPayload(raw);
  expect(JSON.parse(plaintext(payload))).toEqual(raw);
  let w = recovered({ id: id(0, "7"), created_at: 10, payload });
  w = tap(w, SLOT, K, false, 20);
  expect(w.edits[K]?.entry).toEqual({
    follow: false,
    at: 20,
    extra: { note: "x" },
  });
  expect(() => parseFollowPayload({ ...raw, threads: { bad: {} } })).toThrow();
  for (const client_id of ["", "x".repeat(65), "é".repeat(65)])
    expect(() => parseFollowPayload({ ...raw, client_id })).toThrow();
  expect(
    parseFollowPayload({ ...raw, client_id: "é".repeat(64) }).clientId,
  ).toHaveLength(64);
});

it("merges slots by greater `at`, unfollow winning ties", () => {
  const merged = mergeFollows([
    new Map([[K, { follow: true, at: 5 }]]),
    new Map([[K, { follow: false, at: 5 }]]),
    new Map([[A, { follow: true, at: 9 }]]),
    new Map([[A, { follow: false, at: 2 }]]),
  ]);
  expect(merged).toEqual(
    new Map([
      [K, false],
      [A, true],
    ]),
  );
});

it("a future-dated head that pushes the reservation past the host window fails visibly, never clamped", () => {
  const now = 1_000;
  let w = recovered(head(now + 100, { [K]: { follow: true, at: now + 100 } }));
  w = tap(w, SLOT, K, false, now);
  expect(() => capture(w, SLOT, CLIENT, now)).toThrow(
    "Follow choices are ahead of this device's clock",
  );
  // The choice stays pending, so it is retried once the clock catches up.
  expect(Object.keys(w.edits)).toEqual([K]);
  expect(w.packets).toEqual({});
  const [, later] = capture(w, SLOT, CLIENT, now + 60) ?? [];
  expect(later?.created_at).toBe(now + 102);
});

it("D5: a packet's late OK never consumes it behind a newer unreadable head", () => {
  let w = recovered(head(100, {}));
  w = tap(w, SLOT, K, true, 100);
  const [sent, packet] = send(w, 100);
  // The latest journal already holds a newer head this build can't read.
  const held = observe(sent, SLOT, {
    id: id(0, "9"),
    created_at: 200,
    payload: undefined,
  });
  const late = observe(held, SLOT, packet);
  expect(Object.keys(late.packets)).toEqual([packet.id]);
  expect(late.edits[K]).toBeDefined();
});
