import { describe, expect, it } from "vitest";
import {
  composerSchema as schema,
  projectComposerDocument,
  readComposerDocument,
  readComposerSnapshot,
} from "./composer-document";
import { composerMarkdown } from "./composer-markdown";
import { profileMentionParts } from "./profile-mentions";
import { profileTarget } from "../profiles/target";
import { mentionDraft } from "./mention-draft";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import type { Nodes, RootContent } from "mdast";
import type { InlineFormat } from "./composer-dom";

const paragraph = (...children: ReturnType<typeof schema.text>[]) =>
  schema.nodes.paragraph.create(null, children);
const bold = (text: string) => schema.text(text, [schema.marks.bold.create()]);
const doc = (...blocks: ReturnType<typeof paragraph>[]) =>
  schema.nodes.doc.create(null, blocks);
const serialize = (...children: ReturnType<typeof schema.text>[]) =>
  composerMarkdown(projectComposerDocument(doc(paragraph(...children))).draft);

describe("composer document boundary", () => {
  it("keeps document snapshot bounds and cached decoding separate from chat", () => {
    const original = doc(paragraph(bold("x".repeat(16001))));
    const snapshot = projectComposerDocument(original).draft.document;
    expect(readComposerSnapshot(snapshot)).toBeUndefined();
    expect(readComposerSnapshot(snapshot, "document")?.eq(original)).toBe(true);
    expect(readComposerSnapshot(snapshot)).toBeUndefined();
    const oversized = projectComposerDocument(
      doc(paragraph(bold("x".repeat(100001)))),
    ).draft.document;
    expect(readComposerSnapshot(oversized, "document")).toBeUndefined();
  });
  it("preserves distinct block and hard-break structures through persisted drafts", () => {
    const blocks = doc(paragraph(bold("a")), paragraph(schema.text("b")));
    const inline = doc(
      paragraph(bold("a"), schema.nodes.hard_break.create(), schema.text("b")),
    );
    expect(projectComposerDocument(blocks).draft.text).toBe("a\nb");
    expect(projectComposerDocument(inline).draft.text).toBe("a\nb");
    for (const original of [blocks, inline]) {
      const draft = mentionDraft(
        JSON.parse(JSON.stringify(projectComposerDocument(original).draft)),
      );
      expect(readComposerDocument(draft, []).eq(original)).toBe(true);
      expect(composerMarkdown(draft)).toBe("**a**\nb");
    }
  });
  it("uses document text as authoritative and rejects malformed snapshots", () => {
    const original = doc(paragraph(bold("saved")));
    expect(
      mentionDraft({
        ...projectComposerDocument(original).draft,
        text: "stale",
      }).text,
    ).toBe("saved");
    for (const content of [
      { type: "unknown" },
      { type: "doc", content: [{ type: "text", text: "bad block" }] },
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "token", attrs: { source: 5 } }],
          },
        ],
      },
      {
        type: "doc",
        content: [
          {
            type: "code_block",
            attrs: { language: { corrupt: true } },
            content: [{ type: "text", text: "x" }],
          },
        ],
      },
    ]) {
      expect(readComposerSnapshot({ version: 1, content })).toBeUndefined();
    }
    for (const language of ["ts", null])
      expect(
        readComposerSnapshot({
          version: 1,
          content: {
            type: "doc",
            content: [
              {
                type: "code_block",
                attrs: { language },
                content: [{ type: "text", text: "x" }],
              },
            ],
          },
        })?.firstChild?.attrs.language,
      ).toBe(language);
    expect(mentionDraft("legacy __bold__")).toEqual({
      text: "legacy __bold__",
      recipients: [],
    });
  });
  it("round-trips every editable boundary across paragraphs and atomic tokens", () => {
    const original = doc(
      paragraph(schema.text("one")),
      paragraph(
        schema.text("two "),
        schema.nodes.token.create({
          source: "@Honey",
          recipient: { pubkey: "a".repeat(64), name: "Honey" },
        }),
        schema.text("!"),
      ),
    );
    const source = projectComposerDocument(original);
    expect(source.draft.text).toBe("one\ntwo @Honey!");
    for (const offset of [0, 1, 2, 3, 4, 5, 6, 7, 8, 14, 15])
      expect(source.source(source.position(offset)), String(offset)).toBe(
        offset,
      );
    expect(source.draft.recipients).toEqual([
      { pubkey: "a".repeat(64), name: "Honey", start: 8, end: 14 },
    ]);
  });
  it("validates saved provenance rather than inferring a mention from text", () => {
    const token = schema.nodes.token.create({
      source: "@Honey",
      recipient: { pubkey: "invalid", name: "Honey" },
    });
    const draft = mentionDraft(
      projectComposerDocument(doc(paragraph(token))).draft,
    );
    expect(draft.recipients).toEqual([]);
    expect(
      projectComposerDocument(readComposerDocument(draft, [])).draft.recipients,
    ).toEqual([]);
  });
});

