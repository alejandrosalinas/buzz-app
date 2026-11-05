import { assert, afterEach, expect, it, vi } from "vitest";
import type { EventTemplate } from "nostr-tools";
import type { RelayEvent } from "./events";
import type { LiveCallbacks } from "./live";
import { createRelaySession } from "./session";
import { mentionConformance } from "../../bundled/mentions/mention-rules.conformance";
import {
  flush,
  keypair,
  metadata,
  roster,
  scriptedTransport,
  signed,
} from "./testing";

const viewer = keypair(),
  relay = keypair(),
  honey = keypair(),
  namesake = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
function setup(soloMode = false, withLive = false) {
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
        if (
          (soloMode || profileEvents.length) &&
          filters.every((filter) => filter.kinds?.every((kind) => kind === 0))
        )
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
      expect(
        pending.filters.every((filter) =>
          filter.kinds?.every((kind) => kind === 0),
        ),
      ).toBe(true);
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
