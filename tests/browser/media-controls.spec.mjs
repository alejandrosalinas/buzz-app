import { test, expect } from "./source-fixture.mjs";

// Browser-only: the file card retains the dark stage surface across host themes.
test("file previews keep dark stage colors when host appearance changes", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/relay-composer.html?attachments");
  const form = page.getByRole("form", {
    name: "Send a message to General",
    exact: true,
  });
  await form.getByLabel("Choose attachments").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Preview notes"),
  });
  await expect(form.getByText(/Ready$/)).toHaveCount(1);
  await form.getByRole("button", { name: "Preview notes.txt" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Attachment preview",
    exact: true,
  });
  const file = dialog.getByRole("link", { name: /notes.txt/ });
  for (const mode of ["light", "dark", "light"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    await expect(
      dialog.getByRole("heading", { name: "notes.txt", exact: true }),
    ).toHaveCSS(
      "color",
      mode === "light" ? "rgb(15, 15, 15)" : "rgb(255, 255, 255)",
    );
    await expect(file).toHaveCSS("background-color", "rgb(16, 16, 16)");
    await expect(file).toHaveCSS("color", "rgb(255, 255, 255)");
    await file.hover();
    await expect(file).toHaveCSS("background-color", "rgb(46, 46, 46)");
    await page.mouse.move(0, 0);
  }
});

// Browser-only: container-grid cascade and a native CSS transition sampled at
// controlled progress. A DOM emulator cannot prove the sidebar retains width.
for (const kind of ["image", "video"]) {
  test(`narrow ${kind} comments slide downward while retaining their full width`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      `/tests/fixtures/media-review.html?${kind === "image" ? "photo" : "review"}`,
    );
    const dialog = page.getByRole("dialog");
    const comments = dialog.locator('aside[aria-label="Media comments"]');
    await expect(
      dialog.getByRole("heading", { name: "Comments" }),
    ).toBeVisible();
    for (const mode of ["light", "dark"]) {
      await page.evaluate((mode) => {
        document.documentElement.dataset.colorMode = mode;
      }, mode);
      const width = await comments.evaluate(
        (el) => el.getBoundingClientRect().width,
      );
      // Extend only the transform duration so the runner can pause the native
      // transition deterministically while preserving its production curve.
      await comments.evaluate((el) => {
        el.style.transitionDuration = "60s, 0s";
      });
      try {
        await dialog.getByRole("button", { name: "Hide comments" }).click();
        await expect(dialog).toHaveAttribute("data-comments-hidden");
        await expect
          .poll(() =>
            comments.evaluate((el) => {
              const transition = el
                .getAnimations()
                .find(
                  (animation) => animation.transitionProperty === "transform",
                );
              if (!transition) return false;
              transition.pause();
              transition.currentTime =
                transition.effect.getTiming().duration * 0.4;
              return true;
            }),
          )
          .toBe(true);
        const state = await comments.evaluate((el) => {
          const style = getComputedStyle(el);
          const transform = new DOMMatrix(style.transform);
          return {
            width: el.getBoundingClientRect().width,
            x: transform.m41,
            y: transform.m42,
            height: el.offsetHeight,
          };
        });
        expect(state.width).toBeCloseTo(width, 1);
        expect(state.x).toBe(0);
        expect(state.y).toBeGreaterThan(0);
        expect(state.y).toBeLessThan(state.height);
        expect(
          await dialog.evaluate(
            (el) =>
              getComputedStyle(el).gridTemplateColumns.split(/\s+/).length,
          ),
        ).toBe(1);
      } finally {
        await comments.evaluate((el) => {
          el.getAnimations().forEach((animation) => {
            animation.finish();
          });
          el.style.removeProperty("transition-duration");
        });
      }
      await expect(comments).toHaveCSS("visibility", "hidden");
      await dialog
        .getByRole("button", { name: "Show comments" })
        .press("Enter");
      await expect(comments).toBeVisible();
      await expect(comments).toHaveCSS("transform", "none");
    }
  });
}

