import { openChannelDetails } from "./channel-details.mjs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { test, expect } from "./fixture.mjs";

// Full built app + real local broker, signing, session, IndexedDB and rendering.
// Only upstream I/O is modeled: equal 40ms HTTP/EVENT service delay, no live data.
test.use({
  productionBroker: true,
  actionProfile: true,
  threadUnread: true,
  historyCounts: { alpha: 24, beta: 24 },
});

async function measure(button, selector, text = "") {
  return button.evaluate(
    async (button, { selector, text }) => {
      const start = performance.now();
      window.lastActionAt = start;
      button.click();
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`No visible ${selector}`)),
          15000,
        );
        function frame() {
          const node = [...document.querySelectorAll(selector)].find((node) => {
            const bounds = node.getBoundingClientRect();
            const viewport = node
              .closest('[role="region"]')
              ?.getBoundingClientRect();
            return (
              node.textContent.includes(text) &&
              bounds.height > 0 &&
              bounds.bottom > (viewport?.top ?? 0) &&
              bounds.top < (viewport?.bottom ?? innerHeight)
            );
          });
          if (!node) return requestAnimationFrame(frame);
          requestAnimationFrame(() => {
            clearTimeout(timeout);
            resolve();
          });
        }
        requestAnimationFrame(frame);
      });
      return performance.now() - start;
    },
    { selector, text },
  );
}

// Drain actual finite fetch bodies and their dependent work, without a timed sleep.
async function settle(page, app) {
  await expect
    .poll(() =>
      app.relay.sockets.every(
        (socket) =>
          socket.readyState !== 1 ||
          [...socket.routes.keys()].every((id) =>
            app.report.wireFrames.some(
              (frame) => frame[0] === "EOSE" && frame[1] === id,
            ),
          ),
      ),
    )
    .toBe(true);
  await page.waitForFunction(() => window.profileInflight === 0);
  await page.evaluate(async () => {
    let previous = -1;
    while (true) {
      await new Promise(requestAnimationFrame);
      if (!window.profileInflight && previous === window.profileFetchVersion)
        return;
      previous = window.profileInflight ? -1 : window.profileFetchVersion;
    }
  });
}

