// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../features/agents/avatar-testing";
stubAvatarBrowserApis();
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
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { App } from "./App";
import { createServices, type AppServices } from "./services";
import {
  parseOpenTarget,
  type OpenTarget,
} from "../features/navigation/targets";
import { bindDeepLinks } from "../features/navigation/deep-links";
import { matchesEvent } from "../features/relay/projection";
import { bounds, message, metadata, roster } from "../features/relay/testing";
import type { ReadFilter } from "../features/relay/events";
import type { StorageResult } from "../plugins/types";

/** Any variant of the App-owned "page couldn't open" card. */
const pageFailure =
  /^(This page isn’t available|Can’t connect|You don’t have access to this|This link doesn’t work)$/;

// Holds the plugin catalog read, so a test can settle the client first, and
// lets a test change what the read returns.
const catalogGate = vi.hoisted(() => ({
  value: undefined as Promise<void> | undefined,
  edit: undefined as ((result: StorageResult) => StorageResult) | undefined,
}));
vi.mock("../plugins/storage", async (original) => {
  const actual = await original<typeof import("../plugins/storage")>();
  return {
    ...actual,
    createPluginStorage(
      ...args: Parameters<typeof actual.createPluginStorage>
    ) {
      const storage = actual.createPluginStorage(...args);
      return {
        ...storage,
        async getCatalog() {
          await catalogGate.value;
          const result = await storage.getCatalog();
          return catalogGate.edit?.(result) ?? result;
        },
      };
    },
  };
});
// Holds Inbox's module load, so its activation can settle last.
const inboxGate = vi.hoisted(() => ({
  value: undefined as Promise<void> | undefined,
}));
vi.mock("../plugins/modules", async (original) => {
  const actual = await original<typeof import("../plugins/modules")>();
  return {
    ...actual,
    createModuleLoader(...args: Parameters<typeof actual.createModuleLoader>) {
      const load = actual.createModuleLoader(...args);
      return async (plugin: Parameters<typeof load>[0]) => {
        if (plugin.manifest.id === "buzz.inbox") await inboxGate.value;
        return load(plugin);
      };
    },
  };
});
vi.mock("../bundled", async () => ({
  bundledPlugins: [
    {
      manifest: { id: "buzz.channels", name: "Channels", apiVersion: 1 },
      module: await import("../bundled/channels"),
    },
    {
      manifest: { id: "buzz.repos", name: "Projects", apiVersion: 1 },
      module: await import("../bundled/repos"),
    },
    {
      manifest: { id: "buzz.agents", name: "Agents", apiVersion: 1 },
      module: await import("../bundled/agents"),
    },
    {
      manifest: {
        id: "buzz.watching",
        name: "Attention",
        apiVersion: 1,
      },
      module: await import("../bundled/watching"),
      enabledByDefault: true,
    },
    {
      manifest: { id: "buzz.inbox", name: "Activity", apiVersion: 1 },
      module: await import("../bundled/inbox"),
    },
    {
      manifest: { id: "buzz.bestie", name: "Bestie", apiVersion: 1 },
      module: await import("../bundled/bestie"),
    },
    {
      // A vended page without the primary flag: listed in search, no sidebar row.
      manifest: { id: "fixture.notes", name: "Notes", apiVersion: 1 },
      module: {
        inject: ["pages"],
        apply(ctx: import("@deepseek-ai/cordis").Context) {
          ctx.pages.register({
            id: "notes",
            title: "Fixture notes",
            component: () => null,
          });
        },
      },
    },
  ],
}));
const key = new Uint8Array(32).fill(6),
  viewer = getPublicKey(key),
  origin = "https://community.example";
