import { hoverMessage } from "./message-actions.mjs";
import { test, expect } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";
import { holdReadingFocus } from "./reading.mjs";

test.use({
  productionBroker: true,
  readState: true,
  // The viewer wrote the first thread's root; the second is a peer thread the
  // viewer never joined, so its reply is quiet until followed.
  threadUnread: true,
  historyCounts: { alpha: 20, beta: 1 },
});

test("Follow thread makes a peer thread's replies unread across reload, and Unfollow is saved for the viewer's own thread", async ({
  page,
  app,
}) => {
  await holdReadingFocus(page);
  await open(page, app);
  const roots = app.histories
    .get("primary/alpha")
    .filter((row) => row.content.startsWith("Thread root"));
  const row = (root) =>
    page.locator(`[data-channel-timeline] [data-message-id="${root.id}"]`);
  const thread = (root) =>
    row(root).getByRole("button", { name: /^View thread:/ });
  const actions = async (root) => {
    await hoverMessage(row(root));
    await row(root)
      .getByRole("button", { name: "More message actions" })
      .click();
  };
  const choose = async (root, name) => {
    await actions(root);
    await page.getByRole("menuitem", { name, exact: true }).click();
  };
  const offers = (name) =>
    expect(page.getByRole("menuitem", { name, exact: true })).toBeVisible();
  const [own, peer] = roots;
  // The owned thread's dot proves unread evaluation finished for the channel.
  await expect(thread(own)).toHaveAccessibleName(/Observed unread replies/);
  await expect(thread(peer)).toHaveAccessibleName("View thread: 23 replies");

  await choose(peer, "Follow thread");
  await expect(thread(peer)).toHaveAccessibleName(/Observed unread replies/);

  await page.reload();
  await expect(thread(own)).toHaveAccessibleName(/Observed unread replies/);
  await expect(thread(peer)).toHaveAccessibleName(/Observed unread replies/);
  await settle(page);
  await choose(peer, "Unfollow thread");
  await expect(thread(peer)).toHaveAccessibleName("View thread: 23 replies");
  // The viewer's own thread also carries a broadcast reply, which stays
  // unread like a mention, so its saved label is the observable choice.
  await choose(own, "Unfollow thread");
  // The menu changes once the choice is saved; reloading before then can
  // discard it.
  await actions(own);
  await offers("Follow thread");
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(thread(peer)).toHaveAccessibleName("View thread: 23 replies");
  await settle(page);
  await actions(own);
  await offers("Follow thread");
});
