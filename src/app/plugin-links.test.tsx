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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { PageProps } from "../features/pages/service";
import type { OpenTarget } from "../features/navigation/targets";
import { App } from "./App";
import { createServices, type AppServices } from "./services";

const gate = vi.hoisted(() => {
  const state = {
    held: Promise.resolve(),
    release: () => {},
    reset() {
      state.held = new Promise<void>((resolve) => {
        state.release = resolve;
      });
    },
  };
  return state;
});

function Params({ navigation }: PageProps) {
  const target = navigation?.target;
  return (
    <p>
      {target?.kind === "page" ? target.pageId : "?"}:
      {JSON.stringify(
        target?.kind === "page" ? (target.route?.params ?? null) : null,
      )}
    </p>
  );
}
const slugRoute = {
  version: 1,
  validate: (params: unknown) =>
    typeof params === "object" &&
    params !== null &&
    typeof (params as { slug?: unknown }).slug === "string" &&
    (params as { slug: string }).slug !== "forbidden",
};
vi.mock("../bundled", () => ({
  bundledPlugins: [
    {
      manifest: { id: "test.catalog", name: "Catalog", apiVersion: 1 },
      module: {
        inject: ["pages"],
        async apply(ctx: Context) {
          await gate.held;
          ctx.pages.register({ id: "list", title: "List", component: Params });
          ctx.pages.register({
            id: "entry",
            title: "Entry",
            primary: true,
            route: slugRoute,
            component: Params,
          });
        },
      },
    },
    {
      manifest: { id: "test.plain", name: "Plain", apiVersion: 1 },
      module: {
        inject: ["pages"],
        apply(ctx: Context) {
          ctx.pages.register({
            id: "first",
            title: "First",
            component: Params,
          });
          ctx.pages.register({
            id: "second",
            title: "Second",
            component: Params,
          });
        },
      },
    },
  ],
}));

beforeEach(() => {
  gate.reset();
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
let services: AppServices | undefined;
afterEach(async () => {
  gate.release();
  cleanup();
  await services?.dispose();
  services = undefined;
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

function start(target: OpenTarget) {
  window.history.replaceState(
    null,
    "",
    `/#buzz=${encodeURIComponent(JSON.stringify(target))}`,
  );
  const current = createServices();
  services = current;
  render(<App services={current} />);
  return current;
}
const link = (fields: Record<string, unknown>) =>
  ({ version: 1, kind: "plugin", ...fields }) as OpenTarget;

it("opens the primary page with validated link params once its plugin activates", async () => {
  const current = start(
    link({ pluginId: "test.catalog", params: { slug: "alpha" } }),
  );
  await waitFor(() =>
    expect(current.plugins.snapshot().activation["test.catalog"]?.status).toBe(
      "starting",
    ),
  );
  expect(current.navigation.snapshot().status).not.toBe("failed");
  await act(async () => gate.release());
  expect(await screen.findByText('entry:{"slug":"alpha"}')).toBeVisible();
  expect(current.navigation.snapshot()).toMatchObject({
    status: "opened",
    entry: {
      target: {
        kind: "page",
        pluginId: "test.catalog",
        pageId: "entry",
        route: { version: 1, params: { slug: "alpha" } },
      },
    },
    canGoBack: false,
  });
});

it("opens a named page, and the page without params when its validator refuses them", async () => {
  gate.release();
  const current = start(
    link({
      pluginId: "test.catalog",
      pageId: "entry",
      params: { slug: "forbidden" },
    }),
  );
  expect(await screen.findByText("entry:null")).toBeVisible();
  expect(current.navigation.snapshot().entry.target).not.toHaveProperty(
    "route",
  );
});

it("drops params for a page that declares no route", async () => {
  gate.release();
  start(
    link({ pluginId: "test.catalog", pageId: "list", params: { slug: "a" } }),
  );
  expect(await screen.findByText("list:null")).toBeVisible();
});

it("opens the first page of a plugin with no primary page", async () => {
  start(link({ pluginId: "test.plain" }));
  expect(await screen.findByText("first:null")).toBeVisible();
});

it.each([
  ["a plugin that is not installed", { pluginId: "test.absent" }],
  [
    "a page the plugin does not have",
    { pluginId: "test.plain", pageId: "nope" },
  ],
])("fails %s as unavailable", async (_name, fields) => {
  gate.release();
  const current = start(link(fields));
  expect(
    await screen.findByRole("heading", { name: "This page isn’t available" }),
  ).toBeVisible();
  expect(current.navigation.snapshot()).toMatchObject({
    status: "failed",
    reason: "unavailable",
  });
});

it("says a link's plugin is turned off and offers Manage plugins", async () => {
  localStorage.setItem(
    "buzzodz.plugins.v1",
    JSON.stringify({ version: 3, enabled: { "test.plain": false } }),
  );
  const current = start(link({ pluginId: "test.plain" }));
  const card = (
    await screen.findByRole("heading", { name: "Plain is turned off" })
  ).closest<HTMLElement>('[role="alert"]');
  if (!card) throw new Error("Expected the failure alert");
  expect(
    within(card).getByText("Turn it on in Manage plugins to open this page."),
  ).toBeVisible();
  // This fixture has no Messages page to go to.
  expect(
    within(card)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Manage plugins"]);
  expect(current.navigation.snapshot()).toMatchObject({
    status: "failed",
    reason: "unavailable",
  });
});
