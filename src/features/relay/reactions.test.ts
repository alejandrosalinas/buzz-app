import { afterEach, expect, it, vi } from "vitest";
import { createMessages } from "./messages";
import { createRelaySession } from "./session";
import { MessageProjection } from "./message-projection";
import { createRelayProfiler } from "./profiling";
import { foldMessages } from "./fold";
import { PublishRejected, type OutgoingEvent } from "./outbox";
import {
  completeHeads,
  flush,
  keypair,
  message,
  roster,
  scriptedTransport,
  signed,
} from "./testing";
import type { LiveCallbacks } from "./live";
import type { RelayEvent } from "./events";

const viewer = keypair(),
  other = keypair(),
  relay = keypair();
const root = message(other, "c", "React here", 1);
const reaction = (author = viewer, time = 2) =>
  signed(author, {
    kind: 7,
    content: "👍",
    created_at: time,
    tags: [
      ["e", root.id],
      ["h", "c"],
    ],
  });
const remove = (target: RelayEvent, author = viewer) =>
  signed(author, {
    kind: 5,
    content: "",
    tags: [
      ["e", target.id],
      ["h", "c"],
      ["k", "7"],
    ],
  });
const owners: { dispose(): void }[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

it("groups by event-local emoji identity, counts unique people and retains duplicate event IDs", () => {
  const mine = reaction(),
    duplicate = reaction(viewer, 3),
    theirs = reaction(other);
  const custom = (url: string) =>
    signed(viewer, {
      kind: 7,
      content: ":party:",
      tags: [
        ["e", root.id],
        ["emoji", "party", url],
      ],
    });
  const rows = foldMessages("c", relay.pubkey, [
    root,
    mine,
    duplicate,
    theirs,
    custom("https://one.test/a"),
    custom("https://two.test/a"),
  ]);
  expect(rows[0]?.reactions).toHaveLength(3);
  expect(rows[0]?.reactions[0]?.events).toEqual([
    { id: mine.id, authorId: viewer.pubkey },
    { id: duplicate.id, authorId: viewer.pubkey },
    { id: theirs.id, authorId: other.pubkey },
  ]);
  expect(
    new Set(rows[0]?.reactions[0]?.events.map((item) => item.authorId)).size,
  ).toBe(2);
});

it("keeps pill order from the first reaction when counts change", () => {
  const heart = signed(viewer, {
    kind: 7,
    content: "❤️",
    created_at: 2,
    tags: [
      ["e", root.id],
      ["h", "c"],
    ],
  });
  const laugh = signed(other, {
    kind: 7,
    content: "😂",
    created_at: 3,
    tags: [
      ["e", root.id],
      ["h", "c"],
    ],
  });
  const secondHeart = signed(other, {
    kind: 7,
    content: "❤️",
    created_at: 4,
    tags: [
      ["e", root.id],
      ["h", "c"],
    ],
  });
  const events = [root, laugh, secondHeart, heart];
  expect(
    foldMessages("c", relay.pubkey, events)[0]?.reactions.map(
      (item) => item.content,
    ),
  ).toEqual(["❤️", "😂"]);
  expect(
    foldMessages("c", relay.pubkey, [
      ...events,
      remove(heart),
    ])[0]?.reactions.map((item) => item.content),
  ).toEqual(["❤️", "😂"]);
});

it("incremental channel projection applies delete-of-reaction and rejects an owner deletion of a reaction", () => {
  const mine = reaction(),
    deletion = remove(mine),
    foreignDelete = remove(mine, other);
  const projection = new MessageProjection(
    "c",
    relay.pubkey,
    createRelayProfiler(),
  );
  expect(projection.reconcile([root, mine], [])[0]?.reactions).toHaveLength(1);
  expect(
    projection.reconcile([root, mine, remove(mine, other)], [])[0]?.reactions,
  ).toHaveLength(1);
  expect(
    projection.reconcile([root, mine, foreignDelete], [])[0]?.reactions,
  ).toHaveLength(1);
  expect(
    projection.reconcile([root, mine, deletion], [])[0]?.reactions,
  ).toEqual([]);
  expect(projection.reconcile([root, mine], [])[0]?.reactions).toHaveLength(1);
  expect(
    projection.reconcile([root, deletion, mine], [])[0]?.reactions,
  ).toEqual([]);
});

it("removal validates every loaded author and conversation before queuing one deletion per target", () => {
  const mine = reaction(),
    duplicate = reaction(viewer, 3),
    theirs = reaction(other);
  const foreign = message(viewer, "other", "own message", 2);
  const events = [root, mine, duplicate, theirs, foreign];
  const send = vi.fn(() => "operation");
  const messages = createMessages(
    {
      ready: async () => {},
      recovery: async () => undefined,
      recover: async () => {},
      acknowledge: async () => {},
      supports: () => true,
      send,
      retry() {},
      dismiss: async () => {},
      snapshot: () => [],
      subscribe: () => () => {},
      observeDismiss: () => () => {},
      observeSend: () => () => {},
    },
    viewer.pubkey,
    (id) => events.find((item) => item.id === id),
    () => [],
    () => {},
  );
  expect(() => messages.remove([mine.id, theirs.id])).toThrow(/Only your own/);
  expect(() => messages.remove([mine.id, foreign.id])).toThrow(
    /one loaded conversation/,
  );
  expect(() => messages.remove(["missing"])).toThrow(/Load/);
  expect(send).not.toHaveBeenCalled();
  messages.remove([mine.id, duplicate.id, mine.id]);
  expect(send.mock.calls).toEqual(
    [mine.id, duplicate.id].map((id) => [
      {
        kind: 5,
        content: "",
        tags: [
          ["h", "c"],
          ["e", id],
          ["k", "7"],
        ],
      },
    ]),
  );
});

it("requires matching viewer and agent identities to remove agent messages", () => {
  const mine = reaction(),
    agentReaction = reaction(other),
    agentMessage = message(other, "c", "Agent message", 4);
  const events = [root, mine, agentReaction, agentMessage];
  const send = vi.fn(() => "operation");
  const messages = createMessages(
    {
      ready: async () => {},
      recovery: async () => undefined,
      recover: async () => {},
      acknowledge: async () => {},
      supports: () => true,
      send,
      retry() {},
      dismiss: async () => {},
      snapshot: () => [],
      subscribe: () => () => {},
      observeDismiss: () => () => {},
      observeSend: () => () => {},
    },
    viewer.pubkey,
    (id) => events.find((item) => item.id === id),
    () => [],
    () => {},
  );
  const authorization = { agentId: other.pubkey, ownerId: viewer.pubkey };

  expect(() => messages.remove([agentMessage.id])).toThrow(/Only your own/);
  expect(() =>
    messages.remove([agentMessage.id], {
      ...authorization,
      ownerId: other.pubkey,
    }),
  ).toThrow(/Only your own/);
  expect(() =>
    messages.remove([agentMessage.id], {
      ...authorization,
      agentId: viewer.pubkey,
    }),
  ).toThrow(/Only your own/);
  expect(() => messages.remove([agentReaction.id], authorization)).toThrow(
    /Only your own/,
  );
  expect(send).not.toHaveBeenCalled();

  messages.remove([agentMessage.id], authorization);
  expect(send).toHaveBeenCalledExactlyOnceWith({
    kind: 5,
    content: "",
    tags: [
      ["h", "c"],
      ["e", agentMessage.id],
      ["k", "9"],
    ],
  });
});

it("authorizes removal against the relay-attributed agent author, not the relay signer", () => {
  const agent = keypair();
  const attributed = signed(relay, {
    kind: 9,
    content: "Agent output",
    created_at: 5,
    tags: [
      ["actor", agent.pubkey],
      ["h", "c"],
    ],
  });
  const forged = signed(other, {
    kind: 9,
    content: "Forged actor",
    created_at: 6,
    tags: [
      ["actor", agent.pubkey],
      ["h", "c"],
    ],
  });
  const events = [attributed, forged];
  const send = vi.fn(() => "operation");
  const messages = createMessages(
    {
      ready: async () => {},
      recovery: async () => undefined,
      recover: async () => {},
      acknowledge: async () => {},
      supports: () => true,
      send,
      retry() {},
      dismiss: async () => {},
      snapshot: () => [],
      subscribe: () => () => {},
      observeDismiss: () => () => {},
      observeSend: () => () => {},
    },
    viewer.pubkey,
    (id) => events.find((item) => item.id === id),
    () => [],
    () => {},
    undefined,
    undefined,
    undefined,
    relay.pubkey,
  );
  const authorization = { agentId: agent.pubkey, ownerId: viewer.pubkey };

  expect(() => messages.remove([forged.id], authorization)).toThrow(
    /Only your own/,
  );
  expect(send).not.toHaveBeenCalled();

  messages.remove([attributed.id], authorization);
  expect(send).toHaveBeenCalledExactlyOnceWith({
    kind: 5,
    content: "",
    tags: [
      ["h", "c"],
      ["e", attributed.id],
      ["k", "9"],
    ],
  });
});

it("real session retries the same signed deletion and keeps the reaction removed after confirmation", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const publish = vi.fn(async (_event: RelayEvent) => {
    throw new PublishRejected("try again");
  });
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: { sign: async (template) => signed(viewer, template), publish },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  owner.session.channels.ensure("c");
  const mine = reaction();
  live.receive([roster(relay, "c", [viewer.pubkey], 1), root, mine]);
  completeHeads(wire, relay);
  await flush();
  const id = owner.session.messages.remove([mine.id]);
  expect(owner.session.channels.window("c").rows[0]?.reactions).toEqual([]);
  await flush();
  await flush();
  expect(owner.session.outbox?.snapshot()[0]?.delivery).toBe("failed");
  expect(owner.session.channels.window("c").rows[0]?.reactions).toHaveLength(1);
  const original = publish.mock.calls[0]?.[0];
  publish.mockImplementation(async () => undefined as never);
  owner.session.messages.retry(id);
  await flush();
  await flush();
  expect(publish.mock.calls[1]?.[0]).toEqual(original);
  if (!original) throw new Error("Missing signed deletion");
  live.receive([original]);
  expect(owner.session.channels.window("c").rows[0]?.reactions).toEqual([]);
  live.receive([mine]);
  expect(owner.session.channels.window("c").rows[0]?.reactions).toEqual([]);
});

