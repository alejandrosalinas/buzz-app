// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import { registerMessageList, type MessageList } from "./message-selection";
import { SelectionQuote } from "./SelectionQuote";
import * as overlayLayer from "../../shared/design-system/overlayLayer";

const cleanups: (() => void)[] = [];
const rect = (top: number) =>
  ({
    top,
    bottom: top + 20,
    left: 10,
    right: 110,
    width: 100,
    height: 20,
  }) as DOMRect;
beforeEach(() => {
  // jsdom lays nothing out; give the selection and list a visible geometry.
  Range.prototype.getClientRects = () => [rect(100)] as unknown as DOMRectList;
});
const ownRects = Object.getOwnPropertyDescriptor(
  Range.prototype,
  "getClientRects",
);
afterEach(() => {
  // Unmount the portal before the page it lives in is cleared.
  cleanup();
  for (const dispose of cleanups.splice(0)) dispose();
  if (ownRects)
    Object.defineProperty(Range.prototype, "getClientRects", ownRects);
  else delete (Range.prototype as Partial<Range>).getClientRects;
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

const frame = () =>
  act(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );

function setup() {
  const list = document.createElement("section");
  list.innerHTML =
    '<div data-message-id="one"><div data-layout="timeline"><p>Quote me</p></div></div>';
  list.getBoundingClientRect = () => ({ ...rect(0), bottom: 500 }) as DOMRect;
  document.body.append(list);
  const controller: MessageList = {
    row: (id) => ({ id }) as ChannelMessage,
    newest: () => "one",
    canEdit: () => false,
    edit: vi.fn(),
    canDelete: () => false,
    remove: vi.fn(),
    canMarkUnread: () => false,
    markUnread: vi.fn(),
    composer: () => null,
    canQuote: () => true,
    quote: vi.fn(() => true),
  };
  cleanups.push(registerMessageList(list, controller));
  render(<SelectionQuote list={{ current: list }} />);
  const range = document.createRange();
  range.selectNodeContents(list.querySelector("p") as Node);
  act(() => {
    document.getSelection()?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  return { list, controller };
}

it("stays mounted through a real press on Quote and quotes on click", async () => {
  const { controller } = setup();
  const button = await screen.findByRole("button", { name: "Quote" });
  fireEvent.pointerDown(button, { button: 0 });
  // A person's press lasts longer than a frame.
  await frame();
  await frame();
  expect(screen.getByRole("button", { name: "Quote" })).toBe(button);
  fireEvent.pointerUp(button, { button: 0 });
  fireEvent.click(button);
  expect(controller.quote).toHaveBeenCalledOnce();
  expect(vi.mocked(controller.quote).mock.calls[0]?.[0]).toContain("Quote me");
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Quote" })).toBeNull(),
  );
});

it("waits for a drag in the timeline to finish", async () => {
  const { list } = setup();
  await screen.findByRole("button", { name: "Quote" });
  fireEvent.pointerDown(list, { button: 0 });
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Quote" })).toBeNull(),
  );
  fireEvent.pointerUp(list, { button: 0 });
  await screen.findByRole("button", { name: "Quote" });
});

it("skips overlay scans when no text is selected", async () => {
  const { list } = setup();
  await screen.findByRole("button", { name: "Quote" });
  const scan = vi.spyOn(overlayLayer, "behindActiveOverlay");
  try {
    act(() => {
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    await frame();
    fireEvent.scroll(list);
    await frame();
    expect(scan).not.toHaveBeenCalled();
  } finally {
    scan.mockRestore();
  }
});

it("hides behind a modal and returns once it closes", async () => {
  setup();
  await screen.findByRole("button", { name: "Quote" });
  const modal = document.createElement("div");
  modal.setAttribute("aria-modal", "true");
  act(() => document.body.append(modal));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Quote" })).toBeNull(),
  );
  act(() => modal.remove());
  await screen.findByRole("button", { name: "Quote" });
});

it("yields to an open menu and restores the selected quote on dismissal", async () => {
  const { controller } = setup();
  await screen.findByRole("button", { name: "Quote" });
  // overlayLayer tests exercise the shared menu's DOM contract with Base UI.
  const portal = document.createElement("div");
  portal.setAttribute("data-base-ui-portal", "");
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.setAttribute("data-open", "");
  portal.append(menu);
  act(() => document.body.append(portal));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Quote" })).toBeNull(),
  );
  expect(document.getSelection()?.toString()).toBe("Quote me");
  act(() => {
    menu.removeAttribute("data-open");
    menu.setAttribute("data-closed", "");
  });
  const button = await screen.findByRole("button", { name: "Quote" });
  fireEvent.click(button);
  expect(controller.quote).toHaveBeenCalledOnce();
  expect(vi.mocked(controller.quote).mock.calls[0]?.[0]).toContain("Quote me");
});

it("hides once the selection scrolls out of its list", async () => {
  const { list } = setup();
  await screen.findByRole("button", { name: "Quote" });
  list.getBoundingClientRect = () => ({ ...rect(200), bottom: 500 }) as DOMRect;
  fireEvent.scroll(list);
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Quote" })).toBeNull(),
  );
});
