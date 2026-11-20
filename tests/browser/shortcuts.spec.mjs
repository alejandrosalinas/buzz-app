import { pluginAction } from "./plugin-settings.mjs";
import {
  closeSettings,
  openPage,
  pageChoice,
  pageChoices,
  selectSettingsSection,
  settingsDialog,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open, settle, wheel } from "./timeline.mjs";

test.use({ pluginFixtures: true, historyCounts: { alpha: 1, beta: 0 } });
const button = (page, name) => page.getByRole("button", { name, exact: true });
const font = (locator) =>
  locator.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
const mod = async (page) =>
  (await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform)))
    ? "Meta"
    : "Control";
const scale = async (page, expected) =>
  expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--buzz-text-scale"),
      ),
    )
    .toBe(String(expected));

test("real Settings keys respect dialogs and modifiers, focus Settings, and preserve drafts", async ({
  page,
  app,
}) => {
  await open(page, app);
  const modifier = await mod(page);
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await composer.fill("Keep my draft");
  await page.keyboard.press(`${modifier}+Shift+,`);
  await expect(composer).toBeVisible();
  await button(page, "Search Buzz").click();
  await page.keyboard.press(`${modifier}+,`);
  await expect(page.getByRole("dialog", { name: "Search Buzz" })).toBeVisible();
  await expect(
    page.getByRole("dialog", {
      name: "Settings",
      exact: true,
      includeHidden: true,
    }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Search Buzz", includeHidden: true }),
  ).toHaveCount(0);
  await expect(button(page, "Search Buzz")).toBeFocused();
  await composer.focus();
  await page.keyboard.press(`${modifier}+,`);
  await expect(settingsDialog(page)).toBeVisible();
  await expect(button(settingsDialog(page), "Close Settings")).toBeFocused();
  // Closing returns to the retained conversation and its focused draft.
  await closeSettings(page);
  await expect(composer).toBeFocused();
  await expect(composer).toHaveJSProperty("value", "Keep my draft");
});

test("zoom keys scale text, icons and spacing together and persist/reset", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  const modifier = await mod(page);
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  const message = page.locator("[data-message-id] p").last();
  const base = { composer: await font(composer), message: await font(message) };
  const header = page.locator(".shell-header");
  const icon = button(page, "Search Buzz").locator("svg");
  const geometry = async () => ({
    root: await font(page.locator("html")),
    header: await header.evaluate((el) => el.getBoundingClientRect().height),
    gap: await header.evaluate((el) => parseFloat(getComputedStyle(el).gap)),
    icon: await icon.evaluate((el) => el.getBoundingClientRect().width),
  });
  const initialGeometry = await geometry();
  const expectGeometry = async (factor) => {
    for (const [key, value] of Object.entries(initialGeometry))
      await expect
        .poll(async () => (await geometry())[key])
        .toBeCloseTo(value * factor, 1);
  };
  const node = await composer.elementHandle();
  await composer.fill("Unsent zoom draft");
  await page.keyboard.press(`${modifier}+=`);
  await scale(page, 1.1);
  await expectGeometry(1.1);
  expect(await font(composer)).toBeCloseTo(base.composer * 1.1, 1);
  expect(await font(message)).toBeCloseTo(base.message * 1.1, 1);
  await page.keyboard.press(`${modifier}+Shift+=`);
  await scale(page, 1.2);
  await page.keyboard.press(`${modifier}+-`);
  await scale(page, 1.1);
  await page.keyboard.press(`${modifier}+0`);
  await scale(page, 1);
  for (const init of [
    { isComposing: true },
    { altKey: true },
    { ctrlKey: true, metaKey: true },
  ]) {
    const prevented = await composer.evaluate((el, init) => {
      const event = new KeyboardEvent("keydown", {
        key: "=",
        metaKey: /Mac|iPhone|iPad/.test(navigator.platform),
        ctrlKey: !/Mac|iPhone|iPad/.test(navigator.platform),
        bubbles: true,
        cancelable: true,
        ...init,
      });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    }, init);
    expect(prevented).toBe(false);
    await scale(page, 1);
  }
  // Locally handled events must win before the window's bubbling dispatcher.
  await composer.evaluate((el) => {
    const prevent = (event) => {
      if (event.key === "=") {
        event.preventDefault();
        el.removeEventListener("keydown", prevent);
      }
    };
    el.addEventListener("keydown", prevent);
  });
  await page.keyboard.press(`${modifier}+=`);
  await scale(page, 1);
  await page.keyboard.press(`${modifier}+=`);
  await scale(page, 1.1);
  expect(await node.evaluate((el) => el.isConnected)).toBe(true);
  await expect(composer).toHaveJSProperty("value", "Unsent zoom draft");
  await expectGeometry(1.1);
  expect(await page.evaluate(() => window.visualViewport.scale)).toBe(1);
  await page.reload();
  await scale(page, 1.1);
  await openPage(page, "Messages");
  await expect(composer).toHaveJSProperty("value", "Unsent zoom draft");
  await composer.focus();
  for (let i = 0; i < 15; i++) await page.keyboard.press(`${modifier}+=`);
  await scale(page, 2);
  await expectGeometry(2);
  expect(await font(composer)).toBeCloseTo(base.composer * 2, 1);
  expect(await font(message)).toBeCloseTo(base.message * 2, 1);
  await expect(composer).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("interface-200-percent.png"),
  });
  await page.keyboard.press(`${modifier}+0`);
  await scale(page, 1);
  await expectGeometry(1);
  expect(await font(composer)).toBe(base.composer);
  for (let i = 0; i < 5; i++) await page.keyboard.press(`${modifier}+-`);
  await scale(page, 0.8);
  await expectGeometry(0.8);
  await page.keyboard.press(`${modifier}+,`);
  await button(page, "Appearance").click();
  await expect(page.getByRole("status", { name: "Interface size" })).toHaveText(
    "80%",
  );
  await button(page, "Reset interface size").focus();
  await page.keyboard.press("Enter");
  await scale(page, 1);
  await expect(button(page, "Increase interface size")).toBeFocused();
  const colorMode = page.getByRole("combobox", { name: "Mode", exact: true });
  const modeHeight = await colorMode.evaluate(
    (el) => el.getBoundingClientRect().height,
  );
  // At 200%, the handoff target is disabled until the reset commit finishes.
  for (const reset of ["keyboard", "external", "external-unfocused"]) {
    for (let i = 0; i < 10; i++)
      await button(page, "Increase interface size").click();
    await scale(page, 2);
    await expect
      .poll(() => colorMode.evaluate((el) => el.getBoundingClientRect().height))
      .toBeCloseTo(modeHeight * 2, 1);
    await expect(button(page, "Increase interface size")).toBeDisabled();
    await (reset === "external-unfocused"
      ? colorMode
      : button(page, "Reset interface size")
    ).focus();
    if (reset === "keyboard") await page.keyboard.press("Enter");
    else
      await page.evaluate(() => {
        localStorage.setItem("buzz-font-scale.v1", "1");
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: "buzz-font-scale.v1",
            newValue: "1",
            storageArea: localStorage,
          }),
        );
      });
    await scale(page, 1);
    await expect(button(page, "Reset interface size")).toHaveCount(0);
    await expect(
      reset === "external-unfocused"
        ? colorMode
        : button(page, "Increase interface size"),
    ).toBeFocused();
  }
});