// Browser-only: CSS layout, clipping, focus visibility, and paused control opacity
// cannot be established by jsdom. Playback/zoom logic stays in component tests.
for (const kind of ["image", "video"]) {
  test(`${kind} review keeps its header and controls usable across panel widths`, async ({
    page,
  }) => {
    await page.goto(
      `/tests/fixtures/media-review.html?${kind === "image" ? "gallery&photo" : "review"}`,
    );
    const dialog = page.getByRole("dialog");
    const heading = dialog.getByRole("heading", {
      name: kind === "image" ? "Photo preview" : "Review clip.mp4",
      exact: true,
    });
    await expect(heading).toBeVisible();
    await expect(dialog.locator("[data-review-stage]")).toHaveCSS(
      "background-color",
      "rgb(0, 0, 0)",
    );
    await expect(heading).toHaveCSS("color", "rgb(15, 15, 15)");
    await expect(heading).toHaveCSS("font-size", "14px");
    const header = heading.locator("xpath=ancestor::header");
    await expect(header.locator(".panel-header-title svg")).toHaveCount(0);
    await expect(header).toHaveCSS("border-bottom-width", "1px");
    await expect(header).toHaveCSS("border-bottom-style", "solid");
    await expect(
      dialog.getByRole("heading", { name: "Comments" }),
    ).toBeVisible();
    if (kind === "video") {
      const video = dialog.locator("video");
      await expect
        .poll(() => video.evaluate((el) => el.readyState))
        .toBeGreaterThanOrEqual(2);
      await video.evaluate((el) => el.pause());
      await expect(
        dialog.getByRole("button", { name: "Play video", exact: true }),
      ).toBeVisible();
      // Portrait artwork must fill its avatar, independently of the video's fit.
      const portrait = dialog
        .getByRole("button", { name: "Seek to 00:00.5, Alex", exact: true })
        .locator("img");
      await expect(portrait).toHaveAttribute("data-loaded", "true");
      await expect(portrait).toHaveCSS("object-fit", "cover");
    }
    const comments = dialog.getByRole("complementary", {
      name: "Media comments",
    });
    const composer = comments.getByRole("textbox", { name: "Reply to thread" });
    await composer.fill("Keep this draft through theme changes");
    const composerNode = await composer.elementHandle();
    for (const width of [320, 800, 1280]) {
      await page.setViewportSize({ width, height: 720 });
      for (const mode of ["light", "dark", "light"]) {
        await page.evaluate((mode) => {
          document.documentElement.dataset.colorMode = mode;
        }, mode);
        const foreground =
          mode === "light" ? "rgb(15, 15, 15)" : "rgb(255, 255, 255)";
        const surface =
          mode === "light" ? "rgb(255, 255, 255)" : "rgb(26, 26, 26)";
        await expect(heading).toHaveCSS("color", foreground);
        await expect(comments).toHaveCSS("background-color", surface);
        await expect(
          comments.getByRole("heading", { name: "Comments" }),
        ).toHaveCSS("color", foreground);
        await expect(composer).toHaveCSS("color", foreground);
        await expect(
          dialog.getByRole("button", { name: "Hide comments" }),
        ).toHaveCSS("color", foreground);
        await expect(dialog.locator("[data-review-stage]")).toHaveCSS(
          "background-color",
          "rgb(0, 0, 0)",
        );
        await expect(
          dialog.getByRole("button", {
            name: kind === "image" ? /^Image zoom:/ : "Play video",
            exact: true,
          }),
        ).toHaveCSS("color", "rgb(255, 255, 255)");
        expect(
          await composerNode.evaluate(
            (node) =>
              node ===
              document.querySelector(
                '[aria-label="Media comments"] [role="textbox"]',
              ),
          ),
        ).toBe(true);
        await expect(composer).toHaveText(
          "Keep this draft through theme changes",
        );
      }
      if (kind === "video") {
        await page.evaluate(() =>
          window.dispatchEvent(new Event("fixture-typing")),
        );
        const typing = dialog
          .locator('[aria-hidden="true"]')
          .filter({ hasText: "Alex is typing" });
        await expect(
          dialog.getByRole("status", { name: "Conversation activity" }),
        ).toHaveText("Alex is typing");
        const frameOption = dialog.getByRole("checkbox", {
          name: "Comment at current frame",
        });
        await expect(typing).toContainText("Alex is typing");
        const typingBox = await typing.boundingBox();
        const optionBox = await frameOption.boundingBox();
        expect(typingBox.y).toBeGreaterThan(optionBox.y + optionBox.height);
      }
      const control = dialog.getByRole("button", {
        name: kind === "image" ? /^Image zoom:/ : "Play video",
        exact: true,
      });
      if (kind === "image") {
        await control.focus();
        await page.keyboard.press("Tab");
      } else {
        await dialog.focus();
        await page.mouse.move(0, 0);
      }
      const controls =
        kind === "image"
          ? dialog.locator("[data-image-controls]")
          : dialog
              .getByRole("slider", { name: "Video timeline" })
              .locator("..")
              .locator("..");
      await expect(controls).toHaveCSS("opacity", "1");
      await expect
        .poll(() =>
          controls.evaluate((el) => {
            const bounds = el
              .closest('[role="dialog"]')
              .getBoundingClientRect();
            return [...el.querySelectorAll("button, input, a")].every(
              (item) => {
                const rect = item.getBoundingClientRect();
                return (
                  rect.width >= 24 &&
                  rect.height >= 24 &&
                  rect.left >= bounds.left &&
                  rect.right <= bounds.right &&
                  rect.top >= bounds.top &&
                  rect.bottom <= bounds.bottom
                );
              },
            );
          }),
        )
        .toBe(true);
    }
  });
}

