import { spoilerMarkdown } from "./remark-spoilers";
import {
  toMarkdown,
  defaultHandlers,
  type Handle,
} from "mdast-util-to-markdown";
import { fromMarkdown } from "mdast-util-from-markdown";
import {
  gfmStrikethroughFromMarkdown,
  gfmStrikethroughToMarkdown,
} from "mdast-util-gfm-strikethrough";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import type { Emphasis, PhrasingContent, Root, Text } from "mdast";
import type { MentionDraft } from "./mention-draft";
import {
  Fragment,
  type Node as EditorNode,
  type NodeType,
} from "prosemirror-model";
import {
  composerSchema,
  readComposerDocument,
  type SourceRange,
} from "./composer-document";

const strikethrough = gfmStrikethroughToMarkdown();
const deleteHandler = strikethrough.handlers?.delete;
// GFM's serializer omits the attention flanking hint supplied by CommonMark's
// strong/emphasis handlers. Punctuation-only strike needs the same surrounding
// letter encoding (x~~!~~y otherwise renders as literal tildes).
const strike: Handle & { peek?: Handle } = (node, parent, state, info) => {
  if (!deleteHandler)
    throw new Error("GFM strikethrough serializer is required");
  const value = deleteHandler(node, parent, state, info);
  const needsEncoding = (outside: string, inside: string) =>
    !!outside &&
    !/[\s\p{P}\p{S}]/u.test(outside) &&
    /[\p{P}\p{S}]/u.test(inside);
  state.attentionEncodeSurroundingInfo = {
    before: needsEncoding(info.before.slice(-1), value.slice(2, 3)),
    after: needsEncoding(info.after.slice(0, 1), value.slice(-3, -2)),
  };
  return value;
};
strike.peek = () => "~";

/** Plain portions are authored Markdown, not rich-editor literal text. Keeping
 * their source verbatim avoids normalizing formats this slice does not edit.
 * Marked content uses CommonMark/GFM delimiter escaping and flanking rules.
 * A chip is its label as literal text in place. */
