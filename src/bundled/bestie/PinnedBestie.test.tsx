// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { agentAvatars } from "../../features/agents/avatar-packs";
import userEvent from "@testing-library/user-event";
import type { RegisteredPanel } from "../../features/panels/service";
import type { ReactNode } from "react";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { createAgentChoices } from "../../features/agents/choices";
import { createAgentLibrary } from "../../features/agents/library";
import { localAgentsFixture } from "../../features/agents/local-testing";
import type { Agents } from "../../features/agents/service";
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import {
  createNavigationController,
  type Navigation,
} from "../../features/navigation/controller";
import { createMemoryHistory } from "../../features/navigation/history";
import type { PageNavigation } from "../../features/navigation/service";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { createRelaySession } from "../../features/relay/session";
import {
  keypair,
  message,
  summary,
  bounds,
  metadata,
  roster,
  signed,
} from "../../features/relay/testing";
import type { RelayEvent } from "../../features/relay/events";
import { setDefaultAgent } from "../../features/solo/default-agent";
import { readView, writeView } from "../../shared/view-state";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { rememberFirstAgent } from "./FirstAgentWelcome";
import { PinnedBestie } from "./PinnedBestie";
import { bestieRoute } from "./routes";
import { BestieNavigationProvider } from "../../app/shell/BestieNavigation";
import { useBestieConversation } from "../../app/shell/bestie-context";
import type { RegisteredPage } from "../../features/pages/service";

// jsdom has no virtualized layout. Keep the real rows, thread reader and React
// lifecycle; model only Virtua's imperative layout boundary, not scroll behavior.
vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    Virtualizer: forwardRef(function Virtualizer(
      { children }: { children: ReactNode },
      ref,
    ) {
      useImperativeHandle(ref, () => ({
        cache: undefined,
        findItemIndex: () => 0,
        getItemOffset: () => 0,
        scrollOffset: 0,
        scrollSize: 0,
        viewportSize: 0,
        scrollTo() {},
        scrollToIndex() {},
      }));
      return <div>{children}</div>;
    }),
  };
});

composerDOMFixture();
const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});
const pollen = "b".repeat(64),
  fizz = "c".repeat(64),
  libraryOnly = "e".repeat(64);
