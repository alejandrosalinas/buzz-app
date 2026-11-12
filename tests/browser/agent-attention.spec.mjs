import { test, expect } from "./source-fixture.mjs";

// Real browser focus and scroll geometry are outside jsdom.
test("The Attention tab fits both themes and sizes and manages existing watches by keyboard", async ({
  page,
}, testInfo) => {
  await page.goto("/tests/fixtures/agent-attention.html");
  const pane = page.getByRole("region", { name: "Attention", exact: true });
  await expect(pane).toBeVisible();
  await expect(pane.locator(".attention-setting .buzz-avatar")).toHaveCSS(
    "width",
    "32px",
  );
  // The real profile host joins its panels; Interest cards retain their own border.
  const interest = pane.getByRole("region", {
    name: "Interest Release planning",
    exact: true,
  });
  await expect(interest).toHaveCSS("border-top-width", "1px");
  await expect(interest).not.toHaveCSS("border-radius", "0px");
  // A titled Interest shows its summary; an older one keeps its heading and shows none.
  const titled = pane.getByRole("region", {
    name: "Interest PR reviews",
    exact: true,
  });
  await expect(titled.locator(".attention-interest-summary")).toHaveText(
    /^Wakes on new reviews/,
  );
  await expect(interest.locator(".attention-interest-summary")).toHaveCount(0);
  // A person in the instructions shows by name and opens their profile.
  await interest.locator(".attention-instructions summary").click();
  await interest.screenshot({
    path: testInfo.outputPath("interest-profile-link.png"),
  });
  await interest.getByRole("button", { name: "Sam", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-opened",
    /^nostr:npub1/,
  );
  await expect(interest).not.toContainText("npub1");
  await titled.screenshot({
    path: testInfo.outputPath("interest-summary.png"),
  });
  await page
    .getByRole("button", {
      name: "Details for Release discussion",
      exact: true,
    })
    .click();
  await page
    .getByLabel("Show activity for Release discussion", { exact: true })
    .click();
  await expect(page.getByText(/The release is ready for review/)).toBeVisible();
  const timeline = page.getByRole("list", {
    name: "Activity for Release discussion",
  });
  await expect(timeline.getByRole("listitem")).toHaveCount(3);
  const preview = timeline.locator("summary").first();
  await preview.click();
  const messages = page.locator(
    ".attention-activity-preview [data-message-id]",
  );
  await expect(messages).toHaveCount(1);
  await expect(messages.getByText("Alex")).toBeVisible();
  await expect(
    messages.getByRole("link", { name: "release doc" }),
  ).toHaveAttribute("href", "https://example.com/release");
  await preview.click();
  await expect(messages).toHaveCount(0);
  // Pointer affordances must reveal metadata without changing row geometry.
  const stamp = preview.locator(".attention-activity-time");
  await page.mouse.move(0, 0);
  await expect(stamp).toHaveCSS("opacity", "1");
  const restingBox = await preview.boundingBox();
  await preview.hover();
  await expect(stamp).toHaveCSS("opacity", "1");
  await expect(preview).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  expect(await preview.boundingBox()).toEqual(restingBox);
  await page.mouse.move(0, 0);
  await preview.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(stamp).toHaveCSS("opacity", "1");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: testInfo.outputPath("watching-recent-events.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Watch status for Release discussion" })
    .click();
  await expect(
    page.getByRole("menu", {
      name: "Watch status for Release discussion",
      exact: true,
    }),
  ).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: testInfo.outputPath("trigger-status-menu.png"),
  });
  await page.keyboard.press("Escape");
  for (const theme of ["light", "dark"]) {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((theme) => {
        document.documentElement.dataset.colorMode = theme;
        document.documentElement.style.fontSize = "20px";
      }, theme);
      await expect(
        page.getByRole("button", {
          name: "Watch status for Release discussion",
        }),
      ).toBeInViewport();
      expect(
        await pane.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
    }
  }
  const interestStatus = page.getByRole("button", {
    name: "Interest status for Release planning",
  });
  const watched = page.getByRole("button", {
    name: "Watch status for Release discussion",
  });
  await interestStatus.click();
  await expect(
    page.getByRole("menu", {
      name: "Interest status for Release planning",
      exact: true,
    }),
  ).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: testInfo.outputPath("interest-status-menu.png"),
  });
  await page
    .getByRole("menu", {
      name: "Interest status for Release planning",
      exact: true,
    })
    .getByRole("menuitem", { name: "Pause", exact: true })
    .click();
  await expect(interestStatus).toHaveText("Paused");
  await expect(watched).toHaveText("Paused");
  await page.keyboard.press("Escape");
  await interestStatus.click();
  await page.getByRole("menuitem", { name: "Resume", exact: true }).click();
  await expect(interestStatus).toHaveText("Active");
  await expect(watched).toHaveText("Active");
  await page.keyboard.press("Escape");
  const details = page.getByRole("button", {
    name: "Details for example/project#42",
    exact: true,
  });
  await details.focus();
  await page.keyboard.press("Enter");
  await expect(details).toHaveAttribute("aria-expanded", "true");
  await page
    .getByRole("button", { name: "Watch status for example/project#42" })
    .click();
  const toggle = page
    .getByRole("menu", { name: "Watch status for example/project#42" })
    .getByRole("menuitem", {
      name: "Pause",
      exact: true,
    });
  await page.evaluate(() => window.attentionFixture.holdSave());
  try {
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect
      .poll(() => page.evaluate(() => window.attentionFixture.saveStarted))
      .toBe(true);
    await expect(toggle).toHaveAttribute("aria-disabled", "true");
  } finally {
    await page.evaluate(() => window.attentionFixture.releaseSave());
  }
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Source details for example/project#42" })
    .click();
  await expect(
    page.getByRole("link", { name: "Open project#42" }),
  ).toHaveAttribute("href", "https://github.com/example/project/pull/42");
  await page
    .getByRole("button", { name: "Choose who can wake agents" })
    .click();
  expect(await page.evaluate(() => window.attentionFixture.opened)).toEqual({
    version: 1,
    kind: "settings",
    section: "buzz.github/authors",
  });
});

