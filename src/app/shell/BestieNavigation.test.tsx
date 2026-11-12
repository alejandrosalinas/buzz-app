// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode, useEffect, useState } from "react";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentAvatars } from "../../features/agents/avatar-packs";
import { createAgentChoices } from "../../features/agents/choices";
import { createAgentLibrary } from "../../features/agents/library";
import { localAgentsFixture } from "../../features/agents/local-testing";
import type { RegisteredPage } from "../../features/pages/service";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { createRelaySession } from "../../features/relay/session";
import { createSidebarPreferencesStore } from "../../features/relay/sidebar-preferences-store";
import {
  keypair,
  message,
  metadata,
  roster,
} from "../../features/relay/testing";
import type { LiveCallbacks } from "../../features/relay/live";
import type { ReadJournal } from "../../features/relay/read-state-storage";
import type { ReadStateSigning } from "../../features/relay/read-state-host";
import {
  decodeReadState,
  signReadState,
  // @ts-expect-error Test the production Node codec with disposable identities.
} from "../../../browser-host/read-state.mjs";
import {
  forgetDefaultAgent,
  setDefaultAgent,
} from "../../features/solo/default-agent";
import { BestieNavigationProvider } from "./BestieNavigation";
import { PageNavigation } from "./PageNavigation";
import { PrimarySidebar } from "./PrimarySidebar";
import { ChannelNavigationProvider } from "../../features/channel-navigation/ChannelNavigationState";
import type { Navigation } from "../../features/navigation/controller";
import { PageSearch } from "./PageSearch";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
  localStorage.clear();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});
const viewer = "a".repeat(64),
  pollen = "b".repeat(64),
  fizz = "c".repeat(64);
const portrait = (() => {
  const asset = agentAvatars[0];
  if (!asset) throw new Error("Expected bundled agent artwork");
  return asset;
})();
const scope = `https://example.test:${viewer}`;
const page: RegisteredPage = {
  id: "bestie",
  key: "buzz.bestie/bestie",
  pluginId: "buzz.bestie",
  revision: "bundled",
  title: "Bestie",
  primary: true,
  component: () => null,
};

async function fixture(firstAgent = false) {
  const owner = createRelaySession(null);
  const libraryRead = vi.fn(async () => ({
    definitions: [],
    identities: firstAgent ? [] : [{ pubkey: fizz, name: "Fizz" }],
  }));
  const library = createAgentLibrary(libraryRead);
  const native = localAgentsFixture(
    firstAgent
      ? []
      : [
          {
            pubkey: pollen,
            name: "Pollen",
            picture: portrait.url,
            owner: viewer,
            relayUrl: "wss://example.test",
          },
        ],
  );
  const lifetime = new AbortController();
  const choices = createAgentChoices({
    scope,
    library: library.queries,
    native,
    signal: lifetime.signal,
  });
  await choices.refresh(false);
  const session = { ...owner.session, viewer, agentChoices: choices };
  let snapshot: RelaySnapshot = {
    status: "ready",
    generation: 1,
    viewer,
    scope,
    session,
  };
  const listeners = new Set<() => void>();
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry() {},
    tryAgain() {},
    disconnect() {},
    async clearCache() {},
  };
  disposals.push(() => {
    lifetime.abort();
    library.dispose();
    owner.dispose();
  });
  return {
    relay,
    native,
    libraryRead,
    update(patch: Partial<RelaySnapshot>) {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) listener();
    },
  };
}

it("shows the creation invitation in the dock, then follows the configured Bestie avatar", async () => {
  const f = await fixture();
  render(
    <BestieNavigationProvider pages={[page]} relay={f.relay}>
      <PageNavigation
        pages={[page]}
        selected={page.key}
        onSelect={() => {}}
        placement="dock"
      />
    </BestieNavigationProvider>,
  );
  const invitation = await screen.findByRole("tab", {
    name: "Create an agent",
  });
  expect(invitation.querySelector("img")).not.toBeNull();
  expect(invitation).toHaveAttribute("aria-selected", "true");
  act(() => setDefaultAgent(scope, pollen));
  const pollenTab = await screen.findByRole("tab", { name: "Pollen" });
  expect(pollenTab.querySelector("img")).toHaveAttribute(
    "src",
    portrait.preview,
  );
  act(() => setDefaultAgent(scope, fizz));
  const fizzTab = await screen.findByRole("tab", { name: "Fizz" });
  expect(fizzTab.querySelector("img")).toBeNull();
  expect(fizzTab).toHaveTextContent("F");
});

