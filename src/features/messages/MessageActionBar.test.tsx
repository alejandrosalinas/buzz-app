// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  StrictMode,
  useRef,
  type ReactElement,
  type ComponentProps,
  type ReactNode,
} from "react";
import { ConversationPresentation } from "../conversation/ConversationPresentation";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { useKeyboardFocusVisibility } from "../../shared/design-system/useKeyboardFocusVisibility";
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: ToastProvider });
import { MessageActionBar } from "./MessageActionBar";
import { MenuItem } from "../../shared/design-system/ui/Menu";
import { PreviewCard } from "../../shared/design-system/ui/PreviewCard";
import { hoverOpenTiming } from "../../shared/design-system/ui/hoverIntent";
import { createPortal } from "react-dom";
import { MessageLink } from "../conversation/MessageLink";
import { LinkThreadTabContext } from "../conversation/LinkLabelContext";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([true, false])(
  "offers forwarding in the toolbar and menu with link available=%s",
  async (available) => {
    pointerMedia(false);
    const user = userEvent.setup();
    const forward = vi.fn();
    render(
      <Row
        copyText={() => "Message"}
        link={available ? "buzz://message?channel=alpha&id=abc" : undefined}
        onForward={forward}
      />,
    );
    fireEvent.pointerEnter(screen.getByTestId("message"));
    const button = await screen.findByRole("button", {
      name: "Forward message",
    });
    expect((button as HTMLButtonElement).disabled).toBe(!available);
    if (available) {
      await user.click(button);
      expect(forward).toHaveBeenCalledTimes(1);
    }
    await user.click(
      screen.getByRole("button", { name: "More message actions" }),
    );
    const item = await screen.findByRole("menuitem", {
      name: "Forward message",
    });
    expect(item.hasAttribute("data-disabled")).toBe(!available);
    if (available) {
      await user.click(item);
      await waitFor(() => expect(forward).toHaveBeenCalledTimes(2));
      expect(screen.queryByRole("menu")).toBeNull();
    }
  },
);

function Row(props: ComponentProps<typeof MessageActionBar>) {
  const rowRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rowRef} data-testid="message">
      <span>Message author</span>
      <div data-message-action-anchor>
        <span>Message bubble</span>
      </div>
      <div data-message-attachments>
        <span>Message attachment</span>
      </div>
      <MessageActionBar {...props} rowRef={rowRef} />
    </div>
  );
}

function KeyboardModality({ children }: { children: ReactNode }) {
  useKeyboardFocusVisibility();
  return children;
}

function pointerMedia(matches = true) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const listeners = new Set<() => void>();
  const query = {
    matches,
    addEventListener: (_: string, listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) =>
      listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", () => query);
  return (next: boolean) =>
    act(() => {
      query.matches = next;
      for (const listener of listeners) listener();
    });
}

it("leaves portalled message content outside its context-menu target", () => {
  render(
    <MessageActionBar copyText={() => "Message"}>
      <div>
        <button type="button">Expand coordination</button>
        {createPortal(
          <button type="button">Viewer content</button>,
          document.body,
        )}
      </div>
    </MessageActionBar>,
  );
  const viewer = screen.getByRole("button", { name: "Viewer content" });
  expect(
    fireEvent.contextMenu(viewer, { clientX: 20, clientY: 20, button: 2 }),
  ).toBe(true);
  fireEvent.keyDown(viewer, { key: "F10", shiftKey: true });
  expect(screen.queryByRole("menu")).toBeNull();
});

it.each([
  ["external", "{Shift>}{F10}{/Shift}"],
  ["external", "{ContextMenu}"],
  ["thread", "{Shift>}{F10}{/Shift}"],
  ["thread", "{ContextMenu}"],
])(
  "leaves a nested %s link's %s menu to the link owner",
  async (kind, keys) => {
    const user = userEvent.setup();
    render(
      <LinkThreadTabContext value={() => true}>
        <MessageActionBar copyText={() => "Message"}>
          <div>
            <button type="button">Coordination</button>
            <MessageLink
              url={
                kind === "external"
                  ? "https://example.com/context"
                  : `buzz://message?channel=alpha&id=${"a".repeat(64)}`
              }
              label="Nested destination"
              registry={undefined}
              onOpenLink={() => true}
            />
          </div>
        </MessageActionBar>
      </LinkThreadTabContext>,
    );
    const link = screen.getByRole("link", { name: "Nested destination" });
    link.focus();
    await user.keyboard(keys);
    await screen.findByRole("menuitem", {
      name: kind === "external" ? "Open in browser" : "Open link",
    });
    expect(screen.getAllByRole("menu", { hidden: true })).toHaveLength(1);
    expect(screen.queryByRole("menuitem", { name: "Copy message" })).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(link));
    const row = screen.getByRole("button", { name: "Coordination" });
    row.focus();
    await user.keyboard(keys);
    await screen.findByRole("menuitem", { name: "Copy message" });
    expect(screen.getAllByRole("menu", { hidden: true })).toHaveLength(1);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(row));
  },
);

