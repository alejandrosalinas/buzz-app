import { test, expect } from "./fixture.mjs";
import { newChat } from "./navigation.mjs";

const alpha = "33333333-3333-4333-8333-333333333333";
const beta = "44444444-4444-4444-8444-444444444444";
test.use({
  pluginFixtures: true,
  productionBroker: true,
  channelIds: [alpha, beta],
  channelNames: { [alpha]: "Alpha", [beta]: "Beta" },
  soloChannels: [alpha, beta],
  ownSoloChannels: [alpha, beta],
  historyCounts: { [alpha]: 1, [beta]: 1 },
});

async function createWorkspace(page, id, name) {
  await page
    .locator(`[data-solo-channel-id="${id}"]`)
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  await page
    .getByRole("menuitem", { name: "New workspace", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  const field = dialog.getByRole("textbox", { name: "Workspace name" });
  await expect(field).toBeFocused();
  await field.fill(name);
  await dialog.getByRole("button", { name: "Create and move" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByText("Saving workspace…", { exact: true }),
  ).toHaveCount(0);
}

async function pull(page, from, to) {
  const start = await from.boundingBox();
  const end = await to.boundingBox();
  if (!start || !end) throw new Error("Missing workspace header");
  await page.mouse.move(start.x + 12, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + 12, end.y + end.height / 2, { steps: 8 });
}

// Pointer activation, collision geometry, click suppression and the signed
// broker/readback/reload boundary require the real app in a browser. Failure
// and stale-head matrices remain in the preference/component tests.
test("ordinary and composed workspace headers reorder, cancel and restore", async ({
  page,
  app,
}) => {
  const published = async (count) => {
    await expect
      .poll(() => app.report.sidebarPublications?.length ?? 0)
      .toBe(count);
  };
  await page.goto(app.origin);
  await newChat(page);
  await createWorkspace(page, alpha, "Work");
  await published(1);
  await createWorkspace(page, beta, "Home");
  await published(2);
  // Reuse the saved workspaces while exercising both host header shapes.
  for (const [phase, composed] of [false, true].entries()) {
    const baseline = 2 + phase * 2;
    if (composed) {
      await page.goto(
        `${app.origin}/?solo-region-fixture&compose-workspaces&workspace-hit-targets`,
      );
      await newChat(page);
    }
    const sidebar = page.getByRole("navigation", {
      name: "Solo conversations",
    });
    const work = sidebar.locator("[data-project]").filter({
      has: page.getByRole("button", { name: "Work", exact: true }),
    });
    const home = sidebar.locator("[data-project]").filter({
      has: page.getByRole("button", { name: "Home", exact: true }),
    });
    const heading = (name) =>
      sidebar.getByRole("button", { name, exact: true });
    const order = () =>
      sidebar
        .locator(
          "[data-project] > [data-solo-menu-id], [data-project] [data-solo-workspace-id]",
        )
        .evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()));
    await expect.poll(order).toEqual(["Work", "Home"]);
    const disclosure = composed
      ? home.getByRole("button", { name: /tasks and chats in Home/ })
      : heading("Home");
    if ((await disclosure.getAttribute("aria-expanded")) === "false")
      await disclosure.click();
    await disclosure.click();
    const expanded = () =>
      composed
        ? home.getByRole("button", { name: "Show tasks and chats in Home" })
        : heading("Home");
    await expect(expanded()).toHaveAttribute("aria-expanded", "false");
    if (composed) {
      await heading("Work").click();
      await expect(heading("Work")).toHaveAttribute("aria-current", "page");
      await expect(heading("Home")).not.toHaveAttribute("aria-current");
    }

    await pull(page, heading("Home"), heading("Work"));
    await expect(home).toHaveAttribute("data-section-dragging");
    await expect(work).toHaveAttribute("data-drop-edge", "before");
    await expect(work).not.toHaveAttribute("data-drop-target");
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(
      sidebar.locator("[data-drop-edge], [data-section-dragging]"),
    ).toHaveCount(0);
    await expect.poll(order).toEqual(["Work", "Home"]);
    expect(app.report.sidebarPublications).toHaveLength(baseline);

    // Unfiled Chats is pinned; it cannot accept a workspace-header drop.
    await pull(page, heading("Home"), heading("Chats"));
    await expect(home).toHaveAttribute("data-section-dragging");
    await expect(
      sidebar.locator("[data-drop-edge], [data-drop-target]"),
    ).toHaveCount(0);
    await page.mouse.up();
    await expect(sidebar.locator("[data-section-dragging]")).toHaveCount(0);
    await expect.poll(order).toEqual(["Work", "Home"]);
    expect(app.report.sidebarPublications).toHaveLength(baseline);

    await pull(page, heading("Home"), heading("Work"));
    await expect(work).toHaveAttribute("data-drop-edge", "before");
    await page.mouse.up();
    await expect.poll(order).toEqual(["Home", "Work"]);
    await published(baseline + 1);
    await expect(expanded()).toHaveAttribute("aria-expanded", "false");
    // Suppress a late pointer click after the drop without disabling keyboard
    // activation or the next deliberate pointer action.
    await heading("Home").dispatchEvent("click", { detail: 1 });
    await expect(expanded()).toHaveAttribute("aria-expanded", "false");
    if (composed) {
      await expect(heading("Work")).toHaveAttribute("aria-current", "page");
      await expect(heading("Home")).not.toHaveAttribute("aria-current");
      await heading("Home").press("Enter");
      await expect(heading("Home")).toHaveAttribute("aria-current", "page");
      await heading("Work").click();
      await expect(heading("Work")).toHaveAttribute("aria-current", "page");
    }

    await page.reload();
    await expect.poll(order).toEqual(["Home", "Work"]);
    await expect(expanded()).toHaveAttribute("aria-expanded", "false");
    await expect(
      work.locator(`[data-solo-channel-id="${alpha}"]`),
    ).toBeVisible();
    await expect(sidebar.getByRole("alert")).toHaveCount(0);

    await sidebar.getByRole("button", { name: "Actions for Home" }).focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("menuitem", { name: "Move up", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("menuitem", { name: "Move down", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await expect.poll(order).toEqual(["Work", "Home"]);
    await published(baseline + 2);
    await expect(expanded()).toHaveAttribute("aria-expanded", "false");
  }
});
