import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

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
  await open(page, app);
  const pages = page.getByRole("navigation", { name: "Pages", exact: true });
  const inboxRow = pages.getByRole("button", { name: "Activity", exact: true });
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
    await page.evaluate(
      ({ mode, fontSize }) => {
        document.documentElement.dataset.colorMode = mode;
        document.documentElement.classList.toggle("dark", mode === "dark");
        document.documentElement.style.fontSize = fontSize;
      },
      { mode, fontSize },
    );
    await inboxRow.hover();
    await expect(
      rows.getByText("Unread reply 1", { exact: true }),
    ).toBeVisible();
    await expect(card.getByText("Checking recent activity…")).toHaveCount(0);
    // Measure after the open transition, which offsets the card while it runs.
    await card.evaluate((element) =>
      Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      ),
    );
    const row = await inboxRow.boundingBox();
    const box = await card.boundingBox();
    // Where there is room the card sits 6px past the row's hover background,
    // with the line under its header at the row's top edge; otherwise the
    // shared popover moves it, never over the row.
    if (width >= 1280) {
      const header = await card.locator("header").boundingBox();
      expect(Math.abs(box.x - (row.x + row.width + 6))).toBeLessThanOrEqual(1);
      expect(
        Math.abs(header.y + header.height - 1 - row.y),
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

  // A row opens its conversation directly and closes the card; Activity stays unselected.
  await rows
    .getByRole("button", { name: /^Open / })
    .filter({ hasText: "Unread reply 1" })
    .click();
  await expect(card).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Thread messages", exact: true }),
  ).toBeVisible();
  await expect(inboxRow).not.toHaveAttribute("aria-current", "page");
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
});
