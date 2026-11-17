import { hoverMessage } from "./message-actions.mjs";
import { fileURLToPath } from "node:url";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import {
  chooseColorMode,
  openSettings,
  selectSettingsSection,
  settingsDialog,
} from "./navigation.mjs";

// Resolve on the app root, independently of the gallery subtree: a stale or
// incorrectly scoped gallery palette must not supply its own expected colors.
async function hostColor(page, role) {
  return page.evaluate((role) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${role})`;
    document.documentElement.append(probe);
    try {
      return getComputedStyle(probe).color;
    } finally {
      probe.remove();
    }
  }, role);
}

// Browser boundary: real thread-to-gallery wiring, computed CSS, and host
// appearance updates across windows while the gallery and draft stay mounted.
test("an open image gallery follows host appearance while retaining its dark stage", async ({
  page,
  app,
  context,
}, testInfo) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-appearance.v1", "light"),
  );
  await context.route("**/api/relay/primary/media?**", (route) =>
    route.fulfill({
      path: fileURLToPath(
        new URL("../../public/shell-gradient.png", import.meta.url),
      ),
      contentType: "image/png",
    }),
  );
  await open(page, app);
  const event = app.append(
    "primary",
    "alpha",
    "Gallery theme",
    true,
    true,
    undefined,
    undefined,
    [["imeta", "url https://primary.example/media/photo.png", "m image/png"]],
  );
  app.append("primary", "alpha", "Gallery comment", false, true, event.id);
  const row = page
    .getByRole("region", { name: "Channel message history" })
    .locator(`[data-message-id="${event.id}"]`);
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(
    thread.getByText("Gallery comment", { exact: true }),
  ).toBeVisible();
  await thread
    .getByRole("link", { name: "Open image attachment", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Image viewer",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toHaveAttribute("data-review-opening");
  const comments = dialog.getByRole("complementary", {
    name: "Media comments",
  });
  const composer = comments.getByRole("textbox", { name: "Reply to thread" });
  await composer.fill("Retain this gallery draft");
  const node = await composer.elementHandle();
  const other = await context.newPage();
  try {
    await other.goto(app.origin);
    await openSettings(other);
    await expect(
      settingsDialog(other).getByRole("button", {
        name: "Close Settings",
        exact: true,
      }),
    ).toBeFocused();
    await selectSettingsSection(other, "Appearance");
    for (const [index, mode] of ["light", "dark", "light"].entries()) {
      await chooseColorMode(other, mode === "light" ? "Light" : "Dark");
      await expect(page.locator("html")).toHaveAttribute(
        "data-color-mode",
        mode,
      );
      await expect(comments).toHaveCSS(
        "background-color",
        await hostColor(page, "--surface-panel"),
      );
      // The viewer's own comment takes its accent-paired message ink.
      const comment = comments.getByText("Gallery comment", { exact: true });
      await expect(comment).toHaveCSS(
        "color",
        await hostColor(page, "--text-message-own"),
      );
      await expect(composer).toHaveCSS(
        "color",
        await hostColor(page, "--text-standard"),
      );
      await expect(dialog.locator("[data-review-stage]")).toHaveCSS(
        "background-color",
        "rgb(0, 0, 0)",
      );
      await expect(composer).toHaveText("Retain this gallery draft");
      expect(
        await node.evaluate(
          (el) =>
            el ===
            document.querySelector(
              '[aria-label="Media comments"] [role="textbox"]',
            ),
        ),
      ).toBe(true);
      if (index < 2) {
        await page.bringToFront();
        const image = dialog.getByRole("img", { name: "Attachment preview" });
        await expect(image).toBeVisible();
        await image.evaluate((el) => el.decode());
        await dialog.evaluate((el) =>
          Promise.allSettled(
            el
              .getAnimations({ subtree: true })
              .filter(
                (animation) =>
                  animation.effect?.getComputedTiming().endTime !== Infinity,
              )
              .map((animation) => animation.finished),
          ),
        );
        await dialog.screenshot({
          path: testInfo.outputPath(`gallery-${mode}.png`),
        });
      }
    }
    await page.bringToFront();
    await dialog.getByRole("button", { name: "Hide comments" }).click();
    await dialog.getByRole("button", { name: "Show comments" }).click();
    await expect(composer).toHaveText("Retain this gallery draft");
    await dialog
      .getByRole("button", { name: "Close fullscreen viewer" })
      .press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(
      thread.getByRole("link", { name: "Open image attachment", exact: true }),
    ).toBeFocused();
    // Accent changes propagate without tinting the media canvas.
    await other
      .getByRole("button", { name: "Cobalt accent color", exact: true })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-accent", "cobalt");

    await chooseColorMode(other, "Dark");
    await expect(page.locator("html")).toHaveAttribute(
      "data-color-mode",
      "dark",
    );
    await page.bringToFront();
    await thread
      .getByRole("link", { name: "Open image attachment", exact: true })
      .press("Enter");
    // Comments follow the app surface; the image stage remains pure black.
    await expect(comments).toHaveCSS(
      "background-color",
      await hostColor(page, "--surface-panel"),
    );
    await expect(dialog.locator("[data-review-stage]")).toHaveCSS(
      "background-color",
      "rgb(0, 0, 0)",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    for (let percent = 110; percent <= 200; percent += 10) {
      await other
        .getByRole("button", { name: "Increase interface size", exact: true })
        .click();
      await expect(
        other.getByRole("status", { name: "Interface size", exact: true }),
      ).toHaveText(`${percent}%`);
    }
    await expect(
      dialog.getByRole("heading", { name: "photo.png", exact: true }),
    ).toHaveCSS("font-size", "28px");
    await page.bringToFront();
    await expect(composer).toBeVisible();
    await dialog.screenshot({
      path: testInfo.outputPath("gallery-dark-narrow-enlarged.png"),
    });
    await chooseColorMode(other, "Light");
    await expect(page.locator("html")).toHaveAttribute(
      "data-color-mode",
      "light",
    );
    await expect(comments).toHaveCSS(
      "background-color",
      await hostColor(page, "--surface-panel"),
    );
    await expect(composer).toHaveCSS(
      "color",
      await hostColor(page, "--text-standard"),
    );
    await expect(composer).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "photo.png", exact: true }),
    ).toHaveCSS("font-size", "28px");
    await page.bringToFront();
    await dialog.screenshot({
      path: testInfo.outputPath("gallery-light-narrow-enlarged.png"),
    });
    await dialog
      .getByRole("button", { name: "Close fullscreen viewer" })
      .press("Enter");
    await expect(dialog).toHaveCount(0);
  } finally {
    await other.close();
  }
});

// Browser boundary: ChannelsPage's real opener must retain the collapsed batch;
// native focus and key bubbling must survive Retry removing its own button.
test("primary gallery keeps hidden media and keyboard navigation through thread retry", async ({
  page,
  app,
  context,
}) => {
  await context.route("**/api/relay/primary/media?**", (route) =>
    route.fulfill({
      path: fileURLToPath(
        new URL("../../public/shell-gradient.png", import.meta.url),
      ),
      contentType: "image/png",
    }),
  );
  await open(page, app);
  const event = app.append(
    "primary",
    "alpha",
    "Retry gallery",
    true,
    true,
    undefined,
    undefined,
    Array.from({ length: 6 }, (_, index) => [
      "imeta",
      `url https://primary.example/media/item-${index + 1}.${index === 0 ? "mp4" : "png"}`,
      `m ${index === 0 ? "video/mp4" : "image/png"}`,
    ]),
  );
  app.append(
    "primary",
    "alpha",
    "Recovered gallery comment",
    false,
    true,
    event.id,
  );
  const row = page
    .getByRole("region", { name: "Channel message history" })
    .locator(`[data-message-id="${event.id}"]`);
  const tiles = row
    .getByRole("group", { name: "6 photos and videos", exact: true })
    .getByRole("link");
  await expect(tiles).toHaveCount(4);
  let releaseFirst, releaseRetry;
  const first = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const retry = new Promise((resolve) => {
    releaseRetry = resolve;
  });
  let reads = 0;
  let released = false;
  await page.route("**/api/relay/primary/query", async (route) => {
    if (
      !route
        .request()
        .postDataJSON()
        .some((filter) => filter.ids?.includes(event.id))
    )
      return route.continue();
    reads++;
    if (reads === 1) {
      await first;
      // A malformed successful response fails the read without a browser HTTP error.
      return route.fulfill({ contentType: "application/json", body: "{" });
    }
    if (!released) await retry;
    return route.continue();
  });
  try {
    await tiles.last().click();
    await expect.poll(() => reads).toBe(1);
    const dialog = page.getByRole("dialog", {
      name: "Image viewer",
      exact: true,
    });
    await expect(dialog.getByText("4 / 6", { exact: true })).toBeVisible();
    await dialog
      .getByRole("button", { name: "Next media", exact: true })
      .click();
    await expect(dialog.getByText("5 / 6", { exact: true })).toBeVisible();
    releaseFirst();
    const retryButton = dialog.getByRole("button", {
      name: "Retry",
      exact: true,
    });
    await expect(retryButton).toBeVisible();
    await retryButton.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => reads).toBeGreaterThan(1);
    await expect(retryButton).toHaveCount(0);
    await expect(dialog).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(dialog.getByText("6 / 6", { exact: true })).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(dialog.getByText("5 / 6", { exact: true })).toBeVisible();
    released = true;
    releaseRetry();
    await expect(
      dialog.getByRole("textbox", { name: "Reply to thread" }),
    ).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(dialog.getByText("6 / 6", { exact: true })).toBeVisible();
  } finally {
    released = true;
    releaseFirst();
    releaseRetry();
  }
});
