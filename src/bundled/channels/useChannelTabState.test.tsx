// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, test } from "vitest";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { createNavigationController } from "../../features/navigation/controller";
import { createMemoryHistory } from "../../features/navigation/history";
import {
  claimProfileTranscript,
  openProfileTranscript,
  profileActivityViewTarget,
  profileHistoryTarget,
} from "../../features/profiles/target";
import type {
  PanelOpening,
  RegisteredPanel,
} from "../../features/panels/service";
import {
  channelTabs,
  panelTabId,
  rootOfTab,
  useChannelTabState,
} from "./useChannelTabState";
import type { ChannelDrawerOpening } from "./useChannelPanels";

import {
  setThreadPlacementPreference,
  threadPlacementPreference,
} from "../../features/messages/thread-preferences";
afterEach(() => {
  cleanup();
  setThreadPlacementPreference("side");
  localStorage.clear();
});

test("selection readers stay stable during local updates and change with the channel", () => {
  const session = {} as RelaySession;
  const observations: unknown[] = [];
  const h = renderHook(
    ({ channel }) => {
      const state = useChannelTabState(session, channel);
      useEffect(() => {
        observations.push([state.getSelected(), state.getMainSelected()]);
      }, [state.getSelected, state.getMainSelected]);
      return state;
    },
    { initialProps: { channel: "alpha" } },
  );
  const { getSelected, getMainSelected } = h.result.current;
  act(() => {
    h.result.current.select("side");
    h.result.current.selectMain("main");
    expect(getSelected()).toBe("side");
    expect(getMainSelected()).toBe("main");
  });
  expect(observations).toEqual([["thread", undefined]]);
  expect(h.result.current.getSelected).toBe(getSelected);
  expect(h.result.current.getMainSelected).toBe(getMainSelected);
  h.rerender({ channel: "beta" });
  expect(observations).toEqual([
    ["thread", undefined],
    ["thread", undefined],
  ]);
  expect(h.result.current.getSelected()).toBe("thread");
  expect(h.result.current.getMainSelected()).toBeUndefined();
});

test("page remount restores each channel's tabs, selection and closed pane", () => {
  const session = {} as RelaySession;
  const mounted = renderHook(
    ({ channel }) => useChannelTabState(session, channel),
    { initialProps: { channel: "alpha" } },
  );
  act(() => {
    mounted.result.current.setTabs(() => [
      { id: "beta-tab", kind: "conversation", channelId: "beta" },
    ]);
    mounted.result.current.select("beta-tab");
    mounted.result.current.setPaneOpen(false);
  });
  mounted.rerender({ channel: "beta" });
  expect(mounted.result.current.tabs).toEqual([]);
  act(() =>
    mounted.result.current.setSettings({
      channelId: "beta",
    }),
  );
  mounted.unmount();
  const restored = renderHook(
    ({ channel }) => useChannelTabState(session, channel),
    { initialProps: { channel: "alpha" } },
  );
  expect(restored.result.current).toMatchObject({
    selected: "beta-tab",
    paneOpen: false,
    tabs: [{ id: "beta-tab", kind: "conversation", channelId: "beta" }],
  });
  restored.rerender({ channel: "beta" });
  expect(restored.result.current).toMatchObject({
    selected: "settings",
    paneOpen: true,
    settings: { channelId: "beta" },
  });
});

test("replacement sessions are isolated from retained state and old callbacks", () => {
  const first = {} as RelaySession;
  const second = {} as RelaySession;
  const mounted = renderHook(
    ({ session }) => useChannelTabState(session, "alpha"),
    { initialProps: { session: first } },
  );
  const oldSelect = mounted.result.current.select;
  act(() => oldSelect("old-tab"));
  mounted.rerender({ session: second });
  expect(mounted.result.current.selected).toBe("thread");
  act(() => oldSelect("late-old-tab"));
  expect(mounted.result.current.selected).toBe("thread");
  act(() => mounted.result.current.select("new-tab"));
  mounted.rerender({ session: first });
  expect(mounted.result.current.selected).toBe("late-old-tab");
});

test("closing and reopening settings starts a fresh view while hiding the pane retains it", () => {
  const session = {} as RelaySession;
  const mounted = renderHook(() => useChannelTabState(session, "alpha"));
  act(() => mounted.result.current.setSettings({ channelId: "alpha" }));
  const opening = mounted.result.current.settings;
  act(() => mounted.result.current.setPaneOpen(false));
  act(() => mounted.result.current.setPaneOpen(true));
  expect(mounted.result.current.settings).toBe(opening);
  act(() => mounted.result.current.setSettings({ channelId: "alpha" }));
  expect(mounted.result.current.settings).toBe(opening);
  act(() => mounted.result.current.setSettings(undefined));
  act(() => mounted.result.current.setSettings({ channelId: "alpha" }));
  expect(mounted.result.current.settings?.id).not.toBe(opening?.id);
});

test("channel switches keep each channel's menu opening and selection", () => {
  const session = {} as RelaySession;
  const menu = {
    key: "usage",
    channelMenu: { label: "Usage" },
  } as RegisteredPanel;
  const tool = { key: "terminal" } as RegisteredPanel;
  const entry = (channelId: string, panel: RegisteredPanel): PanelOpening => ({
    channelId,
    panel,
    target: `${channelId}-${panel.key}`,
  });
  const alphaTool = entry("alpha", tool);
  const betaTool = entry("beta", tool);
  const alphaUsage = entry("alpha", menu);
  const betaUsage = entry("beta", menu);
  const mounted = renderHook(
    ({ channel }) => useChannelTabState(session, channel),
    { initialProps: { channel: "alpha" } },
  );
  act(() => {
    mounted.result.current.setEntries([alphaTool, alphaUsage]);
    mounted.result.current.select(panelTabId(alphaUsage));
  });
  mounted.rerender({ channel: "beta" });
  expect(mounted.result.current.entries).toEqual([]);
  act(() => {
    mounted.result.current.setEntries([betaTool, betaUsage]);
    mounted.result.current.select(panelTabId(betaTool));
  });
  mounted.rerender({ channel: "alpha" });
  expect(mounted.result.current.entries).toEqual([alphaTool, alphaUsage]);
  expect(mounted.result.current.selected).toBe(panelTabId(alphaUsage));
  mounted.rerender({ channel: "beta" });
  expect(mounted.result.current.entries).toEqual([betaTool, betaUsage]);
  expect(mounted.result.current.selected).toBe(panelTabId(betaTool));
});

