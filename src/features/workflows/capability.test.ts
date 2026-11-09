import { afterEach, assert, expect, it, vi } from "vitest";
import { createWorkflows } from "./capability";
import {
  createOutbox,
  PublishRejected,
  type OutgoingEvent,
} from "../relay/outbox";
import { keypair, signed, flush } from "../relay/testing";
import type { RelayEvent } from "../relay/events";
import { eventDto } from "../relay/events";
import {
  createProfileDirectory,
  type ProfileQueries,
} from "../relay/profile-directory";
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
const id = "11111111-1111-4111-8111-111111111111",
  channelId = "22222222-2222-4222-8222-222222222222",
  runId = "33333333-3333-4333-8333-333333333333";
const yaml =
  "name: Fixture\nenabled: false\ntrigger:\n  on: message_posted\nsteps:\n  - id: send\n    action: send_message\n    text: Hi\n";
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function setup(
  relayHttpUrl?: string,
  key = keypair(),
  profiles?: ProfileQueries,
  initial: readonly OutgoingEvent[] = [],
) {
  let saved: readonly OutgoingEvent[] = [],
    allowed = true;
  let settle!: (value: string) => void, reject!: (error: Error) => void;
  const sign = vi.fn(async (template: Parameters<typeof signed>[1]) =>
    signed(key, template),
  );
  const publish = vi.fn(
    (_event: RelayEvent, _signal: AbortSignal) =>
      new Promise<string>((resolve, fail) => {
        settle = resolve;
        reject = fail;
      }),
  );
  const outbox = createOutbox(
    key.pubkey,
    { kinds: [30620, 46020, 5], sign, publish },
    {
      load: () => initial,
      save: (rows) => {
        saved = structuredClone(rows);
      },
    },
    {
      needsReceipt: (event) => [30620, 46020, 5].includes(event.kind),
      onReceipt: (event, message) => workflows.receipt(event, message),
    },
  );
  const read = vi.fn(async () => [] as RelayEvent[]);
  const workflows = createWorkflows({
    profiles,
    viewer: key.pubkey,
    reader: { read },
    outbox: outbox.outbox,
    local: outbox.local,
    host: {
      runs: async () => ({ runs: [], next: null }),
    },
    canAccess: () => allowed,
    relayHttpUrl,
  });
  disposers.push(() => {
    workflows.dispose();
    outbox.dispose();
  });
  const definition = {
    id,
    channelId,
    owner: key.pubkey,
    revision: "a".repeat(64),
    createdAt: 1,
    yaml,
  };
  return {
    ...workflows,
    outbox,
    read,
    sign,
    publish,
    definition,
    saved: () => saved,
    settle: (value: string) => settle(value),
    reject: (error: Error) => reject(error),
    revoke: () => {
      allowed = false;
      workflows.clear();
    },
  };
}
function ownedWorkflow() {
  const human = keypair(),
    agent = keypair();
  const attestation = [
    "auth",
    human.pubkey,
    "",
    bytesToHex(
      schnorr.sign(
        createHash("sha256")
          .update(`nostr:agent-auth:${agent.pubkey}:`)
          .digest(),
        human.secret,
      ),
    ),
  ];
  const profile = (tags = [attestation], created_at = 1) =>
    eventDto(
      signed(agent, {
        kind: 0,
        created_at,
        content: JSON.stringify({ owner: human.pubkey, is_agent: true }),
        tags,
      }),
    );
  const directory = createProfileDirectory({ read: async () => [profile()] });
  disposers.push(directory.dispose);
  const h = setup(undefined, human, directory.queries);
  const workflow = { ...h.definition, owner: agent.pubkey };
  return { h, human, agent, directory, profile, workflow };
}

