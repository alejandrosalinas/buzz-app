import { hoverMessage } from "./message-actions.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { settlePanelMotion } from "./navigation.mjs";
import { generateSecretKey, getPublicKey } from "nostr-tools";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  pluginFixtures: true,
  historyCounts: { alpha: 3, beta: 1 },
});

// Every thread reply, nested or not, carries the same full action bar; on desktop
// it is revealed by hover or focus.
async function replyActions(row) {
  await hoverMessage(row);
  return row.getByRole("group", { name: "Message actions", exact: true });
}

// Browser-only boundary: real composer -> signing broker -> live nested row;
// layout/focus at different panel widths, and routed reveal through collapsed DOM.
test("nested replies send, stay open, and reveal through links at readable panel widths", async ({
  page,
  app,
}) => {
  await open(page, app);
  const root = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 0");
  await page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ })
    .click();
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const editor = panel.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  const parent = panel
    .locator("[data-message-id]")
    .filter({ hasText: "Unread reply 0" });
  const history = panel.getByRole("region", { name: "Thread messages" });
  await expect(panel.locator('[data-depth="-1"]')).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Hide thread replies", exact: true }),
  ).toHaveCount(0);
  // Ordinary replies are direct siblings, not children of a collapsible panel.
  await expect(
    history.locator(":scope > [data-thread-rows] > ol > li").filter({
      has: page
        .locator("[data-message-id]")
        .filter({ hasText: "Unread reply 0" }),
    }),
  ).toHaveCount(1);
  // Compare settled positions; WebKit can sample the entering dock's transform
  // at different points even within one geometry read.
  await settlePanelMotion(page);
  const ordinaryGeometry = await parent.evaluate((node) => {
    const item = node.closest("li");
    const root = node
      .closest('[aria-label="Thread messages"]')
      .querySelector("[data-message-id]");
    return {
      rootLeft: root.getBoundingClientRect().left,
      replyLeft: node.getBoundingClientRect().left,
      connector: getComputedStyle(item, "::after").content,
    };
  });
  expect(ordinaryGeometry.replyLeft).toBe(ordinaryGeometry.rootLeft);
  expect(ordinaryGeometry.connector).toBe("none");
  await panel.screenshot({
    path: test.info().outputPath("ordinary-thread-replies.png"),
  });
  await editor.fill("Nested browser reply");
  await hoverMessage(parent);
  await parent.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(editor).toHaveText("Nested browser reply");
  let rejected;
  await page.route("**/api/relay/**/publish", async (route) => {
    const event = route.request().postDataJSON();
    if (!rejected && event.content === "Nested browser reply") {
      rejected = event;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          accepted: false,
          event_id: event.id,
          message: "Fixture rejection",
        }),
      });
    } else await route.continue();
  });
  await editor.press("Enter");
  const failed = panel
    .locator("[data-message-id]")
    .filter({ hasText: "Nested browser reply" });
  await expect(
    failed.getByText("Couldn’t send this message.", { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await failed.getByRole("button", { name: "Retry", exact: true }).click();
  await expect
    .poll(
      () =>
        app.report.publications.filter(
          ({ event }) => event?.content === "Nested browser reply",
        ).length,
    )
    .toBe(1);
  const nested = app.report.publications.find(
    ({ event }) => event?.content === "Nested browser reply",
  ).event;
  // Compare signed wire fields, not the verifier’s local symbol cache.
  expect(JSON.parse(JSON.stringify(nested))).toEqual(rejected);
  expect(nested.tags.filter(([key]) => key === "e")).toEqual([
    ["e", root.id, "", "root"],
    ["e", await parent.getAttribute("data-message-id"), "", "reply"],
  ]);
  const nestedRow = panel.locator(`[data-message-id="${nested.id}"]`);
  await expect(nestedRow).toBeInViewport();
  // The parent avatar is bottom aligned: its branch spine must begin below it.
  const spine = await parent.evaluate((node) => {
    const wrapper = node.parentElement;
    const line = getComputedStyle(wrapper, "::after");
    const avatar = node.querySelector(
      'button[aria-label^="View "][aria-label$=" profile"]',
    );
    return {
      content: line.content,
      top: wrapper.getBoundingClientRect().top + parseFloat(line.top),
      avatarBottom: avatar.getBoundingClientRect().bottom,
    };
  });
  expect(spine.content).toBe('""');
  expect(spine.top).toBeGreaterThanOrEqual(spine.avatarBottom);
  // Nested ancestry has a quiet elbow even when the author continues.
  const connector = await nestedRow.evaluate(
    (node) => getComputedStyle(node.closest("li"), "::before").content,
  );
  expect(connector).toBe('""');

  await expect(
    panel.getByRole("button", { name: "Cancel reply target" }),
  ).toHaveCount(0);
  await (await replyActions(nestedRow))
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  await expect(editor).toBeFocused();
  // Main's Up-to-edit shares this composer; cancel must retain the nested target
  // and the native draft history, rather than sending the draft to the root.
  await editor.fill("Unsent nested draft");
  await expect(editor).toHaveJSProperty("value", "Unsent nested draft");
  await editor.fill("");
  await expect(editor).toHaveJSProperty("value", "");
  // Up selects the newest message in the thread; E edits it in this composer.
  await editor.press("ArrowUp");
  await page.keyboard.press("e");
  const editInput = panel.getByRole("textbox", {
    name: "Edit message",
    exact: true,
  });
  await expect(editInput).toBeFocused();
  await expect(editInput).toHaveJSProperty("value", "Nested browser reply");
  await expect(
    panel.getByRole("button", { name: "Cancel reply target" }),
  ).toHaveCount(0);
  await editInput.press("Escape");
  await expect(editor).toBeFocused();
  await expect(
    panel.getByRole("button", { name: "Cancel reply target" }),
  ).toBeVisible();
  await editor.press("ControlOrMeta+z");
  await expect(editor).toHaveJSProperty("value", "Unsent nested draft");
  await editor.fill("Grandchild browser reply");
  let releaseGrandchild;
  let grandchildRequested = false;
  const grandchildGate = new Promise((resolve) => {
    releaseGrandchild = resolve;
  });
  await page.route("**/api/relay/**/publish", async (route) => {
    if (route.request().postDataJSON().content === "Grandchild browser reply") {
      grandchildRequested = true;
      await grandchildGate;
      await route.continue();
    } else await route.fallback();
  });
  await editor.press("Enter");
  try {
    const pending = panel
      .locator("[data-message-id]")
      .filter({ hasText: "Grandchild browser reply" });
    // Replying to a nested reply continues its branch, so an own consecutive
    // send stacks as a continuation.
    await expect(pending.locator('[data-layout="continuation"]')).toBeVisible();
    await expect.poll(() => grandchildRequested).toBe(true);
    await expect(
      (await replyActions(pending)).getByRole("button", {
        name: "Reply",
        exact: true,
      }),
    ).toBeDisabled();
    // Focus the bar's menu trigger to prove the full bar is keyboard-reachable on
    // a nested pending row, then return focus to the composer.
    const pendingMenu = pending.getByRole("button", {
      name: "More message actions",
      exact: true,
    });
    await pendingMenu.focus();
    await expect(pendingMenu).toBeFocused();
    // Inspecting the pending row intentionally moved focus away from composing.
    await editor.focus();
  } finally {
    releaseGrandchild();
  }
  await expect
    .poll(() =>
      app.report.publications.some(
        ({ event }) => event?.content === "Grandchild browser reply",
      ),
    )
    .toBe(true);
  const grandchild = app.report.publications.find(
    ({ event }) => event?.content === "Grandchild browser reply",
  ).event;
  expect(grandchild.tags.filter(([key]) => key === "e")).toEqual([
    ["e", root.id, "", "root"],
    ["e", nested.id, "", "reply"],
  ]);
  const grandchildRow = panel.locator(`[data-message-id="${grandchild.id}"]`);
  await expect(grandchildRow).toBeInViewport();
  await expect(editor).toBeFocused();
  // The signed parent stays exact, but the display keeps one level: the reply
  // joins the nested row's branch instead of opening a deeper one.
  await expect(
    grandchildRow.locator('[data-layout="continuation"]'),
  ).toBeVisible();
  const branchOf = (row) =>
    row.locator('xpath=ancestor::*[@data-depth="0"][1]');
  await expect(
    grandchildRow.locator("xpath=ancestor::*[@data-depth][1]"),
  ).toHaveAttribute("data-depth", "1");
  await expect(
    branchOf(nestedRow).locator(`[data-message-id="${grandchild.id}"]`),
  ).toHaveCount(1);
  await editor.focus();
  await expect(
    panel.getByRole("button", { name: /Hide replies|Collapse this branch/ }),
  ).toHaveCount(0);
  await expect(nestedRow).toBeVisible();
  await expect(grandchildRow).toBeVisible();

  let deepest = grandchildRow;
  for (let depth = 0; depth < 6; depth++) {
    await editor.hover();
    await (await replyActions(deepest))
      .getByRole("button", { name: "Reply", exact: true })
      .click();
    await expect(editor).toBeFocused();
    const content = `Deep reply ${depth}`;
    await editor.fill(content);
    await editor.press("Enter");
    await expect
      .poll(() =>
        app.report.publications.some(({ event }) => event?.content === content),
      )
      .toBe(true);
    const event = app.report.publications.find(
      ({ event }) => event?.content === content,
    ).event;
    expect(event.tags.filter(([key]) => key === "e")).toContainEqual([
      "e",
      root.id,
      "",
      "root",
    ]);
    deepest = panel.locator(`[data-message-id="${event.id}"]`);
    await expect(deepest).toBeInViewport();
    // Every reply in the chain stays in the same one-level branch.
    await expect(
      deepest.locator("xpath=ancestor::*[@data-depth][1]"),
    ).toHaveAttribute("data-depth", "1");
    await expect(
      branchOf(nestedRow).locator(`[data-message-id="${event.id}"]`),
    ).toHaveCount(1);
  }
  // Include phone widths with the persistent sidebar still visible.
  for (const width of [1492, 1280, 1024, 524, 522, 480, 390]) {
    await page.setViewportSize({ width, height: 950 });
    await deepest.scrollIntoViewIfNeeded();
    const geometry = await panel.evaluate((element) => {
      const history = element.querySelector('[aria-label="Thread messages"]');
      return { width: history.clientWidth, scroll: history.scrollWidth };
    });
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
    await expect(
      panel.getByRole("button", { name: /Hide replies|Collapse this branch/ }),
    ).toHaveCount(0);
    const deepestBox = await deepest.boundingBox();
    expect(deepestBox.width).toBeGreaterThan(140);
    // The open branch keeps its spine at every width.
    const spine = await branchOf(deepest).evaluate((node) => {
      const message = node.firstElementChild;
      const style = getComputedStyle(message, "::after");
      const history = node.closest('[aria-label="Thread messages"]');
      const x =
        message.getBoundingClientRect().left + parseFloat(style.left || "0");
      const bounds = history.getBoundingClientRect();
      return {
        content: style.content,
        inside: x >= bounds.left && x <= bounds.right,
      };
    });
    expect(spine).toEqual({ content: '""', inside: true });

    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (mode) =>
          document.documentElement.setAttribute("data-color-mode", mode),
        theme,
      );
      await panel.screenshot({
        path: test.info().outputPath(`nested-${width}-${theme}.png`),
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  await page
    .locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"])',
    )
    .click();
  const linked = app.append(
    "primary",
    "alpha",
    `Open <buzz://message?channel=alpha&id=${grandchild.id}>`,
  );
  const linkRow = page.locator(
    `[data-channel-timeline] [data-message-id="${linked.id}"]`,
  );
  await linkRow
    .getByRole("link", { name: "Fixture Reader in #Alpha", exact: true })
    .click();
  await expect(grandchildRow).toBeInViewport();
  await expect(grandchildRow).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.fixtureNavigation.snapshot().status))
    .toBe("opened");
  // Opened branches remain open through live arrivals and ordinary sends.
  app.reply(root.id);
  await expect(
    panel.getByText("New peer reply", { exact: true }),
  ).toBeVisible();
  await expect(grandchildRow).toBeVisible();
  await expect(parent).toBeVisible();
  // Sending to the thread must not disturb an opened nested branch.
  await editor.fill("Own ordinary thread reply");
  await editor.press("Enter");
  await expect(
    panel.getByText("Own ordinary thread reply", { exact: true }),
  ).toBeInViewport();
  // The optimistic row is visible before relay acceptance. Keep the production
  // subscription alive until publication and delivery settle, then end the test.
  await expect
    .poll(() =>
      app.report.publications.some(
        ({ event }) => event?.content === "Own ordinary thread reply",
      ),
    )
    .toBe(true);
  await expect(grandchildRow).toBeVisible();
  await expect(nestedRow).toBeVisible();
  await expect(parent).toBeVisible();
  const finalReply = app.report.publications.find(
    ({ event }) => event?.content === "Own ordinary thread reply",
  ).event;
  const finalActions = await replyActions(
    panel.locator(`[data-message-id="${finalReply.id}"]`),
  );
  await expect(
    finalActions.getByRole("button", { name: "Reply", exact: true }),
  ).toBeEnabled();
});

