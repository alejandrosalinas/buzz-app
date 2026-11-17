import contract from "./administration-contract.json";
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { afterEach, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools";
import type { ReadFilter, RelayEvent } from "../relay/events";
import { PublishRejected } from "../relay/outbox";
import { createRelaySession } from "../relay/session";
import { matchesEvent } from "../relay/projection";
import { SOLO_LABEL } from "../solo/labels";
import {
  administerMember,
  createMemberAdministration,
  type MemberAdministrationState,
} from "./administration";
import {
  authorizeMemberChange,
  canTransferOwnership,
  memberAuthority,
  validateMemberAdministrationTemplate,
  type MemberChange,
  type MemberRole,
} from "./administration-protocol";

const key = new Uint8Array(32).fill(2);
const relayKey = new Uint8Array(32).fill(3);
const viewer = getPublicKey(key),
  author = getPublicKey(relayKey);
const target = getPublicKey(new Uint8Array(32).fill(4));
const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const change: MemberChange = {
  pubkey: target,
  expectedRole: "member",
  role: "admin",
};
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(actor = "owner", role: string | undefined = "member") {
  let clock = 100;
  const record = (kind: number, tags: string[][]) =>
    finalizeEvent({ kind, tags, content: "", created_at: clock++ }, relayKey);
  const roster = (actor: string, role: string | undefined) => [
    record(39001, [
      ["d", id],
      ...[
        [viewer, actor],
        [target, role],
      ]
        .filter(([, role]) => role === "owner" || role === "admin")
        .map(([key, role]) => ["p", key ?? "", role ?? ""]),
    ]),
    record(39002, [
      ["d", id],
      ["p", viewer, "", actor],
      ...(role === undefined ? [] : [["p", target, "", role]]),
    ]),
  ];
  let events = [
    record(39000, [
      ["d", id],
      ["t", "stream"],
      ["private"],
      ["name", "Fixture"],
    ]),
    ...roster(actor, role),
  ];
  let access = true;
  const read = vi.fn(
    async (_filters: readonly ReadFilter[], _options?: unknown) => events,
  );
  const sign = vi.fn(async (template: EventTemplate) =>
    finalizeEvent(structuredClone(template), key),
  );
  const publish = vi.fn(async (event: RelayEvent) => {
    const named = (pubkey: string) =>
      event.tags.find(([tag, key]) => tag === "p" && key === pubkey)?.[2];
    events = [
      required(events[0]),
      ...roster(
        named(viewer) ?? actor,
        event.kind === 9001
          ? undefined
          : (named(target) ?? event.tags.find(([tag]) => tag === "role")?.[1]),
      ),
    ];
  });
  const acceptDiscovery = vi.fn();
  const owner = createMemberAdministration({
    reader: { read },
    writer: { sign, publish },
    viewer,
    relayAuthor: author,
    canAccess: () => access,
    acceptDiscovery,
  });
  stops.push(owner.dispose);
  return {
    owner,
    read,
    sign,
    publish,
    acceptDiscovery,
    record,
    events: () => events,
    setEvents: (next: RelayEvent[]) => {
      events = next;
    },
    setRoles: (actor: string, role?: string) => {
      events = [required(events[0]), ...roster(actor, role)];
    },
    deny: () => {
      access = false;
    },
  };
}

it.each(["admin", "remove"] as const)(
  "confirms %s while the replica retains the previous role",
  async (role) => {
    const h = harness();
    const replica = h.events();
    h.read.mockImplementation(async (filters) =>
      filters.every((filter) => filter.consistency === "strong")
        ? h.events()
        : replica,
    );
    await h.owner.capability.run(id, { ...change, role });
    expect(h.owner.capability.snapshot(id).operation?.status).toBe("confirmed");
    expect(h.publish).toHaveBeenCalledOnce();
  },
);

it.each(["guest", "admin", "member"] as const)(
  "adds an absent person directly as %s with exact signed readback",
  async (role) => {
    const h = harness();
    h.setRoles("owner");
    await h.owner.capability.run(id, {
      ...change,
      expectedRole: "absent",
      role,
    });
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.publish.mock.calls[0]?.[0].tags).toEqual([
      ["h", id],
      ["p", target],
      ["role", role],
    ]);
    expect(h.owner.capability.snapshot(id).operation?.status).toBe("confirmed");
    expect(h.owner.capability.snapshot(id).authority.roles[target]).toBe(role);
  },
);

it.each(["member", "guest", "bot", "unknown"])(
  "refuses explicit-role additions by a %s",
  async (actor) => {
    const h = harness(actor);
    h.setRoles(actor);
    await h.owner.capability.run(id, { ...change, expectedRole: "absent" });
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  },
);

it.each(["guest", "member", "admin", "owner", "bot", "unknown"])(
  "never treats an existing %s as an absent addition",
  async (role) => {
    const h = harness("owner", role);
    await h.owner.capability.run(id, { ...change, expectedRole: "absent" });
    expect(h.sign).not.toHaveBeenCalled();
  },
);

it.each(["membership", "authority"])(
  "rechecks %s after signing an explicit-role addition",
  async (changed) => {
    const h = harness();
    h.setRoles("owner");
    const sign = required(h.sign.getMockImplementation());
    h.sign.mockImplementationOnce(async (template) => {
      if (changed === "membership") h.setRoles("owner", "member");
      else h.setRoles("member");
      return sign(template);
    });
    await h.owner.capability.run(id, { ...change, expectedRole: "absent" });
    expect(h.sign).toHaveBeenCalledOnce();
    expect(h.publish).not.toHaveBeenCalled();
  },
);