const pollenArtwork = agentAvatars[0];
if (!pollenArtwork) throw new Error("Fixture needs bundled agent artwork");
const { url: pollenPicture, preview: pollenPreview } = pollenArtwork;
const pollenDM = "11111111-1111-4111-8111-111111111111";
const fizzDM = "22222222-2222-4222-8222-222222222222";
const libraryDM = "33333333-3333-4333-8333-333333333333";
const empty: readonly never[] = [];
const contribution = { snapshot: () => empty, subscribe: () => () => {} };
const extensions = { tools: contribution, inline: contribution };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture({
  failed = false,
  localFailed = false,
  hold = false,
  existing = false,
  badRoster = false,
  archived = false,
  withReply = false,
  hasOlder = false,
} = {}) {
  // jsdom has no native scrolling; thread reveals still use this DOM boundary.
  HTMLElement.prototype.scrollIntoView = vi.fn();
  // The timeline waits for a measurable host before mounting its virtualizer.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const viewer = keypair(),
    relayKey = keypair();
  const scope = `https://test.example:${viewer.pubkey}`;
  const discovery = new Map<string, RelayEvent[]>();
  function dm(
    agent: string,
    id = agent === pollen ? pollenDM : agent === fizz ? fizzDM : libraryDM,
  ) {
    discovery.set(id, [
      metadata(
        relayKey,
        id,
        agent === pollen ? "Pollen" : agent === fizz ? "Fizz" : "Library only",
        undefined,
        [["t", "dm"]],
      ),
      roster(relayKey, id, [viewer.pubkey, badRoster ? libraryOnly : agent]),
    ]);
    return id;
  }
  const root = message(viewer, pollenDM, "Are you there?", 1_700_000_000);
  const response = message(
    keypair(),
    pollenDM,
    "Yep, here. What’s up?",
    1_700_000_001,
    [["e", root.id, "", "reply"]],
  );
  const gate = deferred();
  const olderGate = deferred();
  const olderStarted = vi.fn();
  disposals.push(olderGate.resolve);
  if (existing) dm(pollen);
  const open = vi.fn(async (keys: readonly string[], _signal: AbortSignal) => {
    if (hold && keys[0] === pollen) await gate.promise;
    const key = keys[0];
    if (!key) throw new Error("Fixture needs an exact recipient");
    return dm(key);
  });
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relayKey.pubkey,
      ...(archived ? { archiveAuthority: relayKey.pubkey } : {}),
      scope: "https://test.example",
      media: () => undefined,
      query: async (filters) => {
        if (archived && filters.some((filter) => filter.kinds?.includes(13535)))
          return [
            signed(relayKey, {
              kind: 13535,
              created_at: 1_700_000_000,
              content: "",
              tags: [["-"], ["p", pollen]],
            }),
          ];
        if (
          filters.some((f) =>
            f.kinds?.some((kind) => kind === 39000 || kind === 39002),
          )
        )
          return [...discovery.values()].flat();
        const history = filters.find((filter) => filter.top_level);
        if (history?.before_id) {
          olderStarted();
          if (hasOlder) await olderGate.promise;
          return [
            bounds(
              relayKey,
              pollenDM,
              `${history.until}:${history.before_id}`,
              {
                has_more: false,
                next_cursor: null,
              },
            ),
          ];
        }
        if (withReply && history)
          return [
            root,
            summary(relayKey, pollenDM, root.id, {
              reply_count: 1,
              participants: [response.pubkey],
            }),
            bounds(relayKey, pollenDM, "head", {
              has_more: hasOlder,
              next_cursor: hasOlder
                ? { created_at: root.created_at, id: root.id }
                : null,
            }),
          ];
        if (
          withReply &&
          filters.some(
            (f) => f.ids?.includes(root.id) || f["#e"]?.includes(root.id),
          )
        )
          return [root, response];
        if (history)
          return [
            bounds(relayKey, history["#h"]?.[0] ?? pollenDM, "head", {
              has_more: false,
              next_cursor: null,
            }),
          ];
        return [];
      },
      openDirectMessage: open,
      writer: {
        kinds: [9, 9000],
        sign: async (event) => signed(viewer, event),
        publish: async () => {},
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  let unavailable = failed;
  const read = vi.fn(async () => {
    if (unavailable) throw new Error("Fixture inventory unavailable");
    return {
      definitions: [],
      identities: [{ pubkey: libraryOnly, name: "Library only" }],
    };
  });
  const library = createAgentLibrary(read);
  const native = localAgentsFixture(
    [
      {
        pubkey: pollen,
        name: "Pollen",
        picture: pollenPicture,
        owner: viewer.pubkey,
        relayUrl: "wss://test.example",
      },
      {
        pubkey: fizz,
        name: "Fizz",
        owner: viewer.pubkey,
        relayUrl: "wss://test.example",
      },
    ],
    localFailed ? "error" : "ready",
  );
  if (localFailed)
    native.set({ status: "error", error: "Local agents unavailable" });
  const lifetime = new AbortController();
  const choices = createAgentChoices({
    scope,
    library: library.queries,
    native,
    ...(archived ? { archives: owner.session.archives } : {}),
    signal: lifetime.signal,
  });
  await choices.refresh();
  let ineligibleSnapshot: ReturnType<typeof choices.snapshot> | undefined;
  const agentChoices = {
    ...choices,
    snapshot: () => ineligibleSnapshot ?? choices.snapshot(),
  };
  native.onRefresh(() => native.set({ status: "ready" }));
  disposals.push(() => {
    lifetime.abort();
    library.dispose();
    owner.dispose();
  });
  const send = vi.fn<typeof owner.session.messages.send>(() => "d".repeat(64));
  const session = {
    ...owner.session,
    agentChoices,
    messages: { ...owner.session.messages, send },
  };
  let snapshot = {
    status: "ready" as const,
    generation: 1,
    scope,
    viewer: viewer.pubkey,
    session,
  } as RelaySnapshot;
  const relayListeners = new Set<() => void>();
  const retryConnection = vi.fn();
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe(listener) {
      relayListeners.add(listener);
      return () => relayListeners.delete(listener);
    },
    retry() {},
    tryAgain: retryConnection,
    disconnect() {},
    async clearCache() {},
  };
  const controller = createNavigationController(
    createMemoryHistory({
      version: 1,
      kind: "page",
      pluginId: "buzz.bestie",
      pageId: "bestie",
    }),
  );
  disposals.push(controller.dispose);
  const navigator = controller.navigation;
  let panels: readonly RegisteredPanel[] = [];
  const panelListeners = new Set<() => void>();
  const host = {
    relay,
    panels: {
      snapshot: () => panels,
      subscribe: (listener: () => void) => {
        panelListeners.add(listener);
        return () => panelListeners.delete(listener);
      },
      resolve: (target: string) =>
        panels.find((panel) => panel.matches(target)),
    },
    navigation: { open: vi.fn() },
  } as unknown as ConversationHostServices;
  const agents = {
    subscribe: () => () => {},
    snapshot: () => undefined,
    types: () => empty,
    find: () => undefined,
  } as unknown as Agents;
  return {
    setPanels(next: readonly RegisteredPanel[]) {
      panels = next;
      for (const listener of panelListeners) listener();
    },
    viewer: viewer.pubkey,
    scope,
    session,
    relay,
    send,
    read,
    open,
    gate,
    olderGate,
    olderStarted,
    native,
    navigator,
    makePollenIneligible() {
      const current = choices.snapshot();
      ineligibleSnapshot = {
        ...current,
        selectable: current.selectable.filter(
          (choice) => choice.pubkey !== pollen,
        ),
      };
    },
    retryConnection,
    updateRelay(patch: Partial<RelaySnapshot>) {
      snapshot = { ...snapshot, ...patch } as RelaySnapshot;
      for (const listener of relayListeners) listener();
    },
    recover: () => {
      unavailable = false;
    },
    choose: (pubkey: string) => setDefaultAgent(scope, pubkey),
    element: ({
      renderedNavigator = navigator,
      navigation,
    }: {
      renderedNavigator?: Navigation | undefined;
      navigation?: PageNavigation | undefined;
    } = {}) => (
      <ToastProvider>
        <PinnedBestie
          relay={relay}
          host={host}
          extensions={extensions}
          navigator={renderedNavigator}
          agents={agents}
          navigation={navigation}
        />
      </ToastProvider>
    ),
    rootId: root.id,
    mount: () =>
      render(
        <ToastProvider>
          <PinnedBestie
            relay={relay}
            host={host}
            extensions={extensions}
            navigator={navigator}
            agents={agents}
          />
        </ToastProvider>,
        { reactStrictMode: true },
      ),
  };
}