// Browser-only: vendor shadow DOM, popup collision geometry and focus must stay
// coordinated while the actual host keyboard shortcut changes the root size.
test("interface zoom preserves an open emoji search and scales its controls", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await open(page, app);
  const modifier = await mod(page);
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await composer.fill("Keep this draft ");
  await button(page, "Emoji and GIFS").click();
  const search = page.getByRole("searchbox", { name: "Search emoji" });
  await expect(search).toBeFocused();
  await search.fill("grinning");
  const emoji = button(page, "😀");
  await expect(emoji).toHaveCSS("width", "40px");
  await search.press("ArrowRight");
  const selected = page.locator(
    'em-emoji-picker .category:not([data-id]) button[aria-selected="true"]',
  );
  await expect(selected).not.toHaveAttribute("aria-label", "😀");
  const chosen = await selected.getAttribute("aria-label");
  for (let i = 0; i < 10; i++) await page.keyboard.press(`${modifier}+=`);
  await scale(page, 2);
  await expect(search).toHaveValue("grinning");
  await expect(search).toBeFocused();
  await expect(emoji).toHaveCSS("width", "80px");
  await expect(selected).toHaveAttribute("aria-label", chosen);
  await expect(page.locator("em-emoji-picker .search .loupe svg")).toHaveCSS(
    "width",
    "32px",
  );
  const popup = page.getByRole("dialog", { name: "Emoji picker" });
  await expect
    .poll(() =>
      popup.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return (
          rect.left >= 0 &&
          rect.right <= innerWidth &&
          rect.top >= 0 &&
          rect.bottom <= innerHeight
        );
      }),
    )
    .toBe(true);
  await page.keyboard.press(`${modifier}+0`);
  await scale(page, 1);
  await expect(search).toHaveValue("grinning");
  await expect(search).toBeFocused();
  await expect(emoji).toHaveCSS("width", "40px");
  await expect(selected).toHaveAttribute("aria-label", chosen);
  await search.press("Enter");
  await expect(composer).toHaveJSProperty(
    "value",
    `Keep this draft ${chosen} `,
  );
  await expect(composer).toBeFocused();
  await button(page, "Emoji and GIFS").click();
  await search.fill("grinning");
  // Establish a selected query range; Mart owns arrow keys for result navigation.
  await search.evaluate((input) => {
    input.setSelectionRange(0, 2);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(selected).toHaveCount(0);
  const range = () =>
    search.evaluate((input) => [input.selectionStart, input.selectionEnd]);
  await expect.poll(range).toEqual([0, 2]);
  await page.keyboard.press(`${modifier}+=`);
  await scale(page, 1.1);
  await expect
    // The old vendor node is briefly absent during the geometry rebuild.
    .poll(async () => (await emoji.boundingBox())?.width)
    .toBeCloseTo(44, 1);
  await expect(search).toBeFocused();
  await expect.poll(range).toEqual([0, 2]);
  await page.keyboard.type("gr");
  await expect(search).toHaveValue("grinning");
  await expect.poll(range).toEqual([2, 2]);
  await search.press("Escape");
  await expect(composer).toHaveJSProperty(
    "value",
    `Keep this draft ${chosen} `,
  );
});

