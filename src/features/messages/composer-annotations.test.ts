import { describe, expect, it } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { history, redo, undo } from "prosemirror-history";
import type { Node as EditorNode } from "prosemirror-model";
import type { DecorationSet } from "prosemirror-view";
import {
  composerSchema as schema,
  projectComposerDocument,
} from "./composer-document";
import {
  ANNOTATION_EDITOR_LIMIT,
  ANNOTATION_LIMIT,
  acceptedAnnotations,
  annotationAt,
  annotationPlugin,
  annotationRevision,
  mergedAnnotations,
  proseSpans,
  replaceAnnotation,
  showAnnotations,
  shownAnnotations,
  type AnnotationMark,
} from "./composer-annotations";

const text = (value: string, ...marks: ReturnType<typeof bold>[]) =>
  schema.text(value, marks);
const bold = () => schema.marks.bold.create();
const italic = () => schema.marks.italic.create();
const paragraph = (...children: EditorNode[]) =>
  schema.nodes.paragraph.create(null, children);
const doc = (...blocks: EditorNode[]) => schema.nodes.doc.create(null, blocks);
const spanText = (node: EditorNode) => {
  const source = projectComposerDocument(node).draft.text;
  return proseSpans(node).map(({ start, end }) => source.slice(start, end));
};
const observe = (value: string, prose = [{ start: 0, end: value.length }]) => ({
  revision: 1,
  text: value,
  prose,
});
const choices = (...texts: string[]) => texts.map((text) => ({ text }));
const issue = (
  value: string,
  word: string,
  replacements: unknown[] = choices("fixed"),
  from = 0,
) => {
  const start = value.indexOf(word, from);
  return {
    start,
    end: start + word.length,
    text: word,
    label: "Possible misspelling",
    kind: "spelling",
    replacements,
  };
};
const at = (start: number, end: number, text: string) => ({
  start,
  end,
  text,
  label: "Note",
});

describe("prose spans", () => {
  it("joins formatted runs and splits at code, links, mentions, chips and breaks", () => {
    const node = doc(
      paragraph(
        text("plain "),
        text("bold", bold()),
        text(" and ", italic()),
        text("code", schema.marks.code.create()),
        text(" after "),
        text(
          "label",
          schema.marks.link.create({ href: "https://example.org" }),
        ),
        text(" next "),
        text(
          "@Ada",
          schema.marks.recipient.create({
            pubkey: "a".repeat(64),
            name: "Ada",
          }),
        ),
        text(" then "),
        schema.nodes.token.create({ source: "https://example.org/chip" }),
        text(" line"),
        schema.nodes.hard_break.create(),
        text("second"),
      ),
      paragraph(text("block")),
      schema.nodes.code_block.create(null, [text("fenced")]),
    );
    expect(spanText(node)).toEqual([
      "plain bold and ",
      " after ",
      " next ",
      " then ",
      " line",
      "second",
      "block",
    ]);
  });

  it("leaves raw Markdown code, link targets and HTML out of the prose", () => {
    const node = doc(
      paragraph(
        text("see `teh` and [lable](https://example.org/x) or <b>tag</b> done"),
      ),
    );
    expect(spanText(node)).toEqual(["see ", " and ", " or ", "tag", " done"]);
  });

  it("numbers every document once, so the same text in a new document is a new revision", () => {
    const one = doc(paragraph(text("same")));
    const two = doc(paragraph(text("same")));
    expect(annotationRevision(one)).toBe(annotationRevision(one));
    expect(annotationRevision(two)).not.toBe(annotationRevision(one));
  });
});

