import { createChannelDetails } from "../relay/channel-details";
import { keypair, signed } from "../relay/testing";
import type { RelayEvent } from "../relay/events";
import { createRelaySession } from "../relay/session";
import type { ConfigurationState } from "../../plugins/types";
import { createSoloRegionFixture } from "./solo-navigation-testing";
import { prepareSoloMove } from "./solo-navigation";
import { afterEach, expect, it, vi } from "vitest";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const label = "buzz.region:example:work";
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});
function fixture() {
  const h = createSoloRegionFixture();
  cleanup.push(h.dispose);
  return h;
}
const pluginConfiguration = (enabled: boolean): ConfigurationState => ({
  status: "ready",
  externalPluginsPaused: false,
  catalog: {
    profile: "fixture",
    location: "Fixture",
    plugins: [
      {
        manifest: { id: "example", name: "Example", apiVersion: 1 },
        source: "external",
        enabled,
        revision: "one",
        previous: null,
        reloadable: false,
        error: null,
      },
    ],
  },
});

it("keeps labeled channels in one live or recovery placement throughout registration and disposal", async () => {
  const h = fixture();
  expect([...h.service.snapshot().excluded]).toEqual(["owned", "shared"]);
  expect(h.service.snapshot().regions[0]).toMatchObject({ reason: "off" });
  const source = await h.register();
  expect([...(h.service.snapshot().regions[0]?.live ?? [])]).toEqual([
    "owned",
    "shared",
  ]);
  source.update({ status: "loading", binding: source.binding(), revision: 2 });
  expect(h.service.snapshot().regions[0]).toMatchObject({ reason: "loading" });
  expect([...h.service.snapshot().excluded]).toEqual(["owned", "shared"]);
  source.update({
    status: "unavailable",
    binding: source.binding(),
    revision: 3,
  });
  expect(h.service.snapshot().regions[0]).toMatchObject({
    reason: "unavailable",
  });
  await source.fiber.dispose();
  expect(source.signal().aborted).toBe(true);
  expect(h.service.snapshot().regions[0]).toMatchObject({ reason: "off" });
  await expect(
    source.handle.createChat(source.binding(), {
      channelId: "new",
      title: "New",
      members: [],
    }),
  ).rejects.toThrow("ended");
});

it("fences reconnects and rejects old or conflicting snapshots without losing labeled channels", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const h = fixture(),
    source = await h.register();
  const old = source.binding();
  source.update({ status: "loading", binding: old, revision: 1 });
  expect(h.service.snapshot().regions[0]?.reason).toBeUndefined();
  source.update({ status: "loading", binding: old, revision: 0 });
  expect(h.service.snapshot().regions[0]?.reason).toBeUndefined();
  const oldSignal = source.signal();
  h.reconnect();
  expect(oldSignal.aborted).toBe(true);
  expect(source.binding().incarnation).not.toBe(old.incarnation);
  source.update({ status: "unavailable", binding: old, revision: 999 });
  expect([...(h.service.snapshot().regions[0]?.live ?? [])]).toEqual([
    "owned",
    "shared",
  ]);
  await expect(source.handle.classify(old, "owned")).rejects.toThrow("ended");
});

it.each(["bind", "subscribe", "read"] as const)(
  "recovers labeled channels when source %s throws",
  async (method) => {
    const h = fixture();
    await h.register({
      [method]: () => {
        throw new Error("broken source");
      },
    });
    expect(h.service.snapshot().regions[0]).toMatchObject({ reason: "failed" });
    expect([...(h.service.snapshot().regions[0]?.live ?? [])]).toEqual([]);
    expect([...h.service.snapshot().excluded]).toEqual(["owned", "shared"]);
  },
);

