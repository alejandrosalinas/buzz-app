// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { composerDOMFixture } from "./composer-testing";

composerDOMFixture();
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { EventTemplate } from "nostr-tools";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { LiveCallbacks } from "../relay/live";
import type { RelayEvent } from "../relay/events";
import { createRelaySession } from "../relay/session";
import { keypair, message, metadata, roster, signed } from "../relay/testing";
import { MediaReviewViewer } from "./MediaReviewViewer";
import { ThreadPanel } from "./ThreadPanel";
import { LinkThreadTabContext } from "../conversation/LinkLabelContext";

const owners: ReturnType<typeof createRelaySession>[] = [];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
});

type MediaKind = "image" | "video";
type ReviewFixtureOptions = {
  kind: MediaKind;
  typingAgent?: ReturnType<typeof keypair>;
  openComments?: boolean;
  replies?: (
    viewer: ReturnType<typeof keypair>,
    root: RelayEvent,
  ) => readonly RelayEvent[];
  extraRootTags?: readonly string[][];
  fromThread?: boolean;
  attachmentInReply?: boolean;
  openThreadTab?: () => boolean;
  media?: (url: string) => string | undefined;
};

function mime(kind: MediaKind) {
  return kind === "video" ? "video/mp4" : "image/png";
}

async function setupReview({
  kind,
  typingAgent,
  openComments = true,
  replies: buildReplies = () => [],
  extraRootTags = [],
  fromThread = false,
  attachmentInReply = false,
  openThreadTab,
  media = (url) => url,
}: ReviewFixtureOptions) {
  // The DOM emulator has no playback engine; keep native playback calls observable.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  if (fromThread) {
    // jsdom has no layout observer; the real thread still owns its read lifecycle.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  }
  const viewer = keypair();
  const relay = keypair();
  const attachment = {
    url: `https://fixture.test/${kind}.${kind === "video" ? "mp4" : "png"}`,
    kind,
  };
  const root = message(viewer, "one", `${kind} root`, 1, [
    ...(attachmentInReply
      ? []
      : [["imeta", `url ${attachment.url}`, `m ${mime(kind)}`]]),
    ...extraRootTags,
  ]);
  const attachmentOwner = attachmentInReply
    ? message(viewer, "one", "Video attached inside a reply", 2, [
        ["e", root.id, "", "reply"],
        ["imeta", `url ${attachment.url}`, `m ${mime(kind)}`],
      ])
    : root;
  const replies = [
    ...(attachmentInReply ? [attachmentOwner] : []),
    ...buildReplies(viewer, root),
  ];
  const sign = vi.fn(async (template: EventTemplate) =>
    signed(viewer, template),
  );
  const publish = vi.fn(async () => {});
  const events = [
    root,
    ...replies,
    ...(typingAgent
      ? [
          signed(typingAgent, {
            kind: 0,
            content: JSON.stringify({ name: "Comment agent", is_agent: true }),
            tags: [],
            created_at: 1,
          }),
        ]
      : []),
  ];
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media,
      writer: { sign, publish },
      async query(filters) {
        return filters.flatMap((filter) => {
          if (filter.kinds?.includes(0))
            return events.filter((event) => event.kind === 0);
          if (filter.kinds?.includes(39002) || filter.kinds?.includes(39000))
            return [
              roster(relay, "one", [viewer.pubkey]),
              metadata(relay, "one", "One"),
            ];
          if (filter.ids)
            return events.filter((event) => filter.ids?.includes(event.id));
          if (filter.depth_limit)
            return replies.filter(
              (event) =>
                filter.thread_cursor === undefined ||
                event.created_at > filter.thread_cursor,
            );
          return [];
        });
      },
    },
    { outboxStorage: { load: () => [], save: () => {} } },
  );
  owners.push(owner);
  await owner.session.read([
    { kinds: [39002, 39000], "#d": ["one"], limit: 10 },
  ]);
  const user = userEvent.setup();
  const openReview = vi.fn();
  function Harness() {
    const [selectedTime, setSelectedTime] = useState(72);
    const [selectedId, setSelectedId] = useState(
      fromThread ? undefined : attachmentOwner.id,
    );
    return selectedId ? (
      <MediaReviewViewer
        attachment={attachment}
        session={owner.session}
        scope={`review-${kind}`}
        channelId="one"
        channelName="One"
        messageId={selectedId}
        initialTime={selectedTime}
        hasComments={fromThread}
        close={() => setSelectedId(undefined)}
        onOpenLink={() => false}
      />
    ) : (
      <ThreadPanel
        session={owner.session}
        scope={`review-${kind}`}
        channelId="one"
        channelName="One"
        messageId={root.id}
        close={() => {}}
        onOpenLink={() => false}
        onOpenMediaReview={(id, item, seconds, hasComments) => {
          openReview(id, item, seconds, hasComments);
          setSelectedTime(seconds);
          setSelectedId(id);
        }}
      />
    );
  }
  render(
    <LinkThreadTabContext value={openThreadTab}>
      <Harness />
    </LinkThreadTabContext>,
  );
  if (openComments && !fromThread)
    fireEvent.click(screen.getByRole("button", { name: "Show comments" }));
  return { owner, root, sign, user, attachmentOwner, openReview };
}

