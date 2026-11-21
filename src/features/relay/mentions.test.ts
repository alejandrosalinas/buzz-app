import { assert, afterEach, expect, it, vi } from "vitest";
import type { EventTemplate } from "nostr-tools";
import { eventDto, type ReadFilter, type RelayEvent } from "./events";
import { foldMessages } from "./fold";
import type { LiveCallbacks } from "./live";
import { createRelaySession } from "./session";
import {
  createOwnerMentionStore,
  sendWithOwnerMentions,
} from "./owner-mentions";
import { localAgentsFixture } from "../agents/local-testing";
import type { AgentInvocationIntent } from "../agents/session-admission";
import { replyInvocationIntents } from "./messages";
import { PublishRejected } from "./outbox";
import { mentionConformance } from "../../bundled/mentions/mention-rules.conformance";
import {
  flush,
  keypair,
  metadata,
  roster,
  scriptedTransport,
  signed,
} from "./testing";
import { USER_STATUS_KIND } from "./user-status-policy";

const viewer = keypair(),
  relay = keypair(),
  honey = keypair(),
  namesake = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
// Bylines read profiles together with statuses.
const profileRead = (filters: readonly ReadFilter[]) =>
  filters.every((filter) =>
    filter.kinds?.every((kind) => kind === 0 || kind === USER_STATUS_KIND),
  );

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(
  soloMode = false,
  withLive = false,
  agents?: ReturnType<typeof localAgentsFixture>,
  ownerMentionStore?: ReturnType<typeof createOwnerMentionStore>,
) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live: LiveCallbacks | undefined;
  let release: (() => void) | undefined;
  let held = false;
  const publish = vi.fn(async (_event: RelayEvent) => {});
  const sign = vi.fn(async (template: EventTemplate) => {
    if (held)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return signed(viewer, template);
  });
  let currentRoster: RelayEvent | undefined;
  let replicaRoster: RelayEvent | undefined;
  const profileEvents: RelayEvent[] = [];
  const owner = createRelaySession(
    {
      ...wire.transport,
      ...(agents ? { scope: "https://relay.example.test" } : {}),
      query: (filters, ...args) => {
        if (
          filters[0]?.authors?.[0] === relay.pubkey &&
          filters[0]?.kinds?.[0] === 39002 &&
          filters[0]?.limit === 1
        )
          return Promise.resolve(
            replicaRoster && filters[0]?.consistency !== "strong"
              ? [replicaRoster]
              : currentRoster
                ? [currentRoster]
                : [],
          );
        if ((soloMode || profileEvents.length) && profileRead(filters))
          return Promise.resolve(profileEvents);
        if (soloMode && filters.every((filter) => !!filter.ids))
          return Promise.resolve(publish.mock.calls.map(([event]) => event));
        return wire.transport.query(filters, ...args);
      },
      writer: { sign, publish },
      ...(withLive
        ? {
            subscribe(callbacks: LiveCallbacks) {
              live = callbacks;
              return { update() {}, retry() {}, dispose() {} };
            },
          }
        : {}),
    },
    {
      outboxStorage: { load: () => [], save: () => {} },
      ...(agents ? { agentChoices: agents } : {}),
      ...(ownerMentionStore ? { ownerMentionStore } : {}),
    },
  );
  owners.push(owner);
  async function members(
    keys = [viewer.pubkey, honey.pubkey, namesake.pubkey],
    time = 1700000000,
    author = relay,
    meta?: RelayEvent,
  ) {
    const read = owner.session.read([
      { kinds: [39002, 39000], "#d": ["c"], limit: 10 },
    ]);
    let pending = wire.next();
    while (!pending.filters.some((filter) => filter.kinds?.includes(39002))) {
      expect(profileRead(pending.filters)).toBe(true);
      pending.respond([]);
      await flush();
      pending = wire.next();
    }
    currentRoster = roster(author, "c", keys, time);
    pending.respond([
      currentRoster,
      soloMode
        ? signed(relay, {
            kind: 39000,
            content: JSON.stringify({ name: "Work" }),
            tags: [
              ["d", "c"],
              ["t", "stream"],
              ["private"],
              ["t", "buzz.solo"],
            ],
          })
        : (meta ?? metadata(relay, "c", "General")),
    ]);
    await read;
  }
  return {
    ...wire,
    ...owner,
    members,
    live: () => {
      assert(live, "setup(_, true) subscribes a live stream");
      return live;
    },
    setRoster: (keys: readonly string[]) => {
      currentRoster = roster(relay, "c", keys, 1700000001);
    },
    lagReplica: () => {
      replicaRoster = currentRoster;
    },
    async agentProfile(key: typeof honey) {
      profileEvents.push(
        signed(key, {
          kind: 0,
          content: JSON.stringify({ name: "Honey" }),
          tags: [["auth", viewer.pubkey, "", "a".repeat(128)]],
        }),
      );
      await owner.session.profiles.ensure([key.pubkey]);
    },
    sign,
    publish,
    hold: () => {
      held = true;
    },
    release: () => release?.(),
  };
}
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

