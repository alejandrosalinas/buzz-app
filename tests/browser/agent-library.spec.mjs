import { pauseClock } from "./clock.mjs";
import { test, expect } from "./source-fixture.mjs";

test("create-time Thinking uses each provider control in the Agents shell", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1280, height: 950 });
  await page.goto("/tests/fixtures/agent-library.html?harness");
  await page.getByRole("button", { name: "New agent" }).click();
  await page
    .getByRole("menuitem", { name: "Create a new agent", exact: true })
    .click();
  const baselineDialog = page.getByRole("dialog", { name: "Create agent" });
  await expect(
    baselineDialog.getByRole("combobox", { name: "Thinking" }),
  ).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("thinking-before.png") });

  for (const provider of ["claude", "codex"]) {
    for (const dark of [false, true]) {
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 950 });
        await page.goto(
          `/tests/fixtures/agent-library.html?thinking=${provider}`,
        );
        await page.evaluate(
          ({ dark, fontSize }) => {
            document.documentElement.classList.toggle("dark", dark);
            document.documentElement.style.fontSize = fontSize;
          },
          { dark, fontSize: width === 390 ? "20px" : "16px" },
        );

        await page.getByRole("button", { name: "New agent" }).click();
        await page
          .getByRole("menuitem", { name: "Create a new agent", exact: true })
          .click();
        const dialog = page.getByRole("dialog", { name: "Create agent" });
        await expect(dialog).toBeVisible();
        const thinking = dialog.getByRole("combobox", { name: "Thinking" });
        await expect(thinking).toBeVisible();
        await expect(thinking).toBeEnabled();
        await expect(thinking).toContainText(
          provider === "codex" ? "Low · Default" : "Automatic · Default",
        );

        await thinking.focus();
        await expect(thinking).toBeFocused();
        const clearsStickyFooter = await thinking.evaluate((element) => {
          const footer = element
            .closest(".buzz-dialog")
            ?.querySelector(".buzz-dialog-actions");
          return (
            footer != null &&
            element.getBoundingClientRect().bottom <=
              footer.getBoundingClientRect().top
          );
        });
        expect(clearsStickyFooter).toBe(true);
        await page.keyboard.press("Enter");
        const defaultOption =
          provider === "codex" ? "Low · Default" : "Automatic · Default";
        await expect(
          page.getByRole("option", { name: defaultOption }),
        ).toBeFocused();
        await page.keyboard.press("ArrowDown");
        await expect(
          page.getByRole("option", { name: "Low", exact: true }),
        ).toBeFocused();
        await page.keyboard.press("ArrowDown");
        await expect(
          page.getByRole("option", { name: "High", exact: true }),
        ).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(thinking).toContainText("High");
        if (
          (provider === "claude" && dark === false && width === 1280) ||
          (provider === "claude" && dark === true && width === 390) ||
          (provider === "codex" && dark === false && width === 390) ||
          (provider === "codex" && dark === true && width === 1280)
        ) {
          await page.screenshot({
            path: info.outputPath(
              `thinking-${provider}-${dark ? "dark" : "light"}-${width}.png`,
            ),
          });
        }
      }
    }
  }
});