function deferredRead() {
  let resolve!: (events: RelayEvent[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<RelayEvent[]>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it.each([
  { firstKind: "image", outcome: "ready" },
  { firstKind: "video", outcome: "ready" },
  { firstKind: "image", outcome: "missing" },
  { firstKind: "image", outcome: "removed" },
] as const)(
  "preserves six-item $firstKind gallery through thread failure (outcome=$outcome)",
  async ({ firstKind, outcome }) => {
    const viewer = keypair();
    const relay = keypair();
    let traffic!: LiveCallbacks;
    const attachments = Array.from({ length: 6 }, (_, index) => ({
      kind: index === 0 || index === 5 ? firstKind : ("image" as const),
      url: `https://fixture.test/item-${index}.${(index === 0 || index === 5) && firstKind === "video" ? "mp4" : "png"}`,
    }));
    const root = message(
      viewer,
      "one",
      "Six attachments",
      1,
      attachments.map((item) => [
        "imeta",
        `url ${item.url}`,
        `m ${mime(item.kind)}`,
      ]),
    );
    let gate: ReturnType<typeof deferredRead> | undefined;
    let events = [root];
    const query = vi.fn(async () => (gate ? gate.promise : events));
    const owner = createRelaySession({
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: (url) => url,
      query,
      subscribe(callbacks) {
        traffic = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    });
    owners.push(owner);
    traffic.receive([roster(relay, "one", [viewer.pubkey], 10)]);
    gate = deferredRead();
    const opener = attachments[3];
    const last = attachments[5];
    assert.exists(opener);
    assert.exists(last);
    render(
      <MediaReviewViewer
        attachment={opener}
        initialAttachments={attachments}
        session={owner.session}
        scope="failed-gallery"
        channelId="one"
        channelName="One"
        messageId={root.id}
        initialTime={0}
        onOpenLink={() => false}
        close={() => {}}
      />,
    );
    const nextLabel = firstKind === "video" ? "Next media" : "Next image";
    const selectedMedia = () =>
      firstKind === "video"
        ? screen.getByRole("dialog").querySelector("video")
        : screen.getByRole("img", { name: "Attachment preview" });
    // The opener's known attachments remain usable while the exact read is still pending.
    expect(
      await screen.findByRole("button", { name: nextLabel }),
    ).toBeEnabled();
    await waitFor(() => expect(query).toHaveBeenCalled());
    await act(async () => gate?.reject(new Error("thread offline")));
    await screen.findByText("Error: thread offline");
    fireEvent.click(screen.getByRole("button", { name: nextLabel }));
    fireEvent.click(screen.getByRole("button", { name: nextLabel }));
    expect(selectedMedia()).toHaveAttribute("src", last.url);
    gate = deferredRead();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(selectedMedia()).toHaveAttribute("src", last.url);
    const edit = (items: typeof attachments, time: number) =>
      signed(viewer, {
        kind: 40003,
        content: root.content,
        created_at: time,
        tags: [
          ["h", "one"],
          ["e", root.id],
          ...items.map((item) => [
            "imeta",
            `url ${item.url}`,
            `m ${mime(item.kind)}`,
          ]),
        ],
      });
    const removed = edit(
      attachments.filter((item) => item.url !== opener.url),
      2,
    );
    const retryGate = gate;
    events =
      outcome === "ready"
        ? [root]
        : outcome === "removed"
          ? [root, removed]
          : [];
    gate = undefined;
    await act(async () => retryGate.resolve(events));
    if (outcome !== "ready") {
      await screen.findAllByText(
        outcome === "removed"
          ? "Attachment unavailable."
          : "Original message unavailable.",
      );
      expect(
        screen.queryByRole("img", { name: "Attachment preview" }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: nextLabel })).toBeNull();
      gate = deferredRead();
      const readsBeforeRetry = query.mock.calls.length;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() =>
        expect(query.mock.calls.length).toBeGreaterThan(readsBeforeRetry),
      );
      expect(
        screen.queryByRole("img", { name: "Attachment preview" }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: nextLabel })).toBeNull();
      const readmission = gate;
      events =
        outcome === "removed" ? [root, removed, edit(attachments, 3)] : [root];
      gate = undefined;
      await act(async () => readmission.resolve(events));
      await screen.findByRole("button", { name: nextLabel });
      return;
    }
    await waitFor(() =>
      expect(
        screen.queryByText("Error: thread offline"),
      ).not.toBeInTheDocument(),
    );
    expect(selectedMedia()).toHaveAttribute("src", last.url);
    await act(async () => traffic.receive([roster(relay, "one", [], 11)]));
    await waitFor(() =>
      expect(
        screen.queryByRole("img", { name: "Attachment preview" }),
      ).toBeNull(),
    );
    expect(screen.getByRole("dialog").querySelector("video")).toBeNull();
    expect(screen.queryByRole("button", { name: nextLabel })).toBeNull();
    expect(
      screen.queryByRole("textbox", { name: "Reply to thread" }),
    ).toBeNull();
  },
);

it("keeps the image gallery reachable when the opened thumbnail is unavailable", async () => {
  await setupReview({
    kind: "image",
    openComments: false,
    media: (url) => (url.endsWith("image.png") ? undefined : url),
    extraRootTags: [
      ["imeta", "url https://fixture.test/next.png", "m image/png"],
    ],
  });
  const next = await screen.findByRole("button", { name: "Next image" });
  fireEvent.click(next);
  expect(
    screen.getByRole("img", { name: "Attachment preview" }),
  ).toHaveAttribute("src", "https://fixture.test/next.png");
});

it("navigates every mixed attachment even after a video fails", async () => {
  await setupReview({
    kind: "video",
    openComments: false,
    extraRootTags: [
      ["imeta", "url https://fixture.test/one.png", "m image/png"],
      ["imeta", "url https://fixture.test/two.png", "m image/png"],
      ["imeta", "url https://fixture.test/three.png", "m image/png"],
      ["imeta", "url https://fixture.test/last.mp4", "m video/mp4"],
    ],
  });
  await screen.findByText("1 / 5");
  const firstVideo = screen.getByRole("dialog").querySelector("video");
  assert.exists(firstVideo);
  fireEvent.error(firstVideo);
  for (let index = 2; index <= 5; index++) {
    fireEvent.click(screen.getByRole("button", { name: "Next media" }));
    await screen.findByText(`${index} / 5`);
    if (index < 5)
      expect(
        screen.getByRole("img", { name: "Attachment preview" }),
      ).toHaveAttribute(
        "src",
        `https://fixture.test/${["one", "two", "three"][index - 2]}.png`,
      );
  }
  expect(screen.getByRole("dialog").querySelector("video")).toHaveAttribute(
    "src",
    "https://fixture.test/last.mp4",
  );
  expect(screen.getByRole("button", { name: "Next media" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Previous media" }));
  await screen.findByText("4 / 5");
});

it("keeps timed reactions on the exact video while moving through a gallery", async () => {
  const firstUrl = "https://fixture.test/video.mp4";
  const secondUrl = "https://fixture.test/second.mp4";
  const { root, sign, user } = await setupReview({
    kind: "video",
    extraRootTags: [["imeta", `url ${secondUrl}`, "m video/mp4"]],
    replies: (viewer, root) => [
      message(viewer, "one", "⏱ 0:11 — first cut", 2, [
        ["e", root.id, "", "reply"],
        ["buzz:media", firstUrl],
      ]),
      message(viewer, "one", "⏱ 0:21 — 😍", 3, [
        ["e", root.id, "", "reply"],
        ["buzz:media", secondUrl],
      ]),
    ],
  });
  const dialog = await screen.findByRole("dialog", { name: "Video review" });
  const firstVideo = dialog.querySelector("video");
  assert.exists(firstVideo);
  Object.defineProperty(firstVideo, "duration", {
    configurable: true,
    value: 60,
  });
  fireEvent.durationChange(firstVideo);
  expect(
    within(dialog).getByRole("button", { name: /^Seek to 0:11,/ }),
  ).toBeVisible();
  expect(
    within(dialog).queryByRole("button", { name: /^Seek to 0:21,/ }),
  ).toBeNull();
  expect(within(dialog).getByRole("button", { name: "0:11" })).toBeVisible();
  expect(within(dialog).queryByRole("button", { name: "0:21" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "Next media" }));
  const secondVideo = dialog.querySelector("video");
  assert.exists(secondVideo);
  Object.defineProperty(secondVideo, "duration", {
    configurable: true,
    value: 60,
  });
  fireEvent.durationChange(secondVideo);

  expect(
    within(dialog).queryByRole("button", { name: /^Seek to 0:11,/ }),
  ).toBeNull();
  expect(
    within(dialog).getByRole("button", { name: /^Seek to 0:21,/ }),
  ).toBeVisible();
  expect(within(dialog).queryByRole("button", { name: "0:11" })).toBeNull();
  expect(within(dialog).getByRole("button", { name: "0:21" })).toBeVisible();
  secondVideo.currentTime = 21;
  await user.click(
    screen.getByRole("button", { name: "React 😍 at current frame" }),
  );
  const event = await signedTemplate(sign);
  expect(event.content).toBe("⏱ 0:21 — 😍");
  expect(event.tags).toEqual(
    expect.arrayContaining([
      ["e", root.id, "", "reply"],
      ["buzz:media", secondUrl],
    ]),
  );
});

async function signedTemplate(sign: ReturnType<typeof vi.fn>) {
  await waitFor(() => expect(sign).toHaveBeenCalled());
  return sign.mock.calls.at(-1)?.[0] as EventTemplate;
}

async function typeAndSend(
  user: ReturnType<typeof userEvent.setup>,
  text: string,
) {
  await user.type(
    await screen.findByRole("textbox", { name: "Reply to thread" }),
    text,
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));
}

it("publishes checked video review comments as time-prefixed kind 9 replies to the root", async () => {
  const { root, sign, user } = await setupReview({ kind: "video" });
  await screen.findByRole("dialog", { name: "Video review" });
  expect(
    await screen.findByRole("checkbox", { name: "Comment at current frame" }),
  ).toBeChecked();

  await typeAndSend(user, "adjust the cut");

  const event = await signedTemplate(sign);
  expect(event.kind).toBe(9);
  expect(event.content).toBe("⏱ 1:12 — adjust the cut");
  expect(event.tags).toEqual(
    expect.arrayContaining([
      ["h", "one"],
      ["e", root.id, "", "reply"],
      ["buzz:media", "https://fixture.test/video.mp4"],
    ]),
  );
});

it("publishes unchecked video review comments without a time prefix", async () => {
  const { root, sign, user } = await setupReview({ kind: "video" });
  await user.click(
    await screen.findByRole("checkbox", { name: "Comment at current frame" }),
  );

  await typeAndSend(user, "plain comment");

  const event = await signedTemplate(sign);
  expect(event.content).toBe("plain comment");
  expect(event.tags).toEqual(
    expect.arrayContaining([["e", root.id, "", "reply"]]),
  );
});

it.each(["pointer", "keyboard"] as const)(
  "pauses video only when %s focus enters the comment composer",
  async (input) => {
    const { user } = await setupReview({ kind: "video" });
    const checkbox = await screen.findByRole("checkbox", {
      name: "Comment at current frame",
    });
    const video = document.querySelector("video");
    assert.exists(video);
    const pause = vi.spyOn(video, "pause");
    if (input === "keyboard") {
      // jsdom has no layout; expose tab stops to the viewer's focus trap.
      vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
        new DOMRect(0, 0, 100, 20),
      ] as unknown as DOMRectList);
    }

    await user.click(checkbox);

    expect(checkbox).toHaveFocus();
    expect(checkbox).not.toBeChecked();
    expect(pause).not.toHaveBeenCalled();

    const composer = screen.getByRole("textbox", { name: "Reply to thread" });
    if (input === "keyboard") await user.tab();
    else await user.click(composer);

    expect(composer).toHaveFocus();
    expect(pause).toHaveBeenCalledOnce();
  },
);

it("publishes image review comments as plain replies without a frame checkbox", async () => {
  const { root, sign, user } = await setupReview({ kind: "image" });
  await screen.findByRole("dialog", { name: "Image viewer" });
  expect(
    screen.queryByLabelText("Comment at current frame"),
  ).not.toBeInTheDocument();

  await typeAndSend(user, "image note");

  const event = await signedTemplate(sign);
  expect(event.content).toBe("image note");
  expect(event.tags).toEqual(
    expect.arrayContaining([["e", root.id, "", "reply"]]),
  );
});

it("seeks the review video from a timecode reply when the thread has one video", async () => {
  const { user } = await setupReview({
    kind: "video",
    replies: (viewer, root) => [
      message(viewer, "one", "⏱ 0:42 — jump here", 2, [
        ["e", root.id, "", "reply"],
      ]),
    ],
  });
  await screen.findByText("jump here");
  const dialog = await screen.findByRole("dialog", { name: "Video review" });
  const video = dialog.querySelector("video");
  assert.exists(video);
  const play = vi.fn(async () => {});
  const pause = vi.spyOn(video, "pause");
  // jsdom does not implement media playback, so play() needs a test stub.
  Object.defineProperty(video, "play", { configurable: true, value: play });

  await user.click(screen.getByRole("button", { name: "0:42" }));

  // jsdom media time remains at initialTime until the seek handler sets it.
  expect(video.currentTime).toBe(42);
  expect(play).toHaveBeenCalledTimes(1);
  expect(pause).not.toHaveBeenCalled();
});

it.each([
  ["00:00", 2, 0],
  ["00:01", 2, 0],
  ["00:03", 10, 0],
  ["00:42.5", 60, 39.5],
])(
  "opens a thread timestamp %s with three seconds of context (duration %s)",
  async (timestamp, duration, expectedTime) => {
    const { user, attachmentOwner, openReview } = await setupReview({
      kind: "video",
      fromThread: true,
      attachmentInReply: true,
      replies: (viewer, root) => [
        message(viewer, "one", `[${timestamp}] Seek the reply video`, 3, [
          ["e", root.id, "", "reply"],
        ]),
      ],
    });
    expect(await screen.findByText("Seek the reply video")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: timestamp }));
    expect(openReview).toHaveBeenCalledExactlyOnceWith(
      attachmentOwner.id,
      expect.objectContaining({ kind: "video" }),
      expectedTime,
      true,
    );
    const dialog = await screen.findByRole("dialog", { name: "Video review" });
    const video = dialog.querySelector("video");
    assert.exists(video);
    Object.defineProperty(video, "duration", {
      configurable: true,
      value: duration,
    });
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(expectedTime);
  },
);

