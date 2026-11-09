import { fileURLToPath } from "node:url";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

// Browser-only: an own message's fit-content body and the preview's absolute
// layers are layout, which a DOM emulator does not compute.
test("a stacked own video keeps its size without a byline", async ({
  page,
  app,
}) => {
  await page.route("**/api/relay/primary/media?**", (route) =>
    route.fulfill({
      path: fileURLToPath(
        new URL(
          "../fixtures/message-gallery/assets/sample.mp4",
          import.meta.url,
        ),
      ),
      contentType: "video/mp4",
    }),
  );
  await open(page, app);
  app.append("primary", "alpha", "Before the clip");
  const event = app.append(
    "primary",
    "alpha",
    "",
    true,
    true,
    undefined,
    undefined,
    [["imeta", "url https://primary.example/media/sample.mp4", "m video/mp4"]],
  );
  const row = page
    .getByRole("region", { name: "Channel message history" })
    .locator(`[data-message-id="${event.id}"]`);
  const message = row.locator(":scope > [data-layout]");
  await expect(message).toHaveAttribute("data-viewer-message", "");
  await expect(message).toHaveAttribute("data-stack-previous", "true");
  // The preview's width and that of the message body holding it.
  const widths = () =>
    message.locator("[data-video-preview]").evaluate((preview) => {
      const body = [...preview.closest("[data-layout]").children].find(
        (child) => child.contains(preview),
      );
      return {
        preview: preview.getBoundingClientRect().width,
        body: body.getBoundingClientRect().width,
        row: preview.closest("[data-layout]").getBoundingClientRect().width,
      };
    });
  // The default 16:9 ratio at 11.25rem tall.
  await expect.poll(async () => Math.round((await widths()).preview)).toBe(320);
  // A narrow row still fits the preview inside the message body.
  await page.setViewportSize({ width: 360, height: 720 });
  // The dock and native scrollbar reduce the available row width. Preserve
  // a substantial preview relative to that row, rather than the viewport.
  await expect
    .poll(async () => {
      const { preview, row } = await widths();
      return preview / row;
    })
    .toBeGreaterThan(0.5);
  await expect
    .poll(async () => {
      const { preview, body } = await widths();
      return Math.abs(preview - Math.min(320, body));
    })
    .toBeLessThanOrEqual(0.5);
  await expect
    .poll(async () => {
      const { preview, body } = await widths();
      return preview - body;
    })
    .toBeLessThanOrEqual(0.5);
});
