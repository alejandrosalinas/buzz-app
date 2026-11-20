import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

// A picked section emoji returns focus to the trigger, which shows the shared
// dialog-button ring however focus got there.
test.use({ productionBroker: true, savedSidebar: true });

test("picked section emoji returns focus to the ringed trigger", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("button", { name: "More actions for Team", exact: true })
    .click();
  const create = page.getByRole("dialog", { name: "New workspace" });
  await page
    .getByRole("menuitem", { name: "Create workspace", exact: true })
    .click();
  const name = create.getByRole("textbox", { name: "Name" });
  await expect(name).toBeFocused();
  const choose = create.getByRole("button", { name: "Choose section emoji" });
  await expect(choose).toBeVisible();
  await choose.click();
  const search = page.getByRole("searchbox", { name: "Search emoji" });
  await expect(search).toBeFocused();
  await search.fill("rocket");
  await page.getByRole("button", { name: "🚀", exact: true }).click();
  const trigger = create.getByRole("button", {
    name: "Change section emoji, currently 🚀",
  });
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveCSS("outline-style", "solid");
});
