// @vitest-environment jsdom
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
} from "@testing-library/react";
import { npubEncode } from "nostr-tools/nip19";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyEmoji } from "../../bundled/emoji/copy-emoji";
import { setClockPreference } from "../../shared/clock-preference";
import { formatItemTimestamp } from "../../shared/datetime";
import { profileTarget } from "../profiles/target";
import { MessageMarkdown } from "./MessageMarkdown";
import { MessageRow } from "./MessageRow";
import {
  type CopyFormat,
  containMessageSelection,
  copyDocument,
  serializeNode,
  serializeSelection,
  spoilerDelimiter,
  useMessageSelectionCopy,
} from "./selection-copy";

const person = "a".repeat(64);
const target = `nostr:${npubEncode(person)}`;
const message = `buzz://message?channel=general&id=${"b".repeat(64)}`;
const messageHtml = message.replaceAll("&", "&amp;");
const formats: CopyFormat[] = ["text", "markdown", "html"];

// Markup shapes produced by MessageMarkdown's renderProfile and MessageLink.
const mention = (name = "Morgan", locator = target) =>
  `<button type="button" data-mention-kind="person" data-profile-target="${locator}" data-mention-name="${name}"><svg aria-hidden="true"><path d="M0 0"></path></svg>${name}</button>`;
const anchor = (href: string, label: string, visible = label) =>
  `<a href="${href}" data-link-label="${label}"><span data-link-kind="web"><span class="lead"><svg aria-hidden="true"></svg>${visible}</span></span></a>`;
const row = (html: string, id = "m1") =>
  `<div data-message-id="${id}">${html}</div>`;
// MessageRow's shape: toolbar chrome, the byline, then the payload and its
// accessible date. A grouped row keeps its byline out of sight and selections.
const createdAt = 1_789_290_300;
const time = formatItemTimestamp(createdAt, { withTime: true });
const authored = (name: string, body: string, id = "m1") =>
  row(
    `<div><div style="user-select: none"><span>${time}</span></div><div style="user-select: none" data-copy-author="${name}" data-copy-time="${createdAt}"><strong>${name}</strong></div></div><div>${body}<time style="user-select: none">Tuesday</time></div>`,
    id,
  );

