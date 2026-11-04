import { hoverMessage } from "./message-actions.mjs";
import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

// Browser boundary: Inbox plugin routing and portalled message-menu dismissal
// must focus the same native decorated editor and preserve its reply draft.
// Publication/eligibility matrices remain in shared owner tests.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 2, beta: 1 },
  viewport: { width: 1280, height: 720 },
});

test("Inbox edits an owned reply in place and restores the reply draft", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  await openPage(page, "Activity");
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  // The preview can settle on either reply as thread inputs arrive; the
  // conversation's accessible identity is the stable target for this test.
  await inbox
    .getByRole("button", {
      name: "Open Alice Fixture in #Alpha",
      exact: true,
    })
    .click();
  const detail = inbox.getByRole("region", {
    name: "Conversation in Alpha",
    exact: true,
  });
  const reply = detail.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await expect(reply).toBeVisible();
  const root = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 0");
  const own = app.reply(root.id, true);
  const row = detail.locator(`[data-message-id="${own.id}"]`);
  await expect(row).toBeVisible();
  await reply.fill("Unsent Inbox reply");
  const originalNode = await reply.elementHandle();
  const edit = async () => {
    await hoverMessage(row);
    await row.getByRole("button", { name: "More message actions" }).click();
    await page
      .getByRole("menuitem", { name: "Edit message", exact: true })
      .click();
  };
  await edit();
  const editor = detail.getByRole("textbox", {
    name: "Edit message",
    exact: true,
  });
  await expect(editor).toBeFocused();
  await expect(editor).toHaveJSProperty("value", "My reply");
  expect(
    await editor.evaluate(
      (element, original) => element === original,
      originalNode,
    ),
  ).toBe(true);
  await editor.fill("Discard this edit");
  await detail.getByRole("button", { name: "Cancel edit" }).click();
  await expect(reply).toBeFocused();
  await expect(reply).toHaveJSProperty("value", "Unsent Inbox reply");
  await expect(row).toContainText("My reply");
  expect(
    app.report.publications.filter(({ event }) => event.kind === 40003),
  ).toEqual([]);

  await edit();
  await editor.fill("Corrected from Inbox");
  await detail.getByRole("button", { name: "Save changes" }).click();
  await expect(row).toContainText("Corrected from Inbox");
  await expect(reply).toBeFocused();
  await expect(reply).toHaveJSProperty("value", "Unsent Inbox reply");
  await expect
    .poll(
      () =>
        app.report.publications.filter(({ event }) => event.kind === 40003)
          .length,
    )
    .toBe(1);
  const saved = app.report.publications.find(
    ({ event }) => event.kind === 40003,
  ).event;
  expect(saved.content).toBe("Corrected from Inbox");
  expect(saved.tags).toContainEqual(["e", own.id]);

  const peer = detail
    .locator("[data-message-id]")
    .filter({ hasText: "Unread reply 0" });
  await hoverMessage(peer);
  await peer.getByRole("button", { name: "More message actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: /^Mark (read|unread)$/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Edit message", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "Delete message", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Optional review artifact from this exact feature build and disposable data.
  if (process.env.BUZZ_CAPTURE_INBOX_EDIT) {
    await edit();
    await expect(editor).toBeFocused();
    await expect(editor).toHaveJSProperty("value", "Corrected from Inbox");
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("inbox-edit.png") });
  }
});
