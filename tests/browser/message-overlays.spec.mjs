import { hoverMessage } from "./message-actions.mjs";
import { settleDialogMotion } from "./navigation.mjs";
import { test, expect } from "./source-fixture.mjs";
import { settle } from "./timeline.mjs";
import { animationsSettled } from "./animations.mjs";

// Browser-only: real nested hover, deferred toolbar mounting, and top-layer
// visibility must agree with the production reaction row and preview wiring.
test("reaction previews and the inline picker do not reveal message hover actions", async ({
  page,
}) => {
  await page.route("**/emoji-media/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"/>',
    }),
  );
  await page.goto("/tests/fixtures/emoji.html?reactions&wrap&narrow");
  const row = page.locator("[data-message-id]").first();
  // Failed emoji retries rewrap the prose and move reactions off a still pointer.
  await expect(
    row.locator('p img[data-copy-emoji=":party:"]'),
  ).toHaveJSProperty("naturalWidth", 22);
  const reaction = row.locator('button[data-reaction="👍"]');
  const actions = row.getByRole("group", { name: "Message actions" });
  const body = row.locator("[data-message-action-anchor]").first();
  const expectActionsClosed = async () => {
    // Closed controls stay in DOM/tab order; opacity, hit testing, and native
    // top-layer state establish that they neither paint nor intercept input.
    await expect(actions).toHaveCSS("opacity", "0");
    await expect(actions).toHaveCSS("pointer-events", "none");
    await expect
      .poll(() => actions.evaluate((bar) => bar.matches(":popover-open")))
      .toBe(false);
  };
  const plus = row.getByTestId("reaction-row").getByRole("button", {
    name: "Add reaction",
    exact: true,
  });
  // Enter an untouched row directly through its reactions, not its body.
  await reaction.hover();
  const preview = page.locator('.buzz-preview-card[role="tooltip"][data-open]');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Fixture Member");
  await expectActionsClosed();
  // Enter prose below the toolbar overlap, away from the nested reactions.
  await body.hover({ position: { x: 8, y: 32 } });
  await expect(actions).toHaveCSS("opacity", "1");
  // Finish the previous preview's exit before testing a fresh hover entry.
  await expect(page.locator(".buzz-preview-card")).toHaveCount(0);
  await reaction.hover();
  await expect(preview).toBeVisible();
  await expectActionsClosed();
  await plus.hover();
  await expectActionsClosed();
  await plus.click();
  const picker = page.locator('em-emoji-picker input[type="search"]');
  await expect(picker).toBeVisible();
  await expectActionsClosed();
  await picker.press("Escape");
  await expect(picker).toHaveCount(0);
  await body.hover({ position: { x: 8, y: 32 } });
  await expect(actions).toHaveCSS("opacity", "1");
  await actions.getByRole("button", { name: "More message actions" }).hover();
  await expect(actions).toHaveCSS("opacity", "1");
  // Moving the pointer alone does not end keyboard focus restored by Escape.
  await page.mouse.click(0, 0);
  await expectActionsClosed();

  // Keyboard focus still reveals message actions, so retain the paint-order
  // contract when the reactor preview and toolbar can legitimately coexist.
  await page.keyboard.press("Tab");
  await reaction.focus();
  await reaction.hover();
  await expect(preview).toBeVisible();
  await expect(actions).toHaveCSS("opacity", "1");
  await actions.evaluate((bar) => {
    const card = document.querySelector(".buzz-preview-card[data-open]");
    const rect = card.getBoundingClientRect();
    bar.style.top = `${rect.top}px`;
    bar.style.left = `${rect.left}px`;
    bar.style.right = "auto";
  });
  await expect
    .poll(() =>
      preview.evaluate((card) => {
        const rect = card.getBoundingClientRect();
        card.style.pointerEvents = "auto";
        const hit = document.elementFromPoint(rect.left + 10, rect.top + 10);
        card.style.pointerEvents = "";
        return card === hit || card.contains(hit);
      }),
    )
    .toBe(true);
});

