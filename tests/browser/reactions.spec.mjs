import {
  hoverMessage,
  expectMessageActionsHidden,
} from "./message-actions.mjs";
import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";
import { animationsSettled } from "./animations.mjs";

test("reaction plus opens a visible emoji-only picker, restores focus and publishes custom emoji", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.route("**/emoji-media/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><circle cx="11" cy="11" r="10" fill="purple"/></svg>',
    }),
  );
  await page.goto("/tests/fixtures/emoji.html?reactions");
  const root = page
    .locator("[data-message-id]")
    .filter({ hasText: "Historic" });
  const plus = root
    .getByRole("group", { name: "Message actions", includeHidden: true })
    .getByRole("button", {
      name: "Add reaction",
      exact: true,
      includeHidden: true,
    });
  // Every message exposes first-reaction controls, not just previously reacted rows.
  const rows = page.locator("[data-message-id]");
  await expect(rows).toHaveCount(6);
  for (const row of await rows.all()) {
    await hoverMessage(row);
    await expect(
      row
        .getByRole("group", { name: "Message actions", includeHidden: true })
        .getByRole("button", { name: "Add reaction", exact: true }),
    ).toBeVisible();
  }
  await expect(
    page
      .getByRole("group", { name: "Message actions", includeHidden: true })
      .getByRole("button", { name: "Add reaction", exact: true }),
  ).toHaveCount(6);
  await hoverMessage(root);
  await expect(root.getByRole("button", { name: /^React with / })).toHaveCount(
    0,
  );
  const actions = root.getByRole("group", {
    name: "Message actions",
    includeHidden: true,
  });
  // Visibility-hidden anchors still have geometry; Playwright's boundingBox
  // deliberately returns null for them. Measure the real DOM box instead.
  const bounds = (element) =>
    element.evaluate((node) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    });
  await animationsSettled(actions);
  const actionsBefore = await bounds(actions);
  const plusBefore = await bounds(plus);
  await plus.click();
  const search = page.locator('em-emoji-picker input[type="search"]');
  await expect(search).toBeVisible();
  // Mounting the portaled picker must not introduce another flex gap.
  await expect.poll(() => bounds(actions)).toEqual(actionsBefore);
  await expect.poll(() => bounds(plus)).toEqual(plusBefore);
  await search.hover();
  await search.focus();
  await expect(
    root.getByRole("group", { name: "Message actions", includeHidden: true }),
  ).toHaveCSS("visibility", "hidden");
  const padding = await search.evaluate((input) => {
    const field = input.parentElement.getBoundingClientRect();
    const picker = input
      .getRootNode()
      .querySelector("#root")
      .getBoundingClientRect();
    return {
      top: field.top - picker.top,
      left: field.left - picker.left,
      right: picker.right - field.right,
    };
  });
  expect(padding.top).toBeCloseTo(padding.left, 1);
  expect(padding.top).toBeCloseTo(padding.right, 1);
  await expect(search.locator("..")).toHaveCSS("border-radius", "159984px");
  await expect(page.getByRole("tab", { name: "GIF", exact: true })).toHaveCount(
    0,
  );
  await search.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(plus).toBeFocused();
  await hoverMessage(root);
  await plus.click();
  await search.fill("party");
  const custom = page
    .locator("em-emoji-picker button")
    .filter({ has: page.locator('img[src*="1.png"]') })
    .first();
  await expect(custom).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("reaction-picker.png"),
  });
  await custom.click();
  await expect(search).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => window.emojiFixture.report.publications.length),
    )
    .toBe(1);
  const event = await page.evaluate(
    () => window.emojiFixture.report.publications[0].event,
  );
  expect(event.kind).toBe(7);
  expect(event.content).toBe(":party:");
  expect(event.tags).toContainEqual([
    "emoji",
    "party",
    "https://a.test/media/1.png",
  ]);
  expect(event.tags.filter(([name]) => name === "e")).toHaveLength(1);
  for (const length of [62, 63, 64]) {
    await hoverMessage(root);
    await plus.click();
    const boundarySearch = page.locator('em-emoji-picker input[type="search"]');
    const shortcode = "a".repeat(length);
    await boundarySearch.fill(shortcode);
    await page
      .getByRole("button", { name: `:${shortcode}:`, exact: true })
      .click();
  }
  await expect
    .poll(() =>
      page.evaluate(() => window.emojiFixture.report.publications.length),
    )
    .toBe(4);
  await page.evaluate(() => window.emojiFixture.archive(true));
  await expect(plus).toHaveCount(0);
  await page.evaluate(() => window.emojiFixture.archive(false));
  await expect(plus).toHaveCount(1);
  await hoverMessage(root);
  const boundaryEvents = await page.evaluate(() =>
    window.emojiFixture.report.publications.slice(1).map(({ event }) => event),
  );
  expect(boundaryEvents.map(({ content }) => content)).toEqual(
    [62, 63, 64].map((length) => `:${"a".repeat(length)}:`),
  );
  expect(boundaryEvents.every(({ kind }) => kind === 7)).toBe(true);
  await page.evaluate(() => window.emojiFixture.rejectReaction());
  await hoverMessage(root);
  await plus.click();
  await page
    .locator("em-emoji-picker button")
    .filter({ has: page.locator('img[src*="1.png"]') })
    .first()
    .click();
  const retry = page.getByRole("button", { name: "Retry reaction" });
  await expect(retry).toBeVisible();
  await page.evaluate(() => window.emojiFixture.remount());
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => window.emojiFixture.report.publications.length),
    )
    .toBe(5);
  const removal = await page.evaluate(
    () => window.emojiFixture.report.publications[4].event,
  );
  expect(removal.kind).toBe(5);
  expect(removal.tags).toContainEqual(["e", event.id]);
  await expect(
    root.getByRole("button", {
      name: ":party:: You",
      exact: true,
    }),
  ).toHaveCount(0);
  // Joining an old custom-emoji group retains its event-local URL, not the new palette URL.
  await root
    .getByRole("button", { name: ":party:: Fixture Member", exact: true })
    .click();
  await expect(
    root.getByRole("button", {
      name: ":party:: 2 people",
      exact: true,
    }),
  ).toBeVisible();
  const joined = await page.evaluate(
    () => window.emojiFixture.report.publications.at(-1).event,
  );
  expect(joined.tags).toContainEqual([
    "emoji",
    "party",
    "https://a.test/media/reaction.png",
  ]);
  // The pointer is still on the pill, so its reactor preview opens and would
  // sit over the row; leave the row before measuring the hovered actions.
  await page.mouse.move(0, 0);
  await expect(
    page.locator('.buzz-preview-card[role="tooltip"][data-open]'),
  ).toHaveCount(0);
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await hoverMessage(root);
    const box = await root
      .getByRole("group", { name: "Message actions", includeHidden: true })
      .boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
  }
  // Empty reaction rows must not change ordinary message spacing; failed first
  // reactions must still expose recovery in the same mounted row.
  const emptyRow = page
    .locator("[data-message-id]")
    .filter({ hasText: "Broken" });
  const reactionRow = emptyRow.locator('[class*="_reactions_"]');
  await expect(reactionRow).toHaveCSS("margin-top", "0px");
  await hoverMessage(emptyRow);
  const chosen = "👍";
  const chooseReaction = async () => {
    await emptyRow
      .getByRole("button", { name: "Add reaction", exact: true })
      .click();
    await page.locator('em-emoji-picker input[type="search"]').fill("thumbsup");
    await page
      .locator("em-emoji-picker")
      .getByRole("button", { name: chosen, exact: true })
      .click();
  };
  await page.evaluate(() => window.emojiFixture.rejectReaction());
  await chooseReaction();
  const firstRetry = emptyRow.getByRole("button", { name: "Retry reaction" });
  await expect(firstRetry).toBeVisible();
  await expect(emptyRow.getByRole("status")).toHaveCSS("overflow", "visible");
  await firstRetry.click();
  const sole = emptyRow.getByRole("button", {
    name: `${chosen}: You`,
    exact: true,
  });
  await expect(sole).toBeEnabled();
  await sole.focus();
  await page.evaluate(() => window.emojiFixture.rejectReaction());
  await sole.press("Enter");
  const stableAction = emptyRow.getByRole("button", {
    name: "More message actions",
  });
  await expect(stableAction).toBeFocused();
  await expect(firstRetry).toBeVisible();
  await expect(sole).toBeVisible();
  await expect(stableAction).toBeFocused();
  await firstRetry.click();
  await expect(sole).toHaveCount(0);
  await expect(reactionRow).toHaveCSS("margin-top", "0px");
  // Repeat the keyboard path on successful removal as well as rollback.
  await hoverMessage(emptyRow);
  await chooseReaction();
  await expect(sole).toBeEnabled();
  await sole.focus();
  await sole.press("Enter");
  await expect(sole).toHaveCount(0);
  await expect(stableAction).toBeFocused();
  expect(errors.unexplained()).toEqual([]);
});

