import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { openPage } from "./navigation.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  inboxDm: true,
  historyCounts: { alpha: 2, beta: 1 },
});

// Browser-only: the bundled page hosts the shared tab workspace. Its list stays
// the main tab while one side tab follows the rows the reader opens.
test("Inbox rows open their conversation in one side tab beside the list", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, app);
  await openPage(page, "Activity");
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  const main = inbox.getByRole("tablist", { name: "Activity tabs" });
  const side = inbox.getByRole("tablist", { name: "Panel tabs" });
  const list = inbox.getByRole("list", { name: "Activity", exact: true });
  const rows = list.getByRole("listitem");
  const expectList = async () => {
    await expect(main.getByRole("tab")).toHaveText(["Activity"]);
    await expect(
      main.getByRole("tab", { name: "Activity", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(list).toBeVisible();
    await expect(rows).toHaveCount(3);
  };
  await expectList();
  await expect(side).toHaveCount(0);
  const alpha = inbox.getByRole("region", {
    name: "Conversation in Alpha",
    exact: true,
  });
  const thread = alpha.getByRole("region", {
    name: "Thread messages",
    exact: true,
  });
  const reply = alpha.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  const roots = app.histories.get("primary/alpha");
  const root = (content) => roots.find((event) => event.content === content);

  await rows
    .filter({ hasText: "Unread reply 1" })
    .getByRole("button", { name: /^Open / })
    .click();
  await expect(side.getByRole("tab")).toHaveText(["Thread root 1"]);
  await expect(
    side.getByRole("tab", { name: "Thread root 1", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    thread.locator(`[data-message-id="${root("Thread root 1").id}"]`),
  ).toBeVisible();
  await expect(
    thread.locator("[data-message-id]").filter({ hasText: "Unread reply 1" }),
  ).toBeInViewport();
  await expect(reply).toBeVisible();
  await expectList();
  // A tab does not visit the channel; the Inbox page stays in view.
  await expect(page.getByRole("region", { name: "Channels" })).toHaveCount(0);

  await reply.fill("Thread root 1 draft");
  // Thread root 0's row shows whichever of its replies loaded as newest.
  const other = rows
    .filter({ hasText: "#Alpha" })
    .filter({ hasNotText: "Unread reply 1" });
  const shown = (await other.textContent()).includes("Broadcast reply")
    ? "Broadcast reply"
    : "Unread reply 0";
  await other.getByRole("button", { name: /^Open / }).click();
  // A plain open replaces the previous tab, so one tab follows the clicks.
  await expect(side.getByRole("tab")).toHaveText(["Thread root 0"]);
  await expect(
    thread.locator(`[data-message-id="${root("Thread root 0").id}"]`),
  ).toBeVisible();
  await expect(
    thread.locator("[data-message-id]").filter({ hasText: shown }),
  ).toBeInViewport();
  await expect(thread.getByText("Unread reply 1", { exact: true })).toHaveCount(
    0,
  );
  await expect(reply).toBeVisible();
  await expect(reply).not.toHaveText("Thread root 1 draft");
  await expectList();

  await rows
    .filter({ hasText: "Inbox DM fixture reply" })
    .getByRole("button", { name: /^Open / })
    .click();
  // A DM opens its whole conversation, not a thread.
  await expect(side.getByRole("tab")).toHaveText(["Alice Fixture"]);
  const dm = inbox.getByRole("region", {
    name: "Conversation in Alice Fixture",
    exact: true,
  });
  await expect(alpha).toHaveCount(0);
  await expect(
    dm
      .getByRole("region", { name: "Channel message history" })
      .getByText("Inbox DM fixture reply", { exact: true }),
  ).toBeVisible();
  await expect(dm.getByRole("complementary", { name: "Thread" })).toHaveCount(
    0,
  );
  await expect(dm.getByRole("textbox", { name: /^Message / })).toBeVisible();
  await expectList();

  // Reopening the first thread restores its retained draft in a fresh tab.
  await rows
    .filter({ hasText: "Unread reply 1" })
    .getByRole("button", { name: /^Open / })
    .click();
  await expect(side.getByRole("tab")).toHaveText(["Thread root 1"]);
  await expect(reply).toHaveText("Thread root 1 draft");
});

// Browser-only: the tab's menu takes its conversation to Channels, as the
// former Inbox detail pane's Open in channel did.
test("an Inbox tab's menu opens its thread in its channel", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, app);
  await openPage(page, "Activity");
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  const root = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 1");
  await inbox
    .getByRole("list", { name: "Activity", exact: true })
    .getByRole("listitem")
    .filter({ hasText: "Unread reply 1" })
    .getByRole("button", { name: /^Open / })
    .click();
  await inbox
    .getByRole("tablist", { name: "Panel tabs" })
    .getByRole("tab", { name: "Thread root 1", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open in channel" }).click();
  await expect(inbox).toHaveCount(0);
  const target = await page.evaluate(
    () => history.state.buzzNavigationV1.entry.target,
  );
  expect(target.threadRootId).toBe(root.id);
  expect(target.messageId).toMatch(/^[a-f0-9]{64}$/);
  await expect(
    page
      .getByRole("region", { name: "Thread messages", exact: true })
      .getByText("Unread reply 1", { exact: true }),
  ).toBeVisible();
});
