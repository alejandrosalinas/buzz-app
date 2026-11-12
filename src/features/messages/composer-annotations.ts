import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { closeHistory } from "prosemirror-history";
import type { Node as EditorNode, Mark } from "prosemirror-model";
import { scanMarkdown } from "../relay/message-content";
import type {
  AnnotationObservation,
  ComposerAnnotation,
  ComposerReplacement,
  InlineRange,
} from "../conversation/contracts";
import {
  composerMarkdownContext,
  composerSchema,
  projectComposerDocument,
} from "./composer-document";

/** Per annotator, per publication. */
export const ANNOTATION_LIMIT = 200;
export const ANNOTATION_EDITOR_LIMIT = 400;
export const ANNOTATION_LABEL_LENGTH = 120;
export const REPLACEMENT_LIMIT = 5;
export const REPLACEMENT_LENGTH = 64;

/** A host-validated annotation, frozen, with the contribution that published it. */
export type AnnotationMark = Readonly<{
  key: string;
  start: number;
  end: number;
  text: string;
  label: string;
  kind: "spelling" | "grammar" | undefined;
  replacements: readonly Required<ComposerReplacement>[];
}>;

const revisions = new WeakMap<EditorNode, number>();
let lastRevision = 0;
/** One number per immutable document, never reused across editors, so a result
 * for an earlier document (even with the same text) is never current. */
export function annotationRevision(doc: EditorNode) {
  let revision = revisions.get(doc);
  if (revision === undefined) {
    revision = ++lastRevision;
    revisions.set(doc, revision);
  }
  return revision;
}

// Raw Markdown a person typed as plain text: its code, link targets and HTML
// stay literal when sent, so they are not prose.
const RAW_SYNTAX = new Set([
  "code",
  "inlineCode",
  "link",
  "linkReference",
  "image",
  "imageReference",
  "definition",
  "html",
]);
const NOT_PROSE = [
  composerSchema.marks.code,
  composerSchema.marks.link,
  composerSchema.marks.literal,
  composerSchema.marks.recipient,
];

/** Runs of plain text inside one block, in the editable-text projection. Code,
 * link labels, literals, mention text, chips, line breaks and raw Markdown
 * syntax are excluded; formatting marks do not split a run. */
export function proseSpans(doc: EditorNode): InlineRange[] {
  const source = projectComposerDocument(doc);
  const runs: { start: number; end: number }[] = [];
  let run: { start: number; end: number } | undefined;
  doc.descendants((node, position) => {
    if (node.isTextblock && node.type.spec.code) {
      run = undefined;
      return false;
    }
    if (!node.isInline) return;
    if (!node.isText || NOT_PROSE.some((type) => type.isInSet(node.marks))) {
      run = undefined;
      return;
    }
    const start = source.source(position);
    const end = start + node.nodeSize;
    if (run?.end === start) run.end = end;
    else {
      run = { start, end };
      runs.push(run);
    }
  });
  if (!runs.length) return [];
  const { tree, tooDeep } = scanMarkdown(
    composerMarkdownContext(doc, source).text,
  );
  if (tooDeep) return [];
  const blocked: InlineRange[] = [];
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    const start = node?.position?.start.offset,
      end = node?.position?.end.offset;
    if (!node || start === undefined || end === undefined) continue;
    if (RAW_SYNTAX.has(node.type)) blocked.push({ start, end });
    else pending.push(...(node.children ?? []));
  }
  blocked.sort((a, b) => a.start - b.start);
  const spans: InlineRange[] = [];
  for (const { start, end } of runs) {
    let from = start;
    for (const range of blocked) {
      if (range.end <= from || range.start >= end) continue;
      if (range.start > from) spans.push({ start: from, end: range.start });
      from = Math.max(from, range.end);
    }
    if (from < end) spans.push({ start: from, end });
  }
  return spans.map((span) => Object.freeze(span));
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Grapheme boundaries of each span, segmented once per publication. */
function graphemeBoundaries(text: string) {
  const cache = new Map<InlineRange, Set<number>>();
  return (span: InlineRange, offset: number) => {
    let boundaries = cache.get(span);
    if (!boundaries) {
      boundaries = new Set([span.end]);
      for (const { index } of graphemes.segment(
        text.slice(span.start, span.end),
      ))
        boundaries.add(span.start + index);
      cache.set(span, boundaries);
    }
    return boundaries.has(offset);
  };
}
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// Controls, line separators and bidirectional overrides, embeddings, isolates
// and marks: a replacement must not reorder or break the prose around it.
const UNSAFE_TEXT =
  /[\p{Cc}\u2028\u2029\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
function plain(value: unknown, length: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= length &&
    value.trim() === value &&
    !UNSAFE_TEXT.test(value) &&
    !LONE_SURROGATE.test(value)
  );
}
function label(value: unknown) {
  return plain(value, ANNOTATION_LABEL_LENGTH) && value ? value : undefined;
}
function replacement(value: unknown, original: string) {
  if (!value || typeof value !== "object") return;
  const { text, label: name } = value as ComposerReplacement;
  if (!plain(text, REPLACEMENT_LENGTH) || text === original) return;
  const shown = name === undefined && text ? text : label(name);
  return shown === undefined
    ? undefined
    : Object.freeze({ text, label: shown });
}

