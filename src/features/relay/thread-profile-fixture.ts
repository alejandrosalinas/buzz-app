import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { getPublicKey } from "nostr-tools";
import { createRelaySession } from "./session";
import type { RelaySession } from "./session";
import type { ThreadView } from "./threads";
import type { ChannelMessage, Profile } from "./contracts";
import type { ReadFilter, RelayEvent } from "./events";
import type { LiveCallbacks } from "./live";
import type { SavedHead } from "./persistence";
import type { ReadJournal } from "./read-state-storage";
import { bounds, message, profile, roster } from "./testing";
import { connectBrokerTransport } from "./transport";

export const workload = {
  version: 1,
  scenario: "mounted-app-thread-open-reopen",
  replies: 128,
  newerHeadRows: 20,
  authors: 8,
  observers: { thread: 1, profiles: 1 },
  transport: "production-broker-client/synthetic-loopback-http",
  storage: "memory",
  start: "authorized-session/production-head-warming-complete",
  cold: "empty-thread-and-profile-cache",
  warm: "same-session-after-cold/dispose-and-reopen",
} as const;

/** Fixed PUBLIC test secrets; signing is setup, never measured processing. */
export function threadData() {
  const key = (n: number) => {
    const secret = new Uint8Array(32);
    secret[31] = n;
    return { secret, pubkey: getPublicKey(secret) };
  };
  const relay = key(1);
  const viewer = key(2);
  const authors = Array.from({ length: workload.authors }, (_, i) =>
    key(i + 3),
  );
  const firstAuthor = authors[0];
  assert.ok(firstAuthor);
  const root = message(firstAuthor, "a", "Benchmark thread", 1_700_000_000);
  const replies = Array.from({ length: workload.replies }, (_, i) =>
    message(
      authors[i % authors.length] ?? firstAuthor,
      "a",
      `Reply ${i}: ${"synthetic content ".repeat(8)}`,
      root.created_at + i + 1,
      [["e", root.id, "", "reply"]],
    ),
  );
  const profiles = authors.map((author, i) =>
    profile(author, { name: `Author ${i}` }),
  );
  const membership = roster(relay, "a", [viewer.pubkey]);
  const headAuthor = key(11);
  const headProfile = profile(headAuthor, { name: "Newer head author" });
  const headRows = Array.from({ length: workload.newerHeadRows }, (_, i) =>
    message(
      headAuthor,
      "a",
      `Newer top-level message ${i}`,
      root.created_at + 1000 + i,
    ),
  ).reverse();
  const oldestHead = headRows.at(-1);
  assert.ok(oldestHead);
  const head = bounds(relay, "a", "head", {
    has_more: true,
    next_cursor: { created_at: oldestHead.created_at, id: oldestHead.id },
  });
  // Event IDs commit to signed content; signature randomness is not workload drift.
  const hash = createHash("sha256")
    .update(
      JSON.stringify(
        [
          root,
          ...replies,
          ...profiles,
          membership,
          ...headRows,
          headProfile,
          head,
        ].map((event) => event.id),
      ),
    )
    .digest("hex");
  return {
    relay,
    viewer,
    root,
    replies,
    profiles,
    membership,
    headRows,
    headProfile,
    head,
    hash,
  };
}
export type ThreadData = ReturnType<typeof threadData>;

type Request = {
  filters: ReadFilter[];
  priority: string;
  events: number;
  bytes: number;
};

/** Only the HTTP responder is synthetic. Client parse/verify/yield and engine
 * admission, warming, folding, paging and profile demand are production code. */
