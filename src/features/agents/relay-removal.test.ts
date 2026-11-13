import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { afterEach, expect, it, vi } from "vitest";
import { UnattestedProfile } from "../relay/identity-archives";
import { PublishRejected } from "../relay/outbox";
import { createRelaySession } from "../relay/session";
import { archiveRelay, keypair, signed, type Key } from "../relay/testing";
import {
  type OwnerConsent,
  publishAgentRecord,
  removeAgentFromChannels,
  removeRelayAgent,
} from "./relay-removal";

const viewer = keypair(),
  relay = keypair(),
  agent = keypair(),
  stranger = keypair();
const owners: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of owners.splice(0)) await dispose();
});
function authTag(owner: Key) {
  const digest = createHash("sha256")
    .update(`nostr:agent-auth:${agent.pubkey}:`)
    .digest();
  return [
    "auth",
    owner.pubkey,
    "",
    bytesToHex(schnorr.sign(new Uint8Array(digest), owner.secret)),
  ];
}
function attested(owner: Key) {
  return signed(agent, {
    kind: 0,
    content: JSON.stringify({ name: "Agent", is_agent: true }),
    tags: [authTag(owner)],
  });
}
function setup(
  owner: Key = viewer,
  channels: Record<string, string[]> = {
    [`${"a".repeat(8)}-channel`]: [agent.pubkey, viewer.pubkey],
  },
  configure: (fixture: ReturnType<typeof archiveRelay>) => void = () => {},
) {
  const fixture = archiveRelay(viewer, relay, [attested(owner)], {}, channels);
  configure(fixture);
  const instance = createRelaySession(fixture.transport, {
    outboxStorage: { load: () => [], save: () => {} },
  });
  const operations: {
    controller: AbortController;
    release(): void;
    outcome: Promise<PromiseSettledResult<void>[]>;
  }[] = [];
  const dispose = async () => {
    for (const operation of operations) {
      operation.controller.abort();
      operation.release();
    }
    await Promise.all(operations.map(({ outcome }) => outcome));
    instance.dispose();
  };
  owners.push(dispose);
  const remove = (
    signal = new AbortController().signal,
    release = () => {},
    owner?: OwnerConsent,
  ) => {
    const controller = new AbortController();
    const removal = removeRelayAgent(
      instance.session,
      viewer.pubkey,
      agent.pubkey,
      AbortSignal.any([signal, controller.signal]),
      owner,
    );
    // Observe rejection immediately; retain it for the caller's assertion.
    operations.push({
      controller,
      release,
      outcome: Promise.allSettled([removal]),
    });
    return removal;
  };
  return { fixture, instance, remove };
}
const coordinate = () => `30177:${viewer.pubkey}:${agent.pubkey}`;

it("archives, deletes the owner record, then removes channel memberships", async () => {
  const { fixture, instance, remove } = setup();
  await remove();
  expect(fixture.published.map((event) => event.kind)).toEqual([9035, 5, 9001]);
  const deletion = fixture.published[1];
  expect(deletion?.pubkey).toBe(viewer.pubkey);
  expect(deletion?.content).toBe("");
  // The outbox adds its client-id; the native signer admits exactly this shape.
  expect(deletion?.tags).toEqual([
    ["a", coordinate()],
    ["client-id", expect.any(String)],
  ]);
  expect(fixture.deleted).toEqual(new Set([coordinate()]));
  expect(Object.values(fixture.channels).flat()).not.toContain(agent.pubkey);
  expect(fixture.archived.has(agent.pubkey)).toBe(true);
  expect(instance.session.outbox?.snapshot()).toEqual([]);
});

it("without an archive consent path removes nothing", async () => {
  const { fixture, remove } = setup(stranger);
  await expect(remove()).rejects.toThrow(
    "You can no longer archive this identity",
  );
  expect(fixture.published).toEqual([]);
  expect(fixture.deleted).toEqual(new Set());
});