async function wheelToScaledHistoryTop(page, history, messageIds) {
  const position = () =>
    history.evaluate((element, ids) => {
      const { top, bottom } = element.getBoundingClientRect();
      const row = [...element.querySelectorAll("[data-message-id]")].find(
        (row) => {
          const bounds = row.getBoundingClientRect();
          return bounds.bottom > top && bounds.top < bottom;
        },
      );
      const index = ids.indexOf(row?.dataset.messageId);
      if (index === -1 && element.scrollTop >= 4)
        throw new Error("No visible scaled-history message below the top");
      return {
        scrollTop: element.scrollTop,
        index,
        inset: row ? row.getBoundingClientRect().top - top : 0,
      };
    }, messageIds);

  await history.hover();
  let current = await position();
  if (current.scrollTop < 4) {
    // A wheel at the top can request older history without moving the list.
    await page.mouse.wheel(0, -Math.max(1, current.scrollTop));
    await settle(page, history);
  }
  // Row measurement can increase scrollTop while the reader moves up. Keep
  // stepping within the journey's deadline while the visible position advances.
  while (current.scrollTop >= 4) {
    const before = current;
    await wheel(page, -Math.min(2000, before.scrollTop), history);
    current = await position();
    if (current.scrollTop >= 4) {
      expect(
        current.index === before.index
          ? current.inset - before.inset
          : before.index - current.index,
        "wheel moves toward older scaled-history messages",
      ).toBeGreaterThan(0);
    }
  }
  expect(
    await history.evaluate((element) => element.scrollTop),
    "wheel reaches the physical top of scaled history",
  ).toBeLessThan(4);
}

