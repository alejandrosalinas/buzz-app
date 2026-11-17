import { assert, afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { keypair, metadata, ownedProfile, signed } from "./testing";
import { matchesEvent } from "./projection";
import { SOLO_LABEL } from "../solo/labels";
import { soloAdminKey } from "./solo-admins";
import { validateMemberAdministrationTemplate } from "../channel-members/administration-protocol";
import { PublishRejected, type OutgoingEvent } from "./outbox";
import { eventDto, type ReadFilter, type RelayEvent } from "./events";
import type { EventTemplate } from "nostr-tools";

const sessions: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});

function setup() {
  const viewer = keypair(),
    relay = keypair();
  const channel = crypto.randomUUID();
  const agentKeys = [keypair(), keypair()] as const;
  const agents: [string, string] = [agentKeys[0].pubkey, agentKeys[1].pubkey];
  const workspaceKey = keypair();
  const workspaceAgent = workspaceKey.pubkey;
  const profiles = Promise.all(
    [...agentKeys, workspaceKey].map((key) => ownedProfile(key, viewer)),
  );
  let beforeLock = async () => {};
  const profileOverrides = new Map<string, RelayEvent>();
  let omitProfiles = false;
  let failProfiles = false;
  let journal: readonly OutgoingEvent[] = [];
  const events = new Map<string, RelayEvent>();
  const roles = new Map<string, string>();
  const genericPublish = vi.fn(async (event: RelayEvent) => {
    if (event.kind === 9000)
      throw new Error("Elevated commands require their dedicated host route");
    events.set(event.id, event);
    if (event.kind === 9007) {
      roles.set(viewer.pubkey, "owner");
      for (const [tag, key] of event.tags)
        if (tag === "p" && key) roles.set(key, "member");
    }
  });
  const adminPublish = vi.fn(async (event: RelayEvent) => {
    validateMemberAdministrationTemplate(event, viewer.pubkey);
    if (events.has(event.id)) return;
    events.set(event.id, event);
    const agent = event.tags.find(([tag]) => tag === "p")?.[1];
    assert.exists(agent);
    roles.set(agent, "admin");
  });
  const transport = {
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    channelIdentity: true as const,
    media: () => undefined,
    query: async (filters: readonly ReadFilter[]) => {
      if (failProfiles && filters.some((filter) => filter.kinds?.includes(0)))
        throw new Error("Profile read unavailable");
      const roster = signed(relay, {
        kind: 39002,
        content: "",
        tags: [
          ["d", channel],
          ...[...roles].map(([key, role]) => ["p", key, "", role]),
        ],
      });
      return [
        ...(omitProfiles ? [] : await profiles).map((profile) =>
          eventDto(profileOverrides.get(profile.pubkey) ?? profile),
        ),
        ...events.values(),
        ...(roles.size
          ? [
              roster,
              metadata(relay, channel, "Work", Math.floor(Date.now() / 1000), [
                ["t", "stream"],
                ["private"],
                ["t", SOLO_LABEL],
                ["P", viewer.pubkey],
              ]),
            ]
          : []),
      ].filter((event) =>
        filters.some((filter) => matchesEvent(event, filter)),
      );
    },
    writer: {
      kinds: [9, 9000, 9007],
      sign: async (template: EventTemplate) => signed(viewer, template),
      publish: genericPublish,
    },
    memberAdministration: {
      sign: async (template: EventTemplate) => {
        validateMemberAdministrationTemplate(template, viewer.pubkey);
        return signed(viewer, template);
      },
      publish: adminPublish,
    },
  };
  const open = async () => {
    const owner = createRelaySession(transport, {
      outboxStorage: {
        async lock(_id, run) {
          await beforeLock();
          return run();
        },
        load: () => structuredClone(journal),
        save: (next) => {
          journal = structuredClone(next);
        },
      },
    });
    sessions.push(owner);
    await owner.session.outbox?.ready();
    owner.session.channels.ensureList();
    await vi.waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
    return owner;
  };
  const start = (owner: Awaited<ReturnType<typeof open>>) => {
    const creation = owner.session.channelWrites.start(
      channel,
      "Work",
      [...agents, workspaceAgent],
      undefined,
      false,
      undefined,
      { admins: [...agents, workspaceAgent] },
    );
    void creation.ready.catch(() => {});
    const message = owner.session.messages.send(
      channel,
      "Work on this",
      agents,
    );
    return { creation, message };
  };
  return {
    channel,
    viewer,
    async transferAgent(
      owner: Awaited<ReturnType<typeof open>>,
      index: number,
      receive = true,
    ) {
      const agent = agentKeys[index];
      assert.exists(agent);
      const profile = await ownedProfile(agent, keypair());
      const previous = (await profiles).find(
        (event) => event.pubkey === agent.pubkey,
      );
      assert.exists(previous);
      const changed = signed(agent, {
        ...profile,
        created_at: previous.created_at + 1,
      });
      profileOverrides.set(agent.pubkey, changed);
      if (!receive) return;
      await owner.session.read(
        [{ kinds: [0], authors: [agent.pubkey], limit: 1 }],
        { fresh: true },
      );
      expect(owner.session.profiles.event?.(agent.pubkey)?.id).toBe(changed.id);
    },
    omitProfiles: () => {
      omitProfiles = true;
    },
    failProfiles: () => {
      failProfiles = true;
    },
    beforeLock: (run: () => Promise<void>) => {
      beforeLock = run;
    },
    agents,
    workspaceAgent,
    roles,
    events,
    genericPublish,
    adminPublish,
    transport,
    open,
    start,
  };
}

