import { required } from "./markdown-limits";
import GithubSlugger from "github-slugger";
import {
  containerDefinitions,
  definitionSource,
} from "./markdown-container-definitions";
import type { DefinitionReader } from "./markdown-container-definitions";
import { MAX_RENDER_DEPTH } from "./markdown-limits";
import { decodeString } from "micromark-util-decode-string";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Plugin } from "unified";
import type { Root as MdRoot, RootContent as MdContent } from "mdast";
import type { Root as HastRoot, Element } from "hast";
import {
  markdownBlocks,
  prepareBlocks,
  finishBlocks,
  tableStartForCut,
  tableCells,
  tableIndent,
} from "./markdown-blocks";
import type { BlockPart } from "./markdown-blocks";
import {
  definitionBudget,
  referenceDefinitions,
  referenceLabelEnd,
} from "./markdown-references";
import type { ReferenceDefinition } from "./markdown-references";
import { fenceLine } from "./markdown-fences";
import type { Fence as CodeFence, FenceState, Owner } from "./markdown-fences";
import { inlineCut } from "./markdown-inline-cut";
import { startsBlankHtmlBlock, isStandaloneHtmlTag } from "./markdown-html";
import { explicitHtmlStart, explicitHtmlEnd } from "./markdown-html-explicit";
import type { ExplicitHtml } from "./markdown-html-explicit";
import { assemblePart } from "./markdown-part-source";

export const PART_CHARS = 12_500;
export const SYNC_INDEX_CHARS = 64 * 1024;
export const MAX_PART_HEADINGS = 20_000;
export type DocumentKind = "markdown" | "code" | "text";
export type DocumentPart = Readonly<{
  start: number;
  end: number;
  line: number;
  fence?: string;
}>;
export type PartOutlineItem = Readonly<{
  depth: 1 | 2 | 3;
  text: string;
  id: string;
  part: number;
}>;
export type DocumentParts = Readonly<{
  parts: readonly DocumentPart[];
  outline: readonly PartOutlineItem[];
  headings: ReadonlyMap<string, number>;
  headingsTruncated?: true | undefined;
  words: number;
  readingMinutes: number;
  unclosedFence?: number | undefined;
  partSource(index: number): string;
  partFallback(index: number): "too-large" | "too-deep" | "context" | undefined;
  partOf(id: string): number | undefined;
}>;
export type DefinitionSpan = {
  start: number;
  end: number;
  owners?: readonly Owner[] | undefined;
  bodyStart?: number | undefined;
  padding?: number | undefined;
  deep?: true | undefined;
};
type IndexedHeading = {
  offset: number;
  end: number;
  depth: number;
  id: string;
  text: string;
};
export type PreparedPart = {
  source: string;
  bodyStart: number;
  bodyEnd: number;
  prefix: number;
  headingOffsets: ReadonlyMap<number, string>;
  synthetic?: readonly DefinitionSpan[] | undefined;
  footnoteTargets?: ReadonlySet<string> | undefined;
  plain?: boolean | undefined;
  fallback?: "too-large" | "too-deep" | "context";
};
export type PartContext = {
  text: string;
  kind: DocumentKind;
  headings: readonly IndexedHeading[];
  links: ReadonlyMap<string, DefinitionSpan>;
  footnotes: ReadonlyMap<string, DefinitionSpan>;
  footnoteNumbers: ReadonlyMap<string, number>;
  footnoteParts: ReadonlyMap<string, number>;
  notes: readonly DefinitionSpan[];
  blocks: readonly BlockPart[];
  starts: readonly Cursor[];
  ends: readonly Cursor[];
  plain: boolean;
  definitionAt: ReturnType<typeof referenceDefinitions>;
  prepared?: { index: number; value: PreparedPart };
};
const contexts = new WeakMap<DocumentParts, PartContext>();
export const partContext = (parts: DocumentParts): PartContext => {
  const context = contexts.get(parts);
  if (!context)
    throw new TypeError("Document parts were not indexed by this module");
  return context;
};
/** CommonMark label folding, including lower-before-upper for characters such as ß. */
export const normalizeLabel = (label: string): string =>
  label
    .replace(/[\t\n\r ]+/g, " ")
    .replace(/^ | $/g, "")
    .toLowerCase()
    .toUpperCase();
type Fence = CodeFence & Readonly<{ line: number; swallowed: boolean }>;
type Opaque = (
  | Readonly<{ kind: "comment" }>
  | Readonly<{ kind: "raw"; tag: string }>
  | Readonly<{ kind: "html" }>
  | Readonly<{ kind: "definition"; end: number }>
  | Readonly<{ kind: "explicit"; html: ExplicitHtml }>
) & { owners?: readonly number[] | undefined };
type Line = Readonly<{
  end: number;
  next: number;
  body: string;
  bodyStart: number;
  bodyPadding: number;
  blank: boolean;
  heading?: RegExpMatchArray | undefined;
  after?: Fence | undefined;
  region?: Opaque | undefined;
  opaque: boolean;
  afterOpaque?: Opaque | undefined;
  /** Absolute closing-comment end, or Infinity while the comment stays open. */
  commentEnd?: number | undefined;
  explicit?: ExplicitHtml | undefined;
  explicitEnd?: number | undefined;
  explicitVisible?: number | undefined;
  definition?: (DefinitionSpan & { label: string }) | undefined;
  paragraph: boolean;
  code: boolean;
  syntax: FenceState;
  endedBefore: boolean;
  /** Hidden PI/CDATA comment payload precedes this absolute source offset. */
  htmlBlock: boolean;
}>;
type Cursor = Readonly<{
  offset: number;
  line: number;
  fence?: Fence | undefined;
  previousBlank: boolean;
  opaque?: Opaque | undefined;
  paragraph?: boolean | undefined;
  syntax?: FenceState | undefined;
  /** Present only when a forced cut continues the same original source line. */
  current?: Line | undefined;
  /** The forced cut splits a code span, link or emphasis. */
  inline?: true | undefined;
}>;
const lineEnding = /[\r\n]/g;

function initialCursor(_text: string): Cursor {
  return { offset: 0, line: 1, previousBlank: false };
}