test.describe("scaled history", () => {
  test.use({ historyCounts: { alpha: 21, beta: 0 } });
  // Twenty rows fill one page; the extra row proves the virtualized paging edge.
  // Real layout and pointer coordinates cannot be established by a DOM emulator.
  test("interface zoom keeps timeline paging and sidebar resizing usable", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const modifier = await mod(page);
    for (let i = 0; i < 10; i++) await page.keyboard.press(`${modifier}+=`);
    await scale(page, 2);
    await settle(page);
    const history = page.getByRole("region", {
      name: "Channel message history",
    });
    const older = history.getByRole("button", {
      name: "Load older messages",
      exact: true,
    });
    await expect(older).toHaveCSS("min-height", "80px");
    expect(
      await older.evaluate(
        (el) => el.parentElement.getBoundingClientRect().height,
      ),
    ).toBe(112);
    const sidebar = page.getByRole("complementary", {
      name: "Sidebar",
      exact: true,
    });
    const handle = page.getByRole("separator", {
      name: "Resize sidebar",
    });
    const before = await sidebar.boundingBox();
    const grip = await handle.boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      grip.x + grip.width / 2 + 100,
      grip.y + grip.height / 2,
    );
    await page.mouse.up();
    await expect
      .poll(async () => (await sidebar.boundingBox()).width)
      .toBeCloseTo(before.width + 100, 0);
    await settle(page);
    const messages = app.histories.get("primary/alpha");
    // Paging starts before the wheel reaches the top. Hold the relay reader's
    // 10s timer with its response while native scrolling and layout settle.
    const readDeadlines = await page.evaluateHandle(() => {
      const schedule = window.setTimeout;
      const cancel = window.clearTimeout;
      const deferred = new Map();
      const resumed = new Map();
      let nextId = 0;
      window.setTimeout = (callback, delay, ...args) => {
        if (delay !== 10_000 || typeof callback !== "function")
          return schedule.call(window, callback, delay, ...args);
        deferred.set(--nextId, () => callback.apply(window, args));
        return nextId;
      };
      window.clearTimeout = (id) => {
        if (deferred.delete(id)) return;
        cancel.call(window, resumed.get(id) ?? id);
        resumed.delete(id);
      };
      return () => {
        window.setTimeout = schedule;
        for (const [id, callback] of deferred) {
          const timer = schedule.call(
            window,
            () => {
              resumed.delete(id);
              callback();
            },
            10_000,
          );
          resumed.set(id, timer);
        }
        deferred.clear();
      };
    });
    try {
      await wheelToScaledHistoryTop(
        page,
        history,
        messages.map(({ id }) => id),
      );
      await expect.poll(() => app.pending.length).toBe(1);
      const loading = history.getByRole("button", {
        name: "Loading older…",
        exact: true,
      });
      await expect(loading).toBeInViewport();
      expect(
        await loading.evaluate((el) => {
          const control = el.getBoundingClientRect();
          const edge = el.parentElement.getBoundingClientRect();
          return control.top >= edge.top && control.bottom <= edge.bottom;
        }),
      ).toBe(true);
    } finally {
      app.pending.shift()?.release();
      await readDeadlines.evaluate((resume) => resume());
      await readDeadlines.dispose();
    }
    await expect(
      history.getByRole("button", { name: "Loading older…", exact: true }),
    ).toHaveCount(0);
    await expect(
      history.locator(`[data-message-id="${messages[0].id}"]`),
    ).toBeVisible();
  });
});

