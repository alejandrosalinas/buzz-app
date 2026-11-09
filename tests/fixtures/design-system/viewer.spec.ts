import { expect, test, type Locator } from "@playwright/test";
import { watchPageErrors } from "../../browser/page-errors.mjs";
import { COMPONENTS } from "../../../src/shared/design-system/ui/registry";
import { TABLER_ICONS } from "../../../src/shared/design-system/icons/inventory";

const viewer = "/tests/fixtures/design-system.html";

/**
 * Keyboard focus rings are 2px with a 2px offset, or inset where a scrolling list
 * would clip an outside ring. Outside dialogs,
 * html[data-keyboard-navigation] gates pointer and programmatic focus.
 */
const expectKeyboardRing = async (control: Locator, offset = "2px") => {
  await expect(control).toHaveCSS("outline-style", "solid");
  await expect(control).toHaveCSS("outline-width", "2px");
  await expect(control).toHaveCSS("outline-offset", offset);
};

test("loaded avatar artwork stays mounted through status changes", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/avatar`);
  const group = page.locator(".component-specimen-group").filter({
    has: page.getByRole("heading", { name: "Status transitions" }),
  });
  const artwork = group.locator(".buzz-avatar img");
  await expect(artwork).toHaveAttribute("data-loaded", "true");
  await expect(artwork).toHaveCSS("opacity", "1");
  await artwork.evaluate((image) =>
    image.setAttribute("data-test-instance", "retained"),
  );
  for (const status of ["online", "away", "offline"] as const) {
    await group.getByRole("button", { name: `Set ${status}` }).click();
    await expect(
      group.getByRole("img", { name: `Live agent artwork, ${status}` }),
    ).toBeVisible();
    await expect(artwork).toHaveAttribute("data-test-instance", "retained");
    await expect(artwork).toHaveAttribute("data-loaded", "true");
    await expect(artwork).toHaveCSS("opacity", "1");
  }
  await group.getByRole("button", { name: "Clear status" }).click();
  await expect(
    group.getByRole("img", { name: "Live agent artwork", exact: true }),
  ).toBeVisible();
  await expect(artwork).toHaveAttribute("data-test-instance", "retained");
  await expect(artwork).toHaveAttribute("data-loaded", "true");
  await expect(artwork).toHaveCSS("opacity", "1");
});

test("thinking badge reverses mid-morph and settles at once under reduced motion", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-01T01:00:00Z"));
  await page.goto("/tests/fixtures/design-system/thinking-avatar.html");
  const card = page.getByRole("article", {
    name: "Centered Start pill",
    exact: true,
  });
  const root = card.locator(".badge-pill-root");
  await card.getByRole("button", { name: "Thinking", exact: true }).click();
  await page.clock.runFor(150);
  await expect(root).toHaveAttribute("data-phase", "morphing");
  await card.getByRole("button", { name: "Available", exact: true }).click();
  await page.clock.runFor(320);
  await expect(root).toHaveAttribute("data-phase", "available");

  await card.getByRole("button", { name: "Thinking", exact: true }).click();
  await page.clock.runFor(320);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await card.getByRole("button", { name: "Available", exact: true }).click();
  await page.clock.runFor(20);
  await expect(root).toHaveAttribute("data-phase", "available");
});

test("built viewer loads every specimen and foundation without app connections", async ({
  page,
}) => {
  const failures: string[] = [];
  const sockets: string[] = [];
  const pageErrors = watchPageErrors(page);
  page.on("response", (r) => {
    if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`);
  });
  page.on("websocket", (ws) => sockets.push(ws.url()));
  await page.goto(viewer);
  await expect(
    page.getByRole("heading", { name: "Buzz Design System", exact: true }),
  ).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Design system" });
  for (const component of COMPONENTS) {
    await nav.getByRole("link", { name: component.name, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: component.name, exact: true }).first(),
    ).toBeVisible();
  }
  for (const name of [
    "Color",
    "Token table",
    "Typography",
    "Icons",
    "Spacing",
    "Radius",
    "Elevation",
    "Floating surfaces",
    "Glass",
    "Motion",
    "Base UI backing",
    "Maintaining the system",
    "Design guide",
    "Agent guide",
  ]) {
    await nav.getByRole("link", { name, exact: true }).click();
    await expect(page.locator("main h1")).toBeVisible();
    await page.reload();
    await expect(page.locator("main h1")).toBeVisible();
    if (name === "Token table") {
      // Document width alone misses status text colliding with a swatch.
      for (const mode of ["dark", "light"]) {
        const toggle = page.getByRole("button", { name: `Use ${mode} mode` });
        if (await toggle.count()) await toggle.click();
        for (const width of [390, 800, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          const row = page
            .getByRole("row")
            .filter({ hasText: "bg-affordance-panel-hover" });
          const status = row
            .getByText("proposed", { exact: true })
            .filter({ visible: true });
          await expect(status).toHaveCount(1);
          const swatch = row
            .locator("td")
            .last()
            .locator("[aria-hidden]")
            .first();
          await expect(swatch).toBeVisible();
          await expect
            .poll(async () => {
              const labelBox = await status.boundingBox();
              const swatchBox = await swatch.boundingBox();
              return (
                !!labelBox &&
                !!swatchBox &&
                labelBox.x + labelBox.width <= swatchBox.x
              );
            })
            .toBe(true);
        }
      }
    }
  }
  await expect(
    nav.getByRole("link", { name: /Conversation|Agent work/ }),
  ).toHaveCount(0);
  expect([...pageErrors.unexplained(), ...failures]).toEqual([]);
  expect(sockets).toEqual([]);
});