it("rejects removal with an absent expectation", async () => {
  const h = harness();
  await h.owner.capability.run(id, {
    ...change,
    expectedRole: "absent",
    role: "remove",
  });
  expect(h.sign).not.toHaveBeenCalled();
});

it.each(["admin", "member", "guest", "remove"] as const)(
  "confirms %s from exact fresh signed state, never acknowledgement alone",
  async (role) => {
    const h = harness("admin", role === "member" ? "guest" : "member");
    const expectedRole = role === "member" ? "guest" : "member";
    await h.owner.capability.refresh(id);
    await h.owner.capability.run(id, { ...change, role, expectedRole });
    expect(h.owner.capability.snapshot(id).operation?.status).toBe("confirmed");
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.read).toHaveBeenCalledTimes(4);
    expect(h.read.mock.calls[0]).toEqual([
      [39000, 39001, 39002].map((kind) => ({
        kinds: [kind],
        consistency: "strong",
        authors: [author],
        "#d": [id],
        limit: 1,
      })),
      expect.objectContaining({ fresh: true, priority: "foreground" }),
    ]);
  },
);
it.each(["owner", "admin"])(
  "allows %s to explicitly promote a bot to admin with fresh role confirmation",
  async (actor) => {
    const h = harness(actor, "bot");
    await h.owner.capability.run(id, { ...change, expectedRole: "bot" });
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.publish.mock.calls[0]?.[0].tags).toEqual([
      ["h", id],
      ["p", target],
      ["role", "admin"],
    ]);
    expect(h.owner.capability.snapshot(id).operation?.status).toBe("confirmed");
    expect(h.owner.capability.snapshot(id).authority.roles[target]).toBe(
      "admin",
    );
  },
);
it.each(["admin", "guest"] as const)(
  "confirms a requested member from %s when the relay stores bot for an owned agent",
  async (expectedRole) => {
    const h = harness("owner", expectedRole);
    h.publish.mockImplementationOnce(async () => h.setRoles("owner", "bot"));
    await h.owner.capability.run(id, {
      ...change,
      expectedRole,
      role: "member",
    });
    expect(h.owner.capability.snapshot(id).operation?.status).toBe("confirmed");
    expect(h.owner.capability.snapshot(id).authority.roles[target]).toBe("bot");
    await h.owner.capability.run(id, {
      ...change,
      expectedRole: "bot",
      role: "admin",
    });
    expect(h.publish).toHaveBeenCalledTimes(2);
  },
);
it("confirms an uncertain requested member on refresh when the relay stores bot", async () => {
  const h = harness("owner", "admin");
  h.publish.mockImplementationOnce(async () => {
    throw new Error("Connection lost");
  });
  const demote = { ...change, expectedRole: "admin", role: "member" } as const;
  await h.owner.capability.run(id, demote);
  expect(h.owner.capability.snapshot(id).operation?.status).toBe("uncertain");
  h.setRoles("owner", "bot");
  await h.owner.capability.refresh(id);
  expect(h.owner.capability.snapshot(id).operation?.status).toBe("confirmed");
  expect(h.publish).toHaveBeenCalledOnce();
});
it.each(["admin", "guest"] as const)(
  "never confirms a requested %s from a stored bot",
  async (role) => {
    const h = harness("owner", "member");
    h.publish.mockImplementationOnce(async () => h.setRoles("owner", "bot"));
    await h.owner.capability.run(id, { ...change, role });
    expect(h.owner.capability.snapshot(id).operation?.status).toBe("uncertain");
  },
);
it("publishes no member change once the caller's guard turns false during signing", async () => {
  const h = harness();
  let eligible = true;
  const active = vi.fn(() => eligible);
  const sign = required(h.sign.getMockImplementation());
  h.sign.mockImplementationOnce(async (template) => {
    eligible = false;
    return sign(template);
  });
  await h.owner.capability.run(id, change, undefined, active);
  expect(active).toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
  expect(h.owner.capability.snapshot(id)).toMatchObject({
    operation: { status: "failed" },
    error: "Member change cancelled",
  });
  // Nothing reached the relay, so a later eligible change is not fenced as uncertain.
  await h.owner.capability.run(id, change);
  expect(h.owner.capability.snapshot(id).operation?.status).toBe("confirmed");
});
it("checks the guard only after the final re-authorization read settles", async () => {
  const h = harness();
  let eligible = true;
  const active = vi.fn(() => eligible);
  const started = deferred(),
    gate = deferred();
  const sign = required(h.sign.getMockImplementation());
  h.sign.mockImplementationOnce(async (template) => {
    h.read.mockImplementationOnce(async () => {
      started.resolve();
      await gate.promise;
      return h.events();
    });
    return sign(template);
  });
  const running = h.owner.capability.run(id, change, undefined, active);
  try {
    await started.promise;
    expect(active).not.toHaveBeenCalled();
    eligible = false;
  } finally {
    gate.resolve();
  }
  await running;
  expect(active).toHaveBeenCalledOnce();
  expect(h.publish).not.toHaveBeenCalled();
  expect(h.owner.capability.snapshot(id).operation?.status).toBe("failed");
  eligible = true;
  await h.owner.capability.run(id, change, undefined, active);
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.owner.capability.snapshot(id).operation?.status).toBe("confirmed");
});
it("publishes nothing when the caller's signal aborts during signing", async () => {
  const h = harness();
  const controller = new AbortController();
  const sign = required(h.sign.getMockImplementation());
  h.sign.mockImplementationOnce(async (template) => {
    controller.abort();
    return sign(template);
  });
  await h.owner.capability.run(id, change, controller.signal);
  expect(h.publish).not.toHaveBeenCalled();
  expect(h.owner.capability.snapshot(id).operation?.status).toBe("failed");
});
it.each(["owner", "bot", "unknown"])(
  "never coerces %s target roles",
  async (role) => {
    const h = harness("owner", role);
    await h.owner.capability.run(id, change);
    expect(h.sign).not.toHaveBeenCalled();
  },
);
it("allows removing a bot without changing its role or invoking agent deletion", async () => {
  const h = harness("owner", "bot");
  await h.owner.capability.run(id, {
    ...change,
    expectedRole: "bot",
    role: "remove",
  });
  expect(h.publish.mock.calls[0]?.[0]).toMatchObject({
    kind: 9001,
    tags: [
      ["h", id],
      ["p", target],
    ],
  });
});
it.each(["member", "guest", "bot"])(
  "rejects explicit bot promotion by a %s viewer",
  async (actor) => {
    const h = harness(actor, "bot");
    await h.owner.capability.run(id, { ...change, expectedRole: "bot" });
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  },
);
it.each(["member", "guest", "bot"])(
  "never grants administration to %s viewers",
  async (role) => {
    const h = harness(role);
    await h.owner.capability.run(id, change);
    expect(h.sign).not.toHaveBeenCalled();
  },
);
it("protects all owners and self even when co-owners exist", async () => {
  const h = harness("owner", "owner");
  for (const pubkey of [target, viewer]) {
    await h.owner.capability.run(id, {
      pubkey,
      expectedRole: "owner",
      role: "remove",
    });
  }
  expect(h.sign).not.toHaveBeenCalled();
});
it.each(["dm", "archived"])("excludes %s channels", async (kind) => {
  const h = harness();
  h.setEvents([
    h.record(39000, [
      ["d", id],
      ["t", kind === "dm" ? "dm" : "stream"],
      ...(kind === "archived" ? [["archived", "true"]] : []),
    ]),
    ...h.events().slice(1),
  ]);
  await h.owner.capability.run(id, change);
  expect(h.sign).not.toHaveBeenCalled();
});
function soloHarness() {
  const h = harness();
  h.setEvents([
    h.record(39000, [
      ["d", id],
      ["t", "stream"],
      ["t", SOLO_LABEL],
    ]),
    ...h.events().slice(1),
  ]);
  return h;
}
it("lets a Solo chat owner remove a participant", async () => {
  const h = soloHarness();
  await h.owner.capability.run(id, { ...change, role: "remove" });
  expect(h.publish.mock.calls[0]?.[0]).toMatchObject({
    kind: 9001,
    tags: [
      ["h", id],
      ["p", target],
    ],
  });
});
it("never lets a Solo chat owner change roles", async () => {
  const h = soloHarness();
  await h.owner.capability.run(id, change);
  expect(h.sign).not.toHaveBeenCalled();
});
it.each([
  "missing",
  "foreign",
  "channel",
  "duplicate",
  "inconsistent",
  "unexpected",
])("fails closed on %s authority", async (failure) => {
  const h = harness();
  const events = h.events();
  if (failure === "missing") events.pop();
  if (failure === "foreign")
    events[1] = { ...required(events[1]), pubkey: target };
  if (failure === "channel")
    events[1] = h.record(39001, [
      ["d", otherId],
      ["p", viewer, "owner"],
    ]);
  if (failure === "duplicate")
    events[2] = h.record(39002, [
      ["d", id],
      ["p", viewer, "", "owner"],
      ["p", viewer, "", "owner"],
    ]);
  if (failure === "inconsistent") events[1] = h.record(39001, [["d", id]]);
  if (failure === "unexpected") events.push(h.record(9, [["h", id]]));
  await h.owner.capability.run(id, change);
  expect(h.sign).not.toHaveBeenCalled();
});
it("reads a labeled channel's type from its first t tag", () => {
  const h = harness();
  h.setEvents([
    h.record(39000, [
      ["d", id],
      ["t", "stream"],
      ["t", "workspace"],
      ["P", viewer],
      ["private"],
      ["name", "Fixture"],
      ["created_at", "100"],
    ]),
    required(h.events()[1]),
    required(h.events()[2]),
  ]);
  expect(memberAuthority(h.events(), id, viewer, author).roles[target]).toBe(
    "member",
  );
});
it("does not fabricate Member for missing or unknown role hints", () => {
  const h = harness();
  h.setEvents([
    required(h.events()[0]),
    required(h.events()[1]),
    h.record(39002, [
      ["d", id],
      ["p", viewer, "", "owner"],
      ["p", target],
    ]),
  ]);
  expect(memberAuthority(h.events(), id, viewer, author).roles[target]).toBe(
    "unknown",
  );
});
it.each(["actor", "target", "removed", "access"])(
  "rechecks %s after signing, before publishing",
  async (what) => {
    const h = harness();
    h.sign.mockImplementationOnce(async (template) => {
      if (what === "actor") h.setRoles("member", "member");
      if (what === "target") h.setRoles("owner", "owner");
      if (what === "removed") h.setRoles("owner");
      if (what === "access") h.deny();
      return finalizeEvent(template, key);
    });
    await h.owner.capability.run(id, change);
    expect(h.publish).not.toHaveBeenCalled();
  },
);
it("rejects altered signer payloads", async () => {
  const h = harness();
  h.sign.mockImplementationOnce(async (template) =>
    finalizeEvent({ ...template, content: "changed" }, key),
  );
  await h.owner.capability.run(id, change);
  expect(h.publish).not.toHaveBeenCalled();
});
it.each(["ack", "lost", "read"])(
  "retains roles on %s uncertainty and preserves readback-only recovery through clear",
  async (failure) => {
    const h = harness();
    await h.owner.capability.refresh(id);
    h.publish.mockImplementationOnce(async () => {
      if (failure === "lost") throw new Error("Connection lost");
      if (failure === "read")
        h.read.mockRejectedValueOnce(new Error("Offline"));
    });
    await h.owner.capability.run(id, change);
    expect(h.owner.capability.snapshot(id)).toMatchObject({
      authority: { roles: { [target]: "member" } },
      operation: { status: "uncertain" },
    });
    h.owner.clear();
    expect(h.owner.capability.snapshot(id)).toMatchObject({
      authority: {
        roles: {},
        canManage: false,
        canRemove: false,
        canRemoveOwnedAgent: false,
        system: false,
      },
      operation: { change, status: "uncertain" },
    });
    await expect(h.owner.capability.run(id, change)).rejects.toThrow(
      /not be sent again/,
    );
    await h.owner.capability.refresh(id);
    expect(h.owner.capability.snapshot(id).operation?.status).toBe("uncertain");
    h.setRoles("owner", "admin");
    await h.owner.capability.refresh(id);
    expect(h.owner.capability.snapshot(id).operation?.status).toBe("confirmed");
    expect(h.publish).toHaveBeenCalledOnce();
  },
);
it("preserves confirmed roles on rejection and requires fresh explicit intent", async () => {
  const h = harness();
  await h.owner.capability.refresh(id);
  h.publish.mockRejectedValueOnce(new PublishRejected("Not permitted"));
  await h.owner.capability.run(id, change);
  expect(h.owner.capability.snapshot(id)).toMatchObject({
    status: "error",
    error: "Not permitted",
    operation: { status: "failed" },
    authority: { roles: { [target]: "member" } },
  });
});
it.each(["access", "invalid ID"])(
  "settles a %s preflight failure instead of leaving role consumers idle",
  async (failure) => {
    const h = harness();
    if (failure === "access") h.deny();
    const channelId = failure === "invalid ID" ? "one" : id;
    await h.owner.capability.refresh(channelId);
    expect(h.owner.capability.snapshot(channelId)).toMatchObject({
      status: "error",
      authority: {
        roles: {},
        canManage: false,
        canRemove: false,
        canRemoveOwnedAgent: false,
        system: false,
      },
      error:
        failure === "access"
          ? "Channel access unavailable; refresh membership."
          : "Invalid channel ID",
    });
    expect(h.read).not.toHaveBeenCalled();
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  },
);
it.each(["clear", "dispose"] as const)(
  "does not resurrect preflight errors after %s",
  async (end) => {
    const h = harness();
    h.deny();
    const pending = h.owner.capability.refresh(id);
    h.owner[end]();
    await pending;
    expect(h.owner.capability.snapshot(id)).toMatchObject({
      status: "idle",
      authority: {
        roles: {},
        canManage: false,
        canRemove: false,
        canRemoveOwnedAgent: false,
        system: false,
      },
    });
  },
);
it("retains confirmed roles on refresh failure", async () => {
  const h = harness();
  await h.owner.capability.refresh(id);
  h.read.mockRejectedValueOnce(new Error("Offline"));
  await h.owner.capability.refresh(id);
  expect(h.owner.capability.snapshot(id)).toMatchObject({
    status: "error",
    authority: { roles: { [target]: "member" } },
  });
});
it.each(["clear", "dispose"] as const)(
  "%s fences late publication completion",
  async (action) => {
    const h = harness();
    const gate = deferred();
    h.publish.mockImplementationOnce(() => gate.promise);
    const operation = h.owner.capability.run(id, change);
    await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
    await expect(h.owner.capability.run(id, change)).rejects.toThrow(
      /still in progress/,
    );
    h.owner[action]();
    gate.resolve();
    await operation;
    expect(h.owner.capability.snapshot(id).status).toBe("idle");
    expect(h.acceptDiscovery).not.toHaveBeenCalled();
  },
);
it("uses separate snapshots across channel destinations", async () => {
  const h = harness();
  await h.owner.capability.refresh(id);
  expect(h.owner.capability.snapshot(otherId).status).toBe("idle");
});
it("documents the accepted post-preflight departure race without promising atomic changes", async () => {
  const h = harness();
  const publish = required(h.publish.getMockImplementation());
  h.publish.mockImplementationOnce(async (event) => {
    h.setRoles("owner"); // Departure after final preflight; existing relay upsert re-adds.
    await publish(event);
  });
  await h.owner.capability.run(id, change);
  expect(h.owner.capability.snapshot(id).authority.roles[target]).toBe("admin");
});
it("unsupported adapters retain verified role reading but cannot sign", async () => {
  const h = harness();
  const owner = createMemberAdministration({
    reader: { read: h.read },
    viewer,
    relayAuthor: author,
    canAccess: () => true,
    acceptDiscovery: h.acceptDiscovery,
  });
  stops.push(owner.dispose);
  await owner.capability.refresh(id);
  expect(owner.capability.available).toBe(false);
  expect(owner.capability.snapshot(id).authority.roles[target]).toBe("member");
  await expect(owner.capability.run(id, change)).rejects.toThrow(/unavailable/);
});
it("binds the capability to production session discovery, cache clear and disposal", async () => {
  const h = harness();
  const sessionOwner = createRelaySession({
    viewer,
    relayAuthor: author,
    media: () => undefined,
    query: async (filters) =>
      h
        .events()
        .filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        ),
    memberAdministration: { sign: h.sign, publish: h.publish },
  });
  stops.push(sessionOwner.dispose);
  const session = sessionOwner.session;
  session.channels.ensureList();
  await vi.waitFor(() => expect(session.channels.list().status).toBe("ready"));
  await session.memberAdministration.refresh(id);
  await session.memberAdministration.run(id, { ...change, role: "remove" });
  expect(session.channels.get?.(id)?.members).not.toContain(target);
  expect(session.memberAdministration.snapshot(id).operation?.status).toBe(
    "confirmed",
  );
  await sessionOwner.clearCache();
  expect(session.memberAdministration.snapshot(id).status).toBe("idle");
  sessionOwner.dispose();
  await expect(session.memberAdministration.run(id, change)).rejects.toThrow(
    /closed/,
  );
});
it("clears roles when the production session observes viewer access loss", async () => {
  const h = harness();
  const owner = createRelaySession({
    viewer,
    relayAuthor: author,
    media: () => undefined,
    query: async (filters) =>
      h
        .events()
        .filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        ),
    memberAdministration: { sign: h.sign, publish: h.publish },
  });
  stops.push(owner.dispose);
  owner.session.channels.ensureList();
  await vi.waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  await owner.session.memberAdministration.refresh(id);
  h.setEvents([
    required(h.events()[0]),
    h.record(39001, [["d", id]]),
    h.record(39002, [
      ["d", id],
      ["p", target, "", "member"],
    ]),
  ]);
  await owner.session.read([{ kinds: [39002], "#d": [id], limit: 1 }], {
    fresh: true,
  });
  expect(owner.session.memberAdministration.snapshot(id).status).toBe("idle");
  await expect(
    owner.session.memberAdministration.run(id, change),
  ).rejects.toThrow(/access unavailable/);
  expect(h.sign).not.toHaveBeenCalled();
});
it.each(["cache", "access"] as const)(
  "%s clearing preserves sent intent during publication and after uncertainty",
  async (end) => {
    const h = harness();
    const owner = createRelaySession({
      viewer,
      relayAuthor: author,
      media: () => undefined,
      query: async (filters) =>
        h
          .events()
          .filter((event) =>
            filters.some((filter) => matchesEvent(event, filter)),
          ),
      memberAdministration: { sign: h.sign, publish: h.publish },
    });
    stops.push(owner.dispose);
    const session = owner.session;
    const admin = session.memberAdministration;
    const readRoster = () =>
      session.read([{ kinds: [39002], "#d": [id], limit: 1 }], { fresh: true });
    const clear = async () => {
      if (end === "cache") await owner.clearCache();
      else {
        h.setEvents([
          required(h.events()[0]),
          h.record(39001, [["d", id]]),
          h.record(39002, [
            ["d", id],
            ["p", target, "", "member"],
          ]),
        ]);
        await readRoster();
      }
    };
    const recoverAccess = async () => {
      h.setRoles("owner", "member");
      await readRoster();
    };
    session.channels.ensureList();
    await vi.waitFor(() =>
      expect(session.channels.list().status).toBe("ready"),
    );
    await admin.refresh(id);
    const gate = deferred();
    h.publish.mockImplementationOnce(() => gate.promise);
    const pending = admin.run(id, change);
    try {
      await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
      await clear();
      expect(admin.snapshot(id)).toMatchObject({
        status: "idle",
        authority: {
          roles: {},
          canManage: false,
          canRemove: false,
          canRemoveOwnedAgent: false,
          system: false,
        },
        operation: { change, status: "uncertain" },
      });
      await recoverAccess();
      await expect(admin.run(id, change)).rejects.toThrow(/not be sent again/);
      await admin.refresh(id);
      expect(admin.snapshot(id).operation?.status).toBe("uncertain");
      // Clearing the settled uncertain snapshot must retain the same fence too.
      await clear();
      expect(admin.snapshot(id).authority).toEqual({
        roles: {},
        canManage: false,
        canRemove: false,
        canRemoveOwnedAgent: false,
        system: false,
      });
      await recoverAccess();
      await expect(admin.run(id, change)).rejects.toThrow(/not be sent again/);
      // Fresh readback, not a response from the old publication, resolves it.
      h.setRoles("owner", "admin");
      await admin.refresh(id);
      expect(admin.snapshot(id).operation?.status).toBe("confirmed");
      const confirmed = admin.snapshot(id);
      gate.resolve();
      await pending;
      expect(admin.snapshot(id)).toBe(confirmed);
      expect(h.publish).toHaveBeenCalledOnce();
      expect(h.sign).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
      await pending;
    }
  },
);
it("clearing during signing cancels without retaining an unsent operation", async () => {
  const h = harness();
  const gate = deferred();
  h.sign.mockImplementationOnce(async (template) => {
    await gate.promise;
    return finalizeEvent(template, key);
  });
  const pending = h.owner.capability.run(id, change);
  try {
    await vi.waitFor(() => expect(h.sign).toHaveBeenCalledOnce());
    h.owner.clear();
  } finally {
    gate.resolve();
    await pending;
  }
  expect(h.owner.capability.snapshot(id).operation).toBeUndefined();
  expect(h.publish).not.toHaveBeenCalled();
  await h.owner.capability.run(id, change);
  expect(h.owner.capability.snapshot(id).operation?.status).toBe("confirmed");
});
it("narrow validator rejects self-removal and arbitrary role/metadata payloads", () => {
  const base = {
    kind: 9000,
    created_at: 100,
    content: "",
    tags: [
      ["h", id],
      ["p", target],
      ["role", "admin"],
    ],
  };
  expect(() =>
    validateMemberAdministrationTemplate(base, viewer),
  ).not.toThrow();
  for (const invalid of [
    { ...base, kind: 9002 },
    { ...base, content: "extra" },
    {
      ...base,
      tags: [
        ["h", id],
        ["p", viewer],
        ["role", "member"],
      ],
    },
    ...["owner", "bot", ""].map((role) => ({
      ...base,
      tags: [
        ["h", id],
        ["p", target],
        ["role", role],
      ],
    })),
    { ...base, tags: [...base.tags, ["h", id]] },
  ])
    expect(() =>
      validateMemberAdministrationTemplate(invalid, viewer),
    ).toThrow();
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture value");
  return value;
}

function agentProfile(ownerKey = key, created_at = 200, valid = true) {
  const digest = new Uint8Array(
    createHash("sha256").update(`nostr:agent-auth:${target}:`).digest(),
  );
  return finalizeEvent(
    {
      kind: 0,
      created_at,
      content: JSON.stringify({ is_agent: true }),
      tags: valid
        ? [
            [
              "auth",
              getPublicKey(ownerKey),
              "",
              bytesToHex(schnorr.sign(digest, ownerKey)),
            ],
          ]
        : [],
    },
    new Uint8Array(32).fill(4),
  );
}
function ownedAgent(actor = "member", role = "bot") {
  const h = harness(actor, role);
  let profiles = [agentProfile()];
  h.read.mockImplementation(async (filters) =>
    filters.some((filter) => filter.kinds?.includes(0)) ? profiles : h.events(),
  );
  return {
    ...h,
    setProfiles: (next: RelayEvent[]) => {
      profiles = next;
    },
  };
}
const removeAgent: MemberChange = {
  pubkey: target,
  expectedRole: "bot",
  role: "remove",
};
it.each(["member", "guest", "bot", "admin", "owner"])(
  "allows an active %s to remove their verified agent without granting role edits",
  async (actor) => {
    const h = ownedAgent(actor);
    await h.owner.capability.run(id, removeAgent);
    expect(h.owner.capability.snapshot(id).operation?.status).toBe("confirmed");
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.sign.mock.calls[0]?.[0]).toMatchObject({
      kind: 9001,
      tags: [
        ["h", id],
        ["p", target],
      ],
    });
    const ownershipReads = h.read.mock.calls.filter(([filters]) =>
      filters.some((filter) => filter.kinds?.includes(0)),
    );
    expect(ownershipReads).toHaveLength(
      actor === "owner" || actor === "admin" ? 0 : 1,
    );
    expect(
      h.read.mock.calls.filter(([filters]) =>
        filters.some((filter) => filter.kinds?.includes(39002)),
      ),
    ).toHaveLength(3); // Two fresh preflights and final roster readback.
    for (const [filters, options] of ownershipReads) {
      expect(filters).toEqual([
        { kinds: [0], authors: [target], limit: 1, consistency: "strong" },
      ]);
      expect(options).toMatchObject({ fresh: true, priority: "foreground" });
    }
  },
);
it.each([
  "missing",
  "foreign owner",
  "invalid",
  "newer invalid",
  "wrong author",
  "wrong kind",
  "read failure",
])("rejects %s ownership without signing", async (failure) => {
  const h = ownedAgent();
  if (failure === "missing") h.setProfiles([]);
  if (failure === "foreign owner") h.setProfiles([agentProfile(relayKey)]);
  if (failure === "invalid") h.setProfiles([agentProfile(key, 200, false)]);
  if (failure === "newer invalid")
    h.setProfiles([agentProfile(), agentProfile(key, 201, false)]);
  if (failure === "wrong author")
    h.setProfiles([{ ...agentProfile(), pubkey: viewer }]);
  if (failure === "wrong kind") h.setProfiles([{ ...agentProfile(), kind: 9 }]);
  if (failure === "read failure")
    h.read.mockImplementation(async (filters) => {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        throw new Error("unavailable");
      return h.events();
    });
  await h.owner.capability.run(id, removeAgent);
  expect(h.owner.capability.snapshot(id).operation?.status).toBe("failed");
  expect(h.sign).not.toHaveBeenCalled();
});
it.each([
  "nonmember",
  "unknown actor",
  "owner target",
  "unknown target",
  "dm",
  "archived",
  "solo",
  "role edit",
])("owned-agent evidence does not bypass %s restrictions", async (failure) => {
  const h = ownedAgent();
  if (failure === "nonmember")
    h.setEvents(
      h.events().map((e) =>
        e.kind === 39002
          ? h.record(39002, [
              ["d", id],
              ["p", target, "", "bot"],
            ])
          : e,
      ),
    );
  if (failure === "unknown actor") h.setRoles("unknown", "bot");
  if (failure === "owner target") h.setRoles("member", "owner");
  if (failure === "unknown target") h.setRoles("member", "unknown");
  if (["dm", "archived", "solo"].includes(failure))
    h.setEvents([
      h.record(39000, [
        ["d", id],
        ["t", failure === "dm" ? "dm" : "stream"],
        ...(failure === "archived" ? [["archived", "true"]] : []),
        ...(failure === "solo" ? [["t", SOLO_LABEL]] : []),
      ]),
      ...h.events().slice(1),
    ]);
  if (failure === "role edit") h.setRoles("member", "member");
  await h.owner.capability.run(
    id,
    failure === "role edit" ? change : removeAgent,
  );
  expect(h.sign).not.toHaveBeenCalled();
});
it.each(["actor left", "target promoted", "access lost"])(
  "rechecks %s before publishing an owned-agent removal",
  async (failure) => {
    const h = ownedAgent();
    h.sign.mockImplementationOnce(async (template) => {
      if (failure === "actor left")
        h.setEvents(
          h.events().map((e) =>
            e.kind === 39002
              ? h.record(39002, [
                  ["d", id],
                  ["p", target, "", "bot"],
                ])
              : e,
          ),
        );
      if (failure === "target promoted") h.setRoles("member", "owner");
      if (failure === "access lost") h.deny();
      return finalizeEvent(template, key);
    });
    await h.owner.capability.run(id, removeAgent);
    expect(h.sign).toHaveBeenCalledOnce();
    expect(h.publish).not.toHaveBeenCalled();
  },
);
it("reuses verified ownership only within the removal attempt", async () => {
  const h = ownedAgent();
  const read = required(h.read.getMockImplementation());
  h.sign.mockImplementationOnce(async (template) => {
    // A second profile read would fail; membership still has to be refreshed.
    h.read.mockImplementation(async (filters, options) => {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        throw new Error("Profile unavailable");
      return read(filters, options);
    });
    return finalizeEvent(template, key);
  });
  await h.owner.capability.run(id, removeAgent);
  expect(h.owner.capability.snapshot(id).operation?.status).toBe("confirmed");
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.read).toHaveBeenCalledTimes(4);

  // A later attempt must verify again, never inherit the first attempt's evidence.
  h.setRoles("member", "bot");
  await h.owner.capability.run(id, removeAgent);
  expect(h.owner.capability.snapshot(id).operation?.status).toBe("failed");
  expect(h.sign).toHaveBeenCalledOnce();
  expect(h.publish).toHaveBeenCalledOnce();
});
it.each([true, false])(
  "verifies ownership if administration authority is lost while signing (owned: %s)",
  async (owned) => {
    const h = ownedAgent("admin");
    h.setProfiles([agentProfile(owned ? key : relayKey)]);
    h.sign.mockImplementationOnce(async (template) => {
      expect(h.read).toHaveBeenCalledOnce(); // No profile needed for initial admin.
      h.setRoles("member", "bot");
      return finalizeEvent(template, key);
    });
    await h.owner.capability.run(id, removeAgent);
    expect(
      h.read.mock.calls.filter(([filters]) =>
        filters.some((filter) => filter.kinds?.includes(0)),
      ),
    ).toHaveLength(1);
    expect(h.owner.capability.snapshot(id).operation?.status).toBe(
      owned ? "confirmed" : "failed",
    );
    expect(h.publish).toHaveBeenCalledTimes(owned ? 1 : 0);
  },
);
it("retains uncertain owned-agent removal for explicit readback, never replay", async () => {
  const h = ownedAgent();
  h.publish.mockRejectedValueOnce(new Error("connection lost"));
  await h.owner.capability.run(id, removeAgent);
  expect(h.owner.capability.snapshot(id).operation?.status).toBe("uncertain");
  await expect(h.owner.capability.run(id, removeAgent)).rejects.toThrow(
    /not be sent again/,
  );
  h.setRoles("member");
  await h.owner.capability.refresh(id);
  expect(h.owner.capability.snapshot(id).operation?.status).toBe("confirmed");
  expect(h.publish).toHaveBeenCalledOnce();
});

