import { test, expect } from "./source-fixture.mjs";

// Browser-only boundary: real emoji font painting, PNG encoding and decoding.
test("legacy emoji import produces a PNG with the saved background and painted emoji", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/profile-settings.html");
  const result = await page.evaluate(async () => {
    const { importedEmojiPicture } = await import(
      "/src/features/agents/import-picture.ts"
    );
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="256" fill="#c9d46a"/><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-size="258">🤙</text></svg>';
    const source = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    const converted = await importedEmojiPicture(source);
    const image = new Image();
    image.src = converted.png;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 512;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, 512, 512).data;
    let artwork = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] !== 201 || pixels[i + 1] !== 212 || pixels[i + 2] !== 106)
        artwork++;
    }
    return {
      sourceMatches: converted.source === source,
      png: converted.png.startsWith("data:image/png;base64,"),
      width: image.naturalWidth,
      height: image.naturalHeight,
      background: [...pixels.slice(0, 4)],
      artwork,
    };
  });
  expect(result).toMatchObject({
    sourceMatches: true,
    png: true,
    width: 512,
    height: 512,
    background: [201, 212, 106, 255],
  });
  expect(result.artwork).toBeGreaterThan(1000);
  expect(result.artwork).toBeLessThan((512 * 512) / 2);
});
