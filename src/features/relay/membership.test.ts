import { assert, expect, it, vi } from "vitest";
import { ReadError } from "./errors";
import { foldMessages } from "./fold";
import { createRelaySession } from "./session";
import {
  bounds,
  flush,
  keypair,
  message,
  metadata,
  profile,
  roster,
  scriptedTransport,
  signed,
} from "./testing";
import type { LiveCallbacks } from "./live";
import type { ReadFilter } from "./events";
import type { HeadPersistence, SavedHead } from "./persistence";
import { rowProfileIds } from "./membership";

const relay = keypair(),
  viewer = keypair(),
  pinky = keypair(),
  brain = keypair();
const activity = (body: unknown, time = 20, signer = relay, channel = "a") =>
  signed(signer, {
    kind: 40099,
    content: JSON.stringify(body),
    created_at: time,
    tags: [["h", channel]],
  });
const addition = (target = pinky.pubkey, time = 20) =>
  activity({ type: "member_joined", actor: viewer.pubkey, target }, time);
const end = () =>
  bounds(relay, "a", "head", { has_more: false, next_cursor: null });

it("admits only recognized, channel-scoped relay-authored membership payloads", () => {
  const joined = addition();
  const left = activity({ type: "member_left", actor: pinky.pubkey });
  const removed = activity({
    type: "member_removed",
    actor: viewer.pubkey,
    target: brain.pubkey,
  });
  const rows = foldMessages("a", relay.pubkey, [joined, left, removed]);
  expect(rows).toHaveLength(3);
  expect(rows.find((r) => r.id === left.id)?.membership?.target).toBe(
    pinky.pubkey,
  );
  expect(
    rows.every((r) => !r.content && !r.mentions.length && !r.replyCount),
  ).toBe(true);
  const joinedRow = rows.find((r) => r.id === joined.id);
  assert.exists(joinedRow);
  expect(rowProfileIds(joinedRow)).toEqual([viewer.pubkey, pinky.pubkey]);
  const invalid = [
    null,
    [],
    {},
    { type: "channel_created", actor: viewer.pubkey },
    { type: "member_joined", actor: viewer.pubkey },
    { type: "member_joined", actor: "fake", target: pinky.pubkey },
    { type: "member_removed", actor: viewer.pubkey, target: "fake" },
    { type: "member_left", actor: pinky.pubkey, target: brain.pubkey },
  ];
  expect(
    foldMessages("a", relay.pubkey, [
      ...invalid.map((body) => activity(body)),
      activity(
        { type: "member_joined", actor: viewer.pubkey, target: pinky.pubkey },
        20,
        viewer,
      ),
      activity(
        { type: "member_left", actor: pinky.pubkey },
        20,
        relay,
        "other",
      ),
      signed(relay, {
        kind: 40099,
        content: "broken JSON",
        tags: [["h", "a"]],
      }),
    ]),
  ).toEqual([]);
});

/** Take the pending read `match` selects, in whatever order the store issued it. */
const take = (
  wire: ReturnType<typeof scriptedTransport>,
  match: (filter: ReadFilter) => boolean,
) => {
  const index = wire.pending.findIndex((entry) => entry.filters.some(match));
  const [entry] = index < 0 ? [] : wire.pending.splice(index, 1);
  assert(entry, "No matching pending read");
  return entry;
};
const isWindow = (filter: ReadFilter) => filter.top_level === true;
const isNotices = (filter: ReadFilter) =>
  filter.kinds?.length === 1 && filter.kinds[0] === 40099;
const isNames = (filter: ReadFilter) => !!filter.kinds?.includes(0);

