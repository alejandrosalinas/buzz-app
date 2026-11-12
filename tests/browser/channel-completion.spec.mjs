import { test, expect } from "./playwright-test.mjs";
import { build, preview } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/postcss";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

let server, directory, fixture;
// A dev server serves this fixture as about 1,600 modules, and each test
// started its own. On a busy runner the first navigation took longer than the
// navigation timeout to load them, so build the page once and serve the bundle,
// as mentions.spec.mjs does.
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  directory = await mkdtemp(join(tmpdir(), "buzz-channel-completion-"));
  const config = {
    root,
    configFile: false,
    envDir: false,
    logLevel: "error",
    plugins: [react()],
    // Tailwind's optimizer and Vite's CSS minifier each round the 20/14
    // line-height token to 1.42857, which moves the popup 1/32px off the 4px
    // gap measured below. Serve the unrounded CSS the dev server served.
    css: { postcss: { plugins: [tailwindcss({ optimize: false })] } },
    // Development React, as the dev server served, keeps StrictMode's checks.
    define: {
      "import.meta.env.DEV": "true",
      "process.env.NODE_ENV": '"development"',
    },
    build: {
      rollupOptions: { input: join(root, "tests/fixtures/mentions.html") },
      outDir: join(directory, "dist"),
      emptyOutDir: true,
      target: "esnext",
      cssMinify: false,
    },
  };
  await build(config);
  server = await preview({
    ...config,
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  fixture = `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/mentions.html`;
});
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("channel completion preserves native editing, focus, popup geometry and signed send/reply content", async ({
  page,
}) => {
  // Browser boundary: real editor transactions/undo, portal layout and plugin-to-send wiring.
  // Channel eligibility, ranking and stale-list permutations live in colocated Vitest tests.
  const errors = watchPageErrors(page);
  await page.goto(`${fixture}?channels&stream&test-controls`);
  const input = page.getByRole("textbox");
  await expect(input).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.list().status))
    .toBe("ready");
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.reads().pending))
    .toBe(0);
  // A `#` query reads the public channel directory after its typing pause.
  // That read belongs to the query, so the baseline holds whichever side of
  // the pause a keystroke lands.
  const sessionReads = () =>
    page.evaluate(() => {
      const { kinds, queries } = window.mentionFixture.reads();
      return kinds.filter((_, index) => !queries[index]);
    });
  const reads = await sessionReads();
  expect(reads.length).toBeGreaterThan(0);
  const list = page.getByRole("listbox", { name: "Channel suggestions" });
  await input.pressSequentially("#");
  await expect(list.getByRole("option")).toHaveCount(2);
  await expect(input).toBeFocused();
  await expect
    .poll(() =>
      list.evaluate((element) => {
        const popup = element.parentElement;
        return (
          document.querySelector("form").getBoundingClientRect().top -
          popup.getBoundingClientRect().bottom
        );
      }),
    )
    .toBe(4);
  expect(
    await list.evaluate((element) => element.closest("form") === null),
  ).toBe(true);
  await expect(list.locator("..")).toHaveCSS("width", "480px");
  await input.press("ArrowDown");
  await expect(
    list.getByRole("option", { name: "Other Private channel" }),
  ).toHaveAttribute("aria-selected", "true");
  await input.press("Tab");
  await expect(list).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(input).toHaveJSProperty(
    "value",
    "[\\#Other](buzz://channel/other) ",
  );
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveJSProperty("value", "#");
  // Undo restores the replaced query selection. Collapse it before extending.
  await input.press("ArrowRight");
  await input.pressSequentially("Gen");
  await expect(list.getByRole("option")).toHaveCount(1);
  await input.press("Enter");
  await expect(input).toHaveJSProperty(
    "value",
    "[\\#General](buzz://channel/c) ",
  );
  await expect(input.locator("[data-link-renderer]")).toHaveText("General");
  await expect(
    input.locator('[data-link-renderer] svg[aria-hidden="true"]'),
  ).toHaveCount(1);
  await expect(input).toBeFocused();
  expect(await page.evaluate(() => window.mentionFixture.publications)).toEqual(
    [],
  );
  expect(await sessionReads()).toEqual(reads);
  // Stable IDs and source survive draft persistence, not just the mounted input.
  await page.reload();
  await expect(input).toHaveJSProperty(
    "value",
    "[\\#General](buzz://channel/c) ",
  );
  // The restored link edits as one chip with native keys: arrows step over
  // it, Delete removes it whole without exposing Markdown, undo restores it.
  await input.press("ControlOrMeta+ArrowDown");
  await input.press("ArrowLeft");
  await input.press("ArrowLeft");
  await expect(input).toHaveJSProperty(
    "value",
    "[\\#General](buzz://channel/c) ",
  );
  await input.press("Delete");
  await expect(input).toHaveJSProperty("value", " ");
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveJSProperty(
    "value",
    "[\\#General](buzz://channel/c) ",
  );
  await expect(input.locator("[data-link-renderer]")).toHaveText("General");
  await input.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.publications.length))
    .toBe(1);
  const sent = await page.evaluate(() => window.mentionFixture.publications[0]);
  expect(sent.content).toBe("[\\#General](buzz://channel/c)");
  expect(sent.tags).toContainEqual(["h", "c"]);
  expect(sent.tags.filter(([name]) => name === "p")).toEqual([]);
  await page.getByRole("button", { name: "Toggle thread" }).click();
  await input.pressSequentially("#Ot");
  await list.getByRole("option", { name: "Other Private channel" }).click();
  await expect(input).toBeFocused();
  await expect(input).toHaveJSProperty(
    "value",
    "[\\#Other](buzz://channel/other) ",
  );
  await input.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.publications.length))
    .toBe(2);
  const reply = await page.evaluate(
    () => window.mentionFixture.publications[1],
  );
  expect(reply.content).toBe("[\\#Other](buzz://channel/other)");
  expect(reply.tags).toContainEqual(["e", "a".repeat(64), "", "reply"]);
  expect(reply.tags.filter(([name]) => name === "p")).toEqual([]);
  // Rich marks and autocomplete share one native transaction owner.
  for (const shortcut of ["ControlOrMeta+b", "ControlOrMeta+i"]) {
    await input.press(shortcut);
    await input.pressSequentially("#Gen");
    await expect(list.getByRole("option")).toHaveCount(1);
    await input.press("Enter");
    await expect(input).toHaveJSProperty(
      "value",
      "[\\#General](buzz://channel/c) ",
    );
    await expect(input.locator("[data-link-renderer]")).toHaveText("General");
    await expect(
      input.locator('[data-link-renderer] svg[aria-hidden="true"]'),
    ).toHaveCount(1);
    await input.press(shortcut);
    await input.press("ControlOrMeta+a");
    await input.press("Backspace");
  }
  await input.pressSequentially("PR #1234");
  await expect(input).toHaveJSProperty("value", "PR #1234");
  await expect(list).toHaveCount(0);
  await input.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.publications.length))
    .toBe(3);
  expect(
    await page.evaluate(() => window.mentionFixture.publications[2].content),
  ).toBe("PR #1234");
  await page.setViewportSize({ width: 360, height: 740 });
  await input.pressSequentially("#");
  await expect(list).toBeVisible();
  const bounds = await list.locator("..").boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(740);
  await input.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(input).toHaveJSProperty("value", "#");
  expect(errors.unexplained()).toEqual([]);
});

