// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import { ConversationPresentation } from "../conversation/ConversationPresentation";
import { registerMessageList, type MessageList } from "./message-selection";
import { MessageActionBar, MessageContextMenus } from "./MessageActionBar";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuItem,
  MenuPopup,
} from "../../shared/design-system/ui/Menu";
import * as clipboard from "../../shared/clipboard";

const cleanups: (() => void)[] = [];
const ownRects = Object.getOwnPropertyDescriptor(
  Range.prototype,
  "getClientRects",
);
afterEach(() => {
  cleanup();
  for (const dispose of cleanups.splice(0)) dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (ownRects)
    Object.defineProperty(Range.prototype, "getClientRects", ownRects);
  else delete (Range.prototype as Partial<Range>).getClientRects;
  document.getSelection()?.removeAllRanges();
});

function setup({
  canQuote = true,
  active = true,
  more = false,
  other = false,
} = {}) {
  // jsdom lays nothing out; selected text occupies this explicit geometry.
  Range.prototype.getClientRects = () =>
    [new DOMRect(10, 100, 100, 20)] as unknown as DOMRectList;
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
    canQuote: () => canQuote,
    quote: vi.fn(() => true),
  };
  const markUnread = vi.fn();
  function Conversation({
    active,
    show = true,
  }: {
    active: boolean;
    show?: boolean;
  }) {
    const list = useRef<HTMLElement>(null);
    return (
      <ToastProvider>
        <ConversationPresentation value={active}>
          <MessageContextMenus>
            <section ref={list} aria-label="Messages" tabIndex={-1}>
              {show && (
                <MessageActionBar
                  withToolbar
                  messageId="one"
                  copyText={() => "Whole message"}
                  link="buzz://message?channel=general&id=one"
                  onForward={vi.fn()}
                  leadingItems={
                    <MenuItem onClick={markUnread}>Mark unread</MenuItem>
                  }
                  overflowItems={
                    <>
                      <MenuItem>Delete message</MenuItem>
                      <MenuItem>Follow thread</MenuItem>
                    </>
                  }
                >
                  <div data-message-id="one" data-layout="timeline">
                    <p>
                      Before{" "}
                      <ContextMenuRoot>
                        <ContextMenuTrigger
                          render={
                            <a
                              href="https://example.org/"
                              data-link-label="Quote me"
                            />
                          }
                        >
                          Quote me
                        </ContextMenuTrigger>
                        <MenuPopup>
                          <MenuItem>Copy selected link</MenuItem>
                        </MenuPopup>
                      </ContextMenuRoot>{" "}
                      after
                    </p>
                  </div>
                </MessageActionBar>
              )}
              {more && (
                <MessageActionBar
                  messageId="one"
                  copyText={() => "Whole message"}
                />
              )}
              {other && (
                <div data-message-id="two" data-layout="timeline">
                  <p>Other message</p>
                  <MessageActionBar
                    messageId="two"
                    copyText={() => "Other message"}
                  />
                </div>
              )}
              <textarea aria-label="Draft" />
            </section>
          </MessageContextMenus>
        </ConversationPresentation>
      </ToastProvider>
    );
  }
  const view = render(<Conversation active={active} />, {
    wrapper: StrictMode,
  });
  const list = screen.getByRole("region", { name: "Messages" });
  const link = screen.getByRole("link", { name: "Quote me" });
  cleanups.push(registerMessageList(list, controller));
  const select = () => {
    const range = document.createRange();
    range.selectNodeContents(link);
    act(() => {
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
  };
  select();
  const open = (x = 20) => {
    fireEvent.pointerDown(link, { button: 2, clientX: x, clientY: 110 });
    return fireEvent.contextMenu(link, {
      button: 2,
      clientX: x,
      clientY: 110,
    });
  };
  return {
    controller,
    markUnread,
    list,
    link,
    open,
    select,
    view,
    Conversation,
  };
}

it("prepends selection actions to the message menu, including over a selected link", async () => {
  const user = userEvent.setup();
  const { open, markUnread, controller } = setup();
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.queryByRole("button", { name: "Quote highlight" })).toBeNull();
  expect(open()).toBe(false);
  await screen.findByRole("menuitem", { name: "Quote highlight" });
  expect(screen.getAllByRole("menu")).toHaveLength(1);
  expect(
    screen.queryByRole("menuitem", { name: "Copy selected link" }),
  ).toBeNull();
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent),
  ).toEqual([
    "Copy highlight",
    "Quote highlight",
    "Copy link URL",
    "Mark unread",
    "Copy message",
    "Copy message link",
    "Forward message",
    "Delete message",
    "Follow thread",
  ]);
  await user.click(
    await screen.findByRole("menuitem", { name: "Mark unread" }),
  );
  expect(markUnread).toHaveBeenCalledOnce();
  expect(controller.quote).not.toHaveBeenCalled();
});