test("independent plugin consumes injected shortcuts; disable/re-enable and editor guards work", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const modifier = await mod(page);
  await openPage(page, "Shortcut counter");
  const count = page.getByRole("main").getByRole("status");
  await expect(count).toHaveText("Shortcut count: 0");
  await page.keyboard.press(`${modifier}+Shift+g`);
  await expect(count).toHaveText("Shortcut count: 1");
  const input = page.getByRole("textbox", { name: "Shortcut typing guard" });
  await input.fill("Keep typing");
  await page.keyboard.press(`${modifier}+Shift+g`);
  await expect(count).toHaveText("Shortcut count: 1");
  await page.evaluate(() => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    const input = document.createElement("input");
    root.append(input);
    input.focus();
  });
  await page.keyboard.press(`${modifier}+Shift+g`);
  await expect(count).toHaveText("Shortcut count: 1");
  // Core zoom explicitly opts into editable targets, including Shadow DOM.
  await page.keyboard.press(`${modifier}+=`);
  await scale(page, 1.1);
  await page.keyboard.press(`${modifier}+0`);
  await scale(page, 1);
  await button(page, "Search Buzz").click();
  await page.keyboard.press(`${modifier}+Shift+g`);
  // Base UI hides the background from assistive technology while modal.
  await expect(
    page
      .getByRole("main", { includeHidden: true })
      .getByRole("status", { includeHidden: true }),
  ).toHaveText("Shortcut count: 1");
  await page.keyboard.press("Escape");
  // Dismissal and focus restoration finish asynchronously. The host correctly
  // suppresses Settings while a closing modal still owns the keyboard.
  await expect(
    page.getByRole("dialog", { name: "Search Buzz", includeHidden: true }),
  ).toHaveCount(0);
  await expect(button(page, "Search Buzz")).toBeFocused();
  await page.keyboard.press(`${modifier}+,`);
  await button(page, "Manage plugins").click();
  const toggle = pluginAction(page, "Shortcut counter");
  await toggle.click();
  // Search Buzz lives in the workspace, which is inert behind Settings.
  await closeSettings(page);
  const choices = await pageChoices(page, "Settings");
  await expect(pageChoice(choices, "Settings")).toBeVisible();
  await page
    .getByRole("combobox", { name: "Search Buzz", exact: true })
    .fill("Shortcut counter");
  await expect(pageChoice(choices, "Shortcut counter")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Search Buzz", includeHidden: true }),
  ).toHaveCount(0);
  await page.keyboard.press(`${modifier}+Shift+g`);
  await page.keyboard.press(`${modifier}+,`);
  await selectSettingsSection(page, "Manage plugins");
  await toggle.click();
  await closeSettings(page);
  await openPage(page, "Shortcut counter");
  await expect(count).toHaveText("Shortcut count: 0");
  await page.keyboard.press(`${modifier}+Shift+g`);
  await expect(count).toHaveText("Shortcut count: 1");
});

test("a shadow-root modal blocks Settings and plugin bindings but allows interface zoom", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const modifier = await mod(page);
  await openPage(page, "Shortcut counter");
  await page.evaluate(() => {
    const host = document.createElement("div");
    host.id = "shadow-modal";
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    const dialog = document.createElement("dialog");
    const control = document.createElement("button");
    control.textContent = "Modal control";
    dialog.append(control);
    root.append(dialog);
    dialog.showModal();
    control.focus();
  });
  const control = button(page, "Modal control");
  await expect(control).toBeFocused();
  await page.keyboard.press(`${modifier}+,`);
  await expect(control).toBeFocused();
  await expect(
    page.getByRole("dialog", {
      name: "Settings",
      exact: true,
      includeHidden: true,
    }),
  ).toHaveCount(0);
  await page.keyboard.press(`${modifier}+Shift+g`);
  await expect(page.getByRole("main").getByRole("status")).toHaveText(
    "Shortcut count: 0",
  );
  await page.keyboard.press(`${modifier}+=`);
  await scale(page, 1.1);
  await page.keyboard.press(`${modifier}+0`);
  await scale(page, 1);
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.getElementById("shadow-modal").remove());
  await page.getByRole("main").focus();
  await page.keyboard.press(`${modifier}+Shift+g`);
  await expect(page.getByRole("main").getByRole("status")).toHaveText(
    "Shortcut count: 1",
  );
});

