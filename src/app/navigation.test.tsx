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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { keypair, signed } from "../features/relay/testing";
import { stubAvatarBrowserApis } from "../features/agents/avatar-testing";
import type { RelayEvent } from "../features/relay/events";
import type { Context } from "@deepseek-ai/cordis";
import { App } from "./App";
import { createServices, type AppServices } from "./services";

/** Any variant of the App-owned "page couldn't open" card. */
const pageFailure =
  /^(This page isn’t available|Can’t connect|You don’t have access to this|This link doesn’t work)$/;

const activation = vi.hoisted(() => {
  const gate = {
    held: Promise.resolve(),
    release: () => {},
    reset() {
      gate.held = new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    },
  };
  return gate;
});
vi.mock("../bundled", async () => ({
  bundledPlugins: [
    {
      manifest: { id: "buzz.moderation", name: "Moderation", apiVersion: 1 },
      module: await import("../bundled/moderation"),
    },
    {
      manifest: { id: "test.gated", name: "Gated", apiVersion: 1 },
      module: {
        inject: ["settingsCards", "agents"],
        async apply(ctx: Context) {
          await activation.held;
          ctx.settingsCards.register({
            id: "card",
            title: "Gated card",
            group: "Communities",
            component: () => <p>Gated card body</p>,
          });
          const state = { readiness: "ready" as const };
          ctx.agents.register({
            id: "provider",
            title: "Gated provider",
            defaults: () => ({ config: {} }),
            provider: {
              snapshot: () => state,
              subscribe: () => () => {},
              check() {},
              DialogBody: () => <p>Gated provider controls</p>,
            },
          });
        },
      },
    },
    {
      manifest: { id: "buzz.pairing", name: "Pair mobile", apiVersion: 1 },
      module: await import("../bundled/pairing"),
    },
  ],
}));
// jsdom has no media queries; responsive geometry is covered in browser tests.
beforeEach(() => {
  activation.reset();
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
let services: AppServices | undefined;
afterEach(async () => {
  activation.release();
  cleanup();
  await services?.dispose();
  services = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

it("waits for a starting plugin before opening its addressed Settings card", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const target = { version: 1, kind: "settings", section: "test.gated/card" };
  window.history.replaceState(
    null,
    "",
    `/#buzz=${encodeURIComponent(JSON.stringify(target))}`,
  );
  const current = createServices();
  services = current;
  render(<App services={current} />);
  try {
    await waitFor(() =>
      expect(current.plugins.snapshot().activation["test.gated"]?.status).toBe(
        "starting",
      ),
    );
    expect(current.navigation.snapshot().status).not.toBe("failed");
    expect(screen.queryByText(pageFailure)).not.toBeInTheDocument();
  } finally {
    await act(async () => activation.release());
  }
  expect(await screen.findByText("Gated card body")).toBeVisible();
  expect(current.navigation.snapshot().status).toBe("opened");
});

it("waits for a cold Settings provider address until its plugin registers", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const target = {
    version: 1,
    kind: "settings",
    section: "agents",
    provider: "test.gated/provider",
  };
  window.history.replaceState(
    null,
    "",
    `/#buzz=${encodeURIComponent(JSON.stringify(target))}`,
  );
  const current = createServices();
  services = current;
  render(<App services={current} />);
  try {
    await waitFor(() =>
      expect(current.plugins.snapshot().activation["test.gated"]?.status).toBe(
        "starting",
      ),
    );
    expect(current.navigation.snapshot().status).toBe("opening");
    expect(screen.queryByText(pageFailure)).toBeNull();
  } finally {
    await act(async () => activation.release());
  }
  expect(
    await screen.findByRole("dialog", { name: "Gated provider" }),
  ).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  await act(async () => {
    await current.plugins.change("disable", "test.gated");
  });
  expect(await screen.findByText(pageFailure)).toBeVisible();
});

it("Back closes a Settings provider while leaving Settings open and Forward reopens it", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  activation.release();
  const current = createServices();
  services = current;
  render(<App services={current} />);
  await waitFor(() =>
    expect(current.navigation.snapshot().status).not.toBe("pending"),
  );
  void current.navigation.open({
    version: 1,
    kind: "settings",
    section: "agents",
  });
  const trigger = await screen.findByRole("button", {
    name: "Gated provider, ready",
  });
  const agentSetup = current.navigation.snapshot().entry.target;
  expect(agentSetup).not.toHaveProperty("provider");
  fireEvent.click(trigger);
  const provider = await screen.findByRole("dialog", {
    name: "Gated provider",
  });
  expect(provider).toHaveAttribute("data-navigation-visit");
  expect(current.navigation.snapshot().entry.target).toEqual({
    ...agentSetup,
    provider: "test.gated/provider",
  });
  expect(fireEvent.keyDown(provider, { ctrlKey: true, key: "[" })).toBe(false);
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Gated provider" })).toBeNull(),
  );
  expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
  expect(current.navigation.snapshot().entry.target).toEqual(agentSetup);
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Settings" }), {
    ctrlKey: true,
    key: "]",
  });
  expect(
    await screen.findByRole("dialog", { name: "Gated provider" }),
  ).toBeVisible();
  expect(current.navigation.snapshot().entry.target).toEqual({
    ...agentSetup,
    provider: "test.gated/provider",
  });
});