it("withholds owner proof while an open channel's metadata awaits revalidation after a disconnect", async () => {
  const h = setup(false, true);
  h.live().state({ status: "connected", routes: [] });
  await h.members(
    undefined,
    1700000000,
    relay,
    metadata(relay, "c", "General", 1700000000, [["public"]]),
  );
  const source = { channelId: "c", rootId: null };
  const { ownerMentions, channels, messages } = h.session;
  assert(ownerMentions);
  const id = sendWithOwnerMentions(h.session, [honey.pubkey], () =>
    messages.send("c", "@Honey hello", [honey.pubkey]),
  );
  await vi.waitFor(() =>
    expect(ownerMentions.latest(source)?.eventId).toBe(id),
  );

  h.live().receive([roster(relay, "c", [honey.pubkey], 1700000001)]);
  const lookup = channels.resolve?.(["c"]);
  assert(lookup);
  const pendingLookup = () =>
    h.pending.findIndex((entry) =>
      entry.filters.some(
        (filter) =>
          filter.kinds?.includes(39000) && filter["#d"]?.includes("c"),
      ),
    );
  await vi.waitFor(() => expect(pendingLookup()).not.toBe(-1));
  const [request] = h.pending.splice(pendingLookup(), 1);
  assert(request);
  request.respond([metadata(relay, "c", "General", 1700000000, [["public"]])]);
  await lookup;
  expect(channels.get?.("c")?.viewerRole).toBeUndefined();
  expect(channels.get?.("c")?.visibility).toBe("public");
  expect(ownerMentions.confirmedOwnerSends(source, [id])).toEqual([id]);

  h.live().state({ status: "retrying", routes: [] });
  expect(channels.get?.("c")?.metadataCached).toBe(true);
  expect(ownerMentions.latest(source)).toBeNull();
  expect(ownerMentions.confirmedOwnerSends(source, [id])).toEqual([]);

  h.live().state({ status: "connected", routes: [] });
  h.live().receive([
    metadata(relay, "c", "General", 1700000002, [["private"]]),
  ]);
  expect(channels.get?.("c")).toBeUndefined();
  expect(ownerMentions.latest(source)).toBeNull();
  expect(ownerMentions.confirmedOwnerSends(source, [id])).toEqual([]);
});

it("retains a send acknowledged during a disconnect until channel metadata is fresh", async () => {
  const h = setup(false, true);
  h.live().state({ status: "connected", routes: [] });
  await h.members();
  const { ownerMentions, channels, messages, outbox } = h.session;
  assert(ownerMentions && outbox);
  const source = { channelId: "c", rootId: null };
  const acknowledgement = deferred<void>();
  h.publish.mockReturnValueOnce(acknowledgement.promise);
  const id = sendWithOwnerMentions(h.session, [honey.pubkey], () =>
    messages.send("c", "@Honey hello", [honey.pubkey]),
  );
  try {
    await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
    h.live().state({ status: "retrying", routes: [] });
    expect(channels.get?.("c")?.metadataCached).toBe(true);
  } finally {
    acknowledgement.resolve();
  }
  await vi.waitFor(() =>
    expect(outbox.snapshot()[0]?.delivery).toBe("accepted"),
  );
  expect(ownerMentions.latest(source)).toBeNull();
  expect(ownerMentions.confirmedOwnerSends(source, [id])).toEqual([]);

  h.live().state({ status: "connected", routes: [] });
  h.live().receive([metadata(relay, "c", "General", 1700000002)]);
  expect(channels.get?.("c")?.metadataCached).toBeUndefined();
  expect(ownerMentions.latest(source)?.eventId).toBe(id);
  expect(ownerMentions.confirmedOwnerSends(source, [id])).toEqual([id]);
});

