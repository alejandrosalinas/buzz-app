// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { getPublicKey } from "nostr-tools";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { assert, afterEach, beforeEach, expect, it, vi } from "vitest";
import { foldMessages } from "../relay/fold";
import { createRelaySession } from "../relay/session";
import {
  bounds,
  keypair,
  message,
  metadata,
  roster,
  signed,
} from "../relay/testing";
import { ThreadPanel } from "./ThreadPanel";
import { MediaReviewViewer } from "./MediaReviewViewer";
import { PublishRejected, type OutboxStorage } from "../relay/outbox";
import type { RelayEvent } from "../relay/events";
import type { ComposerInputElement } from "./composer-dom";
import { composerDOMFixture } from "./composer-testing";

composerDOMFixture();

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

it("real ThreadPanel edits its own reply and recovers emoji preparation without losing text", async () => {
  const viewer = keypair(),
    relay = keypair(),
    other = keypair();
  const root = message(other, "channel", "Root message", 10);
  const reply = message(viewer, "channel", "Own reply", 11, [
    ["e", root.id, "", "reply"],
  ]);
  const events = [root, reply];
  let emojiAvailable = false;
  const publish = vi.fn(async () => {});
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: "https://edit.test",
      media: () => undefined,
      query: async (filters) =>
        filters.flatMap((filter) => {
          if (filter.kinds?.includes(30030)) {
            if (!emojiAvailable) throw new Error("Emoji unavailable");
            return [];
          }
          if (filter.kinds?.includes(39002))
            return [roster(relay, "channel", [viewer.pubkey, other.pubkey])];
          if (filter.kinds?.includes(39000))
            return [metadata(relay, "channel", "General")];
          if (filter.ids)
            return events.filter((event) => filter.ids?.includes(event.id));
          if (filter.kinds?.includes(9))
            return [
              ...events,
              bounds(relay, "channel", "head", {
                has_more: false,
                next_cursor: null,
              }),
            ];
          return [];
        }),
      writer: {
        kinds: [9, 40003],
        sign: async (template) => signed(viewer, template),
        publish,
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  try {
    await owner.session.read([
      { kinds: [39002], "#d": ["channel"], limit: 1 },
      { kinds: [39000], "#d": ["channel"], limit: 1 },
    ]);
    render(
      <ThreadPanel
        session={owner.session}
        scope="thread-edit"
        channelName="General"
        channelId="channel"
        messageId={root.id}
        close={() => {}}
        onOpenLink={() => false}
      />,
      { reactStrictMode: true },
    );
    const input = await screen.findByRole<ComposerInputElement>("textbox", {
      name: "Reply to thread",
    });
    // Loaded reply is the barrier: neither root-only state nor a channel window
    // can satisfy this edit target. Removing ThreadPanel's editMessages fails here.
    await screen.findByText("Own reply");
    fireEvent.keyDown(input, { key: "ArrowUp", metaKey: true });
    expect(input).toHaveAccessibleName("Edit message");
    expect(input).toHaveValue("Own reply");
    await waitFor(() =>
      expect(owner.session.emoji.snapshot().status).toBe("error"),
    );
    act(() => {
      input.value = "Revised :party:";
      input.setSelectionRange(15, 15);
    });
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: "Enter" });
    const form = within(screen.getByRole("form", { name: "Edit message" }));
    expect(form.getByRole("alert")).toHaveTextContent(
      "Community emoji isn't ready",
    );
    expect(publish).not.toHaveBeenCalled();
    // The refused edit retried the catalog; recovery is offered once that fails.
    const retry = await screen.findByRole("button", {
      name: "Retry message preparation",
    });
    // The retained refusal stays accurate once that retry has failed.
    expect(form.getByRole("alert")).toHaveTextContent(
      "Community emoji isn't ready. Your draft is kept; try sending again shortly.",
    );
    emojiAvailable = true;
    fireEvent.click(retry);
    await waitFor(() =>
      expect(form.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(input).toHaveValue("Revised :party:");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input).toHaveAccessibleName("Reply to thread"));
    expect(publish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: 40003,
        content: "Revised :party:",
        tags: [
          ["h", "channel"],
          ["e", reply.id],
          ["client-id", expect.any(String)],
        ],
      }),
      expect.anything(),
    );
    expect(input).toHaveValue("");
  } finally {
    cleanup();
    owner.dispose();
  }
});