it("keeps thread timestamps noninteractive when a reply video conflicts with a root video", async () => {
  const { openReview } = await setupReview({
    kind: "video",
    fromThread: true,
    attachmentInReply: true,
    extraRootTags: [
      ["imeta", "url https://fixture.test/other.mp4", "m video/mp4"],
    ],
    replies: (viewer, root) => [
      message(viewer, "one", "[00:42.5] Ambiguous target", 3, [
        ["e", root.id, "", "reply"],
      ]),
    ],
  });
  expect(await screen.findByText("Ambiguous target")).toBeVisible();
  expect(screen.getByText("00:42.5").tagName).toBe("SPAN");
  expect(screen.queryByRole("button", { name: "00:42.5" })).toBeNull();
  expect(openReview).not.toHaveBeenCalled();
});

it("keeps root-parented legacy timecodes visible across a reply-video gallery", async () => {
  const { user } = await setupReview({
    kind: "video",
    attachmentInReply: true,
    extraRootTags: [
      ["imeta", "url https://fixture.test/other.mp4", "m video/mp4"],
    ],
    replies: (viewer, root) => [
      message(viewer, "one", "⏱ 0:42 — legacy comment", 3, [
        ["e", root.id, "", "reply"],
      ]),
    ],
  });
  const dialog = await screen.findByRole("dialog", { name: "Video review" });
  const firstVideo = dialog.querySelector("video");
  assert.exists(firstVideo);
  Object.defineProperty(firstVideo, "duration", {
    configurable: true,
    value: 60,
  });
  fireEvent.durationChange(firstVideo);
  expect(within(dialog).getByRole("button", { name: "0:42" })).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Next media" }));
  const secondVideo = dialog.querySelector("video");
  assert.exists(secondVideo);
  Object.defineProperty(secondVideo, "duration", {
    configurable: true,
    value: 60,
  });
  fireEvent.durationChange(secondVideo);
  expect(within(dialog).getByRole("button", { name: "0:42" })).toBeVisible();
});

