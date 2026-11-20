import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
import { animationsSettled } from "./animations.mjs";

const chat = "33333333-3333-4333-8333-333333333333";
test.use({
  productionBroker: true,
  pluginFixtures: true,
  channelLifecycle: true,
  memberRoleChanges: true,
  channelIds: ["alpha", chat],
  channelNames: { alpha: "Project updates", [chat]: "Design review" },
  soloChannels: [chat],
  ownSoloChannels: [chat],
  historyCounts: { alpha: 0, [chat]: 0 },
  viewport: { width: 1100, height: 900 },
});

async function capture(dialog, info, name) {
  await animationsSettled(dialog, { subtree: true });
  await dialog.screenshot({ path: info.outputPath(name) });
}

async function openSoloAccess(page, app) {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page.evaluate(
    ({ chat, viewer }) =>
      window.fixtureNavigation.open({
        version: 1,
        kind: "conversation",
        channelId: chat,
        scope: { viewer, communityOrigin: "https://primary.example" },
      }),
    { chat, viewer: app.viewer },
  );
  await page.getByRole("button", { name: /^Share access to / }).click();
  return page.getByRole("button", {
    name: "Actions for Owner Agent",
    exact: true,
  });
}

// Browser-only: production app routing, portalled menu hit-testing, keyboard
// selection and nested confirmation focus through the real broker signer/write.
// Only upstream signed membership policy is modeled; role matrices live in Vitest.
test("the Solo owner changes an existing agent's access from its menu", async ({
  page,
  app,
}, info) => {
  const agent = app.ownerAgent;
  expect(agent).toBeDefined();
  app.serveMembers(chat, [agent]);
  const grants = () =>
    app.report.publications.filter(({ event }) => event.kind === 9050);
  await page.route("**/api/relay/primary/query", async (route) => {
    const response = await route.fetch();
    const events = await response.json();
    const role = grants().length ? "admin" : "bot";
    await route.fulfill({
      response,
      json: events.map((event) => {
        if (
          ![39001, 39002].includes(event.kind) ||
          !event.tags.some(([tag, value]) => tag === "d" && value === chat)
        )
          return event;
        const tags = event.tags.filter(
          ([tag, key]) => tag !== "p" || key !== agent,
        );
        if (event.kind === 39002) tags.push(["p", agent, "", role]);
        else if (role === "admin") tags.push(["p", agent, "admin"]);
        return app.signRelay({
          ...event,
          tags,
          created_at: event.created_at + 100 + grants().length,
        });
      }),
    });
  });
  await page.addInitScript(() => {
    localStorage.setItem("buzz-appearance.v1", "dark");
    localStorage.setItem("buzz-accent.v1", "cobalt");
  });
  const actions = await openSoloAccess(page, app);
  await actions.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await animationsSettled(menu, { subtree: true });
  const share = page.getByRole("dialog", { name: "Share access", exact: true });
  await capture(share, info, "agent-access-menu.png");
  await expect(
    menu.getByRole("menuitemradio", { name: "Participating", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByRole("menuitemradio")).toHaveCount(3);
  await expect(
    menu.getByRole("menuitem", { name: "Transfer ownership" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(actions).toBeFocused();
  await actions.press("Enter");
  const admin = page.getByRole("menuitemradio", { name: "Admin", exact: true });
  await admin.focus();
  await page.keyboard.press("Enter");
  const confirm = page.getByRole("dialog", { name: "Change access to Admin?" });
  const save = confirm.getByRole("button", {
    name: "Set as admin",
    exact: true,
  });
  await expect(save).toBeFocused();
  expect(grants()).toHaveLength(0);
  await capture(confirm, info, "agent-access-confirmation.png");
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(actions).toBeFocused();
  expect(grants()).toHaveLength(0);
  await actions.click();
  await page.getByRole("menuitemradio", { name: "Admin", exact: true }).click();
  await save.click();
  await expect(share).toBeVisible();
  await expect.poll(() => grants().length).toBe(1);
  expect(grants()[0].event.tags).toEqual([
    ["h", chat],
    ["p", agent],
    ["role", "admin"],
    ["expected_role", "bot"],
  ]);
  await actions.click();
  await expect(
    page.getByRole("menuitemradio", { name: "Admin", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  for (const theme of ["light", "dark"]) {
    for (const width of [1100, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((theme) => {
        document.documentElement.dataset.colorMode = theme;
        document.documentElement.style.fontSize = "20px";
      }, theme);
      await expect(page.locator("html")).toHaveAttribute(
        "data-color-mode",
        theme,
      );
      await actions.click();
      for (const label of ["Admin", "Participating", "Viewing only"]) {
        await expect(
          page.getByRole("menuitemradio", { name: label, exact: true }),
        ).toBeInViewport({ ratio: 1 });
      }
      await page.keyboard.press("Escape");
      await expect(actions).toBeFocused();
    }
  }
  expect(app.report.unexpected).toEqual([]);
});

test.describe("relay without Solo role update support", () => {
  test.use({ memberRoleChanges: false, lifecycleOwnerAgent: true });

  test("keeps existing member actions without offering role changes", async ({
    page,
    app,
  }) => {
    const agent = app.ownerAgent;
    expect(agent).toBeDefined();
    app.serveMembers(chat, [agent]);
    await (await openSoloAccess(page, app)).click();
    const menu = page.getByRole("menu");
    await expect(
      menu.getByRole("menuitem", { name: "Remove from chat" }),
    ).toBeVisible();
    await expect(menu.getByRole("menuitemradio")).toHaveCount(0);
    expect(app.report.unexpected).toEqual([]);
  });
});
