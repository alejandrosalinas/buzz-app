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
  directory = await mkdtemp(join(tmpdir(), "buzz-reminders-layout-"));
  const config = {
    root,
    configFile: false,
    envFile: false,
    logLevel: "error",
    plugins: [react()],
    build: {
      rollupOptions: {
        input: join(root, "tests/browser/reminders-layout.html"),
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
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/reminders-layout.html`;
});
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

// 480 is the desktop minimum window width; 390 is a narrower content region.
for (const width of [480, 390]) {
  test(`reminder rows stay readable and contained at ${width}px`, async ({
    page,
  }) => {
    const { errors } = watchPageErrors(page);
    await page.setViewportSize({ width: 800, height: 900 });
    await page.goto(`${url}?width=${width}`);
    const rows = page.getByRole("listitem");
    await expect(rows).toHaveCount(2);
    for (const row of await rows.all()) {
      const box = await row.boundingBox();
      const geometry = await row.evaluate((el) => ({
        overflow: el.scrollWidth - el.clientWidth,
        // The message navigation target keeps the text width independent of completion.
        text: el.querySelector("button.navigation-item").getBoundingClientRect()
          .width,
      }));
      expect(geometry.overflow, "row content stays inside the row").toBe(0);
      expect(geometry.text, "text keeps a readable width").toBeGreaterThan(
        width / 2,
      );
      for (const button of await row.getByRole("button").all()) {
        const control = await button.boundingBox();
        expect(control.x).toBeGreaterThanOrEqual(box.x);
        expect(control.x + control.width).toBeLessThanOrEqual(
          box.x + box.width,
        );
      }
    }
    // The due date reads on one line rather than one word per line.
    const due = rows.first().locator("time");
    const lineHeight = await due.evaluate((el) =>
      Number.parseFloat(getComputedStyle(el).lineHeight),
    );
    expect((await due.boundingBox()).height).toBeLessThan(lineHeight * 1.5);
    // A note is read only here, so it wraps in full rather than clamping.
    const note = page.getByText("x".repeat(2000), { exact: true });
    expect(
      await note.evaluate((el) => el.scrollHeight - el.clientHeight),
      "the whole note is visible",
    ).toBe(0);
    expect((await note.boundingBox()).height).toBeGreaterThan(lineHeight * 3);
    // Compact time and ellipsis triggers retain pointer menus in the real browser.
    await rows
      .first()
      .getByRole("button", { name: "Snooze: Ada Lovelace" })
      .click();
    await expect(
      page.getByRole("menuitem", { name: /^In 1 hour/ }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await rows
      .first()
      .getByRole("button", { name: "More actions: Ada Lovelace" })
      .click();
    await expect(
      page.getByText("Ada Lovelace · #release-planning", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Open message", exact: true }),
    ).toBeVisible();
    const cancel = page.getByRole("menuitem", {
      name: "Cancel reminder",
      exact: true,
    });
    // Keyboard highlight uses the same danger fill as pointer highlight.
    // Base UI ignores WebKit's zero-delta synthetic hover events.
    await page
      .getByRole("menuitem", { name: "Open message", exact: true })
      .focus();
    await page.keyboard.press("ArrowDown");
    await expect(cancel).toHaveAttribute("data-highlighted", "");
    const danger = await cancel.evaluate((el) => ({
      color: getComputedStyle(el).color,
      icon: getComputedStyle(el.querySelector("svg")).color,
      background: getComputedStyle(el).backgroundColor,
    }));
    expect(danger.icon).toBe(danger.color);
    expect(danger.background).not.toBe("rgba(0, 0, 0, 0)");
    await page.keyboard.press("Escape");
    // Reduced motion keeps a visible static boundary, and keyboard activation
    // still opens the same snooze choices after the border treatment changes.
    const snooze = rows
      .first()
      .getByRole("button", { name: "Snooze: Ada Lovelace" });
    const dashOffset = () =>
      snooze
        .locator("rect")
        .evaluate((el) => getComputedStyle(el).strokeDashoffset);
    const initialOffset = await dashOffset();
    await expect.poll(dashOffset).not.toBe(initialOffset);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const border = await snooze.evaluate((el) => {
      const outline = el.querySelector(".buzz-button-attention");
      const stroke = getComputedStyle(outline.querySelector("rect"));
      return {
        animation: stroke.animationName,
        stroke: stroke.stroke,
        dashes: stroke.strokeDasharray,
        opacity: Number(getComputedStyle(outline).opacity),
      };
    });
    expect(border.animation).toBe("none");
    expect(border.stroke).not.toBe("none");
    expect(border.dashes).not.toBe("none");
    expect(border.opacity).toBeGreaterThan(0);
    await snooze.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("menuitem", { name: /^In 1 hour/ }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
  });
}

test("completion preserves section alignment and avatar opens its conversation", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  // Keep the three scheduled demo rows in Today regardless of the runner's clock.
  await page.clock.setFixedTime(new Date("2026-10-14T12:00:00Z"));
  await page.goto(`${url}?width=900&demo`);
  const today = page.getByRole("region", { name: "Today", exact: true });
  // Pointer completion removes a whole section, then a row in a surviving one.
  await page
    .getByRole("region", { name: "Overdue" })
    .getByRole("checkbox")
    .click();
  await expect(page.getByRole("region", { name: "Overdue" })).toHaveCount(0);
  await today.getByRole("checkbox").first().click();
  const done = page.getByRole("region", { name: "Done", exact: true });
  await done.getByRole("button", { name: "Done 2" }).click();
  await expect(done.getByRole("listitem")).toHaveCount(2);
  const heading = (locator) =>
    locator.evaluate((el) => {
      const text = el.querySelector("span");
      const style = getComputedStyle(text);
      return {
        x: text.getBoundingClientRect().x,
        size: style.fontSize,
        weight: style.fontWeight,
        lineHeight: style.lineHeight,
      };
    });
  expect(await heading(done.getByRole("heading"))).toEqual(
    await heading(today.getByRole("heading")),
  );
  const centerX = (locator) =>
    locator.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return rect.x + rect.width / 2;
    });
  expect(await centerX(done.getByRole("heading").locator("svg"))).toBe(
    await centerX(
      today.getByRole("button", { name: "More actions: Ada Lovelace" }).first(),
    ),
  );
  const textX = (region) =>
    region
      .getByRole("button", { name: "Open message from Ada Lovelace" })
      .first()
      .evaluate((el) => el.getBoundingClientRect().x);
  expect(await textX(done)).toBe(await textX(today));
  await today
    .getByRole("button", { name: "Open conversation: #release-planning" })
    .first()
    .click();
  await expect(
    page.getByText("Demo conversation", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("dialog")
      .getByText("Share the final designs", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  // Keyboard completion is immediate and focus stays on another actionable row.
  await today.getByRole("checkbox").first().focus();
  await page.keyboard.press("Space");
  await expect(today.getByRole("checkbox")).toHaveCount(1);
  await expect(today.getByRole("checkbox")).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await today.getByRole("checkbox").click();
  await expect(
    page.getByRole("region", { name: "Today", exact: true }),
  ).toHaveCount(0);
  await expect(done.getByRole("button", { name: "Done 4" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("pointer completion animates surviving rows in a scrolled list", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-10-14T12:00:00Z"));
  await page.setViewportSize({ width: 1000, height: 260 });
  await page.goto(`${url}?width=900&demo`);
  const today = page.getByRole("region", { name: "Today", exact: true });
  const checkbox = today.getByRole("checkbox").nth(1);
  await checkbox.scrollIntoViewIfNeeded();
  await checkbox.evaluate((el) => {
    const section = el.closest("section");
    const survivor = section.querySelectorAll("li")[2];
    el.addEventListener(
      "pointerdown",
      () => {
        const samples = [survivor.getBoundingClientRect().y];
        const exitChecks = [];
        window.completionFrames = { samples, exitChecks, finished: false };
        const sample = () => {
          samples.push(survivor.getBoundingClientRect().y);
          if (el.isConnected && el.closest("[inert]")) {
            exitChecks.push(el.getAttribute("aria-checked"));
          }
          if (
            section.querySelectorAll("li").length === 2 &&
            getComputedStyle(survivor).transform === "none"
          ) {
            window.completionFrames.finished = true;
          } else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      },
      { once: true },
    );
  });
  await checkbox.click();
  await expect
    .poll(() => page.evaluate(() => window.completionFrames?.finished))
    .toBe(true);
  const samples = await page.evaluate(() => window.completionFrames.samples);
  const exitChecks = await page.evaluate(
    () => window.completionFrames.exitChecks,
  );
  expect(exitChecks.length).toBeGreaterThan(0);
  expect(exitChecks.every((checked) => checked === "true")).toBe(true);
  const start = samples[0];
  const end = samples.at(-1);
  expect(start - end).toBeGreaterThan(20);
  expect(
    samples.some((y) => y < start - 1 && y > end + 1),
    "the next row moves through intermediate positions instead of jumping into the fading row",
  ).toBe(true);
});

// Only a browser can detect the dock wrapper clipping a badge's text or bubble.
// Use the real plugin contribution inside PageNavigation, not a copied count.
test("due reminder counts fit the dock at every supported text size", async ({
  page,
}) => {
  const { unexplained } = watchPageErrors(page);
  for (const count of [0, 1, 12, 125]) {
    await page.goto(`${url}?dock&count=${count}`);
    const tab = page.getByRole("tab", { name: /Reminders/ });
    const badge = tab.getByRole("img", { name: `${count} due`, exact: true });
    if (!count) {
      await expect(tab).toBeVisible();
      await expect(badge).toHaveCount(0);
      continue;
    }
    await expect(badge).toHaveText(count > 99 ? "99+" : String(count));
    await page.evaluate(() => document.fonts.ready);
    for (const width of [480, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      for (const mode of ["light", "dark"]) {
        for (const font of ["default", "larger"]) {
          await page.evaluate(
            ({ mode, font }) => {
              document.documentElement.dataset.colorMode = mode;
              document.documentElement.dataset.fontSize = font;
            },
            { mode, font },
          );
          const geometry = await badge.evaluate((el) => {
            const rect = el.getBoundingClientRect();
            const wrapper = el
              .closest(".buzz-tabs-badge")
              .getBoundingClientRect();
            const tab = el.closest('[role="tab"]');
            const tile = tab.getBoundingClientRect();
            const icon = tab.querySelector("svg").getBoundingClientRect();
            const scrollport = el
              .closest(".shell-dock-pages")
              .getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(el);
            const text = range.getBoundingClientRect();
            return {
              bubbleFits:
                rect.left >= wrapper.left &&
                rect.right <= wrapper.right &&
                rect.top >= wrapper.top &&
                rect.bottom <= wrapper.bottom,
              textFits:
                text.left >= wrapper.left &&
                text.right <= wrapper.right &&
                text.top >= wrapper.top &&
                text.bottom <= wrapper.bottom,
              outsideCorner: rect.top < tile.top && rect.right > tile.right,
              clearOfIcon: rect.bottom <= icon.top || rect.left >= icon.right,
              insideScrollport:
                rect.left >= scrollport.left &&
                rect.right <= scrollport.right &&
                rect.top >= scrollport.top &&
                rect.bottom <= scrollport.bottom,
              overflow: el.scrollWidth - el.clientWidth,
              fontSize: Number.parseFloat(getComputedStyle(el).fontSize),
              tileWidth: tile.width,
              background: getComputedStyle(el).backgroundColor,
            };
          });
          expect(
            geometry.bubbleFits,
            `${count}, ${width}, ${mode}, ${font}`,
          ).toBe(true);
          expect(geometry.textFits).toBe(true);
          expect(geometry.outsideCorner).toBe(true);
          expect(geometry.clearOfIcon).toBe(true);
          expect(geometry.insideScrollport).toBe(true);
          expect(geometry.overflow).toBe(0);
          expect(geometry.fontSize).toBeLessThan(geometry.tileWidth / 2);
          expect(geometry.background).not.toBe("rgba(0, 0, 0, 0)");
        }
      }
    }
    // A corner badge must not intercept the tab's pointer or keyboard action.
    await page.goto(`${url}?dock&count=${count}&inactive`);
    await expect(tab).toHaveAttribute("aria-selected", "false");
    const tile = await tab.boundingBox();
    await tab.click({ position: { x: tile.width - 2, y: 2 } });
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await page.reload();
    await tab.focus();
    await page.keyboard.press("Enter");
    await expect(tab).toHaveAttribute("aria-selected", "true");
  }
  expect(unexplained()).toEqual([]);
});
