import {
  Fragment,
  Schema,
  Slice,
  type Node as EditorNode,
} from "prosemirror-model";
import { bulletList, orderedList, listItem } from "prosemirror-schema-list";
import { composerLinkUrl } from "./composer-link";
import { scanMarkdown } from "../relay/message-content";
import type {
  MentionDraft,
  DraftRecipient,
  PendingMention,
} from "./mention-draft";
import type { ComposerResource } from "../conversation/contracts";
import {
  composerToken,
  composerTokenText,
  type ComposerToken,
} from "./composer-token";

/** The document owns editable marks and exact source tokens. Unimplemented
 * Markdown stays source text, never round-trips through an HTML serializer. */
export const composerSchema = new Schema<
  | "doc"
  | "paragraph"
  | "blockquote"
  | "code_block"
  | "bullet_list"
  | "ordered_list"
  | "list_item"
  | "text"
  | "hard_break"
  | "token",
  | "recipient"
  | "literal"
  | "link"
  | "code"
  | "spoiler"
  | "bold"
  | "italic"
  | "strike"
>({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      whitespace: "pre",
      toDOM: () => ["p", 0],
      parseDOM: [{ tag: "p" }, { tag: "div" }],
    },
    blockquote: {
      group: "block",
      content: "block+",
      defining: true,
      toDOM: () => ["blockquote", 0],
      parseDOM: [{ tag: "blockquote" }],
    },
    code_block: {
      group: "block",
      content: "text*",
      marks: "recipient",
      code: true,
      defining: true,
      // The info string of a typed fence. Serialization emits it after the
      // opening fence; toolbar-created blocks have none. A corrupted persisted
      // draft fails doc.check() here instead of reaching the DOM attribute.
      attrs: { language: { default: null, validate: "string|null" } },
      toDOM: (node) => [
        "pre",
        { spellcheck: "false", "data-language": node.attrs.language },
        ["code", 0],
      ],
      parseDOM: [
        {
          tag: "pre",
          preserveWhitespace: "full",
          getAttrs: (element) => ({
            language: element.getAttribute("data-language"),
          }),
        },
      ],
    },
    bullet_list: { ...bulletList, group: "block", content: "list_item+" },
    ordered_list: { ...orderedList, group: "block", content: "list_item+" },
    list_item: { ...listItem, content: "paragraph block*" },
    text: { group: "inline" },
    hard_break: {
      group: "inline",
      inline: true,
      selectable: false,
      leafText: () => "\n",
      toDOM: () => ["br"],
      parseDOM: [{ tag: "br" }],
    },
    token: {
      group: "inline",
      inline: true,
      atom: true,
      selectable: false,
      attrs: {
        source: {},
        recipient: { default: null },
        /** Host-owned `{ uri, label }`; valid only while `source` is its link. */
        resource: { default: null },
        /** A `ComposerToken` whose label is `source`; never a recipient. */
        semantic: { default: null },
        /** `{ id, name }` while the host resolves a mention Space committed
         * before the chooser could decide. Never persists past the editor. */
        pending: { default: null },
        editAsText: { default: false },
      },
      leafText: (node) => node.attrs.source,
      toDOM: (node) => [
        "span",
        { "data-source": node.attrs.source, contenteditable: "false" },
        node.attrs.source,
      ],
      parseDOM: [
        {
          tag: "span[data-source]",
          getAttrs: (element) => ({
            source: element.getAttribute("data-source"),
          }),
        },
      ],
    },
  },
  marks: {
    recipient: {
      attrs: { pubkey: {}, name: {} },
      inclusive: false,
      toDOM: () => ["span", 0],
    },
    literal: { inclusive: false, toDOM: () => ["span", 0] },
    link: {
      attrs: {
        href: {
          validate: (value) => {
            if (typeof value !== "string" || !composerLinkUrl(value))
              throw new RangeError("Invalid link");
          },
        },
      },
      inclusive: false,
      toDOM: (mark) => ["a", { href: composerLinkUrl(mark.attrs.href) }, 0],
      parseDOM: [
        {
          tag: "a[href]",
          getAttrs: (element) => {
            const href = composerLinkUrl(element.getAttribute("href") ?? "");
            return href ? { href } : false;
          },
        },
      ],
    },
    code: {
      code: true,
      inclusive: false,
      excludes: "bold italic strike link",
      toDOM: () => ["code", { spellcheck: "false" }, 0],
      parseDOM: [{ tag: "code" }],
    },
    spoiler: {
      toDOM: () => ["span", { "data-spoiler": "" }, 0],
      parseDOM: [{ tag: "span[data-spoiler]" }],
    },
    bold: {
      toDOM: () => ["strong", 0],
      parseDOM: [{ tag: "strong" }, { tag: "b" }],
    },
    italic: { toDOM: () => ["em", 0], parseDOM: [{ tag: "em" }, { tag: "i" }] },
    strike: {
      toDOM: () => ["s", 0],
      parseDOM: [{ tag: "s" }, { tag: "del" }, { tag: "strike" }],
    },
  },
});

