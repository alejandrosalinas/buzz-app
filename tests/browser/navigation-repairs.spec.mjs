import { selectCommunity } from "./navigation.mjs";
import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  enabledPlugins: ["buzz.workflows"],
  historyCounts: { alpha: 1, beta: 1 },
});
// Regressions independently reproduced by Pinky against the first wiring handoff.
const button = (page, name) => page.getByRole("button", { name, exact: true });
const entry = (page) =>
  page.evaluate(() => history.state.buzzNavigationV1.entry);

test("Back restores Personal space without inheriting the active community", async ({
  page,
  app,
}) => {
  await open(page, app);
  const rail = page.getByRole("navigation", { name: "Communities" });
  await selectCommunity(page, "Personal space");
  await expect(
    rail.getByRole("button", { name: "Community switcher: Personal space" }),
  ).toBeVisible();
  const personal = await entry(page);
  await selectCommunity(page, "Primary");
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await button(page, "Go back").click();
  await expect(
    rail.getByRole("button", { name: "Community switcher: Personal space" }),
  ).toBeVisible({ timeout: 1500 });
  expect(await entry(page)).toEqual(personal);
  await expect(
    page.getByRole("heading", { name: "Your channels, one conversation." }),
  ).toBeVisible();
  await button(page, "Go forward").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
});

// A missing page fails again synchronously, so its Retry control stays.
test("keyboard Retry keeps focus when the retry fails in place", async ({
  page,
  app,
}) => {
  const missing = {
    version: 1,
    kind: "page",
    pluginId: "missing",
    pageId: "x",
  };
  await page.goto(
    `${app.origin}/#buzz=${encodeURIComponent(JSON.stringify(missing))}`,
  );
  const retry = button(page, "Try again");
  await retry.focus();
  await retry.press("Enter");
  await retry.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(resolve)),
  );
  await expect(retry).toBeFocused();
});

test("keyboard Retry hands off focus while reconnecting a failed Messages tab opening", async ({
  page,
  app,
}) => {
  let requests = 0;
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/relay/primary/session", async (route) => {
    requests++;
    if (requests === 1) return route.fulfill({ json: {} });
    await held;
    return route.continue();
  });
  // Start outside Messages so its header activation owns preserve-focus intent.
  // Settings also reads the community profile through /session, racing this gate.
  await page.goto(
    `${app.origin}/#buzz=${encodeURIComponent(JSON.stringify({ version: 1, kind: "page", pluginId: "buzz.workflows", pageId: "workflows" }))}`,
  );
  await expect
    .poll(async () => (await entry(page)).target.pageId)
    .toBe("workflows");
  const messages = page.getByRole("tab", { name: "Messages", exact: true });
  await messages.focus();
  await messages.press("Enter");
  // A refused connection is a connection failure, whatever the visit was.
  await expect(
    page.getByRole("heading", { name: "Can’t connect" }),
  ).toBeVisible();
  await expect(
    page.getByText("Check your connection, then try again."),
  ).toBeVisible();
  expect(requests).toBe(1);
  const visit = await entry(page);
  const main = page.getByRole("main");
  // The sidebar offers its own Try again for the channel list.
  const retry = button(main, "Try again");
  try {
    await retry.focus();
    await retry.press("Enter");
    await expect.poll(() => requests, { timeout: 1500 }).toBe(2);
    await expect(retry).toHaveCount(0);
    await expect(main).toBeFocused();
  } finally {
    release();
  }
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await expect(main).toBeFocused();
  // Resolving Messages chooses its conversation in the same visit.
  expect(await entry(page)).toEqual({
    id: visit.id,
    target: {
      version: 1,
      kind: "conversation",
      channelId: "alpha",
      scope: visit.target.scope,
    },
  });
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("tabpanel", { name: "Messages", exact: true }),
  ).toBeFocused();
});

