import { fileURLToPath } from "node:url";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { test, expect, repeats, timeline } from "./runner.mjs";
import { anchor, expectAnchor, settle, virtuaIdle } from "../timeline.mjs";

// Browser-only: rich content reflows while the real dock animates. The existing
// correctness journeys do not measure that style/layout work at this scale.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  presenceThreadAuthors: 1,
  historyCounts: { alpha: 40, beta: 1 },
});

const replyCount = 120;
const channelDraft = "Keep this channel draft while reviewing the rich thread.";
const threadDraft = "Keep this rich thread reply draft after closing.";
const imagePath = fileURLToPath(
  new URL("../../../public/shell-gradient.png", import.meta.url),
);
const videoPath = fileURLToPath(
  new URL("../../fixtures/message-gallery/assets/sample.mp4", import.meta.url),
);

function populate(app) {
  const authors = Array.from({ length: 12 }, (_, i) => {
    const key = generateSecretKey();
    app.serveProfile(key, {
      name: `Perf ${i < 8 ? "Agent" : "Reader"} ${i}`,
      ...(i < 8 ? { is_agent: true } : {}),
    });
    return key;
  });
  const { root, replies } = app.presenceThread;
  replies.length = 0;
  for (let i = 0; i < replyCount; i++) {
    const variants = [
      "Plain text from the review conversation.",
      "**Release notes** with _emphasis_, ~~removed text~~ and `inlineCode()`.",
      "Follow-ups:\n- [x] check the image\n- [ ] review the clip\n\n| Build | Style | Result |\n| --- | ---: | --- |\n| before | 120 ms | ready |\n| after | 80 ms | ready |",
      "```typescript\nconst results = await loadMessages({ limit: 80 });\nconsole.log(results.length);\n```",
      "> Review feedback\n\nA second paragraph explains the decision.",
      "@Perf Agent 0: [Design notes](https://example.com/design) and https://example.com/review",
      "Image attachment from the review.",
      "Video attachment from the review.",
    ];
    const media =
      i % 8 === 6
        ? ["png", "image/png"]
        : i % 8 === 7
          ? ["mp4", "video/mp4"]
          : null;
    const nested = i % 6 === 3;
    replies.push(
      finalizeEvent(
        {
          kind: 9,
          created_at: root.created_at + i + 20,
          content: `Rich reply ${i}\n${variants[i % variants.length]}`,
          tags: [
            ["h", "alpha"],
            ...(i % 8 === 5 ? [["p", getPublicKey(authors[0])]] : []),
            ...(nested
              ? [
                  ["e", root.id, "", "root"],
                  ["e", replies.at(-1).id, "", "reply"],
                ]
              : [["e", root.id, "", "reply"]]),
            ...(media
              ? [
                  [
                    "imeta",
                    `url https://primary.example/media/perf-${i}.${media[0]}`,
                    `m ${media[1]}`,
                  ],
                ]
              : []),
          ],
        },
        authors[i % authors.length],
      ),
    );
  }
  const participants = authors.map(getPublicKey);
  const summaries = [[root.id, participants, replies.length]];
  for (let i = 0; i < 8; i++) {
    const event = finalizeEvent(
      {
        kind: 9,
        created_at: root.created_at - 1,
        content: `Agent review thread ${i}: **status** and discussion`,
        // Group roots before the target; fresh signing IDs cannot reorder them.
        tags: [
          ["h", "alpha"],
          ["ms", String(500 + i)],
        ],
      },
      authors[i],
    );
    app.histories.get("primary/alpha").push(event);
    summaries.push([event.id, participants.slice(0, 4), 4]);
  }
  return { root, summaries };
}

async function transitions(dock) {
  await dock.evaluate(async (element) => {
    await Promise.allSettled(
      [
        ...element.getAnimations(),
        ...element.parentElement.getAnimations(),
      ].map((animation) => animation.finished),
    );
  });
}

