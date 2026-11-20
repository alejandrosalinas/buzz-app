import { test, expect } from "./fixture.mjs";

// Twenty Solo chats: Solo lists its newest seven, then steps by ten.
const chats = Array.from(
  { length: 20 },
  (_, index) => `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`,
);
test.use({
  productionBroker: true,
  channelIds: [...chats, "beta"],
  channelNames: {
    ...Object.fromEntries(chats.map((id, index) => [id, `Chat ${index}`])),
    beta: "Beta",
  },
  soloChannels: chats,
  ownSoloChannels: chats,
});

// Real paint geometry: Show more sits on the row icons and titles and Show
// fewer ends where row trailing content ends, on one line down to the
// minimum sidebar width.
test("Show more and Show fewer line up with the rows on one line at every sidebar width", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 1200, height: 1400 });
  await page.goto(app.origin);
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  const section = sidebar.locator('[data-sidebar-section="solo"]');
  const more = section.getByRole("button", { name: "Show more in Solo" });
  const fewer = section.getByRole("button", { name: "Show fewer in Solo" });
  await expect(more).toBeVisible();
  await expect(fewer).toHaveCount(0);
  const geometry = () =>
    section.evaluate((root) => {
      const rect = (element) => element?.getBoundingClientRect();
      const row = [...root.querySelectorAll("button[data-channel-id]")].find(
        (button) => button.getClientRects().length,
      );
      const rowBox = rect(row);
      const label = (action) => {
        const text = action?.querySelector(".navigation-item-label");
        if (!text) return null;
        const box = rect(text);
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          clipped: text.scrollWidth > text.clientWidth + 0.5,
        };
      };
      const expand = root.querySelector("[data-show-more-expand]");
      return {
        icon: rect(row.querySelector("svg")).left,
        title: rect(row.querySelector(".navigation-item-label")).left,
        // Trailing content ends at the row's end padding.
        trailing:
          rowBox.right - parseFloat(getComputedStyle(row).paddingInlineEnd),
        caret: rect(expand?.querySelector("svg"))?.left,
        more: label(expand),
        fewer: label(root.querySelector("[data-show-more-fold]")),
      };
    });
  const near = (actual, expected) =>
    expect(Math.abs(actual - expected)).toBeLessThan(0.5);
  const aligned = async ({ expand = true, fold = true } = {}) => {
    const { icon, title, trailing, caret, more, fewer } = await geometry();
    if (expand) {
      near(caret, icon);
      near(more.left, title);
      expect(more.clipped).toBe(false);
    } else expect(more).toBeNull();
    if (fold) {
      near(fewer.right, trailing);
      expect(fewer.clipped).toBe(false);
    } else expect(fewer).toBeNull();
    if (expand && fold) near(fewer.top, more.top);
  };
  await aligned({ fold: false });

  await more.click();
  await expect(fewer).toBeVisible();
  await expect(more).toBeFocused();
  const shoot = async (name) => {
    await page.mouse.move(900, 900);
    await section.locator("[data-section-show-more]").scrollIntoViewIfNeeded();
    const path = testInfo.outputPath(`${name}.png`);
    await sidebar.screenshot({ path });
    await testInfo.attach(name, { path, contentType: "image/png" });
  };
  await aligned();
  await shoot("show-more-default");

  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  const width = () =>
    sidebar.evaluate((aside) => aside.getBoundingClientRect().width);
  await handle.focus();
  await handle.press("Home");
  await expect.poll(width).toBeLessThanOrEqual(221);
  await aligned();
  await shoot("show-more-220");

  await more.click();
  await expect(fewer).toBeFocused();
  await aligned({ expand: false });
  await fewer.click();
  await expect(more).toBeFocused();
  await aligned({ fold: false });
});
