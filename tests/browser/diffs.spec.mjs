import { test, expect } from "./playwright-test.mjs";
import { previewFixtures } from "./vite-server.mjs";
import { watchPageErrors } from "./page-errors.mjs";

let fixtures;
// A dev server serves this page as about 1,800 modules, and each test started
// its own cold server, so the navigation outlasted its timeout on a busy runner.
test.beforeAll(async () => {
  fixtures = await previewFixtures(["tests/fixtures/diffs.html"]);
});
test.afterAll(() => fixtures?.close());

// Real table geometry/scroll containment, modal portal/focus return and theme
// rendering need a browser. Patch matrices and plugin failures stay in Vitest.
test("diff preview expands in both layouts and keeps focus and scroll containment", async ({
  page,
  browserName,
}) => {
  // Safari on macOS uses Option+Tab to include links in keyboard traversal.
  const tab =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab";
  const errors = watchPageErrors(page);
  await page.goto(`${fixtures.origin}/tests/fixtures/diffs.html`);
  const expand = page.getByRole("button", {
    name: "Expand diff",
    exact: true,
  });
  await expect(expand).toHaveCount(1);
  await expect(page.locator("table.diff-unified")).toBeVisible();
  await expand.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("table.diff-unified")).toBeVisible();
  const unified = dialog.getByRole("button", {
    name: "Unified",
    exact: true,
  });
  const split = dialog.getByRole("button", { name: "Split", exact: true });
  await expect(unified).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.locator("tr").first().locator("td")).toHaveCount(3);
  await split.click();
  await expect(split).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.locator("tr").first().locator("td")).toHaveCount(4);
  const cells = await dialog
    .locator("tr")
    .first()
    .locator("td")
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().x));
  expect(cells[3]).toBeGreaterThan(cells[1]);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(expand).toBeFocused();
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expand.click();
  await split.click();
  await expect(dialog).toHaveAttribute("data-size", "expanded");
  await expect
    .poll(() => dialog.evaluate((e) => e.scrollWidth <= e.clientWidth))
    .toBe(true);
  const file = dialog.locator("section");
  await expect
    .poll(() => file.evaluate((e) => e.scrollWidth > e.clientWidth))
    .toBe(true);
  await page.keyboard.press(tab);
  await expect(file).toBeFocused();
  await expect(file).toHaveCSS("outline-style", "solid");
  // WebKit starts native scrolling while the key is held. Releasing in the
  // same tick can cancel it before the first frame, unlike a human keypress.
  await page.keyboard.down("ArrowRight");
  try {
    await expect
      .poll(() => file.evaluate((e) => e.scrollLeft))
      .toBeGreaterThan(0);
  } finally {
    await page.keyboard.up("ArrowRight");
  }
  await dialog.getByRole("button", { name: "Close diff" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(expand).toBeFocused();
  // The inline preview owns vertical overflow separately from file panning.
  await page.getByRole("button", { name: "Receive long diff" }).click();
  const longCard = page
    .getByRole("region", { name: "Diff: src/greeting.ts", exact: true })
    .last();
  const longExpand = longCard.getByRole("button", { name: "Expand diff" });
  await longExpand.click();
  await page.keyboard.press("Escape");
  await expect(longExpand).toBeFocused();
  await page.keyboard.press(tab);
  const preview = longCard.getByRole("region", {
    name: "Diff preview: src/greeting.ts",
  });
  await expect(preview).toBeFocused();
  await page.keyboard.down("PageDown");
  try {
    await expect
      .poll(() => preview.evaluate((e) => e.scrollTop))
      .toBeGreaterThan(0);
  } finally {
    await page.keyboard.up("PageDown");
  }

  await page.getByRole("button", { name: "Receive malformed diff" }).click();
  const rawCard = page
    .getByRole("region", { name: "Diff: src/greeting.ts", exact: true })
    .last();
  const rawExpand = rawCard.getByRole("button", { name: "Expand diff" });
  await rawExpand.click();
  await dialog.getByRole("button", { name: "Split", exact: true }).click();
  await page.keyboard.press(tab);
  await expect(
    dialog.getByRole("link", {
      name: "View full diff at the source repository",
    }),
  ).toBeFocused();
  await page.keyboard.press(tab);
  const raw = dialog.getByRole("region", { name: "Raw diff" });
  await expect(raw).toBeFocused();
  await page.keyboard.down("ArrowRight");
  try {
    await expect
      .poll(() => raw.evaluate((e) => e.scrollLeft))
      .toBeGreaterThan(0);
  } finally {
    await page.keyboard.up("ArrowRight");
  }
  await page.keyboard.press("Escape");
  await expect(rawExpand).toBeFocused();
  await page.keyboard.press(tab);
  await page.keyboard.press(tab);
  const inlineRaw = rawCard.getByRole("region", { name: "Raw diff" });
  await expect(inlineRaw).toBeFocused();
  await page.keyboard.down("ArrowRight");
  try {
    await expect
      .poll(() => inlineRaw.evaluate((e) => e.scrollLeft))
      .toBeGreaterThan(0);
  } finally {
    await page.keyboard.up("ArrowRight");
  }
  await page.getByRole("button", { name: "Disable diff plugin" }).click();
  await expect(expand).toHaveCount(0);
  const hostRaw = page.getByRole("region", { name: "Raw diff" }).first();
  const hostRow = page
    .locator("[data-message-id]")
    .filter({ has: page.getByRole("region", { name: "Raw diff" }) })
    .first();
  await hostRow.getByRole("button", { name: "More message actions" }).focus();
  await page.keyboard.press(tab);
  await expect(hostRaw).toBeFocused();
  await expect(hostRaw).toHaveCSS("outline-style", "solid");
  await page.keyboard.down("ArrowRight");
  try {
    await expect
      .poll(() => hostRaw.evaluate((e) => e.scrollLeft))
      .toBeGreaterThan(0);
  } finally {
    await page.keyboard.up("ArrowRight");
  }
  expect(errors.unexplained()).toEqual([]);
});