describe("composer Markdown boundary", () => {
  it("retains raw source and surrounding whitespace byte-for-byte", () => {
    for (const text of [
      "__bold__ and **bold**",
      "  before\n\n```js\n`literal` *\n```\n",
      "- one\n  - two",
      "> quote\n> line",
      "[**label**](https://example.com)",
      "~~strike~~ ||spoiler||",
    ]) {
      expect(composerMarkdown(mentionDraft(text))).toBe(text);
    }
    expect(serialize(bold("one more "), schema.text("plain"))).toBe(
      "**one more** plain",
    );
  });
  it("alternates adjacent list markers and caps continuation numbers at nine digits", () => {
    const item = (text: string) =>
      schema.nodes.list_item.create(null, paragraph(schema.text(text)));
    const bullets = (...texts: string[]) =>
      schema.nodes.bullet_list.create(null, texts.map(item));
    const numbers = (order: number, ...texts: string[]) =>
      schema.nodes.ordered_list.create({ order }, texts.map(item));
    const markdown = (...blocks: ReturnType<typeof paragraph>[]) =>
      composerMarkdown(projectComposerDocument(doc(...blocks)).draft);
    const cases: [string, string[]][] = [
      [
        markdown(
          bullets("a"),
          bullets("b"),
          bullets("c"),
          paragraph(schema.text("text")),
          bullets("d"),
        ),
        ["list", "list", "list", "paragraph", "list"],
      ],
      [
        markdown(numbers(3, "third"), numbers(1, "one", "two"), bullets("x")),
        ["list", "list", "list"],
      ],
      [
        markdown(
          schema.nodes.blockquote.create(null, [bullets("a"), bullets("b")]),
        ),
        ["blockquote"],
      ],
      [markdown(numbers(999999999, "item", "next")), ["list"]],
      // An empty paragraph serialises to nothing, so the wire holds only blank
      // lines between the lists and the marker must still alternate.
      [markdown(bullets("a"), paragraph(), bullets("b")), ["list", "list"]],
      [
        markdown(numbers(1, "a"), paragraph(), numbers(1, "b")),
        ["list", "list"],
      ],
      // The parity carries across the empty paragraph as the list kind does,
      // so a third list separated the same way takes the first marker again
      // rather than repeating the second and merging with it.
      [
        markdown(
          bullets("a"),
          paragraph(),
          bullets("b"),
          paragraph(),
          paragraph(),
          bullets("c"),
        ),
        ["list", "list", "list"],
      ],
      [
        markdown(
          numbers(1, "a"),
          paragraph(),
          numbers(1, "b"),
          paragraph(),
          numbers(1, "c"),
        ),
        ["list", "list", "list"],
      ],
      [
        markdown(bullets("a"), paragraph(schema.text("text")), bullets("b")),
        ["list", "paragraph", "list"],
      ],
      [
        markdown(
          bullets("a"),
          schema.nodes.code_block.create(null, schema.text("code")),
          bullets("b"),
        ),
        ["list", "code", "list"],
      ],
      [
        markdown(
          bullets("a"),
          schema.nodes.blockquote.create(null, paragraph(schema.text("q"))),
          bullets("b"),
        ),
        ["list", "blockquote", "list"],
      ],
      [
        markdown(bullets("a"), numbers(1, "b"), bullets("c")),
        ["list", "list", "list"],
      ],
    ];
    expect(cases.map(([text]) => text)).toEqual([
      "- a\n\n* b\n\n- c\n\ntext\n\n- d",
      "3. third\n\n1) one\n2) two\n\n- x",
      "> - a\n>\n> * b",
      "999999999. item\n999999999. next",
      "- a\n\n\n\n* b",
      "1. a\n\n\n\n1) b",
      "- a\n\n\n\n* b\n\n\n\n\n- c",
      "1. a\n\n\n\n1) b\n\n\n\n1. c",
      "- a\n\ntext\n\n- b",
      "- a\n\n```\ncode\n```\n\n- b",
      "- a\n\n> q\n\n- b",
      "- a\n\n1. b\n\n- c",
    ]);
    for (const [text, types] of cases)
      expect(fromMarkdown(text).children.map((node) => node.type)).toEqual(
        types,
      );
    expect(fromMarkdown(cases[1]?.[0] ?? "").children).toMatchObject([
      { type: "list", start: 3 },
      { type: "list", start: 1, children: [{}, {}] },
      { type: "list", ordered: false },
    ]);
    expect(fromMarkdown(cases[2]?.[0] ?? "").children[0]).toMatchObject({
      type: "blockquote",
      children: [{ type: "list" }, { type: "list" }],
    });
    expect(fromMarkdown(cases[3]?.[0] ?? "").children[0]).toMatchObject({
      type: "list",
      start: 999999999,
      children: [{}, {}],
    });
    expect(fromMarkdown(cases[4]?.[0] ?? "").children).toMatchObject([
      { type: "list", ordered: false, children: [{}] },
      { type: "list", ordered: false, children: [{}] },
    ]);
    expect(fromMarkdown(cases[5]?.[0] ?? "").children).toMatchObject([
      { type: "list", ordered: true, start: 1, children: [{}] },
      { type: "list", ordered: true, start: 1, children: [{}] },
    ]);
    for (const index of [6, 7])
      expect(fromMarkdown(cases[index]?.[0] ?? "").children).toMatchObject([
        { type: "list", children: [{}] },
        { type: "list", children: [{}] },
        { type: "list", children: [{}] },
      ]);
  });
  it("writes intraword emphasis with asterisks so the source stays readable", () => {
    const italic = (text: string) =>
      schema.text(text, [schema.marks.italic.create()]);
    const cases: [string, string, string][] = [
      ["foo", "bar", "baz"],
      ["2", "3", "4"],
      ["a", "b", ""],
      ["", "b", "c"],
    ];
    for (const [before, inner, after] of cases) {
      const output = serialize(
        ...(before ? [schema.text(before)] : []),
        italic(inner),
        ...(after ? [schema.text(after)] : []),
      );
      expect(output).toBe(`${before}*${inner}*${after}`);
      expect(fromMarkdown(output).children[0]).toMatchObject({
        type: "paragraph",
        children: [
          ...(before ? [{ type: "text", value: before }] : []),
          { type: "emphasis", children: [{ type: "text", value: inner }] },
          ...(after ? [{ type: "text", value: after }] : []),
        ],
      });
    }
    // Whitespace or punctuation beside the span keeps the underscore, and so
    // does another span's delimiter: the neighbour is read from the wire, not
    // from the paragraph text.
    expect(serialize(schema.text("a "), italic("b"), schema.text(" c"))).toBe(
      "a _b_ c",
    );
    expect(serialize(schema.text("("), italic("b"), schema.text(")"))).toBe(
      "(_b_)",
    );
    expect(serialize(italic("b"))).toBe("_b_");
    expect(serialize(italic("a"), bold("b"))).toBe("_a_**b**");
    // Inside a bold run the neighbours are the bold prose, so * forms intraword
    // where the stock handler would encode them.
    const both = schema.text("b", [
      schema.marks.bold.create(),
      schema.marks.italic.create(),
    ]);
    expect(serialize(bold("a"), both, bold("c"))).toBe("**a*b*c**");
    expect(fromMarkdown("**a*b*c**").children[0]).toMatchObject({
      type: "paragraph",
      children: [
        {
          type: "strong",
          children: [
            { type: "text", value: "a" },
            { type: "emphasis", children: [{ type: "text", value: "b" }] },
            { type: "text", value: "c" },
          ],
        },
      ],
    });
  });
  it.each([
    ["a", "b", "*", "a*b*\\*"],
    ["a", "b", "*c", "a*b*\\*c"],
    ["5*", "x", "y", "5\\**x*y"],
    ["a**", "b", "c", "a\\*\\**b*c"],
    ["a", "b", "**c", "a*b*\\*\\*c"],
    // An unmatched authored run that could open emphasis is escaped wherever
    // it sits before the span; left alone, the parser pairs it with the
    // generated delimiter (a*b\*\**x*y reads as emphasis("b**")). The
    // mirrored run after the span never pairs, so it stays as authored.
    ["a*b**", "x", "y", "a\\*b\\*\\**x*y"],
    ["a*b", "x", "y", "a\\*b*x*y"],
    ["*a", "x", "y", "\\*a*x*y"],
    ["2*3 is", "x", "y", "2\\*3 is*x*y"],
    ["a", "x", "**b*c", "a*x*\\*\\*b*c"],
    ["", "x", "**b*c", "_x_**b*c"],
  ])(
    "preserves emphasis beside literal asterisks in %s / %s / %s",
    (before, inner, after, wire) => {
      const output = serialize(
        ...(before ? [schema.text(before)] : []),
        schema.text(inner, [schema.marks.italic.create()]),
        schema.text(after),
      );
      expect(output).toBe(wire);
      expect(fromMarkdown(output).children[0]).toMatchObject({
        type: "paragraph",
        children: [
          ...(before ? [{ type: "text", value: before }] : []),
          { type: "emphasis", children: [{ type: "text", value: inner }] },
          { type: "text", value: after },
        ],
      });
    },
  );
  it.each([
    ["a\\*", "a\\**b*c", "a*"],
    ["a\\\\*", "a\\\\\\**b*c", "a\\*"],
    ["a\\**", "a\\*\\**b*c", "a**"],
    ["a*\\", "a\\*\\\\*b*c", "a*\\"],
    ["a\\", "a\\\\*b*c", "a\\"],
    ["a\\\\", "a\\\\*b*c", "a\\"],
  ])(
    "preserves raw escapes before generated emphasis in %s",
    (before, wire, rendered) => {
      const output = serialize(
        schema.text(before),
        schema.text("b", [schema.marks.italic.create()]),
        schema.text("c"),
      );
      expect(output).toBe(wire);
      expect(fromMarkdown(output).children[0]).toMatchObject({
        type: "paragraph",
        children: [
          { type: "text", value: rendered },
          { type: "emphasis", children: [{ type: "text", value: "b" }] },
          { type: "text", value: "c" },
        ],
      });
    },
  );
  it.each([
    ["`a*b` then ", "inlineCode", "a*b"],
    ["``a`*b`` then ", "inlineCode", "a`*b"],
    ["`a\\*b` then ", "inlineCode", "a\\*b"],
    ["`a*b\nc*d` then ", "inlineCode", "a*b\nc*d"],
    ["```\na*b\n```\n\nthen ", "code", "a*b"],
    ["    a*b\n\nthen ", "code", "a*b"],
  ])(
    "preserves authored code before generated emphasis: %s",
    (source, type, value) => {
      for (const [mark, delimiter] of [
        [schema.marks.bold, "**"],
        [schema.marks.italic, "_"],
      ] as const) {
        const output = serialize(
          schema.text(source),
          schema.text("c", [mark.create()]),
        );
        expect(output).toBe(`${source}${delimiter}c${delimiter}`);
        const tree = fromMarkdown(output);
        const nodes = tree.children.flatMap<Nodes>((node) =>
          "children" in node ? node.children : [node],
        );
        expect(nodes).toContainEqual(expect.objectContaining({ type, value }));
        expect(nodes.at(-1)).toMatchObject({
          type: mark === schema.marks.bold ? "strong" : "emphasis",
          children: [{ type: "text", value: "c" }],
        });
      }
    },
  );
  it.each([
    "<https://example.com/a*b>",
    "[a*b](https://example.com/c*d)",
    "![a*b](https://example.com/c*d)",
    '<span title="a*b">text</span>',
    "[a*b][ref]\n\n[ref]: https://example.com/c*d\n\n",
    "![a*b][ref]\n\n[ref]: https://example.com/c*d\n\n",
  ])("keeps authored non-prose source unchanged: %s", (source) => {
    const output = serialize(schema.text(`${source} then `), bold("c"));
    expect(output).toBe(`${source} then **c**`);
  });
  it.each(["    a*b", "```a*b", "<div> a*b"])(
    "does not mistake mid-line authored prose for a block: %s",
    (source) => {
      const output = serialize(
        bold("c"),
        schema.text(source),
        schema.text("d", [schema.marks.italic.create()]),
      );
      expect(output).toBe(`**c**${source.replaceAll("*", "\\*")}*d*`);
      expect(fromMarkdown(output).children[0]).toMatchObject({
        type: "paragraph",
        children: expect.arrayContaining([
          expect.objectContaining({
            type: "emphasis",
            children: [expect.objectContaining({ value: "d" })],
          }),
        ]),
      });
    },
  );
  it("retains authored block context across serialized paragraph boundaries", () => {
    const italic = (value: string) =>
      schema.text(value, [schema.marks.italic.create()]);
    const markdown = (...blocks: ReturnType<typeof paragraph>[]) =>
      composerMarkdown(projectComposerDocument(doc(...blocks)).draft);
    const output = markdown(
      paragraph(schema.text("x")),
      paragraph(schema.text("    a*b"), italic("d")),
    );
    expect(output).toBe("x\n    a\\*b*d*");
    expect(fromMarkdown(output).children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", value: "x\na*b" },
        { type: "emphasis", children: [{ type: "text", value: "d" }] },
      ],
    });
    for (const blocks of [
      [
        paragraph(schema.text("x")),
        paragraph(schema.text("```\na*b\n```\n\nthen "), bold("c")),
      ],
      [
        paragraph(schema.text("x")),
        paragraph(),
        paragraph(schema.text("    a*b\n\nthen "), bold("c")),
      ],
      [
        paragraph(schema.text("    first")),
        paragraph(schema.text("    a*b\n\nthen "), bold("c")),
      ],
      [
        paragraph(schema.text("```\nfirst")),
        paragraph(schema.text("a*b\n```\n\nthen "), bold("c")),
      ],
    ]) {
      const wire = markdown(...blocks);
      expect(wire).not.toContain("\\*");
      expect(fromMarkdown(wire).children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "code",
            value: expect.stringContaining("a*b"),
          }),
        ]),
      );
    }
  });
  it("keeps UTF-16 source offsets after rich astral text and recipients", () => {
    for (const before of [
      bold("🎉🎉🎉"),
      schema.nodes.token.create({
        source: "@🎉🎉🎉",
        recipient: { pubkey: "a".repeat(64), name: "🎉🎉🎉" },
      }),
    ]) {
      const prefix = serialize(before);
      for (const mark of [schema.marks.bold, schema.marks.italic]) {
        const output = serialize(
          before,
          schema.text(" `a*b` then "),
          schema.text("c", [mark.create()]),
        );
        expect(output).toBe(
          `${prefix} \`a*b\` then ${mark === schema.marks.bold ? "**c**" : "_c_"}`,
        );
        expect(fromMarkdown(output).children[0]).toMatchObject({
          children: expect.arrayContaining([
            expect.objectContaining({ type: "inlineCode", value: "a*b" }),
          ]),
        });
      }
    }
  });
  it.each(["**Note**", "*Note*", "***Note***", "**Note***", "***Note**"])(
    "preserves authored attention beside generated spans: %s",
    (source) => {
      const italic = (value: string) =>
        schema.text(value, [schema.marks.italic.create()]);
      const authored = renderedCharacters(fromMarkdown(source).children);
      for (const mark of [italic]) {
        const marked = renderedCharacters(
          fromMarkdown(serialize(mark("x"))).children,
        );
        for (const [children, expected] of [
          [
            [schema.text(source), mark("x"), schema.text("y")],
            [...authored, ...marked, { character: "y", marks: [] }],
          ],
          [
            [schema.text("a"), mark("x"), schema.text(source)],
            [{ character: "a", marks: [] }, ...marked, ...authored],
          ],
        ] as const) {
          const output = serialize(...children);
          expect(
            renderedCharacters(fromMarkdown(output).children),
            output,
          ).toEqual(expected);
        }
      }
    },
  );
  it("keeps an unmarked recipient's exact name beside emphasis and a literal asterisk", () => {
    const honey = { pubkey: "a".repeat(64), name: "Honey" };
    const output = serialize(
      schema.nodes.token.create({ source: "@Honey", recipient: honey }),
      schema.text("b", [schema.marks.italic.create()]),
      schema.text("*"),
    );
    expect(output).toBe("@Honey*b*\\*");
    expect(fromMarkdown(output).children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", value: "@Honey" },
        { type: "emphasis", children: [{ type: "text", value: "b" }] },
        { type: "text", value: "*" },
      ],
    });
    expect(
      profileMentionParts(
        { content: output, mentions: [honey.pubkey] },
        new Map([[honey.pubkey, { name: honey.name }]]),
      ),
    ).toEqual([
      { text: "@Honey", target: profileTarget(honey.pubkey) },
      { text: "*b*\\*" },
    ]);
  });
  it("keeps generated strong delimiters distinct from literal asterisks", () => {
    const italic = (text: string) =>
      schema.text(text, [schema.marks.italic.create()]);
    for (const children of [
      [schema.text("a"), italic("b"), bold("c")],
      [bold("a"), italic("b"), schema.text("c")],
      // An unmatched authored run before generated strong is escaped too, so
      // a**b**c** no longer reads as strong("b") followed by a literal c**.
      [schema.text("a**b"), bold("c")],
      [schema.text("a*b"), bold("c"), italic("x"), schema.text("y")],
    ]) {
      const output = serialize(...children);
      expect(output).not.toContain("&#");
      expect(renderedCharacters(fromMarkdown(output).children)).toEqual(
        children.flatMap((child) =>
          [...(child.text ?? "")].map((character) => ({
            character,
            marks: child.marks.map((mark) =>
              mark.type.name === "italic" ? "emphasis" : "strong",
            ),
          })),
        ),
      );
    }
  });
});