// Geometry, not presence: each hook must end on its own reply's avatar, on
// the reply's side, whatever renders around the row.
async function hookFor(row) {
  return row.evaluate((node) => {
    const item = node.closest("li");
    const line = getComputedStyle(item, "::before");
    const box = item.getBoundingClientRect();
    const avatar = node
      .querySelector('[class*="messageAvatar"], [class*="audienceAvatar"]')
      .getBoundingClientRect();
    const left = box.left + parseFloat(line.left);
    const top = box.top + parseFloat(line.top);
    return {
      content: line.content,
      curved: line.borderBottomWidth !== "0px",
      left,
      right: left + parseFloat(line.width),
      bottom: top + parseFloat(line.height),
      itemBottom: box.bottom,
      avatar: {
        left: avatar.left,
        right: avatar.right,
        center: (avatar.top + avatar.bottom) / 2,
      },
    };
  });
}
function expectHookOnAvatar(hook, side) {
  expect(hook.content).toBe('""');
  expect(hook.curved).toBe(true);
  expect(Math.abs(hook.bottom - hook.avatar.center)).toBeLessThan(1);
  // The hook stops one token short of the avatar's near edge.
  if (side === "left") {
    expect(hook.right).toBeLessThan(hook.avatar.left);
    expect(hook.avatar.left - hook.right).toBeLessThan(6);
  } else {
    expect(hook.left).toBeGreaterThan(hook.avatar.right);
    expect(hook.left - hook.avatar.right).toBeLessThan(6);
  }
}
function expectStraightLine(hook) {
  expect(hook.content).toBe('""');
  expect(hook.curved).toBe(false);
  expect(Math.abs(hook.bottom - hook.itemBottom)).toBeLessThan(1);
}

