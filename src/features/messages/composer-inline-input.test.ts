import { describe, expect, it } from "vitest";
import {
  EditorState,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import { composerSchema as schema } from "./composer-document";
import { applyComposerInlineInput } from "./composer-inline-input";

/**
 * Runs the live-conversion step the way the editor does: the typed character is
 * already in the document and the caret sits right after it, so the typed
 * character is always `source[caret - 1]`. `caret` is an offset into `source`
 * (default: the end) so a test can type into the middle of existing text.
 * Returns the resulting text and the mark names on each text run, so a test can
 * assert both which characters survive and which of them are styled.
 */
function closeSpan(
  source: string,
  { caret = source.length, selectAll = false } = {},
) {
  const typed = source[caret - 1] ?? "";
  const doc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, schema.text(source)),
  ]);
  const selection = selectAll
    ? TextSelection.create(doc, 1, doc.content.size - 1)
    : TextSelection.create(doc, caret + 1);
  const tr = EditorState.create({ doc, selection }).tr;
  const converted = applyComposerInlineInput(tr, typed);
  return { converted, tr };
}

function typeClosing(
  source: string,
  options?: Parameters<typeof closeSpan>[1],
) {
  const { converted, tr } = closeSpan(source, options);
  return { converted, text: tr.doc.textContent, runs: runsOf(tr) };
}

function runsOf(tr: Transaction) {
  const runs: [string, string[]][] = [];
  tr.doc.firstChild?.forEach((node) => {
    runs.push([
      node.text ?? "",
      node.marks.map((mark) => mark.type.name).sort(),
    ]);
  });
  return runs;
}

describe("typed inline Markdown conversion", () => {
  describe("converts a span closed by typing", () => {
    it.each([
      ["**bold**", "bold", ["bold"]],
      ["*italic*", "italic", ["italic"]],
      ["_italic_", "italic", ["italic"]],
      ["~~struck~~", "struck", ["strike"]],
      ["`code`", "code", ["code"]],
      ["***both***", "both", ["bold", "italic"]],
    ])("%s", (source, text, marks) => {
      expect(typeClosing(source)).toEqual({
        converted: true,
        text,
        runs: [[text, marks]],
      });
    });

    it("styles only the span and keeps surrounding text", () => {
      expect(typeClosing("say **hi**").runs).toEqual([
        ["say ", []],
        ["hi", ["bold"]],
      ]);
      expect(typeClosing("run `ls -la`").runs).toEqual([
        ["run ", []],
        ["ls -la", ["code"]],
      ]);
    });

    it("converts when typed into the middle of existing text", () => {
      const source = "a `code` b";
      expect(typeClosing(source, { caret: source.indexOf("e` ") + 2 })).toEqual(
        {
          converted: true,
          text: "a code b",
          runs: [
            ["a ", []],
            ["code", ["code"]],
            [" b", []],
          ],
        },
      );
    });

    it("keeps backticks inside a longer code delimiter", () => {
      expect(typeClosing("``a`b``")).toMatchObject({
        converted: true,
        text: "a`b",
      });
    });

    it("drops the single boundary space CommonMark ignores in code", () => {
      expect(typeClosing("` a `")).toMatchObject({
        converted: true,
        text: "a",
      });
    });
  });

  describe("leaves text alone", () => {
    it("when a non-delimiter is typed after a span has converted", () => {
      // Typing `code` converts at the closing backtick. The next keystroke sees
      // the converted document, not the Markdown source, and must not touch it.
      const { tr } = closeSpan("`code`");
      expect(runsOf(tr)).toEqual([["code", ["code"]]]);
      tr.insertText("x");
      expect(applyComposerInlineInput(tr, "x")).toBe(false);
      expect(runsOf(tr)).toEqual([
        ["code", ["code"]],
        ["x", []],
      ]);
    });

    it("when the span is not closed", () => {
      expect(typeClosing("``code`")).toMatchObject({
        converted: false,
        text: "``code`",
      });
      expect(typeClosing("**bold*")).toMatchObject({
        converted: false,
        text: "**bold*",
      });
    });

    it("when the span would be empty", () => {
      expect(typeClosing("``")).toMatchObject({
        converted: false,
        text: "``",
      });
    });

    it("when text is selected", () => {
      expect(typeClosing("`code`", { selectAll: true })).toMatchObject({
        converted: false,
        text: "`code`",
      });
    });

    it("for a lone tilde, which must not strike while typing", () => {
      // Approximate values and paths use a single `~`; only `~~x~~` strikes.
      expect(typeClosing("~5 and ~")).toMatchObject({
        converted: false,
        text: "~5 and ~",
      });
    });
  });

  // Regression: the delimiter length of a code span was read with /^[`~]+/, so a
  // `~` right after the opening backtick counted as delimiter. Two characters
  // were removed from each end: `~/Foo/bar` became `/Foo/ba`.
  describe("keeps every content character of a code span that contains `~`", () => {
    it.each([
      ["`~foo`", "~foo"],
      ["`~/A`", "~/A"],
      ["`~/Foo/bar`", "~/Foo/bar"],
      ["`~A`", "~A"],
      ["`~`", "~"],
      ["`~~`", "~~"],
      ["`~~x~~`", "~~x~~"],
      ["`a~b`", "a~b"],
      ["`foo~`", "foo~"],
    ])("%s", (source, text) => {
      expect(typeClosing(source)).toEqual({
        converted: true,
        text,
        runs: [[text, ["code"]]],
      });
    });

    it("in running text", () => {
      expect(typeClosing("Hello `~/Foo/bar`").runs).toEqual([
        ["Hello ", []],
        ["~/Foo/bar", ["code"]],
      ]);
    });

    it("when typed into the middle of existing text", () => {
      const source = "a `~/Foo/bar` b";
      expect(typeClosing(source, { caret: source.indexOf("` b") + 1 })).toEqual(
        {
          converted: true,
          text: "a ~/Foo/bar b",
          runs: [
            ["a ", []],
            ["~/Foo/bar", ["code"]],
            [" b", []],
          ],
        },
      );
    });

    it("with a double-backtick delimiter", () => {
      expect(typeClosing("``~/a`b``")).toMatchObject({
        converted: true,
        text: "~/a`b",
      });
    });
  });

  it("does not trim the content of typed strikethrough", () => {
    expect(typeClosing("~~/path~~")).toEqual({
      converted: true,
      text: "/path",
      runs: [["/path", ["strike"]]],
    });
  });
});