it.each(["channel", "dm", "thread"])(
  "%s restores a failed removal across session replacement and retries the original event",
  async (surface) => {
    const reply = message(other, "c", "Reply", 2, [
      ["e", root.id, "", "reply"],
    ]);
    const target = surface === "thread" ? reply : root;
    const mine = signed(viewer, {
      kind: 7,
      content: ":party:",
      tags: [
        ["e", target.id],
        ["emoji", "party", "https://old.test/party.png"],
      ],
    }); // Legacy reactions need not carry a channel tag.
    const metadata = signed(relay, {
      kind: 39000,
      content: "{}",
      tags: [
        ["d", "c"],
        ...(surface === "dm" ? [["t", "dm"], ["private"], ["hidden"]] : []),
      ],
    });
    const evidence = [
      roster(relay, "c", [viewer.pubkey, other.pubkey]),
      metadata,
      root,
      reply,
      mine,
    ];
    let stored: readonly OutgoingEvent[] = [];
    const publish = vi.fn(async (_event: RelayEvent) => {
      throw new PublishRejected("Nope");
    });
    const connect = async () => {
      const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
      let live!: LiveCallbacks;
      const owner = createRelaySession(
        {
          ...wire.transport,
          writer: {
            sign: async (template) => signed(viewer, template),
            publish,
          },
          subscribe(callbacks) {
            live = callbacks;
            return { update() {}, retry() {}, dispose() {} };
          },
        },
        {
          outboxStorage: {
            load: async () => stored,
            save: (items) => {
              stored = items;
            },
          },
        },
      );
      owners.push(owner);
      owner.session.channels.ensure("c");
      live.receive(evidence.filter((event) => event.id !== mine.id));
      live.receive([mine]);
      completeHeads(wire, relay);
      await flush();
      const view =
        surface === "thread" ? owner.session.thread("c", root.id) : undefined;
      if (view) owners.push(view);
      const row = () =>
        view
          ? view.snapshot().replies[0]
          : owner.session.channels.window("c").rows[0];
      return { ...owner, live, row };
    };
    const first = await connect();
    expect(first.row()?.reactions[0]?.emoji?.url).toBe(
      "https://old.test/party.png",
    );
    const operation = first.session.messages.remove([mine.id]);
    await flush();
    await flush();
    expect(first.session.outbox?.snapshot()[0]?.delivery).toBe("failed");
    const original = publish.mock.calls[0]?.[0];
    first.dispose();
    const next = await connect();
    await flush();
    await flush();
    const restored = next.session.outbox?.snapshot()[0]?.event;
    if (!restored) throw new Error("Missing restored removal");
    expect(next.session.messages.reactionTarget(restored)).toBe(target.id);
    expect(next.row()?.reactions).toHaveLength(1);
    publish.mockImplementation(async () => undefined as never);
    next.session.messages.retry(operation);
    await flush();
    await flush();
    expect(publish.mock.calls[1]?.[0]).toEqual(original);
    if (!original) throw new Error("Missing publication");
    next.live.receive([original]);
    expect(next.row()?.reactions).toEqual([]);
    next.live.receive([mine]);
    expect(next.row()?.reactions).toEqual([]);
  },
);

