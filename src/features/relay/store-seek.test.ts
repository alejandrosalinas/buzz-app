import { afterEach, assert, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import type { LiveCallbacks } from "./live";
import type { ReadFilter, RelayEvent } from "./events";
import {
  bounds,
  keypair,
  message,
  metadata,
  roster,
  scriptedTransport,
  signed,
} from "./testing";

const HOUR = 3600;
const DAY = 24 * HOUR;
const T0 = 1_700_000_000;
const newestFirst = (a: RelayEvent, b: RelayEvent) =>
  b.created_at - a.created_at || a.id.localeCompare(b.id);

/** A session over an auto-answering relay holding `count` hourly messages in channel "c". */
function harness({
  count = 300,
  maxHistoryRows,
  prepared,
}: {
  count?: number;
  maxHistoryRows?: number;
  prepared?: boolean;
} = {}) {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const history = Array.from({ length: count }, (_, i) =>
    message(alice, "c", `m${i}`, T0 + i * HOUR),
  );
  const ordered = [...history].sort(newestFirst);
  const reads: ReadFilter[] = [];
  const gate: { hold?: Promise<void> | undefined; failHead?: boolean } = {};
  let live!: LiveCallbacks;
  const base = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession(
    {
      ...base.transport,
      async query(filters, signal) {
        const filter = filters[0];
        if (!filter?.top_level) return [];
        reads.push(filter);
        await gate.hold;
        signal?.throwIfAborted();
        if (gate.failHead && filter.until === undefined)
          throw new Error("offline");
        const cursor =
          filter.until !== undefined && filter.before_id
            ? { createdAt: filter.until, eventId: filter.before_id }
            : null;
        const after = cursor
          ? ordered.filter(
              (row) =>
                row.created_at < cursor.createdAt ||
                (row.created_at === cursor.createdAt &&
                  row.id > cursor.eventId),
            )
          : ordered;
        const rows = after.slice(0, filter.limit);
        const hasMore = after.length > filter.limit;
        const last = rows.at(-1);
        return [
          ...rows,
          bounds(
            relay,
            "c",
            cursor ? `${cursor.createdAt}:${cursor.eventId}` : "head",
            {
              has_more: hasMore,
              next_cursor:
                hasMore && last
                  ? { created_at: last.created_at, id: last.id }
                  : null,
            },
          ),
        ];
      },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      now: () => (T0 + count * HOUR) * 1000,
      ...(maxHistoryRows ? { maxHistoryRows } : {}),
      ...(prepared ? { prepared } : {}),
    },
  );
  const channels = owner.session.channels;
  assert.exists(channels.seek);
  assert.exists(channels.loadNewer);
  assert.exists(channels.attach);
  const window = () => channels.window("c");
  const times = () => window().rows.map((row) => row.createdAt);
  const open = async () => {
    live.receive([
      roster(relay, "c", [viewer.pubkey]),
      metadata(relay, "c", "C"),
    ]);
    channels.ensure("c");
    await vi.waitFor(() => expect(window().status).toBe("ready"));
  };
  const seek = (from: number, signal = new AbortController().signal) =>
    (channels.seek as NonNullable<typeof channels.seek>)("c", from, signal);
  return {
    relay,
    alice,
    owner,
    channels,
    history,
    reads,
    gate,
    get live() {
      return live;
    },
    window,
    times,
    open,
    seek,
  };
}

let current: ReturnType<typeof harness> | undefined;
const setup = (options?: Parameters<typeof harness>[0]) => {
  current = harness(options);
  return current;
};
afterEach(() => {
  current?.owner.dispose();
  current = undefined;
});

it("seek installs a segment and resolves the first row at or after from", async () => {
  const h = setup();
  await h.open();
  const from = T0 + 5 * DAY + 1;
  const id = await h.seek(from);
  expect(id).toBe(h.history[5 * 24 + 1]?.id);
  expect(h.window().hasNewer).toBe(true);
  expect(h.times()[0]).toBeLessThan(from);
  expect(h.times()).not.toContain(T0 + 299 * HOUR);
});

it("seek resolves the newest row when nothing is at or after from", async () => {
  const h = setup();
  await h.open();
  const id = await h.seek(T0 + 299 * HOUR + 1);
  expect(id).toBe(h.history[299]?.id);
  expect(h.window().hasNewer).toBeFalsy();
});

it("seek uses held rows without reading", async () => {
  const h = setup();
  await h.open();
  const reads = h.reads.length;
  const id = await h.seek(T0 + 295 * HOUR);
  expect(id).toBe(h.history[295]?.id);
  expect(h.reads).toHaveLength(reads);
});

it("an aborted seek leaves the window unchanged", async () => {
  const h = setup();
  await h.open();
  const before = h.window();
  let release!: () => void;
  h.gate.hold = new Promise((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const pending = h.seek(T0 + DAY, controller.signal);
  controller.abort();
  release();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(h.window()).toBe(before);
});

it("loadOlder pages a detached window from its older cursor", async () => {
  const h = setup();
  await h.open();
  await h.seek(T0 + 9 * DAY);
  const oldest = h.times()[0];
  assert.exists(oldest);
  h.channels.loadOlder("c");
  await vi.waitFor(() => expect(h.times()[0]).toBeLessThan(oldest));
  expect(h.reads.at(-1)).toMatchObject({ until: oldest });
  expect(h.window().hasNewer).toBe(true);
});

it("loadNewer extends the segment and reattaches at the head", async () => {
  const h = setup();
  await h.open();
  await h.seek(T0 + 2 * DAY);
  const newest = () => h.times().at(-1) ?? 0;
  for (let step = 0; h.window().hasNewer && step < 20; step++) {
    const before = newest();
    h.channels.loadNewer?.("c");
    await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
    expect(newest()).toBeGreaterThan(before);
  }
  expect(h.window().hasNewer).toBeFalsy();
  expect(newest()).toBe(T0 + 299 * HOUR);
  // Contiguous: one row per hour from the segment's oldest to the head.
  const times = h.times();
  expect(
    times.every((at, i) => i === 0 || at - (times[i - 1] ?? 0) === HOUR),
  ).toBe(true);
});

it("loadNewer trims the oldest rows past maxHistoryRows", async () => {
  const h = setup({ maxHistoryRows: 100 });
  await h.open();
  await h.seek(T0 + DAY);
  for (let step = 0; h.window().rows.length < 100 && step < 10; step++) {
    h.channels.loadNewer?.("c");
    await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  }
  h.channels.loadNewer?.("c");
  await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  expect(h.window().rows.length).toBeLessThanOrEqual(100);
  expect(h.window().hasMore).toBe(true);
  const oldest = h.window().rows[0];
  assert.exists(oldest);
  h.channels.loadOlder("c");
  await vi.waitFor(() =>
    expect(h.reads.at(-1)).toMatchObject({
      until: oldest.createdAt,
      before_id: oldest.id,
    }),
  );
});

it("accept keeps live rows above a detached ceiling out of the window", async () => {
  const h = setup();
  await h.open();
  await h.seek(T0 + 3 * DAY);
  const held = h.window().rows.at(-1);
  assert.exists(held);
  const fresh = message(h.alice, "c", "fresh", T0 + 300 * HOUR);
  h.live.receive([fresh]);
  expect(h.window().rows.map((row) => row.id)).not.toContain(fresh.id);
  h.live.receive([
    signed(h.alice, {
      kind: 7,
      content: "+",
      created_at: T0 + 300 * HOUR,
      tags: [
        ["h", "c"],
        ["e", held.id],
        ["p", held.authorId],
      ],
    }),
  ]);
  await vi.waitFor(() =>
    expect(h.window().rows.at(-1)?.reactions.length).toBe(1),
  );
});

it("catchUp returns a detached window to its head", async () => {
  const h = setup();
  await h.open();
  await h.seek(T0 + 3 * DAY);
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  await vi.waitFor(() => expect(h.window().hasNewer).toBeFalsy());
  await vi.waitFor(() => expect(h.times().at(-1)).toBe(T0 + 299 * HOUR));
  expect(h.times()[0]).toBeGreaterThan(T0 + 3 * DAY);
});

it("a failed catch-up keeps the detached segment", async () => {
  const h = setup();
  await h.open();
  await h.seek(T0 + 3 * DAY);
  const segment = h.times();
  h.gate.failHead = true;
  const reads = h.reads.length;
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  await vi.waitFor(() =>
    expect(h.reads.slice(reads).some((read) => read.until === undefined)).toBe(
      true,
    ),
  );
  await vi.waitFor(() => expect(h.window().error).toBeDefined());
  expect(h.times()).toEqual(segment);
  expect(h.window().hasNewer).toBe(true);
});

it("catch-up cancels a detached window's newer page", async () => {
  const h = setup();
  await h.open();
  await h.seek(T0 + 3 * DAY);
  let release!: () => void;
  h.gate.hold = new Promise((resolve) => {
    release = resolve;
  });
  h.channels.loadNewer?.("c");
  expect(h.window().loadingNewer).toBe(true);
  h.live.state({ status: "connected", routes: [] });
  h.live.established("c");
  release();
  h.gate.hold = undefined;
  await vi.waitFor(() => expect(h.times().at(-1)).toBe(T0 + 299 * HOUR));
  await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  expect(h.window().hasNewer).toBeFalsy();
  expect(h.times().at(-1)).toBe(T0 + 299 * HOUR);
});

it("a detached segment does not become the channel preview", async () => {
  const h = setup();
  await h.open();
  const preview = () =>
    h.channels.list().channels.find((channel) => channel.id === "c")?.preview;
  await vi.waitFor(() => expect(preview()).toBe("m299"));
  await h.seek(T0 + 3 * DAY);
  expect(preview()).toBe("m299");
  h.channels.attach?.("c");
  await vi.waitFor(() => expect(h.window().hasNewer).toBeFalsy());
  expect(preview()).toBe("m299");
});

it("live messages move the channel preview while detached", async () => {
  const h = setup();
  await h.open();
  const preview = () =>
    h.channels.list().channels.find((channel) => channel.id === "c")?.preview;
  await vi.waitFor(() => expect(preview()).toBe("m299"));
  await h.seek(T0 + 3 * DAY);
  h.live.receive([message(h.alice, "c", "fresh", T0 + 300 * HOUR)]);
  await vi.waitFor(() => expect(preview()).toBe("fresh"));
  expect(h.window().hasNewer).toBe(true);
});

it.each([
  ["a page", false],
  ["a prepared head", true],
])(
  "a live row that lands while attach reads %s is kept",
  async (_, prepared) => {
    const h = setup({ prepared });
    await h.open();
    await h.seek(T0 + 3 * DAY);
    let release!: () => void;
    h.gate.hold = new Promise((resolve) => {
      release = resolve;
    });
    const reads = h.reads.length;
    h.channels.attach?.("c");
    // The relay answered before `fresh` was published; it arrives live.
    await vi.waitFor(() => expect(h.reads.length).toBeGreaterThan(reads));
    const fresh = message(h.alice, "c", "fresh", T0 + 299 * HOUR + 1800);
    h.live.receive([fresh]);
    release();
    h.gate.hold = undefined;
    await vi.waitFor(() => expect(h.window().hasNewer).toBeFalsy());
    expect(h.window().rows.map((row) => row.id)).toContain(fresh.id);
  },
);

it("a live row that lands while the last newer page loads is kept", async () => {
  const h = setup();
  await h.open();
  await h.seek(T0 + 3 * DAY);
  const fresh = message(h.alice, "c", "fresh", T0 + 299 * HOUR + 1800);
  for (let page = 0; page < 10 && h.window().hasNewer; page++) {
    let release!: () => void;
    h.gate.hold = new Promise((resolve) => {
      release = resolve;
    });
    h.channels.loadNewer?.("c");
    // The relay answered before `fresh` was published; it arrives live.
    await vi.waitFor(() => expect(h.reads.length).toBeGreaterThan(0));
    h.live.receive([fresh]);
    release();
    h.gate.hold = undefined;
    await vi.waitFor(() => expect(h.window().loadingNewer).toBeFalsy());
  }
  expect(h.window().hasNewer).toBeFalsy();
  expect(h.window().rows.map((row) => row.id)).toContain(fresh.id);
});

it("attach replaces the segment with the head", async () => {
  const h = setup();
  await h.open();
  await h.seek(T0 + 3 * DAY);
  h.channels.attach?.("c");
  await vi.waitFor(() => expect(h.window().hasNewer).toBeFalsy());
  expect(h.times().at(-1)).toBe(T0 + 299 * HOUR);
  expect(h.times()[0]).toBeGreaterThan(T0 + 3 * DAY);
});

it("rows received before a seek stay out of its segment", async () => {
  const h = setup();
  await h.open();
  const fresh = message(h.alice, "c", "fresh", T0 + 300 * HOUR);
  h.live.receive([fresh]);
  await vi.waitFor(() =>
    expect(h.window().rows.map((row) => row.id)).toContain(fresh.id),
  );
  await h.seek(T0 + 3 * DAY);
  expect(h.window().rows.map((row) => row.id)).not.toContain(fresh.id);
});

it("live rows do not crowd a detached segment out of the history budget", async () => {
  const h = setup({ maxHistoryRows: 250 });
  await h.open();
  await h.seek(T0 + 10 * DAY);
  expect(h.window().rows.length).toBe(200);
  const oldest = h.window().rows[0]?.id;
  h.live.receive(
    Array.from({ length: 60 }, (_, i) =>
      message(h.alice, "c", `fresh${i}`, T0 + 300 * HOUR + i),
    ),
  );
  expect(h.window().rows[0]?.id).toBe(oldest);
});
