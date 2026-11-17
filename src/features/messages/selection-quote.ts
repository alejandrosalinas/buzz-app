import { messageListOf } from "./message-selection";
import { messageSelection, timelineCopy } from "./selection-copy";

/** Message text selected within one list whose own composer can quote it. */
export function quotableSelection(selection = document.getSelection()) {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  const ranges = Array.from({ length: selection.rangeCount }, (_, index) =>
    selection.getRangeAt(index),
  );
  if (!ranges.every(messageSelection) || !selection.toString().trim()) return;
  const [owner, ...others] = ranges.map((range) =>
    messageListOf(range.commonAncestorContainer),
  );
  if (
    !owner ||
    others.some((other) => other?.element !== owner.element) ||
    !owner.list.canQuote()
  )
    return;
  return { element: owner.element, list: owner.list, ranges };
}

/** Quote the current message selection into its conversation's composer. */
export function quoteSelection() {
  const selection = document.getSelection();
  const target = quotableSelection(selection);
  if (!selection || !target) return false;
  const html = timelineCopy(selection);
  // Clear the timeline range before the composer focuses and places its caret;
  // clearing afterwards would remove the composer's caret instead.
  selection.removeAllRanges();
  if (target.list.quote(html)) return true;
  for (const range of target.ranges) selection.addRange(range);
  return false;
}