test("Solo and Messages retain independent workspaces for the same conversation", () => {
  const session = {} as RelaySession;
  const messages = renderHook(() => useChannelTabState(session, "alpha"));
  const solo = renderHook(() => useChannelTabState(session, "alpha", "solo"));
  act(() => {
    messages.result.current.setTabs(() => [
      {
        id: "messages-tab",
        kind: "thread",
        channelId: "alpha",
        messageId: "root",
      },
    ]);
    messages.result.current.select("messages-tab");
    solo.result.current.setTabs(() => [
      { id: "solo-tab", kind: "conversation", channelId: "beta" },
    ]);
    solo.result.current.select("solo-tab");
    solo.result.current.setPaneOpen(false);
  });
  expect(messages.result.current).toMatchObject({
    selected: "messages-tab",
    paneOpen: true,
    tabs: [{ id: "messages-tab" }],
  });
  solo.unmount();
  const restored = renderHook(() =>
    useChannelTabState(session, "alpha", "solo"),
  );
  expect(restored.result.current).toMatchObject({
    selected: "solo-tab",
    paneOpen: false,
    tabs: [{ id: "solo-tab" }],
  });
});

// Exercise the channel-owned open action through a mounted hook. This verifies
// the resulting user state, not React batching or notification counts.
test("opening a thread selects it, deduplicates its root and restores each channel", () => {
  const session = {} as RelaySession;
  const workspace = renderHook(
    ({ channel }) => useChannelTabState(session, channel),
    { initialProps: { channel: "alpha" } },
  );
  act(() => workspace.result.current.setPaneOpen(false));
  act(() =>
    workspace.result.current.openThreadTab(
      "alpha",
      "reply-a",
      "root-a",
      "reply",
    ),
  );
  expect(workspace.result.current).toMatchObject({
    selected: "thread:alpha:root-a",
    paneOpen: true,
    tabs: [{ id: "thread:alpha:root-a", replyRequest: 1 }],
  });
  act(() =>
    workspace.result.current.openThreadTab("alpha", "root-b", "root-b"),
  );
  act(() =>
    workspace.result.current.openThreadTab(
      "alpha",
      "reply-b",
      "root-a",
      "reply",
    ),
  );
  expect(workspace.result.current.tabs).toEqual([
    {
      id: "thread:alpha:root-a",
      kind: "thread",
      channelId: "alpha",
      messageId: "reply-b",
      replyRequest: 2,
      attentionRequest: 1,
      pane: "side",
    },
    {
      id: "thread:alpha:root-b",
      kind: "thread",
      channelId: "alpha",
      messageId: "root-b",
      replyRequest: undefined,
      focusRequest: 1,
      pane: "side",
    },
  ]);
  expect(workspace.result.current.selected).toBe("thread:alpha:root-a");
  workspace.rerender({ channel: "beta" });
  expect(workspace.result.current.tabs).toEqual([]);
  workspace.rerender({ channel: "alpha" });
  expect(workspace.result.current.tabs).toHaveLength(2);
  expect(workspace.result.current.selected).toBe("thread:alpha:root-a");
  act(() =>
    workspace.result.current.openThreadTab("alpha", "reply-b", "root-a"),
  );
  expect(workspace.result.current.tabs[0]).toMatchObject({
    replyRequest: undefined,
  });
});

test.each(["main", "side"] as const)(
  "ordinary openings request reply focus each time in the %s pane; restoration does not",
  (pane) => {
    const session = {} as RelaySession;
    const h = renderHook(() => useChannelTabState(session, "alpha"));
    const open = () =>
      h.result.current.openThreadTab("alpha", "root", "root", undefined, pane);
    act(open);
    expect(h.result.current.tabs[0]).toMatchObject({ focusRequest: 1, pane });
    act(open);
    expect(h.result.current.tabs).toHaveLength(1);
    expect(h.result.current.tabs[0]).toMatchObject({ focusRequest: 2, pane });
    act(() => h.result.current.openThreadTab("alpha", "other", "other"));
    act(open);
    expect(h.result.current.tabs[0]).toMatchObject({ focusRequest: 3, pane });
    act(() =>
      h.result.current.enterVisit("restore", {
        channelId: "alpha",
        messageId: "root",
        rootId: "root",
      }),
    );
    expect(h.result.current.tabs[0]).toMatchObject({ focusRequest: 3, pane });
  },
);

// Placement is one channel-owned list: a move reorders or crosses panes
// without changing the tab's identity, and selection follows it.
test("moving a thread reorders it within a pane and across panes", () => {
  const session = {} as RelaySession;
  const h = renderHook(() => useChannelTabState(session, "alpha"));
  act(() => {
    h.result.current.openThreadTab("alpha", "a", "a");
    h.result.current.openThreadTab("alpha", "b", "b");
    h.result.current.openThreadTab("alpha", "c", "c");
  });
  const ids = () => h.result.current.tabs.map((tab) => tab.id);
  act(() => h.result.current.moveTab("thread:alpha:c", "side", 0));
  expect(ids()).toEqual(["thread:alpha:c", "thread:alpha:a", "thread:alpha:b"]);
  expect(h.result.current.selected).toBe("thread:alpha:c");
  act(() => h.result.current.moveTab("thread:alpha:a", "main", 0));
  expect(
    h.result.current.tabs.find((tab) => tab.id === "thread:alpha:a"),
  ).toMatchObject({ pane: "main" });
  expect(h.result.current.mainSelected).toBe("thread:alpha:a");
  // Reopening a moved thread selects it where it now lives.
  act(() => h.result.current.openThreadTab("alpha", "a", "a", "reply"));
  expect(
    h.result.current.tabs.find((tab) => tab.id === "thread:alpha:a"),
  ).toMatchObject({ pane: "main", replyRequest: 1 });
  act(() => h.result.current.moveTab("thread:alpha:a", "side", 1));
  expect(ids()).toEqual(["thread:alpha:c", "thread:alpha:a", "thread:alpha:b"]);
  expect(h.result.current.mainSelected).toBeUndefined();
  expect(h.result.current.selected).toBe("thread:alpha:a");
  // A visit's own "select" keeps a pending reply focus request.
  act(() => h.result.current.openThreadTab("alpha", "a", "a", "select"));
  expect(
    h.result.current.tabs.find((tab) => tab.id === "thread:alpha:a"),
  ).toMatchObject({ replyRequest: 1 });
  // Focusing keeps the reply request, so the reply box keeps its target.
  act(() => h.result.current.openThreadTab("alpha", "a", "a", "focus"));
  expect(
    h.result.current.tabs.find((tab) => tab.id === "thread:alpha:a"),
  ).toMatchObject({ replyRequest: 1, focusRequest: 2 });
});

