import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import type { ChannelMessage } from "./contracts";
import { shareMessageRows } from "./row-identity";
import { createThreadView, threadReference } from "./threads";
import { byteSize } from "./budget";
import { foldMessages } from "./fold";
import type { RelayReader } from "./reader";
import type { OutgoingEvent } from "./outbox";
import type { LiveCallbacks } from "./live";
import {
  bounds,
  flush,
  keypair,
  message,
  profile,
  roster,
  scriptedTransport,
  signed,
} from "./testing";

vi.mock("./fold", { spy: true });

const relay = keypair(),
  viewer = keypair(),
  alice = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function setup(archiveAuthority?: string) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let traffic!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    ...(archiveAuthority ? { archiveAuthority } : {}),
    subscribe(callbacks) {
      traffic = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  owners.push(owner);
  return { ...wire, ...owner, traffic };
}
const root = message(alice, "a", "Root", 1);
const replacementId = "f".repeat(64);
const membership = {
  type: "member_joined",
  actor: alice.pubkey,
  target: viewer.pubkey,
} satisfies NonNullable<ChannelMessage["membership"]>;
const attachment = {
  url: "https://example.com/original",
  kind: "video",
  mime: "video/mp4",
  size: 100,
  name: "original.mp4",
  duration: 5,
  dimensions: { width: 640, height: 360 },
  blurhash: "blur",
  previewUrl: "https://example.com/preview",
} satisfies ChannelMessage["attachments"][number];
const customEmoji = {
  shortcode: "wave",
  url: "https://example.com/wave",
} satisfies NonNullable<ChannelMessage["emoji"]>[number];
const reaction = {
  content: ":wave:",
  events: [{ id: root.id, authorId: viewer.pubkey }],
  emoji: customEmoji,
} satisfies ChannelMessage["reactions"][number];
const rowValue = (): ChannelMessage => ({
  id: root.id,
  channelId: "a",
  delivery: "sending",
  deliveryError: "pending",
  authorId: alice.pubkey,
  createdAt: 1,
  content: "Root",
  agentEnvelope: true,
  membership,
  edited: true,
  attachmentSeams: [1],
  mentions: [viewer.pubkey],
  attachments: [attachment],
  emoji: [customEmoji],
  reactions: [reaction],
  threadRootId: root.id,
  replyCount: 1,
  participants: [alice.pubkey],
});
const reply = (text: string, time: number, parent = root.id) =>
  message(alice, "a", text, time, [
    ["e", root.id, "", "root"],
    ["e", parent, "", "reply"],
  ]);
function seeded() {
  const h = setup();
  h.traffic.receive([root]);
  return { ...h, view: h.session.thread("a", root.id) };
}

