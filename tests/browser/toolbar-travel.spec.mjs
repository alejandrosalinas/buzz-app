import { test, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";
import { fileURLToPath } from "node:url";

for (const density of ["default", "compact"])
  for (const layout of ["timeline", "thread", "continuation"]) {
    test(`toolbar travel preserves ${density} ${layout} ownership`, async ({
      page,
      context,
      browserName,
    }) => {
      const server = await createServer({
        root: fileURLToPath(new URL("../../", import.meta.url)),
        configFile: false,
        envFile: false,
        logLevel: "error",
        server: { host: "127.0.0.1", port: 0 },
      });
      await server.listen();
      try {
        // Travel is continuous input; CI scheduling must not create a 150ms idle.
        await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
        await page.clock.pauseAt(new Date("2026-01-01T00:01:00Z"));
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/toolbar-travel.html`,
        );
        await expect
          .poll(() => page.evaluate(() => !!window.toolbarFixture))
          .toBe(true);
        for (const own of [true, false])
          for (const direction of ["ltr", "rtl"]) {
            await page.setViewportSize({
              width:
                layout === "thread"
                  ? 650
                  : layout === "continuation"
                    ? 390
                    : 1200,
              height: 900,
            });
            await page.mouse.move(0, 0);
            await page.evaluate(
              ({ density, layout, own, direction }) => {
                document.documentElement.dataset.messageDensity = density;
                document.documentElement.dir = direction;
                document.documentElement.dataset.colorMode = own
                  ? "light"
                  : "dark";
                window.toolbarFixture.set({
                  layout,
                  own,
                  grouped: layout !== "thread",
                  content: "text",
                });
              },
              { density, layout, own, direction },
            );
            await expect
              .poll(() =>
                page.evaluate(
                  (expected) =>
                    document.querySelector("main").dataset.scenario ===
                    JSON.stringify(expected),
                  {
                    layout,
                    own,
                    grouped: layout !== "thread",
                    content: "text",
                  },
                ),
              )
              .toBe(true);
            await page.evaluate(() => document.fonts.ready);
            const row = page.locator('[data-message-id="b"]'),
              bubble = row.locator("[data-message-action-anchor]");
            await bubble.waitFor();
            await bubble.scrollIntoViewIfNeeded();
            const r = await bubble.boundingBox();
            const start = {
              x:
                direction === "ltr"
                  ? r.x + Math.min(25, r.width / 3)
                  : r.x + r.width - Math.min(25, r.width / 3),
              y: r.y + Math.min(5, r.height / 2),
            };
            const bar = row.locator("[data-message-actions]");
            for (const label of ["Add reaction", "More message actions"]) {
              await page.mouse.move(start.x, start.y);
              await page.clock.runFor(16);
              await expect
                .poll(() => bar.evaluate((n) => n.matches(":popover-open")))
                .toBe(true);
              await bar.evaluate((n) =>
                Promise.all(
                  n.getAnimations().map((a) => a.finished.catch(() => {})),
                ),
              );
              const button = await bar
                .getByRole("button", { name: label, exact: true })
                .boundingBox();
              await page.mouse.move(
                button.x + button.width / 2,
                button.y + button.height / 2,
                { steps: 30 },
              );
              await page.clock.runFor(16);
              await expect
                .poll(() => bar.evaluate((n) => n.matches(":popover-open")))
                .toBe(true);
              await expect(
                page.locator("[data-message-actions]:popover-open"),
              ).toHaveCount(1);
            }
          }
        if (
          density === "default" &&
          layout === "timeline" &&
          browserName === "chromium"
        ) {
          const row = page.locator('[data-message-id="b"]');
          const bar = row.locator("[data-message-actions]");
          const bubble = await row
            .locator("[data-message-action-anchor]")
            .boundingBox();
          expect(
            await page.evaluate(
              () => matchMedia("(hover: hover) and (pointer: fine)").matches,
            ),
          ).toBe(true);
          // Native touch on a fine-pointer desktop needs the Chromium input protocol.
          const cdp = await context.newCDPSession(page);
          try {
            const tap = async ({ x, y, width, height }) => {
              await cdp.send("Input.dispatchTouchEvent", {
                type: "touchStart",
                touchPoints: [{ x: x + width / 2, y: y + height / 2, id: 1 }],
              });
              await cdp.send("Input.dispatchTouchEvent", {
                type: "touchEnd",
                touchPoints: [],
              });
              await page.clock.runFor(16);
            };
            await tap(bubble);
            await expect
              .poll(() => bar.evaluate((n) => n.matches(":popover-open")))
              .toBe(true);
            await tap(
              await bar
                .getByRole("button", { name: "More message actions" })
                .boundingBox(),
            );
            await expect(page.getByRole("menu")).toBeVisible();
          } finally {
            await cdp.detach();
          }
        }
      } finally {
        await server.close();
      }
    });
  }

test("Compact media actions remain clickable with a scrolled byline and enlarged text", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  try {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/toolbar-travel.html`,
    );
    await page.waitForFunction(() => !!window.toolbarFixture);
    const options = {
      layout: "thread",
      own: true,
      grouped: false,
      content: "media",
    };
    await page.evaluate((options) => {
      document.documentElement.dataset.messageDensity = "compact";
      document.documentElement.style.setProperty("--buzz-text-scale", "2");
      window.toolbarFixture.set(options);
    }, options);
    await page.waitForFunction(
      (options) =>
        document.querySelector("main").dataset.scenario ===
        JSON.stringify(options),
      options,
    );
    await page.evaluate(() => document.fonts.ready);
    const row = page.locator('[data-message-id="b"]');
    await row.evaluate((n) => {
      const view = n.closest("[data-message-scroller]");
      view.scrollTop +=
        n.getBoundingClientRect().top - view.getBoundingClientRect().top + 14;
    });
    const bubble = row.locator("[data-message-action-anchor]");
    await bubble.hover();
    const bar = row.locator("[data-message-actions]");
    await expect
      .poll(() => bar.evaluate((n) => n.matches(":popover-open")))
      .toBe(true);
    await expect
      .poll(() =>
        bar.evaluate((n) => {
          const r = n.getBoundingClientRect(),
            v = n.closest("[data-message-scroller]").getBoundingClientRect();
          return r.top >= v.top && r.bottom <= v.bottom;
        }),
      )
      .toBe(true);
    await bar.getByRole("button", { name: "More message actions" }).click();
    await expect(page.getByRole("menu")).toBeVisible();
  } finally {
    await server.close();
  }
});
