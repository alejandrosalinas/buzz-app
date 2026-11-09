import { finalizeEvent } from "nostr-tools";
import { hoverMessage } from "./message-actions.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

const localAgentKey =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

// One real app-composition/geometry journey. Matrices stay in the host and
// adapter tests; only native identity custody and the agent's external work are fake.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 2, beta: 1 },
  localAgentActivity: true,
});
test("local agent receipt, work and failure agree across sidebar, thread and exact message", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  const agent = localAgentKey;
  await expect
    .poll(() => page.evaluate(() => !!window.localAgentFixture))
    .toBe(true);
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content.startsWith("Thread root"));
  const rootRow = page.locator(
    `[data-channel-timeline] [data-message-id="${root.id}"]`,
  );
  await rootRow.hover();
  await rootRow.getByRole("button", { name: /^View thread:/ }).click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(
    thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeVisible();
  // Generated viewer identity, signed through the same live relay fixture as chat.
  const send = (text) => {
    const event = app.sign({
      kind: 9,
      content: text,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["h", "alpha"],
        ["e", root.id, "", "root"],
        ["e", root.id, "", "reply"],
        ["p", agent],
      ],
    });
    app.relay.publish("primary", event);
    return event;
  };
  const first = send("First local request");
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.pending().length))
    .toBe(1);
  const second = send("Second local request");
  const secondRow = thread.locator(`[data-message-id="${second.id}"]`);
  const waiting = secondRow.getByRole("button", {
    name: /^(View agent activity|Show activity history|Collapse activity history):/,
  });
  await expect(waiting).toHaveAccessibleName(
    /Local tester, Received · waiting to start/,
  );
  await expect(
    waiting.locator('[data-state="waiting"] > span').first(),
  ).toHaveCSS("animation-duration", "2.4s");
  const sidebar = page.locator(
    '[data-channel-id="alpha"] [data-channel-working]',
  );
  // Neither request has reported a first step yet, so the sidebar breathes.
  await expect(sidebar).toHaveAccessibleName(/Local tester waiting in Alpha/);
  const summary = rootRow.getByRole("button", { name: /^View thread:/ });
  await expect(summary).toContainText("replies");
  await page.evaluate(
    (id) => window.localAgentFixture.finish(id, true),
    first.id,
  );
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.pending().length))
    .toBe(2);
  // Claimed but no first step yet: still breathing, now "Starting".
  await expect(waiting).toHaveAccessibleName(/Local tester, Starting/);
  const firstRow = thread.locator(`[data-message-id="${first.id}"]`);
  await expect(
    firstRow.getByRole("button", { name: /^View agent activity:/ }),
  ).toHaveCount(0);
  await page.evaluate((id) => window.localAgentFixture.handover(id), second.id);
  await expect(waiting).toContainText("Reading notes.txt");
  // The message's live bubble is the only working indicator: the thread tail
  // adds no second one. Its dots stay visible without motion; jsdom cannot
  // prove CSS visibility.
  const liveStep = thread.getByRole("button", {
    name: "Activity: Local tester working",
    exact: true,
  });
  await expect(liveStep).toHaveCount(0);
  const dots = waiting.locator('[data-state="working"] > span');
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(dots).toHaveCount(3);
  await expect(dots.first()).toBeVisible();
  await expect(dots.first()).toHaveCSS("animation-name", "none");
  await page.screenshot({
    path: testInfo.outputPath("local-working-reduced-motion.png"),
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  // Work remains after run() returns; only actual completion settles it.
  await page.evaluate(
    (id) => window.localAgentFixture.finish(id, false),
    second.id,
  );
  await expect(
    secondRow.getByText("Couldn’t finish", { exact: true }),
  ).toBeVisible();
  await expect(waiting).toHaveText("Couldn’t finish");
  await expect(liveStep).toHaveCount(0);
  await expect(waiting).toHaveAccessibleName(
    /Local tester, Fixture provider unavailable/,
  );
  await expect(sidebar).toHaveCount(0);
  await expect(summary.locator("[data-thread-working]")).toHaveCount(0);
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    for (const width of [390, 800, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      await waiting.focus();
      await page.keyboard.press("Enter");
      const popup = secondRow.locator("[data-activity-details]");
      await expect(popup).toContainText("Fixture provider unavailable");
      await expect(popup).not.toHaveAttribute("data-starting-style", "");
      const box = await popup.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      // The full explanation stays readable inside the expanded history.
      await expect(popup.getByText("Fixture provider unavailable")).toHaveCSS(
        "white-space",
        "normal",
      );
      const dismiss = await popup
        .getByRole("button", { name: /^Dismiss error from / })
        .boundingBox();
      expect(dismiss.x + dismiss.width).toBeLessThanOrEqual(box.x + box.width);
      const retry = await popup
        .getByRole("button", { name: /^Retry / })
        .boundingBox();
      expect(retry.x).toBeGreaterThanOrEqual(box.x);
      expect(retry.x + retry.width).toBeLessThanOrEqual(dismiss.x);
      await page.screenshot({
        path: testInfo.outputPath(`local-activity-${colorScheme}-${width}.png`),
      });
      await waiting.click();
      await expect(popup).toBeHidden();
      await expect(waiting).toBeFocused();
    }
  }
  // Retry asks the agent again with the same message; focus returns to the row.
  await waiting.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Retry Local tester" }).focus();
  await page.keyboard.press("Enter");
  await expect(waiting).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.localAgentFixture.pending().filter((row) => row === id).length,
        second.id,
      ),
    )
    .toBe(2);
  await expect(waiting).toHaveAccessibleName(/Local tester, Starting/);
  await page.evaluate(
    (id) => window.localAgentFixture.finish(id, false),
    second.id,
  );
  await expect(
    secondRow.getByText("Couldn’t finish", { exact: true }),
  ).toBeVisible();
  // Dismiss hides only this device's view of the error; focus stays in the row.
  await waiting.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Dismiss error from / }).click();
  await expect(waiting).toHaveCount(0);
  await expect(page.locator("body")).not.toBeFocused();
});

