import { expect, test } from "../../browser/playwright-test.mjs";

const viewer = "/tests/fixtures/design-system.html";

// Real layout/focus coverage: a DOM emulator cannot prove portal stacking or scroll reachability.
test("toast recovery stays reachable across themes, sizes, keyboard scrolling and modals", async ({
  page,
}, testInfo) => {
  await page.goto(`${viewer}#/design/components/toast`);
  const region = page.getByRole("region", { name: "App notifications" });
  const stack = region.locator("[data-sonner-toaster]");
  const recovery = page.getByRole("dialog", {
    name: "Changes weren’t saved",
    exact: true,
  });
  for (const mode of ["light", "dark"]) {
    const theme = page.getByRole("button", { name: `Use ${mode} mode` });
    if (await theme.count()) await theme.click();
    for (const width of [390, 800, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await page
        .getByRole("button", { name: "Show recovery", exact: true })
        .focus();
      await page.keyboard.press("Enter");
      await expect(recovery).toBeInViewport();
      await expect(
        page.getByRole("button", { name: "Show recovery", exact: true }),
      ).toBeFocused();
      await expect(
        recovery.locator("xpath=ancestor::li[@data-sonner-toast]"),
      ).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
      const cardBox = await recovery.boundingBox();
      if (!cardBox) throw new Error("Toast card has no geometry");
      expect(cardBox.x + cardBox.width).toBeGreaterThan(width - 40);
      expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(width - 16);
      const box = await stack.boundingBox();
      if (!box) throw new Error("Toast viewport has no geometry");
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeGreaterThan(844 - 40);
      expect(box.y + box.height).toBeLessThanOrEqual(844 - 16);
      expect(box.x + box.width).toBeGreaterThan(width - 40);
      await page.keyboard.press("F6");
      await expect(stack).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(
        recovery.locator("xpath=ancestor::li[@data-sonner-toast]"),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(recovery).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("button", { name: "Retry saving", exact: true }),
      ).toBeFocused();
      await expect(
        recovery.locator("xpath=ancestor::li[@data-sonner-toast]"),
      ).toHaveCSS("opacity", "1");
      await page.screenshot({
        path: testInfo.outputPath(`toast-${mode}-${width}.png`),
      });
      await page.keyboard.press("Enter");
      await expect(recovery).toHaveCount(0);
    }
  }

  await page.setViewportSize({ width: 480, height: 400 });
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--type-scale", "1.2"),
  );
  await page
    .getByRole("button", { name: "Show recovery", exact: true })
    .click();
  await expect(recovery).toBeVisible();
  await page.keyboard.press("F6");
  await expect(stack).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const shortRetry = page.getByRole("button", {
    name: "Retry saving",
    exact: true,
  });
  await expect(shortRetry).toBeFocused();
  await shortRetry.click();
  await expect(recovery).toHaveCount(0);
  await page.evaluate(() =>
    document.documentElement.style.removeProperty("--type-scale"),
  );
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Show recovery stack" }).click();
  await expect(region.getByRole("dialog")).toHaveCount(6);
  await expect(stack.locator("[data-sonner-toast]").first()).toHaveCSS(
    "transition-duration",
    "0s",
  );
  await page.keyboard.press("F6");
  // Newest first, with no inert overflow entries: reach the oldest through real Tab scrolling.
  for (let id = 6; id >= 1; id--) {
    await page.keyboard.press("Tab");
    await expect(
      page
        .getByRole("dialog", { name: `Recovery ${id}`, exact: true })
        .locator("xpath=ancestor::li[@data-sonner-toast]"),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    const resolve = page.getByRole("button", {
      name: `Resolve ${id}`,
      exact: true,
    });
    await expect(resolve).toBeFocused();
    const actionBox = await resolve.boundingBox();
    const viewportBox = await stack.boundingBox();
    if (!actionBox || !viewportBox)
      throw new Error("Recovery action has no geometry");
    expect(actionBox.y).toBeGreaterThanOrEqual(viewportBox.y);
    expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(
      viewportBox.y + viewportBox.height,
    );
  }
  expect(await stack.evaluate((element) => element.scrollTop)).toBeGreaterThan(
    0,
  );
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "Recovery 1", exact: true }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Open example dialog" }).click();
  const modal = page.getByRole("dialog", {
    name: "Example dialog",
    exact: true,
  });
  await expect(modal).toBeVisible();
  await expect(region).toHaveCount(1); // Base UI keeps live regions announced during modals.
  await expect(
    modal.getByRole("button", { name: "Close", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("F6");
  await expect
    .poll(() =>
      modal.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await expect(region.getByRole("dialog")).toHaveCount(5);
  await page
    .getByRole("navigation", { name: "Design system" })
    .getByRole("link", { name: "Button", exact: true })
    .click();
  await expect(region).toHaveCount(0); // Leaving the owner clears the stack.
});

// Pointer capture and swipe direction require real browser input on the card,
// not a synthetic event sent directly to Sonner's enclosing list item.
test("swiping actual toast content dismisses confirmations and preserves recovery", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/toast`);
  await page
    .getByRole("button", { name: "Show confirmation", exact: true })
    .click();
  const confirmation = page.getByRole("dialog", {
    name: "Changes saved",
    exact: true,
  });
  await expect(confirmation).toBeVisible();
  const swipe = async (name: string) => {
    const card = page.getByRole("dialog", { name, exact: true });
    await expect(
      card.locator("xpath=ancestor::li[@data-sonner-toast]"),
    ).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
    const bounds = await card.boundingBox();
    if (!bounds) throw new Error("Toast card has no geometry");
    const x = bounds.x + 8,
      y = bounds.y + bounds.height - 8;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 160, y, { steps: 8 });
    await page.mouse.up();
  };
  await swipe("Changes saved");
  await expect(confirmation).toHaveCount(0);
  await page
    .getByRole("button", { name: "Show recovery", exact: true })
    .click();
  const recovery = page.getByRole("dialog", {
    name: "Changes weren’t saved",
    exact: true,
  });
  await expect(recovery).toBeVisible();
  await swipe("Changes weren’t saved");
  await expect(recovery).toBeVisible();
  await page.getByRole("button", { name: "Retry saving", exact: true }).click();
  await expect(recovery).toHaveCount(0);
});

// Native focus/blur and clock-controlled expiry must agree without pointer hover.
test("keyboard focus pauses expiry and leaving resumes it, with and without F6", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/toast`);
  await page.clock.install();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page
    .getByRole("switch", { name: "Keep visible while inspecting" })
    .click();
  const show = page.getByRole("button", { name: "Show toast", exact: true });
  const toast = page.getByRole("dialog", {
    name: "Message deleted",
    exact: true,
  });
  for (const hotkey of [false, true]) {
    await show.focus();
    await page.keyboard.press("Enter");
    await expect(toast).toBeVisible();
    await page.mouse.move(0, 0);
    if (hotkey) {
      await page.keyboard.press("F6");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
    } else {
      await toast.getByRole("button", { name: "Dismiss notification" }).focus();
    }
    await page.keyboard.press("Tab");
    await expect(
      toast.getByRole("button", { name: "Undo", exact: true }),
    ).toBeFocused();
    await page.clock.runFor(6000);
    await expect(toast).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(
      toast.getByRole("button", { name: "Undo", exact: true }),
    ).not.toBeFocused();
    await page.clock.runFor(6000);
    await expect(toast).toHaveCount(0);
  }
});

test("Escape dismisses the focused confirmation but leaves persistent recovery", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/toast`);
  await page
    .getByRole("button", { name: "Show confirmation", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  const confirmation = page.getByRole("dialog", {
    name: "Changes saved",
    exact: true,
  });
  await expect(confirmation).toBeVisible();
  await page.keyboard.press("F6");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await page
    .getByRole("button", { name: "Show recovery", exact: true })
    .click();
  const recovery = page.getByRole("dialog", {
    name: "Changes weren’t saved",
    exact: true,
  });
  await expect(recovery).toBeVisible();
  await page.keyboard.press("F6");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await expect(recovery).toBeVisible();
});

test("touch panning reaches overflowing persistent recovery actions", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "Real touch drag injection uses Chromium's CDP input API.",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  const touch = await page.context().newCDPSession(page);
  await touch.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 1,
  });
  await page.goto(`${viewer}#/design/components/toast`);
  await page
    .getByRole("button", { name: "Show recovery stack", exact: true })
    .click();
  const stack = page.locator("[data-sonner-toaster]");
  await expect(stack.getByRole("dialog")).toHaveCount(6);
  await expect(stack.locator("[data-sonner-toast]").first()).toHaveCSS(
    "transform",
    "matrix(1, 0, 0, 1, 0, 0)",
  );
  const box = await stack.boundingBox();
  if (!box) throw new Error("Toast stack has no geometry");
  const x = box.x + box.width / 2,
    y = box.y + box.height - 40;
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  try {
    for (let step = 1; step <= 10; step++) {
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y - step * 16 }],
      });
    }
  } finally {
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  }
  await expect
    .poll(() => stack.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(100);
  await expect(stack.getByRole("dialog")).toHaveCount(6);
});