it.each([false, true])(
  "history, live, older pages and optional profiles share the existing session (prepared=%s)",
  async (prepared) => {
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey, {
      notices: true,
    });
    let live!: LiveCallbacks;
    const owner = createRelaySession(
      {
        ...wire.transport,
        subscribe(callbacks) {
          live = callbacks;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      { readStateFloor: () => 0, prepared },
    );
    const q = owner.session.channels;
    try {
      q.ensureList();
      wire
        .next()
        .respond([
          roster(relay, "a", [viewer.pubkey]),
          metadata(relay, "a", "A"),
        ]);
      await flush();
      q.ensure("a");
      const head = wire.next();
      // Pages leave notices out, so joins cannot crowd messages from them.
      expect([...(head.filters[0]?.kinds ?? [])].sort((a, b) => a - b)).toEqual(
        [9, 40002, 40008, 48100, 48103],
      );
      const hello = message(viewer, "a", "Hello", 20);
      head.respond([
        hello,
        bounds(relay, "a", "head", {
          has_more: true,
          next_cursor: { created_at: hello.created_at, id: hello.id },
        }),
      ]);
      await flush();
      // Messages show before their notices are read.
      expect(q.window("a").rows.map((r) => r.id)).toEqual([hello.id]);
      const notices = take(wire, isNotices);
      expect(notices.filters).toEqual([
        { kinds: [40099], "#h": ["a"], authors: [relay.pubkey], limit: 500 },
      ]);
      // One below the oldest page waits for the page that reaches it.
      const row = addition(pinky.pubkey, 21);
      const below = addition(brain.pubkey, 19);
      notices.respond([row, below]);
      await flush();
      expect(q.window("a").rows.map((r) => r.id)).toEqual([hello.id, row.id]);
      expect(q.window("a").rows[1]?.membership?.target).toBe(pinky.pubkey);
      // Render before enrichment, with no per-row blocking request.
      take(wire, isNames).respond([
        profile(viewer, { name: "Wes" }),
        profile(pinky, { name: "Pinky" }),
      ]);
      await flush();
      const chat = message(pinky, "a", "Conversation preview", 22);
      live.receive([chat, addition(brain.pubkey, 23)]);
      await flush();
      expect(q.window("a").rows.map((r) => r.id)).toEqual([
        hello.id,
        row.id,
        chat.id,
        addition(brain.pubkey, 23).id,
      ]);
      expect(q.list().channels[0]?.preview).toBe("Conversation preview");
      expect(
        owner.session.unread.snapshot({ kind: "channel", channelId: "a" })
          .observedCount,
      ).toBe(1);
      take(wire, isNames).respond([profile(brain, { name: "Brain" })]);
      await flush();
      q.loadOlder("a");
      const older = take(wire, isWindow);
      expect(older.filters[0]).toMatchObject({
        until: 20,
        before_id: hello.id,
      });
      expect(older.filters[0]?.kinds).not.toContain(40099);
      const old = message(pinky, "a", "First", 18);
      older.respond([
        old,
        bounds(relay, "a", `20:${hello.id}`, {
          has_more: false,
          next_cursor: null,
        }),
      ]);
      await flush();
      expect(q.window("a").rows.map((r) => r.id)).toEqual([
        old.id,
        below.id,
        hello.id,
        row.id,
        chat.id,
        addition(brain.pubkey, 23).id,
      ]);
      // The first notice read reached the start; nothing is left to read.
      expect(wire.pending.some((entry) => entry.filters.some(isNotices))).toBe(
        false,
      );
      const before = q.window("a").rows;
      live.receive([
        activity(
          { type: "member_joined", actor: viewer.pubkey, target: brain.pubkey },
          24,
          pinky,
        ),
      ]);
      expect(q.window("a").rows).toEqual(before);
      live.receive([roster(relay, "a", [], 1_800_000_000)]);
      expect(q.window("a").rows).toEqual([]);
    } finally {
      owner.dispose();
    }
  },
);

it("reads notices in relay pages down to the window floor, and a failed read never errors the window", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey, {
    notices: true,
  });
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  const q = owner.session.channels;
  try {
    live.receive([roster(relay, "a", [viewer.pubkey])]);
    q.ensure("a");
    const hello = message(viewer, "a", "Hello", 1_000);
    wire.next().respond([
      hello,
      bounds(relay, "a", "head", {
        has_more: true,
        next_cursor: { created_at: hello.created_at, id: hello.id },
      }),
    ]);
    await flush();
    // A full page of joins newer than every loaded message.
    const burst = Array.from({ length: 500 }, (_, index) =>
      activity(
        {
          type: "member_joined",
          actor: viewer.pubkey,
          target: keypair().pubkey,
        },
        1_001 + Math.floor(index / 2),
      ),
    );
    take(wire, isNotices).respond(burst);
    await flush();
    expect(q.window("a").rows).toHaveLength(501);
    // The page stopped above the floor, so the next one continues from its
    // oldest notice by the relay's composite keyset.
    const last = [...burst]
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
      .at(-1);
    const next = take(wire, isNotices);
    expect(next.filters[0]).toMatchObject({
      until: last?.created_at,
      before_id: last?.id,
    });
    next.fail(new Error("notice read failed"));
    await flush();
    expect(q.window("a")).toMatchObject({ status: "ready", error: undefined });
    expect(q.window("a").rows).toHaveLength(501);
    // The next older page retries the descent from where it stopped.
    q.loadOlder("a");
    const older = take(wire, isWindow);
    const first = message(viewer, "a", "First", 990);
    older.respond([
      first,
      bounds(relay, "a", `1000:${hello.id}`, {
        has_more: false,
        next_cursor: null,
      }),
    ]);
    await flush();
    const retry = take(wire, isNotices);
    expect(retry.filters[0]).toMatchObject({
      until: last?.created_at,
      before_id: last?.id,
    });
    const early = addition(pinky.pubkey, 995);
    retry.respond([early]);
    await flush();
    expect(
      q
        .window("a")
        .rows.slice(0, 3)
        .map((r) => r.id),
    ).toEqual([first.id, early.id, hello.id]);
    expect(wire.pending.some((entry) => entry.filters.some(isNotices))).toBe(
      false,
    );
  } finally {
    owner.dispose();
  }
});

