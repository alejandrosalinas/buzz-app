// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import { ChatNotStarted } from "../../features/relay/channel-writes";
import { ApiPaused } from "../../features/relay/http-admission";
import { ChannelLifecycleUnconfirmed } from "../../features/relay/channel-lifecycle";
import { keypair, signed } from "../../features/relay/testing";
import type { RelayData } from "../../features/relay/service";
import type {
  ChannelList,
  ChannelSummary,
} from "../../features/relay/contracts";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import type { PageNavigation } from "../../features/navigation/service";
import type { Navigation } from "../../features/navigation/controller";
import type { OpenTarget } from "../../features/navigation/targets";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { ChannelNavigationProvider } from "../../features/channel-navigation/ChannelNavigationState";
import {
  conversationTarget,
  soloDraftTarget,
} from "../../features/channel-navigation/routes";
import { linkedDraftKey } from "../../features/solo/linked-chat";
import { attachmentDraft } from "../../features/messages/attachment-draft";
import type { ComposerSession } from "../../features/messages/composer-session";
import { readView, writeView } from "../../shared/view-state";
import { splitPartition } from "../../features/relay/partition";
import {
  ChannelsPage,
  type ArchiveShortcut,
  type ReadShortcut,
} from "./ChannelsPage";
import { SoloWorkspaces } from "./SoloWorkspaces";
import type { RelaySession } from "../../features/relay/session";
import type { RegisteredSidebarRows } from "../../features/channel-navigation/sidebar-rows-service";
import type { ReadTarget } from "../../features/relay/read-state-model";

vi.mock(
  "../../features/messages/solo-model-picks-storage",
  () => import("../../features/messages/solo-model-picks-storage-testing"),
);

composerDOMFixture();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  localStorage.clear();
  for (const owner of owners.splice(0)) owner.dispose();
  vi.unstubAllGlobals();
});
const id = "11111111-1111-4111-8111-111111111111";
const agent = "a".repeat(64);
const empty: readonly never[] = [];
const contribution = { snapshot: () => empty, subscribe: () => () => {} };
const extensions = { tools: contribution, inline: contribution };
function fixture({
  placed = true,
  type = "solo",
  target,
  behindSettings = false,
  people = [],
  unloaded = false,
  departed = false,
  ownedBy,
  archived = false,
  viewerNamed = false,
  others = [],
  unread,
  capability = "frontier-sync",
  viewOnly = false,
  canLeave,
  preview,
  sidebarRows,
  member = false,
  emptyHistory = false,
  restored = false,
}: {
  sidebarRows?: readonly RegisteredSidebarRows[];
  /** Observed unread messages in this chat; fakes the read state when given. */
  unread?: number;
  /** What the read state can do on this connection. */
  capability?: "unsupported" | "read-only" | "frontier-sync";
  viewOnly?: boolean;
  canLeave?: boolean;
  /** The viewer is a plain member; only its agent owns the conversation. */
  member?: boolean;
  /** The relay has no history at all, so the timeline settles empty. */
  emptyHistory?: boolean;
  /** Membership downloaded from disk that the relay has not confirmed yet. */
  restored?: boolean;
  /** An unjoined reader of an open chat, including legacy admission defaults. */
  preview?: { joinRole?: "member" | "guest" };
  /** Other Solo chats listed after this one in the sidebar's Chats. */
  others?: readonly string[];
  /** The viewer's own profile has loaded too. */
  viewerNamed?: boolean;
  /** Someone other than the viewer or its agent created the chat. */
  ownedBy?: string;
  archived?: boolean;
  /** Other people in the chat besides the viewer and its agent. */
  people?: readonly string[];
  /** The people's profiles never load, so nothing confirms they are people. */
  unloaded?: boolean;
  /** The people have left by the time a send refreshes the roster. */
  departed?: boolean;
  /** Whether the viewer created the chat, rather than joining it as a guest. */
  placed?: boolean;
  type?: "solo" | "stream";
  target?: (scope: string) => OpenTarget;
  /** Settings is open over this retained page. */
  behindSettings?: boolean;
} = {}) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const viewer = keypair();
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: keypair().pubkey,
      scope: "https://test.example",
      media: () => undefined,
      query: async () => [],
      writer: {
        kinds: [9, 9000],
        sign: async (event) => signed(viewer, event),
        publish: async () => {},
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  const scope = `https://test.example:${viewer.pubkey}`;
  const listeners = new Set<() => void>();
  const channel: ChannelSummary = {
    id,
    name: "Planning",
    channelType: type,
    ...(!preview && { private: true as const }),
    creator: ownedBy ?? (placed ? viewer.pubkey : agent),
    members: [viewer.pubkey, agent, ...people],
    // The signed roster's roles: a creator owns the chat, a viewer is a guest.
    viewerRole: "owner",
    owners: canLeave ? [viewer.pubkey, agent] : [viewer.pubkey],
    ...(member && { viewerRole: "member" as const, owners: [agent] }),
    ...(viewOnly && {
      readOnly: true as const,
      viewerRole: "guest" as const,
      owners: [agent],
    }),
    ...(preview && {
      members: [agent, ...people],
      readOnly: true,
      ...preview,
    }),
    ...(archived && { archived }),
    ...(restored && { cached: true as const, readOnly: true as const }),
  };
  const neighbors = others.map((other, index) => ({
    ...channel,
    id: other,
    name: `Other ${index + 1}`,
  }));
  let list: ChannelList = {
    status: "ready",
    channels: [channel, ...neighbors],
  };
  // Discovery commits, as `ChannelList.asOf`.
  let reads = 0;
  const listListeners = new Set<() => void>();
  const emitList = () => {
    for (const listener of listListeners) listener();
  };
  const window = {
    ...owner.session.channels.window(id),
    status: "ready" as const,
    rows: [],
    ...(emptyHistory && { hasMore: false }),
  };
  const send = vi.fn<typeof owner.session.messages.send>(() => "d".repeat(64));
  // Like the relay, settle the roster before the confirmed action resolves.
  const run = vi.fn(
    async (action: string, _id?: string, _signal?: AbortSignal) => {
      const { archived: _, ...restored } = channel;
      list = {
        ...list,
        channels: [
          ...(action === "archive"
            ? [{ ...channel, archived: true as const }]
            : action === "unarchive"
              ? [restored]
              : []),
          ...list.channels.filter((chat) => chat.id !== id),
        ],
      };
      emitList();
    },
  );
  // After removal, a public channel's relay still serves it as a preview.
  let removal:
    | { preview?: ChannelSummary; reloading?: boolean; refused?: boolean }
    | undefined;
  // Access checks the page started, so absence can wait for them to settle.
  const accessChecks: Promise<unknown>[] = [];
  // The default agent comes first, so a named agent is distinguishable from it.
  const agents = [
    { pubkey: "b".repeat(64), name: "Helper", managed: false },
    { pubkey: agent, name: "Scout", managed: false },
  ];
  const choices = {
    ...owner.session.agentChoices.snapshot(),
    status: "ready" as const,
    complete: true,
    identities: agents,
    selectable: agents,
    archives: { status: "unavailable" as const, archived: [] },
  };
  // A stable snapshot, as useSyncExternalStore requires.
  const projects = {
    status: "ready" as const,
    data: {
      sections: [{ id: "work", name: "Work", order: 0 }],
      assignments: {},
      starred: [],
      muted: [],
    },
  };
  // A stable snapshot, as useSyncExternalStore requires.
  const profiles = new Map<string, { name: string }>([
    ...(unloaded
      ? []
      : people.map((key) => [key, { name: "Teammate" }] as const)),
    ...(viewerNamed ? [[viewer.pubkey, { name: "Viewer" }] as const] : []),
  ]);
  const markRead = vi.fn(async (_channelId: string) => ({}) as never);
  // useSyncExternalStore needs stable snapshots.
  const unreadState = {
    observedCount: unread ?? 0,
    attentionCount: 0,
    coverage: "observed" as const,
    freshness: "observed" as const,
    manual: "none" as const,
  };
  const unreadStates = new Map<
    string,
    typeof unreadState & { target: ReadTarget }
  >();
  const noActivity = {
    channelId: id,
    items: [],
    coverage: "observed" as const,
    freshness: "observed" as const,
  };
  const readSync = {
    capability,
    status: "reconciled" as const,
    completeness: "snapshot" as const,
  };
  const session = {
    ...owner.session,
    profiles: {
      ...owner.session.profiles,
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: () => new Promise<never>(() => {}),
    },
    agentChoices: {
      ...owner.session.agentChoices,
      retain: () => () => {},
      snapshot: () => choices,
      subscribe: () => () => {},
      refresh: async () => {},
    },
    channelLifecycle: {
      ...owner.session.channelLifecycle,
      available: true,
      load: vi.fn(async () => ({
        channelId: id,
        channelType: "stream" as const,
        canArchive: !viewOnly,
        canUnarchive: false,
        canDelete: !viewOnly,
        canLeave: canLeave ?? viewOnly,
        canHide: false,
      })),
      run,
    },
    channelDetails: {
      ...owner.session.channelDetails,
      available: true,
      load: vi.fn(async () => ({
        channelId: id,
        version: "test",
        name: "Planning",
        description: "",
        visibility: "private" as const,
        canEdit: true,
      })),
    },
    channels: {
      ...owner.session.channels,
      list: () => list,
      subscribeList: (listener: () => void) => {
        listListeners.add(listener);
        return () => {
          listListeners.delete(listener);
        };
      },
      ensureList() {},
      refreshRoster: vi.fn(async () => true),
      window: () => window,
      ensure() {},
      resolve: async (
        ids: readonly string[],
        options?: Parameters<
          NonNullable<typeof owner.session.channels.resolve>
        >[1],
      ) => {
        const check = (async () => {
          if (!removal) return owner.session.channels.resolve?.(ids, options);
          if (removal.refused) throw new Error("Channel unavailable");
          removal.reloading = false;
        })();
        accessChecks.push(check);
        return check;
      },
      get: (channelId: string) =>
        removal?.preview?.id === channelId && !removal.reloading
          ? removal.preview
          : owner.session.channels.get?.(channelId),
    },
    soloPreferences: {
      ...owner.session.soloPreferences,
      snapshot: () => projects,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    messages: { ...owner.session.messages, send },
    unread:
      unread === undefined
        ? owner.session.unread
        : {
            ...owner.session.unread,
            sync: () => readSync,
            snapshot: (
              target: Parameters<typeof owner.session.unread.snapshot>[0],
            ) => {
              const key = JSON.stringify(target);
              let state = unreadStates.get(key);
              if (!state) {
                state = { ...unreadState, target };
                unreadStates.set(key, state);
              }
              return state;
            },
            activity: () => noActivity,
            markChannelRead: markRead,
          },
    channelWrites: {
      ...owner.session.channelWrites,
      available: true,
      // A new chat joins the owner's list once its creation is requested.
      create: vi.fn((chat: string) => {
        list = {
          ...list,
          channels: [...list.channels, { ...channel, id: chat, name: "" }],
        };
        emitList();
        return "c".repeat(64);
      }),
      // Starts through the create above; the relay accepts it at once.
      start: vi.fn((chat: string) => ({
        create: session.channelWrites.create(chat),
        ready: Promise.resolve(),
      })),
      delivered: vi.fn(async () => {}),
      refresh: vi.fn(async () => {}),
      addAgents: vi.fn(async () => {}),
      refreshMembership: vi.fn(async () =>
        departed ? { ...channel, members: [viewer.pubkey, agent] } : channel,
      ),
    },
  };
  let snapshot: ReturnType<RelayData["snapshot"]> = {
    status: "ready" as const,
    generation: 1,
    scope,
    viewer: viewer.pubkey,
    session,
  };
  const relayListeners = new Set<() => void>();
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: (listener) => {
      relayListeners.add(listener);
      return () => {
        relayListeners.delete(listener);
      };
    },
    retry() {},
    tryAgain() {},
    disconnect() {},
    async clearCache() {},
  };
  const abort = new AbortController();
  const complete = vi.fn(() => true);
  let navigation: PageNavigation = {
    entryId: "visit",
    target: target?.(scope) ?? conversationTarget(scope, id),
    signal: abort.signal,
    position: () => undefined,
    savePosition() {},
    forSession: () => navigation,
    passThrough: vi.fn<PageNavigation["passThrough"]>(() => () => {}),
    complete,
    resolve: () => true,
  };
  const open = vi.fn<Navigation["open"]>(async (target) => {
    navigationSnapshot.entry.target = target;
    return { status: "opened" as const };
  });
  const navigationSnapshot = {
    entry: {
      id: navigation.entryId,
      target: behindSettings
        ? { version: 1, kind: "settings", scope: null }
        : (navigation.target as OpenTarget),
    },
    attempt: { signal: abort.signal },
  };
  const navigator = {
    open,
    retry() {},
    snapshot: () => navigationSnapshot,
    subscribe: () => () => {},
  } as unknown as Navigation;
  const archive: ArchiveShortcut = {};
  const read: ReadShortcut = {};
  const page = (sidebar = false) => (
    <ChannelNavigationProvider relay={relay}>
      {sidebar && (
        <SoloWorkspaces
          session={session as unknown as RelaySession}
          navigator={navigator}
          scope={scope}
          sidebarRows={sidebarRows}
          chats={[channel, ...neighbors].map((chat) => ({
            id: chat.id,
            title: chat.name,
          }))}
          renderChat={(item) => <button type="button">{item.title}</button>}
        />
      )}
      <ChannelsPage
        relay={relay}
        panels={{
          ...contribution,
          register() {},
          resolve: () => undefined,
          requestOpen: () => false,
          handleOpenRequests: () => () => {},
        }}
        extensions={extensions}
        navigation={navigation}
        navigator={navigator}
        archive={archive}
        read={read}
      />
    </ChannelNavigationProvider>
  );
  let rendered: ReturnType<typeof render> | undefined;
  return {
    navigation,
    mount: () => render(page()),
    mountWithToasts: () =>
      (rendered = render(<ToastProvider>{page()}</ToastProvider>)),
    /** The navigator moved this page's visit to `next`. */
    show(next: OpenTarget) {
      navigation = { ...navigation, target: next };
      navigationSnapshot.entry.target = next;
      rendered?.rerender(<ToastProvider>{page()}</ToastProvider>);
    },
    mountWithSidebar: (toasts = false) =>
      render(toasts ? <ToastProvider>{page(true)}</ToastProvider> : page(true)),
    abort,
    archive,
    read,
    markRead,
    open,
    run,
    send,
    scope,
    session,
    setArchived(archived: boolean) {
      const next = { ...channel };
      if (archived) next.archived = true;
      else delete next.archived;
      list = { ...list, channels: [next] };
      emitList();
    },
    updateChat(id: string, change: Partial<ChannelSummary>) {
      list = {
        ...list,
        channels: list.channels.map((chat) =>
          chat.id === id ? { ...chat, ...change } : chat,
        ),
      };
      emitList();
    },
    /** An admin removed the viewer: the roster drops the conversation, which
     * stays readable as a preview only when it is public. As from the store,
     * the access check of a private one succeeds with nothing to read, unless
     * the relay `refused` the read. `reloading`: as for a channel the store
     * listed, the preview is served only once the page's next access check
     * reads it again. */
    remove(visibility: "private" | "refused" | "public", reloading = false) {
      const { private: _, viewerRole: __, cached: ___, ...open } = channel;
      removal =
        visibility === "public"
          ? {
              preview: { ...open, members: [agent], readOnly: true },
              reloading,
            }
          : { refused: visibility === "refused" };
      list = {
        ...list,
        asOf: ++reads,
        channels: list.channels.filter((chat) => chat.id !== id),
      };
      emitList();
    },
    /** A complete roster read, by default one that still lists the
     * conversation, as confirmed by the relay. */
    reread(listed = true) {
      const { cached: _, readOnly: __, ...confirmed } = channel;
      const { coverage: ___, ...rest } = list;
      list = {
        ...rest,
        asOf: ++reads,
        rosterAsOf: reads,
        channels: [
          ...list.channels.filter((chat) => chat.id !== id),
          ...(listed ? [restored ? confirmed : channel] : []),
        ],
      };
      emitList();
    },
    /** Discovery commits the list again without a complete roster read, as
     * for live metadata of another channel. */
    discover() {
      list = { ...list, status: "ready", asOf: ++reads };
      emitList();
    },
    /** A roster read failed; the list keeps what it had. */
    failRead() {
      list = { ...list, status: "error", error: "offline" };
      emitList();
    },
    /** Live roster: the viewer is a member again. */
    rejoin() {
      removal = undefined;
      list = {
        ...list,
        asOf: ++reads,
        channels: [...list.channels.filter((chat) => chat.id !== id), channel],
      };
      emitList();
    },
    /** A roster read begins: until it completes, commits are partial. */
    rereading() {
      list = { ...list, coverage: "partial", asOf: ++reads };
      emitList();
    },
    /** How many access checks the page has started. */
    accessChecks: () => accessChecks.length,
    /** Every access check the page started has settled and been applied. */
    async accessSettled() {
      await waitFor(() => expect(accessChecks.length).toBeGreaterThan(0));
      await act(async () => {
        await Promise.allSettled(accessChecks);
      });
    },
    /** The roster read failed, or only part of it arrived. */
    degrade(next: { status: "error" } | { coverage: "partial" }) {
      list = {
        ...list,
        ...next,
        channels: list.channels.filter((chat) => chat.id !== id),
      };
      emitList();
    },
    /** The relay connection hands this page a new session that lists none
     * of this viewer's conversations yet. The generation stays, so the
     * mounted workspace stays too. */
    reconnect() {
      const unlisted: ChannelList = { status: "ready", channels: [] };
      snapshot = {
        ...snapshot,
        session: {
          ...session,
          channels: { ...session.channels, list: () => unlisted },
        } as unknown as RelaySession,
      };
      for (const listener of relayListeners) listener();
    },
    // Chat activity: a new summary object for the same chat.
    retitle(name: string) {
      list = { ...list, channels: [{ ...channel, name }] };
      emitList();
    },
  };
}
it("archives from the shortcut without confirmation, then opens a new Solo draft", async () => {
  const f = fixture();
  f.mount();
  await waitFor(() => expect(f.archive.current?.available()).toBe(true));
  await act(async () => f.archive.current?.run());
  expect(f.session.channelLifecycle.load).toHaveBeenCalledWith(
    id,
    expect.any(AbortSignal),
  );
  expect(screen.queryByRole("dialog", { name: /^Archive chat/ })).toBeNull();
  await waitFor(() => expect(f.open).toHaveBeenCalled());
  expect(f.run).toHaveBeenCalledExactlyOnceWith(
    "archive",
    id,
    expect.any(AbortSignal),
  );
  expect(f.open).toHaveBeenCalledExactlyOnceWith(soloDraftTarget(f.scope));
  expect(f.archive.current).toBeUndefined();
});

