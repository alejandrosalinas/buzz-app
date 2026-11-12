import {
  DOMSerializer,
  Fragment,
  type Node as EditorNode,
} from "prosemirror-model";
import { parseBuzzLink } from "../navigation/buzz-links";
import { profileKey, profileTarget } from "../profiles/target";
import { safeLinkUrl, scanMarkdown } from "../relay/message-content";
import { composerSchema, projectComposerDocument } from "./composer-document";
import { composerMarkdown } from "./composer-markdown";
import { messageLinkParts } from "./message-link-parts";
import {
  copyDocument,
  serializeNode,
  spoilerDelimiter,
} from "./selection-copy";

/** The identity locator a whole source is: `[@Name](nostr:npub…)`. */
export function identityLink(
  source: string,
): { pubkey: string; name: string } | undefined {
  const link = markdownLink(source);
  const pubkey = link && profileKey(link.href);
  const name = link?.label.replace(/^@/, "");
  return pubkey && name ? { pubkey, name } : undefined;
}

/** Read labels with Markdown semantics, including escapes and entities. */
function markdownLink(
  source: string,
): { href: string; label: string } | undefined {
  const { links } = scanMarkdown(source);
  const link = links.length === 1 ? links[0] : undefined;
  if (
    !link?.url ||
    link.position?.start.offset !== 0 ||
    link.position.end.offset !== source.length
  )
    return;
  let name = "";
  const pending = [...(link.children ?? [])].reverse();
  while (pending.length) {
    const node = pending.pop();
    if (node?.value) name += node.value;
    else pending.push(...(node?.children ?? []).slice().reverse());
  }
  return { href: link.url, label: name };
}

/** The anchor a token stands for: a recipient, a resource, a link the
 * normalize plugin recognised, or an identity locator. Other tokens are text. */
function tokenLink(
  node: EditorNode,
): { href: string; label: string } | undefined {
  const { source, recipient, resource } = node.attrs;
  if (node.attrs.semantic) return;
  if (recipient) {
    const href = profileTarget(recipient.pubkey);
    return href ? { href, label: source } : undefined;
  }
  if (resource) return { href: resource.uri, label: resource.label };
  let link: { href: string; label: string } | undefined;
  messageLinkParts(
    source,
    (start, end, label, href) => {
      if (start === 0 && end === source.length)
        link = { href, label: markdownLink(source)?.label ?? label };
    },
    (start, end, href) => {
      if (start === 0 && end === source.length) link ??= { href, label: href };
    },
  );
  if (link) return link;
  const identity = identityLink(source);
  const href = identity && profileTarget(identity.pubkey);
  return identity && href ? { href, label: `@${identity.name}` } : undefined;
}

// The semantic `text/html` flavor, in the shapes selection-copy.ts reads back.
// Marks without a spec (recipient, literal) are plain text.
const serializer = new DOMSerializer(
  {
    paragraph: () => ["p", 0],
    blockquote: () => ["blockquote", 0],
    code_block: (node) => [
      "pre",
      [
        "code",
        node.attrs.language ? { class: `language-${node.attrs.language}` } : {},
        `${node.textContent}\n`,
      ],
    ],
    bullet_list: () => ["ul", 0],
    ordered_list: (node) => [
      "ol",
      node.attrs.order === 1 ? {} : { start: node.attrs.order },
      0,
    ],
    list_item: () => ["li", 0],
    hard_break: () => ["br"],
    token: (node) => {
      const link = tokenLink(node);
      return link
        ? ["a", { href: link.href }, link.label]
        : ["span", node.attrs.source];
    },
  },
  {
    bold: () => ["strong", 0],
    italic: () => ["em", 0],
    strike: () => ["s", 0],
    code: () => ["code", 0],
    link: (mark) => ["a", { href: mark.attrs.href }, 0],
    spoiler: () => ["span", { "data-spoiler": "" }, 0],
  },
);

/** Identity and channel locators read as their sigil-prefixed names outside the app. */
function humanised(node: EditorNode): EditorNode {
  if (node.type.name === "token") {
    if (node.attrs.semantic)
      return composerSchema.text(node.attrs.source, node.marks);
    const link = node.attrs.recipient ? undefined : tokenLink(node);
    const buzz = link && parseBuzzLink(link.href);
    return link &&
      link.label !== link.href &&
      (profileKey(link.href) || (buzz?.format === "legacy" && !buzz.messageId))
      ? composerSchema.text(link.label, node.marks)
      : node;
  }
  return node.isLeaf
    ? node
    : node.copy(Fragment.fromArray(node.content.content.map(humanised)));
}

/** Both clipboard flavors of a composer document. `text` is the Markdown source
 * as a reader expects it; `html` carries every locator for this app's own paste
 * handler and other rich editors. */