it("copies the whole message or the captured highlight independently", async () => {
  const user = userEvent.setup();
  const copy = vi.spyOn(clipboard, "writeClipboardText").mockResolvedValue();
  const rich = vi
    .spyOn(clipboard, "writeClipboardRichText")
    .mockResolvedValue();
  const { open, select, controller, link } = setup();
  const authored = "/panel/release-notes?mode=compact#summary";
  link.setAttribute("href", authored);
  open();
  await user.click(
    await screen.findByRole("menuitem", { name: "Copy link URL" }),
  );
  link.setAttribute("href", "https://example.org/");
  select();
  open();
  await user.click(
    await screen.findByRole("menuitem", { name: "Copy message link" }),
  );
  select();
  open();
  await user.click(
    await screen.findByRole("menuitem", { name: "Copy message" }),
  );
  select();
  open();
  const item = await screen.findByRole("menuitem", { name: "Copy highlight" });
  act(() => document.getSelection()?.removeAllRanges());
  await user.click(item);
  expect(copy.mock.calls.map(([text]) => text)).toEqual([
    authored,
    "buzz://message?channel=general&id=one",
    "Whole message",
  ]);
  expect(rich).toHaveBeenCalledExactlyOnceWith(
    "Quote me (https://example.org/)",
    '<div data-buzz-copy="timeline"><a href="https://example.org/">Quote me</a></div>',
    { fallbackToPlainText: true },
  );
  expect(controller.quote).not.toHaveBeenCalled();
});

it.each(["another row", "both rows", "ends at row start"])(
  "limits overflow highlight actions to contributing rows: %s",
  async (mode) => {
    const user = userEvent.setup();
    const { link } = setup({ other: true });
    const other = screen.getByText("Other message", { selector: "p" });
    if (mode !== "another row") {
      const range = document.createRange();
      range.setStart(link.firstChild as Node, 0);
      range.setEnd(
        other.firstChild as Node,
        mode === "both rows" ? (other.textContent ?? "").length : 0,
      );
      act(() => {
        document.getSelection()?.removeAllRanges();
        document.getSelection()?.addRange(range);
      });
    }
    const more = screen.getByRole("button", { name: "More message actions" });
    fireEvent.pointerDown(more, { pointerType: "touch" });
    // Focus may clear the live range; the captured row membership must survive.
    act(() => document.getSelection()?.removeAllRanges());
    fireEvent.mouseDown(more, { button: 0, detail: 1 });
    fireEvent.mouseUp(more);
    fireEvent.click(more);
    await screen.findByRole("menuitem", { name: "Copy message" });
    expect(!!screen.queryByRole("menuitem", { name: "Copy highlight" })).toBe(
      mode === "both rows",
    );
    expect(!!screen.queryByRole("menuitem", { name: "Quote highlight" })).toBe(
      mode === "both rows",
    );
    await user.keyboard("{Escape}");
  },
);

it.each(["dismissed", "hidden", "unmounted"])(
  "keeps the captured highlight painted until the menu is %s",
  async (close) => {
    // jsdom has no Custom Highlight API; the real-engine journey checks paint styles.
    class FakeHighlight extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    }
    const highlights = new Map<string, FakeHighlight>();
    vi.stubGlobal("CSS", { ...globalThis.CSS, highlights });
    vi.stubGlobal("Highlight", FakeHighlight);
    const user = userEvent.setup();
    const { open, view, Conversation, controller } = setup();
    open();
    await screen.findByRole("menuitem", { name: "Quote highlight" });
    const painted = highlights.get("buzz-message-highlight");
    expect([...(painted ?? [])].map((range) => range.toString())).toEqual([
      "Quote me",
    ]);
    act(() => document.getSelection()?.removeAllRanges());
    expect([...(painted ?? [])].map((range) => range.toString())).toEqual([
      "Quote me",
    ]);
    if (close === "dismissed") await user.keyboard("{Escape}");
    else if (close === "hidden") view.rerender(<Conversation active={false} />);
    else view.unmount();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(controller.quote).not.toHaveBeenCalled();
    expect(highlights.has("buzz-message-highlight")).toBe(false);
    expect(
      document.documentElement.hasAttribute("data-message-highlight"),
    ).toBe(false);
  },
);

