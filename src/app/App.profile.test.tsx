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
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { StrictMode } from "react";
import { App } from "./App";
import { createServices, type AppServices } from "./services";
import { matchesEvent } from "../features/relay/projection";
import type { ReadFilter, RelayEvent } from "../features/relay/events";
import { metadata, roster } from "../features/relay/testing";
import type { ComposerInputElement } from "../features/messages/composer-dom";
import { composerDOMFixture } from "../features/messages/composer-testing";
import * as communityApi from "../features/communities/api";
import { communityDestination } from "../features/communities/destination";
import { readView, writeView } from "../shared/view-state";
import { sidebarFixtureState } from "./sidebar-plugin.fixture";

/** Any variant of the App-owned "page couldn't open" card. */
const pageFailure =
  /^(This page isn’t available|Can’t connect|You don’t have access to this|This link doesn’t work)$/;

composerDOMFixture();

// jsdom has no IndexedDB; this flow keeps its message unsent.
vi.mock("../features/relay/outbox-storage", () => ({
  browserOutboxStorage: () => ({ load: () => [], save: () => {} }),
}));
vi.mock("../bundled", async () => {
  const profiles = await import("../bundled/profiles");
  const { Input } = await import("../shared/design-system/ui/Input");
  return {
    bundledPlugins: [
      {
        manifest: { id: "buzz.channels", name: "Channels", apiVersion: 1 },
        module: await import("../bundled/channels"),
      },
      {
        manifest: { id: "buzz.repos", name: "Repositories", apiVersion: 1 },
        module: await import("../bundled/repos"),
      },
      {
        manifest: {
          id: "test.sidebar",
          name: "Sidebar fixture",
          apiVersion: 1,
        },
        module: await import("./sidebar-plugin.fixture"),
      },
      {
        manifest: { id: "buzz.profiles", name: "Profiles", apiVersion: 1 },
        module: {
          ...profiles,
          apply(ctx) {
            profiles.apply(ctx);
            ctx.panels.register({
              id: "draft-companion",
              title: "Draft companion",
              matches: (target) => target === "fixture:companion",
              launcher: { icon: "/buzz-mark.svg", target: "fixture:companion" },
              component: () => <Input aria-label="Companion note" />,
            });
          },
        } satisfies import("../plugins/api").PluginModule,
      },
    ],
  };
});
const key = new Uint8Array(32).fill(6),
  viewer = getPublicKey(key),
  origin = "https://community.example";
const channelId = "11111111-1111-4111-8111-111111111111";
const channelEvents = [
  metadata({ secret: key, pubkey: viewer }, channelId, "Planning"),
  roster({ secret: key, pubkey: viewer }, channelId, [viewer]),
];
const profile = finalizeEvent(
  {
    kind: 0,
    created_at: 1,
    content: JSON.stringify({ name: "Community name" }),
    tags: [],
  },
  key,
);
const recipient = finalizeEvent(
  {
    kind: 0,
    created_at: 1,
    content: JSON.stringify({ name: "Draft recipient" }),
    tags: [],
  },
  new Uint8Array(32).fill(7),
);
let services: AppServices | undefined;
afterEach(async () => {
  cleanup();
  await services?.dispose();
  services = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  localStorage.clear();
  sidebarFixtureState.broken = true;
  sidebarFixtureState.onTarget = undefined;
  window.history.replaceState(null, "", "/");
});