it("drops shared row identity when any compared field changes", () => {
  const previous = rowValue();
  const changes: ReadonlyArray<
    readonly [string, (row: ChannelMessage) => ChannelMessage]
  > = [
    ["id", (row) => ({ ...row, id: replacementId })],
    ["channelId", (row) => ({ ...row, channelId: "b" })],
    ["delivery", (row) => ({ ...row, delivery: "failed" })],
    ["deliveryError", (row) => ({ ...row, deliveryError: "failed" })],
    ["authorId", (row) => ({ ...row, authorId: replacementId })],
    ["createdAt", (row) => ({ ...row, createdAt: 2 })],
    ["content", (row) => ({ ...row, content: "Edited" })],
    [
      "agentEnvelope",
      (row) => {
        const { agentEnvelope: _agentEnvelope, ...changed } = row;
        return changed;
      },
    ],
    [
      "membership.type",
      (row) => ({
        ...row,
        membership: { ...membership, type: "member_left" },
      }),
    ],
    [
      "membership.actor",
      (row) => ({
        ...row,
        membership: { ...membership, actor: replacementId },
      }),
    ],
    [
      "membership.target",
      (row) => ({
        ...row,
        membership: { ...membership, target: replacementId },
      }),
    ],
    [
      "edited",
      (row) => {
        const { edited: _edited, ...changed } = row;
        return changed;
      },
    ],
    [
      "attachmentSeams",
      (row) => {
        const { attachmentSeams: _seams, ...changed } = row;
        return changed;
      },
    ],
    ["attachmentSeams.offset", (row) => ({ ...row, attachmentSeams: [2] })],
    ["mentions", (row) => ({ ...row, mentions: [replacementId] })],
    [
      "attachments.url",
      (row) => ({
        ...row,
        attachments: [{ ...attachment, url: "https://example.com/new" }],
      }),
    ],
    [
      "attachments.kind",
      (row) => ({
        ...row,
        attachments: [{ ...attachment, kind: "audio" }],
      }),
    ],
    [
      "attachments.mime",
      (row) => {
        const { mime: _mime, ...changed } = attachment;
        return { ...row, attachments: [changed] };
      },
    ],
    [
      "attachments.size",
      (row) => {
        const { size: _size, ...changed } = attachment;
        return { ...row, attachments: [changed] };
      },
    ],
    [
      "attachments.name",
      (row) => {
        const { name: _name, ...changed } = attachment;
        return { ...row, attachments: [changed] };
      },
    ],
    [
      "attachments.duration",
      (row) => {
        const { duration: _duration, ...changed } = attachment;
        return { ...row, attachments: [changed] };
      },
    ],
    [
      "attachments.dimensions.width",
      (row) => ({
        ...row,
        attachments: [
          {
            ...attachment,
            dimensions: { ...attachment.dimensions, width: 800 },
          },
        ],
      }),
    ],
    [
      "attachments.dimensions.height",
      (row) => ({
        ...row,
        attachments: [
          {
            ...attachment,
            dimensions: { ...attachment.dimensions, height: 600 },
          },
        ],
      }),
    ],
    [
      "attachments.blurhash",
      (row) => {
        const { blurhash: _blurhash, ...changed } = attachment;
        return { ...row, attachments: [changed] };
      },
    ],
    [
      "attachments.previewUrl",
      (row) => {
        const { previewUrl: _previewUrl, ...changed } = attachment;
        return { ...row, attachments: [changed] };
      },
    ],
    [
      "emoji.shortcode",
      (row) => ({
        ...row,
        emoji: [{ ...customEmoji, shortcode: "new" }],
      }),
    ],
    [
      "emoji.url",
      (row) => ({
        ...row,
        emoji: [{ ...customEmoji, url: "https://example.com/new" }],
      }),
    ],
    [
      "reactions.content",
      (row) => ({
        ...row,
        reactions: [{ ...reaction, content: ":new:" }],
      }),
    ],
    [
      "reactions.emoji.shortcode",
      (row) => ({
        ...row,
        reactions: [
          {
            ...reaction,
            emoji: { ...customEmoji, shortcode: "new" },
          },
        ],
      }),
    ],
    [
      "reactions.emoji.url",
      (row) => ({
        ...row,
        reactions: [
          {
            ...reaction,
            emoji: { ...customEmoji, url: "https://example.com/new" },
          },
        ],
      }),
    ],
    [
      "reactions.events.id",
      (row) => ({
        ...row,
        reactions: [
          {
            ...reaction,
            events: [{ id: replacementId, authorId: viewer.pubkey }],
          },
        ],
      }),
    ],
    [
      "reactions.events.authorId",
      (row) => ({
        ...row,
        reactions: [
          { ...reaction, events: [{ id: root.id, authorId: alice.pubkey }] },
        ],
      }),
    ],
    [
      "reactions.events.count",
      (row) => ({ ...row, reactions: [{ ...reaction, events: [] }] }),
    ],
    ["threadRootId", (row) => ({ ...row, threadRootId: replacementId })],
    ["replyParentId", (row) => ({ ...row, replyParentId: replacementId })],
    [
      "mediaTargetUrl",
      (row) => ({ ...row, mediaTargetUrl: "https://example.com/other.mp4" }),
    ],
    ["replyCount", (row) => ({ ...row, replyCount: 2 })],
    ["participants", (row) => ({ ...row, participants: [replacementId] })],
  ];

  expect(shareMessageRows([previous], [rowValue()])[0]).toBe(previous);
  for (const [field, change] of changes) {
    expect(
      shareMessageRows([previous], [change(rowValue())])[0],
      field,
    ).not.toBe(previous);
  }
});