it("reports a settled plugin's absent Settings provider as unavailable", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  activation.release();
  const target = {
    version: 1,
    kind: "settings",
    section: "agents",
    provider: "test.gated/missing",
  };
  window.history.replaceState(
    null,
    "",
    `/#buzz=${encodeURIComponent(JSON.stringify(target))}`,
  );
  const current = createServices();
  services = current;
  render(<App services={current} />);
  await waitFor(() =>
    expect(current.plugins.snapshot().activation["test.gated"]?.status).toBe(
      "active",
    ),
  );
  expect(await screen.findByText(pageFailure)).toBeVisible();
  expect(current.navigation.snapshot()).toMatchObject({
    status: "failed",
    reason: "unavailable",
  });
});

it("leaves the app's own navigation as the way out when Messages itself is unavailable", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  activation.release();
  window.history.replaceState(
    null,
    "",
    `/#buzz=${encodeURIComponent(
      JSON.stringify({
        version: 1,
        kind: "page",
        pluginId: "buzz.channels",
        pageId: "channels",
        scope: null,
      }),
    )}`,
  );
  const current = createServices();
  services = current;
  render(<App services={current} />);
  expect(
    await screen.findByRole("heading", { name: "This page isn’t available" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Go to Messages" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull();
});

it("opens Pair mobile in Personal space with no saved communities", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const target = {
    version: 1,
    kind: "settings",
    section: "buzz.pairing/mobile",
    scope: null,
  };
  window.history.replaceState(
    null,
    "",
    `/#buzz=${encodeURIComponent(JSON.stringify(target))}`,
  );
  const current = createServices();
  services = current;
  render(<App services={current} />);
  expect(
    await screen.findByRole("heading", { name: "Pair mobile" }),
  ).toBeVisible();
  expect(current.communities.snapshot().memberships).toEqual([]);
  expect(current.communities.snapshot().selected).toBeNull();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  expect(current.navigation.snapshot().entry.target).toEqual(target);
  const [navigation] = screen.getAllByRole("navigation", {
    name: "Settings sections",
  });
  const group = within(navigation as HTMLElement)
    .getByText("Personal space")
    .closest("section");
  expect(group).not.toBeNull();
  expect(
    within(group as HTMLElement).getByRole("button", { name: "Pair mobile" }),
  ).toHaveAttribute("aria-current", "page");
});

const viewer = keypair();
const authority = keypair();
const primary = "https://membership-a.example";
const secondary = "https://membership-b.example";
const membershipTarget = {
  version: 1 as const,
  kind: "settings" as const,
  section: "buzz.moderation/membership",
  scope: { viewer: viewer.pubkey, communityOrigin: primary },
};
function membershipFixture() {
  stubAvatarBrowserApis();
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
    `buzz-client.v1:${viewer.pubkey}`,
    JSON.stringify({
      profile: { name: "Fixture", picture: "" },
      memberships: [
        { id: primary, name: "Primary" },
        { id: secondary, name: "Secondary" },
      ],
      selected: secondary,
    }),
  );
  let respond: () => Promise<Response> = async () => Response.json([]);
  const rosterReads: string[] = [];
  let offline = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/identity"))
        return Response.json({ viewer: viewer.pubkey });
      const community = decodeURIComponent(url.split("/").at(-2) ?? "");
      if (url.endsWith("/session")) {
        if (offline)
          return Response.json({ error: "offline" }, { status: 503 });
        return Response.json({
          viewer: viewer.pubkey,
          relayAuthor: authority.pubkey,
          relayUrl: community,
        });
      }
      if (url.endsWith("/query")) {
        const filters = JSON.parse(String(options?.body));
        if (
          filters.some((filter: { kinds?: number[] }) =>
            filter.kinds?.includes(13534),
          )
        ) {
          rosterReads.push(community);
          return respond();
        }
        return Response.json([]);
      }
      return Response.json({});
    }),
  );
  const roster = (role: string): RelayEvent =>
    signed(authority, {
      kind: 13534,
      content: "",
      tags: [["member", viewer.pubkey, role]],
    });
  return {
    rosterReads,
    offline(value = true) {
      offline = value;
    },
    hold() {
      let release!: (role: string) => void;
      const response = new Promise<string>((resolve) => {
        release = resolve;
      });
      respond = async () => Response.json([roster(await response)]);
      return (role = "owner") => release(role);
    },
    fail() {
      respond = async () =>
        Response.json({ error: "offline" }, { status: 503 });
    },
    owner() {
      respond = async () => Response.json([roster("owner")]);
    },
  };
}
function restoreMembership() {
  window.history.replaceState(
    null,
    "",
    `/#buzz=${encodeURIComponent(JSON.stringify(membershipTarget))}`,
  );
  const current = createServices();
  services = current;
  render(<App services={current} />);
  return current;
}
function expectPending(current: AppServices) {
  expect(current.navigation.snapshot().status).toBe("opening");
  expect(
    document.querySelector('.page-status [aria-busy="true"]'),
  ).not.toBeNull();
  expect(screen.queryByText(pageFailure)).toBeNull();
  expect(screen.queryByRole("button", { name: "Membership" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Profile" })).toBeNull();
}
it("restores a scoped Membership URL only after its verified roster is applied", async () => {
  const fixture = membershipFixture();
  const release = fixture.hold();
  const current = restoreMembership();
  try {
    await waitFor(() => expect(fixture.rosterReads).toContain(primary));
    expect(current.communities.snapshot().selected).toBe(primary);
    expectPending(current);
  } finally {
    await act(async () => release());
  }
  expect(
    await screen.findByRole("heading", { name: "Membership" }),
  ).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
});
it("reselects and reauthorizes Membership when Back returns from another community", async () => {
  const fixture = membershipFixture();
  fixture.owner();
  const current = restoreMembership();
  await screen.findByRole("heading", { name: "Membership" });
  await act(async () => {
    current.communities.select(secondary);
    void current.navigation.open({
      version: 1,
      kind: "settings",
      section: "appearance",
      scope: { viewer: viewer.pubkey, communityOrigin: secondary },
    });
  });
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  const before = fixture.rosterReads.length;
  const release = fixture.hold();
  try {
    act(() => current.navigation.back());
    await waitFor(() =>
      expect(fixture.rosterReads.length).toBeGreaterThan(before),
    );
    expect(current.communities.snapshot().selected).toBe(primary);
    expectPending(current);
  } finally {
    await act(async () => release());
  }
  expect(
    await screen.findByRole("heading", { name: "Membership" }),
  ).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
});
it("fails a completed ordinary-member read without exposing Membership", async () => {
  const fixture = membershipFixture();
  const release = fixture.hold();
  const current = restoreMembership();
  try {
    await waitFor(() => expect(fixture.rosterReads).toContain(primary));
  } finally {
    await act(async () => release("member"));
  }
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("failed"),
  );
  expect(screen.getByText(pageFailure)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Membership" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Membership" })).toBeNull();
});
it.each([true, false])(
  "Retry navigation refreshes permission and hands off only its own focus (focused: %s)",
  async (focused) => {
    const fixture = membershipFixture();
    fixture.fail();
    const current = restoreMembership();
    const retry = await screen.findByRole("button", {
      name: "Try again",
    });
    const main = document.getElementById("settings-content");
    if (!main) throw new Error("Missing Settings content focus target");
    const elsewhere = screen.getByRole("button", { name: "Close Settings" });
    (focused ? retry : elsewhere).focus();
    const before = fixture.rosterReads.length;
    expect(before).toBeGreaterThan(0);
    const release = fixture.hold();
    try {
      fireEvent.click(retry);
      expect(focused ? main : elsewhere).toHaveFocus();
      await waitFor(() =>
        expect(fixture.rosterReads.length).toBeGreaterThan(before),
      );
      expectPending(current);
      expect(focused ? main : elsewhere).toHaveFocus();
    } finally {
      await act(async () => release());
    }
    expect(
      await screen.findByRole("heading", { name: "Membership" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(current.navigation.snapshot().status).toBe("opened"),
    );
  },
);

it("reconnects the selected Membership community after its transport fails", async () => {
  const fixture = membershipFixture();
  fixture.offline();
  fixture.owner();
  const current = restoreMembership();
  await screen.findByRole("button", { name: "Try again" });
  expect(current.communities.snapshot().selected).toBe(primary);
  expect(current.relay.snapshot().status).toBe("error");
  const retry = vi.spyOn(current.relay, "retry");
  fixture.offline(false);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("heading", { name: "Membership" });
  expect(retry).toHaveBeenCalledOnce();
  expect(current.navigation.snapshot().status).toBe("opened");
});
it("does not reconnect an unrelated community when the addressed Settings scope is denied", async () => {
  const fixture = membershipFixture();
  fixture.offline();
  const current = restoreMembership();
  await screen.findByRole("button", { name: "Try again" });
  const retry = vi.spyOn(current.relay, "retry");
  act(() => {
    void current.navigation.open({
      ...membershipTarget,
      scope: { viewer: authority.pubkey, communityOrigin: primary },
    });
  });
  await waitFor(() =>
    expect(current.navigation.snapshot().reason).toBe("denied"),
  );
  // Retry cannot grant access, so the denied card offers only a way out.
  expect(
    await screen.findByRole("heading", {
      name: "You don’t have access to this",
    }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(current.navigation.snapshot().reason).toBe("denied");
  expect(retry).not.toHaveBeenCalled();
});

it("keeps the confirmed departure mounted through removal, then opens Personal Profile", async () => {
  membershipFixture();
  const target = {
    ...membershipTarget,
    section: "leave-community",
  };
  window.history.replaceState(
    null,
    "",
    `/#buzz=${encodeURIComponent(JSON.stringify(target))}`,
  );
  const current = createServices();
  services = current;
  let finish!: () => void;
  const pendingCleanup = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const remove = current.communities.leave;
  vi.spyOn(current.communities, "leave").mockImplementation(async (...args) => {
    const result = remove(...args);
    await pendingCleanup;
    return result;
  });
  render(<App services={current} />);
  await screen.findByRole("heading", { name: "Leave or remove" });
  fireEvent.click(
    screen.getByRole("button", { name: "Remove from this device" }),
  );
  const dialog = await screen.findByRole("alertdialog");
  try {
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove from this device" }),
    );
    await waitFor(() =>
      expect(current.communities.snapshot().selected).toBeNull(),
    );
    expect(
      current.communities.snapshot().memberships.some((m) => m.id === primary),
    ).toBe(false);
    expect(dialog).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    expect(screen.queryByText(pageFailure)).toBeNull();
  } finally {
    await act(async () => finish());
  }
  await screen.findByRole("heading", { name: "Profile" });
  await waitFor(() =>
    expect(current.navigation.snapshot().entry.target).toEqual({
      version: 1,
      kind: "settings",
      section: "profile",
      scope: null,
    }),
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.queryByText(pageFailure)).toBeNull();
  await waitFor(() =>
    expect(document.getElementById("settings-content")).toHaveFocus(),
  );
  // The presentation lease never makes a removed community navigable again.
  await act(async () => {
    void current.navigation.open(target);
  });
  await screen.findByText(pageFailure);
  expect(current.navigation.snapshot().reason).toBe("denied");
});

it("opens removed Messages settings links at Appearance without adding a navigation entry", async () => {
  // jsdom does not measure layout; this test exercises route normalization, not geometry.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const target = {
    version: 1,
    kind: "settings",
    section: "buzz.channels/messages",
  };
  window.history.replaceState(
    null,
    "",
    `/#buzz=${encodeURIComponent(JSON.stringify(target))}`,
  );
  services = createServices();
  render(<App services={services} />);
  await screen.findByRole("heading", { name: "Conversations" });
  expect(
    screen.getByRole("combobox", { name: "Open threads in" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("switch", { name: "Remember mentioned agents" }),
  ).not.toBeInTheDocument();
  await waitFor(() =>
    expect(services?.navigation.snapshot().status).toBe("opened"),
  );
  expect(services.navigation.snapshot().entry.target).toEqual({
    ...target,
    section: "appearance",
  });
  expect(screen.queryByRole("button", { name: "Messages" })).toBeNull();
});

it("keeps a return path for addressed plugin settings through Back and Forward", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  activation.release();
  const current = createServices();
  services = current;
  render(<App services={current} />);
  await waitFor(() =>
    expect(current.navigation.snapshot().status).not.toBe("pending"),
  );
  const target = {
    version: 1,
    kind: "settings",
    section: "plugins",
    pluginId: "buzz.pairing",
    scope: null,
  } as const;
  const list = {
    version: 1,
    kind: "settings",
    section: "plugins",
    scope: null,
  } as const;
  void current.navigation.open(list);
  await screen.findByRole("dialog", { name: "Settings" });
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  void current.navigation.open(target);
  expect(
    await screen.findByRole("complementary", { name: "Pair mobile details" }),
  ).toBeVisible();
  current.navigation.back();
  await waitFor(() =>
    expect(current.navigation.snapshot().entry.target).toEqual(list),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("complementary", { name: "Pair mobile details" }),
    ).not.toBeInTheDocument(),
  );
  current.navigation.forward();
  expect(
    await screen.findByRole("complementary", { name: "Pair mobile details" }),
  ).toBeVisible();
});

it("retires every visit to addressed plugin settings on Close", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  activation.release();
  const current = createServices();
  services = current;
  render(<App services={current} />);
  await waitFor(() =>
    expect(current.navigation.snapshot().status).not.toBe("pending"),
  );
  const target = {
    version: 1,
    kind: "settings",
    section: "plugins",
    pluginId: "buzz.pairing",
    scope: null,
  } as const;
  const list = {
    version: 1,
    kind: "settings",
    section: "plugins",
    scope: null,
  } as const;
  void current.navigation.open(list);
  await screen.findByRole("dialog", { name: "Settings" });
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  // An earlier details visit stays behind Appearance; Close must retire it too.
  void current.navigation.open(target);
  await screen.findByRole("complementary", { name: "Pair mobile details" });
  const appearance = { ...list, section: "appearance" };
  void current.navigation.open(appearance);
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  void current.navigation.open(target);
  await screen.findByRole("complementary", { name: "Pair mobile details" });
  fireEvent.click(screen.getByRole("button", { name: "Close plugin details" }));
  await waitFor(() =>
    expect(current.navigation.snapshot().entry.target).toEqual({
      version: 1,
      kind: "settings",
      section: "plugins",
      scope: null,
    }),
  );
  current.navigation.back();
  await waitFor(() =>
    expect(current.navigation.snapshot().entry.target).toEqual(appearance),
  );
  current.navigation.back();
  await waitFor(() =>
    expect(current.navigation.snapshot().entry.target).toEqual(list),
  );
  expect(
    screen.queryByRole("complementary", { name: "Pair mobile details" }),
  ).not.toBeInTheDocument();
});

it("Back closes Settings onto the view beneath and Forward reopens it; other shortcuts stay blocked", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  activation.release();
  const current = createServices();
  services = current;
  render(<App services={current} />);
  // Whatever view the app settles on first lies beneath Settings.
  await waitFor(() =>
    expect(current.navigation.snapshot().status).not.toBe("pending"),
  );
  const beneath = current.navigation.snapshot().entry.target;
  const settings = { version: 1, kind: "settings", scope: null } as const;
  void current.navigation.open(settings);
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  expect(dialog).toHaveAttribute("data-navigation-visit");
  const key = (init: KeyboardEventInit) =>
    fireEvent.keyDown(screen.getByRole("button", { name: "Close Settings" }), {
      ctrlKey: true,
      ...init,
    });
  // Home is not a Back/Forward shortcut: Settings keeps today's modal policy.
  key({ key: "o", shiftKey: true });
  await act(async () => {});
  expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
  key({ key: "[" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull(),
  );
  expect(current.navigation.snapshot().entry.target).toEqual(beneath);
  fireEvent.keyDown(document.body, { ctrlKey: true, key: "]" });
  expect(await screen.findByRole("dialog", { name: "Settings" })).toBeVisible();
});
