import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import {
  openSettings,
  closeSettings,
  selectSettingsSection,
} from "./navigation.mjs";
import { hoverMessage } from "./message-actions.mjs";

test.use({ productionBroker: true, historyCounts: { alpha: 1, beta: 1 } });

// Browser boundary: persisted Settings -> real composer/timeline focus and
// native multiline caret navigation in channel and thread composers.
test("Up Arrow editing follows the saved preference in channels and threads", async ({
  page,
  app,
}) => {
  await open(page, app);
  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await input.fill("Channel shortcut message");
  await input.press("Enter");
  const row = page
    .locator("[data-channel-timeline] [data-message-id]")
    .filter({ hasText: "Channel shortcut message" });
  await expect(row).toBeVisible();
  await expect(input).toHaveJSProperty("value", "");
  // Optimistic rows render before delivery makes them eligible for editing.
  await hoverMessage(row);
  await expect(
    row.getByRole("button", { name: "Reply", exact: true }),
  ).toBeEnabled();
  await input.press("ArrowUp");
  await expect(input).not.toBeFocused();
  await expect(
    page.getByRole("textbox", { name: "Edit message", exact: true }),
  ).toHaveCount(0);
  await input.press("Meta+ArrowUp");
  const editor = page.getByRole("textbox", {
    name: "Edit message",
    exact: true,
  });
  await expect(editor).toHaveJSProperty("value", "Channel shortcut message");
  await editor.press("Escape");

  await openSettings(page);
  await selectSettingsSection(page, "Shortcuts");
  const toggle = page.getByRole("switch", {
    name: "Edit last message with Up Arrow",
  });
  await expect(toggle).not.toBeChecked();
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toBeChecked();
  await closeSettings(page);
  await input.press("ArrowUp");
  await expect(editor).toBeFocused();
  await expect(editor).toHaveJSProperty("value", "Channel shortcut message");
  await editor.press("Escape");

  await page.reload();
  await expect(input).toBeVisible();
  await openSettings(page);
  await selectSettingsSection(page, "Shortcuts");
  await expect(toggle).toBeChecked();
  await closeSettings(page);
  await input.fill("first line\nsecond line");
  await input.evaluate((element) =>
    element.setSelectionRange(element.value.length, element.value.length),
  );
  await input.press("ArrowUp");
  await expect(input).toBeFocused();
  await expect(input).toHaveJSProperty("value", "first line\nsecond line");
  await expect
    .poll(() => input.evaluate((element) => element.selectionStart))
    .toBeLessThan(11);
  await input.fill("");

  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const reply = panel.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await reply.fill("Thread shortcut reply");
  await reply.press("Enter");
  await expect(
    panel.getByText("Thread shortcut reply", { exact: true }),
  ).toBeVisible();
  await expect(reply).toHaveJSProperty("value", "");
  const replyRow = panel.locator("[data-message-id]").filter({
    hasText: "Thread shortcut reply",
  });
  await hoverMessage(replyRow);
  await expect(
    replyRow.getByRole("button", { name: "Reply", exact: true }),
  ).toBeEnabled();
  await reply.press("ArrowUp");
  const threadEditor = panel.getByRole("textbox", {
    name: "Edit message",
    exact: true,
  });
  await expect(threadEditor).toBeFocused();
  await expect(threadEditor).toHaveJSProperty("value", "Thread shortcut reply");
  await threadEditor.press("Escape");
  await reply.press("Meta+ArrowUp");
  await expect(threadEditor).toHaveJSProperty("value", "Thread shortcut reply");
  await threadEditor.press("Escape");

  await openSettings(page);
  await selectSettingsSection(page, "Shortcuts");
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await closeSettings(page);
  await reply.press("ArrowUp");
  await expect(reply).not.toBeFocused();
  await expect(threadEditor).toHaveCount(0);
});
