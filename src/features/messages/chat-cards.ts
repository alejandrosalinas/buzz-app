import type { ChannelMessage } from "../relay/contracts";
import { MAX_MARKDOWN_LENGTH, scanMarkdown } from "../relay/message-content";
import { parseBuzzLink } from "../navigation/buzz-links";
import { messageLinkParts } from "./message-link-parts";
import type { ReferenceChannel } from "./ReferenceText";

/** One durable representation for cards admitted by staging or draft restoration. */
export function canonicalChatCard(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 16000) return;
  const scan = scanMarkdown(value);
  const paragraph = scan.tree.children?.[0];
  const link = paragraph?.children?.[0];
  if (
    scan.tooDeep ||
    scan.tree.children?.length !== 1 ||
    paragraph?.type !== "paragraph" ||
    paragraph.children?.length !== 1 ||
    link?.type !== "link" ||
    !link.url
  )
    return;
  const target = parseBuzzLink(link.url);
  if (target?.format !== "legacy" || target.messageId || target.threadRootId)
    return;
  const text = (node: typeof scan.tree): string =>
    node.value ?? node.children?.map(text).join("") ?? "";
  const label = text(link);
  if (!/^(?:Session|Chat)(?::| ·)\s+/.test(label) || /[\r\n]/.test(label))
    return;
  const escaped = label.replace(/[\\`[\]*_~<>&|]/g, "\\$&");
  return `[${escaped}](buzz://channel/${encodeURIComponent(target.channelId)})`;
}

/** Project presentation only. Actions, copy and replies keep the original row. */
export function separateChatCards(
  row: ChannelMessage,
  channels: readonly ReferenceChannel[],
) {
  const cards: { content: string; start: number }[] = [];
  if (
    row.diff ||
    row.agentEnvelope ||
    row.content.length > MAX_MARKDOWN_LENGTH ||
    !/buzz:/i.test(row.content) ||
    row.content.includes("||")
  )
    return {
      caption: row,
      cards,
      ranges: [] as { start: number; end: number }[],
    };
  const scan = scanMarkdown(row.content);
  if (scan.tooDeep)
    return {
      caption: row,
      cards,
      ranges: [] as { start: number; end: number }[],
    };
  type Node = typeof scan.tree;
  const ranges: { start: number; end: number }[] = [];
  const add = (
    url: string,
    label: string | undefined,
    start: number,
    end: number,
  ) => {
    const target = parseBuzzLink(url);
    if (target?.format !== "legacy" || target.messageId || target.threadRootId)
      return false;
    const channel = channels.find((channel) => channel.id === target.channelId);
    if (
      channel
        ? channel.channelType !== "solo"
        : !/^(?:Session|Chat)(?::| ·)\s+/.test(label ?? "")
    )
      return false;
    cards.push({ content: row.content.slice(start, end), start });
    ranges.push({ start, end });
    return true;
  };
  const text = (node: Node): string =>
    node.value ?? node.children?.map(text).join("") ?? "";
  const visit = (node: Node): boolean => {
    if (
      [
        "code",
        "inlineCode",
        "html",
        "image",
        "imageReference",
        "definition",
        "linkReference",
        "blockquote",
        "list",
        "table",
      ].includes(node.type)
    )
      return false;
    const start = node.position?.start.offset,
      end = node.position?.end.offset;
    if (node.type === "link")
      return (
        start !== undefined &&
        end !== undefined &&
        !!node.url &&
        add(node.url, text(node), start, end)
      );
    if (node.type === "text") {
      if (start !== undefined)
        messageLinkParts(
          row.content.slice(start, end),
          undefined,
          (from, to, url) => {
            add(url, undefined, start + from, start + to);
          },
        );
      return !node.value?.trim();
    }
    const before = cards.length;
    const removed = node.children?.map(visit);
    if (
      cards.length > before &&
      removed?.every(Boolean) &&
      start !== undefined &&
      end !== undefined &&
      node.type !== "root"
    ) {
      ranges.push({ start, end });
      return true;
    }
    return false;
  };
  visit(scan.tree);
  if (!cards.length)
    return {
      caption: row,
      cards,
      ranges: [] as { start: number; end: number }[],
    };
  const merged: typeof ranges = [];
  for (const range of ranges.sort(
    (a, b) => a.start - b.start || b.end - a.end,
  )) {
    const prior = merged.at(-1);
    if (prior && range.start <= prior.end)
      prior.end = Math.max(prior.end, range.end);
    else merged.push({ ...range });
  }
  let content = "",
    offset = 0;
  const seams: number[] = [];
  for (const range of merged) {
    content += row.content.slice(offset, range.start);
    seams.push(content.length);
    content += " ";
    offset = range.end;
  }
  content += row.content.slice(offset);
  for (const seam of row.attachmentSeams ?? []) {
    if (merged.some((range) => seam > range.start && seam < range.end))
      continue;
    seams.push(
      seam -
        merged
          .filter((range) => range.end <= seam)
          .reduce((sum, range) => sum + range.end - range.start - 1, 0),
    );
  }
  return {
    caption: { ...row, content, attachmentSeams: seams },
    cards,
    ranges: merged,
  };
}

/** Find Solo destinations in sent Markdown without treating link labels as URLs. */
export function chatLinkIds(
  content: string,
  channels: readonly ReferenceChannel[],
): string[] {
  if (
    content.length > MAX_MARKDOWN_LENGTH ||
    !/buzz:/i.test(content) ||
    content.includes("||")
  )
    return [];
  const scan = scanMarkdown(content);
  if (scan.tooDeep) return [];
  const ids = new Set<string>();
  const add = (url: string | undefined) => {
    const target = url && parseBuzzLink(url);
    if (
      target &&
      target.format === "legacy" &&
      !target.messageId &&
      !target.threadRootId &&
      channels.some(
        ({ id, channelType }) =>
          id === target.channelId && channelType === "solo",
      )
    )
      ids.add(target.channelId);
  };
  const visit = (node: typeof scan.tree) => {
    switch (node.type) {
      case "link":
        add(node.url);
        break;
      case "linkReference":
        add(scan.definitions.get(node.identifier?.toLowerCase() ?? ""));
        break;
      case "text": {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start !== undefined && end !== undefined)
          for (const { url } of messageLinkParts(content.slice(start, end)))
            add(url);
        break;
      }
      case "blockquote":
      case "code":
      case "inlineCode":
      case "html":
      case "image":
      case "imageReference":
      case "definition":
        break;
      default:
        node.children?.forEach(visit);
    }
  };
  visit(scan.tree);
  return [...ids];
}
