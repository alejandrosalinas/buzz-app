import { brokerSocket, openBrokerSocket } from "../tests/broker-socket.mjs";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
  verifyEvent,
} from "nostr-tools";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";
import { createRelayReader } from "../src/features/relay/reader.ts";
import { createReadState } from "../src/features/relay/read-state.ts";
import { readJournal } from "../src/features/relay/read-state-storage.ts";
import {
  ReadStateTimestampRejected,
  READ_STATE_TIMESTAMP_REFUSAL,
} from "../src/features/relay/read-state-host.ts";
import { signReadState } from "./read-state.mjs";
import { fixtureRelayUrl, fixtureAliases } from "../tests/relay-config.ts";

const disposals = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});
const community = "01234567-89ab-cdef-0123-456789abcdef";
async function harness(discovered = true) {
  const key = generateSecretKey(),
    viewer = getPublicKey(key);
  let handler, response, published;
  const calls = [];
  const socket = brokerSocket((event) => {
    published = event;
    return "";
  });
  const server = createServer((req, res) => {
    req.headers.origin ??= `http://${req.headers.host}`;
    handler(req, res);
  });
  const plugin = relayBrokerPlugin({
    archiveFile: ":memory:",
    relayUrl: fixtureRelayUrl,
    communityAliases: fixtureAliases,
    identity: () => key,
    socketFactory: () => {
      const connection = socket.factory();
      const send = connection.send;
      connection.send = (text) => {
        const [type, event] = JSON.parse(text);
        if (
          type === "EVENT" &&
          Math.abs(event.created_at - Math.floor(Date.now() / 1000)) > 900
        ) {
          socket.publications.push(event);
          queueMicrotask(() =>
            connection.onmessage?.({
              data: JSON.stringify([
                "OK",
                event.id,
                false,
                READ_STATE_TIMESTAMP_REFUSAL,
              ]),
            }),
          );
          return;
        }
        send.call(connection, text);
      };
      return connection;
    },
    // Keep real NIP-11 discovery, signing, admission and broker routes. Only relay I/O is modeled.
    upstreamFetch: async (url, init) => {
      if (!init?.body)
        return Response.json({
          self: viewer,
          ...(discovered
            ? {
                read_state_snapshot: {
                  version: 1,
                  community_id: community,
                  max_events: 4096,
                  max_bytes: 8388608,
                },
              }
            : {}),
        });
      const body = JSON.parse(init.body);
      const auth = JSON.parse(
        Buffer.from(init.headers.Authorization.slice(6), "base64").toString(),
      );
      expect(verifyEvent(auth)).toBe(true);
      expect(auth.pubkey).toBe(viewer);
      expect(auth.tags).toContainEqual(["u", String(url)]);
      expect(auth.tags).toContainEqual([
        "payload",
        createHash("sha256").update(init.body).digest("hex"),
      ]);
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/events")) {
        published = body;
        return Response.json({ accepted: true, event_id: body.id });
      }
      if (body[0]?.read_state_snapshot && response instanceof Response)
        return response;
      if (body[0]?.read_state_snapshot)
        return Response.json(
          response ?? {
            read_state_snapshot: 1,
            complete: true,
            community_id: community,
            pubkey: viewer,
            snapshot_id: "a".repeat(64),
            events: published ? [published] : [],
          },
        );
      return Response.json(
        Array.isArray(response) ? response : published ? [published] : [],
      );
    },
  });
  await plugin.configureServer({
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
  const requests = createRelayReader(transport);
  disposals.push(() => requests.dispose());
  return {
    key,
    viewer,
    transport,
    async start() {
      const live = await openBrokerSocket(transport);
      disposals.push(() => live.dispose());
    },
    reader: requests.reader,
    calls,
    envelope(events = []) {
      return {
        read_state_snapshot: 1,
        complete: true,
        community_id: community,
        pubkey: viewer,
        snapshot_id: "a".repeat(64),
        events,
      };
    },
    reply(value) {
      response = value;
    },
    post(route, value, headers) {
      return fetch(`${base}/api/relay/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(value),
      });
    },
  };
}
it("real broker discovery -> reader snapshot and scoped encrypted signing/publication use existing relay routes", async () => {
  const h = await harness(),
    signal = new AbortController().signal;
  expect(h.transport.readState.communityId).toBe(community);
  expect(await h.reader.readStateSnapshot()).toEqual([]);
  const blob = { v: 1, client_id: "fixture", contexts: { room: 12 } };
  const event = await h.transport.readState.sign(
    { slot: "b".repeat(32), createdAt: Math.floor(Date.now() / 1000), blob },
    signal,
  );
  expect(verifyEvent(event)).toBe(true);
  expect(event.content).not.toContain("room");
  expect(await h.transport.readState.decode([event], signal)).toEqual([
    { eventId: event.id, blob },
  ]);
  await h.start();
  await h.transport.readState.publish(event, signal);
  expect(await h.reader.readStateSnapshot({ fresh: true })).toEqual([event]);
  expect(h.calls.map((call) => new URL(call.url).pathname)).toEqual([
    "/query",
    "/query",
  ]);
  expect(h.calls[0].body).toEqual([
    { kinds: [30078], authors: [h.viewer], read_state_snapshot: 1 },
  ]);
});
it("recovers expired saved state through broker HTTP, socket refusal and fresh coordinate readback", async () => {
  const h = await harness();
  await h.start();
  const past = Math.floor(Date.now() / 1000) - 901;
  const event = signReadState(
    {
      slot: "b".repeat(32),
      createdAt: past,
      blob: { v: 1, client_id: "fixture", contexts: { room: past } },
    },
    h.key,
    past,
  );
  await expect(
    h.transport.readState.publish(event, new AbortController().signal),
  ).rejects.toBeInstanceOf(ReadStateTimestampRejected);
  let journal = readJournal(
    {
      version: 1,
      slot: "b".repeat(32),
      clientId: "fixture",
      state: { frontiers: { room: past + 1 }, overrides: {} },
      localUnread: {},
      revision: 2,
      acceptedRevision: 0,
      lastCreatedAt: past,
      pending: { event, revision: 1 },
    },
    h.viewer,
  );
  const owner = createReadState({
    viewer: h.viewer,
    host: h.transport.readState,
    reader: h.reader,
    lock: async (_signal, work) => work(),
    storage: {
      async update(change) {
        journal = readJournal(change(journal), h.viewer);
        return journal;
      },
      close() {},
    },
  });
  disposals.push(() => owner.dispose());
  await owner.ready;
  await owner.flush();
  expect(owner.snapshot().status).toBe("reconciled");
  expect(journal.pending).toBeUndefined();
  expect(journal.acceptedRevision).toBe(2);
  const observed = await h.reader.readStateSnapshot({ fresh: true });
  expect(observed).toHaveLength(1);
  expect(observed[0].id).not.toBe(event.id);
  expect(
    (
      await h.transport.readState.decode(observed, new AbortController().signal)
    )[0].blob.contexts.room,
  ).toBe(past + 1);
});
it.each([false, true])(
  "reconciles legacy maximum-size NIP-44 records without widening writes (snapshot: %s)",
  async (discovered) => {
    const h = await harness(discovered);
    const blob = {
      v: 1,
      client_id: "legacy",
      contexts: Object.fromEntries(
        Array.from({ length: 650 }, (_, i) => [
          `msg:${i.toString(16).padStart(64, "0")}`,
          1786662839,
        ]),
      ),
    };
    const key = nip44.v2.utils.getConversationKey(h.key, h.viewer);
    const expected = { ...blob.contexts };
    const events = Array.from({ length: 5 }, (_, i) => {
      const contexts = { ...blob.contexts, [`slot-${i}`]: 1786662839 + i };
      Object.assign(expected, contexts);
      // Pad valid JSON to the original NIP-44 maximum, with unique evidence
      // per slot so dropping a record or the second batch cannot pass.
      const plaintext = JSON.stringify({ ...blob, contexts }).padEnd(
        65535,
        " ",
      );
      expect(Buffer.byteLength(plaintext)).toBe(65535);
      return finalizeEvent(
        {
          kind: 30078,
          created_at: 1786662839,
          tags: [
            ["d", `read-state:${i.toString(16).padStart(32, "0")}`],
            ["t", "read-state"],
          ],
          content: nip44.v2.encrypt(plaintext, key),
        },
        h.key,
      );
    });
    key.fill(0);
    expect(events[0].content.length).toBe(87472);
    expect(Buffer.byteLength(JSON.stringify(events[0]))).toBe(87888);
    h.reply(discovered ? h.envelope(events) : events);
    let journal;
    const owner = createReadState({
      viewer: h.viewer,
      reader: h.reader,
      host: h.transport.readState,
      storage: {
        async update(change) {
          journal = readJournal(change(journal), h.viewer);
          return journal;
        },
        close() {},
      },
    });
    disposals.push(() => owner.dispose());
    await owner.refresh();
    expect(owner.snapshot()).toMatchObject({
      status: "reconciled",
      completeness: discovered ? "snapshot" : "bounded",
    });
    expect(journal.state.frontiers).toEqual(expected);
    expect(owner.state().frontiers).toEqual(expected);
    // The receive exception is not permission to sign or republish large records.
    expect(
      (
        await h.post("read-state-sign", {
          slot: "a".repeat(32),
          createdAt: Math.floor(Date.now() / 1000),
          blob,
        })
      ).status,
    ).toBe(400);
    expect((await h.post("read-state-publish", events[0])).status).toBe(413);
    // A Unicode envelope can fit the HTTP character cap yet exceed the strict
    // publication byte cap. Exercise the actual publish validator, not only HTTP.
    const small = await h.transport.readState.sign(
      {
        slot: "a".repeat(32),
        createdAt: Math.floor(Date.now() / 1000),
        blob: { v: 1, client_id: "fixture", contexts: { room: 12 } },
      },
      new AbortController().signal,
    );
    const unicodeEnvelope = finalizeEvent(
      {
        ...small,
        tags: [
          ...small.tags,
          ["padding", "界".repeat(10000) + "x".repeat(40000)],
        ],
      },
      h.key,
    );
    expect(JSON.stringify(unicodeEnvelope).length).toBeLessThan(65536);
    expect(Buffer.byteLength(JSON.stringify(unicodeEnvelope))).toBeGreaterThan(
      65536,
    );
    expect((await h.post("read-state-decode", [unicodeEnvelope])).status).toBe(
      200,
    );
    expect((await h.post("read-state-publish", unicodeEnvelope)).status).toBe(
      400,
    );
    expect(h.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/query",
    ]);
  },
);
it("absent discovery does not grant complete enumeration and the broker rejects malformed extension filters before upstream", async () => {
  const old = await harness(false);
  expect(old.transport.readStateSnapshot).toBeUndefined();
  const filter = {
    kinds: [30078],
    authors: [old.viewer],
    read_state_snapshot: 1,
  };
  expect((await old.post("query", [filter])).status).toBe(400);
  expect(old.calls).toHaveLength(0);
  const h = await harness();
  for (const bad of [
    [{ ...filter, authors: [h.viewer], limit: 1 }],
    [{ ...filter, authors: [h.viewer], read_state_snapshot: 2, limit: 1 }],
    [
      { ...filter, authors: [h.viewer] },
      { kinds: [0], limit: 1 },
    ],
  ])
    expect((await h.post("query", bad)).status).toBe(400);
  expect(h.calls).toHaveLength(0);
});
it("broker refuses arbitrary own kind-30078 and hostile origins at decode/sign/publish boundaries", async () => {
  const h = await harness();
  const bad = finalizeEvent(
    {
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", `read-state:${"b".repeat(32)}`],
        ["t", "read-state"],
      ],
      content: "not encrypted read state",
    },
    h.key,
  );
  expect((await h.post("read-state-publish", bad)).status).toBe(400);
  expect((await h.post("read-state-decode", [bad])).status).toBe(400);
  for (const route of [
    "read-state-decode",
    "read-state-sign",
    "read-state-publish",
  ])
    expect(
      (await h.post(route, bad, { Origin: "https://hostile.invalid" })).status,
    ).toBe(403);
  expect(h.calls).toHaveLength(0);
});
it("production reader rejects old, partial, wrong-scope, invalid-signature and duplicate-coordinate snapshot responses", async () => {
  const h = await harness();
  const event = finalizeEvent(
    {
      kind: 30078,
      created_at: 100,
      tags: [["d", "unrelated"]],
      content: "unrelated app",
    },
    h.key,
  );
  const second = finalizeEvent(
    {
      kind: 30078,
      created_at: 101,
      tags: [["d", "unrelated"]],
      content: "replacement",
    },
    h.key,
  );
  for (const response of [
    [],
    { ...h.envelope(), complete: false },
    { ...h.envelope(), read_state_snapshot: 2 },
    { ...h.envelope(), community_id: "11234567-89ab-cdef-0123-456789abcdef" },
    { ...h.envelope(), pubkey: "c".repeat(64) },
    h.envelope([{ ...event, content: "tampered" }]),
    h.envelope([event, second]),
  ]) {
    h.reply(response);
    await expect(h.reader.readStateSnapshot({ fresh: true })).rejects.toThrow();
  }
  h.reply(h.envelope([event]));
  expect(await h.reader.readStateSnapshot({ fresh: true })).toEqual([event]);
}, 15000);

it("broker stops an oversized streamed snapshot before forwarding or parsing it", async () => {
  const h = await harness();
  let cancelled = false,
    pulls = 0;
  h.reply(
    new Response(
      new ReadableStream({
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await expect(h.reader.readStateSnapshot({ fresh: true })).rejects.toThrow(
    "500",
  );
  expect(cancelled).toBe(true);
  expect(pulls).toBeLessThanOrEqual(10);
});
it("thread-follows routes sign and admit only their own exact shape", async () => {
  const h = await harness();
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    client_id: "fixture",
    threads: { [`room:${"1".repeat(64)}`]: { follow: true, at: now } },
  };
  const signed = await h.post("thread-follows-sign", {
    slot: "b".repeat(32),
    createdAt: now,
    payload,
  });
  expect(signed.status).toBe(200);
  const event = await signed.json();
  expect(event.tags[0]).toEqual(["d", `thread-follows:${"b".repeat(32)}`]);
  const decoded = await h.post("thread-follows-decode", [event]);
  expect(await decoded.json()).toEqual([{ eventId: event.id, payload }]);
  // Neither route accepts the other shape, and the window is enforced.
  expect((await h.post("read-state-publish", event)).status).toBe(400);
  expect((await h.post("read-state-decode", [event])).status).toBe(400);
  const read = await h.post("read-state-sign", {
    slot: "a".repeat(32),
    createdAt: now,
    blob: { v: 1, client_id: "fixture", contexts: {} },
  });
  expect(
    (await h.post("thread-follows-publish", await read.json())).status,
  ).toBe(400);
  expect(
    (
      await h.post("thread-follows-sign", {
        slot: "b".repeat(32),
        createdAt: now + 120,
        payload,
      })
    ).status,
  ).toBe(400);
  expect(h.calls).toEqual([]);
});
