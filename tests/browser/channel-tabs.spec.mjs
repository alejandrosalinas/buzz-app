import { getPublicKey } from "nostr-tools";
import { hoverMessage } from "./message-actions.mjs";
import { openChannelDetails } from "./channel-details.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import {
  closeSettings,
  openPage,
  settingsDialog,
  settlePanelMotion,
} from "./navigation.mjs";

// Another person in shared Beta, so it is a conversation, not a chat with agents.
// A fixed key keeps the roster static; its profile confirms it is a person.
const teammateKey = new Uint8Array(32);
teammateKey[31] = 1;
const teammate = getPublicKey(teammateKey);

test.use({
  productionBroker: true,
  companionFixture: true,
  readState: true,
  soloChannels: ["beta"],
  sessionMembers: { beta: [teammate] },
  historyCounts: { alpha: 2, beta: 1 },
});
test.beforeEach(({ app }) => {
  app.serveProfile(teammateKey, { name: "Teammate" });
});

// Real content links, two independent editors, browser focus and signed routing
// prove the retained tab path without a test-only way to manufacture tabs.
test("middle-click closes a content tab without selecting it", async ({
  page,
  app,
}) => {
  await open(page, app);
  const main = page.getByRole("article", { name: "Conversation", exact: true });
  const link = app.append(
    "primary",
    "alpha",
    "[Open Beta](buzz://channel/beta)",
  );
  await main
    .locator(`[data-message-id="${link.id}"]`)
    .getByRole("link", { name: "Open Chat: Beta" })
    .click();
  const workspace = page.locator("[data-panel-workspace]");
  const beta = workspace.getByRole("tab", { name: "Beta", exact: true });
  await expect(beta).toBeVisible();
  await openChannelDetails(page);
  const settings = workspace.getByRole("tab", {
    name: "Channel settings",
    exact: true,
  });
  await expect(settings).toHaveAttribute("aria-selected", "true");
  // A covered tab keeps its state but leaves workspace layout until shown.
  const contentVisibility = async (tab) => {
    const pane = await tab.getAttribute("aria-controls");
    return page
      .locator(`[id="${pane}"]`)
      .evaluate((element) => getComputedStyle(element).contentVisibility);
  };
  await expect.poll(() => contentVisibility(beta)).toBe("hidden");
  await expect.poll(() => contentVisibility(settings)).toBe("visible");
  await beta.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Close all tabs", exact: true }),
  ).toBeVisible();
  // The popup can paint before its animation-frame focus handoff completes.
  await expect(page.getByRole("menu")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(beta).toBeVisible();
  const draft = main.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await draft.fill("Keep this draft");
  await beta.click({ button: "middle" });
  await expect(beta).toHaveCount(0);
  await expect(settings).toHaveAttribute("aria-selected", "true");
  await expect(draft).toBeFocused();
  await expect(draft).toHaveText("Keep this draft");
  await settings.click({ button: "middle" });
  await expect(workspace).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Channel actions", exact: true }),
  ).toBeFocused();
});

