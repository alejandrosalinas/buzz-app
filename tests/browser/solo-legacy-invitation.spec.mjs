import { test, expect } from "./fixture.mjs";
import { generateSecretKey } from "nostr-tools";
import { openPage } from "./navigation.mjs";
import { openChannelDetails } from "./channel-details.mjs";

const chat = "33333333-3333-4333-8333-333333333333";
const channel = "11111111-1111-4111-8111-111111111111";
test.use({
  productionBroker: true,
  channelLifecycle: true,
  channelIds: [channel, chat],
  channelNames: { [channel]: "Project updates", [chat]: "Release planning" },
  soloChannels: [chat],
  ownSoloChannels: [chat],
  historyCounts: { [channel]: 2, [chat]: 2 },
});

async function savedInvitations(page, scope) {
  return page.evaluate(async (scope) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("buzz-outbox-v2", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("events");
        const request = tx
          .objectStore("events")
          .index("scope")
          .getAll(IDBKeyRange.only(scope));
        tx.oncomplete = () =>
          resolve(
            request.result
              .map((entry) => entry.operation)
              .filter((item) => item.event.kind === 9000),
          );
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }, scope);
}

// Browser boundary: restored IndexedDB intent, the real Outbox Retry routing,
// broker reads and signed roster readback must agree across a page reload.
// Expiry/role/concurrency matrices stay in the colocated unit tests.
test("Outbox Retry reconciles a recorded then removed Solo invitation without replaying it", async ({
  page,
  app,
}, info) => {
  const now = Date.now();
  await page.clock.setFixedTime(new Date(now));
  const person = app.serveProfile(generateSecretKey(), { name: "Aria" });
  const original = app.sign({
    kind: 9000,
    created_at: Math.floor(now / 1000) - 899,
    content: "",
    tags: [
      ["h", chat],
      ["p", person.pubkey],
    ],
  });
  await page.addInitScript(
    ({ scope, original }) => {
      localStorage.setItem(
        `buzz-outbox-v1:${scope}`,
        JSON.stringify([
          { event: original, signed: original, delivery: "unknown" },
        ]),
      );
    },
    { scope: `https://primary.example:${app.viewer}`, original },
  );
  const publications = [];
  let joined = false;
  let checkingRecovery = false;
  let membershipReads = 0;
  let releaseRoster;
  const heldRoster = new Promise((resolve) => {
    releaseRoster = resolve;
  });
  await page.route("**/api/relay/**/publish", async (route) => {
    const event = route.request().postDataJSON();
    if (event.kind !== 9000) return route.continue();
    expect(event.id).not.toBe(original.id);
    expect(event.tags).toContainEqual(["role", "member"]);
    publications.push(event);
    joined = true;
    await route.fulfill({
      json: { accepted: true, event_id: event.id, message: "" },
    });
  });
  await page.route("**/api/relay/**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (
      filters.some(
        (filter) => filter.kinds?.includes(0) && filter.search === "Aria",
      )
    )
      return route.fulfill({ json: [person] });
    // The legacy command was applied, then the target was removed. Recording
    // that ID changes the receipt to Seen during the real Retry operation.
    if (
      filters.some(
        (filter) =>
          filter.kinds?.includes(9000) && filter.ids?.includes(original.id),
      )
    )
      return route.fulfill({ json: [original] });
    if (!filters.some((filter) => filter.kinds?.includes(39002)))
      return route.continue();
    if (
      checkingRecovery &&
      filters.some(
        (filter) =>
          filter.kinds?.includes(39002) && filter["#d"]?.includes(chat),
      )
    ) {
      membershipReads++;
      // Hold fresh reconciliation while the original remains recoverable.
      if (membershipReads === 2) {
        await heldRoster;
      }
    }
    const response = await route.fetch();
    const events = await response.json();
    await route.fulfill({
      json: events.map((event) =>
        event.kind === 39002 &&
        event.tags.some(([key, value]) => key === "d" && value === chat)
          ? app.signRelay({
              ...event,
              created_at: Math.floor(now / 1000) + (joined ? 1 : 0),
              tags: [
                ...event.tags,
                ...(joined ? [["p", person.pubkey, "", "member"]] : []),
              ],
            })
          : event,
      ),
    });
  });
  const panel = page.getByRole("complementary", {
    name: "Channel settings",
    exact: true,
  });
  const summary = panel.locator("summary").filter({ hasText: /^Outbox ·/ });
  const outbox = summary.locator("..");
  for (const mode of ["dark", "light"]) {
    await page.goto(app.origin);
    await page.evaluate(
      (mode) => localStorage.setItem("buzz-appearance.v1", mode),
      mode,
    );
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await openPage(page, "Messages");
    await page
      .getByRole("button", { name: "Project updates", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", {
        name: "Message #Project updates",
        exact: true,
      }),
    ).toBeVisible();
    await openChannelDetails(page);
    await panel.getByText("Diagnostics", { exact: true }).click();
    await summary.click();
    await expect(summary).toHaveText("Outbox · 1 items");
    await outbox.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(outbox.getByRole("alert")).toContainText(
      "15-minute delivery window",
    );
    expect(publications).toHaveLength(0);
    if (info.project.name === "chromium")
      await outbox.screenshot({
        path: info.outputPath(`SOLO_LEGACY_WAIT_${mode}.png`),
      });
  }
  await page.clock.setFixedTime(new Date(now + 2000));
  checkingRecovery = true;
  await outbox.getByRole("button", { name: "Retry", exact: true }).click();
  try {
    await expect.poll(() => membershipReads).toBe(2);
    expect(publications).toHaveLength(0);
    await expect(summary).toHaveText("Outbox · 1 items");
    const saved = await savedInvitations(
      page,
      `https://primary.example:${app.viewer}`,
    );
    expect(
      saved.find((item) => item.event.id === original.id)?.acknowledged,
    ).toBeFalsy();
  } finally {
    releaseRoster();
  }
  await expect
    .poll(async () => {
      const saved = await savedInvitations(
        page,
        `https://primary.example:${app.viewer}`,
      );
      return saved.find((item) => item.event.id === original.id)?.acknowledged;
    })
    .toBe(true);
  await expect(summary).toHaveText("Outbox · 0 items");
  await expect(outbox.getByRole("alert")).toHaveCount(0);
  expect(publications).toHaveLength(0);
  await page.reload();
  await openPage(page, "Messages");
  await page
    .getByRole("button", { name: "Project updates", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", {
      name: "Message #Project updates",
      exact: true,
    }),
  ).toBeVisible();
  await openChannelDetails(page);
  await expect(summary).toHaveText("Outbox · 0 items");
  expect(publications).toHaveLength(0);

  // Only an explicit People Add may re-invite the removed person.
  await page.goto(
    `${app.origin}/#buzz=${encodeURIComponent(
      JSON.stringify({
        version: 1,
        kind: "conversation",
        channelId: chat,
        scope: {
          viewer: app.viewer,
          communityOrigin: "https://primary.example",
        },
      }),
    )}`,
  );
  await expect(
    page.getByRole("button", { name: "Chat actions", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /^Share access to /, exact: true })
    .last()
    .click();
  const access = page.getByRole("dialog", {
    name: "Share access",
    exact: true,
  });
  await access
    .getByRole("searchbox", { name: "Search people and channels" })
    .fill("Aria");
  await access.getByRole("button", { name: /^Add Aria / }).click();
  await expect.poll(() => publications.length).toBe(1);
  // Publication is not completion: observe the actual acknowledgement commit.
  await expect
    .poll(async () => {
      const saved = await savedInvitations(
        page,
        `https://primary.example:${app.viewer}`,
      );
      return saved.find((item) => item.event.id === publications[0].id)
        ?.acknowledged;
    })
    .toBe(true);
  await expect(
    access
      .getByRole("region", { name: "People", exact: true })
      .getByRole("button", { name: "Actions for Aria", exact: true }),
  ).toBeVisible();
  await page.reload();
  await openPage(page, "Messages");
  await page
    .getByRole("button", { name: "Project updates", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", {
      name: "Message #Project updates",
      exact: true,
    }),
  ).toBeVisible();
  await openChannelDetails(page);
  await expect(summary).toHaveText("Outbox · 0 items");
  expect(publications).toHaveLength(1);
});
