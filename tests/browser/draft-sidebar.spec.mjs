import { test, expect } from "./fixture.mjs";
import { newChat } from "./navigation.mjs";

const solo = "33333333-3333-4333-8333-333333333333";
const team = "55555555-5555-4555-8555-555555555555";
test.use({
  productionBroker: true,
  channelIds: [solo, team],
  channelNames: { [solo]: "Alpha", [team]: "Beta" },
  soloChannels: [solo],
  ownSoloChannels: [solo],
  historyCounts: { [solo]: 2, [team]: 1 },
});

// Browser-only: real shell composition, routed exact-root editor, keyboard
// activation and dialog focus. Content/count matrices stay in the store tests.
test("Drafts below Inbox opens its draft filter and shares live counts with Solo and Team icons", async ({
  page,
  app,
}) => {
  const root = app.histories.get(`primary/${team}`)[0].id;
  const scope = `https://primary.example:${app.viewer}`;
  await page.addInitScript(
    ({ scope, solo, team, root }) => {
      for (const [key, text] of [
        [`draft:${solo}`, "Solo pending"],
        [`draft:${team}:thread:${root}`, "Team reply pending"],
      ])
        localStorage.setItem(
          `buzz-view.v1:${JSON.stringify([scope, key])}`,
          JSON.stringify(text),
        );
    },
    { scope, solo, team, root },
  );
  await page.goto(app.origin);
  await newChat(page);
  const soloRow = page.locator(`[data-solo-channel-id="${solo}"]`);
  const teamRow = page.locator(`button[data-channel-id="${team}"]`);
  await expect(soloRow.getByRole("img", { name: "1 draft" })).toBeVisible();
  await expect(teamRow.getByRole("img", { name: "1 draft" })).toBeVisible();
  // Only real layout can establish a common row-edge anchor and hover stability.
  const soloPencil = soloRow.getByRole("img", { name: "1 draft" });
  const teamPencil = teamRow.getByRole("img", { name: "1 draft" });
  const right = (icon) =>
    icon.evaluate((node) => node.getBoundingClientRect().right);
  const expectAligned = async () => {
    await expect
      .poll(async () =>
        Math.abs((await right(soloPencil)) - (await right(teamPencil))),
      )
      .toBeLessThan(1);
  };
  await expectAligned();
  const pencilRight = await right(soloPencil);
  await soloRow.hover();
  await expectAligned();
  await expect.poll(() => right(soloPencil)).toBe(pencilRight);
  const menu = page.getByRole("button", {
    name: "Actions for Alpha",
    exact: true,
  });
  await expect(menu).toBeVisible();
  expect(
    (await menu.boundingBox()).x + (await menu.boundingBox()).width,
  ).toBeLessThanOrEqual((await soloPencil.boundingBox()).x);
  await teamRow.hover();
  await expectAligned();
  const pages = page.getByRole("navigation", { name: "Pages", exact: true });
  const drafts = pages.getByRole("button", { name: /^Drafts/ });
  await expect(drafts).toHaveText("Drafts2 drafts");
  expect(await pages.getByRole("button").allTextContents()).toEqual(
    expect.arrayContaining(["Inbox", "Drafts2 drafts"]),
  );
  await drafts.focus();
  await drafts.press("Enter");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(inbox.getByRole("button", { name: "Inbox filters" })).toHaveText(
    "Drafts",
  );
  const list = inbox.getByRole("list", { name: "Drafts", exact: true });
  await list
    .getByRole("listitem")
    .filter({ hasText: "Team reply pending" })
    .getByRole("button")
    .click();
  const editor = inbox.getByRole("textbox", { name: "Reply to thread" });
  await expect(editor).toContainText("Team reply pending");
  await editor.fill("");
  await expect(drafts).toHaveText("Drafts1 draft");
  await expect(teamRow.getByRole("img", { name: "1 draft" })).toHaveCount(0);
  await inbox
    .getByRole("button", { name: "Close detail", exact: true })
    .click();
  await list
    .getByRole("listitem")
    .filter({ hasText: "Solo pending" })
    .getByRole("button")
    .click();
  await inbox
    .getByRole("button", { name: "Delete draft…", exact: true })
    .click();
  await page
    .getByRole("alertdialog", { name: "Delete draft?" })
    .getByRole("button", { name: "Delete draft", exact: true })
    .click();
  await expect(drafts).toHaveText("Drafts");
  await expect(soloRow.getByRole("img", { name: "1 draft" })).toHaveCount(0);
  await expect(inbox.getByText("No drafts", { exact: true })).toBeVisible();
});
