import { pauseClock } from "./clock.mjs";
import { pluginAction } from "./plugin-settings.mjs";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";
import { test, expect } from "./fixture.mjs";
import {
  closeSettings,
  newChat,
  openPage,
  openSettings,
  selectSettingsSection,
  sendOnlyTo,
} from "./navigation.mjs";
import { npubEncode } from "nostr-tools/nip19";
const id = "33333333-3333-4333-8333-333333333333";
const other = "44444444-4444-4444-8444-444444444444";
test.use({
  productionBroker: true,
  channelIds: [id, other, "gamma"],
  channelNames: { [id]: "Alpha", [other]: "Beta", gamma: "Gamma" },
  soloChannels: [id, other],
  ownSoloChannels: [id, other],
  historyCounts: { [id]: 2, [other]: 1, gamma: 1 },
});
// Activity opens the agent's profile, where its type's Activity tab lives.
const agentProfile = (page) =>
  page.getByRole("region", { name: "Profile details", exact: true });
const closeProfile = (page) =>
  page.getByRole("button", { name: /^Close (?!Thread).* tab$/ });
// Render a genuine pre-existing human member through signed roster/profile
// reads; no client stores are seeded. Shared mounts after opening its access UI.
async function showSharedMark(page, app, row) {
  const person = app.serveProfile(generateSecretKey(), {
    name: "Shared teammate",
  });
  await page.route("**/api/relay/primary/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (!filters.some((filter) => filter.kinds?.includes(39002)))
      return route.continue();
    const response = await route.fetch();
    const events = await response.json();
    await route.fulfill({
      response,
      json: events.map((event) =>
        event.kind === 39002 &&
        event.tags.some(([key, value]) => key === "d" && value === id)
          ? app.signRelay({
              ...event,
              created_at: event.created_at + 1,
              tags: [...event.tags, ["p", person.pubkey, "", "member"]],
            })
          : event,
      ),
    });
  });
  await row.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Share access", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Share access",
    exact: true,
  });
  await expect(
    dialog
      .getByRole("region", { name: "People", exact: true })
      .getByText("Shared teammate", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const outer = page.locator(`[data-solo-menu-id="${id}"]`);
  const shared = outer.locator("[data-solo-shared]");
  await expect(row).toHaveAccessibleDescription("Shared");
  // Callers check visibility: a working row hides Shared on pointer devices.
  await expect(shared).toBeAttached();
  return shared;
}
// The row owns status/action geometry. Compare painted centers on desktop;
// on touch, status flows immediately before the actual actions (Shared or menu).
async function expectTrailingAlignment(row, status, touch = false) {
  await expect
    .poll(
      async () => {
        const action = await row.evaluate((button) => {
          const outer = button.closest("[data-solo-menu-id]");
          const menu = outer?.querySelector("[data-solo-row-action]");
          const shared = outer?.querySelector("[data-solo-shared]");
          if (!menu) throw new Error("Missing Solo row action");
          const rect = (node) => {
            const { x, y, width, height } = node.getBoundingClientRect();
            return { x, y, width, height };
          };
          const style = getComputedStyle(button);
          return {
            menu: rect(menu),
            // Shared keeps the trailing slot and the menu opens beside it.
            glyph: rect(
              (shared ?? menu).querySelector("svg") ?? shared ?? menu,
            ),
            next: rect(shared ?? menu),
            // Inline content keeps the same trailing padding and margin as its label.
            endSpace:
              parseFloat(style.paddingRight) + parseFloat(style.marginRight),
          };
        });
        const marker = await status.boundingBox();
        if (!marker) throw new Error("Missing Solo status geometry");
        // A correctly positioned marker can still be clipped by a narrower
        // select button. Check the full paint ancestry, not just its rectangle.
        const unclipped = await status.evaluate((element) => {
          const marker = element.getBoundingClientRect();
          for (
            let node = element.parentElement;
            node;
            node = node.parentElement
          ) {
            const style = getComputedStyle(node);
            const clip = node.getBoundingClientRect();
            const clips = (overflow) =>
              /^(hidden|clip|auto|scroll)$/.test(overflow);
            if (
              clips(style.overflowX) &&
              (marker.left < clip.left - 1 || marker.right > clip.right + 1)
            )
              return false;
            if (
              clips(style.overflowY) &&
              (marker.top < clip.top - 1 || marker.bottom > clip.bottom + 1)
            )
              return false;
          }
          return true;
        });
        if (!unclipped) return false;
        const target = touch ? action.next : action.menu;
        const dy = Math.abs(
          marker.y + marker.height / 2 - target.y - target.height / 2,
        );
        if (touch) {
          const gap = target.x - marker.x - marker.width;
          return dy < 1 && gap >= 0 && gap <= action.endSpace + 1;
        }
        // The wider status pill shares the trailing glyph's edge (Shared when
        // present, else the overflow menu), which sits on the row inset like
        // the leading icon.
        const dx = Math.abs(
          marker.x + marker.width - action.glyph.x - action.glyph.width,
        );
        return dx < 1 && dy < 1;
      },
      {
        message: touch
          ? "status stays next to the row actions"
          : "status shares the trailing glyph's edge",
      },
    )
    .toBe(true);
}
// Verifies shell routing, actual hover/focus and retained drafts across the real panel host.
test("Solo chat Activity opens the agent's profile locally, restores per conversation and retires on plugin disable", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await newChat(page);
  const sidebar = page.getByRole("navigation", { name: "Solo conversations" });
  await sidebar.locator(`[data-solo-channel-id="${id}"]`).click();
  const composer = page.getByRole("textbox", {
    name: "Message your agents",
    exact: true,
  });
  await composer.fill("Keep my Solo draft");
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  const key = generateSecretKey();
  app.observer(
    {
      kind: "turn_liveness",
      seq: 1,
      timestamp: new Date().toISOString(),
      channelId: id,
      sessionId: "S",
      turnId: "solo-activity",
    },
    key,
  );
  const trigger = page.getByRole("button", {
    name: /^Activity: .+ working$/,
  });
  await trigger.hover();
  const preview = page.getByRole("dialog", { name: "Working now" });
  await expect(preview).toBeVisible();
  await preview.getByRole("button", { name: /^View .+ activity$/ }).click();
  const panel = agentProfile(page);
  await expect(panel).toBeVisible();
  await expect(panel.locator("code").first()).toHaveText(
    npubEncode(getPublicKey(key)),
  );
  await expect(preview).toBeHidden();
  await expect(sidebar).toBeVisible();
  await expect(composer).toHaveText("Keep my Solo draft");
  await closeProfile(page).click();
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await preview.getByRole("button", { name: /^View .+ activity$/ }).click();
  await expect(panel).toBeVisible();
  await sidebar.getByRole("button", { name: "Beta", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await sidebar.locator(`[data-solo-channel-id="${id}"]`).click();
  await expect(panel).toBeVisible();
  await expect(composer).toHaveText("Keep my Solo draft");
  await closeProfile(page).click();
  // Restored panels have no retained launcher; closing uses the stable chat region.
  await expect(
    page.getByRole("region", { name: "Chat Alpha", exact: true }),
  ).toBeFocused();
  await trigger.focus();
  await page.mouse.move(0, 0);
  await page.keyboard.press("ArrowDown");
  await expect(preview).toBeVisible();
  await expect(preview).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await preview.getByRole("button", { name: /^View .+ activity$/ }).click();
  await expect(panel).toBeVisible();
  await openSettings(page);
  await selectSettingsSection(page, "Manage plugins");
  await page
    .getByRole("button", { name: "Manage plugins", exact: true })
    .click();
  await pluginAction(page, "Agent Activity").click();
  // Closing Settings returns to the retained Solo visit without the trigger.
  await closeSettings(page);
  await expect(trigger).toHaveCount(0);
});
// Real hover, menu hit targets and local-panel handoff cannot be proved in jsdom.
test("Solo sidebar shares working activity, keyboard preview and local panel navigation", async ({
  page,
  app,
}, info) => {
  // Install before app timers exist so hover cleanup never mixes real/fake IDs.
  await page.clock.install();
  await page.goto(app.origin);
  await newChat(page);
  const sidebar = page.getByRole("navigation", { name: "Solo conversations" });
  const alpha = sidebar.locator(`[data-solo-channel-id="${id}"]`);
  await sidebar.getByRole("button", { name: "Beta", exact: true }).click();
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  const key = generateSecretKey();
  const event = (kind) => ({
    kind,
    seq: 1,
    timestamp: new Date().toISOString(),
    channelId: id,
    sessionId: "S",
    turnId: "sidebar-solo",
  });
  app.observer(event("turn_liveness"), key);
  const badge = alpha.getByRole("img", { name: /working in Alpha$/ });
  await page.mouse.move(0, 0);
  await expect(badge).toBeVisible();
  await expect(alpha.locator("[data-solo-working-indicator]")).toHaveCSS(
    "opacity",
    "1",
  );
  // Activity replaces the overflow action on pointer devices. Their centers
  // must agree even while the menu is visually hidden, not merely avoid overlap.
  await expectTrailingAlignment(alpha, badge);
  // Resize the actual sidebar (not just the browser), and scale text while the
  // same working row remains mounted. No state or geometry is substituted.
  const resize = page.getByRole("separator", {
    name: "Resize sidebar",
    exact: true,
  });
  for (const [keyName, size, mode] of [
    ["Home", "", "light"],
    ["End", "larger", "dark"],
  ]) {
    await resize.press(keyName);
    await page.evaluate(
      ({ size, mode }) => {
        document.documentElement.dataset.fontSize = size;
        document.documentElement.dataset.colorMode = mode;
      },
      { size, mode },
    );
    await page.mouse.move(0, 0);
    await expectTrailingAlignment(alpha, badge);
  }
  await page.evaluate(() => {
    document.documentElement.dataset.fontSize = "";
    document.documentElement.dataset.colorMode = "light";
  });
  await resize.press("Home");
  const shared = await showSharedMark(page, app, alpha);
  await page.mouse.move(0, 0);
  await expectTrailingAlignment(alpha, badge);
  // Pointer rows show one trailing status; working outranks Shared, and the
  // hidden mark takes no clicks.
  await expect(shared).toHaveCSS("opacity", "0");
  await expect(shared).toBeHidden();
  await alpha.press("Enter");
  await expect(alpha).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Escape");
  // Wait for the popup's real focus restoration before moving focus away.
  await expect(alpha).toBeFocused();
  await resize.focus();
  await expect(resize).toBeFocused();
  await page.mouse.move(0, 0);
  await expect(alpha.locator("[data-solo-working-indicator]")).toHaveCSS(
    "opacity",
    "1",
  );
  await expectTrailingAlignment(alpha, badge);
  await page
    .locator(`[data-solo-menu-id="${id}"]`)
    .screenshot({ path: info.outputPath("solo-working-selected.png") });
  // This point belongs to the visible status at rest and the action on hover.
  // It must stay actionable rather than becoming a clipped/dead trailing area.
  const marker = await badge.boundingBox();
  const x = marker.x + marker.width / 2,
    y = marker.y + marker.height / 2;
  await page.mouse.move(x, y);
  const action = page.locator(
    `[data-solo-menu-id="${id}"] [data-solo-row-action]`,
  );
  await expect(action).toHaveCSS("opacity", "1");
  // Bare row actions keep standard artwork, unlike glyph-state toggles.
  await expect(action.locator("svg")).toHaveCSS("width", "16px");
  await expect(action.locator("svg")).toHaveCSS("height", "16px");
  // The selected row's fill is the action's state; the action adds none.
  await expect(action).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  // Hovering a selected row's action keeps the selection's ink on the row.
  const selectedInk = await alpha.evaluate((row) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--text-row-selected)";
    row.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  await expect(alpha).toHaveCSS("color", selectedInk);
  // This shared row keeps Shared in the status slot on hover; the menu opens
  // from the slot beside it.
  await expect(
    page.locator(`[data-solo-menu-id="${id}"] [data-solo-shared]`),
  ).toBeVisible();
  await action.click();
  // Base UI focuses the menu on the next frame. Escape before then leaves
  // focus on the trigger, and the menu keeps focus where it already is.
  await expect(
    page.getByRole("menu", { name: "Actions for Alpha", exact: true }),
  ).toBeFocused();
  await expect(action).toHaveAttribute("aria-expanded", "true");
  await expect(action).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.keyboard.press("Escape");
  await expect(alpha).toBeFocused();
  await sidebar.getByRole("button", { name: "Beta", exact: true }).click();
  await page.mouse.move(0, 0);
  await expectTrailingAlignment(alpha, badge);
  await alpha.hover();
  const popup = page.getByRole("dialog", {
    name: "Activity in Alpha",
    exact: true,
  });
  await expect(popup).toBeVisible();
  await expect(
    sidebar.getByRole("button", { name: "Beta", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await popup.getByRole("button", { name: /Open conversation for/ }).hover();
  await popup.getByRole("button", { name: /View .+ activity/ }).click();
  const panel = agentProfile(page);
  await expect(panel.locator("code").first()).toHaveText(
    npubEncode(getPublicKey(key)),
  );
  await expect(sidebar).toBeVisible();
  await expect(alpha).toHaveAttribute("aria-current", "page");
  await closeProfile(page).click();
  await expect(alpha).toBeFocused();
  // Hold wall time while pausing so command latency cannot pass the target.
  await pauseClock(page);
  // Cross the closed trigger, then reopen by keyboard before hover dismissal.
  await alpha.hover();
  await page.mouse.move(0, 0);
  await alpha.press("Enter");
  await expect(alpha).toHaveAttribute("aria-expanded", "true");
  await expect(popup).toBeVisible();
  // Run past the 150ms hover-close deadline, not a wall-clock wait.
  await page.clock.runFor(200);
  await page.clock.resume();
  await expect(popup).toBeVisible();
  const activityAction = popup.getByRole("button", {
    name: /View .+ activity/,
  });
  // Visibility precedes Base UI's initial-focus handoff. Wait for that boundary
  // before tabbing, otherwise a fast keypress can leave the popup while it opens.
  await expect(
    popup.getByRole("button", { name: /Open conversation for/ }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(activityAction).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel).toBeVisible();
  await closeProfile(page).click();
  // Context actions must remain separate from the activity trigger.
  await alpha.press("Shift+F10");
  await expect(
    page.getByRole("menuitem", { name: "Chat settings", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  app.observer(event("turn_completed"), key);
  await expect(badge).toHaveCount(0);
});

// The minifier wraps a :has() selector list in :is(); WebKit then restyles the
// whole document on every sidebar activity change.
test("Solo row status rules keep :has() out of minified :is() lists", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await newChat(page);
  const wrapped = await page.evaluate(() => {
    const found = [];
    const walk = (rules) => {
      for (const rule of rules) {
        if (rule.cssRules) walk(rule.cssRules);
        const selector = rule.selectorText ?? "";
        if (
          selector.startsWith(":is(") &&
          selector.includes(":has(") &&
          selector.includes("data-solo-shared")
        )
          found.push(selector);
      }
    };
    for (const sheet of document.styleSheets) walk(sheet.cssRules);
    return found;
  });
  expect(wrapped).toEqual([]);
});

// Reading needs real focus inside the chat; a pointer selection leaves it on the row.
test.describe("reading", () => {
  test.use({ readState: true });
  const bold = (row) => row.locator('[data-channel-unread-title="true"]');
  test("Solo chat reads a chat opened from the sidebar, so it stays unbolded after leaving", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await newChat(page);
    const sidebar = page.getByRole("navigation", {
      name: "Solo conversations",
    });
    const alpha = sidebar.locator(`[data-solo-channel-id="${id}"]`);
    const beta = sidebar.locator(`[data-solo-channel-id="${other}"]`);
    // Startup shows Alpha in Messages first, so read Beta, which only Solo shows.
    await expect(bold(beta)).toHaveCount(1);
    // The marker must paint: weight is Solo's only unread cue.
    const semibold = await beta.evaluate((row) => {
      const probe = document.createElement("span");
      probe.style.fontWeight = "var(--type-weight-semibold)";
      row.append(probe);
      const weight = getComputedStyle(probe).fontWeight;
      probe.remove();
      return weight;
    });
    await expect(bold(beta)).toHaveCSS("font-weight", semibold);
    await expect(beta.locator("[data-channel-priority]")).toHaveCount(0);
    await beta.click();
    // The dwell policy reads the visible bottom without any further input,
    // because selection hands focus to the chat's composer.
    await expect(bold(beta)).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Message your agents", exact: true }),
    ).toBeFocused();
    await alpha.click();
    // Unselected, Beta's row shows its saved read state rather than selection.
    await expect(alpha).toHaveAttribute("aria-current", "page");
    await expect(bold(beta)).toHaveCount(0);
    expect(app.report.unexpected).toEqual([]);
  });

  // Hover opens the row's activity preview; clicking keeps it open, so focus
  // starts on a trigger with an open popup.
  test("Solo chat focuses and reads a chat clicked while its activity preview is open", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await newChat(page);
    const sidebar = page.getByRole("navigation", {
      name: "Solo conversations",
    });
    const alpha = sidebar.locator(`[data-solo-channel-id="${id}"]`);
    const beta = sidebar.locator(`[data-solo-channel-id="${other}"]`);
    await alpha.click();
    // Leaving the draft retires its "New chat" row, which lifts Beta under the
    // still pointer. Hover starts on pointer entry, so leave and re-enter.
    await expect(
      sidebar.getByRole("button", { name: "New chat", exact: true }),
    ).toHaveCount(0);
    await page.mouse.move(0, 0);
    await expect(bold(beta)).toHaveCount(1);
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    app.observer(
      {
        kind: "turn_liveness",
        seq: 1,
        timestamp: new Date().toISOString(),
        channelId: other,
        sessionId: "S",
        turnId: "preview-focus",
      },
      generateSecretKey(),
    );
    await expect(
      beta.getByRole("img", { name: /working in Beta$/ }),
    ).toBeVisible();
    await beta.hover();
    await expect(
      page.getByRole("dialog", { name: "Activity in Beta", exact: true }),
    ).toBeVisible();
    await beta.click();
    await expect(beta).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("textbox", { name: "Message your agents", exact: true }),
    ).toBeFocused();
    await expect(bold(beta)).toHaveCount(0);
    expect(app.report.unexpected).toEqual([]);
  });
});

// Real PersonalComposer -> signing boundary remains covered through the main reader.
// A Solo chat no longer has a user path that opens another conversation as a side tab.
// Owner-authored inventory supplies choices; signed membership remains authority.
test.describe("personal recipients", () => {
  test.use({
    soloAgentNames: ["Owned Honey", "Owned Brain"],
    soloOutsideAgentNames: ["Outside Agent"],
  });
  test("Solo chat signs only explicit owned recipients and never offers an outside identity, in a linked tab too", async ({
    page,
    app,
  }) => {
    // An older finite head may finish after a live arrival mounts the reader.
    // Hold the response to exercise that route; the mounted timeline test
    // controls the exact zero-viewport ordering independently of browser timing.
    let releaseHead;
    const heldHead = new Promise((resolve) => {
      releaseHead = resolve;
    });
    let readHead = false;
    await page.route("**/api/relay/primary/query", async (route) => {
      if (
        !route
          .request()
          .postDataJSON()
          .some((filter) => filter.top_level && filter["#h"]?.includes("gamma"))
      )
        return route.continue();
      const response = await route.fetch();
      readHead = true;
      await heldHead;
      await route.fulfill({ response }).catch(() => {});
    });
    try {
      await page.goto(app.origin);
      // Startup opens Gamma, so its head is held from here. Deliver the live
      // arrival and release now rather than across the whole Solo section,
      // which would outlast the relay reader's deadline.
      await expect.poll(() => readHead).toBe(true);
      await expect
        .poll(() =>
          app.report.liveRequests.some((request) =>
            request.filters.some((filter) => filter["#h"]?.includes("gamma")),
          ),
        )
        .toBe(true);
      // Own Solo chats are listed in the Solo section, not the Team channel
      // list. A real conversation link still opens them in the Messages reader.
      const link = app.append(
        "primary",
        "gamma",
        `[Open Beta](buzz://channel/${other})`,
      );
      releaseHead();
      await expect(
        page.locator(`[data-message-id="${link.id}"]`),
      ).toBeVisible();
      await newChat(page);
      await page
        .getByRole("navigation", { name: "Solo conversations" })
        .getByRole("button", { name: "Beta", exact: true })
        .click();
      const workspace = page.getByRole("main");
      const composer = page.getByRole("textbox", {
        name: "Message your agents",
        exact: true,
      });
      const [, brain, outsider] = app.soloAgents;
      // Agents-only Solo chats address agents from the composer's pill.
      const pill = (scope) =>
        scope.getByRole("button", { name: /Change agents$|^Choose agent$/ });
      await expect(composer).toHaveText("");
      // An existing chat starts addressed to one of its agents.
      await expect(pill(workspace)).toHaveAccessibleName(
        /^Sending to .+\. Change agents$/,
      );
      // Choose an owned recipient from the pill.
      await sendOnlyTo(page, pill(workspace), brain);
      await composer.press("End");
      await page.keyboard.insertText("Only this agent from Beta");
      await composer.press("Enter");
      const publications = () =>
        app.report.publications.filter(({ event }) => event.kind === 9);
      await expect.poll(() => publications().length).toBe(1);
      const sent = publications()[0].event;
      expect(verifyEvent(sent)).toBe(true);
      expect(sent.tags.filter(([key]) => key === "h")).toEqual([["h", other]]);
      expect(sent.tags.filter(([key]) => key === "p")).toEqual([
        ["p", brain.pubkey],
      ]);
      // The next draft retains the last notified agent, not the account
      // default, and keeps it out of the text.
      await expect(pill(workspace)).toHaveAccessibleName(
        `Sending to ${brain.name}. Change agents`,
      );
      await expect(composer).toHaveText("");
      // A draft from the ordinary Messages reader may retain a channel member
      // who isn't in the owner's inventory. A Solo chat must reject that explicit recipient.
      await composer.fill("");
      await openPage(page, "Messages");
      await page.locator('[data-channel-id="gamma"]').click();
      await page
        .locator(`[data-message-id="${link.id}"]`)
        .getByRole("link", {
          name: "Open Chat: Beta",
          exact: true,
        })
        .click();
      const linkedChat = page.getByRole("tabpanel", {
        name: "Beta",
        exact: true,
      });
      // The linked tab follows the same Solo policy as the main reader: the
      // channel member outside the owner's inventory is not offered.
      await pill(linkedChat).click();
      const linkedPicker = page.getByRole("dialog", {
        name: "Mention a member or agent",
      });
      await expect(
        linkedPicker
          .getByRole("button")
          .and(page.locator(`[data-mention-choice="${brain.pubkey}"]`)),
      ).toBeVisible();
      await expect(
        linkedPicker
          .getByRole("button")
          .and(page.locator(`[data-mention-choice="${outsider.pubkey}"]`)),
      ).toHaveCount(0);
      await page.keyboard.press("Escape");
      expect(publications()).toHaveLength(1);
    } finally {
      releaseHead();
    }
  });
});

// Touch has no hover affordance: working must coexist with the permanent menu.
test.describe("touch sidebar activity", () => {
  test.use({ hasTouch: true, isMobile: true });
  test("working remains visible beside the row menu", async ({
    page,
    app,
  }, info) => {
    await page.goto(app.origin);
    await newChat(page);
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    const key = generateSecretKey();
    const event = (kind) => ({
      kind,
      seq: 1,
      timestamp: new Date().toISOString(),
      channelId: id,
      sessionId: "S",
      turnId: "touch",
    });
    app.observer(event("turn_liveness"), key);
    const row = page.locator(`[data-solo-channel-id="${id}"]`);
    const indicator = row.locator("[data-solo-working-indicator]");
    await expect(
      row.getByRole("img", { name: /working in Alpha$/ }),
    ).toBeVisible();
    await expect(indicator).toHaveCSS("opacity", "1");
    await row.tap();
    await expect(row).toHaveAttribute("aria-current", "page");
    await expect(indicator).toHaveCSS("opacity", "1");
    // The quiet pill distinguishes working from the adjacent overflow glyph.
    // Its own ink/fill pair must survive the selection's inherited text color.
    const badge = row.locator("[data-channel-working]");
    const detail = await row.evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--text-row-selected-detail)";
      probe.style.backgroundColor = "var(--surface-row-selected-detail)";
      element.append(probe);
      const style = getComputedStyle(probe);
      const pair = { ink: style.color, fill: style.backgroundColor };
      probe.remove();
      return pair;
    });
    await expect(badge).toHaveCSS("background-color", detail.fill);
    await expect(badge).toHaveCSS("color", detail.ink);
    const dots = badge.locator('[data-state="working"] > span');
    await expect(dots).toHaveCount(3);
    for (const dot of await dots.all())
      await expect(dot).toHaveCSS("background-color", detail.ink);
    const menu = page.locator(
      `[data-solo-menu-id="${id}"] [data-solo-row-action]`,
    );
    await expect(menu).toHaveCSS("opacity", "1");
    await expectTrailingAlignment(row, badge, true);
    const shared = await showSharedMark(page, app, row);
    await expectTrailingAlignment(row, badge, true);
    await expect(shared).toBeVisible();
    // Touch keeps adjacent actions and status aligned at wider layouts and
    // larger text too, without a hard-coded extra action-width offset.
    await page
      .getByRole("separator", { name: "Resize sidebar", exact: true })
      .press("End");
    await page.evaluate(() => {
      document.documentElement.dataset.colorMode = "dark";
      document.documentElement.dataset.fontSize = "larger";
    });
    await expectTrailingAlignment(row, badge, true);
    await page
      .locator(`[data-solo-menu-id="${id}"]`)
      .screenshot({ path: info.outputPath("solo-touch-working.png") });
    await menu.focus();
    await expect(menu).toBeFocused();
    await expect(indicator).toHaveCSS("opacity", "1");
    const label = row.locator(".navigation-item-label");
    const labelWidth = await label.evaluate((element) => element.clientWidth);
    const before = await menu.boundingBox();
    app.observer(event("turn_completed"), key);
    await expect(badge).toHaveCount(0);
    await expect(indicator).toBeHidden();
    await expect
      .poll(() => label.evaluate((element) => element.clientWidth))
      .toBeGreaterThan(labelWidth);
    const after = await menu.boundingBox();
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);
    await expect(menu).toBeFocused();
  });
});