async function setup(
  connectionError = false,
  muteWrite?: (intent: {
    channelId: string;
    muted: boolean;
  }) => Promise<Response>,
) {
  // jsdom has no media queries; responsive shell geometry is covered in browsers.
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.parentElement;
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        // Supply row and viewport sizes; real scrolling is covered in browsers.
        queueMicrotask(() =>
          this.callback(
            [
              {
                target,
                contentRect: {
                  width: 400,
                  height: target.getAttribute("role") === "listbox" ? 400 : 40,
                },
              } as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
          ),
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "Local name", picture: "" },
      memberships: [{ id: origin, name: "Fixture community" }],
      selected: origin,
    }),
  );
  const events: RelayEvent[] = [profile, recipient];
  if (muteWrite) events.push(...channelEvents);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/identity")) return Response.json({ viewer });
      if (url.endsWith("/session")) {
        if (connectionError) return new Response(null, { status: 502 });
        return Response.json({
          viewer,
          relayAuthor: viewer,
          relayUrl: origin,
          writeKinds: [9],
          directMessages: true,
          sidebarPreferences: !!muteWrite,
          sidebarMuteWrites: !!muteWrite,
        });
      }
      if (url.endsWith("/sidebar-preferences"))
        return Response.json({
          sections: [],
          assignments: {},
          starred: [],
          muted: [],
        });
      if (url.endsWith("/sidebar-mute") && muteWrite)
        return muteWrite(JSON.parse(String(options?.body)));
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
  const user = userEvent.setup();
  services = createServices();
  const current = services;
  render(
    <StrictMode>
      <App services={current} />
    </StrictMode>,
  );
  await waitFor(() =>
    expect(current.relay.snapshot().status).toBe(
      connectionError ? "error" : "ready",
    ),
  );
  return user;
}

async function openSidebarPage(pageId: string, params?: string) {
  await act(async () => {
    await services?.navigation.open({
      version: 1,
      kind: "page",
      pluginId: "test.sidebar",
      pageId,
      ...(params === undefined ? {} : { route: { version: 1, params } }),
    });
  });
}

