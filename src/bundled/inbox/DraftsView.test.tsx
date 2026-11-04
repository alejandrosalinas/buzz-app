const emptyPanels: never[] = [];
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
// @vitest-environment jsdom
import { huddleDescription } from "../../features/huddle/lifecycle";
import { readView, writeView } from "../../shared/view-state";
import {
  attachmentDraft,
  useAttachmentDraft,
} from "../../features/messages/attachment-draft";
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { PageTabs } from "../channels/PageTabs";
import { InboxPage } from "./InboxPage";
import { ChannelPreview } from "./ChannelPreview";
import { ThreadPanel } from "../../features/messages/ThreadPanel";

import {
  composerDOMFixture,
  typedDraft,
} from "../../features/messages/composer-testing";
import { followupDraft } from "../../features/messages/mention-draft";
import { createRelaySession } from "../../features/relay/session";
import type { RelaySnapshot, RelayData } from "../../features/relay/service";
import type { Navigation } from "../../features/navigation/controller";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import { matchesEvent } from "../../features/relay/projection";
import {
  readJournal,
  type ReadJournal,
} from "../../features/relay/read-state-storage";
import {
  bounds,
  keypair,
  message,
  metadata,
  profile,
  roster,
  signed,
} from "../../features/relay/testing";
import {
  decodeReadState,
  signReadState,
  // @ts-expect-error Node host codec, with disposable test identities only.
} from "../../../browser-host/read-state.mjs";

vi.mock("./ChannelPreview", { spy: true });
vi.mock("../../features/messages/ThreadPanel", { spy: true });

