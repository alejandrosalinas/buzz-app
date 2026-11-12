import { scanMarkdown } from "../relay/message-content";
import { prepareMarkdown } from "./markdown-preparation";
import { messageLinkParts } from "./message-link-parts";

type Node = {
  type: string;
  url?: string;
  identifier?: string;
  value?: string;
  children?: Node[] | undefined;
  position?: { start: { offset?: number }; end: { offset?: number } };
};

const skipped = new Set([
  "code",
  "inlineCode",
  "html",
  "definition",
  "image",
  "imageReference",
]);

const https = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
};

/** The HTTPS links a message's prose names, in order, once each: bare,
 * labeled and reference links, but not `<url>`, which asks for no preview,
 * nor links in code or spoilers, nor ones naming one of `exclude`. */
export function previewLinks(
  content: string,
  exclude: readonly string[] = [],
): readonly string[] {
  const prepared = prepareMarkdown(content);
  if (prepared.kind === "plain" || !/https:\/\//i.test(content)) return [];
  const scan = scanMarkdown(prepared.content);
  if (scan.tooDeep) return [];
  const source = prepared.content;
  const delimiters = prepared.spoilerDelimiters;
  const excluded = new Set(exclude.map((url) => https(url) ?? url));
  const found: string[] = [];
  const add = (raw: string | undefined) => {
    const url = raw && https(raw);
    if (url && !excluded.has(url) && !found.includes(url)) found.push(url);
  };
  const span = (node: Node) => [
    node.position?.start.offset,
    node.position?.end.offset,
  ];
  // Spoilers pair `||` among one parent's text children, as remarkSpoilers does.
  const hiddenRanges = (children: readonly Node[]) => {
    const own = children.flatMap((child) => {
      const [start, end] = span(child);
      return child.type === "text" && start !== undefined && end !== undefined
        ? delimiters.filter((at) => at >= start && at + 2 <= end)
        : [];
    });
    const ranges: [number, number][] = [];
    for (let i = 0; i + 1 < own.length; i += 2)
      ranges.push([own[i] ?? 0, (own[i + 1] ?? 0) + 2]);
    return ranges;
  };
  const visit = (node: Node, hidden: readonly [number, number][]) => {
    if (skipped.has(node.type)) return;
    const [start, end] = span(node);
    const inside = (at: number) =>
      hidden.some(([from, to]) => at >= from && at < to);
    if (node.type === "link" || node.type === "linkReference") {
      if (start === undefined || source[start] === "<" || inside(start)) return;
      add(
        node.type === "link"
          ? node.url
          : scan.definitions.get(node.identifier?.toLowerCase() ?? ""),
      );
      return;
    }
    if (node.type === "text") {
      if (start === undefined || end === undefined || !node.value) return;
      const text = hidden.length ? source.slice(start, end) : node.value;
      messageLinkParts(text, undefined, (from, to, url) => {
        if (text[from] !== "<" && to > from && !inside(start + from)) add(url);
      });
      return;
    }
    const children = node.children ?? [];
    const own = hiddenRanges(children);
    for (const child of children) visit(child, own);
  };
  visit(scan.tree as Node, []);
  return found;
}