it("defers desktop controls until row interaction and retains them after leaving", () => {
  pointerMedia();
  render(
    <StrictMode>
      <Row copyText={() => "Hello"} />
    </StrictMode>,
  );
  expect(
    screen.queryByRole("button", {
      name: "More message actions",
      hidden: true,
    }),
  ).toBeNull();
  fireEvent.pointerEnter(screen.getByTestId("message"));
  const trigger = screen.getByRole("button", {
    name: "More message actions",
    hidden: true,
  });
  fireEvent.pointerLeave(screen.getByTestId("message"));
  expect(
    screen.getByRole("button", { name: "More message actions", hidden: true }),
  ).toBe(trigger);
});

it("reveals actions only over message content or the toolbar, not the row's empty space", () => {
  pointerMedia();
  render(
    <StrictMode>
      <Row copyText={() => "Hello"} />
    </StrictMode>,
  );
  const row = screen.getByTestId("message");
  // First entry prepares the lazy controls without revealing them over whitespace.
  fireEvent.pointerEnter(row);
  const bar = screen.getByRole("group", { hidden: true });
  fireEvent.pointerLeave(row);
  fireEvent.pointerEnter(row);
  fireEvent.pointerOver(row);
  expect(row.hasAttribute("data-actions-revealed")).toBe(false);
  for (const content of ["Message bubble", "Message attachment"]) {
    const target = screen.getByText(content);
    fireEvent.pointerOver(target, { relatedTarget: row });
    expect(row.hasAttribute("data-actions-revealed")).toBe(true);
    fireEvent.pointerOut(target, { relatedTarget: bar });
    expect(row.hasAttribute("data-actions-revealed")).toBe(true);
    fireEvent.pointerOver(bar, { relatedTarget: target });
    expect(row.hasAttribute("data-actions-revealed")).toBe(true);
    fireEvent.pointerOut(bar, { relatedTarget: row });
    expect(row.hasAttribute("data-actions-revealed")).toBe(false);
  }
  fireEvent.pointerOver(screen.getByText("Message author"));
  expect(row.hasAttribute("data-actions-revealed")).toBe(false);
});

it("keeps actions under the row's own open preview card until it closes", async () => {
  pointerMedia();
  function PreviewRow({ open }: { open: boolean }) {
    const rowRef = useRef<HTMLDivElement>(null);
    return (
      <div ref={rowRef} data-testid="message">
        <div data-message-action-anchor>
          <PreviewCard
            open={open}
            trigger={<a href="#linked">Linked message</a>}
            link={<a href="#linked" />}
            aria-label="Message preview"
          >
            Preview body
          </PreviewCard>
        </div>
        <MessageActionBar rowRef={rowRef} copyText={() => "Linked message"} />
      </div>
    );
  }
  const view = render(<PreviewRow open />);
  const row = screen.getByTestId("message");
  const link = screen.getByRole("link", { name: "Linked message" });
  const card = screen.getByText("Preview body");
  // An open card keeps only actions that are already shown.
  expect(row.hasAttribute("data-actions-revealed")).toBe(false);
  fireEvent.pointerEnter(row);
  fireEvent.pointerOver(link);
  expect(row.hasAttribute("data-actions-revealed")).toBe(true);
  // A card growing over its trigger under a still pointer leaves for a frame.
  fireEvent.pointerOut(link, { relatedTarget: card });
  expect(row.hasAttribute("data-actions-revealed")).toBe(true);
  fireEvent.pointerOver(link, { relatedTarget: card });
  expect(row.hasAttribute("data-actions-revealed")).toBe(true);
  // Off the bubble's edge and back while the card is open: hiding here would
  // show the actions again above the card.
  fireEvent.pointerOut(link, { relatedTarget: row });
  fireEvent.pointerOver(row, { relatedTarget: link });
  expect(row.hasAttribute("data-actions-revealed")).toBe(true);
  fireEvent.pointerOut(row, { relatedTarget: link });
  fireEvent.pointerOver(link, { relatedTarget: row });
  fireEvent.pointerOut(link, { relatedTarget: card });
  expect(row.hasAttribute("data-actions-revealed")).toBe(true);
  // The row never hears the pointer leave the portaled card; its close ends it.
  await act(async () => view.rerender(<PreviewRow open={false} />));
  expect(row.hasAttribute("data-actions-revealed")).toBe(false);
  // A closed card holds nothing: the row's empty space hides the actions.
  fireEvent.pointerOver(link, { relatedTarget: row });
  expect(row.hasAttribute("data-actions-revealed")).toBe(true);
  fireEvent.pointerOut(link, { relatedTarget: row });
  fireEvent.pointerOver(row, { relatedTarget: link });
  expect(row.hasAttribute("data-actions-revealed")).toBe(false);
  await act(async () => view.rerender(<PreviewRow open />));
  expect(row.hasAttribute("data-actions-revealed")).toBe(false);
});