/** Copy at most `ANNOTATION_LIMIT` well-formed annotations from a publication,
 * dropping any that do not exactly match the observed prose, or nothing for a
 * publication that is not an array. Of overlapping annotations, the one that
 * starts first is kept. */
export function acceptedAnnotations(
  raw: unknown,
  observation: AnnotationObservation,
  key: string,
): AnnotationMark[] | undefined {
  if (!Array.isArray(raw)) return;
  const { text, prose } = observation;
  const boundary = graphemeBoundaries(text);
  const accepted: AnnotationMark[] = [];
  const count = Math.min(raw.length, ANNOTATION_LIMIT);
  for (let index = 0; index < count; index++) {
    const item: unknown = raw[index];
    if (!item || typeof item !== "object") continue;
    const { start, end, text: expected, kind } = item as ComposerAnnotation;
    const name = label((item as ComposerAnnotation).label);
    if (
      !name ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start ||
      end > text.length ||
      expected !== text.slice(start, end)
    )
      continue;
    const span = prose.find((span) => span.start <= start && end <= span.end);
    if (
      !span ||
      !boundary(span, start) ||
      !boundary(span, end) ||
      LONE_SURROGATE.test(expected)
    )
      continue;
    const offered: unknown = (item as ComposerAnnotation).replacements;
    const choices: Required<ComposerReplacement>[] = [];
    if (Array.isArray(offered))
      for (
        let i = 0;
        i < offered.length && choices.length < REPLACEMENT_LIMIT;
        i++
      ) {
        const choice = replacement(offered[i], expected);
        if (choice && !choices.some((c) => c.text === choice.text))
          choices.push(choice);
      }
    accepted.push(
      Object.freeze({
        key,
        start,
        end,
        text: expected,
        label: name,
        kind: kind === "spelling" || kind === "grammar" ? kind : undefined,
        replacements: Object.freeze(choices),
      }),
    );
  }
  accepted.sort((a, b) => a.start - b.start || a.end - b.end);
  let end = 0;
  return accepted.filter((mark) => {
    if (mark.start < end) return false;
    end = mark.end;
    return true;
  });
}

/** Combine annotators in contribution order: earlier ones win overlaps, and an
 * editor shows at most `ANNOTATION_EDITOR_LIMIT` marks. */
export function mergedAnnotations(
  groups: readonly (readonly AnnotationMark[])[],
) {
  const merged: AnnotationMark[] = [];
  for (const group of groups)
    for (const mark of group) {
      if (merged.length >= ANNOTATION_EDITOR_LIMIT) break;
      if (!merged.some((m) => mark.start < m.end && mark.end > m.start))
        merged.push(mark);
    }
  return merged.sort((a, b) => a.start - b.start);
}

type AnnotationState = Readonly<{
  revision: number;
  marks: readonly AnnotationMark[];
  set: DecorationSet;
}>;
const annotationKey = new PluginKey<AnnotationState>("composer-annotations");
type Shown = Readonly<{ revision: number; marks: readonly AnnotationMark[] }>;

function decorate(
  doc: EditorNode,
  marks: readonly AnnotationMark[],
  className: string,
) {
  const source = projectComposerDocument(doc);
  return DecorationSet.create(
    doc,
    marks.map((mark) =>
      Decoration.inline(
        source.position(mark.start),
        source.position(mark.end, -1),
        {
          class: className,
          "aria-invalid": mark.kind ?? "true",
          "data-annotation": "",
        },
        { text: mark.text },
      ),
    ),
  );
}

/** Underlines for the marks shown at the current revision. After an edit the
 * marks stop being actionable; underlines whose text changed are dropped, others
 * follow their text until the next publication. Under an IME composition the
 * underlines only move, so the composing text node is left alone. */
