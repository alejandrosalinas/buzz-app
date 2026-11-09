import { expect, it } from "vitest";
import {
  addressingOnly,
  hasDraftContent,
  legacyFollowupDraft,
  mentionDraft,
  followupDraft,
} from "./mention-draft";
import { typedDraft } from "./composer-testing";
import { composerMarkdown } from "./composer-markdown";
const first = { pubkey: "a".repeat(64), name: "Honey", start: 0, end: 6 };
const second = { pubkey: "b".repeat(64), name: "Honey", start: 7, end: 13 };
it("punctuation, quotes and inline Markdown delimiters end a mention as the timeline binds it, but an underscore or a mark extends the name", () => {
  for (const text of [
    "**@Honey**",
    "~~@Honey~~",
    "`@Honey`",
    "*@Honey*",
    "@Honey's",
    "@Honey’s",
    '"@Honey"',
    "“@Honey”",
    "(@Honey)",
    "@Honey, @Honey. @Honey! @Honey? @Honey: @Honey;",
    "@Honey-bot",
    "@Honey/ops",
    "@Honey😀",
  ]) {
    const start = text.indexOf("@Honey");
    expect(
      mentionDraft({
        text,
        recipients: [{ ...first, start, end: start + 6 }],
      }).recipients,
      text,
    ).toEqual([{ ...first, start, end: start + 6 }]);
  }
  for (const text of ["_@Honey_", "@Honeys", "@Honey2", "@Honeý"]) {
    const start = text.indexOf("@Honey");
    expect(
      mentionDraft({
        text,
        recipients: [{ ...first, start, end: start + 6 }],
      }).recipients,
      text,
    ).toEqual([]);
  }
});

it("legacy prose and malformed persisted metadata never infer recipients", () => {
  expect(mentionDraft("@Honey").recipients).toEqual([]);
  for (const recipient of [
    { ...first, start: -1 },
    { ...first, pubkey: "invalid" },
    { ...first, end: 4 },
  ]) {
    expect(
      mentionDraft({ text: "@Honey", recipients: [recipient] }).recipients,
    ).toEqual([]);
  }
});

it("followup drafts deduplicate exact keys, preserve namesakes, and enforce draft bounds", () => {
  expect(followupDraft([first, second, first])).toEqual({
    text: "@Honey @Honey ",
    recipients: [first, second],
  });
  const many = Array.from({ length: 33 }, (_, i) => ({
    pubkey: i.toString(16).padStart(64, "0"),
    name: `Agent ${i}`,
  }));
  expect(followupDraft(many).recipients).toHaveLength(32);
  expect(
    followupDraft([{ ...first, name: "x".repeat(15998) }, second]).text,
  ).toHaveLength(16000);
  expect(followupDraft([{ ...first, name: "x".repeat(15999) }])).toEqual({
    text: "",
    recipients: [],
  });
  expect(followupDraft([])).toEqual({ text: "", recipients: [] });
});

it("restores chat cards from drafts saved under the old sessionCards field", () => {
  const link = "[Chat: Fix](buzz://channel/chat-id)";
  expect(mentionDraft({ text: "hi", sessionCards: [link] }).chatCards).toEqual([
    link,
  ]);
  expect(
    mentionDraft({ text: "hi", chatCards: [link], sessionCards: ["x"] })
      .chatCards,
  ).toEqual([link]);
});
it("restores staged GIFs as lone image Markdown, at most ten", () => {
  const gif = (n: number) => `![Party ${n}](https://gif.test/${n}.gif)`;
  expect(
    mentionDraft({
      text: "hi",
      gifs: [gif(1), "prose ![x](https://gif.test/x.gif)", 7, gif(2)],
    }).gifs,
  ).toEqual([gif(1), gif(2)]);
  expect(
    mentionDraft({
      text: "",
      gifs: Array.from({ length: 12 }, (_, n) => gif(n)),
    }).gifs,
  ).toHaveLength(10);
  expect(mentionDraft({ text: "hi", gifs: [gif(1), gif(1)] }).gifs).toEqual([
    gif(1),
  ]);
  expect(mentionDraft({ text: "hi", gifs: [] })).not.toHaveProperty("gifs");
  // A staged GIF is content: a tag-only follow-up with one is not discarded.
  expect(
    legacyFollowupDraft({ ...followupDraft([first]), gifs: [gif(1)] }),
  ).toBe(false);
  expect(addressingOnly({ ...followupDraft([first]), gifs: [gif(1)] })).toBe(
    false,
  );
});
it("sends staged GIFs after the caption, as their own paragraphs", () => {
  expect(
    composerMarkdown({
      text: "look at this",
      recipients: [],
      gifs: ["![A](https://gif.test/a.gif)", "![B](https://gif.test/b.gif)"],
    }),
  ).toBe(
    "look at this\n\n![A](https://gif.test/a.gif)\n\n![B](https://gif.test/b.gif)",
  );
});
it("text, chat cards, GIFs or files are draft content; blank text alone is not", () => {
  const blank = mentionDraft({ text: "  ", recipients: [] });
  expect(hasDraftContent(blank)).toBe(false);
  expect(hasDraftContent({ ...blank, chatCards: ["card"] })).toBe(true);
  expect(hasDraftContent({ ...blank, gifs: ["gif"] })).toBe(true);
  expect(hasDraftContent(blank, 1)).toBe(true);
  // A typed tag is text the person put there; the editor saves it with its
  // snapshot.
  const typed = typedDraft(followupDraft([first]));
  expect(typed).toMatchObject({ text: "@Honey ", recipients: [first] });
  expect(hasDraftContent(typed)).toBe(true);
  expect(
    hasDraftContent(mentionDraft({ text: "@Honey", recipients: [] })),
  ).toBe(true);
  // The follow-up a release through preview.177.1 saved has no snapshot.
  expect(legacyFollowupDraft(followupDraft([first]))).toBe(true);
  expect(hasDraftContent(followupDraft([first]))).toBe(false);
  expect(hasDraftContent(followupDraft([first]), 1)).toBe(true);
  expect(legacyFollowupDraft(typed)).toBe(false);
  expect(
    legacyFollowupDraft(
      mentionDraft({ text: "@Honey hi", recipients: [first] }),
    ),
  ).toBe(false);
});
it("addressingOnly holds for selected tags with no prose or chat card", () => {
  const tags = mentionDraft({
    text: "@Honey @Honey ",
    recipients: [first, second],
  });
  expect(addressingOnly(tags)).toBe(true);
  expect(addressingOnly(followupDraft([first]))).toBe(true);
  expect(addressingOnly(mentionDraft({ text: "  ", recipients: [] }))).toBe(
    false,
  );
  // Typed @Name text without a selected identity is the person's prose.
  expect(addressingOnly(mentionDraft({ text: "@Honey", recipients: [] }))).toBe(
    false,
  );
  expect(
    addressingOnly(
      mentionDraft({ text: "@Honey @Honey hi", recipients: [first, second] }),
    ),
  ).toBe(false);
  expect(addressingOnly({ ...tags, chatCards: ["card"] })).toBe(false);
});
