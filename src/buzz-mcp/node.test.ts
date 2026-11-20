import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "nostr-tools/utils";
import { keypair, signed } from "../features/relay/testing";
import { LIVE_CANVAS_BYTES } from "../features/channel-templates/canvas-limits.ts";
import { nodeClient, relayAuthority, relayAuthorityLookup } from "./node";
import { callTool, memoryVersion } from "./tools";

const agent = keypair();
const owner = keypair();
let stored: unknown[];
let response: ((init: RequestInit) => unknown) | undefined;

// A community that keeps what is posted and answers every query with all of it.
beforeEach(() => {
  stored = [];
  response = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/events")) stored.push(JSON.parse(String(init.body)));
      const body = url.endsWith("/events")
        ? { accepted: true }
        : (response?.(init) ?? stored);
      return new Response(JSON.stringify(body));
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const client = () =>
  nodeClient({
    relay: "wss://relay.test",
    key: bytesToHex(agent.secret),
    auth: JSON.stringify(["auth", owner.pubkey, "", "0".repeat(128)]),
    root: "/",
  });
const message = signed(owner, { kind: 9, content: "hi", tags: [["h", "c"]] });

it("returns verified events from a query", async () => {
  response = () => [message];
  expect(await client().query([{ kinds: [9] }])).toMatchObject([
    { id: message.id, content: "hi" },
  ]);
});

it.each([
  ["a forged signature", () => [{ ...message, sig: "0".repeat(128) }]],
  ["edited content", () => [{ ...message, content: "bye" }]],
  ["a malformed record", () => [{ ...message, pubkey: "me" }]],
  ["a non-array body", () => ({ events: [message] })],
])("rejects a query answered with %s", async (_, body) => {
  response = body;
  await expect(client().query([{ kinds: [9] }])).rejects.toThrow(
    /malformed or invalidly signed|not an event array/,
  );
});

it("marks a memory read the relay cut short as partial", async () => {
  const buzz = client();
  await buzz.remember("mem/a", "x", 0);
  await buzz.remember("mem/b", "y", 0);
  // 1,001 matching events (repeats are cheap to verify); the relay answers at
  // most 1,000 to one query, whatever it asks.
  let total = 1001;
  response = (init) => {
    const [{ limit }] = JSON.parse(String(init.body)) as [{ limit: number }];
    const count = Math.min(limit, 1000, total);
    return Array.from({ length: count }, (_, index) => stored[index % 2]);
  };
  expect(await buzz.memories()).toMatchObject({ partial: true });
  total = 999;
  expect(await buzz.memories()).toMatchObject({ partial: false });
}, 30_000);

it("reads back its memory and rejects a tampered entry", async () => {
  const buzz = client();
  await buzz.remember("mem/notes", "keep this", 0);
  expect(await buzz.memories()).toMatchObject({
    entries: [{ slug: "mem/notes", body: "keep this" }],
    partial: false,
  });

  // The newest head would win if its signature went unchecked.
  const entry = stored[0] as { created_at: number };
  stored.push({ ...entry, created_at: entry.created_at + 1 });
  await expect(buzz.memories()).rejects.toThrow(/invalidly signed/);
});

it("deletes a memory entry and recreates it after its tombstone", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(1_800_000_000_000);
    const buzz = client();
    // An entry dated ahead of this clock, as a writer with a fast clock leaves.
    await buzz.remember("mem/notes", "keep this", 1_800_000_100);
    await expect(
      callTool(buzz, {}, "mem_rm", {
        slug: "notes",
        expected: await memoryVersion("keep this"),
      }),
    ).resolves.toBe("deleted mem/notes");
    expect(await buzz.memories()).toEqual({
      entries: [],
      deleted: [{ slug: "mem/notes", createdAt: 1_800_000_102 }],
      partial: false,
    });
    // In the same second, the new entry must still outrank the tombstone.
    await callTool(buzz, {}, "mem_set", { slug: "notes", text: "again" });
    expect(stored).toHaveLength(3);
    await expect(
      callTool(buzz, {}, "mem_get", { slug: "notes" }),
    ).resolves.toBe(`version: ${await memoryVersion("again")}\n\nagain`);
  } finally {
    vi.useRealTimers();
  }
});