it("confirms a lost grant ACK and holds the opening message and local wake until every admin is ready", async () => {
  const h = setup();
  const owner = await h.open();
  const heard = vi.fn();
  owner.session.subscribeLive(heard, { replay: true });
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const publish = h.adminPublish.getMockImplementation();
  assert.exists(publish);
  h.adminPublish
    .mockImplementationOnce(async (event) => {
      await publish(event);
      throw new Error("ACK lost");
    })
    .mockImplementationOnce(async (event) => {
      await held;
      await publish(event);
    });
  try {
    const { message } = h.start(owner);
    await vi.waitFor(() => expect(h.adminPublish).toHaveBeenCalledTimes(2));
    expect(h.roles.get(h.agents[0])).toBe("admin");
    expect(h.roles.get(h.agents[1])).toBe("member");
    expect(h.genericPublish.mock.calls.map(([event]) => event.kind)).toEqual([
      9007,
    ]);
    expect(heard).not.toHaveBeenCalled();
    expect(
      owner.session.outbox
        ?.snapshot()
        .some((item) => item.recovery?.key === soloAdminKey(h.channel)),
    ).toBe(true);
    release();
    await vi.waitFor(() => expect(h.events.has(message)).toBe(true));
    expect(h.agents.map((key) => h.roles.get(key))).toEqual(["admin", "admin"]);
    expect(h.roles.get(h.workspaceAgent)).toBe("admin");
    expect(h.roles.get(h.viewer.pubkey)).toBe("owner");
    expect(h.adminPublish).toHaveBeenCalledTimes(3);
    expect(h.adminPublish.mock.calls.map(([event]) => event.tags)).toEqual(
      [...h.agents, h.workspaceAgent].map((key) => [
        ["h", h.channel],
        ["p", key],
        ["role", "admin"],
      ]),
    );
    const create = h.genericPublish.mock.calls.find(
      ([event]) => event.kind === 9007,
    )?.[0];
    assert.exists(create);
    expect(
      h.adminPublish.mock.calls.every(
        ([event]) =>
          event.pubkey === h.viewer.pubkey &&
          event.created_at === create.created_at,
      ),
    ).toBe(true);
    expect(
      owner.session.outbox
        ?.snapshot()
        .some((item) => item.recovery?.key === soloAdminKey(h.channel)),
    ).toBe(false);
  } finally {
    release();
  }
});

it("resumes a partial setup from the durable outbox after restart without restoring a later demotion", async () => {
  const h = setup();
  const first = await h.open();
  const publish = h.adminPublish.getMockImplementation();
  assert.exists(publish);
  h.adminPublish
    .mockImplementationOnce(publish)
    .mockRejectedValueOnce(new Error("offline"));
  const { message } = h.start(first);
  await vi.waitFor(() =>
    expect(
      first.session.outbox?.snapshot().find((item) => item.event.id === message)
        ?.delivery,
    ).toBe("failed"),
  );
  expect(h.events.has(message)).toBe(false);
  h.roles.set(h.agents[0], "bot");
  first.dispose();
  const resumed = await h.open();
  resumed.session.outbox?.retry(message);
  await vi.waitFor(() => expect(h.events.has(message)).toBe(true));
  expect(h.roles.get(h.agents[0])).toBe("bot");
  expect(h.roles.get(h.agents[1])).toBe("admin");
  expect(
    h.adminPublish.mock.calls.filter(
      ([event]) => event.tags[1]?.[1] === h.agents[0],
    ),
  ).toHaveLength(1);
  const second = h.adminPublish.mock.calls.filter(
    ([event]) => event.tags[1]?.[1] === h.agents[1],
  );
  expect(second).toHaveLength(2);
  expect(second[0]?.[0].id).toBe(second[1]?.[0].id);
  expect(
    h.genericPublish.mock.calls.filter(([event]) => event.kind === 9),
  ).toHaveLength(1);
});

