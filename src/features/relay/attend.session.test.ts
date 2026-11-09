import { afterEach, assert, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import type { RelayEvent } from "./events";
import type { LiveCallbacks } from "./live";
import { flush, keypair, scriptedTransport, signed } from "./testing";

const viewer = keypair(),
  relay = keypair(),
  other = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
const OPEN = "33333333-3333-4333-8333-333333333333";
const CLOSED = "44444444-4444-4444-8444-444444444444";

function harness() {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const update =
    vi.fn<(ids: readonly string[], joined?: readonly string[]) => void>();
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    scope: "https://one.example",
    subscribe(callbacks) {
      live = callbacks;
      return { update, retry() {}, dispose() {} };
    },
  });
  owners.push(owner);
  /** Connects, and the viewer's roster read finds no channel. */
  const discover = async () => {
    live.state({ status: "connected", routes: [] });
    live.established();
    await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
    wire.next().respond([]);
    await vi.waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
  };
  /** Drops and restores the socket, and discovery reads the roster again. */
  const reconnect = async () => {
    live.state({ status: "retrying", routes: [] });
    live.state({ status: "connected", routes: [] });
    live.established();
    const roster = () =>
      wire.pending.findIndex(
        (entry) =>
          !entry.signal?.aborted &&
          !entry.filters.some((filter) => filter["#d"]),
      );
    await vi.waitFor(() => expect(roster()).not.toBe(-1));
    wire.pending.splice(roster(), 1)[0]?.respond([]);
    await flush();
  };
  /** Connects, with the roster read left unanswered. */
  const connect = () => {
    live.state({ status: "connected", routes: [] });
    live.established();
  };
  return {
    owner,
    wire,
    update,
    discover,
    reconnect,
    connect,
    receive: (events: readonly RelayEvent[]) => live.receive(events as never),
    state: (snapshot: Parameters<LiveCallbacks["state"]>[0]) =>
      live.state(snapshot),
    establish: (...args: Parameters<LiveCallbacks["established"]>) =>
      live.established(...args),
    recover: () => live.recover?.(),
  };
}
/** The relay's signed metadata and roster of a channel only `other` is in. */
const channel = (
  id: string,
  visibility: "public" | "private",
  created_at = 10,
) => [
  signed(relay, {
    kind: 39000,
    content: "",
    created_at,
    tags: [["d", id], ["name", id.slice(0, 4)], [visibility]],
  }),
  signed(relay, {
    kind: 39002,
    content: "",
    created_at,
    tags: [
      ["d", id],
      ["p", other.pubkey],
    ],
  }),
];
const asks = (filters: readonly { "#d"?: readonly string[] }[], id: string) =>
  filters.some((filter) => filter["#d"]?.includes(id));

it("keeps an attended public channel live once its metadata is read, never a private one, and drops it when stopped", async () => {
  const h = harness();
  const live = () => h.update.mock.lastCall?.[0] ?? [];
  const joined = () => h.update.mock.lastCall?.[1] ?? [];
  const stop = h.owner.session.attend([OPEN, CLOSED, "not a channel id"]);
  // Unknown until the relay's metadata is read, which waits for discovery:
  // a lookup must not stand in for it.
  await flush();
  expect(live()).not.toContain(OPEN);
  expect(h.wire.pending.some((entry) => asks(entry.filters, OPEN))).toBe(false);
  await h.discover();
  await vi.waitFor(() =>
    expect(h.wire.pending.some((entry) => asks(entry.filters, OPEN))).toBe(
      true,
    ),
  );
  const read = h.wire.pending.find((entry) => asks(entry.filters, OPEN));
  read?.respond([
    ...channel(OPEN, "public"),
    ...channel(CLOSED, "private"),
  ] as RelayEvent[]);
  await vi.waitFor(() => expect(live()).toContain(OPEN));
  await flush();
  // Live, though not joined or listed; a private channel the viewer is not
  // in is not live.
  expect(joined()).not.toContain(OPEN);
  expect(live()).not.toContain(CLOSED);
  expect(
    h.owner.session.channels.list().channels.map(({ id }) => id),
  ).not.toContain(OPEN);
  stop();
  expect(live()).not.toContain(OPEN);
});

it("says a channel is pending until its metadata is read, attended or not yet, and reads again what failed", async () => {
  const h = harness();
  const pending = () => h.owner.session.attendPending(OPEN);
  const lookup = () =>
    h.wire.pending.find(
      (entry) => !entry.signal?.aborted && asks(entry.filters, OPEN),
    );
  /** Answers the metadata read in flight, and takes it off the wire. */
  const answer = (
    respond: (entry: NonNullable<ReturnType<typeof lookup>>) => void,
  ) => {
    const entry = lookup();
    if (!entry) throw new Error("No metadata read");
    h.wire.pending.splice(h.wire.pending.indexOf(entry), 1);
    respond(entry);
  };
  // Unknown, it is pending before any `attend`, so a catch-up that starts
  // first waits too.
  expect(pending()).toBe(true);
  h.owner.session.attend([OPEN]);
  expect(pending()).toBe(true);
  await h.discover();
  await vi.waitFor(() => expect(lookup()).toBeDefined());
  // A failed read leaves it pending, and a reconnect reads it again.
  answer((entry) => entry.fail(new Error("down")));
  await flush();
  expect(pending()).toBe(true);
  expect(lookup()).toBeUndefined();
  await h.reconnect();
  await vi.waitFor(() => expect(lookup()).toBeDefined());
  // So does a wait, with no reconnect.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    answer((entry) => entry.fail(new Error("down again")));
    await vi.advanceTimersByTimeAsync(0);
    expect(lookup()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
  } finally {
    vi.useRealTimers();
  }
  await vi.waitFor(() => expect(lookup()).toBeDefined());
  expect(pending()).toBe(true);
  answer((entry) => entry.respond(channel(OPEN, "public") as RelayEvent[]));
  await vi.waitFor(() => expect(pending()).toBe(false));
});

it("gives each batch of attended channels' lookups its own read deadline, so a slow first batch does not time out the next", async () => {
  const h = harness();
  const unknown = Array.from(
    { length: 128 },
    (_, index) =>
      `55555555-5555-4555-8555-${index.toString(16).padStart(12, "0")}`,
  );
  const live = () => h.update.mock.lastCall?.[0] ?? [];
  const lookup = (id: string) =>
    h.wire.pending.find(
      (entry) => !entry.signal?.aborted && asks(entry.filters, id),
    );
  // From the start, so the reader's deadlines run on this clock.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    h.owner.session.attend([...unknown, OPEN]);
    await h.discover();
    await vi.waitFor(() => expect(lookup(unknown[0] ?? "")).toBeDefined());
    // The first batch takes 6 of the reader's 10 seconds and finds nothing.
    await vi.advanceTimersByTimeAsync(6_000);
    const first = lookup(unknown[0] ?? "");
    assert(first);
    h.wire.pending.splice(h.wire.pending.indexOf(first), 1);
    first.respond([]);
    await vi.advanceTimersByTimeAsync(0);
    // The next one still has its 10 seconds after 5 more.
    await vi.advanceTimersByTimeAsync(5_000);
    lookup(OPEN)?.respond(channel(OPEN, "public") as RelayEvent[]);
    await vi.advanceTimersByTimeAsync(0);
  } finally {
    vi.useRealTimers();
  }
  await vi.waitFor(() => expect(live()).toContain(OPEN));
});