it("seeds a thread root and observed replies synchronously from retained session data", async () => {
  const h = setup();
  h.traffic.receive([roster(relay, "a", [viewer.pubkey])]);
  h.session.channels.ensure("a");
  h.next().respond([
    root,
    bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
  ]);
  await flush();
  expect(h.session.channels.window("a").rows.map((row) => row.id)).toEqual([
    root.id,
  ]);
  const observedReply = reply("Observed reply", 2);
  h.traffic.receive([observedReply]);

  const view = h.session.thread("a", root.id);
  expect(view.snapshot().root?.id).toBe(root.id);
  expect(view.snapshot().replies.map((row) => row.id)).toEqual([
    observedReply.id,
  ]);
});

it("resolves canonical marked ancestry, never arbitrary references or a lone root", () => {
  const tags = (extra: string[][]) => message(alice, "a", "test", 1, extra);
  expect(threadReference(tags([["e", root.id]]))).toBeUndefined();
  expect(threadReference(tags([["e", root.id, "", "root"]]))).toBeUndefined();
  expect(threadReference(tags([["e", root.id, "", "reply"]]))).toEqual({
    rootId: root.id,
    parentId: root.id,
  });
  expect(
    threadReference(
      tags([
        ["e", root.id, "", "reply"],
        ["e", "bad", "", "reply"],
      ]),
    )?.rootId,
  ).toBe(root.id);
  const nested = reply("nested", 3, "a".repeat(64));
  expect(threadReference(nested)).toEqual({
    rootId: root.id,
    parentId: "a".repeat(64),
  });
});

it("keeps exact forward page cursors separate from concurrent live rows and auxiliary timestamps", async () => {
  const h = seeded();
  const first = reply("first", 10),
    second = reply("second", 20),
    live = reply("live", 100);
  const loading = h.view.refresh();
  const page = h.next();
  expect(page.filters).toEqual([
    { ids: [root.id], "#h": ["a"], limit: 1 },
    {
      kinds: [40002, 40008, 9],
      "#h": ["a"],
      "#e": [root.id],
      depth_limit: 100,
      include_aux: true,
      limit: 50,
    },
  ]);
  h.traffic.receive([live]);
  page.respond([
    root,
    first,
    second,
    signed(alice, {
      kind: 40003,
      content: "edited",
      created_at: 200,
      tags: [["e", first.id]],
    }),
  ]);
  await loading;
  expect(h.view.snapshot().replies.map((row) => row.content)).toEqual([
    "edited",
    "second",
    "live",
  ]);
  const more = h.view.loadMore();
  const next = h.next();
  expect(next.filters[1]).toMatchObject({
    thread_cursor: 20,
    thread_cursor_id: second.id,
  });
  next.respond([root, reply("third", 30)]);
  await more;
  expect(h.view.snapshot().replies.map((row) => row.createdAt)).toEqual([
    10, 20, 30, 100,
  ]);
});

it("pages same-second ties, counts non-rendered content and keeps short pages continuable", async () => {
  const h = seeded();
  const tied = [reply("one", 10), reply("two", 10)].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const first = h.view.refresh();
  h.next().respond([root, ...tied]);
  await first;
  const more = h.view.loadMore();
  const page = h.next();
  expect(page.filters[1]).toMatchObject({
    thread_cursor: 10,
    thread_cursor_id: tied[1]?.id,
  });
  const other = signed(alice, {
    kind: 45003,
    content: "other content kind",
    created_at: 11,
    tags: [
      ["h", "a"],
      ["e", root.id, "", "reply"],
    ],
  });
  page.respond([root, other]);
  await more;
  expect(h.view.snapshot().canLoadMore).toBe(true);
  const end = h.view.loadMore();
  const empty = h.next();
  expect(empty.filters[1]).toMatchObject({
    thread_cursor: 11,
    thread_cursor_id: other.id,
  });
  empty.respond([root]);
  await end;
  expect(h.view.snapshot()).toMatchObject({
    status: "ready",
    canLoadMore: false,
    limited: false,
  });
});

