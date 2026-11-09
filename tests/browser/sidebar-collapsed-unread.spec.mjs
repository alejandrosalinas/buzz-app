import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { holdReadingFocus } from "./reading.mjs";

test.use({
  productionBroker: true,
  readState: true,
  savedSidebar: true,
  pluginFixtures: true,
  historyCounts: { alpha: 2, beta: 2 },
});

// Browser-only contract: :has() projects real unread markers through hidden
// section content into computed heading paint, including nested scope headings.
test("collapsed headings follow unread, confirmed mute and read changes", async ({
  page,
  app,
}, info) => {
  // Mark as read cuts at click time; keep the signed fixture arrival newer.
  await page.clock.setFixedTime(
    new Date(app.histories.get("primary/beta").at(-1).created_at * 1000),
  );
  await holdReadingFocus(page);
  await open(page, app);
  const section = page.locator('[data-sidebar-section="group:work"]');
  const summary = section.locator("summary");
  const title = summary.getByText("Work", { exact: true });
  const beta = section.locator('button[data-channel-id="beta"]');
  const badge = beta.locator("[data-channel-unread]");
  const menu = page.getByRole("menu", { name: "Actions for Beta" });
  const action = async (name) => {
    await beta.click({ button: "right" });
    await menu.getByRole("menuitem", { name, exact: true }).click();
    await expect(menu).toBeHidden();
  };
  const ink = (role) =>
    title.evaluate((element, role) => {
      const probe = document.createElement("span");
      probe.style.color = `var(--${role})`;
      element.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }, role);
  await expect(badge).toHaveCount(1);
  await expect(title).toHaveCSS("color", await ink("text-metadata"));
  await summary.click();
  await expect(beta).toBeHidden();
  for (const mode of ["light", "dark"]) {
    await page.evaluate((mode) => {
      localStorage.setItem("buzz-appearance.v1", mode);
      window.dispatchEvent(
        new StorageEvent("storage", { key: null, storageArea: localStorage }),
      );
    }, mode);
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await expect(title).toHaveCSS("color", await ink("text-navigation-unread"));
    await expect(title).toHaveCSS("font-weight", "600");
    await section.screenshot({
      path: info.outputPath(`collapsed-${mode}.png`),
    });
    const resize = page.getByRole("separator", { name: "Resize sidebar" });
    for (const [key, scale] of [
      ["Home", 2],
      ["End", 1],
    ]) {
      await resize.press(key);
      await page.evaluate((scale) => {
        localStorage.setItem("buzz-font-scale.v1", String(scale));
        window.dispatchEvent(
          new StorageEvent("storage", { key: null, storageArea: localStorage }),
        );
      }, scale);
      await expect(page.locator("html")).toHaveCSS(
        "font-size",
        `${16 * scale}px`,
      );
      await expect(title).toHaveCSS(
        "color",
        await ink("text-navigation-unread"),
      );
      await section.screenshot({
        path: info.outputPath(`collapsed-${mode}-${key}.png`),
      });
    }
  }
  // Keyboard disclosure restores the quiet heading while rows carry unread.
  await summary.press("Enter");
  await expect(beta).toBeVisible();
  await expect(title).toHaveCSS("color", await ink("text-metadata"));
  await action("Mute");
  await expect(
    beta.getByRole("img", { name: "Muted", exact: true }),
  ).toBeVisible();
  await summary.click();
  await expect(title).toHaveCSS("color", await ink("text-metadata"));
  await summary.click();
  await action("Unmute");
  await expect(
    beta.getByRole("img", { name: "Muted", exact: true }),
  ).toHaveCount(0);
  await summary.click();
  await expect(title).toHaveCSS("color", await ink("text-navigation-unread"));
  await summary.click();
  await action("Mark as read");
  await expect(badge).toHaveCount(0);
  await summary.click();
  await expect(title).toHaveCSS("color", await ink("text-metadata"));
  // New evidence must update the heading without reopening its hidden rows.
  await expect.poll(() => app.relay.hasRoute("primary", "beta")).toBe(true);
  app.append("primary", "beta", "Unread while collapsed", true, false);
  await expect(badge).toHaveCount(1);
  await expect(title).toHaveCSS("color", await ink("text-navigation-unread"));
  await expect(beta).toBeHidden();
  // The aggregate Team heading also represents nested collapsed sections.
  const team = page.locator(
    '[data-sidebar-section="scope:team"] > .navigation-section-heading .navigation-section-heading-label > details > summary',
  );
  await team.click();
  await expect(team.getByText("Team", { exact: true })).toHaveCSS(
    "color",
    await ink("text-navigation-unread"),
  );
  await team.press("Enter");
  await expect(summary).toBeVisible();
});

test.describe("thread activity", () => {
  test.use({
    threadUnread: true,
    historyCounts: { alpha: 20, beta: 1 },
  });

  test("unread replies highlight a collapsed starred heading after reading the timeline", async ({
    page,
    app,
  }) => {
    await holdReadingFocus(page);
    await open(page, app);
    const section = page.locator('[data-sidebar-section="starred"]');
    const alpha = section.locator('button[data-channel-id="alpha"]');
    // Opening Alpha quieted its row; move to Beta, then a later reply in a
    // followed thread lights it again.
    await page.locator('button[data-channel-id="beta"]').first().click();
    await expect(alpha.locator("[data-channel-activity]")).toHaveCount(0);
    const root = app.histories.get("primary/alpha").at(-2);
    app.relay.publish(
      "primary",
      finalizeEvent(
        {
          kind: 9,
          created_at: Math.floor(Date.now() / 1000),
          content: "Later broadcast reply",
          tags: [
            ["h", "alpha"],
            ["e", root.id, "", "reply"],
            ["broadcast", "1"],
          ],
        },
        generateSecretKey(),
      ),
    );
    await expect(alpha.locator("[data-channel-activity]")).toHaveCount(1);
    // The timeline's public read operation clears top-level backlog, preserving
    // replies until their own thread is read. This is real engine state.
    await page.evaluate(async () => {
      const session = window.fixtureRelay.snapshot().session;
      const messages = session.channels
        .window("alpha")
        .rows.filter(
          (row) => !row.membership && !row.huddle && !row.threadRootId,
        )
        .map((row) => row.id);
      await session.unread.markTimelineRead("alpha", messages);
    });
    await expect(alpha.locator("[data-channel-unread-title]")).toHaveCount(0);
    await expect(alpha.locator("[data-channel-activity]")).toHaveCount(1);
    const summary = section.locator("summary");
    const title = summary.getByText("Starred", { exact: true });
    await summary.click();
    await expect(title).toHaveCSS("font-weight", "600");
    await expect(alpha).toBeHidden();
    await summary.click();
    await alpha.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Mute", exact: true }).click();
    await expect(
      alpha.getByRole("img", { name: "Muted", exact: true }),
    ).toBeVisible();
    await summary.click();
    await expect(title).toHaveCSS("font-weight", "500");
  });
});