it("offers no Archive shortcut outside a Solo chat", async () => {
  const f = fixture({ type: "stream" });
  f.mount();
  await screen.findByRole("textbox", { name: "Message Planning" });
  expect(f.archive.current).toBeUndefined();
});

it("turns /leave into the existing channel confirmation without posting it", async () => {
  const f = fixture({ type: "stream", canLeave: true });
  f.mount();
  const editor = await screen.findByRole("textbox", {
    name: "Message Planning",
  });
  const user = userEvent.setup();
  await user.type(editor, "/leave{Enter}");
  const dialog = await screen.findByRole("dialog", {
    name: "Leave channel: Planning",
  });
  expect(f.session.channelLifecycle.load).toHaveBeenCalledWith(
    id,
    expect.any(AbortSignal),
  );
  expect(f.send).not.toHaveBeenCalled();
  expect(editor).toHaveValue("");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(editor).toHaveFocus());
  expect(f.run).not.toHaveBeenCalled();
});

it("retires the Archive shortcut once the chat is archived", async () => {
  const f = fixture();
  f.mount();
  await waitFor(() => expect(f.archive.current).toBeDefined());
  await act(() => f.run("archive"));
  await waitFor(() => expect(f.archive.current).toBeUndefined());
});

it("opens no Archive from the shortcut where the menu offers none", async () => {
  const f = fixture();
  f.mount();
  await waitFor(() => expect(f.archive.current).toBeDefined());
  f.session.channelLifecycle.load.mockResolvedValueOnce({
    channelId: id,
    channelType: "stream",
    canArchive: false,
    canUnarchive: false,
    canDelete: false,
    canLeave: true,
    canHide: false,
  });
  await act(async () => f.archive.current?.run());
  f.session.channelLifecycle.load.mockRejectedValueOnce(new Error("offline"));
  await act(async () => f.archive.current?.run());
  // Each press reads permission afresh.
  expect(f.session.channelLifecycle.load).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(f.run).not.toHaveBeenCalled();
});