it("advances owner mention evidence A to B to A only on confirmed human sends in the exact source", async () => {
  const h = setup(true, true);
  h.live().state({ status: "connected", routes: [] });
  await h.members();
  const { ownerMentions, outbox, messages } = h.session;
  assert(ownerMentions && outbox);
  const channel = { channelId: "c", rootId: null };
  const rootId = "1".repeat(64);
  const parentId = "2".repeat(64);
  const thread = { channelId: "c", rootId };
  const invocation = { channelId: "c", rootId: parentId };
  const observed = vi.fn(() => ownerMentions.latest(channel)?.eventId);
  const stop = ownerMentions.subscribe(observed);
  expect(ownerMentions.version).toBe(1);

  const a = sendWithOwnerMentions(h.session, [honey.pubkey], () =>
    messages.send("c", "@Honey first", [honey.pubkey]),
  );
  expect(ownerMentions.latest(channel)).toBeNull();
  await vi.waitFor(() =>
    expect(ownerMentions.latest(channel)).toMatchObject({
      eventId: a,
      recipientIds: [honey.pubkey],
    }),
  );

  // Automatic Solo routes and owner-signed raw posts use the same p tag.
  const inherited = messages.send("c", "continue", [namesake.pubkey]);
  const automation = outbox.send({
    kind: 9,
    content: "@Namesake automated",
    tags: [
      ["h", "c"],
      ["p", namesake.pubkey],
    ],
  });
  await vi.waitFor(() =>
    expect(h.publish.mock.calls.map(([event]) => event.id)).toEqual(
      expect.arrayContaining([inherited, automation]),
    ),
  );
  h.live().receive([
    signed(namesake, {
      kind: 9,
      content: "@Namesake agent relay",
      tags: [
        ["h", "c"],
        ["p", namesake.pubkey],
      ],
    }),
    signed(viewer, {
      kind: 9,
      content: "@Namesake older client",
      tags: [
        ["h", "c"],
        ["p", namesake.pubkey],
      ],
    }),
  ]);
  expect(ownerMentions.latest(channel)?.eventId).toBe(a);
  expect(observed).toHaveReturnedWith(a);
  expect(
    new Set(
      observed.mock.results.flatMap(({ value }) => (value ? [value] : [])),
    ),
  ).toEqual(new Set([a]));

  const plain = sendWithOwnerMentions(h.session, [], () =>
    messages.send("c", "An ordinary owner update"),
  );
  const candidates = [automation, plain, inherited, a];
  await vi.waitFor(() =>
    expect(ownerMentions.confirmedOwnerSends(channel, candidates)).toEqual([
      plain,
      a,
    ]),
  );
  expect(ownerMentions.confirmedOwnerSends(thread, candidates)).toEqual([]);
  expect(
    ownerMentions.confirmedOwnerSends(
      { channelId: "c", rootId: plain },
      candidates,
    ),
  ).toEqual([plain]);
  expect(
    ownerMentions.confirmedOwnerSends(channel, Array(129).fill(plain)),
  ).toEqual([]);
  expect(ownerMentions.latest(channel)?.eventId).toBe(a);

  const b = sendWithOwnerMentions(h.session, [namesake.pubkey], () =>
    messages.send("c", "@Namesake second", [namesake.pubkey]),
  );
  await vi.waitFor(() =>
    expect(ownerMentions.latest(channel)).toMatchObject({
      eventId: b,
      recipientIds: [namesake.pubkey],
    }),
  );
  expect(ownerMentions.latest(channel, [honey.pubkey])).toMatchObject({
    eventId: a,
    recipientIds: [honey.pubkey],
  });
  expect(ownerMentions.latest(channel, [viewer.pubkey])).toBeNull();
  await vi.waitFor(() => expect(observed).toHaveReturnedWith(b));
  const reply = sendWithOwnerMentions(h.session, [honey.pubkey], () =>
    messages.reply("c", rootId, "@Honey thread", [honey.pubkey]),
  );
  await vi.waitFor(() =>
    expect(ownerMentions.latest(thread)?.eventId).toBe(reply),
  );
  const nested = sendWithOwnerMentions(h.session, [namesake.pubkey], () =>
    messages.reply(
      "c",
      rootId,
      "@Namesake invocation",
      [namesake.pubkey],
      [],
      parentId,
    ),
  );
  await vi.waitFor(() =>
    expect(ownerMentions.latest(invocation)?.eventId).toBe(nested),
  );
  expect(ownerMentions.latest(thread)?.eventId).toBe(reply);
  expect(
    ownerMentions.latest({ channelId: "other", rootId: parentId }),
  ).toBeNull();
  expect(ownerMentions.latest(channel)?.eventId).toBe(b);
  const back = sendWithOwnerMentions(h.session, [honey.pubkey], () =>
    messages.send("c", "@Honey third", [honey.pubkey]),
  );
  await vi.waitFor(() =>
    expect(ownerMentions.latest(channel)).toMatchObject({
      eventId: back,
      recipientIds: [honey.pubkey],
    }),
  );
  expect(ownerMentions.latest(channel)?.createdAtMs).toBeGreaterThan(
    ownerMentions.latest({ channelId: "c", rootId: a })?.createdAtMs ??
      Infinity,
  );
  stop();
});