function mount(html: string) {
  document.body.innerHTML = html;
  return document.body;
}
function query(selector: string, root: ParentNode = document) {
  const element = root.querySelector(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}
function lastText(node: Node): Text {
  const last = node.lastChild;
  if (!last) throw new Error("Empty node");
  return last.nodeType === Node.TEXT_NODE ? (last as Text) : lastText(last);
}
function select(
  start: Node,
  startOffset: number,
  end: Node,
  endOffset: number,
) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = document.getSelection();
  if (!selection) throw new Error("No selection");
  selection.removeAllRanges();
  selection.addRange(range);
  return { range, selection };
}
function each(node: Node, range?: Range) {
  return Object.fromEntries(
    formats.map((format) => [format, serializeNode(node, format, range)]),
  ) as Record<CopyFormat, string>;
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("serializeNode", () => {
  it.each([
    [mention(), "Morgan", "@Morgan", `[@Morgan](${target})`],
    [
      anchor("buzz://channel/design", "#design", "design"),
      "design",
      "#design",
      "[#design](buzz://channel/design)",
    ],
    [
      anchor("http://example.com/docs", "docs"),
      "docs",
      "docs (http://example.com/docs)",
      "[docs](http://example.com/docs)",
    ],
    [
      anchor("https://example.com/docs", "docs"),
      "docs",
      "docs (https://example.com/docs)",
      "[docs](https://example.com/docs)",
    ],
  ])(
    "keeps a whole chip selected within one text node: %s",
    (html, label, plain, markdown) => {
      const paragraph = query("p", mount(row(`<p>before ${html} after</p>`)));
      const labelNode = lastText(query("button, a", paragraph));
      const { selection } = select(labelNode, 0, labelNode, label.length);
      expect(serializeSelection(selection, "text")).toBe(plain);
      expect(serializeSelection(selection, "markdown")).toBe(markdown);
      expect(serializeSelection(selection, "html")).toContain("<a href=");
      select(labelNode, 1, labelNode, label.length - 1);
      for (const format of formats)
        expect(serializeSelection(selection, format)).toBe(label.slice(1, -1));
    },
  );

  it("keeps a whole mention's identity and drops it from a fragment", () => {
    const paragraph = query("p", mount(row(`<p>Hi ${mention()} there</p>`)));
    expect(each(paragraph)).toEqual({
      text: "Hi @Morgan there",
      markdown: `Hi [@Morgan](${target}) there`,
      html: `<p>Hi <a href="${target}">@Morgan</a> there</p>`,
    });
    const { range } = select(
      paragraph.firstChild as Node,
      0,
      lastText(query("button", paragraph)),
      3,
    );
    expect(each(paragraph, range)).toEqual({
      text: "Hi Mor",
      markdown: "Hi Mor",
      html: "<p>Hi Mor</p>",
    });
    const whole = select(
      paragraph.firstChild as Node,
      3,
      lastText(query("button", paragraph)),
      6,
    );
    expect(serializeNode(paragraph, "markdown", whole.range)).toBe(
      `[@Morgan](${target})`,
    );
  });

  it("restores the channel sigil with its locator", () => {
    const link = query(
      "a",
      mount(row(anchor("buzz://channel/design", "#design", "design"))),
    );
    expect(each(link)).toEqual({
      text: "#design",
      markdown: "[#design](buzz://channel/design)",
      html: '<a href="buzz://channel/design">#design</a>',
    });
  });

  it("copies raw in-app and external links as their URL and labelled ones with the label", () => {
    const paragraph = query(
      "p",
      mount(
        row(
          `<p>${anchor(message, "", "Message")} ${anchor(message, "Desktop alias")} ${anchor("https://example.com/docs", "", "example.com/docs")} ${anchor("https://example.com/docs", "docs")}</p>`,
        ),
      ),
    );
    expect(each(paragraph)).toEqual({
      text: `${message} Desktop alias (${message}) https://example.com/docs docs (https://example.com/docs)`,
      markdown: `${message} [Desktop alias](${message}) https://example.com/docs [docs](https://example.com/docs)`,
      html: `<p><a href="${messageHtml}">${messageHtml}</a> <a href="${messageHtml}">Desktop alias</a> <a href="https://example.com/docs">https://example.com/docs</a> <a href="https://example.com/docs">docs</a></p>`,
    });
    const { range } = select(
      lastText(query("a:nth-of-type(2)", paragraph)),
      0,
      lastText(query("a:nth-of-type(2)", paragraph)),
      7,
    );
    expect(serializeNode(paragraph, "markdown", range)).toBe("Desktop");
  });

  it("copies labelled and shortened raw HTTP links through every clipboard format", () => {
    const raw = "http://example.com/a/long/destination";
    const paragraph = query(
      "p",
      mount(
        row(
          `<p>${anchor(raw, "", "example.com/a/long…")} ${anchor("http://example.com/docs", "docs")}</p>`,
        ),
      ),
    );
    expect(each(paragraph)).toEqual({
      text: `${raw} docs (http://example.com/docs)`,
      markdown: `${raw} [docs](http://example.com/docs)`,
      html: `<p><a href="${raw}">${raw}</a> <a href="http://example.com/docs">docs</a></p>`,
    });
    const template = document.createElement("template");
    template.innerHTML = serializeNode(paragraph, "html");
    expect(serializeNode(template.content, "markdown")).toBe(
      serializeNode(paragraph, "markdown"),
    );
  });

  it("reads its own HTML back into the same Markdown", () => {
    const paragraph = query(
      "p",
      mount(
        row(
          `<p>Ask ${mention()} in ${anchor("buzz://channel/design", "#design", "design")} about <strong>${anchor("https://example.com/", "", "example.com")}</strong> or ${anchor(message, "Desktop alias")}</p>`,
        ),
      ),
    );
    const template = document.createElement("template");
    template.innerHTML = serializeNode(paragraph, "html");
    expect(serializeNode(template.content, "markdown")).toBe(
      serializeNode(paragraph, "markdown"),
    );
    expect(serializeNode(template.content, "text")).toBe(
      serializeNode(paragraph, "text"),
    );
  });

  it.each(["", "\n", "\n\n\n"])(
    "drops renderer whitespace between paragraphs with DOM separator %j",
    (spacing) => {
      const body = mount(row(`<p>First</p>${spacing}<p>Second</p>`));
      const { selection } = select(
        lastText(query("p", body)),
        1,
        lastText(query("p:last-child", body)),
        3,
      );
      expect(serializeSelection(selection, "text")).toBe("irst\n\nSec");
      const html = document.createElement("div");
      html.dataset.buzzCopy = "timeline";
      html.innerHTML = serializeSelection(selection, "html");
      expect(serializeNode(html, "markdown")).toBe("irst\n\nSec");
    },
  );

  it("writes custom emoji as shortcodes", () => {
    const paragraph = query(
      "p",
      mount(
        row(
          '<p>Party <img data-copy-emoji=":party:" alt=":party:" src="x"> on <img alt="plain" src="y"></p>',
        ),
      ),
    );
    expect(each(paragraph)).toEqual({
      text: "Party :party: on ",
      markdown: "Party :party: on ",
      html: "<p>Party :party: on </p>",
    });
  });

  it("separates rows and blocks like the browser's plain text", () => {
    const body = mount(
      `<ol><li>${row("<p>First</p>")}</li><li>${row(`<p>Second ${mention()}</p><table><tr><td>a</td><td></td><td>c</td></tr></table>`, "m2")}</li></ol>`,
    );
    const { selection } = select(
      lastText(query("[data-message-id='m1'] p", body)),
      0,
      lastText(query("td:last-child", body)),
      1,
    );
    expect(serializeSelection(selection, "text")).toBe(
      "First\nSecond @Morgan\n\na\t\tc",
    );
    expect(serializeSelection(selection, "markdown")).toBe(
      `First\nSecond [@Morgan](${target})\na\t\tc`,
    );
    expect(serializeSelection(selection, "html")).toBe(
      `<p>First</p><p>Second <a href="${target}">@Morgan</a></p><table><tbody><tr><td>a</td><td></td><td>c</td></tr></tbody></table>`,
    );
  });

  it.each([
    [2, "a\tb"],
    [4, "a\tb\nc\td"],
  ])(
    "keeps table boundaries when the selection ends in cell %s",
    (end, expected) => {
      const body = mount(
        row(
          "<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>",
        ),
      );
      const cells = body.querySelectorAll("td");
      const { selection } = select(
        lastText(cells.item(0)),
        0,
        lastText(cells.item(end - 1)),
        1,
      );
      expect(serializeSelection(selection, "text")).toBe(expected);
      expect(serializeSelection(selection, "markdown")).toBe(expected);
      const html = document.createElement("template");
      html.innerHTML = `<div data-buzz-copy="timeline">${serializeSelection(selection, "html")}</div>`;
      expect(serializeNode(html.content, "markdown")).toBe(expected);
    },
  );

  it("keeps inline formatting, code and fenced blocks", () => {
    const body = mount(
      row(
        '<p><strong>bold</strong> <em>it</em> <s>gone</s> <code>ls</code><br>next</p>\n<pre><code class="language-sh">echo hi\nls</code></pre>',
      ),
    );
    expect(each(query("[data-message-id]", body))).toEqual({
      text: "bold it gone ls\nnext\n\necho hi\nls",
      markdown: "**bold** _it_ ~~gone~~ `ls`\nnext\n\n```sh\necho hi\nls\n```",
      html: '<p><strong>bold</strong> <em>it</em> <s>gone</s> <code>ls</code><br>next</p><pre><code class="language-sh">echo hi\nls</code></pre>',
    });
  });

  it("keeps whitespace outside emphasis delimiters and inside code", () => {
    const paragraph = query(
      "p",
      mount(
        row("<p>a<strong> bold </strong>b <em>it </em>c <code> ls </code></p>"),
      ),
    );
    expect(each(paragraph)).toEqual({
      text: "a bold b it c  ls ",
      markdown: "a **bold** b _it_ c `  ls  `",
      html: "<p>a<strong> bold </strong>b <em>it </em>c <code> ls </code></p>",
    });
  });

  it.each([
    [1, "a"],
    [2, "a\n"],
    [3, "a\nb"],
    [4, "a\nb"],
  ])(
    "keeps selected code content at offset %s while removing only its terminator",
    (end, value) => {
      const body = mount(row("<p>x</p><pre><code>a\nb\n</code></pre>"));
      const { selection } = select(
        lastText(query("p", body)),
        0,
        lastText(query("code", body)),
        end,
      );
      const expected = `x\n\n\`\`\`\n${value}\n\`\`\``;
      expect(serializeSelection(selection, "markdown")).toBe(expected);
      const html = document.createElement("template");
      html.innerHTML = serializeSelection(selection, "html");
      expect(serializeNode(html.content, "markdown")).toBe(expected);
    },
  );

  it("writes lists, quotes and fences as Markdown blocks", () => {
    // Renderer formatting whitespace is omitted; semantic blocks own separation.
    const body = mount(
      row(
        '<ul><li>one</li><li>two <strong>b</strong></li></ul>\n<ol start="3"><li><p>first</p>\n<ul><li>sub</li></ul></li></ol>\n<blockquote><p>quoted</p>\n<blockquote><p>deep</p></blockquote></blockquote>\n<pre data-language="sh"><code>ls</code></pre>',
      ),
    );
    expect(each(query("[data-message-id]", body))).toEqual({
      text: "one\ntwo b\n\nfirst\n\nsub\n\nquoted\n\ndeep\n\nls",
      markdown:
        "- one\n- two **b**\n\n3. first\n   \n   - sub\n\n> quoted\n>\n> > deep\n\n```sh\nls\n```",
      html: '<ul><li>one</li><li>two <strong>b</strong></li></ul><ol start="3"><li><p>first</p><ul><li>sub</li></ul></li></ol><blockquote><p>quoted</p><blockquote><p>deep</p></blockquote></blockquote><pre><code class="language-sh">ls</code></pre>',
    });
    // The paste side inserts this document's nodes; `markdown` serializes it.
    const paragraph = (...content: object[]) => ({
      type: "paragraph",
      content,
    });
    const text = (text: string, marks?: object[]) =>
      marks ? { type: "text", text, marks } : { type: "text", text };
    const item = (...content: object[]) => ({
      type: "list_item",
      attrs: { spread: false },
      content,
    });
    expect(copyDocument(query("[data-message-id]", body)).toJSON()).toEqual({
      type: "doc",
      content: [
        {
          type: "bullet_list",
          attrs: { spread: false },
          content: [
            item(paragraph(text("one"))),
            item(paragraph(text("two "), text("b", [{ type: "bold" }]))),
          ],
        },
        {
          type: "ordered_list",
          attrs: { order: 3, spread: false },
          content: [
            item(paragraph(text("first")), {
              type: "bullet_list",
              attrs: { spread: false },
              content: [item(paragraph(text("sub")))],
            }),
          ],
        },
        {
          type: "blockquote",
          content: [
            paragraph(text("quoted")),
            { type: "blockquote", content: [paragraph(text("deep"))] },
          ],
        },
        {
          type: "code_block",
          attrs: { language: "sh" },
          content: [text("ls")],
        },
      ],
    });
    // A partial selection keeps each item's own number.
    const { range } = select(
      lastText(query("ol li p", body)),
      2,
      lastText(query("blockquote p", body)),
      3,
    );
    expect(
      serializeNode(query("[data-message-id]", body), "markdown", range),
    ).toBe("3. rst\n   \n   - sub\n\n> quo");
  });

  // MessageSpoiler's shape: a mask button, then content that reveal toggles.
  const spoiler = (revealed: boolean, inner: string) =>
    `<span data-spoiler="" data-revealed="${revealed}"><button type="button" aria-label="Reveal spoiler"></button><span aria-hidden="${!revealed}">${inner}</span></span>`;
  const spoilerHtml = (inner: string) =>
    `<span data-spoiler="">${spoilerDelimiter}${inner}${spoilerDelimiter}</span>`;

  it("copies a spoiler as the composer's mark in HTML and delimited elsewhere", () => {
    const body = mount(
      row(
        `<p>a ${spoiler(false, "secret")} b ${spoiler(true, "<strong>shown</strong>")}</p>`,
      ),
    );
    const paragraph = query("p", body);
    const flavors = {
      text: "a ||secret|| b ||shown||",
      markdown: "a ||secret|| b ||**shown**||",
      html: `<p>a ${spoilerHtml("secret")} b ${spoilerHtml("<strong>shown</strong>")}</p>`,
    };
    expect(each(paragraph)).toEqual(flavors);
    const parsed = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "a " },
            { type: "text", text: "secret", marks: [{ type: "spoiler" }] },
            { type: "text", text: " b " },
            {
              type: "text",
              text: "shown",
              marks: [{ type: "spoiler" }, { type: "bold" }],
            },
          ],
        },
      ],
    };
    expect(copyDocument(paragraph).toJSON()).toEqual(parsed);
    // Part of a spoiler stays a spoiler, including a word selected wholly
    // inside its text, whose range never reaches the spoiler element itself;
    // a selection ending at its start adds nothing.
    const secret = lastText(query("[data-spoiler] span", paragraph));
    const after = paragraph.childNodes[2] as Text;
    expect(
      serializeSelection(select(secret, 2, after, 2).selection, "text"),
    ).toBe("||cret|| b");
    const inside = select(secret, 2, secret, 4).selection;
    expect(serializeSelection(inside, "text")).toBe("||cr||");
    expect(serializeSelection(inside, "markdown")).toBe("||cr||");
    expect(serializeSelection(inside, "html")).toBe(spoilerHtml("cr"));
    expect(
      serializeSelection(select(paragraph, 0, secret, 0).selection, "html"),
    ).toBe("<p>a </p>");
    // A chip inside a spoiler copies as the spoiler's, whole label or not.
    const chip = query(
      "[data-spoiler] a",
      mount(
        row(
          `<p>${spoiler(true, `ask <a href="${profileTarget("c".repeat(64))}">@Mic</a>`)}</p>`,
        ),
      ),
    );
    const label = lastText(chip);
    expect(
      serializeSelection(select(label, 0, label, 4).selection, "markdown"),
    ).toBe(`||[@Mic](${profileTarget("c".repeat(64))})||`);
    expect(
      serializeSelection(select(label, 1, label, 3).selection, "markdown"),
    ).toBe("||Mi||");
    // Read back from the clipboard, the delimiters are the mark's, not text,
    // and copying that HTML again does not double them.
    const copied = mount(
      `<div data-buzz-copy="timeline">${flavors.html}</div>`,
    );
    expect(each(query("p", copied))).toEqual(flavors);
    expect(copyDocument(query("[data-buzz-copy]", copied)).toJSON()).toEqual(
      parsed,
    );
  });

  it("keeps pipe pairs authored inside a spoiler apart from its delimiters", () => {
    // `||\|\|secret\|\| \`||x||\`||` renders literal pipes inside the spoiler.
    const body = mount(
      row(`<p>a ${spoiler(false, "||secret|| <code>||x||</code>")}</p>`),
    );
    const paragraph = query("p", body);
    const flavors = {
      text: "a ||||secret|| ||x||||",
      markdown: "a ||\\|\\|secret\\|\\| `||x||`||",
      html: `<p>a ${spoilerHtml("||secret|| <code>||x||</code>")}</p>`,
    };
    expect(each(paragraph)).toEqual(flavors);
    const parsed = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "a " },
            { type: "text", text: "||secret|| ", marks: [{ type: "spoiler" }] },
            {
              type: "text",
              text: "||x||",
              marks: [{ type: "code" }, { type: "spoiler" }],
            },
          ],
        },
      ],
    };
    expect(copyDocument(paragraph).toJSON()).toEqual(parsed);
    const copied = mount(
      `<div data-buzz-copy="timeline">${flavors.html}</div>`,
    );
    expect(each(query("p", copied))).toEqual(flavors);
    expect(copyDocument(query("[data-buzz-copy]", copied)).toJSON()).toEqual(
      parsed,
    );
  });

  it("copies headings, task states and rules as semantic HTML the composer reads as source", () => {
    const body = mount(
      `<div data-buzz-copy="timeline">${row(
        '<h2>Title <strong>b</strong></h2>\n<ul class="contains-task-list">\n<li class="task-list-item"><input disabled="" type="checkbox"> todo</li>\n<li class="task-list-item"><input disabled="" type="checkbox" checked=""> done</li>\n<li>plain</li>\n</ul>\n<p>above</p>\n<hr>\n<p>below</p>',
      )}</div>`,
    );
    const message = query("[data-message-id]", body);
    expect(each(message)).toEqual({
      text: "Title b\n\n[ ] todo\n[x] done\nplain\n\nabove\n\n---\n\nbelow",
      markdown:
        "## Title **b**\n\n- [ ] todo\n- [x] done\n- plain\n\nabove\n\n***\n\nbelow",
      html: '<h2>Title <strong>b</strong></h2><ul><li><input type="checkbox"> todo</li><li><input type="checkbox" checked> done</li><li>plain</li></ul><p>above</p><hr><p>below</p>',
    });
    // Source text joins the paragraphs and items; no new block kinds appear.
    expect(
      copyDocument(message)
        .toJSON()
        .content.map((block: { type: string }) => block.type),
    ).toEqual([
      "paragraph",
      "bullet_list",
      "paragraph",
      "paragraph",
      "paragraph",
      "paragraph",
      "paragraph",
    ]);
    // A selection starting inside a heading keeps its level; one starting
    // after a checkbox omits it, while one from the item's start keeps it.
    const done = lastText(query("li + li", body));
    const partial = (start: Node, offset: number) =>
      serializeNode(message, "markdown", select(start, offset, done, 5).range);
    expect(partial(query("h2", body).firstChild as Text, 2)).toBe(
      "## tle **b**\n\n- [ ] todo\n- [x] done",
    );
    expect(partial(lastText(query("li", body)), 2)).toBe("- odo\n- [x] done");
    expect(partial(query("li", body), 0)).toBe("- [ ] todo\n- [x] done");
  });

  it("spells a copied rule `***`, which no line above can make a heading", () => {
    const body = mount(
      `<div data-buzz-copy="timeline">${row("<p>text</p>\n<hr>")}</div>`,
    );
    const message = query("[data-message-id]", body);
    expect(serializeNode(message, "html")).toBe("<p>text</p><hr>");
    expect(serializeNode(message, "text")).toBe("text\n\n---");
    expect(serializeNode(message, "markdown")).toBe("text\n\n***");
    expect(copyDocument(message).toJSON()).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "text" }] },
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "***" }] },
      ],
    });
  });

  it.each([
    ["<h2>Title</h2>\n<p>body</p>", "p", "Title", "## Title", "<h2>Title</h2>"],
    [
      "<p>first</p>\n<blockquote>\n<p>quoted</p>\n</blockquote>",
      "blockquote p",
      "first",
      "first",
      "<p>first</p>",
    ],
    [
      "<p>first</p>\n<pre><code>code\n</code></pre>",
      "pre",
      "first",
      "first",
      "<p>first</p>",
    ],
    [
      "<ul>\n<li>\n<p>one</p>\n</li>\n<li>\n<p>two</p>\n</li>\n</ul>",
      "li + li p",
      "one",
      "- one",
      "<ul><li><p>one</p></li></ul>",
    ],
  ])(
    "leaves out the block after %j that a triple-click's range ends at",
    (html, next, text, markdown, copied) => {
      // Chromium and WebKit end it at offset 0 of the next block element.
      const body = mount(row(html));
      const message = query("[data-message-id]", body);
      const first = query("h2, p", message).firstChild as Text;
      const { range } = select(first, 0, query(next, body), 0);
      expect(each(message, range)).toEqual({ text, markdown, html: copied });
    },
  );

  it("leaves out the next row and an empty reaction row when a triple-click crosses into it", () => {
    // The real shape: a message's last paragraph to offset 0 of the next row's
    // first element, past the first row's empty reaction row.
    const body = mount(
      row(
        '<div><p>only</p><div role="group" aria-label="Reactions"></div></div>',
      ) + row("<div><span>Name</span><p>next</p></div>", "m2"),
    );
    const { range } = select(
      query("p", body).firstChild as Text,
      0,
      query('[data-message-id="m2"] span', body),
      0,
    );
    expect(each(body, range)).toEqual({
      text: "only",
      markdown: "only",
      html: "<p>only</p>",
    });
  });

  it("copies each byline a selection holds as one line above its message", () => {
    const body = mount(
      authored("Robin", "<p>first</p>") +
        authored("Mic", "<p>sure</p>\n<p>later</p>", "m2"),
    );
    const { range } = select(
      body,
      0,
      lastText(query("[data-message-id='m2'] p:last-of-type", body)),
      5,
    );
    const html = `<p><strong>Robin</strong> ${time}<br>first</p><p><strong>Mic</strong> ${time}<br>sure</p><p>later</p>`;
    expect(each(body, range)).toEqual({
      text: `Robin ${time}\nfirst\nMic ${time}\nsure\n\nlater`,
      markdown: `**Robin** ${time}\nfirst\n**Mic** ${time}\nsure\nlater`,
      html,
    });
    // Pasted into the composer, messages keep the blank line between them.
    const copied = document.createElement("template");
    copied.innerHTML = `<div data-buzz-copy="timeline">${html}</div>`;
    expect(serializeNode(query("div", copied.content), "markdown")).toBe(
      `**Robin** ${time}\nfirst\n\n**Mic** ${time}\nsure\n\nlater`,
    );
  });

  it("keeps a byline its own paragraph before another block, as the name alone when the row hides its time", () => {
    const body = mount(
      row(
        '<div data-copy-author="R&amp;D <ops>"><strong>R&amp;D &lt;ops&gt;</strong></div><ul><li>one</li></ul>',
      ) +
        row(
          '<div data-copy-author="Mic" data-copy-time=""><strong>Mic</strong><span>Away</span></div>',
          "m2",
        ),
    );
    expect(each(body)).toEqual({
      text: "R&D <ops>\none\nMic",
      markdown: "**R\\&D <ops>**\n\n- one\n\n**Mic**",
      html: "<p><strong>R&amp;D &lt;ops&gt;</strong></p><ul><li>one</li></ul><p><strong>Mic</strong></p>",
    });
  });

  it("copies part of a byline as its text, and none of one outside the selection", () => {
    const body = mount(
      row(
        `<div data-copy-author="Morgan" data-copy-time="${createdAt}"><strong>Morgan</strong><time>10:31</time></div><p>text</p>`,
      ) + authored("Mic", "<p>next</p>", "m2"),
    );
    const name = lastText(query("strong", body));
    const paragraph = lastText(query("p", body));
    expect(each(body, select(name, 2, paragraph, 4).range)).toEqual({
      text: "rgan10:31\ntext",
      markdown: "**rgan**10:31\ntext",
      html: "<p><strong>rgan</strong>10:31</p><p>text</p>",
    });
    // A triple-click ends at the next row's start, short of its byline.
    expect(
      each(
        body,
        select(paragraph, 0, query("[data-message-id='m2'] div", body), 0)
          .range,
      ),
    ).toEqual({ text: "text", markdown: "text", html: "<p>text</p>" });
  });

  it("leaves out chrome that only the prefixed user-select hides", () => {
    // The macOS system webview has no unprefixed property.
    const body = mount(authored("Robin", "<p>first</p>"));
    const styles = vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element) =>
        ({
          webkitUserSelect: (element as HTMLElement).style.userSelect,
        }) as CSSStyleDeclaration,
    );
    try {
      expect(serializeNode(body, "text")).toBe(`Robin ${time}\nfirst`);
    } finally {
      styles.mockRestore();
    }
  });

  it("copies an unselectable reaction row as its stated counts", () => {
    const body = mount(
      row(
        '<p>hello</p><div role="group" aria-label="Reactions" data-copy-text="👍 2, :party: 1"><button>👍<span>2</span></button></div>',
      ) + row("<p>next</p>", "m2"),
    );
    const { range } = select(
      query("p", body).firstChild as Text,
      0,
      lastText(query('[data-message-id="m2"] p', body)),
      4,
    );
    expect(each(body, range)).toEqual({
      text: "hello\n👍 2, :party: 1\nnext",
      markdown: "hello\n👍 2, :party: 1\nnext",
      html: "<p>hello</p><p>👍 2, :party: 1</p><p>next</p>",
    });
    // A selection that ends before the row leaves it out.
    const before = select(
      query("p", body).firstChild as Text,
      0,
      query("p", body).firstChild as Text,
      5,
    ).range;
    expect(serializeNode(body, "text", before)).toBe("hello");
  });

  it("spaces a byline's name and time, which only a flex gap separates", () => {
    const body = mount(
      row(
        '<div style="display: flex; column-gap: 8px"><strong>Morgan</strong><time>2:31 PM</time></div><p>hello</p>',
      ),
    );
    expect(each(body)).toEqual({
      text: "Morgan 2:31 PM\nhello",
      markdown: "**Morgan** 2:31 PM\nhello",
      html: "<p><strong>Morgan</strong> 2:31 PM</p><p>hello</p>",
    });
    // Without a gap, flex items abut as they render.
    query("div[style]", body).setAttribute("style", "display: flex");
    expect(serializeNode(body, "text")).toBe("Morgan2:31 PM\nhello");
  });

  it("numbers a list from its first item a selection holds, keeping a whole empty item", () => {
    const body = mount(
      row('<ol start="3">\n<li>one</li>\n<li></li>\n<li>three</li>\n</ol>'),
    );
    const message = query("[data-message-id]", body);
    // A drag from the end of the first item's text holds none of it.
    const { range } = select(
      lastText(query("li", message)),
      3,
      lastText(query("li:last-child", message)),
      5,
    );
    expect(serializeNode(message, "html", range)).toBe(
      '<ol start="4"><li></li><li>three</li></ol>',
    );
    expect(serializeNode(message, "markdown", range)).toBe("4. \n5. three");
  });

  it("serializes each element of deeply nested ordered lists once", () => {
    // The shape `"1. ".repeat(16) + "x"` renders: numbering an ordered list
    // must not serialize its items again at every level.
    const nested = `${"<ol><li>".repeat(16)}x${"</li></ol>".repeat(16)}`;
    const message = query("[data-message-id]", mount(row(nested)));
    const { range } = select(lastText(message), 0, lastText(message), 1);
    const styles = vi.spyOn(window, "getComputedStyle");
    try {
      expect(serializeNode(message, "html", range)).toBe(nested);
      expect(styles).toHaveBeenCalledTimes(
        message.querySelectorAll("*").length + 1,
      );
    } finally {
      styles.mockRestore();
    }
  });

  it("degrades unknown elements to text and escapes HTML", () => {
    const paragraph = query(
      "p",
      mount(row('<p><mark>PLUGIN</mark> &lt;tag&gt; &amp; "q"</p>')),
    );
    expect(each(paragraph)).toEqual({
      text: 'PLUGIN <tag> & "q"',
      markdown: 'PLUGIN <tag> & "q"',
      html: "<p>PLUGIN &lt;tag&gt; &amp; &quot;q&quot;</p>",
    });
  });

  it("escapes link labels read from the DOM", () => {
    const markup = '"><img src=x onerror=alert(1)>';
    const html = "&quot;&gt;&lt;img src=x onerror=alert(1)&gt;";
    const markdown = '"\\>\\<img src=x onerror=alert(1)\\>';
    const paragraph = query(
      "p",
      mount(row(`<p>${mention()} ${mention()} ${anchor(message, "docs")}</p>`)),
    );
    // Each label source: a mention name, a nameless chip's text, a link label.
    query("button", paragraph).setAttribute("data-mention-name", markup);
    const chip = query("button:nth-of-type(2)", paragraph);
    chip.removeAttribute("data-mention-name");
    lastText(chip).data = markup;
    query("a", paragraph).setAttribute("data-link-label", markup);
    expect(each(paragraph)).toEqual({
      text: `@${markup} @${markup} ${markup} (${message})`,
      markdown: `[@${markdown}](${target}) [@${markdown}](${target}) [${markdown}](${message})`,
      html: `<p><a href="${target}">@${html}</a> <a href="${target}">@${html}</a> <a href="${messageHtml}">${html}</a></p>`,
    });
  });

  it("emits unsafe or unverifiable destinations as text only", () => {
    const paragraph = query(
      "p",
      mount(
        row(
          `<p>${anchor("javascript:alert(1)", "x")} ${anchor("http://user:pw@example.com/", "plain")} ${anchor("https://user:pw@example.com/", "", "example.com")} ${anchor("buzz://channel/bad id", "#bad")} ${mention("Spoof", "nostr:npub1invalid")} ${mention("Agent", `buzz:agent-profile:${person}`)}</p>`,
        ),
      ),
    );
    expect(each(paragraph)).toEqual({
      text: "x plain example.com #bad Spoof Agent",
      markdown: "x plain example.com #bad Spoof Agent",
      html: "<p>x plain example.com #bad Spoof Agent</p>",
    });
  });
});