it("keeps a shortcut Archive across chat activity during the permission read", async () => {
  const f = fixture();
  let release = () => {};
  f.session.channelLifecycle.load.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            channelId: id,
            channelType: "stream",
            canArchive: true,
            canUnarchive: false,
            canDelete: true,
            canLeave: false,
            canHide: false,
          });
      }),
  );
  f.mountWithToasts();
  await waitFor(() => expect(f.archive.current).toBeDefined());
  let pending: Promise<void> | undefined;
  act(() => {
    pending = f.archive.current?.run();
  });
  act(() => f.retitle("Roadmap"));
  await act(async () => {
    release();
    await pending;
  });
  // The result names the latest summary, not the one at keypress.
  expect(
    await screen.findByRole("dialog", { name: "Chat archived: Roadmap" }),
  ).toBeInTheDocument();
});

it("stops offering the Archive shortcut when its visit ends", async () => {
  const f = fixture();
  f.mount();
  await waitFor(() => expect(f.archive.current?.available()).toBe(true));
  f.abort.abort();
  expect(f.archive.current?.available()).toBe(false);
});

it("renders a Solo draft route as the new chat composer", async () => {
  const f = fixture({ target: (scope) => soloDraftTarget(scope) });
  f.mount();
  const region = await screen.findByRole("region", { name: "New chat" });
  expect(
    within(region).getByRole("textbox", { name: "Message your agents" }),
  ).toBeVisible();
  expect(screen.queryByLabelText("Channel message history")).toBeNull();
  expect(f.archive.current).toBeUndefined();
});

it("keeps the newer destination when a departed New chat acquires model ownership", async () => {
  const first = fixture({
    target: (scope) => soloDraftTarget(scope, { agent }),
  });
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested!: () => void;
  const waiting = new Promise<void>((resolve) => {
    requested = resolve;
  });
  let completed!: () => void;
  const settled = new Promise<void>((resolve) => {
    completed = resolve;
  });
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (_name: string, run: () => unknown) => {
        requested();
        await held;
        try {
          return run();
        } finally {
          completed();
        }
      },
    },
  });
  const view = first.mount();
  const user = userEvent.setup();
  try {
    await user.type(
      await screen.findByRole("textbox", { name: "Message your agents" }),
      "Start before navigating",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waiting;
    expect(first.send).toHaveBeenCalledOnce();
    first.abort.abort();
    view.unmount();
    const newer = fixture({ type: "stream" });
    newer.mount();
    await screen.findByRole("textbox", { name: "Message Planning" });
    await act(async () => {
      release();
      await settled;
    });
    expect(first.open).not.toHaveBeenCalled();
    expect(newer.open).not.toHaveBeenCalled();
    expect(
      screen.getByRole("textbox", { name: "Message Planning" }),
    ).toBeVisible();
  } finally {
    release();
    if (descriptor) Object.defineProperty(navigator, "locks", descriptor);
    else Reflect.deleteProperty(navigator, "locks");
  }
});

it("keeps refused-start restoration visibly retryable when window ownership fails again", async () => {
  const f = fixture({ target: (scope) => soloDraftTarget(scope, { agent }) });
  let refuse!: () => void;
  const ready = new Promise<void>((_resolve, reject) => {
    refuse = () => reject(new ChatNotStarted("Channel creation rejected"));
  });
  f.session.channelWrites.start.mockImplementationOnce((chat) => ({
    create: f.session.channelWrites.create(chat),
    ready,
  }));
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
  const available = {
    request: async (_name: string, run: () => unknown) => run(),
  };
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: available,
  });
  f.mountWithToasts();
  const user = userEvent.setup();
  try {
    await user.type(
      await screen.findByRole("textbox", { name: "Message your agents" }),
      "Keep this message",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(f.open).toHaveBeenCalledOnce());
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: async () => {
          throw new Error("Lock refused");
        },
      },
    });
    await act(async () => {
      refuse();
      await ready.catch(() => {});
    });
    const retry = () =>
      screen.findByRole("button", { name: "Retry restoring message" });
    const firstRetry = await retry();
    fireEvent.click(firstRetry);
    // The toast consumes its action before invoking it; a second failure must
    // offer a new action retaining the same refused prompt.
    await waitFor(() => expect(firstRetry).not.toBeInTheDocument());
    const offeredAgain = await retry();
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: available,
    });
    fireEvent.click(offeredAgain);
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Message your agents" }),
      ).toHaveTextContent("Keep this message"),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Retry restoring message" }),
      ).toBeNull(),
    );
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.session.channelWrites.start).toHaveBeenCalledOnce();
  } finally {
    if (descriptor) Object.defineProperty(navigator, "locks", descriptor);
    else Reflect.deleteProperty(navigator, "locks");
  }
});

it("starts a Solo draft route in its project, with that project's saved draft", async () => {
  const f = fixture({
    target: (scope) => soloDraftTarget(scope, { project: "work" }),
  });
  writeView(f.scope, "solo:project:work:new-draft", {
    text: "Plan the week",
    recipients: [],
  });
  writeView(f.scope, "solo:new-draft", { text: "Unfiled", recipients: [] });
  f.mount();
  const region = await screen.findByRole("region", { name: "New chat" });
  expect(
    within(region).getByRole("textbox", { name: "Message your agents" }),
  ).toHaveTextContent("Plan the week");
  await waitFor(() =>
    expect(
      within(region).getByRole("button", { name: "Workspace: Work" }),
    ).toBeEnabled(),
  );
});

it("addresses a Solo draft route's agent in the new chat without tagging the text", async () => {
  const f = fixture({ target: (scope) => soloDraftTarget(scope, { agent }) });
  f.mount();
  const region = await screen.findByRole("region", { name: "New chat" });
  const input = within(region).getByRole("textbox", {
    name: "Message your agents",
  });
  expect(
    within(region).getByRole("button", { name: "Add workspace" }),
  ).toBeVisible();
  // The routed agent is the recipient, held outside the text.
  const user = userEvent.setup();
  await user.click(input);
  expect(input).not.toHaveTextContent("@");
  await user.keyboard("Hello{Enter}");
  await waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
  expect(f.send).toHaveBeenCalledWith(expect.any(String), "Hello", [agent]);
});

it("keeps a new chat out of Back history until something is written in it", async () => {
  const f = fixture({ target: (scope) => soloDraftTarget(scope, { agent }) });
  f.mount();
  const region = await screen.findByRole("region", { name: "New chat" });
  const input = within(region).getByRole("textbox", {
    name: "Message your agents",
  });
  const user = userEvent.setup();
  await user.click(input);
  const passes = vi.mocked(f.navigation.passThrough).mock.lastCall?.[0];
  // The agent is addressed outside the text, and nothing is saved: nothing
  // to come back to.
  expect(input).not.toHaveTextContent("@");
  expect(readView(f.scope, "solo:new-draft", null)).toBeNull();
  expect(passes?.()).toBe(true);
  await user.keyboard(" Plan the week");
  expect(passes?.()).toBe(false);
  await user.click(
    within(region).getByRole("button", { name: "Send message" }),
  );
  await waitFor(() => expect(f.open).toHaveBeenCalledOnce());
  // The sent draft is spent; the started chat takes its place.
  expect(passes?.()).toBe(true);
});

it("gives a new chat that could not be started its draft's place in Back history", async () => {
  const f = fixture({ target: (scope) => soloDraftTarget(scope, { agent }) });
  let refuse: (reason: unknown) => void = () => {};
  vi.mocked(f.session.channelWrites.start).mockImplementationOnce(
    (chat: string) => ({
      create: f.session.channelWrites.create(chat),
      ready: new Promise<void>((_resolve, reject) => {
        refuse = reject;
      }),
    }),
  );
  f.mountWithToasts();
  const region = await screen.findByRole("region", { name: "New chat" });
  const user = userEvent.setup();
  await user.click(
    within(region).getByRole("textbox", { name: "Message your agents" }),
  );
  await user.keyboard(" Plan the week{Enter}");
  await waitFor(() => expect(f.open).toHaveBeenCalledOnce());
  const chat = vi.mocked(f.session.channelWrites.start).mock.lastCall?.[0];
  expect(chat).toBeDefined();
  f.show(conversationTarget(f.scope, chat ?? ""));
  await act(async () => refuse(new ChatNotStarted("relay refused")));
  // Replacing the never-made chat leaves Back at the draft's opener.
  await waitFor(() =>
    expect(f.open).toHaveBeenLastCalledWith(
      soloDraftTarget(f.scope, { agent }),
      { replace: true },
    ),
  );
});

it("routes between keyed region drafts without reusing the other editor", async () => {
  const region = "buzz.region:example:work";
  const destination = (scope: string, key: string) =>
    soloDraftTarget(scope, {
      region,
      draft: { key, context: { item: key } },
    });
  const f = fixture({ target: (scope) => destination(scope, "first") });
  writeView(
    f.scope,
    `solo:region:${region}:draft:first:new-draft`,
    "First intent",
  );
  writeView(
    f.scope,
    `solo:region:${region}:draft:second:new-draft`,
    "Second intent",
  );
  f.mountWithToasts();
  expect(
    await screen.findByRole("textbox", { name: "Message your agents" }),
  ).toHaveTextContent("First intent");
  f.show(destination(f.scope, "second"));
  expect(
    await screen.findByRole("textbox", { name: "Message your agents" }),
  ).toHaveTextContent("Second intent");
  f.show(JSON.parse(JSON.stringify(destination(f.scope, "first"))));
  expect(
    await screen.findByRole("textbox", { name: "Message your agents" }),
  ).toHaveTextContent("First intent");
});

it("keeps a written new chat in Back history when its draft cannot be saved", async () => {
  const f = fixture({ target: (scope) => soloDraftTarget(scope, { agent }) });
  const draftStorageKey = `buzz-view.v1:${JSON.stringify([f.scope, "solo:new-draft"])}`;
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key: string,
    value: string,
  ) {
    if (key === draftStorageKey)
      throw new DOMException("Storage is full", "QuotaExceededError");
    setItem.call(this, key, value);
  });
  try {
    f.mount();
    const region = await screen.findByRole("region", { name: "New chat" });
    const input = within(region).getByRole("textbox", {
      name: "Message your agents",
    });
    const user = userEvent.setup();
    await user.click(input);
    const passes = vi.mocked(f.navigation.passThrough).mock.lastCall?.[0];
    expect(passes?.()).toBe(true);
    await user.keyboard(" Unsaved but written");
    expect(readView(f.scope, "solo:new-draft", null)).toBeNull();
    expect(passes?.()).toBe(false);
  } finally {
    vi.mocked(Storage.prototype.setItem).mockRestore();
  }
});