test("Open in channel takes a content tab to its conversation with its composer focused", async ({
  page,
  app,
}) => {
  await open(page, app);
  const main = page.getByRole("article", { name: "Conversation", exact: true });
  const link = app.append(
    "primary",
    "alpha",
    "[Open Beta](buzz://channel/beta)",
  );
  await main
    .locator(`[data-message-id="${link.id}"]`)
    .getByRole("link", { name: "Open Chat: Beta" })
    .click();
  await page
    .locator("[data-panel-workspace]")
    .getByRole("tab", { name: "Beta", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Open in channel", exact: true })
    .click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(
    page.evaluate(() => history.state.buzzNavigationV1.entry.target),
  ).resolves.toMatchObject({ kind: "conversation", channelId: "beta" });
  // The menu hands focus back before navigating, so the destination takes it.
  await expect(
    main.getByRole("textbox", {
      name: "Message this conversation",
      exact: true,
    }),
  ).toBeFocused();
});

test("content-opened tabs restore drafts without offering blank-tab creation", async ({
  page,
  app,
}) => {
  await open(page, app);
  const main = page.getByRole("article", { name: "Conversation", exact: true });
  const workspace = page.locator("[data-panel-workspace]");
  const split = page.getByRole("button", {
    name: "Toggle tab pane",
    exact: true,
  });
  await expect(split).toHaveCount(0);
  await expect(workspace).toHaveCount(0);
  const fullWidth = (await main.boundingBox()).width;
  const link = app.append(
    "primary",
    "alpha",
    "[Open Beta](buzz://channel/beta)",
  );
  const chip = main
    .locator(`[data-message-id="${link.id}"]`)
    .getByRole("link", { name: "Open Chat: Beta" });
  await expect(chip).toBeVisible();
  await main
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .fill("Alpha draft");
  await openChannelDetails(page);
  await chip.click();
  const beta = workspace.getByRole("region", {
    name: "Conversation in Beta",
    exact: true,
  });
  const composer = beta.getByRole("textbox", {
    name: "Message this conversation",
    exact: true,
  });
  await expect(composer).toBeVisible();
  await expect(
    workspace.getByRole("button", { name: "Add tab", exact: true }),
  ).toHaveCount(0);
  await expect(
    workspace.getByRole("region", { name: "Choose a tab" }),
  ).toHaveCount(0);
  await expect(
    main.getByRole("button", { name: "Toggle tab pane", exact: true }),
  ).toHaveCount(0);
  await expect(
    workspace.getByRole("button", { name: "Toggle tab pane", exact: true }),
  ).toBeVisible();
  const tabClose = workspace.getByRole("button", {
    name: "Close Beta tab",
    exact: true,
  });
  await expect(tabClose.locator("svg")).toHaveCSS("width", "16px");
  await composer.fill("Beta draft");
  await split.click();
  await expect(split).toBeFocused();
  await expect(workspace).toBeHidden();
  await expect
    .poll(async () => (await main.boundingBox()).width)
    .toBeCloseTo(fullWidth, 0);
  // A shell companion is independent of this channel's hidden tabs.
  await page
    .getByRole("button", { name: "Companion fixture", exact: true })
    .click();
  const account = page.getByRole("complementary", {
    name: "Companion fixture",
    exact: true,
  });
  await expect(account).toBeVisible();
  await expect(split).toHaveAttribute("aria-expanded", "false");
  await split.click();
  await expect(composer).toHaveText("Beta draft");
  await expect(account).toBeVisible();
  await account
    .getByRole("button", { name: "Close Companion fixture panel", exact: true })
    .click();
  // Settings covers the retained channel: its tabs stay mounted behind the
  // modal, inert, and are restored when Settings closes.
  await openPage(page, "Settings");
  await expect(settingsDialog(page)).toBeVisible();
  await expect(workspace).toContainText("Beta draft");
  expect(
    await workspace.evaluate(
      (el) => !!el.closest('[aria-hidden="true"], [inert]'),
    ),
  ).toBe(true);
  await closeSettings(page);
  await expect(composer).toHaveText("Beta draft");
  await expect(
    workspace.getByRole("tab", { name: "Beta", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await split.click();
  await openPage(page, "Settings");
  await expect(settingsDialog(page)).toBeVisible();
  await expect(workspace).toHaveCount(1);
  await closeSettings(page);
  await expect(workspace).toBeHidden();
  await expect(split).toHaveAttribute("aria-expanded", "false");
  await split.click();
  await chip.click();
  await expect(
    workspace.getByRole("tab", { name: "Beta", exact: true }),
  ).toHaveCount(1);
  await expect(composer).toHaveText("Beta draft");
  await composer.press("Enter");
  await expect
    .poll(() =>
      app.report.publications.some(
        ({ event }) =>
          event.kind === 9 &&
          event.content === "Beta draft" &&
          event.tags.some(([key, value]) => key === "h" && value === "beta"),
      ),
    )
    .toBe(true);
  // Solo agents answer at top level, so a Solo row starts no thread.
  const sent = beta
    .locator("[data-message-id]")
    .filter({ has: page.getByText("Beta draft", { exact: true }) });
  await hoverMessage(sent);
  await expect(
    sent.getByRole("button", { name: "Reply", exact: true }),
  ).toHaveCount(0);
  const row = main.locator(`[data-message-id="${link.id}"]`);
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  const reply = workspace.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await expect(reply).toBeFocused();
  await reply.fill("Alpha reply draft");
  // Shared Beta lists with the viewer's chats.
  await page.locator('button[data-solo-channel-id="beta"]').click();
  await expect(workspace).toHaveCount(0);
  await page.locator('button[data-channel-id="alpha"]').click();
  await expect(
    workspace.locator('[role="tab"][data-tab-value^="thread:alpha:"]'),
  ).toHaveAttribute("aria-selected", "true");
  await expect(reply).toHaveText("Alpha reply draft");
  const alphaComposer = main.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await expect(alphaComposer).toHaveText("Alpha draft");
  // Restored side content must not take focus from the main conversation.
  await expect(alphaComposer).toBeFocused();
  await workspace.getByRole("tab", { name: "Beta", exact: true }).click();
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(reply).toBeFocused();
  await expect(reply).toHaveText("Alpha reply draft");
  await workspace
    .locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:alpha:"][aria-selected="true"]) > button:not([role="tab"])',
    )
    .click();
  await workspace.getByRole("tab", { name: "Beta", exact: true }).click();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
    }, theme);
    for (const width of [1440, 800, 390]) {
      await page.setViewportSize({ width, height: 950 });
      await expect(workspace).not.toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
      await expect(composer).toBeInViewport();
    }
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  // Alpha's own thread took its details tab; reopen it for Diagnostics.
  await openChannelDetails(page);
  app.omitChannel("beta");
  await workspace
    .getByRole("tab", { name: "Channel settings", exact: true })
    .click();
  await workspace.getByText("Diagnostics", { exact: true }).click();
  await workspace
    .getByRole("button", { name: "Refresh channels", exact: true })
    .click();
  const unavailable = workspace.getByRole("tab", {
    name: "Unavailable conversation",
    exact: true,
  });
  await expect(unavailable).toBeVisible();
  await unavailable.click();
  await expect(workspace.getByRole("status")).toHaveText(
    "This conversation is no longer available.",
  );
  await expect(composer).toHaveCount(0);
  await workspace
    .getByRole("button", {
      name: "Close Unavailable conversation tab",
      exact: true,
    })
    .click();
  await workspace
    .getByRole("button", { name: "Close Channel settings tab", exact: true })
    .click();
  await expect(workspace).toHaveCount(0);
  await expect(split).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Channel actions", exact: true }),
  ).toBeFocused();
});

// Overflow and native keyboard reveal need actual tab-strip geometry. Six
// linked Solo chats supply real content tabs rather than removed blank tabs.
test.describe("crowded content tabs", () => {
  const ids = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"];
  test.use({
    channelIds: ids,
    soloChannels: ids.slice(1),
    historyCounts: Object.fromEntries(ids.map((id) => [id, 1])),
  });
  test("tab overflow stays horizontal and keyboard navigation reveals its destination", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const main = page.getByRole("article", {
      name: "Conversation",
      exact: true,
    });
    const link = app.append(
      "primary",
      "alpha",
      ids
        .slice(1)
        .map((id) => `[${id}](buzz://channel/${id})`)
        .join(" "),
    );
    const row = main.locator(`[data-message-id="${link.id}"]`);
    await row
      .getByRole("link", { name: "Open Chat: Beta", exact: true })
      .click();
    const workspace = page.locator("[data-panel-workspace]");
    const list = workspace.getByRole("tablist", { name: "Panel tabs" });
    const tabs = list.getByRole("tab");
    const header = workspace.locator(":scope > header");
    await expect(tabs).toHaveCount(1);
    await settlePanelMotion(page);
    await expect
      .poll(() => list.evaluate((el) => el.scrollWidth > el.clientWidth))
      .toBe(false);
    const initialHeader = await header.boundingBox();
    const initialTab = await tabs.first().boundingBox();
    const expectTabPosition = async () => {
      await expect
        .poll(async () => (await tabs.last().boundingBox()).y)
        .toBeCloseTo(initialTab.y, 1);
      expect((await tabs.last().boundingBox()).height).toBeCloseTo(
        initialTab.height,
        1,
      );
      expect((await header.boundingBox()).height).toBeCloseTo(
        initialHeader.height,
        1,
      );
    };
    for (const id of ids.slice(2))
      await row
        .getByRole("link", { name: `Open Chat: ${id}`, exact: true })
        .click();
    await expect(tabs).toHaveCount(6);
    await settlePanelMotion(page);
    const activeClose = workspace.getByRole("button", {
      name: "Close eta tab",
      exact: true,
    });
    const inactiveClose = workspace.getByRole("button", {
      name: "Close zeta tab",
      exact: true,
    });
    const outside = workspace.getByRole("button", {
      name: "Toggle tab pane",
      exact: true,
    });
    const thumbColor = () =>
      list.evaluate(
        (el) =>
          getComputedStyle(el, "::-webkit-scrollbar-thumb").backgroundColor,
      );
    await outside.hover();
    await expect(activeClose).toHaveCSS("opacity", "1");
    await expect(inactiveClose).toHaveCSS("opacity", "0");
    await tabs.nth(4).hover();
    await expect(inactiveClose).toHaveCSS("opacity", "1");
    await expect(activeClose).toHaveCSS("opacity", "1");
    await outside.hover();
    await expect(inactiveClose).toHaveCSS("opacity", "0");
    await expectTabPosition();
    await expect.poll(thumbColor).toBe("rgba(0, 0, 0, 0)");
    await list.hover();
    await expect.poll(thumbColor).not.toBe("rgba(0, 0, 0, 0)");
    await expectTabPosition();
    const geometry = await list.evaluate((el) => ({
      scrollbar: el.offsetHeight - el.clientHeight,
      nativeWidth: getComputedStyle(el).scrollbarWidth,
      trackHeight: getComputedStyle(el, "::-webkit-scrollbar").height,
    }));
    expect(geometry.scrollbar).toBeLessThanOrEqual(4);
    expect(geometry.nativeWidth).toBe("auto");
    expect(geometry.trackHeight).toBe("3px");
    await expect
      .poll(() => list.evaluate((el) => el.scrollWidth > el.clientWidth))
      .toBe(true);
    await expect(list).toHaveCSS("overflow-y", "hidden");
    const height = (await list.boundingBox()).height;
    await tabs.last().press("Home");
    await expect(tabs.first()).toBeFocused();
    await expect(tabs.first()).toBeInViewport();
    await expect(
      workspace.getByRole("button", { name: "Close Beta tab", exact: true }),
    ).toHaveCSS("opacity", "1");
    await expect(list).toHaveJSProperty("scrollTop", 0);
    await expectTabPosition();
    await tabs.first().press("End");
    await expect(tabs.last()).toBeFocused();
    await expect(tabs.last()).toBeInViewport();
    await expect(list).toHaveJSProperty("scrollTop", 0);
    await expectTabPosition();
    // Keyboard focus must not keep the scrollbar visible after hover leaves.
    await outside.hover();
    await expect(tabs.last()).toBeFocused();
    await expect.poll(thumbColor).toBe("rgba(0, 0, 0, 0)");
    await expectTabPosition();
    await list.hover();
    await expect.poll(thumbColor).not.toBe("rgba(0, 0, 0, 0)");
    await expectTabPosition();
    expect((await list.boundingBox()).height).toBeCloseTo(height, 1);
    await expect(tabs.last()).toHaveAccessibleName("eta");
    await tabs.last().press("Delete");
    await expect(tabs).toHaveCount(5);
    await expect(
      list.getByRole("tab", { name: "eta", exact: true }),
    ).toHaveCount(0);
    await expect(
      list.getByRole("tab", { name: "zeta", exact: true }),
    ).toBeFocused();
    // Closing the final content tab returns focus to channel actions.
    for (let remaining = 5; remaining > 0; remaining--) {
      await tabs.first().focus();
      await tabs.first().press("Delete");
    }
    await expect(workspace).toHaveCount(0);
    const split = main.getByRole("button", {
      name: "Toggle tab pane",
      exact: true,
    });
    await expect(split).toHaveCount(0);
    await expect(
      main.getByRole("button", { name: "Channel actions", exact: true }),
    ).toBeFocused();
    await expect(
      workspace.getByRole("button", { name: "Add tab", exact: true }),
    ).toHaveCount(0);
  });
});

