import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createUserStatuses } from "./user-status";
import { createEmojiDirectory } from "./emoji-directory";
import { createRelaySession } from "./session";
import {
  bounds,
  keypair,
  message,
  metadata,
  profile,
  roster,
  signed,
} from "./testing";
import type { RelayEvent } from "./events";
import type { RelayReader } from "./reader";

const alice = keypair();
const bob = keypair();
const now = 1_700_000_000;
function status(text: string, emoji = "", time = now, expiresAt?: number) {
  return signed(alice, {
    kind: 30315,
    created_at: time,
    content: text,
    tags: [
      ["d", "general"],
      ...(emoji ? [["emoji", emoji]] : []),
      ...(expiresAt === undefined ? [] : [["expiration", String(expiresAt)]]),
    ],
  });
}
const beeUrl = "https://emoji.test/bee.png";
function emojiStatus(tag: string[], time = now) {
  return signed(alice, {
    kind: 30315,
    created_at: time,
    content: "Buzzin'",
    tags: [["d", "general"], tag],
  });
}
const emojiSet = signed(bob, {
  kind: 30030,
  content: "",
  tags: [
    ["d", "buzz:custom-emoji"],
    ["emoji", "bee", beeUrl],
  ],
});
const owners: ReturnType<typeof createUserStatuses>[] = [];
function setup(
  reader: RelayReader = { read: async () => [] },
  publish = vi.fn(async (_event: RelayEvent, _signal: AbortSignal) => {}),
  emojiTags?: (content: string) => string[][],
) {
  const sign = vi.fn(async (template) => signed(alice, template));
  const owner = createUserStatuses(
    reader,
    alice.pubkey,
    { kinds: [30315], sign, publish },
    undefined,
    emojiTags,
  );
  owners.push(owner);
  owner.queries.watch([alice.pubkey]);
  return { owner, queries: owner.queries, sign, publish };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now * 1000);
});
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
});

it("shares emoji-only and text-only values and preserves text when the emoji is removed", () => {
  const { owner, queries } = setup();
  const changed = vi.fn();
  queries.subscribe(changed);
  owner.accept([status("", "🚌")]);
  expect(queries.snapshot().get(alice.pubkey)).toMatchObject({
    text: "",
    emoji: "🚌",
  });
  owner.accept([status("Commuting", "🚌", now + 1)]);
  owner.accept([status("Commuting", "", now + 2)]);
  expect(queries.snapshot().get(alice.pubkey)).toMatchObject({
    text: "Commuting",
    emoji: "",
  });
  expect(changed).toHaveBeenCalledTimes(3);
});

it("keeps explicit clears as replacement evidence against stale reads and live replay", () => {
  const { owner, queries } = setup();
  owner.accept([status("Working", "🏠"), status("", "", now + 2)]);
  owner.accept([status("Late old update", "", now + 1)]);
  expect(queries.snapshot().size).toBe(0);
  owner.accept([status("New", "", now + 3)]);
  expect(queries.snapshot().get(alice.pubkey)?.text).toBe("New");
});

it("expires at the deadline, keeps the expired replacement, and filters it after restart", async () => {
  const event = status("Meeting", "🗣️", now, now + 3600);
  const { owner, queries } = setup();
  owner.accept([event]);
  const changed = vi.fn();
  queries.subscribe(changed);
  await vi.advanceTimersByTimeAsync(3599999);
  expect(queries.snapshot().size).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(queries.snapshot().size).toBe(0);
  expect(changed).toHaveBeenCalledOnce();
  owner.accept([status("Old", "", now - 1)]);
  expect(queries.snapshot().size).toBe(0);
  const restarted = setup({ read: async () => [event] });
  await vi.runAllTimersAsync();
  expect(restarted.queries.snapshot().size).toBe(0);
});

it("uses deterministic ID ordering for events in the same second", () => {
  const first = status("first"),
    second = status("second");
  const a = setup(),
    b = setup();
  a.owner.accept([first, second]);
  b.owner.accept([second, first]);
  expect(a.queries.snapshot().get(alice.pubkey)).toEqual(
    b.queries.snapshot().get(alice.pubkey),
  );
});

