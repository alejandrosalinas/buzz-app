import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { MAX_MARKDOWN_LENGTH, scanMarkdown } from "../relay/message-content";
import { normalizeWrappedLinks } from "./message-link-parts";

export type LiteralRange = Readonly<{ start: number; end: number }>;
type MarkdownNode = {
  type: string;
  children?: MarkdownNode[] | undefined;
  position?:
    | {
        start: { offset?: number | undefined };
        end: { offset?: number | undefined };
      }
    | undefined;
};
export type PreparedMarkdown =
  | Readonly<{ kind: "plain"; content: string }>
  | Readonly<{
      kind: "markdown";
      content: string;
      literalRanges: readonly LiteralRange[];
      spoilerDelimiters: readonly number[];
    }>;

export const isLiteralMarkdownContext = (type: string) =>
  [
    "code",
    "inlineCode",
    "link",
    "linkReference",
    "image",
    "imageReference",
    "definition",
    "html",
  ].includes(type);

function literalRanges(
  tree: MarkdownNode,
  includeLinks: boolean,
): readonly LiteralRange[] {
  const ranges: LiteralRange[] = [];
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    if (
      isLiteralMarkdownContext(node.type) &&
      (includeLinks || node.type !== "link")
    ) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined)
        ranges.push(Object.freeze({ start, end }));
      continue;
    }
    for (let index = (node.children?.length ?? 0) - 1; index >= 0; index--) {
      const child = node.children?.[index];
      if (child) pending.push(child);
    }
  }
  return Object.freeze(ranges);
}

function spoilerDelimiters(content: string): readonly number[] {
  if (!content.includes("||")) return Object.freeze([]);
  // Table separators are grammar, not prose. Reuse the same GFM table parser
  // as the renderer without enabling autolinks, which can consume closing pipes.
  const tree = fromMarkdown(content, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });
  const positions: number[] = [];
  const visit = (node: MarkdownNode) => {
    if (isLiteralMarkdownContext(node.type) || node.type === "table") return;
    const start = node.position?.start.offset,
      end = node.position?.end.offset;
    if (node.type === "text" && start !== undefined && end !== undefined) {
      for (const match of content.slice(start, end).matchAll(/\\[\s\S]|\|\|/g))
        if (match[0] === "||") positions.push(start + match.index);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return Object.freeze(positions);
}

/** Prose that no Markdown, GFM or message syntax acts on: no syntax characters,
 * `:` (shortcodes, URL schemes), `@`, `www.`, private-use placeholders, tabs or
 * other controls, line-start list or indent markers, or a space before a line
 * ending. Its tree is paragraphs of text, which `plainProseTree` builds. */
export const isPlainProse = (content: string) =>
  !/(?![\n\r])\p{Cc}|[*_`~[\]<>|#\\&!=:@\p{Co}\p{Zl}\p{Zp}\ufeff\ufffc]|www\.| [\n\r]|^ *(?:[-+]|\d+[.)])|^ {4}/imu.test(
    content,
  );

/** The tree micromark builds for `isPlainProse` content. */
export const plainProseTree = (content: string) => ({
  type: "root",
  children: content
    .split(/(?:\r\n|\r(?!\n)|\n){2,}/)
    .map((block) =>
      block
        .replace(/^ +/gm, "")
        // The lookbehind starts the tail match only at a run's start, so a long
        // mid-line space run is scanned once, not once per space.
        .replace(/^(?:\r\n?|\n)+|(?<![\r\n ])[\r\n ]+$/g, ""),
    )
    .filter(Boolean)
    .map((value) => ({
      type: "paragraph",
      children: [{ type: "text", value }],
    })),
});

/** Pure, immutable Markdown work; MessageMarkdown keeps recent results. */
export function prepareMarkdown(content: string): PreparedMarkdown {
  if (content.length > MAX_MARKDOWN_LENGTH)
    return Object.freeze({ kind: "plain", content });
  // Nothing in plain prose is literal, a wrapped link or a spoiler.
  if (isPlainProse(content))
    return Object.freeze({
      kind: "markdown",
      content,
      literalRanges: Object.freeze([]),
      spoilerDelimiters: Object.freeze([]),
    });

  let scan = scanMarkdown(content);
  if (scan.tooDeep) return Object.freeze({ kind: "plain", content });

  const normalizationLiterals = literalRanges(scan.tree, false);
  const normalized = normalizeWrappedLinks(content, (start, end) =>
    normalizationLiterals.some(
      (range) => start < range.end && end > range.start,
    ),
  );
  if (normalized !== content) {
    scan = scanMarkdown(normalized);
    if (scan.tooDeep) return Object.freeze({ kind: "plain", content });
  }

  return Object.freeze({
    kind: "markdown",
    content: normalized,
    literalRanges: literalRanges(scan.tree, true),
    spoilerDelimiters: spoilerDelimiters(normalized),
  });
}
