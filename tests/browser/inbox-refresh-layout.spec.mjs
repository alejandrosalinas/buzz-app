import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

// Real layout and header truncation cannot be inferred from jsdom. Hold the
// addressed refresh while ordinary unread catch-up completes so only the loading
// indicator (not the separate stale/error notices) can change row geometry.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  inboxDm: true,
  historyCounts: { alpha: 2, beta: 1 },
});

for (const width of [1280, 280]) {
  test(`Inbox refresh status preserves layout at ${width}px`, async ({
    page,
    app,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(app.origin);
    await openPage(page, "Activity");
    const inbox = page.getByRole("region", { name: "Activity", exact: true });
    const status = inbox.getByText("Checking recent activity…", {
      exact: true,
    });
    const list = inbox.getByRole("list", { name: "Activity", exact: true });
    const rows = list.getByRole("listitem");
    const filters = inbox.getByRole("button", {
      name: /^From /,
    });
    await expect(rows).toHaveCount(3);
    await expect(status).toHaveCount(0);
    let gate;
    await page.route("**/api/relay/primary/query", async (route) => {
      const pending = gate;
      if (
        !pending ||
        !route
          .request()
          .postDataJSON()
          .some((filter) => filter["#p"] && filter.kinds?.includes(9))
      )
        return route.continue();
      pending.started = true;
      await pending.promise;
      await route.continue();
    });
    // The list's toolbar, not the page's tab strip above it.
    const toolbar = inbox.locator("header").filter({
      has: page.getByRole("button", { name: /^From / }),
    });
    await expect(toolbar).toHaveCount(1);
    const geometry = () =>
      inbox.evaluate((element) => {
        const header = element
          .querySelector('header button[aria-haspopup="menu"]')
          .closest("header");
        const box = (node) => {
          const { x, y, width, height } = node.getBoundingClientRect();
          return { x, y, width, height };
        };
        return {
          rows: [
            ...element.querySelectorAll('[aria-label="Activity"] > li'),
          ].map((row) => ({ ...box(row), text: row.textContent })),
          header: box(header),
          filters: box(
            element.querySelector('header button[aria-haspopup="menu"]'),
          ),
          unread: box(
            element.querySelector('[role="switch"][aria-label="Unread"]'),
          ),
          types: box(
            element.querySelector(
              '[role="tablist"][aria-label="Activity type"]',
            ),
          ),
        };
      });
    const measurements = [];
    await expect(filters).toBeVisible();
    const before = await geometry();
    gate = { ...Promise.withResolvers(), started: false };
    try {
      app.relay.disconnect("primary");
      await expect.poll(() => gate.started).toBe(true);
      await expect(status).toBeVisible();
      await expect(inbox.getByText("Showing retained activity.")).toHaveCount(
        0,
      );
      await expect.poll(geometry).toEqual(before);
      await expect(
        toolbar.getByText("Checking recent activity…"),
      ).toBeVisible();
      const textStyle = await status.evaluate((element) => ({
        whiteSpace: getComputedStyle(element).whiteSpace,
        overflow: getComputedStyle(element).overflow,
        textOverflow: getComputedStyle(element).textOverflow,
        width: element.getBoundingClientRect().width,
        scrollWidth: element.scrollWidth,
      }));
      expect(textStyle).toMatchObject({
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      });
      // The pane width that truncated beside the former 48px community rail.
      if (width === 280)
        expect(textStyle.scrollWidth).toBeGreaterThan(textStyle.width);
      const during = await geometry();
      measurements.push({ width, before, during, textStyle });
    } finally {
      gate.resolve();
      gate = undefined;
    }
    await expect(status).toHaveCount(0);
    await expect.poll(geometry).toEqual(before);
    await expect(inbox.getByRole("alert")).toHaveCount(0);
    await expect(filters).toHaveAccessibleName("From anyone");
    await filters.click();
    await expect(
      page.getByRole("menuitemradio", { name: "Anyone", exact: true }),
    ).toBeChecked();
    await page.keyboard.press("Escape");
    await testInfo.attach("refresh-geometry", {
      body: JSON.stringify(measurements, null, 2),
      contentType: "application/json",
    });
  });
}

// Only a browser can prove that the sibling Mark as read control leaves readable
// label space when the host's interface size doubles at a narrow width.
test("narrow enlarged-text rows overlay Mark as read without erasing their labels", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem("buzz-font-scale.v1", "2");
  });
  await page.goto(app.origin);
  await openPage(page, "Activity");
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  const list = inbox.getByRole("list", { name: "Activity", exact: true });
  const rows = list.getByRole("listitem");
  await expect(rows).toHaveCount(3);
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  await expect(list).toHaveAttribute("aria-busy", "false");
  const row = rows.first();
  const open = row.getByRole("button", { name: /^Open / });
  const check = row.getByRole("button", { name: /^Mark as read / });
  const geometry = () =>
    row.evaluate((element) => {
      const open = element.querySelector(".navigation-item");
      const label = open.querySelector(".navigation-item-label");
      const action = open.nextElementSibling;
      const box = (node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        root: parseFloat(getComputedStyle(document.documentElement).fontSize),
        row: box(element),
        open: box(open),
        label: box(label),
        action: box(action),
      };
    });
  const measured = await geometry();
  // NavigationItem truncates long labels at enlarged text sizes; this checks
  // that Mark as read reserves no additional inline space, not full visual acceptance.
  expect(measured.label.width).toBeGreaterThanOrEqual(2 * measured.root);
  expect(measured.open.x + measured.open.width).toBe(
    measured.row.x + measured.row.width,
  );
  expect(measured.action.y).toBeGreaterThanOrEqual(measured.open.y);
  expect(measured.action.y + measured.action.height).toBeLessThanOrEqual(
    measured.open.y + measured.open.height,
  );
  await open.focus();
  await expect(check.locator("xpath=..")).toHaveCSS("opacity", "1");
  await expect(row.locator("[data-inbox-date]")).toHaveCSS("opacity", "0");
  await check.click();
  // With Unread off the row stays, read: its ✓ goes and its date returns.
  await expect(row.getByRole("img", { name: "Unread" })).toHaveCount(0);
  await expect(check).toHaveCount(0);
  await expect(rows).toHaveCount(3);
  await expect(row.locator("[data-inbox-date]")).toHaveCSS("opacity", "1");
  // Row actions never open a conversation tab.
  await expect(
    inbox.getByRole("region", { name: /^Conversation in / }),
  ).toHaveCount(0);
  const filters = inbox.getByRole("button", {
    name: /^From /,
  });
  const menu = page.getByRole("menu", { name: "From" });
  const mentions = inbox
    .getByRole("tablist", { name: "Activity type" })
    .getByRole("tab", { name: "Mentions", exact: true });
  await mentions.click();
  await expect(mentions).toHaveAttribute("aria-selected", "true");
  await filters.click();
  await menu
    .getByRole("menuitemradio", { name: "Agents", exact: true })
    .click();
  await expect(menu).toHaveCount(0);
  await expect(filters).toHaveAccessibleName("From agents");
  await expect
    .poll(() =>
      filters.evaluate((element) => element.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(390);
});