test("composer documents interactive, pending, failure and narrow states", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/composer`);
  const interactive = page.getByRole("form", { name: "Interactive message" });
  const input = interactive.getByRole("textbox", {
    name: "Interactive message",
  });
  const send = interactive.getByRole("button", { name: "Send message" });

  await expect(send).toBeDisabled();
  await input.fill("Ready to review");
  await expect(send).toBeEnabled();
  await send.click();
  await expect(input).toHaveValue("");
  await expect(interactive.getByRole("status")).toHaveText(
    "Message sent in this local preview.",
  );

  const sending = page.getByRole("form", { name: "Sending message" });
  await expect(sending).toHaveAttribute("aria-busy", "true");
  await expect(
    sending.getByRole("button", { name: "Sending message" }),
  ).toBeDisabled();

  const failed = page.getByRole("form", { name: "Message with error" });
  await expect(failed.getByRole("alert")).toContainText(
    "Custom emoji could not be prepared.",
  );
  await failed.getByRole("button", { name: "Retry" }).click();
  await expect(failed.getByRole("alert")).toHaveCount(0);
  await expect(failed.getByRole("status")).toHaveText(
    "Message preparation recovered.",
  );

  for (const width of [390, 800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(
      page.getByRole("form", { name: "Narrow message" }),
    ).toBeVisible();
  }
});

test("icon inventory is routed, complete, decorative, and responsive", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/icons`);
  await expect(
    page.getByRole("heading", { name: "Icons", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/#\/design\/icons$/);

  const tablerList = page.getByRole("list", {
    name: "Available Tabler icons",
  });
  await expect(tablerList.getByRole("listitem")).toHaveCount(
    TABLER_ICONS.length,
  );
  await expect(page.getByRole("img")).toHaveCount(0);
  await expect(page.locator("main svg:not([aria-hidden='true'])")).toHaveCount(
    0,
  );
  await expect(
    page.getByText("Open GitHub issue", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Microsoft OneDrive link", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("22 × 22px", { exact: true })).toBeVisible();
  await expect(page.getByText("14 × 14px", { exact: true })).toBeVisible();
  // CSS visibility alone misses captions hidden from assistive technology.
  for (const [meaning, caption] of [
    ["Open GitHub issue", "22 × 22px"],
    ["Microsoft OneDrive link", "14 × 14px"],
  ] as const) {
    const example = page
      .getByRole("article")
      .filter({
        has: page.getByRole("heading", { name: meaning, exact: true }),
      })
      .locator(".custom-icon-examples");
    await expect(example).toMatchAriaSnapshot(`- text: ${caption}`);
  }

  for (const width of [390, 800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(tablerList.getByRole("listitem").first()).toBeVisible();
  }
});

test("narrow, intermediate and wide layouts preserve theme and keyboard interaction", async ({
  page,
  browserName,
}) => {
  for (const width of [390, 800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${viewer}#/design/components/button`);
    const toggle = page.getByRole("button", { name: "Use dark mode" });
    if (await toggle.count()) await toggle.click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.getByRole("button", { name: "Use light mode" }).click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  const primary = page.getByRole("button", {
    name: "prominent md",
    exact: true,
  });
  await primary.click();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-keyboard-navigation",
  );
  const tab =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab";
  await page.keyboard.press(tab);
  await expect(
    page.getByRole("button", { name: "prominent lg", exact: true }),
  ).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute(
    "data-keyboard-navigation",
    "",
  );
  await primary.click();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-keyboard-navigation",
  );
  await page.keyboard.press(tab);
  await expect(
    page.getByRole("button", { name: "prominent lg", exact: true }),
  ).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute(
    "data-keyboard-navigation",
    "",
  );
});

test("switch keyboard activation matches pointer state and focus in both modes", async ({
  page,
  browserName,
}) => {
  await page.goto(`${viewer}#/design/components/switch`);
  const switches = page.getByRole("switch", { name: "Show agent activity" });
  const control = switches.nth(0);
  const tab =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab";
  for (const width of [390, 800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const mode of ["light", "dark"]) {
      const toggle = page.getByRole("button", { name: `Use ${mode} mode` });
      if (await toggle.count()) await toggle.click();
      await expect(control).not.toBeChecked();
      await control.click();
      await expect(control).toBeChecked();
      // Pointer activation stays quiet; the keyboard pass below asserts the ring.
      await expect(control).toHaveCSS("outline-style", "none");
      await page.keyboard.press(tab);
      await expect(switches.nth(1)).toBeFocused();
      await page.keyboard.press(`Shift+${tab}`);
      await expect(control).toBeFocused();
      await expectKeyboardRing(control);
      await page.keyboard.press("Space");
      await expect(control).not.toBeChecked();
      await page.keyboard.press("Enter");
      await expect(control).toBeChecked();
      await control.click();
      await expect(control).not.toBeChecked();
    }
  }
});

// A scrolling tab list clips in both axes, so only a real engine can show
// whether the ring it draws survives its own overflow.
test("tab variants keep the whole keyboard focus ring inside their scrolling list", async ({
  page,
  browserName,
}) => {
  await page.goto(`${viewer}#/design/components/tabs`);
  const tab =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab";
  // Arm the modality fact the focus recipes are gated on.
  await page.keyboard.press(tab);
  for (const mode of ["light", "dark"]) {
    const toggle = page.getByRole("button", { name: `Use ${mode} mode` });
    if (await toggle.count()) await toggle.press("Enter");
    const checked: string[] = [];
    for (const [variant, selector, offset] of [
      ["panel", ".buzz-tabs-tab", "2px"],
      ["navigation", ".navigation-item", "-2px"],
      ["chrome", ".buzz-tabs-tab", "2px"],
      ["workspace", ".buzz-tabs-tab", "2px"],
    ] as const) {
      const strip = page
        .locator(`.buzz-tabs[data-variant="${variant}"]`)
        .first();
      if (!(await strip.count())) continue;
      const focused = strip.locator(selector).first();
      // Chromium only matches :focus-visible for a real keyboard arrival, so
      // step out of the strip and Tab back into its active tab.
      await focused.evaluate((element: HTMLElement) => element.focus());
      await page.keyboard.press(`Shift+${tab}`);
      await page.keyboard.press(tab);
      await expect(focused).toBeFocused();
      await expectKeyboardRing(focused, offset);
      // Compare the painted ring against every clipping ancestor it sits in.
      const cuts = await focused.evaluate((element) => {
        const style = getComputedStyle(element);
        const spread =
          Number.parseFloat(style.outlineOffset) +
          Number.parseFloat(style.outlineWidth);
        const box = element.getBoundingClientRect();
        const ring = {
          top: box.top - spread,
          bottom: box.bottom + spread,
          left: box.left - spread,
          right: box.right + spread,
        };
        const found: Record<string, number>[] = [];
        for (
          let node = element.parentElement;
          node;
          node = node.parentElement
        ) {
          const owner = getComputedStyle(node);
          if (
            !/hidden|auto|scroll|clip/.test(owner.overflowX + owner.overflowY)
          )
            continue;
          const edge = node.getBoundingClientRect();
          found.push({
            top: Math.max(0, Math.round(edge.top - ring.top)),
            bottom: Math.max(0, Math.round(ring.bottom - edge.bottom)),
            left: Math.max(0, Math.round(edge.left - ring.left)),
            right: Math.max(0, Math.round(ring.right - edge.right)),
          });
        }
        return found;
      });
      expect(
        cuts.length,
        `${variant} tab has no clipping ancestor`,
      ).toBeGreaterThan(0);
      for (const cut of cuts) {
        expect(cut, `${mode} ${variant} tab ring is clipped`).toEqual({
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
        });
      }
      checked.push(variant);
    }
    // Every documented variant must be measured, or this test proves nothing.
    expect(checked).toEqual(["panel", "navigation", "chrome", "workspace"]);
  }
});

test("disabled switch exposes its state, skips Tab and rejects activation", async ({
  page,
  browserName,
}) => {
  await page.goto(`${viewer}#/design/components/switch`);
  const switches = page.getByRole("switch", { name: "Show agent activity" });
  const disabled = switches.nth(2);
  await expect(disabled).toBeDisabled();
  await expect(disabled).not.toBeChecked();
  await switches.nth(1).click();
  await page.keyboard.press(
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab",
  );
  await expect(disabled).not.toBeFocused();
  await disabled.click({ force: true });
  await disabled.press("Space");
  await disabled.press("Enter");
  await expect(disabled).not.toBeChecked();
});

test("viewer does not replace host styles or appearance ownership", async ({
  page,
  context,
}) => {
  const settings = `/#buzz=${encodeURIComponent(JSON.stringify({ version: 1, kind: "settings" }))}`;
  await page.goto(`http://localhost:1444${settings}`);
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  const readHost = () =>
    page.evaluate(() => ({
      storage: JSON.stringify(
        Object.entries(localStorage)
          .filter(([key]) => key !== "buzz-design-viewer-color-scheme")
          .sort(),
      ),
      mode: document.documentElement.getAttribute("data-color-mode"),
      background: getComputedStyle(document.body).backgroundColor,
      systemToken: getComputedStyle(document.documentElement).getPropertyValue(
        "--purple-9",
      ),
    }));
  const before = await readHost();
  expect(before.systemToken.trim()).toBe("#8e4ec6");
  await page.goto(`http://localhost:1445${settings}`);
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  const sameOriginBefore = await readHost();
  const other = await context.newPage();
  await other.goto(`http://localhost:1445${viewer}`);
  await other.getByRole("button", { name: /Use (dark|light) mode/ }).click();
  expect(await readHost()).toEqual(sameOriginBefore);
  await other.close();
});

test("documentation retains table guidance and storage failure stays usable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error("Storage denied");
    };
    Storage.prototype.setItem = () => {
      throw new Error("Storage denied");
    };
  });
  await page.goto(`${viewer}#/design/design-guide`);
  // A real cell in a real row, so run-on prose or a dropped table both fail.
  const roleRow = page
    .locator("main table tbody tr")
    .filter({ hasText: "Component recipes and product screens." });
  await expect(roleRow.locator("td").first()).toHaveText("Roles");
  await expect(
    page.locator("main table thead th").filter({ hasText: "Layer" }),
  ).toHaveCount(1);
  await expect(page.locator("main")).not.toContainText("|---|");
  // A token is one word: it may sit on its own line, never break across two.
  const split = await page
    .locator("main table code")
    .evaluateAll((nodes) =>
      nodes
        .filter((node) => node.getClientRects().length > 1)
        .map((node) => node.textContent ?? ""),
    );
  expect(split).toEqual([]);
  await expect(page.getByRole("status")).toContainText(
    "Appearance is temporary",
  );
  const before = await page.locator("html").getAttribute("class");
  await page.getByRole("button", { name: /Use (light|dark) mode/ }).click();
  await expect
    .poll(() => page.locator("html").getAttribute("class"))
    .not.toBe(before);
  await expect(page.getByRole("status")).toContainText("Toggle again to retry");
});