it("updates an owned page sidebar target without remounting its healthy draft", async () => {
  await setup();
  await openSidebarPage("main", "first");
  expect(await screen.findByText("Beacon page content")).toBeVisible();
  expect(
    screen.getByRole("complementary", { name: "Beacon sidebar" }),
  ).toHaveTextContent("main:first");
  const sidebarDraft = screen.getByRole("textbox", { name: "Sidebar draft" });
  fireEvent.change(sidebarDraft, { target: { value: "keep this draft" } });
  expect(
    within(
      screen.getByRole("complementary", { name: "Beacon sidebar" }),
    ).getByRole("navigation", { name: "Pages" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Hide sidebar" })).toBeVisible();

  await openSidebarPage("main", "second");
  expect(
    await within(
      screen.getByRole("complementary", { name: "Beacon sidebar" }),
    ).findByText("main:second"),
  ).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Sidebar draft" })).toHaveValue(
    "keep this draft",
  );
  expect(screen.getByRole("textbox", { name: "Sidebar draft" })).toBe(
    sidebarDraft,
  );
});

it("retains an owned page sidebar and its draft through Settings sections and Close", async () => {
  const user = await setup();
  await openSidebarPage("main", "first");
  const sidebarDraft = await screen.findByRole("textbox", {
    name: "Sidebar draft",
  });
  fireEvent.change(sidebarDraft, { target: { value: "keep this draft" } });

  if (!services) throw new Error("Missing services");
  const current = services;
  await act(async () => {
    void current.navigation.open({
      version: 1,
      kind: "settings",
      section: "appearance",
    });
  });
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  expect(sidebarDraft).toBeInTheDocument();
  expect(sidebarDraft).toHaveValue("keep this draft");
  // A section button opens its section with the selected community's scope
  // (openSettingsSection in App.tsx). Make that same navigation here; clicking
  // the buttons is covered by the unsent-conversation journey below.
  const { viewer, selected } = current.communities.snapshot();
  if (!viewer || !selected) throw new Error("Missing selected community");
  await act(async () => {
    void current.navigation.open({
      version: 1,
      kind: "settings",
      section: "notifications",
      scope: { viewer, communityOrigin: communityDestination(selected).url },
    });
  });
  await within(settings).findByRole("heading", { name: "Notifications" });
  expect(sidebarDraft).toBeInTheDocument();
  await user.click(
    within(settings).getByRole("button", { name: "Close Settings" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull(),
  );
  expect(screen.getByRole("textbox", { name: "Sidebar draft" })).toBe(
    sidebarDraft,
  );
  expect(sidebarDraft).toHaveValue("keep this draft");
});

it("isolates a sidebar failure and recovers it on target change before restoring the default sidebar", async () => {
  await setup();
  await openSidebarPage("main", "first");
  await screen.findByRole("textbox", { name: "Sidebar draft" });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await openSidebarPage("main", "broken-sidebar");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This page’s sidebar is unavailable.",
    );
    expect(screen.getByText("Beacon page content")).toBeVisible();
    expect(screen.getByRole("button", { name: "Your profile" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "Pages" })).toBeVisible();

    await openSidebarPage("main", "recovered");
    expect(
      await screen.findByRole("complementary", { name: "Beacon sidebar" }),
    ).toHaveTextContent("main:recovered");

    await openSidebarPage("plain");
    expect(await screen.findByText("Plain page content")).toBeVisible();
    expect(
      screen.queryByRole("complementary", { name: "Sidebar" }),
    ).not.toBeInTheDocument();
  } finally {
    error.mockRestore();
  }
});

it("recovers a failed sidebar registration after disabling and re-enabling its plugin", async () => {
  await setup();
  await openSidebarPage("plain");
  await screen.findByText("Plain page content");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await openSidebarPage("broken");
    expect(await screen.findByText("Broken Beacon page content")).toBeVisible();
    const fallback = screen.getByRole("complementary", {
      name: "Broken Beacon sidebar",
    });
    expect(fallback).toContainElement(within(fallback).getByRole("alert"));
    expect(
      within(fallback).getByRole("navigation", { name: "Pages" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Hide sidebar" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Your profile" })).toBeVisible();

    await act(async () => {
      await services?.plugins.change("disable", "test.sidebar");
    });
    sidebarFixtureState.broken = false;
    await act(async () => {
      await services?.plugins.change("enable", "test.sidebar");
    });
    expect(
      await screen.findByRole("complementary", {
        name: "Recovered Beacon sidebar",
      }),
    ).toBeVisible();
    expect(screen.getByText("Broken Beacon page content")).toBeVisible();
  } finally {
    error.mockRestore();
  }
});

it("shares its resizable width between a page sidebar and Messages, including the fallback", async () => {
  await setup();
  const appServices = services;
  if (!appServices) throw new Error("Expected app services after setup");
  const scope =
    appServices.communities.relay.snapshot().scope ?? "disconnected";
  act(() => writeView(scope, "channel-sidebar", { width: 344 }));
  const sidebarColumn = () =>
    screen.getByRole("separator", { name: "Resize sidebar" })
      .previousElementSibling as HTMLElement;

  await openSidebarPage("main", "first");
  expect(await screen.findByText("Beacon page content")).toBeVisible();
  expect(sidebarColumn()).toHaveStyle({ width: "344px" });
  fireEvent.keyDown(screen.getByRole("separator", { name: "Resize sidebar" }), {
    key: "End",
  });
  expect(sidebarColumn()).toHaveStyle({ width: "520px" });
  expect(readView(scope, "channel-sidebar", null)).toMatchObject({
    width: 520,
  });

  await act(async () => {
    await appServices.navigation.open({
      version: 1,
      kind: "page",
      pluginId: "buzz.channels",
      pageId: "channels",
    });
  });
  expect(
    await screen.findByRole("complementary", { name: "Sidebar" }),
  ).toBeVisible();
  expect(sidebarColumn()).toHaveStyle({ width: "520px" });
  fireEvent.keyDown(screen.getByRole("separator", { name: "Resize sidebar" }), {
    key: "Home",
  });
  expect(sidebarColumn()).toHaveStyle({ width: "220px" });
  expect(readView(scope, "channel-sidebar", null)).toMatchObject({
    width: 220,
  });

  await openSidebarPage("main", "second");
  expect(
    await within(
      screen.getByRole("complementary", { name: "Beacon sidebar" }),
    ).findByText("main:second"),
  ).toBeVisible();
  expect(sidebarColumn()).toHaveStyle({ width: "220px" });

  await openSidebarPage("main", "broken-sidebar");
  expect(
    await screen.findByText("This page’s sidebar is unavailable."),
  ).toBeVisible();
  expect(sidebarColumn()).toHaveStyle({ width: "220px" });
  fireEvent.keyDown(screen.getByRole("separator", { name: "Resize sidebar" }), {
    key: "End",
  });
  expect(sidebarColumn()).toHaveStyle({ width: "520px" });
});

it.each([
  { when: "before leaving", action: "Dismiss", from: "Messages" },
  { when: "while away", action: "Retry", from: "Messages" },
  { when: "while away", action: "Retry", from: "the contributed page" },
  { when: "while away", action: "Dismiss", from: "the contributed page" },
] as const)(
  "keeps mute recovery when saving rejects $when, then $action from $from",
  async ({ when, action, from }) => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const write = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValue(
        Response.json({
          version: 1,
          channels: { [channelId]: { muted: true, updatedAt: 1 } },
        }),
      );
    const user = await setup(false, write);
    try {
      const sidebar = await screen.findByRole("complementary", {
        name: "Sidebar",
      });
      const row = await within(sidebar).findByRole("button", {
        name: "Planning",
      });
      fireEvent.keyDown(row, { key: "ContextMenu" });
      await user.click(await screen.findByRole("menuitem", { name: "Mute" }));
      await waitFor(() =>
        expect(write).toHaveBeenCalledExactlyOnceWith({
          channelId,
          muted: true,
        }),
      );
      const fail = async () => {
        await act(async () => {
          release(Response.json({ error: "relay offline" }, { status: 503 }));
        });
      };
      if (when === "before leaving") {
        await fail();
        await screen.findByRole("dialog", { name: "Couldn’t mute Planning" });
      }
      await openSidebarPage("main", "mute-recovery");
      const contributed = await screen.findByRole("complementary", {
        name: "Beacon sidebar",
      });
      expect(row).not.toBeInTheDocument();
      if (from === "the contributed page") {
        // jsdom lacks the native focus fallback after the focused row unmounts.
        await user.click(
          within(contributed).getByRole("textbox", { name: "Sidebar draft" }),
        );
      }
      if (when === "while away") await fail();
      if (when === "before leaving") {
        expect(
          screen.getByRole("dialog", { name: "Couldn’t mute Planning" }),
        ).toHaveTextContent("Relay request failed (503)");
      }
      const returnToMessages = async (muted = false) => {
        await act(async () => {
          await services?.navigation.open({
            version: 1,
            kind: "page",
            pluginId: "buzz.channels",
            pageId: "channels",
          });
        });
        const sidebar = await screen.findByRole("complementary", {
          name: "Sidebar",
        });
        return within(sidebar).findByRole("button", {
          name: muted ? /^Planning\s*Muted$/ : "Planning",
        });
      };
      const returnedRow =
        from === "Messages" ? await returnToMessages() : undefined;
      const notice = await screen.findByRole("dialog", {
        name: "Couldn’t mute Planning",
      });
      expect(notice).toHaveTextContent("Relay request failed (503)");
      expect(
        within(notice).getByRole("button", { name: "Retry" }),
      ).toBeVisible();
      if (action === "Dismiss") {
        await user.click(
          within(notice).getByRole("button", { name: "Dismiss" }),
        );
        expect(write).toHaveBeenCalledOnce();
      } else {
        await user.click(within(notice).getByRole("button", { name: "Retry" }));
        await waitFor(() =>
          expect(
            services?.relay.snapshot().session.sidebarPreferences.snapshot()
              .data?.muted,
          ).toEqual([channelId]),
        );
        expect(write).toHaveBeenCalledTimes(2);
        expect(write).toHaveBeenLastCalledWith({ channelId, muted: true });
      }
      if (returnedRow) expect(returnedRow).toHaveFocus();
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "Couldn’t mute Planning" }),
        ).toBeNull(),
      );
      if (from === "the contributed page") {
        expect(
          screen.getByRole("complementary", { name: "Beacon sidebar" }),
        ).toBeVisible();
        expect(screen.getByText("Beacon page content")).toBeVisible();
        await returnToMessages(action === "Retry");
        expect(
          screen.queryByRole("dialog", { name: "Couldn’t mute Planning" }),
        ).toBeNull();
      }
    } finally {
      release(Response.json({ error: "relay offline" }, { status: 503 }));
    }
  },
);