it("keeps a saved draft that only tags the default agent in Back history", async () => {
  const f = fixture({ target: (scope) => soloDraftTarget(scope, { agent }) });
  // A tag the person typed, saved with its editor snapshot.
  const typed = {
    text: "@Scout ",
    recipients: [{ pubkey: agent, name: "Scout", start: 0, end: 6 }],
    document: {
      version: 1,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "@Scout",
                marks: [
                  {
                    type: "recipient",
                    attrs: { pubkey: agent, name: "Scout" },
                  },
                ],
              },
              { type: "text", text: " " },
            ],
          },
        ],
      },
    },
  };
  writeView(f.scope, "solo:new-draft", typed);
  f.mount();
  const region = await screen.findByRole("region", { name: "New chat" });
  await waitFor(() =>
    expect(
      within(region).getByRole("textbox", { name: "Message your agents" }),
    ).toHaveTextContent("@Scout"),
  );
  const passes = vi.mocked(f.navigation.passThrough).mock.lastCall?.[0];
  expect(passes?.()).toBe(false);
  expect(readView(f.scope, "solo:new-draft", null)).toEqual(typed);
});

it("keeps a linked chat draft in Back history until its source is used", async () => {
  const linked = "22222222-2222-4222-8222-222222222222";
  const f = fixture({ target: (scope) => soloDraftTarget(scope, { linked }) });
  const link = `buzz://message?channel=33333333-3333-4333-8333-333333333333&id=${"e".repeat(64)}`;
  writeView(f.scope, linkedDraftKey(linked), {
    channelId: "33333333-3333-4333-8333-333333333333",
    link,
  });
  f.mount();
  await waitFor(() =>
    expect(screen.getByRole("textbox")).toHaveTextContent(link),
  );
  const passes = vi.mocked(f.navigation.passThrough).mock.lastCall?.[0];
  expect(
    readView(f.scope, `${linkedDraftKey(linked)}:new-draft`, null),
  ).toBeNull();
  expect(passes?.()).toBe(false);
  // As a successful start leaves it: source consumed, draft absent.
  writeView(f.scope, linkedDraftKey(linked), null);
  expect(passes?.()).toBe(true);
});

it("counts a new chat's attached file as written", async () => {
  const f = fixture({ target: soloDraftTarget });
  f.mount();
  const region = await screen.findByRole("region", { name: "New chat" });
  const passes = vi.mocked(f.navigation.passThrough).mock.lastCall?.[0];
  expect(passes?.()).toBe(true);
  Object.assign(f.session, { attachments: { uploadForNewChat: vi.fn() } });
  attachmentDraft(
    f.session as unknown as ComposerSession,
    `${f.scope}:solo:new-draft`,
    "",
    true,
  ).addUploaded({
    name: "notes.txt",
    url: "https://media.invalid/notes.txt",
    type: "text/plain",
    size: 5,
    sha256: "f".repeat(64),
  });
  expect(passes?.()).toBe(false);
  expect(region).toBeVisible();
});

it("a new Solo chat finishing behind Settings stays put and retires its draft", async () => {
  const f = fixture({ behindSettings: true, target: soloDraftTarget });
  writeView(f.scope, "solo:new-draft", {
    text: "@Scout Started behind Settings",
    recipients: [{ pubkey: agent, name: "Scout", start: 0, end: 6 }],
  });
  f.mount();
  // Stands in for a field in the Settings modal that owns focus.
  const settingsField = document.createElement("input");
  document.body.append(settingsField);
  const region = await screen.findByRole("region", { name: "New chat" });
  try {
    // The start runs while Settings owns focus.
    settingsField.focus();
    fireEvent.click(
      within(region).getByRole("button", { name: "Send message" }),
    );
    await waitFor(() =>
      expect(f.session.channelWrites.create).toHaveBeenCalledOnce(),
    );
    expect(f.open).not.toHaveBeenCalled();
    // A fresh draft replaces the submitted one, so it cannot start again.
    const composer = () =>
      within(screen.getByRole("region", { name: "New chat" })).getByRole(
        "textbox",
        { name: "Message your agents" },
      );
    await waitFor(() =>
      expect(composer()).not.toHaveTextContent("Started behind Settings"),
    );
    // The replacement never pulls focus out of Settings.
    expect(settingsField).toHaveFocus();
    expect(f.open).not.toHaveBeenCalled();
  } finally {
    settingsField.remove();
  }
});

it("sends the owner's Solo chat to its only agent without a tag, and gives it its project", async () => {
  const f = fixture();
  f.mount();
  const input = await screen.findByRole("textbox", {
    name: "Message your agents",
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Add workspace" })).toBeEnabled(),
  );
  const user = userEvent.setup();
  await user.click(input);
  await user.keyboard("Untagged{Enter}");
  // The chat's only agent is already in the pill, so no tag is needed.
  await waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
  expect(f.send.mock.calls[0]?.[2]).toEqual([agent]);
  expect(
    screen.queryByText("Choose an agent to send", { selector: "[role=alert]" }),
  ).toBeNull();
});

it("sends a guest alone with agents to the chat's only agent, who can still file the chat", async () => {
  const f = fixture({ placed: false });
  f.mount();
  const input = await screen.findByRole("textbox", {
    name: "Message your agents",
  });
  // A shared chat is the guest's to file in their own workspaces.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Add workspace" })).toBeEnabled(),
  );
  const user = userEvent.setup();
  await user.click(input);
  await user.keyboard("Hello team{Enter}");
  // The chat's only agent is already in the pill, so no tag is needed.
  await waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
  expect(f.send.mock.calls[0]?.[2]).toEqual([agent]);
  expect(
    screen.queryByText("Choose an agent to send", { selector: "[role=alert]" }),
  ).toBeNull();
});

it.each([
  ["owner", true],
  ["guest", false],
] as const)(
  "lets the %s talk without a tag once another person is in the chat",
  async (_, placed) => {
    const f = fixture({ placed, people: ["c".repeat(64)] });
    f.mount();
    const input = await screen.findByRole("textbox", {
      name: "Message this conversation",
    });
    const user = userEvent.setup();
    await user.click(input);
    await user.keyboard("Hello team{Enter}");
    await waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Tag a person or agent to send")).toBeNull();
  },
);

it.each([
  ["a person", false],
  ["a person and an agent", true],
] as const)(
  "with queued follow-ups, the owner's send to %s goes out now",
  async (_, withAgent) => {
    localStorage.setItem("buzz-follow-up-behavior.v1", "queue");
    try {
      const person = "c".repeat(64);
      const f = fixture({ people: [person] });
      const text = withAgent ? "@Teammate @Scout hi" : "@Teammate hi";
      writeView(f.scope, `draft:${id}`, {
        text,
        recipients: [
          { pubkey: person, name: "Teammate", start: 0, end: 9 },
          ...(withAgent
            ? [{ pubkey: agent, name: "Scout", start: 10, end: 16 }]
            : []),
        ],
      });
      f.mount();
      const input = await screen.findByRole("textbox", {
        name: "Message this conversation",
      });
      const user = userEvent.setup();
      await user.click(input);
      await user.keyboard("{Enter}");
      await waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
      expect(f.send.mock.calls[0]?.[2]).toEqual(
        withAgent ? [person, agent] : [person],
      );
      expect(
        screen.queryByText(/no longer available/, { selector: "[role=alert]" }),
      ).toBeNull();
    } finally {
      localStorage.removeItem("buzz-follow-up-behavior.v1");
    }
  },
);

it("keeps the tag requirement while a member's profile has not loaded", async () => {
  const f = fixture({ people: ["c".repeat(64)], unloaded: true });
  f.mount();
  const input = await screen.findByRole("textbox", {
    name: "Message your agents",
  });
  const user = userEvent.setup();
  await user.click(input);
  await user.keyboard("Hello team{Enter}");
  expect(
    await screen.findByText("Tag a person or agent to send", {
      selector: "[role=alert]",
    }),
  ).toBeVisible();
  expect(f.send).not.toHaveBeenCalled();
});

it("refuses an untagged send once the fresh roster has no other person", async () => {
  const f = fixture({ people: ["c".repeat(64)], departed: true });
  f.mount();
  const input = await screen.findByRole("textbox", {
    name: "Message this conversation",
  });
  const user = userEvent.setup();
  await user.click(input);
  await user.keyboard("Hello team{Enter}");
  expect(await screen.findByText("Tag an agent to send.")).toBeVisible();
  expect(f.send).not.toHaveBeenCalled();
});

it.each([
  ["archive", "Archive chat", undefined],
  ["delete", "Delete chat", "Delete Planning?"],
] as const)(
  "runs %s from Chat actions, then opens a new Solo draft",
  async (action, label, title) => {
    const f = fixture();
    f.mount();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Chat actions" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: label }));
    // Archive is undoable from its result toast, so only Delete confirms.
    if (title) {
      const dialog = screen.getByRole("dialog", { name: title });
      await user.click(within(dialog).getByRole("button", { name: label }));
    }
    await waitFor(() => expect(f.run).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(f.run).toHaveBeenCalledExactlyOnceWith(
      action,
      id,
      expect.any(AbortSignal),
    );
    expect(f.open).toHaveBeenCalledExactlyOnceWith(soloDraftTarget(f.scope));
  },
);

it.each([
  ["open", true],
  ["another", false],
] as const)(
  "archives the %s chat from its sidebar row; only leaving the open chat opens a new Solo draft",
  async (_, open) => {
    const f = fixture(
      open ? {} : { target: (scope) => soloDraftTarget(scope) },
    );
    f.mountWithSidebar();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Actions for Planning" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Archive chat" }),
    );
    await waitFor(() => expect(f.run).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(f.run).toHaveBeenCalledExactlyOnceWith(
      "archive",
      id,
      expect.any(AbortSignal),
    );
    if (open)
      expect(f.open).toHaveBeenCalledExactlyOnceWith(soloDraftTarget(f.scope));
    else expect(f.open).not.toHaveBeenCalled();
  },
);

