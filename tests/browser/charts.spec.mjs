import { test, expect } from "./source-fixture.mjs";

const gallery = "/tests/fixtures/message-gallery.html?group=charts";
const strokes = (plot) =>
  plot.evaluate((svg) =>
    [...svg.querySelectorAll("[stroke]")].map((e) => e.getAttribute("stroke")),
  );
const overflows = (node) =>
  node.evaluate((e) => e.scrollWidth > e.clientWidth + 1);

// Real CSS tokens, SVG layout and focus return need a browser; spec validation
// and sanitizing stay in Vitest.
test("charts draw in the series colors of each theme and redraw on change", async ({
  page,
}) => {
  await page.goto(gallery);
  const plot = page.locator('[data-message-id="chart-line"] [role="img"] svg');
  await expect(plot).toBeVisible();
  expect(await strokes(plot)).toEqual(
    expect.arrayContaining(["rgb(5,136,240)", "rgb(239,95,0)"]),
  );
  await page.evaluate(() => {
    document.documentElement.dataset.colorMode = "dark";
  });
  await expect
    .poll(() => strokes(plot))
    .toEqual(expect.arrayContaining(["rgb(0,144,255)", "rgb(163,88,41)"]));
});

test("charts stay inside a narrow column and at 1.5x text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(gallery);
  await page.getByRole("button", { name: "Narrow preview" }).click();
  await page.addStyleTag({ content: "html { font-size: 150%; }" });
  for (const id of ["chart-line", "chart-pie"]) {
    const message = page.locator(`[data-message-id="${id}"]`);
    const figure = message.getByRole("figure");
    await expect(message.locator('[role="img"] svg')).toBeVisible();
    await expect(figure.locator("figcaption")).toBeVisible();
    const box = await figure.boundingBox();
    expect(box.width).toBeLessThanOrEqual(360);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(await overflows(figure), id).toBe(false);
  }
  const rows = page
    .locator('[data-message-id="chart-line"]')
    .getByRole("button", { name: /data rows/ });
  await rows.click();
  const table = page.locator('[data-message-id="chart-line"] table').first();
  await expect(table).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("Expand opens a larger chart in a dialog and returns focus", async ({
  page,
}) => {
  await page.goto(gallery);
  const message = page.locator('[data-message-id="chart-line"]');
  await expect(message.locator('[role="img"] svg')).toBeVisible();
  await message.hover();
  const expand = message.getByRole("button", { name: "Expand chart" });
  await expand.focus();
  await expand.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Chart" });
  await expect(dialog).toHaveAttribute("data-size", "expanded");
  const plot = dialog.locator('[role="img"] svg');
  await expect(plot).toBeVisible();
  await expect(dialog.getByRole("button", { name: /copy/i })).toHaveCount(0);
  const inline = await message.locator('[role="img"]').boundingBox();
  const large = await dialog.locator('[role="img"]').boundingBox();
  expect(large.height).toBeGreaterThan(inline.height);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(expand).toBeFocused();
});

test("an invalid chart shows the error and its source", async ({ page }) => {
  await page.goto(gallery);
  const message = page.locator('[data-message-id="chart-invalid"]');
  await expect(message.getByRole("alert")).toContainText(/bar|line|scatter|x/i);
  await expect(message).toContainText('{"version":1,"type":"bar"}');
  await expect(message.getByRole("figure")).toHaveCount(0);
});

test("with the plugin off the fence stays a plain code block", async ({
  page,
}) => {
  await page.goto(`${gallery}&charts=off`);
  const message = page.locator('[data-message-id="chart-line"]');
  await expect(message).toContainText('"type":"line"');
  await expect(message.locator("pre")).toBeVisible();
  await expect(message.getByRole("figure")).toHaveCount(0);
  await expect(message.locator('[role="img"] svg')).toHaveCount(0);
  await expect(
    message.getByRole("button", { name: "Expand chart" }),
  ).toHaveCount(0);
});
