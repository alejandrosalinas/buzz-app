import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import type { HeadPersistence, SavedHead, SavedStartup } from "./persistence";
import type { ReadTransport } from "./transport";
import { ReadError } from "./errors";
import { bounds, keypair, message, metadata, roster, signed } from "./testing";
import { eventDto, type RelayEvent } from "./events";
import { provideRelay } from "./service";

const storage = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("./persistence", () => ({ createHeadPersistence: storage.create }));
const native = vi.hoisted(() => ({
  clear: vi.fn(async () => {}),
  enabled: vi.fn(() => false),
}));
vi.mock("../identity/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../identity/service")>()),
  nativeIdentityEnabled: native.enabled,
}));
const images = vi.hoisted(() => ({ retry: vi.fn() }));
vi.mock("../../shared/design-system/useReadyImage", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../shared/design-system/useReadyImage")
  >()),
  retryFailedImages: images.retry,
}));
vi.mock("./native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native")>()),
  clearNativeMedia: native.clear,
  nativeMediaUrl: (url: string) => `native:${url}`,
}));
const roots: Context[] = [];
afterEach(async () => {
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose();
  vi.useRealTimers();
  native.enabled.mockReset().mockReturnValue(false);
});
/** A signature no JavaScript check accepts; only a stubbed host admits it. */
const FORGED = "0".repeat(128);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup({
  saved = true,
  profiles = [],
  headProfiles = [],
  verifyStored,
  relay = keypair(),
  verifiedProfiles,
  forged = false,
  origin = "primary",
}: {
  saved?: boolean;
  profiles?: unknown[];
  headProfiles?: unknown[];
  verifyStored?: ReadTransport["verifyStored"];
  relay?: ReturnType<typeof keypair>;
  verifiedProfiles?: unknown;
  /** Give the saved history message a signature only a host could accept. */
  forged?: boolean;
  origin?: string;
} = {}) {
  const viewer = keypair();
  const events = [
    roster(relay, "alpha", [viewer.pubkey]),
    metadata(relay, "alpha", "Alpha"),
  ];
  let startup: SavedStartup | undefined = saved
    ? {
        discovery: { savedAt: Date.now(), relayAuthor: relay.pubkey, events },
        ...(verifiedProfiles ? { verifiedProfiles } : {}),
      }
    : undefined;
  let heads: SavedHead[] = !saved
    ? []
    : [
        {
          channelId: "alpha",
          savedAt: Date.now(),
          profiles: headProfiles,
          events: [
            forged
              ? {
                  ...message(viewer, "alpha", "Saved history", 20),
                  sig: FORGED,
                }
              : message(viewer, "alpha", "Saved history", 20),
            bounds(relay, "alpha", "head", {
              has_more: false,
              next_cursor: null,
            }),
          ],
        },
      ];
  const disk: HeadPersistence = {
    readProfiles: async () => structuredClone(profiles),
    readStartup: vi.fn(async () => structuredClone(startup)),
    writeStartup: vi.fn(async (patch) => {
      startup = { ...startup, ...structuredClone(patch) };
    }),
    read: vi.fn(async () => structuredClone(heads)),
    write: vi.fn(async () => {}),
    remove: vi.fn(async (id) => {
      heads = heads.filter((h) => h.channelId !== id);
    }),
    retain: vi.fn(async (ids) => {
      heads = heads.filter((h) => ids.includes(h.channelId));
    }),
    clear: vi.fn(async () => {
      startup = undefined;
      heads = [];
    }),
    close: vi.fn(),
  };
  storage.create.mockImplementation(() => disk);
  const connections: ReturnType<typeof deferred<ReadTransport>>[] = [];
  const ctx = new Context();
  roots.push(ctx);
  const source: ReadTransport = {
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    scope: "primary",
    media: () => undefined,
    query: vi.fn(async (filters: readonly import("./events").ReadFilter[]) =>
      filters.some((f) => f.kinds?.includes(39002)) ? events : [],
    ),
  };
  const data = provideRelay(
    ctx,
    () => {
      const request = deferred<ReadTransport>();
      connections.push(request);
      return request.promise;
    },
    undefined,
    undefined,
    undefined,
    { viewer: viewer.pubkey, scope: origin },
    undefined,
    verifyStored,
  );
  const restored = async () => {
    await vi.waitFor(() => expect(data.snapshot().cached).toBe(true));
    data.snapshot().session.channels.ensure("alpha");
    expect(
      data.snapshot().session.channels.window("alpha").rows[0]?.content,
    ).toBe("Saved history");
    return data.snapshot();
  };
  return { ctx, data, disk, connections, source, restored };
}
it.each(["profile mirror", "discovery", "history", "head profiles"])(
  "waits for host verification of cached %s before publishing while offline",
  async (stage) => {
    const profile = signed(keypair(), {
      kind: 0,
      tags: [],
      content: JSON.stringify({ name: "Saved member" }),
    });
    const checking = deferred<void>();
    const kind = stage === "discovery" ? 39002 : stage === "history" ? 9 : 0;
    const holds = (values: readonly unknown[]) =>
      values.some((value) => (value as { kind: number }).kind === kind);
    const verifyStored = vi.fn(async (values: readonly unknown[]) => {
      if (holds(values)) await checking.promise;
      return values.map((value) => eventDto(JSON.parse(JSON.stringify(value))));
    });
    const { data, restored, source } = setup({
      profiles: stage === "profile mirror" ? [profile] : [],
      headProfiles: stage === "head profiles" ? [profile] : [],
      verifyStored,
    });
    try {
      await vi.waitFor(() =>
        expect(verifyStored.mock.calls.some(([values]) => holds(values))).toBe(
          true,
        ),
      );
      expect(data.snapshot().cached).toBeUndefined();
    } finally {
      checking.resolve();
    }
    const snapshot = await restored();
    if (kind === 0)
      expect(
        snapshot.session.profiles.snapshot().get(profile.pubkey)?.name,
      ).toBe("Saved member");
    expect(snapshot.status).toBe("connecting");
    expect(source.query).not.toHaveBeenCalled();
  },
);
it.each([false, true])(
  "shows saved avatars offline with the URLs the connection will use (native=%s)",
  async (enabled) => {
    native.enabled.mockReturnValue(enabled);
    const origin = "https://relay.example.org";
    const { restored } = setup({ origin });
    const { session } = await restored();
    const hash = "a".repeat(64);
    expect(session.media(`${origin}/media/${hash}.png`, "small")).toBe(
      enabled ? `native:${origin}/media/${hash}.thumb.webp` : undefined,
    );
    expect(session.media("https://cdn.example.org/a.png")).toBe(
      "https://cdn.example.org/a.png",
    );
  },
);
it("asks failed images to load again once the connection replaces the restored session", async () => {
  images.retry.mockClear();
  const { data, connections, source, restored } = setup();
  await restored();
  expect(images.retry).not.toHaveBeenCalled();
  connections[0]?.resolve(source);
  await vi.waitFor(() => expect(data.snapshot().status).toBe("ready"));
  expect(images.retry).toHaveBeenCalledOnce();
});
it.each([false, true])(
  "restores valid cached profiles with JS when host verification fails or is absent (host=%s)",
  async (host) => {
    const profile = signed(keypair(), {
      kind: 0,
      tags: [],
      content: JSON.stringify({ name: "Saved member" }),
    });
    const invalid = {
      ...profile,
      content: JSON.stringify({ name: "Changed bytes" }),
    };
    const embedded = signed(keypair(), {
      kind: 0,
      tags: [],
      content: JSON.stringify({ name: "History author" }),
    });
    const verifyStored = host
      ? vi.fn(async () => {
          throw new Error("Host unavailable");
        })
      : undefined;
    const { restored } = setup({
      profiles: [invalid, profile],
      headProfiles: [profile, embedded],
      verifyStored,
    });
    const snapshot = await restored();
    expect(snapshot.session.profiles.snapshot().get(profile.pubkey)?.name).toBe(
      "Saved member",
    );
    expect(
      snapshot.session.profiles.snapshot().get(embedded.pubkey)?.name,
    ).toBe("History author");
    if (verifyStored) expect(verifyStored).toHaveBeenCalled();
  },
);
it("restores cached discovery, history and head profiles from the host's answer alone", async () => {
  // Only the host's result can admit these records: JS rejects their signatures.
  const profile = {
    ...signed(keypair(), {
      kind: 0,
      tags: [],
      content: JSON.stringify({ name: "Saved member" }),
    }),
    sig: FORGED,
  };
  const verifyStored = vi.fn(async (values: readonly unknown[]) =>
    values.map((value) => structuredClone(value) as RelayEvent),
  );
  const { restored } = setup({
    forged: true,
    headProfiles: [profile],
    verifyStored,
  });
  const snapshot = await restored();
  expect(snapshot.session.profiles.snapshot().get(profile.pubkey)?.name).toBe(
    "Saved member",
  );
  for (const kind of [39002, 9, 0])
    expect(
      verifyStored.mock.calls.some(([values]) =>
        values.some((value) => (value as RelayEvent).kind === kind),
      ),
    ).toBe(true);
});
it.each(["history", "head profiles"])(
  "drops a cached head whose %s the host rejects",
  async (stage) => {
    const profile = signed(keypair(), {
      kind: 0,
      tags: [],
      content: JSON.stringify({ name: "Saved member" }),
    });
    const verifyStored = vi.fn(async (values: readonly unknown[]) => {
      if (values.some((value) => (value as RelayEvent).sig === FORGED))
        throw new Error("Relay supplied a malformed or invalidly signed event");
      return values.map((value) => eventDto(JSON.parse(JSON.stringify(value))));
    });
    const { data } = setup({
      forged: stage === "history",
      headProfiles: [
        stage === "head profiles" ? { ...profile, sig: FORGED } : profile,
      ],
      verifyStored,
    });
    await vi.waitFor(() => expect(data.snapshot().cached).toBe(true));
    data.snapshot().session.channels.ensure("alpha");
    expect(data.snapshot().session.channels.window("alpha").rows).toEqual([]);
    expect(
      data.snapshot().session.profiles.snapshot().get(profile.pubkey),
    ).toBeUndefined();
  },
);
it.each([
  ["the saved authority", true],
  ["no saved authority", false],
])("shows saved verified names while offline with %s", async (_, saved) => {
  const relay = keypair(),
    alice = keypair();
  const head = signed(relay, {
    kind: 30382,
    content: "",
    tags: [
      ["d", alice.pubkey],
      ["p", alice.pubkey],
      ["active", "true"],
      ["display_name", "Alice"],
      ["username", "alice"],
      ["issuer_label", "Example"],
      ["verified_at", "1700000000"],
    ],
  });
  const self = signed(alice, {
    kind: 0,
    tags: [],
    content: JSON.stringify({ name: "Self-chosen" }),
  });
  const { restored } = setup({
    relay,
    profiles: [self, head],
    ...(saved
      ? {
          verifiedProfiles: {
            pubkey: relay.pubkey,
            multipleIssuers: false,
          },
        }
      : {}),
  });
  const snapshot = await restored();
  expect(snapshot.session.profiles.snapshot().get(alice.pubkey)).toMatchObject(
    saved
      ? { name: "Alice", verified: { status: "cached" } }
      : { name: "Self-chosen" },
  );
});
it("resumes and connects one partition: heads keep `viewer:origin`, snapshots `origin:viewer`", async () => {
  const { data, connections, source, restored } = setup();
  const viewer = source.viewer;
  expect((await restored()).scope).toBe(`primary:${viewer}`);
  await vi.waitFor(() => expect(connections).toHaveLength(1));
  connections[0]?.resolve(source);
  await vi.waitFor(() => expect(data.snapshot().status).toBe("ready"));
  expect(data.snapshot().scope).toBe(`primary:${viewer}`);
  // Resume and the live session open the same head partition argument order.
  expect(storage.create.mock.calls).toEqual([
    [viewer, "primary"],
    [viewer, "primary"],
  ]);
});
it("retains a timed-out cached startup, rejects the late handshake and promotes a retry without changing generation", async () => {
  vi.useFakeTimers();
  const { data, connections, source, restored } = setup();
  const before = await restored();
  await vi.advanceTimersByTimeAsync(8_001);
  expect(data.snapshot()).toMatchObject({
    status: "error",
    cached: true,
    error: expect.stringContaining("timed out"),
    // A timeout reconnects by itself; navigation waits instead of failing.
    retrying: true,
  });
  data.retry();
  expect(data.snapshot().retrying).toBeUndefined();
  await vi.waitFor(() => expect(connections).toHaveLength(2));
  connections[0]?.resolve(source);
  await vi.advanceTimersByTimeAsync(10);
  expect(data.snapshot().session).toBe(before.session);
  connections[1]?.resolve(source);
  await vi.waitFor(() => expect(data.snapshot().cached).toBeUndefined());
  expect(data.snapshot().generation).toBe(before.generation);
  expect(data.snapshot().scope).toBe(before.scope);
  expect(data.snapshot().session).not.toBe(before.session);
  expect(
    data.snapshot().session.channels.window("alpha").rows[0]?.content,
  ).toBe("Saved history");
});
it("bootstraps from disk behind the launch surface only once, not on retries after a failure", async () => {
  vi.useFakeTimers();
  const { data } = setup({ saved: false });
  expect(data.snapshot()).toMatchObject({
    status: "connecting",
    restoring: true,
  });
  await vi.advanceTimersByTimeAsync(8_001);
  expect(data.snapshot()).toMatchObject({ status: "error", retrying: true });
  // Both the automatic reconnect and Try again keep the app on screen.
  await vi.advanceTimersByTimeAsync(1_000);
  expect(data.snapshot().status).toBe("connecting");
  expect(data.snapshot().restoring).toBeUndefined();
  await vi.advanceTimersByTimeAsync(8_001);
  expect(data.snapshot().status).toBe("error");
  data.retry();
  expect(data.snapshot().status).toBe("connecting");
  expect(data.snapshot().restoring).toBeUndefined();
});
it("explicit handshake denial purges saved history instead of retaining offline content", async () => {
  const { data, disk, connections, restored } = setup();
  await restored();
  connections[0]?.reject(new ReadError("denied", "Removed"));
  await vi.waitFor(() => expect(data.snapshot().status).toBe("error"));
  expect(data.snapshot().cached).toBeUndefined();
  expect(data.snapshot().retrying).toBeUndefined();
  // Pages explain a refusal as access, not as the connection.
  expect(data.snapshot().denied).toBe(true);
  expect(data.snapshot().session.channels.list().channels).toEqual([]);
  expect(await disk.readStartup?.()).toBeUndefined();
  expect(await disk.read()).toEqual([]);
});
it.each([
  [
    "an access refusal forgets",
    "restricted: authorization denied",
    [["primary"]],
  ],
  ["a sign-in refusal keeps", "auth-required: authentication required", []],
])("%s this community's saved images", async (_, message, cleared) => {
  const { data, connections, restored } = setup();
  await restored();
  native.clear.mockClear();
  connections[0]?.reject(new ReadError("denied", message));
  await vi.waitFor(() => expect(data.snapshot().status).toBe("error"));
  expect(native.clear.mock.calls).toEqual(cleared);
});
it("clearing during successor hydration fences the old result and clears next-launch records", async () => {
  const { data, disk, connections, source, restored } = setup();
  await restored();
  const stale = await disk.read();
  const hydration = deferred<SavedHead[]>();
  vi.mocked(disk.read).mockReturnValueOnce(hydration.promise);
  connections[0]?.resolve(source);
  await vi.waitFor(() => expect(disk.read).toHaveBeenCalledTimes(3));
  native.clear.mockClear();
  await data.clearCache();
  expect(native.clear.mock.calls).toEqual([["primary"]]);
  hydration.resolve(stale);
  await vi.waitFor(() => expect(connections).toHaveLength(2));
  expect(data.snapshot().session.channels.list().channels).toEqual([]);
  expect(data.snapshot().session.channels.window("alpha").rows).toEqual([]);
  expect(await disk.readStartup?.()).toBeUndefined();
  expect(await disk.read()).toEqual([]);
});
it("a different viewer or relay scope does not receive retained cached windows", async () => {
  const { data, connections, source, restored } = setup();
  const before = await restored();
  storage.create.mockImplementation(() => ({
    read: async () => [],
    readStartup: async () => undefined,
    close() {},
  }));
  connections[0]?.resolve({
    ...source,
    viewer: keypair().pubkey,
    scope: "other",
    query: async () => [],
  });
  await vi.waitFor(() => expect(data.snapshot().cached).toBeUndefined());
  expect(data.snapshot().scope).not.toBe(before.scope);
  expect(data.snapshot().session.channels.window("alpha").rows).toEqual([]);
});
it("disposal while local storage is still reading never publishes the restored session", async () => {
  const { ctx, data, disk, connections, source } = setup();
  const saved = await disk.readStartup?.();
  // The service has started its initial read; hold the session's subsequent reads.
  const reading = deferred<SavedStartup | undefined>();
  if (!disk.readStartup) throw new Error("Missing startup reader");
  vi.mocked(disk.readStartup).mockReturnValue(reading.promise);
  await ctx.fiber.dispose();
  const snapshot = data.snapshot();
  reading.resolve(saved);
  connections[0]?.resolve(source);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(data.snapshot()).toBe(snapshot);
});