it("keeps a confirmed owner mention through session replacement and ignores older replay", async () => {
  const store = createOwnerMentionStore(viewer.pubkey);
  const source = { channelId: "c", rootId: null };
  const first = setup(false, true, undefined, store);
  const dm = metadata(relay, "c", "Honey", 1700000000, [
    ["t", "dm"],
    ["private"],
  ]);
  await first.members([viewer.pubkey, honey.pubkey], 1700000000, relay, dm);
  await first.agentProfile(honey);
  const automatic = first.session.messages.send("c", "no explicit mention");
  await vi.waitFor(() =>
    expect(first.publish.mock.calls[0]?.[0]).toMatchObject({
      id: automatic,
      tags: expect.arrayContaining([["p", honey.pubkey]]),
    }),
  );
  expect(first.session.ownerMentions?.latest(source)).toBeNull();
  const explicit = sendWithOwnerMentions(first.session, [honey.pubkey], () =>
    first.session.messages.send("c", "@Honey next", [honey.pubkey]),
  );
  await vi.waitFor(() =>
    expect(first.session.ownerMentions?.latest(source)?.eventId).toBe(explicit),
  );
  const received = deferred<RelayEvent>();
  const acknowledgement = deferred<void>();
  first.publish.mockImplementationOnce(async (event) => {
    received.resolve(event);
    await acknowledgement.promise;
  });
  const interrupted = sendWithOwnerMentions(first.session, [honey.pubkey], () =>
    first.session.messages.send("c", "@Honey while reconnecting", [
      honey.pubkey,
    ]),
  );
  let replayed: RelayEvent;
  try {
    replayed = await received.promise;
    expect(first.session.ownerMentions?.latest(source)?.eventId).toBe(explicit);
  } finally {
    first.dispose();
    acknowledgement.resolve();
  }
  expect(first.session.ownerMentions?.latest(source)).toBeNull();

  const second = setup(false, true, undefined, store);
  expect(second.session.ownerMentions?.latest(source)).toBeNull();
  const observed = vi.fn(
    () => second.session.ownerMentions?.latest(source)?.eventId,
  );
  second.session.ownerMentions?.subscribe(observed);
  await second.members([viewer.pubkey, honey.pubkey], 1700000000, relay, dm);
  await vi.waitFor(() => expect(observed).toHaveReturnedWith(explicit));
  observed.mockClear();
  second.live().receive([
    replayed,
    ...first.publish.mock.calls
      .slice(0, 2)
      .map(([event]) => event)
      .reverse(),
  ]);
  expect(second.session.ownerMentions?.latest(source)?.eventId).toBe(
    interrupted,
  );
  await vi.waitFor(() => expect(observed).toHaveReturnedWith(interrupted));
  expect(
    second.session.ownerMentions?.confirmedOwnerSends(source, [
      explicit,
      automatic,
      interrupted,
    ]),
  ).toEqual([explicit, interrupted]);
  await second.members([honey.pubkey], 1700000001, relay, dm);
  expect(second.session.ownerMentions?.latest(source)).toBeNull();
  expect(
    second.session.ownerMentions?.confirmedOwnerSends(source, [
      explicit,
      interrupted,
    ]),
  ).toEqual([]);
});

it.each([false, true])(
  "publishes exact selected keys through real session/outbox for reply=%s, deduplicating keys not names",
  async (reply) => {
    const h = setup();
    await h.members();
    const keys = [honey.pubkey, honey.pubkey, namesake.pubkey];
    const root = "a".repeat(64);
    const id = reply
      ? h.session.messages.reply("c", root, "@Honey @Honey help", keys)
      : h.session.messages.send("c", "@Honey @Honey help", keys);
    await flush();
    const event = h.publish.mock.calls[0]?.[0];
    expect(event?.id).toBe(id);
    expect(event?.tags.filter(([tag]) => tag !== "client-id")).toEqual([
      ["h", "c"],
      ...(reply ? [["e", root, "", "reply"]] : []),
      ["p", honey.pubkey],
      ["p", namesake.pubkey],
      ["ms", expect.stringMatching(/^(0|[1-9]\d{0,2})$/)],
    ]);
    expect(h.sign).toHaveBeenCalledTimes(1);
    // Actual publication acknowledgement is not execution completion.
    expect(h.session.outbox?.snapshot()[0]?.delivery).toBe("accepted");
  },
);

