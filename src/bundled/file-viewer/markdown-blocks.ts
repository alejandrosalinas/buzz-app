import { required } from "./markdown-limits";
// Bounded block context at part cuts; no whole-document syntax tree is retained.
import type { Root, Element } from "hast";
import type { DocumentPart } from "./document-parts";
import { MAX_RENDER_CHARS, MAX_RENDER_DEPTH } from "./markdown-limits";
import { startsBlankHtmlBlock, isStandaloneHtmlTag } from "./markdown-html";
import type { referenceDefinitions } from "./markdown-references";
import { fenceLine } from "./markdown-fences";
import type { FenceState, Owner } from "./markdown-fences";
import { explicitHtmlStart, explicitHtmlEnd } from "./markdown-html-explicit";
import type { ExplicitHtml } from "./markdown-html-explicit";

type List = { offset: number; marker: string; loose: boolean };
type Frame = {
  list: List;
  number: number;
  item: number;
  indent: number;
  content: number;
  marker: string;
  fenced?: boolean | undefined;
  quotes?: readonly number[] | undefined;
  owner?: number;
};
type Entry = Frame & { continued: boolean };
export type BlockPart = {
  prefix: string;
  overflow?: boolean | undefined;
  deep?: boolean | undefined;
  codeEnd?: { offset: number; ending: string };
  table?: { start: number; end: number; columns: number; indent: number };
  first: Entry[];
  last: Entry[];
  start: number;
};
type Syntax = {
  type: string;
  value?: string | undefined;
  position?: { start: { offset?: number | undefined } } | undefined;
  children?: Syntax[] | undefined;
  start?: number | null | undefined;
  spread?: boolean | null | undefined;
  data?: { hProperties?: Record<string, unknown> | undefined } | undefined;
};

