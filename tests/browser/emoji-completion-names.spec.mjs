import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";

// Real overflow, tooltip placement and retained editor focus need a browser.
// Reuse the emoji fixture's real composer/provider with only its small catalog.
test("truncated emoji names reveal their full value without taking composer focus", async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  await page.route("**/emoji-media/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><circle cx="11" cy="11" r="10" fill="purple"/></svg>',
    }),
  );
  await page.goto("/tests/fixtures/emoji.html");
  const input = page.getByRole("textbox", { name: "Message #general" });
  const firstName = ":very-long-community-emoji-name-that-does-not-fit:";
  const secondName =
    ":very-long-community-emoji-name-that-does-not-fit-either:";
  const choices = page.getByRole("option");
  const tooltip = page.getByRole("tooltip").and(page.locator("[data-open]"));

  for (const [mode, width, scale] of [
    ["light", 1280, 1],
    ["dark", 1280, 1],
    ["light", 390, 1.5],
    ["dark", 390, 1.5],
  ]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(
      ({ mode, scale }) => {
        document.documentElement.dataset.colorMode = mode;
        document.documentElement.style.setProperty("--buzz-text-scale", scale);
      },
      { mode, scale },
    );
    await page.mouse.move(0, 0);
    await input.fill(":very-long");
    await expect(choices).toHaveCount(2);
    const label = choices.first().locator("[data-completion-label] > span");
    await expect(label).toHaveCSS("text-overflow", "ellipsis");
    await expect(label).toHaveCSS("white-space", "nowrap");
    await expect
      .poll(() => label.evaluate((el) => el.scrollWidth > el.clientWidth))
      .toBe(true);
    await label.hover();
    await expect(tooltip).toHaveText(firstName);
    await expect(tooltip).toHaveCSS("opacity", "1");
    await expect(input).toBeFocused();
    await expect
      .poll(() =>
        tooltip.evaluate((el) => {
          const bounds = el.getBoundingClientRect();
          return (
            bounds.left >= 0 &&
            bounds.right <= innerWidth &&
            bounds.top >= 0 &&
            bounds.bottom <= innerHeight &&
            el.scrollWidth <= el.clientWidth
          );
        }),
      )
      .toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`emoji-name-${mode}-${width}.png`),
    });
    await input.press("Escape");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(tooltip).toHaveCount(0);
    await expect(input).toHaveJSProperty("value", ":very-long");
    await expect(input).toBeFocused();
  }

  await page.mouse.move(0, 0);
  await input.fill(":very-long");
  await expect(choices).toHaveCount(2);
  await input.press("ArrowDown");
  await expect(choices.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(tooltip).toHaveText(secondName);
  await expect(input).toBeFocused();
  await page.mouse.move(1, 1);
  await expect(tooltip).toHaveCount(0);
  await expect(input).toBeFocused();
  await input.press("ArrowUp");
  await expect(tooltip).toHaveText(firstName);
  await input.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(tooltip).toHaveCount(0);
  await expect(input).toBeFocused();
  await input.fill(":very-long");
  await expect(choices).toHaveCount(2);
  await input.press("ArrowUp");
  await expect(tooltip).toHaveText(secondName);
  await input.press("ArrowUp");
  await expect(tooltip).toHaveText(firstName);
  await input.press("Tab");
  await expect(input).toHaveJSProperty("value", `${firstName} `);
  await expect(tooltip).toHaveCount(0);
  await expect(input).toBeFocused();

  await input.fill(":very-long");
  await expect(choices).toHaveCount(2);
  await input.press("ArrowDown");
  await expect(tooltip).toHaveText(secondName);
  await input.press("Enter");
  await expect(input).toHaveJSProperty("value", `${secondName} `);
  await expect(tooltip).toHaveCount(0);

  await input.fill(":very-long");
  await choices.first().locator("[data-completion-label]").hover();
  await expect(tooltip).toHaveText(firstName);
  await choices.nth(1).click();
  await expect(input).toHaveJSProperty("value", `${secondName} `);
  await expect(tooltip).toHaveCount(0);
  await expect(input).toBeFocused();

  // Fully visible names keep their label without an unnecessary hint.
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "1"),
  );
  await input.fill(":aonly");
  const shortChoice = page.getByRole("option", {
    name: ":aonly:",
    exact: true,
  });
  await expect(shortChoice).toBeVisible();
  const short = shortChoice.locator("[data-completion-label] > span");
  await expect
    .poll(() => short.evaluate((el) => el.scrollWidth <= el.clientWidth))
    .toBe(true);
  await short.hover();
  await input.press("ArrowDown");
  await input.press("ArrowUp");
  await expect(shortChoice).toHaveAttribute("aria-selected", "true");
  await expect(tooltip).toHaveCount(0);
  // Resize the same mounted query to exercise overflow updates both ways.
  const selectedId = await shortChoice.getAttribute("id");
  await page.mouse.move(0, 0);
  await input.press("ArrowDown");
  await input.press("ArrowUp");
  await page.setViewportSize({ width: 200, height: 844 });
  await expect(tooltip).toHaveText(":aonly:");
  await page.setViewportSize({ width: 1280, height: 844 });
  await expect
    .poll(() => short.evaluate((el) => el.scrollWidth <= el.clientWidth))
    .toBe(true);
  await expect(tooltip).toHaveCount(0);
  await expect(shortChoice).toHaveAttribute("id", selectedId);
  await input.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  expect(errors.unexplained()).toEqual([]);
});