test("Settings → Shortcuts rebinds a plugin shortcut live, blocks host conflicts, persists and resets", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const modifier = await mod(page);
  const spokenModifiers =
    modifier === "Meta" ? "Shift Command" : "Control Shift";
  const title = "Increment shortcut counter";
  await openPage(page, "Shortcut counter");
  const count = page.getByRole("main").getByRole("status");
  await expect(count).toHaveText("Shortcut count: 0");
  await page.keyboard.press(`${modifier}+Shift+g`);
  await expect(count).toHaveText("Shortcut count: 1");
  await page.keyboard.press(`${modifier}+,`);
  await button(page, "Shortcuts").click();
  const region = page.getByRole("region", { name: "Shortcuts", exact: true });
  await expect(
    region.getByRole("heading", { name: "Shortcut counter", exact: true }),
  ).toBeVisible();
  await expect(
    region.getByRole("article", { name: "Go back", exact: true }),
  ).toHaveCount(1);
  await expect(
    region.getByRole("article", { name: "Go forward", exact: true }),
  ).toHaveCount(1);
  const row = region.getByRole("article", { name: title });
  await expect(
    row.getByText(`${spokenModifiers} G`, { exact: true }),
  ).toBeAttached();
  await button(row, `Change shortcut for ${title}`).click();
  const listening = page.getByRole("textbox", {
    name: `New shortcut for ${title}`,
  });
  await expect(listening).toBeFocused();
  // The chord being listened for goes to the capture control, not the dispatcher.
  await page.keyboard.press(`${modifier}+k`);
  await expect(row.getByRole("alert")).toContainText("Search Buzz");
  await expect(
    page.getByRole("dialog", { name: "Search Buzz", includeHidden: true }),
  ).toHaveCount(0);
  await expect(listening).toBeFocused();
  await page.keyboard.press(`${modifier}+Shift+u`);
  await expect(listening).toHaveCount(0);
  await expect(row.getByText("Modified")).toBeVisible();
  await expect(
    row.getByText(`${spokenModifiers} U`, { exact: true }),
  ).toBeAttached();
  await expect(button(row, `Reset shortcut for ${title}`)).toBeVisible();
  await expect(button(row, `Change shortcut for ${title}`)).toBeFocused();
  await closeSettings(page);
  await openPage(page, "Shortcut counter");
  await expect(count).toHaveText("Shortcut count: 1");
  await page.keyboard.press(`${modifier}+Shift+g`);
  await page.keyboard.press(`${modifier}+Shift+u`);
  await expect(count).toHaveText("Shortcut count: 2");
  await page.reload();
  await openPage(page, "Shortcut counter");
  await expect(count).toHaveText("Shortcut count: 0");
  await page.keyboard.press(`${modifier}+Shift+u`);
  await expect(count).toHaveText("Shortcut count: 1");
  await page.keyboard.press(`${modifier}+,`);
  await button(page, "Shortcuts").click();
  await button(row, `Reset shortcut for ${title}`).click();
  await expect(row.getByText("Modified")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Reset all shortcuts", exact: true }),
  ).toBeDisabled();
  await closeSettings(page);
  await openPage(page, "Shortcut counter");
  await page.keyboard.press(`${modifier}+Shift+u`);
  await page.keyboard.press(`${modifier}+Shift+g`);
  await expect(count).toHaveText("Shortcut count: 2");
});

