import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuzzClient } from "../../buzz-mcp/client";
import { appClient } from "../../buzz-mcp/app-client";
import { callSessionTool } from "../../buzz-mcp/session-tools";
import type { ProtectionAction } from "../agent-protection/service";
import {
  type ChannelLifecycleSettings,
  lifecycleSettings,
} from "../relay/channel-lifecycle-protocol";
import type { ChannelList, ChannelSummary } from "../relay/contracts";
import type { ReadFilter, RelayEvent } from "../relay/events";
import type { AgentHandle } from "./service";
import {
  createOwnerAccess,
  type OwnerBinding,
  type OwnerSession,
  ownerMcpEnabled,
} from "./owner-access";

const owner = "a".repeat(64);
const agent = "b".repeat(64);
const person = "c".repeat(64);
const otherOwner = "d".repeat(64);
const relayAuthor = "e".repeat(64);
const community = "https://relay.example.test";
const joined = "11111111-1111-4111-8111-111111111111";
const archived = "22222222-2222-4222-8222-222222222222";
const system = "44444444-4444-4444-8444-444444444444";
const unlisted = "66666666-6666-4666-8666-666666666666";

afterEach(() => {
  vi.unstubAllEnvs();
});

const record = (kind: number, id: string, tags: string[][]) =>
  ({
    id: `${kind}${id}`.padEnd(64, "0").slice(0, 64),
    pubkey: relayAuthor,
    kind,
    created_at: 100,
    content: "",
    tags: [["d", id], ...tags],
    sig: "",
  }) as unknown as RelayEvent;
/** The relay-signed state of channel `id`: owners/admins and the roster. */
function signed(
  id: string,
  roles: Readonly<Record<string, string>>,
  metadata: string[][] = [["t", "stream"], ["private"]],
) {
  return [
    record(39000, id, metadata),
    record(
      39001,
      id,
      Object.entries(roles)
        .filter(([, role]) => role === "owner" || role === "admin")
        .map(([key, role]) => ["p", key, role]),
    ),
    record(
      39002,
      id,
      Object.entries(roles).map(([key, role]) => ["p", key, "", role]),
    ),
  ];
}

/** The owner's session: only reads, so any other member reached fails. Its
 * lifecycle owner answers from the records last read, with direct roles alone. */
function fakeSession(
  list: Partial<ChannelList> & { channels: ChannelSummary[] },
  events: () => readonly RelayEvent[] = () => [],
  lifecycle?: (id: string) => ChannelLifecycleSettings,
  content: readonly RelayEvent[] = [],
) {
  const touched = new Set<PropertyKey>();
  const readRemote = vi.fn(
    async (
      filters: readonly ReadFilter[],
      options?: { signal?: AbortSignal },
    ): Promise<readonly RelayEvent[]> => {
      options?.signal?.throwIfAborted();
      const wanted = filters.flatMap((filter) => filter["#d"] ?? []);
      return events().filter(
        (event) =>
          !wanted.length ||
          event.tags.some(
            ([key, value]) => key === "d" && wanted.includes(value ?? ""),
          ),
      );
    },
  );
  // The relay's own answer, newest first per filter, as `snapshotRead` gives.
  const snapshotRead = vi.fn(
    async (
      filters: readonly ReadFilter[],
      options: { signal?: AbortSignal | undefined },
    ) => {
      options.signal?.throwIfAborted();
      // As the relay reader does.
      if (
        filters.some(
          ({ limit }) => limit === undefined || limit < 1 || limit > 500,
        )
      )
        throw new Error("Relay read limit must be between 1 and 500");
      return filters.flatMap((filter) =>
        content
          .filter((event) => matches(filter, event))
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, filter.limit),
      );
    },
  );
  const ensureList = vi.fn();
  const ensure = vi.fn(async () => {});
  const load = vi.fn(
    async (
      id: string,
      signal?: AbortSignal,
      records?: readonly RelayEvent[],
    ) => {
      signal?.throwIfAborted();
      if (lifecycle) return lifecycle(id);
      return lifecycleSettings(records ?? events(), id, owner, relayAuthor);
    },
  );
  const target = {
    relayAuthor,
    channels: {
      list: () => ({ status: "ready", ...list }) as ChannelList,
      // Never in list(), but a lookup can return one.
      get: (id: string): ChannelSummary | undefined =>
        id === system
          ? { id, name: "App data", channelType: "system", members: [owner] }
          : undefined,
      ensureList,
    },
    readRemote,
    names: { resolve: (key: string) => (key === person ? "Pat" : undefined) },
    profiles: {
      ensure,
      snapshot: () => new Map([[owner, { name: "Owner" }]]),
    },
    // Reads only: it has no `run`.
    channelLifecycle: { load },
    snapshotRead,
  };
  const session = new Proxy(target, {
    get(object, key, receiver) {
      touched.add(key);
      if (!(key in object)) throw new Error(`Unexpected ${String(key)}`);
      return Reflect.get(object, key, receiver);
    },
  }) as unknown as OwnerSession;
  return {
    session,
    readRemote,
    snapshotRead,
    ensureList,
    ensure,
    load,
    touched,
  };
}

