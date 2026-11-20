import { describe, expect, it } from "vitest";
import { restoreChatLinks, stageChatCards } from "./composer-chat-cards";
import { mentionDraft } from "./mention-draft";
import { composerMarkdown } from "./composer-markdown";

const link = "[Session: Fix](buzz://channel/session-id)";
describe("staged session references", () => {
  it.each([link, `**${link}**`])(
    "removes card-only formatting wrappers: %s",
    (text) => {
      const draft = stageChatCards(mentionDraft(text), []);
      expect(draft.text.trim()).toBe("");
      expect(draft.chatCards).toEqual([link]);
      expect(composerMarkdown(draft).trim()).toBe(link);
      expect(mentionDraft(JSON.parse(JSON.stringify(draft))).chatCards).toEqual(
        [link],
      );
    },
  );
  it("preserves a boundary between caption fragments", () => {
    expect(stageChatCards(mentionDraft(`before${link}after`), []).text).toBe(
      "before after",
    );
  });
  it.each([`\`${link}\``, `> ${link}`, `||${link}||`])(
    "keeps literal and hidden references in prose: %s",
    (text) => {
      const draft = stageChatCards(mentionDraft(text), []);
      expect(draft.text).toBe(text);
      expect(draft.chatCards).toBeUndefined();
    },
  );
});

it("retains explicit recipients in a legacy draft on either side of a staged card", () => {
  const text = `@Honey ${link} @Basil`;
  const recipients = [
    { pubkey: "a".repeat(64), name: "Honey", start: 0, end: 6 },
    {
      pubkey: "b".repeat(64),
      name: "Basil",
      start: text.indexOf("@Basil"),
      end: text.length,
    },
  ];
  const staged = stageChatCards(mentionDraft({ text, recipients }), []);
  expect(staged.chatCards).toEqual([link]);
  expect(staged.recipients).toEqual([
    recipients[0],
    {
      ...recipients[1],
      start: staged.text.indexOf("@Basil"),
      end: staged.text.length,
    },
  ]);
});

it.each(["blockquote", "bullet_list", "ordered_list", "spoiler"])(
  "preserves a chat reference inside rich %s formatting",
  (format) => {
    const text = {
      type: "text",
      text: link,
      ...(format === "spoiler" ? { marks: [{ type: "spoiler" }] } : {}),
    };
    const paragraph = { type: "paragraph", content: [text] };
    const protectedBlock =
      format === "blockquote"
        ? { type: format, content: [paragraph] }
        : format.endsWith("_list")
          ? {
              type: format,
              content: [{ type: "list_item", content: [paragraph] }],
            }
          : paragraph;
    const draft = mentionDraft({
      document: {
        version: 1,
        content: {
          type: "doc",
          content: [
            protectedBlock,
            { type: "paragraph", content: [{ type: "text", text: link }] },
          ],
        },
      },
    });
    const before = composerMarkdown(draft);
    const staged = stageChatCards(draft, []);
    expect(staged.chatCards).toEqual([link]);
    expect(composerMarkdown({ ...staged, chatCards: [] }).trim()).toBe(
      before.slice(0, before.lastIndexOf(link)).trim(),
    );
    expect(staged.document?.content).toMatchObject({
      content: [protectedBlock, { type: "paragraph" }],
    });
  },
);

it("keeps a partially spoiler-marked label hidden instead of staging a masked card", () => {
  const paragraph = {
    type: "paragraph",
    content: [
      { type: "text", text: "[Session: " },
      { type: "text", text: "Secret name", marks: [{ type: "spoiler" }] },
      { type: "text", text: "](buzz://channel/session-id)" },
    ],
  };
  const draft = mentionDraft({
    document: { version: 1, content: { type: "doc", content: [paragraph] } },
  });
  const staged = stageChatCards(draft, []);
  expect(staged).toBe(draft);
  expect(staged.chatCards).toBeUndefined();
  expect(composerMarkdown(staged)).toBe(composerMarkdown(draft));
});

it.each([
  '[Session: Fix](buzz://channel/session-id "title")',
  "[Session: Fix](<buzz://channel/session-id>)",
  "[Session: Fix](BUZZ://channel/session-id)",
])("restores every admitted card after serialization: %s", (text) => {
  expect(
    mentionDraft({ text: "Caption", recipients: [], chatCards: [text] })
      .chatCards,
  ).toEqual([link]);
  const staged = stageChatCards(mentionDraft(`${text}\n\nCaption`), []);
  expect(staged.chatCards).toEqual([link]);
  const restored = mentionDraft(JSON.parse(JSON.stringify(staged)));
  expect(restored.chatCards).toEqual([link]);
  expect(composerMarkdown(restored)).toBe(composerMarkdown(staged));
  expect(restored.text.trim()).toBe("Caption");
});

it("preserves literal label punctuation across repeated card restoration", () => {
  const name = "PR *45* _fix_ `code` &amp; <fix> [a] \\ ok";
  const escaped = name.replace(/[\\`[\]*_~<>&|]/g, "\\$&");
  const card = `[Session: ${escaped}](buzz://channel/session-id)`;
  let draft = stageChatCards(mentionDraft(card), []);
  for (let i = 0; i < 3; i++) {
    draft = mentionDraft(JSON.parse(JSON.stringify(draft)));
    expect(draft.chatCards).toEqual([card]);
  }
});

it("stages new Chat labels and legacy Session labels with identical source identity", () => {
  for (const label of ["Chat: Fix", "Session: Fix", "Session · Fix"]) {
    const link = `[${label}](buzz://channel/session-id)`;
    expect(stageChatCards(mentionDraft(link), []).chatCards).toEqual([link]);
  }
});

it.each([
  {
    version: 1,
    origin: "example.org",
    channelId: "source",
    id: "b".repeat(64),
  },
  null,
])(
  "restores legacy chat attachments and preserves forward state %j",
  (forward) => {
    const gif = "![wave](https://example.org/wave.gif)";
    const caption = mentionDraft({
      text: "@Honey please review",
      recipients: [{ pubkey: "a".repeat(64), name: "Honey", start: 0, end: 6 }],
      chatCards: [link],
      gifs: [gif],
      forward,
    });
    const restored = restoreChatLinks(caption);
    expect(restored.chatCards).toBeUndefined();
    expect(restored.forward).toEqual(forward);
    expect(restored.text).toBe(`${link}\n\n@Honey please review`);
    expect(restored.recipients).toEqual([
      {
        pubkey: "a".repeat(64),
        name: "Honey",
        start: link.length + 2,
        end: link.length + 8,
      },
    ]);
    expect(composerMarkdown(restored)).toBe(
      `${link}\n\n@Honey please review\n\n${gif}`,
    );
    expect(restoreChatLinks(restored)).toBe(restored);
    expect(
      composerMarkdown(mentionDraft(JSON.parse(JSON.stringify(restored)))),
    ).toBe(composerMarkdown(restored));
  },
);
