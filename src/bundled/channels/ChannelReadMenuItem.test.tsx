// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  UnreadCapability,
  UnreadSnapshot,
} from "../../features/relay/unread";
import {
  MenuRoot,
  MenuPopup,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { ChannelReadMenuItem } from "./ChannelReadMenuItem";

afterEach(cleanup);
function setup() {
  const listeners = new Map<string, Set<() => void>>();
  const snapshots = new Map<string, UnreadSnapshot>();
  const set = (channelId: string, patch: Partial<UnreadSnapshot> = {}) => {
    snapshots.set(channelId, {
      target: { kind: "channel", channelId },
      observedCount: 0,
      attentionCount: 0,
      manual: "none",
      coverage: "observed",
      freshness: "observed",
      ...patch,
    });
    for (const listener of listeners.get(channelId) ?? []) listener();
  };
  set("room");
  set("other", { observedCount: 2 });
  const saved = {
    operationId: "saved",
    durability: "saved",
    sync: "local-only",
  } as const;
  const unread = {
    snapshot: (target) => {
      const snapshot = snapshots.get(target.channelId);
      if (!snapshot) throw new Error("Missing test snapshot");
      return snapshot;
    },
    subscribe(target, listener) {
      const owned = listeners.get(target.channelId) ?? new Set();
      listeners.set(target.channelId, owned);
      owned.add(listener);
      return () => {
        owned.delete(listener);
      };
    },
    markChannelRead: vi.fn(async () => saved),
    markUnreadLocal: vi.fn(async () => saved),
  } satisfies Pick<
    UnreadCapability,
    "snapshot" | "subscribe" | "markChannelRead" | "markUnreadLocal"
  >;
  const run = vi.fn(async (action: () => Promise<unknown>) => {
    await action();
  });
  const menu = (channelId = "room", pending = false, open = true) => (
    <StrictMode>
      <MenuRoot open={open} triggerId="read-menu-trigger">
        <MenuTrigger id="read-menu-trigger">Channel actions</MenuTrigger>
        <MenuPopup>
          <ChannelReadMenuItem
            unread={unread}
            channelId={channelId}
            pending={pending}
            run={run}
          />
        </MenuPopup>
      </MenuRoot>
    </StrictMode>
  );
  return { unread, run, menu, set, listeners };
}

it.each([
  { observedCount: 3, manual: "none", name: "Mark as read" },
  { observedCount: 0, manual: "local-only", name: "Mark as read" },
  { observedCount: 0, manual: "remote", name: "Mark as read" },
  { observedCount: 0, manual: "none", name: "Mark as unread" },
  { observedCount: null, manual: "none", name: "Mark as unread" },
] as const)(
  "offers only $name for count=$observedCount/manual=$manual",
  async ({ name, ...snapshot }) => {
    const h = setup();
    h.set("room", snapshot);
    render(h.menu());
    const item = await screen.findByRole("menuitem", { name });
    expect(screen.getAllByRole("menuitem")).toHaveLength(1);
    expect(item.querySelector(".buzz-menu-icon")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(item.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    await userEvent.click(item);
    if (name === "Mark as read") {
      expect(h.unread.markChannelRead).toHaveBeenCalledExactlyOnceWith("room");
      expect(h.unread.markUnreadLocal).not.toHaveBeenCalled();
    } else {
      expect(item).toHaveAttribute("title", "Mark as unread");
      expect(h.unread.markUnreadLocal).toHaveBeenCalledExactlyOnceWith({
        kind: "channel",
        channelId: "room",
      });
      expect(h.unread.markChannelRead).not.toHaveBeenCalled();
    }
  },
);

it("updates an open menu from the domain snapshot, disables pending work and releases retargeted subscriptions", async () => {
  const h = setup();
  const view = render(h.menu());
  const initial = await screen.findByRole("menuitem", {
    name: "Mark as unread",
  });
  await waitFor(() => expect(initial).toBeVisible());
  act(() => h.set("room", { observedCount: 1 }));
  expect(screen.getByRole("menuitem", { name: "Mark as read" })).toBeVisible();
  act(() => h.set("room"));
  expect(
    screen.getByRole("menuitem", { name: "Mark as unread" }),
  ).toBeVisible();
  view.rerender(h.menu("room", true));
  const disabled = screen.getByRole("menuitem", { name: "Mark as unread" });
  expect(disabled).toHaveAttribute("aria-disabled", "true");
  await userEvent.click(disabled);
  expect(h.run).not.toHaveBeenCalled();
  view.rerender(h.menu("other"));
  expect(h.listeners.get("room")?.size).toBe(0);
  await userEvent.click(screen.getByRole("menuitem", { name: "Mark as read" }));
  expect(h.unread.markChannelRead).toHaveBeenCalledExactlyOnceWith("other");
  view.rerender(h.menu("other", false, false));
  await waitFor(() => expect(h.listeners.get("other")?.size).toBe(0));
  view.unmount();
});