test("built component references retain anatomy and fallback identity", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/tabs`);
  const selectedTabRow = page
    .locator("tbody tr")
    .filter({ hasText: "Unselected tab" })
    .first();
  await expect(selectedTabRow).toContainText("text-subtle");
  await expect(selectedTabRow.locator("td")).toHaveCount(6);

  await page.goto(`${viewer}#/design/components/avatar`);
  await expect(page.getByRole("img", { name: "Cynthia Chen" })).toHaveCount(3);
  // Five original image examples plus six status/cutout specimens.
  await expect(page.getByRole("img", { name: "Morgan Martin" })).toHaveCount(
    11,
  );
});

test("a small pane drag settles on release and Escape", async ({ page }) => {
  await page.goto(`${viewer}#/design/components/swap-workspace`);
  const playground = page.getByRole("region", { name: "3 panels playground" });
  const pane = playground.locator('[data-group="One"]');
  const header = pane.locator(".multi-swap-header");

  const dragWithinPane = async (cancel: boolean) => {
    const startTransform = await pane.evaluate(
      (element) => element.style.transform,
    );
    const box = await header.boundingBox();
    if (!box) throw new Error("Missing pane header geometry");
    await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width, box.y + box.height / 2 + 20);
    if (cancel) await page.keyboard.press("Escape");
    else await page.mouse.up();
    await expect
      .poll(() => pane.evaluate((element) => element.style.transform))
      .toBe(startTransform);
    if (cancel) await page.mouse.up();
  };

  await dragWithinPane(false);
  await dragWithinPane(true);
});

test("a stale or renamed link explains itself instead of rendering blank", async ({
  page,
}) => {
  const failures: string[] = [];
  const pageErrors = watchPageErrors(page);
  for (const hash of [
    "#/design/components/renamed-away",
    "#/design/colours",
    "#/design/nope/deeper",
  ]) {
    await page.goto(`${viewer}${hash}`);
    await expect(
      page.getByRole("heading", { name: "Not in the system" }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Design system" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Go to the overview" }).click();
    await expect(
      page.getByRole("heading", { name: "Buzz Design System", exact: true }),
    ).toBeVisible();
  }
  expect([...pageErrors.unexplained(), ...failures]).toEqual([]);
});

test("switch labels activate the control and busy switches preserve focus", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/switch`);
  const control = page
    .getByRole("switch", { name: "Show agent activity" })
    .first();
  await expect(control).not.toBeChecked();
  await page
    .locator("label")
    .filter({ hasText: "Show agent activity" })
    .first()
    .click();
  await expect(control).toBeChecked();
  const busy = page.getByRole("switch", { name: "Enable busy plugin" });
  await expect(busy).toHaveAttribute("aria-disabled", "true");
  await busy.focus();
  await expect(busy).toBeFocused();
  for (const key of ["Space", "Enter"]) {
    await page.keyboard.press(key);
    await expect(busy).toBeChecked();
    await expect(busy).toBeFocused();
  }
  await busy.click({ force: true });
  await expect(busy).toBeChecked();
});

// Native label focus and reset/FormData behavior must agree in real engines.
// Detailed cancellation, controlled state and external form cases live in RTL.
test("textarea labels focus explicit IDs and preserve edits", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/textarea`);
  const textarea = page.getByRole("textbox", {
    name: "Description",
    exact: true,
  });
  await page
    .locator("label")
    .filter({ hasText: /^Description$/ })
    .click();
  await expect(textarea).toBeFocused();
  await textarea.fill("Updated summary");
  await expect(textarea).toHaveValue("Updated summary");
});