it("uses hydrated verified ownership, signs as the human, and retains deletion recovery after ownership replacement", async () => {
  const { h, human, agent, directory, profile, workflow } = ownedWorkflow();
  expect(h.capability.permissions.canDelete(workflow)).toBe(false);
  const listener = vi.fn();
  const stop = h.capability.permissions.subscribe(listener);
  h.read.mockResolvedValue([
    eventDto(
      signed(agent, {
        kind: 30620,
        created_at: 1,
        content: yaml,
        tags: [
          ["h", channelId],
          ["d", id],
        ],
      }),
    ),
  ]);
  const view = h.capability.definitions(channelId);
  await view.refresh();
  await directory.queries.ensure([agent.pubkey]);
  await vi.waitFor(() =>
    expect(h.capability.permissions.canDelete(workflow)).toBe(true),
  );
  expect(listener).toHaveBeenCalled();
  expect(() =>
    h.capability.save({ channelId, yaml, existing: workflow }),
  ).toThrow(/owner/i);
  expect(() => h.capability.trigger(workflow)).toThrow(/owner/i);
  const operation = h.capability.delete(workflow);
  await flush();
  const event = h.publish.mock.calls[0]?.[0];
  assert.ok(event);
  expect(event.pubkey).toBe(human.pubkey);
  expect(event.tags).toContainEqual(["a", `30620:${agent.pubkey}:${id}`]);
  expect(() => h.validate(event)).not.toThrow();
  expect(h.capability.operations.snapshot()[0]).toMatchObject({
    eventId: operation,
    workflow: { id, channelId, owner: agent.pubkey },
    action: "delete",
    outcome: "pending",
  });
  directory.accept([profile([], 2)]);
  expect(h.capability.permissions.canDelete(workflow)).toBe(false);
  expect(() => h.validate(event)).toThrow(/verified agent owner/);
  expect(() => h.capability.delete(workflow)).toThrow(/owner/i);
  // Revocation must not hide a command that may already have reached the relay.
  expect(h.capability.operations.snapshot()[0]?.eventId).toBe(operation);
  h.settle("");
  await flush();
  expect(h.capability.operations.snapshot()[0]?.outcome).toBe("unknown");
  h.read.mockResolvedValue([]);
  await view.refresh();
  expect(h.capability.operations.snapshot()[0]?.outcome).toBe("succeeded");
  expect(h.publish).toHaveBeenCalledOnce();
  stop();
  view.dispose();
});

it.each([
  "metadata only",
  "forged attestation",
  "another human",
  "unverified profile",
])("denies workflow deletion with %s ownership", async (scenario) => {
  const { h, agent, directory, profile, workflow } = ownedWorkflow();
  let event: RelayEvent = profile();
  if (scenario === "metadata only") event = profile([]);
  if (scenario === "forged attestation")
    event = profile([["auth", h.definition.owner, "", "0".repeat(128)]]);
  if (scenario === "another human") {
    const other = keypair();
    event = profile([
      [
        "auth",
        other.pubkey,
        "",
        bytesToHex(
          schnorr.sign(
            createHash("sha256")
              .update(`nostr:agent-auth:${agent.pubkey}:`)
              .digest(),
            other.secret,
          ),
        ),
      ],
    ]);
  }
  if (scenario === "unverified profile") event = { ...event };
  directory.accept([event]);
  await flush();
  expect(h.capability.permissions.canDelete(workflow)).toBe(false);
  expect(() => h.capability.delete(workflow)).toThrow(/owner/i);
  expect(() =>
    h.validate({
      ...event,
      pubkey: h.definition.owner,
      kind: 5,
      content: "",
      tags: [
        ["h", channelId],
        ["a", `30620:${agent.pubkey}:${id}`],
      ],
    }),
  ).toThrow();
  expect(h.sign).not.toHaveBeenCalled();
});

it("keeps own-agent rejection visible and permits a deliberate retry without enabling unrelated deletes", async () => {
  const { h, directory, workflow } = ownedWorkflow();
  await directory.queries.ensure([workflow.owner]);
  await vi.waitFor(() =>
    expect(h.capability.permissions.canDelete(workflow)).toBe(true),
  );
  h.capability.delete(workflow);
  await flush();
  h.reject(new PublishRejected("ownership revoked"));
  await flush();
  expect(h.capability.operations.snapshot()[0]).toMatchObject({
    action: "delete",
    outcome: "rejected",
    workflow: { id, channelId, owner: workflow.owner },
  });
  h.capability.delete(workflow);
  await flush();
  expect(h.publish).toHaveBeenCalledTimes(2);
  expect(() =>
    h.capability.delete({ ...workflow, owner: keypair().pubkey }),
  ).toThrow(/owner/i);
  h.revoke();
  expect(h.capability.permissions.canDelete(workflow)).toBe(false);
});

