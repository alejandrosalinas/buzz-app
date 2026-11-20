import { test, expect } from "./source-fixture.mjs";

// Browser-only contract: the shared settings host saves each agent independently,
// restores the choices after reload, and keeps the chooser usable in narrow panes.
test("Codex Voices persist separately through the settings host", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-library.html?settingsSync=codex", {
    waitUntil: "domcontentloaded",
  });
  await page.getByText("Ada", { exact: true }).click();
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  const pane = page.getByRole("tabpanel", { name: "Settings", exact: true });
  const voice = pane.getByRole("button", { name: "Huddle voice", exact: true });
  expect(
    await voice.evaluate((button) => {
      const pane = button.closest('[role="tabpanel"]');
      const sessions = pane?.querySelector('[aria-label="Session scope"]');
      return (
        sessions &&
        !!(
          sessions.compareDocumentPosition(button) &
          Node.DOCUMENT_POSITION_FOLLOWING
        )
      );
    }),
  ).toBe(true);
  await voice.click();
  await expect(
    page.getByRole("button", { name: "Close", exact: true }),
  ).toBeFocused();
  const chooserRows = page.getByRole("dialog", { name: "Choose voice" });
  await expect
    .poll(() =>
      chooserRows.evaluate((dialog) => {
        const rows = [
          ...dialog.querySelectorAll('.buzz-choice[data-variant="row"]'),
        ];
        return rows
          .slice(1)
          .every(
            (row, index) =>
              row.getBoundingClientRect().top >
              rows[index].getBoundingClientRect().bottom,
          );
      }),
    )
    .toBe(true);
  await expect
    .poll(() =>
      chooserRows.evaluate((dialog) => {
        const rows = dialog.querySelectorAll(
          '.buzz-choice[data-variant="row"]',
        );
        return (
          dialog.getBoundingClientRect().bottom -
          rows[rows.length - 1].getBoundingClientRect().bottom
        );
      }),
    )
    .toBeGreaterThan(8);
  const locale = page.getByRole("combobox", { name: "Language and region" });
  const defaultVoice = chooserRows.getByRole("radio", {
    name: "Codex default",
    exact: true,
  });
  await expect(defaultVoice).toHaveAccessibleDescription("Currently Cove");
  expect((await defaultVoice.boundingBox()).y).toBeLessThan(
    (await locale.boundingBox()).y,
  );
  const voicesHeading = chooserRows.getByRole("heading", { name: "Voices" });
  const firstVoice = chooserRows.getByRole("radio", { name: "Cove" });
  await expect(voicesHeading).toBeVisible();
  const headingBounds = await voicesHeading.boundingBox();
  const localeBounds = await locale.boundingBox();
  expect(headingBounds.y).toBeGreaterThan(localeBounds.y + localeBounds.height);
  expect(headingBounds.y + headingBounds.height).toBeLessThan(
    (await firstVoice.boundingBox()).y,
  );
  await expect(locale).toContainText("American English");
  await expect(
    page.getByRole("radio", { name: "Vale", exact: true }),
  ).toHaveCount(0);
  await locale.click();
  await page
    .getByRole("option", { name: "British English", exact: true })
    .click();
  await page.mouse.click(8, 8);
  await expect(chooserRows).toBeVisible();
  await expect(defaultVoice).toHaveAccessibleDescription("Currently Cove");
  await expect(
    page.getByRole("radio", { name: "Vale", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "Maple", exact: true }),
  ).toHaveCount(0);
  await locale.click();
  await page
    .getByRole("option", { name: "American English", exact: true })
    .click();
  await page.getByRole("radio", { name: "Codex default", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("dialog", { name: "Choose voice" }),
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "Maple", exact: true }),
  ).toBeChecked();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", {
      name: "Huddle voice",
      exact: true,
      includeHidden: true,
    }),
  ).toContainText("Cove · Default");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(voice).toContainText("Maple");
  await expect(voice).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Ada", { exact: true }).click();
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await expect(voice).toContainText("Maple");
  await page.getByText("Bo", { exact: true }).click();
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await expect(voice).toContainText("Cove · Default");
  await voice.click();
  await page.getByRole("radio", { name: "Cove", exact: true }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Bo", { exact: true }).click();
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await expect(voice).toContainText("Cove");
  for (const { width, dark, fontSize } of [
    { width: 1280, dark: false, fontSize: "16px" },
    { width: 390, dark: true, fontSize: "20px" },
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await page.evaluate(
      ({ dark, fontSize }) => {
        document.documentElement.classList.toggle("dark", dark);
        document.documentElement.style.fontSize = fontSize;
      },
      { dark, fontSize },
    );
    await voice.scrollIntoViewIfNeeded();
    const label = pane.getByText("Huddle voice", { exact: true });
    expect(
      await label.evaluate(
        (el) =>
          el.getBoundingClientRect().height <=
          2 * Number.parseFloat(getComputedStyle(el).lineHeight),
      ),
    ).toBe(true);
    await voice.focus();
    await expect(voice).toBeFocused();
    await page.keyboard.press("Enter");
    const chooser = page.getByRole("dialog", { name: "Choose voice" });
    await expect(chooser).toBeVisible();
    await expect(
      chooser.getByRole("radio", { name: "Cove", exact: true }),
    ).toBeChecked();
    const maple = chooser.getByRole("radio", { name: "Maple", exact: true });
    await maple.focus();
    await expect(maple).toBeFocused();
    expect(
      await chooser.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await maple.press("Space");
    await expect(maple).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(voice).toHaveText("Cove");
    await expect(voice).toBeFocused();
    await expect(pane.getByRole("button", { name: /Preview/ })).toHaveCount(0);
    expect(await pane.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
  }
});
