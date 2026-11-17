import type { KeyboardEvent } from "react";
import { focusWithKeyboard } from "../../shared/design-system/useKeyboardFocusVisibility";
import type { ChannelMessage } from "../relay/contracts";

/**
 * Keyboard message selection. A selected message is a focused row, so focus,
 * Virtua's keep-mounted rule and screen readers all follow the same fact.
 * Lists publish row lookup and editing; shortcuts act on the focused row.
 */
export type MessageList = Readonly<{
  row(id: string): ChannelMessage | undefined;
  /** The conversation's newest message, rendered or not. */
  newest(): string | undefined;
  canEdit(row: ChannelMessage): boolean;
  edit(row: ChannelMessage): void;
  /** Your own messages, through the menu's delete confirmation. */
  canDelete(row: ChannelMessage): boolean;
  remove(row: ChannelMessage): void;
  canMarkUnread(row: ChannelMessage): boolean;
  markUnread(row: ChannelMessage): void;
  /** Where Escape and Down past the newest message return focus. */
  composer(): HTMLElement | null;
  /** Append copied message HTML to this list's own composer as a quote. */
  quote(html: string): boolean;
  canQuote(): boolean;
}>;

const ROW = "[data-message-id]";
const lists = new Map<HTMLElement, MessageList>();

export function registerMessageList(element: HTMLElement, list: MessageList) {
  lists.set(element, list);
  return () => {
    if (lists.get(element) === list) lists.delete(element);
  };
}

/** The row's message box, not its day divider, takes focus. */
function focusTarget(row: HTMLElement) {
  return row.querySelector<HTMLElement>(":scope > [data-layout]") ?? row;
}

/** Rows that can act as messages: not membership notices, folded or collapsed. */
function rowsIn(list: HTMLElement) {
  const owner = lists.get(list);
  return Array.from(list.querySelectorAll<HTMLElement>(ROW)).filter(
    (row) =>
      !!row.dataset.messageId &&
      !!owner?.row(row.dataset.messageId) &&
      !row.closest("[inert], [hidden]"),
  );
}

/** The innermost registered list containing this node. */
function listFor(element: Node) {
  let found: HTMLElement | undefined;
  for (const list of lists.keys())
    if (list.contains(element) && (!found || found.contains(list)))
      found = list;
  return found;
}

/** The innermost registered list containing this node, with its controller. */
export function messageListOf(node: Node) {
  const element = listFor(node);
  const list = element && lists.get(element);
  return element && list ? { element, list } : undefined;
}

export function selectMessage(row: HTMLElement) {
  const target = focusTarget(row);
  if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
  focusWithKeyboard(target);
  target.scrollIntoView?.({ block: "nearest" });
}

/**
 * A virtualized list scrolled away from its end has unmounted the newest
 * message; its last rendered row is then not "the newest".
 */
function showsNewest(list: HTMLElement) {
  const id = lists.get(list)?.newest();
  return (
    !id ||
    Array.from(list.querySelectorAll<HTMLElement>(ROW)).some(
      (row) => row.dataset.messageId === id,
    )
  );
}

/**
 * Selects the newest message by identity, since a nested thread's tree order
 * can put an older sibling last; false when it isn't rendered or there is none.
 */
export function selectNewestMessage(list: HTMLElement | null | undefined) {
  if (!list?.isConnected || !showsNewest(list)) return false;
  const rows = rowsIn(list);
  const newest = lists.get(list)?.newest();
  const row =
    rows.find((row) => row.dataset.messageId === newest) ?? rows.at(-1);
  if (!row) return false;
  selectMessage(row);
  return true;
}

export type SelectedMessage = Readonly<{
  element: HTMLElement;
  row: ChannelMessage;
  list: MessageList;
}>;

export function selectedMessage(): SelectedMessage | undefined {
  const active = document.activeElement;
  const element = active?.closest<HTMLElement>(ROW);
  if (!element || focusTarget(element) !== active) return;
  const owner = listFor(element);
  const list = owner && lists.get(owner);
  const id = element.dataset.messageId;
  const row = id ? list?.row(id) : undefined;
  return list && row ? { element, row, list } : undefined;
}

/** The focused pane's list, else the first visible one, as composer shortcuts do. */
export function activeMessageList() {
  const visible = [...lists.keys()].filter(
    (element) =>
      element.isConnected &&
      !element.closest('[inert], [hidden], [aria-hidden="true"]') &&
      (element.checkVisibility?.({ visibilityProperty: true }) ?? true),
  );
  for (
    let element = document.activeElement;
    element;
    element = element.parentElement
  ) {
    const contained = visible.filter((list) => element.contains(list));
    if (contained.length === 1) return contained[0];
  }
  return visible[0];
}

/** The selected row's own reaction picker trigger, preferring its action bar. */
export function reactionTrigger(element: HTMLElement) {
  const triggers = Array.from(
    element.querySelectorAll<HTMLButtonElement>(
      "[data-reaction-tool] button[aria-haspopup]:not(:disabled)",
    ),
  ).filter((trigger) => trigger.closest(ROW) === element);
  return (
    triggers.find((trigger) => trigger.closest('[role="group"]')) ?? triggers[0]
  );
}

/** The selected row's own Reply control, which opens or answers its thread. */
export function replyTrigger(element: HTMLElement) {
  return Array.from(
    element.querySelectorAll<HTMLButtonElement>(
      '[role="group"] button[aria-label="Reply"]:not(:disabled)',
    ),
  ).find((trigger) => trigger.closest(ROW) === element);
}

/**
 * Up/Down move between messages and Escape returns to the composer, but only
 * while a message itself is selected; controls inside it keep their keys.
 * Up at the oldest rendered row stays native so history can load, as does
 * Down at the last rendered row while newer ones are unmounted.
 */
export function moveMessageSelection(event: KeyboardEvent<HTMLElement>) {
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    !["ArrowUp", "ArrowDown", "Escape"].includes(event.key)
  )
    return;
  const selected = selectedMessage();
  if (!selected || !event.currentTarget.contains(selected.element)) return;
  const owner = listFor(selected.element);
  if (!owner) return;
  if (event.key === "Escape") {
    const composer = selected.list.composer();
    if (!composer) return;
    event.preventDefault();
    focusWithKeyboard(composer);
    return;
  }
  const rows = rowsIn(owner);
  const index = rows.indexOf(selected.element);
  const next = rows[index + (event.key === "ArrowUp" ? -1 : 1)];
  if (next) {
    event.preventDefault();
    selectMessage(next);
    return;
  }
  // Past the last rendered row, native scrolling brings newer rows in.
  if (event.key === "ArrowDown" && showsNewest(owner)) {
    const composer = selected.list.composer();
    if (!composer) return;
    event.preventDefault();
    focusWithKeyboard(composer);
  }
}
