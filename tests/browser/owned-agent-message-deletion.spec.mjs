import { hoverMessage } from "./message-actions.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { animationsSettled } from "./animations.mjs";

const opened = async (menu) => {
  await expect(menu).toBeVisible();
  await animationsSettled(menu, { subtree: true });
};
test.use({
  productionBroker: true,
  readState: true,
  historyCounts: { alpha: 2, beta: 1 },
  agentMessageDeletion: true,
  viewport: { width: 1280, height: 720 },
  video: "on",
});

test("the verified owner confirms a NIP-09 delete for an agent message", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  const event = app.ownerAgentMessage;
  expect(event).toBeTruthy();
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await hoverMessage(row);
  await row.getByRole("button", { name: "More message actions" }).click();
  const action = page.getByRole("menuitem", {
    name: "Delete message",
    exact: true,
  });
  await expect(action).toBeVisible();
  const actionMenu = page.getByRole("menu");
  await opened(actionMenu);
  await page.screenshot({
    path: testInfo.outputPath("owned-agent-delete-menu.png"),
  });
  await action.click();

  const confirmation = page.getByRole("alertdialog", {
    name: "Delete message?",
  });
  await expect(confirmation).toBeVisible();
  await expect(
    confirmation.getByRole("heading", { name: "Delete message?" }),
  ).toBeVisible();
  await expect(confirmation).toContainText(
    "This requests removal of this message from Buzz’s relay.",
  );
  await expect(confirmation).toContainText("People may still have copies.");
  await expect(
    confirmation.getByRole("button", { name: "Cancel" }),
  ).toBeFocused();
  await animationsSettled(confirmation, { subtree: true });
  await expect
    .poll(() =>
      app.report.publications.filter(({ event: item }) => item.kind === 5),
    )
    .toHaveLength(0);
  await page.screenshot({
    path: testInfo.outputPath("owned-agent-delete-confirmation.png"),
  });

  // The actual recovery control must retain eligibility after its dialog closes;
  // role/ownership revocation matrices stay in the session/component tests.
  let rejected;
  await page.route("**/api/relay/**/publish", async (route) => {
    const event = route.request().postDataJSON();
    if (event.kind !== 5 || rejected) return route.continue();
    rejected = event;
    await route.fulfill({
      json: {
        accepted: false,
        event_id: event.id,
        message: "Fixture deletion refusal",
      },
    });
  });
  await confirmation
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(confirmation.getByRole("alert")).toContainText(
    "Fixture deletion refusal",
  );
  await confirmation
    .getByRole("button", { name: "Close", exact: true })
    .filter({ hasText: /^Close$/ })
    .click();
  await expect(confirmation).toHaveCount(0);
  const retry = page.getByRole("button", {
    name: "Retry message update",
    exact: true,
  });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(row).toHaveCount(0);
  await expect(confirmation).toHaveCount(0);
  // Row removal is optimistic; wait for the broker publication before reading it.
  await expect
    .poll(() =>
      app.report.publications.filter(
        ({ event: item }) =>
          item.kind === 5 &&
          item.tags.some(([name, id]) => name === "e" && id === event.id),
      ),
    )
    .toHaveLength(1);
  const deletion = app.report.publications.find(
    ({ event: item }) =>
      item.kind === 5 &&
      item.tags.some(([name, id]) => name === "e" && id === event.id),
  ).event;
  expect(deletion.id).toBe(rejected.id);
  expect(deletion.pubkey).toBe(app.viewer);
  expect(deletion.tags.filter(([name]) => name !== "client-id")).toEqual([
    ["h", "alpha"],
    ["e", event.id],
    ["k", "9"],
  ]);
  expect(app.report.unexpected).toEqual([]);
});