const owners: ReturnType<typeof createRelaySession>[] = [];
composerDOMFixture();
beforeEach(() => localStorage.clear());
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);
HTMLElement.prototype.scrollIntoView = vi.fn();
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
});
function fixture(
  options: {
    withDm?: boolean;
    holdProfiles?: boolean;
    withWriter?: boolean;
    connected?: boolean;
    upload?: (
      file: File,
      signal: AbortSignal,
    ) => Promise<import("../../features/relay/attachments").UploadedAttachment>;
  } = {},
) {
  const viewer = keypair(),
    alice = keypair(),
    relayKey = keypair();
  let releaseProfiles = () => {};
  const profilesGate = options.holdProfiles
    ? new Promise<void>((resolve) => {
        releaseProfiles = resolve;
      })
    : undefined;
  const historyRequests: string[] = [];
  const threadRequests: string[] = [];
  const exactRequests: string[] = [];
  const published: RelayEvent[] = [];
  const historyGates = new Map<string, Promise<void>>();
  const historyFailures = new Set<string>();
  const answer = (filter: ReadFilter): RelayEvent[] => {
    const result = events.filter((event) => matchesEvent(event, filter));
    if (filter.depth_limit) {
      return result
        .filter(
          (event) =>
            filter.thread_cursor === undefined ||
            event.created_at > filter.thread_cursor ||
            (event.created_at === filter.thread_cursor &&
              event.id > (filter.thread_cursor_id ?? "")),
        )
        .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
        .slice(0, filter.limit);
    }
    if (filter.top_level && filter["#h"]?.[0]) {
      return [
        ...result,
        ...events.filter(
          (event) =>
            event.kind === 5 &&
            event.tags.some(
              ([key, value]) => key === "h" && value === filter["#h"]?.[0],
            ),
        ),
        bounds(
          relayKey,
          filter["#h"][0],
          filter.until === undefined
            ? "head"
            : `${filter.until}:${filter.before_id}`,
          { has_more: false, next_cursor: null },
        ),
      ];
    }
    // The ordinary #p feed has no implicit include_aux. Exact #e pages
    // terminate only on empty even if visibility shortened an earlier page.
    if (filter["#e"])
      return result
        .filter(
          (event) =>
            filter.until === undefined ||
            event.created_at < filter.until ||
            (event.created_at === filter.until &&
              event.id > (filter.before_id ?? "")),
        )
        .slice(0, filter.limit);
    return result.slice(0, filter.limit);
  };
  let journal: ReadJournal | undefined;
  let saveFailure = false;
  let failThreadSave = false;
  let hold: Promise<void> | undefined;
  let saveStarted = false;
  let emit: (events: readonly RelayEvent[]) => void = () => {};
  const roots = [message(viewer, "room", "Our discussion", 20)];
  const mention = message(alice, "room", "Please review **this**", 21, [
    ["p", viewer.pubkey],
  ]);
  const reply = message(alice, "room", "A thread update", 22, [
    ["e", roots[0]?.id ?? "", "", "reply"],
  ]);
  const events = [
    roster(relayKey, "room", [viewer.pubkey, alice.pubkey], 10),
    metadata(relayKey, "room", "Design", 10, [["t", "stream"]]),
    profile(alice, { name: "Alice" }),
    ...roots,
    mention,
    reply,
    ...(options.withDm
      ? [
          roster(relayKey, "dm-room", [viewer.pubkey, alice.pubkey], 10),
          metadata(relayKey, "dm-room", "Direct message", 10, [
            ["t", "dm"],
            ["hidden"],
          ]),
          message(alice, "dm-room", "A direct reply", 23),
        ]
      : []),
  ];
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relayKey.pubkey,
      query: async (filters) => {
        if (profilesGate && filters.some((filter) => filter.kinds?.includes(0)))
          await profilesGate;
        for (const filter of filters) {
          const channelId = filter["#h"]?.[0];
          if (filter.top_level && channelId) historyRequests.push(channelId);
          if (filter.depth_limit && channelId) threadRequests.push(channelId);
          if (filter.ids && channelId) exactRequests.push(...filter.ids);
          if (
            (filter.top_level || filter.depth_limit || filter.ids) &&
            channelId
          ) {
            await historyGates.get(channelId);
            if (historyFailures.has(channelId))
              throw new Error("history offline");
          }
        }
        return filters.flatMap(answer);
      },
      media: () => undefined,
      ...(options.upload ? { uploadAttachment: options.upload } : {}),
      ...(options.withWriter
        ? {
            writer: {
              kinds: [9, 9007, 40003, 5],
              sign: async (template: import("nostr-tools").EventTemplate) =>
                signed(viewer, template),
              publish: async (event: RelayEvent) => {
                published.push(event);
              },
            },
          }
        : {}),
      subscribe(callbacks) {
        if (options.connected)
          callbacks.state({ status: "connected", routes: [] });
        emit = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
      readState: {
        decode: async (records: readonly RelayEvent[]) =>
          decodeReadState(records, viewer.secret),
        sign: async (
          intent: import("../../features/relay/read-state-host").ReadStateSigning,
        ) => signReadState(intent, viewer.secret),
        publish: async (event: RelayEvent) => {
          events.push(event);
        },
      },
    },
    {
      outboxStorage: { load: () => [], save: () => {} },
      readStateStorage: {
        async update(change) {
          if (hold) {
            saveStarted = true;
            const wait = hold;
            hold = undefined;
            await wait;
          }
          if (saveFailure) {
            saveFailure = false;
            throw new Error("disk full");
          }
          const next = readJournal(change(journal), viewer.pubkey);
          if (
            failThreadSave &&
            Object.keys(next.state.frontiers).some(
              (key) =>
                key.startsWith("thread:") &&
                next.state.frontiers[key] !== journal?.state.frontiers[key],
            )
          ) {
            failThreadSave = false;
            throw new Error("thread disk full");
          }
          journal = next;
          return journal;
        },
        close() {},
      },
      readPublisherLock: async (_signal, work) => work(),
    },
  );
  owners.push(owner);
  // Held profiles arrive only through the gated read: names survive access
  // changes now, so a live copy would name everyone before the gate opens.
  emit(profilesGate ? events.filter((event) => event.kind !== 0) : events);
  const scope = {
    viewer: viewer.pubkey,
    communityOrigin: "https://relay.test",
  };
  const observedSession = owner.session;
  let connection: RelaySnapshot = {
    status: "ready",
    generation: 1,
    scope: `${scope.communityOrigin}:${scope.viewer}`,
    viewer: scope.viewer,
    session: observedSession,
  };
  const subscribers = new Set<() => void>();
  const relay: RelayData = {
    snapshot: () => connection,
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    retry() {},
    disconnect() {},
    clearCache: owner.clearCache,
  };
  const open = vi.fn<Navigation["open"]>(async () => ({ status: "opened" }));
  const host = {
    relay,
    navigation: { open },
    panels: {
      subscribe: () => () => {},
      snapshot: () => emptyPanels,
      resolve: () => undefined,
    },
  } as unknown as ConversationHostServices;
  return {
    owner,
    relay,
    observedSession,
    historyRequests,
    threadRequests,
    exactRequests,
    published,
    addEvent(event: RelayEvent) {
      events.push(event);
    },
    deleteHistory(channelId: string) {
      const deletions = events
        .filter(
          (e) =>
            e.kind === 9 &&
            e.tags.some(([k, v]) => k === "h" && v === channelId),
        )
        .map((event) =>
          signed(event.pubkey === viewer.pubkey ? viewer : alice, {
            kind: 5,
            tags: [
              ["h", channelId],
              ["e", event.id],
            ],
            content: "",
            created_at: 200,
          }),
        );
      events.push(...deletions);
      emit(deletions);
    },
    retireThreadRoot() {
      const root = roots[0];
      if (!root) throw new Error("Missing fixture root");
      const deletion = signed(viewer, {
        kind: 5,
        tags: [
          ["h", "room"],
          ["e", root.id],
        ],
        content: "",
        created_at: 200,
      });
      events.push(deletion);
      emit([deletion]);
    },
    root: roots[0],
    failHistory(channelId: string) {
      historyFailures.add(channelId);
    },
    recoverHistory(channelId: string) {
      historyFailures.delete(channelId);
    },
    emptyHistory(channelId: string) {
      for (let i = events.length - 1; i >= 0; i--)
        if (
          events[i]?.kind === 9 &&
          events[i]?.tags.some(([k, v]) => k === "h" && v === channelId)
        )
          events.splice(i, 1);
    },
    holdHistory(channelId: string) {
      let release = () => {};
      historyGates.set(
        channelId,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return () => {
        historyGates.delete(channelId);
        release();
      };
    },
    releaseProfiles,
    relayKey,
    alice,
    viewer,
    emit,
    events,
    scope,
    mention,
    reply,
    open,
    journal: () => journal,
    view: (
      <StrictMode>
        <InboxPage
          host={host}
          tabs={(props) => <PageTabs {...props} host={host} />}
          relay={relay}
          navigator={{ open } as unknown as Navigation}
        />
      </StrictMode>
    ),
    revokeRoom() {
      emit([roster(relayKey, "room", [alice.pubkey], 100)]);
    },
    restoreRoom() {
      const restored = roster(
        relayKey,
        "room",
        [viewer.pubkey, alice.pubkey],
        101,
      );
      events.push(restored);
      emit([restored, mention, reply, ...roots]);
    },
    renameRoom() {
      const renamed = metadata(relayKey, "room", "Renamed", 99, [
        ["t", "stream"],
      ]);
      events.push(renamed);
      emit([renamed]);
    },
    failSave() {
      saveFailure = true;
    },
    failThreadSave() {
      failThreadSave = true;
    },
    saveStarted: () => saveStarted,
    holdSave() {
      saveStarted = false;
      let release = () => {};
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    disconnect() {
      connection = { ...connection, status: "disconnected", generation: 2 };
      for (const listener of subscribers) listener();
    },
  };
}

async function chooseFilter(label: string, control = "Activity type") {
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Inbox filters" });
  trigger.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("menu", { name: "Inbox filters" });
  if (control === "Sender") {
    const people = screen.getByRole("menuitemcheckbox", { name: "People" });
    const agents = screen.getByRole("menuitemcheckbox", { name: "Agents" });
    // Enable the desired sender before disabling the other: never select none.
    if (label !== "Agents" && people.getAttribute("aria-checked") !== "true")
      await user.click(people);
    if (label !== "Humans" && agents.getAttribute("aria-checked") !== "true")
      await user.click(agents);
    if (label === "Agents" && people.getAttribute("aria-checked") === "true")
      await user.click(people);
    if (label === "Humans" && agents.getAttribute("aria-checked") === "true")
      await user.click(agents);
    await user.keyboard("{Escape}");
  } else {
    await user.click(
      screen.getByRole("menuitemradio", {
        name: label === "All activity" ? "All" : label,
      }),
    );
  }
  await waitFor(() =>
    expect(
      screen.queryByRole("menu", { name: "Inbox filters" }),
    ).not.toBeInTheDocument(),
  );
}
it("Drafts shares the composer storage, gates origin navigation on current membership, and deletes only after consent", async () => {
  const h = fixture({ withWriter: true });
  const root = h.mention.id;
  const key = `draft:room:thread:${root}`;
  const saved = {
    text: "Draft reply @Alice",
    recipients: [
      { pubkey: h.mention.pubkey, name: "Alice", start: 12, end: 18 },
    ],
  };
  writeView(h.owner.session.scope, key, saved);
  writeView("other-scope", "draft:room", "Private other viewer draft");
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Threads");
  await chooseFilter("Humans", "Sender");
  fireEvent.click(screen.getByRole("button", { name: "Unread only" }));
  await chooseFilter("Drafts");
  expect(
    screen.getByRole("button", { name: "Inbox filters" }),
  ).toHaveTextContent("Drafts");
  expect(screen.getByRole("button", { name: "Inbox filters" })).toHaveFocus();
  expect(
    screen.queryByRole("button", { name: "Unread only" }),
  ).not.toBeInTheDocument();
  const user = userEvent.setup();
  screen.getByRole("button", { name: "Inbox filters" }).focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("menu", { name: "Inbox filters" });
  const people = screen.getByRole("menuitemcheckbox", { name: "People" });
  const agents = screen.getByRole("menuitemcheckbox", { name: "Agents" });
  expect(people).toHaveAttribute("aria-disabled", "true");
  expect(agents).toHaveAttribute("aria-disabled", "true");
  expect(
    screen.queryByText("Sender filters don’t apply to drafts."),
  ).not.toBeInTheDocument();
  expect(people).toBeChecked();
  expect(agents).not.toBeChecked();
  await user.keyboard("{Escape}");
  expect(
    screen.queryByRole("button", { name: "Refresh" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("list", { name: "Drafts" })).toHaveTextContent(
    "Draft reply @Alice",
  );
  expect(
    screen.queryByText(/Private other viewer draft/),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText(/Saved drafts on this device/),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Back to drafts" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Continue in conversation" }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  expect(screen.getByRole("heading", { name: "Design" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Delete draft…" })).toHaveAttribute(
    "data-variant",
    "ghost",
  );
  expect(screen.getByRole("button", { name: "Delete draft…" })).toHaveAttribute(
    "data-size",
    "sm",
  );
  fireEvent.click(screen.getByRole("button", { name: "Open in origin" }));
  await waitFor(() =>
    expect(h.open).toHaveBeenCalledWith({
      version: 1,
      kind: "conversation",
      scope: h.scope,
      channelId: "room",
      messageId: root,
      threadRootId: root,
    }),
  );
  expect(readView(h.owner.session.scope, key, "")).toEqual(saved);
  fireEvent.click(screen.getByRole("button", { name: "Delete draft…" }));
  expect(readView(h.owner.session.scope, key, "")).toEqual(saved);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(readView(h.owner.session.scope, key, "")).toEqual(saved);
  fireEvent.click(screen.getByRole("button", { name: "Delete draft…" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete draft" }));
  expect(readView(h.owner.session.scope, key, "")).toBe("");
  expect(screen.getByText("No drafts")).toBeVisible();
  await chooseFilter("Threads");
  expect(screen.getByRole("button", { name: "Inbox filters" })).toHaveFocus();
  expect(
    screen.getByRole("button", { name: "Inbox filters" }),
  ).toHaveTextContent("Threads");
  expect(
    screen.getByRole("button", { name: "Inbox filters" }),
  ).toHaveTextContent("People");
  expect(screen.getByRole("button", { name: "Unread only" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(h.journal()?.state.frontiers).toEqual({});
});

it("Drafts responds to same-window editor changes and disables composition if membership disappears", async () => {
  const h = fixture({ withWriter: true });
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Drafts");
  expect(screen.getByText("No drafts")).toBeVisible();
  act(() =>
    writeView(h.owner.session.scope, "draft:room", {
      text: "Unsent message",
      recipients: [],
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  expect(screen.getByRole("button", { name: "Open in origin" })).toBeEnabled();
  expect(screen.getByRole("textbox", { name: "Message #Design" })).toHaveValue(
    "Unsent message",
  );
  act(() => h.revokeRoom());
  expect(
    screen.queryByRole("button", { name: "Open in origin" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("textbox", { name: "Message #Design" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Delete draft…" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    screen.getByRole("heading", { name: "Unavailable conversation" }),
  ).toBeInTheDocument();
  expect(readView(h.owner.session.scope, "draft:room", "")).toMatchObject({
    text: "Unsent message",
  });
  expect(h.open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Close detail" }));
  expect(
    screen.queryByRole("region", { name: "Draft detail" }),
  ).not.toBeInTheDocument();
  expect(readView(h.owner.session.scope, "draft:room", "")).toMatchObject({
    text: "Unsent message",
  });
});

it("a failed confirmed draft deletion keeps the original saved text and remains retryable", async () => {
  const h = fixture();
  const key = "draft:room";
  writeView(h.owner.session.scope, key, "Do not discard me");
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Drafts");
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete draft…" }));
  const failure = vi
    .spyOn(Storage.prototype, "removeItem")
    .mockImplementation(() => {
      throw new Error("disk full");
    });
  try {
    fireEvent.click(screen.getByRole("button", { name: "Delete draft" }));
    expect(screen.getByRole("alert")).toHaveTextContent("disk full");
    expect(readView(h.owner.session.scope, key, "")).toBe("Do not discard me");
  } finally {
    failure.mockRestore();
  }
  fireEvent.click(screen.getByRole("button", { name: "Delete draft" }));
  expect(readView(h.owner.session.scope, key, "")).toBe("");
  expect(screen.getByText("No drafts")).toBeInTheDocument();
});

it("a selected DM draft reads only its real window and preserves its scoped composer", async () => {
  const h = fixture({ withDm: true, withWriter: true });
  writeView(h.owner.session.scope, "draft:dm-room", "DM draft body");
  writeView(h.owner.session.scope, "draft:room", "Channel draft body");
  render(h.view);
  await screen.findByText("A direct reply");
  await chooseFilter("Drafts");
  expect(h.owner.session.channels.window("room").status).toBe("idle");
  expect(h.owner.session.channels.window("dm-room").status).toBe("idle");
  fireEvent.click(screen.getByRole("button", { name: "Open draft for Alice" }));
  const preview = () =>
    screen.getByRole("region", { name: "Conversation preview" });
  await waitFor(() =>
    expect(h.owner.session.channels.window("dm-room").status).toBe("ready"),
  );
  expect(
    h.owner.session.channels
      .window("dm-room")
      .rows.some((row) => row.content === "A direct reply"),
  ).toBe(true);
  expect(h.owner.session.channels.window("room").status).toBe("idle");
  expect(
    within(preview()).getByRole("textbox", { name: "Message DM with Alice" }),
  ).toHaveValue("DM draft body");
  expect(within(preview()).getAllByRole("form")).toHaveLength(1);
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  await waitFor(() =>
    expect(h.owner.session.channels.window("room").status).toBe("ready"),
  );
  expect(
    within(preview()).getByRole("textbox", { name: "Message #Design" }),
  ).toHaveValue("Channel draft body");
  expect(
    screen.queryByRole("textbox", { name: "Message DM with Alice" }),
  ).not.toBeInTheDocument();
  expect(readView(h.owner.session.scope, "draft:dm-room", "")).toBe(
    "DM draft body",
  );
});

it("a thread draft edits the viewer's own message like Channels and keeps the draft", async () => {
  const h = fixture({ withWriter: true });
  if (!h.root) throw new Error("Missing root");
  const key = `draft:room:thread:${h.root.id}`;
  writeView(h.owner.session.scope, key, "Thread draft body");
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Drafts");
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  const history = await screen.findByRole("region", {
    name: "Thread messages",
  });
  const row = (
    await within(history).findByText("Our discussion")
  ).closest<HTMLElement>("[data-message-id]");
  if (!row) throw new Error("Missing owned root");
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Reply to thread" }),
    ).toHaveValue("Thread draft body"),
  );
  fireEvent.focus(row);
  fireEvent.click(
    within(row).getByRole("button", { name: "More message actions" }),
  );
  expect(
    await screen.findByRole("menuitem", { name: "Delete message" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit message" }));
  const editor = await screen.findByRole("textbox", { name: "Edit message" });
  await waitFor(() => expect(editor).toHaveValue("Our discussion"));
  act(() => {
    (editor as HTMLTextAreaElement).value = "Corrected from Drafts";
  });
  fireEvent.input(editor);
  const form = editor.closest("form");
  if (!form) throw new Error("Missing edit composer form");
  fireEvent.submit(form);
  await waitFor(() =>
    expect(h.published.map((event) => event.kind)).toContain(40003),
  );
  expect(h.published.find((event) => event.kind === 40003)).toMatchObject({
    content: "Corrected from Drafts",
  });
  expect(
    await screen.findByRole("textbox", { name: "Reply to thread" }),
  ).toHaveValue("Thread draft body");
  expect(readView(h.owner.session.scope, key, "")).toBe("Thread draft body");
});

it("DM draft composer labels use exact roster participants and recover as profiles arrive", async () => {
  const h = fixture({ withDm: true, holdProfiles: true, withWriter: true });
  const key = "draft:dm-room";
  writeView(h.owner.session.scope, key, {
    text: "  hi\n  again ",
    recipients: [],
  });
  render(h.view);
  await screen.findByText("A direct reply");
  await chooseFilter("Drafts");
  const detail = () => screen.getByRole("region", { name: "Draft detail" });
  const row = screen.getByRole("list", { name: "Drafts" });
  expect(row).toHaveTextContent("DM");
  fireEvent.click(
    within(row).getByRole("button", { name: /^Open draft for / }),
  );
  expect(
    within(detail()).getByRole("heading", { name: "Direct message" }),
  ).toBeInTheDocument();
  expect(
    within(detail()).getByRole("textbox", { name: /Message DM with npub/ }),
  ).toHaveValue("  hi\n  again ");
  try {
    await act(async () => h.releaseProfiles());
    await waitFor(() =>
      expect(
        within(detail()).getByRole("textbox", {
          name: "Message DM with Alice",
        }),
      ).toBeInTheDocument(),
    );
    expect(h.journal()?.state.frontiers).toEqual({});
  } finally {
    h.releaseProfiles();
  }
});

it("holds selected history, surfaces failure, and retries to a genuinely empty channel without losing the draft", async () => {
  const h = fixture({ withDm: true, withWriter: true });
  writeView(
    h.owner.session.scope,
    "draft:dm-room",
    "Keep while history recovers",
  );
  render(h.view);
  await screen.findByText("A direct reply");
  await waitFor(() =>
    expect(
      screen.queryByText("Checking recent activity…"),
    ).not.toBeInTheDocument(),
  );
  await chooseFilter("Drafts");
  const release = h.holdHistory("dm-room");
  h.failHistory("dm-room");
  try {
    fireEvent.click(
      screen.getByRole("button", { name: "Open draft for Alice" }),
    );
    await waitFor(() => expect(h.historyRequests).toContain("dm-room"));
    expect(screen.queryByText("No messages yet.")).not.toBeInTheDocument();
    expect(h.owner.session.channels.window("dm-room").status).toBe("loading");
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  } finally {
    await act(async () => release());
  }
  expect(
    await screen.findByRole("button", { name: "Retry conversation" }),
  ).toBeInTheDocument();
  expect(
    screen
      .getAllByRole("alert")
      .some((node) => node.textContent?.includes("history offline")),
  ).toBe(true);
  expect(screen.queryByText("Loading conversation…")).not.toBeInTheDocument();
  act(() => h.deleteHistory("dm-room"));
  h.recoverHistory("dm-room");
  fireEvent.click(screen.getByRole("button", { name: "Retry conversation" }));
  await screen.findByText("No messages yet.");
  expect(
    screen.queryByRole("button", { name: "Retry conversation" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("textbox", { name: "Message DM with Alice" }),
  ).toHaveValue("Keep while history recovers");
});

it("retargets a held DM history without leaking the old context or draft and sends only to the selected channel", async () => {
  const h = fixture({ withDm: true, withWriter: true });
  writeView(h.owner.session.scope, "draft:dm-room", "Keep DM draft");
  writeView(h.owner.session.scope, "draft:room", "Send this channel draft");
  render(h.view);
  await screen.findByText("A direct reply");
  await chooseFilter("Drafts");
  const release = h.holdHistory("dm-room");
  try {
    fireEvent.click(
      screen.getByRole("button", { name: "Open draft for Alice" }),
    );
    await waitFor(() => expect(h.historyRequests).toContain("dm-room"));
    fireEvent.click(
      screen.getByRole("button", { name: "Open draft for #Design" }),
    );
    await waitFor(() =>
      expect(h.owner.session.channels.window("room").status).toBe("ready"),
    );
    expect(
      screen.getByRole("textbox", { name: "Message #Design" }),
    ).toHaveValue("Send this channel draft");
    expect(
      screen.queryByRole("textbox", { name: /Message DM/ }),
    ).not.toBeInTheDocument();
  } finally {
    await act(async () => release());
  }
  await waitFor(() =>
    expect(h.owner.session.channels.window("dm-room").status).toBe("ready"),
  );
  expect(screen.getAllByRole("textbox")).toHaveLength(1);
  const detail = screen.getByRole("region", { name: "Draft detail" });
  expect(
    within(detail).getByRole("region", { name: "Channel message history" }),
  ).toHaveAttribute("data-channel-timeline", "room");
  fireEvent.click(within(detail).getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(h.published).toHaveLength(1));
  expect(h.published[0]).toMatchObject({
    kind: 9,
    content: "Send this channel draft",
  });
  expect(h.published[0]?.tags).toContainEqual(["h", "room"]);
  expect(h.published[0]?.tags.some(([tag]) => tag === "e")).toBe(false);
  expect(readView(h.owner.session.scope, "draft:dm-room", "")).toBe(
    "Keep DM draft",
  );
});

it("renders an exact draft thread's real root and replies with one composer and sends to that root", async () => {
  const h = fixture({ withWriter: true });
  if (!h.root) throw new Error("Missing root");
  const key = `draft:room:thread:${h.root.id}`;
  writeView(h.owner.session.scope, key, "Thread draft to send");
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Drafts");
  const release = h.holdHistory("room");
  try {
    fireEvent.click(
      screen.getByRole("button", { name: "Open draft for #Design" }),
    );
    await waitFor(() => expect(h.exactRequests).toContain(h.root?.id));
    expect(
      screen.queryByRole("textbox", { name: "Reply to thread" }),
    ).not.toBeInTheDocument();
  } finally {
    await act(async () => release());
  }
  const history = await screen.findByRole("region", {
    name: "Thread messages",
  });
  await within(history).findByText("Our discussion");
  await within(history).findByText("A thread update");
  const input = await screen.findByRole("textbox", { name: "Reply to thread" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled(),
  );
  expect(input).toHaveValue("Thread draft to send");
  expect(screen.getAllByRole("textbox")).toHaveLength(1);
  expect(h.historyRequests).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(h.published).toHaveLength(1));
  expect(h.published[0]?.tags).toContainEqual(["h", "room"]);
  expect(h.published[0]?.tags).toContainEqual(["e", h.root.id, "", "reply"]);
  expect(readView(h.owner.session.scope, key, "")).toMatchObject({ text: "" });
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Draft detail" }),
    ).not.toBeInTheDocument(),
  );
});

it("keeps the scoped draft but removes its thread composer and history when the root is deleted", async () => {
  const h = fixture({ withWriter: true });
  if (!h.root) throw new Error("Missing root");
  const key = `draft:room:thread:${h.root.id}`;
  writeView(h.owner.session.scope, key, "Do not retarget this reply");
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Drafts");
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  await screen.findByRole("textbox", { name: "Reply to thread" });
  act(() => h.retireThreadRoot());
  await waitFor(() =>
    expect(
      screen.queryByRole("textbox", { name: "Reply to thread" }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.queryByText("Our discussion")).not.toBeInTheDocument();
  expect(readView(h.owner.session.scope, key, "")).toBe(
    "Do not retarget this reply",
  );
  expect(h.published).toHaveLength(0);
});

it("retries thread history failure without another composer and never rebinds a malformed saved thread coordinate", async () => {
  const h = fixture({ withWriter: true });
  if (!h.root) throw new Error("Missing root");
  const key = `draft:room:thread:${h.root.id}`;
  writeView(h.owner.session.scope, key, "Retry this thread draft");
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Drafts");
  h.failHistory("room");
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  const retry = await screen.findByRole("button", { name: "Try again" });
  expect(
    screen.queryByRole("textbox", { name: "Reply to thread" }),
  ).not.toBeInTheDocument();
  h.recoverHistory("room");
  fireEvent.click(retry);
  const composer = await screen.findByRole("textbox", {
    name: "Reply to thread",
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled(),
  );
  expect(composer).toHaveValue("Retry this thread draft");
  fireEvent.click(screen.getByRole("button", { name: "Close detail" }));
  // A saved reply ID cannot silently resolve to another root-keyed draft.
  act(() => {
    writeView(h.owner.session.scope, key, "");
    writeView(
      h.owner.session.scope,
      `draft:room:thread:${h.reply.id}`,
      "Invalid coordinate draft",
    );
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  await screen.findByText(/This saved draft does not identify a thread root/);
  expect(
    screen.queryByRole("textbox", { name: "Reply to thread" }),
  ).not.toBeInTheDocument();
  expect(
    readView(h.owner.session.scope, `draft:room:thread:${h.reply.id}`, ""),
  ).toBe("Invalid coordinate draft");
  expect(h.published).toHaveLength(0);
});

it("sends a DM draft only to its restored destination through the session outbox", async () => {
  const h = fixture({ withDm: true, withWriter: true });
  writeView(h.owner.session.scope, "draft:dm-room", "Only this DM");
  render(h.view);
  await screen.findByText("A direct reply");
  await chooseFilter("Drafts");
  fireEvent.click(screen.getByRole("button", { name: "Open draft for Alice" }));
  const detail = screen.getByRole("region", { name: "Draft detail" });
  expect(
    within(detail).getByRole("textbox", { name: "Message DM with Alice" }),
  ).toHaveValue("Only this DM");
  fireEvent.click(within(detail).getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(h.published).toHaveLength(1));
  expect(h.published[0]).toMatchObject({ kind: 9, content: "Only this DM" });
  expect(h.published[0]?.tags).toContainEqual(["h", "dm-room"]);
  expect(h.published[0]?.tags.some(([tag]) => tag === "e")).toBe(false);
});

it("meaningful Drafts survive 500 empty records and keep an emptied selected editor until close", async () => {
  const h = fixture({ withWriter: true });
  for (let i = 0; i < 510; i++)
    writeView(h.owner.session.scope, `draft:empty-${i}`, { text: "  " });
  writeView(h.owner.session.scope, "draft:room", {
    text: "Keep editing",
    recipients: [],
  });
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Drafts");
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  const editor = await screen.findByRole("textbox", {
    name: "Message #Design",
  });
  fireEvent.change(editor, { target: { value: "" } });
  await waitFor(() =>
    expect(
      readView(h.owner.session.scope, "draft:room", "missing"),
    ).toMatchObject({ text: "" }),
  );
  expect(screen.getByRole("textbox", { name: "Message #Design" })).toBe(editor);
  expect(
    screen.getByRole("region", { name: "Draft detail" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close detail" }));
  expect(
    screen.queryByRole("region", { name: "Draft detail" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("No drafts")).toBeInTheDocument();
});
it("a typed tag with nothing after it is listed like any other draft; the follow-up an earlier release saved is not", async () => {
  const h = fixture({ withDm: true, withWriter: true });
  // Releases through preview.177.1 saved the remembered-agent follow-up as
  // the draft, without a snapshot; relay history seeds it now. The composer
  // saves no tags of its own, so a tag saved with the editor snapshot every
  // typed draft carries is the person's.
  const legacy = followupDraft([{ pubkey: h.alice.pubkey, name: "Alice" }]);
  const tagOnly = typedDraft(legacy);
  writeView(h.owner.session.scope, "draft:dm-room", tagOnly);
  writeView(h.owner.session.scope, "draft:room", legacy);
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Drafts");
  expect(
    screen.getByRole("button", { name: "Open draft for Alice" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Open draft for #Design" }),
  ).toBeNull();
  expect(readView(h.owner.session.scope, "draft:dm-room", "")).toEqual(tagOnly);
  expect(readView(h.owner.session.scope, "draft:room", "")).toEqual(legacy);
});
it("lists a tagged draft that holds attached files", async () => {
  const h = fixture({
    withDm: true,
    withWriter: true,
    upload: async () => ({
      name: "note.txt",
      url: "https://relay.test/media/note.txt",
      type: "text/plain",
      size: 4,
      sha256: "a".repeat(64),
    }),
  });
  writeView(h.owner.session.scope, "draft:dm-room", {
    text: "@Alice ",
    recipients: [{ pubkey: h.alice.pubkey, name: "Alice", start: 0, end: 6 }],
  });
  const files = renderHook(() =>
    useAttachmentDraft(
      h.observedSession,
      `${h.owner.session.scope}:draft:dm-room`,
      "dm-room",
    ),
  );
  act(() => {
    files.result.current.store.add([
      new File(["note"], "note.txt", { type: "text/plain" }),
    ]);
  });
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Drafts");
  expect(
    screen.getByRole("button", { name: "Open draft for Alice" }),
  ).toBeInTheDocument();
});
it("lists an emptied draft as soon as files return to it, with no text change", async () => {
  const h = fixture({
    withDm: true,
    withWriter: true,
    upload: async () => ({
      name: "note.txt",
      url: "https://relay.test/media/note.txt",
      type: "text/plain",
      size: 4,
      sha256: "a".repeat(64),
    }),
  });
  // The empty stub a send leaves behind.
  writeView(h.owner.session.scope, "draft:dm-room", {
    text: "",
    recipients: [],
  });
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Drafts");
  expect(
    screen.queryByRole("button", { name: "Open draft for Alice" }),
  ).not.toBeInTheDocument();
  // As when a failed background send hands its files back to the draft.
  act(() => {
    attachmentDraft(
      h.observedSession,
      `${h.owner.session.scope}:draft:dm-room`,
      "dm-room",
    ).add([new File(["note"], "note.txt", { type: "text/plain" })]);
  });
  expect(
    await screen.findByRole("button", { name: "Open draft for Alice" }),
  ).toBeInTheDocument();
});
it("hands keyboard focus into draft deletion and back on cancel without changing the saved draft", async () => {
  const h = fixture({ withWriter: true });
  writeView(h.owner.session.scope, "draft:room", "Keep this draft");
  render(h.view);
  await screen.findByText("Please review this");
  const user = userEvent.setup();
  await chooseFilter("Drafts");
  await user.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  const trigger = screen.getByRole("button", { name: "Delete draft…" });
  trigger.focus();
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("alertdialog", {
    name: "Delete draft?",
  });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(dialog).toHaveAccessibleDescription(
    "Delete this saved draft and its attachments on this device? This cannot be undone.",
  );
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus(),
  );
  await user.keyboard("{Enter}");
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(screen.getByRole("region", { name: "Draft detail" })).toBeVisible();
  expect(readView(h.owner.session.scope, "draft:room", "")).toBe(
    "Keep this draft",
  );
  await user.keyboard("{Enter}");
  const reopened = await screen.findByRole("alertdialog", {
    name: "Delete draft?",
  });
  await waitFor(() =>
    expect(
      within(reopened).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus(),
  );
  await user.keyboard("{Escape}");
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Draft detail" })).toBeVisible();
  expect(readView(h.owner.session.scope, "draft:room", "")).toBe(
    "Keep this draft",
  );
});

it("Delete draft clears exact ready attachments but preserves sibling channel and thread files", async () => {
  const h = fixture({
    withWriter: true,
    upload: async () => ({
      name: "note.txt",
      url: "https://relay.test/media/note.txt",
      type: "text/plain",
      size: 4,
      sha256: "a".repeat(64),
    }),
  });
  const key = "draft:room";
  const root = h.root;
  if (!root) throw Error("Missing fixture root");
  writeView(h.owner.session.scope, key, "Discard this text");
  writeView(h.owner.session.scope, "draft:dm-room", "Another draft");
  const exact = renderHook(() =>
    useAttachmentDraft(
      h.observedSession,
      `${h.owner.session.scope}:${key}`,
      "room",
    ),
  );
  const sibling = renderHook(() =>
    useAttachmentDraft(
      h.observedSession,
      `${h.owner.session.scope}:draft:room:thread:${root.id}`,
      "room",
    ),
  );
  const file = new File(["note"], "note.txt", { type: "text/plain" });
  act(() => {
    exact.result.current.store.add([file]);
    sibling.result.current.store.add([file]);
  });
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Drafts");
  // The sibling thread now appears too, even though it has files only.
  expect(screen.getByText("Attachment")).toBeVisible();
  const target = screen.getByText("Discard this text").closest("button");
  if (!target) throw new Error("Missing draft control");
  fireEvent.click(target);
  fireEvent.click(screen.getByRole("button", { name: "Delete draft…" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete draft" }));
  expect(readView(h.owner.session.scope, key, "")).toBe("");
  expect(exact.result.current.items).toEqual([]);
  expect(sibling.result.current.items).toHaveLength(1);
  expect(readView(h.owner.session.scope, "draft:dm-room", "")).toBe(
    "Another draft",
  );
});

it("a failed saved-text cleanup keeps its exact attachment draft for retry", async () => {
  const h = fixture({
    withWriter: true,
    upload: async () => ({
      name: "keep.txt",
      url: "https://relay.test/media/keep.txt",
      type: "text/plain",
      size: 4,
      sha256: "b".repeat(64),
    }),
  });
  const key = "draft:room";
  writeView(h.owner.session.scope, key, "Keep this body");
  const files = renderHook(() =>
    useAttachmentDraft(
      h.observedSession,
      `${h.owner.session.scope}:${key}`,
      "room",
    ),
  );
  act(() => files.result.current.store.add([new File(["keep"], "keep.txt")]));
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Drafts");
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete draft…" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus(),
  );
  const denied = vi
    .spyOn(Storage.prototype, "removeItem")
    .mockImplementation(() => {
      throw Error("disk full");
    });
  try {
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Delete draft" }));
    expect(
      screen.getByRole("alertdialog", { name: "Delete draft?" }),
    ).toHaveTextContent("disk full");
    expect(readView(h.owner.session.scope, key, "")).toBe("Keep this body");
    expect(files.result.current.items).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Delete draft" })).toHaveFocus();
  } finally {
    denied.mockRestore();
  }
  fireEvent.click(screen.getByRole("button", { name: "Delete draft" }));
  expect(readView(h.owner.session.scope, key, "")).toBe("");
  expect(files.result.current.items).toEqual([]);
});

it.each([false, true])(
  "retains accepted %s draft cleanup recovery without publishing twice, including reopen",
  async (thread) => {
    const h = fixture({ withWriter: true });
    const key = thread ? `draft:room:thread:${h.mention.id}` : "draft:room";
    const storageKey = `buzz-view.v1:${JSON.stringify([h.owner.session.scope, key])}`;
    writeView(h.owner.session.scope, key, "Accepted body");
    render(h.view);
    await screen.findByText("Please review this");
    await chooseFilter("Drafts");
    fireEvent.click(
      screen.getByRole("button", { name: "Open draft for #Design" }),
    );
    await screen.findByRole("textbox");
    const original = Storage.prototype.setItem;
    const fail = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === storageKey) throw Error("Storage full");
        return original.call(this, key, value);
      });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(h.published).toHaveLength(1));
      expect(
        screen.getByRole("region", { name: "Draft detail" }),
      ).toBeVisible();
      expect(screen.getByRole("alert")).toHaveTextContent(/accepted.*draft/i);
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeDisabled();
      fireEvent.click(
        screen.getByRole("button", {
          name: "Close detail",
        }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Open draft for #Design" }),
      );
      await screen.findByRole("button", { name: "Retry draft cleanup" });
      expect(screen.getByRole("textbox")).toHaveValue("");
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeDisabled();
    } finally {
      fail.mockRestore();
    }
    fireEvent.click(
      screen.getByRole("button", { name: "Retry draft cleanup" }),
    );
    expect(
      screen.queryByRole("region", { name: "Draft detail" }),
    ).not.toBeInTheDocument();
    expect(readView(h.owner.session.scope, key, "")).toMatchObject({
      text: "",
    });
    expect(h.published).toHaveLength(1);
  },
);

function replaceStoredDraft(scope: string, key: string, text: string) {
  const storageKey = `buzz-view.v1:${JSON.stringify([scope, key])}`;
  act(() => {
    localStorage.setItem(storageKey, JSON.stringify({ text, recipients: [] }));
    window.dispatchEvent(
      new StorageEvent("storage", {
        storageArea: localStorage,
        key: storageKey,
      }),
    );
  });
}

it("reloads a clean selected editor with the row and requires a dirty conflict choice without remounting", async () => {
  const h = fixture({ withWriter: true });
  const scope = h.owner.session.scope,
    key = "draft:room";
  writeView(scope, key, "Original body");
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Drafts");
  const row = screen.getByRole("button", { name: "Open draft for #Design" });
  fireEvent.click(row);
  const input = screen.getByRole(
    "textbox",
  ) as import("../../features/messages/composer-dom").ComposerInputElement;
  replaceStoredDraft(scope, key, "Other window revision");
  expect(row).toHaveTextContent("Other window revision");
  fireEvent.click(row);
  expect(screen.getByRole("textbox")).toBe(input);
  expect(input).toHaveValue("Other window revision");
  fireEvent.change(input, { target: { value: "My local edits" } });
  replaceStoredDraft(scope, key, "Newer saved work");
  fireEvent.click(row);
  expect(input).toHaveValue("My local edits");
  expect(screen.getByRole("alert")).toHaveTextContent(/changed elsewhere/i);
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  fireEvent.change(input, { target: { value: "More local edits" } });
  expect(readView(scope, key, "")).toMatchObject({ text: "Newer saved work" });
  fireEvent.click(screen.getByRole("button", { name: "Keep my draft" }));
  expect(readView(scope, key, "")).toMatchObject({ text: "More local edits" });
  replaceStoredDraft(scope, key, "Last saved work");
  fireEvent.click(screen.getByRole("button", { name: "Load saved draft" }));
  expect(input).toHaveValue("Last saved work");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(h.published).toHaveLength(0);
});

it("keeps a valid rich editor mounted across 128 KiB and reopens the saved document", async () => {
  const h = fixture({ withWriter: true });
  const { mentionDraft } = await import(
    "../../features/messages/mention-draft"
  );
  const { readComposerSnapshot } = await import(
    "../../features/messages/composer-document"
  );
  const document = {
    version: 1,
    content: {
      type: "doc",
      content: Array.from({ length: 1898 }, () => ({
        type: "paragraph",
        content: [{ type: "text", text: "note" }],
      })),
    },
  };
  expect(readComposerSnapshot(document)).toBeDefined();
  const rich = mentionDraft({ document });
  expect(JSON.stringify(rich).length).toBeLessThan(128 * 1024);
  writeView(h.owner.session.scope, "draft:room", rich);
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Drafts");
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  const input = screen.getByRole(
    "textbox",
  ) as import("../../features/messages/composer-dom").ComposerInputElement;
  act(() => {
    input.setSelectionRange(input.value.length, input.value.length);
    input.insertText(" plus twelve new letters");
  });
  expect(screen.getByRole("textbox")).toBe(input);
  const saved = readView(h.owner.session.scope, "draft:room", rich);
  expect(JSON.stringify(saved).length).toBeGreaterThan(128 * 1024);
  expect(readComposerSnapshot(saved.document)).toBeDefined();
  expect(mentionDraft(saved).text).toBe(`${rich.text} plus twelve new letters`);
  fireEvent.click(screen.getByRole("button", { name: "Close detail" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  expect(screen.getByRole("textbox")).toHaveValue(mentionDraft(saved).text);
});

it("discloses records beyond the bounded preview without retiring a selected editor", async () => {
  const h = fixture({ withWriter: true });
  const key = `buzz-view.v1:${JSON.stringify([h.owner.session.scope, "draft:room"])}`;
  writeView(h.owner.session.scope, "draft:room", "Kept in the selected editor");
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Drafts");
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "My retained edits" } });
  const getItem = Storage.prototype.getItem;
  const oversized = JSON.stringify({ text: "x".repeat(8 * 1024 * 1024) });
  const read = vi
    .spyOn(Storage.prototype, "getItem")
    .mockImplementation(function (this: Storage, storageKey) {
      return storageKey === key ? oversized : getItem.call(this, storageKey);
    });
  try {
    act(() =>
      window.dispatchEvent(
        new StorageEvent("storage", { storageArea: localStorage, key }),
      ),
    );
    expect(
      screen.getByText(/saved drafts exceed the preview size limit/),
    ).toBeVisible();
    expect(screen.queryByText("No drafts")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBe(input);
    expect(input).toHaveValue("My retained edits");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  } finally {
    read.mockRestore();
  }
});

it.each(["channel", "thread", "unavailable"])(
  "returns focus to the invoking %s draft after Close",
  async (kind) => {
    const h = fixture({ withWriter: true });
    const key =
      kind === "thread"
        ? `draft:room:thread:${h.mention.id}`
        : kind === "unavailable"
          ? "draft:missing"
          : "draft:room";
    writeView(h.owner.session.scope, key, "Keep my place");
    render(h.view);
    await screen.findByText("Please review this");
    const user = userEvent.setup();
    await chooseFilter("Drafts");
    const row = screen.getByRole("button", { name: /^Open draft for/ });
    await user.click(row);
    const close = await screen.findByRole("button", {
      name: "Close detail",
    });
    close.focus();
    await user.keyboard("{Enter}");
    expect(row).toHaveFocus();
    expect(
      screen.queryByRole("region", { name: "Draft detail" }),
    ).not.toBeInTheDocument();
  },
);

it.each(["delete", "send", "empty-close"])(
  "restores focus to a remaining row then Inbox filters on %s",
  async (exit) => {
    const h = fixture({ withWriter: true, withDm: true });
    writeView(h.owner.session.scope, "draft:room", "First draft");
    writeView(h.owner.session.scope, "draft:dm-room", "Second draft");
    render(h.view);
    await screen.findByText("Please review this");
    const user = userEvent.setup();
    await chooseFilter("Drafts");
    const remaining = screen.getByRole("button", {
      name: "Open draft for Alice",
    });
    for (const name of ["Open draft for #Design", "Open draft for Alice"]) {
      await user.click(screen.getByRole("button", { name }));
      const editor = await screen.findByRole("textbox");
      if (exit === "empty-close")
        fireEvent.change(editor, { target: { value: "" } });
      if (exit === "delete")
        await user.click(screen.getByRole("button", { name: "Delete draft…" }));
      const control = screen.getByRole("button", {
        name:
          exit === "delete"
            ? "Delete draft"
            : exit === "send"
              ? "Send message"
              : "Close detail",
      });
      control.focus();
      await user.keyboard("{Enter}");
      expect(
        screen.queryByRole("region", { name: "Draft detail" }),
      ).not.toBeInTheDocument();
      expect(
        name === "Open draft for #Design"
          ? remaining
          : screen.getByRole("button", { name: "Inbox filters" }),
      ).toHaveFocus();
    }
  },
);

it.each([false, true])(
  "ignores a retired visit's saved-send callback after retargeting (thread: %s)",
  async (thread) => {
    const h = fixture({ withWriter: true, withDm: true });
    writeView(
      h.owner.session.scope,
      thread ? `draft:room:thread:${h.mention.id}` : "draft:room",
      "First draft",
    );
    writeView(h.owner.session.scope, "draft:dm-room", "Second draft");
    render(h.view);
    await screen.findByText("Please review this");
    const user = userEvent.setup();
    await chooseFilter("Drafts");
    const firstRow = screen.getByRole("button", {
      name: "Open draft for #Design",
    });
    await user.click(firstRow);
    await screen.findByRole("textbox");
    // Spy calls still execute the real components/hooks. Retain just the old
    // callback to control its delivery after the visit has been replaced.
    const retired = thread
      ? vi.mocked(ThreadPanel).mock.calls.at(-1)?.[0].onDraftSaved
      : vi.mocked(ChannelPreview).mock.calls.at(-1)?.[0].onDraftSaved;
    expect(retired).toBeTypeOf("function");
    await user.click(
      screen.getByRole("button", { name: "Open draft for Alice" }),
    );
    await screen.findByRole("textbox", { name: "Message DM with Alice" });
    // Even returning to the same draft key is a new visit, not the old callback's target.
    await user.click(firstRow);
    const current = await screen.findByRole("textbox");
    current.focus();
    act(() => retired?.());
    expect(
      screen.getByRole("region", { name: "Draft detail" }),
    ).toBeInTheDocument();
    expect(current).toHaveFocus();
  },
);

it("sending a remembered-agent draft leaves no follow-up row, and focus moves to the remaining row", async () => {
  const h = fixture({ withWriter: true, withDm: true, connected: true });
  writeView(h.owner.session.scope, "draft:room", "First row, not the invoker");
  writeView(h.owner.session.scope, "draft:dm-room", {
    text: "@Alice Hello",
    recipients: [{ pubkey: h.alice.pubkey, name: "Alice", start: 0, end: 6 }],
  });
  const agent = profile(
    h.alice,
    { name: "Alice", isAgent: true },
    1_700_000_001,
  );
  h.addEvent(agent);
  h.emit([agent]);
  await h.observedSession.profiles.ensure([h.alice.pubkey], "background");
  expect(
    h.observedSession.profiles.snapshot().get(h.alice.pubkey)?.isAgent,
  ).toBe(true);
  render(h.view);
  await screen.findByText("Please review this");
  const user = userEvent.setup();
  await chooseFilter("Drafts");
  const row = screen.getByRole("button", { name: "Open draft for Alice" });
  await user.click(row);
  await screen.findByRole("textbox");
  const send = screen.getByRole("button", { name: "Send message" });
  send.focus();
  await user.keyboard("{Enter}");
  expect(
    screen.queryByRole("region", { name: "Draft detail" }),
  ).not.toBeInTheDocument();
  // Remembered agents live in memory and relay history, not in a draft: the
  // sent draft's row is gone and focus moves to the remaining row.
  expect(row).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  ).toHaveFocus();
  expect(readView(h.owner.session.scope, "draft:dm-room", "")).toMatchObject({
    text: "",
  });
});

it("a thread-starting send leaves no thread draft in storage or the Drafts list", async () => {
  const h = fixture({ withWriter: true, connected: true });
  writeView(h.owner.session.scope, "draft:room", {
    text: "@Alice Hello",
    recipients: [{ pubkey: h.alice.pubkey, name: "Alice", start: 0, end: 6 }],
  });
  const agent = profile(
    h.alice,
    { name: "Alice", isAgent: true },
    1_700_000_001,
  );
  h.addEvent(agent);
  h.emit([agent]);
  await h.observedSession.profiles.ensure([h.alice.pubkey], "background");
  expect(
    h.observedSession.profiles.snapshot().get(h.alice.pubkey)?.isAgent,
  ).toBe(true);
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Drafts");
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  await screen.findByRole("textbox");
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(h.published).toHaveLength(1));
  expect(h.published[0]?.tags).toContainEqual(["p", h.alice.pubkey]);
  expect(
    Object.keys(localStorage).filter((key) =>
      key.includes("draft:room:thread:"),
    ),
  ).toEqual([]);
  expect(readView(h.owner.session.scope, "draft:room", "")).toMatchObject({
    text: "",
  });
  expect(
    screen.queryByRole("button", { name: /^Open draft for/ }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("No drafts")).toBeVisible();
});

it.each([true, false])(
  "retires an excluded draft with focus owned=%s and preserves storage",
  async (ownedFocus) => {
    const h = fixture({ withWriter: true });
    writeView(h.owner.session.scope, "draft:room", "Private draft text");
    render(
      <>
        <button type="button">Outside draft</button>
        {h.view}
      </>,
    );
    await screen.findByText("Please review this");
    await chooseFilter("Drafts");
    fireEvent.click(
      screen.getByRole("button", { name: "Open draft for #Design" }),
    );
    await screen.findByRole("region", { name: "Draft detail" });
    const outside = screen.getByRole("button", { name: "Outside draft" });
    (ownedFocus
      ? screen.getByRole("button", { name: "Close detail" })
      : outside
    ).focus();
    await act(async () =>
      h.emit([
        metadata(h.relayKey, "room", "Huddle", 100, [
          ["private"],
          ["P", h.viewer.pubkey],
          ["about", huddleDescription("00000000-0000-4000-8000-000000000001")],
        ]),
        signed(h.viewer, {
          kind: 9007,
          created_at: 1,
          content: "",
          tags: [
            ["h", "room"],
            ["visibility", "private"],
            ["channel_type", "stream"],
            [
              "about",
              huddleDescription("00000000-0000-4000-8000-000000000001"),
            ],
          ],
        }),
      ]),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Draft detail" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("Private draft text")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Open draft for/ }),
    ).not.toBeInTheDocument();
    expect(readView(h.owner.session.scope, "draft:room", "")).toBe(
      "Private draft text",
    );
    await waitFor(() =>
      expect(
        ownedFocus
          ? screen.getByRole("button", { name: "Inbox filters" })
          : outside,
      ).toHaveFocus(),
    );
    await act(async () =>
      h.emit([metadata(h.relayKey, "room", "Restored", 101)]),
    );
    expect(
      screen.queryByRole("region", { name: "Draft detail" }),
    ).not.toBeInTheDocument();
  },
);

it("withholds drafts with pending metadata and restores ordinary destinations after discovery", async () => {
  const h = fixture();
  writeView(h.owner.session.scope, "draft:pending", "Unclassified draft");
  render(h.view);
  await screen.findByText("Please review this");
  await act(async () =>
    h.emit([roster(h.relayKey, "pending", [h.viewer.pubkey], 100)]),
  );
  await chooseFilter("Drafts");
  expect(screen.queryByText("Unclassified draft")).not.toBeInTheDocument();
  await act(async () =>
    h.emit([metadata(h.relayKey, "pending", "Resolved", 101)]),
  );
  expect(
    await screen.findByRole("button", { name: "Open draft for #Resolved" }),
  ).toBeInTheDocument();
  expect(readView(h.owner.session.scope, "draft:pending", "")).toBe(
    "Unclassified draft",
  );
});

it.each([false, true])(
  "discovers and reopens a card-only saved draft (thread: %s)",
  async (thread) => {
    const h = fixture({ withWriter: true });
    const key = thread ? `draft:room:thread:${h.mention.id}` : "draft:room";
    const link = "[Session: Fix](buzz://channel/session-id)";
    writeView(h.owner.session.scope, key, {
      text: "",
      recipients: [],
      chatCards: [link],
    });
    render(h.view);
    await screen.findByText("Please review this");
    await chooseFilter("Drafts");
    const list = screen.getByRole("list", { name: "Drafts" });
    expect(list).toHaveTextContent("Chat attachment");
    await userEvent
      .setup()
      .click(
        within(list).getByRole("button", { name: "Open draft for #Design" }),
      );
    const detail = await screen.findByRole("region", { name: "Draft detail" });
    await waitFor(() =>
      expect(
        within(detail).getByRole("button", {
          name: "Remove chat attachment 1",
        }),
      ).toBeVisible(),
    );
    expect(within(detail).getByRole("textbox")).toHaveValue("");
    expect(readView(h.owner.session.scope, key, null)).toMatchObject({
      chatCards: [link],
    });
  },
);
