import type { Node as EditorNode } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { expect, it } from "vitest";
import { composerBlockPrefix, composerCodeBlockExit } from "./composer-blocks";
import {
  projectComposerDocument,
  composerSchema as schema,
} from "./composer-document";
import { composerMarkdown } from "./composer-markdown";

const { blockquote, bullet_list, code_block, doc, list_item, paragraph } =
  schema.nodes;
const text = (value: string) => schema.text(value);
const code = (value = "") => code_block.create(null, value ? text(value) : []);
const prose = (value: string) => paragraph.create(null, text(value));

/** State with the caret at `head`, or a range from `anchor` to `head`. */
function at(node: EditorNode, head: number, anchor = head) {
  return EditorState.create({
    doc: node,
    selection: TextSelection.create(node, anchor, head),
  });
}

it("opens an editable heading only for a document's plain line prefix", () => {
  for (const line of ["# ", "###### ", "####### ", "x # ", "\\# "]) {
    const state = at(doc.create(null, prose(line)), line.length + 1);
    const result = composerBlockPrefix(state, " ", "document");
    expect(result?.doc.firstChild?.attrs.level).toBe(
      line === "# " ? 1 : line === "###### " ? 6 : undefined,
    );
    expect(composerBlockPrefix(state, " ", "chat")).toBeUndefined();
  }
});

it.each([
  ["empty", ""],
  ["single-line", "one"],
  ["multiline", "one\ntwo"],
])("opens a paragraph past either edge of a lone %s code block", (_, value) => {
  const block = code(value);
  const node = doc.create(null, block);
  const end = 1 + block.content.size;

  const below = composerCodeBlockExit(at(node, end), true);
  expect(below?.doc.toJSON()).toEqual(
    doc.create(null, [block, paragraph.create()]).toJSON(),
  );
  expect(below?.selection.$head.parent.type).toBe(paragraph);
  expect(below?.selection.head).toBe(block.nodeSize + 1);

  const above = composerCodeBlockExit(at(node, 1), false);
  expect(above?.doc.toJSON()).toEqual(
    doc.create(null, [paragraph.create(), block]).toJSON(),
  );
  expect(above?.selection.head).toBe(1);
  expect(above?.selection.$head.parent.type).toBe(paragraph);
});

it("leaves a code block to native motion where a textblock lies beyond its edge", () => {
  const block = code("one\ntwo");
  const node = doc.create(null, [prose("before"), block, prose("after")]);
  const start = prose("before").nodeSize + 1;
  const end = start + block.content.size;
  expect(composerCodeBlockExit(at(node, end), true)).toBeUndefined();
  expect(composerCodeBlockExit(at(node, start), false)).toBeUndefined();
  // Only the side the key moves toward counts.
  const last = doc.create(null, [prose("before"), block]);
  expect(composerCodeBlockExit(at(last, start), false)).toBeUndefined();
  expect(composerCodeBlockExit(at(last, end), true)).toBeDefined();
  // A textblock beyond an enclosing block counts as well.
  const quoted = doc.create(null, [
    blockquote.create(null, block),
    prose("after"),
  ]);
  expect(
    composerCodeBlockExit(at(quoted, 2 + block.content.size), true),
  ).toBeUndefined();
});

it("opens the paragraph inside the enclosing block of a code block that ends the draft", () => {
  const block = code("one");
  const node = doc.create(null, [
    prose("before"),
    blockquote.create(null, block),
  ]);
  const end = prose("before").nodeSize + 2 + block.content.size;
  const exit = composerCodeBlockExit(at(node, end), true);
  expect(exit?.doc.toJSON()).toEqual(
    doc
      .create(null, [
        prose("before"),
        blockquote.create(null, [block, paragraph.create()]),
      ])
      .toJSON(),
  );
  expect(exit?.selection.$head.parent.type).toBe(paragraph);
  expect(exit?.selection.$head.node(1).type).toBe(blockquote);
});

it("ignores a range and a caret outside a code block", () => {
  const node = doc.create(null, [prose("before"), code("one")]);
  const end = node.content.size - 1;
  expect(composerCodeBlockExit(at(node, end, end - 2), true)).toBeUndefined();
  expect(composerCodeBlockExit(at(node, 7), true)).toBeUndefined();
});

it.each([
  ["the draft", (block: EditorNode) => [block], true],
  ["a quote", (block: EditorNode) => [blockquote.create(null, block)], true],
  [
    "a list item",
    (block: EditorNode) => [
      bullet_list.create(null, list_item.create(null, [prose("a"), block])),
    ],
    false,
  ],
] as const)(
  "sends an exit paragraph at an edge of %s as nothing, so the exit fits at the length limit",
  (_, shape, backward) => {
    const send = (node: EditorNode) =>
      composerMarkdown(projectComposerDocument(node).draft);
    const draft = (length: number) =>
      doc.create(null, shape(code("x".repeat(length))));
    const node = draft(16_001 - send(draft(1)).length);
    expect(send(node)).toHaveLength(16_000);
    let start = 0;
    node.descendants((child, position) => {
      if (child.type === code_block) start = position + 1;
    });
    const end = start + node.textBetween(start, node.content.size).length;
    const below = composerCodeBlockExit(at(node, end), true);
    expect(below && send(below.doc)).toBe(send(node));
    const above = composerCodeBlockExit(at(node, start), false);
    if (backward) expect(above && send(above.doc)).toBe(send(node));
    else expect(above).toBeUndefined();
  },
);

it("still sends every other blank line", () => {
  const send = (node: EditorNode) =>
    composerMarkdown(projectComposerDocument(node).draft);
  const blank = paragraph.create();
  const block = code("x");
  expect(send(doc.create(null, [prose("a"), blank]))).toBe("a\n");
  expect(send(doc.create(null, [block, blank, blank]))).toBe(
    "```\nx\n```\n\n\n",
  );
  expect(
    send(doc.create(null, blockquote.create(null, [prose("a"), blank]))),
  ).toBe("> a\n>");
});

it("keeps blank lines that no code block exit opened", () => {
  const send = (node: EditorNode) =>
    composerMarkdown(projectComposerDocument(node).draft);
  const blank = paragraph.create();
  // A nested `-` must not join the outer marker as `- - -`, a divider.
  const nested = doc.create(
    null,
    bullet_list.create(
      null,
      list_item.create(null, [
        blank,
        bullet_list.create(null, list_item.create(null, prose("-"))),
      ]),
    ),
  );
  expect(send(nested)).toBe("- \n  \n  - -");
  expect(
    send(doc.create(null, [blank, blockquote.create(null, prose("a"))])),
  ).toBe("\n\n> a");
});

it("copies a typed blank line beside a code block", () => {
  const node = doc.create(null, [paragraph.create(), code("one")]);
  const draft = projectComposerDocument(node).draft;
  expect(composerMarkdown(draft, { authored: true })).toBe("\n\n```\none\n```");
  expect(composerMarkdown(draft)).toBe("```\none\n```");
});