test("Stop in a message's activity ends its local work quietly", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  await expect
    .poll(() => page.evaluate(() => !!window.localAgentFixture))
    .toBe(true);
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content.startsWith("Thread root"));
  const rootRow = page.locator(
    `[data-channel-timeline] [data-message-id="${root.id}"]`,
  );
  await rootRow.hover();
  await rootRow.getByRole("button", { name: /^View thread:/ }).click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const event = app.sign({
    kind: 9,
    content: "Request to stop",
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["h", "alpha"],
      ["e", root.id, "", "root"],
      ["e", root.id, "", "reply"],
      ["p", localAgentKey],
    ],
  });
  app.relay.publish("primary", event);
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.pending().length))
    .toBe(1);
  await page.evaluate((id) => window.localAgentFixture.handover(id), event.id);
  const activity = thread
    .locator(`[data-message-id="${event.id}"]`)
    .getByRole("button", { name: /^View agent activity:/ });
  await expect(activity).toHaveAccessibleName(/Local tester/);
  // A long step stays on one line and ends in an ellipsis.
  await page.evaluate(
    (id) =>
      window.localAgentFixture.step(
        id,
        "Read",
        "src/features/agents/a-very-long-path/with-many-segments/notes-for-the-stop-button.txt",
      ),
    event.id,
  );
  await activity.hover();
  const popup = page.getByRole("dialog", {
    name: "Agent activity",
    exact: true,
  });
  const stop = popup.getByRole("button", {
    name: "Stop Local tester",
    exact: true,
  });
  await expect(stop).toBeVisible();
  await expect(stop).toHaveText("Stop");
  // The small action sits inside a padded slot; its hit area stays unobscured.
  await expect
    .poll(() =>
      stop.evaluate((element) => {
        const button = element.getBoundingClientRect();
        const slot = element.parentElement.getBoundingClientRect();
        return (
          slot.height > button.height &&
          slot.width > button.width &&
          element.contains(
            document.elementFromPoint(
              button.x + button.width / 2,
              button.y + button.height / 2,
            ),
          )
        );
      }),
    )
    .toBe(true);
  await expect(popup).not.toHaveAttribute("data-starting-style", "");
  const preview = popup.getByText(/^Reading /);
  await expect(preview).toBeVisible();
  const line = await preview.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      height: element.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(style.lineHeight),
      clipped: element.scrollWidth > element.clientWidth,
      ellipsis: style.textOverflow,
    };
  });
  expect(line.height).toBeLessThan(line.lineHeight * 1.5);
  expect(line.clipped).toBe(true);
  expect(line.ellipsis).toBe("ellipsis");
  // Stop stays inside the popup, after its row's preview.
  const [box, frame, text] = await Promise.all([
    stop.boundingBox(),
    popup.boundingBox(),
    preview.boundingBox(),
  ]);
  expect(box.x).toBeGreaterThanOrEqual(text.x + text.width);
  expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width);
  const row = thread.locator(`[data-message-id="${event.id}"]`);
  const around = await row.boundingBox();
  const left = Math.min(frame.x, around.x) - 16;
  const top = Math.min(frame.y, around.y) - 16;
  await page.screenshot({
    path: testInfo.outputPath("local-activity-stop.png"),
    clip: {
      x: Math.max(0, left),
      y: Math.max(0, top),
      width:
        Math.max(frame.x + frame.width, around.x + around.width) + 16 - left,
      height:
        Math.max(frame.y + frame.height, around.y + around.height) + 16 - top,
    },
  });
  await stop.focus();
  await stop.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.stopped()))
    .toEqual([event.id]);
  // Stopped work is neither finished nor failed: its live activity goes, a
  // toast confirms the stop, and the message keeps a note that it stopped.
  await expect(activity).toHaveCount(0);
  await expect(
    page.getByText("Stopped Local tester", { exact: true }),
  ).toBeVisible();
  await expect(
    row.getByRole("button", {
      name: /activity history: Local tester, Stopped/,
    }),
  ).toBeFocused();
  const note = row.getByText("Stopped", { exact: true });
  await expect(note).toBeVisible();
  await row.screenshot({
    path: testInfo.outputPath("local-activity-stopped.png"),
  });
  await expect(
    page.locator('[data-channel-id="alpha"] [data-channel-working]'),
  ).toHaveCount(0);
});