it("shares exact native/broker command admission fixtures", () => {
  const signedBy = (event: EventTemplate): EventTemplate =>
    JSON.parse(JSON.stringify(event).replaceAll("$viewer", viewer));
  for (const { event } of [
    ...contract.accepted,
    ...contract.transfer.accepted.map((c) => ({ event: signedBy(c.event) })),
  ])
    expect(() =>
      validateMemberAdministrationTemplate(event, viewer),
    ).not.toThrow();
  for (const { event } of [
    ...contract.rejected,
    ...contract.transfer.rejected.map((c) => ({ event: signedBy(c.event) })),
  ])
    expect(() => validateMemberAdministrationTemplate(event, viewer)).toThrow();
});

const transfer: MemberChange = {
  pubkey: target,
  expectedRole: "member",
  role: "owner",
};
const personProfile = () =>
  finalizeEvent(
    { kind: 0, created_at: 200, content: "{}", tags: [] },
    new Uint8Array(32).fill(4),
  );
function transferHarness(
  actor = "owner",
  role = "member",
  profiles: RelayEvent[] = [personProfile()],
) {
  const h = ownedAgent(actor, role);
  h.setProfiles(profiles);
  return h;
}
it("transfers ownership in one event that steps the viewer down to admin", async () => {
  const h = transferHarness();
  await h.owner.capability.run(id, transfer);
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.publish.mock.calls[0]?.[0].tags).toEqual([
    ["h", id],
    ["p", target, "owner"],
    ["p", viewer, "admin"],
  ]);
  const { operation, authority } = h.owner.capability.snapshot(id);
  expect(operation?.status).toBe("confirmed");
  expect(authority.roles).toEqual({ [viewer]: "admin", [target]: "owner" });
});
it.each([
  ["the viewer is an admin", "admin", "member", [personProfile()]],
  ["the heir is a bot", "owner", "bot", [personProfile()]],
  ["the heir has no profile", "owner", "member", []],
  ["the heir's profile is an agent's", "owner", "member", [agentProfile()]],
] as const)("refuses a transfer when %s", async (_, actor, role, profiles) => {
  const h = transferHarness(actor, role, [...profiles]);
  await h.owner.capability.run(id, { ...transfer, expectedRole: role });
  expect(h.sign).not.toHaveBeenCalled();
});
it("never offers a transfer to a co-owner", () => {
  const state = {
    roles: { [viewer]: "owner" as const, [target]: "owner" as const },
    canManage: true,
    canRemove: true,
    canRemoveOwnedAgent: false,
    system: false,
  };
  expect(canTransferOwnership(state, viewer, target, false)).toBe(false);
});
it("refuses a transfer in a system channel", async () => {
  const h = transferHarness();
  h.setEvents([
    h.record(39000, [
      ["d", id],
      ["t", "system"],
    ]),
    ...h.events().slice(1),
  ]);
  await h.owner.capability.run(id, transfer);
  expect(h.sign).not.toHaveBeenCalled();
});
it("leaves a transfer uncertain when only the heir's promotion lands", async () => {
  const h = transferHarness();
  h.publish.mockImplementationOnce(async () => h.setRoles("owner", "owner"));
  await h.owner.capability.run(id, transfer);
  expect(h.owner.capability.snapshot(id).operation?.status).toBe("uncertain");
});