// A link's root hint is not identity: the reader's verified root merges a
// duplicate into the tab that already holds the thread.
test("a tab opened from a wrong hint merges into the verified thread's tab", () => {
  const session = {} as RelaySession;
  const h = renderHook(() => useChannelTabState(session, "alpha"));
  act(() => h.result.current.openThreadTab("alpha", "root", "root"));
  act(() => h.result.current.moveTab("thread:alpha:root", "main", 0));
  act(() => h.result.current.openThreadTab("alpha", "reply", "wrong-hint"));
  expect(h.result.current.tabs).toHaveLength(2);
  act(() =>
    h.result.current.resolveThreadRoot("thread:alpha:wrong-hint", "root"),
  );
  expect(h.result.current.tabs).toEqual([
    expect.objectContaining({
      id: "thread:alpha:root",
      messageId: "reply",
      pane: "main",
      rootId: "root",
    }),
  ]);
  expect(h.result.current.mainSelected).toBe("thread:alpha:root");
  // Later openings by either identity select the same tab.
  act(() => h.result.current.openThreadTab("alpha", "root", "root"));
  expect(h.result.current.tabs).toHaveLength(1);
});

test.each(["side", "main"] as const)(
  "late root confirmation in %s preserves newer selection and closed panes",
  (pane) => {
    const session = {} as RelaySession;
    const h = renderHook(() => useChannelTabState(session, "alpha"));
    act(() => h.result.current.openThreadTab("alpha", "root", "root"));
    act(() => h.result.current.resolveThreadRoot("thread:alpha:root", "root"));
    act(() =>
      h.result.current.openThreadTab("alpha", "reply", "guess", "select", pane),
    );
    act(() =>
      h.result.current.openThreadTab("alpha", "other", "other", "select", pane),
    );
    act(() => h.result.current.setPaneOpen(false));
    act(() => h.result.current.resolveThreadRoot("thread:alpha:guess", "root"));
    expect(h.result.current.paneOpen).toBe(false);
    expect(
      pane === "main"
        ? h.result.current.mainSelected
        : h.result.current.selected,
    ).toBe("thread:alpha:other");
    expect(
      h.result.current.tabs.find((tab) => tab.id === "thread:alpha:root"),
    ).toMatchObject({ messageId: "root" });
  },
);

test("a selected hidden provisional tab merges without switching the main pane", () => {
  const session = {} as RelaySession;
  const h = renderHook(() => useChannelTabState(session, "alpha"));
  act(() =>
    h.result.current.openThreadTab("alpha", "root", "root", "select", "main"),
  );
  act(() => h.result.current.resolveThreadRoot("thread:alpha:root", "root"));
  act(() =>
    h.result.current.openThreadTab("alpha", "other", "other", "select", "main"),
  );
  act(() => h.result.current.openThreadTab("alpha", "reply", "guess"));
  act(() => h.result.current.setPaneOpen(false));
  act(() => h.result.current.resolveThreadRoot("thread:alpha:guess", "root"));
  expect(h.result.current.mainSelected).toBe("thread:alpha:other");
  expect(h.result.current.paneOpen).toBe(false);
});

test.each(["side", "main"] as const)(
  "wrong-root diversion preserves the %s pane despite the opposite default and resolves into the actual owner",
  (pane) => {
    const otherPane = pane === "side" ? "main" : "side";
    setThreadPlacementPreference(otherPane);
    const session = {} as RelaySession;
    const h = renderHook(() => useChannelTabState(session, "alpha"));
    act(() =>
      h.result.current.openThreadTab("alpha", "x", "x", "select", pane),
    );
    act(() => h.result.current.resolveThreadRoot("thread:alpha:x", "x"));
    act(() =>
      h.result.current.openThreadTab("alpha", "y", "y", "select", otherPane),
    );
    act(() => h.result.current.resolveThreadRoot("thread:alpha:y", "y"));
    act(() =>
      h.result.current.openThreadTab("alpha", "reply-y", "x", "select", pane),
    );
    act(() => h.result.current.divertThread("thread:alpha:x", "reply-y", "x"));
    expect(
      h.result.current.tabs.find((tab) => tab.id === "thread:alpha:x"),
    ).toMatchObject({ messageId: "x", rootId: "x", pane });
    expect(
      h.result.current.tabs.find((tab) => tab.id === "thread:alpha:reply-y"),
    ).toMatchObject({ messageId: "reply-y", pane });
    expect(
      pane === "side"
        ? h.result.current.selected
        : h.result.current.mainSelected,
    ).toBe("thread:alpha:reply-y");
    // An already-open verified destination still keeps its own placement.
    act(() => h.result.current.resolveThreadRoot("thread:alpha:reply-y", "y"));
    expect(h.result.current.tabs).toHaveLength(2);
    expect(
      otherPane === "main"
        ? h.result.current.mainSelected
        : h.result.current.selected,
    ).toBe("thread:alpha:y");
    expect(
      h.result.current.tabs.find((tab) => tab.id === "thread:alpha:y"),
    ).toMatchObject({ messageId: "reply-y", pane: otherPane });
    const tabs = h.result.current.tabs;
    act(() => h.result.current.divertThread("thread:alpha:x", "reply-y", "x"));
    expect(h.result.current.tabs).toBe(tabs);
    expect(threadPlacementPreference()).toBe(otherPane);
  },
);

test("verified identity takes precedence over a tab's original hint id", () => {
  const session = {} as RelaySession;
  const h = renderHook(() => useChannelTabState(session, "alpha"));
  act(() => h.result.current.openThreadTab("alpha", "reply-y", "x"));
  act(() => h.result.current.resolveThreadRoot("thread:alpha:x", "y"));
  act(() => h.result.current.openThreadTab("alpha", "x", "x"));
  expect(h.result.current.tabs).toHaveLength(2);
  expect(new Set(h.result.current.tabs.map((tab) => tab.id)).size).toBe(2);
  expect(h.result.current.tabs[0]).toMatchObject({
    messageId: "reply-y",
    rootId: "y",
  });
});

