import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { anchor, expectAnchor, keyScroll, settle } from "./timeline.mjs";

test.use({
  membershipActivity: true,
  productionBroker: true,
  historyCounts: { alpha: 640, beta: 1 },
});

// Do not let the shared fixture's legacy WebKit exception mask timeline reflow
// errors. These journeys must preserve the reader without observer-loop errors.
// Startup can report WebKit's ResizeObserver loop while the sidebar and search
// palette replace their loading views, before any journey step. The fixture
// still classifies those errors; the raw check starts once Messages is ready.
let startupErrors = 0;
test.beforeEach(() => {
  startupErrors = 0;
});
test.afterEach(async ({ app }) => {
  expect(app.report.errors.slice(startupErrors)).toEqual([]);
});

async function openMessages(page, app) {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  // Unread evidence can extend the row's name; its channel id is stable.
  await expect(page.locator('button[data-channel-id="alpha"]')).toBeVisible();
  // A loop error is reported in the frame that delivers the observations.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  startupErrors = app.report.errors.length;
}

test("Channels renders grouped history and live membership without turning activity into messages", async ({
  page,
  app,
}, testInfo) => {
  await openMessages(page, app);
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  const feed = page.getByRole("region", { name: "Channel message history" });
  const groups = feed.locator("[data-membership-row]");
  await expect(groups).toHaveCount(1);
  await expect(groups.first()).toContainText(
    "Pinky added by you, along with Brain",
  );
  // Member names open profiles; the row carries no message actions.
  await expect(groups.locator("button")).toHaveText(["Pinky", "you", "Brain"]);
  await groups.getByRole("button", { name: "View Pinky profile" }).click();
  const profile = page.getByRole("complementary", {
    name: "Profile",
    exact: true,
  });
  await expect(profile).toContainText("Pinky");
  await page
    .getByRole("button", { name: "Close Pinky tab", exact: true })
    .click();
  await expect(profile).toHaveCount(0);
  // Count each identity once; its overlap frame and shared artwork both
  // carry the shape. Shared Avatar owns the single-letter fallback.
  const avatars = groups
    .first()
    .locator(
      "[data-avatar-shape]:not([data-avatar-shape] [data-avatar-shape])",
    );
  await expect(avatars).toHaveCount(2);
  await expect(avatars.filter({ hasText: /^P$/ })).toHaveAttribute(
    "data-avatar-shape",
    "circle",
  );
  await expect(avatars.filter({ hasText: /^B$/ })).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  const centered = await groups.first().evaluate((row) => {
    const content = row.querySelector("p");
    const avatars = row.querySelector('[aria-hidden="true"]');
    const bounds = row.getBoundingClientRect();
    return Math.abs(
      (avatars.getBoundingClientRect().left +
        content.getBoundingClientRect().right) /
        2 -
        (bounds.left + bounds.right) / 2,
    );
  });
  expect(centered).toBeLessThan(2);
  // Pages leave notices out; the history activity came from its own read.
  expect(
    app.report.queries
      .filter(({ filter }) => filter.top_level)
      .some(({ filter }) => filter.kinds.includes(40099)),
  ).toBe(false);
  expect(
    app.report.queries.some(
      ({ filter }) =>
        filter.kinds?.length === 1 &&
        filter.kinds[0] === 40099 &&
        filter["#h"]?.includes("alpha"),
    ),
  ).toBe(true);
  await groups
    .first()
    .screenshot({ path: testInfo.outputPath("grouped-members.png") });
  await testInfo.attach("grouped-members", {
    path: testInfo.outputPath("grouped-members.png"),
    contentType: "image/png",
  });
  // The real stream subscriber/filter/session must deliver additions and departures.
  await expect.poll(() => app.relay.hasRoute("primary", "alpha")).toBe(true);
  app.membership("member_joined", 0, 0);
  app.membership("member_left", 0, 0);
  app.membership("member_left", 1, 1);
  await expect(groups).toHaveCount(1);
  await expect(groups.last()).toContainText(
    "Pinky added by you, along with Brain",
  );
  app.membership("member_removed", 0);
  await expect(groups).toHaveCount(1);
  await expect(groups.last()).toContainText(
    "Brain was added · Pinky was removed",
  );
  await expect(groups.last().locator("p")).toHaveAttribute(
    "title",
    /Pinky was removed by you/,
  );
  await groups.last().screenshot({
    path: testInfo.outputPath("latest-membership-change.png"),
  });
  app.membership("member_joined", 0, -1, true);
  // Place a genuine message after the forgery: seeing it proves the batch was processed.
  const after = app.append("primary", "alpha", "After membership activity");
  await expect(feed.locator(`[data-message-id="${after.id}"]`)).toBeVisible();
  await expect(groups).toHaveCount(1);
  // A normal message is a grouping barrier, never swallowed by an activity cohort.
  app.membership("member_joined", 0);
  await expect(groups).toHaveCount(2);
  await expect(groups.last()).toContainText("Pinky added by you");
  await expect(groups.last()).toBeVisible();
  // Wait for the scheduled bottom-follow before leaving; an overscan count is
  // not evidence that the newly appended activity has reached the viewport.
  await expect
    .poll(() =>
      feed.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
    )
    .toBeLessThan(2);
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await expect(groups).toHaveCount(2);
  await expect(groups.last()).toBeVisible();
});

