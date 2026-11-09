import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { createRelaySession } from "../relay/session";
import { eventDto, type RelayEvent } from "../relay/events";
import type { LiveCallbacks } from "../relay/live";
import { PublishRejected } from "../relay/outbox";
import {
  flush,
  keypair,
  roster,
  signed,
  scriptedTransport,
} from "../relay/testing";
const channelId = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const relay = keypair(),
  viewer = keypair();
const definition = signed(viewer, {
  kind: 30620,
  created_at: 10,
  content: "PRIVATE yaml",
  tags: [
    ["h", channelId],
    ["d", id],
  ],
});
const reference = { id, channelId, owner: viewer.pubkey };
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function setup() {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let incoming!: (events: readonly RelayEvent[]) => void;
  let state!: LiveCallbacks["state"];
  let resolveRuns!: (value: unknown) => void;
  const runs = vi.fn(
    (_id: string, _cursor: unknown, _signal: AbortSignal) =>
      new Promise<unknown>((resolve) => {
        resolveRuns = resolve;
      }),
  );
  const owner = createRelaySession({
    ...wire.transport,
    workflows: { runs },
    subscribe(callbacks) {
      incoming = callbacks.receive;
      state = callbacks.state;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  owners.push(owner);
  return {
    ...wire,
    ...owner,
    runs,
    state: (status: "connected" | "retrying") => state({ status, routes: [] }),
    emit: (events: readonly RelayEvent[]) => incoming(events),
    resolveRuns: (value: unknown) => resolveRuns(value),
  };
}
async function ownedWorkflowSession(role: "member" | "guest") {
  const agent = keypair(),
    foreign = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let incoming!: (events: readonly RelayEvent[]) => void;
  const sign = vi.fn(async (template: Parameters<typeof signed>[1]) =>
    signed(viewer, template),
  );
  const publish = vi.fn(async () => "");
  const connection = createRelaySession(
    {
      ...wire.transport,
      writer: { kinds: [9, 30620, 46020, 5], sign, publish },
      workflows: { runs: async () => ({ runs: [], next: null }) },
      subscribe(callbacks) {
        incoming = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(connection);
  const profile = (author: typeof agent, human: typeof viewer) =>
    eventDto(
      signed(author, {
        kind: 0,
        created_at: 10,
        content: "{}",
        tags: [
          [
            "auth",
            human.pubkey,
            "",
            bytesToHex(
              schnorr.sign(
                createHash("sha256")
                  .update(`nostr:agent-auth:${author.pubkey}:`)
                  .digest(),
                human.secret,
              ),
            ),
          ],
        ],
      }),
    );
  connection.session.channels.ensure(channelId);
  incoming([
    signed(relay, {
      kind: 39002,
      created_at: 1,
      content: "",
      tags: [
        ["d", channelId],
        ["p", viewer.pubkey, "", role],
        ["p", agent.pubkey, "", "bot"],
        ["p", foreign.pubkey, "", "bot"],
      ],
    }),
    profile(agent, viewer),
    profile(foreign, keypair()),
  ]);
  await connection.session.outbox?.ready();
  const workflow = {
    ...reference,
    owner: agent.pubkey,
    yaml: definition.content,
    revision: definition.id,
    createdAt: 10,
  };
  await vi.waitFor(() =>
    expect(connection.session.workflows.permissions.canDelete(workflow)).toBe(
      true,
    ),
  );
  return {
    ...connection,
    agent,
    foreign,
    workflow,
    sign,
    publish,
    emit: (events: readonly RelayEvent[]) => incoming(events),
  };
}

it.each(["member", "guest"] as const)(
  "publishes a %s's owned-agent workflow deletion through the real session",
  async (role) => {
    const h = await ownedWorkflowSession(role);
    const operation = h.session.workflows.delete(h.workflow);
    await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
    expect(h.sign).toHaveBeenCalledOnce();
    expect(h.sign.mock.calls[0]?.[0].tags).toContainEqual([
      "a",
      `30620:${h.agent.pubkey}:${id}`,
    ]);
    await vi.waitFor(() =>
      expect(h.session.workflows.operations.snapshot()[0]).toMatchObject({
        eventId: operation,
        action: "delete",
        delivery: "accepted",
      }),
    );
  },
);

it("lets a Guest delete a self-authored workflow under the same deletion permission", async () => {
  const h = await ownedWorkflowSession("guest");
  const workflow = { ...h.workflow, owner: viewer.pubkey };
  expect(h.session.workflows.permissions.canDelete(workflow)).toBe(true);
  h.session.workflows.delete(workflow);
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
});

it("keeps Guest contributions, foreign workflows and malformed deletes blocked before host signing", async () => {
  const h = await ownedWorkflowSession("guest");
  const foreign = { ...h.workflow, owner: h.foreign.pubkey };
  expect(h.session.workflows.permissions.canDelete(foreign)).toBe(false);
  expect(() => h.session.workflows.delete(foreign)).toThrow();
  expect(() =>
    h.session.workflows.save({
      channelId,
      yaml: h.workflow.yaml,
      existing: h.workflow,
    }),
  ).toThrow();
  expect(() => h.session.workflows.trigger(h.workflow)).toThrow();
  const tags = [
    ["h", channelId],
    ["a", `30620:${h.agent.pubkey}:${id}`],
  ];
  const commands = [
    {
      kind: 5,
      content: "",
      tags: [
        ["h", channelId],
        ["a", `30620:${h.foreign.pubkey}:${id}`],
      ],
    },
    {
      kind: 5,
      content: "",
      tags: [
        ["h", channelId],
        ["a", `030620:${h.agent.pubkey}:${id}`],
      ],
    },
    { kind: 5, content: "", tags: [...tags, ["e", definition.id]] },
    { kind: 5, content: "unexpected", tags },
    {
      kind: 5,
      content: "",
      tags: [
        ["h", channelId],
        ["a", `30023:${viewer.pubkey}:${id}`],
      ],
    },
    { kind: 9, content: "Guest message", tags: [["h", channelId]] },
    {
      kind: 30620,
      content: "name: New workflow",
      tags: [
        ["h", channelId],
        ["d", id],
      ],
    },
    {
      kind: 46020,
      content: "",
      tags: [
        ["h", channelId],
        ["d", id],
      ],
    },
  ];
  for (const command of commands) {
    const operation = h.session.outbox?.send(command);
    await vi.waitFor(() =>
      expect(
        h.session.outbox?.snapshot().find((row) => row.event.id === operation)
          ?.delivery,
      ).toBe("failed"),
    );
  }
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
});

it.each(["ownership", "membership"] as const)(
  "rechecks a Guest owner's %s after asynchronous signing",
  async (revoked) => {
    const h = await ownedWorkflowSession("guest");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.sign.mockImplementationOnce(async (template) => {
      await gate;
      return signed(viewer, template);
    });
    const operation = h.session.workflows.delete(h.workflow);
    try {
      await vi.waitFor(() => expect(h.sign).toHaveBeenCalledOnce());
      h.emit([
        revoked === "ownership"
          ? signed(h.agent, {
              kind: 0,
              created_at: 11,
              content: "{}",
              tags: [],
            })
          : roster(relay, channelId, [], 2),
      ]);
      expect(h.session.workflows.permissions.canDelete(h.workflow)).toBe(false);
    } finally {
      release();
    }
    await vi.waitFor(() =>
      expect(
        h.session.outbox?.snapshot().find((row) => row.event.id === operation)
          ?.delivery,
      ).toBe("failed"),
    );
    expect(h.publish).not.toHaveBeenCalled();
  },
);

it("workflow views start lazy and purge to unavailable before any channel/operation/view observer runs", async () => {
  const h = setup();
  h.emit([roster(relay, channelId, [viewer.pubkey], 1)]);
  const definitions = h.session.workflows.definitions(channelId),
    history = h.session.workflows.runs(reference);
  expect(h.pending).toHaveLength(0);
  expect(h.runs).not.toHaveBeenCalled();
  const loading = definitions.refresh();
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  const request = h.next();
  expect(request.filters).toEqual([
    { kinds: [30620], "#h": [channelId], limit: 100 },
  ]);
  // A second refresh shares its pending read.
  expect(definitions.refresh()).toBe(loading);
  request.respond([definition]);
  await loading;
  expect(definitions.snapshot().status).toBe("ready");
  expect(history.snapshot().status).toBe("idle");
});
it("authoritative revocation clears all saved and structured data before callbacks, rejects late results and denies fresh views", async () => {
  const h = setup();
  h.emit([roster(relay, channelId, [viewer.pubkey], 1)]);
  const definitions = h.session.workflows.definitions(channelId),
    history = h.session.workflows.runs(reference);
  const loading = definitions.refresh();
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  h.next().respond([definition]);
  await loading;
  expect(definitions.snapshot().data.items[0]?.revision).toBe(definition.id);
  const runRead = history.refresh();
  await vi.waitFor(() => expect(h.runs).toHaveBeenCalledTimes(1));
  const checked = vi.fn(() => {
    expect(definitions.snapshot()).toMatchObject({
      status: "unavailable",
      data: { items: [] },
    });
    expect(history.snapshot()).toMatchObject({
      status: "unavailable",
      data: { runs: [] },
    });
    expect(h.session.workflows.operations.snapshot()).toEqual([]);
  });
  definitions.subscribe(checked);
  history.subscribe(checked);
  h.session.workflows.operations.subscribe(checked);
  h.session.channels.subscribeList(checked);
  h.emit([roster(relay, channelId, [], 2)]);
  expect(checked).toHaveBeenCalled();
  expect(h.runs.mock.calls[0]?.[2].aborted).toBe(true);
  const denied = h.session.workflows.definitions(channelId);
  expect(denied.snapshot().status).toBe("unavailable");
  await denied.refresh();
  expect(h.pending).toHaveLength(0);
  h.resolveRuns({ runs: [], next: null });
  await runRead;
  expect(history.snapshot().status).toBe("unavailable");
});
it("revoking one channel purges a loaded batch before observers and fences its late refresh", async () => {
  const h = setup();
  const other = "33333333-3333-4333-8333-333333333333";
  h.emit([
    roster(relay, channelId, [viewer.pubkey], 1),
    roster(relay, other, [viewer.pubkey], 1),
  ]);
  const view = h.session.workflows.definitions([channelId, other]);
  const first = view.refresh();
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  h.next().respond([definition]);
  await first;
  expect(view.snapshot().data.items).toHaveLength(1);
  const second = view.refresh();
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  const late = h.next();
  const checked = vi.fn(() => {
    expect(view.snapshot()).toMatchObject({
      status: "unavailable",
      data: { items: [] },
    });
  });
  view.subscribe(checked);
  h.session.channels.subscribeList(checked);
  h.emit([roster(relay, other, [], 2)]);
  expect(checked).toHaveBeenCalled();
  expect(late.signal?.aborted).toBe(true);
  late.respond([definition]);
  await second;
  expect(view.snapshot().data.items).toEqual([]);
  await view.refresh();
  expect(h.pending).toHaveLength(0);
});

it("regrant cannot resurrect stale history; clear-cache and dispose cancel interest", async () => {
  const h = setup();
  h.emit([roster(relay, channelId, [viewer.pubkey], 1)]);
  const history = h.session.workflows.runs(reference);
  const first = history.refresh();
  await vi.waitFor(() => expect(h.runs).toHaveBeenCalledTimes(1));
  h.emit([roster(relay, channelId, [], 2)]);
  h.emit([roster(relay, channelId, [viewer.pubkey], 3)]);
  h.resolveRuns({ runs: [], next: null });
  await first;
  expect(history.snapshot().status).toBe("unavailable");
  const fresh = history.refresh();
  await vi.waitFor(() => expect(h.runs).toHaveBeenCalledTimes(2));
  h.resolveRuns({ runs: [], next: null });
  await fresh;
  expect(history.snapshot().status).toBe("ready");
  const next = history.refresh();
  await vi.waitFor(() => expect(h.runs).toHaveBeenCalledTimes(3));
  await h.clearCache();
  expect(h.runs.mock.calls[2]?.[2].aborted).toBe(true);
  expect(history.snapshot()).toMatchObject({
    status: "idle",
    data: { runs: [] },
  });
  h.resolveRuns({ runs: [], next: null });
  await next;
  expect(history.snapshot().status).toBe("idle");
  h.dispose();
  expect(history.snapshot().status).toBe("unavailable");
});
it("a loading observer can revoke without leaving a wedged pending read", async () => {
  const h = setup();
  h.emit([roster(relay, channelId, [viewer.pubkey], 1)]);
  const history = h.session.workflows.runs(reference);
  const stop = history.subscribe(() => {
    if (history.snapshot().status === "loading")
      h.emit([roster(relay, channelId, [], 2)]);
  });
  await history.refresh();
  expect(h.runs).not.toHaveBeenCalled();
  expect(history.snapshot().status).toBe("unavailable");
  stop();
  h.emit([roster(relay, channelId, [viewer.pubkey], 3)]);
  const fresh = history.refresh();
  await vi.waitFor(() => expect(h.runs).toHaveBeenCalledTimes(1));
  h.resolveRuns({ runs: [], next: null });
  await fresh;
  expect(history.snapshot().status).toBe("ready");
});
it("existing backend permits workflow commands without lifecycle metadata while retaining session access and shape guards", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let incoming!: (events: readonly RelayEvent[]) => void;
  const sign = vi.fn(async (template: Parameters<typeof signed>[1]) =>
    signed(viewer, template),
  );
  const publish = vi.fn(async () => "");
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: { kinds: [9, 30620, 46020, 5], sign, publish },
      workflows: { runs: async () => ({ runs: [], next: null }) },
      subscribe(callbacks) {
        incoming = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: async () => [], save: async () => {} } },
  );
  owners.push(owner);
  incoming([roster(relay, channelId, [viewer.pubkey], 1)]);
  expect(owner.session.workflows.availability).toMatchObject({
    save: true,
    delete: true,
    trigger: true,
  });
  const workflow = {
    ...reference,
    yaml: definition.content,
    revision: definition.id,
    createdAt: 10,
  };
  const operation = owner.session.workflows.trigger(workflow);
  await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
  await vi.waitFor(() =>
    expect(owner.session.workflows.operations.snapshot()[0]).toMatchObject({
      eventId: operation,
      outcome: "unknown",
    }),
  );
  expect(sign).toHaveBeenCalledTimes(1);
  const invalid = owner.session.outbox?.send({
    kind: 46020,
    tags: [
      ["h", channelId],
      ["d", "not-a-uuid"],
    ],
    content: "",
  });
  await vi.waitFor(() =>
    expect(
      owner.session.outbox?.snapshot().find((row) => row.event.id === invalid)
        ?.delivery,
    ).toBe("failed"),
  );
  expect(sign).toHaveBeenCalledTimes(1);
  incoming([roster(relay, channelId, [], 2)]);
  expect(() => owner.session.workflows.trigger(workflow)).toThrow(
    "unavailable",
  );
  const denied = owner.session.outbox?.send({
    kind: 46020,
    tags: [
      ["h", channelId],
      ["d", id],
    ],
    content: "",
  });
  await vi.waitFor(() =>
    expect(
      owner.session.outbox?.snapshot().find((row) => row.event.id === denied)
        ?.delivery,
    ).toBe("failed"),
  );
  expect(sign).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledTimes(1);
});

it("session fresh definition read resolves a lost save, while ordinary echo does not", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let incoming!: (events: readonly RelayEvent[]) => void;
  let reject!: (error: Error) => void;
  let published: RelayEvent | undefined;
  const sign = vi.fn(async (template: Parameters<typeof signed>[1]) =>
    signed(viewer, template),
  );
  const publish = vi.fn((event: RelayEvent) => {
    published = event;
    return new Promise<string>((_resolve, fail) => {
      reject = fail;
    });
  });
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: { kinds: [30620], sign, publish },
      workflows: { runs: async () => ({ runs: [], next: null }) },
      subscribe(callbacks) {
        incoming = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: async () => [], save: async () => {} } },
  );
  owners.push(owner);
  incoming([roster(relay, channelId, [viewer.pubkey], 1)]);
  const workflows = owner.session.workflows;
  const op = workflows.save({
    channelId,
    yaml: "name: Saved\nenabled: false\ntrigger:\n  on: message_posted\nsteps:\n  - id: wait\n    action: delay\n    duration: 1s\n",
  });
  await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
  if (!published) throw new Error("missing signed event");
  incoming([published]);
  reject(new Error("lost receipt"));
  await vi.waitFor(() =>
    expect(workflows.operations.snapshot()[0]).toMatchObject({
      eventId: op,
      outcome: "unknown",
      delivery: "seen",
    }),
  );
  // Settle the existing outbox confirmation read; it is not task-level recovery.
  await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
  wire.next().respond([published]);
  const view = workflows.definitions(channelId);
  expect(workflows.operations.snapshot()[0]?.outcome).toBe("unknown");
  const loading = view.refresh();
  await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
  const request = wire.next();
  expect(request.filters).toEqual([
    { kinds: [30620], "#h": [channelId], limit: 100 },
  ]);
  request.respond([published]);
  await loading;
  expect(view.snapshot().data.items[0]?.revision).toBe(op);
  expect(workflows.operations.snapshot()[0]?.outcome).toBe("succeeded");
  expect(sign).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledTimes(1);
});

