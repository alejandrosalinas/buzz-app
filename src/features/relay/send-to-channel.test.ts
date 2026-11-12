import { assert, expect, it, vi } from "vitest";
import { profileMentionParts } from "../messages/profile-mentions";
import { createMessages } from "./messages";
import {
  messageTokenTags,
  signMessageTokens,
} from "../messages/message-tokens";
import { createOutbox } from "./outbox";
import { foldMessages } from "./fold";
import { keypair, message, signed } from "./testing";
import type { EventData, RelayEvent } from "./events";

const author = keypair();
const other = keypair();
const root = message(other, "channel", "A thread", 1);
const reply = message(author, "channel", "Hello :wave:", 2, [
  ["e", root.id, "", "reply"],
  ["p", other.pubkey],
  ["emoji", "wave", "https://example.com/wave.png"],
  ["imeta", "url https://example.com/photo.png", "m image/png"],
]);
function setup(events: EventData[] = [root, reply], allowed = true) {
  const writer = {
    kinds: [9, 5, 40003],
    sign: vi.fn(async (event) => signed(author, event)),
    publish: vi.fn(async (_event: RelayEvent) => {}),
  };
  const { outbox } = createOutbox(author.pubkey, writer, {
    load: () => [],
    save: () => {},
  });
  const messages = createMessages(
    outbox,
    author.pubkey,
    (id) => events.find((event) => event.id === id),
    () => [],
    () => {},
    () => allowed,
  );
  const row =
    foldMessages("channel", other.pubkey, events, {
      includeReplies: true,
    }).find((row) => row.id === reply.id) ??
    foldMessages("channel", other.pubkey, [reply], { includeReplies: true })[0];
  assert.exists(row);
  return { outbox, messages, row, writer };
}
it("signs a fresh top-level message and folds its provenance, emoji, attachment and mention display", async () => {
  const { messages, row, outbox, writer } = setup();
  await outbox.ready();
  messages.sendToChannel(row);
  await vi.waitFor(() => expect(writer.publish).toHaveBeenCalledOnce());
  const event = outbox.snapshot()[0]?.event;
  assert.exists(event);
  expect(event.id).not.toBe(reply.id);
  expect(event.pubkey).toBe(author.pubkey);
  expect(event.kind).toBe(9);
  expect(event.content).toBe(row.content);
  expect(event.tags).toContainEqual(["h", "channel"]);
  expect(event.tags).toContainEqual(["buzz:sent-from-thread", root.id]);
  expect(event.tags.some(([name]) => name === "e" || name === "p")).toBe(false);
  const shared = foldMessages("channel", other.pubkey, [event])[0];
  assert.exists(shared);
  expect(shared.threadRootId).toBeUndefined();
  expect(shared.sentFromThread?.rootId).toBe(root.id);
  expect(shared.emoji).toEqual(row.emoji);
  expect(shared.attachments).toEqual(row.attachments);
  expect(shared.mentionReferences).toEqual([other.pubkey]);
});
it("copies the edited body and edited attachment provenance", () => {
  const edit = signed(author, {
    kind: 40003,
    created_at: 3,
    content: "Edited reply",
    tags: [
      ["e", reply.id],
      ["h", "channel"],
      ["imeta", "url https://example.com/new.png", "m image/png"],
    ],
  });
  const { messages, row, outbox } = setup([root, reply, edit]);
  messages.sendToChannel(row);
  const event = outbox.snapshot()[0]?.event;
  assert.exists(event);
  expect(event.content).toBe("Edited reply");
  expect(event.tags).toContainEqual(edit.tags[2]);
  expect(event.tags).not.toContainEqual(
    reply.tags.find(([name]) => name === "imeta"),
  );
  expect(event.tags.some(([name]) => name === "p")).toBe(false);
});
it("rejects third-party authors, pending messages, mismatched destinations and unavailable membership", () => {
  const { messages, row, outbox } = setup();
  for (const invalid of [
    { ...row, authorId: other.pubkey },
    { ...row, delivery: "sending" as const },
    { ...row, channelId: "elsewhere" },
    { ...row, threadRootId: "a".repeat(64) },
  ]) {
    expect(() => messages.sendToChannel(invalid)).toThrow();
  }
  expect(() => setup([root, reply], false).messages.sendToChannel(row)).toThrow(
    /write access/,
  );
  expect(() => setup([root]).messages.sendToChannel(row)).toThrow(/Load/);
  expect(outbox.snapshot()).toHaveLength(0);
});
it("ignores malformed provenance on received messages", () => {
  const invalid = message(author, "channel", "Hello", 4, [
    ["buzz:sent-from-thread", "invalid"],
  ]);
  expect(
    foldMessages("channel", other.pubkey, [invalid])[0]?.sentFromThread,
  ).toBeUndefined();
});

