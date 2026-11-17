import type { Element, Nodes, Root } from "hast";
import { expect, it } from "vitest";
import { highlight, languageFor, rehypeHighlight } from "./highlight";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";

function text(node: Nodes): string {
  return node.type === "text"
    ? node.value
    : "children" in node
      ? node.children.map(text).join("")
      : "";
}
function spans(node: Nodes): number {
  if (node.type === "element") expect(node.tagName).toBe("span");
  return (
    (node.type === "element" ? 1 : 0) +
    ("children" in node
      ? node.children.reduce((n, child) => n + spans(child), 0)
      : 0)
  );
}

it.each(["typescript", "ts", "javascript", "json", "python", "sql"])(
  "highlights %s without losing source text",
  (language) => {
    const source =
      language === "json"
        ? '{"answer":42}'
        : 'const answer = 42;\nprint("hello");\n';
    const tree = highlight(source, language);
    expect(text(tree)).toBe(source);
    expect(spans(tree)).toBeGreaterThan(0);
  },
);

it.each([undefined, "unknown-language"])(
  "keeps unrecognized language %s as literal text",
  (language) => {
    const source = '<script>alert("hello")</script>\n';
    expect(highlight(source, language)).toEqual({
      type: "root",
      children: [{ type: "text", value: source }],
    });
  },
);

it("selects grammars from paths and leaves ordinary text unhighlighted", () => {
  expect(languageFor("/docs/EXAMPLE.TSX")).toBe("typescript");
  expect(languageFor("C:\\docs\\Dockerfile")).toBe("dockerfile");
  expect(languageFor("events.ndjson")).toBe("json");
  expect(languageFor("notes.txt")).toBeUndefined();
  expect(languageFor("constructor")).toBeUndefined();
});

it("highlights fenced blocks and leaves unknown and inline code literal", () => {
  const source =
    "```ts\nconst answer = 42;\n```\n\n```unknown-language\n<x>\n```\n\n`const answer = 42;`";
  const parser = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeHighlight);
  const tree = parser.runSync(parser.parse(source)) as Root;
  const blocks = tree.children.filter(
    (node): node is Element =>
      node.type === "element" && node.tagName === "pre",
  );
  const [first, second] = blocks;
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  if (!first || !second) throw new Error("Missing fenced blocks");
  expect(text(first)).toBe("const answer = 42;\n");
  const highlighted = first.children[0];
  expect(
    highlighted?.type === "element" &&
      highlighted.children.some(
        (child) => child.type === "element" && child.tagName === "span",
      ),
  ).toBe(true);
  expect(text(second)).toBe("<x>\n");
  const unknown = second.children[0];
  expect(
    unknown?.type === "element" &&
      unknown.children.every((node) => node.type === "text"),
  ).toBe(true);
  const paragraph = tree.children.find(
    (node) => node.type === "element" && node.tagName === "p",
  );
  expect(
    paragraph && "children" in paragraph && paragraph.children[0],
  ).toMatchObject({
    tagName: "code",
    children: [{ type: "text", value: "const answer = 42;" }],
  });
});
