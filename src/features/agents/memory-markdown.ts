import { isLiteralMarkdownContext } from "../messages/markdown-preparation";
import { messageLinkParts } from "../messages/message-link-parts";
import { parseBuzzLink } from "../navigation/buzz-links";

type Node = {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
};

/** Link bare Buzz destinations in prose, leaving code and authored links alone. */
export function remarkMemoryLinks() {
  return function visit(parent: Node) {
    if (isLiteralMarkdownContext(parent.type) || !parent.children) return;
    parent.children = parent.children.flatMap((child) => {
      if (child.type !== "text" || !child.value) {
        visit(child);
        return [child];
      }
      const value = child.value;
      const nodes: Node[] = [];
      let offset = 0;
      messageLinkParts(value, undefined, (start, end, url) => {
        if (!parseBuzzLink(url) || value.slice(start, end) !== url) return;
        if (start > offset)
          nodes.push({ type: "text", value: value.slice(offset, start) });
        nodes.push({
          type: "link",
          url,
          children: [{ type: "text", value: url }],
        });
        offset = end;
      });
      if (!nodes.length) return [child];
      if (offset < value.length)
        nodes.push({ type: "text", value: value.slice(offset) });
      return nodes;
    });
  };
}
