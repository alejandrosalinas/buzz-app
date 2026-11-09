import { test, expect } from "./fixture.mjs";
import { activate, clickRow, open, virtuaIdle } from "./timeline.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  pluginFixtures: true,
  historyCounts: { alpha: 20, beta: 1 },
});

// Browser-only: prove opener → retained portal → native editor focus, including
// pointer tab selection and the main pane's inert transition.
for (const pane of ["side", "main"]) {
  test(`opening and reopening a ${pane} thread resumes typing`, async ({
    page,
    app,
  }) => {
    await page.addInitScript(
      (pane) => localStorage.setItem("buzz-thread-placement.v1", pane),
      pane,
    );
    await open(page, app);
    const roots = app.histories
      .get("primary/alpha")
      .filter((row) => row.content.startsWith("Thread root"));
    const main = page.locator("[data-main-workspace]");
    const host = page.locator(
      pane === "main" ? "[data-main-workspace]" : "[data-panel-workspace]",
    );
    const reply = host.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    const tab = (root) =>
      host.locator(`[role="tab"][data-tab-value="thread:alpha:${root.id}"]`);
    const showConversation = async () => {
      const conversationTab = main.getByRole("tab", {
        name: "Alpha",
        exact: true,
      });
      if (pane === "main" && (await conversationTab.count()))
        await conversationTab.click();
    };
    const openThread = async (root, keyboard = false) => {
      await showConversation();
      const trigger = page
        .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ });
      if (keyboard) await activate(trigger);
      else await clickRow(page, trigger);
      await expect(reply).toBeFocused();
    };
    await openThread(roots[0]);
    await page.keyboard.type("First thread draft");
    await expect(reply).toHaveText("First thread draft");
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
    const selection = () =>
      reply.evaluate((editor) => [editor.selectionStart, editor.selectionEnd]);
    await expect.poll(selection).toEqual([12, 12]);
    await openThread(roots[1], true);
    await page.keyboard.type("Second thread draft");
    await expect(reply).toHaveText("Second thread draft");
    await tab(roots[0]).click();
    await expect(reply).toBeFocused();
    await expect(reply).toHaveText("First thread draft");
    await expect.poll(selection).toEqual([12, 12]);
    await openThread(roots[1]);
    await expect(reply).toHaveText("Second thread draft");
    // Reopen the selected thread too, without relying on a selection change.
    await openThread(roots[1], true);
    await expect(reply).toHaveText("Second thread draft");
    await expect(
      host.locator('[role="tab"][data-tab-value^="thread:"]'),
    ).toHaveCount(2);
    await openThread(roots[0]);
    await expect.poll(selection).toEqual([12, 12]);
    await page.keyboard.type("X");
    await expect(reply).toHaveText("First threadX draft");
    // Reopening the selected thread also keeps its existing caret.
    await openThread(roots[0], true);
    await expect.poll(selection).toEqual([13, 13]);
  });
}

// Beta has never been opened, so its root cannot seed the reply editor from the
// timeline cache. Hold its read until a real gesture cancels the focus request.
for (const owner of [undefined, "page draft", "menu", "dialog"]) {
  test(`a late-mounted thread ${owner ? `preserves a later ${owner}` : "focuses its reply composer"}`, async ({
    page,
    app,
  }) => {
    await open(page, app);
    const root = app.histories.get("primary/beta")[0];
    let release;
    let started;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const pending = new Promise((resolve) => {
      started = resolve;
    });
    await page.route("**/api/relay/**/query", async (route) => {
      if (
        route
          .request()
          .postDataJSON()
          .some((filter) => filter.ids?.includes(root.id))
      ) {
        started();
        await held;
      }
      await route.continue().catch(() => {});
    });
    try {
      await page.evaluate(
        (threadId) =>
          window.fixtureNavigation.open({
            version: 1,
            kind: "page",
            pluginId: "fixture.session",
            pageId: "thread-focus",
            route: { version: 1, params: threadId },
          }),
        root.id,
      );
      await page
        .getByRole("button", { name: "Open cold thread", exact: true })
        .click();
      await pending;
      // This is the late-mount boundary: neither cached history nor preview
      // has made an editor available to consume the opening's focus request.
      const reply = page.locator(
        '[aria-label="Reply to thread"][role="textbox"]',
      );
      await expect(reply).toHaveCount(0);
      let target;
      if (owner === "page draft") {
        target = page.getByRole("textbox", {
          name: "Page draft",
          exact: true,
        });
        await target.click();
        await page.keyboard.type("Keep my main draft");
      } else if (owner === "menu") {
        await page
          .getByRole("button", { name: "Your profile", exact: true })
          .click();
        target = page.getByRole("menuitem", { name: "Settings", exact: true });
        await target.focus();
      } else if (owner === "dialog") {
        await page
          .getByRole("button", { name: "Search Buzz", exact: true })
          .click();
        target = page.getByRole("combobox", {
          name: "Search Buzz",
          exact: true,
        });
        await expect(target).toBeFocused();
      }
      release();
      // The dialog correctly hides the workspace from the accessibility tree;
      // observe the retained editor DOM as the read-completion barrier.
      await expect(reply).toHaveCount(1);
      await expect(target ?? reply).toBeFocused();
      if (owner === "page draft")
        await expect(target).toHaveValue("Keep my main draft");
    } finally {
      release();
    }
  });
}

test("a link to a specific reply reveals it without focusing the composer", async ({
  page,
  app,
}) => {
  await open(page, app);
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Thread root 0");
  const target = app.reply(root.id, false, false);
  const message = app.append(
    "primary",
    "alpha",
    `<buzz://message?channel=alpha&id=${target.id}>`,
  );
  const link = page
    .locator(`[data-channel-timeline] [data-message-id="${message.id}"]`)
    .getByRole("link", { name: "Alice Fixture in #Alpha", exact: true });
  const thread = page.getByRole("region", {
    name: "Thread messages",
    exact: true,
  });
  const reply = page.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  // The appended row measures, and its link resolves the reply's byline, after
  // it mounts; the timeline follows both. A click before then retries through
  // forced scroll alignments, and a forced scroll whose event lands between
  // press and release starts Virtua's pointer-event hold, so the release misses
  // the link and the click opens nothing. Wait for the settled row.
  await expect(link).toBeVisible();
  await virtuaIdle(page);
  // Check both normal navigation and the link menu's workspace-local opener.
  for (const menu of [false, true]) {
    if (menu) {
      await link.click({ button: "right" });
      await page
        .getByRole("menuitem", { name: "Open link", exact: true })
        .click();
    } else await link.click();
    const row = thread.locator(`[data-message-id="${target.id}"]`);
    await expect(row).toBeInViewport();
    await expect(reply).toBeVisible();
    await expect(reply).not.toBeFocused();
  }
});