test("Back to a visit whose only side content is a retained drawer shows that drawer", () => {
  const session = {} as RelaySession;
  const h = renderHook(() => useChannelTabState(session, "alpha"));
  const drawer = {
    panel: { key: "buzz.todos/todos", channelPlacement: "side" },
    context: { channelId: "alpha" },
    target: "todos",
  } as unknown as ChannelDrawerOpening;
  act(() => h.result.current.enterVisit("first:channel"));
  act(() => h.result.current.setSideDrawer(drawer));
  act(() => h.result.current.enterVisit("second:channel"));
  act(() => h.result.current.enterVisit("first:channel"));
  expect(h.result.current.sideDrawer).toBe(drawer);
  expect(h.result.current.paneOpen).toBe(true);
});

// Back/Forward restore each visit's selected tabs and never close a thread.
test("explicit close identifies only the thread's addressed visits, not channel visits retaining its tab", () => {
  const session = {} as RelaySession;
  const h = renderHook(() => useChannelTabState(session, "alpha"));
  const thread = { channelId: "alpha", messageId: "reply", rootId: "root" };
  act(() => h.result.current.enterVisit("channel:channel"));
  act(() => h.result.current.enterVisit("first:thread", thread));
  act(() =>
    h.result.current.enterVisit("other:thread", { ...thread, rootId: "other" }),
  );
  act(() =>
    h.result.current.enterVisit("second:thread", {
      ...thread,
      messageId: "root",
    }),
  );
  act(() => h.result.current.enterVisit("retained:channel", undefined, true));
  expect(h.result.current.threadVisits("alpha", "root")).toEqual([
    "first",
    "second",
  ]);
  expect(h.result.current.threadVisits("alpha", "other")).toEqual(["other"]);
  expect(h.result.current.threadVisits("beta", "root")).toEqual([]);
});

test.each([
  ["profile", `buzz:agent-profile:${"a".repeat(64)}`],
  ["activity", profileActivityViewTarget("a".repeat(64)) as string],
  ["transcript", profileActivityViewTarget("a".repeat(64)) as string],
])(
  "closing %s after Back retires its retained version visit",
  async (opening, base) => {
    const scope = {
      viewer: "b".repeat(64),
      communityOrigin: "https://relay.example",
    };
    const channel = {
      version: 1,
      kind: "conversation",
      scope,
      channelId: "alpha",
    } as const;
    const host = createNavigationController(createMemoryHistory(channel));
    const session = {} as RelaySession;
    const h = renderHook(() => useChannelTabState(session, "alpha"));
    if (opening === "transcript") openProfileTranscript(base, () => true);
    const list = profileHistoryTarget(base);
    const selected = profileHistoryTarget(base, {
      side: "instructions",
      id: "c".repeat(64),
    });
    try {
      const others = [
        `${base}#unknown`,
        `${base}#version=invalid`,
        profileHistoryTarget(`buzz:agent-profile:${"d".repeat(64)}`),
        "https://github.com/sample/project/pull/42#versions",
      ];
      for (const [index, target] of others.entries()) {
        act(() =>
          h.result.current.enterVisit(
            `other-${index}:detail`,
            undefined,
            true,
            {
              channelId: "alpha",
              target,
            },
          ),
        );
      }
      for (const target of [list, selected]) {
        void host.navigation.open({ ...channel, detail: { target } });
        act(() =>
          h.result.current.enterVisit(
            `${host.navigation.snapshot().entry.id}:detail`,
            undefined,
            true,
            { channelId: "alpha", target },
          ),
        );
      }
      act(() => host.navigation.back());
      expect(host.navigation.snapshot().entry.target).toEqual({
        ...channel,
        detail: { target: list },
      });
      // ChannelsPage uses this retirement set when explicitly closing the tab.
      act(() =>
        host.navigation.dismiss(
          h.result.current.detailVisits("alpha", list),
          channel,
        ),
      );
      act(() => host.navigation.forward());
      expect(host.navigation.snapshot().entry.target).toEqual(channel);
      expect(h.result.current.detailVisits("beta", list)).toEqual([]);
      for (const [index, target] of others.entries()) {
        expect(h.result.current.detailVisits("alpha", target)).toEqual([
          `other-${index}`,
        ]);
      }
    } finally {
      claimProfileTranscript(base);
      host.dispose();
    }
  },
);

test("dismissal follows verified roots and retains thread visits beyond the layout snapshot limit", () => {
  const session = {} as RelaySession;
  const h = renderHook(() => useChannelTabState(session, "alpha"));
  act(() =>
    h.result.current.enterVisit("linked:thread", {
      channelId: "alpha",
      messageId: "reply",
      rootId: "hint",
    }),
  );
  act(() =>
    h.result.current.resolveThreadRoot("thread:alpha:hint", "verified"),
  );
  expect(h.result.current.threadVisits("alpha", "hint")).toEqual([]);
  expect(h.result.current.threadVisits("alpha", "verified")).toEqual([
    "linked",
  ]);
  for (let i = 0; i < 60; i++)
    act(() => h.result.current.enterVisit(`${i}:channel`));
  expect(h.result.current.threadVisits("alpha", "verified")).toEqual([
    "linked",
  ]);
});

test.each(["nostr:profile", "https://github.com/sample/project/pull/42"])(
  "same-scope successors inherit all addressed visits for %s without old callback authority",
  (target) => {
    const scope = crypto.randomUUID();
    const first = { scope, viewer: "viewer" } as RelaySession;
    const h = renderHook(
      ({ session }) => useChannelTabState(session, "alpha"),
      { initialProps: { session: first } },
    );
    const detail = { channelId: "alpha", target };
    act(() =>
      h.result.current.enterVisit("first:detail", undefined, true, detail),
    );
    act(() =>
      h.result.current.enterVisit("other:detail", undefined, true, {
        ...detail,
        target: "nostr:other",
      }),
    );
    act(() =>
      h.result.current.enterVisit("last:detail", undefined, true, detail),
    );
    const old = h.result.current;
    h.rerender({ session: { scope, viewer: "viewer" } as RelaySession });
    expect(h.result.current.detailVisits("alpha", target)).toEqual([
      "first",
      "last",
    ]);
    expect(h.result.current.detailVisits("alpha", "nostr:other")).toEqual([
      "other",
    ]);
    expect(h.result.current.detailVisits("beta", target)).toEqual([]);
    // No presentation state or live panel objects cross the session boundary.
    expect(h.result.current.entries).toEqual([]);
    act(() => old.enterVisit("stale:detail", undefined, true, detail));
    act(() =>
      h.result.current.enterVisit("fresh:detail", undefined, true, detail),
    );
    h.rerender({ session: { scope, viewer: "viewer" } as RelaySession });
    expect(h.result.current.detailVisits("alpha", target)).toEqual([
      "first",
      "last",
      "fresh",
    ]);
  },
);