it("resolves a selected broadcast reply to its actual root", async () => {
  const h = setup();
  const selected = reply("nested", 3, "b".repeat(64));
  const view = h.session.thread("a", selected.id);
  const loading = view.refresh();
  h.next().respond([selected]);
  await flush();
  const page = h.next();
  expect(page.filters[1]?.["#e"]).toEqual([root.id]);
  page.respond([root, selected]);
  await loading;
  expect(view.snapshot().root?.id).toBe(root.id);
});

it("preserves folded identities across status changes and extends them across pages", async () => {
  const h = seeded();
  const first = reply("first", 10);
  const initial = h.view.refresh();
  const request = h.next();
  const loading = h.view.snapshot();
  request.respond([root, first]);
  await initial;

  const ready = h.view.snapshot();
  expect(ready.root).toBe(loading.root);
  const retainedRoot = ready.root;
  const retainedReply = ready.replies[0];
  const retainedReplies = ready.replies;

  const more = h.view.loadMore();
  expect(h.view.snapshot()).toMatchObject({ status: "loading" });
  expect(h.view.snapshot().root).toBe(retainedRoot);
  expect(h.view.snapshot().replies).toBe(retainedReplies);
  const second = reply("second", 20);
  h.next().respond([root, second]);
  await more;

  expect(h.view.snapshot().root).toBe(retainedRoot);
  expect(h.view.snapshot().replies[0]).toBe(retainedReply);
  expect(h.view.snapshot().replies.map((row) => row.content)).toEqual([
    "first",
    "second",
  ]);
});

it("preserves folded identities when a page fails", async () => {
  const h = seeded();
  const first = reply("first", 10);
  const initial = h.view.refresh();
  h.next().respond([root, first]);
  await initial;
  const ready = h.view.snapshot();

  const more = h.view.loadMore();
  expect(h.view.snapshot().root).toBe(ready.root);
  expect(h.view.snapshot().replies).toBe(ready.replies);
  h.next().fail(new Error("offline"));
  await more;

  expect(h.view.snapshot()).toMatchObject({ status: "error" });
  expect(h.view.snapshot().root).toBe(ready.root);
  expect(h.view.snapshot().replies).toBe(ready.replies);
});

it("does not invalidate folded content for duplicate or unrelated live traffic", async () => {
  const h = seeded();
  const first = reply("first", 10);
  const loading = h.view.refresh();
  h.next().respond([root, first]);
  await loading;
  const before = h.view.snapshot();

  h.traffic.receive([
    first,
    message(alice, "b", "another channel", 11),
    message(alice, "a", "not a reply", 12),
  ]);

  expect(h.view.snapshot().root).toBe(before.root);
  expect(h.view.snapshot().replies).toBe(before.replies);
});

it("updates nested replies and reply-targeted overlays without a new socket or arbitrary e-tag matches", async () => {
  const h = seeded();
  const parent = reply("parent", 10),
    child = reply("child", 11, parent.id);
  const loading = h.view.refresh();
  h.next().respond([root, parent]);
  await loading;
  h.traffic.receive([
    child,
    message(alice, "a", "reference only", 12, [["e", root.id]]),
    message(alice, "b", "wrong channel", 12, [["e", root.id, "", "reply"]]),
  ]);
  const edit = signed(alice, {
    kind: 40003,
    content: "child edited",
    tags: [["e", child.id]],
  });
  h.traffic.receive([edit]);
  expect(h.view.snapshot().replies.map((row) => row.content)).toEqual([
    "parent",
    "child edited",
  ]);
  h.traffic.receive([
    signed(alice, { kind: 5, content: "", tags: [["e", child.id]] }),
  ]);
  expect(h.view.snapshot().replies.map((row) => row.content)).toEqual([
    "parent",
  ]);
});

