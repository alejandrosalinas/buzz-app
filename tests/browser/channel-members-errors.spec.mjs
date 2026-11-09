import { createHash } from "node:crypto";
import { getPublicKey } from "nostr-tools";
import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

const channelId = "11111111-1111-4111-8111-111111111111";
const keyFor = (name) =>
  new Uint8Array(
    createHash("sha256").update(`members-errors:${name}`).digest(),
  );
const members = Array.from(
  { length: 60 },
  (_, i) => `Sam ${String(i + 1).padStart(2, "0")}`,
);
test.use({
  productionBroker: true,
  channelLifecycle: true,
  lifecycleRole: "owner",
  historyCounts: { alpha: 1, beta: 0 },
  sessionMembers: {
    [channelId]: members.map((name) => getPublicKey(keyFor(name))),
  },
});

// Browser-only: whether the dialog body keeps hidden scroll overflow, and
// whether inserting an alert above a long, highlighted list scrolls it, are
// layout and scroll-anchoring behaviour jsdom cannot model.
test("member action errors stay in view above a long roster", async ({
  page,
  app,
}) => {
  for (const name of [...members, "Sam"])
    app.serveProfile(keyFor(name), { name });
  await page.route("**/api/relay/**", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    if (
      /\/publish$/.test(request.url()) &&
      request.postDataJSON()?.kind === 9000
    ) {
      return route.fulfill({
        json: {
          accepted: false,
          event_id: request.postDataJSON().id,
          message:
            "blocked: you are not allowed to add members to this channel",
        },
      });
    }
    if (/\/direct-message$/.test(request.url()))
      return route.fulfill({
        json: { channelId: "99999999-9999-4999-8999-999999999999" },
      });
    return route.fallback();
  });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "Lifecycle channel", exact: true })
    .click();
  await page.getByRole("button", { name: /^Manage members of / }).click();
  const dialog = page.getByRole("dialog", {
    name: "Manage members",
    exact: true,
  });
  const list = dialog.getByRole("region", { name: "Member list", exact: true });
  const search = dialog.getByRole("searchbox");
  await expect(
    list.getByRole("heading", { name: "People · 61", exact: true }),
  ).toBeVisible();
  await expect(list.getByRole("listitem")).toHaveCount(50);
  // Root cause: the pager's positioned sr-only text must not give the
  // overflow: hidden dialog body anything to scroll.
  expect(
    await list.evaluate((node) => {
      const body = node.closest(".buzz-dialog-body");
      return body.scrollHeight - body.clientHeight;
    }),
  ).toBe(0);

  // The exact match is highlighted at the bottom of the results and scrolled into view.
  await search.click();
  await page.keyboard.type("Sam");
  const add = list
    .getByRole("region", { name: "Not in this channel", exact: true })
    .getByRole("button", { name: /^Add Sam \(.*\)$/ });
  await expect(add).toBeVisible();
  await expect(list.getByRole("listitem")).toHaveCount(50);
  await add.click();
  const refusal = dialog
    .getByRole("alert")
    .filter({ hasText: "not allowed to add members" });
  await expect(refusal).toHaveText(
    /^Sam: blocked: you are not allowed to add members/,
  );
  await expect(list.getByRole("alert")).toHaveCount(0);
  await expect(refusal).toBeInViewport({ ratio: 1 });
  await expect(search).toBeInViewport({ ratio: 1 });

  await list
    .getByRole("listitem")
    .filter({ hasText: "Sam 02" })
    .getByRole("button", { name: "Actions for Sam 02", exact: true })
    .click();
  await page.getByRole("menuitem", { name: /^Send message/ }).click();
  const failure = dialog
    .getByRole("alert")
    .filter({ hasText: "participants could not be confirmed" });
  await expect(failure).toBeVisible();
  await expect(refusal).toBeInViewport({ ratio: 1 });
  await expect(failure).toBeInViewport({ ratio: 1 });
  await expect(search).toBeInViewport({ ratio: 1 });
});
