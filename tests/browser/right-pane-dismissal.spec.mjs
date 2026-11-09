import { test, expect } from "./fixture.mjs";
import { activate, open } from "./timeline.mjs";
import { openChannelDetails } from "./channel-details.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  pluginFixtures: true,
  historyCounts: { alpha: 20, beta: 20 },
});

async function start(page, app) {
  await open(page, app);
  for (const channel of ["beta", "alpha"]) {
    await page.locator(`button[data-channel-id="${channel}"]`).click();
    await expect(
      page.getByRole("textbox", {
        name: `Message #${channel === "alpha" ? "Alpha" : "Beta"}`,
        exact: true,
      }),
    ).toBeVisible();
  }
  const roots = app.histories
    .get("primary/alpha")
    .filter((row) => row.content.startsWith("Thread root"));
  const tabs = page.locator(
    '[data-panel-workspace] [role="tab"][data-tab-value^="thread:"]',
  );
  const openThread = async (index) => {
    // A restored channel can paint before its new presentation owns actions.
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation.snapshot().status),
      )
      .toBe("opened");
    await activate(
      page
        .locator(
          `[data-channel-timeline="alpha"] [data-message-id="${roots[index].id}"]`,
        )
        .getByRole("button", { name: /^View thread:/ }),
    );
    await expect(
      page
        .getByRole("complementary", { name: "Thread", exact: true })
        .getByText(`Thread root ${index}`, { exact: true }),
    ).toBeVisible();
  };
  const address = () =>
    page.evaluate(() => window.fixtureNavigation.snapshot());
  return { roots, tabs, openThread, address };
}

async function traverse(page, direction, testInfo) {
  if (testInfo.project.name !== "chromium") {
    await (direction === "back" ? page.goBack() : page.goForward());
    return;
  }
  // Playwright's mouse wrapper only accepts left/right/middle. CDP exposes
  // the actual auxiliary mouse buttons, which exercise browser traversal.
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 5,
      y: 5,
      button: direction,
      buttons: direction === "back" ? 8 : 16,
      clickCount: 1,
    });
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 5,
      y: 5,
      button: direction,
      buttons: 0,
      clickCount: 1,
    });
  } finally {
    await session.detach();
  }
}

