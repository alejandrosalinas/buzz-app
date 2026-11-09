import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { generateSecretKey } from "nostr-tools";
import { formatPublicKey } from "../../src/shared/identity/public-key.ts";

// Browser-only: actual Markdown link hit-testing, panel placement, two independent
// virtualized conversations and composer focus cannot be verified in jsdom.
test.use({
  pluginFixtures: true,
  productionBroker: true,
  dmLabels: true,
  agentPeers: true,
  soloChannels: ["beta"],
  channelWriteKinds: [9, 9000, 9007],
  historyCounts: { alpha: 2, beta: 2 },
});

test("a Solo chat link card opens the same authorized conversation in the channel side pane", async ({
  page,
  app,
}) => {
  const title = "Make contrast meet accessibility standards ".repeat(2).trim();
  await page.route("**/query", async (route) => {
    const response = await route.fetch();
    const events = await response.json();
    await route.fulfill({
      response,
      json: events.map((event) => {
        if (
          event.kind !== 39000 ||
          !event.tags.some(([key, value]) => key === "d" && value === "beta")
        )
          return event;
        return app.signRelay({
          kind: event.kind,
          created_at: event.created_at,
          content: event.content,
          tags: [
            ...event.tags.map((tag) =>
              tag[0] === "name" ? ["name", title] : tag,
            ),
            ["t", "buzz.solo"],
            ["t", "buzz.session.named"],
          ],
        });
      }),
    });
  });
  await open(page, app);
  const destination = page.getByRole("article", {
    name: "Conversation",
    exact: true,
  });
  app.append("primary", "alpha", "A preceding message from the same person.");
  const link = app.append(
    "primary",
    "alpha",
    "[Session · beta](buzz://channel/beta)\n\nPlease review this chat.",
  );
  const row = destination.locator(`[data-message-id="${link.id}"]`);
  const chip = row.getByRole("link", {
    name: `Open Chat: ${title}`,
    exact: true,
  });
  await expect(chip).toBeVisible();
  await expect(row.locator('[data-stack-previous="true"]')).toHaveCount(1);
  const captionGap = () =>
    row.evaluate((element) => {
      const cards = element.querySelector("[data-solo-cards]");
      const caption = element.querySelector('[class*="messageBubble"]');
      return (
        caption.getBoundingClientRect().top -
        cards.getBoundingClientRect().bottom
      );
    });
  await expect.poll(captionGap).toBe(2);
  await expect(chip.locator("svg.tabler-icon-message-circle")).toBeVisible();
  await chip.click();
  const panel = page.locator("[data-panel-workspace]");
  await expect(panel.getByRole("tab", { name: title })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const conversation = panel.getByRole("region", {
    name: `Conversation in ${title}`,
  });
  await expect(
    conversation.getByRole("region", { name: "Channel message history" }),
  ).toBeVisible();
  // Alice Fixture is in Beta too, so it is a conversation.
  await expect(
    conversation.getByRole("textbox", { name: "Message this conversation" }),
  ).toBeVisible();
  await expect(
    destination.getByRole("textbox", { name: "Message #Alpha" }),
  ).toBeVisible();
  await expect(row).toBeVisible();
  const geometry = await conversation.evaluate((element) => {
    const column = element
      .querySelector("[data-solo-column]")
      .getBoundingClientRect();
    const pane = element.getBoundingClientRect();
    const composer = element
      .querySelector('[aria-label="Message this conversation"]')
      .closest("form")
      .getBoundingClientRect();
    return {
      ratio: column.width / pane.width,
      inset: column.left - pane.left,
      composerRatio: composer.width / pane.width,
    };
  });
  expect(geometry.ratio).toBeGreaterThan(0.97);
  expect(geometry.inset).toBeLessThan(2);
  expect(geometry.composerRatio).toBeGreaterThan(0.83);
  await panel.getByRole("button", { name: `Close ${title} tab` }).click();
  await page.setViewportSize({ width: 390, height: 850 });
  await expect(chip).toBeVisible();
  const linkBounds = await chip.evaluate((el) => ({
    right: el.getBoundingClientRect().right,
    viewport: innerWidth,
  }));
  expect(linkBounds.right).toBeLessThanOrEqual(linkBounds.viewport);
  await expect(
    destination.getByRole("textbox", { name: "Message #Alpha" }),
  ).toBeVisible();
});

// Real modal/footer reachability, portal hit-testing and focus in both engines.
async function reachable(locator, { scroll = true } = {}) {
  if (scroll) {
    // Match keyboard highlighting's reveal below sticky group headings.
    await locator.evaluate((element) =>
      element.scrollIntoView({ block: "nearest", inline: "nearest" }),
    );
    // WebKit can still reveal the focused field after a viewport/text reflow.
    // Check normal pointer actionability before sampling the final geometry.
    await locator.click({ trial: true });
  }
  await expect(locator).toBeInViewport();
  await expect
    .poll(() =>
      locator.evaluate((element) => {
        const r = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
        );
      }),
    )
    .toBe(true);
}