test("unavailable media keeps its explanation readable and recovery visible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/tests/fixtures/media-review.html?photo&missing-root");
  const dialog = page.getByRole("dialog", { name: "Image viewer" });
  const message = dialog
    .getByRole("alert")
    .filter({ has: page.getByRole("button", { name: "Retry", exact: true }) });
  await expect(message).toContainText("Original message unavailable.");
  await expect(message).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(
    message.getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Comments" })).toBeVisible();
});

// Inline previews have a much shorter media area than the expanded player.
test("narrow video thumbnails keep play clear of the progress controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/tests/fixtures/media-review.html");
  const preview = page.locator("[data-video-preview]");
  await expect(preview.locator("video")).toHaveCSS("object-fit", "contain");
  await expect(preview).toHaveCSS("clip-path", "none");
  await expect(preview.locator("[data-image-outline]")).toHaveCSS(
    "overflow",
    "visible",
  );
  const play = preview.getByRole("button", { name: "Play video", exact: true });
  // Metadata enables the timeline; do not tab past its initial disabled state.
  await expect(
    preview.getByRole("slider", { name: "Video progress" }),
  ).toBeEnabled();
  const expand = preview.getByRole("button", { name: "Open video fullscreen" });
  await page.mouse.move(0, 0);
  await expect(expand).toHaveCSS("opacity", "0");
  await preview.hover();
  await expect(expand).toHaveCSS("opacity", "1");
  await page.mouse.move(0, 0);
  await expand.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(expand).toHaveCSS("opacity", "1");
  await play.focus();
  await page.keyboard.press("Tab");
  await expect(
    preview.getByRole("button", { name: "Video volume", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  const controls = preview
    .getByRole("slider", { name: "Video progress" })
    .locator("..")
    .locator("..");
  await expect
    .poll(() =>
      controls.evaluate((el) => {
        const play = el.parentElement.querySelector(
          'button[aria-label="Play video"]',
        );
        const frame = el.parentElement.getBoundingClientRect();
        const button = play.getBoundingClientRect();
        return (
          Math.abs(button.x + button.width / 2 - (frame.x + frame.width / 2)) <
            1 &&
          Math.abs(
            button.y + button.height / 2 - (frame.y + frame.height / 2),
          ) < 1 &&
          el.getBoundingClientRect().top >= button.bottom
        );
      }),
    )
    .toBe(true);
  await expect(
    preview.getByRole("slider", { name: "Video progress" }),
  ).toBeFocused();
});

// CSS transitions and their reduced-motion override need a real rendering engine.
test("mute glides the volume knob and keyboard changes stay immediate", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/media-review.html?review");
  const dialog = page.getByRole("dialog", {
    name: "Video review",
    exact: true,
  });
  // Playback hides the controls and, on CI's Linux WebKit, restarts the ended
  // clip when it is muted. Keep the clip still so only the volume UI moves.
  await dialog.locator("[data-review-media]").evaluate((video) => {
    video.autoplay = false;
    video.pause();
  });
  await dialog
    .getByRole("button", { name: "Video volume", exact: true })
    .hover();
  const popup = page.getByRole("dialog", {
    name: "Video volume controls",
    exact: true,
  });
  const volume = page.getByRole("slider", { name: "Video volume" });
  await expect(volume).toBeVisible();
  const knob = volume
    .locator("..")
    .locator('[aria-hidden="true"] > span')
    .last();
  await expect(volume).toHaveValue("1");
  // Hold the actual CSS transition at its midpoint instead of racing its duration.
  // Pause from the poll, not a transitionrun listener, and stretch the 120ms
  // glide so a slow runner cannot finish it before the first poll.
  await knob.evaluate((el) => el.style.setProperty("--duration-fast", "60s"));
  try {
    await popup
      .getByRole("button", { name: "Mute video", exact: true })
      .click();
    await expect(volume).toHaveValue("0");
    await expect
      .poll(() =>
        knob.evaluate((el) => {
          const animation = el.getAnimations()[0];
          if (!animation) return false;
          animation.pause();
          animation.currentTime = animation.effect.getTiming().duration / 2;
          const y = new DOMMatrix(getComputedStyle(el).transform).m42;
          return y < 0 && y > -el.getBoundingClientRect().height;
        }),
      )
      .toBe(true);
  } finally {
    await knob.evaluate((el) => {
      el.getAnimations().forEach((animation) => {
        animation.finish();
      });
      el.style.removeProperty("--duration-fast");
    });
  }
  await popup
    .getByRole("button", { name: "Unmute video", exact: true })
    .click();
  await expect(volume).toHaveValue("1");
  await volume.press("ArrowDown");
  await expect(volume).toHaveValue("0.95");
  await expect(knob).toHaveCSS("transition-duration", "0s");
  await popup
    .getByRole("button", { name: "Mute video", exact: true })
    .press("Enter");
  await expect(volume).toHaveValue("0");
  await expect(knob).toHaveCSS("transition-duration", "0s");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await popup
    .getByRole("button", { name: "Unmute video", exact: true })
    .click();
  await expect(volume).toHaveValue("0.95");
  await expect(knob).toHaveCSS("transition-duration", "0s");
});