// Browser focus after removal, including async writes, cannot be proved by jsdom.
test("watch and interest deletion restore focus without taking it from another control", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-attention.html");
  const pane = page.getByRole("region", { name: "Attention", exact: true });
  const remove = page.getByRole("menuitem", {
    name: "Delete Release discussion",
  });
  await expect(remove).toHaveCount(0);
  await page
    .getByRole("button", { name: "Watch status for Release discussion" })
    .click();
  await expect(remove).toBeVisible();
  await page.getByRole("menuitem", { name: "Pause", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(remove).toBeFocused();
  // Delete asks first. Escape keeps the watch and returns focus to its pill.
  await page.keyboard.press("Enter");
  const confirm = page.getByRole("alertdialog", {
    name: "Delete Release discussion?",
  });
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  const pill = page.getByRole("button", {
    name: "Watch status for Release discussion",
  });
  await expect(pill).toBeFocused();
  expect(await page.evaluate(() => window.attentionFixture.saveStarted)).toBe(
    false,
  );
  await page.keyboard.press("Enter");
  await remove.click();
  await page.evaluate(() => window.attentionFixture.holdSave());
  const confirmDelete = confirm.getByRole("button", { name: "Delete" });
  await confirmDelete.focus();
  await page.keyboard.press("Enter");
  try {
    await expect
      .poll(() => page.evaluate(() => window.attentionFixture.saveStarted))
      .toBe(true);
    await expect(confirmDelete).toBeFocused();
  } finally {
    await page.evaluate(() => window.attentionFixture.releaseSave());
  }
  await expect(confirm).toHaveCount(0);
  await expect(pill).toHaveCount(0);
  // The dialog leaves with the row; Base UI returns focus to the nearest
  // remaining control, the Interest's own status pill.
  await expect(
    page.getByRole("button", { name: "Interest status for Release planning" }),
  ).toBeFocused();
  const interest = page.getByRole("region", {
    name: "Interest Release planning",
    exact: true,
  });
  await expect(interest).toBeVisible();
  const removeInterest = page.getByRole("button", {
    name: "Interest status for Release planning",
  });
  await expect(removeInterest).toHaveText("Active");
  await expect(removeInterest.locator("..")).toHaveCSS("opacity", "1");
  await page.evaluate(() => window.attentionFixture.holdSave());
  await removeInterest.focus();
  await expect(removeInterest.locator("..")).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  try {
    await expect
      .poll(() => page.evaluate(() => window.attentionFixture.saveStarted))
      .toBe(true);
    await expect(
      page.getByRole("menuitem", { name: "Delete", exact: true }),
    ).toBeFocused();
  } finally {
    await page.evaluate(() => window.attentionFixture.releaseSave());
  }
  await expect(interest).toHaveCount(0);
  await expect(pane).toBeFocused();
});

// Hover media behavior and tap activation require a real touch browser context.
test.describe("touch delete actions", () => {
  test.use({ hasTouch: true });
  test("keeps watch and Interest deletion available without hover", async ({
    page,
  }, testInfo) => {
    await page.goto("/tests/fixtures/agent-attention.html");
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(
      true,
    );
    const remove = page.getByRole("menuitem", {
      name: "Delete Release discussion",
    });
    await expect(remove).toHaveCount(0);
    await page
      .getByRole("button", { name: "Watch status for Release discussion" })
      .tap();
    await expect(remove).toBeVisible();
    await remove.tap();
    await expect(remove).toHaveCount(0);
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toBeVisible();
    await expect(confirm).toHaveCSS("opacity", "1");
    await confirm.getByRole("button", { name: "Delete" }).tap();
    await expect(
      page.getByRole("button", { name: "Watch status for Release discussion" }),
    ).toHaveCount(0);
    const interest = page.getByRole("button", {
      name: "Interest status for Release planning",
    });
    await expect(interest.locator("..")).toHaveCSS("opacity", "1");
    await interest.tap();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).tap();
    await expect(interest).toHaveCount(0);
    const remaining = page.getByRole("button", {
      name: /^Interest status for /,
    });
    await remaining.tap();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).tap();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS("opacity", "1");
    await page.screenshot({
      path: testInfo.outputPath("delete-interest-confirmation.png"),
    });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).tap();
    await expect(remaining).toBeVisible();
    await remaining.tap();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).tap();
    await dialog.getByRole("button", { name: "Delete", exact: true }).tap();
    await expect(remaining).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^Watch status for / }),
    ).toHaveCount(0);
  });
});