it("marks a ready region hidden without losing its chats or ownership, and recovers it when the source is not ready", async () => {
  const h = fixture();
  const source = await h.register();
  source.update({
    status: "ready",
    binding: source.binding(),
    revision: 2,
    hidden: true,
  });
  const hidden = h.service.snapshot().regions[0];
  expect(hidden).toMatchObject({ hidden: true });
  expect(hidden?.reason).toBeUndefined();
  expect([...(hidden?.live ?? [])]).toEqual(["owned", "shared"]);
  expect([...h.service.snapshot().excluded]).toEqual(["owned", "shared"]);
  // Hiding is presentation only: the source still owns, files and starts its chats.
  expect(prepareSoloMove(h.session, "owned")).toBe(
    "This chat is managed by Work.",
  );
  expect(h.service.draftRegion(label)?.source.id).toBe("work");
  source.update({
    status: "loading",
    binding: source.binding(),
    revision: 3,
    hidden: true,
  });
  expect(h.service.snapshot().regions[0]).toMatchObject({ reason: "loading" });
  expect(h.service.snapshot().regions[0]?.hidden).toBeUndefined();
  source.update({ status: "ready", binding: source.binding(), revision: 4 });
  expect([...(h.service.snapshot().regions[0]?.live ?? [])]).toEqual([
    "owned",
    "shared",
  ]);
  source.update({
    status: "ready",
    binding: source.binding(),
    revision: 5,
    hidden: true,
  });
  await source.fiber.dispose();
  expect(h.service.snapshot().regions[0]).toMatchObject({ reason: "off" });
  expect([...h.service.snapshot().excluded]).toEqual(["owned", "shared"]);
});

it("fails a source whose snapshot has a non-boolean hidden", async () => {
  const h = fixture();
  const source = await h.register();
  source.update({
    status: "ready",
    binding: source.binding(),
    revision: 2,
    hidden: "yes" as unknown as boolean,
  });
  expect(h.service.snapshot().regions[0]).toMatchObject({ reason: "failed" });
  expect([...h.service.snapshot().excluded]).toEqual(["owned", "shared"]);
});

it("uses the code-point-lowest external region label and excludes no unknown or archived channel", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const h = fixture();
  h.roster([
    {
      id: "multi",
      name: "Multi",
      channelType: "solo",
      labels: ["buzz.region:zeta:other", label],
    },
  ]);
  expect(h.service.snapshot().regions).toHaveLength(1);
  expect(h.service.snapshot().regions[0]).toMatchObject({
    label,
    reason: "off",
  });
  expect([...h.service.snapshot().excluded]).toEqual(["multi"]);
});

it("keeps cached labeled channels in recovery while the new connection is unavailable", async () => {
  const h = fixture();
  const source = await h.register();
  h.cache();
  expect(source.signal().aborted).toBe(true);
  expect([...h.service.snapshot().excluded]).toEqual(["owned", "shared"]);
  expect(h.service.snapshot().regions[0]).toMatchObject({ reason: "loading" });
  expect([...(h.service.snapshot().regions[0]?.live ?? [])]).toEqual([]);
});

it("gives Retry a fresh incarnation and restores a failed source without reviving old handles", async () => {
  const h = fixture();
  let broken = true;
  const source = await h.register({
    read: (binding) => {
      if (broken) throw new Error("read failed");
      return { status: "ready", binding, revision: 1 };
    },
  });
  expect(h.service.snapshot().regions[0]).toMatchObject({ reason: "failed" });
  const old = source.binding(),
    oldSignal = source.signal();
  broken = false;
  h.service.retry("example/work");
  expect(oldSignal.aborted).toBe(true);
  expect(source.binding().incarnation).not.toBe(old.incarnation);
  expect([...(h.service.snapshot().regions[0]?.live ?? [])]).toEqual([
    "owned",
    "shared",
  ]);
  await expect(source.handle.classify(old, "owned")).rejects.toThrow("ended");
});

it("keeps label exclusion even when connection coordinates are missing", async () => {
  const h = fixture();
  await h.register();
  h.loseCoordinates();
  expect([...h.service.snapshot().excluded]).toEqual(["owned", "shared"]);
});

it("revokes a source create during signing before the host publishes it", async () => {
  const viewer = keypair(),
    relay = keypair();
  const started = deferred(),
    release = deferred();
  const publish = vi.fn(async () => {});
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      channelIdentity: true,
      media: () => undefined,
      query: async () => [],
      writer: {
        kinds: [9007],
        publish,
        sign: async (template) => {
          started.resolve();
          await release.promise;
          return signed(viewer, template);
        },
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  cleanup.push(owner.dispose);
  const h = createSoloRegionFixture(viewer.pubkey);
  cleanup.push(h.dispose);
  Object.assign(h.session, { channelWrites: owner.session.channelWrites });
  const source = await h.register();
  const operation = source.handle.createChat(source.binding(), {
    channelId: "11111111-1111-4111-8111-111111111111",
    title: "Work",
    members: [viewer.pubkey],
  });
  const settled = operation.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await started.promise;
    h.reconnect();
    expect(publish).not.toHaveBeenCalled();
  } finally {
    release.resolve();
  }
  await vi.waitFor(() =>
    expect(owner.session.outbox?.snapshot()[0]?.delivery).toBe("failed"),
  );
  expect(publish).not.toHaveBeenCalled();
  owner.dispose();
  expect(await settled).toBeInstanceOf(Error);
});