it.each([
  ["reply", 9, 9],
  ["forward", 9, 9],
  ["reply", 40002, 9],
  ["forward", 9, 40002],
] as const)(
  "signs invocation intent for an opted-in owned recipient in a %s to kinds %i/%i and keeps it on retry",
  async (kind, rootKind, parentKind) => {
    const origin = "https://relay.example.test";
    const local = localAgentsFixture([
      {
        pubkey: honey.pubkey,
        name: "Honey",
        relayUrl: origin,
        owner: viewer.pubkey,
      },
    ]);
    const invocationIntent = vi.fn<(input: AgentInvocationIntent) => boolean>(
      () => true,
    );
    const h = setup(false, true, local);
    replyInvocationIntents.set(h.session, invocationIntent);
    await h.members(
      undefined,
      undefined,
      undefined,
      metadata(relay, "c", "General", undefined, [["t", "stream"]]),
    );
    h.live().state({ status: "connected", routes: [] });
    const root = eventDto(
      signed(viewer, {
        kind: rootKind,
        content: "Discussion",
        created_at: 1700000001,
        tags: [["h", "c"]],
      }),
    );
    const parent = eventDto(
      signed(namesake, {
        kind: parentKind,
        content: "Earlier reply",
        created_at: 1700000002,
        tags: [
          ["h", "c"],
          ["e", root.id, "", "reply"],
        ],
      }),
    );
    h.live().receive([root, parent], { phase: "live", channelId: "c" });
    h.publish.mockRejectedValueOnce(new PublishRejected("try again"));
    const tags = ["buzz:invocation-intent", "1", honey.pubkey];
    const send = (content: string, mentions: readonly string[]) => {
      if (kind === "reply")
        return h.session.messages.reply(
          "c",
          root.id,
          content,
          mentions,
          [],
          parent.id,
        );
      const row = foldMessages("c", viewer.pubkey, [root])[0];
      assert.exists(row);
      return h.session.messages.forward(
        "c",
        row,
        "Author",
        content,
        undefined,
        {
          rootId: root.id,
          parentId: parent.id,
          mentions,
        },
      );
    };
    const id = send("Please take this", [honey.pubkey, namesake.pubkey]);
    await vi.waitFor(() =>
      expect(
        h.session.outbox?.snapshot().find((item) => item.event.id === id)
          ?.delivery,
      ).toBe("failed"),
    );
    const first = eventDto(structuredClone(h.publish.mock.calls[0]?.[0]));
    expect(first).toMatchObject({ id, pubkey: viewer.pubkey, kind: 9 });
    expect(first.tags).toEqual(
      expect.arrayContaining([
        ["h", "c"],
        ["e", root.id, "", "root"],
        ["e", parent.id, "", "reply"],
        ["p", honey.pubkey],
        ["p", namesake.pubkey],
        tags,
      ]),
    );
    expect(
      first.tags.filter(([name]) => name === "buzz:invocation-intent"),
    ).toEqual([tags]);
    expect(invocationIntent).toHaveBeenCalledExactlyOnceWith({
      communityOrigin: origin,
      owner: viewer.pubkey,
      source: { channelId: "c", root: root.id },
      agentPubkey: honey.pubkey,
    });

    replyInvocationIntents.delete(h.session);
    h.session.messages.retry(id);
    await vi.waitFor(() =>
      expect(
        h.session.outbox?.snapshot().find((item) => item.event.id === id)
          ?.delivery,
      ).toBe("accepted"),
    );
    expect(h.publish.mock.calls[1]?.[0]).toEqual(first);
    expect(h.sign).toHaveBeenCalledTimes(1);

    send("Legacy reply", [honey.pubkey]);
    await vi.waitFor(() => expect(h.publish).toHaveBeenCalledTimes(3));
    expect(h.publish.mock.calls[2]?.[0].tags).not.toContainEqual(tags);
  },
);
it("mentions a just-added member despite an older replica roster", async () => {
  const h = setup();
  await h.members([viewer.pubkey]);
  h.lagReplica();
  await h.members([viewer.pubkey, honey.pubkey], 1700000001);
  const id = h.session.messages.send("c", "@Honey help", [honey.pubkey]);
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
  expect(h.publish.mock.calls[0]?.[0].id).toBe(id);
  expect(h.publish.mock.calls[0]?.[0].tags).toContainEqual(["p", honey.pubkey]);
});

