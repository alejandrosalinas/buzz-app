import { useEffect } from "react";
import {
  DOMParser as EditorDOMParser,
  Fragment,
  type Node as EditorNode,
} from "prosemirror-model";
import { parseBuzzLink } from "../navigation/buzz-links";
import { profileKey } from "../profiles/target";
import { safeLinkUrl } from "../relay/message-content";
import { composerSchema, projectComposerDocument } from "./composer-document";
import { composerMarkdown } from "./composer-markdown";

/** `text` reads well outside the app; `markdown` keeps identity locators and
 * the block syntax the composer understands; `html` is the semantic `text/html`
 * flavor. */
export type CopyFormat = "text" | "markdown" | "html";

/** A spoiler's `||` in the `text/html` flavor: visible text to other
 * consumers, marked so `copyDocument` drops it and authored pipes stay. */
export const spoilerDelimiter = '<span data-spoiler-delimiter="">||</span>';

const wrappers = "[data-profile-target], a, [data-spoiler]";

/** Serialize every range of a live selection; ranges join like lines. */
export function serializeSelection(
  selection: Selection,
  format: CopyFormat,
): string {
  const values: string[] = [];
  for (let index = 0; index < selection.rangeCount; index++) {
    const range = selection.getRangeAt(index);
    if (!range.collapsed) {
      const ancestor = range.commonAncestorContainer;
      // A whole chip can have both endpoints inside its one label text node,
      // and a word inside a spoiler is still masked content; the outermost
      // such wrapper keeps a chip inside a spoiler as the spoiler's.
      const element = elementOf(ancestor);
      let wrapper: Element | null = null;
      for (
        let outer = element?.closest(wrappers) ?? null;
        outer;
        outer = outer.parentElement?.closest(wrappers) ?? null
      )
        wrapper = outer;
      // TR/TD/TBODY fragments lose their markup when parsed outside a table.
      const root = wrapper ?? element?.closest("table") ?? ancestor;
      values.push(serializeNode(root, format, range));
    }
  }
  return values.join("\n");
}

/** Walk a DOM tree, clipped to `range` when given. The DOM is untrusted data:
 * identity travels only on validated `nostr:`, `buzz:` and credential-free
 * `http:` and `https:` destinations, and only when a chip's whole text is selected.
 * Unknown elements degrade to their text. */
export function serializeNode(
  node: Node,
  format: CopyFormat,
  range?: Range,
): string {
  if (format === "markdown") return markdown(node, range);
  return serialize(node, format, range);
}

