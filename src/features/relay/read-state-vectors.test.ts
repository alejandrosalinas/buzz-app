import { describe, expect, it } from "vitest";
// Shared with buzz mobile; never edit one copy alone.
import vectors from "../../../tests/fixtures/read-state-vectors.json";
import {
  effectiveFrontier,
  mergeReadStates,
  packReadState,
  readBlob,
  unreadActive,
  unreadBlob,
  unreadDiscardable,
  unreadExpired,
  unreadReceive,
  unreadStamp,
} from "./read-state-model";

const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
const state = (frontiers: Record<string, number>) => ({
  frontiers,
  overrides: {},
});
const slots =
  (n = 0) =>
  () =>
    String(n++).padStart(32, "0");

describe("NIP-RS shared vectors", () => {
  it.each(vectors.evaluation)("evaluation $id", (v) => {
    const merged = mergeReadStates(...v.states.map(state));
    const [channelId, thread] = v.parents;
    const effective = Math.max(
      vectors.floor,
      effectiveFrontier(
        merged,
        v.key,
        channelId,
        thread?.slice("thread:".length),
      ) ?? 0,
    );
    expect(effective).toBe(v.expectedEffective);
    expect(v.messageAt > effective).toBe(v.expectedUnread);
  });
  it.each(vectors.packing)("packing $id", (v) => {
    const generated = v.generate;
    const frontiers =
      v.frontiers ??
      Object.fromEntries(
        Array.from({ length: generated?.count ?? 0 }, (_, n) => [
          `${generated?.keyPrefix}${n.toString(16).padStart(64, "0")}`,
          (generated?.valueStart ?? 0) + n * (generated?.valueStep ?? 0),
        ]),
      );
    const plan = packReadState(
      v.clientId,
      frontiers,
      [],
      slots(),
      v.maxPlaintextBytes,
    );
    const blobs = plan.map(({ frontiers }) =>
      readBlob(v.clientId, state({ ...frontiers }), () => undefined),
    );
    expect(blobs.map(bytes)).toEqual(v.expectedPlaintextBytes);
    const keys = blobs.map((blob) => Object.keys(blob.contexts));
    if (v.expectedBlobKeys) expect(keys).toEqual(v.expectedBlobKeys);
    const sorted = Object.keys(frontiers).sort();
    for (const [index, range] of (v.expectedBlobRanges ?? []).entries())
      expect(keys[index]).toEqual(
        sorted.slice(range.firstIndex, range.lastIndex + 1),
      );
  });
  it.each(vectors.placement)("placement $id", (v) => {
    const plan = packReadState(
      v.clientId,
      Object.assign({}, ...v.slots.map((s) => s.frontiers), v.advance),
      v.slots.map(({ slot, frontiers }) => ({
        slot,
        carried: Object.keys(frontiers),
      })),
      slots(2),
      v.maxPlaintextBytes,
    );
    for (const [key, slot] of Object.entries(v.expectedPreservedAssignments))
      expect(plan.find((blob) => key in blob.frontiers)?.slot).toBe(slot);
    // The untouched carrier keeps exactly its content, so it is not rewritten.
    expect(plan[1]?.frontiers).toEqual(v.slots[1]?.frontiers);
    expect(plan.some((blob) => "room-a" in blob.frontiers)).toBe(true);
  });
  it.each(vectors.placement)("placement $id, first carrier full", (v) => {
    // With no room left beside its carriers, the early key must go
    // elsewhere rather than push a carried key out of its blob.
    const [full, rest] = v.slots;
    const plan = packReadState(
      v.clientId,
      Object.assign({}, ...v.slots.map((s) => s.frontiers), v.advance),
      v.slots.map(({ slot, frontiers }) => ({
        slot,
        carried: Object.keys(frontiers),
      })),
      slots(2),
      bytes(
        readBlob(v.clientId, state({ ...full?.frontiers }), () => undefined),
      ),
    );
    expect(plan[0]?.frontiers).toEqual(full?.frontiers);
    expect(plan[1]?.frontiers).toMatchObject({ ...rest?.frontiers });
    expect(plan.some((blob) => "room-a" in blob.frontiers)).toBe(true);
  });
});

describe("NIP-RS shared vectors: expiring unread (version 2)", () => {
  const { unreadV2 } = vectors;
  const register = (r: { s: number; c: number; b: number }) => ({
    set: r.s,
    clear: r.c,
    baseline: r.b,
  });
  const now = 1800000000;
  it.each(unreadV2.liveness)("liveness $id", (v) => {
    const value = register(v.register);
    expect(unreadActive(value, v.frontier, now)).toBe(v.expectedActive);
    expect(unreadExpired(value, now)).toBe(v.expectedExpired);
    expect(unreadDiscardable(value, now)).toBe(v.expectedDiscardable);
    const blob = unreadBlob("c", { room: value }, () => v.frontier, now);
    const { room: _frontier, ...groups } = blob.contexts;
    expect(blob.v).toBe(2);
    expect(groups).toEqual(v.expectedDiscardable ? {} : v.expectedCanonical);
  });
  it.each(unreadV2.allocation)("allocation $id", (v) => {
    expect(unreadStamp(register(v.register), v.now)).toBe(v.expectedStamp);
  });
  it.each(unreadV2.receive)("receive $id", (v) => {
    expect(unreadReceive(register(v.register), v.now)).toBe(v.expected);
  });
});
