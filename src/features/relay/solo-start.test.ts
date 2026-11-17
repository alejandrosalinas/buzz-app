import { assert, afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { PublishNotSent, PublishRejected } from "./outbox";
import { ChatNotStarted } from "./channel-writes";
import { ReadError } from "./errors";
import { subscribeRelayTraffic } from "./live";
import { keypair, metadata, roster, signed } from "./testing";
import { matchesEvent } from "./projection";
import { SOLO_LABEL } from "../solo/labels";
import { ownerCanvas } from "../agent-harness/project";
import type { EventTemplate } from "nostr-tools";
import type { ReadFilter, RelayEvent } from "./events";

class Socket {
  readyState = 1;
  onmessage?: (event: { data: string }) => Promise<void>;
  onclose?: () => void;
  onerror?: () => void;
  sent: unknown[][] = [];
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  async receive(value: unknown) {
    await this.onmessage?.({ data: JSON.stringify(value) });
  }
  requests() {
    return this.sent.filter((e) => e[0] === "REQ");
  }
  async auth() {
    await this.receive(["AUTH", "challenge"]);
    const event = this.sent.find((e) => e[0] === "AUTH")?.[1];
    await this.receive(["OK", (event as RelayEvent).id, true]);
  }
}
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
});

/** A relay that makes the chat, with the members its create names, once it
 * accepts the create; `release` lets the held create through. `refuse` makes
 * it reject the create instead, and `unreachable` loses every attempt before
 * it arrives. Until the chat exists, reading it is refused as a non-member. */
function setup(id: string, deliveryTimeoutMs?: number) {
  vi.useFakeTimers();
  const viewer = keypair(),
    relay = keypair(),
    agent = keypair();
  let created: string[] | undefined;
  let release = () => {};
  let refuse = false;
  let loseAck = false;
  let unreachable = false;
  let paused = false;
  let stored: RelayEvent | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const query = vi.fn(async (filters: readonly ReadFilter[]) => {
    if (!created && filters.some((filter) => filter["#h"]?.includes(id)))
      throw new ReadError("denied", "restricted: not a channel member", 403);
    return [
      ...(stored ? [stored] : []),
      roster(relay, "c", [viewer.pubkey]),
      metadata(relay, "c", "General"),
      ...(created
        ? [
            roster(relay, id, created),
            metadata(relay, id, "Start", 1_700_000_000, [
              ["t", "stream"],
              ["private"],
              ["t", SOLO_LABEL],
            ]),
          ]
        : []),
    ].filter((e) => filters.some((f) => matchesEvent(e, f)));
  });
  const publish = vi.fn(async (event: RelayEvent) => {
    if (event.kind !== 9007) return;
    await held;
    if (refuse) throw new PublishRejected("blocked: not allowed");
    if (paused) {
      paused = false;
      throw new PublishNotSent("Relay requests paused; retry in 1s");
    }
    if (unreachable) throw new Error("connection lost");
    stored = event;
    created = [
      event.pubkey,
      ...event.tags.flatMap(([name, key]) =>
        name === "p" && key ? [key] : [],
      ),
    ];
    if (loseAck) {
      loseAck = false;
      throw new Error("ACK connection lost");
    }
  });
  const sockets: Socket[] = [];
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      channelIdentity: true,
      media: (url) => url,
      query,
      writer: {
        kinds: [9, 9000, 9007, 40100],
        sign: async (template: EventTemplate) => signed(viewer, template),
        publish,
      },
      subscribe(callbacks) {
        return subscribeRelayTraffic(
          "wss://fixture.invalid",
          async (t) => signed(viewer, t),
          viewer.pubkey,
          callbacks,
          () => {
            const socket = new Socket();
            sockets.push(socket);
            return socket as unknown as WebSocket;
          },
        );
      },
    },
    {
      outboxStorage: { load: () => [], save: () => {} },
      ...(deliveryTimeoutMs ? { deliveryTimeoutMs } : {}),
    },
  );
  owners.push(owner);
  owner.session.channels.ensureList();
  return {
    ...owner,
    agent,
    publish,
    query,
    release,
    refuse() {
      refuse = true;
    },
    loseAck() {
      loseAck = true;
    },
    unreachable() {
      unreachable = true;
    },
    /** This device holds the next create back, as during the API cooldown. */
    pauseOnce() {
      paused = true;
    },
    /** Live subscriptions asked for the chat's events. */
    liveReads(channelId: string) {
      return sockets
        .flatMap((socket) => socket.requests())
        .filter((request) =>
          request
            .slice(2)
            .some((filter) =>
              (filter as ReadFilter)["#h"]?.includes(channelId),
            ),
        ).length;
    },
    async established() {
      await vi.advanceTimersByTimeAsync(0);
      const socket = sockets[0];
      assert.exists(socket);
      await socket.auth();
      await vi.advanceTimersByTimeAsync(750);
      for (const request of socket.requests())
        await socket.receive(["EOSE", request[1]]);
      await vi.advanceTimersByTimeAsync(1);
    },
  };
}