it("restores an own-agent delete without current ownership evidence and never automatically republishes it", async () => {
  const { h, human, directory, workflow } = ownedWorkflow();
  await directory.queries.ensure([workflow.owner]);
  await vi.waitFor(() =>
    expect(h.capability.permissions.canDelete(workflow)).toBe(true),
  );
  const operation = h.capability.delete(workflow);
  await flush();
  h.settle("");
  await flush();
  const journal = h.saved();
  h.outbox.dispose();
  h.dispose();
  directory.clear();
  const restored = setup(undefined, human, directory.queries, journal);
  await flush();
  expect(restored.capability.permissions.canDelete(workflow)).toBe(false);
  expect(restored.capability.operations.snapshot()[0]).toMatchObject({
    eventId: operation,
    action: "delete",
    workflow: { id, channelId, owner: workflow.owner },
    outcome: "unknown",
  });
  const view = restored.capability.definitions(channelId);
  await view.refresh();
  expect(restored.capability.operations.snapshot()[0]?.outcome).toBe("unknown");
  expect(restored.publish).not.toHaveBeenCalled();
  view.dispose();
});

it("save preserves exact YAML/coordinate/revision, receipt success is distinct from signed head readback", async () => {
  const h = setup();
  const view = h.capability.definitions(channelId);
  const operation = h.capability.save({
    channelId,
    yaml,
    existing: h.definition,
  });
  await flush();
  const event = h.publish.mock.calls[0]?.[0];
  expect(event).toBeDefined();
  expect(event?.content).toBe(yaml);
  expect(event?.tags).toContainEqual([
    "expected-revision",
    h.definition.revision,
  ]);
  expect(event?.tags).toContainEqual(["d", id]);
  h.settle(`response:${JSON.stringify({ workflow_id: id })}`);
  await flush();
  expect(h.capability.operations.snapshot()[0]).toMatchObject({
    eventId: operation,
    outcome: "succeeded",
  });
  // Local echo and receipt never masquerade as a freshly read committed head.
  expect(view.snapshot()).toMatchObject({
    status: "idle",
    data: { items: [] },
  });
  await view.refresh();
  expect(view.snapshot().data.items).toEqual([]);
});
it.each([
  [JSON.stringify({ run_id: runId }), "succeeded", runId],
  [JSON.stringify({ workflow_id: id, run_id: runId }), "succeeded", runId],
  [JSON.stringify({ workflow_id: runId, run_id: runId }), "unknown", undefined],
  [JSON.stringify({ run_id: "bad" }), "unknown", undefined],
  [
    JSON.stringify({ run_id: runId, webhook_secret: "PRIVATE" }),
    "unknown",
    undefined,
  ],
  ["{PRIVATE malformed", "unknown", undefined],
])(
  "manual run only correlates validated returned run ID: %s",
  async (payload, outcome, expectedRun) => {
    const h = setup();
    h.capability.trigger(h.definition);
    await flush();
    h.settle(`response:${payload}`);
    await flush();
    expect(h.capability.operations.snapshot()[0]?.outcome).toBe(outcome);
    expect(h.capability.operations.snapshot()[0]?.runId).toBe(expectedRun);
    expect(h.read).not.toHaveBeenCalled();
    expect(JSON.stringify(h.saved())).not.toContain("PRIVATE");
    expect(JSON.stringify(h.capability.operations.snapshot())).not.toContain(
      "PRIVATE",
    );
  },
);
it("lost receipt plus echo stays unknown; dismissal never repeats the command", async () => {
  const h = setup();
  const operation = h.capability.trigger(h.definition);
  await flush();
  const event = h.publish.mock.calls[0]?.[0];
  if (!event) throw new Error("missing publication");
  h.outbox.observe([event]);
  h.reject(new Error("PRIVATE lost"));
  await flush();
  expect(h.capability.operations.snapshot()[0]).toMatchObject({
    eventId: operation,
    delivery: "seen",
    outcome: "unknown",
  });
  await h.capability.operations.dismiss(operation);
  expect(h.capability.operations.snapshot()).toEqual([]);
  expect(h.publish).toHaveBeenCalledTimes(1);
  expect(h.sign).toHaveBeenCalledTimes(1);
});
it("explicit rejection is rejected, not unknown; revocation fences late receipts without discarding durable intent", async () => {
  const h = setup();
  h.capability.trigger(h.definition);
  await flush();
  h.reject(new PublishRejected("PRIVATE rejection"));
  await flush();
  expect(h.capability.operations.snapshot()[0]?.outcome).toBe("rejected");
  const id = h.capability.trigger(h.definition);
  await flush();
  h.revoke();
  h.settle(`response:${JSON.stringify({ run_id: runId })}`);
  await flush();
  expect(h.capability.operations.snapshot()).toEqual([]);
  expect(h.saved().some((row) => row.event.id === id)).toBe(true);
  expect(JSON.stringify(h.saved())).not.toContain("PRIVATE");
});
it("a secret-bearing save receipt succeeds; the secret is taken once and never journaled or surfaced", async () => {
  const h = setup("https://relay.test");
  const operation = h.capability.save({
    channelId,
    yaml: yaml.replace("message_posted", "webhook"),
    existing: h.definition,
  });
  await flush();
  expect(h.publish).toHaveBeenCalledTimes(1);
  expect(h.publish.mock.calls[0]?.[0]?.content).toContain("on: webhook");
  h.settle(
    `response:${JSON.stringify({ workflow_id: id, webhook_secret: "PRIVATE-SECRET" })}`,
  );
  await flush();
  const settled = h.capability.operations.snapshot()[0];
  expect(settled).toMatchObject({
    eventId: operation,
    outcome: "succeeded",
    secretHeld: true,
  });
  expect(settled?.error).toBeUndefined();
  expect(JSON.stringify(h.capability.operations.snapshot())).not.toContain(
    "PRIVATE",
  );
  expect(JSON.stringify(h.saved())).not.toContain("PRIVATE");
  expect(h.capability.webhookUrl(id)).toBe(`https://relay.test/hooks/${id}`);
  expect(() => h.capability.webhookUrl("../admin")).toThrow();
  expect(h.capability.takeWebhookSecret("f".repeat(64))).toBeUndefined();
  expect(h.capability.takeWebhookSecret(operation)).toBe("PRIVATE-SECRET");
  expect(h.capability.operations.snapshot()[0]).toMatchObject({
    eventId: operation,
    outcome: "succeeded",
  });
  expect(h.capability.operations.snapshot()[0]?.secretHeld).toBeUndefined();
  expect(h.capability.takeWebhookSecret(operation)).toBeUndefined();
  expect(JSON.stringify(h.saved())).not.toContain("PRIVATE");
});
it("a non-string secret keeps the save unknown; clear() forgets a held secret", async () => {
  const h = setup();
  const first = h.capability.save({
    channelId,
    yaml,
    existing: h.definition,
  });
  await flush();
  h.settle(
    `response:${JSON.stringify({ workflow_id: id, webhook_secret: 42 })}`,
  );
  await flush();
  expect(h.capability.operations.snapshot()[0]?.outcome).toBe("unknown");
  expect(h.capability.operations.snapshot()[0]?.secretHeld).toBeUndefined();
  expect(h.capability.takeWebhookSecret(first)).toBeUndefined();
  expect(h.capability.webhookUrl(id)).toBeUndefined();
  const second = h.capability.save({
    channelId,
    yaml,
    existing: h.definition,
  });
  await flush();
  h.settle(
    `response:${JSON.stringify({ workflow_id: id, webhook_secret: "PRIVATE-SECRET" })}`,
  );
  await flush();
  expect(h.capability.operations.snapshot()[1]).toMatchObject({
    eventId: second,
    outcome: "succeeded",
    secretHeld: true,
  });
  h.clear();
  expect(h.capability.takeWebhookSecret(second)).toBeUndefined();
  expect(
    h.capability.operations.snapshot().some((item) => item.secretHeld),
  ).toBe(false);
  expect(JSON.stringify(h.saved())).not.toContain("PRIVATE");
});
it("stale/legacy deletion receipt never proves deletion", async () => {
  const h = setup();
  h.capability.delete(h.definition);
  await flush();
  h.settle("");
  await flush();
  expect(h.capability.operations.snapshot()[0]?.outcome).toBe("unknown");
  h.capability.delete(h.definition);
  await flush();
  h.settle(`response:${JSON.stringify({ workflow_id: id, deleted: true })}`);
  await flush();
  expect(h.capability.operations.snapshot()[1]?.outcome).toBe("succeeded");
});

