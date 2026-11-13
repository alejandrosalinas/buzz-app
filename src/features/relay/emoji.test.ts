import { afterEach, expect, it, vi } from "vitest";
import { createEmojiDirectory } from "./emoji-directory";
import {
  EMOJI_SET,
  emojiTags,
  referencedEmoji,
  suggestShortcode,
  validEmojiSetTemplate,
  validReactionContent,
} from "./emoji";
import { createRelaySession } from "./session";
import { foldMessages } from "./fold";
import { PublishRejected } from "./outbox";
import { ReadError } from "./errors";
import {
  flush,
  keypair,
  message,
  roster,
  scriptedTransport,
  signed,
  type Key,
} from "./testing";
import type { LiveCallbacks } from "./live";
import type { RelayEvent } from "./events";

const viewer = keypair(),
  relay = keypair(),
  member = keypair();
const url = "https://a.test/media/party.png";
const nostrUrl = "nostr:emoji:party";
function set(key = member, time = 1, tags = [["emoji", "party", url]]) {
  return signed(key, {
    kind: 30030,
    created_at: time,
    content: "",
    tags: [["d", EMOJI_SET], ...tags],
  });
}
const owners: { dispose(): void }[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks();
});
function session(scope = "a", publishSucceeds = false) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const sign = vi.fn(async (template) => signed(viewer, template));
  const publish = vi.fn(async (_event: RelayEvent) => {
    if (publishSucceeds) return;
    throw new PublishRejected("retry test");
  });
  const query = vi.fn(wire.transport.query);
  const owner = createRelaySession(
    {
      ...wire.transport,
      scope,
      query,
      writer: { sign, publish },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  return { ...owner, wire, live, sign, publish, query };
}
it("normalizes first-wins scheme-agnostic emoji tags and leaves URL fragments out of text references", () => {
  const nonHttpsSet = set(member, 1, [
    ["emoji", ":PaRtY:", nostrUrl],
    ["emoji", "party", "ignored"],
    ["emoji", "sparkles", "ipfs://bafkreiemoji"],
    ["emoji", "bad code", url],
  ]);
  expect(emojiTags(nonHttpsSet)).toEqual([
    { shortcode: "party", url: nostrUrl },
    { shortcode: "sparkles", url: "ipfs://bafkreiemoji" },
  ]);
  expect(
    referencedEmoji(
      ":PARTY: :party: https://a.test/:link: http://localhost:3000/:dev: :other:",
    ),
  ).toEqual(["party", "other"]);
});
it("unions latest complete member sets; empty replacements and ties survive stale reads", async () => {
  const h = session();
  const loading = h.session.emoji.ensure();
  const pending = h.wire.next();
  expect(pending.filters).toEqual([
    { kinds: [30030], "#d": [EMOJI_SET], limit: 500 },
  ]);
  expect(h.query.mock.calls[0]?.[3]).toBe("background");
  h.live.receive([
    set(member, 3, []),
    set(viewer, 2, [["emoji", "party", "https://z.test/p"]]),
  ]);
  pending.respond([set(member, 1)]);
  await loading;
  expect(h.session.emoji.snapshot().entries).toEqual([
    { shortcode: "party", url: "https://z.test/p" },
  ]);
  h.live.receive([set(relay, 2, [["emoji", "party", "https://b.test/p"]])]);
  expect(h.session.emoji.snapshot().entries[0]?.url).toBe("https://b.test/p");
  const sameA = set(member, 4, [["emoji", "party", "https://x.test/a"]]);
  const sameB = set(member, 4, [["emoji", "party", "https://x.test/b"]]);
  h.live.receive([sameA, sameB, sameA]);
  expect(h.session.emoji.snapshot().entries[0]?.url).toBe(
    emojiTags(sameA.id < sameB.id ? sameA : sameB)[0]?.url,
  );
});
it("actual session cold send is draft-safe; A/B sends, replies and signed retries pin original URLs", async () => {
  const a = session("a"),
    b = session("b");
  expect(() => a.session.messages.send("c", ":party:")).toThrow(/isn't ready/);
  expect(a.session.outbox?.snapshot()).toHaveLength(0);
  expect(b.wire.pending).toHaveLength(0);
  const aRead = a.wire.next();
  const bReady = b.session.emoji.ensure();
  b.wire
    .next()
    .respond([
      set(member, 1, [["emoji", "party", "https://b.test/media/party.png"]]),
    ]);
  aRead.respond([set(member, 1, [["emoji", "party", nostrUrl]])]);
  await bReady;
  await flush();
  const sendId = a.session.messages.send("c", ":unknown:party:");
  const replyId = b.session.messages.reply(
    "c",
    "e".repeat(64),
    ":party: :party:",
  );
  const aEvent = a.session.outbox
    ?.snapshot()
    .find((e) => e.event.id === sendId)?.event;
  const bEvent = b.session.outbox
    ?.snapshot()
    .find((e) => e.event.id === replyId)?.event;
  expect(bEvent?.tags.filter(([name]) => name === "emoji")).toEqual([
    ["emoji", "party", "https://b.test/media/party.png"],
  ]);
  expect(aEvent?.tags.filter(([name]) => name === "emoji")).toEqual([
    ["emoji", "party", nostrUrl],
  ]);
  expect(bEvent?.tags).toEqual(
    expect.arrayContaining([
      ["emoji", "party", "https://b.test/media/party.png"],
      ["e", "e".repeat(64), "", "reply"],
    ]),
  );
  await flush();
  await flush();
  expect(a.publish).toHaveBeenCalledTimes(1);
  a.live.receive([set(member, 9, [["emoji", "party", "https://new.test/p"]])]);
  a.session.messages.retry(sendId);
  await flush();
  await flush();
  expect(a.sign).toHaveBeenCalledTimes(1);
  expect(a.publish.mock.calls[1]?.[0]).toEqual(a.publish.mock.calls[0]?.[0]);
  expect(a.publish.mock.calls[1]?.[0].tags).toContainEqual([
    "emoji",
    "party",
    nostrUrl,
  ]);
  expect(a.session.emoji.snapshot().entries[0]?.url).toBe("https://new.test/p");
});
it("reactions use retained thread targets after shared-cache eviction", () => {
  const h = session();
  const root = message(member, "c", "Still visible", 1);
  h.live.receive([root]);
  const thread = h.session.thread("c", root.id);
  owners.push(thread);
  h.live.receive(
    Array.from({ length: 9 }, (_, index) =>
      message(member, "other", "x".repeat(1024 * 1024), 100 + index),
    ),
  );
  expect(thread.snapshot().root?.id).toBe(root.id);
  const id = h.session.messages.react(root.id, "👍");
  expect(
    h.session.outbox?.snapshot().find((item) => item.event.id === id)?.event,
  ).toMatchObject({
    kind: 7,
    content: "👍",
    tags: expect.arrayContaining([
      ["h", "c"],
      ["e", root.id],
      ["p", root.pubkey],
    ]),
  });
});
it("reconciles retained channel reactions through confirmation and access loss", async () => {
  const h = session("a", true);
  const root = message(member, "c", "Still visible", 1);
  h.session.channels.ensure("c");
  h.live.receive([roster(relay, "c", [viewer.pubkey], 1), root]);
  h.live.receive(
    Array.from({ length: 9 }, (_, index) =>
      message(member, "other", "x".repeat(1024 * 1024), 100 + index),
    ),
  );
  expect(h.session.channels.window("c").rows[0]?.id).toBe(root.id);
  const id = h.session.messages.react(root.id, "👍");
  expect(h.session.channels.window("c").rows[0]?.reactions).toEqual([
    { content: "👍", events: [{ id, authorId: viewer.pubkey }] },
  ]);
  await flush();
  await flush();
  const operation = h.session.outbox
    ?.snapshot()
    .find((item) => item.event.id === id);
  expect(operation).toMatchObject({ delivery: "accepted", signed: { id } });
  const confirmation = h.wire.pending.find((request) =>
    request.filters.some((filter) => filter.ids?.includes(id)),
  );
  if (!confirmation || !operation?.signed)
    throw new Error("Missing signed reaction confirmation");
  confirmation.respond([operation.signed]);
  await flush();
  expect(h.session.outbox?.snapshot()).toHaveLength(0);
  expect(h.session.channels.window("c").rows[0]?.reactions).toEqual([
    { content: "👍", events: [{ id, authorId: viewer.pubkey }] },
  ]);
  h.live.receive([roster(relay, "c", [], 2)]);
  expect(h.session.channels.window("c").rows).toEqual([]);
  expect(() => h.session.messages.react(root.id, "🎉")).toThrow(/Load/);
});
it("accepts every catalog shortcode length through session reaction authoring", async () => {
  const h = session();
  const root = message(member, "c", "React here", 1);
  const names = [62, 63, 64].map((length) => "a".repeat(length));
  h.live.receive([root]);
  const ready = h.session.emoji.ensure();
  h.wire.next().respond([
    set(
      member,
      1,
      names.map((name) => ["emoji", name, `https://a.test/${name}.png`]),
    ),
  ]);
  await ready;
  for (const name of names) {
    const content = `:${name}:`;
    const id = h.session.messages.react(root.id, content);
    expect(
      h.session.outbox?.snapshot().find((item) => item.event.id === id)?.event,
    ).toMatchObject({
      kind: 7,
      content,
      tags: expect.arrayContaining([
        ["e", root.id],
        ["emoji", name, `https://a.test/${name}.png`],
      ]),
    });
  }
});
it("custom emoji reactions are colon-wrapped, bounded, tagged, and retry original URLs", async () => {
  const h = session();
  const root = message(member, "c", "React here", 1);
  h.live.receive([root]);
  const ready = h.session.emoji.ensure();
  h.wire.next().respond([set(member, 1, [["emoji", "party", nostrUrl]])]);
  await ready;
  const id = h.session.messages.react(root.id, ":party:");
  await flush();
  await flush();
  const event = h.publish.mock.calls[0]?.[0];
  expect(validReactionContent(":party:")).toBe(true);
  expect(event).toMatchObject({ kind: 7, content: ":party:" });
  expect(event?.tags).toEqual(
    expect.arrayContaining([
      ["h", "c"],
      ["e", root.id],
      ["emoji", "party", nostrUrl],
    ]),
  );
  h.live.receive([set(member, 9, [["emoji", "party", "https://new.test/p"]])]);
  h.session.messages.retry(id);
  await flush();
  await flush();
  expect(h.sign).toHaveBeenCalledTimes(1);
  expect(h.publish.mock.calls[1]?.[0]).toEqual(event);
  expect(() => h.session.messages.react("missing", "👍")).toThrow(/Load/);
  expect(() => h.session.messages.react(root.id, " ")).toThrow(/empty/);
  expect(validReactionContent("x".repeat(64))).toBe(true);
  expect(validReactionContent("x".repeat(65))).toBe(false);
  expect(validReactionContent(`:${"x".repeat(64)}:`)).toBe(true);
  expect(() => h.session.messages.react(root.id, "x".repeat(65))).toThrow(
    /long/,
  );
  expect(() =>
    h.session.messages.react(root.id, `:${"x".repeat(65)}:`),
  ).toThrow(/long/);
});
it("plain sends do not acquire a palette; a custom send retries a cold failure while passive demand does not", async () => {
  const h = session();
  const reads = () =>
    h.query.mock.calls.filter(([filters]) =>
      filters.some((filter) => filter.kinds?.includes(30030)),
    ).length;
  expect(h.session.messages.send("c", "hello")).toMatch(/^[0-9a-f]{64}$/);
  expect(h.wire.pending.some((p) => p.filters[0]?.kinds?.includes(30030))).toBe(
    false,
  );
  for (const pending of h.wire.pending.splice(0)) pending.respond([]);
  await flush();
  const ready = h.session.emoji.ensure();
  await flush();
  h.wire.next().fail(new Error("offline"));
  await ready;
  expect(h.session.emoji.snapshot().status).toBe("error");
  // Passive warm-up does not re-read a cold failure.
  void h.session.emoji.ensure();
  await flush();
  expect(h.session.emoji.snapshot().status).toBe("error");
  expect(reads()).toBe(1);
  // A refused send starts one retry cycle; repeated sends and demand share it.
  expect(() =>
    h.session.messages.reply("c", "a".repeat(64), ":party:"),
  ).toThrow(/isn't ready/);
  expect(h.session.emoji.snapshot().status).toBe("loading");
  const retry = h.session.emoji.ensure();
  expect(() => h.session.messages.send("c", ":party:")).toThrow(/isn't ready/);
  expect(h.session.emoji.ensure()).toBe(retry);
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  expect(reads()).toBe(2);
  h.wire.next().respond([set()]);
  await retry;
  expect(h.session.emoji.snapshot().status).toBe("ready");
  const id = h.session.messages.send("c", ":party:");
  expect(
    h.session.outbox?.snapshot().find((item) => item.event.id === id)?.event
      .tags,
  ).toContainEqual(["emoji", "party", url]);
  expect(reads()).toBe(2);
});
it("explicit retries jump background traffic that starves the passive catalog load", async () => {
  vi.useFakeTimers();
  try {
    const catalog = (target: ReturnType<typeof session>) =>
      target.wire.pending.find((p) => p.filters[0]?.kinds?.includes(30030));
    // Background profile reads hold the background lane, as on channel open.
    const busy = (target: ReturnType<typeof session>, key: Key) =>
      void target.session.profiles
        .ensure([key.pubkey], "background")
        .catch(() => {});
    const h = session();
    busy(h, member);
    void h.session.emoji.ensure();
    // The passive load spends its whole deadline queued, never reaching the relay.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(catalog(h)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.session.emoji.snapshot()).toMatchObject({
      status: "error",
      error: expect.stringContaining("Relay read timed out"),
    });
    h.wire.pending.splice(0);
    busy(h, relay);
    await vi.advanceTimersByTimeAsync(0);
    // The refused send's retry dispatches despite the busy lane.
    expect(() => h.session.messages.send("c", ":party:")).toThrow(
      /isn't ready/,
    );
    await vi.advanceTimersByTimeAsync(0);
    catalog(h)?.respond([set()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.emoji.snapshot().status).toBe("ready");
    const id = h.session.messages.send("c", ":party:");
    expect(
      h.session.outbox?.snapshot().find((item) => item.event.id === id)?.event
        .tags,
    ).toContainEqual(["emoji", "party", url]);
    // A retry while the passive load is still queued supersedes it.
    const queued = session("b");
    busy(queued, member);
    void queued.session.emoji.ensure();
    await vi.advanceTimersByTimeAsync(0);
    expect(catalog(queued)).toBeUndefined();
    const retry = queued.session.emoji.refresh();
    await vi.advanceTimersByTimeAsync(0);
    catalog(queued)?.respond([set()]);
    await retry;
    expect(queued.session.emoji.snapshot().status).toBe("ready");
  } finally {
    vi.useRealTimers();
  }
});
it("a failed refresh keeps a loaded catalog ready and sendable, with its error until a retry", async () => {
  const h = session();
  const ready = h.session.emoji.ensure();
  h.wire.next().respond([set()]);
  await ready;
  const loaded = h.session.emoji.snapshot();
  const failing = h.session.emoji.refresh();
  expect(h.session.emoji.snapshot()).toBe(loaded);
  h.wire.next().fail(new Error("offline"));
  await failing;
  expect(h.session.emoji.snapshot()).toMatchObject({
    status: "ready",
    error: expect.stringContaining("offline"),
  });
  expect(h.session.emoji.snapshot().entries).toBe(loaded.entries);
  const id = h.session.messages.reply("c", "a".repeat(64), ":party:");
  expect(
    h.session.outbox?.snapshot().find((item) => item.event.id === id)?.event
      .tags,
  ).toContainEqual(["emoji", "party", url]);
  // Demand does not re-read a ready catalog; an explicit retry clears the error.
  await h.session.emoji.ensure();
  expect(h.wire.pending).toHaveLength(0);
  const retry = h.session.emoji.refresh();
  expect(h.session.emoji.snapshot()).toMatchObject({
    status: "ready",
    error: undefined,
  });
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  h.wire.next().respond([set()]);
  await retry;
  expect(h.session.emoji.snapshot()).toMatchObject({
    status: "ready",
    error: undefined,
  });
});
it("initial roster cancellation restarts demanded emoji once; clear/dispose fence obsolete results", async () => {
  const h = session();
  h.session.channels.ensureList();
  const discovery = h.wire.next();
  const ready = h.session.emoji.ensure(),
    stale = h.wire.next();
  discovery.respond([roster(relay, "c", [viewer.pubkey])]);
  await ready;
  await flush();
  expect(stale.signal?.aborted).toBe(true);
  const fresh = h.wire.pending.find((p) =>
    p.filters[0]?.kinds?.includes(30030),
  );
  expect(fresh).toBeDefined();
  fresh?.respond([set(member, 2)]);
  h.wire.pending
    .splice(0)
    .filter((p) => p !== fresh)
    .forEach((p) => {
      p.respond([]);
    });
  await flush();
  expect(h.session.emoji.snapshot().status).toBe("ready");
  const refreshing = h.session.emoji.refresh(),
    old = h.wire.next();
  const clear = h.clearCache();
  await clear;
  await refreshing;
  await flush();
  expect(old.signal?.aborted).toBe(true);
  expect(h.session.emoji.snapshot().entries).toEqual([]);
  h.dispose();
  old.respond([set(member, 99)]);
  await flush();
  expect(h.session.emoji.snapshot().entries).toEqual([]);
});
it("reconnect repairs a previously requested catalog in place, without preloading an unused community", async () => {
  const h = session(),
    idle = session();
  const ready = h.session.emoji.ensure();
  h.wire.next().respond([set()]);
  await ready;
  const loaded = h.session.emoji.snapshot();
  for (const target of [h, idle]) {
    target.live.state({ status: "connected", routes: [] });
    target.live.established();
  }
  await flush();
  await flush();
  const requests = h.wire.pending.filter((p) =>
    p.filters[0]?.kinds?.includes(30030),
  );
  expect(requests).toHaveLength(1);
  expect(
    idle.wire.pending.some((p) => p.filters[0]?.kinds?.includes(30030)),
  ).toBe(false);
  // The repair read publishes nothing while pending, and sends keep their tags.
  expect(h.session.emoji.snapshot()).toBe(loaded);
  const id = h.session.messages.send("c", ":party:");
  expect(
    h.session.outbox?.snapshot().find((item) => item.event.id === id)?.event
      .tags,
  ).toContainEqual(["emoji", "party", url]);
  requests[0]?.respond([set(member, 2, [])]);
  await flush();
  expect(h.session.emoji.snapshot().entries).toEqual([]);
});
it("active catalog demand bypasses queued warm-up and recovers a cold failure without reloading ready data", async () => {
  vi.useFakeTimers();
  try {
    const h = session();
    void h.session.profiles
      .ensure([member.pubkey], "background")
      .catch(() => {});
    void h.session.emoji.ensure();
    await vi.advanceTimersByTimeAsync(0);
    const catalog = () =>
      h.wire.pending.find(
        (p) => !p.signal?.aborted && p.filters[0]?.kinds?.includes(30030),
      );
    expect(catalog()).toBeUndefined();
    const active = h.session.emoji.ensure("foreground");
    await vi.advanceTimersByTimeAsync(0);
    expect(catalog()).toBeDefined();
    catalog()?.fail(new Error("catalog unavailable"));
    await active;
    expect(h.session.emoji.snapshot().status).toBe("error");
    await h.session.emoji.ensure();
    expect(h.session.emoji.snapshot().status).toBe("error");
    const failed = h.session.emoji.snapshot();
    const failedReads = h.query.mock.calls.length;
    // Completion providers remount on each edit. A settled foreground failure
    // retains its recovery action instead of starting another automatic read.
    await h.session.emoji.ensure("foreground");
    await h.session.emoji.ensure("foreground");
    expect(h.query.mock.calls).toHaveLength(failedReads);
    expect(h.session.emoji.snapshot()).toBe(failed);
    const retry = h.session.emoji.refresh();
    await vi.advanceTimersByTimeAsync(0);
    catalog()?.respond([set()]);
    await retry;
    expect(h.session.emoji.snapshot().entries).toEqual([
      { shortcode: "party", url },
    ]);
    const reads = h.query.mock.calls.length;
    await h.session.emoji.ensure("foreground");
    expect(h.query.mock.calls).toHaveLength(reads);
  } finally {
    vi.useRealTimers();
  }
});
it("exposes read-cap and retained-byte limits rather than evicting replacement evidence", async () => {
  const reader = {
    read: vi.fn(async () => Array(500).fill(set()) as RelayEvent[]),
  };
  const directory = createEmojiDirectory(reader);
  owners.push(directory);
  await directory.queries.ensure();
  // A capped read is incomplete, but still resolves the shortcodes it holds.
  expect(directory.queries.snapshot()).toMatchObject({
    status: "ready",
    entries: [{ shortcode: "party", url }],
    error: expect.stringContaining("incomplete"),
  });
  expect(directory.tags(":party:")).toEqual([["emoji", "party", url]]);
  directory.accept([
    set(member, 2, [["emoji", "party", "x".repeat(2 * 1024 * 1024)]]),
  ]);
  expect(directory.queries.snapshot()).toMatchObject({
    status: "error",
    entries: [],
    error: expect.stringContaining("budget"),
  });
  // Overflow would repeat on every read, so demand and sends leave it to Retry.
  await directory.queries.ensure();
  await directory.queries.ensure("foreground");
  expect(() => directory.tags(":party:")).toThrow(/Retry message preparation/);
  expect(reader.read).toHaveBeenCalledTimes(1);
  directory.accept([set(member, 1)]);
  expect(directory.queries.snapshot().entries).toEqual([]);
  reader.read.mockResolvedValueOnce([set(member, 3, [])]);
  await directory.queries.refresh();
  expect(reader.read).toHaveBeenCalledTimes(2);
  expect(directory.queries.snapshot()).toMatchObject({
    status: "ready",
    entries: [],
  });
  directory.accept([set(member, 1)]);
  expect(directory.queries.snapshot().entries).toEqual([]);
});
it("fold preserves historical message/edit mappings and per-reaction URLs without a catalog", () => {
  const original = message(viewer, "c", ":party:", 1, [
    ["emoji", "party", url],
  ]);
  const edit = (key: Key, time: number, tags: string[][]) =>
    signed(key, {
      kind: 40003,
      created_at: time,
      content: "edited :party:",
      tags: [["e", original.id], ...tags],
    });
  const reactions = ["https://one.test/p", "https://two.test/p"].map(
    (url, index) =>
      signed(member, {
        kind: 7,
        content: ":party:",
        created_at: 3 + index,
        tags: [
          ["e", original.id],
          ["emoji", "party", url],
        ],
      }),
  );
  const deletedReaction = signed(viewer, {
    kind: 7,
    content: ":party:",
    tags: [
      ["e", original.id],
      ["emoji", "party", "nostr:emoji:deleted"],
    ],
  });
  const deleteReaction = signed(viewer, {
    kind: 5,
    content: "",
    tags: [["e", deletedReaction.id]],
  });
  const tagged = edit(viewer, 2, [["emoji", "party", "https://edited.test/p"]]);
  const fold = (...extra: RelayEvent[]) =>
    foldMessages("c", relay.pubkey, [
      original,
      ...reactions,
      deletedReaction,
      deleteReaction,
      ...extra,
    ])[0];
  expect(fold(tagged)?.emoji).toEqual([
    { shortcode: "party", url: "https://edited.test/p" },
  ]);
  expect(fold(tagged, edit(viewer, 3, []))?.emoji).toEqual([
    { shortcode: "party", url },
  ]);
  expect(
    fold(edit(member, 4, [["emoji", "party", "https://spoof.test/p"]]))?.emoji,
  ).toEqual([{ shortcode: "party", url }]);
  expect(fold()?.reactions.map((r) => r.emoji?.url)).toEqual([
    "https://one.test/p",
    "https://two.test/p",
  ]);
});
function authoring(
  kinds?: readonly number[],
  upload = vi.fn(async (file: File) => ({
    name: file.name,
    url: "https://a.test/media/new.png",
    type: "image/png",
    size: 3,
    sha256: "b".repeat(64),
  })),
) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const sign = vi.fn(async (template) => signed(viewer, template));
  const publish = vi.fn(async (_event: RelayEvent) => {});
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: { sign, publish, ...(kinds ? { kinds } : {}) },
      uploadAttachment: upload,
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  const emoji = owner.session.emoji;
  const ownRead = () => {
    const pending = wire.pending.find((p) => p.filters[0]?.authors);
    if (!pending) throw new Error("No own-set read");
    wire.pending.splice(wire.pending.indexOf(pending), 1);
    return pending;
  };
  return { ...owner, wire, sign, publish, upload, emoji, ownRead };
}
it("adding republishes the viewer's own set, replaces one shortcode and reaches the palette", async () => {
  const h = authoring();
  const ready = h.emoji.ensure();
  h.wire.next().respond([
    set(member, 1, [["emoji", "wave", "https://a.test/wave.png"]]),
    set(viewer, 5, [
      ["emoji", "party", url],
      ["emoji", "keep", "https://a.test/keep.png"],
    ]),
  ]);
  await ready;
  expect(h.emoji.snapshot().mine.map((e) => e.shortcode)).toEqual([
    "party",
    "keep",
  ]);
  const adding = h.emoji.add?.(":Party:", "https://a.test/media/new.png");
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  const own = h.ownRead();
  expect(own.filters).toEqual([
    { kinds: [30030], "#d": [EMOJI_SET], authors: [viewer.pubkey], limit: 1 },
  ]);
  own.respond([
    set(viewer, 5, [
      ["emoji", "party", url],
      ["emoji", "keep", "https://a.test/keep.png"],
    ]),
  ]);
  await expect(adding).resolves.toBe("party");
  const event = h.publish.mock.calls[0]?.[0];
  expect(event).toMatchObject({ kind: 30030, pubkey: viewer.pubkey });
  expect(event?.created_at).toBeGreaterThan(5);
  expect(event?.tags).toEqual([
    ["d", EMOJI_SET],
    ["emoji", "keep", "https://a.test/keep.png"],
    ["emoji", "party", "https://a.test/media/new.png"],
  ]);
  expect(h.emoji.snapshot().entries).toEqual([
    { shortcode: "keep", url: "https://a.test/keep.png" },
    { shortcode: "party", url: "https://a.test/media/new.png" },
    { shortcode: "wave", url: "https://a.test/wave.png" },
  ]);
  // Use: sends reference the added image by its original URL.
  const sent = h.session.messages.send("c", "hi :party:");
  expect(
    h.session.outbox?.snapshot().find((item) => item.event.id === sent)?.event
      .tags,
  ).toContainEqual(["emoji", "party", "https://a.test/media/new.png"]);
  // Reload: a fresh session reading the relay's stored set shows the addition.
  const reloaded = authoring();
  const reread = reloaded.emoji.ensure();
  reloaded.wire.next().respond(event ? [event] : []);
  await reread;
  expect(reloaded.emoji.snapshot().mine).toEqual([
    { shortcode: "keep", url: "https://a.test/keep.png" },
    { shortcode: "party", url: "https://a.test/media/new.png" },
  ]);
});
it("rejects invalid names before any read and maps publish failure to reference copy", async () => {
  const h = authoring();
  await expect(h.emoji.add?.("bad name", url)).rejects.toThrow(
    "Invalid emoji name. Use letters, numbers, hyphen, or underscore.",
  );
  await expect(h.emoji.add?.("x".repeat(65), url)).rejects.toThrow(
    /Invalid emoji name/,
  );
  expect(h.wire.pending).toHaveLength(0);
  h.publish.mockRejectedValueOnce(new PublishRejected("blocked: no"));
  const adding = h.emoji.add?.("party", url);
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  h.ownRead().respond([]);
  await expect(adding).rejects.toThrow("Failed to add emoji.");
  expect(h.emoji.snapshot().mine).toEqual([]);
  const failedRead = h.emoji.add?.("party", url);
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  h.ownRead().fail(new Error("offline"));
  await expect(failedRead).rejects.toThrow("Failed to add emoji.");
  expect(h.publish).toHaveBeenCalledTimes(1);
});
it("removes only from the fresh own set and preserves another member's colliding emoji", async () => {
  const h = authoring();
  const other = set(member, 1);
  const own = set(viewer, 2, [["emoji", "party", "https://a.test/own.png"]]);
  const ready = h.emoji.ensure();
  h.wire.next().respond([other, own]);
  await ready;
  const removing = h.emoji.remove?.(":PARTY:");
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  const read = h.ownRead();
  expect(read.filters).toEqual([
    { kinds: [30030], "#d": [EMOJI_SET], authors: [viewer.pubkey], limit: 1 },
  ]);
  // A newer own set has an entry absent from the initial catalog.
  read.respond([
    set(viewer, 3, [
      ["emoji", "party", "https://a.test/own.png"],
      ["emoji", "keep", "https://a.test/keep.png"],
    ]),
  ]);
  await removing;
  const event = h.publish.mock.calls[0]?.[0];
  expect(event).toMatchObject({
    kind: 30030,
    pubkey: viewer.pubkey,
    content: "",
  });
  expect(event?.tags).toEqual([
    ["d", EMOJI_SET],
    ["emoji", "keep", "https://a.test/keep.png"],
  ]);
  expect(h.emoji.snapshot().entries).toEqual([
    { shortcode: "keep", url: "https://a.test/keep.png" },
    { shortcode: "party", url },
  ]);
  const last = h.emoji.remove?.("keep");
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  h.ownRead().respond(event ? [event] : []);
  await last;
  const empty = h.publish.mock.calls[1]?.[0];
  expect(empty?.tags).toEqual([["d", EMOJI_SET]]);
  const reloaded = authoring();
  const reread = reloaded.emoji.ensure();
  reloaded.wire.next().respond(empty ? [other, empty, own] : []);
  await reread;
  expect(reloaded.emoji.snapshot().mine).toEqual([]);
  expect(reloaded.emoji.snapshot().entries).toEqual([
    { shortcode: "party", url },
  ]);
});
it("does not republish invalid, absent, or other members' names", async () => {
  const h = authoring();
  await h.emoji.remove?.("bad name");
  expect(h.wire.pending).toHaveLength(0);
  const removing = h.emoji.remove?.("party");
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  h.ownRead().respond([set(member)]);
  await removing;
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
});
it("serializes additions and removals despite a stale own-set read", async () => {
  const h = authoring();
  const add = h.emoji.add?.("party", url);
  const remove = h.emoji.remove?.("party");
  const keep = h.emoji.add?.("keep", "https://a.test/keep.png");
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  h.ownRead().respond([]);
  await add;
  const stale = h.publish.mock.calls[0]?.[0];
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  h.ownRead().respond([]);
  await remove;
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  h.ownRead().respond(stale ? [stale] : []);
  await keep;
  expect(h.publish.mock.calls[2]?.[0].tags).toEqual([
    ["d", EMOJI_SET],
    ["emoji", "keep", "https://a.test/keep.png"],
  ]);
});
it("keeps the own set after rejected removal and recovers on retry", async () => {
  const h = authoring();
  h.publish.mockRejectedValueOnce(new PublishRejected("blocked: no"));
  const own = set(viewer);
  const removing = h.emoji.remove?.("party");
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  h.ownRead().respond([own]);
  await expect(removing).rejects.toThrow("Failed to remove emoji.");
  expect(h.emoji.snapshot().mine).toEqual([{ shortcode: "party", url }]);
  const retry = h.emoji.remove?.("party");
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  h.ownRead().respond([own]);
  await retry;
  expect(h.emoji.snapshot().mine).toEqual([]);
});
it("fails removal on read failure, timeout, signer mismatch and disposal", async () => {
  const h = authoring();
  const readFailure = h.emoji.remove?.("party");
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  h.ownRead().fail(new Error("offline"));
  await expect(readFailure).rejects.toThrow("Failed to remove emoji.");
  const deadline = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(deadline.signal);
  try {
    const removing = h.emoji.remove?.("party");
    await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
    h.ownRead();
    deadline.abort();
    await expect(removing).rejects.toThrow("Timed out while removing emoji.");
  } finally {
    timeout.mockRestore();
  }
  h.sign.mockImplementationOnce(async (template) => signed(member, template));
  const mismatch = h.emoji.remove?.("party");
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  h.ownRead().respond([set(viewer)]);
  await expect(mismatch).rejects.toThrow("Failed to remove emoji.");
  const running = h.emoji.remove?.("party");
  const queued = h.emoji.remove?.("party");
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  h.dispose();
  await expect(running).rejects.toThrow("Failed to remove emoji.");
  await expect(queued).rejects.toThrow("Failed to remove emoji.");
  await expect(h.emoji.remove?.("party")).rejects.toThrow(
    "Failed to remove emoji.",
  );
  expect(h.publish).not.toHaveBeenCalled();
});
it("maps an add that outlives its deadline to the reference timeout copy", async () => {
  const deadline = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(deadline.signal);
  try {
    const h = authoring();
    const adding = h.emoji.add?.("party", url);
    await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
    expect(timeout).toHaveBeenCalledWith(12_000);
    deadline.abort(new DOMException("timed out", "TimeoutError"));
    await expect(adding).rejects.toThrow("Timed out while adding emoji.");
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.emoji.snapshot().mine).toEqual([]);
  } finally {
    timeout.mockRestore();
  }
});
it("dispose fails running and queued adds without publishing", async () => {
  const h = authoring();
  const running = h.emoji.add?.("one", "https://a.test/1.png");
  const queued = h.emoji.add?.("two", "https://a.test/2.png");
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  h.dispose();
  await expect(running).rejects.toThrow("Failed to add emoji.");
  await expect(queued).rejects.toThrow("Failed to add emoji.");
  await expect(h.emoji.add?.("three", url)).rejects.toThrow(
    "Failed to add emoji.",
  );
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
});
it("serializes concurrent adds so a stale own-set read cannot drop an earlier addition", async () => {
  const h = authoring();
  const first = h.emoji.add?.("one", "https://a.test/1.png");
  const second = h.emoji.add?.("two", "https://a.test/2.png");
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  h.ownRead().respond([]);
  await first;
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  h.ownRead().respond([]); // the relay has not indexed the first yet
  await second;
  expect(h.publish.mock.calls[1]?.[0].tags).toEqual([
    ["d", EMOJI_SET],
    ["emoji", "one", "https://a.test/1.png"],
    ["emoji", "two", "https://a.test/2.png"],
  ]);
});
it("requires 30030 writing for removal and an uploader for additions", async () => {
  const h = authoring();
  const file = new File(["png"], "party.png", { type: "image/png" });
  await expect(
    h.emoji.upload?.(file, new AbortController().signal),
  ).resolves.toMatchObject({ url: "https://a.test/media/new.png" });
  expect(h.upload).toHaveBeenCalledWith(file, expect.any(AbortSignal));
  expect(authoring([7, 9]).emoji.add).toBeUndefined();
  expect(authoring([7, 9]).emoji.remove).toBeUndefined();
  expect(authoring([30030]).emoji.add).toBeTypeOf("function");
  expect(session().session.emoji.remove).toBeTypeOf("function");
  expect(session().session.emoji.add).toBeUndefined();
});
it("suggests Desktop's file-first shortcode and admits only canonical own sets", () => {
  expect(suggestShortcode("C:\\pics/Party Parrot!!.GIF")).toBe("party_parrot");
  expect(suggestShortcode("--wave--.png")).toBe("wave");
  expect(suggestShortcode("!!!.png")).toBeUndefined();
  const now = 1700000000;
  const template = {
    kind: 30030,
    created_at: now,
    content: "",
    tags: [
      ["d", EMOJI_SET],
      ["emoji", "party", url],
    ],
  };
  expect(validEmojiSetTemplate(template, now)).toBe(true);
  expect(
    validEmojiSetTemplate({ ...template, tags: [["d", EMOJI_SET]] }, now),
  ).toBe(true);
  for (const patch of [
    { kind: 30315 },
    { content: "x" },
    { created_at: now + 301 },
    { created_at: 1.5 },
    { tags: [["emoji", "party", url]] },
    {
      tags: [
        ["d", EMOJI_SET],
        ["emoji", ":party:", url],
      ],
    },
    {
      tags: [
        ["d", EMOJI_SET],
        ["emoji", "party", ""],
      ],
    },
    {
      tags: [
        ["d", EMOJI_SET],
        ["emoji", "party", `https://a.test/${"x".repeat(2048)}`],
      ],
    },
    {
      tags: [
        ["d", EMOJI_SET],
        ["emoji", "party", url],
        ["emoji", "party", url],
      ],
    },
    {
      tags: [
        ["d", EMOJI_SET],
        ["p", viewer.pubkey],
      ],
    },
  ])
    expect(validEmojiSetTemplate({ ...template, ...patch }, now)).toBe(false);
});
const catalogReads = (h: ReturnType<typeof session>) =>
  h.query.mock.calls.filter(([filters]) => filters[0]?.kinds?.includes(30030))
    .length;
const pendingCatalog = (h: ReturnType<typeof session>) => {
  const index = h.wire.pending.findIndex((p) =>
    p.filters[0]?.kinds?.includes(30030),
  );
  const [read] = index < 0 ? [] : h.wire.pending.splice(index, 1);
  if (!read) throw new Error("No pending catalog read");
  return read;
};
async function timeOut(h: ReturnType<typeof session>) {
  pendingCatalog(h).fail(new ReadError("unavailable", "Relay read timed out"));
  await vi.advanceTimersByTimeAsync(0);
  expect(h.session.emoji.snapshot()).toMatchObject({
    status: "error",
    transient: true,
  });
}
it("retries a timed-out catalog with one read per growing backoff step until it loads", async () => {
  vi.useFakeTimers();
  // The ceiling of each jittered delay.
  vi.spyOn(Math, "random").mockReturnValue(1);
  try {
    const h = session();
    void h.session.emoji.ensure("foreground");
    await vi.advanceTimersByTimeAsync(0);
    let reads = 1;
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      await timeOut(h);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(catalogReads(h)).toBe(reads);
      await vi.advanceTimersByTimeAsync(1);
      expect(catalogReads(h)).toBe(++reads);
      expect(h.session.emoji.snapshot().status).toBe("loading");
    }
    // The catalog's retry is its own: session recovery and its notice stay idle.
    expect(h.session.recovery?.snapshot()).toMatchObject({
      recovering: false,
      shown: false,
    });
    pendingCatalog(h).respond([set()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.emoji.snapshot()).toMatchObject({
      status: "ready",
      entries: [{ shortcode: "party", url }],
      error: undefined,
      transient: undefined,
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(catalogReads(h)).toBe(reads);
  } finally {
    vi.useRealTimers();
  }
});
it("leaves deterministic catalog failures to Retry and stops retrying at close", async () => {
  vi.useFakeTimers();
  try {
    const denied = session("a");
    void denied.session.emoji.ensure("foreground");
    await vi.advanceTimersByTimeAsync(0);
    pendingCatalog(denied).fail(new Error("restricted: not a member"));
    await vi.advanceTimersByTimeAsync(0);
    expect(denied.session.emoji.snapshot()).toMatchObject({
      status: "error",
      transient: undefined,
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(catalogReads(denied)).toBe(1);
    const closing = session("b");
    void closing.session.emoji.ensure("foreground");
    await vi.advanceTimersByTimeAsync(0);
    await timeOut(closing);
    closing.dispose();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(catalogReads(closing)).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});
it("credential retry leaves an unrequested catalog unread", async () => {
  const h = session();
  h.session.recovery?.retryAll();
  await flush();
  expect(catalogReads(h)).toBe(0);
  expect(h.session.emoji.snapshot().status).toBe("idle");
});
it("retries a ready catalog's timed-out refresh with growing backoff, keeping its entries", async () => {
  vi.useFakeTimers();
  // The ceiling of each jittered delay.
  vi.spyOn(Math, "random").mockReturnValue(1);
  try {
    const h = session();
    void h.session.emoji.ensure("foreground");
    await vi.advanceTimersByTimeAsync(0);
    pendingCatalog(h).respond([set()]);
    await vi.advanceTimersByTimeAsync(0);
    const loaded = h.session.emoji.snapshot().entries;
    void h.session.emoji.refresh();
    await vi.advanceTimersByTimeAsync(0);
    let reads = 2;
    for (const delay of [1_000, 2_000, 4_000]) {
      pendingCatalog(h).fail(
        new ReadError("unavailable", "Relay read timed out"),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(h.session.emoji.snapshot()).toMatchObject({
        status: "ready",
        entries: loaded,
        transient: true,
      });
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(catalogReads(h)).toBe(reads);
      await vi.advanceTimersByTimeAsync(1);
      expect(catalogReads(h)).toBe(++reads);
    }
    pendingCatalog(h).respond([set()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.emoji.snapshot()).toMatchObject({
      status: "ready",
      error: undefined,
      transient: undefined,
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(catalogReads(h)).toBe(reads);
    // A recovered refresh restarts the backoff for the next failure.
    void h.session.emoji.refresh();
    await vi.advanceTimersByTimeAsync(0);
    pendingCatalog(h).fail(
      new ReadError("unavailable", "Relay read timed out"),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(catalogReads(h)).toBe(reads + 2);
  } finally {
    vi.useRealTimers();
  }
});
it("jitters each catalog retry within the upper half of its capped delay", async () => {
  vi.useFakeTimers();
  const random = vi.spyOn(Math, "random").mockReturnValue(0);
  try {
    const h = session();
    void h.session.emoji.ensure("foreground");
    await vi.advanceTimersByTimeAsync(0);
    await timeOut(h);
    await vi.advanceTimersByTimeAsync(499);
    expect(catalogReads(h)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(catalogReads(h)).toBe(2);
    random.mockReturnValue(0.5);
    await timeOut(h);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(catalogReads(h)).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(catalogReads(h)).toBe(3);
  } finally {
    vi.useRealTimers();
  }
});