// Keep this reader-intent journey out of the older-page zone, as scroll.spec
// does, and model the read publication produced by focusing history.
const keyboardTest = test.extend({ tallMessages: true, readState: true });
keyboardTest(
  "one keyboard scroll leaves bottom follow and live membership preserves the reader",
  async ({ page, app }) => {
    await openMessages(page, app);
    // The open channel's row is quiet, and its identity locates it.
    const alpha = page.locator('button[data-channel-id="alpha"]');
    await expect(alpha).toHaveAttribute("aria-current", "page");
    await expect(alpha.getByRole("img")).toHaveCount(0);
    await alpha.click();
    const feed = page.getByRole("region", { name: "Channel message history" });
    const distance = () =>
      feed.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
    await expect(feed.locator("[data-membership-row]")).toContainText(
      "Pinky added by you, along with Brain",
    );
    await settle(page);
    await expect.poll(distance).toBeLessThan(2);
    expect(
      await feed.evaluate(
        (el) => el.scrollTop - Math.max(3000, el.clientHeight * 4),
      ),
      "keyboard reading starts outside the older-page zone",
    ).toBeGreaterThan(0);
    await feed.focus();
    await expect(feed).toBeFocused();
    // Settled geometry is not completion: Linux WebKit can pause a gesture and
    // resume it after the anchor is captured. Wait for its scrollend. Do not
    // require PageUp to animate; a loaded engine can land it in one frame.
    await keyScroll(page, "PageUp");
    await expect.poll(distance).toBeGreaterThan(200);
    await settle(page);
    const saved = await anchor(page);
    await expect.poll(() => app.relay.hasRoute("primary", "alpha")).toBe(true);
    app.membership("member_left", 0);
    const after = app.append(
      "primary",
      "alpha",
      "Activity while reading above bottom",
    );
    await expect(
      feed.locator(`[data-message-id="${after.id}"]`),
    ).toBeAttached();
    await settle(page);
    await expectAnchor(page, saved);
    expect(await distance()).toBeGreaterThan(200);
  },
);

test("a restored membership anchor follows delayed group growth through resize and revisit", async ({
  page,
  app,
}) => {
  const history = app.histories.get("primary/alpha");
  const members = history.filter((event) => event.kind === 40099);
  // Keep a preceding message and later chats: the activity is an interior anchor.
  history.splice(0, history.length, history[0], ...members);
  const delayed = app.membership("member_joined", 0, -1, false, false);
  for (let i = 0; i < 12; i++)
    app.append(
      "primary",
      "alpha",
      `Later chat ${i} ${"Long message. ".repeat(30)}`,
      false,
    );
  history.splice(history.indexOf(delayed), 1);
  await openMessages(page, app);
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  const feed = page.getByRole("region", { name: "Channel message history" });
  await settle(page);
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  // Seed only a persisted reading preference, not relay evidence or client rows.
  await page.evaluate((id) => {
    const key = Object.keys(localStorage).find(
      (key) =>
        key.startsWith("buzz-view.v1:") &&
        JSON.parse(key.slice("buzz-view.v1:".length))[1] === "scroll:alpha",
    );
    if (!key) throw new Error("Missing saved Alpha reading position");
    localStorage.setItem(
      key,
      JSON.stringify({ offset: 0, bottom: false, anchor: { id, y: 90 } }),
    );
  }, members[0].id);
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  const group = feed.locator("[data-membership-row]");
  const y = () =>
    group.evaluate(
      (row) =>
        row.getBoundingClientRect().top -
        row.closest("section").getBoundingClientRect().top,
    );
  await expect.poll(async () => Math.abs((await y()) - 90)).toBeLessThan(2);
  await expect(group).toHaveAttribute("data-message-id", members[1].id);
  // This competing paragraph is wholly visible, while its row is clipped.
  // Losing the retained group identity would make positionAt choose it instead.
  const preceding = await feed
    .locator(`[data-message-id="${history[0].id}"]`)
    .evaluate((row) => {
      const top = row.closest("section").getBoundingClientRect().top;
      return {
        row: row.getBoundingClientRect().top - top,
        paragraph: row.querySelector("p").getBoundingClientRect().top - top,
      };
    });
  expect(preceding.row).toBeLessThan(0);
  expect(preceding.paragraph).toBeGreaterThan(0);

  await expect.poll(() => app.relay.hasRoute("primary", "alpha")).toBe(true);
  history.push(delayed);
  app.relay.publish("primary", delayed);
  await expect(group).toHaveAttribute("data-message-id", delayed.id);
  await settle(page);
  // Deliver an ordinary reflow scroll, without a wheel/key/pointer gesture.
  await feed.evaluate((el) =>
    el.dispatchEvent(new Event("scroll", { bubbles: true })),
  );
  const beforeResize = await y();
  await page.setViewportSize({ width: 1200, height: 950 });
  await settle(page);
  await expect
    .poll(async () => Math.abs((await y()) - beforeResize))
    .toBeLessThan(2);
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  const saved = await page.evaluate(() => {
    const key = Object.keys(localStorage).find(
      (key) =>
        key.startsWith("buzz-view.v1:") &&
        JSON.parse(key.slice("buzz-view.v1:".length))[1] === "scroll:alpha",
    );
    return JSON.parse(localStorage.getItem(key));
  });
  expect(saved.anchor.id).toBe(delayed.id);
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await settle(page);
  await expect
    .poll(async () => Math.abs((await y()) - beforeResize))
    .toBeLessThan(2);
});