it.each([
  {
    name: "rejected route parameters",
    params: 42,
    scope: undefined,
    reason: "unavailable",
  },
  {
    name: "a foreign viewer",
    params: "foreign-viewer",
    scope: { viewer: recipient.pubkey, communityOrigin: origin },
    reason: "denied",
  },
  {
    name: "an unjoined community",
    params: "unjoined-community",
    scope: { viewer, communityOrigin: "https://other.example" },
    reason: "denied",
  },
])("withholds a page sidebar for $name", async ({ params, scope, reason }) => {
  await setup();
  const current = services;
  if (!current) throw new Error("Missing services");
  const delivered = vi.fn();
  sidebarFixtureState.onTarget = delivered;
  await act(async () => {
    expect(
      await current.navigation.open({
        version: 1,
        kind: "page",
        pluginId: "test.sidebar",
        pageId: "main",
        route: { version: 1, params },
        ...(scope !== undefined ? { scope } : {}),
      }),
    ).toMatchObject({ status: "failed", reason });
  });
  expect(
    await screen.findByRole("heading", { name: pageFailure }),
  ).toBeVisible();
  expect(screen.queryByText("Beacon page content")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("complementary", { name: "Beacon sidebar" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("navigation", { name: "Pages" })).toBeVisible();
  expect(delivered).not.toHaveBeenCalled();
});

it("delivers a page sidebar target only after selecting its personal scope", async () => {
  await setup();
  const current = services;
  if (!current) throw new Error("Missing services");
  const observed: {
    selected: string | null;
    relayScope: string | undefined;
  }[] = [];
  sidebarFixtureState.onTarget = () => {
    observed.push({
      selected: current.communities.snapshot().selected,
      relayScope: current.relay.snapshot().scope,
    });
  };
  await act(async () => {
    expect(
      await current.navigation.open({
        version: 1,
        kind: "page",
        pluginId: "test.sidebar",
        pageId: "main",
        route: { version: 1, params: "personal-space" },
        scope: null,
      }),
    ).toMatchObject({ status: "opened" });
  });
  expect(await screen.findByText("Beacon page content")).toBeVisible();
  expect(observed.length).toBeGreaterThan(0);
  for (const observation of observed) {
    expect(observation.selected).toBeNull();
    expect(observation.relayScope).toBeUndefined();
  }
});

it("opens profile settings from the account menu header", async () => {
  const user = await setup();
  await user.click(screen.getByRole("button", { name: "Your profile" }));
  const menu = await screen.findByRole("menu", { name: "Community name" });
  await user.click(
    within(menu).getByRole("menuitem", {
      name: "Community name, edit profile",
    }),
  );
  await waitFor(() => expect(menu).not.toBeInTheDocument());
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  expect(
    await within(settings).findByText(
      "Update this community’s profile. Other community profiles stay unchanged.",
    ),
  ).toBeVisible();
  expect(
    await within(settings).findByRole("textbox", { name: "Display name" }),
  ).toHaveValue("Community name");
});

// Startup has already cached the viewer's profile in this session, so the
// first open is served from that cache.
it("opens profile settings from the session cache while refreshing", async () => {
  await setup();
  if (!services) throw new Error("Missing services");
  const current = services;
  // ProfileButton fills that cache from its own background read, after the
  // relay is ready. Settings seeds its loaded profile from the cache once, on
  // mount, so wait for the fixture profile to land before opening.
  await waitFor(() =>
    expect(current.relay.snapshot().session?.profiles.event?.(viewer)?.id).toBe(
      profile.id,
    ),
  );
  let release = () => {};
  const read = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inspect = communityApi.inspectProfile;
  const refresh = vi
    .spyOn(communityApi, "inspectProfile")
    .mockImplementation(async (...args) => {
      await read;
      return inspect(...args);
    });
  // Reopening uses the cached value immediately. Control delayed loading
  // feedback so a busy runner cannot cross its one-second boundary first.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await act(async () => {
      void current.navigation.open({
        version: 1,
        kind: "settings",
        section: "profile",
      });
    });
    expect(refresh).toHaveBeenCalledWith(
      origin,
      current.relay.snapshot().session,
    );
    const settings = screen.getByRole("dialog", { name: "Settings" });
    expect(
      within(settings).getByRole("textbox", { name: "Display name" }),
    ).toHaveValue("Community name");
    expect(within(settings).queryByText(/Loading your profile/)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(within(settings).getByText(/Loading your profile/)).toBeVisible();
    expect(
      within(settings).getByRole("textbox", { name: "Display name" }),
    ).toHaveValue("Community name");
  } finally {
    await act(async () => release());
    vi.useRealTimers();
  }
});