// Native hover, portal hit testing, and vertical range geometry are browser contracts.
test("media popovers support hover and keyboard without stealing playback focus", async ({
  page,
}) => {
  // Linux media backends return float32 volume values (0.8 becomes 0.8000000119).
  // Keep that precision boundary covered on every runner, including macOS.
  await page.addInitScript(() => {
    const volume = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      "volume",
    );
    Object.defineProperty(HTMLMediaElement.prototype, "volume", {
      ...volume,
      get() {
        return Math.fround(volume.get.call(this));
      },
    });
  });
  await page.goto("/tests/fixtures/media-review.html?review");
  const review = page.getByRole("dialog", {
    name: "Video review",
    exact: true,
  });
  const trigger = review.getByRole("button", {
    name: "Video volume",
    exact: true,
  });
  await expect(
    review.getByRole("slider", { name: "Video timeline" }),
  ).toBeEnabled();
  // Enter the video before its controls: autoplay can hide chrome during startup.
  await review
    .locator("[data-review-stage]")
    .hover({ position: { x: 8, y: 8 } });
  await expect(trigger.locator("..")).toHaveCSS("opacity", "1");
  await trigger.hover();
  const volumePopup = page.getByRole("dialog", {
    name: "Video volume controls",
    exact: true,
  });
  const volume = volumePopup.getByRole("slider", { name: "Video volume" });
  await expect(volume).toBeVisible();
  await volume.hover();
  await expect(volumePopup).toBeVisible();
  const geometry = await volume.boundingBox();
  expect(geometry.height).toBeGreaterThan(geometry.width);
  const popupGeometry = await volumePopup.boundingBox();
  expect(popupGeometry.width).toBeLessThanOrEqual(44);
  expect(
    await volumePopup.evaluate((el) =>
      Number.parseFloat(getComputedStyle(el).borderTopLeftRadius),
    ),
  ).toBeGreaterThanOrEqual(popupGeometry.width / 2);
  // Native vertical input: the upper part raises volume and the lower part lowers it.
  await volume.click({
    position: { x: geometry.width / 2, y: 4 + (geometry.height - 8) * 0.2 },
  });
  await expect.poll(() => volume.inputValue()).toBe("0.8");
  await volume.press("ArrowDown");
  await expect(volume).toBeFocused();
  await expect(volume).toHaveValue("0.75");
  await expect(review.locator("video")).toHaveJSProperty("volume", 0.75);
  await volume.press("Escape");
  await expect(volumePopup).toBeHidden();
  await expect(review).toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await expect(volume).toBeFocused();
  await expect(volume).toHaveValue("0.75");
  await expect(review.locator("video")).toHaveJSProperty("muted", false);
  await volume.press("Escape");
  await expect(volumePopup).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(review.locator("video")).toHaveJSProperty("muted", false);
  await expect(review.locator("video")).toHaveJSProperty("volume", 0.75);
  await trigger.press("Space");
  await expect(volume).toBeFocused();
  await expect(volume).toHaveValue("0.75");
  await volume.press("ArrowDown");
  await expect(volume).toHaveValue("0.7");
  await expect
    .poll(() => review.locator("video").evaluate((video) => video.volume))
    .toBeCloseTo(0.7, 6);
  await volume.press("Tab");
  const mute = volumePopup.getByRole("button", {
    name: "Mute video",
    exact: true,
  });
  await expect(mute).toBeFocused();
  await mute.press("Enter");
  await expect(volume).toHaveValue("0");
  await expect(review.locator("video")).toHaveJSProperty("muted", true);
  const unmute = volumePopup.getByRole("button", {
    name: "Unmute video",
    exact: true,
  });
  await unmute.press("Space");
  await expect(volume).toHaveValue("0.7");
  await expect(review.locator("video")).toHaveJSProperty("muted", false);
  await mute.press("Tab");
  await expect(
    review.getByRole("slider", { name: "Video timeline" }),
  ).toBeFocused();
  const speed = review.getByRole("button", { name: "Playback speed: 1x" });
  await speed.hover();
  const menu = page.getByRole("menu", { name: /^Playback speed:/ });
  await expect(menu).toBeVisible();
  expect((await menu.boundingBox()).width).toBeLessThan(120);
  await menu.getByRole("menuitemradio", { name: "1.5x", exact: true }).click();
  await expect(review.locator("video")).toHaveJSProperty("playbackRate", 1.5);
  await expect(menu).toBeHidden();
});

