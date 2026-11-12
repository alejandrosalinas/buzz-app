import { test, expect } from "./fixture.mjs";
import {
  activityRow,
  closeSettings,
  openPage,
  settlePanelMotion,
  settleShellToggle,
} from "./navigation.mjs";
import { clickRow, open } from "./timeline.mjs";
import { readJournal } from "./reading.mjs";
import { openChannelDetails } from "./channel-details.mjs";

test.use({
  productionBroker: true,
  soloChannels: ["beta"],
  historyCounts: { alpha: 2, beta: 1 },
});

async function focusKeys(page) {
  const apple = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform),
  );
  return {
    apple,
    mod: apple ? "Meta" : "Control",
    composer: apple ? "Meta+l" : "Control+l",
    main: apple ? "Meta+Shift+h" : "Shift+F8",
    side: apple ? "Meta+Shift+l" : "F8",
  };
}

// Browser focus, modal dismissal and native editor selection require a real
// browser. The app and broker are real; upstream relay traffic is modeled.
test("search, composer and split-pane keyboard focus preserve both drafts", async ({
  page,
  app,
}) => {
  await open(page, app);
  const keys = await focusKeys(page);
  const mod = keys.mod;
  const main = page.locator("[data-main-workspace], [data-solo-focus-pane]");
  const alpha = main.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await alpha.fill("Alpha draft");
  await page.keyboard.press(`${mod}+k`);
  const search = page.getByRole("dialog", { name: "Search Buzz", exact: true });
  const query = search.getByRole("combobox", {
    name: "Search Buzz",
    exact: true,
  });
  await expect(query).toBeFocused();
  await query.fill("Beta");
  // Beta is a Solo chat, so it is in the Chats group.
  const chats = search.locator('[aria-label="Chats"] [data-search-result]');
  await expect(chats.filter({ hasText: /Beta/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Enter");
  await expect(search).toHaveCount(0);
  const beta = main.getByRole("textbox", {
    name: "Message your agents",
    exact: true,
  });
  await expect(beta).toBeFocused();
  await page.keyboard.type("Beta draft");
  await expect(beta).toHaveText("Beta draft");

  // Return through the same keyboard search path and restore Alpha's draft.
  await page.keyboard.press(`${mod}+k`);
  await expect(query).toBeFocused();
  await query.fill("Alpha");
  const channels = search.locator(
    '[aria-label="Channels"] [data-search-result]',
  );
  await expect(channels.filter({ hasText: /Alpha/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Enter");
  await expect(search).toHaveCount(0);
  await expect(alpha).toBeFocused();
  await expect(alpha).toHaveText("Alpha draft");

  const link = app.append(
    "primary",
    "alpha",
    "[Open Beta](buzz://channel/beta)",
  );
  await main
    .locator(`[data-message-id="${link.id}"]`)
    .getByRole("link")
    .click();
  const side = page.locator("[data-panel-workspace]");
  const sideBeta = side.getByRole("textbox", {
    name: "Message your agents",
    exact: true,
  });
  await expect(sideBeta).toHaveText("Beta draft");

  // Pane shortcuts resume typing directly and retain the native range.
  await sideBeta.focus();
  // Seed editor state directly so setup does not race native selectionchange.
  await sideBeta.evaluate((element) => element.setSelectionRange(0, 1));
  expect(
    await sideBeta.evaluate(() => document.getSelection()?.toString()),
  ).toBe("B");
  await page.keyboard.press(keys.main);
  await expect(alpha).toBeFocused();
  await page.keyboard.press(keys.side);
  await expect(sideBeta).toBeFocused();
  expect(
    await sideBeta.evaluate((element) => [
      element.selectionStart,
      element.selectionEnd,
    ]),
  ).toEqual([0, 1]);
  expect(
    await sideBeta.evaluate(() => document.getSelection()?.toString()),
  ).toBe("B");
  await expect(alpha).toHaveText("Alpha draft");
  await expect(sideBeta).toHaveText("Beta draft");

  // A collapsed pane keeps its draft mounted but cannot receive shortcut focus.
  const toggle = page.getByRole("button", {
    name: "Toggle tab pane",
    exact: true,
  });
  await toggle.click();
  await expect(side).toBeHidden();
  await page.keyboard.press(keys.main);
  await expect(alpha).toBeFocused();
  await toggle.click();
  await expect(sideBeta).toHaveText("Beta draft");

  // Existing shortcut journeys cover storage/reload/reset. Here the real
  // capture must reach a focus action from a selected ProseMirror range.
  const title = keys.apple ? "Focus main pane" : "Focus next pane";
  await page.keyboard.press(`${mod}+,`);
  const settingsDialog = page.getByRole("dialog", {
    name: "Settings",
    exact: true,
  });
  await settingsDialog
    .getByRole("button", { name: "Shortcuts", exact: true })
    .click();
  const row = settingsDialog.getByRole("article", { name: title, exact: true });
  await row
    .getByRole("button", { name: `Change shortcut for ${title}` })
    .click();
  await expect(
    row.getByRole("textbox", { name: `New shortcut for ${title}` }),
  ).toBeFocused();
  await page.keyboard.press("Control+Alt+ArrowLeft");
  await expect(row.getByText("Modified", { exact: true })).toBeVisible();
  await closeSettings(page);
  await sideBeta.focus();
  await sideBeta.evaluate((element) => element.setSelectionRange(0, 1));
  await page.keyboard.press("Control+Alt+ArrowLeft");
  await expect(alpha).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute(
    "data-keyboard-navigation",
    "",
  );
});

test.extend({ companionFixture: true })(
  "companion overlays exclude the covered main focus targets",
  async ({ page, app }, testInfo) => {
    await page.setViewportSize({ width: 600, height: 900 });
    await open(page, app);
    const keys = await focusKeys(page);
    const main = page.locator("[data-main-workspace]");
    // The covered conversation leaves the accessibility tree; these checks
    // still read it.
    const composer = main.getByRole("textbox", {
      name: "Message #Alpha",
      exact: true,
      includeHidden: true,
    });
    const members = main.getByRole("button", {
      name: "Manage members of Alpha",
      exact: true,
      includeHidden: true,
    });
    await composer.fill("Alpha draft");
    await page
      .getByRole("button", { name: "Companion fixture", exact: true })
      .click();
    const companion = page.getByRole("complementary", {
      name: "Companion fixture",
      exact: true,
    });
    await expect(companion).toBeVisible();
    for (const target of [composer, members]) {
      await expect
        .poll(() =>
          target.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return !!document
              .elementFromPoint(
                bounds.x + bounds.width / 2,
                bounds.y + bounds.height / 2,
              )
              ?.closest('aside[aria-label="Companion fixture"]');
          }),
        )
        .toBe(true);
    }
    for (const start of [
      companion.getByRole("button", { name: "Close Companion fixture panel" }),
      page.getByRole("button", { name: "Search Buzz", exact: true }),
    ]) {
      await start.focus();
      await page.keyboard.press(keys.composer);
      await expect(start).toBeFocused();
      for (const key of [keys.main, keys.side]) {
        await page.keyboard.press(key);
        await expect(start).toBeFocused();
      }
      await expect(composer).toHaveText("Alpha draft");
    }
    await companion
      .getByRole("button", { name: "Close Companion fixture panel" })
      .click();
    await page.keyboard.press(keys.composer);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveText("Alpha draft");

    // A tool without a composer falls back to its tab, retaining visible focus
    // after pointer use in both themes, breakpoints and enlarged text.
    await openChannelDetails(page);
    const tab = page.locator("[data-panel-workspace]").getByRole("tab", {
      name: "Channel settings",
      exact: true,
    });
    const conversation = page.locator('article[aria-label="Conversation"]');
    const dock = page.locator("[data-channel-workspace] > [data-panel-dock]");
    const search = page.getByRole("button", {
      name: "Search Buzz",
      exact: true,
    });
    // Normal text puts the pane over main at full width and as a card at 900,
    // and beside it at 1440. Enlarged text floats it over main at every width.
    const coverage = new Set();
    for (const [mode, scale] of [
      ["light", "1"],
      ["light", "2"],
      ["dark", "2"],
    ]) {
      await page.evaluate(
        ([mode, scale]) => {
          document.documentElement.dataset.colorMode = mode;
          document.documentElement.style.setProperty(
            "--buzz-text-scale",
            scale,
          );
        },
        [mode, scale],
      );
      for (const width of [600, 900, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await tab.click();
        // The PC binding cycles: start outside the side pane so its next
        // destination is side. Where the pane floats over main, as at narrow
        // widths or with enlarged text, main can't take focus: start from
        // Search instead.
        if (!keys.apple) {
          // Measured, so this checks the hook rather than repeating it. The
          // click waited for the tab, and so the pane, to stop moving.
          const [pane, main] = await Promise.all([
            dock.boundingBox(),
            conversation.boundingBox(),
          ]);
          const covered =
            Math.min(pane.x + pane.width, main.x + main.width) -
              Math.max(pane.x, main.x) >
              1 &&
            Math.min(pane.y + pane.height, main.y + main.height) -
              Math.max(pane.y, main.y) >
              1;
          coverage.add(covered);
          if (covered) await expect(conversation).toHaveAttribute("inert", "");
          else await expect(conversation).not.toHaveAttribute("inert");
          const start = covered ? search : members;
          await start.focus();
          await expect(start).toBeFocused();
        }
        await expect(page.locator("html")).not.toHaveAttribute(
          "data-keyboard-navigation",
          "",
        );
        await page.keyboard.press(keys.side);
        await expect(tab).toBeFocused();
        await expect(tab).toHaveCSS("outline-style", "solid");
        await expect(tab).toHaveCSS("outline-width", "2px");
        if (testInfo.project.name === "chromium")
          await page.screenshot({
            path: testInfo.outputPath(`focus-${mode}-${scale}x-${width}.png`),
          });
      }
    }
    // Both branches ran: from main beside the pane, and from Search over it.
    if (!keys.apple) expect([...coverage].sort()).toEqual([false, true]);
  },
);

test("covered panes and notifications preserve focus and F6 recovery", async ({
  page,
  app,
}) => {
  await open(page, app);
  const keys = await focusKeys(page);
  const main = page.locator("[data-main-workspace], [data-solo-focus-pane]");
  // The covered conversation leaves the accessibility tree; these checks
  // still read it.
  const alpha = main.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
    includeHidden: true,
  });
  await alpha.fill("Alpha draft");
  const link = app.append(
    "primary",
    "alpha",
    "[Open Beta](buzz://channel/beta)",
  );
  await page
    .locator(`[data-message-id="${link.id}"]`)
    .getByRole("link")
    .click();
  const side = page.locator("[data-panel-workspace]");
  const composer = side.getByRole("textbox", {
    name: "Message your agents",
    exact: true,
  });
  await composer.fill("Beta draft");
  const exposed = (locator) =>
    locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const front = document.elementFromPoint(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
      );
      return (
        !!front &&
        element
          .closest("[data-main-workspace], [data-panel-workspace]")
          ?.contains(front)
      );
    });
  for (const width of [900, 600]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => exposed(alpha)).toBe(false);
    await composer.focus();
    await page.keyboard.press(keys.main);
    const focused = page.locator(":focus");
    await expect.poll(() => exposed(focused)).toBe(true);
    await page.keyboard.press(keys.composer);
    await expect.poll(() => exposed(focused)).toBe(true);
    await page.keyboard.type("x");
    await expect(alpha).toHaveText("Alpha draft");
    // Outside both panes, a covered main composer must not claim the shortcut.
    const search = page.getByRole("button", {
      name: "Search Buzz",
      exact: true,
    });
    await search.focus();
    await page.keyboard.press(keys.composer);
    await expect(search).toBeFocused();
    await expect(alpha).toHaveText("Alpha draft");
  }
  // Repeat with a notification above the competing dock. Toasts now rise above
  // docked composers; pin the stack to its base offset so a covered composer's
  // focus recovery stays exercised.
  await page.addStyleTag({
    content: ":root { --buzz-toast-clearance: 0px !important; }",
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await composer.fill("Toast draft");
  await composer.evaluate((input) => {
    // Exercise the real attachment rejection without allocating a huge buffer.
    const file = new File(["x"], "large.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "size", { value: 501 * 1024 * 1024 });
    const data = new DataTransfer();
    data.items.add(file);
    input.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  });
  const notices = page.getByRole("region", { name: "App notifications" });
  await expect(
    notices.getByText("Could not attach file", { exact: true }),
  ).toBeVisible();
  const toastCoversComposer = () =>
    composer.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return !!document
        .elementFromPoint(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        )
        ?.closest('[aria-label="App notifications"]');
    });
  await expect.poll(toastCoversComposer).toBe(true);
  for (const key of ["F6", "Shift+F6"]) {
    await composer.focus();
    await page.keyboard.press(key);
    await expect(notices.locator("ol")).toBeFocused();
  }
  await page.keyboard.press(keys.main);
  await expect(alpha).toBeFocused();
  await page.keyboard.press(keys.side);
  await expect(composer).toBeFocused();
  await expect(composer).toHaveText("Toast draft");

  // The toast can also cover a dock that covers the main composer. Search
  // through that stack: ignoring just the top toast must not expose the main.
  await page.setViewportSize({ width: 600, height: 900 });
  // The shell compacts its header in a later render. Focusing Search before
  // then scrolls the shell, moving main's tab offscreen where F8 can pick it.
  await settleShellToggle(page);
  await expect.poll(toastCoversComposer).toBe(true);
  // WebKit can retain horizontal shell scroll after resizing. An offscreen
  // main tab must not make that covered pane eligible for focus recovery.
  const mainTab = main.getByRole("button", {
    name: "Manage members of Alpha",
    exact: true,
    includeHidden: true,
  });
  await mainTab.evaluate((tab) => {
    const bounds = tab.getBoundingClientRect();
    const shell = tab.closest("[data-shell-tone]");
    // How far the shell overflows depends on the pages in its header, so
    // guarantee room to scroll the tab fully offscreen.
    const room = document.createElement("div");
    room.style.cssText = "flex:none;height:0;width:200vw";
    shell.append(room);
    shell.scrollLeft += bounds.x + bounds.width / 2 + 1;
  });
  await expect
    .poll(() =>
      mainTab.evaluate((tab) => {
        const bounds = tab.getBoundingClientRect();
        return bounds.x + bounds.width / 2;
      }),
    )
    .toBeLessThan(0);
  const search = page.getByRole("button", { name: "Search Buzz", exact: true });
  await search.focus();
  await page.keyboard.press(keys.composer);
  await expect(search).toBeFocused();
  await page.keyboard.press(keys.main);
  await expect(keys.apple ? search : composer).toBeFocused();
  await page.keyboard.press(keys.side);
  await expect(composer).toBeFocused();
  await expect(
    notices.getByText("Could not attach file", { exact: true }),
  ).toBeVisible();
});

// Media and container queries decide whether a pane floats over the
// conversation, and jsdom evaluates neither. Covered content must leave the
// tab order, typing and the accessibility tree, as a card and at full width.
test.extend({ readState: true, threadUnread: true })(
  "a thread covering the conversation keeps typing out of it",
  async ({ page, app }) => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await open(page, app);
    const conversation = page.locator('article[aria-label="Conversation"]');
    const composer = conversation.getByRole("textbox", {
      name: "Message #Alpha",
      exact: true,
      includeHidden: true,
    });
    await composer.fill("Alpha draft");
    const root = app.histories
      .get("primary/alpha")
      .find((event) => event.content === "Thread root 1");
    const chip = page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/, includeHidden: true });
    await clickRow(page, chip);
    const side = page.locator("[data-panel-workspace]");
    const tab = side.getByRole("tab", { name: "Thread root 1", exact: true });
    await expect(tab).toBeVisible();
    // Beside the thread, the conversation stays live.
    await expect(conversation).not.toHaveAttribute("inert");
    await composer.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" wide");
    await expect(composer).toHaveText("Alpha draft wide");

    // Narrowing while typing hands focus to the thread's tab; the draft stays.
    await page.setViewportSize({ width: 600, height: 900 });
    await expect(tab).toBeFocused();
    await page.keyboard.type("x");
    await expect(composer).toHaveText("Alpha draft wide");

    const dock = page.locator("[data-channel-workspace] > [data-panel-dock]");
    for (const width of [600, 900]) {
      await page.setViewportSize({ width, height: 900 });
      await settleShellToggle(page);
      await settlePanelMotion(page);
      if (width === 900) {
        // The sidebar leaves room for a card, with part of the composer
        // still showing beside it.
        const [card, editor] = await Promise.all([
          dock.boundingBox(),
          composer.boundingBox(),
        ]);
        expect(card.width).toBeLessThan(width / 2);
        expect(editor.x).toBeLessThan(card.x);
      }
      await expect(conversation).toHaveAttribute("inert", "");
      await expect(conversation).toHaveAttribute("aria-hidden", "true");
      await expect(
        page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
      ).toHaveCount(0);
      await tab.focus();
      for (let press = 0; press < 8; press++) {
        await page.keyboard.press("Shift+Tab");
        expect(
          await conversation.evaluate((element) =>
            element.contains(document.activeElement),
          ),
        ).toBe(false);
      }
      await page.keyboard.type("y");
      await expect(composer).toHaveText("Alpha draft wide");
    }

    await side
      .getByRole("button", { name: "Close Thread root 1 tab", exact: true })
      .click();
    await expect(conversation).not.toHaveAttribute("inert");
    await expect(chip).toBeFocused();
    await composer.click();
    await page.keyboard.press("End");
    await page.keyboard.type("!");
    await expect(composer).toHaveText("Alpha draft wide!");
  },
);