it("purges atomically on access loss, fences late results and allows explicit regrant recovery", async () => {
  const h = seeded();
  h.traffic.receive([roster(relay, "a", [viewer.pubkey], 10)]);
  const loading = h.view.refresh();
  const stale = h.next();
  h.traffic.receive([roster(relay, "a", [], 11)]);
  expect(stale.signal?.aborted).toBe(true);
  expect(h.view.snapshot().root).toBeUndefined();
  expect(h.view.snapshot().replies).toEqual([]);
  h.traffic.receive([roster(relay, "a", [viewer.pubkey], 12)]);
  stale.respond([root, reply("late", 10)]);
  await loading;
  expect(h.view.snapshot().replies).toEqual([]);
  const fresh = h.view.refresh();
  h.next().respond([root]);
  await flush();
  h.next().respond([root, reply("fresh", 13)]);
  await fresh;
  expect(h.view.snapshot().replies.map((row) => row.content)).toEqual([
    "fresh",
  ]);
});

it("disposes pending work and never allocates beyond the shared owned-view budget", async () => {
  const h = seeded();
  const loading = h.view.refresh();
  const pending = h.next();
  h.view.dispose();
  expect(pending.signal?.aborted).toBe(true);
  pending.respond([root]);
  await loading;
  for (let i = 0; i < 64; i++) h.session.thread("a", root.id);
  expect(() => h.session.thread("a", root.id)).toThrow("capacity");
});

it("repairs retained thread pages through the real channel-established catch-up path without head invalidation cancelling traversal", async () => {
  const h = seeded();
  h.traffic.receive([
    roster(relay, "a", [viewer.pubkey]),
    profile(alice, { name: "Alice" }),
  ]);
  h.session.channels.ensure("a");
  h.next().respond([
    bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
  ]);
  await flush();
  const first = h.view.refresh();
  h.next().respond([root, reply("old", 10)]);
  await first;
  const more = h.view.loadMore();
  h.next().respond([root, reply("later", 20)]);
  await more;
  h.traffic.established("b");
  expect(h.pending).toHaveLength(0);
  h.traffic.state({ status: "connected", routes: [] });
  h.traffic.state({ status: "retrying", routes: [] });
  h.traffic.state({ status: "connected", routes: [] });
  h.traffic.established("a");
  const repair = h.next();
  await flush(); // EOSE queues the actual retained channel catch-up.
  const head = h.next();
  expect(head.filters[0]?.depth_limit).toBeUndefined();
  expect(head.filters[0]?.["#h"]).toEqual(["a"]);
  expect(repair.signal?.aborted).toBe(false);
  head.respond([
    bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
  ]);
  repair.respond([root, reply("old", 10), reply("missed", 15)]);
  await flush();
  const next = h.next();
  expect(next.filters[1]?.thread_cursor).toBe(15);
  next.respond([root, reply("later", 20)]);
  await flush();
  expect(h.view.snapshot().replies.map((row) => row.content)).toEqual([
    "old",
    "missed",
    "later",
  ]);
});