function editOwner(
  viewer: ReturnType<typeof keypair>,
  events: RelayEvent[],
  storage: OutboxStorage = { load: () => [], save() {} },
  publish: (
    event: RelayEvent,
    signal?: AbortSignal,
  ) => Promise<void> = async () => {},
  exactOnly?: string,
) {
  const relay = keypair();
  return createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: "https://edit.test",
      media: (url) => url,
      query: async (filters) =>
        filters.flatMap((filter) => {
          if (filter.kinds?.includes(39002))
            return [
              roster(relay, "channel", [
                ...new Set(events.map((event) => event.pubkey)),
              ]),
            ];
          if (filter.kinds?.includes(39000))
            return [metadata(relay, "channel", "General")];
          if (filter.ids)
            return events.filter((event) => filter.ids?.includes(event.id));
          if (filter.kinds?.includes(40003) && filter["#e"])
            return events.filter((event) =>
              event.tags.some(
                ([name, id]) =>
                  name === "e" && filter["#e"]?.includes(id ?? ""),
              ),
            );
          if (filter.depth_limit)
            return events.filter(
              (event) =>
                event.id !== exactOnly &&
                event.tags.some(([name]) => name === "e") &&
                (filter.thread_cursor === undefined ||
                  event.created_at > filter.thread_cursor),
            );
          return [];
        }),
      writer: {
        kinds: [9, 40003],
        sign: async (template) => signed(viewer, template),
        publish,
      },
    },
    { outboxStorage: storage },
  );
}

async function authorize(owner: ReturnType<typeof createRelaySession>) {
  await owner.session.read([
    { kinds: [39002], "#d": ["channel"], limit: 1 },
    { kinds: [39000], "#d": ["channel"], limit: 1 },
  ]);
}

it.each(["image", "video"] as const)(
  "%s review edits its own root or latest reply, including a separately retained target",
  async (kind) => {
    // Root fallback, duplicate root/target, and an older exact target must not
    // displace the newer eligible own reply. The real viewer owns the row handoff.
    for (const scenario of [
      "root",
      "reply",
      "exact",
      "exact-older",
      "same-second",
    ] as const) {
      const secret = new Uint8Array(32).fill(1);
      const viewer = { secret, pubkey: getPublicKey(secret) },
        other = keypair();
      const attachment = {
        url: `https://fixture.test/edit.${kind === "image" ? "png" : "mp4"}`,
        kind,
      };
      const mediaTags = [
        [
          "imeta",
          `url ${attachment.url}`,
          `m ${kind}/${kind === "image" ? "png" : "mp4"}`,
        ],
      ];
      const root = message(viewer, "channel", "Own media root", 10, mediaTags);
      const exact = message(viewer, "channel", "Older own exact reply", 11, [
        ["e", root.id, "", "reply"],
        ...mediaTags,
      ]);
      const reply =
        scenario === "same-second"
          ? message(viewer, "channel", "Latest own reply", 10, [
              ["e", root.id, "", "reply"],
              // Fixed fixtures place the reply ID below its same-second root.
              ["nonce", kind === "image" ? "31" : "0"],
            ])
          : message(viewer, "channel", "Latest own reply", 12, [
              ["e", root.id, "", "reply"],
            ]);
      if (scenario === "same-second")
        expect(reply.id.localeCompare(root.id)).toBeLessThan(0);
      const foreign = message(other, "channel", "Newer other reply", 13, [
        ["e", root.id, "", "reply"],
      ]);
      const events =
        scenario === "root"
          ? [root, foreign]
          : scenario === "same-second"
            ? [root, reply, foreign]
            : scenario === "exact"
              ? [root, exact, foreign]
              : [root, exact, reply, foreign];
      const exactTarget = scenario.startsWith("exact");
      const publish = vi.fn(async () => {});
      const owner = editOwner(
        viewer,
        events,
        undefined,
        publish,
        exactTarget ? exact.id : undefined,
      );
      try {
        await authorize(owner);
        render(
          <MediaReviewViewer
            attachment={attachment}
            session={owner.session}
            scope={`media-edit-${kind}-${scenario}`}
            channelId="channel"
            channelName="General"
            messageId={exactTarget ? exact.id : root.id}
            initialTime={5}
            close={() => {}}
            onOpenLink={() => false}
          />,
          { reactStrictMode: true },
        );
        await screen.findByText("Newer other reply");
        const input = screen.getByRole<ComposerInputElement>("textbox", {
          name: "Reply to thread",
        });
        fireEvent.keyDown(input, { key: "ArrowUp" });
        const expected =
          scenario === "root" ? root : scenario === "exact" ? exact : reply;
        expect(input).toHaveAccessibleName("Edit message");
        expect(input).toHaveValue(expected.content);
        act(() => {
          input.value = "Revised media comment";
          input.setSelectionRange(21, 21);
        });
        fireEvent.input(input);
        fireEvent.keyDown(input, { key: "Enter" });
        await waitFor(() =>
          expect(input).toHaveAccessibleName("Reply to thread"),
        );
        expect(publish).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            kind: 40003,
            content: "Revised media comment",
            tags: [
              ["h", "channel"],
              ["e", expected.id],
              ...expected.tags.filter(([name]) => name === "imeta"),
              ["client-id", expect.any(String)],
            ],
          }),
          expect.anything(),
        );
      } finally {
        cleanup();
        owner.dispose();
      }
    }
  },
);