test("profiles primary actions through production broker and built app", async ({
  page,
  app,
}) => {
  const samples = app.report.measurements;
  await page.addInitScript(() => {
    const fetcher = window.fetch;
    window.actionPublications = [];
    window.profileInflight = 0;
    window.profileFetchVersion = 0;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.name === "events" && value?.operation?.delivery === "seen") {
        const id = value.id;
        this.transaction.addEventListener("complete", () => {
          const entry = window.actionPublications.find((p) => p.id === id);
          if (entry && !entry.confirmed) entry.confirmed = performance.now();
        });
      }
      return put.call(this, value, ...args);
    };
    window.fetch = async (...args) => {
      const path = String(args[0]);
      const init = args[1];
      const publishing = path.endsWith("/publish");
      const event = publishing ? JSON.parse(init.body) : undefined;
      const entry = event && {
        id: event.id,
        kind: event.kind,
        action: window.lastActionAt,
        start: performance.now(),
        transport: "X-Buzz-Live-ID" in init.headers ? "websocket" : "http",
      };
      if (entry) window.actionPublications.push(entry);
      const finite = !path.endsWith("/stream");
      if (finite) {
        window.profileInflight++;
        window.profileFetchVersion++;
      }
      let response;
      try {
        response = await fetcher(...args);
      } catch (error) {
        if (finite) window.profileInflight--;
        throw error;
      }
      if (finite)
        void response
          .clone()
          .arrayBuffer()
          .then(
            () => {
              window.profileInflight--;
            },
            () => {
              window.profileInflight--;
            },
          );
      if (entry) {
        // Observe without delaying the response delivered to the real transport.
        void response
          .clone()
          .json()
          .then(
            (receipt) => {
              entry.receipt = performance.now();
              entry.accepted =
                response.ok &&
                receipt.accepted === true &&
                receipt.event_id === entry.id;
            },
            (error) => {
              entry.receiptError = String(error);
            },
          );
      }
      return response;
    };
  });
  const start = performance.now();
  await page.goto(app.origin);
  const messages = page
    .getByRole("tab", { name: "Messages", exact: true })
    .first();
  await messages.waitFor();
  samples.push({
    action: "shell-navigation-upper-bound",
    ms: performance.now() - start,
  });
  samples.push({
    action: "cold-messages",
    ms: await measure(
      messages,
      '[aria-label="Channel message history"] [data-message-id]',
    ),
  });
  for (const channel of ["alpha", "beta"])
    await expect.poll(() => app.relay.hasRoute("primary", channel)).toBe(true);
  await expect(
    page.getByRole("dialog", {
      name: "Buzz is having trouble connecting",
      exact: true,
    }),
  ).toHaveCount(0);
  await settle(page, app);
  // Warm barrier is positive signed catch-up, not a sleep/request-count snapshot.
  const marker = app.append("primary", "beta", "Profile warm barrier");
  const beta = page.locator('button[data-channel-id="beta"]');
  samples.push({
    action: "first-beta",
    ms: await measure(
      beta,
      `[aria-label="Channel message history"] [data-message-id="${marker.id}"]`,
    ),
  });
  await settle(page, app);
  for (const channel of ["alpha", "beta", "alpha"]) {
    const id = app.histories.get(`primary/${channel}`).at(-1).id;
    samples.push({
      action: "warm-channel",
      channel,
      ms: await measure(
        page.locator(`button[data-channel-id="${channel}"]`),
        `[aria-label="Channel message history"] [data-message-id="${id}"]`,
      ),
    });
  }
  await settle(page, app);
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Thread root 1");
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${root.id}"]`,
  );
  for (const temperature of ["cold", "reopen"]) {
    samples.push({
      action: `thread-${temperature}`,
      ms: await measure(
        row.getByRole("button", { name: /^View thread:/ }),
        '[aria-label="Thread messages"]',
        "Unread reply 1",
      ),
    });
    await page
      .locator(
        '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"]), button[aria-label="Close thread"]',
      )
      .click();
  }
  await settle(page, app);
  const draft = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await draft.fill("Profile message");
  const send = page.getByRole("button", { name: "Send message", exact: true });
  samples.push({
    action: "send-visible-frame",
    ms: await measure(
      send,
      '[aria-label="Channel message history"] [data-message-id]',
      "Profile message",
    ),
  });
  await expect
    .poll(
      () => app.report.publications.filter((p) => p.event.kind === 9).length,
    )
    .toBe(1);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.actionPublications.every((p) => p.accepted && p.confirmed),
      ),
    )
    .toBe(true);
  const sent = app.report.publications.find((p) => p.event.kind === 9).event;
  await expect
    .poll(() =>
      app.report.queries.some(({ filter }) => filter.ids?.includes(sent.id)),
    )
    .toBe(true);
  await row.getByRole("button", { name: "Add reaction", exact: true }).click();
  const search = page.locator('em-emoji-picker input[type="search"]');
  await search.fill("grinning");
  const emoji = page.getByRole("button", { name: "😀", exact: true });
  await expect(emoji).toBeVisible();
  // Shadow DOM action cannot use document.querySelector for its trigger, but the
  // visible result lives in the actual channel row.
  samples.push({
    action: "reaction-visible-frame",
    ms: await measure(
      emoji,
      `[data-channel-timeline] [data-message-id="${root.id}"] span`,
      "😀",
    ),
  });
  await expect
    .poll(
      () => app.report.publications.filter((p) => p.event.kind === 7).length,
    )
    .toBe(1);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.actionPublications.every((p) => p.accepted && p.confirmed),
      ),
    )
    .toBe(true);
  await row.getByRole("button", { name: /^View thread:/ }).click();
  await page
    .getByRole("textbox", { name: "Reply to thread", exact: true })
    .fill("Profile reply");
  samples.push({
    action: "reply-visible-frame",
    ms: await measure(
      page
        .getByRole("complementary", { name: "Thread", exact: true })
        .getByRole("button", { name: "Send message", exact: true }),
      '[aria-label="Thread messages"] [data-message-id]',
      "Profile reply",
    ),
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.actionPublications.length === 3 &&
          window.actionPublications.every((p) => p.accepted && p.confirmed),
      ),
    )
    .toBe(true);
  await page
    .locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"]), button[aria-label="Close thread"]',
    )
    .click();
  const reconnectAt = performance.now();
  app.relay.disconnect("primary");
  await expect.poll(() => app.relay.hasRoute("primary", "alpha")).toBe(true);
  // Fresh traffic proves recovery reached the browser, not merely a socket REQ.
  const recovered = app.append("primary", "alpha", "Profile recovery barrier");
  await expect(
    page.locator(`[data-channel-timeline] [data-message-id="${recovered.id}"]`),
  ).toBeVisible();
  samples.push({
    action: "reconnect-upper-bound",
    ms: performance.now() - reconnectAt,
  });
  await draft.fill("Profile after reconnect");
  samples.push({
    action: "reconnected-send-visible-frame",
    ms: await measure(
      send,
      '[aria-label="Channel message history"] [data-message-id]',
      "Profile after reconnect",
    ),
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.actionPublications.length === 4 &&
          window.actionPublications.every((p) => p.accepted && p.confirmed),
      ),
    )
    .toBe(true);
  await settle(page, app);
  // Finite-fetch quiescence excludes reading dwell and the five-second sync
  // timer. Establish the same explicit mark-through outcome on both arms, then
  // observe durable reconciliation. This is outside the primary-action timings.
  await openChannelDetails(page);
  await page.getByText("Diagnostics", { exact: true }).click();
  await page
    .getByRole("button", {
      name: "Mark read through loaded messages",
      exact: true,
    })
    .click();
  const readSyncAt = performance.now();
  await expect
    .poll(async () => {
      app.report.readJournals = await page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open("buzz-read-state-v1");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          return await new Promise((resolve, reject) => {
            const request = db
              .transaction("partitions", "readonly")
              .objectStore("partitions")
              .getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        } finally {
          db.close();
        }
      });
      return (
        app.report.readPublications.length > 0 &&
        app.report.readJournals.some(
          (journal) => journal.state.frontiers.alpha > 0,
        ) &&
        app.report.readJournals.every(
          (journal) =>
            journal.acceptedRevision === journal.revision && !journal.pending,
        )
      );
    })
    .toBe(true);
  await settle(page, app);
  app.report.readSyncBoundaryWaitMs = performance.now() - readSyncAt;
  app.report.actionPublications = await page.evaluate(
    () => window.actionPublications,
  );
  expect(app.report.actionPublications).toHaveLength(4);
  expect(new Set(app.report.publications.map((p) => p.event.id)).size).toBe(4);
  expect(app.report.publications).toHaveLength(4);
  for (const [index, entry] of app.report.actionPublications.entries()) {
    const name = ["send", "reaction", "reply", "reconnected-send"][index];
    samples.push({
      action: `${name}-publish-to-receipt`,
      ms: entry.receipt - entry.start,
    });
    samples.push({
      action: `${name}-action-to-receipt`,
      ms: entry.receipt - entry.action,
    });
    samples.push({
      action: `${name}-action-to-confirmed-journal`,
      ms: entry.confirmed - entry.action,
    });
  }
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
  app.report.relayTimings = JSON.parse(
    await readFile(await (await download).path(), "utf8"),
  );
  app.report.profile = {
    upstreamDelayMs: 40,
    receiptLane:
      "No live publication echo: receipt with finite-read reconciliation; concurrent thread history may confirm before the dedicated ID query",
    visible:
      "Programmatic DOM click -> geometric intersection -> next animation frame; thread samples match the container containing text, not reply-row visibility; not native paint",
    counts: {
      broker: app.report.brokerRequests.length,
      queryFilters: app.report.queries.length,
      publications: app.report.publications.length,
      sockets: app.relay.sockets.length,
      liveRequests: app.relay.requests.length,
    },
    hashes: Object.fromEntries(
      await Promise.all(
        [
          "tests/browser/websocket-actions.profile.mjs",
          "tests/browser/fixture.mjs",
          "tests/browser/policy-relay.mjs",
          "tests/browser/build.mjs",
          "pnpm-lock.yaml",
          "browser-host/relay-broker.mjs",
          "src/features/relay/transport.ts",
          "src/features/relay/live.ts",
          "src/features/relay/broker-live.ts",
          "src/features/relay/http-admission.ts",
          "src/features/relay/host-admission.ts",
          "src/features/relay/events.ts",
        ].map(async (path) => [
          path,
          createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
        ]),
      ),
    ),
  };
  await page.screenshot({ path: test.info().outputPath("actions.png") });
});