const marked = (text: string, ...marks: InlineFormat[]) =>
  schema.text(
    text,
    marks.map((name) => schema.marks[name].create()),
  );
const parseFormats = (text: string) =>
  fromMarkdown(text, {
    extensions: [gfmStrikethrough()],
    mdastExtensions: [gfmStrikethroughFromMarkdown()],
  });

// Compare rendered characters and their formats, not one preferred spelling of
// valid Markdown. Generated mark delimiters cannot wrap boundary whitespace.
function renderedCharacters(
  nodes: readonly RootContent[],
  marks: string[] = [],
): { character: string; marks: string[] }[] {
  return nodes.flatMap((node) => {
    const nested = ["strong", "emphasis", "delete"].includes(node.type)
      ? [...marks, node.type].sort()
      : marks;
    if (node.type === "text")
      return [...node.value]
        .filter((character) => !/\s/.test(character))
        .map((character) => ({ character, marks: nested }));
    return "children" in node ? renderedCharacters(node.children, nested) : [];
  });
}

describe("inline formatting batch", () => {
  it("round-trips nested and crossing marks through Markdown and persisted drafts", () => {
    const names = ["bold", "italic", "strike"] as const;
    const types = { bold: "strong", italic: "emphasis", strike: "delete" };
    for (const [left, right] of [
      ["one ", "two"],
      ["a", "b"],
      ["!", "?"],
    ] as const)
      for (let first = 0; first < 8; first++)
        for (let second = 0; second < 8; second++) {
          const a = names.filter((_, index) => first & (1 << index));
          const b = names.filter((_, index) => second & (1 << index));
          const original = doc(
            paragraph(
              marked(left, ...a),
              marked(right, ...b),
              schema.text(" plain"),
            ),
          );
          const draft = mentionDraft(
            JSON.parse(JSON.stringify(projectComposerDocument(original).draft)),
          );
          expect(readComposerDocument(draft, []).eq(original)).toBe(true);
          expect(draft.text).toBe(`${left}${right} plain`);
          const output = composerMarkdown(draft);
          expect(
            renderedCharacters(parseFormats(output).children),
            output,
          ).toEqual([
            ...[...left.trim()].map((character) => ({
              character,
              marks: a.map((name) => types[name]).sort(),
            })),
            ...[...right].map((character) => ({
              character,
              marks: b.map((name) => types[name]).sort(),
            })),
            ...[..."plain"].map((character) => ({ character, marks: [] })),
          ]);
        }
  });
  it("preserves whitespace and existing inline Markdown inside nested formats", () => {
    expect(
      serialize(bold("one "), marked("two", "bold", "italic"), bold(" three")),
    ).toBe("**one _two_ three**");
    expect(
      serialize(marked("~~old~~ and [link](https://example.com)", "italic")),
    ).toBe("_~~old~~ and [link](https://example.com)_");
    expect(
      serialize(marked("one\ntwo ", "italic", "strike"), schema.text("plain")),
    ).toBe("_~~one\ntwo~~_ plain");
  });
  it("writes an italic recipient with asterisks so the timeline still binds the mention", () => {
    const honey = { pubkey: "a".repeat(64), name: "Honey" };
    const chip = (...marks: InlineFormat[]) =>
      schema.nodes.token.create(
        { source: "@Honey", recipient: honey },
        null,
        marks.map((name) => schema.marks[name].create()),
      );
    expect(serialize(chip("italic"), schema.text(" "))).toBe("*@Honey* ");
    expect(
      serialize(marked("hi ", "italic"), chip("italic"), schema.text(" there")),
    ).toBe("*hi @Honey* there");
    expect(serialize(chip("bold", "italic"))).toBe("***@Honey***");
    // Only the span holding the recipient changes marker.
    expect(
      serialize(marked("x", "italic"), schema.text(" "), chip("italic")),
    ).toBe("_x_ *@Honey*");
    // A mention without signed provenance is prose; nothing binds it either way.
    expect(
      serialize(
        schema.nodes.token.create({ source: "@Honey" }, null, [
          schema.marks.italic.create(),
        ]),
      ),
    ).toBe("_@Honey_");
  });
  it("escapes literal punctuation in each generated format", () => {
    for (const mark of ["bold", "italic", "strike"] as const)
      for (const character of ["*", "_", "~", "!"]) {
        const output = serialize(
          schema.text("x"),
          marked(character, mark),
          schema.text("y"),
        );
        expect(
          renderedCharacters(parseFormats(output).children),
          output,
        ).toEqual([
          { character: "x", marks: [] },
          {
            character,
            marks: [
              { bold: "strong", italic: "emphasis", strike: "delete" }[mark],
            ],
          },
          { character: "y", marks: [] },
        ]);
      }
  });
});

it.each(["chat", "document"] as const)(
  "keeps folder-chip paths literal in %s Markdown",
  (mode) => {
    const chip = {
      kind: "folder",
      id: "/__draft__/notes",
      label: "Draft notes",
    };
    const original = doc(
      paragraph(schema.nodes.token.create({ source: chip.id, semantic: chip })),
    );
    const draft = projectComposerDocument(original).draft;
    const tree = fromMarkdown(composerMarkdown(draft, { mode }));
    expect(tree.children).toMatchObject([
      { type: "paragraph", children: [{ type: "text", value: chip.id }] },
    ]);
    expect(readComposerDocument(draft, []).eq(original)).toBe(true);
  },
);
