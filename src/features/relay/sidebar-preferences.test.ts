import {
  fixtureRelayUrl,
  fixtureAliases,
} from "../../../tests/relay-config.ts";
import { createServer, request, type RequestListener } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { ViteDevServer } from "vite";
import { nip44 } from "nostr-tools";
import { expect, it, vi } from "vitest";
import { relayBrokerPlugin } from "../../../browser-host/relay-broker.mjs";
import { connectBrokerTransport } from "./transport";
import { createRelaySession } from "./session";
import {
  projectSidebarPreferences,
  readSidebarPreferences,
  workspaceSectionOrder,
} from "./sidebar-preferences";
import { keypair, signed, scriptedTransport, flush, roster } from "./testing";
import type { LiveCallbacks } from "./live";
import { ReadError } from "./errors";

const groups = {
  version: 1,
  sections: [{ id: "work", name: "Work", order: 0 }],
  assignments: { general: "work", orphan: "missing" },
};
const stars = {
  version: 1,
  channels: {
    general: { starred: true, updatedAt: 1 },
    removed: { starred: false, updatedAt: 2 },
  },
};
const expected = {
  sections: groups.sections,
  assignments: { general: "work" },
  starred: ["general"],
  muted: [],
};

it.each([
  { saved: [], workspaces: ["group:work", "group:later"] },
  { saved: ["group:later"], workspaces: ["group:later", "group:work"] },
])(
  "inserts new workspaces in a saved layout with groups $saved",
  ({ saved, workspaces }) => {
    const sectionOrder = [
      "channels",
      "starred",
      ...saved,
      "solo",
      "forums",
      "dms",
    ];
    const sections = [
      ...groups.sections,
      { id: "later", name: "Later", order: 1 },
    ];
    expect(workspaceSectionOrder({ sections, sectionOrder })).toEqual([
      "pages",
      "channels",
      "starred",
      ...workspaces,
      "solo",
      "forums",
      "dms",
    ]);
  },
);

it("decodes four individually bounded populated preferences beyond the former aggregate limit", async () => {
  const viewer = keypair();
  const key = nip44.v2.utils.getConversationKey(viewer.secret, viewer.pubkey);
  const encrypted = (coordinate: string, value: unknown) =>
    signed(viewer, {
      kind: 30078,
      tags: [["d", coordinate]],
      content: nip44.v2.encrypt(JSON.stringify(value), key),
    });
  const section = "00000000-1234-1234-1234-123456789abc";
  const id = (i: number) =>
    `${i.toString(16).padStart(8, "0")}-1234-1234-1234-123456789abc`;
  const sections = {
    version: 1,
    sections: Array.from({ length: 100 }, (_, i) => ({
      id: id(i),
      name: "N".repeat(198),
      order: i,
    })),
    assignments: Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [id(i), section]),
    ),
  };
  const channels = (field: "starred" | "muted") => ({
    version: 1,
    channels: Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [
        `${i.toString(16).padStart(8, "0")}-5678-1234-1234-123456789abc`,
        { [field]: true, updatedAt: 1_700_000_000_000 },
      ]),
    ),
  });
  const events = [
    encrypted("channel-sections", sections),
    encrypted("channel-stars", channels("starred")),
    encrypted("channel-mutes", channels("muted")),
    encrypted("channel-sort", { version: 1, groups: { channels: "recent" } }),
  ];
  expect(Buffer.byteLength(JSON.stringify(events))).toBeGreaterThan(256 * 1024);
  const projected = (
    await import("../../../browser-host/sidebar-preferences.mjs")
  ).decodeSidebarPreferences(events, viewer.secret);
  expect(projected.sections).toHaveLength(100);
  expect(Object.keys(projected.assignments)).toHaveLength(1000);
  expect(projected.starred).toHaveLength(500);
  expect(projected.muted).toHaveLength(500);
  expect(projected.sort).toEqual({ channels: "recent" });
  key.fill(0);
});