test("native form reset keeps choice appearance and submitted values together", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/radio-group`);
  const form = page.getByRole("form", { name: "Notification preferences" });
  const checkbox = form.getByRole("checkbox", { name: "Include a summary" });
  const all = form.getByRole("radio", { name: "All updates" });
  const mentions = form.getByRole("radio", { name: "Mentions only" });
  await checkbox.click();
  await mentions.click();
  await expect(checkbox).not.toBeChecked();
  await expect(mentions).toBeChecked();
  expect(
    await form.evaluate((element) =>
      Object.fromEntries(new FormData(element as HTMLFormElement)),
    ),
  ).toEqual({ notifications: "mentions" });
  await form.getByRole("button", { name: "Reset preferences" }).click();
  await expect(checkbox).toBeChecked();
  await expect(all).toBeChecked();
  await expect(mentions).not.toBeChecked();
  expect(
    await form.evaluate((element) =>
      Object.fromEntries(new FormData(element as HTMLFormElement)),
    ),
  ).toEqual({ notifications: "all", summary: "yes" });
});

test("invalid input and textarea boundaries remain visible in both themes", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/field`);
  for (const mode of ["light", "dark"]) {
    const toggle = page.getByRole("button", { name: `Use ${mode} mode` });
    if (await toggle.count()) await toggle.click();
    const controls = page.getByRole("textbox");
    await expect(controls).toHaveCount(2);
    for (const control of await controls.all()) {
      await expect(control).toHaveAttribute("aria-invalid", "true");
      await expect(control).toHaveCSS("border-top-width", "1px");
      await expect(control).toHaveCSS("border-top-style", "solid");
      await expect(control).toHaveCSS("box-shadow", "none");
      const ratio = await control.evaluate((element) => {
        const style = getComputedStyle(element);
        const luminance = (color: string) => {
          const components = color
            .match(/[\d.]+/g)
            ?.slice(0, 3)
            .map(Number);
          if (components?.length !== 3)
            throw new Error(`Unexpected color ${color}`);
          const linear = components.map((component) => {
            const value = component / 255;
            return value <= 0.04045
              ? value / 12.92
              : ((value + 0.055) / 1.055) ** 2.4;
          });
          const [red = 0, green = 0, blue = 0] = linear;
          return red * 0.2126 + green * 0.7152 + blue * 0.0722;
        };
        const border = luminance(style.borderTopColor);
        const background = luminance(style.backgroundColor);
        return (
          (Math.max(border, background) + 0.05) /
          (Math.min(border, background) + 0.05)
        );
      });
      expect(ratio).toBeGreaterThanOrEqual(3);
    }
  }
});

// These cases verify native reset against actual hidden form inputs, not only ARIA.
test("controlled choices keep the owner's unchanged values after native reset", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/radio-group`);
  const form = page.getByRole("form", { name: "Controlled preferences" });
  const checkbox = form.getByRole("checkbox", { name: "Include a summary" });
  const mentions = form.getByRole("radio", { name: "Mentions only" });
  await checkbox.click();
  await mentions.click();
  await expect(checkbox).toBeChecked();
  await expect(mentions).toBeChecked();
  await form.getByRole("button", { name: "Reset preferences" }).click();
  await expect(checkbox).toBeChecked();
  await expect(mentions).toBeChecked();
  await expect(
    form.locator('input[type="radio"][value="mentions"]'),
  ).toBeChecked();
  await expect(
    form.locator('input[type="checkbox"][name="summary"]'),
  ).toBeChecked();
  expect(
    await form.evaluate((element) =>
      Object.fromEntries(new FormData(element as HTMLFormElement)),
    ),
  ).toEqual({ delivery: "mentions", summary: "yes" });
});

test("radios enabled after mount remain synchronized on native reset", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/radio-group`);
  const form = page.getByRole("form", { name: "Deferred preferences" });
  const all = form.getByRole("radio", { name: "All updates" });
  const mentions = form.getByRole("radio", { name: "Mentions only" });
  await expect(all).toBeDisabled();
  await form.getByRole("button", { name: "Enable choices" }).click();
  await mentions.click();
  await expect(mentions).toBeChecked();
  await form.getByRole("button", { name: "Reset preferences" }).click();
  await expect(all).toBeChecked();
  await expect(mentions).not.toBeChecked();
  expect(
    await form.evaluate((element) =>
      Object.fromEntries(new FormData(element as HTMLFormElement)),
    ),
  ).toEqual({ delivery: "all" });
});

test("button loading keeps focus and labels stay single-line in constrained layouts", async ({
  page,
  browserName,
}) => {
  await page.goto(`${viewer}#/design/components/button`);
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await save.focus();
  const tab =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab";
  await page.keyboard.press(`Shift+${tab}`);
  await page.keyboard.press(tab);
  await expect(save).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(save).toHaveAttribute("aria-busy", "true");
  await expect(save).toBeFocused();
  // Tab reached this button, so the busy state must keep its keyboard ring.
  await expectKeyboardRing(save);
  await page.keyboard.press("Enter");
  await expect(save).toHaveAttribute("aria-busy", "true");
  await page
    .getByRole("button", { name: "Complete saving", exact: true })
    .click();
  await expect(save).not.toHaveAttribute("aria-busy", "true");
  await save.click();
  // A pointer press drops the modality fact, so the ring goes away.
  await expect(save).toHaveCSS("outline-style", "none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(save.locator(".buzz-button-spinner")).toHaveCSS(
    "animation-name",
    "none",
  );
  await page
    .getByRole("button", { name: "Complete saving", exact: true })
    .click();
  const expanded = page.getByRole("button", {
    name: "Show details",
    exact: true,
  });
  await expanded.click();
  await expect(expanded).toHaveAttribute("aria-expanded", "true");
  await page.mouse.move(0, 0);
  await expect(page.locator("#button-example-details")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  for (const width of [390, 800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const fontSize of ["100%", "200%"]) {
      await page.evaluate((size) => {
        document.documentElement.style.fontSize = size;
      }, fontSize);
      for (const name of [
        "Apply changes",
        "Allow notifications for this workspace",
      ]) {
        const button = page.getByRole("button", { name, exact: true });
        const label = button.locator(".buzz-button-label");
        await expect
          .poll(() =>
            label.evaluate((el) => {
              const text = [...el.childNodes].find(
                (node) =>
                  node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
              );
              if (!text) return 0;
              const range = document.createRange();
              range.selectNodeContents(text);
              return range.getClientRects().length;
            }),
          )
          .toBe(1);
        await expect
          .poll(() => button.evaluate((el) => el.scrollWidth <= el.clientWidth))
          .toBe(true);
      }
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        )
        .toBe(true);
    }
    await page.evaluate(() => {
      document.documentElement.style.removeProperty("font-size");
    });
  }
});

