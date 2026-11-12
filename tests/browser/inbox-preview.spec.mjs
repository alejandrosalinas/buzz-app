import { finalizeEvent, generateSecretKey } from "nostr-tools";
import {
  activityRow,
  openSettings,
  selectSettingsSection,
  chooseColorMode,
  closeSettings,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { animationsSettled } from "./animations.mjs";

// Browser-only contract: a real pointer resting on the sidebar row opens the
// card, which sits just past the row, and its row navigates without opening
// Activity. Shell gating and the card's states stay in RTL tests.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  inboxDm: true,
  historyCounts: { alpha: 2, beta: 1 },
});

test("hovering the sidebar Activity row previews recent conversations and opens one directly", async ({
  page,
  app,
}, testInfo) => {
  const history = app.histories.get("primary/alpha");
  const target = history.find(
    (event) => event.kind === 9 && event.pubkey === app.viewer,
  );
  const reactor = generateSecretKey();
  const reaction = finalizeEvent(
    {
      kind: 7,
      content: "❤️",
      created_at: target.created_at + 100,
      tags: [
        ["h", "alpha"],
        ["e", target.id],
        ["p", app.viewer],
      ],
    },
    reactor,
  );
  history.push(reaction);
  app.relay.publish("primary", reaction, { requireSubscriber: false });
  const solo = finalizeEvent(
    {
      kind: 7,
      content: "👍",
      created_at: reaction.created_at + 1,
      tags: reaction.tags,
    },
    reactor,
  );
  const shared = finalizeEvent(
    {
      kind: 7,
      content: "❤️",
      created_at: reaction.created_at + 2,
      tags: reaction.tags,
    },
    generateSecretKey(),
  );
  history.push(solo, shared);
  app.relay.publish("primary", solo, { requireSubscriber: false });
  app.relay.publish("primary", shared, { requireSubscriber: false });
  await open(page, app);
  const inboxRow = activityRow(page);
  const card = page.getByRole("dialog", { name: "Activity", exact: true });
  const rows = card.getByRole("list", { name: "Recent activity" });
  // Beside the row, inside the window, in both themes, at an intermediate
  // width and with enlarged text.
  for (const [mode, width, fontSize] of [
    ["light", 1280, "16px"],
    ["dark", 1280, "16px"],
    ["dark", 760, "20px"],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await openSettings(page);
    await selectSettingsSection(page, "Appearance");
    await chooseColorMode(page, mode === "dark" ? "Dark" : "Light");
    await closeSettings(page);
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-palette-changing",
    );
    await page.evaluate((fontSize) => {
      document.documentElement.style.fontSize = fontSize;
    }, fontSize);
    await inboxRow.hover();
    await expect(
      rows.getByText("Unread reply 1", { exact: true }),
    ).toBeVisible();
    await expect(card.getByText("Checking recent activity…")).toHaveCount(0);
    const reactionRow = rows.getByRole("button", {
      name: /reacted with heart/,
    });
    await expect(reactionRow).toBeVisible();
    await expect(reactionRow).toContainText(" and ");
    await expect(
      rows.getByRole("button", { name: /reacted with/ }),
    ).toHaveCount(2);
    await expect(
      reactionRow.getByText("in #Alpha", { exact: true }),
    ).toBeVisible();
    const geometry = await reactionRow.evaluate((element) => {
      const preview = element
        .querySelector('[class*="reactionPreview"]')
        .getBoundingClientRect();
      const context = element
        .querySelector('[class*="source"]')
        .getBoundingClientRect();
      const tail = element
        .querySelector('[class*="reactionTail"]')
        .getBoundingClientRect();
      return {
        previewY: preview.y,
        contextY: context.y,
        tailBottom: tail.bottom,
        tailRight: tail.right,
        rowRight: element.getBoundingClientRect().right,
      };
    });
    expect(geometry.previewY).toBeGreaterThanOrEqual(geometry.tailBottom);
    expect(geometry.contextY).toBeGreaterThan(geometry.previewY);
    expect(geometry.tailRight).toBeLessThanOrEqual(geometry.rowRight);
    // Measure after the open transition, which offsets the card while it runs.
    await animationsSettled(card);
    const row = await inboxRow.boundingBox();
    const box = await card.boundingBox();
    // Where there is room the card sits 6px past the row's hover background,
    // with the line under its header at the row's top edge; otherwise the
    // shared popover moves it, never over the row.
    if (width >= 1280) {
      const header = await card.locator("header").boundingBox();
      expect(Math.abs(box.x - (row.x + row.width + 6))).toBeLessThanOrEqual(1);
      // The first sidebar row can be too high for header-line alignment; the
      // card then keeps an 8px gutter below the window header instead.
      const workspaceTop = await page
        .locator(".shell-workspace")
        .evaluate((element) => element.getBoundingClientRect().top);
      const alignedTop = row.y - (header.y - box.y) - header.height + 1;
      expect(
        Math.abs(box.y - Math.max(workspaceTop + 8, alignedTop)),
      ).toBeLessThanOrEqual(1);
    } else
      expect(box.y >= row.y + row.height || box.x >= row.x + row.width).toBe(
        true,
      );
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(900);
    expect(
      await card.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(
        `inbox-preview-${mode}-${width}-${fontSize}.png`,
      ),
    });
    // Leaving the row and card dismisses it.
    await page.mouse.move(width - 20, 880);
    await expect(card).toHaveCount(0);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => {
    document.documentElement.dataset.colorMode = "light";
    document.documentElement.classList.remove("dark");
    document.documentElement.style.fontSize = "";
  });

  // Unread only belongs to the card; the Activity page keeps its own filters.
  await inboxRow.hover();
  const unreadOnly = card.getByRole("switch", { name: "Unread only" });
  await unreadOnly.click();
  await expect(unreadOnly).toBeChecked();
  await expect(rows.getByRole("button", { name: /reacted with/ })).toHaveCount(
    0,
  );
  await unreadOnly.click();
  await rows.getByRole("button", { name: /reacted with heart/ }).click();
  await expect(card).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "Thread messages", exact: true })
      .locator(`[data-message-id="${target.id}"]`),
  ).toBeVisible();
  await expect(inboxRow).not.toHaveAttribute("aria-current", "page");
  await inboxRow.hover();
  await unreadOnly.check();

  // A row opens its conversation directly and closes the card; Activity stays unselected.
  await rows
    .getByRole("button", { name: /^Open / })
    .filter({ hasText: "Unread reply 1" })
    .click();
  await expect(card).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Thread messages", exact: true }),
  ).toBeVisible();
  await expect(inboxRow).not.toHaveAttribute("aria-current");
  await expect(
    page.getByRole("region", { name: "Activity", exact: true }),
  ).toHaveCount(0);

  // While Activity is the open page, its row offers no preview.
  await inboxRow.click();
  await expect(inboxRow).toHaveAttribute("aria-current", "page");
  await expect(inboxRow).not.toHaveAttribute("aria-haspopup");
  await expect(
    page
      .getByRole("region", { name: "Activity", exact: true })
      .getByRole("switch", { name: "Unread", exact: true }),
  ).not.toBeChecked();
  // The selected row's label is visible, so hovering it shows only the
  // ordinary title hint, never the card.
  await page.mouse.move(1200, 880);
  await inboxRow.hover();
  await expect(inboxRow).toHaveAttribute("title", "Activity");
  await expect(card).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("selected-inbox-row.png"),
  });
});
