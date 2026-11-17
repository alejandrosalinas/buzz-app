import { test, expect } from "./source-fixture.mjs";

const splitImage = async (page) => {
  // A 200x100 image: red on the left half, blue on the right.
  const artwork = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 100;
    const context = canvas.getContext("2d");
    context.fillStyle = "#ff0000";
    context.fillRect(0, 0, 100, 100);
    context.fillStyle = "#0000ff";
    context.fillRect(100, 0, 100, 100);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.getByLabel("Upload an image", { exact: true }).setInputFiles({
    name: "split.png",
    mimeType: "image/png",
    buffer: Buffer.from(artwork),
  });
};

// Copy the saved PNG's decoded pixels rather than drawing the displayed
// element, which WebKit can occasionally read back blank.
const savedArtwork = async (page) => {
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
    const at = (x, y) =>
      Array.from(data.slice((y * 512 + x) * 4, (y * 512 + x) * 4 + 4));
    // Count pixels painted over the background, which fills the corner.
    let left = 0;
    let right = 0;
    for (let i = 0; i < data.length; i += 4)
      if (
        data.slice(i, i + 4).some((value, channel) => value !== data[channel])
      )
        (i >> 2) % 512 < 256 ? left++ : right++;
    return {
      blank: !data.some((value, i) => i % 4 === 3 && value),
      size: [bitmap.width, bitmap.height],
      left: at(10, 256),
      right: at(500, 256),
      painted: { left, right },
    };
  });
};

// A cold WebKit can read a just-decoded image as blank once; read again.
const paintedArtwork = async (page) => {
  let artwork;
  await expect
    .poll(async () => {
      artwork = await savedArtwork(page);
      return artwork.blank;
    })
    .toBe(false);
  return artwork;
};

const drag = async (page, locator, dx, dy) => {
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + dx * box.width,
    box.y + box.height / 2 + dy * box.height,
    { steps: 4 },
  );
  await page.mouse.up();
};