test("video speed options escape the thread and restore focus after selection and Escape", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/media-review.html?thread", {
    waitUntil: "domcontentloaded",
  });
  await page.evaluate(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.dataset.colorMode = "light";
  });
  const trigger = page
    .getByRole("button", { name: "Playback speed: 1x" })
    .first();
  await expect(trigger).toBeVisible();
  await expect(
    page.getByRole("slider", { name: "Video progress", exact: true }).first(),
  ).toBeEnabled();
  // Model the constrained grid cell that hosts ThreadPanel in the app.
  // A height on a plain block wrapper does not constrain the panel itself.
  await page
    .getByRole("complementary", { name: "Thread", exact: true })
    .evaluate((panel) => {
      Object.assign(panel.parentElement.style, {
        display: "grid",
        height: "400px",
      });
    });
  const scroller = page.getByRole("region", {
    name: "Thread messages",
    exact: true,
  });
  await expect(scroller).toHaveAttribute("aria-busy", "false");
  // Finish resize-driven positioning before establishing the menu's scroll baseline.
  await settle(page, scroller);
  // Mark this as a reader gesture and capture the resized viewport before
  // assigning the exact clipping geometry used by this paint-order test.
  await scroller.dispatchEvent("wheel", { deltaY: -1 });
  await trigger.evaluate((button) => {
    const scroller = button.closest("[data-message-scroller]");
    // WebKit truncates fractional scroll requests. Round the final position so
    // fractional message heights still reach the same constrained-menu setup.
    scroller.scrollTop = Math.round(
      scroller.scrollTop +
        button.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        40,
    );
  });
  await expect
    .poll(() =>
      trigger.evaluate((button) => {
        const scroller = button.closest("[data-message-scroller]");
        return (
          button.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top
        );
      }),
    )
    .toBeCloseTo(40, 0);
  // The scroll event commits reading intent after geometry changes. Opening
  // the menu first can let a pending render follow the old bottom position.
  await expect(
    scroller.getByRole("button", { name: "Jump to latest", exact: true }),
  ).toBeVisible();
  await trigger.press("Enter");
  const menu = page.getByRole("menu", { name: /^Playback speed:/ });
  await expect(menu).toBeVisible();
  // The scoped dark owner must keep the explicit floating recipe, not the
  // ordinary dark control fill (#232323), even though the host stays light.
  await expect(menu).toHaveCSS("--interaction-fill", "#404040");
  await expect(menu).toHaveCSS("background-color", "rgba(40, 40, 40, 0.9)");
  await expect(menu).toHaveCSS("backdrop-filter", "blur(8px)");
  const fast = menu.getByRole("menuitemradio", { name: "2x", exact: true });
  await expect
    .poll(() =>
      fast.evaluate((item) => {
        const rect = item.getBoundingClientRect();
        const edge = document
          .querySelector("[data-message-scroller]")
          .getBoundingClientRect().top;
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return rect.top < edge && (item === hit || item.contains(hit));
      }),
    )
    .toBe(true);
  await fast.click();
  await expect(menu).toBeHidden();
  const updated = page
    .getByRole("button", { name: "Playback speed: 2x" })
    .first();
  await expect(updated).toBeFocused();
  await expect(page.locator("video").first()).toHaveJSProperty(
    "playbackRate",
    2,
  );
  await updated.press("Enter");
  await expect(
    menu.getByRole("menuitemradio", { name: "2x", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(updated).toBeFocused();
  await updated.click();
  await expect(menu).toBeVisible();
  // Modal menus intentionally block the page underneath. Send the outside
  // pointer gesture to that backdrop, rather than waiting for a heading to
  // receive a click through it.
  const heading = await page
    .getByRole("heading", { name: "Video and photo review" })
    .boundingBox();
  if (!heading) throw new Error("Media review heading is missing");
  await page.mouse.click(heading.x + 8, heading.y + heading.height / 2);
  await expect(menu).toBeHidden();
  await page.locator("[data-video-preview]").first().hover();
  await page
    .getByRole("button", { name: "Open video fullscreen" })
    .first()
    .click();
  const review = page.getByRole("dialog", {
    name: "Video review",
    exact: true,
  });
  const reviewSpeed = review.getByRole("button", {
    name: "Playback speed: 2x",
  });
  await reviewSpeed.focus();
  await reviewSpeed.press("Enter");
  await expect(menu).toBeVisible();
  await expect(menu).toHaveCSS("--interaction-fill", "#404040");
  await expect(
    menu.getByRole("menuitemradio", { name: "2x", exact: true }),
  ).toHaveCSS("background-color", "rgb(46, 46, 46)");
  await expect(
    menu.getByRole("menuitemradio", { name: "2x", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await expect(
    menu.getByRole("menuitemradio", { name: "2x", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    menu.getByRole("menuitemradio", { name: "1.75x", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  const selected = review.getByRole("button", {
    name: "Playback speed: 1.75x",
  });
  await expect(selected).toBeFocused();
  await selected.press("Enter");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(review).toBeVisible();
  await expect(selected).toBeFocused();
});

// Retry is a Button under the viewer's unavailable-media branch, not its header.
test("unavailable dark media review keeps Retry readable in a light host", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/media-review.html?photo&missing-root");
  await page.evaluate(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.dataset.colorMode = "light";
  });
  const dialog = page.getByRole("dialog", { name: "Image viewer" });
  const retry = dialog.getByRole("button", { name: "Retry", exact: true });
  await expect(dialog.getByRole("alert").first()).toContainText(
    "Original message unavailable.",
  );
  await expect(retry).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(retry).toHaveCSS("background-color", "rgb(35, 35, 35)");
  await retry.hover();
  await expect(retry).toHaveCSS("background-color", "rgb(46, 46, 46)");
});

// Shared preview callers must retain viewport placement and non-stealing focus.
test("resolved chip previews fit narrow, intermediate and wide themed views", async ({
  page,
}) => {
  await page.goto(
    "/tests/fixtures/design-system.html#/design/components/inline-chip",
  );
  const chip = page
    .locator('button.inline-chip[data-state="resolved"]')
    .first();
  for (const [width, mode] of [
    [390, "light"],
    [900, "dark"],
    [1440, "light"],
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await page.evaluate((mode) => {
      document.documentElement.classList.toggle("dark", mode === "dark");
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    await chip.scrollIntoViewIfNeeded();
    await chip.focus();
    await chip.hover();
    const preview = page.locator(
      '.buzz-preview-card[role="tooltip"][data-open]',
    );
    await expect(preview).toBeVisible();
    await expect(chip).toBeFocused();
    await expect
      .poll(() =>
        preview.evaluate((card) => {
          const rect = card.getBoundingClientRect();
          return (
            rect.left >= 0 &&
            rect.right <= innerWidth &&
            rect.top >= 0 &&
            rect.bottom <= innerHeight
          );
        }),
      )
      .toBe(true);
    await page.mouse.move(0, 0);
    await chip.blur();
    await expect(page.locator(".buzz-preview-card")).toHaveCount(0);
  }
});

// Browser-only: sibling reflow moves the anchor without resizing the observed
// row/slot/scroller. jsdom cannot establish this geometry or native focus.
test("focused actions follow sibling growth and shrinkage without scrolling", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/emoji.html");
  const rows = page.locator("[data-message-id]");
  const sibling = rows.nth(0);
  const row = rows.nth(1);
  await expect(row).toBeVisible();
  // Bound the real message list without introducing app traffic that could
  // accidentally rescue stale positioning through unrelated DOM mutations.
  await row.evaluate((node) => {
    const list = node.parentElement;
    list.setAttribute("data-message-scroller", "");
    list.style.height = "600px";
    list.style.overflow = "auto";
  });
  const scroller = page.locator("[data-message-scroller]");
  const actions = row.getByRole("group", {
    name: "Message actions",
    includeHidden: true,
  });
  await hoverMessage(row);
  await expect
    .poll(() => actions.evaluate((bar) => bar.matches(":popover-open")))
    .toBe(true);
  const button = actions.getByRole("button").first();
  await button.focus();
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  await settle(page, scroller);
  const baseline = await actions.evaluate((bar) => {
    const slot = bar.parentElement;
    const scroller = bar.closest("[data-message-scroller]");
    return {
      top: slot.getBoundingClientRect().top,
      barBottom: bar.getBoundingClientRect().bottom,
      slotHeight: slot.offsetHeight,
      rowHeight: bar.closest("[data-layout]").offsetHeight,
      scrollerHeight: scroller.clientHeight,
      scrollTop: scroller.scrollTop,
    };
  });
  const scrolls = await scroller.evaluateHandle((node) => {
    const state = { count: 0 };
    const listener = () => state.count++;
    node.addEventListener("scroll", listener);
    return {
      state,
      dispose: () => node.removeEventListener("scroll", listener),
    };
  });
  try {
    for (const growth of [100, 0]) {
      // Models an attachment or edit changing only the preceding message's height.
      await sibling.evaluate((node, growth) => {
        node.style.paddingBottom = `${growth}px`;
      }, growth);
      await expect
        .poll(() =>
          actions.evaluate((bar) => ({
            slotTop: bar.parentElement.getBoundingClientRect().top,
            barBottom: bar.getBoundingClientRect().bottom,
          })),
        )
        .toEqual({
          slotTop: baseline.top + growth,
          barBottom: baseline.barBottom + growth,
        });
      await expect(button).toBeFocused();
      await expect
        .poll(() => actions.evaluate((bar) => bar.matches(":popover-open")))
        .toBe(true);
      // Complete layout and scroll-event delivery before the negative assertions.
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          }),
      );
      expect(
        await actions.evaluate((bar) => ({
          slotHeight: bar.parentElement.offsetHeight,
          rowHeight: bar.closest("[data-layout]").offsetHeight,
          scrollerHeight: bar.closest("[data-message-scroller]").clientHeight,
          scrollTop: bar.closest("[data-message-scroller]").scrollTop,
        })),
      ).toEqual({
        slotHeight: baseline.slotHeight,
        rowHeight: baseline.rowHeight,
        scrollerHeight: baseline.scrollerHeight,
        scrollTop: baseline.scrollTop,
      });
      expect(await scrolls.evaluate(({ state }) => state.count)).toBe(0);
    }
  } finally {
    await scrolls.evaluate(({ dispose }) => dispose());
    await scrolls.dispose();
  }
});

// Top-layer previews ignore z-index, so only the browser can show a background
// destination staying clickable above a modal opened while it was hovered.
test("destination previews yield to modals they are outside", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/tests/fixtures/preview-modal.html");
  const preview = (name) =>
    page.getByRole("link", { name: `${name} preview`, exact: true });
  const clickable = (card) =>
    card.evaluate((card) => {
      const rect = card.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + 10, rect.top + 10);
      return card === hit || card.contains(hit);
    });
  const background = preview("Background");
  await page.getByRole("link", { name: "Open Background" }).hover();
  await expect(background).toBeVisible();
  const bounds = await background.boundingBox();
  await page.mouse.move(bounds.x + 10, bounds.y + 10);
  await expect.poll(() => clickable(background)).toBe(true);

  await page.getByRole("button", { name: "Open modal" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Modal" });
  await expect(dialog).toBeVisible();
  // Outlast the close delay with the pointer still over the preview.
  await page.clock.runFor(1000);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .querySelector(".buzz-preview-card[data-open]")
            ?.parentElement?.matches(":popover-open") ?? false,
      ),
    )
    .toBe(false);
  // The backdrop, not the background preview, receives the click.
  await page.mouse.click(bounds.x + 10, bounds.y + 10);
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.previewClicks)).toEqual([]);

  // A trigger inside the active modal keeps its preview above the backdrop.
  await page.mouse.move(0, 0);
  await page.getByRole("button", { name: "Open modal" }).click();
  // A pointer-opened modal animates in; hover once the trigger stops moving.
  await settleDialogMotion(dialog);
  await dialog.getByRole("link", { name: "Open Inside" }).hover();
  const inside = preview("Inside");
  await expect(inside).toBeVisible();
  await expect.poll(() => clickable(inside)).toBe(true);
  await inside.click();
  expect(await page.evaluate(() => window.previewClicks)).toEqual(["Inside"]);

  // Once dismissed, background previews rejoin the top layer.
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("link", { name: "Open Background" }).hover();
  await expect(background).toBeVisible();
  await expect.poll(() => clickable(background)).toBe(true);
});

// Browser-only: enlarged geometry, clipping and actual control hit targets.
test("enlarged media review reflows comments and keeps playback controls reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/tests/fixtures/media-review.html?review");
  const review = page.getByRole("dialog", {
    name: "Video review",
    exact: true,
  });
  const video = review.locator("video");
  await expect(video).toHaveJSProperty("readyState", 4);
  // This tests enlarged hit targets, not autoplay. Explicitly pause so the short
  // clip cannot end and restart in WebKit when muting makes autoplay eligible.
  await video.evaluate((el) => el.pause());
  await expect(
    review.getByRole("button", { name: "Play video", exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "2"),
  );
  const stage = review.locator("[data-review-stage]");
  await expect
    .poll(() => stage.evaluate((el) => el.getBoundingClientRect().width))
    .toBeGreaterThan(700);
  const speed = review.getByRole("button", { name: "Playback speed: 1x" });
  const volumeTrigger = review.getByRole("button", {
    name: "Video volume",
    exact: true,
  });
  const reaction = review.getByRole("button", {
    name: "React 😂 at current frame",
    exact: true,
  });
  const mute = page
    .getByRole("dialog", { name: "Video volume controls", exact: true })
    .getByRole("button", { name: /^(Unmute|Mute) video$/ });
  const expectReachable = async (control) => {
    await expect(control).toBeInViewport();
    await expect
      .poll(() =>
        control.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return (
            r.left >= 0 &&
            r.right <= innerWidth &&
            el.contains(
              document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
            )
          );
        }),
      )
      .toBe(true);
  };
  for (const width of [1024, 800]) {
    await page.setViewportSize({ width, height: 768 });
    await stage.hover({ position: { x: 8, y: 8 } });
    for (const control of [
      speed,
      volumeTrigger,
      reaction,
      review.getByRole("slider", { name: "Video timeline", exact: true }),
    ]) {
      await expectReachable(control);
    }
    await volumeTrigger.hover();
    await expectReachable(mute);
    await mute.press("Escape");
    await expect(mute).toBeHidden();
  }
  await stage.hover({ position: { x: 8, y: 8 } });
  await volumeTrigger.hover();
  const volume = page.getByRole("slider", {
    name: "Video volume",
    exact: true,
  });
  await expect(volume).toBeInViewport();
  await volume.press("Escape");
  await speed.click();
  await page.getByRole("menuitemradio", { name: "2x", exact: true }).click();
  await expect(video).toHaveJSProperty("playbackRate", 2);
  const wasMuted = await video.evaluate((el) => el.muted);
  await stage.hover({ position: { x: 8, y: 8 } });
  await volumeTrigger.hover();
  await expectReachable(mute);
  await expect(video).toHaveJSProperty("muted", wasMuted);
  await mute.click();
  await expect(video).toHaveJSProperty("muted", !wasMuted);
  await expect(video).toHaveJSProperty("paused", true);
  await reaction.click();
  const comments = review.getByRole("complementary", {
    name: "Media comments",
  });
  await comments.scrollIntoViewIfNeeded();
  const postedReaction = comments.locator("p[data-single-emoji]", {
    hasText: "😂",
  });
  await expect(postedReaction).toBeVisible();
  await postedReaction.scrollIntoViewIfNeeded();
  await expect(postedReaction).toBeInViewport();
  await review
    .getByRole("button", { name: "Hide comments", exact: true })
    .click();
  await expect(comments).toBeHidden();
  await review
    .getByRole("button", { name: "Show comments", exact: true })
    .click();
  await expect(comments).toBeVisible();
});