function matches(filter: ReadFilter, event: RelayEvent) {
  const tagged = (name: string) => {
    const wanted = filter[`#${name}`];
    return (
      !wanted ||
      event.tags.some(
        ([key, value]) => key === name && wanted.includes(value ?? ""),
      )
    );
  };
  return (
    (!filter.ids || filter.ids.includes(event.id)) &&
    (!filter.kinds || filter.kinds.includes(event.kind)) &&
    (!filter.authors || filter.authors.includes(event.pubkey)) &&
    (filter.since === undefined || event.created_at >= filter.since) &&
    (filter.until === undefined || event.created_at <= filter.until) &&
    (filter.before_id === undefined || event.id !== filter.before_id) &&
    (filter.search === undefined || event.content.includes(filter.search)) &&
    tagged("h") &&
    tagged("e")
  );
}

/** A message in channel `h`; `key` names its ID. */
const post = (
  key: string,
  h: string,
  created_at: number,
  content: string,
  tags: string[][] = [],
  patch: Partial<RelayEvent> = {},
) =>
  ({
    id: key.repeat(64).slice(0, 64),
    pubkey: person,
    kind: 9,
    created_at,
    content,
    tags: [["h", h], ...tags],
    sig: "",
    ...patch,
  }) as unknown as RelayEvent;

const channels: ChannelSummary[] = [
  {
    id: joined,
    name: "Plans",
    channelType: "stream",
    private: true,
    viewerRole: "owner",
    members: [owner, person],
    owners: [owner],
  },
  {
    id: archived,
    name: "Old",
    channelType: "forum",
    visibility: "public",
    archived: true,
    members: [owner, person, agent],
  },
];

function bound(session: OwnerSession, viewer = owner) {
  const controller = new AbortController();
  const first: OwnerBinding = {
    viewer,
    origin: community,
    session,
    signal: controller.signal,
  };
  let binding: OwnerBinding | undefined = first;
  return {
    first,
    bind: () => binding,
    controller,
    set(next: OwnerBinding | undefined) {
      binding = next;
    },
  };
}

function started() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ownerMcpEnabled", () => {
  it("is off by default and for every other origin", () => {
    vi.stubEnv("VITE_BUZZ_OWNER_MCP_COMMUNITIES", "");
    expect(ownerMcpEnabled(community)).toBe(false);
    vi.stubEnv("VITE_BUZZ_OWNER_MCP_COMMUNITIES", community);
    expect(ownerMcpEnabled(community)).toBe(true);
    expect(ownerMcpEnabled("wss://relay.example.test")).toBe(true);
    for (const other of [
      "https://other.example.test",
      "https://relay.example.test.evil.test",
      "https://relay.example.test:8443",
      "not a community",
      null,
    ])
      expect(ownerMcpEnabled(other)).toBe(false);
  });
});