it("real session publishes attributed-owner edits and deletion through its trusted authority", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const published: RelayEvent[] = [];
  const owner = createRelaySession(
    {
      ...wire.transport,
      archiveAuthority: relay.pubkey,
      writer: {
        sign: async (template) => signed(viewer, template),
        publish: async (event) => {
          published.push(event);
        },
      },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  owner.session.channels.ensure("c");
  const attributed = signed(relay, {
    kind: 9,
    content: "Original",
    tags: [
      ["h", "c"],
      ["actor", viewer.pubkey],
    ],
  });
  live.receive([roster(relay, "c", [viewer.pubkey], 1), attributed]);
  completeHeads(wire, relay);
  await flush();
  expect(owner.session.channels.window("c").rows[0]?.authorId).toBe(
    viewer.pubkey,
  );
  await owner.session.outbox?.ready();
  const editId = owner.session.messages.edit(
    attributed.id,
    "Edited",
    attributed.id,
  );
  await vi.waitFor(() =>
    expect(published.some((event) => event.id === editId)).toBe(true),
  );
  const edit = published.find((event) => event.id === editId);
  expect(edit).toMatchObject({ kind: 40003, pubkey: viewer.pubkey });
  expect(edit?.tags).toContainEqual(["e", attributed.id]);
  if (!edit) throw new Error("Missing published edit");
  live.receive([edit]);
  expect(owner.session.channels.window("c").rows[0]?.content).toBe("Edited");
  const deletionId = owner.session.messages.remove([attributed.id]);
  await vi.waitFor(() =>
    expect(published.some((event) => event.id === deletionId)).toBe(true),
  );
  const deletion = published.find((event) => event.id === deletionId);
  expect(deletion).toMatchObject({ kind: 5, pubkey: viewer.pubkey });
  expect(deletion?.tags).toContainEqual(["e", attributed.id]);
  if (!deletion) throw new Error("Missing published deletion");
  live.receive([deletion]);
  expect(owner.session.channels.window("c").rows).toEqual([]);
});
