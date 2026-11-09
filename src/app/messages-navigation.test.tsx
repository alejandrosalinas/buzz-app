// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
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
import { App } from "./App";
import { createServices, type AppServices } from "./services";

vi.mock("../bundled", async () => ({
  bundledPlugins: [
    {
      manifest: (await import("../bundled/channels/manifest.json")).default,
      module: await import("../bundled/channels"),
      enabledByDefault: true,
    },
    {
      // Off by default in the app; enabled here to exercise its navigation.
      manifest: (await import("../bundled/drafts-sent/manifest.json")).default,
      module: await import("../bundled/drafts-sent"),
      enabledByDefault: true,
    },
    {
      manifest: { id: "test.sidebar", name: "Sidebar fixture", apiVersion: 1 },
      module: await import("./sidebar-plugin.fixture"),
      enabledByDefault: true,
    },
  ],
}));

let services: AppServices | undefined;
const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
);
beforeEach(() => {
  // jsdom has no layout scrolling; search reveals its selected result.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});

it("opens the Drafts & sent plugin page from global search inside Messages", async () => {
  services = createServices();
  render(<App services={services} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Search Buzz" }));
  const search = await screen.findByRole("combobox", { name: "Search Buzz" });
  await user.type(search, "drafts");
  const dialog = await screen.findByRole("dialog", { name: "Search Buzz" });
  await user.click(
    await within(dialog).findByRole("button", { name: "Drafts & sent" }),
  );
  expect(
    await screen.findByRole("region", { name: "Drafts & sent" }),
  ).toBeVisible();
  expect(services.navigation.snapshot().entry.target).toMatchObject({
    kind: "page",
    pluginId: "buzz.drafts-and-sent",
    pageId: "drafts-sent",
  });
  expect(screen.getByRole("tab", { name: "Messages" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it("opens Drafts & sent from a plugin-owned sidebar's shared Pages navigation", async () => {
  services = createServices();
  render(<App services={services} />);
  await waitFor(() =>
    expect(services?.navigation.snapshot().status).toBe("opened"),
  );
  act(() => {
    void services?.navigation.open({
      version: 1,
      kind: "page",
      pluginId: "test.sidebar",
      pageId: "main",
    });
  });
  const sidebar = await screen.findByRole("complementary", {
    name: "Beacon sidebar",
  });
  const pages = within(sidebar).getByRole("navigation", { name: "Pages" });
  await userEvent.click(
    within(pages).getByRole("button", { name: "Drafts & sent" }),
  );
  expect(
    await screen.findByRole("region", { name: "Drafts & sent" }),
  ).toBeVisible();
  expect(screen.getByRole("navigation", { name: "Pages" })).toContainElement(
    screen.getByRole("button", { name: "Drafts & sent" }),
  );
});
afterEach(async () => {
  cleanup();
  await services?.dispose();
  services = undefined;
  vi.unstubAllGlobals();
  if (scrollIntoViewDescriptor)
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollIntoView",
      scrollIntoViewDescriptor,
    );
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

it("opens Drafts & sent inside Messages and retains the sidebar through Back/Forward", async () => {
  services = createServices();
  render(<App services={services} />);
  const drafts = await screen.findByRole("button", { name: "Drafts & sent" });
  await waitFor(() =>
    expect(services?.navigation.snapshot().status).toBe("opened"),
  );
  await userEvent.click(drafts);
  expect(
    await screen.findByRole("region", { name: "Drafts & sent" }),
  ).toBeVisible();
  expect(screen.getByRole("tab", { name: "Messages" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(document.getElementById("shell-navigation")).toHaveAttribute(
    "aria-hidden",
    "false",
  );
  expect(drafts).toHaveAttribute("aria-current", "page");
  act(() => {
    void services?.navigation.open({
      version: 1,
      kind: "settings",
      section: "appearance",
    });
  });
  await screen.findByRole("dialog", { name: "Settings" });
  expect(drafts).toHaveAttribute("aria-current", "page");
  await userEvent.click(screen.getByRole("button", { name: "Close Settings" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull(),
  );
  expect(drafts).toHaveAttribute("aria-current", "page");
  await waitFor(() =>
    expect(services?.navigation.snapshot().status).toBe("opened"),
  );
  act(() => services?.navigation.back());
  expect(
    await screen.findByRole("heading", {
      name: "Your channels, one conversation.",
    }),
  ).toBeVisible();
  act(() => services?.navigation.forward());
  expect(
    await screen.findByRole("region", { name: "Drafts & sent" }),
  ).toBeVisible();
  expect(document.getElementById("shell-navigation")).toHaveAttribute(
    "aria-hidden",
    "false",
  );
});

const legacyLinks = {
  "plugin page": {
    version: 1,
    kind: "page",
    pluginId: "buzz.drafts-sent",
    pageId: "drafts-sent",
    scope: null,
  },
  plugin: {
    version: 1,
    kind: "plugin",
    pluginId: "buzz.drafts-sent",
    pageId: "drafts-sent",
    scope: null,
  },
  "Messages route": {
    version: 1,
    kind: "page",
    pluginId: "buzz.channels",
    pageId: "channels",
    scope: null,
    route: { version: 1, params: "drafts-sent" },
  },
};
it.each(Object.keys(legacyLinks) as (keyof typeof legacyLinks)[])(
  "opens old %s links inside Messages without an extra history visit",
  async (kind) => {
    window.history.replaceState(
      null,
      "",
      `/#buzz=${encodeURIComponent(JSON.stringify(legacyLinks[kind]))}`,
    );
    services = createServices();
    const entryId = services.navigation.snapshot().entry.id;
    render(<App services={services} />);
    expect(
      await screen.findByRole("region", { name: "Drafts & sent" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(services?.navigation.snapshot().status).toBe("opened"),
    );
    expect(services.navigation.snapshot().entry.id).toBe(entryId);
    expect(services.navigation.snapshot().entry.target).toEqual({
      version: 1,
      kind: "page",
      pluginId: "buzz.drafts-and-sent",
      pageId: "drafts-sent",
      scope: null,
    });
    expect(screen.getByRole("tab", { name: "Messages" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  },
);