it.each(["accepted", "rejected", "missing", "revoked", "echoed"])(
  "address-based deletion preserves local status and recovery (%s)",
  async (result) => {
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let traffic!: LiveCallbacks;
    let settle!: (message: string) => void;
    let reject!: (error: Error) => void;
    const publish = vi.fn(
      (_event: RelayEvent) =>
        new Promise<string>((resolve, fail) => {
          settle = resolve;
          reject = fail;
        }),
    );
    const owner = createRelaySession(
      {
        ...wire.transport,
        writer: {
          kinds: [5],
          sign: async (template) => signed(viewer, template),
          publish,
        },
        workflows: { runs: async () => ({ runs: [], next: null }) },
        subscribe(callbacks) {
          traffic = callbacks;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      { outboxStorage: { load: () => [], save() {} } },
    );
    owners.push(owner);
    traffic.receive([roster(relay, channelId, [viewer.pubkey], 1)]);
    const workflows = owner.session.workflows;
    const operation = workflows.delete({
      ...reference,
      yaml: definition.content,
      revision: definition.id,
      createdAt: definition.created_at,
    });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    try {
      expect(workflows.operations.snapshot()).toMatchObject([
        { eventId: operation, action: "delete", outcome: "pending" },
      ]);
      if (result === "echoed") {
        const published = publish.mock.calls[0]?.[0];
        if (!published) throw new Error("Missing signed publication");
        const live = vi.fn();
        owner.session.subscribeLive(live);
        traffic.receive([published], { phase: "live", channelId });
        expect(workflows.operations.snapshot()[0]?.delivery).toBe("seen");
        expect(live).not.toHaveBeenCalled();
      }
      if (result === "revoked")
        traffic.receive([roster(relay, channelId, [], 2)]);
      if (result === "rejected") reject(new PublishRejected("Delete refused"));
      else if (result === "missing") reject(new Error("Receipt unavailable"));
      else settle("");
      await flush();
      if (result === "revoked") {
        expect(workflows.operations.snapshot()).toEqual([]);
        return;
      }
      const outcome = result === "rejected" ? "rejected" : "unknown";
      expect(workflows.operations.snapshot()).toMatchObject([
        { eventId: operation, outcome, error: expect.any(String) },
      ]);
      if (result !== "rejected") {
        // The outbox's exact-event read is separate from workflow recovery.
        await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
        const confirmation = wire.next();
        expect(confirmation.filters).toEqual([{ ids: [operation], limit: 1 }]);
        confirmation.respond([]);
        await flush();
      }
      const view = workflows.definitions(channelId);
      const loading = view.refresh();
      await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
      const request = wire.next();
      expect(request.filters).toEqual([
        { kinds: [30620], "#h": [channelId], limit: 100 },
      ]);
      request.respond([]);
      await loading;
      expect(workflows.operations.snapshot()).toMatchObject([
        {
          eventId: operation,
          outcome:
            result === "accepted" || result === "echoed"
              ? "succeeded"
              : outcome,
        },
      ]);
      expect(publish).toHaveBeenCalledTimes(1);
      await workflows.operations.dismiss(operation);
      expect(workflows.operations.snapshot()).toEqual([]);
    } finally {
      settle("");
    }
  },
);

it("address-only workflow deletions do not enter the verified channel watch stream", () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let traffic!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      traffic = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  owners.push(owner);
  traffic.receive([roster(relay, channelId, [viewer.pubkey], 1)]);
  const received: RelayEvent[] = [];
  owner.session.subscribeLive(({ events }) => received.push(...events));
  const message = signed(viewer, {
    kind: 9,
    content: "Hello",
    tags: [["h", channelId]],
  });
  const deletion = signed(viewer, {
    kind: 5,
    content: "",
    tags: [
      ["h", channelId],
      ["a", `30620:${viewer.pubkey}:${id}`],
    ],
  });
  traffic.receive([message, deletion], { phase: "live", channelId });
  expect(received.map((event) => event.id)).toEqual([message.id]);
});

it("transient reconnect cancels reads without purging authorized snapshots", async () => {
  const h = setup();
  h.emit([roster(relay, channelId, [viewer.pubkey], 1)]);
  h.state("connected");
  const definitions = h.session.workflows.definitions(channelId);
  const loading = definitions.refresh();
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  h.next().respond([definition]);
  await loading;
  const history = h.session.workflows.runs(reference);
  const pending = history.refresh();
  await vi.waitFor(() => expect(h.runs).toHaveBeenCalledTimes(1));
  h.state("retrying");
  expect(definitions.snapshot()).toMatchObject({
    status: "error",
    data: { items: [{ revision: definition.id }] },
  });
  expect(history.snapshot().status).toBe("error");
  expect(h.runs.mock.calls[0]?.[2].aborted).toBe(true);
  h.resolveRuns({ runs: [], next: null });
  await pending;
  expect(history.snapshot().status).toBe("error");
  h.state("connected");
  const refresh = definitions.refresh();
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  h.next().respond([definition]);
  await refresh;
  expect(definitions.snapshot().status).toBe("ready");
});

it.each(["reconnect", "revoke", "dispose"])(
  "in-flight run receipt across %s follows session authority",
  async (transition) => {
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let traffic!: LiveCallbacks;
    let settle!: (message: string) => void;
    const publish = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          settle = resolve;
        }),
    );
    const owner = createRelaySession(
      {
        ...wire.transport,
        writer: {
          kinds: [46020],
          sign: async (template) => signed(viewer, template),
          publish,
        },
        workflows: { runs: async () => ({ runs: [], next: null }) },
        subscribe(callbacks) {
          traffic = callbacks;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      { outboxStorage: { load: () => [], save() {} } },
    );
    owners.push(owner);
    traffic.receive([roster(relay, channelId, [viewer.pubkey], 1)]);
    traffic.state({ status: "connected", routes: [] });
    const eventId = owner.session.workflows.trigger({
      ...reference,
      yaml: definition.content,
      revision: definition.id,
      createdAt: 10,
    });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    if (transition === "reconnect")
      traffic.state({ status: "retrying", routes: [] });
    else if (transition === "revoke")
      traffic.receive([roster(relay, channelId, [], 2)]);
    else owner.dispose();
    settle('response:{"run_id":"33333333-3333-4333-8333-333333333333"}');
    if (transition === "reconnect") {
      await vi.waitFor(() =>
        expect(owner.session.workflows.operations.snapshot()[0]).toMatchObject({
          eventId,
          outcome: "succeeded",
          runId: "33333333-3333-4333-8333-333333333333",
        }),
      );
    } else {
      await flush();
      expect(owner.session.workflows.operations.snapshot()).toEqual([]);
    }
  },
);