// The channel's thread summary is host-owned; its activity popup offers Stop.
test("Stop in a channel response activity stops its work", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect
    .poll(() => page.evaluate(() => !!window.localAgentFixture))
    .toBe(true);
  const request = app.sign({
    kind: 9,
    content: "Stop this from the channel",
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["h", "alpha"],
      ["p", localAgentKey],
    ],
  });
  app.relay.publish("primary", request);
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.pending().length))
    .toBe(1);
  await page.evaluate(
    (id) => window.localAgentFixture.handover(id),
    request.id,
  );
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${request.id}"]`,
  );
  const summary = row.getByRole("button", { name: /^View agent activity:/ });
  await expect(summary).toBeVisible();
  await expect(row.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
  // Recorded updates must not remove the only control that can stop this turn.
  const key = new Uint8Array(32);
  key[31] = 1;
  for (const [index, content] of [
    "Checking the request",
    "Checking the final detail",
  ].entries()) {
    app.relay.publish(
      "primary",
      finalizeEvent(
        {
          kind: 40002,
          content,
          created_at: request.created_at + index + 1,
          tags: [
            ["h", "alpha"],
            ["audience", "agents"],
          ],
        },
        key,
      ),
    );
  }
  const history = page.getByRole("button", {
    name: /Show activity history:.*Checking the final detail/,
  });
  await expect(history).toBeVisible();
  await history.click();
  await expect(
    page.getByText("Checking the request", { exact: true }),
  ).toBeVisible();
  await expect(summary).toHaveCount(0);
  const stop = page.getByRole("button", {
    name: "Stop Local tester",
    exact: true,
  });
  await expect(stop).toBeVisible();
  await expect(
    page.getByRole("button", { name: "View transcript", exact: true }),
  ).toBeVisible();
  app.relay.publish(
    "primary",
    app.sign({
      kind: 9,
      content: "Keep going while I check the result",
      created_at: request.created_at + 3,
      tags: [["h", "alpha"]],
    }),
  );
  await expect(
    page.getByText("Keep going while I check the result", { exact: true }),
  ).toBeVisible();
  const live = page.locator(
    "[data-channel-timeline] [data-conversation-activity]",
  );
  await expect(live.getByText("Local tester", { exact: true })).toBeVisible();
  await stop.click();
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.stopped()))
    .toEqual([request.id]);
  await expect(summary).toHaveCount(0);
  await expect(
    page.getByText("Stopped Local tester", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Collapse activity history:/ }),
  ).toBeFocused();
  // These legacy updates have no explicit reply IDs, so they cannot claim
  // this request's terminal outcome. It stays on the request itself.
  const note = row.getByRole("button", {
    name: /activity history: Local tester, Stopped/,
  });
  await expect(note).toContainText("Stopped");
  const [bounds, noted] = await Promise.all([
    row.boundingBox(),
    note.boundingBox(),
  ]);
  expect(noted.x).toBeGreaterThanOrEqual(bounds.x);
  expect(noted.x + noted.width).toBeLessThanOrEqual(bounds.x + bounds.width);
});