describe("owner access", () => {
  it("lists the owner's channels, including ones the agent is not in, as the owner", async () => {
    const fake = fakeSession({ channels });
    const access = createOwnerAccess(
      { pubkey: agent, owner },
      bound(fake.session).bind,
    );
    await expect(access.channels()).resolves.toEqual({
      execution: { agent, owner, community },
      partial: false,
      channels: [
        {
          id: joined,
          name: "Plans",
          type: "stream",
          visibility: "private",
          archived: false,
          role: "owner",
          members: 2,
        },
        {
          id: archived,
          name: "Old",
          type: "forum",
          visibility: "open",
          archived: true,
          // Listed as a member with no role: which role is not known.
          role: "unknown",
          members: 3,
        },
      ],
    });
    expect(fake.ensureList).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: "loading" as const }, true],
    [{ status: "error" as const, error: "offline" }, true],
    [{ coverage: "partial" as const }, false],
  ])("marks a list that is not complete partial: %j", async (state, asks) => {
    const fake = fakeSession({ channels: [], ...state });
    const access = createOwnerAccess(
      { pubkey: agent, owner },
      bound(fake.session).bind,
    );
    const list = await access.channels();
    expect(list).toMatchObject({ partial: true, channels: [] });
    if ("error" in state) expect(list.error).toBe("offline");
    expect(fake.ensureList).toHaveBeenCalledTimes(asks ? 1 : 0);
  });

  it("answers a channel with the relay's current roles and rights", async () => {
    // The listed role is stale: the fresh roster says admin.
    const fake = fakeSession({ channels }, () =>
      signed(joined, { [owner]: "admin", [person]: "member", [agent]: "bot" }),
    );
    const access = createOwnerAccess(
      { pubkey: agent, owner },
      bound(fake.session).bind,
    );
    const details = await access.channel(joined);
    expect(details).toMatchObject({
      execution: { agent, owner, community },
      channel: { id: joined, role: "admin", members: 3, visibility: "private" },
      // An admin, not the sole owner the list says: no Delete.
      capabilities: {
        manageRoles: true,
        removeMembers: true,
        archive: true,
        unarchive: false,
        delete: false,
      },
    });
    expect(fake.readRemote).toHaveBeenCalledExactlyOnceWith(
      [39000, 39001, 39002].map((kind) => ({
        kinds: [kind],
        consistency: "strong",
        authors: [relayAuthor],
        "#d": [joined],
        limit: 1,
      })),
      expect.objectContaining({ priority: "foreground" }),
    );
  });

  it.each([
    [
      "archived since it was listed",
      [["t", "stream"], ["private"], ["archived", "true"]],
      { type: "stream", archived: true },
      { archive: false, unarchive: true, delete: false },
    ],
    [
      "a DM, whatever the list says",
      [["t", "dm"], ["private"]],
      { type: "dm", archived: false },
      { archive: false, unarchive: false, delete: false },
    ],
  ])(
    "answers the current state of a channel %s",
    async (_what, metadata, channel, rights) => {
      const fake = fakeSession({ channels }, () =>
        signed(joined, { [owner]: "owner", [person]: "member" }, metadata),
      );
      const access = createOwnerAccess(
        { pubkey: agent, owner },
        bound(fake.session).bind,
      );
      await expect(access.channel(joined)).resolves.toMatchObject({
        channel: { ...channel, role: "owner" },
        capabilities: rights,
      });
    },
  );

  it("offers lifecycle actions the owner has through an agent it owns", async () => {
    // A member by role, owning the channel's owner-role agent: the session's
    // lifecycle owner verifies that, as the relay does.
    const fake = fakeSession(
      { channels },
      () => signed(joined, { [owner]: "member", [agent]: "owner" }),
      (id) => ({
        ...lifecycleSettings(
          signed(joined, { [owner]: "member", [agent]: "owner" }),
          id,
          owner,
          relayAuthor,
        ),
        canArchive: true,
        canDelete: true,
      }),
    );
    const access = createOwnerAccess(
      { pubkey: agent, owner },
      bound(fake.session).bind,
    );
    await expect(access.channel(joined)).resolves.toMatchObject({
      channel: { role: "member" },
      capabilities: {
        manageRoles: false,
        removeMembers: false,
        archive: true,
        unarchive: false,
        delete: true,
      },
    });
    // It judges the writer-backed records just read, not a replica's.
    expect(fake.readRemote).toHaveBeenCalledOnce();
    const [filters] = fake.readRemote.mock.calls[0] ?? [];
    expect(filters).toEqual(
      [39000, 39001, 39002].map((kind) =>
        expect.objectContaining({ kinds: [kind], consistency: "strong" }),
      ),
    );
    expect(fake.load).toHaveBeenCalledExactlyOnceWith(
      joined,
      expect.any(AbortSignal),
      await fake.readRemote.mock.results[0]?.value,
    );
  });

  it("gives an owner without a role no rights, whatever the list says", async () => {
    const fake = fakeSession({ channels }, () =>
      signed(joined, { [person]: "owner" }),
    );
    const access = createOwnerAccess(
      { pubkey: agent, owner },
      bound(fake.session).bind,
    );
    await expect(access.channel(joined)).resolves.toMatchObject({
      channel: { role: null },
      capabilities: {
        manageRoles: false,
        removeMembers: false,
        archive: false,
        unarchive: false,
        delete: false,
      },
    });
    expect(fake.load).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown channel", "33333333-3333-4333-8333-333333333333", () => []],
    ["a channel the relay withholds", joined, () => []],
    [
      "unverifiable roles",
      joined,
      () => signed(joined, { [owner]: "owner" }).slice(0, 1),
    ],
    ["an ID that is not a channel's", "general", () => []],
    [
      "a system channel",
      system,
      () => signed(system, { [owner]: "owner" }, [["t", "system"]]),
    ],
  ])("fails for %s", async (_what, id, events) => {
    const fake = fakeSession({ channels }, events);
    const access = createOwnerAccess(
      { pubkey: agent, owner },
      bound(fake.session).bind,
    );
    await expect(access.channel(id)).rejects.toThrow();
    await expect(
      access.members(id, { offset: 0, limit: 10 }),
    ).rejects.toThrow();
  });

  it("reads nothing more from a channel the relay says is a system channel, whatever the list says", async () => {
    const untyped = "55555555-5555-4555-8555-555555555555";
    const fake = fakeSession(
      { channels: [{ id: untyped, name: "Setup", members: [owner] }] },
      () => signed(untyped, { [owner]: "owner" }, [["t", "system"]]),
    );
    const access = createOwnerAccess(
      { pubkey: agent, owner },
      bound(fake.session).bind,
    );
    await expect(access.channel(untyped)).rejects.toThrow(
      "not in your owner's channels",
    );
    await expect(
      access.members(untyped, { offset: 0, limit: 10 }),
    ).rejects.toThrow("not in your owner's channels");
    expect(fake.readRemote).toHaveBeenCalledTimes(2);
    expect(fake.ensure).not.toHaveBeenCalled();
  });

  it("reads no roster for a channel outside the owner's channels", async () => {
    const fake = fakeSession({ channels: [] }, () =>
      signed(joined, { [owner]: "owner" }),
    );
    const access = createOwnerAccess(
      { pubkey: agent, owner },
      bound(fake.session).bind,
    );
    await expect(
      access.members(joined, { offset: 0, limit: 10 }),
    ).rejects.toThrow("not in your owner's channels");
    expect(fake.readRemote).not.toHaveBeenCalled();
  });

  it("pages the roster with roles and names", async () => {
    const fake = fakeSession({ channels }, () =>
      signed(joined, {
        [owner]: "owner",
        [person]: "guest",
        [agent]: "bot",
        [otherOwner]: "custom",
      }),
    );
    const access = createOwnerAccess(
      { pubkey: agent, owner },
      bound(fake.session).bind,
    );
    await expect(
      access.members(joined, { offset: 1, limit: 2 }),
    ).resolves.toEqual({
      execution: { agent, owner, community },
      channel: joined,
      total: 4,
      members: [
        { pubkey: person, role: "guest", name: "Pat" },
        { pubkey: agent, role: "bot" },
      ],
    });
    expect(fake.ensure).toHaveBeenCalledExactlyOnceWith(
      [person, agent],
      "foreground",
    );
    await expect(
      access.members(joined, { offset: 3, limit: 2 }),
    ).resolves.toMatchObject({ members: [{ role: "unknown" }] });
  });

  it("only reads", async () => {
    const fake = fakeSession({ channels }, () =>
      signed(joined, { [owner]: "owner" }),
    );
    const access = createOwnerAccess(
      { pubkey: agent, owner },
      bound(fake.session).bind,
    );
    await access.channels();
    await access.channel(joined);
    await access.members(joined, { offset: 0, limit: 10 });
    await access.messages({ channel: joined, limit: 5 });
    await access.messages({ search: "plan", limit: 5 });
    await access.canvas(joined);
    await access.canvasHistory(joined, {});
    expect(
      [...fake.touched].every((key) =>
        [
          "relayAuthor",
          "channels",
          "readRemote",
          "names",
          "profiles",
          "channelLifecycle",
          "snapshotRead",
        ].includes(String(key)),
      ),
    ).toBe(true);
    // Content comes only from the relay's own answer, never through the
    // session's projected reads; the strong read is relay-signed state alone.
    for (const [filters] of fake.readRemote.mock.calls)
      for (const filter of filters as readonly ReadFilter[])
        expect(
          filter.kinds?.every((kind) => kind >= 39000 && kind <= 39002),
        ).toBe(true);
  });

  it.each(["no binding", "another account's binding", "a replaced binding"])(
    "reads nothing with %s",
    async (state) => {
      const fake = fakeSession({ channels }, () =>
        signed(joined, { [owner]: "owner" }),
      );
      const binding = bound(fake.session);
      if (state === "no binding") binding.set(undefined);
      else if (state === "another account's binding")
        binding.set({ ...binding.first, viewer: otherOwner });
      else binding.controller.abort();
      const access = createOwnerAccess({ pubkey: agent, owner }, binding.bind);
      await expect(access.channels()).rejects.toThrow("not connected");
      await expect(access.channel(joined)).rejects.toThrow("not connected");
      expect(fake.readRemote).not.toHaveBeenCalled();
    },
  );

  it.each(["signs in as someone else", "reconnects", "disconnects"])(
    "returns nothing when the owner's connection %s during the call",
    async (change) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reading = started();
      const fake = fakeSession({ channels });
      const binding = bound(fake.session);
      fake.readRemote.mockImplementation(async () => {
        reading.resolve();
        await held;
        return signed(joined, { [owner]: "owner" });
      });
      const access = createOwnerAccess({ pubkey: agent, owner }, binding.bind);
      const call = access.channel(joined);
      await reading.promise;
      if (change === "signs in as someone else")
        binding.set({ ...binding.first, viewer: otherOwner });
      else if (change === "reconnects")
        binding.set({
          ...binding.first,
          session: fakeSession({ channels }).session,
        });
      else binding.set(undefined);
      release();
      await expect(call).rejects.toThrow("changed during the call");
    },
  );

  it.each(["signs in as someone else", "reconnects", "disconnects"])(
    "withholds an answer when the owner's connection %s while its result is reviewed",
    async (change) => {
      const fake = fakeSession({ channels }, () =>
        signed(joined, { [owner]: "owner" }),
      );
      const binding = bound(fake.session);
      const access = createOwnerAccess({ pubkey: agent, owner }, binding.bind);
      const reviewing = started();
      const approve = started();
      const protect = vi.fn(async (action: ProtectionAction) => {
        if (action.kind !== "tool-result") return;
        reviewing.resolve();
        await approve.promise;
      });
      const client = {
        pubkey: agent,
        key: agent,
        ownerAccess: access,
        protect,
      } as unknown as BuzzClient;
      const call = callSessionTool(client, {}, "owner_channel_get", {
        channel: joined,
      });
      await reviewing.promise;
      const replacement = fakeSession({ channels });
      if (change === "signs in as someone else")
        binding.set({ ...binding.first, viewer: otherOwner });
      else if (change === "reconnects")
        binding.set({ ...binding.first, session: replacement.session });
      else binding.set(undefined);
      approve.resolve();
      await expect(call).rejects.toThrow("changed during the call");
      // Checked, not read again or read elsewhere.
      expect(fake.readRemote).toHaveBeenCalledOnce();
      expect(replacement.readRemote).not.toHaveBeenCalled();
    },
  );

  it("answers only reads it made itself", () => {
    const access = createOwnerAccess(
      { pubkey: agent, owner },
      bound(fakeSession({ channels }).session).bind,
    );
    expect(() => access.held({ agent, owner, community })).toThrow(
      "changed during the call",
    );
  });

  it("returns nothing once the binding is replaced mid-read", async () => {
    const reading = started();
    const fake = fakeSession({ channels });
    const binding = bound(fake.session);
    fake.readRemote.mockImplementation(
      (_filters, options) =>
        new Promise<readonly RelayEvent[]>((_resolve, reject) => {
          reading.resolve();
          options?.signal?.addEventListener("abort", () =>
            reject(options.signal?.reason),
          );
        }),
    );
    const access = createOwnerAccess({ pubkey: agent, owner }, binding.bind);
    const call = access.channel(joined);
    await reading.promise;
    binding.controller.abort();
    await expect(call).rejects.toThrow("changed during the call");
  });

  it("stops when its caller cancels, before or during the read", async () => {
    const fake = fakeSession({ channels }, () =>
      signed(joined, { [owner]: "owner" }),
    );
    const access = createOwnerAccess(
      { pubkey: agent, owner },
      bound(fake.session).bind,
    );
    const before = new AbortController();
    before.abort(new Error("Turn ended"));
    await expect(access.channels(before.signal)).rejects.toThrow("Turn ended");
    const during = new AbortController();
    fake.readRemote.mockImplementationOnce(async () => {
      during.abort(new Error("Turn ended"));
      return signed(joined, { [owner]: "owner" });
    });
    await expect(access.channel(joined, during.signal)).rejects.toThrow(
      "Turn ended",
    );
  });

  it("keeps each owner's reads to that owner's own session", async () => {
    const first = fakeSession({ channels });
    const second = fakeSession({
      channels: [{ id: archived, name: "Theirs", members: [otherOwner] }],
    });
    const mine = bound(first.session);
    const theirs = bound(second.session, otherOwner);
    const a = createOwnerAccess({ pubkey: agent, owner }, mine.bind);
    const b = createOwnerAccess(
      { pubkey: person, owner: otherOwner },
      theirs.bind,
    );
    await a.channels();
    const list = await b.channels();
    expect(list.channels.map(({ name }) => name)).toEqual(["Theirs"]);
    expect(list.execution).toEqual({
      agent: person,
      owner: otherOwner,
      community,
    });
    // The first owner's agent never reads through the second owner's session.
    mine.set(theirs.first);
    await expect(a.channels()).rejects.toThrow("not connected");
  });
});

