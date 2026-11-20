import { test, expect } from "./playwright-test.mjs";
import { previewFixtures } from "./vite-server.mjs";
import { watchPageErrors } from "./page-errors.mjs";

let fixtures;
test.beforeAll(async () => {
  fixtures = await previewFixtures(["tests/fixtures/diffs.html"]);
});
test.afterAll(() => fixtures?.close());

// Shadow-DOM rendering, focus return, layout geometry and theme changes need a browser.
test("Kotlin diff renders in diffs, both themes and both layouts", async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  await page.goto(`${fixtures.origin}/tests/fixtures/diffs.html`);
  await page.getByRole("button", { name: "Receive Kotlin diff" }).click();
  const card = page
    .getByRole("region", { name: "Diff: src/Greeting.kt" })
    .last();
  await expect(
    card.locator("diffs-container pre span[style]").first(),
  ).toBeVisible();
  await card.getByRole("button", { name: "Expand diff" }).click();
  const dialog = page.getByRole("dialog");
  const file = dialog.getByRole("region", { name: "src/Greeting.kt" });
  const code = file.locator("diffs-container pre");
  await expect(code).toContainText("fun greet");
  for (const theme of ["light", "dark"]) {
    if (theme === "dark")
      await page.evaluate(() => {
        document.documentElement.dataset.colorMode = "dark";
      });
    for (const layout of ["Unified", "Split"]) {
      const button = dialog.getByRole("button", { name: layout, exact: true });
      await button.click();
      await expect(button).toHaveAttribute("aria-pressed", "true");
      await expect(code.locator("span[style]").first()).toBeVisible();
      await dialog.screenshot({
        path: testInfo.outputPath(
          `pierre-kotlin-${theme}-${layout.toLowerCase()}.png`,
        ),
      });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => dialog.evaluate((el) => el.scrollWidth <= el.clientWidth))
    .toBe(true);
  const column = file.locator("diffs-container code").last();
  await expect
    .poll(() => column.evaluate((el) => el.scrollWidth > el.clientWidth))
    .toBe(true);
  await column.focus();
  await expect(column).toBeFocused();
  await page.keyboard.down("ArrowRight");
  try {
    await expect
      .poll(() => column.evaluate((el) => el.scrollLeft))
      .toBeGreaterThan(0);
  } finally {
    await page.keyboard.up("ArrowRight");
  }
  await dialog.screenshot({
    path: testInfo.outputPath("pierre-kotlin-narrow.png"),
  });
  expect(errors.unexplained()).toEqual([]);
});

test("Shiki initialization failure retains escaped raw diff", async ({
  page,
}) => {
  let blocked = 0;
  await page.route(/\/(?:shiki|engine-javascript)-[^/]+\.js/, (route) => {
    blocked++;
    return route.abort();
  });
  await page.goto(`${fixtures.origin}/tests/fixtures/diffs.html`);
  await expect.poll(() => blocked).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Receive multi-file diff" }).click();
  const card = page
    .getByRole("region", { name: "Diff: src/greeting.ts" })
    .last();
  const raw = card.getByRole("region", { name: "Raw diff" });
  await expect(raw).toHaveCount(1);
  await expect(raw).toContainText("return `Hello");
  await expect(raw).toContainText("src/Second.kt");
  await expect(card.locator("diffs-container")).toHaveCount(0);
});

test("one failed grammar falls back once for an entire multi-file diff", async ({
  page,
}) => {
  let blocked = 0;
  await page.route(/\/kotlin-[^/]+\.js/, (route) => {
    blocked++;
    return route.abort();
  });
  await page.goto(`${fixtures.origin}/tests/fixtures/diffs.html`);
  await page.getByRole("button", { name: "Receive multi-file diff" }).click();
  await expect.poll(() => blocked).toBeGreaterThan(0);
  const card = page
    .getByRole("region", { name: "Diff: src/greeting.ts" })
    .last();
  const raw = card.getByRole("region", { name: "Raw diff" });
  await expect(raw).toHaveCount(1);
  await expect(raw).toContainText("src/Second.kt");
  await expect(card.locator("diffs-container")).toHaveCount(0);
});

test("diff dialog restores focus and malformed or disabled patches stay escaped and readable", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto(`${fixtures.origin}/tests/fixtures/diffs.html`);
  const expand = page.getByRole("button", { name: "Expand diff" });
  await expect(expand).toHaveCount(1);
  await expect(page.locator("diffs-container pre").first()).toBeVisible();
  await expand.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("diffs-container pre")).toBeVisible();
  await dialog.getByRole("button", { name: "Split", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(expand).toBeFocused();
  await page.getByRole("button", { name: "Receive malformed diff" }).click();
  const rawCard = page
    .getByRole("region", { name: "Diff: src/greeting.ts" })
    .last();
  await expect(rawCard.getByRole("region", { name: "Raw diff" })).toContainText(
    "<script>",
  );
  await expect(rawCard.locator("img, script")).toHaveCount(0);
  await rawCard.getByRole("button", { name: "Expand diff" }).click();
  await expect(dialog.getByRole("region", { name: "Raw diff" })).toContainText(
    "<script>",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Disable diff plugin" }).click();
  await expect(page.locator("diffs-container")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Raw diff" }).first(),
  ).toBeVisible();
  expect(errors.unexplained()).toEqual([]);
});
