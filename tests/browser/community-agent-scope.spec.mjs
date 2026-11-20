import { test, expect } from "./source-fixture.mjs";

// Real Select popup/focus and provider forms in the shared settings host,
// including save/reload. Runtime identity and isolation belong in Vitest.
for (const provider of ["claude", "codex"]) {
  test(`${provider} saves community scope from its agent settings`, async ({
    page,
  }) => {
    await page.goto(
      `/tests/fixtures/agent-library.html?settingsSync=${provider}`,
      { waitUntil: "domcontentloaded" },
    );
    await page.getByRole("gridcell", { name: "Ada", exact: true }).click();
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    const scope = page.getByRole("combobox", {
      name: "Session scope",
      exact: true,
    });
    await expect(scope).toBeVisible();
    await scope.focus();
    await scope.press("Enter");
    const option = page.getByRole("option", {
      name: "One session per community",
      exact: true,
    });
    await expect(option).toBeVisible();
    await option.click();
    await expect(scope).toContainText("One session per community");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Save", exact: true }),
    ).toHaveCount(0);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("gridcell", { name: "Ada", exact: true }).click();
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await expect(scope).toContainText("One session per community");
    await page.setViewportSize({ width: 390, height: 950 });
    await page.evaluate(() => {
      document.documentElement.classList.add("dark");
      document.documentElement.style.fontSize = "20px";
    });
    await scope.focus();
    await scope.press("Enter");
    await expect(
      page.getByRole("option", {
        name: "One session per community",
        exact: true,
      }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(scope).toBeFocused();
  });
}