test("removing a focused recovery resumes remaining confirmation timers", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/toast`);
  await page.clock.install();
  await page
    .getByRole("button", { name: "Show confirmation", exact: true })
    .click();
  const confirmation = page.getByRole("dialog", {
    name: "Changes saved",
    exact: true,
  });
  await expect(confirmation).toBeVisible();
  await page
    .getByRole("button", { name: "Show recovery", exact: true })
    .click();
  const retry = page.getByRole("button", { name: "Retry saving", exact: true });
  await retry.focus();
  await page.mouse.move(0, 0);
  await page.clock.runFor(6000);
  await expect(confirmation).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(retry).toHaveCount(0);
  // Source content leaves before Sonner's 200ms exit lifecycle completes.
  await page.clock.runFor(250);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(1);
  await page.clock.runFor(6000);
  await expect(confirmation).toHaveCount(0);
});

// The notice surface and its nested controls need real hit testing.
test("notice body opens its destination while nested actions keep their targets", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/toast`);
  const recovery = page.getByRole("dialog", {
    name: "Plugin update available",
    exact: true,
  });
  const destination = page.getByRole("dialog", {
    name: "Example dialog",
    exact: true,
  });
  for (const [mode, width, key] of [
    ["light", 390, "Enter"],
    ["dark", 1280, "Space"],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    const theme = page.getByRole("button", { name: `Use ${mode} mode` });
    if (await theme.count()) await theme.click();
    await page
      .getByRole("button", { name: "Show linked notice", exact: true })
      .click();
    await expect(recovery).toBeVisible();
    const body = recovery.getByRole("button", { name: "Open related dialog" });
    await body.hover();
    await expect(body).toHaveCSS("cursor", "pointer");
    const title = await recovery
      .getByText("Plugin update available", { exact: true })
      .boundingBox();
    if (!title) throw new Error("Missing notice title");
    await page.mouse.click(
      title.x + title.width / 2,
      title.y + title.height / 2,
    );
    await expect(destination).toBeVisible();
    await destination
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Show linked notice", exact: true })
      .click();
    await recovery.getByRole("button", { name: "Update", exact: true }).click();
    await expect(recovery).toHaveCount(0);
    await expect(destination).toHaveCount(0);
    await page
      .getByRole("button", { name: "Show linked notice", exact: true })
      .click();
    // Reach the body by Tab from the stack: WebKit skips a button without an
    // explicit tabindex unless the OS enables full keyboard access.
    await expect(body).toHaveAttribute("tabindex", "0");
    await page.keyboard.press("F6");
    await page.keyboard.press("Tab");
    await expect(
      recovery.locator("xpath=ancestor::li[@data-sonner-toast]"),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(body).toBeFocused();
    await page.keyboard.press(key);
    await expect(destination).toBeVisible();
    await destination
      .getByRole("button", { name: "Close", exact: true })
      .click();
  }
});
