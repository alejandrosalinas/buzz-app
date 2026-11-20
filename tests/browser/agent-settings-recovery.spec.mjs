import { test, expect } from "./playwright-test.mjs";
import { previewFixtures } from "./vite-server.mjs";

let fixtures;
test.beforeAll(async () => {
  fixtures = await previewFixtures(["tests/fixtures/agent-library.html"]);
});
test.afterAll(() => fixtures?.close());

test("reverts incompatible agent settings from Previous Versions", async ({
  page,
}) => {
  await page.goto(
    `${fixtures.origin}/tests/fixtures/agent-library.html?settingsRecovery`,
    { waitUntil: "domcontentloaded" },
  );
  await page.getByRole("gridcell", { name: "Ada", exact: true }).click();
  const history = page
    .getByRole("alert")
    .getByRole("button", { name: "Previous Versions" });
  await expect(page.getByRole("alert")).toContainText(
    "Use a Buzz version that supports them, or open Previous Versions to look for a compatible revision.",
  );
  await history.focus();
  await history.press("Enter");
  await expect(
    page.getByRole("tab", { name: "Settings", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("button", { name: "Previous versions", exact: true }),
  ).toBeFocused();
  const versions = page.getByRole("list", { name: "Previous versions" });
  const incompatible = versions.getByRole("button", { name: /Incompatible/ });
  await expect(incompatible).toBeVisible();
  const compatible = versions.getByRole("button").filter({
    hasNotText: "Incompatible",
  });
  await expect(compatible).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("fixture-recovery-head")),
    )
    .toBeNull();

  await page.setViewportSize({ width: 390, height: 950 });
  await page.evaluate(() => {
    document.documentElement.classList.add("dark");
    document.documentElement.style.fontSize = "20px";
  });
  await compatible.click();
  const revert = page.getByRole("button", { name: "Revert to this" });
  await expect(revert).toBeVisible();
  await revert.click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const saved = localStorage.getItem("fixture-recovery-head");
        return saved && JSON.parse(JSON.parse(saved).content).settings;
      }),
    )
    .toEqual({ scope: "channel", model: "older-model", effort: "high" });

  await expect(history).toHaveCount(0);
  // Successful recovery remounts the now-available split settings editor.
  // Its history still contains the incompatible revision.
  const disclosure = page.getByRole("button", {
    name: "Previous versions",
    exact: true,
  });
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await disclosure.click();
  await expect(incompatible).toBeVisible();

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("gridcell", { name: "Ada", exact: true }).click();
  await expect(history).toHaveCount(0);
  await expect(
    page.getByText(/These agent settings aren't compatible/),
  ).toHaveCount(0);
});
