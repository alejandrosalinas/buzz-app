import { test, expect } from "./fixture.mjs";
import {
  expectMessageActionsHidden,
  hoverMessage,
} from "./message-actions.mjs";
import { open, end, wheel, settle } from "./timeline.mjs";
import { generateSecretKey, finalizeEvent, getPublicKey } from "nostr-tools";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 2, beta: 1 },
  developmentReact: true,
});

// Native focus and virtual-list scroll anchoring need the real conversation.
test("removing a reaction from a tall message preserves the reading position", async ({
  page,
  app,
}) => {
  await open(page, app);
  const event = app.append("primary", "alpha", "Reaction scroll target");
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  await expect(row).toBeVisible();
  await hoverMessage(row);
  await row.getByRole("button", { name: "Add reaction", exact: true }).click();
  await page.locator('em-emoji-picker input[type="search"]').fill("thumbsup");
  await page
    .locator("em-emoji-picker")
    .getByRole("button", { name: "👍", exact: true })
    .click();
  const reaction = row.locator('button[data-reaction="👍"]');
  await expect(reaction).toHaveAttribute("aria-pressed", "true");
  app.edit(
    "primary",
    "alpha",
    event,
    "This long message keeps its reaction below the visible start.\n\n".repeat(
      60,
    ),
  );
  for (let i = 0; i < 6; i++)
    app.append("primary", "alpha", `Message after the reaction ${i}`);
  await end(page);
  await wheel(page, -120);
  await reaction.scrollIntoViewIfNeeded();
  await settle(page);
  const history = page.getByRole("region", { name: "Channel message history" });
  const before = await history.evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThan(500);
  await reaction.click();
  await expect(reaction).toHaveCount(0);
  await settle(page);
  expect(await history.evaluate((el) => el.scrollTop)).toBe(before);
});