// Reading follows focus. Narrowing hands it to the thread's tab, so the thread
// keeps reading, and a message that arrives in the conversation meanwhile
// waits until closing the pane returns focus there. The journey above checks
// that covering keeps focus out.
test.extend({ readState: true, threadUnread: true })(
  "narrowing hands reading to the thread tab until the pane closes",
  async ({ page, app }) => {
    const frontiers = async () =>
      (await readJournal(page))?.state.frontiers ?? {};
    const read = (frontier, event, catchUp) =>
      Object.hasOwn(frontier, `msg:${event.id}`) ||
      (frontier[catchUp] ?? 0) >= event.created_at;
    await page.setViewportSize({ width: 1100, height: 900 });
    await open(page, app);
    const history = app.histories.get("primary/alpha");
    const root = history.find((event) => event.content === "Thread root 1");
    await clickRow(
      page,
      page
        .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ }),
    );
    const tab = page
      .locator("[data-panel-workspace]")
      .getByRole("tab", { name: "Thread root 1", exact: true });
    await expect(tab).toBeVisible();
    // Typing in the conversation reads it.
    await page
      .getByRole("textbox", { name: "Message #Alpha", exact: true })
      .click();
    const newest = Math.max(...history.map((event) => event.created_at));
    await expect
      .poll(async () => (await frontiers())["activity:alpha"] ?? 0)
      .toBeGreaterThanOrEqual(newest);
    await page.setViewportSize({ width: 600, height: 900 });
    await expect(tab).toBeFocused();
    const caughtUp = (await frontiers())["activity:alpha"];
    const message = app.append(
      "primary",
      "alpha",
      "Arrived while covered",
      true,
      false,
      undefined,
      undefined,
      [],
      caughtUp + 1,
    );
    await expect(
      page.locator(`[data-channel-timeline] [data-message-id="${message.id}"]`),
    ).toBeAttached();
    // The thread reads a later reply, so the conversation's own dwell for the
    // message has passed too.
    const reply = app.reply(root.id);
    await expect
      .poll(async () =>
        read(await frontiers(), reply, `thread-activity:${root.id}`),
      )
      .toBe(true);
    expect(read(await frontiers(), message, "activity:alpha")).toBe(false);
    await page
      .getByRole("button", { name: "Close Thread root 1 tab", exact: true })
      .click();
    await expect
      .poll(async () => read(await frontiers(), message, "activity:alpha"))
      .toBe(true);
  },
);

