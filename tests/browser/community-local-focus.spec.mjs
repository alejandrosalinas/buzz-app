import { test, expect } from "./source-fixture.mjs";

// Native disabled/blur behavior requires real engines, not jsdom. The fixture
// mounts the actual forms/service; IPC is held at the native boundary only.
test("local settings retain keyboard focus through save, recovery, cancel and reset without stealing it", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.isTauri = true;
    window.folderRequests = [];
    window.__TAURI_INTERNALS__ = {
      invoke(command, args) {
        if (command === "workspace_pick_folder")
          return Promise.resolve("~/Development");
        if (command === "credential_pairing_communities")
          return Promise.resolve();
        if (command !== "repositories_folder_validate")
          throw new Error(`Unexpected command: ${command}`);
        window.folderRequests.push(args.path);
        return new Promise((resolve, reject) => {
          window.finishFolder = ({ error, path }) =>
            error ? reject(error) : resolve(path);
        });
      },
    };
  });
  await page.goto("/tests/fixtures/community-local-settings.html");
  const name = page.getByLabel("Display name", { exact: true });
  const folder = page.getByLabel("Repositories folder", { exact: true });
  const button = (label) =>
    page.getByRole("button", { name: label, exact: true });
  const nameForm = name.locator("xpath=ancestor::form");
  const folderForm = folder.locator("xpath=ancestor::form");
  await name.fill("Draft");
  await nameForm.getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(name).toBeFocused();
  await name.fill("Saved name");
  await nameForm.getByRole("button", { name: "Save", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(name).toBeFocused();
  await button("Reset name").focus();
  await page.keyboard.press("Enter");
  await expect(name).toBeFocused();

  await button("Choose folder…").focus();
  await page.keyboard.press("Enter");
  await expect(folder).toHaveValue("~/Development");
  await expect(button("Choose folder…")).toBeFocused();
  await folderForm.getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(folder).toBeFocused();
  await folder.fill("/draft");
  try {
    await folder.press("Enter");
    await expect
      .poll(() => page.evaluate(() => window.folderRequests.length))
      .toBe(1);
    await expect(folder).toBeFocused();
    await expect(folder).toHaveAttribute("readonly", "");
    await page.evaluate(() =>
      window.finishFolder({ error: "Folder unavailable" }),
    );
    await expect(page.getByRole("alert")).toHaveText("Folder unavailable");
    await expect(folder).toBeFocused();
    await expect(folder).toBeEditable();

    await button("Save folder").focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => window.folderRequests.length))
      .toBe(2);
    await expect(button("Save folder")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.keyboard.press("Shift+Tab");
    await expect(
      folderForm.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    await page.evaluate(() => window.finishFolder({ path: "/draft" }));
    await expect(folderForm.getByRole("status")).toBeVisible();
    await expect(folder).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => window.folderRequests.length))
      .toBe(2);

    await button("Restore default").focus();
    await page.keyboard.press("Enter");
    await expect(folder).toHaveValue("");
    await expect(folder).toBeFocused();
    await folder.fill("/another");
    await button("Save folder").focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => window.folderRequests.length))
      .toBe(3);
    await button("Outside action").focus();
    await page.evaluate(() => window.finishFolder({ path: "/another" }));
    await expect(folderForm.getByRole("status")).toBeVisible();
    await expect(button("Outside action")).toBeFocused();
  } finally {
    await page.evaluate(() =>
      window.finishFolder?.({ error: "Fixture cleanup" }),
    );
  }
});