test("dialog motion retains exit presence and respects immediate interaction paths", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/dialog`);
  const trigger = page
    .getByRole("region", { name: "Single field", exact: true })
    .getByRole("button", { name: "Open dialog", exact: true });
  const popup = page.locator(".buzz-dialog");
  // Hold real CSS transitions, so intermediate presence does not depend on speed.
  await page.evaluate(() => {
    document.addEventListener(
      "transitionrun",
      (event) => {
        if (
          !(event.target instanceof HTMLElement) ||
          !event.target.matches('.buzz-dialog[data-motion="default"]')
        )
          return;
        for (const animation of event.target.getAnimations()) animation.pause();
      },
      true,
    );
  });
  const finish = () =>
    page.evaluate(() => {
      for (const animation of document.getAnimations()) animation.finish();
    });
  try {
    await trigger.click();
    await expect
      .poll(() =>
        popup.evaluate((el) =>
          el.getAnimations().some((a) => a.playState === "paused"),
        ),
      )
      .toBe(true);
    await finish();
    await expect
      .poll(() => popup.evaluate((el) => el.contains(document.activeElement)))
      .toBe(true);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(popup).toHaveAttribute("data-ending-style", "");
    await expect
      .poll(() =>
        popup.evaluate((el) =>
          el.getAnimations().some((a) => a.playState === "paused"),
        ),
      )
      .toBe(true);
    await finish();
    await expect(popup).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // Escape can interrupt a pointer-opened entrance without waiting for motion.
    await trigger.click();
    await expect
      .poll(() =>
        popup.evaluate((el) =>
          el.getAnimations().some((a) => a.playState === "paused"),
        ),
      )
      .toBe(true);
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // Use real keyboard navigation to activate the host's modality owner.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await trigger.press("Enter");
    await expect(popup).toHaveCSS("transition-duration", "0s");
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await trigger.click();
    await expect(popup).toHaveCSS("transition-duration", "0s");
    await expect(popup).toHaveCSS("opacity", "1");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(popup).toHaveCount(0);
  } finally {
    await finish();
  }
});

// Real engines own :focus-visible, input modality and portal focus transfer.
test("menu items show a keyboard focus ring and stay quiet under pointer input in both modes", async ({
  page,
  browserName,
}) => {
  await page.goto(`${viewer}#/design/components/menu`);
  const trigger = page.getByRole("button", {
    name: "More actions",
    exact: true,
  });
  const action = page.getByRole("menuitem", {
    name: "Mark all as read",
    exact: true,
  });
  const checkbox = page.getByRole("menuitemcheckbox", {
    name: "Notifications",
  });
  const submenu = page.getByRole("menuitem", { name: "Sort", exact: true });
  const recent = page.getByRole("menuitemradio", { name: "Recent" });
  const alpha = page.getByRole("menuitemradio", { name: "A–Z" });
  const tab =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab";
  for (const mode of ["light", "dark"]) {
    const toggle = page.getByRole("button", { name: `Use ${mode} mode` });
    if (await toggle.count()) await toggle.click();
    await trigger.click();
    await expect(page.getByRole("menu")).toHaveCSS("transform", "none");
    await page.mouse.move(0, 0);
    await action.hover();
    // Programmatic focus following a pointer open must stay quiet too.
    await action.focus();
    await expect(action).toBeFocused();
    await expect(action).toHaveCSS("outline-style", "none");
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await page.keyboard.press(tab);
    await page.keyboard.press(`Shift+${tab}`);
    await expect(trigger).toBeFocused();
    await page.keyboard.press("ArrowDown");
    for (const item of [action, checkbox, submenu]) {
      await expect(item).toBeFocused();
      // Inset, so the scrolling popup cannot clip the ring at its edge.
      await expectKeyboardRing(item, "-2px");
      if (item !== submenu) await page.keyboard.press("ArrowDown");
    }
    await page.keyboard.press("ArrowRight");
    await expect(recent).toBeFocused();
    await expectKeyboardRing(recent, "-2px");
    await page.keyboard.press("ArrowDown");
    await expect(alpha).toBeFocused();
    await expectKeyboardRing(alpha, "-2px");
    await page.keyboard.press("Escape");
    await expect(submenu).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(page.getByRole("menu")).toHaveCount(0);
    // Returning to pointer input must remove the ring even after keyboard use.
    await trigger.click();
    await submenu.hover();
    await expect(recent).toBeVisible();
    await expect(page.getByRole("menu").last()).toHaveCSS("transform", "none");
    await recent.hover();
    await recent.focus();
    await expect(recent).toBeFocused();
    await expect(recent).toHaveCSS("outline-style", "none");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  }
});

