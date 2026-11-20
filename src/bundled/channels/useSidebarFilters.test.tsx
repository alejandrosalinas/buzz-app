// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelSummary } from "../../features/relay/contracts";
import { createRelaySession } from "../../features/relay/session";
import { sidebarSections } from "./sidebar-sections";
import {
  SIDEBAR_ACTIVE_WINDOW,
  useSidebarFilters,
  type SidebarFilter,
} from "./useSidebarFilters";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("filters sections independently while preserving their saved sort and roster gates", () => {
  const owner = createRelaySession(null);
  const sections = sidebarSections(
    [
      { id: "older", name: "A", lastActivityAt: 1 },
      { id: "newer", name: "Z", lastActivityAt: 2 },
      { id: "grouped", name: "Grouped" },
      { id: "hidden", name: "Hidden", hidden: true },
    ],
    {
      sections: [{ id: "work", name: "Work", icon: "", order: 0 }],
      assignments: { grouped: "work" },
      starred: [],
      muted: [],
      sort: { channels: "recent" },
    },
  );
  const { result, unmount } = renderHook(() =>
    useSidebarFilters(
      sections,
      { "group:work": "unreads" },
      "hidden",
      owner.session.unread,
    ),
  );
  expect(
    result.current.map(({ key, rows }) => [key, rows.map(({ id }) => id)]),
  ).toEqual([
    ["solo", []],
    ["starred", []],
    ["group:work", []],
    ["channels", ["newer", "older"]],
    ["forums", []],
    ["dms", []],
  ]);
  unmount();
  owner.dispose();
});

it("keeps section membership and ordering, shows any open channel, and expires idle activity", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
  const owner = createRelaySession(null);
  const now = Date.now() / 1000;
  const roster: ChannelSummary[] = [
    {
      id: "old",
      name: "Old",
      lastActivityAt: now - SIDEBAR_ACTIVE_WINDOW / 1000,
    },
    {
      id: "fresh",
      name: "Fresh",
      lastActivityAt: now - SIDEBAR_ACTIVE_WINDOW / 1000 + 1,
    },
    { id: "unknown", name: "Unknown" },
    { id: "revoked", name: "Revoked", hidden: true },
  ];
  const sections = sidebarSections(roster);
  const { result, rerender, unmount } = renderHook(
    ({ current, mode }) =>
      useSidebarFilters(
        sections,
        { channels: mode },
        current,
        owner.session.unread,
      ),
    { initialProps: { current: "old", mode: "active" as SidebarFilter } },
  );
  const ids = () =>
    result.current
      .find(({ key }) => key === "channels")
      ?.rows.map(({ id }) => id);
  const hiddenIds = () =>
    result.current
      .find(({ key }) => key === "channels")
      ?.hiddenRows.map(({ id }) => id);
  expect(ids()).toEqual(["fresh", "old"]);
  expect(hiddenIds()).toEqual(["unknown"]);
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(ids()).toEqual(["old"]);
  expect(hiddenIds()).toEqual(["fresh", "unknown"]);
  rerender({ current: "unknown", mode: "active" });
  expect(ids()).toEqual(["unknown"]);
  expect(hiddenIds()).toEqual(["fresh", "old"]);
  rerender({ current: "unknown", mode: "all" });
  expect(ids()).toEqual(["fresh", "old", "unknown"]);
  expect(hiddenIds()).toEqual([]);
  expect(result.current.find(({ key }) => key === "channels")?.allRows).toEqual(
    sections.find(({ key }) => key === "channels")?.rows,
  );
  unmount();
  expect(vi.getTimerCount()).toBe(0);
  owner.dispose();
});

it("reschedules activity deadlines beyond the browser timeout limit", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
  const owner = createRelaySession(null);
  const sections = sidebarSections([
    { id: "fresh", name: "Fresh", lastActivityAt: Date.now() / 1000 },
  ]);
  const { result, unmount } = renderHook(() =>
    useSidebarFilters(
      sections,
      { channels: "active" },
      undefined,
      owner.session.unread,
    ),
  );
  act(() => {
    vi.advanceTimersByTime(2_147_483_647);
  });
  expect(
    result.current.find(({ key }) => key === "channels")?.rows,
  ).toHaveLength(1);
  act(() => {
    vi.advanceTimersByTime(SIDEBAR_ACTIVE_WINDOW - 2_147_483_647);
  });
  expect(
    result.current.find(({ key }) => key === "channels")?.rows,
  ).toHaveLength(0);
  unmount();
  owner.dispose();
});