// The saved artwork must be the framed part of the image, painted by a real canvas.
test("pans and zooms an uploaded agent avatar into the saved artwork", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-avatar-picker.html");
  await splitImage(page);
  const frame = page.getByRole("application", { name: "Image position" });
  await expect(frame).toBeVisible();
  await expect(frame.locator("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  await page.getByRole("slider", { name: "Zoom" }).fill("2");
  // Drag the image right until its red half fills the frame.
  await drag(page, frame, 1.5, 0);
  await page.screenshot({
    path: test.info().outputPath("agent-avatar-crop.png"),
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const { size, left, right } = await paintedArtwork(page);
  expect({ size, left, right }).toEqual({
    size: [512, 512],
    left: [255, 0, 0, 255],
    right: [255, 0, 0, 255],
  });
});

test("a drag past the avatar selects no page text", async ({ page }) => {
  await page.goto("/tests/fixtures/agent-avatar-picker.html");
  await splitImage(page);
  const frame = page.getByRole("application", { name: "Image position" });
  await expect(frame).toBeVisible();
  await drag(page, frame, 0, 4);
  expect(await page.evaluate(() => String(window.getSelection()))).toBe("");
});

test("the zoom slider appears over the avatar without moving the card", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-avatar-picker.html");
  const dock = page.getByRole("group", { name: "Agent avatars" });
  const before = await dock.boundingBox();
  await splitImage(page);
  const frame = page.getByRole("application", { name: "Image position" });
  const zoom = page.getByRole("slider", { name: "Zoom" });
  const pill = page.locator("label", { has: zoom });
  await expect(frame).toBeVisible();
  expect(await dock.boundingBox()).toEqual(before);
  await page.mouse.move(0, 0);
  await expect(pill).toHaveCSS("opacity", "0");
  await frame.hover();
  await expect(pill).toHaveCSS("opacity", "1");
  // Moving from the image onto the slider keeps it.
  await zoom.hover();
  await expect(pill).toHaveCSS("opacity", "1");
  await drag(page, zoom, 0.25, 0);
  await expect(zoom).not.toHaveValue("1");
  // A mouse-focused slider still hides once the pointer leaves.
  await page.mouse.move(0, 0);
  await expect(pill).toHaveCSS("opacity", "0");
});

test("pans and zooms an emoji over its background", async ({ page }) => {
  await page.goto("/tests/fixtures/agent-avatar-picker.html");
  await page.getByRole("tab", { name: "Emoji", exact: true }).click();
  await page.getByRole("slider", { name: "Zoom" }).fill("1.2");
  const emoji = page.getByRole("button", { name: "Choose emoji" });
  // A click without a drag still opens the picker.
  await emoji.click();
  await expect(
    page.getByRole("dialog", { name: "Choose emoji" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Choose emoji" })).toHaveCount(
    0,
  );
  // Drag the emoji's center to the right edge; the drag opens no picker.
  await drag(page, emoji, 1, 0);
  await expect(page.getByRole("dialog", { name: "Choose emoji" })).toHaveCount(
    0,
  );
  await page.screenshot({
    path: test.info().outputPath("agent-avatar-emoji.png"),
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const { size, painted } = await paintedArtwork(page);
  expect(size).toEqual([512, 512]);
  expect(painted.left).toBe(0);
  expect(painted.right).toBeGreaterThan(0);
});

// The image point under the frame's centre, as fractions of the image.
const centred = (frame) =>
  frame.evaluate((element) => {
    const f = element.getBoundingClientRect();
    const i = element.querySelector("img").getBoundingClientRect();
    return [
      (f.x + f.width / 2 - i.x) / i.width,
      (f.y + f.height / 2 - i.y) / i.height,
    ];
  });

test("zooming keeps the framed subject under the frame's centre", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-avatar-picker.html");
  await splitImage(page);
  const frame = page.getByRole("application", { name: "Image position" });
  await expect(frame).toBeVisible();
  await drag(page, frame, 0.25, 0);
  const [x, y] = await centred(frame);
  await page.getByRole("slider", { name: "Zoom" }).fill("3");
  const [zoomedX, zoomedY] = await centred(frame);
  expect(zoomedX).toBeCloseTo(x, 3);
  expect(zoomedY).toBeCloseTo(y, 3);
});

test("the zoom slider stays while its thumb is dragged off the avatar", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/fixtures/agent-avatar-picker.html");
  await splitImage(page);
  const frame = page.getByRole("application", { name: "Image position" });
  await expect(frame).toBeVisible();
  const zoom = page.getByRole("slider", { name: "Zoom" });
  const pill = page.locator("label", { has: zoom });
  const slider = await zoom.boundingBox();
  const avatar = await frame.boundingBox();
  await page.mouse.move(slider.x + 4, slider.y + slider.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    slider.x + slider.width / 2,
    avatar.y + avatar.height + 40,
    { steps: 4 },
  );
  await expect(zoom).not.toHaveValue("1");
  await expect(pill).toHaveCSS("opacity", "1");
  await page.mouse.up();
  await page.mouse.move(0, 0);
  await expect(pill).toHaveCSS("opacity", "0");
});

test("a wide upload is never painted squashed into the square", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-avatar-picker.html");
  // Record each preview's shape as it enters the page, before it can paint.
  await page.evaluate(() => {
    window.firstFrames = [];
    new MutationObserver(() => {
      for (const image of document.querySelectorAll(
        'img[alt="Avatar preview"]:not([data-seen])',
      )) {
        image.dataset.seen = "";
        const { width, height } = image.getBoundingClientRect();
        window.firstFrames.push({
          shown: getComputedStyle(image).visibility !== "hidden",
          ratio: width / height,
        });
      }
    }).observe(document, { subtree: true, childList: true });
  });
  await splitImage(page);
  await expect(
    page.getByRole("application", { name: "Image position" }),
  ).toBeVisible();
  const frames = await page.evaluate(() => window.firstFrames);
  expect(frames.length).toBeGreaterThan(0);
  for (const { shown, ratio } of frames)
    if (shown) expect(ratio).toBeCloseTo(2, 2);
});