it("reads an attended channel once while its read is in flight, through a new attendance and a retry", async () => {
  const h = harness();
  // Five batches of channels the relay never finds.
  const ids = Array.from(
    { length: 640 },
    (_, index) =>
      `66666666-6666-4666-8666-${index.toString(16).padStart(12, "0")}`,
  );
  const last = ids[512] ?? "";
  const metadata = () =>
    h.wire.pending.filter(
      (entry) =>
        !entry.signal?.aborted && entry.filters.some((filter) => filter["#d"]),
    );
  let reads = 0;
  const answer = () => {
    const [read] = metadata();
    assert(read);
    if (asks(read.filters, last)) reads += 1;
    h.wire.pending.splice(h.wire.pending.indexOf(read), 1);
    read.respond([]);
  };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    h.owner.session.attend(ids);
    await h.discover();
    await vi.waitFor(() => expect(metadata()).toHaveLength(1));
    // A new watch set attends the same channels before the old one stops.
    h.owner.session.attend(ids);
    await vi.advanceTimersByTimeAsync(0);
    // Each read takes 9 seconds. The first one's end arms the 30-second
    // retry, which fires while the last batch is still in flight.
    for (let batch = 0; batch < 5; batch += 1) {
      await vi.advanceTimersByTimeAsync(9_000);
      answer();
      await vi.advanceTimersByTimeAsync(0);
    }
    // What the retry queued: the first four batches again, not the fifth.
    while (metadata().length) {
      answer();
      await vi.advanceTimersByTimeAsync(0);
    }
  } finally {
    vi.useRealTimers();
  }
  expect(reads).toBe(1);
});

it("resolves the channels a read of every channel finds, of any kinds, once discovery is done", async () => {
  const h = harness();
  const read = () =>
    h.owner.session.read([{ kinds: [9, 7], since: 11, until: 20, limit: 16 }], {
      fresh: true,
      resolveChannels: true,
    });
  const message = signed(other, {
    kind: 9,
    content: "message",
    created_at: 15,
    tags: [["h", OPEN]],
  });
  const history = [
    message,
    signed(other, {
      kind: 7,
      content: "+",
      created_at: 16,
      tags: [
        ["h", OPEN],
        ["e", message.id],
      ],
    }),
  ] as RelayEvent[];
  await h.discover();
  const reading = read();
  await vi.waitFor(() =>
    expect(
      h.wire.pending.some((entry) =>
        entry.filters.some((filter) => filter.kinds?.includes(7)),
      ),
    ).toBe(true),
  );
  const index = h.wire.pending.findIndex((entry) =>
    entry.filters.some((filter) => filter.kinds?.includes(7)),
  );
  h.wire.pending.splice(index, 1)[0]?.respond(history);
  await vi.waitFor(() =>
    expect(h.wire.pending.some((entry) => asks(entry.filters, OPEN))).toBe(
      true,
    ),
  );
  const lookup = h.wire.pending.find((entry) => asks(entry.filters, OPEN));
  lookup?.respond(channel(OPEN, "public") as RelayEvent[]);
  expect((await reading).map(({ kind }) => kind).sort()).toEqual([7, 9]);
});

it.each([
  ["of chat, as any read of messages does, the viewer's own", [9], true],
  ["of other kinds too, only agents'", [9, 7], false],
] as const)(
  "counts a channel a read of every channel resolves %s",
  async (_, kinds, viewers) => {
    const h = harness();
    await h.discover();
    expect(h.owner.session.unattended(OPEN, false)).toBe(true);
    const reading = h.owner.session.read(
      [{ kinds: [...kinds], since: 11, until: 20, limit: 16 }],
      { fresh: true, resolveChannels: true },
    );
    const asked = () =>
      h.wire.pending.findIndex((entry) =>
        entry.filters.some((filter) => filter.kinds?.includes(9)),
      );
    await vi.waitFor(() => expect(asked()).not.toBe(-1));
    h.wire.pending.splice(asked(), 1)[0]?.respond([
      signed(other, {
        kind: 9,
        content: "message",
        created_at: 15,
        tags: [["h", OPEN]],
      }),
    ] as RelayEvent[]);
    await vi.waitFor(() =>
      expect(h.wire.pending.some((entry) => asks(entry.filters, OPEN))).toBe(
        true,
      ),
    );
    h.wire.pending
      .find((entry) => asks(entry.filters, OPEN))
      ?.respond(channel(OPEN, "public") as RelayEvent[]);
    expect(await reading).toHaveLength(1);
    // Not attended, so live says the same; catch-up reads tell them apart.
    expect(h.owner.session.unattended(OPEN, false)).toBe(viewers);
    expect(h.owner.session.unattended(OPEN, true)).toBe(viewers);
  },
);

it("counts a channel only agents' reads found as the viewer's only once the viewer's own lookup of it succeeds", async () => {
  const h = harness();
  await h.discover();
  const message = signed(other, {
    kind: 9,
    content: "message",
    created_at: 15,
    tags: [["h", OPEN]],
  }) as RelayEvent;
  /** Reads with `filter`, answers the read with the message, and answers
   * its metadata lookup with `lookup`. */
  const read = async (
    filter: Record<string, unknown>,
    resolveChannels: boolean,
    lookup: (entry: (typeof h.wire.pending)[number]) => void,
  ) => {
    const reading = h.owner.session.read([filter as never], {
      fresh: true,
      ...(resolveChannels ? { resolveChannels } : {}),
    });
    const asked = () =>
      h.wire.pending.findIndex(
        (entry) =>
          !entry.signal?.aborted &&
          entry.filters.some((item) => item.kinds?.includes(9)),
      );
    await vi.waitFor(() => expect(asked()).not.toBe(-1));
    h.wire.pending.splice(asked(), 1)[0]?.respond([message]);
    const metadata = () =>
      h.wire.pending.findIndex(
        (entry) => !entry.signal?.aborted && asks(entry.filters, OPEN),
      );
    await vi.waitFor(() => expect(metadata()).not.toBe(-1));
    const entry = h.wire.pending.splice(metadata(), 1)[0];
    if (entry) lookup(entry);
    return reading.then(
      () => "read",
      () => "failed",
    );
  };
  // An agent's read of every channel, of more than chat, finds it first.
  expect(
    await read(
      { kinds: [9, 7], since: 11, until: 20, limit: 16 },
      true,
      (entry) => entry.respond(channel(OPEN, "public") as RelayEvent[]),
    ),
  ).toBe("read");
  expect(h.owner.session.unattended(OPEN, false)).toBe(false);
  // The viewer's search finds it too, but its lookup fails: without agents,
  // the channel would still be unknown.
  expect(
    await read({ kinds: [9], search: "message", limit: 16 }, false, (entry) =>
      entry.fail(new Error("timed out")),
    ),
  ).toBe("failed");
  expect(h.owner.session.unattended(OPEN, false)).toBe(false);
  // Once a lookup of the viewer's own succeeds, it is the viewer's.
  expect(
    await read({ kinds: [9], search: "message", limit: 16 }, false, (entry) =>
      entry.respond(channel(OPEN, "public") as RelayEvent[]),
    ),
  ).toBe("read");
  expect(h.owner.session.unattended(OPEN, false)).toBe(true);
});

