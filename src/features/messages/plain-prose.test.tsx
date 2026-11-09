// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { fromMarkdown } from "mdast-util-from-markdown";
import remarkGfm from "remark-gfm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type {
  ConversationExtensions,
  InlineRenderer,
} from "../conversation/contracts";
import type { Contribution } from "../../plugins/contributions";
import { normalizeWrappedLinks } from "./message-link-parts";
import { scanMarkdown } from "../relay/message-content";
import {
  isPlainProse,
  plainProseTree,
  prepareMarkdown,
} from "./markdown-preparation";

// MarkdownBody reads the predicate through the module, so the full path can be
// forced; a fresh module instance per path keeps each path's caches apart.
const parser = vi.hoisted(() => ({ full: false }));
vi.mock("./markdown-preparation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./markdown-preparation")>();
  return {
    ...actual,
    isPlainProse: (content: string) =>
      !parser.full && actual.isPlainProse(content),
  };
});

const corpus = [
  "hello",
  "one line, with punctuation. And (parentheses)? Yes; really... 100% sure",
  "first line\nsecond line\nthird line",
  "paragraph one\n\nparagraph two",
  "a\n\n\n\nb\n\n\n\n\nc",
  "  leading spaces\n   on every line",
  "trailing spaces   ",
  "\n\nleading and trailing blank lines\n\n\n",
  "windows\r\nline\r\n\r\nendings\r\n",
  "old mac\rline\r\rendings",
  "mixed\n\r\nendings\r\rhere",
  "Unicode café, naïve, 日本語, Ελληνικά, עברית, العربية",
  "emoji 😀 🎉 👍🏽 👨‍👩‍👧 ❤️ glyphs",
  "😀",
  "\u00a0non-breaking\u00a0spaces\u00a0",
  "numbers 1. in the middle and 2) too, 3 - 4 + 5",
  "a sentence with PLUGIN inside",
  "",
  "   ",
];

const pluginRenderer: Contribution<InlineRenderer> = {
  id: "word",
  key: "test/word",
  pluginId: "test",
  revision: "1",
  title: "Word",
  matches: ({ text }) =>
    [...text.matchAll(/PLUGIN/g)].map((match) => ({
      start: match.index,
      end: match.index + 6,
    })),
  component: ({ text }) => <mark>{text}</mark>,
};
const extensions: ConversationExtensions = {
  tools: { snapshot: () => [], subscribe: () => () => {} },
  inline: { snapshot: () => [pluginRenderer], subscribe: () => () => {} },
};
const variants = [
  {},
  { largeEmoji: true },
  { edited: true },
  { interactive: false },
  { extensions },
];

async function renderAll(full: boolean) {
  parser.full = full;
  vi.resetModules();
  const { MessageMarkdown } = await import("./MessageMarkdown");
  return corpus.flatMap((content) =>
    variants.map((options) => {
      const props: ComponentProps<typeof MessageMarkdown> = {
        row: {
          id: "message",
          channelId: "channel",
          authorId: "author",
          content,
          createdAt: 1,
          mentions: [],
          participants: [],
          attachments: [],
          reactions: [],
          replyCount: 0,
        },
        media: () => undefined,
        onOpenLink: () => false,
        ...options,
      };
      return {
        label: `${JSON.stringify(content)} ${Object.keys(options)}`,
        html: renderToStaticMarkup(<MessageMarkdown {...props} />),
      };
    }),
  );
}

// The parse MarkdownBody runs: micromark with remark-gfm's extensions.
const gfm: Record<string, never[]> = {};
remarkGfm.call({ data: () => gfm } as never);
const gfmTree = (content: string) =>
  fromMarkdown(content, {
    extensions: gfm.micromarkExtensions,
    mdastExtensions: gfm.fromMarkdownExtensions,
  });

const withoutPositions = (node: object): unknown => {
  const {
    position: _position,
    children,
    ...rest
  } = node as Record<string, unknown>;
  return Array.isArray(children)
    ? { ...rest, children: children.map(withoutPositions) }
    : rest;
};

afterEach(() => {
  parser.full = false;
});

describe("plain prose fast path", () => {
  it("qualifies the whole corpus", () => {
    for (const content of corpus)
      expect(isPlainProse(content), content).toBe(true);
  });

  it("builds micromark's tree and prepares nothing literal", () => {
    for (const content of corpus) {
      const tree = gfmTree(content);
      expect(plainProseTree(content), JSON.stringify(content)).toEqual(
        withoutPositions(tree),
      );
      // The full preparation's inputs: no literal or deep nodes, no wrapped
      // links and no spoiler pipes, so it equals the fast result.
      const scan = scanMarkdown(content);
      expect(scan.tooDeep).toBe(false);
      expect(scan.links).toEqual([]);
      expect(scan.images).toEqual([]);
      expect(normalizeWrappedLinks(content, () => false)).toBe(content);
      expect(prepareMarkdown(content)).toEqual({
        kind: "markdown",
        content,
        literalRanges: [],
        spoilerDelimiters: [],
      });
    }
  });

  it("renders the same HTML as the full Markdown path", async () => {
    const fast = await renderAll(false);
    const full = await renderAll(true);
    expect(fast.length).toBe(corpus.length * variants.length);
    for (const [index, { label, html }] of fast.entries())
      expect(html, label).toBe(full[index]?.html);
  });

  it("builds micromark's tree for random prose it accepts", () => {
    expect(gfm.micromarkExtensions).toHaveLength(1);
    expect(gfm.fromMarkdownExtensions).toHaveLength(1);
    const atoms = [
      "a",
      "hello",
      "1",
      "12",
      ".",
      ")",
      "-",
      "+",
      " ",
      "    ",
      "\n",
      "\n\n",
      "\r",
      "\r\n",
      "\t",
      "\u00a0",
      "\u3000",
      "\u200d",
      "\ufeff",
      "\u0085",
      "😀",
      "日本",
      "www",
      "http",
      "a.com",
      "1.",
      "- ",
    ];
    let seed = 1;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let index = 0; index < 5000; index++) {
      let content = "";
      for (let count = 1 + Math.floor(random() * 8); count > 0; count--)
        content += atoms[Math.floor(random() * atoms.length)];
      if (isPlainProse(content))
        expect(plainProseTree(content), JSON.stringify(content)).toEqual(
          withoutPositions(gfmTree(content)),
        );
    }
  });

  it("builds the tree of a long space run in linear time", () => {
    // A per-position tail match took seconds here; the linear trim takes ~1 ms.
    const content = `a${" ".repeat(99_998)}b`;
    const start = performance.now();
    expect(plainProseTree(content).children).toHaveLength(1);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("sends bodies with syntax, links, mentions or markers to the full path", () => {
    for (const content of [
      "*em*",
      "_em_",
      "`code`",
      "~~del~~",
      "[label](x)",
      "<b>",
      "> quote",
      "a | b",
      "# heading",
      "back\\slash",
      "&amp;",
      "!image",
      "setext\n===",
      "- item",
      "+ item",
      "1. item",
      "2) item",
      "    indented code",
      "tab\there",
      "hard  \nbreak",
      "soft \nspace",
      ":party_parrot:",
      "https://example.test",
      "see www.example.test",
      "@Alice",
      "a ||spoiler|| b",
      "private \ue000 use",
      "object \ufffc replacement",
      "\ufeff    byte order mark",
      "line\u2028separator",
      "bell \u0007",
    ])
      expect(isPlainProse(content), JSON.stringify(content)).toBe(false);
  });
});