// Signed metadata edits require an actual channel UUID and owner authority.
test.describe("View only channel share", () => {
  const sharedChatId = "44444444-4444-4444-8444-444444444444";
  test.use({
    channelIds: ["alpha", sharedChatId],
    channelNames: { [sharedChatId]: "Beta" },
    soloChannels: [sharedChatId],
    ownSoloChannels: [sharedChatId],
    historyCounts: { alpha: 2, [sharedChatId]: 2 },
    channelWriteKinds: [9, 9000, 9002, 9007],
  });
  test("shares View only links with accessible disclosure", async ({
    page,
    app,
  }, info) => {
    // Pre-existing grants have no device-local provenance. Keep the large fallback
    // collapsed, and prove real scrolling cannot push the fixed footer away.
    const legacyPeople = Array.from({ length: 14 }, (_, index) =>
      app.serveProfile(generateSecretKey(), {
        name: `Existing person ${index + 1}`,
      }),
    );
    app.serveMembers(
      sharedChatId,
      legacyPeople.map((person) => person.pubkey),
    );
    await page.goto(app.origin);
    await openChat(page, app, sharedChatId);
    const trigger = page.getByRole("button", {
      name: /^Share access to /,
      exact: true,
    });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Share access" });
    const search = dialog.getByRole("searchbox", {
      name: "Search people and channels",
    });
    await expect(search).toBeFocused();
    // Access is grouped by role, like a channel: Bob and Carol are agents.
    const agents = dialog.getByRole("region", { name: "Agents", exact: true });
    await expect(
      agents.getByText("Bob Fixture", { exact: true }),
    ).toBeVisible();
    await expect(
      agents.getByText("Carol Fixture", { exact: true }),
    ).toBeVisible();
    // People holds the owner, the 14 legacy humans and Alice.
    const people = dialog.getByRole("region", { name: "People", exact: true });
    await expect(people.getByRole("heading")).toHaveText("People · 16");
    await expect(
      people.getByText("Existing person 14", { exact: true }),
    ).toBeAttached();
    await expect(
      dialog.getByText(/^The original sharing destination/),
    ).toHaveCount(0);
    // The narrowest viewport is where a scrolling body can push the footer away.
    await page.setViewportSize({ width: 390, height: 620 });
    await reachable(dialog.getByRole("button", { name: "Done", exact: true }), {
      scroll: false,
    });
    await dialog
      .getByText("Existing person 14", { exact: true })
      .scrollIntoViewIfNeeded();
    await reachable(dialog.getByRole("button", { name: "Done", exact: true }), {
      scroll: false,
    });
    await page.setViewportSize({ width: 1280, height: 850 });
    const done = dialog.getByRole("button", { name: "Done", exact: true });
    for (const [width, scale] of [
      [1280, 1],
      [390, 2],
    ]) {
      await page.setViewportSize({ width, height: 850 });
      await page.evaluate(
        (scale) =>
          document.documentElement.style.setProperty(
            "--buzz-text-scale",
            String(scale),
          ),
        scale,
      );
      const footer = dialog.locator(".buzz-dialog-actions");
      const copy = dialog.getByRole("button", {
        name: /^(Copy link|Link copied)$/,
      });
      // Each button gets its own flex item. Horizontal overflow is allowed
      // only for a single oversized action, not the combined Copy/Done row.
      await expect
        .poll(() =>
          footer.evaluate((el) => {
            const widest = Math.max(
              ...[...el.querySelectorAll("button")].map(
                (button) => button.getBoundingClientRect().width,
              ),
            );
            // Include the shared focus-ring inset around an oversized action.
            const style = getComputedStyle(el);
            const inset =
              parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
            return el.scrollWidth - Math.max(el.clientWidth, widest + inset);
          }),
        )
        .toBeLessThanOrEqual(1);
      if (scale === 1) {
        await expect
          .poll(() => footer.evaluate((el) => el.scrollWidth - el.clientWidth))
          .toBeLessThanOrEqual(1);
        await reachable(done, { scroll: false });
        await reachable(copy, { scroll: false });
      } else {
        await expect
          .poll(async () => {
            const shared = await done.boundingBox();
            const copied = await copy.boundingBox();
            return shared.y >= copied.y + copied.height;
          })
          .toBe(true);
        // Real Tab still reaches both wrapped controls, without programmatic
        // scrolling or focus bypassing the actual tab order.
        for (const action of [done, copy]) {
          for (
            let step = 0;
            !(await action.evaluate((el) => el === document.activeElement));
            step++
          ) {
            // Every roster row has profile and actions stops before the footer.
            expect(step).toBeLessThan(64);
            await page.keyboard.press("Tab");
            // Base UI returns focus from its guard on the next frame. Do not
            // send another Tab while that handoff is still pending.
            await expect
              .poll(() =>
                page.evaluate(() =>
                  document.activeElement?.hasAttribute(
                    "data-base-ui-focus-guard",
                  ),
                ),
              )
              .toBe(false);
          }
          await expect(action).toBeFocused();
          await expect(action).toBeInViewport({ ratio: 1 });
        }
        await reachable(copy, { scroll: false });
        await page.keyboard.press("Enter");
        await expect
          .poll(
            async () =>
              (await copy.innerText()) === "Link copied" ||
              (await dialog
                .getByRole("alert")
                .filter({ hasText: "Couldn’t copy the link." })
                .count()) > 0,
          )
          .toBe(true);
        await expect(copy).toBeFocused();
      }
    }
    // A channel's search-result action opens the confirmation directly.
    await search.fill("Alpha");
    const share = dialog.getByRole("button", {
      name: "Share #Alpha",
      exact: true,
    });
    await reachable(share);
    await share.press("Enter");
    const confirmation = page.getByRole("alertdialog", {
      name: "Share this chat?",
    });
    await expect(confirmation).toContainText(
      "full history, Canvas, workspace folders, and agent instructions",
    );
    await confirmation
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(share).toBeFocused();
    await expect(search).toHaveValue("Alpha");
    await expect(
      dialog.getByRole("region", { name: "Selected channel" }),
    ).toHaveCount(0);
    expect(app.report.detailsPublications ?? []).toHaveLength(0);
    expect(
      app.report.publications.filter(({ event }) => event.kind === 9),
    ).toHaveLength(0);
    // Close retires this dialog visit before testing persisted appearance reloads.
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    // Keep actual appearance settings, nested modal focus, and action reachability
    // in this browser journey; service and role matrices live in Vitest.
    for (const [mode, width, scale] of [
      ["dark", 1280, 1],
      ["light", 1280, 1],
      ["dark", 390, 1.5],
      ["light", 390, 1.5],
    ]) {
      await page.setViewportSize({ width, height: width === 390 ? 720 : 850 });
      await page.evaluate(
        ({ mode, scale }) => {
          localStorage.setItem("buzz-appearance.v1", mode);
          localStorage.setItem("buzz-font-scale.v1", String(scale));
        },
        { mode, scale },
      );
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute(
        "data-color-mode",
        mode,
      );
      await expect(page.locator("html")).toHaveCSS(
        "--buzz-text-scale",
        String(scale),
      );
      // The cached header has only Share. Live Chat actions shifts Share left;
      // wait for that header before pointer hit-testing can straddle the change.
      await expect(
        page.getByRole("button", { name: "Chat actions", exact: true }),
      ).toBeVisible();
      await trigger.click();
      await expect(search).toBeFocused();
      await search.fill("Alpha");
      await reachable(share);
      await expect(
        dialog.getByRole("status").filter({ hasText: "Searching…" }),
      ).toHaveCount(0);
      if (info.project.name === "chromium")
        await dialog.screenshot({
          path: info.outputPath(`SOLO_SHARE_RESULTS_${mode}_${width}.png`),
        });
      await share.click();
      const cancel = confirmation.getByRole("button", {
        name: "Cancel",
        exact: true,
      });
      await expect(cancel).toBeFocused();
      const confirmShare = confirmation.getByRole("button", {
        name: "Share",
        exact: true,
      });
      await reachable(confirmShare);
      await expect(confirmShare).toBeInViewport({ ratio: 1 });
      if (info.project.name === "chromium")
        await confirmation.screenshot({
          path: info.outputPath(`SOLO_SHARE_CONFIRM_${mode}_${width}.png`),
        });
      await page.keyboard.press("Escape");
      await expect(confirmation).not.toBeVisible();
      await expect(share).toBeFocused();
      if (mode !== "light" || width !== 390) {
        await dialog
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await expect(dialog).not.toBeVisible();
      }
    }
    await share.press("Enter");
    await confirmation
      .getByRole("button", { name: "Share", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    const changedToast = page.getByRole("dialog", {
      name: "Chat changed to View only. Shared in #Alpha",
      exact: true,
    });
    await expect(changedToast).toBeVisible();
    await expect(
      changedToast.getByRole("button", { name: "View", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => window.fixtureNavigation.snapshot().entry.target.channelId,
      ),
    ).toBe(sharedChatId);
    await changedToast.hover();
    if (info.project.name === "chromium")
      await changedToast.screenshot({
        path: info.outputPath("SHARE_ACCESS_CHANGED_TOAST_390.png"),
      });
    expect(app.report.detailsPublications).toHaveLength(1);
    expect(app.report.detailsPublications[0].tags).toContainEqual([
      "visibility",
      "open",
    ]);
    expect(app.report.detailsPublications[0].tags).toContainEqual([
      "join_role",
      "guest",
    ]);
    expect(
      app.report.publications.filter(({ event }) => event.kind === 9000),
    ).toHaveLength(0);
    await page.setViewportSize({ width: 1280, height: 850 });
    await page.evaluate(() =>
      document.documentElement.style.setProperty("--buzz-text-scale", "1"),
    );
    await expect
      .poll(
        () =>
          app.report.publications.filter(({ event }) => event.kind === 9)
            .length,
      )
      .toBe(1);
    const links = app.report.publications.filter(
      ({ event }) => event.kind === 9,
    );
    expect(links[0].event.content).toBe(
      `[Chat: Beta](buzz://channel/${sharedChatId})`,
    );
    expect(links[0].event.tags).toContainEqual(["h", "alpha"]);
    expect(links[0].event.tags.filter(([key]) => key === "p")).toHaveLength(0);
    expect(
      links[0].event.tags.some(([key]) => key === "t" || key === "s"),
    ).toBe(false);
    await changedToast
      .getByRole("button", { name: "View", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation.snapshot().entry.target),
      )
      .toMatchObject({ channelId: "alpha", messageId: links[0].event.id });
    await openChat(page, app, sharedChatId);
    // Sharing again confirms delivery while retaining the existing View only policy.
    await trigger.click();
    await search.fill("Alpha");
    await share.click();
    await expect(confirmation).toContainText(
      "This chat is already View only. Its link will be posted in #Alpha.",
    );
    expect(app.report.detailsPublications).toHaveLength(1);
    expect(
      app.report.publications.filter(({ event }) => event.kind === 9),
    ).toHaveLength(1);
    if (info.project.name === "chromium")
      await confirmation.screenshot({
        path: info.outputPath("VIEW_ONLY_SHARE_CONFIRM_1280.png"),
      });
    await confirmation
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(share).toBeFocused();
    await expect(search).toHaveValue("Alpha");
    expect(
      app.report.publications.filter(({ event }) => event.kind === 9),
    ).toHaveLength(1);
    await share.click();
    await confirmation
      .getByRole("button", { name: "Share", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "Shared in #Alpha", exact: true }),
    ).toBeVisible();
    await expect
      .poll(
        () =>
          app.report.publications.filter(({ event }) => event.kind === 9)
            .length,
      )
      .toBe(2);
    expect(app.report.detailsPublications).toHaveLength(1);
    expect(
      app.report.publications.filter(({ event }) => event.kind === 9000),
    ).toHaveLength(0);
  });

  // Browser-only: clipboard -> Solo card -> real composer consent/focus -> one
  // original message through the broker. Policy/failure matrices stay in Vitest.
  test("pasted owned chats confirm Private and View only while preserving Public access", async ({
    page,
    app,
  }, info) => {
    await open(page, app);
    const input = page.getByRole("textbox", {
      name: "Message #Alpha",
      exact: true,
    });
    const pasteLink = async () => {
      // A visible cold composer can still be disabled until signed membership loads.
      await expect(input).toBeEditable();
      await expect(input).toBeEnabled();
      await input.focus();
      await input.evaluate((element, link) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", `${link}\n\nPlease look at this`);
        element.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData,
          }),
        );
      }, `buzz://channel/${sharedChatId}`);
      await expect(input).toContainText("Please look at this");
    };
    await pasteLink();
    const send = page.getByRole("button", {
      name: "Send message",
      exact: true,
    });
    const confirmation = page.getByRole("alertdialog", {
      name: "Share this chat?",
    });
    const primary = confirmation.getByRole("button", {
      name: "Share",
      exact: true,
    });
    for (const [mode, width, scale] of [
      ["dark", 1280, 1],
      ["light", 390, 1.5],
    ]) {
      await page.setViewportSize({ width, height: width === 390 ? 720 : 850 });
      await page.evaluate(
        ({ mode, scale }) => {
          localStorage.setItem("buzz-appearance.v1", mode);
          localStorage.setItem("buzz-font-scale.v1", String(scale));
        },
        { mode, scale },
      );
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute(
        "data-color-mode",
        mode,
      );
      await expect(input).toBeVisible();
      await send.click();
      await expect(confirmation).toContainText(
        "full history, Canvas, workspace folders, and agent instructions",
      );
      await expect(primary).toBeFocused();
      await reachable(primary);
      await expect(primary).toBeInViewport({ ratio: 1 });
      if (info.project.name === "chromium")
        await confirmation.screenshot({
          path: info.outputPath(`SOLO_PASTE_CONFIRM_${mode}_${width}.png`),
        });
      await page.keyboard.press("Escape");
      await expect(confirmation).not.toBeVisible();
      await expect(input).toBeFocused();
      await expect(input).toContainText("Please look at this");
      expect(app.report.detailsPublications ?? []).toHaveLength(0);
    }
    await send.click();
    await primary.click();
    await expect(confirmation).not.toBeVisible();
    await expect
      .poll(
        () =>
          app.report.publications.filter(({ event }) => event.kind === 9)
            .length,
      )
      .toBe(1);
    expect(app.report.detailsPublications).toHaveLength(1);
    expect(app.report.detailsPublications[0].tags).toContainEqual([
      "visibility",
      "open",
    ]);
    expect(app.report.detailsPublications[0].tags).toContainEqual([
      "join_role",
      "guest",
    ]);
    const message = app.report.publications.find(
      ({ event }) => event.kind === 9,
    ).event;
    expect(message.content).toContain(`buzz://channel/${sharedChatId}`);
    expect(message.content).toContain("Please look at this");
    expect(
      app.report.publications.filter(({ event }) => event.kind === 9000),
    ).toHaveLength(0);

    await pasteLink();
    await send.click();
    const viewOnlyConfirmation = page.getByRole("alertdialog", {
      name: "Share this chat?",
    });
    await expect(viewOnlyConfirmation).toContainText(
      "This chat is already View only.",
    );
    expect(app.report.detailsPublications).toHaveLength(1);
    expect(
      app.report.publications.filter(({ event }) => event.kind === 9),
    ).toHaveLength(1);
    if (info.project.name === "chromium")
      await viewOnlyConfirmation.screenshot({
        path: info.outputPath("VIEW_ONLY_PASTE_CONFIRM_390.png"),
      });
    await viewOnlyConfirmation
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(input).toBeFocused();
    await expect(input).toContainText("Please look at this");
    await send.click();
    await viewOnlyConfirmation
      .getByRole("button", { name: "Share", exact: true })
      .click();
    await expect(viewOnlyConfirmation).not.toBeVisible();
    await expect
      .poll(
        () =>
          app.report.publications.filter(({ event }) => event.kind === 9)
            .length,
      )
      .toBe(2);
    expect(app.report.detailsPublications).toHaveLength(1);

    // Renewed consent must remount the real alert, return focus to Cancel and
    // keep the original composer message unsent until a second explicit Share.
    await pasteLink();
    await send.click();
    await expect(viewOnlyConfirmation).toBeVisible();
    app.setChannelMetadata(sharedChatId, [
      ["t", "stream"],
      ["t", "buzz.solo"],
      ["P", app.viewer],
      ["name", "Beta"],
      ["private"],
      ["join_role", "guest"],
    ]);
    await viewOnlyConfirmation
      .getByRole("button", { name: "Share", exact: true })
      .click();
    await expect(confirmation).toContainText("from Private to View only");
    await expect(primary).toBeFocused();
    expect(app.report.detailsPublications).toHaveLength(1);
    expect(
      app.report.publications.filter(({ event }) => event.kind === 9),
    ).toHaveLength(2);
    if (info.project.name === "chromium")
      await confirmation.screenshot({
        path: info.outputPath("RENEWED_PASTE_CONSENT_390.png"),
      });
    await primary.click();
    await expect(confirmation).not.toBeVisible();
    await expect
      .poll(
        () =>
          app.report.publications.filter(({ event }) => event.kind === 9)
            .length,
      )
      .toBe(3);
    expect(app.report.detailsPublications).toHaveLength(2);

    app.setChannelMetadata(sharedChatId, [
      ["t", "stream"],
      ["t", "buzz.solo"],
      ["P", app.viewer],
      ["name", "Beta"],
      ["public"],
      ["join_role", "member"],
    ]);
    await page.reload();
    await expect(input).toBeVisible();
    await pasteLink();
    await send.click();
    await expect
      .poll(
        () =>
          app.report.publications.filter(({ event }) => event.kind === 9)
            .length,
      )
      .toBe(4);
    await expect(confirmation).not.toBeVisible();
    expect(app.report.detailsPublications).toHaveLength(2);
    expect(
      app.report.publications.filter(({ event }) => event.kind === 9000),
    ).toHaveLength(0);
  });
});

