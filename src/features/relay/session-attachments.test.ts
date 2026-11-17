import { assert, afterEach, expect, it, vi } from "vitest";
import type { EventTemplate } from "nostr-tools";
import type { RelayEvent } from "./events";
import type { AttachmentUpload, UploadedAttachment } from "./attachments";
import { createRelaySession } from "./session";
import { PublishRejected } from "./outbox";
import { keypair, metadata, roster, signed } from "./testing";

const viewer = keypair(),
  relay = keypair(),
  other = keypair();
const origin = "https://relay.test";
const attachment: UploadedAttachment = {
  name: "notes.pdf",
  url: `${origin}/media/${"a".repeat(64)}.pdf`,
  type: "application/pdf",
  size: 3,
  sha256: "a".repeat(64),
};
const file = new File(["pdf"], attachment.name);
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function setup(uploadAttachment?: AttachmentUpload, writable = true) {
  let members = [viewer.pubkey, other.pubkey];
  let time = 1700000000;
  const sign = vi.fn(async (template: EventTemplate) =>
    signed(viewer, template),
  );
  const publish = vi.fn(async (_event: RelayEvent) => {});
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: origin,
      media: (url) => url,
      async query(filters) {
        if (filters[0]?.limit === 1 && filters[0]?.kinds?.[0] === 39002)
          return [roster(relay, "c", members, time)];
        return filters.some((f) => f.kinds?.includes(39002))
          ? [
              roster(relay, "c", members, time),
              metadata(relay, "c", "General", time),
            ]
          : [];
      },
      ...(uploadAttachment ? { uploadAttachment } : {}),
      ...(writable ? { writer: { sign, publish } } : {}),
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  async function membership(next = members) {
    members = next;
    time++;
    await owner.session.read([
      { kinds: [39002, 39000], "#d": ["c"], limit: 10 },
    ]);
  }
  return { ...owner, sign, publish, membership };
}

it("does not advertise upload support on read-only or unsupported connections", () => {
  expect(setup().session.attachments).toBeUndefined();
  expect(
    setup(async () => attachment, false).session.attachments,
  ).toBeUndefined();
});

it.each([false, true])(
  "uploads once, builds attachment-only root/reply (%s), and retries the same signed event",
  async (reply) => {
    const upload = vi.fn(async () => attachment);
    const h = setup(upload);
    assert.exists(h.session.attachments);
    await h.membership();
    h.publish.mockRejectedValueOnce(new PublishRejected("try again"));
    const result = await h.session.attachments.upload(
      file,
      "c",
      new AbortController().signal,
    );
    expect(h.publish).not.toHaveBeenCalled();
    const root = "b".repeat(64);
    const id = reply
      ? h.session.messages.reply("c", root, "", [other.pubkey], [result])
      : h.session.messages.send("c", "", [other.pubkey], [result]);
    await vi.waitFor(() =>
      expect(h.session.outbox?.snapshot()[0]?.delivery).toBe("failed"),
    );
    const first = h.publish.mock.calls[0]?.[0];
    assert.exists(first);
    expect(first.content).toBe(`[notes.pdf](<${attachment.url}>)`);
    expect(first.tags).toContainEqual(["p", other.pubkey]);
    expect(first.tags).toContainEqual([
      "imeta",
      `url ${attachment.url}`,
      "m application/pdf",
      "size 3",
      `x ${attachment.sha256}`,
      "filename notes.pdf",
    ]);
    if (reply) expect(first.tags).toContainEqual(["e", root, "", "reply"]);
    h.session.messages.retry(id);
    await vi.waitFor(() => expect(h.publish).toHaveBeenCalledTimes(2));
    expect(h.publish.mock.calls[1]?.[0]).toEqual(first);
    expect(h.sign).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
  },
);