it("opens Plugins from the account menu and switches back to profile settings", async () => {
  const user = await setup();
  await user.click(screen.getByRole("button", { name: "Your profile" }));
  await user.click(await screen.findByRole("menuitem", { name: "Plugins" }));
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  expect(
    await within(settings).findByRole("region", {
      name: "Manage plugins",
    }),
  ).toBeVisible();
  await user.click(within(settings).getByRole("button", { name: "Profile" }));
  expect(
    await within(settings).findByRole("region", {
      name: "Profile",
    }),
  ).toBeVisible();
});

// Whole-app journeys through several Settings sections run slower in CI.
it("keeps the same unsent conversation and companion panel through Settings sections and Close", async () => {
  const user = await setup();
  if (!services) throw new Error("Missing app services");
  const current = services;
  await user.click(await screen.findByRole("button", { name: "New message" }));
  const composing = await screen.findByRole("region", { name: "New message" });
  await user.click(
    await screen.findByRole("option", { name: "Draft recipient" }),
  );
  const editor = within(composing).getByRole<ComposerInputElement>("textbox", {
    name: "Message Draft recipient",
  });
  await user.click(editor);
  await user.paste("Keep this draft behind Settings");
  await user.click(screen.getByRole("button", { name: "Draft companion" }));
  const panel = await screen.findByRole("complementary", {
    name: "Draft companion",
  });
  const note = within(panel).getByRole("textbox", { name: "Companion note" });
  await user.type(note, "Retain companion state");
  const trigger = screen.getByRole("button", { name: "Your profile" });
  const entry = current.navigation.snapshot().entry;
  const assertPreserved = () => {
    expect(composing).toBeInTheDocument();
    expect(panel).toBeInTheDocument();
    expect(
      within(panel).getByRole("textbox", {
        name: "Companion note",
        hidden: true,
      }),
    ).toBe(note);
    expect(note).toHaveValue("Retain companion state");
    expect(
      within(composing).getByRole("textbox", {
        name: "Message Draft recipient",
        hidden: true,
      }),
    ).toBe(editor);
    expect(editor).toHaveTextContent("Keep this draft behind Settings");
  };
  const communities = screen.getByRole("navigation", { name: "Communities" });
  await user.click(trigger);
  await user.click(await screen.findByRole("menuitem", { name: "Settings" }));
  const modal = await screen.findByRole("dialog", { name: "Settings" });
  const frame = modal.closest("[data-shell-dialog-frame]");
  expect(frame).not.toBeNull();
  const workspace = frame?.parentElement;
  expect(workspace).toContainElement(composing);
  expect(workspace).toContainElement(panel);
  // The dock remains in the workspace alongside the Settings frame.
  expect(workspace).toContainElement(communities);
  expect(modal.closest('[aria-hidden="true"], [inert]')).toBeNull();
  await waitFor(() =>
    expect(modal).toContainElement(document.activeElement as HTMLElement),
  );
  assertPreserved();
  await user.click(within(modal).getByRole("button", { name: "Appearance" }));
  await within(modal).findByRole("heading", { name: "Appearance" });
  await user.click(
    within(modal).getByRole("button", { name: "Notifications" }),
  );
  await within(modal).findByRole("heading", { name: "Notifications" });
  assertPreserved();
  await user.click(
    within(modal).getByRole("button", { name: "Close Settings" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull(),
  );
  expect(current.navigation.snapshot().entry.id).toBe(entry.id);
  assertPreserved();
  expect(trigger).toHaveFocus();
}, 15_000);

it("returns keyboard-opened Settings to the same focused draft", async () => {
  const user = await setup();
  await user.click(await screen.findByRole("button", { name: "New message" }));
  const composing = await screen.findByRole("region", { name: "New message" });
  await user.click(
    await screen.findByRole("option", { name: "Draft recipient" }),
  );
  const editor = within(composing).getByRole<ComposerInputElement>("textbox", {
    name: "Message Draft recipient",
  });
  await user.click(editor);
  await user.paste("Keyboard draft");
  await user.keyboard("{Control>},{/Control}");
  const modal = await screen.findByRole("dialog", { name: "Settings" });
  await waitFor(() =>
    expect(modal).toContainElement(document.activeElement as HTMLElement),
  );
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull(),
  );
  expect(editor).toHaveFocus();
  expect(editor).toHaveTextContent("Keyboard draft");
});

// Whole-app journeys through several Settings sections run slower in CI.
it("asks before any Settings dismissal discards unsaved profile edits", async () => {
  const user = await setup();
  await act(async () => {
    void services?.navigation.open({
      version: 1,
      kind: "settings",
      section: "profile",
    });
  });
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  const name = await within(settings).findByRole("textbox", {
    name: "Display name",
  });
  await waitFor(() => expect(name).toHaveValue("Community name"));
  await user.clear(name);
  await user.type(name, "Unsaved name");
  const confirmation = () =>
    screen.findByRole("alertdialog", { name: "Discard changes?" });
  const keepEditing = async () => {
    await user.click(
      within(await confirmation()).getByRole("button", {
        name: "Keep editing",
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("alertdialog", { name: "Discard changes?" }),
      ).toBeNull(),
    );
    expect(screen.getByRole("dialog", { name: "Settings" })).toBe(settings);
    expect(name).toHaveValue("Unsaved name");
  };

  await user.keyboard("{Escape}");
  await keepEditing();
  await user.click(
    document.querySelector(".buzz-dialog-backdrop") as HTMLElement,
  );
  await keepEditing();
  await user.click(
    within(settings).getByRole("button", { name: "Close Settings" }),
  );
  await confirmation();
  // The confirmation needs a deliberate choice; its backdrop does nothing.
  const backdrops = document.querySelectorAll(".buzz-dialog-backdrop");
  await user.click(backdrops[backdrops.length - 1] as HTMLElement);
  expect(await confirmation()).toBeVisible();
  // Escape backs out of the prompt, not out of Settings.
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(
      screen.queryByRole("alertdialog", { name: "Discard changes?" }),
    ).toBeNull(),
  );
  expect(screen.getByRole("dialog", { name: "Settings" })).toBe(settings);

  await user.click(
    within(settings).getByRole("button", { name: "Close Settings" }),
  );
  await user.click(
    within(await confirmation()).getByRole("button", {
      name: "Discard changes",
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull(),
  );
  await act(async () => {
    void services?.navigation.open({
      version: 1,
      kind: "settings",
      section: "profile",
    });
  });
  const reopened = await screen.findByRole("dialog", { name: "Settings" });
  expect(
    within(reopened).getByRole("textbox", { name: "Display name" }),
  ).toHaveValue("Community name");
  // A clean profile closes without asking.
  await user.click(
    within(reopened).getByRole("button", { name: "Close Settings" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull(),
  );
  expect(
    screen.queryByRole("alertdialog", { name: "Discard changes?" }),
  ).toBeNull();
}, 15_000);

it.each(["pending", "unavailable"] as const)(
  "retains a dirty Profile through a same-scope %s Settings destination",
  async (state) => {
    const user = await setup();
    if (!services) throw new Error("Missing app services");
    const current = services;
    const profile = {
      version: 1,
      kind: "settings",
      section: "profile",
    } as const;
    await act(async () => {
      void current.navigation.open(profile);
    });
    await screen.findByRole("textbox", { name: "Display name" });
    await act(async () => {
      void current.navigation.open({
        ...profile,
        section: "agents",
        provider: "test.sidebar/missing",
      });
    });
    await screen.findByText(pageFailure);
    act(() => current.navigation.back());
    const name = await screen.findByRole("textbox", { name: "Display name" });
    await waitFor(() => expect(name).toHaveValue("Community name"));
    await user.clear(name);
    // The draft's content matters here, not how it was entered; each typed
    // keystroke renders the whole app again.
    await user.paste("Keep this draft");
    if (state === "pending") {
      const snapshot = current.plugins.snapshot();
      const sidebar = snapshot.activation["test.sidebar"];
      if (!sidebar) throw new Error("Missing sidebar plugin");
      vi.spyOn(current.plugins, "snapshot").mockReturnValue({
        ...snapshot,
        activation: {
          ...snapshot.activation,
          "test.sidebar": {
            ...sidebar,
            status: "starting",
          },
        },
      });
    }
    act(() => current.navigation.forward());
    if (state === "pending")
      await waitFor(() =>
        expect(
          document.querySelector('.page-status [aria-busy="true"]'),
        ).not.toBeNull(),
      );
    else await screen.findByText(pageFailure);
    expect(name).toBeInTheDocument();
    expect(name).not.toBeVisible();
    act(() => current.navigation.back());
    expect(await screen.findByRole("textbox", { name: "Display name" })).toBe(
      name,
    );
    expect(name).toHaveValue("Keep this draft");
  },
  // Each Settings navigation here renders the whole app again, about a second
  // apiece on a loaded runner, as in the neighbouring tests.
  15_000,
);

it("drops the retained draft after an accepted departure to another account's unavailable Settings", async () => {
  const user = await setup();
  if (!services) throw new Error("Missing app services");
  const current = services;
  await act(async () => {
    void current.navigation.open({
      version: 1,
      kind: "settings",
      section: "profile",
    });
  });
  const name = await screen.findByRole("textbox", { name: "Display name" });
  await waitFor(() => expect(name).toHaveValue("Community name"));
  await user.clear(name);
  await user.type(name, "Discard this draft");
  act(() => {
    void current.navigation.open({
      version: 1,
      kind: "settings",
      section: "profile",
      scope: { viewer: "a".repeat(64), communityOrigin: origin },
    });
  });
  const prompt = await screen.findByRole("alertdialog", {
    name: "Discard changes?",
  });
  await user.click(
    within(prompt).getByRole("button", { name: "Discard changes" }),
  );
  await screen.findByText(pageFailure);
  expect(name).not.toBeInTheDocument();
  act(() => current.navigation.back());
  expect(
    await screen.findByRole("textbox", { name: "Display name" }),
  ).toHaveValue("Community name");
});

it.each(["Close", "Back"] as const)(
  "clears the %s discard prompt when the pending save is sent",
  async (exit) => {
    const user = await setup();
    let release = () => {};
    const read = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inspect = communityApi.inspectProfile;
    let holding = false;
    vi.spyOn(communityApi, "inspectProfile").mockImplementation(
      async (...args) => {
        if (holding) await read;
        return inspect(...args);
      },
    );
    const publish = vi
      .spyOn(communityApi, "publishProfile")
      .mockImplementation(async (_id, next) => {
        vi.mocked(communityApi.inspectProfile).mockResolvedValue({
          exists: true,
          profile: next,
          existing: {},
        });
      });
    await act(async () => {
      void services?.navigation.open({
        version: 1,
        kind: "settings",
        section: "profile",
      });
    });
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    const name = await within(settings).findByRole("textbox", {
      name: "Display name",
    });
    await waitFor(() => expect(name).toHaveValue("Community name"));
    await user.clear(name);
    await user.type(name, "Pending name");
    holding = true;
    await user.click(within(settings).getByRole("button", { name: "Save" }));
    if (exit === "Back") act(() => services?.navigation.back());
    else
      await user.click(
        within(settings).getByRole("button", { name: "Close Settings" }),
      );
    await screen.findByRole("alertdialog", { name: "Discard changes?" });
    // The save is sent behind the prompt; nothing is left to discard.
    holding = false;
    await act(async () => release());
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        screen.queryByRole("alertdialog", { name: "Discard changes?" }),
      ).toBeNull(),
    );
    expect(screen.getByRole("dialog", { name: "Settings" })).toBe(settings);
    await waitFor(() => expect(name).toBeEnabled());
    await user.clear(name);
    await user.type(name, "Another draft");
    await user.click(
      within(settings).getByRole("button", { name: "Close Settings" }),
    );
    const prompt = await screen.findByRole("alertdialog", {
      name: "Discard changes?",
    });
    await user.click(
      within(prompt).getByRole("button", { name: "Discard changes" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull(),
    );
  },
  15_000,
);