export async function threadSample(
  data: ThreadData,
  mount: (
    session: RelaySession,
    channelId: string,
    messageId: string,
  ) => {
    view: ThreadView;
    rendered(): Promise<void>;
    dispose(): void;
  },
  corrupt = false,
) {
  const requests: Request[] = [];
  // Unread conversation lookups: parents by ID (unscoped), or the viewer's
  // replies to them in one channel.
  const lookup = (filters: readonly ReadFilter[]) =>
    filters.every(
      (filter) =>
        filter.include_aux &&
        !filter.depth_limit &&
        (filter.authors || (filter.ids && !filter["#h"])),
    );
  let fixtureError: unknown;
  const server = createServer(async (request, response) => {
    try {
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url === "/api/relay/session") {
        response.end(
          JSON.stringify({
            viewer: data.viewer.pubkey,
            relayAuthor: data.relay.pubkey,
          }),
        );
        return;
      }
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/api/relay/query");
      let body = "";
      for await (const chunk of request) body += chunk;
      const filters = JSON.parse(body) as ReadFilter[];
      const first = filters[0];
      let events: RelayEvent[];
      if (first?.kinds?.includes(39002)) {
        assert.deepEqual(filters, [
          { kinds: [39002], "#p": [data.viewer.pubkey], limit: 1 },
        ]);
        events = [data.membership];
      } else if (first?.top_level) {
        assert.deepEqual(first["#h"], ["a"]);
        assert.equal(first.limit, data.headRows.length);
        events = [...data.headRows, data.head];
      } else if (first?.kinds?.includes(30315)) {
        assert.equal(filters.length, 1);
        assert.deepEqual(first["#d"], ["general"]);
        assert.equal(first.limit, first.authors?.length);
        assert.ok(first.limit && first.limit <= 100);
        events = [];
      } else if (first?.kinds?.includes(0)) {
        assert.equal(filters.length, 1);
        assert.ok(
          first.authors?.every((id) =>
            [...data.profiles, data.headProfile].some((p) => p.pubkey === id),
          ),
        );
        events = [...data.profiles, data.headProfile].filter((p) =>
          first.authors?.includes(p.pubkey),
        );
      } else if (lookup(filters)) {
        // Unread conversation membership: the viewer authored nothing here.
        for (const filter of filters)
          if (filter.authors)
            assert.deepEqual(filter.authors, [data.viewer.pubkey]);
        events = [];
      } else {
        assert.deepEqual(first, { ids: [data.root.id], "#h": ["a"], limit: 1 });
        assert.ok(filters.length === 1 || filters.length === 2);
        events = [data.root];
        const page = filters[1];
        if (page) {
          const cursor = data.replies.findIndex(
            (r) => r.id === page.thread_cursor_id,
          );
          if (page.thread_cursor_id !== undefined) {
            assert.ok(cursor >= 0);
            assert.equal(page.thread_cursor, data.replies[cursor]?.created_at);
          }
          assert.deepEqual(page, {
            kinds: [40002, 40008, 9],
            "#h": ["a"],
            "#e": [data.root.id],
            depth_limit: 100,
            limit: 50,
            include_aux: true,
            ...(cursor >= 0
              ? {
                  thread_cursor: data.replies[cursor]?.created_at,
                  thread_cursor_id: data.replies[cursor]?.id,
                }
              : {}),
          });
          events.push(...data.replies.slice(cursor + 1, cursor + 51));
        }
      }
      const payload = JSON.stringify(
        corrupt && events[0]?.id === data.root.id
          ? events.map((e) => ({ ...e, content: "tampered after signing" }))
          : events,
      );
      requests.push({
        filters,
        priority: String(request.headers["x-buzz-read-priority"]),
        events: events.length,
        bytes: Buffer.byteLength(payload),
      });
      response.end(payload);
    } catch (error) {
      fixtureError = error;
      response.statusCode = 500;
      response.end(JSON.stringify({ error: "Request failed." }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let dispose = () => {};
  const setupStart = performance.now();
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const transport = await connectBrokerTransport(
      `http://127.0.0.1:${address.port}`,
    );
    let traffic!: LiveCallbacks;
    let journal: ReadJournal | undefined;
    const heads = new Map<string, SavedHead>();
    const warmed = deferred();
    const owner = createRelaySession(
      {
        ...transport,
        subscribe(callbacks) {
          traffic = callbacks;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      {
        readStateFloor: () => 0,
        // Match service.ts production options; no production defaults are changed.
        prepared: true,
        warm: true,
        persistence: {
          async read() {
            return [...heads.values()];
          },
          async write(head) {
            heads.set(head.channelId, head);
            if (head.profiles.length === 1) warmed.resolve();
          },
          async remove(id) {
            heads.delete(id);
          },
          async retain(ids) {
            for (const id of heads.keys())
              if (!ids.includes(id)) heads.delete(id);
          },
          async clear() {
            heads.clear();
          },
          close() {},
        },
        readStateStorage: {
          capture: async () => structuredClone(journal),
          async update(change) {
            journal = change(journal);
            return journal;
          },
          close() {},
        },
      },
    );
    dispose = owner.dispose;
    // Authorization is real signed evidence, but connection/discovery is NOT timed.
    traffic.receive(
      await transport.query([
        { kinds: [39002], "#p": [data.viewer.pubkey], limit: 1 },
      ]),
    );
    await deadline(warmed.promise);
    const setupMs = performance.now() - setupStart;
    const setupRequests = requests.splice(0);
    assert.equal(setupRequests.length, 3);
    assert.ok(
      owner.session.profiling.snapshot().every((span) => span.outcome === "ok"),
      "setup still has pending work",
    );
    assert.equal(owner.session.profiles.snapshot().size, 1);
    assert.equal(
      owner.session.profiles.snapshot().get(data.headProfile.pubkey)?.name,
      "Newer head author",
    );
    assert.ok(
      data.profiles.every(
        (p) => !owner.session.profiles.snapshot().has(p.pubkey),
      ),
    );

    async function open(mode: "cold" | "warm") {
      owner.session.profiling.clear();
      const start = performance.now();
      const cpu = process.cpuUsage();
      const mounted = mount(owner.session, "a", data.root.id);
      const view = mounted.view;
      let publications = 0;
      let profilePublications = 0;
      let firstRowsMs: number | undefined;
      const done = deferred();
      const observe = () => {
        const snapshot = view.snapshot();
        if (
          snapshot.root &&
          snapshot.replies.length &&
          firstRowsMs === undefined
        )
          firstRowsMs = performance.now() - start;
        if (snapshot.status === "error")
          done.reject(fixtureError ?? new Error(snapshot.error));
        if (
          snapshot.status === "ready" &&
          !snapshot.canLoadMore &&
          data.profiles.every((p) =>
            owner.session.profiles.snapshot().has(p.pubkey),
          )
        )
          done.resolve();
      };
      const unsubscribe = view.subscribe(() => {
        publications++;
        observe();
      });
      const unprofile = owner.session.profiles.subscribe(() => {
        profilePublications++;
        observe();
      });
      try {
        observe();
        await deadline(done.promise);
        const completeMs = performance.now() - start;
        const cpuUsed = process.cpuUsage(cpu);
        await mounted.rendered();
        const domReadyMs = performance.now() - start;
        if (fixtureError) throw fixtureError;
        const snapshot = view.snapshot();
        assert.equal(snapshot.root?.id, data.root.id);
        assert.deepEqual(
          snapshot.replies.map((r) => r.id),
          data.replies.map((r) => r.id),
        );
        assertProjection(
          data,
          snapshot.root,
          snapshot.replies,
          owner.session.profiles.snapshot(),
        );
        assert.equal(snapshot.limited, false);
        assert.equal(snapshot.error, undefined);
        const timings = owner.session.profiling.snapshot();
        assert.ok(
          timings.every((t) => t.outcome === "ok"),
          "pending/failed engine work invalidates sample",
        );
        const trace = requests.splice(0);
        // Opening the thread renders unread replies whose conversation is
        // undecided; unread asks once per parent, so only the cold open pays.
        assert.equal(
          trace.filter((r) => lookup(r.filters)).length,
          mode === "cold" ? 1 : 0,
        );
        assert.equal(
          trace.filter((r) => r.filters.length === 2 && !lookup(r.filters))
            .length,
          4,
          "three data pages plus empty continuation",
        );
        assert.equal(
          trace.filter(
            (r) =>
              r.filters.length === 1 && r.filters[0]?.ids && !lookup(r.filters),
          ).length,
          mode === "cold" ? 1 : 0,
        );
        assert.equal(
          trace.filter((r) => r.filters[0]?.kinds?.includes(0)).length,
          mode === "cold" ? 1 : 0,
        );
        assert.equal(
          timings.filter((t) => t.stage === "read.verify").length,
          trace.length,
        );
        return {
          mode,
          correct: true as const,
          firstRowsMs,
          completeMs,
          domReadyMs,
          processCpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
          work: {
            httpQueries: trace.length,
            wireEventsValidated: trace.reduce((n, r) => n + r.events, 0),
            responseBytes: trace.reduce((n, r) => n + r.bytes, 0),
            threadObserverNotifications: publications,
            profileObserverNotifications: profilePublications,
          },
          trace,
          timings,
        };
      } finally {
        unsubscribe();
        unprofile();
        mounted.dispose();
      }
    }
    const cold = await open("cold");
    const warm = await open("warm");
    return { setupMs, setupRequests, phases: { cold, warm } };
  } finally {
    dispose();
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
}

async function deadline<T>(work: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("Thread scenario exceeded 10s correctness deadline"),
            ),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Plain-text scenario oracle, deliberately not the production fold. */
export function assertProjection(
  data: ThreadData,
  root: ChannelMessage | undefined,
  replies: readonly ChannelMessage[],
  profiles: ReadonlyMap<string, Profile>,
) {
  assert.ok(root);
  const rows = [root, ...replies];
  const source = [data.root, ...data.replies];
  assert.equal(rows.length, source.length);
  rows.forEach((row, i) => {
    const event = source[i];
    assert.ok(event);
    assert.equal(row.id, event.id);
    assert.equal(row.channelId, "a");
    assert.equal(row.authorId, event.pubkey);
    assert.equal(row.createdAt, event.created_at);
    assert.equal(row.content, event.content);
    assert.equal(row.threadRootId, i === 0 ? undefined : data.root.id);
    assert.deepEqual(row.mentions, []);
    assert.deepEqual(row.attachments, []);
    assert.deepEqual(row.reactions, []);
    assert.equal(row.replyCount, 0);
    assert.deepEqual(row.participants, []);
  });
  data.profiles.forEach((event, i) => {
    assert.deepEqual(profiles.get(event.pubkey), { name: `Author ${i}` });
  });
}