test("People search holds loading, lists inline results and restores keyboard focus", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 620 });
  await page.goto(app.origin);
  await openChat(page, app, "beta");
  const trigger = page.getByRole("button", {
    name: /^Share access to /,
    exact: true,
  });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Share access" });
  const search = dialog.getByRole("searchbox", {
    name: "Search people and channels",
  });
  let signal;
  const requested = new Promise((resolve) => {
    signal = resolve;
  });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const humans = Array.from({ length: 12 }, (_, index) =>
    app.serveProfile(generateSecretKey(), {
      name: `Morgan person ${index + 1}`,
    }),
  );
  const bot = app.serveProfile(generateSecretKey(), {
    name: "Morgan agent",
    is_agent: true,
  });
  await page.route("**/api/relay/**/profile-search", async (route) => {
    if (route.request().postDataJSON().query === "Morgan") {
      signal();
      await held;
      return route.fulfill({ json: [...humans, bot] });
    }
    return route.continue();
  });
  try {
    await search.fill("Morgan");
    await requested;
    const results = dialog.getByRole("region", {
      name: "Not in this chat",
      exact: true,
    });
    await expect(
      results.getByText("Searching…", { exact: true }),
    ).toBeVisible();
    const adds = results.getByRole("button", { name: /^Add Morgan person/ });
    await expect(adds).toHaveCount(0);
    release();
    // Agents join a Solo chat by mention, so they are not offered here.
    await expect(adds).not.toHaveCount(0);
    await expect(results.getByText("Morgan agent")).toHaveCount(0);
    await expect(
      results.getByText("To add an agent, mention it in the chat.", {
        exact: true,
      }),
    ).toBeVisible();
    for (const [width, scale] of [
      [1280, 1],
      [390, 2],
    ]) {
      await page.setViewportSize({ width, height: 620 });
      await page.evaluate(
        (scale) =>
          document.documentElement.style.setProperty(
            "--buzz-text-scale",
            String(scale),
          ),
        scale,
      );
      await reachable(adds.first());
    }
    // At enlarged text, production keyboard reveals must keep Add reachable
    // while focus stays in the search field, including the return upward.
    for (const key of ["ArrowDown", "ArrowUp"]) {
      await search.press(key);
      await expect(search).toBeFocused();
      await reachable(
        results
          .locator("[data-highlighted]")
          .getByRole("button", { name: /^Add Morgan person/ }),
        { scroll: false },
      );
    }
    await page.evaluate(() =>
      document.documentElement.style.setProperty("--buzz-text-scale", "1"),
    );
    // Typing highlights the first result; arrows move it without leaving the field.
    const first = results.locator("[data-highlighted]");
    await expect(first).toHaveCount(1);
    await search.press("ArrowDown");
    await expect(search).toBeFocused();
    await expect(results.locator("[data-highlighted]")).toHaveCount(1);
    await expect(results).not.toContainText(formatPublicKey(humans[0].pubkey));
    await search.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
  } finally {
    release();
  }
});