it("a new chat's first message reaches its local agent at once and the relay right after the create", async () => {
  const id = "55555555-5555-4555-8555-555555555555";
  const h = setup(id);
  await h.established();
  const heard: RelayEvent[] = [];
  h.session.subscribeLive((batch) => heard.push(...batch.events), {
    replay: true,
  });
  const { ready } = h.session.channelWrites.start(id, "Start", [
    h.agent.pubkey,
  ]);
  const listed = () =>
    h.session.channels.list().channels.find((channel) => channel.id === id);
  expect(listed()).toMatchObject({
    channelType: "solo",
    pending: true,
    members: expect.arrayContaining([h.agent.pubkey]),
  });
  // It lists and opens before its metadata arrives, unlike a temporary room.
  expect(listed()?.metadataPending).toBeUndefined();
  expect(h.session.channels.get?.(id)?.metadataPending).toBeUndefined();
  const message = h.session.messages.send(id, "@Agent go", [h.agent.pubkey]);
  h.session.channels.ensure(id);
  await vi.advanceTimersByTimeAsync(0);
  // The open chat shows the message from here, with no history to read yet.
  const window = () => h.session.channels.window(id);
  const historyReads = () =>
    h.query.mock.calls.filter(([filters]) =>
      filters.some((filter) => filter["#h"]?.includes(id)),
    ).length;
  expect(window().status).toBe("ready");
  expect(window().rows.map((row) => row.id)).toEqual([message]);
  expect(historyReads()).toBe(0);
  // Only the create is on its way; the agent already has the message.
  expect(h.publish.mock.calls.map(([event]) => event.kind)).toEqual([9007]);
  expect(h.publish.mock.calls[0]?.[0].tags).toContainEqual([
    "p",
    h.agent.pubkey,
  ]);
  expect(heard.map((event) => event.id)).toEqual([message]);
  // Nor does its live tail, which the relay refuses until the chat exists.
  await vi.advanceTimersByTimeAsync(1_000);
  expect(h.liveReads(id)).toBe(0);

  let settled = false;
  void ready.then(() => {
    settled = true;
  });
  h.release();
  for (let step = 0; step < 40 && !settled; step++)
    await vi.advanceTimersByTimeAsync(100);
  expect(settled).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.publish.mock.calls.map(([event]) => event.kind)).toEqual([9007, 9]);
  expect(h.publish.mock.calls[1]?.[0].id).toBe(message);
  expect(listed()?.pending).toBeUndefined();
  // Once the relay has it, the open chat reads its history.
  await vi.advanceTimersByTimeAsync(0);
  expect(historyReads()).toBeGreaterThan(0);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(h.liveReads(id)).toBeGreaterThan(0);
  expect(listed()?.members).toContain(h.agent.pubkey);
});

