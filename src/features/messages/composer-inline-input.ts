import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import type { MarkType } from "prosemirror-model";
import { TextSelection, type Transaction } from "prosemirror-state";
import {
  composerSchema as schema,
  projectComposerDocument,
  composerMarkdownContext,
} from "./composer-document";

/** Typed characters that can close an inline span. */
export const composerInlineDelimiters: ReadonlySet<string> = new Set([
  "`",
  "*",
  "_",
  "~",
]);

const INLINE_MARKS = {
  strong: schema.marks.bold,
  emphasis: schema.marks.italic,
  delete: schema.marks.strike,
  inlineCode: schema.marks.code,
} as const;
type InlineType = keyof typeof INLINE_MARKS;
const isInline = (type: string): type is InlineType => type in INLINE_MARKS;

// No input rules inside links, images, HTML, or fenced/indented code. The
// schema has no heading node, so a `# Title` line stays a paragraph, but the
// timeline renders it as a heading with its spans styled; those spans convert.
const CONTAINERS = new Set([
  "root",
  "paragraph",
  "heading",
  "strong",
  "emphasis",
  "delete",
  "blockquote",
  "list",
  "listItem",
]);

const children = (node: Nodes): readonly Nodes[] =>
  "children" in node ? node.children : [];

type Span = {
  mark: MarkType;
  start: number;
  innerStart: number;
  innerEnd: number;
  end: number;
};

