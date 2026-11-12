import {
  chooseColorMode,
  closeSettings,
  openSettings,
  selectSettingsSection,
  settingsDialog,
  settingsSections,
  settleShellToggle,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { stopRoutes } from "./playwright-test.mjs";
import { open, anchor, expectAnchor, upper, settle } from "./timeline.mjs";
import { wcagRatio } from "../../scripts/design-system/apca.mjs";

test.use({ historyCounts: { alpha: 20, beta: 1 }, launchAnimation: true });
const key = "buzz-appearance.v1";
const button = (page, name) => page.getByRole("button", { name, exact: true });
async function settings(page) {
  await openSettings(page);
  // Finish the menu-to-dialog focus handoff before testing keyboard controls.
  await expect(button(settingsDialog(page), "Close Settings")).toBeFocused();
  await selectSettingsSection(page, "Appearance");
}
// Reload restores the Settings visit; its modal reopens with its own focus.
async function reopenedSettings(page) {
  await expect(button(settingsDialog(page), "Close Settings")).toBeFocused();
  await selectSettingsSection(page, "Appearance");
}
async function expectMode(page, mode, inSettings = false) {
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
  await expect(page.locator("html")).toHaveCSS("color-scheme", mode);
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    mode === "dark" ? "rgb(16, 16, 16)" : "rgb(241, 241, 242)",
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    mode === "dark" ? /^#101010$/ : /^#f1f1f2$/,
  );
  await expect(page.locator(".shell-background")).toHaveCSS(
    "background-color",
    mode === "dark" ? "rgb(16, 16, 16)" : "rgb(241, 241, 242)",
  );
  await expect(page.locator(".shell-background")).toHaveCSS(
    "background-image",
    /radial-gradient/,
  );
  // Settings keeps its sections inside the modal at every width.
  if (inSettings) {
    await expect(settingsSections(page)).toBeVisible();
    return;
  }
  await settleShellToggle(page);
  const disclosure = button(page, "Show navigation");
  const collapsed = await disclosure.isVisible();
  if (collapsed) await disclosure.click();
  await expect(
    page
      .getByRole("complementary", { name: "Sidebar", exact: true })
      .getByRole("navigation", { name: "Subscribed channels", exact: true }),
  ).toBeVisible();
  if (collapsed) await button(page, "Hide navigation").click();
}