it("batches mounted people, refreshes after reconnect, and a late read cannot replace a live clear", async () => {
  let resolve!: (events: RelayEvent[]) => void;
  const read = vi.fn<RelayReader["read"]>(
    () =>
      new Promise<RelayEvent[]>((done) => {
        resolve = done;
      }),
  );
  const { owner, queries } = setup({ read });
  queries.watch([bob.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledOnce();
  expect(read.mock.calls[0]?.[0][0]?.authors).toEqual([
    alice.pubkey,
    bob.pubkey,
  ]);
  owner.accept([status("", "", now + 1)]);
  resolve([status("Stale")]);
  await vi.advanceTimersByTimeAsync(0);
  expect(queries.snapshot().size).toBe(0);
  owner.reconnect();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(2);
  resolve([status("Fresh", "", now + 2)]);
  await vi.advanceTimersByTimeAsync(0);
  expect(queries.snapshot().get(alice.pubkey)?.text).toBe("Fresh");
});

it("waits for publication and keeps the previous status on rejection", async () => {
  let finish!: () => void;
  const publish = vi.fn(
    (_event: RelayEvent, _signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const { owner, queries } = setup(undefined, publish);
  owner.accept([status("Before")]);
  let done = false;
  const saving = queries
    .save({ text: "After", emoji: ":party:", expiresAt: now + 86400 })
    .then(() => {
      done = true;
    });
  await vi.advanceTimersByTimeAsync(0);
  expect(done).toBe(false);
  expect(queries.snapshot().get(alice.pubkey)?.text).toBe("Before");
  finish();
  await saving;
  expect(queries.snapshot().get(alice.pubkey)).toMatchObject({
    text: "After",
    emoji: ":party:",
    expiresAt: now + 86400,
  });
  publish.mockRejectedValueOnce(new Error("Relay refused"));
  await expect(queries.save({ text: "", emoji: "" })).rejects.toThrow(
    "Relay refused",
  );
  expect(queries.snapshot().get(alice.pubkey)?.text).toBe("After");
});

it("publishes a durable clear and advances the timestamp beyond the current own status", async () => {
  const { queries, publish } = setup({
    read: async () => [status("Before", "🚌", now, now + 600)],
  });
  await queries.save({ text: "", emoji: "" });
  expect(publish.mock.calls[0]?.[0]).toMatchObject({
    kind: 30315,
    created_at: now + 1,
    content: "",
    tags: [["d", "general"]],
  });
  expect(queries.snapshot().size).toBe(0);
});

it("isolates communities and refuses malformed coordinates and past expiration", async () => {
  const a = setup(),
    b = setup();
  a.owner.accept([status("Only A")]);
  expect(b.queries.snapshot().size).toBe(0);
  a.owner.accept([
    signed(alice, {
      kind: 30315,
      created_at: now + 2,
      content: "Wrong coordinate",
      tags: [["d", "music"]],
    }),
  ]);
  expect(a.queries.snapshot().get(alice.pubkey)?.text).toBe("Only A");
  await expect(
    a.queries.save({ text: "Expired", emoji: "", expiresAt: now - 1 }),
  ).rejects.toThrow("future");
  expect(a.sign).not.toHaveBeenCalled();
});

it("disposal fences late reads, late publications, and expiration notifications", async () => {
  let finish!: () => void;
  const publish = vi.fn(
    (_event: RelayEvent, _signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const { owner, queries } = setup(undefined, publish);
  const saving = queries.save({ text: "Late", emoji: "" });
  const rejected = expect(saving).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(0);
  owner.dispose();
  finish();
  await rejected;
  expect(queries.snapshot().size).toBe(0);
});

it("reloads an author unmounted before its initial read completed", async () => {
  let finish!: (events: RelayEvent[]) => void;
  const event = signed(bob, {
    kind: 30315,
    created_at: now,
    content: "Remote",
    tags: [["d", "general"]],
  });
  const read = vi
    .fn<RelayReader["read"]>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue([event]);
  const owner = createUserStatuses({ read });
  owners.push(owner);
  const unwatch = owner.queries.watch([bob.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  unwatch();
  finish([event]);
  await vi.advanceTimersByTimeAsync(0);
  expect(owner.queries.snapshot().size).toBe(0);
  owner.queries.watch([bob.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(2);
  expect(owner.queries.snapshot().get(bob.pubkey)?.text).toBe("Remote");
});

it("keeps recently unwatched authors loaded, current from live traffic, and bounded", async () => {
  const carol = keypair();
  const remote = signed(bob, {
    kind: 30315,
    created_at: now,
    content: "Remote",
    tags: [["d", "general"]],
  });
  const read = vi.fn<RelayReader["read"]>(async ([filter]) =>
    filter?.authors?.includes(bob.pubkey) ? [remote] : [],
  );
  const owner = createUserStatuses({ read });
  owners.push(owner);
  owner.live(true);
  // Rows scroll out of view and back: nothing is read again.
  const first = owner.queries.watch([bob.pubkey, carol.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  first();
  expect(read).toHaveBeenCalledOnce();
  expect(owner.queries.snapshot().get(bob.pubkey)?.text).toBe("Remote");
  // An author read without a status takes one set while out of view.
  owner.accept([
    signed(carol, {
      kind: 30315,
      created_at: now + 1,
      content: "Live",
      tags: [["d", "general"]],
    }),
  ]);
  const unwatch = owner.queries.watch([bob.pubkey, carol.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledOnce();
  expect(owner.queries.snapshot().get(carol.pubkey)?.text).toBe("Live");
  // As many authors out of view as profiles keep bob, the oldest; one more
  // evicts that status.
  unwatch();
  const pass = (from: number, count: number) => {
    for (let n = from; n < from + count; n++)
      owner.queries.watch([n.toString(16).padStart(64, "0")])();
  };
  pass(1, 1022);
  expect(owner.queries.snapshot().has(bob.pubkey)).toBe(true);
  pass(1023, 1);
  expect(owner.queries.snapshot().has(bob.pubkey)).toBe(false);
  expect(owner.queries.snapshot().has(carol.pubkey)).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  read.mockClear();
  owner.queries.watch([bob.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledOnce();
});

it("reads an idle author again after a reconnect, which can miss live changes", async () => {
  const read = vi.fn<RelayReader["read"]>(async () => []);
  const owner = createUserStatuses({ read });
  owners.push(owner);
  owner.live(true);
  const unwatch = owner.queries.watch([bob.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  unwatch();
  owner.accept([
    signed(bob, {
      kind: 30315,
      created_at: now,
      content: "Live",
      tags: [["d", "general"]],
    }),
  ]);
  expect(owner.queries.snapshot().get(bob.pubkey)?.text).toBe("Live");
  owner.reconnect();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledOnce();
  owner.queries.watch([bob.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(2);
});

it("keeps unwatched authors loaded only while the profiles stream is live, and shown either way", async () => {
  const read = vi.fn<RelayReader["read"]>(async () => [
    signed(bob, {
      kind: 30315,
      created_at: now,
      content: "Remote",
      tags: [["d", "general"]],
    }),
  ]);
  const owner = createUserStatuses({ read });
  owners.push(owner);
  owner.live(true);
  const rows = () => {
    const unwatch = owner.queries.watch([bob.pubkey]);
    return vi.advanceTimersByTimeAsync(0).then(unwatch);
  };
  await rows();
  await rows();
  expect(read).toHaveBeenCalledOnce();
  // The stream stops: nothing keeps bob's status current, so it stays shown
  // but is read again whenever the row returns.
  owner.live(false);
  expect(owner.queries.snapshot().get(bob.pubkey)?.text).toBe("Remote");
  await rows();
  expect(read).toHaveBeenCalledTimes(2);
  await rows();
  expect(read).toHaveBeenCalledTimes(3);
  // Live again: an unwatched author stays loaded.
  owner.live(true);
  await rows();
  await rows();
  expect(read).toHaveBeenCalledTimes(4);
});

it("recovers a mounted status after a transient read failure without hot-looping", async () => {
  const read = vi
    .fn<RelayReader["read"]>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue([status("Recovered")]);
  const { queries } = setup({ read });
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(4999);
  expect(read).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
  expect(queries.snapshot().get(alice.pubkey)?.text).toBe("Recovered");
});

it.each(["dispose", "clear", "reconnect", "unwatch", "exhaust"])(
  "bounds failed-read retries through %s",
  async (transition) => {
    const read = vi
      .fn<RelayReader["read"]>()
      .mockRejectedValue(new Error("offline"));
    const owner = createUserStatuses({ read });
    owners.push(owner);
    const unwatch = owner.queries.watch([bob.pubkey]);
    await vi.advanceTimersByTimeAsync(0);
    if (transition === "unwatch") unwatch();
    else if (transition !== "exhaust")
      owner[transition as "dispose" | "clear" | "reconnect"]();
    await vi.runAllTimersAsync();
    expect(read).toHaveBeenCalledTimes(
      transition === "exhaust"
        ? 4
        : transition === "clear" || transition === "reconnect"
          ? 5
          : 1,
    );
  },
);

it("rejects oversized peer content and emoji before retaining a replacement", () => {
  const { owner, queries } = setup();
  owner.accept([status("Good")]);
  owner.accept([
    status("x".repeat(101), "", now + 1),
    status("Bad", "x".repeat(101), now + 2),
    status("Two\nlines", "", now + 3),
  ]);
  expect(queries.snapshot().get(alice.pubkey)?.text).toBe("Good");
});

it("does not sign another future update over an already future-dated coordinate", async () => {
  const { queries, sign, publish } = setup({
    read: async () => [status("Future", "", now + 301)],
  });
  await expect(queries.save({ text: "New", emoji: "" })).rejects.toThrow(
    "future",
  );
  expect(sign).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
});

it("fences an aborted save preflight before accepting its old-session result", async () => {
  let finish!: (events: RelayEvent[]) => void;
  const read = vi.fn<RelayReader["read"]>((_, options) =>
    options?.fresh
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve([]),
  );
  const { owner, queries, sign } = setup({ read });
  const saving = queries.save({ text: "New", emoji: "" });
  const rejected = expect(saving).rejects.toThrow();
  owner.clear();
  finish([status("Before purge")]);
  await rejected;
  expect(queries.snapshot().size).toBe(0);
  expect(sign).not.toHaveBeenCalled();
});

it("trims local status edits before checking limits but bounds incoming wire text before trimming", async () => {
  const { owner, queries, publish } = setup();
  await queries.save({ text: ` ${"x".repeat(100)}\n`, emoji: " 🚌\r" });
  expect(publish.mock.calls[0]?.[0]).toMatchObject({
    content: "x".repeat(100),
    tags: [
      ["d", "general"],
      ["emoji", "🚌"],
    ],
  });
  owner.accept([status(` ${"x".repeat(100)} `, "", now + 2)]);
  expect(queries.snapshot().get(alice.pubkey)?.emoji).toBe("🚌");
  owner.accept([status("Incoming", "  ", now + 3)]);
  expect(queries.snapshot().get(alice.pubkey)).toMatchObject({
    text: "Incoming",
    emoji: "",
  });
});

it.each([
  { text: "x".repeat(101), emoji: "" },
  { text: "😀".repeat(51), emoji: "" },
  { text: "", emoji: "😀".repeat(51) },
  { text: "one\ntwo", emoji: "" },
  { text: "", emoji: "one\rtwo" },
])(
  "rejects invalid status text before signing and when receiving: %j",
  async (input) => {
    const { owner, queries, sign } = setup();
    owner.accept([status("Before")]);
    owner.accept([status(input.text, input.emoji, now + 1)]);
    expect(queries.snapshot().get(alice.pubkey)?.text).toBe("Before");
    await expect(queries.save(input)).rejects.toThrow("one short line");
    expect(sign).not.toHaveBeenCalled();
  },
);

it("keeps a custom code's own image URL and ignores URLs on other values", () => {
  const { owner, queries } = setup();
  owner.accept([emojiStatus(["emoji", ":bee:", ` ${beeUrl} `])]);
  expect(queries.snapshot().get(alice.pubkey)).toMatchObject({
    emoji: ":bee:",
    emojiUrl: beeUrl,
  });
  for (const [time, tag] of [
    ["emoji", ":bee:"],
    ["emoji", "🐝", beeUrl],
    ["emoji", "bee", beeUrl],
    ["emoji", ":bee:", "javascript:alert(1)"],
    ["emoji", ":bee:", `https://emoji.test/${"x".repeat(2048)}`],
  ].entries()) {
    owner.accept([emojiStatus(tag, now + time + 1)]);
    const status = queries.snapshot().get(alice.pubkey);
    expect(status?.emoji).toBe(tag[1]);
    expect(status).not.toHaveProperty("emojiUrl");
  }
});

it("saves a catalog code with its original image URL and unicode with a two-value tag", async () => {
  const relay = keypair();
  const publish = vi.fn(async (_event: RelayEvent) => {});
  const owner = createRelaySession(
    {
      viewer: alice.pubkey,
      relayAuthor: relay.pubkey,
      media: (url) => `https://media.test/?url=${encodeURIComponent(url)}`,
      async query(filters) {
        return filters[0]?.kinds?.includes(30030) ? [emojiSet] : [];
      },
      writer: {
        kinds: [30315],
        sign: async (template) => signed(alice, template),
        publish,
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  try {
    const { emoji, statuses } = owner.session;
    await emoji.refresh();
    await statuses.save({ text: "Buzzin'", emoji: ":bee:" });
    await statuses.save({ text: "Buzzin'", emoji: "🐝" });
    expect(publish.mock.calls.map(([event]) => event.tags)).toEqual([
      [
        ["d", "general"],
        ["emoji", ":bee:", beeUrl],
      ],
      [
        ["d", "general"],
        ["emoji", "🐝"],
      ],
    ]);
  } finally {
    owner.dispose();
  }
});

const memberSet = (content: string, tags: string[][] = []) =>
  signed(bob, {
    kind: 30030,
    content,
    tags: [["d", "buzz:custom-emoji"], ...tags],
  });
it.each([
  ["no longer lists the code", "ready", memberSet("")],
  [
    "lists an unusable URL",
    "ready",
    memberSet("", [["emoji", "bee", "data:image/png;base64,AA"]]),
  ],
  ["is cold", "idle", emojiSet],
  ["is over budget", "error", memberSet("x".repeat(2 * 1024 * 1024))],
])(
  "carries a code's URL forward on a re-save when the catalog %s",
  async (_, state, set) => {
    const catalog = createEmojiDirectory({ read: async () => [set] });
    if (state !== "idle") await catalog.queries.refresh();
    expect(catalog.queries.snapshot().status).toBe(state);
    const { queries, publish } = setup(
      { read: async () => [emojiStatus(["emoji", ":bee:", beeUrl])] },
      undefined,
      catalog.tags,
    );
    await queries.save({ text: "Still buzzin'", emoji: ":bee:" });
    await queries.save({ text: "Still buzzin'", emoji: ":wasp:" });
    expect(publish.mock.calls.map(([event]) => event.tags[1])).toEqual([
      ["emoji", ":bee:", beeUrl],
      ["emoji", ":wasp:"],
    ]);
    catalog.dispose();
  },
);

it("prefers the catalog's current URL over the one a re-save carries forward", async () => {
  const newer = "https://emoji.test/bee-v2.png";
  const catalog = createEmojiDirectory({
    read: async () => [memberSet("", [["emoji", "bee", newer]])],
  });
  await catalog.queries.refresh();
  const { queries, publish } = setup(
    { read: async () => [emojiStatus(["emoji", ":bee:", beeUrl])] },
    undefined,
    catalog.tags,
  );
  await queries.save({ text: "Still buzzin'", emoji: ":bee:" });
  expect(publish.mock.calls[0]?.[0].tags[1]).toEqual(["emoji", ":bee:", newer]);
  catalog.dispose();
});

it("shows saved statuses at once, reads them again when their rows mount, and saves only shown ones", async () => {
  const carol = keypair();
  const dave = keypair();
  const bobStatus = (content: string, time: number) =>
    signed(bob, {
      kind: 30315,
      created_at: time,
      content,
      tags: [["d", "general"]],
    });
  const read = vi.fn<RelayReader["read"]>(async () => [
    bobStatus("Fresh", now + 1),
  ]);
  const owner = createUserStatuses({ read });
  owners.push(owner);
  const saved = bobStatus("Saved", now);
  owner.restore([
    saved,
    signed(carol, {
      kind: 30315,
      created_at: now,
      content: "Gone",
      tags: [
        ["d", "general"],
        ["expiration", String(now - 1)],
      ],
    }),
    signed(dave, {
      kind: 30315,
      created_at: now,
      content: "",
      tags: [["d", "general"]],
    }),
  ]);
  expect(owner.queries.snapshot().get(bob.pubkey)?.text).toBe("Saved");
  expect([...owner.queries.snapshot().keys()]).toEqual([bob.pubkey]);
  expect(owner.saved()).toEqual([saved]);
  expect(read).not.toHaveBeenCalled();
  owner.queries.watch([bob.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledOnce();
  expect(owner.queries.snapshot().get(bob.pubkey)?.text).toBe("Fresh");
  // An older copy never replaces what the relay answered.
  owner.restore([saved]);
  expect(owner.queries.snapshot().get(bob.pubkey)?.text).toBe("Fresh");
});
it("restores in the order live events replace: the same second keeps the lower ID", async () => {
  const read = vi.fn<RelayReader["read"]>(async () => []);
  const owner = createUserStatuses({ read });
  owners.push(owner);
  owner.queries.watch([bob.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  const [low, high] = ["One", "Two"]
    .map((content) =>
      signed(bob, {
        kind: 30315,
        created_at: now,
        content,
        tags: [["d", "general"]],
      }),
    )
    .sort((a, b) => a.id.localeCompare(b.id)) as [RelayEvent, RelayEvent];
  owner.accept([high]);
  owner.restore([low]);
  expect(owner.queries.snapshot().get(bob.pubkey)?.text).toBe(low.content);
  owner.accept([high]);
  expect(owner.saved()).toEqual([low]);
});
it("drops a saved status a successful read no longer returns, but not after a failure or a live event", async () => {
  const carol = keypair();
  const saved = (author: typeof bob, content: string, time = now) =>
    signed(author, {
      kind: 30315,
      created_at: time,
      content,
      tags: [["d", "general"]],
    });
  let fail = true;
  const read = vi.fn<RelayReader["read"]>(async () => {
    if (fail) throw new Error("offline");
    // Carol's live event lands while the read is out.
    owner.accept([saved(carol, "Live", now + 1)]);
    return [];
  });
  const owner = createUserStatuses({ read });
  owners.push(owner);
  owner.restore([saved(bob, "Removed"), saved(carol, "Old")]);
  owner.queries.watch([bob.pubkey, carol.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledOnce();
  expect(owner.queries.snapshot().get(bob.pubkey)?.text).toBe("Removed");
  fail = false;
  await vi.advanceTimersByTimeAsync(5000);
  expect(read).toHaveBeenCalledTimes(2);
  expect(owner.queries.snapshot().has(bob.pubkey)).toBe(false);
  expect(owner.queries.snapshot().get(carol.pubkey)?.text).toBe("Live");
  expect(owner.saved().map((event) => event.content)).toEqual(["Live"]);
});
it("prepares a channel's status images with its avatars", async () => {
  const relay = keypair();
  const created: string[] = [];
  vi.stubGlobal(
    "Image",
    class {
      decoding = "";
      set src(url: string) {
        created.push(url);
      }
    },
  );
  const owner = createRelaySession(
    {
      viewer: bob.pubkey,
      relayAuthor: relay.pubkey,
      media: (url) => `https://media.test/?url=${encodeURIComponent(url)}`,
      async query(filters) {
        const kinds = filters.flatMap((filter) => filter.kinds ?? []);
        if (kinds.includes(39002))
          return [roster(relay, "c", [bob.pubkey]), metadata(relay, "c", "C")];
        if (kinds.includes(9) && filters[0]?.["#h"])
          return [
            message(alice, "c", "hello", now),
            bounds(relay, "c", "head", { has_more: false, next_cursor: null }),
          ];
        if (kinds.includes(0)) return [profile(alice, { name: "Alice" })];
        if (kinds.includes(30315))
          return [emojiStatus(["emoji", ":bee:", beeUrl])];
        return [];
      },
    },
    {},
  );
  try {
    const { channels, statuses } = owner.session;
    channels.ensureList();
    await vi.waitFor(() => expect(channels.list().channels).toHaveLength(1));
    channels.ensure("c");
    statuses.watch([alice.pubkey]);
    await vi.waitFor(() =>
      expect(statuses.snapshot().get(alice.pubkey)?.emojiUrl).toBe(beeUrl),
    );
    channels.prepare?.("c");
    expect(created).toContain(
      `https://media.test/?url=${encodeURIComponent(beeUrl)}`,
    );
  } finally {
    owner.dispose();
    vi.unstubAllGlobals();
  }
});

it("lets a profile read's status query cover rows for its authors, with or without a status", async () => {
  const carol = keypair();
  const read = vi.fn<RelayReader["read"]>(async () => []);
  const owner = createUserStatuses({ read });
  owners.push(owner);
  owner.live(true);
  const prefetch = owner.prefetch([bob.pubkey, carol.pubkey]);
  expect(prefetch?.filter).toEqual({
    kinds: [30315],
    "#d": ["general"],
    authors: [bob.pubkey, carol.pubkey],
    limit: 2,
  });
  // Rows mount while the profile read is out.
  owner.queries.watch([bob.pubkey, carol.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  expect(read).not.toHaveBeenCalled();
  prefetch?.settle([
    signed(bob, {
      kind: 30315,
      created_at: now,
      content: "Prefetched",
      tags: [["d", "general"]],
    }),
  ]);
  await vi.advanceTimersByTimeAsync(0);
  expect(owner.queries.snapshot().get(bob.pubkey)?.text).toBe("Prefetched");
  expect(owner.queries.snapshot().has(carol.pubkey)).toBe(false);
  expect(read).not.toHaveBeenCalled();
  expect(owner.prefetch([bob.pubkey, carol.pubkey])).toBeUndefined();
});

it("leaves a failed profile read's statuses to their rows and skips statuses rows are reading", async () => {
  const carol = keypair();
  let answer!: (events: RelayEvent[]) => void;
  const read = vi.fn<RelayReader["read"]>(
    () => new Promise((resolve) => (answer = resolve)),
  );
  const owner = createUserStatuses({ read });
  owners.push(owner);
  const prefetch = owner.prefetch([bob.pubkey]);
  owner.queries.watch([bob.pubkey, carol.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledOnce();
  expect(read.mock.calls[0]?.[0][0]?.authors).toEqual([carol.pubkey]);
  // Carol's row read is out, so a profile read asks for neither.
  expect(owner.prefetch([bob.pubkey, carol.pubkey])).toBeUndefined();
  prefetch?.settle();
  answer([]);
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[1]?.[0][0]?.authors).toEqual([bob.pubkey]);
});

it("reads statuses with the profiles of bylines, so their rows read nothing more", async () => {
  const relay = keypair();
  const carol = keypair();
  const queries: (readonly { kinds?: readonly number[] }[])[] = [];
  let answer!: () => void;
  const owner = createRelaySession(
    {
      viewer: alice.pubkey,
      relayAuthor: relay.pubkey,
      media: (url) => url,
      async query(filters) {
        queries.push(filters);
        if (!filters.some((filter) => filter.kinds?.includes(0))) return [];
        await new Promise<void>((resolve) => (answer = resolve));
        return [
          signed(bob, { kind: 0, content: '{"name":"Bob"}', tags: [] }),
          signed(bob, {
            kind: 30315,
            created_at: now,
            content: "Bundled",
            tags: [["d", "general"]],
          }),
        ];
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  try {
    const { profiles, statuses } = owner.session;
    const read = profiles.ensure([bob.pubkey], "background", {
      withStatuses: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(queries.at(-1)?.map((filter) => filter.kinds)).toEqual([
      [0],
      [30315],
    ]);
    // The byline's row mounts while its profile read is out.
    const before = queries.length;
    statuses.watch([bob.pubkey]);
    await vi.advanceTimersByTimeAsync(0);
    answer();
    await read;
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.snapshot().get(bob.pubkey)?.text).toBe("Bundled");
    expect(queries.slice(before)).toEqual([]);
    // A view without bylines reads profiles alone.
    const alone = profiles.ensure([carol.pubkey], "background");
    await vi.advanceTimersByTimeAsync(0);
    answer();
    await alone;
    expect(queries.at(-1)?.map((filter) => filter.kinds)).toEqual([[0]]);
  } finally {
    owner.dispose();
  }
});

it("hands a failed prefetch's statuses to rows that mounted while it was out", async () => {
  const read = vi.fn<RelayReader["read"]>(async () => []);
  const owner = createUserStatuses({ read });
  owners.push(owner);
  const prefetch = owner.prefetch([bob.pubkey]);
  owner.queries.watch([bob.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  expect(read).not.toHaveBeenCalled();
  prefetch?.settle();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledOnce();
  expect(read.mock.calls[0]?.[0][0]?.authors).toEqual([bob.pubkey]);
});

it("lets rows read their statuses when a reconnect drops a prefetch's claim", async () => {
  const read = vi.fn<RelayReader["read"]>(async () => [
    signed(bob, {
      kind: 30315,
      created_at: now + 1,
      content: "Current",
      tags: [["d", "general"]],
    }),
  ]);
  const owner = createUserStatuses({ read });
  owners.push(owner);
  const prefetch = owner.prefetch([bob.pubkey]);
  owner.queries.watch([bob.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  expect(read).not.toHaveBeenCalled();
  owner.reconnect();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledOnce();
  // The retired read's late answer changes nothing.
  prefetch?.settle([
    signed(bob, {
      kind: 30315,
      created_at: now,
      content: "Stale",
      tags: [["d", "general"]],
    }),
  ]);
  expect(owner.queries.snapshot().get(bob.pubkey)?.text).toBe("Current");
});

it("keeps a live status or clear that lands while a prefetch is out, and drops saved ones it no longer finds", async () => {
  const carol = keypair();
  const read = vi.fn<RelayReader["read"]>(async () => []);
  const owner = createUserStatuses({ read });
  owners.push(owner);
  owner.live(true);
  const event = (key: typeof bob, content: string, time: number) =>
    signed(key, {
      kind: 30315,
      created_at: time,
      content,
      tags: [["d", "general"]],
    });
  const dave = keypair();
  owner.restore([event(carol, "Saved", now), event(dave, "Removed", now)]);
  const prefetch = owner.prefetch([bob.pubkey, carol.pubkey, dave.pubkey]);
  owner.accept([event(bob, "New", now + 1), event(carol, "", now + 1)]);
  prefetch?.settle([event(bob, "Old", now), event(carol, "Saved", now)]);
  owner.queries.watch([bob.pubkey, carol.pubkey, dave.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  expect(owner.queries.snapshot().get(bob.pubkey)?.text).toBe("New");
  expect(owner.queries.snapshot().has(carol.pubkey)).toBe(false);
  // The relay no longer has Dave's saved status.
  expect(owner.queries.snapshot().has(dave.pubkey)).toBe(false);
  expect(read).not.toHaveBeenCalled();
});

it("loads names when the relay refuses a combined read, and rows read their own statuses", async () => {
  const relay = keypair();
  const queries: (readonly { kinds?: readonly number[] }[])[] = [];
  const owner = createRelaySession(
    {
      viewer: alice.pubkey,
      relayAuthor: relay.pubkey,
      media: (url) => url,
      async query(filters) {
        queries.push(filters);
        if (filters.length > 1) throw new Error("kind 30315 refused");
        if (filters[0]?.kinds?.includes(0))
          return [
            signed(bob, { kind: 0, content: '{"name":"Bob"}', tags: [] }),
          ];
        return [
          signed(bob, {
            kind: 30315,
            created_at: now,
            content: "Alone",
            tags: [["d", "general"]],
          }),
        ];
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  try {
    const { profiles, statuses } = owner.session;
    const read = profiles.ensure([bob.pubkey], "background", {
      withStatuses: true,
    });
    statuses.watch([bob.pubkey]);
    // The names' one retry waits out the first recovery delay.
    await vi.advanceTimersByTimeAsync(1000);
    await read;
    await vi.advanceTimersByTimeAsync(0);
    expect(profiles.snapshot().get(bob.pubkey)?.name).toBe("Bob");
    expect(statuses.snapshot().get(bob.pubkey)?.text).toBe("Alone");
    expect(
      queries
        .filter((filters) =>
          filters.some((f) => f.kinds?.includes(0) || f.kinds?.includes(30315)),
        )
        .map((filters) => filters.map((f) => f.kinds)),
    ).toEqual([[[0], [30315]], [[30315]], [[0]]]);
  } finally {
    owner.dispose();
  }
});
