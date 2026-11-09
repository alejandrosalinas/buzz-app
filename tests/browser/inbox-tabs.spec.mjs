import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import {
  openPage,
  openSettings,
  selectSettingsSection,
  chooseColorMode,
  closeSettings,
} from "./navigation.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  inboxDm: true,
  historyCounts: { alpha: 2, beta: 1 },
});

// Browser-only: the bundled page hosts the shared tab workspace. Its list stays
// the main tab while one side tab follows the rows the reader opens.
test("Inbox rows open their conversation in one side tab beside the list", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, app);
  await openPage(page, "Activity");
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  const main = inbox.getByRole("tablist", { name: "Activity tabs" });
  const side = inbox.getByRole("tablist", { name: "Panel tabs" });
  const list = inbox.getByRole("list", { name: "Activity", exact: true });
  const rows = list.getByRole("listitem");
  const expectList = async () => {
    await expect(main.getByRole("tab")).toHaveText(["Activity"]);
    await expect(
      main.getByRole("tab", { name: "Activity", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(list).toBeVisible();
    await expect(rows).toHaveCount(3);
  };
  await expectList();
  await expect(side).toHaveCount(0);
  const alpha = inbox.getByRole("region", {
    name: "Conversation in Alpha",
    exact: true,
  });
  const thread = alpha.getByRole("region", {
    name: "Thread messages",
    exact: true,
  });
  const reply = alpha.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  const roots = app.histories.get("primary/alpha");
  const root = (content) => roots.find((event) => event.content === content);

  await rows
    .filter({ hasText: "Unread reply 1" })
    .getByRole("button", { name: /^Open / })
    .click();
  await expect(side.getByRole("tab")).toHaveText(["Thread root 1"]);
  await expect(
    side.getByRole("tab", { name: "Thread root 1", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    thread.locator(`[data-message-id="${root("Thread root 1").id}"]`),
  ).toBeVisible();
  await expect(
    thread.locator("[data-message-id]").filter({ hasText: "Unread reply 1" }),
  ).toBeInViewport();
  await expect(reply).toBeVisible();
  await expectList();
  // A tab does not visit the channel; the Inbox page stays in view.
  await expect(page.getByRole("region", { name: "Channels" })).toHaveCount(0);

  await reply.fill("Thread root 1 draft");
  // Thread root 0's row shows whichever of its replies loaded as newest.
  const other = rows
    .filter({ hasText: "#Alpha" })
    .filter({ hasNotText: "Unread reply 1" });
  const shown = (await other.textContent()).includes("Broadcast reply")
    ? "Broadcast reply"
    : "Unread reply 0";
  await other.getByRole("button", { name: /^Open / }).click();
  // A plain open replaces the previous tab, so one tab follows the clicks.
  await expect(side.getByRole("tab")).toHaveText(["Thread root 0"]);
  await expect(
    thread.locator(`[data-message-id="${root("Thread root 0").id}"]`),
  ).toBeVisible();
  await expect(
    thread.locator("[data-message-id]").filter({ hasText: shown }),
  ).toBeInViewport();
  await expect(thread.getByText("Unread reply 1", { exact: true })).toHaveCount(
    0,
  );
  await expect(reply).toBeVisible();
  await expect(reply).not.toHaveText("Thread root 1 draft");
  await expectList();

  await rows
    .filter({ hasText: "Inbox DM fixture reply" })
    .getByRole("button", { name: /^Open / })
    .click();
  // A DM opens its whole conversation, not a thread.
  await expect(side.getByRole("tab")).toHaveText(["Alice Fixture"]);
  const dm = inbox.getByRole("region", {
    name: "Conversation in Alice Fixture",
    exact: true,
  });
  await expect(alpha).toHaveCount(0);
  await expect(
    dm
      .getByRole("region", { name: "Channel message history" })
      .getByText("Inbox DM fixture reply", { exact: true }),
  ).toBeVisible();
  await expect(dm.getByRole("complementary", { name: "Thread" })).toHaveCount(
    0,
  );
  await expect(dm.getByRole("textbox", { name: /^Message / })).toBeVisible();
  await expectList();

  // Reopening the first thread restores its retained draft in a fresh tab.
  await rows
    .filter({ hasText: "Unread reply 1" })
    .getByRole("button", { name: /^Open / })
    .click();
  await expect(side.getByRole("tab")).toHaveText(["Thread root 1"]);
  await expect(reply).toHaveText("Thread root 1 draft");
});

// Browser-only: the tab's menu takes its conversation to Channels, as the
// former Inbox detail pane's Open in channel did. Real layout decides that
// the channel's root row is in view and painted beside the focused thread.
test.describe("with the thread's root beyond the channel's newest page", () => {
  test.use({ threadUnreadNewerRows: 30 });
  test("an Inbox tab's menu opens its thread in its channel beside its root", async ({
    page,
    app,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page, app);
    await openPage(page, "Activity");
    const inbox = page.getByRole("region", { name: "Activity", exact: true });
    await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
    const root = app.histories
      .get("primary/alpha")
      .find((event) => event.content === "Thread root 1");
    await inbox
      .getByRole("list", { name: "Activity", exact: true })
      .getByRole("listitem")
      .filter({ hasText: "Unread reply 1" })
      .getByRole("button", { name: /^Open / })
      .click();
    // The arrival cue is transient: observe it before the channel opens.
    await page.evaluate((id) => {
      window.rootMarked = false;
      new MutationObserver(() => {
        const row = document.querySelector(
          `[data-channel-timeline="alpha"] [data-message-id="${id}"]`,
        );
        if (
          row &&
          [row, ...row.querySelectorAll("[data-highlight-surface]")].some(
            (surface) => /messageHighlight/.test(surface.className),
          )
        )
          window.rootMarked = true;
      }).observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ["class"],
      });
    }, root.id);
    // Off the channel's newest page, the tab cannot name its thread by root.
    await inbox
      .getByRole("tablist", { name: "Panel tabs" })
      .getByRole("tab", { name: /^Thread/ })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "Open in channel" }).click();
    await expect(inbox).toHaveCount(0);
    const target = await page.evaluate(
      () => history.state.buzzNavigationV1.entry.target,
    );
    expect(target.threadRootId).toBe(root.id);
    expect(target.messageId).toMatch(/^[a-f0-9]{64}$/);
    // The thread still opens at the same message, which keeps focus.
    const reply = page
      .getByRole("region", { name: "Thread messages", exact: true })
      .locator(`[data-message-id="${target.messageId}"]`);
    await expect(reply).toContainText("Unread reply 1");
    await expect(reply).toBeFocused();
    // Beside it, the channel waits to show its list at the thread's root,
    // reading the older page the fixture holds.
    await expect.poll(() => app.pending.length).toBe(1);
    expect(app.pending[0].channel).toBe("alpha");
    await expect(
      page
        .getByRole("region", { name: "Channel history", exact: true })
        .getByRole("status"),
    ).toHaveText("Loading messages…");
    await expect(reply).toBeFocused();
    app.pending.shift().release();
    const head = app.report.queries.find(
      ({ community, filter }) =>
        community === "primary" &&
        filter.top_level &&
        filter.until === undefined &&
        filter["#h"].includes("alpha"),
    );
    expect(
      app.histories.get("primary/alpha").at(-head.filter.limit).created_at,
      "the root predates the channel's newest page",
    ).toBeGreaterThan(root.created_at);
    await expect(
      page
        .locator('[data-channel-timeline="alpha"]')
        .locator(`[data-message-id="${root.id}"]`),
    ).toBeInViewport();
    await expect.poll(() => page.evaluate(() => window.rootMarked)).toBe(true);
    await expect(reply).toBeFocused();
  });
});