// Browser-only: top-layer preview hit-testing can obstruct the pointer retry.
test("keyboard removal keeps pointer retry reachable after a rejected deletion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 520, height: 950 });
  await page.goto("/tests/fixtures/emoji.html?reactions&single-reaction");
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "2"),
  );
  const row = page.locator("[data-message-id]").first();
  const pill = row.locator('button[data-reaction="👍"]');
  await pill.click();
  await expect(pill).toHaveAttribute("aria-pressed", "true");
  await expect(pill).toHaveAttribute("aria-disabled", "false");
  await page.mouse.move(0, 0);
  await pill.press("Tab");
  // Re-enter using native keyboard navigation, the behavior this journey covers.
  await page.keyboard.press("Shift+Tab");
  await expect(pill).toBeFocused();
  const preview = page.locator('.buzz-preview-card[role="tooltip"][data-open]');
  await expect(preview).toBeVisible();
  await page.evaluate(() => window.emojiFixture.rejectReaction());
  await pill.press("Space");
  const retry = row.getByRole("button", { name: "Retry reaction" });
  await expect(retry).toBeVisible();
  await expect(pill).toBeFocused();
  await expect(pill).toHaveAttribute("aria-pressed", "true");
  await expect(preview).toHaveCount(0);
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect(pill).toHaveAttribute("aria-pressed", "false");
  await expect(pill).toHaveAttribute("aria-disabled", "false");
  // Deliberate pointer re-entry still reveals who reacted after recovery.
  await page.mouse.move(0, 0);
  await pill.hover();
  await expect(preview).toBeVisible();
});