it.each([false, true])(
  "seeks the selected full-viewer video with multiple videos (thread entry: %s)",
  async (fromThread) => {
    const { user } = await setupReview({
      kind: "video",
      fromThread,
      extraRootTags: [
        ["imeta", "url https://fixture.test/other.mp4", "m video/mp4"],
      ],
      replies: (viewer, root) => [
        message(viewer, "one", "⏱ 0:42 — keep text", 2, [
          ["e", root.id, "", "reply"],
        ]),
      ],
    });
    expect(await screen.findByText("keep text")).toBeVisible();
    if (fromThread) {
      expect(screen.getByText("0:42").tagName).toBe("SPAN");
      expect(screen.queryByRole("button", { name: "0:42" })).toBeNull();
      const expand = screen.getAllByRole("button", {
        name: "Open video fullscreen",
      })[0];
      assert.exists(expand);
      await user.click(expand);
    }
    const dialog = await screen.findByRole("dialog", { name: "Video review" });
    const video = dialog.querySelector("video");
    assert.exists(video);
    Object.defineProperty(video, "duration", {
      configurable: true,
      value: 100,
    });
    fireEvent.durationChange(video);
    await user.click(within(dialog).getByRole("button", { name: "0:42" }));
    expect(video.currentTime).toBe(42);
    video.currentTime = 1;
    await user.click(
      within(dialog).getByRole("button", { name: /^Seek to 0:42,/ }),
    );
    expect(video.currentTime).toBe(42);
  },
);