// Geometry and hit testing cannot be established by a DOM emulator.
test("shared menus stay reachable near viewport edges and above a dialog", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/menu`);
  for (const width of [390, 800, 1280]) {
    await page.setViewportSize({ width, height: 700 });
    const context = page.getByRole("button", { name: "Context actions" });
    // Put the real trigger at the collision boundary, without replacing menu behavior.
    await context.evaluate((element) => {
      Object.assign(element.style, {
        position: "fixed",
        right: "0",
        bottom: "0",
        zIndex: "1",
      });
    });
    const contextBounds = await context.boundingBox();
    if (!contextBounds)
      throw new Error("Context trigger has no visible bounds");
    // Stay near the viewport edge, inside the pill rather than its cut-out corner.
    await context.click({
      button: "right",
      position: { x: contextBounds.width - 4, y: contextBounds.height / 2 },
    });
    const popup = page.getByRole("menu");
    await expect(popup).toBeVisible();
    await expect(popup).toHaveCSS("transform", "none");
    const box = await popup.boundingBox();
    if (!box) throw new Error("Context menu has no visible bounds");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(700);
    await page
      .getByRole("menuitem", { name: "Copy link", exact: true })
      .click();
    await expect(popup).toHaveCount(0);
    const trigger = page.getByRole("button", {
      name: "More actions",
      exact: true,
    });
    await trigger.evaluate((element) => {
      Object.assign(element.style, {
        position: "fixed",
        right: "0",
        top: "0",
        zIndex: "1",
      });
    });
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("menuitem", { name: "Mark all as read", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("End");
    await expect(
      page.getByRole("menuitem", { name: "Sort", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("ArrowRight");
    const nested = page.getByRole("menu", { name: "Sort", exact: true });
    await expect(nested).toBeVisible();
    await expect(nested).toHaveCSS("transform", "none");
    const nestedBox = await nested.boundingBox();
    if (!nestedBox) throw new Error("Submenu has no visible bounds");
    expect(nestedBox.x).toBeGreaterThanOrEqual(0);
    expect(nestedBox.y).toBeGreaterThanOrEqual(0);
    expect(nestedBox.x + nestedBox.width).toBeLessThanOrEqual(width);
    expect(nestedBox.y + nestedBox.height).toBeLessThanOrEqual(700);
    const choice = page.getByRole("menuitemradio", { name: "A–Z" });
    await choice.click();
    await expect(choice).toBeChecked();
    // Base UI choices stay open by default; dismiss each level explicitly.
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("menuitem", { name: "Sort", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Open menu dialog" }).click();
  const dialog = page.getByRole("dialog", { name: "Menu composition" });
  const trigger = dialog.getByRole("button", { name: "More actions" });
  await trigger.click();
  const action = page.getByRole("menuitem", {
    name: "Mark all as read",
    exact: true,
  });
  await expect(action).toBeVisible();
  await action.click(); // Playwright hit testing rejects an obscured portal.
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(trigger).toBeFocused();
});

// Real iframe sizing, theme propagation, media decoding and built asset paths
// require a browser; the specimen interactions only mutate local sample state.
test("built Messages gallery renders isolated product states and follows viewer theme and width", async ({
  page,
}) => {
  const failures: string[] = [];
  const sockets: string[] = [];
  const pageErrors = watchPageErrors(page);
  page.on("response", (response) => {
    if (response.status() >= 400)
      failures.push(`${response.status()} ${response.url()}`);
  });
  page.on("websocket", (socket) => sockets.push(socket.url()));
  await page.goto(`${viewer}#/design/messages`);
  const gallery = page.frameLocator('iframe[title="Message types and states"]');
  await expect(gallery.locator(".message-gallery-example")).toHaveCount(33);
  await expect(
    gallery.getByRole("heading", { name: "Member removed", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => page.locator("iframe").evaluate((el) => el.clientHeight))
    .toBeLessThanOrEqual(900);
  await gallery
    .getByRole("button", { name: "Delivery states", exact: true })
    .click();
  const failed = gallery.getByRole("region", { name: "Failed", exact: true });
  await expect(failed.getByRole("status")).toHaveText(
    "Couldn’t send this message.",
  );
  await failed.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(failed.getByRole("status")).toHaveCount(0);
  await gallery.getByRole("button", { name: "Reset examples" }).click();
  await expect(failed.getByRole("status")).toHaveText(
    "Couldn’t send this message.",
  );
  await gallery
    .getByRole("button", { name: "Conversation context", exact: true })
    .click();
  await gallery.getByRole("button", { name: "View thread: 4 replies" }).click();
  await expect(
    gallery.getByRole("region", { name: "Sample thread replies" }),
  ).toBeVisible();
  await gallery.getByRole("button", { name: "Close replies" }).click();
  await expect(
    gallery.getByRole("region", { name: "Sample thread replies" }),
  ).toHaveCount(0);
  for (const mode of ["light", "dark"]) {
    const toggle = page.getByRole("button", { name: `Use ${mode} mode` });
    if (await toggle.count()) await toggle.click();
    await expect(gallery.locator("html")).toHaveAttribute(
      "data-color-mode",
      mode,
    );
    await gallery
      .getByRole("button", { name: "Attachments", exact: true })
      .click();
    const video = gallery
      .getByRole("region", { name: "Video attachment", exact: true })
      .locator("video");
    await expect
      .poll(() => video.evaluate((el) => (el as HTMLVideoElement).readyState))
      .toBeGreaterThanOrEqual(2);
    for (const width of [390, 800, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(() =>
          gallery
            .locator("body")
            .evaluate((el) => el.scrollWidth <= window.innerWidth),
        )
        .toBe(true);
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        )
        .toBe(true);
    }
  }
  await gallery
    .getByRole("button", { name: "Content and identity", exact: true })
    .click();
  await gallery.getByRole("button", { name: "Narrow preview" }).click();
  await expect
    .poll(() =>
      gallery
        .locator(".message-gallery-examples")
        .evaluate((el) => el.clientWidth),
    )
    .toBeLessThanOrEqual(390);
  await expect(
    gallery.getByRole("button", { name: "View Sam Rivera profile" }),
  ).toBeVisible();
  await expect(
    gallery.getByRole("img", { name: ":landscape:", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(gallery.locator(".message-gallery-example")).toHaveCount(33);
  expect([...pageErrors.unexplained(), ...failures]).toEqual([]);
  expect(sockets).toEqual([]);
});

// Cross-document fullscreen placement and native focus restoration require a browser.
test("Messages gallery fullscreen stays reachable and returns focus to its trigger", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/messages`);
  const gallery = page.frameLocator('iframe[title="Message types and states"]');
  for (const width of [1280, 800, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const category of ["All messages", "Attachments"]) {
      await gallery
        .getByRole("button", { name: category, exact: true })
        .click();
      const trigger = gallery
        .getByRole("button", { name: "Open video fullscreen", exact: true })
        .first();
      await trigger.click();
      const dialog = gallery.getByRole("dialog", {
        name: "Video attachment",
        exact: true,
      });
      const close = dialog.getByRole("button", {
        name: "Close fullscreen viewer",
        exact: true,
      });
      await expect(dialog).toBeInViewport({ ratio: 1 });
      await expect(close).toBeInViewport({ ratio: 1 });
      await expect(close).toBeFocused();
      await expect(dialog.locator("video")).toBeInViewport({ ratio: 1 });
      await expect
        .poll(() =>
          dialog
            .locator("video")
            .evaluate(
              (video) =>
                video instanceof HTMLVideoElement &&
                video.readyState >= 2 &&
                video.videoWidth > 0 &&
                video.currentTime > 0,
            ),
        )
        .toBe(true);
      await close.click();
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await trigger.press("Enter");
      await expect(dialog).toBeInViewport({ ratio: 1 });
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
  }
});

// Real engines own transition presence, filtering, portal dismissal, and focus.
test("form choice popups settle, retain exit presence, and respect immediate motion", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/forms`);
  // Select retains a hidden portal to measure labels; Combobox unmounts it.
  // Both must remove the active surface after its exit completes.
  const popup = page.locator(
    ".buzz-select-positioner:not([hidden]) .buzz-select-popup",
  );
  await page.evaluate(() => {
    document.addEventListener(
      "transitionrun",
      (event) => {
        if (
          !(event.target instanceof HTMLElement) ||
          !event.target.matches(".buzz-select-popup")
        )
          return;
        for (const animation of event.target.getAnimations()) animation.pause();
      },
      true,
    );
  });
  const finish = () =>
    page.evaluate(() => {
      for (const animation of document.getAnimations()) animation.finish();
    });
  const paused = () =>
    expect
      .poll(() =>
        popup.evaluate((el) =>
          el
            .getAnimations()
            .some((animation) => animation.playState === "paused"),
        ),
      )
      .toBe(true);
  try {
    for (const name of ["Destination", "Searchable destination"]) {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const field = page.getByRole("combobox", { name, exact: true }).first();
      await field.click();
      await paused();
      await finish();
      await expect(popup).toHaveCSS("opacity", "1");
      await page.getByRole("option", { name: /^Product team/ }).click();
      await expect(popup).toHaveAttribute("data-ending-style", "");
      await paused();
      await finish();
      await expect(popup).toHaveCount(0);
      await expect(field).toBeFocused();

      await page.keyboard.press("Tab");
      await field.focus();
      await field.press("ArrowDown");
      await expect(popup).toBeVisible();
      await expect(popup).toHaveCSS("transition-duration", "0s");
      await expect(popup).toHaveCSS("filter", "none");
      await page.keyboard.press("Escape");
      await expect(popup).toHaveCount(0);

      await page.emulateMedia({ reducedMotion: "reduce" });
      await field.click();
      await expect(popup).toBeVisible();
      await expect(popup).toHaveCSS("transition-duration", "0s");
      await expect(popup).toHaveCSS("filter", "none");
      await expect(popup).toHaveCSS("transform", "none");
      await page.keyboard.press("Escape");
      await expect(popup).toHaveCount(0);
    }
  } finally {
    await finish();
  }
});

// Native portal focus and dismissal cannot be established by a DOM emulator.
test("popovers return focus and nested popovers close before their dialog", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/popover`);
  const trigger = page.getByRole("button", {
    name: "Edit workspace name",
    exact: true,
  });
  await expect(trigger).toBeVisible();
  await page.keyboard.press("Tab");
  await trigger.focus();
  await page.keyboard.press("Enter");
  const popup = page.getByRole("dialog", {
    name: "Edit workspace",
    exact: true,
  });
  const input = popup.getByRole("textbox", { name: "Workspace name" });
  await expect(input).toBeFocused();
  await expect(popup).toHaveCSS("transition-duration", "0s");
  await input.fill("Research studio");
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(
    page.getByRole("status").filter({ hasText: /^Workspace:/ }),
  ).toHaveText("Workspace: Design studio");
  await trigger.click();
  await expect(input).toHaveValue("Design studio");
  await input.fill("Research studio");
  await popup.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /^Workspace:/ }),
  ).toHaveText("Workspace: Research studio");
  const activityTrigger = page.getByRole("button", {
    name: "Recent activity",
    exact: true,
  });
  await activityTrigger.hover();
  const activity = page.getByRole("dialog", {
    name: "Recent activity",
    exact: true,
  });
  await expect(activity).toBeVisible();
  await activity.hover();
  await expect(activity).toBeVisible();
  await activity.getByRole("button", { name: /Alex Morgan/ }).click();
  await expect(activity).toHaveCount(0);
  await page.getByRole("button", { name: "Open popover dialog" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Workspace details",
    exact: true,
  });
  const nestedTrigger = dialog.getByRole("button", {
    name: "View access details",
  });
  await nestedTrigger.click();
  const nested = page.getByRole("dialog", { name: "Invite only", exact: true });
  await expect(nested.getByRole("button", { name: "Done" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(nested).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(nestedTrigger).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

// Popup collision geometry, scrolling and text scaling need a layout engine.
test("popover placements and rich choices fit narrow screens and enlarged text", async ({
  page,
}) => {
  for (const mode of ["light", "dark"]) {
    await page.goto(`${viewer}#/design/components/popover`);
    const toggle = page.getByRole("button", { name: `Use ${mode} mode` });
    if (await toggle.count()) await toggle.click();
    await page.setViewportSize({ width: 390, height: 850 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    for (const side of ["top", "right", "bottom", "left"]) {
      await page.getByRole("button", { name: side, exact: true }).click();
      const popup = page.getByRole("dialog", {
        name: `Anchored ${side}`,
        exact: true,
      });
      await expect(popup).toBeVisible();
      await expect(popup).toHaveCSS("transform", "none");
      const box = await popup.boundingBox();
      if (!box) throw new Error("Popover has no visible bounds");
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(850);
      await expect
        .poll(() => popup.evaluate((e) => e.scrollWidth <= e.clientWidth))
        .toBe(true);
      await page.keyboard.press("Escape");
      await expect(popup).toHaveCount(0);
    }
    await page.goto(`${viewer}#/design/components/menu`);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await page
      .getByRole("button", { name: "Choose an agent", exact: true })
      .click();
    const menu = page.getByRole("menu", {
      name: "Choose an agent",
      exact: true,
    });
    await expect(menu).toHaveCSS("transform", "none");
    await expect
      .poll(() => menu.evaluate((e) => e.scrollWidth <= e.clientWidth))
      .toBe(true);
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Choose workspace", exact: true })
      .click();
    const list = page.getByRole("menu", {
      name: "Choose workspace",
      exact: true,
    });
    await expect(list).toHaveCSS("transform", "none");
    await expect
      .poll(() => list.evaluate((e) => e.scrollHeight > e.clientHeight))
      .toBe(true);
    await page.keyboard.press("End");
    const last = page.getByRole("menuitemradio", {
      name: "Workspace 24",
      exact: true,
    });
    await expect(last).toBeFocused();
    const listBox = await list.boundingBox();
    const rowBox = await last.boundingBox();
    if (!listBox || !rowBox)
      throw new Error("Menu or last row has no visible bounds");
    expect(rowBox.y).toBeGreaterThanOrEqual(listBox.y);
    expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(
      listBox.y + listBox.height,
    );
    await page.keyboard.press("Enter");
    await expect(list).toHaveCount(0);
  }
});

// Reduced-motion preference must suppress popup animation in the browser.
test("popover reduced motion and outside dismissal remain immediate", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${viewer}#/design/components/popover`);
  await page.getByRole("button", { name: "Open popover", exact: true }).click();
  const popup = page.getByRole("dialog", {
    name: "Workspace access",
    exact: true,
  });
  await expect(popup).toBeVisible();
  await expect(popup).toHaveCSS("transition-duration", "0s");
  await page.getByRole("heading", { name: "Popover", exact: true }).click();
  await expect(popup).toHaveCount(0);
});

// Native focus, responsive chrome, and hash-anchor scrolling require a browser.
test("documentation navigation keeps the article reachable at narrow widths", async ({
  page,
  browserName,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`${viewer}#/design/design-guide`);
  const browse = page.getByRole("button", { name: /Browse pages/ });
  await expect(browse).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("main h1")).toBeInViewport();
  const tab =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab";
  await page.keyboard.press(tab);
  await expect(
    page.getByRole("button", { name: "Skip to content" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  await expect(page).toHaveURL(/#\/design\/design-guide$/);
  await browse.click();
  const nav = page.getByRole("navigation", { name: "Design system" });
  await nav.getByRole("link", { name: "Glass", exact: true }).click();
  await expect(browse).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("main")).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "Glass", exact: true }),
  ).toBeInViewport();
  await expect(
    nav.getByRole("link", { name: "Color", exact: true }),
  ).toBeHidden();

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(
    nav.getByRole("link", { name: "Color", exact: true }),
  ).toBeVisible();
  await nav.getByRole("link", { name: "Design guide", exact: true }).click();
  await page
    .getByRole("link", { name: "Identity shapes", exact: true })
    .click();
  await expect(page).toHaveURL(/#\/design\/design-guide#identity-shapes$/);
  await expect(page.locator("#identity-shapes")).toBeInViewport();
});

// Browser geometry catches document overflow, hidden reference columns, and
// truncated sample labels that a DOM emulator cannot measure.
test("documentation tables and token ramps reflow without hiding labels", async ({
  page,
}) => {
  for (const width of [320, 720, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ["design-guide", "color", "glass"]) {
      await page.goto(`${viewer}#/design/${route}`);
      await expect(page.locator("main h1")).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBe(width);
      if (route === "design-guide") {
        const table = page.locator(".design-doc-table-scroll").first();
        if (width === 320) {
          await expect(
            page.getByText("Wide tables scroll horizontally.").first(),
          ).toBeVisible();
          await table.focus();
          await page.keyboard.press("ArrowRight");
          await expect
            .poll(() => table.evaluate((element) => element.scrollLeft))
            .toBeGreaterThan(0);
          await page.keyboard.press("ArrowLeft");
          await expect
            .poll(() => table.evaluate((element) => element.scrollLeft))
            .toBe(0);
        }
      }
      if (route === "glass") {
        await expect(page.locator(".glass-ramp code")).toHaveCount(5);
        await expect
          .poll(() =>
            page
              .locator(".glass-ramp code, .glass-ramp span")
              .evaluateAll(
                (elements) =>
                  elements.filter(
                    (element) => element.scrollWidth > element.clientWidth,
                  ).length,
              ),
          )
          .toBe(0);
      }
    }
  }
});

// Real browser focus, responsive geometry, and route-to-section navigation are
// the browser boundary. Clipboard outcomes and draft retention are unit tested.
test("documentation code tabs and contents work with keyboard and narrow layouts", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/input`);
  const tabs = page.getByRole("tablist", { name: "Input states view" });
  await tabs.getByRole("tab", { name: "Preview", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    tabs.getByRole("tab", { name: "Code", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  const codePanel = page.getByRole("tabpanel", { name: "Code", exact: true });
  await expect(codePanel).toBeVisible();
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 320) {
      await codePanel.focus();
      await page.keyboard.press("PageDown");
      await expect
        .poll(() => codePanel.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
    }
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
  }
  await page
    .getByRole("navigation", { name: "Design system", exact: true })
    .getByRole("link", { name: "Popover", exact: true })
    .click();
  const contents = page.getByRole("navigation", {
    name: "On this page",
    exact: true,
  });
  await contents
    .getByRole("button", { name: "Placement", exact: true })
    .click();
  const heading = page.getByRole("heading", { name: "Placement", exact: true });
  await expect(heading).toBeFocused();
  await expect
    .poll(async () => (await heading.boundingBox())?.y)
    .toBeLessThan(100);
  await page
    .getByRole("navigation", { name: "Design system", exact: true })
    .getByRole("link", { name: "Button", exact: true })
    .click();
  await expect(
    contents.getByRole("button", { name: "Placement", exact: true }),
  ).toHaveCount(0);
  await expect(
    contents.getByRole("button", {
      name: "Loading and expansion",
      exact: true,
    }),
  ).toBeVisible();
});

// Real font metrics, wrapping, and RTL geometry cannot be established in jsdom.
test("empty states preserve grouping and contain translated copy at 200 percent", async ({
  page,
}, info) => {
  await page.goto(`${viewer}#/design/components/empty-state`);
  const cards = page.locator(".buzz-empty-state");
  await expect(cards).toHaveCount(2);
  await page.evaluate(() => document.fonts.ready);
  for (const width of [1440, 800, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const scale of ["100%", "200%"]) {
      for (const direction of ["ltr", "rtl"]) {
        for (const copy of [
          {
            lang: "en",
            title: "No emojis yet",
            description: "Add a custom emoji to use in messages and reactions.",
            action: "Add emoji",
          },
          {
            lang: "de",
            title: "Noch keine persönlichen Gruppen",
            description:
              "Organisiere zusammengehörige Kanäle in persönlichen Gruppen. Deine Gruppen sind nur für dich sichtbar.",
            action: "Persönliche Gruppen verwalten",
          },
          {
            lang: "en",
            title: "[Ñöö pëërsöönââl gröüps yëët]",
            description:
              "[Këëp rëëlââtëëd châânnëëls töögëëthëër ïïn yöüür sëëttïïngs. Thëësëë gröüps âârëë prïïvââtëë töö yöüü.]",
            action: "[Mâânââgëë pëërsöönââl gröüps]",
          },
        ]) {
          // Test-only copy substitutions stress the real shared component.
          await cards.first().evaluate(
            (root, { scale, direction, copy }) => {
              document.documentElement.style.fontSize = scale;
              document.documentElement.dir = direction;
              root.setAttribute("lang", copy.lang);
              const title = root.querySelector(".buzz-empty-state-title");
              const description = root.querySelector(
                ".buzz-empty-state-description",
              );
              const action = root.querySelector(".buzz-button-label");
              if (!title || !description || !action)
                throw new Error("Empty-state specimen is incomplete");
              title.textContent = copy.title;
              description.textContent = copy.description;
              action.textContent = copy.action;
            },
            { scale, direction, copy },
          );
          for (const card of await cards.all()) {
            await expect
              .poll(
                () =>
                  card.evaluate((root) => {
                    const bounds = root.getBoundingClientRect();
                    return (
                      [...root.querySelectorAll("*")].every((node) => {
                        const box = node.getBoundingClientRect();
                        return (
                          box.left >= bounds.left && box.right <= bounds.right
                        );
                      }) && root.scrollWidth <= root.clientWidth
                    );
                  }),
                { message: `${width}px, ${scale}, ${direction}, ${copy.lang}` },
              )
              .toBe(true);
          }
          const lineHeight = await cards.first().evaluate((root) => {
            const description = root.querySelector("p");
            if (!description) throw new Error("Empty-state copy is missing");
            const body = getComputedStyle(description);
            return parseFloat(body.lineHeight) / parseFloat(body.fontSize);
          });
          expect(lineHeight).toBeGreaterThanOrEqual(1.4);
          if (copy.lang === "de") {
            const fitsWords = await cards
              .first()
              .getByRole("button")
              .evaluate((button) => {
                const label = button.querySelector(".buzz-button-label");
                if (!label) throw new Error("Missing action label");
                const style = getComputedStyle(label);
                const canvas = document.createElement("canvas");
                const context = canvas.getContext("2d");
                if (!context)
                  throw new Error("Missing font measurement context");
                context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
                const longest = Math.max(
                  ...(label.textContent ?? "")
                    .split(/\s+/)
                    .map((word) => context.measureText(word).width),
                );
                return label.getBoundingClientRect().width >= longest;
              });
            expect(fitsWords, "Translated action retains whole words").toBe(
              true,
            );
          }
        }
      }
    }
    await cards.first().screenshot({
      path: info.outputPath(`empty-state-${width}-200-rtl.png`),
    });
  }
});

