import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import type { Mark, Node as EditorNode } from "prosemirror-model";
import type { RootContent } from "mdast";
import {
  composerSchema as schema,
  projectComposerDocument,
} from "./composer-document";
import { composerLinkUrl } from "./composer-link";
import { mentionDraft, type MentionDraft } from "./mention-draft";
import { composerMarkdown } from "./composer-markdown";
import { MAX_MARKDOWN_LENGTH, scanMarkdown } from "../relay/message-content";
import { fitsDocumentRenderBudget } from "../markdown/document-profile";

/** Use the existing editor schema; unsupported syntax remains editable source. */
export function documentEditorDraft(markdown: string) {
  if (markdown.length > MAX_MARKDOWN_LENGTH) return mentionDraft(markdown);
  const scan = scanMarkdown(markdown);
  const { tooDeep } = scan;
  if (tooDeep) return mentionDraft(markdown);
  const tree = fromMarkdown(markdown, {
    extensions: [gfmStrikethrough(), gfmTable()],
    mdastExtensions: [gfmStrikethroughFromMarkdown(), gfmTableFromMarkdown()],
  });
  const raw = (node: RootContent) =>
    markdown.slice(
      node.position?.start.offset ?? 0,
      node.position?.end.offset ?? 0,
    );
  const text = (value: string, marks: readonly Mark[] = []) =>
    value ? [schema.text(value, marks)] : [];
  // Link labels serialize as escaped text. Keep the whole source link when a
  // label needs syntax that the link mark cannot represent (code or images).
  const linkLabel = (node: RootContent): boolean =>
    node.type === "text" ||
    node.type === "break" ||
    ((node.type === "strong" ||
      node.type === "emphasis" ||
      node.type === "delete") &&
      node.children.every(linkLabel));
  const inline = (
    node: RootContent,
    marks: readonly Mark[] = [],
  ): EditorNode[] => {
    if (node.type === "text")
      return text(
        node.value.replace(/\n/g, " "),
        raw(node) === node.value
          ? marks
          : [...marks, schema.marks.literal.create()],
      );
    if (node.type === "inlineCode")
      return marks.length
        ? text(raw(node), marks)
        : text(node.value, [schema.marks.code.create()]);
    if (node.type === "break")
      return [schema.nodes.hard_break.create(null, null, marks)];
    const mark =
      node.type === "strong"
        ? schema.marks.bold
        : node.type === "emphasis"
          ? schema.marks.italic
          : node.type === "delete"
            ? schema.marks.strike
            : undefined;
    if (mark && "children" in node)
      return node.children.flatMap((child) =>
        inline(child, [...marks, mark.create()]),
      );
    if (
      node.type === "link" &&
      composerLinkUrl(node.url) &&
      node.title == null &&
      node.children.length > 0 &&
      node.children.every(linkLabel)
    )
      return node.children.flatMap((child) =>
        inline(child, [...marks, schema.marks.link.create({ href: node.url })]),
      );
    return text(raw(node), marks);
  };
  // A descendant's source slice still includes continuation-line quote/list
  // prefixes. Fall back at the root container so serialization cannot add them
  // a second time. Fully supported containers keep their rich structure.
  const supportedBlock = (node: RootContent): boolean =>
    ((node.type === "paragraph" || node.type === "heading") &&
      node.children
        .flatMap((child) => inline(child))
        .every(
          (child) => !child.isText || !child.textContent.includes("\n"),
        )) ||
    (node.type === "code" && node.meta == null) ||
    (node.type === "blockquote" && node.children.every(supportedBlock)) ||
    (node.type === "list" &&
      node.children.every(
        (item) =>
          item.checked == null &&
          (item.children.length === 0 ||
            item.children[0]?.type === "paragraph") &&
          item.children.every(supportedBlock),
      ) &&
      !/^\s*[-*+]\s+\[[ xX]\]/m.test(raw(node)));
  const block = (node: RootContent): EditorNode => {
    if (node.type === "heading")
      return schema.nodes.heading.create(
        { level: node.depth },
        node.children.flatMap((child) => inline(child)),
      );
    if (node.type === "paragraph")
      return schema.nodes.paragraph.create(
        null,
        node.children.flatMap((child) => inline(child)),
      );
    if (node.type === "code")
      return schema.nodes.code_block.create(
        { language: node.lang ?? null },
        text(node.value),
      );
    if (node.type === "blockquote")
      return schema.nodes.blockquote.create(
        null,
        node.children.length
          ? node.children.map(block)
          : schema.nodes.paragraph.create(),
      );
    if (node.type === "list")
      return schema.nodes[node.ordered ? "ordered_list" : "bullet_list"].create(
        {
          ...(node.ordered ? { order: node.start ?? 1 } : {}),
          spread: node.spread,
        },
        node.children.map((item) =>
          schema.nodes.list_item.create(
            { spread: item.spread },
            item.children.length
              ? item.children.map(block)
              : schema.nodes.paragraph.create(),
          ),
        ),
      );
    return schema.nodes.paragraph.create(null, text(raw(node)));
  };
  const withinTableBudget =
    !tree.children.some((node) => node.type === "table") ||
    fitsDocumentRenderBudget(markdown);
  const blocks = tree.children.map((node) => {
    if (supportedBlock(node)) return block(node);
    const source = raw(node);
    if (node.type === "table" && withinTableBudget) {
      const columns = node.children[0]?.children.length ?? 0;
      // GFM pads short rows and hides extra cells. Keep excessive expansion
      // and any cells the grid would hide visible in the source fallback.
      if (
        columns * node.children.length <= source.length &&
        node.children.every((row) => row.children.length <= columns)
      )
        return schema.nodes.markdown_table.create({ source });
    }
    return schema.nodes.paragraph.create(null, text(source));
  });
  const doc = schema.nodes.doc.create(
    null,
    blocks.length ? blocks : schema.nodes.paragraph.create(),
  );
  doc.check();
  return projectComposerDocument(doc).draft;
}

/** CommonMark document structure; bounded-parser fallbacks stay exact source. */
export function documentEditorMarkdown(draft: MentionDraft) {
  return composerMarkdown(draft, {
    mode: draft.document ? "document" : "chat",
  });
}