it.each(["[00:42.5]", "[00:42.5]No space", "[00:42.5]\nNew line"])(
  "seeks timestamp-only and compact legacy comments: %s",
  async (content) => {
    const { user } = await setupReview({
      kind: "video",
      replies: (viewer, root) => [
        message(viewer, "one", content, 3, [["e", root.id, "", "reply"]]),
      ],
    });
    const chip = await screen.findByRole("button", { name: "00:42.5" });
    await user.click(chip);
    expect(document.querySelector("video")?.currentTime).toBe(42.5);
  },
);

it.each([
  { fromThread: false, attachmentInReply: false },
  { fromThread: true, attachmentInReply: false },
  { fromThread: false, attachmentInReply: true },
  { fromThread: true, attachmentInReply: true },
])(
  "resolves the same comments and reply root from $fromThread thread entry, reply attachment $attachmentInReply",
  async (entry) => {
    const { user, root, sign, attachmentOwner, openReview } = await setupReview(
      {
        kind: "video",
        ...entry,
        replies: (viewer, root) => [
          message(viewer, "one", "[00:42.5] Shared comment", 3, [
            ["e", root.id, "", "reply"],
          ]),
        ],
      },
    );
    if (entry.fromThread) {
      await user.click(
        await screen.findByRole("button", { name: "Open video fullscreen" }),
      );
      expect(openReview).toHaveBeenCalledWith(
        attachmentOwner.id,
        expect.objectContaining({ kind: "video" }),
        0,
        true,
      );
    }
    const dialog = await screen.findByRole("dialog", { name: "Video review" });
    expect(await screen.findByText("Shared comment")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "00:42.5" }));
    expect(dialog.querySelector("video")?.currentTime).toBe(42.5);
    await typeAndSend(user, "Same conversation");
    const event = await signedTemplate(sign);
    if (entry.attachmentInReply) {
      expect(event.tags).toEqual(
        expect.arrayContaining([
          ["e", root.id, "", "root"],
          ["e", attachmentOwner.id, "", "reply"],
        ]),
      );
    } else {
      expect(event.tags).toContainEqual(["e", root.id, "", "reply"]);
    }
  },
);

