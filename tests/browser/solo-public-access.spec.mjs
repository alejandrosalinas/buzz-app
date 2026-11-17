import { test, expect } from "./fixture.mjs";
import { generateSecretKey } from "nostr-tools";
import {
  expectMessageActionsHidden,
  hoverMessage,
} from "./message-actions.mjs";

const own = "33333333-3333-4333-8333-333333333333";
const shared = "11111111-1111-4111-8111-111111111111";
const presentations = [
  { mode: "dark", width: 1440, scale: 1 },
  { mode: "light", width: 1440, scale: 1 },
  { mode: "dark", width: 390, scale: 1.5 },
  { mode: "light", width: 390, scale: 1.5 },
];

test.use({ productionBroker: true, channelLifecycle: true });

async function openChat(page, app, channelId) {
  await page.goto(
    `${app.origin}/#buzz=${encodeURIComponent(
      JSON.stringify({
        version: 1,
        kind: "conversation",
        channelId,
        scope: {
          viewer: app.viewer,
          communityOrigin: "https://primary.example",
        },
      }),
    )}`,
  );
  await expect(
    page.getByRole("article", { name: "Conversation", exact: true }),
  ).toBeVisible();
}

async function present(page, { mode, width, scale }) {
  await page.setViewportSize({ width, height: width === 390 ? 720 : 950 });
  await page.evaluate(
    ({ mode, scale }) => {
      localStorage.setItem("buzz-appearance.v1", mode);
      localStorage.setItem("buzz-font-scale.v1", String(scale));
      localStorage.setItem("buzz-accent.v1", "cobalt");
    },
    { mode, scale },
  );
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
  await expect(page.locator("html")).toHaveCSS(
    "--buzz-text-scale",
    String(scale),
  );
}

async function capture(surface, info, name) {
  if (info.project.name === "chromium")
    await surface.screenshot({ path: info.outputPath(`${name}.png`) });
}

