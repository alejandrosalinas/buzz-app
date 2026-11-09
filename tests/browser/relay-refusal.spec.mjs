import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

test.use({ productionBroker: true, historyCounts: { alpha: 1, beta: 1 } });

/** Every refused request is one expected console error, matched by URL. */
function expectRefusals(page, app) {
  app.report.relayFailures = [];
  page.on("response", (response) => {
    if ([401, 403].includes(response.status()))
      app.report.relayFailures.push(response.url());
  });
}
const NO_ACCESS = "You don’t have access to this community";

// A key the community does not admit connects (discovery is public), then
// the relay refuses every signed request with its plain-text NIP-FI denial.
// That is one fact about the whole community: one notice, on every page, with
// what fixes it, not a raw status repeated by every feature that tried to read.
test("a community that refuses this key says so once, with no raw status", async ({
  page,
  app,
}, testInfo) => {
  expectRefusals(page, app);
  app.relay.refuseSigned(403, "authorization denied\n");
  await page.goto(app.origin);
  const notice = page.getByRole("dialog", { name: NO_ACCESS });
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAccessibleDescription(
    "Ask the community’s admin to add you.",
  );
  // Messages only says why it's empty; nothing else offers a retry.
  await expect(
    page.getByRole("main").getByRole("heading", { name: NO_ACCESS }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Check again" })).toHaveCount(
    1,
  );
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expect(page.getByText(/Relay request failed|\(403\)/)).toHaveCount(0);
  await expect(page.getByText("Loading workspaces…")).toHaveCount(0);
  await expect(
    page.getByText("Saved sidebar preferences couldn’t refresh"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "Buzz is having trouble connecting" }),
  ).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("refused.png") });

  // The notice follows the person to another page.
  await openPage(page, "Agents", { connected: false });
  await expect(notice).toBeVisible();

  // Once an admin adds the key, Check again opens the community.
  app.relay.refuseSigned();
  await notice.getByRole("button", { name: "Check again" }).click();
  await openPage(page, "Messages");
  await expect(
    page.getByRole("button", { name: "Beta", exact: true }),
  ).toBeVisible();
  await expect(notice).toHaveCount(0);
});

// A session that was working loses its sign-in: the next read's refusal
// replaces the whole community with one notice. This browser host has no
// sign-in of its own, so the notice says plainly that it can't help.
test("a sign-in that ends mid-session is reported once", async ({
  page,
  app,
}, testInfo) => {
  expectRefusals(page, app);
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  app.relay.refuseSigned(403, "evidence rejected\n");
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  await expect(
    page.getByRole("dialog", {
      name: "This community needs a sign-in Buzz doesn’t support yet",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("main").getByRole("heading", {
      name: "Sign in to open this community",
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expect(page.getByText(/Relay request failed|\(403\)/)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("sign-in-ended.png") });
});

// Browser-only: the broker's upload route answers with its own error code, so
// only its refusal mark carries the relay's reason to the connection.
test("an upload is the first request the community refuses", async ({
  page,
  app,
}) => {
  expectRefusals(page, app);
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const form = page.locator("form").filter({
    has: page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  });
  await expect(form).toBeVisible();
  app.relay.refuseSigned(403, "authorization denied\n", ["/upload"]);
  await form.getByLabel("Choose attachments").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("notes"),
  });
  await expect(page.getByRole("dialog", { name: NO_ACCESS })).toBeVisible();
  await expect(page.getByText(/Relay request failed|\(403\)/)).toHaveCount(0);
});