// Real plugin registration through the channel menu, channel navigation and
// tab focus need app wiring in both browsers. Save/conflict permutations
// belong to editor tests.
test("Canvas opens once beside Thread and retains its channel draft", async ({
  page,
  app,
}) => {
  await open(page, app);
  const main = page.getByRole("article", { name: "Conversation", exact: true });
  const row = main.locator("[data-message-id]").first();
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  const workspace = page.locator("[data-panel-workspace]");
  const thread = workspace.locator(
    '[role="tab"][data-tab-value^="thread:alpha:"]',
  );
  await expect(thread).toHaveAttribute("aria-selected", "true");
  const viewCanvas = async () => {
    await main
      .getByRole("button", { name: "Channel actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "View canvas", exact: true })
      .click();
  };
  await viewCanvas();
  const canvas = workspace.getByRole("tab", { name: "Canvas", exact: true });
  const text = workspace.getByRole("textbox", { name: "Canvas Markdown" });
  const view = workspace.getByRole("article", { name: "Saved Canvas" });
  const edit = workspace.getByRole("tab", { name: "Edit", exact: true });
  await expect(canvas).toHaveAttribute("aria-selected", "true");
  await expect(view).toBeVisible();
  await edit.click();
  await expect(text).toBeEnabled();
  await text.fill("Channel-scoped draft");
  await thread.click();
  await expect(text).toBeHidden();
  await viewCanvas();
  await expect(canvas).toHaveCount(1);
  await expect(canvas).toHaveAttribute("aria-selected", "true");
  // Returning to an open Canvas tab keeps its selected Edit tab.
  await expect(text).toHaveValue("Channel-scoped draft");
  // Pointer-returning to Canvas on Edit resumes the editor, not hidden View.
  await text.evaluate((node) => node.setSelectionRange(2, 7));
  await thread.click();
  await expect(text).toBeHidden();
  await canvas.click();
  await expect(text).toBeFocused();
  await expect(text).toHaveValue("Channel-scoped draft");
  expect(
    await text.evaluate((node) => [node.selectionStart, node.selectionEnd]),
  ).toEqual([2, 7]);
  await workspace
    .getByRole("button", { name: "Close Canvas tab", exact: true })
    .click();
  await expect(thread).toHaveAttribute("aria-selected", "true");
  await viewCanvas();
  await expect(view).toBeVisible();
  await edit.click();
  await expect(text).toHaveValue("Channel-scoped draft");
  // Leaving a channel keeps its Canvas tab open for the return.
  await page.locator('button[data-solo-channel-id="beta"]').click();
  await expect(workspace).toHaveCount(0);
  await page.locator('button[data-channel-id="alpha"]').click();
  await expect(thread).toBeVisible();
  await expect(canvas).toHaveCount(1);
  await expect(canvas).toHaveAttribute("aria-selected", "true");
  // Returning shows the open Canvas; Edit still holds the channel's draft.
  await edit.click();
  await expect(text).toHaveValue("Channel-scoped draft");
});

// Real channel metadata, membership, panel registration, and history reads must
// agree on archived access. The write-control matrix stays in component tests.
test.describe("archived Canvas", () => {
  test.use({ lifecycleVisibility: { archived: ["alpha"], hidden: [] } });
  test("members can open Canvas and History in an archived channel", async ({
    page,
    app,
  }) => {
    const revision = app.sign({
      kind: 40100,
      content: "Archived plan",
      tags: [["h", "alpha"]],
      created_at: 1700000000,
    });
    await page.route("**/api/relay/primary/query", async (route) => {
      const filters = route.request().postDataJSON();
      if (!filters.every((filter) => filter.kinds?.includes(40100)))
        return route.continue();
      return route.fulfill({ json: [revision] });
    });
    await page.goto(app.origin);
    await openPage(page, "Messages");
    const scope = await page.evaluate(
      () => history.state.buzzNavigationV1.entry.target.scope,
    );
    const target = {
      version: 1,
      kind: "conversation",
      channelId: "alpha",
      scope,
    };
    await page.goto(
      `${app.origin}/#buzz=${encodeURIComponent(JSON.stringify(target))}`,
    );
    await page
      .getByRole("button", { name: "Channel actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "View canvas", exact: true })
      .click();
    const canvas = page.getByRole("region", {
      name: "Channel Canvas",
      exact: true,
    });
    await expect(
      canvas.getByRole("article", { name: "Saved Canvas" }),
    ).toHaveText("Archived plan");
    await canvas.getByRole("tab", { name: "Edit", exact: true }).click();
    const editor = canvas.getByRole("textbox", { name: "Canvas Markdown" });
    await expect(editor).toHaveValue("Archived plan");
    await expect(editor).toHaveAttribute("readonly", "");
    await expect(
      canvas.getByRole("button", { name: "Save Canvas" }),
    ).toBeDisabled();
    await canvas.getByRole("tab", { name: "History", exact: true }).click();
    await expect(canvas.getByText("Same as current version.")).toBeVisible();
    await canvas.getByRole("checkbox", { name: "Show full content" }).click();
    await expect(
      canvas.getByRole("textbox", { name: "Revision Markdown" }),
    ).toHaveValue("Archived plan");
    await expect(
      canvas.getByRole("button", { name: "Restore this version" }),
    ).toBeDisabled();
  });
});