it("reacts to message, manual and thread unread evidence and cleans up filtered subscriptions", () => {
  const owner = createRelaySession(null);
  const listeners = new Set<() => void>();
  const activityListeners = new Set<() => void>();
  const states = new Map<
    string,
    { count: number; manual?: boolean; thread?: boolean }
  >();
  const subscribe = (set: Set<() => void>, listener: () => void) => {
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };
  const unread = {
    ...owner.session.unread,
    snapshot: (
      target: Parameters<typeof owner.session.unread.snapshot>[0],
    ) => ({
      ...owner.session.unread.snapshot(target),
      observedCount: states.get(target.channelId)?.count ?? null,
      manual: states.get(target.channelId)?.manual
        ? ("local-only" as const)
        : ("none" as const),
    }),
    activity: (id: string) => ({
      ...owner.session.unread.activity(id),
      items: states.get(id)?.thread
        ? [
            {
              channelId: id,
              rootId: "root",
              latestMessageId: "reply",
              authorId: "other",
              createdAt: 1,
              preview: "Reply",
              unreadCount: 1,
            },
          ]
        : [],
    }),
    subscribe: (_target: unknown, listener: () => void) =>
      subscribe(listeners, listener),
    subscribeActivity: (_id: string, listener: () => void) =>
      subscribe(activityListeners, listener),
  };
  const sections = sidebarSections(
    ["alpha", "beta", "gamma"].map((id) => ({ id, name: id })),
  );
  const { result, rerender, unmount } = renderHook(
    ({ current, mode }) =>
      useSidebarFilters(sections, { channels: mode }, current, unread),
    { initialProps: { current: "alpha", mode: "unreads" as SidebarFilter } },
  );
  const ids = () =>
    result.current
      .find(({ key }) => key === "channels")
      ?.rows.map(({ id }) => id);
  expect(ids()).toEqual(["alpha"]);
  act(() => {
    states.set("beta", { count: 1 });
    for (const listener of listeners) listener();
  });
  expect(ids()).toEqual(["alpha", "beta"]);
  act(() => {
    states.set("beta", { count: 0, manual: true });
    states.set("gamma", { count: 0, thread: true });
    for (const listener of activityListeners) listener();
  });
  expect(ids()).toEqual(["alpha", "beta", "gamma"]);
  act(() => {
    states.clear();
    for (const listener of listeners) listener();
  });
  rerender({ current: "beta", mode: "unreads" });
  expect(ids()).toEqual(["beta"]);
  rerender({ current: "beta", mode: "all" });
  expect(listeners.size).toBe(0);
  expect(activityListeners.size).toBe(0);
  unmount();
  owner.dispose();
});

it("uses each section's saved window and replaces its expiry deadline when edited", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
  const owner = createRelaySession(null);
  const age = 7 * 86400;
  const sections = sidebarSections([
    { id: "old", name: "Old", lastActivityAt: Date.now() / 1000 - age + 1 },
  ]);
  const { result, rerender, unmount } = renderHook(
    ({ seconds }) =>
      useSidebarFilters(
        sections,
        { channels: "active" },
        undefined,
        owner.session.unread,
        { channels: seconds },
      ),
    { initialProps: { seconds: age } },
  );
  expect(
    result.current.find(({ key }) => key === "channels")?.rows,
  ).toHaveLength(1);
  rerender({ seconds: 14 * 86400 });
  act(() => vi.advanceTimersByTime(1000));
  expect(
    result.current.find(({ key }) => key === "channels")?.rows,
  ).toHaveLength(1);
  rerender({ seconds: age });
  expect(
    result.current.find(({ key }) => key === "channels")?.rows,
  ).toHaveLength(0);
  rerender({ seconds: 14 * 86400 });
  act(() => vi.advanceTimersByTime(age * 1000));
  expect(
    result.current.find(({ key }) => key === "channels")?.rows,
  ).toHaveLength(0);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
  owner.dispose();
});

it("preserves unknown activity until a successful read, including first-read failure and retry", () => {
  const owner = createRelaySession(null);
  const sections = sidebarSections([
    { id: "old", name: "Old", lastActivityAt: 1 },
    { id: "unknown", name: "Unknown" },
  ]);
  const { result, rerender, unmount } = renderHook(
    ({ status }) =>
      useSidebarFilters(
        sections,
        { channels: "active" },
        undefined,
        owner.session.unread,
        {},
        status === "ready",
      ),
    { initialProps: { status: "idle" } },
  );
  const ids = () =>
    result.current
      .find(({ key }) => key === "channels")
      ?.rows.map(({ id }) => id);
  expect(ids()).toEqual(["unknown"]);
  for (const status of ["loading", "error", "loading"]) {
    rerender({ status });
    expect(ids()).toEqual(["unknown"]);
  }
  rerender({ status: "ready" });
  expect(ids()).toEqual([]);
  expect(
    result.current
      .find(({ key }) => key === "channels")
      ?.hiddenRows.map(({ id }) => id),
  ).toEqual(["old", "unknown"]);
  unmount();
  owner.dispose();
});

it("keeps known-inactive rows hidden through refreshes while new rows remain visible", () => {
  const owner = createRelaySession(null);
  const sections = sidebarSections([
    { id: "quiet", name: "Quiet", activityKnown: true },
    { id: "new", name: "New" },
  ]);
  const { result, rerender, unmount } = renderHook(
    ({ ready, current }) =>
      useSidebarFilters(
        sections,
        { channels: "active" },
        current,
        owner.session.unread,
        {},
        ready,
      ),
    { initialProps: { ready: true, current: "elsewhere" } },
  );
  expect(result.current.find(({ key }) => key === "channels")?.rows).toEqual(
    [],
  );
  rerender({ ready: false, current: "elsewhere" });
  expect(
    result.current
      .find(({ key }) => key === "channels")
      ?.rows.map(({ id }) => id),
  ).toEqual(["new"]);
  rerender({ ready: false, current: "quiet" });
  expect(
    result.current
      .find(({ key }) => key === "channels")
      ?.rows.map(({ id }) => id),
  ).toEqual(["new", "quiet"]);
  unmount();
  owner.dispose();
});