// Browser-only boundary: real popup focus/geometry and existing tab navigation
// must retain the live thread. Identity/lifecycle matrices live in Vitest.
test("message activity opens a grouped preview and the agent's profile without losing the thread", async ({
  page,
  app,
}, testInfo) => {
  const keys = [generateSecretKey(), generateSecretKey()];
  await page.route("**/agent-library", (route) =>
    route.fulfill({
      json: {
        definitions: [],
        identities: keys.map((key, index) => ({
          pubkey: getPublicKey(key),
          name: `Agent ${index + 1}`,
        })),
      },
    }),
  );
  await open(page, app);
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content.startsWith("Thread root"));
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${root.id}"]`,
  );
  await row.hover();
  await row.getByRole("button", { name: /^View thread:/ }).click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const reply = thread.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await expect(reply).toBeVisible();
  keys.forEach((key, index) => {
    app.serveProfile(key, { name: `Agent ${index + 1}`, is_agent: true });
  });
  const human = generateSecretKey();
  const publish = (
    key,
    kind,
    content,
    tags,
    createdAt = Math.floor(Date.now() / 1000),
  ) =>
    app.relay.publish(
      "primary",
      finalizeEvent(
        {
          kind,
          content,
          tags,
          created_at: createdAt,
        },
        key,
      ),
    );
  let telemetryTime;
  const send = (index, kind, seq, payload = {}) =>
    app.observer(
      {
        kind,
        seq,
        timestamp: telemetryTime ?? new Date().toISOString(),
        channelId: "alpha",
        sessionId: "S",
        turnId: `working-${index}`,
        payload:
          kind === "turn_started" ? { triggeringEventIds: [root.id] } : payload,
      },
      keys[index],
    );
  keys.forEach((_, index) => {
    send(index, "turn_started", 1);
    send(index, "acp_read", 2, {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "read",
          title: "buzz-dev-mcp__read_file",
          status: "completed",
          rawInput: { path: "/project/README.md" },
          content: [
            {
              type: "content",
              content: { type: "text", text: "Safe example output" },
            },
          ],
        },
      },
    });
    send(index, "acp_read", 3, {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Checking the result and explaining the next steps in ordinary prose. ".repeat(
              8,
            ),
          },
        },
      },
    });
  });
  const requestRow = thread.locator(`[data-message-id="${root.id}"]`);
  // Expired outcomes can follow public replies; inspect this request's activity.
  const region = requestRow.getByRole("region", {
    name: "Agent activity on this message",
    exact: true,
  });
  const bubble = region.getByRole("button", { name: /^View agent activity:/ });
  await expect(bubble).toHaveCount(1);
  await expect(
    thread
      .locator(`[data-message-id="${root.id}"]`)
      .getByRole("region", { name: "Agent activity on this message" }),
  ).toHaveCount(1);
  await expect(
    thread.getByRole("form").getByRole("region", { name: /Agent activity/ }),
  ).toHaveCount(0);
  await expect(
    row.getByRole("region", { name: "Agent activity on this message" }),
  ).toHaveCount(1);
  await expect(
    row.locator("[data-thread-summary] [data-thread-working]"),
  ).toHaveCount(0);
  await expect(
    bubble
      .locator("xpath=ancestor::*[@data-agent-response-preview]")
      .locator(".buzz-avatar"),
  ).toHaveCount(2);
  await expect(bubble.locator(".buzz-avatar-status-dot")).toHaveCount(0);
  await expect(bubble).not.toContainText("working");
  publish(keys[0], 7, "👀", [
    ["h", "alpha"],
    ["e", root.id],
  ]);
  publish(keys[0], 7, "💬", [
    ["h", "alpha"],
    ["e", root.id],
  ]);
  publish(human, 7, "👀", [
    ["h", "alpha"],
    ["e", root.id],
  ]);
  publish(keys[0], 7, "✅", [
    ["h", "alpha"],
    ["e", root.id],
  ]);
  const messageActions = requestRow.getByRole("group", {
    name: "Message actions",
    includeHidden: true,
  });
  await expect(requestRow.locator('[data-reaction="✅"]')).toBeVisible();
  const eyes = requestRow.locator('[data-reaction="👀"]');
  await expect(eyes).toHaveCount(1);
  await expect(eyes).toHaveAccessibleName("👀: 2 people");
  await eyes.hover();
  const reactionPreview = page.locator(
    '.buzz-preview-card[role="tooltip"][data-open]',
  );
  await expect(reactionPreview).toContainText("Agent 1");
  await expect(reactionPreview).toContainText(getPublicKey(human).slice(0, 10));
  await page.mouse.move(0, 0);
  await expect(requestRow.locator('[data-reaction="💬"]')).toBeVisible();
  const typingTags = [
    ["h", "alpha"],
    ["e", root.id, "", "root"],
    ["e", root.id, "", "reply"],
  ];
  publish(keys[0], 20002, "", typingTags);
  publish(human, 20002, "", typingTags);
  const typing = thread.getByRole("status", { name: "Conversation activity" });
  await expect(typing).toContainText(getPublicKey(human).slice(0, 10));
  await expect(typing).not.toContainText("Agent 1");
  const threadIndicator = row.locator("[data-message-activity]");
  // The shared summary represents these requests once, alongside participants.
  await expect(threadIndicator).toHaveCount(1);
  await reply.fill("Keep this draft while inspecting activity");
  let livenessSeq = 3;
  const renew = () => {
    telemetryTime = new Date().toISOString();
    keys.forEach((_, index) => {
      send(index, "turn_liveness", ++livenessSeq);
    });
  };
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    for (const width of [1440, 800, 390]) {
      // Geometry checks inspect live tool details, not telemetry expiry.
      renew();
      // Resize with the channel toolbar revealed: the overlay thread pane
      // must cover it, even if the pointer has not moved off its old row.
      await page.setViewportSize({ width: 1440, height: 950 });
      await hoverMessage(row);
      await page.setViewportSize({ width, height: 950 });
      await expect(bubble).toBeVisible();
      const groupBox = await region.boundingBox();
      const formBox = await thread
        .getByRole("form", { name: "Reply to thread", exact: true })
        .boundingBox();
      expect(groupBox.y + groupBox.height).toBeLessThanOrEqual(formBox.y);
      const buttonBox = await bubble.boundingBox();
      const artworkBox = await region
        .locator(".buzz-avatar")
        .first()
        .boundingBox();
      expect(artworkBox.x + artworkBox.width).toBeLessThanOrEqual(buttonBox.x);
      expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(width);
      await bubble.focus();
      await page.keyboard.press("Enter");
      const popup = page.getByRole("dialog", {
        name: "Agent activity",
        exact: true,
      });
      await expect(popup).toBeVisible();
      await bubble.focus();
      // Native top-layer message actions must step aside for the activity
      // portal, including when its trigger retains keyboard focus.
      await expectMessageActionsHidden(messageActions);
      await expect(
        popup.getByRole("button", { name: /^View activity for/ }),
      ).toHaveCount(2);
      // Each agent's row is the way in; there is no separate Activity heading.
      await expect(
        popup.getByRole("button", { name: "View full activity" }),
      ).toHaveCount(0);
      const lastActivity = popup.getByRole("button").last();
      await expect
        .poll(() =>
          lastActivity.evaluate((button) => {
            const box = button.getBoundingClientRect();
            return button.contains(
              document.elementFromPoint(box.x + box.width / 2, box.bottom - 2),
            );
          }),
        )
        .toBe(true);
      for (const text of [
        "Agent activity",
        "Latest reported activity for this message.",
        "Agent 1",
        "Agent 2",
        "View activity",
        "Close",
      ])
        await expect(popup.getByText(text, { exact: true })).toHaveCount(0);
      await expect(popup.getByRole("tab")).toHaveCount(0);
      await expect(
        popup.getByText(/^Checking the result and explaining/),
      ).toHaveCount(0);
      const action = popup.getByRole("button", {
        name: "View activity for Agent 1",
        exact: true,
      });
      await expect(action).toContainText("Read file · Completed");
      const prose = action.getByText("README.md", { exact: true });
      const avatarBox = await action.locator(".buzz-avatar").boundingBox();
      const detailBox = await prose.boundingBox();
      expect(avatarBox.x + avatarBox.width).toBeLessThanOrEqual(detailBox.x);
      await expect(prose).toBeVisible();
      await expect(prose).toHaveCSS("white-space", "nowrap");
      expect(
        await prose.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await expect(
        popup.getByText("Safe example output", { exact: true }),
      ).toHaveCount(0);
      await expect(popup).toHaveCSS("filter", "blur(0px)");
      const box = await popup.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: testInfo.outputPath(`activity-${colorScheme}-${width}.png`),
      });
      await page.keyboard.press("Escape");
      await expect(popup).toBeHidden();
      await expect(bubble).toBeFocused();
      await hoverMessage(requestRow);
      await expect
        .poll(() =>
          messageActions.evaluate((bar) => bar.matches(":popover-open")),
        )
        .toBe(true);
    }
  }
  renew();
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await bubble
      .locator('span[aria-hidden="true"] > span')
      .evaluateAll((dots) =>
        dots.every((dot) => getComputedStyle(dot).animationName === "none"),
      ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 950 });
  // The earlier thread click leaves the pointer where the 800px bubble lands,
  // so the browser may already count it as inside. Enter from outside.
  await page.mouse.move(0, 0);
  await bubble.hover();
  const popup = page.getByRole("dialog", {
    name: "Agent activity",
    exact: true,
  });
  await expect(popup).toBeVisible();
  await reply.click();
  await expect(popup).toBeHidden();
  await bubble.focus();
  await page.keyboard.press("Enter");
  const activityRow = popup
    .getByRole("button", { name: /^View activity for/ })
    .first();
  await activityRow.focus();
  await page.keyboard.press("Enter");
  const profile = page.getByRole("region", {
    name: "Profile details",
    exact: true,
  });
  // Browser builds register no agent type, so there is no Activity tab to land on.
  await expect(
    profile.getByRole("tab", { name: "Info", selected: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Close (?!Thread).* tab$/ }).click();
  await expect(reply).toHaveText("Keep this draft while inspecting activity");
  publish(keys[0], 9, "Agent reply with plain avatar", typingTags);
  const agentReply = thread.locator("[data-message-id]").filter({
    has: page.getByText("Agent reply with plain avatar", { exact: true }),
  });
  const authorAvatar = agentReply.getByRole("button", {
    name: "View Agent 1 profile",
    exact: true,
  });
  await expect(authorAvatar).toBeVisible();
  await expect(
    authorAvatar.locator('[data-avatar-shape="squircle"]'),
  ).toHaveCount(1);
  await expect(agentReply.locator(".agent-motion-avatar")).toHaveCount(0);
  await expect(authorAvatar).not.toHaveAccessibleDescription(/thinking/);
  await expect(bubble).toBeVisible();
  // The reply summary remains bounded even with participant and working groups.
  publish(keys[1], 9, "Second agent reply", typingTags);
  publish(human, 9, "Human reply", typingTags);
  await expect(thread.getByText("Human reply", { exact: true })).toBeVisible();
  app.threadSummary(
    root.id,
    [...keys.map(getPublicKey), getPublicKey(human)],
    26,
  );
  const summary = row.getByRole("button", { name: /^View thread:/ });
  await expect(summary.locator("[data-avatar-shape][title]")).toHaveCount(3);
  await expect(summary).toContainText("26 replies");
  await page.clock.install();
  await page.clock.fastForward(5000);
  const resumedAt = await page.evaluate(() => Math.floor(Date.now() / 1000));
  publish(keys[0], 20002, "", typingTags, resumedAt);
  publish(keys[1], 20002, "", typingTags, resumedAt);
  // Typing does not renew exact request work; observer liveness does.
  telemetryTime = await page.evaluate(() => new Date().toISOString());
  send(0, "turn_liveness", ++livenessSeq);
  await expect(threadIndicator).toHaveCount(1);
  // The tab title may be the loaded message preview, not literally "Thread".
  await page
    .locator(
      '[data-panel-workspace] :is([data-tab-value="thread"], [data-tab-value^="thread:"])[aria-selected="true"]',
    )
    .locator("..")
    .getByRole("button", { name: /^Close .+ tab$/ })
    .click();
  publish(human, 9, "Unread reply while agents work", typingTags, resumedAt);
  await expect(summary).toHaveAccessibleName(/Observed unread replies/);
  // Passive uncertainty stays quiet while the other agent keeps working.
  // Control expiry so this transition does not depend on runner speed.
  await page.clock.fastForward(31_000);
  telemetryTime = await page.evaluate(() => new Date().toISOString());
  send(1, "turn_liveness", ++livenessSeq);
  const channelActivity = row.getByRole("region", {
    name: "Agent activity on this message",
  });
  await channelActivity.getByRole("button").click();
  const mixedActivity = page.getByRole("dialog", {
    name: "Agent activity",
    exact: true,
  });
  const firstActivity = mixedActivity.getByRole("button", {
    name: "View activity for Agent 1",
    exact: true,
  });
  const secondActivity = mixedActivity.getByRole("button", {
    name: "View activity for Agent 2",
    exact: true,
  });
  await expect(secondActivity).toBeVisible();
  await expect(secondActivity).not.toContainText(
    "Activity interrupted or out of date",
  );
  await expect(firstActivity).toHaveCount(0);
  await expect(channelActivity.locator(".buzz-avatar")).toHaveCount(1);
  await expect(channelActivity).not.toContainText("Couldn’t finish");
  // Uncertainty is retained internally: fresh evidence restores the same agent.
  telemetryTime = await page.evaluate(() => new Date().toISOString());
  send(0, "turn_liveness", ++livenessSeq);
  await expect(firstActivity).toBeVisible();
  await expect(firstActivity).not.toContainText(
    "Activity interrupted or out of date",
  );
  await expect(channelActivity.locator(".buzz-avatar")).toHaveCount(2);
  await page.keyboard.press("Escape");
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    for (const width of [1440, 800, 390]) {
      await page.setViewportSize({ width, height: 950 });
      await expect(summary).toBeVisible();
      await expect(
        summary.locator('[title^="Observed unread replies"]'),
      ).toBeVisible();
      await expect(summary.locator("[data-avatar-shape][title]")).toHaveCount(
        3,
      );
      await expect(threadIndicator).toHaveCount(1);
      const responseAvatars = channelActivity.locator(".buzz-avatar");
      await expect(responseAvatars).toHaveCount(2);
      for (const avatar of await responseAvatars.all()) {
        const bounds = await avatar.boundingBox();
        expect(bounds.width).toBeGreaterThan(0);
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      }
      const box = await summary.boundingBox();
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      // The connector extends beyond the button; measure label overflow
      // separately while retaining the connector's viewport bounds.
      const geometry = await summary.evaluate((element) => {
        const label = element.querySelector(".buzz-button-label");
        const box = element.getBoundingClientRect();
        const connector = getComputedStyle(element, "::before");
        const extension = parseFloat(connector.width) || 0;
        return {
          labelOverflow: label.scrollWidth - label.clientWidth,
          connectorLeft: box.left - extension,
          connectorRight: box.right + extension,
          viewport: innerWidth,
        };
      });
      expect(
        geometry.labelOverflow,
        JSON.stringify(geometry),
      ).toBeLessThanOrEqual(0);
      expect(geometry.connectorLeft).toBeGreaterThanOrEqual(0);
      expect(geometry.connectorRight).toBeLessThanOrEqual(geometry.viewport);
      await page.screenshot({
        path: testInfo.outputPath(
          `channel-activity-${colorScheme}-${width}.png`,
        ),
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  await row.getByRole("button", { name: /^View thread:/ }).click();
  telemetryTime = await page.evaluate(() => new Date().toISOString());
  send(0, "turn_completed", ++livenessSeq);
  // Public replies do not complete work: both the thread and channel retain
  // the remaining agent's request activity until its lifecycle finishes.
  await expect(region.locator(".buzz-avatar")).toHaveCount(1);
  await expect(channelActivity.locator(".buzz-avatar")).toHaveCount(1);
  await expect(threadIndicator).toHaveCount(1);
  send(1, "turn_completed", ++livenessSeq);
  await expect(channelActivity).toHaveCount(0);
  await expect(region).toHaveCount(0);
  await expect(threadIndicator).toHaveCount(0);
  await expect(reply).toHaveText("Keep this draft while inspecting activity");
});

// Real layout: adding agents widens one fixed-height row, with bounded artwork.
test("activity avatar stack stays one height with overflow at every supported width", async ({
  page,
  app,
}, testInfo) => {
  const keys = Array.from({ length: 5 }, () => generateSecretKey());
  await page.route("**/agent-library", (route) =>
    route.fulfill({
      json: {
        definitions: [],
        identities: keys.map((key, i) => ({
          pubkey: getPublicKey(key),
          name: `Stack agent ${i + 1}`,
        })),
      },
    }),
  );
  await open(page, app);
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content.startsWith("Thread root"));
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${root.id}"]`,
  );
  await row.hover();
  await row.getByRole("button", { name: /^View thread:/ }).click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const bubble = thread.getByRole("button", { name: /^View agent activity:/ });
  let firstHeight;
  for (const [i, key] of keys.entries()) {
    app.serveProfile(key, { name: `Stack agent ${i + 1}`, is_agent: true });
    app.observer(
      {
        kind: "turn_started",
        seq: 1,
        timestamp: new Date().toISOString(),
        channelId: "alpha",
        sessionId: "stack",
        turnId: `stack-${i}`,
        payload: { triggeringEventIds: [root.id] },
      },
      key,
    );
    await expect(bubble).toHaveAccessibleName(
      new RegExp(`Stack agent ${i + 1}, working`),
    );
    await expect(
      bubble
        .locator("xpath=ancestor::*[@data-agent-response-preview]")
        .locator(".buzz-avatar"),
    ).toHaveCount(Math.min(3, i + 1));
    const box = await bubble.boundingBox();
    firstHeight ??= box.height;
    expect(box.height).toBe(firstHeight);
  }
  await bubble.click();
  await expect(
    page
      .getByRole("dialog", { name: "Agent activity" })
      .getByRole("button", { name: /^View activity for/ }),
  ).toHaveCount(5);
  await page.keyboard.press("Escape");
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    for (const width of [390, 800, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      const box = await bubble.boundingBox();
      expect(box.height).toBe(firstHeight);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      const artwork = await bubble
        .locator("xpath=ancestor::*[@data-agent-response-preview]")
        .locator(".buzz-avatar")
        .evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width };
          }),
        );
      for (const avatar of artwork) {
        expect(avatar.x).toBeGreaterThanOrEqual(0);
        expect(avatar.x + avatar.width).toBeLessThanOrEqual(width);
      }
      await page.mouse.move(0, 0);
      await page.screenshot({
        path: testInfo.outputPath(`stack-${colorScheme}-${width}.png`),
      });
    }
  }
});

