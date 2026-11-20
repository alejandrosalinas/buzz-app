import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";
import { SIDEBAR_HEAD_BYTES } from "./sidebar-preferences.mjs";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import { prepareSidebarSort } from "./sidebar-sort.mjs";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";
import { fixtureRelayUrl, fixtureAliases } from "../tests/relay-config.ts";

const disposals = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});
async function harness() {
  const key = generateSecretKey(),
    viewer = getPublicKey(key);
  let handler, queryFailure, publicationFailure;
  let conflict = false;
  let activityEvents = [];
  const heads = new Map(),
    calls = [];
  const server = createServer((req, res) => {
    req.headers.origin ??= `http://${req.headers.host}`;
    handler(req, res);
  });
  await relayBrokerPlugin({
    archiveFile: ":memory:",
    relayUrl: fixtureRelayUrl,
    communityAliases: fixtureAliases,
    identity: () => key,
    upstreamFetch: async (url, init) => {
      if (!init?.body) return Response.json({ self: viewer });
      const body = JSON.parse(init.body);
      const auth = JSON.parse(
        Buffer.from(init.headers.Authorization.slice(6), "base64").toString(),
      );
      expect(verifyEvent(auth)).toBe(true);
      expect(auth.pubkey).toBe(viewer);
      expect(auth.tags).toContainEqual(["u", String(url)]);
      expect(auth.tags).toContainEqual(["method", "POST"]);
      expect(auth.tags).toContainEqual([
        "payload",
        createHash("sha256").update(init.body).digest("hex"),
      ]);
      expect(init.redirect).toBe("error");
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/events")) {
        expect(verifyEvent(body)).toBe(true);
        if (publicationFailure) return publicationFailure;
        if (!conflict)
          heads.set(body.tags.find(([name]) => name === "d")[1], body);
        return Response.json({ accepted: true, event_id: body.id });
      }
      if (queryFailure) return queryFailure;
      if (body[0]["#h"]) return Response.json(activityEvents);
      // Model an empty stale replica: only strong reads observe the writer head.
      const head =
        body[0].consistency === "strong"
          ? heads.get(body[0]["#d"][0])
          : undefined;
      return Response.json(head ? [head] : []);
    },
  }).configureServer({
    httpServer: server,
    config: { logger: { info() {}, error() {} } },
    middlewares: {
      use(callback) {
        handler = callback;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  disposals.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const transport = await connectBrokerTransport(base);
  return {
    key,
    viewer,
    setActivity(events) {
      activityEvents = events;
    },
    transport,
    calls,
    heads,
    failQuery(value) {
      queryFailure = value;
    },
    failPublication(value) {
      publicationFailure = value;
    },
    conflict() {
      conflict = true;
    },
    post(value, origin, route = "sidebar-sort") {
      return fetch(`${base}/api/relay/${route}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(origin ? { Origin: origin } : {}),
        },
        body: JSON.stringify(value),
      });
    },
  };
}
it("real broker sorting preserves saved-section keys in transport confirmation and removes A–Z overrides", async () => {
  const h = await harness();
  const signal = new AbortController().signal;
  h.heads.set(
    "channel-sort",
    prepareSidebarSort(
      [],
      { group: "forums", mode: "recent", sectionIds: [] },
      h.key,
    ).event,
  );
  expect(
    await h.transport.writeSidebarSort(
      "section:work",
      "recent",
      ["work"],
      signal,
    ),
  ).toEqual({ forums: "recent", "section:work": "recent" });
  expect(h.calls.map((call) => new URL(call.url).pathname)).toEqual([
    "/query",
    "/query",
    "/events",
    "/query",
  ]);
  expect(h.calls[0].body).toEqual([
    {
      kinds: [30078],
      authors: [h.viewer],
      "#d": ["channel-workspace-sort"],
      limit: 1,
      consistency: "strong",
    },
  ]);
  expect(
    await h.transport.writeSidebarSort(
      "section:work",
      "alpha",
      ["work"],
      signal,
    ),
  ).toEqual({ forums: "recent" });
  const queries = h.calls.filter(({ url }) => url.endsWith("/query"));
  expect(queries).toHaveLength(5);
  expect(queries.map(({ body }) => body[0]["#d"][0])).toEqual([
    "channel-workspace-sort",
    "channel-sort",
    "channel-workspace-sort",
    "channel-workspace-sort",
    "channel-workspace-sort",
  ]);
});

it.each(["query", "oversized", "publication", "receipt", "conflict"])(
  "does not confirm sidebar sorting after %s failure",
  async (failure) => {
    const h = await harness();
    if (failure === "query")
      h.failQuery(new Response("failed", { status: 503 }));
    if (failure === "oversized")
      h.failQuery(new Response(`[${" ".repeat(SIDEBAR_HEAD_BYTES)}]`));
    if (failure === "publication")
      h.failPublication(new Response("failed", { status: 503 }));
    if (failure === "receipt")
      h.failPublication(Response.json({ accepted: false, event_id: "wrong" }));
    if (failure === "conflict") h.conflict();
    await expect(
      h.transport.writeSidebarSort(
        "channels",
        "recent",
        [],
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    if (["query", "oversized"].includes(failure))
      expect(h.calls.filter((call) => call.url.endsWith("/events"))).toEqual(
        [],
      );
  },
);

it("activity uses the purpose-bound 128-channel broker route without widening generic query admission", async () => {
  const h = await harness();
  const ids = Array.from({ length: 128 }, (_, i) => `room-${i}`);
  expect(
    await h.transport.channelActivity(ids, new AbortController().signal),
  ).toEqual([]);
  const filters = h.calls[0].body;
  expect(filters).toEqual(
    ids.map((id) => ({
      kinds: [9, 40002, 40008, 45001, 45003],
      "#h": [id],
      limit: 1,
    })),
  );
  const before = h.calls.length;
  for (const [route, body] of [
    ["query", filters],
    ["channel-activity", [...filters, filters[0]]],
    ["channel-activity", [{ ...filters[0], limit: 2 }]],
    ["channel-activity", [{ ...filters[0], kinds: [0] }]],
    ["channel-activity", [{ ...filters[0], authors: [h.viewer] }]],
  ])
    expect((await h.post(body, undefined, route)).status).toBe(400);
  expect(h.calls).toHaveLength(before);
  h.setActivity([{ kind: 9, content: "unsigned" }]);
  await expect(
    h.transport.channelActivity(["room-0"], new AbortController().signal),
  ).rejects.toThrow();
});

it("refuses invalid sort intent, excessive bodies and foreign origins before upstream access", async () => {
  const h = await harness();
  const intent = { group: "channels", mode: "recent", sectionIds: [] };
  expect((await h.post({ ...intent, mode: "random" })).status).toBe(400);
  expect((await h.post(intent, "https://foreign.invalid")).status).toBe(403);
  expect((await h.post({ ...intent, group: "x".repeat(66_000) })).status).toBe(
    413,
  );
  expect(h.calls).toEqual([]);
});

it("persists filters through the real broker transport, preserves sort, confirms reset and rejects unsafe requests", async () => {
  const h = await harness();
  const signal = new AbortController().signal;
  await h.transport.writeSidebarSort("channels", "recent", [], signal);
  const savedSort = h.heads.get("channel-sort");
  expect(
    await h.transport.writeSidebarFilter(
      "section:work",
      "unreads",
      ["work"],
      signal,
    ),
  ).toEqual({
    filters: { "section:work": "unreads" },
    activeWindowSeconds: {},
  });
  expect(
    await h.transport.writeSidebarFilter(
      "channels",
      "active",
      ["work"],
      signal,
      7 * 86400,
    ),
  ).toEqual({
    filters: { "section:work": "unreads", channels: "active" },
    activeWindowSeconds: { channels: 7 * 86400 },
  });
  expect(h.heads.get("channel-sort")).toEqual(savedSort);
  expect(
    await h.transport.writeSidebarFilter(
      "section:work",
      "all",
      ["work"],
      signal,
    ),
  ).toEqual({
    filters: { channels: "active" },
    activeWindowSeconds: { channels: 7 * 86400 },
  });
  for (const call of h.calls.filter(
    ({ body }) =>
      Array.isArray(body) && body[0]?.["#d"]?.[0] === "channel-filter",
  ))
    expect(call.body[0].consistency).toBe("strong");
  expect(
    (
      await h.post(
        { group: "channels", mode: "recent", sectionIds: [] },
        undefined,
        "sidebar-filter",
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await h.post(
        { group: "channels", mode: "all", sectionIds: [] },
        "https://evil.test",
        "sidebar-filter",
      )
    ).status,
  ).toBe(403);
  h.conflict();
  await expect(
    h.transport.writeSidebarFilter("channels", "unreads", [], signal),
  ).rejects.toThrow("Relay request failed (502)");
});
