import { test, expect } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";
import { readJournal } from "./reading.mjs";

const channelId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
test.use({
  productionBroker: true,
  channelLifecycle: true,
  lifecycleRole: "guest",
  readState: true,
  channelIds: [channelId, "beta"],
  channelNames: { [channelId]: "Alpha" },
  historyCounts: { [channelId]: 1, beta: 1 },
  sessionMembers: {
    "11111111-1111-4111-8111-111111111111": Array.from(
      { length: 2999 },
      (_, i) => (i + 1).toString(16).padStart(64, "0"),
    ),
  },
});

// Browser boundary: real guest-channel opening, focused timeline dwell, durable
// IndexedDB read intent and the sidebar badge. The 3,000-member roster protects
// the reported scale; the post predates the viewer's signed membership.
for (const entry of ["sidebar", "search"]) {
  test(`opening a joined guest channel from ${entry} reads its welcome post`, async ({
    page,
    app,
  }) => {
    const id = "11111111-1111-4111-8111-111111111111";
    const post = app.signRelay({
      kind: 9,
      tags: [["h", id]],
      content: "Welcome to the announcements channel",
      created_at: 1699999900,
    });
    app.histories.set(`primary/${id}`, [post]);
    await open(page, app, { cold: true });
    const channel = page.getByRole("button", { name: /^Lifecycle channel/ });
    await expect(channel.locator("[data-channel-unread]")).toHaveCount(1);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let requested = false;
    await page.route("**/query", async (route) => {
      const filters = route.request().postDataJSON();
      // Search's preview of the highlighted channel reads it too; hold that
      // read so the channel still opens on its own pending read.
      if (filters.some((filter) => filter["#h"]?.includes(id))) {
        if (
          filters.some(
            (filter) => filter.top_level && filter["#h"]?.includes(id),
          )
        )
          requested = true;
        await gate;
      }
      await route.continue();
    });
    try {
      if (entry === "sidebar") await channel.click();
      else {
        await page
          .getByRole("button", { name: "Search Buzz", exact: true })
          .click();
        const search = page.getByRole("dialog", {
          name: "Search Buzz",
          exact: true,
        });
        await search
          .getByRole("combobox", { name: "Search Buzz" })
          .fill("Lifecycle channel");
        await search.getByRole("option", { name: /Lifecycle channel/ }).click();
        await expect(search).toHaveCount(0);
      }
      await expect.poll(() => requested).toBe(true);
      await expect(
        page.getByRole("status").filter({ hasText: "Loading messages…" }),
      ).toBeVisible();
    } finally {
      release();
    }
    await expect(
      page.getByRole("region", { name: "Read-only channel" }),
    ).toBeVisible();
    await settle(page);
    await expect(
      page.getByRole("region", { name: "Channel message history" }),
    ).toBeFocused();
    await expect
      .poll(async () => (await readJournal(page))?.state.frontiers[id])
      .toBe(post.created_at);
    await expect(channel.locator("[data-channel-unread]")).toHaveCount(0);
  });
}
