import type { Profile } from "./contracts";
import { assert, expect, it, vi } from "vitest";
import { createMessages } from "./messages";
import { createOutbox } from "./outbox";
import { foldMessages } from "./fold";
import { eventDto, type EventData, type RelayEvent } from "./events";
import { keypair, message, signed } from "./testing";
import { forwardBody, forwardTag, readForward } from "./forwarded-message";

const author = keypair();
const forwarder = keypair();
const recipient = keypair();
const original = eventDto(
  message(author, "private-source", "Read **this**", 100, [
    ["p", recipient.pubkey],
    ["mention", recipient.pubkey],
    ["imeta", "url https://example.org/photo.png", "m image/png"],
  ]),
);
function setup(
  events: EventData[] = [original],
  allowed = true,
  profiles: ReadonlyMap<string, Profile> = new Map(),
) {
  const writer = {
    kinds: [9],
    sign: vi.fn(async (event) => signed(forwarder, event)),
    publish: vi.fn(async (_event: RelayEvent) => {}),
  };
  const { outbox } = createOutbox(forwarder.pubkey, writer, {
    load: () => [],
    save: () => {},
  });
  const messages = createMessages(
    outbox,
    forwarder.pubkey,
    (id) => events.find((event) => event.id === id),
    () => [],
    () => {},
    () => allowed,
    "https://relay.example",
    undefined,
    undefined,
    {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
  );
  const row = foldMessages(
    events[0]?.tags.find(([name]) => name === "h")?.[1] ?? "private-source",
    forwarder.pubkey,
    events,
  )[0];
  assert.exists(row);
  return { messages, row, outbox, writer };
}
it("publishes a standalone destination snapshot with attachment refs and no copied notifications", async () => {
  const { messages, row, outbox, writer } = setup();
  await outbox.ready();
  messages.forward("destination", row, "Original Author", "Please read");
  await vi.waitFor(() => expect(writer.publish).toHaveBeenCalledOnce());
  const event = eventDto(writer.publish.mock.calls[0]?.[0]);
  expect(event.pubkey).toBe(forwarder.pubkey);
  expect(event.tags).toContainEqual(["h", "destination"]);
  expect(event.tags).toContainEqual(original.tags[3]);
  expect(event.tags.some(([name]) => name === "p" || name === "mention")).toBe(
    false,
  );
  // The recipient has only the destination event, never the source.
  const received = foldMessages("destination", recipient.pubkey, [event])[0];
  expect(received?.forward?.snapshot).toMatchObject({
    authorId: author.pubkey,
    authorName: "Original Author",
    content: "Read **this**",
    createdAt: 100,
  });
  expect(received?.forward?.note).toBe("Please read");
  expect(received?.attachments).toHaveLength(1);
  expect(received?.content).toContain("> Read **this**");
  expect(received?.mentions).toEqual([]);
});
it("copies current edits and attachments and flattens a subsequent forward", async () => {
  const edit = eventDto(
    signed(author, {
      kind: 40003,
      created_at: 101,
      content: "Updated",
      tags: [
        ["h", "private-source"],
        ["e", original.id],
        ["imeta", "url https://example.org/new.png", "m image/png"],
      ],
    }),
  );
  const { messages, row, outbox, writer } = setup([original, edit]);
  await outbox.ready();
  messages.forward("destination", row, "Original Author", "");
  await vi.waitFor(() => expect(writer.publish).toHaveBeenCalledOnce());
  const first = eventDto(writer.publish.mock.calls[0]?.[0]);
  expect(first.tags).toContainEqual(edit.tags[2]);
  expect(first.tags).not.toContainEqual(original.tags[3]);
  const received = foldMessages("destination", recipient.pubkey, [first])[0];
  assert.exists(received);
  const next = setup([first]);
  await next.outbox.ready();
  next.messages.forward("third", received, "Forwarder", "Second note");
  await vi.waitFor(() => expect(next.writer.publish).toHaveBeenCalledOnce());
  const second = next.writer.publish.mock.calls[0]?.[0];
  assert.exists(second);
  expect(readForward(second)?.snapshot).toEqual(readForward(first)?.snapshot);
  expect(readForward(second)?.snapshot.content).toBe("Updated");
  expect(second.tags.filter(([name]) => name === "buzz:forward")).toHaveLength(
    1,
  );
});
it("rejects unavailable evidence, denied destinations, and oversized payloads without publishing", () => {
  const { messages, row, outbox } = setup();
  expect(() =>
    messages.forward(
      "destination",
      { ...row, attachmentSourceId: "missing" },
      "Author",
      "",
    ),
  ).toThrow(/Reload/);
  expect(() =>
    messages.forward(
      "destination",
      { ...row, content: "界".repeat(12000) },
      "Author",
      "",
    ),
  ).toThrow("This message is too long to forward. Copy its link instead.");
  expect(() =>
    setup([original], false).messages.forward("destination", row, "Author", ""),
  ).toThrow(/write access/);
  expect(() =>
    setup([{ ...original }]).messages.forward("destination", row, "Author", ""),
  ).toThrow(/Reload/);
  expect(outbox.snapshot()).toEqual([]);
});
it("falls back to ordinary content for mismatched, unsupported or malformed metadata", () => {
  const snapshot = {
    id: original.id,
    channelId: "private-source",
    authorId: author.pubkey,
    authorName: "Author",
    createdAt: 100,
    content: "Text",
  };
  const event = {
    kind: 9,
    tags: [forwardTag(snapshot)],
    content: forwardBody(snapshot, "Note"),
  };
  expect(readForward(event)?.snapshot).toEqual(snapshot);
  for (const changed of [
    { ...event, content: "Tampered body" },
    { ...event, tags: [["buzz:forward", "2", JSON.stringify(snapshot)]] },
    { ...event, tags: [forwardTag(snapshot), forwardTag(snapshot)] },
    { ...event, tags: [["buzz:forward", "1", "{"]] },
    { ...event, tags: [forwardTag({ ...snapshot, createdAt: -1 })] },
  ])
    expect(readForward(changed)).toBeUndefined();
});

it.each(["diagram.png", "diagram.svg", "image?id=123"])(
  "preserves Markdown-only media %s as destination attachment references",
  async (file) => {
    const source = eventDto(
      message(
        author,
        "private-source",
        `See diagram\n\n![diagram](https://example.org/${file})`,
        100,
      ),
    );
    const { messages, row, outbox, writer } = setup([source]);
    expect(row.attachments).toHaveLength(1);
    await outbox.ready();
    messages.forward("destination", row, "Author", "");
    await vi.waitFor(() => expect(writer.publish).toHaveBeenCalledOnce());
    const forwarded = eventDto(writer.publish.mock.calls[0]?.[0]);
    const received = foldMessages("destination", recipient.pubkey, [
      forwarded,
    ])[0];
    expect(received?.attachments).toMatchObject([
      { url: `https://example.org/${file}`, kind: "image" },
    ]);
    expect(received?.forward?.snapshot.content).toContain(
      `![diagram](https://example.org/${file})`,
    );
    // External Markdown media must not be promoted to relay-local upload tags.
    expect(forwarded.tags.some(([name]) => name === "imeta")).toBe(false);
  },
);

it("refuses local Markdown media without an admitted upload reference instead of sending broken images", () => {
  const source = eventDto(
    message(
      author,
      "private-source",
      `![photo](https://relay.example/media/${"a".repeat(64)}.png)`,
      100,
    ),
  );
  const { messages, row, outbox } = setup([source]);
  expect(() => messages.forward("destination", row, "Author", "")).toThrow(
    "This message contains an attachment that can’t be forwarded. Copy its link instead.",
  );
  expect(outbox.snapshot()).toEqual([]);
});

it("retains admitted root-relative media metadata without rejecting its absolute Markdown image", async () => {
  const hash = "a".repeat(64);
  const tags = [
    ["imeta", `url /media/${hash}.png`, "m image/png", `x ${hash}`, "size 123"],
  ];
  const source = eventDto(
    message(
      author,
      "private-source",
      `![photo](https://relay.example/media/${hash}.png)`,
      100,
      tags,
    ),
  );
  const { messages, row, outbox, writer } = setup([source]);
  await outbox.ready();
  messages.forward("destination", row, "Author", "");
  await vi.waitFor(() => expect(writer.publish).toHaveBeenCalledOnce());
  const sent = writer.publish.mock.calls[0]?.[0];
  expect(sent?.tags).toContainEqual(tags[0]);
});

it("freezes mention labels and emoji for a recipient and a second forward without notifying copied identities", async () => {
  const source = eventDto(
    message(
      author,
      "private-source",
      `@A*B* (${recipient.pubkey}) :wave:`,
      100,
      [
        ["p", recipient.pubkey],
        ["emoji", "wave", "https://example.org/wave.png"],
      ],
    ),
  );
  const first = setup(
    [source],
    true,
    new Map([[recipient.pubkey, { name: "A*B*" }]]),
  );
  await first.outbox.ready();
  first.messages.forward("destination", first.row, "Author", "");
  await vi.waitFor(() => expect(first.writer.publish).toHaveBeenCalledOnce());
  const event = eventDto(first.writer.publish.mock.calls[0]?.[0]);
  const received = foldMessages("destination", recipient.pubkey, [event])[0];
  assert.exists(received);
  expect(received.forward?.snapshot.mentionLabels).toEqual([
    { id: recipient.pubkey, names: ["A*B*"] },
  ]);
  expect(received.forward?.snapshot.emoji).toEqual([
    { shortcode: "wave", url: "https://example.org/wave.png" },
  ]);
  expect(event.tags.some(([tag]) => tag === "p" || tag === "mention")).toBe(
    false,
  );
  const second = setup([event]);
  await second.outbox.ready();
  second.messages.forward("third", received, "Forwarder", "");
  await vi.waitFor(() => expect(second.writer.publish).toHaveBeenCalledOnce());
  const forwardedAgain = second.writer.publish.mock.calls[0]?.[0];
  assert.exists(forwardedAgain);
  expect(readForward(forwardedAgain)?.snapshot).toEqual(
    received.forward?.snapshot,
  );
});
it("preflights inaccessible local emoji and oversized content without publishing", () => {
  const source = eventDto(
    message(author, "private-source", ":wave:", 100, [
      ["emoji", "wave", `https://relay.example/media/${"a".repeat(64)}.png`],
    ]),
  );
  const { messages, row, outbox } = setup([source]);
  expect(messages.forwardProblem("destination", row, "Author", "")).toMatch(
    /attachment/,
  );
  expect(
    messages.forwardProblem(
      "destination",
      { ...row, emoji: [], content: "界".repeat(12000) },
      "Author",
      "",
    ),
  ).toMatch(/too long/);
  expect(outbox.snapshot()).toEqual([]);
});

it("omits automatic recipients and unused profile aliases from destination metadata", async () => {
  const hidden = keypair();
  const source = eventDto(
    message(author, "private-source", "Hello @Visible", 100, [
      ["p", hidden.pubkey],
      ["p", recipient.pubkey],
    ]),
  );
  const h = setup(
    [source],
    true,
    new Map([
      [hidden.pubkey, { name: "Secret DM Partner" }],
      [
        recipient.pubkey,
        {
          name: "Visible",
          verified: { displayName: "Hidden Alias", fullName: "Another Alias" },
        } as Profile,
      ],
    ]),
  );
  await h.outbox.ready();
  h.messages.forward("destination", h.row, "Author", "");
  await vi.waitFor(() => expect(h.writer.publish).toHaveBeenCalledOnce());
  const event = h.writer.publish.mock.calls[0]?.[0];
  assert.exists(event);
  expect(JSON.stringify(event)).not.toContain(hidden.pubkey);
  expect(JSON.stringify(event)).not.toContain("Secret DM Partner");
  expect(JSON.stringify(event)).not.toContain("Hidden Alias");
  expect(readForward(event)?.snapshot.mentionLabels).toEqual([
    { id: recipient.pubkey, names: ["Visible"] },
  ]);
});

it("keeps sender uploads outside snapshot ownership and drops them when flattening", async () => {
  const h = setup();
  await h.outbox.ready();
  const hash = "b".repeat(64);
  const upload = {
    name: "ForwardersEvidence.png",
    url: `https://relay.example/media/${hash}.png`,
    type: "image/png",
    size: 10,
    sha256: hash,
  };
  h.messages.forward("destination", h.row, "Author", "My evidence", undefined, {
    attachments: [upload],
  });
  await vi.waitFor(() => expect(h.writer.publish).toHaveBeenCalledOnce());
  const event = eventDto(h.writer.publish.mock.calls[0]?.[0]);
  const received = setup([event]);
  expect(received.row.attachments.map(({ url }) => url)).toContain(upload.url);
  expect(received.row.forward?.snapshot.attachmentUrls).toEqual([
    "https://example.org/photo.png",
  ]);
  expect(received.row.forward?.note).toContain("ForwardersEvidence.png");
  await received.outbox.ready();
  received.messages.forward("third", received.row, "Forwarder", "Again");
  await vi.waitFor(() =>
    expect(received.writer.publish).toHaveBeenCalledOnce(),
  );
  const second = received.writer.publish.mock.calls[0]?.[0];
  assert.exists(second);
  expect(JSON.stringify(second)).not.toContain(upload.url);
  expect(second.tags).toContainEqual([
    "imeta",
    "url https://example.org/photo.png",
    "m image/png",
  ]);
});

it.each([
  ["comment", "<!-- @Secret -->", false],
  ["definition title", '[ref]: https://example.org "@Secret"', false],
  ["inline code", "`@Secret`", false],
  ["fenced code", "```text\n@Secret\n```", false],
  ["link text", "[@Secret](https://example.org)", false],
  ["link URL", "[link](https://example.org/@Secret)", false],
  ["reference link", "[@Secret][ref]\n\n[ref]: https://example.org", false],
  ["bare URL", "https://example.org/@Secret", false],
  ["visible prose", "Hello @Secret", true],
  ["visible emphasis", "**@Secret**", true],
] as const)(
  "copies only rendered bindings through first and legacy re-forward: %s",
  async (_name, body, visible) => {
    const hidden = keypair();
    const content = "Hello @Visible\n\n" + body;
    const labels = [
      { id: recipient.pubkey, names: ["Visible"] },
      { id: hidden.pubkey, names: ["Secret"] },
    ];
    const expected = visible ? labels : labels.slice(0, 1);
    const source = eventDto(
      message(author, "private-source", content, 100, [
        ["p", recipient.pubkey],
        ["p", hidden.pubkey],
      ]),
    );
    const first = setup(
      [source],
      true,
      new Map([
        [recipient.pubkey, { name: "Visible" }],
        [hidden.pubkey, { name: "Secret" }],
      ]),
    );
    await first.outbox.ready();
    first.messages.forward("destination", first.row, "Author", "");
    await vi.waitFor(() => expect(first.writer.publish).toHaveBeenCalledOnce());
    const sent = first.writer.publish.mock.calls[0]?.[0];
    assert.exists(sent);
    const snapshot = readForward(sent)?.snapshot;
    assert.exists(snapshot);
    expect(snapshot.mentionLabels).toEqual(expected);
    // Older copies can already carry the hidden bindings. Re-forwarding must
    // sanitize those labels too, without needing a source profile directory.
    const legacy = { ...snapshot, mentionLabels: labels };
    const event = eventDto(
      message(forwarder, "destination", forwardBody(legacy, ""), 101, [
        forwardTag(legacy),
      ]),
    );
    const second = setup([event]);
    await second.outbox.ready();
    second.messages.forward("third", second.row, "Forwarder", "");
    await vi.waitFor(() =>
      expect(second.writer.publish).toHaveBeenCalledOnce(),
    );
    const resent = second.writer.publish.mock.calls[0]?.[0];
    assert.exists(resent);
    expect(readForward(resent)?.snapshot.mentionLabels).toEqual(expected);
    expect(resent.tags.some(([tag]) => tag === "p" || tag === "mention")).toBe(
      false,
    );
  },
);