const project = finalizeEvent(
  {
    kind: 30617,
    created_at: 1,
    content: "",
    tags: [
      ["d", "project"],
      ["name", "Recovered project"],
      ["description", "Actual recovered destination"],
    ],
  },
  key,
);
// jsdom has no media queries; responsive geometry is covered in browser tests.
beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
let services: AppServices | undefined;
let stop = () => {};
afterEach(async () => {
  cleanup();
  stop();
  await services?.dispose();
  services = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  catalogGate.value = undefined;
  catalogGate.edit = undefined;
  inboxGate.value = undefined;
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});
it("keeps an OS entity intent through real community selection and Retry in App", async () => {
  // jsdom has no layout observer; App now keeps its real sidebar mounted here.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "Fixture", picture: "" },
      memberships: [{ id: origin, name: "Fixture community" }],
      selected: null,
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/identity")) return Response.json({ viewer });
      if (url.endsWith("/session"))
        return Response.json({ viewer, relayAuthor: viewer, relayUrl: origin });
      if (url.endsWith("/query")) {
        const filters = JSON.parse(String(options?.body)) as ReadFilter[];
        return Response.json(
          [project].filter((event) =>
            filters.some((filter) => matchesEvent(event, filter)),
          ),
        );
      }
      return Response.json({});
    }),
  );
  services = createServices();
  const current = services;
  const queue = [`buzz://repo?owner=${viewer}&d=project`];
  let ping = () => {};
  stop = bindDeepLinks(current.deepLinks, current.communities, {
    take: async () => queue.splice(0),
    watch(listener) {
      ping = listener;
      return () => {};
    },
  });
  render(<App services={current} />);
  await screen.findByRole("button", { name: "Try again" });
  expect(current.navigation.snapshot()).toMatchObject({
    ingress: true,
    retryable: true,
  });
  await userEvent.click(
    screen.getByRole("button", { name: /^Community switcher:/ }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Switch to Fixture community" }),
  );
  expect(current.navigation.snapshot().ingress).toBe(true);
  await waitFor(() => expect(current.relay.snapshot().status).toBe("ready"));
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText("Actual recovered destination");
  expect(current.navigation.snapshot()).toMatchObject({
    status: "opened",
    entry: {
      target: {
        kind: "page",
        pluginId: "buzz.repos",
        route: { params: { type: "repo", dtag: "project" } },
      },
    },
  });
  // A link that names nothing, in the running app, shows its notice over the
  // page in place: no visit, and history is unchanged.
  const before = current.navigation.snapshot();
  await act(async () => {
    queue.push("buzz://unknown");
    ping();
  });
  await screen.findByRole("dialog", { name: "This link doesn’t work" });
  expect(current.navigation.snapshot()).toMatchObject({
    status: "opened",
    attempt: { id: before.attempt.id },
    entry: { id: before.entry.id },
    canGoForward: before.canGoForward,
  });
  expect(current.navigation.snapshot().ingress).toBeUndefined();
  expect(screen.getByText("Actual recovered destination")).toBeVisible();
  // The notice is the only failure shown: no card replaces the page.
  expect(screen.getAllByText(pageFailure)).toHaveLength(1);
  await act(async () => {
    queue.push("buzz://channel/general");
    ping();
  });
  await waitFor(() =>
    expect(current.navigation.snapshot().entry.target).toMatchObject({
      kind: "conversation",
      channelId: "general",
      scope: { viewer, communityOrigin: origin },
    }),
  );
  // The valid link clears the earlier notice.
  expect(current.rejectedLinks.snapshot()).toBeUndefined();
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "This link doesn’t work" }),
    ).not.toBeInTheDocument(),
  );
});

it.each([
  ["opens Inbox with the notice", true],
  ["shows the notice over the start page when Inbox is turned off", false],
] as const)(
  "for a malformed link that launches the app, %s",
  async (_, inbox) => {
    // The client stays loading until released, so the link is a launch link.
    let release = () => {};
    const identity = new Promise<void>((resolve) => (release = resolve));
    const { current } = bindCommunityLinks(
      origin,
      async () => ["buzz://unknown"],
      identity,
    );
    await waitFor(() => expect(current.plugins.startup()).not.toBe("loading"));
    if (!inbox)
      await act(() => current.plugins.change("disable", "buzz.inbox"));
    const before = current.navigation.snapshot();
    release();
    await screen.findByRole("dialog", { name: "This link doesn’t work" });
    if (inbox)
      await waitFor(() =>
        expect(current.navigation.snapshot()).toMatchObject({
          status: "opened",
          entry: {
            target: {
              kind: "page",
              pluginId: "buzz.inbox",
              pageId: "inbox",
              scope: { viewer, communityOrigin: origin },
            },
          },
        }),
      );
    else
      expect(current.navigation.snapshot()).toMatchObject({
        attempt: { id: before.attempt.id },
        entry: { id: before.entry.id },
        canGoForward: false,
      });
  },
);

it("opens Inbox for a malformed launch link when the catalog settles after the client", async () => {
  let release = () => {};
  catalogGate.value = new Promise<void>((resolve) => (release = resolve));
  const { current } = bindCommunityLinks(origin, async () => [
    "buzz://unknown",
  ]);
  await waitFor(() =>
    expect(current.communities.snapshot()).toMatchObject({
      status: "ready",
      selected: origin,
    }),
  );
  expect(current.plugins.startup()).toBe("loading");
  release();
  await screen.findByRole("dialog", { name: "This link doesn’t work" });
  await waitFor(() =>
    expect(current.navigation.snapshot()).toMatchObject({
      status: "opened",
      entry: {
        target: {
          kind: "page",
          pluginId: "buzz.inbox",
          pageId: "inbox",
          scope: { viewer, communityOrigin: origin },
        },
      },
    }),
  );
});

it("opens Inbox for a malformed launch link when Inbox activates last", async () => {
  let release = () => {};
  inboxGate.value = new Promise<void>((resolve) => (release = resolve));
  const { current } = bindCommunityLinks(origin, async () => [
    "buzz://unknown",
  ]);
  await waitFor(() => {
    expect(current.communities.snapshot()).toMatchObject({
      status: "ready",
      selected: origin,
    });
    expect(current.plugins.snapshot().activation).toMatchObject({
      "buzz.channels": { status: "active" },
      "buzz.inbox": { status: "starting" },
    });
  });
  expect(current.rejectedLinks.snapshot()).toBeUndefined();
  release();
  await screen.findByRole("dialog", { name: "This link doesn’t work" });
  await waitFor(() =>
    expect(current.navigation.snapshot()).toMatchObject({
      status: "opened",
      entry: {
        target: {
          kind: "page",
          pluginId: "buzz.inbox",
          pageId: "inbox",
          scope: { viewer, communityOrigin: origin },
        },
      },
    }),
  );
});

