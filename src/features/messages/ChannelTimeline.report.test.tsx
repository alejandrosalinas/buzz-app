// @vitest-environment jsdom
import "../../../tests/sonner-dom";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, type ReactElement, type ReactNode } from "react";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { createRelaySession } from "../relay/session";
import type { LiveCallbacks } from "../relay/live";
import type { RelayEvent } from "../relay/events";
import {
  keypair,
  message,
  roster,
  scriptedTransport,
  signed,
} from "../relay/testing";
import type { ConversationExtensions } from "../conversation/contracts";
import { VoiceNoteCard } from "../../bundled/voice-notes/VoiceNoteCard";
import { ThreadPanel } from "./ThreadPanel";
import { ChannelTimeline } from "./ChannelTimeline";

// Virtualizer boundary: render only "visible" indices plus `keepMounted`,
// as Virtua does for rows scrolled out of its buffer. Layout is browser-tested.
const view = vi.hoisted(() => ({
  visible: undefined as ReadonlySet<number> | undefined,
}));
vi.mock("virtua", async () => {
  const { Children, forwardRef, useImperativeHandle } = await import("react");
  return {
    Virtualizer: forwardRef(function Virtualizer(
      {
        children,
        keepMounted = [],
      }: { children: ReactNode; keepMounted?: readonly number[] },
      ref,
    ) {
      useImperativeHandle(ref, () => ({
        cache: undefined,
        findItemIndex: () => 0,
        getItemOffset: () => 0,
        scrollOffset: 0,
        scrollSize: 0,
        viewportSize: 0,
        scrollTo() {},
        scrollToIndex() {},
      }));
      return (
        <ol>
          {Children.toArray(children).map((child, index) =>
            !view.visible ||
            view.visible.has(index) ||
            keepMounted.includes(index) ? (
              <li key={(child as ReactElement).key}>{child}</li>
            ) : null,
          )}
        </ol>
      );
    }),
  };
});

const viewer = keypair(),
  other = keypair(),
  relay = keypair();