test.describe("owned Solo invitation headings", () => {
  const soloId = "33333333-3333-4333-8333-333333333333";
  test.use({
    channelIds: [soloId],
    channelNames: { [soloId]: "Planning" },
    soloChannels: [soloId],
    ownSoloChannels: [soloId],
    agentPeers: false,
    channelWriteKinds: [9, 9000, 9007],
    historyCounts: { [soloId]: 1 },
  });

  // Browser-only: persisted text scaling, wrapped headings and native keyboard
  // scroll reveal must leave the real Add action exposed, without test scrolling.
  for (const mode of ["light", "dark"]) {
    test(`wrapped saved-agent headings preserve keyboard reachability in ${mode}`, async ({
      page,
      app,
    }, info) => {
      await page.setViewportSize({ width: 390, height: 620 });
      await page.addInitScript((mode) => {
        localStorage.setItem("buzz-font-scale.v1", "2");
        localStorage.setItem("buzz-appearance.v1", mode);
      }, mode);
      const saved = Array.from({ length: 5 }, (_, index) => {
        const name = `Saved helper ${index + 1}`;
        const event = app.serveProfile(generateSecretKey(), {
          name,
          is_agent: true,
        });
        return { pubkey: event.pubkey, name };
      });
      // Model the host's direct-agent capability and saved inventory; the
      // built frontend, production broker and invitation policy stay real.
      await page.route("**/api/relay/**/session", async (route) => {
        const response = await route.fetch();
        const session = await response.json();
        await route.fulfill({
          response,
          json: { ...session, writeKinds: [...session.writeKinds, 9007] },
        });
      });
      await page.route("**/api/relay/**/agent-library", (route) =>
        route.fulfill({ json: { definitions: [], identities: saved } }),
      );
      await page.goto(app.origin);
      await openChat(page, app, soloId);
      await expect(page.locator("html")).toHaveCSS("--buzz-text-scale", "2");
      await page
        .getByRole("button", { name: /^Share access to /, exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "Share access" });
      const search = dialog.getByRole("searchbox");
      await search.fill("Saved helper");
      const group = dialog.getByRole("region", {
        name: "Your other agents",
        exact: true,
      });
      await expect(
        group.getByRole("button", { name: /^Add Saved helper/ }),
      ).toHaveCount(4);
      const heading = group.getByRole("heading", {
        name: /^Your other agents/,
      });
      await expect(heading).toBeVisible();
      for (const [key, number] of [
        ["ArrowDown", 2],
        ["ArrowDown", 3],
        ["ArrowUp", 2],
      ]) {
        await search.press(key);
        await expect(search).toBeFocused();
        await expect(group.locator("[data-highlighted]")).toContainText(
          `Saved helper ${number}`,
        );
      }
      await dialog.screenshot({
        path: info.outputPath(`wrapped-invitations-${mode}.png`),
      });
      await reachable(
        group.getByRole("button", { name: /^Add Saved helper 2 / }),
        { scroll: false },
      );
      await page.setViewportSize({ width: 1280, height: 1600 });
      await expect(heading).toHaveCSS("position", "sticky");
    });
  }
});

