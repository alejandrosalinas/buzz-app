import { openCommunityPicker } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

// Real font metrics, footer overflow and native focus scrolling require browsers.
test.use({ historyCounts: { alpha: 0, beta: 0 } });

test("community dialog keeps oversized actions intact, reachable and keyboard operable", async ({
  page,
  app,
}, info) => {
  await page.addInitScript(() => {
    localStorage.setItem("buzz-font-scale.v1", "2");
    localStorage.setItem("buzz-appearance.v1", "dark");
  });
  await page.route("**/api/relay/secondary/info", (route) =>
    route.fulfill({ json: { name: "Secondary", policy: null } }),
  );
  await page.goto(app.origin);
  await (await openCommunityPicker(page))
    .getByRole("button", { name: "Join a community", exact: true })
    .click();
  const url = page.getByRole("textbox", { name: "Community URL", exact: true });
  await expect(url).toBeFocused();
  await page.screenshot({ path: info.outputPath("community-url-focused.png") });
  await url.fill("wss://secondary.example");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Your profile",
    exact: true,
  });
  await expect(
    dialog.getByRole("textbox", { name: "Display name", exact: true }),
  ).toBeFocused();
  await dialog
    .getByRole("textbox", { name: "Display name", exact: true })
    .fill("Updated profile");
  const action = dialog.getByRole("button", {
    name: "Publish profile & open",
    exact: true,
  });
  const actions = dialog.locator(".buzz-dialog-action-row");
  await expect(action).toBeEnabled();
  await page.evaluate(() => document.fonts.ready);

  for (const [scale, mode] of [
    [1, "light"],
    [2, "light"],
    [2, "dark"],
  ]) {
    // Exercise the host's supported cross-window preference restore, not a CSS override.
    await page.evaluate(
      ({ scale, mode }) => {
        localStorage.setItem("buzz-font-scale.v1", String(scale));
        localStorage.setItem("buzz-appearance.v1", mode);
        window.dispatchEvent(
          new StorageEvent("storage", { key: null, storageArea: localStorage }),
        );
      },
      { scale, mode },
    );
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    for (const width of [1280, 800, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(action).toHaveCSS("font-size", `${14 * scale}px`);
      if ((scale === 1 && width === 1280) || (mode === "dark" && width === 320))
        await page.screenshot({
          path: info.outputPath(
            `community-profile-${scale}-${mode}-${width}.png`,
          ),
        });
      await expect
        .poll(() =>
          action.evaluate((button) => {
            const box = button.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(
              button.querySelector(".buzz-button-label"),
            );
            const lines = [...range.getClientRects()];
            return (
              lines.length === 1 &&
              lines.every(
                (line) =>
                  line.left >= box.left &&
                  line.right <= box.right &&
                  line.top >= box.top &&
                  line.bottom <= box.bottom,
              )
            );
          }),
        )
        .toBe(true);
    }
  }
  await expect
    .poll(() => actions.evaluate((node) => node.scrollWidth > node.clientWidth))
    .toBe(true);
  await actions.scrollIntoViewIfNeeded();
  const gap = await actions.evaluate((node) => {
    node.scrollLeft = 0;
    const bounds = node.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.bottom - 1 };
  });
  // The scrollbar strip/gaps must target the scroller, not content underneath it.
  expect(
    await actions.evaluate(
      (node, point) => document.elementFromPoint(point.x, point.y) === node,
      gap,
    ),
  ).toBe(true);
  await page.mouse.move(gap.x, gap.y);
  await page.mouse.wheel(200, 0);
  await expect
    .poll(() => actions.evaluate((node) => node.scrollLeft))
    .toBeGreaterThan(0);
  for (const edge of ["start", "end"]) {
    await actions.evaluate((node, edge) => {
      node.scrollLeft = edge === "start" ? 0 : node.scrollWidth;
    }, edge);
    await expect
      .poll(() =>
        action.evaluate((button, edge) => {
          const box = button.getBoundingClientRect();
          const footer = button.closest(".buzz-dialog-action-row");
          const bounds = footer.getBoundingClientRect();
          const dialog = footer
            .closest('[role="dialog"]')
            .getBoundingClientRect();
          return (
            bounds.left >= dialog.left &&
            bounds.right <= dialog.right &&
            bounds.left >= 0 &&
            bounds.right <= innerWidth &&
            (edge === "start"
              ? box.left >= bounds.left - 1
              : box.right <= bounds.right + 1)
          );
        }, edge),
      )
      .toBe(true);
    await actions.screenshot({
      path: info.outputPath(`dialog-actions-320-200-dark-${edge}.png`),
    });
  }
  // Tab through the real footer, not programmatically focusing the submit action.
  await dialog
    .getByRole("textbox", {
      name: "Profile description (optional)",
      exact: true,
    })
    .focus();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Back", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(action).toBeFocused();
  await expect
    .poll(() =>
      action.evaluate((button) => {
        const box = button.getBoundingClientRect();
        const bounds = button
          .closest(".buzz-dialog-action-row")
          .getBoundingClientRect();
        return (
          box.right > bounds.left &&
          box.left < bounds.right &&
          box.top >= 0 &&
          box.bottom <= innerHeight
        );
      }),
    )
    .toBe(true);
  const published = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/relay/secondary/profile") &&
      response.request().method() === "POST",
  );
  await page.keyboard.press("Enter");
  expect((await published).ok()).toBe(true);
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", {
      name: "Community switcher: Secondary",
      exact: true,
    }),
  ).toBeVisible();
});

test.describe("touch entry", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  // Native focus and virtual-keyboard avoidance depend on the browser's pointer modality.
  test("community entry waits for a deliberate field tap", async ({
    page,
    app,
  }) => {
    await page.route("**/api/relay/secondary/info", (route) =>
      route.fulfill({ json: { name: "Secondary", policy: null } }),
    );
    await page.goto(app.origin);
    await (await openCommunityPicker(page))
      .getByRole("button", { name: "Join a community", exact: true })
      .tap();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toHaveAccessibleName("Join a community");
    await expect(dialog).toBeFocused();
    const url = dialog.getByRole("textbox", {
      name: "Community URL",
      exact: true,
    });
    await url.tap();
    await expect(url).toBeFocused();
    await url.fill("wss://secondary.example");
    await dialog.getByRole("button", { name: "Continue", exact: true }).tap();
    await expect(dialog).toHaveAccessibleName("Your profile");
    const name = dialog.getByRole("textbox", {
      name: "Display name",
      exact: true,
    });
    await expect(name).toBeEnabled();
    await expect(name).not.toBeFocused();
  });
});