it("live activity obeys the same retained row budget as messages", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { readStateFloor: () => 0, maxHistoryRows: 2 },
  );
  try {
    live.receive([roster(relay, "a", [viewer.pubkey])]);
    owner.session.channels.ensure("a");
    wire.next().respond([end()]);
    await flush();
    live.receive([
      addition(pinky.pubkey, 1),
      addition(pinky.pubkey, 2),
      addition(brain.pubkey, 3),
    ]);
    expect(owner.session.channels.window("a")).toMatchObject({
      historyLimited: true,
    });
    expect(
      owner.session.channels.window("a").rows.map((r) => r.createdAt),
    ).toEqual([2, 3]);
  } finally {
    owner.dispose();
  }
});

it("prepared disk heads retain signed membership evidence and subject profiles for warm restore", async () => {
  let saved: SavedHead[] = [];
  const disk: HeadPersistence = {
    read: async () => saved,
    write: async (record) => {
      saved = [record];
    },
    retain: async () => {},
    remove: async () => {},
    clear: async () => {},
    close() {},
  };
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const first = createRelaySession(wire.transport, {
    readStateFloor: () => 0,
    prepared: true,
    persistence: disk,
  });
  try {
    first.session.channels.ensureList();
    wire
      .next()
      .respond([
        roster(relay, "a", [viewer.pubkey]),
        metadata(relay, "a", "A"),
      ]);
    await flush();
    first.session.channels.prepare?.("a");
    wire.next().respond([addition(), end()]);
    await flush();
    wire
      .next()
      .respond([
        profile(viewer, { name: "Wes" }),
        profile(pinky, { name: "Pinky" }),
      ]);
    await flush();
    expect(saved[0]?.events).toContainEqual(
      expect.objectContaining({ id: addition().id, kind: 40099 }),
    );
    expect(saved[0]?.profiles).toHaveLength(2);
  } finally {
    first.dispose();
  }
  const secondWire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const second = createRelaySession(secondWire.transport, {
    readStateFloor: () => 0,
    prepared: true,
    persistence: disk,
  });
  try {
    second.session.channels.ensureList();
    secondWire
      .next()
      .respond([
        roster(relay, "a", [viewer.pubkey]),
        metadata(relay, "a", "A"),
      ]);
    await flush();
    await flush();
    second.session.channels.ensure("a");
    await vi.waitFor(() =>
      expect(
        second.session.channels.window("a").rows[0]?.membership?.target,
      ).toBe(pinky.pubkey),
    );
    expect(second.session.profiles.snapshot().get(pinky.pubkey)?.name).toBe(
      "Pinky",
    );
  } finally {
    second.dispose();
  }
});

it("reads a head's newest notices beside it, showing those that land first with its rows", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey, {
    notices: true,
  });
  const owner = createRelaySession(wire.transport, {
    readStateFloor: () => 0,
    prepared: true,
  });
  const q = owner.session.channels;
  try {
    q.ensureList();
    wire
      .next()
      .respond([
        roster(relay, "a", [viewer.pubkey]),
        metadata(relay, "a", "A"),
      ]);
    await flush();
    q.ensure("a");
    await flush();
    // Both reads are out before either answers.
    const head = take(wire, isWindow);
    const notices = take(wire, isNotices);
    const joined = addition(pinky.pubkey, 21);
    notices.respond([joined]);
    await flush();
    // Notices alone never render; they wait for the head's rows.
    expect(q.window("a")).toMatchObject({ status: "loading", rows: [] });
    const hello = message(viewer, "a", "Hello", 20);
    head.respond([hello, end()]);
    await flush();
    expect(q.window("a").rows.map((r) => r.id)).toEqual([hello.id, joined.id]);
    // The notice read beside the head was its only one.
    expect(wire.pending.some((entry) => entry.filters.some(isNotices))).toBe(
      false,
    );
  } finally {
    owner.dispose();
  }
});