it("keeps a malformed launch link on the start page when the catalog turning Inbox off settles last", async () => {
  let release = () => {};
  catalogGate.value = new Promise<void>((resolve) => (release = resolve));
  localStorage.setItem(
    "buzzodz.plugins.v1",
    JSON.stringify({ version: 3, enabled: { "buzz.inbox": false } }),
  );
  const { current } = bindCommunityLinks(origin, async () => [
    "buzz://unknown",
  ]);
  await waitFor(() =>
    expect(current.communities.snapshot()).toMatchObject({
      status: "ready",
      selected: origin,
    }),
  );
  expect(current.plugins.startup()).toBe("loading");
  expect(current.rejectedLinks.snapshot()).toBeUndefined();
  const before = current.navigation.snapshot();
  release();
  await screen.findByRole("dialog", { name: "This link doesn’t work" });
  await waitFor(() =>
    expect(current.navigation.snapshot().status).not.toBe("opening"),
  );
  expect(current.navigation.snapshot()).toMatchObject({
    attempt: { id: before.attempt.id },
    entry: { id: before.entry.id },
    canGoForward: false,
  });
  expect(current.navigation.snapshot().status).not.toBe("failed");
  expect(current.navigation.snapshot().entry.target).not.toMatchObject({
    pluginId: "buzz.inbox",
  });
});

it("a malformed link in a running app retires an earlier link's Try again", async () => {
  const queue: string[] = [];
  const { current, ping } = bindCommunityLinks(origin, async () =>
    queue.splice(0),
  );
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  await act(async () => current.communities.select(null));
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  const before = current.navigation.snapshot();
  await act(async () => {
    queue.push("buzz://channel/general");
    ping();
  });
  await screen.findByRole("button", { name: "Try again" });
  await act(async () => {
    queue.push("buzz://unknown");
    ping();
  });
  await screen.findByRole("dialog", { name: "This link doesn’t work" });
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument(),
  );
  expect(current.navigation.snapshot()).toMatchObject({
    entry: { id: before.entry.id },
    canGoForward: before.canGoForward,
  });
  expect(current.navigation.snapshot().ingress).toBeUndefined();
});

const elsewhere = "https://elsewhere.example";
/** Live App services with community links bound to a controllable shell. */
function bindCommunityLinks(
  selected: string | null,
  take: () => Promise<readonly string[]>,
  /** Holds the identity lookup, keeping the client loading. */
  identity?: Promise<void>,
) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "Fixture", picture: "" },
      memberships: [
        { id: origin, name: "Fixture community" },
        { id: elsewhere, name: "Elsewhere" },
      ],
      selected,
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/identity")) {
        await identity;
        return Response.json({ viewer });
      }
      if (url.endsWith("/session"))
        return Response.json({ viewer, relayAuthor: viewer, relayUrl: origin });
      if (url.endsWith("/query")) return Response.json([]);
      return Response.json({});
    }),
  );
  services = createServices();
  const current = services;
  let ping = () => {};
  stop = bindDeepLinks(current.deepLinks, current.communities, {
    take,
    watch(listener) {
      ping = listener;
      return () => {};
    },
  });
  render(<App services={current} />);
  return { current, ping: () => ping() };
}

