// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PageNavigation } from "../../features/navigation/service";
import { useChannelHistoryFocus } from "./useChannelHistoryFocus";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});
function setup(
  overrides: Partial<PageNavigation> = {},
  openerParent = document.body,
) {
  const opener = document.createElement("button");
  const other = document.createElement("button");
  const container = document.createElement("section");
  container.tabIndex = -1;
  const history = document.createElement("section");
  history.tabIndex = 0;
  history.setAttribute("data-message-scroller", "");
  container.append(history);
  openerParent.append(opener);
  document.body.append(other, container);
  opener.focus();
  const abort = new AbortController();
  const navigation: PageNavigation = {
    entryId: "visit",
    target: {
      version: 1,
      kind: "conversation",
      channelId: "room",
      scope: {
        viewer: "a".repeat(64),
        communityOrigin: "https://relay.example",
      },
    },
    signal: abort.signal,
    position: () => undefined,
    savePosition: vi.fn(),
    passThrough: vi.fn(),
    complete: vi.fn(),
    resolve: vi.fn(),
    forSession: vi.fn(),
    ...overrides,
  };
  const ref = { current: container };
  const view = renderHook(
    ({ ready, enabled, request }) =>
      useChannelHistoryFocus(ref, request, enabled, ready),
    {
      initialProps: { ready: false, enabled: true, request: navigation },
    },
  );
  return {
    opener,
    other,
    container,
    history,
    navigation,
    abort,
    ready: (enabled = true, request = navigation) =>
      view.rerender({ ready: true, enabled, request }),
  };
}
it("hands a ready read-only visit to its history once", () => {
  const h = setup();
  expect(document.activeElement).toBe(h.opener);
  h.ready();
  expect(document.activeElement).toBe(h.history);
  h.other.focus();
  h.ready(false);
  h.ready();
  expect(document.activeElement).toBe(h.other);
});
it("leaves a writable conversation's composer to its own focus owner", () => {
  const h = setup();
  h.ready(false);
  expect(document.activeElement).toBe(h.opener);
});
it("ends the handoff when focus moves while history loads, even if it moves back", () => {
  const h = setup();
  h.other.focus();
  h.opener.focus();
  h.ready();
  expect(document.activeElement).toBe(h.opener);
});
it("does not focus an aborted visit", () => {
  const h = setup();
  h.abort.abort();
  h.ready();
  expect(document.activeElement).toBe(h.opener);
});
it("preserves a passive restoration", () => {
  const h = setup({ focus: "preserve" });
  h.ready();
  expect(document.activeElement).toBe(h.opener);
});
it.each(["hidden", "inert", "aria-hidden"])(
  "does not focus history under %s",
  (attribute) => {
    const h = setup();
    h.container.setAttribute(attribute, "true");
    h.ready();
    expect(document.activeElement).toBe(h.opener);
  },
);
it.each([
  { messageId: "b".repeat(64) },
  { panel: "members" as const },
  { detail: { target: "test:tool" } },
])("leaves addressed content to its focus owner (%j)", (target) => {
  const h = setup();
  h.ready(true, {
    ...h.navigation,
    signal: new AbortController().signal,
    target: { ...h.navigation.target, ...target },
  });
  expect(document.activeElement).toBe(h.opener);
});

it("retains the search dialog handoff to loading history until its timeline is ready", () => {
  const h = setup();
  h.container.focus();
  h.ready();
  expect(document.activeElement).toBe(h.history);
});

it("keeps the captured opener focused inside an active modal when history becomes ready", () => {
  const modal = document.createElement("div");
  modal.setAttribute("aria-modal", "true");
  document.body.append(modal);
  const h = setup({}, modal);
  expect(document.activeElement).toBe(h.opener);
  h.ready();
  expect(document.activeElement).toBe(h.opener);
});
