// @vitest-environment jsdom
// Message rendering is the reference every shared Markdown change is checked
// against: this records the rendered DOM of a fixed corpus as tag, attributes
// and text. The baseline was captured before the shared renderer existed.
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import type { Contribution } from "../../plugins/contributions";
import type {
  CodeBlockRenderer,
  ConversationExtensions,
} from "../conversation/contracts";
import { MessageMarkdown } from "./MessageMarkdown";

const CORPUS: Record<string, string> = {
  headings:
    "# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six",
  lists: "- a\n  - b\n    - c\n- d\n\n1. x\n2. y\n\n- [ ] open\n- [x] done",
  inline:
    "**bold** _em_ ~~gone~~ `code` [link](https://example.com) https://example.org",
  blocks: "> quote\n> more\n\n---\n\n| a | b |\n| - | :-: |\n| 1 | 2 |",
  code: "```\nplain\n```\n\n```ts\nconst x = 1\n```",
  plugin: "```Mermaid\nflowchart LR\n```",
  throwing: "```Broken\nboom\n```",
  html: "<mark>x</mark> <!-- hidden --> <script>alert(1)</script>",
  spoiler: "Before ||**secret**|| after",
  breaks: "first\nsecond",
  image: "![alt text](https://example.com/a.png)",
  mention: "hi @Mic",
};

const renderer = (
  id: string,
  language: string,
  component: CodeBlockRenderer["component"],
): Contribution<CodeBlockRenderer> => ({
  id,
  key: `test/${id}`,
  pluginId: "test",
  revision: "1",
  title: id,
  matches: (value) => value === language,
  component,
});
const renderers = [
  renderer("diagram", "Mermaid", ({ code }) => <figure>{code}</figure>),
  renderer("broken", "Broken", () => {
    throw new Error("broken renderer");
  }),
];
const codeBlocks = { snapshot: () => renderers, subscribe: () => () => {} };
const none: never[] = [];
const empty = { snapshot: () => none, subscribe: () => () => {} };
const extensions = {
  tools: empty,
  inline: empty,
  codeBlocks,
} as unknown as ConversationExtensions;
const mic = "b".repeat(64);

/** Tag, attributes and text, in document order. */
function serialize(node: Node, depth = 0): string[] {
  const pad = "  ".repeat(depth);
  if (node.nodeType === Node.TEXT_NODE)
    return node.textContent
      ? [`${pad}${JSON.stringify(node.textContent)}`]
      : [];
  if (!(node instanceof Element)) return [];
  const attributes = [...node.attributes]
    // React ids depend on hook order, not on what is rendered.
    .map(({ name, value }) =>
      name === "id" && value.startsWith("base-ui-")
        ? "id=<react id>"
        : `${name}=${JSON.stringify(value)}`,
    )
    .sort();
  return [
    `${pad}<${node.tagName.toLowerCase()}${attributes.map((a) => ` ${a}`).join("")}>`,
    ...[...node.childNodes].flatMap((child) => serialize(child, depth + 1)),
  ];
}

function draw(
  content: string,
  options: { largeEmoji?: boolean; edited?: boolean } = {},
) {
  const view = render(
    <MessageMarkdown
      row={{
        id: "message",
        channelId: "channel",
        authorId: "author",
        content,
        createdAt: 1,
        mentions: [mic],
        participants: [],
        attachments: [],
        reactions: [],
        replyCount: 0,
        emoji: [],
      }}
      media={() => undefined}
      onOpenLink={() => false}
      canOpenLink={() => true}
      participantProfiles={new Map([[mic, { name: "Mic" }]])}
      extensions={extensions}
      {...options}
    />,
    { wrapper: ToastProvider },
  );
  const lines = [...view.container.childNodes].flatMap((child) =>
    serialize(child),
  );
  cleanup();
  return lines.join("\n");
}

afterEach(() => vi.restoreAllMocks());

it("renders the message corpus exactly as the recorded baseline", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const output = Object.entries(CORPUS).map(
    ([name, content]) => `## ${name}\n${draw(content)}`,
  );
  output.push(`## edited\n${draw("changed", { edited: true })}`);
  output.push(`## largeEmoji\n${draw("😀", { largeEmoji: true })}`);
  await expect(`${output.join("\n\n")}\n`).toMatchFileSnapshot(
    "./__parity__/message-markdown.txt",
  );
});