const target = message(other, "c", "Report me", 1, [
  ["imeta", "url https://relay.test/media/a.png", "m image/png"],
]);
const neighbor = message(other, "c", "Neighbor", 2);
const owners: { dispose(): void }[] = [];
beforeEach(() => {
  view.visible = undefined;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function mount(
  publish: (event: RelayEvent) => Promise<void>,
  targetEvent = target,
  initial = [targetEvent, neighbor],
  threadRoot?: string,
  options: {
    media?: (url: string) => string;
    extensions?: ConversationExtensions;
  } = {},
) {
  let live: LiveCallbacks | undefined;
  const owner = createRelaySession(
    {
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      ...(threadRoot ? { query: async () => initial } : {}),
      ...(options.media ? { media: options.media } : {}),
      writer: { sign: async (template) => signed(viewer, template), publish },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  owner.session.channels.ensure("c");
  live?.receive([roster(relay, "c", [viewer.pubkey], 1), ...initial]);
  const tree = () => (
    <StrictMode>
      <ToastProvider>
        {threadRoot ? (
          <ThreadPanel
            session={owner.session}
            scope="viewer"
            channelName="C"
            channelId="c"
            messageId={threadRoot}
            onOpenLink={() => false}
          />
        ) : (
          <ChannelTimeline
            channelId="c"
            scope="viewer"
            queries={owner.session}
            window={owner.session.channels.window("c")}
            onOpenLink={() => false}
            extensions={options.extensions}
          />
        )}
      </ToastProvider>
    </StrictMode>
  );
  const result = render(tree());
  const row = () =>
    document.querySelector<HTMLElement>(
      `[data-message-id="${targetEvent.id}"]`,
    );
  const neighborRow = () =>
    document.querySelector(`[data-message-id="${neighbor.id}"]`);
  return {
    receive(event: RelayEvent) {
      act(() => {
        live?.receive([event]);
        result.rerender(tree());
      });
    },
    row,
    neighborRow,
    // Scroll the target out of the virtualizer buffer.
    evict() {
      const index = owner.session.channels
        .window("c")
        .rows.findIndex((row) => row.id === neighbor.id);
      view.visible = new Set([index]);
      result.rerender(tree());
    },
    show() {
      view.visible = undefined;
      result.rerender(tree());
    },
    unmount: result.unmount,
  };
}

async function openReport(row: HTMLElement) {
  const user = userEvent.setup();
  const more = within(row).queryByRole("button", {
    name: "More message actions",
  });
  const trigger =
    more ?? within(row).getByRole("button", { name: /Working on the report/ });
  if (more) await user.click(trigger);
  else fireEvent.contextMenu(trigger);
  await user.click(await screen.findByRole("menuitem", { name: "Report" }));
  await screen.findByRole("dialog", { name: "Report message" });
  return { user, trigger };
}

it("keeps the reporting row mounted through a held submission and its notice, then releases it", async () => {
  let settle!: () => void;
  const publish = vi.fn(
    () => new Promise<void>((resolve) => (settle = resolve)),
  );
  const h = mount(publish);
  const row = h.row();
  if (!row) throw new Error("Missing target row");
  const { user } = await openReport(row);
  h.evict();
  expect(h.neighborRow()).not.toBeNull();
  expect(h.row()).toBe(row);
  await user.click(screen.getByRole("radio", { name: "Spam" }));
  await user.type(
    screen.getByRole("textbox", { name: "Additional context (optional)" }),
    "repeated links",
  );
  await user.click(screen.getByRole("button", { name: "Submit report" }));
  await waitFor(() => expect(publish).toHaveBeenCalledOnce());
  h.evict();
  expect(h.row()).toBe(row);
  act(() => settle());
  expect(
    await screen.findByText("Report submitted to community moderators"),
  ).toBeTruthy();
  h.evict();
  expect(h.row()).toBe(row);
  await user.click(screen.getByRole("button", { name: /dismiss/i }));
  // Once the notice and focus are gone, the virtualizer may evict the row.
  await waitFor(() => expect(h.row()).toBeNull());
  expect(h.neighborRow()).not.toBeNull();
});

it("releases on cancel, pins again on reopen, and unmounts cleanly while open", async () => {
  const error = vi.spyOn(console, "error");
  const h = mount(async () => {});
  const row = h.row();
  if (!row) throw new Error("Missing target row");
  const { user, trigger } = await openReport(row);
  await user.click(screen.getByRole("radio", { name: "Other" }));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  await openReport(row);
  expect(
    screen.getByRole("radio", { name: "Other" }).getAttribute("aria-checked"),
  ).toBe("false");
  h.evict();
  expect(h.row()).toBe(row);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  // Restored focus keeps the row; once focus leaves, the pin must be gone.
  act(() => trigger.blur());
  h.evict();
  await waitFor(() => expect(h.row()).toBeNull());

  h.show();
  const remounted = h.row();
  if (!remounted) throw new Error("Missing target row");
  await openReport(remounted);
  h.unmount();
  await act(() => new Promise((resolve) => setTimeout(resolve)));
  expect(screen.queryByRole("dialog", { name: "Report message" })).toBeNull();
  expect(error).not.toHaveBeenCalled();
});

it("keeps an image row mounted while its fullscreen viewer is open, then releases it after restoring focus", async () => {
  const user = userEvent.setup();
  const h = mount(async () => {});
  const row = h.row();
  if (!row) throw new Error("Missing target row");
  const thumbnail = within(row).getByRole("link", {
    name: "Open image attachment",
  });
  await user.click(thumbnail);
  const dialog = await screen.findByRole("dialog", {
    name: "Image attachment",
  });
  // Focus inside the portal leaves the timeline's focused row unset.
  h.evict();
  expect(h.row()).toBe(row);
  expect(dialog.isConnected).toBe(true);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(thumbnail));
  h.evict();
  expect(h.row()).toBe(row);
  // Restored focus keeps the row; once focus leaves, the pin must be gone.
  act(() => thumbnail.blur());
  h.evict();
  await waitFor(() => expect(h.row()).toBeNull());
});

// The report notice and the image viewer hold the same row; releasing either
// must leave the other's pin in place.
it("a report notice expiring behind the image viewer keeps the row pinned for the viewer", async () => {
  let settle!: () => void;
  const publish = vi.fn(
    () => new Promise<void>((resolve) => (settle = resolve)),
  );
  const h = mount(publish);
  const row = h.row();
  if (!row) throw new Error("Missing target row");
  const { user } = await openReport(row);
  await user.click(screen.getByRole("radio", { name: "Spam" }));
  await user.click(screen.getByRole("button", { name: "Submit report" }));
  await waitFor(() => expect(publish).toHaveBeenCalledOnce());
  // The notice's five seconds start when the submission settles. Testing
  // Library's async helpers wait on real timers, so from here events are fired
  // directly and the clock is advanced explicitly.
  vi.useFakeTimers();
  await act(async () => settle());
  const notice = () =>
    screen.queryByText("Report submitted to community moderators");
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(notice()).not.toBeNull();
  const thumbnail = within(row).getByRole("link", {
    name: "Open image attachment",
  });
  fireEvent.click(thumbnail);
  await act(() => vi.advanceTimersByTimeAsync(50));
  const dialog = screen.getByRole("dialog", { name: "Image attachment" });
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(notice()).not.toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(notice()).toBeNull();
  // The notice's deferred release has run; the viewer's hold must remain.
  await act(() => vi.runOnlyPendingTimersAsync());
  h.evict();
  expect(h.row()).toBe(row);
  expect(dialog.isConnected).toBe(true);
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  // Focus restoration and the viewer's release each take a frame.
  await act(() => vi.advanceTimersByTimeAsync(50));
  expect(document.activeElement).toBe(thumbnail);
  act(() => thumbnail.blur());
  h.evict();
  expect(h.row()).toBeNull();
});

it("closing the image viewer before the report notice ends keeps the row pinned for the notice", async () => {
  const h = mount(async () => {});
  const row = h.row();
  if (!row) throw new Error("Missing target row");
  const { user } = await openReport(row);
  await user.click(screen.getByRole("radio", { name: "Spam" }));
  await user.click(screen.getByRole("button", { name: "Submit report" }));
  await screen.findByText("Report submitted to community moderators");
  const thumbnail = within(row).getByRole("link", {
    name: "Open image attachment",
  });
  await user.click(thumbnail);
  await screen.findByRole("dialog", { name: "Image attachment" });
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(thumbnail));
  // The viewer releases a frame after close; wait for that frame to pass.
  await act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  act(() => thumbnail.blur());
  h.evict();
  expect(h.row()).toBe(row);
  await user.click(screen.getByRole("button", { name: /dismiss/i }));
  await waitFor(() => expect(h.row()).toBeNull());
  expect(h.neighborRow()).not.toBeNull();
});

// Inline audio plays only from the relay proxy; other sources are file cards.
const proxied = (url: string) =>
  `/api/relay/primary/media?url=${encodeURIComponent(url)}`;
// Readers must return stable snapshots, or useSyncExternalStore loops.
const empty: never[] = [];
const none = { snapshot: () => empty, subscribe: () => () => {} };
const voiceNote = [
  {
    key: "voice-notes:player",
    pluginId: "voice-notes",
    revision: "1",
    id: "player",
    title: "Voice note",
    matches: (attachment: { name?: string }) =>
      !!attachment.name?.endsWith(".m4a"),
    component: ({ source }: { source: string }) => (
      <VoiceNoteCard source={source} duration={120} />
    ),
  },
];
const voiceNotes: ConversationExtensions = {
  tools: none,
  inline: none,
  attachments: { snapshot: () => voiceNote, subscribe: () => () => {} },
};

it.each([
  ["a plain audio attachment", "a.mp3", "audio/mpeg", "Play a.mp3", "pause"],
  ["a voice note", "voice.m4a", "audio/mp4", "Play voice note", "pause"],
  [
    "a voice note (reloaded)",
    "voice.m4a",
    "audio/mp4",
    "Play voice note",
    "emptied",
  ],
  ["an inline video", "a.mp4", "video/mp4", "Open video fullscreen", "ended"],
] as const)(
  "keeps a row mounted while %s plays, then lets it go when playback stops",
  async (_, file, mime, control, stop) => {
    const playing = message(other, "c", "Listen", 1, [
      ["imeta", `url https://relay.test/media/${file}`, `m ${mime}`],
    ]);
    const h = mount(async () => {}, playing, [playing, neighbor], undefined, {
      media: proxied,
      extensions: voiceNotes,
    });
    const row = h.row();
    const player = row?.querySelector<HTMLMediaElement>("audio, video");
    if (!row || !player) throw new Error("Missing media row");
    within(row).getByRole("button", { name: control });
    // jsdom has no playback; report what a browser reports while playing.
    let paused = false;
    Object.defineProperty(player, "paused", { get: () => paused });
    fireEvent.play(player);
    // A browser delivers the play's mutation records before playback stops.
    await act(async () => {});
    h.evict();
    expect(h.row()).toBe(row);
    expect(player.isConnected).toBe(true);
    paused = true;
    fireEvent[stop](player);
    await waitFor(() => expect(h.row()).toBeNull());
    expect(h.neighborRow()).not.toBeNull();
  },
);

it("keeps a row mounted while another of its players still plays", async () => {
  const both = message(other, "c", "Listen", 1, [
    ["imeta", "url https://relay.test/media/a.mp3", "m audio/mpeg"],
    ["imeta", "url https://relay.test/media/a.mp4", "m video/mp4"],
  ]);
  const h = mount(async () => {}, both, [both, neighbor], undefined, {
    media: proxied,
  });
  const row = h.row();
  const audio = row?.querySelector("audio");
  const video = row?.querySelector("video");
  if (!row || !audio || !video) throw new Error("Missing media row");
  const playing = new Set<HTMLMediaElement>([audio, video]);
  for (const player of playing)
    Object.defineProperty(player, "paused", {
      get: () => !playing.has(player),
    });
  fireEvent.play(audio);
  fireEvent.play(video);
  playing.delete(audio);
  fireEvent.pause(audio);
  // A released pin lets go a task later; wait it out before evicting.
  await act(() => new Promise((resolve) => setTimeout(resolve)));
  h.evict();
  expect(h.row()).toBe(row);
  playing.delete(video);
  fireEvent.pause(video);
  await waitFor(() => expect(h.row()).toBeNull());
});

it("lets a playing row go when its voice note fails", async () => {
  const failing = message(other, "c", "Listen", 1, [
    ["imeta", "url https://relay.test/media/voice.m4a", "m audio/mp4"],
  ]);
  const h = mount(async () => {}, failing, [failing, neighbor], undefined, {
    media: proxied,
    extensions: voiceNotes,
  });
  const row = h.row();
  const audio = row?.querySelector("audio");
  if (!row || !audio) throw new Error("Missing media row");
  // A failed element can still report paused false.
  Object.defineProperty(audio, "paused", { get: () => false });
  fireEvent.play(audio);
  // A decode error is not retried.
  Object.defineProperty(audio, "error", { get: () => ({ code: 3 }) });
  fireEvent.error(audio);
  within(row).getByText("Audio unavailable. Retry playback.");
  // The card keeps its failed player, so no removal releases the row.
  expect(audio.isConnected).toBe(true);
  h.evict();
  await waitFor(() => expect(h.row()).toBeNull());
  expect(h.neighborRow()).not.toBeNull();
});

const claimer = [
  {
    key: "cards:claimer",
    pluginId: "cards",
    revision: "1",
    id: "claimer",
    title: "Claimed card",
    matches: (message: { content: string }) => message.content === "Claimed",
    ownsAttachment: () => true,
    component: () => <p>Claimed card</p>,
  },
];
const cards: ConversationExtensions = {
  tools: none,
  inline: none,
  messages: { snapshot: () => claimer, subscribe: () => () => {} },
};

// An edit listing no attachments keeps the original's, so only a claim can
// unmount the whole list.
it.each([
  ["is edited out", "Listen", "url https://relay.test/media/b.pdf"],
  [
    "is claimed, emptying the list",
    "Claimed",
    "url https://relay.test/media/a.mp3",
  ],
] as const)(
  "lets a playing row go when its player %s",
  async (_, content, url) => {
    const playing = message(other, "c", "Listen", 1, [
      ["imeta", "url https://relay.test/media/a.mp3", "m audio/mpeg"],
    ]);
    const h = mount(async () => {}, playing, [playing, neighbor], undefined, {
      media: proxied,
      extensions: cards,
    });
    const row = h.row();
    const audio = row?.querySelector("audio");
    if (!row || !audio) throw new Error("Missing media row");
    Object.defineProperty(audio, "paused", { get: () => false });
    fireEvent.play(audio);
    h.evict();
    expect(h.row()).toBe(row);
    // React no longer dispatches events for the removed player.
    h.receive(
      signed(other, {
        kind: 40003,
        content,
        created_at: 3,
        tags: [
          ["h", "c"],
          ["e", playing.id],
          ["imeta", url],
        ],
      }),
    );
    expect(audio.isConnected).toBe(false);
    await waitFor(() => expect(h.row()).toBeNull());
    expect(h.neighborRow()).not.toBeNull();
  },
);

it("lets a playing agents row go when it collapses", async () => {
  const root = message(viewer, "c", "Request", 1);
  const step = message(other, "c", "Listen", 3, [
    ["audience", "agents"],
    ["imeta", "url https://relay.test/media/a.mp3", "m audio/mpeg"],
  ]);
  const h = mount(async () => {}, step, [root, neighbor, step], undefined, {
    media: proxied,
  });
  fireEvent.click(
    await screen.findByRole("button", { name: /Show activity history/ }),
  );
  // The group's toggle takes focus, and a focused group stays mounted.
  act(() => (document.activeElement as HTMLElement).blur());
  const row = h.row();
  if (!row) throw new Error("Missing agents row");
  const line = within(row).getByRole("button", { name: /Listen/ });
  fireEvent.click(line);
  const audio = await waitFor(() => {
    const player = row.querySelector("audio");
    if (!player) throw new Error("Missing player");
    return player;
  });
  let paused = false;
  Object.defineProperty(audio, "paused", { get: () => paused });
  fireEvent.play(audio);
  fireEvent.click(line);
  await waitFor(() => expect(audio.isConnected).toBe(false));
  // A browser pauses the detached player, but React drops its pause.
  paused = true;
  fireEvent.pause(audio);
  h.evict();
  await waitFor(() => expect(h.row()).toBeNull());
  expect(h.neighborRow()).not.toBeNull();
});

it.each([
  ["channel", "draft"],
  ["channel", "pending"],
  ["thread", "draft"],
  ["thread", "pending"],
] as const)(
  "retains the %s report owner through completion with a %s report",
  async (host, phase) => {
    let release!: () => void;
    const publish = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const root = message(viewer, "c", "Request", 1);
    const tags =
      host === "thread"
        ? [
            ["e", root.id, "", "root"],
            ["e", root.id, "", "reply"],
          ]
        : [];
    const step = message(other, "c", "Working on the report", 2, [
      ["audience", "agents"],
      ...tags,
    ]);
    const h = mount(
      publish,
      step,
      [root, step],
      host === "thread" ? root.id : undefined,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /Show activity history/ }),
    );
    const original = h.row();
    if (!original) throw new Error("Missing contained activity");
    const { user } = await openReport(original);
    await user.click(screen.getByRole("radio", { name: "Spam" }));
    const context = screen.getByRole("textbox", {
      name: "Additional context (optional)",
    });
    await user.type(context, "Keep this draft");
    try {
      if (phase === "pending") {
        await user.click(screen.getByRole("button", { name: "Submit report" }));
        await waitFor(() => expect(publish).toHaveBeenCalledOnce());
      }
      h.receive(message(other, "c", "Finished the work", 3, tags));
      expect(h.row()).toBe(original);
      expect(
        screen.getByRole("dialog", { name: "Report message" }),
      ).toBeTruthy();
      expect(context).toHaveValue("Keep this draft");
    } finally {
      if (phase === "pending") await act(async () => release());
    }
    if (phase === "pending") {
      expect(
        await screen.findByText("Report submitted to community moderators"),
      ).toBeTruthy();
      expect(h.row()).toBe(original);
      await user.click(screen.getByRole("button", { name: /dismiss/i }));
    } else {
      await user.click(screen.getByRole("button", { name: "Cancel" }));
    }
    expect(h.row()).toBeInTheDocument();
  },
);