it("repairs a ready thread on stream establishment without notifying when nothing changed, then runs an older page requested meanwhile", async () => {
  const h = seeded();
  const first = h.view.refresh();
  h.next().respond([root, reply("old", 10)]);
  await first;
  const ready = h.view.snapshot();
  const statuses: string[] = [];
  const stop = h.view.subscribe(() => statuses.push(h.view.snapshot().status));

  h.traffic.established("a");
  const repair = h.next();
  expect(h.view.snapshot()).toBe(ready);
  const more = h.view.loadMore();
  expect(h.pending).toHaveLength(0);
  repair.respond([root, reply("old", 10)]);
  await flush();
  // The unchanged repair published nothing; only the queued page shows loading.
  expect(statuses).toEqual(["loading"]);
  expect(h.view.snapshot()).toMatchObject({ readKind: "older" });
  expect(h.view.snapshot().replies).toBe(ready.replies);

  const page = h.next();
  expect(page.filters[1]?.thread_cursor).toBe(10);
  page.respond([root, reply("later", 20)]);
  await more;
  await flush();
  expect(h.view.snapshot().replies.map((row) => row.content)).toEqual([
    "old",
    "later",
  ]);
  expect(statuses.at(-1)).toBe("ready");
  stop();
});

it("keeps a failed establishment repair visible and drops the older page requested meanwhile", async () => {
  const h = seeded();
  const first = h.view.refresh();
  h.next().respond([root, reply("old", 10)]);
  await first;

  h.traffic.established("a");
  const repair = h.next();
  void h.view.loadMore();
  repair.fail(new Error("offline"));
  await flush();
  expect(h.pending).toHaveLength(0);
  expect(h.view.snapshot()).toMatchObject({ status: "error" });
  expect(h.view.snapshot().error).toContain("offline");
});

it("offers retry on failures and rejects a non-advancing cursor without erasing readable rows", async () => {
  const h = seeded();
  const first = h.view.refresh();
  h.next().fail(new Error("offline"));
  await first;
  expect(h.view.snapshot()).toMatchObject({
    status: "error",
    root: { id: root.id },
  });
  const retry = h.view.refresh();
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  const one = reply("one", 10);
  h.next().respond([root, one]);
  await retry;
  const more = h.view.loadMore();
  h.next().respond([root, one]);
  await more;
  expect(h.view.snapshot().error).toContain("did not advance");
  expect(h.view.snapshot().replies).toHaveLength(1);
});

it("drops stale root content when the finite root is missing and exposes explicit page limits", async () => {
  const h = seeded();
  const missing = h.view.refresh();
  h.next().respond([]);
  await missing;
  expect(h.view.snapshot().root).toBeUndefined();
  const retry = h.view.refresh();
  h.next().respond([root, reply("1", 10)]);
  await retry;
  for (let page = 2; page <= 10; page++) {
    const more = h.view.loadMore();
    h.next().respond([root, reply(String(page), page * 10)]);
    await more;
  }
  expect(h.view.snapshot()).toMatchObject({
    limited: true,
    canLoadMore: false,
  });
  await h.view.loadMore();
  expect(h.pending).toHaveLength(0);
});

it("explicitly limits oversized evidence rather than evicting aux and resurrecting deleted rows", async () => {
  const h = seeded();
  const loading = h.view.refresh();
  h.next().respond([root, reply("x".repeat(4 * 1024 * 1024), 2)]);
  await loading;
  expect(h.view.snapshot()).toMatchObject({
    status: "error",
    limited: true,
    canLoadMore: false,
    root: undefined,
    replies: [],
  });
});

it("trips the live byte limit at exactly the whole-thread serialised size", async () => {
  const h = seeded();
  const first = reply("first", 10);
  const loading = h.view.refresh();
  h.next().respond([root, first]);
  await loading;
  const limit = 4 * 1024 * 1024;
  const sized = (length: number) => reply("x".repeat(length), 11);
  const fits = sized(limit - byteSize([root, first, sized(0)]));
  expect(byteSize([root, first, fits])).toBe(limit);
  h.traffic.receive([fits]);
  expect(h.view.snapshot()).toMatchObject({ status: "ready", limited: false });
  expect(h.view.snapshot().replies).toHaveLength(2);
  h.traffic.receive([reply("y", 12)]);
  expect(h.view.snapshot()).toMatchObject({
    status: "error",
    limited: true,
    replies: [],
  });
});

