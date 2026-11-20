// @vitest-environment jsdom
import { expect, it } from "vitest";
import {
  buzzCopyDocument,
  composerClipboard,
  pastedFiles,
} from "./composer-clipboard";
import { composerSchema } from "./composer-document";
import { spoilerDelimiter } from "./selection-copy";

const { doc, paragraph, bullet_list, list_item, token } = composerSchema.nodes;

it("copies heading levels to documents and keeps their Markdown prefix in chat", () => {
  const heading = composerSchema.nodes.heading.create(
    { level: 2 },
    composerSchema.text("Heading"),
  );
  const original = doc.create(null, heading);
  const copied = composerClipboard(original, document, "document");
  expect(copied.text).toBe("## Heading");
  expect(buzzCopyDocument(copied.html, "document")?.eq(original)).toBe(true);
  const chat = buzzCopyDocument(copied.html);
  expect(chat?.firstChild?.type.name).toBe("paragraph");
  expect(chat?.textContent).toBe(copied.text);
});

it("copies aligned document tables with exact Markdown and pastes source in chat", () => {
  const source = "| Value |\n| ---: |\n| `a\\|b` |";
  const table = composerSchema.nodes.markdown_table.create({ source });
  const original = doc.create(null, table);
  const copied = composerClipboard(original, document, "document");
  expect(copied.text).toBe(source);
  expect(buzzCopyDocument(copied.html, "document")?.eq(original)).toBe(true);
  const chat = buzzCopyDocument(copied.html);
  expect(chat?.firstChild?.type).toBe(paragraph);
  expect(chat?.textContent).toBe(source);
});

it("copies plain text and unlinked tokens as text and round-trips clipboard HTML", () => {
  const source = "<img src=x onerror=alert(1)> & text";
  const copied = composerClipboard(
    doc.create(
      null,
      paragraph.create(null, [
        composerSchema.text("before "),
        token.create({ source }),
        composerSchema.text(" after"),
      ]),
    ),
    document,
  );
  const html = new DOMParser().parseFromString(copied.html, "text/html");
  expect(html.body.textContent).toBe(`before ${source} after`);
  expect(html.querySelector("img")).toBeNull();
  expect(copied.text).toBe(`before ${source} after`);
  expect(buzzCopyDocument(copied.html)?.toJSON()).toEqual({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: `before ${source} after` }],
      },
    ],
  });
});

it("reads its own blocks and marks back as nodes, with anchors and breaks as text", () => {
  const bold = [composerSchema.marks.bold.create()];
  const copied = composerClipboard(
    doc.create(null, [
      paragraph.create(null, [
        composerSchema.text("a"),
        composerSchema.text("\nb", bold),
      ]),
      bullet_list.create(
        null,
        list_item.create(
          null,
          paragraph.create(null, [
            composerSchema.text("see "),
            token.create({ source: "[docs](https://example.com/)" }),
          ]),
        ),
      ),
    ]),
    document,
  );
  expect(copied.html).toBe(
    '<div data-buzz-copy="composer"><p>a<strong><br>b</strong></p><ul><li><p>see <a href="https://example.com/">docs</a></p></li></ul></div>',
  );
  expect(buzzCopyDocument(copied.html)?.toJSON()).toEqual({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "\nb", marks: [{ type: "bold" }] },
        ],
      },
      {
        type: "bullet_list",
        attrs: { spread: false },
        content: [
          {
            type: "list_item",
            attrs: { spread: false },
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "see [docs](https://example.com/)" },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  expect(buzzCopyDocument("<p>other</p>")).toBeUndefined();
});

it("keeps a spoiler a mark in its HTML and reads it back", () => {
  const copied = composerClipboard(
    doc.create(
      null,
      paragraph.create(null, [
        composerSchema.text("a "),
        composerSchema.text("secret", [composerSchema.marks.spoiler.create()]),
      ]),
    ),
    document,
  );
  expect(copied).toEqual({
    text: "a ||secret||",
    html: `<div data-buzz-copy="composer"><p>a <span data-spoiler="">${spoilerDelimiter}secret${spoilerDelimiter}</span></p></div>`,
  });
  expect(buzzCopyDocument(copied.html)?.toJSON()).toEqual({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "a " },
          { type: "text", text: "secret", marks: [{ type: "spoiler" }] },
        ],
      },
    ],
  });
});