// Browser-only: a CSS transform transition on an ancestor moves the top-layer
// toolbar's slot without resizing, mutating or scrolling anything observable.
test("comment actions revealed while the drawer slides realign when it settles", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/media-review.html?photo");
  const review = page.getByRole("dialog", {
    name: "Image viewer",
    exact: true,
  });
  const drawer = review.getByRole("complementary", { name: "Media comments" });
  const row = drawer.locator("[data-review-comment] [data-message-id]").first();
  const actions = row.getByRole("group", {
    name: "Message actions",
    includeHidden: true,
  });
  const shown = () =>
    expect
      .poll(() => actions.evaluate((bar) => bar.matches(":popover-open")))
      .toBe(true);
  await expect(row).toBeVisible();
  await review
    .getByRole("button", { name: "Hide comments", exact: true })
    .click();
  await expect(drawer).toBeHidden();
  // The role hides at once, but the closing slide runs on. Reopening before it
  // ends reverses that slide from near the open position. Visibility turns
  // hidden only once the slide has ended.
  await expect
    .poll(() =>
      page
        .locator('aside[aria-label="Media comments"]')
        .evaluate((node) => getComputedStyle(node).visibility),
    )
    .toBe("hidden");
  // Hold the opening slide early in its transform transition. transitionrun is
  // dispatched after a frame, which can outlast the slide on a loaded runner.
  // A mutation callback runs before any frame, and getAnimations() flushes
  // style, so it creates the slide still at its start.
  await page.evaluate(() => {
    const drawer = document.querySelector('aside[aria-label="Media comments"]');
    const viewer = drawer.closest("[data-comments-hidden]");
    window.drawerHeld = new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (viewer.hasAttribute("data-comments-hidden")) return;
        observer.disconnect();
        const slide = drawer
          .getAnimations()
          .find((animation) => animation.transitionProperty === "transform");
        slide.pause();
        slide.currentTime = 40;
        window.drawerSlide = slide;
        resolve();
      });
      observer.observe(viewer, { attributeFilter: ["data-comments-hidden"] });
    });
  });
  await review
    .getByRole("button", { name: "Show comments", exact: true })
    .click();
  await page.evaluate(() => window.drawerHeld);
  await hoverMessage(row);
  await shown();
  const anchoring = () =>
    actions.evaluate((bar) => {
      const bubble = bar
        .closest("[data-layout]")
        .querySelector("[data-message-action-anchor]")
        .getBoundingClientRect();
      const rect = bar.getBoundingClientRect();
      return {
        right: Math.round(bubble.right),
        anchored:
          Math.abs(bubble.top + 8 - rect.bottom) < 1 &&
          Math.abs(
            Math.min(
              bubble.right + 8,
              bar.closest("[data-message-scroller]").getBoundingClientRect()
                .right - 12,
              document.documentElement.clientWidth - 12,
            ) - rect.right,
          ) < 1,
      };
    });
  // Keep the drawer held while the toolbar's own entrance settles.
  await animationsSettled(actions);
  // The animated gap queues a resize-observer positioning frame after entry.
  await expect.poll(anchoring).toMatchObject({ anchored: true });
  const moving = await anchoring();
  expect(moving.anchored).toBe(true);
  await page.evaluate(() => {
    window.drawerSlide.play();
    return window.drawerSlide.finished.then(() => {});
  });
  await expect
    .poll(() => drawer.evaluate((node) => getComputedStyle(node).transform))
    .toBe("none");
  // The slot settled well left of where the toolbar was revealed; the toolbar
  // must follow it there without any further pointer, scroll or resize input.
  const settled = await anchoring();
  expect(moving.right - settled.right).toBeGreaterThan(20);
  await expect.poll(anchoring).toEqual({ ...settled, anchored: true });
  await shown();
});

