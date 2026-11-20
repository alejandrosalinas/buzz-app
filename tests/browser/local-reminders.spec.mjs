import { fileURLToPath } from "node:url";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { activityRow } from "./navigation.mjs";
import { readJournal } from "./reading.mjs";

// Device-local reminders set while their conversation is on screen stay until
// that visit ends, across the pauses a menu or a layout imposes.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  pluginFixtures: true, // The session handle sets a durable `msg:` reminder.
  historyCounts: { alpha: 2, beta: 1 },
});

test("a message marked unread while shown survives opening and dismissing its menu", async ({
  page,
  app,
}) => {
  await open(page, app);
  const event = app.append("primary", "alpha", "Marked while shown");
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  await expect(row).toBeVisible();
  await page.getByRole("region", { name: "Channel message history" }).focus();
  await expect
    .poll(async () => (await readJournal(page))?.state.frontiers.alpha ?? 0)
    .toBeGreaterThanOrEqual(event.created_at);
  // The message menu's Mark as unread is a per-visit overlay; this is the
  // durable local reminder.
  await page.clock.install({ time: Date.now() });
  await page.evaluate(
    (messageId) =>
      window.fixtureRelay.snapshot().session.unread.markUnreadLocal({
        kind: "message",
        channelId: "alpha",
        messageId,
      }),
    event.id,
  );
  const key = `msg:${event.id}`;
  expect((await readJournal(page))?.localUnread[key]).toBeDefined();
  // A modal context menu isolates the page from assistive technology;
  // dismissing it resumes the same visit, whose shown rows cannot clear the
  // mark.
  const menu = page.getByRole("menu");
  await row
    .getByText(event.content, { exact: true })
    .click({ button: "right" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await page.getByRole("region", { name: "Channel message history" }).focus();
  await page.clock.runFor(1500);
  expect((await readJournal(page))?.localUnread[key]).toBeDefined();
});

test("a thread marked unread from Inbox while open, with no row fully shown, stays marked for that visit", async ({
  page,
  app,
}) => {
  await open(page, app);
  await activityRow(page).click();
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  const rows = inbox
    .getByRole("list", { name: "Activity", exact: true })
    .getByRole("listitem");
  const row = rows.filter({ hasText: "Unread reply 1" });
  const opener = row.getByRole("button", { name: /^Open / });
  await opener.click();
  const thread = inbox
    .getByRole("region", { name: "Conversation in Alpha", exact: true })
    .getByRole("region", { name: "Thread messages", exact: true });
  await expect(thread.getByText("Unread reply 1")).toBeVisible();
  await expect(row.getByRole("img", { name: "Unread" })).toHaveCount(0);
  await page.clock.install({ time: Date.now() });
  // Every row taller than the pane: none is ever fully shown.
  const style = await page.addStyleTag({
    content: "[data-reading-surface] [data-message-id] { min-height: 4000px; }",
  });
  await opener.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark as unread" }).click();
  const dot = row.getByRole("img", { name: "Unread" });
  await expect(dot).toBeVisible();
  // Reading the open thread for longer than a dwell leaves the mark.
  await thread.focus();
  await page.clock.runFor(1500);
  await thread.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.clock.runFor(1500);
  await expect(dot).toBeVisible();
  await style.evaluate((element) => element.remove());
  await page.clock.runFor(1500);
  await expect(dot).toBeVisible();
  // After another conversation, opening it again reads it.
  await rows
    .filter({ hasText: "Broadcast descendant" })
    .getByRole("button", { name: /^Open / })
    .click();
  await opener.click();
  await expect(dot).toHaveCount(0);
});

test("reminders set while shown survive opening and closing the image viewer", async ({
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
    "Viewed image",
    true,
    true,
    undefined,
    undefined,
    [["imeta", "url https://primary.example/media/photo.png", "m image/png"]],
  );
  const reply = app.append(
    "primary",
    "alpha",
    "Image reply",
    true,
    false,
    event.id,
  );
  // Inbox opens the thread in its main pane, which media review retains.
  await activityRow(page).click();
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  const row = inbox
    .getByRole("list", { name: "Activity", exact: true })
    .getByRole("listitem")
    .filter({ hasText: "Image reply" });
  const opener = row.getByRole("button", { name: /^Open / });
  await opener.click();
  const thread = inbox
    .getByRole("region", { name: "Conversation in Alpha", exact: true })
    .getByRole("region", { name: "Thread messages", exact: true });
  await expect(thread.getByText("Image reply")).toBeVisible();
  await page.clock.install({ time: Date.now() });
  await opener.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark as unread" }).click();
  const dot = row.getByRole("img", { name: "Unread" });
  await expect(dot).toBeVisible();
  await page.evaluate(
    (messageId) =>
      window.fixtureRelay.snapshot().session.unread.markUnreadLocal({
        kind: "message",
        channelId: "alpha",
        messageId,
      }),
    reply.id,
  );
  const key = `msg:${reply.id}`;
  expect((await readJournal(page))?.localUnread[key]).toBeDefined();
  // The viewer isolates the rest of the window while open; closing it
  // returns to the same visit.
  await thread
    .getByRole("link", { name: "Open image attachment", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Image viewer",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await thread.focus();
  await page.clock.runFor(1500);
  expect((await readJournal(page))?.localUnread[key]).toBeDefined();
  await expect(dot).toBeVisible();
});
