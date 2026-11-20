import {
  EditorState,
  AllSelection,
  Selection,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import {
  wrapInList,
  liftListItem,
  sinkListItem,
  splitListItemKeepMarks,
} from "prosemirror-schema-list";
import {
  lift,
  setBlockType,
  wrapIn,
  splitBlock,
  exitCode,
} from "prosemirror-commands";
import type { Command } from "prosemirror-state";
import type { ResolvedPos } from "prosemirror-model";
import {
  composerSchema as schema,
  projectComposerDocument,
} from "./composer-document";
import type { BlockFormat } from "./composer-dom";
import type { ComposerMarkdownMode } from "./composer-markdown";

export function activeBlockFormats(state: EditorState): BlockFormat[] {
  const selection =
    state.selection instanceof AllSelection
      ? TextSelection.between(
          Selection.atStart(state.doc).$from,
          Selection.atEnd(state.doc).$to,
        )
      : state.selection;
  const { $from, from, to } = selection;
  const active: BlockFormat[] = [];
  if ($from.parent.type === schema.nodes.code_block) {
    let all = true;
    state.doc.nodesBetween(from, to, (node) => {
      if (node.isTextblock && node.type !== schema.nodes.code_block)
        all = false;
    });
    if (all) active.push("code_block");
  }
  let foundList = false;
  for (let depth = $from.depth; depth > 0; depth--) {
    const name = $from.node(depth).type.name;
    if (name === "bullet_list" || name === "ordered_list") {
      if (foundList) continue;
      foundList = true;
    }
    if (
      ["blockquote", "bullet_list", "ordered_list"].includes(name) &&
      to <= $from.end(depth) &&
      !active.includes(name as BlockFormat)
    )
      active.push(name as BlockFormat);
  }
  return active;
}

/** Block toggles isolate the selected prose, or the caret's newline-delimited
 * line. Splits and the format itself remain a single history transaction. */
function isolate(tr: Transaction) {
  const selection = tr.selection;
  let { from, to } = selection;
  const backward = selection.anchor > selection.head;
  if (
    selection.empty &&
    selection.$from.parent.type === schema.nodes.paragraph
  ) {
    const source = projectComposerDocument(tr.doc);
    const text = source.draft.text,
      caret = source.source(from);
    const block = source.blocks.find(
      (block) => from >= block.from && from <= block.to,
    );
    if (!block) return;
    const start = Math.max(block.start, text.lastIndexOf("\n", caret - 1) + 1);
    const newline = text.indexOf("\n", caret);
    from = source.position(start);
    to =
      newline < 0 ? block.to : Math.min(block.to, source.position(newline, -1));
  }
  // Raw newlines are existing prose, not extra empty paragraphs around a block.
  const split = (position: number, before: boolean) => {
    const $pos = tr.doc.resolve(position);
    if ($pos.parent.type !== schema.nodes.paragraph) return;
    if (
      (!before && $pos.parentOffset === $pos.parent.content.size) ||
      (before && $pos.parentOffset === 0)
    )
      return;
    const adjacent = before ? $pos.nodeBefore : $pos.nodeAfter;
    if (
      adjacent?.isText &&
      (before
        ? adjacent.textContent.endsWith("\n")
        : adjacent.textContent.startsWith("\n"))
    ) {
      const start = before ? position - 1 : position;
      tr.delete(start, start + 1);
      if (before) position--;
    } else if (adjacent?.type === schema.nodes.hard_break) {
      const start = before ? position - 1 : position;
      tr.delete(start, start + 1);
      if (before) position--;
    }
    tr.split(position);
  };
  let caret = selection.from;
  const isolateEdge = (position: number, before: boolean) => {
    const steps = tr.steps.length;
    split(position, before);
    const mapping = tr.mapping.slice(steps),
      bias = before ? 1 : -1;
    from = mapping.map(from, bias);
    to = mapping.map(to, bias);
    caret = mapping.map(caret, bias);
  };
  isolateEdge(to, false);
  isolateEdge(from, true);
  if (selection.empty) tr.setSelection(TextSelection.create(tr.doc, caret));
  else
    tr.setSelection(
      TextSelection.create(tr.doc, backward ? to : from, backward ? from : to),
    );
}

/** Use native ProseMirror block commands, composing their steps into the same
 * transaction as token expansion/selection isolation. No second history owner. */
export function apply(tr: Transaction, command: Command) {
  const state = EditorState.create({
    doc: tr.doc,
    selection: tr.selection,
    storedMarks: tr.storedMarks,
  });
  return command(state, (next) => {
    for (const step of next.steps) tr.step(step);
    tr.setSelection(next.selection.getBookmark().resolve(tr.doc));
    if (next.storedMarksSet) tr.setStoredMarks(next.storedMarks);
  });
}

export function toggleComposerBlock(
  state: EditorState,
  format: BlockFormat,
): Transaction | undefined {
  const tr = state.tr;
  const formats = activeBlockFormats(state);
  const active = formats.includes(format);
  const list = format === "bullet_list" || format === "ordered_list";
  const inList = formats.some(
    (name) => name === "bullet_list" || name === "ordered_list",
  );
  if (list && inList) {
    if (active)
      return apply(tr, liftListItem(schema.nodes.list_item)) ? tr : undefined;
    // Switch the selected list owner in place, never lift into an ancestor
    // merely because that ancestor already uses the requested marker style.
    const { $from } = state.selection;
    for (let depth = $from.depth; depth > 0; depth--) {
      if (["bullet_list", "ordered_list"].includes($from.node(depth).type.name))
        return tr.setNodeMarkup($from.before(depth), schema.nodes[format]);
    }
  }
  // The first child of a list item must stay a paragraph. Lift before replacing
  // it with a code/quote block, rather than leaving the toolbar silently inert.
  if (
    !list &&
    inList &&
    !active &&
    !apply(tr, liftListItem(schema.nodes.list_item))
  )
    return;
  if (format === "blockquote" && active)
    return apply(tr, lift) ? tr : undefined;
  if (format === "code_block" && active)
    return apply(tr, setBlockType(schema.nodes.paragraph))
      ? tr.setStoredMarks([])
      : undefined;
  isolate(tr);
  if (list) {
    // Prose keeps authored newlines inside paragraphs. A list command turns
    // those selected lines into separate items without changing source text.
    apply(tr, setBlockType(schema.nodes.paragraph));
    const breaks: number[] = [];
    tr.doc.nodesBetween(tr.selection.from, tr.selection.to, (node, pos) => {
      if (node.type !== schema.nodes.paragraph) return;
      node.forEach((child, offset) => {
        if (child.isText)
          for (let i = 0; i < child.textContent.length; i++) {
            if (child.textContent[i] === "\n")
              breaks.push(pos + 1 + offset + i);
          }
        else if (child.type === schema.nodes.hard_break)
          breaks.push(pos + 1 + offset);
      });
      return false;
    });
    for (const pos of breaks.reverse()) {
      tr.delete(pos, pos + 1);
      tr.split(pos);
    }
    return apply(tr, wrapInList(schema.nodes[format])) ? tr : undefined;
  }
  if (format === "blockquote")
    return apply(tr, wrapIn(schema.nodes.blockquote)) ? tr : undefined;
  // Expand all leaves in the affected textblocks, including a collapsed caret's
  // line, before applying the text-only schema. Explicit recipient intent stays.
  const leaves: { pos: number; node: import("prosemirror-model").Node }[] = [];
  tr.doc.nodesBetween(tr.selection.from, tr.selection.to, (block, pos) => {
    if (!block.isTextblock) return;
    block.forEach((node, offset) => {
      if (!node.isText) leaves.push({ pos: pos + 1 + offset, node });
    });
    return false;
  });
  for (const { pos, node } of leaves.reverse()) {
    const text =
      node.type === schema.nodes.hard_break
        ? "\n"
        : (node.attrs.source as string);
    const marks = node.attrs.recipient
      ? [schema.marks.recipient.create(node.attrs.recipient)]
      : [];
    tr.replaceWith(pos, pos + node.nodeSize, schema.text(text, marks));
  }
  if (!apply(tr, setBlockType(schema.nodes.code_block))) return;
  // Multiple selected paragraphs become one code block, not separate fences.
  const joins: number[] = [];
  tr.doc.nodesBetween(tr.selection.from, tr.selection.to, (node, pos) => {
    if (
      node.type === schema.nodes.code_block &&
      tr.doc.resolve(pos).nodeBefore?.type === node.type &&
      pos > tr.selection.from
    )
      joins.push(pos);
  });
  for (const pos of joins.reverse()) {
    tr.insertText("\n", pos - 1);
    tr.join(pos + 1);
  }
  return tr.setStoredMarks([]);
}

/** Typed characters that can complete a fence line. */
export const composerFenceDelimiters: ReadonlySet<string> = new Set(["`", "~"]);
// The fence the composer converts as it is typed: exactly three backticks or
// tildes filling the caret's line. The third character is the trigger, so an
// info string can never be typed before the block opens, and a fourth character
// typed after undoing the conversion leaves the line literal.
const FENCE = /^(`{3}|~{3})$/;
// Any fence line CommonMark accepts in authored source, for reading the other
// lines of the paragraph: up to three spaces of indentation and any info string.
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

type Fence = { marker: string; length: number };

/** The fence a line opens or closes, as the timeline will read it. A block
 * closes only on a line holding the opening marker, at least as long, followed
 * by nothing but whitespace; a backtick fence's info string cannot hold a
 * backtick. */
function readFence(line: string, open: Fence | undefined): Fence | undefined {
  const match = FENCE_LINE.exec(line);
  const run = match?.[1],
    info = match?.[2] ?? "";
  if (!run) return open;
  const marker = run[0] ?? "";
  if (!open)
    return marker === "~" || !info.includes("`")
      ? { marker, length: run.length }
      : undefined;
  return marker === open.marker && run.length >= open.length && !info.trim()
    ? undefined
    : open;
}

/** Whether authored lines leave a fenced block open. */
function insideFence(lines: readonly string[]): boolean {
  let open: Fence | undefined;
  for (const line of lines) open = readFence(line, open);
  return !!open;
}

/** Whether one of the lines below a fence closes it. */
function closedBelow(fence: Fence, lines: readonly string[]): boolean {
  return lines.some((line) => !readFence(line, fence));
}

/** Draft offsets of the run of sibling paragraphs holding the caret's. Sibling
 * paragraphs serialise joined by single newlines, exactly as the draft text
 * holds them, so the timeline reads the run as one source context: a fence
 * opened or closed in one paragraph counts for the others, and a toolbar
 * toggle that splits a paragraph changes nothing on the wire. Any other block
 * between two paragraphs ends the run. */
function paragraphRun(
  $from: ResolvedPos,
  source: ReturnType<typeof projectComposerDocument>,
): { start: number; end: number } {
  const depth = $from.depth,
    parent = $from.node(depth - 1);
  let first = $from.index(depth - 1),
    last = first,
    from = $from.before(depth),
    to = $from.after(depth);
  while (first > 0 && parent.child(first - 1).type === schema.nodes.paragraph)
    from -= parent.child(--first).nodeSize;
  while (
    last + 1 < parent.childCount &&
    parent.child(last + 1).type === schema.nodes.paragraph
  )
    to += parent.child(++last).nodeSize;
  return { start: source.source(from), end: source.source(to - 1) };
}

/** Typing the third character of a line holding only ``` or ~~~ turns that line
 * into a code block at once, without waiting for Enter. Only a fence the typed
 * character completes at the end of its line qualifies: a fence that closes or
 * sits inside a block the other lines of its paragraph, or of the sibling
 * paragraphs joined to it on the wire, open (pasted source, a message opened
 * for editing, or a paragraph a toolbar toggle split), fences inside
 * code/link/literal ranges or tokens, and any line inside an existing code
 * block stay literal source. The transaction carries the deletion and the
 * block; the caller closes history around it, so one undo restores the typed
 * fence. */
export function composerCodeFence(
  state: EditorState,
  typed: string,
): Transaction | undefined {
  const { $from, empty } = state.selection;
  if (!composerFenceDelimiters.has(typed) || !empty) return;
  if ($from.parent.type !== schema.nodes.paragraph) return;
  const source = projectComposerDocument(state.doc);
  const text = source.draft.text;
  const caret = source.source($from.pos);
  const block = source.blocks.find(
    (block) => $from.pos >= block.from && $from.pos <= block.to,
  );
  if (!block) return;
  // The caret must end the fence line; text after it would be a code line.
  if (caret !== source.source(block.to) && text[caret] !== "\n") return;
  const start = Math.max(block.start, text.lastIndexOf("\n", caret - 1) + 1);
  const match = FENCE.exec(text.slice(start, caret));
  if (!match || match[1]?.[0] !== typed) return;
  // A closing fence, a fence line inside an open block, or an opening fence a
  // later line already closes is authored source the timeline renders as code:
  // it never opens a second block. The lines read are those of the whole run
  // of sibling paragraphs, since the wire joins them with single newlines.
  const run = paragraphRun($from, source);
  if (insideFence(text.slice(run.start, start).split("\n"))) return;
  const below = text.slice(caret, run.end);
  if (
    below &&
    closedBelow({ marker: typed, length: 3 }, below.slice(1).split("\n"))
  )
    return;
  const from = source.position(start),
    to = $from.pos;
  if (source.source(from) !== start) return;
  let plain = true;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isInline) return;
    if (
      !node.isText ||
      (["code", "link", "literal"] as const).some((name) =>
        schema.marks[name].isInSet(node.marks),
      )
    )
      plain = false;
  });
  if (!plain) return;
  const tr = state.tr.delete(from, to);
  isolate(tr);
  if (!apply(tr, setBlockType(schema.nodes.code_block))) return;
  return tr.setStoredMarks([]);
}