// Browser-only: the list's offset needs real layout. Leaving Inbox through a
// thread tab's channel name unmounts the page; Back returns to the offset the
// user chose, even away from the selected row and after rows shifted, unless
// a fresh reply moved a selected row they could see out of view while away.
// A tab moved to the main pane covers the list, which is placed once it shows.
const titles = {
  kept: "",
  moved: " around a row that moved",
  covered: " around a row that moved under a main-pane tab",
  away: " away from the selected row",
  shifted: " away from the selected row as rows shift",
  drifted: " after rows pushed the selected row out of view",
};
for (const variant of Object.keys(titles))
  test(`returning to Inbox keeps the list's place${titles[variant]}`, async ({
    page,
    app,
  }) => {
    // Mentioned threads, enough to overflow the list; later ones land live.
    const seed = (from, count, deliver) =>
      Array.from({ length: count }, (_, offset) => {
        const index = from + offset;
        const root = app.append(
          "primary",
          "beta",
          `Beta root ${index}`,
          deliver,
          false,
        );
        app.append(
          "primary",
          "beta",
          `Beta mention ${index}`,
          deliver,
          false,
          root.id,
          undefined,
          [["p", app.viewer]],
        );
        return root;
      });
    const roots = seed(0, 25, false);
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page, app);
    await openPage(page, "Activity");
    const inbox = page.getByRole("region", { name: "Activity", exact: true });
    await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
    const list = inbox.getByRole("list", { name: "Activity", exact: true });
    const scroller = list.locator("xpath=..");
    const rows = list.getByRole("listitem");
    // Scrolling past the selected row before leaving, or rows pushing it out
    // of view while the list shows, leaves it off-screen on return.
    const away = variant === "away" || variant === "shifted";
    const offscreen = away || variant === "drifted";
    const moved = variant === "moved" || variant === "covered";
    // A row near the top is in view at once; a low one needs scrolling.
    const row = rows.filter({
      hasText: offscreen ? "Beta mention 24" : "Beta mention 3",
    });
    await expect(rows).toHaveCount(28);
    if (!offscreen) {
      await expect(row).not.toBeInViewport();
      await row.scrollIntoViewIfNeeded();
    }
    await row.getByRole("button", { name: /^Open / }).click();
    const channel = inbox.getByRole("button", { name: "#Beta", exact: true });
    await expect(channel).toBeVisible();
    await expect(row).toBeInViewport();
    if (away) {
      await scroller.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(row).not.toBeInViewport();
    }
    if (variant === "drifted") {
      seed(25, 20, true);
      await expect(rows).toHaveCount(48);
      await expect(row).not.toBeInViewport();
    }
    const top = () => scroller.evaluate((element) => element.scrollTop);
    const offset = await top();
    if (variant === "drifted") expect(offset).toBe(0);
    else expect(offset).toBeGreaterThan(0);

    const main = inbox.getByRole("tablist", { name: "Activity tabs" });
    const listTab = main.getByRole("tab", { name: "Activity", exact: true });
    if (variant === "covered") {
      // Opening the thread reveals its message and focuses the row once the
      // thread has loaded. Move the tab after that, or the late reveal takes
      // focus from it.
      await expect(
        inbox
          .getByRole("region", { name: "Thread messages", exact: true })
          .locator("[data-message-id]", { hasText: "Beta mention 3" }),
      ).toBeFocused();
      await inbox
        .getByRole("tablist", { name: "Panel tabs" })
        .getByRole("tab")
        .focus();
      await page.keyboard.press("Alt+Shift+ArrowLeft");
      await expect(main.getByRole("tab")).toHaveText([
        "Activity",
        "Thread · Beta",
      ]);
      await expect(
        main.getByRole("tab", { name: "Thread · Beta", exact: true }),
      ).toBeFocused();
      await expect(listTab).toHaveAttribute("aria-selected", "false");
      await expect(channel).toBeVisible();
    }

    await channel.click();
    await expect(inbox).toHaveCount(0);
    if (moved) {
      app.append(
        "primary",
        "beta",
        "Fresh Beta mention 3",
        true,
        false,
        roots[3].id,
        undefined,
        [["p", app.viewer]],
      );
      // Delivered to the open thread, so the session has the row's move.
      await expect(
        page.getByText("Fresh Beta mention 3", { exact: true }),
      ).toBeVisible();
    }
    if (variant === "shifted") {
      // A new mentioned thread adds a row above, shifting the rest down.
      const root = app.append("primary", "beta", "Beta root 25", true, false);
      app.append(
        "primary",
        "beta",
        "Beta mention 25",
        true,
        false,
        root.id,
        undefined,
        [["p", app.viewer]],
      );
      // Delivered to the open channel, so the session has the new row.
      await expect(
        page.getByText("Beta root 25", { exact: true }),
      ).toBeVisible();
    }
    await page.getByRole("button", { name: "Go back", exact: true }).click();
    if (variant === "covered") {
      // Inbox returns under the moved tab, which renders the moved row unseen.
      await expect(listTab).toHaveAttribute("aria-selected", "false");
      await expect(
        inbox
          .getByRole("list", {
            name: "Activity",
            exact: true,
            includeHidden: true,
          })
          .getByRole("listitem", { includeHidden: true })
          .nth(1),
      ).toContainText("Fresh Beta mention 3");
      await listTab.click();
    }
    await expect(row).toHaveAttribute("data-selected", "true");
    if (moved) {
      // The newer DM fixture row stays first; the thread moved above its page.
      await expect(rows.nth(1)).toContainText("Fresh Beta mention 3");
      await expect(row).toBeInViewport();
      return;
    }
    if (variant === "shifted") await expect(rows).toHaveCount(29);
    await expect.poll(top).toBeGreaterThanOrEqual(offset - 1);
    expect(await top()).toBeLessThanOrEqual(offset + 1);
    if (offscreen) await expect(row).not.toBeInViewport();
    else await expect(row).toBeInViewport();
  });