it.each(["caller", "dispose", "clear", "access"])(
  "cancels upload on %s and fences an uncooperative late result",
  async (action) => {
    let release!: (value: UploadedAttachment) => void;
    let signal!: AbortSignal;
    const h = setup(async (_file, supplied) => {
      signal = supplied;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    await h.membership();
    assert.exists(h.session.attachments);
    const caller = new AbortController();
    const pending = h.session.attachments.upload(file, "c", caller.signal);
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    if (action === "caller") caller.abort();
    if (action === "dispose") h.dispose();
    if (action === "clear") await h.clearCache();
    if (action === "access") await h.membership([other.pubkey]);
    expect(signal.aborted).toBe(true);
    release(attachment);
    await rejected;
    expect(h.publish).not.toHaveBeenCalled();
  },
);

it("blocks upload and attachment sending after membership loss or session disposal", async () => {
  const upload = vi.fn(async () => attachment);
  const h = setup(upload);
  assert.exists(h.session.attachments);
  await h.membership([other.pubkey]);
  await expect(
    h.session.attachments.upload(file, "c", new AbortController().signal),
  ).rejects.toMatchObject({ code: "denied" });
  expect(() => h.session.messages.send("c", "", [], [attachment])).toThrow(
    /write access/,
  );
  expect(upload).not.toHaveBeenCalled();
  h.dispose();
  expect(() => h.session.messages.send("c", "hello")).toThrow(/write access/);
});

it("rejects other-community attachment URLs, invalid roots and genuinely empty messages before enqueue", async () => {
  const h = setup(async () => attachment);
  await h.membership();
  expect(() =>
    h.session.messages.send(
      "c",
      "",
      [],
      [
        {
          ...attachment,
          url: attachment.url.replace("relay.test", "other.test"),
        },
      ],
    ),
  ).toThrow(/invalid/);
  expect(() =>
    h.session.messages.reply("c", "bad", "", [], [attachment]),
  ).toThrow(/thread root/);
  expect(() => h.session.messages.send("c", " ")).toThrow(/empty/);
  expect(h.sign).not.toHaveBeenCalled();
});

it.each(["dispose", "clear"])(
  "uploads for a chat not yet created and still cancels on %s",
  async (action) => {
    const ready = setup(async () => attachment);
    assert.exists(ready.session.attachments?.uploadForNewChat);
    await expect(
      ready.session.attachments.uploadForNewChat(
        file,
        new AbortController().signal,
      ),
    ).resolves.toEqual(attachment);

    let signal!: AbortSignal;
    let release!: (value: UploadedAttachment) => void;
    const h = setup(async (_file, supplied) => {
      signal = supplied;
      return new Promise<UploadedAttachment>((resolve) => {
        release = resolve;
      });
    });
    assert.exists(h.session.attachments?.uploadForNewChat);
    const pending = h.session.attachments.uploadForNewChat(
      file,
      new AbortController().signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    if (action === "dispose") h.dispose();
    else await h.clearCache();
    expect(signal.aborted).toBe(true);
    release(attachment);
    await rejected;
  },
);

it("forwards an accepted local message again before its relay echo", async () => {
  const h = setup();
  await h.membership();
  const id = h.session.messages.send("c", "Copy this");
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
  const { foldMessages } = await import("./fold");
  const first = h.publish.mock.calls[0]?.[0];
  assert.exists(first);
  const row = foldMessages("c", viewer.pubkey, [first])[0];
  assert.exists(row);
  expect(row.id).toBe(id);
  h.session.messages.forward("c", row, "Viewer", "");
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledTimes(2));
  const forwarded = h.publish.mock.calls[1]?.[0];
  assert.exists(forwarded);
  const received = foldMessages("c", viewer.pubkey, [forwarded])[0];
  assert.exists(received);
  h.session.messages.forward("c", received, "Viewer", "Again");
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledTimes(3));
  expect(
    h.publish.mock.calls[2]?.[0].tags.filter(([tag]) => tag === "buzz:forward"),
  ).toHaveLength(1);
});