it.each(["reject", "commit"] as const)(
  "keeps the edit open until delayed Outbox dismissal can %s",
  async (outcome) => {
    const viewer = keypair(),
      other = keypair();
    const root = message(other, "channel", "Root message", 10);
    const reply = message(viewer, "channel", "Own reply", 11, [
      ["e", root.id, "", "reply"],
    ]);
    let release = () => {};
    let reject = (_error: Error) => {};
    const gate = new Promise<void>((resolve, fail) => {
      release = resolve;
      reject = fail;
    });
    let saving = () => {};
    const started = new Promise<void>((resolve) => {
      saving = resolve;
    });
    let holdRemoval = false;
    let operation: string | undefined;
    const storage: OutboxStorage = {
      load: () => [],
      async save(records) {
        if (
          holdRemoval &&
          !records.some((item) => item.event.id === operation)
        ) {
          saving();
          await gate;
        }
      },
    };
    const publish = vi
      .fn(async (_event: RelayEvent, _signal?: AbortSignal) => {})
      .mockRejectedValueOnce(new PublishRejected("Edit rejected"));
    const owner = editOwner(viewer, [root, reply], storage, publish);
    try {
      await authorize(owner);
      render(
        <ThreadPanel
          session={owner.session}
          scope={`dismiss-${outcome}`}
          channelName="General"
          channelId="channel"
          messageId={root.id}
          close={() => {}}
          onOpenLink={() => false}
        />,
      );
      await screen.findByText("Own reply");
      const input = screen.getByRole<ComposerInputElement>("textbox", {
        name: "Reply to thread",
      });
      fireEvent.keyDown(input, { key: "ArrowUp", metaKey: true });
      act(() => {
        input.value = "Keep my revision";
        input.setSelectionRange(16, 16);
      });
      fireEvent.input(input);
      fireEvent.keyDown(input, { key: "Enter" });
      await screen.findByRole("button", { name: "Retry edit" });
      const outbox = owner.session.outbox;
      assert.exists(outbox);
      const pending = outbox.snapshot()[0];
      assert.exists(pending);
      operation = pending.event.id;
      holdRemoval = true;
      const dismissed = outbox.dismiss(operation);
      const result = dismissed.then(
        () => undefined,
        (error: unknown) => error,
      );
      await act(async () => {
        await started;
      });
      expect(input).toHaveAccessibleName("Edit message");
      expect(input).toHaveValue("Keep my revision");
      await act(async () => {
        holdRemoval = false;
        if (outcome === "reject") reject(new Error("Disk unavailable"));
        else release();
        await result;
      });
      if (outcome === "reject") {
        expect(await result).toEqual(new Error("Disk unavailable"));
        expect(input).toHaveAccessibleName("Edit message");
        expect(input).toHaveValue("Keep my revision");
        fireEvent.click(screen.getByRole("button", { name: "Retry edit" }));
        await waitFor(() =>
          expect(input).toHaveAccessibleName("Reply to thread"),
        );
        expect(publish).toHaveBeenCalledTimes(2);
        expect(publish.mock.calls[1]?.[0]).toEqual(publish.mock.calls[0]?.[0]);
      } else {
        expect(await result).toBeUndefined();
        await waitFor(() =>
          expect(input).toHaveAccessibleName("Reply to thread"),
        );
        expect(outbox.snapshot()).toHaveLength(0);
        expect(publish).toHaveBeenCalledTimes(1);
      }
      expect(input).toHaveValue("");
    } finally {
      release();
      cleanup();
      owner.dispose();
    }
  },
);

