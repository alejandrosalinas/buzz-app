// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Communities } from "../../features/communities/service";
import { createShortcutBindings } from "../../features/shortcuts/preferences";
import { ShortcutsService } from "../../features/shortcuts/service";
import { CommunityShortcuts } from "./CommunityShortcuts";

afterEach(cleanup);

function setup(selected: string | null) {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const shortcuts = new ShortcutsService(
    root,
    window,
    createShortcutBindings(window),
  );
  let snapshot = {
    selected,
    memberships: [{ id: "a" }, { id: "b" }],
  };
  const listeners = new Set<() => void>();
  const communities = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => snapshot,
    select: vi.fn(),
  } as unknown as Communities;
  const onSelect = vi.fn();
  render(
    <CommunityShortcuts
      communities={communities}
      shortcuts={shortcuts}
      onSelect={onSelect}
    />,
  );
  return {
    onSelect,
    /** The service saved a new switcher order. */
    reorder(ids: string[]) {
      act(() => {
        snapshot = { ...snapshot, memberships: ids.map((id) => ({ id })) };
        for (const listener of listeners) listener();
      });
    },
  };
}

// jsdom has no platform, so Control is the primary modifier here.
const press = (key: string, shift = false) => {
  const event = new KeyboardEvent("keydown", {
    key,
    ctrlKey: true,
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(event);
  return event.defaultPrevented;
};

it("switches to the community switcher's entries by number, Personal space first", () => {
  const { onSelect } = setup("a");
  expect(press("1")).toBe(true);
  expect(onSelect).toHaveBeenLastCalledWith(null);
  expect(press("3")).toBe(true);
  expect(onSelect).toHaveBeenLastCalledWith("b");
  // No fourth entry: the key is left alone.
  expect(press("4")).toBe(false);
  expect(onSelect).toHaveBeenCalledTimes(2);
});

it("follows a reordered switcher at once, for numbers and steps alike", () => {
  const { onSelect, reorder } = setup("a");
  reorder(["b", "a"]);
  expect(press("2")).toBe(true);
  expect(onSelect).toHaveBeenLastCalledWith("b");
  expect(press("3")).toBe(true);
  expect(onSelect).toHaveBeenLastCalledWith("a");
  // The selected community is now last, so the next step wraps.
  expect(press("]", true)).toBe(true);
  expect(onSelect).toHaveBeenLastCalledWith(null);
  expect(press("[", true)).toBe(true);
  expect(onSelect).toHaveBeenLastCalledWith("b");
});

it("steps to the next and previous community with wrapping, on either bracket key", () => {
  const { onSelect } = setup("b");
  expect(press("}", true)).toBe(true);
  expect(onSelect).toHaveBeenLastCalledWith(null);
  expect(press("[", true)).toBe(true);
  expect(onSelect).toHaveBeenLastCalledWith("a");
});
