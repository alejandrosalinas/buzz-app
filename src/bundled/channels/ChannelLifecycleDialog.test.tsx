// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ChannelLifecycleUnconfirmed,
  type ChannelLifecycleCapability,
} from "../../features/relay/channel-lifecycle";
import type { ChannelLifecycleAction } from "../../features/relay/channel-lifecycle-protocol";
import { ReadError } from "../../features/relay/errors";
import { ApiPaused } from "../../features/relay/http-admission";
import { PublishNotSent } from "../../features/relay/outbox";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { ChannelLifecycleDialog } from "./ChannelLifecycleDialog";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function capability() {
  return {
    available: true,
    load: vi.fn<ChannelLifecycleCapability["load"]>(),
    run: vi.fn<ChannelLifecycleCapability["run"]>(async () => {}),
    snapshot: () => ({ status: "ready", hidden: [] }),
    subscribe: () => () => {},
    observeRemoval: () => () => {},
    refreshVisibility: async () => {},
  } satisfies ChannelLifecycleCapability;
}
const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const warning = "This deletes the channel for everyone. You can’t undo this.";

function mount(
  lifecycle: ChannelLifecycleCapability,
  action: ChannelLifecycleAction = "delete",
) {
  const callbacks = { close: vi.fn(), completed: vi.fn(), failed: vi.fn() };
  const view = render(
    <ToastProvider>
      <ChannelLifecycleDialog
        channelId="id"
        channelName="Fixture"
        action={action}
        lifecycle={lifecycle}
        {...callbacks}
      />
    </ToastProvider>,
  );
  return { ...callbacks, view };
}

it("keeps a paused delete's confirmation and offers Retry only after the pause, re-running the action on each click", async () => {
  const lifecycle = capability();
  lifecycle.run
    .mockRejectedValueOnce(new ApiPaused(2500))
    .mockRejectedValueOnce(new ApiPaused(1000))
    .mockResolvedValueOnce();
  const { completed, failed } = mount(lifecycle);
  fireEvent.click(screen.getByRole("button", { name: "Delete channel" }));
  await flush();

  const dialog = screen.getByRole("dialog", { name: "Delete Fixture?" });
  const retry = screen.getByRole("button", { name: "Retry" });
  expect(retry).toHaveAttribute("aria-disabled", "true");
  expect(retry).toHaveAttribute("data-variant", "destructive");
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  // Keyboard and screen-reader users can still reach Retry and its state.
  retry.focus();
  expect(retry).toHaveFocus();
  expect(dialog).toHaveAccessibleDescription(
    `${warning} Relay requests are paused, so nothing was deleted. You can retry in 3 seconds.`,
  );
  expect(failed).not.toHaveBeenCalled();
  fireEvent.click(retry);
  expect(lifecycle.run).toHaveBeenCalledOnce();

  await advance(500);
  expect(dialog).toHaveAccessibleDescription(/retry in 2 seconds\.$/);
  await advance(1999);
  expect(dialog).toHaveAccessibleDescription(/retry in 1 second\.$/);
  expect(retry).toHaveAttribute("aria-disabled", "true");
  await advance(1);
  expect(dialog).toHaveAccessibleDescription(
    `${warning} Relay requests were paused, so nothing was deleted. You can retry now.`,
  );
  expect(retry).toHaveAttribute("aria-disabled", "false");
  // The pause ending never starts the action by itself.
  await advance(60_000);
  expect(lifecycle.run).toHaveBeenCalledOnce();

  // Each Retry is a full new run, so authorization is read again.
  fireEvent.click(retry);
  await flush();
  expect(lifecycle.run).toHaveBeenCalledTimes(2);
  expect(lifecycle.run).toHaveBeenLastCalledWith(
    "delete",
    "id",
    expect.any(AbortSignal),
  );
  const again = screen.getByRole("button", { name: "Retry" });
  expect(again).toHaveAttribute("aria-disabled", "true");
  await advance(1000);
  fireEvent.click(again);
  fireEvent.click(again);
  await flush();
  expect(lifecycle.run).toHaveBeenCalledTimes(3);
  expect(completed).toHaveBeenCalledOnce();
  expect(failed).not.toHaveBeenCalled();
});

it("holds a second click while a retried delete is pending", async () => {
  const lifecycle = capability();
  let finish!: () => void;
  lifecycle.run
    .mockRejectedValueOnce(new ApiPaused(0))
    .mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
  const { completed } = mount(lifecycle);
  fireEvent.click(screen.getByRole("button", { name: "Delete channel" }));
  await flush();
  const retry = screen.getByRole("button", { name: "Retry" });
  expect(retry).toHaveAttribute("aria-disabled", "false");
  fireEvent.click(retry);
  fireEvent.click(retry);
  await flush();
  expect(lifecycle.run).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  await act(async () => finish());
  expect(completed).toHaveBeenCalledOnce();
});

it.each(["cancel", "unmount"] as const)(
  "%s during a pause never runs the delete again",
  async (exit) => {
    const lifecycle = capability();
    lifecycle.run.mockRejectedValueOnce(new ApiPaused(5000));
    const { close, completed, view } = mount(lifecycle);
    fireEvent.click(screen.getByRole("button", { name: "Delete channel" }));
    await flush();
    expect(screen.getByRole("button", { name: "Retry" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    if (exit === "cancel") {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(close).toHaveBeenCalledOnce();
    } else {
      view.unmount();
    }
    await advance(10_000);
    expect(lifecycle.run).toHaveBeenCalledOnce();
    expect(completed).not.toHaveBeenCalled();
  },
);

it.each([
  [
    "a pause after a possible send",
    new ChannelLifecycleUnconfirmed(new ApiPaused(1000)),
  ],
  [
    "an unsent publication",
    new PublishNotSent("Relay requests paused; retry in 1s"),
  ],
  [
    "an untyped error with pause text",
    new ReadError(
      "unavailable",
      "Relay requests paused; retry in 1s",
      429,
      1000,
    ),
  ],
  ["any other failure", new Error("Relay rejected the request.")],
])("delete keeps the existing failure report for %s", async (_, error) => {
  const lifecycle = capability();
  lifecycle.run.mockRejectedValueOnce(error);
  const { failed } = mount(lifecycle);
  fireEvent.click(screen.getByRole("button", { name: "Delete channel" }));
  await flush();
  expect(failed).toHaveBeenCalledExactlyOnceWith(
    "Delete channel failed",
    error.message,
  );
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

it.each([
  ["leave", "Leave channel"],
  ["archive", "Archive channel"],
  ["unarchive", "Unarchive channel"],
  ["hide", "Hide conversation"],
] as const)(
  "%s keeps the existing failure report for a pause",
  async (action, label) => {
    const lifecycle = capability();
    lifecycle.run.mockRejectedValueOnce(new ApiPaused(1000));
    const { failed } = mount(lifecycle, action);
    fireEvent.click(screen.getByRole("button", { name: label }));
    await flush();
    expect(failed).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  },
);