// Browser-only: actual Settings gutters, flex wrapping and keyboard focus paint
// cannot be established by jsdom. Reuse one app for the layout/theme samples.
test("shortcut capture keeps its title and keyboard focus visible, with neutral notices and a Tab exit", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  const modifier = await mod(page);
  await button(page, "Search Buzz").waitFor();
  await page.keyboard.press(`${modifier}+,`);
  await button(page, "Shortcuts").click();
  const row = page.getByRole("article", { name: "Open Settings", exact: true });
  const change = button(row, "Change shortcut for Open Settings");
  const input = row.getByRole("textbox", {
    name: "New shortcut for Open Settings",
  });
  const title = row.getByRole("heading", {
    name: "Open Settings",
    exact: true,
  });
  for (const mode of ["light", "dark"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    for (const width of [390, 800, 1280]) {
      await page.setViewportSize({ width, height: 950 });
      for (const scale of [1, 2]) {
        await page.evaluate(
          (scale) =>
            document.documentElement.style.setProperty(
              "--buzz-text-scale",
              String(scale),
            ),
          scale,
        );
        // Enter capture through real keyboard navigation, not a pointer click.
        await change.focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        await expect(change).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(input).toBeFocused();
        await expect(input).toHaveCSS("outline-style", "solid");
        await expect(input).toHaveCSS("outline-width", "2px");
        await expect(input).toHaveAccessibleDescription(
          /Press Escape to cancel/,
        );
        const focusColor = await input.evaluate((element) => {
          const probe = document.createElement("span");
          probe.style.color = "var(--border-focus)";
          element.parentElement.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        });
        await expect(input).toHaveCSS("outline-color", focusColor);
        await page.evaluate(() => document.fonts.ready);
        const headingBox = await title.boundingBox();
        const inputBox = await input.boundingBox();
        const rowBox = await row.boundingBox();
        const textBoxes = await title.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return [...range.getClientRects()].map(({ x, y, width, height }) => ({
            x,
            y,
            width,
            height,
          }));
        });
        for (const box of textBoxes) {
          expect(box.x + box.width).toBeLessThanOrEqual(
            headingBox.x + headingBox.width + 1,
          );
          expect(
            box.y + box.height <= inputBox.y || box.x + box.width <= inputBox.x,
          ).toBe(true);
        }
        expect(
          headingBox.y + headingBox.height <= inputBox.y ||
            headingBox.x + headingBox.width <= inputBox.x,
        ).toBe(true);
        for (const box of [
          inputBox,
          await button(row, "Cancel changing Open Settings").boundingBox(),
        ]) {
          expect(box.x).toBeGreaterThanOrEqual(rowBox.x);
          expect(box.x + box.width).toBeLessThanOrEqual(
            rowBox.x + rowBox.width,
          );
        }
        // A rejected chord stays in capture, announces why, and stays neutral.
        await page.keyboard.press(`${modifier}+k`);
        const alert = row.getByRole("alert");
        await expect(alert).toContainText("already used by Search Buzz");
        await expect(input).toHaveAccessibleDescription(
          /already used by Search Buzz/,
        );
        await expect(alert).toHaveCSS(
          "color",
          await title.evaluate((el) => getComputedStyle(el).color),
        );
        if (scale === 1)
          await page.screenshot({
            path: testInfo.outputPath(`capture-${mode}-${width}.png`),
          });
        await page.keyboard.press("Tab");
        await expect(input).toHaveCount(0);
        await expect(change).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(input).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(change).toBeFocused();
      }
    }
    await page.keyboard.press("Enter");
    await expect(input).toBeFocused();
    await page.keyboard.press(`${modifier}+z`);
    await expect(row.getByRole("alert")).toContainText(
      "message editor handles",
    );
    await expect(row.getByRole("alert")).toHaveCSS(
      "color",
      await title.evaluate((el) => getComputedStyle(el).color),
    );
    await button(row, "Reset shortcut for Open Settings").click();
  }
});