it.each([
  "own",
  "shared",
  "archived",
  "readOnly",
  "different",
  "already",
  "archiveDuringLoad",
  "readOnlyDuringLoad",
  "convertedDuringLoad",
  "reconnectDuringLoad",
] as const)(
  "classifies through signed details, preserving labels (%s)",
  async (mode) => {
    const viewer = keypair(),
      relay = keypair();
    const h = createSoloRegionFixture(viewer.pubkey);
    cleanup.push(h.dispose);
    const id = "11111111-1111-4111-8111-111111111111";
    let labels = [
      "buzz.solo",
      "keep",
      ...(mode === "different"
        ? ["buzz.region:other:work"]
        : mode === "already"
          ? [label]
          : []),
    ];
    let clock = 100;
    const record = (kind: number, tags: string[][]) =>
      signed(relay, {
        kind,
        content: "",
        created_at: clock++,
        tags: [["d", id], ...tags],
      });
    const metadata = () =>
      record(39000, [
        ["name", "Classify"],
        ["about", ""],
        ["private"],
        ["t", "stream"],
        ...labels.map((value) => ["t", value]),
      ]);
    let events: RelayEvent[] = [
      metadata(),
      record(39001, [["p", viewer.pubkey, "owner"]]),
      record(39002, [["p", viewer.pubkey, "", "owner"]]),
    ];
    const publish = vi.fn(async (event: RelayEvent) => {
      labels = event.tags
        .filter(([name]) => name === "t")
        .map(([, value]) => value as string);
      events = [metadata(), ...events.slice(1)];
    });
    const held =
      mode === "archiveDuringLoad" ||
      mode === "readOnlyDuringLoad" ||
      mode === "convertedDuringLoad" ||
      mode === "reconnectDuringLoad";
    const started = deferred();
    const release = deferred();
    const details = createChannelDetails({
      reader: {
        read: async () => {
          if (held) {
            started.resolve();
            await release.promise;
          }
          return events;
        },
      },
      writer: { sign: async (template) => signed(viewer, template), publish },
      labels: true,
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      canAccess: () => true,
      acceptDiscovery() {},
    });
    cleanup.push(details.dispose);
    Object.assign(h.session, { channelDetails: details.capability });
    h.roster([
      {
        id,
        name: "Classify",
        channelType: "solo",
        creator: mode === "shared" ? relay.pubkey : viewer.pubkey,
        labels,
        ...(mode === "archived" ? { archived: true as const } : {}),
        ...(mode === "readOnly" ? { readOnly: true as const } : {}),
      },
    ]);
    const source = await h.register();
    if (held) {
      const operation = source.handle.classify(source.binding(), id);
      const rejected = expect(operation).rejects.toThrow(
        mode === "reconnectDuringLoad"
          ? /ended|abort/i
          : mode === "convertedDuringLoad"
            ? "no longer a Solo"
            : "own active Solo",
      );
      try {
        await started.promise;
        if (mode === "reconnectDuringLoad") {
          h.reconnect();
        } else if (mode === "convertedDuringLoad") {
          labels = ["keep"];
          events = [metadata(), ...events.slice(1)];
        } else {
          h.roster(
            h.session.channels.list().channels.map((channel) => ({
              ...channel,
              ...(mode === "archiveDuringLoad"
                ? { archived: true as const }
                : { readOnly: true as const }),
            })),
          );
        }
        expect(publish).not.toHaveBeenCalled();
      } finally {
        release.resolve();
      }
      await rejected;
      expect(publish).not.toHaveBeenCalled();
    } else if (["shared", "archived", "readOnly", "different"].includes(mode)) {
      await expect(
        source.handle.classify(source.binding(), id),
      ).rejects.toThrow(
        mode === "different" ? "another region" : "own active Solo",
      );
      expect(publish).not.toHaveBeenCalled();
    } else {
      await source.handle.classify(source.binding(), id);
      expect((await details.capability.load(id)).labels).toEqual([
        "buzz.solo",
        "keep",
        label,
      ]);
      expect(publish).toHaveBeenCalledTimes(mode === "already" ? 0 : 1);
    }
  },
);

