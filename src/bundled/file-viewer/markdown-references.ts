import { required } from "./markdown-limits";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { startsBlankHtmlBlock } from "./markdown-html";
import { MAX_RENDER_CHARS } from "./markdown-limits";

export type ReferenceDefinition = Readonly<{
  label: string;
  start: number;
  end: number;
}>;
export type DefinitionBudget = Readonly<{
  exhausted: boolean;
  charge: (labelSize: number) => boolean;
}>;
// Leave room above the ordinary 4,172-entry reading-list corpus while the
// independent character-work cap continues to bound large labels.
const MAX_DEFINITIONS = 16_384;
const DEFINITION_OVERHEAD = 16;

/** Charge attempts, including duplicate labels, before parsing or retaining.
 * Payload length belongs to part admission, not this bounded label budget. */
export function definitionBudget(): DefinitionBudget {
  let count = 0,
    work = 0,
    exhausted = false;
  return {
    get exhausted() {
      return exhausted;
    },
    charge(labelSize) {
      if (
        exhausted ||
        count >= MAX_DEFINITIONS ||
        labelSize + DEFINITION_OVERHEAD > MAX_RENDER_CHARS - work
      ) {
        exhausted = true;
        return false;
      }
      count++;
      work += labelSize + DEFINITION_OVERHEAD;
      return true;
    },
  };
}

/** micromark-factory-label counts escaped punctuation, but not line endings,
 * towards its 999-character ceiling. Bracket escapes stay in the identifier. */
export function referenceLabelEnd(
  text: string,
  start: number,
): number | undefined {
  let size = 0,
    seen = false;
  // Each counted character can also have one CRLF before it. Blank source
  // lines cannot belong to a parsed reference label.
  for (
    let at = start;
    at < text.length && at - start <= 3000 && size <= 999;
    at++
  ) {
    const value = text[at];
    if (value === "]") return seen ? at : undefined;
    if (value === "[") return undefined;
    if (value === "\r" || value === "\n") continue;
    size++;
    seen ||= value !== " " && value !== "\t";
    if (value === "\\" && /[[\]\\]/.test(text[at + 1] ?? "")) {
      at++;
      size++;
    }
  }
  return undefined;
}

/** A bounded projection must not turn its edge into semantic end-of-input. */
export type ReferenceWindow = { complete: boolean; needsMore: boolean };

const processor = unified().use(remarkParse);
const space = (char: string | undefined) => char === " " || char === "\t";
const ending = (char: string | undefined) => char === "\n" || char === "\r";

/** Validate payloads lexically and let the installed parser validate only the
 * bounded label. Overlapping candidates never reparse a shared title payload. */
