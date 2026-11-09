import { test, expect } from "./source-fixture.mjs";

// Glyph containment and line wrapping require a layout engine, not jsdom.
test("remote introduction contains long names while keeping ordinary words together", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 480, height: 950 });
  await page.goto("/tests/fixtures/agent-library.html?harness=hosted");
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "20px";
  });
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  await page.getByRole("menuitem", { name: "Create a new agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Create agent" });
  await dialog.getByRole("combobox", { name: "Harness" }).click();
  await page.getByRole("option", { name: "Builderlab", exact: true }).click();
  const name = "production-infrastructure-validation-automation-agent";
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await dialog
    .getByRole("button", { name: "Create agent", exact: true })
    .click();
  const intro = page.getByRole("dialog", { name: "Meet your remote agent" });
  const copy = intro.locator('[aria-hidden="true"][class*="remoteSpeechCopy"]');
  await expect(copy).toBeVisible();
  await expect
    .poll(() =>
      copy
        .locator('[class*="remoteSpeechCharacter"]')
        .last()
        .evaluate((glyph) => getComputedStyle(glyph).opacity),
    )
    .toBe("1");
  for (const theme of ["light", "dark"]) {
    for (const width of [480, 1280]) {
      await page.setViewportSize({ width, height: 950 });
      await page.evaluate((theme) => {
        document.documentElement.classList.toggle("dark", theme === "dark");
      }, theme);
      const geometry = await copy.evaluate((element, name) => {
        const bubble = element.parentElement.getBoundingClientRect();
        const words = [
          ...element.querySelectorAll('[class*="remoteSpeechWord"]'),
        ];
        const glyphs = words.flatMap((word) => [...word.children]);
        return {
          overflow: Math.max(
            0,
            ...glyphs.map((glyph) => {
              const bounds = glyph.getBoundingClientRect();
              return Math.max(
                bubble.left - bounds.left,
                bounds.right - bubble.right,
              );
            }),
          ),
          splitOrdinaryWord: words.some((word) => {
            if (word.textContent === `${name}.`) return false;
            const tops = [...word.children].map(
              (glyph) => glyph.getBoundingClientRect().top,
            );
            return Math.max(...tops) - Math.min(...tops) > 1;
          }),
        };
      }, name);
      expect(geometry.overflow).toBeLessThanOrEqual(1);
      expect(geometry.splitOrdinaryWord).toBe(false);
    }
  }
});

test("agent creation waits for owner review in the existing editable form", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-library.html?review");
  const dialog = page.getByRole("dialog", { name: "Create agent" });
  const name = dialog.getByRole("textbox", { name: "Name", exact: true });
  await expect(name).toHaveValue("Child");
  await expect(name).toBeFocused();
  await expect(dialog).toContainText(
    "Parent requested this agent. Review its settings",
  );
  expect(await page.evaluate(() => window.creationReviewResult())).toEqual([]);
  for (const theme of ["light", "dark"]) {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 950 });
      await page.evaluate((theme) => {
        document.documentElement.classList.toggle("dark", theme === "dark");
        document.documentElement.style.fontSize = "20px";
      }, theme);
      await expect(name).toBeInViewport();
      await expect(
        dialog.getByRole("button", { name: "Create agent", exact: true }),
      ).toBeInViewport();
    }
  }
  await name.fill("Reviewed");
  await dialog
    .getByRole("button", { name: "Create agent", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.creationReviewResult())).toEqual([
    expect.objectContaining({ name: "Reviewed", type: "fixture/agent" }),
  ]);
});

test("failed agent creation keeps its error above sticky actions and allows retry", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 420 });
  await page.goto("/tests/fixtures/agent-library.html?review&fail");
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "20px";
  });
  const dialog = page.getByRole("dialog", { name: "Create agent" });
  await dialog
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Reviewed");
  const create = dialog.getByRole("button", {
    name: "Create agent",
    exact: true,
  });
  await create.click();
  const alert = dialog.getByRole("alert");
  await expect(alert).toHaveText("Credential store refused");
  await expect
    .poll(() =>
      alert.evaluate((element) => {
        const dialog = element.closest('[role="dialog"]');
        const header = dialog.querySelector(".buzz-dialog-header");
        const footer = dialog.querySelector(".buzz-dialog-actions");
        const error = element.getBoundingClientRect();
        return (
          error.top >= header.getBoundingClientRect().bottom &&
          error.bottom <= footer.getBoundingClientRect().top
        );
      }),
    )
    .toBe(true);
  await create.click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.creationReviewResult())).toEqual([
    expect.objectContaining({ name: "Reviewed", type: "fixture/agent" }),
  ]);
});