it("counts a channel only agents' reads found as the viewer's once a name search finds it, as without agents", async () => {
  const h = harness();
  await h.discover();
  const pending = (
    match: (entry: (typeof h.wire.pending)[number]) => boolean,
  ) =>
    h.wire.pending.findIndex((entry) => !entry.signal?.aborted && match(entry));
  const take = async (
    match: (entry: (typeof h.wire.pending)[number]) => boolean,
  ) => {
    await vi.waitFor(() => expect(pending(match)).not.toBe(-1));
    const entry = h.wire.pending.splice(pending(match), 1)[0];
    assert(entry);
    return entry;
  };
  const lookup = (entry: (typeof h.wire.pending)[number]) =>
    asks(entry.filters, OPEN);
  // An agent's read of every channel, of more than chat, finds it first.
  const reading = h.owner.session.read(
    [{ kinds: [9, 7], since: 11, until: 20, limit: 16 }],
    { fresh: true, resolveChannels: true },
  );
  (
    await take((entry) =>
      entry.filters.some((filter) => filter.kinds?.includes(9)),
    )
  ).respond([
    signed(other, {
      kind: 9,
      content: "message",
      created_at: 15,
      tags: [["h", OPEN]],
    }),
  ] as RelayEvent[]);
  (await take(lookup)).respond(channel(OPEN, "public") as RelayEvent[]);
  expect(await reading).toHaveLength(1);
  expect(h.owner.session.unattended(OPEN, false)).toBe(false);
  const search = () => {
    const found = h.owner.session.channels.searchPublic?.("3333");
    assert(found);
    return found.then(
      ({ channels }) => channels.map(({ id }) => id),
      () => "failed",
    );
  };
  const directory = (entry: (typeof h.wire.pending)[number]) =>
    entry.filters.some(
      (filter) => filter.kinds?.includes(39000) && !filter["#d"],
    );
  // The viewer's name search lists it, but its lookup fails: without agents,
  // the channel would still be unknown.
  const failing = search();
  (await take(directory)).respond(channel(OPEN, "public") as RelayEvent[]);
  (await take(lookup)).fail(new Error("timed out"));
  expect(await failing).toBe("failed");
  expect(h.owner.session.unattended(OPEN, false)).toBe(false);
  // Once the search's lookup succeeds, the channel is the viewer's, though
  // never opened.
  // It ranks the directory page already read.
  const finding = search();
  (await take(lookup)).respond(channel(OPEN, "public") as RelayEvent[]);
  expect(await finding).toEqual([OPEN]);
  expect(h.owner.session.unattended(OPEN, false)).toBe(true);
});

it("counts an attended channel the viewer has not joined or opened as heard only for agents, live and read", async () => {
  const h = harness();
  const stop = h.owner.session.attend([OPEN]);
  await h.discover();
  await vi.waitFor(() =>
    expect(h.wire.pending.some((entry) => asks(entry.filters, OPEN))).toBe(
      true,
    ),
  );
  h.wire.pending
    .find((entry) => asks(entry.filters, OPEN))
    ?.respond(channel(OPEN, "public") as RelayEvent[]);
  await vi.waitFor(() =>
    expect(h.update.mock.lastCall?.[0] ?? []).toContain(OPEN),
  );
  expect(h.owner.session.unattended(OPEN, true)).toBe(false);
  // Its metadata came only from the attendance's lookup.
  expect(h.owner.session.unattended(OPEN, false)).toBe(false);
  // A channel no agent attends is heard as without attendance.
  expect(h.owner.session.unattended(CLOSED, true)).toBe(true);
  stop();
});

it("counts a joined channel that agents also attend as heard for the viewer, live and read", async () => {
  const h = harness();
  const joined = () => h.update.mock.lastCall?.[1] ?? [];
  h.connect();
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  h.wire.next().respond([
    signed(relay, {
      kind: 39000,
      content: "",
      created_at: 10,
      tags: [["d", OPEN], ["name", "open"], ["public"]],
    }),
    signed(relay, {
      kind: 39002,
      content: "",
      created_at: 10,
      tags: [
        ["d", OPEN],
        ["p", viewer.pubkey],
      ],
    }),
  ] as RelayEvent[]);
  await vi.waitFor(() => expect(joined()).toContain(OPEN));
  const stop = h.owner.session.attend([OPEN]);
  await flush();
  // Known already, so attendance reads nothing; the live routes carry it for
  // the viewer as without attendance, so a live mention is heard as on main.
  expect(
    h.wire.pending.some(
      (entry) => !entry.signal?.aborted && asks(entry.filters, OPEN),
    ),
  ).toBe(false);
  expect(h.owner.session.unattended(OPEN, true)).toBe(true);
  expect(h.owner.session.unattended(OPEN, false)).toBe(true);
  stop();
});

it("counts an attended channel its read did not find as the viewer's once a link's lookup of it succeeds", async () => {
  const h = harness();
  const stop = h.owner.session.attend([OPEN]);
  await h.discover();
  const lookup = () =>
    h.wire.pending.findIndex(
      (entry) => !entry.signal?.aborted && asks(entry.filters, OPEN),
    );
  await vi.waitFor(() => expect(lookup()).not.toBe(-1));
  // Attendance's read finds nothing the viewer may read.
  h.wire.pending.splice(lookup(), 1)[0]?.respond([]);
  await flush();
  expect(h.owner.session.channels.get?.(OPEN)?.pending ?? true).toBe(true);
  expect(h.owner.session.unattended(OPEN, false)).toBe(false);
  // A link to it mounts, and the viewer's own lookup finds it public.
  const release = h.owner.session.channels.refer?.(OPEN);
  await vi.waitFor(() => expect(lookup()).not.toBe(-1));
  h.wire.pending
    .splice(lookup(), 1)[0]
    ?.respond(channel(OPEN, "public") as RelayEvent[]);
  await vi.waitFor(() =>
    expect(h.owner.session.channels.get?.(OPEN)).toBeDefined(),
  );
  expect(h.owner.session.unattended(OPEN, false)).toBe(true);
  release?.();
  stop();
});