for (const phase of ["open", "close", "reopen"])
  for (let i = 1; i <= repeats; i++)
    test(`thread-${phase}-rich sample ${i}`, async ({ page, app, perf }) => {
      const { root, summaries } = populate(app);
      await page.route("**/api/relay/primary/media?**", (route) => {
        const video = decodeURIComponent(route.request().url()).includes(
          ".mp4",
        );
        return route.fulfill({
          path: video ? videoPath : imagePath,
          contentType: video ? "video/mp4" : "image/png",
        });
      });
      await perf.setup("alpha");
      for (const args of summaries) app.threadSummary(...args);
      const channel = page.locator(timeline("alpha"));
      for (const [id, , count] of summaries)
        await expect(
          channel.locator(`[data-message-id="${id}"]`).getByRole("button", {
            name: new RegExp(`^View thread: ${count} replies`),
          }),
        ).toBeAttached();
      const channelInput = page.getByRole("textbox", {
        name: "Message #Alpha",
        exact: true,
      });
      await channelInput.fill(channelDraft);
      const trigger = channel
        .locator(`[data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ });
      await trigger.scrollIntoViewIfNeeded();
      await virtuaIdle(page, channel);
      await expect(
        channel.locator("[data-message-id]").filter({
          hasText: /Agent review thread \d:/,
        }),
        "all eight auxiliary thread roots are mounted before measurement",
      ).toHaveCount(8);
      const channelRowsAtSetup = await channel
        .locator("[data-message-id]")
        .evaluateAll((rows) => rows.map((row) => row.dataset.messageId));
      const reading = await anchor(page);
      const closedWidth = await channel.evaluate(
        (element) => element.getBoundingClientRect().width,
      );
      const channelGeometry = () =>
        channel.evaluate((element) => ({
          width: element.getBoundingClientRect().width,
          viewport: element.clientHeight,
          height: element.scrollHeight,
          top: element.scrollTop,
          rows: [...element.querySelectorAll("[data-message-id]")].map(
            (row) => [
              row.dataset.messageId,
              row.getBoundingClientRect().y,
              row.getBoundingClientRect().height,
            ],
          ),
        }));
      const thread = page.getByRole("complementary", {
        name: "Thread",
        exact: true,
      });
      const history = thread.getByRole("region", {
        name: "Thread messages",
        exact: true,
      });
      const dock = page.locator("[data-channel-workspace] > [data-panel-dock]");
      const replyInput = thread.getByRole("textbox", {
        name: "Reply to thread",
        exact: true,
      });
      async function open() {
        await trigger.click();
        await expect(history).not.toHaveAttribute("data-positioning");
        await expect(history.locator("[data-message-id]")).toHaveCount(101);
        await expect(
          history.getByRole("link", {
            name: "Open image attachment",
            exact: true,
          }),
        ).toHaveCount(15);
        await expect(
          history.getByRole("button", { name: /^View 1 reply/ }),
        ).toHaveCount(20);
        // Every reply is unread, so each opening starts at the first unread one.
        await expect(
          history.locator("[data-new-messages-boundary]"),
        ).toBeInViewport();
        await expect
          .poll(() =>
            history.evaluate((element) => {
              const bounds = element.getBoundingClientRect();
              return [...element.querySelectorAll("img")].every((image) => {
                const box = image.getBoundingClientRect();
                return (
                  box.bottom <= bounds.top ||
                  box.top >= bounds.bottom ||
                  (image.complete && image.naturalWidth > 0)
                );
              });
            }),
          )
          .toBe(true);
        await expect
          .poll(() =>
            history
              .locator("video")
              .evaluateAll(
                (videos) =>
                  videos.length === 10 &&
                  videos.every(
                    (video) => video.readyState >= 2 && video.videoWidth > 0,
                  ),
              ),
          )
          .toBe(true);
        await transitions(dock);
        await settle(page, history);
      }
      async function close() {
        await page
          .locator(
            '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"]), button[aria-label="Close thread"]',
          )
          .click();
        // PanelDock detaches only after its own and the grid's transitions;
        // immediate closes can already have removed the dock after the click.
        await expect(
          page.locator(
            '[data-channel-workspace] [aria-label="Thread messages"]',
          ),
        ).toHaveCount(0);
        await page.waitForFunction(
          (width) => {
            const element = document.querySelector(
              '[data-channel-timeline="alpha"]',
            );
            return (
              !document.querySelector(
                '[data-channel-workspace] [aria-label="Thread messages"]',
              ) &&
              element &&
              Math.abs(element.getBoundingClientRect().width - width) < 1
            );
          },
          closedWidth,
          { polling: "raf" },
        );
        await virtuaIdle(page, channel);
        await expectAnchor(page, reading);
      }
      if (phase !== "open") {
        await open();
        await replyInput.fill(threadDraft);
        await settle(page, history);
        await virtuaIdle(page, channel);
        if (phase === "reopen") await close();
      }
      const channelBefore = await channelGeometry();
      const auxiliaryRootIds = summaries.slice(1).map(([id]) => id);
      expect(channelBefore.rows.map(([id]) => id)).toEqual(
        expect.arrayContaining(auxiliaryRootIds),
      );
      const sample = await perf.measure("alpha", {
        timeoutMs: 30_000,
        act: phase === "close" ? close : open,
        work: {
          phase,
          replyCount,
          mountedRows: 101,
          participants: 12,
          agentParticipants: 8,
          collapsedNestedReplies: 20,
          images: 15,
          videos: 10,
          auxiliaryThreads: 8,
          mainRootId: root.id,
          auxiliaryRootIds,
          channelRowsAtSetup,
          channelBefore,
        },
      });
      if (phase === "close") {
        sample.work.channelAtEnd = await channelGeometry();
        await virtuaIdle(page, channel);
        sample.work.channelAfterCheck = await channelGeometry();
      }
      await perf.save(sample);
      await expect(channelInput).toHaveText(channelDraft);
      if (phase === "close")
        expect(
          sample.work.channelAfterCheck,
          "no channel reflow after the measurement window",
        ).toEqual(sample.work.channelAtEnd);
      if (phase === "reopen") await expect(replyInput).toHaveText(threadDraft);
    });