// Captured-message navigation uses the exact-message reader, not a guessed thread.
test("Solo sidebar opens a captured trigger in the canonical message reader", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await newChat(page);
  const sidebar = page.getByRole("navigation", { name: "Solo conversations" });
  const alpha = sidebar.locator(`[data-solo-channel-id="${id}"]`);
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  const key = generateSecretKey();
  const target = app.histories.get(`primary/${id}`)[0];
  app.observer(
    {
      kind: "turn_started",
      seq: 1,
      timestamp: new Date().toISOString(),
      channelId: id,
      sessionId: "S",
      turnId: "captured-trigger",
      payload: { triggeringEventIds: [target.id] },
    },
    key,
  );
  await expect(
    alpha.getByRole("img", { name: /working in Alpha$/ }),
  ).toBeVisible();
  await alpha.hover();
  const popup = page.getByRole("dialog", {
    name: "Activity in Alpha",
    exact: true,
  });
  await expect(popup).toBeVisible();
  await popup.getByRole("button", { name: /Open thread for/ }).click();
  await expect(sidebar).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(decodeURIComponent(location.hash.slice("#buzz=".length))),
      ),
    )
    .toMatchObject({
      kind: "conversation",
      channelId: id,
      messageId: target.id,
    });
  await expect(page.locator(`[data-message-id="${target.id}"]`)).toBeVisible();
});