it("saves only its community's media, signed for a get, and shows images", async () => {
  const dir = await mkdtemp(join(tmpdir(), "buzz-media-"));
  const buzz = nodeClient({
    relay: "wss://relay.test",
    key: bytesToHex(agent.secret),
    root: "/",
    media: dir,
  });
  const bytes = new Uint8Array([1, 2, 3]);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const fetch = vi.mocked(globalThis.fetch);
  const serve = (body: BodyInit, type: string, status = 200) =>
    fetch.mockResolvedValueOnce(
      new Response(body, { status, headers: { "content-type": type } }),
    );
  serve(bytes, "image/png");
  await expect(
    buzz.media(`https://relay.test/media/${sha}.png`),
  ).resolves.toEqual({
    path: join(dir, `${sha}.png`),
    type: "image/png",
    size: 3,
    data: btoa("\x01\x02\x03"),
  });
  const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
  expect(url).toBe(`https://relay.test/media/${sha}.png`);
  const header = (init.headers as Record<string, string>).authorization ?? "";
  const auth = JSON.parse(
    Buffer.from(header.replace("Nostr ", ""), "base64url").toString(),
  );
  expect(auth).toMatchObject({ kind: 24242, pubkey: agent.pubkey });
  expect(auth.tags).toContainEqual(["t", "get"]);
  expect(auth.tags).toContainEqual(["server", "relay.test"]);
  for (const input of [
    `https://elsewhere.test/media/${sha}.png`,
    `${sha}/../x`,
    "not-a-hash",
  ])
    await expect(buzz.media(input)).rejects.toThrow(
      "only their community's media",
    );
  expect(fetch).toHaveBeenCalledTimes(1);

  // Any other type is saved, named with its type, and not shown.
  serve(bytes, "video/mp4");
  await expect(buzz.media(sha)).resolves.toEqual({
    path: join(dir, `${sha}.mp4`),
    type: "video/mp4",
    size: 3,
  });
  expect(new Uint8Array(await readFile(join(dir, `${sha}.mp4`)))).toEqual(
    bytes,
  );
  // An image too big to show is still saved.
  const big = new Uint8Array(3_932_161);
  const bigSha = createHash("sha256").update(big).digest("hex");
  serve(big, "image/png");
  await expect(buzz.media(bigSha)).resolves.toEqual({
    path: join(dir, `${bigSha}.png`),
    type: "image/png",
    size: big.length,
  });

  serve("denied", "text/plain", 401);
  await expect(buzz.media(sha)).rejects.toThrow("Media failed: 401 denied");
  const wrongHash = "a".repeat(64);
  serve(bytes, "video/mp4");
  await expect(buzz.media(wrongHash)).rejects.toThrow(
    "Media did not match its SHA-256",
  );
  // Nothing is left behind for a refused blob.
  expect((await readdir(dir)).sort()).toEqual(
    [`${sha}.png`, `${sha}.mp4`, `${bigSha}.png`].sort(),
  );
  serve(bytes, "image/jpeg");
  await expect(buzz.media(`${wrongHash}.thumb.jpg`)).resolves.toMatchObject({
    type: "image/jpeg",
    data: btoa("\x01\x02\x03"),
  });
  await rm(dir, { recursive: true });
});

it("reports a media folder it cannot write as a tool error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "buzz-media-"));
  await chmod(dir, 0o500);
  const buzz = nodeClient({
    relay: "wss://relay.test",
    key: bytesToHex(agent.secret),
    root: "/",
    media: dir,
  });
  const bytes = new Uint8Array([1, 2, 3]);
  const sha = createHash("sha256").update(bytes).digest("hex");
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(
    new Response(bytes, { headers: { "content-type": "video/mp4" } }),
  );
  // An unhandled stream error would end the MCP server instead.
  await expect(buzz.media(sha)).rejects.toThrow(/EACCES/);
  await chmod(dir, 0o700);
  expect(await readdir(dir)).toEqual([]);
  await rm(dir, { recursive: true });
});