export function annotationPlugin(className: string, composing: () => boolean) {
  return new Plugin<AnnotationState>({
    key: annotationKey,
    state: {
      init: () => ({ revision: 0, marks: [], set: DecorationSet.empty }),
      apply(tr, value, _old, state) {
        const shown = tr.getMeta(annotationKey) as Shown | undefined;
        if (shown)
          return {
            revision: shown.revision,
            marks: shown.marks,
            set: decorate(state.doc, shown.marks, className),
          };
        if (!tr.docChanged) return value;
        let set = value.set.map(tr.mapping, tr.doc);
        if (!composing())
          set = set.remove(
            set
              .find()
              .filter(
                (item) =>
                  item.from >= item.to ||
                  tr.doc.textBetween(item.from, item.to) !==
                    (item.spec as { text: string }).text,
              ),
          );
        return { revision: 0, marks: [], set };
      },
    },
    props: {
      decorations(state) {
        const value = annotationKey.getState(state);
        if (!value) return null;
        // Text being typed is not marked until the caret leaves it.
        const { empty, head } = state.selection;
        const typing = empty
          ? value.set.find(head, head).filter((item) => item.to === head)
          : [];
        return typing.length ? value.set.remove(typing) : value.set;
      },
    },
  });
}

/** A transaction showing `marks`, or nothing when the revision is no longer current. */
export function showAnnotations(
  state: EditorState,
  revision: number,
  marks: readonly AnnotationMark[],
): Transaction | undefined {
  if (marks.length && revision !== annotationRevision(state.doc)) return;
  const current = annotationKey.getState(state);
  if (!marks.length && !current?.set.find().length) return;
  return state.tr
    .setMeta(annotationKey, { revision, marks } satisfies Shown)
    .setMeta("addToHistory", false);
}

/** The marks actionable now: those last shown, until the draft changes. A
 * withdrawn or replaced publication's marks are no longer among them. */
export function shownAnnotations(
  state: EditorState,
): readonly AnnotationMark[] {
  const value = annotationKey.getState(state);
  return value && value.revision === annotationRevision(state.doc)
    ? value.marks
    : [];
}

/** The actionable mark at a document position, only at the revision it was shown for. */
export function annotationAt(state: EditorState, position: number) {
  const value = annotationKey.getState(state);
  if (!value || value.revision !== annotationRevision(state.doc)) return;
  const offset = projectComposerDocument(state.doc).source(position);
  const mark = value.marks.find(
    (mark) => mark.start <= offset && offset <= mark.end,
  );
  return mark && word(state, mark) ? mark : undefined;
}

/** The mark's text as one uniformly formatted run, or nothing. */
function word(state: EditorState, mark: AnnotationMark) {
  const source = projectComposerDocument(state.doc);
  if (source.draft.text.slice(mark.start, mark.end) !== mark.text) return;
  const from = source.position(mark.start),
    to = source.position(mark.end, -1);
  if (state.doc.textBetween(from, to) !== mark.text) return;
  let marks: readonly Mark[] | undefined;
  let uniform = true;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isInline) return;
    if (!node.isText) uniform = false;
    else if (!marks) marks = node.marks;
    else if (!sameMarks(marks, node.marks)) uniform = false;
  });
  return uniform && marks ? { from, to, marks } : undefined;
}

/** Replace a shown mark's text with one of its replacements, as its own undo
 * step. The text must still be the same uniformly formatted run at the same
 * revision; the caret, when inside it, moves after the replacement. */
export function replaceAnnotation(
  state: EditorState,
  revision: number,
  target: Readonly<{ start: number; end: number; text: string }>,
  replacement: string,
): Transaction | undefined {
  const value = annotationKey.getState(state);
  const mark = value?.marks.find(
    (mark) =>
      mark.start === target.start &&
      mark.end === target.end &&
      mark.text === target.text,
  );
  if (
    !value ||
    !mark ||
    value.revision !== revision ||
    revision !== annotationRevision(state.doc) ||
    !mark.replacements.some((choice) => choice.text === replacement)
  )
    return;
  const range = word(state, mark);
  if (!range) return;
  const { from, to, marks } = range;
  const tr = closeHistory(state.tr);
  if (replacement)
    tr.replaceWith(from, to, composerSchema.text(replacement, marks));
  else tr.delete(from, to);
  // A selection touching the text (as a right-click selects it) collapses
  // after the replacement; any other selection maps through the edit.
  if (state.selection.from <= to && state.selection.to >= from)
    tr.setSelection(TextSelection.create(tr.doc, from + replacement.length));
  return tr;
}
function sameMarks(a: readonly Mark[], b: readonly Mark[]) {
  return a.length === b.length && a.every((mark, i) => b[i]?.eq(mark));
}