it("drops a queued quote when its message is removed before dismissal completes", async () => {
  const { open, controller, view, Conversation } = setup();
  open();
  const item = await screen.findByRole("menuitem", { name: "Quote highlight" });
  act(() => {
    fireEvent.click(item);
    view.rerender(<Conversation active show={false} />);
  });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(controller.quote).not.toHaveBeenCalled();
});

it.each(["context", "touch overflow"])(
  "quotes from %s after focus has cleared the live range",
  async (source) => {
    const user = userEvent.setup();
    const { open, controller } = setup({ more: source === "touch overflow" });
    const draft = screen.getByRole("textbox", { name: "Draft" });
    vi.mocked(controller.quote).mockImplementation(() => {
      draft.focus();
      return true;
    });
    if (source === "context") open();
    else {
      const more = screen.getByRole("button", { name: "More message actions" });
      const touch = new MouseEvent("pointerdown", { bubbles: true });
      Object.defineProperty(touch, "pointerType", { value: "touch" });
      fireEvent(more, touch);
      act(() => document.getSelection()?.removeAllRanges());
      fireEvent.mouseDown(more, { button: 0, detail: 1 });
      fireEvent.mouseUp(more);
      fireEvent.click(more);
    }
    const item = await screen.findByRole("menuitem", {
      name: "Quote highlight",
    });
    act(() => document.getSelection()?.removeAllRanges());
    await user.click(item);
    await waitFor(() =>
      expect(controller.quote).toHaveBeenCalledExactlyOnceWith(
        '<div data-buzz-copy="timeline"><a href="https://example.org/">Quote me</a></div>',
        [],
      ),
    );
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(draft);
  },
);

it.each(["unavailable", "rejected"])(
  "reports a %s quote and restores source focus",
  async (failure) => {
    const user = userEvent.setup();
    const { open, controller, list } = setup();
    open();
    const item = await screen.findByRole("menuitem", {
      name: "Quote highlight",
    });
    if (failure === "unavailable")
      vi.spyOn(controller, "canQuote").mockReturnValue(false);
    else vi.mocked(controller.quote).mockReturnValue(false);
    act(() => item.focus());
    await user.keyboard("{Enter}");
    await screen.findByText("Couldn’t quote. Select the text and try again.");
    await waitFor(() => expect(document.activeElement).toBe(list));
    expect(controller.quote).toHaveBeenCalledTimes(
      failure === "unavailable" ? 0 : 1,
    );
  },
);

it("reports clipboard failure", async () => {
  const user = userEvent.setup();
  vi.spyOn(clipboard, "writeClipboardRichText").mockRejectedValue(
    new Error("Denied"),
  );
  const { open } = setup();
  open();
  await user.click(
    await screen.findByRole("menuitem", { name: "Copy highlight" }),
  );
  await screen.findByText("Couldn’t copy. Try again from the message menu.");
});

it.each([{ canQuote: false }, { active: false }])(
  "leaves the link menu available when quoting is unavailable: %j",
  async (options) => {
    const { open } = setup(options);
    open();
    await screen.findByRole("menuitem", { name: "Copy selected link" });
    expect(
      screen.queryByRole("menuitem", { name: "Quote highlight" }),
    ).toBeNull();
  },
);

it("leaves clicks outside the highlight with the link menu", async () => {
  const { open } = setup();
  open(200);
  await screen.findByRole("menuitem", { name: "Copy selected link" });
  expect(
    screen.queryByRole("menuitem", { name: "Quote highlight" }),
  ).toBeNull();
});

it("leaves an editor's selection native", () => {
  setup();
  const field = screen.getByRole("textbox", { name: "Draft" });
  expect(fireEvent.contextMenu(field, { clientX: 20, clientY: 200 })).toBe(
    true,
  );
  expect(screen.queryByRole("menu")).toBeNull();
});

it("does not intercept a word first selected by the secondary press", async () => {
  const { link, select } = setup();
  act(() => document.getSelection()?.removeAllRanges());
  fireEvent.pointerDown(link, { button: 2, clientX: 20, clientY: 110 });
  select();
  fireEvent.contextMenu(link, { button: 2, clientX: 20, clientY: 110 });
  await screen.findByRole("menuitem", { name: "Copy selected link" });
  expect(
    screen.queryByRole("menuitem", { name: "Quote highlight" }),
  ).toBeNull();
});
