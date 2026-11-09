import { test, expect } from "./fixture.mjs";
import { newChat } from "./navigation.mjs";
import { settle } from "./timeline.mjs";

// The production app's exact-reader -> DOM focus/visibility -> navigation
// completion boundary requires real layout and both browser engines.
test.use({
  pluginFixtures: true,
  exactMessages: true,
  soloChannels: ["alpha"],
  historyCounts: { alpha: 90, beta: 5 },
});
const target = (app, messageId, threadRootId) => ({
  version: 1,
  kind: "conversation",
  channelId: "alpha",
  scope: { viewer: app.viewer, communityOrigin: "https://primary.example" },
  ...(messageId ? { messageId } : {}),
  ...(threadRootId ? { threadRootId } : {}),
});
const openTarget = (page, value) =>
  page.evaluate((target) => window.fixtureNavigation.open(target), value);
const history = (page) =>
  page.getByRole("region", { name: "Channel message history", exact: true });
const thread = (page) =>
  page.getByRole("region", { name: "Thread messages", exact: true });

const membershipTest = test.extend({ membershipActivity: true });
membershipTest(
  "a Solo chat reply shows as a thread and its link opens beside the chat",
  async ({ page, app }) => {
    await page.goto(app.origin);
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation?.snapshot().status),
      )
      .toBe("opened");
    expect(await openTarget(page, target(app))).toEqual({ status: "opened" });
    await expect(history(page)).toBeVisible();
    // The Solo chat must pass the active viewer through to its shared timeline.
    await expect(history(page).locator("[data-membership-row]")).toContainText(
      "Pinky added by you, along with Brain",
    );
    await settle(page);
    const root = app.append("primary", "alpha", "Solo chat prompt");
    const prompt = history(page).locator(`[data-message-id="${root.id}"]`);
    await expect(prompt).toBeVisible();
    const reply = app.append(
      "primary",
      "alpha",
      "Threaded Solo chat reply",
      true,
      true,
      root.id,
    );
    app.threadSummary(root.id, [reply.pubkey], 1);
    // Like a channel, the timeline summarizes the reply on its root.
    const summary = prompt.getByRole("button", {
      name: /^View thread: 1 reply/,
    });
    await expect(summary).toBeVisible();
    await expect(
      history(page).locator(`[data-message-id="${reply.id}"]`),
    ).toHaveCount(0);
    // Live inserts resize the virtual timeline; let its bottom anchor settle
    // before targeting the summary with a real pointer click.
    await settle(page);
    await summary.click();
    const row = thread(page).locator(`[data-message-id="${reply.id}"]`);
    await expect(row).toBeVisible();
    // Its link opens the same thread tab, as a channel reply link does.
    expect(await openTarget(page, target(app, reply.id, root.id))).toEqual({
      status: "opened",
    });
    await expect(row).toBeFocused();
  },
);

// Real container geometry, pointer targeting and editing at enlarged interface sizes.
const soloChannel = "33333333-3333-4333-8333-333333333333";
test.describe("Solo layout", () => {
  test.use({
    productionBroker: true,
    exactMessages: false,
    channelIds: [soloChannel, "beta"],
    channelNames: { [soloChannel]: "Alpha" },
    soloChannels: [soloChannel],
    ownSoloChannels: [soloChannel],
    historyCounts: { [soloChannel]: 5, beta: 1 },
  });
  test("Solo chat keeps new and selected chats usable and full width at 200%", async ({
    page,
    app,
  }) => {
    await page.setViewportSize({ width: 800, height: 768 });
    await page.goto(app.origin);
    await newChat(page);
    const workspace = page;
    const sidebar = page.getByRole("navigation", {
      name: "Solo conversations",
    });
    const composer = workspace.getByRole("textbox", {
      name: "Message your agents",
      exact: true,
    });
    await expect(composer).toBeVisible();
    await page.evaluate(() =>
      document.documentElement.style.setProperty("--buzz-text-scale", "2"),
    );
    const expectReachable = async () => {
      await expect
        .poll(() =>
          composer.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return (
              r.width > 150 &&
              r.left >= 0 &&
              r.right <= innerWidth &&
              r.top >= 0 &&
              r.bottom <= innerHeight &&
              el.contains(
                document.elementFromPoint(
                  r.x + r.width / 2,
                  r.y + r.height / 2,
                ),
              )
            );
          }),
        )
        .toBe(true);
      await composer.click();
      await page.keyboard.type("Scaled Solo draft");
      await expect(composer).toHaveText("Scaled Solo draft");
    };
    await expectReachable();
    await sidebar.getByRole("button", { name: "Alpha", exact: true }).click();
    await expect(
      workspace.getByRole("button", {
        name: "Share access to Alpha",
        exact: true,
      }),
    ).toBeVisible();
    await expectReachable();
    // The selected chat's column uses nearly all of the conversation panel.
    await expect
      .poll(() =>
        composer.evaluate((el) => {
          const panel = el.closest("article").getBoundingClientRect();
          const column = el
            .closest("[data-attachment-drop-zone]")
            .getBoundingClientRect();
          return column.width > panel.width * 0.9;
        }),
      )
      .toBe(true);
    await newChat(page);
    await expect(composer).toHaveText("Scaled Solo draft");
    await page.evaluate(() =>
      document.documentElement.style.setProperty("--buzz-text-scale", "1"),
    );
    await expect(composer).toBeInViewport();
  });
});