// Focus-ring clipping needs real overflow geometry, including the scrolling footer.
test("dialog footer focus rings remain visible in both themes and widths", async ({
  page,
}) => {
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const mode of ["light", "dark"]) {
      for (const [route, trigger, role, action] of [
        [
          "floating-surfaces",
          "Open interaction dialog",
          "dialog",
          "Close proof",
        ],
        [
          "components/alert-dialog",
          "Discard example changes",
          "alertdialog",
          "Discard",
        ],
      ] as const) {
        await page.goto(`${viewer}#/design/${route}`);
        const toggle = page.getByRole("button", { name: `Use ${mode} mode` });
        if (await toggle.count()) await toggle.click();
        await page.getByRole("button", { name: trigger, exact: true }).click();
        const dialog = page.getByRole(role);
        await page.keyboard.press("Tab");
        const button = dialog.getByRole("button", {
          name: action,
          exact: true,
        });
        await button.focus();
        await expectKeyboardRing(button);
        await expect
          .poll(async () =>
            button.evaluate((element) => {
              const footer = element.closest(".buzz-dialog-actions");
              if (!footer) throw new Error("Missing dialog footer");
              const control = element.getBoundingClientRect();
              const bounds = footer.getBoundingClientRect();
              const style = getComputedStyle(element);
              const ring =
                parseFloat(style.outlineWidth) +
                parseFloat(style.outlineOffset);
              return {
                left: control.left - ring >= bounds.left,
                right: control.right + ring <= bounds.right,
                top: control.top - ring >= bounds.top,
                bottom: control.bottom + ring <= bounds.bottom,
              };
            }),
          )
          .toEqual({ left: true, right: true, top: true, bottom: true });
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
      }
    }
  }
});