it("opens the actual verified DM and sends plain text without a seeded removable mention", async () => {
  const f = await fixture();
  rememberFirstAgent(f.scope, pollen);
  f.choose(pollen);
  const user = userEvent.setup();
  const view = f.mount();
  const input = await screen.findByRole("textbox", { name: "Message Pollen" });
  expect(f.open).toHaveBeenCalledWith([pollen], expect.any(AbortSignal));
  expect(
    f.session.channels.list().channels.find((c) => c.id === pollenDM),
  ).toMatchObject({
    channelType: "dm",
    members: expect.arrayContaining([pollen]),
  });
  const welcome = await screen.findByRole("article", {
    name: "Welcome to Buzz",
  });
  expect(welcome).toHaveTextContent(
    "Ask away, or tell me what you’d like to work on.",
  );
  expect(within(welcome).getByText("Pollen")).toBeVisible();
  expect(
    within(welcome).getByRole("heading", { name: "Welcome to Buzz!" }),
  ).toBeVisible();
  expect(
    within(welcome)
      .getByRole("img", { name: "Pollen avatar" })
      .querySelector("img"),
  ).toHaveAttribute("src", pollenPreview);
  expect(
    within(welcome).queryByText(/Local welcome|not a sent message/),
  ).not.toBeInTheDocument();
  expect(within(welcome).queryByRole("button")).not.toBeInTheDocument();
  expect(screen.queryByText("No messages yet.")).not.toBeInTheDocument();
  expect(f.send).not.toHaveBeenCalled();
  expect(f.session.channels.window(pollenDM).rows).toHaveLength(0);
  expect(input).not.toHaveTextContent("@Pollen");
  expect(
    screen.queryByRole("button", { name: /Remove mention/ }),
  ).not.toBeInTheDocument();
  await user.type(input, "Morning");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(f.send).toHaveBeenCalledWith(pollenDM, "Morning", [], []),
  );
  expect(
    screen.getByRole("article", { name: "Welcome to Buzz" }),
  ).toBeVisible();
  view.unmount();
  f.mount();
  expect(
    await screen.findByRole("article", { name: "Welcome to Buzz" }),
  ).toBeVisible();
  expect(f.send).toHaveBeenCalledTimes(1);
  act(() => f.choose(fizz));
  await screen.findByRole("textbox", { name: "Message Fizz" });
  expect(
    screen.queryByRole("article", { name: "Welcome to Buzz" }),
  ).not.toBeInTheDocument();
  act(() => f.choose(pollen));
  expect(
    await screen.findByRole("textbox", { name: "Message Pollen" }),
  ).not.toHaveTextContent("@Pollen");
  expect(
    screen.queryByRole("button", { name: /Remove mention/ }),
  ).not.toBeInTheDocument();
});