it("reuses completed aggregate definitions only for fresh session-cache reads", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const h = setup();
  const other = "44444444-4444-4444-8444-444444444444";
  const row = signed(keypair(), {
    kind: 30620,
    created_at: 1,
    content: yaml,
    tags: [
      ["h", channelId],
      ["d", id],
    ],
  });
  h.read.mockResolvedValue([row]);
  const first = h.capability.definitions([channelId, other]);
  await first.refresh({ ifStale: true });
  expect(h.read).toHaveBeenCalledTimes(1);
  first.dispose();

  const fresh = h.capability.definitions([other, channelId]);
  expect(fresh.snapshot()).toMatchObject({
    status: "ready",
    data: { items: [{ revision: row.id }] },
  });
  await fresh.refresh({ ifStale: true });
  expect(h.read).toHaveBeenCalledTimes(1);
  await fresh.refresh();
  expect(h.read).toHaveBeenCalledTimes(2);
  fresh.dispose();

  vi.setSystemTime(10_001);
  const stale = h.capability.definitions([channelId, other]);
  expect(stale.snapshot()).toMatchObject({
    status: "ready",
    data: { items: [{ revision: row.id }] },
  });
  const refreshing = stale.refresh({ ifStale: true });
  expect(stale.snapshot()).toMatchObject({
    status: "loading",
    data: { items: [{ revision: row.id }] },
  });
  await refreshing;
  expect(h.read).toHaveBeenCalledTimes(3);
  stale.dispose();

  vi.setSystemTime(70_002);
  expect(h.capability.definitions([channelId, other]).snapshot()).toMatchObject(
    {
      status: "idle",
      data: { items: [] },
    },
  );
});