const marker = /^( *)([*+-]|\d{1,9}[.)])(?:([\t ]+)(.*)|$)/;
const thematic = /^ {0,3}(?:(?:\*[\t ]*){3,}|(?:-[\t ]*){3,}|(?:_[\t ]*){3,})$/;
const interrupt = /^(?: {0,3}(?:#{1,6}(?:\s|$)|>|`{3,}|~{3,}|<!--)|\s*$)/;
function columns(line: string): string[] | undefined {
  if (!line.includes("|")) return undefined;
  const cells: string[] = [];
  let cell = "",
    lastPipe = -1;
  for (let at = 0; at < line.length; at++) {
    if (line[at] === "\\" && (line[at + 1] === "|" || line[at + 1] === "\\")) {
      cell += line.slice(at, at + 2);
      at++;
    } else if (line[at] === "|") {
      cells.push(cell.trim());
      cell = "";
      lastPipe = at;
    } else cell += line[at];
  }
  cells.push(cell.trim());
  if (line.trimStart().startsWith("|")) cells.shift();
  if (lastPipe === line.trimEnd().length - 1) cells.pop();
  return cells;
}

/** GFM splits cells on unescaped pipes, including pipes inside code spans. */
export function tableCells(line: string): { start: number; end: number }[] {
  const cells: { start: number; end: number }[] = [];
  let start = 0;
  for (let at = 0; at < line.length; at++) {
    if (line[at] === "\\") {
      at++;
      continue;
    }
    if (line[at] === "|") {
      cells.push({ start, end: at });
      start = at + 1;
    }
  }
  cells.push({ start, end: line.length });
  if (
    cells.length > 1 &&
    /^[\t ]*$/.test(line.slice(0, required(cells[0]).end))
  )
    cells.shift();
  if (
    cells.length > 1 &&
    /^[\t ]*$/.test(line.slice(required(cells.at(-1)).start))
  )
    cells.pop();
  return cells;
}

/** Table headers/delimiters cannot start in four-column code indentation.
 * Recover the physical column before any remaining tab in the owner-stripped
 * body: fenceLine may have replaced a partially consumed tab with spaces. */
export function tableIndent(raw: string, body: string): boolean {
  const spaces = required(required(body.match(/^ */))[0]).length;
  if (spaces >= 4) return false;
  let column = 0,
    indent = spaces;
  for (let at = 0; at < raw.length - body.length + spaces; at++)
    column += raw[at] === "\t" ? 4 - (column % 4) : 1;
  for (let at = spaces; body[at] === " " || body[at] === "\t"; at++) {
    const width = body[at] === "\t" ? 4 - (column % 4) : 1;
    column += width;
    indent += width;
    if (indent >= 4) return false;
  }
  return true;
}

/** The header and delimiter establish one table and must share a part. */
export function tableStartForCut(
  text: string,
  cut: number,
  floor: number,
): number {
  let end = cut;
  if (text[end - 1] === "\n") end--;
  if (text[end - 1] === "\r") end--;
  let start = end;
  while (start > floor && text[start - 1] !== "\r" && text[start - 1] !== "\n")
    start--;
  if (start <= floor) return cut;
  let next = cut;
  while (next < text.length && text[next] !== "\r" && text[next] !== "\n")
    next++;
  const delimiter = columns(text.slice(cut, next)),
    header = columns(text.slice(start, end));
  return delimiter?.length &&
    header?.length === delimiter.length &&
    delimiter.every((cell) => /^:?-+:?$/.test(cell))
    ? start
    : cut;
}

/** One forward scan. Retained list records are shared only by parts they cross. */
export function markdownBlocks(
  text: string,
  parts: readonly DocumentPart[],
  definitionAt: ReturnType<typeof referenceDefinitions>,
): BlockPart[] {
  const result: BlockPart[] = parts.map((part) => ({
    prefix: "",
    first: [],
    last: [],
    start: part.start,
  }));
  let frames: Frame[] = [],
    part = 0,
    start = 0,
    blank = true,
    indentation = 0;
  let previous: { start: number; end: number; content: string } | undefined;
  let table: BlockPart["table"];
  let fences: FenceState = { owners: [] };
  let beforeOwners: readonly Owner[] = [];
  let indentedCode = false,
    lineEnd = 0;
  let previousCode:
    | { end: number; ending: string; owners: readonly Owner[] }
    | undefined;
  let comment = false,
    raw: string | undefined,
    html = false;
  let explicit: ExplicitHtml | undefined;
  let definitionEnd = 0;
  const breaks = /\r\n|\r|\n/g;
  function snapshot(offset: number): Entry[] {
    return frames.map((frame) => ({
      ...frame,
      continued: frame.item < offset,
    }));
  }
  function openOwners(
    owners: readonly Owner[],
    previousOwners: readonly Owner[],
  ): void {
    let depth = 0;
    const quotes: number[] = [];
    for (const owner of owners) {
      if (owner.kind === "quote") {
        quotes.push(owner.id);
        continue;
      }
      const current = frames[depth];
      const sameScope =
        (current?.quotes?.length ?? 0) === quotes.length &&
        quotes.every((id, index) => current?.quotes?.[index] === id);
      const same =
        current &&
        sameScope &&
        owner.indent < current.content &&
        current.list.marker.replace(/\d+/g, "1") ===
          owner.marker.replace(/\d+/g, "1");
      if (!same) frames.length = depth;
      if (same) {
        if (!previousOwners.some((previous) => previous.id === owner.id)) {
          if (blank) current.list.loose = true;
          current.number++;
          current.item = start + owner.markerOffset;
        }
        current.indent = owner.indent;
        current.content = owner.content;
        current.marker = owner.marker;
        current.fenced = true;
        current.quotes = quotes.slice();
        current.owner = owner.id;
      } else {
        const number = /^\d/.test(owner.marker)
          ? Number(owner.marker.slice(0, -1))
          : 1;
        frames.push({
          list: {
            offset: start + owner.markerOffset,
            marker: owner.marker,
            loose: false,
          },
          number,
          item: start + owner.markerOffset,
          indent: owner.indent,
          content: owner.content,
          marker: owner.marker,
          fenced: true,
          quotes: quotes.slice(),
          owner: owner.id,
        });
      }
      depth++;
    }
    frames.length = depth;
  }
  const tooDeep = (owners: readonly Owner[]): boolean =>
    frames.length * 2 >= MAX_RENDER_DEPTH ||
    owners.reduce(
      (depth, owner) => depth + (owner.kind === "list" ? 2 : 1),
      0,
    ) >= MAX_RENDER_DEPTH ||
    !!fences.overflow;
  function capture(offset: number): void {
    while (
      part + 1 < parts.length &&
      required(parts[part + 1]).start <= offset
    ) {
      const cut = required(parts[++part]).start,
        entry = required(result[part]);
      // Each enclosing list contributes both a list and an item to the tree.
      // Do not retain oversized ancestor inventories for already-deep output.
      const owners = cut === start ? beforeOwners : fences.owners;
      if (tooDeep(owners)) {
        entry.deep = true;
        continue;
      }
      entry.first = snapshot(cut);
      required(result[part - 1]).last = snapshot(cut);
      let prefix = "";
      const quoted = owners.some((owner) => owner.kind === "quote");
      if (quoted) {
        prefix = owners
          .map(
            (owner) =>
              " ".repeat(owner.relativeIndent) +
              owner.marker +
              " ".repeat(owner.padding),
          )
          .join("");
        // At a physical boundary only previously open owners are synthetic;
        // new quote/list markers on that line remain in the original slice.
        // Midline cuts must instead reopen all owners already consumed there.
        if (cut === start) {
          prefix += `${indentedCode ? "" : "\uE000"}\n`;
          if (blank)
            prefix += `${owners
              .map((owner) =>
                owner.kind === "list"
                  ? " ".repeat(owner.width)
                  : " ".repeat(owner.relativeIndent) +
                    ">" +
                    " ".repeat(owner.padding),
              )
              .join("")}\n`;
        } else if (indentedCode) {
          prefix +=
            "\n" +
            owners
              .map((owner) =>
                owner.kind === "list"
                  ? " ".repeat(owner.width)
                  : " ".repeat(owner.relativeIndent) +
                    ">" +
                    " ".repeat(owner.padding),
              )
              .join("") +
            "    ";
        }
        if (prefix.length > MAX_RENDER_CHARS) entry.overflow = true;
      }
      for (const [depth, frame] of entry.first.entries())
        if (!quoted && frame.continued) {
          if (
            prefix.length + frame.indent + frame.marker.length + 1 >
            MAX_RENDER_CHARS
          ) {
            entry.overflow = true;
            break;
          }
          const lazy =
            !indentedCode &&
            depth === entry.first.length - 1 &&
            (cut > start || indentation < frame.content);
          prefix +=
            " ".repeat(frame.indent) + frame.marker + (lazy ? " " : "\n");
        }
      if (indentedCode && cut > start && cut < lineEnd) {
        required(result[part - 1]).codeEnd = { offset: cut, ending: "" };
        if (!quoted && !entry.overflow) {
          const padding = (entry.first.at(-1)?.content ?? 0) + 4;
          if (padding > MAX_RENDER_CHARS - prefix.length) entry.overflow = true;
          else prefix += " ".repeat(padding);
        }
      } else if (
        cut === start &&
        indentedCode &&
        previousCode?.ending === "\r\n" &&
        fences.owners.length === previousCode.owners.length &&
        fences.owners.every(
          (owner, index) =>
            owner.id === required(required(previousCode).owners[index]).id,
        )
      ) {
        required(result[part - 1]).codeEnd = {
          offset: previousCode.end,
          ending: previousCode.ending,
        };
      }
      if (table && cut >= table.end) entry.table = table;
      entry.prefix = prefix;
    }
    // Admission belongs to every source slice touched by this line, including
    // the initial part and depth first encountered between two cuts.
    if (tooDeep(fences.owners)) required(result[part]).deep = true;
  }

  for (;;) {
    const ending = breaks.exec(text),
      end = ending?.index ?? text.length,
      next = ending ? breaks.lastIndex : text.length;
    const source = text.slice(start, end);
    lineEnd = end;
    const content = source.replace(/^[\t ]+/, (space) => {
      let width = 0;
      for (const char of space) width += char === "\t" ? 4 - (width % 4) : 1;
      return " ".repeat(width);
    });
    const empty = !/\S/.test(content);
    indentation = required(required(content.match(/^ */))[0]).length;
    if (html && empty) html = false;
    const otherOpaque =
      comment ||
      raw !== undefined ||
      html ||
      explicit !== undefined ||
      start < definitionEnd;
    let opaque = otherOpaque;
    const wasOpaque = opaque || fences.fence !== undefined;
    const previousOwners = fences.owners;
    let step = fenceLine(source, fences, opaque);
    if (!opaque && !step.code && !table)
      definitionEnd = Math.max(definitionEnd, definitionAt(start)?.end ?? 0);
    const definition = start < definitionEnd;
    opaque ||= definition;
    if (!opaque && !step.code && /^ {0,3}<!--/.test(content)) {
      comment = true;
      opaque = true;
    }
    if (!opaque && !step.code) {
      explicit = explicitHtmlStart(content);
      opaque ||= explicit !== undefined;
    }
    if (!opaque && !step.code) {
      const tag = content.match(
        /^ {0,3}<(script|style|pre|textarea)(?:[\t >]|$)/i,
      );
      if (tag) {
        raw = tag[1];
        opaque = true;
      }
    }
    if (
      !opaque &&
      !step.code &&
      (startsBlankHtmlBlock(content) || (blank && isStandaloneHtmlTag(content)))
    ) {
      html = true;
      opaque = true;
    }
    if (opaque) step = fenceLine(source, fences, true);
    beforeOwners = step.beforeOwners;
    fences = step.after;
    indentedCode =
      !opaque &&
      !step.code &&
      !fences.paragraph &&
      /\S/.test(step.body) &&
      !tableIndent(source, step.body);
    if (step.endedBefore || frames.some((frame) => frame.fenced))
      frames.length = Math.min(
        frames.length,
        fences.owners.filter((owner) => owner.kind === "list").length,
      );
    // Quoted lists use the same owner transitions as fence openers: a new
    // sibling advances its list only within the same quote scope. Fence
    // payload/closers never enter ordinary list/table recognition.
    const owned =
      step.opened ||
      (!opaque &&
        !step.code &&
        (fences.owners.some((owner) => owner.kind === "quote") ||
          frames.some((frame) => frame.quotes?.length)));
    if (owned) {
      openOwners(fences.owners, previousOwners);
      if (blank && /\S/.test(step.body))
        for (const frame of frames)
          if (frame.item < start) frame.list.loose = true;
    }
    opaque ||= step.code;
    if (comment && content.includes("-->")) comment = false;
    if (explicit && content.includes(explicitHtmlEnd(explicit)))
      explicit = undefined;
    if (raw && new RegExp(`</${raw}[\\t ]*>`, "i").test(content))
      raw = undefined;
    if (
      !wasOpaque &&
      opaque &&
      !step.opened &&
      !definition &&
      frames.length &&
      indentation < required(frames[0]).content
    )
      frames = [];
    if (!opaque && !owned) {
      const rule = thematic.test(content),
        item = rule ? null : marker.exec(content);
      if (rule) frames = [];
      if (item) {
        const listed = frames.length > 0;
        while (
          frames.length > 1 &&
          indentation < required(frames[frames.length - 2]).content
        )
          frames.pop();
        let current = frames.at(-1);
        let column = indentation + required(item[2]).length;
        for (const char of item[3] ?? " ")
          column += char === "\t" ? 4 - (column % 4) : 1;
        const padding = column - indentation - required(item[2]).length;
        const contentIndent =
          indentation + required(item[2]).length + (padding <= 4 ? padding : 1);
        if (current && indentation < current.content) {
          const same =
            required(item[2]).replace(/\d+/g, "1") ===
            current.list.marker.replace(/\d+/g, "1");
          if (same) {
            if (blank) current.list.loose = true;
            current.number++;
            current.item = start;
            current.indent = indentation;
            current.content = contentIndent;
            current.marker = required(item[2]);
          } else {
            frames.pop();
            current = frames.at(-1);
          }
        }
        if (!current || indentation >= current.content) {
          const number = /^\d/.test(required(item[2]))
            ? Number(required(item[2]).slice(0, -1))
            : 1;
          // Ordered lists only interrupt a paragraph when their marker is 1.
          if (
            (frames.length || indentation <= 3) &&
            (listed || blank || number === 1 || start === 0)
          )
            frames.push({
              list: { offset: start, marker: required(item[2]), loose: false },
              number,
              item: start,
              indent: indentation,
              content: contentIndent,
              marker: required(item[2]),
            });
        }
      } else if (
        !empty &&
        frames.length &&
        indentation < required(frames[0]).content &&
        (blank || interrupt.test(content))
      )
        frames = [];
      else if (!empty && blank)
        for (const frame of frames) frame.list.loose = true;
      if (empty || rule || interrupt.test(content) || item) table = undefined;
      else if (!table && previous) {
        const cells = columns(content),
          header = columns(previous.content);
        if (
          cells?.length &&
          header?.length === cells.length &&
          cells.every((cell) => /^:?-+:?$/.test(cell))
        )
          table = {
            start,
            end: next,
            columns: cells.length,
            indent: indentation,
          };
      }
    } else table = undefined;
    capture(start);
    // A forced cut inside a source line inherits the current item/table.
    if (next > start) capture(next - 1);
    previous = !opaque && !empty ? { start, end: next, content } : undefined;
    blank = empty || (owned && !/\S/.test(step.body));
    previousCode = indentedCode
      ? { end, ending: ending?.[0] ?? "", owners: fences.owners }
      : undefined;
    if (!ending) break;
    start = next;
  }
  return result;
}

/** Restore list starts/spread on the actual parser's nodes, before sanitation. */
export function prepareBlocks(
  root: Syntax,
  block: BlockPart | undefined,
  prefix: number,
): void {
  if (!block) return;
  const entries = [...block.first, ...block.last];
  const firstList = (parent: Syntax | undefined): Syntax | undefined => {
    const pending = [...(parent?.children ?? [])].reverse();
    while (pending.length) {
      const node = required(pending.pop());
      if (node.type === "list") return node;
      if (node.type === "blockquote")
        for (let index = (node.children?.length ?? 0) - 1; index >= 0; index--)
          pending.push(required(required(node.children)[index]));
    }
    return undefined;
  };
  let first = firstList(root);
  const initial = new Map<Syntax, Entry>();
  for (const frame of block.first) {
    if (!first) break;
    initial.set(first, frame);
    first = firstList(first.children?.[0]);
  }
  const markerOffset = block.prefix.indexOf("\uE000");
  const markerPosition = prefix - block.prefix.length + markerOffset;
  const stack = [root];
  while (stack.length) {
    const node = required(stack.pop());
    if (markerOffset >= 0 && node.children)
      node.children = node.children.filter((child) => {
        const marker =
          child.type === "paragraph" ? child.children?.[0] : undefined;
        if (
          marker?.type !== "text" ||
          marker.position?.start.offset !== markerPosition ||
          !marker.value?.startsWith("\uE000")
        )
          return true;
        marker.value = marker.value.slice(1).replace(/^\n/, "");
        return required(child.children).some(
          (part) => part.type !== "text" || part.value,
        );
      });
    if (node.type === "list") {
      const offset = node.position?.start.offset;
      const frame =
        initial.get(node) ??
        entries.find(
          (entry) =>
            offset !== undefined &&
            entry.list.offset === block.start + offset - prefix,
        );
      if (frame) {
        if (initial.has(node) && /^\d/.test(frame.list.marker))
          node.start = frame.number;
        node.spread = frame.list.loose;
        for (const item of node.children ?? []) item.spread = frame.list.loose;
        if (initial.has(node) && frame.continued && node.children?.[0]) {
          const item = required(node.children[0]);
          item.data ??= {};
          item.data.hProperties ??= {};
          item.data.hProperties.className = ["mdv-continued"];
        }
      }
    }
    if (node.children) stack.push(...node.children);
  }
}

export function finishBlocks(
  tree: Root,
  block: BlockPart | undefined,
  prefix: number,
): void {
  if (!block || (!block.table && block.codeEnd === undefined)) return;
  const codeEnd =
    block.codeEnd === undefined
      ? undefined
      : prefix + block.codeEnd.offset - block.start;
  let table = !!block.table;
  const stack: (Root | Element)[] = [tree];
  while (stack.length) {
    const node = required(stack.pop());
    if (node.type === "element" && node.tagName === "table" && table) {
      node.children = node.children.filter(
        (child) => child.type !== "element" || child.tagName !== "thead",
      );
      table = false;
    }
    // The converter appends an EOF LF to indented code. Interior cuts need
    // their original ending (or none inside a line), keeping the payload exact.
    if (
      node.type === "element" &&
      node.tagName === "pre" &&
      codeEnd !== undefined &&
      node.position?.end.offset === codeEnd
    ) {
      const code = node.children.find(
        (child) => child.type === "element" && child.tagName === "code",
      ) as Element | undefined;
      const tail = code?.children.at(-1);
      if (tail?.type === "text" && tail.value.endsWith("\n"))
        tail.value = tail.value.slice(0, -1) + required(block.codeEnd).ending;
    }
    for (let at = node.children.length - 1; at >= 0; at--)
      if (required(node.children[at]).type === "element")
        stack.push(required(node.children[at]) as Element);
  }
}
