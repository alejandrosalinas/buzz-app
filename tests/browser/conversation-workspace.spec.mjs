import { test, expect } from "./fixture.mjs";
import { anchor, expectAnchor, open, settle, wheel } from "./timeline.mjs";

test.use({
  pluginFixtures: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 20, beta: 20 },
  viewport: { width: 1200, height: 650 },
});

const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });
const thread = (page) =>
  page.getByRole("region", { name: "Thread messages", exact: true });
const gap = (region) =>
  region.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
const reselect = (page) =>
  page.getByRole("button", { name: "Reselect transcript" }).click();
const jump = (page) =>
  page.getByRole("button", { name: "Jump retained transcript" });

async function select(page, params) {
  expect(
    await page.evaluate(
      (params) =>
        window.fixtureNavigation.open({
          version: 1,
          kind: "page",
          pluginId: "fixture.session",
          pageId: "reader",
          route: { version: 1, params },
        }),
      params,
    ),
  ).toEqual({ status: "opened" });
}

async function expectBottom(page, region) {
  await expect.poll(() => gap(region)).toBeLessThan(4);
  await settle(page, region);
  expect(await gap(region)).toBeLessThan(4);
}

async function readEarlier(page, region) {
  await region.hover();
  await wheel(page, -450, region);
  await expect.poll(() => gap(region)).toBeGreaterThan(200);
  await settle(page, region);
}

async function openReplyTab(app, region) {
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Thread root 1");
  await region
    .locator(`[data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ })
    .click();
  return root.content;
}

test("a workspace opens at the end on selection and reselect, and restores reading on Back and Forward", async ({
  page,
  app,
}) => {
  const region = history(page);
  await open(page, app);
  await readEarlier(page, region);

  await select(page, { channelId: "alpha" });
  await expectBottom(page, region);
  await readEarlier(page, region);
  await reselect(page);
  await expectBottom(page, region);

  const replyTab = await openReplyTab(app, region);
  const side = page.locator("[data-panel-workspace]");
  const main = page.getByRole("tablist", { name: "Transcript fixture tabs" });
  await side.getByRole("tab", { name: replyTab }).press("Alt+Shift+ArrowLeft");
  const moved = main.getByRole("tab", { name: replyTab });
  await expect(moved).toHaveAttribute("aria-selected", "true");
  await reselect(page);
  await expect(
    main.getByRole("tab", { name: "Transcript fixture" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(moved).toBeVisible();
  await expectBottom(page, region);

  await readEarlier(page, region);
  const alpha = await anchor(page);

  await select(page, { channelId: "beta" });
  await expectBottom(page, region);
  await readEarlier(page, region);
  const beta = await anchor(page);

  await page.goBack();
  await expectAnchor(page, alpha);
  await page.goForward();
  await expectAnchor(page, beta);
});

test("reselect uncovers the transcript and keeps the narrow reply dock available", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page.setViewportSize({ width: 900, height: 650 });
  const region = history(page);
  await select(page, { channelId: "alpha" });
  await expectBottom(page, region);

  const replyTab = await openReplyTab(app, region);
  const side = page
    .locator("[data-panel-workspace]")
    .getByRole("tab", { name: replyTab });
  await expect(side).toBeVisible();
  await expect(region).toHaveCount(0);

  await side.focus();
  await expect(side).toBeFocused();
  // A plugin command can issue a request without taking focus from the dock.
  await jump(page).evaluate((button) => button.click());
  await expectBottom(page, region);
  const toggle = page.getByRole("button", { name: "Toggle tab pane" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(side).toBeVisible();
});

test("a gesture retires a queued latest request before new messages arrive", async ({
  page,
  app,
}) => {
  const region = history(page);
  await open(page, app);
  await select(page, { channelId: "alpha" });
  await expectBottom(page, region);
  await readEarlier(page, region);

  const scroller = await region.elementHandle();
  // The fixture click commits the request synchronously. Send the input in
  // the same browser task, before the timeline's deferred scroll can run.
  await jump(page).evaluate((button, element) => {
    button.click();
    element.dispatchEvent(
      new WheelEvent("wheel", { bubbles: true, deltaY: -100 }),
    );
  }, scroller);
  await settle(page, region);
  const reading = await anchor(page);
  expect(await gap(region)).toBeGreaterThan(200);

  app.append("primary", "alpha", "A message arrived while reading");
  await expect(
    region.getByRole("button", { name: "1 new message" }),
  ).toBeVisible();
  await settle(page, region);
  await expectAnchor(page, reading);
  expect(await gap(region)).toBeGreaterThan(200);
});

test.describe("thread workspace", () => {
  test.use({ exactMessages: true });

  test("reselect moves the retained reader to the end and an explicit reply still wins", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const region = thread(page);
    const target = { channelId: "alpha", threadId: app.exact.root.id };
    await select(page, target);
    await expectBottom(page, region);
    await readEarlier(page, region);
    await jump(page).click();
    await expectBottom(page, region);
    await readEarlier(page, region);

    const messageId = app.exact.replies.at(-20).id;
    await select(page, { ...target, messageId });
    await expect(
      region.locator(`[data-message-id="${messageId}"]`),
    ).toBeInViewport();
    await settle(page, region);
    expect(await gap(region)).toBeGreaterThan(200);
  });
});
