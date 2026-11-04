import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
import { readJournal } from "./reading.mjs";

const channel = "f12918e7-88d0-4ddd-aa6b-d4888ff6d3bd";
const conversations = (inbox) =>
  inbox.getByRole("region", { name: /^Conversation in / });
const sideTabs = (inbox) =>
  inbox.getByRole("tablist", { name: "Panel tabs" }).getByRole("tab");
test.use({
  productionBroker: true,
  readState: true,
  inboxThreadWindow: true,
  agentPeers: true,
  inboxSoloAgent: true,
  pluginFixtures: true,
  channelIds: ["alpha", channel],
  channelNames: { [channel]: "Review room" },
  historyCounts: { alpha: 1, [channel]: 0 },
  screenshot: "off",
});

async function choose(page, inbox, control, option) {
  if (control === "Activity type") {
    const tab = inbox
      .getByRole("tablist", { name: "Activity type" })
      .getByRole("tab", {
        name: option === "All activity" ? "All" : option,
        exact: true,
      });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    return;
  }
  // Sender: the From menu's single choice.
  await inbox.getByRole("button", { name: /^From / }).click();
  const menu = page.getByRole("menu", { name: "From" });
  await expect(menu).toBeVisible();
  await menu
    .getByRole("menuitemradio", {
      name:
        option === "Humans"
          ? "People"
          : option === "Everyone"
            ? "Anyone"
            : option,
      exact: true,
    })
    .click();
  await expect(menu).toHaveCount(0);
}

const markedNotice = (page) =>
  page.getByRole("dialog", { name: "Marked as read", exact: true });
const unreadSwitch = (inbox) =>
  inbox.getByRole("switch", { name: "Unread", exact: true });
// Typing in a just-mounted composer's first instant can be dropped on the
// unchanged base too, which these tests do not cover: retype until it lands.
const typeDraft = (editor, text) =>
  expect(async () => {
    await editor.fill(text);
    await expect(editor).toHaveText(text, { timeout: 1000 });
  }).toPass();