// Real layout boundary: activity follows its triggering message in both hosts.
for (const own of [true, false]) {
  test.describe(`Activity alignment for ${own ? "outgoing" : "incoming"} messages`, () => {
    test.use({ threadUnreadOwnedRoot: own });
    test("activity follows the bubble edge in channels and threads", async ({
      page,
      app,
    }) => {
      const key = generateSecretKey();
      await open(page, app);
      await expect
        .poll(() => app.relay.hasRoute("primary", "observer"))
        .toBe(true);
      const root = app.histories
        .get("primary/alpha")
        .find((row) => row.content.startsWith("Thread root"));
      const row = page.locator(
        `[data-channel-timeline] [data-message-id="${root.id}"]`,
      );
      await row.hover();
      await row.getByRole("button", { name: /^View thread:/ }).click();
      const thread = page.getByRole("complementary", {
        name: "Thread",
        exact: true,
      });
      await expect(
        thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
      ).toBeVisible();
      app.serveProfile(key, { name: "Working agent", is_agent: true });
      app.observer(
        {
          kind: "turn_started",
          seq: 1,
          timestamp: new Date().toISOString(),
          channelId: "alpha",
          sessionId: "alignment",
          turnId: "working",
          payload: { triggeringEventIds: [root.id] },
        },
        key,
      );
      for (const target of [
        row,
        thread.locator(`[data-message-id="${root.id}"]`),
      ]) {
        const chip = target.getByRole("region", {
          name: "Agent activity on this message",
          exact: true,
        });
        await expect(chip).toBeVisible();
        const control = chip.getByRole("button", {
          name: /^View agent activity:/,
        });
        const avatar = chip.locator(".buzz-avatar").first();
        const [controlBox, avatarBox] = await Promise.all([
          control.boundingBox(),
          avatar.boundingBox(),
        ]);
        expect(avatarBox.x + avatarBox.width).toBeLessThanOrEqual(controlBox.x);
        expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(
          (await target.boundingBox()).x + (await target.boundingBox()).width,
        );
      }
      app.threadSummary(root.id, [getPublicKey(key)], 6);
      const summary = row.locator("[data-thread-summary]");
      await expect(summary).toContainText("6 replies");
      await expect(summary.locator("[data-avatar-shape][title]")).toHaveCount(
        1,
      );
      await expect(summary.locator("[data-thread-working]")).toHaveCount(0);
      await page
        .locator(
          '[data-panel-workspace] :is([data-tab-value="thread"], [data-tab-value^="thread:"])[aria-selected="true"]',
        )
        .locator("..")
        .getByRole("button", { name: /^Close .+ tab$/ })
        .click();
      await summary.click();
      await expect(
        thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
      ).toBeVisible();
      app.observer(
        {
          kind: "turn_completed",
          seq: 2,
          timestamp: new Date().toISOString(),
          channelId: "alpha",
          sessionId: "alignment",
          turnId: "working",
          payload: {},
        },
        key,
      );
      await expect(summary.locator("[data-thread-working]")).toHaveCount(0);
      await expect(summary).toContainText("6 replies");
      await expect(summary.locator("[data-avatar-shape][title]")).toHaveCount(
        1,
      );
    });
  });
}
