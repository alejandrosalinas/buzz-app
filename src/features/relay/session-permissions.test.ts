import { afterEach, assert, expect, it, vi } from "vitest";
import type { EventTemplate } from "nostr-tools";
import { createRelaySession } from "./session";
import { PublishRejected } from "./outbox";
import { matchesEvent } from "./projection";
import { keypair, message, signed } from "./testing";
import type { RelayEvent } from "./events";
import type { AttachmentUpload } from "./attachments";
import { removeAgentFromChannels } from "../agents/relay-removal";

const id = "11111111-1111-4111-8111-111111111111";
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setup(
  initialRole = "member",
  uploadAttachment?: AttachmentUpload,
) {
  const viewer = keypair(),
    relay = keypair(),
    peer = keypair(),
    agent = keypair();
  let role = initialRole,
    peerRole = "owner",
    member = true,
    joinRole = "guest",
    time = 1700000000,
    agentJoined = true;
  const own = message(viewer, id, "Earlier message", time);
  const root = message(peer, id, "Announcement", time);
  const canvas = signed(peer, {
    kind: 40100,
    content: "Saved announcement notes",
    tags: [["h", id]],
    created_at: time,
  });
  const events = () => [
    signed(relay, {
      kind: 39000,
      created_at: time,
      content: "",
      tags: [
        ["d", id],
        ["name", "Updates"],
        ["t", "stream"],
        ["public"],
        ["join_role", joinRole],
      ],
    }),
    signed(relay, {
      kind: 39001,
      created_at: time,
      content: "",
      tags: [
        ["d", id],
        ...(peerRole === "owner" ? [["p", peer.pubkey, "owner"]] : []),
      ],
    }),
    signed(relay, {
      kind: 39002,
      created_at: time,
      content: "",
      tags: [
        ["d", id],
        ["p", peer.pubkey, "", peerRole],
        ...(member ? [["p", viewer.pubkey, "", role]] : []),
        ...(agentJoined ? [["p", agent.pubkey, "", "bot"]] : []),
      ],
    }),
    own,
    root,
    canvas,
  ];
  const sign = vi.fn(async (event: EventTemplate) => signed(viewer, event));
  const publish = vi.fn(async (event: RelayEvent) => {
    if (event.kind === 9022) {
      member = false;
      time++;
    }
    if (event.kind === 9021) {
      member = true;
      role = joinRole;
      time++;
    }
    if (
      event.kind === 9001 &&
      event.tags.some(([key, value]) => key === "p" && value === agent.pubkey)
    ) {
      agentJoined = false;
      time++;
    }
  });
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: (url) => url,
      writer: { sign, publish },
      channelLifecycle: { sign, publish },
      channelDetails: { sign, publish },
      workflows: { runs: async () => ({ runs: [], next: null }) },
      ...(uploadAttachment ? { uploadAttachment } : {}),
      query: async (filters) =>
        events().filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        ),
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  owner.session.channels.refreshList?.();
  await vi.waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  await owner.session.read([{ kinds: [9], "#h": [id], limit: 10 }]);
  await owner.session.outbox?.ready();
  return {
    ...owner,
    sign,
    publish,
    own,
    root,
    viewer,
    peer,
    agent,
    async role(next: string) {
      role = next;
      time++;
      await owner.session.read([{ kinds: [39002], "#d": [id], limit: 1 }]);
    },
    async peerRole(next: string) {
      peerRole = next;
      time++;
      await owner.session.read([{ kinds: [39002], "#d": [id], limit: 1 }]);
    },
    async default(next: string) {
      joinRole = next;
      time++;
      await owner.session.read([{ kinds: [39000], "#d": [id], limit: 1 }]);
    },
  };
}

