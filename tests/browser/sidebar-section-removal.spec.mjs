import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
// Real app/header portals, caller wiring, row relocation and cold reload through
// the production signing broker. Failure/lifecycle matrices stay in Vitest.
test.use({ productionBroker: true, savedSidebar: true, largeSidebar: false });
test.describe("section removal", () => {
  test.use({
    initialSidebarSort: { "section:work": "recent", channels: "recent" },
  });
  test("confirmed section removal preserves channels and survives reload", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await openPage(page, "Messages");
    const title = "Work";
    const id = "work";
    const channel = "beta";
    const group = page.locator(`[data-sidebar-section="group:${id}"]`);
    const row = page.locator(`[data-channel-id="${channel}"]`);
    await expect(group.locator(`[data-channel-id="${channel}"]`)).toBeVisible();
    await page
      .getByRole("button", { name: `More actions for ${title}` })
      .click();
    await page
      .getByRole("menuitem", { name: "Remove workspace", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: `Remove ${title}?` });
    await expect(dialog).toHaveAccessibleDescription(
      "1 conversation will return to their default sections.",
    );
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: `More actions for ${title}` }),
    ).toBeFocused();
    expect(app.report.sidebarPublications ?? []).toHaveLength(0);
    await expect(group).toBeVisible();
    await group.locator("summary").click();
    await expect(group.locator("details")).not.toHaveAttribute("open");
    await page
      .getByRole("button", { name: `More actions for ${title}` })
      .click();
    await page
      .getByRole("menuitem", { name: "Remove workspace", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Remove workspace", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(group).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "More actions for Team" }),
    ).toBeFocused();
    await expect(
      page.locator(
        `[data-sidebar-section="channels"] [data-channel-id="${channel}"]`,
      ),
    ).toBeVisible();
    await expect(row).toHaveCount(1);
    await expect
      .poll(() => app.report.sidebarPublications?.length ?? 0)
      .toBe(3);
    const reset = app.report.sidebarPublications[0];
    expect(reset.coordinate).toBe("channel-workspace-sort");
    expect(reset.blob.meta.g[`section:${id}`][2]).toBeNull();
    expect(reset.blob.groups).toEqual({ channels: "recent" });
    const filterReset = app.report.sidebarPublications[1];
    expect(filterReset.coordinate).toBe("channel-workspace-filter");
    expect(filterReset.blob.meta.g[`section:${id}`][2]).toBeNull();
    expect(filterReset.blob.groups).toEqual({});
    const { coordinate, blob } = app.report.sidebarPublications.at(-1);
    expect(coordinate).toBe("channel-workspaces");
    expect(blob.removedSections).toContain(id);
    expect(blob.sections.map((section) => section.id)).not.toContain(id);
    expect(blob.assignments).not.toHaveProperty(channel);
    // Persist view intent through the production pagehide owner, then reload.
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    const savedViews = await page.evaluate(() =>
      Object.entries(localStorage)
        .filter(
          ([key]) =>
            key.startsWith("buzz-view.v1:") &&
            JSON.parse(key.slice("buzz-view.v1:".length))[1] ===
              "channel-sidebar",
        )
        .map(([, value]) => JSON.parse(value)),
    );
    expect(savedViews.length).toBeGreaterThan(0);
    for (const view of savedViews)
      expect(view.collapsed).not.toContain(`group:${id}`);
    await page.reload();
    await openPage(page, "Messages");
    await expect(group).toHaveCount(0);
    await expect(
      page.locator(
        `[data-sidebar-section="channels"] [data-channel-id="${channel}"]`,
      ),
    ).toBeVisible();
    await expect(
      page.locator(
        '[data-sidebar-section="starred"] [data-channel-id="alpha"]',
      ),
    ).toBeVisible();
    await row.click();
    await expect(
      page.getByRole("article", { name: "Conversation" }),
    ).toBeVisible();
  });
});
