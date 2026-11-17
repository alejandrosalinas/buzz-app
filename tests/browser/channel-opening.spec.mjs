import { openChannelDetails } from "./channel-details.mjs";
import { readFile } from "node:fs/promises";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  productionBroker: true,
  largeSidebar: true,
  historyCounts: { alpha: 20, beta: 20 },
});
const heads = (app, channel) =>
  app.report.queries.filter(
    ({ filter }) =>
      filter.kinds?.includes(9) &&
      filter.top_level === true &&
      filter["#h"]?.includes(channel) &&
      filter.until === undefined,
  );

test("cold opening bypasses held DM labels; warm switching paints without a head read", {
  tag: "@local-webkit",
}, async ({ page, app }) => {
  const submittedHeads = [];
  page.on("request", (request) => {
    if (!new URL(request.url()).pathname.endsWith("/query")) return;
    for (const filter of request.postDataJSON() ?? [])
      if (
        filter.kinds?.includes(9) &&
        filter.top_level === true &&
        filter.until === undefined
      )
        submittedHeads.push(filter);
  });
  const labelReads = () =>
    app.report.queries.filter(
      ({ filter }) =>
        filter.kinds?.includes(0) &&
        filter.authors?.some((id) => app.participants.includes(id)),
    );
  app.relay.holdProfiles(app.participants);
  app.relay.holdEose("alpha");
  app.relay.holdEose("beta");
  // Establish a cold target deterministically: let the actual label read own
  // the background slot before preferences release the roster warmer. Hold the
  // host decoder, not a reader slot; demand and all production owners stay real.
  const preferences = Promise.withResolvers();
  let preferencesPending = false;
  await page.route("**/sidebar-preferences", async (route) => {
    preferencesPending = true;
    await preferences.promise;
    await route.fallback();
  });
  // A visible pre-establishment head is not a warm, verified cache. A signed
  // missed message proves the catch-up reached the UI, not merely the broker.
  try {
    await open(page, app);
    expect(heads(app, "alpha")).toHaveLength(1);
    const missed = Object.fromEntries(
      ["alpha", "beta"].map((channel) => [
        channel,
        app.append("primary", channel, "Startup catch-up marker", false),
      ]),
    );
    // Alpha and Beta may share one wire and therefore one EOSE. Release both
    // holds; Alpha catches up, while the still-unopened Beta remains cold.
    app.relay.releaseEose("alpha");
    app.relay.releaseEose("beta");
    await expect(
      page.locator(`[data-message-id="${missed.alpha.id}"]`),
    ).toBeVisible();
    expect(heads(app, "alpha")).toHaveLength(2);
    await expect.poll(() => labelReads().length).toBe(1);
    expect(labelReads()[0].filter.authors).toHaveLength(500);
    expect(app.report.profileHolds.some((held) => held.pending)).toBe(true);
    await expect.poll(() => preferencesPending).toBe(true);
    const decoded = page.waitForResponse(
      (response) =>
        response.url().endsWith("/sidebar-preferences") && response.ok(),
    );
    preferences.resolve();
    await decoded;
    // The actual label hook has >1,000 missing participants. Keep its profile
    // response held through cold opening; do not bypass that production caller.
    expect(heads(app, "beta")).toHaveLength(0);
    await page
      .getByRole("button", { name: "Beta", exact: true })
      .evaluate((button) => {
        performance.mark("cold-beta-click");
        button.click();
      });
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    await expect(page.locator("[data-message-id]").first()).toBeVisible();
    app.report.measurements.push({
      name: "Beta",
      coldVisibleUpperBoundMs: await page.evaluate(
        () =>
          performance.now() -
          performance.getEntriesByName("cold-beta-click").at(-1).startTime,
      ),
      note: "Includes Playwright visibility assertion roundtrip; warm times use browser paint clock",
    });
    expect(heads(app, "beta").length).toBeGreaterThan(0);
    expect(app.report.profileHolds.some((held) => held.pending)).toBe(true);
    expect(app.report.profileHolds.some((held) => held.aborted)).toBe(false);
    await expect(
      page.locator(`[data-message-id="${missed.beta.id}"]`),
    ).toBeVisible();
    expect(heads(app, "beta")).toHaveLength(1);
    const before = submittedHeads.length;
    const targetMs = 100;
    // Browser-clock click → first visible row → paint, excluding Playwright IPC.
    for (const name of ["Alpha", "Beta", "Alpha", "Beta"]) {
      const timing = await page
        .getByRole("button", { name, exact: true })
        .evaluate(
          async (button, { name, ids }) => {
            const start = performance.now();
            button.click();
            const clickDispatchMs = performance.now() - start;
            const frames = [];
            let firstVisibleMs;
            let paintOpportunity;
            await new Promise((resolve, reject) => {
              const deadline = setTimeout(
                () => reject(new Error("warm switch did not paint")),
                1000,
              );
              const check = (timestamp) => {
                frames.push({
                  frameMs: timestamp - start,
                  callbackMs: performance.now() - start,
                });
                const composer = document.querySelector(
                  `[role="textbox"][aria-label="Message #${name}"]`,
                );
                const history = document.querySelector(
                  '[aria-label="Channel message history"]',
                );
                const rect = history?.getBoundingClientRect();
                const visible =
                  rect &&
                  [...history.querySelectorAll("[data-message-id]")].some(
                    (row) => {
                      const bounds = row.getBoundingClientRect();
                      return (
                        ids.includes(row.dataset.messageId) &&
                        bounds.height > 0 &&
                        bounds.bottom > rect.top &&
                        bounds.top < rect.bottom
                      );
                    },
                  );
                if (!visible || !composer) return requestAnimationFrame(check);
                firstVisibleMs = performance.now() - start;
                requestAnimationFrame((timestamp) => {
                  paintOpportunity = {
                    frameMs: timestamp - start,
                    callbackMs: performance.now() - start,
                  };
                  clearTimeout(deadline);
                  resolve();
                });
              };
              requestAnimationFrame(check);
            });
            const warmVisibleMs = performance.now() - start;
            return {
              warmVisibleMs,
              // Synchronous button.click() only, not all React/render work.
              clickDispatchMs,
              frames,
              firstVisibleMs,
              paintOpportunity,
            };
          },
          {
            name,
            ids: app.histories
              .get(`primary/${name.toLowerCase()}`)
              .map((event) => event.id),
          },
        );
      app.report.measurements.push({ name, ...timing });
      // Surface target misses without truncating samples or functional checks.
      if (timing.warmVisibleMs >= targetMs)
        test.info().annotations.push({
          type: "performance",
          description: `${name} warm switch: ${timing.warmVisibleMs.toFixed(1)}ms (target <${targetMs}ms)`,
        });
    }
    expect(submittedHeads).toHaveLength(before);
    await openChannelDetails(page);
    const diagnostics = page
      .locator("summary")
      .filter({ hasText: /^Relay timings$/ });
    await diagnostics.evaluate((element) => {
      for (
        let parent = element.parentElement;
        parent;
        parent = parent.parentElement
      )
        if (parent.tagName === "DETAILS") parent.open = true;
    });
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export timings" }).click();
    const timings = await download;
    app.report.relayTimings = JSON.parse(
      await readFile(await timings.path(), "utf8"),
    );
    expect(app.report.profileHolds.some((held) => held.pending)).toBe(true);
    expect(app.report.profileHolds.some((held) => held.aborted)).toBe(false);
  } finally {
    preferences.resolve();
    app.relay.releaseEose("alpha");
    app.relay.releaseEose("beta");
    app.relay.releaseProfiles();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test.describe("large thread opening", () => {
  test.use({
    readState: true,
    largeSidebar: false,
    threadUnread: true,
    presenceThreadAuthors: 300,
  });
  test("300-author thread opening retains bounded traversal and measures cold/reopened rendering", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const { root } = app.presenceThread;
    const trigger = page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ });
    const history = page.getByRole("region", {
      name: "Thread messages",
      exact: true,
    });
    for (const phase of ["cold", "reopened"]) {
      const timing = await trigger.evaluate(async (button) => {
        const start = performance.now();
        button.click();
        let firstPaint;
        await new Promise((resolve, reject) => {
          const deadline = setTimeout(
            () => reject(new Error("thread did not finish traversal")),
            10000,
          );
          const check = () => {
            const panel = document.querySelector(
              '[aria-label="Thread messages"]',
            );
            const rows = panel?.querySelectorAll("[data-message-id]");
            const rect = panel?.getBoundingClientRect();
            const visible =
              rect &&
              [...rows].some((row) => {
                const bounds = row.getBoundingClientRect();
                return (
                  bounds.height > 0 &&
                  bounds.bottom > rect.top &&
                  bounds.top < rect.bottom
                );
              });
            if (visible && firstPaint === undefined)
              firstPaint = performance.now() - start;
            if (
              !visible ||
              rows.length !== 301 ||
              panel.textContent.includes("Loading thread…")
            )
              return requestAnimationFrame(check);
            requestAnimationFrame(() => {
              clearTimeout(deadline);
              resolve();
            });
          };
          requestAnimationFrame(check);
        });
        return {
          firstVisibleMs: firstPaint,
          fullTraversalPaintMs: performance.now() - start,
        };
      });
      app.report.measurements.push({
        scenario: "300-author-thread",
        phase,
        ...timing,
      });
      await expect(history.locator("[data-message-id]")).toHaveCount(301);
      // Every reply is unread, so each opening starts at the first unread one.
      await expect(
        history.locator("[data-new-messages-boundary]"),
      ).toBeInViewport();
      await page
        .locator(
          '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"]), button[aria-label="Close thread"]',
        )
        .click();
      await expect(history).toHaveCount(0);
    }
  });
});
