import { createHash } from "node:crypto";
import { assert, afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { connectBrokerTransport } from "./transport";
import type { ReadFilter, RelayEvent } from "./events";
import type { LiveCallbacks } from "./live";
import { keypair, message, roster, signed } from "./testing";
import { threadBinding, threadAuthority } from "./thread-window";
import { createThreadView, type ThreadResume } from "./threads";

const channel = "00000000-0000-0000-0000-000000000000";
const origin = "https://relay.example:8443";
const relay = keypair(),
  viewer = keypair(),
  author = keypair();
const root = message(author, channel, "root", 1);
const reply = (n: number) =>
  message(author, channel, `reply ${n}`, 10 + Math.floor(n / 3), [
    ["e", root.id, "", "reply"],
  ]);
// Independent encoder: do not sign fixture bounds with the client's implementation.
function bounds(
  filter: ReadFilter,
  cursor: { created_at: number; id: string } | null = null,
  patch: Record<string, unknown> = {},
  key = relay,
) {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "tw",
        1,
        "older",
        "relay.example:8443",
        viewer.pubkey,
        channel,
        root.id,
        filter.limit,
        filter.depth_limit ?? 100,
        [...new Set(filter.kinds)].sort((a, b) => a - b),
        filter.until === undefined ? null : [filter.until, filter.before_id],
        filter.include_aux ?? false,
      ]),
    )
    .digest("hex");
  return signed(key, {
    kind: 39007,
    tags: [
      ["d", `tw:1:${digest}`],
      ["h", channel],
      ["e", root.id],
    ],
    content: JSON.stringify({
      version: 1,
      direction: "older",
      has_more: cursor !== null,
      next_cursor: cursor,
      ...patch,
    }),
  });
}
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  vi.unstubAllGlobals();
});
async function setup(
  answer: (
    filter: ReadFilter,
  ) => readonly RelayEvent[] | Promise<readonly RelayEvent[]>,
) {
  const requests: ReadFilter[][] = [];
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/session"))
      return Response.json({
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        relayUrl: origin,
      });
    const filters = JSON.parse(options?.body as string) as ReadFilter[];
    requests.push(filters);
    return Response.json((await Promise.all(filters.map(answer))).flat());
  });
  vi.stubGlobal("fetch", fetcher);
  const transport = await connectBrokerTransport();
  let traffic!: LiveCallbacks;
  const owner = createRelaySession({
    ...transport,
    subscribe(callbacks) {
      traffic = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  cleanup.push(owner.dispose);
  traffic.receive([root, roster(relay, channel, [viewer.pubkey])]);
  return {
    ...owner,
    traffic,
    requests,
    fetcher,
    view: owner.session.thread(channel, root.id),
    transport,
  };
}
it("matches the Rust binding vector and normalized authority, including IPv6 and ports", async () => {
  expect(
    await threadBinding(
      {
        thread_window: true,
        "#h": [channel],
        "#e": ["ab".repeat(32)],
        kinds: [9],
        limit: 50,
      },
      "https://Relay.Example.:443",
      "ab".repeat(32),
    ),
  ).toBe(
    "tw:1:5252322dfd797ddb1d5f1150acd4cf914b9fc09e39bcf3048d25aed514b3546d",
  );
  expect(threadAuthority("wss://RELAY.example.:8443")).toBe(
    "relay.example.:8443",
  );
  expect(threadAuthority("http://[::1]:3000")).toBe("[::1]:3000");
});
it("pages 303 tied replies newest-first, deduplicates live rows and repairs retained overlays", async () => {
  const rows = Array.from({ length: 303 }, (_, n) => reply(n));
  const newest = [...rows].sort(
    (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
  );
  const late = message(author, channel, "live", 999, [
    ["e", root.id, "", "reply"],
  ]);
  const oldest = rows[0];
  const latest = newest[0];
  assert.exists(oldest);
  assert.exists(latest);
  let overlays: RelayEvent[] = [];
  const h = await setup((f) => {
    if (f.ids) return [root];
    expect(f.thread_window).toBe(true);
    expect(f.thread_cursor).toBeUndefined();
    const eligible = newest.filter(
      (e) =>
        f.until === undefined ||
        e.created_at < f.until ||
        (e.created_at === f.until && e.id > (f.before_id ?? "")),
    );
    const page = eligible.slice(0, f.limit);
    const last = page.at(-1);
    assert.exists(last);
    return [
      ...page,
      ...overlays.filter((e) =>
        e.tags.some(([k, id]) => k === "e" && page.some((r) => r.id === id)),
      ),
      bounds(
        f,
        eligible.length > page.length
          ? { created_at: last.created_at, id: last.id }
          : null,
      ),
    ];
  });
  await h.view.refresh();
  expect(h.view.snapshot()).toMatchObject({
    status: "ready",
    direction: "older",
    canLoadMore: true,
  });
  expect(new Set(h.view.snapshot().replies.map((e) => e.id))).toEqual(
    new Set(newest.slice(0, 10).map((e) => e.id)),
  );
  h.traffic.receive([late, latest]);
  while (h.view.snapshot().canLoadMore) await h.view.loadMore();
  expect(h.view.snapshot()).toMatchObject({ status: "ready", limited: false });
  expect(h.view.snapshot().replies.map((e) => e.id)).toEqual(
    [...rows, late]
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
      .map((e) => e.id),
  );
  const windows = h.requests.filter(([f]) => f?.thread_window);
  expect(windows).toHaveLength(7);
  expect(windows.map(([f]) => f?.limit)).toEqual([10, 50, 50, 50, 50, 50, 50]);
  expect(windows.every(([f]) => f?.include_aux === true)).toBe(true);
  // The relay's window row allowlist rejects legacy diff kind 40008.
  expect(
    h.requests
      .filter(([f]) => f?.thread_window)
      .every(([f]) => !f?.kinds?.includes(40008)),
  ).toBe(true);
  expect(h.requests.every((filters) => filters.length === 1)).toBe(true);
  overlays = [
    signed(author, {
      kind: 40003,
      created_at: 1000,
      content: "edited oldest",
      tags: [["e", oldest.id]],
    }),
  ];
  const beforeRepair = h.requests.length;
  await h.view.refresh();
  const repair = h.requests.slice(beforeRepair);
  expect(repair).toHaveLength(8);
  expect(repair[0]).toEqual([{ ids: [root.id], "#h": [channel], limit: 1 }]);
  expect(repair.slice(1).every(([filter]) => filter?.thread_window)).toBe(true);
  expect(repair.slice(1).map(([filter]) => filter?.limit)).toEqual([
    10, 50, 50, 50, 50, 50, 50,
  ]);
  expect(repair.every((filters) => filters.length === 1)).toBe(true);
  expect(
    h.view.snapshot().replies.find((r) => r.id === oldest.id)?.content,
  ).toBe("edited oldest");
  const edit = overlays[0];
  assert.exists(edit);
  h.traffic.receive([
    signed(author, {
      kind: 5,
      content: "",
      created_at: 1001,
      tags: [["e", edit.id]],
    }),
  ]);
  expect(
    h.view.snapshot().replies.find((r) => r.id === oldest.id)?.content,
  ).toBe(oldest.content);
});
it("pages older to a read frontier in one read, revalidating the root once", async () => {
  const newest = Array.from({ length: 303 }, (_, n) => reply(n)).sort(
    (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
  );
  const h = await setup((f) => {
    if (f.ids) return [root];
    const eligible = newest.filter(
      (e) =>
        f.until === undefined ||
        e.created_at < f.until ||
        (e.created_at === f.until && e.id > (f.before_id ?? "")),
    );
    const page = eligible.slice(0, f.limit);
    const last = page.at(-1);
    assert.exists(last);
    return [
      ...page,
      bounds(
        f,
        eligible.length > page.length
          ? { created_at: last.created_at, id: last.id }
          : null,
      ),
    ];
  });
  await h.view.refresh();
  const before = h.requests.length;
  await h.view.loadMore(() => 50);
  const read = h.requests.slice(before);
  expect(read[0]).toEqual([{ ids: [root.id], "#h": [channel], limit: 1 }]);
  expect(read.slice(1).map(([f]) => f?.limit)).toEqual([50, 50, 50, 50]);
  expect(h.view.snapshot()).toMatchObject({
    status: "ready",
    canLoadMore: true,
  });
  expect(h.view.snapshot().replies[0]?.createdAt).toBeLessThanOrEqual(50);
});
// A strict-window relay over `replies`, newest first.
const pagedThread =
  (replies: readonly RelayEvent[]) =>
  (f: ReadFilter): readonly RelayEvent[] => {
    if (f.ids) return [root];
    const eligible = replies.filter(
      (e) =>
        f.until === undefined ||
        e.created_at < f.until ||
        (e.created_at === f.until && e.id > (f.before_id ?? "")),
    );
    const page = eligible.slice(0, f.limit);
    const last = page.at(-1);
    return [
      ...page,
      bounds(
        f,
        last && eligible.length > page.length
          ? { created_at: last.created_at, id: last.id }
          : null,
      ),
    ];
  };
it("reads a shallow frontier without loading large older replies", async () => {
  const large = "x".repeat(30 * 1024);
  const replies = Array.from({ length: 210 }, (_, n) =>
    n < 150
      ? message(author, channel, `${large}${n}`, 10 + n, [
          ["e", root.id, "", "reply"],
        ])
      : message(author, channel, `reply ${n}`, 10 + n, [
          ["e", root.id, "", "reply"],
        ]),
  ).reverse();
  const h = await setup(pagedThread(replies));
  await h.view.refresh();
  const before = h.requests.length;
  // Unread from the 40th newest reply: one 50-row continuation reaches it.
  await h.view.loadMore(() => 10 + 170);
  expect(h.requests.slice(before + 1).map(([f]) => f?.limit)).toEqual([50]);
  expect(h.view.snapshot()).toMatchObject({
    status: "ready",
    canLoadMore: true,
    limited: false,
  });
  expect(h.view.snapshot().replies).toHaveLength(60);
});
it("stops a frontier load when the frontier moves past the loaded replies", async () => {
  const replies = Array.from({ length: 303 }, (_, n) =>
    message(author, channel, `reply ${n}`, 10 + n, [
      ["e", root.id, "", "reply"],
    ]),
  ).reverse();
  const relay = pagedThread(replies);
  let frontier = 0;
  const h = await setup((f) => {
    // A read synced from another device while the first older page loads.
    if (f.until !== undefined) frontier = Infinity;
    return relay(f);
  });
  await h.view.refresh();
  const before = h.requests.length;
  await h.view.loadMore(() => frontier);
  expect(h.requests.slice(before + 1).map(([f]) => f?.limit)).toEqual([50]);
  expect(h.view.snapshot().replies).toHaveLength(60);
});
it("resumes a failed frontier load from the page that failed", async () => {
  const replies = Array.from({ length: 303 }, (_, n) =>
    message(author, channel, `reply ${n}`, 10 + n, [
      ["e", root.id, "", "reply"],
    ]),
  ).reverse();
  const relay = pagedThread(replies);
  let windows = 0;
  let fail = true;
  const h = await setup((f) => {
    if (f.thread_window && f.until !== undefined && ++windows === 2 && fail)
      return relay(f).filter((event) => event.kind !== 39007);
    return relay(f);
  });
  await h.view.refresh();
  await h.view.loadMore(() => 0);
  expect(h.view.snapshot().status).toBe("error");
  fail = false;
  const retry = h.requests.length;
  await h.view.loadMore();
  const [window] =
    h.requests.slice(retry).find(([f]) => f?.thread_window) ?? [];
  // The retry reads the failed second page, not the first again.
  expect(window?.until).toBe(10 + 303 - 60);
  expect(h.view.snapshot()).toMatchObject({ status: "ready" });
  expect(h.view.snapshot().replies).toHaveLength(110);
});
it("uses raw scan progress across empty pages without deriving cursors from rows", async () => {
  let pages = 0;
  const h = await setup((f) =>
    f.ids
      ? [root]
      : [
          bounds(
            f,
            ++pages === 1 ? { created_at: 20, id: "a".repeat(64) } : null,
          ),
        ],
  );
  await h.view.refresh();
  expect(h.view.snapshot()).toMatchObject({
    status: "ready",
    canLoadMore: true,
    replies: [],
  });
  await h.view.loadMore();
  expect(h.requests.at(-1)?.[0]).toMatchObject({
    until: 20,
    before_id: "a".repeat(64),
  });
  expect(h.view.snapshot()).toMatchObject({
    status: "ready",
    canLoadMore: false,
    replies: [],
  });
});
it("discards an old relay's 200 probe and restarts legacy with clean state", async () => {
  const old = reply(0),
    probeOnly = reply(100);
  const h = await setup((f) =>
    f.ids
      ? [root]
      : f.thread_window
        ? [probeOnly]
        : f.thread_cursor === undefined
          ? [old]
          : [],
  );
  await h.view.refresh();
  expect(h.view.snapshot()).toMatchObject({
    status: "ready",
    direction: "forward",
    canLoadMore: true,
  });
  expect(h.view.snapshot().replies.map((r) => r.id)).toEqual([old.id]);
  expect(h.requests.at(-1)).toHaveLength(2);
  expect(h.requests.at(-1)?.[1]).not.toHaveProperty("thread_window");
  expect(h.requests.at(-1)?.[1]).not.toHaveProperty("until");
  expect(h.requests.at(-1)?.[1]?.kinds).toContain(40008);
  await h.view.loadMore();
  expect(h.requests.at(-1)?.[1]).toMatchObject({
    thread_cursor: old.created_at,
    thread_cursor_id: old.id,
  });
  expect(h.view.snapshot().canLoadMore).toBe(false);
});
it("does not downgrade a later missing bound or admit its rows", async () => {
  let calls = 0;
  const first = reply(200),
    untrusted = reply(0);
  const h = await setup((f) =>
    f.ids
      ? [root]
      : ++calls === 1
        ? [first, bounds(f, { created_at: first.created_at, id: first.id })]
        : [untrusted],
  );
  await h.view.refresh();
  await h.view.loadMore();
  expect(h.view.snapshot()).toMatchObject({
    status: "error",
    direction: "older",
  });
  expect(h.view.snapshot().replies.map((r) => r.id)).toEqual([first.id]);
  expect(h.requests.every((fs) => fs.length === 1)).toBe(true);
});
it.each([
  ["wrong signer", (f: ReadFilter) => [bounds(f, null, {}, author)]],
  ["duplicate bounds", (f: ReadFilter) => [bounds(f), bounds(f)]],
  [
    "missing tags",
    (f: ReadFilter) => [
      signed(relay, { ...bounds(f), tags: bounds(f).tags.slice(0, 2) }),
    ],
  ],
  ["wrong binding", (f: ReadFilter) => [bounds({ ...f, limit: 49 })]],
  ["wrong version", (f: ReadFilter) => [bounds(f, null, { version: 2 })]],
  [
    "wrong direction",
    (f: ReadFilter) => [bounds(f, null, { direction: "newer" })],
  ],
  [
    "wrong flag type",
    (f: ReadFilter) => [bounds(f, null, { has_more: "false" })],
  ],
  [
    "missing cursor",
    (f: ReadFilter) => [bounds(f, null, { next_cursor: undefined })],
  ],
  [
    "bad timestamp",
    (f: ReadFilter) => [bounds(f, { created_at: -1, id: "a".repeat(64) })],
  ],
  [
    "bad ID",
    (f: ReadFilter) => [bounds(f, { created_at: 1, id: "A".repeat(64) })],
  ],
  ["contradiction", (f: ReadFilter) => [bounds(f, null, { has_more: true })]],
  [
    "bad signature",
    (f: ReadFilter) => [{ ...bounds(f), sig: "0".repeat(128) }],
  ],
] as const)(
  "rejects %s before shared session admission",
  async (_name, bad) => {
    const row = reply(0);
    const h = await setup((f) => (f.ids ? [root] : [row, ...bad(f)]));
    const observer = h.session.observe([
      { kinds: [9], "#h": [channel], limit: 50 },
    ]);
    await h.view.refresh();
    expect(h.view.snapshot().status).toBe("error");
    expect(h.view.snapshot().replies).toEqual([]);
    expect(observer.snapshot().events.some((e) => e.id === row.id)).toBe(false);
    expect(h.requests).toHaveLength(2);
    observer.dispose();
  },
);
it("keeps ambiguous empty access-scoped responses as errors, not fallback or exhaustion", async () => {
  const h = await setup((f) => (f.ids ? [root] : []));
  await h.view.refresh();
  expect(h.view.snapshot()).toMatchObject({
    status: "error",
    canLoadMore: false,
  });
  expect(h.requests).toHaveLength(2);
});
it.each([401, 403, 429, 500])(
  "does not downgrade HTTP %s and can explicitly retry",
  async (status) => {
    const h = await setup((f) => (f.ids ? [root] : [bounds(f)]));
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
      const f = options?.body
        ? JSON.parse(options.body as string)[0]
        : undefined;
      return f?.thread_window
        ? Response.json({ error: "fixture failure" }, { status })
        : original(url, options);
    });
    vi.useFakeTimers();
    const pending = h.view.refresh();
    await vi.advanceTimersByTimeAsync(7000);
    await pending;
    if (status === 401 || status === 403) {
      expect(h.view.snapshot()).toMatchObject({
        status: "idle",
        root: undefined,
        replies: [],
      });
      expect(h.view.snapshot().error).toContain("no longer available");
    } else expect(h.view.snapshot().status).toBe("error");
    expect(h.requests).toHaveLength(1);
    vi.stubGlobal("fetch", original);
    if (status !== 401 && status !== 403) {
      await h.view.refresh();
      expect(h.view.snapshot().status).toBe("ready");
    }
    vi.useRealTimers();
  },
);

it("validates binding changes and non-advancing cursors on continuation before admission", async () => {
  const first = reply(100),
    older = reply(0);
  let corrupt = false;
  const h = await setup((filter) => {
    if (filter.ids) return [root];
    if (filter.until === undefined)
      return [
        first,
        bounds(filter, { created_at: first.created_at, id: first.id }),
      ];
    return [
      older,
      bounds(
        corrupt ? { ...filter, until: 1 } : filter,
        corrupt ? null : { created_at: first.created_at, id: first.id },
      ),
    ];
  });
  await h.view.refresh();
  await h.view.loadMore();
  expect(h.view.snapshot().status).toBe("error");
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual([first.id]);
  corrupt = true;
  await h.view.loadMore();
  expect(h.view.snapshot().status).toBe("error");
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual([first.id]);
});

it("refreshes retained strict pages after establishment while preserving live deletions", async () => {
  const one = reply(0),
    two = reply(60);
  let edited = false;
  const h = await setup((filter) => {
    if (filter.ids) return [root];
    if (filter.until === undefined)
      return [two, bounds(filter, { created_at: two.created_at, id: two.id })];
    return [
      one,
      ...(edited
        ? [
            signed(author, {
              kind: 40003,
              content: "repaired",
              created_at: 500,
              tags: [["e", one.id]],
            }),
          ]
        : []),
      bounds(filter),
    ];
  });
  await h.view.refresh();
  await h.view.loadMore();
  h.traffic.receive([
    signed(author, {
      kind: 5,
      created_at: 501,
      content: "",
      tags: [["e", two.id]],
    }),
  ]);
  edited = true;
  const before = h.requests.length;
  h.traffic.established(channel);
  await vi.waitFor(() =>
    expect(h.view.snapshot().replies[0]?.content).toBe("repaired"),
  );
  expect(h.view.snapshot().status).toBe("ready");
  expect(h.requests.slice(before)).toMatchObject([
    [{ ids: [root.id] }],
    [{ thread_window: true }],
    [{ thread_window: true, until: two.created_at, before_id: two.id }],
  ]);
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual([one.id]);
});

const at = (n: number) =>
  message(author, channel, `reply ${n}`, 10 * n, [["e", root.id, "", "reply"]]);
const cursorOf = (row: RelayEvent) => ({
  created_at: row.created_at,
  id: row.id,
});

it("refresh after establishment pages past its re-read until it reaches a retained reply", async () => {
  // Live replay covers minutes; a long disconnect can leave the newest page
  // short of the retained replies. Pages continue until one is reached.
  const one = at(1),
    two = at(2),
    three = at(3);
  let reconnected = false;
  const h = await setup((filter) => {
    if (filter.ids) return [root];
    if (!reconnected) return [one, bounds(filter, cursorOf(one))];
    if (filter.until === undefined)
      return [three, bounds(filter, cursorOf(three))];
    if (filter.until === three.created_at)
      return [two, bounds(filter, cursorOf(two))];
    return [one, bounds(filter, cursorOf(one))];
  });
  await h.view.refresh();
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual([one.id]);
  reconnected = true;
  const before = h.requests.length;
  h.traffic.established(channel);
  await vi.waitFor(() => {
    const snapshot = h.view.snapshot();
    expect(snapshot.replies.map((row) => row.id)).toEqual([
      one.id,
      two.id,
      three.id,
    ]);
    expect(snapshot).toMatchObject({
      status: "ready",
      canLoadMore: true,
      limited: false,
    });
  });
  expect(h.requests.slice(before)).toMatchObject([
    [{ ids: [root.id] }],
    [{ thread_window: true }],
    [{ thread_window: true, until: three.created_at, before_id: three.id }],
    [{ thread_window: true, until: two.created_at, before_id: two.id }],
  ]);
});

it("replies the re-established stream replays before refresh are not overlap with the replies kept across the drop", async () => {
  const one = at(1),
    two = at(2),
    three = at(3);
  let reconnected = false;
  const h = await setup((filter) => {
    if (filter.ids) return [root];
    if (!reconnected) return [one, bounds(filter, cursorOf(one))];
    if (filter.until === undefined)
      return [three, two, bounds(filter, cursorOf(two))];
    return [one, bounds(filter, cursorOf(one))];
  });
  await h.view.refresh();
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual([one.id]);
  reconnected = true;
  h.traffic.state({ status: "connected", routes: [] });
  h.traffic.state({ status: "retrying", routes: [] });
  h.traffic.state({ status: "connected", routes: [] });
  h.traffic.receive([three]);
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual([
    one.id,
    three.id,
  ]);
  const before = h.requests.length;
  h.traffic.established(channel);
  await vi.waitFor(() => {
    const snapshot = h.view.snapshot();
    expect(snapshot.replies.map((row) => row.id)).toEqual([
      one.id,
      two.id,
      three.id,
    ]);
    expect(snapshot).toMatchObject({ status: "ready", limited: false });
  });
  // The newest page overlaps the replayed reply; the fill still pages on to
  // the reply kept across the drop.
  expect(h.requests.slice(before)).toMatchObject([
    [{ ids: [root.id] }],
    [{ thread_window: true }],
    [{ thread_window: true, until: two.created_at, before_id: two.id }],
  ]);
});

it("refresh after establishment drops a retained reply it cannot reach within the page bound and settles on the range the reader had", async () => {
  const old = at(1);
  const fresh = Array.from({ length: 10 }, (_, index) => at(20 - index));
  let reconnected = false;
  const h = await setup((filter) => {
    if (filter.ids) return [root];
    if (!reconnected) return [old, bounds(filter, cursorOf(old))];
    const row =
      fresh[
        filter.until === undefined
          ? 0
          : fresh.findIndex(
              (candidate) => candidate.created_at === filter.until,
            ) + 1
      ];
    assert(row);
    return [row, bounds(filter, cursorOf(row))];
  });
  await h.view.refresh();
  reconnected = true;
  h.traffic.established(channel);
  // Ten pages never reached `old`: it goes rather than sitting below a gap.
  // The pages read stay, but the reader had one page, so the range settles
  // on one: a later refresh re-reads one page, not ten, and older pages
  // continue from its bound. The repair stays ready throughout, so wait on
  // its rows.
  const shown = fresh.map((row) => row.id).reverse();
  await vi.waitFor(() => {
    expect(h.view.snapshot().replies.map((row) => row.id)).toEqual(shown);
    expect(h.view.snapshot()).toMatchObject({
      status: "ready",
      limited: false,
      canLoadMore: true,
    });
  });
  let before = h.requests.length;
  await h.view.refresh();
  expect(h.requests.slice(before)).toMatchObject([
    [{ ids: [root.id] }],
    [{ thread_window: true }],
  ]);
  expect(h.requests.at(-1)?.[0]).not.toHaveProperty("until");
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual(shown);
  before = h.requests.length;
  await h.view.loadMore();
  expect(h.requests.slice(before)).toMatchObject([
    [{ ids: [root.id] }],
    [
      {
        thread_window: true,
        until: fresh[0]?.created_at,
        before_id: fresh[0]?.id,
      },
    ],
  ]);
  expect(h.view.snapshot()).toMatchObject({
    status: "ready",
    canLoadMore: true,
    limited: false,
  });
});

/** Reconnect pages: `four` and `three` on the newest page, then `two`, then `one`. */
const reconnectPages =
  (reconnected: () => boolean) =>
  (filter: ReadFilter): readonly RelayEvent[] => {
    const [one, two, three, four] = [at(1), at(2), at(3), at(4)];
    if (filter.ids) return [root];
    if (!reconnected()) return [one, bounds(filter, cursorOf(one))];
    if (filter.until === undefined)
      return [four, three, bounds(filter, cursorOf(three))];
    if (filter.until === three.created_at)
      return [two, bounds(filter, cursorOf(two))];
    return [one, bounds(filter, cursorOf(one))];
  };

it("a refresh completing while the stream is down keeps the replies held across the drop for the establishment refresh to reach", async () => {
  const [one, two, three, four] = [at(1), at(2), at(3), at(4)];
  let reconnected = false;
  const h = await setup(reconnectPages(() => reconnected));
  await h.view.refresh();
  h.traffic.state({ status: "connected", routes: [] });
  h.traffic.state({ status: "retrying", routes: [] });
  // A user refresh while the stream is down re-reads the same page. Were it
  // to clear the drop-time snapshot, the replayed reply would be the
  // establishment refresh's overlap.
  await h.view.refresh();
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual([one.id]);
  reconnected = true;
  h.traffic.state({ status: "connected", routes: [] });
  h.traffic.receive([four]);
  const before = h.requests.length;
  h.traffic.established(channel);
  await vi.waitFor(() => {
    const snapshot = h.view.snapshot();
    expect(snapshot.replies.map((row) => row.id)).toEqual([
      one.id,
      two.id,
      three.id,
      four.id,
    ]);
    expect(snapshot).toMatchObject({ status: "ready", limited: false });
  });
  expect(h.requests.slice(before)).toMatchObject([
    [{ ids: [root.id] }],
    [{ thread_window: true }],
    [{ thread_window: true, until: three.created_at, before_id: three.id }],
    [{ thread_window: true, until: two.created_at, before_id: two.id }],
  ]);
});

it("an establishment refresh queued before a drop runs as a plain refresh, keeping the replies held for the next establishment", async () => {
  // A renewal EOSE while a read runs queues an establishment refresh. Run as
  // one after the drop, it would clear the drop-time snapshot while offline.
  const [one, two, three, four] = [at(1), at(2), at(3), at(4)];
  let reconnected = false;
  let gate: Promise<void> | undefined;
  let release = () => {};
  const pages = reconnectPages(() => reconnected);
  const h = await setup(async (filter) => {
    const held = filter.thread_window ? gate : undefined;
    if (held) gate = undefined;
    await held;
    return pages(filter);
  });
  h.traffic.state({ status: "connected", routes: [] });
  await h.view.refresh();
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual([one.id]);
  gate = new Promise((resolve) => {
    release = resolve;
  });
  const refreshing = h.view.refresh();
  let queued = 0;
  try {
    await vi.waitFor(() => expect(gate).toBeUndefined());
    queued = h.requests.length;
    h.traffic.established(channel);
    h.traffic.state({ status: "retrying", routes: [] });
  } finally {
    release();
  }
  await refreshing;
  await vi.waitFor(() => {
    expect(h.requests.slice(queued)).toMatchObject([
      [{ ids: [root.id] }],
      [{ thread_window: true }],
    ]);
    expect(h.view.snapshot().status).toBe("ready");
  });
  reconnected = true;
  h.traffic.state({ status: "connected", routes: [] });
  h.traffic.receive([four]);
  const before = h.requests.length;
  h.traffic.established(channel);
  await vi.waitFor(() => {
    const snapshot = h.view.snapshot();
    expect(snapshot.replies.map((row) => row.id)).toEqual([
      one.id,
      two.id,
      three.id,
      four.id,
    ]);
    expect(snapshot).toMatchObject({ status: "ready", limited: false });
  });
  expect(h.requests.slice(before)).toMatchObject([
    [{ ids: [root.id] }],
    [{ thread_window: true }],
    [{ thread_window: true, until: three.created_at, before_id: three.id }],
    [{ thread_window: true, until: two.created_at, before_id: two.id }],
  ]);
});

it("a thread view opened while the stream is down keeps its first read for the establishment refresh to reach", async () => {
  const [one, two, three, four] = [at(1), at(2), at(3), at(4)];
  let reconnected = false;
  const h = await setup(reconnectPages(() => reconnected));
  h.traffic.state({ status: "connected", routes: [] });
  h.traffic.state({ status: "retrying", routes: [] });
  h.view.dispose();
  const view = h.session.thread(channel, root.id);
  cleanup.push(view.dispose);
  await view.refresh();
  expect(view.snapshot().replies.map((row) => row.id)).toEqual([one.id]);
  reconnected = true;
  h.traffic.state({ status: "connected", routes: [] });
  h.traffic.receive([four]);
  const before = h.requests.length;
  h.traffic.established(channel);
  await vi.waitFor(() => {
    const snapshot = view.snapshot();
    expect(snapshot.replies.map((row) => row.id)).toEqual([
      one.id,
      two.id,
      three.id,
      four.id,
    ]);
    expect(snapshot).toMatchObject({ status: "ready", limited: false });
  });
  expect(h.requests.slice(before)).toMatchObject([
    [{ ids: [root.id] }],
    [{ thread_window: true }],
    [{ thread_window: true, until: three.created_at, before_id: three.id }],
    [{ thread_window: true, until: two.created_at, before_id: two.id }],
  ]);
});

it("a thread view opened before the first connection keeps its first read for the establishment refresh to reach", async () => {
  // Replies the first connection replays before EOSE are newer than any gap
  // between the pre-connect read and them, not overlap with it.
  const [one, two, three, four] = [at(1), at(2), at(3), at(4)];
  let reconnected = false;
  const h = await setup(reconnectPages(() => reconnected));
  await h.view.refresh();
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual([one.id]);
  reconnected = true;
  h.traffic.state({ status: "connected", routes: [] });
  h.traffic.receive([four]);
  const before = h.requests.length;
  h.traffic.established(channel);
  await vi.waitFor(() => {
    const snapshot = h.view.snapshot();
    expect(snapshot.replies.map((row) => row.id)).toEqual([
      one.id,
      two.id,
      three.id,
      four.id,
    ]);
    expect(snapshot).toMatchObject({ status: "ready", limited: false });
  });
  expect(h.requests.slice(before)).toMatchObject([
    [{ ids: [root.id] }],
    [{ thread_window: true }],
    [{ thread_window: true, until: three.created_at, before_id: three.id }],
    [{ thread_window: true, until: two.created_at, before_id: two.id }],
  ]);
});

it("keeps a root edit from a window that answers before an unretained root", async () => {
  const row = reply(0);
  const edit = signed(author, {
    kind: 40003,
    created_at: 50,
    content: "edited root",
    tags: [["e", root.id]],
  });
  // Like the session's verified reader, each answer is admitted as it
  // resolves: an edit whose target is not known yet is dropped.
  const known = new Set<string>();
  let held: Promise<void> | undefined;
  let release = () => {};
  let rootPending = false;
  const reader = {
    async read(filters: readonly ReadFilter[]) {
      const [f] = filters;
      assert.exists(f);
      let events: RelayEvent[];
      if (f.ids?.includes(root.id)) {
        rootPending = true;
        await held;
        rootPending = false;
        events = [root];
      } else if (f.ids) events = [row];
      else if (f.thread_window) events = [row, edit, bounds(f)];
      else events = [];
      const admitted = events.filter(
        (event) =>
          event.kind !== 40003 ||
          event.tags.every(([name, id]) => name !== "e" || known.has(id ?? "")),
      );
      for (const event of admitted) known.add(event.id);
      return admitted;
    },
  };
  // The root answers only once the test releases it, after any read started
  // alongside it has answered.
  const refresh = async (view: { refresh(): Promise<void> }) => {
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refreshing = view.refresh();
    await vi.waitFor(() => expect(rootPending).toBe(true));
    release();
    await refreshing;
    held = undefined;
  };
  const open = (resume?: ThreadResume) =>
    createThreadView({
      channelId: channel,
      messageId: root.id,
      relayAuthor: relay.pubkey,
      reader,
      seed: undefined,
      resume,
      local: undefined,
      canAccess: () => true,
      visible: (events) => events,
      notify: () => {},
    });
  const first = open();
  await first.view.refresh();
  const resume = first.resume();
  first.view.dispose();
  assert(typeof resume === "object");
  // The resume holds the root; the shared evidence no longer does.
  known.clear();
  const reopened = open(resume);
  await refresh(reopened.view);
  expect(reopened.view.snapshot()).toMatchObject({
    status: "ready",
    root: { id: root.id, content: "edited root" },
  });
  // A retarget makes this ordinary view exact; its reader still admits.
  await expect(
    reopened.view.retarget(row.id, new AbortController().signal),
  ).resolves.toBe("selected");
  reopened.purge(true);
  known.clear();
  await refresh(reopened.view);
  expect(reopened.view.snapshot()).toMatchObject({
    status: "ready",
    root: { id: root.id, content: "edited root" },
  });
});

it("stops an exact view's overlapped window when the root is missing", async () => {
  let rootReads = 0;
  let window:
    | { filter: ReadFilter; signal: AbortSignal | undefined }
    | undefined;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reader = {
    async read(
      filters: readonly ReadFilter[],
      settings?: { signal?: AbortSignal },
    ) {
      const [f] = filters;
      assert.exists(f);
      if (f.ids) return ++rootReads === 1 ? [root] : [];
      if (!f.thread_window) return [];
      window = { filter: f, signal: settings?.signal };
      await held;
      return [reply(0), bounds(f)];
    },
  };
  const view = createThreadView({
    channelId: channel,
    messageId: root.id,
    relayAuthor: relay.pubkey,
    reader,
    seed: undefined,
    local: undefined,
    exact: true,
    canAccess: () => true,
    visible: (events) => events,
    notify: () => {},
  });
  // The target read finds the root; the root read that follows does not.
  const loading = view.view.refresh();
  await vi.waitFor(() => expect(rootReads).toBe(2));
  await loading;
  expect(view.view.snapshot()).toMatchObject({ status: "error" });
  // The window read started with the root read and is stopped.
  expect(window?.filter.thread_window).toBe(true);
  expect(window?.signal?.aborted).toBe(true);
  release();
});

it("revalidates a missing strict root before repair and preserves tombstones on retry", async () => {
  const row = reply(0);
  let missing = false;
  const h = await setup((filter) =>
    filter.ids ? (missing ? [] : [root]) : [row, bounds(filter)],
  );
  await h.view.refresh();
  h.traffic.receive([
    signed(author, {
      kind: 5,
      created_at: 500,
      content: "",
      tags: [["e", row.id]],
    }),
  ]);
  missing = true;
  const before = h.requests.length;
  await h.view.refresh();
  expect(h.requests.slice(before)).toEqual([
    [{ ids: [root.id], "#h": [channel], limit: 1 }],
  ]);
  expect(h.view.snapshot()).toMatchObject({
    status: "error",
    root: undefined,
    replies: [],
    canLoadMore: false,
  });
  expect(h.view.snapshot().error).toContain(
    "original thread message is unavailable",
  );
  missing = false;
  await h.view.refresh();
  expect(h.view.snapshot()).toMatchObject({
    status: "ready",
    root: { id: root.id },
    replies: [],
    canLoadMore: false,
  });
});

it.each([
  ["dispose", "root"],
  ["clear", "root"],
  ["revoke", "root"],
  ["dispose", "window"],
  ["clear", "window"],
  ["revoke", "window"],
])("fences %s during a held strict %s read", async (action, phase) => {
  let release!: (events: readonly RelayEvent[]) => void;
  const held = new Promise<readonly RelayEvent[]>((resolve) => {
    release = resolve;
  });
  let pending: ReadFilter | undefined;
  const h = await setup((filter) => {
    if (phase === "window" && filter.ids) return [root];
    pending = filter;
    return held;
  });
  const loading = h.view.refresh();
  try {
    await vi.waitFor(() => expect(pending).toBeDefined());
    if (action === "dispose") h.dispose();
    else if (action === "clear") await h.clearCache();
    else h.traffic.receive([roster(relay, channel, [], 1_700_000_001)]);
  } finally {
    release(
      phase === "root" ? [root] : pending ? [reply(0), bounds(pending)] : [],
    );
  }
  await loading;
  expect(h.view.snapshot().replies).toEqual([]);
  expect(h.view.snapshot().root).toBeUndefined();
  expect(h.requests).toHaveLength(phase === "root" ? 1 : 2);
});

it.each([8_210_266_876_800, Number.MAX_SAFE_INTEGER])(
  "rejects signed timestamps outside chrono's domain (%s) before admission",
  async (created_at) => {
    const row = reply(0);
    const h = await setup((filter) =>
      filter.ids ? [root] : [row, bounds(filter, { created_at, id: row.id })],
    );
    const observer = h.session.observe([
      { kinds: [9], "#h": [channel], limit: 50 },
    ]);
    await h.view.refresh();
    expect(h.view.snapshot().status).toBe("error");
    expect(
      observer.snapshot().events.some((event) => event.id === row.id),
    ).toBe(false);
    expect(h.requests).toHaveLength(2);
    observer.dispose();
  },
);
it("accepts and echoes chrono's inclusive maximum cursor", async () => {
  const cursor = { created_at: 8_210_266_876_799, id: "a".repeat(64) };
  const h = await setup((filter) =>
    filter.ids
      ? [root]
      : [bounds(filter, filter.until === undefined ? cursor : null)],
  );
  await h.view.refresh();
  expect(h.view.snapshot()).toMatchObject({
    status: "ready",
    canLoadMore: true,
  });
  await h.view.loadMore();
  expect(h.requests.at(-1)?.[0]).toMatchObject({
    until: cursor.created_at,
    before_id: cursor.id,
  });
  expect(h.view.snapshot()).toMatchObject({
    status: "ready",
    canLoadMore: false,
  });
});

const filler = (n: number) =>
  message(author, channel, `filler ${n}`, 20 + n, [
    ["e", root.id, "", "reply"],
  ]);
const nested = (text: string, at: number, parent: string) =>
  message(author, channel, text, at, [
    ["e", root.id, "", "root"],
    ["e", parent, "", "reply"],
  ]);
/** A relay holding `rows`, served newest first in signed windows. */
const serving = (rows: readonly RelayEvent[]) => (f: ReadFilter) => {
  if (f.ids) return [root];
  if (!f.thread_window) return [];
  const eligible = [...rows]
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
    .filter(
      (e) =>
        f.until === undefined ||
        e.created_at < f.until ||
        (e.created_at === f.until && e.id > (f.before_id ?? "")),
    );
  const page = eligible.slice(0, f.limit);
  const last = page.at(-1);
  return [
    ...page,
    bounds(
      f,
      last && eligible.length > page.length
        ? { created_at: last.created_at, id: last.id }
        : null,
    ),
  ];
};
const windows = (requests: readonly ReadFilter[][]) =>
  requests.filter(([f]) => f?.thread_window).map(([f]) => f?.limit);

it("shows a read view's window, then reads older pages for the parent of a loaded reply, and leaves other views bounded", async () => {
  const parent = filler(0);
  const child = nested("child", 100, parent.id);
  const rows = [parent, ...Array.from({ length: 12 }, (_, n) => filler(n + 1))];
  const h = await setup(serving([...rows, child]));
  await h.view.refresh();
  expect(h.view.snapshot()).toMatchObject({ canLoadMore: true });
  expect(h.view.snapshot().replies.map((row) => row.id)).not.toContain(
    parent.id,
  );
  expect(windows(h.requests)).toEqual([10]);

  const view = h.session.thread(channel, root.id, { reading: true });
  const before = h.requests.length;
  const statuses: string[] = [];
  view.subscribe(() => {
    const { status, replies } = view.snapshot();
    statuses.push(`${status} ${replies.length}`);
  });
  await view.refresh();
  await vi.waitFor(() =>
    expect(view.snapshot()).toMatchObject({
      status: "ready",
      canLoadMore: false,
      seeking: undefined,
    }),
  );
  // The window shows, and stays ready, while the page that holds the parent
  // is read behind it at background priority.
  expect(
    statuses
      .slice(statuses.indexOf("ready 10"))
      .filter((status) => !status.startsWith("ready")),
  ).toEqual([]);
  expect(windows(h.requests.slice(before))).toEqual([10, 50]);
  expect(
    h.fetcher.mock.calls
      .filter(([, sent]) => String(sent?.body).includes("thread_window"))
      .map(([, sent]) => new Headers(sent?.headers).get("X-Buzz-Read-Priority"))
      .slice(-2),
  ).toEqual(["foreground", "background"]);
  expect(view.snapshot().replies.map((row) => row.id)).toContain(parent.id);
  view.dispose();
});

it("reads a read view to the end for a parent the relay does not hold, once", async () => {
  const orphan = nested("orphan", 100, "e".repeat(64));
  const rows = Array.from({ length: 70 }, (_, n) => filler(n));
  const h = await setup(serving([...rows, orphan]));
  const view = h.session.thread(channel, root.id, { reading: true });
  await view.refresh();
  await vi.waitFor(() =>
    expect(view.snapshot()).toMatchObject({
      status: "ready",
      canLoadMore: false,
      limited: false,
    }),
  );
  expect(windows(h.requests)).toEqual([10, 50, 50]);
  expect(
    view.snapshot().replies.find((row) => row.id === orphan.id)?.replyParentId,
  ).toBe("e".repeat(64));
  // Exhausted history is the answer: another orphan starts no read.
  h.traffic.receive([nested("later orphan", 101, "d".repeat(64))]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(windows(h.requests)).toHaveLength(3);
  view.dispose();
});

it("reads a read view back for a live reply to a parent outside its loaded pages", async () => {
  const parent = filler(0);
  const rows = [parent, ...Array.from({ length: 12 }, (_, n) => filler(n + 1))];
  const h = await setup(serving(rows));
  const view = h.session.thread(channel, root.id, { reading: true });
  await view.refresh();
  expect(view.snapshot()).toMatchObject({ status: "ready", canLoadMore: true });
  expect(windows(h.requests)).toEqual([10]);
  const child = nested("child", 100, parent.id);
  h.traffic.receive([child]);
  await vi.waitFor(() =>
    expect(view.snapshot()).toMatchObject({
      status: "ready",
      canLoadMore: false,
    }),
  );
  expect(windows(h.requests)).toEqual([10, 50]);
  expect(view.snapshot().replies.map((row) => row.id)).toEqual(
    expect.arrayContaining([parent.id, child.id]),
  );
  // A live reply to a loaded parent reads nothing.
  h.traffic.receive([nested("sibling", 101, parent.id)]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(windows(h.requests)).toHaveLength(2);
  view.dispose();
});

it("keeps a read view's rows through repeated transient failures and recovers under session recovery without an error", async () => {
  const rows = Array.from({ length: 70 }, (_, n) => filler(n));
  let down = false;
  const h = await setup((f) => {
    if (down && f.thread_window) throw new TypeError("offline");
    return serving(rows)(f);
  });
  // A stream still connecting keeps recovery busy on its own.
  h.traffic.state({ status: "connected", routes: [] });
  const view = h.session.thread(channel, root.id, { reading: true });
  await view.refresh();
  const loaded = view.snapshot().replies;
  expect(loaded).toHaveLength(10);
  expect(view.snapshot().canLoadMore).toBe(true);
  const statuses: string[] = [];
  view.subscribe(() => statuses.push(view.snapshot().status));
  const recovery = h.session.recovery;
  assert.exists(recovery);

  down = true;
  rows.push(filler(70));
  vi.spyOn(Math, "random").mockReturnValue(1);
  vi.useFakeTimers();
  try {
    const attempts = () => windows(h.requests).length - 1;
    void view.refresh();
    // An older page asked for behind the read that fails is still wanted.
    void view.loadMore();
    // One read and its three quick retries (1, 2 and 4 s), then recovery.
    await vi.advanceTimersByTimeAsync(7000);
    expect(attempts()).toBe(4);
    expect(view.snapshot()).toMatchObject({
      status: "loading",
      recovering: true,
      error: undefined,
    });
    expect(view.snapshot().replies).toBe(loaded);
    expect(recovery.snapshot()).toMatchObject({ recovering: true, attempt: 0 });
    // Recovery waits 1 s, then 2 s: no read starts in between, and demand
    // for older pages, here to the oldest reply, waits with it.
    void view.loadMore(() => 0);
    expect(view.snapshot().readKind).toBe("older");
    await vi.advanceTimersByTimeAsync(999);
    expect(attempts()).toBe(4);
    await vi.advanceTimersByTimeAsync(1);
    // The retry is the refresh's; the page asked for still shows as waiting.
    expect(attempts()).toBe(5);
    expect(view.snapshot().readKind).toBe("older");
    await vi.advanceTimersByTimeAsync(7000);
    expect(attempts()).toBe(8);
    expect(view.snapshot().readKind).toBe("older");
    expect(recovery.snapshot()).toMatchObject({ recovering: true, attempt: 1 });
    await vi.advanceTimersByTimeAsync(1999);
    expect(attempts()).toBe(8);
    down = false;
    await vi.advanceTimersByTimeAsync(1);
    // New rows are verified off the fake clock. The refresh shows the new
    // reply; the demand held across the failure then reads to its frontier.
    await vi.waitFor(() =>
      expect(view.snapshot()).toMatchObject({
        status: "ready",
        canLoadMore: false,
        recovering: undefined,
        error: undefined,
      }),
    );
    expect(view.snapshot().replies).toHaveLength(71);
    expect(recovery.snapshot()).toMatchObject({
      recovering: false,
      attempt: 0,
    });
    expect(statuses).not.toContain("error");
    // Settled: recovery holds no timer for the thread.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts()).toBe(11);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    view.dispose();
  }
});

it("recovers a failed read view at once when the stream is established, and stops retrying one that closed", async () => {
  let down = true;
  const h = await setup((f) => {
    if (down && f.thread_window) throw new TypeError("offline");
    return serving([filler(0)])(f);
  });
  h.traffic.state({ status: "connected", routes: [] });
  const recovery = h.session.recovery;
  assert.exists(recovery);
  vi.spyOn(Math, "random").mockReturnValue(1);
  vi.useFakeTimers();
  try {
    const view = h.session.thread(channel, root.id, { reading: true });
    void view.refresh();
    await vi.advanceTimersByTimeAsync(7000);
    expect(view.snapshot()).toMatchObject({
      status: "loading",
      error: undefined,
    });
    down = false;
    h.traffic.established(channel);
    // No recovery delay passes: establishment itself reads again.
    await vi.waitFor(() => expect(view.snapshot().replies).toHaveLength(1), {
      interval: 0,
    });
    expect(view.snapshot()).toMatchObject({ status: "ready" });
    expect(recovery.snapshot().recovering).toBe(false);

    down = true;
    void view.refresh();
    await vi.advanceTimersByTimeAsync(7000);
    expect(recovery.snapshot().recovering).toBe(true);
    const sent = h.requests.length;
    view.dispose();
    expect(recovery.snapshot().recovering).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.requests).toHaveLength(sent);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

it("still reports a failure of a read view that a retry cannot fix", async () => {
  const h = await setup((f) => (f.ids ? [] : serving([filler(0)])(f)));
  const view = h.session.thread(channel, root.id, { reading: true });
  await view.refresh();
  expect(view.snapshot().status).toBe("error");
  expect(view.snapshot().error).toContain("unavailable");
  expect(h.session.recovery?.snapshot().recovering).toBe(false);
  view.dispose();
});

it("keeps a read view ready while its read for a missing parent fails, and finishes it under session recovery", async () => {
  const parent = filler(0);
  const rows = [
    parent,
    ...Array.from({ length: 12 }, (_, n) => filler(n + 1)),
    nested("child", 100, parent.id),
  ];
  let down = true;
  const h = await setup((f) => {
    if (down && f.until !== undefined) throw new TypeError("offline");
    return serving(rows)(f);
  });
  h.traffic.state({ status: "connected", routes: [] });
  const recovery = h.session.recovery;
  assert.exists(recovery);
  vi.spyOn(Math, "random").mockReturnValue(1);
  vi.useFakeTimers();
  const view = h.session.thread(channel, root.id, { reading: true });
  try {
    const statuses: string[] = [];
    view.subscribe(() => statuses.push(view.snapshot().status));
    void view.refresh();
    await vi.waitFor(() => expect(view.snapshot().status).toBe("ready"));
    await vi.advanceTimersByTimeAsync(7000);
    expect(view.snapshot()).toMatchObject({
      status: "ready",
      seeking: true,
      recovering: true,
      error: undefined,
    });
    expect(view.snapshot().replies).toHaveLength(10);
    expect(recovery.snapshot().recovering).toBe(true);
    down = false;
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() =>
      expect(view.snapshot().replies.map((row) => row.id)).toContain(parent.id),
    );
    expect(view.snapshot().seeking).toBeUndefined();
    expect(statuses.slice(statuses.indexOf("ready"))).not.toContain("loading");
    expect(recovery.snapshot().recovering).toBe(false);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    view.dispose();
  }
});

it("ends a read view's wait on recovery once nothing is left to read", async () => {
  const child = nested("child", 100, filler(0).id);
  const rows = [...Array.from({ length: 13 }, (_, n) => filler(n)), child];
  const h = await setup((f) => {
    if (f.until !== undefined) throw new TypeError("offline");
    return serving(rows)(f);
  });
  h.traffic.state({ status: "connected", routes: [] });
  const recovery = h.session.recovery;
  assert.exists(recovery);
  vi.spyOn(Math, "random").mockReturnValue(1);
  vi.useFakeTimers();
  const view = h.session.thread(channel, root.id, { reading: true });
  try {
    void view.refresh();
    await vi.waitFor(() => expect(view.snapshot().status).toBe("ready"));
    await vi.advanceTimersByTimeAsync(7000);
    expect(view.snapshot()).toMatchObject({ seeking: true, recovering: true });
    const read = windows(h.requests).length;
    // The reply without its parent goes: no read is left to retry.
    h.traffic.receive([
      signed(author, {
        kind: 5,
        created_at: 500,
        content: "",
        tags: [["e", child.id]],
      }),
    ]);
    await vi.waitFor(() => expect(view.snapshot().seeking).toBeUndefined());
    await vi.advanceTimersByTimeAsync(1000);
    expect(view.snapshot().recovering).toBeUndefined();
    expect(recovery.snapshot().recovering).toBe(false);
    expect(windows(h.requests)).toHaveLength(read);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    view.dispose();
  }
});

it("reports a relay's rejection of a read view's read, and recovers quietly from its 502", async () => {
  let status = 0;
  const h = await setup(serving([filler(0)]));
  const answer = h.fetcher.getMockImplementation();
  assert.exists(answer);
  h.fetcher.mockImplementation(async (url, sent) =>
    status && String(sent?.body).includes("thread_window")
      ? new Response("{}", { status })
      : answer(url, sent),
  );
  h.traffic.state({ status: "connected", routes: [] });
  const recovery = h.session.recovery;
  assert.exists(recovery);
  vi.spyOn(Math, "random").mockReturnValue(1);
  vi.useFakeTimers();
  const view = h.session.thread(channel, root.id, { reading: true });
  try {
    status = 404;
    void view.refresh();
    await vi.advanceTimersByTimeAsync(7000);
    expect(view.snapshot().status).toBe("error");
    expect(recovery.snapshot().recovering).toBe(false);
    // The read and its three quick retries, and no more.
    const sent = h.fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.fetcher.mock.calls).toHaveLength(sent);

    status = 502;
    void view.refresh();
    await vi.advanceTimersByTimeAsync(7000);
    expect(view.snapshot()).toMatchObject({
      status: "loading",
      error: undefined,
    });
    expect(recovery.snapshot().recovering).toBe(true);
    status = 0;
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(view.snapshot().status).toBe("ready"));
    expect(recovery.snapshot().recovering).toBe(false);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    view.dispose();
  }
});

it("leaves a failed read view to its establishment refresh on reconnect, and to recovery's delay without one", async () => {
  let down = false;
  let held = false;
  let release = () => {};
  const h = await setup(async (f) => {
    if (down && f.thread_window) throw new TypeError("offline");
    if (held && f.thread_window)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return serving([filler(0)])(f);
  });
  h.traffic.state({ status: "connected", routes: [] });
  h.traffic.established(channel);
  const recovery = h.session.recovery;
  assert.exists(recovery);
  const view = h.session.thread(channel, root.id, { reading: true });
  await view.refresh();
  vi.spyOn(Math, "random").mockReturnValue(1);
  vi.useFakeTimers();
  try {
    const drop = async () => {
      down = true;
      h.traffic.state({ status: "retrying", routes: [] });
      void view.refresh();
      await vi.advanceTimersByTimeAsync(7000);
      expect(recovery.snapshot().recovering).toBe(true);
      down = false;
      const sent = windows(h.requests).length;
      // The socket is back: recovery retries its failed reads now.
      h.traffic.state({ status: "connected", routes: [] });
      await vi.advanceTimersByTimeAsync(0);
      return sent;
    };
    // The channel's establishment refreshes the view: one read, not two.
    let sent = await drop();
    h.traffic.established(channel);
    await vi.waitFor(() => expect(recovery.snapshot().recovering).toBe(false), {
      interval: 0,
    });
    expect(windows(h.requests)).toHaveLength(sent + 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(windows(h.requests)).toHaveLength(sent + 1);

    // No establishment comes: recovery's first delay reads.
    sent = await drop();
    await vi.advanceTimersByTimeAsync(999);
    expect(windows(h.requests)).toHaveLength(sent);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(recovery.snapshot().recovering).toBe(false), {
      interval: 0,
    });
    expect(windows(h.requests)).toHaveLength(sent + 1);

    // The establishment comes while that delayed read runs. The read began
    // before the stream was live, so the establishment refresh follows it.
    sent = await drop();
    held = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(windows(h.requests)).toHaveLength(sent + 1);
    h.traffic.established(channel);
    held = false;
    release();
    await vi.waitFor(() => expect(recovery.snapshot().recovering).toBe(false), {
      interval: 0,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(windows(h.requests)).toHaveLength(sent + 2);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    view.dispose();
  }
});

it("reads a page a person asks for in place of a read view's read for a missing parent, once", async () => {
  const parent = filler(0);
  const rows = [
    parent,
    ...Array.from({ length: 12 }, (_, n) => filler(n + 1)),
    nested("child", 100, parent.id),
  ];
  let held = true;
  let release = () => {};
  const h = await setup(async (f) => {
    if (held && f.thread_window && f.until !== undefined)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return serving(rows)(f);
  });
  const view = h.session.thread(channel, root.id, { reading: true });
  await view.refresh();
  // The read for the child's parent is held behind the first window.
  await vi.waitFor(() => expect(windows(h.requests)).toEqual([10, 50]));
  expect(view.snapshot()).toMatchObject({ status: "ready", seeking: true });
  held = false;
  const sought = h.fetcher.mock.calls
    .map(([, sent]) => sent)
    .filter((sent) => String(sent?.body).includes("thread_window"))[1];
  expect(sought?.signal?.aborted).toBe(false);
  const asked = view.loadMore();
  // The ask ends the read for the parent and shows as its own.
  expect(sought?.signal?.aborted).toBe(true);
  expect(view.snapshot()).toMatchObject({
    status: "loading",
    readKind: "older",
  });
  await asked;
  expect(view.snapshot()).toMatchObject({
    status: "ready",
    canLoadMore: false,
    seeking: undefined,
  });
  expect(view.snapshot().replies).toHaveLength(14);
  // The page was read for the person, and neither read repeats it.
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(windows(h.requests)).toEqual([10, 50, 50]);
  const sent = h.fetcher.mock.calls
    .map(([, sent]) => sent)
    .filter((sent) => String(sent?.body).includes("thread_window"));
  expect(
    sent
      .map((sent) => new Headers(sent?.headers).get("X-Buzz-Read-Priority"))
      .slice(-2),
  ).toEqual(["background", "foreground"]);
  // The page was read from the cursor the read for the parent had: the
  // oldest reply of the first window.
  const cursors = h.requests
    .filter(([f]) => f?.thread_window)
    .map(([f]) => [f?.until, f?.before_id]);
  expect(cursors[1]).toEqual([24, filler(4).id]);
  expect(cursors[2]).toEqual(cursors[1]);
  // Each of the three runs read the root once.
  expect(h.requests.filter(([f]) => f?.ids)).toHaveLength(3);
  view.dispose();
});

it("waits for a reopened read view's first read before reading for a missing parent", async () => {
  const parent = filler(0);
  const rows = [parent, ...Array.from({ length: 12 }, (_, n) => filler(n + 1))];
  const child = nested("child", 100, parent.id);
  const h = await setup((f) => serving(rows)(f));
  h.traffic.state({ status: "connected", routes: [] });
  h.traffic.established(channel);
  const first = h.session.thread(channel, root.id, { reading: true });
  await first.refresh();
  expect(first.snapshot().seeking).toBeUndefined();
  first.dispose();
  // A reply to a parent outside the loaded page arrives while it is closed,
  // beside the root: the reopened view takes both before it reads.
  rows.push(child);
  h.traffic.receive([root, child]);
  const before = h.requests.length;
  const view = h.session.thread(channel, root.id, { reading: true });
  expect(view.snapshot()).toMatchObject({
    status: "ready",
    resumed: true,
    seeking: true,
  });
  // It has no page of its own to read on from: nothing is sent.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(windows(h.requests.slice(before))).toEqual([]);
  await view.refresh();
  await vi.waitFor(() =>
    expect(view.snapshot().replies.map((row) => row.id)).toContain(parent.id),
  );
  expect(windows(h.requests.slice(before))).toEqual([10, 50]);
  view.dispose();
});

it.each([
  ["a deeper frontier asked for behind it", () => 75, () => 0],
  ["its frontier under a page asked for behind it", () => 0, undefined],
])("keeps %s when a page's read fails", async (_name, running, queued) => {
  const rows = Array.from({ length: 70 }, (_, n) => filler(n));
  let down = false;
  const h = await setup((f) => {
    if (down && f.thread_window) throw new TypeError("offline");
    return serving(rows)(f);
  });
  h.traffic.state({ status: "connected", routes: [] });
  const view = h.session.thread(channel, root.id, { reading: true });
  await view.refresh();
  vi.spyOn(Math, "random").mockReturnValue(1);
  vi.useFakeTimers();
  try {
    down = true;
    void view.loadMore(running);
    void view.loadMore(queued);
    await vi.advanceTimersByTimeAsync(7000);
    expect(view.snapshot()).toMatchObject({ recovering: true });
    down = false;
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() =>
      expect(view.snapshot()).toMatchObject({
        status: "ready",
        canLoadMore: false,
      }),
    );
    expect(view.snapshot().replies).toHaveLength(70);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    view.dispose();
  }
});

it("reports a root that a read view's read for a missing parent finds gone, and recovers on refresh", async () => {
  const parent = filler(0);
  const rows = [
    parent,
    ...Array.from({ length: 12 }, (_, n) => filler(n + 1)),
    nested("child", 100, parent.id),
  ];
  // The relay holds the root for the first window, then not for the read
  // that follows it.
  let roots = 0;
  let gone = true;
  const h = await setup((f) =>
    f.ids && gone && ++roots > 1 ? [] : serving(rows)(f),
  );
  const view = h.session.thread(channel, root.id, { reading: true });
  await view.refresh();
  expect(view.snapshot().replies).toHaveLength(10);
  // The thread's failure shows, with its retry, and not as a missing parent.
  await vi.waitFor(() =>
    expect(view.snapshot()).toMatchObject({
      status: "error",
      root: undefined,
      seeking: undefined,
    }),
  );
  gone = false;
  await view.refresh();
  await vi.waitFor(() =>
    expect(view.snapshot()).toMatchObject({
      status: "ready",
      error: undefined,
      canLoadMore: false,
    }),
  );
  expect(view.snapshot().root?.id).toBe(root.id);
  expect(view.snapshot().replies).toHaveLength(14);
  view.dispose();
});

it("ends a read view's read for a missing parent quietly when the relay rejects it, and still reports a page a person asks for", async () => {
  const parent = filler(0);
  const rows = [
    parent,
    ...Array.from({ length: 12 }, (_, n) => filler(n + 1)),
    nested("child", 100, parent.id),
  ];
  const h = await setup(serving(rows));
  const answer = h.fetcher.getMockImplementation();
  assert.exists(answer);
  h.fetcher.mockImplementation(async (url, sent) =>
    String(sent?.body).includes('"until"')
      ? new Response("{}", { status: 404 })
      : answer(url, sent),
  );
  h.traffic.state({ status: "connected", routes: [] });
  const recovery = h.session.recovery;
  assert.exists(recovery);
  vi.spyOn(Math, "random").mockReturnValue(1);
  vi.useFakeTimers();
  const view = h.session.thread(channel, root.id, { reading: true });
  try {
    const statuses: string[] = [];
    view.subscribe(() => statuses.push(view.snapshot().status));
    void view.refresh();
    await vi.waitFor(
      () =>
        expect(view.snapshot()).toMatchObject({
          status: "ready",
          seeking: true,
        }),
      { interval: 0 },
    );
    // The read and its three quick retries, and no more: the note may show.
    await vi.advanceTimersByTimeAsync(7000);
    expect(view.snapshot()).toMatchObject({
      status: "ready",
      canLoadMore: true,
      error: undefined,
      seeking: undefined,
      recovering: undefined,
    });
    expect(statuses).not.toContain("error");
    expect(recovery.snapshot().recovering).toBe(false);
    const sent = h.fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.fetcher.mock.calls).toHaveLength(sent);

    void view.loadMore();
    await vi.advanceTimersByTimeAsync(7000);
    expect(view.snapshot()).toMatchObject({
      status: "error",
      readKind: "older",
    });
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    view.dispose();
  }
});

it("reads nothing for a parent a read view holds but does not show", async () => {
  const parent = filler(20);
  const child = nested("child", 100, parent.id);
  const rows = [
    ...Array.from({ length: 12 }, (_, n) => filler(n)),
    parent,
    child,
  ];
  const h = await setup(serving(rows));
  const view = h.session.thread(channel, root.id, { reading: true });
  await view.refresh();
  expect(view.snapshot()).toMatchObject({ status: "ready", canLoadMore: true });
  h.traffic.receive([
    signed(author, {
      kind: 5,
      created_at: 500,
      content: "",
      tags: [["e", parent.id]],
    }),
  ]);
  await vi.waitFor(() =>
    expect(view.snapshot().replies.map((row) => row.id)).not.toContain(
      parent.id,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The deletion is the answer: no older page is read, and the note may show.
  expect(
    view.snapshot().replies.find((row) => row.id === child.id)?.replyParentId,
  ).toBe(parent.id);
  expect(view.snapshot()).toMatchObject({ canLoadMore: true });
  expect(view.snapshot().seeking).toBeUndefined();
  expect(windows(h.requests)).toEqual([10]);
  view.dispose();
});

it("settles session recovery when a read view with a quiet failure passes its memory limit", async () => {
  const rows = Array.from({ length: 12 }, (_, n) => filler(n));
  let down = false;
  const h = await setup((f) => {
    if (down && f.thread_window) throw new TypeError("offline");
    return serving(rows)(f);
  });
  h.traffic.state({ status: "connected", routes: [] });
  const view = h.session.thread(channel, root.id, { reading: true });
  await view.refresh();
  const recovery = h.session.recovery;
  assert.exists(recovery);
  down = true;
  vi.spyOn(Math, "random").mockReturnValue(1);
  vi.useFakeTimers();
  try {
    void view.loadMore();
    await vi.advanceTimersByTimeAsync(7000);
    expect(recovery.snapshot().recovering).toBe(true);
    // Live replies alone pass the limit: no read is running to report it.
    h.traffic.receive(
      Array.from({ length: 5 }, (_, n) =>
        message(author, channel, "x".repeat(1 << 20), 1000 + n, [
          ["e", root.id, "", "reply"],
        ]),
      ),
    );
    await vi.waitFor(() =>
      expect(view.snapshot()).toMatchObject({ status: "error", limited: true }),
    );
    expect(recovery.snapshot().recovering).toBe(false);
    // The limit's own error is retried by hand, not by recovery.
    const sent = h.requests.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.requests).toHaveLength(sent);
    expect(recovery.snapshot()).toMatchObject({
      recovering: false,
      shown: false,
    });
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    view.dispose();
  }
});