it("searches profile names, signed, and reports a community without the search", async () => {
  const wes = signed(owner, { kind: 0, content: '{"name":"Wes"}', tags: [] });
  const fetch = vi.mocked(globalThis.fetch);
  fetch.mockResolvedValueOnce(new Response(JSON.stringify([wes])));
  expect(await client().searchProfiles?.("wes", 100)).toMatchObject([
    { id: wes.id },
  ]);
  const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("https://relay.test/profiles/search");
  expect(JSON.parse(String(init.body))).toEqual({ query: "wes", limit: 100 });
  const header = (init.headers as Record<string, string>).authorization ?? "";
  const auth = JSON.parse(atob(header.replace(/^Nostr /, "")));
  expect(auth.kind).toBe(27235);
  expect(auth.tags).toContainEqual(["u", url]);
  for (const status of [404, 405]) {
    fetch.mockResolvedValueOnce(new Response("", { status }));
    expect(await client().searchProfiles?.("wes", 100)).toBeUndefined();
  }
  fetch.mockResolvedValueOnce(new Response("broken", { status: 500 }));
  await expect(client().searchProfiles?.("wes", 100)).rejects.toThrow(
    "500 broken",
  );
});

describe("relayAuthority", () => {
  const key = "a".repeat(64);
  const relay = (answer: () => Promise<Response>) => {
    const fetch = vi.fn(answer);
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };

  it("asks the relay's own origin for its NIP-11 key, sending no credentials", async () => {
    const fetch = relay(async () => Response.json({ self: key, pubkey: "b" }));
    expect(await relayAuthority("wss://relay.test/")).toBe(key);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://relay.test");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({ Accept: "application/nostr+json" });
  });

  it.each([
    ["no key", async () => Response.json({ name: "relay" })],
    [
      "only the operator-contact pubkey",
      async () => Response.json({ pubkey: key }),
    ],
    ["a non-object", async () => Response.json(null)],
  ])("learns there is no key from %s", async (_, answer) => {
    relay(answer);
    expect(await relayAuthority("wss://relay.test")).toBeUndefined();
  });

  it.each([
    ["a failed answer", async () => new Response("no", { status: 503 })],
    ["unreadable JSON", async () => new Response("<html>")],
    ["a malformed key", async () => Response.json({ self: "A".repeat(64) })],
    [
      "a refused redirect",
      async () => {
        throw new TypeError("fetch failed: redirect mode is set to error");
      },
    ],
  ])("fails, rather than finding no key, on %s", async (_, answer) => {
    relay(answer);
    await expect(relayAuthority("wss://relay.test")).rejects.toThrow();
  });

  it("asks again after a failed lookup and keeps the key it learns", async () => {
    const fetch = relay(async () => new Response("no", { status: 503 }));
    const lookup = relayAuthorityLookup("wss://relay.test");
    await expect(lookup()).rejects.toThrow("503");
    fetch.mockImplementation(async () => Response.json({ self: key }));
    expect(await lookup()).toBe(key);
    expect(await lookup()).toBe(key);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps a learned key when an overlapping lookup fails later", async () => {
    let fail = (_: Response) => {};
    const fetch = relay(async () => Response.json({ self: key }));
    fetch.mockImplementationOnce(async () => Response.json({ self: key }));
    fetch.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (fail = resolve)),
    );
    const lookup = relayAuthorityLookup("wss://relay.test");
    const [learned, overlapping] = [lookup(), lookup()];
    expect(await learned).toBe(key);
    fail(new Response("no", { status: 503 }));
    expect(await overlapping).toBe(key);
    expect(await lookup()).toBe(key);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

it("refuses a Canvas whose escaped signed event would exceed the relay frame", async () => {
  const buzz = client();
  const tags = [["h", "c"]];
  await buzz.publish({
    kind: 40100,
    content: "x".repeat(LIVE_CANVAS_BYTES),
    tags,
  });
  expect(stored).toHaveLength(1);
  await expect(
    (async () =>
      buzz.publish({
        kind: 40100,
        content: '"'.repeat(LIVE_CANVAS_BYTES),
        tags,
      }))(),
  ).rejects.toThrow("too large to publish");
  expect(stored).toHaveLength(1);
});
