// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { KeyboardEvent } from "react";
import type { ChannelMessage } from "../relay/contracts";
import {
  activeMessageList,
  moveMessageSelection,
  reactionTrigger,
  registerMessageList,
  selectedMessage,
  selectNewestMessage,
  type MessageList,
} from "./message-selection";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
});

const message = (id: string) => ({ id }) as ChannelMessage;

function fixture(ids = ["one", "two", "three"], newest = ids.at(-1)) {
  const list = document.createElement("section");
  list.innerHTML = ids
    .map(
      (id) =>
        `<div data-message-id="${id}"><div data-layout="timeline"><span>${id}</span>` +
        `<div role="group"><span data-reaction-tool><button aria-haspopup="dialog">React</button></span></div>` +
        "</div></div>",
    )
    .join("");
  const composer = document.createElement("textarea");
  document.body.append(list, composer);
  const controller: MessageList = {
    row: (id) => (ids.includes(id) ? message(id) : undefined),
    newest: () => newest,
    canEdit: (row) => row.id !== "one",
    edit: vi.fn(),
    canDelete: () => false,
    remove: vi.fn(),
    canMarkUnread: () => false,
    markUnread: vi.fn(),
    composer: () => composer,
    canQuote: () => false,
    quote: vi.fn(),
  };
  cleanups.push(registerMessageList(list, controller));
  const box = (id: string) =>
    list.querySelector<HTMLElement>(
      `[data-message-id="${id}"] > [data-layout]`,
    );
  return { list, composer, controller, box };
}

function key(list: HTMLElement, name: string, modifiers = {}) {
  const event = {
    key: name,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
    defaultPrevented: false,
    currentTarget: list,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  moveMessageSelection(event as unknown as KeyboardEvent<HTMLElement>);
  return event.defaultPrevented;
}

it("selects the newest message's box and reports it as selected", () => {
  const { list, box, controller } = fixture();
  expect(selectNewestMessage(list)).toBe(true);
  expect(document.activeElement).toBe(box("three"));
  expect(selectedMessage()).toMatchObject({
    row: { id: "three" },
    list: controller,
  });
  expect(selectNewestMessage(document.createElement("section"))).toBe(false);
});

it("selects the newest message by id when tree order puts an older sibling last", () => {
  // An expanded branch renders its newer reply above a later, older sibling.
  const { list, box } = fixture(
    ["root", "newer-reply", "older-sibling"],
    "newer-reply",
  );
  expect(selectNewestMessage(list)).toBe(true);
  expect(document.activeElement).toBe(box("newer-reply"));
});

it("treats only the message itself as selected, not a control inside it", () => {
  const { list } = fixture();
  selectNewestMessage(list);
  list.querySelector<HTMLButtonElement>("button")?.focus();
  expect(selectedMessage()).toBeUndefined();
});

it("moves with Up and Down and returns to the composer past the newest", () => {
  const { list, box, composer } = fixture();
  selectNewestMessage(list);
  expect(key(list, "ArrowUp")).toBe(true);
  expect(document.activeElement).toBe(box("two"));
  expect(key(list, "ArrowUp")).toBe(true);
  expect(document.activeElement).toBe(box("one"));
  // The oldest rendered row leaves Up native so older history can load.
  expect(key(list, "ArrowUp")).toBe(false);
  expect(document.activeElement).toBe(box("one"));
  expect(key(list, "ArrowDown")).toBe(true);
  expect(key(list, "ArrowDown")).toBe(true);
  expect(document.activeElement).toBe(box("three"));
  expect(key(list, "ArrowDown")).toBe(true);
  expect(document.activeElement).toBe(composer);
});

it("returns to the composer on Escape and ignores modified or unselected keys", () => {
  const { list, box, composer } = fixture();
  selectNewestMessage(list);
  expect(key(list, "ArrowUp", { altKey: true })).toBe(false);
  expect(key(list, "ArrowUp", { shiftKey: true })).toBe(false);
  expect(document.activeElement).toBe(box("three"));
  expect(key(list, "Escape")).toBe(true);
  expect(document.activeElement).toBe(composer);
  expect(key(list, "ArrowUp")).toBe(false);
});

it("finds the selected message's reaction trigger, preferring its action bar", () => {
  const { list, box } = fixture(["one"]);
  const row = list.querySelector<HTMLElement>("[data-message-id]");
  if (!row) throw new Error("Expected row");
  const inline = document.createElement("span");
  inline.dataset.reactionTool = "";
  inline.innerHTML = '<button aria-haspopup="dialog">Inline</button>';
  box("one")?.prepend(inline);
  expect(reactionTrigger(row)?.textContent).toBe("React");
  for (const button of row.querySelectorAll("button")) button.disabled = true;
  expect(reactionTrigger(row)).toBeUndefined();
});

it("prefers the list in the focused pane", () => {
  const first = fixture(["a"]);
  const pane = document.createElement("div");
  const second = fixture(["b"]);
  pane.append(second.list, second.composer);
  document.body.append(pane);
  second.composer.focus();
  expect(activeMessageList()).toBe(second.list);
  first.composer.focus();
  expect(activeMessageList()).toBe(first.list);
});

it("skips rows it can't act on: membership notices, collapsed and folded rows", () => {
  const { list, box, composer } = fixture();
  const extra = (id: string, wrap?: "hidden" | "inert") => {
    const row = document.createElement("div");
    row.dataset.messageId = id;
    row.innerHTML = '<div data-layout="timeline"></div>';
    const holder = document.createElement("div");
    if (wrap) holder.setAttribute(wrap, "");
    holder.append(row);
    return holder;
  };
  // "joined" has no row() entry, like a membership notice.
  box("two")?.parentElement?.after(extra("joined"));
  list.append(extra("collapsed", "hidden"), extra("folded", "inert"));
  selectNewestMessage(list);
  expect(document.activeElement).toBe(box("three"));
  expect(key(list, "ArrowUp")).toBe(true);
  expect(document.activeElement).toBe(box("two"));
  expect(key(list, "ArrowDown")).toBe(true);
  expect(key(list, "ArrowDown")).toBe(true);
  expect(document.activeElement).toBe(composer);
});

it("leaves keys native while the newest message is scrolled out of the window", () => {
  const { list, box } = fixture(["one", "two"], "unmounted");
  expect(selectNewestMessage(list)).toBe(false);
  box("two")?.setAttribute("tabindex", "-1");
  box("two")?.focus();
  expect(key(list, "ArrowDown")).toBe(false);
  expect(document.activeElement).toBe(box("two"));
});