test("branch hooks land on each reply's avatar across sides and row shapes", async ({
  page,
  app,
}) => {
  const agent = generateSecretKey();
  await page.route("**/agent-library", (route) =>
    route.fulfill({
      json: {
        definitions: [],
        identities: [{ pubkey: getPublicKey(agent), name: "Hook Agent" }],
      },
    }),
  );
  const root = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 0");
  const post = (content, own, parent, tags) =>
    app.append("primary", "alpha", content, false, own, root.id, parent, tags);
  const agents = [["audience", "agents"]];
  const note =
    "Agents coordination note that wraps onto several lines once it opens in the thread";
  const peer = post("Peer branch", false);
  const peerReply = post("Peer reply", false, peer.id);
  const peerOwn = post("Own reply on the other side", true, peer.id);
  const viewer = post("Viewer branch", true);
  const viewerPeer = post("Peer reply on the other side", false, viewer.id);
  const viewerReply = post("Viewer reply", true, viewer.id);
  const agentPeer = post("Agent branch", false);
  const agentPeerReply = post(note, false, agentPeer.id, agents);
  const agentViewer = post("Viewer agents branch", true);
  const ownAgents = post(`Own ${note}`, true, agentViewer.id, agents);
  const ownAgentsInPeer = post("Agents host", false);
  const ownAgentsLeft = post(
    `Viewer ${note}`,
    true,
    ownAgentsInPeer.id,
    agents,
  );
  const ownAgentsStart = post("Own agents start", true, undefined, agents);
  const startReply = post(
    "Reply to own agents start",
    false,
    ownAgentsStart.id,
  );
  const emoji = post("Emoji branch", false);
  const emojiReply = post("🎉", false, emoji.id);
  await open(page, app);
  app.serveProfile(agent, { name: "Hook Agent", is_agent: true });
  await page.setViewportSize({ width: 1280, height: 1600 });
  await page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ })
    .click();
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const row = (event) => panel.locator(`[data-message-id="${event.id}"]`);
  for (const branch of [
    peer,
    viewer,
    agentPeer,
    agentViewer,
    ownAgentsInPeer,
    ownAgentsStart,
    emoji,
  ]) {
    const summary = row(branch)
      .locator("xpath=ancestor::*[@data-depth][1]")
      .locator(":scope > div [data-thread-summary]");
    if (await summary.count()) await summary.click();
  }
  await expect(row(startReply)).toBeVisible();
  for (const event of [agentPeerReply, ownAgentsLeft, ownAgents]) {
    await panel
      .getByRole("button", {
        name: new RegExp(`^Show activity history: .*: ${event.content}$`),
      })
      .click();
  }

  // Peer- and viewer-started branches hook on their own side; a reply on the
  // other side gets a straight line past it.
  await row(peerReply).scrollIntoViewIfNeeded();
  expectHookOnAvatar(await hookFor(row(peerReply)), "left");
  expectStraightLine(await hookFor(row(peerOwn)));
  await row(viewerReply).scrollIntoViewIfNeeded();
  expectStraightLine(await hookFor(row(viewerPeer)));
  expectHookOnAvatar(await hookFor(row(viewerReply)), "right");

  // A final agents reply keeps its hook on the avatar, open or closed. The
  // viewer's own agents line renders on the left, so it is not right-side.
  for (const [event, check] of [
    [agentPeerReply, (hook) => expectHookOnAvatar(hook, "left")],
    [ownAgentsLeft, (hook) => expectHookOnAvatar(hook, "left")],
    [ownAgents, expectStraightLine],
  ]) {
    const reply = row(event);
    await reply.scrollIntoViewIfNeeded();
    check(await hookFor(reply));
    const toggle = reply.getByRole("button", { name: /coordination note/ });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await reply.evaluate((node) =>
      Promise.all(
        node.getAnimations({ subtree: true }).map((motion) => motion.finished),
      ),
    );
    check(await hookFor(reply));
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await reply.evaluate((node) =>
      Promise.all(
        node.getAnimations({ subtree: true }).map((motion) => motion.finished),
      ),
    );
    check(await hookFor(reply));
  }
  // An own agents line starting a branch keeps the spine and hooks on the left.
  await row(startReply).scrollIntoViewIfNeeded();
  expectHookOnAvatar(await hookFor(row(startReply)), "left");

  // Reactions under an emoji-only bubble do not move the hook off the avatar.
  const reacted = row(emojiReply);
  await reacted.scrollIntoViewIfNeeded();
  await hoverMessage(reacted);
  await reacted
    .getByRole("button", { name: "Add reaction", exact: true })
    .click();
  await page.locator('em-emoji-picker input[type="search"]').fill("thumbsup");
  await page
    .locator("em-emoji-picker")
    .getByRole("button", { name: "👍", exact: true })
    .click();
  await expect(
    reacted.getByRole("button", { name: /👍/ }).last(),
  ).toBeVisible();
  // The chip renders optimistically; confirm a signed kind-7 tagged with this
  // reply's id actually reached the relay before the journey moves on.
  await expect
    .poll(() =>
      app.report.publications.some(
        ({ event }) =>
          event.kind === 7 &&
          event.tags.some(([name, id]) => name === "e" && id === emojiReply.id),
      ),
    )
    .toBe(true);
  await panel.getByRole("textbox", { name: "Reply to thread" }).focus();
  const hook = await hookFor(reacted);
  expect(hook.itemBottom - hook.avatar.center).toBeGreaterThan(30);
  expectHookOnAvatar(hook, "left");

  // An agent's activity under a reply carries the agent's avatar on the left;
  // the hook stays on the reply's own avatar rather than crossing the
  // transparent activity bubble to reach it. An agents reply mounts its
  // activity only inside its open disclosure.
  const disclosure = row(agentPeerReply).getByRole("button", {
    name: /coordination note/,
  });
  await row(agentPeerReply).scrollIntoViewIfNeeded();
  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await row(agentPeerReply).evaluate((node) =>
    Promise.all(
      node.getAnimations({ subtree: true }).map((motion) => motion.finished),
    ),
  );
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  for (const [index, reply] of [
    peerReply,
    viewerReply,
    agentPeerReply,
  ].entries())
    app.observer(
      {
        kind: "turn_started",
        seq: index + 1,
        timestamp: new Date().toISOString(),
        channelId: "alpha",
        sessionId: "hooks",
        turnId: `hooks-${index}`,
        payload: { triggeringEventIds: [reply.id] },
      },
      agent,
    );
  for (const [reply, side] of [
    [peerReply, "left"],
    [viewerReply, "right"],
    [agentPeerReply, "left"],
  ]) {
    const activity = row(reply).getByRole("region", {
      name: "Agent activity on this message",
      exact: true,
    });
    await expect(activity).toBeVisible();
    await activity.evaluate((section) =>
      Promise.all(section.getAnimations().map((motion) => motion.finished)),
    );
    await row(reply).scrollIntoViewIfNeeded();
    expectHookOnAvatar(await hookFor(row(reply)), side);
  }
});