// A burst of joins newer than every message must not hold messages back:
// pages leave notices out, and the notices follow in their own reads.
const burstTest = test.extend({ membershipBurst: 600 });
burstTest(
  "a join burst longer than a page shows the newest messages first, then its joins",
  async ({ page, app }, testInfo) => {
    await openMessages(page, app);
    await page.getByRole("button", { name: "Alpha", exact: true }).click();
    const feed = page.getByRole("region", { name: "Channel message history" });
    const groups = feed.locator("[data-membership-row]");
    await expect(
      feed.getByText("primary alpha message 639", { exact: false }),
    ).toBeInViewport();
    await expect(
      feed.getByText("primary alpha message 625", { exact: false }),
    ).toBeVisible();
    await expect(groups).toHaveCount(1);
    await expect(groups).toContainText("and 499 others were added");
    // The second notice read pages below the first by the composite cursor.
    await expect.poll(() => app.pending.length).toBe(1);
    const notices = app.pending.shift();
    expect(notices.filter).toMatchObject({ kinds: [40099], "#h": ["alpha"] });
    expect(notices.filter.until).toEqual(expect.any(Number));
    notices.release();
    await expect(groups).toContainText("Pinky and 601 others were added");
    await expect(groups).toHaveCount(1);
    await settle(page);
    expect(app.pending).toHaveLength(0);
    // A real hover surface must remain reachable and expose every member,
    // including those beyond the scroll viewport; keyboard activation works too.
    const others = groups.getByRole("button", {
      name: "601 others",
      exact: true,
    });
    await others.hover();
    const popup = page.getByRole("dialog", {
      name: "People who were added (602)",
    });
    await expect(popup).toBeVisible();
    const people = popup.getByRole("region", {
      name: "People who were added",
      exact: true,
    });
    await expect(people.getByRole("listitem")).toHaveCount(602);
    await expect(people.getByRole("listitem").first()).toHaveText("Pinky");
    await expect(people.getByRole("listitem").nth(1)).toHaveText("Brain");
    await people.hover();
    await page.screenshot({
      path: testInfo.outputPath("membership-people.png"),
    });
    await page.mouse.wheel(0, 100000);
    await expect(people.getByRole("listitem").last()).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await page.mouse.move(0, 0);
    await others.focus();
    await others.press("Enter");
    await expect(popup).toBeVisible();
    await expect(people).toBeFocused();
    await people.press("End");
    await expect(people.getByRole("listitem").last()).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(others).toBeFocused();
    await page.setViewportSize({ width: 390, height: 900 });
    await page.locator("html").evaluate((root) => {
      root.dataset.colorMode = "dark";
      root.style.setProperty("--buzz-text-scale", "1.5");
    });
    await others.hover();
    await expect(popup).toBeVisible();
    await expect
      .poll(() =>
        popup.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return (
            rect.left >= 0 &&
            rect.right <= innerWidth &&
            rect.top >= 0 &&
            rect.bottom <= innerHeight
          );
        }),
      )
      .toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("membership-people-narrow-dark.png"),
    });
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);

    await page.screenshot({ path: testInfo.outputPath("join-burst.png") });
    await testInfo.attach("join-burst", {
      path: testInfo.outputPath("join-burst.png"),
      contentType: "image/png",
    });
  },
);
