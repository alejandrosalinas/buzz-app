import { expect, test } from "./playwright-test.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { createServer, warmUp } from "./vite-server.mjs";
import { watchPageErrors } from "./page-errors.mjs";

// Browser-only boundary: ancestor inertness and overlay hit testing cannot be
// established by an enabled-button assertion in jsdom. Keep the real index.html.
test("window controls stay usable through the launch overlay and identity handoff", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [
      react(),
      {
        name: "window-chrome-fixture",
        transformIndexHtml(html) {
          return html.replace(
            "/src/main.tsx",
            "/tests/fixtures/window-chrome.tsx",
          );
        },
      },
    ],
    define: { "import.meta.env.VITE_BUZZ_LIVE": '"0"' },
    server: { host: "127.0.0.1", port: 0 },
  });
  const errors = watchPageErrors(page);
  await page.addInitScript(() => {
    window.isTauri = true;
    Object.defineProperty(navigator, "platform", { value: "Linux x86_64" });
  });
  try {
    await server.listen();
    // The fixture mounts the real App, about 1,400 modules on a cold server;
    // compile them outside the navigation budget, which a busy runner can
    // otherwise exhaust.
    await warmUp(server, "/tests/fixtures/window-chrome.tsx");
    await page.setViewportSize({ width: 480, height: 400 });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
    await expect
      .poll(() => page.evaluate(() => window.windowChrome?.calls))
      .toEqual(["identity_restore"]);
    const root = page.locator("#root");
    await expect(root).toHaveAttribute("inert", "");
    await expect(root).toHaveAttribute("aria-hidden", "true");
    await expect(page.locator("#buzz-launch")).toBeVisible();
    const controls = page.getByRole("group", { name: "Window controls" });
    await expect(controls).toHaveCount(1);
    await expect(controls).toBeInViewport({ ratio: 1 });
    const minimize = controls.getByRole("button", { name: "Minimize window" });
    await page.keyboard.press("Tab");
    await expect(minimize).toBeFocused();
    await page.keyboard.press("Enter");
    await controls
      .getByRole("button", { name: "Maximize or restore window" })
      .click();
    await controls.getByRole("button", { name: "Close window" }).click();
    await expect
      .poll(() => page.evaluate(() => window.windowChrome.calls))
      .toEqual([
        "identity_restore",
        "plugin:window|minimize",
        "plugin:window|toggle_maximize",
        "plugin:window|close",
      ]);
    // The usable header must provide background hit targets, not just buttons.
    expect(
      await page.evaluate(() =>
        document
          .elementFromPoint(20, 20)
          ?.hasAttribute("data-tauri-drag-region"),
      ),
    ).toBe(true);
    // No window action may expose unfinished content.
    await expect(root).toHaveAttribute("inert", "");
    await page.evaluate(() => window.windowChrome.restore());
    await expect(page.locator("#buzz-launch")).toHaveCount(0);
    await expect(root).not.toHaveAttribute("inert");
    await expect(controls).toHaveCount(1);
    await expect(
      root.getByRole("group", { name: "Window controls" }),
    ).toHaveCount(1);
    await controls.getByRole("button", { name: "Close window" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.windowChrome.calls.filter(
              (command) => command === "plugin:window|close",
            ).length,
        ),
      )
      .toBe(2);
    await expect(
      page.getByRole("heading", { name: "Buzz", exact: true }),
    ).toBeVisible();
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await page.evaluate(() => window.windowChrome?.restore()).catch(() => {});
    await server.close();
  }
});
