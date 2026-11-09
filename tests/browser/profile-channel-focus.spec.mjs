import { test, expect } from "./source-fixture.mjs";

// Read actual painted pixels at the shared 2px outline (2px outward offset).
// CSS declarations alone cannot tell us whether the list clips the ring.
async function expectPaintedRing(page, list, row) {
  await expect(row).toBeFocused();
  await expect(row).toHaveCSS("outline-width", "2px");
  expect(
    await row.evaluate((element) => element.matches(":focus-visible")),
  ).toBe(true);
  const listBounds = await list.boundingBox();
  // Navigation rows paint their focus ring outside the unbordered list.
  const bounds = {
    x: listBounds.x - 4,
    y: listBounds.y - 4,
    width: listBounds.width + 8,
    height: listBounds.height + 8,
  };
  const image = await page.screenshot({
    clip: {
      x: Math.floor(bounds.x),
      y: Math.floor(bounds.y),
      width: Math.ceil(bounds.x + bounds.width) - Math.floor(bounds.x),
      height: Math.ceil(bounds.y + bounds.height) - Math.floor(bounds.y),
    },
    scale: "css",
  });
  const paint = await row.evaluate(
    async (element, { png, clip }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const rect = element.getBoundingClientRect();
      const color = getComputedStyle(element)
        .outlineColor.match(/\d+/g)
        .map(Number);
      const sample = (x, y) => {
        const pixel = context.getImageData(
          Math.floor(x - clip.x),
          Math.floor(y - clip.y),
          1,
          1,
        ).data;
        return (
          pixel[3] === 255 &&
          color.every((value, index) => Math.abs(value - pixel[index]) < 30)
        );
      };
      // Sample the center of the 2px stroke, beyond its 2px offset.
      return {
        top: sample(rect.left + rect.width / 2, rect.top - 3),
        bottom: sample(rect.left + rect.width / 2, rect.bottom + 3),
        left: sample(rect.left - 3, rect.top + rect.height / 2),
        right: sample(rect.right + 3, rect.top + rect.height / 2),
      };
    },
    {
      png: image.toString("base64"),
      clip: { x: Math.floor(bounds.x), y: Math.floor(bounds.y) },
    },
  );
  expect(paint).toEqual({ top: true, bottom: true, left: true, right: true });
}

test("profile channel focus ring paints on one row and both list boundaries", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/profiles.html");
  const panel = page.getByRole("complementary", {
    name: "Profile",
    exact: true,
  });
  const channels = panel.getByRole("region", { name: "Channels" });
  await page
    .getByRole("button", { name: "View thread: 1 reply", exact: true })
    .click();
  await page.getByRole("button", { name: "View Pinky profile" }).click();
  await panel.getByRole("tab", { name: "Channels" }).click();
  const single = channels.locator("ul");
  await expect(single.locator("li")).toHaveCount(1);
  // The source fixture has no host keyboard-modality listener; emulate its
  // state after a real keyboard input while retaining browser :focus-visible.
  await page.keyboard.press("Tab");
  await page
    .locator("html")
    .evaluate((html) => html.setAttribute("data-keyboard-navigation", ""));
  await single.getByRole("button", { name: "One" }).focus();
  await expectPaintedRing(page, single, single.getByRole("button"));

  await page
    .locator(
      '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button[aria-label^="Close "]',
    )
    .click();
  await page
    .getByRole("article", { name: "Conversation", exact: true })
    .getByRole("button", { name: "View Viewer profile" })
    .click();
  await panel.getByRole("tab", { name: "Channels" }).click();
  const multiple = channels.locator("ul");
  await expect(multiple.locator("li")).toHaveCount(2);
  for (const row of [
    multiple.getByRole("button").first(),
    multiple.getByRole("button").last(),
  ]) {
    await page.keyboard.press("Tab");
    await row.focus();
    await expectPaintedRing(page, multiple, row);
  }
});
