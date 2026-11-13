import { closeSettings, openPage, settingsDialog } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

test.use({ historyCounts: { alpha: 1, beta: 0 } });
test("completion menu stays reachable in the production channel layout", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  for (const [width, height] of [
    [1280, 832],
    [800, 600],
    [480, 400],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await input.fill(":sm");
    const option = page.getByRole("option").first();
    await expect(option).toBeVisible();
    await expect
      .poll(() =>
        option.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return el.contains(
            document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
          );
        }),
      )
      .toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`completion-${width}x${height}.png`),
    });
    await option.click();
    await expect(input).toBeFocused();
    await expect(input).not.toHaveJSProperty("value", ":sm");
  }
});

test("host shortcuts coexist with an open completion menu and preserve its draft", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  const modifier = (await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform),
  ))
    ? "Meta"
    : "Control";
  await input.fill(":smile");
  await expect(page.getByRole("option").first()).toContainText(":smile:");
  await input.press(`${modifier}+=`);
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--buzz-text-scale"),
      ),
    )
    .toBe("1.1");
  await expect(input).toHaveJSProperty("value", ":smile");
  await expect(input).toBeFocused();
  await input.press("Tab");
  await expect(input).toHaveJSProperty("value", "😄 ");
  await input.fill(":smile");
  await expect(page.getByRole("option").first()).toBeVisible();
  await input.press(`${modifier}+,`);
  await expect(settingsDialog(page)).toBeVisible();
  // The conversation stays mounted behind Settings; its menu must not.
  await expect(page.getByRole("listbox", { includeHidden: true })).toHaveCount(
    0,
  );
  await closeSettings(page);
  await expect(input).toHaveJSProperty("value", ":smile");
  // Draft persistence restores text, not selection. Establish the query caret
  // through the editor API; native End can race focus/selection reconciliation.
  await input.focus();
  await input.evaluate((el) =>
    el.setSelectionRange(el.value.length, el.value.length),
  );
  await expect(input).toBeFocused();
  await expect
    .poll(() => input.evaluate((el) => [el.selectionStart, el.selectionEnd]))
    .toEqual([6, 6]);
  await expect(page.getByRole("option").first()).toContainText(":smile:");
  await input.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(input).toHaveJSProperty("value", ":smile");
});