// Real pointer hit testing and preview transitions cannot be proved in jsdom.
test("a grouped reaction toggles my contribution while its preview is open", async ({
  page,
}) => {
  await page.route("**/emoji-media/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"/>',
    }),
  );
  await page.goto("/tests/fixtures/emoji.html?reactions&repeated");
  const row = page.locator("[data-message-id]").first();
  // Failed emoji retries rewrap the prose and move reactions off a still pointer.
  await expect(
    row.locator('p img[data-copy-emoji=":party:"]'),
  ).toHaveJSProperty("naturalWidth", 22);
  const button = row.locator('button[data-reaction="😂"]');
  const matching = row.locator('button[data-reaction="😂"]');
  await expect(button).toHaveCount(1);
  await expect(matching).toHaveCount(1);
  await expect(button).toHaveAccessibleName("😂: 2 people");
  for (let cycle = 0; cycle < 2; cycle++) {
    await page.mouse.move(0, 0);
    // Each cycle starts after the previous click-dismissed preview has exited.
    await expect(page.locator(".buzz-preview-card")).toHaveCount(0);
    await button.hover();
    const preview = page.locator(".buzz-preview-card[data-open]");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("Fixture Member");
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(matching).toHaveCount(1);
    await expect(button).toHaveAccessibleName("😂: 3 people");
    await expect(button).toHaveAttribute("aria-disabled", "false");
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(matching).toHaveCount(1);
    await expect(button).toHaveAccessibleName("😂: 2 people");
    await expect(button).toHaveCount(1);
    await expect(button).toHaveAttribute("aria-disabled", "false");
  }
});

// A direct pointer click does not wait for preview handoff animations to settle.
test("clicking a grouped reaction during preview handoff toggles it", async ({
  page,
}) => {
  await page.route("**/emoji-media/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"/>',
    }),
  );
  await page.goto("/tests/fixtures/emoji.html?reactions&wrap&repeated&narrow");
  const row = page.locator("[data-message-id]").first();
  // Failed emoji retries rewrap the prose and move reactions off a still pointer.
  await expect(
    row.locator('p img[data-copy-emoji=":party:"]'),
  ).toHaveJSProperty("naturalWidth", 22);
  const button = row.locator('button[data-reaction="😂"]');
  const matching = row.locator('button[data-reaction="😂"]');
  await expect(button).toHaveCount(1);
  await expect(matching).toHaveCount(1);
  await expect(button).toHaveAccessibleName("😂: 2 people");
  await row.locator('button[data-reaction="👍"]').hover();
  await expect(page.locator(".buzz-preview-card[data-open]")).toBeVisible();
  const box = await button.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(matching).toHaveCount(1);
  await expect(button).toHaveAccessibleName("😂: 3 people");
});