// Browser-only: grouped reaction navigation uses the real tab workspace and exact
// message seek, with responsive toolbar geometry in both rendering engines.
test("Reaction activity turns Unread off and opens the exact message", async ({
  page,
  app,
}, testInfo) => {
  const history = app.histories.get("primary/alpha");
  const target = history.find(
    (event) => event.kind === 9 && event.pubkey === app.viewer,
  );
  expect(target).toBeTruthy();
  const reactor = generateSecretKey();
  const reaction = finalizeEvent(
    {
      kind: 7,
      content: "❤️",
      created_at: target.created_at + 100,
      tags: [
        ["h", "alpha"],
        ["e", target.id],
        ["p", app.viewer],
      ],
    },
    reactor,
  );
  history.push(reaction);
  app.relay.publish("primary", reaction, { requireSubscriber: false });
  await open(page, app);
  await openPage(page, "Activity");
  const inbox = page.getByRole("region", { name: "Activity", exact: true });
  const unread = inbox.getByRole("switch", { name: "Unread", exact: true });
  await unread.check();
  await inbox.getByRole("tab", { name: "Reactions", exact: true }).click();
  await expect(unread).not.toBeChecked();
  const row = inbox
    .getByRole("list", { name: "Activity", exact: true })
    .getByRole("listitem");
  await expect(row).toHaveCount(1);
  await expect(row).not.toHaveAttribute("data-unread", "true");
  // Rendered integration: real sidebar slot, full-colour glyph and both themes.
  const liveReaction = finalizeEvent(
    {
      kind: 7,
      content: "✅",
      created_at: reaction.created_at + 1,
      tags: [
        ["h", "alpha"],
        ["e", target.id],
        ["p", app.viewer],
      ],
    },
    reactor,
  );
  history.push(liveReaction);
  app.relay.publish("primary", liveReaction);
  const icon = page
    .getByRole("navigation", { name: "Apps dock", exact: true })
    .getByRole("tab", { name: "Activity", exact: true })
    .locator("[data-active]");
  await expect(icon).toHaveText("✅");
  await expect(icon).toHaveAttribute("aria-hidden", "true");
  await page.screenshot({ path: testInfo.outputPath("reaction-bell.png") });
  await expect(icon).toHaveCount(0);
  await page.route("**/reaction-custom.svg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#b557dd"/><path d="M8 16l5 5 11-12" stroke="white" stroke-width="4" fill="none"/></svg>',
    }),
  );
  const custom = finalizeEvent(
    {
      kind: 7,
      content: ":done:",
      created_at: reaction.created_at + 2,
      tags: [
        ["h", "alpha"],
        ["e", target.id],
        ["p", app.viewer],
        ["emoji", "done", "https://primary.example/reaction-custom.svg"],
      ],
    },
    reactor,
  );
  history.push(custom);
  app.relay.publish("primary", custom);
  await expect(icon.locator("img")).toBeVisible();
  // The dock tile is larger than a sidebar row, and so is its emoji.
  await expect(icon.locator("img")).toHaveCSS("width", "18px");
  await expect(icon.locator("img").locator("..")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: testInfo.outputPath("reaction-custom.png") });
  await expect(icon).toHaveCount(0);
  for (const theme of ["light", "dark"]) {
    await openSettings(page);
    await selectSettingsSection(page, "Appearance");
    await chooseColorMode(page, theme === "dark" ? "Dark" : "Light");
    await closeSettings(page);
    await expect(page.locator("html")).toHaveAttribute(
      "data-color-mode",
      theme,
    );
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-palette-changing",
    );
    await page.evaluate(() =>
      Promise.allSettled(
        document
          .getAnimations()
          .filter(
            (animation) =>
              animation.effect?.getComputedTiming().endTime !== Infinity,
          )
          .map((animation) => animation.finished),
      ),
    );
    await page.screenshot({
      path: testInfo.outputPath(`reaction-${theme}.png`),
    });
  }

  // Each window width leaves the dock's 66px beside the list: a 540px list at
  // 606, then 522px and 402px lists, where Unread and then From wrap.
  for (const width of [1280, 606, 588, 468]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(
      inbox.getByRole("tab", { name: "Reactions", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    const tail = row.locator('[class*="reactionTail"]');
    await expect(tail).toHaveText(/reacted ❤️ ✅/);
    await expect(tail.locator("img")).toBeVisible();
    expect(
      await tail.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const row = element.closest("li").getBoundingClientRect();
        return box.left >= row.left && box.right <= row.right;
      }),
    ).toBe(true);
    const geometry = await inbox.evaluate((element) => {
      const centerY = (selector) => {
        const box = element.querySelector(selector).getBoundingClientRect();
        return box.y + box.height / 2;
      };
      return {
        width: element.getBoundingClientRect().width,
        tabsY: centerY(
          '[role="tablist"][aria-label="Activity type"] [role="tab"]',
        ),
        fromY: centerY('button[aria-label="From anyone"]'),
        unreadY: centerY('[role="switch"][aria-label="Unread"]'),
      };
    });
    if (width === 606) {
      expect(geometry.width).toBe(540);
      expect(Math.abs(geometry.tabsY - geometry.unreadY)).toBeLessThan(3);
    } else if (width === 588) {
      expect(geometry.unreadY).toBeGreaterThan(geometry.tabsY + 20);
      expect(Math.abs(geometry.tabsY - geometry.fromY)).toBeLessThan(3);
    } else if (width === 468) {
      expect(geometry.fromY).toBeGreaterThan(geometry.tabsY + 20);
      expect(Math.abs(geometry.fromY - geometry.unreadY)).toBeLessThan(3);
    }
    await page.screenshot({
      path: testInfo.outputPath(`reaction-width-${width}.png`),
    });
  }
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "1.5"),
  );
  await expect(
    inbox.getByRole("tab", { name: "Reactions", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("reaction-enlarged.png") });
  await page.setViewportSize({ width: 1280, height: 900 });
  const sharedHeart = finalizeEvent(
    {
      kind: 7,
      content: "❤️",
      created_at: reaction.created_at + 3,
      tags: [
        ["h", "alpha"],
        ["e", target.id],
        ["p", app.viewer],
      ],
    },
    generateSecretKey(),
  );
  history.push(sharedHeart);
  app.relay.publish("primary", sharedHeart);
  await expect(row).toHaveCount(2);
  await expect(row.filter({ hasText: "reacted ❤️" })).toContainText(" and ");
  const typeTabs = inbox.getByRole("tablist", { name: "Activity type" });
  await typeTabs.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
  });
  await expect
    .poll(() =>
      typeTabs.evaluate((element) => {
        const selected = element
          .querySelector('[aria-selected="true"]')
          .getBoundingClientRect();
        const indicator = element
          .querySelector(".buzz-tabs-indicator")
          .getBoundingClientRect();
        return (
          Math.abs(selected.left - indicator.left) < 2 &&
          Math.abs(selected.width - indicator.width) < 2
        );
      }),
    )
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("reaction-shared-and-solo.png"),
  });
  await row.getByRole("button", { name: /reacted with heart/ }).click();
  await expect(
    inbox.getByRole("tablist", { name: "Panel tabs" }).getByRole("tab"),
  ).toHaveCount(1);
  await expect(inbox.locator(`[data-message-id="${target.id}"]`)).toBeVisible();
});