it("abandons expired setup while signing is held without granting or releasing its message", async () => {
  const h = setup();
  const sign = h.transport.memberAdministration.sign;
  let release = () => {};
  let started = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const signing = new Promise<void>((resolve) => {
    started = resolve;
  });
  h.transport.memberAdministration.sign = async (template) => {
    started();
    await held;
    return sign(template);
  };
  const owner = await h.open();
  const clock = vi.spyOn(Date, "now");
  try {
    const { message } = h.start(owner);
    await signing;
    const outbox = owner.session.outbox;
    assert.exists(outbox);
    const receipt = outbox
      .snapshot()
      .find((item) => item.recovery?.key === soloAdminKey(h.channel));
    assert.exists(receipt);
    const active = owner.session.channelWrites.prepareOpening(h.channel);
    assert.exists(active);
    const outcome = active.then(
      () => undefined,
      (error: unknown) => error,
    );
    clock.mockReturnValue(Date.now() + 16 * 60 * 1000);
    await outbox.dismiss(receipt.event.id, receipt.recovery);
    release();
    const error = await outcome;
    expect(h.adminPublish).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(Error);
    expect(h.agents.map((key) => h.roles.get(key))).toEqual([
      "member",
      "member",
    ]);
    expect(h.events.has(message)).toBe(false);
    await vi.waitFor(() =>
      expect(
        outbox.snapshot().find((item) => item.event.id === message)?.delivery,
      ).toBe("failed"),
    );
    const oldMessage = outbox
      .snapshot()
      .find((item) => item.event.id === message);
    assert.exists(oldMessage);
    assert.exists(oldMessage.event.created_at);
    expect(oldMessage.event.created_at).toBeLessThan(
      Date.now() / 1000 - 15 * 60,
    );
    // Model the relay's timestamp rejection: Retry preserves the old event.
    h.genericPublish.mockRejectedValueOnce(
      new PublishRejected("Event too old"),
    );
    outbox.retry(message);
    await vi.waitFor(() =>
      expect(
        outbox.snapshot().find((item) => item.event.id === message),
      ).toMatchObject({
        delivery: "failed",
        error: "Event too old",
      }),
    );
    expect(h.genericPublish.mock.lastCall?.[0]).toEqual(oldMessage.signed);
    const fresh = owner.session.messages.send(
      h.channel,
      "Continue with current roles",
      h.agents,
    );
    await vi.waitFor(() => expect(h.events.has(fresh)).toBe(true));
    expect(h.events.has(message)).toBe(false);
    expect(
      outbox.snapshot().find((item) => item.event.id === message)?.event,
    ).toEqual(oldMessage.event);
    expect(h.adminPublish).not.toHaveBeenCalled();
  } finally {
    release();
    clock.mockRestore();
  }
});

it.each(["transferred", "missing", "unavailable"] as const)(
  "refreshes cached ownership before opening grants when the relay profile is %s",
  async (change) => {
    const h = setup();
    const owner = await h.open();
    await owner.session.profiles.ensure(h.agents);
    const cached = owner.session.profiles.event?.(h.agents[0]);
    assert.exists(cached);
    if (change === "transferred") await h.transferAgent(owner, 0, false);
    else if (change === "missing") h.omitProfiles();
    else h.failProfiles();
    expect(owner.session.profiles.event?.(h.agents[0])).toBe(cached);
    const { creation, message } = h.start(owner);
    await creation.ready;
    await expect(
      owner.session.channelWrites.prepareOpening(h.channel),
    ).rejects.toThrow(
      change === "unavailable"
        ? "Profile read unavailable"
        : "not verified as owned",
    );
    expect(h.adminPublish).not.toHaveBeenCalled();
    expect(h.events.has(message)).toBe(false);
    expect(
      owner.session.outbox
        ?.snapshot()
        .some((item) => item.recovery?.key === soloAdminKey(h.channel)),
    ).toBe(true);
  },
);

it("checks the current profile inside the shared publication lock after signing", async () => {
  const h = setup();
  const owner = await h.open();
  const sign = h.transport.memberAdministration.sign;
  h.transport.memberAdministration.sign = async (template) => {
    const event = await sign(template);
    h.beforeLock(async () => {
      h.beforeLock(async () => {});
      await h.transferAgent(owner, 0);
    });
    return event;
  };
  const { creation, message } = h.start(owner);
  await creation.ready;
  await expect(
    owner.session.channelWrites.prepareOpening(h.channel),
  ).rejects.toThrow("not verified as owned");
  expect(h.adminPublish).not.toHaveBeenCalled();
  expect(h.roles.get(h.agents[0])).toBe("member");
  expect(h.events.has(message)).toBe(false);
  await vi.waitFor(() =>
    expect(
      owner.session.outbox?.snapshot().find((item) => item.event.id === message)
        ?.delivery,
    ).toBe("failed"),
  );
  expect(
    owner.session.outbox
      ?.snapshot()
      .some((item) => item.recovery?.key === soloAdminKey(h.channel)),
  ).toBe(true);
});
