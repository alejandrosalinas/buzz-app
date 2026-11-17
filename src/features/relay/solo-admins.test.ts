import { assert, expect, it, vi } from "vitest";
import {
  soloAdminSetup,
  ownedSoloAgents,
  promoteSoloAdmins,
  soloAdminRecovery,
  soloAgentOwnership,
} from "./solo-admins";
import { keypair, ownedProfile, signed } from "./testing";
import { matchesEvent } from "./projection";
import type { OutgoingEvent } from "./outbox";
import { eventDto, type ReadFilter, type RelayEvent } from "./events";

it("grants ownership only from the current verified NIP-OA profile, never library hints", async () => {
  const viewer = keypair(),
    other = keypair();
  const own = keypair(),
    shared = keypair(),
    unsigned = keypair(),
    hinted = keypair();
  const heads = new Map<string, RelayEvent>([
    [own.pubkey, eventDto(await ownedProfile(own, viewer))],
    [shared.pubkey, eventDto(await ownedProfile(shared, other))],
    [unsigned.pubkey, await ownedProfile(unsigned, viewer)],
    [
      hinted.pubkey,
      eventDto(
        signed(hinted, {
          kind: 0,
          content: JSON.stringify({ owner: viewer.pubkey }),
          tags: [],
        }),
      ),
    ],
  ]);
  const ensure = vi.fn(async () => {});
  expect(
    await ownedSoloAgents(
      { ensure, event: (key) => heads.get(key) },
      viewer.pubkey,
      [...heads.keys(), own.pubkey],
    ),
  ).toEqual(new Set([own.pubkey]));
  expect(ensure).toHaveBeenCalledExactlyOnceWith([...heads.keys()]);
});

it("does not grant from an ownership head replaced while its attestation is checked", async () => {
  const viewer = keypair(),
    agent = keypair();
  const previous = eventDto(await ownedProfile(agent, viewer));
  const changed = eventDto(
    signed(agent, {
      kind: 0,
      content: "{}",
      tags: [],
      created_at: previous.created_at + 1,
    }),
  );
  const event = vi.fn().mockReturnValueOnce(previous).mockReturnValue(changed);
  expect(
    await ownedSoloAgents({ ensure: async () => {}, event }, viewer.pubkey, [
      agent.pubkey,
    ]),
  ).toEqual(new Set());
});

function setup() {
  const owner = keypair(),
    relay = keypair();
  const agents: [string, string] = [keypair().pubkey, keypair().pubkey];
  const channel = crypto.randomUUID();
  const create = signed(owner, {
    kind: 9007,
    content: "",
    created_at: Math.floor(Date.now() / 1000),
    tags: [["h", channel], ...agents.map((key) => ["p", key])],
  });
  const creation: OutgoingEvent = {
    event: create,
    delivery: "accepted",
    recovery: soloAdminRecovery(channel, agents, agents),
  };
  const records = new Map<string, RelayEvent>();
  const roles = new Map(agents.map((key) => [key, "member"]));
  const read = vi.fn(async (filters: readonly ReadFilter[]) => {
    const roster = signed(relay, {
      kind: 39002,
      content: "",
      tags: [
        ["d", channel],
        ["p", owner.pubkey, "", "owner"],
        ...[...roles].map(([key, role]) => ["p", key, "", role]),
      ],
    });
    return [...records.values(), roster].filter((event) =>
      filters.some((filter) => matchesEvent(event, filter)),
    );
  });
  const publish = vi.fn(
    async (
      event: RelayEvent,
      _signal: AbortSignal,
      _checkOwnership: () => void,
    ) => {
      const agent = event.tags.find(([tag]) => tag === "p")?.[1];
      assert.exists(agent);
      records.set(event.id, event);
      roles.set(agent, "admin");
    },
  );
  const writer = {
    sign: vi.fn(async (template: Parameters<typeof signed>[1]) =>
      signed(owner, template),
    ),
    publish,
  };
  const controller = new AbortController();
  const owned = vi.fn(
    async (_key: string): Promise<() => boolean> =>
      () =>
        true,
  );
  const run = (saved = creation) =>
    promoteSoloAdmins(
      saved,
      writer,
      { read },
      relay.pubkey,
      controller.signal,
      owned,
    );
  return {
    agents,
    creation,
    records,
    roles,
    read,
    writer,
    publish,
    owned,
    run,
  };
}

it("does not restore a removed opening agent when replaying a stale creation receipt", async () => {
  const h = setup();
  await h.run();
  h.roles.delete(h.agents[0]);
  await h.run(structuredClone(h.creation));
  expect(h.publish).toHaveBeenCalledTimes(2);
  expect(h.roles.has(h.agents[0])).toBe(false);
});