// Browser-only: the real virtualized timeline must reveal the exact reaction
// target inside Solo/DM conversation tabs, rather than opening isolated threads.
test.describe("reaction conversation targets", () => {
  test.use({ soloChannels: ["beta"] });
  test("Solo and DM reactions reveal their message in the existing conversation", async ({
    page,
    app,
  }) => {
    const targets = ["beta", "dm-peer"].map((channelId, index) => {
      const message = app.sign({
        kind: 9,
        content: `Acknowledged ${channelId}`,
        created_at: 1700000950 + index,
        tags: [["h", channelId]],
      });
      const reaction = finalizeEvent(
        {
          kind: 7,
          content: "❤️",
          created_at: 1700001000 + index,
          tags: [
            ["h", channelId],
            ["e", message.id],
            ["p", app.viewer],
          ],
        },
        generateSecretKey(),
      );
      app.histories.get(`primary/${channelId}`).push(message, reaction);
      for (const event of [message, reaction])
        app.relay.publish("primary", event, { requireSubscriber: false });
      return { channelId, message };
    });
    await open(page, app);
    await openPage(page, "Activity");
    const inbox = page.getByRole("region", { name: "Activity", exact: true });
    await inbox.getByRole("tab", { name: "Reactions", exact: true }).click();
    for (const { channelId, message } of targets) {
      await inbox
        .getByRole("button", {
          name: new RegExp(
            `reacted with heart to your message: Acknowledged ${channelId}$`,
          ),
        })
        .click();
      const history = inbox.getByRole("region", {
        name: "Channel message history",
      });
      await expect(history).toHaveAttribute("data-channel-timeline", channelId);
      await expect(
        history.locator(`[data-message-id="${message.id}"]`),
      ).toBeInViewport();
      await expect(
        inbox.getByRole("region", { name: "Thread messages" }),
      ).toHaveCount(0);
    }
  });
});
