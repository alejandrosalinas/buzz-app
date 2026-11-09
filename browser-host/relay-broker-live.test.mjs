import {
  getLogger,
  logLevel,
  setLogLevel,
} from "../src/features/developer/logging.ts";
import { fixtureRelayUrl, fixtureAliases } from "../tests/relay-config.ts";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test, expect, vi } from "vitest";
import {
  getPublicKey,
  generateSecretKey,
  finalizeEvent,
  nip44,
} from "nostr-tools";
import { createRelaySession } from "../src/features/relay/session.ts";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import { ARTIFACT_SYNC_MAX_VIEWS } from "../src/features/relay/artifact-sync-filter.ts";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";
import { createOutbox, PublishRejected } from "../src/features/relay/outbox.ts";

/** Real HTTP setup/response cancellation and production subscriber; only upstream
 * WS I/O is substituted. No Keychain access or network outside localhost. */
async function harness(
  refuseAt = 0,
  reason = "rate-limited: quota exceeded; retry in 0s",
  options = {},
) {
  const key = new Uint8Array(32);
  key[31] = 1;
  const requests = [];
  const sockets = [];
  const publications = [];
  const upstream = [];
  const frames = [];
  const stored = new Map();
  const roster = finalizeEvent(
    {
      kind: 39002,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags: [
        ["d", "a"],
        ["p", getPublicKey(key)],
      ],
    },
    key,
  );
  let handler;
  const server = createServer((req, res) => {
    if (req.url.endsWith("/stream")) options.response?.(res);
    handler?.(req, res);
  });
  const plugin = relayBrokerPlugin({
    archiveFile: ":memory:",
    relayUrl: fixtureRelayUrl,
    communityAliases: fixtureAliases,
    identity: () => key,
    authority: async () => ({
      relayAuthor: getPublicKey(key),
      artifactSupport: true,
    }),
    upstreamFetch: async (url, init) => {
      upstream.push(String(url));
      const filters = JSON.parse(init?.body ?? "[]");
      return Response.json(
        filters[0]?.kinds?.includes(39002) && options.roster
          ? [roster]
          : (filters[0]?.ids ?? []).flatMap((id) => stored.get(id) ?? []),
      );
    },
    socketFactory: () => {
      const socket = {
        readyState: 1,
        send(text) {
          const [kind, id, ...filters] = JSON.parse(text);
          const filter = filters[0];
          frames.push({ kind, id, at: performance.now(), socket });
          if (kind === "AUTH" && !options.holdAuth)
            setImmediate(() => this.receive(["OK", id.id, true]));
          if (kind === "EVENT") publications.push({ event: id, socket });
          if (kind !== "REQ") return;
          requests.push({ at: performance.now(), id, filter, filters, socket });
          const refused = requests.length === refuseAt;
          // WS replies arrive on an I/O turn, which also lets HTTP readers drain.
          if (!options.holdSetup)
            setImmediate(() =>
              this.receive(refused ? ["CLOSED", id, reason] : ["EOSE", id]),
            );
        },
        receive(frame) {
          if (this.readyState === 1)
            return this.onmessage?.({ data: JSON.stringify(frame) });
        },
        close() {
          this.readyState = 3;
          this.onclose?.();
        },
      };
      sockets.push(socket);
      setImmediate(() => socket.receive(["AUTH", "fixture"]));
      return socket;
    },
  });
  await plugin.configureServer({
    httpServer: server,
    config: { logger: { info() {}, error() {} } },
    middlewares: {
      use(cb) {
        handler = cb;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const controllers = [];
  return {
    key,
    sockets,
    requests,
    publications,
    upstream,
    frames,
    stored,
    base,
    async post(channels, origin = base) {
      const controller = new AbortController();
      controllers.push(controller);
      const response = await fetch(`${base}/api/relay/stream`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ channels, statusDeltas: options.statusDeltas }),
        signal: controller.signal,
      });
      return { response, abort: () => controller.abort() };
    },
    async close() {
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(10);
  }
  throw new Error("Local HTTP fixture did not reach expected state");
}

test("presence busy skips cross the real broker as null while cooldown keeps its deadline", async () => {
  const h = await harness();
  const nativeFetch = globalThis.fetch;
  const outcomes = [];
  let traffic;
  let clock = 0; // Integer milliseconds keep ceil-based admission deadlines exact.
  try {
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubGlobal("fetch", async (input, init) => {
      const response = await nativeFetch(input, {
        ...init,
        headers: {
          ...init?.headers,
          ...(init?.method === "POST" ? { Origin: h.base } : {}),
        },
      });
      if (String(input).endsWith("/stream-presence"))
        outcomes.push(await response.clone().json());
      return response;
    });
    const transport = await connectBrokerTransport(h.base);
    let snapshot;
    traffic = transport.subscribe({
      receive() {},
      established() {},
      denied() {},
      state(value) {
        snapshot = value;
      },
    });
    await until(() => snapshot?.status === "connected");
    const first = traffic.publishPresence(
      "online",
      new AbortController().signal,
    );
    await until(() => h.publications.length === 1);
    clock += 5100; // Gate elapsed; real receipt timer remains held.
    expect(
      await traffic.publishPresence("away", new AbortController().signal),
    ).toBeNull();
    expect(outcomes).toEqual([{ accepted: null }]);
    expect(h.publications).toHaveLength(1);
    const { event, socket } = h.publications[0];
    await socket.receive([
      "OK",
      event.id,
      false,
      "rate-limited: quota exceeded; retry in 3s",
    ]);
    expect(await first).toBe(false);
    expect(
      await traffic.publishPresence("away", new AbortController().signal),
    ).toEqual({ retryAfterMs: 4000 });
    expect(outcomes.at(-1)).toEqual({ accepted: null, retryAfterMs: 4000 });
    clock += 4000;
    const next = traffic.publishPresence("away", new AbortController().signal);
    await until(() => h.publications.length === 2);
    expect(h.publications[1].event.content).toBe("away");
    await socket.receive(["OK", h.publications[1].event.id, true, ""]);
    expect(await next).toBe(true);
  } finally {
    traffic?.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await h.close();
  }
});

test("POST replacement and a second stream share server cooldown without pacing healthy starts; response close disposes WS", async () => {
  const h = await harness(1);
  try {
    const first = await h.post(["a", "b"]);
    expect(first.response.status).toBe(200);
    // WebKit must not wait for a later heartbeat to receive the last SSE frame.
    expect(first.response.headers.get("transfer-encoding")).toBeNull();
    expect(first.response.headers.get("connection")).toBe("close");
    await until(() => h.requests.length === 4);
    const second = await h.post(["c", "d"]);
    expect(second.response.status).toBe(200);
    first.abort();
    await until(() => h.sockets[0].readyState === 3);
    const replacement = await h.post(["a", "b", "e"]);
    expect(replacement.response.status).toBe(200);
    await delay(300);
    expect(h.requests).toHaveLength(4);
    await until(() => h.requests.length === 13);
    // A local quota refusal with a zero-second hint still has a rounding margin.
    expect(h.requests[4].at - h.requests[0].at).toBeGreaterThanOrEqual(990);
    expect(h.requests.slice(4).map((r) => r.socket)).toEqual(
      expect.arrayContaining([h.sockets[1], h.sockets[2]]),
    );
    second.abort();
    replacement.abort();
    await until(() => h.sockets.every((s) => s.readyState === 3));
  } finally {
    await h.close();
  }
});

test("real HTTP accepts the 1022-channel body and rejects invalid/oversized/origin inputs before WS allocation", async () => {
  const h = await harness();
  try {
    const channels = Array.from(
      { length: 1022 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const large = await h.post(channels);
    expect(large.response.status).toBe(200);
    expect(large.response.headers.get("content-type")).toBe(
      "text/event-stream",
    );
    large.abort();
    await until(() => h.sockets.every((s) => s.readyState === 3));
    const count = h.sockets.length;
    for (const invalid of [[""], ["x".repeat(150001)]]) {
      const { response } = await h.post(invalid);
      expect([400, 413]).toContain(response.status);
      await response.text();
    }
    const denied = await h.post(["a"], "https://other.invalid");
    expect(denied.response.status).toBe(403);
    expect(h.sockets).toHaveLength(count);
  } finally {
    await h.close();
  }
});

test.each([null, 1])(
  "maximum channel interests survive observer startup and toggles (initial %s) through the real broker/browser stream",
  async (initialObserver) => {
    const h = await harness();
    const nativeFetch = globalThis.fetch;
    let traffic;
    try {
      const fetcher = vi.fn((input, init) =>
        nativeFetch(input, {
          ...init,
          headers: {
            ...init?.headers,
            ...(init?.method === "POST" ? { Origin: h.base } : {}),
          },
        }),
      );
      vi.stubGlobal("fetch", fetcher);
      const transport = await connectBrokerTransport(h.base);
      const states = [],
        received = [];
      let snapshot;
      traffic = transport.subscribe({
        receive(events) {
          received.push(...events);
        },
        established() {},
        denied() {},
        state(value) {
          snapshot = value;
          states.push(value);
        },
      });
      const ids = Array.from(
        { length: 1024 },
        (_, i) => `channel-${String(i).padStart(4, "0")}`,
      );
      traffic.observe(initialObserver);
      traffic.update(ids);
      const streamPosts = () =>
        fetcher.mock.calls.filter(([url]) => String(url).endsWith("/stream"))
          .length;
      let sockets, posts;
      for (const [phase, observer] of [
        initialObserver,
        initialObserver === null ? 1 : null,
        initialObserver,
      ].entries()) {
        traffic.observe(observer);
        const enabled = observer !== null;
        await until(
          () =>
            snapshot?.status === "connected" &&
            snapshot.routes.length === 1026 + Number(enabled) &&
            snapshot.routes.every(
              (r) => r.status === "live" || r.status === "limited",
            ) &&
            (!enabled ||
              snapshot.routes.some(
                (r) => r.id === "observer" && r.status === "live",
              )),
        );
        expect(
          snapshot.routes
            .filter((r) => r.channelId)
            .map((r) => r.channelId)
            .sort(),
        ).toEqual(ids);
        expect(
          snapshot.routes
            .filter((r) => r.status === "limited")
            .map((r) => r.channelId)
            .sort(),
        ).toEqual(ids.slice(enabled ? 1020 : 1021));
        // One wire stays free for the silence probe. All interests stay visible.
        expect(
          snapshot.routes.filter((r) => r.status !== "limited"),
        ).toHaveLength(1023);
        expect(snapshot.routes.some((r) => r.id === "observer")).toBe(enabled);
        sockets ??= h.sockets.length;
        posts ??= streamPosts();
        expect(h.sockets).toHaveLength(sockets);
        expect(streamPosts()).toBe(posts);

        const socket = h.sockets.at(-1);
        for (const [kind, tags] of [
          [9, [["h", ids[0]]]],
          [0, []],
          [44100, [["p", getPublicKey(h.key)]]],
        ]) {
          const route = h.requests.find(
            (r) => r.socket === socket && r.filter.kinds.includes(kind),
          );
          expect(route).toBeDefined();
          const event = finalizeEvent(
            {
              kind,
              tags,
              created_at: Math.floor(Date.now() / 1000),
              content: `ordinary traffic in observer phase ${phase}`,
            },
            h.key,
          );
          await socket.receive(["EVENT", route.id, event]);
          await until(() => received.some((r) => r.id === event.id));
        }
        expect(received).toHaveLength((phase + 1) * 3);
        expect(
          states.filter((s) => s.status === "retrying" || s.status === "error"),
        ).toEqual([]);
      }
    } finally {
      traffic?.dispose();
      vi.unstubAllGlobals();
      await h.close();
    }
  },
);

test.each([
  "rate-limited: quota exceeded; retry in 0s",
  "temporary: fixture read unavailable",
])(
  "actual browser transport retry preserves healthy routes (%s)",
  async (reason) => {
    const h = await harness(5, reason);
    const nativeFetch = globalThis.fetch;
    let traffic;
    try {
      vi.stubGlobal("fetch", (input, init) =>
        nativeFetch(input, {
          ...init,
          headers: {
            ...init?.headers,
            ...(init?.method === "POST" ? { Origin: h.base } : {}),
          },
        }),
      );
      const transport = await connectBrokerTransport(h.base);
      let snapshot;
      traffic = transport.subscribe({
        receive() {},
        established() {},
        denied() {},
        state(value) {
          snapshot = value;
        },
      });
      traffic.update(["a", "b", "c"]);
      await until(() =>
        snapshot?.routes.some((r) => r.channelId === "c" && r.error),
      );
      expect(snapshot.routes.filter((r) => r.status === "live")).toHaveLength(
        4,
      );
      const sockets = h.sockets.length;
      const healthySocket = h.sockets.at(-1);
      traffic.retry();
      traffic.retry(); // Duplicate clicks coalesce the control request.
      await until(() => snapshot.routes.every((r) => r.status === "live"));
      expect(h.sockets).toHaveLength(sockets);
      expect(healthySocket.readyState).toBe(1);
      expect(h.requests.map((r) => r.filter["#h"]?.[0] ?? "global")).toEqual([
        "global",
        "global",
        "a",
        "b",
        "c",
        "c",
      ]);
      traffic.dispose();
      await until(() => h.sockets.every((s) => s.readyState === 3));
    } finally {
      traffic?.dispose();
      vi.unstubAllGlobals();
      await h.close();
    }
  },
);

test("retry control is bounded, same-origin/community scoped and removed with its response owner", async () => {
  const h = await harness();
  const post = (path, body, origin = h.base) =>
    fetch(`${h.base}${path}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const stream = await h.post(["a"]);
    const streamId = stream.response.headers.get("x-buzz-live-id");
    expect(streamId).toMatch(/^[0-9a-f]{32}$/);
    await until(() => h.requests.length === 3);
    for (const [body, status] of [
      [{ streamId: "bad" }, 400],
      [{ streamId: "f".repeat(32) }, 404],
      [{ streamId: "x".repeat(300) }, 413],
    ]) {
      const response = await post("/api/relay/stream-retry", body);
      expect(response.status).toBe(status);
      await response.text();
    }
    const cross = await post(
      "/api/relay/stream-retry",
      { streamId },
      "https://evil.invalid",
    );
    expect(cross.status).toBe(403);
    const other = "https://other.invalid";
    await (await post("/api/relay/register", { url: other })).text();
    const wrongScope = await post(
      `/api/relay/${encodeURIComponent(other)}/stream-retry`,
      { streamId },
    );
    expect(wrongScope.status).toBe(404);
    expect(h.sockets).toHaveLength(1);
    const valid = await post("/api/relay/stream-retry", { streamId });
    expect(valid.status).toBe(200);
    await valid.text();
    expect(h.requests).toHaveLength(3); // No healthy route restarts.
    stream.abort();
    await until(() => h.sockets[0].readyState === 3);
    const stale = await post("/api/relay/stream-retry", { streamId });
    expect(stale.status).toBe(404);
  } finally {
    await h.close();
  }
});

test("current demand reaches the front of a large roster without replacing its POST or healthy globals", async () => {
  const h = await harness(0, undefined, { holdSetup: true, holdAuth: true });
  const nativeFetch = globalThis.fetch;
  let traffic;
  try {
    const fetcher = vi.fn((input, init) =>
      nativeFetch(input, {
        ...init,
        headers: {
          ...init?.headers,
          ...(init?.method === "POST" ? { Origin: h.base } : {}),
        },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const transport = await connectBrokerTransport(h.base);
    traffic = transport.subscribe({
      receive() {},
      established() {},
      denied() {},
      state() {},
    });
    const ids = Array.from(
      { length: 128 },
      (_, i) => `channel-${String(i).padStart(3, "0")}`,
    );
    traffic.prioritize([ids[127]]);
    traffic.update(ids);
    // Hold authentication until the startup control POSTs have reached the host.
    const initialControl = () =>
      fetcher.mock.calls.findIndex(
        ([url, init]) =>
          String(url).endsWith("/stream-priority") &&
          JSON.parse(init.body).channels[0] === ids[127],
      );
    await until(() => initialControl() >= 0);
    await fetcher.mock.results[initialControl()].value;
    const interestControl = () =>
      fetcher.mock.calls.findIndex(([url]) =>
        String(url).endsWith("/stream-interests"),
      );
    await until(() => interestControl() >= 0);
    await fetcher.mock.results[interestControl()].value;
    const auth = h.frames.find((frame) => frame.kind === "AUTH");
    await h.sockets[0].receive(["OK", auth.id.id, true]);
    await until(() => h.requests.length >= 3);
    expect(
      h.requests.slice(0, 3).map((r) => r.filter["#h"]?.[0] ?? "global"),
    ).toEqual(["global", "global", ids[127]]);
    const sockets = h.sockets.length;
    const posts = fetcher.mock.calls.filter(([url]) =>
      String(url).endsWith("/stream"),
    ).length;
    traffic.prioritize([ids[126]]);
    traffic.prioritize([ids[125]]);
    // Observe the latest real control response before freeing setup capacity.
    const targetControl = () =>
      fetcher.mock.calls.findIndex(
        ([url, init]) =>
          String(url).endsWith("/stream-priority") &&
          JSON.parse(init.body).channels[0] === ids[125],
      );
    await until(() => targetControl() >= 0);
    await fetcher.mock.results[targetControl()].value;
    await h.sockets[0].receive(["EOSE", h.requests[0].id]);
    await until(() => h.requests.some((r) => r.filter["#h"]?.[0] === ids[125]));
    expect(
      h.requests.findIndex((r) => r.filter["#h"]?.[0] === ids[125]),
    ).toBeLessThan(7);
    expect(h.sockets).toHaveLength(sockets);
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).endsWith("/stream")),
    ).toHaveLength(posts);
    expect(h.requests.filter((r) => !r.filter["#h"])).toHaveLength(2);
  } finally {
    traffic?.dispose();
    vi.unstubAllGlobals();
    await h.close();
  }
});
test("priority control cannot allocate interests or bypass owner, origin, community and body bounds", async () => {
  const h = await harness();
  try {
    const opened = await h.post(["a"]);
    const streamId = opened.response.headers.get("x-buzz-live-id");
    const control = (
      body,
      path = "/api/relay/stream-priority",
      origin = h.base,
    ) =>
      fetch(`${h.base}${path}`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    for (const body of [
      { streamId, channels: [""] },
      { streamId, channels: Array(65).fill("a") },
      { streamId: "bad", channels: ["a"] },
    ])
      expect((await control(body)).status).toBe(400);
    expect(
      (
        await control(
          { streamId, channels: ["a"] },
          "/api/relay/secondary/stream-priority",
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await control(
          { streamId, channels: ["a"] },
          undefined,
          "https://wrong.test",
        )
      ).status,
    ).toBe(403);
    expect(
      (await control({ streamId, channels: ["x".repeat(9001)] })).status,
    ).toBe(413);
    expect(
      (await control({ streamId, channels: ["not-an-interest"] })).status,
    ).toBe(200);
    await until(() => h.requests.length === 3);
    expect(
      h.requests.filter((r) => r.filter["#h"]).map((r) => r.filter["#h"]),
    ).toEqual([["a"]]);
    opened.abort();
    await until(() => h.sockets.every((s) => s.readyState === 3));
    expect((await control({ streamId, channels: ["a"] })).status).toBe(404);
    expect(h.sockets).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("real signed/encrypted WS → host decode → SSE → session activity; demand and clear fence without replacing chat", async () => {
  const h = await harness();
  const nativeFetch = globalThis.fetch;
  let owner, release;
  try {
    vi.stubGlobal("fetch", (input, init) =>
      nativeFetch(input, {
        ...init,
        headers: {
          ...init?.headers,
          ...(init?.method === "POST" ? { Origin: h.base } : {}),
        },
      }),
    );
    const transport = await connectBrokerTransport(h.base);
    expect(transport.agentActivity).toBe(true);
    owner = createRelaySession(transport, { prepared: true });
    // Initial authoritative roster replacement clears access-scoped activity.
    // Establish that startup boundary before capturing the observer incarnation.
    await until(
      () => owner.session.live.snapshot().roster.state === "verified",
    );
    release = owner.session.agentActivity.activate();
    await until(
      () => owner.session.agentActivity.snapshot().status === "listening",
    );
    const routes = () =>
      h.requests.filter((r) => r.filter.kinds.includes(24200));
    const first = routes().at(-1);
    const socketCount = h.sockets.length;
    const globals = h.requests.filter(
      (r) => !r.filter.kinds.includes(24200),
    ).length;
    const agent = generateSecretKey(),
      sender = getPublicKey(agent),
      viewer = getPublicKey(h.key);
    const encrypt = (
      raw,
      tags = [
        ["p", viewer],
        ["agent", sender],
        ["frame", "telemetry"],
      ],
    ) =>
      finalizeEvent(
        {
          kind: 24200,
          created_at: Math.floor(Date.now() / 1000),
          tags,
          content: nip44.v2.encrypt(
            JSON.stringify(raw),
            nip44.v2.utils.getConversationKey(agent, viewer),
          ),
        },
        agent,
      );
    const raw = {
      kind: "turn_started",
      seq: 1,
      timestamp: new Date().toISOString(),
      channelId: null,
      sessionId: null,
      turnId: "synthetic-turn",
      payload: { text: "inert <script>raw</script>" },
    };
    const event = encrypt(raw);
    const view = owner.session.observe([{ kinds: [24200], limit: 1 }]);
    await first.socket.receive(["EVENT", first.id, event]);
    await until(
      () => owner.session.agentActivity.snapshot().records.length === 1,
    );
    expect(owner.session.agentActivity.snapshot().records[0].plaintext).toBe(
      JSON.stringify(raw),
    );
    expect(owner.session.agentActivity.snapshot().turns[0].state).toBe(
      "working",
    );
    expect(view.snapshot().events).toEqual([]);
    // Wrong direction is signed/encrypted but must never become telemetry.
    await first.socket.receive([
      "EVENT",
      first.id,
      encrypt(raw, [
        ["p", viewer],
        ["agent", sender],
        ["frame", "control"],
      ]),
    ]);
    await delay(20);
    expect(owner.session.agentActivity.snapshot().records).toHaveLength(1);
    await owner.clearCache();
    expect(owner.session.agentActivity.snapshot().records).toHaveLength(0);
    await until(() => routes().length === 2);
    await first.socket.receive(["EVENT", first.id, event]);
    await delay(20);
    expect(owner.session.agentActivity.snapshot().records).toHaveLength(0);
    const second = routes().at(-1);
    await until(
      () => owner.session.agentActivity.snapshot().status === "listening",
    );
    await second.socket.receive([
      "EVENT",
      second.id,
      encrypt({ ...raw, kind: "turn_completed" }),
    ]);
    await until(
      () => owner.session.agentActivity.snapshot().records.length === 1,
    );
    expect(owner.session.agentActivity.snapshot().turns[0].state).toBe("ended");
    release();
    expect(owner.session.agentActivity.snapshot().records).toHaveLength(0);
    await delay(30);
    expect(h.sockets).toHaveLength(socketCount);
    expect(
      h.requests.filter((r) => !r.filter.kinds.includes(24200)),
    ).toHaveLength(globals);
    view.dispose();
  } finally {
    release?.();
    owner?.dispose();
    vi.unstubAllGlobals();
    await h.close();
  }
});

test("channel recovery under broker backpressure invalidates owner activity typing without restarting observer", async () => {
  let response;
  let backpressured = false;
  const h = await harness(0, undefined, {
    roster: true,
    response(res) {
      response = res;
      Object.defineProperty(res, "writableNeedDrain", {
        get: () => backpressured,
      });
    },
  });
  let owner, release;
  try {
    browserFetch(h.base);
    owner = createRelaySession(await connectBrokerTransport(h.base), {
      prepared: true,
    });
    await until(
      () => owner.session.live.snapshot().roster.state === "verified",
    );
    release = owner.session.agentActivity.activate();
    await until(
      () => owner.session.agentActivity.snapshot().status === "listening",
    );
    const channel = h.requests.find((r) => r.filter["#h"]?.includes("a"));
    const observer = h.requests.find((r) => r.filter.kinds.includes(24200));
    const agent = generateSecretKey();
    const viewer = getPublicKey(h.key);
    const telemetry = (seq) =>
      finalizeEvent(
        {
          kind: 24200,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["p", viewer],
            ["agent", getPublicKey(agent)],
            ["frame", "telemetry"],
          ],
          content: nip44.v2.encrypt(
            JSON.stringify({
              kind: "turn_liveness",
              channelId: "a",
              turnId: "typing-turn",
              seq,
              timestamp: new Date().toISOString(),
            }),
            nip44.v2.utils.getConversationKey(agent, viewer),
          ),
        },
        agent,
      );
    await observer.socket.receive(["EVENT", observer.id, telemetry(1)]);
    await until(
      () => owner.session.agentActivity.snapshot().records.length === 1,
    );
    await channel.socket.receive([
      "EVENT",
      channel.id,
      finalizeEvent(
        {
          kind: 20002,
          content: "",
          created_at: Math.floor(Date.now() / 1000),
          tags: [["h", "a"]],
        },
        agent,
      ),
    ]);
    await until(
      () => owner.session.agentActivity.snapshot().typing.length === 1,
    );

    // Only this channel fails. The observer and authenticated socket stay live.
    // Force recovery before drain, so latest-snapshot-only coalescing loses the edge.
    backpressured = true;
    await channel.socket.receive([
      "CLOSED",
      channel.id,
      "error: retry channel",
    ]);
    owner.session.live.retry();
    await until(
      () =>
        h.requests.filter((r) => r.filter["#h"]?.includes("a")).length === 2,
    );
    response.emit("drain");
    // A subsequent observer frame is the SSE consumption barrier, not a sleep.
    await observer.socket.receive(["EVENT", observer.id, telemetry(2)]);
    await until(
      () => owner.session.agentActivity.snapshot().records.length === 2,
    );
    expect(owner.session.agentActivity.snapshot().status).toBe("listening");
    expect(
      h.requests.filter((r) => r.filter.kinds.includes(24200)),
    ).toHaveLength(1);
    expect(h.sockets).toHaveLength(1);
    expect(owner.session.agentActivity.snapshot().typing).toEqual([]);
    const recovered = h.requests
      .filter((r) => r.filter["#h"]?.includes("a"))
      .at(-1);
    await recovered.socket.receive([
      "EVENT",
      recovered.id,
      finalizeEvent(
        {
          kind: 20002,
          content: "",
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["h", "a"],
            ["e", "a".repeat(64), "", "reply"],
          ],
        },
        agent,
      ),
    ]);
    await until(
      () => owner.session.agentActivity.snapshot().typing.length === 1,
    );
    expect(owner.session.agentActivity.snapshot().typing[0].threadRootId).toBe(
      "a".repeat(64),
    );
  } finally {
    release?.();
    owner?.dispose();
    vi.unstubAllGlobals();
    await h.close();
  }
});

// Browser-origin HTTP is local credential IPC; assertions below inspect upstream transport.
function browserFetch(base) {
  const nativeFetch = globalThis.fetch;
  const fetcher = vi.fn((input, init) =>
    nativeFetch(input, {
      ...init,
      headers: {
        ...init?.headers,
        ...(init?.method === "POST" ? { Origin: base } : {}),
      },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
const callbacks = { receive() {}, established() {}, denied() {}, state() {} };
async function outgoing(transport, content = "socket message") {
  return transport.writer.sign(
    {
      kind: 9,
      content,
      tags: [["h", "a"]],
      created_at: Math.floor(Date.now() / 1000),
    },
    new AbortController().signal,
  );
}

test("typing signing admits only empty conversation scope and stays outside durable write kinds", async () => {
  const h = await harness();
  try {
    browserFetch(h.base);
    const transport = await connectBrokerTransport(h.base);
    expect(transport.writer.kinds).not.toContain(20002);
    const live = transport.subscribe(callbacks);
    expect(live.publish).toBeUndefined(); // Agent presence remains unsupported.
    expect(live.publishTyping).toBeTypeOf("function");
    live.dispose();
    const pulse = {
      kind: 20002,
      content: "",
      tags: [["h", "dm"]],
      created_at: Math.floor(Date.now() / 1000),
    };
    expect(
      await transport.writer.sign(pulse, new AbortController().signal),
    ).toMatchObject(pulse);
    for (const change of [
      { content: "draft" },
      { tags: [] },
      {
        tags: [
          ["h", "dm"],
          ["p", getPublicKey(h.key)],
        ],
      },
      {
        tags: [
          ["h", "dm"],
          ["h", "other"],
        ],
      },
    ]) {
      await expect(
        transport.writer.sign(
          { ...pulse, ...change },
          new AbortController().signal,
        ),
      ).rejects.toThrow("Signing failed (400)");
    }
    expect(h.publications).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
    await h.close();
  }
});

test("session outbox publishes and reconciles on its authenticated live socket", async () => {
  const h = await harness(0, undefined, { roster: true });
  let owner;
  try {
    const fetcher = browserFetch(h.base);
    const transport = await connectBrokerTransport(h.base);
    owner = createRelaySession(transport, {
      prepared: true,
      outboxStorage: { load: () => [], save() {} },
    });
    await until(() => h.requests.length >= 2);
    const id = owner.session.messages.send("a", "shared socket");
    await until(() => h.publications.length === 1);
    const { event, socket } = h.publications[0];
    expect(event.id).toBe(id);
    // The signed live echo may interleave with the private publication receipt.
    const profile = finalizeEvent(
      {
        kind: 0,
        created_at: event.created_at,
        tags: [],
        content: '{"name":"fixture"}',
      },
      h.key,
    );
    await socket.receive(["EVENT", h.requests[0].id, profile]);
    h.stored.set(id, event);
    await socket.receive(["OK", id, true, ""]);
    await until(() => owner.session.outbox.snapshot().length === 0);
    expect(h.sockets).toHaveLength(1);
    expect(h.upstream.some((url) => url.endsWith("/events"))).toBe(false);
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).endsWith("/stream")),
    ).toHaveLength(1);
    expect(h.upstream.some((url) => url.endsWith("/query"))).toBe(true); // Explicit temporary read gate.
  } finally {
    owner?.dispose();
    vi.unstubAllGlobals();
    await h.close();
  }
});

test("production interest controls preserve socket/global routes and pending writes", async () => {
  const h = await harness();
  let traffic;
  try {
    const fetcher = browserFetch(h.base);
    const transport = await connectBrokerTransport(h.base);
    traffic = transport.subscribe(callbacks);
    traffic.update(["a"]);
    await until(() => h.requests.length === 3);
    const event = await outgoing(transport);
    const result = transport.writer.publish(
      event,
      new AbortController().signal,
    );
    await until(() => h.publications.length === 1);
    traffic.update(["a", "b"]);
    traffic.update(["b", "c"]);
    await until(() => h.requests.some((r) => r.filter["#h"]?.[0] === "c"));
    expect(h.sockets).toHaveLength(1);
    expect(h.requests.filter((r) => !r.filter["#h"])).toHaveLength(2);
    expect(
      h.frames.some(
        (f) =>
          f.kind === "CLOSE" &&
          f.id === h.requests.find((r) => r.filter["#h"]?.[0] === "a").id,
      ),
    ).toBe(true);
    await h.sockets[0].receive(["OK", event.id, true, "private-result"]);
    expect(await result).toBe("private-result");
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).endsWith("/stream")),
    ).toHaveLength(1);
    expect(h.upstream.some((url) => url.endsWith("/events"))).toBe(false);
  } finally {
    traffic?.dispose();
    vi.unstubAllGlobals();
    await h.close();
  }
});

test.each([
  ["restricted: not a member", true, "Relay request failed (503)"],
  [
    'invalid: an open channel named "Launch" already exists',
    true,
    'An open channel named "Launch" already exists',
  ],
  [
    "error: internal server error",
    false,
    "Relay delivery could not be confirmed (503)",
  ],
  [
    "rate-limited: quota exceeded; retry in 17s",
    true,
    "rate-limited: quota exceeded; retry in 17s",
  ],
  [
    "rate-limited: shared admission unavailable",
    true,
    "rate-limited: shared admission unavailable",
  ],
  [
    "rate-limited: private-agent-policy\nforged-line",
    true,
    "rate-limited: unrecognized reason",
  ],
])(
  "real broker preserves rejection versus uncertain command outcome: %s",
  async (reason, rejected, message) => {
    const h = await harness();
    let traffic;
    try {
      browserFetch(h.base);
      const transport = await connectBrokerTransport(h.base);
      traffic = transport.subscribe(callbacks);
      await until(() => h.requests.length >= 1);
      const event = await outgoing(transport);
      const result = transport.writer
        .publish(event, new AbortController().signal)
        .catch((e) => e);
      await until(() => h.publications.length === 1);
      await h.sockets[0].receive(["OK", event.id, false, reason]);
      const error = await result;
      expect(error).toBeInstanceOf(Error);
      expect(error instanceof PublishRejected).toBe(rejected);
      expect(error.message).toBe(message);
      expect(h.publications).toHaveLength(1);
      // A WS refusal must not pause the independent HTTP API admission lane.
      await expect(
        transport.query([{ kinds: [0], limit: 1 }]),
      ).resolves.toEqual([]);
      expect(h.upstream.some((url) => url.endsWith("/events"))).toBe(false);
    } finally {
      traffic?.dispose();
      vi.unstubAllGlobals();
      await h.close();
    }
  },
);

test("lost publication receipt stays unknown; reconnect never automatically republishes", async () => {
  const h = await harness();
  let traffic;
  try {
    browserFetch(h.base);
    const transport = await connectBrokerTransport(h.base);
    traffic = transport.subscribe(callbacks);
    await until(() => h.requests.length >= 1);
    const event = await outgoing(transport);
    const result = transport.writer
      .publish(event, new AbortController().signal)
      .catch((e) => e);
    await until(() => h.publications.length === 1);
    h.sockets[0].close();
    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PublishRejected);
    await until(
      () =>
        h.sockets.length === 2 &&
        h.requests.some((r) => r.socket === h.sockets[1]),
    );
    expect(h.publications).toHaveLength(1);
    expect(h.upstream.some((url) => url.endsWith("/events"))).toBe(false);
  } finally {
    traffic?.dispose();
    vi.unstubAllGlobals();
    await h.close();
  }
});

test("a reconnect's continuous channel replays cross the real HTTP boundary", async () => {
  const h = await harness(0, undefined, { holdAuth: true });
  let traffic;
  const clock = vi.spyOn(Date, "now");
  try {
    const now = Date.now();
    clock.mockReturnValue(now - 20 * 60_000);
    browserFetch(h.base);
    const transport = await connectBrokerTransport(h.base);
    const established = vi.fn();
    traffic = transport.subscribe({ ...callbacks, established });
    traffic.update(["a", "b", "c"], ["a", "b"]);
    await until(() => h.frames.some((frame) => frame.kind === "AUTH"));
    // Start the session before the floor, then authenticate at the current
    // time so the connection cursor has the full resume lag behind it.
    clock.mockRestore();
    const auth = h.frames.find((frame) => frame.kind === "AUTH");
    await h.sockets[0].receive(["OK", auth.id.id, true]);
    const channels = () =>
      established.mock.calls.filter(([ids]) => ids !== undefined);
    await until(() => channels().length === 2);
    // A first connection has no cursor: no channel reports continuity.
    expect(channels()).toEqual(expect.arrayContaining([[["a", "b"]], ["c"]]));
    established.mockClear();
    h.sockets[0].close();
    await until(
      () => h.frames.filter((frame) => frame.kind === "AUTH").length === 2,
    );
    const nextAuth = h.frames.filter((frame) => frame.kind === "AUTH")[1];
    await h.sockets[1].receive(["OK", nextAuth.id.id, true]);
    await until(() => channels().length === 2);
    // The quiet replays resumed from their cursors, below the limit.
    expect(channels()).toEqual(
      expect.arrayContaining([
        [["a", "b"], undefined, ["a", "b"]],
        ["c", undefined, ["c"]],
      ]),
    );
  } finally {
    clock.mockRestore();
    traffic?.dispose();
    vi.unstubAllGlobals();
    await h.close();
  }
});

test("read-only profile lookup needs no live owner; a not-yet-ready session fails publication without HTTP fallback", async () => {
  const h = await harness();
  try {
    browserFetch(h.base);
    const transport = await connectBrokerTransport(h.base);
    expect(
      await transport.query([
        { kinds: [0], authors: [getPublicKey(h.key)], limit: 1 },
      ]),
    ).toEqual([]);
    expect(h.sockets).toHaveLength(0);
    const event = await outgoing(transport);
    await expect(
      transport.writer.publish(event, new AbortController().signal),
    ).rejects.toBeInstanceOf(PublishRejected);
    const traffic = transport.subscribe(callbacks);
    const publication = transport.writer.publish(
      event,
      new AbortController().signal,
    );
    traffic.dispose();
    await expect(publication).rejects.toBeInstanceOf(PublishRejected);
    expect(h.publications).toHaveLength(0);
    expect(h.upstream.some((url) => url.endsWith("/events"))).toBe(false);
  } finally {
    vi.unstubAllGlobals();
    await h.close();
  }
});

test("socket publication retains broker signature, purpose, origin and relay-scoping admission", async () => {
  const h = await harness();
  let traffic;
  try {
    browserFetch(h.base);
    const transport = await connectBrokerTransport(h.base);
    traffic = transport.subscribe(callbacks);
    await until(() => !!traffic.identity());
    const event = await outgoing(transport);
    const post = (path, body, overrides = {}) =>
      fetch(`${h.base}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Buzz-Live-ID": traffic.identity(),
          ...overrides,
        },
        body: JSON.stringify(body),
      });
    for (const [path, body, status] of [
      ["/api/relay/publish", { ...event, sig: "0".repeat(128) }, 400],
      ["/api/relay/publish", { ...event, pubkey: "f".repeat(64) }, 400],
      [
        "/api/relay/publish",
        finalizeEvent(
          { kind: 1, created_at: event.created_at, content: "", tags: [] },
          h.key,
        ),
        400,
      ],
      ["/api/relay/read-state-publish", event, 400],
      ["/api/relay/secondary/publish", event, 503],
    ]) {
      const response = await post(path, body);
      expect(response.status).toBe(status);
      await response.text();
    }
    expect(h.publications).toHaveLength(0);
    expect(h.upstream.some((url) => url.endsWith("/events"))).toBe(false);
    const wrongStream = await post("/api/relay/publish", event, {
      "X-Buzz-Live-ID": "f".repeat(32),
    });
    expect(await wrongStream.json()).toMatchObject({ sent: false });
  } finally {
    traffic?.dispose();
    vi.unstubAllGlobals();
    await h.close();
  }
});

test("workflow command receipts and purpose-bound encrypted read-state writes use the shared socket", async () => {
  const h = await harness();
  let traffic;
  try {
    browserFetch(h.base);
    const transport = await connectBrokerTransport(h.base);
    traffic = transport.subscribe(callbacks);
    await until(() => h.requests.length >= 1);
    const signal = new AbortController().signal;
    const command = await transport.writer.sign(
      {
        kind: 46020,
        created_at: Math.floor(Date.now() / 1000),
        content: "",
        tags: [
          ["h", "00000000-0000-4000-8000-000000000001"],
          ["d", "00000000-0000-4000-8000-000000000002"],
        ],
      },
      signal,
    );
    const commandResult = transport.writer.publish(command, signal);
    await until(() => h.publications.length === 1);
    await h.sockets[0].receive(["OK", command.id, true, "workflow-result"]);
    expect(await commandResult).toBe("workflow-result");
    const blob = { v: 1, client_id: "fixture", contexts: { room: 12 } };
    const state = await transport.readState.sign(
      { slot: "b".repeat(32), createdAt: Math.floor(Date.now() / 1000), blob },
      signal,
    );
    expect(state.content).not.toContain("room");
    const stateResult = transport.readState.publish(state, signal);
    await until(() => h.publications.length === 2);
    expect(h.publications[1].event).toMatchObject({
      id: state.id,
      kind: 30078,
    });
    await h.sockets[0].receive(["OK", state.id, true, ""]);
    await stateResult;
    expect(await transport.readState.decode([state], signal)).toEqual([
      { eventId: state.id, blob },
    ]);
    expect(h.sockets).toHaveLength(1);
    expect(h.upstream.some((url) => url.endsWith("/events"))).toBe(false);
  } finally {
    traffic?.dispose();
    vi.unstubAllGlobals();
    await h.close();
  }
});

test("coalesced remove/re-add retires old upstream wire without interrupting publications", async () => {
  const h = await harness();
  let traffic, release;
  try {
    const fetcher = browserFetch(h.base);
    const denied = vi.fn(),
      received = vi.fn(),
      established = vi.fn();
    const transport = await connectBrokerTransport(h.base);
    traffic = transport.subscribe({
      ...callbacks,
      denied,
      established,
      receive: received,
    });
    traffic.update(["a"]);
    await until(() => h.requests.length === 3);
    const old = h.requests.find((r) => r.filter["#h"]?.[0] === "a");
    const event = await outgoing(transport);
    const publication = transport.writer
      .publish(event, new AbortController().signal)
      .catch((error) => error);
    await until(() => h.publications.length === 1);
    let held = false,
      completed = 0;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    vi.stubGlobal("fetch", async (url, init) => {
      const response = await fetcher(url, init);
      if (String(url).endsWith("/stream-interests")) {
        if (!held) {
          held = true;
          await gate;
        }
        completed++;
      }
      return response;
    });
    traffic.update(["a", "b"]);
    await until(() => held);
    // Both changes happen while the preceding control response is held.
    traffic.update(["b"]);
    traffic.update(["a", "b"]);
    release();
    await until(() => completed === 2);
    // Completed HTTP control is the barrier: the old wire must already be retired.
    expect(
      h.frames.some((frame) => frame.kind === "CLOSE" && frame.id === old.id),
    ).toBe(true);
    await until(
      () => h.requests.filter((r) => r.filter["#h"]?.[0] === "a").length === 2,
    );
    const current = h.requests
      .filter((r) => r.filter["#h"]?.[0] === "a")
      .at(-1);
    expect(current.id).not.toBe(old.id);
    await until(
      () => established.mock.calls.filter(([id]) => id === "a").length === 2,
    );
    const establishedBefore = established.mock.calls.length;
    await h.sockets[0].receive(["EOSE", old.id]);
    await h.sockets[0].receive([
      "CLOSED",
      old.id,
      "restricted: not a channel member",
    ]);
    await h.sockets[0].receive(["EVENT", old.id, event]);
    await h.sockets[0].receive(["EVENT", current.id, event]);
    await until(() =>
      received.mock.calls.some(([events]) =>
        events.some((e) => e.id === event.id),
      ),
    );
    expect(denied).not.toHaveBeenCalled();
    expect(established).toHaveBeenCalledTimes(establishedBefore);
    expect(h.requests.filter((r) => r.filter["#h"]?.[0] === "b")).toHaveLength(
      1,
    );
    expect(received).toHaveBeenCalledTimes(1);
    expect(h.sockets).toHaveLength(1);
    expect(h.requests.filter((r) => !r.filter["#h"])).toHaveLength(2);
    await h.sockets[0].receive(["OK", event.id, true, "still-pending"]);
    expect(await publication).toBe("still-pending");
  } finally {
    release?.();
    traffic?.dispose();
    vi.unstubAllGlobals();
    await h.close();
  }
});

test.each([
  [30620, "conflict: workflow changed since it was loaded", "failed"],
  [
    30620,
    "forbidden: workflow belongs to a different owner or channel",
    "failed",
  ],
  [46020, "forbidden: not authorized to trigger this workflow", "failed"],
  [46020, "forbidden: workflow is disabled or inactive", "failed"],
  [46020, "error: internal server error", "unknown"],
])(
  "workflow refusal reaches broker/outbox as %s / %s / %s",
  async (kind, reason, delivery) => {
    const h = await harness();
    let traffic, owner;
    const saved = [];
    try {
      browserFetch(h.base);
      const transport = await connectBrokerTransport(h.base);
      traffic = transport.subscribe(callbacks);
      await until(() => h.requests.length >= 1);
      owner = createOutbox(
        transport.viewer,
        transport.writer,
        {
          load: () => [],
          save: (records) => saved.push(JSON.stringify(records)),
        },
        { needsReceipt: () => true },
      );
      const id = owner.outbox.send({
        kind,
        content:
          kind === 30620
            ? "name: Fixture\nenabled: false\ntrigger:\n  on: message\nsteps:\n  - id: pause\n    action: delay\n    seconds: 1\n"
            : "",
        tags: [
          ["h", "00000000-0000-4000-8000-000000000001"],
          ["d", "00000000-0000-4000-8000-000000000002"],
        ],
      });
      await until(() => h.publications.length === 1);
      await h.sockets[0].receive(["OK", id, false, reason]);
      await until(() => owner.outbox.snapshot()[0]?.delivery === delivery);
      expect(owner.outbox.snapshot()[0].error).toContain(
        delivery === "failed"
          ? "Workflow command rejected"
          : "could not be confirmed",
      );
      expect(saved.join("\n")).not.toContain(reason);
      owner.outbox.retry(id);
      expect(h.publications).toHaveLength(1);
      expect(h.upstream.some((url) => url.endsWith("/events"))).toBe(false);
    } finally {
      owner?.dispose();
      traffic?.dispose();
      vi.unstubAllGlobals();
      await h.close();
    }
  },
);

test.each([
  [
    45010,
    "conflict: artifact head changed",
    "failed",
    "conflict: the relay state",
  ],
  [45010, "error: internal server error", "unknown", "could not be confirmed"],
  [
    40100,
    "conflict: canvas head changed",
    "failed",
    "conflict: the relay state",
  ],
  [40100, "error: internal server error", "unknown", "could not be confirmed"],
])(
  "kind %s refusal %s reaches broker/outbox as %s / %s",
  async (kind, reason, delivery, error) => {
    const h = await harness();
    let traffic, owner;
    try {
      browserFetch(h.base);
      const transport = await connectBrokerTransport(h.base);
      traffic = transport.subscribe(callbacks);
      await until(() => h.requests.length >= 1);
      owner = createOutbox(transport.viewer, transport.writer, {
        load: () => [],
        save() {},
      });
      const id = owner.outbox.send({
        kind,
        content: "",
        tags: [
          ["h", "00000000-0000-4000-8000-000000000001"],
          ["expected-revision", "none"],
        ],
      });
      await until(() => h.publications.length === 1);
      await h.sockets[0].receive(["OK", id, false, reason]);
      await until(() => owner.outbox.snapshot()[0]?.delivery === delivery);
      expect(owner.outbox.snapshot()[0].error).toContain(error);
    } finally {
      owner?.dispose();
      traffic?.dispose();
      vi.unstubAllGlobals();
      await h.close();
    }
  },
);

test("joined batches survive the real HTTP boundary and retirement only rebuilds the affected scope", async () => {
  const h = await harness();
  let traffic;
  try {
    const fetcher = browserFetch(h.base);
    const transport = await connectBrokerTransport(h.base);
    const established = vi.fn(),
      receive = vi.fn();
    traffic = transport.subscribe({ ...callbacks, established, receive });
    const joined = Array.from(
      { length: 256 },
      (_, i) => `c${String(i).padStart(3, "0")}`,
    );
    traffic.update([...joined, "preview"], joined);
    await until(
      () => established.mock.calls.length === 4 && h.requests.length === 5,
    );
    expect(h.requests).toHaveLength(5);
    const batches = h.requests.filter(
      (r) => r.filter["#h"] && r.filter.limit === 0,
    );
    // Every joined channel replays through one combined filter; the preview
    // channel has its own route.
    const replays = h.requests.filter(
      (r) =>
        r.filter["#h"] &&
        r.filter.limit === 500 &&
        !r.filter["#h"].includes("preview"),
    );
    expect(replays.map((r) => r.filters.length)).toEqual([1]);
    expect(replays[0].filter["#h"]).toEqual(joined);
    expect(
      established.mock.calls
        .filter(([ids]) => Array.isArray(ids))
        .map(([ids]) => ids.length),
    ).toEqual([256]);
    // Globals carry their continuity across the host boundary. A first
    // connection has no cursor, so neither proves it missed nothing.
    expect(
      established.mock.calls
        .filter(([ids]) => ids === undefined)
        .map(([, global]) => global),
    ).toEqual(
      expect.arrayContaining([
        { route: "profiles", continuous: false },
        { route: "membership", continuous: false },
      ]),
    );
    const old = batches[0];
    // Host rejects mismatched joined scope before changing any live routes.
    const malformed = await fetcher(`${h.base}/api/relay/stream-interests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streamId: traffic.identity(),
        channels: ["preview"],
        joined: ["not-present"],
        interestRevision: 2,
      }),
    });
    expect(malformed.status).toBe(400);
    await malformed.text();
    expect(h.requests).toHaveLength(5);
    const retained = joined.slice(1);
    traffic.update([...retained, "preview"], retained);
    await until(() => established.mock.calls.length === 5);
    expect(established).toHaveBeenCalledTimes(5);
    expect(h.requests).toHaveLength(6);
    expect(
      h.frames.filter((f) => f.kind === "CLOSE" && f.id === old.id),
    ).toHaveLength(1);
    expect(h.requests.at(-1).filters.flatMap((f) => f["#h"])).toEqual(
      joined.slice(1),
    );
    const event = finalizeEvent(
      {
        kind: 5,
        content: "",
        tags: [["e", "f".repeat(64)]],
        created_at: 1700000000,
      },
      h.key,
    );
    await h.sockets[0].receive(["EVENT", old.id, event]);
    await h.sockets[0].receive(["EVENT", h.requests.at(-1).id, event]);
    await until(() => receive.mock.calls.length === 1);
    expect(receive).toHaveBeenCalledExactlyOnceWith([event], {
      phase: "live",
      sourceChannels: joined.slice(1),
    });
    expect(h.sockets).toHaveLength(1);
  } finally {
    traffic?.dispose();
    vi.unstubAllGlobals();
    await h.close();
  }
});

test("startup response ABA retires an old wire before applying the latest interests", async () => {
  const h = await harness();
  let traffic, release;
  try {
    const fetcher = browserFetch(h.base);
    const denied = vi.fn(),
      established = vi.fn(),
      receive = vi.fn();
    const transport = await connectBrokerTransport(h.base);
    traffic = transport.subscribe({
      ...callbacks,
      denied,
      established,
      receive,
    });
    traffic.update(["a", "b"]);
    await until(() => h.requests.length === 4);
    await until(() => established.mock.calls.some(([id]) => id === "a"));
    let held = false,
      controlled = false;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    vi.stubGlobal("fetch", async (url, init) => {
      const response = await fetcher(url, init);
      if (String(url).endsWith("/stream")) {
        held = true;
        await gate;
      }
      if (String(url).endsWith("/stream-interests")) controlled = true;
      return response;
    });
    // No socket restart helper: force the production browser stream recovery.
    const retryResponse = await fetcher(
      `${h.base}/api/relay/stream-interests`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          streamId: traffic.identity(),
          channels: ["a", "b"],
          interestRevision: 0,
        }),
      },
    );
    expect(retryResponse.status).toBe(409);
    // Request a control that the broker rejects, so the browser reconnects with current intent.
    let rejected = false;
    const priorFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (url, init) => {
      if (!rejected && String(url).endsWith("/stream-interests")) {
        rejected = true;
        return Promise.resolve(new Response(null, { status: 503 }));
      }
      return priorFetch(url, init);
    });
    traffic.update(["a", "b", "c"]);
    await until(
      () =>
        held &&
        h.sockets.length === 2 &&
        h.requests.filter((r) => r.socket === h.sockets[1]).length === 5,
    );
    const old = h.requests.find(
      (r) => r.socket === h.sockets[1] && r.filter["#h"]?.[0] === "a",
    );
    traffic.update(["b", "c"]);
    traffic.update(["a", "b", "c"]);
    release();
    await until(() => controlled);
    expect(
      h.frames.some(
        (f) =>
          f.kind === "CLOSE" && f.id === old.id && f.socket === h.sockets[1],
      ),
    ).toBe(true);
    await until(
      () =>
        h.requests.filter(
          (r) => r.socket === h.sockets[1] && r.filter["#h"]?.[0] === "a",
        ).length === 2,
    );
    const current = h.requests
      .filter((r) => r.socket === h.sockets[1] && r.filter["#h"]?.[0] === "a")
      .at(-1);
    await h.sockets[1].receive(["EOSE", old.id]);
    await h.sockets[1].receive([
      "CLOSED",
      old.id,
      "restricted: not a channel member",
    ]);
    const event = await outgoing(transport);
    await h.sockets[1].receive(["EVENT", old.id, event]);
    await h.sockets[1].receive(["EVENT", current.id, event]);
    await until(() => receive.mock.calls.length === 1);
    expect(established.mock.calls.filter(([id]) => id === "a")).toHaveLength(2);
    expect(denied).not.toHaveBeenCalled();
    expect(h.sockets).toHaveLength(2);
    expect(
      h.requests.filter(
        (r) => r.socket === h.sockets[1] && r.filter["#h"]?.[0] === "b",
      ),
    ).toHaveLength(1);
  } finally {
    release?.();
    traffic?.dispose();
    vi.unstubAllGlobals();
    await h.close();
  }
});

test("a re-added pending route replaces its queued removal before drain", async () => {
  let response;
  let backpressured = false;
  const deltas = [];
  const h = await harness(0, undefined, {
    holdSetup: true,
    statusDeltas: true,
    response(res) {
      response = res;
      Object.defineProperty(res, "writableNeedDrain", {
        get: () => backpressured,
      });
      const write = res.write.bind(res);
      res.write = (chunk, ...args) => {
        const text = String(chunk);
        if (text.startsWith("event: state-delta\n"))
          deltas.push(JSON.parse(text.split("data: ")[1]));
        return write(chunk, ...args);
      };
    },
  });
  try {
    const opened = await h.post(["a"]);
    await until(() => h.requests.some((r) => r.filter["#h"]?.includes("a")));
    const control = async (channels, interestRevision) => {
      const result = await fetch(`${h.base}/api/relay/stream-interests`, {
        method: "POST",
        headers: { Origin: h.base, "Content-Type": "application/json" },
        body: JSON.stringify({
          streamId: opened.response.headers.get("x-buzz-live-id"),
          channels,
          interestRevision,
        }),
      });
      expect(result.status).toBe(200);
      await result.text();
    };
    backpressured = true;
    await control([], 1);
    await control(["a"], 2);
    const before = deltas.length;
    backpressured = false;
    response.emit("drain");
    const drained = deltas.slice(before);
    expect(drained.flatMap((d) => d.removed)).not.toContain("channel:a");
    expect(drained.flatMap((d) => d.routes)).toContainEqual(
      expect.objectContaining({ id: "channel:a", status: "pending" }),
    );
    expect(drained.every((d) => d.interestRevision === 2)).toBe(true);
  } finally {
    await h.close();
  }
});

test.each(["disconnect", "close"])(
  "backpressured route state drains latest revision and fences observer transitions and %s",
  async (ending) => {
    let response;
    const states = [];
    const established = [];
    const h = await harness(0, undefined, {
      holdSetup: true,
      response(res) {
        response = res;
        Object.defineProperty(res, "writableNeedDrain", { get: () => true });
        const write = res.write.bind(res);
        res.write = (chunk, ...args) => {
          const text = String(chunk);
          if (text.startsWith("event: state\n"))
            states.push(JSON.parse(text.split("data: ")[1]));
          if (text.startsWith("event: established\n"))
            established.push(JSON.parse(text.split("data: ")[1]));
          return write(chunk, ...args);
        };
      },
    });
    try {
      const opened = await h.post(["a", "b"]);
      await until(() => h.requests.length === 4);
      const before = states.length;
      const socket = h.sockets[0];
      await socket.receive(["EOSE", h.requests[0].id]);
      await socket.receive(["EOSE", h.requests[1].id]);
      expect(states).toHaveLength(before);
      expect(established).toHaveLength(2); // Events are not coalesced with snapshots.
      response.emit("drain");
      expect(states).toHaveLength(before + 1);
      expect(
        states.at(-1).routes.filter((r) => r.status === "live"),
      ).toHaveLength(2);
      const control = (path, body) =>
        fetch(`${h.base}/api/relay/${path}`, {
          method: "POST",
          headers: { Origin: h.base, "Content-Type": "application/json" },
          body: JSON.stringify({
            streamId: opened.response.headers.get("x-buzz-live-id"),
            ...body,
          }),
        });
      await socket.receive(["EOSE", h.requests[2].id]);
      expect(states).toHaveLength(before + 1); // Pending channel progress.
      await (await control("stream-observer", { observer: 1 })).text();
      expect(states.at(-1).routes.find((r) => r.id === "observer").status).toBe(
        "pending",
      );
      const observer = h.requests.find((r) => r.filter.kinds.includes(24200));
      await socket.receive(["EOSE", observer.id]);
      expect(states.at(-1).routes.find((r) => r.id === "observer").status).toBe(
        "live",
      );
      await (await control("stream-observer", { observer: null })).text();
      expect(states.at(-1).routes.some((r) => r.id === "observer")).toBe(false);
      await (
        await control("stream-interests", {
          channels: ["a", "b"],
          removed: [],
          interestRevision: 3,
        })
      ).text();
      await socket.receive(["EOSE", h.requests[3].id]);
      response.emit("drain");
      expect(states.at(-1).interestRevision).toBe(3);
      await (await control("stream-priority", { channels: ["a"] })).text();
      if (ending === "disconnect") {
        socket.close();
        expect(states.at(-1).status).toBe("retrying");
        const afterDisconnect = states.length;
        response.emit("drain");
        expect(states).toHaveLength(afterDisconnect); // No stale connected snapshot.
      }
      // In the close arm the channel snapshot is still pending when the response closes.
      opened.abort();
      await until(() => response.destroyed);
      const afterClose = states.length;
      response.emit("drain");
      expect(states).toHaveLength(afterClose);
    } finally {
      await h.close();
    }
  },
);

test.each([
  [
    "invalid: policy:nobody — this agent has disabled external channel additions",
    false,
    "invalid: policy:nobody — this agent has disabled external channel additions",
  ],
  ["error: internal server error", true, "error: internal server error"],
  [
    "rate-limited: quota exceeded; retry in 17s",
    false,
    "rate-limited: quota exceeded; retry in 17s",
  ],
  [
    "rate-limited: shared admission unavailable",
    false,
    "rate-limited: shared admission unavailable",
  ],
  [
    "rate-limited: quota exceeded; retry in 17s\nprivate",
    false,
    "rate-limited: unrecognized reason",
  ],
  [
    "invalid: private-agent-policy\nforged-line",
    false,
    "invalid: unrecognized reason",
  ],
])(
  "publication diagnostics correlate a membership refusal and expose only safe quota text: %s",
  async (reason, sent, summary) => {
    const logger = getLogger("relay-broker");
    const reporters = [...logger.options.reporters];
    const previousLevel = logLevel();
    const lines = [];
    logger.setReporters([{ log: (entry) => lines.push(entry.args.join(" ")) }]);
    setLogLevel("info");
    const h = await harness();
    let traffic;
    try {
      browserFetch(h.base);
      const transport = await connectBrokerTransport(h.base);
      traffic = transport.subscribe(callbacks);
      await until(() => h.requests.length >= 1 && !!traffic.identity());
      const event = await transport.writer.sign(
        {
          kind: 9000,
          content: "",
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["h", "00000000-0000-4000-8000-000000000001"],
            ["p", "a".repeat(64)],
          ],
        },
        new AbortController().signal,
      );
      const result = fetch(`${h.base}/api/relay/publish`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Buzz-Live-ID": traffic.identity(),
        },
        body: JSON.stringify(event),
      });
      await until(() => h.publications.length === 1);
      // An unmatched negative OK must neither finish nor contaminate this operation.
      await h.sockets[0].receive([
        "OK",
        "f".repeat(64),
        false,
        "invalid: private-unmatched",
      ]);
      await h.sockets[0].receive(["OK", event.id, false, reason]);
      const response = await result;
      // A proven validation refusal answers this client as the relay's HTTP
      // API does, with its own text; the log keeps only the safe summary.
      const validation = !sent && reason.startsWith("invalid:");
      expect(response.status).toBe(validation ? 400 : 503);
      expect(await response.json()).toEqual(
        validation
          ? { error: reason }
          : {
              error: summary.startsWith("rate-limited:")
                ? summary
                : "Socket publication could not be confirmed",
              ...(!sent ? { sent: false } : {}),
            },
      );
      expect(lines).toContain(
        `publication id=${event.id} kind=9000 stage=socket sent=${sent} reason=Relay publication not confirmed refusal=${summary}`,
      );
      const output = lines.join("\n");
      for (const secret of [
        event.sig,
        "a".repeat(64),
        traffic.identity(),
        "private",
        "forged-line",
      ])
        expect(output).not.toContain(secret);
      expect(h.publications).toHaveLength(1);
    } finally {
      traffic?.dispose();
      vi.unstubAllGlobals();
      await h.close();
      logger.setReporters(reporters);
      setLogLevel(previousLevel);
    }
  },
);

test("publication diagnostics distinguish missing and mismatched live owner without dispatch", async () => {
  const logger = getLogger("relay-broker");
  const reporters = [...logger.options.reporters];
  const previousLevel = logLevel();
  const lines = [];
  logger.setReporters([{ log: (entry) => lines.push(entry.args.join(" ")) }]);
  setLogLevel("info");
  const h = await harness();
  let traffic;
  try {
    browserFetch(h.base);
    const transport = await connectBrokerTransport(h.base);
    traffic = transport.subscribe(callbacks);
    await until(() => !!traffic.identity());
    const event = await outgoing(transport, "private-event-body");
    for (const [path, liveId, stage] of [
      ["/api/relay/publish", "missing-owner", "owner-missing"],
      ["/api/relay/secondary/publish", traffic.identity(), "owner-mismatch"],
    ]) {
      const response = await fetch(`${h.base}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Buzz-Live-ID": liveId,
        },
        body: JSON.stringify(event),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "Publication socket unavailable",
        sent: false,
      });
      expect(lines).toContain(
        `publication id=${event.id} kind=9 stage=${stage} sent=false`,
      );
    }
    expect(h.publications).toHaveLength(0);
    for (const secret of [
      event.content,
      event.sig,
      traffic.identity(),
      "missing-owner",
    ])
      expect(lines.join("\n")).not.toContain(secret);
  } finally {
    traffic?.dispose();
    vi.unstubAllGlobals();
    await h.close();
    logger.setReporters(reporters);
    setLogLevel(previousLevel);
  }
});