it("labels a linked spoiler without its delimiters", () => {
  const href = "https://example.com/";
  const copied = composerClipboard(
    doc.create(
      null,
      paragraph.create(null, [
        composerSchema.text("a "),
        composerSchema.text("secret", [
          composerSchema.marks.link.create({ href }),
          composerSchema.marks.spoiler.create(),
        ]),
      ]),
    ),
    document,
  );
  expect(copied.html).toBe(
    `<div data-buzz-copy="composer"><p>a <a href="${href}"><span data-spoiler="">${spoilerDelimiter}secret${spoilerDelimiter}</span></a></p></div>`,
  );
  // The link's label is the spoiler's content; the mark itself does not
  // survive the anchor, as before.
  expect(buzzCopyDocument(copied.html)?.toJSON()).toEqual({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: `a [secret](${href})` }],
      },
    ],
  });
});

it("reads crafted HTML whose anchors have no text as an empty paste, not an error", () => {
  expect(
    buzzCopyDocument(
      '<div data-buzz-copy="composer"><a href="javascript:x"></a><a href="https://example.com/"></a></div>',
    )?.toJSON(),
  ).toEqual({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "https://example.com/" }],
      },
    ],
  });
});

it("pastes text whose picture rides beside it, and attaches every other file", () => {
  const paste = (
    flavors: { html?: string | undefined; plain?: string | undefined },
    ...files: File[]
  ) =>
    pastedFiles({
      items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
      getData: (type: string) =>
        (type === "text/html" ? flavors.html : flavors.plain) ?? "",
    } as unknown as DataTransfer);
  const picture = new File(["png"], "image.png", { type: "image/png" });
  const pdf = new File(["pdf"], "notes.pdf", { type: "application/pdf" });
  // Copied office cells: their text, their HTML and a picture of them.
  const cells = { html: "<table><tr><td>Q3</td></tr></table>", plain: "Q3" };
  expect(paste(cells, picture)).toEqual([]);
  // Without plain text no text path can insert, so the picture is the paste.
  for (const plain of [undefined, "", " \n"])
    expect(paste({ ...cells, plain }, picture)).toEqual([picture]);
  expect(
    paste({ html: "<span><style>.x{}</style></span>", plain: "" }, picture),
  ).toEqual([picture]);
  // A screenshot, a copied image and copied files stay attachments.
  expect(paste({ plain: "image.png" }, picture)).toEqual([picture]);
  expect(
    paste(
      { html: '<img src="https://example.com/a.png">', plain: "a" },
      picture,
    ),
  ).toEqual([picture]);
  expect(paste({ html: "<p>notes.pdf</p>", plain: "notes.pdf" }, pdf)).toEqual([
    pdf,
  ]);
  expect(paste(cells, picture, pdf)).toEqual([picture, pdf]);
  expect(paste(cells)).toEqual([]);
  expect(pastedFiles(null)).toEqual([]);
});

it("keeps default chat clipboard output when document list metadata is present", () => {
  const tree = doc.create(null, [
    paragraph.create(null, [
      composerSchema.text("First"),
      composerSchema.nodes.hard_break.create(),
      composerSchema.text("Second"),
    ]),
    bullet_list.create({ spread: true }, [
      list_item.create(
        null,
        paragraph.create(null, composerSchema.text("One")),
      ),
      list_item.create(
        null,
        paragraph.create(null, composerSchema.text("Two")),
      ),
    ]),
  ]);
  const chat = composerClipboard(tree, document);
  expect(chat.text).toBe("First\nSecond\n\n- One\n- Two");
  expect(chat.html).toBe(
    '<div data-buzz-copy="composer"><p>First<br>Second</p><ul><li><p>One</p></li><li><p>Two</p></li></ul></div>',
  );
  const copied = composerClipboard(tree, document, "document");
  const imported = buzzCopyDocument(copied.html);
  expect(imported?.lastChild?.attrs.spread).toBe(false);
});

it.each(["chat", "document"] as const)(
  "copies namesake chips as authored text in %s mode",
  (mode) => {
    const chips = ["a", "b"].flatMap((key, index) => [
      ...(index ? [composerSchema.text(" ")] : []),
      token.create({
        source: "@Honey",
        recipient: { pubkey: key.repeat(64), name: "Honey" },
      }),
    ]);
    const copied = composerClipboard(
      doc.create(null, paragraph.create(null, chips)),
      document,
      mode,
    );
    expect(copied.text).toBe("@Honey @Honey");
    // HTML retains identity destinations for paste; plain text has no send-only keys.
    expect(copied.html.match(/<a /g)).toHaveLength(2);
  },
);