test("Appearance changes and restores both modes, shared keyboard controls, dialogs and narrow layout", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  await expectMode(page, "light");
  await settings(page);
  for (const label of ["Citrus accent color", "Cobalt accent color"]) {
    const swatch = button(page, label);
    await page.mouse.move(0, 0);
    const colors = await swatch.evaluate((node) => {
      const probe = document.createElement("span");
      node.append(probe);
      const colors = {};
      for (const state of ["hover", "pressed"]) {
        probe.style.backgroundColor = `var(--affordance-accent-prominent-${state})`;
        colors[state] = getComputedStyle(probe).backgroundColor;
      }
      probe.remove();
      return colors;
    });
    await swatch.hover();
    await expect(swatch).toHaveCSS("background-color", colors.hover);
    await page.mouse.down();
    try {
      await expect(swatch).toHaveCSS("background-color", colors.pressed);
    } finally {
      await page.mouse.up();
    }
    await page.mouse.move(0, 0);
    await expect(swatch).toHaveAttribute("aria-pressed", "true");
    const selectedColors = await swatch.evaluate((node) => {
      const hex = (value) =>
        "#" +
        value
          .match(/\d+/g)
          .slice(0, 3)
          .map((part) => Number(part).toString(16).padStart(2, "0"))
          .join("");
      return {
        ink: hex(getComputedStyle(node.querySelector("svg")).color),
        fill: hex(getComputedStyle(node).backgroundColor),
      };
    });
    expect(
      wcagRatio(selectedColors.ink, selectedColors.fill),
    ).toBeGreaterThanOrEqual(3);
  }
  await button(page, "Cobalt accent color").focus();
  await page.keyboard.press("Enter");
  await expect(button(page, "Cobalt accent color")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const system = page.getByRole("combobox", { name: "Mode", exact: true });
  await expect(system).toHaveText("System");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectMode(page, "dark", true);
  await page.emulateMedia({ colorScheme: "light" });
  await expectMode(page, "light", true);
  await chooseColorMode(page, "Light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectMode(page, "light", true);
  await system.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("option", { name: "Light", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("option", { name: "Dark", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(system).toHaveText("Dark");
  await expect(system).toBeFocused();
  await expectMode(page, "dark", true);
  await expect(
    page
      .getByRole("navigation", { name: "Settings sections", exact: true })
      .getByRole("button", { name: "Notifications", exact: true }),
  ).toHaveCSS(
    "color",
    await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--text-navigation)";
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }),
  );
  // Sidebar selection keeps a strong accent independently of bubble contrast.
  await expect(button(page, "Appearance")).toHaveCSS(
    "background-color",
    await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--surface-sidebar-selected)";
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    }),
  );
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
    "dark",
  );
  const palettes = {};
  for (const mode of ["dark", "light"]) {
    await chooseColorMode(page, mode === "dark" ? "Dark" : "Light");
    await expectMode(page, mode, true);
    // Dots must follow a tinted shell, not keep a separately authored gray.
    // Use browser paint to measure resolved CSS colors (including color-mix).
    const texture = await page.evaluate((mode) => {
      const root = document.documentElement;
      const previous = root.style.getPropertyValue("--bg-app");
      const priority = root.style.getPropertyPriority("--bg-app");
      const probe = document.createElement("span");
      document.body.append(probe);
      const context = document.createElement("canvas").getContext("2d");
      if (!context) throw new Error("Canvas color measurement unavailable");
      const rgb = (role) => {
        probe.style.color = `var(${role})`;
        context.fillStyle = getComputedStyle(probe).color;
        context.fillRect(0, 0, 1, 1);
        return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
      };
      try {
        root.style.setProperty(
          "--bg-app",
          mode === "light" ? "#eeddee" : "#221122",
        );
        return { shell: rgb("--bg-app"), dots: rgb("--texture-dots-color") };
      } finally {
        if (previous) root.style.setProperty("--bg-app", previous, priority);
        else root.style.removeProperty("--bg-app");
        probe.remove();
      }
    }, mode);
    // Both samples are purple: equal red/blue, less green. The texture must
    // retain that hue and move lighter/darker together, not turn neutral.
    expect(texture.dots[0]).toBe(texture.dots[2]);
    expect(texture.dots[0]).toBeGreaterThan(texture.dots[1]);
    for (const [channel, value] of texture.dots.entries()) {
      if (mode === "light") expect(value).toBeLessThan(texture.shell[channel]);
      else expect(value).toBeGreaterThan(texture.shell[channel]);
    }
    // Preview artwork uses the real mode's roles, even inside the other mode.
    palettes[mode] = await page.evaluate(() => {
      const probe = document.createElement("span");
      document.body.append(probe);
      const colors = Object.fromEntries(
        ["bg-app", "surface-panel", "text-metadata", "surface-message-own"].map(
          (role) => {
            probe.style.color = `var(--${role})`;
            return [role, getComputedStyle(probe).color];
          },
        ),
      );
      probe.remove();
      return colors;
    });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      // Narrow Settings stacks its sections above the detail; choosing a
      // section brings that detail into view.
      await selectSettingsSection(page, "Appearance");
      await expect(
        page.getByRole("region", { name: "Appearance", exact: true }),
      ).toBeInViewport();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      await page.screenshot({
        path: testInfo.outputPath(`appearance-${mode}-${width}.png`),
      });
    }
    // The workspace behind Settings is inert; search from the workspace.
    await closeSettings(page);
    await button(page, "Search Buzz").click();
    const dialog = page.getByRole("dialog", { name: "Search Buzz" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS(
      "background-color",
      mode === "dark" ? "rgb(26, 26, 26)" : "rgb(255, 255, 255)",
    );
    await expect(dialog).toHaveCSS("backdrop-filter", "none");
    await page.keyboard.press("Escape");
    await settings(page);
  }
  const preview = page.getByRole("figure", { name: "Appearance preview" });
  for (const hostMode of ["Dark", "Light"]) {
    await chooseColorMode(page, hostMode);
    const colors = palettes[hostMode.toLowerCase()];
    await expect(preview).toBeVisible();
    await expect(preview.locator("[inert]")).toHaveCount(1);
    await expect(preview).toHaveCSS(
      "background-color",
      colors["surface-panel"],
    );
    await expect(preview.locator("[data-own]")).toHaveCSS(
      "background-color",
      colors["surface-message-own"],
    );
  }
  await button(page, "Magenta accent color").click();
  const pink = await button(page, "Magenta accent color").evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--surface-message-own)";
    el.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
  await expect(preview.locator("[data-own]")).toHaveCSS(
    "background-color",
    pink,
  );
  await page
    .getByRole("region", { name: "Appearance", exact: true })
    .screenshot({
      path: testInfo.outputPath("appearance-pink-preview.png"),
    });
  await chooseColorMode(page, "Dark");
  await page.reload();
  await expectMode(page, "dark", true);
  await reopenedSettings(page);
  await expect(system).toHaveText("Dark");
});