describe("accepted annotations", () => {
  it("rejects a publication that is not a list", () => {
    for (const raw of [undefined, null, {}, "teh", 3])
      expect(acceptedAnnotations(raw, observe("teh"), "p/one")).toBeUndefined();
  });

  it("keeps only issues that exactly match whole graphemes inside one span", () => {
    const value = "teh 👍🏽x ok cafe" + "\u0301" + " wrld";
    const spans = [
      { start: 0, end: 12 },
      { start: 12, end: value.length },
    ];
    const accepted = acceptedAnnotations(
      [
        issue(value, "teh"),
        // Wrong text, outside the draft, reversed or fractional ranges.
        at(0, 3, "the"),
        at(0, value.length + 1, value),
        at(3, 0, ""),
        at(0.5, 3, "teh"),
        // Splits a surrogate pair, then a modifier sequence.
        at(4, 5, value.slice(4, 5)),
        at(4, 6, value.slice(4, 6)),
        // Crosses the prose boundary.
        at(9, 14, value.slice(9, 14)),
        // Splits "e" from its combining accent.
        at(13, 17, value.slice(13, 17)),
        // No usable label.
        { ...at(0, 3, "teh"), label: "" },
        { ...at(0, 3, "teh"), label: " padded" },
        { ...at(0, 3, "teh"), label: "x".repeat(121) },
        issue(value, "wrld", choices("world")),
        null,
        "teh",
      ],
      observe(value, spans),
      "p/one",
    );
    expect(accepted?.map((mark) => mark.text)).toEqual(["teh", "wrld"]);
    expect(Object.isFrozen(accepted?.[0])).toBe(true);
    expect(Object.isFrozen(accepted?.[0]?.replacements)).toBe(true);
    expect(accepted?.[1]).toEqual({
      key: "p/one",
      start: value.indexOf("wrld"),
      end: value.length,
      text: "wrld",
      label: "Possible misspelling",
      kind: "spelling",
      replacements: [{ text: "world", label: "world" }],
    });
    // A whole emoji with its modifier is a grapheme boundary.
    const emoji = acceptedAnnotations(
      [at(4, 8, value.slice(4, 8))],
      observe(value, spans),
      "p/one",
    );
    expect(emoji).toHaveLength(1);
  });

  it("offers at most five distinct plain-text replacements", () => {
    const [mark] =
      acceptedAnnotations(
        [
          issue("teh", "teh", [
            ...choices(
              "the",
              "the",
              "teh",
              "",
              " the",
              "x".repeat(65),
              "t\nh",
              "t\u202Eh",
              "t\u2066h",
              "t\uD800h",
            ),
            "the",
            { text: 3 },
            { text: "ten", label: "" },
            { text: "ten" },
            { text: "", label: "Remove" },
            { text: "tea", label: "Use tea" },
            ...choices("tech", "x".repeat(64), "eh"),
          ]),
        ],
        observe("teh"),
        "p/one",
      ) ?? [];
    expect(mark?.replacements).toEqual([
      { text: "the", label: "the" },
      { text: "ten", label: "ten" },
      { text: "", label: "Remove" },
      { text: "tea", label: "Use tea" },
      { text: "tech", label: "tech" },
    ]);
    const [none] =
      acceptedAnnotations(
        [{ ...at(0, 3, "teh"), replacements: "the", kind: "style" }],
        observe("teh"),
        "p/one",
      ) ?? [];
    expect(none?.replacements).toEqual([]);
    expect(none?.kind).toBeUndefined();
  });

  it("reads a bounded number of annotations and drops later overlaps", () => {
    const value = "ab ".repeat(ANNOTATION_LIMIT + 10);
    const flood = Array.from({ length: ANNOTATION_LIMIT + 10 }, (_, i) =>
      at(i * 3, i * 3 + 2, "ab"),
    );
    expect(acceptedAnnotations(flood, observe(value), "p/one")).toHaveLength(
      ANNOTATION_LIMIT,
    );
    const overlapping = acceptedAnnotations(
      [at(3, 5, "ab"), at(0, 4, "ab a"), at(0, 2, "ab")],
      observe(value),
      "p/one",
    );
    expect(overlapping?.map(({ start, end }) => [start, end])).toEqual([
      [0, 2],
      [3, 5],
    ]);
  });
});