test("Activity filter choices combine, persist, and hold menu focus through row updates", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(app.origin);
  await openPage(page, "Activity");
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  const rows = inbox
    .getByRole("list", { name: "Activity", exact: true })
    .getByRole("listitem");
  const trigger = inbox.getByRole("button", {
    name: /^From /,
  });

  await expect(trigger).toHaveAccessibleName("From anyone");
  await expect(rows).toHaveCount(1);
  // The unread row's ✓ waits for hover, where it takes the date's place.
  const check = rows.getByRole("button", { name: /^Mark as read / });
  await page.mouse.move(0, 0);
  await expect(check.locator("xpath=..")).toHaveCSS("opacity", "0");
  await rows.hover();
  await expect(check.locator("xpath=..")).toHaveCSS("opacity", "1");

  await choose(page, inbox, "Activity type", "Mentions");
  await choose(page, inbox, "Sender", "Agents");
  await unreadSwitch(inbox).click();
  await rows.getByRole("button", { name: /^Open / }).focus();
  await page.keyboard.press("Shift+F10");
  await expect(
    page.getByRole("menuitem", { name: "Mark unread", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("menuitem", { name: "Mark as read", exact: true })
    .click();
  // Under Unread the read row leaves; a narrowed view offers Clear filters.
  await expect(rows).toHaveCount(0);
  await expect(markedNotice(page)).toBeVisible();
  await expect(
    inbox.getByText("No unread activity in this view", { exact: true }),
  ).toBeVisible();
  await expect(
    inbox.getByRole("button", { name: "Clear filters", exact: true }),
  ).toBeVisible();
  await unreadSwitch(inbox).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.getByRole("img", { name: "Unread" })).toHaveCount(0);
  // A read row shows its date and no ✓.
  await expect(
    rows.getByRole("button", { name: /^Mark as read / }),
  ).toHaveCount(0);
  await expect(trigger).toHaveAccessibleName("From agents");
  await page.reload();
  await openPage(page, "Activity");
  await expect(rows).toHaveCount(1);
  await expect(trigger).toHaveAccessibleName("From agents");
  await expect(
    inbox
      .getByRole("tablist", { name: "Activity type" })
      .getByRole("tab", { name: "Mentions", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(unreadSwitch(inbox)).toHaveAttribute("aria-checked", "false");
  await expect(conversations(inbox)).toHaveCount(0);
  // Keep the focused From choice while relay activity updates rows.
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "From" });
  await expect(menu.getByRole("menuitemradio")).toHaveText([
    "Anyone",
    "People",
    "Agents",
  ]);
  const people = menu.getByRole("menuitemradio", {
    name: "People",
    exact: true,
  });
  // Keys before the opened menu takes focus would go to the trigger.
  await expect
    .poll(() =>
      page.evaluate(() => !!document.activeElement?.closest('[role="menu"]')),
    )
    .toBe(true);
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowUp");
  await expect(people).toBeFocused();
  app.append(
    "primary",
    channel,
    "Another review request",
    true,
    false,
    undefined,
    undefined,
    [["p", app.viewer]],
  );
  await expect(rows.getByRole("img", { name: "Unread" })).toHaveCount(1);
  await expect(people).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toHaveAccessibleName("From people");
  await expect(trigger).toBeFocused();
});

test("the toolbar keeps tabs, From and Unread on one row in a 540px list and wraps Unread first, under All", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(app.origin);
  await openPage(page, "Activity");
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  const types = inbox.getByRole("tablist", { name: "Activity type" });
  const trigger = inbox.getByRole("button", { name: /^From / });
  await expect(
    inbox
      .getByRole("list", { name: "Activity", exact: true })
      .getByRole("listitem"),
  ).toHaveCount(1);
  // Drafts left Activity: only the four activity types remain.
  await expect(types.getByRole("tab")).toHaveText([
    "All",
    "Threads",
    "Mentions",
    "DMs",
  ]);
  // From's label stays short; its name says the choice, and a fill shows a
  // narrowing choice.
  await expect(trigger).toHaveText("From");
  await expect(trigger).toHaveAccessibleName("From anyone");
  await expect(trigger).toHaveAttribute("data-variant", "ghost");
  const layout = () =>
    inbox.evaluate((root) => {
      const toolbar = root.querySelector(
        'header:has([role="tablist"][aria-label="Activity type"])',
      );
      const box = (element) => element.getBoundingClientRect().toJSON();
      const textBox = (element) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node && !node.textContent.trim()) node = walker.nextNode();
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getBoundingClientRect().toJSON();
      };
      const tab = (name) =>
        [...toolbar.querySelectorAll('[role="tab"]')].find(
          (element) => element.textContent === name,
        );
      const style = getComputedStyle(toolbar);
      return {
        pane: toolbar.parentElement.getBoundingClientRect().width,
        toolbar: box(toolbar),
        inset: parseFloat(style.paddingInlineEnd),
        tabText: textBox(tab("All")).left,
        bell: root.querySelector(".panel-header svg").getBoundingClientRect()
          .left,
        tabGap: textBox(tab("Mentions")).left - textBox(tab("Threads")).right,
        fromGap:
          textBox(toolbar.querySelector('button[aria-haspopup="menu"]')).left -
          textBox(tab("DMs")).right,
        unreadText: textBox(toolbar.querySelector(".buzz-switch")).left,
        controls: [
          '[role="tablist"][aria-label="Activity type"]',
          'button[aria-haspopup="menu"]',
          '.buzz-switch:has([role="switch"])',
        ].map((selector) => box(toolbar.querySelector(selector))),
      };
    });
  // The first tab's text starts on the title bar's bell.
  const wide = await layout();
  expect(Math.abs(wide.tabText - wide.bell)).toBeLessThan(1);
  // Size the list pane to 540px: the sidebar keeps its width as the window narrows.
  await page.setViewportSize({
    width: Math.round(1280 - (wide.pane - 540)),
    height: 720,
  });
  await expect.poll(async () => Math.round((await layout()).pane)).toBe(540);
  const mid = await layout();
  const [tabs, from, unread] = mid.controls;
  const middle = (box) => box.top + box.height / 2;
  // One row, left-aligned: tabs, then From, then Unread right after it.
  expect(Math.abs(middle(tabs) - middle(from))).toBeLessThan(2);
  expect(Math.abs(middle(tabs) - middle(unread))).toBeLessThan(2);
  // From reads as part of the tab group: about one tab gap after DMs.
  expect(from.left).toBeGreaterThan(tabs.right);
  expect(mid.fromGap - mid.tabGap).toBeLessThanOrEqual(8);
  // Unread follows From at the row's control gap, not pushed to the far edge.
  expect(unread.left).toBeGreaterThan(from.right);
  expect(unread.left - from.right).toBeLessThanOrEqual(mid.fromGap + 8);
  expect(mid.toolbar.right - mid.inset - unread.right).toBeGreaterThan(40);
  for (const width of [420, 390, 280]) {
    await page.setViewportSize({ width, height: 720 });
    await expect(trigger).toBeVisible();
    const narrow = await layout();
    const [tabs, from, unread] = narrow.controls;
    // Unread wraps first, to the start of the next line under "All"; once From
    // wraps too, it starts that line instead and Unread follows it.
    expect(unread.top).toBeGreaterThanOrEqual(tabs.bottom - 1);
    if (from.top < tabs.bottom)
      expect(Math.abs(narrow.unreadText - narrow.tabText)).toBeLessThan(1);
    else {
      expect(Math.abs(from.left - narrow.tabText)).toBeLessThan(1);
      expect(Math.abs(middle(from) - middle(unread))).toBeLessThan(2);
    }
    expect(from.left).toBeGreaterThanOrEqual(narrow.toolbar.left);
    narrow.controls.forEach((control, index) => {
      expect(control.left).toBeGreaterThanOrEqual(narrow.toolbar.left);
      expect(control.right).toBeLessThanOrEqual(narrow.toolbar.right);
      expect(control.bottom).toBeLessThanOrEqual(narrow.toolbar.bottom);
      for (const other of narrow.controls.slice(index + 1))
        expect(
          control.right <= other.left ||
            other.right <= control.left ||
            control.bottom <= other.top ||
            other.bottom <= control.top,
        ).toBe(true);
    });
  }
});