// A collapsed branch summary reads as the same quiet caption as the channel
// feed's thread summary, not as a larger button label.
test("branch summaries match the channel thread summary's type", async ({
  page,
  app,
}) => {
  const root = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 0");
  const branch = app.append(
    "primary",
    "alpha",
    "Summary branch",
    false,
    false,
    root.id,
  );
  app.append(
    "primary",
    "alpha",
    "Summary branch reply",
    false,
    false,
    root.id,
    branch.id,
  );
  await open(page, app);
  const channelSummary = page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ });
  await channelSummary.click();
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const branchSummary = panel
    .locator(`[data-message-id="${branch.id}"]`)
    .locator("xpath=ancestor::*[@data-depth][1]")
    .getByRole("button", { name: /^View 1 reply/ });
  await expect(branchSummary).toBeVisible();
  await settlePanelMotion(page);
  const type = (node) => {
    const style = getComputedStyle(node);
    return {
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      fontWeight: style.fontWeight,
      paddingBlock: `${style.paddingTop} ${style.paddingBottom}`,
      paddingInline: `${style.paddingLeft} ${style.paddingRight}`,
      height: Math.round(node.getBoundingClientRect().height),
    };
  };
  expect(await branchSummary.evaluate(type)).toEqual(
    await channelSummary.evaluate(type),
  );
  await page.screenshot({
    path: test.info().outputPath("branch-summary-type.png"),
  });
});

