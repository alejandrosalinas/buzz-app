import { pluginAction } from "./plugin-settings.mjs";
import { test, expect } from "./fixture.mjs";
import { open, wheel, virtuaIdle } from "./timeline.mjs";
import { closeSettings } from "./navigation.mjs";
import { npubEncode } from "nostr-tools/nip19";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
test.use({
  productionBroker: true,
  // Navigation can publish read positions through the real broker.
  readState: true,
  developmentReact: true,
});

// Agent responses live in history; human typing stays beside the composer.
const channelComposer = (page) =>
  page
    .getByRole("region", { name: "Alpha", exact: true })
    .or(page.getByRole("tabpanel", { name: "Alpha", exact: true }));
const activityTrigger = (scope) =>
  scope.locator("[data-agent-activity-trigger]");
const responseAvatars = (trigger) =>
  trigger
    .locator("xpath=ancestor::*[@data-agent-response-preview]")
    .locator(".buzz-avatar");
const workingNow = (page) =>
  page.getByRole("dialog", { name: "Working now", exact: true });
// Hover is the pointer path; keyboard opening is exercised explicitly below.
const openWorkingNow = async (page, scope) => {
  // Leave the sidebar preview before crossing into the conversation. Its
  // open surface can cover the conversation trigger after channel navigation.
  await page.mouse.move(0, 0);
  await expect(
    page.locator('[role="dialog"][data-channel-activity]'),
  ).toHaveCount(0);
  await activityTrigger(scope).hover();
  const popup = workingNow(page);
  await expect(popup).toBeVisible();
  return popup;
};
// Agents without a loaded profile fall back to their key prefix. A row whose
// conversation is already shown opens the agent's activity instead, so match
// the row itself rather than its separate activity icon.
const agentRow = (popup, agent) =>
  popup
    .getByRole("button", {
      name: new RegExp(
        `^(?:Open (?:thread|conversation) for|View) .*${agent.slice(0, 10)}`,
      ),
    })
    .and(popup.locator('[data-variant="row"]'));
const agentActivityAction = (popup, agent) =>
  popup.getByRole("button", {
    name: new RegExp(`^View .*${agent.slice(0, 10)}.* activity$`),
  });
// The activity icon is revealed by hovering or focusing its row, like the sidebar;
// a row that opens activity itself is the action.
const viewAgentActivity = async (page, scope, agent) => {
  const popup = await openWorkingNow(page, scope);
  await agentRow(popup, agent).hover();
  await agentActivityAction(popup, agent).click();
};
const isFocused = (locator) =>
  locator.evaluate((element) => element === document.activeElement);
// Activity opens the agent's profile, where its type's Activity tab lives.
const expectProfile = async (page, agent) => {
  const profile = page.getByRole("region", {
    name: "Profile details",
    exact: true,
  });
  await expect(profile.locator("code").first()).toHaveText(npubEncode(agent));
  return profile;
};
const activity = (kind, channelId, turnId, payload) => ({
  kind,
  seq: 1,
  timestamp: new Date().toISOString(),
  channelId,
  sessionId: "S",
  turnId,
  ...(payload === undefined ? {} : { payload }),
});

test("sidebar activity opens the working agent's profile", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  const key = generateSecretKey();
  const agent = getPublicKey(key);
  app.observer(activity("turn_liveness", "alpha", "sidebar"), key);
  const row = page.locator('[data-channel-id="alpha"]');
  await expect(
    row.getByRole("img", { name: /working in Alpha$/ }),
  ).toBeVisible();
  await row.hover();
  const popup = page.getByRole("dialog", { name: "Activity in Alpha" });
  await expect(popup).toBeVisible();
  await popup.getByRole("button", { name: /Open conversation for/ }).hover();
  const action = popup.getByRole("button", { name: /View .+ activity/ });
  await expect(action).toBeVisible();
  await action.click();
  await expectProfile(page, agent);
});

test("mention picker demands the relay's protected archive snapshot", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page
    .getByRole("button", { name: "Mention a member", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Mention a member or agent" }),
  ).toBeVisible();
  await expect
    .poll(
      () =>
        app.report.queries.filter(({ filter }) => filter.kinds?.includes(13535))
          .length,
    )
    .toBeGreaterThan(0);
  expect(
    app.report.queries
      .filter(({ filter }) => filter.kinds?.includes(13535))
      .every(
        ({ filter }) =>
          filter.authors?.length === 1 &&
          filter.limit === 1 &&
          Object.keys(filter).length === 3,
      ),
  ).toBe(true);
});

