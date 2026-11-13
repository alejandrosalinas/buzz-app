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

// Immutable build/server per worker; each test owns its page and fixture state.
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  directory = await mkdtemp(join(tmpdir(), "buzz-find-on-screen-"));
  const config = {
    root,
    configFile: false,
    envFile: false,
    logLevel: "error",
    plugins: [react()],
    build: {
      rollupOptions: {
        input: join(root, "tests/browser/find-on-screen.html"),
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
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/find-on-screen.html`;
});
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

const bar = (page) => page.locator("search");
const field = (page) => page.getByRole("searchbox", { name: "Find on screen" });
const box = (locator) =>
  locator.evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  });
// The active match's box, and whether it lies inside every clipping ancestor.
const activeMatch = (page) =>
  page.evaluate(() => {
    const [range] = CSS.highlights.get("buzz-find-active");
    const match = range.getBoundingClientRect();
    let shown = match.width > 0;
    for (let element = range.startContainer.parentElement; element; ) {
      const style = getComputedStyle(element);
      if (`${style.overflowX}${style.overflowY}` !== "visiblevisible") {
        const clip = element.getBoundingClientRect();
        shown &&=
          match.top >= clip.top &&
          match.bottom <= clip.bottom &&
          match.left >= clip.left &&
          match.right <= clip.right;
      }
      element = element.parentElement;
    }
    return { text: range.toString(), shown };
  });

// Layout: inside a dialog, the dialog's floating material becomes the
// containing block for fixed descendants and clips them; jsdom has no layout.
test("the bar keeps the window's top-right corner inside a dialog", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(url);
  await page.evaluate(() => window.openFind());
  await expect(field(page)).toBeFocused();
  const outside = await box(bar(page));
  await field(page).press("Escape");

  await page.evaluate(() => window.setModal(true));
  const dialog = page.getByRole("dialog", { name: "Members" });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => window.openFind());
  await expect(dialog.locator("search")).toHaveCount(1);
  await expect(field(page)).toBeFocused();
  expect(await box(bar(page))).toEqual(outside);

  // The dialog's own field stays clear of the bar and takes a click.
  const input = dialog.getByRole("textbox", { name: "Dialog field" });
  await input.click();
  await expect(input).toBeFocused();
  await expect(dialog).toBeVisible();
  expect(errors.unexplained()).toEqual([]);
});

// Geometry: a code block taller and wider than its scroller holds matches
// that centering the block can't reveal; jsdom has no range geometry.
test("stepping reveals each match in a long code block", async ({ page }) => {
  const errors = watchPageErrors(page);
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(url);
  await page.evaluate(() => window.openFind());
  await field(page).fill("needle");
  const status = page.locator("search [role=status]");
  await expect(status).toHaveText("1 of 2");
  expect(await activeMatch(page)).toEqual({ text: "needle", shown: true });
  await field(page).press("Enter");
  await expect(status).toHaveText("2 of 2");
  expect(await activeMatch(page)).toEqual({ text: "needle", shown: true });

  await field(page).fill("farright");
  await expect(status).toHaveText("1 of 1");
  await expect
    .poll(() => activeMatch(page))
    .toEqual({ text: "farright", shown: true });
  expect(errors.unexplained()).toEqual([]);
});