it("a refused create drops the pending chat and everything sent in it", async () => {
  const id = "66666666-6666-4666-8666-666666666666";
  const h = setup(id);
  await h.established();
  const { ready } = h.session.channelWrites.start(id, "Start", [
    h.agent.pubkey,
  ]);
  ready.catch(() => {});
  h.session.messages.send(id, "@Agent go", [h.agent.pubkey]);
  const outbox = h.session.outbox;
  assert.exists(outbox);
  h.refuse();
  h.release();
  await vi.advanceTimersByTimeAsync(0);
  await expect(ready).rejects.toThrow("blocked");
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
  // The start withdraws the create and the message it held, so neither
  // lingers as a failed item for a chat that is not there.
  expect(
    outbox
      .snapshot()
      .filter((item) => item.event.tags.some(([, value]) => value === id)),
  ).toEqual([]);
  // The create was sent, and once more on retry; never the message.
  expect(new Set(h.publish.mock.calls.map(([event]) => event.kind))).toEqual(
    new Set([9007]),
  );
  expect(
    h.session.channels.list().channels.some((channel) => channel.id === id),
  ).toBe(false);
});

async function settle(ready: Promise<void>) {
  let settled = false;
  void ready.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let step = 0; step < 400 && !settled; step++)
    await vi.advanceTimersByTimeAsync(100);
  expect(settled).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
}

it("a create this device held back for the relay's cooldown goes again, and the chat starts", async () => {
  const id = "79797979-7979-4979-8979-797979797979";
  const h = setup(id);
  await h.established();
  h.pauseOnce();
  const { create, ready } = h.session.channelWrites.start(id, "Start", [
    h.agent.pubkey,
  ]);
  const message = h.session.messages.send(id, "@Agent go", [h.agent.pubkey]);
  h.release();
  await settle(ready);
  await expect(ready).resolves.toBeUndefined();
  const sent = h.publish.mock.calls.map(([event]) => event.id);
  expect(sent.filter((event) => event === create)).toHaveLength(2);
  expect(sent.at(-1)).toBe(message);
  expect(
    h.session.channels.list().channels.some((channel) => channel.id === id),
  ).toBe(true);
});

it("a lost create acknowledgment resends the same create, and the chat starts", async () => {
  const id = "77777777-7777-4777-8777-777777777777";
  const h = setup(id);
  await h.established();
  h.loseAck();
  const { create, ready } = h.session.channelWrites.start(id, "Start", [
    h.agent.pubkey,
  ]);
  const message = h.session.messages.send(id, "@Agent go", [h.agent.pubkey]);
  h.release();
  await settle(ready);
  await expect(ready).resolves.toBeUndefined();
  const sent = h.publish.mock.calls.map(([event]) => event.id);
  expect(sent.filter((event) => event === create).length).toBeGreaterThan(0);
  expect(sent.at(-1)).toBe(message);
  expect(
    h.session.channels.list().channels.find((channel) => channel.id === id)
      ?.pending,
  ).toBeUndefined();
});

it("messages held while their chat starts keep their whole deadline for after it exists", async () => {
  const id = "88888888-8888-4888-8888-888888888888";
  const h = setup(id, 2_000);
  await h.established();
  const { ready } = h.session.channelWrites.start(id, "Start", [
    h.agent.pubkey,
  ]);
  ready.catch(() => {});
  // More than the outbox delivers at once.
  const messages = ["one", "two", "three", "four"].map((text) =>
    h.session.messages.send(id, `@Agent ${text}`, [h.agent.pubkey]),
  );
  await vi.advanceTimersByTimeAsync(2_500);
  for (const message of messages)
    expect(
      h.session.outbox?.snapshot().find((item) => item.event.id === message)
        ?.delivery,
    ).toBe("sending");
  h.release();
  await settle(ready);
  await vi.advanceTimersByTimeAsync(100);
  const sent = h.publish.mock.calls.map(([event]) => event.id);
  for (const message of messages) expect(sent).toContain(message);
});

