import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

test.use({ productionBroker: true, savedSidebar: true, sidebarIcons: true });

// The fixture groups use custom-emoji icons; serve every one as a plain image.
test.beforeEach(({ page }) =>
  page.route("**/media?*", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" rx="4" fill="#5865f2"/></svg>',
    }),
  ),
);

test("editing a saved group's name persists and keeps its channels", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const work = page.locator('[data-sidebar-section="group:work"]');
  await expect(work.locator('[data-channel-id="beta"]')).toBeVisible();

  await page.getByRole("button", { name: "More actions for Work" }).click();
  await page.getByRole("menuitem", { name: "Workspace settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Workspace settings" });
  const input = dialog.getByRole("textbox", { name: "Workspace name" });
  await expect(input).toHaveValue("Work");
  await input.fill("Projects");
  await dialog.getByRole("button", { name: "Save changes" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(work.locator("summary")).toHaveAccessibleName("Projects");
  await expect(work.locator('[data-channel-id="beta"]')).toBeVisible();
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(1);
  const { blob } = app.report.sidebarPublications.at(-1);
  expect(blob.sections.find(({ id }) => id === "work").name).toBe("Projects");
  expect(blob.sections.find(({ id }) => id === "work").icon).toBe(":stamp:");

  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await page.reload();
  await openPage(page, "Messages");
  await expect(work.locator("summary")).toHaveAccessibleName("Projects");
});

test("section emoji edits are centered, keyboard-safe, independently removable and persistent", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const work = page.locator('[data-sidebar-section="group:work"]');
  const more = page.getByRole("button", { name: "More actions for Work" });
  const openEditor = async () => {
    await more.click();
    await page.getByRole("menuitem", { name: "Workspace settings" }).click();
    const dialog = page.getByRole("dialog", { name: "Workspace settings" });
    await expect(dialog).toBeVisible();
    return dialog;
  };
  const select = async (query, value) => {
    const trigger = page.getByRole("button", {
      name: "Change section emoji",
    });
    await trigger.click();
    const search = page.getByRole("searchbox", { name: "Search emoji" });
    await expect(search).toBeFocused();
    await search.fill(query);
    await page.getByRole("button", { name: value, exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "Emoji picker", exact: true }),
    ).toHaveCount(0);
    await expect(trigger).toBeFocused();
  };
  let dialog = await openEditor();
  const input = dialog.getByRole("textbox", { name: "Workspace name" });
  await expect(input).toHaveValue("Work");
  await expect(input).toBeEnabled();
  await input.focus();
  await expect(input).toBeFocused();
  const trigger = dialog.getByRole("button", {
    name: "Change section emoji",
  });
  await expect(trigger).toHaveAccessibleName(
    "Change section emoji, currently stamp",
  );
  await input.press("End");
  await expectIconCentered(dialog);
  await dialog.screenshot({
    path: testInfo.outputPath("edit-section-community-light.png"),
  });
  // A no-op Rename closes without publishing anything or resending a stale field.
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(more).toBeFocused();
  expect(app.report.sidebarPublications ?? []).toHaveLength(0);

  dialog = await openEditor();
  const unicodeTrigger = dialog.getByRole("button", {
    name: "Change section emoji",
  });
  await unicodeTrigger.click();
  const search = page.getByRole("searchbox", { name: "Search emoji" });
  await expect(search).toBeFocused();
  await search.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(unicodeTrigger).toBeFocused();
  await select("exclamation", "❗");
  await expectIconCentered(dialog);
  await unicodeTrigger.press("Enter");
  await expect(search).toBeFocused();
  await expectIconCentered(dialog);
  await search.press("Escape");
  await expect(unicodeTrigger).toBeFocused();
  await expectIconCentered(dialog);

  // A multi-codepoint emoji can have a wider advance than the fixed slot.
  await unicodeTrigger.click();
  await search.fill("woman technologist");
  await page.getByRole("button", { name: "👩‍💻", exact: true }).click();
  const tones = page.locator("em-emoji-picker #root > .menu");
  await expect(tones).toBeVisible();
  await tones.locator(".option").nth(3).click();
  await expect(search).toHaveCount(0);
  await expect(unicodeTrigger).toBeFocused();
  await expect(unicodeTrigger).toHaveAccessibleName(
    "Change section emoji, currently 👩🏽‍💻",
  );
  await expectIconCentered(dialog);
  await select("bus", "🚌");
  await expect(unicodeTrigger).toHaveAccessibleName(
    "Change section emoji, currently 🚌",
  );
  await expectIconCentered(dialog);
  await dialog.screenshot({
    path: testInfo.outputPath("edit-section-unicode-light.png"),
  });
  await page.evaluate(() => {
    localStorage.setItem("buzz-appearance.v1", "dark");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "buzz-appearance.v1",
        newValue: "dark",
        storageArea: localStorage,
      }),
    );
  });
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
  await dialog.screenshot({
    path: testInfo.outputPath("edit-section-unicode-dark.png"),
  });
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(work.locator("summary")).toHaveAccessibleName("Work");
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(1);
  let blob = app.report.sidebarPublications.at(-1).blob;
  expect(blob.sections.find(({ id }) => id === "work").name).toBe("Work");
  expect(blob.sections.find(({ id }) => id === "work").icon).toBe("🚌");

  dialog = await openEditor();
  await select("stamp", ":stamp:");
  await expectIconCentered(dialog);
  await dialog.screenshot({
    path: testInfo.outputPath("edit-section-community-dark.png"),
  });
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(2);
  blob = app.report.sidebarPublications.at(-1).blob;
  expect(blob.sections.find(({ id }) => id === "work").icon).toBe(":stamp:");
  await expect(work.locator("[data-sidebar-group-icon] img")).toBeVisible();

  // Keyboard removal changes only the draft; Cancel leaves the saved icon intact.
  dialog = await openEditor();
  await dialog.getByRole("button", { name: "Change section emoji" }).click();
  const picker = page.getByRole("dialog", {
    name: "Emoji picker",
    exact: true,
  });
  await expect(search).toBeFocused();
  await expectPickerBelow(dialog, picker);
  await page.screenshot({
    path: testInfo.outputPath("edit-section-picker-below-dark.png"),
    clip: { x: 480, y: 270, width: 520, height: 665 },
  });
  await search.press("Shift+Tab");
  // The shared Tabs panel is a native tab stop between its search and the action.
  await expect(picker.getByRole("tabpanel")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  const remove = picker.getByRole("button", {
    name: "Remove emoji",
    exact: true,
  });
  await expect(remove).toBeFocused();
  await remove.press("Enter");
  await expect(picker).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Choose section emoji" }),
  ).toBeFocused();
  await expect(input).toHaveValue("Work");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(app.report.sidebarPublications).toHaveLength(2);

  dialog = await openEditor();
  await expect(
    dialog.getByRole("button", { name: "Change section emoji" }),
  ).toHaveAccessibleName("Change section emoji, currently stamp");
  await dialog.getByRole("button", { name: "Change section emoji" }).click();
  await expect(search).toBeFocused();
  // A centered compact dialog still fits below at short heights. Move the real
  // dialog down within that viewport to establish a genuine bottom collision.
  await page.setViewportSize({ width: 1440, height: 650 });
  await dialog.evaluate((element) => {
    element.style.translate = "0 120px";
  });
  await expect(picker).toHaveAttribute("data-side", "top");
  await expectPickerInViewport(picker, page);
  await dialog.evaluate((element) => {
    element.style.translate = "";
  });
  await page.setViewportSize({ width: 1440, height: 950 });
  await expectPickerBelow(dialog, picker);
  await remove.click();
  await expect(picker).toHaveCount(0);
  await expect(input).toHaveValue("Work");
  await expect(
    dialog.getByRole("button", { name: "Choose section emoji" }),
  ).toBeVisible();
  await expectIconCentered(dialog);
  await expect(
    dialog.getByRole("button", { name: "Choose section emoji" }),
  ).toBeFocused();
  await dialog.screenshot({
    path: testInfo.outputPath("edit-section-removed-dark.png"),
  });
  await dialog.getByRole("button", { name: "Choose section emoji" }).click();
  await expect(search).toBeFocused();
  await expect(remove).toHaveCount(0);
  await search.press("Escape");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(3);
  blob = app.report.sidebarPublications.at(-1).blob;
  expect(blob.sections.find(({ id }) => id === "work").name).toBe("Work");
  expect(blob.sections.find(({ id }) => id === "work")).not.toHaveProperty(
    "icon",
  );
  await expect(work.locator("summary")).toHaveAccessibleName("Work");
  await expect(work.locator("[data-sidebar-group-icon]")).toHaveCount(0);
  await page.reload();
  await openPage(page, "Messages");
  await expect(work.locator("summary")).toHaveAccessibleName("Work");
  await expect(work.locator('[data-channel-id="beta"]')).toBeVisible();
  await expect(work.locator("[data-sidebar-group-icon]")).toHaveCount(0);
});

