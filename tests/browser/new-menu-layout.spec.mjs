import { test, expect } from "./fixture.mjs";
import { openPage, settleShellToggle } from "./navigation.mjs";

// Browser hit testing is required: jsdom cannot detect overflowing filter text.
test("the floating New button remains clickable with enlarged text", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await settleShellToggle(page);
  await page
    .getByRole("button", { name: "Show navigation", exact: true })
    .click();
  const trigger = page.getByRole("button", {
    name: "New options",
    exact: true,
  });
  await expect(trigger).toBeInViewport();
  const selected = page.locator('button[data-channel-id="alpha"]');
  await expect(selected).toHaveAttribute("aria-current", "page");
  await trigger.click();
  await expect(
    page.getByRole("menuitem", { name: "New chat", exact: true }),
  ).toBeVisible();
  await expect(selected).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});