it("saves a head's notices with it and restores only relay-signed ones", async () => {
  let saved: SavedHead[] = [];
  const disk: HeadPersistence = {
    read: async () => saved,
    write: async (record) => {
      saved = [record];
    },
    retain: async () => {},
    remove: async () => {},
    clear: async () => {},
    close() {},
  };
  const hello = message(viewer, "a", "Hello", 20);
  const joined = addition(pinky.pubkey, 21);
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey, {
    notices: true,
  });
  const first = createRelaySession(wire.transport, {
    readStateFloor: () => 0,
    prepared: true,
    persistence: disk,
  });
  try {
    first.session.channels.ensureList();
    wire
      .next()
      .respond([
        roster(relay, "a", [viewer.pubkey]),
        metadata(relay, "a", "A"),
      ]);
    await flush();
    first.session.channels.ensure("a");
    await flush();
    take(wire, isWindow).respond([hello, end()]);
    take(wire, isNotices).respond([joined]);
    await flush();
    expect(saved[0]?.notices).toEqual([
      expect.objectContaining({ id: joined.id }),
    ]);
  } finally {
    first.dispose();
  }
  // A notice the relay did not sign is dropped on restore.
  const forged = activity(
    { type: "member_joined", actor: viewer.pubkey, target: brain.pubkey },
    22,
    viewer,
  );
  saved = saved.map((record) => ({
    ...record,
    notices: [...(record.notices ?? []), forged],
  }));
  const secondWire = scriptedTransport(viewer.pubkey, relay.pubkey, {
    notices: true,
  });
  const second = createRelaySession(secondWire.transport, {
    readStateFloor: () => 0,
    prepared: true,
    persistence: disk,
  });
  try {
    second.session.channels.ensureList();
    secondWire
      .next()
      .respond([
        roster(relay, "a", [viewer.pubkey]),
        metadata(relay, "a", "A"),
      ]);
    await flush();
    await flush();
    second.session.channels.ensure("a");
    // The saved head shows with its notices before any read answers.
    await vi.waitFor(() =>
      expect(second.session.channels.window("a").rows.map((r) => r.id)).toEqual(
        [hello.id, joined.id],
      ),
    );
  } finally {
    second.dispose();
  }
});

it("does not rewrite a restored head whose notice names are already saved", async () => {
  const hello = message(viewer, "a", "Hello", 20);
  const joined = addition(pinky.pubkey, 21);
  let writes = 0;
  const disk: HeadPersistence = {
    read: async () => [
      {
        channelId: "a",
        savedAt: Date.now(),
        events: [hello, end()],
        notices: [joined],
        profiles: [
          profile(viewer, { name: "Wes" }),
          profile(pinky, { name: "Pinky" }),
        ],
      },
    ],
    write: async () => {
      writes++;
    },
    retain: async () => {},
    remove: async () => {},
    clear: async () => {},
    close() {},
  };
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey, {
    notices: true,
  });
  const owner = createRelaySession(wire.transport, {
    readStateFloor: () => 0,
    prepared: true,
    persistence: disk,
  });
  try {
    owner.session.channels.ensureList();
    wire
      .next()
      .respond([
        roster(relay, "a", [viewer.pubkey]),
        metadata(relay, "a", "A"),
      ]);
    await flush();
    await flush();
    owner.session.channels.ensure("a");
    await vi.waitFor(() =>
      expect(owner.session.channels.window("a").rows.map((r) => r.id)).toEqual([
        hello.id,
        joined.id,
      ]),
    );
    await flush();
    expect(writes).toBe(0);
  } finally {
    owner.dispose();
  }
});

