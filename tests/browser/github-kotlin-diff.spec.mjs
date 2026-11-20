import { test, expect } from "./playwright-test.mjs";
import { previewFixtures } from "./vite-server.mjs";
import { watchPageErrors } from "./page-errors.mjs";

let fixtures;
test.beforeAll(async () => {
  fixtures = await previewFixtures(["tests/fixtures/github-kotlin-diff.html"]);
});
test.afterAll(() => fixtures?.close());

test("GitHub PR files route Kotlin syntax into the shared diff renderer", async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  await page.goto(`${fixtures.origin}/tests/fixtures/github-kotlin-diff.html`);
  const changes = page.getByRole("complementary", { name: "GitHub changes" });
  await expect(
    changes.getByRole("region", { name: "src/FeedPresenter.kt", exact: true }),
  ).toBeVisible();
  const rendered = changes.locator("diffs-container pre");
  await expect(rendered).toContainText("when");
  await expect(rendered).toContainText('"Hello"');
  await expect(rendered.locator("span[style]").first()).toBeVisible();
  await expect(rendered.locator('[data-line="5100"]').first()).toContainText(
    "package example.feed",
  );
  await expect(changes.getByRole("region", { name: "Raw diff" })).toHaveCount(
    0,
  );
  expect(await page.evaluate(() => window.diffCalls)).toEqual([
    { repository: "example-org/sample", base: "base", head: "head" },
  ]);
  expect(errors.unexplained()).toEqual([]);
  const file = changes.getByRole("region", {
    name: "src/FeedPresenter.kt",
    exact: true,
  });
  await file.screenshot({
    path: testInfo.outputPath("github-kotlin-rich-light.png"),
  });
  await page.evaluate(() => {
    document.documentElement.dataset.colorMode = "dark";
  });
  await expect(
    file.locator("diffs-container pre span[style]").first(),
  ).toBeVisible();
  await file.screenshot({
    path: testInfo.outputPath("github-kotlin-rich-dark.png"),
  });
});
