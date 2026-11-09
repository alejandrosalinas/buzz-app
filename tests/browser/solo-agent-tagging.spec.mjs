import { test, expect } from "./fixture.mjs";
import { INVENTORY_KINDS } from "../../src/features/agents/relay-library.ts";

const chat = "33333333-3333-4333-8333-333333333333";
const team = "44444444-4444-4444-8444-444444444444";
// Browser-only: the real reader schedules the broker's read-state snapshot
// against the owner inventory read that Solo tagging waits for, and the real
// composer seeds its pill from the resulting agent choices. A longer snapshot
// deadline (#2627) left the pill empty behind "Retry agents" while every Node
// test of the reader, the inventory and seeding stayed green (#2751).
test.use({
  productionBroker: true,
  readState: true,
  channelIds: [chat, team],
  channelNames: { [chat]: "Plan the launch", [team]: "Team" },
  soloChannels: [chat],
  ownSoloChannels: [chat],
  historyCounts: { [chat]: 1, [team]: 1 },
  soloAgentNames: ["Owned Honey"],
});

const query = (request) => request.url().endsWith("/query");
const isSnapshot = (filters) =>
  filters.some((filter) => filter.read_state_snapshot === 1);
// The owner's agent inventory, which Solo needs complete before it tags.
const isInventory = (filters) =>
  filters.some(
    (filter) =>
      filter.kinds?.length === INVENTORY_KINDS.length &&
      INVENTORY_KINDS.every((kind) => filter.kinds.includes(kind)),
  );

test("a Solo chat alone with an agent tags it while a background read-state snapshot is still loading", async ({
  page,
  app,
}) => {
  // Startup's snapshot is a foreground read. After a connection gap, read
  // state has no capacity basis and takes a fresh snapshot in the background,
  // the read that outlasts other reads' deadlines on large accounts. Hold
  // that one until the pill has been decided.
  let gapped = false;
  const held = Promise.withResolvers();
  const gate = Promise.withResolvers();
  // The gap also clears the agent inventory. Refuse its re-read until the
  // snapshot is in flight, so the read the viewer's Retry issues is the one
  // scheduled against it. The library rejects a record from another author
  // outright, with no transport error to retry or log.
  let inventoryAnswered = true;
  let refused = 0;
  const foreign = app.signRelay({
    kind: INVENTORY_KINDS[1],
    created_at: 1,
    tags: [["d", "f".repeat(64)]],
    content: JSON.stringify({ name: "Not yours" }),
  });
  await page.route("**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (isSnapshot(filters)) {
      if (gapped) {
        held.resolve(route.request());
        await gate.promise;
      }
    } else if (isInventory(filters) && !inventoryAnswered) {
      refused++;
      return route.fulfill({ json: [foreign] });
    }
    await route.continue();
  });
  const [agent] = app.soloAgents;
  // The gap leaves the chat's row carrying an unread badge in its name.
  const row = page
    .getByRole("navigation", { name: "Solo conversations" })
    .locator(`[data-solo-channel-id="${chat}"]`);
  const pill = page.getByRole("button", {
    name: `Sending to ${agent.name}. Change agents`,
    exact: true,
  });
  // The composer shows no standing notice (#2948); the failed read offers
  // Retry in its picker. Until the agent's profile loads, the chat cannot
  // tell it is an agent, so the picker opens from the mention button rather
  // than the agent pill. Either is right while the inventory is missing.
  const picker = page.getByRole("button", {
    name: /^(Choose agent|Mention a member)$/,
  });
  const retry = page.getByRole("button", {
    name: "Retry agent list",
    exact: true,
  });
  try {
    const started = page.waitForResponse(
      (response) =>
        query(response.request()) &&
        isSnapshot(response.request().postDataJSON()),
    );
    await page.goto(app.origin);
    await started;
    await expect(row).toBeVisible();
    gapped = true;
    inventoryAnswered = false;
    app.relay.disconnect("primary");
    // A follow-up: switch from the team channel to the Solo chat.
    await row.click();
    await expect(
      page.getByRole("textbox", { name: "Message your agents", exact: true }),
    ).toBeVisible();
    const snapshot = await held.promise;
    expect(snapshot.headers()["x-buzz-read-priority"]).toBe("background");
    // Without complete inventory the chat offers Retry and tags nobody.
    await picker.click();
    await expect(retry).toBeVisible();
    expect(refused).toBeGreaterThan(0);
    await expect(pill).toHaveCount(0);
    // The relay answers again. The snapshot is still running, so this read
    // must not wait for it.
    inventoryAnswered = true;
    await retry.click();
    // Alone with one agent, the composer addresses it without a mention.
    await expect(pill).toBeVisible();
    await expect(retry).toHaveCount(0);
  } finally {
    gate.resolve();
  }
  // The snapshot completing changes nothing about the addressed agent.
  await expect(pill).toBeVisible();
  await expect(retry).toHaveCount(0);
});