it("shares legacy fractional timecodes between timeline markers and sidebar and stamps quick reactions", async () => {
  const { user, sign, root } = await setupReview({
    kind: "video",
    replies: (viewer, root) => [
      message(viewer, "one", "[00:42.5] A fractional timestamp comment", 2, [
        ["e", root.id, "", "reply"],
      ]),
    ],
  });
  await screen.findByText("A fractional timestamp comment");
  const video = document.querySelector("video");
  assert.exists(video);
  vi.spyOn(video, "pause").mockImplementation(() => {});
  Object.defineProperty(video, "duration", { configurable: true, value: 100 });
  fireEvent.durationChange(video);
  await user.click(screen.getByRole("button", { name: /^Seek to 00:42.5/ }));
  expect(video.currentTime).toBe(42.5);
  video.currentTime = 1;
  await user.click(screen.getByRole("button", { name: "00:42.5" }));
  expect(video.currentTime).toBe(42.5);
  await user.click(
    screen.getByRole("button", { name: "React 👍 at current frame" }),
  );
  const event = await signedTemplate(sign);
  expect(event.content).toBe("⏱ 0:42 — 👍");
  expect(event.tags).toContainEqual(["e", root.id, "", "reply"]);
  expect(
    await screen.findByRole("button", { name: /^Seek to 0:42,/ }),
  ).toBeInTheDocument();
});

