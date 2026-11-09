// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import {
  FAMILIAR_HINT_REST_MS,
  HELPFUL_HINT_REST_MS,
  PREVIEW_REST_MS,
} from "./hoverIntent";
import { PreviewCard } from "./PreviewCard";
import { Tooltip, TooltipProvider } from "./Tooltip";

afterEach(cleanup);

it("retains hover hints and click dismissal by default", async () => {
  const user = userEvent.setup();
  render(
    <Tooltip content="A hint">
      <button type="button">Action</button>
    </Tooltip>,
  );
  const action = screen.getByRole("button", { name: "Action" });
  await user.hover(action);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("A hint");
  await user.click(action);
  await waitFor(() =>
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
  );
});

function Feedback({ follow = "trigger" }: { follow?: "trigger" | "pointer" }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <>
      <span id="original">Original description</span>
      <Tooltip
        follow={follow}
        open={open}
        onOpenChange={setOpen}
        closeOnClick={false}
        content={copied ? "Copied" : "Copy value"}
      >
        <button
          type="button"
          aria-describedby="original"
          onClick={() => {
            setCopied(true);
            setOpen(true);
          }}
        >
          Copy
        </button>
      </Tooltip>
    </>
  );
}

it.each(["trigger", "pointer"] as const)(
  "shows %s feedback without losing descriptions and dismisses with Escape",
  async (follow) => {
    const user = userEvent.setup();
    render(<Feedback follow={follow} />);
    const action = screen.getByRole("button", { name: "Copy" });
    await user.click(action);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Copied");
    expect(action).toHaveAccessibleDescription("Original description Copied");
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
    );
    expect(action).toHaveAccessibleDescription("Original description");
  },
);

it("preserves an explicit trigger palette across the tooltip portal", async () => {
  const user = userEvent.setup();
  render(
    <div data-accent="bee" data-color-mode="light">
      <Tooltip content="Iris">
        <button type="button" data-accent="iris" data-color-mode="dark">
          Iris swatch
        </button>
      </Tooltip>
    </div>,
  );
  await user.hover(screen.getByRole("button", { name: "Iris swatch" }));
  const hint = await screen.findByRole("tooltip");
  expect(hint).toHaveAttribute("data-accent", "iris");
  expect(hint).toHaveAttribute("data-color-mode", "dark");
});