// Browser-only boundary: real CSS cascade and pre-paint bootstrap cannot
// be established in jsdom.
test("saved vibe levels cannot tint the shell after choosing an accent or reloading", async ({
  page,
  app,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-color-level.v1", "full"),
  );
  await page.goto(app.origin);
  await settings(page);
  for (const mode of ["Light", "Dark"]) {
    await chooseColorMode(page, mode);
    await button(page, "Cobalt accent color").click();
    await expectMode(page, mode.toLowerCase(), true);
    await page.reload();
    await expect(button(page, "Cobalt accent color")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expectMode(page, mode.toLowerCase(), true);
    await expect(page.getByRole("slider", { name: "Vibe level" })).toHaveCount(
      0,
    );
  }
});

test("System appearance follows computer changes and keeps the selected choice after reload", async ({
  page,
  app,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(app.origin);
  await settings(page);
  const system = page.getByRole("combobox", { name: "Mode", exact: true });
  await chooseColorMode(page, "Dark");
  await chooseColorMode(page, "System");
  await expect(system).toHaveText("System");
  await expectMode(page, "light", true);
  await page.screenshot({ path: testInfo.outputPath("system-light.png") });
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
    "system",
  );
  await page.emulateMedia({ colorScheme: "dark" });
  await expectMode(page, "dark", true);
  await page.reload();
  await expectMode(page, "dark", true);
  await reopenedSettings(page);
  await expect(system).toHaveText("System");
  await page.screenshot({ path: testInfo.outputPath("system-dark.png") });
  await page.emulateMedia({ colorScheme: "light" });
  await expectMode(page, "light", true);
  await chooseColorMode(page, "Dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expectMode(page, "dark", true);
});

test("storage denial is visible and retryable; another window updates a live conversation without remount", async ({
  page,
  context,
  app,
}, testInfo) => {
  await open(page, app);
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await composer.fill("Unsent appearance draft");
  const before = await anchor(page);
  const node = await composer.elementHandle();
  await button(page, "Emoji and GIFS").click();
  const emojiSearch = page.getByRole("searchbox", {
    name: "Search emoji",
    exact: true,
  });
  await emojiSearch.fill("grinning");
  const emojiNode = await emojiSearch.elementHandle();
  await expect(page.locator("em-emoji-picker #root")).toHaveAttribute(
    "data-theme",
    "light",
  );
  const other = await context.newPage();
  try {
    await other.goto(app.origin);
    await settings(other);
    const settingsSessions = app.report.sessions.length;
    await other.evaluate((key) => {
      const original = Storage.prototype.setItem;
      window.restoreStorage = () => {
        Storage.prototype.setItem = original;
      };
      Storage.prototype.setItem = function (k, v) {
        if (k === key) throw new DOMException("denied", "QuotaExceededError");
        return original.call(this, k, v);
      };
    }, key);
    await chooseColorMode(other, "Dark");
    await expectMode(other, "dark", true);
    await expect(
      other.getByRole("dialog", {
        name: "Appearance wasn’t saved",
        exact: true,
      }),
    ).toContainText("could not be saved");
    await expectMode(page, "light");
    await button(other, "Notifications").click();
    await expect(
      other.getByRole("dialog", {
        name: "Appearance wasn’t saved",
        exact: true,
      }),
    ).toHaveCount(0);
    await button(other, "Appearance").click();
    await expect(
      other.getByRole("dialog", {
        name: "Appearance wasn’t saved",
        exact: true,
      }),
    ).toHaveCount(1);
    await other.evaluate(() => window.restoreStorage());
    await button(other, "Retry saving appearance").click();
    await expect(
      other.getByRole("dialog", {
        name: "Appearance wasn’t saved",
        exact: true,
      }),
    ).toHaveCount(0);
    await expectMode(page, "dark");
    await expect(page.locator("em-emoji-picker #root")).toHaveAttribute(
      "data-theme",
      "dark",
    );
    await expect(emojiSearch).toHaveValue("grinning");
    expect(await emojiNode.evaluate((el) => el.isConnected)).toBe(true);
    await expect(composer).toHaveJSProperty("value", "Unsent appearance draft");
    expect(await node.evaluate((el) => el.isConnected)).toBe(true);
    await expectAnchor(page, before);
    // Settings may acquire its captured community profile; a mode change must not
    // create another relay session after the destination is ready.
    expect(app.report.sessions.length).toBe(settingsSessions);
    await page.screenshot({ path: testInfo.outputPath("messages-dark.png") });
    await chooseColorMode(other, "Light");
    await expectMode(page, "light");
    await expect(page.locator("em-emoji-picker #root")).toHaveAttribute(
      "data-theme",
      "light",
    );
    await emojiSearch.press("Escape");
    await expectAnchor(page, before);
    await page.screenshot({ path: testInfo.outputPath("messages-light.png") });
  } finally {
    await other.close();
  }
});

test("saved dark document paints before the application module is allowed to execute", async ({
  page,
  app,
}) => {
  const relayRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/relay/"))
      relayRequests.push(request.url());
  });
  // Seed only persisted input before the first document. Booting a live app
  // just to save this preference races its pending relay reads against goto.
  await page.addInitScript((key) => localStorage.setItem(key, "dark"), key);
  // Completing a no-op module keeps React from executing without leaving a
  // pending script request. WebKit stalls animation frames when that pending
  // request coexists with @font-face rules, even after styles are computed.
  // Only the entry is withheld: a modulepreloaded shared chunk served empty
  // would poison WebKit's module map for the reload below.
  await page.route(/\/assets\/index-[^/]*\.js$/, (route) =>
    route.fulfill({
      contentType: "application/javascript",
      headers: { "cache-control": "no-store" },
      body: "/* Application execution deliberately withheld. */",
    }),
  );
  try {
    await page.goto(app.origin, { waitUntil: "commit" });
    await expect(page.locator("html")).toHaveAttribute(
      "data-color-mode",
      "dark",
    );
    await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
    await expect(page.locator("html")).toHaveCSS(
      "background-color",
      "rgb(16, 16, 16)",
    );
    await expect(page.locator("#buzz-launch")).toBeVisible();
    await expect(page.locator("#buzz-launch img")).toBeVisible();
    // Observe the painted document for two frames with the entire React bundle still withheld.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(page.locator("html")).toHaveCSS(
      "background-color",
      "rgb(16, 16, 16)",
    );
    // Pre-paint coverage must never start (then tear down) a relay session.
    expect(relayRequests).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: "wait" });
  }
  await page.reload();
  await expect(button(page, "Your profile")).toBeVisible();
  await expectMode(page, "dark");
});