it("rejects a loaded reply authored by someone else even when the caller changes the displayed author", () => {
  const foreign = message(other, "channel", "Other reply", 3, [
    ["e", root.id, "", "reply"],
  ]);
  const { messages, row, outbox } = setup([root, reply, foreign]);
  expect(() => messages.sendToChannel({ ...row, id: foreign.id })).toThrow(
    /Only your own/,
  );
  expect(outbox.snapshot()).toHaveLength(0);
});
it("preserves attachment-only replies", () => {
  const image = message(author, "channel", "", 3, [
    ["e", root.id, "", "reply"],
    ["imeta", "url https://example.com/photo.png", "m image/png"],
  ]);
  const { messages, outbox } = setup([root, image]);
  const row = foldMessages("channel", other.pubkey, [image], {
    includeReplies: true,
  })[0];
  assert.exists(row);
  messages.sendToChannel(row);
  const event = outbox.snapshot()[0]?.event;
  assert.exists(event);
  expect(event.content).toBe("https://example.com/photo.png");
  expect(
    foldMessages("channel", other.pubkey, [event])[0]?.attachments,
  ).toEqual(row.attachments);
});

it("shares a compact excerpt from the reconciled root, omitting spoilers and markup", () => {
  const { messages, row, outbox } = setup();
  const currentRoot = foldMessages("channel", other.pubkey, [root])[0];
  assert.exists(currentRoot);
  messages.sendToChannel(row, {
    ...currentRoot,
    content:
      "**Updated** [layout](https://example.com) ||secret||\n\n" +
      "😀".repeat(80),
  });
  const tag = outbox
    .snapshot()[0]
    ?.event.tags.find(([name]) => name === "buzz:sent-from-thread");
  expect(tag?.[2]).toMatch(/^Updated layout 😀/);
  expect(tag?.[2]).not.toContain("secret");
  expect(tag?.[2]).not.toContain("https:");
  expect(Array.from(tag?.[2] ?? "")).toHaveLength(64);
  expect(tag?.[2]?.endsWith("…")).toBe(true);
});
it("omits the excerpt when the supplied root belongs to another conversation", () => {
  const { messages, row, outbox } = setup();
  messages.sendToChannel(row, {
    ...row,
    id: root.id,
    channelId: "elsewhere",
    content: "Unrelated",
  });
  expect(outbox.snapshot()[0]?.event.tags).toContainEqual([
    "buzz:sent-from-thread",
    root.id,
  ]);
});

it("does not restore display-only mention bindings when sharing an edited reply", () => {
  const original = message(author, "channel", "Hello @Other", 2, [
    ["e", root.id, "", "reply"],
    ["mention", other.pubkey],
  ]);
  const edit = signed(author, {
    kind: 40003,
    created_at: 3,
    content: "Edited @Other",
    tags: [
      ["e", original.id],
      ["h", "channel"],
    ],
  });
  const { messages, outbox } = setup([root, original, edit]);
  const rows = foldMessages("channel", other.pubkey, [root, original, edit], {
    includeReplies: true,
  });
  const row = rows.find((item) => item.id === original.id);
  assert.exists(row);
  const profiles = new Map([[other.pubkey, { name: "Other" }]]);
  expect(row.mentionReferences).toEqual([other.pubkey]);
  expect(profileMentionParts(row, profiles)).toEqual([
    { text: "Edited @Other" },
  ]);
  messages.sendToChannel(row);
  const event = outbox.snapshot()[0]?.event;
  assert.exists(event);
  const shared = foldMessages("channel", other.pubkey, [event])[0];
  assert.exists(shared);
  expect(shared.edited).toBeFalsy();
  expect(profileMentionParts(shared, profiles)).toEqual([
    { text: "Edited @Other" },
  ]);
});