it("refuses an unrecorded opening grant after ownership changes without replacing the saved intent", async () => {
  const h = setup();
  const saved = structuredClone(h.creation);
  h.owned.mockResolvedValue(() => false);
  await expect(h.run()).rejects.toThrow("not verified as owned");
  expect(h.writer.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
  expect(structuredClone(h.creation)).toEqual(saved);
});

it("confirms recorded opening grants after an ownership change without issuing new grants", async () => {
  const h = setup();
  await h.run();
  h.owned.mockClear().mockResolvedValue(() => false);
  await h.run();
  expect(h.owned).not.toHaveBeenCalled();
  expect(h.publish).toHaveBeenCalledTimes(2);
});

it.each(["owner", "guest", "absent"])(
  "preserves an opening agent changed to %s before its grant",
  async (role) => {
    const h = setup();
    if (role === "absent") h.roles.delete(h.agents[0]);
    else h.roles.set(h.agents[0], role);
    await expect(h.run()).rejects.toThrow("access changed");
    expect(h.publish).not.toHaveBeenCalled();
  },
);

it("keeps uncertainty recoverable when a publish claims success but no command is recorded", async () => {
  const h = setup();
  h.publish.mockResolvedValue(undefined);
  await expect(h.run()).rejects.toThrow("unconfirmed");
  expect(h.publish).toHaveBeenCalledOnce();
});

it("does not turn a failed role read into a permission grant", async () => {
  const h = setup();
  h.read.mockRejectedValueOnce(new Error("read offline"));
  await expect(h.run()).rejects.toThrow("read offline");
  expect(h.writer.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
});

it("never re-dates an expired grant, but can still confirm recorded grants after expiry", async () => {
  const h = setup();
  await h.run();
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 16 * 60 * 1000);
  try {
    await h.run();
    h.records.clear();
    await expect(h.run()).rejects.toThrow("expired");
    expect(h.publish).toHaveBeenCalledTimes(2);
  } finally {
    clock.mockRestore();
  }
});

it("rejects recovery that grants a nonmember admin, without signing", async () => {
  const h = setup();
  assert.exists(h.creation.recovery);
  await expect(
    h.run({
      ...h.creation,
      recovery: {
        ...h.creation.recovery,
        value: JSON.stringify([keypair().pubkey]),
      },
    }),
  ).rejects.toThrow("initial chat agents");
  expect(h.writer.sign).not.toHaveBeenCalled();
});

it("recognizes a valid opening-admin receipt before delivery or expiry", () => {
  const h = setup();
  const recovery = h.creation.recovery;
  assert.exists(recovery);
  expect(soloAdminSetup(h.creation)?.recovery).toEqual(recovery);
  expect(soloAdminSetup({ ...h.creation, delivery: "unknown" })).toBeDefined();
  for (const item of [
    { ...h.creation, recovery: undefined },
    {
      ...h.creation,
      recovery: { key: "another-owner", value: recovery.value },
    },
    {
      ...h.creation,
      recovery: { key: recovery.key, value: "invalid JSON" },
    },
    {
      ...h.creation,
      recovery: {
        key: recovery.key,
        value: JSON.stringify([keypair().pubkey]),
      },
    },
    { ...h.creation, event: { ...h.creation.event, kind: 9000 } },
  ])
    expect(soloAdminSetup(item)).toBeUndefined();
});

it("invalidates a verified ownership guard when its head is replaced or evicted", async () => {
  const viewer = keypair(),
    agent = keypair();
  const initial = eventDto(await ownedProfile(agent, viewer));
  let head: RelayEvent | undefined = initial;
  const owns = await soloAgentOwnership(
    { event: () => head },
    viewer.pubkey,
    agent.pubkey,
  );
  expect(owns()).toBe(true);
  head = eventDto(await ownedProfile(agent, keypair()));
  expect(owns()).toBe(false);
  head = undefined;
  expect(owns()).toBe(false);
});

it("rechecks the next opening target after publishing the previous grant", async () => {
  const h = setup();
  const publish = h.publish.getMockImplementation();
  assert.exists(publish);
  h.publish.mockImplementationOnce(async (event) => {
    await publish(event, new AbortController().signal, () => {});
    h.owned.mockResolvedValue(() => false);
  });
  await expect(h.run()).rejects.toThrow("not verified as owned");
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.writer.sign).toHaveBeenCalledOnce();
  expect(h.roles.get(h.agents[1])).toBe("member");
});

it.each(["roster read", "signing", "publication lock"])(
  "refuses an unrecorded grant if ownership changes during %s",
  async (boundary) => {
    const h = setup();
    let current = true;
    h.owned.mockResolvedValue(() => current);
    if (boundary === "roster read") {
      const read = h.read.getMockImplementation();
      assert.exists(read);
      h.read.mockImplementation(async (filters) => {
        const result = await read(filters);
        if (filters.some((filter) => filter.kinds?.includes(39002)))
          current = false;
        return result;
      });
    } else if (boundary === "signing") {
      const sign = h.writer.sign.getMockImplementation();
      assert.exists(sign);
      h.writer.sign.mockImplementation(async (template) => {
        const result = await sign(template);
        current = false;
        return result;
      });
    } else {
      // Like the production journal: another holder can change the profile
      // before this callback acquires permission to publish.
      h.writer.publish = vi.fn(async (_event, _signal, checkOwnership) => {
        await Promise.resolve();
        current = false;
        checkOwnership();
      });
    }
    await expect(h.run()).rejects.toThrow("not verified as owned");
    expect(h.records.size).toBe(0);
    expect(h.roles.get(h.agents[0])).toBe("member");
    expect(h.writer.sign).toHaveBeenCalledTimes(
      boundary === "roster read" ? 0 : 1,
    );
  },
);