/** One parsed span at the source offsets the parser reports. */
function spanOf(node: Nodes, start: number, end: number, raw: string) {
  if (!isInline(node.type)) return;
  let delimiter: number;
  switch (node.type) {
    case "strong":
      delimiter = 2;
      break;
    case "emphasis":
      delimiter = 1;
      break;
    case "delete":
      delimiter = /^~+/.exec(raw)?.[0].length ?? 0;
      break;
    default:
      // Only the backtick run delimits a code span; a `~` right after the
      // opener (`~/path`) is content, not part of the delimiter.
      delimiter = /^`+/.exec(raw)?.[0].length ?? 0;
  }
  if (!delimiter) return;
  let innerStart = start + delimiter,
    innerEnd = end - delimiter;
  if (node.type === "inlineCode") {
    const value = raw.slice(delimiter, raw.length - delimiter);
    // CommonMark removes one boundary space when both surround nonspace text.
    if (value.startsWith(" ") && value.endsWith(" ") && /[^ ]/.test(value)) {
      innerStart++;
      innerEnd--;
    }
  }
  if (innerStart >= innerEnd) return;
  const span: Span = {
    mark: INLINE_MARKS[node.type],
    start,
    innerStart,
    innerEnd,
    end,
  };
  return span;
}

/** Offsets of every unescaped `typed` character in a literal text node's
 * source. Each character of a run counts, so a run beside a span is found
 * whichever of its characters touches the span. */
function literalDelimiters(text: string, typed: string): number[] {
  const offsets: number[] = [];
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (escaped) escaped = false;
    else if (char === "\\") escaped = true;
    else if (char === typed) offsets.push(i);
  }
  return offsets;
}

/** Adopt only the inline span just closed by typing, never pasted/restored
 * Markdown or fenced blocks. The parser owns escapes, flanking and delimiter
 * matching, so the composer styles exactly what recipients will render. */
export function applyComposerInlineInput(
  tr: Transaction,
  typed: string,
): boolean {
  if (!composerInlineDelimiters.has(typed) || !tr.selection.empty) return false;
  if (tr.selection.$from.parent.type.spec.code) return false;
  const source = projectComposerDocument(tr.doc);
  const caret = source.source(tr.selection.from);
  const markdown = composerMarkdownContext(tr.doc, source).text;
  // The serializer's parser family, so flanking rules match the timeline. GFM
  // single-tilde ~x~ is deliberately excluded: the serializer emits ~~x~~, and
  // a lone ~ in prose (approximate values, paths) must not strike while typing.
  const tree = fromMarkdown(markdown, {
    extensions: [gfmStrikethrough({ singleTilde: false })],
    mdastExtensions: [gfmStrikethroughFromMarkdown()],
  });
  const pending: Nodes[] = [tree];
  const literal: number[] = [];
  let matched: { node: Nodes; start: number; end: number } | undefined;
  while (pending.length) {
    const node = pending.pop();
    if (!node) break;
    const start = node.position?.start.offset,
      end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    if (!matched && isInline(node.type) && end === caret) {
      matched = { node, start, end };
      continue;
    }
    if (node.type === "text")
      for (const offset of literalDelimiters(markdown.slice(start, end), typed))
        literal.push(start + offset);
    if (CONTAINERS.has(node.type)) pending.push(...children(node));
  }
  if (!matched) return false;
  if (/[\r\n]/.test(markdown.slice(matched.start, matched.end))) return false;
  // A shorter inner pair can look complete while a longer opener is unfinished
  // (**a*, ``a`b`). Wait for that outer delimiter rather than consuming the pair.
  // Backtick runs pair only by exact length, so any literal backtick earlier on
  // the line may still be that opener. For *, _ and ~ the parser's flanking
  // rules have already settled the pairing, so only a literal run touching the
  // span's opening delimiter is an unfinished outer run: snake_case _x_ and
  // 5 * 3 is *great* convert exactly as the timeline renders them.
  const { start: matchedStart } = matched;
  const lineStart = markdown.lastIndexOf("\n", matchedStart - 1) + 1;
  const unfinished =
    typed === "`"
      ? literal.some((offset) => offset >= lineStart && offset < matchedStart)
      : literal.includes(matchedStart - 1);
  if (unfinished) return false;
  // Nested spans (***x***) each add their own mark. A link, image, HTML or
  // code span inside keeps its source text and only receives the outer mark.
  const spans: Span[] = [];
  const nested: Nodes[] = [matched.node];
  while (nested.length) {
    const node = nested.pop();
    if (!node) break;
    const start = node.position?.start.offset,
      end = node.position?.end.offset;
    if (start === undefined || end === undefined) return false;
    const span = spanOf(node, start, end, markdown.slice(start, end));
    if (!span) return false;
    spans.push(span);
    if (node.type !== "inlineCode")
      for (const child of children(node))
        if (isInline(child.type) && child.type !== "inlineCode")
          nested.push(child);
  }
  const outer = spans[0];
  if (!outer) return false;
  // Every delimiter must sit at an editable boundary, never inside an atom.
  const at = (
    project: ReturnType<typeof projectComposerDocument>,
    offset: number,
    bias = 1,
  ) => {
    const position = project.position(offset, bias);
    return project.source(position) === offset ? position : undefined;
  };
  const from = at(source, outer.start),
    to = at(source, outer.end, -1);
  if (from === undefined || to === undefined) return false;
  if (
    (["code", "link", "literal"] as const).some((name) =>
      tr.doc.rangeHasMark(from, to, schema.marks[name]),
    )
  )
    return false;
  const inherited = tr.selection.$from.marks();
  let project = source;
  if (outer.mark === schema.marks.code) {
    // URLs/mentions may already be atoms. Expand them on this transaction, keeping
    // explicit recipient provenance; never normalize until the code mark exists.
    for (const token of [...source.tokens].reverse()) {
      if (token.from < from || token.to > to) continue;
      const marks = token.node.attrs.recipient
        ? [
            ...token.node.marks,
            schema.marks.recipient.create(token.node.attrs.recipient),
          ]
        : token.node.marks;
      tr.replaceWith(
        token.from,
        token.to,
        schema.text(token.node.attrs.source, marks),
      );
    }
    project = projectComposerDocument(tr.doc);
  }
  // Emphasis marks apply across mention/emoji atoms, so chips and recipients
  // survive; only code turns them into literal text. An italic recipient is
  // serialized as *@Honey*, a form the timeline still binds, where _@Honey_
  // would not (see paragraphMarkdown), so the conversion needs no exception.
  const edits: {
    mark: MarkType;
    first: number;
    innerStart: number;
    innerEnd: number;
    last: number;
  }[] = [];
  for (const span of spans) {
    const first = at(project, span.start),
      innerStart = at(project, span.innerStart),
      innerEnd = at(project, span.innerEnd, -1),
      last = at(project, span.end, -1);
    if (
      first === undefined ||
      innerStart === undefined ||
      innerEnd === undefined ||
      last === undefined
    )
      return false;
    edits.push({ mark: span.mark, first, innerStart, innerEnd, last });
  }
  const outerEdit = edits[0];
  if (!outerEdit) return false;
  const steps = tr.steps.length;
  for (const edit of edits)
    tr.addMark(edit.innerStart, edit.innerEnd, edit.mark.create());
  // Delimiter ranges are disjoint; deleting from the end keeps positions valid.
  const deletions = edits
    .flatMap((edit) => [
      [edit.innerEnd, edit.last] as const,
      [edit.first, edit.innerStart] as const,
    ])
    .sort((a, b) => b[0] - a[0]);
  for (const [start, end] of deletions) tr.delete(start, end);
  const end = tr.mapping.slice(steps).map(outerEdit.innerEnd, -1);
  tr.setSelection(TextSelection.create(tr.doc, end));
  // The closing delimiter exits the span. Code leaves ordinary text, as before;
  // emphasis keeps only the marks the typed text already carried.
  const added = new Set(edits.map((edit) => edit.mark));
  tr.setStoredMarks(
    outer.mark === schema.marks.code
      ? []
      : inherited.filter((mark) => !added.has(mark.type)),
  );
  return true;
}
