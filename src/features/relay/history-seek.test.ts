import { describe, expect, it } from "vitest";
import type { RelayEvent } from "./events";
import {
  locate,
  SEEK_PAGE,
  SEEK_READS,
  SeekLimitError,
  type SeekRead,
} from "./history-seek";
import type { WindowCursor } from "./window";

const DAY = 86_400;
const T0 = 1_700_006_400; // A UTC midnight.

/** An in-memory NIP-CW channel window: `created_at DESC, id ASC` keyset pages. */
function relay(times: readonly number[]) {
  const rows = times
    .map(
      (created_at, index) =>
        ({
          id: index.toString(16).padStart(64, "0"),
          created_at,
          kind: 9,
          pubkey: "",
          tags: [],
          content: "",
          sig: "",
        }) as unknown as RelayEvent,
    )
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
  const calls: { cursor: WindowCursor | null; full: boolean }[] = [];
  const read: SeekRead = async (cursor, full) => {
    calls.push({ cursor, full });
    const after = cursor
      ? rows.filter(
          (row) =>
            row.created_at < cursor.createdAt ||
            (row.created_at === cursor.createdAt && row.id > cursor.eventId),
        )
      : rows;
    const events = after.slice(0, SEEK_PAGE);
    const hasMore = after.length > SEEK_PAGE;
    const last = events.at(-1);
    return {
      events,
      hasMore,
      cursor:
        hasMore && last
          ? { createdAt: last.created_at, eventId: last.id }
          : null,
    };
  };
  return { rows, read, calls };
}

const rowsOf = (located: Awaited<ReturnType<typeof locate>>) =>
  located.kind === "segment"
    ? located.page.events.map((event) => event.created_at)
    : [];

describe("locate", () => {
  it("fits on the first day probe", async () => {
    const hourly = Array.from({ length: 30 * 24 }, (_, i) => T0 + i * 3600);
    const { read, calls } = relay(hourly);
    const from = T0 + 10 * DAY;
    const located = await locate(read, from, T0 + 30 * DAY, true);
    expect(located.kind).toBe("segment");
    expect(rowsOf(located)).toContain(from);
    expect(rowsOf(located).some((at) => at < from)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("gallops over empty days", async () => {
    const times = [
      ...Array.from({ length: 10 }, (_, i) => T0 + i * 60),
      ...Array.from({ length: 10 }, (_, i) => T0 + 20 * DAY + i * 60),
    ];
    const { read, calls } = relay(times);
    const located = await locate(read, T0 + 5 * DAY, T0 + 30 * DAY, true);
    expect(rowsOf(located)).toContain(T0 + 20 * DAY);
    expect(calls.length).toBeLessThanOrEqual(8);
  });

  it("binary searches a dense day", async () => {
    const from = T0 + 3 * DAY;
    const times = [
      ...Array.from({ length: 300 }, (_, i) => T0 + i * 600),
      ...Array.from({ length: 5000 }, (_, i) => from + 5 + i * 17),
    ];
    const { read, calls } = relay(times);
    const located = await locate(read, from, T0 + 10 * DAY, true);
    expect(rowsOf(located)).toContain(from + 5);
    expect(calls.length).toBeLessThanOrEqual(SEEK_READS);
  });

  it("returns newest when nothing is at or after from", async () => {
    const { read } = relay([T0, T0 + 60, T0 + 120]);
    await expect(locate(read, T0 + DAY, T0 + 3 * DAY, true)).resolves.toEqual({
      kind: "newest",
    });
  });

  it("finds the channel start without gallop", async () => {
    const span = 2 * 365 * DAY;
    const times = Array.from(
      { length: 3000 },
      (_, i) => T0 + Math.floor((i * span) / 3000),
    );
    const { read } = relay(times);
    const located = await locate(read, 0, T0 + span + DAY, false);
    expect(located).toMatchObject({ kind: "segment" });
    expect(rowsOf(located)).toContain(T0);
  });

  it("rejects a burst of more than a page in one second", async () => {
    const times = [
      ...Array.from({ length: 10 }, (_, i) => T0 + i),
      ...Array.from({ length: 450 }, () => T0 + DAY + 30),
    ];
    const { read } = relay(times);
    await expect(
      locate(read, T0 + DAY, T0 + 3 * DAY, true),
    ).rejects.toBeInstanceOf(SeekLimitError);
  });

  it("throws SeekLimitError past the read budget", async () => {
    let reads = 0;
    const overflow: SeekRead = async () => {
      reads++;
      // Every probe looks dense: rows at the far future, more beyond.
      return {
        events: [
          {
            id: "a".repeat(64),
            created_at: Number.MAX_SAFE_INTEGER,
            kind: 9,
          } as unknown as RelayEvent,
        ],
        hasMore: true,
        cursor: { createdAt: 1, eventId: "a".repeat(64) },
      };
    };
    await expect(
      locate(overflow, 0, Number.MAX_SAFE_INTEGER - 1, false),
    ).rejects.toBeInstanceOf(SeekLimitError);
    expect(reads).toBe(SEEK_READS);
  });

  it("reads bare probes and one full page", async () => {
    const hourly = Array.from({ length: 30 * 24 }, (_, i) => T0 + i * 3600);
    const { read, calls } = relay(hourly);
    await locate(read, T0 + 4 * DAY, T0 + 30 * DAY, true);
    expect(calls.slice(0, -1).every((call) => !call.full)).toBe(true);
    expect(calls.at(-1)?.full).toBe(true);
  });
});
