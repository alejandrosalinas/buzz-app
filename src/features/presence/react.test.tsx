// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PresenceIndicator } from "./react";
import type { Presence, PresenceStatus } from "./presence";

afterEach(cleanup);

it("omits unavailable evidence and updates valid profile status without Unknown copy", () => {
  let status: PresenceStatus = "unknown";
  let changed = () => {};
  const presence = {
    status: () => status,
    limited: () => false,
    subscribeSelection: () => () => {},
    subscribe(_key, listener) {
      changed = listener;
      return () => {};
    },
    connected() {},
    clear() {},
    refresh() {},
    dispose() {},
  } satisfies Presence;
  render(
    <PresenceIndicator presence={presence} pubkey={"a".repeat(64)} profile />,
  );
  expect(screen.queryByRole("img")).toBeNull();
  for (const [next, label] of [
    ["online", "Active"],
    ["away", "Away"],
    ["offline", "Offline"],
    ["unknown", null],
  ] as const) {
    act(() => {
      status = next;
      changed();
    });
    if (label)
      expect(
        screen.getByRole("img", { name: `Presence: ${label}` }).textContent,
      ).toContain(label);
    else expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText(/Unknown/)).toBeNull();
  }
});