it("counts a channel only agents' reads found as the viewer's once a link to it mounts, with no lookup", async () => {
  const h = harness();
  await h.discover();
  const reading = h.owner.session.read(
    [{ kinds: [9, 7], since: 11, until: 20, limit: 16 }],
    { fresh: true, resolveChannels: true },
  );
  const asked = () =>
    h.wire.pending.findIndex((entry) =>
      entry.filters.some((filter) => filter.kinds?.includes(9)),
    );
  await vi.waitFor(() => expect(asked()).not.toBe(-1));
  h.wire.pending.splice(asked(), 1)[0]?.respond([
    signed(other, {
      kind: 9,
      content: "message",
      created_at: 15,
      tags: [["h", OPEN]],
    }),
  ] as RelayEvent[]);
  await vi.waitFor(() =>
    expect(h.wire.pending.some((entry) => asks(entry.filters, OPEN))).toBe(
      true,
    ),
  );
  h.wire.pending
    .find((entry) => asks(entry.filters, OPEN))
    ?.respond(channel(OPEN, "public") as RelayEvent[]);
  expect(await reading).toHaveLength(1);
  expect(h.owner.session.unattended(OPEN, false)).toBe(false);
  // Without agents, the link's lookup would have made it known; here it is
  // already, so nothing is read.
  const release = h.owner.session.channels.refer?.(OPEN);
  await flush();
  expect(
    h.wire.pending.some(
      (entry) => !entry.signal?.aborted && asks(entry.filters, OPEN),
    ),
  ).toBe(false);
  expect(h.owner.session.unattended(OPEN, false)).toBe(true);
  release?.();
});

it("counts a channel only agents' reads found as the viewer's once a scoped search's lookup of it succeeds", async () => {
  const h = harness();
  await h.discover();
  const reading = h.owner.session.read(
    [{ kinds: [9, 7], since: 11, until: 20, limit: 16 }],
    { fresh: true, resolveChannels: true },
  );
  const lookup = () =>
    h.wire.pending.findIndex(
      (entry) => !entry.signal?.aborted && asks(entry.filters, OPEN),
    );
  const asked = () =>
    h.wire.pending.findIndex((entry) =>
      entry.filters.some((filter) => filter.kinds?.includes(9)),
    );
  await vi.waitFor(() => expect(asked()).not.toBe(-1));
  h.wire.pending.splice(asked(), 1)[0]?.respond([
    signed(other, {
      kind: 9,
      content: "message",
      created_at: 15,
      tags: [["h", OPEN]],
    }),
  ] as RelayEvent[]);
  await vi.waitFor(() => expect(lookup()).not.toBe(-1));
  h.wire.pending
    .splice(lookup(), 1)[0]
    ?.respond(channel(OPEN, "public") as RelayEvent[]);
  expect(await reading).toHaveLength(1);
  expect(h.owner.session.unattended(OPEN, false)).toBe(false);
  // `in:<id>` search resolves the channel itself before its read. A failed
  // lookup leaves it as it was.
  const search = () =>
    (h.owner.session.channels.resolve?.([OPEN]) ?? Promise.resolve()).then(
      () => "read",
      () => "failed",
    );
  const failing = search();
  await vi.waitFor(() => expect(lookup()).not.toBe(-1));
  h.wire.pending.splice(lookup(), 1)[0]?.fail(new Error("timed out"));
  expect(await failing).toBe("failed");
  expect(h.owner.session.unattended(OPEN, false)).toBe(false);
  const finding = search();
  await vi.waitFor(() => expect(lookup()).not.toBe(-1));
  h.wire.pending
    .splice(lookup(), 1)[0]
    ?.respond(channel(OPEN, "public") as RelayEvent[]);
  expect(await finding).toBe("read");
  expect(h.owner.session.unattended(OPEN, false)).toBe(true);
});

it("keeps an attended channel heard only for agents when a recheck after an access-revoked CLOSED finds it public again", async () => {
  const h = harness();
  const stop = h.owner.session.attend([OPEN]);
  await h.discover();
  const lookup = () =>
    h.wire.pending.findIndex(
      (entry) => !entry.signal?.aborted && asks(entry.filters, OPEN),
    );
  await vi.waitFor(() => expect(lookup()).not.toBe(-1));
  h.wire.pending
    .splice(lookup(), 1)[0]
    ?.respond(channel(OPEN, "public") as RelayEvent[]);
  await vi.waitFor(() =>
    expect(h.update.mock.lastCall?.[0] ?? []).toContain(OPEN),
  );
  expect(h.owner.session.unattended(OPEN, false)).toBe(false);
  h.state({
    status: "connected",
    routes: [
      {
        id: "attended",
        channelId: OPEN,
        status: "error",
        replay: "unknown",
        error: "restricted: channel access revoked",
      },
    ],
  });
  // The recheck, and attendance's own read of the suspended channel, find it
  // public again; the viewer has still not looked it up.
  await vi.waitFor(() => expect(lookup()).not.toBe(-1));
  await flush();
  expect(
    h.wire.pending.filter((entry) => asks(entry.filters, OPEN)),
  ).toHaveLength(2);
  while (lookup() !== -1)
    h.wire.pending
      .splice(lookup(), 1)[0]
      ?.respond(channel(OPEN, "public") as RelayEvent[]);
  await flush();
  expect(h.owner.session.channels.get?.(OPEN)).toBeDefined();
  expect(h.owner.session.unattended(OPEN, false)).toBe(false);
  stop();
});

it("does not answer a read of every channel that resolves its channels before discovery, rather than drop what it cannot place", async () => {
  const h = harness();
  // Discovery has not succeeded: its roster read failed.
  h.connect();
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  h.wire.next().fail(new Error("down"));
  await vi.waitFor(() =>
    expect(h.owner.session.channels.list().status).not.toBe("ready"),
  );
  let settled = false;
  void h.owner.session
    .read([{ kinds: [7], since: 11, until: 20, limit: 16 }], {
      fresh: true,
      resolveChannels: true,
    })
    .finally(() => {
      settled = true;
    })
    .catch(() => {});
  const reads = () =>
    h.wire.pending.findIndex((entry) =>
      entry.filters.some((filter) => filter.kinds?.includes(7)),
    );
  await vi.waitFor(() => expect(reads()).not.toBe(-1));
  h.wire.pending.splice(reads(), 1)[0]?.respond([]);
  await flush();
  await flush();
  // It is tried again later, not answered empty.
  expect(settled).toBe(false);
});

it("reads again a channel found unreadable, holding it pending, and keeps it live once it turns public", async () => {
  const h = harness();
  const live = () => h.update.mock.lastCall?.[0] ?? [];
  const pending = () => h.owner.session.attendPending(OPEN);
  const lookup = () =>
    h.wire.pending.find(
      (entry) => !entry.signal?.aborted && asks(entry.filters, OPEN),
    );
  const answer = (events: readonly unknown[]) => {
    const entry = lookup();
    if (!entry) throw new Error("No metadata read");
    h.wire.pending.splice(h.wire.pending.indexOf(entry), 1);
    entry.respond(events as RelayEvent[]);
  };
  h.owner.session.attend([OPEN]);
  await h.discover();
  await vi.waitFor(() => expect(lookup()).toBeDefined());
  // Private, and the viewer is not in it: nothing it can read yet. It stays
  // pending, so catch-up keeps its checkpoint, and a reconnect reads it again.
  answer(channel(OPEN, "private"));
  await flush();
  expect(pending()).toBe(true);
  expect(lookup()).toBeUndefined();
  await h.reconnect();
  await vi.waitFor(() => expect(lookup()).toBeDefined());
  // So does a wait, with no reconnect: the relay may have no answer at all.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    answer([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(pending()).toBe(true);
    expect(lookup()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
  } finally {
    vi.useRealTimers();
  }
  await vi.waitFor(() => expect(lookup()).toBeDefined());
  expect(pending()).toBe(true);
  // Now public, by newer metadata: known, and live.
  answer(channel(OPEN, "public", 20));
  await vi.waitFor(() => expect(pending()).toBe(false));
  await vi.waitFor(() => expect(live()).toContain(OPEN));
});