it("typed names create no recipient tags; unconfirmed or forged membership cannot grant mention permission", async () => {
  const h = setup();
  expect(() => h.session.messages.send("c", "@Honey", [honey.pubkey])).toThrow(
    /membership/,
  );
  await h.members(undefined, 1700000000, namesake);
  expect(() => h.session.messages.send("c", "@Honey", [honey.pubkey])).toThrow(
    "You don’t have write access to this conversation.",
  );
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
  await h.members();
  expect(() => h.session.messages.send("c", "@Honey", ["not-a-key"])).toThrow(
    /valid/,
  );
  h.session.messages.send("c", "@Honey");
  await flush();
  expect(
    h.publish.mock.calls[0]?.[0].tags.filter(([tag]) => tag !== "client-id"),
  ).toEqual([
    ["h", "c"],
    ["ms", expect.stringMatching(/^(0|[1-9]\d{0,2})$/)],
  ]);
});
it("publishes roster changes even when channel names/previews are unchanged and rejects a removed recipient", async () => {
  const h = setup();
  await h.members();
  const before = h.session.channels.list();
  await h.members([viewer.pubkey, namesake.pubkey], 1700000001);
  expect(h.session.channels.list()).not.toBe(before);
  expect(h.session.channels.list().channels[0]?.members).toEqual(
    [viewer.pubkey, namesake.pubkey].sort(),
  );
  expect(() => h.session.messages.send("c", "@Honey", [honey.pubkey])).toThrow(
    /no longer/,
  );
  expect(() =>
    h.session.messages.reply("c", "a".repeat(64), "@Honey", [honey.pubkey]),
  ).toThrow(/no longer/);
  expect(h.sign).not.toHaveBeenCalled();
});
it("membership loss while signing blocks publication; retry checks again without silently replacing the recipient", async () => {
  const h = setup();
  await h.members();
  h.hold();
  const id = h.session.messages.send("c", "@Honey", [honey.pubkey]);
  await flush();
  expect(h.sign).toHaveBeenCalledTimes(1);
  await h.members([viewer.pubkey, namesake.pubkey], 1700000001);
  h.release();
  await flush();
  expect(h.publish).not.toHaveBeenCalled();
  expect(h.session.outbox?.snapshot()[0]).toMatchObject({ delivery: "failed" });
  h.session.messages.retry(id);
  await flush();
  expect(h.publish).not.toHaveBeenCalled();
  await h.members(undefined, 1700000002);
  h.session.messages.retry(id);
  await flush();
  expect(h.publish.mock.calls[0]?.[0].tags).toContainEqual(["p", honey.pubkey]);
});
it("raw outbox writes cannot bypass the pre-sign membership check", async () => {
  const h = setup();
  await h.members([viewer.pubkey]);
  assert.exists(h.session.outbox);
  h.session.outbox.send({
    kind: 9,
    content: "@Honey",
    tags: [
      ["h", "c"],
      ["p", honey.pubkey],
    ],
  });
  await flush();
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
  expect(h.session.outbox?.snapshot()[0]?.delivery).toBe("failed");
});
it("disposal during signing fences publication to a retired session", async () => {
  const h = setup();
  await h.members();
  h.hold();
  h.session.messages.send("c", "@Honey", [honey.pubkey]);
  await flush();
  h.dispose();
  h.release();
  await flush();
  expect(h.publish).not.toHaveBeenCalled();
});

it.each([false, true])(
  "preserves an independent caller's explicit Solo chat recipients, reply=%s",
  async (reply) => {
    const h = setup(true);
    await h.members([viewer.pubkey, honey.pubkey]);
    await h.agentProfile(honey);
    const send = (mentions: readonly string[]) =>
      reply
        ? h.session.messages.reply("c", "a".repeat(64), "Keep going", mentions)
        : h.session.messages.send("c", "Keep going", mentions);
    send([]);
    await flush();
    expect(
      h.publish.mock.calls[0]?.[0].tags.filter(([name]) => name === "p"),
    ).toEqual([]);
    send([honey.pubkey]);
    await flush();
    expect(
      h.publish.mock.calls.at(-1)?.[0].tags.filter(([name]) => name === "p"),
    ).toEqual([["p", honey.pubkey]]);
    expect(h.publish).toHaveBeenCalledTimes(2);
  },
);

