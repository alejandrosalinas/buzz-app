import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

test.use({ historyCounts: { alpha: 2, beta: 1 } });

// Browser-only: real contextmenu propagation through the message menu, canvas
// PNG encoding, browser downloads, and fullscreen focus/dismissal ownership.
for (const kind of ["image", "video"]) {
  test(`${kind} menu copies, downloads and opens the gallery`, async ({
    page,
    app,
  }, testInfo) => {
    const filename = kind === "image" ? "still.png" : "sample.mp4";
    const path = fileURLToPath(
      new URL(
        kind === "image"
          ? "../fixtures/attachment-media/still.png"
          : "../fixtures/message-gallery/assets/sample.mp4",
        import.meta.url,
      ),
    );
    const original = `https://primary.example/media/${filename}`;
    app.mediaFiles.set(original, {
      bytes: await readFile(path),
      contentType: kind === "image" ? "image/png" : "video/mp4",
    });
    await page.addInitScript(() => {
      window.mediaClipboard = { urls: [], images: [], denyUrlCopy: false };
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value) => {
            if (window.mediaClipboard.denyUrlCopy)
              throw new Error("Copy denied");
            window.mediaClipboard.urls.push(value);
          },
          write: async (items) => {
            const blob = await items[0].getType("image/png");
            window.mediaClipboard.images.push({
              type: blob.type,
              size: blob.size,
            });
          },
        },
      });
    });
    await open(page, app);
    const event = app.append(
      "primary",
      "alpha",
      "Media actions",
      true,
      true,
      undefined,
      undefined,
      [
        [
          "imeta",
          `url ${original}`,
          `m ${kind === "image" ? "image/png" : "video/mp4"}`,
          `filename ${filename}`,
        ],
      ],
    );
    const row = page.locator(
      `[data-channel-timeline] [data-message-id="${event.id}"]`,
    );
    const preview = row.locator("[data-media-preview]");
    if (kind === "image") {
      await expect(preview).toHaveAttribute("data-image-ready");
    } else {
      await expect
        .poll(() => preview.locator("video").evaluate((el) => el.readyState))
        .toBeGreaterThanOrEqual(2);
    }
    const rightClick = () => preview.click({ button: "right" });
    await rightClick();
    const menu = page.getByRole("menu");
    await expect(
      menu.locator('[role="menuitem"], [role="separator"]'),
    ).toHaveText(
      kind === "image"
        ? ["Open image", "Copy image", "Copy image URL", "", "Download image"]
        : ["Open video", "Copy video URL", "", "Download video"],
    );
    await menu.getByRole("menuitem", { name: `Copy ${kind} URL` }).click();
    await expect
      .poll(() => page.evaluate(() => window.mediaClipboard.urls))
      .toEqual([original]);
    if (kind === "image") {
      await rightClick();
      await menu
        .getByRole("menuitem", { name: "Copy image", exact: true })
        .click();
      await expect
        .poll(() => page.evaluate(() => window.mediaClipboard.images.length))
        .toBe(1);
      const copied = await page.evaluate(() => window.mediaClipboard.images[0]);
      expect(copied.type).toBe("image/png");
      expect(copied.size).toBeGreaterThan(0);
    }
    await rightClick();
    const downloaded = page.waitForEvent("download");
    await menu.getByRole("menuitem", { name: `Download ${kind}` }).click();
    const download = await downloaded;
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toBe(filename);
    expect(await readFile(await download.path())).toEqual(await readFile(path));
    await rightClick();
    await menu.getByRole("menuitem", { name: `Open ${kind}` }).click();
    const viewer = page.getByRole("dialog", {
      name: kind === "image" ? "Image viewer" : "Video review",
    });
    await expect(viewer).toBeVisible();
    await expect(menu).toHaveCount(0);
    await expect
      .poll(() => viewer.evaluate((el) => el.contains(document.activeElement)))
      .toBe(true);
    const stage =
      kind === "image"
        ? viewer.getByRole("group", { name: "Image gallery" })
        : viewer.locator("video[data-review-media]");
    await stage.click({ button: "right", position: { x: 20, y: 20 } });
    await expect(
      menu.getByRole("menuitem", { name: `Copy ${kind} URL` }),
    ).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^Open / })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(viewer).toBeVisible();
    const control =
      kind === "image"
        ? viewer.getByRole("button", { name: "Zoom in" })
        : viewer.getByRole("button", { name: /^Playback speed:/ });
    await control.focus();
    await page.keyboard.press("Shift+F10");
    await expect(
      menu.getByRole("menuitem", { name: `Copy ${kind} URL` }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(control).toBeFocused();
    const feedback = viewer.getByRole("status", { name: "Media actions" });
    await expect(feedback).toBeEmpty();
    await expect(feedback).toHaveAttribute("aria-live", "polite");
    await page.evaluate(() => {
      window.mediaClipboard.denyUrlCopy = true;
    });
    await page.keyboard.press("Shift+F10");
    await menu.getByRole("menuitem", { name: `Copy ${kind} URL` }).click();
    await expect(menu).toHaveCount(0);
    await expect(feedback).toHaveText("Couldn’t copy URL. Try again.");
    await expect(viewer).toBeVisible();
    const toastRoot = page.locator("#buzz-toast-root");
    await expect(toastRoot).toHaveAttribute("aria-hidden", "true");
    await expect(
      toastRoot.getByText("Couldn’t copy URL. Try again.", { exact: true }),
    ).toBeVisible();
    await page.evaluate(() => {
      window.mediaClipboard.denyUrlCopy = false;
    });
    await control.focus();
    await page.keyboard.press("Shift+F10");
    await menu.getByRole("menuitem", { name: `Copy ${kind} URL` }).click();
    await expect(feedback).toHaveText(
      kind === "image" ? "Image URL copied" : "Video URL copied",
    );
    await expect(menu).toHaveCount(0);
    await viewer
      .getByRole("button", { name: "Close fullscreen viewer" })
      .click();
    await expect(viewer).toHaveCount(0);
    // Representative rendering checks: both themes, narrow and enlarged text.
    for (const [mode, width, font] of [
      ["light", 1440, "100%"],
      ["dark", 390, "125%"],
    ]) {
      // Keep the real pointer target clear when resizing moves it under the
      // toast stack. Leaving the stack lets notification expiry resume.
      await page.mouse.move(0, 0);
      await expect(
        toastRoot.getByRole("button", { name: "Dismiss notification" }),
      ).toHaveCount(0);
      await page.setViewportSize({ width, height: 950 });
      await page.evaluate(
        ({ mode, font }) => {
          document.documentElement.dataset.colorMode = mode;
          document.documentElement.style.fontSize = font;
        },
        { mode, font },
      );
      await rightClick();
      await expect(menu).toBeVisible();
      const bounds = await menu.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: testInfo.outputPath(`${kind}-${mode}.png`),
      });
      await menu.getByRole("menuitem", { name: `Copy ${kind} URL` }).click();
      await expect(menu).toHaveCount(0);
    }
  });
}