it("a chat's Canvas save goes once the chat exists, alongside more messages than delivery slots", async () => {
  const id = "8888aaaa-8888-4888-8888-888888888888";
  const h = setup(id);
  await h.established();
  const { ready } = h.session.channelWrites.start(
    id,
    "Start",
    [h.agent.pubkey],
    undefined,
    false,
    {
      canvas: "# Brief",
      async apply() {
        await h.session.canvas.save(id, "# Brief", undefined);
      },
    },
  );
  const messages = ["one", "two", "three", "four"].map((text) =>
    h.session.messages.send(id, `@Agent ${text}`, [h.agent.pubkey]),
  );
  await vi.advanceTimersByTimeAsync(0);
  h.release();
  await settle(ready);
  await vi.advanceTimersByTimeAsync(100);
  const kinds = h.publish.mock.calls.map(([event]) => event.kind);
  expect(kinds).toContain(40100);
  const sent = h.publish.mock.calls.map(([event]) => event.id);
  for (const message of messages) expect(sent).toContain(message);
});

it("a read waiting on a start the relay refuses fails here, without asking the relay", async () => {
  const id = "8888bbbb-8888-4888-8888-888888888888";
  const h = setup(id);
  await h.established();
  h.refuse();
  const { ready } = h.session.channelWrites.start(id, "Start", [
    h.agent.pubkey,
  ]);
  ready.catch(() => {});
  const canvas = h.session.canvas.read(id);
  canvas.catch(() => {});
  h.release();
  await settle(ready);
  await expect(canvas).rejects.toMatchObject({ kind: "unavailable" });
  expect(
    h.query.mock.calls.some(([filters]) =>
      filters.some((filter) => filter["#h"]?.includes(id)),
    ),
  ).toBe(false);
});

it("a read of a chat that is still starting waits for the create instead of losing access", async () => {
  const id = "99999999-9999-4999-8999-999999999999";
  const h = setup(id);
  await h.established();
  const { ready } = h.session.channelWrites.start(id, "Start", [
    h.agent.pubkey,
  ]);
  const message = h.session.messages.send(id, "@Agent go", [h.agent.pubkey]);
  // As a local agent does when it takes the first message: read the Canvas.
  const canvas = h.session.canvas.read(id);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(
    h.query.mock.calls.some(([filters]) =>
      filters.some((filter) => filter["#h"]?.includes(id)),
    ),
  ).toBe(false);
  h.release();
  await settle(ready);
  await expect(canvas).resolves.toBeUndefined();
  const listed = h.session.channels
    .list()
    .channels.find((channel) => channel.id === id);
  expect(listed).toBeDefined();
  expect(listed?.pending).toBeUndefined();
  expect(h.publish.mock.calls.at(-1)?.[0].id).toBe(message);
});