it.each([true])(
  "publishes nonmember references without addressed tags, reply=%s",
  async (reply) => {
    const h = setup();
    await h.members([viewer.pubkey, honey.pubkey]);
    const root = "f".repeat(64);
    if (reply)
      h.session.messages.reply(
        "c",
        root,
        "@Honey and @Outside",
        [honey.pubkey],
        [],
        undefined,
        [namesake.pubkey],
      );
    else
      h.session.messages.send(
        "c",
        "@Honey and @Outside",
        [honey.pubkey],
        [],
        undefined,
        [namesake.pubkey],
      );
    await flush();
    const event = h.publish.mock.calls[0]?.[0];
    expect(event?.tags).toContainEqual(["p", honey.pubkey]);
    expect(event?.tags).toContainEqual(["mention", namesake.pubkey]);
    expect(event?.tags).not.toContainEqual(["p", namesake.pubkey]);
    expect(() =>
      h.session.messages.send("c", "@Outside", [namesake.pubkey]),
    ).toThrow(/no longer a channel member/);
    expect(() =>
      h.session.messages.send("c", "@Outside", [], [], undefined, ["invalid"]),
    ).toThrow(/valid mention references/);
  },
);

it.each([false, true])(
  "asks a mentioned agent for a model and effort, and only a mentioned one, reply=%s",
  async (reply) => {
    const h = setup();
    await h.members([viewer.pubkey, honey.pubkey]);
    const root = "f".repeat(64);
    const post = (
      picks: Record<string, { model?: string; effort?: string }>,
    ) =>
      reply
        ? h.session.messages.reply(
            "c",
            root,
            "@Honey",
            [honey.pubkey],
            [],
            undefined,
            [],
            picks,
          )
        : h.session.messages.send(
            "c",
            "@Honey",
            [honey.pubkey],
            [],
            undefined,
            [],
            picks,
          );
    post({
      [honey.pubkey]: { model: "claude-fable-5-1[1m]", effort: "xhigh" },
    });
    await flush();
    const tags = h.publish.mock.calls[0]?.[0]?.tags;
    expect(tags).toContainEqual([
      "model",
      honey.pubkey,
      "claude-fable-5-1[1m]",
    ]);
    expect(tags).toContainEqual(["effort", honey.pubkey, "xhigh"]);
    // goose catalogs name models by their provider: `openrouter`'s `vendor/…`.
    post({ [honey.pubkey]: { model: "anthropic/claude-sonnet-5-5" } });
    await flush();
    expect(h.publish.mock.calls[1]?.[0]?.tags).toContainEqual([
      "model",
      honey.pubkey,
      "anthropic/claude-sonnet-5-5",
    ]);
    expect(() => post({ [namesake.pubkey]: { effort: "high" } })).toThrow(
      /addressed agent/,
    );
    expect(() => post({ [honey.pubkey]: { effort: "High Effort" } })).toThrow(
      /addressed agent/,
    );
    expect(() => post({ [honey.pubkey]: { model: "two words" } })).toThrow(
      /addressed agent/,
    );
  },
);

it("asks a one-to-one DM's other member for a model and effort without a mention", async () => {
  const h = setup();
  const read = h.session.read([
    { kinds: [39002, 39000], "#d": ["c"], limit: 10 },
  ]);
  let pending = h.next();
  while (!pending.filters.some((filter) => filter.kinds?.includes(39002))) {
    pending.respond([]);
    await flush();
    pending = h.next();
  }
  pending.respond([
    roster(relay, "c", [viewer.pubkey, honey.pubkey]),
    metadata(relay, "c", "Honey", 1700000000, [["t", "dm"], ["private"]]),
  ]);
  await read;
  h.session.messages.send("c", "think hard", [], [], undefined, [], {
    [honey.pubkey]: { effort: "high" },
  });
  await flush();
  const tags = h.publish.mock.calls[0]?.[0]?.tags;
  expect(tags).toContainEqual(["effort", honey.pubkey, "high"]);
  expect(tags).not.toContainEqual(["p", honey.pubkey]);
  expect(() =>
    h.session.messages.send("c", "think hard", [], [], undefined, [], {
      [namesake.pubkey]: { effort: "high" },
    }),
  ).toThrow(/addressed agent/);
});