test("successors retain verified roots and page/channel retirement partitions", () => {
  const scope = crypto.randomUUID();
  const first = { scope, viewer: "viewer" } as RelaySession;
  const h = renderHook(
    ({ session, channel, page }) => useChannelTabState(session, channel, page),
    { initialProps: { session: first, channel: "alpha", page: "messages" } },
  );
  act(() =>
    h.result.current.enterVisit("reply:thread", {
      channelId: "alpha",
      messageId: "reply",
      rootId: "hint",
    }),
  );
  act(() =>
    h.result.current.resolveThreadRoot("thread:alpha:hint", "verified"),
  );
  const old = h.result.current;
  h.rerender({ session: first, channel: "beta", page: "messages" });
  act(() =>
    h.result.current.enterVisit("beta:thread", {
      channelId: "beta",
      messageId: "root",
      rootId: "root",
    }),
  );
  const successor = { scope, viewer: "viewer" } as RelaySession;
  h.rerender({ session: successor, channel: "alpha", page: "messages" });
  expect(h.result.current.threadVisits("alpha", "verified")).toEqual(["reply"]);
  expect(h.result.current.threadVisits("alpha", "hint")).toEqual([]);
  act(() => old.resolveThreadRoot("thread:alpha:hint", "stale"));
  expect(h.result.current.threadVisits("alpha", "verified")).toEqual(["reply"]);
  act(() =>
    h.result.current.enterVisit("current:thread", {
      channelId: "alpha",
      messageId: "reply",
      rootId: "hint",
    }),
  );
  act(() =>
    h.result.current.resolveThreadRoot("thread:alpha:hint", "verified"),
  );
  expect(h.result.current.threadVisits("alpha", "verified")).toEqual([
    "reply",
    "current",
  ]);
  h.rerender({ session: successor, channel: "beta", page: "messages" });
  expect(h.result.current.threadVisits("beta", "root")).toEqual(["beta"]);
  h.rerender({ session: successor, channel: "alpha", page: "solo" });
  expect(h.result.current.threadVisits("alpha", "verified")).toEqual([]);
});

test("a rebuilt reply keeps its inherited root before the successor reader resolves", () => {
  const scope = crypto.randomUUID();
  const h = renderHook(({ session }) => useChannelTabState(session, "alpha"), {
    initialProps: { session: { scope, viewer: "viewer" } as RelaySession },
  });
  act(() =>
    h.result.current.enterVisit("root:thread", {
      channelId: "alpha",
      messageId: "verified",
      rootId: "verified",
    }),
  );
  act(() =>
    h.result.current.enterVisit("reply:thread", {
      channelId: "alpha",
      messageId: "reply",
      rootId: "reply",
    }),
  );
  act(() =>
    h.result.current.resolveThreadRoot("thread:alpha:reply", "verified"),
  );
  h.rerender({ session: { scope, viewer: "viewer" } as RelaySession });
  act(() =>
    h.result.current.enterVisit("reply:thread", {
      channelId: "alpha",
      messageId: "reply",
      rootId: "reply",
    }),
  );
  const tab = h.result.current.tabs[0];
  if (tab?.kind !== "thread") throw new Error("Missing rebuilt thread");
  // Close reads these identities before any successor resolveThreadRoot call.
  expect(rootOfTab(tab)).toBe("verified");
  expect(h.result.current.threadVisits(tab.channelId, rootOfTab(tab))).toEqual([
    "root",
    "reply",
  ]);
  act(() => h.result.current.closeTabs(""));
  expect(h.result.current.tabs).toEqual([]);
});

test.each(["channel", "message"])(
  "a rebuilt visit cannot reuse a root for a different %s",
  (change) => {
    const scope = crypto.randomUUID();
    const h = renderHook(
      ({ session }) => useChannelTabState(session, "alpha"),
      {
        initialProps: { session: { scope, viewer: "viewer" } as RelaySession },
      },
    );
    const route = { channelId: "alpha", messageId: "reply", rootId: "hint" };
    act(() => h.result.current.enterVisit("reply:thread", route));
    act(() =>
      h.result.current.resolveThreadRoot("thread:alpha:hint", "verified"),
    );
    h.rerender({ session: { scope, viewer: "viewer" } as RelaySession });
    const changed = {
      ...route,
      ...(change === "channel"
        ? { channelId: "beta" }
        : { messageId: "other" }),
    };
    act(() => h.result.current.enterVisit("reply:thread", changed));
    const tab = h.result.current.tabs.find(
      (item) =>
        item.kind === "thread" &&
        item.channelId === changed.channelId &&
        item.messageId === changed.messageId,
    );
    if (tab?.kind !== "thread") throw new Error("Missing rebuilt thread");
    expect(rootOfTab(tab)).toBe("hint");
    expect(h.result.current.threadVisits(changed.channelId, "hint")).toEqual([
      "reply",
    ]);
    expect(h.result.current.threadVisits("alpha", "verified")).toEqual([]);
  },
);

test.each(["account", "community", "unknown"])(
  "%s scope does not inherit another session's retirement records",
  (change) => {
    const first = {
      viewer: "viewer",
      scope: `${crypto.randomUUID()}:viewer`,
    } as RelaySession;
    const h = renderHook(
      ({ session }) => useChannelTabState(session, "alpha"),
      { initialProps: { session: first } },
    );
    act(() =>
      h.result.current.enterVisit("detail:detail", undefined, true, {
        channelId: "alpha",
        target: "nostr:profile",
      }),
    );
    act(() =>
      h.result.current.enterVisit("thread:thread", {
        channelId: "alpha",
        messageId: "root",
        rootId: "root",
      }),
    );
    h.rerender({
      session: {
        viewer: "viewer",
        scope:
          change === "unknown"
            ? undefined
            : change === "account"
              ? first.scope.replace(":viewer", ":other")
              : `other:${first.scope}`,
      } as RelaySession,
    });
    expect(h.result.current.detailVisits("alpha", "nostr:profile")).toEqual([]);
    expect(h.result.current.threadVisits("alpha", "root")).toEqual([]);
    expect(h.result.current.tabs).toEqual([]);
  },
);