test("keyboard hints stay on the active emoji while scrolling under a resting pointer", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.route("**/emoji-media/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"/>',
    }),
  );
  await page.goto("/tests/fixtures/emoji.html?completion-scroll");
  const input = page.getByRole("textbox", { name: "Message #general" });
  await input.fill(":scrolling-emoj");
  const list = page.getByRole("listbox", { name: "Emoji suggestions" });
  const choices = list.getByRole("option");
  const tooltip = page.getByRole("tooltip").and(page.locator("[data-open]"));
  await expect(choices).toHaveCount(30);
  await page.evaluate(() => {
    document.addEventListener(
      "pointermove",
      (event) => {
        window.restingEmojiPointer = {
          clientX: event.clientX,
          clientY: event.clientY,
        };
      },
      { once: true },
    );
  });
  await choices.first().locator("[data-completion-label]").hover();
  await expect(tooltip).toHaveText(
    ":scrolling-emoji-with-a-long-common-name-00:",
  );
  // Continuing the query replaces its owner without any physical pointer move.
  await input.press("i");
  await expect(input).toHaveJSProperty("value", ":scrolling-emoji");
  await expect(choices).toHaveCount(30);
  // Leave the physical pointer over row zero. Arrow keys must own selection
  // even after scrolling moves different rows underneath that pointer.
  for (let index = 1; index <= 20; index++) {
    await input.press("ArrowDown");
    if (index === 1) {
      // Linux WebKit emits this same-coordinate event during scroll. Exercise
      // it explicitly so macOS also detects a regression in input ownership.
      await choices
        .nth(8)
        .dispatchEvent(
          "pointermove",
          await page.evaluate(() => window.restingEmojiPointer),
        );
    }
    await expect(choices.nth(index)).toHaveAttribute("aria-selected", "true");
    await expect(tooltip).toHaveText(
      `:scrolling-emoji-with-a-long-common-name-${String(index).padStart(2, "0")}:`,
    );
    await expect(input).toBeFocused();
  }
  await expect
    .poll(() => list.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      choices.nth(20).evaluate((el) => {
        const row = el.getBoundingClientRect();
        const viewport = el.closest('[role="listbox"]').getBoundingClientRect();
        return row.top >= viewport.top && row.bottom <= viewport.bottom;
      }),
    )
    .toBe(true);
  await input.press("Enter");
  await expect(input).toHaveJSProperty(
    "value",
    ":scrolling-emoji-with-a-long-common-name-20: ",
  );
  await expect(tooltip).toHaveCount(0);
  await expect(input).toBeFocused();
  expect(errors.unexplained()).toEqual([]);
});