export function composerMarkdown(draft: MentionDraft): string {
  const project = (node: EditorNode): EditorNode =>
    node.type.name === "token" && node.attrs.semantic
      ? node.mark(composerSchema.marks.literal.create().addToSet(node.marks))
      : node.isLeaf
        ? node
        : node.copy(Fragment.fromArray(node.content.content.map(project)));
  const doc = project(readComposerDocument(draft, []));
  return [
    ...(draft.chatCards ?? []),
    blocksMarkdown(doc),
    ...(draft.gifs ?? []),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function blocksMarkdown(doc: EditorNode): string {
  const blocks: string[] = [];
  let previous: EditorNode | undefined;
  const authored = authoredLiteralRanges(doc);
  // Two lists of one kind separated only by blank lines read as one list, so
  // adjacent lists alternate their marker as mdast-util-to-markdown does: `-`
  // then `*` for bullets, `.` then `)` for numbers. A block that serialises to
  // nothing but whitespace, such as an empty paragraph, adds only blank lines
  // to the wire, so both the last list kind and the parity carry across it
  // unchanged; any other block between two lists starts the sequence again.
  let lastList: NodeType | undefined;
  let alternate = false;
  doc.forEach((block, offset) => {
    // Blank separation prevents lazy quote continuation and adjacent blocks
    // merging on send; ordinary authored paragraph newlines remain unchanged.
    if (previous)
      blocks.push(
        previous.type.name === "paragraph" && block.type.name === "paragraph"
          ? "\n"
          : "\n\n",
      );
    const list =
      block.type.name === "bullet_list" || block.type.name === "ordered_list";
    if (list) alternate = lastList === block.type && !alternate;
    let output: string;
    if (block.type.name === "code_block") {
      const language: unknown = block.attrs.language;
      output = toMarkdown(
        {
          type: "root",
          children: [
            {
              type: "code",
              lang:
                typeof language === "string" && language ? language : undefined,
              value: block.textContent,
            },
          ],
        },
        { fences: true },
      ).slice(0, -1);
    } else if (block.type.name === "blockquote") {
      output = blocksMarkdown(block)
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
    } else if (list) {
      const items: string[] = [];
      block.forEach((item, _offset, index) => {
        // CommonMark reads at most nine digits in a marker, and only the first
        // number carries meaning, so continuation numbers stop there.
        const prefix =
          block.type.name === "ordered_list"
            ? `${Math.min(block.attrs.order + index, 999999999)}${alternate ? ")" : "."} `
            : alternate
              ? "* "
              : "- ";
        const lines = blocksMarkdown(item).split("\n");
        items.push(
          prefix +
            lines
              .map((line, index) =>
                index ? " ".repeat(prefix.length) + line : line,
              )
              .join("\n"),
        );
      });
      output = items.join("\n");
    } else output = paragraphMarkdown(block, authored.get(offset));
    blocks.push(output);
    if (list) lastList = block.type;
    else if (/\S/.test(output)) {
      lastList = undefined;
      alternate = false;
    }
    previous = block;
  });
  return blocks.join("");
}

/** Parse each contiguous paragraph run once, lazily. Rich text is masked so
 * only authored source defines code, links and HTML; offsets stay unchanged. */
function authoredLiteralRanges(doc: EditorNode) {
  const ranges = new Map<number, () => SourceRange[]>();
  let run: { source: string; ranges?: SourceRange[] } | undefined;
  doc.forEach((block, offset) => {
    if (block.type.name !== "paragraph") {
      run = undefined;
      return;
    }
    run ??= { source: "" };
    const context = run;
    const start = context.source.length;
    block.forEach((node) => {
      const value: string = node.isText
        ? node.textContent
        : node.type.name === "hard_break"
          ? "\n"
          : node.attrs.source;
      context.source +=
        node.marks.length || node.attrs.recipient
          ? value.replace(/\S/g, "a")
          : value;
    });
    const end = context.source.length;
    context.source += "\n";
    ranges.set(offset, () => {
      if (!context.ranges) {
        context.ranges = [];
        const visit = (
          node: Root | Root["children"][number] | PhrasingContent,
        ) => {
          if (
            node.type === "inlineCode" ||
            node.type === "code" ||
            node.type === "link" ||
            node.type === "linkReference" ||
            node.type === "image" ||
            node.type === "imageReference" ||
            node.type === "definition" ||
            node.type === "html"
          ) {
            const from = node.position?.start.offset;
            const to = node.position?.end.offset;
            if (from !== undefined && to !== undefined)
              context.ranges?.push({ start: from, end: to });
          } else if ("children" in node) node.children.forEach(visit);
        };
        visit(fromMarkdown(context.source));
      }
      return context.ranges
        .filter((range) => range.start < end && range.end > start)
        .map((range) => ({
          start: range.start - start,
          end: range.end - start,
        }));
    });
  });
  return ranges;
}

function paragraphMarkdown(
  block: EditorNode,
  authoredLiterals?: () => SourceRange[],
): string {
  let text = "";
  const formats = [
    { mark: composerSchema.marks.spoiler, type: "spoiler" },
    { mark: composerSchema.marks.link, type: "link" },
    { mark: composerSchema.marks.bold, type: "strong" },
    { mark: composerSchema.marks.italic, type: "emphasis" },
    { mark: composerSchema.marks.strike, type: "delete" },
    { mark: composerSchema.marks.code, type: "inlineCode" },
  ] as const;
  const ranges: (SourceRange & { href?: string })[][] = formats.map(() => []);
  const literals: SourceRange[] = [];
  const recipients: SourceRange[] = [];
  block.forEach((node) => {
    const start = text.length;
    text += node.isText
      ? node.textContent
      : node.type.name === "hard_break"
        ? "\n"
        : node.attrs.source;
    if (composerSchema.marks.literal.isInSet(node.marks))
      literals.push({ start, end: text.length });
    if (
      node.attrs.recipient ||
      composerSchema.marks.recipient.isInSet(node.marks)
    )
      recipients.push({ start, end: text.length });
    formats.forEach(({ mark }, index) => {
      const active = mark.isInSet(node.marks);
      if (!active) return;
      const href =
        mark === composerSchema.marks.link
          ? (active.attrs.href as string)
          : undefined;
      const spans = ranges[index];
      if (!spans) throw new RangeError("Missing composer format ranges");
      const previous = spans.at(-1);
      if (previous?.end === start && previous.href === href)
        previous.end = text.length;
      else spans.push({ start, end: text.length, ...(href ? { href } : {}) });
    });
  });
  // A spoiler is inline syntax. Close/reopen it across authored blank lines so
  // every resulting Markdown paragraph stays hidden after publication.
  ranges[0] = (ranges[0] ?? []).flatMap((range) => {
    const parts: SourceRange[] = [];
    let start = range.start;
    for (const match of text
      .slice(range.start, range.end)
      .matchAll(/\n[ \t]*\n/g)) {
      const end = range.start + match.index;
      if (end > start) parts.push({ start, end });
      start = end + match[0].length;
    }
    if (start < range.end) parts.push({ start, end: range.end });
    return parts;
  });
  if (!literals.length && ranges.every((spans) => !spans.length)) return text;
  const raw = new WeakMap<Text, SourceRange>();
  const literal = new WeakSet<Text>();
  const attention = new WeakMap<Text, SourceRange[]>();
  const authoredAttention = (node: Text) => {
    let spans = attention.get(node);
    if (spans) return spans;
    spans = [];
    const visit = (
      child: Root | Root["children"][number] | PhrasingContent,
    ) => {
      if (child.type === "emphasis" || child.type === "strong") {
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        if (start !== undefined && end !== undefined)
          spans.push({ start, end });
      } else if ("children" in child) child.children.forEach(visit);
    };
    const range = raw.get(node);
    let source = node.value;
    if (range) {
      for (const recipient of recipients) {
        const start = Math.max(0, recipient.start - range.start);
        const end = Math.min(source.length, recipient.end - range.start);
        if (start < end)
          source =
            source.slice(0, start) +
            "a".repeat(end - start) +
            source.slice(end);
      }
    }
    visit(fromMarkdown(source));
    attention.set(node, spans);
    return spans;
  };
  // Emphasis is written with _ except in two cases that take *. The timeline
  // binds a signed mention only when the character before its @ and the one
  // after its name are not word characters, and _ is one, so a span holding a
  // recipient uses *: *@Honey* renders italic and stays a bound mention where
  // _@Honey_ would lose the binding. A touching span also uses * so its marker
  // cannot become part of the name. Chosen over refusing the typed *@Honey*
  // conversion so toolbar italics on a chip send a bindable form too. The
  // second case, a span touching a word character on the wire, is decided in
  // the handler below from the serialized neighbours.
  const asterisk = new WeakSet<Emphasis>();
  const source = (
    start: number,
    end: number,
    marked: boolean,
    linked: boolean,
  ): PhrasingContent[] => {
    const value = text.slice(start, end);
    if (!value) return [];
    const boundaries = [
      ...new Set(
        literals
          .flatMap((range) => [range.start, range.end])
          .filter((point) => point > start && point < end),
      ),
    ].sort((a, b) => a - b);
    if (!linked && marked && boundaries.length) {
      const points = [start, ...boundaries, end];
      return points
        .slice(0, -1)
        .flatMap((point, index) =>
          source(point, points[index + 1] ?? end, marked, linked),
        );
    }
    const node: Text = { type: "text", value };
    if (!marked && !linked) {
      const points = [
        ...new Set([
          start,
          end,
          ...literals
            .flatMap((range) => [range.start, range.end])
            .filter((point) => point > start && point < end),
        ]),
      ].sort((a, b) => a - b);
      return points.slice(0, -1).map((from, index) => {
        const part: Text = {
          type: "text",
          value: text.slice(from, points[index + 1]),
        };
        if (literals.some((range) => from >= range.start && from < range.end))
          literal.add(part);
        else raw.set(part, { start: from, end: points[index + 1] ?? end });
        return part;
      });
    }
    // Linked labels use normal escaping, including mdast's autolink context.
    // Entity encoding is only for unlinked prose that must not become a URL.
    if (linked) return [node];
    if (literals.some((range) => start < range.end && end > range.start)) {
      literal.add(node);
      return [node];
    }
    // Existing inline Markdown inside a selection retains its meaning.
    const leading = value.length - value.trimStart().length;
    const trailing = value.trimEnd().length;
    if (leading >= trailing) return [node];
    const parsed = fromMarkdown(value.slice(leading, trailing), {
      extensions: [gfmStrikethrough()],
      mdastExtensions: [gfmStrikethroughFromMarkdown()],
    });
    const paragraph =
      parsed.children.length === 1 && parsed.children[0]?.type === "paragraph"
        ? parsed.children[0]
        : undefined;
    return [
      ...(leading
        ? [{ type: "text" as const, value: value.slice(0, leading) }]
        : []),
      ...(paragraph?.children ?? [
        { type: "text" as const, value: value.slice(leading, trailing) },
      ]),
      ...(trailing < value.length
        ? [{ type: "text" as const, value: value.slice(trailing) }]
        : []),
    ];
  };
  // A fixed nesting order makes overlapping marks a valid tree, splitting only
  // the crossing mark. Whitespace stays outside each generated delimiter pair,
  // while the editor document retains it (and its marks) for continued typing.
  const content = (
    start: number,
    end: number,
    depth: number,
    marked: boolean,
    linked = false,
  ): PhrasingContent[] => {
    const format = formats[depth];
    if (!format) return source(start, end, marked, linked);
    const children: PhrasingContent[] = [];
    let offset = start;
    for (const range of ranges[depth] ?? []) {
      const from = Math.max(start, range.start),
        to = Math.min(end, range.end);
      if (from >= to) continue;
      const value = text.slice(from, to);
      if (format.type === "inlineCode") {
        children.push(...source(offset, from, marked, linked));
        // CommonMark folds newlines inside a code span to spaces. Separate spans
        // preserve authored line breaks without inventing a fenced block.
        value.split("\n").forEach((line, index) => {
          if (index) children.push({ type: "text", value: "\n" });
          if (line) children.push({ type: "inlineCode", value: line });
        });
        offset = to;
        continue;
      }
      const first =
        format.type === "link"
          ? from
          : from + value.length - value.trimStart().length;
      const last = format.type === "link" ? to : from + value.trimEnd().length;
      if (first >= last) continue;
      children.push(...content(offset, first, depth + 1, marked, linked));
      const nested = content(
        first,
        last,
        depth + 1,
        true,
        linked || format.type === "link",
      );
      if (format.type === "link") {
        if (range.href === undefined)
          throw new Error("Link mark has no destination");
        children.push({ type: "link", url: range.href, children: nested });
      } else {
        const span: PhrasingContent = { type: format.type, children: nested };
        if (
          span.type === "emphasis" &&
          recipients.some((range) => range.start <= last && range.end >= first)
        )
          asterisk.add(span);
        children.push(span);
      }
      offset = last;
    }
    children.push(...content(offset, end, depth + 1, marked, linked));
    return children;
  };
  const word = (character: string) =>
    !!character && !/[\s\p{P}\p{S}]/u.test(character);
  const punctuation = (character: string) => /[\p{P}\p{S}]/u.test(character);
  const rawText: Handle = (node, parent, state, info) => {
    if (node.type === "text" && raw.has(node)) {
      // Escape only raw asterisks that could pair with generated delimiters;
      // unrelated authored Markdown remains byte-for-byte source.
      let value: string = node.value;
      const starBefore = info.before.endsWith("*");
      // Emphasis.peek advertises _ even when the handler later chooses *.
      const delimiterAfter = /^[*_]/.test(info.after);
      if (starBefore || delimiterAfter) {
        const range = raw.get(node);
        // Raw prose includes authored Markdown and exact recipient names, not
        // just literal characters. Only text outside those spans may be escaped.
        const protectedRanges: SourceRange[] = recipients.flatMap(
          (recipient) =>
            range && recipient.start < range.end && recipient.end > range.start
              ? [
                  {
                    start: recipient.start - range.start,
                    end: recipient.end - range.start,
                  },
                ]
              : [],
        );
        protectedRanges.push(...authoredAttention(node));
        if (range)
          for (const span of authoredLiterals?.() ?? [])
            if (span.start < range.end && span.end > range.start)
              protectedRanges.push({
                start: span.start - range.start,
                end: span.end - range.start,
              });
        const unprotected = (index: number) =>
          !protectedRanges.some(
            ({ start, end }) => index >= start && index < end,
          );
        // The run touching a generated delimiter is escaped whole. So is any
        // earlier unmatched run that could open emphasis, because the parser
        // pairs it with the generated delimiter that follows: `a*b` before
        // *x* reads as emphasis("b"), and micromark lets a run preceded by a
        // star close, so `a*b**` before *x* reads as emphasis("b**") once
        // only its trailing run is escaped. A run that cannot open, such as
        // a list marker or `5 * 3`, stays as authored. Left-flanking follows
        // micromark: a word or delimiter after the run, or punctuation after
        // it with whitespace or punctuation before.
        const opens = (start: number, end: number) => {
          const after = value[end] ?? "";
          const before = start
            ? (value[start - 1] ?? "")
            : info.before.slice(-1);
          return (
            word(after) ||
            /[*_]/.test(after) ||
            (punctuation(after) && !word(before))
          );
        };
        const tail = delimiterAfter
          ? value.length - (/[\\*]+$/.exec(value)?.[0].length ?? 0)
          : Number.POSITIVE_INFINITY;
        value = value.replace(/\\[\\*]|\*+|\\$/g, (token, offset: number) => {
          // Authored escape pairs stay; a trailing backslash is doubled so it
          // cannot swallow the generated delimiter.
          if (token.startsWith("\\"))
            return token.length === 1 && offset >= tail && unprotected(offset)
              ? "\\\\"
              : token;
          if (
            offset < tail &&
            !(starBefore && offset === 0) &&
            !(delimiterAfter && opens(offset, offset + token.length))
          )
            return token;
          return [...token]
            .map((star, index) =>
              unprotected(offset + index) ? `\\${star}` : star,
            )
            .join("");
        });
      }
      if (info.before.endsWith("|"))
        value = value.replace(/^\|+/, (pipes) =>
          pipes.replaceAll("|", "&#124;"),
        );
      if (info.after.startsWith("|"))
        value = value.replace(/[|\\]+$/, (tail) =>
          tail.replace(/[|\\]/g, (char) => `&#${char.charCodeAt(0)};`),
        );
      if (info.before.endsWith("`"))
        value = value.replace(/^`+/, (ticks) => ticks.replaceAll("`", "\\`"));
      if (info.after.startsWith("`"))
        value = value.replace(/[`\\]+$/, (tail) =>
          tail.replace(/[\\`]/g, "\\$&"),
        );
      return value;
    }
    const value = defaultHandlers.text(node, parent, state, info);
    // Literal link labels must not become GFM/bare autolinks after unlinking.
    return node.type === "text" && literal.has(node)
      ? value.replace(/[:.@]/g, (char) => `&#${char.charCodeAt(0)};`)
      : value;
  };
  // The stock handler reads its marker from the serializer options, so swap
  // the option for the span being written rather than reimplementing its
  // flanking encoding. `info` carries the wire neighbours: the character the
  // serializer wrote last and the one the next node will start with, so a
  // delimiter another span emits between the emphasis and the prose counts as
  // punctuation, exactly as the stock handler classifies it. A span touching a
  // word character there takes *, since _ cannot open or close intraword and
  // the stock handler would encode both neighbours as character references
  // (fo&#x6F;_&#x62;a&#x72;_&#x62;az); * forms there as typed, so agents and
  // the CLI reading the raw event see foo*bar*baz.
  // A matched authored delimiter is not a literal star to escape. Use the
  // alternate marker only at that boundary, keeping ordinary intraword source
  // readable and leaving signed recipient spans on their bindable * form.
  const touchesAuthored = (
    node: Parameters<Handle>[0],
    parent: Parameters<Handle>[1],
  ) => {
    if (!parent || !("children" in parent)) return false;
    const index = parent.children.findIndex((child) => child === node);
    return [parent.children[index - 1], parent.children[index + 1]].some(
      (sibling, side) =>
        sibling?.type === "text" &&
        raw.has(sibling) &&
        (side === 0
          ? sibling.value.endsWith("*")
          : sibling.value.startsWith("*")) &&
        authoredAttention(sibling).some(({ start, end }) =>
          side === 0 ? end === sibling.value.length : start === 0,
        ),
    );
  };
  const emphasis: Handle & { peek?: Handle } = (node, parent, state, info) => {
    const previous = state.options.emphasis;
    state.options.emphasis =
      asterisk.has(node) ||
      (!touchesAuthored(node, parent) &&
        (word(info.before.slice(-1)) || word(info.after.slice(0, 1))))
        ? "*"
        : "_";
    try {
      return defaultHandlers.emphasis(node, parent, state, info);
    } finally {
      state.options.emphasis = previous;
    }
  };
  // The peek only tells the preceding node which character follows it, and
  // both markers are punctuation to every rule that reads it, so the wire
  // neighbours need not be known here.
  emphasis.peek = (node) => (asterisk.has(node) ? "*" : "_");
  const tree: Root = {
    type: "root",
    children: [
      { type: "paragraph", children: content(0, text.length, 0, false) },
    ],
  };
  // Root adds exactly one final line ending; authored trailing newlines stay.
  return toMarkdown(tree, {
    extensions: [strikethrough],
    unsafe: [{ character: "|", inConstruct: "spoiler" }],
    handlers: {
      text: rawText,
      delete: strike,
      emphasis,
      spoiler: spoilerMarkdown,
    },
    strong: "*",
    emphasis: "_",
  }).slice(0, -1);
}