/** The typed character that completes a block prefix. */
export const composerPrefixDelimiters: ReadonlySet<string> = new Set([" "]);
// A block prefix filling the caret's line up to the typed space, as CommonMark
// reads it: a bullet marker, one to nine digits with a dot or parenthesis, or a
// quote marker. Every form the timeline renders as a list converts, so `* `,
// `+ ` and `1) ` open blocks although the serializer writes each bullet as `- `
// and each number with a dot; the sent text renders the same either way.
// A typed Unicode bullet is a convenience alias, serialized as Markdown `- `.
const PREFIX = /^(?:([-*+•])|(\d{1,9})[.)]|>) $/;
const DOCUMENT_HEADING_PREFIX = /^#{1,6} $/;
// Positions to read before the caret: the widest prefix and its space, plus the
// character before them, so the cheap check sees whether the line starts there.
const PREFIX_WINDOW = 12;

/** Typing the space after a lone `- `, `1. ` or `> ` marker turns the caret's
 * line into a list item or quoted paragraph at once. In documents, one to six
 * hashes and a space open a heading. Prose after the caret becomes the block's
 * content, and the paragraph's other lines stay where they are. Inside a quote
 * the markers nest a list or a second quote; inside a list item a marker of
 * the item's own list kind, typed as the only text of an item after the first,
 * nests that item as Tab does. A marker typed after prose, as code, link or
 * literal text, inside a code block, or inside pasted fenced source stays
 * literal; chips, links and formatting later on the line move into the block.
 * The caller closes history around the transaction, so one undo restores the
 * typed prefix. */