test("publication diagnostics separate local unsent duplicates from lost socket receipts", async () => {
  const logger = getLogger("relay-broker");
  const reporters = [...logger.options.reporters];
  const previousLevel = logLevel();
  const lines = [];
  logger.setReporters([{ log: (entry) => lines.push(entry.args.join(" ")) }]);
  setLogLevel("info");
  const h = await harness();
  let traffic;
  try {
    browserFetch(h.base);
    const transport = await connectBrokerTransport(h.base);
    traffic = transport.subscribe(callbacks);
    await until(() => h.requests.length >= 1 && !!traffic.identity());
    const event = await outgoing(transport, "private-event-body");
    const publish = () =>
      fetch(`${h.base}/api/relay/publish`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Buzz-Live-ID": traffic.identity(),
        },
        body: JSON.stringify(event),
      });
    const first = publish();
    await until(() => h.publications.length === 1);
    const duplicate = await publish();
    expect(duplicate.status).toBe(503);
    expect(await duplicate.json()).toEqual({
      error: "Socket publication could not be confirmed",
      sent: false,
    });
    expect(lines).toContain(
      `publication id=${event.id} kind=9 stage=socket sent=false reason=Publication already in flight`,
    );
    h.sockets[0].close();
    const interrupted = await first;
    expect(interrupted.status).toBe(503);
    expect(await interrupted.json()).toEqual({
      error: "Socket publication could not be confirmed",
    });
    expect(lines).toContain(
      `publication id=${event.id} kind=9 stage=socket sent=true reason=Socket connection interrupted`,
    );
    const output = lines.join("\n");
    expect(output).not.toContain("refusal=");
    for (const secret of [event.content, event.sig, traffic.identity()])
      expect(output).not.toContain(secret);
    expect(h.publications).toHaveLength(1);
  } finally {
    traffic?.dispose();
    vi.unstubAllGlobals();
    await h.close();
    logger.setReporters(reporters);
    setLogLevel(previousLevel);
  }
});

