import { expect, test } from "./playwright-test.mjs";
import { build, preview } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

let server;
let directory;
let url;

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  directory = await mkdtemp(join(tmpdir(), "buzz-sidebar-reveal-"));
  const config = {
    root,
    configFile: false,
    envFile: false,
    logLevel: "error",
    plugins: [react()],
    build: {
      rollupOptions: {
        input: join(root, "tests/browser/sidebar-reveal.html"),
      },
      outDir: join(directory, "dist"),
      emptyOutDir: true,
      target: "esnext",
    },
  };
  await build(config);
  server = await preview({
    ...config,
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/sidebar-reveal.html`;
});
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

const key = `buzz-view.v1:${JSON.stringify(["fixture", "channel-sidebar"])}`;
const open = async (page) => {
  await page.goto(url);
  // Navigation can finish before React's first render publishes the fixture API.
  await page.waitForFunction(
    () => typeof window.sidebar?.update === "function",
  );
};
// Scroll events dispatch in the rendering step, before animation frames.
const settle = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
const update = (page, next) =>
  page.evaluate((next) => window.sidebar.update(next), next);
const rows = (page, count) =>
  page.evaluate(
    (count) => window.sidebar.update({ rows: window.sidebar.rows(count) }),
    count,
  );

// jsdom does not reject focus inside hidden/inert content. Use the real row
// and disclosure owners here; preference-refresh permutations stay in Vitest.
test("focus skips a row relocated into a collapsed section", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  await open(page);
  await update(page, { relocated: false });
  const beta = page.locator('button[data-channel-id="beta"]');
  await beta.focus();
  await expect(beta).toBeFocused();

  await update(page, { relocated: true });

  await expect(
    page.locator('[data-sidebar-section="starred"] [data-channel-id="beta"]'),
  ).toBeHidden();
  await expect(
    page.getByRole("button", { name: "gamma", exact: true }),
  ).toBeFocused();
  expect(errors).toEqual([]);
});

test("restoring the saved position does not cancel a delayed entry's reveal", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  await open(page);
  await page.evaluate(
    ([key, value]) => localStorage.setItem(key, JSON.stringify(value)),
    [key, { collapsed: [], scrollTop: 800, width: 260, location: "row:5" }],
  );
  const sidebar = page.getByRole("navigation", {
    name: "Sidebar",
    exact: true,
  });
  // Remount at another destination whose entry is still being looked up.
  await page.evaluate(() =>
    window.sidebar.update({
      mounted: true,
      at: "row:45",
      rows: window.sidebar.rows(45),
    }),
  );
  await expect
    .poll(() => sidebar.evaluate((element) => element.scrollTop))
    .toBe(800);
  // Let the restoration's scroll event dispatch before the entry arrives.
  await settle(page);
  await rows(page, 50);
  await expect(sidebar.locator('[data-row="45"]')).toBeInViewport({
    ratio: 1,
  });
  expect(errors).toEqual([]);
});

test("a user scroll before a delayed entry renders keeps that position for its destination", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  await open(page);
  const sidebar = page.getByRole("navigation", {
    name: "Sidebar",
    exact: true,
  });
  await rows(page, 45);
  await update(page, { mounted: true });
  await expect(sidebar.locator('[data-row="0"]')).toHaveAttribute(
    "aria-current",
    "page",
  );
  await update(page, { at: "row:45" });
  // The user scrolls before the destination's entry renders.
  await sidebar.hover();
  await page.mouse.wheel(0, 200);
  await expect
    .poll(() => sidebar.evaluate((element) => element.scrollTop))
    .toBe(200);
  await settle(page);
  await rows(page, 50);
  await expect(sidebar.locator('[data-row="45"]')).toHaveAttribute(
    "aria-current",
    "page",
  );
  await settle(page);
  // The user's scroll wins over the late reveal.
  expect(await sidebar.evaluate((element) => element.scrollTop)).toBe(200);
  // Leave (Settings replaces the sidebar) and come back to the same place.
  await update(page, { mounted: false });
  await update(page, { mounted: true });
  await expect(sidebar.locator('[data-row="45"]')).toHaveAttribute(
    "aria-current",
    "page",
  );
  await settle(page);
  expect(await sidebar.evaluate((element) => element.scrollTop)).toBe(200);
  expect(errors).toEqual([]);
});

test("late contributed rows retry the sidebar reveal without moving the owner", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  await open(page);
  const sidebar = page.getByRole("navigation", {
    name: "Sidebar",
    exact: true,
  });
  await page.evaluate(() =>
    window.sidebar.update({
      mounted: true,
      at: "conversation:late",
      rows: window.sidebar.rows(50),
    }),
  );
  const contributedRow = sidebar.getByRole("button", { name: "Late item" });
  await expect(contributedRow).toHaveCount(0);

  // This external-store publication rerenders SectionContents, not Sidebar.
  await page.evaluate(() =>
    window.sidebar.publishContributionRows([
      { id: "late", label: "Late item" },
    ]),
  );
  await expect(contributedRow).toBeInViewport({ ratio: 0.9 });
  await expect(contributedRow).toHaveAttribute("aria-current", "page");
  expect(errors).toEqual([]);
});

test("a focus scroll survives a layout change before its scroll event", async ({
  page,
}) => {
  await open(page);
  await update(page, { mounted: true, anchored: true });
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const destination = sidebar.locator('[data-row="20"]');
  await sidebar.evaluate(async (viewport) => {
    const scrolled = new Promise((resolve) =>
      viewport.addEventListener("scroll", resolve, { once: true }),
    );
    viewport.scrollTop = 160;
    await scrolled;
  });
  await expect(destination).not.toBeInViewport();

  await destination.evaluate((row) => {
    const viewport = row.closest("nav");
    const scrolled = new Promise((resolve) =>
      viewport.addEventListener("scroll", resolve, { once: true }),
    );
    row.tabIndex = -1;
    row.focus();
    viewport.querySelector('[data-row="0"]').style.height = "72px";
    return scrolled;
  });

  await expect(destination).toBeFocused();
  await expect(destination).toBeInViewport({ ratio: 1 });
});

test("a delayed reveal that lands in place takes precedence over the old anchor", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  await open(page);
  await update(page, { mounted: true, anchored: true });
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const current = sidebar.locator('[data-row="0"]');
  await expect(current).toHaveAttribute("aria-current", "page");
  const baseline = await sidebar.evaluate((viewport) => {
    const row = viewport.querySelector('[data-row="4"]');
    viewport.scrollTop +=
      row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    return viewport.scrollTop;
  });
  expect(baseline).toBeGreaterThan(0);
  await settle(page);
  await update(page, { at: "row:55" });
  await expect(current).not.toHaveAttribute("aria-current", "page");
  await page.evaluate(() => {
    const rows = window.sidebar.rows(50);
    rows.splice(4, 0, 55);
    window.sidebar.update({ rows });
  });
  const destination = sidebar.locator('[data-row="55"]');
  await expect(destination).toHaveAttribute("aria-current", "page");
  await settle(page);
  expect(await sidebar.evaluate((viewport) => viewport.scrollTop)).toBe(
    baseline,
  );
  await expect(destination).toBeInViewport({ ratio: 1 });
  expect(errors).toEqual([]);
});

test("a refresh does not follow the only sampled row when it leaves view", async ({
  page,
}) => {
  await open(page);
  await update(page, { mounted: true, anchored: true });
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const nearby = sidebar.locator('[data-row="7"]');
  await expect(nearby).toBeAttached();
  const before = await sidebar.evaluate((viewport) => {
    viewport.scrollTop = 160;
    return viewport.scrollTop;
  });
  await settle(page);
  await expect(nearby).toBeInViewport({ ratio: 1 });

  await page.evaluate(() => {
    const rows = window.sidebar.rows(50);
    rows.splice(4, 3);
    window.sidebar.update({ rows: [6, ...rows] });
  });
  await expect(sidebar.locator("[data-row]").first()).toHaveText("Row 6");
  await settle(page);
  expect(await sidebar.evaluate((viewport) => viewport.scrollTop)).toBe(before);
  await expect(nearby).toBeInViewport({ ratio: 1 });
});

for (const count of [2, 3]) {
  test(`a refresh keeps the nearby row when ${count} rows move to the top`, async ({
    page,
  }) => {
    await open(page);
    await update(page, { mounted: true, anchored: true });
    const sidebar = page.getByRole("navigation", {
      name: "Subscribed channels",
    });
    const nearby = sidebar.locator(`[data-row="${4 + count}"]`);
    await expect(nearby).toBeAttached();
    const before = await sidebar.evaluate((viewport) => {
      viewport.scrollTop = 160;
      return viewport.scrollTop;
    });
    await settle(page);

    await page.evaluate((count) => {
      const rows = window.sidebar.rows(50);
      const promoted = rows.splice(4, count);
      window.sidebar.update({ rows: [...promoted, ...rows] });
    }, count);
    await expect(sidebar.locator("[data-row]").first()).toHaveText("Row 4");
    await settle(page);
    expect(await sidebar.evaluate((viewport) => viewport.scrollTop)).toBe(
      before,
    );
    await expect(nearby).toBeInViewport({ ratio: 1 });
  });
}

test("a height change above the viewport keeps the visible row in place", async ({
  page,
}) => {
  await open(page);
  await update(page, { mounted: true, anchored: true });
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const row = sidebar.locator('[data-row="4"]');
  await expect(row).toBeAttached();
  await sidebar.evaluate((viewport) => {
    viewport.scrollTop = 160;
  });
  await settle(page);
  const position = () =>
    row.evaluate(
      (row) =>
        row.getBoundingClientRect().top -
        row.closest("nav").getBoundingClientRect().top,
    );
  const before = await position();

  await sidebar.locator('[data-row="0"]').evaluate((row) => {
    row.style.height = "280px";
  });
  await settle(page);
  expect(await position()).toBe(before);
});

test("a refresh anchors to a surviving Team row while removed rows fade", async ({
  page,
}) => {
  await open(page);
  await update(page, { mounted: true, anchored: true, animated: true });
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const survivor = sidebar.locator('[data-row="6"]');
  await expect(survivor).toBeAttached();
  await sidebar.evaluate((viewport) => {
    viewport.scrollTop = 160;
  });
  await settle(page);
  const offset = () =>
    survivor.evaluate(
      (row) =>
        row.getBoundingClientRect().top -
        row.closest("nav").getBoundingClientRect().top,
    );
  const before = await offset();

  await page.evaluate(() => {
    const rows = window.sidebar.rows(50);
    rows.splice(4, 2, 60);
    window.sidebar.update({ rows });
  });
  await expect(sidebar.locator('[data-row="4"]')).toHaveCount(0);
  await expect(sidebar.locator('[data-row="5"]')).toHaveCount(0);
  expect(await offset()).toBe(before);
});

test("a wheel scroll during a row slide stays put through the next reorder", async ({
  page,
}) => {
  await open(page);
  await update(page, { mounted: true, anchored: true, animated: true });
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  await expect(sidebar.locator('[data-row="4"]')).toBeAttached();
  const initial = await sidebar.evaluate((viewport) => {
    viewport.scrollTop = 160;
    return viewport.scrollTop;
  });
  await settle(page);
  await sidebar.evaluate((viewport) => {
    const observer = new MutationObserver(() => {
      const moving = [...viewport.querySelectorAll("[data-moving]")];
      if (!moving.length) return;
      observer.disconnect();
      for (const row of moving) {
        for (const slide of row.getAnimations()) {
          slide.pause();
          slide.currentTime = 20;
        }
      }
    });
    observer.observe(viewport, {
      subtree: true,
      attributeFilter: ["data-moving"],
    });
    const rows = window.sidebar.rows(50);
    rows.splice(4, 6, 6, 4, 5, 9, 7, 8);
    window.sidebar.update({ rows });
  });
  const moving = sidebar.locator("[data-moving]");
  await expect(moving).toHaveCount(6);
  await sidebar.hover();
  const preWheel = await sidebar.evaluate((viewport) => viewport.scrollTop);
  await page.mouse.wheel(0, 8);
  await expect
    .poll(() => sidebar.evaluate((viewport) => viewport.scrollTop))
    .toBe(preWheel + 8);
  await settle(page);
  const afterWheel = await sidebar.evaluate((viewport) => {
    for (const row of viewport.querySelectorAll("[data-moving]")) {
      for (const slide of row.getAnimations()) slide.finish();
    }
    return viewport.scrollTop;
  });
  expect(initial).toBeGreaterThan(0);
  await expect(moving).toHaveCount(0);
  await settle(page);
  expect(await sidebar.evaluate((viewport) => viewport.scrollTop)).toBe(
    afterWheel,
  );
  await page.evaluate(() => {
    const rows = window.sidebar.rows(50);
    rows.splice(4, 6, 6, 4, 7, 9, 5, 8);
    window.sidebar.update({ rows });
  });
  await expect(sidebar.locator("[data-row]").nth(6)).toHaveText("Row 7");
  await expect(moving).toHaveCount(0);
  await settle(page);
  expect(await sidebar.evaluate((viewport) => viewport.scrollTop)).toBe(
    afterWheel,
  );
});

test("a user scroll before contributed rows arrive cancels their reveal", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  await open(page);
  const sidebar = page.getByRole("navigation", {
    name: "Sidebar",
    exact: true,
  });
  await page.evaluate(() =>
    window.sidebar.update({
      mounted: true,
      at: "conversation:late",
      rows: window.sidebar.rows(50),
    }),
  );
  await sidebar.hover();
  await page.mouse.wheel(0, 200);
  await expect
    .poll(() => sidebar.evaluate((element) => element.scrollTop))
    .toBe(200);
  await settle(page);

  await page.evaluate(() =>
    window.sidebar.publishContributionRows([
      { id: "late", label: "Late item" },
    ]),
  );
  const contributedRow = sidebar.getByRole("button", { name: "Late item" });
  await expect(contributedRow).toHaveAttribute("aria-current", "page");
  await settle(page);
  expect(await sidebar.evaluate((element) => element.scrollTop)).toBe(200);
  await expect(contributedRow).not.toBeInViewport();
  expect(errors).toEqual([]);
});
