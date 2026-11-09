import { test, expect } from "./source-fixture.mjs";

// Real grid + settings host wiring, focus, responsive conflict controls and a
// reload of fixture storage. The reconciliation matrix belongs in Vitest.
test("Claude grid changes reconcile with the open settings draft", async ({
  page,
}, info) => {
  // The interactive controls establish readiness; unrelated image loads do not.
  await page.goto("/tests/fixtures/agent-library.html?settingsSync", {
    waitUntil: "domcontentloaded",
  });
  await page.getByText("Ada", { exact: true }).click();
  const pane = page.getByRole("tabpanel", { name: "Identity", exact: true });
  const sidebarModel = pane.getByRole("combobox", {
    name: "Model",
    exact: true,
  });
  await expect(sidebarModel).toBeVisible();
  const gridModel = page
    .getByRole("gridcell", { name: "Ada", exact: true })
    .getByRole("combobox", { name: "Model", exact: true });
  await gridModel.click();
  await page
    .getByRole("option", { name: "Other Claude model", exact: true })
    .click();
  await expect(sidebarModel).toContainText("Other Claude model");
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(0);

  await pane
    .getByLabel("Instructions", { exact: true })
    .fill("Keep these instructions.");
  await gridModel.click();
  await page
    .getByRole("option", {
      name: "Fictional Claude model · Default",
      exact: true,
    })
    .click();
  await expect(sidebarModel).toContainText("Fictional Claude model");
  await expect(pane.getByLabel("Instructions", { exact: true })).toHaveValue(
    "Keep these instructions.",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Ada", { exact: true }).click();
  await expect(pane.getByLabel("Instructions", { exact: true })).toHaveValue(
    "Keep these instructions.",
  );
  await expect(sidebarModel).toContainText("Fictional Claude model");

  // Competing model edits must remain a deliberate choice, including at narrow
  // widths and enlarged text where the host moves the pane over the grid.
  await sidebarModel.click();
  await page.getByRole("option", { name: "Custom model", exact: true }).click();
  await page.getByRole("textbox", { name: "Model ID" }).fill("my-model");
  await page.getByRole("button", { name: "Use model", exact: true }).click();
  await gridModel.click();
  await page
    .getByRole("option", { name: "Other Claude model", exact: true })
    .click();
  const modelConflict = pane.getByRole("group", {
    name: "Model and thinking conflict",
  });
  await expect(modelConflict.getByRole("alert")).toContainText(
    "Model and thinking changed elsewhere",
  );
  await expect(modelConflict).toContainText("Latest: Other Claude model");
  await expect(modelConflict).toContainText("Yours: my-model");
  await pane
    .getByLabel("Instructions", { exact: true })
    .fill("My newer instructions");
  await page.evaluate(() =>
    window.updateFixtureInstructions(
      "Other device instructions\nKeep this second line.",
    ),
  );
  const instructionsConflict = pane.getByRole("group", {
    name: "Instructions conflict",
  });
  await instructionsConflict
    .getByRole("button", { name: "View latest instructions" })
    .click();
  await expect(instructionsConflict).toContainText("Keep this second line.");
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
    const resolve = modelConflict.getByRole("button", {
      name: "Use latest",
    });
    await resolve.scrollIntoViewIfNeeded();
    await expect(resolve).toBeVisible();
    await resolve.focus();
    await expect(resolve).toBeFocused();
    await page.screenshot({ path: info.outputPath(`conflict-${width}.png`) });
    await instructionsConflict
      .getByRole("button", { name: "Keep mine" })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`instructions-conflict-${width}.png`),
    });
    await resolve.focus();
  }
  await page.keyboard.press("Enter");
  await expect(modelConflict).toHaveCount(0);
  await expect(instructionsConflict).toBeVisible();
  await expect(sidebarModel).toContainText("Other Claude model");
  await instructionsConflict.getByRole("button", { name: "Keep mine" }).click();
  await expect(pane.getByLabel("Instructions", { exact: true })).toHaveValue(
    "My newer instructions",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(0);
});