it("keeps actions under a preview card that reopens during its exit", async () => {
  pointerMedia();
  vi.useFakeTimers();
  const rest = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
  // jsdom has no top layer. Model its order: the last popover shown is on top.
  const layer: Element[] = [];
  HTMLElement.prototype.showPopover = function () {
    if (!layer.includes(this)) layer.push(this);
  };
  HTMLElement.prototype.hidePopover = function () {
    if (layer.includes(this)) layer.splice(layer.indexOf(this), 1);
  };
  function PreviewRow() {
    const rowRef = useRef<HTMLDivElement>(null);
    return (
      <div ref={rowRef} data-testid="message">
        <div data-message-action-anchor>
          <PreviewCard
            trigger={<a href="#linked">Linked message</a>}
            link={<a href="#linked" />}
            aria-label="Message preview"
          >
            Preview body
          </PreviewCard>
        </div>
        <MessageActionBar rowRef={rowRef} copyText={() => "Linked message"} />
      </div>
    );
  }
  let release = () => {};
  try {
    render(<PreviewRow />);
    const row = screen.getByTestId("message");
    const link = screen.getByRole("link", { name: "Linked message" });
    fireEvent.pointerEnter(row);
    const bar = screen.getByRole("group", { hidden: true });
    fireEvent.pointerOver(link);
    fireEvent.mouseEnter(link);
    fireEvent.mouseMove(link);
    await rest(hoverOpenTiming.preview.delay);
    const card = screen.getByRole("link", {
      name: "Message preview",
      hidden: true,
    });
    const positioner = card.parentElement;
    expect(layer).toEqual([bar, positioner]);
    // Hold the card's exit at Base UI's animation boundary.
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    const animations = vi.fn(() => [{ finished }]);
    Object.defineProperty(card, "getAnimations", { value: animations });
    // Off the bubble's edge into the row's empty space until the card's close
    // grace ends. Its close releases the hold on the actions.
    fireEvent.pointerOut(link, { relatedTarget: row });
    fireEvent.pointerOver(row, { relatedTarget: link });
    fireEvent.mouseLeave(link, { relatedTarget: row });
    await rest(hoverOpenTiming.preview.closeDelay);
    expect(link.hasAttribute("data-popup-open")).toBe(false);
    // Base UI reads the exit's animations a frame after the close.
    await rest(16);
    expect(animations).toHaveBeenCalled();
    expect(layer).toEqual([positioner]);
    // Back onto the link while the card is still exiting. One pointer move
    // shows the actions again and reopens the same card before React commits
    // either, so the card must join the top layer after that commit.
    act(() => {
      fireEvent.pointerOut(row, { relatedTarget: link });
      fireEvent.pointerOver(link, { relatedTarget: row });
      fireEvent.mouseEnter(link, { relatedTarget: row });
    });
    await rest(0);
    expect(link.hasAttribute("data-popup-open")).toBe(true);
    expect(card.isConnected).toBe(true);
    expect(layer).toEqual([bar, positioner]);
  } finally {
    await act(async () => release());
    vi.useRealTimers();
    Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
    Reflect.deleteProperty(HTMLElement.prototype, "hidePopover");
  }
});