it.each([
  ["Chat actions", "archive", "Archive chat", undefined],
  ["Chat actions", "delete", "Delete chat", "Delete Planning?"],
  ["Actions for Planning", "archive", "Archive chat", undefined],
] as const)(
  "from %s, %s leaves the open chat for its sidebar neighbor",
  async (trigger, action, label, title) => {
    const other = "22222222-2222-4222-8222-222222222222";
    const f = fixture({ others: [other] });
    f.mountWithSidebar();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: trigger }));
    await user.click(await screen.findByRole("menuitem", { name: label }));
    // Archive is undoable from its result toast, so only Delete confirms.
    if (title) {
      const dialog = await screen.findByRole("dialog", { name: title });
      await user.click(within(dialog).getByRole("button", { name: label }));
    }
    await waitFor(() => expect(f.open).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(f.run).toHaveBeenCalledExactlyOnceWith(
      action,
      id,
      expect.any(AbortSignal),
    );
    expect(f.open).toHaveBeenCalledExactlyOnceWith(
      conversationTarget(f.scope, other),
    );
  },
);

it.each(["Chat actions", "Actions for Planning"])(
  "keeps a submitted delete alive from %s and reports failure with its chat name",
  async (trigger) => {
    const other = "22222222-2222-4222-8222-222222222222";
    const f = fixture({ others: [other] });
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    f.run.mockImplementationOnce(() => pending);
    f.mountWithSidebar(true);
    const user = userEvent.setup();
    try {
      await user.click(await screen.findByRole("button", { name: trigger }));
      await user.click(
        await screen.findByRole("menuitem", { name: "Delete chat" }),
      );
      const confirm = await screen.findByRole("button", {
        name: "Delete chat",
      });
      fireEvent.click(confirm);
      fireEvent.click(confirm);
      await waitFor(() => expect(f.run).toHaveBeenCalledOnce());
      expect(f.open).toHaveBeenCalledExactlyOnceWith(
        conversationTarget(f.scope, other),
      );
      const signal = f.run.mock.calls[0]?.[2];
      expect(signal?.aborted).toBe(false);
      expect(
        f.session.channels.list().channels.some((chat) => chat.id === id),
      ).toBe(true);
      await act(async () => reject(new Error("Deletion refused")));
      const failure = await screen.findByRole("dialog", {
        name: "Delete chat failed",
      });
      expect(failure).toHaveTextContent("Planning: Deletion refused");
      expect(
        f.session.channels.list().channels.some((chat) => chat.id === id),
      ).toBe(true);
      expect(f.open).toHaveBeenCalledOnce();
    } finally {
      await act(async () => reject(new Error("Test finished")));
    }
  },
);

it.each([
  ["Chat actions", "Cancel"],
  ["Chat actions", "Retry"],
  ["Actions for Planning", "Cancel"],
  ["Actions for Planning", "Retry"],
] as const)(
  "keeps a paused Solo delete recoverable after departure from %s (%s)",
  async (trigger, choice) => {
    const other = "22222222-2222-4222-8222-222222222222";
    const f = fixture({ others: [other] });
    f.run.mockRejectedValueOnce(new ApiPaused(0));
    // A real route change aborts the old visit before the paused result arrives.
    f.open.mockImplementation(async (target) => {
      f.show(target);
      f.abort.abort();
      return { status: "opened" as const };
    });
    f.mountWithSidebar(true);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: trigger }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Delete chat" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Delete chat" }),
    );
    const retry = await screen.findByRole("button", { name: "Retry" });
    const confirmation = screen.getByRole("dialog", {
      name: "Delete Planning?",
    });
    expect(confirmation).toHaveTextContent("nothing was deleted");
    expect(f.open).toHaveBeenCalledExactlyOnceWith(
      conversationTarget(f.scope, other),
    );
    expect(
      f.session.channels.list().channels.some((chat) => chat.id === id),
    ).toBe(true);
    expect(f.run).toHaveBeenCalledOnce();
    await user.click(
      choice === "Retry"
        ? retry
        : within(confirmation).getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() => expect(confirmation).not.toBeInTheDocument());
    if (choice === "Retry") {
      await screen.findByRole("dialog", { name: "Chat deleted: Planning" });
      expect(f.run).toHaveBeenCalledTimes(2);
      expect(
        f.session.channels.list().channels.some((chat) => chat.id === id),
      ).toBe(false);
    } else {
      expect(f.run).toHaveBeenCalledOnce();
      expect(
        f.session.channels.list().channels.some((chat) => chat.id === id),
      ).toBe(true);
    }
    expect(f.open).toHaveBeenCalledOnce();
  },
);

it.each([
  ["Chat actions", true],
  ["Chat actions", false],
  ["Actions for Planning", true],
  ["Actions for Planning", false],
] as const)(
  "retires a reopened deleted chat from %s, preserving other destinations (%s)",
  async (trigger, reopened) => {
    const other = "22222222-2222-4222-8222-222222222222";
    const last = "33333333-3333-4333-8333-333333333333";
    const f = fixture({ others: [other, last] });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = f.run.getMockImplementation();
    if (!run) throw new Error("Missing lifecycle fixture implementation");
    f.run.mockImplementationOnce(async (...args) => {
      await pending;
      await run(...args);
    });
    f.mountWithSidebar(true);
    const user = userEvent.setup();
    try {
      await user.click(await screen.findByRole("button", { name: trigger }));
      await user.click(
        await screen.findByRole("menuitem", { name: "Delete chat" }),
      );
      await user.click(
        await screen.findByRole("button", { name: "Delete chat" }),
      );
      await waitFor(() => expect(f.run).toHaveBeenCalledOnce());
      expect(f.open).toHaveBeenCalledExactlyOnceWith(
        conversationTarget(f.scope, other),
      );
      act(() => {
        f.abort.abort();
        f.show(conversationTarget(f.scope, reopened ? id : last));
      });
      await act(async () => {
        release();
      });
      await screen.findByRole("dialog", { name: "Chat deleted: Planning" });
      expect(f.open).toHaveBeenCalledTimes(reopened ? 2 : 1);
      expect(f.open).toHaveBeenLastCalledWith(
        conversationTarget(f.scope, other),
      );
    } finally {
      await act(async () => {
        release();
      });
    }
  },
);

it.each([
  ["Chat actions", "confirmation"],
  ["Chat actions", "pending"],
  ["Chat actions", "all-hidden"],
  ["Actions for Planning", "confirmation"],
  ["Actions for Planning", "pending"],
  ["Actions for Planning", "all-hidden"],
] as const)(
  "chooses visible successors from %s on delete submission (%s)",
  async (trigger, phase) => {
    const other = "22222222-2222-4222-8222-222222222222";
    const last = "33333333-3333-4333-8333-333333333333";
    const f = fixture({
      others: [other, last],
      sidebarRows: [
        {
          version: 1,
          id: "hide",
          key: "fixture.rows/hide",
          pluginId: "fixture.rows",
          revision: "one",
          render: (row, Default) =>
            row.channel.lastActivityAt === 1 ? null : Default,
        },
      ],
    });
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = f.run.getMockImplementation();
    if (!run) throw new Error("Missing lifecycle fixture implementation");
    f.run.mockImplementationOnce(async (...args) => {
      await pending;
      await run(...args);
    });
    f.mountWithSidebar();
    const user = userEvent.setup();
    try {
      await user.click(await screen.findByRole("button", { name: trigger }));
      await user.click(
        await screen.findByRole("menuitem", { name: "Delete chat" }),
      );
      const dialog = await screen.findByRole("dialog", {
        name: "Delete Planning?",
      });
      if (phase === "confirmation")
        act(() => f.updateChat(other, { lastActivityAt: 1 }));
      await user.click(
        within(dialog).getByRole("button", { name: "Delete chat" }),
      );
      await waitFor(() => expect(f.run).toHaveBeenCalledOnce());
      const successor = conversationTarget(
        f.scope,
        phase === "confirmation" ? last : other,
      );
      expect(f.open).toHaveBeenCalledExactlyOnceWith(successor);
      if (phase !== "confirmation")
        act(() => {
          f.updateChat(other, { lastActivityAt: 1 });
          if (phase === "all-hidden") f.updateChat(last, { lastActivityAt: 1 });
        });
      expect(screen.queryByRole("button", { name: "Other 1" })).toBeNull();
      await act(async () => {
        release();
      });
      // Completion must not navigate again, even if sidebar visibility changed.
      expect(f.open).toHaveBeenCalledExactlyOnceWith(successor);
    } finally {
      release();
    }
  },
);

it("offers the header's chat actions from the sidebar row, plus inline Rename", async () => {
  const f = fixture();
  f.mountWithSidebar();
  const user = userEvent.setup();
  const items = async (trigger: string) => {
    await user.click(await screen.findByRole("button", { name: trigger }));
    const menu = await screen.findByRole("menu", { name: trigger });
    await within(menu).findByRole("menuitem", { name: "Delete chat" });
    const names = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    return names;
  };
  const header = await items("Chat actions");
  expect(header).toEqual([
    "Chat settings",
    "Move to",
    "Share access",
    "Copy link",
    "Convert to channel",
    "Archive chat",
    "Delete chat",
  ]);
  expect(await items("Actions for Planning")).toEqual(["Rename", ...header]);
});