it("evicts only overlapping aggregate definition cache entries after completed reads", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const h = setup();
  const other = "44444444-4444-4444-8444-444444444444";
  const disjoint = "55555555-5555-4555-8555-555555555555";
  const row = signed(keypair(), {
    kind: 30620,
    created_at: 1,
    content: yaml,
    tags: [
      ["h", channelId],
      ["d", id],
    ],
  });

  h.read.mockResolvedValueOnce([]);
  const emptySuperset = h.capability.definitions([channelId, other]);
  await emptySuperset.refresh();
  emptySuperset.dispose();

  h.read.mockResolvedValueOnce([]);
  const emptyDisjoint = h.capability.definitions([disjoint]);
  await emptyDisjoint.refresh();
  emptyDisjoint.dispose();

  h.read.mockResolvedValueOnce([row]);
  const subset = h.capability.definitions([channelId]);
  await subset.refresh();
  subset.dispose();
  expect(h.read).toHaveBeenCalledTimes(3);

  const cachedDisjoint = h.capability.definitions([disjoint]);
  expect(cachedDisjoint.snapshot()).toMatchObject({
    status: "ready",
    data: { items: [] },
  });
  await cachedDisjoint.refresh({ ifStale: true });
  expect(h.read).toHaveBeenCalledTimes(3);
  cachedDisjoint.dispose();

  const evictedSuperset = h.capability.definitions([other, channelId]);
  expect(evictedSuperset.snapshot()).toMatchObject({
    status: "idle",
    data: { items: [] },
  });
  h.read.mockResolvedValueOnce([row]);
  await evictedSuperset.refresh({ ifStale: true });
  expect(evictedSuperset.snapshot()).toMatchObject({
    status: "ready",
    data: { items: [{ revision: row.id }] },
  });
  evictedSuperset.dispose();
  expect(h.read).toHaveBeenCalledTimes(4);

  const evictedSubset = h.capability.definitions([channelId]);
  expect(evictedSubset.snapshot()).toMatchObject({
    status: "idle",
    data: { items: [] },
  });
  h.read.mockRejectedValueOnce(new Error("offline"));
  await evictedSubset.refresh();
  expect(evictedSubset.snapshot()).toMatchObject({
    status: "error",
    data: { items: [] },
  });
  evictedSubset.dispose();

  const retainedSuperset = h.capability.definitions([channelId, other]);
  expect(retainedSuperset.snapshot()).toMatchObject({
    status: "ready",
    data: { items: [{ revision: row.id }] },
  });
  await retainedSuperset.refresh({ ifStale: true });
  expect(h.read).toHaveBeenCalledTimes(5);
});