test("timeline hover marks the click position without seeking until clicked", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/media-review.html?review");
  const review = page.getByRole("dialog", {
    name: "Video review",
    exact: true,
  });
  const video = review.locator("video");
  await expect
    .poll(() => video.evaluate((el) => el.readyState))
    .toBeGreaterThanOrEqual(2);
  await video.evaluate((el) => {
    el.pause();
  });
  const before = await video.evaluate((el) => el.currentTime);
  const timeline = review.getByRole("slider", { name: "Video timeline" });
  const bounds = await timeline.boundingBox();
  await expect(timeline).toHaveCSS("background-size", "100% 2px");
  const x = bounds.x + 1 + (bounds.width - 2) * 0.4;
  await page.mouse.move(x, bounds.y + bounds.height / 2);
  const preview = review.locator("[data-seek-preview]");
  await expect(preview).toBeVisible();
  await expect(preview).toHaveCSS("width", "2px");
  const marker = await preview.boundingBox();
  expect(Math.abs(marker.x + marker.width / 2 - x)).toBeLessThan(1);
  expect(
    await preview.evaluate((el) => getComputedStyle(el, "::before").opacity),
  ).toBe("0.5");
  await expect(video).toHaveJSProperty("currentTime", before);
  await page.mouse.click(x, bounds.y + bounds.height / 2);
  await expect
    .poll(() => video.evaluate((el) => el.currentTime))
    .toBeCloseTo((await video.evaluate((el) => el.duration)) * 0.4, 1);
  await page.mouse.move(0, 0);
  await expect(preview).toBeHidden();
});