it("shows the local welcome only at known history start and keeps real history intact", async () => {
  const f = await fixture({ existing: true, withReply: true, hasOlder: true });
  rememberFirstAgent(f.scope, pollen);
  f.choose(pollen);
  f.mount();
  try {
    // Main fills a short viewport automatically. Hold that real session read
    // so the assertion observes pending history, not a race with its response.
    await waitFor(() => expect(f.olderStarted).toHaveBeenCalledOnce());
    expect(await screen.findByText("Are you there?")).toBeVisible();
    expect(
      screen.queryByRole("article", { name: "Welcome to Buzz" }),
    ).not.toBeInTheDocument();
    await act(async () => f.olderGate.resolve());
    expect(
      await screen.findByRole("article", { name: "Welcome to Buzz" }),
    ).toBeVisible();
    expect(screen.getByText("Are you there?")).toBeVisible();
    expect(f.send).not.toHaveBeenCalled();
  } finally {
    f.olderGate.resolve();
  }
});

it("reuses an existing DM and its ordinary draft after leaving and reopening Bestie", async () => {
  const f = await fixture({ existing: true });
  writeView(f.scope, `draft:${pollenDM}`, "Existing DM draft");
  f.choose(pollen);
  const view = f.mount();
  expect(
    await screen.findByRole("textbox", { name: "Message Pollen" }),
  ).toHaveTextContent("Existing DM draft");
  expect(f.open).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("article", { name: "Welcome to Buzz" }),
  ).not.toBeInTheDocument();
  view.unmount();
  f.mount();
  expect(
    await screen.findByRole("textbox", { name: "Message Pollen" }),
  ).toHaveTextContent("Existing DM draft");
  expect(f.open).not.toHaveBeenCalled();
});

it("keeps the promoted verified DM usable through discovery failure until absence is confirmed", async () => {
  const f = await fixture({ existing: true });
  const agents = f.native.snapshot().agents;
  f.choose(pollen);
  writeView(f.scope, `draft:${pollenDM}`, "Keep the existing draft");
  const page: RegisteredPage = {
    id: "bestie",
    key: "buzz.bestie/bestie",
    pluginId: "buzz.bestie",
    revision: "bundled",
    title: "Bestie",
    component: () => null,
  };
  function Promotion() {
    return (
      <output aria-label="promoted DM">
        {useBestieConversation(f.session) ?? "none"}
      </output>
    );
  }
  render(
    <BestieNavigationProvider pages={[page]} relay={f.relay}>
      <Promotion />
      {f.element()}
    </BestieNavigationProvider>,
    { reactStrictMode: true },
  );
  const input = await screen.findByRole("textbox", { name: "Message Pollen" });
  expect(input).toHaveTextContent("Keep the existing draft");
  expect(screen.getByLabelText("promoted DM")).toHaveTextContent(pollenDM);
  act(() => {
    f.native.set({
      status: "error",
      agents: [],
      error: "Local agents unavailable",
    });
  });
  expect(f.session.agentChoices.snapshot()).toMatchObject({ complete: false });
  expect(
    f.session.agentChoices.snapshot().selectable.map((agent) => agent.pubkey),
  ).not.toContain(pollen);
  expect(await screen.findByRole("textbox", { name: "Message Bestie" })).toBe(
    input,
  );
  expect(input).toHaveTextContent("Keep the existing draft");
  expect(screen.getByLabelText("promoted DM")).toHaveTextContent(pollenDM);
  act(() => f.native.set({ status: "ready", agents }));
  expect(await screen.findByRole("textbox", { name: "Message Pollen" })).toBe(
    input,
  );
  act(() => f.native.set({ status: "ready", agents: [] }));
  expect(await screen.findByText("Bestie is no longer here")).toBeVisible();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.getByLabelText("promoted DM")).toHaveTextContent("none");
  expect(f.open).not.toHaveBeenCalled();
});

