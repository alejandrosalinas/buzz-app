import { hoverMessage } from "./message-actions.mjs";
import { test, expect } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";

test.use({
  productionBroker: true,
  dmLabels: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 3, beta: 1 },
});

// Browser-only: layout clipping can blank both the preview and expanded prose
// between React states even when the height transition itself runs correctly.
test("coordination keeps its first line visible throughout expansion and collapse", async ({
  page,
  app,
}) => {
  await open(page, app);
  const root = app.append("primary", "alpha", "Coordination motion check");
  const original = page.locator(
    `[data-channel-timeline] [data-message-id="${root.id}"]`,
  );
  await hoverMessage(original);
  await original.getByRole("button", { name: "Reply", exact: true }).click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const event = app.append(
    "primary",
    "alpha",
    "Three café names:\n\n1. Corner Cup: Friendly and local.\n2. Common Grounds: A gathering place.\n3. Porchlight Café: Warm and welcoming.\n\n[Nested destination](https://example.com/context)",
    true,
    true,
    root.id,
    undefined,
    [["audience", "agents"]],
  );
  await thread.getByRole("button", { name: /^Show activity history:/ }).click();
  const row = thread.locator(`[data-message-id="${event.id}"]`);
  const toggle = row.getByRole("button", { name: /Three café names:/ });
  await expect(toggle).toBeVisible();
  await settle(page, thread.getByRole("region", { name: "Thread messages" }));
  const result = await row.evaluate(async (row) => {
    const button = row.querySelector("button[aria-expanded]");
    const preview = row.querySelector('[class*="audiencePreview"]');
    if (!preview) throw new Error("Coordination preview is missing");
    // Pane entry can move the whole row while the disclosure animates.
    const textEdge =
      preview.getBoundingClientRect().left - row.getBoundingClientRect().left;
    const failures = [];
    let animated = false;
    // A busy frame can miss the entire transition. Observe its start before
    // clicking; frame samples still check clipping and settlement below.
    const onTransitionStart = (event) => {
      if (
        event.target.matches('[class*="audiencePanel"]') &&
        event.propertyName === "height"
      )
        animated = true;
    };
    row.addEventListener("transitionstart", onTransitionStart);
    const sample = (opening) => {
      const panel = row.querySelector('[class*="audiencePanel"]');
      const preview = row.querySelector('[class*="audiencePreview"]');
      const text = panel?.querySelector("p");
      const panelBox = panel?.getBoundingClientRect();
      const textBox = text?.getBoundingClientRect();
      const previewVisible =
        !!preview && preview.getBoundingClientRect().height > 0;
      const firstLineVisible =
        !!textBox &&
        !!panelBox &&
        Math.min(textBox.bottom, panelBox.bottom) -
          Math.max(textBox.top, panelBox.top) >=
          Number.parseFloat(getComputedStyle(text).lineHeight) / 2;
      if (!previewVisible && !firstLineVisible)
        failures.push(opening ? "opening" : "closing");
      if (
        textBox &&
        Math.abs(textBox.left - row.getBoundingClientRect().left - textEdge) >
          0.5
      )
        failures.push(
          opening ? "opening shifted text" : "closing shifted text",
        );
      const running = panel
        ?.getAnimations()
        .some((animation) => animation.playState === "running");
      return { panel, running };
    };
    try {
      for (const opening of [true, false]) {
        const start = performance.now();
        button.click();
        await new Promise((resolve, reject) => {
          let settled = 0;
          const tick = () => {
            const { panel, running } = sample(opening);
            settled = (
              opening
                ? panel &&
                  !panel.hasAttribute("data-starting-style") &&
                  !running
                : !panel
            )
              ? settled + 1
              : 0;
            if (settled >= 2) resolve();
            else if (performance.now() - start > 5000)
              reject(new Error("Coordination transition did not settle"));
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      }
    } finally {
      row.removeEventListener("transitionstart", onTransitionStart);
    }
    return { failures, animated };
  });
  expect(result).toEqual({ failures: [], animated: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(
    row.getByText("Three café names:", { exact: true }),
  ).toBeVisible();
  await expect(row.getByTestId("inline-add-reaction")).toHaveCount(0);
  // A real nested link owns its handled keyboard gesture; the row still owns
  // the same gesture on its disclosure. Verify each portal's focus return.
  const link = row.getByRole("link", {
    name: "Nested destination",
    exact: true,
  });
  await link.focus();
  await page.keyboard.press("Shift+F10");
  await expect(
    page.getByRole("menuitem", { name: "Open in browser", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(1);
  await expect(page.getByRole("menu")).toBeFocused();
  await expect(
    page.getByRole("menuitem", { name: "Copy message", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(link).toBeFocused();
  await toggle.focus();
  await page.keyboard.press("Shift+F10");
  await expect(
    page.getByRole("menuitem", { name: "Copy message", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(1);
  await expect(page.getByRole("menu")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(toggle).toBeFocused();
});

// Native Tab must discover deferred controls before the browser chooses focus;
// continuation rows have no avatar that could activate them on the way in.
for (const direction of ["forward", "backward"]) {
  test(`Tab enters untouched continuation actions ${direction} without an extra stop`, async ({
    page,
    app,
  }) => {
    await open(page, app);
    await page
      .getByRole("textbox", { name: "Message #Alpha", exact: true })
      .click();
    await page.mouse.move(0, 0);
    const before = app.append(
      "primary",
      "alpha",
      "[Before](https://example.com/before)",
    );
    const target = app.append("primary", "alpha", "Untouched continuation");
    const after = app.append("primary", "alpha", "Following continuation");
    const row = (event) =>
      page.locator(`[data-channel-timeline] [data-message-id="${event.id}"]`);
    await expect(row(target).locator("[data-stack-previous]")).toBeVisible();
    await expect(row(after)).toBeVisible();
    await settle(page);
    const actions = row(target).getByRole("group", {
      name: "Message actions",
      includeHidden: true,
    });
    await expect(
      actions.getByRole("button", { includeHidden: true }),
    ).toHaveCount(0);
    if (direction === "forward")
      await row(before)
        .getByRole("link", { name: "Before", exact: true })
        .focus();
    else
      await row(after)
        .getByRole("button", { name: /^View .* profile$/ })
        .first()
        .focus();
    await expect(
      actions.getByRole("button", { includeHidden: true }),
    ).toHaveCount(0);
    await page.keyboard.press(direction === "forward" ? "Tab" : "Shift+Tab");
    await expect(
      actions.getByRole("button", {
        name: direction === "forward" ? "Add reaction" : "More message actions",
        exact: true,
      }),
    ).toBeFocused();
    await expect(actions.locator("[data-message-keyboard-time]")).toBeVisible();
    await page.keyboard.press(direction === "forward" ? "Tab" : "Shift+Tab");
    await expect(
      actions.getByRole("button", {
        name: direction === "forward" ? "Reply" : "Forward message",
        exact: true,
      }),
    ).toBeFocused();
  });
}

// Browser-only contracts: actual hover/coarse-pointer layout, portal focus return,
// and opening a real thread then focusing its real editor. Clipboard failures and
// mention matrices live in colocated unit tests, not a browser scenario matrix.
test("message actions reveal, copy, restore focus and reply across responsive layouts", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    window.copiedMessages = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.copiedMessages.push(text);
        },
      },
    });
  });
  await open(page, app);
  const event = app.append("primary", "alpha", "Message actions browser check");
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  await expect(row).toBeVisible();
  const actions = row.getByRole("group", { name: "Message actions" });
  await page.mouse.move(0, 0);
  await expect(actions).toHaveCSS("opacity", "0");
  await hoverMessage(row);
  await expect(actions).toHaveCSS("opacity", "1");
  const trigger = row.getByRole("button", { name: "More message actions" });
  await trigger.focus();
  await trigger.press("Enter");
  await expect(
    page.getByRole("menuitem", { name: "Copy message", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page
    .getByRole("menuitem", { name: "Copy message", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "App notifications" })
      .getByText("Message copied", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.copiedMessages)).toEqual([
    event.content,
  ]);
  await hoverMessage(row);
  await row.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "App notifications" })
      .getByText("Link copied", { exact: true }),
  ).toBeVisible();
  const copiedLink = await page.evaluate(() => window.copiedMessages.at(-1));
  expect(copiedLink).toBe(`buzz://message?channel=alpha&id=${event.id}`);
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const root = panel.locator(`[data-message-id="${event.id}"]`);
  await expect(root).toBeVisible();
  // A pointer click leaves focus on the control; the bar still follows hover.
  const copyLink = row.getByRole("button", {
    name: "Copy link",
    exact: true,
  });
  await hoverMessage(row);
  await copyLink.click();
  await root.hover();
  await expect(actions).toHaveCSS("opacity", "0");
  // Tab only exercises the keyboard path if focus is still on Copy link, so
  // it lands on the row's next control. Copy link is briefly disabled while
  // copying, which would otherwise let focus fall back to the body.
  await expect(copyLink).toBeFocused();
  // Keyboard focus still reveals it while the mouse is elsewhere.
  await page.keyboard.press("Tab");
  await expect(actions).toHaveCSS("opacity", "1");
  // Assistive presses arrive without navigation keydowns; focus alone reveals
  // the bar. Clicking plain text first clears the keyboard-modality flag.
  const menu = page.getByRole("menu");
  await row.getByText(event.content, { exact: true }).click();
  await page.mouse.move(0, 0);
  await trigger.focus();
  // Script focus after a pointer click stays quiet.
  await expect(actions).toHaveCSS("opacity", "0");
  await trigger.press("Enter");
  await expect(
    page.getByRole("menuitem", { name: "Copy message", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(actions).toHaveCSS("opacity", "1");
  // Keyboard dismissal restores focus even when the menu was pointer-opened.
  // Waiting for deferred initial focus keeps Escape off the trigger.
  await hoverMessage(row);
  await trigger.click();
  await expect(menu).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.mouse.move(0, 0);
  await expect(actions).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  // Keyboard opening focuses the first item; Mark unread leads a managed row.
  await expect(
    page.getByRole("menuitem", { name: "Mark unread", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  // Pointer-only selection still leaves the bar free to follow hover.
  await hoverMessage(row);
  await trigger.click();
  await expect(menu).toBeFocused();
  await page
    .getByRole("menuitem", { name: "Copy message", exact: true })
    .click();
  await expect(menu).toHaveCount(0);
  await expect(trigger).not.toBeFocused();
  await page.mouse.move(0, 0);
  await expect(actions).toHaveCSS("opacity", "0");
  await hoverMessage(root);
  await root.getByRole("button", { name: "Add reaction", exact: true }).click();
  await page.locator('em-emoji-picker input[type="search"]').fill("thumbsup");
  await page
    .locator("em-emoji-picker")
    .getByRole("button", { name: "👍", exact: true })
    .click();
  await expect(
    root.getByRole("button", {
      name: "👍: You",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    row.getByRole("button", {
      name: "👍: You",
      exact: true,
    }),
  ).toBeVisible();
  await root.getByRole("button", { name: "👍: You", exact: true }).click();
  await expect(
    root.getByRole("button", { name: "👍: You", exact: true }),
  ).toHaveCount(0);
  await expect(
    row.getByRole("button", { name: "👍: You", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(
      () =>
        app.report.publications.filter(({ event }) => event.kind === 5).length,
    )
    .toBe(1);
  const added = app.report.publications.find(
    ({ event }) => event.kind === 7,
  ).event;
  const removed = app.report.publications.find(
    ({ event }) => event.kind === 5,
  ).event;
  expect(added.tags).toContainEqual(["e", event.id]);
  expect(removed.tags).toContainEqual(["e", added.id]);
  expect(removed.pubkey).toBe(added.pubkey);
  await hoverMessage(root);
  await root.getByRole("button", { name: "Reply", exact: true }).click();
  const replyBox = panel.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await expect(replyBox).toBeFocused();
  await replyBox.fill("Keep this reply draft");
  await hoverMessage(row);
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(replyBox).toBeFocused();
  await expect(replyBox).toHaveText("Keep this reply draft");
  await hoverMessage(root);
  await root.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(
    panel.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeFocused();
  await page
    .locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"]), button[aria-label="Close thread"]',
    )
    .click();
  await expect(
    row.getByRole("button", { name: "Reply", exact: true }),
  ).toBeFocused();

  // A broadcast reply must open its owning thread for composition, not reveal
  // the selected reply and steal focus back from the editor.
  const broadcast = app.histories
    .get("primary/alpha")
    .find((item) => item.content === "Broadcast reply");
  if (!broadcast) throw new Error("Expected broadcast reply fixture");
  const broadcastRow = page.locator(
    `[data-channel-timeline] [data-message-id="${broadcast.id}"]`,
  );
  // Closing retains the split until its transition finishes. Establish the
  // final row geometry before placing the pointer over the next message.
  await expect(page.locator("[data-panel-dock][data-closing]")).toHaveCount(0);
  await hoverMessage(broadcastRow);
  await broadcastRow
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  await expect(replyBox).toBeFocused();
  await page
    .locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"]), button[aria-label="Close thread"]',
    )
    .click();
  await broadcastRow.getByRole("button", { name: /^View thread:/ }).click();
  await expect(
    panel.locator(`[data-message-id="${broadcast.id}"]`),
  ).toBeFocused();
  await page
    .locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"]), button[aria-label="Close thread"]',
    )
    .click();
  for (const width of [900, 603, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await row.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await page.mouse.click(0, 0);
    await expect(actions).toHaveCSS("opacity", "0");
    await hoverMessage(row);
    await expect(actions).toHaveCSS("opacity", "1");
    await expect(
      row.getByRole("button", { name: "Copy link", exact: true }),
    ).toBeVisible();
    await trigger.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    const bounds = await menu.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
    // Escape starts the exit; its deferred focus return must finish before the
    // next resize/pointer transition, or that old return can reopen the bar.
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
  await page.screenshot({
    path: test.info().outputPath("message-actions-narrow.png"),
  });
});

// Browser-only: clipboard -> rendered Markdown -> cross-conversation navigation
// must finish with the actual virtual row visible and focused.
test("copied Buzz links and the desktop alias reveal their destination from a conversation", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.copiedMessageLink = text;
        },
      },
    });
  });
  await open(page, app);
  const event = app.append("primary", "alpha", "Shared destination");
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  await hoverMessage(row);
  await row.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "App notifications" })
      .getByText("Link copied", { exact: true }),
  ).toBeVisible();
  const copiedLink = await page.evaluate(() => window.copiedMessageLink);
  expect(copiedLink).toBe(`buzz://message?channel=alpha&id=${event.id}`);
  const sharedConversation = page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "Alice Fixture", exact: true });
  await sharedConversation.click();
  const sharedChannel = await page
    .locator("[data-channel-timeline]")
    .getAttribute("data-channel-timeline");
  app.append(
    "primary",
    sharedChannel,
    `${copiedLink}\n\n[Desktop alias](buzz://channel/alpha/${event.id})`,
  );
  for (const href of [copiedLink, `buzz://channel/alpha/${event.id}`]) {
    await sharedConversation.click();
    await page.locator(`[data-channel-timeline] a[href="${href}"]`).click();
    await expect(row).toBeVisible();
    await expect(row).toBeFocused();
  }
});

test("DM actions open the correct reply thread", async ({ page, app }) => {
  await open(page, app);
  await page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "Alice Fixture", exact: true })
    .click();
  const timeline = page.locator("[data-channel-timeline]");
  const channel = await timeline.getAttribute("data-channel-timeline");
  const event = app.append("primary", channel, "DM menu check");
  const row = timeline.locator(`[data-message-id="${event.id}"]`);
  await hoverMessage(row);
  await row.getByRole("button", { name: "Add reaction", exact: true }).click();
  await page.locator('em-emoji-picker input[type="search"]').fill("thumbsup");
  await page
    .locator("em-emoji-picker")
    .getByRole("button", { name: "👍", exact: true })
    .click();
  await expect(
    row.getByRole("button", {
      name: "👍: You",
      exact: true,
    }),
  ).toBeVisible();
  await row.getByRole("button", { name: "👍: You", exact: true }).click();
  await expect(
    row.getByRole("button", { name: "👍: You", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(
      () =>
        app.report.publications.filter(({ event }) => event.kind === 5).length,
    )
    .toBe(1);
  const added = app.report.publications.find(
    ({ event }) => event.kind === 7,
  ).event;
  const removed = app.report.publications.find(
    ({ event }) => event.kind === 5,
  ).event;
  expect(added.tags).toContainEqual(["e", event.id]);
  expect(removed.tags).toContainEqual(["e", added.id]);
  expect(removed.pubkey).toBe(added.pubkey);
  await hoverMessage(row);
  await row.getByRole("button", { name: "More message actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Copy message", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(
    page
      .getByRole("complementary", { name: "Thread", exact: true })
      .locator(`[data-message-id="${event.id}"]`),
  ).toBeVisible();
  const replyBox = page.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await expect(replyBox).toBeFocused();
  await hoverMessage(row);
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(replyBox).toBeFocused();
});

test.describe("touch", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 850 } });
  test("opens the message menu without hover", async ({ page, app }) => {
    // This checks touch access, not live-append scrolling. Include the message
    // in initial history so open() settles its layout before the single tap.
    const event = app.append("primary", "alpha", "Touch menu check", false);
    await open(page, app);
    const row = page.locator(
      `[data-channel-timeline] [data-message-id="${event.id}"]`,
    );
    const actions = row.getByRole("group", { name: "Message actions" });
    await expect(actions).toHaveCSS("opacity", "1");
    await row.getByRole("button", { name: "More message actions" }).tap();
    await expect(
      page.getByRole("menuitem", { name: "Copy message", exact: true }),
    ).toBeVisible();
  });
});

// Native geometry and hit testing protect prose/link access while controls reveal.
test("narrow timeline continuation actions never cover prose or move adjacent rows", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 950 });
  await open(page, app);
  app.append("primary", "alpha", "Start a compact group");
  const event = app.append(
    "primary",
    "alpha",
    "Read [this reference](https://example.com/reference)",
  );
  const next = app.append("primary", "alpha", "Next message");
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  const following = page.locator(
    `[data-channel-timeline] [data-message-id="${next.id}"]`,
  );
  await expect(row.locator("[data-stack-previous]")).toBeVisible();
  await expect(following).toBeVisible();
  const actions = row.getByRole("group", { name: "Message actions" });
  const link = row.getByRole("link", { name: /this reference/ });
  await page.mouse.move(0, 0);
  await expect(actions).toHaveCSS("opacity", "0");
  await settle(page);
  const expectClockHidden = async () => {
    await expect(row.locator("time")).toHaveClass(/sr-only/);
    await expect(row.locator("time")).toHaveCSS("position", "absolute");
  };
  const baseline = await following.boundingBox();
  for (const mode of ["hover", "focus"]) {
    if (mode === "hover")
      await row.locator("[data-message-action-anchor]").hover();
    else {
      await page.mouse.move(0, 0);
      await page.keyboard.press("ArrowRight");
      await row.getByRole("button", { name: "More message actions" }).focus();
    }
    await expect
      .poll(() =>
        actions.evaluate((bar) => {
          const bubble = bar
            .closest("[data-layout]")
            .querySelector("[data-message-action-anchor]")
            .getBoundingClientRect();
          return bar.getBoundingClientRect().top < bubble.top;
        }),
      )
      .toBe(true);
    await expect(actions).toHaveCSS("opacity", "1");
    const prose = await row.locator("p").first().boundingBox();
    const toolbar = await actions.boundingBox();
    expect(
      toolbar.y + toolbar.height <= prose.y ||
        toolbar.x + toolbar.width <= prose.x ||
        toolbar.y >= prose.y + prose.height ||
        toolbar.x >= prose.x + prose.width,
    ).toBe(true);
    await expect(actions).toHaveCSS("position", "fixed");
    expect((await following.boundingBox()).y).toBe(baseline.y);
    await expectClockHidden();
    await expect
      .poll(() =>
        link.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return node.contains(
            document.elementFromPoint(rect.x + rect.width / 2, rect.y + 1),
          );
        }),
      )
      .toBe(true);
  }
  // Start on ordinary prose, not the link's native drag target.
  await hoverMessage(row);
  const prose = await row
    .locator("p")
    .first()
    .evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node.firstChild);
      const { x, y, width, height } = range.getBoundingClientRect();
      return { x, y, width, height };
    });
  const text = await link.boundingBox();
  await page.mouse.move(prose.x + 1, prose.y + 1);
  await expect(actions).toHaveCSS("opacity", "1");
  await page.mouse.down();
  await page.mouse.move(text.x + text.width - 1, text.y + text.height / 2, {
    steps: 10,
  });
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => getSelection()?.toString()))
    .toContain("reference");
  await page.evaluate(() => getSelection()?.removeAllRanges());
  // The first line must receive a real pointer press, not just have a clear
  // center. Prevent navigation while observing the link's native click.
  await link.evaluate((node) => {
    node.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        node.dataset.clicked = "true";
      },
      { once: true },
    );
  });
  await link.click({ position: { x: 10, y: 1 } });
  await expect(link).toHaveAttribute("data-clicked", "true");
  // Chromium retains focus on the clicked link. Return to the composer.
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .focus();
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 900, height: 950 });
  await settle(page);
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "2"),
  );
  // Let the virtual list reconcile resized rows before binding a scroll action
  // to a node that text scaling can replace. This observes layout, not a delay.
  await settle(page);
  await row.scrollIntoViewIfNeeded();
  await settle(page);
  await expectClockHidden();
});