it("runs the header's own chat actions and returns focus to Chat actions", async () => {
  const f = fixture();
  const assign = vi.fn(async () => {});
  Object.assign(f.session.soloPreferences, { writable: true, assign });
  f.mount();
  const user = userEvent.setup();
  const trigger = await screen.findByRole("button", { name: "Chat actions" });
  await user.click(trigger);
  (await screen.findByRole("menuitem", { name: "Move to" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(await screen.findByRole("menuitem", { name: "Work" }));
  expect(assign).toHaveBeenCalledExactlyOnceWith(id, "work");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "Chat settings" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Edit chat" });
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(trigger).toHaveFocus());
});

it("reports a failed header move beside the header and retries it", async () => {
  const f = fixture();
  const base = f.session.soloPreferences.snapshot();
  let current: ReturnType<typeof f.session.soloPreferences.snapshot> = base;
  const listeners = new Set<() => void>();
  const publish = (next: typeof current) => {
    current = next;
    for (const listener of listeners) listener();
  };
  const failed = {
    ...base,
    moves: [
      {
        id: 1,
        channelId: id,
        destination: { section: "work" },
        pending: false,
        error: "Relay unavailable",
      },
    ],
  } as unknown as typeof current;
  const retryMove = vi.fn(async () => {});
  Object.assign(f.session.soloPreferences, {
    writable: true,
    snapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    assign: vi.fn(async () => {
      publish(failed);
      throw new Error("Relay unavailable");
    }),
    retryMove,
    dismissMoveError: () => publish(base),
  });
  f.mountWithToasts();
  const user = userEvent.setup();
  // No failure is shown for a move this header did not start.
  act(() => publish(failed));
  expect(screen.queryByText("Chat wasn’t moved")).toBeNull();
  act(() => publish(base));
  await user.click(await screen.findByRole("button", { name: "Chat actions" }));
  (await screen.findByRole("menuitem", { name: "Move to" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(await screen.findByRole("menuitem", { name: "Work" }));
  expect(await screen.findByText("Chat wasn’t moved")).toBeVisible();
  // Toasts own swipe gestures, so press their buttons without a pointer.
  fireEvent.click(screen.getByRole("button", { name: "Retry move" }));
  expect(retryMove).toHaveBeenCalledExactlyOnceWith(id);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
  await waitFor(() =>
    expect(screen.queryByText("Chat wasn’t moved")).toBeNull(),
  );
});

it("returns focus to Chat actions when its confirmation is cancelled", async () => {
  const f = fixture();
  f.mount();
  const user = userEvent.setup();
  const trigger = await screen.findByRole("button", { name: "Chat actions" });
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete chat" }),
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(trigger).toHaveFocus();
  expect(f.run).not.toHaveBeenCalled();
  expect(f.open).not.toHaveBeenCalled();
});

it("keeps Chat settings in the chat actions menu, not as a separate heading button", async () => {
  const f = fixture();
  f.mount();
  await screen.findByRole("button", { name: "Chat actions" });
  expect(screen.queryByRole("button", { name: "Chat settings" })).toBeNull();
});

it("names the owner on the access controls of someone else's shared chat", async () => {
  const person = "e".repeat(64);
  const f = fixture({ placed: false, ownedBy: person, people: [person] });
  f.mountWithSidebar();
  const user = userEvent.setup();
  // The header names the owner; the sidebar mark retains the owner avatar.
  const header = await screen.findByRole("button", {
    name: "Share access to Planning, Teammate’s chat",
  });
  expect(header).toHaveTextContent("Planning");
  expect(header).toHaveAttribute("title", "Teammate’s chat");
  const mark = screen.getByRole("button", { name: "Teammate’s chat" });
  expect(mark).toHaveTextContent("T");
  await user.click(mark);
  expect(
    await screen.findByRole("dialog", { name: /Share access/ }),
  ).toBeInTheDocument();
  // Closing returns focus to the mark, not the row's select button.
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(mark).toHaveFocus();
});

it.each([
  ["the viewer's own chat", { people: ["e".repeat(64)], viewerNamed: true }],
  [
    "a chat whose owner's profile has not loaded",
    {
      placed: false,
      ownedBy: "e".repeat(64),
      people: ["e".repeat(64)],
      unloaded: true,
    },
  ],
])("names no owner on %s", async (_, options) => {
  fixture(options).mountWithSidebar();
  expect(
    await screen.findByRole("button", { name: "Share access to Planning" }),
  ).toBeInTheDocument();
  expect(screen.queryByText(/’s chat/)).toBeNull();
});

it("marks an archived chat once and keeps only its lifecycle actions", async () => {
  fixture({ archived: true }).mount();
  await screen.findByRole("button", { name: "Chat actions" });
  expect(screen.getAllByText("Archived")).toHaveLength(1);
  expect(
    screen.queryByRole("button", { name: "Share access to Planning" }),
  ).toBeNull();
  expect(
    await screen.findByRole("region", { name: "Archived chat" }),
  ).toHaveTextContent("This chat is archived");
  expect(screen.queryByRole("textbox")).toBeNull();
  // Solo chats keep their header mark; the channel banner is not repeated.
  expect(
    screen.queryByRole("region", { name: "Archived · view only" }),
  ).toBeNull();
});

it.each([
  { preview: { joinRole: "guest" as const }, joinable: true },
  { preview: { joinRole: "member" as const }, joinable: false },
  { preview: {}, joinable: false },
])(
  "offers Solo preview Join only for Guest admission ($preview)",
  async ({ preview, joinable }) => {
    fixture({ placed: false, preview }).mount();
    expect(
      await screen.findByRole("region", {
        name:
          "joinRole" in preview && preview.joinRole === "guest"
            ? "Read-only chat"
            : "Chat preview",
      }),
    ).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(!!screen.queryByRole("button", { name: "Join" })).toBe(joinable);
  },
);

it("lets a joined Solo viewer cancel Leave and restores focus to Chat actions", async () => {
  const f = fixture({ placed: false, viewOnly: true });
  f.mountWithSidebar();
  const row = await screen.findByRole("button", { name: /^Planning/ });
  expect(row).toBeVisible();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
  const user = userEvent.setup();
  const actions = screen.getByRole("button", { name: "Chat actions" });
  await user.click(actions);
  const leave = await screen.findByRole("menuitem", { name: "Leave chat" });
  expect(screen.queryByRole("menuitem", { name: "Archive chat" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Delete chat" })).toBeNull();
  await user.click(leave);
  const dialog = await screen.findByRole("dialog", {
    name: "Leave chat: Planning",
  });
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus(),
  );
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(actions).toHaveFocus());
  expect(f.run).not.toHaveBeenCalled();
});

it.each(["solo", "stream"] as const)(
  "replaces an archived %s composer with a notice and restores its draft on unarchive",
  async (type) => {
    const f = fixture({ type });
    const place = type === "solo" ? "chat" : "channel";
    f.mount();
    const editor = await screen.findByRole("textbox");
    expect(editor).toHaveFocus();
    const user = userEvent.setup();
    await user.click(editor);
    await user.keyboard("Keep this draft");
    await act(() => f.run("archive"));
    expect(
      await screen.findByRole("region", { name: `Archived ${place}` }),
    ).toHaveTextContent(`This ${place} is archived`);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
    // Remote unarchive restores composition without taking the reader's focus.
    const history = screen.getByRole("region", {
      name: "Channel message history",
    });
    history.focus();
    expect(history).toHaveFocus();
    act(() => f.setArchived(false));
    expect(await screen.findByRole("textbox")).toHaveTextContent(
      "Keep this draft",
    );
    expect(
      screen.queryByRole("region", { name: `Archived ${place}` }),
    ).toBeNull();
    expect(history).toHaveFocus();
    expect(f.send).not.toHaveBeenCalled();
  },
);

it("does not recreate a consumed linked draft on history navigation", () => {
  const linked = "22222222-2222-4222-8222-222222222222";
  const f = fixture({ target: (scope) => soloDraftTarget(scope, { linked }) });
  f.mount();
  expect(
    screen.getByText(
      "This linked chat draft is unavailable. Start again from its source.",
    ),
  ).toBeVisible();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(readView(f.scope, linkedDraftKey(linked), null)).toBeNull();
});

it("finishes a linked chat across roster updates without appending source prose", async () => {
  const linked = "22222222-2222-4222-8222-222222222222";
  const f = fixture({ target: (scope) => soloDraftTarget(scope, { linked }) });
  const source = {
    channelId: "33333333-3333-4333-8333-333333333333",
    link: `buzz://message?channel=33333333-3333-4333-8333-333333333333&id=${"e".repeat(64)}`,
  };
  writeView(f.scope, linkedDraftKey(linked), source);
  f.mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("textbox"));
  await user.keyboard("Investigate this");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(f.open).toHaveBeenCalledOnce());
  expect(screen.queryByText("Draft unavailable")).toBeNull();
  expect(f.send.mock.calls[0]?.[1]).not.toContain("Source:");
  expect(f.session.channelWrites.start).toHaveBeenCalledOnce();
  expect(f.send.mock.calls[0]?.[1]).toContain(source.link);
});

it("marks the open conversation read from Escape while it shows unread", async () => {
  const f = fixture({ unread: 3 });
  f.mount();
  await waitFor(() => expect(f.read.current?.available()).toBe(true));
  await act(async () => f.read.current?.run());
  expect(f.markRead).toHaveBeenCalledExactlyOnceWith(id);
});

it("offers no Escape mark-read for a read chat, without read sync, or after the visit", async () => {
  const read = fixture();
  read.mount();
  await waitFor(() => expect(read.read.current).toBeDefined());
  expect(read.read.current?.available()).toBe(false);
  cleanup();
  const unsynced = fixture({ unread: 2, capability: "read-only" });
  unsynced.mount();
  await waitFor(() => expect(unsynced.read.current).toBeDefined());
  expect(unsynced.read.current?.available()).toBe(false);
  cleanup();
  const visit = fixture({ unread: 2 });
  visit.mount();
  await waitFor(() => expect(visit.read.current?.available()).toBe(true));
  visit.abort.abort();
  expect(visit.read.current?.available()).toBe(false);
});

it("offers no Escape mark-read for a read-only preview or the new message page", async () => {
  const f = fixture({
    unread: 2,
    target: (scope) => ({
      version: 1,
      kind: "page",
      pluginId: "buzz.channels",
      pageId: "channels",
      scope: splitPartition(scope) as never,
      route: { version: 1, params: "new-message" },
    }),
  });
  f.mount();
  await screen.findByRole("textbox", { name: /message/i }).catch(() => {});
  expect(f.read.current).toBeUndefined();
});

it("reports a failed Escape mark-read in a toast and keeps the chat open", async () => {
  const f = fixture({ unread: 1 });
  f.markRead.mockRejectedValueOnce(new Error("offline"));
  f.mountWithToasts();
  await waitFor(() => expect(f.read.current?.available()).toBe(true));
  await act(async () => f.read.current?.run());
  expect(await screen.findByText("Couldn’t mark as read.")).toBeInTheDocument();
});

it("leaves Escape to a text field outside the composer", async () => {
  const f = fixture({ unread: 1 });
  f.mount();
  await waitFor(() => expect(f.read.current?.available()).toBe(true));
  const field = document.createElement("input");
  document.body.append(field);
  field.focus();
  expect(f.read.current?.available()).toBe(false);
  field.remove();
});

const noLongerMember = /^You’re no longer a member of/;

/** Fails the test on any render of the lost-membership notice, however brief. */
function watchForLossNotice() {
  const seen = vi.fn();
  const observer = new MutationObserver(() => {
    if (screen.queryByText(noLongerMember)) seen();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return {
    seen,
    stop: () => observer.disconnect(),
  };
}

it("names an archived channel above its history, and its owner unarchives it there", async () => {
  const f = fixture({ type: "stream", archived: true, emptyHistory: true });
  f.mountWithToasts();
  const banner = await screen.findByRole("region", {
    name: "Archived · view only",
  });
  expect(banner).toHaveTextContent(
    "It’s hidden from the sidebar until it’s unarchived.",
  );
  // The pane's persistent status announces it; the notice is not another one.
  expect(banner.parentElement).toHaveAttribute("role", "status");
  expect(banner).not.toHaveAttribute("role");
  expect(banner).not.toHaveAttribute("aria-live");
  const history = screen.getByRole("region", {
    name: "Channel message history",
  });
  expect(
    banner.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  // The lower notice still says what archiving does to writing.
  expect(
    screen.getByRole("region", { name: "Archived channel" }),
  ).toHaveTextContent("This channel is archived");
  expect(await screen.findByText("No messages yet.")).toBeVisible();
  expect(screen.queryByText("Start the conversation below.")).toBeNull();
  const user = userEvent.setup();
  await user.click(within(banner).getByRole("button", { name: "Unarchive" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Unarchive channel: Planning",
  });
  expect(f.run).not.toHaveBeenCalled();
  await user.click(
    within(dialog).getByRole("button", { name: "Unarchive channel" }),
  );
  expect(f.run).toHaveBeenCalledExactlyOnceWith(
    "unarchive",
    id,
    expect.any(AbortSignal),
  );
  // Restoring removes the trigger; the restored composer takes focus.
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Message Planning" }),
    ).toHaveFocus(),
  );
  expect(
    screen.queryByRole("region", { name: "Archived · view only" }),
  ).toBeNull();
  expect(screen.getByText("Start the conversation below.")).toBeVisible();
});

it("returns focus to Unarchive when its confirmation is cancelled", async () => {
  fixture({ type: "stream", archived: true }).mountWithToasts();
  const unarchive = await screen.findByRole("button", { name: "Unarchive" });
  const user = userEvent.setup();
  await user.click(unarchive);
  const dialog = await screen.findByRole("dialog", {
    name: "Unarchive channel: Planning",
  });
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(unarchive).toHaveFocus());
});

it("offers no Unarchive to a member of an archived channel", async () => {
  fixture({ type: "stream", archived: true, member: true }).mount();
  const banner = await screen.findByRole("region", {
    name: "Archived · view only",
  });
  expect(within(banner).queryByRole("button")).toBeNull();
});

it("says nothing about the sidebar to a preview reader of an archived channel", async () => {
  fixture({ type: "stream", archived: true, preview: {} }).mount();
  const banner = await screen.findByRole("region", {
    name: "Archived · view only",
  });
  // It was never in their sidebar.
  expect(banner).toHaveTextContent(/^Archived · view only$/);
});

it.each(["private", "public"] as const)(
  "explains lost membership of the open %s channel and leads back to channels",
  async (visibility) => {
    const f = fixture({ type: "stream" });
    f.mountWithToasts();
    await screen.findByRole("textbox", { name: "Message Planning" });
    writeView(f.scope, "selected-channel", id);
    const live = new Set(document.querySelectorAll('[role="status"]'));
    act(() => f.remove(visibility));
    const banner = await screen.findByRole("region", {
      // Named as the channel was shown while joined.
      name: "You’re no longer a member of Planning",
    });
    // It appears in a status that was already mounted, so it is announced.
    expect(live.has(banner.parentElement as Element)).toBe(true);
    expect(banner.parentElement).toHaveAttribute("role", "status");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText("Select a channel to read it.")).toBeNull();
    if (visibility === "public") {
      // The preview's lower notice still offers Join, below the history.
      const join = await screen.findByRole("region", {
        name: "Channel preview",
      });
      expect(join).toHaveTextContent("Join channel to send messages");
      expect(
        banner.compareDocumentPosition(join) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    } else
      expect(
        screen.queryByRole("region", { name: "Channel preview" }),
      ).toBeNull();
    await userEvent
      .setup()
      .click(within(banner).getByRole("button", { name: "Back to channels" }));
    // Without a sidebar to choose a neighbor, it lands where Leave does.
    expect(f.open).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      kind: "page",
      pluginId: "buzz.channels",
      pageId: "channels",
      route: { version: 1, params: "empty" },
    });
    expect(readView(f.scope, "selected-channel", null)).toBeNull();
  },
);

it("explains lost membership of an already-archived channel opened from Search", async () => {
  // Out of the sidebar, so its membership comes from the roster itself.
  const f = fixture({ type: "stream", archived: true });
  f.mountWithToasts();
  await screen.findByRole("region", { name: "Archived · view only" });
  act(() => f.remove("private"));
  const banner = await screen.findByRole("region", {
    name: "You’re no longer a member of Planning",
  });
  expect(
    within(banner).getByRole("button", { name: "Back to channels" }),
  ).toBeVisible();
  expect(screen.queryByText("Select a channel to read it.")).toBeNull();
});

// What lost membership unmounts with the channel.
const focusOrigins = {
  composer: () => screen.getByRole("textbox", { name: "Message Planning" }),
  "header's Channel actions": () =>
    screen.getByRole("button", { name: "Channel actions" }),
  "history scroller": () =>
    screen.getByRole("region", { name: "Channel message history" }),
};
it.each(
  (Object.keys(focusOrigins) as (keyof typeof focusOrigins)[]).flatMap(
    (origin) => [
      [origin, "private", "Back to channels"] as const,
      [origin, "refused", "Back to channels"] as const,
      [origin, "public", "the history"] as const,
    ],
  ),
)(
  "moves focus from the %s of a lost %s channel to %s",
  async (origin, visibility, _target) => {
    const f = fixture({ type: "stream" });
    f.mountWithToasts();
    await screen.findByRole("textbox", { name: "Message Planning" });
    const focused = focusOrigins[origin]();
    act(() => focused.focus());
    expect(focused).toHaveFocus();
    act(() => f.remove(visibility));
    const banner = await screen.findByRole("region", {
      name: "You’re no longer a member of Planning",
    });
    const history = screen.getByRole("region", { name: "Channel history" });
    if (visibility !== "public")
      await waitFor(() =>
        expect(
          within(banner).getByRole("button", { name: "Back to channels" }),
        ).toHaveFocus(),
      );
    else {
      await screen.findByRole("region", { name: "Channel preview" });
      await waitFor(() =>
        expect(history.contains(document.activeElement)).toBe(true),
      );
    }
    expect(document.activeElement).not.toBe(document.body);
  },
);

it("leaves focus that moved on before the lost membership notice shows", async () => {
  const f = fixture({ type: "stream" });
  f.mountWithToasts();
  const composer = await screen.findByRole("textbox", {
    name: "Message Planning",
  });
  const field = document.createElement("input");
  document.body.append(field);
  try {
    act(() => composer.focus());
    act(() => f.remove("private"));
    // Elsewhere, while the access check is still pending.
    act(() => field.focus());
    await screen.findByRole("region", {
      name: "You’re no longer a member of Planning",
    });
    expect(field).toHaveFocus();
  } finally {
    field.remove();
  }
});

it("leaves focus that left the conversation before it lost membership", async () => {
  const f = fixture({ type: "stream" });
  f.mountWithToasts();
  await screen.findByRole("textbox", { name: "Message Planning" });
  // Say, its sidebar row, which goes with the channel.
  const elsewhere = document.createElement("button");
  document.body.append(elsewhere);
  try {
    act(() => screen.getByRole("button", { name: "Channel actions" }).focus());
    act(() => elsewhere.focus());
    act(() => {
      elsewhere.remove();
      f.remove("private");
    });
    await screen.findByRole("region", {
      name: "You’re no longer a member of Planning",
    });
    await f.accessSettled();
    expect(document.activeElement).toBe(document.body);
  } finally {
    elsewhere.remove();
  }
});

/** Focus outside the conversation, for `run`; then it goes. */
async function withFocusElsewhere(run: (elsewhere: HTMLElement) => unknown) {
  const elsewhere = document.createElement("button");
  document.body.append(elsewhere);
  try {
    await run(elsewhere);
  } finally {
    elsewhere.remove();
  }
}

/** Loses a public channel with focus elsewhere, then joins it again from
 * its preview; the composer takes focus. */
const joinFromItsPreview = async (f: ReturnType<typeof fixture>) => {
  await screen.findByRole("textbox", { name: "Message Planning" });
  // Elsewhere, so this first loss takes no focus from the pane.
  await withFocusElsewhere(async (elsewhere) => {
    act(() => elsewhere.focus());
    act(() => f.remove("public"));
    await screen.findByRole("region", { name: "Channel preview" });
    await f.accessSettled();
  });
  f.run.mockImplementationOnce(async () => f.rejoin());
  await userEvent
    .setup()
    .click(
      within(screen.getByRole("region", { name: "Channel preview" })).getByRole(
        "button",
        { name: "Join" },
      ),
    );
  // Join hands focus to the composer once membership makes it writable.
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Message Planning" }),
    ).toHaveFocus(),
  );
};

it.each([
  ["joined from its preview", joinFromItsPreview],
  [
    "rejoined after the viewer's unconfirmed Leave took effect",
    async (f: ReturnType<typeof fixture>) => {
      await failLeave(f);
      await withFocusElsewhere(async (elsewhere) => {
        act(() => elsewhere.focus());
        act(() => f.remove("public"));
        await screen.findByRole("region", { name: "Channel preview" });
        await f.accessSettled();
      });
      act(() => f.rejoin());
      const composer = await screen.findByRole("textbox", {
        name: "Message Planning",
      });
      act(() => composer.focus());
    },
  ],
] as const)(
  "moves focus from the composer into the history when a public channel this visit previewed, %s, is lost",
  async (_, joinFromPreview) => {
    const f = fixture({ type: "stream", canLeave: true });
    f.mountWithToasts();
    await joinFromPreview(f);
    const header = screen.getByRole("button", { name: "Channel actions" });
    // The visit already resolved the preview: the header and history stay,
    // and only the composer goes.
    act(() => f.remove("public"));
    await screen.findByRole("region", {
      name: "You’re no longer a member of Planning",
    });
    expect(header).toBeInTheDocument();
    const history = screen.getByRole("region", { name: "Channel history" });
    await waitFor(() =>
      expect(history.contains(document.activeElement)).toBe(true),
    );
  },
);

it("moves focus into the history when a public channel joined from its preview is lost while that preview reloads", async () => {
  const f = fixture({ type: "stream", canLeave: true });
  f.mountWithToasts();
  await joinFromItsPreview(f);
  await userEvent.setup().keyboard("Hello");
  // The preview is gone until access is checked again: the notice shows
  // first with Back to channels, then the preview's history returns.
  act(() => f.remove("public", true));
  await screen.findByRole("region", {
    name: "You’re no longer a member of Planning",
  });
  await f.accessSettled();
  await screen.findByRole("region", { name: "Channel preview" });
  const history = screen.getByRole("region", { name: "Channel history" });
  await waitFor(() =>
    expect(history.contains(document.activeElement)).toBe(true),
  );
});

it.each([
  [
    "the viewer's own unconfirmed Leave",
    async (f: ReturnType<typeof fixture>) => {
      await failLeave(f);
      act(() =>
        screen.getByRole("button", { name: "Channel actions" }).focus(),
      );
      act(() => f.remove("public"));
      await screen.findByRole("region", { name: "Channel preview" });
    },
  ],
  [
    "a partial roster read",
    async (f: ReturnType<typeof fixture>) => {
      await screen.findByRole("textbox", { name: "Message Planning" });
      act(() =>
        screen.getByRole("button", { name: "Channel actions" }).focus(),
      );
      act(() => f.degrade({ coverage: "partial" }));
      await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    },
  ],
] as const)(
  "forgets the focus a loss explained by %s took, once the channel is back",
  async (_, firstLoss) => {
    const f = fixture({ type: "stream", canLeave: true });
    f.mountWithToasts();
    // The header goes with the channel: the history pane takes its focus,
    // and no notice comes to place it.
    await firstLoss(f);
    await f.accessSettled();
    expect(screen.queryByText(noLongerMember)).toBeNull();
    act(() => f.rejoin());
    act(() => f.reread());
    await screen.findByRole("textbox", { name: "Message Planning" });
    // A later loss, with focus outside the pane, owes it nothing.
    await withFocusElsewhere(async (elsewhere) => {
      act(() => elsewhere.focus());
      act(() => {
        elsewhere.remove();
        f.remove("private");
      });
      await screen.findByRole("region", {
        name: "You’re no longer a member of Planning",
      });
      await f.accessSettled();
    });
    expect(document.activeElement).toBe(document.body);
  },
);

it("keeps the notice mounted while a later visit to the same channel rechecks access", async () => {
  const f = fixture({ type: "stream" });
  f.mountWithToasts();
  await screen.findByRole("textbox", { name: "Message Planning" });
  act(() => f.remove("public"));
  const banner = await screen.findByRole("region", {
    name: "You’re no longer a member of Planning",
  });
  await screen.findByRole("region", { name: "Channel preview" });
  await f.accessSettled();
  const removals = vi.fn();
  const observer = new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.removedNodes)
        if (node === banner || node.contains(banner)) removals();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  try {
    // A thread or message link opens the same channel again.
    const again = conversationTarget(f.scope, id);
    if (again.kind !== "conversation") throw new Error("Not a conversation");
    const checks = f.accessChecks();
    act(() => f.show({ ...again, messageId: "e".repeat(64) }));
    await waitFor(() => expect(f.accessChecks()).toBeGreaterThan(checks));
    await f.accessSettled();
  } finally {
    observer.disconnect();
  }
  expect(removals).not.toHaveBeenCalled();
  expect(banner).toBeInTheDocument();
});