// Joined profile framing and responsive artwork geometry require browser layout.
test("empty Attention retains its card and sonar at both widths in the profile host", async ({
  page,
}, testInfo) => {
  await page.goto("/tests/fixtures/agent-attention.html");
  for (const name of ["Release discussion", "example/project#42"]) {
    await page
      .getByRole("button", { name: `Watch status for ${name}` })
      .click();
    await page
      .getByRole("menuitem", { name: `Delete ${name}`, exact: true })
      .click();
    await page
      .getByRole("alertdialog", { name: `Delete ${name}?` })
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(
      page.getByRole("button", { name: `Watch status for ${name}` }),
    ).toHaveCount(0);
  }
  const removeInterest = page.getByRole("button", {
    name: /^Interest status for /,
  });
  await expect(removeInterest).toHaveCount(2);
  await removeInterest.first().focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(removeInterest).toHaveCount(1);
  await removeInterest.first().focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const empty = page.getByRole("region", {
    name: "Start watching",
    exact: true,
  });
  await expect(empty).toBeVisible();
  await expect(empty.locator(".buzz-avatar")).toHaveCSS("width", "48px");
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(empty.locator(".buzz-empty-state")).toHaveCSS(
      "border-top-width",
      "1px",
    );
    await expect(empty.locator(".buzz-empty-state")).not.toHaveCSS(
      "border-radius",
      "0px",
    );
    await expect(empty.locator(".attention-sonar")).toHaveCSS("width", "160px");
    await expect(empty.getByRole("button")).toHaveCount(0);
    expect(await empty.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath(`empty-${width}.png`) });
  }
  // Sample the CSS timeline where the sweep reveals its first Citrus signal.
  await empty.locator(".attention-sonar").evaluate((el) => {
    for (const animation of el.getAnimations({ subtree: true })) {
      animation.pause();
      const signal = el.querySelector(".attention-sonar-signal[data-citrus]");
      const delay = Number.parseFloat(
        getComputedStyle(signal).getPropertyValue("--sonar-delay"),
      );
      animation.currentTime = (delay + 0.6) * 1000;
    }
  });
  await expect(empty.locator(".attention-sonar-hint").first()).toHaveCSS(
    "opacity",
    "1",
  );
  await page.screenshot({ path: testInfo.outputPath("sonar-signal.png") });
  // Finishing a sweep must not replace a still-visible signal or its bubble.
  expect(
    await empty.locator(".attention-sonar").evaluate(async (el) => {
      const hint = el.querySelector(".attention-sonar-hint");
      el.querySelector(".attention-sonar-sweep").dispatchEvent(
        new AnimationEvent("animationiteration", {
          animationName: "attention-sonar-scan",
          bubbles: true,
        }),
      );
      await new Promise(requestAnimationFrame);
      return hint.isConnected && Number(getComputedStyle(hint).opacity) === 1;
    }),
  ).toBe(true);
  // Sample two complete native animation cycles, including the wraparound.
  const maximumVisibleHints = await empty
    .locator(".attention-sonar")
    .evaluate((el) => {
      const animations = el.getAnimations({ subtree: true });
      const period =
        Number.parseFloat(
          getComputedStyle(el).getPropertyValue("--sonar-period"),
        ) * 1000;
      let maximum = 0;
      for (let time = 0; time < period * 2; time += 100) {
        for (const animation of animations) {
          animation.pause();
          animation.currentTime = time;
        }
        maximum = Math.max(
          maximum,
          [...el.querySelectorAll(".attention-sonar-hint")].filter(
            (hint) => Number(getComputedStyle(hint).opacity) > 0.01,
          ).length,
        );
      }
      return maximum;
    });
  expect(maximumVisibleHints).toBe(1);
});