it("keeps timestamp hover and keyboard focus separate from message actions", () => {
  pointerMedia();
  function TimeRow() {
    const rowRef = useRef<HTMLDivElement>(null);
    return (
      <div ref={rowRef} data-testid="message">
        <div data-message-action-anchor>
          <button type="button" data-media-timecode>
            0:18
          </button>
          <span>Comment body</span>
        </div>
        <MessageActionBar rowRef={rowRef} copyText={() => "Comment body"} />
      </div>
    );
  }
  render(<TimeRow />);
  const row = screen.getByTestId("message");
  const time = screen.getByRole("button", { name: "0:18" });
  const body = screen.getByText("Comment body");
  fireEvent.pointerEnter(row);
  fireEvent.pointerOver(body);
  expect(row.hasAttribute("data-actions-revealed")).toBe(true);
  fireEvent.pointerOut(body, { relatedTarget: time });
  fireEvent.pointerOver(time);
  expect(row.hasAttribute("data-actions-revealed")).toBe(false);
  document.documentElement.setAttribute("data-keyboard-navigation", "");
  try {
    act(() => time.focus());
    expect(row.hasAttribute("data-actions-revealed")).toBe(false);
  } finally {
    document.documentElement.removeAttribute("data-keyboard-navigation");
  }
  act(() => time.blur());
  fireEvent.pointerOver(body);
  expect(row.hasAttribute("data-actions-revealed")).toBe(true);
});

it("keeps reaction hover separate from message actions without losing keyboard access", async () => {
  pointerMedia();
  function ReactionRow() {
    const rowRef = useRef<HTMLDivElement>(null);
    return (
      <div ref={rowRef} data-testid="message">
        <div data-message-action-anchor>
          <span>Message body</span>
          <div data-message-reactions>
            <button type="button">Existing reaction</button>
            <button type="button">Add reaction</button>
          </div>
        </div>
        <MessageActionBar rowRef={rowRef} copyText={() => "Message body"} />
        <div>
          <span data-message-reactions>
            <button type="button">First reaction</button>
          </span>
          <span>Unused reaction space</span>
        </div>
      </div>
    );
  }
  render(<ReactionRow />);
  const row = screen.getByTestId("message");
  const body = screen.getByText("Message body");
  const reaction = screen.getByRole("button", { name: "Existing reaction" });
  const plus = screen.getByRole("button", { name: "Add reaction" });
  // The first entry mounts deferred controls; jsdom cannot retain native :hover.
  fireEvent.pointerEnter(row);
  fireEvent.pointerEnter(row);
  fireEvent.pointerOver(body);
  expect(row.hasAttribute("data-actions-revealed")).toBe(true);
  fireEvent.pointerOut(body, { relatedTarget: reaction });
  fireEvent.pointerOver(reaction, { relatedTarget: body });
  expect(row.hasAttribute("data-actions-revealed")).toBe(false);
  fireEvent.pointerOut(reaction, { relatedTarget: plus });
  fireEvent.pointerOver(plus, { relatedTarget: reaction });
  expect(row.hasAttribute("data-actions-revealed")).toBe(false);
  fireEvent.pointerOut(plus, { relatedTarget: body });
  fireEvent.pointerOver(body, { relatedTarget: plus });
  expect(row.hasAttribute("data-actions-revealed")).toBe(true);
  const actions = screen.getByRole("group", { hidden: true });
  fireEvent.pointerOut(body, { relatedTarget: actions });
  fireEvent.pointerOver(actions, { relatedTarget: body });
  expect(row.hasAttribute("data-actions-revealed")).toBe(true);
  fireEvent.pointerOut(actions, { relatedTarget: document.body });
  fireEvent.pointerLeave(row);
  expect(row.hasAttribute("data-actions-revealed")).toBe(false);
  fireEvent.pointerEnter(row);
  fireEvent.pointerOver(reaction);
  expect(row.hasAttribute("data-actions-revealed")).toBe(false);
  fireEvent.pointerOver(screen.getByRole("button", { name: "First reaction" }));
  expect(row.hasAttribute("data-actions-revealed")).toBe(false);
  fireEvent.pointerOver(screen.getByText("Unused reaction space"));
  expect(row.hasAttribute("data-actions-revealed")).toBe(false);
  fireEvent.pointerOver(reaction);
  expect(row.hasAttribute("data-actions-revealed")).toBe(false);
  document.documentElement.setAttribute("data-keyboard-navigation", "");
  try {
    act(() => reaction.focus());
    expect(row.hasAttribute("data-actions-revealed")).toBe(true);
    fireEvent.click(
      screen.getByRole("button", {
        name: "More message actions",
        hidden: true,
      }),
    );
    await screen.findByRole("menu");
    fireEvent.pointerOver(reaction);
    expect(row.hasAttribute("data-actions-revealed")).toBe(true);
  } finally {
    document.documentElement.removeAttribute("data-keyboard-navigation");
  }
});

