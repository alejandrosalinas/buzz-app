import { test, expect } from "./source-fixture.mjs";

// Native pointer capture, click targeting after release, and scroll geometry
// require real browsers rather than a DOM emulator.
test("avatar strips drag without selecting, then still accept clicks and keyboard", async ({
  page,
}) => {
  for (const editing of [false, true]) {
    await page.setViewportSize({ width: editing ? 390 : 1280, height: 950 });
    await page.goto("/tests/fixtures/agent-library.html?saveFooter");
    await page.evaluate((editing) => {
      document.documentElement.classList.toggle("dark", editing);
      document.documentElement.style.fontSize = editing ? "20px" : "16px";
    }, editing);
    if (editing) {
      await page.getByRole("gridcell", { name: "Ada", exact: true }).click();
      await page.getByRole("button", { name: "Agent profile actions" }).click();
      await page.getByRole("menuitem", { name: "Change avatar" }).click();
    } else {
      await page.getByRole("button", { name: "New agent" }).click();
      await page
        .getByRole("menuitem", { name: "Create a new agent", exact: true })
        .click();
    }
    const dialog = page.getByRole("dialog", {
      name: editing ? "Change avatar" : "Create agent",
      exact: true,
    });
    const dock = dialog.getByRole("group", { name: "Agent avatars" });
    await dock.scrollIntoViewIfNeeded();
    const labels = () =>
      dock
        .getByRole("button")
        .evaluateAll((buttons) =>
          buttons.map((button) => button.getAttribute("aria-label")),
        );
    const initial = await labels();
    const bounds = await dock.boundingBox();
    if (!bounds) throw new Error("Avatar strip is visible");
    const x = bounds.x + bounds.width * 0.7;
    const y = bounds.y + bounds.height - 25;
    await page.mouse.move(x, y);
    await expect(dock).toHaveCSS("cursor", "grab");
    await page.mouse.down();
    await page.mouse.move(x - 100, y, { steps: 5 });
    await expect(dock).toHaveAttribute("data-dragging", "true");
    await expect
      .poll(() => dock.evaluate((node) => node.scrollLeft))
      .toBeGreaterThan(80);
    await expect(dock).toHaveCSS("cursor", "grabbing");
    // Capture continues outside the strip, and releasing there clears it.
    await page.mouse.move(x - 120, bounds.y - 20, { steps: 3 });
    await page.mouse.up();
    await expect(dock).not.toHaveAttribute("data-dragging");
    expect(await labels()).toEqual(initial);

    // Release over an avatar too: it must not activate that choice.
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 80, y, { steps: 5 });
    await page.mouse.up();
    expect(await labels()).toEqual(initial);
    const left = await dock.evaluate((node) => node.scrollLeft);
    await page.mouse.wheel(0, 100);
    await expect
      .poll(() => dock.evaluate((node) => node.scrollLeft))
      .toBeGreaterThan(left);

    const choice = dock.getByRole("button").nth(8);
    await choice.focus();
    await page.keyboard.press("Enter");
    await expect.poll(labels).not.toEqual(initial);
    const afterKeyboard = await labels();
    await choice.click();
    await expect.poll(labels).not.toEqual(afterKeyboard);
    await page.screenshot({
      path: `test-results/avatar-drag-${editing ? "edit" : "create"}.png`,
    });
  }
});

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