test("production startup owns keyboard modality", async ({
  page,
  app,
  browserName,
}) => {
  await page.goto(app.origin);
  await button(page, "Your profile").click();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-keyboard-navigation",
  );
  await page.keyboard.press(
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-keyboard-navigation",
    "",
  );
  await page.mouse.click(2, 2);
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-keyboard-navigation",
  );
});

test("compiled host preserves compatibility utility meanings", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  // Diagnostic nodes use the production stylesheet, not fixture-generated CSS.
  // Opposing inherited color prevents a missing text utility from passing.
  await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.id = "style-contract";
    probe.innerHTML = `<code id="old-code">Old code</code><span id="old-mono" class="font-mono">Old mono</span><div data-buzz-ui><code id="new-mono" class="font-mono">New mono</code><div class="text-secondary"><span id="primary-text" class="text-primary">Text</span></div><div id="primary-border" class="border border-primary">Border</div></div><button id="old-primary" class="bg-primary text-on-primary rounded-xl hover:bg-primary-hover">Old primary</button>`;
    document.body.append(probe);
  });
  for (const mode of ["Light", "Dark"]) {
    await settings(page);
    await chooseColorMode(page, mode);
    await expect(page.locator("#primary-text")).toHaveCSS(
      "color",
      mode === "Light" ? "rgb(15, 15, 15)" : "rgb(255, 255, 255)",
    );
    await expect(page.locator("#primary-border")).toHaveCSS(
      "border-top-color",
      mode === "Light" ? "rgb(232, 232, 232)" : "rgb(51, 51, 51)",
    );
    // The legacy fill keeps meaning "prominent", with neutral shared controls.

    await expect(page.locator("#old-primary")).toHaveCSS(
      "background-color",
      await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.backgroundColor = "var(--affordance-prominent)";
        document.body.append(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      }),
    );
    const legacy = await page.locator("#old-primary").evaluate((node) => {
      const style = getComputedStyle(node);
      const hex = (color) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d");
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return (
          "#" +
          [...context.getImageData(0, 0, 1, 1).data]
            .slice(0, 3)
            .map((v) => v.toString(16).padStart(2, "0"))
            .join("")
        );
      };
      return { ink: hex(style.color), fill: hex(style.backgroundColor) };
    });
    expect(
      wcagRatio(legacy.ink, legacy.fill),
      `legacy primary ink in ${mode}`,
    ).toBeGreaterThanOrEqual(4.5);
    await expect(page.locator("#old-primary")).toHaveCSS(
      "border-radius",
      "20px",
    );
    for (const id of ["old-code", "old-mono"]) {
      await expect(page.locator(`#${id}`)).toHaveCSS(
        "font-family",
        /ui-monospace/,
      );
      await expect(page.locator(`#${id}`)).toHaveCSS(
        "font-family",
        /JetBrains Mono/,
      );
    }
    await expect(page.locator("#new-mono")).toHaveCSS(
      "font-family",
      /JetBrains Mono/,
    );
    await closeSettings(page);
  }
});

