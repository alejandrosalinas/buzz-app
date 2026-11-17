import { test, expect } from "./source-fixture.mjs";

// Read the saved PNG's decoded pixels; only a real canvas paints the emoji.
const savedAlpha = async (page) => {
  const saved = page.getByRole("img", { name: "Saved avatar" });
  await expect(saved).toBeVisible();
  return saved.evaluate(async (image) => {
    await image.decode();
    const bitmap = await createImageBitmap(image);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let painted = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]) painted++;
    return {
      size: [bitmap.width, bitmap.height],
      corner: data[3],
      center: data[(256 * 512 + 256) * 4 + 3],
      painted,
    };
  });
};

test("saves an emoji over a transparent background in a squircle", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-avatar-picker.html");
  await page.getByRole("tab", { name: "Emoji", exact: true }).click();
  const artwork = page
    .getByRole("button", { name: "Choose emoji" })
    .locator("[data-avatar-shape]");
  await expect(artwork).toHaveAttribute("data-avatar-shape", "squircle");
  await page.screenshot({
    path: test.info().outputPath("agent-avatar-squircle.png"),
  });
  await page
    .getByRole("button", { name: "Use transparent background" })
    .click();
  await expect(artwork).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  // The card stays opaque and the tick contrasts with the checkerboard.
  const { surface, fill, tick, primary } = await artwork.evaluate((art) => {
    const alpha = (color) => {
      const context = document.createElement("canvas").getContext("2d");
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data[3];
    };
    let card = art.parentElement;
    while (!card.style.backgroundColor) card = card.parentElement;
    const probe = document.body.appendChild(document.createElement("i"));
    probe.style.color = "var(--text-primary)";
    const primary = getComputedStyle(probe).color;
    probe.remove();
    const swatch = document.querySelector('[data-color-swatch="transparent"]');
    return {
      surface: alpha(getComputedStyle(card).backgroundColor),
      fill: getComputedStyle(swatch).backgroundImage,
      tick: getComputedStyle(swatch.querySelector("svg")).color,
      primary,
    };
  });
  expect(surface).toBe(255);
  // The pointer still rests on the swatch, so this is its hover state.
  expect(fill).toContain("conic-gradient");
  expect(tick).toBe(primary);
  await page.screenshot({
    path: test.info().outputPath("agent-avatar-transparent.png"),
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  // A cold WebKit can read a just-decoded image as blank once; read again.
  let pixels;
  await expect
    .poll(async () => {
      pixels = await savedAlpha(page);
      return pixels.center;
    })
    .toBeGreaterThan(0);
  const { size, corner, painted } = pixels;
  expect(size).toEqual([512, 512]);
  expect(corner).toBe(0);
  expect(painted).toBeLessThan(512 * 512);
});