export type SourceToken = { start: number; end: number; editAsText?: boolean };
export type SourceRange = { start: number; end: number };

/** Source ranges the editor must not format: existing Markdown code, images,
 * definitions and HTML stay literal text. */
export function markdownRanges(text: string) {
  const { tree, tooDeep } = scanMarkdown(text);
  const literal: SourceRange[] = [];
  if (tooDeep) return { literal: [{ start: 0, end: text.length }] };
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    const start = node.position?.start.offset,
      end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    if (
      [
        "code",
        "inlineCode",
        "image",
        "imageReference",
        "definition",
        "html",
      ].includes(node.type)
    ) {
      literal.push({ start, end });
      continue;
    }
    pending.push(...(node.children ?? []));
  }
  return { literal };
}

/** Draft text stays the editing/completion coordinate space. Formatting metadata
 * is local authoring state; message publication serializes it separately. */
export function readComposerDocument(
  draft: MentionDraft,
  tokens: readonly SourceToken[],
) {
  const nodes: EditorNode[] = [];
  const restored = readComposerSnapshot(draft.document);
  if (restored) {
    // Mention provenance is explicit metadata, never inferred from matching text.
    const source = projectComposerDocument(restored);
    const content = (node: EditorNode, position: number): EditorNode => {
      const start = source.source(position),
        end = source.source(position + node.nodeSize);
      const valid = (identity: { pubkey: string; name: string }) =>
        draft.recipients.some(
          (item) =>
            item.pubkey === identity.pubkey &&
            item.name === identity.name &&
            item.start <= start &&
            item.end >= end,
        );
      const marks = node.marks.filter(
        (mark) =>
          mark.type !== composerSchema.marks.recipient ||
          valid(mark.attrs as { pubkey: string; name: string }),
      );
      if (node.isText) return node.mark(marks);
      if (node.type.name === "token") {
        // The resolver died with the previous editor; the typed text stands.
        if (node.attrs.pending)
          return composerSchema.text(node.attrs.source, marks);
        const resource = composerResource(node.attrs.resource);
        const semantic = composerToken(node.attrs.semantic);
        return node.type.create(
          {
            ...node.attrs,
            semantic:
              semantic && composerTokenText(semantic) === node.attrs.source
                ? semantic
                : null,
            recipient:
              node.attrs.recipient && valid(node.attrs.recipient)
                ? node.attrs.recipient
                : null,
            resource:
              resource &&
              resource.source === node.attrs.source &&
              !resourceBlockingMarks().some((type) => type.isInSet(marks))
                ? resource.resource
                : null,
          },
          null,
          marks,
        );
      }
      const children: EditorNode[] = [];
      node.forEach((child, offset) => {
        children.push(content(child, position + 1 + offset));
      });
      return node.type.create(node.attrs, children, marks);
    };
    return demoteBrokenResources(content(restored, -1));
  }
  const points = [
    ...new Set([
      0,
      draft.text.length,
      ...tokens.flatMap((token) => [token.start, token.end]),
    ]),
  ].sort((a, b) => a - b);
  let offset = 0;
  while (offset < draft.text.length) {
    const token = tokens.find((token) => token.start === offset);
    if (token) {
      nodes.push(
        composerSchema.nodes.token.create({
          source: draft.text.slice(token.start, token.end),
          editAsText: !!token.editAsText,
          recipient:
            draft.recipients.find(
              (item) => item.start === token.start && item.end === token.end,
            ) ?? null,
        }),
      );
      offset = token.end;
    } else {
      const end = points.find((point) => point > offset) ?? draft.text.length;
      nodes.push(composerSchema.text(draft.text.slice(offset, end)));
      offset = end;
    }
  }
  return composerSchema.nodes.doc.create(
    null,
    composerSchema.nodes.paragraph.create(null, nodes),
  );
}

/** Resource tokens whose source no longer parses as exactly their own link in
 * the surrounding Markdown (e.g. after `!`, inside backticks, or under a mark). */
export function brokenResources(
  doc: EditorNode,
  source = projectComposerDocument(doc),
) {
  const resources = source.tokens.filter((token) => token.node.attrs.resource);
  if (!resources.length) return [];
  const { links, tooDeep } = scanMarkdown(
    composerMarkdownContext(doc, source).text,
  );
  return resources.filter(
    (token) =>
      tooDeep ||
      resourceBlockingMarks().some((type) => type.isInSet(token.node.marks)) ||
      !links.some(
        (link) =>
          link.type === "link" &&
          link.position?.start.offset === token.start &&
          link.position.end.offset === token.end,
      ),
  );
}

