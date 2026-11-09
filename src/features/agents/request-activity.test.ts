import { expect, it, vi } from "vitest";
import { requestActivity } from "./request-activity";

const agent = "a".repeat(64);
const trigger = "b".repeat(64);
const record = (index: number, events: unknown[]) =>
  Object.freeze({
    id: index.toString(16).padStart(64, "0"),
    agent,
    receivedAt: 1800000000000 + index,
    kind: "batch",
    plaintext: JSON.stringify({ kind: "batch", payload: { events } }),
  });
const event = (kind: string, turnId: string, seq: number, payload = {}) => ({
  kind,
  turnId,
  seq,
  channelId: "c",
  timestamp: new Date(1800000000000).toISOString(),
  payload,
});

it("parses only newly appended records when the records array changes", () => {
  const first = [
    record(1, [
      event("turn_started", "t", 1, { triggeringEventIds: [trigger] }),
      event("step", "t", 2),
    ]),
    record(2, [event("step", "t", 3), event("step", "other", 1)]),
  ];
  requestActivity(first, agent, "c", trigger);
  const parse = vi.spyOn(JSON, "parse");
  try {
    const added = record(3, [event("turn_completed", "t", 4)]);
    const next = [...first, added];
    const result = requestActivity(next, agent, "c", trigger);
    // One envelope parse plus one parse for its single projected child.
    expect(parse).toHaveBeenCalledTimes(2);
    parse.mockClear();
    const fresh = requestActivity(structuredClone(next), agent, "c", trigger);
    expect(parse.mock.calls.length).toBeGreaterThan(2 * next.length);
    expect(result).toEqual(fresh);
    expect(result.records.map(({ id }) => id)).toEqual([
      `${first[0]?.id}:0`,
      `${first[0]?.id}:1`,
      `${first[1]?.id}:0`,
      `${added.id}:0`,
    ]);
    expect(result.terminal.get("t")).toBe("ended");
  } finally {
    parse.mockRestore();
  }
});
