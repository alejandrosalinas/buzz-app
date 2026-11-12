import { test, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

test("link previews draw web cards below messages and let a plugin claim its own links", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/link-previews.html`,
    );
    const rows = page.locator("[data-link-previews]");
    const first = rows.nth(0);
    const launch = first.getByRole("link", {
      name: /Buzz ships link previews/,
    });
    await expect(launch).toBeVisible();
    await expect(first).toContainText("Example News · news.example.com");
    await expect(first.locator("img")).toBeVisible();
    await expect(first.locator("[data-tracker-card]")).toHaveText(
      "Tracker issue 42 · In progress",
    );
    await expect(
      first.getByRole("link", { name: /tracker\.example\.com/ }),
    ).toHaveCount(0);

    const second = rows.nth(1);
    await expect(
      second.getByRole("link", { name: /Docs reached through a redirect/ }),
    ).toBeVisible();
    await expect(second.getByRole("link")).toHaveCount(1);
    const asked = await page.evaluate(() => window.linkPreviewFixture.asked);
    expect(asked).not.toContain("https://quiet.example.com/");
    expect(asked).not.toContain("https://code.example.com/");
    expect(asked.some((url) => url.includes("router.local"))).toBe(false);

    const third = rows.nth(2);
    await expect(third.getByRole("link")).toHaveCount(3);
    await third.getByRole("button", { name: "Show 2 more previews" }).click();
    await expect(third.getByRole("link")).toHaveCount(5);
    await third.getByRole("button", { name: "Show fewer previews" }).click();
    await expect(third.getByRole("link")).toHaveCount(3);

    await launch.click();
    await expect(page.getByRole("status")).toHaveText(
      "https://news.example.com/launch",
    );

    await page.getByRole("button", { name: "Disable tracker plugin" }).click();
    await expect(
      first.getByRole("link", { name: /Page at tracker\.example\.com/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Disable link previews" }).click();
    await expect(page.locator("[data-link-previews]")).toHaveCount(0);
    await page.getByRole("button", { name: "Enable link previews" }).click();
    await page.getByRole("button", { name: "Enable tracker plugin" }).click();
    await page.getByRole("button", { name: "Toggle theme" }).click();
    await expect(first.locator("[data-tracker-card]")).toBeVisible();
    await expect(launch).toBeVisible();
  } finally {
    await server.close();
  }
});
