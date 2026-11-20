import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import {
  generateSecretKey,
  getPublicKey,
  nip44,
  verifyEvent,
} from "nostr-tools";
import { prepareSidebarAssignment } from "./sidebar-preferences.mjs";
import { SIDEBAR_HEAD_BYTES } from "./sidebar-preferences.mjs";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import { prepareSidebarStar } from "./sidebar-toggle.mjs";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";
import { createRelaySession } from "../src/features/relay/session.ts";
import { fixtureRelayUrl, fixtureAliases } from "../tests/relay-config.ts";

const emptyWorkspace = { sections: [], assignments: {}, sectionOrder: [] };
const disposals = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});
async function harness(chunkBytes) {
  const key = generateSecretKey(),
    viewer = getPublicKey(key);
  let handler, queryFailure, publicationFailure;
  let conflict = false;
  let queryGate;
  const received = [];
  const requestWaiters = new Map();
  const heads = new Map(),
    calls = [];
  const server = createServer((req, res) => {
    req.headers.origin ??= `http://${req.headers.host}`;
    if (chunkBytes) {
      const incoming = req[Symbol.asyncIterator].bind(req);
      // Force broker-visible boundaries; TCP may coalesce separate client writes.
      req[Symbol.asyncIterator] = async function* () {
        for await (const part of { [Symbol.asyncIterator]: incoming }) {
          for (let offset = 0; offset < part.length; offset += chunkBytes)
            yield part.subarray(offset, offset + chunkBytes);
        }
      };
    }
    const incoming = req[Symbol.asyncIterator].bind(req);
    req[Symbol.asyncIterator] = async function* () {
      yield* { [Symbol.asyncIterator]: incoming };
      received.push(req.url);
      requestWaiters.get(req.url)?.();
    };
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
      if (queryGate) {
        const held = queryGate;
        queryGate = undefined;
        held.started.resolve();
        await held.release.promise;
      }
      if (queryFailure) return queryFailure;
      // Model an empty stale replica: only strong reads observe the writer head.
      return Response.json(
        body.flatMap((filter) => {
          const head =
            filter.consistency === "strong"
              ? heads.get(filter["#d"][0])
              : undefined;
          return head ? [head] : [];
        }),
      );
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
  const broker = await connectBrokerTransport(base);
  const transport = {
    ...broker,
    writeSidebarAssignment: (intent, signal, legacy = emptyWorkspace) =>
      broker.writeSidebarAssignment(intent, signal, legacy),
  };
  return {
    key,
    viewer,
    transport,
    calls,
    heads,
    holdNextQuery() {
      const held = {
        started: Promise.withResolvers(),
        release: Promise.withResolvers(),
      };
      queryGate = held;
      return held;
    },
    received(route) {
      const url = `/api/relay/${route}`;
      if (received.includes(url)) return Promise.resolve();
      return new Promise((resolve) => requestWaiters.set(url, resolve));
    },
    failQuery(value) {
      queryFailure = value;
    },
    failPublication(value) {
      publicationFailure = value;
    },
    conflict() {
      conflict = true;
    },
    post(value, origin, route = "sidebar-star") {
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
it.each([false, true])(
  "uncertain creation reconciles through the writer despite replica lag (recovery initially fails: %s)",
  async (fails) => {
    const h = await harness();
    const owner = createRelaySession({
      ...h.transport,
      writeSidebarAssignment: async (intent, signal, legacy) => {
        await h.transport.writeSidebarAssignment(intent, signal, legacy);
        if (fails)
          h.failQuery(
            Response.json({ error: "writer unavailable" }, { status: 503 }),
          );
        throw new Error("response lost");
      },
    });
    const preferences = owner.session.sidebarPreferences;
    const section = {
      id: "12345678-1234-1234-1234-123456789abc",
      name: "Launch",
    };
    try {
      await preferences.ensure();
      await expect(preferences.createSection(section)).rejects.toThrow(
        "response lost",
      );
      if (fails) {
        expect(preferences.sectionCreationWritable).toBe(false);
        await expect(
          preferences.createSection({
            ...section,
            id: "22345678-1234-1234-1234-123456789abc",
          }),
        ).rejects.toThrow("unavailable");
        h.failQuery(undefined);
        await preferences.refresh();
      }
      expect(preferences.snapshot().data.sections).toEqual([
        { ...section, order: 0 },
      ]);
      expect(preferences.sectionCreationWritable).toBe(true);
      const batches = h.calls.filter(
        ({ body }) => Array.isArray(body) && body.length === 5,
      );
      expect(batches).toHaveLength(fails ? 3 : 2);
      expect(
        batches[0].body.every((filter) => filter.consistency === undefined),
      ).toBe(true);
      for (const { body } of batches.slice(1))
        expect(body.every((filter) => filter.consistency === "strong")).toBe(
          true,
        );
      expect(h.calls.filter(({ url }) => url.endsWith("/events"))).toHaveLength(
        1,
      );
    } finally {
      owner.dispose();
    }
  },
);

it("real broker Star roundtrip signs scoped requests and confirms before projecting", async () => {
  const h = await harness(),
    signal = new AbortController().signal;
  h.heads.set(
    "channel-stars",
    prepareSidebarStar([], { channelId: "other", starred: true }, h.key).event,
  );
  expect(
    await h.transport.writeSidebarStar(
      { channelId: "alpha", starred: true },
      signal,
    ),
  ).toEqual(["other", "alpha"]);
  expect(h.calls.map((call) => new URL(call.url).pathname)).toEqual([
    "/query",
    "/events",
    "/query",
  ]);
  expect(h.calls[0].body).toEqual([
    {
      kinds: [30078],
      authors: [h.viewer],
      "#d": ["channel-stars"],
      limit: 1,
      consistency: "strong",
    },
  ]);
  expect(
    await h.transport.writeSidebarStar(
      { channelId: "alpha", starred: false },
      signal,
    ),
  ).toEqual(["other"]);
  expect(h.calls.filter((call) => call.url.endsWith("/events"))).toHaveLength(
    2,
  );
  await h.transport.writeSidebarStar(
    { channelId: "alpha", starred: false },
    signal,
  );
  expect(h.calls.filter((call) => call.url.endsWith("/events"))).toHaveLength(
    2,
  );
  const queries = h.calls.filter(({ url }) => url.endsWith("/query"));
  expect(queries).toHaveLength(5);
  for (const { body } of queries) expect(body).toEqual(h.calls[0].body);
});
it("refuses invalid intent and foreign origins without upstream requests", async () => {
  const h = await harness();
  expect((await h.post({ channelId: "alpha", starred: "true" })).status).toBe(
    400,
  );
  expect(
    (
      await h.post(
        { channelId: "alpha", starred: true },
        "https://foreign.invalid",
      )
    ).status,
  ).toBe(403);
  expect(
    (await h.post({ channelId: "x".repeat(2100), starred: true })).status,
  ).toBe(413);
  expect(h.calls).toEqual([]);
});
it.each(["query", "oversized", "publication", "receipt", "conflict"])(
  "does not claim a saved Star after %s failure",
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
      h.transport.writeSidebarStar(
        { channelId: "alpha", starred: true },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    if (["query", "oversized"].includes(failure))
      expect(h.calls.filter((call) => call.url.endsWith("/events"))).toEqual(
        [],
      );
  },
);

it("real broker creates and assigns a section through the signed, confirmed narrow command", async () => {
  const h = await harness();
  const intent = {
    channelId: "alpha",
    createSection: {
      id: "12345678-1234-1234-1234-123456789abc",
      name: "Launch",
    },
  };
  const result = await h.transport.writeSidebarAssignment(
    intent,
    new AbortController().signal,
  );
  expect(result).toEqual({
    sections: [{ ...intent.createSection, order: 0 }],
    assignments: { alpha: intent.createSection.id },
    sectionOrder: [],
  });
  expect(h.calls.map(({ url }) => new URL(url).pathname)).toEqual([
    "/query",
    "/events",
    "/query",
  ]);
  expect(
    await h.transport.writeSidebarAssignment(
      intent,
      new AbortController().signal,
    ),
  ).toEqual(result);
  expect(h.calls.filter(({ url }) => url.endsWith("/events"))).toHaveLength(1);
  const queries = h.calls.filter(({ url }) => url.endsWith("/query"));
  expect(queries).toHaveLength(3);
  for (const { body } of queries)
    expect(body).toEqual([
      {
        kinds: [30078],
        authors: [h.viewer],
        "#d": ["channel-workspaces"],
        limit: 1,
        consistency: "strong",
      },
    ]);
  const before = h.calls.length;
  expect(
    (
      await h.post(
        { ...intent, sectionId: "work" },
        undefined,
        "sidebar-assignment",
      )
    ).status,
  ).toBe(400);
  expect(h.calls).toHaveLength(before);
});

it("preserves split UTF-8 section names in the published record and response", async () => {
  const h = await harness(1);
  const intent = {
    channelId: "alpha",
    createSection: {
      id: "12345678-1234-1234-1234-123456789abc",
      name: "Launch 🚀 · Café · 日本語",
    },
  };
  const response = await h.post(
    { intent, legacy: emptyWorkspace },
    undefined,
    "sidebar-assignment",
  );
  expect(response.status).toBe(200);
  const expected = {
    sections: [{ ...intent.createSection, order: 0 }],
    assignments: { alpha: intent.createSection.id },
    sectionOrder: [],
  };
  expect.soft(await response.json()).toEqual(expected);
  expect(h.calls.map(({ url }) => new URL(url).pathname)).toEqual([
    "/query",
    "/events",
    "/query",
  ]);
  const key = nip44.v2.utils.getConversationKey(h.key, h.viewer);
  try {
    const published = h.heads.get("channel-workspaces");
    const projection = JSON.parse(nip44.v2.decrypt(published.content, key));
    expect(projection).toMatchObject({ version: 1, ...expected });
  } finally {
    key.fill(0);
  }
});

it("saves the order worked out from legacy records with the first edit", async () => {
  const h = await harness();
  const legacy = {
    sections: [
      { id: "notes", name: "Notes", order: 0 },
      { id: "release", name: "Release", order: 1 },
    ],
    assignments: {},
    sectionOrder: ["group:notes", "solo", "starred", "group:release"],
  };
  const response = await h.post(
    { intent: { channelId: "alpha", sectionId: "release" }, legacy },
    undefined,
    "sidebar-assignment",
  );
  expect(response.status).toBe(200);
  expect((await response.json()).sectionOrder).toEqual(legacy.sectionOrder);
  const key = nip44.v2.utils.getConversationKey(h.key, h.viewer);
  try {
    const published = h.heads.get("channel-workspaces");
    const projection = JSON.parse(nip44.v2.decrypt(published.content, key));
    expect(projection.sectionOrder).toEqual(legacy.sectionOrder);
  } finally {
    key.fill(0);
  }
});

it("signs and confirms a full migrated workspace roster through the broker", async () => {
  const h = await harness();
  const signal = new AbortController().signal;
  const sections = Array.from({ length: 200 }, (_, order) => ({
    id: `00000000-0000-4000-8000-${String(order).padStart(12, "0")}`,
    name: `Workspace ${order}`,
    order,
  }));
  const assignments = Object.fromEntries(
    Array.from({ length: 2000 }, (_, index) => [
      index.toString(16).padStart(64, "0"),
      sections[index % sections.length].id,
    ]),
  );
  const legacy = { sections, assignments };
  const [first, second] = Object.keys(assignments);
  const [source, target] = sections;
  const renamed = await h.transport.renameSidebarSection(
    { sectionId: source.id, name: "Renamed" },
    signal,
    legacy,
  );
  expect(renamed.sections[0].name).toBe("Renamed");
  expect(renamed.assignments).toEqual(assignments);
  const moved = await h.transport.writeSidebarAssignment(
    { channelId: first, sectionId: target.id },
    signal,
    legacy,
  );
  expect(moved.assignments[first]).toBe(target.id);
  const unfiled = await h.transport.writeSidebarAssignment(
    { channelId: second },
    signal,
    legacy,
  );
  expect(unfiled.assignments).not.toHaveProperty(second);
  const removed = await h.transport.removeSidebarSection(
    source.id,
    signal,
    legacy,
  );
  expect(removed.sections).toHaveLength(199);
  expect(Object.keys(removed.assignments)).toHaveLength(1990);
  expect(h.calls.filter(({ url }) => url.endsWith("/events"))).toHaveLength(4);
});

it.each(["sidebar-assignment", "sidebar-star"])(
  "%s rejects split UTF-8 bodies over the byte budget before any upstream request",
  async (route) => {
    const h = await harness(1);
    const intent = { channelId: "🚀".repeat(512) };
    expect(JSON.stringify(intent).length).toBeLessThan(2048);
    expect(Buffer.byteLength(JSON.stringify(intent))).toBeGreaterThan(2048);
    expect((await h.post(intent, undefined, route)).status).toBe(413);
    expect(h.calls).toEqual([]);
  },
);

it("real broker removes a section, unfiles its contents, and preserves other sections", async () => {
  const h = await harness();
  const signal = new AbortController().signal;
  const id = "12345678-1234-1234-1234-123456789abc";
  const other = "22345678-1234-1234-1234-123456789abc";
  await h.transport.writeSidebarAssignment(
    { channelId: "alpha", createSection: { id, name: "Work" } },
    signal,
  );
  await h.transport.writeSidebarAssignment(
    { channelId: "beta", createSection: { id: other, name: "Other" } },
    signal,
  );
  const result = await h.transport.removeSidebarSection(id, signal);
  expect(result).toEqual({
    sections: [{ id: other, name: "Other", order: 0 }],
    assignments: { beta: other },
    sectionOrder: [],
  });
  expect(await h.transport.removeSidebarSection(id, signal)).toEqual(result);
});
it.each(["query", "publication", "receipt", "conflict"])(
  "does not report section deletion after %s failure",
  async (failure) => {
    const h = await harness();
    const signal = new AbortController().signal;
    const id = "12345678-1234-1234-1234-123456789abc";
    await h.transport.writeSidebarAssignment(
      { channelId: "alpha", createSection: { id, name: "Work" } },
      signal,
    );
    if (failure === "query")
      h.failQuery(new Response("failed", { status: 503 }));
    if (failure === "publication")
      h.failPublication(new Response("failed", { status: 503 }));
    if (failure === "receipt")
      h.failPublication(Response.json({ accepted: false, event_id: "wrong" }));
    if (failure === "conflict") h.conflict();
    await expect(
      h.transport.removeSidebarSection(id, signal),
    ).rejects.toThrow();
  },
);
it("rejects malformed removal intents before accessing the relay", async () => {
  const h = await harness();
  for (const intent of [
    {},
    { sectionId: "" },
    { sectionId: "work", channelId: "alpha" },
  ]) {
    expect(
      (await h.post(intent, undefined, "sidebar-section-removal")).status,
    ).toBe(400);
  }
  expect(h.calls).toEqual([]);
});

// All four routes share body handling; sort alone retains its larger budget.
it("accepts split UTF-8 sort intents above the other routes' 2 KiB budget", async () => {
  const h = await harness(1);
  const sectionIds = Array.from(
    { length: 20 },
    (_, i) => `${i}-${"é".repeat(100)}`,
  );
  const group = `section:${sectionIds[0]}`;
  const intent = { group, mode: "recent", sectionIds };
  expect(Buffer.byteLength(JSON.stringify(intent))).toBeGreaterThan(2048);
  expect(Buffer.byteLength(JSON.stringify(intent))).toBeLessThan(32 * 1024);
  const response = await h.post(intent, undefined, "sidebar-sort");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ groups: { [group]: "recent" } });
  expect(h.calls.map(({ url }) => new URL(url).pathname)).toEqual([
    "/query",
    "/query",
    "/events",
    "/query",
  ]);
});

it("serializes different sidebar endpoints through one relay queue", async () => {
  const h = await harness();
  const held = h.holdNextQuery();
  const star = h.post({ channelId: "alpha", starred: true });
  await held.started.promise;
  const sort = h.post(
    { group: "channels", mode: "recent", sectionIds: [] },
    undefined,
    "sidebar-sort",
  );
  try {
    // Both HTTP requests have reached the broker before the first read completes.
    await h.received("sidebar-sort");
  } finally {
    held.release.resolve();
  }
  const responses = await Promise.all([star, sort]);
  expect(responses.map(({ status }) => status)).toEqual([200, 200]);
  await Promise.all(responses.map((response) => response.json()));
  expect(
    h.calls.map(({ body, url }) => [
      new URL(url).pathname,
      Array.isArray(body)
        ? body[0]["#d"][0]
        : body.tags.find(([name]) => name === "d")[1],
    ]),
  ).toEqual([
    ["/query", "channel-stars"],
    ["/events", "channel-stars"],
    ["/query", "channel-stars"],
    ["/query", "channel-workspace-sort"],
    ["/query", "channel-sort"],
    ["/events", "channel-workspace-sort"],
    ["/query", "channel-workspace-sort"],
  ]);
});

it("real broker removal drops a unified-only section and its filings", async () => {
  const h = await harness();
  const signal = new AbortController().signal;
  const id = "11111111-1111-4111-8111-111111111111";
  h.heads.set(
    "channel-workspaces",
    prepareSidebarAssignment(
      [],
      { channelId: "alpha", createSection: { id, name: "Work" } },
      h.key,
      Date.now(),
      emptyWorkspace,
    ).event,
  );
  expect(await h.transport.removeSidebarSection(id, signal)).toMatchObject({
    sections: [],
    assignments: {},
  });
  expect(h.calls.map(({ url }) => new URL(url).pathname)).toEqual([
    "/query",
    "/events",
    "/query",
  ]);
  const head = h.heads.get("channel-workspaces");
  const key = nip44.v2.utils.getConversationKey(h.key, h.viewer);
  const saved = JSON.parse(nip44.v2.decrypt(head.content, key));
  key.fill(0);
  expect(saved.sections).toEqual([]);
  expect(saved.assignments).toEqual({});
  expect(saved.removedSections).toBeUndefined();
  expect(saved.unfiled).toBeUndefined();
});
it("broker removal rejects invalid envelopes and unconfirmed publication", async () => {
  const h = await harness();
  for (const intent of [
    null,
    [],
    { sectionId: "" },
    { sectionId: "work", extra: true },
  ])
    expect(
      (await h.post(intent, undefined, "sidebar-section-removal")).status,
    ).toBe(400);
  const id = "11111111-1111-4111-8111-111111111111";
  h.heads.set(
    "channel-workspaces",
    prepareSidebarAssignment(
      [],
      { channelId: "alpha", createSection: { id, name: "Work" } },
      h.key,
      Date.now(),
      emptyWorkspace,
    ).event,
  );
  h.conflict();
  await expect(
    h.transport.removeSidebarSection(id, new AbortController().signal),
  ).rejects.toThrow("Relay request failed (502)");
  expect(h.calls.map(({ url }) => new URL(url).pathname)).toEqual([
    "/query",
    "/events",
    "/query",
  ]);
});

it("real broker reorders sections through the signed, confirmed narrow command", async () => {
  const h = await harness();
  const signal = new AbortController().signal;
  const ids = Array.from(
    { length: 100 },
    (_, i) => `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`,
  );
  for (const id of ids.slice(0, 2))
    await h.transport.writeSidebarAssignment(
      { channelId: id, createSection: { id, name: id } },
      signal,
    );
  h.calls.length = 0;
  for (const intent of [
    null,
    [],
    {},
    { sectionIds: "work" },
    { sectionIds: [1] },
    { sectionIds: ["a", "a"] },
    { sectionIds: [], extra: true },
  ])
    expect(
      (await h.post(intent, undefined, "sidebar-section-order")).status,
    ).toBe(400);
  expect(h.calls).toEqual([]);
  // A full 100-section order exceeds the 2 KiB budget of single-item intents.
  const reversed = [...ids].reverse().map((id) => `group:${id}`);
  expect(
    Buffer.byteLength(JSON.stringify({ sectionIds: reversed })),
  ).toBeGreaterThan(2048);
  expect(
    await h.transport.writeSidebarSectionOrder(reversed, signal),
  ).toMatchObject({
    sectionOrder: [
      `group:${ids[1]}`,
      `group:${ids[0]}`,
      "pages",
      "solo",
      "starred",
      "channels",
      "dms",
    ],
  });
  expect(h.calls.map(({ url }) => new URL(url).pathname)).toEqual([
    "/query",
    "/events",
    "/query",
  ]);
  h.calls.length = 0;
  await h.transport.writeSidebarSectionOrder(
    [`group:${ids[1]}`, `group:${ids[0]}`],
    signal,
  );
  expect(h.calls.map(({ url }) => new URL(url).pathname)).toEqual(["/query"]);
  h.conflict();
  await expect(
    h.transport.writeSidebarSectionOrder(
      [`group:${ids[0]}`, `group:${ids[1]}`],
      signal,
    ),
  ).rejects.toThrow("Relay request failed (502)");
});

it("real broker renames a section through the signed, confirmed narrow command", async () => {
  const h = await harness();
  const signal = new AbortController().signal;
  const id = "11111111-1111-4111-8111-111111111111";
  await h.transport.writeSidebarAssignment(
    {
      channelId: "alpha",
      createSection: { id, name: "Work", icon: "🏢" },
    },
    signal,
  );
  h.calls.length = 0;
  for (const intent of [
    null,
    [],
    {},
    { sectionId: id },
    { sectionId: id, name: 1 },
    { sectionId: id, name: "  " },
    { sectionId: id, icon: "  " },
    { sectionId: id, icon: 1 },
    { sectionId: id, name: "Projects", extra: true },
  ])
    expect(
      (await h.post(intent, undefined, "sidebar-section-rename")).status,
    ).toBe(400);
  expect(h.calls).toEqual([]);
  expect(
    await h.transport.renameSidebarSection(
      { sectionId: id, name: "Projects" },
      signal,
    ),
  ).toMatchObject({
    sections: [{ id, name: "Projects", icon: "🏢", order: 0 }],
    assignments: { alpha: id },
  });
  expect(h.calls.map(({ url }) => new URL(url).pathname)).toEqual([
    "/query",
    "/events",
    "/query",
  ]);
  h.calls.length = 0;
  const iconOnly = await h.transport.renameSidebarSection(
    { sectionId: id, icon: "📚" },
    signal,
  );
  expect(iconOnly.sections[0]).toMatchObject({
    id,
    name: "Projects",
    icon: "📚",
    order: 0,
  });
  expect(h.calls.map(({ url }) => new URL(url).pathname)).toEqual([
    "/query",
    "/events",
    "/query",
  ]);
  h.calls.length = 0;
  const removed = await h.transport.renameSidebarSection(
    { sectionId: id, icon: null },
    signal,
  );
  expect(removed.sections[0]).not.toHaveProperty("icon");
  expect(removed.sections[0]).toMatchObject({ name: "Projects", order: 0 });
  h.calls.length = 0;
  await h.transport.renameSidebarSection(
    { sectionId: id, name: "Projects" },
    signal,
  );
  expect(h.calls.map(({ url }) => new URL(url).pathname)).toEqual(["/query"]);
  h.conflict();
  await expect(
    h.transport.renameSidebarSection({ sectionId: id, name: "Other" }, signal),
  ).rejects.toThrow("Relay request failed (502)");
});