test("GitHub visits restore through native history and reload; X skips their retired visits", async ({
  page,
  app,
}) => {
  // Keep the navigation probe but disable the fixture's intentional catch-all
  // panel so this exercises the real bundled GitHub owner.
  await page.addInitScript(() =>
    localStorage.setItem(
      "buzzodz.plugins.v1",
      JSON.stringify({ version: 2, enabled: { "fixture.notes": false } }),
    ),
  );
  const { address } = await start(page, app);
  await page.route(
    "https://api.github.com/repos/sample/project/pulls/*",
    (route) =>
      route.fulfill({
        json: {
          title: "Fixture change",
          state: "open",
          user: { login: "fixture" },
          body: "Read-only fixture content",
        },
      }),
  );
  const channelVisit = (await address()).entry.id;
  const tabs = page.locator(
    '[data-panel-workspace] [role="tab"][data-tab-value^="buzz.github/object:"]',
  );
  const panel = page.getByRole("complementary", {
    name: "GitHub",
    exact: true,
  });
  const target = "https://github.com/sample/project/pull/42";
  app.append("primary", "alpha", `Review ${target}`);
  // A pasted pull request link is named for it, with the title read.
  await activate(
    page.getByRole("link", {
      name: "project#42 · Fixture change",
      exact: true,
    }),
  );
  await expect(
    panel.getByRole("heading", { name: "Fixture change #42", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect.poll(async () => (await address()).entry.id).toBe(channelVisit);
  await expect(panel).toBeHidden();
  await page.goForward();
  await expect(panel).toBeVisible();
  await page.reload();
  await expect(
    panel.getByRole("heading", { name: "Fixture change #42", exact: true }),
  ).toBeVisible();
  await tabs
    .locator("..")
    .getByRole("button", { name: /^Close / })
    .click();
  await expect.poll(async () => (await address()).entry.id).toBe(channelVisit);
  await page.goBack();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect.poll(async () => (await address()).entry.id).toBe(channelVisit);
  await expect(tabs).toHaveCount(0);
});

// Browser-only: popstate + hashchange and native/mouse traversal cannot be
// established by the memory driver or a DOM-emulated tab state test.
test("passive Back/Forward preserves a thread; X removes its visit without an invisible stop", async ({
  page,
  app,
}) => {
  const { tabs, openThread, address } = await start(page, app);
  const channelVisit = (await address()).entry.id;
  await openThread(0);
  const threadVisit = (await address()).entry.id;
  await page.goBack();
  await expect.poll(async () => (await address()).entry.id).toBe(channelVisit);
  await expect(tabs).toHaveCount(1);
  await page.goForward();
  await expect.poll(async () => (await address()).entry.id).toBe(threadVisit);
  await expect(
    page.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeVisible();
  await tabs
    .locator("xpath=..")
    .getByRole("button", { name: /^Close / })
    .click();
  await expect(tabs).toHaveCount(0);
  await expect.poll(async () => (await address()).entry.id).toBe(channelVisit);
  expect((await address()).canGoForward).toBe(false);
  await page.goBack();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect.poll(async () => (await address()).entry.id).toBe(channelVisit);
  await expect(tabs).toHaveCount(0);
  await openThread(0); // Explicit reopening is still allowed.
  await expect(tabs).toHaveCount(1);
});

// Native history must retire the hinted visit before its reader can verify a root.
for (const close of [
  "X",
  "Close all tabs",
  "Close other tabs",
  "Keep unresolved",
]) {
  test(`${close} uses an unresolved reply tab's hinted thread identity`, async ({
    page,
    app,
  }) => {
    const { roots, tabs, openThread, address } = await start(page, app);
    const channelVisit = (await address()).entry;
    let kept = channelVisit;
    if (close === "Close other tabs") {
      await openThread(1);
      kept = (await address()).entry;
    }
    const reply = "e".repeat(64);
    let release;
    let requested = false;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    await page.route("**/api/relay/**/query", async (route) => {
      if (
        route
          .request()
          .postDataJSON()
          .some((filter) => filter.ids?.includes(reply))
      ) {
        requested = true;
        await held;
      }
      await route.continue().catch(() => {});
    });
    const target = {
      ...channelVisit.target,
      messageId: reply,
      threadRootId: roots[0].id,
    };
    const pendingTab = page.locator(
      `[data-panel-workspace] [role="tab"][data-tab-value="thread:alpha:${roots[0].id}"]`,
    );
    try {
      await page.evaluate((target) => {
        void window.fixtureNavigation.open(target);
      }, target);
      await expect.poll(() => requested).toBe(true);
      await expect(pendingTab).toHaveAttribute("aria-selected", "true");
      if (close === "Keep unresolved") {
        await page.evaluate((target) => window.fixtureNavigation.open(target), {
          ...target,
          messageId: roots[1].id,
          threadRootId: roots[1].id,
        });
        await pendingTab.click({ button: "right" });
        await page
          .getByRole("menuitem", { name: "Close other tabs", exact: true })
          .click();
        await expect
          .poll(async () => (await address()).entry.target)
          .toEqual(target);
        await expect(pendingTab).toHaveAttribute("aria-selected", "true");
        await expect(tabs).toHaveCount(1);
      } else {
        if (close === "X") {
          await pendingTab
            .locator("..")
            .getByRole("button", { name: /^Close / })
            .click();
        } else {
          await (close === "Close other tabs"
            ? tabs.first()
            : pendingTab
          ).click({ button: "right" });
          await page
            .getByRole("menuitem", { name: close, exact: true })
            .click();
        }
        await expect.poll(async () => (await address()).entry).toEqual(kept);
        expect((await address()).canGoForward).toBe(false);
        await expect(pendingTab).toHaveCount(0);
        await page.goBack();
        await expect
          .poll(async () => (await address()).entry.target)
          .toMatchObject({
            kind: "conversation",
            channelId: close === "Close other tabs" ? "alpha" : "beta",
          });
        await page.goForward();
        await expect.poll(async () => (await address()).entry).toEqual(kept);
        await expect(pendingTab).toHaveCount(0);
      }
    } finally {
      release();
    }
  });
}

test("X on an inactive thread skips its visits through native history while preserving the selected thread", async ({
  page,
  app,
}, testInfo) => {
  const { tabs, openThread, address } = await start(page, app);
  const channelVisit = (await address()).entry.id;
  await openThread(0);
  await openThread(1);
  const selectedVisit = (await address()).entry.id;
  await tabs
    .first()
    .locator("xpath=..")
    .getByRole("button", { name: /^Close / })
    .click();
  await expect(tabs).toHaveCount(1);
  expect((await address()).entry.id).toBe(selectedVisit);
  await traverse(page, "back", testInfo);
  await expect.poll(async () => (await address()).entry.id).toBe(channelVisit);
  await traverse(page, "forward", testInfo);
  await expect.poll(async () => (await address()).entry.id).toBe(selectedVisit);
  await expect(tabs).toHaveCount(1);
  await expect(
    page
      .getByRole("complementary", { name: "Thread", exact: true })
      .getByText("Thread root 1", { exact: true }),
  ).toBeVisible();
});

test("a cold thread closes to its own channel in place", async ({
  page,
  app,
}) => {
  const { tabs, openThread, address } = await start(page, app);
  await openThread(0);
  // Reload the existing valid thread URL without a managed predecessor.
  await page.evaluate(() => history.replaceState(null, ""));
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeVisible();
  await tabs
    .locator("xpath=..")
    .getByRole("button", { name: /^Close / })
    .click();
  await expect(tabs).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await address()).entry.target)
    .toMatchObject({ kind: "conversation", channelId: "alpha" });
  expect((await address()).entry.target.messageId).toBeUndefined();
  expect((await address()).canGoBack).toBe(false);
});

test("closing the selected thread returns to its surviving neighbour and Back leaves that thread", async ({
  page,
  app,
}) => {
  const { tabs, openThread, address } = await start(page, app);
  const channelVisit = (await address()).entry.id;
  await openThread(0);
  const firstVisit = (await address()).entry.id;
  await openThread(1);
  await tabs
    .last()
    .locator("xpath=..")
    .getByRole("button", { name: /^Close / })
    .click();
  await expect(tabs).toHaveCount(1);
  await expect.poll(async () => (await address()).entry.id).toBe(firstVisit);
  await page.goBack();
  await expect.poll(async () => (await address()).entry.id).toBe(channelVisit);
  await page.goForward();
  await expect.poll(async () => (await address()).entry.id).toBe(firstVisit);
  await expect(tabs).toHaveCount(1);
});

async function openGitHub(page, app) {
  await page.route(
    "https://api.github.com/repos/sample/project/pulls/*",
    (route) =>
      route.fulfill({
        json: {
          title: "Bulk close fixture",
          state: "open",
          user: { login: "fixture" },
          body: "Read-only fixture content",
        },
      }),
  );
  const target = "https://github.com/sample/project/pull/43";
  app.append("primary", "alpha", `Review ${target}`);
  // A pasted pull request link is named for it, with the title read.
  await activate(
    page.getByRole("link", {
      name: "project#43 · Bulk close fixture",
      exact: true,
    }),
  );
  await expect(
    page.getByRole("heading", { name: "Bulk close fixture #43", exact: true }),
  ).toBeVisible();
  return page.locator(
    '[data-panel-workspace] [role="tab"][data-tab-value^="buzz.github/object:"]',
  );
}

test("Close others keeps channel details visible when its routed threads are retired", async ({
  page,
  app,
}) => {
  const { openThread, address } = await start(page, app);
  const channelVisit = (await address()).entry.id;
  await openThread(0);
  await openThread(1);
  await openChannelDetails(page);
  const settings = page.getByRole("tab", {
    name: "Channel settings",
    exact: true,
  });
  await expect(settings).toHaveAttribute("aria-selected", "true");
  await settings.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Close other tabs", exact: true })
    .click();
  await expect.poll(async () => (await address()).entry.id).toBe(channelVisit);
  await expect(settings).toBeVisible();
  await expect(settings).toHaveAttribute("aria-selected", "true");
  await expect(settings).toBeFocused();
  await page.goBack();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect.poll(async () => (await address()).entry.id).toBe(channelVisit);
  await expect(settings).toHaveAttribute("aria-selected", "true");
  await openThread(0);
  await expect(settings).toHaveCount(0); // The keep intent cannot outlive its return.
});

// These prove native history skipping after one batch, including visits belonging
// to inactive closed tabs. Store-only tests cannot establish popstate traversal.
test("Close all retires mixed active and inactive content visits", async ({
  page,
  app,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "buzzodz.plugins.v1",
      JSON.stringify({ version: 2, enabled: { "fixture.notes": false } }),
    ),
  );
  const { openThread, address } = await start(page, app);
  const channelVisit = (await address()).entry.id;
  await openThread(0);
  await openThread(1);
  await openGitHub(page, app);
  const channel = page.getByRole("button", {
    name: "Manage members of Alpha",
    exact: true,
  });
  await channel.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Close all tabs", exact: true })
    .click();
  await expect.poll(async () => (await address()).entry.id).toBe(channelVisit);
  await expect(page.locator('[data-panel-workspace] [role="tab"]')).toHaveCount(
    0,
  );
  await page.goBack();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect.poll(async () => (await address()).entry.id).toBe(channelVisit);
  await expect(page.locator('[data-panel-workspace] [role="tab"]')).toHaveCount(
    0,
  );
  expect((await address()).canGoForward).toBe(false);
});

for (const keep of ["thread", "GitHub"]) {
  test(`Close others preserves an inactive ${keep} and retires every other content visit`, async ({
    page,
    app,
  }) => {
    await page.addInitScript(() =>
      localStorage.setItem(
        "buzzodz.plugins.v1",
        JSON.stringify({ version: 2, enabled: { "fixture.notes": false } }),
      ),
    );
    const { tabs, openThread, address } = await start(page, app);
    const channelVisit = (await address()).entry.id;
    await openThread(0);
    const threadVisit = (await address()).entry.id;
    await openThread(1);
    const github = await openGitHub(page, app);
    const githubVisit = (await address()).entry.id;
    await tabs.last().click();
    const kept = keep === "thread" ? tabs.first() : github;
    const keptVisit = keep === "thread" ? threadVisit : githubVisit;
    await kept.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Close other tabs", exact: true })
      .click();
    await expect.poll(async () => (await address()).entry.id).toBe(keptVisit);
    await expect(kept).toHaveAttribute("aria-selected", "true");
    await expect(kept).toBeFocused();
    await expect(
      page.locator('[data-panel-workspace] [role="tab"]'),
    ).toHaveCount(1);
    await page.goBack();
    await expect
      .poll(async () => (await address()).entry.id)
      .toBe(channelVisit);
    await page.goForward();
    await expect.poll(async () => (await address()).entry.id).toBe(keptVisit);
    await expect(kept).toHaveAttribute("aria-selected", "true");
    await expect(
      page.locator('[data-panel-workspace] [role="tab"]'),
    ).toHaveCount(1);
    expect((await address()).canGoForward).toBe(false);
  });
}
