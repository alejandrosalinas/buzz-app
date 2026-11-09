import { fixtureRelayUrl } from "../tests/relay-config.ts";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import { createRelaySession } from "../src/features/relay/session.ts";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";

const self = getPublicKey(generateSecretKey());
const contact = getPublicKey(generateSecretKey());
async function harness(info, identity = generateSecretKey()) {
  let handler;
  const requests = [];
  const server = createServer((req, res) => {
    req.headers.origin = `http://${req.headers.host}`;
    handler(req, res);
  });
  await relayBrokerPlugin({
    archiveFile: ":memory:",
    relayUrl: fixtureRelayUrl,
    identity: () => identity,
    // Exercise real NIP-11 parsing, broker /session and browser transport.
    upstreamFetch: async (url, init) => {
      requests.push([url, init]);
      return info(url, init);
    },
  }).configureServer({
    httpServer: server,
    config: { logger: { info() {}, error() {} } },
    middlewares: {
      use(fn) {
        handler = fn;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    requests,
    connect: () => connectBrokerTransport(base),
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
it.each([
  [undefined, false],
  [null, false],
  [[], false],
  [["nip-cl"], false],
  ["nip-ar", false],
  [["nip-ar"], true],
])(
  "offers artifact writes only with a NIP-AR advertisement: %j",
  async (supported_extensions, supported) => {
    const h = await harness(() =>
      Response.json({ self, supported_extensions }),
    );
    try {
      const transport = await h.connect();
      expect(transport.writer.kinds.includes(45010)).toBe(supported);
      expect(transport.configArtifacts !== undefined).toBe(supported);
      if (supported) {
        const event = await transport.configArtifacts.sign(
          {
            kind: 45010,
            created_at: Math.floor(Date.now() / 1000),
            tags: [["ar", "1"]],
            content: "{}",
          },
          new AbortController().signal,
        );
        expect(event.kind).toBe(45010);
        expect(event.pubkey).toBe(transport.viewer);
      }
      expect(h.requests).toHaveLength(1);
    } finally {
      await h.close();
    }
  },
);
it.each([
  ["explicit self", { self, pubkey: contact }, self, self],
  ["self without contact", { self }, self, self],
  ["contact only", { pubkey: contact }, contact, undefined],
  ["null self", { self: null, pubkey: contact }, contact, undefined],
])(
  "preserves archive authority only from %s",
  async (_label, info, author, archiveAuthority) => {
    const h = await harness(() => Response.json(info));
    try {
      const transport = await h.connect();
      expect(transport.relayAuthor).toBe(author);
      expect(transport.archiveAuthority).toBe(archiveAuthority);
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0][0]).toBe(transport.scope);
      expect(h.requests[0][1].headers.Accept).toBe("application/nostr+json");
      expect(h.requests[0][1].redirect).toBe("error");
    } finally {
      await h.close();
    }
  },
);
it.each([
  null,
  [],
  {},
  { self: "", pubkey: contact },
  { self: self.toUpperCase(), pubkey: contact },
  { self: 42, pubkey: contact },
])("rejects malformed NIP-11 identity without fallback: %j", async (info) => {
  const h = await harness(() => Response.json(info));
  try {
    await expect(h.connect()).rejects.toThrow();
  } finally {
    await h.close();
  }
});
it("does not accept an identity from a failed HTTP response or cache that failure", async () => {
  let fail = true;
  const h = await harness(() =>
    Response.json({ self }, { status: fail ? 503 : 200 }),
  );
  try {
    await expect(h.connect()).rejects.toThrow();
    fail = false;
    expect((await h.connect()).archiveAuthority).toBe(self);
    expect(h.requests).toHaveLength(2);
  } finally {
    await h.close();
  }
});

it("actual broker → verified transport → session rejects a corrupted archive envelope", async () => {
  const secret = generateSecretKey();
  const author = getPublicKey(secret);
  const event = finalizeEvent(
    { kind: 13535, created_at: 1, tags: [["-"], ["p", contact]], content: "" },
    secret,
  );
  let corrupt = true;
  const h = await harness((url) =>
    String(url).endsWith("/query")
      ? Response.json([
          { ...event, sig: corrupt ? "0".repeat(128) : event.sig },
        ])
      : Response.json({ self: author, pubkey: contact }),
  );
  // Finite read contract only; do not open an upstream WebSocket in this test.
  const { subscribe: _live, ...transport } = await h.connect();
  const owner = createRelaySession(transport);
  try {
    await owner.session.archives.refresh();
    expect(owner.session.archives.snapshot().status).toBe("error");
    expect(owner.session.archives.state(contact)).toBe("unknown");
    corrupt = false;
    await owner.session.archives.refresh();
    expect(owner.session.archives.state(contact)).toBe("archived");
  } finally {
    owner.dispose();
    await h.close();
  }
});

it.each([Infinity, 100.5])(
  "raw HTTP profile time %s fails the entire read, not just the malformed row",
  async (created_at) => {
    const key = generateSecretKey();
    const author = getPublicKey(key);
    const older = finalizeEvent(
      { kind: 0, created_at: 1, content: "{}", tags: [] },
      key,
    );
    const invalid = finalizeEvent(
      { kind: 0, created_at, content: "{}", tags: [] },
      key,
    );
    let malformed = true;
    const filter = { authors: [author], kinds: [0], limit: 500 };
    const h = await harness((url, init) => {
      if (!String(url).endsWith("/query")) return Response.json({ self });
      expect(JSON.parse(init.body)).toEqual([filter]);
      return new Response(
        JSON.stringify(malformed ? [older, invalid] : [older]).replace(
          '"created_at":null',
          '"created_at":1e400',
        ),
        { headers: { "Content-Type": "application/json" } },
      );
    });
    const transport = await h.connect();
    try {
      await expect(transport.query([filter])).rejects.toThrow();
      malformed = false;
      expect(await transport.query([filter])).toEqual([older]);
    } finally {
      await h.close();
    }
  },
);
it("raw HTTP overflow archive cannot poison the ordering fence across clear and valid retry", async () => {
  const key = generateSecretKey(),
    author = getPublicKey(key);
  const bad = finalizeEvent(
    {
      kind: 13535,
      created_at: Infinity,
      content: "",
      tags: [["-"], ["p", contact]],
    },
    key,
  );
  const good = finalizeEvent(
    { kind: 13535, created_at: 200, content: "", tags: [["-"]] },
    key,
  );
  let malformed = true;
  const h = await harness((url) =>
    !String(url).endsWith("/query")
      ? Response.json({ self: author })
      : new Response(
          JSON.stringify([malformed ? bad : good]).replace(
            '"created_at":null',
            '"created_at":1e400',
          ),
          { headers: { "Content-Type": "application/json" } },
        ),
  );
  const { subscribe: _live, ...transport } = await h.connect();
  const owner = createRelaySession(transport);
  try {
    await owner.session.archives.refresh();
    expect(owner.session.archives.snapshot().status).toBe("error");
    expect(owner.session.archives.state(contact)).toBe("unknown");
    await owner.clearCache();
    malformed = false;
    await owner.session.archives.refresh();
    expect(owner.session.archives.snapshot()).toMatchObject({
      status: "ready",
      createdAt: 200,
    });
    expect(owner.session.archives.state(contact)).toBe("not-archived");
  } finally {
    owner.dispose();
    await h.close();
  }
});
