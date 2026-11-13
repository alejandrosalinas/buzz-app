import { fromMarkdown, type Options } from "mdast-util-from-markdown";
import type { Root } from "mdast";
import { scanMarkdown } from "../relay/message-content";
import type { MarkdownProfile } from "./profiles";

type Node = { type: string; children?: Node[] };

/** Parse as remark-parse does under the profile's syntax plugins, without its
 * transforms, so every node the renderer will build is seen before any HAST
 * or React conversion. */
export function parseForGuard(content: string, profile: MarkdownProfile): Root {
  const data: {
    micromarkExtensions?: NonNullable<Options["extensions"]>;
    fromMarkdownExtensions?: NonNullable<Options["mdastExtensions"]>;
  } = {};
  const processor = { data: () => data };
  for (const plugin of profile.syntax) {
    const [attach, ...options] = Array.isArray(plugin) ? plugin : [plugin];
    (attach as (this: typeof processor, ...options: unknown[]) => void).call(
      processor,
      ...options,
    );
  }
  return fromMarkdown(content, {
    extensions: data.micromarkExtensions,
    mdastExtensions: data.fromMarkdownExtensions,
  });
}

/** GFM pads every table row to its header's width, so a small sparse table
 * can still expand to many cells. Counts tables anywhere, including inside
 * footnote definitions. */
function tableCells(tree: Root) {
  const pending: Node[] = [tree];
  let cells = 0;
  for (let node = pending.pop(); node; node = pending.pop())
    if (node.type === "table")
      cells +=
        (node.children?.[0]?.children?.length ?? 0) *
        (node.children?.length ?? 0);
    else for (const child of node.children ?? []) pending.push(child);
  return cells;
}

/** Whether a document is within a screen's rendering budget: its size, then
 * its depth (before anything recursive), then limits that need the profile's
 * syntax. */
export function guardDocument(
  content: string,
  profile: MarkdownProfile,
  limits: Readonly<{ chars: number; cells?: number | undefined }>,
) {
  if (content.length > limits.chars || scanMarkdown(content).tooDeep)
    return false;
  return (
    limits.cells === undefined ||
    tableCells(parseForGuard(content, profile)) <= limits.cells
  );
}