function offlineMessagesFixture() {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "Fixture", picture: "" },
      memberships: [{ id: origin, name: "Fixture community" }],
      selected: origin,
    }),
  );
  let offline = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/identity")) return Response.json({ viewer });
      if (url.endsWith("/session"))
        return offline
          ? Response.json({ error: "offline" }, { status: 503 })
          : Response.json({ viewer, relayAuthor: viewer, relayUrl: origin });
      if (url.endsWith("/query")) return Response.json([]);
      return Response.json({});
    }),
  );
  window.history.replaceState(
    null,
    "",
    `/#buzz=${encodeURIComponent(
      JSON.stringify({
        version: 1,
        kind: "page",
        pluginId: "buzz.channels",
        pageId: "channels",
        scope: { viewer, communityOrigin: origin },
      }),
    )}`,
  );
  services = createServices();
  render(<App services={services} />);
  return {
    current: services,
    online() {
      offline = false;
    },
  };
}
it("waits through a connection that retries by itself, then opens Messages without Retry", async () => {
  const { current, online } = offlineMessagesFixture();
  await waitFor(() =>
    expect(current.relay.snapshot()).toMatchObject({
      status: "error",
      retrying: true,
    }),
  );
  // The relay's own reconnect owns this wait; the visit stays pending.
  expect(current.navigation.snapshot().status).toBe("opening");
  expect(screen.queryByText(pageFailure)).toBeNull();
  online();
  await waitFor(
    () => expect(current.navigation.snapshot().status).toBe("opened"),
    { timeout: 5_000 },
  );
  expect(screen.queryByText(pageFailure)).toBeNull();
});
it("reopens a visit that timed out while connecting once the connection is live", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const { current, online } = offlineMessagesFixture();
    await waitFor(() => expect(current.relay.snapshot().status).toBe("error"));
    // The visit deadline ends the wait with an honest, recoverable card.
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(current.navigation.snapshot()).toMatchObject({
      status: "failed",
      reason: "timeout",
    });
    expect(
      await screen.findByRole("heading", { name: "Can’t connect" }),
    ).toBeVisible();
    // Messages is what failed, so the way out leads elsewhere.
    expect(screen.queryByRole("button", { name: "Go to Messages" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Try again" }).dataset.variant,
    ).toBe("prominent");
    online();
    await act(() => vi.advanceTimersByTimeAsync(31_000));
    await waitFor(() =>
      expect(current.navigation.snapshot().status).toBe("opened"),
    );
    expect(screen.queryByText(pageFailure)).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
it("does not reopen a failed visit after the user has left it", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const { current, online } = offlineMessagesFixture();
    await waitFor(() => expect(current.relay.snapshot().status).toBe("error"));
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    await screen.findByRole("heading", { name: "Can’t connect" });
    const failed = current.navigation.snapshot().entry.id;
    act(() => {
      void current.navigation.open({
        version: 1,
        kind: "settings",
        section: "appearance",
        scope: { viewer, communityOrigin: origin },
      });
    });
    await waitFor(() =>
      expect(current.navigation.snapshot().entry.id).not.toBe(failed),
    );
    const left = current.navigation.snapshot().entry.id;
    online();
    await act(() => vi.advanceTimersByTimeAsync(31_000));
    await waitFor(() => expect(current.relay.snapshot().status).toBe("ready"));
    expect(current.navigation.snapshot().entry.id).toBe(left);
    expect(current.navigation.snapshot().entry.target.kind).toBe("settings");
  } finally {
    vi.useRealTimers();
  }
});
it("keeps Messages on screen when only the linked message fails to open", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "Fixture", picture: "" },
      memberships: [{ id: origin, name: "Fixture community" }],
      selected: origin,
    }),
  );
  const author = { secret: key, pubkey: viewer };
  const events = [
    roster(author, "alpha", [viewer]),
    metadata(author, "alpha", "Alpha"),
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/identity")) return Response.json({ viewer });
      if (url.endsWith("/session"))
        return Response.json({ viewer, relayAuthor: viewer, relayUrl: origin });
      if (url.endsWith("/query")) {
        const filters = JSON.parse(String(options?.body)) as ReadFilter[];
        return Response.json(
          events.filter((event) =>
            filters.some((filter) => matchesEvent(event, filter)),
          ),
        );
      }
      return Response.json({});
    }),
  );
  window.history.replaceState(
    null,
    "",
    `/#buzz=${encodeURIComponent(
      JSON.stringify({
        version: 1,
        kind: "conversation",
        scope: { viewer, communityOrigin: origin },
        channelId: "alpha",
        messageId: "e".repeat(64),
      }),
    )}`,
  );
  services = createServices();
  const current = services;
  render(<App services={current} />);
  await waitFor(() =>
    expect(current.navigation.snapshot()).toMatchObject({
      status: "failed",
      presented: true,
    }),
  );
  // The failure stays beside the message; the conversation stays usable.
  expect(
    await screen.findByText("This message isn’t available."),
  ).toBeVisible();
  expect(screen.getByRole("region", { name: "Channels" })).toBeVisible();
  expect(screen.queryByText(pageFailure)).toBeNull();
});
it("keeps a failed message read in place until its own Retry succeeds", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "Fixture", picture: "" },
      memberships: [{ id: origin, name: "Fixture community" }],
      selected: origin,
    }),
  );
  const author = { secret: key, pubkey: viewer };
  const channel = [
    roster(author, "alpha", [viewer]),
    metadata(author, "alpha", "Alpha"),
  ];
  const history = [
    message(author, "alpha", "Back again", 1_700_000_100),
    bounds(author, "alpha", "head", { has_more: false, next_cursor: null }),
  ];
  // Two failed history reads within one live connection, then recovery.
  let failures = 2;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/identity")) return Response.json({ viewer });
      if (url.endsWith("/session"))
        return Response.json({ viewer, relayAuthor: viewer, relayUrl: origin });
      if (url.endsWith("/query")) {
        const filters = JSON.parse(String(options?.body)) as ReadFilter[];
        if (filters.some((filter) => filter.kinds?.includes(9))) {
          if (failures > 0) {
            failures--;
            return Response.json({ error: "offline" }, { status: 503 });
          }
          return Response.json(history);
        }
        return Response.json(
          channel.filter((event) =>
            filters.some((filter) => matchesEvent(event, filter)),
          ),
        );
      }
      return Response.json({});
    }),
  );
  window.history.replaceState(
    null,
    "",
    `/#buzz=${encodeURIComponent(
      JSON.stringify({
        version: 1,
        kind: "conversation",
        scope: { viewer, communityOrigin: origin },
        channelId: "alpha",
      }),
    )}`,
  );
  services = createServices();
  const current = services;
  render(<App services={current} />);
  await waitFor(() =>
    expect(current.navigation.snapshot()).toMatchObject({
      status: "failed",
      presented: true,
    }),
  );
  const generation = current.relay.snapshot().generation;
  expect(screen.queryByText(pageFailure)).toBeNull();
  // The page keeps its visit's authority, so the timeline's own Retry works.
  expect(current.navigation.snapshot().attempt.signal.aborted).toBe(false);
  const timeline = () =>
    document.querySelector('[data-channel-timeline="alpha"]');
  while (!timeline()) {
    await userEvent.click(
      await screen.findByRole("button", { name: "Retry messages" }),
    );
    await waitFor(() =>
      expect(
        timeline() ?? screen.queryByRole("button", { name: "Retry messages" }),
      ).not.toBeNull(),
    );
  }
  // Rows need real layout to paint; the recovered window is the observable here.
  expect(
    current.relay
      .snapshot()
      .session.channels.window("alpha")
      .rows.map((row) => row.content),
  ).toEqual(["Back again"]);
  expect(screen.queryByRole("button", { name: "Retry messages" })).toBeNull();
  expect(current.navigation.snapshot().attempt.signal.aborted).toBe(false);
  expect(failures).toBe(0);
  expect(current.relay.snapshot().generation).toBe(generation);
  expect(screen.queryByText(pageFailure)).toBeNull();
});
it("offers to join a code-less link's community, or opens it once joined", async () => {
  const queue = [
    "buzz://add-community?relay=wss%3A%2F%2Fother.example%2F&name=other",
  ];
  const { current, ping } = bindCommunityLinks(null, async () =>
    queue.splice(0),
  );
  expect(await screen.findByLabelText("Community URL")).toHaveValue(
    "https://other.example",
  );
  await act(async () => {
    queue.push("buzz://connect?relay=wss%3A%2F%2Fcommunity.example");
    ping();
  });
  await waitFor(() =>
    expect(current.navigation.snapshot()).toMatchObject({
      status: "opened",
      entry: {
        target: {
          kind: "page",
          pluginId: "buzz.channels",
          scope: { viewer, communityOrigin: origin },
        },
      },
    }),
  );
  expect(current.communities.snapshot().selected).toBe(origin);
  // The latest link replaces the unjoined community's dialog.
  expect(current.invites.snapshot()).toBeUndefined();
  await waitFor(() =>
    expect(screen.queryByLabelText("Community URL")).not.toBeInTheDocument(),
  );
});