it("an empty deletion receipt reconciles only after a complete fresh read without its coordinate", async () => {
  const h = setup();
  const operation = h.capability.delete(h.definition);
  await flush();
  h.settle("");
  await flush();
  expect(h.capability.operations.snapshot()[0]?.outcome).toBe("unknown");
  await h.capability.definitions(channelId).refresh();
  expect(h.read).toHaveBeenCalledWith(
    [{ kinds: [30620], "#h": [channelId], limit: 100 }],
    expect.objectContaining({ fresh: true }),
  );
  expect(h.capability.operations.snapshot()[0]).toMatchObject({
    eventId: operation,
    action: "delete",
    delivery: "accepted",
    outcome: "succeeded",
  });
  expect(h.capability.operations.snapshot()[0]?.error).toBeUndefined();
  expect(h.publish).toHaveBeenCalledTimes(1);
  expect(h.sign).toHaveBeenCalledTimes(1);
});

it.each([
  "retained",
  "partial",
  "other-channel",
  "failed-read",
  "lost-receipt",
  "echo-only",
  "rejected",
  "malformed-receipt",
  "revoked",
  "disposed",
])("does not confirm deletion from %s", async (scenario) => {
  const h = setup();
  h.capability.delete(h.definition);
  await flush();
  const event = h.publish.mock.calls[0]?.[0];
  if (!event) throw new Error("missing deletion");
  if (scenario === "echo-only") h.outbox.observe([event]);
  if (scenario === "lost-receipt" || scenario === "echo-only")
    h.reject(new Error("Lost receipt"));
  else if (scenario === "rejected")
    h.reject(new PublishRejected("Deletion rejected"));
  else h.settle(scenario === "malformed-receipt" ? "response:{" : "");
  await flush();
  const view = h.capability.definitions(
    scenario === "other-channel" ? runId : channelId,
  );
  const retained = {
    ...event,
    kind: 30620,
    content: yaml,
    tags: [
      ["h", channelId],
      ["d", id],
    ],
  };
  if (scenario === "retained") h.read.mockResolvedValue([retained]);
  if (scenario === "partial")
    h.read.mockResolvedValue(
      Array.from({ length: 100 }, (_, index) => ({
        ...retained,
        id: index.toString(16).padStart(64, "0"),
        tags: [
          ["h", channelId],
          ["d", runId],
        ],
      })),
    );
  if (scenario === "failed-read")
    h.read.mockRejectedValue(new Error("Offline"));
  let release!: () => void;
  if (scenario === "revoked" || scenario === "disposed")
    h.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([]);
        }),
    );
  const reading = view.refresh();
  await flush();
  try {
    if (scenario === "revoked") h.revoke();
    if (scenario === "disposed") view.dispose();
  } finally {
    release?.();
  }
  await reading;
  expect(
    h.capability.operations.snapshot().some((op) => op.outcome === "succeeded"),
  ).toBe(false);
  expect(h.publish).toHaveBeenCalledTimes(1);
});

it("a read started before deletion acceptance cannot reconcile absence; a later read can", async () => {
  const h = setup();
  h.capability.delete(h.definition);
  await flush();
  let release!: () => void;
  h.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve([]);
      }),
  );
  const view = h.capability.definitions(channelId);
  const reading = view.refresh();
  await flush();
  try {
    h.settle("");
    await flush();
  } finally {
    release();
  }
  await reading;
  expect(h.capability.operations.snapshot()[0]?.outcome).toBe("unknown");
  await view.refresh();
  expect(h.capability.operations.snapshot()[0]?.outcome).toBe("succeeded");
  expect(h.publish).toHaveBeenCalledTimes(1);
});

it("refresh during an older in-flight read queues deletion readback after that read", async () => {
  const h = setup();
  h.capability.delete(h.definition);
  await flush();
  let release!: () => void;
  h.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve([]);
      }),
  );
  const view = h.capability.definitions(channelId);
  const oldRead = view.refresh();
  await flush();
  let readback: Promise<void> | undefined;
  try {
    h.settle("");
    await flush();
    readback = view.refresh();
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.capability.operations.snapshot()[0]?.outcome).toBe("unknown");
  } finally {
    release();
  }
  await Promise.all([oldRead, readback]);
  expect(h.read).toHaveBeenCalledTimes(2);
  expect(h.capability.operations.snapshot()[0]?.outcome).toBe("succeeded");
  expect(h.publish).toHaveBeenCalledTimes(1);
});