function sourceLine(
  text: string,
  cursor: Cursor,
  definitionAt?: DefinitionReader,
): Line {
  if (cursor.current) return cursor.current;
  // One search per line: separately searching for CR on an LF-only file
  // would scan the entire remaining suffix at every line.
  lineEnding.lastIndex = cursor.offset;
  const ending = lineEnding.exec(text);
  const end = ending?.index ?? text.length;
  const next = ending
    ? end + (text[end] === "\r" && text[end + 1] === "\n" ? 2 : 1)
    : text.length;
  const content = text.slice(cursor.offset, end);
  let syntax = fenceLine(
    content,
    {
      ...cursor.syntax,
      owners: cursor.syntax?.owners ?? [],
      fence: cursor.fence,
      paragraph: cursor.syntax?.paragraph ?? cursor.paragraph,
    },
    !!cursor.opaque,
  );
  // Suppress known raw regions without attempting a full HTML block parser.
  // In particular, a literal fence inside a comment must never warn the user.
  let region = cursor.opaque;
  if (
    region?.owners &&
    (region.owners.length !== syntax.after.owners.length ||
      region.owners.some((id, at) => id !== syntax.after.owners[at]?.id))
  ) {
    region = undefined;
    syntax = fenceLine(
      content,
      {
        ...cursor.syntax,
        owners: cursor.syntax?.owners ?? [],
        paragraph: false,
      },
      false,
    );
  }
  const body = syntax.body;
  if (!region && !syntax.code && /^ {0,3}</.test(body)) {
    if (/^ {0,3}<!--/.test(body)) region = { kind: "comment" };
    else if (explicitHtmlStart(body))
      region = { kind: "explicit", html: required(explicitHtmlStart(body)) };
    else {
      const raw = body.match(
        /^ {0,3}<(script|style|pre|textarea)(?:[\t >]|\/>|$)/i,
      );
      if (raw) region = { kind: "raw", tag: required(raw[1]).toLowerCase() };
      else {
        if (
          startsBlankHtmlBlock(body) ||
          (!cursor.paragraph && isStandaloneHtmlTag(body))
        )
          region = { kind: "html" };
      }
    }
  }
  if (region && region !== cursor.opaque && region.kind !== "definition")
    region = {
      ...region,
      owners: syntax.after.owners.map((owner) => owner.id),
    };
  const sameOwners =
    (cursor.syntax?.owners.length ?? 0) === syntax.after.owners.length &&
    syntax.after.owners.every(
      (owner, at) => owner.id === cursor.syntax?.owners[at]?.id,
    );
  const definition =
    !region && !syntax.code && (!cursor.paragraph || !sameOwners)
      ? (definitionAt?.(cursor.offset) ??
        definitionAt?.contained?.(
          cursor.offset,
          cursor.offset + syntax.bodyOffset,
          syntax.after,
          syntax.bodyPadding,
        ))
      : undefined;
  if (definition) region = { kind: "definition", end: definition.end };
  let afterOpaque = region;
  const commentClose = region?.kind === "comment" ? content.indexOf("-->") : -1;
  const explicit = region?.kind === "explicit" ? region.html : undefined;
  const explicitClose = explicit
    ? content.indexOf(explicitHtmlEnd(explicit))
    : -1;
  const visible = explicit && !explicit.visible ? content.indexOf(">") : -1;
  if (region?.kind === "definition" && next >= region.end)
    afterOpaque = undefined;
  else if (region?.kind === "comment" && commentClose >= 0)
    afterOpaque = undefined;
  else if (explicit)
    afterOpaque =
      explicitClose >= 0
        ? undefined
        : {
            kind: "explicit",
            html: visible >= 0 ? { ...explicit, visible: true } : explicit,
            owners: region?.owners,
          };
  else if (
    region?.kind === "raw" &&
    new RegExp(`</${region.tag}[\\t ]*>`, "i").test(content)
  )
    afterOpaque = undefined;
  else if (region?.kind === "html" && /^[\t ]*$/.test(body))
    afterOpaque = undefined;
  const heading =
    syntax.body.match(/^ {0,3}(#{1,6})(?:[\t ]+|$)([^\r\n]*)$/) ?? undefined;
  const after: Fence | undefined = syntax.after.fence
    ? {
        ...syntax.after.fence,
        line: syntax.opened ? cursor.line : required(cursor.fence).line,
        swallowed:
          !syntax.opened && (required(cursor.fence).swallowed || !!heading),
      }
    : undefined;
  const blank = /^[\t \r]*$/.test(body);
  const paragraph =
    !blank && !region && !syntax.code && !!syntax.after.paragraph;
  const htmlBlock = region?.kind === "raw" || region?.kind === "html";
  return {
    end,
    next,
    body: syntax.body,
    bodyStart: cursor.offset + syntax.bodyOffset,
    bodyPadding: syntax.bodyPadding,
    blank,
    heading,
    after,
    region,
    opaque: region !== undefined,
    afterOpaque,
    paragraph,
    definition,
    htmlBlock,
    code: syntax.code,
    syntax: region ? { ...syntax.after, paragraph: false } : syntax.after,
    endedBefore: syntax.endedBefore,
    ...(explicit
      ? {
          explicit,
          explicitEnd:
            explicitClose < 0
              ? Infinity
              : cursor.offset +
                explicitClose +
                explicitHtmlEnd(explicit).length,
          ...(visible < 0
            ? {}
            : { explicitVisible: cursor.offset + visible + 1 }),
        }
      : {}),
    ...(region?.kind === "comment"
      ? {
          commentEnd:
            commentClose < 0 ? Infinity : cursor.offset + commentClose + 3,
        }
      : {}),
  };
}

function nextLine(cursor: Cursor, line: Line): Cursor {
  return {
    offset: line.next,
    line: cursor.line + 1,
    fence: line.after,
    syntax: line.syntax,
    previousBlank: line.blank,
    opaque: line.afterOpaque,
    paragraph: line.paragraph,
  };
}

/** Stateful reader for callers assembling local parts. Definition syntax is
 * accepted only at the same block positions as the whole-file index. */
export function positionedReferenceDefinitions(
  text: string,
  paragraph = false,
  definitionAt = referenceDefinitions(text),
): ReturnType<typeof referenceDefinitions> {
  let cursor: Cursor = { ...initialCursor(text), paragraph };
  return (offset) => {
    while (cursor.offset <= offset && cursor.offset < text.length) {
      const line = sourceLine(text, cursor, definitionAt);
      const definition = cursor.offset === offset ? line.definition : undefined;
      cursor = nextLine(cursor, line);
      if (definition) return definition;
    }
    return undefined;
  };
}

export function footnoteLabelEnd(
  text: string,
  start: number,
  end: number,
): number | undefined {
  let at = start,
    size = 0;
  while (at < end && size <= 999) {
    const value = text.charAt(at);
    if (value === "]") return size && size <= 999 ? at : undefined;
    if (value === "[" || /[\t\n\r ]/.test(value)) return undefined;
    if (value === "\\" && /[[\]\\]/.test(text[at + 1] ?? "")) {
      at++;
      size++;
    }
    at++;
    size++;
  }
  return undefined;
}

function footnoteDefinitionLabel(text: string): string | undefined {
  const opening = text.match(/^ {0,3}\[\^/);
  if (!opening) return undefined;
  const end = footnoteLabelEnd(text, required(opening[0]).length, text.length);
  return end !== undefined && text[end + 1] === ":"
    ? normalizeLabel(text.slice(required(opening[0]).length, end))
    : undefined;
}

const titleSpace = (char: string | undefined): boolean =>
  char === " " || char === "\t";

/** Optional CommonMark link title and the resource's final closing paren. */
function linkTitleEnd(text: string, start: number): number | undefined {
  const opener = text[start],
    closer = opener === "(" ? ")" : opener;
  if (opener !== '"' && opener !== "'" && opener !== "(") return undefined;
  let at = start + 1;
  for (; at < text.length; at++) {
    const char = text.charAt(at);
    if (
      char === "\\" &&
      (text[at + 1] === closer ||
        text[at + 1] === opener ||
        text[at + 1] === "\\")
    ) {
      at++;
      continue;
    }
    if (char === closer) break;
    if (char === "\r" || char === "\n" || (opener === "(" && char === "("))
      return undefined;
  }
  if (at === text.length) return undefined;
  while (titleSpace(text[++at])) {
    /* optional trailing space */
  }
  return text[at] === ")" ? at + 1 : undefined;
}

/** Same destination nesting limit as micromark's label-end resource (32).
 * Escapes and enclosed destinations do not count their literal parentheses. */
function inlineLinkEnd(text: string, open: number): number | undefined {
  let at = open + 1;
  while (titleSpace(text[at])) at++;
  if (text[at] === ")") return at + 1;
  if (text[at] === "<") {
    for (at++; at < text.length && text[at] !== ">"; at++) {
      if (text[at] === "\\" && /[<>\\]/.test(text[at + 1] ?? "")) at++;
      else if (text[at] === "<" || text[at] === "\r" || text[at] === "\n")
        return undefined;
    }
    if (at === text.length) return undefined;
    at++;
  } else {
    let depth = 0;
    for (; at < text.length; at++) {
      const char = text.charAt(at);
      if (char === "\\" && /[()\\]/.test(text[at + 1] ?? "")) {
        at++;
        continue;
      }
      if (char === "(") {
        if (++depth > 32) return undefined;
      } else if (char === ")") {
        if (depth === 0) return at + 1;
        depth--;
      } else if (titleSpace(char)) {
        if (depth) return undefined;
        break;
      } else if (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
        return undefined;
    }
  }
  const end = at;
  while (titleSpace(text[at])) at++;
  if (text[at] === ")") return at + 1;
  return at > end ? linkTitleEnd(text, at) : undefined;
}

function inlineHtmlEnd(
  text: string,
  start: number,
  end: number,
  closers: Map<string, number>,
): number | undefined {
  const source = text.slice(start, end);
  // CommonMark accepts these abrupt empty comment closers.
  if (source.startsWith("<!-->")) return start + 5;
  if (source.startsWith("<!--->")) return start + 6;
  for (const [opening, closing] of [
    ["<!--", "-->"],
    ["<?", "?>"],
    ["<![CDATA[", "]]>"],
  ] as const) {
    if (!source.startsWith(opening)) continue;
    let at = closers.get(closing);
    if (at === undefined || (at >= 0 && at < start + opening.length)) {
      at = text.indexOf(closing, start + opening.length);
      if (at >= end) at = -1;
      closers.set(closing, at);
    }
    return at < 0 ? undefined : at + closing.length;
  }
  const autolink = source.match(
    /^<(?:[a-z][a-z\d+.-]{1,31}:[^<>\s]*|[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d][a-z\d.-]*)>/i,
  );
  if (autolink) return start + required(autolink[0]).length;
  const tag = source.match(
    /^<\/[a-z][a-z\d-]*[\t\r\n ]*>|^<[a-z][a-z\d-]*(?:[\t\r\n ]+[a-z_:][a-z\d_.:-]*(?:[\t\r\n ]*=[\t\r\n ]*(?:[^\s"'=<>`]+|"[^"]*"|'[^']*'))?)*[\t\r\n ]*\/?>/i,
  );
  return tag ? start + required(tag[0]).length : undefined;
}

/** Check only the resource after an already paired image label. Reference
 * labels have the CommonMark 999-character limit; inline alt can be longer. */
function imageResourceEnd(
  text: string,
  start: number,
  close: number,
  end: number,
  links?: ReadonlyMap<string, unknown>,
): number | undefined {
  if (text[close + 1] === "(") {
    const resource = inlineLinkEnd(text, close + 1);
    return resource !== undefined && resource <= end ? resource : undefined;
  }
  if (!links?.size) return undefined;
  let label: string | undefined;
  if (close - start - 1 <= 999) label = text.slice(start + 1, close);
  if (text[close + 1] === "[") {
    let at = close + 2;
    for (; at < end && at - close <= 1001; at++) {
      if (text[at] === "\\") {
        at++;
        continue;
      }
      if (text[at] === "[" || /[\r\n]/.test(text.charAt(at))) break;
      if (text[at] === "]") {
        const reference = text.slice(close + 2, at) || label;
        return reference !== undefined && links.has(normalizeLabel(reference))
          ? at + 1
          : undefined;
      }
    }
  } else if (label !== undefined && links.has(normalizeLabel(label)))
    return close + 1;
  return undefined;
}

/** GFM note labels are not general link labels: whitespace and nested `[` are
 * forbidden, but escaped brackets and backslashes are allowed (micromark 2.1).
 * Scan a block twice for code runs; the inventory is per distinct run length,
 * never per reference or per source line. Multiline code stays literal. */
function scanFootnotes(
  text: string,
  start: number,
  end: number,
  defined: ReadonlyMap<string, unknown>,
  visit: (start: number, end: number, label: string) => void,
  links?: ReadonlyMap<string, unknown>,
  everyReference = false,
): void {
  // Keep only each label's first candidate during whole-file numbering. Image
  // alt can invalidate a suffix when its resource closes; no occurrence list
  // or completed-image inventory is needed. Brackets retain active depth only.
  const candidates: { start: number; end: number; label: string }[] = [];
  const seen = new Set<string>();
  // Four-byte offsets plus one image bit, in reusable fixed-size pages: no
  // per-delimiter objects or overlapping growing-array backing stores.
  const bracketPages: Uint32Array[] = [];
  let bracketDepth = 0;
  const htmlClosers = new Map<string, number>();
  const remaining = new Map<string, number>();
  let hasNoteSyntax = false;
  const consumeRuns = (from: number, to: number, change: number) => {
    for (let at = from; at < to; at++) {
      const char = text.charAt(at);
      if (change > 0 && char === "[" && text[at + 1] === "^")
        hasNoteSyntax = true;
      if (char !== "`") continue;
      let next = at + 1;
      while (next < to && text[next] === char) next++;
      const key = `${char}${next - at}`;
      remaining.set(key, (remaining.get(key) ?? 0) + change);
      at = next - 1;
    }
  };
  consumeRuns(start, end, 1);
  if (!hasNoteSyntax) return;
  // Inline code closes only on an equal backtick run. Its payload cannot
  // request footnotes or references.
  let literal: string | undefined,
    literalSize = 0,
    lastNoteEnd = -1;
  for (let at = start; at < end; at++) {
    const char = text.charAt(at);
    if (char === "`") {
      let next = at + 1;
      while (next < end && text[next] === char) next++;
      const size = next - at,
        key = `${char}${size}`;
      remaining.set(key, required(remaining.get(key)) - 1);
      if (literal === char && literalSize === size) literal = undefined;
      else if (!literal && remaining.get(key)) {
        literal = char;
        literalSize = size;
      }
      at = next - 1;
      continue;
    }
    if (literal) continue;
    if (char === "\\" && at + 1 < end) {
      const escaped = text.charAt(at + 1);
      if (escaped === "`") {
        let next = at + 1;
        while (next < end && text[next] === escaped) next++;
        const size = next - at - 1,
          key = `${escaped}${size}`;
        remaining.set(key, required(remaining.get(key)) - 1);
        if (size > 1 && remaining.get(`${escaped}${size - 1}`)) {
          literal = escaped;
          literalSize = size - 1;
        }
        at = next - 1;
      } else if (/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(escaped)) at++;
      continue;
    }
    let opaqueEnd: number | undefined;
    if (char === "<") opaqueEnd = inlineHtmlEnd(text, at, end, htmlClosers);
    else if (char === "]") {
      let packed: number | undefined;
      if (bracketDepth) {
        bracketDepth--;
        packed = required(bracketPages[Math.floor(bracketDepth / 4096)])[
          bracketDepth % 4096
        ];
      }
      if (packed !== undefined && packed % 2 === 1) {
        const opening = Math.floor(packed / 2);
        opaqueEnd = imageResourceEnd(text, opening, at, end, links);
        if (opaqueEnd !== undefined) {
          while (
            candidates.length &&
            required(candidates[candidates.length - 1]).start > opening
          ) {
            const removed = required(candidates.pop());
            seen.delete(removed.label);
          }
        }
      }
    } else if (char === "(" && text[at - 1] === "]" && lastNoteEnd !== at) {
      const close = inlineLinkEnd(text, at);
      if (close !== undefined && close <= end) opaqueEnd = close;
    }
    if (opaqueEnd !== undefined) {
      consumeRuns(at, opaqueEnd, -1);
      at = opaqueEnd - 1;
      continue;
    }
    if (char !== "[") continue;
    const next =
      text[at + 1] === "^" ? footnoteLabelEnd(text, at + 2, end) : undefined;
    const label =
      next === undefined ? undefined : normalizeLabel(text.slice(at + 2, next));
    if (next !== undefined && label !== undefined && defined.has(label)) {
      if (everyReference || !seen.has(label)) {
        candidates.push({ start: at, end: next + 1, label });
        seen.add(label);
      }
      lastNoteEnd = next + 1;
      at = next;
    } else {
      let slashes = 0;
      if (text[at - 1] === "!")
        for (
          let before = at - 2;
          before >= start && text[before] === "\\";
          before--
        )
          slashes++;
      const image = text[at - 1] === "!" && slashes % 2 === 0;
      if (image || bracketDepth) {
        const page = Math.floor(bracketDepth / 4096);
        bracketPages[page] ??= new Uint32Array(4096);
        required(bracketPages[page])[bracketDepth % 4096] =
          at * 2 + Number(image);
        bracketDepth++;
      }
    }
  }
  for (const candidate of candidates)
    visit(candidate.start, candidate.end, candidate.label);
}

/** The whole renderer numbers body references first, then walks the growing
 * footer queue. Scan each cited definition once in that same breadth order. */
function footnoteNumbers(
  text: string,
  defined: ReadonlyMap<string, DefinitionSpan>,
  links: ReadonlyMap<string, DefinitionSpan>,
  definitionAt: ReturnType<typeof referenceDefinitions>,
  notes: readonly DefinitionSpan[],
  origins: Map<string, number>,
  counts?: Map<string, number>,
): Map<string, number> {
  const sourceText = text;
  const numbers = new Map<string, number>();
  if (!defined.size) return numbers;
  let origin: number | undefined;
  const record = (start: number, _end: number, label: string) => {
    if (counts) counts.set(label, (counts.get(label) ?? 0) + 1);
    if (!numbers.has(label)) {
      numbers.set(label, numbers.size + 1);
      origins.set(label, origin ?? start);
    }
  };
  const scanRegion = (note?: DefinitionSpan) => {
    const source = note ? definitionSource(sourceText, note) : sourceText;
    const text = source;
    let cursor = initialCursor(note ? "" : text),
      start: number | undefined;
    if (note) {
      const colon =
        required(
          footnoteLabelEnd(text, text.indexOf("[^", 0) + 2, text.length),
        ) + 1;
      cursor = {
        ...cursor,
        offset:
          colon + 1 + (/^[\t ]/.test(text.slice(colon + 1, colon + 2)) ? 1 : 0),
      };
    }
    const end = text.length;
    let noteIndex = 0,
      table = 0,
      first = true;
    let owners: FenceState["owners"] = [];
    let previous:
      | {
          start: number;
          next: number;
          body: string;
          offset: number;
          indent: boolean;
        }
      | undefined;
    const cells = (body: string, offset: number, columns = Infinity) => {
      for (const cell of tableCells(body).slice(0, columns))
        scanFootnotes(
          text,
          offset + cell.start,
          offset + cell.end,
          defined,
          record,
          links,
          !!counts,
        );
    };
    const flush = (end: number) => {
      if (start === undefined) return;
      scanFootnotes(text, start, end, defined, record, links, !!counts);
      start = undefined;
    };
    while (cursor.offset < end) {
      const physical = cursor.offset;
      if (note && !first) {
        // Remove the definition's four-column continuation indent before
        // classifying blocks; a further four columns still mean code.
        let column = 0,
          indent = 0;
        while (
          column < 4 &&
          (text[physical + indent] === " " || text[physical + indent] === "\t")
        ) {
          column += text[physical + indent++] === "\t" ? 4 - (column % 4) : 1;
        }
        if (column >= 4) cursor = { ...cursor, offset: physical + indent };
      }
      first = false;
      const line = sourceLine(text, cursor, note ? undefined : definitionAt);
      const content = text.slice(cursor.offset, line.end);
      if (!note)
        while (
          noteIndex < notes.length &&
          required(notes[noteIndex]).end <= cursor.offset
        )
          noteIndex++;
      const inNote =
        !note &&
        !!notes[noteIndex] &&
        required(notes[noteIndex]).start <= cursor.offset &&
        cursor.offset < required(notes[noteIndex]).end;
      if (!line.code && !inNote && line.definition) {
        flush(cursor.offset);
        cursor = {
          ...cursor,
          offset: line.definition.end,
          previousBlank: true,
          paragraph: false,
          opaque: undefined,
        };
        table = 0;
        previous = undefined;
        continue;
      }
      const definition = /^ {0,3}\[[^\]\r\n]+\]:/.test(content);
      const skip =
        line.code ||
        line.opaque ||
        line.blank ||
        inNote ||
        definition ||
        (start === undefined && /^(?: {4}|\t)/.test(content));
      const sameOwners =
        owners.length === line.syntax.owners.length &&
        owners.every(
          (owner, index) => owner.id === required(line.syntax.owners[index]).id,
        );
      const body = line.body,
        offset = cursor.offset + content.length - body.length,
        ranges = tableCells(body),
        indent = tableIndent(content, body);
      const delimiter =
        !skip &&
        sameOwners &&
        previous?.next === physical &&
        previous.indent &&
        indent &&
        /[|:]/.test(body) &&
        ranges.length === tableCells(previous.body).length &&
        ranges.every((cell) =>
          /^[\t ]*:?-+:?[\t ]*$/.test(body.slice(cell.start, cell.end)),
        );
      if (skip || !sameOwners || !line.paragraph) table = 0;
      if (delimiter && previous) {
        // Delay only the possible header line until its delimiter confirms a
        // table, then scan every cell with independent literal pairing.
        flush(previous.start);
        cells(previous.body, previous.offset);
        table = ranges.length;
        previous = undefined;
      } else if (table) {
        cells(body, offset, table);
        previous = undefined;
      } else {
        if (skip || line.heading || !sameOwners || !cursor.paragraph)
          flush(cursor.offset);
        if (!skip) {
          start ??= cursor.offset;
          if (line.heading) flush(line.end);
        }
        previous =
          !skip && line.paragraph
            ? { start: cursor.offset, next: line.next, body, offset, indent }
            : undefined;
      }
      owners = line.syntax.owners;
      cursor = nextLine(cursor, line);
      if (table)
        cursor = {
          ...cursor,
          paragraph: false,
          syntax: { ...required(cursor.syntax), paragraph: false },
        };
    }
    flush(end);
  };
  scanRegion();
  // Map iteration includes labels appended by earlier definitions. Each label
  // is admitted once, so cycles terminate without recursion or another queue.
  for (const label of numbers.keys()) {
    origin = origins.get(label);
    scanRegion(required(defined.get(label)));
  }
  return numbers;
}

/** Linear approximation of consumed attention runs, outside code spans. */
function linearAttention(text: string): Uint8Array | undefined {
  const code = new Uint8Array(text.length);
  const runs: { start: number; end: number; closer?: number | undefined }[] =
    [];
  const ticks = /`+/g;
  for (let match = ticks.exec(text); match; match = ticks.exec(text))
    runs.push({ start: match.index, end: ticks.lastIndex });
  const next = new Map<number, number>();
  for (let at = runs.length - 1; at >= 0; at--) {
    const size = required(runs[at]).end - required(runs[at]).start;
    const closer = next.get(size);
    next.set(size, at);
    let escaped = 0;
    for (
      let before = required(runs[at]).start - 1;
      before >= 0 && text[before] === "\\";
      before--
    )
      escaped++;
    if (!(escaped % 2)) required(runs[at]).closer = closer;
  }
  for (let at = 0; at < runs.length; at++) {
    const closer = required(runs[at]).closer;
    if (closer === undefined) continue;
    code.fill(1, required(runs[at]).start, required(runs[closer]).end);
    at = closer;
  }
  let markers: Uint8Array | undefined;
  const opening = new Map<string, { start: number; end: number }>();
  const pattern = /([*_~])\1*/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const start = match.index,
      end = start + match[0].length;
    if (code[start]) continue;
    let escaped = 0;
    for (let at = start - 1; at >= 0 && text[at] === "\\"; at--) escaped++;
    if (escaped % 2) continue;
    const before = text[start - 1] ?? "",
      after = text[end] ?? "";
    const underscore = match[1] === "_";
    const canOpen =
      Boolean(after) &&
      !/\s/u.test(after) &&
      (!underscore || !/[\p{L}\p{N}]/u.test(before));
    const canClose =
      Boolean(before) &&
      !/\s/u.test(before) &&
      (!underscore || !/[\p{L}\p{N}]/u.test(after));
    const prior = opening.get(match[0]);
    if (canClose && prior) {
      markers ??= new Uint8Array(text.length);
      markers.fill(1, prior.start, prior.end);
      markers.fill(1, start, end);
      opening.delete(match[0]);
    } else if (canOpen) opening.set(match[0], { start, end });
  }
  return markers;
}

function withoutLinkDestinations(
  text: string,
  links: ReadonlyMap<string, DefinitionSpan>,
  sourceLabel: (label: string) => string,
): string {
  const chunks: string[] = [];
  type Opening = {
    at: number;
    chunk: number;
    image: boolean;
    active: boolean;
    nested: boolean;
  };
  const openings: Opening[] = [],
    activeLinks: Opening[] = [];
  const htmlClosers = new Map<string, number>();
  const defined = (value: string) => {
    const raw = sourceLabel(value);
    return (
      raw.length <= 999 &&
      referenceLabelEnd(`[${raw}]`, 1) === raw.length + 1 &&
      links.has(normalizeLabel(raw))
    );
  };
  let copied = 0;
  for (let at = 0; at < text.length; at++) {
    if (text[at] === "\\") {
      at++;
      continue;
    }
    if (text[at] === "<") {
      const end = inlineHtmlEnd(text, at, text.length, htmlClosers);
      if (end !== undefined) {
        at = end - 1;
        continue;
      }
    }
    if (text[at] === "[") {
      if (openings.length)
        required(openings[openings.length - 1]).nested = true;
      let slashes = 0;
      if (text[at - 1] === "!")
        for (
          let before = at - 2;
          before >= 0 && text[before] === "\\";
          before--
        )
          slashes++;
      const image = text[at - 1] === "!" && slashes % 2 === 0;
      chunks.push(text.slice(copied, at - Number(image)));
      const opening = {
        at,
        chunk: chunks.length,
        image,
        active: true,
        nested: false,
      };
      chunks.push(image ? "![" : "[");
      openings.push(opening);
      if (!image) activeLinks.push(opening);
      copied = at + 1;
      continue;
    }
    if (text[at] !== "]" || !openings.length) continue;
    const opening = required(openings.pop());
    if (!opening.image && opening.active) activeLinks.pop();
    if (!opening.active) continue;
    const after = at + 1;
    const labelDefined = () =>
      !opening.nested && defined(text.slice(opening.at + 1, at));
    let end = text[after] === "(" ? inlineLinkEnd(text, after) : undefined;
    if (end === undefined && text[after] === "[") {
      const close =
        text[after + 1] === "]"
          ? after + 1
          : referenceLabelEnd(text, after + 1);
      if (
        close !== undefined &&
        (close === after + 1
          ? labelDefined()
          : defined(text.slice(after + 1, close)))
      )
        end = close + 1;
    } else if (end === undefined && labelDefined()) end = after;
    if (end === undefined) continue;
    chunks.push(text.slice(copied, at));
    chunks[opening.chunk] = "";
    copied = end;
    at = end - 1;
    // A resolved link disables enclosing link openers; images may still own
    // links in their alt text. Each active opener is retired at most once.
    if (!opening.image) {
      for (const link of activeLinks) link.active = false;
      activeLinks.length = 0;
    }
  }
  chunks.push(text.slice(copied));
  return chunks.join("");
}

/** Linear fallback for titles outside the small parser budget. */
function linearHeadingText(
  raw: string,
  links: ReadonlyMap<string, DefinitionSpan>,
  numbers: ReadonlyMap<string, number>,
): string {
  const claimed = new Set(raw + decodeString(raw));
  let point = 0xf0000;
  while (claimed.has(String.fromCodePoint(point))) point++;
  const marker = String.fromCodePoint(point);
  const attention = linearAttention(raw);
  const ticks = [...raw.matchAll(/`+/g)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    size: match[0].length,
    next: undefined as number | undefined,
  }));
  const next = new Map<number, number>();
  for (let at = ticks.length - 1; at >= 0; at--) {
    required(ticks[at]).next = next.get(required(ticks[at]).size);
    next.set(required(ticks[at]).size, at);
  }
  const code: { source: string; value: string }[] = [];
  const chunks: string[] = [];
  let copied = 0;
  const prose = (start: number, end: number): string => {
    const result: string[] = [];
    for (let at = start; at < end; at++)
      result.push(
        attention?.[at] ? `${marker}A${raw.charCodeAt(at)};` : raw.charAt(at),
      );
    return result.join("");
  };
  for (let at = 0; at < ticks.length; at++) {
    const open = required(ticks[at]);
    let slashes = 0;
    for (
      let before = open.start - 1;
      before >= 0 && raw[before] === "\\";
      before--
    )
      slashes++;
    if (slashes % 2 || open.next === undefined) continue;
    const close = required(ticks[open.next]);
    chunks.push(prose(copied, open.start));
    let value = raw.slice(open.end, close.start).replace(/[\r\n]/g, " ");
    if (value.startsWith(" ") && value.endsWith(" ") && /[^ ]/.test(value))
      value = value.slice(1, -1);
    chunks.push(`${marker}C${code.length};`);
    code.push({ source: raw.slice(open.start, close.end), value });
    copied = close.end;
    at = open.next;
  }
  chunks.push(prose(copied, raw.length));
  const token = new RegExp(`${marker}([AC])(\\d+);`, "g");
  const originalLabel = (value: string) =>
    value.replace(token, (_all, kind: string, index: string) =>
      kind === "C"
        ? required(code[Number(index)]).source
        : String.fromCharCode(Number(index)),
    );
  let text = withoutLinkDestinations(chunks.join(""), links, originalLabel);
  const numbered: string[] = [];
  copied = 0;
  scanFootnotes(
    text,
    0,
    text.length,
    numbers,
    (start, end, label) => {
      numbered.push(text.slice(copied, start), String(numbers.get(label)));
      copied = end;
    },
    links,
    true,
  );
  numbered.push(text.slice(copied));
  text = numbered.join("");
  text = decodeString(text);
  return text.replace(token, (_all, kind: string, index: string) =>
    kind === "C" ? required(code[Number(index)]).value : "",
  );
}

const headingParser = unified().use(remarkParse).use(remarkGfm);
const MAX_PARSED_TITLE_CHARS = 500;
const HEADING_PARSE_BUDGET = 100_000;

/** Parse only short titles: unmatched attention runs can be superlinear. */
function headingText(
  raw: string,
  links: ReadonlyMap<string, DefinitionSpan>,
  numbers: ReadonlyMap<string, number>,
  budget: { left: number },
): string {
  if (raw.length > MAX_PARSED_TITLE_CHARS || raw.length > budget.left) {
    // Preserve ordinary formatting with linear scans once the bounded parser
    // budget is unavailable; never parse an unrestricted heading title.
    return linearHeadingText(raw, links, numbers);
  }
  budget.left -= raw.length;
  if (/^[^\\&`*_~[\]!<#\t\n\r\0]*$/.test(raw)) return raw;
  const definitions: string[] = [];
  const seen = new Set<string>();
  for (let at = 0; at < raw.length; at++) {
    if (raw[at] === "\\") {
      at++;
      continue;
    }
    if (raw[at] !== "[") continue;
    const end = referenceLabelEnd(raw, at + 1);
    if (end === undefined) continue;
    const label = raw.slice(at + 1, end),
      normalized = normalizeLabel(label);
    if (
      label.startsWith("^") &&
      numbers.has(normalizeLabel(label.slice(1))) &&
      !seen.has(normalized)
    ) {
      definitions.push(`[${label}]: note`);
      seen.add(normalized);
    } else if (links.has(normalized) && !seen.has(normalized)) {
      definitions.push(`[${label}]: /`);
      seen.add(normalized);
    }
    at = end;
  }
  const node = required(
    headingParser.parse(
      `${raw.includes("\n") ? `${raw}\n===` : `# ${raw}`}\n\n${definitions.join("\n")}`,
    ).children[0],
  );
  let result = "";
  const pending: MdContent[] = node ? [node] : [];
  while (pending.length) {
    const item = required(pending.pop());
    if (item.type === "footnoteReference")
      result +=
        numbers.get(normalizeLabel(item.identifier)) ??
        `[^${item.label ?? item.identifier}]`;
    else if (item.type === "image" || item.type === "imageReference")
      result += item.alt ?? "";
    else if ("value" in item) result += item.value;
    else if ("children" in item)
      for (let at = item.children.length - 1; at >= 0; at--)
        pending.push(required(item.children[at]) as MdContent);
  }
  return result;
}

type Index = {
  headings: IndexedHeading[];
  links: Map<string, DefinitionSpan>;
  footnotes: Map<string, DefinitionSpan>;
  footnoteNumbers: Map<string, number>;
  origins: Map<string, number>;
  notes: DefinitionSpan[];
  truncated: boolean;
  unclosed?: number | undefined;
  definitionAt: ReturnType<typeof referenceDefinitions>;
  definitions: Map<number, ReferenceDefinition>;
  plain: boolean;
};

function deepOwners(state: FenceState): boolean {
  return (
    !!state.overflow ||
    state.owners.reduce(
      (depth, owner) => depth + (owner.kind === "list" ? 2 : 1),
      0,
    ) >= MAX_RENDER_DEPTH
  );
}

function indexSource(text: string, counts?: Map<string, number>): Index {
  const headings: IndexedHeading[] = [],
    links = new Map<string, DefinitionSpan>(),
    footnotes = new Map<string, DefinitionSpan>();
  const notes: DefinitionSpan[] = [],
    origins = new Map<string, number>();
  const definitions = new Map<number, ReferenceDefinition>();
  const budget = definitionBudget(),
    definitionAt = containerDefinitions(text, budget);
  let cursor = initialCursor(text),
    note: DefinitionSpan | undefined,
    noteCursor = initialCursor("");
  let referenceEnd = 0,
    truncated = false;
  let paragraph:
    | { offset: number; cursor: Cursor; owners: readonly number[] }
    | undefined;
  const retain = (
    offset: number,
    end: number,
    depth: number,
    value: string,
  ) => {
    if (headings.length < MAX_PART_HEADINGS)
      headings.push({ offset, end, depth, text: value, id: "" });
    else truncated = true;
  };
  while (cursor.offset < text.length) {
    const line = sourceLine(text, cursor, definitionAt);
    if (budget.exhausted) break;
    if (line.definition) definitions.set(cursor.offset, line.definition);
    const raw = text.slice(cursor.offset, line.end);
    const content = line.body,
      bodyStart = line.bodyStart - line.bodyPadding;
    let column = 0,
      indent = 0;
    while (column < 4 && (content[indent] === " " || content[indent] === "\t"))
      column += content[indent++] === "\t" ? 4 - (column % 4) : 1;
    const inner = {
      ...noteCursor,
      offset:
        line.bodyStart +
        (column >= 4 ? Math.max(0, indent - line.bodyPadding) : 0),
    };
    const noteLine = note ? sourceLine(text, inner) : undefined;
    const sameOwners =
      noteLine &&
      (noteCursor.syntax?.owners.length ?? 0) ===
        noteLine.syntax.owners.length &&
      noteLine.syntax.owners.every(
        (owner, at) => owner.id === required(noteCursor.syntax?.owners[at]).id,
      );
    const lazy =
      note &&
      noteCursor.paragraph &&
      !noteCursor.fence &&
      !noteCursor.opaque &&
      noteLine?.paragraph &&
      !noteLine.code &&
      !noteLine.opaque &&
      sameOwners &&
      footnoteDefinitionLabel(content) === undefined;
    let inNote = false;
    const sameNoteOwners =
      (note?.owners?.length ?? 0) === line.syntax.owners.length &&
      line.syntax.owners.every(
        (owner, at) => owner.id === note?.owners?.[at]?.id,
      );
    if (note && sameNoteOwners && (line.blank || column >= 4 || lazy)) {
      inNote = true;
      if (!line.blank) note.end = line.next;
      if (deepOwners(required(noteLine).syntax)) note.deep = true;
      noteCursor = nextLine(inner, required(noteLine));
    } else {
      note = undefined;
      if (
        !line.code &&
        (line.definition || !line.opaque) &&
        cursor.offset >= referenceEnd
      ) {
        const label = footnoteDefinitionLabel(content);
        if (label !== undefined && !budget.charge(label.length)) break;
        if (line.definition) referenceEnd = line.definition.end;
        if (label !== undefined || line.definition) {
          const key = label ?? required(line.definition).label;
          const span: DefinitionSpan = {
            ...line.definition,
            start: cursor.offset,
            end: line.definition?.end ?? line.next,
            ...(line.syntax.owners.length
              ? {
                  owners: line.syntax.owners,
                  bodyStart: line.bodyStart,
                  padding: line.bodyPadding,
                }
              : {}),
          };
          const map = label !== undefined ? footnotes : links;
          if (!map.has(key)) map.set(key, span);
          if (label !== undefined) {
            inNote = true;
            note = span;
            notes.push(span);
            const colon =
              required(
                footnoteLabelEnd(
                  content,
                  content.indexOf("[^") + 2,
                  content.length,
                ),
              ) + 1;
            const beginning = {
              ...initialCursor(""),
              offset:
                bodyStart +
                colon +
                1 +
                (/^[\t ]/.test(content.slice(colon + 1)) ? 1 : 0),
              line: cursor.line,
            };
            const beginningLine = sourceLine(text, beginning);
            if (deepOwners(beginningLine.syntax)) span.deep = true;
            noteCursor = nextLine(beginning, beginningLine);
          }
        }
      }
    }
    if (referenceEnd > line.next) {
      const breaks = /\r\n|\r|\n/g;
      breaks.lastIndex = cursor.offset;
      let count = 0;
      for (
        let match = breaks.exec(text);
        match && match.index < referenceEnd;
        match = breaks.exec(text)
      )
        count++;
      cursor = {
        offset: referenceEnd,
        line: cursor.line + count,
        previousBlank: false,
        paragraph: false,
        syntax: line.syntax,
      };
      paragraph = undefined;
      continue;
    }
    const owners = line.syntax.owners.map((owner) => owner.id);
    const sameParagraphOwners =
      paragraph?.owners.length === owners.length &&
      owners.every((id, at) => id === paragraph?.owners[at]);
    const setext =
      !inNote &&
      !line.code &&
      !line.opaque &&
      paragraph &&
      sameParagraphOwners &&
      line.body.match(/^ {0,3}(=+|-+)[\t ]*$/);
    if (setext) {
      const lines: string[] = [];
      let previous = required(paragraph).cursor;
      while (previous.offset < cursor.offset) {
        const entry = sourceLine(text, previous);
        lines.push(entry.body.trim());
        previous = nextLine(previous, entry);
      }
      retain(
        required(paragraph).offset,
        line.next,
        required(setext[1])[0] === "=" ? 1 : 2,
        lines.join("\n"),
      );
      paragraph = undefined;
    } else if (!inNote && !line.code && !line.opaque && line.heading) {
      const title = required(line.heading[2])
        .replace(/[\t ]+#+[\t ]*$/, "")
        .trim();
      retain(
        bodyStart + (line.body.match(/^ */)?.[0].length ?? 0),
        line.next,
        required(line.heading[1]).length,
        title,
      );
      paragraph = undefined;
    } else if (
      !inNote &&
      !line.code &&
      !line.opaque &&
      line.paragraph &&
      tableIndent(raw, line.body)
    ) {
      const offset = bodyStart + (line.body.match(/^ */)?.[0].length ?? 0);
      paragraph =
        paragraph && sameParagraphOwners && cursor.paragraph
          ? paragraph
          : { offset, cursor, owners };
    } else paragraph = undefined;
    cursor = nextLine(cursor, line);
  }
  const indexed = referenceDefinitions(text, budget, definitions);
  if (budget.exhausted)
    return {
      headings: [],
      links: new Map(),
      footnotes: new Map(),
      notes: [],
      footnoteNumbers: new Map(),
      origins,
      truncated,
      definitionAt: () => undefined,
      definitions: new Map(),
      plain: true,
    };
  const numbers = footnoteNumbers(
    text,
    footnotes,
    links,
    indexed,
    notes,
    origins,
    counts,
  );
  const slugger = new GithubSlugger(),
    parseBudget = { left: HEADING_PARSE_BUDGET };
  for (const heading of headings) {
    heading.text = headingText(heading.text, links, numbers, parseBudget);
    heading.id = slugger.slug(heading.text);
  }
  return {
    headings,
    links,
    footnotes,
    notes,
    footnoteNumbers: numbers,
    origins,
    truncated,
    definitionAt: indexed,
    definitions,
    plain: false,
    ...(cursor.fence?.swallowed ? { unclosed: cursor.fence.line } : {}),
  };
}

/** Same Unicode words as the Markdown metadata, without a regex match per word. */
function wordCount(text: string): number {
  const unicode = /[\p{L}\p{N}]/u;
  const letter = (code: number) =>
    code < 128
      ? (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122)
      : unicode.test(String.fromCodePoint(code));
  let count = 0,
    inside = false;
  for (let at = 0; at < text.length; at++) {
    const code = required(text.codePointAt(at));
    if (letter(code)) {
      if (!inside) count++;
      inside = true;
    } else {
      const connector =
        code === 39 || code === 0x2019 || code === 95 || code === 45;
      const next = text.codePointAt(at + 1);
      inside = inside && connector && next !== undefined && letter(next);
    }
    if (code > 0xffff) at++;
  }
  return count;
}

/** Plain files need only physical line boundaries, never Markdown state. */
function plainParts(text: string): DocumentPart[] {
  const parts: DocumentPart[] = [];
  let cachedStart = -1,
    cachedEnd = -1,
    cachedNext = -1;
  const lineAt = (start: number) => {
    if (start >= cachedStart && start <= cachedEnd) return;
    let end = start;
    while (
      end < text.length &&
      text.charCodeAt(end) !== 13 &&
      text.charCodeAt(end) !== 10
    )
      end++;
    cachedStart = start;
    cachedEnd = end;
    cachedNext =
      end < text.length
        ? end +
          (text.charCodeAt(end) === 13 && text.charCodeAt(end + 1) === 10
            ? 2
            : 1)
        : end;
  };
  let start = 0,
    line = 1,
    midline = false;

  do {
    if (text.length - start <= PART_CHARS) {
      parts.push({ start, end: text.length, line });
      break;
    }
    const upper = start + PART_CHARS;
    const left = Math.ceil((text.length - start) / PART_CHARS);
    const aim = start + (text.length - start) / left;
    const lower = start + PART_CHARS / 2;
    let at = start,
      number = line,
      current = midline;
    let chosen = -1,
      chosenLine = line;
    for (;;) {
      if (
        !current &&
        at >= lower &&
        at <= upper &&
        at < text.length &&
        at > start &&
        (chosen < 0 || Math.abs(at - aim) < Math.abs(chosen - aim))
      ) {
        chosen = at;
        chosenLine = number;
      }
      lineAt(at);
      if (cachedNext > upper || cachedNext === text.length) {
        let end: number;
        if (chosen >= 0) {
          end = chosen;
          number = chosenLine;
          midline = false;
        } else if (!current && at > start && cachedEnd - at <= PART_CHARS) {
          end = at;
          midline = false;
        } else {
          end = safeCut(text, upper);
          midline = true;
        }
        parts.push({ start, end, line });
        start = end;
        line = number;
        break;
      }
      at = cachedNext;
      number++;
      current = false;
    }
  } while (start < text.length);
  return parts;
}

function safeCut(text: string, offset: number): number {
  const before = text.charCodeAt(offset - 1),
    after = text.charCodeAt(offset);
  return (before >= 0xd800 &&
    before <= 0xdbff &&
    after >= 0xdc00 &&
    after <= 0xdfff) ||
    (before === 13 && after === 10)
    ? offset - 1
    : offset;
}

function chooseCut(
  text: string,
  start: Cursor,
  aim: number,
  markdown: boolean,
  definitionAt?: ReturnType<typeof referenceDefinitions>,
  notes: readonly DefinitionSpan[] = [],
  headings: readonly IndexedHeading[] = [],
): Cursor {
  const upper = Math.min(start.offset + PART_CHARS, text.length),
    lower = start.offset + (upper - start.offset) / 2;
  const candidates: (Cursor | undefined)[] = [undefined, undefined, undefined];
  const consider = (kind: number, cursor: Cursor) => {
    if (
      cursor.offset < lower ||
      cursor.offset > upper ||
      cursor.offset >= text.length ||
      cursor.offset <= start.offset
    )
      return;
    let low = 0,
      high = headings.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (required(headings[middle]).end <= cursor.offset) low = middle + 1;
      else high = middle;
    }
    const heading = headings[low];
    if (
      heading &&
      heading.offset < cursor.offset &&
      cursor.offset < heading.end &&
      heading.end - heading.offset <= PART_CHARS
    )
      return;
    const previous = candidates[kind];
    if (
      !previous ||
      Math.abs(cursor.offset - aim) < Math.abs(previous.offset - aim)
    )
      candidates[kind] = cursor;
  };
  let cursor = start;
  while (cursor.offset < text.length && cursor.offset <= upper) {
    const line = sourceLine(text, cursor, definitionAt);
    if (!cursor.current && line.endedBefore)
      cursor = { ...cursor, fence: undefined };
    let low = 0,
      high = notes.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (required(notes[middle]).end <= cursor.offset) low = middle + 1;
      else high = middle;
    }
    const insideNote =
      !!notes[low] &&
      required(notes[low]).start < cursor.offset &&
      cursor.offset < required(notes[low]).end;
    if (!cursor.current && !insideNote) {
      consider(2, cursor);
      if (markdown && !line.code && !line.opaque) {
        if (line.heading) consider(0, cursor);
        if (
          cursor.previousBlank &&
          !line.blank &&
          !/^[\t ]/.test(text.charAt(cursor.offset))
        )
          consider(1, cursor);
      }
    }
    if (line.next > upper || line.next === text.length) {
      const chosen = candidates[0] ?? candidates[1] ?? candidates[2];
      if (chosen) return chosen;
      if (
        !cursor.current &&
        cursor.offset > start.offset &&
        line.end - cursor.offset <= PART_CHARS
      )
        return cursor;
      let offset = safeCut(text, upper);
      if (
        line.commentEnd !== undefined &&
        offset > line.commentEnd - 3 &&
        offset < line.commentEnd
      )
        offset = line.commentEnd - 3;
      if (line.explicit && line.explicitEnd !== undefined) {
        const closeStart =
          line.explicitEnd - explicitHtmlEnd(line.explicit).length;
        if (offset > closeStart && offset < line.explicitEnd)
          offset = closeStart;
      }
      let inline = false;
      if (markdown && !line.code && !line.opaque && !cursor.fence) {
        const safe = inlineCut(
          text,
          cursor.offset,
          Math.max(lower, cursor.offset + 1),
          offset,
          Math.min(line.end, offset + PART_CHARS),
        );
        if (safe === undefined) inline = true;
        else offset = safe;
      }
      return {
        ...cursor,
        offset,
        current: line,
        paragraph: line.paragraph,
        inline: inline ? true : undefined,
      };
    }
    cursor = nextLine(cursor, line);
  }
  return candidates[0] ?? candidates[1] ?? candidates[2] ?? cursor;
}

function partAt(parts: readonly DocumentPart[], offset: number): number {
  let low = 0,
    high = parts.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (required(parts[middle]).start <= offset) low = middle;
    else high = middle;
  }
  return low;
}

export function preparedPart(
  parts: DocumentParts,
  index: number,
): PreparedPart {
  if (!Number.isInteger(index) || index < 0 || index >= parts.parts.length)
    throw new RangeError("Invalid document part index");
  const context = partContext(parts);
  if (context.prepared?.index === index) return context.prepared.value;
  const value = assemblePart(parts, index);
  context.prepared = { index, value };
  return value;
}

/** Data sent across the worker boundary; readers and caches stay in this realm. */
export type IndexData = Omit<
  DocumentParts,
  "partSource" | "partFallback" | "partOf"
> & {
  kind: DocumentKind;
  definitionAt: Map<number, ReferenceDefinition>;
  context: Omit<PartContext, "text" | "kind" | "definitionAt" | "prepared">;
};

export function indexData(text: string, kind: DocumentKind): IndexData {
  const index = kind === "markdown" ? indexSource(text) : undefined;
  const markdown = kind === "markdown" && !index?.plain;
  const parts: DocumentPart[] = kind === "markdown" ? [] : plainParts(text),
    starts: Cursor[] = [],
    ends: Cursor[] = [];
  const definitionAt = markdown ? required(index).definitionAt : undefined;
  let cursor = initialCursor(text);
  if (kind === "markdown")
    while (cursor.offset < text.length || !parts.length) {
      const start = cursor;
      if (text.length - start.offset <= PART_CHARS) {
        while (cursor.offset < text.length)
          cursor = nextLine(cursor, sourceLine(text, cursor, definitionAt));
      } else {
        const left = Math.ceil((text.length - start.offset) / PART_CHARS);
        cursor = chooseCut(
          text,
          start,
          start.offset + (text.length - start.offset) / left,
          markdown,
          definitionAt,
          index?.notes,
          index?.headings,
        );
        if (markdown && !cursor.current && !cursor.fence && !cursor.opaque) {
          const offset = tableStartForCut(text, cursor.offset, start.offset);
          if (offset !== cursor.offset)
            cursor = {
              ...cursor,
              offset,
              line: cursor.line - 1,
              previousBlank: false,
              paragraph: false,
            };
        }
      }
      parts.push({
        start: start.offset,
        end: cursor.offset,
        line: start.line,
        ...(markdown && start.fence ? { fence: start.fence.opener } : {}),
      });
      starts.push(start);
      ends.push(cursor);
    }
  const headings = new Map<string, number>(),
    outline: PartOutlineItem[] = [];
  for (const heading of index?.headings ?? []) {
    const part = partAt(parts, heading.offset);
    headings.set(heading.id, part);
    if (heading.depth <= 3)
      outline.push({
        depth: heading.depth as 1 | 2 | 3,
        text: heading.text,
        id: heading.id,
        part,
      });
  }
  const footnoteParts = new Map<string, number>();
  for (const [label, offset] of index?.origins ?? [])
    footnoteParts.set(label, partAt(parts, offset));
  const words = kind === "markdown" ? wordCount(text) : 0;
  return {
    kind,
    definitionAt: index?.definitions ?? new Map(),
    parts,
    outline,
    headings,
    words,
    readingMinutes: Math.max(1, Math.ceil(words / 230)),
    ...(index?.truncated ? { headingsTruncated: true } : {}),
    ...(index?.unclosed ? { unclosedFence: index.unclosed } : {}),
    context: {
      headings: index?.headings ?? [],
      links: index?.links ?? new Map(),
      footnotes: index?.footnotes ?? new Map(),
      footnoteNumbers: index?.footnoteNumbers ?? new Map(),
      footnoteParts,
      notes: index?.notes ?? [],
      starts,
      ends,
      plain: index?.plain ?? false,
      blocks: markdown
        ? markdownBlocks(
            text,
            parts,
            positionedReferenceDefinitions(
              text,
              false,
              required(index).definitionAt,
            ),
          )
        : [],
    },
  };
}

export function documentParts(text: string, data: IndexData): DocumentParts {
  const { kind, context, definitionAt, ...metadata } = data;
  const { parts, headings } = metadata;
  const { footnoteParts } = context;
  const anchors = new Map<string, number>(headings);
  for (const [label, part] of footnoteParts) {
    const safe = label.toLowerCase();
    anchors.set(`fn-${safe}`, part);
    anchors.set(`fnref-${safe}`, part);
  }
  const result: DocumentParts = {
    ...metadata,
    partSource(part) {
      return preparedPart(result, part).source;
    },
    partFallback(part) {
      return preparedPart(result, part).fallback;
    },
    partOf(raw) {
      let id = raw.replace(/^#/, "");
      try {
        id = decodeURIComponent(id);
      } catch {
        /* preserve malformed literals */
      }
      // A literal slug wins when it also looks like a prefixed identifier.
      // Callers can use the additional prefix for that heading's rendered ID.
      const bare = anchors.get(id);
      if (bare !== undefined) return bare;
      id = id.replace(/^user-content-/, "");
      const exact = anchors.get(id);
      if (exact !== undefined) return exact;
      const suffix = id.match(/^(fn(?:ref)?-.+)-part-(\d+)$/);
      if (suffix) {
        const target = Number(suffix[2]);
        if (
          !Number.isSafeInteger(target) ||
          target < 0 ||
          target >= parts.length
        )
          return undefined;
        const prepared = preparedPart(result, target);
        if (prepared.plain) return undefined;
        if (!prepared.footnoteTargets) {
          const counts = new Map<string, number>();
          const local = indexSource(prepared.source, counts);
          const targets = new Set<string>();
          for (const label of local.footnoteNumbers.keys()) {
            if (
              footnoteParts.get(label) === target ||
              !footnoteParts.has(label)
            )
              continue;
            const bare = label.toLowerCase();
            targets.add(`fn-${bare}`);
            targets.add(`fnref-${bare}`);
            for (let repeat = 2; repeat <= (counts.get(label) ?? 1); repeat++)
              targets.add(`fnref-${bare}-${repeat}`);
          }
          prepared.footnoteTargets = targets;
        }
        return prepared.footnoteTargets.has(suffix[1] ?? "")
          ? target
          : undefined;
      }
      return anchors.get(id.replace(/^(fnref-.+?)-\d+$/, "$1"));
    },
  };
  contexts.set(result, {
    ...context,
    kind,
    text,
    definitionAt: (offset) => definitionAt.get(offset),
  });
  return result;
}

export function indexDocument(text: string, kind: DocumentKind): DocumentParts {
  return documentParts(text, indexData(text, kind));
}

/** Apply globally indexed IDs by source offset, including reconstructed parts. */
export function remarkPartHeadings(
  parts: DocumentParts,
  index: number,
): Plugin<[], MdRoot> {
  return () => (tree) => {
    const context = partContext(parts),
      prepared = preparedPart(parts, index);
    if (prepared.plain) return;
    prepareBlocks(tree, context.blocks[index], prepared.prefix);
    const stack: (MdRoot | MdContent)[] = [tree];
    while (stack.length) {
      const node = required(stack.pop());
      const offset = node.position?.start.offset;
      if (node.type === "heading" && offset !== undefined) {
        const id = prepared.headingOffsets.get(offset);
        if (id !== undefined) {
          node.data ??= {};
          node.data.hProperties ??= {};
          node.data.hProperties.id = `user-content-${id}`;
        }
      }
      if (
        node.type === "html" &&
        node.position?.start.offset !== undefined &&
        node.position.end.offset !== undefined
      ) {
        const start = node.position.start.offset,
          end = node.position.end.offset;
        let copied = start;
        const chunks: string[] = [];
        for (const range of prepared.synthetic ?? []) {
          if (range.end <= copied || range.start >= end) continue;
          chunks.push(
            prepared.source.slice(copied, Math.max(copied, range.start)),
          );
          copied = Math.min(end, range.end);
        }
        if (chunks.length || copied !== start)
          node.value = chunks.join("") + prepared.source.slice(copied, end);
      }
      if ("children" in node)
        for (let at = node.children.length - 1; at >= 0; at--)
          stack.push(required(node.children[at]) as MdContent);
    }
  };
}

/** Keep canonical footnote targets on their first part, local IDs elsewhere. */
export function rehypePartFootnotes(
  parts: DocumentParts,
  index: number,
): Plugin<[], HastRoot> {
  return () => (tree) => {
    const context = partContext(parts),
      prepared = preparedPart(parts, index);
    if (prepared.plain) return;
    finishBlocks(tree, context.blocks[index], prepared.prefix);
    const suffixFor = (id: string): string => {
      const bare = id.replace(/^user-content-/, "");
      if (bare === "footnote-label") return index ? `${id}-part-${index}` : id;
      const match = bare.match(/^fn(ref)?-(.*)$/);
      if (!match) return id;
      let label = match[2] ?? "";
      try {
        label = decodeURIComponent(label);
      } catch {
        /* literal malformed escape */
      }
      let owner = context.footnoteParts.get(normalizeLabel(label));
      if (owner === undefined && match[1])
        owner = context.footnoteParts.get(
          normalizeLabel(label.replace(/-\d+$/, "")),
        );
      return owner !== undefined && owner !== index
        ? `${id}-part-${index}`
        : id;
    };
    const numberFor = (id: string): number | undefined => {
      let label = id.replace(/^#?user-content-fn(?:ref)?-/, "");
      try {
        label = decodeURIComponent(label);
      } catch {
        /* literal */
      }
      return (
        context.footnoteNumbers.get(normalizeLabel(label)) ??
        context.footnoteNumbers.get(normalizeLabel(label.replace(/-\d+$/, "")))
      );
    };
    const stack: (HastRoot | Element)[] = [tree];
    while (stack.length) {
      const node = required(stack.pop());
      let number: number | undefined;
      if (node.type === "element") {
        const props = node.properties;
        if (
          (props.dataFootnoteRef !== undefined ||
            props.dataFootnoteBackref !== undefined) &&
          typeof props.href === "string"
        )
          number = numberFor(props.href);
        if (typeof props.id === "string") {
          if (
            node.tagName === "li" &&
            props.id.startsWith("user-content-fn-")
          ) {
            const definitionNumber = numberFor(props.id);
            if (definitionNumber !== undefined)
              props.value = String(definitionNumber);
          }
          props.id = suffixFor(props.id);
        }
        if (typeof props.href === "string" && props.href.startsWith("#"))
          props.href = `#${suffixFor(props.href.slice(1))}`;
        if (Array.isArray(props.ariaDescribedBy))
          props.ariaDescribedBy = props.ariaDescribedBy.map((id) =>
            typeof id === "string" ? suffixFor(id) : id,
          );
        if (
          props.dataFootnoteRef !== undefined &&
          typeof props.href === "string"
        ) {
          if (number !== undefined)
            node.children = [{ type: "text", value: String(number) }];
        }
      }
      if (
        node.type === "element" &&
        node.properties.dataFootnoteBackref !== undefined &&
        typeof node.properties.href === "string" &&
        typeof node.properties.ariaLabel === "string"
      ) {
        if (number !== undefined)
          node.properties.ariaLabel = node.properties.ariaLabel.replace(
            /^(Back to reference )\d+/,
            `$1${number}`,
          );
      }
      for (const child of node.children)
        if (child.type === "element") stack.push(child);
    }
  };
}