test("All caught up: Undo returns the row unread, and Show all turns Unread off", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Activity");
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  const list = inbox.getByRole("list", { name: "Activity", exact: true });
  const rows = list.getByRole("listitem");
  await expect(rows).toHaveCount(1);
  await unreadSwitch(inbox).click();
  await expect(rows).toHaveCount(1);
  await rows.hover();
  await rows.getByRole("button", { name: /^Mark as read / }).click();
  await expect(rows).toHaveCount(0);
  await expect(inbox.getByText("All caught up", { exact: true })).toBeVisible();
  await expect(
    inbox.getByText("New replies, mentions and DMs show up here.", {
      exact: true,
    }),
  ).toBeVisible();
  await markedNotice(page)
    .getByRole("button", { name: "Undo", exact: true })
    .click();
  // Undo returns it unread on this device, so Unread shows it again.
  await expect(rows).toHaveCount(1);
  await expect(rows.getByRole("img", { name: "Unread" })).toBeVisible();
  await expect(list).toHaveAttribute("aria-busy", "false");
  await rows.hover();
  await rows.getByRole("button", { name: /^Mark as read / }).click();
  await expect(rows).toHaveCount(0);
  await inbox.getByRole("button", { name: "Show all", exact: true }).click();
  await expect(unreadSwitch(inbox)).toHaveAttribute("aria-checked", "false");
  await expect(rows).toHaveCount(1);
  await expect(rows.getByRole("img", { name: "Unread" })).toHaveCount(0);
  await expect(inbox.getByRole("button", { name: /^From / })).toBeFocused();
});

// Browser coverage proves Activity/thread/composer wiring: sending leaves both open.
test("Activity sending keeps the conversation and its row open", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Activity");
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  const rows = inbox
    .getByRole("list", { name: "Activity", exact: true })
    .getByRole("listitem");
  await expect(
    inbox.getByText("Checking recent activity…", { exact: true }),
  ).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await rows.getByRole("button", { name: /^Open / }).click();
  const detail = conversations(inbox);
  const editor = detail.getByRole("textbox");
  // Let the reader settle first: typing in the composer's first instant can be
  // dropped on the unchanged base too, which this test does not cover.
  await expect(
    detail.locator(`[data-message-id="${app.inboxWindow.root.id}"]`),
  ).toBeVisible();
  await expect(
    inbox.getByRole("list", { name: "Activity", exact: true }),
  ).toHaveAttribute("aria-busy", "false");
  await typeDraft(editor, "Keep this conversation");
  await detail.getByRole("button", { name: "Send message" }).click();
  await expect(editor).toHaveText("");
  await expect(
    detail.getByText("Keep this conversation", { exact: true }),
  ).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(editor).toBeVisible();
  await expect(sideTabs(inbox)).toHaveCount(1);
});