it("follows a bestie changed elsewhere without carrying the old DM draft or modifying the Solo draft", async () => {
  const f = await fixture();
  const user = userEvent.setup();
  writeView(f.scope, "solo:new-draft", "Untouched Solo notes");
  f.choose(pollen);
  f.mount();
  await user.type(
    await screen.findByRole("textbox", { name: "Message Pollen" }),
    "Keep these notes",
  );
  expect(
    screen.queryByRole("button", { name: /Change.*bestie/i }),
  ).not.toBeInTheDocument();
  act(() => {
    f.choose(fizz);
  });
  expect(
    await screen.findByRole("textbox", { name: "Message Fizz" }),
  ).not.toHaveTextContent("Keep these notes");
  act(() => {
    f.choose(pollen);
  });
  expect(
    await screen.findByRole("textbox", { name: "Message Pollen" }),
  ).toHaveTextContent("Keep these notes");
  expect(readView(f.scope, "solo:new-draft", "")).toBe("Untouched Solo notes");
});

it("does not display a stale open after the selection changes, and aborts it on unmount", async () => {
  const f = await fixture({ hold: true });
  f.choose(pollen);
  const view = f.mount();
  await waitFor(() => expect(f.open).toHaveBeenCalled());
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  act(() => {
    f.choose(fizz);
  });
  await screen.findByRole("textbox", { name: "Message Fizz" });
  await act(async () => {
    f.gate.resolve();
  });
  expect(
    screen.queryByRole("textbox", { name: "Message Pollen" }),
  ).not.toBeInTheDocument();
  expect(
    f.open.mock.calls
      .filter(([keys]) => keys[0] === pollen)
      .every(([, signal]) => signal.aborted),
  ).toBe(true);
  view.unmount();
});

it("reports an open failure and retries through the same DM owner", async () => {
  const f = await fixture();
  f.open.mockRejectedValueOnce(new Error("DM temporarily unavailable"));
  // StrictMode abandons its initial effect; both initial opens must fail.
  f.open.mockRejectedValueOnce(new Error("DM temporarily unavailable"));
  f.choose(pollen);
  f.mount();
  await screen.findByText("DM temporarily unavailable");
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("textbox", { name: "Message Pollen" });
});

it("keeps a failed DM retry focused and announces another failure", async () => {
  const f = await fixture();
  f.open.mockRejectedValueOnce(new Error("DM temporarily unavailable"));
  // StrictMode abandons its initial effect; both initial opens must fail.
  f.open.mockRejectedValueOnce(new Error("DM temporarily unavailable"));
  let rejectRetry!: (reason: unknown) => void;
  f.open.mockImplementationOnce(
    () =>
      new Promise<string>((_resolve, reject) => {
        rejectRetry = reject;
      }),
  );
  f.choose(pollen);
  f.mount();
  await screen.findByText("DM temporarily unavailable");
  const retry = screen.getByRole("button", { name: "Try again" });
  await userEvent.click(retry);
  expect(retry).toHaveFocus();
  await waitFor(() => expect(retry).toHaveAttribute("aria-busy", "true"));
  await act(async () => rejectRetry(new Error("DM still unavailable")));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "DM still unavailable",
  );
  expect(screen.getByRole("button", { name: "Try again" })).toBe(retry);
  expect(retry).toHaveFocus();
});