test("live streams request no agent telemetry without plugin demand", async () => {
  const h = await harness();
  // The transport uses browser Origin headers in production; Node's fetch needs them supplied.
  const original = globalThis.fetch;
  vi.stubGlobal("fetch", (input, init) =>
    original(input, {
      ...init,
      headers: {
        ...init?.headers,
        ...(init?.method === "POST" ? { Origin: h.base } : {}),
      },
    }),
  );
  let traffic;
  try {
    const transport = await connectBrokerTransport(h.base);
    let snapshot;
    traffic = transport.subscribe({
      receive() {},
      observer() {},
      state(value) {
        snapshot = value;
      },
      established() {},
    });
    // Routes are registered before dispatch, so a live global set is complete.
    await until(
      () =>
        snapshot?.status === "connected" &&
        ["profiles", "membership"].every((id) =>
          snapshot.routes.some((r) => r.id === id && r.status === "live"),
        ),
    );
    expect(snapshot.routes.map((r) => r.id)).not.toContain("observer");
    expect(
      h.requests.some((r) =>
        r.filter.kinds.some((kind) => [24200, 44200].includes(kind)),
      ),
    ).toBe(false);
  } finally {
    traffic?.dispose();
    vi.unstubAllGlobals();
    await h.close();
  }
});

test("real broker keeps 100,000 joined channels and delivers outside the first batch", async () => {
  const h = await harness();
  const nativeFetch = globalThis.fetch;
  let traffic;
  try {
    vi.stubGlobal("fetch", (input, init) =>
      nativeFetch(input, {
        ...init,
        headers: {
          ...init?.headers,
          ...(init?.method === "POST" ? { Origin: h.base } : {}),
        },
      }),
    );
    const transport = await connectBrokerTransport(h.base);
    let snapshot;
    const received = [];
    const established = new Set();
    traffic = transport.subscribe({
      receive(events) {
        received.push(...events);
      },
      established(ids) {
        for (const id of typeof ids === "string" ? [ids] : (ids ?? []))
          established.add(id);
      },
      denied() {},
      state(value) {
        snapshot = value;
      },
    });
    const ids = Array.from(
      { length: 100_000 },
      (_, i) => `${String(i).padStart(6, "0")}-${"c".repeat(121)}`,
    );
    traffic.update(ids, ids);
    await vi.waitFor(
      () => {
        expect(
          established.size,
          JSON.stringify({
            status: snapshot?.status,
            error: snapshot?.error,
            requests: h.requests.length,
            sockets: h.sockets.length,
          }),
        ).toBe(100_000);
        expect(snapshot?.status).toBe("connected");
        expect(
          snapshot.routes.filter(
            (route) => route.channelId && route.status === "live",
          ),
        ).toHaveLength(100_000);
      },
      { timeout: 30_000 },
    );
    expect(h.sockets).toHaveLength(1);
    expect(
      h.requests.filter((r) => r.filters.some((f) => f["#h"] && f.limit === 0)),
    ).toHaveLength(49);
    const last = ids.at(-1);
    const route = h.requests.find((request) =>
      request.filters.some((filter) => filter["#h"]?.includes(last)),
    );
    expect(route).toBeDefined();
    const event = finalizeEvent(
      {
        kind: 9,
        content: "last task input",
        created_at: Math.floor(Date.now() / 1000),
        tags: [["h", last]],
      },
      h.key,
    );
    await route.socket.receive(["EVENT", route.id, event]);
    await vi.waitFor(() =>
      expect(received.map((item) => item.id)).toContain(event.id),
    );
    const next = [...ids.slice(0, -1), "new-task"];
    traffic.update(next, next);
    await vi.waitFor(
      () => {
        expect(established.has("new-task")).toBe(true);
        expect(snapshot.routes.some((route) => route.channelId === last)).toBe(
          false,
        );
      },
      { timeout: 30_000 },
    );
    const active = new Set();
    for (const { kind, id } of h.frames) {
      if (kind === "REQ") active.add(id);
      if (kind === "CLOSE") active.delete(id);
      expect(active.size).toBeLessThanOrEqual(1024);
    }
  } finally {
    traffic?.dispose();
    vi.unstubAllGlobals();
    await h.close();
  }
}, 60_000);