async function openChat(page, app, channelId, messageId) {
  await expect
    .poll(() =>
      page.evaluate(() => window.fixtureNavigation?.snapshot().status),
    )
    .toBe("opened");
  expect(
    await page.evaluate((target) => window.fixtureNavigation.open(target), {
      version: 1,
      kind: "conversation",
      channelId,
      ...(messageId ? { messageId } : {}),
      scope: { viewer: app.viewer, communityOrigin: "https://primary.example" },
    }),
  ).toEqual({ status: "opened" });
}

test.describe("Messages Share navigation", () => {
  const firstChat = "55555555-5555-4555-8555-555555555555";
  const secondChat = "66666666-6666-4666-8666-666666666666";
  test.use({
    soloChannels: [firstChat, secondChat],
    ownSoloChannels: [firstChat, secondChat],
    channelIds: [firstChat, secondChat, "gamma"],
    channelNames: {
      [firstChat]: "Alpha",
      [secondChat]: "Beta",
      gamma: "Gamma",
    },
    historyCounts: { [firstChat]: 1, [secondChat]: 1, gamma: 0 },
  });

  // Browser-only: production ChannelsPage reconciliation and host/browser history
  // must tear down a portalled Share dialog before another source becomes active.
  test("Messages Share choices never cross source or history visits", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await openChat(page, app, firstChat);
    await page
      .getByRole("button", { name: /^Share access to /, exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Share access" });
    const search = dialog.getByRole("searchbox", {
      name: "Search people and channels",
    });
    await search.fill("Gamma");
    await dialog
      .getByRole("button", { name: "Share #Gamma", exact: true })
      .click();
    const confirmation = page.getByRole("alertdialog", {
      name: "Share this chat?",
    });
    await expect(confirmation).toBeVisible();
    await openChat(page, app, secondChat);
    await expect(dialog).toHaveCount(0);
    await expect(confirmation).toHaveCount(0);
    await page
      .getByRole("button", { name: /^Share access to /, exact: true })
      .click();
    await expect(
      dialog.getByRole("searchbox", { name: "Search people and channels" }),
    ).toHaveValue("");
    await expect(
      dialog.getByRole("button", { name: "Done", exact: true }),
    ).toBeEnabled();
    await page.goBack();
    await expect
      .poll(() =>
        page.evaluate(() => ({
          channel: window.fixtureNavigation.snapshot().entry.target.channelId,
          status: window.fixtureNavigation.snapshot().status,
        })),
      )
      .toEqual({ channel: firstChat, status: "opened" });
    await expect(dialog).toHaveCount(0);
    await expect(confirmation).toHaveCount(0);
    await page
      .getByRole("button", { name: /^Share access to /, exact: true })
      .click();
    await expect(
      dialog.getByRole("searchbox", { name: "Search people and channels" }),
    ).toHaveValue("");
    await expect(
      dialog.getByRole("button", { name: "Done", exact: true }),
    ).toBeEnabled();
    // Another message visit in the same source also discards unsent UI.
    await search.fill("Gamma");
    await dialog
      .getByRole("button", { name: "Share #Gamma", exact: true })
      .click();
    await expect(confirmation).toBeVisible();
    const next = app.append(
      "primary",
      firstChat,
      "A new visit in the same chat",
    );
    await openChat(page, app, firstChat, next.id);
    await expect(dialog).toHaveCount(0);
    await expect(confirmation).toHaveCount(0);
    await page
      .getByRole("button", { name: /^Share access to /, exact: true })
      .click();
    await expect(
      dialog.getByRole("searchbox", { name: "Search people and channels" }),
    ).toHaveValue("");
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await page
      .getByRole("button", { name: "Chat actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Chat settings", exact: true })
      .click();
    const settings = page.getByRole("dialog", {
      name: "Edit chat",
      exact: true,
    });
    await expect(settings).toBeVisible();
    const following = app.append(
      "primary",
      firstChat,
      "Another visit retires chat settings",
    );
    await openChat(page, app, firstChat, following.id);
    await expect(settings).toHaveCount(0);
  });
});