it("shares a relay-attributed reply with edited media only under explicit signing authority", async () => {
  const attributed = signed(other, {
    kind: 9,
    content: "Original",
    created_at: 5,
    tags: [
      ["h", "channel"],
      ["e", root.id, "", "reply"],
      ["actor", author.pubkey],
    ],
  });
  const edit = signed(author, {
    kind: 40003,
    content: "Edited attributed reply",
    created_at: 6,
    tags: [
      ["h", "channel"],
      ["e", attributed.id],
      ["imeta", "url https://example.com/new.png", "m image/png"],
    ],
  });
  const { messages, outbox } = setup([root, attributed, edit]);
  const row = foldMessages("channel", other.pubkey, [root, attributed, edit], {
    includeReplies: true,
    signingAuthority: other.pubkey,
  }).find((item) => item.id === attributed.id);
  assert.exists(row);
  expect(row.authorId).toBe(author.pubkey);
  expect(() => messages.sendToChannel(row)).toThrow(/Only your own/);
  const trusted = createMessages(
    outbox,
    author.pubkey,
    (id) => [root, attributed, edit].find((event) => event.id === id),
    () => [],
    () => {},
    () => true,
    undefined,
    undefined,
    other.pubkey,
  );
  trusted.sendToChannel(row);
  await outbox.ready();
  const sent = outbox.snapshot()[0]?.event;
  assert.exists(sent);
  expect(sent.content).toBe("Edited attributed reply");
  expect(sent.tags).toContainEqual(edit.tags[2]);
  expect(
    sent.tags.some(([name, id]) => name === "e" && id === attributed.id),
  ).toBe(false);
});

it("mirrors an edit between a thread reply and its channel copy", async () => {
  const { messages, row, outbox, writer } = setup();
  await outbox.ready();
  messages.sendToChannel(row);
  const copy = outbox.snapshot()[0]?.event;
  assert.exists(copy);
  expect(copy.tags).toContainEqual(["buzz:copy-of", reply.id]);
  const events = [root, reply, copy];
  const linked = createMessages(
    outbox,
    author.pubkey,
    (id) => events.find((event) => event.id === id),
    () => [],
    () => {},
    () => true,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (id) =>
      events.filter((event) =>
        event.tags.some(([n, v]) => n === "buzz:copy-of" && v === id),
      ),
  );
  const targets = (before: number) =>
    outbox
      .snapshot()
      .slice(before)
      .map((item) => item.event)
      .filter((event) => event.kind === 40003)
      .map((event) => event.tags.find(([n]) => n === "e")?.[1])
      .sort();
  const start = outbox.snapshot().length;
  linked.edit(copy.id, "Changed", copy.id);
  expect(targets(start)).toEqual([copy.id, reply.id].sort());
  const next = outbox.snapshot().length;
  linked.edit(reply.id, "Changed again", reply.id);
  expect(targets(next)).toEqual([copy.id, reply.id].sort());
  void writer;
});

