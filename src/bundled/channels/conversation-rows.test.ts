// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  adjacentConversation,
  conversationRows,
  inFieldOutsideComposer,
  inTerminal,
  stepConversation,
} from "./conversation-rows";

afterEach(() => {
  document.body.innerHTML = "";
});
const unread = '<span data-channel-unread=""></span>';
const activity = '<span data-channel-activity=""></span>';
/** Rows are `id` or `id:` plus markup; `*id` is the open one; `s-id` is Solo. */
function sidebar(rows: string[], wrap = (html: string) => html) {
  document.body.innerHTML = `<aside><nav aria-label="Subscribed channels">${wrap(
    rows
      .map((spec) => {
        const [name = "", markup = ""] = spec.split(":");
        const open = name.startsWith("*");
        const id = name.replace("*", "");
        const attr = id.startsWith("s-")
          ? `data-solo-channel-id="${id}"`
          : `data-channel-id="${id}"`;
        return `<button type="button" ${attr} ${open ? 'aria-current="page"' : ""}>${id}${markup}</button>`;
      })
      .join(""),
  )}</nav></aside>`;
}
const id = (row: HTMLElement | undefined) =>
  row?.dataset.channelId ?? row?.dataset.soloChannelId;
const step = (
  direction: "previous" | "next",
  unreadOnly = false,
  root?: ParentNode,
) => id(adjacentConversation(direction, unreadOnly, root));

it("steps through team and Solo rows in rendered order without wrapping", () => {
  sidebar(["s-a", "b", "*c", "d", "s-e"]);
  expect(step("previous")).toBe("b");
  expect(step("next")).toBe("d");
  sidebar(["*s-a", "b"]);
  expect(step("previous")).toBeUndefined();
  sidebar(["a", "*b"]);
  expect(step("next")).toBeUndefined();
});

it("starts from the top for next and the bottom for previous when the open conversation is not listed", () => {
  sidebar(["a", "b", "c"]);
  expect(step("next")).toBe("a");
  expect(step("previous")).toBe("c");
});

it("skips to the nearest conversation that shows unread or thread activity", () => {
  sidebar([`a:${unread}`, "b", "*c", "d", `e:${activity}`, `f:${unread}`]);
  expect(step("next", true)).toBe("e");
  expect(step("previous", true)).toBe("a");
  sidebar(["a", "*b", "c"]);
  expect(step("next", true)).toBeUndefined();
  expect(step("previous", true)).toBeUndefined();
});

it("wraps unread stepping past either end", () => {
  sidebar([`a:${unread}`, "b", `c:${activity}`, "*d", "e"]);
  expect(step("next", true)).toBe("a");
  sidebar(["a", "*b", "c", `d:${unread}`, `e:${unread}`]);
  expect(step("previous", true)).toBe("e");
  // The open conversation alone is not a destination, even when unread.
  sidebar(["a", `*b:${unread}`, "c"]);
  expect(step("next", true)).toBeUndefined();
});

it("steps over a conversation listed twice, including the open one", () => {
  sidebar(["a", "*b", "c", "*b", "d"]);
  expect(step("next")).toBe("d");
  expect(step("previous")).toBe("a");
  sidebar(["*b", "a", "b"]);
  expect(step("next")).toBe("a");
  sidebar(["b", "a", "*b"]);
  expect(step("previous")).toBe("a");
});

it("ignores rows in collapsed sections and hidden panes but not a collapsed sidebar", () => {
  document.body.innerHTML = `<aside inert><nav aria-label="Subscribed channels">
    <section hidden><button data-solo-channel-id="s-hidden"></button></section>
    <div inert><button data-channel-id="closed"></button></div>
    <button data-channel-id="a"></button>
    <button data-channel-id="b" aria-current="page"></button>
    <button data-channel-id="c" disabled></button>
    <button data-channel-id="d"></button>
  </nav></aside>`;
  expect(conversationRows().map(id)).toEqual(["a", "b", "d"]);
  expect(step("next")).toBe("d");
  expect(step("previous")).toBe("a");
});

it("finds nothing without the sidebar list", () => {
  document.body.innerHTML = '<button data-channel-id="a"></button>';
  expect(conversationRows()).toEqual([]);
  expect(step("next")).toBeUndefined();
});

it("steps by activating the row, scrolling only the list", () => {
  sidebar(["*a", "b"]);
  const nav = document.querySelector("nav") as HTMLElement;
  const next = document.querySelector<HTMLElement>('[data-channel-id="b"]');
  const clicked = vi.fn();
  next?.addEventListener("click", clicked);
  vi.spyOn(nav, "getBoundingClientRect").mockReturnValue({
    top: 0,
    bottom: 100,
  } as DOMRect);
  vi.spyOn(next as HTMLElement, "getBoundingClientRect").mockReturnValue({
    top: 120,
    bottom: 140,
  } as DOMRect);
  nav.scrollTop = 0;
  stepConversation("next", false);
  expect(clicked).toHaveBeenCalledOnce();
  expect(nav.scrollTop).toBe(40);
  // No neighbour, no click.
  clicked.mockClear();
  next?.setAttribute("aria-current", "page");
  stepConversation("next", false);
  expect(clicked).not.toHaveBeenCalled();
});

it("recognises terminals and text fields outside the composer", () => {
  document.body.innerHTML = `
    <div class="xterm"><textarea id="term"></textarea></div>
    <input id="plain">
    <form data-composer-surface=""><div role="textbox" tabindex="0" id="composer"></div></form>
    <button id="button"></button>`;
  const focus = (selector: string) =>
    (document.querySelector(selector) as HTMLElement).focus();
  focus("#term");
  expect(inTerminal()).toBe(true);
  expect(inFieldOutsideComposer()).toBe(true);
  focus("#plain");
  expect(inTerminal()).toBe(false);
  expect(inFieldOutsideComposer()).toBe(true);
  focus("#composer");
  expect(inFieldOutsideComposer()).toBe(false);
  focus("#button");
  expect(inFieldOutsideComposer()).toBe(false);
});