// The Activity page's tabs float over it the same way. The native close-all
// command must still reach the page while its tabs cover it.
test.extend({
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
})(
  "an Activity tab covering the page keeps focus out and still closes all tabs",
  async ({ page, app }) => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await open(page, app);
    await activityRow(page).click();
    const inbox = page.getByRole("region", { name: "Activity", exact: true });
    await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
    const row = inbox
      .getByRole("list", { name: "Activity", exact: true })
      .getByRole("listitem")
      .filter({ hasText: "Unread reply 1" })
      .getByRole("button", { name: /^Open / });
    await row.click();
    const side = page.locator("[data-panel-workspace]");
    const tab = side.getByRole("tab", { selected: true });
    await expect(tab).toBeVisible();
    const covered = inbox.locator(
      'div[tabindex="-1"]:has(> [data-main-workspace])',
    );
    // Beside the tab the page stays live. Narrowing from it hands focus to
    // the tab. Opening lands on the reply first; let it, or it takes focus
    // back from the row.
    await expect(covered).not.toHaveAttribute("inert");
    await expect(side.locator("[data-message-id]:focus")).toHaveCount(1);
    await row.focus();
    await expect(row).toBeFocused();
    await page.setViewportSize({ width: 600, height: 900 });
    await expect(tab).toBeFocused();
    await settlePanelMotion(page);
    await expect(covered).toHaveAttribute("inert", "");
    await expect(covered).toHaveAttribute("aria-hidden", "true");
    await tab.focus();
    for (let press = 0; press < 8; press++) {
      await page.keyboard.press("Shift+Tab");
      expect(
        await covered.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      ).toBe(false);
    }
    // Close from the pane being removed. Surviving navigation controls keep
    // their focus, and Shift+Tab can reach different ones in each engine.
    await tab.focus();
    const handled = await page.evaluate(() => {
      const event = new Event("buzz:close-all-tabs", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(handled).toBe(true);
    await expect(side).toHaveCount(0);
    await expect(covered).not.toHaveAttribute("inert");
    await expect(
      inbox.getByRole("tab", { name: "Activity", exact: true }),
    ).toBeFocused();
  },
);

// A companion over the conversation takes focus on itself, where a typed key
// does nothing: as the cover starts, and when a tab closes under it.
test.extend({ companionFixture: true })(
  "a companion covering the conversation takes focus itself, not its Close button",
  async ({ page, app }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, app);
    const conversation = page.locator('article[aria-label="Conversation"]');
    await page
      .getByRole("button", { name: "Companion fixture", exact: true })
      .click();
    const companion = page.getByRole("complementary", {
      name: "Companion fixture",
      exact: true,
    });
    const closeCompanion = companion.getByRole("button", {
      name: "Close Companion fixture panel",
      exact: true,
    });
    await expect(companion).toBeVisible();
    await expect(conversation).not.toHaveAttribute("inert");
    await page
      .getByRole("textbox", { name: "Message #Alpha", exact: true })
      .click();
    await page.setViewportSize({ width: 600, height: 900 });
    await expect(companion).toBeFocused();
    await expect(closeCompanion).not.toBeFocused();
    await expect(conversation).toHaveAttribute("inert", "");
    await page.keyboard.press("Space");
    await expect(companion).toBeVisible();

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(conversation).not.toHaveAttribute("inert");
    await openChannelDetails(page);
    const close = page.getByRole("button", {
      name: "Close Channel settings tab",
      exact: true,
    });
    await expect(close).toBeVisible();
    await page.setViewportSize({ width: 600, height: 900 });
    await settlePanelMotion(page);
    await expect(conversation).toHaveAttribute("inert", "");
    await close.click();
    await expect(close).toHaveCount(0);
    // Its opener stays covered, so the companion takes focus.
    await expect(companion).toBeFocused();
    await expect(closeCompanion).not.toBeFocused();

    // Collapsing the tab pane remounts its toggle in the conversation header,
    // which the companion still covers, so the companion takes focus again.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(conversation).not.toHaveAttribute("inert");
    await openChannelDetails(page);
    const collapse = page.locator(
      '[data-tab-pane-toggle][aria-expanded="true"]',
    );
    await expect(collapse).toBeVisible();
    await page.setViewportSize({ width: 600, height: 900 });
    await settlePanelMotion(page);
    await expect(conversation).toHaveAttribute("inert", "");
    await collapse.click();
    // The companion keeps the dock, so the workspace hides rather than unmounts.
    await expect(collapse).toBeHidden();
    await expect(conversation).toHaveAttribute("inert", "");
    await expect(companion).toBeFocused();
    await expect(closeCompanion).not.toBeFocused();
  },
);

// A side panel's launcher sits in the conversation the panel covers at narrow
// widths, so Escape returns focus to it once the close uncovers it.
test("escaping a side panel over the conversation returns focus to its launcher", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "buzzodz.plugins.v1",
      JSON.stringify({ version: 2, enabled: { "buzz.todos": true } }),
    );
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, app);
  const conversation = page.locator('article[aria-label="Conversation"]');
  const launcher = page.getByRole("button", {
    name: "Toggle channel todos",
    exact: true,
  });
  await launcher.click();
  const todos = page.getByRole("region", { name: "Todos panel", exact: true });
  await expect(todos).toBeVisible();
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .click();
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(todos).toBeFocused();
  await expect(conversation).toHaveAttribute("inert", "");
  await page.keyboard.press("Escape");
  await expect(todos).toHaveCount(0);
  await expect(conversation).not.toHaveAttribute("inert");
  await expect(launcher).toBeFocused();
});