async function threadHistoryFixture() {
  const f = await fixture({ existing: true, withReply: true });
  f.choose(pollen);
  const previous = {
    version: 1,
    kind: "page",
    pluginId: "buzz.channels",
    pageId: "channels",
  } as const;
  const bestie = {
    version: 1,
    kind: "page",
    pluginId: "buzz.bestie",
    pageId: "bestie",
  } as const;
  const controller = createNavigationController(createMemoryHistory(previous));
  disposals.push(controller.dispose);
  const navigator = controller.navigation;
  void navigator.open(bestie);
  const pageNavigation = (): PageNavigation => {
    const { entry, attempt } = navigator.snapshot();
    const request: PageNavigation = {
      entryId: entry.id,
      target: entry.target,
      signal: attempt.signal,
      ...(attempt.focus ? { focus: attempt.focus } : {}),
      position: () => undefined,
      savePosition() {},
      passThrough: () => () => {},
      forSession: () => request,
      resolve: () => false,
      complete: () => true,
    };
    return request;
  };
  const view = render(
    f.element({ renderedNavigator: navigator, navigation: pageNavigation() }),
    { reactStrictMode: true },
  );
  const rerender = () =>
    view.rerender(
      f.element({ renderedNavigator: navigator, navigation: pageNavigation() }),
    );

  return { ...f, navigator, bestie, previous, rerender, view, pageNavigation };
}

it("restores Bestie threads with Back and Forward and retires every explicitly closed visit", async () => {
  const f = await threadHistoryFixture();
  const { navigator, rerender, bestie } = f;
  await userEvent.click(
    await screen.findByRole("button", { name: "View thread: 1 reply" }),
  );
  const threadTarget = navigator.snapshot().entry.target;
  expect(
    threadTarget.kind === "page"
      ? bestieRoute(threadTarget.route?.params)
      : undefined,
  ).toEqual({
    channelId: pollenDM,
    messageId: f.rootId,
    threadRootId: f.rootId,
  });
  rerender();
  expect(await screen.findByLabelText("Thread")).toBeVisible();

  act(() => navigator.back());
  rerender();
  expect(
    await screen.findByRole("textbox", { name: "Message Pollen" }),
  ).toBeVisible();
  act(() => navigator.forward());
  rerender();
  expect(await screen.findByLabelText("Thread")).toBeVisible();

  const other = {
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
  } as const;
  void navigator.open(other);
  rerender();
  void navigator.open(bestie);
  rerender();
  void navigator.open(threadTarget);
  rerender();
  expect(await screen.findByLabelText("Thread")).toBeVisible();

  await userEvent.click(
    screen.getByRole("button", { name: "Close Are you there? tab" }),
  );
  rerender();
  expect(navigator.snapshot().entry.target).toEqual(bestie);
  act(() => navigator.back());
  expect(navigator.snapshot().entry.target).toEqual(other);
  act(() => navigator.back());
  expect(navigator.snapshot().entry.target).toEqual(bestie);
  act(() => navigator.forward());
  expect(navigator.snapshot().entry.target).toEqual(other);
  act(() => navigator.forward());
  expect(navigator.snapshot().entry.target).toEqual(bestie);
});

it("retires an old Bestie's thread visits instead of reading them in the replacement DM", async () => {
  const f = await threadHistoryFixture();
  const { navigator, rerender, bestie, previous } = f;
  await userEvent.click(
    await screen.findByRole("button", { name: "View thread: 1 reply" }),
  );
  const threadTarget = navigator.snapshot().entry.target;
  rerender();
  expect(await screen.findByLabelText("Thread")).toBeVisible();
  // Repeated visits to A's thread must all retire, not only the current one.
  act(() => void navigator.open(bestie));
  rerender();
  act(() => void navigator.open(threadTarget));
  rerender();
  expect(await screen.findByLabelText("Thread")).toBeVisible();
  const agents = {
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
  } as const;
  act(() => void navigator.open(agents));
  // The page is not mounted while the owner changes Bestie in Agents.
  f.view.unmount();
  const readThread = vi.spyOn(f.session, "thread");
  act(() => f.choose(fizz));
  act(() => navigator.back());
  const restored = render(
    f.element({
      renderedNavigator: navigator,
      navigation: f.pageNavigation(),
    }),
    { reactStrictMode: true },
  );
  expect(
    await screen.findByRole("textbox", { name: "Message Fizz" }),
  ).toBeVisible();
  await waitFor(() =>
    expect(navigator.snapshot().entry.target).toEqual(bestie),
  );
  expect(screen.queryByLabelText("Thread")).not.toBeInTheDocument();
  expect(readThread).not.toHaveBeenCalled();
  restored.unmount();
  act(() => navigator.back());
  expect(navigator.snapshot().entry.target).toEqual(bestie);
  act(() => navigator.back());
  expect(navigator.snapshot().entry.target).toEqual(previous);
  act(() => navigator.forward());
  expect(navigator.snapshot().entry.target).toEqual(bestie);
  act(() => navigator.forward());
  expect(navigator.snapshot().entry.target).toEqual(bestie);
  act(() => navigator.forward());
  expect(navigator.snapshot().entry.target).toEqual(agents);
});