it("offers first-agent creation, then shows the exact Bestie in navigation and search", async () => {
  const f = await fixture(true);

  const select = vi.fn();
  render(
    <StrictMode>
      <BestieNavigationProvider pages={[page]} relay={f.relay}>
        <nav aria-label="Pages">
          <PageNavigation
            pages={[page]}
            selected={page.key}
            onSelect={select}
          />
        </nav>
        <PageSearch pages={[page]} onSelect={select} />
      </BestieNavigationProvider>
    </StrictMode>,
  );
  const nav = screen.getByRole("navigation", { name: "Pages" });
  const placeholder = await within(nav).findByRole("button", {
    name: "Create an agent",
  });
  expect(placeholder).toBeVisible();
  await waitFor(() => expect(placeholder.querySelector("img")).not.toBeNull());
  expect(select).not.toHaveBeenCalled();
  act(() => {
    f.native.set({
      agents: [
        {
          pubkey: pollen,
          name: "Pollen",
          picture: portrait.url,
          owner: viewer,
          relayUrl: "wss://example.test",
        },
        {
          pubkey: fizz,
          name: "Fizz",
          owner: viewer,
          relayUrl: "wss://example.test",
        },
      ],
    });
    setDefaultAgent(scope, pollen);
  });
  const pollenRow = await within(nav).findByRole("button", { name: "Pollen" });
  expect(pollenRow.querySelector("img")).toHaveAttribute(
    "src",
    portrait.preview,
  );
  expect(pollenRow.querySelector("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  expect(pollenRow.querySelector("[data-status]")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Search Buzz" }));
  const dialog = screen.getByRole("dialog", { name: "Search Buzz" });
  const pollenSearch = within(dialog).getByRole("option", {
    name: /Pollen.*Bestie/,
  });
  expect(pollenSearch.querySelector("img")).toHaveAttribute(
    "src",
    portrait.preview,
  );
  const search = within(dialog).getByRole("combobox", { name: "Search Buzz" });
  await userEvent.type(search, "Pollen");
  expect(
    within(dialog).getByRole("option", { name: /Pollen.*Bestie/ }),
  ).toBeInTheDocument();
  await userEvent.clear(search);
  await userEvent.type(search, "Bestie");
  expect(
    within(dialog).getByRole("option", { name: /Pollen.*Bestie/ }),
  ).toBeInTheDocument();
  act(() => {
    setDefaultAgent(scope, fizz);
  });
  expect(
    within(dialog).getByRole("option", { name: /Fizz.*Bestie/ }),
  ).toBeInTheDocument();
  await userEvent.click(
    within(dialog).getByRole("option", { name: /Fizz.*Bestie/ }),
  );
  expect(select).toHaveBeenCalledWith(page.key);
  const fizzRow = await within(nav).findByRole("button", { name: "Fizz" });
  expect(fizzRow.querySelector("img")).toBeNull();
  expect(fizzRow.querySelector("[data-avatar-shape]")).toHaveTextContent("F");
  act(() => {
    forgetDefaultAgent(fizz);
  });
  // An unassigned shortcut is the creation invitation even while the shared
  // library offers existing agents. Their presence does not make one Bestie.
  expect(
    within(nav).getByRole("button", { name: "Create an agent" }),
  ).toBeInTheDocument();
  act(() => {
    setDefaultAgent(scope, "d".repeat(64));
  });
  expect(
    within(nav).getByRole("button", { name: "Bestie" }),
  ).toBeInTheDocument();
});

