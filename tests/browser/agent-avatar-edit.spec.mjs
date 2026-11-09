import { test, expect } from "./source-fixture.mjs";

// Real layout and popup focus must hold inside the profile's modal at small
// widths and enlarged text; component tests cover draft/save behavior.
test("avatar editing shares the creation picker in responsive dialogs", async ({
  page,
}) => {
  for (const { width, dark, fontSize } of [
    { width: 1280, dark: false, fontSize: "16px" },
    { width: 390, dark: true, fontSize: "20px" },
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await page.goto("/tests/fixtures/agent-library.html?saveFooter");
    await page.evaluate(
      ({ dark, fontSize }) => {
        document.documentElement.classList.toggle("dark", dark);
        document.documentElement.style.fontSize = fontSize;
      },
      { dark, fontSize },
    );
    await page.getByRole("gridcell", { name: "Ada", exact: true }).click();
    const menu = page.getByRole("button", { name: "Agent profile actions" });
    await menu.click();
    await page.getByRole("menuitem", { name: "Change avatar" }).click();
    const dialog = page.getByRole("dialog", {
      name: "Change avatar",
      exact: true,
    });
    const save = dialog.getByRole("button", { name: "Save changes" });
    await expect(save).toBeDisabled();
    await expect(
      dialog.getByRole("group", { name: "Agent avatars" }),
    ).toBeVisible();
    await dialog.getByRole("tab", { name: "Emoji", exact: true }).click();
    await expect(
      dialog.getByRole("group", { name: "Avatar background" }),
    ).toBeVisible();
    await expect(save).toBeEnabled();
    const emoji = dialog.getByRole("button", { name: "Choose emoji" });
    await expect(emoji.locator("[data-avatar-shape]")).toHaveAttribute(
      "data-avatar-shape",
      "squircle",
    );
    await emoji.click();
    await expect(
      page.getByRole("dialog", { name: "Choose emoji", exact: true }),
    ).toBeVisible();
    await expect(page.locator("em-emoji-picker input")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(emoji).toBeFocused();
    await expect(dialog).toBeVisible();
    const bounds = await dialog.evaluate((node) => ({
      left: node.getBoundingClientRect().left,
      right: node.getBoundingClientRect().right,
      client: node.clientWidth,
      scroll: node.scrollWidth,
    }));
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(width);
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.client);
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport();
    await page.screenshot({ path: `test-results/avatar-edit-${width}.png` });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(menu).toBeFocused();
  }
});