test("historical single-day DMs and their threads expose dates without hover", async ({
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
  const event = app.append("primary", channel, "Historical message");
  const row = timeline.locator(`[data-message-id="${event.id}"]`);
  await expect(row).toBeVisible();
  const day = await page.evaluate((seconds) => {
    const date = new Date(seconds * 1000);
    return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
      .map((part) => String(part).padStart(2, "0"))
      .join("-");
  }, event.created_at);
  await page.mouse.move(0, 0);
  await expect(timeline.locator(`[data-day="${day}"]`)).toBeVisible();
  await expect(
    timeline.getByRole("button", { name: "Load older messages" }),
  ).toHaveCount(0);
  const reply = row.getByRole("button", { name: "Reply", exact: true });
  // Start real keyboard navigation so the untouched row prepares its controls.
  await page.keyboard.press("Tab");
  await reply.focus();
  await reply.press("Enter");
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  // The original's byline names its day; the thread has no leading day divider.
  const original = thread.locator(`[data-message-id="${event.id}"]`);
  const timestamp = original.locator('time > span[aria-hidden="true"]');
  await expect(timestamp).toHaveText(/ at /);
  await expect(timestamp).toBeVisible();
  await expect(original.locator("[data-day]")).toHaveCount(0);
});

// Browser-only: live timeline/thread grouping must preserve real native focus
// and Tab's next destination while the focused avatar retires on blur.
test("live grouped appends preserve avatar focus in channel and thread", async ({
  page,
  app,
}) => {
  await open(page, app);
  const root = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 0");
  for (const mode of ["channel", "thread"]) {
    let container = page.locator("[data-channel-timeline]");
    let composer = page.getByRole("textbox", {
      name: "Message #Alpha",
      exact: true,
    });
    if (mode === "thread") {
      await page
        .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ })
        .click();
      const panel = page.getByRole("complementary", {
        name: "Thread",
        exact: true,
      });
      container = panel;
      composer = panel.getByRole("textbox", {
        name: "Reply to thread",
        exact: true,
      });
    }
    const append = (text) =>
      app.append(
        "primary",
        "alpha",
        text,
        true,
        true,
        mode === "thread" ? root.id : undefined,
      );
    const first = append(`Focused ${mode} message`);
    const row = container.locator(`[data-message-id="${first.id}"]`);
    const avatar = row
      .getByRole("button", { name: /^View .* profile$/ })
      .first();
    await expect(avatar).toBeVisible();
    await settle(page);
    await page.keyboard.press("Tab");
    await avatar.focus();
    const preview = page.getByRole("dialog", { name: /profile preview$/ });
    await expect(preview).toBeVisible();
    const second = append(`Next ${mode} message`);
    await expect(row.locator("[data-stack-next]")).toBeVisible();
    await expect(avatar).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      preview.getByRole("button", { name: "View profile", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(preview).toBeHidden();
    await page.keyboard.press("Tab");
    await expect(
      row.getByRole("button", { name: "Add reaction", exact: true }),
    ).toBeFocused();
    await expect(avatar).toHaveCount(0);
    await composer.focus();
    append(`Another ${mode} message`);
    await expect(
      container.locator(`[data-message-id="${second.id}"] [data-stack-next]`),
    ).toBeVisible();
    await expect(composer).toBeFocused();
  }
});