describe("containMessageSelection", () => {
  function layout() {
    return mount(
      `<nav><p>Sidebar</p></nav><section data-message-scroller><p>first</p><p>last</p></section><section data-message-scroller><p>thread</p></section><div contenteditable="true"><p>draft</p></div>`,
    );
  }
  function extend(
    anchor: Node,
    anchorOffset: number,
    focus: Node,
    offset: number,
  ) {
    const selection = document.getSelection();
    if (!selection) throw new Error("No selection");
    selection.setBaseAndExtent(anchor, anchorOffset, focus, offset);
    containMessageSelection();
    return selection;
  }

  it("stops a drag from a message history at that history's edges", () => {
    const body = layout();
    const timeline = query("[data-message-scroller]", body);
    const thread = query(
      "[data-message-scroller] + [data-message-scroller]",
      body,
    );
    const last = lastText(query("p:last-child", timeline));
    const up = extend(last, 2, lastText(query("nav p", body)), 3);
    expect([
      up.anchorNode,
      up.anchorOffset,
      up.focusNode,
      up.focusOffset,
    ]).toEqual([last, 2, timeline, 0]);
    expect(up.toString()).toBe("firstla");
    const first = lastText(query("p", timeline));
    const across = extend(first, 1, lastText(query("p", thread)), 2);
    expect([across.focusNode, across.focusOffset]).toEqual([
      timeline,
      timeline.childNodes.length,
    ]);
    expect(across.toString()).toBe("irstlast");
  });

  it("leaves selections inside one history, outside histories and in editors alone", () => {
    const body = layout();
    const timeline = query("[data-message-scroller]", body);
    const first = lastText(query("p", timeline));
    const last = lastText(query("p:last-child", timeline));
    const sidebar = lastText(query("nav p", body));
    const draft = lastText(query("[contenteditable] p", body));
    for (const [anchor, focus] of [
      [first, last],
      [sidebar, last],
      [draft, sidebar],
    ] satisfies [Text, Text][]) {
      const selection = extend(anchor, 1, focus, 2);
      expect([selection.anchorNode, selection.focusNode]).toEqual([
        anchor,
        focus,
      ]);
    }
  });
});