test("a refused account is explained once, as access", async ({
  page,
  app,
}) => {
  app.report.relayFailures = [];
  await page.route("**/api/relay/primary/session", (route) => {
    app.report.relayFailures.push(route.request().url());
    return route.fulfill({ status: 403, json: { error: "Forbidden" } });
  });
  await page.goto(app.origin);
  const main = page.getByRole("main");
  const access = "You don’t have access to this community";
  // Messages says why it's empty rather than giving network advice; the one
  // notice on every page offers what fixes it.
  await expect(main.getByRole("heading", { name: access })).toBeVisible();
  await expect(main.getByText(/Check your connection/)).toHaveCount(0);
  const notice = page.getByRole("dialog", { name: access });
  await expect(notice).toBeVisible();
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(sidebar.getByText(/have access/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  const refusals = app.report.relayFailures.length;
  await button(notice, "Check again").click();
  await expect
    .poll(() => app.report.relayFailures.length)
    .toBeGreaterThan(refusals);
  await expect(main.getByRole("heading", { name: access })).toBeVisible();
});

test("Skip to content focuses main without adding a visit or dropping Back", async ({
  page,
  app,
}) => {
  await open(page, app);
  await openPage(page, "Workflows");
  await expect(page.getByRole("main")).toBeFocused();
  const before = await entry(page);
  const url = page.url();
  const skip = page.getByRole("link", { name: "Skip to content", exact: true });
  await skip.focus();
  await skip.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Workflows", exact: true }),
  ).toBeVisible({ timeout: 1500 });
  await expect(page.getByRole("main")).toBeFocused();
  expect(await entry(page)).toEqual(before);
  expect(page.url()).toBe(url);
  await expect(button(page, "Go back")).toBeEnabled();
  await button(page, "Go back").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
});

test("An edited navigation hash opens its destination and survives reload and Back", async ({
  page,
  app,
}) => {
  await open(page, app);
  const alpha = await entry(page);
  await page.evaluate(() => {
    location.hash =
      "#buzz=" +
      encodeURIComponent(
        JSON.stringify({ version: 1, kind: "settings", section: "appearance" }),
      );
  });
  const appearance = page.getByRole("heading", {
    name: "Appearance",
    exact: true,
  });
  await expect(appearance).toBeVisible({ timeout: 1500 });
  const settings = await entry(page);
  await page.reload();
  await expect(appearance).toBeVisible();
  expect(await entry(page)).toEqual(settings);
  // The shell toolbar is inert behind the Settings modal; traverse history.
  await page.goBack();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  expect(await entry(page)).toEqual(alpha);
  await button(page, "Go forward").click();
  await expect(appearance).toBeVisible();
});

const launchTest = test.extend({ launchAnimation: true });
launchTest(
  "malformed navigation addresses fail explicitly on cold and warm entry",
  async ({ page, app }) => {
    await page.goto(`${app.origin}/#buzz=%7B`);
    const failed = page.getByRole("heading", {
      name: "This link doesn’t work",
      exact: true,
    });
    await expect(page.locator("#buzz-launch")).toHaveCount(0);
    await expect(failed).toBeVisible();
    const card = page.locator('.page-status[role="alert"]');
    // Opened cold, there is nowhere to go back to: Messages did not fail.
    await expect(button(card, "Go back")).toHaveCount(0);
    await expect(button(card, "Go to Messages")).toBeVisible();
    await openPage(page, "Workflows");
    await expect(failed).toBeHidden();
    await page.getByRole("tab", { name: "Agents", exact: true }).click();
    await page.evaluate(() => {
      location.hash = "#buzz=%7B";
    });
    await expect(failed).toBeVisible({ timeout: 1500 });
    await page.reload();
    await expect(page.locator("#buzz-launch")).toHaveCount(0);
    await expect(failed).toBeVisible();
    const history = page.getByRole("navigation", {
      name: "Navigation history",
      exact: true,
    });
    await button(history, "Go back").click();
    await expect(
      page.getByRole("region", { name: "Agents", exact: true }),
    ).toBeVisible();
    await button(history, "Go forward").click();
    await expect(failed).toBeVisible();
    // Followed from elsewhere in the app, the card returns there.
    await button(card, "Go back").click();
    await expect(
      page.getByRole("region", { name: "Agents", exact: true }),
    ).toBeVisible();
    await expect(failed).toBeHidden();
  },
);

// A page status rule that continues past its :has(), or a :has() list the
// minifier wraps in :is(), restyles the whole tab panel on every mutation.
test("page status :has() rules keep :has() on their subject", async ({
  page,
  app,
}) => {
  await open(page, app);
  const selectors = await page.evaluate(() => {
    const found = [];
    const walk = (rules) => {
      for (const rule of rules) {
        if (rule.cssRules) walk(rule.cssRules);
        const selector = rule.selectorText ?? "";
        if (selector.includes(":has(") && selector.includes("page-status"))
          found.push(selector);
      }
    };
    for (const sheet of document.styleSheets) walk(sheet.cssRules);
    return found;
  });
  expect(selectors.length).toBeGreaterThan(0);
  for (const selector of selectors) expect(selector).toMatch(/:has\([^()]*\)$/);
});