describe("merged annotations", () => {
  const mark = (start: number, end: number, key: string): AnnotationMark => ({
    key,
    start,
    end,
    text: "x".repeat(end - start),
    label: "Note",
    kind: undefined,
    replacements: [],
  });
  it("lets earlier annotators win overlaps and caps the editor", () => {
    expect(
      mergedAnnotations([
        [mark(4, 8, "a")],
        [mark(0, 2, "b"), mark(6, 10, "b")],
      ]).map(({ key, start }) => [key, start]),
    ).toEqual([
      ["b", 0],
      ["a", 4],
    ]);
    const many = (key: string, offset: number) =>
      Array.from({ length: 300 }, (_, i) =>
        mark(offset + i * 2, offset + i * 2 + 1, key),
      );
    expect(mergedAnnotations([many("a", 0), many("b", 1000)])).toHaveLength(
      ANNOTATION_EDITOR_LIMIT,
    );
  });
});

describe("annotation state", () => {
  const create = (node: EditorNode, composing = () => false) =>
    EditorState.create({
      doc: node,
      plugins: [history(), annotationPlugin("marked", composing)],
    });
  const shown = (state: EditorState, marks: AnnotationMark[]) => {
    const tr = showAnnotations(state, annotationRevision(state.doc), marks);
    if (!tr) throw new Error("not shown");
    return state.apply(tr);
  };
  const markFor = (state: EditorState, word: string, offered = ["the"]) => {
    const value = projectComposerDocument(state.doc).draft.text;
    const [found] =
      acceptedAnnotations(
        [issue(value, word, choices(...offered))],
        {
          revision: annotationRevision(state.doc),
          text: value,
          prose: proseSpans(state.doc),
        },
        "p/one",
      ) ?? [];
    if (!found) throw new Error(`no issue for ${word}`);
    return found;
  };
  const underlined = (state: EditorState) =>
    annotationPlugin("marked", () => false)
      .getState(state)
      ?.set.find()
      .map((item) => state.doc.textBetween(item.from, item.to)) ?? [];
  const command = (state: EditorState, run: typeof undo): EditorState => {
    let next = state;
    run(state, (tr) => {
      next = state.apply(tr);
    });
    return next;
  };
  const value = (state: EditorState) =>
    projectComposerDocument(state.doc).draft.text;

  it("replaces a word in its own undo step, keeping its formatting", () => {
    let state = create(
      doc(paragraph(text("say "), text("teh", bold()), text(" word"))),
    );
    // Earlier typing, then the correction, each undo separately.
    state = state.apply(state.tr.insertText("!", state.doc.content.size - 1));
    const mark = markFor(state, "teh");
    state = shown(state, [mark]);
    expect(underlined(state)).toEqual(["teh"]);
    const revision = annotationRevision(state.doc);
    // The caret inside the word moves after the replacement.
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 6)),
    );
    expect(annotationAt(state, 6)).toBe(mark);
    expect(shownAnnotations(state)).toEqual([mark]);
    const tr = replaceAnnotation(state, revision, mark, "the");
    if (!tr) throw new Error("not replaced");
    state = state.apply(tr);
    expect(value(state)).toBe("say the word!");
    expect(
      state.doc
        .child(0)
        .child(1)
        .marks.map((m) => m.type.name),
    ).toEqual(["bold"]);
    expect(state.selection.head).toBe(8);
    expect(underlined(state)).toEqual([]);
    expect(shownAnnotations(state)).toEqual([]);
    state = command(state, undo);
    expect(value(state)).toBe("say teh word!");
    state = command(state, undo);
    expect(value(state)).toBe("say teh word");
    state = command(state, redo);
    state = command(state, redo);
    expect(value(state)).toBe("say the word!");
  });

  it("refuses a stale revision, a changed word, mixed formatting or an unoffered choice", () => {
    let state = create(doc(paragraph(text("teh cat"))));
    const mark = markFor(state, "teh");
    state = shown(state, [mark]);
    const revision = annotationRevision(state.doc);
    expect(replaceAnnotation(state, revision, mark, "tea")).toBeUndefined();
    expect(replaceAnnotation(state, revision + 1, mark, "the")).toBeUndefined();
    expect(
      replaceAnnotation(state, revision, { ...mark, start: 1 }, "the"),
    ).toBeUndefined();
    // A structural change with the same text still retires the marks.
    const restyled = state.apply(state.tr.addMark(5, 8, bold()));
    expect(value(restyled)).toBe("teh cat");
    expect(annotationAt(restyled, 2)).toBeUndefined();
    expect(replaceAnnotation(restyled, revision, mark, "the")).toBeUndefined();
    // Its word unchanged, the underline follows until the next publication.
    expect(underlined(restyled)).toEqual(["teh"]);
    // Editing the word removes its underline.
    const edited = state.apply(state.tr.insertText("x", 2));
    expect(underlined(edited)).toEqual([]);

    let mixed = create(
      doc(paragraph(text("te"), text("h", bold()), text(" cat"))),
    );
    const split = markFor(mixed, "teh");
    mixed = shown(mixed, [split]);
    expect(annotationAt(mixed, 2)).toBeUndefined();
    expect(
      replaceAnnotation(mixed, annotationRevision(mixed.doc), split, "the"),
    ).toBeUndefined();
  });

  it("only moves underlines under a composition and refuses stale publication", () => {
    let composing = false;
    let state = create(doc(paragraph(text("teh cat"))), () => composing);
    const stale = annotationRevision(state.doc);
    const mark = markFor(state, "teh");
    state = shown(state, [mark]);
    composing = true;
    state = state.apply(state.tr.insertText("x", 2));
    expect(underlined(state)).toEqual(["txeh"]);
    composing = false;
    expect(showAnnotations(state, stale, [mark])).toBeUndefined();
    // Clearing is always allowed, and a no-op once nothing is shown.
    const clear = showAnnotations(state, 0, []);
    expect(clear).toBeDefined();
    if (clear) state = state.apply(clear);
    expect(underlined(state)).toEqual([]);
    expect(showAnnotations(state, 0, [])).toBeUndefined();
  });

  it("can remove an annotation's text", () => {
    let state = create(doc(paragraph(text("the the cat"))));
    const value = projectComposerDocument(state.doc).draft.text;
    const [repeated, general] =
      acceptedAnnotations(
        [
          {
            ...at(4, 8, "the "),
            kind: "grammar",
            replacements: [{ text: "", label: "Remove repeated word" }],
          },
          at(8, 11, "cat"),
        ],
        {
          revision: annotationRevision(state.doc),
          text: value,
          prose: proseSpans(state.doc),
        },
        "p/one",
      ) ?? [];
    if (!repeated || !general) throw new Error("not accepted");
    state = shown(state, [repeated, general]);
    expect(underlined(state)).toEqual(["the ", "cat"]);
    const tr = replaceAnnotation(
      state,
      annotationRevision(state.doc),
      repeated,
      "",
    );
    if (!tr) throw new Error("not removed");
    state = state.apply(tr);
    expect(projectComposerDocument(state.doc).draft.text).toBe("the cat");
  });

  it("hides the underline of the word being typed at the caret", () => {
    let state = create(doc(paragraph(text("teh"))));
    state = shown(state, [markFor(state, "teh")]);
    const plugin = state.plugins.find((p) => p.props.decorations);
    const decorations = (s: EditorState) =>
      (
        plugin?.props.decorations?.call(plugin, s) as DecorationSet | null
      )?.find().length ?? 0;
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 4)),
    );
    expect(decorations(state)).toBe(0);
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 1)),
    );
    expect(decorations(state)).toBe(1);
  });
});
