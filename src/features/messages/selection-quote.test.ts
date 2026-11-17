// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import { registerMessageList, type MessageList } from "./message-selection";
import { quotableSelection, quoteSelection } from "./selection-quote";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

function list(id: string, { canQuote = true, accepts = true } = {}) {
  const element = document.createElement("section");
  element.innerHTML =
    `<div data-message-id="${id}"><div data-layout="timeline">` +
    `<p>${id} says <strong>hello</strong></p></div></div>`;
  document.body.append(element);
  const controller: MessageList = {
    row: (row) => ({ id: row }) as ChannelMessage,
    newest: () => id,
    canEdit: () => false,
    edit: vi.fn(),
    canDelete: () => false,
    remove: vi.fn(),
    canMarkUnread: () => false,
    markUnread: vi.fn(),
    composer: () => null,
    canQuote: () => canQuote,
    quote: vi.fn(() => accepts),
  };
  cleanups.push(registerMessageList(element, controller));
  return { element, controller };
}

function select(start: Node, startOffset: number, end = start, endOffset = 0) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset || (end.textContent?.length ?? 0));
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return range;
}

const text = (element: Element, selector: string) =>
  element.querySelector(selector)?.firstChild as Node;

it("quotes a message selection into its own list's composer", () => {
  const channel = list("channel");
  const thread = list("thread");
  select(text(thread.element, "p"), 0, text(thread.element, "strong"));
  expect(quotableSelection()?.element).toBe(thread.element);
  expect(quoteSelection()).toBe(true);
  expect(channel.controller.quote).not.toHaveBeenCalled();
  expect(thread.controller.quote).toHaveBeenCalledOnce();
  const html = vi.mocked(thread.controller.quote).mock.calls[0]?.[0];
  expect(html).toMatch(/^<div data-buzz-copy="timeline">/);
  expect(html).toContain("thread says <strong>hello</strong>");
  expect(document.getSelection()?.rangeCount).toBe(0);
});

it("keeps the selection when the composer refuses the quote", () => {
  const { element, controller } = list("one", { accepts: false });
  const range = select(text(element, "p"), 0);
  expect(quoteSelection()).toBe(false);
  expect(controller.quote).toHaveBeenCalledOnce();
  expect(document.getSelection()?.getRangeAt(0)).toEqual(range);
});

it("offers nothing without an editable composer, text, or a single list", () => {
  const closed = list("closed", { canQuote: false });
  select(text(closed.element, "p"), 0);
  expect(quotableSelection()).toBeUndefined();

  const open = list("open");
  select(text(open.element, "p"), 0, text(open.element, "p"), 0);
  document.getSelection()?.collapseToStart();
  expect(quotableSelection()).toBeUndefined();

  // Across two conversations there is no one composer to quote into.
  const other = list("other");
  select(text(open.element, "p"), 0, text(other.element, "strong"));
  expect(quotableSelection()).toBeUndefined();

  const outside = document.createElement("p");
  outside.textContent = "Not a message";
  document.body.append(outside);
  select(outside.firstChild as Node, 0);
  expect(quotableSelection()).toBeUndefined();
  expect(quoteSelection()).toBe(false);
});