// Browser-only: a row menu beside a live rich editor must not replace it, and
// Undo must restore the row's unread mark. Focus matrices live in InboxPage.test.tsx.
test("under Unread, a neighbor's menu Mark as read keeps the open draft and Undo restores it", async ({
  page,
  app,
}) => {
  const neighbor = app.append(
    "primary",
    channel,
    "Unread neighbor",
    false,
    false,
    undefined,
    undefined,
    [["p", app.viewer]],
  );
  await page.goto(app.origin);
  await openPage(page, "Activity");
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  const list = inbox.getByRole("list", { name: "Activity", exact: true });
  const rows = list.getByRole("listitem");
  const thread = rows.filter({ hasText: "Inbox strict reply" });
  const next = rows.filter({ hasText: "Unread neighbor" });
  await expect(rows).toHaveCount(2);
  await thread.getByRole("button", { name: /^Open / }).click();
  const editor = conversations(inbox).getByRole("textbox");
  // Let the reader settle first: typing in the composer's first instant can be
  // dropped on the unchanged base too, which this test does not cover.
  await expect(
    conversations(inbox).locator(
      `[data-message-id="${app.inboxWindow.root.id}"]`,
    ),
  ).toBeVisible();
  await expect(list).toHaveAttribute("aria-busy", "false");
  await typeDraft(editor, "Keep the open draft");
  await editor.evaluate((el) => {
    el.dataset.retentionMarker = "original-editor";
  });
  // The open conversation is read now, but stays listed under Unread.
  await unreadSwitch(inbox).click();
  await expect(rows).toHaveCount(2);
  await expect(thread).toHaveAttribute("data-selected", "true");
  await expect(next.getByRole("img", { name: "Unread" })).toBeVisible();
  await next.getByRole("button", { name: /^Open / }).focus();
  await page.keyboard.press("Shift+F10");
  await page
    .getByRole("menuitem", { name: "Mark as read", exact: true })
    .click();
  await expect(rows).toHaveCount(1);
  await expect
    .poll(
      async () =>
        (await readJournal(page)).state.frontiers[`msg:${neighbor.id}`],
    )
    .toBe(neighbor.created_at);
  // Focus the menu held moves to the remaining row; the open tab stays.
  await expect(thread.getByRole("button", { name: /^Open / })).toBeFocused();
  await expect(sideTabs(inbox)).toHaveCount(1);
  await expect(editor).toHaveText("Keep the open draft");
  await expect(editor).toHaveAttribute(
    "data-retention-marker",
    "original-editor",
  );
  await markedNotice(page)
    .getByRole("button", { name: "Undo", exact: true })
    .click();
  await expect(rows).toHaveCount(2);
  await expect(next.getByRole("img", { name: "Unread" })).toBeVisible();
  await expect(next).not.toHaveAttribute("data-selected", "true");
  await expect(editor).toHaveText("Keep the open draft");
  await expect(editor).toHaveAttribute(
    "data-retention-marker",
    "original-editor",
  );
});

// Browser-only: the row ✓ beside a live rich editor reads that row in place.
test("with Unread off, an unselected row's ✓ reads it in place and preserves the open editor", async ({
  page,
  app,
}) => {
  const neighbor = app.append(
    "primary",
    channel,
    "Unread neighbor",
    false,
    false,
    undefined,
    undefined,
    [["p", app.viewer]],
  );
  await page.goto(app.origin);
  await openPage(page, "Activity");
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  const list = inbox.getByRole("list", { name: "Activity", exact: true });
  const rows = list.getByRole("listitem");
  const thread = rows.filter({ hasText: "Inbox strict reply" });
  const next = rows.filter({ hasText: "Unread neighbor" });
  await expect(rows).toHaveCount(2);
  await thread.getByRole("button", { name: /^Open / }).click();
  const target = conversations(inbox).locator(
    `[data-message-id="${app.inboxWindow.replies[0].id}"]`,
  );
  await expect(target).toBeInViewport();
  // Finish entry reveal and its next-frame acknowledgement before taking the
  // editor/row-focus baseline; list aria-busy does not cover reader positioning.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const editor = conversations(inbox).getByRole("textbox");
  await typeDraft(editor, "Keep the unselected draft");
  await editor.evaluate((el) => {
    el.dataset.retentionMarker = "original-editor";
  });
  await expect(list).toHaveAttribute("aria-busy", "false");
  // The open conversation is read, so only the neighbor offers a ✓.
  await expect(
    thread.getByRole("button", { name: /^Mark as read / }),
  ).toHaveCount(0);
  await next.getByRole("button", { name: /^Mark as read / }).focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () =>
        (await readJournal(page)).state.frontiers[`msg:${neighbor.id}`],
    )
    .toBe(neighbor.created_at);
  await expect(rows).toHaveCount(2);
  await expect(list).toHaveAttribute("aria-busy", "false");
  await expect(next.getByRole("img", { name: "Unread" })).toHaveCount(0);
  await expect(
    next.getByRole("button", { name: /^Mark as read / }),
  ).toHaveCount(0);
  // The ✓ goes with the unread mark; its focus stays on the row.
  await expect(next.getByRole("button", { name: /^Open / })).toBeFocused();
  await expect(next).not.toHaveAttribute("data-selected", "true");
  await expect(thread).toHaveAttribute("data-selected", "true");
  await expect(sideTabs(inbox)).toHaveCount(1);
  await expect(markedNotice(page)).toHaveCount(0);
  await expect(editor).toHaveText("Keep the unselected draft");
  await expect(editor).toHaveAttribute(
    "data-retention-marker",
    "original-editor",
  );
});

