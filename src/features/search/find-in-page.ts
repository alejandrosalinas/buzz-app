/** Find on screen reports at most this many matches, bounding work per pass. */
export const FIND_LIMIT = 1000;

const SKIPPED =
  'script, style, noscript, template, textarea, select, .sr-only, [inert], [contenteditable]:not([contenteditable="false"])';

/**
 * Whether text in `element` is on-screen text a person can select. Labels,
 * fields, the excluded subtree and content the engine reports as not visible
 * (`display: none`, `visibility: hidden`, covered `content-visibility: hidden`
 * tabs) don't count. Neither does `user-select: none` chrome such as sidebar
 * rows: WebKit paints highlights there onto the next selectable text instead.
 * Inert content, such as a collapsed drop target, can't be selected either,
 * even where its computed style says it can. A highlight there makes older
 * WebKit paint the unselectable text around it.
 */
function findable(element: Element, exclude: Element | null | undefined) {
  if (element.closest(SKIPPED) || exclude?.contains(element)) return false;
  if (!(element.checkVisibility?.({ visibilityProperty: true }) ?? true))
    return false;
  const style = getComputedStyle(element);
  return style.userSelect !== "none" && style.webkitUserSelect !== "none";
}

/**
 * `value` lowercased. Lowercasing can lengthen a character (`İ` becomes `i̇`);
 * then each lowercased code unit also maps to its character's source bounds.
 */
function lower(value: string) {
  const text = value.toLowerCase();
  if (text.length === value.length) return { text };
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let start = 0;
  for (const char of value) {
    const end = start + char.length;
    const lowered = char.toLowerCase();
    folded += lowered;
    for (let unit = 0; unit < lowered.length; unit++) {
      starts.push(start);
      ends.push(end);
    }
    start = end;
  }
  return { text: folded, starts, ends };
}

/**
 * Ranges for each case-insensitive occurrence of `query` in the findable text
 * under `root`, in document order. Matches don't span text nodes.
 */
export function findRanges(
  root: Node,
  query: string,
  exclude?: Element | null,
): Range[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const document = root.ownerDocument ?? (root as Document);
  const checked = new Map<Element, boolean>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const ranges: Range[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const { text, starts, ends } = lower(node.nodeValue ?? "");
    let at = text.indexOf(needle);
    // Style checks are the cost; only text that matches pays it.
    const parent = node.parentElement;
    if (at === -1 || !parent) continue;
    const ok = checked.get(parent) ?? findable(parent, exclude);
    checked.set(parent, ok);
    if (!ok) continue;
    for (; at !== -1; at = text.indexOf(needle, at + needle.length)) {
      const range = document.createRange();
      const last = at + needle.length - 1;
      range.setStart(node, starts?.[at] ?? at);
      range.setEnd(node, ends?.[last] ?? last + 1);
      ranges.push(range);
      if (ranges.length === FIND_LIMIT) return ranges;
    }
  }
  return ranges;
}
