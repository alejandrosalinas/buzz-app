/** The sidebar's navigation landmark, which scopes every scan below. */
export const CONVERSATION_LIST_LABEL = "Subscribed channels";
/** What a row shows when it has unread messages or thread activity. */
export const UNREAD_MARKERS = "[data-channel-unread], [data-channel-activity]";

/** Team rows and Solo rows carry different id attributes; both are buttons. */
const ROWS = "button[data-channel-id], button[data-solo-channel-id]";
const rowId = (row: HTMLElement) =>
  row.dataset.channelId ?? row.dataset.soloChannelId;

/**
 * Rendered sidebar conversations in document order. Sorting, sections, filters
 * and collapse are already applied by what the sidebar renders; rows in a
 * collapsed section (`inert`) or the inactive All/Solo/Team pane (`hidden`) are
 * skipped. An inert or hidden ancestor outside the list, such as a collapsed
 * sidebar, does not count: the order still exists and can be stepped through.
 */
export function conversationRows(root: ParentNode = document) {
  const list = root.querySelector<HTMLElement>(
    `nav[aria-label="${CONVERSATION_LIST_LABEL}"]`,
  );
  if (!list) return [];
  return [...list.querySelectorAll<HTMLButtonElement>(ROWS)].filter((row) => {
    const blocked = row.closest("[hidden], [inert]");
    return !row.disabled && !(blocked && list.contains(blocked));
  });
}

/**
 * The nearest conversation before or after the open one, optionally only those
 * showing unread. Only unread stepping wraps around to the other end. The open
 * conversation is the row marked `aria-current`; when it is not among the
 * rendered rows, "next" starts from the top and "previous" from the bottom. A
 * conversation listed in two sections is stepped over once.
 */
export function adjacentConversation(
  direction: "previous" | "next",
  unreadOnly: boolean,
  root: ParentNode = document,
) {
  const rows = conversationRows(root);
  const current = rows.filter(
    (row) => row.getAttribute("aria-current") === "page",
  );
  const first = current[0];
  const last = current[current.length - 1];
  const currentId = first && rowId(first);
  const candidates =
    first && last
      ? direction === "next"
        ? rows.slice(rows.indexOf(last) + 1)
        : rows.slice(0, rows.indexOf(first))
      : rows;
  const nearest = (from: HTMLButtonElement[]) => {
    const eligible = from.filter(
      (row) =>
        rowId(row) !== currentId &&
        (!unreadOnly || !!row.querySelector(UNREAD_MARKERS)),
    );
    return direction === "next" ? eligible[0] : eligible[eligible.length - 1];
  };
  return nearest(candidates) ?? (unreadOnly ? nearest(rows) : undefined);
}

/**
 * Opens a neighbouring conversation by activating its own row, so it takes the
 * exact path of a click: saved selection, navigation intent, staleness guards
 * and Solo's immediate activation. Scrolls the sidebar list, and nothing above
 * it, just far enough to show the row.
 */
export function stepConversation(
  direction: "previous" | "next",
  unreadOnly: boolean,
) {
  const row = adjacentConversation(direction, unreadOnly);
  if (!row) return;
  const list = row.closest("nav");
  if (list) {
    const frame = list.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    if (box.top < frame.top) list.scrollTop -= frame.top - box.top;
    else if (box.bottom > frame.bottom)
      list.scrollTop += box.bottom - frame.bottom;
  }
  row.click();
}

/** Terminals keep Escape and Option+Arrow for the shell. */
export const inTerminal = () => !!document.activeElement?.closest(".xterm");

/** A text field other than the composer owns its own keys, like Escape. */
export function inFieldOutsideComposer() {
  const active = document.activeElement;
  return (
    !!active &&
    !active.closest("[data-composer-surface]") &&
    !!active.closest(
      'input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])',
    )
  );
}