it.each(["clear", "interrupt"] as const)(
  "%s fences queued deletion readback without starting another read",
  async (action) => {
    const h = setup();
    h.capability.delete(h.definition);
    await flush();
    let release!: () => void;
    h.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([]);
        }),
    );
    const view = h.capability.definitions(channelId);
    const oldRead = view.refresh();
    await flush();
    h.settle("");
    await flush();
    const queued = view.refresh();
    try {
      h[action]();
    } finally {
      release();
    }
    await Promise.all([oldRead, queued]);
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.capability.operations.snapshot()[0]?.outcome).toBe("unknown");
    expect(view.snapshot().status).toBe(action === "clear" ? "idle" : "error");
  },
);

it.each([true, false])(
  "fresh exact saved configuration resolves a lost save receipt without replay (echo=%s)",
  async (echo) => {
    const h = setup();
    const operation = h.capability.save({
      channelId,
      yaml,
      existing: h.definition,
    });
    await flush();
    const event = h.publish.mock.calls[0]?.[0];
    if (!event) throw new Error("missing publication");
    if (echo) h.outbox.observe([event]);
    h.reject(new Error("lost receipt"));
    await flush();
    expect(h.capability.operations.snapshot()[0]?.outcome).toBe("unknown");
    h.read.mockResolvedValue([event]);
    const view = h.capability.definitions(channelId);
    expect(h.read).not.toHaveBeenCalled();
    await view.refresh();
    expect(h.read).toHaveBeenCalledWith(
      [{ kinds: [30620], "#h": [channelId], limit: 100 }],
      expect.objectContaining({ fresh: true }),
    );
    expect(view.snapshot()).toMatchObject({
      status: "ready",
      data: { items: [{ revision: operation }] },
    });
    expect(h.capability.operations.snapshot()[0]).toMatchObject({
      eventId: operation,
      outcome: "succeeded",
    });
    expect(h.capability.operations.snapshot()[0]?.error).toBeUndefined();
    expect(h.sign).toHaveBeenCalledTimes(1);
    expect(h.publish).toHaveBeenCalledTimes(1);
  },
);
it.each([
  "revision",
  "owner",
  "channel",
  "workflow",
  "newer-head",
  "read-failure",
  "revoked",
  "disposed",
])(
  "fresh read does not resolve an unknown save on %s mismatch or lost interest",
  async (caseName) => {
    const h = setup();
    h.capability.save({ channelId, yaml, existing: h.definition });
    await flush();
    const event = h.publish.mock.calls[0]?.[0];
    if (!event) throw new Error("missing publication");
    h.reject(new Error("lost receipt"));
    await flush();
    const view = h.capability.definitions(channelId);
    let row = event;
    if (caseName === "revision") row = { ...event, id: "f".repeat(64) };
    if (caseName === "owner") row = { ...event, pubkey: "f".repeat(64) };
    if (caseName === "channel" || caseName === "workflow")
      row = {
        ...event,
        tags: event.tags.map((tag) =>
          tag[0] === (caseName === "channel" ? "h" : "d")
            ? [tag[0], runId]
            : tag,
        ),
      };
    let resolve!: (events: RelayEvent[]) => void;
    h.read.mockImplementationOnce(
      () =>
        new Promise<RelayEvent[]>((done) => {
          resolve = done;
        }),
    );
    const reading = view.refresh();
    await flush();
    if (caseName === "revoked") h.revoke();
    if (caseName === "disposed") view.dispose();
    resolve(
      caseName === "newer-head"
        ? [
            event,
            { ...event, id: "f".repeat(64), created_at: event.created_at + 1 },
          ]
        : caseName === "read-failure"
          ? [{ ...event, kind: 9 }]
          : [row],
    );
    await reading;
    expect(
      h.capability.operations
        .snapshot()
        .some((op) => op.outcome === "succeeded"),
    ).toBe(false);
    expect(h.publish).toHaveBeenCalledTimes(1);
  },
);
it("fresh saved configuration never resolves an unknown manual run", async () => {
  const h = setup();
  h.capability.trigger(h.definition);
  await flush();
  h.reject(new Error("lost receipt"));
  await flush();
  const event = h.publish.mock.calls[0]?.[0];
  if (!event) throw new Error("missing publication");
  h.read.mockResolvedValue([{ ...event, kind: 30620, content: yaml }]);
  await h.capability.definitions(channelId).refresh();
  expect(h.capability.operations.snapshot()[0]?.outcome).toBe("unknown");
});