it("checks live overlays against retained thread targets after shared-cache eviction, without allowing orphan or denied targets", async () => {
  const h = seeded();
  const row = reply("retained", 10);
  const first = h.view.refresh();
  h.next().respond([root, row]);
  await first;
  // Byte budget eviction with a few large, unrelated verified events.
  h.traffic.receive(
    Array.from({ length: 9 }, (_, i) =>
      message(alice, "b", "x".repeat(1024 * 1024), 100 + i),
    ),
  );
  expect(h.view.snapshot().replies[0]?.content).toBe("retained");
  const edit = signed(alice, {
    kind: 40003,
    content: "edited after eviction",
    tags: [["e", row.id]],
  });
  h.traffic.receive([edit]);
  expect(h.view.snapshot().replies[0]?.content).toBe("edited after eviction");
  h.traffic.receive([
    signed(alice, {
      kind: 5,
      content: "",
      tags: [
        ["e", row.id],
        ["e", "a".repeat(64)],
      ],
    }),
  ]);
  expect(h.view.snapshot().replies).toHaveLength(1);
  h.traffic.receive([
    signed(alice, { kind: 5, content: "", tags: [["e", row.id]] }),
  ]);
  expect(h.view.snapshot().replies).toEqual([]);
  h.traffic.receive([roster(relay, "a", [], 200)]);
  h.traffic.receive([edit]);
  const raw = h.session.read([{ ids: [edit.id], limit: 1 }]);
  h.next().respond([edit]);
  expect(await raw).toEqual([]);
  expect(h.view.snapshot().root).toBeUndefined();
});

it("keeps pre-refresh live tombstones and edits when a stale finite repair omits them", async () => {
  const h = seeded();
  const deleted = reply("deleted", 10),
    edited = reply("original", 11);
  const first = h.view.refresh();
  h.next().respond([root, deleted, edited]);
  await first;
  h.traffic.receive([
    signed(alice, { kind: 5, content: "", tags: [["e", deleted.id]] }),
    signed(alice, { kind: 40003, content: "edited", tags: [["e", edited.id]] }),
  ]);
  expect(h.view.snapshot().replies.map((row) => row.content)).toEqual([
    "edited",
  ]);
  const refresh = h.view.refresh();
  h.next().respond([root, deleted, edited]);
  await refresh;
  expect(h.view.snapshot().replies.map((row) => row.content)).toEqual([
    "edited",
  ]);
});

it("keeps deleted edits and reactions removed, including a delete-of-aux arriving before its target in a page", async () => {
  const h = seeded();
  const row = reply("original", 10);
  const edit = signed(alice, {
    kind: 40003,
    content: "edited",
    tags: [["e", row.id]],
  });
  const reaction = signed(viewer, {
    kind: 7,
    content: "+",
    tags: [["e", row.id]],
  });
  const removeEdit = signed(alice, {
    kind: 5,
    content: "",
    tags: [["e", edit.id]],
  });
  const first = h.view.refresh();
  h.next().respond([root, row, removeEdit, edit, reaction]);
  await first;
  expect(h.view.snapshot().replies[0]).toMatchObject({
    content: "original",
    reactions: [{ content: "+" }],
  });
  h.traffic.receive([
    signed(alice, { kind: 5, content: "", tags: [["e", reaction.id]] }),
  ]);
  expect(h.view.snapshot().replies[0]?.reactions).toEqual([
    { content: "+", events: [{ id: reaction.id, authorId: viewer.pubkey }] },
  ]);
  h.traffic.receive([
    signed(viewer, { kind: 5, content: "", tags: [["e", reaction.id]] }),
  ]);
  expect(h.view.snapshot().replies[0]?.reactions).toEqual([]);
});