async function expectIconCentered(dialog) {
  const artwork = dialog.locator("[data-sidebar-group-icon]");
  if (await artwork.count()) {
    await expect(artwork).toBeVisible();
    const image = artwork.locator("img");
    if (await image.count()) {
      await expect(image).toBeVisible();
      await expect
        .poll(() =>
          image.evaluate((img) => img.complete && img.naturalWidth > 0),
        )
        .toBe(true);
    }
  }
  const metrics = await dialog
    .getByRole("button", {
      name: /^(?:Choose section emoji|Change section emoji, currently .+)$/,
    })
    .evaluate((button) => {
      const artwork = button.querySelector("[data-sidebar-group-icon], svg");
      const input = button.closest(".buzz-input-group")?.querySelector("input");
      if (!artwork || !input) throw new Error("Section emoji geometry missing");
      const control = button.getBoundingClientRect();
      const icon = artwork.getBoundingClientRect();
      // The fixed slot can be centered while its implicit grid track overflows.
      // Range measures text advance, not the painted emoji's optical bounds.
      const range = document.createRange();
      range.selectNodeContents(artwork);
      const content =
        artwork.firstChild?.nodeType === Node.TEXT_NODE
          ? range.getBoundingClientRect()
          : (
              artwork.querySelector("img, svg") ?? artwork
            ).getBoundingClientRect();
      const name = input.getBoundingClientRect();
      return {
        // The modest CSS nudge is Unicode-only, not a universal ink-centering gate.
        unicode: artwork.firstChild?.nodeType === Node.TEXT_NODE,
        nudge: new DOMMatrixReadOnly(
          getComputedStyle(artwork.parentElement).transform,
        ).m41,
        contentX: Math.abs(
          control.x + control.width / 2 - (content.x + content.width / 2),
        ),
        x: Math.abs(control.x + control.width / 2 - (icon.x + icon.width / 2)),
        y: Math.abs(
          control.y + control.height / 2 - (icon.y + icon.height / 2),
        ),
        nameY: Math.abs(
          control.y + control.height / 2 - (name.y + name.height / 2),
        ),
      };
    });
  expect(metrics.nudge).toBe(metrics.unicode ? 0.5 : 0);
  expect(metrics.contentX).toBeLessThanOrEqual(1);
  expect(metrics.x).toBeLessThanOrEqual(1);
  expect(metrics.y).toBeLessThanOrEqual(1);
  expect(metrics.nameY).toBeLessThanOrEqual(1);
}

async function expectPickerBelow(dialog, picker) {
  await expect(picker).toHaveAttribute("data-side", "bottom");
  // Retry until Base UI has applied its collision position, not its entry transform.
  await expect
    .poll(async () => {
      const field = await dialog.locator(".buzz-input-group").boundingBox();
      const popup = await picker.boundingBox();
      return Math.max(
        Math.abs(popup.x - field.x),
        Math.abs(popup.y - field.y - field.height - 6),
      );
    })
    .toBeLessThanOrEqual(1);
}

async function expectPickerInViewport(picker, page) {
  await expect
    .poll(async () => {
      const popup = await picker.boundingBox();
      const viewport = page.viewportSize();
      return (
        popup.x >= 0 &&
        popup.y >= 0 &&
        popup.x + popup.width <= viewport.width &&
        popup.y + popup.height <= viewport.height
      );
    })
    .toBe(true);
}