// A side panel restored by a page remount has no launcher element to return
// to, so Escape lands on the page's fallback once the close uncovers it.
test("escaping a restored side panel over the conversation returns focus to the page", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "buzzodz.plugins.v1",
      JSON.stringify({ version: 2, enabled: { "buzz.todos": true } }),
    );
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, app);
  const conversation = page.locator('article[aria-label="Conversation"]');
  await page
    .getByRole("button", { name: "Toggle channel todos", exact: true })
    .click();
  const todos = page.getByRole("region", { name: "Todos panel", exact: true });
  await expect(todos).toBeVisible();
  await activityRow(page).click();
  await expect(todos).toHaveCount(0);
  await openPage(page, "Messages");
  await expect(todos).toBeVisible();
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .click();
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(todos).toBeFocused();
  await expect(conversation).toHaveAttribute("inert", "");
  await page.keyboard.press("Escape");
  await expect(todos).toHaveCount(0);
  await expect(conversation).not.toHaveAttribute("inert");
  await expect(
    page.getByRole("button", { name: "Channel actions", exact: true }),
  ).toBeFocused();
});

// Close-all keeps a launcher's side panel open, so at a narrow width the dock
// still covers the conversation and the closed tab's focus lands in it.
test.extend({ readState: true, threadUnread: true })(
  "closing all tabs under a side panel that stays keeps focus in the dock",
  async ({ page, app }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "buzzodz.plugins.v1",
        JSON.stringify({ version: 2, enabled: { "buzz.todos": true } }),
      );
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, app);
    const conversation = page.locator('article[aria-label="Conversation"]');
    await page
      .getByRole("button", { name: "Toggle channel todos", exact: true })
      .click();
    const todos = page.getByRole("region", {
      name: "Todos panel",
      exact: true,
    });
    await expect(todos).toBeVisible();
    const root = app.histories
      .get("primary/alpha")
      .find((event) => event.content === "Thread root 1");
    await clickRow(
      page,
      page
        .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ }),
    );
    const tab = page
      .locator("[data-panel-workspace]")
      .getByRole("tab", { name: "Thread root 1", exact: true });
    await expect(tab).toBeVisible();
    await expect(todos).toBeVisible();
    await page.setViewportSize({ width: 600, height: 900 });
    await settlePanelMotion(page);
    await expect(conversation).toHaveAttribute("inert", "");
    await tab.focus();
    await expect(tab).toBeFocused();
    expect(
      await page.evaluate(() => {
        const event = new Event("buzz:close-all-tabs", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      }),
    ).toBe(true);
    await expect(tab).toHaveCount(0);
    await expect(todos).toBeVisible();
    await expect(conversation).toHaveAttribute("inert", "");
    await expect(todos).toBeFocused();
  },
);

