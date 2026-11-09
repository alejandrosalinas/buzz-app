import { receiveAttachment } from "./attachment-file.mjs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { expect, test, vi } from "vitest";
import { getPublicKey, verifyEvent } from "nostr-tools";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import {
  uploadAttachment,
  UPLOAD_MAX_BYTES,
  UPLOAD_TIMEOUT_MS,
} from "./attachment-upload.mjs";

const key = new Uint8Array(32).fill(7);
const relay = "https://relay.test";
const descriptor = (body, origin = relay) => {
  const sha256 = createHash("sha256").update(body).digest("hex");
  return {
    url: `${origin}/media/${sha256}.bin`,
    sha256,
    size: body.length,
    type: "application/octet-stream",
    uploaded: 1700000000,
  };
};
const deferred = () => Promise.withResolvers();
async function harness(respond, completed = () => {}) {
  const calls = [];
  let handler;
  const server = createServer(async (req, res) => {
    try {
      await handler(req, res, () => res.end());
    } finally {
      completed(req);
    }
  });
  const plugin = relayBrokerPlugin({
    archiveFile: ":memory:",
    relayUrl: relay,
    identity: () => key.slice(),
    authority: async () => ({ relayAuthor: getPublicKey(key) }),
    upstreamFetch: async (url, init) => {
      // Consume the real streaming request before the fake relay returns a descriptor.
      const received = init.body
        ? Buffer.concat(await Array.fromAsync(init.body))
        : undefined;
      const observed = { ...init, body: received };
      calls.push({ url: String(url), init: observed });
      return respond(String(url), observed);
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
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    calls,
    base,
    post(body = "notes", options = {}) {
      return fetch(`${base}/api/relay/upload`, {
        method: "POST",
        body,
        headers: { Origin: base, "Content-Type": "application/octet-stream" },
        ...options,
      });
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("binary upload signs exact bytes for the captured community; existing proxy safely downloads", async () => {
  const bytes = Buffer.from("private notes");
  const other = "https://second.test";
  const h = await harness(async (url, init) => {
    const auth = JSON.parse(
      Buffer.from(init.headers.Authorization.slice(6), "base64url"),
    );
    expect(verifyEvent(auth)).toBe(true);
    expect(auth.pubkey).toBe(getPublicKey(key));
    expect(auth.tags).toContainEqual(["server", "second.test"]);
    expect(init.redirect).toBe("error");
    if (url.endsWith("/upload")) {
      expect(init.method).toBe("PUT");
      expect(init.body).toEqual(bytes);
      expect(auth.kind).toBe(24242);
      expect(auth.tags).toContainEqual(["t", "upload"]);
      expect(auth.tags).toContainEqual(["x", descriptor(bytes).sha256]);
      expect(init.headers["X-SHA-256"]).toBe(descriptor(bytes).sha256);
      expect(auth.tags).toContainEqual([
        "expiration",
        String(auth.created_at + Math.ceil(UPLOAD_TIMEOUT_MS / 1000) + 60),
      ]);
      return Response.json({ ...descriptor(bytes, other), dim: "640x400" });
    }
    expect(auth.tags).toContainEqual(["t", "get"]);
    return new Response(bytes, {
      headers: { "Content-Type": "application/octet-stream" },
    });
  });
  try {
    const register = await fetch(`${h.base}/api/relay/register`, {
      method: "POST",
      headers: { Origin: h.base },
      body: JSON.stringify({ url: other }),
    });
    const destination = await register.json();
    const endpoint = `${h.base}/api/relay/${encodeURIComponent(destination.id)}`;
    const uploaded = await fetch(`${endpoint}/upload`, {
      method: "POST",
      body: bytes,
      headers: { Origin: h.base, "Content-Type": "application/octet-stream" },
    });
    expect(uploaded.status).toBe(200);
    const result = await uploaded.json();
    const { uploaded: _uploaded, ...expected } = descriptor(bytes, other);
    expect(result).toEqual({ ...expected, dim: "640x400" });
    const downloaded = await fetch(
      `${endpoint}/media?url=${encodeURIComponent(result.url)}`,
    );
    expect(downloaded.headers.get("content-disposition")).toBe("attachment");
    expect(downloaded.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
    expect(h.calls.map((c) => c.url)).toEqual([`${other}/upload`, result.url]);
  } finally {
    await h.close();
  }
});

test("rejects cross-origin, unregistered destination, empty body and malformed MIME before upload", async () => {
  const h = await harness(() => {
    throw new Error("Unexpected upstream call");
  });
  try {
    expect(
      (await h.post("notes", { headers: { Origin: "https://evil.test" } }))
        .status,
    ).toBe(403);
    expect(
      (
        await fetch(
          `${h.base}/api/relay/${encodeURIComponent("https://unknown.test")}/upload`,
          {
            method: "POST",
            body: "notes",
            headers: { Origin: h.base },
          },
        )
      ).status,
    ).toBe(400);
    expect((await h.post("")).status).toBe(413);
    expect(
      (
        await h.post("notes", {
          headers: { Origin: h.base, "Content-Type": "text/plain; x=1" },
        })
      ).status,
    ).toBe(400);
    expect(h.calls).toHaveLength(0);
  } finally {
    await h.close();
  }
});

test.each([
  [400, "metadata", 400],
  [415, "rejected", 400],
])(
  "maps upstream %i without leaking response details",
  async (status, code, expected) => {
    const h = await harness(
      () =>
        new Response(
          status === 400 ? "private metadata details" : "private error",
          { status },
        ),
    );
    try {
      const response = await h.post();
      expect(response.status).toBe(expected);
      expect(await response.json()).toEqual({ code });
    } finally {
      await h.close();
    }
  },
);

test.each([
  [
    422,
    "video resolution too high: maximum is 2160 on the short edge and 3840 on the long edge",
    "resolution",
  ],
  [422, "video too long: duration exceeds 600 seconds", "duration"],
  [415, "unsupported container: only MP4 is accepted", "rejected"],
])("names the relay's %i video rule: %s", async (status, error, code) => {
  const h = await harness(() => Response.json({ error }, { status }));
  try {
    const response = await h.post();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code });
  } finally {
    await h.close();
  }
});

test.each([
  [413, "size", 413],
  [401, "denied", 403],
  [403, "denied", 403],
  [429, "capacity", 429],
  [500, "failed", 502],
])(
  "preserves upstream %i with oversized or absent bodies and releases admission",
  async (status, code, expected) => {
    let cancelled = 0;
    let empty = false;
    const h = await harness(
      () =>
        new Response(
          empty
            ? null
            : new ReadableStream({
                start(controller) {
                  controller.enqueue(new Uint8Array(8193));
                },
                cancel() {
                  cancelled++;
                },
              }),
          { status },
        ),
    );
    try {
      for (let i = 0; i < 3; i++) {
        const response = await h.post();
        expect(response.status).toBe(expected);
        expect(await response.json()).toEqual({ code });
      }
      expect(cancelled).toBe(3);
      empty = true;
      const response = await h.post();
      expect(response.status).toBe(expected);
      expect(await response.json()).toEqual({ code });
      expect(h.calls).toHaveLength(4);
    } finally {
      await h.close();
    }
  },
);

test.each([
  null,
  { size: 99 },
  { sha256: "0".repeat(64) },
  { type: "text/html; charset=utf-8" },
  { url: "https://evil.test/media/a.bin" },
  { url: "https://relay.test/not-media" },
  { url: "https://user@relay.test/media/a.bin" },
  { url: "?query" },
])("rejects invalid upload descriptors %j", async (patch) => {
  const h = await harness((_, init) =>
    Response.json(
      patch === null ? null : { ...descriptor(init.body), ...patch },
    ),
  );
  try {
    const response = await h.post();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ code: "invalid" });
  } finally {
    await h.close();
  }
});

test("response budget cancels the upstream reader and releases admission", async () => {
  let cancelled = false;
  const h = await harness(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(8193));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  try {
    for (let i = 0; i < 3; i++) expect((await h.post()).status).toBe(502);
    expect(cancelled).toBe(true);
    expect(h.calls).toHaveLength(3);
  } finally {
    await h.close();
  }
});

test("two in-flight uploads bound admission; disconnect cancels upstream and frees its slot", async () => {
  const started = [deferred(), deferred(), deferred()];
  const aborted = deferred();
  const settleAbort = deferred();
  const completed = deferred();
  const release = deferred();
  let count = 0;
  const h = await harness(
    async (_, init) => {
      const index = count++;
      started[index].resolve();
      if (index === 0) {
        await new Promise((resolve) => {
          init.signal.addEventListener(
            "abort",
            () => {
              aborted.resolve();
              resolve();
            },
            { once: true },
          );
        });
        // Hold cancellation settlement: an unrelated GET must not prove cleanup.
        await settleAbort.promise;
        throw init.signal.reason;
      }
      await release.promise;
      return Response.json(descriptor(init.body));
    },
    (req) => {
      if (req.headers["x-test-upload"] === "first") completed.resolve();
    },
  );
  const cancel = new AbortController();
  const first = h.post("first", {
    signal: cancel.signal,
    headers: {
      Origin: h.base,
      "Content-Type": "application/octet-stream",
      "X-Test-Upload": "first",
    },
  });
  const failure = expect(first).rejects.toThrow();
  let second, third;
  try {
    await started[0].promise;
    second = h.post("second");
    await started[1].promise;
    expect((await h.post()).status).toBe(429);
    cancel.abort();
    await failure;
    await aborted.promise;
    await fetch(`${h.base}/api/relay/identity`);
    expect((await h.post()).status).toBe(429);
    settleAbort.resolve();
    // Await the actual middleware lifetime, including stream/disk cleanup and slot release.
    await completed.promise;
    third = h.post("third");
    await started[2].promise;
    release.resolve();
    expect((await second).status).toBe(200);
    expect((await third).status).toBe(200);
  } finally {
    cancel.abort();
    settleAbort.resolve();
    release.resolve();
    await Promise.allSettled([first, second, third]);
    await h.close();
  }
});

test("declared and streamed request budgets reject before signing or forwarding", async () => {
  const forward = vi.fn();
  for (const declared of [true, false]) {
    const req = Readable.from(
      (function* () {
        // Cross the cumulative limit without hashing/spooling the entire budget.
        // The second chunk fits by itself; the preceding byte makes it too large.
        yield Buffer.from("x");
        yield Buffer.alloc(UPLOAD_MAX_BYTES);
      })(),
    );
    req.headers = declared
      ? { "content-length": String(UPLOAD_MAX_BYTES + 1) }
      : {};
    await expect(
      uploadAttachment(req, relay, key, forward, new AbortController().signal),
    ).rejects.toMatchObject({ code: "size" });
    req.destroy();
  }
  expect(forward).not.toHaveBeenCalled();
});

test("the spool budget counts bytes across chunks", async () => {
  const req = Readable.from([
    Buffer.alloc(8),
    Buffer.alloc(8),
    Buffer.alloc(1),
  ]);
  req.headers = {};
  try {
    await expect(
      receiveAttachment(
        req,
        16,
        new AbortController().signal,
        () => new Error("size"),
      ),
    ).rejects.toThrow("size");
  } finally {
    req.destroy();
  }
});

test("the whole-operation timeout aborts a stalled body without forwarding", async () => {
  const deadline = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(deadline.signal);
  const forward = vi.fn();
  const req = new Readable({ read() {} });
  req.headers = {};
  try {
    const result = uploadAttachment(
      req,
      relay,
      key,
      forward,
      new AbortController().signal,
    );
    const rejected = expect(result).rejects.toThrow();
    expect(timeout).toHaveBeenCalledWith(UPLOAD_TIMEOUT_MS);
    deadline.abort();
    await rejected;
    expect(req.destroyed).toBe(true);
    expect(forward).not.toHaveBeenCalled();
  } finally {
    timeout.mockRestore();
    req.destroy();
  }
});

test.each(["text/html"])(
  "keeps range headers on inert %s downloads",
  async (type) => {
    const bytes = Buffer.from("partial");
    const h = await harness((url, init) => {
      expect(url).toBe(`${relay}/media/${"d".repeat(64)}.bin`);
      expect(init.headers.Range).toBe("bytes=3-9");
      return new Response(bytes, {
        status: 206,
        headers: {
          "Content-Type": type,
          "Content-Range": "bytes 3-9/20",
          "Content-Length": String(bytes.length),
          "Accept-Ranges": "bytes",
        },
      });
    });
    try {
      const response = await fetch(
        `${h.base}/api/relay/media?url=${encodeURIComponent(`${relay}/media/${"d".repeat(64)}.bin`)}`,
        { headers: { Range: "bytes=3-9" } },
      );
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe("bytes 3-9/20");
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(response.headers.get("content-length")).toBe(String(bytes.length));
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(response.headers.get("content-disposition")).toBe("attachment");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    } finally {
      await h.close();
    }
  },
);

test("an upload the community refuses marks its response for the connection", async () => {
  let reply;
  const h = await harness(async () => reply());
  try {
    for (const [status, body, mark] of [
      [403, "authorization denied\n", "access"],
      [401, "authentication required\n", "sign-in"],
      [403, "evidence rejected\n", "sign-in"],
      // The media route's own membership refusal (non-member or banned).
      [403, JSON.stringify({ error: "relay membership required" }), "access"],
      // The REST refusal, at 97 bytes past the old 64-byte copy bound.
      [
        403,
        JSON.stringify({
          error: "relay_membership_required",
          message: "You must be a relay member to access this relay",
        }),
        "access",
      ],
      // An item's or an edge's refusal says nothing about the community.
      [403, JSON.stringify({ error: "restricted: p-gated" }), null],
      [403, "<html>Forbidden</html>", null],
    ]) {
      reply = () => new Response(body, { status });
      const response = await h.post();
      // The route still reports its own upload error.
      expect(await response.json()).toEqual({ code: "denied" });
      expect(response.headers.get("x-buzz-refusal")).toBe(mark);
    }
  } finally {
    await h.close();
  }
});