it.each([
  ["loading", "loading"],
  ["recovery", "off"],
  ["absent", "not-installed"],
] as const)("uses generic recovery copy with catalog %s", (state, reason) => {
  const h = fixture();
  h.plugins(
    state === "loading"
      ? { status: "loading" }
      : state === "recovery"
        ? { status: "recovery", reason: "Unavailable", canReset: false }
        : {
            status: "ready",
            catalog: { profile: "fixture", location: "Fixture", plugins: [] },
            externalPluginsPaused: false,
          },
  );
  expect(h.service.snapshot().regions[0]).toMatchObject({
    title: "Plugin chats",
    reason,
  });
});

it.each([false, true])(
  "shows disabled region chats in ordinary Solo and reclaims them when re-enabled (hidden: %s)",
  async (hidden) => {
    const h = fixture();
    const source = await h.register();
    source.update({
      status: "ready",
      binding: source.binding(),
      revision: 2,
      hidden,
    });
    const active = {
      example: { revision: "one", status: "active" as const, error: null },
    };
    const before = h.session.channels
      .list()
      .channels.find((channel) => channel.id === "owned");
    expect([...h.service.snapshot().excluded]).toEqual(["owned", "shared"]);

    h.plugins(pluginConfiguration(false), active);
    const disabled = h.service.snapshot();
    expect(disabled.regions[0]?.hidden).toBeUndefined();
    expect([...disabled.excluded]).toEqual([]);
    expect([...disabled.managed]).toEqual(["owned", "shared"]);
    expect(prepareSoloMove(h.session, "owned")).toBe(
      "This chat is managed by Work.",
    );
    expect(prepareSoloMove(h.session, "chat")).toBeUndefined();
    expect(
      h.session.channels
        .list()
        .channels.find((channel) => channel.id === "owned"),
    ).toEqual(before);

    h.plugins(pluginConfiguration(true), active);
    const enabled = h.service.snapshot();
    expect(enabled.regions[0]?.hidden).toBe(hidden || undefined);
    expect([...enabled.excluded]).toEqual(["owned", "shared"]);
    expect([...enabled.managed]).toEqual(["owned", "shared"]);
  },
);

it("matches disabled plugins by exact id without misclassifying an uninstalled plugin", () => {
  const h = fixture();
  h.roster([
    ...h.session.channels.list().channels,
    {
      id: "prefix",
      name: "Prefix",
      channelType: "solo",
      creator: h.session.viewer,
      labels: ["buzz.solo", "buzz.region:example-other:work"],
    },
  ]);
  h.plugins(pluginConfiguration(false));

  const snapshot = h.service.snapshot();
  expect(
    snapshot.regions.find((region) => region.label === label)?.reason,
  ).toBe("disabled");
  expect(
    snapshot.regions.find(
      (region) => region.label === "buzz.region:example-other:work",
    )?.reason,
  ).toBe("not-installed");
  expect([...snapshot.excluded]).toEqual(["prefix"]);
  expect([...snapshot.managed]).toEqual(["owned", "shared", "prefix"]);
});

it("keeps disabled chats ordinary through loading, re-enable, and reconnect", async () => {
  const h = fixture();
  const active = {
    example: { revision: "one", status: "active" as const, error: null },
  };
  h.plugins(pluginConfiguration(false), active);
  expect(h.service.snapshot().regions[0]?.reason).toBe("disabled");
  expect([...h.service.snapshot().excluded]).toEqual([]);

  h.plugins({ status: "loading" });
  expect(h.service.snapshot().regions[0]?.reason).toBe("loading");
  expect([...h.service.snapshot().excluded]).toEqual(["owned", "shared"]);

  h.plugins(pluginConfiguration(true), active);
  expect(h.service.snapshot().regions[0]?.reason).toBe("off");
  const source = await h.register();
  expect(h.service.snapshot().regions[0]?.reason).toBeUndefined();
  expect([...h.service.snapshot().excluded]).toEqual(["owned", "shared"]);

  await source.fiber.dispose();
  h.plugins(pluginConfiguration(false), active);
  h.reconnect();
  expect(h.service.snapshot().regions[0]?.reason).toBe("disabled");
  expect([...h.service.snapshot().excluded]).toEqual([]);
  expect([...h.service.snapshot().managed]).toEqual(["owned", "shared"]);
});