test("content retirement identifies only that channel's addressed panel visits beyond fifty layout snapshots", () => {
  const session = {} as RelaySession;
  const h = renderHook(() => useChannelTabState(session, "alpha"));
  const detail = { channelId: "alpha", target: "nostr:profile" };
  act(() => h.result.current.enterVisit("one:detail", undefined, true, detail));
  act(() =>
    h.result.current.enterVisit("two:detail", undefined, true, {
      ...detail,
      target: "https://github.com/sample/project/pull/42",
    }),
  );
  act(() =>
    h.result.current.enterVisit("three:detail", undefined, true, detail),
  );
  for (let i = 0; i < 60; i++)
    act(() => h.result.current.enterVisit(`${i}:channel`));
  expect(h.result.current.detailVisits("alpha", detail.target)).toEqual([
    "one",
    "three",
  ]);
  expect(h.result.current.detailVisits("beta", detail.target)).toEqual([]);
});

test("revisiting a history entry restores its selection without closing threads", () => {
  const session = {} as RelaySession;
  const h = renderHook(() => useChannelTabState(session, "alpha"));
  act(() => h.result.current.enterVisit("one:channel"));
  act(() => h.result.current.select("detail"));
  act(() => h.result.current.setPaneOpen(false));
  // Opening a thread changes selection before its visit arrives.
  act(() => h.result.current.leaveVisit());
  act(() => h.result.current.openThreadTab("alpha", "root", "root"));
  const routed = { channelId: "alpha", messageId: "root", rootId: "root" };
  act(() => h.result.current.enterVisit("two:thread", routed));
  expect(h.result.current.selected).toBe("thread:alpha:root");
  act(() => h.result.current.enterVisit("one:channel"));
  expect(h.result.current.selected).toBe("detail");
  expect(h.result.current.paneOpen).toBe(false);
  expect(h.result.current.tabs).toHaveLength(1);
  // Re-entering the same visit (a remount) changes nothing.
  act(() => h.result.current.select("other"));
  act(() => h.result.current.enterVisit("one:channel"));
  expect(h.result.current.selected).toBe("other");
  act(() => h.result.current.enterVisit("two:thread", routed));
  expect(h.result.current.selected).toBe("thread:alpha:root");
});

test("a new channel visit shows the conversation unless it keeps the current selection", () => {
  const session = {} as RelaySession;
  const h = renderHook(() => useChannelTabState(session, "alpha"));
  act(() => h.result.current.openThreadTab("alpha", "root", "root", "select"));
  act(() => h.result.current.moveTab("thread:alpha:root", "main", 0));
  act(() => h.result.current.enterVisit("one:channel", undefined, true));
  expect(h.result.current.mainSelected).toBe("thread:alpha:root");
  act(() => h.result.current.enterVisit("two:channel"));
  expect(h.result.current.mainSelected).toBeUndefined();
});

test("Back restores an empty side pane as hidden while retaining the later thread", () => {
  const session = {} as RelaySession;
  const h = renderHook(() => useChannelTabState(session, "alpha"));
  act(() => h.result.current.enterVisit("channel"));
  act(() => h.result.current.leaveVisit());
  act(() =>
    h.result.current.enterVisit("link", {
      channelId: "alpha",
      messageId: "root",
      rootId: "root",
    }),
  );
  expect(h.result.current.paneOpen).toBe(true);
  act(() => h.result.current.enterVisit("channel"));
  expect(h.result.current.paneOpen).toBe(false);
  expect(h.result.current.tabs).toHaveLength(1);
});

test("new ordinary and routed threads follow the device choice; existing tabs and moves do not", () => {
  const session = {} as RelaySession;
  const mounted = renderHook(() => useChannelTabState(session, "alpha"));
  act(() => mounted.result.current.openThreadTab("alpha", "one", "one"));
  expect(mounted.result.current.tabs[0]).toMatchObject({ pane: "side" });
  act(() => setThreadPlacementPreference("main"));
  act(() => mounted.result.current.openThreadTab("alpha", "two", "two"));
  expect(mounted.result.current.tabs[1]).toMatchObject({ pane: "main" });
  act(() => mounted.result.current.openThreadTab("alpha", "one", "one"));
  expect(mounted.result.current.tabs[0]).toMatchObject({ pane: "side" });
  act(() =>
    mounted.result.current.enterVisit("link", {
      channelId: "alpha",
      messageId: "three",
      rootId: "three",
    }),
  );
  expect(mounted.result.current.tabs[2]).toMatchObject({ pane: "main" });
  act(() => mounted.result.current.moveTab("thread:alpha:two", "side", 0));
  expect(threadPlacementPreference()).toBe("main");
});

test("the returned state keeps its identity across unrelated re-renders", () => {
  const session = {} as RelaySession;
  const mounted = renderHook(
    ({ channel }) => useChannelTabState(session, channel),
    { initialProps: { channel: "alpha" } },
  );
  const initial = mounted.result.current;
  mounted.rerender({ channel: "alpha" });
  expect(mounted.result.current).toBe(initial);
  act(() => mounted.result.current.select("beta-tab"));
  const selected = mounted.result.current;
  expect(selected).not.toBe(initial);
  expect(selected.selected).toBe("beta-tab");
  expect(selected.select).toBe(initial.select);
  mounted.rerender({ channel: "beta" });
  expect(mounted.result.current).not.toBe(selected);
});

test("agents open thread tabs in the background and never close a shown one", () => {
  const session = tabSession();
  const tabs = channelTabs(session);
  const page = renderHook(() => useChannelTabState(session, "alpha"));
  // An empty side pane stays closed; nothing is selected for the viewer.
  act(() => {
    expect(tabs.open("alpha", "r1")).toBe(true);
  });
  expect(page.result.current).toMatchObject({
    paneOpen: false,
    selected: "thread",
    tabs: [{ id: "thread:alpha:r1", channelId: "alpha", messageId: "r1" }],
  });
  expect(tabs.open("alpha", "r1")).toBe(false);
  // Behind the closed pane it is not shown, so the agent can close it again.
  expect(tabs.list("alpha")).toEqual([
    { root: "r1", pane: "side", shown: false },
  ]);
  // The viewer opens another thread and one from another channel; an agent's
  // later tab leaves their selection, and agents never see the other channel's.
  act(() => page.result.current.openThreadTab("beta", "r3", "r3"));
  act(() => page.result.current.openThreadTab("alpha", "r2", "r2"));
  act(() => {
    tabs.open("alpha", "r4");
  });
  expect(page.result.current).toMatchObject({
    paneOpen: true,
    selected: "thread:alpha:r2",
  });
  expect(tabs.list("alpha")).toEqual([
    { root: "r1", pane: "side", shown: false },
    { root: "r2", pane: "side", shown: true },
    { root: "r4", pane: "side", shown: false },
  ]);
  expect(tabs.close("alpha", "r2")).toBe("shown");
  expect(tabs.close("alpha", "r3")).toBe("missing");
  expect(tabs.close("alpha", "r9")).toBe("missing");
  act(() => {
    expect(tabs.close("alpha", "r1")).toBe("closed");
  });
  expect(page.result.current.tabs.map((tab) => tab.id)).toEqual([
    "thread:beta:r3",
    "thread:alpha:r2",
    "thread:alpha:r4",
  ]);
  expect(page.result.current.selected).toBe("thread:alpha:r2");
  // Other channels and the Solo workspace keep their own tabs.
  expect(tabs.list("beta")).toEqual([]);
  const solo = renderHook(() => useChannelTabState(session, "alpha", "solo"));
  expect(solo.result.current.tabs).toEqual([]);
});

