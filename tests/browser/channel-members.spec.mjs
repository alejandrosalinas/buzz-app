import { openChannelDetails } from "./channel-details.mjs";
import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { animationsSettled } from "./animations.mjs";

test.use({ pluginFixtures: true });

// Browser-only contract: real header composition, modal focus and responsive geometry.
// Write/search failure matrices live in the mounted component and session tests.
test("channel members opens from the header, fits each viewport, and returns keyboard focus", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const conversation = page.getByRole("article", { name: "Conversation" });
  await expect(
    conversation.getByRole("button", {
      name: "Manage members of Alpha",
      exact: true,
    }),
  ).toBeVisible();
  const trigger = conversation.getByRole("button", {
    name: /^Manage members of /,
    exact: true,
  });
  for (const [width, height, mode] of [
    [1440, 850, "light"],
    [800, 850, "dark"],
    [390, 850, "light"],
    [800, 300, "dark"],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(
      (value) =>
        document.documentElement.setAttribute("data-color-mode", value),
      mode,
    );
    // The avatar’s leading edge must open members, clear of the resize strip.
    const inset = await trigger.evaluate((node) =>
      Number.parseFloat(getComputedStyle(node).paddingLeft),
    );
    await trigger.click({
      position: { x: inset + 1, y: (await trigger.boundingBox()).height / 2 },
    });
    const dialog = page.getByRole("dialog", {
      name: "Manage members",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("searchbox")).toBeFocused();
    await expect(dialog.getByText(/People ·/)).toBeVisible();
    await expect(dialog.getByText("Loading members…")).toHaveCount(0);
    // Finish the entrance before measuring; content changes must not recenter it.
    await animationsSettled(dialog);
    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    expect(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    const search = dialog.getByRole("searchbox");
    await search.fill("no-matching-member");
    await expect(
      dialog.getByText("No members match your search."),
    ).toBeVisible();
    await expect
      .poll(async () => {
        const next = await dialog.boundingBox();
        return { height: next.height, y: next.y };
      })
      .toEqual({ height: box.height, y: box.y });
    await search.fill("");
    await expect(dialog.getByText("No members match your search.")).toHaveCount(
      0,
    );
    await expect
      .poll(async () => (await dialog.boundingBox()).height)
      .toBe(box.height);
    const body = dialog.locator(".buzz-dialog-body");
    await expect(body).toHaveCSS("overflow-y", "hidden");
    const list = dialog.getByRole("region", {
      name: "Member list",
      exact: true,
    });
    await expect(list).toHaveCSS("overflow-y", "auto");
    await expect(
      dialog.getByRole("button", { name: "Close" }),
    ).toBeInViewport();
    // A single compact row now fits at 360px; use a genuinely constrained viewport.
    if (height === 300) {
      expect(
        await list.evaluate((node) => node.scrollHeight > node.clientHeight),
      ).toBe(true);
      await list.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await expect
        .poll(() => list.evaluate((node) => node.scrollTop))
        .toBeGreaterThan(0);
      await expect(
        dialog.getByRole("button", { name: "Close" }),
      ).toBeInViewport();
    }
    await page.screenshot({
      path: testInfo.outputPath(
        `channel-members-${width}-${height}-${mode}.png`,
      ),
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
  await page.setViewportSize({ width: 1440, height: 850 });
  await trigger.click();
  await expect(
    page.getByRole("dialog", { name: "Manage members" }),
  ).toBeVisible();
  // Model navigation arriving while the modal is open, not a pointer through its backdrop.
  await page
    .locator('button[data-channel-id="beta"]')
    .evaluate((node) => node.click());
  await expect(
    page.getByRole("dialog", { name: "Manage members" }),
  ).toHaveCount(0);
  await page.locator('button[data-channel-id="alpha"]').click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("dialog", { name: "Manage members" }),
  ).toHaveCount(0);
});

// Native history traversal/reload plus the real channel tab owner cannot be
// represented by a dialog-only jsdom test. No member mutations are performed.
test("Members closes passively on Back, restores on Forward, and retires on explicit dismissal", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const conversation = page.getByRole("article", {
    name: "Conversation",
    exact: true,
  });
  const trigger = conversation.getByRole("button", {
    name: /^Manage members of /,
    exact: true,
  });
  const composer = conversation.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  const beta = page.getByRole("textbox", {
    name: "Message #Beta",
    exact: true,
  });
  const entry = () => page.evaluate(() => history.state.buzzNavigationV1.entry);
  const canGoForward = () =>
    page.evaluate(() => window.fixtureNavigation.snapshot().canGoForward);
  const length = () => page.evaluate(() => history.length);
  // Give the channel a known predecessor so "Back leaves the channel" is observable.
  await page.locator('button[data-channel-id="beta"]').click();
  await expect(beta).toBeVisible();
  await page.locator('button[data-channel-id="alpha"]').click();
  await expect(composer).toBeVisible();
  await composer.fill("Keep this draft");
  await openChannelDetails(page);
  const settings = page
    .locator("[data-panel-workspace]")
    .getByRole("tab", { name: "Channel settings", exact: true });
  await expect(settings).toHaveAttribute("aria-selected", "true");
  const before = await entry();
  const chain = await length();
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "Manage members",
    exact: true,
  });
  await expect(dialog.getByRole("searchbox")).toBeFocused();
  // Opening creates a visit without changing the underlying channel content.
  const members = await entry();
  expect(members.id).not.toBe(before.id);
  expect(members.target).toEqual({ ...before.target, panel: "members" });
  expect(await length()).toBe(chain + 1);
  expect(await canGoForward()).toBe(false);
  await dialog.getByRole("searchbox").fill("not-persisted");
  // Passive Back closes Members on the same channel, retaining Forward.
  await page.goBack();
  await expect(composer).toBeVisible();
  await expect(dialog).toHaveCount(0);
  expect((await entry()).id).toBe(before.id);
  expect(await canGoForward()).toBe(true);
  // Forward returns to the channel visit; its address still carries the panel.
  await page.goForward();
  await expect(dialog.getByRole("searchbox")).toBeFocused();
  expect((await entry()).id).toBe(members.id);
  await expect(dialog.getByRole("searchbox")).toHaveValue("");
  expect(await canGoForward()).toBe(false);
  // Explicit dismissal retires the dialog visit; Back leaves the channel.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect((await entry()).target).toEqual(before.target);
  expect(await length()).toBe(chain + 1);
  expect(await canGoForward()).toBe(false);
  await expect(composer).toHaveText("Keep this draft");
  await expect(settings).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(beta).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await page.goForward();
  await expect(composer).toBeVisible();
  await expect(dialog).toHaveCount(0);
  expect((await entry()).target).toEqual(before.target);
  expect(await canGoForward()).toBe(false);
  // Reload restores Members from the address.
  await trigger.click();
  await expect(dialog.getByRole("searchbox")).toBeFocused();
  const reopened = await entry();
  await page.reload();
  await expect(dialog.getByRole("searchbox")).toBeFocused();
  expect((await entry()).id).toBe(reopened.id);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  // Tabs remain session-owned; reload creates a new relay session. Their disk
  // persistence is deliberately not part of the Members route.
  await expect(composer).toHaveText("Keep this draft");
  expect((await entry()).target).toEqual(before.target);
  expect(await length()).toBe(chain + 1);
  await page.goBack();
  await expect(beta).toBeVisible();
  await expect(dialog).toHaveCount(0);
});

// Members must not compete with an exact-message reveal for modal focus.
test.describe("scoped Members history", () => {
  test.use({
    exactMessages: true,
    historyCounts: { alpha: 3, beta: 0 },
  });
  test("Members keeps modal focus above an exact timeline target", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await openPage(page, "Messages");
    const target = {
      version: 1,
      kind: "conversation",
      scope: { viewer: app.viewer, communityOrigin: "https://primary.example" },
      channelId: "alpha",
      messageId: app.exact.root.id,
      panel: "members",
    };
    expect(
      await page.evaluate(
        (target) => window.fixtureNavigation.open(target),
        target,
      ),
    ).toEqual({ status: "opened" });
    const dialog = page.getByRole("dialog", {
      name: "Manage members",
      exact: true,
    });
    await expect(dialog.getByRole("searchbox")).toBeFocused();
    await page.reload();
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation.snapshot().status),
      )
      .toBe("opened");
    await expect(dialog.getByRole("searchbox")).toBeFocused();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(
      page.locator(
        `[data-channel-timeline="alpha"] [data-message-id="${target.messageId}"]`,
      ),
    ).toBeFocused();
  });
  test("restores Members over a routed thread and respects account scope", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await openPage(page, "Messages");
    const origin = await page.evaluate(
      () => history.state.buzzNavigationV1.entry,
    );
    const target = {
      version: 1,
      kind: "conversation",
      scope: { viewer: app.viewer, communityOrigin: "https://primary.example" },
      channelId: "alpha",
      messageId: app.exact.target.id,
      threadRootId: app.exact.root.id,
    };
    expect(
      await page.evaluate(
        (target) => window.fixtureNavigation.open(target),
        target,
      ),
    ).toEqual({ status: "opened" });
    await page
      .getByRole("button", { name: /^Manage members of /, exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Manage members",
      exact: true,
    });
    await expect(dialog.getByRole("searchbox")).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation.snapshot().status),
      )
      .toBe("opened");
    const entry = await page.evaluate(
      () => history.state.buzzNavigationV1.entry,
    );
    expect(entry.target).toEqual({ ...target, panel: "members" });
    await page.reload();
    await expect(dialog.getByRole("searchbox")).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation.snapshot().status),
      )
      .toBe("opened");
    await expect(dialog.getByRole("searchbox")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(
      (await page.evaluate(() => history.state.buzzNavigationV1.entry)).target,
    ).toEqual(target);
    await expect(
      page
        .getByRole("region", { name: "Thread messages", exact: true })
        .locator(`[data-message-id="${target.messageId}"]`),
    ).toBeFocused();
    // Dismissal returned to the routed thread; Back now leaves that visit.
    await page.goBack();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => history.state.buzzNavigationV1.entry)).id,
      )
      .toBe(origin.id);
    await expect(dialog).toHaveCount(0);
    expect(
      await page.evaluate((target) => window.fixtureNavigation.open(target), {
        ...entry.target,
        scope: { ...target.scope, viewer: "a".repeat(64) },
      }),
    ).toEqual({ status: "failed", reason: "denied" });
    await expect(dialog).toHaveCount(0);
  });
});

