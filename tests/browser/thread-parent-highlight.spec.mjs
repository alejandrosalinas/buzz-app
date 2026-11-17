import { test, expect } from "./fixture.mjs";
import { hoverMessage } from "./message-actions.mjs";
import { open } from "./timeline.mjs";
import { animationsSettled } from "./animations.mjs";

const paintedFill = (row, density) =>
  row.evaluate((item, density) => {
    const surface = item.querySelector("[data-highlight-surface]");
    const style =
      density === "compact"
        ? getComputedStyle(surface, "::before")
        : getComputedStyle(
            surface.querySelector("[data-message-action-anchor]"),
          );
    // An ungenerated pseudo still has computed styles, but paints nothing.
    if (density === "compact" && ["none", "normal"].includes(style.content))
      return ["rgba(0, 0, 0, 0)", "1"];
    return [style.backgroundColor, style.opacity];
  }, density);

test.use({ historyCounts: { alpha: 3, beta: 0 } });

// Browser-only: prove selected-tab wiring reaches the virtualized row and that
// its painted fill matches hover in both density/theme recipes.
for (const density of ["default", "compact"]) {
  for (const theme of ["light", "dark"]) {
    test(`side thread keeps the ${density} ${theme} hover treatment on its original`, async ({
      page,
      app,
    }, testInfo) => {
      await page.addInitScript(
        ({ density, theme }) => {
          localStorage.setItem("buzz-message-density.v1", density);
          localStorage.setItem("buzz-appearance.v1", theme);
        },
        { density, theme },
      );
      await open(page, app);
      await expect(page.locator("html")).toHaveAttribute(
        "data-color-mode",
        theme,
      );
      await expect(page.locator("html")).toHaveAttribute(
        "data-message-density",
        density,
      );
      const events = [
        app.append(
          "primary",
          "alpha",
          "Can we keep the original message highlighted while its thread is open?",
          true,
          true,
        ),
        app.append(
          "primary",
          "alpha",
          "Yes — the highlight follows the thread you are reading.",
          true,
          false,
        ),
      ];
      const row = (event) =>
        page.locator(`[data-channel-timeline] [data-message-id="${event.id}"]`);
      const surface = (event) =>
        row(event).locator("[data-highlight-surface]").first();
      const fill = (event) => paintedFill(row(event), density);
      const resting = [];
      for (const event of events) {
        await expect(surface(event)).toBeVisible();
        resting.push(await fill(event));
        await hoverMessage(row(event));
        await expect(surface(event)).toHaveAttribute("data-actions-revealed");
        const hovered = await fill(event);
        expect(hovered).not.toEqual(resting.at(-1));
        const reply = row(event).getByRole("button", {
          name: "Reply",
          exact: true,
        });
        await reply.focus();
        await reply.press("Enter");
        await expect(
          page.getByRole("textbox", { name: "Reply to thread", exact: true }),
        ).toBeFocused();
        await page.mouse.move(0, 0);
        await expect(surface(event)).toHaveAttribute("data-thread-open");
        await expect.poll(() => fill(event)).toEqual(hovered);
      }
      await expect(surface(events[0])).not.toHaveAttribute("data-thread-open");
      await expect(surface(events[1])).toHaveAttribute("data-thread-open");
      await expect.poll(() => fill(events[0])).toEqual(resting[0]);
      // Selecting a retained thread with the pointer moves the marker too.
      const tab = (event) =>
        page.locator(`[role="tab"][data-tab-value="thread:alpha:${event.id}"]`);
      await tab(events[0]).click();
      await expect(surface(events[0])).toHaveAttribute("data-thread-open");
      await expect(surface(events[1])).not.toHaveAttribute("data-thread-open");
      await tab(events[1]).click();
      await page.mouse.move(0, 0);
      await animationsSettled(page.locator("body"), { subtree: true });
      await page.screenshot({
        path: testInfo.outputPath("thread-highlight.png"),
      });
    });
  }
}

// CSS media queries and touch input need an actual browser, not jsdom.
test.describe("touch-only pointer", () => {
  test.use({ hasTouch: true, threadUnread: true, readState: true });
  for (const density of ["default", "compact"]) {
    test(`the ${density} thread marker paints without hover support`, async ({
      page,
      app,
    }) => {
      await page.addInitScript((density) => {
        localStorage.setItem("buzz-message-density.v1", density);
        localStorage.setItem("buzz-appearance.v1", "light");
      }, density);
      await open(page, app);
      expect(
        await page.evaluate(
          () => matchMedia("(hover: hover) and (pointer: fine)").matches,
        ),
      ).toBe(false);
      const roots = app.histories
        .get("primary/alpha")
        .filter((row) => row.content.startsWith("Thread root"));
      expect(roots).toHaveLength(2);
      const row = (root) =>
        page.locator(`[data-channel-timeline] [data-message-id="${root.id}"]`);
      const fill = (root) => paintedFill(row(root), density);
      const resting = [];
      for (const root of roots) {
        await expect(row(root)).toBeVisible();
        resting.push(await fill(root));
        const expected = await row(root).evaluate((item, density) => {
          const surface = item.querySelector("[data-highlight-surface]");
          const sample = document.createElement("span");
          sample.style.backgroundColor =
            density === "compact"
              ? "var(--affordance-subtle-hover)"
              : surface.hasAttribute("data-own")
                ? "var(--surface-message-own-hover)"
                : "var(--surface-message-hover)";
          surface.append(sample);
          const color = getComputedStyle(sample).backgroundColor;
          sample.remove();
          return [color, density === "compact" ? "0.5" : "1"];
        }, density);
        expect(expected).not.toEqual(resting.at(-1));
        await row(root)
          .getByRole("button", { name: /^View thread:/ })
          .tap();
        await expect(row(root).locator("[data-thread-open]")).toHaveCount(1);
        await expect.poll(() => fill(root)).toEqual(expected);
      }
      await expect(row(roots[0]).locator("[data-thread-open]")).toHaveCount(0);
      await expect.poll(() => fill(roots[0])).toEqual(resting[0]);
    });
  }
});

for (const density of ["default", "compact"]) {
  test(`a collapsed agents root keeps the ${density} hover fill for its open thread`, async ({
    page,
    app,
  }) => {
    await page.addInitScript((density) => {
      localStorage.setItem("buzz-message-density.v1", density);
    }, density);
    await open(page, app);
    const event = app.append(
      "primary",
      "alpha",
      "Agent coordination root",
      true,
      true,
      undefined,
      undefined,
      [["audience", "agents"]],
    );
    await page
      .getByRole("button", {
        name: /Show activity history:.*Agent coordination root/,
      })
      .click();
    const row = page.locator(
      `[data-channel-timeline] [data-message-id="${event.id}"]`,
    );
    const toggle = row.getByRole("button", { name: /Agent coordination root/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const highlighted = await toggle.evaluate((element) => {
      const sample = document.createElement("span");
      sample.style.backgroundColor = "var(--affordance-subtle-hover)";
      element.append(sample);
      const color = getComputedStyle(sample).backgroundColor;
      sample.remove();
      return color;
    });
    await expect(toggle).not.toHaveCSS("background-color", highlighted);
    await toggle.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Reply", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "Reply to thread", exact: true }),
    ).toBeFocused();
    await page.mouse.move(0, 0);
    await expect(row).toHaveAttribute("data-thread-open");
    await expect(row).toHaveAttribute("aria-current", "true");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toHaveCSS("background-color", highlighted);
  });
}
