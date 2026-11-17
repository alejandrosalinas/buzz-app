/** The nearest ancestor of `element` that scrolls vertically, if any. */
export function scrollport(element: Element) {
  for (let node = element.parentElement; node; node = node.parentElement)
    if (/auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
  return null;
}