export function referenceDefinitions(
  text: string,
  budget = definitionBudget(),
  accepted?: ReadonlyMap<number, ReferenceDefinition>,
  window?: ReferenceWindow,
): (offset: number) => ReferenceDefinition | undefined {
  // Whole-file later passes consume the first pass's bounded accepted spans.
  if (accepted) return (offset) => accepted.get(offset);
  const boundary = () => {
    if (window && !window.complete) window.needsMore = true;
  };
  const breaks = /[\r\n]/g;
  const lineEnd = (at: number) => {
    breaks.lastIndex = at;
    return breaks.exec(text)?.index ?? text.length;
  };
  const nextLine = (at: number) =>
    at + (text[at] === "\r" && text[at + 1] === "\n" ? 2 : 1);
  const white = (at: number) => {
    while (space(text[at])) at++;
    if (ending(text[at])) {
      at = nextLine(at);
      while (space(text[at])) at++;
    }
    return at;
  };
  const interrupts = (start: number): boolean => {
    const line = text.slice(start, lineEnd(start));
    // A multiline definition/title is still provisional paragraph content.
    // These core blocks can interrupt it; four-column indentation cannot.
    if (
      /^ {0,3}(?:#{1,6}(?:[\t ]|$)|>|(?:=+|-+)[\t ]*$|(?:\*[\t ]*){3,}$|(?:_[\t ]*){3,}$|<!--|<\?|<!\[CDATA\[|<![A-Za-z])/.test(
        line,
      ) ||
      /^ {0,3}<(?:script|style|pre|textarea)(?:[\t >]|\/>|$)/i.test(line)
    )
      return true;
    if (
      /^ {0,3}(?:[*+-]|1[.)])[\t ]+[^\t ]/.test(line) ||
      startsBlankHtmlBlock(line)
    )
      return true;
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    return (
      !!fence &&
      (required(fence[1])[0] !== "`" || !required(fence[2]).includes("`"))
    );
  };
  const searches = new Map<
    string,
    { start: number; end: number; close?: number }
  >();
  const titleClose = (start: number): number | undefined => {
    const closer = text[start] === "(" ? ")" : text.charAt(start);
    const cached = searches.get(closer);
    if (cached && start >= cached.start && start < cached.end) {
      if (cached.end >= text.length) boundary();
      return cached.close;
    }
    let at = start + 1;
    for (; at < text.length; at++) {
      if (text[at] === closer) {
        searches.set(closer, { start, end: at, close: at });
        return at;
      }
      if (
        text[at] === "\\" &&
        (text[at + 1] === closer || text[at + 1] === "\\")
      ) {
        at++;
        continue;
      }
      if (ending(text[at])) {
        const startOfLine = nextLine(at);
        const next = white(at);
        if (ending(text[next])) {
          at = next;
          break;
        }
        if (interrupts(startOfLine)) {
          at = startOfLine;
          break;
        }
        at = next - 1;
      }
    }
    if (at >= text.length) boundary();
    searches.set(closer, { start, end: at });
    return undefined;
  };
  return (offset) => {
    if (window) window.needsMore = false;
    if (budget.exhausted) return undefined;
    let at = offset;
    while (at - offset < 4 && text[at] === " ") at++;
    if (at - offset > 3 || text[at] !== "[") return undefined;
    const labelEnd = referenceLabelEnd(text, at + 1);
    if (labelEnd === undefined) {
      if (text.length - at < 3002) boundary();
      return undefined;
    }
    if (labelEnd + 1 >= text.length) boundary();
    if (text[labelEnd + 1] !== ":" || text[at + 1] === "^") return undefined;
    if (!budget.charge(labelEnd + 2 - offset)) return undefined;
    at = white(labelEnd + 2);
    let destinationLine = offset;
    for (let next = labelEnd + 2; next < at; next++)
      if (ending(text[next])) destinationLine = next + 1;
    if (destinationLine !== offset && interrupts(destinationLine))
      return undefined;
    const destination = at;
    if (text[at] === "<") {
      for (
        at++;
        at < text.length &&
        !ending(text[at]) &&
        text[at] !== "<" &&
        text[at] !== ">";
        at++
      )
        if (text[at] === "\\" && /[<>\\]/.test(text[at + 1] ?? "")) at++;
      if (at >= text.length) boundary();
      if (text[at] !== ">") return undefined;
      at++;
    } else {
      let balance = 0;
      for (; at < text.length && !space(text[at]) && !ending(text[at]); at++) {
        if (text[at] === "\\" && /[()\\]/.test(text[at + 1] ?? "")) {
          at++;
          continue;
        }
        if (text[at] === "(") balance++;
        else if (text[at] === ")") {
          if (!balance) break;
          balance--;
        } else if (text.charCodeAt(at) < 32 || text.charCodeAt(at) === 127)
          return undefined;
      }
      if (at >= text.length) boundary();
      if (at === destination || balance) return undefined;
    }
    let end = lineEnd(at),
      validTitle = false;
    let baseTail = at;
    while (space(text[baseTail])) baseTail++;
    const validBase = baseTail === text.length || ending(text[baseTail]);
    const title = white(at);
    if (title >= text.length) boundary();
    if (title > at && /["'(]/.test(text[title] ?? "")) {
      const close = titleClose(title);
      if (close !== undefined) {
        let tail = close + 1;
        while (space(text[tail])) tail++;
        if (tail >= text.length) boundary();
        if (tail === text.length || ending(text[tail])) {
          end = tail;
          validTitle = true;
        }
      }
    }
    if (!validTitle && !validBase) return undefined;
    // Only labels need parser validation now. Always compress payloads, not
    // just individually oversized ones: many small overlapping candidates can
    // otherwise make cumulative synchronous parsing quadratic. Keep original
    // spans so part-context admission still charges every source character.
    const candidate = `${text.slice(offset, labelEnd + 2)} x${validTitle ? ' ""' : ""}`;
    const node = processor.parse(candidate).children[0];
    if (node?.type !== "definition" || node.position?.end.offset === undefined)
      return undefined;
    let last = end;
    while (space(text[last])) last++;
    if (ending(text[last])) last = nextLine(last);
    return { label: node.identifier.toUpperCase(), start: offset, end: last };
  };
}
