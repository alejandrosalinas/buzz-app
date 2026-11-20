// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type {
  ChannelList,
  ChannelMessage,
  ChannelQueries,
  ChannelSummary,
  Profile,
} from "./contracts";
import type { ProfileQueries } from "./profile-directory";
import { useChannelRoster, useRowProfiles } from "./react";

afterEach(cleanup);

function profiles() {
  let snapshot: ReadonlyMap<string, Profile> = new Map();
  const listeners = new Set<() => void>();
  const queries: ProfileQueries = {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ensure: async () => {},
  };
  return {
    queries,
    listeners,
    set(id: string, name?: string) {
      const next = new Map(snapshot);
      if (name) next.set(id, { name } as Profile);
      else next.delete(id);
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}
const row = (authorId: string) =>
  ({ authorId, mentions: [], participants: [] }) as unknown as ChannelMessage;

it("keeps the selected map while added rows have no loaded profile", () => {
  const source = profiles();
  source.set("a", "Alice");
  const { result, rerender } = renderHook(
    ({ rows }) => useRowProfiles(source.queries, rows),
    { initialProps: { rows: [row("a")] } },
  );
  const first = result.current;
  expect([...first]).toEqual([["a", { name: "Alice" }]]);
  // A page adds an author still loading: same values, same identity.
  rerender({ rows: [row("a"), row("b")] });
  expect(result.current).toBe(first);
  // Its arrival, and a narrower demand, are real changes.
  act(() => source.set("b", "Bob"));
  expect([...result.current.keys()]).toEqual(["a", "b"]);
  const both = result.current;
  rerender({ rows: [row("b")] });
  expect(result.current).not.toBe(both);
  expect([...result.current]).toEqual([["b", { name: "Bob" }]]);
});

it("replaces the seed for swapped authors, updates, removal and a new source", () => {
  const source = profiles();
  source.set("a", "Alice");
  source.set("b", "Bob");
  const { result, rerender, unmount } = renderHook(
    ({ queries, rows }) => useRowProfiles(queries, rows),
    { initialProps: { queries: source.queries, rows: [row("a")] } },
  );
  rerender({ queries: source.queries, rows: [row("b")] });
  expect([...result.current]).toEqual([["b", { name: "Bob" }]]);
  act(() => source.set("b", "Robert"));
  expect([...result.current]).toEqual([["b", { name: "Robert" }]]);
  act(() => source.set("b"));
  expect(result.current.size).toBe(0);
  // Reload it, so the new source missing it is a real change.
  act(() => source.set("b", "Robert"));
  const other = profiles();
  rerender({ queries: other.queries, rows: [row("b")] });
  expect(result.current.size).toBe(0);
  act(() => other.set("b", "Other Bob"));
  expect([...result.current]).toEqual([["b", { name: "Other Bob" }]]);
  // The replaced source no longer drives this view.
  expect(source.listeners.size).toBe(0);
  act(() => source.set("b", "Stale"));
  expect([...result.current]).toEqual([["b", { name: "Other Bob" }]]);
  unmount();
  expect(other.listeners.size).toBe(0);
});

it("keeps the roster through preview and activity changes only while ready", () => {
  let list: ChannelList = { status: "loading", channels: [] };
  const listeners = new Set<() => void>();
  const queries = {
    list: () => list,
    subscribeList(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ensureList: () => {},
  } as unknown as ChannelQueries;
  const publish = (next: ChannelList) => {
    list = next;
    for (const listener of listeners) listener();
  };
  const { result } = renderHook(() => useChannelRoster(queries));
  const ready = {
    status: "ready" as const,
    channels: [{ id: "c", name: "general", preview: "hi" }],
  };
  act(() => publish(ready));
  expect(result.current).toBe(ready);
  act(() =>
    publish({
      ...ready,
      channels: [
        {
          id: "c",
          name: "general",
          preview: "next",
          lastActivityAt: 2,
          activityKnown: true,
        },
      ],
    }),
  );
  expect(result.current).toBe(ready);
  const renamed = { ...ready, channels: [{ id: "c", name: "renamed" }] };
  act(() => publish(renamed));
  expect(result.current).toBe(renamed);
  // An error retry is a new attempt even with identical fields.
  const failed = { status: "error" as const, channels: [], error: "x" };
  act(() => publish(failed));
  const retried = { ...failed };
  act(() => publish(retried));
  expect(result.current).toBe(retried);
});

it("keeps activity changes with a rank only when the selected channels' ranking changes", () => {
  let list: ChannelList = { status: "loading", channels: [] };
  const listeners = new Set<() => void>();
  const queries = {
    list: () => list,
    subscribeList(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ensureList: () => {},
  } as unknown as ChannelQueries;
  const publish = (next: ChannelList) => {
    list = next;
    for (const listener of listeners) listener();
  };
  const solo = (channel: ChannelSummary) => channel.id !== "x";
  const rank = (channel: ChannelSummary) => channel.lastActivityAt;
  const { result } = renderHook(() =>
    useChannelRoster(queries, { activity: solo, rank }),
  );
  const at = (a: number, b: number, x: number): ChannelList => ({
    status: "ready",
    channels: [
      { id: "a", name: "a", lastActivityAt: a, activityKnown: true },
      { id: "b", name: "b", lastActivityAt: b, activityKnown: true },
      { id: "x", name: "x", lastActivityAt: x, activityKnown: true },
    ],
  });
  const ready = at(2, 1, 0);
  act(() => publish(ready));
  expect(result.current).toBe(ready);
  // The leading chat gets newer, and an unselected channel overtakes both.
  act(() => publish(at(5, 1, 9)));
  expect(result.current).toBe(ready);
  // A tie leaves the order to the caller's tie-break, so it is published.
  const tied = at(5, 5, 9);
  act(() => publish(tied));
  expect(result.current).toBe(tied);
  const broken = at(5, 6, 9);
  act(() => publish(broken));
  expect(result.current).toBe(broken);
  act(() => publish(at(5, 7, 1)));
  expect(result.current).toBe(broken);
  const renamed: ChannelList = {
    ...broken,
    channels: broken.channels.map((channel) =>
      channel.id === "a" ? { ...channel, name: "renamed" } : channel,
    ),
  };
  act(() => publish(renamed));
  expect(result.current).toBe(renamed);
});
