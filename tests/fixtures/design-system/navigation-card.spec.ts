import { expect, test } from "../../browser/playwright-test.mjs";

const viewer = "/tests/fixtures/design-system.html";

// Browser coverage is necessary: inherited tokens and :has() paint are not
// resolved by the DOM emulator.
test("collection card selection matches a standalone row in both themes", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/navigation-item`);
  const draft = page.getByRole("button", {
    name: "Selected draft",
    exact: true,
  });
  const sent = page.getByRole("button", {
    name: "Selected sent message",
    exact: true,
  });
  const card = page.locator(".navigation-card").filter({ has: draft });
  for (const theme of ["light", "dark"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
    }, theme);
    await expect(draft).toHaveAttribute("aria-current", "true");
    const selected = await sent.evaluate((row) => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = getComputedStyle(row).getPropertyValue(
        "--interaction-selected",
      );
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });
    await expect(sent).toHaveCSS("background-color", selected);
    expect(selected).not.toBe("rgba(0, 0, 0, 0)");
    await expect(card).toHaveCSS("background-color", selected);
    await draft.hover();
    await expect(card).toHaveCSS("background-color", selected);
    await card.getByRole("button", { name: "Delete selected draft" }).hover();
    await expect(card).toHaveCSS("background-color", selected);
    await page.mouse.move(0, 0);
    await expect(card).toHaveCSS("background-color", selected);
    await draft.focus();
    await page.keyboard.press("Tab");
    await expect(
      card.getByRole("button", { name: "Delete selected draft" }),
    ).toBeFocused();
    await expect(card).toHaveCSS("background-color", selected);
  }
});