// Native touch activation must disclose the controls without mutating media.
test.describe("touch volume controls", () => {
  test.use({ hasTouch: true });

  test("opening and dismissing volume preserves sound until an explicit mute", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 320 });
    await page.goto("/tests/fixtures/media-review.html?review");
    const review = page.getByRole("dialog", {
      name: "Video review",
      exact: true,
    });
    const video = review.locator("video");
    await expect(
      review.getByRole("slider", { name: "Video timeline" }),
    ).toBeEnabled();
    await video.evaluate((element) => {
      element.volume = 0.75;
    });
    const trigger = review.getByRole("button", {
      name: "Video volume",
      exact: true,
    });
    await trigger.tap();
    const popup = page.getByRole("dialog", {
      name: "Video volume controls",
      exact: true,
    });
    await expect(
      popup.getByRole("slider", { name: "Video volume" }),
    ).toHaveValue("0.75");
    await expect(video).toHaveJSProperty("muted", false);
    await expect(video).toHaveJSProperty("volume", 0.75);
    await expect
      .poll(() =>
        popup.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return [...element.querySelectorAll("input, button")].every(
            (control) => {
              const rect = control.getBoundingClientRect();
              return (
                rect.width >= 24 &&
                rect.height >= 24 &&
                rect.top >= bounds.top &&
                rect.bottom <= bounds.bottom &&
                rect.left >= bounds.left &&
                rect.right <= bounds.right
              );
            },
          );
        }),
      )
      .toBe(true);
    await trigger.tap();
    await expect(popup).toBeHidden();
    await expect(video).toHaveJSProperty("muted", false);
    await expect(video).toHaveJSProperty("volume", 0.75);
    await trigger.tap();
    await popup.getByRole("button", { name: "Mute video", exact: true }).tap();
    await expect(video).toHaveJSProperty("muted", true);
    await expect(
      popup.getByRole("slider", { name: "Video volume" }),
    ).toHaveValue("0");
    await popup
      .getByRole("button", { name: "Unmute video", exact: true })
      .tap();
    await expect(video).toHaveJSProperty("muted", false);
    await expect(
      popup.getByRole("slider", { name: "Video volume" }),
    ).toHaveValue("0.75");
    await expect(video).toHaveJSProperty("volume", 0.75);
  });
});
