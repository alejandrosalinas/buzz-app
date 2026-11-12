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
  directory = await mkdtemp(join(tmpdir(), "buzz-changesets-"));
  const config = {
    root,
    configFile: false,
    envFile: false,
    logLevel: "error",
    plugins: [react()],
    build: {
      rollupOptions: { input: join(root, "tests/browser/changesets.html") },
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
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/changesets.html`;
});
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

// The desktop-only plugin can't run in the browser build, so this renders its
// real card, panel and Diff viewer over a scripted git and a seeded turn.
for (const { name, width, theme, large } of [
  { name: "wide, light", width: 1280, theme: "light" },
  { name: "wide, dark", width: 1280, theme: "dark" },
  { name: "narrow, light", width: 420, theme: "light" },
  {
    name: "narrow, dark, enlarged text",
    width: 420,
    theme: "dark",
    large: true,
  },
]) {
  test(`shows a turn's changes and opens a diff (${name})`, async ({
    page,
  }) => {
    const { unexplained } = watchPageErrors(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${url}?theme=${theme}${large ? "&large" : ""}`);

    const local = page.getByRole("article", { name: "Local agent's reply" });
    const card = local.getByRole("region", { name: "Changeset: app (main)" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("3 files changed");
    await expect(
      card.getByRole("button", { name: /src\/app\.ts/ }),
    ).toBeVisible();
    await expect(card.getByRole("button", { name: /logo\.png/ })).toContainText(
      "binary",
    );

    // Pointer opens the diff beside the chat.
    await card.getByRole("button", { name: /src\/app\.ts/ }).click();
    const panel = page.getByRole("complementary", { name: "Changes" });
    await expect(panel).toBeVisible();
    await expect(panel.getByText("const retries = 3;")).toBeVisible();
    await expect(panel.getByText("const delay = 250;")).toBeVisible();

    // Keyboard steps to the next file; a binary file has no text diff.
    const next = panel.getByRole("button", { name: "Next file" });
    await next.focus();
    await page.keyboard.press("Enter");
    await expect(panel.getByText("export const answer = 42;")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(panel.getByText(/Binary file/)).toBeVisible();
    await expect(panel.getByRole("button", { name: "Try again" })).toHaveCount(
      0,
    );

    // Nothing sideways: the page never scrolls horizontally.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBeLessThanOrEqual(0);
    expect(unexplained()).toEqual([]);
  });
}

test("shows no card for a remote agent and never runs git for its turn", async ({
  page,
}) => {
  await page.goto(url);
  const remote = page.getByRole("article", { name: "Remote agent's reply" });
  await expect(remote).toBeVisible();
  await expect(page.getByRole("region", { name: /Changeset/ })).toHaveCount(1);
  const before = await page.evaluate(() => window.gitCalls.length);
  await page.evaluate(() => window.runRemoteTurn());
  expect(await page.evaluate(() => window.gitCalls.length)).toBe(before);
  await expect(remote.getByRole("region")).toHaveCount(0);
});
