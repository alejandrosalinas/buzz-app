import { describe, expect, it } from "vitest";
import {
  advanceRead,
  effectiveFrontier,
  EMPTY_READ_STATE,
  mergeReadStates,
  overrideActive,
  parseReadBlob,
  readBlob,
  readCoordinate,
  readVersion,
  READ_STATE_MAX,
  unreadBlob,
  unreadStamp,
} from "./read-state-model";

// Aggregate (journal) parsing: frontiers and groups without wire pairing.
const parse = (contexts: Record<string, unknown>) =>
  parseReadBlob({ v: 2, client_id: "test", contexts }, true).state;
const wire = (contexts: Record<string, unknown>) =>
  parseReadBlob({ v: 2, client_id: "test", contexts }).state;
describe("NIP-RS read-state algebra", () => {
  it("is commutative, associative and idempotent across frontier and override replays", () => {
    const a = parse({
      channel: 11,
      "ov_s:channel": 2,
      "ov_c:channel": 1,
      "ov_b:channel": 11,
    });
    const b = parse({ channel: 7, "ov_c:channel": 3 });
    const c = parse({ channel: 13, "msg:x": 18 });
    expect(mergeReadStates(a, b, c)).toEqual(mergeReadStates(c, a, b));
    expect(mergeReadStates(mergeReadStates(a, b), c)).toEqual(
      mergeReadStates(a, mergeReadStates(b, c)),
    );
    expect(mergeReadStates(a, a)).toEqual(a);
    expect(overrideActive(mergeReadStates(a, b).overrides.channel, 11)).toBe(
      false,
    );
  });
  it("keeps unknown distinct from timestamp zero and never advances a parent for a child", () => {
    const state = advanceRead(
      advanceRead(EMPTY_READ_STATE, "room", 10),
      "msg:reply",
      30,
    );
    expect(effectiveFrontier(state, "missing")).toBeUndefined();
    expect(effectiveFrontier(parse({ room: 0 }), "room")).toBe(0);
    expect(effectiveFrontier(state, "msg:other", "room")).toBe(10);
    expect(effectiveFrontier(state, "room")).toBe(10);
    expect(
      effectiveFrontier(
        advanceRead(state, "thread:root", 20),
        "msg:other",
        "room",
        "root",
      ),
    ).toBe(20);
  });
  it("rejects malformed override siblings as a whole without losing their frontier", () => {
    for (const contexts of [
      { room: 4, "ov_s:room": 3 },
      { room: 4, "ov_c:room": 1, "ov_b:room": 3 },
      { room: 4, "ov_s:room": 3, "ov_c:room": -1, "ov_b:room": 4 },
    ]) {
      expect(parse(contexts)).toEqual({
        frontiers: { room: 4 },
        overrides: {},
      });
    }
  });
  it("retains canonical permanent clear floors against stale live registers", () => {
    const set = parse({
      room: 10,
      "ov_s:room": 5,
      "ov_c:room": 0,
      "ov_b:room": 10,
    });
    expect(overrideActive(set.overrides.room, 10)).toBe(true);
    const clear = advanceRead(set, "room", 11);
    const canonical = unreadBlob(
      "test",
      clear.overrides,
      (key) => effectiveFrontier(clear, key),
      5,
    );
    expect(canonical.contexts).toEqual({ room: 11, "ov_c:room": 5 });
    expect(
      overrideActive(
        mergeReadStates(parseReadBlob(canonical).state, set).overrides.room,
        10,
      ),
    ).toBe(false);
    expect(
      unreadStamp(
        parse({ "ov_c:room": READ_STATE_MAX }).overrides.room,
        READ_STATE_MAX,
      ),
    ).toBeNull();
  });
  it("never imports version-1 override groups", () => {
    const groups = { room: 4, "ov_s:room": 3, "ov_c:room": 0, "ov_b:room": 4 };
    expect(
      parseReadBlob({ v: 1, client_id: "a", contexts: groups }).state,
    ).toEqual({ frontiers: { room: 4 }, overrides: {} });
    expect(parse(groups).overrides.room).toEqual({
      set: 3,
      clear: 0,
      baseline: 4,
    });
  });
  it.each([
    [
      "a group with no frontier",
      { "ov_s:room": 3, "ov_c:room": 0, "ov_b:room": 4 },
    ],
    [
      "a group with an invalid frontier",
      { room: -1, "ov_s:room": 3, "ov_c:room": 0, "ov_b:room": 4 },
    ],
    ["a frontier-only entry", { other: 9 }],
    [
      "a non-channel group",
      {
        "thread:x": 2,
        "ov_s:thread:x": 3,
        "ov_c:thread:x": 0,
        "ov_b:thread:x": 2,
      },
    ],
  ])("a version-2 record drops %s", (_name, extra) => {
    const paired = { side: 0, "ov_s:side": 5, "ov_c:side": 0, "ov_b:side": 0 };
    expect(wire({ ...paired, ...extra })).toEqual({
      frontiers: { side: 0 },
      overrides: { side: { set: 5, clear: 0, baseline: 0 } },
    });
  });
  it("a version-2 record pairs a group with its escaped frontier key", () => {
    expect(
      wire({
        "esc:ov_room": 4,
        "ov_s:ov_room": 5,
        "ov_c:ov_room": 0,
        "ov_b:ov_room": 4,
      }),
    ).toEqual({
      frontiers: { ov_room: 4 },
      overrides: { ov_room: { set: 5, clear: 0, baseline: 4 } },
    });
  });
  it("a version-2 record keeps a tombstone with its paired frontier, and version 1 keeps frontiers", () => {
    expect(wire({ room: 7, "ov_c:room": 3, other: 9 })).toEqual({
      frontiers: { room: 7 },
      overrides: { room: { set: 0, clear: 3, baseline: 0 } },
    });
    expect(
      parseReadBlob({ v: 1, client_id: "a", contexts: { other: 9 } }).state,
    ).toEqual({ frontiers: { other: 9 }, overrides: {} });
  });
  it("escapes reserved IDs once and accepts prototype-looking IDs as ordinary data", () => {
    const state = parse(
      JSON.parse('{"esc:ov_s:x":2,"esc:esc:x":3,"__proto__":4}'),
    );
    const blob = readBlob("test", state, () => undefined);
    expect(blob.contexts["esc:ov_s:x"]).toBe(2);
    expect(blob.contexts["esc:esc:x"]).toBe(3);
    expect(Object.hasOwn(blob.contexts, "__proto__")).toBe(true);
    expect(parseReadBlob(blob).state).toEqual(state);
  });
  it("validates version, capacities, UTF-8 bytes and uint32 entries", () => {
    expect(() => parseReadBlob({ v: 3, client_id: "a", contexts: {} })).toThrow(
      "Unsupported",
    );
    expect(
      parse({ bad: -1, fraction: 1.5, huge: READ_STATE_MAX + 1, good: 0 }),
    ).toEqual({ frontiers: { good: 0 }, overrides: {} });
    expect(parse({ ["é".repeat(129)]: 1 }).frontiers).toEqual({});
    expect(() =>
      parse(
        Object.fromEntries(
          Array.from({ length: 10001 }, (_, i) => [`k${i}`, 1]),
        ),
      ),
    ).toThrow("capacity");
  });
  it("selects only exact coordinates and one discoverability tag", () => {
    const event = {
      kind: 30078,
      tags: [
        ["d", `read-state:${"a".repeat(32)}`],
        ["t", "read-state"],
      ],
    };
    expect(readCoordinate(event)).toBe(event.tags[0]?.[1]);
    expect(
      readCoordinate({ ...event, tags: [...event.tags, ["d", "other"]] }),
    ).toBeUndefined();
    expect(
      readCoordinate({ ...event, tags: [...event.tags, ["t", "read-state"]] }),
    ).toBeUndefined();
    expect(readCoordinate({ ...event, kind: 9 })).toBeUndefined();
  });
  it("orders same-second publications and stops a backward-clock runaway", () => {
    expect(readVersion(100, 100)).toBe(101);
    expect(readVersion(100, 110)).toBe(111);
    expect(() => readVersion(100, 160)).toThrow("clock");
  });
});
