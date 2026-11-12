import { test, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";

// Real layout, scrolling, 3D faces and popup focus cannot be proved in jsdom.
test("backup pills open stable key details and long content scrolls within the badge", async ({
  page,
}) => {
  const server = await createServer({
    configFile: false,
    envFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const height = (badge) => badge.evaluate((el) => el.offsetHeight);
  const openFixture = async (path, mode) => {
    await page.setViewportSize({ width: 1920, height: 1440 });
    await page.goto(`${origin}/tests/fixtures/${path}`);
    await page.evaluate(async (colorMode) => {
      document.documentElement.dataset.colorMode = colorMode;
      await document.fonts.ready;
    }, mode);
  };
  try {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    for (const mode of ["light", "dark"]) {
      await openFixture("identity-badge.html", mode);
      const badge = page.getByRole("region", { name: "Your Buzz ID" });
      const check = badge.getByRole("button", { name: "Check backup" });
      await expect(check).toBeVisible();
      const front = await height(badge);
      await check.focus();
      // Pause the real flip near its start: settled checks miss a blank first half.
      await badge.evaluate((el) => {
        document.addEventListener(
          "click",
          () => {
            for (const animation of el.getAnimations({ subtree: true })) {
              animation.pause();
              animation.currentTime = 1;
            }
          },
          { once: true },
        );
      });
      await page.keyboard.press("Enter");
      const back = badge.getByRole("button", { name: "Back", exact: true });
      await expect(back).toBeFocused();
      const inactive = badge.locator('[inert][aria-hidden="true"]');
      await expect(inactive).toHaveCSS("visibility", "visible");
      await badge.evaluate((el) => {
        for (const animation of el.getAnimations({ subtree: true }))
          animation.finish();
      });
      // Compare the card alone: DOM/geometry miss the overlay; the corner tooltip animates.
      const card = inactive.locator("..");
      const painted = await card.screenshot();
      await inactive.evaluate((el) => (el.style.visibility = "hidden"));
      const hidden = await card.screenshot();
      await inactive.evaluate((el) => el.style.removeProperty("visibility"));
      expect(painted.equals(hidden), "inactive face must not paint").toBe(true);
      const keyMenu = badge.getByRole("button", {
        name: "Private key actions",
      });
      await keyMenu.click();
      await expect(page.getByRole("menu")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(keyMenu).toBeFocused();
      const retry = badge.getByRole("button", { name: "Retry backup" });
      const remove = badge.getByRole("button", { name: "Remove from device" });
      const retryBox = await retry.boundingBox();
      expect(retryBox.y + retryBox.height).toBeLessThan(
        (await remove.boundingBox()).y,
      );
      expect(await height(badge)).toBe(front);
      await remove.click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await expect(remove).toBeFocused();
    }

    await page.goto(`${origin}/tests/fixtures/identity-badge.html`);
    const badge = page.getByRole("region", { name: "Your Buzz ID" });
    await page.setViewportSize({ width: 390, height: 950 });
    await page.evaluate(
      () => (document.documentElement.style.fontSize = "32px"),
    );
    const check = badge.getByRole("button", { name: "Check backup" });
    await expect(check).toBeVisible();
    expect(
      await check.evaluate((el) => {
        const r = el.parentElement.getBoundingClientRect();
        const face = el.closest('[aria-hidden="false"]');
        const card = face.getBoundingClientRect();
        const heading = face.querySelector("strong").getBoundingClientRect();
        return (
          r.left >= card.left &&
          r.right <= card.right &&
          r.top >= heading.bottom
        );
      }),
    ).toBe(true);
    await check.click();
    await page.setViewportSize({ width: 1920, height: 1440 });
    await page.evaluate(
      () => (document.documentElement.style.fontSize = "16px"),
    );
    const details = badge.getByRole("region", { name: "Identity details" });
    await expect(details).toHaveCount(0);
    // The concise attention copy fits at normal size; enlarged text overflows.
    await page.setViewportSize({ width: 390, height: 950 });
    await page.evaluate(
      () => (document.documentElement.style.fontSize = "32px"),
    );
    await expect(details).toBeVisible();
    const enlarged = await height(badge);
    const sizes = await details.evaluate((el) => ({
      scroll: el.scrollHeight,
      client: el.clientHeight,
    }));
    expect(sizes.scroll).toBeGreaterThan(sizes.client);
    const remove = badge.getByRole("button", {
      name: "Remove from device",
      exact: true,
    });
    // The two full bottom CTA labels share the accepted 390/200% limit.
    expect(
      await remove.evaluate((button) => {
        const panel = button.closest("section");
        const retry = [...button.parentElement.querySelectorAll("button")].find(
          (candidate) => candidate.textContent.trim() === "Retry backup",
        );
        const style = getComputedStyle(panel);
        const width =
          panel.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight);
        const fits = (child) =>
          child === button ||
          child === retry ||
          (child.clientWidth <= width &&
            (child.contains(button) || (retry && child.contains(retry))
              ? [...child.children].every(fits)
              : child.scrollWidth <= child.clientWidth));
        return [...panel.children].every(fits);
      }),
    ).toBe(true);
    expect(await height(badge)).toBe(enlarged);
    await details.focus();
    await page.keyboard.press("End");
    // WebKit animates the End scroll: wait for it to land at the bottom, or
    // it can carry on after the focus reveal below and scroll Remove away.
    await expect
      .poll(() =>
        details.evaluate(
          (el) =>
            el.scrollTop > 0 &&
            el.scrollHeight - el.clientHeight - el.scrollTop <= 1,
        ),
      )
      .toBe(true);
    await remove.focus();
    // WebKit reveals a focused element on a timer.
    await expect
      .poll(() =>
        remove.evaluate((el) => {
          const r = el.getBoundingClientRect(),
            p = el
              .closest('[aria-label="Identity details"]')
              .getBoundingClientRect();
          return r.top >= p.top && r.bottom <= p.bottom;
        }),
      )
      .toBe(true);
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.evaluate(
      () => (document.documentElement.style.fontSize = "16px"),
    );
    await expect(details).toHaveCount(0);
    for (const mode of ["light", "dark"]) {
      await openFixture("identity-badge.html?accounts", mode);
      await expect(page.getByRole("article")).toHaveCount(2);
      const menu = page.getByRole("button", {
        name: "More actions for Example Org",
      });
      await menu.click();
      await page.getByRole("menuitem", { name: "Sign out" }).click();
      const confirmation = page.getByRole("alertdialog");
      await expect(confirmation).toContainText("Sign out of Example Org?");
      await confirmation.getByRole("button", { name: "Cancel" }).click();
      await expect(
        page.getByRole("button", { name: "Renew sign-in", exact: true }),
      ).toBeFocused();
      await expect(
        page.getByRole("dialog", { name: "Settings" }),
      ).toBeVisible();
      const builderlab = page.getByRole("button", {
        name: "Open Builderlab settings",
      });
      await page.setViewportSize({ width: 390, height: 950 });
      await page.evaluate(
        () => (document.documentElement.style.fontSize = "32px"),
      );
      const primary = page.getByRole("article").first();
      for (const control of [menu, builderlab]) {
        await control.scrollIntoViewIfNeeded();
        expect(
          await control.evaluate((el) => {
            const c = el.getBoundingClientRect();
            const a = el.closest("article").getBoundingClientRect();
            return c.left >= a.left && c.right <= a.right;
          }),
        ).toBe(true);
      }
      await expect(
        primary.getByRole("button", { name: "Renew sign-in" }),
      ).toBeVisible();
      await page.getByRole("article").last().scrollIntoViewIfNeeded();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await expect(
        page.getByRole("button", { name: "Sign in", exact: true }),
      ).toBeVisible();
    }
  } finally {
    await server.close();
  }
});