it.each(["image", "video"] as const)(
  "starts an empty %s review with a dark stage and comments closed",
  async (kind) => {
    const { user } = await setupReview({ kind, openComments: false });
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(
        dialog.querySelector('[aria-label="Reply to thread"]'),
      ).not.toBeNull(),
    );
    expect(dialog).not.toHaveAttribute("data-color-mode");
    expect(dialog).not.toHaveClass("dark");
    expect(dialog.parentElement).not.toHaveClass("dark");
    expect(dialog.querySelector("[data-review-stage]")).toHaveAttribute(
      "data-color-mode",
      "dark",
    );
    expect(dialog).toHaveAttribute("data-comments-hidden");
    expect(
      screen.queryByRole("complementary", { name: "Media comments" }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show comments" }));
    const composer = await screen.findByRole("textbox", {
      name: "Reply to thread",
    });
    await user.type(composer, "Keep this draft");
    await user.click(screen.getByRole("button", { name: "Hide comments" }));
    await user.click(screen.getByRole("button", { name: "Show comments" }));
    expect(screen.getByRole("textbox", { name: "Reply to thread" })).toBe(
      composer,
    );
    expect(composer).toHaveTextContent("Keep this draft");
  },
);

it("keeps comment message links inert beneath a host tab opener", async () => {
  const openThreadTab = vi.fn(() => true);
  const target = `buzz://message?channel=one&id=${"a".repeat(64)}`;
  await setupReview({
    kind: "image",
    openComments: false,
    openThreadTab,
    replies: (viewer, root) => [
      message(viewer, "one", `See <${target}>`, 2, [
        ["e", root.id, "", "reply"],
      ]),
    ],
  });
  const comments = await screen.findByRole("region", {
    name: "Media comments",
  });
  const link = await within(comments).findByRole("link");
  expect(link).toHaveAttribute("href", target);
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
  });
  fireEvent(link, event);
  expect(event.defaultPrevented).toBe(false);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(openThreadTab).not.toHaveBeenCalled();
});

it("opens image comments by default when the thread contains replies", async () => {
  await setupReview({
    kind: "image",
    openComments: false,
    replies: (viewer, root) => [
      message(viewer, "one", "Photo feedback", 2, [
        ["e", root.id, "", "reply"],
      ]),
    ],
  });
  expect(await screen.findByText("Photo feedback")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Hide comments" }),
  ).toBeInTheDocument();
});

it.each(["image", "video"] as const)(
  "shows incoming agent typing in %s comments before any reply arrives",
  async (kind) => {
    const typingAgent = keypair();
    const { owner, root } = await setupReview({ kind, typingAgent });
    const agent = typingAgent.pubkey;
    await owner.session.profiles.ensure([agent], "background");
    const typing = [{ pubkey: agent, channelId: "one", threadRootId: root.id }];
    vi.spyOn(owner.session.typing, "snapshot").mockReturnValue(typing);
    // Closing and reopening the comments mounts the real host with the new signal.
    fireEvent.click(screen.getByRole("button", { name: "Hide comments" }));
    fireEvent.click(screen.getByRole("button", { name: "Show comments" }));
    const comments = await screen.findByRole("region", {
      name: "Media comments",
    });
    expect(
      within(comments).getByRole("button", { name: /Activity:.*working/ }),
    ).toBeVisible();
  },
);