it("archives an owned agent whose profile proves nothing once its own profile is republished naming its owner", async () => {
  const { fixture, remove } = setup(stranger);
  const issued = authTag(viewer);
  await remove(undefined, undefined, {
    issue: async () => issued,
    // The agent's own profile, naming its saved owner.
    attest: async () => {
      fixture.publishProfile(
        signed(agent, {
          kind: 0,
          content: JSON.stringify({ name: "Agent", bot: true }),
          tags: [authTag(viewer)],
          created_at: 1_700_000_001,
        }),
      );
    },
  });
  expect(fixture.published.map((event) => event.kind)).toEqual([9035, 5, 9001]);
  expect(fixture.published[0]?.tags).toContainEqual(issued);
  expect(fixture.archived.has(agent.pubkey)).toBe(true);
});

it("an owned agent whose profile proves nothing and can't be republished stays", async () => {
  const { fixture, remove } = setup(stranger);
  await expect(
    remove(undefined, undefined, { issue: async () => authTag(viewer) }),
  ).rejects.toBeInstanceOf(UnattestedProfile);
  expect(fixture.published).toEqual([]);
  expect(fixture.deleted).toEqual(new Set());
});

it("a refused archive stops the later steps and a retry finishes them", async () => {
  const { fixture, remove } = setup();
  fixture.script.fail = new PublishRejected("restricted: not authorized");
  await expect(remove()).rejects.toThrow("restricted: not authorized");
  expect(fixture.published).toEqual([]);
  expect(fixture.archived.has(agent.pubkey)).toBe(false);
  delete fixture.script.fail;
  await remove();
  expect(fixture.published.map((event) => event.kind)).toEqual([9035, 5, 9001]);
});

it("a refused record deletion fails Remove; the retry does not archive again", async () => {
  const { fixture, remove } = setup();
  fixture.removal.fail = new Error("restricted: not authorized");
  fixture.removal.failKind = 5;
  await expect(remove()).rejects.toThrow("restricted: not authorized");
  expect(fixture.published.map((event) => event.kind)).toEqual([9035]);
  expect(fixture.deleted.size).toBe(0);
  delete fixture.removal.fail;
  await remove();
  expect(fixture.published.map((event) => event.kind)).toEqual([9035, 5, 9001]);
  expect(fixture.deleted).toEqual(new Set([coordinate()]));
});

it("a refused channel removal does not fail Remove or leave outbox work", async () => {
  const { fixture, instance, remove } = setup();
  fixture.removal.fail = new Error("restricted: not authorized");
  fixture.removal.failKind = 9001;
  await remove();
  expect(fixture.published.map((event) => event.kind)).toEqual([9035, 5]);
  expect(fixture.archived.has(agent.pubkey)).toBe(true);
  expect(fixture.deleted).toEqual(new Set([coordinate()]));
  expect(Object.values(fixture.channels).flat()).toContain(agent.pubkey);
  expect(instance.session.outbox?.snapshot()).toEqual([]);
});

it("skips archived channels, where the relay refuses membership changes", async () => {
  const active = `${"a".repeat(8)}-channel`,
    archived = `${"b".repeat(8)}-channel`;
  const { fixture, instance } = setup(viewer, {
    [active]: [agent.pubkey, viewer.pubkey],
    [archived]: [agent.pubkey, viewer.pubkey],
  });
  fixture.archivedChannels.add(archived);
  const loaded = [
    { id: active, members: [agent.pubkey] },
    { id: archived, members: [agent.pubkey] },
  ];
  await removeAgentFromChannels(
    {
      ...instance.session,
      channels: { list: () => ({ channels: loaded }) },
    } as unknown as typeof instance.session,
    agent.pubkey,
    new AbortController().signal,
  );
  expect(fixture.published.map((event) => event.tags[0])).toEqual([
    ["h", active],
  ]);
  expect(fixture.channels[active]).not.toContain(agent.pubkey);
  expect(fixture.channels[archived]).toContain(agent.pubkey);
  expect(instance.session.outbox?.snapshot()).toEqual([]);
});