export function composerBlockPrefix(
  state: EditorState,
  typed: string,
  mode: ComposerMarkdownMode = "chat",
): Transaction | undefined {
  const { $from, empty } = state.selection;
  if (!composerPrefixDelimiters.has(typed) || !empty) return;
  if ($from.parent.type !== schema.nodes.paragraph) return;
  // Space is typed constantly; read only the caret's line before projecting.
  const offset = $from.parentOffset;
  const window = $from.parent.textBetween(
    Math.max(0, offset - PREFIX_WINDOW),
    offset,
  );
  const newline = window.lastIndexOf("\n");
  if (newline < 0 && offset > PREFIX_WINDOW) return;
  const line = window.slice(newline + 1);
  const heading =
    mode === "document" ? DOCUMENT_HEADING_PREFIX.exec(line) : null;
  const match = heading ?? PREFIX.exec(line);
  if (!match) return;
  const kind = heading
    ? "heading"
    : match[1]
      ? "bullet_list"
      : match[2]
        ? "ordered_list"
        : "blockquote";
  // Nesting converts where the schema can hold the shape the timeline reads
  // from the sent text. A paragraph in the document or in a quote wraps, so
  // `> ` inside a quote nests a second quote as `> > inner` renders. A list
  // item's first child must stay a paragraph, so a marker typed there can only
  // nest the item itself, as Tab does: a marker of the item's own list kind,
  // typed as the only text of an item after the first, sinks that item. A
  // quote marker or a marker of the other list kind inside an item, a marker
  // in a list's first item, or one beside the item's prose stays literal text
  // that still nests once sent: the timeline shows a quote or list inside that
  // item where the composer shows the marker.
  const sink =
    kind !== "heading" &&
    $from.node($from.depth - 1).type === schema.nodes.list_item;
  if (
    sink &&
    ($from.node($from.depth - 2).type !== schema.nodes[kind] ||
      $from.index($from.depth - 1) !== 0 ||
      $from.index($from.depth - 2) === 0 ||
      $from.parent.textContent !== match[0])
  )
    return;
  const source = projectComposerDocument(state.doc);
  const text = source.draft.text;
  const caret = source.source($from.pos);
  const block = source.blocks.find(
    (block) => $from.pos >= block.from && $from.pos <= block.to,
  );
  if (!block) return;
  const start = Math.max(block.start, text.lastIndexOf("\n", caret - 1) + 1);
  if (text.slice(start, caret) !== match[0]) return;
  // A marker inside authored fenced source is a code line on the timeline,
  // whichever paragraph of the run the fence was opened in.
  if (
    insideFence(
      text.slice(paragraphRun($from, source).start, start).split("\n"),
    )
  )
    return;
  const from = source.position(start),
    to = $from.pos;
  if (source.source(from) !== start) return;
  // Only the marker must be typed prose. Chips, links and code after it move
  // into the block with the line's text, as the toolbar toggle keeps them.
  let plain = true;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isInline) return;
    if (
      !node.isText ||
      (["code", "link", "literal"] as const).some((name) =>
        schema.marks[name].isInSet(node.marks),
      )
    )
      plain = false;
  });
  if (!plain) return;
  const marks = $from.marks();
  const tr = state.tr.delete(from, to);
  if (sink) {
    if (!apply(tr, sinkListItem(schema.nodes.list_item))) return;
    // A sunk item joins the previous item's nested list when there is one, as
    // Tab does, and the typed number is then a continuation. A new nested list
    // starts at the typed number, as a top-level marker does.
    const $sunk = tr.selection.$from,
      depth = $sunk.depth - 2;
    if (kind === "ordered_list" && $sunk.node(depth).childCount === 1)
      tr.setNodeMarkup($sunk.before(depth), undefined, {
        order: Number(match[2]),
      });
  } else {
    isolate(tr);
    const command =
      kind === "heading"
        ? setBlockType(schema.nodes.heading, { level: match[0].length - 1 })
        : kind === "blockquote"
          ? wrapIn(schema.nodes.blockquote)
          : wrapInList(
              schema.nodes[kind],
              kind === "ordered_list" ? { order: Number(match[2]) } : null,
            );
    if (!apply(tr, command)) return;
  }
  // The marker's own marks (an explicit Bold typing mode) continue into the
  // block, as the typed prose already carried them.
  return marks.length ? tr.setStoredMarks(marks) : tr;
}