it("queues a plain one-to-one DM message to an agent while the live stream reconnects, and checks membership fresh before publishing", async () => {
  const h = setup(false, true);
  h.live().state({ status: "connected", routes: [] });
  await h.members(
    [viewer.pubkey, honey.pubkey],
    1700000000,
    relay,
    metadata(relay, "c", "Honey", 1700000000, [["t", "dm"], ["private"]]),
  );
  await h.agentProfile(honey);
  h.live().state({ status: "retrying", routes: [] });
  // The agent partner's implicit tag no longer blocks queueing.
  const id = h.session.messages.send("c", "hello");
  await flush();
  const event = h.publish.mock.calls[0]?.[0];
  expect(event?.id).toBe(id);
  expect(event?.tags).toContainEqual(["p", honey.pubkey]);
  // Publication still reads the roster fresh: a partner who has left is refused.
  h.setRoster([viewer.pubkey]);
  const refused = h.session.messages.send("c", "still there?");
  await flush();
  expect(h.publish).toHaveBeenCalledTimes(1);
  expect(
    h.session.outbox?.snapshot().find((item) => item.event.id === refused),
  ).toMatchObject({
    delivery: "failed",
    // The fresh roster no longer lists them, so they are not the DM partner.
    error: expect.stringMatching(/channel membership/),
  });
});

it("refuses at signing a recipient whose Delete started after the send began", async () => {
  const agent = {
    pubkey: honey.pubkey,
    name: "Honey",
    relayUrl: "wss://relay.example.test",
    owner: viewer.pubkey,
  };
  const agents = localAgentsFixture([agent]);
  const h = setup(false, false, agents);
  await h.members([viewer.pubkey, honey.pubkey]);
  expect(h.session.agentChoices.snapshot().identities).toContainEqual(
    expect.objectContaining({ pubkey: honey.pubkey }),
  );
  // Admitted at send; its Delete starts before the event is signed.
  h.session.messages.send("c", "@Honey", [honey.pubkey]);
  agents.set({ agents: [{ ...agent, deleting: true }] });
  await flush();
  expect(h.publish).not.toHaveBeenCalled();
  expect(h.session.outbox?.snapshot()).toMatchObject([
    {
      delivery: "failed",
      error: expect.stringMatching(/being deleted/),
    },
  ]);
});

it("still confirms an event signed before its recipient's Delete started", async () => {
  const agent = {
    pubkey: honey.pubkey,
    name: "Honey",
    relayUrl: "wss://relay.example.test",
    owner: viewer.pubkey,
  };
  const agents = localAgentsFixture([agent]);
  const h = setup(false, false, agents);
  await h.members([viewer.pubkey, honey.pubkey]);
  // Signed and sent, with an outcome the relay never confirmed.
  h.publish.mockRejectedValueOnce(
    new Error("Relay delivery could not be confirmed"),
  );
  const id = h.session.messages.send("c", "@Honey", [honey.pubkey]);
  await flush();
  expect(h.publish).toHaveBeenCalledOnce();
  agents.set({ agents: [{ ...agent, deleting: true }] });
  h.session.outbox?.retry(id);
  await flush();
  expect(h.publish).toHaveBeenCalledTimes(2);
  expect(h.publish.mock.calls[1]?.[0].id).toBe(id);
});

it("still requires a connected live stream to mention anyone else while it reconnects", async () => {
  const h = setup(false, true);
  h.live().state({ status: "connected", routes: [] });
  await h.members([viewer.pubkey, honey.pubkey, namesake.pubkey]);
  h.live().state({ status: "retrying", routes: [] });
  expect(() => h.session.messages.send("c", "@Honey", [honey.pubkey])).toThrow(
    /Refresh channel membership/,
  );
  // A plain message with no mention queues as before.
  h.session.messages.send("c", "hello");
  await flush();
  expect(h.publish).toHaveBeenCalledTimes(1);
});

it.each(mentionConformance.tags.write)(
  "conforms to the portable mention tag writing contract: $name",
  async (fixture) => {
    const h = setup();
    // The sender must be a member; fixtures list only the other members.
    await h.members([viewer.pubkey, ...fixture.members]);
    const send = () =>
      h.session.messages.send(
        "c",
        "@Someone",
        fixture.recipients,
        [],
        undefined,
        fixture.references,
      );
    const expected = fixture.expected;
    if ("error" in expected) {
      expect(send).toThrow(
        {
          not_member: /no longer a channel member/,
          invalid: /valid mention/,
          too_many: /at most 32/,
        }[expected.error],
      );
      return;
    }
    send();
    await flush();
    const event = h.publish.mock.calls[0]?.[0];
    expect(
      event?.tags.filter(([name]) => name === "p" || name === "mention"),
    ).toEqual(expected.tags);
  },
);