function accessControls(page) {
  const dialog = page.getByRole("dialog", {
    name: "Share access",
    exact: true,
  });
  return {
    dialog,
    audience: dialog.getByRole("combobox", { name: "General access" }),
    confirm: page.getByRole("alertdialog", {
      name: "Change general access?",
    }),
    async openAccess() {
      // Cached startup renders Share access too. Its local dialog is replaced
      // with the live session; Chat actions exists only on the live header.
      await expect(
        page.getByRole("button", { name: "Chat actions", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: /^Share access to /, exact: true })
        .last()
        .click();
    },
  };
}

// These journeys preserve actual routing, signed discovery, broker save/readback,
// focus and responsive overlays. Role matrices stay in Vitest.
test.describe("owner", () => {
  test.use({
    channelIds: [own],
    channelNames: { [own]: "Release planning" },
    soloChannels: [own],
    ownSoloChannels: [own],
    historyCounts: { [own]: 2 },
  });
  test("omits Public, retains View only after reload, and restores privacy", async ({
    page,
    app,
  }, info) => {
    await openChat(page, app, own);
    const row = page.locator(`[data-solo-channel-id="${own}"]`);
    const { dialog, audience, openAccess, confirm } = accessControls(page);
    let saves = 0;
    for (const presentation of presentations) {
      const suffix = `${presentation.mode}_${presentation.width}`;
      await present(page, presentation);
      if (presentation.width === 1440) await expect(row).toBeVisible();
      await openAccess();
      await expect(audience).toBeEnabled();
      await expect(audience).toHaveText("Private");
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      // General access now scrolls with the member list, including at enlarged text.
      await audience.scrollIntoViewIfNeeded();
      await expect(audience).toBeInViewport({ ratio: 1 });
      await capture(dialog, info, `SOLO_DROPDOWN_PRIVATE_${suffix}`);
      await audience.focus();
      await audience.press("Enter");
      await expect(page.getByRole("option")).toHaveCount(2);
      await expect(
        page.getByRole("option", { name: "Public", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("option", { name: "Private", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("option", { name: "View only", exact: true }),
      ).toBeVisible();
      // The popup owns the transition; the nested list has no animations.
      await expect(page.locator(".buzz-select-popup")).toHaveCSS(
        "filter",
        "blur(0px)",
      );
      await expect(page.locator(".buzz-select-popup")).toHaveCSS(
        "opacity",
        "1",
      );
      // At 150% text the shared popup scrolls to the selected Private item.
      // Verify View only is reachable before capturing it.
      const viewOnlyOption = page.getByRole("option", {
        name: "View only",
        exact: true,
      });
      await viewOnlyOption.scrollIntoViewIfNeeded();
      await expect(viewOnlyOption).toBeInViewport({ ratio: 1 });
      await capture(page, info, `SOLO_DROPDOWN_OPTIONS_${suffix}`);
      await page.keyboard.press("Home");
      await expect(viewOnlyOption).toBeFocused();
      await expect(confirm).toHaveCount(0);
      expect(app.report.detailsPublications?.length ?? 0).toBe(saves);
      await page.keyboard.press("Enter");
      await expect(confirm).toHaveAccessibleDescription(
        "Everyone in this community will be able to read this chat’s full history and Canvas, including its workspace folders and agent instructions.",
      );
      await expect(
        confirm.getByRole("button", { name: "Cancel", exact: true }),
      ).toBeFocused();
      await capture(confirm, info, `SOLO_VIEW_ONLY_CONFIRMATION_${suffix}`);
      await page.keyboard.press("Escape");
      await expect(audience).toBeFocused();
      expect(app.report.detailsPublications?.length ?? 0).toBe(saves);
      await audience.click();
      await page
        .getByRole("option", { name: "View only", exact: true })
        .click();
      await expect(
        confirm.getByRole("button", { name: "Change access", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await confirm
        .getByRole("button", { name: "Change access", exact: true })
        .click();
      await expect(audience).toBeEnabled();
      await expect(audience).toHaveText("View only");
      expect(app.report.detailsPublications).toHaveLength(++saves);
      const opened = app.report.detailsPublications.at(-1);
      expect(opened.tags).toContainEqual(["visibility", "open"]);
      if (saves === 1)
        expect(opened.tags).toContainEqual(["join_role", "guest"]);
      await expect(dialog.getByRole("combobox")).toHaveCount(1);
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      await capture(dialog, info, `SOLO_DROPDOWN_VIEW_ONLY_${suffix}`);
      await page.keyboard.press("Escape");
      await page.reload();
      await openAccess();
      await expect(audience).toHaveText("View only");
      await expect(audience).toBeEnabled();
      // A title update can arrive while Share access stays open. Switching
      // back to Private must review the current signed details, not overwrite
      // that update or fail against the snapshot from opening the dialog.
      if (saves === 1) {
        app.setChannelMetadata(own, [
          ["t", "stream"],
          ["t", "buzz.solo"],
          ["P", app.viewer],
          ["name", "Renamed while sharing"],
          ["public"],
          ["join_role", "guest"],
        ]);
      }
      await audience.click();
      await expect(
        page.getByRole("option", { name: "Public", exact: true }),
      ).toHaveCount(0);
      await page.getByRole("option", { name: "Private", exact: true }).click();
      await expect(confirm).toContainText(
        "Only chat members will have access.",
      );
      await confirm
        .getByRole("button", { name: "Change access", exact: true })
        .click();
      await expect(audience).toHaveText("Private");
      await expect(audience).toBeEnabled();
      expect(app.report.detailsPublications).toHaveLength(++saves);
      expect(app.report.detailsPublications.at(-1).tags).toContainEqual([
        "visibility",
        "private",
      ]);
      if (saves === 2)
        expect(app.report.detailsPublications.at(-1).tags).toContainEqual([
          "name",
          "Renamed while sharing",
        ]);
      await expect(
        dialog.getByRole("button", { name: "Done", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await page.keyboard.press("Escape");
    }
    expect(app.report.detailsPublications.map(({ kind }) => kind)).toEqual(
      Array(8).fill(9002),
    );
    expect(app.report.lifecyclePublications ?? []).toEqual([]);
    expect(app.report.publications).toEqual([]);
  });

  test("explains retained access for joined viewers and existing Public chats", async ({
    page,
    app,
  }, info) => {
    await openChat(page, app, own);
    const { dialog, audience, openAccess, confirm } = accessControls(page);
    // The longer conditional descriptions need real modal geometry and focus
    // coverage. Guest/status matrices remain in the component/session tests.
    const guest = app.serveProfile(generateSecretKey(), {
      name: "Aria viewer",
    });
    app.addChannelGuest(own, guest.pubkey);
    for (const presentation of presentations) {
      const suffix = `${presentation.mode}_${presentation.width}`;
      app.setChannelMetadata(own, [
        ["t", "stream"],
        ["t", "buzz.solo"],
        ["P", app.viewer],
        ["name", "Release planning"],
        ["public"],
        ["join_role", "guest"],
      ]);
      await present(page, presentation);
      await openAccess();
      await expect(audience).toBeEnabled();
      await expect(audience).toHaveText("View only");
      await expect(
        dialog.getByText("Viewing only", { exact: true }),
      ).toBeVisible();
      await audience.click();
      await page.getByRole("option", { name: "Private", exact: true }).click();
      await expect(confirm).toHaveAccessibleDescription(
        "Only chat members will have access. People who joined while it was View only are members and keep reading until you remove them in People.",
      );
      await expect(
        confirm.getByRole("button", { name: "Cancel", exact: true }),
      ).toBeFocused();
      await expect(
        confirm.getByRole("button", { name: "Change access", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await capture(confirm, info, `SOLO_PRIVATE_GUEST_CONFIRMATION_${suffix}`);
      await page.keyboard.press("Escape");
      await expect(audience).toBeFocused();
      await page.keyboard.press("Escape");
      app.setChannelMetadata(own, [
        ["t", "stream"],
        ["t", "buzz.solo"],
        ["P", app.viewer],
        ["name", "Release planning"],
        ["public"],
        ["join_role", "member"],
      ]);
      await page.reload();
      await openAccess();
      await expect(audience).toBeEnabled();
      await expect(audience).toHaveText("Public");
      await audience.click();
      await page
        .getByRole("option", { name: "View only", exact: true })
        .click();
      await expect(confirm).toHaveAccessibleDescription(
        "Everyone in this community will be able to read this chat’s full history and Canvas, including its workspace folders and agent instructions. People already in the chat keep their access. You won’t be able to switch back to Public here.",
      );
      await expect(
        confirm.getByRole("button", { name: "Change access", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await capture(
        confirm,
        info,
        `SOLO_EXISTING_PUBLIC_CONFIRMATION_${suffix}`,
      );
      await page.keyboard.press("Escape");
      await expect(audience).toBeFocused();
      await audience.click();
      await page.getByRole("option", { name: "Private", exact: true }).click();
      await expect(confirm).toHaveAccessibleDescription(
        "Only chat members will have access. People who already joined remain members and keep their access until you remove them in People. You won’t be able to switch back to Public here.",
      );
      await expect(
        confirm.getByRole("button", { name: "Change access", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await capture(
        confirm,
        info,
        `SOLO_PUBLIC_PRIVATE_CONFIRMATION_${suffix}`,
      );
      await page.keyboard.press("Escape");
      await expect(audience).toBeFocused();
      await page.keyboard.press("Escape");
    }
    expect(app.report.detailsPublications ?? []).toEqual([]);
    expect(app.report.lifecyclePublications ?? []).toEqual([]);
    expect(app.report.publications).toEqual([]);
  });
});

test.describe("visitor", () => {
  test.use({
    guestPermalinks: true,
    lifecycleRole: "nonmember",
    historyCounts: { [shared]: 2 },
  });
  test("reads View only without joining and loses access when the chat becomes Private", async ({
    page,
    app,
  }, info) => {
    const tags = [
      ["name", "Release planning"],
      ["t", "stream"],
      ["t", "buzz.solo"],
      ["P", "a".repeat(64)],
      ["join_role", "guest"],
    ];
    app.setChannelMetadata(shared, [...tags, ["public"]]);
    await page.goto(app.origin);
    await page
      .getByRole("button", { name: "Search Buzz", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Search Buzz" })
      .fill("Release planning");
    const result = page
      .locator("[data-search-result]")
      .filter({ hasText: "View-only chat" });
    await expect(result).toContainText("Release planning");
    await result.click();
    const article = page.getByRole("article", {
      name: "Conversation",
      exact: true,
    });
    for (const presentation of presentations) {
      const suffix = `${presentation.mode}_${presentation.width}`;
      await present(page, presentation);
      const message = article.locator("[data-message-id]").last();
      await expect(message).toBeVisible();
      await expect(
        page.getByText(
          "This chat is read-only. Join to keep it in your sidebar and appear as a viewer.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Join", exact: true }),
      ).toBeVisible();
      await expect(
        page.locator(`[data-solo-channel-id="${shared}"]`),
      ).toHaveCount(0);
      await hoverMessage(message);
      await message
        .getByRole("button", { name: "More message actions", exact: true })
        .click();
      await expect(page.getByRole("menu")).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: "React", exact: true }),
      ).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      const searchButton = page.getByRole("button", {
        name: "Search Buzz",
        exact: true,
      });
      await searchButton.focus();
      await expect(searchButton).toBeFocused();
      await searchButton.evaluate((button) => button.blur());
      await page.mouse.move(0, 0);
      await expect(page.getByRole("tooltip")).toHaveCount(0);
      await expectMessageActionsHidden(
        message.getByRole("group", {
          name: "Message actions",
          exact: true,
          includeHidden: true,
        }),
      );
      await capture(article, info, `SOLO_DROPDOWN_VISITOR_${suffix}`);
      await page
        .getByRole("button", { name: /^Chat access for / })
        .last()
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Chat access",
        exact: true,
      });
      await expect(
        dialog.getByText("Anyone in the community can read."),
      ).toBeVisible();
      await expect(
        dialog.getByText("Viewing only. Ask an owner or admin to participate."),
      ).toBeVisible();
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      await expect(
        dialog.getByRole("combobox", { name: "General access" }),
      ).toHaveCount(0);
      await capture(dialog, info, `SOLO_DROPDOWN_VISITOR_ACCESS_${suffix}`);
      await page.keyboard.press("Escape");
    }
    app.setChannelMetadata(shared, [...tags, ["private"]]);
    await page.reload();
    await expect(article.locator("[data-message-id]")).toHaveCount(0);
    app.setChannelMetadata(shared, [
      ...tags.filter(([name]) => name !== "join_role"),
      ["join_role", "member"],
      ["public"],
    ]);
    await page.reload();
    await expect(article.locator("[data-message-id]").last()).toBeVisible();
    await expect(
      article.getByRole("region", { name: "Chat preview", exact: true }),
    ).toBeVisible();
    await expect(
      article.getByRole("button", { name: "Join", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: /^Share access to / })
      .last()
      .click();
    const existingAccess = page.getByRole("dialog", {
      name: "Share access",
      exact: true,
    });
    await expect(
      existingAccess.getByRole("region", { name: "Member list" }),
    ).toHaveAttribute("data-refreshing", "false");
    await expect(existingAccess.getByRole("alert")).toHaveCount(0);
    await expect(
      existingAccess.getByRole("region", { name: "People", exact: true }),
    ).toBeVisible();
    await expect(
      existingAccess.getByRole("region", { name: "General access" }),
    ).toContainText("New people can participate.");
    await capture(
      existingAccess,
      info,
      "SOLO_PUBLIC_EXISTING_VISITOR_light_390",
    );
    expect(app.report.detailsPublications ?? []).toEqual([]);
    expect(app.report.lifecyclePublications ?? []).toEqual([]);
    expect(app.report.publications).toEqual([]);
  });

  // Browser boundary: signed join/readback must update the real Solo inventory,
  // both action menus and role presentation without enabling composition.
  test("joins as a viewer, keeps Private access and leaves without write access", async ({
    page,
    app,
  }, info) => {
    const tags = [
      ["name", "Release planning"],
      ["t", "stream"],
      ["t", "buzz.solo"],
      ["P", "a".repeat(64)],
      ["join_role", "guest"],
    ];
    app.setChannelMetadata(shared, [...tags, ["public"]]);
    await openChat(page, app, shared);
    const article = page.getByRole("article", {
      name: "Conversation",
      exact: true,
    });
    const row = page.locator(`[data-solo-channel-id="${shared}"]`);
    await expect(row).toHaveCount(0);
    const join = page.getByRole("button", { name: "Join", exact: true });
    await present(page, presentations[0]);
    await expect(article.locator("[data-message-id]").last()).toBeVisible();
    await expect(join).toBeVisible();
    await capture(page, info, "VIEWER_JOIN_NOTICE_dark_1440");
    await join.focus();
    await join.press("Enter");
    await expect(row).toBeVisible();
    await expect(join).toHaveCount(0);
    await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
    await expect(
      page.getByText("This chat is read-only", { exact: true }),
    ).toBeVisible();
    expect(app.report.lifecyclePublications.map(({ kind }) => kind)).toEqual([
      9021,
    ]);
    for (const presentation of presentations) {
      await present(page, presentation);
      await expect(article.locator("[data-message-id]").last()).toBeVisible();
      if (presentation.width === 1440) await expect(row).toBeVisible();
      await expect(join).toHaveCount(0);
      await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
      await expect(
        page.getByText("This chat is read-only", { exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await capture(
        page,
        info,
        `VIEWER_JOINED_${presentation.mode}_${presentation.width}`,
      );
    }
    await present(page, presentations[0]);
    const actions = page.getByRole("button", {
      name: "Chat actions",
      exact: true,
    });
    await page.reload();
    await expect(row).toBeVisible();
    // Cached startup renders Share access too. Its local dialog is replaced
    // with the live session; Chat actions exists only on the live header.
    await expect(actions).toBeVisible();
    await page
      .getByRole("button", { name: /^Chat access for / })
      .last()
      .click();
    const access = page.getByRole("dialog", {
      name: "Chat access",
      exact: true,
    });
    await expect(
      access.getByText("Viewing only", { exact: true }),
    ).toBeVisible();
    await capture(access, info, "VIEWER_JOINED_ACCESS_dark_1440");
    await page.keyboard.press("Escape");
    app.setChannelMetadata(shared, [...tags, ["private"]]);
    await page.reload();
    await expect(article.locator("[data-message-id]").last()).toBeVisible();
    await expect(row).toBeVisible();
    await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
    await actions.click();
    await expect(
      page.getByRole("menuitem", { name: "Archive chat", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("menuitem", { name: "Leave chat", exact: true })
      .click();
    const leave = page.getByRole("dialog", {
      name: "Leave chat: Release planning",
      exact: true,
    });
    await expect(
      leave.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(actions).toBeFocused();
    await actions.click();
    await page
      .getByRole("menuitem", { name: "Leave chat", exact: true })
      .click();
    await leave
      .getByRole("button", { name: "Leave chat", exact: true })
      .click();
    await expect(row).toHaveCount(0);
    await expect(leave).toHaveCount(0);
    expect(app.report.lifecyclePublications.map(({ kind }) => kind)).toEqual([
      9021, 9022,
    ]);
    await openChat(page, app, shared);
    await expect(article.locator("[data-message-id]")).toHaveCount(0);
    app.setChannelMetadata(shared, [...tags, ["public"]]);
    await openChat(page, app, shared);
    await expect(join).toBeVisible();
    await expect(row).toHaveCount(0);
    expect(app.report.publications).toEqual([]);
    expect(app.report.unexpected).toEqual([]);
  });
});