describe("hover intent", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const rest = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  it("opens a hint only after the pointer rests, restarting on movement", async () => {
    render(
      <Tooltip content="A hint">
        <button type="button">Action</button>
      </Tooltip>,
    );
    const action = screen.getByRole("button", { name: "Action" });
    fireEvent.mouseEnter(action);
    fireEvent.mouseMove(action, { movementX: 4 });
    await rest(HELPFUL_HINT_REST_MS - 100);
    fireEvent.mouseMove(action, { movementX: 4 });
    await rest(HELPFUL_HINT_REST_MS - 1);
    expect(screen.queryByRole("tooltip")).toBeNull();
    await rest(1);
    expect(screen.getByRole("tooltip")).toHaveTextContent("A hint");
  });

  it("waits longer before naming a familiar icon", async () => {
    render(
      <Tooltip content="Go back" hint="familiar">
        <button type="button">Back</button>
      </Tooltip>,
    );
    const back = screen.getByRole("button", { name: "Back" });
    fireEvent.mouseEnter(back);
    fireEvent.mouseMove(back);
    await rest(FAMILIAR_HINT_REST_MS - 1);
    expect(screen.queryByRole("tooltip")).toBeNull();
    await rest(1);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Go back");
  });

  it("opens even a familiar hint at once on keyboard focus", async () => {
    render(
      <Tooltip content="Go back" hint="familiar">
        <button type="button">Back</button>
      </Tooltip>,
    );
    act(() => screen.getByRole("button", { name: "Back" }).focus());
    await rest(0);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Go back");
  });

  it("keeps a pressed trigger's hint closed when focus returns, until Tab", async () => {
    render(
      <Tooltip content="Go back" hint="familiar">
        <button type="button">Back</button>
      </Tooltip>,
    );
    const back = screen.getByRole("button", { name: "Back" });
    // A menu opened by the press closes and hands focus back to its trigger.
    fireEvent.pointerDown(back, { pointerType: "mouse" });
    act(() => back.focus());
    await rest(0);
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => back.blur());
    fireEvent.keyDown(window, { key: "Tab" });
    act(() => back.focus());
    await rest(0);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Go back");
  });

  it("releases a pressed trigger when roving focus arrives from a sibling", async () => {
    render(
      <div role="tablist" aria-label="Apps" aria-orientation="vertical">
        <Tooltip content="Activity label" hint="dock">
          <button type="button" role="tab">
            Activity
          </button>
        </Tooltip>
        <Tooltip content="Messages label" hint="dock">
          <button type="button" role="tab">
            Messages
          </button>
        </Tooltip>
      </div>,
    );
    const activity = screen.getByRole("tab", { name: "Activity" });
    const messages = screen.getByRole("tab", { name: "Messages" });
    // Click Activity, then click Messages, then move back with an arrow key.
    fireEvent.pointerDown(activity, { pointerType: "mouse" });
    act(() => activity.focus());
    fireEvent.pointerDown(messages, { pointerType: "mouse" });
    act(() => messages.focus());
    fireEvent.keyDown(messages, { key: "ArrowUp" });
    act(() => activity.focus());
    await rest(0);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Activity label");
  });

  it("keeps a pressed trigger quiet after keys inside its own menu", async () => {
    render(
      <>
        <div role="tablist" aria-label="Apps">
          <Tooltip content="Activity label" hint="dock">
            <button type="button" role="tab">
              Activity
            </button>
          </Tooltip>
        </div>
        <div role="menu" aria-label="Tab actions">
          <button type="button" role="menuitem">
            Close
          </button>
        </div>
      </>,
    );
    const activity = screen.getByRole("tab", { name: "Activity" });
    const item = screen.getByRole("menuitem", { name: "Close" });
    fireEvent.pointerDown(activity, { pointerType: "mouse" });
    act(() => item.focus());
    fireEvent.keyDown(item, { key: "ArrowDown" });
    fireEvent.keyDown(item, { key: "Escape" });
    act(() => activity.focus());
    await rest(0);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("opens a neighbor at once while a hint in the same provider is showing", async () => {
    render(
      <TooltipProvider>
        <Tooltip content="First hint">
          <button type="button">First</button>
        </Tooltip>
        <Tooltip content="Second hint">
          <button type="button">Second</button>
        </Tooltip>
      </TooltipProvider>,
    );
    const first = screen.getByRole("button", { name: "First" });
    const second = screen.getByRole("button", { name: "Second" });
    fireEvent.mouseEnter(first);
    fireEvent.mouseMove(first);
    await rest(HELPFUL_HINT_REST_MS);
    expect(screen.getByRole("tooltip")).toHaveTextContent("First hint");
    fireEvent.mouseLeave(first, { relatedTarget: second });
    fireEvent.mouseEnter(second);
    fireEvent.mouseMove(second);
    await rest(0);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Second hint");
  });

  it("opens a preview only after the pointer rests on its trigger", async () => {
    render(
      <PreviewCard
        trigger={<a href="#profile">Profile</a>}
        aria-label="Preview"
      >
        Preview body
      </PreviewCard>,
    );
    const trigger = screen.getByRole("link", { name: "Profile" });
    fireEvent.mouseEnter(trigger);
    fireEvent.mouseMove(trigger, { movementX: 4 });
    await rest(PREVIEW_REST_MS - 100);
    fireEvent.mouseMove(trigger, { movementX: 4 });
    await rest(PREVIEW_REST_MS - 1);
    expect(screen.queryByText("Preview body")).toBeNull();
    await rest(1);
    expect(screen.getByText("Preview body")).toBeInTheDocument();
  });

  it("makes an action preview wait for a rest, but opens it at once on focus", async () => {
    function ActionPreview() {
      const action = useRef<HTMLButtonElement>(null);
      return (
        <PreviewCard
          trigger={<button type="button">View Ada profile</button>}
          aria-label="Ada profile preview"
          actionRef={action}
        >
          <button type="button" ref={action}>
            Open profile
          </button>
        </PreviewCard>
      );
    }
    render(<ActionPreview />);
    const trigger = screen.getByRole("button", { name: "View Ada profile" });
    fireEvent.mouseEnter(trigger);
    fireEvent.mouseMove(trigger, { movementX: 4 });
    await rest(PREVIEW_REST_MS - 1);
    expect(trigger).not.toHaveAttribute("data-popup-open");
    fireEvent.mouseLeave(trigger);
    await rest(PREVIEW_REST_MS);
    expect(trigger).not.toHaveAttribute("data-popup-open");
    act(() => trigger.focus());
    await rest(0);
    expect(trigger).toHaveAttribute("data-popup-open");
  });
});
