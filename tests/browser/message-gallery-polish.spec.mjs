import { test, expect } from "./source-fixture.mjs";

// Real browser computed styles and pointer/focus behavior.
test("layout message presentation", async ({ page }) => {
  await page.goto("/tests/fixtures/message-gallery.html?accent=blue");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.colorMode = theme;
    }, theme);
    for (const id of ["table-links", "code-diff"]) {
      const bubble = page.locator(
        `[data-message-id="${id}"] [data-message-action-anchor]`,
      );
      await expect(bubble).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(bubble).toHaveCSS("padding-top", "0px");
    }
  }
});

// Browser line layout: a capsule that starts a line, whether at a paragraph
// start, after a line break or by wrapping, meets the prose edge.
test("line-start mention capsules align with prose", async ({ page }) => {
  await page.goto("/tests/fixtures/message-gallery.html?group=references");
  await page.getByRole("button", { name: "Narrow preview" }).click();
  const body = page.locator(
    '[data-message-id="wrapped-mentions"] [data-message-action-anchor]',
  );
  for (const density of ["comfortable", "compact"]) {
    await page.evaluate((density) => {
      document.documentElement.dataset.messageDensity = density;
    }, density);
    const offsets = await body.evaluate((bubble) =>
      [...bubble.querySelectorAll("p")].flatMap((paragraph) => {
        const edge = paragraph.getBoundingClientRect().left;
        return [...paragraph.querySelectorAll("[data-mention-kind]")].map(
          (capsule) => capsule.getBoundingClientRect().left - edge,
        );
      }),
    );
    // Mid-line capsules sit well right of the edge; line starts sit near it.
    const starts = offsets.filter((offset) => offset < 16);
    expect(starts.length, density).toBeGreaterThan(3);
    for (const offset of starts)
      expect(Math.abs(offset), density).toBeLessThan(0.5);
  }
});