it.each(["thread", "exact"])(
  "%s composer preserves replaced attachments on a text re-edit",
  async (surface) => {
    const viewer = keypair(),
      other = keypair();
    const oldUrl = "https://fixture.test/old.png";
    const url = "https://fixture.test/current.png";
    const imeta = [
      "imeta",
      `url ${url}`,
      "m image/png",
      "dim 640x480",
      "x retained-hash",
    ];
    const root = message(other, "channel", "Root", 10);
    const reply = message(viewer, "channel", "Original", 11, [
      ["e", root.id, "", "reply"],
      ["imeta", `url ${oldUrl}`, "m image/png"],
    ]);
    const edit = signed(viewer, {
      kind: 40003,
      content: `Current caption\n\n![image](${url})`,
      created_at: 12,
      tags: [["h", "channel"], ["e", reply.id], imeta],
    });
    const events = [root, reply, edit];
    const publish = vi.fn(async (_event: RelayEvent) => {});
    const owner = editOwner(
      viewer,
      events,
      undefined,
      publish,
      surface === "exact" ? reply.id : undefined,
    );
    try {
      await authorize(owner);
      const shared = {
        session: owner.session,
        scope: `replacement-${surface}`,
        channelId: "channel",
        channelName: "General",
        close: () => {},
        onOpenLink: () => false,
      };
      render(
        surface === "thread" ? (
          <ThreadPanel {...shared} messageId={root.id} />
        ) : (
          <MediaReviewViewer
            {...shared}
            messageId={reply.id}
            attachment={{ url, kind: "image" }}
            initialTime={0}
          />
        ),
        { reactStrictMode: true },
      );
      await screen.findByText("Current caption");
      const input = screen.getByRole<ComposerInputElement>("textbox", {
        name: "Reply to thread",
      });
      fireEvent.keyDown(input, { key: "ArrowUp", metaKey: true });
      expect(input).toHaveValue(edit.content);
      const content = `New caption\n\n![image](${url})`;
      act(() => {
        input.value = content;
        input.setSelectionRange(content.length, content.length);
      });
      fireEvent.input(input);
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
      const sent = publish.mock.calls[0]?.[0];
      assert(sent);
      expect(sent.tags.filter(([name]) => name === "imeta")).toEqual([imeta]);
      expect(sent.content).toBe(content);
      const row = foldMessages("channel", "", [...events, sent], {
        includeReplies: true,
      }).find((row) => row.id === reply.id);
      expect(row?.content).toBe("New caption");
      expect(row?.attachments).toEqual([
        {
          url,
          kind: "image",
          mime: "image/png",
          name: "current.png",
          dimensions: { width: 640, height: 480 },
        },
      ]);
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);
