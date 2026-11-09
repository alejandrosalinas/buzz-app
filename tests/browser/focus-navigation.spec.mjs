import { test, expect } from "./fixture.mjs";
import { closeSettings, settleShellToggle } from "./navigation.mjs";
import { open } from "./timeline.mjs";
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
    const composer = main.getByRole("textbox", {
      name: "Message #Alpha",
      exact: true,
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
    for (const target of [
      composer,
      main.getByRole("button", {
        name: "Manage members of Alpha",
        exact: true,
      }),
    ]) {
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
    for (const mode of ["light", "dark"]) {
      await page.evaluate((mode) => {
        document.documentElement.dataset.colorMode = mode;
        document.documentElement.style.setProperty("--buzz-text-scale", "2");
      }, mode);
      for (const width of [600, 900, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await tab.click();
        // The PC binding cycles: start in main so its next destination is side.
        if (!keys.apple)
          await main
            .getByRole("button", {
              name: "Manage members of Alpha",
              exact: true,
            })
            .focus();
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
            path: testInfo.outputPath(`focus-${mode}-${width}.png`),
          });
      }
    }
  },
);

test("covered panes and notifications preserve focus and F6 recovery", async ({
  page,
  app,
}) => {
  await open(page, app);
  const keys = await focusKeys(page);
  const main = page.locator("[data-main-workspace], [data-solo-focus-pane]");
  const alpha = main.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
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