it("reads again a channel that newer metadata makes private, at once and then after a growing wait, and hears it once it is public again", async () => {
  const h = harness();
  const live = () => h.update.mock.lastCall?.[0] ?? [];
  const pending = () => h.owner.session.attendPending(OPEN);
  const lookup = () =>
    h.wire.pending.find(
      (entry) => !entry.signal?.aborted && asks(entry.filters, OPEN),
    );
  const answer = (events: readonly unknown[]) => {
    const entry = lookup();
    if (!entry) throw new Error("No metadata read");
    h.wire.pending.splice(h.wire.pending.indexOf(entry), 1);
    entry.respond(events as RelayEvent[]);
  };
  h.owner.session.attend([OPEN]);
  await h.discover();
  await vi.waitFor(() => expect(lookup()).toBeDefined());
  answer(channel(OPEN, "public"));
  await vi.waitFor(() => expect(live()).toContain(OPEN));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    // Newer metadata makes it private: it leaves the live routes, and its
    // metadata is read again at once.
    h.receive(channel(OPEN, "private", 20) as RelayEvent[]);
    await vi.advanceTimersByTimeAsync(0);
    expect(pending()).toBe(true);
    expect(live()).not.toContain(OPEN);
    expect(lookup()).toBeDefined();
    // Still private: read again after 30 s, then after 60 s.
    answer(channel(OPEN, "private", 20));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(lookup()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(lookup()).toBeDefined();
    answer(channel(OPEN, "private", 20));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(lookup()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(lookup()).toBeDefined();
    // Public again: known, and live.
    answer(channel(OPEN, "public", 30));
    await vi.advanceTimersByTimeAsync(0);
  } finally {
    vi.useRealTimers();
  }
  await vi.waitFor(() => expect(pending()).toBe(false));
  await vi.waitFor(() => expect(live()).toContain(OPEN));
});

it("leaves to the live owner, which batches joined channels, whether an attended channel fits", async () => {
  const h = harness();
  const live = () => h.update.mock.lastCall?.[0] ?? [];
  const joined = () => h.update.mock.lastCall?.[1] ?? [];
  // 1,020 joined channels share one wire of up to 2,048, so a wire is free
  // for a public channel the viewer has not joined.
  const ids = Array.from({ length: 1_020 }, (_, i) => `joined-${i}`);
  h.connect();
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  h.wire.next().respond(
    ids.flatMap((id) => [
      signed(relay, {
        kind: 39000,
        content: "",
        created_at: 10,
        tags: [["d", id], ["name", id], ["private"]],
      }),
      signed(relay, {
        kind: 39002,
        content: "",
        created_at: 10,
        tags: [
          ["d", id],
          ["p", viewer.pubkey],
        ],
      }),
    ]) as RelayEvent[],
  );
  await vi.waitFor(() => expect(joined()).toHaveLength(1_020));
  h.owner.session.attend([OPEN]);
  const read = () =>
    h.wire.pending.find(
      (entry) => !entry.signal?.aborted && asks(entry.filters, OPEN),
    );
  await vi.waitFor(() => expect(read()).toBeDefined());
  read()?.respond(channel(OPEN, "public") as RelayEvent[]);
  await vi.waitFor(() => expect(live()).toContain(OPEN));
  expect(joined()).not.toContain(OPEN);
}, 30_000);

it("reads unknown attended channels one batch at a time, in the background lane", async () => {
  const h = harness();
  const ids = Array.from(
    { length: 257 },
    (_, i) => `attended-${i.toString().padStart(3, "0")}`,
  );
  const lookups = () =>
    h.wire.pending.filter(
      (entry) =>
        !entry.signal?.aborted && ids.some((id) => asks(entry.filters, id)),
    );
  await h.discover();
  h.owner.session.attend(ids);
  await vi.waitFor(() => expect(lookups()).toHaveLength(1));
  await flush();
  // Three batches, but only one background read at a time: the rest of the
  // reader stays free for what the owner opens.
  expect(lookups()).toHaveLength(1);
});

it("counts a joined channel's metadata as only saved from a stream drop until discovery reads it again", async () => {
  const h = harness();
  const metadata = (visibility: "public" | "private", created_at: number) =>
    signed(relay, {
      kind: 39000,
      content: "",
      created_at,
      tags: [["d", OPEN], ["name", "open"], [visibility]],
    });
  const roster = signed(relay, {
    kind: 39002,
    content: "",
    created_at: 10,
    tags: [
      ["d", OPEN],
      ["p", viewer.pubkey],
    ],
  });
  const summary = () => h.owner.session.channels.get?.(OPEN);
  const take = async (
    match: (entry: (typeof h.wire.pending)[number]) => boolean,
  ) => {
    const index = () =>
      h.wire.pending.findIndex(
        (entry) => !entry.signal?.aborted && match(entry),
      );
    await vi.waitFor(() => expect(index()).not.toBe(-1));
    const entry = h.wire.pending.splice(index(), 1)[0];
    assert(entry);
    return entry;
  };
  h.connect();
  (await take(() => true)).respond([
    metadata("public", 10),
    roster,
  ] as RelayEvent[]);
  await vi.waitFor(() => expect(summary()?.visibility).toBe("public"));
  expect(summary()?.metadataCached).toBeUndefined();
  // The channel may turn private while the stream is down, and the replay
  // can arrive before discovery reads it: its public grant is only saved.
  h.state({ status: "retrying", routes: [] });
  expect(summary()?.metadataCached).toBe(true);
  h.connect();
  (
    await take((entry) => !entry.filters.some((filter) => filter["#d"]))
  ).respond([roster] as RelayEvent[]);
  // Discovery reads it again, and that read decides.
  (await take((entry) => asks(entry.filters, OPEN))).respond([
    metadata("private", 11),
  ] as RelayEvent[]);
  await vi.waitFor(() => expect(summary()?.visibility).toBe("private"));
  expect(summary()?.metadataCached).toBeUndefined();
});

it("keeps a channel the viewer looked up heard for the viewer when a recheck after an access-revoked CLOSED finds it public again", async () => {
  const h = harness();
  await h.discover();
  const lookup = () =>
    h.wire.pending.findIndex(
      (entry) => !entry.signal?.aborted && asks(entry.filters, OPEN),
    );
  // The viewer's own lookup, for a link since unmounted, finds it before
  // agents attend it.
  const release = h.owner.session.channels.refer?.(OPEN);
  await vi.waitFor(() => expect(lookup()).not.toBe(-1));
  h.wire.pending
    .splice(lookup(), 1)[0]
    ?.respond(channel(OPEN, "public") as RelayEvent[]);
  await vi.waitFor(() =>
    expect(h.owner.session.channels.get?.(OPEN)).toBeDefined(),
  );
  release?.();
  const stop = h.owner.session.attend([OPEN]);
  await vi.waitFor(() =>
    expect(h.update.mock.lastCall?.[0] ?? []).toContain(OPEN),
  );
  expect(h.owner.session.unattended(OPEN, false)).toBe(true);
  h.state({
    status: "connected",
    routes: [
      {
        id: "attended",
        channelId: OPEN,
        status: "error",
        replay: "unknown",
        error: "restricted: channel access revoked",
      },
    ],
  });
  // The recheck, and attendance's own read of the suspended channel, find it
  // public again; neither is news to the viewer.
  await vi.waitFor(() => expect(lookup()).not.toBe(-1));
  await flush();
  while (lookup() !== -1)
    h.wire.pending
      .splice(lookup(), 1)[0]
      ?.respond(channel(OPEN, "public") as RelayEvent[]);
  await flush();
  expect(h.owner.session.channels.get?.(OPEN)).toBeDefined();
  expect(h.owner.session.unattended(OPEN, false)).toBe(true);
  stop();
});

it("skips the queued lookups of attended channels no watch wants any more, so a new watch's lookup does not wait behind them", async () => {
  const h = harness();
  // Five batches of channels the relay never finds.
  const ids = Array.from(
    { length: 640 },
    (_, index) =>
      `77777777-7777-4777-8777-${index.toString(16).padStart(12, "0")}`,
  );
  const metadata = () =>
    h.wire.pending.filter(
      (entry) =>
        !entry.signal?.aborted && entry.filters.some((filter) => filter["#d"]),
    );
  await h.discover();
  const stop = h.owner.session.attend(ids);
  await vi.waitFor(() => expect(metadata()).toHaveLength(1));
  // The watch set changes while the first batch is in flight.
  stop();
  const next = h.owner.session.attend([OPEN]);
  await flush();
  const [first] = metadata();
  assert(first);
  expect(asks(first.filters, ids[0] ?? "")).toBe(true);
  h.wire.pending.splice(h.wire.pending.indexOf(first), 1);
  first.respond([]);
  // The next read is the new watch's, not the withdrawn batches'.
  await vi.waitFor(() => expect(metadata()).toHaveLength(1));
  const [after] = metadata();
  assert(after);
  expect(asks(after.filters, OPEN)).toBe(true);
  expect(ids.some((id) => asks(after.filters, id))).toBe(false);
  after.respond(channel(OPEN, "public") as RelayEvent[]);
  await vi.waitFor(() =>
    expect(h.update.mock.lastCall?.[0] ?? []).toContain(OPEN),
  );
  next();
});

it("reads again a joined channel's metadata a drop left unconfirmed when the membership replay resumes without a gap, and through recovery if that read fails", async () => {
  const h = harness();
  const metadata = (visibility: "public" | "private", created_at: number) =>
    signed(relay, {
      kind: 39000,
      content: "",
      created_at,
      tags: [["d", OPEN], ["name", "open"], [visibility]],
    });
  const roster = signed(relay, {
    kind: 39002,
    content: "",
    created_at: 10,
    tags: [
      ["d", OPEN],
      ["p", viewer.pubkey],
    ],
  });
  const summary = () => h.owner.session.channels.get?.(OPEN);
  const live = (match: (entry: (typeof h.wire.pending)[number]) => boolean) =>
    h.wire.pending.findIndex((entry) => !entry.signal?.aborted && match(entry));
  h.connect();
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  h.wire.next().respond([metadata("public", 10), roster] as RelayEvent[]);
  await vi.waitFor(() => expect(summary()?.visibility).toBe("public"));
  h.state({ status: "retrying", routes: [] });
  expect(summary()?.metadataCached).toBe(true);
  h.state({ status: "connected", routes: [] });
  // The replay resumed without a gap, so the roster is not read again; the
  // unconfirmed metadata still is, alone.
  h.establish(undefined, { route: "membership", continuous: true });
  const lookup = (entry: (typeof h.wire.pending)[number]) =>
    asks(entry.filters, OPEN) &&
    entry.filters.every((filter) => filter.kinds?.includes(39000));
  await vi.waitFor(() => expect(live(lookup)).not.toBe(-1));
  expect(live((entry) => !entry.filters.some((filter) => filter["#d"]))).toBe(
    -1,
  );
  // The first read fails while the socket stays up: the confirmation is
  // owed to recovery, whose next tick reads again through discovery.
  h.wire.pending.splice(live(lookup), 1)[0]?.fail(new Error("timed out"));
  await flush();
  expect(summary()?.metadataCached).toBe(true);
  h.recover();
  const rosterRead = (entry: (typeof h.wire.pending)[number]) =>
    !entry.filters.some((filter) => filter["#d"]);
  await vi.waitFor(() => expect(live(rosterRead)).not.toBe(-1));
  h.wire.pending
    .splice(live(rosterRead), 1)[0]
    ?.respond([roster] as RelayEvent[]);
  await vi.waitFor(() => expect(live(lookup)).not.toBe(-1));
  h.wire.pending
    .splice(live(lookup), 1)[0]
    ?.respond([metadata("public", 10)] as RelayEvent[]);
  await vi.waitFor(() => expect(summary()?.metadataCached).toBeUndefined());
  expect(summary()?.visibility).toBe("public");
  // Confirmed, so the next tick owes no read.
  h.recover();
  await flush();
  expect(live(rosterRead)).toBe(-1);
});

it("keeps the agents-only mark another agents' read set on a channel whose queued attendance batch is skipped", async () => {
  const h = harness();
  // A batch of channels the relay never finds runs first.
  const ids = Array.from(
    { length: 128 },
    (_, index) =>
      `88888888-8888-4888-8888-${index.toString(16).padStart(12, "0")}`,
  );
  const pending = (
    match: (entry: (typeof h.wire.pending)[number]) => boolean,
  ) =>
    h.wire.pending.findIndex((entry) => !entry.signal?.aborted && match(entry));
  const take = async (
    match: (entry: (typeof h.wire.pending)[number]) => boolean,
  ) => {
    await vi.waitFor(() => expect(pending(match)).not.toBe(-1));
    const entry = h.wire.pending.splice(pending(match), 1)[0];
    assert(entry);
    return entry;
  };
  await h.discover();
  const first = h.owner.session.attend(ids);
  const firstBatch = await take((entry) => asks(entry.filters, ids[0] ?? ""));
  // OPEN's batch queues behind it.
  const stop = h.owner.session.attend([OPEN]);
  await flush();
  // An agent's read of every channel, of more than chat, finds OPEN and
  // waits for its metadata.
  const reading = h.owner.session.read(
    [{ kinds: [9, 7], since: 11, until: 20, limit: 16 }],
    { fresh: true, resolveChannels: true },
  );
  (
    await take((entry) =>
      entry.filters.some((filter) => filter.kinds?.includes(9)),
    )
  ).respond([
    signed(other, {
      kind: 9,
      content: "message",
      created_at: 15,
      tags: [["h", OPEN]],
    }),
  ] as RelayEvent[]);
  const broad = await take((entry) => asks(entry.filters, OPEN));
  // OPEN's attendance is withdrawn, and its queued batch is skipped.
  stop();
  firstBatch.respond([]);
  await flush();
  expect(pending((entry) => asks(entry.filters, OPEN))).toBe(-1);
  broad.respond(channel(OPEN, "public") as RelayEvent[]);
  expect(await reading).toHaveLength(1);
  // Only agents' reads found it; the viewer never looked it up.
  expect(h.owner.session.unattended(OPEN, false)).toBe(false);
  first();
});

it("counts a public preview's metadata as only saved from a stream drop until discovery reads it again, though the viewer has not joined", async () => {
  const h = harness();
  const summary = () => h.owner.session.channels.get?.(OPEN);
  const lookup = () =>
    h.wire.pending.findIndex(
      (entry) => !entry.signal?.aborted && asks(entry.filters, OPEN),
    );
  await h.discover();
  const stop = h.owner.session.attend([OPEN]);
  await vi.waitFor(() => expect(lookup()).not.toBe(-1));
  h.wire.pending
    .splice(lookup(), 1)[0]
    ?.respond(channel(OPEN, "public") as RelayEvent[]);
  await vi.waitFor(() => expect(summary()?.visibility).toBe("public"));
  expect(summary()?.metadataCached).toBeUndefined();
  // It may turn private while the stream is down, with the viewer added, so
  // the owner's catch-up can return its new messages before a read decides.
  h.state({ status: "retrying", routes: [] });
  expect(summary()?.metadataCached).toBe(true);
  // Discovery's roster read never returns a channel the viewer has not
  // joined, so its metadata step reads this one by itself.
  await h.reconnect();
  await vi.waitFor(() => expect(lookup()).not.toBe(-1));
  expect(summary()?.metadataCached).toBe(true);
  h.wire.pending
    .splice(lookup(), 1)[0]
    ?.respond([channel(OPEN, "private", 11)[0]] as RelayEvent[]);
  await vi.waitFor(() => expect(summary()?.visibility).not.toBe("public"));
  stop();
});

it("owes a discovery when a revocation elsewhere cancels the read confirming metadata a drop left unconfirmed", async () => {
  const h = harness();
  const OTHER = "55555555-5555-4555-8555-555555555555";
  const joined = (id: string, created_at = 10, members = [viewer.pubkey]) => [
    signed(relay, {
      kind: 39000,
      content: "",
      created_at: 10,
      tags: [["d", id], ["name", id.slice(0, 4)], ["public"]],
    }),
    signed(relay, {
      kind: 39002,
      content: "",
      created_at,
      tags: [["d", id], ...members.map((member) => ["p", member])],
    }),
  ];
  const summary = () => h.owner.session.channels.get?.(OPEN);
  const live = (match: (entry: (typeof h.wire.pending)[number]) => boolean) =>
    h.wire.pending.findIndex((entry) => !entry.signal?.aborted && match(entry));
  const confirmation = (entry: (typeof h.wire.pending)[number]) =>
    asks(entry.filters, OPEN);
  const rosterRead = (entry: (typeof h.wire.pending)[number]) =>
    !entry.filters.some((filter) => filter["#d"]);
  h.connect();
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  h.wire.next().respond([...joined(OPEN), ...joined(OTHER)] as RelayEvent[]);
  await vi.waitFor(() => expect(summary()?.visibility).toBe("public"));
  h.state({ status: "retrying", routes: [] });
  h.state({ status: "connected", routes: [] });
  h.establish(undefined, { route: "membership", continuous: true });
  await vi.waitFor(() => expect(live(confirmation)).not.toBe(-1));
  // The viewer leaves the other channel, and that revocation cancels the
  // confirmation in flight: OPEN's metadata stays unconfirmed.
  h.receive([joined(OTHER, 11, [other.pubkey])[1]] as RelayEvent[]);
  await vi.waitFor(() => expect(live(confirmation)).toBe(-1));
  await flush();
  expect(summary()?.metadataCached).toBe(true);
  expect(live(rosterRead)).toBe(-1);
  // Recovery's next tick reads it again through discovery.
  h.recover();
  await vi.waitFor(() => expect(live(rosterRead)).not.toBe(-1));
  h.wire.pending
    .splice(live(rosterRead), 1)[0]
    ?.respond([joined(OPEN)[1]] as RelayEvent[]);
  await vi.waitFor(() => expect(live(confirmation)).not.toBe(-1));
  h.wire.pending
    .splice(live(confirmation), 1)[0]
    ?.respond([joined(OPEN)[0]] as RelayEvent[]);
  await vi.waitFor(() => expect(summary()?.metadataCached).toBeUndefined());
});

it("keeps a channel the viewer looked up heard for the viewer when agents read it while newer metadata makes it private", async () => {
  const h = harness();
  await h.discover();
  const lookup = () =>
    h.wire.pending.findIndex(
      (entry) => !entry.signal?.aborted && asks(entry.filters, OPEN),
    );
  const release = h.owner.session.channels.refer?.(OPEN);
  await vi.waitFor(() => expect(lookup()).not.toBe(-1));
  h.wire.pending
    .splice(lookup(), 1)[0]
    ?.respond(channel(OPEN, "public") as RelayEvent[]);
  await vi.waitFor(() =>
    expect(h.owner.session.channels.get?.(OPEN)).toBeDefined(),
  );
  release?.();
  // Newer signed metadata makes it private, so it is not readable now.
  h.receive([channel(OPEN, "private", 11)[0]] as RelayEvent[]);
  await vi.waitFor(() =>
    expect(h.owner.session.channels.get?.(OPEN)?.visibility).not.toBe("public"),
  );
  // Agents attend it while it is private; it turns public again.
  const stop = h.owner.session.attend([OPEN]);
  await vi.waitFor(() => expect(lookup()).not.toBe(-1));
  h.wire.pending
    .splice(lookup(), 1)[0]
    ?.respond(channel(OPEN, "public", 12) as RelayEvent[]);
  await vi.waitFor(() =>
    expect(h.owner.session.channels.get?.(OPEN)?.visibility).toBe("public"),
  );
  // The viewer found it first, so it is not news only to agents.
  expect(h.owner.session.unattended(OPEN, false)).toBe(true);
  stop();
});

it("keeps a suspended preview the viewer looked up heard for the viewer when a read of every channel resolves it", async () => {
  const h = harness();
  await h.discover();
  const lookup = () =>
    h.wire.pending.findIndex(
      (entry) => !entry.signal?.aborted && asks(entry.filters, OPEN),
    );
  const release = h.owner.session.channels.refer?.(OPEN);
  await vi.waitFor(() => expect(lookup()).not.toBe(-1));
  h.wire.pending
    .splice(lookup(), 1)[0]
    ?.respond(channel(OPEN, "public") as RelayEvent[]);
  await vi.waitFor(() =>
    expect(h.owner.session.channels.get?.(OPEN)).toBeDefined(),
  );
  release?.();
  const stop = h.owner.session.attend([OPEN]);
  await vi.waitFor(() =>
    expect(h.update.mock.lastCall?.[0] ?? []).toContain(OPEN),
  );
  // The relay closes it; the recheck is left in flight.
  h.state({
    status: "connected",
    routes: [
      {
        id: "attended",
        channelId: OPEN,
        status: "error",
        replay: "unknown",
        error: "restricted: channel access revoked",
      },
    ],
  });
  await vi.waitFor(() => expect(lookup()).not.toBe(-1));
  expect(h.owner.session.channels.get?.(OPEN)).toBeUndefined();
  // An agents' read of every channel, of more than chat, finds it suspended.
  const reading = h.owner.session.read(
    [{ kinds: [9, 7], since: 11, until: 20, limit: 16 }],
    { fresh: true, resolveChannels: true },
  );
  const chat = () =>
    h.wire.pending.findIndex(
      (entry) =>
        !entry.signal?.aborted &&
        entry.filters.some((filter) => filter.kinds?.includes(9)),
    );
  await vi.waitFor(() => expect(chat()).not.toBe(-1));
  h.wire.pending.splice(chat(), 1)[0]?.respond([
    signed(other, {
      kind: 9,
      content: "message",
      created_at: 15,
      tags: [["h", OPEN]],
    }),
  ] as RelayEvent[]);
  await flush();
  // Every lookup finds it public again.
  while (lookup() !== -1)
    h.wire.pending
      .splice(lookup(), 1)[0]
      ?.respond(channel(OPEN, "public") as RelayEvent[]);
  await reading;
  await flush();
  expect(h.owner.session.channels.get?.(OPEN)).toBeDefined();
  expect(h.owner.session.unattended(OPEN, false)).toBe(true);
  stop();
});

it("stops counting an attended preview's saved grant once a read after a drop omits it, and hears it once a later lookup finds it public again", async () => {
  for (const continuous of [false, true]) {
    const h = harness();
    const summary = () => h.owner.session.channels.get?.(OPEN);
    const lookup = () =>
      h.wire.pending.findIndex(
        (entry) => !entry.signal?.aborted && asks(entry.filters, OPEN),
      );
    const answer = (events: readonly unknown[]) => {
      const index = lookup();
      if (index === -1) throw new Error("No metadata read");
      h.wire.pending.splice(index, 1)[0]?.respond(events as RelayEvent[]);
    };
    await h.discover();
    const stop = h.owner.session.attend([OPEN]);
    await vi.waitFor(() => expect(lookup()).not.toBe(-1));
    answer(channel(OPEN, "public"));
    await vi.waitFor(() => expect(summary()?.visibility).toBe("public"));
    // Private while the stream is down: the read after it omits it.
    if (continuous) {
      h.state({ status: "retrying", routes: [] });
      h.state({ status: "connected", routes: [] });
      h.establish(undefined, { route: "membership", continuous: true });
    } else await h.reconnect();
    await vi.waitFor(() => expect(lookup()).not.toBe(-1));
    expect(summary()?.metadataCached).toBe(true);
    answer([]);
    // Missing evidence keeps no saved grant: unknown, so attendance reads
    // it again, at once or after its wait.
    await vi.waitFor(() => expect(summary()).toBeUndefined());
    expect(h.owner.session.attendPending(OPEN)).toBe(true);
    await flush();
    if (lookup() === -1) {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        await vi.advanceTimersByTimeAsync(30_000);
      } finally {
        vi.useRealTimers();
      }
    }
    await vi.waitFor(() => expect(lookup()).not.toBe(-1));
    answer(channel(OPEN, "public", 12));
    await vi.waitFor(() => expect(summary()?.visibility).toBe("public"));
    expect(summary()?.metadataCached).toBeUndefined();
    stop();
    h.owner.dispose();
  }
});

