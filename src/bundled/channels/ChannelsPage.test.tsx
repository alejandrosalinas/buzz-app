// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { createNavigationController } from "../../features/navigation/controller";
import { createMemoryHistory } from "../../features/navigation/history";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import type { Panels } from "../../features/panels/service";
import type { PageNavigation } from "../../features/navigation/service";
import { ChannelsPage, mediaReviewForDestination } from "./ChannelsPage";

afterEach(cleanup);
// Run the page's hooks in React, then inspect its returned workspace element.
// Browser journeys exercise the workspace subtree and navigation interactions.
// Inspect the actual element returned at the workspace boundary, not a parallel
// key helper. React uses this key to decide whether to retain the subtree.
vi.mock("../../features/relay/react", async (original) => ({
  ...(await original<typeof import("../../features/relay/react")>()),
  useRelayConnection: (relay: RelayData) => relay.snapshot(),
}));
function workspace(scope: string, generation: number) {
  const snapshot = { status: "ready", scope, generation } as RelaySnapshot;
  const relay = { snapshot: () => snapshot } as RelayData;
  const page = renderHook(() =>
    ChannelsPage({
      relay,
      panels: {} as Panels,
      navigator: createNavigationController(createMemoryHistory()).navigation,
    }),
  ).result.current;
  return page.props.children as ReactElement<{ scope: string }>;
}

