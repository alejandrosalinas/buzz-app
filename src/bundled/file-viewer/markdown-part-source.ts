import { definitionSource } from "./markdown-container-definitions";
import { required } from "./markdown-limits";
// Assemble one requested part; retain at most that part's prepared source.
import type {
  DocumentParts,
  PreparedPart,
  DefinitionSpan,
} from "./document-parts";
import {
  footnoteLabelEnd,
  normalizeLabel,
  partContext,
  positionedReferenceDefinitions,
} from "./document-parts";
import { tableCells, tableIndent } from "./markdown-blocks";
import { MAX_RENDER_CHARS } from "./markdown-limits";
import {
  definitionBudget,
  referenceDefinitions,
  referenceLabelEnd,
} from "./markdown-references";
import { fenceLine } from "./markdown-fences";
import type { FenceState } from "./markdown-fences";
import { explicitHtmlStart, explicitHtmlEnd } from "./markdown-html-explicit";
import { startsBlankHtmlBlock, isStandaloneHtmlTag } from "./markdown-html";
/** Candidate labels, including shortcut/collapsed references and footnotes.
 * Definitions themselves are not uses; inline links need no external context. */
function references(
  source: string,
  literals = codeRanges(source),
  paragraph = false,
  budget = definitionBudget(),
  indexed?: ReturnType<typeof referenceDefinitions>,
): { label: string; note: boolean }[] | undefined {
  const found: { label: string; note: boolean }[] = [];
  const seen = new Set<string>();
  const add = (label: string, note: boolean) => {
    const key = `${note ? "note" : "link"}:${label}`;
    if (!seen.has(key)) {
      seen.add(key);
      found.push({ label, note });
    }
  };
  // Footnote calls take precedence over paired link labels and do not stop
  // being calls before `(text)`. Scan them independently so adjacent calls
  // cannot consume each other's definition requests as `[label][label]`.
  const notes = /\[\^/g;
  const noteInCode = literalCursor(literals);
  for (let match = notes.exec(source); match; match = notes.exec(source)) {
    if (noteInCode(match.index)) continue;
    let slashes = 0;
    for (let at = match.index - 1; at >= 0 && source[at] === "\\"; at--)
      slashes++;
    if (slashes % 2) continue;
    const end = footnoteLabelEnd(source, notes.lastIndex, source.length);
    if (end === undefined) continue;
    let before = match.index;
    while (before > 0 && match.index - before < 4 && source[before - 1] === " ")
      before--;
    const definition =
      source[end + 1] === ":" &&
      match.index - before <= 3 &&
      (before === 0 ||
        source[before - 1] === "\r" ||
        source[before - 1] === "\n");
    if (!definition)
      add(normalizeLabel(source.slice(notes.lastIndex, end)), true);
    notes.lastIndex = end + 1;
  }
  const inCode = literalCursor(literals);
  const definitionAt =
    indexed ??
    positionedReferenceDefinitions(
      source,
      paragraph,
      referenceDefinitions(source, budget),
    );
  for (let at = 0; at < source.length; at++) {
    if (source[at] === "\\") {
      at++;
      continue;
    }
    if (source[at] !== "[" || inCode(at)) continue;
    const end = referenceLabelEnd(source, at + 1);
    if (end === undefined) continue;
    let indent = 0;
    while (indent < 4 && source[at - indent - 1] === " ") indent++;
    const before = source[at - indent - 1];
    if (
      indent <= 3 &&
      (before === undefined || before === "\r" || before === "\n")
    ) {
      const definition = definitionAt(at - indent);
      if (budget.exhausted) return undefined;
      if (definition) {
        at = definition.end - 1;
        continue;
      }
    }
    let raw = source.slice(at + 1, end),
      last = end;
    if (source[end + 1] === "[") {
      if (source[end + 2] === "]") last = end + 2;
      else {
        const full = referenceLabelEnd(source, end + 2);
        if (full !== undefined) {
          raw = source.slice(end + 2, full);
          last = full;
        }
      }
    } else if (source[end + 1] === "(") {
      at = end;
      continue;
    }
    if (raw[0] !== "^") add(normalizeLabel(raw), false);
    at = last;
  }
  return found;
}

function* lines(
  source: string,
): Generator<{ start: number; end: number; next: number }> {
  const breaks = /\r\n|\r|\n/g;
  let start = 0;
  for (let match = breaks.exec(source); match; match = breaks.exec(source)) {
    yield { start, end: match.index, next: breaks.lastIndex };
    start = breaks.lastIndex;
  }
  if (start < source.length)
    yield { start, end: source.length, next: source.length };
}

/** Imported notes are parsed inside their four-column continuation container.
 * Collect descendants from that body so its tables and code keep their scope. */
function footnoteBody(source: string): string {
  const chunks: string[] = [];
  for (const line of lines(source)) {
    let at = line.start;
    if (!at) {
      at =
        required(footnoteLabelEnd(source, source.indexOf("[^") + 2, line.end)) +
        2;
      if (source[at] === " " || source[at] === "\t") at++;
    } else {
      let column = 0;
      while (column < 4 && (source[at] === " " || source[at] === "\t"))
        column += source[at++] === "\t" ? 4 - (column % 4) : 1;
      if (column < 4) at = line.start;
    }
    chunks.push(source.slice(at, line.next));
  }
  return chunks.join("");
}

type LiteralRange = { start: number; end: number };
const literalCursor = (ranges: readonly LiteralRange[]) => {
  let index = 0;
  return (offset: number): boolean => {
    while (index < ranges.length && required(ranges[index]).end <= offset)
      index++;
    return index < ranges.length && required(ranges[index]).start <= offset;
  };
};

/** Fenced blocks, comments and paired inline backticks never request definitions.
 * Pair runs only inside one leaf paragraph or table cell, in linear passes. */
function codeRanges(source: string): LiteralRange[] {
  const blocks: LiteralRange[] = [];
  const ticks: (LiteralRange & {
    size: number;
    paragraph: number;
    next?: number | undefined;
  })[] = [];
  let paragraphId = 0;
  let state: FenceState = { owners: [] },
    start = 0;
  let comment = false;
  let table = false;
  let previous:
    | {
        body: string;
        offset: number;
        ticks: number;
        next: number;
        indent: boolean;
      }
    | undefined;
  let htmlClose: string | RegExp | undefined,
    blankHtml = false;
  for (const line of lines(source)) {
    const content = source.slice(line.start, line.end);
    if (blankHtml && /^[\t ]*$/.test(content)) {
      blocks.push({ start, end: line.start });
      blankHtml = false;
    }
    const before = state,
      paragraph = state.paragraph;
    const syntax = fenceLine(
      content,
      state,
      comment || !!htmlClose || blankHtml,
    );
    state = syntax.after;
    if (syntax.endedBefore) blocks.push({ start, end: line.start });
    const sameOwners =
      before.owners.length === state.owners.length &&
      before.owners.every(
        (owner, index) => owner.id === required(state.owners[index]).id,
      );
    if (!syntax.code && !comment && !htmlClose && !blankHtml) {
      const tag = content.match(
        /^ {0,3}<(script|pre|style|textarea)(?:[\t >]|$)/i,
      )?.[1];
      if (tag) htmlClose = new RegExp(`</${tag}[\\t ]*>`, "i");
      else if (explicitHtmlStart(content))
        htmlClose = explicitHtmlEnd(required(explicitHtmlStart(content)));
      else if (
        startsBlankHtmlBlock(content) ||
        (!paragraph && isStandaloneHtmlTag(content))
      )
        blankHtml = true;
      if (htmlClose || blankHtml) start = line.start;
    }
    if (htmlClose || blankHtml) {
      previous = undefined;
      table = false;
      state = { ...state, paragraph: false };
      if (
        htmlClose &&
        (typeof htmlClose === "string"
          ? content.includes(htmlClose)
          : htmlClose.test(content))
      ) {
        blocks.push({ start, end: line.next });
        htmlClose = undefined;
      }
      continue;
    }
    if (!syntax.code && (comment || /^ {0,3}<!--/.test(content))) {
      previous = undefined;
      table = false;
      state = { ...state, paragraph: false };
      if (!comment) start = line.start;
      const close = content.indexOf("-->");
      comment = close < 0;
      if (!comment) blocks.push({ start, end: line.next });
      continue;
    }
    if (syntax.opened) start = line.start;
    if (syntax.code && !state.fence) blocks.push({ start, end: line.next });
    if (!syntax.code) {
      const body = syntax.body,
        offset = line.start + content.length - body.length;
      const cells = tableCells(body);
      const indent = tableIndent(content, body);
      const delimiter =
        sameOwners &&
        previous?.next === line.start &&
        previous.indent &&
        indent &&
        /[|:]/.test(body) &&
        cells.length === tableCells(previous.body).length &&
        cells.every((cell) =>
          /^[\t ]*:?-+:?[\t ]*$/.test(body.slice(cell.start, cell.end)),
        );
      if (!sameOwners || !state.paragraph) table = false;
      if (delimiter && previous) {
        // The delimiter confirms the preceding line was a header, not prose.
        // Reassign only the preceding line's runs in the visible-part inventory.
        let tick = previous.ticks;
        for (const cell of tableCells(previous.body)) {
          paragraphId++;
          while (
            tick < ticks.length &&
            required(ticks[tick]).start < previous.offset + cell.end
          )
            required(ticks[tick++]).paragraph = paragraphId;
        }
        table = true;
        previous = undefined;
        state = { ...state, paragraph: false };
        continue;
      }
      if (!before.paragraph || !state.paragraph || !sameOwners) paragraphId++;
      const firstTick = ticks.length;
      let cell = 0;
      for (const match of content.matchAll(/`+/g)) {
        if (table)
          while (
            cell < cells.length &&
            line.start + match.index >= offset + required(cells[cell]).end
          ) {
            paragraphId++;
            cell++;
          }
        ticks.push({
          start: line.start + match.index,
          end: line.start + match.index + required(match[0]).length,
          size: required(match[0]).length,
          paragraph: paragraphId,
        });
      }
      previous =
        !table && state.paragraph
          ? { body, offset, ticks: firstTick, next: line.next, indent }
          : undefined;
      if (table) state = { ...state, paragraph: false };
    } else {
      previous = undefined;
      table = false;
    }
  }
  if (state.fence || comment || htmlClose || blankHtml)
    blocks.push({ start, end: source.length });
  const next = new Map<number, number>();
  let paragraph = -1;
  for (let i = ticks.length - 1; i >= 0; i--) {
    if (required(ticks[i]).paragraph !== paragraph) {
      next.clear();
      paragraph = required(ticks[i]).paragraph;
    }
    required(ticks[i]).next = next.get(required(ticks[i]).size);
    next.set(required(ticks[i]).size, i);
  }
  const inline: LiteralRange[] = [];
  for (let i = 0; i < ticks.length; i++) {
    let slashes = 0;
    for (
      let at = required(ticks[i]).start - 1;
      at >= 0 && source[at] === "\\";
      at--
    )
      slashes++;
    if (slashes % 2 || required(ticks[i]).next === undefined) continue;
    const end = required(required(ticks[i]).next);
    inline.push({
      start: required(ticks[i]).start,
      end: required(ticks[end]).end,
    });
    i = end;
  }
  return [...blocks, ...inline].sort((a, b) => a.start - b.start);
}

/** CommonMark HTML block kinds which blank lines cannot terminate. */
function openHtmlTail(source: string): boolean {
  let state: FenceState = { owners: [] };
  let close: string | RegExp | undefined;
  for (const entry of lines(source)) {
    const line = source.slice(entry.start, entry.end);
    const syntax = fenceLine(line, state, !!close);
    state = syntax.after;
    if (!close) {
      if (syntax.code) continue;
      if (/^ {0,3}<!--/.test(line)) close = "-->";
      else if (explicitHtmlStart(line))
        close = explicitHtmlEnd(required(explicitHtmlStart(line)));
      else {
        const tag = line.match(
          /^ {0,3}<(script|pre|style|textarea)(?:[\t >]|$)/i,
        )?.[1];
        if (tag) close = new RegExp(`</${tag}[\\t ]*>`, "i");
      }
    }
    if (close) {
      state = { ...state, paragraph: false };
      if (typeof close === "string" ? line.includes(close) : close.test(line))
        close = undefined;
    }
  }
  return close !== undefined;
}

export function assemblePart(
  parts: DocumentParts,
  index: number,
): PreparedPart {
  const context = partContext(parts),
    text = context.text,
    part = required(parts.parts[index]);
  const originalSlice = text.slice(part.start, part.end);
  if (context.kind !== "markdown")
    return {
      source: originalSlice,
      prefix: 0,
      bodyStart: 0,
      bodyEnd: originalSlice.length,
      headingOffsets: new Map(),
    };
  const plain = (overflow: boolean, deep = false): PreparedPart => {
    // A longer delimiter cannot be closed by any run from the literal source.
    let longest = 2;
    for (const run of originalSlice.matchAll(/`+/g))
      longest = Math.max(longest, required(run[0]).length);
    const fence = "`".repeat(longest + 1),
      prefix = `${fence}\n`;
    return {
      source: `${prefix}${originalSlice}${/[\r\n]$/.test(originalSlice) ? "" : "\n"}${fence}`,
      prefix: prefix.length,
      bodyStart: prefix.length,
      bodyEnd: prefix.length + originalSlice.length,
      headingOffsets: new Map(),
      plain: true,
      ...(deep
        ? { fallback: "too-deep" as const }
        : overflow
          ? { fallback: "too-large" as const }
          : { fallback: "context" as const }),
    };
  };
  if (context.plain) return plain(true);
  let slice = originalSlice;
  // A forced cut may bisect a footnote. Its body is never ordinary source:
  // hide only crossing definitions, then import the full span if cited below.
  // Equal-length whitespace keeps heading and literal offsets unchanged.
  const notes = context?.notes ?? [];
  let first = 0,
    last = notes.length;
  while (first < last) {
    const middle = (first + last) >>> 1;
    if (required(notes[middle]).end <= part.start) first = middle + 1;
    else last = middle;
  }
  const kept: string[] = [];
  let copied = 0;
  for (
    let at = first;
    at < notes.length && required(notes[at]).start < part.end;
    at++
  ) {
    const note = required(notes[at]);
    if (note.start >= part.start && note.end <= part.end) continue;
    const from = Math.max(0, note.start - part.start),
      to = Math.min(slice.length, note.end - part.start);
    kept.push(
      slice.slice(copied, from),
      slice.slice(from, to).replace(/[^\r\n]/g, " "),
    );
    copied = to;
  }
  if (kept.length) slice = kept.join("") + slice.slice(copied);
  // Every local validation shares one budget. Failure must discard all local
  // precedence/context decisions before formatting, just like index failure.
  const localBudget = definitionBudget();
  const indexedDefinitions = context?.definitionAt;
  const definitionsFor = (
    base: number,
  ): ReturnType<typeof referenceDefinitions> | undefined =>
    indexedDefinitions
      ? (offset) => {
          const definition = indexedDefinitions(base + offset);
          return definition
            ? {
                ...definition,
                start: definition.start - base,
                end: definition.end - base,
              }
            : undefined;
        }
      : undefined;

  const start = required(context.starts[index]),
    end = required(context.ends[index]);
  const startComment = start.current
    ? start.current.commentEnd !== undefined &&
      start.offset < start.current.commentEnd
    : start.opaque?.kind === "comment";
  const endComment = end.current
    ? end.current.commentEnd !== undefined &&
      end.offset < end.current.commentEnd
    : end.opaque?.kind === "comment";
  const startParagraph = !!start.paragraph;
  const block = required(context.blocks[index]);
  const startFence = start.fence;
  const region = start.current?.region ?? start.opaque;
  // These wrappers supply CommonMark block context only. remarkPartHeadings
  // clips their bytes from raw HTML nodes before ReactMarkdown sees them.
  const htmlOwners = start.syntax?.owners ?? [];
  const ownerOpen = htmlOwners
    .map(
      (owner) =>
        " ".repeat(owner.relativeIndent) +
        owner.marker +
        " ".repeat(owner.padding),
    )
    .join("");
  const ownerContinue = htmlOwners
    .map((owner) =>
      owner.kind === "list"
        ? " ".repeat(owner.width)
        : `${" ".repeat(owner.relativeIndent)}>${" ".repeat(owner.padding)}`,
    )
    .join("");
  const htmlOpen = startComment
    ? "<!--"
    : region?.kind === "raw"
      ? `<${region.tag}>`
      : region?.kind === "html" || start.current?.htmlBlock
        ? "<div>"
        : region?.kind === "explicit"
          ? region.html.kind === "pi"
            ? "<?"
            : region.html.kind === "cdata"
              ? "<![CDATA["
              : "<!A"
          : "";
  const explicitTail =
    start.current?.explicit &&
    start.offset >= (start.current.explicitEnd ?? Infinity);
  const opaquePrefix = explicitTail
    ? `${ownerOpen}<!-- -->`
    : htmlOpen
      ? `${ownerOpen}${htmlOpen}\n${start.current ? ownerContinue : ""}`
      : "";
  const opaqueClose = "";
  if (block?.deep) return plain(false, true);
  if (start.inline || end.inline) return plain(false);
  const blockLength =
    (startFence ? 0 : (block?.prefix.length ?? 0)) +
    (block?.table
      ? block.table.end -
        block.table.start +
        block.table.indent +
        block.table.columns +
        2
      : 0);
  if (block?.overflow || blockLength > MAX_RENDER_CHARS - slice.length)
    return plain(true);
  const blockPrefix =
    (startFence ? "" : (block?.prefix ?? "")) +
    (block?.table
      ? " ".repeat(block.table.indent) +
        "|".repeat(block.table.columns + 1) +
        "\n" +
        text.slice(block.table.start, block.table.end)
      : "");
  const paragraphPrefix =
    startParagraph &&
    !blockPrefix &&
    !part.fence &&
    !startComment &&
    !!referenceDefinitions(slice, localBudget)(0);
  if (localBudget.exhausted) return plain(true);
  // A blank line already ended a condition-6/7 HTML block in the source;
  // reconstructed ancestors must allow Markdown to resume at the same point.

  const prefix =
    (opaquePrefix || blockPrefix) +
    (paragraphPrefix ? "\uE000" : "") +
    (startFence
      ? `${startFence.reopen}\n${required(context.starts[index]).current ? startFence.continuation : ""}`
      : part.fence
        ? `${part.fence}\n`
        : "");
  const commentClose = endComment ? "\n-->\n" : "";
  const endFence = required(context.ends[index]).fence;
  const closer = endFence
    ? `${/[\r\n]$/.test(slice) ? "" : "\n"}${endFence.close}\n`
    : "";
  const closingLength = closer.length;
  const baseLength =
    prefix.length +
    slice.length +
    closingLength +
    commentClose.length +
    opaqueClose.length;
  if (baseLength > MAX_RENDER_CHARS) return plain(true);

  const selected: DefinitionSpan[] = [];
  const visited = new Set<string>();
  // Scan the actual reconstructed containers, then translate ranges back to
  // source offsets. A raw continuation slice alone has no owning list/quote.
  const body = prefix + slice + closer + commentClose + opaqueClose;
  const literals = codeRanges(body)
    .map((range) => ({
      start: Math.max(0, range.start - prefix.length),
      end: Math.min(slice.length, range.end - prefix.length),
    }))
    .filter((range) => range.end > range.start);
  const pending = references(
    slice,
    literals,
    startParagraph,
    localBudget,
    definitionsFor(part.start),
  );
  if (!pending) return plain(true);
  let definitionLength = 0;
  let prepend = false;
  // A later local definition must not override the file's first definition.
  const localDefinitions = new Set<string>();
  const inCode = literalCursor(literals);
  const definitionAt =
    definitionsFor(part.start) ??
    positionedReferenceDefinitions(
      slice,
      startParagraph,
      referenceDefinitions(slice, localBudget),
    );
  let definitionEnd = 0;
  for (const line of lines(slice)) {
    if (line.start < definitionEnd || inCode(line.start)) continue;
    const definition = definitionAt(line.start);
    if (localBudget.exhausted) return plain(true);
    if (definition) {
      localDefinitions.add(`link:${definition.label}`);
      definitionEnd = definition.end;
      continue;
    }
    const opening = slice.slice(line.start, line.end).match(/^ {0,3}\[\^/);
    if (!opening) continue;
    const labelStart = line.start + required(opening[0]).length;
    const end = footnoteLabelEnd(slice, labelStart, line.end);
    if (end !== undefined && slice[end + 1] === ":")
      localDefinitions.add(
        `note:${normalizeLabel(slice.slice(labelStart, end))}`,
      );
  }
  for (let next = 0; next < pending.length; next++) {
    const { label, note } = required(pending[next]);
    const key = `${note ? "note" : "link"}:${label}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const span = (note ? context?.footnotes : context?.links)?.get(label);
    if (note && span?.deep) return plain(false, true);
    if (!span || (span.start >= part.start && span.end <= part.end)) continue;
    prepend ||=
      (note && span.start < part.start) ||
      localDefinitions.has(key) ||
      (span.start >= part.start && span.start < part.end);
    selected.push(span);
    definitionLength += span.end - span.start;
    // Prefix mode adds an inert block boundary so a note cannot absorb the
    // original part's initial indented lines. No context is copied before admission.
    const overhead = selected.length * 2 + (prepend ? 10 : 1);
    if (baseLength + definitionLength + overhead > MAX_RENDER_CHARS)
      return plain(true);
    const definition = definitionSource(text, span);
    const nested = references(
      note ? footnoteBody(definition) : definition,
      undefined,
      false,
      localBudget,
      note ? undefined : definitionsFor(span.start),
    );
    if (!nested) return plain(true);
    for (const reference of nested) pending.push(reference);
  }
  if (selected.length && openHtmlTail(body)) return plain(false);

  let source = body;
  const insertion = 0;
  let added = 0;
  const synthetic: DefinitionSpan[] = [];
  if (selected.length) {
    const definitions = selected
      .map((span) => definitionSource(text, span))
      .join("\n\n");
    if (prepend) {
      const block = `${definitions}\n\n<!-- -->\n\n`;
      added = block.length;
      synthetic.push({ start: definitions.length + 2, end: added });
      if (source.length + added > MAX_RENDER_CHARS) return plain(true);
      source = source.slice(0, insertion) + block + source.slice(insertion);
    } else source += `\n\n${definitions}\n`;
  }

  // Admission charges physical source spans; tab projection can add virtual
  // padding, so the assembled result still obeys the same rendering budget.
  if (source.length > MAX_RENDER_CHARS) return plain(true);
  const headings = new Map<number, string>();
  let low = 0,
    high = context.headings.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (required(context.headings[middle]).offset < part.start)
      low = middle + 1;
    else high = middle;
  }
  for (
    let at = low;
    at < context.headings.length &&
    required(context.headings[at]).offset < part.end;
    at++
  ) {
    const heading = required(context.headings[at]),
      offset = prefix.length + heading.offset - part.start;
    headings.set(offset + (offset >= insertion ? added : 0), heading.id);
  }
  synthetic.push(
    { start: added, end: added + prefix.length },
    { start: added + prefix.length + slice.length, end: added + body.length },
  );
  synthetic.sort((left, right) => left.start - right.start);
  return {
    source,
    synthetic,
    prefix: prefix.length + added,
    bodyStart: prefix.length + added,
    bodyEnd: prefix.length + added + slice.length,
    headingOffsets: headings,
  };
}