test("an exact linked reply stays readable when its parent is outside loaded history", async ({
  page,
  app,
}) => {
  const root = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 0");
  // Peer-authored rows never enter this viewer's persistent outbox. The bounded
  // history contains the child and root, but not the intermediate parent.
  const child = app.append(
    "primary",
    "alpha",
    "Exact orphan reply",
    false,
    false,
    root.id,
    "a".repeat(64),
  );
  const link = app.append(
    "primary",
    "alpha",
    `Open <buzz://message?channel=alpha&id=${child.id}>`,
    false,
  );
  await open(page, app);
  await page
    .locator(`[data-channel-timeline] [data-message-id="${link.id}"]`)
    .getByRole("link", { name: "Alice Fixture in #Alpha", exact: true })
    .click();
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const orphan = panel.locator(`[data-message-id="${child.id}"]`);
  await expect(orphan).toBeFocused();
  await expect(orphan).toBeInViewport();
  await expect(
    panel.getByText("Earlier reply unavailable in loaded history.", {
      exact: true,
    }),
  ).toBeVisible();
});

test.describe("touch branch controls", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("expands with a visible touch target and removes it once open", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const root = app.histories
      .get("primary/alpha")
      .find((event) => event.content === "Thread root 0");
    const thread = page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ });
    // This case exercises touch controls inside the thread, not the virtualized feed's pointer lock.
    await thread.focus();
    await thread.press("Enter");
    const panel = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const summary = panel.getByRole("button", { name: /^View 1 reply/ });
    await expect(summary).toContainText("(1 new)");
    await summary.tap();
    await expect(summary).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: /Hide replies|Collapse this branch/ }),
    ).toHaveCount(0);
    const history = panel.getByRole("region", { name: "Thread messages" });
    const geometry = await history.evaluate((node) => ({
      width: node.clientWidth,
      scroll: node.scrollWidth,
    }));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
    const branch = panel.locator('[data-depth="0"][data-open="true"]').first();
    const child = branch.locator(":scope > [id] [data-message-id]").first();
    await expect(child).toBeFocused();
    await expect(child).toBeVisible();
    const actions = child.getByRole("group", {
      name: "Message actions",
      exact: true,
    });
    await expect(actions).toBeVisible();
    await actions
      .getByRole("button", { name: "Add reaction", exact: true })
      .tap();
    await expect(
      page.getByRole("dialog", { name: "Emoji picker", exact: true }),
    ).toBeVisible();
    const emojiSearch = page.locator('em-emoji-picker input[type="search"]');
    await expect(emojiSearch).toBeFocused();
    await emojiSearch.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "Emoji picker", exact: true }),
    ).toHaveCount(0);
    await expect(actions).toBeVisible();
    const menuTrigger = actions.getByRole("button", {
      name: "More message actions",
      exact: true,
    });
    await menuTrigger.tap();
    await expect(
      page.getByRole("menuitem", { name: "Copy message", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(menuTrigger).toBeFocused();
    await expect(actions).toBeVisible();
    await actions.getByRole("button", { name: "Reply", exact: true }).tap();
    await expect(
      panel.getByRole("textbox", { name: "Reply to thread" }),
    ).toBeFocused();
    await expect(
      panel.getByRole("button", { name: "Cancel reply target" }),
    ).toBeVisible();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const motion = await branch.locator(":scope > [id]").evaluate((node) => ({
      transition: getComputedStyle(node).transitionDuration,
      animation: getComputedStyle(node).animationDuration,
    }));
    expect(motion).toEqual({ transition: "0s", animation: "0s" });

    app.reply(root.id);
    await expect(
      panel.getByText("New peer reply", { exact: true }),
    ).toBeVisible();
    await expect(child).toBeVisible();
    await expect(summary).toHaveCount(0);
  });
});

