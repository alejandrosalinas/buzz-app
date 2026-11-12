import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { createSidebarPreferencesStore } from "./sidebar-preferences-store";
import { byteSize } from "./budget";
import { DiscoveryState } from "./discovery";
import { ReadError } from "./errors";
import type { HeadPersistence, SavedHead, SavedStartup } from "./persistence";
import {
  bounds,
  hostSigner,
  keypair,
  message,
  metadata,
  nativeSignatureChecks,
  roster,
  profile,
} from "./testing";
import { connectSignedTransport } from "./transport";
import type { RelayEvent } from "./events";
import type { SidebarPreferences } from "./sidebar-preferences";
import { readJournal, type ReadJournal } from "./read-state-storage";

const viewer = keypair(),
  relay = keypair();
const discovery = [
  roster(relay, "alpha", [viewer.pubkey]),
  metadata(relay, "alpha", "Alpha"),
];
const head = (content: string) => [
  message(viewer, "alpha", content, 20),
  bounds(relay, "alpha", "head", { has_more: false, next_cursor: null }),
];
const preferences: SidebarPreferences = {
  sections: [{ id: "work", name: "Work", order: 0 }],
  assignments: { alpha: "work" },
  starred: [],
  muted: [],
  sort: {},
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function disk() {
  let startup: SavedStartup | undefined = {
    discovery: {
      savedAt: Date.now(),
      relayAuthor: relay.pubkey,
      events: discovery,
    },
    preferences: { savedAt: Date.now(), data: preferences },
  };
  let heads: SavedHead[] = [
    {
      channelId: "alpha",
      savedAt: Date.now(),
      events: head("saved"),
      profiles: [],
    },
  ];
  let profiles: unknown[] = [];
  const storage: HeadPersistence = {
    readStartup: vi.fn(async () => structuredClone(startup)),
    writeStartup: vi.fn(async (patch) => {
      startup = { ...startup, ...structuredClone(patch) };
    }),
    readProfiles: vi.fn(async () => structuredClone(profiles)),
    writeProfiles: vi.fn(async (events) => {
      profiles = structuredClone([...events]);
    }),
    read: vi.fn(async () => structuredClone(heads)),
    write: vi.fn(async (value) => {
      heads = [structuredClone(value)];
    }),
    retain: vi.fn(async (ids) => {
      heads = heads.filter((row) => ids.includes(row.channelId));
    }),
    remove: vi.fn(async (id) => {
      heads = heads.filter((row) => row.channelId !== id);
    }),
    clear: vi.fn(async () => {
      startup = undefined;
      heads = [];
      profiles = [];
    }),
    close: vi.fn(),
  };
  return storage;
}
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function setup(
  storage = disk(),
  cachedOnly = false,
  initialChannelId?: string,
  readIntent = false,
  maxDiscoveryBytes?: number,
) {
  let journal: ReadJournal | undefined;
  const membership = deferred<RelayEvent[]>();
  const query = vi.fn(
    async (filters: readonly import("./events").ReadFilter[]) => {
      if (filters.some((f) => f.kinds?.includes(39002)))
        return membership.promise;
      if (filters.some((f) => f.kinds?.includes(39000)))
        return [metadata(relay, "alpha", "Updated Alpha", 1_700_000_001)];
      if (filters.some((f) => f["#h"]?.includes("alpha"))) return head("fresh");
      return [];
    },
  );
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      query,
      media: () => undefined,
      ...(readIntent
        ? {
            readState: {
              decode: async () => [],
              sign: async () => {
                throw new Error("Not publishing in this test");
              },
              publish: async () => {},
            },
          }
        : {}),
    },
    {
      readStateFloor: () => 0,
      ...(maxDiscoveryBytes ? { maxDiscoveryBytes } : {}),
      persistence: storage,
      prepared: true,
      cachedOnly,
      initialChannelId,
      readPublisherLock: async (_signal, work) => work(),
      readStateStorage: {
        capture: async () => structuredClone(journal),
        async update(change) {
          journal = readJournal(change(journal), viewer.pubkey);
          return journal;
        },
        close() {},
      },
    },
  );
  owners.push(owner);
  return {
    owner,
    channels: owner.session.channels,
    membership,
    query,
    storage,
  };
}
describe("device-local startup", () => {
  let pagedRosters: RelayEvent[];
  let capacityRosters: readonly RelayEvent[];
  beforeAll(() => {
    // Alpha is confirmed on page one; the 501st membership requires a continuation.
    pagedRosters = [
      roster(relay, "alpha", [viewer.pubkey], 1_700_000_001),
      ...Array.from({ length: 500 }, (_, index) =>
        roster(relay, `channel-${index}`, [viewer.pubkey]),
      ).sort((a, b) => a.id.localeCompare(b.id)),
    ];
    // Large signed snapshot for restore and byte-budget checks.
    capacityRosters = Array.from({ length: 10_000 }, (_, i) =>
      roster(relay, `other-${i}`, [viewer.pubkey]),
    ).sort((a, b) => a.id.localeCompare(b.id));
  }, 60_000);

  it("restores 10,000 signed rosters as cached membership after restart", async () => {
    const { owner, channels, storage } = setup();
    await storage.writeStartup?.({
      discovery: {
        savedAt: Date.now(),
        relayAuthor: relay.pubkey,
        events: [...capacityRosters],
      },
    });
    await owner.restore();
    expect(channels.list().channels).toHaveLength(10_000);
    expect(channels.list().channels.every((channel) => channel.cached)).toBe(
      true,
    );
  }, 60_000);

  it.each(["roster failure", "roster cancellation", "metadata failure"])(
    "retries restored metadata after %s clears cached membership",
    async (failure) => {
      const { owner, channels, query } = setup();
      const interruption = deferred<RelayEvent[]>();
      const names = deferred<RelayEvent[]>();
      const fresh = metadata(relay, "alpha", "Renamed Alpha", 1_700_000_002, [
        ["archived", "true"],
      ]);
      let retry = false;
      query.mockImplementation(async (filters) => {
        const filter = filters[0];
        if (filter?.kinds?.includes(39002)) {
          if (!filter.before_id) return pagedRosters.slice(0, 500);
          if (!retry && failure !== "metadata failure")
            return interruption.promise;
          return pagedRosters.slice(500);
        }
        if (filter?.kinds?.includes(39000)) {
          if (!retry) return interruption.promise;
          return filter["#d"]?.includes("alpha") ? names.promise : [];
        }
        return [];
      });
      await owner.restore();
      expect(channels.get?.("alpha")).toMatchObject({
        name: "Alpha",
        cached: true,
      });
      channels.ensureList();
      try {
        await vi.waitFor(() =>
          expect(query).toHaveBeenCalledTimes(
            failure === "metadata failure" ? 3 : 2,
          ),
        );
        expect(channels.get?.("alpha")?.cached).toBeUndefined();
        expect(channels.get?.("alpha")?.name).toBe("Alpha");
        expect(owner.session.live.snapshot().roster.state).toBe("pending");
      } finally {
        interruption.reject(
          failure === "roster cancellation"
            ? new DOMException("Cancelled", "AbortError")
            : new ReadError("unavailable", "Offline"),
        );
      }
      await vi.waitFor(() =>
        expect(owner.session.live.snapshot().roster.state).toBe(
          failure === "roster cancellation" ? "deferred" : "error",
        ),
      );
      retry = true;
      query.mockClear();
      channels.ensureList();
      try {
        await vi.waitFor(() =>
          expect(
            query.mock.calls
              .flatMap(([filters]) => filters)
              .filter((filter) => filter.kinds?.includes(39000))
              .flatMap((filter) => filter["#d"] ?? []),
          ).toContain("alpha"),
        );
        expect(owner.session.live.snapshot().roster.state).toBe("pending");
        expect(channels.get?.("alpha")?.name).toBe("Alpha");
        expect(channels.get?.("alpha")?.archived).toBeUndefined();
        // A failed refresh confirmed nothing of the saved metadata.
        expect(channels.get?.("alpha")?.metadataCached).toBe(true);
      } finally {
        names.resolve([fresh]);
      }
      await vi.waitFor(() =>
        expect(owner.session.live.snapshot().roster.state).toBe("verified"),
      );
      expect(channels.list().channels).toHaveLength(501);
      expect(channels.list().coverage).toBeUndefined();
      expect(channels.get?.("alpha")).toMatchObject({
        name: "Renamed Alpha",
        archived: true,
      });
      expect(channels.get?.("alpha")?.cached).toBeUndefined();
    },
  );

  it.each([false, true])(
    "refreshes restored channel metadata with metadata included in the roster response=%s",
    async (included) => {
      const { owner, channels, membership, query } = setup();
      const fresh = metadata(relay, "alpha", "Renamed Alpha", 1_700_000_001, [
        ["archived", "true"],
      ]);
      const names = deferred<RelayEvent[]>();
      query.mockImplementation(async (filters) => {
        if (filters.some((filter) => filter.kinds?.includes(39002)))
          return membership.promise;
        if (filters.some((filter) => filter.kinds?.includes(39000)))
          return names.promise;
        return [];
      });
      await owner.restore();
      expect(channels.get?.("alpha")).toMatchObject({
        name: "Alpha",
        cached: true,
      });
      expect(channels.get?.("alpha")?.archived).toBeUndefined();
      channels.ensureList();
      await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
      try {
        membership.resolve([
          roster(relay, "alpha", [viewer.pubkey]),
          ...(included ? [fresh] : []),
        ]);
        if (!included) {
          await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
          expect(channels.get?.("alpha")?.cached).toBeUndefined();
          // The roster is fresh; the saved metadata is not confirmed yet.
          expect(channels.get?.("alpha")?.metadataCached).toBe(true);
          expect(
            channels.list().channels.find(({ id }) => id === "alpha")
              ?.metadataCached,
          ).toBe(true);
          expect(owner.session.live.snapshot().roster.state).toBe("pending");
        }
      } finally {
        names.resolve([fresh]);
      }
      await vi.waitFor(() =>
        expect(owner.session.live.snapshot().roster.state).toBe("verified"),
      );
      expect(channels.get?.("alpha")).toMatchObject({
        name: "Renamed Alpha",
        archived: true,
      });
      expect(channels.get?.("alpha")?.cached).toBeUndefined();
      expect(channels.get?.("alpha")?.metadataCached).toBeUndefined();
      expect(
        channels.list().channels.find(({ id }) => id === "alpha")
          ?.metadataCached,
      ).toBeUndefined();
      expect(
        query.mock.calls
          .flatMap(([filters]) => filters)
          .filter((filter) => filter.kinds?.includes(39000)),
      ).toEqual(
        included
          ? []
          : [
              {
                kinds: [39000],
                authors: [relay.pubkey],
                "#d": ["alpha"],
                limit: 500,
              },
            ],
      );
    },
  );

  it.each([false, true])(
    "keeps saved names across discovery confirmation and omission=%s",
    async (omitted) => {
      const storage = disk();
      const records = await storage.read();
      const record = records[0];
      if (!record) throw new Error("Missing saved head");
      record.profiles = [profile(viewer, { name: "Saved name" })];
      storage.read = async () => structuredClone(records);
      const { owner, channels, membership, query } = setup(storage);
      await owner.restore();
      expect(owner.session.profiles.snapshot().get(viewer.pubkey)?.name).toBe(
        "Saved name",
      );
      const names: (string | undefined)[] = [];
      owner.session.profiles.subscribe(() =>
        names.push(owner.session.profiles.snapshot().get(viewer.pubkey)?.name),
      );
      channels.ensureList();
      await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
      membership.resolve(omitted ? [] : discovery);
      await vi.waitFor(() =>
        expect(channels.list().channels.some((c) => c.cached)).toBe(false),
      );
      // A profile is a global relay event; losing a channel does not drop it.
      expect(owner.session.profiles.snapshot().get(viewer.pubkey)?.name).toBe(
        "Saved name",
      );
      expect(names).not.toContain(undefined);
    },
  );

  it.each([false, true])(
    "keeps viewer layout across a real channel revocation without restoring denied content (saved duration: %s)",
    async (withWindow) => {
      const storage = disk();
      const participant = keypair();
      const alpha = [
        roster(relay, "alpha", [viewer.pubkey, participant.pubkey]),
        metadata(relay, "alpha", "Alpha", 1_700_000_000, [["t", "dm"]]),
      ];
      const beta = [
        roster(relay, "beta", [viewer.pubkey]),
        metadata(relay, "beta", "Beta"),
      ];
      const layout = {
        ...preferences,
        starred: ["beta"],
        ...(withWindow
          ? {
              filters: { "section:work": "active" as const },
              activeWindowSeconds: { "section:work": 14 * 86400 },
            }
          : {}),
      };
      await storage.writeStartup?.({
        discovery: {
          savedAt: Date.now(),
          relayAuthor: relay.pubkey,
          events: [...alpha, ...beta],
        },
        preferences: { savedAt: Date.now(), data: layout },
      });
      await storage.writeProfiles?.([
        profile(participant, { name: "Alpha-only participant" }),
      ]);
      const { owner, channels, membership, query } = setup(storage);
      await owner.restore();
      expect(
        owner.session.profiles.snapshot().get(participant.pubkey)?.name,
      ).toBe("Alpha-only participant");
      channels.ensureList();
      await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
      membership.resolve([...alpha, ...beta]);
      await vi.waitFor(() =>
        expect(
          channels.list().channels.every((channel) => !channel.cached),
        ).toBe(true),
      );
      query.mockResolvedValue([
        roster(relay, "beta", [viewer.pubkey]),
        metadata(relay, "beta", "Beta"),
      ]);
      channels.refreshList?.();
      await vi.waitFor(() =>
        expect(channels.list().channels.map((channel) => channel.id)).toEqual([
          "beta",
        ]),
      );
      expect(storage.clear).not.toHaveBeenCalled();
      expect(await storage.read()).toEqual([]);
      expect((await storage.readStartup?.())?.preferences?.data).toEqual(
        layout,
      );
      const next = setup(storage, true);
      await next.owner.restore();
      // A profile is a global relay event; losing a channel does not drop it.
      expect(
        next.owner.session.profiles.snapshot().get(participant.pubkey)?.name,
      ).toBe("Alpha-only participant");
      expect(
        next.channels.list().channels.map((channel) => channel.id),
      ).toEqual(["beta"]);
      expect(next.owner.session.sidebarPreferences.snapshot().data).toEqual(
        layout,
      );
      expect(next.channels.window("alpha").rows).toEqual([]);
    },
  );

  it("restores names a previous session loaded", async () => {
    const storage = disk();
    const stranger = keypair();
    const first = setup(storage);
    await first.owner.restore();
    const reply = first.query.getMockImplementation();
    first.query.mockImplementation(async (filters) =>
      filters.some((filter) => filter.kinds?.includes(0))
        ? [profile(stranger, { name: "Stranger" })]
        : (reply?.(filters) ?? []),
    );
    await first.owner.session.profiles.ensure([stranger.pubkey]);
    await vi.waitFor(
      async () => expect(await storage.readProfiles?.()).toHaveLength(1),
      { timeout: 3000 },
    );
    const next = setup(storage, true);
    await next.owner.restore();
    expect(
      next.owner.session.profiles.snapshot().get(stranger.pubkey)?.name,
    ).toBe("Stranger");
  });

  it.each([
    ["accepts every record", "accepts"],
    ["rejects a forged signature", "rejects"],
    ["fails", "fails"],
  ])("restores names when the native check %s", async (_, mode) => {
    const [first, second, third] = [0, 1, 2].map((index) =>
      profile(keypair(), { name: `Saved ${index}` }),
    ) as [RelayEvent, RelayEvent, RelayEvent];
    const check = vi.fn(async (claims: readonly { sig: string }[]) => {
      if (mode === "fails") throw new Error("host unavailable");
      if (mode === "accepts") return claims.map(() => true);
      return nativeSignatureChecks({ claims });
    });
    const transport = await connectSignedTransport(
      { ...hostSigner(viewer), verifySignatures: check },
      "https://restore.test",
      relay.pubkey,
    );
    const storage = disk();
    // Right id, wrong signature: only the host's answer decides it.
    const forged = { ...second, sig: third.sig };
    await storage.writeProfiles?.([first, forged, third]);
    const owner = createRelaySession(transport, {
      persistence: storage,
      prepared: true,
      cachedOnly: true,
    });
    owners.push(owner);
    await owner.restore();
    const names = owner.session.profiles.snapshot();
    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0]?.[0]).toHaveLength(3);
    expect(names.get(first.pubkey)?.name).toBe("Saved 0");
    // A host that accepts the record is trusted: the JS check never ran.
    expect(names.get(second.pubkey)?.name).toBe(
      mode === "accepts" ? "Saved 1" : undefined,
    );
    expect(names.get(third.pubkey)?.name).toBe("Saved 2");
    // The saved copy survives the restore.
    expect(await storage.readProfiles?.()).toHaveLength(
      mode === "accepts" ? 3 : 2,
    );
  });

  it("restores a multi-batch mirror when the shorter roster restores first", async () => {
    const storage = disk();
    const people = Array.from({ length: 60 }, (_, index) =>
      profile(keypair(), { name: `Saved ${index}` }),
    );
    await storage.writeProfiles?.(people);
    const { owner } = setup(storage, true);
    await owner.restore();
    const snapshot = owner.session.profiles.snapshot();
    for (const [index, event] of people.entries())
      expect(snapshot.get(event.pubkey)?.name).toBe(`Saved ${index}`);
    expect(await storage.readProfiles?.()).toHaveLength(60);
  });

  it("rereads restored names and saves a newer profile", async () => {
    const storage = disk();
    const stranger = keypair();
    await storage.writeProfiles?.([profile(stranger, { name: "Old" })]);
    const { owner, query } = setup(storage);
    const reply = query.getMockImplementation();
    const renamed = deferred<RelayEvent[]>();
    query.mockImplementation(async (filters) =>
      filters.some((filter) => filter.authors?.includes(stranger.pubkey))
        ? renamed.promise
        : (reply?.(filters) ?? []),
    );
    await owner.restore();
    expect(owner.session.profiles.snapshot().get(stranger.pubkey)?.name).toBe(
      "Old",
    );
    renamed.resolve([profile(stranger, { name: "New" }, 1_700_000_001)]);
    await vi.waitFor(() =>
      expect(owner.session.profiles.snapshot().get(stranger.pubkey)?.name).toBe(
        "New",
      ),
    );
    await vi.waitFor(
      async () =>
        expect(await storage.readProfiles?.()).toEqual([
          expect.objectContaining({ created_at: 1_700_000_001 }),
        ]),
      { timeout: 3000 },
    );
  });

  it("reveals the selected head before verifying unrelated history", async () => {
    const storage = disk();
    const saved = await storage.readStartup?.();
    if (!saved?.discovery) throw new Error("Missing saved discovery");
    saved.discovery.events.push(
      roster(relay, "beta", [viewer.pubkey]),
      metadata(relay, "beta", "Beta"),
    );
    await storage.writeStartup?.(saved);
    const alpha = (await storage.read())[0];
    if (!alpha) throw new Error("Missing saved head");
    let examinedBeta = false;
    const beta = {
      ...alpha,
      channelId: "beta",
      get events() {
        examinedBeta = true;
        return [];
      },
    };
    storage.read = async () => [beta, alpha];
    const { owner, channels } = setup(storage, true, "alpha");
    await owner.restore();
    channels.ensure("alpha");
    expect(channels.window("alpha").rows[0]?.content).toBe("saved");
    expect(examinedBeta).toBe(false);
    await vi.waitFor(() => expect(examinedBeta).toBe(true));
  });

  it("shows signed saved history before discovery, then promotes identical membership and refreshes only demand", async () => {
    const { owner, channels, membership, query } = setup();
    await owner.restore();
    channels.ensureList();
    channels.ensure("alpha");
    channels.prepare?.("alpha");
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    expect(channels.list().channels[0]).toMatchObject({
      name: "Alpha",
      readOnly: true,
      cached: true,
    });
    expect(channels.window("alpha").rows[0]?.content).toBe("saved");
    await expect(
      owner.session.read([{ kinds: [9], "#h": ["alpha"], limit: 1 }]),
    ).rejects.toThrow("Reconnect");
    expect(query).toHaveBeenCalledTimes(1);
    membership.resolve(discovery);
    await vi.waitFor(() =>
      expect(channels.window("alpha").rows[0]?.content).toBe("fresh"),
    );
    expect(channels.list().channels[0]?.cached).toBeUndefined();
    expect(channels.list().channels[0]?.readOnly).toBeUndefined();
    expect(
      query.mock.calls
        .flatMap(([filters]) => filters)
        .filter((f) => f["#h"])
        .every((f) => f["#h"]?.every((id) => id === "alpha")),
    ).toBe(true);
  });
  it("confirms restored membership that moved ahead of the cursor before purging saved history", async () => {
    const { owner, channels, query, storage } = setup();
    const exact = deferred<RelayEvent[]>();
    const others = Array.from({ length: 500 }, (_, index) =>
      roster(relay, `other-${index}`, [viewer.pubkey]),
    ).sort((a, b) => a.id.localeCompare(b.id));
    const fresh = roster(relay, "alpha", [viewer.pubkey], 1_700_000_002);
    query.mockImplementation(async (filters) => {
      const rosterFilter = filters.find((f) => f.kinds?.includes(39002));
      if (rosterFilter?.["#d"]?.includes("alpha")) return exact.promise;
      if (rosterFilter) return rosterFilter.before_id ? [] : others;
      const metadataFilter = filters.find((f) => f.kinds?.includes(39000));
      if (metadataFilter)
        return (metadataFilter["#d"] ?? []).includes("alpha")
          ? [metadata(relay, "alpha", "Renamed Alpha", 1_700_000_003)]
          : [];
      if (filters.some((f) => f["#h"]?.includes("alpha"))) return head("fresh");
      return [];
    });
    await owner.restore();
    channels.ensure("alpha");
    channels.ensureList();
    await vi.waitFor(() =>
      expect(
        query.mock.calls
          .flatMap(([filters]) => filters)
          .some((filter) => filter["#d"]?.includes("alpha")),
      ).toBe(true),
    );
    expect(channels.get?.("alpha")).toMatchObject({
      name: "Alpha",
      cached: true,
    });
    expect(channels.window("alpha").rows[0]?.content).toBe("saved");
    exact.resolve([fresh]);
    await vi.waitFor(() =>
      expect(owner.session.live.snapshot().roster.state).toBe("verified"),
    );
    expect(channels.get?.("alpha")).toMatchObject({
      name: "Renamed Alpha",
    });
    expect(channels.get?.("alpha")?.cached).toBeUndefined();
    await vi.waitFor(() =>
      expect(channels.window("alpha").rows[0]?.content).toBe("fresh"),
    );
    expect(
      (await storage.readStartup?.())?.discovery?.events.some((event) =>
        (event as RelayEvent).tags.some(
          ([name, value]) => name === "d" && value === "alpha",
        ),
      ),
    ).toBe(true);
  });
  it.each(["confirm", "omit", "deny"])(
    "fresh exact and ID-only reads respect held cached authority: %s",
    async (outcome) => {
      const { owner, channels, query, membership } = setup();
      await owner.restore();
      channels.ensure("alpha");
      channels.ensureList();
      await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
      const fresh = message(keypair(), "alpha", "Never saved", 30);
      query.mockImplementation(async (filters) => {
        if (filters.some((f) => f.kinds?.includes(39002)))
          return membership.promise;
        if (filters.some((f) => f.ids?.includes(fresh.id) || f.depth_limit))
          return [fresh];
        return [];
      });
      const exact = owner.session.thread("alpha", fresh.id, { exact: true });
      await exact.refresh();
      expect(exact.snapshot().target).toBeUndefined();
      expect(query).toHaveBeenCalledTimes(1);
      expect(await owner.session.read([{ ids: [fresh.id], limit: 1 }])).toEqual(
        [],
      );
      expect(channels.window("alpha").rows[0]?.content).toBe("saved");
      if (outcome === "deny")
        membership.reject(new ReadError("denied", "Removed"));
      else membership.resolve(outcome === "confirm" ? discovery : []);
      await vi.waitFor(() =>
        expect(channels.get?.("alpha")?.cached).toBeUndefined(),
      );
      await exact.refresh();
      if (outcome === "confirm") {
        expect(exact.snapshot().target?.content).toBe("Never saved");
        expect(
          (await owner.session.read([{ ids: [fresh.id], limit: 1 }]))[0]?.id,
        ).toBe(fresh.id);
      } else {
        expect(exact.snapshot().target).toBeUndefined();
        expect(channels.window("alpha").rows).toEqual([]);
      }
      exact.dispose();
    },
  );
  it("automatically observes unopened-channel unread after a held cached roster becomes fresh", async () => {
    const storage = disk();
    const beta = [
      roster(relay, "beta", [viewer.pubkey]),
      metadata(relay, "beta", "Beta"),
    ];
    await storage.writeStartup?.({
      discovery: {
        savedAt: Date.now(),
        relayAuthor: relay.pubkey,
        events: [...discovery, ...beta],
      },
    });
    const { owner, channels, query, membership } = setup(storage);
    await owner.restore();
    channels.ensureList();
    await owner.session.unread.ensure();
    await owner.session.unread.ensure();
    const evidence = message(keypair(), "beta", "While closed", 30);
    query.mockImplementation(async (filters) => {
      if (filters.some((f) => f.kinds?.includes(39002)))
        return membership.promise;
      if (filters.some((f) => f.kinds?.includes(9))) return [evidence];
      return [];
    });
    expect(
      query.mock.calls
        .flatMap(([filters]) => filters)
        .filter((f) => f.kinds?.includes(9)),
    ).toEqual([]);
    membership.resolve([...discovery, ...beta]);
    await vi.waitFor(() =>
      expect(
        owner.session.unread.snapshot({ kind: "channel", channelId: "beta" })
          .observedCount,
      ).toBe(1),
    );
    expect(channels.window("beta").rows).toEqual([]);
  });
  it.each(["confirm", "omit", "deny"])(
    "revalidates demanded cached membership omitted by byte-limited discovery: %s",
    async (outcome) => {
      const maxBytes = capacityRosters
        .slice(0, 500)
        .reduce((bytes, event) => bytes + byteSize(event), 0);
      const { owner, channels, query, membership, storage } = setup(
        disk(),
        false,
        undefined,
        false,
        maxBytes,
      );
      await owner.restore();
      channels.ensureList();
      await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
      const exact = deferred<RelayEvent[]>();
      query.mockImplementation(async (filters) => {
        if (
          filters.some(
            (f) => f.kinds?.includes(39002) && f["#d"]?.includes("alpha"),
          )
        )
          return exact.promise;
        const rosterFilter = filters.find((f) => f.kinds?.includes(39002));
        if (rosterFilter)
          return capacityRosters
            .filter(
              (event) =>
                !rosterFilter.before_id || event.id > rosterFilter.before_id,
            )
            .slice(0, rosterFilter.limit);
        if (filters.some((f) => f["#h"]?.includes("alpha")))
          return head("fresh");
        return [];
      });
      membership.resolve(capacityRosters.slice(0, 500));
      await vi.waitFor(() =>
        expect(owner.session.live.snapshot().roster.state).toBe("verified"),
      );
      expect(channels.list().coverage).toBe("partial");
      expect(channels.get?.("alpha")?.cached).toBe(true);
      // The snapshot write is coalesced behind a short delay.
      await vi.waitFor(async () =>
        expect(
          (await storage.readStartup?.())?.discovery?.events.some((e) =>
            (e as RelayEvent).tags.some(([k, v]) => k === "d" && v === "alpha"),
          ),
        ).toBe(false),
      );
      channels.ensure("alpha");
      channels.refresh?.("alpha");
      channels.loadOlder("alpha");
      await vi.waitFor(() =>
        expect(
          query.mock.calls
            .flatMap(([filters]) => filters)
            .filter(
              (f) => f.kinds?.includes(39002) && f["#d"]?.includes("alpha"),
            ),
        ).toHaveLength(1),
      );
      expect(channels.window("alpha").rows[0]?.content).toBe("saved");
      if (outcome === "deny") exact.reject(new ReadError("denied", "Removed"));
      else
        exact.resolve(
          outcome === "confirm"
            ? discovery
            : [metadata(relay, "alpha", "Alpha")],
        );
      await vi.waitFor(() =>
        expect(channels.get?.("alpha")?.cached).toBeUndefined(),
      );
      if (outcome === "confirm") {
        await vi.waitFor(() =>
          expect(channels.window("alpha").rows[0]?.content).toBe("fresh"),
        );
      } else {
        expect(channels.get?.("alpha")).toBeUndefined();
        expect(channels.window("alpha").rows).toEqual([]);
        expect(await storage.read()).toEqual([]);
      }
    },
  );
  it("promotes verified disk evidence for read intent without waiting for a held network head", async () => {
    const { owner, channels, membership, query } = setup(
      disk(),
      false,
      undefined,
      true,
    );
    await owner.restore();
    channels.ensure("alpha");
    const id = channels.window("alpha").rows[0]?.id;
    if (!id) throw new Error("Missing saved row");
    const target = { kind: "channel", channelId: "alpha" } as const;
    await expect(
      owner.session.unread.markThrough(target, id),
    ).rejects.toThrow();
    channels.ensureList();
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    const content = deferred<RelayEvent[]>();
    query.mockImplementation(async (filters) =>
      filters.some((f) => f.kinds?.includes(39002))
        ? membership.promise
        : content.promise,
    );
    membership.resolve(discovery);
    await vi.waitFor(() =>
      expect(channels.get?.("alpha")?.cached).toBeUndefined(),
    );
    expect(owner.session.unread.snapshot(target).observedCount).not.toBeNull();
    // A known saved message reaches durability, rather than failing evidence lookup.
    await expect(
      owner.session.unread.markThrough(target, id),
    ).resolves.toBeDefined();
    content.resolve([]);
  });
  it("a cache-only owner cannot fetch heads, hover preparation, unread evidence or older pages", async () => {
    const { owner, channels, query } = setup(disk(), true);
    await owner.restore();
    channels.ensureList();
    channels.ensure("alpha");
    channels.prepare?.("alpha");
    channels.refresh?.("alpha");
    channels.loadOlder("alpha");
    await owner.session.unread.ensure();
    expect(query).not.toHaveBeenCalled();
    expect(channels.window("alpha").rows[0]?.content).toBe("saved");
  });
  it.each(["absent", "denied"])(
    "fresh %s membership removes saved rows, heads and next-launch discovery",
    async (outcome) => {
      const { owner, channels, membership, query, storage } = setup();
      await owner.restore();
      channels.ensure("alpha");
      channels.ensureList();
      await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
      if (outcome === "absent") membership.resolve([]);
      else membership.reject(new ReadError("denied", "Removed"));
      await vi.waitFor(() => expect(channels.list().channels).toEqual([]));
      expect(channels.window("alpha").rows).toEqual([]);
      expect(await storage.read()).toEqual([]);
      const saved = await storage.readStartup?.();
      expect(saved?.discovery?.events ?? []).toEqual([]);
    },
  );
  it("transient discovery failure retains the readable snapshot for deliberate retry", async () => {
    const { owner, channels, membership, query } = setup();
    await owner.restore();
    channels.ensure("alpha");
    channels.ensureList();
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    membership.reject(new ReadError("unavailable", "Offline"));
    await vi.waitFor(() => expect(channels.list().status).toBe("error"));
    expect(channels.list().channels[0]?.cached).toBe(true);
    expect(channels.window("alpha").rows[0]?.content).toBe("saved");
  });
  it.each(["tampered", "expired", "other-relay"])(
    "ignores %s discovery without blocking fresh reads",
    async (mode) => {
      const storage = disk();
      const saved = await storage.readStartup?.();
      if (!saved?.discovery) throw new Error("Missing saved discovery");
      if (mode === "tampered")
        saved.discovery.events[0] = { ...discovery[0], content: "tampered" };
      if (mode === "expired") saved.discovery.savedAt -= 86_400_001;
      if (mode === "other-relay")
        saved.discovery.relayAuthor = keypair().pubkey;
      await storage.writeStartup?.(saved);
      const { owner, channels, membership, query } = setup(storage);
      await owner.restore();
      expect(channels.list().channels).toEqual([]);
      channels.ensureList();
      await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
      membership.resolve(discovery);
      await vi.waitFor(() =>
        expect(channels.list().channels[0]?.name).toBe("Alpha"),
      );
    },
  );
  it("fresh authority wins over a late disk read", async () => {
    const storage = disk();
    const saved = await storage.readStartup?.();
    const delayed = deferred<SavedStartup | undefined>();
    storage.readStartup = () => delayed.promise;
    const { owner, channels } = setup(storage);
    const restoring = owner.restore();
    await owner.session.read([{ kinds: [39000], "#d": ["alpha"], limit: 1 }]);
    delayed.resolve(saved);
    await restoring;
    expect(channels.list().channels).toEqual([]);
  });
  it("clear cache fences a pending restore and prevents saved roster resurrection", async () => {
    const storage = disk();
    const saved = await storage.readStartup?.();
    const delayed = deferred<SavedStartup | undefined>();
    storage.readStartup = () => delayed.promise;
    const { owner, channels } = setup(storage, true);
    const restoring = owner.restore();
    await owner.clearCache();
    delayed.resolve(saved);
    await restoring;
    channels.ensure("alpha");
    await owner.restore();
    expect(channels.list().channels).toEqual([]);
    expect(channels.window("alpha").rows).toEqual([]);
    expect(await storage.read()).toEqual([]);
  });
  it("clearing an already restored owner removes its cached discovery", async () => {
    const { owner, channels } = setup(disk(), true);
    await owner.restore();
    channels.ensure("alpha");
    await owner.clearCache();
    channels.ensure("alpha");
    expect(channels.list().channels).toEqual([]);
    expect(channels.window("alpha").rows).toEqual([]);
  });
  it("never renews unconfirmed saved membership or promotes it from an older response", () => {
    const state = new DiscoveryState(viewer.pubkey, relay.pubkey);
    state.accept(roster(relay, "alpha", [viewer.pubkey], 20), true);
    state.accept(roster(relay, "beta", [viewer.pubkey], 20));
    state.accept(roster(relay, "alpha", [viewer.pubkey], 19));
    expect(state.canParticipate("alpha")).toBe(false);
    expect(
      state
        .savedEvents()
        .map((event) => event.tags.find(([key]) => key === "d")?.[1]),
    ).toEqual(["beta"]);
  });
  it("restores preference display without a writable base; fresh response replaces it", async () => {
    const fresh = deferred<typeof preferences>();
    const sort = vi.fn(),
      mute = vi.fn();
    const store = createSidebarPreferencesStore({
      read: () => fresh.promise,
      available: true,
      writeMute: mute,
      writeSort: sort,
      persistence: disk(),
    });
    try {
      await store.ready;
      expect(store.queries.snapshot()).toMatchObject({
        cached: true,
        data: { sections: preferences.sections },
      });
      expect(store.queries.writable).toBe(false);
      expect(store.queries.sortWritable).toBe(false);
      await expect(
        store.queries.setSort("channels", "recent", ["alpha"]),
      ).rejects.toThrow();
      await expect(store.queries.setMute("alpha", true)).rejects.toThrow();
      expect(sort).not.toHaveBeenCalled();
      expect(mute).not.toHaveBeenCalled();
      const loading = store.queries.ensure();
      fresh.resolve({ ...preferences, sections: [], assignments: {} });
      await loading;
      expect(store.queries.snapshot().cached).toBeUndefined();
      expect(store.queries.snapshot().data?.sections).toEqual([]);
    } finally {
      store.dispose();
    }
  });
});
