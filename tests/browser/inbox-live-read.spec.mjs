import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

const windowRoom = "00000000-0000-0000-0000-000000000123";

test.use({
  productionBroker: true,
  readState: true,
  inboxThreadWindow: true,
  channelIds: ["alpha", windowRoom],
  channelNames: { [windowRoom]: "Window room" },
  historyCounts: { alpha: 1, [windowRoom]: 0 },
});

// Opening a row leaves focus on the list; the open conversation beside it is
// still what the reader sees, so a reply that lands in view is read.
test("a live reply in the open Activity conversation is read while focus stays on its row", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Activity");
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  const row = inbox
    .getByRole("list", { name: "Activity", exact: true })
    .getByRole("listitem")
    .filter({ hasText: "Window room" });
  const open = row.getByRole("button", { name: /^Open / });
  await open.click();
  const detail = inbox.getByRole("region", {
    name: "Conversation in Window room",
    exact: true,
  });
  const unread = row.getByRole("img", { name: "Unread" });
  await expect(
    detail.getByRole("textbox", { name: "Reply to thread" }),
  ).toBeVisible();
  await expect(unread).toHaveCount(0);
  const scroller = detail.getByRole("region", {
    name: "Thread messages",
    exact: true,
  });
  // Opening reveals the exact message, which takes focus once it settles;
  // move focus back to the row only after that, so nothing takes it again.
  await expect
    .poll(() =>
      detail.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);
  await open.focus();
  await expect(open).toBeFocused();
  app.reply(app.inboxWindow.root.id);
  await expect(
    detail.getByText("New peer reply", { exact: true }),
  ).toBeVisible();
  await expect(row).toContainText("New peer reply");
  // Reading needs the reply in view, whatever holds focus.
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(open).toBeFocused();
  await expect(unread).toHaveCount(0);
});