// Real pointer hit testing and focus cannot be verified in jsdom.
for (const width of [1492, 1280, 1024, 700, 390])
  test(`crowded capped branches expand once with readable actions at ${width}`, async ({
    page,
    app,
  }) => {
    const root = app.histories
      .get("primary/alpha")
      .find((e) => e.content === "Thread root 0");
    let parent = root.id;
    const ids = [];
    for (let i = 0; i < 13; i++) {
      parent = app.append(
        "primary",
        "alpha",
        `Crowded reply ${i}`,
        false,
        i < 9 ? i % 2 === 0 : true,
        root.id,
        parent,
      ).id;
      ids.push(parent);
    }
    const continuation = app.append(
      "primary",
      "alpha",
      "Same-parent continuation",
      false,
      true,
      root.id,
      ids.at(-2),
    );
    await open(page, app);
    await page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ })
      .click();
    const panel = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const branchFor = (id) =>
      panel.locator(`[data-message-id="${id}"]`).locator("../..");
    // The whole reply chain lifts into the first reply's branch, so one
    // disclosure reveals every reply in history order.
    const expandAll = async () => {
      const branch = branchFor(ids[0]);
      await expect(branch).toHaveAttribute("data-open", "false");
      await expect(
        panel.getByRole("region", { name: "Thread messages", exact: true }),
      ).toHaveAttribute("aria-busy", "false");
      await branch
        .locator(":scope > div")
        .nth(1)
        .getByRole("button")
        .press("Enter");
      await expect(
        panel.locator(`[data-message-id="${ids[1]}"]`),
      ).toBeFocused();
      await expect(
        branch.getByRole("button", { name: /^View \d+ repl/ }),
      ).toHaveCount(0);
      expect(
        await branch
          .locator("[data-message-id]")
          .evaluateAll((rows) => rows.map((row) => row.dataset.messageId)),
      ).toEqual([...ids, continuation.id]);
    };
    await page.setViewportSize({ width, height: 950 });
    await expandAll();
    // Stacked bubbles share one avatar, so only the last of a run hooks in.
    const hooks = await panel
      .locator(
        `[data-message-id="${ids[9]}"], [data-message-id="${continuation.id}"]`,
      )
      .evaluateAll((rows) =>
        rows.map(
          (row) => getComputedStyle(row.closest("li"), "::before").content,
        ),
      );
    expect(hooks).toEqual(["none", '""']);
    // A same-parent continuation keeps its full timestamp for assistive
    // technology without an inline clock or a bubble hover.
    const continuationRow = panel.locator(
      `[data-message-id="${continuation.id}"]`,
    );
    await expect(
      continuationRow.locator('[data-layout="continuation"]'),
    ).toBeVisible();
    const clock = continuationRow.locator("time");
    await panel.getByRole("textbox", { name: "Reply to thread" }).focus();
    await page
      .locator('[role="tab"][data-tab-value^="thread:"][aria-selected="true"]')
      .hover();
    await expect(clock).toHaveClass(/sr-only/);
    await continuationRow
      .getByText("Same-parent continuation", { exact: true })
      .hover();
    await expect(clock).toContainText(/\d{4}/);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await continuationRow
      .getByRole("button", { name: "More message actions", exact: true })
      .focus();
    await page
      .locator('[role="tab"][data-tab-value^="thread:"][aria-selected="true"]')
      .hover();
    await expect(clock).toHaveClass(/sr-only/);
    for (const id of [...ids, continuation.id]) {
      const branch = branchFor(id);
      const row = panel.locator(`[data-message-id="${id}"]`);
      await panel.getByRole("textbox", { name: "Reply to thread" }).focus();
      await page
        .locator(
          '[role="tab"][data-tab-value^="thread:"][aria-selected="true"]',
        )
        .hover();
      await row.scrollIntoViewIfNeeded();
      // Exercise the lifted bar away from the top edge. Morgan accepted
      // clipping at that boundary; scrolling the row down restores access.
      await row.evaluate((node) => {
        const history = node.closest('[aria-label="Thread messages"]');
        history.scrollTop +=
          node.getBoundingClientRect().top -
          history.getBoundingClientRect().top -
          history.clientHeight / 2;
      });
      const restingHeight = (await row.boundingBox()).height;
      await hoverMessage(row);
      expect((await row.boundingBox()).height).toBe(restingHeight);
      // Every reply, nested or not, exposes the same full bar. Revealing it must
      // not reflow the row.
      const actions = row.getByRole("group", {
        name: "Message actions",
        exact: true,
      });
      await expect(actions).toHaveCount(1);
      await expect(actions).toHaveCSS("opacity", "1");
      // Opacity can round to 1 before the entrance transform has finished.
      // Measure settled placement after the actual animation completes.
      await actions.evaluate((bar) =>
        Promise.all(bar.getAnimations().map((animation) => animation.finished)),
      );
      if (width >= 640) {
        // Headers and continuations both lift the bar over the bubble's top
        // corner by the same token-sized overlap.
        const placement = await row.evaluate((node) => {
          const bar = node.querySelector('[aria-label="Message actions"]');
          const body = node.querySelector('[class*="_messageBubble_"]');
          const rect = bar.getBoundingClientRect();
          const anchor = body.getBoundingClientRect();
          return {
            actual: rect.bottom,
            expected:
              anchor.top +
              parseFloat(getComputedStyle(bar).scrollMarginBlockStart),
          };
        });
        expect(placement.actual).toBeCloseTo(placement.expected, 1);
        // Header anchoring must not wrap a full toolbar inside the narrower
        // body column before the row-width action reductions take effect.
        const centres = await actions.evaluate((bar) =>
          [...bar.querySelectorAll("button")]
            .map((button) => button.getBoundingClientRect())
            .filter((box) => box.width > 0 && box.height > 0)
            .map((box) => box.top + box.height / 2),
        );
        expect(Math.max(...centres) - Math.min(...centres)).toBeLessThan(1);
      }
      // Reaching the bar from the byline is the natural pointer path, and the bar
      // is allowed to sit over the timestamp. The date hint must therefore never
      // take ownership of the pointer where the bar is: it outranks the bar in the
      // layer stack, so a hoverable hint would swallow every action click.
      const stamp = row.locator("time");
      if (await stamp.count()) {
        // Metadata is not a pointer reveal target. Keep the toolbar keyboard-
        // owned while checking that it remains hit-testable over the byline.
        await page.keyboard.press("Tab");
        await actions.getByRole("button").first().focus();
        const hint = await stamp.boundingBox();
        await page.mouse.move(hint.x + 4, hint.y + hint.height / 2);
        await expect
          .poll(() =>
            actions.evaluate((bar) =>
              [...bar.querySelectorAll("button")]
                .filter((button) => {
                  const box = button.getBoundingClientRect();
                  return box.width > 0 && box.height > 0;
                })
                .every((button) => {
                  const box = button.getBoundingClientRect();
                  return document
                    .elementsFromPoint(
                      (box.left + box.right) / 2,
                      (box.top + box.bottom) / 2,
                    )[0]
                    ?.isSameNode(button);
                }),
            ),
          )
          .toBe(true);
        await hoverMessage(row);
      }
      // Every action is on screen, enabled and owns the pointer at its centre.
      // One page-side check per row: a trial click per button made this test
      // the slowest in its shard and timed it out on slow WebKit runners.
      await expect
        .poll(() =>
          actions.evaluate((bar) => {
            // Row-width reductions remove actions from layout, not from the DOM.
            const buttons = [...bar.querySelectorAll("button")].filter(
              (button) =>
                button.getClientRects().length > 0 &&
                getComputedStyle(button).visibility !== "hidden",
            );
            return (
              buttons.length > 0 &&
              buttons.every((button) => {
                const box = button.getBoundingClientRect();
                const x = (box.left + box.right) / 2;
                const y = (box.top + box.bottom) / 2;
                return (
                  x >= 0 &&
                  y >= 0 &&
                  x < window.innerWidth &&
                  y < window.innerHeight &&
                  !button.disabled &&
                  button.contains(document.elementFromPoint(x, y))
                );
              })
            );
          }),
        )
        .toBe(true);
      // The bar must not cover this row's own message text. Compare against the
      // rendered body only, inset by half-leading so leading is not read as ink.
      // Include headerless continuation rows: the shared lift must clear them too.
      await expect
        .poll(() =>
          row.evaluate((node) => {
            const tray = node
              .querySelector('[aria-label="Message actions"]')
              .getBoundingClientRect();
            const body = node.querySelectorAll(
              '[class*="_text_"], [class*="_plainText_"]',
            );
            for (const element of body) {
              const size = parseFloat(getComputedStyle(element).fontSize);
              const walker = document.createTreeWalker(
                element,
                NodeFilter.SHOW_TEXT,
              );
              for (
                let text = walker.nextNode();
                text;
                text = walker.nextNode()
              ) {
                if (!text.textContent.trim()) continue;
                const range = document.createRange();
                range.selectNodeContents(text);
                for (const rect of range.getClientRects()) {
                  if (!rect.width || !rect.height) continue;
                  const lead = Math.max(0, (rect.height - size) / 2);
                  const dx =
                    Math.min(tray.right, rect.right) -
                    Math.max(tray.left, rect.left);
                  const dy =
                    Math.min(tray.bottom, rect.bottom - lead) -
                    Math.max(tray.top, rect.top + lead);
                  if (dx > 0.5 && dy > 0.5) return true;
                }
              }
            }
            return false;
          }),
        )
        .toBe(false);
      if (width >= 640 && id === continuation.id) {
        // Real diagonal pointer travel must not drop the hover-only toolbar.
        await panel.getByRole("textbox", { name: "Reply to thread" }).focus();
        const body = await row
          .getByText("Same-parent continuation", { exact: true })
          .boundingBox();
        await page.mouse.move(body.x + 4, body.y + body.height / 2);
        await expect(actions).toHaveCSS("opacity", "1");
        const reply = actions.getByRole("button", {
          name: "Reply",
          exact: true,
        });
        const target = await reply.boundingBox();
        await page.mouse.move(
          target.x + target.width / 2,
          target.y + target.height / 2,
          { steps: 20 },
        );
        await expect(actions).toHaveCSS("opacity", "1");
        await reply.click({ trial: true });
      }
      await expect(
        branch.getByRole("button", {
          name: /Hide replies|Collapse this branch/,
        }),
      ).toHaveCount(0);
    }
    await panel.getByRole("textbox", { name: "Reply to thread" }).focus();
    await page
      .locator('[role="tab"][data-tab-value^="thread:"][aria-selected="true"]')
      .hover();
    // Resting state must match the contract for every rendered reply, not just
    // the first: hidden on desktop hover-capable widths, always usable below 640.
    for (const id of [...ids, continuation.id]) {
      await expect(
        panel
          .locator(`[data-message-id="${id}"]`)
          .getByRole("group", { name: "Message actions", exact: true }),
      ).toHaveCSS("opacity", "0");
    }
    await panel.screenshot({
      path: test.info().outputPath(`crowded-${width}.png`),
    });
  });