it("prepares untouched rows synchronously for Tab navigation and leaves new pointer rows deferred", () => {
  pointerMedia();
  const view = (extra = false) => (
    <KeyboardModality>
      <Row copyText={() => "First"} />
      <Row copyText={() => "Second"} />
      {extra && <Row copyText={() => "Third"} />}
    </KeyboardModality>
  );
  const { rerender } = render(view());
  fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
  expect(screen.queryAllByRole("button", { hidden: true })).toHaveLength(0);
  const atDefaultAction = vi.fn(() => {
    expect(
      screen.getAllByRole("button", {
        name: "More message actions",
        hidden: true,
      }),
    ).toHaveLength(2);
  });
  window.addEventListener("keydown", atDefaultAction, { once: true });
  fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
  expect(atDefaultAction).toHaveBeenCalledOnce();
  fireEvent.pointerDown(window);
  rerender(view(true));
  expect(
    screen.getAllByRole("button", {
      name: "More message actions",
      hidden: true,
    }),
  ).toHaveLength(2);
  fireEvent.keyDown(window, { key: "Tab" });
  expect(
    screen.getAllByRole("button", {
      name: "More message actions",
      hidden: true,
    }),
  ).toHaveLength(3);
});

it("renders coarse-pointer controls immediately and activates when pointer capability changes", () => {
  const changePointer = pointerMedia(false);
  const { rerender } = render(<Row key="touch" copyText={() => "Touch"} />);
  expect(
    screen.getByRole("button", { name: "More message actions", hidden: true }),
  ).toBeTruthy();
  changePointer(true);
  rerender(<Row key="desktop" copyText={() => "Desktop"} />);
  expect(
    screen.queryByRole("button", {
      name: "More message actions",
      hidden: true,
    }),
  ).toBeNull();
  changePointer(false);
  expect(
    screen.getByRole("button", { name: "More message actions", hidden: true }),
  ).toBeTruthy();
});
it("replies and exposes real sibling controls without placeholders", () => {
  const reply = vi.fn();
  render(<MessageActionBar onReply={reply} copyText={() => "Hello"} />);
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  expect(reply).toHaveBeenCalledOnce();
  expect(
    screen.getByRole("button", { name: "Copy link" }).hasAttribute("disabled"),
  ).toBe(true);
});
it("opens with keyboard, invokes a sibling action, and returns focus on Escape", async () => {
  const user = userEvent.setup();
  const action = vi.fn();
  render(
    <MessageActionBar
      copyText={() => "Hello"}
      overflowItems={<MenuItem onClick={action}>Edit message</MenuItem>}
    />,
  );
  const trigger = screen.getByRole("button", { name: "More message actions" });
  trigger.focus();
  await user.keyboard("{Enter}");
  await user.click(
    await screen.findByRole("menuitem", { name: "Edit message" }),
  );
  expect(action).toHaveBeenCalledOnce();
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  trigger.focus();
  await user.keyboard("{Enter}");
  const menu = await screen.findByRole("menu");
  await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
it.each(["{Escape}", "{ArrowDown}{Escape}"])(
  "returns focus after pointer open then keyboard close: %s",
  async (keys) => {
    const user = userEvent.setup();
    render(<MessageActionBar copyText={() => "Hello"} />);
    const trigger = screen.getByRole("button", {
      name: "More message actions",
    });
    await user.click(trigger);
    const menu = await screen.findByRole("menu");
    await waitFor(() =>
      expect(menu.contains(document.activeElement)).toBe(true),
    );
    await user.keyboard(keys);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
  },
);
it("keeps keyboard retry reachable after pointer open and a failed copy", async () => {
  const user = userEvent.setup();
  const write = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValueOnce();
  render(<MessageActionBar copyText={() => "Hello"} />);
  const trigger = screen.getByRole("button", { name: "More message actions" });
  await user.click(trigger);
  const menu = await screen.findByRole("menu");
  await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
  await user.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(
    screen.getByRole("menuitem", { name: "Copy message" }),
  );
  await user.keyboard("{Enter}");
  await screen.findByText("Couldn’t copy. Try again from the message menu.");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  await user.keyboard("{Enter}");
  const retry = await screen.findByRole("menuitem", { name: "Copy message" });
  await waitFor(() => expect(document.activeElement).toBe(retry));
  await user.keyboard("{Enter}");
  await screen.findByText("Message copied");
  expect(write).toHaveBeenCalledTimes(2);
  expect(write).toHaveBeenLastCalledWith("Hello");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
it("copies the message, shows failure, and allows retry", async () => {
  const user = userEvent.setup();
  const write = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValueOnce();
  render(<MessageActionBar copyText={() => "Hello"} />);
  const trigger = screen.getByRole("button", { name: "More message actions" });
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "Copy message" }),
  );
  await screen.findByText("Couldn’t copy. Try again from the message menu.");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(document.activeElement).not.toBe(trigger);
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "Copy message" }),
  );
  const copied = await screen.findByText("Message copied");
  expect(copied.closest(".buzz-toast")).not.toBeNull();
  expect(write).toHaveBeenLastCalledWith("Hello");
});
it("prevents duplicate clipboard writes until the first settles", async () => {
  userEvent.setup();
  let finish!: () => void;
  const write = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <MessageActionBar
      link="buzz://link"
      copyText={() => "Hello"}
      replyDisabled
      onReply={() => {}}
    />,
  );
  const link = screen.getByRole("button", { name: "Copy link" });
  fireEvent.click(link);
  try {
    expect(link.hasAttribute("disabled")).toBe(true);
    fireEvent.click(link);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("buzz://link");
    expect(
      screen.getByRole("button", { name: "Reply" }).hasAttribute("disabled"),
    ).toBe(true);
  } finally {
    finish();
  }
  await screen.findByText("Link copied");
  expect(link.hasAttribute("disabled")).toBe(false);
});