it("never renders a DM whose signed membership does not match the chosen agent", async () => {
  const f = await fixture({ badRoster: true });
  f.choose(pollen);
  f.mount();
  await screen.findByText(
    "The conversation’s participants could not be confirmed. Try again.",
  );
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

it("keeps the saved Bestie visible through reconnect and offers connection recovery", async () => {
  const f = await fixture({ existing: true });
  f.choose(pollen);
  f.mount();
  await screen.findByRole("textbox", { name: "Message Pollen" });
  act(() => f.updateRelay({ status: "connecting" }));
  expect(screen.getByRole("heading", { name: "Pollen" })).toBeVisible();
  expect(screen.getByText("Connecting…")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Set up Bestie" }),
  ).not.toBeInTheDocument();
  act(() =>
    f.updateRelay({ status: "error", error: "Community temporarily offline" }),
  );
  expect(screen.getByText("Community temporarily offline")).toBeVisible();
  await userEvent.click(
    screen.getByRole("button", { name: "Retry connection" }),
  );
  expect(f.retryConnection).toHaveBeenCalledOnce();
});

it("recovers a saved agent missing from a partial inventory through refresh", async () => {
  const f = await fixture({ localFailed: true });
  f.choose(pollen);
  f.mount();
  expect(await screen.findByText("Local agents unavailable")).toBeVisible();
  expect(f.session.agentChoices.snapshot()).toMatchObject({
    status: "ready",
    complete: false,
    error: "Local agents unavailable",
  });
  expect(f.open).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("textbox", { name: "Message Pollen" });
  expect(f.session.agentChoices.snapshot()).toMatchObject({
    status: "ready",
    complete: true,
  });
  expect(f.session.agentChoices.snapshot()).not.toHaveProperty("error");
});

it("replaces a missing saved Bestie from the chooser in place", async () => {
  const f = await fixture();
  f.choose(pollen);
  f.makePollenIneligible();
  f.mount();
  expect(
    await screen.findByRole("heading", { name: "Pollen is no longer here" }),
  ).toBeVisible();
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("combobox", {
      name: "Choose an eligible agent or create a new one:",
    }),
  );
  await user.click(await screen.findByRole("option", { name: /^Fizz / }));
  expect(
    await screen.findByRole("textbox", { name: "Message Fizz" }),
  ).toBeVisible();
  expect(f.open).toHaveBeenCalledWith([fizz], expect.any(AbortSignal));
});

it("does not use a known-archived identity's DM during partial discovery", async () => {
  const f = await fixture({
    existing: true,
    localFailed: true,
    archived: true,
  });
  await f.session.archives.refresh();
  expect(f.session.agentChoices.snapshot().archives.archived).toContain(pollen);
  // Keep both source reads settled and failed while archive evidence stays ready.
  f.native.onRefresh(() => {});
  f.choose(pollen);
  f.mount();
  await waitFor(() =>
    expect(screen.getByText("Local agents unavailable")).toBeVisible(),
  );
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(f.open).not.toHaveBeenCalled();
});

it("rechecks eligibility before retrying a failed DM open", async () => {
  const f = await fixture();
  f.open.mockRejectedValueOnce(new Error("DM temporarily unavailable"));
  f.open.mockRejectedValueOnce(new Error("DM temporarily unavailable"));
  f.choose(pollen);
  f.mount();
  await screen.findByText("DM temporarily unavailable");
  const attempts = f.open.mock.calls.length;
  f.makePollenIneligible();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(
    await screen.findByText(
      "This agent is no longer available in this community.",
    ),
  ).toBeVisible();
  expect(f.open).toHaveBeenCalledTimes(attempts);
});

it("keeps the welcome, DM and draft mounted beside a thread and retains the reply draft while collapsing its pane", async () => {
  const f = await fixture({ existing: true, withReply: true });
  rememberFirstAgent(f.scope, pollen);
  f.choose(pollen);
  f.mount();
  const user = userEvent.setup();
  const composer = await screen.findByRole("textbox", {
    name: "Message Pollen",
  });
  const welcome = await screen.findByRole("article", {
    name: "Welcome to Buzz",
  });
  await user.type(composer, "Main draft");
  await user.click(
    await screen.findByRole("button", { name: "View thread: 1 reply" }),
  );
  expect(await screen.findByLabelText("Thread")).toBeVisible();
  expect(screen.getByRole("article", { name: "Welcome to Buzz" })).toBe(
    welcome,
  );
  expect(screen.getByRole("textbox", { name: "Message Pollen" })).toBe(
    composer,
  );
  expect(composer).toHaveTextContent("Main draft");
  const reply = screen.getByRole("textbox", { name: "Reply to thread" });
  await user.type(reply, "Reply draft");
  await user.click(screen.getByRole("button", { name: "Toggle tab pane" }));
  expect(composer).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Toggle tab pane" }));
  expect(await screen.findByRole("textbox", { name: "Reply to thread" })).toBe(
    reply,
  );
  expect(reply).toHaveTextContent("Reply draft");
  await user.click(
    screen.getByRole("button", { name: "Close Are you there? tab" }),
  );
  expect(composer).toHaveTextContent("Main draft");
  expect(screen.queryByLabelText("Thread")).not.toBeInTheDocument();
  expect(screen.getByRole("article", { name: "Welcome to Buzz" })).toBe(
    welcome,
  );
  expect(f.send).not.toHaveBeenCalled();
});

it.each(["side", "bottom", "tab"] as const)(
  "offers DM plugin controls and opens their %s content in Bestie",
  async (placement) => {
    const f = await fixture({ existing: true });
    f.choose(pollen);
    const user = userEvent.setup();
    f.setPanels([
      {
        id: "test",
        key: "test/control",
        pluginId: "test",
        revision: "1",
        title: "Call control",
        matches: (target) => target === "test:call",
        channelPlacement: placement,
        channelLauncher: ({ context, toggle, available }) => (
          <button
            type="button"
            onClick={() => {
              if (available()) toggle("test:call");
            }}
          >
            Call {context.channelId}
          </button>
        ),
        component: ({ close }) => (
          <button type="button" onClick={close}>
            Close call content
          </button>
        ),
      } satisfies RegisteredPanel,
    ]);
    f.mount();
    await user.click(
      await screen.findByRole("button", { name: `Call ${pollenDM}` }),
    );
    expect(
      await screen.findByRole("button", { name: "Close call content" }),
    ).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "Message Pollen" }),
    ).toBeInTheDocument();
    await act(async () => f.setPanels([]));
    expect(
      screen.queryByRole("button", { name: `Call ${pollenDM}` }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Close call content" }),
    ).toBeNull();
  },
);