test("broker renewals retain establishment signals while channel status stays live", async () => {
  const h = await harness();
  let traffic;
  try {
    browserFetch(h.base);
    const transport = await connectBrokerTransport(h.base);
    const established = vi.fn();
    const states = [];
    traffic = transport.subscribe({
      ...callbacks,
      established,
      state: (state) => states.push(state),
    });
    const ids = Array.from({ length: 20 }, (_, i) => `c${i}`);
    traffic.update(ids, ids);
    await until(
      () =>
        established.mock.calls.filter(([value]) => Array.isArray(value))
          .length === 1,
    );
    const membership = h.requests.find((request) =>
      request.filters.some((filter) => filter.kinds.includes(44100)),
    );
    expect(membership).toBeDefined();
    const before = states.length;
    const notice = finalizeEvent(
      {
        kind: 44100,
        content: "",
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["p", getPublicKey(h.key)],
          ["h", ids[0]],
        ],
      },
      h.key,
    );
    await membership.socket.receive(["EVENT", membership.id, notice]);
    await until(
      () =>
        established.mock.calls.filter(([value]) => Array.isArray(value))
          .length === 2,
    );
    expect(
      states
        .slice(before)
        .every((state) =>
          state.routes
            .filter((route) => route.channelId)
            .every((route) => route.status === "live"),
        ),
    ).toBe(true);
    expect(established.mock.calls.at(-1)).toEqual([ids.sort()]);
    expect(h.sockets).toHaveLength(1);
  } finally {
    traffic?.dispose();
    vi.unstubAllGlobals();
    await h.close();
  }
});