it("reads legacy preferences through the production session, transport, and bounded broker decoder without publishing", async () => {
  const viewer = keypair(),
    relay = keypair(),
    other = keypair();
  const encrypted = (d: string, value: unknown, author = viewer) =>
    signed(author, {
      kind: 30078,
      tags: [["d", d]],
      content: nip44.v2.encrypt(
        JSON.stringify(value),
        nip44.v2.utils.getConversationKey(author.secret, author.pubkey),
      ),
    });
  const records = [
    encrypted("channel-sections", groups),
    encrypted("channel-stars", stars),
  ];
  let result = records;
  const upstream = vi.fn<typeof fetch>(async (input, init) => {
    expect(String(input)).toBe("https://primary.example/query");
    const filters = JSON.parse(String(init?.body));
    const coordinates = filters.flatMap(
      (filter: { "#d"?: string[] }) => filter["#d"] ?? [],
    );
    if (
      !coordinates.length ||
      coordinates.some((coordinate: string) => coordinate.startsWith("groups:"))
    )
      return Response.json([]);
    return Response.json(
      result.filter((event) =>
        event.tags.some(
          ([key, value]) => key === "d" && coordinates.includes(value),
        ),
      ),
    );
  });
  let handler: RequestListener = () => {};
  const server = createServer((req, res) => handler(req, res));
  const plugin = relayBrokerPlugin({
    archiveFile: ":memory:",
    relayUrl: fixtureRelayUrl,
    communityAliases: fixtureAliases,
    identity: () => viewer.secret.slice(),
    authority: async () => ({ relayAuthor: relay.pubkey }),
    upstreamFetch: upstream,
  });
  await (plugin.configureServer as (server: ViteDevServer) => Promise<void>)({
    httpServer: server,
    config: { logger: { info() {}, error() {} } },
    middlewares: {
      use(callback: RequestListener) {
        handler = callback;
      },
    },
  } as unknown as ViteDevServer);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const nativeFetch = globalThis.fetch;
  // Supply the Origin automatically sent by a same-origin browser POST.
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    nativeFetch(input, {
      ...init,
      headers: { ...init?.headers, Origin: base },
    }),
  );
  const transport = await connectBrokerTransport(base);
  const { subscribe: _subscribe, ...http } = transport;
  const owner = createRelaySession(http);
  const post = (value: unknown, origin = base, route = "sidebar-preferences") =>
    nativeFetch(`${base}/api/relay/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(value),
    });
  try {
    const legacy = await owner.session.sidebarPreferences.read();
    expect(legacy).toEqual({
      ...expected,
      sectionOrder: [],
    });
    expect(workspaceSectionOrder(legacy)).toEqual([
      "pages",
      "solo",
      "starred",
      "group:work",
      "channels",
      "forums",
      "dms",
    ]);
    const reads = upstream.mock.calls.flatMap(([, init]) =>
      (JSON.parse(String(init?.body ?? "[]")) as { "#d"?: string[] }[]).flatMap(
        (filter) => filter["#d"] ?? [],
      ),
    );
    expect(reads).toEqual(
      expect.arrayContaining([
        "channel-sections",
        "channel-workspaces",
        "channel-stars",
        "channel-mutes",
        "channel-sort",
        "channel-filter",
      ]),
    );
    result = [
      ...records,
      encrypted("channel-mutes", {
        version: 1,
        channels: {
          general: { muted: true, updatedAt: 1 },
          removed: { muted: false, updatedAt: 2 },
        },
      }),
      encrypted("channel-sort", { version: 1, groups: { channels: "recent" } }),
    ];
    expect(await owner.session.sidebarPreferences.read()).toEqual({
      ...expected,
      sectionOrder: [],
      muted: ["general"],
      sort: { channels: "recent" },
    });
    const calls = upstream.mock.calls.length;
    const corrupt = { ...records[0], sig: "0".repeat(128) };
    const duplicateTag = signed(viewer, {
      kind: 30078,
      tags: [
        ["d", "channel-sections"],
        ["d", "channel-stars"],
      ],
      content: records[0]?.content ?? "",
    });
    for (const invalid of [
      [encrypted("other-preference", groups)],
      [encrypted("channel-sections", groups, other)],
      [corrupt],
      [records[0], records[0]],
      [duplicateTag],
      [
        signed(viewer, {
          kind: 9,
          tags: [["d", "channel-sections"]],
          content: "no",
        }),
      ],
      [
        signed(viewer, {
          kind: 30078,
          tags: [["d", "channel-sections"]],
          content: "not encrypted",
        }),
      ],
      [encrypted("channel-sections", { ...groups, version: 2 })],
      [
        encrypted("channel-stars", {
          version: 1,
          channels: Object.fromEntries(
            Array.from({ length: 501 }, (_, i) => [
              String(i),
              { starred: true, updatedAt: 1 },
            ]),
          ),
        }),
      ],
    ])
      expect((await post(invalid)).status).toBe(400);
    expect((await post(records, "https://evil.test")).status).toBe(403);
    expect((await post("x".repeat(960 * 1024))).status).toBe(413);
    expect(
      (await post(records, base, "unregistered/sidebar-preferences")).status,
    ).toBe(400);
    expect((await post(records[0], base, "sign")).status).toBe(400);
    expect(upstream).toHaveBeenCalledTimes(calls); // Decode/reject paths add no relay traffic.

    // Hold partial uploads through the real middleware: admission must precede body reading.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const upload = async (body?: string) => {
      const arrived = once(server, "request");
      const outgoing = request(`${base}/api/relay/sidebar-preferences`, {
        method: "POST",
        headers: { Origin: base },
      });
      const response = new Promise<number | undefined>((resolve) => {
        outgoing.on("error", () => resolve(undefined));
        outgoing.on("response", (incoming) => {
          incoming.resume();
          incoming.on("end", () => resolve(incoming.statusCode));
        });
      });
      outgoing.write(body ?? "[");
      if (body !== undefined) outgoing.end();
      const [incoming] = await arrived;
      return { outgoing, incoming, response };
    };
    try {
      const held = [];
      for (let i = 0; i < 2; i++) held.push(await upload());
      expect(await (await upload("[]")).response).toBe(429);
      const first = held[0];
      if (!first) throw new Error("Missing held upload");
      const aborted = new Promise<void>((resolve) =>
        first.incoming.once("close", resolve),
      );
      first.outgoing.destroy();
      await aborted;
      // Oversize and successful completion both return their slot.
      expect(
        await (await upload(JSON.stringify("x".repeat(960 * 1024)))).response,
      ).toBe(413);
      expect(await (await upload("[]")).response).toBe(200);
      const expired = held
        .slice(1)
        .map(({ incoming }) => once(incoming, "close"));
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.all(expired);
      expect(await (await upload("[]")).response).toBe(200);
    } finally {
      vi.useRealTimers();
    }
    result = [];
    expect(await owner.session.sidebarPreferences.read()).toEqual({
      sections: expected.sections,
      assignments: expected.assignments,
      sectionOrder: [],
      starred: [],
      muted: [],
    });
    upstream.mockImplementationOnce(async () =>
      Response.json({ error: "unavailable" }, { status: 503 }),
    );
    await expect(owner.session.sidebarPreferences.read()).rejects.toThrow();
    owner.dispose();
    await expect(owner.session.sidebarPreferences.read()).rejects.toThrow();
  } finally {
    owner.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("does not return a decoded result after caller cancellation or session disposal", async () => {
  let release!: (value: typeof expected) => void;
  const decode = vi.fn(
    () =>
      new Promise<typeof expected>((resolve) => {
        release = resolve;
      }),
  );
  const viewer = keypair(),
    relay = keypair();
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    query: async () => [],
    media: () => undefined,
    decodeSidebarPreferences: decode,
  });
  const pending = owner.session.sidebarPreferences.read();
  await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
  owner.dispose();
  release(expected);
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  const cancel = new AbortController();
  cancel.abort();
  const read = vi.fn(async () => []);
  await expect(
    readSidebarPreferences({ read }, viewer.pubkey, decode, cancel.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
});

it("bounds preference shape, strips orphan assignments, and honors unstar tombstones", () => {
  expect(projectSidebarPreferences(groups, stars)).toEqual(expected);
  expect(() =>
    projectSidebarPreferences(
      { ...groups, sections: Array(101).fill(groups.sections[0]) },
      stars,
    ),
  ).toThrow();
  expect(() =>
    projectSidebarPreferences(
      { ...groups, sections: [{ id: "x", name: "n".repeat(257), order: 0 }] },
      stars,
    ),
  ).toThrow();
  expect(() =>
    projectSidebarPreferences(groups, {
      ...stars,
      channels: { x: { starred: true, updatedAt: -1 } },
    }),
  ).toThrow();
});

it("reports capability absence without querying a host that cannot decode", async () => {
  const query = vi.fn(async () => []);
  const owner = createRelaySession({
    viewer: keypair().pubkey,
    relayAuthor: keypair().pubkey,
    query,
    media: () => undefined,
  });
  try {
    expect(owner.session.sidebarPreferences.available).toBe(false);
    await expect(owner.session.sidebarPreferences.read()).rejects.toThrow(
      "unavailable",
    );
    expect(query).not.toHaveBeenCalled();
  } finally {
    owner.dispose();
  }
});

it("labels query and decoder failures separately while preserving their causes", async () => {
  const signal = new AbortController().signal;
  const unavailable = new Error("Relay read timed out");
  const badDecode = new Error("Local decoder failed (HTTP 400)");
  const decode = vi.fn(async () => {
    throw badDecode;
  });
  await expect(
    readSidebarPreferences(
      {
        read: async () => {
          throw unavailable;
        },
      },
      "viewer",
      decode,
      signal,
    ),
  ).rejects.toMatchObject({
    message: "Preference query: Relay read timed out",
    cause: unavailable,
  });
  expect(decode).not.toHaveBeenCalled();
  await expect(
    readSidebarPreferences({ read: async () => [] }, "viewer", decode, signal),
  ).rejects.toMatchObject({
    message: "Preference decode: Local decoder failed (HTTP 400)",
    cause: badDecode,
  });
});

it.each([false, true])(
  "loads groups and stars without waiting for bulk profiles (labels=%s)",
  async (labels) => {
    vi.useFakeTimers();
    const viewer = keypair(),
      relay = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const decode = vi.fn(async () => expected);
    const owner = createRelaySession({
      ...wire.transport,

      decodeSidebarPreferences: decode,
    });
    try {
      const names = labels
        ? owner.session.profiles
            .ensure(
              Array.from({ length: 1024 }, (_, i) =>
                i.toString(16).padStart(64, "0"),
              ),
              "background",
            )
            .catch(() => {})
        : Promise.resolve();
      const heldProfile = labels ? wire.next() : undefined;
      if (heldProfile) expect(heldProfile.filters[0]?.kinds).toEqual([0]);
      // Actual hook entry point, with the same already-running background work as replay/Retry.
      const preferences = owner.session.sidebarPreferences.read();
      const request = wire.next();
      expect(request.filters[0]?.kinds).toEqual([30078]);
      expect(wire.pending).toHaveLength(0); // Remaining profile batches still yield.

      // Sidebar state must not consume the capacity reserved for opening a conversation.
      const conversation = owner.session.read([
        { kinds: [9], "#h": ["general"], limit: 1 },
      ]);
      const messages = wire.next();
      expect(messages.filters[0]?.kinds).toEqual([9]);
      messages.respond([]);
      await expect(conversation).resolves.toEqual([]);
      await vi.advanceTimersByTimeAsync(2000);
      request.respond([]);
      await expect(preferences).resolves.toEqual(expected);
      expect(decode).toHaveBeenCalledOnce();
      if (heldProfile) expect(heldProfile.signal?.aborted).toBe(false);
      owner.dispose();
      await names;
    } finally {
      owner.dispose();
      vi.useRealTimers();
    }
  },
);

it("recovers once from startup roster invalidation through the same preference read", async () => {
  const viewer = keypair(),
    relay = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const decode = vi.fn(async () => expected);
  const owner = createRelaySession({
    ...wire.transport,
    decodeSidebarPreferences: decode,
  });
  try {
    owner.session.channels.ensureList();
    const discovery = wire.next();
    const first = owner.session.sidebarPreferences.read();
    const preference = wire.next();
    discovery.respond([roster(relay, "general", [viewer.pubkey])]);
    await flush();
    expect(preference.signal?.aborted).toBe(true);
    expect(decode).not.toHaveBeenCalled();
    // Recovery must be owned by the original invocation, not a manual Retry.
    // Optional metadata may already have been dispatched by discovery.
    const retried = wire.pending.find((job) =>
      job.filters.some((filter) => filter.kinds?.includes(30078)),
    );
    expect(retried).toBeDefined();
    retried?.respond([]);
    await expect(first).resolves.toEqual(expected);
  } finally {
    owner.dispose();
  }
});

it("preserves caller and live cancellation while recovering an already-settled access epoch", async () => {
  const viewer = keypair(),
    relay = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    decodeSidebarPreferences: async () => expected,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  try {
    const caller = new AbortController();
    const cleaned = owner.session.sidebarPreferences.read(caller.signal);
    wire.next();
    const cleanup = expect(cleaned).rejects.toMatchObject({
      name: "AbortError",
    });
    caller.abort();
    await cleanup;

    live.state({ status: "connected", routes: [] });
    const interrupted = owner.session.sidebarPreferences.read();
    wire.next();
    const interruption = expect(interrupted).rejects.toMatchObject({
      name: "AbortError",
    });
    live.state({ status: "connecting", routes: [] });
    await interruption;

    // Settle the reader, then change access before readVerified resumes.
    live.receive([roster(relay, "general", [viewer.pubkey])]);
    const stale = owner.session.sidebarPreferences.read();
    wire.next().respond([]);
    queueMicrotask(() =>
      live.receive([roster(relay, "general", [], 1700000001)]),
    );
    await flush();
    wire.next().respond([]);
    await expect(stale).resolves.toEqual(expected);
  } finally {
    owner.dispose();
  }
});

it.each(["access", "caller", "dispose", "cache", "deadline"] as const)(
  "does not retry again after recovery is interrupted by %s",
  async (reason) => {
    const viewer = keypair(),
      relay = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let live!: LiveCallbacks;
    const deadline = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(deadline.signal);
    const caller = new AbortController();
    const decode = vi.fn(async () => expected);
    const owner = createRelaySession({
      ...wire.transport,

      decodeSidebarPreferences: decode,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    });
    try {
      live.receive([roster(relay, "general", [viewer.pubkey])]);
      const pending = owner.session.sidebarPreferences.read(caller.signal);
      const rejected = expect(pending).rejects.toThrow();
      const first = wire.next();
      live.receive([roster(relay, "general", [], 1700000001)]);
      await flush();
      const replacement = wire.next();
      expect(first.signal?.aborted).toBe(true);
      expect(replacement.signal?.aborted).toBe(false);
      expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
      if (reason === "access") {
        live.receive([roster(relay, "general", [viewer.pubkey], 1700000002)]);
        live.receive([roster(relay, "general", [], 1700000003)]);
      } else if (reason === "caller") caller.abort();
      else if (reason === "dispose") owner.dispose();
      else if (reason === "cache") await owner.clearCache();
      else deadline.abort(new DOMException("Timed out", "TimeoutError"));
      await rejected;
      expect(replacement.signal?.aborted).toBe(true);
      expect(wire.pending).toHaveLength(0);
      expect(decode).not.toHaveBeenCalled();
      expect(timeout).toHaveBeenCalledTimes(1); // Recovery never resets the outer deadline.
    } finally {
      owner.dispose();
      timeout.mockRestore();
    }
  },
);

it.each([
  "cache",
  "caller",
  "dispose",
  "deadline",
  "denied",
  "quota",
  "network",
  "abort",
] as const)(
  "does not recover a first query cancelled or failed by %s",
  async (reason) => {
    const viewer = keypair(),
      relay = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let live!: LiveCallbacks;
    const deadline = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(deadline.signal);
    const caller = new AbortController();
    const decode = vi.fn(async () => expected);
    const owner = createRelaySession({
      ...wire.transport,

      decodeSidebarPreferences: decode,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    });
    try {
      live.receive([roster(relay, "general", [viewer.pubkey])]);
      const pending = owner.session.sidebarPreferences.read(caller.signal);
      const rejected = expect(pending).rejects.toThrow();
      const first = wire.next();
      if (["cache", "caller", "dispose", "deadline"].includes(reason)) {
        // Even when access loss coincides, explicit cancellation must win.
        live.receive([roster(relay, "general", [], 1700000001)]);
        if (reason === "cache") await owner.clearCache();
        else if (reason === "caller") caller.abort();
        else if (reason === "dispose") owner.dispose();
        else deadline.abort(new DOMException("Timed out", "TimeoutError"));
      } else {
        first.fail(
          reason === "denied"
            ? new ReadError("denied", "Denied", 403)
            : reason === "quota"
              ? new ReadError("unavailable", "Quota", 429, 8000)
              : reason === "network"
                ? new Error("Network failed")
                : new DOMException("Adapter aborted", "AbortError"),
        );
      }
      await rejected;
      expect(wire.pending).toHaveLength(0);
      expect(decode).not.toHaveBeenCalled();
      expect(timeout).toHaveBeenCalledTimes(1);
    } finally {
      owner.dispose();
      timeout.mockRestore();
    }
  },
);

it("writer reconciliation cannot join an older in-flight preference read", async () => {
  const read = vi.fn(async () => []);
  const decode = vi.fn(async () => expected);
  const signal = new AbortController().signal;
  await readSidebarPreferences({ read }, "viewer", decode, signal, "strong");
  expect(read).toHaveBeenCalledWith(
    expect.arrayContaining([
      expect.objectContaining({ consistency: "strong" }),
    ]),
    { signal, priority: "foreground", fresh: true },
  );
});

it("admits only the complete bounded sidebar batch beyond the normal reader limit", async () => {
  const { SIDEBAR_COORDINATES, isSidebarPreferencesBatch } = await import(
    "./sidebar-preferences"
  );
  const filters = SIDEBAR_COORDINATES.map((coordinate) => ({
    kinds: [30078],
    authors: ["viewer"],
    "#d": [coordinate],
    limit: 1,
  }));
  expect(isSidebarPreferencesBatch(filters)).toBe(true);
  expect(
    isSidebarPreferencesBatch(
      filters.map((filter) => ({ ...filter, consistency: "strong" })),
    ),
  ).toBe(true);
  expect(
    isSidebarPreferencesBatch(
      filters.map((filter) => ({
        ...filter,
        consistency: "weak",
      })) as unknown as typeof filters,
    ),
  ).toBe(false);
  expect(
    isSidebarPreferencesBatch(
      filters.map((filter) => ({
        ...filter,
        consistency: true,
      })) as unknown as typeof filters,
    ),
  ).toBe(false);
  expect(isSidebarPreferencesBatch(filters.slice(1))).toBe(false);
  expect(
    isSidebarPreferencesBatch([
      ...filters.slice(0, 4),
      filters[0] as (typeof filters)[number],
    ]),
  ).toBe(false);
  for (const changed of [
    { limit: 2 },
    { kinds: [9] },
    { authors: ["other"] },
    { "#d": ["unknown"] },
    { since: 1 },
  ])
    expect(
      isSidebarPreferencesBatch([
        { ...(filters[0] as (typeof filters)[number]), ...changed },
        ...filters.slice(1),
      ]),
    ).toBe(false);
});

it("projects bounded optional activity windows without changing legacy mode decoding", () => {
  const project = (activeWindowSeconds?: unknown) =>
    projectSidebarPreferences(
      undefined,
      undefined,
      undefined,
      undefined,
      ["work"],
      { version: 1, groups: { channels: "active" }, activeWindowSeconds },
    );
  expect(project().filters).toEqual({ channels: "active" });
  expect(project().activeWindowSeconds).toEqual({});
  expect(
    project({
      channels: 604800,
      "section:work": 31536000,
      "section:removed": 86400,
    }).activeWindowSeconds,
  ).toEqual({ channels: 604800, "section:work": 31536000 });
  for (const value of [0, -86400, 86401, 1.5, "604800", null, 31622400])
    expect(() => project({ channels: value })).toThrow(
      "Invalid sidebar activity window",
    );
  expect(() =>
    project(
      Object.fromEntries(
        Array.from({ length: 105 }, (_, i) => [`section:${i}`, 86400]),
      ),
    ),
  ).toThrow("Invalid sidebar activity window");
});