describe("useMessageSelectionCopy", () => {
  const mic = "c".repeat(64);
  function Surface() {
    useMessageSelectionCopy();
    return null;
  }
  function copy(
    node: Node,
    start: Node,
    startOffset: number,
    end: Node,
    endOffset: number,
  ) {
    select(start, startOffset, end, endOffset);
    const setData = vi.fn();
    const event = createEvent.copy(node, { clipboardData: { setData } });
    fireEvent(node, event);
    return { prevented: event.defaultPrevented, data: setData.mock.calls };
  }

  it("writes both flavors for a rendered message and nothing for an editor", () => {
    const joined = [
      { id: "design", name: "design", channelType: "forum" },
      { id: "general", name: "General", channelType: "forum" },
    ] as const;
    const view = render(
      <StrictMode>
        <Surface />
        <div data-message-id="m1">
          <MessageMarkdown
            row={{
              id: "m1",
              channelId: "general",
              authorId: mic,
              content: `Hi @Mic, see #design and https://example.com/docs, ${message} or [Alias](${message})`,
              createdAt: 1,
              mentions: [mic],
              participants: [],
              attachments: [],
              reactions: [],
              replyCount: 0,
            }}
            media={() => undefined}
            onOpenLink={() => false}
            canOpenLink={() => true}
            participantProfiles={new Map([[mic, { name: "Mic" }]])}
            directory={{
              profiles: new Map(),
              agents: [],
              channels: joined,
              named: joined,
            }}
          />
        </div>
        <div contentEditable="true" suppressContentEditableWarning>
          <p>draft @Mic</p>
        </div>
      </StrictMode>,
    );
    // The raw message link shows its channel's name but copies as its URL.
    expect(view.getByRole("link", { name: "General" }).textContent).toBe(
      "General",
    );
    const paragraph = query("[data-message-id] p", view.container);
    expect(
      copy(paragraph, paragraph, 0, paragraph, paragraph.childNodes.length),
    ).toEqual({
      prevented: true,
      data: [
        [
          "text/plain",
          `Hi @Mic, see #design and https://example.com/docs, ${message} or Alias (${message})`,
        ],
        [
          "text/html",
          `<div data-buzz-copy="timeline"><p>Hi <a href="${profileTarget(mic)}">@Mic</a>, see <a href="buzz://channel/design">#design</a> and <a href="https://example.com/docs">https://example.com/docs</a>, <a href="${messageHtml}">${messageHtml}</a> or <a href="${messageHtml}">Alias</a></p></div>`,
        ],
      ],
    });
    const draft = query("[contenteditable] p", view.container);
    expect(copy(draft, draft, 0, draft, 1)).toEqual({
      prevented: false,
      data: [],
    });
  });

  it("copies a scheme-less host as authored, in both flavors", () => {
    const view = render(
      <StrictMode>
        <Surface />
        <div data-message-id="m1">
          <MessageMarkdown
            row={{
              id: "m1",
              channelId: "general",
              authorId: mic,
              content: "see example.com/a & bun.sh now",
              createdAt: 1,
              mentions: [],
              participants: [],
              attachments: [],
              reactions: [],
              replyCount: 0,
            }}
            media={() => undefined}
            onOpenLink={() => false}
          />
        </div>
      </StrictMode>,
    );
    expect(
      view.getByRole("link", { name: "example.com/a" }).getAttribute("href"),
    ).toBe("https://example.com/a");
    const paragraph = query("[data-message-id] p", view.container);
    expect(
      copy(paragraph, paragraph, 0, paragraph, paragraph.childNodes.length),
    ).toEqual({
      prevented: true,
      data: [
        ["text/plain", "see example.com/a & bun.sh now"],
        [
          "text/html",
          '<div data-buzz-copy="timeline"><p>see example.com/a &amp; bun.sh now</p></div>',
        ],
      ],
    });
  });

  it.each([
    ["grouped", true],
    ["shown", false],
  ])(
    "copies a rendered row's %s byline as one line above its text",
    (_, stackPrevious) => {
      const rendered = () =>
        render(
          <StrictMode>
            <Surface />
            <MessageRow
              row={{
                id: "m1",
                channelId: "general",
                authorId: mic,
                content: "What next?",
                createdAt,
                mentions: [],
                participants: [],
                attachments: [],
                reactions: [],
                replyCount: 0,
              }}
              profile={{ name: "Mic" }}
              media={() => undefined}
              onOpenLink={() => false}
              day={false}
              retry={undefined}
              stackPrevious={stackPrevious}
            />
          </StrictMode>,
        );
      // From the byline's start, as a drag from beside the message selects.
      const held = (container: HTMLElement) => {
        const byline = query("[data-copy-author]", container);
        const header = byline.parentElement as HTMLElement;
        const paragraph = query("[data-message-id] p", container);
        return copy(
          paragraph,
          header,
          [...header.childNodes].indexOf(byline),
          paragraph,
          paragraph.childNodes.length,
        ).data;
      };
      const view = rendered();
      expect(held(view.container)).toEqual([
        ["text/plain", `Mic ${time}\nWhat next?`],
        [
          "text/html",
          `<div data-buzz-copy="timeline"><p><strong>Mic</strong> ${time}<br>What next?</p></div>`,
        ],
      ]);
      // The message's own text alone still copies without it.
      const paragraph = query("[data-message-id] p", view.container);
      expect(
        copy(paragraph, paragraph, 0, paragraph, paragraph.childNodes.length)
          .data[0],
      ).toEqual(["text/plain", "What next?"]);
      view.unmount();
      setClockPreference({ messageTimestamps: "hide" });
      try {
        expect(held(rendered().container)[0]).toEqual([
          "text/plain",
          "Mic\nWhat next?",
        ]);
      } finally {
        setClockPreference({ messageTimestamps: "show" });
      }
    },
  );

  it("acts before the emoji plugin for messages and leaves other selections to it", () => {
    document.addEventListener("copy", copyEmoji);
    try {
      const view = render(
        <StrictMode>
          <Surface />
        </StrictMode>,
      );
      document.body.insertAdjacentHTML(
        "beforeend",
        `${row('<p>Party <img data-copy-emoji=":party:" alt=":party:" src="x"> on</p>')}<div><p>Outside <img data-copy-emoji=":party:" alt=":party:" src="x"></p></div>`,
      );
      const inside = query("[data-message-id] p");
      expect(copy(inside, inside, 0, inside, 3)).toEqual({
        prevented: true,
        data: [
          ["text/plain", "Party :party: on"],
          [
            "text/html",
            '<div data-buzz-copy="timeline"><p>Party :party: on</p></div>',
          ],
        ],
      });
      const outside = query("body > div:not([data-message-id]) p");
      expect(copy(outside, outside, 0, outside, 2)).toEqual({
        prevented: true,
        data: [["text/plain", "Outside :party:"]],
      });
      // The listener is shared: it outlives one surface and leaves with the last.
      const second = render(<Surface />);
      view.unmount();
      expect(copy(inside, inside, 0, inside, 3).data).toHaveLength(2);
      second.unmount();
      expect(copy(inside, inside, 0, inside, 3)).toEqual({
        prevented: true,
        data: [["text/plain", "Party :party: on"]],
      });
    } finally {
      document.removeEventListener("copy", copyEmoji);
    }
  });
});
