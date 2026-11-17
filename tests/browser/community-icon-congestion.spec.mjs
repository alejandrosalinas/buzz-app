import { openCommunityPicker } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

// A real same-origin HTTP server holds icon responses. Browser route interception
// would hide per-origin connection starvation and cannot prove server arrival.
// Saved communities beyond primary and secondary. Every connected one holds a
// real live stream, so badge sessions must leave the origin room too.
for (const saved of [4, 6]) {
  test.describe(`${saved + 2} saved communities`, () => {
    test.use({ iconCongestion: saved });

    test("held saved-community icons and live streams leave a connection for foreground traffic", async ({
      page,
      app,
    }) => {
      try {
        await page.goto(app.origin);
        const rail = await openCommunityPicker(page);
        await expect(
          rail.getByRole("button", { name: `Switch to Saved ${saved - 1}` }),
        ).toBeVisible();
        await expect
          .poll(() => app.iconCongestion.iconRequests.length)
          .toBeGreaterThanOrEqual(2);

        // Start the request from the page, not Node: it must compete for the same
        // browser's connections while both optional responses are still held.
        const foreground = page.evaluate(async () => {
          const response = await fetch("/foreground-probe");
          return response.json();
        });
        await expect
          .poll(() => app.iconCongestion.foregroundRequests.length)
          .toBe(1);
        expect(await foreground).toEqual({ reached: true });
        expect(app.iconCongestion.iconRequests).toHaveLength(2);
      } finally {
        app.iconCongestion.release();
      }
      await expect
        .poll(() => app.iconCongestion.iconRequests.length)
        .toBe(saved + 2);
    });
  });
}