test("one active reaction picker preserves target and focus when switching or unmounting", async ({
  page,
}) => {
  await page.route("**/emoji-media/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"/>',
    }),
  );
  await page.goto("/tests/fixtures/emoji.html?reactions");
  const rows = page.locator("[data-message-id]");
  // Open the lower row first so its popup does not cover the next trigger.
  const firstRow = rows.nth(1);
  const secondRow = rows.nth(0);
  const first = firstRow
    .getByRole("group", { name: "Message actions", includeHidden: true })
    .getByRole("button", {
      name: "Add reaction",
      exact: true,
      includeHidden: true,
    });
  const second = secondRow
    .getByRole("group", { name: "Message actions", includeHidden: true })
    .getByRole("button", {
      name: "Add reaction",
      exact: true,
      includeHidden: true,
    });
  const search = page.locator('em-emoji-picker input[type="search"]');
  await hoverMessage(firstRow);
  await first.click();
  await expect(search).toBeVisible();
  // Other message toolbars yield until the current picker is dismissed.
  await hoverMessage(secondRow);
  await expect(second).toBeHidden();
  await search.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(first).toBeFocused();
  await hoverMessage(secondRow);
  await second.click();
  await expect(search).toHaveCount(1);
  await expect(search).toBeVisible();
  await expect(first).toHaveAttribute("aria-expanded", "false");
  await expect(second).toHaveAttribute("aria-expanded", "true");
  await search.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(second).toBeFocused();
  await expect(second).toHaveAttribute("aria-expanded", "false");
  await first.focus();
  await first.press("Enter");
  await expect(search).toBeVisible();
  // The other toolbar may close entirely rather than remain an invisible
  // popup anchor. Both states must neither paint nor intercept the pointer.
  await expectMessageActionsHidden(
    secondRow.getByRole("group", {
      name: "Message actions",
      includeHidden: true,
    }),
  );
  await search.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(first).toBeFocused();
  await second.focus();
  await second.press("Enter");
  await expect(search).toHaveCount(1);
  await expect(search).toBeVisible();
  await search.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(second).toBeFocused();
  await expect(second).toHaveAttribute("aria-expanded", "false");
  await second.press("Enter");
  await expect(search).toBeVisible();
  await page.evaluate(() => window.emojiFixture.remount());
  await expect(search).toHaveCount(0);
  await hoverMessage(firstRow);
  await first.click();
  await expect(search).toBeVisible();
  await page.evaluate(() => window.emojiFixture.archive(true));
  await expect(search).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add reaction", exact: true }),
  ).toHaveCount(0);
});

// Browser-only: the documented gallery owns a separate root/iframe, so app-level
// provider coverage cannot prove that its portaled clipboard feedback is wired.
test("standalone message gallery hosts clipboard success and failure toasts", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.addInitScript(() => {
    let attempts = 0;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          if (++attempts === 1) throw new Error("Clipboard unavailable");
        },
      },
    });
  });
  await page.goto("/tests/fixtures/message-gallery.html");
  const row = page
    .getByRole("region", { name: "Plain text", exact: true })
    .locator('[data-message-id="text"]');
  const notifications = page.getByRole("region", {
    name: "App notifications",
  });
  const copy = async () => {
    await hoverMessage(row);
    await row
      .getByRole("button", { name: "More message actions", exact: true })
      .click();
    // This test covers toast hosting, not pointer hit-testing. A pointer click
    // can race the popup's first placement, and Playwright's scroll retries
    // then move the page under the open menu. The keyboard path avoids both.
    await page
      .getByRole("menuitem", { name: "Copy message", exact: true })
      .press("Enter");
  };
  await copy();
  await expect(
    notifications.getByText("Couldn’t copy. Try again from the message menu.", {
      exact: true,
    }),
  ).toBeVisible();
  await copy();
  await expect(
    notifications.getByText("Message copied", { exact: true }),
  ).toBeVisible();
  await expect(row).toBeVisible();
  expect(errors.unexplained()).toEqual([]);
});