it.each([false, true])(
  "sends from the overflow menu and keeps feedback after it closes (failure=%s)",
  async (failure) => {
    const user = userEvent.setup();
    const send = vi.fn(() => {
      if (failure) throw new Error("Join the conversation before posting");
    });
    render(
      <MessageActionBar copyText={() => "Reply"} onSendToChannel={send} />,
    );
    await user.click(
      screen.getByRole("button", { name: "More message actions" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Send to channel" }),
    );
    expect(send).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(
      await screen.findByText(
        failure ? "Join the conversation before posting" : "Sending to channel",
      ),
    ).toBeTruthy();
  },
);

it("retires the native top-layer bar and its open menu with the source", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const show = vi.fn(function (this: HTMLElement) {
      this.style.display = "block";
    }),
    hide = vi.fn(function (this: HTMLElement) {
      this.style.display = "";
    });
  HTMLElement.prototype.showPopover = show;
  HTMLElement.prototype.hidePopover = hide;
  function Visit({ active }: { active: boolean }) {
    const row = useRef<HTMLDivElement>(null);
    return (
      <ConversationPresentation value={active}>
        <div ref={row} data-testid="row" hidden={!active} inert={!active}>
          <MessageActionBar rowRef={row} copyText={() => "Source"} />
        </div>
      </ConversationPresentation>
    );
  }
  try {
    const view = render(<Visit active />);
    fireEvent.pointerEnter(screen.getByTestId("row"));
    // The first interaction now mounts lazy controls. jsdom has no real hover;
    // opening their menu supplies the floating owner's retained-open evidence.
    fireEvent.click(
      screen.getByRole("button", {
        name: "More message actions",
        hidden: true,
      }),
    );
    expect(await screen.findByRole("menu")).toBeTruthy();
    expect(show).toHaveBeenCalled();
    view.rerender(<Visit active={false} />);
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.body.querySelector('[popover="manual"]')).toBeNull();
    expect(hide).toHaveBeenCalled();
    view.rerender(<Visit active />);
    await act(() => Promise.resolve());
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  } finally {
    cleanup();
    Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
    Reflect.deleteProperty(HTMLElement.prototype, "hidePopover");
    vi.unstubAllGlobals();
  }
});