it("keeps a link read while a code-less link switches communities", async () => {
  const reads: ((urls: readonly string[]) => void)[] = [];
  const { current, ping } = bindCommunityLinks(
    elsewhere,
    () => new Promise((resolve) => reads.push(resolve)),
  );
  await waitFor(() => expect(reads).toHaveLength(1));
  await waitFor(() =>
    expect(current.communities.snapshot().status).toBe("ready"),
  );
  // A second link arrives while the first read is pending.
  ping();
  await act(async () =>
    reads[0]?.(["buzz://connect?relay=wss%3A%2F%2Fcommunity.example"]),
  );
  await waitFor(() => expect(reads).toHaveLength(2));
  await waitFor(() =>
    expect(current.communities.snapshot().selected).toBe(origin),
  );
  await act(async () =>
    reads[1]?.(["buzz://add-community?relay=wss%3A%2F%2Fother.example"]),
  );
  expect(await screen.findByLabelText("Community URL")).toHaveValue(
    "https://other.example",
  );
});

it("lists active primary pages in the app dock", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // jsdom lacks scrollIntoView; the search palette scrolls its selection.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  // Personal space with a saved community, not the first-run join screen.
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "Fixture", picture: "" },
      memberships: [{ id: origin, name: "Fixture community" }],
      selected: null,
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/identity")) return Response.json({ viewer });
      if (url.endsWith("/query")) return Response.json([]);
      return Response.json({});
    }),
  );
  services = createServices();
  const current = services;
  render(<App services={current} />);
  await screen.findByRole("tab", { name: "Activity" });
  expect(screen.getByRole("tab", { name: "Bestie" })).toBeInTheDocument();

  expect(
    screen.queryByRole("tab", { name: "Repository" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Agents" })).toBeInTheDocument();

  // The fixture page is active and searchable but never a sidebar row.
  expect(current.pages.snapshot().map((page) => page.key)).toContain(
    "fixture.notes/notes",
  );

  // The Attention tab is on by default, and attention keeps running without it.
  // Bestie adds its own tabs beside it.
  const providers = () =>
    current.agents.attentionProviders().map(({ provider }) => provider);
  const tabs = () =>
    current.agents
      .addedTabs()
      .map((tab) => tab.key)
      .sort();
  await waitFor(() =>
    expect(tabs()).toEqual([
      "buzz.bestie/bestie",
      "buzz.bestie/former-bestie",
      "buzz.watching/watching",
    ]),
  );
  await act(() => current.plugins.change("disable", "buzz.watching"));
  await waitFor(() =>
    expect(tabs()).toEqual(["buzz.bestie/bestie", "buzz.bestie/former-bestie"]),
  );
  expect(providers()).toContain("attention/command");
  await act(() => current.plugins.change("enable", "buzz.watching"));
  await waitFor(() =>
    expect(tabs()).toEqual([
      "buzz.bestie/bestie",
      "buzz.bestie/former-bestie",
      "buzz.watching/watching",
    ]),
  );

  await act(() => current.plugins.change("disable", "buzz.agents"));
  expect(screen.getByRole("tab", { name: "Activity" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Bestie" })).toBeInTheDocument();

  expect(screen.queryByRole("tab", { name: "Agents" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Search Buzz" }));
  const search = await screen.findByRole("dialog", { name: "Search Buzz" });
  expect(
    within(search).queryByRole("option", { name: "Fixture notes" }),
  ).not.toBeInTheDocument();
  await userEvent.type(
    within(search).getByRole("combobox", { name: "Search Buzz" }),
    "Fixture notes",
  );
  expect(
    within(search).getByRole("option", { name: "Fixture notes" }),
  ).toBeInTheDocument();
  expect(
    within(search).queryByRole("option", { name: "Agents" }),
  ).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");

  // Disabling optional pages removes their dock entries without hiding Messages.
  for (const id of ["buzz.inbox", "buzz.bestie", "buzz.repos"])
    await act(() => current.plugins.change("disable", id));
  expect(
    screen.queryByRole("tab", { name: "Activity" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: "Bestie" })).not.toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Messages" })).toBeInTheDocument();
  expect(
    screen.getByRole("complementary", { name: "Sidebar" }),
  ).toBeInTheDocument();
});

function legacyPageFixture(
  memberships = [{ id: origin, name: "Fixture community" }],
  selected = origin,
) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "Fixture", picture: "" },
      memberships,
      selected,
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/identity")) return Response.json({ viewer });
      if (url.endsWith("/session"))
        return Response.json({ viewer, relayAuthor: viewer, relayUrl: origin });
      if (url.endsWith("/query")) return Response.json([]);
      return Response.json({});
    }),
  );
  const current = createServices();
  services = current;
  render(<App services={current} />);
  return current;
}

it.each(
  ["Inbox", "Bestie"].flatMap((name) => [
    { name, scope: undefined },
    { name, scope: null },
    { name, scope: { viewer, communityOrigin: origin } },
  ]),
)(
  "normalizes old $name links in the same visit and caller, retaining $scope scope",
  async ({ name, scope }) => {
    const current = legacyPageFixture();
    await screen.findByRole("tab", { name: "Activity" });
    const pageId = name.toLowerCase();

    act(() => {
      void current.navigation.open({
        version: 1,
        kind: "settings",
        section: "appearance",
      });
    });
    await waitFor(() =>
      expect(current.navigation.snapshot().status).toBe("opened"),
    );
    const previous = current.navigation.snapshot().entry.id;
    const old: OpenTarget = {
      version: 1,
      kind: "page",
      pluginId: "buzz.channels",
      pageId: "channels",
      route: { version: 1, params: name },
      ...(scope !== undefined ? { scope } : {}),
    };
    const bound = parseOpenTarget(old);
    let visit = "";
    let result!: ReturnType<typeof current.navigation.open>;
    act(() => {
      result = current.navigation.open(bound);
      visit = current.navigation.snapshot().entry.id;
    });
    await waitFor(() =>
      expect(current.navigation.snapshot().status).toBe("opened"),
    );
    expect(await result).toEqual({ status: "opened" });
    expect(current.navigation.snapshot().entry).toEqual({
      id: visit,
      target: {
        version: 1,
        kind: "page",
        pluginId: `buzz.${pageId}`,
        pageId,
        ...(scope !== undefined ? { scope } : {}),
      },
    });
    expect(current.communities.snapshot().selected).toBe(
      scope === null ? null : origin,
    );
    act(() => current.navigation.back());
    await waitFor(() =>
      expect(current.navigation.snapshot().entry.id).toBe(previous),
    );
    act(() => current.navigation.forward());
    await waitFor(() => {
      expect(current.navigation.snapshot().entry.id).toBe(visit);
      expect(current.navigation.snapshot().status).toBe("opened");
    });
  },
);

// Reminder notifications without an openable message send a page target scoped
// to the reminder's community; it must win over the community selected at click.
it("opens a community-scoped page from another community, but not after leaving it", async () => {
  const other = "https://other.example";
  const target = parseOpenTarget({
    version: 1,
    kind: "page",
    pluginId: "fixture.notes",
    pageId: "notes",
    scope: { viewer, communityOrigin: origin },
  });
  const member = legacyPageFixture(
    [
      { id: origin, name: "Fixture community" },
      { id: other, name: "Other community" },
    ],
    other,
  );
  await screen.findByRole("tab", { name: "Activity" });
  let result!: ReturnType<typeof member.navigation.open>;
  act(() => {
    result = member.navigation.open(target);
  });
  expect(await result).toEqual({ status: "opened" });
  expect(member.communities.snapshot().selected).toBe(origin);
  expect(member.navigation.snapshot().entry.target).toEqual(target);
  cleanup();
  await services?.dispose();
  localStorage.clear();

  const left = legacyPageFixture(
    [{ id: other, name: "Other community" }],
    other,
  );
  await screen.findByRole("tab", { name: "Activity" });
  act(() => {
    result = left.navigation.open(target);
  });
  expect(await result).toEqual({ status: "failed", reason: "denied" });
  expect(left.communities.snapshot().selected).toBe(other);
});

it("restores legacy placeholder history but does not normalize unknown versions or bypass access and plugin gates", async () => {
  const old: OpenTarget = {
    version: 1,
    kind: "page",
    pluginId: "buzz.channels",
    pageId: "channels",
    route: { version: 1, params: "Inbox" },
  };
  window.history.replaceState(
    null,
    "",
    `/#buzz=${encodeURIComponent(JSON.stringify(old))}`,
  );
  const current = legacyPageFixture();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  expect(current.navigation.snapshot().entry.target).toMatchObject({
    pluginId: "buzz.inbox",
    pageId: "inbox",
  });
  for (const target of [
    { ...old, route: { version: 2, params: "Inbox" } },
    { ...old, route: { version: 1, params: "Unknown" } },
    { ...old, scope: { viewer: "ab".repeat(32), communityOrigin: origin } },
  ]) {
    let result!: ReturnType<typeof current.navigation.open>;
    act(() => {
      result = current.navigation.open(target);
    });
    await waitFor(() =>
      expect(current.navigation.snapshot().status).toBe("failed"),
    );
    expect(await result).toMatchObject({ status: "failed" });
  }
  await act(() => current.plugins.change("disable", "buzz.inbox"));
  let result!: ReturnType<typeof current.navigation.open>;
  act(() => {
    result = current.navigation.open(old);
  });
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("failed"),
  );
  expect(await result).toEqual({ status: "failed", reason: "unavailable" });
});

it("cold Settings Close uses required Messages when Inbox is disabled", async () => {
  window.history.replaceState(
    null,
    "",
    `/#buzz=${encodeURIComponent(
      JSON.stringify({
        version: 1,
        kind: "settings",
        section: "appearance",
      }),
    )}`,
  );
  const current = legacyPageFixture();
  const back = await screen.findByRole("button", { name: "Close Settings" });
  await act(() => current.plugins.change("disable", "buzz.inbox"));
  expect(
    current.pages.snapshot().some((page) => page.key === "buzz.inbox/inbox"),
  ).toBe(false);
  await userEvent.click(back);
  await waitFor(() =>
    expect(current.navigation.snapshot()).toMatchObject({
      status: "opened",
      entry: {
        target: { kind: "page", pluginId: "buzz.channels", pageId: "channels" },
      },
    }),
  );
  expect(screen.queryByText(pageFailure)).not.toBeInTheDocument();
});

it("Close returns to the immediately preceding failed destination, not an older retained workspace", async () => {
  const current = legacyPageFixture();
  await screen.findByRole("tab", { name: "Activity" });
  await act(async () => {
    void current.navigation.open({
      version: 1,
      kind: "page",
      pluginId: "fixture.notes",
      pageId: "notes",
    });
  });
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  const failed: OpenTarget = {
    version: 1,
    kind: "page",
    pluginId: "fixture.missing",
    pageId: "missing",
  };
  await act(async () => {
    void current.navigation.open(failed);
  });
  await screen.findByText(pageFailure);
  const visit = current.navigation.snapshot().entry.id;
  await act(async () => {
    void current.navigation.open({
      version: 1,
      kind: "settings",
      section: "appearance",
    });
  });
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  await userEvent.click(
    within(settings).getByRole("button", { name: "Close Settings" }),
  );
  await waitFor(() =>
    expect(current.navigation.snapshot().entry).toEqual({
      id: visit,
      target: failed,
    }),
  );
});

/** The card for Activity turned off, with its copy and actions. */
async function activityTurnedOff() {
  const card = (
    await screen.findByRole("heading", { name: "Activity is turned off" })
  ).closest<HTMLElement>('[role="alert"]');
  if (!card) throw new Error("Expected the failure alert");
  expect(
    within(card).getByText("Turn it on in Manage plugins to open this page."),
  ).toBeVisible();
  expect(
    within(card)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Manage plugins", "Go to Messages"]);
  return card;
}

/** Turns Activity off while it's open, then goes to Messages and Back. */
async function backOntoTurnedOffActivity() {
  const current = legacyPageFixture();
  await userEvent.click(await screen.findByRole("tab", { name: "Activity" }));
  await waitFor(() =>
    expect(current.navigation.snapshot()).toMatchObject({
      status: "opened",
      entry: { target: { kind: "page", pluginId: "buzz.inbox" } },
    }),
  );
  const visit = current.navigation.snapshot().entry.id;
  await act(() => current.plugins.change("disable", "buzz.inbox"));
  await userEvent.click(
    within(await activityTurnedOff()).getByRole("button", {
      name: "Go to Messages",
    }),
  );
  await waitFor(() =>
    expect(current.navigation.snapshot()).toMatchObject({
      status: "opened",
      entry: { target: { kind: "page", pluginId: "buzz.channels" } },
    }),
  );
  act(() => current.navigation.back());
  const card = await activityTurnedOff();
  expect(current.navigation.snapshot()).toMatchObject({
    status: "failed",
    reason: "unavailable",
    entry: { id: visit },
  });
  return { current, visit, card };
}

it("says when the open page's plugin is turned off, again after Back, and its Manage plugins opens that plugin and returns to the page", async () => {
  const { current, visit, card } = await backOntoTurnedOffActivity();

  await userEvent.click(
    within(card).getByRole("button", { name: "Manage plugins" }),
  );
  await waitFor(() =>
    expect(current.navigation.snapshot().entry.target).toEqual({
      version: 1,
      kind: "settings",
      section: "plugins",
      pluginId: "buzz.inbox",
      scope: { viewer, communityOrigin: origin },
    }),
  );
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  await userEvent.click(
    await within(settings).findByRole("button", { name: "Enable" }),
  );
  await waitFor(() =>
    expect(
      current.pages.snapshot().some((page) => page.key === "buzz.inbox/inbox"),
    ).toBe(true),
  );
  await userEvent.click(
    within(settings).getByRole("button", { name: "Close Settings" }),
  );
  await waitFor(() =>
    expect(current.navigation.snapshot()).toMatchObject({
      status: "opened",
      entry: { id: visit, target: { kind: "page", pluginId: "buzz.inbox" } },
    }),
  );
  expect(current.navigation.snapshot().reason).toBeUndefined();
  expect(screen.queryByText(pageFailure)).not.toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Activity is turned off" }),
  ).not.toBeInTheDocument();
});

// The failed visit doesn't retry by itself; Try again opens it.
it("turning a plugin back on over its failed page offers Try again, which opens the page", async () => {
  const { current, visit } = await backOntoTurnedOffActivity();

  // As ⌘K's switch does.
  await act(() => current.plugins.change("enable", "buzz.inbox"));
  const card = (
    await screen.findByRole("heading", { name: "This page isn’t available" })
  ).closest<HTMLElement>('[role="alert"]');
  if (!card) throw new Error("Expected the failure alert");
  expect(
    within(card).getByText("It didn’t load this time. Try again in a moment."),
  ).toBeVisible();
  expect(
    within(card)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Try again", "Go to Messages"]);
  expect(
    screen.queryByRole("heading", { name: "Activity is turned off" }),
  ).not.toBeInTheDocument();

  await userEvent.click(
    within(card).getByRole("button", { name: "Try again" }),
  );
  await waitFor(() =>
    expect(current.navigation.snapshot()).toMatchObject({
      status: "opened",
      entry: { id: visit, target: { kind: "page", pluginId: "buzz.inbox" } },
    }),
  );
  expect(current.navigation.snapshot().reason).toBeUndefined();
  expect(screen.queryByText(pageFailure)).not.toBeInTheDocument();
});

// Paused external plugins can't start this launch, so Enable wouldn't help.
it("keeps the unavailable card for a turned-off external plugin while external plugins are paused", async () => {
  catalogGate.edit = (result) =>
    result.status === "ready"
      ? {
          ...result,
          externalPluginsPaused: true,
          catalog: {
            ...result.catalog,
            plugins: result.catalog.plugins.map((plugin) =>
              plugin.manifest.id === "fixture.notes"
                ? { ...plugin, source: "external", enabled: false }
                : plugin,
            ),
          },
        }
      : result;
  const current = legacyPageFixture();
  await screen.findByRole("tab", { name: "Activity" });
  expect(current.plugins.snapshot().configuration).toMatchObject({
    status: "ready",
    externalPluginsPaused: true,
  });
  act(() => {
    void current.navigation.open({
      version: 1,
      kind: "page",
      pluginId: "fixture.notes",
      pageId: "notes",
    });
  });
  const card = (
    await screen.findByRole("heading", { name: "This page isn’t available" })
  ).closest<HTMLElement>('[role="alert"]');
  if (!card) throw new Error("Expected the failure alert");
  expect(
    within(card).getByText(
      "It may have been removed, or you may need to update Buzz.",
    ),
  ).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "Notes is turned off" }),
  ).not.toBeInTheDocument();
  expect(current.navigation.snapshot()).toMatchObject({
    status: "failed",
    reason: "unavailable",
  });
});