test("channel completion finds an open channel the viewer has not joined", async ({
  page,
}) => {
  // Browser boundary: the real store's public search and its read-only preview.
  const errors = watchPageErrors(page);
  await page.goto(`${fixture}?channels&stream&open-channels&test-controls`);
  const input = page.getByRole("textbox");
  await expect(input).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.list().status))
    .toBe("ready");
  const list = page.getByRole("listbox", { name: "Channel suggestions" });
  await input.pressSequentially("#Ge");
  const options = list.getByRole("option");
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText("General");
  await expect(options.nth(1)).toContainText("Gemstones");
  await expect(options.nth(1)).toContainText("Not joined");
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(input).toHaveJSProperty(
    "value",
    "[\\#Gemstones](buzz://channel/open) ",
  );
  // Each edit remounts the completion. While the next lookup is held, the
  // still-matching open row stays, so Enter completes instead of sending.
  await input.press("ControlOrMeta+a");
  await input.press("Backspace");
  await input.pressSequentially("#Gem");
  await expect(options).toHaveCount(1);
  await expect(options.nth(0)).toContainText("Gemstones");
  await page.evaluate(() => window.mentionFixture.holdChannelReads());
  await input.pressSequentially("s");
  await expect(
    page.getByRole("status").filter({ hasText: "Searching open channels…" }),
  ).toBeVisible();
  await expect(options).toHaveCount(1);
  await input.press("Enter");
  await expect(input).toHaveJSProperty(
    "value",
    "[\\#Gemstones](buzz://channel/open) ",
  );
  expect(await page.evaluate(() => window.mentionFixture.publications)).toEqual(
    [],
  );
  await page.evaluate(() => window.mentionFixture.releaseChannelReads());
  expect(errors.unexplained()).toEqual([]);
});