it("follows roster changes and community replacement without remounting content or leaking the old identity", async () => {
  const f = await fixture();
  setDefaultAgent(scope, pollen);
  const mounts = vi.fn(),
    unmounts = vi.fn();
  function Content() {
    const [text, setText] = useState("");
    useEffect(() => {
      mounts();
      return unmounts;
    }, []);
    return (
      <input
        aria-label="Draft"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
    );
  }
  render(
    <BestieNavigationProvider pages={[page]} relay={f.relay}>
      <PageNavigation pages={[page]} selected={page.key} onSelect={() => {}} />
      <Content />
    </BestieNavigationProvider>,
  );
  await screen.findByRole("button", { name: "Pollen" });
  await userEvent.type(
    screen.getByRole("textbox", { name: "Draft" }),
    "keep this",
  );
  act(() => {
    f.native.set({
      agents: f.native
        .snapshot()
        .agents.map((agent) => ({ ...agent, name: "Renamed" })),
    });
  });
  expect(screen.getByRole("button", { name: "Renamed" })).toBeInTheDocument();
  act(() => {
    f.update({ status: "connecting", generation: 2 });
  });
  expect(screen.getByRole("button", { name: "Renamed" })).toBeInTheDocument();
  act(() => {
    f.update({ status: "ready", scope: `https://other.test:${viewer}` });
  });
  expect(
    screen.getByRole("button", { name: "Create an agent" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue(
    "keep this",
  );
  expect(mounts).toHaveBeenCalledTimes(1);
  expect(unmounts).not.toHaveBeenCalled();
});

it("does not demand legacy inventory when the Bestie page is disabled", async () => {
  const f = await fixture();
  render(
    <BestieNavigationProvider pages={[]} relay={f.relay}>
      content
    </BestieNavigationProvider>,
  );
  await waitFor(() => expect(screen.getByText("content")).toBeInTheDocument());
  expect(f.libraryRead).not.toHaveBeenCalled();
});

it("honors the promoted DM's mute and unread state through reads and Bestie replacement", async () => {
  const f = await fixture();
  const me = keypair(),
    relay = keypair(),
    agent = keypair();
  const first = "11111111-1111-4111-8111-111111111111",
    second = "22222222-2222-4222-8222-222222222222";
  let muted = true;
  const preferences = createSidebarPreferencesStore({
    available: true,
    read: async () => ({
      sections: [],
      assignments: {},
      starred: [],
      muted: muted ? [first] : [],
    }),
  });
  disposals.push(() => preferences.dispose());
  await preferences.queries.refresh();
  const discovery = [
    metadata(relay, first, "Pollen DM", undefined, [["t", "dm"]]),
    roster(relay, first, [me.pubkey, pollen]),
    metadata(relay, second, "Fizz DM", undefined, [["t", "dm"]]),
    roster(relay, second, [me.pubkey, fizz]),
  ];
  let live: LiveCallbacks | undefined;
  let journal: ReadJournal | undefined;
  const owner = createRelaySession(
    {
      viewer: me.pubkey,
      relayAuthor: relay.pubkey,
      readState: {
        decode: async (events) => decodeReadState(events, me.secret),
        sign: async (intent: ReadStateSigning) =>
          signReadState(intent, me.secret),
        publish: async () => {},
      },
      media: () => undefined,
      query: async (filters) =>
        filters.some((filter) =>
          filter.kinds?.some((kind) => kind === 39000 || kind === 39002),
        )
          ? discovery
          : [],
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      readStateFloor: () => 0,
      readPublisherLock: async (_signal, work) => work(),
      readStateStorage: {
        capture: async () => structuredClone(journal),
        async update(change) {
          journal = change(journal);
          return journal;
        },
        close() {},
      },
    },
  );
  disposals.push(() => owner.dispose());
  const liveState = {
    ...owner.session.live.snapshot(),
    roster: { state: "verified" as const },
  };
  const session = {
    ...owner.session,
    live: { ...owner.session.live, snapshot: () => liveState },
    agentChoices: f.relay.snapshot().session.agentChoices,
    sidebarPreferences: preferences.queries,
  };
  const currentScope = `https://example.test:${me.pubkey}`;
  f.update({ session, scope: currentScope, viewer: me.pubkey });
  live?.receive(discovery);
  setDefaultAgent(currentScope, pollen);
  const navigator = {
    open: vi.fn().mockResolvedValue({ status: "opened" }),
    subscribe: () => () => {},
    snapshot: () => ({ attempt: { id: "bestie-visit" } }),
  } as unknown as Navigation;
  // Like AppShell's memoized navigation: the provider can update without
  // recreating the sidebar element. Context must reach its retained consumers.
  const sidebar = (
    <ChannelNavigationProvider relay={f.relay}>
      <PrimarySidebar
        relay={f.relay}
        navigator={navigator}
        target={{
          version: 1,
          kind: "page",
          pluginId: "buzz.bestie",
          pageId: "bestie",
        }}
      >
        <PageNavigation
          pages={[page]}
          selected={page.key}
          placement="dock"
          onSelect={() => {}}
        />
      </PrimarySidebar>
    </ChannelNavigationProvider>
  );
  const tree = () => (
    <StrictMode>
      <BestieNavigationProvider pages={[page]} relay={f.relay}>
        {sidebar}
      </BestieNavigationProvider>
    </StrictMode>
  );
  const view = render(tree());
  const row = () => screen.getByRole("tab", { name: /^Pollen/ });
  const dmRow = () => document.querySelector(`[data-channel-id="${first}"]`);
  expect(row().querySelector("[data-channel-priority]")).toBeNull();
  await waitFor(() =>
    expect(
      document.querySelector(`[data-channel-id="${second}"]`),
    ).not.toBeNull(),
  );
  expect(dmRow()).toBeNull();
  const root = message(me, first, "Question", 1_700_000_004);
  act(() => {
    live?.receive([
      root,
      message(agent, first, "Thread reply", 1_700_000_005, [
        ["e", root.id, "", "reply"],
      ]),
    ]);
  });
  await waitFor(() => expect(row()).toHaveAccessibleName(/1 unread thread/));
  expect(row().querySelector("[data-channel-activity]")).toBeNull();
  expect(
    within(row()).getByRole("img", { name: /1 observed unread messages/ }),
  ).toBeInTheDocument();
  expect(row().querySelector("[data-channel-priority]")).toBeNull();
  expect(dmRow()).toBeNull();
  await act(async () => {
    muted = false;
    await preferences.queries.refresh();
  });
  expect(row().querySelector("[data-channel-activity]")).toBeInTheDocument();
  await act(async () => {
    muted = true;
    await preferences.queries.refresh();
  });
  expect(row().querySelector("[data-channel-activity]")).toBeNull();
  expect(row()).toHaveAccessibleName(/1 unread thread/);
  expect(dmRow()).toBeNull();
  view.rerender(tree());
  expect(dmRow()).toBeNull();
  await act(async () => {
    await session.unread.markChannelRead(first);
  });
  expect(row().querySelector("[data-channel-priority]")).toBeNull();
  await act(async () => {
    await session.unread.markUnreadLocal({ kind: "channel", channelId: first });
  });
  expect(
    within(row()).getByRole("img", { name: /Marked unread/ }),
  ).toBeInTheDocument();
  act(() => {
    setDefaultAgent(currentScope, fizz);
  });
  const replacement = screen.getByRole("tab", { name: "Fizz" });
  expect(replacement.querySelector("[data-channel-priority]")).toBeNull();
  act(() => {
    live?.receive([message(agent, first, "Old bestie message", 1_700_000_006)]);
  });
  expect(replacement.querySelector("[data-channel-priority]")).toBeNull();
  act(() => {
    live?.receive([
      message(agent, second, "New bestie message", 1_700_000_007),
    ]);
  });
  await waitFor(() =>
    expect(replacement.querySelector("[data-channel-priority]")).not.toBeNull(),
  );
  act(() => {
    forgetDefaultAgent(fizz);
  });
  expect(
    screen
      .getByRole("tab", { name: "Create an agent" })
      .querySelector("[data-channel-priority]"),
  ).toBeNull();
});