it.each(["success", "failure"])(
  "cache clear blocks retries after aborted connection %s settles",
  async (outcome) => {
    const { data, disk, connections, source, restored } = setup();
    await restored();
    const gate = deferred<void>();
    const erase = disk.clear.bind(disk);
    vi.mocked(disk.clear).mockImplementationOnce(async () => {
      await gate.promise;
      await erase();
    });
    const cleared = data.clearCache();
    expect(data.clearCache()).toBe(cleared);
    await vi.waitFor(() => expect(disk.clear).toHaveBeenCalled());
    if (outcome === "success") connections[0]?.resolve(source);
    else connections[0]?.reject(new Error("aborted connection failed"));
    // Drain the connection's then/catch/finally before attempting retry.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    data.retry();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(connections).toHaveLength(1);
    expect(data.snapshot().session.channels.window("alpha").rows).toEqual([]);
    gate.resolve();
    await cleared;
    await vi.waitFor(() => expect(connections).toHaveLength(2));
    connections[1]?.resolve(source);
    await vi.waitFor(() => expect(data.snapshot().status).toBe("ready"));
    expect(data.snapshot().session.channels.window("alpha").rows).toEqual([]);
    expect(await disk.read()).toEqual([]);
  },
);
it.each([
  ["saved images", () => native.clear],
  ["saved records", (disk: HeadPersistence) => vi.mocked(disk.clear)],
])(
  "a clear that can't forget %s clears the rest and then fails",
  async (_, failing) => {
    const { data, disk, restored } = setup();
    await restored();
    failing(disk).mockRejectedValueOnce(new Error("busy"));
    await expect(data.clearCache()).rejects.toThrow();
    expect(native.clear).toHaveBeenCalledWith("primary");
    expect(data.snapshot().session.channels.list().channels).toEqual([]);
    await expect(data.clearCache()).resolves.toBeUndefined();
    expect(await disk.read()).toEqual([]);
  },
);
it("disconnect during a coalesced cache clear does not reconnect", async () => {
  const { data, disk, connections, restored } = setup();
  await restored();
  const gate = deferred<void>();
  vi.mocked(disk.clear).mockImplementationOnce(() => gate.promise);
  const cleared = data.clearCache();
  await vi.waitFor(() => expect(disk.clear).toHaveBeenCalled());
  data.disconnect();
  gate.resolve();
  await cleared;
  expect(data.snapshot().status).toBe("disconnected");
  expect(connections).toHaveLength(1);
});
it.each([
  ["at once", false],
  ["after its first attempt times out", true],
])(
  "reload reads a fresh saved head from the relay again %s",
  async (_, timesOut) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const relay = keypair();
    const { data, connections, source, restored } = setup({ relay });
    const author = keypair();
    await restored();
    connections[0]?.resolve(source);
    await vi.waitFor(() =>
      expect(data.snapshot()).toMatchObject({ status: "ready" }),
    );
    expect(data.snapshot().cached).toBeUndefined();
    const before = data.snapshot();
    // The saved head is fresh, so the live session showed it without asking.
    expect(before.session.channels.window("alpha").rows[0]?.content).toBe(
      "Saved history",
    );
    const headQuery = vi.mocked(source.query);
    headQuery.mockImplementation(async (filters) =>
      filters.some((f) => f.kinds?.includes(39002))
        ? [
            roster(relay, "alpha", [source.viewer]),
            metadata(relay, "alpha", "Alpha"),
          ]
        : filters.some((f) => f["#h"]?.includes("alpha"))
          ? [
              message(author, "alpha", "Relay reply", 30),
              bounds(relay, "alpha", "head", {
                has_more: false,
                next_cursor: null,
              }),
            ]
          : [],
    );

    data.reload();
    expect(data.snapshot()).toMatchObject({
      status: "connecting",
      reloading: true,
    });
    await vi.waitFor(() => expect(connections).toHaveLength(2));
    expect(data.snapshot().restoring).toBeUndefined();
    expect(data.snapshot().generation).toBeGreaterThan(before.generation);
    if (timesOut) {
      await vi.advanceTimersByTimeAsync(8_001);
      expect(data.snapshot()).toMatchObject({
        status: "error",
        retrying: true,
        reloading: true,
      });
      // Its automatic retry is still the reload.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(data.snapshot()).toMatchObject({
        status: "connecting",
        reloading: true,
      });
      await vi.waitFor(() => expect(connections).toHaveLength(3));
    }
    connections.at(-1)?.resolve(source);
    await vi.waitFor(() =>
      expect(
        data.snapshot().session.channels.window("alpha").rows[0]?.content,
      ).toBe("Relay reply"),
    );
    expect(data.snapshot()).toMatchObject({ status: "ready" });
    expect(data.snapshot().reloading).toBeUndefined();
    expect(data.snapshot().session).not.toBe(before.session);
  },
);
it("reload keeps its state through a denial until disconnected, and does nothing once disconnected", async () => {
  const { data, connections, source, restored } = setup();
  await restored();
  connections[0]?.resolve(source);
  await vi.waitFor(() => expect(data.snapshot().status).toBe("ready"));
  data.reload();
  await vi.waitFor(() => expect(connections).toHaveLength(2));
  connections.at(-1)?.reject(new ReadError("denied", "Removed"));
  await vi.waitFor(() =>
    expect(data.snapshot()).toMatchObject({
      status: "error",
      denied: true,
      reloading: true,
    }),
  );
  data.disconnect();
  expect(data.snapshot().reloading).toBeUndefined();
  const count = connections.length;
  data.reload();
  expect(data.snapshot().status).toBe("disconnected");
  expect(connections).toHaveLength(count);
});
it("reload keeps a channel to reopen through a second reload before its roster answers", async () => {
  const relay = keypair();
  const { data, connections, source, restored } = setup({ relay });
  await restored();
  connections[0]?.resolve(source);
  await vi.waitFor(() => expect(data.snapshot().status).toBe("ready"));
  const query = vi.mocked(source.query);
  const rosterRead = (filters: readonly import("./events").ReadFilter[]) =>
    filters.some((f) => f.kinds?.includes(39002));
  const fallback = async (filters: readonly import("./events").ReadFilter[]) =>
    rosterRead(filters)
      ? [
          roster(relay, "alpha", [source.viewer]),
          metadata(relay, "alpha", "Alpha"),
          roster(relay, "beta", [source.viewer]),
          metadata(relay, "beta", "Beta"),
        ]
      : filters.some((f) => f["#h"]?.includes("beta"))
        ? [
            bounds(relay, "beta", "head", {
              has_more: false,
              next_cursor: null,
            }),
          ]
        : [];
  query.mockImplementation(fallback);
  const { channels } = data.snapshot().session;
  channels.refreshList?.();
  await vi.waitFor(() => expect(channels.get?.("beta")).toBeDefined());
  // Beta is open in the background; alpha stays the selected channel.
  channels.ensure("beta");
  channels.ensure("alpha");
  query.mockImplementation(async (filters) => {
    if (rosterRead(filters)) return new Promise(() => {});
    return fallback(filters);
  });
  data.reload();
  await vi.waitFor(() => expect(connections).toHaveLength(2));
  connections.at(-1)?.resolve(source);
  await vi.waitFor(() => expect(data.snapshot().status).toBe("ready"));
  expect(data.snapshot().session.channels.list().status).toBe("loading");
  // Another reload before the roster answers still carries beta.
  query.mockImplementation(fallback);
  data.reload();
  await vi.waitFor(() => expect(connections).toHaveLength(3));
  connections.at(-1)?.resolve(source);
  await vi.waitFor(() =>
    expect(data.snapshot().session.channels.window("beta").status).toBe(
      "ready",
    ),
  );
});
it.each([
  ["a later roster page", "paged"],
  ["the retry after a roster error", "failed"],
] as const)(
  "reload reopens a channel the new roster first authorizes in %s",
  async (_, mode) => {
    const relay = keypair();
    const { data, connections, source, restored } = setup({ relay });
    await restored();
    connections[0]?.resolve(source);
    await vi.waitFor(() => expect(data.snapshot().status).toBe("ready"));
    const query = vi.mocked(source.query);
    const rosterRead = (filters: readonly import("./events").ReadFilter[]) =>
      filters.some((f) => f.kinds?.includes(39002));
    const beta = [
      roster(relay, "beta", [source.viewer], 1_600_000_000),
      metadata(relay, "beta", "Beta", 1_600_000_000),
    ];
    const head = (filters: readonly import("./events").ReadFilter[]) =>
      filters.some((f) => f["#h"]?.includes("beta"))
        ? [
            bounds(relay, "beta", "head", {
              has_more: false,
              next_cursor: null,
            }),
          ]
        : [];
    query.mockImplementation(async (filters) =>
      rosterRead(filters)
        ? [
            roster(relay, "alpha", [source.viewer]),
            roster(relay, "gamma", [source.viewer]),
            ...beta,
          ]
        : head(filters),
    );
    const { channels } = data.snapshot().session;
    channels.refreshList?.();
    await vi.waitFor(() => expect(channels.get?.("gamma")).toBeDefined());
    channels.ensure("gamma");
    channels.ensure("beta");
    channels.ensure("alpha");
    // A full first page with beta's and gamma's metadata but not their
    // rosters, so both stay closed until a later page or a retry: it brings
    // beta's roster, and no longer lists gamma.
    const firstPage = [
      metadata(relay, "beta", "Beta", 1_600_000_000),
      metadata(relay, "gamma", "Gamma", 1_600_000_000),
      ...Array.from({ length: 500 }, (_, index) =>
        roster(
          relay,
          `filler-${index}`,
          [source.viewer],
          1_700_000_000 - index,
        ),
      ),
    ];
    let failed = false;
    let release = () => {};
    const later = new Promise<void>((resolve) => (release = resolve));
    query.mockImplementation(async (filters) => {
      if (!rosterRead(filters)) return head(filters);
      if (!filters.some((f) => f.until !== undefined)) return firstPage;
      if (mode === "failed" && !failed) {
        failed = true;
        throw new ReadError("unavailable", "Down");
      }
      await later;
      return beta;
    });
    const reloadCalls = query.mock.calls.length;
    data.reload();
    await vi.waitFor(() => expect(connections).toHaveLength(2));
    connections.at(-1)?.resolve(source);
    const next = () => data.snapshot().session.channels;
    await vi.waitFor(() => expect(next().get?.("filler-0")).toBeDefined());
    expect(next().window("beta").status).toBe("idle");
    if (mode === "failed") {
      await vi.waitFor(() => expect(next().list().status).toBe("error"));
      next().ensureList();
    }
    release();
    // Reopened, it reads its head from the new session.
    await vi.waitFor(() =>
      expect(
        query.mock.calls
          .slice(reloadCalls)
          .some(([filters]) => filters.some((f) => f["#h"]?.includes("beta"))),
      ).toBe(true),
    );
    // The complete roster left gamma out, so a later reload does not carry
    // it, even once gamma is the viewer's again.
    await vi.waitFor(() => expect(next().list().rosterAsOf).toBeDefined());
    query.mockImplementation(async (filters) =>
      rosterRead(filters)
        ? [roster(relay, "gamma", [source.viewer]), ...beta]
        : filters.some((f) => f["#h"]?.includes("gamma"))
          ? [
              bounds(relay, "gamma", "head", {
                has_more: false,
                next_cursor: null,
              }),
            ]
          : head(filters),
    );
    const secondCalls = query.mock.calls.length;
    data.reload();
    await vi.waitFor(() => expect(connections).toHaveLength(3));
    connections.at(-1)?.resolve(source);
    await vi.waitFor(() => expect(next().get?.("gamma")).toBeDefined());
    await vi.waitFor(() =>
      expect(
        query.mock.calls
          .slice(secondCalls)
          .some(([filters]) => filters.some((f) => f["#h"]?.includes("beta"))),
      ).toBe(true),
    );
    expect(
      query.mock.calls
        .slice(secondCalls)
        .some(([filters]) => filters.some((f) => f["#h"]?.includes("gamma"))),
    ).toBe(false);
  },
);