it("rejects a guest's direct message operations before signing and restores them only after promotion", async () => {
  const h = await setup("guest");
  for (const action of [
    () => h.session.messages.send(id, "Post"),
    () => h.session.messages.reply(id, h.root.id, "Reply"),
    () => h.session.messages.react(h.root.id, "👍"),
    () => h.session.messages.edit(h.own.id, "Edit", h.own.id),
    () => h.session.messages.remove([h.own.id]),
  ])
    expect(action).toThrow();
  await h.default("member");
  expect(() => h.session.messages.send(id, "Still guest")).toThrow();
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
  await h.role("member");
  h.session.messages.send(id, "Now member");
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
});

it.each([9, 7, 40003, 5, 40100, 30620, 46020])(
  "blocks kind %s sent directly through a guest's outbox",
  async (kind) => {
    const h = await setup("guest");
    const outbox = h.session.outbox;
    assert.exists(outbox);
    const workflow = kind === 30620 || kind === 46020;
    const eventId = outbox.send({
      kind,
      content:
        kind === 30620
          ? "name: Updates\nenabled: false\ntrigger:\n  on: message_posted\nsteps:\n  - id: send\n    action: send_message\n    text: Hi\n"
          : kind === 46020
            ? ""
            : "Write",
      tags: [["h", id], workflow ? ["d", id] : ["e", h.root.id]],
    });
    await vi.waitFor(() =>
      expect(
        outbox.snapshot().find((entry) => entry.event.id === eventId),
      ).toMatchObject({
        delivery: "failed",
        error: workflow
          ? "Workflow command rejected; retain the draft and refresh the saved configuration."
          : "You have read-only access to this channel.",
      }),
    );
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  },
);

it.each([9000, 9022])(
  "leaves Guest membership command %s authorization to the relay",
  async (kind) => {
    const h = await setup("guest");
    const outbox = h.session.outbox;
    assert.exists(outbox);
    const eventId = outbox.send({
      kind,
      content: "",
      tags: [["h", id], ...(kind === 9022 ? [] : [["p", h.peer.pubkey]])],
    });
    await vi.waitFor(() =>
      expect(
        outbox.snapshot().find((entry) => entry.event.id === eventId),
      ).toMatchObject({ delivery: "accepted" }),
    );
    expect(h.sign).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.publish.mock.calls[0]?.[0]).toMatchObject({ kind });
  },
);

it("lets a Guest remove an agent through the existing removal workflow and confirm its fresh roster", async () => {
  const h = await setup("guest");
  await removeAgentFromChannels(
    h.session,
    h.agent.pubkey,
    new AbortController().signal,
  );
  expect(h.sign).toHaveBeenCalledOnce();
  expect(h.publish.mock.calls[0]?.[0]).toMatchObject({
    kind: 9001,
    tags: expect.arrayContaining([
      ["h", id],
      ["p", h.agent.pubkey],
    ]),
  });
  expect(h.session.outbox?.snapshot()).toHaveLength(0);
});

it("blocks a message demoted while signing without publishing it", async () => {
  const h = await setup();
  const started = deferred<void>(),
    gate = deferred<void>();
  h.sign.mockImplementationOnce(async (template) => {
    started.resolve();
    await gate.promise;
    return signed(h.viewer, template);
  });
  const eventId = h.session.messages.send(id, "Queued before demotion");
  try {
    await started.promise;
    await h.role("guest");
  } finally {
    gate.resolve();
  }
  await vi.waitFor(() =>
    expect(
      h.session.outbox?.snapshot().find((entry) => entry.event.id === eventId),
    ).toMatchObject({
      delivery: "failed",
      error: "You have read-only access to this channel.",
    }),
  );
  expect(h.publish).not.toHaveBeenCalled();
});

it("rechecks a signed retry after demotion without signing or publishing it again", async () => {
  const h = await setup();
  h.publish.mockRejectedValueOnce(new PublishRejected("Try later"));
  const eventId = h.session.messages.send(id, "Signed before demotion");
  await vi.waitFor(() =>
    expect(h.session.outbox?.snapshot()[0]?.delivery).toBe("failed"),
  );
  await h.role("guest");
  h.session.messages.retry(eventId);
  await vi.waitFor(() =>
    expect(h.session.outbox?.snapshot()[0]).toMatchObject({
      delivery: "failed",
      error: "You have read-only access to this channel.",
    }),
  );
  expect(h.sign).toHaveBeenCalledOnce();
  expect(h.publish).toHaveBeenCalledOnce();
});