it("does not lose tombstones through missing-root recovery, and clears handles on cache/session disposal", async () => {
  const h = seeded();
  const row = reply("deleted", 10);
  const first = h.view.refresh();
  h.next().respond([root, row]);
  await first;
  h.traffic.receive([
    signed(alice, { kind: 5, content: "", tags: [["e", row.id]] }),
  ]);
  const missing = h.view.refresh();
  h.next().respond([]);
  await missing;
  expect(h.view.snapshot().root).toBeUndefined();
  const retry = h.view.refresh();
  h.next().respond([root, row]);
  await retry;
  expect(h.view.snapshot().root?.id).toBe(root.id);
  expect(h.view.snapshot().replies).toEqual([]);
  const pending = h.view.refresh();
  const stale = h.next();
  await h.clearCache();
  expect(stale.signal?.aborted).toBe(true);
  await pending;
  expect(h.view.snapshot().root).toBeUndefined();
  const disposed = h.view.refresh();
  const read = h.next();
  h.dispose();
  expect(read.signal?.aborted).toBe(true);
  await disposed;
  h.traffic.receive([root, row]);
  expect(h.view.snapshot().root).toBeUndefined();
});

it.each([
  ["explicit NIP-11 self", relay.pubkey, alice.pubkey],
  ["contact-key fallback", undefined, relay.pubkey],
])(
  "attributes relay-signed workflow output only under an %s",
  async (_, authority, author) => {
    const h = setup(authority);
    const output = signed(relay, {
      kind: 9,
      content: "Scheduled",
      created_at: 1,
      tags: [
        ["p", alice.pubkey],
        ["h", "a"],
        ["buzz:workflow", "true"],
      ],
    });
    h.traffic.receive([roster(relay, "a", [viewer.pubkey])]);
    h.session.channels.ensure("a");
    h.next().respond([
      output,
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    expect(h.session.channels.window("a").rows[0]?.authorId).toBe(author);
    expect(h.session.thread("a", output.id).snapshot().root?.authorId).toBe(
      author,
    );
  },
);

it("re-folds for local operations and profiles only when the thread's own change", () => {
  const agent = keypair();
  const answer = signed(agent, {
    kind: 9,
    content: "Whole answer",
    created_at: 2,
    tags: reply("", 2).tags,
  });
  const edit = signed(alice, {
    kind: 40003,
    content: "Spoken",
    created_at: 3,
    tags: [
      ["h", "a"],
      ["e", answer.id],
    ],
  });
  let owner: string | undefined;
  const elsewhere: OutgoingEvent = {
    event: message(viewer, "b", "Elsewhere", 4),
    delivery: "sending",
  };
  let operations = [elsewhere];
  const thread = createThreadView({
    channelId: "a",
    messageId: root.id,
    relayAuthor: relay.pubkey,
    agentOwner: () => owner,
    reader: {} as RelayReader,
    seed: root,
    local: { snapshot: () => operations, subscribe: () => () => {} },
    canAccess: () => true,
    visible: (events) => events,
    notify: (listener) => listener(),
  });
  thread.receive([answer, edit]);
  const content = (id: string) =>
    thread.view.snapshot().replies.find((row) => row.id === id)?.content;
  expect(content(answer.id)).toBe("Whole answer");
  const listener = vi.fn();
  thread.view.subscribe(listener);
  vi.mocked(foldMessages).mockClear();
  // Another conversation's send settles, and an unrelated profile arrives.
  operations = [{ ...elsewhere, delivery: "accepted" }];
  thread.localChanged();
  thread.ownersChanged();
  expect(foldMessages).not.toHaveBeenCalled();
  expect(listener).not.toHaveBeenCalled();
  // The agent's owner is verified: their edit now applies.
  owner = alice.pubkey;
  thread.ownersChanged();
  expect(content(answer.id)).toBe("Spoken");
  // A reply sent in this thread appears with its delivery.
  const sending = reply("Mine", 5);
  operations = [...operations, { event: sending, delivery: "sending" }];
  thread.localChanged();
  expect(content(sending.id)).toBe("Mine");
  expect(foldMessages).toHaveBeenCalledTimes(2);
  expect(listener).toHaveBeenCalledTimes(2);
  // The same operations in a new snapshot change nothing.
  operations = [...operations];
  thread.localChanged();
  expect(foldMessages).toHaveBeenCalledTimes(2);
});