// Real grid/flex sizing decides whether the slug truncates; jsdom cannot measure it.
test("long memory labels truncate within the agent pane", async ({ page }) => {
  const slug = `mem/${Array.from({ length: 3 }, () => "long-memory-label".repeat(3)).join("/")}`;
  for (const { width, fontSize, dark } of [
    { width: 360, fontSize: "20px", dark: true },
    { width: 1280, fontSize: "16px", dark: false },
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await page.goto(
      `/tests/fixtures/agent-library.html?memoryLabel=${encodeURIComponent(slug)}`,
    );
    await page.evaluate(
      ({ fontSize, dark }) => {
        document.documentElement.style.fontSize = fontSize;
        document.documentElement.classList.toggle("dark", dark);
      },
      { fontSize, dark },
    );
    await page.getByRole("tab", { name: "Memory", exact: true }).click();
    const trigger = page.getByRole("button", { name: slug, exact: true });
    await expect(trigger).toBeVisible();
    const layout = () =>
      trigger.evaluate((button) => {
        const pane = button.closest('[class*="detailsScroll"]');
        const label = button.querySelector(".truncate");
        const timestamp = button.querySelector("[title]");
        const icon = button.querySelector("span svg");
        const chevron = button.querySelector(":scope > svg");
        return {
          paneWidth: pane.clientWidth,
          scrollWidth: pane.scrollWidth,
          rowRight: button.getBoundingClientRect().right,
          paneRight: pane.getBoundingClientRect().right,
          truncated: label.scrollWidth > label.clientWidth,
          ellipsis: getComputedStyle(label).textOverflow,
          timestampRight: timestamp.getBoundingClientRect().right,
          chevronLeft: chevron.getBoundingClientRect().left,
          chevronRight: chevron.getBoundingClientRect().right,
          iconWidth: icon.getBoundingClientRect().width,
        };
      });
    const closed = await layout();
    expect(closed.scrollWidth).toBeLessThanOrEqual(closed.paneWidth);
    expect(closed.rowRight).toBeLessThanOrEqual(closed.paneRight);
    expect(closed.truncated).toBe(true);
    expect(closed.ellipsis).toBe("ellipsis");
    expect(closed.timestampRight).toBeLessThan(closed.chevronLeft);
    expect(closed.chevronRight).toBeLessThan(closed.paneRight);
    expect(closed.iconWidth).toBe((Number.parseFloat(fontSize) / 16) * 20);
    await trigger.focus();
    await trigger.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByRole("heading", { name: "Saved detail" }),
    ).toBeVisible();
    const opened = await layout();
    expect(opened.scrollWidth).toBeLessThanOrEqual(opened.paneWidth);
    await trigger.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  }
});