it("offers the shared DM actions and channel details in Bestie", async () => {
  const f = await fixture({ existing: true });
  f.choose(pollen);
  const user = userEvent.setup();
  f.mount();
  await user.click(
    await screen.findByRole("button", { name: "Channel actions" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "View channel details" }),
  );
  expect(
    await screen.findByRole("tab", { name: "Channel settings" }),
  ).toBeVisible();
  expect(
    screen.getByRole("textbox", { name: "Message Pollen" }),
  ).toBeInTheDocument();
});

it("opens eligible plugin menu items in the Bestie workspace", async () => {
  const f = await fixture({ existing: true });
  f.choose(pollen);
  const user = userEvent.setup();
  f.setPanels([
    {
      id: "canvas",
      key: "test/canvas",
      pluginId: "test",
      revision: "1",
      title: "Canvas",
      matches: () => false,
      channelMenu: {
        label: "View canvas",
        eligible: (channel) => channel.id === pollenDM,
      },
      component: ({ channelContext }) => (
        <p>Canvas for {channelContext?.channelId}</p>
      ),
    } satisfies RegisteredPanel,
  ]);
  f.mount();
  await user.click(
    await screen.findByRole("button", { name: "Channel actions" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "View canvas" }),
  );
  expect(await screen.findByText(`Canvas for ${pollenDM}`)).toBeVisible();
  expect(
    screen.getByRole("textbox", { name: "Message Pollen" }),
  ).toBeInTheDocument();
});
