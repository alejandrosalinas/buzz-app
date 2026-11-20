import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ productionBroker: true });

// Browser-only: the production broker forwards the combined profile and
// status read to the modeled relay, and the row renders what that one read
// returned.
test("a new author's status arrives with their name, and their row reads nothing more", async ({
  page,
  app,
}) => {
  await open(page, app);
  const key = generateSecretKey();
  const author = getPublicKey(key);
  app.serveProfile(key, { name: "Newcomer" });
  app.serveStatus(key, "🐝", "Buzzing");
  const event = finalizeEvent(
    {
      kind: 9,
      created_at: Math.floor(Date.now() / 1000),
      content: "First post",
      tags: [["h", "alpha"]],
    },
    key,
  );
  app.relay.publish("primary", event);
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  await expect(row.getByText("Newcomer", { exact: true })).toBeVisible();
  await expect(row.getByRole("img", { name: /Buzzing/ })).toBeVisible();
  const reads = (kind) =>
    app.report.queries.filter(
      ({ filter }) =>
        filter.kinds?.includes(kind) && filter.authors?.includes(author),
    );
  // The status rode the profile read: one of each, sent together.
  await expect.poll(() => reads(0).length).toBe(1);
  expect(reads(30315)).toHaveLength(1);
  expect(reads(30315)[0].at).toBeCloseTo(reads(0)[0].at, 0);
});
