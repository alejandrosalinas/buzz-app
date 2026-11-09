import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

test.use({ dmLabels: true, historyCounts: { alpha: 1, beta: 1 } });

async function appearance(page, scale, mode = "light") {
  await page.evaluate(
    ({ scale, mode }) => {
      localStorage.setItem("buzz-appearance.v1", mode);
      localStorage.setItem("buzz-font-scale.v1", String(scale));
      window.dispatchEvent(
        new StorageEvent("storage", { key: null, storageArea: localStorage }),
      );
    },
    { scale, mode },
  );
  await expect
    .poll(() =>
      page
        .locator("html")
        .evaluate((root) => Number.parseFloat(getComputedStyle(root).fontSize)),
    )
    .toBeCloseTo(16 * scale, 5);
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
}

// Real layout proves label width, compact height, adjacent chevrons and hit areas.
test("sidebar headings keep readable space and compact disclosure targets at enlarged sizes", async ({
  page,
  app,
}, info) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const sidebar = page.locator(".shell-sidebar");
  const resize = page.getByRole("separator", { name: "Resize sidebar" });
  const summaries = ["Channels", "Direct messages"].map((title) =>
    sidebar.locator("summary").filter({ hasText: title }),
  );
  for (const summary of summaries) await expect(summary).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  // Color mode changes no size tokens; cover geometry once and both paints below.
  for (const scale of [1, 1.2, 1.5, 1.8, 2]) {
    await resize.press("Home");
    await appearance(page, scale);
    for (const width of [220, 260, 520]) {
      if (width === 260) await resize.dblclick();
      else await resize.press(width === 220 ? "Home" : "End");
      await expect(resize).toHaveAttribute("aria-valuenow", String(width));
      // Measure at rest: the double-click leaves the pointer where a heading
      // can land, and hovering reveals its actions, which take their width.
      await page.mouse.move(0, 0);
      for (const summary of summaries) {
        await summary.scrollIntoViewIfNeeded();
        await expect
          .poll(() =>
            summary.evaluate((element) => {
              const title = element.firstElementChild.lastElementChild;
              const label = element.firstElementChild.getBoundingClientRect();
              const chevron = element.lastElementChild.getBoundingClientRect();
              const header = element.closest(".navigation-section-heading");
              const frame = header.getBoundingClientRect();
              const slot = header
                .querySelector(".navigation-section-heading-label")
                .getBoundingClientRect();
              const disclosure = element.getBoundingClientRect();
              const actions = header
                .querySelector(".navigation-section-heading-actions")
                .getBoundingClientRect();
              const root = Number.parseFloat(
                getComputedStyle(document.documentElement).fontSize,
              );
              const gap = Number.parseFloat(
                getComputedStyle(element).columnGap,
              );
              return {
                readable: title.clientWidth >= 2 * root,
                singleLine:
                  title.getBoundingClientRect().height <=
                  Number.parseFloat(getComputedStyle(title).lineHeight) + 1,
                compact:
                  Math.abs(frame.height - disclosure.height) < 1 &&
                  frame.height <= 2.5 * root,
                adjacent: Math.abs(chevron.left - label.right - gap) < 1,
                // The trigger fills the label slot; actions follow it.
                fullTarget:
                  disclosure.left === slot.left &&
                  disclosure.right === slot.right &&
                  slot.right <= actions.left + 0.5,
                actionsContained:
                  actions.left >= frame.left &&
                  actions.right <= frame.right + 1 &&
                  // Fractional sizes may land half a layout subpixel off;
                  // check the intended center.
                  Math.abs(
                    actions.top +
                      actions.height / 2 -
                      frame.top -
                      frame.height / 2,
                  ) < 0.5 &&
                  actions.height <= frame.height + 1,
              };
            }),
          )
          .toEqual({
            readable: true,
            singleLine: true,
            compact: true,
            adjacent: true,
            fullTarget: true,
            actionsContained: true,
          });
      }
    }
  }

  await resize.press("Home");
  await page.setViewportSize({ width: 1440, height: 1200 });
  const channels = summaries[0];
  // The trailing edge before the revealed action buttons still toggles the
  // section. Hover first: revealed actions take their width from the trigger.
  await channels.hover();
  const target = await channels.boundingBox();
  await channels.click({
    position: { x: target.width - 2, y: target.height / 2 },
  });
  await expect(channels.locator("..")).not.toHaveAttribute("open");
  await channels.press("Enter");
  await expect(channels.locator("..")).toHaveAttribute("open", "");
  await page.keyboard.press("Tab");
  const more = sidebar.getByRole("button", {
    name: "More actions for Channels",
    exact: true,
  });
  await expect(more).toBeFocused();
  await expect(more.locator("..")).toHaveCSS("opacity", "1");
  await more.press("Enter");
  await expect(
    page.getByRole("menu", { name: "More actions for Channels", exact: true }),
  ).toBeVisible();
  await expect(channels.locator("..")).toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
  await expect(channels.locator("..")).toHaveAttribute("open", "");
  await resize.focus();
  await page.mouse.move(0, 0);
  await appearance(page, 1);
  await page.screenshot({
    path: info.outputPath("sidebar-100-percent-light.png"),
  });
  for (const mode of ["light", "dark"]) {
    await appearance(page, 2, mode);
    await page.screenshot({
      path: info.outputPath(`sidebar-200-percent-${mode}.png`),
    });
    const direct = await summaries[1].boundingBox();
    await summaries[1].hover({ position: { x: 12, y: direct.height / 2 } });
    await expect(
      sidebar
        .getByRole("button", { name: "New message", exact: true })
        .locator(".."),
    ).toHaveCSS("opacity", "1");
    await page.screenshot({
      path: info.outputPath(`sidebar-200-percent-${mode}-actions.png`),
    });
    await page.mouse.move(0, 0);
  }
});
