import { MAX_RENDER_CHARS, required } from "./markdown-limits";
import { containerDefinitions } from "./markdown-container-definitions";
import { fenceLine } from "./markdown-fences";
import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import type { Root, Element } from "hast";
import {
  indexDocument,
  indexData,
  documentParts,
  PART_CHARS,
  remarkPartHeadings,
  rehypePartFootnotes,
} from "./document-parts";

function rendered(
  parts: ReturnType<typeof indexDocument>,
  index: number,
): Root {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkPartHeadings(parts, index))
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypePartFootnotes(parts, index));
  return processor.runSync(processor.parse(parts.partSource(index))) as Root;
}
function elements(tree: Root): Element[] {
  const found: Element[] = [];
  const stack: (Root | Element)[] = [tree];
  while (stack.length)
    for (const child of required(stack.pop()).children)
      if (child.type === "element") {
        found.push(child);
        stack.push(child);
      }
  return found;
}
function textOf(node: Root | Element): string {
  return node.children
    .map((child) =>
      "value" in child
        ? child.value
        : child.type === "element"
          ? textOf(child)
          : "",
    )
    .join("");
}

describe("bounded document parts", () => {
  it.each(["markdown", "code", "text"] as const)(
    "keeps exact scalar and CRLF boundaries and physical lines for %s",
    (kind) => {
      const text =
        "a".repeat(PART_CHARS - 1) +
        "😀\r\n" +
        "b".repeat(PART_CHARS * 2) +
        "\r\nlast";
      const indexed = indexDocument(text, kind);
      expect(
        indexed.parts.map((part) => text.slice(part.start, part.end)).join(""),
      ).toBe(text);
      for (const part of indexed.parts) {
        expect(part.end - part.start).toBeLessThanOrEqual(PART_CHARS);
        expect(part.line).toBe(
          1 + [...text.slice(0, part.start).matchAll(/\r\n|\r|\n/g)].length,
        );
        expect(text.slice(part.start, part.end)).not.toMatch(
          /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/,
        );
        expect(text.slice(part.start, part.end)).not.toMatch(/^\n|\r$/);
      }
      expect(indexDocument("", kind).parts).toEqual([
        { start: 0, end: 0, line: 1 },
      ]);
    },
  );

  it("assigns global heading IDs by source offset and indexes rendered container/setext headings", () => {
    const text =
      "# User content files\n\n#### Repeat\n\n# Repeat\n\n> ## Quoted *heading*\n\n- ### Listed\n\n  ### Indented\n\nSetext &amp; `code`\n===\n\n" +
      "paragraph\n\n".repeat(2000) +
      "# Files\n\n# Repeat\n";
    const indexed = indexDocument(text, "markdown");
    expect(indexed.outline.map((item) => [item.text, item.id])).toEqual([
      ["User content files", "user-content-files"],
      ["Repeat", "repeat-1"],
      ["Quoted heading", "quoted-heading"],
      ["Listed", "listed"],
      ["Indented", "indented"],
      ["Setext & code", "setext--code"],
      ["Files", "files"],
      ["Repeat", "repeat-2"],
    ]);
    for (let i = 0; i < indexed.parts.length; i++) {
      const ids = elements(rendered(indexed, i))
        .filter((node) => /^h[1-6]$/.test(node.tagName))
        .map((node) => node.properties.id);
      for (const heading of indexed.outline.filter((item) => item.part === i))
        expect(ids).toContain(`user-content-${heading.id}`);
    }
    expect(indexed.partOf("#user-content-files")).toBe(0);
    expect(indexed.partOf("#files")).toBe(indexed.parts.length - 1);
    expect(indexed.partOf("#user-content-user-content-files")).toBe(0);
    expect(indexed.partOf("user-content-repeat-2")).toBe(
      indexed.parts.length - 1,
    );
  });

  it("carries a container-owned fence without interpreting its payload as headings", () => {
    const text = `> - \`\`\`ts\n${">   # literal\n".repeat(1600)}>   \`\`\`\n\n# Visible\n`;
    const indexed = indexDocument(text, "markdown");
    expect(indexed.outline.map((item) => item.text)).toEqual(["Visible"]);
    expect(
      indexed.parts.slice(1).some((part) => part.fence !== undefined),
    ).toBe(true);
    for (let i = 0; i < indexed.parts.length; i++) {
      const nodes = elements(rendered(indexed, i));
      expect(
        nodes.filter((node) => node.tagName === "h1").map(textOf),
      ).not.toContain("literal");
      expect(textOf(rendered(indexed, i))).not.toContain("\uE000");
    }
  });

  it("preserves first definitions and builds local footnotes with canonical navigation", () => {
    for (const [owner, noteOwner] of [
      ["> ", "> "],
      [">\t", ">\t"],
      ["- ", "  "],
      ["- ", "- "],
    ] as const) {
      const duplicate = indexDocument(
        `[^n]: First definition.\n\n${"paragraph\n\n".repeat(1500)}${noteOwner.trim() ? noteOwner : owner}[^n]: Later definition.\n\nCall[^n].\n`,
        "markdown",
      );
      const duplicateNotes = elements(
        rendered(duplicate, duplicate.parts.length - 1),
      )
        .filter((node) => node.tagName === "li")
        .map(textOf)
        .join("");
      expect(duplicateNotes).toContain("First definition.");
      expect(duplicateNotes).not.toContain("Later definition.");
      const source = `${owner}[site]: https://example.org/first\n${noteOwner}[^n]: Footnote\n${owner.startsWith(">") ? ">     " : "      "}continued [site].\n\n${"paragraph\n\n".repeat(1500)}[site]: https://example.org/later\n\nRead [site] and note[^n].\n`;
      const parts = indexDocument(source, "markdown"),
        last = elements(rendered(parts, parts.parts.length - 1));
      expect(
        last.some(
          (node) => node.properties.href === "https://example.org/first",
        ),
      ).toBe(true);
      expect(
        last.some(
          (node) => node.properties.href === "https://example.org/later",
        ),
      ).toBe(false);
      expect(
        last
          .filter((node) => node.tagName === "li")
          .map(textOf)
          .join(""),
      ).toContain("Footnote\ncontinued");
    }
    const text =
      "[site]: https://example.org/first\n\nFirst [site] and other[^other], then note[^n].\n\n" +
      "paragraph\n\n".repeat(1400) +
      "[site]: https://example.org/later\n\n# Later\nSecond [site] and note[^n].\n\n[^n]: Definition [site] and nested[^other].\n[^other]: Cycle[^n].\n";
    const indexed = indexDocument(text, "markdown");
    const first = elements(rendered(indexed, 0));
    const lastIndex = indexed.parts.length - 1,
      last = elements(rendered(indexed, lastIndex));
    expect(
      first
        .filter((node) => node.tagName === "a")
        .some((node) => node.properties.href === "https://example.org/first"),
    ).toBe(true);
    expect(
      last
        .filter((node) => node.tagName === "a")
        .some((node) => node.properties.href === "https://example.org/later"),
    ).toBe(false);
    expect(
      first.some((node) => node.properties.id === "user-content-fn-n"),
    ).toBe(true);
    expect(
      last.some(
        (node) => node.properties.id === `user-content-fn-n-part-${lastIndex}`,
      ),
    ).toBe(true);
    expect(
      last.some(
        (node) =>
          node.properties.id === `user-content-fn-other-part-${lastIndex}`,
      ),
    ).toBe(true);
    expect(
      Number(
        last.find(
          (node) =>
            node.properties.id === `user-content-fn-n-part-${lastIndex}`,
        )?.properties.value,
      ),
    ).toBe(2);
    expect(indexed.partOf(`user-content-fn-n-part-${lastIndex}`)).toBe(
      lastIndex,
    );
    expect(indexed.partOf(`user-content-fnref-n-2-part-${lastIndex}`)).toBe(
      lastIndex,
    );
    expect(
      indexed.partOf(`user-content-fnref-n-999-part-${lastIndex}`),
    ).toBeUndefined();
    expect(
      indexed.partOf(`user-content-fn-n-part-${indexed.parts.length}`),
    ).toBeUndefined();
    expect(indexed.partFallback(lastIndex)).toBeUndefined();
  });

  it("keeps CommonMark HTML suppression and removes synthetic context bytes", () => {
    const text =
      "<div>\n" +
      "# hidden\n".repeat(2000) +
      "\n# Visible\n\n<!--\n" +
      "# comment\n".repeat(1600) +
      "-->\n\n# End\n";
    const indexed = indexDocument(text, "markdown");
    expect(indexed.outline.map((item) => item.text)).toEqual([
      "Visible",
      "End",
    ]);
    for (let i = 1; i < indexed.parts.length; i++) {
      const output = textOf(rendered(indexed, i));
      const part = required(indexed.parts[i]);
      const original = text.slice(part.start, part.end);
      expect([...output.matchAll(/<div>/g)].length).toBe(
        [...original.matchAll(/<div>/g)].length,
      );
      expect([...output.matchAll(/<!--\n/g)].length).toBe(
        [...original.matchAll(/<!--\n/g)].length,
      );
    }
  });

  it("treats frontmatter, math and emoji with the installed SafeMarkdown semantics", () => {
    const indexed = indexDocument(
      "---\n# YAML heading\n---\n\n$$\n# Math heading\n$$\n\n# :sparkles:\n",
      "markdown",
    );
    expect(indexed.outline.map((item) => item.text)).toEqual([
      "YAML heading",
      "Math heading",
      ":sparkles:",
    ]);
  });
  it("keeps setext headings with their underline at a part seam", () => {
    const text =
      "paragraph\n\n".repeat(600) +
      "First line\nsecond line\n===\n\n" +
      "paragraph\n\n".repeat(1300);
    const indexed = indexDocument(text, "markdown");
    expect(indexed.outline.map((item) => item.text)).toEqual([
      "First line\nsecond line",
    ]);
    const item = required(indexed.outline[0]);
    expect(
      elements(rendered(indexed, item.part)).some(
        (node) => node.properties.id === `user-content-${item.id}`,
      ),
    ).toBe(true);
  });

  it("normalizes long formatted labels without parsing an unbounded heading", () => {
    const title =
      "label ".repeat(100) +
      "*emphasis* and `*code*` &amp; [site](https://example.org)";
    const indexed = indexDocument(`# ${title}\n`, "markdown");
    expect(indexed.outline[0]?.text).toBe(
      `${"label ".repeat(100)}emphasis and *code* & site`,
    );
  });

  it("ends HTML suppression when its quote owner ends and retains imported note HTML", () => {
    const text =
      "> <div>\n" +
      "> # hidden\n".repeat(1800) +
      "\n# Visible\n\nCall[^n].\n\n" +
      "paragraph\n\n".repeat(1200) +
      "[^n]: Literal <b>HTML</b>.\n";
    const indexed = indexDocument(text, "markdown");
    expect(indexed.outline.map((item) => item.text)).toEqual(["Visible"]);
    const caller = indexed.parts.findIndex((part) =>
      text.slice(part.start, part.end).includes("Call[^n]"),
    );
    expect(textOf(rendered(indexed, caller))).toContain("Literal <b>HTML</b>.");
    for (let at = 1; at < indexed.parts.length; at++)
      expect(
        elements(rendered(indexed, at))
          .filter((node) => /^h[1-6]$/.test(node.tagName))
          .map(textOf),
      ).not.toContain("hidden");
  });

  it("routes encoded footnote identifiers and keeps code-only notes unreferenced", () => {
    const suffixed = indexDocument(
      `First[^z].\n\n${"paragraph\n\n".repeat(1500)}Second[^n-part-1].\n\n[^z]: Z\n[^n-part-1]: N\n`,
      "markdown",
    );
    const suffixNodes = elements(rendered(suffixed, suffixed.parts.length - 1));
    expect(
      suffixNodes
        .filter((node) => node.properties.dataFootnoteRef !== undefined)
        .map(textOf),
    ).toEqual(["2"]);
    expect(
      suffixNodes.find((node) => node.tagName === "li")?.properties.value,
    ).toBe("2");
    const text =
      "`[^unused]` <!-- [^unused] --> Call[^é].\n\n" +
      "paragraph\n\n".repeat(1300) +
      "Again[^é].\n\n[^é]: Unicode.\n[^unused]: Hidden.\n";
    const indexed = indexDocument(text, "markdown");
    expect(indexed.partOf("user-content-fn-%C3%A9")).toBe(0);
    expect(indexed.partOf("fnref-%C3%A9-part-1")).toBe(1);
    expect(indexed.partOf("fn-unused")).toBeUndefined();
    expect(textOf(rendered(indexed, 0))).not.toContain("Hidden.");
  });

  it("bounds container projection without accepting a synthetic end of input", () => {
    const tail = `\n\n${"paragraph\n\n".repeat(1500)}`;
    const owner = "> ".repeat(40),
      label = Array.from({ length: 70 }, () => "x").join("\n");
    const labelSource = `${owner}[${label.replace(/\n/g, `\n${owner}`)}]: https://example.org/label${tail}[${label.replace(/\n/g, " ")}]\n`;
    const titleSource = `> [site]: https://example.org/title\n> "${"title\n> ".repeat(1000)}end"${tail}[site]\n`;
    const shortSource = `> [site]: https://example.org/short\n> ${"plain prose ".repeat(100_000)}${tail}[site]\n`;
    const manySource = `${Array.from({ length: 2000 }, (_, at) => `> [entry-${at}]: https://example.org/${at}\n`).join("")}${tail}[entry-1] [entry-1999]\n`;
    for (const [source, expected, title] of [
      [labelSource, ["https://example.org/label"], undefined],
      [
        titleSource,
        ["https://example.org/title"],
        `${"title\n".repeat(1000)}end`,
      ],
      [shortSource, ["https://example.org/short"], undefined],
      [
        manySource,
        ["https://example.org/1", "https://example.org/1999"],
        undefined,
      ],
    ] as const) {
      const indexed = indexDocument(source, "markdown"),
        last = indexed.parts.length - 1;
      expect(indexed.partFallback(last)).toBeUndefined();
      const links = elements(rendered(indexed, last)).filter(
        (node) => node.tagName === "a",
      );
      expect(links.map((node) => node.properties.href)).toEqual(expected);
      expect(links.map((node) => node.properties.title)).toEqual(
        expected.map(() => title),
      );
    }
    let charges = 0;
    const firstLine = required(titleSource.split("\n")[0]),
      first = fenceLine(firstLine, { owners: [] });
    const reader = containerDefinitions(titleSource, {
      exhausted: false,
      charge() {
        charges++;
        return true;
      },
    });
    expect(
      reader.contained?.(0, first.bodyOffset, first.after, first.bodyPadding)
        ?.label,
    ).toBe("SITE");
    expect(charges).toBe(1);
    const oversized = indexDocument(
      `> [site]: https://example.org/large\n> "${"x".repeat(MAX_RENDER_CHARS)}"${tail}[site]\n`,
      "markdown",
    );
    expect(oversized.partFallback(0)).toBe("too-large");
    const opening = '> [site]: https://example.org/invalid "';
    const invalid = indexDocument(
      `${opening}${"x".repeat(4096 - opening.length - 1)}" trailing${tail}[site]\n`,
      "markdown",
    );
    expect(
      elements(rendered(invalid, invalid.parts.length - 1)).filter(
        (node) => node.tagName === "a",
      ),
    ).toHaveLength(0);
  });

  it("reports admitted-size fallback and renders literal source without a delimiter escape", () => {
    for (const [prefix, nesting] of [
      ["", 6000],
      [`${"paragraph\n\n".repeat(1300)}safe\n\n`, 600],
    ] as const) {
      const source = `${prefix}${"> ".repeat(nesting)}word\n`;
      const parts = indexDocument(source, "markdown");
      const at = parts.parts.findIndex((part) => part.end === source.length);
      if (prefix)
        expect(required(parts.parts[at]).start).toBeLessThan(prefix.length);
      expect(() => rendered(parts, at)).not.toThrow();
      expect(parts.partFallback(at)).toBe("too-deep");
      expect(
        elements(rendered(parts, at))
          .filter((node) => node.tagName === "code")
          .map(textOf),
      ).toEqual([source.slice(required(parts.parts[at]).start)]);
    }
    const noteSource = `Call[^deep].\n\n${"paragraph\n\n".repeat(1500)}[^deep]: ${"> ".repeat(6000)}word\n`;
    const noteParts = indexDocument(noteSource, "markdown");
    expect(noteParts.partFallback(0)).toBe("too-deep");
    expect(() => rendered(noteParts, 0)).not.toThrow();
    const definition = `[^n]: ${"value ".repeat(170_000)}\n`;
    const text =
      "Use[^n].\n\n```literal\n```\n\n" +
      "paragraph\n\n".repeat(1400) +
      definition;
    const indexed = indexDocument(text, "markdown");
    expect(indexed.partFallback(0)).toBe("too-large");
    const part = required(indexed.parts[0]);
    expect(
      elements(rendered(indexed, 0))
        .filter((node) => node.tagName === "code")
        .map(textOf),
    ).toEqual([text.slice(part.start, part.end)]);
  });
});