test("an agent's tab leaves a page's side panel showing", () => {
  const session = tabSession();
  const tabs = channelTabs(session);
  const page = renderHook(() => useChannelTabState(session, "alpha"));
  act(() => page.result.current.setSidePanel(true));
  act(() => {
    tabs.open("alpha", "r1");
  });
  expect(page.result.current.paneOpen).toBe(true);
  expect(page.result.current.tabs[0]?.focusRequest).toBeUndefined();
});

test("an agent's main-pane tab leaves the conversation showing", () => {
  setThreadPlacementPreference("main");
  const session = tabSession();
  const tabs = channelTabs(session);
  const page = renderHook(() => useChannelTabState(session, "alpha"));
  act(() => {
    tabs.open("alpha", "r1");
  });
  expect(page.result.current).toMatchObject({
    mainSelected: undefined,
    paneOpen: true,
    tabs: [{ id: "thread:alpha:r1", pane: "main", focusRequest: undefined }],
  });
  act(() => page.result.current.selectMain("thread:alpha:r1"));
  expect(tabs.list("alpha")).toEqual([
    { root: "r1", pane: "main", shown: true },
  ]);
  expect(tabs.close("alpha", "r1")).toBe("shown");
});

test("Solo threads open beside the chat even when the device prefers main", () => {
  setThreadPlacementPreference("main");
  const session = tabSession([
    { id: "alpha", name: "Alpha", channelType: "solo" },
  ]);
  const tabs = channelTabs(session);
  const page = renderHook(() => useChannelTabState(session, "alpha"));
  act(() => {
    tabs.open("alpha", "r1");
  });
  act(() =>
    page.result.current.enterVisit("link", {
      channelId: "alpha",
      messageId: "r2",
      rootId: "r2",
      pane: "side",
    }),
  );
  expect(page.result.current.tabs).toMatchObject([
    { id: "thread:alpha:r1", pane: "side" },
    { id: "thread:alpha:r2", pane: "side" },
  ]);
});

function tabSession(
  channels: readonly ChannelSummary[] = [{ id: "alpha", name: "Alpha" }],
) {
  return {
    channels: { list: () => ({ channels }) },
  } as unknown as RelaySession;
}

test.each(["channel", "page", "community", "unmount"])(
  "agents can close a selected tab after leaving its %s",
  (destination) => {
    const session = tabSession();
    const tabs = channelTabs(session);
    const page = renderHook(
      (props) => useChannelTabState(props.session, props.channel, props.page),
      { initialProps: { session, channel: "alpha", page: "messages" } },
    );
    act(() => page.result.current.openThreadTab("alpha", "side", "side"));
    act(() =>
      page.result.current.openThreadTab(
        "alpha",
        "main",
        "main",
        undefined,
        "main",
      ),
    );
    expect(tabs.list("alpha").every((tab) => tab.shown)).toBe(true);
    if (destination === "unmount") page.unmount();
    else
      page.rerender({
        session: destination === "community" ? tabSession() : session,
        channel: destination === "channel" ? "beta" : "alpha",
        page: destination === "page" ? "solo" : "messages",
      });
    expect(tabs.list("alpha").every((tab) => !tab.shown)).toBe(true);
    act(() => {
      expect(tabs.close("alpha", "side")).toBe("closed");
      expect(tabs.close("alpha", "main")).toBe("closed");
    });
    expect(tabs.list("alpha")).toEqual([]);
  },
);

test("remounting a retained workspace protects its selected tabs again", () => {
  const session = tabSession();
  const tabs = channelTabs(session);
  const page = renderHook(() => useChannelTabState(session, "alpha"));
  act(() => page.result.current.openThreadTab("alpha", "r1", "r1"));
  page.unmount();
  expect(tabs.list("alpha")[0]?.shown).toBe(false);
  renderHook(() => useChannelTabState(session, "alpha"));
  expect(tabs.list("alpha")[0]?.shown).toBe(true);
  expect(tabs.close("alpha", "r1")).toBe("shown");
});

test.each(["missing", "readOnly", "archived", "cached"])(
  "agents cannot open a thread unavailable to the owner (%s)",
  (reason) => {
    const channels =
      reason === "missing"
        ? []
        : [{ id: "alpha", name: "Alpha", [reason]: true }];
    const session = tabSession(channels);
    const tabs = channelTabs(session);
    expect(() => tabs.open("alpha", "r1")).toThrow(
      "Your owner cannot open threads in this channel.",
    );
    expect(tabs.list("alpha")).toEqual([]);
  },
);

test("a joined Guest can open a readable thread without writing access", () => {
  const session = tabSession([
    { id: "alpha", name: "Alpha", readOnly: true, viewerRole: "guest" },
  ]);
  const tabs = channelTabs(session);
  expect(tabs.open("alpha", "r1")).toBe(true);
  expect(tabs.list("alpha")).toHaveLength(1);
});