// Real host composition: one summary combines replies and exact-message work.
test("one thread summary retains reply navigation and work on another reply", async ({
  page,
  app,
}) => {
  await open(page, app);
  const agent = localAgentKey;
  await expect
    .poll(() => page.evaluate(() => !!window.localAgentFixture))
    .toBe(true);
  const request = app.sign({
    kind: 9,
    content: "Top-level activity request",
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["h", "alpha"],
      ["p", agent],
    ],
  });
  app.histories.get("primary/alpha").push(request);
  app.relay.publish("primary", request);
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${request.id}"]`,
  );
  const summary = row.getByRole("button", { name: /^View thread:/ });
  const activity = row.getByRole("button", { name: /^View agent activity:/ });
  await expect(activity).toBeVisible();
  app.threadSummary(request.id, [agent], 1);
  await expect(summary).toContainText("1 reply");
  await expect(row.locator("[data-thread-summary]")).toHaveCount(1);
  await page.evaluate(
    (id) => window.localAgentFixture.handover(id),
    request.id,
  );
  const reply = app.sign({
    kind: 9,
    content: "Follow-up activity request",
    created_at: request.created_at + 1,
    tags: [
      ["h", "alpha"],
      ["e", request.id, "", "root"],
      ["e", request.id, "", "reply"],
      ["p", agent],
    ],
  });
  app.histories.get("primary/alpha").push(reply);
  app.relay.publish("primary", reply);
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.pending().length))
    .toBe(2);
  await expect(summary).toHaveAccessibleName(/Local tester (working|waiting)/);
  await expect(activity).toHaveCount(0);
  await page.evaluate(
    (id) => window.localAgentFixture.finish(id, true),
    request.id,
  );
  await expect(activity).toHaveCount(0);
  await expect(summary).toContainText("1 reply");
  await summary.click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const replyActivity = thread
    .locator(`[data-message-id="${reply.id}"]`)
    .getByRole("button", { name: /^View agent activity:/ });
  await expect(replyActivity.locator('[data-state="waiting"]')).toBeVisible();
  await page.evaluate(
    (id) => window.localAgentFixture.finish(id, true),
    reply.id,
  );
  await expect(replyActivity).toHaveCount(0);
  await expect(summary).toContainText("1 reply");
});

