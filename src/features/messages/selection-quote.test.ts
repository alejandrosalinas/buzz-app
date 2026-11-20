// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import { registerMessageList, type MessageList } from "./message-selection";
import {
  captureSelectedQuote,
  quotableSelection,
  quoteSelection,
} from "./selection-quote";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function list(
  id: string,
  {
    canQuote = true,
    accepts = true,
    threadRootId,
    delivery,
  }: {
    canQuote?: boolean;
    accepts?: boolean;
    threadRootId?: string;
    delivery?: ChannelMessage["delivery"];
  } = {},
) {
  const element = document.createElement("section");
  element.innerHTML =
    `<div data-message-id="${id}"><div data-layout="timeline">` +
    `<p>${id} says <strong>hello</strong></p></div></div>`;
  document.body.append(element);
  const controller: MessageList = {
    scope: `https://relay.test:${"f".repeat(64)}`,
    row: (row) =>
      ({
        id: row,
        channelId: "general",
        threadRootId,
        delivery,
      }) as ChannelMessage,
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

it.each(["live", "captured"])(
  "quotes a %s selection into its own list's composer",
  (mode) => {
    const channel = list("channel");
    const thread = list("thread");
    select(text(thread.element, "p"), 0, text(thread.element, "strong"));
    expect(quotableSelection()?.element).toBe(thread.element);
    const quote = mode === "captured" ? captureSelectedQuote() : undefined;
    if (mode === "captured") {
      expect(quote?.text).toBe("thread says hello");
      select(text(channel.element, "p"), 0);
    }
    expect(quoteSelection(quote)).toBe(true);
    expect(channel.controller.quote).not.toHaveBeenCalled();
    expect(thread.controller.quote).toHaveBeenCalledOnce();
    const html = vi.mocked(thread.controller.quote).mock.calls[0]?.[0];
    expect(html).toMatch(/^<div data-buzz-copy="timeline">/);
    expect(html).toContain("thread says <strong>hello</strong>");
    expect(document.getSelection()?.rangeCount).toBe(0);
  },
);

it("keeps the selection when the composer refuses the quote", () => {
  const { element, controller } = list("one", { accepts: false });
  const range = select(text(element, "p"), 0);
  expect(quoteSelection()).toBe(false);
  expect(controller.quote).toHaveBeenCalledOnce();
  expect(document.getSelection()?.getRangeAt(0)).toEqual(range);
});

it("captures the original message link with its thread hint", () => {
  const id = "a".repeat(64);
  const root = "b".repeat(64);
  const { element, controller } = list(id, { threadRootId: root });
  select(text(element, "strong"), 0);
  const quote = captureSelectedQuote();
  expect([...(quote?.messageIds ?? [])]).toEqual([id]);
  expect(quote?.sourceLinks).toEqual([
    `buzz://message?channel=general&id=${id}&thread=${root}`,
  ]);
  expect(quoteSelection(quote)).toBe(true);
  expect(vi.mocked(controller.quote).mock.calls[0]?.[1]).toEqual(
    quote?.sourceLinks,
  );
});

it("attributes each selected message and skips the next row when selection ends at its start", () => {
  const firstId = "a".repeat(64);
  const secondId = "b".repeat(64);
  const { element } = list(firstId);
  const second = document.createElement("div");
  second.dataset.messageId = secondId;
  second.innerHTML =
    '<div data-copy-author="Second author" style="user-select: none">Second author</div><p>Second message</p>';
  element.append(second);
  const range = select(text(element, "strong"), 0, text(second, "p"));
  expect(captureSelectedQuote()?.sourceLinks).toEqual([
    `buzz://message?channel=general&id=${firstId}`,
    `buzz://message?channel=general&id=${secondId}`,
  ]);
  expect([...(captureSelectedQuote()?.messageIds ?? [])]).toEqual([
    firstId,
    secondId,
  ]);
  range.setEnd(text(second, "p"), 0);
  const quote = captureSelectedQuote();
  expect([...(quote?.messageIds ?? [])]).toEqual([firstId]);
  expect(quote?.sourceLinks).toEqual([
    `buzz://message?channel=general&id=${firstId}`,
  ]);
  expect(quote?.text).toContain("Second author");
  expect(quote?.html).toContain("<strong>Second author</strong>");
});

it("keeps quoting without inventing a link for an unpublished message", () => {
  const { element, controller } = list("a".repeat(64), { delivery: "sending" });
  select(text(element, "strong"), 0);
  const quote = captureSelectedQuote();
  expect([...(quote?.messageIds ?? [])]).toEqual(["a".repeat(64)]);
  expect(quote?.sourceLinks).toEqual([]);
  expect(quoteSelection(quote)).toBe(true);
  expect(controller.quote).toHaveBeenCalledOnce();
});

it.each(["detached", "replaced", "unwritable"])(
  "refuses a captured quote after its composer is %s",
  (change) => {
    const { element, controller } = list("one");
    select(text(element, "p"), 0);
    const quote = captureSelectedQuote();
    if (change === "detached") element.remove();
    if (change === "replaced")
      cleanups.push(registerMessageList(element, { ...controller }));
    if (change === "unwritable")
      vi.spyOn(controller, "canQuote").mockReturnValue(false);
    expect(quoteSelection(quote)).toBe(false);
    expect(controller.quote).not.toHaveBeenCalled();
  },
);

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