// Solo chats have no Members surface; handwritten routes must retain the exact
// reader rather than suppressing its focus for a modal that cannot mount.
test.describe("Members on an unsupported Solo chat destination", () => {
  test.use({
    exactMessages: true,
    soloChannels: ["alpha"],
    historyCounts: { alpha: 3, beta: 0 },
  });
  test("discards the unavailable panel while preserving message focus and history", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await openPage(page, "Messages");
    const target = {
      version: 1,
      kind: "conversation",
      channelId: "alpha",
      scope: { viewer: app.viewer, communityOrigin: "https://primary.example" },
      messageId: app.exact.target.id,
    };
    expect(
      await page.evaluate((target) => window.fixtureNavigation.open(target), {
        ...target,
        panel: "members",
      }),
    ).toEqual({ status: "opened" });
    const dialog = page.getByRole("dialog", {
      name: "Share access",
      exact: true,
    });
    // As in a channel, the exact message opens in its thread.
    const row = page
      .getByRole("region", { name: "Thread messages", exact: true })
      .locator(`[data-message-id="${target.messageId}"]`);
    await expect(row).toBeFocused();
    await expect(dialog).toHaveCount(0);
    expect(
      (await page.evaluate(() => history.state.buzzNavigationV1.entry)).target,
    ).toEqual(target);
    await page.reload();
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation.snapshot().status),
      )
      .toBe("opened");
    await expect(row).toBeFocused();
    await expect(dialog).toHaveCount(0);
    expect(
      (await page.evaluate(() => history.state.buzzNavigationV1.entry)).target,
    ).toEqual(target);
  });
});
