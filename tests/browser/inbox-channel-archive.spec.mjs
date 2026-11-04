import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
import { openChannelDetails } from "./channel-details.mjs";

const channel = "11111111-1111-4111-8111-111111111111";
test.use({
  productionBroker: true,
  readState: true,
  channelLifecycle: true,
  inboxThreadWindow: true,
  channelIds: ["alpha", channel],
  historyCounts: { alpha: 1, [channel]: 0 },
});

// Real lifecycle publication, search routing and IndexedDB reload must agree
// with the shared Inbox projection. Live selection permutations stay mounted.
test("excludes a channel-archived conversation across reload without clearing local unread", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Activity");
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  const rows = inbox
    .getByRole("list", { name: "Activity", exact: true })
    .getByRole("listitem");
  await expect(rows).toHaveCount(1);
  await rows.getByRole("button", { name: /^Open / }).click();
  const detail = inbox.getByRole("region", { name: /^Conversation in / });
  await expect(
    detail.locator(`[data-message-id="${app.inboxWindow.root.id}"]`),
  ).toBeVisible();
  await expect(rows.getByRole("img", { name: "Unread" })).toHaveCount(0);
  await rows.getByRole("button", { name: /^Open / }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark unread" }).click();
  await expect(rows.getByRole("img", { name: "Unread" })).toBeVisible();

  // Navigate to ordinary Channels without earning another Inbox read.
  await openPage(page, "Messages");
  await page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "Lifecycle channel", exact: true })
    .click();
  await openChannelDetails(page);
  await page
    .getByRole("button", { name: "Archive channel", exact: true })
    .click();
  await page
    .getByRole("dialog", {
      name: "Archive channel: Lifecycle channel",
      exact: true,
    })
    .getByRole("button", { name: "Archive channel", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", {
      name: "Archive channel: Lifecycle channel",
      exact: true,
    }),
  ).toHaveCount(0);
  await openPage(page, "Activity");
  await expect(
    inbox.getByText("No recent activity in this view", { exact: true }),
  ).toBeVisible();
  await expect(rows).toHaveCount(0);
  await expect(detail).toHaveCount(0);
  await page.reload();
  await openPage(page, "Activity");
  await expect(
    inbox.getByText("No recent activity in this view", { exact: true }),
  ).toBeVisible();
  await expect(rows).toHaveCount(0);

  // Archive is not access loss. Restore through the actual search/settings path.
  await page.getByRole("button", { name: "Search Buzz", exact: true }).click();
  const search = page.getByRole("dialog", { name: "Search Buzz", exact: true });
  await search.getByRole("combobox").fill("Lifecycle channel");
  await search
    .getByRole("option", {
      name: "Lifecycle channel Archived channel · 1 member",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("region", { name: "Archived channel", exact: true }),
  ).toHaveText("This channel is archived");
  await expect(
    page.getByRole("textbox", {
      name: "Message #Lifecycle channel",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.locator(`[data-message-id="${app.inboxWindow.root.id}"]`),
  ).toBeVisible();
  await openChannelDetails(page);
  await page
    .getByRole("button", { name: "Unarchive channel", exact: true })
    .click();
  await page
    .getByRole("dialog", {
      name: "Unarchive channel: Lifecycle channel",
      exact: true,
    })
    .getByRole("button", { name: "Unarchive channel", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", {
      name: "Unarchive channel: Lifecycle channel",
      exact: true,
    }),
  ).toHaveCount(0);
  await openPage(page, "Activity");
  await expect(rows).toHaveCount(1);
  await expect(rows.getByRole("img", { name: "Unread" })).toBeVisible();
  await expect(detail).toHaveCount(0);
  await expect(inbox.getByRole("alert")).toHaveCount(0);
  expect(app.report.lifecyclePublications.map((event) => event.tags)).toEqual([
    [
      ["h", channel],
      ["archived", "true"],
    ],
    [
      ["h", channel],
      ["archived", "false"],
    ],
  ]);
});