async function detailWorkspace(target: string) {
  const { Context } = await import("@deepseek-ai/cordis");
  const { provideNavigation } = await import(
    "../../features/navigation/service"
  );
  const { provideRelay } = await import("../../features/relay/service");
  const ctx = new Context();
  const host = provideNavigation(ctx);
  const source = provideRelay(ctx);
  const scope = {
    viewer: "a".repeat(64),
    communityOrigin: "https://relay.example",
  };
  const partition = `${scope.communityOrigin}:${scope.viewer}`;
  let connection: RelaySnapshot = {
    ...source.snapshot(),
    status: "ready",
    scope: partition,
    viewer: scope.viewer,
  };
  const listeners = new Set<() => void>();
  const relay: RelayData = {
    ...source,
    snapshot: () => connection,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  void host.navigation.open({
    version: 1,
    kind: "conversation",
    scope,
    channelId: "alpha",
    detail: { target },
  });
  const navigation = host.request(host.navigation.snapshot().attempt, {
    valid: () => true,
    subscribe: () => () => {},
  }).request;
  const page = renderHook(() =>
    ChannelsPage({
      relay,
      panels: {} as Panels,
      navigation,
      navigator: host.navigation,
    }),
  );
  return {
    scope,
    partition,
    navigation: host.navigation,
    workspace: () =>
      page.result.current.props.children as ReactElement<{
        navigation?: PageNavigation;
      }>,
    replace(next: Partial<RelaySnapshot>) {
      act(() => {
        source.disconnect();
        connection = { ...source.snapshot(), ...next };
        for (const listener of listeners) listener();
      });
      page.rerender();
    },
    dispose: () => ctx.fiber.dispose(),
  };
}

it.each(["nostr:npub1example", "https://github.com/block/buzz/pull/4"])(
  "keeps %s restorable through reconnect and same-scope reset, revoking old authority",
  async (target) => {
    const h = await detailWorkspace(target);
    try {
      const visit = h.navigation.snapshot().entry;
      const old = h.workspace().props.navigation;
      h.replace({ status: "connecting" }); // Scope is temporarily unknown.
      expect(h.navigation.snapshot().entry).toEqual(visit);
      expect(old?.signal.aborted).toBe(true);
      expect(old?.complete({ status: "opened" })).toBe(false);
      h.replace({
        status: "ready",
        scope: h.partition,
        viewer: h.scope.viewer,
      });
      expect(h.navigation.snapshot().entry).toEqual(visit);
      expect(h.workspace().props.navigation?.signal.aborted).toBe(false);
      h.replace({
        status: "ready",
        scope: h.partition,
        viewer: h.scope.viewer,
      });
      expect(h.navigation.snapshot().entry).toEqual(visit);
      h.navigation.back();
      h.navigation.forward();
      expect(h.navigation.snapshot().entry).toEqual(visit);
    } finally {
      await h.dispose();
    }
  },
);

it.each(["account", "community"])(
  "retires the current detail when the %s scope changes",
  async (changed) => {
    const h = await detailWorkspace("nostr:npub1example");
    try {
      const old = h.workspace().props.navigation;
      const visit = h.navigation.snapshot().entry;
      h.replace({
        status: "ready",
        scope:
          changed === "account"
            ? `${h.scope.communityOrigin}:${"b".repeat(64)}`
            : `https://other.example:${h.scope.viewer}`,
      });
      expect(h.navigation.snapshot().entry).toEqual({
        id: visit.id,
        target: {
          version: 1,
          kind: "conversation",
          scope: h.scope,
          channelId: "alpha",
        },
      });
      expect(old?.signal.aborted).toBe(true);
      expect(h.workspace().props.navigation).toBeUndefined();
    } finally {
      await h.dispose();
    }
  },
);

it("never carries a media review across channel navigation or resurrects it on return", () => {
  const review = { channelId: "alpha", messageId: "root", entryId: "visit-a" };
  expect(mediaReviewForDestination(review, "alpha", "visit-a")).toBe(review);
  expect(mediaReviewForDestination(review, "beta", "visit-a")).toBeUndefined();
  expect(mediaReviewForDestination(review, "alpha", "visit-b")).toBeUndefined();
  expect(
    mediaReviewForDestination(undefined, "alpha", "visit-a"),
  ).toBeUndefined();
});

it("distinguishes ready communities with the same connection generation", () => {
  const a = workspace("community-a:viewer", 1);
  const b = workspace("community-b:viewer", 1);
  expect(a.key).not.toBe(b.key);
  expect(a.props.scope).toBe("community-a:viewer");
  expect(b.props.scope).toBe("community-b:viewer");
});
it("distinguishes a replacement session within one scope without changing persisted intent keys", () => {
  const before = workspace("community-a:viewer", 1);
  const after = workspace("community-a:viewer", 2);
  expect(before.key).not.toBe(after.key);
  expect(before.props.scope).toBe(after.props.scope);
});
it("keeps the same workspace identity for updates within a session", () => {
  expect(workspace("community-a:viewer", 1).key).toBe(
    workspace("community-a:viewer", 1).key,
  );
});

it("the actual workspace receives session-bound authority, never the page's reusable authority", async () => {
  const { Context } = await import("@deepseek-ai/cordis");
  const { provideNavigation } = await import(
    "../../features/navigation/service"
  );
  const { provideRelay } = await import("../../features/relay/service");
  const ctx = new Context();
  const host = provideNavigation(ctx);
  const source = provideRelay(ctx);
  const relay: RelayData = {
    ...source,
    snapshot: () => ({ ...source.snapshot(), status: "ready" }),
  };
  try {
    const pending = host.navigation.open({
      version: 1,
      kind: "page",
      pluginId: "buzz.channels",
      pageId: "channels",
    });
    const parent = host.request(host.navigation.snapshot().attempt, {
      valid: () => true,
      subscribe: () => () => {},
    }).request;
    const rendered = renderHook(() =>
      ChannelsPage({
        relay,
        panels: {} as Panels,
        navigation: parent,
        navigator: host.navigation,
      }),
    ).result.current;
    const workspace = rendered.props.children as ReactElement<{
      navigation: typeof parent;
    }>;
    source.disconnect();
    expect(workspace.props.navigation.signal.aborted).toBe(true);
    expect(workspace.props.navigation.complete({ status: "opened" })).toBe(
      false,
    );
    expect(
      workspace.props.navigation.resolve({ version: 1, kind: "settings" }),
    ).toBe(false);
    expect(parent.signal.aborted).toBe(false);
    const replacement = renderHook(() =>
      ChannelsPage({
        relay,
        panels: {} as Panels,
        navigation: parent,
        navigator: host.navigation,
      }),
    ).result.current.props.children as typeof workspace;
    expect(replacement.props.navigation.complete({ status: "opened" })).toBe(
      true,
    );
    expect(await pending).toEqual({ status: "opened" });
  } finally {
    await ctx.fiber.dispose();
  }
});

it("animates Connecting only while a connection is actually under way", async () => {
  const { render, screen } = await import("@testing-library/react");
  const retry = vi.fn();
  const controller = createNavigationController(createMemoryHistory());
  const page = (snapshot: Partial<RelaySnapshot>) => {
    const relay = {
      snapshot: () => ({ scope: "s", generation: 0, ...snapshot }),
      retry,
    } as unknown as RelayData;
    return (
      <ChannelsPage
        relay={relay}
        panels={{} as Panels}
        navigator={controller.navigation}
      />
    );
  };
  vi.useFakeTimers();
  try {
    // A refusal after cached content opened the visit: nothing is retrying.
    const view = render(page({ status: "error" }));
    expect(screen.getByRole("alert").textContent).toContain("Can’t connect");
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.queryByText("Connecting…")).toBeNull();
    act(() => screen.getByRole("button", { name: "Try again" }).click());
    expect(retry).toHaveBeenCalledOnce();
    for (const working of [
      { status: "connecting" },
      { status: "error", retrying: true },
    ] as const) {
      view.rerender(page(working));
      act(() => vi.advanceTimersByTime(1_000));
      expect(screen.getByRole("status").textContent).toContain("Connecting…");
      expect(screen.queryByRole("alert")).toBeNull();
    }
    // Once the visit has settled no deadline ends the wait: between retries,
    // say it can't connect and keeps trying instead of animating forever.
    act(() => {
      controller.complete(controller.navigation.snapshot().attempt, {
        status: "opened",
      });
    });
    view.rerender(page({ status: "error", retrying: true }));
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByRole("alert").textContent).toContain(
      "We’ll keep trying.",
    );
    expect(screen.queryByText("Connecting…")).toBeNull();
    view.rerender(page({ status: "connecting" }));
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByRole("status").textContent).toContain("Connecting…");
    // A refusal, e.g. after cached content opened, is about access. The
    // shell's notice offers what fixes it; the page only says why it's empty.
    view.rerender(page({ status: "error", denied: true }));
    expect(
      screen.getByRole("heading", {
        name: "You don’t have access to this community",
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/Check your connection/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(page({ status: "error", denied: true, refusal: "sign-in" }));
    expect(
      screen.getByRole("heading", { name: "Sign in to open this community" }),
    ).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});