test("incoming replies and mentions update the open conversation without replacing its draft", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Activity");
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  const rows = inbox
    .getByRole("list", { name: "Activity", exact: true })
    .getByRole("listitem");
  await expect(rows).toHaveCount(1);
  await rows.getByRole("button", { name: /^Open / }).click();
  const detail = conversations(inbox);
  const editor = detail.getByRole("textbox");
  // Let the reader settle first: typing in the composer's first instant can be
  // dropped on the unchanged base too, which this test does not cover.
  await expect(
    detail.locator(`[data-message-id="${app.inboxWindow.root.id}"]`),
  ).toBeVisible();
  await expect(
    inbox.getByRole("list", { name: "Activity", exact: true }),
  ).toHaveAttribute("aria-busy", "false");
  await typeDraft(editor, "Unsent mention retention draft");
  await editor.evaluate((el) => {
    el.dataset.retentionMarker = "original-composer";
  });
  const seed = app.sign({
    kind: 9,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["h", channel],
      ["e", app.inboxWindow.root.id, "", "reply"],
    ],
    content: "Current thread context",
  });
  app.histories.get(`primary/${channel}`).push(seed);
  app.relay.publish("primary", seed);
  app.append(
    "primary",
    channel,
    "Ordinary peer reply",
    true,
    false,
    app.inboxWindow.root.id,
  );
  await expect(detail).toContainText("Ordinary peer reply");
  await expect(rows).toHaveCount(1);
  await expect(editor).toHaveText("Unsent mention retention draft");
  await expect(editor).toHaveAttribute(
    "data-retention-marker",
    "original-composer",
  );
  // The conversation stays open while the type tabs change.
  await choose(page, inbox, "Activity type", "Threads");
  await choose(page, inbox, "Activity type", "Mentions");
  await expect(detail).toHaveCount(1);
  await expect(editor).toHaveText("Unsent mention retention draft");
  app.append(
    "primary",
    channel,
    "Fresh peer explicit mention",
    true,
    false,
    app.inboxWindow.root.id,
    undefined,
    [["p", app.viewer]],
  );
  await expect(detail).toContainText("Fresh peer explicit mention");
  await expect(rows).toHaveCount(1);
  await expect(editor).toHaveText("Unsent mention retention draft");
  await expect(editor).toHaveAttribute(
    "data-retention-marker",
    "original-composer",
  );
});

// Browser-only: real same-origin storage events must reconcile two mounted windows.
test("same-account windows reconcile filters without reload", async ({
  page,
  context,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Activity");
  const other = await context.newPage();
  app.watchPageErrors(other);
  try {
    await other.goto(app.origin);
    await openPage(other, "Activity");
    const inbox = page.getByRole("region", { name: "Activity", exact: true });
    const sibling = other.getByRole("region", {
      name: "Activity",
      exact: true,
    });
    const rows = inbox
      .getByRole("list", { name: "Activity", exact: true })
      .getByRole("listitem");
    const siblingRows = sibling
      .getByRole("list", { name: "Activity", exact: true })
      .getByRole("listitem");
    await expect(rows).toHaveCount(1);
    await expect(siblingRows).toHaveCount(1);
    await choose(page, inbox, "Activity type", "Mentions");
    await choose(page, inbox, "Sender", "Agents");
    await unreadSwitch(inbox).click();
    await expect(
      sibling
        .getByRole("tablist", { name: "Activity type" })
        .getByRole("tab", { name: "Mentions", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      sibling.getByRole("button", { name: /^From / }),
    ).toHaveAccessibleName("From agents");
    await expect(unreadSwitch(sibling)).toHaveAttribute("aria-checked", "true");
    await unreadSwitch(sibling).click();
    await expect(unreadSwitch(inbox)).toHaveAttribute("aria-checked", "false");
    await choose(other, sibling, "Sender", "Everyone");
    await expect(
      inbox.getByRole("button", { name: /^From / }),
    ).toHaveAccessibleName("From anyone");
    await expect(rows).toHaveCount(1);
    await expect(siblingRows).toHaveCount(1);
  } finally {
    await other.close();
  }
});