/** Like mention provenance, a resource that would not be sent as its link
 * becomes the ordinary source text that will actually be sent. */
export function demoteBrokenResources(doc: EditorNode) {
  for (const token of brokenResources(doc).reverse())
    doc = doc.replace(
      token.from,
      token.to,
      new Slice(
        Fragment.from(
          composerSchema.text(token.node.attrs.source, token.node.marks),
        ),
        0,
        0,
      ),
    );
  return doc;
}

/** Marks under which a resource token's source is not sent as its link. */
export const resourceBlockingMarks = () => {
  const { code, link, literal, recipient } = composerSchema.marks;
  return [code, link, literal, recipient];
};

/** A resource is sent as exactly `source`: one inline Markdown link whose text is
 * the escaped, single-line label (at most 120 code points) and whose destination
 * is the unchanged, navigation-safe URI. Anything else is rejected. */
export function composerResource(
  value: unknown,
): { resource: ComposerResource; source: string } | undefined {
  if (!value || typeof value !== "object") return;
  const { uri, label } = value as Record<string, unknown>;
  if (typeof uri !== "string" || typeof label !== "string") return;
  const text = [
    ...label.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069\s]+/gu, " ").trim(),
  ]
    .slice(0, 120)
    .join("")
    .trimEnd();
  if (!text || composerLinkUrl(uri) !== uri) return;
  const source = `[${text.replace(/[\\`[\]*_~<>&|]/g, "\\$&")}](${uri})`;
  const { tree } = scanMarkdown(source);
  const link = tree.children?.length === 1 ? tree.children[0] : undefined;
  if (
    link?.children?.length !== 1 ||
    link.children[0]?.type !== "link" ||
    link.children[0].url !== uri ||
    link.children[0].position?.end.offset !== source.length
  )
    return;
  return { resource: { uri, label: text }, source };
}

/** Semantic chips and their text spans. Host-internal: `MentionDraft`, which
 * plugins see, never carries them. */
export function composerChips(doc: EditorNode | undefined) {
  const chips: Readonly<{
    token: ComposerToken;
    start: number;
    end: number;
  }>[] = [];
  for (const { node, start, end } of doc
    ? projectComposerDocument(doc).tokens
    : []) {
    const token = composerToken(node.attrs.semantic);
    if (token) chips.push({ token, start, end });
  }
  return chips;
}

/** Document positions, editable text offsets, and serialized Markdown offsets
 * are distinct. No generated Markdown delimiter enters this map. */
export function projectComposerDocument(doc: EditorNode) {
  // A node is immutable, so one keystroke's several readers share a projection.
  const cached = projections.get(doc);
  if (cached) return cached;
  const projection = project(doc);
  projections.set(doc, projection);
  return projection;
}
const projections = new WeakMap<EditorNode, ReturnType<typeof project>>();

function project(doc: EditorNode) {
  let text = "";
  const positions = new Array<number>(doc.content.size + 1).fill(0);
  const recipients: DraftRecipient[] = [];
  const pending: PendingMention[] = [];
  const carets: number[] = [];
  const blocks: { from: number; to: number; start: number; code: boolean }[] =
    [];
  const tokens: (SourceToken & {
    from: number;
    to: number;
    node: EditorNode;
  })[] = [];
  doc.descendants((node, position) => {
    if (node.isTextblock) {
      if (blocks.length) text += "\n";
      positions[position] = text.length;
      positions[position + 1] = text.length;
      carets.push(position + 1);
      blocks.push({
        from: position + 1,
        to: position + node.nodeSize - 1,
        start: text.length,
        code: !!node.type.spec.code,
      });
      return;
    }
    if (!node.isInline) return;
    const start = text.length;
    const content: string = node.isText
      ? node.textContent
      : node.type.name === "hard_break"
        ? "\n"
        : node.attrs.source;
    positions[position] = start;
    text += content;
    if (node.isText)
      for (let i = 0; i <= content.length; i++) {
        positions[position + i] = start + i;
        carets.push(position + i);
      }
    else {
      positions[position + node.nodeSize] = text.length;
      carets.push(position, position + node.nodeSize);
    }
    const identity = composerSchema.marks.recipient.isInSet(node.marks);
    if (identity) {
      const previous = recipients.at(-1);
      if (previous?.end === start && previous.pubkey === identity.attrs.pubkey)
        recipients[recipients.length - 1] = { ...previous, end: text.length };
      else
        recipients.push({
          pubkey: identity.attrs.pubkey,
          name: identity.attrs.name,
          start,
          end: text.length,
        });
    }
    if (node.type.name === "token") {
      tokens.push({
        start,
        end: text.length,
        from: position,
        to: position + node.nodeSize,
        node,
        editAsText: node.attrs.editAsText,
      });
      if (node.attrs.recipient)
        recipients.push({ ...node.attrs.recipient, start, end: text.length });
      if (node.attrs.pending)
        pending.push({ ...node.attrs.pending, start, end: text.length });
    }
  });
  for (let i = 1; i < positions.length; i++)
    positions[i] = Math.max(positions[i] ?? 0, positions[i - 1] ?? 0);
  positions[positions.length - 1] = text.length;
  return {
    draft: {
      text,
      recipients,
      ...(pending.length ? { pending } : {}),
      document: { version: 1, content: doc.toJSON() },
    } satisfies MentionDraft,
    positions,
    tokens,
    blocks,
    source(position: number) {
      return (
        positions[Math.max(0, Math.min(position, positions.length - 1))] ??
        text.length
      );
    },
    position(offset: number, bias = 1) {
      offset = Math.max(0, Math.min(offset, text.length));
      let closest = carets[0] ?? 1;
      for (const position of carets) {
        const value = positions[position] ?? text.length;
        if (value === offset) return position;
        if (value > offset) return bias < 0 ? closest : position;
        closest = position;
      }
      return closest;
    },
  };
}

/** Already-rich content is not Markdown syntax. Preserve UTF-16 offsets and
 * line breaks so raw prose can use the parser without borrowing rich delimiters. */
export function composerMarkdownContext(
  doc: EditorNode,
  source = projectComposerDocument(doc),
) {
  let text = source.draft.text;
  const protectedRanges: SourceRange[] = [];
  const mask = (from: number, to: number) => {
    const start = source.source(from),
      end = source.source(to);
    protectedRanges.push({ start, end });
    text =
      text.slice(0, start) +
      text.slice(start, end).replace(/[^\r\n]/g, "x") +
      text.slice(end);
  };
  doc.descendants((node, position) => {
    if (node.isTextblock && node.type.spec.code) {
      mask(position + 1, position + node.nodeSize - 1);
      return false;
    }
    if (
      node.isInline &&
      (["code", "link", "literal"] as const).some((name) =>
        composerSchema.marks[name].isInSet(node.marks),
      )
    )
      mask(position, position + node.nodeSize);
  });
  return { text, protected: protectedRanges };
}

/** Local persistence envelope. The schema, not parallel mark ranges, owns shape. */
export function readComposerSnapshot(value: unknown): EditorNode | undefined {
  // Snapshots are never mutated, and validation plus parsing is O(draft).
  if (typeof value !== "object" || !value) return read(value);
  if (!snapshots.has(value)) snapshots.set(value, read(value));
  return snapshots.get(value);
}
const snapshots = new WeakMap<object, EditorNode | undefined>();

function read(value: unknown): EditorNode | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("content" in value)
  )
    return;
  const pending = [{ node: value.content, depth: 0 }];
  let count = 0,
    length = 0;
  while (pending.length) {
    const item = pending.pop();
    if (!item) break;
    if (
      ++count > 32001 ||
      item.depth > 100 ||
      !item.node ||
      typeof item.node !== "object"
    )
      return;
    const node = item.node as Record<string, unknown>;
    if (typeof node.type !== "string" || !composerSchema.nodes[node.type])
      return;
    if (node.type === "text") {
      if (typeof node.text !== "string") return;
      length += node.text.length;
    }
    if (node.type === "token") {
      if (
        !node.attrs ||
        typeof node.attrs !== "object" ||
        !("source" in node.attrs) ||
        typeof node.attrs.source !== "string"
      )
        return;
      length += node.attrs.source.length;
      if ("semantic" in node.attrs && node.attrs.semantic !== null) {
        const token = composerToken(node.attrs.semantic);
        if (
          !token ||
          composerTokenText(token) !== node.attrs.source ||
          ("recipient" in node.attrs && node.attrs.recipient) ||
          ("resource" in node.attrs && node.attrs.resource) ||
          ("pending" in node.attrs && node.attrs.pending)
        )
          return;
      }
    }
    if (length > 16000) return;
    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) return;
      for (const child of node.content)
        pending.push({ node: child, depth: item.depth + 1 });
    }
  }
  try {
    const doc = composerSchema.nodeFromJSON(value.content);
    if (doc.type !== composerSchema.nodes.doc) return;
    doc.check();
    return doc;
  } catch {
    return;
  }
}