it("signs a new channel removal instead of resending one the relay would refuse as stale", async () => {
  const { fixture, instance } = setup();
  const removeFromChannels = () =>
    removeAgentFromChannels(
      instance.session,
      agent.pubkey,
      new AbortController().signal,
    );
  fixture.removal.fail = new Error("restricted: not authorized");
  fixture.removal.failKind = 9001;
  await expect(removeFromChannels()).rejects.toThrow();
  const [stale] = instance.session.outbox?.snapshot() ?? [];
  expect(stale?.event.kind).toBe(9001);
  delete fixture.removal.fail;
  // Past the relay's 15-minute timestamp bound, resending `stale` can never land.
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 20 * 60_000 });
  try {
    await removeFromChannels();
  } finally {
    vi.useRealTimers();
  }
  const [sent] = fixture.published;
  expect(fixture.published).toHaveLength(1);
  expect(sent?.id).not.toBe(stale?.event.id);
  expect(sent?.created_at).toBeGreaterThan(
    (stale?.event.created_at ?? 0) + 15 * 60,
  );
  expect(Object.values(fixture.channels).flat()).not.toContain(agent.pubkey);
  expect(instance.session.outbox?.snapshot()).toEqual([]);
});

it("waits for every channel removal before finishing, and leaves no outbox work", async () => {
  const [first, second] = ["first", "second"].map(
    (name) => `${name.padEnd(8, "x")}-channel`,
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const attempts: string[] = [];
  const { fixture, instance, remove } = setup(
    viewer,
    {
      [first as string]: [agent.pubkey, viewer.pubkey],
      [second as string]: [agent.pubkey, viewer.pubkey],
    },
    ({ transport }) => {
      const writer = transport.writer;
      if (!writer) throw new Error("fixture writer missing");
      const publish = writer.publish.bind(writer);
      // The first channel refuses at once; the second fails only after release.
      writer.publish = (event, signal) => {
        const channel = event.tags.find(([name]) => name === "h")?.[1];
        if (event.kind === 9001 && channel) attempts.push(channel);
        if (event.kind === 9001 && channel === first)
          return Promise.reject<void>(
            new PublishRejected("restricted: first refused"),
          );
        if (event.kind === 9001 && channel === second)
          return held.then<void>(() => {
            throw new PublishRejected("restricted: second refused");
          });
        return publish(event, signal);
      };
    },
  );
  let finished = false;
  try {
    const removal = remove(undefined, release);
    void Promise.allSettled([removal]).then(() => {
      finished = true;
    });
    await expect.poll(() => fixture.deleted.size).toBe(1);
    // Both removals were attempted; the first has already been refused.
    await expect.poll(() => [...attempts].sort()).toEqual([first, second]);
    expect(finished).toBe(false);
    release();
    await removal;
  } finally {
    release();
  }
  expect(instance.session.outbox?.snapshot()).toEqual([]);
});

it("settles already enqueued channel removals when a later enqueue throws", async () => {
  const [first, second] = ["first", "second"].map(
    (name) => `${name.padEnd(8, "x")}-channel`,
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { instance, remove } = setup(
    viewer,
    {
      [first as string]: [agent.pubkey, viewer.pubkey],
      [second as string]: [agent.pubkey, viewer.pubkey],
    },
    ({ transport }) => {
      const writer = transport.writer;
      if (!writer) throw new Error("fixture writer missing");
      const publish = writer.publish.bind(writer);
      writer.publish = (event, signal) => {
        // Unrelated filler operations fail and stay in the outbox.
        if (
          event.kind === 5 &&
          !event.tags.some(([, value]) => value === coordinate())
        )
          return Promise.reject<void>(new PublishRejected("filler"));
        // The one enqueued channel removal fails only after release.
        if (event.kind === 9001)
          return held.then<void>(() => {
            throw new PublishRejected("restricted: refused");
          });
        return publish(event, signal);
      };
    },
  );
  const outbox = instance.session.outbox;
  if (!outbox) throw new Error("fixture outbox missing");
  await outbox.ready();
  // Fill the outbox (256 operations) so it takes one channel removal, then
  // refuses the next.
  for (let index = 0; index < 255; index++)
    outbox.send({
      kind: 5,
      content: "",
      tags: [["a", `30177:${viewer.pubkey}:${index}`]],
    });
  await expect
    .poll(() =>
      outbox.snapshot().every(({ delivery }) => delivery === "failed"),
    )
    .toBe(true);
  const removals = () =>
    outbox.snapshot().filter(({ event }) => event.kind === 9001);
  let finished = false;
  try {
    const removal = remove(undefined, release);
    void Promise.allSettled([removal]).then(() => {
      finished = true;
    });
    // One removal is enqueued and still sending; the next enqueue threw.
    await expect
      .poll(() => removals().map(({ delivery }) => delivery))
      .toEqual(["sending"]);
    await expect.poll(() => outbox.snapshot().length).toBe(256);
    expect(finished).toBe(false);
    release();
    await removal;
  } finally {
    release();
  }
  expect(removals()).toEqual([]);
  expect(outbox.snapshot()).toHaveLength(255);
});

it("a cancelled removal signs and publishes nothing", async () => {
  const { fixture, remove } = setup();
  const controller = new AbortController();
  controller.abort();
  await expect(remove(controller.signal)).rejects.toBeDefined();
  expect(fixture.published).toEqual([]);
  expect(fixture.signedBy).toEqual([]);
});

it("publishes the owner's record of an agent with its runtime", async () => {
  const { fixture, instance } = setup();
  await publishAgentRecord(
    instance.session,
    {
      pubkey: agent.pubkey,
      name: "Agent",
      picture: "https://example.test/a.png",
      runtime: "example/echo",
    },
    new AbortController().signal,
  );
  const [listed] = fixture.published;
  expect(listed).toMatchObject({ kind: 30177, pubkey: viewer.pubkey });
  expect(JSON.parse(listed?.content ?? "")).toEqual({
    name: "Agent",
    picture: "https://example.test/a.png",
    parallelism: 1,
    respond_to: "owner-only",
  });
  expect(listed?.tags).toEqual([
    ["d", agent.pubkey],
    ["runtime", "example/echo"],
    ["client-id", expect.any(String)],
  ]);
  expect(instance.session.outbox?.snapshot()).toEqual([]);
});

it("keeps the settings and tags of the record it replaces", async () => {
  const { fixture, instance } = setup();
  const written = await publishAgentRecord(
    instance.session,
    {
      pubkey: agent.pubkey,
      name: "Renamed",
      runtime: "example/echo",
      prior: {
        content: {
          name: "Agent",
          picture: "https://example.test/old.png",
          parallelism: 3,
          respond_to: "anyone",
          persona_id: "p1",
        },
        tags: [
          ["d", agent.pubkey],
          ["runtime", "example/old"],
          ["a", "30175:owner:p1"],
          ["client-id", "old"],
        ],
      },
    },
    new AbortController().signal,
  );
  const [listed] = fixture.published;
  const content = {
    name: "Renamed",
    parallelism: 3,
    respond_to: "anyone",
    persona_id: "p1",
  };
  expect(JSON.parse(listed?.content ?? "")).toEqual(content);
  expect(listed?.tags).toEqual([
    ["d", agent.pubkey],
    ["runtime", "example/echo"],
    ["a", "30175:owner:p1"],
    ["client-id", expect.any(String)],
  ]);
  expect(written).toEqual({
    content,
    tags: [
      ["d", agent.pubkey],
      ["runtime", "example/echo"],
      ["a", "30175:owner:p1"],
    ],
  });
});