function linkedSetup() {
  const { messages: base, row, outbox } = setup();
  const copies: EventData[] = [];
  const events: EventData[] = [root, reply];
  const messages = createMessages(
    outbox,
    author.pubkey,
    (id) => events.find((event) => event.id === id),
    () => [],
    () => {},
    () => true,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (id) =>
      events.filter((event) =>
        event.tags.some(([n, v]) => n === "buzz:copy-of" && v === id),
      ),
  );
  void base;
  const send = () => {
    const before = outbox.snapshot().length;
    messages.sendToChannel(row);
    const event = outbox.snapshot()[before]?.event;
    assert.exists(event);
    // Distinct ids: nudge created_at so two sends differ.
    events.push(event);
    copies.push(event);
    return event;
  };
  const targets = (before: number, kind: number) =>
    outbox
      .snapshot()
      .slice(before)
      .map((item) => item.event)
      .filter((event) => event.kind === kind)
      .flatMap((event) =>
        event.tags.filter(([n]) => n === "e").map(([, id]) => id),
      )
      .sort();
  return { messages, outbox, send, targets, copies };
}
it("editing one of two copies also updates the reply and the sibling copy", async () => {
  const { messages, outbox, send, targets, copies } = linkedSetup();
  await outbox.ready();
  send();
  send();
  const [a, b] = copies;
  assert.exists(a);
  assert.exists(b);
  const before = outbox.snapshot().length;
  messages.edit(a.id, "Changed", a.id);
  expect(targets(before, 40003)).toEqual([a.id, b.id, reply.id].sort());
});
it("deleting the reply or either copy removes every linked copy", async () => {
  const { messages, outbox, send, targets, copies } = linkedSetup();
  await outbox.ready();
  send();
  send();
  const [a, b] = copies;
  assert.exists(a);
  assert.exists(b);
  const before = outbox.snapshot().length;
  messages.remove([a.id]);
  expect(targets(before, 5)).toEqual([a.id, b.id, reply.id].sort());
  const next = outbox.snapshot().length;
  messages.remove([reply.id]);
  expect(targets(next, 5)).toEqual([a.id, b.id, reply.id].sort());
});
it("a host reply signs its chips once and retries the exact bytes; the public API cannot add chips", async () => {
  const token = {
    kind: "skill" as const,
    id: JSON.stringify({ path: "/skills/review/SKILL.md", name: "Review" }),
    label: "/review",
    target: author.pubkey,
  };
  const h = setup();
  await h.outbox.ready();
  h.writer.publish.mockRejectedValueOnce(new Error("network cut"));
  const id = signMessageTokens([token], () =>
    h.messages.reply("channel", root.id, "Review", [author.pubkey]),
  );
  await vi.waitFor(() =>
    expect(
      h.outbox.snapshot().find((item) => item.event.id === id)?.delivery,
    ).toBe("unknown"),
  );
  const saved = h.outbox
    .snapshot()
    .find((item) => item.event.id === id)?.signed;
  assert.exists(saved);
  expect(saved.tags).toContainEqual(messageTokenTags([token])[0]);
  h.outbox.retry(id);
  await vi.waitFor(() => expect(h.writer.publish).toHaveBeenCalledTimes(2));
  expect(JSON.stringify(h.writer.publish.mock.calls[1]?.[0])).toBe(
    JSON.stringify(saved),
  );
  expect(h.writer.sign).toHaveBeenCalledTimes(1);
  // Outside the host scope, extra arguments are ignored.
  const send = h.messages.send as (...args: unknown[]) => string;
  const plain = send("channel", "Plain", [], [], undefined, [], {}, [token]);
  await vi.waitFor(() =>
    expect(h.writer.publish.mock.calls.at(-1)?.[0].id).toBe(plain),
  );
  expect(
    h.writer.publish.mock.calls
      .at(-1)?.[0]
      .tags.some(([name]) => name === "buzz-tokens-v1"),
  ).toBe(false);
});
it("only the host's own send carries its chips, not a send an outbox subscriber makes while it is queued", async () => {
  const token = {
    kind: "folder" as const,
    id: "/private/source",
    label: "source",
  };
  const tokens = (event?: { tags: string[][] }) =>
    event?.tags.filter(([name]) => name === "buzz-tokens-v1") ?? [];
  const h = setup(),
    other = setup();
  await Promise.all([h.outbox.ready(), other.outbox.ready()]);
  const reentrant: string[] = [];
  let entered = false;
  const stop = h.outbox.subscribe(() => {
    if (entered || !h.outbox.snapshot().length) return;
    entered = true;
    reentrant.push(
      h.messages.send("other-task", "subscriber send"),
      h.messages.reply("channel", root.id, "subscriber reply"),
      other.messages.send("other-session", "other session send"),
    );
  });
  const id = signMessageTokens([token], () =>
    h.messages.send("task", "intended", [author.pubkey]),
  );
  stop();
  expect(reentrant).toHaveLength(3);
  const queued = [...h.outbox.snapshot(), ...other.outbox.snapshot()];
  const event = (key: string) =>
    queued.find((item) => item.event.id === key)?.event;
  expect(tokens(event(id))).toEqual(messageTokenTags([token]));
  for (const key of reentrant) {
    expect(event(key)).toBeDefined();
    expect(tokens(event(key))).toEqual([]);
  }
  // A publish that throws restores the unsigned state.
  expect(() =>
    signMessageTokens([token], () => {
      throw new Error("refused");
    }),
  ).toThrow("refused");
  const plain = h.messages.send("task", "plain");
  expect(
    tokens(h.outbox.snapshot().find((item) => item.event.id === plain)?.event),
  ).toEqual([]);
});
it("deletes a reply and its channel copy with one target per deletion", async () => {
  const { messages, outbox, send } = linkedSetup();
  await outbox.ready();
  const copy = send();
  const before = outbox.snapshot().length;
  messages.remove([reply.id]);
  expect(
    outbox
      .snapshot()
      .slice(before)
      .map((item) => item.event.tags.filter(([n]) => n !== "client-id")),
  ).toEqual(
    [reply.id, copy.id].map((id) => [
      ["h", "channel"],
      ["e", id],
      ["k", "9"],
    ]),
  );
});
it("still deletes the other copies when one deletion fails, then reports it", async () => {
  const { outbox, copies, send } = linkedSetup();
  await outbox.ready();
  send();
  const events = [root, reply, ...copies];
  const sent: string[] = [];
  const messages = createMessages(
    {
      ...outbox,
      send(input, ...rest) {
        const target = input.tags.find(([n]) => n === "e")?.[1] ?? "";
        if (target === reply.id) throw new Error("storage full");
        sent.push(target);
        return outbox.send(input, ...rest);
      },
    },
    author.pubkey,
    (id) => events.find((event) => event.id === id),
    () => [],
    () => {},
    () => true,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (id) =>
      events.filter((event) =>
        event.tags.some(([n, v]) => n === "buzz:copy-of" && v === id),
      ),
  );
  expect(() => messages.remove([reply.id])).toThrow(
    "Could not delete 1 of 2 linked messages",
  );
  expect(sent).toEqual(copies.map((copy) => copy.id));
});