it("does not reveal disabled chats or replay a reveal queued before disabling", async () => {
  const h = fixture();
  const source = await h.register();
  const sourceEntry = h.service.sources()[0];
  if (!sourceEntry) throw new Error("Expected the registered Solo source");
  const revealRequests = h.service.presentation(
    sourceEntry,
    source.binding(),
  ).revealRequests;
  const sourceReveal = vi.fn();
  const stopSourceReveal = revealRequests.subscribe(sourceReveal);
  await h.navigate({
    version: 1,
    kind: "conversation",
    scope: {
      communityOrigin: "https://fixture.invalid",
      viewer: h.session.viewer ?? "",
    },
    channelId: "owned",
  });
  const listener = vi.fn();
  h.service.reveal("owned");
  expect(sourceReveal).toHaveBeenCalledWith("owned");
  h.plugins(pluginConfiguration(false), {
    example: { revision: "one", status: "active", error: null },
  });
  h.service.reveal("owned");
  expect(sourceReveal).toHaveBeenCalledTimes(1);
  h.plugins(pluginConfiguration(true), {
    example: { revision: "one", status: "active", error: null },
  });
  expect(sourceReveal).toHaveBeenCalledTimes(1);
  const stop = h.service.subscribeReveal(listener, true);
  expect(listener).not.toHaveBeenCalled();
  stop();
  stopSourceReveal();

  h.service.reveal("owned");
  const replayed = vi.fn(() => true);
  const stopReplay = h.service.subscribeReveal(replayed, true);
  expect(replayed).toHaveBeenCalledWith("owned", true);
  stopReplay();
});

it("skips a disabled source when opening a newly created workspace", async () => {
  const h = fixture();
  const disabledOpen = vi.fn(async () => {});
  const enabledOpen = vi.fn(async () => {});
  await h.register({
    order: -1,
    composeWorkspaces: true,
    openWorkspace: disabledOpen,
  });
  await h.register(
    {
      composeWorkspaces: true,
      openWorkspace: enabledOpen,
    },
    "another",
  );
  const disabledConfiguration = pluginConfiguration(false);
  if (disabledConfiguration.status !== "ready")
    throw new Error("Expected plugin configuration to be ready");
  const example = disabledConfiguration.catalog.plugins[0];
  if (!example) throw new Error("Expected the example plugin");
  h.plugins(
    {
      ...disabledConfiguration,
      catalog: {
        ...disabledConfiguration.catalog,
        plugins: [
          example,
          {
            ...example,
            manifest: { ...example.manifest, id: "another", name: "Another" },
            enabled: true,
          },
        ],
      },
    },
    {
      another: { revision: "one", status: "active", error: null },
    },
  );

  expect(h.service.snapshot().regions[0]?.reason).toBe("disabled");
  await expect(
    h.service.openCreatedWorkspace("created-workspace"),
  ).resolves.toBe(true);
  expect(disabledOpen).not.toHaveBeenCalled();
  expect(enabledOpen).toHaveBeenCalledWith(
    expect.objectContaining({ viewer: h.session.viewer }),
    "created-workspace",
  );
});

it.each(["starting", "failed", "paused", "stale"] as const)(
  "uses the installed plugin's current activation for recovery (%s)",
  (state) => {
    const h = fixture();
    h.plugins(
      {
        status: "ready",
        externalPluginsPaused: state === "paused",
        catalog: {
          profile: "fixture",
          location: "Fixture",
          plugins: [
            {
              manifest: { id: "example", name: "Example", apiVersion: 1 },
              source: "external",
              enabled: true,
              revision: "one",
              previous: null,
              reloadable: false,
              error: null,
            },
          ],
        },
      },
      {
        example: {
          revision: state === "stale" ? "old" : "one",
          status: state === "failed" ? "failed" : "starting",
          error: null,
        },
      },
    );
    expect(h.service.snapshot().regions[0]?.reason).toBe(
      state === "starting" ? "loading" : state === "failed" ? "failed" : "off",
    );
  },
);

it("allows explicit recovery reveal with cached connection coordinates while refusing a non-current chat", async () => {
  const h = fixture();
  const target = {
    version: 1 as const,
    kind: "conversation" as const,
    scope: {
      communityOrigin: "https://fixture.invalid",
      viewer: h.session.viewer ?? "",
    },
    channelId: "owned",
  };
  await h.navigate(target);
  h.cache();
  const reveal = vi.fn();
  const stop = h.service.subscribeReveal(reveal);
  h.service.reveal("owned");
  expect(reveal).toHaveBeenCalledWith("owned", true);
  h.service.reveal("shared");
  expect(reveal).toHaveBeenCalledOnce();
  stop();
});