it("keeps an attended preview that newer metadata or a membership reaches while a later batch of the read after a drop is in flight", async () => {
  // The viewer joins enough channels that a confirmation needs two batches.
  // Signed once: the two cases share them.
  const joined = Array.from({ length: 500 }, (_, i) => {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    return [
      signed(relay, {
        kind: 39000,
        content: "",
        created_at: 10,
        tags: [["d", id], ["name", id.slice(-4)], ["public"]],
      }),
      signed(relay, {
        kind: 39002,
        content: "",
        created_at: 10,
        tags: [
          ["d", id],
          ["p", viewer.pubkey],
        ],
      }),
    ];
  }).flat() as RelayEvent[];
  for (const arrival of ["metadata", "membership"] as const) {
    const h = harness();
    const summary = () => h.owner.session.channels.get?.(OPEN);
    const live = (match: (entry: (typeof h.wire.pending)[number]) => boolean) =>
      h.wire.pending.findIndex(
        (entry) => !entry.signal?.aborted && match(entry),
      );
    const metadataRead = (entry: (typeof h.wire.pending)[number]) =>
      entry.filters.some((filter) => filter["#d"]);
    await h.discover();
    const stop = h.owner.session.attend([OPEN]);
    await vi.waitFor(() =>
      expect(live((entry) => asks(entry.filters, OPEN))).not.toBe(-1),
    );
    h.wire.pending
      .splice(
        live((entry) => asks(entry.filters, OPEN)),
        1,
      )[0]
      ?.respond(channel(OPEN, "public") as RelayEvent[]);
    await vi.waitFor(() => expect(summary()?.visibility).toBe("public"));
    // The preview, saved first, is in the first batch.
    h.receive(joined);
    await flush();
    while (live(() => true) !== -1)
      h.wire.pending
        .splice(
          live(() => true),
          1,
        )[0]
        ?.respond([]);
    await flush();
    h.state({ status: "retrying", routes: [] });
    h.state({ status: "connected", routes: [] });
    h.establish(undefined, { route: "membership", continuous: true });
    await vi.waitFor(() => expect(live(metadataRead)).not.toBe(-1));
    const first = h.wire.pending.splice(live(metadataRead), 1)[0];
    expect(first && asks(first.filters, OPEN)).toBe(true);
    // The first batch omits the preview.
    first?.respond([]);
    await vi.waitFor(() => expect(live(metadataRead)).not.toBe(-1));
    // Before the second batch answers, the preview turns public in newer
    // metadata, or the viewer joins it as a guest, which leaves it read-only.
    h.receive(
      arrival === "metadata"
        ? [channel(OPEN, "public", 12)[0] as RelayEvent]
        : ([
            signed(relay, {
              kind: 39002,
              content: "",
              created_at: 11,
              tags: [
                ["d", OPEN],
                ["p", other.pubkey],
                ["p", viewer.pubkey, "", "guest"],
              ],
            }),
          ] as RelayEvent[]),
    );
    await flush();
    h.wire.pending.splice(live(metadataRead), 1)[0]?.respond([]);
    await flush();
    expect(summary(), arrival).toBeDefined();
    expect(summary()?.visibility, arrival).toBe("public");
    if (arrival === "membership")
      expect(summary()).toMatchObject({ viewerRole: "guest", readOnly: true });
    stop();
    h.owner.dispose();
  }
}, 15_000); // This case signs and applies 1,000 relay events.
