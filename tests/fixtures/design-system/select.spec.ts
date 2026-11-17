import { expect, test } from "../../browser/playwright-test.mjs";

const viewer = "/tests/fixtures/design-system.html";

// DOM emulation cannot measure line placement or inherited line-box height.
test("model precedes inline attribution below the prose and wraps compactly", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/select`);
  await page.evaluate(() => document.fonts.ready);
  for (const mode of ["dark", "light"]) {
    const toggle = page.getByRole("button", { name: `Use ${mode} mode` });
    if (await toggle.count()) await toggle.click();
    for (const width of [390, 800]) {
      await page.setViewportSize({ width, height: 900 });
      const byline = page.locator('span[title^="Set to "] > .truncate');
      await expect(byline).toHaveCSS("white-space", "nowrap");
      await expect(byline).toHaveCSS("text-overflow", "ellipsis");
      const line = await byline.evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
        width: element.clientWidth,
        contentWidth: element.scrollWidth,
      }));
      expect(line.height).toBeCloseTo(line.lineHeight, 1);
      expect(line.contentWidth).toBeGreaterThan(line.width);
      const trigger = page.getByRole("combobox", {
        name: "Mode with description details",
      });
      await trigger.click();
      const option = page.getByRole("option", {
        name: "Automatic",
        exact: true,
      });
      await expect(option).toBeVisible();
      await expect(option).toBeFocused();
      await expect
        .poll(async () =>
          option.evaluate((element) => {
            const label = Array.from(element.querySelectorAll("*")).find(
              (span) => span.textContent === "Automatic",
            );
            const detail = element.querySelector("span[title]");
            const prose = Array.from(element.querySelectorAll("span")).find(
              (span) =>
                span.textContent ===
                "Recommended by Example Co. Use recommended settings for a balance of capability, speed, and availability.",
            );
            if (!label || !detail || !prose) return false;
            const labelBox = label.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(prose);
            const lastProse = Array.from(range.getClientRects()).at(-1);
            range.selectNodeContents(detail);
            const fragments = Array.from(range.getClientRects());
            const first = fragments[0];
            const last = fragments.at(-1);
            return (
              !!first &&
              !!last &&
              !!lastProse &&
              Math.abs(first.left - lastProse.left) < 1 &&
              first.top >= labelBox.bottom &&
              first.top >= lastProse.bottom
            );
          }),
        )
        .toBe(true);
      if (width === 390) {
        const spacing = await option
          .locator("span[title]")
          .evaluate((detail) => {
            const range = document.createRange();
            range.selectNodeContents(detail);
            const fragments = Array.from(range.getClientRects());
            const last = fragments.at(-1);
            const previous = fragments.at(-2);
            return {
              lines: fragments.length,
              step: last && previous ? last.top - previous.top : 0,
              lineHeight: Number.parseFloat(
                getComputedStyle(detail).lineHeight,
              ),
            };
          });
        expect(spacing.lines).toBeGreaterThan(2);
        expect(spacing.step).toBeCloseTo(spacing.lineHeight, 1);
      }
      await page.keyboard.press("Escape");
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await expect(trigger).toBeFocused();
    }
  }
});

// Placeholder descendants can override an inherited disabled color; real engines
// must resolve the cascade for both placeholder and selected-value controls.
test("disabled selects give placeholders, values and carets the same treatment", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/select`);
  const roleColor = (role: string) =>
    page.evaluate((role) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${role})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }, role);
  for (const mode of ["dark", "light"]) {
    const toggle = page.getByRole("button", { name: `Use ${mode} mode` });
    if (await toggle.count()) await toggle.click();
    const color = await roleColor("--text-unavailable");
    for (const width of [390, 800, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const variant of ["field", "inline", "compact", "preference"]) {
        const placeholder = page.getByRole("combobox", {
          name: `${variant} placeholder`,
          exact: true,
        });
        const selected = page.getByRole("combobox", {
          name: `${variant} value`,
          exact: true,
        });
        await expect(placeholder).toBeDisabled();
        await expect(selected).toBeDisabled();
        await expect(placeholder).toHaveCSS("color", color);
        await expect(selected).toHaveCSS("color", color);
        await expect(
          placeholder.getByText("Unavailable", { exact: true }),
        ).toHaveCSS("color", color);
        await expect(
          selected.getByText("Design studio", { exact: true }),
        ).toHaveCSS("color", color);
        await expect(placeholder.locator("svg")).toHaveCSS("color", color);
        await expect(selected.locator("svg")).toHaveCSS("color", color);
      }
    }
    // Enabled placeholders retain their quieter prompt treatment.
    const enabled = page.getByRole("combobox", {
      name: "Workspace",
      exact: true,
    });
    await expect(
      enabled.getByText("Choose a workspace", { exact: true }),
    ).toHaveCSS("color", await roleColor("--text-metadata"));
  }
});
