import { hoverMessage } from "./message-actions.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { readJournal } from "./reading.mjs";
import { npubEncode } from "nostr-tools/nip19";

test.use({
  productionBroker: true,
  dmLabels: true,
  readState: true,
  historyCounts: { alpha: 2, beta: 1 },
});

// Real shared-row/portal integration, keyboard focus and responsive geometry;
// failure, retry, identity and permission matrices stay in lower-layer tests.
test("manage a channel message, peer unread state, and its thread", async ({
  page,
  app,
}) => {
  await open(page, app);
  const mention = `[@Morgarita](nostr:${npubEncode("b".repeat(64))})`;
  const event = app.append("primary", "alpha", `${mention} whats your name`);
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  await expect(row).toBeVisible();
  const trigger = row.getByRole("button", { name: "More message actions" });
  await hoverMessage(row);
  await trigger.click();
  await page
    .getByRole("menuitem", { name: "Edit message", exact: true })
    .click();
  const editor = page.getByRole("textbox", {
    name: "Edit message",
    exact: true,
  });
  await expect(editor).toBeFocused();
  await expect(page.getByRole("dialog", { name: "Edit message" })).toHaveCount(
    0,
  );
  await expect(editor.locator('.inline-chip[data-kind="person"]')).toHaveText(
    "@Morgarita",
  );
  await expect(editor).not.toContainText("nostr:");
  await expect(page.getByRole("listbox", { name: /suggestions/i })).toHaveCount(
    0,
  );
  for (const width of [1440, 900, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await expect
      .poll(() =>
        editor.evaluate((element) => {
          // Read parent and child in the same layout, after responsive reflow.
          const bounds = element.getBoundingClientRect();
          const chip = element
            .querySelector('.inline-chip[data-kind="person"]')
            .getBoundingClientRect();
          return (
            bounds.x >= 0 &&
            bounds.right <= window.innerWidth &&
            chip.x >= bounds.x &&
            chip.right <= bounds.right
          );
        }),
      )
      .toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  await editor.press("End");
  await editor.pressSequentially("? Management corrected");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(row).toContainText("Management corrected");
  await expect
    .poll(() =>
      app.report.publications.some(({ event: item }) => item.kind === 40003),
    )
    .toBe(true);
  const saved = app.report.publications.find(
    ({ event: item }) => item.kind === 40003,
  ).event;
  expect(saved.content).toBe(
    `${mention} whats your name? Management corrected`,
  );
  expect(saved.tags.filter(([name]) => name === "p")).toEqual([]);
  await expect(page.getByText("Editing message", { exact: true })).toHaveCount(
    0,
  );
  // Own messages are excluded from notification unread; use a peer row for the toggle.
  const peer = app.append(
    "primary",
    "alpha",
    "Peer unread target",
    true,
    false,
  );
  const peerRow = page.locator(
    `[data-channel-timeline] [data-message-id="${peer.id}"]`,
  );
  await expect(peerRow).toBeVisible();
  const peerTrigger = peerRow.getByRole("button", {
    name: "More message actions",
  });
  // Automatic reading can change the action while its menu opens. Establish
  // the durable read boundary first, then exercise exact actions, not whichever
  // toggle happens to occupy the same menu row when the click is dispatched.
  await peerRow.click();
  await expect
    .poll(
      async () =>
        (await readJournal(page))?.state.frontiers["activity:alpha"] ?? 0,
    )
    .toBeGreaterThanOrEqual(peer.created_at);
  const toggle = page.getByRole("menuitem", { name: /^Mark (read|unread)$/ });
  for (const [action, next] of [
    ["Mark unread", "Mark read"],
    ["Mark read", "Mark unread"],
  ]) {
    await hoverMessage(peerRow);
    await peerTrigger.click();
    await page.getByRole("menuitem", { name: action, exact: true }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await hoverMessage(peerRow);
    await peerTrigger.click();
    await expect(toggle).toHaveText(next);
    await page.keyboard.press("Escape");
  }
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const root = thread.locator(`[data-message-id="${event.id}"]`);
  await hoverMessage(root);
  await root.getByRole("button", { name: "More message actions" }).click();
  await page
    .getByRole("menuitem", { name: "Edit message", exact: true })
    .click();
  const threadEditor = thread.getByRole("textbox", {
    name: "Edit message",
    exact: true,
  });
  await expect(threadEditor).toBeFocused();
  await threadEditor.fill("Edited from thread");
  await thread.getByRole("button", { name: "Save changes" }).click();
  await expect(root).toContainText("Edited from thread");
  await expect(row).toContainText("Edited from thread");
  await page
    .locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"]), button[aria-label="Close thread"]',
    )
    .click();
  for (const width of [900, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await row.scrollIntoViewIfNeeded();
    await hoverMessage(row);
    await trigger.click();
    await page
      .getByRole("menuitem", { name: "Delete message", exact: true })
      .click();
    const confirmation = page.getByRole("alertdialog", {
      name: "Delete message?",
    });
    await expect(confirmation).toBeVisible();
    const bounds = await confirmation.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(row).toBeVisible();
    await expect(trigger).toBeFocused();
    // Pointer cancellation retains focus, but need not reveal an unhovered
    // toolbar. Continue from that focus with the keyboard, not a hidden click.
    await page.mouse.move(0, 0);
    const actions = row.getByRole("group", { name: "Message actions" });
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("menuitem", { name: "Delete message", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(actions).toHaveCSS("opacity", "1");
  }
  await hoverMessage(row);
  await trigger.click();
  await page
    .getByRole("menuitem", { name: "Delete message", exact: true })
    .click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeFocused();
  // The row leaves before the relay records the deletion.
  await expect
    .poll(() =>
      app.report.publications.some(({ event: item }) => item.kind === 5),
    )
    .toBe(true);
  const deletion = app.report.publications.find(
    ({ event: item }) => item.kind === 5,
  ).event;
  expect(deletion.tags).toContainEqual(["e", event.id]);
  expect(deletion.pubkey).toBe(event.pubkey);
});

test("deleting a thread reply returns focus to the surviving thread composer", async ({
  page,
  app,
}) => {
  await open(page, app);
  const root = app.append("primary", "alpha", "Thread deletion root");
  const channelRow = page.locator(
    `[data-channel-timeline] [data-message-id="${root.id}"]`,
  );
  await expect(channelRow).toBeVisible();
  await hoverMessage(channelRow);
  await channelRow.getByRole("button", { name: "Reply", exact: true }).click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const reply = app.append(
    "primary",
    "alpha",
    "My thread reply",
    true,
    true,
    root.id,
  );
  const replyRow = thread.locator(`[data-message-id="${reply.id}"]`);
  await expect(replyRow).toBeVisible();
  await hoverMessage(replyRow);
  await replyRow.getByRole("button", { name: "More message actions" }).click();
  await page
    .getByRole("menuitem", { name: "Delete message", exact: true })
    .click();
  await expect(
    page.getByRole("alertdialog", { name: "Delete message?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(replyRow).toHaveCount(0);
  await expect(
    thread.getByRole("textbox", { name: "Reply to thread" }),
  ).toBeFocused();
  const rootRow = thread.locator(`[data-message-id="${root.id}"]`);
  await hoverMessage(rootRow);
  await rootRow.getByRole("button", { name: "More message actions" }).click();
  await page
    .getByRole("menuitem", { name: "Delete message", exact: true })
    .click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(channelRow).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeFocused();
});

test("DM menus edit own messages but never expose destructive actions for peers", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "Alice Fixture", exact: true })
    .click();
  const timeline = page.locator("[data-channel-timeline]");
  const channel = await timeline.getAttribute("data-channel-timeline");
  const own = app.append("primary", channel, "Own DM message");
  const row = timeline.locator(`[data-message-id="${own.id}"]`);
  await hoverMessage(row);
  await row.getByRole("button", { name: "More message actions" }).click();
  await page
    .getByRole("menuitem", { name: "Edit message", exact: true })
    .click();
  const dmEditor = page.getByRole("textbox", {
    name: "Edit message",
    exact: true,
  });
  await expect(dmEditor).toBeFocused();
  await dmEditor.fill("Corrected DM");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(row).toContainText("Corrected DM");
  const peer = app.append("primary", channel, "Peer DM message", true, false);
  const peerRow = timeline.locator(`[data-message-id="${peer.id}"]`);
  await hoverMessage(peerRow);
  await peerRow.getByRole("button", { name: "More message actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: /^Mark (read|unread)$/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Edit message", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "Delete message", exact: true }),
  ).toHaveCount(0);
});

// The actual composer-to-production-signing boundary previously rejected imeta.
test("saving an attachment caption preserves its original metadata through the broker", async ({
  page,
  app,
}) => {
  await open(page, app);
  const url = "https://fixture.test/media/report.pdf";
  // Older clients can supply minimal metadata; editing must preserve it verbatim.
  const imeta = ["imeta", `url ${url}`, "m application/pdf"];
  const link = `[report.pdf](<${url}>)`;
  const event = app.append(
    "primary",
    "alpha",
    `Original caption\n\n${link}`,
    true,
    true,
    undefined,
    undefined,
    [imeta],
  );
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  await expect(row).toBeVisible();
  await hoverMessage(row);
  await row.getByRole("button", { name: "More message actions" }).click();
  await page
    .getByRole("menuitem", { name: "Edit message", exact: true })
    .click();
  const editor = page.getByRole("textbox", {
    name: "Edit message",
    exact: true,
  });
  await expect(editor).toBeFocused();
  await editor.fill(`Corrected caption\n\n${link}`);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect
    .poll(
      () =>
        app.report.publications.filter(
          ({ event: item }) =>
            item.kind === 40003 &&
            item.tags.some(([name, id]) => name === "e" && id === event.id),
        ).length,
    )
    .toBe(1);
  const saved = app.report.publications.find(
    ({ event: item }) =>
      item.kind === 40003 &&
      item.tags.some(([name, id]) => name === "e" && id === event.id),
  ).event;
  expect(saved.content).toBe(`Corrected caption\n\n${link}`);
  expect(saved.tags.filter(([name]) => name === "imeta")).toEqual([imeta]);
  await expect(page.getByText("Editing message", { exact: true })).toHaveCount(
    0,
  );
  await expect(row).toContainText("Corrected caption");
  await expect(row.getByRole("link", { name: /report.pdf/ })).toHaveAttribute(
    "href",
    url,
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
});

// Native tab order and competing portalled modal handlers need a real browser.
test("thread media preserves its tab and draft while modal Escape restores focus", async ({
  page,
  app,
}) => {
  await page.route("https://fixture.test/media/review.png", (route) => {
    return route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y79d4sAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  });
  await open(page, app);
  const url = "https://fixture.test/media/review.png";
  const root = app.append(
    "primary",
    "alpha",
    `Review image\n\n${url}`,
    true,
    true,
    undefined,
    undefined,
    [["imeta", `url ${url}`, "m image/png"]],
  );
  const comment = app.append(
    "primary",
    "alpha",
    "My review comment",
    true,
    true,
    root.id,
  );
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${root.id}"]`,
  );
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const editor = thread.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await editor.fill("Keep this reply while reviewing media");
  const retainedEditor = await editor.elementHandle();
  const opener = thread
    .locator(`[data-message-id="${root.id}"]`)
    .getByRole("link", { name: "Open image attachment" });
  await opener.focus();
  await opener.press("Enter");
  const viewer = page.getByRole("dialog", { name: "Image viewer" });
  await expect(viewer).toBeVisible();
  const commentRow = viewer.locator(`[data-message-id="${comment.id}"]`);
  const trigger = commentRow.getByRole("button", {
    name: "More message actions",
  });
  const confirmation = page.getByRole("alertdialog", {
    name: "Delete message?",
  });
  for (const cancelWith of ["Escape", "Cancel"]) {
    await commentRow.getByText("My review comment", { exact: true }).hover();
    await trigger.click();
    await page
      .getByRole("menuitem", { name: "Delete message", exact: true })
      .click();
    const cancel = confirmation.getByRole("button", {
      name: "Cancel",
      exact: true,
    });
    const remove = confirmation.getByRole("button", {
      name: "Delete",
      exact: true,
    });
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(remove).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      confirmation.getByRole("button", { name: "Close", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(
      confirmation.getByRole("button", { name: "Close", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(remove).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(cancel).toBeFocused();
    if (cancelWith === "Escape") await page.keyboard.press("Escape");
    else await cancel.click();
    await expect(confirmation).toHaveCount(0);
    await expect(viewer).toBeVisible();
    await expect(trigger).toBeFocused();
    await expect(commentRow).toBeVisible();
  }
  // The viewer resumes keyboard ownership after confirmation dismissal.
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(editor).toHaveText("Keep this reply while reviewing media");
  expect(await retainedEditor.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  // A subsequent Escape from the thread itself still closes that tab.
  await editor.press("Escape");
  await expect(thread).toHaveCount(0);
});
