import { openChannelDetails } from "./channel-details.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ historyCounts: { alpha: 1, beta: 1 } });
test("channel context menus retain keyboard focus without write capabilities", async ({
  page,
  app,
}) => {
  await open(page, app);
  const beta = page.locator('[data-channel-id="beta"]');
  const menu = page.getByRole("menu", { name: "Actions for Beta" });
  await beta.click({ button: "right" });
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole("menuitem", {
      name: "Channel actions unavailable on this connection",
    }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(beta).toBeFocused();
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(beta).toBeFocused();
});

// Representative app-wiring regression: a decoded preference update unmounts an
// open Base UI portal while ChannelsPage stays mounted. Transition permutations
// belong in useChannelRowMenu.test.tsx; this checks the actual page/portal seam.
test.describe("menu placement lifetime", () => {
  test.use({ productionBroker: true, savedSidebar: true });
  test("does not resurrect a menu after a preference refresh moves its row away and back", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const sidebar = page.getByRole("navigation", {
      name: "Subscribed channels",
      includeHidden: true,
    });
    const work = sidebar.locator('[data-sidebar-section="group:work"]');
    const starred = sidebar.locator('[data-sidebar-section="starred"]');
    // A section move retains an inert exit copy until its fade finishes.
    const activeBeta = 'button[data-channel-id="beta"]:not([inert] *)';
    const beta = sidebar.locator(activeBeta);
    const menu = page.getByRole("menu", { name: "Actions for Beta" });
    await expect(work.locator(activeBeta)).toBeVisible();
    await openChannelDetails(page);
    await page.getByText("Diagnostics", { exact: true }).click();
    const refresh = page.getByRole("button", {
      name: "Refresh groups and stars",
      exact: true,
    });
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let requested;
    const started = new Promise((resolve) => {
      requested = resolve;
    });
    let stars = ["alpha", "beta"];
    // Fake only the host decode response. No app hook or client state injection;
    // no account writes. The existing refresh/store subscription drives the UI.
    await page.route("**/sidebar-preferences", async (route) => {
      requested();
      await held;
      await route.fulfill({
        json: {
          sections: [{ id: "work", name: "Work", order: 0 }],
          assignments: { beta: "work" },
          starred: stars,
          muted: [],
        },
      });
    });
    // Keep the actual exiting row mounted so portal closure cannot pass merely
    // because the row's 100 ms fade finished. Entry and popup motion stay live.
    const exits = await page.evaluateHandle(() => {
      const animate = Element.prototype.animate;
      const held = [];
      let holding = true;
      Element.prototype.animate = function (...args) {
        const animation = animate.apply(this, args);
        if (
          this.hasAttribute("inert") &&
          this.firstElementChild?.matches("[data-channel-sidebar-row]")
        ) {
          held.push(animation);
          queueMicrotask(() => {
            if (!holding) return;
            animation.pause();
            animation.currentTime = 0;
          });
        }
        return animation;
      };
      return {
        held,
        release() {
          holding = false;
          Element.prototype.animate = animate;
          for (const animation of held)
            if (animation.playState === "paused") animation.finish();
        },
      };
    });
    try {
      await refresh.click();
      await started;
      await expect(refresh).toBeDisabled();
      await beta.click({ button: "right" });
      await expect(menu).toBeVisible();
      const leaving = await beta.elementHandle();
      release();
      await expect(starred.locator(activeBeta)).toBeVisible();
      await expect
        .poll(() => exits.evaluate(({ held }) => held.length))
        .toBeGreaterThan(0);
      await expect(menu).toHaveCount(0);
      expect(await leaving.evaluate((row) => !!row.closest("[inert]"))).toBe(
        true,
      );
      await expect(beta).toBeFocused();
      stars = ["alpha"];
      await expect(refresh).toBeEnabled();
      await refresh.click();
      await expect(work.locator(activeBeta)).toBeVisible();
      await expect(menu).toHaveCount(0);
      await beta.focus();
      await page.keyboard.press("Shift+F10");
      await expect(menu).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(beta).toBeFocused();
    } finally {
      release();
      await exits.evaluate((state) => state.release());
      await page.unroute("**/sidebar-preferences");
    }
  });
});