it("never shows lost membership for the viewer's own Leave, even before it navigates", async () => {
  const f = fixture({ type: "stream", canLeave: true });
  f.mountWithToasts();
  const watch = watchForLossNotice();
  try {
    const user = userEvent.setup();
    await screen.findByRole("textbox", { name: "Message Planning" });
    await user.click(screen.getByRole("button", { name: "Channel actions" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Leave channel" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Leave channel: Planning",
    });
    // The relay drops the roster before the run settles and navigation follows.
    f.run.mockImplementationOnce(async () => f.remove("public"));
    await user.click(
      within(dialog).getByRole("button", { name: "Leave channel" }),
    );
    await waitFor(() => expect(f.run).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /^Leave/ })).toBeNull(),
    );
  } finally {
    watch.stop();
  }
  expect(watch.seen).not.toHaveBeenCalled();
  expect(screen.queryByText(noLongerMember)).toBeNull();
});

it.each(["Archive channel", "Leave channel"])(
  "shows a loss that arrived behind an open %s confirmation once it is cancelled",
  async (item) => {
    const f = fixture({ type: "stream", canLeave: true });
    f.mountWithToasts();
    const user = userEvent.setup();
    await screen.findByRole("textbox", { name: "Message Planning" });
    await user.click(screen.getByRole("button", { name: "Channel actions" }));
    await user.click(await screen.findByRole("menuitem", { name: item }));
    const dialog = await screen.findByRole("dialog", {
      name: `${item}: Planning`,
    });
    // Someone else removes the viewer while they are still deciding; nothing
    // of theirs was submitted, so the loss is not their own.
    act(() => f.remove("public"));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(
      await screen.findByRole("region", {
        name: "You’re no longer a member of Planning",
      }),
    ).toBeVisible();
    expect(f.run).not.toHaveBeenCalled();
  },
);