it("authorizes a system-channel add only for a non-member other than the viewer with an editable role", () => {
  const state = {
    roles: { [viewer]: "owner" as const, [author]: "member" as const },
    canManage: true,
    canRemove: true,
    canRemoveOwnedAgent: false,
    system: true,
  };
  const add = (change: Partial<MemberChange>) => () =>
    authorizeMemberChange(state, viewer, {
      pubkey: target,
      expectedRole: "none",
      role: "member",
      ...change,
    } as MemberChange);

  expect(add({})).not.toThrow();
  expect(add({ pubkey: author })).toThrow(/Membership or permissions changed/);
  expect(add({ pubkey: viewer })).toThrow(/Membership or permissions changed/);
  expect(add({ role: "remove" })).toThrow(/Membership or permissions changed/);
  expect(add({ role: "owner" as never })).toThrow(
    /Membership or permissions changed/,
  );
});

it("administers one member change from a fresh roster read", async () => {
  const roles: Record<string, string> = { [target]: "member" };
  let after: object = {};
  const state = (value: object) => value as MemberAdministrationState;
  const admin = {
    refresh: vi.fn(async () => {}),
    run: vi.fn(async () => {}),
    snapshot: vi.fn(() =>
      state(
        admin.run.mock.calls.length
          ? { status: "ready", authority: { roles }, ...after }
          : { status: "ready", authority: { roles } },
      ),
    ),
  };
  const remove = (role: MemberRole | undefined) =>
    role ? ({ expectedRole: role, role: "remove" } as const) : undefined;
  const settled = (status: string, error?: string) => {
    after = {
      operation: { change: { pubkey: target, role: "remove" }, status },
      ...(error ? { error } : {}),
    };
  };

  settled("confirmed");
  await expect(administerMember(admin, id, target, remove)).resolves.toEqual({
    status: "confirmed",
  });
  expect(admin.refresh).toHaveBeenCalledWith(id);
  expect(admin.run).toHaveBeenCalledWith(id, {
    pubkey: target,
    expectedRole: "member",
    role: "remove",
  });

  // The roster already shows the result: nothing is sent.
  admin.run.mockClear();
  await expect(administerMember(admin, id, otherId, remove)).resolves.toEqual({
    status: "confirmed",
  });
  expect(admin.run).not.toHaveBeenCalled();

  settled("failed", "Rejected");
  await expect(administerMember(admin, id, target, remove)).resolves.toEqual({
    status: "failed",
    error: "Rejected",
  });
  settled("uncertain", "May have taken effect");
  await expect(administerMember(admin, id, target, remove)).resolves.toEqual({
    status: "uncertain",
    error: "May have taken effect",
  });
  // A pending, or someone else's, operation is no confirmation.
  settled("pending");
  await expect(administerMember(admin, id, target, remove)).resolves.toEqual({
    status: "uncertain",
  });
  after = {
    operation: {
      change: { pubkey: otherId, role: "remove" },
      status: "confirmed",
    },
  };
  await expect(administerMember(admin, id, target, remove)).resolves.toEqual({
    status: "uncertain",
  });

  admin.run.mockRejectedValueOnce(new Error("Offline"));
  await expect(administerMember(admin, id, target, remove)).resolves.toEqual({
    status: "failed",
    error: "Offline",
  });

  admin.snapshot.mockReturnValue(
    state({ status: "error", authority: { roles } }),
  );
  admin.run.mockClear();
  await expect(administerMember(admin, id, target, remove)).resolves.toEqual({
    status: "failed",
    error: "Roles unavailable",
  });
  await expect(
    administerMember(admin, id, target, remove, "Try again."),
  ).resolves.toEqual({ status: "failed", error: "Try again." });
  admin.snapshot.mockReturnValue(
    state({ status: "error", authority: { roles }, error: "Read failed" }),
  );
  await expect(administerMember(admin, id, target, remove)).resolves.toEqual({
    status: "failed",
    error: "Read failed",
  });
  expect(admin.run).not.toHaveBeenCalled();
});