describe("owner reads", () => {
  /** The relay's signed state of the owner's two channels; the agent is in
   * neither private channel's roster. */
  const state = () => [
    ...signed(joined, { [owner]: "owner", [person]: "member" }),
    ...signed(
      archived,
      { [owner]: "member", [person]: "member", [agent]: "bot" },
      [["t", "forum"], ["public"], ["archived", "true"]],
    ),
  ];
  const reader = (content: readonly RelayEvent[], list = { channels }) => {
    const fake = fakeSession(list, state, undefined, content);
    const binding = bound(fake.session);
    return {
      fake,
      binding,
      access: createOwnerAccess({ pubkey: agent, owner }, binding.bind),
    };
  };
  const contentReads = (fake: ReturnType<typeof fakeSession>) =>
    fake.snapshotRead.mock.calls.map(([filters]) => filters);

  it("reads a private channel the agent is not in, a page at a time, with edits and names", async () => {
    const one = post("1", joined, 10, "first");
    const two = post("2", joined, 20, "second");
    const three = post("3", joined, 30, "third");
    const edit = post("4", joined, 31, "third, fixed", [["e", three.id]], {
      kind: 40003,
    });
    const elsewhere = post("5", archived, 40, "elsewhere");
    const { fake, access } = reader([one, two, three, edit, elsewhere]);
    const page = await access.messages({ channel: joined, limit: 2 });
    expect(page).toEqual({
      execution: { agent, owner, community },
      channel: joined,
      events: [three, two, edit],
      names: { [person]: "Pat" },
      more: { before: 20, beforeId: two.id },
    });
    expect(contentReads(fake)[0]).toEqual([
      expect.objectContaining({ "#h": [joined], limit: 3 }),
    ]);
    // Read with the call's signal, from the relay's own answer.
    expect(fake.snapshotRead.mock.calls[0]?.[1]).toEqual({
      signal: expect.any(AbortSignal),
    });
    await expect(
      access.messages({
        channel: joined,
        limit: 2,
        before: 20,
        beforeId: two.id,
      }),
    ).resolves.toMatchObject({ events: [one], channel: joined });
    // An archived open forum reads the same way.
    await expect(
      access.messages({ channel: archived, limit: 5 }),
    ).resolves.toMatchObject({ events: [elsewhere], channel: archived });
  });

  it("names the owners its Buzz has verified for a page's authors", async () => {
    const one = post("1", joined, 10, "first");
    const { fake, access } = reader([one]);
    Object.assign(fake.session.profiles, {
      owner: (key: string) => (key === person ? owner : undefined),
    });
    await expect(
      access.messages({ channel: joined, limit: 5 }),
    ).resolves.toMatchObject({ owners: { [person]: owner } });
  });

  it("says when a page's edits fill the one edit read", async () => {
    const message = post("1", joined, 10, "first");
    const edits = Array.from({ length: 500 }, (_, i) =>
      post(
        `a${i.toString(16).padStart(3, "0")}`,
        joined,
        11 + i,
        `v${i}`,
        [["e", message.id]],
        { kind: 40003 },
      ),
    );
    const { access } = reader([message, ...edits]);
    await expect(
      access.messages({ channel: joined, limit: 5 }),
    ).resolves.toMatchObject({ editsLimited: true });
  });

  it("reads a whole thread from any of its messages", async () => {
    const root = post("1", joined, 10, "root");
    const reply = (key: string, at: number) =>
      post(key, joined, at, `reply ${key}`, [
        ["e", root.id, "", "root"],
        ["e", root.id, "", "reply"],
      ]);
    const first = reply("2", 20);
    const second = reply("3", 30);
    const { access } = reader([
      root,
      first,
      second,
      post("4", joined, 40, "x"),
    ]);
    const page = await access.messages({ thread: second.id, limit: 1 });
    expect(page).toMatchObject({
      channel: joined,
      root: root.id,
      events: [root, second],
      more: { before: 30, beforeId: second.id },
    });
    await expect(
      access.messages({
        thread: second.id,
        limit: 1,
        before: 30,
        beforeId: second.id,
      }),
    ).resolves.toMatchObject({ root: root.id, events: [first] });
  });

  it("searches only the owner's channels, and says when that is incomplete or limited", async () => {
    const mine = post("1", joined, 10, "the plan");
    const unknown = post("2", unlisted, 20, "their plan");
    const hidden = post("3", system, 30, "system plan");
    const { access } = reader([mine, unknown, hidden]);
    await expect(
      access.messages({ search: "plan", limit: 5 }),
    ).resolves.toEqual({
      execution: { agent, owner, community },
      events: [mine],
      names: { [person]: "Pat" },
    });
    await expect(
      access.messages({ search: "plan", limit: 3 }),
    ).resolves.toMatchObject({ events: [mine], limited: true });
    const loading = reader([mine], {
      channels: [],
      status: "loading",
    } as never).access;
    await expect(
      loading.messages({ search: "plan", limit: 5 }),
    ).resolves.toMatchObject({ events: [], partial: true });
  });

  it.each([
    ["a channel outside the owner's channels", unlisted, "not in your owner's"],
    ["a system channel", system, "not in your owner's"],
    ["an ID that is not a channel's", "general", "must be a channel ID"],
  ])("reads nothing from %s", async (_what, id, error) => {
    const { fake, access } = reader([post("1", id, 10, "secret")]);
    await expect(access.messages({ channel: id, limit: 5 })).rejects.toThrow(
      error,
    );
    await expect(access.canvas(id)).rejects.toThrow(error);
    await expect(access.canvasHistory(id, {})).rejects.toThrow(error);
    expect(fake.snapshotRead).not.toHaveBeenCalled();
  });

  it("reads nothing from a channel the relay withholds from the owner", async () => {
    const fake = fakeSession({ channels }, () => [], undefined, [
      post("1", joined, 10, "secret"),
    ]);
    const access = createOwnerAccess(
      { pubkey: agent, owner },
      bound(fake.session).bind,
    );
    await expect(
      access.messages({ channel: joined, limit: 5 }),
    ).rejects.toThrow("not found or your owner cannot see it");
    expect(fake.snapshotRead).not.toHaveBeenCalled();
  });

  it("answers a message or thread outside the owner's channels as missing, reading no more", async () => {
    const theirs = post("1", unlisted, 10, "secret");
    const { fake, access } = reader([theirs]);
    await expect(
      access.messages({ thread: theirs.id, limit: 5 }),
    ).rejects.toThrow(`No message ${theirs.id}`);
    await expect(
      access.messages({ thread: "f".repeat(64), limit: 5 }),
    ).rejects.toThrow("No message");
    // Only the message lookups.
    for (const filters of contentReads(fake))
      expect(filters).toEqual([expect.objectContaining({ limit: 1 })]);
    expect(fake.readRemote).not.toHaveBeenCalled();
  });

  it("is unavailable while the owner's session cannot read the relay", async () => {
    const fake = fakeSession({ channels }, state);
    const session = new Proxy(fake.session, {
      get: (object, key) =>
        key === "snapshotRead" ? undefined : Reflect.get(object, key),
    });
    const access = createOwnerAccess(
      { pubkey: agent, owner },
      bound(session).bind,
    );
    await expect(
      access.messages({ channel: joined, limit: 5 }),
    ).rejects.toThrow("owner tools are unavailable now");
    await expect(access.canvas(joined)).rejects.toThrow(
      "owner tools are unavailable now",
    );
  });

  it("reads the current canvas, a revision of it, and its history a page at a time", async () => {
    const canvas = (key: string, h: string, at: number, content: string) =>
      post(key, h, at, content, [], { kind: 40100, pubkey: owner });
    const older = canvas("1", joined, 10, "# Draft");
    const newer = canvas("2", joined, 20, "# Plan");
    const other = canvas("3", archived, 30, "# Other");
    const { fake, access } = reader([older, newer, other]);
    await expect(access.canvas(joined)).resolves.toEqual({
      execution: { agent, owner, community },
      channel: joined,
      canvas: newer,
    });
    await expect(access.canvas(joined, older.id)).resolves.toMatchObject({
      canvas: older,
    });
    // A revision is read from the writer, so one history just listed is found.
    expect(contentReads(fake).at(-1)).toEqual([
      expect.objectContaining({ ids: [older.id], consistency: "strong" }),
    ]);
    await expect(access.canvas(joined, other.id)).rejects.toThrow(
      `No revision ${other.id} of channel ${joined}'s canvas.`,
    );
    await expect(access.canvasHistory(joined, {})).resolves.toEqual({
      execution: { agent, owner, community },
      channel: joined,
      revisions: [newer, older],
    });
    // The first page is the writer's; later ones follow the cursor.
    expect(contentReads(fake).at(-1)).toEqual([
      expect.objectContaining({ consistency: "strong", "#h": [joined] }),
    ]);
    await expect(
      access.canvasHistory(joined, { before: 20, beforeId: newer.id }),
    ).resolves.toMatchObject({ revisions: [older] });
    expect(contentReads(fake).at(-1)).toEqual([
      expect.not.objectContaining({ consistency: "strong" }),
    ]);
    expect(contentReads(fake).at(-1)).toEqual([
      expect.objectContaining({ until: 20, before_id: newer.id }),
    ]);
    // A channel with no canvas has none.
    const empty = reader([]).access;
    await expect(empty.canvas(joined)).resolves.not.toHaveProperty("canvas");
  });

  it("returns no content once the owner's connection changes mid-read", async () => {
    const reading = started();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fake, binding, access } = reader([post("1", joined, 10, "secret")]);
    const replacement = fakeSession({ channels }, state);
    fake.snapshotRead.mockImplementationOnce(async () => {
      reading.resolve();
      await held;
      return [post("1", joined, 10, "secret")];
    });
    const call = access.messages({ channel: joined, limit: 5 });
    await reading.promise;
    binding.set({ ...binding.first, session: replacement.session });
    release();
    await expect(call).rejects.toThrow("changed during the call");
    expect(replacement.snapshotRead).not.toHaveBeenCalled();
    expect(replacement.readRemote).not.toHaveBeenCalled();
  });

  it("stops when its caller cancels during a content read", async () => {
    const { fake, access } = reader([post("1", joined, 10, "secret")]);
    const during = new AbortController();
    fake.snapshotRead.mockImplementationOnce(async () => {
      during.abort(new Error("Turn ended"));
      return [post("1", joined, 10, "secret")];
    });
    await expect(
      access.messages({ channel: joined, limit: 5 }, during.signal),
    ).rejects.toThrow("Turn ended");
    const before = new AbortController();
    before.abort(new Error("Turn ended"));
    await expect(
      access.canvas(joined, undefined, before.signal),
    ).rejects.toThrow("Turn ended");
  });

  it("never gives one owner's agent another owner's content", async () => {
    const mine = reader([post("1", joined, 10, "mine")]);
    const theirs = fakeSession(
      { channels: [{ id: joined, name: "Plans", members: [otherOwner] }] },
      () => signed(joined, { [otherOwner]: "owner" }),
      undefined,
      [post("2", joined, 20, "theirs")],
    );
    const other = bound(theirs.session, otherOwner);
    await expect(
      mine.access.messages({ channel: joined, limit: 5 }),
    ).resolves.toMatchObject({ events: [{ content: "mine" }] });
    // The host now binds the other owner: this agent reads nothing there.
    mine.binding.set(other.first);
    await expect(
      mine.access.messages({ channel: joined, limit: 5 }),
    ).rejects.toThrow("not connected");
    await expect(mine.access.canvas(joined)).rejects.toThrow("not connected");
    expect(theirs.snapshotRead).not.toHaveBeenCalled();
  });

  it("answers each owner read tool through the agent's own client, as the owner", async () => {
    const message = post("1", joined, 10, "see the plan");
    const canvas = post("2", joined, 20, "# Plan", [], {
      kind: 40100,
      pubkey: owner,
    });
    const { fake, access } = reader([message, canvas]);
    const client = appClient(
      {
        pubkey: agent,
        key: agent,
        owner,
        ownerAccess: access,
      } as unknown as AgentHandle,
      {
        read: vi.fn(),
        memories: async () => ({ entries: [], partial: false }),
      },
    );
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(String(await callSessionTool(client, {}, name, args)));
    const executedAs = { agent, owner, community };
    await expect(
      call("owner_read", { channel: joined }),
    ).resolves.toMatchObject({
      executedAs,
      channel: joined,
      messages: [expect.stringContaining("see the plan")],
    });
    await expect(call("owner_read", { q: "plan" })).resolves.toMatchObject({
      executedAs,
      messages: [expect.any(String)],
    });
    await expect(
      call("owner_canvas_get", { channel: joined }),
    ).resolves.toMatchObject({ executedAs, id: canvas.id, canvas: "# Plan" });
    await expect(
      call("owner_canvas_history", { channel: joined }),
    ).resolves.toMatchObject({ executedAs, revisions: [{ id: canvas.id }] });
    // Every answer came from the relay's own reads with the owner's session.
    expect(fake.snapshotRead).toHaveBeenCalled();
  });
});