it("opens a channel over the established stream with its notices read beside the head, saved with their names", async () => {
  let saved: SavedHead[] = [];
  const disk: HeadPersistence = {
    read: async () => saved,
    write: async (record) => {
      saved = [record];
    },
    retain: async () => {},
    remove: async () => {},
    clear: async () => {},
    close() {},
  };
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey, {
    notices: true,
  });
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { readStateFloor: () => 0, prepared: true, persistence: disk },
  );
  const q = owner.session.channels;
  try {
    q.ensureList();
    wire
      .next()
      .respond([
        roster(relay, "a", [viewer.pubkey]),
        metadata(relay, "a", "A"),
      ]);
    await flush();
    live.state({ status: "connected", routes: [] });
    live.established("a");
    await flush();
    q.ensure("a");
    await flush();
    // The catch-up sends both reads before either answers.
    const head = take(wire, isWindow);
    const notices = take(wire, isNotices);
    const joined = addition(pinky.pubkey, 21);
    notices.respond([joined]);
    await flush();
    expect(q.window("a").rows).toEqual([]);
    const hello = message(viewer, "a", "Hello", 20);
    head.respond([hello, end()]);
    await flush();
    expect(q.window("a").rows.map((r) => r.id)).toEqual([hello.id, joined.id]);
    // Each name read answers only the names it asks for, so the joiner's name
    // lands after the head's own save.
    const names = new Map([
      [viewer.pubkey, profile(viewer, { name: "Wes" })],
      [pinky.pubkey, profile(pinky, { name: "Pinky" })],
    ]);
    for (let round = 0; round < 3; round++) {
      for (const entry of wire.pending.splice(0))
        entry.respond(
          entry.filters.flatMap((filter) =>
            isNames(filter)
              ? (filter.authors ?? []).flatMap((id) => names.get(id) ?? [])
              : [],
          ),
        );
      await flush();
    }
    expect(saved[0]?.notices).toEqual([
      expect.objectContaining({ id: joined.id }),
    ]);
    expect(saved[0]?.profiles).toContainEqual(
      expect.objectContaining({ pubkey: pinky.pubkey, kind: 0 }),
    );
  } finally {
    owner.dispose();
  }
});

it("leaves a failed head's window empty though its notices landed first", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey, {
    notices: true,
  });
  const owner = createRelaySession(wire.transport, {
    readStateFloor: () => 0,
    prepared: true,
  });
  const q = owner.session.channels;
  try {
    q.ensureList();
    wire
      .next()
      .respond([
        roster(relay, "a", [viewer.pubkey]),
        metadata(relay, "a", "A"),
      ]);
    await flush();
    q.ensure("a");
    await flush();
    const head = take(wire, isWindow);
    take(wire, isNotices).respond([addition(pinky.pubkey, 21)]);
    await flush();
    head.fail(new ReadError("unavailable", "head failed"));
    await flush();
    expect(q.window("a")).toMatchObject({ status: "error", rows: [] });
  } finally {
    owner.dispose();
  }
});

it("a catch-up head rereads the newest notices, and restarts the descent only when they do not meet the ones held", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey, {
    notices: true,
  });
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { prepared: true },
  );
  const q = owner.session.channels;
  const hello = message(viewer, "a", "Hello", 1_000);
  const head = () =>
    take(wire, isWindow).respond([
      hello,
      bounds(relay, "a", "head", {
        has_more: true,
        next_cursor: { created_at: hello.created_at, id: hello.id },
      }),
    ]);
  const noticeReads = () =>
    wire.pending.filter(
      (entry) => !entry.signal?.aborted && entry.filters.some(isNotices),
    );
  try {
    q.ensureList();
    wire
      .next()
      .respond([
        roster(relay, "a", [viewer.pubkey]),
        metadata(relay, "a", "A"),
      ]);
    await flush();
    q.ensure("a");
    head();
    await flush();
    const held = addition(pinky.pubkey, 1_001);
    take(wire, isNotices).respond([held]);
    await flush();
    expect(q.window("a").rows.map((r) => r.id)).toEqual([hello.id, held.id]);
    expect(noticeReads()).toHaveLength(0);
    // A long drop: more joins than one page landed while the stream was down.
    live.state({ status: "connected", routes: [] });
    live.established("a");
    await flush();
    head();
    await flush();
    const missed = Array.from({ length: 500 }, (_, index) =>
      addition(keypair().pubkey, 1_100 + index),
    );
    const top = take(wire, isNotices);
    expect(top.filters[0]).not.toHaveProperty("until");
    top.respond(missed);
    await flush();
    const resumed = take(wire, isNotices);
    expect(resumed.filters[0]).toMatchObject({
      until: 1_100,
      before_id: missed[0]?.id,
    });
    resumed.respond([held]);
    await flush();
    expect(q.window("a").rows).toHaveLength(502);
    expect(noticeReads()).toHaveLength(0);
    // A head whose newest notices meet the ones held reads nothing more.
    live.state({ status: "retrying", routes: [] });
    await flush();
    live.state({ status: "connected", routes: [] });
    live.established("a");
    await flush();
    head();
    await flush();
    take(wire, isNotices).respond(missed);
    await flush();
    expect(noticeReads()).toHaveLength(0);
    expect(q.window("a").rows).toHaveLength(502);
  } finally {
    owner.dispose();
  }
});