/** A caret leaving a code block by an arrow key, past the edge of the block in
 * that direction, lands in an empty paragraph opened there when no textblock
 * lies beyond, as Enter on the block's empty last line opens one below it.
 * Elsewhere the native caret motion already leaves the block. The caller
 * decides that the caret is at the block's edge in the key's direction. */
export function composerCodeBlockExit(
  state: EditorState,
  forward: boolean,
): Transaction | undefined {
  const { $head, empty } = state.selection;
  if (!empty || !$head.parent.type.spec.code) return;
  const edge = forward ? $head.after() : $head.before();
  const $edge = state.doc.resolve(edge);
  if (Selection.findFrom($edge, forward ? 1 : -1, true)) return;
  const index = $edge.index();
  if (!$edge.parent.canReplaceWith(index, index, schema.nodes.paragraph))
    return;
  const tr = state.tr.insert(edge, schema.nodes.paragraph.create());
  return tr
    .setSelection(TextSelection.create(tr.doc, edge + 1))
    .setStoredMarks([]);
}

/** A line break continues the block; an empty last line exits it. The host
 * owns when Enter sends or requests a line break. */
export function composerBlockLineBreak(
  state: EditorState,
): Transaction | undefined {
  const { $from, empty } = state.selection;
  const tr = state.tr;
  if ($from.parent.type === schema.nodes.code_block) {
    if (
      empty &&
      $from.parentOffset === $from.parent.content.size &&
      $from.parent.textContent.endsWith("\n")
    ) {
      tr.delete($from.pos - 1, $from.pos);
      return apply(tr, exitCode) ? tr.setStoredMarks([]) : undefined;
    }
    return tr.insertText("\n");
  }
  const formats = activeBlockFormats(state);
  if (
    formats.some((name) => name === "bullet_list" || name === "ordered_list")
  ) {
    return apply(tr, splitListItemKeepMarks(schema.nodes.list_item)) ||
      apply(tr, liftListItem(schema.nodes.list_item))
      ? tr
      : undefined;
  }
  if (formats.includes("blockquote")) {
    return apply(tr, empty && !$from.parent.content.size ? lift : splitBlock)
      ? tr
      : undefined;
  }
}