it("publishes a roster owner change that leaves the viewer's own role as it was", async () => {
  const h = await setup("owner");
  const channel = () =>
    h.session.channels.list().channels.find((entry) => entry.id === id);
  expect(channel()?.owners).toEqual([h.peer.pubkey, h.viewer.pubkey].sort());
  // Only the other owner changes: members and the viewer's role stay put, yet
  // the viewer becomes the last owner, which decides whether Leave is offered.
  await h.peerRole("member");
  await vi.waitFor(() => expect(channel()?.owners).toEqual([h.viewer.pubkey]));
  expect(channel()?.viewerRole).toBe("owner");
});

it("retains guest history, details and Leave", async () => {
  const h = await setup("guest");
  expect(
    await h.session.read([{ kinds: [9], "#h": [id], limit: 10 }]),
  ).toHaveLength(2);
  expect(await h.session.channelDetails.load(id)).toMatchObject({
    canEdit: false,
  });
  expect(await h.session.channelLifecycle.load(id)).toMatchObject({
    canLeave: true,
    canArchive: false,
  });
  await h.session.channelLifecycle.run("leave", id);
  expect(h.publish.mock.calls[0]?.[0].kind).toBe(9022);
  expect(h.session.channels.list().channels).toHaveLength(0);
});

it("drops a departed Guest's role when a newer public preview permits rejoining in the same session", async () => {
  const h = await setup("guest");
  await h.session.channelLifecycle.run("leave", id);
  // Advance metadata independently of the equal-version preview regression.
  await h.default("member");
  await h.session.channels.resolve?.([id]);
  const preview = h.session.channels.get?.(id);
  expect(preview).toMatchObject({ readOnly: true, joinRole: "member" });
  expect(preview?.viewerRole).toBeUndefined();
  expect(h.session.channels.list().channels).toHaveLength(0);
  await h.session.channelLifecycle.run("join", id);
  expect(h.publish.mock.calls.map(([event]) => event.kind)).toEqual([
    9022, 9021,
  ]);
  expect(h.session.channels.get?.(id)).toMatchObject({ viewerRole: "member" });
  h.session.messages.send(id, "Rejoined participant");
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledTimes(3));
});

it("lets a Guest read canvas content and history without granting save access", async () => {
  const h = await setup("guest");
  expect(await h.session.canvas.read(id)).toMatchObject({
    content: "Saved announcement notes",
  });
  expect((await h.session.canvas.history(id)).revisions).toHaveLength(1);
  await expect(
    h.session.canvas.save(id, "Forbidden edit", undefined),
  ).rejects.toThrow("Canvas writing is unavailable in this channel");
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
});

it("rejects guest uploads and fences an upload completed after demotion", async () => {
  const started = deferred<void>(),
    gate = deferred<void>();
  const result = {
    url: "https://relay.test/media/notes.txt",
    name: "notes.txt",
    size: 4,
    type: "text/plain",
    sha256: "a".repeat(64),
  };
  const upload = vi.fn(async () => {
    started.resolve();
    await gate.promise;
    return result;
  });
  const h = await setup("guest", upload);
  const attachments = h.session.attachments;
  assert.exists(attachments);
  const file = new File(["text"], "notes.txt");
  await expect(
    attachments.upload(file, id, new AbortController().signal),
  ).rejects.toMatchObject({ code: "denied" });
  expect(upload).not.toHaveBeenCalled();
  await h.role("member");
  const pending = attachments.upload(file, id, new AbortController().signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: "denied" });
  try {
    await started.promise;
    await h.role("guest");
  } finally {
    gate.resolve();
  }
  await rejected;
});