it("rebuilds the worker index with distant references and whole-file anchors", () => {
  const source =
    "[site] Call[^n].\n\n" +
    "paragraph\n\n".repeat(1800) +
    "# Late\n\n[site]: https://example.org/site\n[^n]: A distant note.\n";
  const data = structuredClone(indexData(source, "markdown"));
  const parts = documentParts(source, data);
  expect(parts.outline).toEqual([
    { depth: 1, text: "Late", id: "late", part: parts.parts.length - 1 },
  ]);
  expect(parts.partOf("#late")).toBe(parts.parts.length - 1);
  const first = elements(rendered(parts, 0));
  expect(
    first
      .filter((node) => node.tagName === "a")
      .map((node) => node.properties.href),
  ).toContain("https://example.org/site");
  expect(textOf(rendered(parts, 0))).toContain("A distant note.");
});

it("counts Unicode Markdown words while plain files skip reading metadata", () => {
  const source = "hello-world café 你好 123 can't a--b 𐐀𐐁\n";
  expect(indexDocument(source, "markdown").words).toBe(8);
  for (const kind of ["code", "text"] as const)
    expect(indexDocument(source, kind).words).toBe(0);
});

describe("forced cuts inside one long line", () => {
  it("cut between inline spans, never inside one", () => {
    const sentence =
      "Some prose with `a code span inside` and *emphasis here*. ";
    const text = sentence.repeat(Math.ceil((PART_CHARS * 3) / sentence.length));
    const indexed = indexDocument(text, "markdown");
    expect(indexed.parts.length).toBeGreaterThan(2);
    expect(
      indexed.parts.map((part) => text.slice(part.start, part.end)).join(""),
    ).toBe(text);
    indexed.parts.forEach((part, index) => {
      const slice = text.slice(part.start, part.end);
      expect((slice.match(/`/g)?.length ?? 0) % 2).toBe(0);
      expect((slice.match(/\*/g)?.length ?? 0) % 2).toBe(0);
      expect(indexed.partFallback(index)).toBeUndefined();
    });
  });

  it("shows both sides as text when a span fills the whole window", () => {
    const text = `x \`${"y ".repeat(Math.floor(PART_CHARS * 0.6))}\` z`;
    const indexed = indexDocument(text, "markdown");
    expect(indexed.parts.length).toBe(2);
    expect(indexed.partFallback(0)).toBe("context");
    expect(indexed.partFallback(1)).toBe("context");
  });

  it("renders the parts after an unsafe cut normally", () => {
    const span = `x \`${"y ".repeat(Math.floor(PART_CHARS * 0.6))}\` `;
    const text = span + "plain words ".repeat(PART_CHARS / 2);
    const indexed = indexDocument(text, "markdown");
    expect(indexed.parts.length).toBeGreaterThan(3);
    expect(indexed.partFallback(0)).toBe("context");
    expect(indexed.partFallback(1)).toBe("context");
    for (let index = 2; index < indexed.parts.length; index++)
      expect(indexed.partFallback(index)).toBeUndefined();
  });
});