// Browser focus restoration, popup placement and scrolling cannot be proved in jsdom.
test("shared settings help and tab discards keep Memory scope clear", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-library.html?saveFooter");
  await page.getByRole("gridcell", { name: "Ada", exact: true }).click();
  const field = page.getByRole("textbox", {
    name: "Instructions",
    exact: true,
  });
  await field.fill("Unsaved instructions");
  const hint = page.getByRole("button", { name: /^Shared across/ });
  await hint.hover();
  const popover = page.getByRole("dialog", {
    name: "Ada’s shared settings",
  });
  await expect(popover).toContainText(
    "Ada’s name, instructions, and settings are shared across these communities:",
  );
  await expect(
    popover.getByRole("list", { name: "Communities" }),
  ).toContainText("other.example");
  await expect(
    popover.getByRole("list", { name: "Communities" }),
  ).toContainText("current.example");
  await page.mouse.move(0, 0);
  await expect(popover).toBeHidden();
  await hint.focus();
  await hint.press("Enter");
  await expect(popover).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(hint).toBeFocused();
  await page.getByRole("tab", { name: "Memory", exact: true }).click();
  const warning = page.getByRole("alertdialog", { name: "Discard changes?" });
  await expect(
    warning.getByRole("button", { name: "Keep editing" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(warning).toBeHidden();
  await expect(field).toHaveValue("Unsaved instructions");
  await page.getByRole("tab", { name: "Memory", exact: true }).click();
  await warning.getByRole("button", { name: "Discard changes" }).click();
  await expect(
    page.getByRole("tab", { name: "Memory", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByText("Memory isn't available here.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Memories stay in this community.", { exact: true }),
  ).toHaveCount(0);
  await expect(hint).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "Identity", exact: true }).click();
  await expect(field).toHaveValue("");
});

// Sticky chrome and scroll anchoring need real browser layout. The
// source fixture mounts the production Agents page, details pane and save owner.
test("settings footer opens and closes gradually without moving editing focus", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  // Dispatch every animation frame even when a loaded runner cannot render in real time.
  await page.clock.install();
  await page.goto("/tests/fixtures/agent-library.html?saveFooter");
  await page.getByRole("gridcell", { name: "Ada", exact: true }).click();
  const field = page.getByRole("textbox", {
    name: "Instructions",
    exact: true,
  });
  await field.click();
  const sample = async () =>
    page.evaluate(() => {
      const footer = document.querySelector('[class*="saveFooter"]');
      const input = document.querySelector("textarea");
      const heights = [footer.getBoundingClientRect().height];
      const positions = [input.getBoundingClientRect().top];
      let running = true;
      const frame = () => {
        heights.push(footer.getBoundingClientRect().height);
        positions.push(input.getBoundingClientRect().top);
        if (running) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      window.stopSaveSamples = () => {
        running = false;
        return { heights, positions };
      };
    });
  const expectGradual = async () => {
    const { heights, positions } = await page.evaluate(() =>
      window.stopSaveSamples(),
    );
    const range = Math.max(...heights) - Math.min(...heights);
    expect(range).toBeGreaterThan(20);
    expect(
      new Set(heights.map((height) => Math.round(height))).size,
    ).toBeGreaterThan(3);
    const steps = heights
      .slice(1)
      .map((height, index) => Math.abs(height - heights[index]));
    expect(Math.max(...steps)).toBeLessThan(range * 0.8);
    const movement = Math.max(...positions) - Math.min(...positions);
    if (movement > 4) {
      const jumps = positions
        .slice(1)
        .map((position, index) => Math.abs(position - positions[index]));
      expect(Math.max(...jumps)).toBeLessThan(movement * 0.8);
    }
    await expect(field).toBeFocused();
  };
  await pauseClock(page, 1000);
  await sample();
  await field.pressSequentially("x");
  await page.clock.runFor(400);
  const save = page.getByRole("button", {
    name: "Save",
    exact: true,
    includeHidden: true,
  });
  const frame = save.locator("../..");
  await expect
    .poll(() => frame.evaluate((element) => element.style.height))
    .toBe("auto");
  await expectGradual();
  await expect(page.getByText("Shared across")).toBeVisible();
  // The scrollport must continue beneath the hint, not cut off above it.
  expect(
    await field.evaluate((element) => {
      const scroll = element.closest('[class*="detailsScroll"]');
      const hint = scroll.querySelector('[class*="sharedSettingsNotice"]');
      return (
        scroll.getBoundingClientRect().bottom -
        hint.getBoundingClientRect().bottom
      );
    }),
  ).toBeGreaterThan(0);
  await page.clock.resume();
  await save.click({ trial: true });
  await pauseClock(page, 1000);
  await sample();
  await field.fill("");
  await page.clock.runFor(400);
  await expect
    .poll(() => frame.evaluate((element) => element.style.height))
    .toBe("0px");
  await expectGradual();
});

// Native textarea selection, internal scrolling and sticky coverage require layout.
test("opening Save keeps the active textarea line above the footer", async ({
  page,
}) => {
  const instructions = Array.from({ length: 45 }, (_, i) => `Line ${i}`).join(
    "\n",
  );
  for (const tall of [false, true]) {
    await page.emulateMedia({
      reducedMotion: tall ? "reduce" : "no-preference",
    });
    await page.goto(
      `/tests/fixtures/agent-library.html?saveFooter&instructions=${encodeURIComponent(instructions)}`,
    );
    await page.getByRole("gridcell", { name: "Ada", exact: true }).click();
    const field = page.getByRole("textbox", {
      name: "Instructions",
      exact: true,
    });
    const position = tall
      ? instructions.indexOf("Line 24")
      : instructions.length;
    await field.evaluate(
      (input, { tall, position }) => {
        if (tall) input.style.height = "1000px";
        input.focus({ preventScroll: true });
        input.setSelectionRange(position, position);
        input.scrollTop = tall ? 0 : input.scrollHeight;
        const scroll = input.closest('[class*="detailsScroll"]');
        scroll.scrollTop = scroll.scrollHeight;
        if (tall) {
          const style = getComputedStyle(input);
          const caret =
            input.getBoundingClientRect().top +
            parseFloat(style.borderTopWidth) +
            parseFloat(style.paddingTop) +
            25 * parseFloat(style.lineHeight);
          scroll.scrollTop +=
            caret - (scroll.getBoundingClientRect().bottom - 8);
        }
      },
      { tall, position },
    );
    await field.pressSequentially("!");
    const frame = page
      .getByRole("button", { name: "Save", exact: true })
      .locator("../..");
    await expect
      .poll(() => frame.evaluate((element) => element.style.height))
      .toBe("auto");
    const expectLineVisible = async (extraLines) =>
      expect
        .poll(() =>
          field.evaluate(
            (input, { tall, extraLines }) => {
              const style = getComputedStyle(input);
              const scroll = input.closest('[class*="detailsScroll"]');
              const footer = scroll.querySelector('[class*="saveFooter"]');
              const row = (tall ? 24 : 44) + extraLines;
              const caretBottom =
                input.getBoundingClientRect().top +
                parseFloat(style.borderTopWidth) +
                parseFloat(style.paddingTop) +
                (row + 1) * parseFloat(style.lineHeight) -
                input.scrollTop;
              return {
                aboveFooter:
                  caretBottom <= footer.getBoundingClientRect().top + 1,
                belowPaneTop:
                  caretBottom - parseFloat(style.lineHeight) >=
                  scroll.getBoundingClientRect().top,
              };
            },
            { tall, extraLines },
          ),
        )
        .toEqual({ aboveFooter: true, belowPaneTop: true });
    await expectLineVisible(0);
    await field.press("Enter");
    await expectLineVisible(1);
    await expect(field).toBeFocused();
    expect(
      await field.evaluate((input) => [
        input.selectionStart,
        input.selectionEnd,
      ]),
    ).toEqual([position + 2, position + 2]);
  }
});

// Real flex geometry and clipping are the contract; jsdom cannot detect text
// painting over adjacent effort labels in a constrained model trigger.
test("card model and effort labels do not overlap", async ({ page }) => {
  for (const model of ["gpt-6-sol", "gpt-6-sol-extended-context-preview"]) {
    await page.goto(
      `/tests/fixtures/agent-library.html?inheritedModel=${model}`,
    );
    const trigger = page
      .getByRole("gridcell", { name: "Ada", exact: true })
      .getByRole("button", {
        name: `Model: ${model} · Default, Automatic`,
        exact: true,
      });
    await expect(trigger).toBeVisible();
    await expect(trigger).not.toHaveText(/Default/);
    for (const theme of ["light", "dark"]) {
      for (const width of [390, 800, 1280]) {
        await page.setViewportSize({ width, height: 950 });
        for (const fontSize of [16, 20]) {
          await page.evaluate(
            ({ theme, fontSize }) => {
              document.documentElement.classList.toggle(
                "dark",
                theme === "dark",
              );
              document.documentElement.dataset.colorMode = theme;
              document.documentElement.style.fontSize = `${fontSize}px`;
            },
            { theme, fontSize },
          );
          const geometry = await trigger.evaluate((button) => {
            const model = button.querySelector(".buzz-select-value");
            const effort = button.querySelector(".text-body-sm");
            const content = model.parentElement;
            const caret = [...button.querySelectorAll("svg")].at(-1);
            return {
              effortAfterModel:
                effort.getBoundingClientRect().left >=
                model.getBoundingClientRect().right - 0.5,
              contentBeforeCaret:
                content.getBoundingClientRect().right <=
                caret.getBoundingClientRect().left + 0.5,
              contained: getComputedStyle(content).overflow === "hidden",
              modelTruncates:
                getComputedStyle(model).textOverflow === "ellipsis",
              effortTruncates:
                getComputedStyle(effort).textOverflow === "ellipsis",
            };
          });
          expect(
            geometry,
            `${model}, ${theme}, ${width}px, ${fontSize}px text`,
          ).toEqual({
            effortAfterModel: true,
            contentBeforeCaret: true,
            contained: true,
            modelTruncates: true,
            effortTruncates: true,
          });
        }
      }
    }
    await trigger.focus();
    await trigger.press("Enter");
    await expect(
      page.getByRole("menu", {
        name: "Model",
        exact: true,
      }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(
      page.getByRole("menu", {
        name: "Model",
        exact: true,
      }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
  }
});

// The real cascade and WebKit accessibility tree require a browser. Service
// concurrency, recovery and snapshot-state permutations stay in colocated tests.
test("agent cards expose selection and creation preserves focus and avatar choices", async ({
  page,
}, info) => {
  await page.goto("/tests/fixtures/agent-library.html");
  const grid = page.getByRole("grid", { name: "Agents", exact: true });
  await expect(grid.getByRole("row")).toHaveCount(3);
  const ada = grid.getByRole("gridcell", { name: "Ada", exact: true });
  await ada.focus();
  await page.keyboard.press("ArrowRight");
  await expect(ada).toHaveAttribute("aria-selected", "true");
  // Chromium models Windows high contrast; WebKit cannot emulate forced colors.
  if (info.project.name === "chromium") {
    await page.emulateMedia({ forcedColors: "active" });
    expect(
      await page.evaluate(() => matchMedia("(forced-colors: active)").matches),
    ).toBe(true);
    const model = ada.getByRole("combobox", { name: "Model", exact: true });
    await model.focus();
    await expect(model).toBeFocused();
    await expect(ada).not.toBeFocused();
    await expect(ada).toHaveAttribute("aria-selected", "true");
    await expect(ada).toHaveCSS("outline-style", "solid");
    await expect(ada).toHaveCSS("outline-width", "2px");
    await expect(ada).toHaveCSS("outline-offset", "-2px");
    await page.screenshot({
      path: info.outputPath("selected-forced-colors.png"),
    });
    // This isolated fixture has no app-root keyboard modality listener.
    await page.evaluate(() => {
      document.documentElement.dataset.keyboardNavigation = "";
    });
    await ada.focus();
    await expect(ada).toHaveCSS("outline-offset", "2px");
    await page.emulateMedia({ forcedColors: "none" });
    await page.evaluate(() => {
      delete document.documentElement.dataset.keyboardNavigation;
    });
  }
  await page.keyboard.press("ArrowRight");
  await expect(
    grid.getByRole("gridcell", { name: "Bo", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Create a new agent", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const name = dialog.getByRole("textbox", { name: "Name", exact: true });
  await expect(name).toBeFocused();
  const create = dialog.getByRole("button", {
    name: "Create agent",
    exact: true,
  });
  await expect(create).toBeDisabled();
  await name.fill("Nova");
  await expect(create).toBeEnabled();
  await name.fill("   ");
  await expect(create).toBeDisabled();
  await name.fill("");
  await expect
    .poll(() =>
      name.evaluate((field) => getComputedStyle(field).borderBottomColor),
    )
    .not.toBe("rgba(0, 0, 0, 0)");
  await page.screenshot({
    path: info.outputPath("creation-pointer-focus.png"),
  });
  for (const theme of ["light", "dark"]) {
    for (const width of [390, 768, 1280]) {
      await page.setViewportSize({ width, height: 950 });
      await page.evaluate((theme) => {
        document.documentElement.classList.toggle("dark", theme === "dark");
        document.documentElement.dataset.keyboardNavigation = "";
        document.documentElement.style.fontSize = "20px";
      }, theme);
      await name.focus();
      await expect(name).toBeFocused();
      await expect
        .poll(() =>
          name.evaluate((field) => getComputedStyle(field).borderBottomColor),
        )
        .not.toBe("rgba(0, 0, 0, 0)");
      await expect(name).toBeInViewport();
      const label = dialog
        .locator(".buzz-preference-row-label")
        .filter({ hasText: /^Model$/ });
      await expect
        .poll(() =>
          label.evaluate((element) => {
            const style = getComputedStyle(element);
            return (
              element.getBoundingClientRect().height /
              Number.parseFloat(style.lineHeight)
            );
          }),
        )
        .toBeLessThan(1.5);
      const instructions = dialog.getByRole("textbox", {
        name: "Instructions Optional",
        exact: true,
      });
      await expect(instructions).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
      await expect(instructions.locator("..")).not.toHaveClass(
        /buzz-settings-group/,
      );
      await instructions.focus();
      await expect(instructions).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
      await expect
        .poll(() =>
          instructions.evaluate(
            (element) => getComputedStyle(element).borderBottomColor,
          ),
        )
        .not.toBe("rgba(0, 0, 0, 0)");
      await page.screenshot({
        path: info.outputPath(`creation-${theme}-${width}.png`),
      });
    }
  }
  // An invalid field inside the scrollport may still be covered by sticky chrome.
  await page.setViewportSize({ width: 390, height: 700 });
  await name.evaluate((field) => {
    const popup = field.closest('[role="dialog"]');
    const header = popup.querySelector(".buzz-dialog-header");
    popup.scrollTop +=
      field.getBoundingClientRect().top - header.getBoundingClientRect().top;
  });
  await expect
    .poll(() =>
      name.evaluate((field) => {
        const header = field
          .closest('[role="dialog"]')
          .querySelector(".buzz-dialog-header");
        return (
          field.getBoundingClientRect().top <
          header.getBoundingClientRect().bottom
        );
      }),
    )
    .toBe(true);
  // Ordinary creation is gated; a direct submit still reveals invalid fields.
  await expect(create).toBeDisabled();
  await expect(name).not.toBeFocused();
  await dialog
    .getByRole("form", { name: "New agent", exact: true })
    .evaluate((form) => form.requestSubmit());
  await expect(name).toBeFocused();
  await expect(
    dialog.getByText("Add a name to create your agent", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      name.evaluate((field) => {
        const header = field
          .closest('[role="dialog"]')
          .querySelector(".buzz-dialog-header");
        return (
          field.getBoundingClientRect().top >=
          header.getBoundingClientRect().bottom
        );
      }),
    )
    .toBe(true);
  await dialog.getByRole("tab", { name: "Emoji", exact: true }).click();
  const option = dialog
    .getByRole("group", { name: "Avatar background" })
    .getByRole("button")
    .nth(1);
  await option.click();
  await dialog.getByRole("tab", { name: "Gloopies", exact: true }).click();
  await expect(
    dialog.getByRole("group", { name: "Agent avatars" }),
  ).toBeVisible();
  await dialog.getByRole("tab", { name: "Emoji", exact: true }).click();
  await expect(option).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(0, 0);
  await expect(option.locator("svg")).toHaveCSS("opacity", "1");
  await option.hover();
  await expect(option).toHaveAttribute("aria-pressed", "true");
  await expect(option.locator("svg")).toHaveCSS("opacity", "1");
});

test("owner profile keeps its pane and caret stable during inline name editing", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/fixtures/agent-library.html");
  await page.getByRole("gridcell", { name: "Ada", exact: true }).click();
  const profile = page.getByRole("region", {
    name: "Agent profile",
    exact: true,
  });
  const agents = page.getByRole("region", { name: "Agents", exact: true });
  expect((await profile.boundingBox()).y).toBe((await agents.boundingBox()).y);
  const divider = page.getByRole("separator", {
    name: "Resize main and secondary panels",
  });
  const originalWidth = (await profile.boundingBox()).width;
  const originalListWidth = (await agents.boundingBox()).width;
  const handle = await divider.boundingBox();
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(handle.x - 100, handle.y + handle.height / 2);
  await page.mouse.up();
  await expect
    .poll(async () => (await profile.boundingBox()).width)
    .toBeGreaterThan(originalWidth + 80);
  expect((await agents.boundingBox()).width).toBeLessThan(
    originalListWidth - 80,
  );
  await divider.focus();
  const draggedWidth = (await profile.boundingBox()).width;
  await divider.press("ArrowRight");
  await expect
    .poll(async () => (await profile.boundingBox()).width)
    .toBeLessThan(draggedWidth);
  const adaCard = agents.getByRole("gridcell", { name: "Ada", exact: true });
  await divider.press("End");
  const agentGrid = agents.getByRole("grid", { name: "Agents", exact: true });
  await expect
    .poll(() =>
      agentGrid.evaluate(
        (element) =>
          getComputedStyle(element.parentElement).gridTemplateColumns.split(" ")
            .length,
      ),
    )
    .toBe(1);
  expect(
    await agentGrid.evaluate(
      (element) =>
        element.parentElement.scrollWidth <= element.parentElement.clientWidth,
    ),
  ).toBe(true);
  await adaCard.focus();
  await adaCard.press("ArrowDown");
  await expect(
    agents.getByRole("gridcell", { name: "Bo", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await divider.dblclick();
  await expect
    .poll(async () => (await profile.boundingBox()).width)
    .toBe(originalWidth);

  const settings = page.getByRole("tab", { name: "Settings", exact: true });
  await settings.click();
  await expect(settings).toHaveAttribute("aria-selected", "true");
  const before = await profile.boundingBox();
  await page.screenshot({ path: info.outputPath("agent-profile.png") });
  await profile.getByRole("button", { name: "Agent profile actions" }).click();
  await page.getByRole("menuitem", { name: "Change name" }).click();
  const input = profile.getByRole("textbox", { name: "Agent name" });
  await expect(input).toBeFocused();
  await expect
    .poll(() =>
      input.evaluate((element) => getComputedStyle(element).borderBottomColor),
    )
    .toBe("rgba(0, 0, 0, 0)");
  await expect
    .poll(() => input.evaluate((el) => [el.selectionStart, el.selectionEnd]))
    .toEqual([3, 3]);
  expect((await profile.boundingBox()).height).toBe(before.height);
  await page.screenshot({
    path: info.outputPath("name-edit-pointer-focus.png"),
  });
  // This isolated fixture does not install the app's modality tracker.
  await page.evaluate(() => {
    document.documentElement.dataset.keyboardNavigation = "";
  });
  await input.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(input).toBeFocused();
  await expect
    .poll(() =>
      input.evaluate((field) => getComputedStyle(field).borderBottomColor),
    )
    .not.toBe("rgba(0, 0, 0, 0)");
  await input.fill("Ada renamed");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    profile.getByRole("heading", { name: "Ada", exact: true }),
  ).toBeVisible();
  expect((await profile.boundingBox()).height).toBe(before.height);
});

// A persisted interface size changes rem geometry; real pointer hit testing
// must keep each split action inside its own card.
test("scaled import controls keep pointer actions on their own agent", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-library.html?import");
  await page.evaluate(() => localStorage.setItem("buzz-font-scale.v1", "1.1"));
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    for (const width of [361, 800]) {
      await page.setViewportSize({ width, height: 950 });
      await page.reload();
      await expect(page.locator("html")).toHaveCSS("font-size", "17.6px");
      await page
        .getByRole("button", { name: "New agent", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Import an agent", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Import an agent",
        exact: true,
      });
      const choose = dialog.getByRole("button", {
        name: "Choose a type for Legacy 1",
        exact: true,
      });
      await choose.click();
      await page
        .getByRole("menuitemradio", { name: "Claude Code", exact: true })
        .click();
      const bounds = await choose.boundingBox();
      expect(bounds).not.toBeNull();
      await page.mouse.click(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
      );
      await expect(
        page.getByRole("menuitemradio", { name: "Claude Code", exact: true }),
      ).toBeChecked();
      expect(await page.evaluate(() => window.importTargets)).toEqual([]);
      await page
        .getByRole("menuitemradio", { name: "Alternative", exact: true })
        .click();
      const action = dialog.getByRole("button", {
        name: "Import as Alternative, Legacy 1",
        exact: true,
      });
      await expect(action).toContainText("Alternative");
      for (const control of [choose, action]) {
        const contained = await control.evaluate((button) => {
          const card = button.closest('[class*="agentCard"]');
          const box = button.getBoundingClientRect(),
            parent = card.getBoundingClientRect();
          return box.left >= parent.left && box.right <= parent.right;
        });
        expect(contained).toBe(true);
      }
      await action.click();
      await expect
        .poll(() => page.evaluate(() => window.importTargets))
        .toEqual([
          {
            source: "installed",
            pubkey: "1".repeat(64),
            type: "fixture/agent",
          },
        ]);
    }
  }
});

// Nested dialog focus, source artwork and responsive footer hit targets need
// the browser; import/preference state matrices stay in component tests.
test("team imports explain scope before running and restore the trigger on cancellation", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-font-scale.v1", "1.25"),
  );
  for (const [colorScheme, width] of [
    ["light", 361],
    ["dark", 800],
  ]) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width, height: 950 });
    await page.goto("/tests/fixtures/agent-library.html?teamImport");
    await page.getByRole("tab", { name: "Your teams", exact: true }).click();
    await page.getByRole("button", { name: "New team", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "Import a team", exact: true })
      .click();
    const trigger = page.getByRole("button", {
      name: "Import team Research",
      exact: true,
    });
    await trigger.click();
    const dialog = page.getByRole("dialog", {
      name: "Import Research",
      exact: true,
    });
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    await expect(
      dialog.getByRole("figure", { name: /^From community-/ }),
    ).toHaveCount(2);
    const bounds = await dialog.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => window.joined)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => window.joined)).toEqual([]);
    await trigger.press("Enter");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.joined))
      .toEqual(["4".repeat(64), "5".repeat(64)]);
    await expect(dialog).toBeHidden();
  }
});