it("dismissal cannot unlock an active echoed command", async () => {
  const h = setup();
  const operation = h.capability.trigger(h.definition);
  await flush();
  const event = h.publish.mock.calls[0]?.[0];
  if (!event) throw new Error("missing publication");
  h.outbox.observe([event]);
  await expect(h.capability.operations.dismiss(operation)).rejects.toThrow(
    "still being delivered",
  );
  expect(h.capability.operations.snapshot()[0]?.eventId).toBe(operation);
  h.settle(`response:${JSON.stringify({ run_id: runId })}`);
  await flush();
  expect(h.capability.operations.snapshot()[0]?.outcome).toBe("succeeded");
  await h.capability.operations.dismiss(operation);
  expect(h.capability.operations.snapshot()).toEqual([]);
});

it.each(["save", "trigger", "delete"] as const)(
  "foreign definitions stay browsable but cannot be used for %s",
  async (action) => {
    const h = setup();
    const foreign = { ...h.definition, owner: keypair().pubkey };
    const write =
      action === "save"
        ? () => h.capability.save({ channelId, yaml, existing: foreign })
        : () => h.capability[action](foreign);
    expect(write).toThrow(/owner/i);
    await flush();
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    expect(() => h.capability.runs(foreign)).not.toThrow();
  },
);

it("batch definitions use one bounded filter and count unique events before coordinate folding", async () => {
  const h = setup();
  const other = "44444444-4444-4444-8444-444444444444";
  const empty = "66666666-6666-4666-8666-666666666666";
  const author = keypair();
  const make = (channel: string, index: number) =>
    signed(author, {
      kind: 30620,
      created_at: index,
      content: yaml,
      tags: [
        ["h", channel],
        ["d", id],
      ],
    });
  const first = make(channelId, 1);
  h.read.mockResolvedValue([
    ...Array.from({ length: 100 }, () => first),
    make(other, 2),
  ]);
  const view = h.capability.definitions([channelId, other, empty, channelId]);
  await view.refresh();
  expect(h.read).toHaveBeenLastCalledWith(
    [{ kinds: [30620], "#h": [channelId, other, empty], limit: 100 }],
    expect.anything(),
  );
  expect(view.snapshot().data).toMatchObject({
    items: expect.any(Array),
    partial: false,
    partialChannelIds: [],
  });
  expect(view.snapshot().data.items).toHaveLength(2);
  const events = [
    ...Array.from({ length: 49 }, (_, i) => make(channelId, i)),
    ...Array.from({ length: 50 }, (_, i) => make(other, i)),
  ];
  h.read.mockResolvedValue(events);
  await view.refresh();
  expect(view.snapshot().data.partial).toBe(false);
  h.read
    .mockResolvedValueOnce([...events, make(channelId, 49)])
    .mockResolvedValueOnce([]);
  await view.refresh();
  expect(view.snapshot().data).toMatchObject({
    partial: false,
    partialChannelIds: [],
  });
  expect(view.snapshot().data.items).toHaveLength(2);
  expect(h.read).toHaveBeenCalledTimes(4);
  const cached = h.capability.definitions([channelId, other, empty]).snapshot();
  expect(cached.status).toBe("ready");
  expect(cached.data.items).toHaveLength(2);
  h.read.mockResolvedValue([make("55555555-5555-4555-8555-555555555555", 1)]);
  await view.refresh();
  expect(view.snapshot()).toMatchObject({
    status: "error",
    data: { items: [] },
  });
  h.read.mockResolvedValue([{ ...first, tags: [...first.tags, ["h", other]] }]);
  await view.refresh();
  expect(view.snapshot().status).toBe("error");
});