function serialize(
  node: Node,
  format: CopyFormat,
  range?: Range,
  inList = false,
): string {
  if (range && !range.intersectsNode(node)) return "";
  if (node.nodeType === Node.TEXT_NODE)
    return text(clip(node as Text, range), format);
  if (!(node instanceof Element)) return children(node, format, range);
  if (unselectable(node)) return "";
  // This module's own delimiter markup; the spoiler branch writes it afresh.
  if (node.hasAttribute("data-spoiler-delimiter")) return "";
  // SVG tag names keep their case.
  const tag = node.tagName.toUpperCase();
  const tokenSource = tag === "SPAN" ? node.getAttribute("data-source") : null;
  if (tokenSource !== null && whole(node, range))
    return format === "html"
      ? sourceTokenHtml(tokenSource)
      : text(tokenSource, format);
  if (tag === "BR") return format === "html" ? "<br>" : "\n";
  if (tag === "IMG")
    return text(node.getAttribute("data-copy-emoji") ?? "", format);
  // Blocks the composer has no node for stay semantic HTML for other
  // consumers; `copyDocument` reads them as Markdown source. A rule and a
  // task's state are content, so plain text keeps them too; a heading's
  // marker is formatting.
  if (tag === "HR") return format === "html" ? "<hr>" : "---";
  if (tag === "INPUT") {
    if (node.getAttribute("type") !== "checkbox") return "";
    const checked = (node as HTMLInputElement).checked;
    return format === "html"
      ? `<input type="checkbox"${checked ? " checked" : ""}>`
      : `[${checked ? "x" : " "}]`;
  }
  // A plugin-presented code block copies as its whole source, not its drawing,
  // with the terminator a rendered PRE's code carries.
  const source = node.getAttribute("data-copy-code");
  if (source !== null) {
    if (!holds(node, range)) return "";
    const code = text(`${source}\n`, format);
    return format === "text"
      ? code
      : fence(node.getAttribute("data-copy-language") ?? "", code);
  }
  // Element children that copy as something, so a list can tell which items
  // it keeps without serializing them again.
  const kept: Element[] = [];
  const inner = children(node, format, range, kept);
  // A triple-click ends its range at the next block's start, often past an
  // empty reaction row, and a drag can start at a block's end. An empty layout
  // container, or a block holding none of the selection, copies as nothing,
  // not as an empty line, item or code block.
  if (
    !inner &&
    (/^(DIV|SECTION)$/.test(tag) ||
      (range && blockTag.test(tag) && !covers(node, range)))
  )
    return "";
  // Revealed or not, a spoiler is authored content, and every flavor shows
  // its delimiters so other editors see where it was masked; HTML also carries
  // the composer's mark, which `copyDocument` reads back alone.
  if (node.hasAttribute("data-spoiler") && inner)
    return format === "html"
      ? `<span data-spoiler="">${spoilerDelimiter}${inner}${spoilerDelimiter}</span>`
      : `||${inner}||`;
  const target = node.getAttribute("data-profile-target");
  if (target !== null)
    return whole(node, range) && profileKey(target)
      ? link(
          format,
          target,
          `@${node.getAttribute("data-mention-name") ?? node.textContent}`,
        )
      : inner;
  if (tag === "A")
    return whole(node, range) ? anchor(node, inner, format) : inner;
  switch (tag) {
    case "STRONG":
    case "B":
      return wrap(format, inner, "strong");
    case "EM":
    case "I":
      return wrap(format, inner, "em");
    case "S":
    case "DEL":
      return wrap(format, inner, "s");
    case "CODE":
      return node.parentElement?.tagName === "PRE"
        ? inner
        : wrap(format, inner, "code");
    case "PRE": {
      if (format === "text") return inner;
      // The info string travels as the conventional class; the composer's own
      // DOM carries it as an attribute.
      const language =
        node.querySelector("code")?.className.match(/language-(\S+)/)?.[1] ??
        node.getAttribute("data-language") ??
        "";
      let code = inner;
      if (range) {
        const remainder = node.ownerDocument.createRange();
        remainder.selectNodeContents(node);
        if (range.compareBoundaryPoints(Range.END_TO_END, remainder) < 0) {
          remainder.setStart(range.endContainer, range.endOffset);
          // A clipped block needs its own terminator: its selected final newline
          // may be content, before the renderer's actual last newline.
          if (remainder.toString()) code += "\n";
        }
      }
      return fence(language, code);
    }
  }
  if (
    format === "html" &&
    /^(UL|OL|LI|BLOCKQUOTE|TABLE|THEAD|TBODY|TFOOT|TR|TD|TH)$/.test(tag) &&
    // An item copied without its list is prose, not an orphan <li> that the
    // editor parser would wrap in a new bullet list.
    (tag !== "LI" || inList) &&
    !node.querySelector("[data-message-id]")
  ) {
    const start =
      tag === "OL"
        ? Number.parseInt(node.getAttribute("start") ?? "1", 10) +
          // The first item the copy keeps, not one it only touches.
          (range && kept[0] ? [...node.children].indexOf(kept[0]) : 0)
        : 1;
    return `<${tag.toLowerCase()}${tag === "OL" && Number.isFinite(start) && start !== 1 ? ` start="${start}"` : ""}>${inner}</${tag.toLowerCase()}>`;
  }
  if (format !== "html" || !blockTag.test(tag) || node.querySelector(blocks))
    return inner;
  const block = /^H[1-6]$/.test(tag) ? tag.toLowerCase() : "p";
  return `<${block}>${inner}</${block}>`;
}

/** Engines omit computed `user-select: none` chrome from copies; so do we. */
export function unselectable(element: Element): boolean {
  return getComputedStyle(element).userSelect === "none";
}