// Panes that stay open keep focus in the dock, in page order: closing Todos
// under the companion hands focus to the companion, and a thread tab above the
// companion takes it first.
test.extend({ companionFixture: true, readState: true, threadUnread: true })(
  "a dock that still covers the conversation keeps focus in page order",
  async ({ page, app }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "buzzodz.plugins.v1",
        JSON.stringify({ version: 2, enabled: { "buzz.todos": true } }),
      );
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, app);
    const conversation = page.locator('article[aria-label="Conversation"]');
    const composer = page.getByRole("textbox", {
      name: "Message #Alpha",
      exact: true,
    });
    await page
      .getByRole("button", { name: "Toggle channel todos", exact: true })
      .click();
    const todos = page.getByRole("region", {
      name: "Todos panel",
      exact: true,
    });
    await expect(todos).toBeVisible();
    await page
      .getByRole("button", { name: "Companion fixture", exact: true })
      .click();
    const companion = page.getByRole("complementary", {
      name: "Companion fixture",
      exact: true,
    });
    await expect(companion).toBeVisible();
    await expect(todos).toBeVisible();
    await composer.click();
    await page.setViewportSize({ width: 600, height: 900 });
    await expect(todos).toBeFocused();
    await expect(conversation).toHaveAttribute("inert", "");
    // The companion still covers Todos' launcher, so it takes focus.
    await page.keyboard.press("Escape");
    await expect(todos).toHaveCount(0);
    await expect(conversation).toHaveAttribute("inert", "");
    await expect(companion).toBeFocused();

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(conversation).not.toHaveAttribute("inert");
    const root = app.histories
      .get("primary/alpha")
      .find((event) => event.content === "Thread root 1");
    await clickRow(
      page,
      page
        .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ }),
    );
    const tab = page
      .locator("[data-panel-workspace]")
      .getByRole("tab", { name: "Thread root 1", exact: true });
    await expect(tab).toBeVisible();
    await expect(companion).toBeVisible();
    await composer.click();
    await page.setViewportSize({ width: 600, height: 900 });
    await expect(tab).toBeFocused();
  },
);