// Real host navigation and hover/keyboard coexistence require a browser: no reply
// exists yet, and the same root's accessory must change behavior inside the pane.
test("opens an active message's empty thread without losing its activity preview", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect
    .poll(() => page.evaluate(() => !!window.localAgentFixture))
    .toBe(true);
  const request = app.sign({
    kind: 9,
    content: "Open this active thread before its first reply",
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["h", "alpha"],
      ["p", localAgentKey],
    ],
  });
  app.histories.get("primary/alpha").push(request);
  app.relay.publish("primary", request);
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${request.id}"]`,
  );
  const trigger = row.getByRole("button", { name: "Reply", exact: true });
  const response = row.getByRole("button", { name: /^View agent activity:/ });
  await row.hover();
  await expect(trigger).toBeVisible();
  await response.hover();
  const preview = page.getByRole("dialog", {
    name: "Agent activity",
    exact: true,
  });
  await expect(preview).toBeVisible();
  await page.keyboard.press("Escape");
  await hoverMessage(row);
  await trigger.click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(
    thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeVisible();
  await expect(preview).toHaveCount(0);
  const root = thread.locator(`[data-message-id="${request.id}"]`);
  await expect(root).toContainText(request.content);
  const activity = root.getByRole("button", { name: /^View agent activity:/ });
  await expect(activity).toBeVisible();
  await activity.click();
  await expect(preview).toBeVisible();
  await expect(
    preview.getByRole("button", { name: "View activity for Local tester" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  // The tab title may be the loaded message preview, not literally "Thread".
  await page
    .locator(
      '[data-panel-workspace] :is([data-tab-value="thread"], [data-tab-value^="thread:"])[aria-selected="true"]',
    )
    .locator("..")
    .getByRole("button", { name: /^Close .+ tab$/ })
    .click();
  await expect(thread).toHaveCount(0);
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(
    thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeVisible();
  await expect(activity).toBeVisible();
  await page.evaluate(
    (id) => window.localAgentFixture.finish(id, true),
    request.id,
  );
});

for (const focusOn of ["bubble", "popup", "composer"]) {
  test(`finishing activity retires keyboard controls without stealing focus: ${focusOn}`, async ({
    page,
    app,
  }) => {
    await open(page, app);
    await expect
      .poll(() => page.evaluate(() => !!window.localAgentFixture))
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
    const composer = thread.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    await expect(composer).toBeVisible();
    const request = app.sign({
      kind: 9,
      content: "Finish while focused",
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["h", "alpha"],
        ["e", root.id, "", "reply"],
        ["p", localAgentKey],
      ],
    });
    app.relay.publish("primary", request);
    const message = thread.locator(`[data-message-id="${request.id}"]`);
    const bubble = message.getByRole("button", {
      name: /^View agent activity:/,
    });
    await expect(bubble).toBeVisible();
    // Finish entrance and hold only the exit so the intermediate state is testable.
    await message.locator("section").evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations({ subtree: true })
          .filter((a) => a.effect.getTiming().iterations !== Infinity)
          .map((a) => a.finished),
      );
    });
    // Hold the actual exit animation before its first frame, rather than racing
    // a delayed animationstart event on a busy runner. Release in finally.
    const exitGate = await page.addStyleTag({
      content: "[data-leaving] { animation-play-state: paused !important; }",
    });
    const popup = page.getByRole("dialog", {
      name: "Agent activity",
      exact: true,
    });
    if (focusOn === "popup") {
      await bubble.click();
      await popup
        .getByRole("button", { name: "View activity for Local tester" })
        .focus();
    } else if (focusOn === "bubble") await bubble.focus();
    else await composer.focus();
    const section = message.locator("section");
    try {
      await page.evaluate(
        (id) => window.localAgentFixture.finish(id, true),
        request.id,
      );
      await expect(section).toHaveAttribute("data-leaving", "");
      await expect(section).toHaveAttribute("inert", "");
      await expect(popup).toHaveCount(0);
      const destination =
        focusOn === "composer"
          ? composer
          : message.getByRole("button", { name: "More message actions" });
      await expect(destination).toBeFocused();
      await page.keyboard.press("Tab");
      expect(
        await section.evaluate((e) => e.contains(document.activeElement)),
      ).toBe(false);
    } finally {
      await exitGate.evaluate((element) => element.remove());
    }
    await expect(section).toHaveCount(0);
  });
}

// Real browser focus must survive removal of the decorated host button/portal.
test("finishing a channel response hands focus back only when it owns focus", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect
    .poll(() => page.evaluate(() => !!window.localAgentFixture))
    .toBe(true);
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  for (const focusOn of ["summary", "popup", "composer"]) {
    // Exercise immediate popup removal without depending on an exit animation.
    await page.emulateMedia({
      reducedMotion: focusOn === "popup" ? "reduce" : "no-preference",
    });
    const request = app.sign({
      kind: 9,
      content: `Finish zero-reply activity: ${focusOn}`,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["h", "alpha"],
        ["p", localAgentKey],
      ],
    });
    app.relay.publish("primary", request);
    const row = page.locator(
      `[data-channel-timeline] [data-message-id="${request.id}"]`,
    );
    const summary = row.getByRole("button", { name: /^View agent activity:/ });
    const popup = page.getByRole("dialog", {
      name: "Agent activity",
      exact: true,
    });
    await expect(summary).toBeVisible();
    if (focusOn === "popup") {
      // Pin the popup open: this case checks focus handoff, not hover intent.
      await summary.click();
      await popup
        .getByRole("button", { name: "View activity for Local tester" })
        .focus();
    } else if (focusOn === "summary") await summary.focus();
    else await composer.focus();
    await page.evaluate(
      (id) => window.localAgentFixture.finish(id, true),
      request.id,
    );
    await expect(summary).toHaveCount(0);
    await expect(popup).toHaveCount(0);
    await expect(
      focusOn === "composer"
        ? composer
        : row.getByRole("button", { name: "More message actions" }),
    ).toBeFocused();
  }
});