function anchor(node: Element, inner: string, format: CopyFormat): string {
  const target = node.getAttribute("href") ?? "";
  const panel = node.getAttribute("data-panel-target") === target;
  const href = panel ? target : safeHref(target);
  if (!href) return inner;
  // Message links state their label (empty for a raw destination). Other HTML,
  // including this module's own output, is raw when its text is the URL.
  const label = node.getAttribute("data-link-label") ?? visibleText(node);
  // Unknown schemes stay source text in HTML; the editor's existing token
  // parser preserves them without adding an active clipboard destination.
  if (panel && format === "html")
    return sourceTokenHtml(link("markdown", href, label || href));
  if (!label || label === href || label === node.getAttribute("href"))
    return format === "html" ? link(format, href, href) : href;
  // Identity and channel locators read as their sigil-prefixed name alone.
  const buzz = parseBuzzLink(href);
  const plain =
    profileKey(href) || (buzz?.format === "legacy" && !buzz.messageId)
      ? label
      : `${label} (${href})`;
  return link(format, href, label, plain);
}

function sourceTokenHtml(source: string): string {
  return `<span data-source="${escapeHtml(source)}">${escapeHtml(source)}</span>`;
}

/** An element's text without this module's spoiler delimiters. */
function visibleText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node as Text).data;
  if (node instanceof Element && node.hasAttribute("data-spoiler-delimiter"))
    return "";
  let value = "";
  for (const child of node.childNodes) value += visibleText(child);
  return value;
}

function safeHref(value: string): string | undefined {
  return profileKey(value) || parseBuzzLink(value) ? value : safeLinkUrl(value);
}