test("Message width defaults to Narrow, widens the conversation by 50%, and restores", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 2000, height: 1000 });
  await open(page, app);
  const row = page
    .locator(
      '[data-channel-timeline="alpha"] [data-message-id] > [data-layout]',
    )
    .first();
  const rowWidth = () =>
    row.evaluate((node) => node.getBoundingClientRect().width);
  const narrow = await rowWidth();
  await settings(page);
  const choice = page.getByRole("combobox", {
    name: "Message width",
    exact: true,
  });
  await expect(choice).toHaveText("Narrow");
  const previewColumn = page
    .getByRole("figure", { name: "Appearance preview" })
    .locator("[data-message-width]");
  const previewWidth = () =>
    previewColumn.evaluate((node) => node.getBoundingClientRect().width);
  const narrowPreview = await previewWidth();
  await choice.click();
  await page.getByRole("option", { name: "Wide", exact: true }).click();
  await expect(choice).toHaveText("Wide");
  await expect.poll(previewWidth).toBeCloseTo(narrowPreview * 1.5, 0);
  await closeSettings(page);
  await expect.poll(rowWidth).toBe(narrow * 1.5);
  await page.reload();
  await expect(row).toBeVisible();
  await expect.poll(rowWidth).toBe(narrow * 1.5);
  await settings(page);
  await expect(choice).toHaveText("Wide");
  await closeSettings(page);
  await page.setViewportSize({ width: 480, height: 900 });
  await expect.poll(rowWidth).toBeLessThanOrEqual(480);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(480);
});

test.describe("message width reading position", () => {
  test.use({
    historyCounts: { alpha: 60, beta: 1 },
    markdownMessages: true,
    productionBroker: true,
  });

  test("preserves wrapped history through Settings and another window", async ({
    page,
    context,
    app,
  }) => {
    await page.setViewportSize({ width: 2200, height: 1000 });
    await open(page, app);
    const saved = await upper(page);
    const history = page.getByRole("region", {
      name: "Channel message history",
    });
    const viewportWidth = await history.evaluate(
      (element) => element.clientWidth,
    );
    const chooseWidth = async (target, width) => {
      await target
        .getByRole("combobox", { name: "Message width", exact: true })
        .click();
      await target.getByRole("option", { name: width, exact: true }).click();
    };

    await settings(page);
    await chooseWidth(page, "Wide");
    await closeSettings(page);
    await settle(page);
    expect(await history.evaluate((element) => element.clientWidth)).toBe(
      viewportWidth,
    );
    await expectAnchor(page, saved);

    const other = await context.newPage();
    try {
      await other.goto(app.origin);
      await settings(other);
      await chooseWidth(other, "Narrow");
      await expect(page.locator("html")).toHaveCSS(
        "--buzz-message-width",
        "52rem",
      );
      await settle(page);
      await expectAnchor(page, saved);
      await chooseWidth(other, "Wide");
      await expect(page.locator("html")).toHaveCSS(
        "--buzz-message-width",
        "78rem",
      );
      await settle(page);
      await expectAnchor(page, saved);
    } finally {
      await stopRoutes(context);
      await other.close();
    }
  });
});
