import { test, expect } from "./source-fixture.mjs";

// Real browser pointer/focus behavior opens each Retry's delivery detail.
test("delivery Retry explains its state on hover and focus", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/message-gallery.html?accent=blue");
  for (const [id, detail] of [
    ["delivery-failed", "Couldn’t send"],
    ["delivery-unknown", "Delivery not yet confirmed"],
    ["delivery-detail", "Reconnect to confirm delivery"],
  ]) {
    const row = page.locator(`[data-message-id="${id}"]`);
    const retry = row.getByRole("button", { name: "Retry", exact: true });
    await retry.hover();
    await expect(
      page.getByRole("tooltip").filter({ hasText: detail }),
    ).toBeVisible();
    await page.mouse.move(0, 0);
    await retry.focus();
    await expect(
      page.getByRole("tooltip").filter({ hasText: detail }),
    ).toBeVisible();
    await retry.press("Tab");
  }
});

// Built-app boundary: the shell/sidebar and timeline constrain Retry more than
// the specimen gallery does. Both engines must hit-test the whole action.
import { test as appTest } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";

appTest.describe("app delivery", () => {
  appTest.use({ productionBroker: true });
  appTest(
    "delivery Retry fits the app at enlarged text sizes",
    async ({ page, app }) => {
      await open(page, app);
      let rejected;
      await page.route("**/api/relay/**/publish", async (route) => {
        const event = route.request().postDataJSON();
        if (event.content !== "Retry containment" || rejected)
          return route.continue();
        rejected = event;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            accepted: false,
            event_id: event.id,
            message: "Fixture rejection",
          }),
        });
      });
      const editor = page.getByRole("textbox", {
        name: "Message #Alpha",
        exact: true,
      });
      await editor.fill("Retry containment");
      await editor.press("Enter");
      const row = page
        .locator("[data-channel-timeline] [data-message-id]")
        .filter({ hasText: "Retry containment" });
      const retry = row.getByRole("button", { name: "Retry", exact: true });
      await expect(retry).toBeVisible({ timeout: 15000 });
      await page.evaluate(() => document.fonts.ready);
      for (const width of [400, 800, 1440]) {
        await page.setViewportSize({ width, height: 950 });
        for (const fontSize of [32, 16]) {
          await page.evaluate((size) => {
            document.documentElement.style.fontSize = `${size}px`;
          }, fontSize);
          // Responsive remounts can detach a resolved element mid-scroll.
          // Reacquire only for this idempotent action; geometry and activation
          // assertions below are never retried.
          await settle(page);
          await expect(async () => {
            await retry.scrollIntoViewIfNeeded();
          }).toPass({ timeout: 10000 });
          await settle(page);
          const geometry = await retry.evaluate((button) => {
            const rect = button.getBoundingClientRect();
            const history = button.closest("[data-channel-timeline]");
            const clip = history.getBoundingClientRect();
            return {
              left: rect.left,
              right: rect.right,
              clipLeft: Math.max(0, clip.left),
              clipRight: Math.min(innerWidth, clip.right),
              hit: button.contains(
                document.elementFromPoint(
                  rect.right - 1,
                  rect.top + rect.height / 2,
                ),
              ),
            };
          });
          expect(geometry.left).toBeGreaterThanOrEqual(geometry.clipLeft);
          expect(geometry.right).toBeLessThanOrEqual(geometry.clipRight);
          expect(geometry.hit).toBe(true);
          await retry.focus();
          await expect(retry).toBeFocused();
          await expect(
            page.getByRole("tooltip", {
              name: "Couldn’t send this message.",
              exact: true,
            }),
          ).toBeVisible();
          await retry.press("Tab");
          await row.screenshot({
            path: appTest.info().outputPath(`retry-${width}-${fontSize}.png`),
          });
        }
      }
      await retry.focus();
      await retry.press("Enter");
      await expect(retry).toHaveCount(0);
      await expect
        .poll(() =>
          app.report.publications.some(
            ({ event }) => event?.id === rejected.id,
          ),
        )
        .toBe(true);
    },
  );
});

// Browser boundary: the real journal storage survives a reload, and a send
// that reaches the relay after its removal returns as an ordinary message.
appTest.describe("app delivery removal", () => {
  appTest.use({ productionBroker: true });
  appTest(
    "removes unconfirmed sends from this device without hiding a relay copy",
    async ({ page, app }) => {
      await open(page, app);
      const lost = new Map();
      await page.route("**/api/relay/**/publish", async (route) => {
        const request = route.request();
        const event = request.postDataJSON();
        if (!["Lost send", "Late send"].includes(event.content))
          return route.continue();
        lost.set(event.content, { id: event.id, request });
        // The connection drops mid-send: no answer ever arrives, so the
        // delivery deadline leaves it unconfirmed.
      });
      const editor = page.getByRole("textbox", {
        name: "Message #Alpha",
        exact: true,
      });
      const row = (text) =>
        page
          .locator("[data-channel-timeline] [data-message-id]")
          .filter({ hasText: text });
      for (const text of ["Lost send", "Late send"]) {
        await editor.fill(text);
        await editor.press("Enter");
        await expect(
          row(text).getByRole("button", { name: "Retry", exact: true }),
        ).toBeVisible({ timeout: 15000 });
      }
      await page.unroute("**/api/relay/**/publish");
      for (const text of ["Lost send", "Late send"]) {
        // Keyboard reaches the action on a send that may never arrive.
        const trigger = row(text).getByRole("button", {
          name: "More message actions",
        });
        await trigger.focus();
        await trigger.press("Enter");
        await page
          .getByRole("menuitem", { name: "Remove from this device" })
          .click();
        const confirmation = page.getByRole("alertdialog", {
          name: "Remove message from this device?",
        });
        await expect(confirmation).toContainText(
          "If it was delivered, it stays in the conversation.",
        );
        await confirmation.getByRole("button", { name: "Remove" }).click();
        await expect(confirmation).toHaveCount(0);
        await expect(row(text)).toHaveCount(0);
      }
      // The dropped request still reaches the relay after its removal.
      const late = lost.get("Late send").request;
      const delivered = await page.request.fetch(late.url(), {
        method: "POST",
        headers: await late.allHeaders(),
        data: late.postData(),
      });
      expect(delivered.ok()).toBe(true);
      await expect(row("Late send")).toBeVisible();
      await page.reload();
      await open(page, app);
      await expect(row("Late send")).toBeVisible();
      await expect(
        row("Late send").getByRole("button", { name: "Retry", exact: true }),
      ).toHaveCount(0);
      await expect(row("Lost send")).toHaveCount(0);
      // Removal published nothing of its own: no deletion and no resend.
      expect(
        app.report.publications.filter(
          ({ event }) =>
            event?.kind === 5 || event?.id === lost.get("Lost send").id,
        ),
      ).toEqual([]);
    },
  );
});