it.each(["secret", "missing", "malformed", "mismatched", "failure", "revoked"])(
  "exact readback preserves configuration success and the later %s receipt contract",
  async (result) => {
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let incoming!: (events: readonly RelayEvent[]) => void;
    let settle!: (value: string) => void;
    let reject!: (error: Error) => void;
    const publish = vi.fn((_event: RelayEvent) => {
      const receipt = new Promise<string>((resolve, fail) => {
        settle = resolve;
        reject = fail;
      });
      return result === "missing" ? receipt.then(() => {}) : receipt;
    });
    const owner = createRelaySession(
      {
        ...wire.transport,
        writer: {
          kinds: [30620],
          sign: async (template: Parameters<typeof signed>[1]) =>
            signed(viewer, template),
          publish,
        },
        workflows: { runs: async () => ({ runs: [], next: null }) },
        subscribe(callbacks) {
          incoming = callbacks.receive;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      { outboxStorage: { load: async () => [], save: async () => {} } },
    );
    owners.push(owner);
    incoming([roster(relay, channelId, [viewer.pubkey], 1)]);
    const workflows = owner.session.workflows;
    const operation = workflows.save({
      channelId,
      yaml: "name: Hook\nenabled: false\ntrigger: { on: webhook }\nsteps: [{ id: wait, action: delay, duration: 1s }]\n",
    });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    try {
      const published = publish.mock.calls[0]?.[0];
      if (!published) throw new Error("Missing signed publication");
      expect(workflows.operations.snapshot()[0]?.outcome).toBe("pending");
      const view = workflows.definitions(channelId);
      const loading = view.refresh();
      await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
      wire.next().respond([published]);
      await loading;
      expect(workflows.operations.snapshot()[0]?.outcome).toBe("succeeded");
      const workflowId = published.tags.find(([key]) => key === "d")?.[1];
      if (result === "revoked") incoming([roster(relay, channelId, [], 2)]);
      if (result === "failure") reject(new Error("Receipt unavailable"));
      else
        settle(
          result === "malformed"
            ? "response:{"
            : `response:${JSON.stringify({
                workflow_id: result === "mismatched" ? id : workflowId,
                webhook_secret: "DISPOSABLE-SECRET",
              })}`,
        );
      await flush();
      if (result === "revoked")
        expect(workflows.operations.snapshot()).toEqual([]);
      else
        expect(workflows.operations.snapshot()[0]?.outcome).toBe("succeeded");
      expect(workflows.takeWebhookSecret(operation)).toBe(
        result === "secret" ? "DISPOSABLE-SECRET" : undefined,
      );
      expect(workflows.takeWebhookSecret(operation)).toBeUndefined();
      expect(publish).toHaveBeenCalledTimes(1);
      view.dispose();
    } finally {
      settle("");
    }
  },
);
