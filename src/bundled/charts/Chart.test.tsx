// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  act,
  cleanup,
  configure,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationService } from "../../features/conversation/service";
import { MessageMarkdown } from "../../features/messages/MessageMarkdown";
import { createPluginManager } from "../../plugins/manager";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { bundledPlugins } from "..";
import { Chart } from "./Chart";
import { ChartExpand } from "./ChartExpand";
import * as charts from "./index";
import manifest from "./manifest.json";

const appearance = vi.hoisted(() => ({ failing: false }));
vi.mock("./theme", async (importOriginal) => {
  const original = await importOriginal<typeof import("./theme")>();
  return {
    hostTheme: (node: HTMLElement) => {
      if (appearance.failing) throw new Error("theme");
      const theme = original.hostTheme(node);
      const dark = document.documentElement.dataset.colorMode === "dark";
      return {
        ...theme,
        textStyle: { ...theme.textStyle, color: dark ? "#e0e0e0" : "#202020" },
      };
    },
  };
});

// The first draw loads ECharts, which is slow while many files import in parallel.
configure({ asyncUtilTimeout: 15_000 });
vi.setConfig({ testTimeout: 30_000 });

const disposals: (() => Promise<unknown>)[] = [];
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(320);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(async () => {
  cleanup();
  for (const dispose of disposals.splice(0)) await dispose();
  localStorage.removeItem("buzzodz.plugins.v1");
  delete document.documentElement.dataset.colorMode;
  appearance.failing = false;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const chart = {
  version: 1,
  type: "line",
  title: "Weekly reviews",
  x: "week",
  y: "reviews",
  series: "team",
  data: [
    { week: 1, reviews: 8, team: "Web" },
    { week: 2, reviews: 11, team: "Web" },
    { week: 1, reviews: 5, team: "Relay" },
  ],
  source: {
    name: "Review stats",
    url: "https://example.com/stats",
    metric: "reviews",
  },
  note: "Illustration only",
};
const code = JSON.stringify(chart);
const drawn = (container: HTMLElement) =>
  container.querySelector('[role="img"] svg');

it("draws buzz-chart fences in messages while the bundled plugin is enabled", async () => {
  expect(
    bundledPlugins.find((plugin) => plugin.manifest.id === "buzz.charts")
      ?.enabledByDefault,
  ).toBe(false);
  const ctx = new Context();
  const plugins = createPluginManager(ctx, {
    bundled: [{ manifest: { ...manifest, apiVersion: 1 }, module: charts }],
  });
  const service = new ConversationService(ctx);
  disposals.push(async () => {
    await plugins.dispose();
    await ctx.fiber.dispose();
  });
  const view = render(
    <MessageMarkdown
      row={{
        id: "message",
        channelId: "channel",
        authorId: "author",
        content: `Trend:\n\n\`\`\`buzz-chart\n${code}\n\`\`\``,
        createdAt: 1,
        mentions: [],
        participants: [],
        attachments: [],
        reactions: [],
        replyCount: 0,
      }}
      extensions={service}
      media={() => undefined}
      onOpenLink={() => false}
    />,
    { wrapper: ToastProvider },
  );
  await waitFor(() => expect(drawn(view.container)).not.toBeNull());
  expect(view.container.querySelector("pre")).toBeNull();
  expect(screen.getByRole("figure")).toHaveAccessibleName("Weekly reviews");
  expect(
    screen.getAllByRole("button").map((button) => button.ariaLabel),
  ).toContain("Expand chart");

  await act(() => plugins.change("disable", "buzz.charts"));
  expect(drawn(view.container)).toBeNull();
  expect(view.container.querySelector("pre code")).toHaveClass(
    "language-buzz-chart",
  );
});

it("draws the plot with its title, source link, note and data rows", async () => {
  const user = userEvent.setup();
  const view = render(<Chart code={code} />);
  await waitFor(() => expect(drawn(view.container)).not.toBeNull());
  expect(view.container.querySelector("figcaption")).toHaveTextContent(
    "Weekly reviews",
  );
  expect(drawn(view.container)).toHaveTextContent("Web");
  const link = screen.getByRole("link", { name: /Review stats/ });
  expect(link).toHaveTextContent("Review stats (example.com)");
  expect(link).toHaveAttribute("href", "https://example.com/stats");
  expect(link).toHaveAttribute("target", "_blank");
  expect(link.getAttribute("rel")).toContain("noopener");
  expect(screen.getByText(/· reviews/)).toBeVisible();
  expect(screen.getByText("Illustration only")).toBeVisible();

  expect(screen.queryByRole("table")).toBeNull();
  await user.click(screen.getByRole("button", { name: "View 3 data rows" }));
  const table = await screen.findByRole("table");
  expect(within(table).getAllByRole("row")).toHaveLength(4);
  expect(within(table).getByRole("cell", { name: "Relay" })).toBeVisible();
});

it("shows no attribution without a source, and never links an unsafe one", async () => {
  const { source, ...unattributed } = chart;
  const view = render(<Chart code={JSON.stringify(unattributed)} />);
  await waitFor(() => expect(drawn(view.container)).not.toBeNull());
  expect(screen.queryByText(/Source:/)).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();

  view.rerender(
    <Chart
      code={JSON.stringify({
        ...chart,
        source: { ...source, url: "javascript:alert(1)" },
      })}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(/HTTPS/);
  expect(screen.queryByRole("link")).toBeNull();
});

it("draws version 2 options at the requested height", async () => {
  const view = render(
    <Chart
      code={JSON.stringify({
        version: 2,
        title: "Review time",
        height: 280,
        option: {
          series: [{ type: "pie", data: [{ name: "Waiting", value: 45 }] }],
        },
      })}
    />,
  );
  await waitFor(() => expect(drawn(view.container)).not.toBeNull());
  expect(view.container.querySelector('[role="img"]')).toHaveStyle({
    "--chart-height": "280px",
  });
  expect(drawn(view.container)).toHaveTextContent("Waiting");
});

it("shows the error and source for an invalid chart, then recovers", async () => {
  const broken = '{"version":1,"type":"bar"}';
  const view = render(<Chart code={broken} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(/title/);
  expect(screen.getByText(broken)).toBeVisible();
  expect(view.container.querySelector("svg")).toBeNull();

  view.rerender(<Chart code={code} />);
  await waitFor(() => expect(drawn(view.container)).not.toBeNull());
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(broken)).toBeNull();
});

it("caps the source it echoes for an unreadable chart", async () => {
  render(<Chart code={`${"x".repeat(10_000)}SECRET_END`} />);
  expect(await screen.findByText(/source truncated/)).toBeVisible();
  expect(screen.queryByText(/SECRET_END/)).toBeNull();
});

it("shows the source when the chart cannot be drawn", async () => {
  appearance.failing = true;
  const view = render(<Chart code={code} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This chart couldn't be drawn.",
  );
  expect(screen.getByText(code)).toBeVisible();
  expect(view.container.querySelector("svg")).toBeNull();
});

it("redraws in the new colors when the host theme changes", async () => {
  const view = render(<Chart code={code} />);
  await waitFor(() => expect(drawn(view.container)).not.toBeNull());
  expect(drawn(view.container)?.innerHTML).toContain("#202020");
  act(() => {
    document.documentElement.dataset.colorMode = "dark";
  });
  await waitFor(() =>
    expect(drawn(view.container)?.innerHTML).toContain("#e0e0e0"),
  );
});

it("expands the chart in a dialog and restores focus on close", async () => {
  const user = userEvent.setup();
  render(<ChartExpand code={code} />, { wrapper: ToastProvider });
  const expand = screen.getByRole("button", { name: "Expand chart" });
  await user.click(expand);
  const dialog = await screen.findByRole("dialog", { name: "Chart" });
  await waitFor(() => expect(drawn(dialog)).not.toBeNull());
  expect(within(dialog).queryByRole("button", { name: /copy/i })).toBeNull();
  await user.click(within(dialog).getByRole("button", { name: "Close chart" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Chart" })).toBeNull(),
  );
  expect(expand).toHaveFocus();
});