export function composerClipboard(doc: EditorNode, document: Document) {
  const fragment = serializer.serializeFragment(doc.content, { document });
  // Spoilers have no HTML of their own: their delimiters stay visible inside
  // the mark's span, marked so this app's paste reads the mark alone.
  for (const spoiler of fragment.querySelectorAll("[data-spoiler]"))
    for (const position of ["afterbegin", "beforeend"] as const)
      spoiler.insertAdjacentHTML(position, spoilerDelimiter);
  // Line breaks inside prose are whitespace to HTML; code blocks keep theirs.
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  const breaks: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (
      (node as Text).data.includes("\n") &&
      !node.parentElement?.closest("pre")
    )
      breaks.push(node as Text);
  for (const text of breaks)
    text.replaceWith(
      ...text.data
        .split("\n")
        .flatMap((line, index) =>
          index ? [document.createElement("br"), line] : [line],
        ),
    );
  const container = document.createElement("div");
  container.appendChild(fragment);
  return {
    text: composerMarkdown(projectComposerDocument(humanised(doc)).draft),
    html: `<div data-buzz-copy="composer">${container.innerHTML}</div>`,
  };
}

/** This app's own `text/html` payload as editor content; other HTML is never
 * read. Its blocks and marks paste as they are, while anchors and line breaks
 * become source text: the host's decorations decide which links are chips, as
 * for typed source, and paragraphs keep line breaks as text. */
export function buzzCopyDocument(html: string): EditorNode | undefined {
  if (!html.includes("data-buzz-copy")) return;
  const copy = new DOMParser()
    .parseFromString(html, "text/html")
    .querySelector("[data-buzz-copy]");
  return (copy && sourced(copyDocument(copy))) ?? undefined;
}

function sourced(node: EditorNode): EditorNode | null {
  if (node.isText) return node;
  // The schema refuses empty text nodes; a leaf without text contributes none.
  if (node.isLeaf)
    return node.textContent
      ? composerSchema.text(node.textContent, node.marks)
      : null;
  return node.copy(
    Fragment.fromArray(
      node.content.content.flatMap((child) => sourced(child) ?? []),
    ),
  );
}

/** External HTML contributes web links, never Buzz identity metadata or styling. */
export function externalLinkMarkdown(
  html: string,
  plain?: string,
): string | undefined {
  if (!html) return;
  const body = new DOMParser().parseFromString(html, "text/html").body;
  // Rules and checkboxes would copy as Markdown source; they are styling here.
  for (const node of body.querySelectorAll(
    "script, style, template, iframe, object, hr, input",
  ))
    node.remove();
  // Browser text/plain can include an inline image's alt text. Preserve it as
  // literal text before stripping attributes, including inside link labels.
  for (const image of body.querySelectorAll("img"))
    image.replaceWith(
      body.ownerDocument.createTextNode(image.getAttribute("alt") ?? ""),
    );
  let linked = false;
  for (const element of body.querySelectorAll("*")) {
    const href =
      element.tagName === "A"
        ? safeLinkUrl(element.getAttribute("href") ?? "")
        : undefined;
    for (const attribute of [...element.attributes])
      element.removeAttribute(attribute.name);
    if (href && element.textContent?.trim()) {
      element.setAttribute("href", href);
      linked = true;
    }
    // Keep text and line boundaries; importing other rich formatting is separate.
    if (/^(STRONG|B|EM|I|S|DEL|CODE)$/.test(element.tagName))
      element.replaceWith(...element.childNodes);
    else if (/^(UL|OL|LI|BLOCKQUOTE|PRE|H[1-6])$/.test(element.tagName)) {
      const block = body.ownerDocument.createElement("div");
      block.append(...element.childNodes);
      element.replaceWith(block);
    }
  }
  if (!linked) return;
  // External labels must fit one Markdown paragraph. Read child boundaries
  // before collapsing whitespace so adjacent blocks and <br> do not join words.
  for (const anchor of body.querySelectorAll("a[href]")) {
    const label = body.ownerDocument.createElement("div");
    label.append(...anchor.childNodes);
    anchor.textContent = serializeNode(label, "text")
      .replace(/\s+/g, " ")
      .trim();
  }
  if (plain !== undefined) {
    // Compare the serializer's actual labels, not the source HTML's textContent:
    // serialization can lose image emoji or boundaries inside an anchor.
    const visible = body.ownerDocument.createElement("div");
    visible.innerHTML = serializeNode(body, "html");
    for (const anchor of visible.querySelectorAll("a"))
      anchor.replaceWith(...anchor.childNodes);
    const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
    if (normalize(serializeNode(visible, "text")) !== normalize(plain)) return;
  }
  return serializeNode(body, "markdown");
}
