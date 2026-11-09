// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Communities } from "../../features/communities/service";
import type { Shortcut } from "../../features/shortcuts/service";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { MarkAllReadShortcut } from "./MarkAllReadShortcut";

afterEach(cleanup);
const origin = "https://relay.example";
const viewer = "a".repeat(64);

function setup({
  capability = "frontier-sync",
  unreadChannels = ["one"],
  selected = origin as string | null,
  connected = origin,
}: {
  capability?: string;
  unreadChannels?: string[];
  selected?: string | null;
  /** The community the relay session is actually connected to. */
  connected?: string;
} = {}) {
  const markAllChannelsRead = vi.fn(async () => []);
  const unread = {
    sync: () => ({ capability }),
    snapshot: ({ channelId }: { channelId: string }) => ({
      manual: "none",
      observedCount: unreadChannels.includes(channelId) ? 2 : 0,
    }),
    activity: () => ({ items: [] }),
    markAllChannelsRead,
  };
  const session = {
    unread,
    channels: { list: () => ({ channels: [{ id: "one" }, { id: "two" }] }) },
  };
  const client = {
    selected,
    memberships: [{ id: origin, name: "Acme Relay" }],
  };
  const relaySnapshot = {
    status: "ready" as const,
    scope: `${connected}:${viewer}`,
    session,
  };
  const communities = {
    subscribe: () => () => {},
    snapshot: () => client,
    relay: { subscribe: () => () => {}, snapshot: () => relaySnapshot },
  } as unknown as Communities;
  let registered: Shortcut | undefined;
  const dispose = vi.fn();
  const shortcuts = {
    registerHost(shortcut: Shortcut) {
      registered = shortcut;
      return dispose;
    },
  };
  render(
    <ToastProvider>
      <MarkAllReadShortcut
        communities={communities}
        shortcuts={shortcuts as never}
      />
    </ToastProvider>,
  );
  return { markAllChannelsRead, shortcut: () => registered, dispose };
}

it("registers Shift+Escape, which works while typing but not behind a dialog", () => {
  const { shortcut } = setup();
  expect(shortcut()).toMatchObject({
    id: "mark-all-read",
    binding: { key: "Escape", shift: true },
    allowInEditable: true,
  });
  expect(shortcut()?.allowInModal).toBeUndefined();
});

it("is unavailable without read sync, without anything unread, or while another community is connected", () => {
  expect(setup().shortcut()?.when?.()).toBe(true);
  cleanup();
  expect(setup({ capability: "read-only" }).shortcut()?.when?.()).toBe(false);
  cleanup();
  expect(setup({ unreadChannels: [] }).shortcut()?.when?.()).toBe(false);
  cleanup();
  expect(setup({ selected: null }).shortcut()).toBeUndefined();
  cleanup();
  expect(
    setup({ connected: "https://other.example" }).shortcut(),
  ).toBeUndefined();
});

it("asks first, focusing Mark all as read, and marks nothing when cancelled", async () => {
  const { shortcut, markAllChannelsRead } = setup();
  act(() => void shortcut()?.run());
  const dialog = await screen.findByRole("alertdialog", {
    name: "Mark everything as read?",
  });
  expect(dialog).toHaveTextContent("Acme Relay");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Mark all as read" }),
    ).toHaveFocus(),
  );
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(markAllChannelsRead).not.toHaveBeenCalled();
});

it("marks everything read on confirm, then closes and reports success", async () => {
  const { shortcut, markAllChannelsRead } = setup();
  act(() => void shortcut()?.run());
  await userEvent.click(
    await screen.findByRole("button", { name: "Mark all as read" }),
  );
  expect(markAllChannelsRead).toHaveBeenCalledOnce();
  expect(await screen.findByText("Marked all as read.")).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

it("reports a failure the way the community menu does", async () => {
  const { shortcut, markAllChannelsRead } = setup();
  markAllChannelsRead.mockRejectedValueOnce(new Error("offline"));
  act(() => void shortcut()?.run());
  await userEvent.click(
    await screen.findByRole("button", { name: "Mark all as read" }),
  );
  expect(
    await screen.findByText("Couldn’t mark everything as read."),
  ).toBeInTheDocument();
});

it("withdraws the shortcut when it unmounts", () => {
  const { dispose } = setup();
  cleanup();
  expect(dispose).toHaveBeenCalled();
});