it("shows a removal during the viewer's Leave that fails before publishing", async () => {
  const f = fixture({ type: "stream", canLeave: true });
  f.mountWithToasts();
  const user = userEvent.setup();
  await screen.findByRole("textbox", { name: "Message Planning" });
  await user.click(screen.getByRole("button", { name: "Channel actions" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Leave channel" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Leave channel: Planning",
  });
  // Someone else removes the viewer while Leave reads its permissions, which
  // then refuse it: nothing was published.
  f.run.mockImplementationOnce(async () => {
    f.remove("private");
    throw new Error("You can’t leave this channel.");
  });
  await user.click(
    within(dialog).getByRole("button", { name: "Leave channel" }),
  );
  expect(await screen.findByText("Leave channel failed")).toBeVisible();
  expect(
    await screen.findByRole("region", {
      name: "You’re no longer a member of Planning",
    }),
  ).toBeVisible();
});

/** Leave fails unconfirmed: the relay may still apply it. */
async function failLeave(f: ReturnType<typeof fixture>) {
  const user = userEvent.setup();
  await screen.findByRole("textbox", { name: "Message Planning" });
  await user.click(screen.getByRole("button", { name: "Channel actions" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Leave channel" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Leave channel: Planning",
  });
  f.run.mockRejectedValueOnce(
    new ChannelLifecycleUnconfirmed(new Error("No acknowledgement")),
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Leave channel" }),
  );
  expect(await screen.findByText("Leave channel failed")).toBeVisible();
}

it.each([
  ["", () => {}],
  [
    ", even after discovery that reads no complete roster",
    // Live metadata of another channel, an exact read: none proves absence.
    (f: ReturnType<typeof fixture>) => f.discover(),
  ],
  [
    ", even through a failed roster read",
    (f: ReturnType<typeof fixture>) => {
      f.failRead();
      f.discover();
    },
  ],
] as const)(
  "keeps an unconfirmed Leave the viewer's own until the relay answers for the channel%s",
  async (_, between) => {
    const f = fixture({ type: "stream", canLeave: true });
    f.mountWithToasts();
    await failLeave(f);
    act(() => between(f));
    const watch = watchForLossNotice();
    try {
      // The relay applies the Leave after all, in its own time.
      act(() => f.remove("public"));
      await screen.findByRole("region", { name: "Channel preview" });
      await f.accessSettled();
    } finally {
      watch.stop();
    }
    expect(watch.seen).not.toHaveBeenCalled();
  },
);

it("shows a later loss once a complete roster read after an unconfirmed Leave still lists the channel", async () => {
  const f = fixture({ type: "stream", canLeave: true });
  f.mountWithToasts();
  await failLeave(f);
  // The Leave did not take effect: the viewer is still a member.
  act(() => f.reread());
  // A later read is partial until it completes. The settled Leave stays
  // settled, so a loss during that read is shown once it completes.
  act(() => f.rereading());
  act(() => f.remove("private"));
  act(() => f.reread(false));
  expect(
    await screen.findByRole("region", {
      name: "You’re no longer a member of Planning",
    }),
  ).toBeVisible();
});

it("shows the loss of a channel rejoined after an unconfirmed Leave took effect", async () => {
  const f = fixture({ type: "stream", canLeave: true });
  f.mountWithToasts();
  await failLeave(f);
  act(() => f.remove("public"));
  await screen.findByRole("region", { name: "Channel preview" });
  await f.accessSettled();
  expect(screen.queryByText(noLongerMember)).toBeNull();
  // Live roster events, with no complete read between them.
  act(() => f.rejoin());
  await screen.findByRole("textbox", { name: "Message Planning" });
  act(() => f.remove("private"));
  expect(
    await screen.findByRole("region", {
      name: "You’re no longer a member of Planning",
    }),
  ).toBeVisible();
});

it.each([
  ["the roster read fails", { status: "error" } as const],
  ["the roster is incomplete", { coverage: "partial" } as const],
])("claims no lost membership when %s", async (_, degraded) => {
  const f = fixture({ type: "stream" });
  f.mount();
  await screen.findByRole("textbox", { name: "Message Planning" });
  act(() => f.degrade(degraded));
  await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  await f.accessSettled();
  expect(screen.queryByText(noLongerMember)).toBeNull();
});

it("claims no lost membership from a new session that has not listed the channel", async () => {
  const f = fixture({ type: "stream" });
  f.mount();
  await screen.findByRole("textbox", { name: "Message Planning" });
  act(() => f.reconnect());
  await waitFor(() =>
    expect(
      screen.queryByRole("textbox", { name: "Message Planning" }),
    ).toBeNull(),
  );
  await f.accessSettled();
  expect(screen.queryByText(noLongerMember)).toBeNull();
});

it("claims no lost membership the relay never confirmed after launch", async () => {
  // Downloaded membership opens the channel before the live roster arrives.
  const f = fixture({ type: "stream", restored: true });
  f.mount();
  await screen.findByRole("button", { name: "Channel actions" });
  act(() => f.remove("public"));
  await screen.findByRole("region", { name: "Channel preview" });
  await f.accessSettled();
  expect(screen.queryByText(noLongerMember)).toBeNull();
});

it("claims no lost membership of a Solo chat", async () => {
  const f = fixture();
  f.mount();
  await screen.findByRole("button", { name: "Chat actions" });
  act(() => f.remove("private"));
  await f.accessSettled();
  expect(screen.queryByText(noLongerMember)).toBeNull();
});