it("a chat's local agents get its first message and its Canvas before the relay has the chat", async () => {
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const h = setup(id);
  await h.established();
  const heard: RelayEvent[] = [];
  h.session.subscribeLive((batch) => heard.push(...batch.events), {
    replay: true,
  });
  let finish = () => {};
  const apply = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const { ready } = h.session.channelWrites.start(
    id,
    "Start",
    [h.agent.pubkey],
    undefined,
    false,
    { canvas: "# Brief", apply },
  );
  const message = h.session.messages.send(id, "@Agent go", [h.agent.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  // As an agent's first turn reads it, without asking the relay.
  const canvas = (channelId: string) =>
    ownerCanvas(
      h.session.canvas,
      h.session.viewer ?? "",
      channelId,
      h.session.channelWrites.startingCanvas(channelId),
    );
  expect(heard.map((event) => event.id)).toEqual([message]);
  await expect(canvas(id)).resolves.toBe("# Brief");
  expect(
    h.query.mock.calls.some(([filters]) =>
      filters.some((filter) => filter["#h"]?.includes(id)),
    ),
  ).toBe(false);
  h.release();
  await settle(ready);
  // The message goes with the chat; the Canvas save does not hold it.
  expect(apply).toHaveBeenCalledOnce();
  expect(h.publish.mock.calls.at(-1)?.[0].id).toBe(message);
  expect(h.session.channelWrites.startingCanvas(id)).toBe("# Brief");
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.session.channelWrites.startingCanvas(id)).toBeUndefined();
});

it("a plain chat's first turn knows at once that it has no Canvas", async () => {
  const id = "aaaabbbb-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const h = setup(id);
  await h.established();
  const { ready } = h.session.channelWrites.start(id, "Start", [
    h.agent.pubkey,
  ]);
  await expect(
    ownerCanvas(
      h.session.canvas,
      h.session.viewer ?? "",
      id,
      h.session.channelWrites.startingCanvas(id),
    ),
  ).resolves.toBeUndefined();
  h.release();
  await settle(ready);
  expect(h.session.channelWrites.startingCanvas(id)).toBeUndefined();
});

it("a create that never arrives backs off, then ends the start once the relay shows no chat", async () => {
  const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const h = setup(id);
  await h.established();
  h.unreachable();
  const { ready } = h.session.channelWrites.start(id, "Start", [
    h.agent.pubkey,
  ]);
  ready.catch(() => {});
  h.release();
  await vi.advanceTimersByTimeAsync(0);
  const creates = () =>
    h.publish.mock.calls.filter(([event]) => event.kind === 9007).length;
  const first = creates();
  await vi.advanceTimersByTimeAsync(0);
  // No immediate burst of attempts: the next one waits.
  expect(creates()).toBe(first);
  await settle(ready);
  await expect(ready).rejects.toBeInstanceOf(ChatNotStarted);
  expect(creates()).toBeGreaterThan(first);
  await vi.advanceTimersByTimeAsync(0);
  expect(
    h.session.outbox
      ?.snapshot()
      .some((item) => item.event.tags.some(([, value]) => value === id)),
  ).toBe(false);
  expect(
    h.session.channels.list().channels.some((channel) => channel.id === id),
  ).toBe(false);
});

it("lists a labeled region start only with the same labels as its single create", async () => {
  const id = "66666666-6666-4666-8666-666666666666";
  const h = setup(id);
  await h.established();
  const region = "buzz.region:example:work";
  const start = h.session.channelWrites.start(
    id,
    "Start",
    [],
    undefined,
    true,
    undefined,
    { labels: [region] },
  );
  const pending = h.session.channels
    .list()
    .channels.find((channel) => channel.id === id);
  expect(pending).toMatchObject({
    pending: true,
    channelType: "solo",
    labels: [SOLO_LABEL, "buzz.session.named", region],
  });
  try {
    await vi.waitFor(() => expect(h.publish).toHaveBeenCalled());
    expect(
      h.publish.mock.calls[0]?.[0].tags.filter(([tag]) => tag === "t"),
    ).toEqual([
      ["t", SOLO_LABEL],
      ["t", "buzz.session.named"],
      ["t", region],
    ]);
  } finally {
    h.release();
  }
  await start.ready;
});

it("a held first message reaches a starting chat's local agents only after its hold", async () => {
  const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const h = setup(id);
  await h.established();
  const heard: RelayEvent[] = [];
  h.session.subscribeLive((batch) => heard.push(...batch.events), {
    replay: true,
  });
  const { ready } = h.session.channelWrites.start(id, "Start", [
    h.agent.pubkey,
  ]);
  let release = () => {};
  const hold = vi.fn(
    (_id: string) =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  assert.exists(h.session.outbox?.sendHeld);
  const message = h.session.outbox.sendHeld(
    {
      kind: 9,
      content: "@Agent go",
      tags: [
        ["h", id],
        ["p", h.agent.pubkey],
      ],
    },
    hold,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(hold).toHaveBeenCalledExactlyOnceWith(message);
  // An agent's first turn cannot start before the plugin's work ends.
  expect(heard).toEqual([]);
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(heard.map((event) => event.id)).toEqual([message]);
  expect(h.publish.mock.calls.map(([event]) => event.kind)).toEqual([9007]);
  h.release();
  await settle(ready);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.publish.mock.calls.at(-1)?.[0].id).toBe(message);
});