test("a sync close that overtakes its open keeps the late open from taking a host slot", async () => {
  const h = await harness();
  const post = (path, body) =>
    fetch(`${h.base}${path}`, {
      method: "POST",
      headers: { Origin: h.base, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const filter = {
    artifact: "current",
    "#h": ["11111111-1111-4111-8111-111111111111"],
  };
  try {
    const stream = await h.post(["a"]);
    const streamId = stream.response.headers.get("x-buzz-live-id");
    await until(() => h.requests.length === 3);
    const close = await post("/api/relay/stream-artifact-sync-close", {
      streamId,
      id: "s1",
    });
    expect(close.status).toBe(200);
    await close.text();
    const late = await post("/api/relay/stream-artifact-sync", {
      streamId,
      id: "s1",
      filter,
    });
    expect(late.status).toBe(409);
    await late.text();
    // The remembered close is spent; nothing reached the relay for it.
    expect(h.requests).toHaveLength(3);
    const next = await post("/api/relay/stream-artifact-sync", {
      streamId,
      id: "s2",
      filter,
    });
    expect(next.status).toBe(200);
    await next.text();
    stream.abort();
  } finally {
    await h.close();
  }
});

test("a stream admits as many syncs as the session does", async () => {
  const h = await harness();
  const filter = {
    artifact: "current",
    "#h": ["11111111-1111-4111-8111-111111111111"],
  };
  const open = async (streamId, id) => {
    const response = await fetch(`${h.base}/api/relay/stream-artifact-sync`, {
      method: "POST",
      headers: { Origin: h.base, "Content-Type": "application/json" },
      body: JSON.stringify({ streamId, id, filter }),
    });
    await response.text();
    return response.status;
  };
  try {
    const stream = await h.post(["a"]);
    const streamId = stream.response.headers.get("x-buzz-live-id");
    await until(() => h.requests.length === 3);
    for (let i = 0; i < ARTIFACT_SYNC_MAX_VIEWS; i++)
      expect(await open(streamId, `s${i}`)).toBe(200);
    expect(await open(streamId, "over")).toBe(429);
    stream.abort();
  } finally {
    await h.close();
  }
});

test("a stream with too many unresolved sync closes ends instead of forgetting one", async () => {
  const h = await harness();
  const post = async (path, body) => {
    const response = await fetch(`${h.base}${path}`, {
      method: "POST",
      headers: { Origin: h.base, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await response.text();
    return response.status;
  };
  const filter = {
    artifact: "current",
    "#h": ["11111111-1111-4111-8111-111111111111"],
  };
  try {
    const stream = await h.post(["a"]);
    const streamId = stream.response.headers.get("x-buzz-live-id");
    await until(() => h.requests.length === 3);
    const closeSync = (id) =>
      post("/api/relay/stream-artifact-sync-close", { streamId, id });
    for (let i = 0; i < 64; i++) expect(await closeSync(`c${i}`)).toBe(200);
    // The oldest close is still remembered at capacity.
    expect(
      await post("/api/relay/stream-artifact-sync", {
        streamId,
        id: "c0",
        filter,
      }),
    ).toBe(409);
    expect(await closeSync("c0")).toBe(200);
    // One more unresolved close ends the stream rather than forget a record.
    expect(await closeSync("c64")).toBe(200);
    for (const id of ["c1", "c64", "fresh"])
      expect(
        await post("/api/relay/stream-artifact-sync", { streamId, id, filter }),
      ).toBe(404);
    expect(h.requests).toHaveLength(3);
    stream.abort();
  } finally {
    await h.close();
  }
});