// The floating composer control lists every working agent in the channel.
// Profile activity remains the durable fallback after fresh evidence disappears.
test("channel activity consumes telemetry, opens each agent's profile, and resets on disable", async ({
  page,
  app,
}) => {
  // Hold the first explicit profile read before broker admission so telemetry
  // cannot coalesce into it; hold all upstream presence responses too,
  // including a replacement if that first request is cancelled.
  app.relay.holdPresence();
  const firstSnapshot = Promise.withResolvers();
  let firstAuthors;
  await page.route("**/presence-snapshot", async (route) => {
    if (!firstAuthors) {
      firstAuthors = route.request().postDataJSON()[0].authors;
      await firstSnapshot.promise;
    }
    await route.fallback();
  });
  const firstKey = generateSecretKey();
  const secondKey = generateSecretKey();
  const first = getPublicKey(firstKey);
  const second = getPublicKey(secondKey);
  const composer = channelComposer(page);
  const trigger = activityTrigger(composer);
  const popup = workingNow(page);
  const onlyFirst = new RegExp(`^Activity: .*${first.slice(0, 10)}.* working$`);
  const onlySecond = new RegExp(
    `^Activity: .*${second.slice(0, 10)}.* working$`,
  );
  try {
    await open(page, app);
    await page
      .getByRole("button", { name: "View Alice Fixture profile", exact: true })
      .first()
      .click();
    await expect.poll(() => firstAuthors).toBeDefined();
    await expect(
      page.getByRole("button", { name: "Agent Activity", exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    app.observer(activity("turn_liveness", "alpha", "one"), firstKey);
    app.observer(activity("turn_liveness", "alpha", "two"), secondKey);
    await expect(trigger).toHaveAccessibleName("Activity: 2 agents working");
    // The compact control renders telemetry keys without demanding profile or
    // presence reads, so neither can join the held explicit profile read.
    expect(firstAuthors).not.toContain(first);
    expect(firstAuthors).not.toContain(second);
  } finally {
    firstSnapshot.resolve();
    app.relay.releasePresence();
  }
  // The released explicit read (or its replacement) settles before counting.
  await expect
    .poll(
      () =>
        app.report.presenceSnapshots.length > 0 &&
        app.report.presenceSnapshots.every(({ pending }) => !pending),
    )
    .toBe(true);
  await page
    .locator(
      '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button[aria-label^="Close "]',
    )
    .click();
  // A busy skip followed by a successful retry must not masquerade as recovery.
  expect(
    app.report.brokerRequests.filter(({ url }) =>
      url.endsWith("/presence-snapshot"),
    ),
  ).toHaveLength(app.report.presenceSnapshots.length);
  // Bare avatars: no permanent container behind the resting control.
  await page.mouse.move(0, 0);
  await expect(popup).toHaveCount(0);
  await expect(trigger).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  for (const side of ["top", "right", "bottom", "left"])
    await expect(trigger).toHaveCSS(`border-${side}-width`, "0px");
  await expect(responseAvatars(trigger)).toHaveCount(2);

  await openWorkingNow(page, composer);
  // Each agent's row is the way in; there is no separate Activity heading.
  await expect(
    popup.getByRole("button", { name: "View full activity", exact: true }),
  ).toHaveCount(0);
  // Observer turns carry no thread identity, and the channel is already shown:
  // rows open each agent's activity instead of guessing a thread.
  for (const agent of [first, second]) {
    await expect(agentRow(popup, agent)).toHaveAccessibleName(
      /^View .+ activity$/,
    );
    await expect(agentRow(popup, agent)).toContainText(
      "No current step details received.",
    );
    await expect(agentRow(popup, agent)).toContainText(
      "Work with unconfirmed thread",
    );
    await expect(agentActivityAction(popup, agent)).toHaveCount(1);
  }
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await page.mouse.move(0, 0);
  // Keyboard path: real key input opens the popup and reaches the agent's row.
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(popup).toBeVisible();
  // Keyboard opening focuses the first row a frame later. Rows can be in either
  // order, so wait for that focus, then Tab to this agent's row.
  await expect(popup.getByRole("button").first()).toBeFocused();
  const firstAction = agentActivityAction(popup, first);
  for (let step = 0; step < 3 && !(await isFocused(firstAction)); step++)
    await page.keyboard.press("Tab");
  await expect(firstAction).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(popup).toHaveCount(0);
  await expectProfile(page, first);

  await page
    .locator(
      '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button[aria-label^="Close "]',
    )
    .click();
  // The popup's action has unmounted; focus returns to its floating trigger.
  await expect(trigger).toBeFocused();
  await viewAgentActivity(page, composer, second);
  await expectProfile(page, second);
  await page
    .locator(
      '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button[aria-label^="Close "]',
    )
    .click();
  await expect(trigger).toBeFocused();

  const sockets = app.relay.sockets.length;
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Manage plugins", exact: true })
    .click();
  const toggle = pluginAction(page, "Agent Activity");
  const disabled = page.waitForResponse(
    (response) =>
      response.url().endsWith("/stream-observer") &&
      response.ok() &&
      response.request().postDataJSON().observer === null,
  );
  await toggle.click();
  await disabled;
  // Disabling the activity UI withdraws the only observer demand without
  // replacing the socket or chat globals.
  await expect
    .poll(() => app.relay.hasRoute("primary", "observer"))
    .toBe(false);
  expect(app.relay.sockets).toHaveLength(sockets);
  await closeSettings(page);
  await page.locator('[data-channel-id="alpha"]').click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await expect(trigger).toHaveCount(0);

  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Manage plugins", exact: true })
    .click();
  // Wait for the new display generation to reach the host before publishing.
  const enabled = page.waitForResponse(
    (response) =>
      response.url().endsWith("/stream-observer") &&
      response.ok() &&
      response.request().postDataJSON().observer !== null,
  );
  await toggle.click();
  await enabled;
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  app.observer(activity("turn_liveness", "alpha", "after-reset"), firstKey);
  await closeSettings(page);
  await page.locator('[data-channel-id="alpha"]').click();
  // Only the fresh agent returns; the disabled generation's evidence is gone.
  await expect(trigger).toHaveAccessibleName(onlyFirst);
  await viewAgentActivity(page, composer, first);
  await expectProfile(page, first);

  // One terminal turn must not hide another active turn for the same agent,
  // and stale evidence is not working. The other agent's frames, observed in
  // order, are the barrier for each transition. The route survives closing the profile.
  await page
    .locator(
      '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button[aria-label^="Close "]',
    )
    .click();
  app.observer(activity("turn_liveness", "alpha", "parallel"), firstKey);
  app.observer(activity("turn_completed", "alpha", "after-reset"), firstKey);
  app.observer(activity("turn_liveness", "alpha", "barrier"), secondKey);
  await expect(trigger).toHaveAccessibleName("Activity: 2 agents working");
  app.observer(activity("turn_completed", "alpha", "parallel"), firstKey);
  app.observer(
    {
      ...activity("turn_liveness", "alpha", "stale"),
      timestamp: new Date(Date.now() - 31_000).toISOString(),
    },
    firstKey,
  );
  await expect(trigger).toHaveAccessibleName(onlySecond);
  app.observer(activity("turn_liveness", "alpha", "fresh"), firstKey);
  await expect(trigger).toHaveAccessibleName("Activity: 2 agents working");
  app.observer(activity("turn_completed", "alpha", "fresh"), firstKey);
  await expect(trigger).toHaveAccessibleName(onlySecond);
  app.observer(activity("turn_completed", "alpha", "stale"), firstKey);
  app.observer(activity("turn_completed", "alpha", "barrier"), secondKey);
  await expect(trigger).toHaveCount(0);
});

// Enough history for real scrolling to expose Jump alongside the activity pill.
const layoutTest = test.extend({ historyCounts: { alpha: 30, beta: 1 } });
for (const mode of ["light", "dark"]) {
  layoutTest(
    `channel activity control fits wide and narrow layouts in ${mode}`,
    async ({ page, app }, testInfo) => {
      await page.addInitScript((mode) => {
        localStorage.setItem("buzz-appearance.v1", mode);
      }, mode);
      await open(page, app);
      await expect
        .poll(() => app.relay.hasRoute("primary", "observer"))
        .toBe(true);
      const agentKey = generateSecretKey();
      const agent = getPublicKey(agentKey);
      const secondKey = generateSecretKey();
      app.observer(
        activity("turn_liveness", "alpha", "second-layout"),
        secondKey,
      );
      app.observer(
        activity("acp_read", "alpha", "layout", {
          text: "A long literal raw record. ".repeat(40),
        }),
        agentKey,
      );
      const composer = channelComposer(page);
      const trigger = activityTrigger(composer);
      const popup = workingNow(page);
      await expect(trigger).toHaveAccessibleName("Activity: 2 agents working");
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        // The shell applies its media-query change in React. Wait for that commit
        // before measuring; otherwise these reads can straddle sidebar collapse.
        await expect(
          page.locator("[data-shell-sidebar-toggle]"),
        ).toHaveAttribute(
          "aria-label",
          width <= 650 ? "Show navigation" : "Hide sidebar",
        );
        await expect(trigger).toBeVisible();
        // Real scrolling and floating-control geometry cannot be proven in jsdom.
        // The recovery wrapper must preserve the activity lane for channel history.
        const history = page.getByRole("region", {
          name: "Channel message history",
        });
        await virtuaIdle(page, history);
        await history.hover();
        await wheel(page, -500, history);
        const jump = history.getByRole("button", { name: "Jump to latest" });
        await expect(jump).toBeVisible();
        await jump.click();
        await expect(trigger).toBeInViewport();
        const triggerBox = await trigger.boundingBox();
        const historyBox = await history.boundingBox();
        expect(triggerBox.x).toBeGreaterThanOrEqual(historyBox.x);
        expect(triggerBox.x + triggerBox.width).toBeLessThanOrEqual(
          historyBox.x + historyBox.width,
        );
        expect(triggerBox.y + triggerBox.height).toBeLessThanOrEqual(
          historyBox.y + historyBox.height,
        );
        const avatar = responseAvatars(trigger).first();
        // Production CSS must retain a loadable SVG mask after bundling. A valid
        // mask-image string alone can still point to the HTML fallback route.
        await expect
          .poll(() =>
            avatar.evaluate(async (element) => {
              const mask = getComputedStyle(element).maskImage;
              const image = new Image();
              image.src = mask.slice(4, -1).replace(/^["']|["']$/g, "");
              try {
                await image.decode();
                return image.naturalWidth > 0;
              } catch {
                return false;
              }
            }),
          )
          .toBe(true);
        await expect(page.locator("html")).toHaveAttribute(
          "data-color-mode",
          mode,
        );
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(width);
        // Escape suppresses hover until the pointer leaves the trigger. A viewport
        // resize can keep WebKit's pointer over it, so make the next entry explicit.
        await page.mouse.move(0, 0);
        await openWorkingNow(page, composer);
        await expect(agentRow(popup, agent)).toBeVisible();
        await expect(popup).not.toHaveAttribute("data-starting-style", "");
        const popupBox = await popup.boundingBox();
        expect(popupBox.x).toBeGreaterThanOrEqual(0);
        expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(width);
        expect(popupBox.y + popupBox.height).toBeLessThanOrEqual(triggerBox.y);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(width);
        await page.screenshot({
          path: testInfo.outputPath(`activity-entry-${mode}-${width}.png`),
        });
        await page.keyboard.press("Escape");
        // Escape starts Base UI's asynchronous unmount. The closing portal still
        // has its wide-screen position and can overflow the next narrow viewport.
        await expect(
          page.getByRole("dialog", {
            name: "Working now",
            includeHidden: true,
          }),
        ).toHaveCount(0);
      }
    },
  );
}

test.describe("thread activity", () => {
  test.use({
    threadUnread: true,
    readState: true,
    historyCounts: { alpha: 2, beta: 1 }, // Thread fixtures replace the last two Alpha rows with roots.
  });

  test("thread typing uses the existing route, stays isolated, and floats thread activity above the composer", async ({
    page,
    app,
  }, testInfo) => {
    await open(page, app);
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    const key = generateSecretKey(),
      agent = getPublicKey(key);
    const onlyAgent = new RegExp(
      `^Activity: .*${agent.slice(0, 10)}.* working$`,
    );
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content.startsWith("Thread root"));
    const row = page.locator(
      `[data-channel-timeline] [data-message-id="${root.id}"]`,
    );
    const thread = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const openThread = async () => {
      await row.hover();
      await row.getByRole("button", { name: /^View thread:/ }).click();
      await expect(
        thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
      ).toBeVisible();
    };
    await openThread();
    const composer = channelComposer(page);
    const channelTrigger = activityTrigger(composer);
    const threadTrigger = activityTrigger(thread);
    const threadStatus = thread.locator("[data-agent-working-status]");
    const popup = workingNow(page);
    const marker = page
      .locator('[data-channel-id="alpha"]')
      .getByRole("img", { name: /working in Alpha$/ });
    const sendEvent = (kind, threadId, signingKey = key, content = "") => {
      const event = finalizeEvent(
        {
          kind,
          created_at: Math.floor(Date.now() / 1000),
          content,
          tags: [
            ["h", "alpha"],
            ...(threadId
              ? [
                  ["e", threadId, "", "root"],
                  ["e", threadId, "", "reply"],
                ]
              : []),
          ],
        },
        signingKey,
      );
      app.relay.publish("primary", event);
      return event;
    };
    const sendTyping = (threadId, signingKey) =>
      sendEvent(20002, threadId, signingKey);
    // Pointer exit closes the hover popup; Escape is covered separately.
    const closePopup = async () => {
      await page.mouse.move(0, 0);
      await expect(popup).toHaveCount(0);
    };
    // Owner telemetry recognizes the agent; its channel-wide turn has no thread.
    app.observer(activity("turn_liveness", "alpha", "previous"), key);
    await expect(channelTrigger).toHaveAccessibleName(onlyAgent);
    await expect(threadTrigger).toHaveCount(0);
    app.observer(activity("turn_completed", "alpha", "previous"), key);
    await expect(channelTrigger).toHaveCount(0);
    const unrecognized = generateSecretKey();
    const otherThread = "b".repeat(64);
    sendTyping(otherThread);
    sendTyping(root.id, unrecognized);
    // An unrecognized signer is ordinary typing, never an agent avatar.
    await expect(threadStatus).toHaveText(/^\S+ is typing$/);
    // The later human typing event is the relay barrier. Another thread's
    // agent activity belongs to that thread, not this channel or open thread.
    await expect(channelTrigger).toHaveCount(0);
    await expect(threadTrigger).toHaveCount(0);
    // A completed message ends public typing in both scopes.
    sendEvent(9, root.id, unrecognized, "Unrecognized participant finished");
    sendEvent(9, otherThread, key, "Other thread finished");
    await expect(threadStatus).toBeEmpty();
    await expect(channelTrigger).toHaveCount(0);
    // Finish panel entrance before starting the eight-second working signal.
    await page.locator("[data-panel-dock]").evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      );
    });
    const typing = sendTyping(root.id);
    await expect(threadTrigger).toHaveAccessibleName(onlyAgent);
    await expect(threadStatus).toHaveText(/ is working$/);
    await expect(marker).toHaveCount(0); // Thread-only fallback must not light channel scope.
    await expect(page.locator(`[data-message-id="${typing.id}"]`)).toHaveCount(
      0,
    );
    const form = thread.getByRole("form", {
      name: "Reply to thread",
      exact: true,
    });
    const expectAboveForm = async () => {
      const triggerBox = await threadTrigger.boundingBox(),
        formBox = await form.boundingBox();
      expect(triggerBox.y + triggerBox.height).toBeLessThanOrEqual(formBox.y);
      expect(triggerBox.x).toBeGreaterThanOrEqual(formBox.x);
      expect(triggerBox.x + triggerBox.width).toBeLessThanOrEqual(
        formBox.x + formBox.width,
      );
    };
    await expectAboveForm();
    // The thread control's row is already in its thread, so it opens activity;
    // no channel-wide guess.
    await openWorkingNow(page, thread);
    await expect(agentRow(popup, agent)).toHaveAccessibleName(
      /^View .+ activity$/,
    );
    await expect(agentRow(popup, agent)).not.toContainText("Thread ·");
    await closePopup();
    // Same agent, two observer turns, and scoped thread typing. Do not infer
    // that either channel-wide turn belongs to this thread, or hide other work.
    app.observer(activity("turn_liveness", "alpha", "parallel-one"), key);
    app.observer(activity("turn_liveness", "alpha", "parallel-two"), key);
    sendTyping(root.id);
    await openWorkingNow(page, composer);
    await expect(agentRow(popup, agent)).toContainText(
      "Work with unconfirmed thread",
    );
    await expect(agentRow(popup, agent)).not.toContainText("Thread ·");
    await expect(threadTrigger).toHaveAccessibleName(onlyAgent);
    await page.screenshot({
      path: testInfo.outputPath("thread-activity-above-composer.png"),
    });
    await agentRow(popup, agent).hover();
    await agentActivityAction(popup, agent).click();
    await expectProfile(page, agent);
    await page
      .locator(
        '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button[aria-label^="Close "]',
      )
      .click();
    // The profile and Thread share the detail pane; return to the thread.
    await openThread();
    // The activity detour can outlast thread typing's 8s freshness on slow
    // runners; refresh it, as each later section does, before using the trigger.
    sendTyping(root.id);
    // Popup semantics and keyboard operation need real browsers.
    await threadTrigger.focus();
    await page.keyboard.press("Enter");
    await expect(popup).toBeVisible();
    await expect(agentRow(popup, agent)).toBeVisible();
    // Keyboard opening focuses the first row a frame later. Tabbing before then
    // can skip past it and leave the non-modal popup, which closes it.
    await expect(agentRow(popup, agent)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(popup).toHaveCount(0);
    await expectProfile(page, agent);
    await page
      .locator(
        '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button[aria-label^="Close "]',
      )
      .click();
    await openThread();
    await page.setViewportSize({ width: 390, height: 844 });
    sendTyping(root.id);
    await expect(threadTrigger).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBe(390);
    await expectAboveForm();
    await page.screenshot({
      path: testInfo.outputPath("thread-activity-narrow.png"),
    });
    await page.setViewportSize({ width: 1440, height: 950 });
    await viewAgentActivity(page, thread, agent);
    await expectProfile(page, agent);
    await page
      .locator(
        '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button[aria-label^="Close "]',
      )
      .click();
    // The reply summary opens the thread; channel activity never guesses
    // that an unscoped observer turn belongs to a known thread.
    await openThread();
    await page
      .locator(
        '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button[aria-label^="Close "]',
      )
      .click();
    await expect(thread).toHaveCount(0);
    sendTyping(root.id);
    await openWorkingNow(page, composer);
    await expect(agentRow(popup, agent)).toHaveAccessibleName(
      /^View .+ activity$/,
    );
    await expect(agentRow(popup, agent)).not.toContainText("Thread ·");
    await closePopup();
    await openThread();
    await expect(
      thread.getByRole("region", { name: "Thread messages", exact: true }),
    ).toContainText(root.content);
    app.observer(activity("turn_completed", "alpha", "parallel-one"), key);
    app.observer(activity("turn_completed", "alpha", "parallel-two"), key);
    sendEvent(9, root.id, key, "Thread work finished");
    await expect(threadTrigger).toHaveCount(0);
    sendTyping();
    await expect(marker).toBeVisible();
    const workingBox = await marker.boundingBox();
    expect(workingBox).toEqual(
      expect.objectContaining({ width: 26, height: 15 }),
    );
    // Channel-level work is in the conversation already shown, never an
    // inferred thread, so its row opens the agent's activity.
    await openWorkingNow(page, composer);
    await expect(agentRow(popup, agent)).toHaveAccessibleName(
      /^View .+ activity$/,
    );
    await expect(agentRow(popup, agent)).toContainText(
      "Only typing updates are reaching this app.",
    );
    const channelStatus = composer.locator("[data-agent-working-status]");
    await expect(channelStatus).toHaveText(/ is working$/);
    await page.screenshot({
      path: testInfo.outputPath("channel-agent-single-presentation.png"),
    });
    // Escape dismisses only the popup, never the conversation pane beneath it.
    await expect(thread).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(thread).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(marker).toHaveCount(0, { timeout: 10_000 });
    await expect(channelTrigger).toHaveCount(0);
    await expect(channelStatus).toBeEmpty();
  });
  // Browser-only: real composer wiring through signed relay traffic,
  // mixed-status geometry at narrow width, and navigation across live scopes.
  test("thread working avatars deduplicate agents while preserving human typing and scope transitions", async ({
    page,
    app,
  }, testInfo) => {
    await open(page, app);
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    const keys = [generateSecretKey(), generateSecretKey()];
    const roots = app.histories
      .get("primary/alpha")
      .filter((row) => row.content.startsWith("Thread root"));
    const thread = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const threadTrigger = activityTrigger(thread);
    const workingStatus = thread.locator("[data-agent-working-status]");
    // Visible human typing is presentation; the status above announces it.
    const humanTyping = (scope) =>
      scope.locator('[aria-hidden="true"]').filter({ hasText: /is typing$/ });
    const popup = workingNow(page);
    const openThread = async (root) => {
      await page
        .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ })
        .click();
      await expect(
        thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
      ).toBeVisible();
    };
    const publish = (key, root, kind = 20002) => {
      app.relay.publish(
        "primary",
        finalizeEvent(
          {
            kind,
            created_at: Math.floor(Date.now() / 1000),
            content: kind === 9 ? "Work finished" : "",
            tags: [
              ["h", "alpha"],
              ...(root
                ? [
                    ["e", root.id, "", "root"],
                    ["e", root.id, "", "reply"],
                  ]
                : []),
            ],
          },
          key,
        ),
      );
    };
    // Pointer exit closes the hover popup; Escape is covered separately.
    const closePopup = async () => {
      await page.mouse.move(0, 0);
      await expect(popup).toHaveCount(0);
    };
    await openThread(roots[0]);
    // The live region exists before the first transition, without visible layout.
    await expect(workingStatus).toBeAttached();
    await expect(workingStatus).toBeEmpty();
    await expect(threadTrigger).toHaveCount(0);
    const composer = channelComposer(page);
    const channelTrigger = activityTrigger(composer);
    // Names come from already-loaded profiles; the control itself reads none.
    // Ordinary channel messages load them before any activity starts.
    for (const [index, key] of keys.entries()) {
      app.serveProfile(key, { name: `Worker ${index + 1}`, is_agent: true });
      publish(key, undefined, 9);
      await expect(
        page
          .locator("[data-channel-timeline]")
          .getByText(`Worker ${index + 1}`, { exact: true }),
      ).toBeVisible();
      app.observer(
        activity("turn_liveness", "alpha", `recognize-${index}`),
        key,
      );
    }
    await expect(channelTrigger).toHaveAccessibleName(
      "Activity: 2 agents working",
    );
    for (const [index, key] of keys.entries())
      app.observer(
        activity("turn_completed", "alpha", `recognize-${index}`),
        key,
      );
    await expect(channelTrigger).toHaveCount(0);
    publish(keys[0], roots[0]);
    await expect(threadTrigger).toHaveAccessibleName(
      /^Activity: Worker 1 working$/,
    );
    await expect(workingStatus).toHaveText("Worker 1 is working");
    await expect(humanTyping(thread)).toHaveCount(0);
    publish(keys[1], roots[0]);
    await expect(threadTrigger).toHaveAccessibleName(
      "Activity: 2 agents working",
    );
    await expect(workingStatus).toHaveText(
      /^Worker [12], Worker [12] are working$/,
    );
    await expect(responseAvatars(threadTrigger)).toHaveCount(2);
    await openWorkingNow(page, thread);
    for (const name of ["Worker 1", "Worker 2"])
      await expect(
        popup.getByRole("button", { name: `View ${name} activity` }),
      ).toHaveCount(1);
    await closePopup();
    await expect(humanTyping(thread)).toHaveCount(0);
    const human = generateSecretKey();
    app.serveProfile(human, { name: "Human typer" });
    publish(human, roots[0]);
    await expect(humanTyping(thread)).toHaveCount(1);
    await expect(humanTyping(thread)).not.toContainText("Worker");
    await expect(workingStatus).toHaveText(/ are working\. .+ is typing$/);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("[data-panel-dock]").evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      );
    });
    for (const key of keys) publish(key, roots[0]);
    publish(human, roots[0]);
    await expect(threadTrigger).toHaveAccessibleName(
      "Activity: 2 agents working",
    );
    await expect(humanTyping(thread)).toBeVisible();
    // Human typing and agent avatars share one floating lane without overlap.
    const typingBox = await humanTyping(thread).boundingBox();
    const triggerBox = await threadTrigger.boundingBox();
    const formBox = await thread
      .getByRole("form", { name: "Reply to thread", exact: true })
      .boundingBox();
    expect(typingBox.y + typingBox.height).toBeLessThanOrEqual(formBox.y);
    expect(triggerBox.y + triggerBox.height).toBeLessThanOrEqual(formBox.y);
    expect(typingBox.x).toBeGreaterThanOrEqual(formBox.x);
    expect(triggerBox.y + triggerBox.height).toBeLessThanOrEqual(typingBox.y);
    expect(triggerBox.x + triggerBox.width).toBeLessThanOrEqual(
      formBox.x + formBox.width + 0.5,
    );
    await page.screenshot({
      path: testInfo.outputPath(
        "thread-single-agent-presentation-human-typing.png",
      ),
    });
    await page.setViewportSize({ width: 1440, height: 950 });
    publish(human, roots[0], 9);
    await expect(humanTyping(thread)).toHaveCount(0);
    await page
      .locator(
        '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button[aria-label^="Close "]',
      )
      .click();
    await openThread(roots[1]);
    await expect(
      thread.getByRole("region", { name: "Thread messages", exact: true }),
    ).toContainText(roots[1].content);
    await expect(threadTrigger).toHaveCount(0);
    await expect(workingStatus).toBeEmpty();
    await page
      .locator(
        '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button[aria-label^="Close "]',
      )
      .click();
    await openThread(roots[0]);
    // Fresh pulses avoid making the navigation assertions depend on fixture speed.
    for (const key of keys) publish(key, roots[0]);
    await expect(threadTrigger).toHaveAccessibleName(
      "Activity: 2 agents working",
    );
    publish(keys[0], roots[0], 9);
    await expect(threadTrigger).toHaveAccessibleName(
      "Activity: Worker 2 working",
    );
    publish(keys[1], roots[0], 9);
    await expect(threadTrigger).toHaveCount(0);
    await expect(workingStatus).toBeAttached();
    await expect(workingStatus).toBeEmpty();
    await expect(humanTyping(thread)).toHaveCount(0);
    await page
      .locator(
        '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button[aria-label^="Close "]',
      )
      .click();
    // The channel composer uses the same floating control and popup rows.
    const channelStatus = composer.locator("[data-agent-working-status]");
    publish(keys[0]);
    await expect(channelTrigger).toHaveAccessibleName(
      "Activity: Worker 1 working",
    );
    await expect(channelStatus).toHaveText("Worker 1 is working");
    await expect(humanTyping(composer)).toHaveCount(0);
    publish(keys[1]);
    await expect(channelTrigger).toHaveAccessibleName(
      "Activity: 2 agents working",
    );
    await expect(channelStatus).toHaveText(
      /^Worker [12], Worker [12] are working$/,
    );
    await expect(popup).toHaveCount(0);
    await openWorkingNow(page, composer);
    for (const name of ["Worker 1", "Worker 2"])
      await expect(
        popup.getByRole("button", { name: `View ${name} activity` }),
      ).toHaveCount(1);
    await closePopup();
    publish(human);
    await expect(humanTyping(composer)).toBeVisible();
    await expect(humanTyping(composer)).not.toContainText("Worker");
    await expect(channelStatus).toHaveText(/ are working\. .+ is typing$/);
    await page.screenshot({
      path: testInfo.outputPath("channel-multiple-agents-human-typing.png"),
    });
    publish(human, undefined, 9);
    await expect(humanTyping(composer)).toHaveCount(0);
    publish(keys[0], undefined, 9);
    await expect(channelTrigger).toHaveAccessibleName(
      "Activity: Worker 2 working",
    );
    publish(keys[1], undefined, 9);
    await expect(channelTrigger).toHaveCount(0);
    await page.locator('[data-channel-id="beta"]').click();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    await expect(page.locator("[data-agent-activity-trigger]")).toHaveCount(0);
    await expect(
      page.locator("[data-agent-working-status]:not(:empty)"),
    ).toHaveCount(0);
  });
});