test("the published-activity tab shows turns its agent published", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect
    .poll(() => page.evaluate(() => !!window.localAgentFixture))
    .toBe(true);
  // Activity is best effort; publish only once the owner's observer route is live.
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  // The fixture agent's key is the curve generator, so secret key 1 signs as it.
  const key = new Uint8Array(32);
  key[31] = 1;
  const frame = (kind, payload) => ({
    kind,
    seq: 1,
    timestamp: new Date().toISOString(),
    channelId: "alpha",
    sessionId: "S",
    turnId: "published",
    payload,
  });
  app.observer(frame("turn_started", {}), key);
  app.observer(
    frame("acp_read", {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "S",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "m1",
          content: { type: "text", text: "Published reply" },
        },
      },
    }),
    key,
  );
  await page
    .getByRole("form", { name: "Send a message to Alpha", exact: true })
    .locator("..")
    .getByRole("button", { name: /^Activity: .+ working$/ })
    .hover();
  const popup = page.getByRole("dialog", { name: "Working now", exact: true });
  // The channel is already shown, so the agent's row opens its activity.
  await popup
    .getByRole("button", { name: /^View .*Local tester.* activity$/ })
    .click();
  await expect(
    page.getByRole("tab", { name: "Activity", selected: true }),
  ).toBeVisible();
  await expect(
    page.locator("summary").getByText("Published reply", { exact: true }),
  ).toBeVisible();
  // Real browser layout is required: jsdom cannot catch flex min-content collapse.
  const path = "src/features/agents/ActivityTranscript.tsx";
  app.observer(
    frame("acp_read", {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "S",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "layout-tool",
          kind: "read",
          title: path,
          status: "completed",
          rawInput: { path },
        },
      },
    }),
    key,
  );
  const toolSummary = page.locator("summary").filter({ hasText: path });
  await toolSummary.click();
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 950 });
    for (const size of ["150%", "200%"]) {
      await page.evaluate((value) => {
        document.documentElement.style.fontSize = value;
      }, size);
      await expect
        .poll(async () => {
          const label = await toolSummary
            .getByText(path, { exact: true })
            .boundingBox();
          return label?.width ?? 0;
        })
        .toBeGreaterThan(100);
      await expect
        .poll(async () => (await toolSummary.boundingBox())?.height ?? Infinity)
        .toBeLessThan(300);
      // The host inset, hero, and footer must agree after the dock narrows it.
      await expect
        .poll(() =>
          toolSummary.evaluate((summary) => {
            let host = summary.parentElement;
            while (host && getComputedStyle(host).overflowY !== "auto")
              host = host.parentElement;
            if (!host) throw new Error("Missing activity scrollport");
            return host.scrollWidth - host.clientWidth;
          }),
        )
        .toBe(0);
    }
  }
  await page.evaluate(() => {
    document.documentElement.style.removeProperty("font-size");
  });
  await page.setViewportSize({ width: 1280, height: 950 });
  // A turn's thread label opens that thread.
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content.startsWith("Thread root"));
  app.observer(
    {
      ...frame("turn_started", { threadRootEventId: root.id }),
      sessionId: "T",
      turnId: "threaded",
    },
    key,
  );
  await page
    .getByRole("button", { name: `Thread ${root.id.slice(0, 8)}`, exact: true })
    .click();
  await expect(
    page
      .getByRole("complementary", { name: "Thread", exact: true })
      .getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeVisible();
});