function link(
  format: CopyFormat,
  href: string,
  label: string,
  plain = label,
): string {
  if (format === "html")
    return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
  if (format === "markdown")
    return `[${label.replace(/[\\`[\]*_~<>&|]/g, "\\$&")}](${href.replace(/\\|&(?=#?\w+;)/g, "\\$&").replace(/[()]/g, (character) => (character === "(" ? "%28" : "%29"))})`;
  return plain;
}

function wrap(format: CopyFormat, inner: string, tag: string): string {
  if (format === "html") return `<${tag}>${inner}</${tag}>`;
  return inner;
}

/** Reuse the send serializer's CommonMark flanking, escaping and code delimiters. */
function markdown(node: Node, range?: Range): string {
  return composerMarkdown(
    projectComposerDocument(copyDocument(node, range)).draft,
  );
}

/** The editor document this app's semantic HTML parses to: the nodes a paste
 * inserts and the source `markdown` serializes. Only the semantic HTML emitted
 * above reaches the editor parser. Anchors become source tokens, not
 * recipients; the paste host still owns mention acceptance. */
export function copyDocument(node: Node, range?: Range): EditorNode {
  const container = (node.ownerDocument ?? document).createElement("div");
  container.innerHTML = serializeNode(node, "html", range);
  const html = container.ownerDocument;
  // A spoiler's delimiters are text for other consumers; the mark carries them.
  for (const delimiter of container.querySelectorAll(
    "[data-spoiler-delimiter]",
  ))
    delimiter.remove();
  // Headings, rules and task checkboxes have no composer node. They become the
  // Markdown source that renders them again once sent: paragraph and item text.
  for (const heading of container.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    const paragraph = html.createElement("p");
    if (heading.textContent)
      paragraph.append(`${"#".repeat(Number(heading.tagName.slice(1)))} `);
    paragraph.append(...heading.childNodes);
    heading.replaceWith(paragraph);
  }
  // `***`, not `---`: a paste can land the rule's line directly under the
  // destination's text, which `---` would turn into a setext heading.
  for (const rule of container.querySelectorAll("hr")) {
    const paragraph = html.createElement("p");
    paragraph.textContent = "***";
    rule.replaceWith(paragraph);
  }
  for (const input of container.querySelectorAll("input"))
    input.replaceWith(
      input.type === "checkbox" ? `[${input.checked ? "x" : " "}]` : "",
    );
  // Rendered paragraphs are separated by blank lines; editor paragraphs are
  // individual source lines. Preserve that distinction only for timeline HTML.
  const origin = node instanceof Element ? node : node.parentElement;
  if (origin?.closest('[data-buzz-copy="timeline"]')) {
    for (const paragraph of container.querySelectorAll("p + p"))
      paragraph.before(html.createElement("p"));
  }
  // Tables remain tab-separated source in the composer, whose schema has no table.
  for (const row of container.querySelectorAll("tr"))
    for (const cell of [...row.children].slice(1)) cell.prepend("\t");
  const parser = new EditorDOMParser(composerSchema, [
    {
      tag: "a",
      node: "token",
      getAttrs: (element) => ({
        source: anchor(element, element.textContent ?? "", "markdown"),
      }),
    },
    {
      tag: "pre",
      node: "code_block",
      getAttrs: (element) => ({
        language:
          element
            .querySelector("code")
            ?.className.match(/language-(\S+)/)?.[1] ?? null,
      }),
      getContent: (element) => {
        // Both clipboard producers use the renderer's one final newline. Remove
        // just that terminator, preserving intentional blank lines in the code.
        const value = (element.textContent ?? "").replace(/\n$/, "");
        return value
          ? Fragment.from(composerSchema.text(value))
          : Fragment.empty;
      },
    },
    { tag: "tr", node: "paragraph" },
    ...EditorDOMParser.fromSchema(composerSchema).rules,
  ]);
  return parser.parse(container, { preserveWhitespace: "full" });
}

function fence(language: string, code: string): string {
  return `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${code}</code></pre>`;
}

function text(value: string, format: CopyFormat): string {
  return format === "html" ? escapeHtml(value) : value;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character] ??
      character,
  );
}

function clip(node: Text, range?: Range): string {
  const start = range && node === range.startContainer ? range.startOffset : 0;
  const value = node.data.slice(
    start,
    range && node === range.endContainer ? range.endOffset : undefined,
  );
  // The renderer writes a hard break as `<br>\n`; that newline is formatting.
  return start === 0 &&
    node.previousSibling?.nodeName === "BR" &&
    value.startsWith("\n")
    ? value.slice(1)
    : value;
}

/** A chip keeps its identity only when all of its text is selected. */
function whole(element: Element, range?: Range): boolean {
  return !range || within(element, range).toString() === element.textContent;
}

/** Whether a selection covers an element or some of its text, not merely
 * ends inside it, as a triple-click on the paragraph above leaves it. */
function holds(element: Element, range?: Range): boolean {
  return (
    !range || covers(element, range) || within(element, range).toString() !== ""
  );
}

/** Whether a range contains all of an element. */
function covers(element: Element, range: Range): boolean {
  const bounds = element.ownerDocument.createRange();
  bounds.selectNode(element);
  return (
    range.compareBoundaryPoints(Range.START_TO_START, bounds) <= 0 &&
    range.compareBoundaryPoints(Range.END_TO_END, bounds) >= 0
  );
}

function within(element: Element, range: Range): Range {
  const part = range.cloneRange();
  const bounds = element.ownerDocument.createRange();
  bounds.selectNodeContents(element);
  if (part.compareBoundaryPoints(Range.START_TO_START, bounds) < 0)
    part.setStart(bounds.startContainer, bounds.startOffset);
  if (part.compareBoundaryPoints(Range.END_TO_END, bounds) > 0)
    part.setEnd(bounds.endContainer, bounds.endOffset);
  return part;
}

// Preserve explicit breaks, blocks, and the tab/newline boundaries browsers use
// for table cells and rows. HTML output wraps leaf blocks instead.
function children(
  node: Node,
  format: CopyFormat,
  range?: Range,
  kept?: Element[],
): string {
  let text = "";
  let previous: Node | undefined;
  for (const child of node.childNodes) {
    if ((range && !range.intersectsNode(child)) || formatting(child)) continue;
    const value = serialize(
      child,
      format,
      range,
      /^(UL|OL)$/.test(node.nodeName),
    );
    if (value && child instanceof Element) kept?.push(child);
    const separator =
      previous && format !== "html" ? siblingSeparator(previous, child) : "";
    if (separator === "\n\n" && text && value) {
      const existing =
        (text.match(/\n*$/)?.[0].length ?? 0) +
        (value.match(/^\n*/)?.[0].length ?? 0);
      text += "\n".repeat(Math.max(0, 2 - existing));
    } else if (separator === "\t") text += separator;
    else if (
      text &&
      value &&
      separator &&
      !text.endsWith(separator) &&
      !value.startsWith(separator)
    )
      text += separator;
    text += value;
    previous = child;
  }
  return text;
}

const blockTag =
  /^(DIV|P|LI|OL|UL|SECTION|TABLE|BLOCKQUOTE|PRE|H[1-6]|HR|TR|THEAD|TBODY|TFOOT|TD|TH)$/;
const blocks =
  "div, p, li, ol, ul, section, table, blockquote, pre, h1, h2, h3, h4, h5, h6, hr, tr, thead, tbody, tfoot, td, th";

function siblingSeparator(previous: Node, current: Node) {
  const previousTag = blockName(previous);
  const currentTag = blockName(current);
  if (/^(TD|TH)$/.test(previousTag) || /^(TD|TH)$/.test(currentTag))
    return "\t";
  // Markdown separates blocks with a blank line, as the composer's serializer
  // does; list items, table rows and layout containers are single lines.
  if (markdownBlock.test(previousTag) && markdownBlock.test(currentTag))
    return "\n\n";
  return blockTag.test(previousTag) || blockTag.test(currentTag) ? "\n" : "";
}

const markdownBlock = /^(P|H[1-6]|HR|UL|OL|BLOCKQUOTE|PRE|TABLE)$/;

// A presented code block's frame separates like the PRE it replaces.
const blockName = (node: Node) =>
  node instanceof Element
    ? node.hasAttribute("data-copy-code")
      ? "PRE"
      : node.tagName
    : "";

/** Whitespace between rendered blocks is formatting; blocks supply separators. */
function formatting(node: Node): boolean {
  return (
    node.nodeType === Node.TEXT_NODE &&
    !node.parentElement?.closest("pre, code") &&
    !/\S/.test((node as Text).data) &&
    [node.previousSibling, node.nextSibling].some(
      (sibling) => sibling instanceof Element && blockTag.test(sibling.tagName),
    )
  );
}

const editable =
  'input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';
const elementOf = (node: Node) =>
  node instanceof Element ? node : node.parentElement;

/** Message rows only; editors own their selections. */
function messageSelection(range: Range): boolean {
  const scope = elementOf(range.commonAncestorContainer);
  if (
    !scope ||
    [range.startContainer, range.endContainer].some((node) =>
      elementOf(node)?.closest(editable),
    )
  )
    return false;
  return (
    !!scope.closest("[data-message-id]") ||
    [...scope.querySelectorAll("[data-message-id]")].some((row) =>
      range.intersectsNode(row),
    )
  );
}

// Registered in the capture phase so it runs before `copyEmoji`
// (src/bundled/emoji/copy-emoji.ts), which bubbles on the same document and
// yields once the event is prevented. This walk emits shortcodes itself, so a
// message selection loses nothing by taking the event first.
function copyMessageSelection(event: ClipboardEvent) {
  const selection = document.getSelection();
  if (
    event.defaultPrevented ||
    !event.clipboardData ||
    !selection ||
    selection.isCollapsed ||
    !selection.rangeCount
  )
    return;
  const ranges = Array.from({ length: selection.rangeCount }, (_, index) =>
    selection.getRangeAt(index),
  );
  if (!ranges.every(messageSelection)) return;
  event.clipboardData.setData(
    "text/plain",
    serializeSelection(selection, "text"),
  );
  event.clipboardData.setData(
    "text/html",
    `<div data-buzz-copy="timeline">${serializeSelection(selection, "html")}</div>`,
  );
  event.preventDefault();
}

let surfaces = 0;
/** Timeline and thread surfaces share one document listener. */
export function useMessageSelectionCopy() {
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (surfaces++ === 0)
      document.addEventListener("copy", copyMessageSelection, true);
    return () => {
      if (--surfaces === 0)
        document.removeEventListener("copy", copyMessageSelection, true);
    };
  }, []);
}