test("an agent's tab name stays with the tab until cleared", () => {
  const session = tabSession();
  const tabs = channelTabs(session);
  const page = renderHook(() => useChannelTabState(session, "alpha"));
  act(() => page.result.current.openThreadTab("alpha", "r1", "r1"));
  expect(tabs.rename("alpha", "r9", "Missing")).toBe(false);
  act(() => {
    expect(tabs.rename("alpha", "r1", "Launch plan")).toBe(true);
  });
  expect(tabs.list("alpha")).toEqual([
    { root: "r1", pane: "side", name: "Launch plan", shown: true },
  ]);
  // Reopening, moving and remounting keep the same tab and its name.
  act(() => page.result.current.openThreadTab("alpha", "reply", "r1", "reply"));
  act(() => page.result.current.moveTab("thread:alpha:r1", "main", 0));
  page.unmount();
  const remounted = renderHook(() => useChannelTabState(session, "alpha"));
  expect(remounted.result.current.tabs).toMatchObject([
    { id: "thread:alpha:r1", pane: "main", name: "Launch plan" },
  ]);
  // A provisional tab that resolves to the same root merges into the named one.
  act(() => remounted.result.current.openThreadTab("alpha", "r2", "hint"));
  act(() =>
    remounted.result.current.resolveThreadRoot("thread:alpha:hint", "r1"),
  );
  expect(remounted.result.current.tabs).toMatchObject([
    { id: "thread:alpha:r1", name: "Launch plan" },
  ]);
  expect(remounted.result.current.tabs).toHaveLength(1);
  act(() => {
    tabs.rename("alpha", "r1", "  ");
  });
  expect(remounted.result.current.tabs[0]).toMatchObject({ name: undefined });
});

test.each(["foreground", "background"])(
  "a renamed provisional tab keeps its name when it merges into an unnamed tab (%s)",
  (branch) => {
    const session = tabSession();
    const page = renderHook(() => useChannelTabState(session, "alpha"));
    act(() => page.result.current.openThreadTab("alpha", "r1", "r1"));
    act(() => page.result.current.openThreadTab("alpha", "r2", "hint"));
    act(() =>
      page.result.current.renameTab("thread:alpha:hint", "Launch plan"),
    );
    if (branch === "background")
      act(() => page.result.current.select("thread:alpha:r1"));
    act(() => page.result.current.resolveThreadRoot("thread:alpha:hint", "r1"));
    expect(page.result.current.tabs).toHaveLength(1);
    expect(page.result.current.tabs[0]).toMatchObject({ name: "Launch plan" });
  },
);

test("offline sessions with the shared undefined scope never inherit retirement addresses", () => {
  const scope = "undefined:undefined";
  const h = renderHook(({ session }) => useChannelTabState(session, "alpha"), {
    initialProps: { session: { scope } as RelaySession },
  });
  act(() =>
    h.result.current.enterVisit("offline:detail", undefined, true, {
      channelId: "alpha",
      target: "nostr:profile",
    }),
  );
  h.rerender({ session: { scope } as RelaySession });
  expect(h.result.current.detailVisits("alpha", "nostr:profile")).toEqual([]);
});

test("agent Close retires inactive thread visits without moving the current selection", async () => {
  const { createNavigationController } = await import(
    "../../features/navigation/controller"
  );
  const { createMemoryHistory } = await import(
    "../../features/navigation/history"
  );
  const scope = {
    viewer: "a".repeat(64),
    communityOrigin: "https://relay.example",
  };
  const channel = {
    version: 1,
    kind: "conversation",
    scope,
    channelId: "alpha",
  } as const;
  const host = createNavigationController(createMemoryHistory(channel));
  const session = {
    channels: { list: () => ({ channels: [{ id: "alpha" }] }) },
  } as unknown as RelaySession;
  const h = renderHook(() => useChannelTabState(session, "alpha"));
  try {
    for (const root of ["1".repeat(64), "2".repeat(64)]) {
      void host.navigation.open({ ...channel, messageId: root });
      act(() =>
        h.result.current.enterVisit(
          `${host.navigation.snapshot().entry.id}:thread`,
          { channelId: "alpha", messageId: root, rootId: root },
        ),
      );
    }
    const selected = host.navigation.snapshot().attempt;
    act(() =>
      expect(
        channelTabs(session, host.navigation).close("alpha", "1".repeat(64)),
      ).toBe("closed"),
    );
    expect(host.navigation.snapshot().attempt).toBe(selected);
    expect(h.result.current.selected).toBe(`thread:alpha:${"2".repeat(64)}`);
    expect(h.result.current.threadVisits("alpha", "1".repeat(64))).toEqual([]);
    host.navigation.back();
    expect(host.navigation.snapshot().entry.target).toEqual(channel);
    host.navigation.forward();
    expect(host.navigation.snapshot().attempt.entry).toBe(selected.entry);
  } finally {
    host.dispose();
  }
});

test("retirement metadata follows the bounded history window and drops dismissed identities", async () => {
  const { createNavigationController } = await import(
    "../../features/navigation/controller"
  );
  const { createMemoryHistory } = await import(
    "../../features/navigation/history"
  );
  const scope = {
    viewer: "a".repeat(64),
    communityOrigin: "https://relay.example",
  };
  const channel = {
    version: 1,
    kind: "conversation",
    scope,
    channelId: "alpha",
  } as const;
  const host = createNavigationController(createMemoryHistory(channel));
  const session = {
    viewer: scope.viewer,
    scope: `${scope.communityOrigin}:${scope.viewer}`,
  } as RelaySession;
  const h = renderHook(() =>
    useChannelTabState(session, "alpha", "messages", host.navigation),
  );
  try {
    for (let i = 0; i < 150; i++) {
      const target = `https://github.com/sample/project/pull/${i}`;
      act(() => {
        void host.navigation.open({ ...channel, detail: { target } });
        h.result.current.enterVisit(
          `${host.navigation.snapshot().entry.id}:detail`,
          undefined,
          true,
          { channelId: "alpha", target },
        );
      });
    }
    expect(
      Array.from({ length: 150 }, (_, i) =>
        h.result.current.detailVisits(
          "alpha",
          `https://github.com/sample/project/pull/${i}`,
        ),
      ).flat(),
    ).toHaveLength(100);
    const current = host.navigation.snapshot().entry.id;
    act(() => host.navigation.dismiss([current], channel));
    expect(
      h.result.current.detailVisits(
        "alpha",
        "https://github.com/sample/project/pull/149",
      ),
    ).toEqual([]);
    h.unmount();
    const successor = renderHook(() =>
      useChannelTabState(
        { ...session } as RelaySession,
        "alpha",
        "messages",
        host.navigation,
      ),
    );
    expect(
      Array.from({ length: 150 }, (_, i) =>
        successor.result.current.detailVisits(
          "alpha",
          `https://github.com/sample/project/pull/${i}`,
        ),
      ).flat(),
    ).toHaveLength(99);
  } finally {
    host.dispose();
  }
});
