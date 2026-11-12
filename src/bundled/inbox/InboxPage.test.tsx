const emptyPanels: never[] = [];
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cloneElement, StrictMode, type ReactElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { PageTabs } from "../channels/PageTabs";
import { InboxPage } from "./InboxPage";
import { InboxPreview } from "./InboxPreview";
import { huddleDescription } from "../../features/huddle/lifecycle";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { writeView } from "../../shared/view-state";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
import type { ComposerInputElement } from "../../features/messages/composer-dom";
import { createRelaySession } from "../../features/relay/session";
import type { RelaySnapshot, RelayData } from "../../features/relay/service";
import type { Navigation } from "../../features/navigation/controller";
import type { PageNavigation } from "../../features/navigation/service";
import { inboxRouteTarget, inboxTarget, type InboxRoute } from "./route";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import { matchesEvent } from "../../features/relay/projection";
import {
  readJournal,
  newReadJournal,
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
import { mediaUrl } from "../../features/relay/transport";
import {
  decodeReadState,
  signReadState,
  // @ts-expect-error Node host codec, with disposable test identities only.
} from "../../../browser-host/read-state.mjs";

const owners: ReturnType<typeof createRelaySession>[] = [];
composerDOMFixture();
beforeEach(() => localStorage.clear());
stubAvatarBrowserApis();
HTMLElement.prototype.scrollIntoView = vi.fn();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
});

it.each([false, true])(
  "retires a conversation moved to the main pane when its room becomes a Huddle (focus elsewhere: %s)",
  async (elsewhere) => {
    const h = fixture({ withWriter: true });
    render(h.view);
    const list = () => within(screen.getByRole("list", { name: "Activity" }));
    await waitFor(() =>
      expect(list().getAllByRole("button", { name: /^Open / })).toHaveLength(2),
    );
    const [first] = list().getAllByRole("button", { name: /^Open / });
    if (!first) throw new Error("Missing fixture row");
    fireEvent.click(first);
    await findReader();
    const [label] = sideTabs();
    if (!label) throw new Error("Missing side tab");
    act(() => {
      fireEvent.keyDown(screen.getByRole("tab", { name: label }), {
        key: "ArrowLeft",
        altKey: true,
        shiftKey: true,
      });
    });
    expect(tabs("Activity tabs")).toHaveLength(2);
    // Another visible control, such as the app's sidebar, keeps its focus.
    const other = document.body.appendChild(document.createElement("button"));
    if (elsewhere) other.focus();
    else (await screen.findByRole("textbox")).focus();
    const about = huddleDescription("00000000-0000-4000-8000-000000000001");
    act(() =>
      h.emit([
        metadata(h.relayKey, "room", "Huddle", 100, [
          ["private"],
          ["P", h.viewer.pubkey],
          ["about", about],
        ]),
        signed(h.viewer, {
          kind: 9007,
          created_at: 1,
          content: "",
          tags: [
            ["h", "room"],
            ["visibility", "private"],
            ["channel_type", "stream"],
            ["about", about],
          ],
        }),
      ]),
    );
    await waitFor(() => expect(tabs("Activity tabs")).toHaveLength(1));
    expect(queryReader()).not.toBeInTheDocument();
    if (elsewhere) expect(other).toHaveFocus();
    else expect(fromTrigger()).toHaveFocus();
    other.remove();
  },
);

// The Archived view was the only way to end a selection while keeping its tab;
// its cases ("selection cleared first: true") left with it.
it.each([
  [false, false],
  [false, true],
])(
  "retires an opened conversation when its room becomes a Huddle (selection cleared first: %s, focus in a link dialog: %s)",
  async (cleared, dialog) => {
    const h = fixture({ withWriter: true });
    render(h.view);
    const list = () => within(screen.getByRole("list", { name: "Activity" }));
    await waitFor(() =>
      expect(list().getAllByRole("button", { name: /^Open / })).toHaveLength(2),
    );
    const [first] = list().getAllByRole("button", { name: /^Open / });
    if (!first) throw new Error("Missing fixture row");
    fireEvent.click(first);
    await waitFor(() =>
      expect(
        reader().querySelector(`[data-message-id="${h.reply.id}"]`),
      ).toHaveFocus(),
    );
    (await screen.findByRole("textbox")).focus();
    if (dialog) {
      // The dialog is portalled outside the tab that owns it.
      fireEvent.click(
        screen.getByRole("button", { name: "Toggle formatting" }),
      );
      fireEvent.click(screen.getByRole("button", { name: /^Link/ }));
      const [url] = within(
        await screen.findByRole("dialog", { name: "Add link" }),
      ).getAllByRole("textbox");
      url?.focus();
      expect(url).toHaveFocus();
    }
    const about = huddleDescription("00000000-0000-4000-8000-000000000001");
    act(() =>
      h.emit([
        metadata(h.relayKey, "room", "Huddle", 100, [
          ["private"],
          ["P", h.viewer.pubkey],
          ["about", about],
        ]),
        signed(h.viewer, {
          kind: 9007,
          created_at: 1,
          content: "",
          tags: [
            ["h", "room"],
            ["visibility", "private"],
            ["channel_type", "stream"],
            ["about", about],
          ],
        }),
      ]),
    );
    await waitFor(() => expect(queryReader()).not.toBeInTheDocument());
    if (cleared) {
      expect(
        screen.getByText("This conversation is no longer available."),
      ).toBeInTheDocument();
      // The retained tab keeps focus its reader held.
      expect(document.activeElement).toHaveAttribute("role", "tab");
      expect(document.activeElement).toHaveAttribute("aria-selected", "true");
    } else {
      expect(sideTabs()).toEqual([]);
      expect(fromTrigger()).toHaveFocus();
    }
  },
);

it("returns the list to its last offset in the same session", async () => {
  const h = fixture();
  const view = render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  expect(scroller()?.scrollTop).toBe(0);
  scrollTo(120);
  view.unmount();
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  expect(scroller()?.scrollTop).toBe(120);
});

it("does not override a scroll made before the list's rows arrive", async () => {
  const h = fixture();
  const view = render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  scrollTo(120);
  await chooseFilter("Unread only", "Attention");
  view.unmount();
  await act(async () => {
    await h.owner.session.unread.markChannelRead("room");
  });
  render(h.view);
  await screen.findByText("All caught up");
  // Compositor scrolling can move the list before its scroll event arrives.
  const list = scroller();
  if (!list) throw new Error("Missing Activity scroller");
  list.scrollTop = 40;
  const mention = message(
    h.alice,
    "room",
    "Fresh mention",
    Math.floor(Date.now() / 1000) + 5,
    [["p", h.viewer.pubkey]],
  );
  h.addEvent(mention);
  act(() => h.emit([mention]));
  await waitFor(() => expect(rows()).toHaveLength(1));
  expect(scroller()?.scrollTop).toBe(40);
});

it("keeps a saved offset off a list the user refilters", async () => {
  const h = fixture();
  const view = render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  scrollTo(120);
  await chooseFilter("Unread only", "Attention");
  view.unmount();
  await act(async () => {
    await h.owner.session.unread.markChannelRead("room");
  });
  const returned = render(h.view);
  await screen.findByText("All caught up");
  // Rows the user's filter change shows are not the list the offset was for.
  await chooseFilter("All", "Attention");
  await waitFor(() => expect(rows()).toHaveLength(2));
  expect(scroller()?.scrollTop).toBe(0);
  // The next return still restores the offset scrolled last.
  scrollTo(40);
  returned.unmount();
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  expect(scroller()?.scrollTop).toBe(40);
});

it("neither measures nor places the list until a tab moved to the main pane uncovers it", async () => {
  const h = fixture();
  const view = render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  const list = scroller();
  if (!list) throw new Error("Missing Activity scroller");
  scrollTo(120);
  const [first] = rows();
  if (!first) throw new Error("Missing fixture row");
  fireEvent.click(within(first).getByRole("button", { name: /^Open / }));
  await findReader();
  const [label] = sideTabs();
  if (!label) throw new Error("Missing side tab");
  act(() => {
    fireEvent.keyDown(screen.getByRole("tab", { name: label }), {
      key: "ArrowLeft",
      altKey: true,
      shiftKey: true,
    });
  });
  expect(tabs("Activity tabs")).toHaveLength(2);
  expect(list.closest("[inert]")).not.toBeNull();
  // The covered list keeps its selected row, which an update would measure.
  expect(list.querySelector("li[data-selected]")).not.toBeNull();
  const measure = vi.spyOn(Element.prototype, "getBoundingClientRect");
  try {
    const mention = message(
      h.alice,
      "room",
      "Fresh mention",
      Math.floor(Date.now() / 1000) + 5,
      [["p", h.viewer.pubkey]],
    );
    h.addEvent(mention);
    act(() => h.emit([mention]));
    await waitFor(() => expect(list).toHaveTextContent("Fresh mention"));
    // Rows arriving above a scrolled, covered list can anchor it.
    list.scrollTop = 160;
    fireEvent.scroll(list);
    expect(
      measure.mock.contexts.filter(
        (element) => element instanceof Node && list.contains(element),
      ),
    ).toEqual([]);
  } finally {
    measure.mockRestore();
  }
  // Returning to Activity under the moved tab leaves the list where it is
  // until that tab is no longer selected.
  view.unmount();
  render(h.view);
  const returned = await screen.findByRole("list", {
    name: "Activity",
    hidden: true,
  });
  await waitFor(() => expect(returned).toHaveTextContent("Fresh mention"));
  const covered = returned.parentElement;
  if (!covered) throw new Error("Missing Activity scroller");
  expect(covered.closest("[inert]")).not.toBeNull();
  expect(covered.scrollTop).toBe(0);
  fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
  expect(covered.closest("[inert]")).toBeNull();
  expect(covered.scrollTop).toBe(160);
});

it.each([
  ["DMs", "Activity type"],
  ["Agents", "Sender"],
  ["Unread only", "Attention"],
] as const)(
  "offers Clear filters when %s empties a filtered view",
  async (label, control) => {
    const h = fixture();
    render(h.view);
    await waitFor(() => expect(rows()).toHaveLength(2));
    if (control === "Attention") {
      await act(async () => {
        await h.owner.session.unread.markChannelRead("room");
      });
      // Unread alone means caught up; with a type it is a filtered view.
      await chooseFilter("DMs");
    }
    await chooseFilter(label, control);
    await screen.findByText(
      control === "Attention"
        ? "No unread activity in this view"
        : "No recent activity in this view",
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    const filters = fromTrigger();
    expect(filters).toHaveFocus();
    expect(filters).toHaveAccessibleName("From anyone");
    expect(screen.getByRole("switch", { name: "Unread" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  },
);

it("All caught up offers Show all once Unread leaves nothing, then shows the read conversations", async () => {
  const h = fixture();
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  await act(async () => {
    await h.owner.session.unread.markChannelRead("room");
  });
  await chooseFilter("Unread only", "Attention");
  const empty = await screen.findByText("All caught up");
  const status = empty.closest<HTMLElement>('[role="status"]');
  if (!status) throw new Error("Missing empty state");
  expect(status).toHaveTextContent(
    "New replies, mentions and DMs show up here.",
  );
  expect(status).not.toHaveTextContent(/archiv/i);
  expect(
    within(status)
      .queryAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Show all"]);
  fireEvent.click(within(status).getByRole("button", { name: "Show all" }));
  await waitFor(() => expect(rows()).toHaveLength(2));
  expect(unreadToggle()).toHaveAttribute("aria-checked", "false");
  expect(fromTrigger()).toHaveFocus();
});

it.each(["button", "menu"] as const)(
  "unselected-row Mark as read via %s reads that row in place and leaves the reader and its draft alone",
  async (action) => {
    const h = fixture({ withWriter: true });
    render(h.view);
    await waitFor(() => expect(rows()).toHaveLength(2));
    const thread = rows().find((row) =>
      row.textContent?.includes("A thread update"),
    );
    const mention = rows().find((row) =>
      row.textContent?.includes("Please review"),
    );
    if (!thread || !mention) throw new Error("Missing fixture rows");
    fireEvent.click(within(thread).getByRole("button", { name: /^Open / }));
    const editor = (await screen.findByRole("textbox")) as ComposerInputElement;
    act(() => editor.insertText("Keep the open draft"));
    await waitFor(() =>
      expect(screen.getByRole("list", { name: "Activity" })).toHaveAttribute(
        "aria-busy",
        "false",
      ),
    );
    if (action === "menu") {
      fireEvent.contextMenu(
        within(mention).getByRole("button", { name: /^Open / }),
      );
      fireEvent.click(
        await screen.findByRole("menuitem", { name: "Mark as read" }),
      );
    } else {
      fireEvent.click(
        within(mention).getByRole("button", { name: /^Mark as read / }),
      );
    }
    await waitFor(() =>
      expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBe(21),
    );
    // With Unread off the row stays, no longer unread, and offers no Undo.
    await waitFor(() =>
      expect(within(mention).queryByRole("img", { name: "Unread" })).toBeNull(),
    );
    expect(rows()).toHaveLength(2);
    expect(rows()).toContain(mention);
    expect(
      within(mention).queryByRole("button", { name: /^Mark as read / }),
    ).toBeNull();
    expect(screen.queryByText("Marked as read")).not.toBeInTheDocument();
    expect(thread).toHaveAttribute("data-selected");
    expect(screen.getByRole("textbox")).toBe(editor);
    expect(editor).toHaveTextContent("Keep the open draft");
  },
);

it.each([false, true])(
  "sending leaves the conversation open in its list (DM: %s)",
  async (dm) => {
    const h = fixture({ withWriter: true, withDm: dm });
    render(h.view);
    await waitFor(() => expect(rows()).toHaveLength(dm ? 3 : 2));
    if (dm) await chooseFilter("DMs");
    const row = rows().find((entry) =>
      entry.textContent?.includes(dm ? "A direct reply" : "A thread update"),
    );
    if (!row) throw Error("Missing send fixture row");
    fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
    const editor = (await screen.findByRole("textbox")) as ComposerInputElement;
    act(() => {
      editor.insertText("Keep conversation open");
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(editor).toHaveValue(""));
    expect(rows()).toHaveLength(dm ? 1 : 2);
    expect(screen.getByRole("textbox")).toBe(editor);
  },
);

it("defaults saved filters field by field and loads a retired Archived view as the normal list", async () => {
  const h = fixture();
  localStorage.setItem(
    `buzz-view.v1:${JSON.stringify([h.owner.session.scope, "inbox:filters"])}`,
    JSON.stringify({ show: "archived", activity: "bogus", sender: "agents" }),
  );
  render(h.view);
  // Archive is gone: the saved Archived view shows every conversation.
  await waitFor(() => expect(rows()).toHaveLength(0));
  expect(fromTrigger()).toHaveAccessibleName("From agents");
  expect(
    screen.getByRole("tab", { name: "All", selected: true }),
  ).toBeInTheDocument();
  expect(unreadToggle()).toHaveAttribute("aria-checked", "false");
  fireEvent.click(fromTrigger());
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Anyone" }));
  await waitFor(() => expect(rows()).toHaveLength(2));
  expect(fromTrigger()).toHaveAccessibleName("From anyone");
  expect(savedFilters(h)).not.toHaveProperty("show");
});

it.each([
  ["everyone", "From anyone", "Anyone"],
  ["humans", "From people", "People"],
  ["agents", "From agents", "Agents"],
] as const)(
  "a saved %s sender loads as %s with its From choice checked",
  async (sender, label, choice) => {
    const h = fixture();
    localStorage.setItem(
      `buzz-view.v1:${JSON.stringify([h.owner.session.scope, "inbox:filters"])}`,
      JSON.stringify({ sender }),
    );
    render(h.view);
    await waitFor(() => expect(fromTrigger()).toHaveAccessibleName(label));
    fireEvent.click(fromTrigger());
    const menu = await screen.findByRole("menu", { name: "From" });
    expect(
      within(menu)
        .getAllByRole("menuitemradio")
        .map((item) => [item.textContent, item.getAttribute("aria-checked")]),
    ).toEqual(
      ["Anyone", "People", "Agents"].map((name) => [
        name,
        String(name === choice),
      ]),
    );
  },
);

it("reconciles saved preferences from another window", async () => {
  const h = fixture({ withWriter: true });
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  const row = rows().find((entry) =>
    entry.textContent?.includes("A thread update"),
  );
  if (!row) throw Error("Missing thread row");
  fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
  await screen.findByRole("textbox");
  act(() => {
    for (const [key, value] of [
      [
        "inbox:filters",
        {
          show: "all",
          activity: "bogus",
          sender: "agents",
          attention: "unread",
        },
      ],
    ] as const) {
      const storageKey = `buzz-view.v1:${JSON.stringify([h.owner.session.scope, key])}`;
      localStorage.setItem(storageKey, JSON.stringify(value));
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: storageKey,
          storageArea: localStorage,
        }),
      );
    }
  });
  expect(activityType()).toBe("All");
  expect(fromTrigger()).toHaveAccessibleName("From agents");
  expect(screen.getByRole("switch", { name: "Unread" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

/** The sidebar hover card over the same session as the page. */
const previewAt = (h: ReturnType<typeof fixture>, close = vi.fn()) => (
  <InboxPreview
    relay={h.relay}
    navigator={{ open: h.open } as unknown as Navigation}
    close={close}
  />
);
const previewRows = () =>
  within(screen.getByRole("list", { name: "Recent activity" })).queryAllByRole(
    "listitem",
  );
async function markRead(h: ReturnType<typeof fixture>, channelId: string) {
  const items = h.session.unread
    .inbox()
    .items.filter((entry) => entry.channelId === channelId);
  if (!items.length) throw new Error(`Missing ${channelId} conversation`);
  await act(async () => {
    for (const item of items)
      if (item.target.kind === "channel")
        await h.session.unread.prepareChannelRead(channelId)();
      else if (item.timeline)
        await h.session.unread.markTimelineRead(channelId, item.messageIds);
      else
        for (const step of item.readThrough)
          await h.session.unread.markThrough(step.target, step.messageId);
  });
}

it("previews recent conversations and opens a row directly", async () => {
  const h = fixture({ withDm: true });
  const close = vi.fn();
  render(previewAt(h, close));
  await waitFor(() => expect(previewRows()).toHaveLength(3));
  expect(
    screen.getByText("3 unread · 1 mention · 1 thread · 1 DM"),
  ).toBeInTheDocument();

  // The newest #Design row opens at its exact message, in its thread when it has one.
  const [newest] = h.session.unread
    .inbox()
    .items.filter((item) => item.channelId === "room")
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  if (!newest) throw new Error("Missing room conversation");
  const roomRow = previewRows().find((row) =>
    within(row).queryByRole("button", { name: /^Open Alice in #Design/ }),
  );
  if (!roomRow) throw new Error("Missing room preview row");
  fireEvent.click(
    within(roomRow).getByRole("button", { name: /^Open Alice in #Design/ }),
  );
  expect(close).toHaveBeenCalledOnce();
  expect(h.open).toHaveBeenLastCalledWith({
    version: 1,
    kind: "conversation",
    scope: h.scope,
    channelId: "room",
    messageId: newest.messageId,
    ...(newest.rootId && { threadRootId: newest.rootId }),
  });
  fireEvent.click(screen.getByRole("button", { name: "Open Activity" }));
  expect(close).toHaveBeenCalledTimes(2);
  expect(h.open).toHaveBeenLastCalledWith(inboxTarget);
});

it("keeps Unread only to the card and offers recent activity once caught up", async () => {
  const h = fixture({ withDm: true });
  // The page's own Unread only neither seeds the card nor changes with it.
  writeView(h.owner.session.scope, "inbox:filters", { attention: "unread" });
  const view = render(previewAt(h));
  await waitFor(() => expect(previewRows()).toHaveLength(3));
  expect(screen.getByRole("switch", { name: "Unread only" })).not.toBeChecked();
  await markRead(h, "dm-room");
  await waitFor(() =>
    expect(
      screen.getByText("2 unread · 1 mention · 1 thread"),
    ).toBeInTheDocument(),
  );
  const unreadOnly = () => screen.getByRole("switch", { name: "Unread only" });
  fireEvent.click(unreadOnly());
  await waitFor(() => expect(previewRows()).toHaveLength(2));
  expect(screen.queryByText("A direct reply")).not.toBeInTheDocument();

  // The choice survives reopening the card, and the page keeps its own filters.
  view.unmount();
  render(previewAt(h));
  await waitFor(() => expect(previewRows()).toHaveLength(2));
  expect(unreadOnly()).toBeChecked();
  expect(savedFilters(h)).toEqual({ attention: "unread" });

  await markRead(h, "room");
  expect(await screen.findByText("You're all caught up")).toBeInTheDocument();
  expect(screen.getByText("Nothing unread")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Show recent activity" }));
  await waitFor(() => expect(previewRows()).toHaveLength(3));
  expect(unreadOnly()).not.toBeChecked();
});

it("leads the card's header with the total and counts a mention only while it is unread", async () => {
  const h = fixture({ withSolo: true });
  render(previewAt(h));
  await waitFor(() => expect(previewRows()).toHaveLength(3));
  expect(
    screen.getByText("3 unread · 1 mention · 1 thread"),
  ).toBeInTheDocument();
  // A Solo chat's flat row has no kind, so only the total counts it.
  await markRead(h, "room");
  expect(await screen.findByText("1 unread")).toBeInTheDocument();

  const reply = (content: string, at: number, tags: string[][] = []) => {
    const event = message(h.alice, "room", content, at, [
      ["e", h.root?.id ?? "", "", "reply"],
      ...tags,
    ]);
    h.addEvent(event);
    act(() => h.emit([event]));
  };
  reply("Can you check this?", 30, [["p", h.viewer.pubkey]]);
  expect(await screen.findByText("2 unread · 1 mention")).toBeInTheDocument();

  // A plain reply after the mention was read is thread activity, as Mentions
  // with Unread only would list nothing.
  await markRead(h, "room");
  await markRead(h, "solo-room");
  expect(await screen.findByText("Nothing unread")).toBeInTheDocument();
  reply("Following up", 31);
  expect(await screen.findByText("1 unread · 1 thread")).toBeInTheDocument();
});

it("shows the card's connection and read failures with their recovery", async () => {
  const offline = fixture();
  const view = render(previewAt(offline));
  await waitFor(() => expect(previewRows()).toHaveLength(2));
  act(() => offline.disconnect());
  expect(
    await screen.findByText("Choose a community to see your activity."),
  ).toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "Unread only" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(screen.getByRole("button", { name: "Open Activity" })).toBeEnabled();
  view.unmount();

  const h = fixture({ failRoster: true });
  render(previewAt(h));
  expect(await screen.findByRole("alert")).toHaveTextContent("roster offline");
  const release = h.recoverRoster();
  try {
    fireEvent.click(screen.getByRole("button", { name: "Retry activity" }));
    await waitFor(() => expect(h.rosterStarted()).toBe(true));
  } finally {
    await act(async () => release());
  }
  await waitFor(() => expect(previewRows()).toHaveLength(2));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("refreshes the card's failed activity once its roster Retry recovers", async () => {
  const h = fixture();
  render(previewAt(h));
  await waitFor(() => expect(previewRows()).toHaveLength(2));
  await waitFor(() =>
    expect(h.owner.session.inboxFeed.snapshot().status).toBe("ready"),
  );
  // Activity and then discovery fail; the roster's error is shown first.
  h.failAux();
  await act(async () => h.owner.session.inboxFeed.refresh());
  h.failAux(false);
  h.failRoster();
  act(() => h.owner.session.channels.refreshList?.());
  expect(await screen.findByRole("alert")).toHaveTextContent("roster offline");
  expect(h.owner.session.inboxFeed.snapshot().error).toBe(
    "auxiliary history unavailable",
  );
  const release = h.recoverRoster();
  try {
    fireEvent.click(screen.getByRole("button", { name: "Retry activity" }));
    await waitFor(() => expect(h.rosterStarted()).toBe(true));
  } finally {
    await act(async () => release());
  }
  // One Retry clears both failures, as on the page.
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
  expect(previewRows()).toHaveLength(2);
});

it.each([true, false])(
  "hands a recovered Retry's focus to Unread only when it owned focus (%s)",
  async (owned) => {
    const h = fixture();
    const user = userEvent.setup();
    render(previewAt(h));
    await waitFor(() => expect(previewRows()).toHaveLength(2));
    await waitFor(() =>
      expect(h.owner.session.inboxFeed.snapshot().status).toBe("ready"),
    );
    h.failAux();
    await act(async () => h.owner.session.inboxFeed.refresh());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "auxiliary history unavailable",
    );
    h.failAux(false);
    const retry = screen.getByRole("button", { name: "Retry activity" });
    const openInbox = screen.getByRole("button", { name: "Open Activity" });
    if (owned) {
      retry.focus();
      await user.keyboard("{Enter}");
    } else {
      // A pointer press elsewhere keeps focus where the user left it.
      openInbox.focus();
      fireEvent.click(retry);
    }
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(
      owned ? screen.getByRole("switch", { name: "Unread only" }) : openInbox,
    ).toHaveFocus();
  },
);

it("retries the card's connection, activity and read-state failures", async () => {
  const h = fixture();
  const view = render(previewAt(h));
  await waitFor(() => expect(previewRows()).toHaveLength(2));
  await waitFor(() =>
    expect(h.owner.session.inboxFeed.snapshot().status).toBe("ready"),
  );
  // Activity failures retry the reads, then read-state sync, as on the page.
  h.failAux();
  await act(async () => h.owner.session.inboxFeed.refresh());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "auxiliary history unavailable",
  );
  h.failAux(false);
  fireEvent.click(screen.getByRole("button", { name: "Retry activity" }));
  await waitFor(() => expect(h.retrySync).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
  act(() => h.failSync("read state offline"));
  expect(screen.getByRole("alert")).toHaveTextContent("read state offline");
  fireEvent.click(screen.getByRole("button", { name: "Retry activity" }));
  await waitFor(() => expect(h.retrySync).toHaveBeenCalledTimes(2));
  act(() => h.failSync());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();

  // Cleared activity is not reported as nothing to read while the repair the
  // clear starts observes it again, and that repair brings it back.
  let clearing: Promise<void> | undefined;
  act(() => {
    clearing = h.owner.clearCache();
  });
  expect(
    screen.queryByRole("list", { name: "Recent activity" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("No recent activity")).not.toBeInTheDocument();
  expect(screen.queryByText("Nothing unread")).not.toBeInTheDocument();
  await act(async () => {
    await clearing;
  });
  await waitFor(() => expect(previewRows()).toHaveLength(2));
  expect(screen.queryByText("No recent activity")).not.toBeInTheDocument();
  view.unmount();

  act(() => h.failConnection("relay offline"));
  render(previewAt(h));
  expect(await screen.findByText("relay offline")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
  expect(h.retryConnection).toHaveBeenCalledOnce();
  // A refusal is the community's, not the connection's: its notice on every
  // page offers what fixes it, so Activity neither shows the relay's raw text
  // nor a retry of the same request.
  act(() =>
    h.failConnection("restricted: authorization denied", { denied: true }),
  );
  expect(
    await screen.findByText("You don’t have access to this community"),
  ).toBeInTheDocument();
  expect(screen.queryByText(/restricted:/)).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Retry connection" }),
  ).not.toBeInTheDocument();
});

function fixture(
  options: {
    failRoster?: boolean;
    archivedChannel?: boolean;
    withDm?: boolean;
    withSolo?: boolean;
    withSenders?: boolean;
    holdProfiles?: boolean;
    withWriter?: boolean;
    soloChannel?: boolean;
    memberAgents?: 1 | 2;
    readCapability?: "read-only" | "unsupported";
    guest?: boolean;
  } = {},
) {
  const viewer = keypair(),
    alice = keypair(),
    agent = keypair(),
    profileAgent = keypair(),
    late = keypair(),
    unknown = keypair(),
    relayKey = keypair();
  // Held profiles are unpublished until release, then arrive live. Holding a
  // read open instead would occupy the one background read slot for good.
  let profilesHeld = options.holdProfiles ?? false;
  const unheld = (found: RelayEvent[]) =>
    profilesHeld ? found.filter((event) => event.kind !== 0) : found;
  let rosterFailure = options.failRoster ?? false;
  let rosterGate: Promise<void> | undefined;
  let rosterStarted = false;
  let evidenceReads = 0;
  let unreadGate: Promise<void> | undefined;
  let unreadStarted = false;
  const historyRequests: string[] = [];
  const threadRequests: string[] = [];
  const exactRequests: string[] = [];
  const published: RelayEvent[] = [];
  const historyGates = new Map<string, Promise<void>>();
  let addressedGate: Promise<void> | undefined;
  let releaseAddressed = () => {};
  let failAux = false;
  let auxGate: Promise<void> | undefined;
  let releaseAux = () => {};
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
    roster(
      relayKey,
      "room",
      [
        viewer.pubkey,
        alice.pubkey,
        ...(options.memberAgents ? [agent.pubkey] : []),
        ...(options.memberAgents === 2 ? [profileAgent.pubkey] : []),
      ],
      10,
    ),
    metadata(relayKey, "room", "Design", 10, [
      ...(options.soloChannel
        ? [["t", "stream"], ["private"], ["t", "buzz.solo"]]
        : [
            ["t", "stream"],
            ...(options.archivedChannel ? [["archived", "true"]] : []),
          ]),
    ]),
    profile(alice, { name: "Alice", picture: alicePicture }),
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
    ...(options.withSolo
      ? [
          roster(relayKey, "solo-room", [viewer.pubkey, alice.pubkey], 10),
          metadata(relayKey, "solo-room", "Notes", 10, [
            ["t", "stream"],
            ["private"],
            ["t", "buzz.solo"],
          ]),
          message(alice, "solo-room", "A Solo update", 23),
        ]
      : []),
    ...(options.withSenders
      ? [
          roster(relayKey, "agent-dm", [viewer.pubkey, agent.pubkey], 10),
          metadata(relayKey, "agent-dm", "Agent direct", 10, [
            ["t", "dm"],
            ["hidden"],
          ]),
          message(agent, "agent-dm", "Agent direct reply", 24),
          message(agent, "room", "Agent mention", 25, [["p", viewer.pubkey]]),
          message(unknown, "room", "Unprofiled mention", 26, [
            ["p", viewer.pubkey],
          ]),
          profile(profileAgent, { name: "Public agent", is_agent: true }),
          message(profileAgent, "room", "Public agent mention", 27, [
            ["p", viewer.pubkey],
          ]),
          message(late, "room", "Late profile mention", 28, [
            ["p", viewer.pubkey],
          ]),
        ]
      : []),
  ];
  if (options.guest) {
    const roster = events[0];
    if (!roster) throw new Error("Missing channel roster");
    events[0] = signed(relayKey, {
      ...roster,
      tags: roster.tags.map((tag) =>
        tag[0] === "p" && tag[1] === viewer.pubkey
          ? ["p", viewer.pubkey, "", "guest"]
          : tag,
      ),
    });
  }
  if (options.readCapability) {
    journal = {
      ...newReadJournal(),
      state: {
        frontiers: { [`msg:${mention.id}`]: mention.created_at },
        overrides: {},
      },
      localUnread: { [`msg:${"f".repeat(64)}`]: 1 },
      revision: 1,
      acceptedRevision: 1,
    };
  }
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relayKey.pubkey,
      query: async (filters) => {
        if (
          filters.some(
            (filter) =>
              filter.include_aux && !!filter["#h"] && filter.kinds?.includes(9),
          )
        ) {
          unreadStarted = true;
          await unreadGate;
        }
        if (
          filters.some((filter) => !!filter["#p"] && filter.kinds?.includes(9))
        )
          await addressedGate;
        if (
          filters.some(
            (filter) => !!filter["#e"] && filter.kinds?.includes(40003),
          )
        ) {
          await auxGate;
          if (failAux) throw new Error("auxiliary history unavailable");
        }
        if (filters.some((filter) => filter.kinds?.includes(39002))) {
          rosterStarted = true;
          if (rosterGate) await rosterGate;
          if (rosterFailure) throw new Error("roster offline");
        }
        if (filters.some((filter) => filter.kinds?.includes(9)))
          evidenceReads++;
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
        return unheld(filters.flatMap(answer));
      },
      // The real sizing rewrite behind a pass-through proxy, so rows resolve
      // relay-hosted pictures to the variant they actually requested.
      media: (url, size) =>
        mediaUrl(url, (proxied) => proxied, "https://relay.test", size),
      ...(options.withWriter
        ? {
            writer: {
              kinds: [9, 9007],
              sign: async (template: import("nostr-tools").EventTemplate) =>
                signed(viewer, template),
              publish: async (event: RelayEvent) => {
                published.push(event);
              },
            },
          }
        : {}),
      ...(options.withSenders || options.memberAgents
        ? {
            readAgentLibrary: async () => ({
              definitions: [],
              identities: [
                { pubkey: agent.pubkey, name: "Scout" },
                ...(options.memberAgents === 2
                  ? [{ pubkey: profileAgent.pubkey, name: "Second agent" }]
                  : []),
              ],
            }),
          }
        : {}),
      subscribe(callbacks) {
        if (options.memberAgents)
          callbacks.state({ status: "connected", routes: [] });
        emit = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
      ...(options.readCapability === "unsupported"
        ? {}
        : {
            readState: {
              decode: async (records: readonly RelayEvent[]) =>
                decodeReadState(records, viewer.secret),
              ...(options.readCapability === "read-only"
                ? {}
                : {
                    sign: async (
                      intent: import("../../features/relay/read-state-host").ReadStateSigning,
                    ) => signReadState(intent, viewer.secret),
                    publish: async (event: RelayEvent) => {
                      events.push(event);
                    },
                  }),
            },
          }),
    },
    {
      readStateFloor: () => 0,
      outboxStorage: { load: () => [], save: () => {} },
      readStateStorage: {
        capture: async () => structuredClone(journal),
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
  if (!options.failRoster) emit(unheld(events));
  const scope = {
    viewer: viewer.pubkey,
    communityOrigin: "https://relay.test",
  };
  const readSteps: {
    target: Parameters<typeof owner.session.unread.markThrough>[0];
    id: string;
    work: ReturnType<typeof owner.session.unread.markThrough>;
  }[] = [];
  const retrySync = vi.fn(() => owner.session.unread.retrySync());
  let failedSync: ReturnType<typeof owner.session.unread.sync> | undefined;
  const syncListeners = new Set<() => void>();
  const observedSession = {
    ...owner.session,
    messages: { ...owner.session.messages },
    unread: {
      ...owner.session.unread,
      retrySync,
      sync: () => failedSync ?? owner.session.unread.sync(),
      subscribeSync(listener: () => void) {
        syncListeners.add(listener);
        const stop = owner.session.unread.subscribeSync(listener);
        return () => {
          syncListeners.delete(listener);
          stop();
        };
      },
      markThrough(
        target: Parameters<typeof owner.session.unread.markThrough>[0],
        id: string,
      ) {
        const work = owner.session.unread.markThrough(target, id);
        readSteps.push({ target, id, work });
        return work;
      },
    },
  };
  let connection: RelaySnapshot = {
    status: "ready",
    generation: 1,
    scope: `${scope.communityOrigin}:${scope.viewer}`,
    viewer: scope.viewer,
    session: observedSession,
  };
  const subscribers = new Set<() => void>();
  const retryConnection = vi.fn();
  const relay: RelayData = {
    snapshot: () => connection,
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    retry() {},
    tryAgain: retryConnection,
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
    session: observedSession,
    relay,
    retrySync,
    readSteps,
    evidenceReads: () => evidenceReads,
    historyRequests,
    unreadStarted: () => unreadStarted,
    holdUnread() {
      unreadStarted = false;
      let release = () => {};
      unreadGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        unreadGate = undefined;
        release();
      };
    },
    holdAddressed() {
      addressedGate = new Promise<void>((resolve) => {
        releaseAddressed = resolve;
      });
      return () => {
        addressedGate = undefined;
        releaseAddressed();
      };
    },
    holdAux() {
      auxGate = new Promise<void>((resolve) => {
        releaseAux = resolve;
      });
      return () => {
        auxGate = undefined;
        releaseAux();
      };
    },
    failAux(value = true) {
      failAux = value;
    },
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
    rosterStarted: () => rosterStarted,
    releaseProfiles() {
      if (!profilesHeld) return;
      profilesHeld = false;
      emit(events.filter((event) => event.kind === 0));
    },
    agent,
    unknown,
    late,
    alice,
    viewer,
    relayKey,
    profileAgent,
    emit,
    events,
    publishLateProfile() {
      act(() => emit([profile(late, { name: "Late person" }, 30)]));
    },
    publishAgentProfile() {
      act(() => emit([profile(agent, { name: "Scout", is_agent: true }, 27)]));
    },
    publishMalformedProfile() {
      act(() =>
        emit([
          signed(unknown, {
            kind: 0,
            tags: [],
            content: "broken",
            created_at: 27,
          }),
        ]),
      );
    },
    failRoster() {
      rosterFailure = true;
    },
    recoverRoster() {
      rosterFailure = false;
      rosterStarted = false;
      let release = () => {};
      rosterGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    scope,
    mention,
    reply,
    open,
    journal: () => journal,
    view: (
      <StrictMode>
        <InboxPage
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
    archiveRoom(archived: boolean, time: number) {
      const state = metadata(relayKey, "room", "Design", time, [
        ["t", "stream"],
        ["archived", String(archived)],
      ]);
      events.push(state);
      emit([state]);
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
    retryConnection,
    failSync(error?: string) {
      failedSync = error
        ? { ...owner.session.unread.sync(), error }
        : undefined;
      for (const listener of syncListeners) listener();
    },
    failConnection(error: string, refused?: Partial<RelaySnapshot>) {
      connection = {
        ...connection,
        status: "error",
        error,
        generation: 2,
        ...refused,
      };
      for (const listener of subscribers) listener();
    },
  };
}
/** Relay-hosted, so `media()` decides which variant the row loads. */
const alicePicture = `https://relay.test/media/${"a".repeat(64)}.png`;
const rows = () =>
  within(screen.getByRole("list", { name: "Activity" })).queryAllByRole(
    "listitem",
  );
/** The element that scrolls the Activity list. */
const scroller = () =>
  screen.getByRole("list", { name: "Activity" }).parentElement;
const scrollTo = (top: number) => {
  const list = scroller();
  if (!list) throw new Error("Missing Activity scroller");
  list.scrollTop = top;
  fireEvent.scroll(list);
};
/** The conversation Inbox opened in a tab beside its list. */
const reader = () => screen.getByRole("region", { name: /^Conversation in / });
const queryReader = () =>
  screen.queryByRole("region", { name: /^Conversation in / });
const findReader = () =>
  screen.findByRole("region", { name: /^Conversation in / });
const tabs = (name: string) =>
  within(screen.getByRole("tablist", { name }))
    .getAllByRole("tab")
    .map((tab) => tab.textContent);
/** The side pane's tab list, beside the main pane's and the type filter's. */
const sideTabList = () =>
  screen
    .queryAllByRole("tablist")
    .find(
      (item) =>
        !["Activity tabs", "Activity type"].includes(
          item.getAttribute("aria-label") ?? "",
        ),
    );
/** The selected Activity type tab's label. */
const activityType = () =>
  within(screen.getByRole("tablist", { name: "Activity type" })).queryByRole(
    "tab",
    { selected: true },
  )?.textContent;
/** The side pane's tabs, beside the main pane's "Activity tabs". */
const sideTabs = () => {
  const list = sideTabList();
  return list
    ? within(list)
        .getAllByRole("tab")
        .map((tab) => tab.textContent)
    : [];
};
/** A visit's presentation: every open, even of the same address, is a new object. */
function visit(params?: InboxRoute): PageNavigation {
  return {
    entryId: "entry",
    target: params
      ? inboxRouteTarget(params)
      : {
          version: 1,
          kind: "page",
          pluginId: "buzz.inbox",
          pageId: "inbox",
        },
    signal: new AbortController().signal,
  } as unknown as PageNavigation;
}
/** The fixture's page, handed a navigation like the host's PageView does. */
function viewAt(h: ReturnType<typeof fixture>, navigation: PageNavigation) {
  const page = (
    h.view.props as {
      children: ReactElement<{ navigation?: PageNavigation }>;
    }
  ).children;
  return cloneElement(h.view, {}, cloneElement(page, { navigation }));
}
const savedFilters = (h: ReturnType<typeof fixture>) =>
  JSON.parse(
    localStorage.getItem(
      `buzz-view.v1:${JSON.stringify([h.owner.session.scope, "inbox:filters"])}`,
    ) ?? "null",
  );
/** The From menu's trigger, which names the current choice. */
const fromTrigger = () => screen.getByRole("button", { name: /^From / });
const unreadToggle = () => screen.getByRole("switch", { name: "Unread" });

it.each([
  [{ activity: "all", attention: "unread" }, "All", "true"],
  [{ activity: "threads" }, "Threads", "false"],
  [{ activity: "mentions" }, "Mentions", "false"],
  [{ activity: "dms" }, "DMs", "false"],
] as const)(
  "a shortcut open with %j applies and saves its filters, leaving the others",
  async (params, label, unread) => {
    const h = fixture({ withDm: true });
    localStorage.setItem(
      `buzz-view.v1:${JSON.stringify([h.owner.session.scope, "inbox:filters"])}`,
      JSON.stringify({
        activity: "all",
        sender: "agents",
        attention: "all",
      }),
    );
    render(viewAt(h, visit(params)));
    await waitFor(() => expect(activityType()).toBe(label));
    expect(fromTrigger()).toHaveAccessibleName("From agents");
    expect(unreadToggle()).toHaveAttribute("aria-checked", unread);
    expect(savedFilters(h)).toEqual({
      sender: "agents",
      attention: unread === "true" ? "unread" : "all",
      ...params,
    });
  },
);

it("keeps the saved attention when a shortcut names only an activity", async () => {
  const h = fixture();
  localStorage.setItem(
    `buzz-view.v1:${JSON.stringify([h.owner.session.scope, "inbox:filters"])}`,
    JSON.stringify({ attention: "unread" }),
  );
  render(viewAt(h, visit({ activity: "threads" })));
  await waitFor(() => expect(activityType()).toBe("Threads"));
  expect(unreadToggle()).toHaveAttribute("aria-checked", "true");
  expect(savedFilters(h)).toMatchObject({ attention: "unread" });
});

it("re-applies a repeated shortcut open after the filters were changed by hand", async () => {
  const h = fixture({ withDm: true });
  const view = render(viewAt(h, visit({ activity: "threads" })));
  await waitFor(() => expect(activityType()).toBe("Threads"));
  await chooseFilter("Mentions");
  await chooseFilter("Unread only", "Attention");
  expect(activityType()).toBe("Mentions");
  // A rerender of the same presentation is not a new visit.
  const same = visit({ activity: "threads" });
  view.rerender(viewAt(h, same));
  await waitFor(() => expect(activityType()).toBe("Threads"));
  await chooseFilter("DMs");
  view.rerender(viewAt(h, same));
  expect(activityType()).toBe("DMs");
  // The host presents a repeated open of an identical address as a new object.
  view.rerender(viewAt(h, visit({ activity: "threads" })));
  await waitFor(() => expect(activityType()).toBe("Threads"));
  expect(savedFilters(h)).toMatchObject({ activity: "threads" });
});

it("Back/Forward to a shortcut visit keeps the filters chosen since", async () => {
  const h = fixture({ withDm: true });
  const view = render(viewAt(h, visit({ activity: "threads" })));
  await waitFor(() => expect(activityType()).toBe("Threads"));
  await chooseFilter("Mentions");
  // Traversal presents the visit as a new object carrying the same address.
  view.rerender(
    viewAt(h, { ...visit({ activity: "threads" }), traversal: true }),
  );
  expect(activityType()).toBe("Mentions");
  expect(savedFilters(h)).toMatchObject({ activity: "mentions" });
});

it("a route open applies its sender, keeping the other saved filters", async () => {
  const h = fixture({ withDm: true });
  localStorage.setItem(
    `buzz-view.v1:${JSON.stringify([h.owner.session.scope, "inbox:filters"])}`,
    JSON.stringify({
      activity: "threads",
      sender: "everyone",
      attention: "unread",
    }),
  );
  render(viewAt(h, visit({ sender: "agents" })));
  await waitFor(() =>
    expect(fromTrigger()).toHaveAccessibleName("From agents"),
  );
  expect(activityType()).toBe("Threads");
  expect(unreadToggle()).toBeChecked();
  expect(savedFilters(h)).toMatchObject({
    activity: "threads",
    sender: "agents",
    attention: "unread",
  });
});

it.each([
  [{ show: "archived", sender: "agents" }, "From agents"],
  [{ drafts: "true" }, "From anyone"],
] as const)(
  "a link from before Archived and Drafts were removed, %j, still opens the page",
  async (params, from) => {
    const h = fixture();
    render(
      viewAt(h, {
        ...visit(),
        target: {
          version: 1,
          kind: "page",
          pluginId: "buzz.inbox",
          pageId: "inbox",
          route: { version: 1, params },
        },
      }),
    );
    await waitFor(() => expect(fromTrigger()).toHaveAccessibleName(from));
    expect(activityType()).toBe("All");
    expect(screen.getByRole("list", { name: "Activity" })).toBeVisible();
  },
);

it("a plain open leaves saved filters alone", async () => {
  const h = fixture();
  const saved = {
    activity: "mentions",
    sender: "humans",
    attention: "unread",
  };
  localStorage.setItem(
    `buzz-view.v1:${JSON.stringify([h.owner.session.scope, "inbox:filters"])}`,
    JSON.stringify(saved),
  );
  const view = render(viewAt(h, visit()));
  await waitFor(() =>
    expect(fromTrigger()).toHaveAccessibleName("From people"),
  );
  expect(unreadToggle()).toHaveAttribute("aria-checked", "true");
  view.rerender(viewAt(h, visit()));
  expect(savedFilters(h)).toEqual(saved);
  expect(fromTrigger()).toHaveAccessibleName("From people");
  expect(activityType()).toBe("Mentions");
});

async function chooseFilter(label: string, control = "Activity type") {
  if (control === "Attention") {
    const toggle = screen.getByRole("switch", { name: "Unread" });
    if (
      toggle.getAttribute("aria-checked") !== String(label === "Unread only")
    ) {
      fireEvent.click(toggle);
    }
    expect(toggle).toHaveAttribute(
      "aria-checked",
      String(label === "Unread only"),
    );
    return;
  }
  const user = userEvent.setup();
  if (control === "Activity type") {
    await user.click(
      within(screen.getByRole("tablist", { name: "Activity type" })).getByRole(
        "tab",
        { name: label === "All activity" ? "All" : label },
      ),
    );
    return;
  }
  await user.click(fromTrigger());
  const menu = await screen.findByRole("menu", { name: "From" });
  await user.click(
    within(menu).getByRole("menuitemradio", {
      name:
        label === "Humans" ? "People" : label === "Everyone" ? "Anyone" : label,
    }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("menu", { name: "From" }),
    ).not.toBeInTheDocument(),
  );
}
it.each([false, true])(
  "Mentions excludes ordinary thread progress (selected=%s)",
  async (selectProgress) => {
    const h = fixture();
    render(h.view);
    await screen.findByText("Please review this");
    await act(async () => {
      await h.owner.session.unread.markThrough(
        { kind: "message", channelId: "room", messageId: h.mention.id },
        h.mention.id,
      );
    });
    const response = message(h.viewer, "room", "My answer", 30, [
      ["e", h.mention.id, "", "reply"],
    ]);
    const progress = message(h.alice, "room", "Ordinary progress", 31, [
      ["e", h.mention.id, "", "reply"],
    ]);
    h.addEvent(response);
    h.addEvent(progress);
    act(() => h.emit([response, progress]));
    if (selectProgress) {
      const progressRow = await waitFor(() => {
        const row = rows().find((candidate) =>
          candidate.textContent?.includes("Ordinary progress"),
        );
        if (!row) throw new Error("Missing ordinary progress row");
        return row;
      });
      fireEvent.click(
        within(progressRow).getByRole("button", { name: /^Open / }),
      );
      await findReader();
      await waitFor(() =>
        expect(
          within(progressRow).getByRole("button", { name: /^Open / }),
        ).toBeEnabled(),
      );
    }
    await chooseFilter("Mentions");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("Please review this");
    expect(rows()[0]).not.toHaveTextContent("Ordinary progress");
    await chooseFilter("Unread only", "Attention");
    await waitFor(() => expect(rows()).toHaveLength(0));
    const fresh = message(h.alice, "room", "Another decision", 32, [
      ["e", h.mention.id, "", "reply"],
      ["p", h.viewer.pubkey],
    ]);
    act(() => h.emit([fresh]));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveTextContent("Another decision");
  },
);

it("Mentions orders and classifies matching senders and reads only through matching messages", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  h.publishAgentProfile();
  const root = h.root;
  if (!root) throw new Error("Missing fixture root");
  const mention = message(h.agent, "room", "Agent decision", 23, [
    ["e", root.id, "", "reply"],
    ["p", h.viewer.pubkey],
  ]);
  const progress = message(h.alice, "room", "Later human progress", 24, [
    ["e", root.id, "", "reply"],
  ]);
  h.addEvent(mention);
  h.addEvent(progress);
  act(() => h.emit([mention, progress]));
  await chooseFilter("Mentions");
  expect(rows().map((row) => row.textContent)).toEqual([
    expect.stringContaining("Agent decision"),
    expect.stringContaining("Please review this"),
  ]);
  await chooseFilter("Humans", "Sender");
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent("Please review this");
  await chooseFilter("Agents", "Sender");
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent("Agent decision");
  const row = rows()[0];
  if (!row) throw new Error("Missing agent mention row");
  fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
  await findReader();
  await waitFor(() =>
    expect(h.readSteps.map((step) => step.id)).toEqual([mention.id]),
  );
  expect(
    h.owner.session.unread
      .inbox()
      .items.find((item) => item.id.endsWith(root.id)),
  ).toMatchObject({ messageId: progress.id, unreadCount: 1 });
});

it("lets a joined Guest read an Inbox item and change its personal unread state", async () => {
  const h = fixture({ guest: true });
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  expect(h.session.channels.get?.("room")).toMatchObject({
    viewerRole: "guest",
    readOnly: true,
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice in #Design" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("img", { name: "Unread" }),
    ).not.toBeInTheDocument(),
  );
  expect(
    screen.queryByText(
      "This action expired. Close and reopen the conversation.",
    ),
  ).not.toBeInTheDocument();
  fireEvent.click(await openRowMenu());
  await waitFor(() =>
    expect(h.journal()?.localUnread[`msg:${h.mention.id}`]).toBeTypeOf(
      "number",
    ),
  );
  expect(h.session.channels.get?.("room")?.viewerRole).toBe("guest");
});

async function openRowMenu(
  method: "context" | "keyboard" | "contextKey" = "context",
) {
  const row = rows()[0];
  if (!row) throw new Error("Missing inbox row");
  if (method === "context")
    fireEvent.contextMenu(within(row).getByRole("button", { name: /^Open / }), {
      clientX: 20,
      clientY: 20,
    });
  else {
    const open = within(row).getByRole("button", { name: /^Open / });
    open.focus();
    fireEvent.keyDown(
      open,
      method === "keyboard"
        ? { key: "F10", shiftKey: true }
        : { key: "ContextMenu" },
    );
  }
  return screen.findByRole("menuitem", { name: "Mark unread" });
}
it("excludes archived-channel mentions and threads without hiding active DMs", async () => {
  const h = fixture({ archivedChannel: true, withDm: true });
  render(h.view);
  await screen.findByText("A direct reply");
  await waitFor(() =>
    expect(
      screen.queryByText("Checking recent activity…"),
    ).not.toBeInTheDocument(),
  );
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent("A direct reply");
  // The sender avatar reuses the thumbnail message rows load, not the original.
  expect(rows()[0]?.querySelector("img")).toHaveAttribute(
    "src",
    alicePicture.replace(/\.png$/, ".thumb.webp"),
  );
  await chooseFilter("Mentions");
  expect(rows()).toHaveLength(0);
  await chooseFilter("Threads");
  expect(rows()).toHaveLength(0);
});

it.each(["Please review", "A thread update"])(
  "retires the selected visit on channel archive and restores unread intent on unarchive (%s)",
  async (preview) => {
    const h = fixture({ withWriter: true });
    render(h.view);
    await waitFor(() => expect(rows()).toHaveLength(2));
    const row = rows().find((item) => item.textContent?.includes(preview));
    if (!row) throw new Error("Missing fixture conversation");
    fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
    const detail = await findReader();
    await within(detail).findByText(
      preview === "Please review" ? /Please review/ : "A thread update",
    );
    await waitFor(() =>
      expect(
        within(row).queryByRole("img", { name: "Unread" }),
      ).not.toBeInTheDocument(),
    );
    fireEvent.contextMenu(within(row).getByRole("button", { name: /^Open / }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Mark unread" }),
    );
    await waitFor(() =>
      expect(
        within(row).getByRole("img", { name: "Unread" }),
      ).toBeInTheDocument(),
    );
    const journal = h.journal();
    act(() => h.archiveRoom(true, 100));
    await waitFor(() => expect(rows()).toHaveLength(0));
    expect(queryReader()).not.toBeInTheDocument();
    expect(h.journal()).toEqual(journal);
    act(() => h.archiveRoom(false, 101));
    await waitFor(() => expect(rows()).toHaveLength(2));
    const restored = rows().find((item) => item.textContent?.includes(preview));
    if (!restored) throw new Error("Missing restored conversation");
    expect(
      within(restored).getByRole("img", { name: "Unread" }),
    ).toBeInTheDocument();
    expect(restored).not.toHaveAttribute("data-selected");
    // Unarchiving the channel does not reopen its conversation.
    expect(queryReader()).not.toBeInTheDocument();
    expect(h.journal()).toEqual(journal);
  },
);

it("reads a reopened row again after its tab closes", async () => {
  const h = fixture();
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  const row = () => {
    const item = rows().find((item) =>
      item.textContent?.includes("Please review"),
    );
    if (!item) throw new Error("Missing fixture conversation");
    return item;
  };
  const open = () =>
    fireEvent.click(within(row()).getByRole("button", { name: /^Open / }));
  const unread = () => within(row()).queryByRole("img", { name: "Unread" });
  open();
  await findReader();
  await waitFor(() => expect(unread()).not.toBeInTheDocument());
  fireEvent.contextMenu(within(row()).getByRole("button", { name: /^Open / }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Mark unread" }));
  await waitFor(() => expect(unread()).toBeInTheDocument());
  const side = sideTabList();
  if (!side) throw new Error("Missing side tabs");
  fireEvent.click(within(side).getByRole("button", { name: /^Close / }));
  await waitFor(() => expect(queryReader()).not.toBeInTheDocument());
  expect(row()).not.toHaveAttribute("data-selected");
  open();
  await findReader();
  await waitFor(() => expect(unread()).not.toBeInTheDocument());
});

it.each([false, true])(
  "retires selected visits only on explicit archive during a held unread refresh (archive=%s)",
  async (archive) => {
    const h = fixture();
    render(h.view);
    await screen.findByText("Please review this");
    await waitFor(() =>
      expect(h.owner.session.unread.inbox().status).toBe("ready"),
    );
    await chooseFilter("Mentions");
    fireEvent.click(
      screen.getByRole("button", { name: "Open Alice in #Design" }),
    );
    await within(await findReader()).findByText(/Please review/);
    await waitFor(() =>
      expect(
        screen.queryByRole("img", { name: "Unread" }),
      ).not.toBeInTheDocument(),
    );
    const journal = h.journal();
    const release = h.holdUnread();
    let refresh: Promise<void> | undefined;
    try {
      act(() => {
        refresh = h.owner.session.unread.refresh();
      });
      await waitFor(() => expect(h.unreadStarted()).toBe(true));
      expect(h.owner.session.unread.inbox().status).toBe("loading");
      expect(reader()).toBeInTheDocument();
      expect(rows()[0]).toHaveAttribute("data-selected");
      if (archive) {
        act(() => h.archiveRoom(true, 100));
        await waitFor(() => expect(rows()).toHaveLength(0));
        expect(queryReader()).not.toBeInTheDocument();
        act(() => h.archiveRoom(false, 101));
        await waitFor(() => expect(rows()).toHaveLength(1));
        expect(h.owner.session.unread.inbox().status).toBe("loading");
        expect(rows()[0]).not.toHaveAttribute("data-selected");
        expect(h.journal()).toEqual(journal);
      }
    } finally {
      await act(async () => {
        release();
        await refresh;
      });
    }
    await waitFor(() =>
      expect(h.owner.session.unread.inbox().status).toBe("ready"),
    );
    expect(rows()[0]?.hasAttribute("data-selected")).toBe(!archive);
    expect(h.journal()).toEqual(journal);
  },
);

it("retires a failed captured read on archive during a held unread refresh", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await waitFor(() =>
    expect(h.owner.session.unread.inbox().status).toBe("ready"),
  );
  await chooseFilter("Mentions");
  h.failSave();
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice in #Design" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
  const release = h.holdUnread();
  let refresh: Promise<void> | undefined;
  try {
    act(() => {
      refresh = h.owner.session.unread.refresh();
    });
    await waitFor(() => expect(h.unreadStarted()).toBe(true));
    act(() => h.archiveRoom(true, 100));
    await waitFor(() => expect(rows()).toHaveLength(0));
    act(() => h.archiveRoom(false, 101));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(h.owner.session.unread.inbox().status).toBe("loading");
    expect(
      screen.queryByRole("button", { name: "Retry activity" }),
    ).not.toBeInTheDocument();
  } finally {
    await act(async () => {
      release();
      await refresh;
    });
  }
  await waitFor(() =>
    expect(h.owner.session.unread.inbox().status).toBe("ready"),
  );
  expect(rows()[0]).not.toHaveAttribute("data-selected");
  expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBeUndefined();
  expect(screen.getByRole("img", { name: "Unread" })).toBeInTheDocument();
});

it("filters real session evidence, opens an exact message and marks it read, and shares durable local unread", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await waitFor(() =>
    expect(
      screen.queryByText("Checking recent activity…"),
    ).not.toBeInTheDocument(),
  );
  expect(rows()).toHaveLength(2);
  await chooseFilter("Mentions");
  expect(rows()).toHaveLength(1);
  fireEvent.click(
    await screen.findByRole("button", { name: "Open Alice in #Design" }),
  );
  // The exact message opens in a tab beside Inbox, not by navigating away.
  expect(
    (await findReader()).querySelector(`[data-message-id="${h.mention.id}"]`),
  ).toBeInTheDocument();
  expect(h.open).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(
      screen.queryByRole("img", { name: "Unread" }),
    ).not.toBeInTheDocument(),
  );
  expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBe(21);
  expect(
    h.owner.session.unread.snapshot({ kind: "channel", channelId: "room" })
      .observedCount,
  ).toBe(1);
  fireEvent.click(await openRowMenu("keyboard"));
  await waitFor(() =>
    expect(screen.getByRole("img", { name: "Unread" })).toBeInTheDocument(),
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Open Alice in #Design" }));
  expect(screen.getByRole("img", { name: "Unread" })).toBeInTheDocument();
  // Re-clicking reveals the message again, which takes focus.
  await waitFor(() =>
    expect(
      reader().querySelector(`[data-message-id="${h.mention.id}"]`),
    ).toHaveFocus(),
  );
  expect(
    screen.queryByText(/Marked unread on this device/),
  ).not.toBeInTheDocument();
  await chooseFilter("Unread only", "Attention");
  expect(rows()).toHaveLength(1);
  await chooseFilter("Threads");
  expect(rows()).toHaveLength(1);
  expect(screen.getByText("A thread update")).toBeInTheDocument();
});

it("puts the actual channel or DM source below the sender without category tags", async () => {
  const h = fixture({ withDm: true });
  render(h.view);
  await screen.findByText("A direct reply");
  await waitFor(() => expect(rows()).toHaveLength(3));
  const dmRow = rows().find((row) =>
    row.textContent?.includes("A direct reply"),
  );
  const mentionRow = rows().find((row) =>
    row.textContent?.includes("Please review this"),
  );
  if (!dmRow || !mentionRow) throw new Error("Expected DM and channel rows");
  const dmSource = dmRow.querySelector("[data-inbox-source]");
  const channelSource = mentionRow.querySelector("[data-inbox-source]");
  expect(dmSource).toHaveTextContent("DM · Alice");
  expect(channelSource).toHaveTextContent("#Design");
  expect(
    within(dmRow).getByText("Alice", { selector: "strong" }),
  ).toBeInTheDocument();
  expect(
    within(mentionRow).getByText("Alice", { selector: "strong" }),
  ).toBeInTheDocument();
  expect(dmSource).toHaveClass(/source/);
  expect(channelSource).toHaveClass(/source/);
  expect(
    (dmSource?.compareDocumentPosition(
      within(dmRow).getByText("A direct reply"),
    ) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    (channelSource?.compareDocumentPosition(
      within(mentionRow).getByText("Please review this"),
    ) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  for (const row of [dmRow, mentionRow]) {
    expect(row).not.toHaveTextContent(
      / · (Mention|Thread|Agent)|Needs action|Project update/,
    );
  }
  expect(
    within(dmRow).getByRole("button", { name: "Open Alice in DM · Alice" }),
  ).toBeInTheDocument();
  await chooseFilter("DMs");
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent("A direct reply");
  await chooseFilter("Mentions");
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent("Please review this");
  await chooseFilter("All activity");
  expect(rows()).toHaveLength(3);
});

it("distinguishes same-sender thread choices by their visible safe preview", async () => {
  const h = fixture();
  const root = message(h.viewer, "room", "Another discussion", 30);
  const reply = message(h.alice, "room", "A **different** thread update", 31, [
    ["e", root.id, "", "reply"],
  ]);
  h.events.push(root, reply);
  h.emit([root, reply]);
  render(h.view);
  await screen.findByText("A different thread update");
  await chooseFilter("Threads");
  expect(rows()).toHaveLength(2);
  for (const preview of ["A thread update", "A different thread update"]) {
    const choice = screen.getByRole("button", {
      name: "Open Alice in #Design",
      description: preview,
    });
    expect(choice).toContainElement(screen.getByText(preview));
  }
});

it("renders all loaded rows without pagination while preserving unread filtering", async () => {
  const h = fixture();
  const extra = Array.from({ length: 49 }, (_, index) =>
    message(h.alice, "room", `Additional mention ${index}`, 100 + index, [
      ["p", h.viewer.pubkey],
    ]),
  );
  h.events.push(...extra);
  h.emit(extra);
  render(h.view);
  await screen.findByText("Additional mention 48");
  await waitFor(() =>
    expect(
      screen.queryByText("Checking recent activity…"),
    ).not.toBeInTheDocument(),
  );
  expect(rows()).toHaveLength(51);
  expect(
    screen.queryByRole("button", { name: "Show more" }),
  ).not.toBeInTheDocument();
  await act(async () => {
    await h.owner.session.unread.markChannelRead("room");
  });
  await chooseFilter("Unread only", "Attention");
  expect(rows()).toHaveLength(0);
  expect(
    screen.queryByRole("button", { name: "Show more" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("switch", { name: "Unread" }));
  expect(rows()).toHaveLength(51);
  expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
});

it("intersects activity and representative sender evidence without inferring missing profiles", async () => {
  const h = fixture({ withDm: true, withSenders: true, holdProfiles: true });
  render(h.view);
  await screen.findByText("Agent direct reply");
  expect(activityType()).toBe("All");
  await chooseFilter("DMs");
  await chooseFilter("Agents", "Sender");
  // Inbox's idle-only ensure reads the shared choices; no filter-owned inventory.
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent("Agent direct reply");
  await chooseFilter("Mentions");
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent("Agent mention");
  await chooseFilter("Humans", "Sender");
  expect(rows()).toHaveLength(0);
  try {
    await act(async () => h.releaseProfiles());
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveTextContent("Please review this");
    await chooseFilter("Agents", "Sender");
    h.publishAgentProfile();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(
      rows().some((row) => row.textContent?.includes("Public agent mention")),
    ).toBe(true);
    await chooseFilter("Humans", "Sender");
    h.publishMalformedProfile();
    h.publishLateProfile();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(
      rows().some((row) => row.textContent?.includes("Late profile mention")),
    ).toBe(true);
    expect(
      rows().some((row) => row.textContent?.includes("Unprofiled mention")),
    ).toBe(false);
    await chooseFilter("Everyone", "Sender");
    await waitFor(() => expect(rows().length).toBeGreaterThan(4));
    expect(
      rows().some((row) => row.textContent?.includes("Unprofiled mention")),
    ).toBe(true);
    expect(h.journal()?.state.frontiers).toEqual({}); // filtering never marks read
  } finally {
    h.releaseProfiles();
  }
});

it("offers Open and Mark as read only on unread rows, and Mark as read and a disabled Mark unread via right-click", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  const row = rows()[0];
  if (!row) throw new Error("Missing inbox row");
  const buttons = () =>
    within(row)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
  expect(buttons()).toEqual([
    "Open Alice in #Design",
    "Mark as read Alice in #Design",
  ]);
  expect(
    within(row).queryByRole("button", { name: /^Actions for / }),
  ).not.toBeInTheDocument();
  expect(row.querySelector("[data-inbox-row-overflow]")).toBeNull();
  expect(within(row).getByRole("img", { name: "Unread" })).toBeInTheDocument();
  const action = await openRowMenu("context");
  expect(action).toHaveAttribute("aria-disabled", "true");
  const menu = action.closest<HTMLElement>('[role="menu"]');
  if (!menu) throw new Error("Missing row menu");
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => [
        item.textContent,
        item.getAttribute("aria-disabled") === "true",
      ]),
  ).toEqual([
    ["Mark as read", false],
    ["Mark unread", true],
  ]);
  expect(queryReader()).not.toBeInTheDocument();
  expect(h.journal()?.state.frontiers).toEqual({});
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Mark as read" }));
  await waitFor(() =>
    expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBe(21),
  );
  // A read row has nothing to mark: only Open remains, beside its date.
  await waitFor(() => expect(buttons()).toEqual(["Open Alice in #Design"]));
  expect(row).not.toHaveAttribute("data-action");
});

it("a failed Mark as read keeps the row unread until Retry reads it", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  const row = rows()[0];
  if (!row) throw new Error("Missing inbox row");
  expect(within(row).getByRole("img", { name: "Unread" })).toBeInTheDocument();
  h.failSave();
  fireEvent.click(within(row).getByRole("button", { name: /^Mark as read / }));
  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
  expect(rows()).toEqual([row]);
  expect(within(row).getByRole("img", { name: "Unread" })).toBeInTheDocument();
  expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: "Retry activity" }));
  await waitFor(() =>
    expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBe(21),
  );
  await waitFor(() =>
    expect(within(row).queryByRole("img", { name: "Unread" })).toBeNull(),
  );
  expect(rows()).toEqual([row]);
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each(["button", "menu"] as const)(
  "under Unread, Mark as read via %s offers Undo, which returns the row unread",
  async (action) => {
    const h = fixture();
    render(h.view, { wrapper: ToastProvider });
    await screen.findByText("Please review this");
    await chooseFilter("Mentions");
    await chooseFilter("Unread only", "Attention");
    const row = rows()[0];
    if (!row) throw new Error("Missing inbox row");
    if (action === "menu") {
      await openRowMenu("context");
      fireEvent.click(screen.getByRole("menuitem", { name: "Mark as read" }));
    } else
      fireEvent.click(
        within(row).getByRole("button", { name: /^Mark as read / }),
      );
    await screen.findByText("Marked as read");
    await waitFor(() => expect(rows()).toHaveLength(0));
    expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBe(21);
    fireEvent.click(
      await screen.findByRole("button", { name: "Undo", hidden: true }),
    );
    await waitFor(() => expect(rows()).toHaveLength(1));
    await waitFor(() =>
      expect(
        within(rows()[0] as HTMLElement).getByRole("img", { name: "Unread" }),
      ).toBeInTheDocument(),
    );
  },
);

it("with Unread off, Mark as read offers no Undo and keeps focus on its row", async () => {
  const h = fixture();
  render(h.view, { wrapper: ToastProvider });
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  const row = rows()[0];
  if (!row) throw new Error("Missing inbox row");
  const check = within(row).getByRole("button", { name: /^Mark as read / });
  check.focus();
  fireEvent.click(check);
  await waitFor(() =>
    expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBe(21),
  );
  await waitFor(() =>
    expect(within(row).queryByRole("img", { name: "Unread" })).toBeNull(),
  );
  expect(rows()).toEqual([row]);
  // The ✓ leaves with the unread mark; its focus moves to the row itself.
  expect(
    within(row).queryByRole("button", { name: /^Mark as read / }),
  ).toBeNull();
  await waitFor(() =>
    expect(within(row).getByRole("button", { name: /^Open / })).toHaveFocus(),
  );
  expect(screen.queryByText("Marked as read")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Undo", hidden: true }),
  ).not.toBeInTheDocument();
});

it("under Unread only, marking a neighbor read keeps the open conversation and its draft mounted", async () => {
  const h = fixture({ withWriter: true });
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  fireEvent.click(screen.getByRole("switch", { name: "Unread" }));
  await waitFor(() =>
    expect(screen.getByRole("switch", { name: "Unread" })).toHaveAttribute(
      "aria-checked",
      "true",
    ),
  );
  const thread = rows().find((row) =>
    row.textContent?.includes("A thread update"),
  );
  const mention = rows().find((row) =>
    row.textContent?.includes("Please review"),
  );
  if (!thread || !mention) throw new Error("Missing fixture rows");
  fireEvent.click(within(thread).getByRole("button", { name: /^Open / }));
  const editor = (await screen.findByRole("textbox")) as ComposerInputElement;
  act(() => {
    editor.insertText("Keep this unread-only draft");
  });
  await waitFor(() =>
    expect(
      reader().querySelector(`[data-message-id="${h.reply.id}"]`),
    ).toHaveFocus(),
  );
  await waitFor(() =>
    expect(screen.getByRole("list", { name: "Activity" })).toHaveAttribute(
      "aria-busy",
      "false",
    ),
  );
  const opened = sideTabs();
  fireEvent.click(
    within(mention).getByRole("button", { name: /^Mark as read / }),
  );
  await waitFor(() =>
    expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBe(21),
  );
  // The read neighbor leaves; the open conversation stays, read but selected.
  await waitFor(() => expect(rows()).toEqual([thread]));
  expect(thread).toHaveAttribute("data-selected");
  expect(sideTabs()).toEqual(opened);
  expect(screen.getByRole("textbox")).toBe(editor);
  expect(editor).toHaveTextContent("Keep this unread-only draft");
  expect(
    reader().querySelector(`[data-message-id="${h.reply.id}"]`),
  ).toBeInTheDocument();
});

it("Mark as read reads an unselected row without opening or clearing it", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  const row = rows()[0];
  if (!row) throw new Error("Missing inbox row");
  await openRowMenu("context");
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Mark as read" }),
  );
  await waitFor(() =>
    expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBe(21),
  );
  await waitFor(() =>
    expect(within(row).queryByRole("img", { name: "Unread" })).toBeNull(),
  );
  expect(rows()).toEqual([row]);
  expect(row).not.toHaveAttribute("data-selected");
  expect(queryReader()).not.toBeInTheDocument();
  // Once read, Mark as read is unavailable and Mark unread returns.
  const unread = await openRowMenu("context");
  expect(unread).not.toHaveAttribute("aria-disabled");
  expect(
    screen.getByRole("menuitem", { name: "Mark as read" }),
  ).toHaveAttribute("aria-disabled", "true");
});

it("Mark as read under Unread moves focus to the next row as its row leaves", async () => {
  const h = fixture();
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  await chooseFilter("Unread only", "Attention");
  await waitFor(() => expect(rows()).toHaveLength(2));
  const [first, second] = rows();
  if (!first || !second) throw new Error("Missing inbox rows");
  within(first)
    .getByRole("button", { name: /^Open / })
    .focus();
  await openRowMenu("keyboard");
  fireEvent.click(screen.getByRole("menuitem", { name: "Mark as read" }));
  await waitFor(() => expect(rows()).toEqual([second]));
  await waitFor(() =>
    expect(
      within(second).getByRole("button", { name: /^Open / }),
    ).toHaveFocus(),
  );
});

it("opens local unread actions with the ContextMenu key without changing selection", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice in #Design" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("img", { name: "Unread" }),
    ).not.toBeInTheDocument(),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Close Thread · Design tab" }),
  );
  expect(queryReader()).not.toBeInTheDocument();
  const action = await openRowMenu("contextKey");
  expect(action).toHaveTextContent("Mark unread");
  expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBe(21);
  expect(queryReader()).not.toBeInTheDocument();
  expect(sideTabs()).toEqual([]);
  fireEvent.keyDown(action, { key: "Escape" });
});

it("holds read actions pending, surfaces storage failure, and retries without losing evidence", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  const release = h.holdSave();
  h.failSave();
  try {
    fireEvent.click(
      screen.getByRole("button", { name: "Open Alice in #Design" }),
    );
    await findReader();
  } finally {
    await act(async () => release());
  }
  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
  expect(screen.getByText("Please review this")).toBeInTheDocument();
  expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: "Retry activity" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("img", { name: "Unread" }),
    ).not.toBeInTheDocument(),
  );
  expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBe(21);
});

it.each([false, true])(
  "a two-step Inbox read admits the second prefix only while mounted (retire=%s)",
  async (retire) => {
    const h = fixture();
    const root = message(h.alice, "room", "Two-step root", 30, [
      ["p", h.viewer.pubkey],
    ]);
    const child = message(h.alice, "room", "Two-step reply", 31, [
      ["p", h.viewer.pubkey],
      ["e", root.id, "", "reply"],
    ]);
    h.events.push(root, child);
    h.emit([root, child]);
    render(h.view);
    await screen.findByText("Two-step reply");
    await waitFor(() =>
      expect(
        screen.queryByText("Checking recent activity…"),
      ).not.toBeInTheDocument(),
    );
    const row = h.owner.session.unread
      .inbox()
      .items.find((item) => item.id === `room:${root.id}`);
    if (!row) throw Error("Missing two-step conversation");
    expect(row.readThrough).toEqual([
      {
        target: { kind: "message", channelId: "room", messageId: root.id },
        messageId: root.id,
      },
      {
        target: { kind: "thread", channelId: "room", rootId: root.id },
        messageId: child.id,
      },
    ]);
    const release = h.holdSave();
    try {
      const target = rows().find((row) =>
        row.textContent?.includes("Two-step reply"),
      );
      if (!target) throw Error("Missing two-step row");
      fireEvent.click(within(target).getByRole("button", { name: /^Open / }));
      await waitFor(() => expect(h.saveStarted()).toBe(true));
      expect(h.readSteps).toHaveLength(1);
      expect(h.readSteps[0]?.id).toBe(root.id);
      if (retire) act(() => h.disconnect());
    } finally {
      await act(async () => release());
    }
    const first = h.readSteps[0];
    if (!first) throw Error("First read never started");
    await act(async () => {
      await first.work;
    });
    if (!retire) {
      await waitFor(() => expect(h.readSteps).toHaveLength(2));
      const second = h.readSteps[1];
      if (!second) throw Error("Second read never started");
      await act(async () => {
        await second.work;
      });
      expect(second.id).toBe(child.id);
      expect(h.journal()?.state.frontiers[`thread:${root.id}`]).toBe(31);
    } else {
      expect(h.readSteps).toHaveLength(1);
      expect(h.journal()?.state.frontiers[`thread:${root.id}`]).toBeUndefined();
      expect(
        screen.getByText("Choose a community to see your activity."),
      ).toBeInTheDocument();
    }
    expect(h.journal()?.state.frontiers[`msg:${root.id}`]).toBe(30);
  },
);

it("two-step read access loss during its first save stops before the second step", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const root = message(h.alice, "room", "Cancelled root", 30, [
    ["p", h.viewer.pubkey],
  ]);
  const child = message(h.alice, "room", "Cancelled reply", 31, [
    ["p", h.viewer.pubkey],
    ["e", root.id, "", "reply"],
  ]);
  h.events.push(root, child);
  h.emit([root, child]);
  render(h.view);
  await screen.findByText("Cancelled reply");
  await waitFor(() =>
    expect(h.owner.session.inboxFeed.snapshot().status).toBe("ready"),
  );
  expect(
    h.owner.session.unread
      .inbox()
      .items.find((item) => item.id === `room:${root.id}`)?.readThrough,
  ).toHaveLength(2);
  const release = h.holdSave();
  try {
    const row = rows().find((row) =>
      row.textContent?.includes("Cancelled reply"),
    );
    if (!row) throw Error("Missing two-step row");
    await user.click(within(row).getByRole("button", { name: /^Open / }));
    await waitFor(() => expect(h.saveStarted()).toBe(true));
    expect(h.readSteps.map((step) => step.id)).toEqual([root.id]);
    act(() => h.revokeRoom());
    expect(queryReader()).not.toBeInTheDocument();
  } finally {
    await act(async () => release());
  }
  await waitFor(() =>
    expect(
      screen.getByRole("list", {
        name: "Activity",
      }),
    ).toHaveAttribute("aria-busy", "false"),
  );
  expect(h.readSteps.map((step) => step.id)).toEqual([root.id]);
  expect(h.journal()?.state.frontiers[`thread:${root.id}`]).toBeUndefined();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Reading observation expired",
  );
});

it.each(["retry", "other", "blur"] as const)(
  "held read Retry completion preserves focus ownership (%s)",
  async (focusOwner) => {
    const h = fixture();
    const user = userEvent.setup();
    render(h.view);
    await screen.findByText("Please review this");
    await chooseFilter("Mentions");
    h.failSave();
    await user.click(
      screen.getByRole("button", { name: "Open Alice in #Design" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    const detail = reader();
    // The exact reader has already revealed and focused its message, so no later reveal takes focus.
    await waitFor(() =>
      expect(
        detail.querySelector(`[data-message-id="${h.mention.id}"]`),
      ).toHaveFocus(),
    );
    const retry = screen.getByRole("button", { name: "Retry activity" });
    const other = screen.getByRole("switch", { name: "Unread" });
    const release = h.holdSave();
    try {
      retry.focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(h.saveStarted()).toBe(true));
      expect(retry).toBeInTheDocument();
      expect(retry).toHaveFocus();
      expect(retry).not.toBeDisabled();
      expect(retry).toHaveAttribute("aria-disabled", "true");
      await user.keyboard("{Enter}");
      expect(h.readSteps).toHaveLength(2);
      if (focusOwner === "other") other.focus();
      if (focusOwner === "blur") retry.blur();
    } finally {
      await act(async () => release());
    }
    await waitFor(() =>
      expect(screen.queryByText("disk full")).not.toBeInTheDocument(),
    );
    expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBe(21);
    // Focus the retired Retry owned moves to a stable Inbox control.
    if (focusOwner === "retry") expect(fromTrigger()).toHaveFocus();
    else expect(focusOwner === "other" ? other : document.body).toHaveFocus();
    expect(reader()).toBe(detail);
  },
);

it("a second rejected Retry retains its focused control until a successful recovery", async () => {
  const h = fixture();
  const user = userEvent.setup();
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  h.failSave();
  await user.click(
    screen.getByRole("button", { name: "Open Alice in #Design" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
  const detail = reader();
  await waitFor(() =>
    expect(
      detail.querySelector(`[data-message-id="${h.mention.id}"]`),
    ).toHaveFocus(),
  );
  const retry = screen.getByRole("button", { name: "Retry activity" });
  const release = h.holdSave();
  h.failSave();
  try {
    retry.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(h.saveStarted()).toBe(true));
    expect(retry).toHaveFocus();
  } finally {
    await act(async () => release());
  }
  await waitFor(() =>
    expect(
      screen.getByRole("list", {
        name: "Activity",
      }),
    ).toHaveAttribute("aria-busy", "false"),
  );
  expect(retry).toHaveFocus();
  expect(screen.getByRole("alert")).toHaveTextContent("disk full");
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.queryByText("disk full")).not.toBeInTheDocument(),
  );
  expect(fromTrigger()).toHaveFocus();
  expect(reader()).toBe(detail);
});

it.each([true, false])(
  "source Retry stays mounted through held refresh and hands off list focus only when owned (%s)",
  async (keepFocus) => {
    const h = fixture();
    const user = userEvent.setup();
    render(h.view);
    await screen.findByText("Please review this");
    await waitFor(() =>
      expect(h.owner.session.inboxFeed.snapshot().status).toBe("ready"),
    );
    h.failAux();
    await act(async () => h.owner.session.inboxFeed.refresh());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "auxiliary history unavailable",
    );
    h.failAux(false);
    const release = h.holdAux();
    const retry = screen.getByRole("button", { name: "Retry activity" });
    const other = screen.getByRole("switch", { name: "Unread" });
    try {
      retry.focus();
      await user.keyboard("{Enter}");
      await waitFor(() =>
        expect(h.owner.session.inboxFeed.snapshot().incomplete).toContain(
          h.mention.id,
        ),
      );
      expect(retry).toHaveFocus();
      expect(retry).toHaveAttribute("aria-disabled", "true");
      if (!keepFocus) other.focus();
    } finally {
      await act(async () => release());
    }
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(keepFocus ? fromTrigger() : other).toHaveFocus();
  },
);

it("keeps a From menu choice focused through incoming row updates", async () => {
  const h = fixture();
  const user = userEvent.setup();
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  const trigger = fromTrigger();
  act(() => trigger.focus());
  await user.keyboard("{Enter}");
  const people = await screen.findByRole("menuitemradio", { name: "People" });
  await user.keyboard("{End}");
  await user.keyboard("{ArrowUp}");
  await waitFor(() => expect(people).toHaveFocus());
  const incoming = message(h.alice, "room", "Another review request", 50, [
    ["p", h.viewer.pubkey],
  ]);
  h.addEvent(incoming);
  await act(async () => h.emit([incoming]));
  await waitFor(() => expect(rows()).toHaveLength(3));
  expect(people).toHaveFocus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(fromTrigger()).toHaveAccessibleName("From people");
  await waitFor(() => expect(fromTrigger()).toHaveFocus());
});

it("Mark as read keeps the type, From and Unread choices", async () => {
  const h = fixture({ withSenders: true });
  render(h.view);
  await screen.findByText("Public agent mention");
  await waitFor(() => expect(rows().length).toBeGreaterThan(0));

  expect(activityType()).toBe("All");
  expect(screen.queryByRole("group", { name: "Inbox scope" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "About Inbox archive" }),
  ).toBeNull();

  await chooseFilter("Mentions");
  await chooseFilter("Agents", "Sender");
  await waitFor(() => expect(rows()).toHaveLength(2));
  const agentRow = rows().find((row) =>
    row.textContent?.includes("Agent mention"),
  );
  if (!agentRow) throw new Error("Missing agent-authored mention");
  await chooseFilter("Unread only", "Attention");
  const agentOpen = within(agentRow).getByRole("button", { name: /^Open / });
  agentOpen.focus();
  fireEvent.keyDown(agentOpen, { key: "F10", shiftKey: true });
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Mark as read" }),
  );
  await waitFor(() => expect(rows()).toHaveLength(1));

  const expectKept = (unread = "true") => {
    expect(activityType()).toBe("Mentions");
    expect(fromTrigger()).toHaveAccessibleName("From agents");
    expect(screen.getByRole("switch", { name: "Unread" })).toHaveAttribute(
      "aria-checked",
      unread,
    );
  };
  expectKept();
  await chooseFilter("All messages", "Attention");
  await waitFor(() => expect(rows()).toHaveLength(2));
  expectKept("false");
});

it("names the page Activity in its region, page tab and list", async () => {
  const h = fixture();
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  expect(screen.getByRole("region", { name: "Activity" })).toBeInTheDocument();
  expect(tabs("Activity tabs")).toEqual(["Activity"]);
  expect(screen.getByRole("list", { name: "Activity" })).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Inbox" })).toBeNull();
  expect(screen.queryByText(/\binbox\b/i)).toBeNull();
});

it.each([
  ["Anyone", "From anyone", "ghost"],
  ["People", "From people", "subtle"],
  ["Agents", "From agents", "subtle"],
])(
  "From says %s in its name and tooltip, filled only while it narrows",
  async (choice, name, variant) => {
    const h = fixture();
    render(h.view);
    await waitFor(() => expect(rows()).toHaveLength(2));
    if (choice !== "Anyone")
      await chooseFilter(choice === "People" ? "Humans" : choice, "Sender");
    const trigger = fromTrigger();
    // The visible label stays "From"; its name and tooltip say the choice.
    expect(trigger).toHaveAccessibleName(name);
    expect(trigger).toHaveTextContent(/^From$/);
    expect(trigger).toHaveAttribute("data-variant", variant);
    act(() => trigger.blur());
    fireEvent.keyDown(window, { key: "Tab" });
    act(() => trigger.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent(name);
    const user = userEvent.setup();
    await user.click(trigger);
    const menu = await screen.findByRole("menu", { name: "From" });
    // Choices are plain words.
    expect(
      within(menu)
        .getAllByRole("menuitemradio")
        .map((item) => item.textContent),
    ).toEqual(["Anyone", "People", "Agents"]);
    expect(menu.querySelector(".buzz-menu-icon")).toBeNull();
    expect(
      within(menu).getByRole("menuitemradio", { name: choice }),
    ).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{Escape}");
  },
);

it("orders the toolbar as tabs, From, then Unread", async () => {
  const h = fixture();
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  const tablist = screen.getByRole("tablist", { name: "Activity type" });
  const unread = screen.getByRole("switch", { name: "Unread" });
  const follows = (a: Node, b: Node) =>
    !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  expect(follows(tablist, fromTrigger())).toBe(true);
  expect(follows(fromTrigger(), unread)).toBe(true);
});

it("combines the existing filter choices without placeholder actions", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  const trigger = fromTrigger();
  expect(trigger).toHaveAccessibleName("From anyone");
  expect(screen.queryByRole("combobox")).toBeNull();
  // Inbox's own tab holds the list; its only other tabs are the type filter.
  expect(tabs("Activity tabs")).toEqual(["Activity"]);
  expect(tabs("Activity type")).toEqual([
    "All",
    "Threads",
    "Mentions",
    "DMs",
    "Reactions",
  ]);
  expect(activityType()).toBe("All");
  expect(
    within(screen.getByRole("tabpanel", { name: "Activity" }))
      .queryAllByRole("tablist")
      .map((list) => list.getAttribute("aria-label")),
  ).toEqual(["Activity type"]);
  expect(
    screen.queryByRole("button", { name: /Mark shown as read|Mark unread/ }),
  ).toBeNull();
  // Mark as read is a per-row action, never a list-wide one.
  expect(
    screen
      .getAllByRole("button", { name: /Mark as read/ })
      .every((button) => button.closest("li[data-inbox-row]")),
  ).toBe(true);
  expect(
    screen.queryByText(
      /Verified recent conversations|Results are bounded|Feed history reached its result limit|Read-state sync is unavailable on this host/,
    ),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  expect(screen.getByRole("switch", { name: "Unread" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  const user = userEvent.setup();
  trigger.focus();
  await user.keyboard("{Enter}");
  const menu = await screen.findByRole("menu", { name: "From" });
  // From is a single choice; types are tabs, not menu items.
  expect(
    within(menu)
      .getAllByRole("menuitemradio")
      .map((item) => [item.textContent, item.getAttribute("aria-checked")]),
  ).toEqual([
    ["Anyone", "true"],
    ["People", "false"],
    ["Agents", "false"],
  ]);
  expect(within(menu).queryAllByRole("menuitemcheckbox")).toEqual([]);
  for (const name of ["Drafts", "Projects", "Needs action", "Reactions"])
    expect(within(menu).queryByRole("menuitemradio", { name })).toBeNull();
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
});

it("waits for roster recovery before explicit evidence refresh", async () => {
  const h = fixture({ failRoster: true });
  render(h.view);
  expect(await screen.findByRole("alert")).toHaveTextContent("roster offline");
  const baseline = h.evidenceReads();
  const release = h.recoverRoster();
  try {
    fireEvent.click(screen.getByRole("button", { name: "Retry activity" }));
    await waitFor(() => expect(h.rosterStarted()).toBe(true));
    expect(h.evidenceReads()).toBe(baseline);
    expect(h.retrySync).toHaveBeenCalledOnce();
  } finally {
    await act(async () => release());
  }
  await screen.findByText("Please review this");
  expect(h.evidenceReads()).toBeGreaterThan(baseline);
});

it("cache clear shows explicit refresh instead of a spinner with no pending work", async () => {
  const h = fixture();
  const root = h.root;
  if (!root) throw new Error("Missing fixture root");
  // Only the feed reads reactions; unread evidence never includes them.
  h.addEvent(
    signed(h.alice, {
      kind: 7,
      content: "❤️",
      created_at: 30,
      tags: [
        ["e", root.id],
        ["p", h.viewer.pubkey],
      ],
    }),
  );
  const reaction = { name: /Alice reacted with heart/ };
  render(h.view);
  await screen.findByText("Please review this");
  await screen.findByRole("button", reaction);
  await waitFor(() =>
    expect(
      screen.queryByText("Checking recent activity…"),
    ).not.toBeInTheDocument(),
  );
  await act(async () => {
    await h.owner.clearCache();
  });
  // The repair the clear starts brings back the mention from unread evidence
  // on its own, but the cleared feed stays idle: it offers Refresh rather than
  // a spinner with nothing pending.
  await screen.findByText("Please review this");
  expect(h.owner.session.inboxFeed.snapshot().status).toBe("idle");
  expect(screen.getByText("Check recent activity.")).toBeVisible();
  expect(
    screen.queryByText("Checking recent activity…"),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("button", reaction)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByRole("button", reaction);
  expect(h.owner.session.inboxFeed.snapshot().status).toBe("ready");
  expect(h.retrySync).not.toHaveBeenCalled();
});

it("does not accept a second row selection while its explicit read is pending", async () => {
  const h = fixture({ withDm: true });
  render(h.view);
  await screen.findByText("A direct reply");
  await waitFor(() =>
    expect(
      screen.queryByText("Checking recent activity…"),
    ).not.toBeInTheDocument(),
  );
  const release = h.holdSave();
  try {
    fireEvent.click(
      screen.getByRole("button", { name: "Open Alice in DM · Alice" }),
    );
    await waitFor(() => expect(h.saveStarted()).toBe(true));
    const other = rows().find((row) =>
      row.textContent?.includes("Please review this"),
    );
    if (!other) throw Error("missing second row");
    const button = within(other).getByRole("button", { name: /^Open / });
    expect(button).toBeDisabled();
    expect(screen.getByRole("list", { name: "Activity" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    fireEvent.click(button);
    expect(sideTabs()).toEqual(["Alice"]);
    expect(
      screen.getByRole("region", { name: "Conversation in Alice" }),
    ).toBeInTheDocument();
    expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBeUndefined();
  } finally {
    await act(async () => release());
  }
  await waitFor(() =>
    expect(screen.getByRole("list", { name: "Activity" })).toHaveAttribute(
      "aria-busy",
      "false",
    ),
  );
  const other = rows().find((row) =>
    row.textContent?.includes("Please review this"),
  );
  if (!other) throw Error("missing second row");
  fireEvent.click(within(other).getByRole("button", { name: /^Open / }));
  await waitFor(() =>
    expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBe(21),
  );
});
it("a failed captured read cannot retry after access retirement", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  h.failSave();
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice in #Design" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
  act(() => h.revokeRoom());
  await waitFor(() => expect(rows()).toHaveLength(0));
  fireEvent.click(screen.getByRole("button", { name: "Retry activity" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This action expired",
  );
  expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBeUndefined();
});
it("classifies cached profile-only agents beyond the first 50 without unbounded enrichment", async () => {
  const h = fixture();
  const agent = profile(
    h.profileAgent,
    { name: "Cached outside", is_agent: true },
    100,
  );
  const first = Array.from({ length: 51 }, (_, index) =>
    message(h.unknown, "room", `Unknown ${index}`, 100 + index, [
      ["p", h.viewer.pubkey],
    ]),
  );
  const outside = message(h.profileAgent, "room", "Outside first fifty", 90, [
    ["p", h.viewer.pubkey],
  ]);
  h.events.push(agent, ...first, outside);
  h.emit([agent, ...first, outside]);
  render(h.view);
  await screen.findByText("Unknown 50");
  await waitFor(() =>
    expect(
      screen.queryByText("Checking recent activity…"),
    ).not.toBeInTheDocument(),
  );
  // Roster completion clears optional profiles; restore genuinely shared cache evidence after it.
  act(() => h.emit([agent]));
  await chooseFilter("Agents", "Sender");
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent("Outside first fifty");
  expect(
    screen.queryByRole("button", { name: "Show more" }),
  ).not.toBeInTheDocument();
  await chooseFilter("Humans", "Sender");
  expect(
    rows().some((row) => row.textContent?.includes("Outside first fifty")),
  ).toBe(false);
  act(() => h.emit([profile(h.profileAgent, { name: "Cached outside" }, 101)]));
  await waitFor(() =>
    expect(
      rows().some((row) => row.textContent?.includes("Outside first fifty")),
    ).toBe(true),
  );
});

it("feed invalidation has its own local recovery even when shared unread stays ready", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await waitFor(() =>
    expect(h.owner.session.inboxFeed.snapshot().status).toBe("ready"),
  );
  expect(h.owner.session.unread.inbox().status).toBe("ready");
  act(() => h.owner.session.inboxFeed.clear());
  expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(h.owner.session.inboxFeed.snapshot().status).toBe("ready"),
  );
  expect(
    screen.queryByRole("button", { name: "Refresh" }),
  ).not.toBeInTheDocument();
});
it("a newer manual intent invalidates retry of an earlier rejected read", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  h.failSave();
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice in #Design" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
  await act(async () =>
    h.owner.session.unread.markUnreadLocal({
      kind: "message",
      channelId: "room",
      messageId: h.mention.id,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry activity" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This action expired",
  );
  expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBeUndefined();
  expect(h.journal()?.localUnread[`msg:${h.mention.id}`]).toBeTypeOf("number");
});

it("same-value manual writes after a failed mark-unread supersede retry even without a projection change", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice in #Design" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("img", { name: "Unread" }),
    ).not.toBeInTheDocument(),
  );
  h.failSave();
  fireEvent.click(await openRowMenu());
  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
  // An explicit newer read at the same saved frontier has the same visual snapshot.
  await act(async () =>
    h.owner.session.unread.markThrough(
      { kind: "message", channelId: "room", messageId: h.mention.id },
      h.mention.id,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry activity" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This action expired",
  );
  expect(h.journal()?.localUnread[`msg:${h.mention.id}`]).toBeUndefined();
});

it("routine delayed publication does not cancel Retry for a failed mark-unread save", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice in #Design" }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBe(21);
  const revision = h.owner.session.unread.revision();
  fireEvent.contextMenu(
    within(rows()[0] as HTMLElement).getByRole("button", { name: /^Open / }),
    {
      clientX: 20,
      clientY: 20,
    },
  );
  const release = h.holdSave();
  h.failSave();
  try {
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark unread" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(h.saveStarted()).toBe(true);
  } finally {
    await act(async () => release());
  }
  expect(screen.getByRole("alert")).toHaveTextContent("disk full");
  // Run the already-scheduled publication, including its no-op storage reread.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(h.journal()?.acceptedRevision).toBe(revision);
  expect(h.owner.session.unread.revision()).toBe(revision);
  fireEvent.click(screen.getByRole("button", { name: "Retry activity" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(h.journal()?.localUnread[`msg:${h.mention.id}`]).toBeTypeOf("number");
  expect(screen.queryByText("disk full")).not.toBeInTheDocument();
});

it.each([true, false])(
  "Inbox activity replies preserve shared recipient policy (solo=%s)",
  async (soloChannel) => {
    const h = fixture({ withWriter: true, soloChannel, memberAgents: 1 });
    if (soloChannel)
      writeView(h.owner.session.scope, "draft:room", {
        text: "@Scout Respond to this",
        recipients: [
          { pubkey: h.agent.pubkey, name: "Scout", start: 0, end: 6 },
        ],
      });
    render(h.view);
    await screen.findByText("Please review this");
    await chooseFilter("Mentions");
    fireEvent.click(
      screen.getByRole("button", {
        name: soloChannel ? "Open Alice in Design" : "Open Alice in #Design",
      }),
    );
    const editor = await screen.findByRole("textbox", {
      name: soloChannel ? "Message this conversation" : "Reply to thread",
    });
    if (!soloChannel)
      fireEvent.change(editor, { target: { value: "Respond to this" } });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => {
      const alerts = screen.queryAllByRole("alert").map((el) => el.textContent);
      const failed = h.owner.session.outbox
        ?.snapshot()
        .filter((row) => row.delivery === "failed");
      expect({ alerts, failed, published: h.published.length }).toEqual({
        alerts: [],
        failed: [],
        published: 1,
      });
    });
    const sent = h.published[0];
    if (!sent) throw Error("Missing publication");
    expect(sent.tags).toContainEqual(["h", "room"]);
    // A Solo chat is flat: Inbox replies continue it at the top level.
    expect(sent.tags.some(([name]) => name === "e")).toBe(!soloChannel);
    if (!soloChannel)
      expect(sent.tags).toContainEqual(["e", h.mention.id, "", "reply"]);
    expect(sent.tags.filter(([name]) => name === "p")).toEqual(
      soloChannel ? [["p", h.agent.pubkey]] : [],
    );
  },
);
it("Inbox Solo chat activity shared with a person sends without a tag", async () => {
  const h = fixture({
    withWriter: true,
    soloChannel: true,
    memberAgents: 2,
  });
  writeView(h.owner.session.scope, "draft:room", {
    text: "No tag needed",
    recipients: [],
  });
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  fireEvent.click(screen.getByRole("button", { name: "Open Alice in Design" }));
  const editor = await screen.findByRole("textbox", {
    name: "Message this conversation",
  });
  expect(editor).toHaveValue("No tag needed");
  // Alice is a member, so the viewer isn't alone with agents.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(h.published).toHaveLength(1));
  expect(h.published[0]?.tags.filter(([name]) => name === "p")).toEqual([]);
});

it("a Solo chat row includes ordinary agent responses under All, not DMs, keeping threads separate", async () => {
  const h = fixture({ soloChannel: true, memberAgents: 1 });
  const progress = message(h.agent, "room", "Agent progress", 30);
  h.addEvent(progress);
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  act(() => h.emit([progress]));
  await waitFor(() => expect(rows()[0]).toHaveTextContent("Agent progress"));
  expect(rows()[1]).toHaveTextContent("A thread update");
  expect(screen.queryByText("Please review this")).not.toBeInTheDocument();
  // Opening the timeline row reads it with one channel catch-up mark, leaving
  // its separate thread row unread.
  const before = h.journal()?.revision ?? 0;
  fireEvent.click(
    within(rows()[0] as HTMLElement).getByRole("button", { name: /^Open / }),
  );
  await waitFor(() =>
    expect(h.journal()?.state.frontiers["activity:room"]).toBe(30),
  );
  expect(h.journal()?.revision).toBe(before + 1);
  expect(
    within(rows()[1] as HTMLElement).getByRole("img", { name: "Unread" }),
  ).toBeInTheDocument();
  // The sidebar keeps Solo chats apart from direct messages; so does Inbox.
  await chooseFilter("DMs");
  expect(screen.queryByText("Agent progress")).not.toBeInTheDocument();
});

it("Inbox keeps an open Solo chat timeline when a late reply regroups its mention", async () => {
  const h = fixture({
    withWriter: true,
    soloChannel: true,
    memberAgents: 1,
  });
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  fireEvent.click(screen.getByRole("button", { name: "Open Alice in Design" }));
  const editor = await screen.findByRole("textbox", {
    name: "Message this conversation",
  });
  fireEvent.change(editor, { target: { value: "Draft in progress" } });
  act(() =>
    h.emit([
      message(h.alice, "room", "Threaded follow-up", 30, [
        ["e", h.mention.id, "", "reply"],
        ["p", h.viewer.pubkey],
      ]),
    ]),
  );
  await waitFor(() =>
    expect(
      h.owner.session.unread
        .inbox()
        .items.find((item) => item.messageIds.includes(h.mention.id))?.thread,
    ).toBe(true),
  );
  await act(async () => {});
  expect(
    screen.getByRole("textbox", { name: "Message this conversation" }),
  ).toHaveValue("Draft in progress");
  expect(
    screen.queryByRole("textbox", { name: "Reply to thread" }),
  ).not.toBeInTheDocument();
  const [row] = rows();
  if (!row) throw Error("Missing regrouped row");
  // Reselecting the regrouped row keeps its Solo chat timeline.
  fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
  await act(async () => {});
  expect(
    screen.getByRole("textbox", { name: "Message this conversation" }),
  ).toHaveValue("Draft in progress");
  expect(
    screen.queryByRole("textbox", { name: "Reply to thread" }),
  ).not.toBeInTheDocument();
});

it.each(["preview", "name", "history"])(
  "failed unread Retry survives harmless channel %s replacement",
  async (change) => {
    const h = fixture();
    render(h.view);
    await screen.findByText("Please review this");
    await chooseFilter("Mentions");
    fireEvent.click(
      screen.getByRole("button", { name: "Open Alice in #Design" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("img", { name: "Unread" }),
      ).not.toBeInTheDocument(),
    );
    const before = h.owner.session.channels
      .list()
      .channels.find((channel) => channel.id === "room");
    const revision = h.owner.session.unread.revision();
    const row = h.owner.session.unread
      .inbox()
      .items.find((row) => row.messageId === h.mention.id);
    if (!before || !row) throw Error("Missing ready evidence");
    h.failSave();
    fireEvent.click(await openRowMenu());
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    if (change === "name") act(() => h.renameRoom());
    else if (change === "preview")
      act(() => h.emit([message(h.alice, "room", "Unrelated traffic", 60)]));
    else {
      h.events.push(message(h.alice, "room", "Historical preview", 61));
      act(() => h.owner.session.channels.ensure("room"));
      await waitFor(() =>
        expect(h.owner.session.channels.window("room").status).toBe("ready"),
      );
    }
    await waitFor(() =>
      expect(
        h.owner.session.channels
          .list()
          .channels.find((channel) => channel.id === "room"),
      ).not.toBe(before),
    );
    expect(h.owner.session.unread.revision()).toBe(revision);
    expect(
      h.owner.session.unread.inbox().items.find((item) => item.id === row.id),
    ).toEqual(row);
    fireEvent.click(screen.getByRole("button", { name: "Retry activity" }));
    await waitFor(() =>
      expect(h.journal()?.localUnread[`msg:${h.mention.id}`]).toBeTypeOf(
        "number",
      ),
    );
  },
);
it("revoke and regrant cannot revive a captured failed Inbox mutation", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  h.failSave();
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice in #Design" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
  act(() => {
    h.revokeRoom();
    h.restoreRoom();
  });
  await waitFor(() => expect(rows()).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "Retry activity" }));
  expect(
    await screen.findByText(
      "This action expired. Close and reopen the conversation.",
    ),
  ).toBeInTheDocument();
  expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBeUndefined();
});

it.each(["read-only", "unsupported"] as const)(
  "%s host cannot create an unread mark it cannot clear",
  async (readCapability) => {
    const h = fixture({ readCapability });
    render(h.view);
    await screen.findByText("Please review this");
    await chooseFilter("Mentions");
    await waitFor(() =>
      expect(
        screen.queryByText("Checking recent activity…"),
      ).not.toBeInTheDocument(),
    );
    expect(h.owner.session.unread.sync().capability).toBe(readCapability);
    expect(rows()).toHaveLength(1);
    expect(
      within(rows()[0] as HTMLElement).queryByRole("img", { name: "Unread" }),
    ).not.toBeInTheDocument();
    const before = h.journal();
    if (!before) throw Error("Missing saved read state");
    fireEvent.click(
      screen.getByRole("button", { name: "Open Alice in #Design" }),
    );
    await screen.findByRole("region", { name: "Thread messages" });
    const action = await openRowMenu();
    expect(action).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(action);
    await act(async () => {});
    expect(h.journal()).toEqual(before);
    expect(h.journal()?.localUnread).toEqual({ [`msg:${"f".repeat(64)}`]: 1 });
  },
);
it("retiring a session removes its open unread menu without another write", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice in #Design" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("img", { name: "Unread" }),
    ).not.toBeInTheDocument(),
  );
  const action = await openRowMenu();
  const before = h.journal();
  act(() => h.disconnect());
  expect(action).not.toBeInTheDocument();
  await act(async () => {});
  expect(h.journal()).toEqual(before);
});

it("a two-step read retries its rejected thread prefix without losing the saved first step", async () => {
  const h = fixture();
  const root = message(h.alice, "room", "Partial root", 30, [
    ["p", h.viewer.pubkey],
  ]);
  const child = message(h.alice, "room", "Partial reply", 31, [
    ["p", h.viewer.pubkey],
    ["e", root.id, "", "reply"],
  ]);
  h.events.push(root, child);
  h.emit([root, child]);
  render(h.view);
  await screen.findByText("Partial reply");
  await waitFor(() =>
    expect(
      screen.queryByText("Checking recent activity…"),
    ).not.toBeInTheDocument(),
  );
  h.failThreadSave();
  const row = rows().find((row) => row.textContent?.includes("Partial reply"));
  if (!row) throw Error("Missing two-step row");
  fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "thread disk full",
  );
  expect(h.readSteps.map((step) => step.id)).toEqual([root.id, child.id]);
  expect(h.journal()?.state.frontiers[`msg:${root.id}`]).toBe(30);
  expect(h.journal()?.state.frontiers[`thread:${root.id}`]).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: "Retry activity" }));
  await waitFor(() =>
    expect(h.journal()?.state.frontiers[`thread:${root.id}`]).toBe(31),
  );
  expect(h.journal()?.state.frontiers[`msg:${root.id}`]).toBe(30);
});

it("All activity stays chat-only when addressed project and approval evidence arrives", async () => {
  const h = fixture();
  const nonchat = [1621, 46010].map((kind) =>
    signed(h.alice, {
      kind,
      content: `Not an Inbox conversation ${kind}`,
      created_at: 40,
      tags: [
        ["h", "room"],
        ["p", h.viewer.pubkey],
        ["a", `30617:${h.alice.pubkey}:repo`],
      ],
    }),
  );
  h.events.push(...nonchat);
  render(h.view);
  await screen.findByText("Please review this");
  await waitFor(() =>
    expect(h.owner.session.inboxFeed.snapshot().status).toBe("ready"),
  );
  expect(rows()).toHaveLength(2);
  act(() => h.emit(nonchat));
  expect(rows()).toHaveLength(2);
  expect(screen.queryByText(/Not an Inbox conversation/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Open in project" })).toBeNull();
});

it("keeps the captured reply selected when its older root is verified", async () => {
  const h = fixture();
  const unknownRoot = message(h.alice, "room", "Late root", 39);
  const reply = message(h.alice, "room", "Orphan addressed reply", 42, [
    ["p", h.viewer.pubkey],
    ["e", unknownRoot.id, "", "reply"],
  ]);
  h.events.push(reply);
  h.emit([reply]);
  render(h.view);
  await screen.findByText("Orphan addressed reply");
  const row = rows().find((item) =>
    item.textContent?.includes("Orphan addressed reply"),
  );
  if (!row) throw Error("Missing orphan row");
  const open = within(row).getByRole("button", { name: /^Open / });
  fireEvent.click(open);
  const detail = await findReader();
  expect(open).toHaveAttribute("aria-current", "page");
  act(() => h.emit([unknownRoot]));
  expect(reader()).toBe(detail);
  expect(sideTabs()).toHaveLength(1);
  const regrouped = rows().find((item) =>
    item.textContent?.includes("Orphan addressed reply"),
  );
  if (!regrouped) throw Error("Missing regrouped row");
  const reopen = within(regrouped).getByRole("button", { name: /^Open / });
  expect(reopen).toHaveAttribute("aria-current", "page");
  // Reselecting the regrouped row keeps the captured visit in its one tab.
  fireEvent.click(reopen);
  expect(reopen).toHaveAttribute("aria-current", "page");
  expect(sideTabs()).toHaveLength(1);
  expect(h.open).not.toHaveBeenCalled();
});

it("a Solo chat row previewing unfinished workflow output that is not its evidence shows its placeholder", async () => {
  const h = fixture({ soloChannel: true });
  // Output attributed to the viewer without a workflow mention is not Inbox
  // evidence, but the addressed feed still settles its stored overlays.
  const output = signed(h.relayKey, {
    kind: 9,
    content: "OLD BODY",
    created_at: 39,
    tags: [
      ["h", "room"],
      ["p", h.viewer.pubkey],
      ["buzz:workflow", "true"],
      ["buzz:workflow-owner", h.viewer.pubkey],
    ],
  });
  // Fill the bounded addressed page so the row's own mention stays settled.
  h.events.unshift(
    output,
    ...Array.from({ length: 49 }, (_, i) =>
      message(h.viewer, "room", `Note ${i}`, 1 + i, [["p", h.viewer.pubkey]]),
    ),
  );
  const release = h.holdAux();
  render(h.view);
  act(() => h.emit([output]));
  const timeline = () => {
    const row = rows().find(
      (item) => !item.textContent?.includes("A thread update"),
    );
    if (!row) throw Error("Missing timeline row");
    return row;
  };
  try {
    await waitFor(() =>
      expect(h.owner.session.inboxFeed.snapshot().incomplete).toContain(
        output.id,
      ),
    );
    expect(h.owner.session.inboxFeed.snapshot().incomplete).not.toContain(
      h.mention.id,
    );
    await waitFor(() =>
      expect(timeline()).toHaveTextContent("Preview updating…"),
    );
    expect(timeline()).not.toHaveTextContent("OLD BODY");
    h.failAux();
  } finally {
    await act(async () => release());
  }
  await waitFor(() =>
    expect(timeline()).toHaveTextContent(
      "Preview unavailable. Retry activity.",
    ),
  );
  expect(timeline()).not.toHaveTextContent("OLD BODY");
});

it("shows only the exact unfinished row's placeholder through held edits and retry, never an unverified body", async () => {
  const h = fixture();
  const old = message(h.alice, "room", "OLD BODY", 39, [
    ["p", h.viewer.pubkey],
  ]);
  const edit = signed(h.alice, {
    kind: 40003,
    content: "CURRENT BODY",
    created_at: 40,
    tags: [
      ["h", "room"],
      ["e", old.id],
    ],
  });
  h.events.push(old, edit);
  const release = h.holdAux();
  render(h.view);
  try {
    await waitFor(() =>
      expect(h.owner.session.inboxFeed.snapshot().incomplete).toContain(old.id),
    );
    const unfinished = rows().find((row) =>
      row.textContent?.includes("Preview updating…"),
    );
    if (!unfinished) throw Error("Missing pending preview row");
    expect(unfinished).not.toHaveTextContent("OLD BODY");
    expect(
      within(unfinished).getByRole("button", { name: /^Open / }),
    ).toHaveAccessibleDescription("Preview updating…");
    const unaffected = rows().find((row) =>
      row.textContent?.includes("A thread update"),
    );
    expect(unaffected).toBeDefined();
    expect(unaffected).not.toHaveTextContent("Preview updating…");
    fireEvent.click(within(unfinished).getByRole("button", { name: /^Open / }));
    expect(
      screen.getByRole("button", {
        name: /^Open /,
        current: "page",
      }),
    ).toHaveAccessibleDescription("Preview updating…");
    expect(unfinished).not.toHaveTextContent("OLD BODY");
    h.failAux();
  } finally {
    await act(async () => release());
  }
  await waitFor(() =>
    expect(
      screen.getByRole("button", {
        name: /^Open /,
        current: "page",
      }),
    ).toHaveAccessibleDescription("Preview unavailable. Retry activity."),
  );
  h.failAux(false);
  fireEvent.click(screen.getByRole("button", { name: "Retry activity" }));
  await waitFor(() =>
    expect(h.owner.session.inboxFeed.snapshot()).toMatchObject({
      status: "ready",
      incomplete: [],
    }),
  );
  expect(
    screen.getByRole("button", {
      name: /^Open /,
      current: "page",
    }),
  ).toHaveAccessibleDescription("CURRENT BODY");
  expect(rows().some((row) => row.textContent?.includes("CURRENT BODY"))).toBe(
    true,
  );
  expect(rows().some((row) => row.textContent?.includes("OLD BODY"))).toBe(
    false,
  );
});

it("freezes the top-level origin coordinate when read-state switches representative to a reply", async () => {
  const h = fixture();
  const root = message(h.alice, "room", "New root mention", 30, [
    ["p", h.viewer.pubkey],
  ]);
  const reply = message(h.alice, "room", "New reply mention", 31, [
    ["p", h.viewer.pubkey],
    ["e", root.id, "", "reply"],
  ]);
  h.addEvent(root);
  h.addEvent(reply);
  h.emit([root, reply]);
  render(h.view);
  await screen.findByText("New reply mention");
  const row = rows().find((item) =>
    item.textContent?.includes("New reply mention"),
  );
  if (!row) throw Error("Missing root mention");
  fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
  await waitFor(() =>
    expect(h.journal()?.state.frontiers[`thread:${root.id}`]).toBe(31),
  );
  expect(reader()).toBeInTheDocument();
  // Reading changes the row representative, not the already captured visit.
  const selectedRow = rows().find((item) =>
    item.textContent?.includes("New reply mention"),
  );
  if (!selectedRow) throw Error("Missing regrouped selected row");
  expect(selectedRow).toHaveAttribute("data-selected");
  const steps = h.readSteps.length;
  fireEvent.click(within(selectedRow).getByRole("button", { name: /^Open / }));
  expect(selectedRow).toHaveAttribute("data-selected");
  expect(sideTabs()).toHaveLength(1);
  expect(h.readSteps).toHaveLength(steps);
  expect(h.open).not.toHaveBeenCalled();
});

it("retires a deleted selected row", async () => {
  const h = fixture({ withDm: true });
  render(h.view);
  await screen.findByText("A direct reply");
  const mention = rows().find((row) =>
    row.textContent?.includes("Please review this"),
  );
  if (!mention) throw Error("Missing mention row");
  fireEvent.click(within(mention).getByRole("button", { name: /^Open / }));
  await findReader();
  expect(mention).toHaveAttribute("data-selected");
  act(() =>
    h.emit([
      signed(h.alice, {
        kind: 5,
        content: "",
        created_at: 99,
        tags: [
          ["h", "room"],
          ["e", h.mention.id],
        ],
      }),
    ]),
  );
  await waitFor(() =>
    expect(
      rows().some((row) => row.textContent?.includes("Please review this")),
    ).toBe(false),
  );
  expect(rows().some((row) => row.hasAttribute("data-selected"))).toBe(false);
});

it("keeps the exact selected group visibly incomplete when a held reply regroups under an older root", async () => {
  const h = fixture();
  const root = message(h.alice, "room", "Older root", 29);
  const reply = message(h.alice, "room", "ORIGINAL REPLY", 30, [
    ["p", h.viewer.pubkey],
    ["e", root.id, "", "reply"],
  ]);
  const edit = signed(h.alice, {
    kind: 40003,
    content: "Edited reply",
    created_at: 31,
    tags: [
      ["h", "room"],
      ["e", reply.id],
    ],
  });
  h.addEvent(reply);
  h.addEvent(edit);
  const release = h.holdAux();
  render(h.view);
  try {
    await waitFor(() =>
      expect(h.owner.session.inboxFeed.snapshot().incomplete).toContain(
        reply.id,
      ),
    );
    const original = rows().find((row) =>
      row.textContent?.includes("Preview updating…"),
    );
    if (!original) throw Error("No pending orphan reply");
    fireEvent.click(within(original).getByRole("button", { name: /^Open / }));
    act(() => h.emit([root]));
    expect(
      h.owner.session.unread
        .inbox()
        .items.some(
          (row) =>
            row.id === `room:${root.id}` && row.messageIds.includes(reply.id),
        ),
    ).toBe(true);
    const selected = screen.getByRole("button", {
      name: /^Open /,
      current: "page",
    });
    expect(selected).toHaveAccessibleDescription("Preview updating…");
    expect(selected.closest("li")).not.toHaveTextContent("ORIGINAL REPLY");
  } finally {
    await act(async () => release());
  }
  await waitFor(() =>
    expect(h.owner.session.inboxFeed.snapshot().incomplete).toEqual([]),
  );
  expect(rows().some((row) => row.textContent?.includes("Edited reply"))).toBe(
    true,
  );
});

it("retries the remaining captured prefix after a harmless new reply while the second save fails", async () => {
  const h = fixture();
  const root = message(h.alice, "room", "Retry root", 30, [
    ["p", h.viewer.pubkey],
  ]);
  const child = message(h.alice, "room", "Retry reply", 31, [
    ["p", h.viewer.pubkey],
    ["e", root.id, "", "reply"],
  ]);
  const arriving = message(h.alice, "room", "Later reply", 32, [
    ["p", h.viewer.pubkey],
    ["e", root.id, "", "reply"],
  ]);
  h.addEvent(root);
  h.addEvent(child);
  h.emit([root, child]);
  render(h.view);
  await screen.findByText("Retry reply");
  await waitFor(() =>
    expect(
      screen.queryByText("Checking recent activity…"),
    ).not.toBeInTheDocument(),
  );
  h.failThreadSave();
  const row = rows().find((item) => item.textContent?.includes("Retry reply"));
  if (!row) throw Error("Missing retry row");
  fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "thread disk full",
  );
  expect(h.journal()?.state.frontiers[`msg:${root.id}`]).toBe(30);
  expect(h.journal()?.state.frontiers[`thread:${root.id}`]).toBeUndefined();
  h.addEvent(arriving);
  act(() => h.emit([arriving]));
  fireEvent.click(screen.getByRole("button", { name: "Retry activity" }));
  await waitFor(() =>
    expect(h.journal()?.state.frontiers[`thread:${root.id}`]).toBe(31),
  );
  expect(h.readSteps.map((step) => step.id)).toEqual([
    root.id,
    child.id,
    child.id,
  ]);
  expect(h.journal()?.state.frontiers[`msg:${root.id}`]).toBe(30);
  expect(
    h.owner.session.unread
      .inbox()
      .items.find((item) => item.id === `room:${root.id}`)?.messageIds,
  ).toContain(arriving.id);
});

it("preserves a failed captured read across verified root regrouping", async () => {
  const h = fixture();
  const root = message(h.alice, "room", "Late regroup root", 29);
  const orphan = message(h.alice, "room", "Regrouped reply", 30, [
    ["p", h.viewer.pubkey],
    ["e", root.id, "", "reply"],
  ]);
  h.addEvent(orphan);
  h.emit([orphan]);
  render(h.view);
  await screen.findByText("Regrouped reply");
  h.failSave();
  const row = rows().find((candidate) =>
    candidate.textContent?.includes("Regrouped reply"),
  );
  if (!row) throw Error("Missing orphan");
  fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
  h.addEvent(root);
  act(() => h.emit([root]));
  expect(
    h.owner.session.unread
      .inbox()
      .items.some(
        (item) =>
          item.id === `room:${root.id}` && item.messageIds.includes(orphan.id),
      ),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry activity" }));
  await waitFor(() =>
    expect(h.journal()?.state.frontiers[`msg:${orphan.id}`]).toBe(30),
  );
  expect(h.readSteps.map((step) => step.id)).toEqual([orphan.id, orphan.id]);
});

it("DM read Retry retains the original cutoff and survives re-click of the selected row", async () => {
  const clickedAt = Math.floor(Date.now() / 1000);
  const now = vi.spyOn(Date, "now").mockReturnValue(clickedAt * 1000);
  const h = fixture({ withDm: true });
  const releaseHistory = h.holdHistory("dm-room");
  try {
    render(h.view);
    await screen.findByText("A direct reply");
    await waitFor(() =>
      expect(
        screen.queryByText("Checking recent activity…"),
      ).not.toBeInTheDocument(),
    );
    const dmRow = rows().find((item) =>
      item.textContent?.includes("A direct reply"),
    );
    if (!dmRow) throw Error("Missing DM row");
    const row = within(dmRow).getByRole("button", { name: /^Open / });
    h.failSave();
    fireEvent.click(row);
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    fireEvent.click(row);
    now.mockReturnValue((clickedAt + 120) * 1000);
    const later = message(
      h.alice,
      "dm-room",
      "Arrived after failed read",
      clickedAt + 61,
    );
    h.addEvent(later);
    act(() => h.emit([later]));
    fireEvent.click(screen.getByRole("button", { name: "Retry activity" }));
    await waitFor(() => {
      const journal = h.journal();
      if (!journal) throw Error("Expected saved read journal");
      expect(journal.state.frontiers["dm-room"]).toBe(clickedAt);
    });
    expect(h.owner.session.unread.attention("dm-room", later.id).unread).toBe(
      true,
    );
  } finally {
    await act(async () => releaseHistory());
    now.mockRestore();
  }
});

it("Retry with a ready roster waits for both evidence reads before retrying sync", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await waitFor(() =>
    expect(h.owner.session.inboxFeed.snapshot().status).toBe("ready"),
  );
  h.failAux();
  await act(async () => h.owner.session.inboxFeed.refresh());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "auxiliary history unavailable",
  );
  h.failAux(false);
  const release = h.holdAux();
  try {
    fireEvent.click(screen.getByRole("button", { name: "Retry activity" }));
    await waitFor(() =>
      expect(h.owner.session.inboxFeed.snapshot().incomplete).toContain(
        h.mention.id,
      ),
    );
    expect(h.retrySync).not.toHaveBeenCalled();
    expect(screen.getByRole("list", { name: "Activity" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
  } finally {
    await act(async () => release());
  }
  await waitFor(() => expect(h.retrySync).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(screen.getByRole("list", { name: "Activity" })).toHaveAttribute(
      "aria-busy",
      "false",
    ),
  );
});

it("opens a thread row in a side tab beside Inbox, at its exact message", async () => {
  const h = fixture();
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  const thread = rows().find((row) =>
    row.textContent?.includes("A thread update"),
  );
  if (!thread) throw Error("Missing thread row");
  fireEvent.click(within(thread).getByRole("button", { name: /^Open / }));
  const tab = await screen.findByRole("region", {
    name: "Conversation in Design",
  });
  // The list stays Inbox's own tab; the conversation opens beside it.
  expect(tabs("Activity tabs")).toEqual(["Activity"]);
  expect(sideTabs()).toEqual(["Thread · Design"]);
  expect(screen.getByRole("list", { name: "Activity" })).toBeInTheDocument();
  expect(
    within(tab).getByRole("region", { name: "Thread messages" }),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(
      tab.querySelector(`[data-message-id="${h.reply.id}"]`),
    ).toBeInTheDocument(),
  );
  expect(thread).toHaveAttribute("data-selected");
  expect(h.open).not.toHaveBeenCalled();
});

it("replaces the tab the previous row opened", async () => {
  const h = fixture();
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  const row = (text: string) => {
    const found = rows().find((item) => item.textContent?.includes(text));
    if (!found) throw Error(`Missing ${text} row`);
    return within(found).getByRole("button", { name: /^Open / });
  };
  fireEvent.click(row("A thread update"));
  await waitFor(() =>
    expect(
      reader().querySelector(`[data-message-id="${h.reply.id}"]`),
    ).toBeInTheDocument(),
  );
  await waitFor(() =>
    expect(screen.getByRole("list", { name: "Activity" })).toHaveAttribute(
      "aria-busy",
      "false",
    ),
  );
  fireEvent.click(row("Please review"));
  await waitFor(() =>
    expect(
      reader().querySelector(`[data-message-id="${h.mention.id}"]`),
    ).toBeInTheDocument(),
  );
  expect(sideTabs()).toHaveLength(1);
  expect(
    reader().querySelector(`[data-message-id="${h.reply.id}"]`),
  ).not.toBeInTheDocument();
  expect(row("Please review").closest("li")).toHaveAttribute("data-selected");
});

it("opens a DM row's whole conversation in a tab", async () => {
  const h = fixture({ withDm: true });
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(3));
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice in DM · Alice" }),
  );
  const tab = await screen.findByRole("region", {
    name: "Conversation in Alice",
  });
  expect(sideTabs()).toEqual(["Alice"]);
  expect(
    within(tab).getByRole("region", { name: "Channel message history" }),
  ).toBeInTheDocument();
  expect(
    within(tab).queryByRole("region", { name: "Thread messages" }),
  ).not.toBeInTheDocument();
  expect(h.open).not.toHaveBeenCalled();
});

/** A DM with Alice holding `messages`, beside the fixture's channel rows. */
function seedDm(
  h: ReturnType<typeof fixture>,
  messages: readonly RelayEvent[],
) {
  const dm = [
    roster(h.relayKey, "dm-room", [h.viewer.pubkey, h.alice.pubkey], 10),
    metadata(h.relayKey, "dm-room", "Direct message", 10, [
      ["t", "dm"],
      ["hidden"],
    ]),
    ...messages,
  ];
  for (const event of dm) h.addEvent(event);
  h.emit(dm);
  return {
    row: () =>
      h.owner.session.unread
        .inbox()
        .items.find((item) => item.channelId === "dm-room"),
    open: () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Open Alice in DM · Alice" }),
      ),
  };
}
/** jsdom has no layout or window focus. Lays out thread history alone, each
 * element one visible box, so an opened thread's reveal completes and the
 * thread settles; the window stays unfocused, so nothing reads yet. The
 * returned `dwellIn` focuses the window and `reader`, then runs a controlled
 * clock until `read` holds: a thread still settling, or reflowed by the focus,
 * starts its 300 ms dwell a frame later. The wait is bounded in fake time
 * (2 s), not by how fast the runner checks. */
function threadLayout() {
  const windowFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const box = new DOMRect(0, 0, 500, 500);
  const laidOut = (element: Element) =>
    !!element.closest('[aria-label="Thread messages"]');
  const { getBoundingClientRect, getClientRects } = Element.prototype;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      return laidOut(this) ? box : getBoundingClientRect.call(this);
    },
  );
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (
    this: Element,
  ) {
    return laidOut(this)
      ? ([box] as unknown as DOMRectList)
      : getClientRects.call(this);
  });
  // A reveal's completion notice does not bubble, so capture it.
  const positioned = new Set<Element>();
  const notice = (event: Event) => {
    if (event.target instanceof Element) positioned.add(event.target);
  };
  document.addEventListener("reading-positioned", notice, true);
  onTestFinished(() =>
    document.removeEventListener("reading-positioned", notice, true),
  );
  return async (reader: HTMLElement, read: () => void) => {
    // The fake clock below never runs a frame requested before it, so first
    // let this reader's reveal finish on the real one: it notifies reading
    // once its row is placed and verified.
    await waitFor(() =>
      expect(
        [...positioned].some(
          (target) =>
            target.isConnected &&
            (target.contains(reader) || reader.contains(target)),
        ),
      ).toBe(true),
    );
    windowFocus.mockReturnValue(true);
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ],
    });
    try {
      await act(async () => reader.focus());
      for (let elapsed = 50; ; elapsed += 50) {
        await act(() => vi.advanceTimersByTimeAsync(50));
        try {
          read();
          break;
        } catch (error) {
          if (elapsed >= 2000) throw error;
        }
      }
    } finally {
      vi.useRealTimers();
    }
  };
}
/** The open DM tab's shape: its whole timeline, or one of its threads. */
async function dmTabShows(shape: "whole" | "thread") {
  await waitFor(() =>
    expect(sideTabs()).toEqual([
      shape === "whole" ? "Alice" : "Thread · Alice",
    ]),
  );
  const tab = await screen.findByRole("region", {
    name: "Conversation in Alice",
  });
  const [present, absent] =
    shape === "whole"
      ? ["Channel message history", "Thread messages"]
      : ["Thread messages", "Channel message history"];
  expect(
    within(tab).getByRole("region", { name: present }),
  ).toBeInTheDocument();
  expect(
    within(tab).queryByRole("region", { name: absent }),
  ).not.toBeInTheDocument();
  return tab;
}

it("opens a DM row resuming at a thread reply in that thread, at the reply", async () => {
  const h = fixture();
  // Alice's only DM activity is a reply under the viewer's DM message.
  const root = message(h.viewer, "dm-room", "Our DM topic", 23);
  const reply = message(h.alice, "dm-room", "A DM thread reply", 24, [
    ["e", root.id, "", "reply"],
  ]);
  const dm = seedDm(h, [root, reply]);
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(3));
  dm.open();
  const tab = await dmTabShows("thread");
  await waitFor(() =>
    expect(
      tab.querySelector(`[data-message-id="${reply.id}"]`),
    ).toBeInTheDocument(),
  );
  expect(h.open).not.toHaveBeenCalled();
});

it("opens a DM whole when an older unread thread reply precedes newer top-level messages, and re-clicking keeps it whole", async () => {
  const h = fixture();
  const root = message(h.viewer, "dm-room", "Our DM topic", 23);
  const reply = message(h.alice, "dm-room", "A DM thread reply", 24, [
    ["e", root.id, "", "reply"],
  ]);
  const one = message(h.alice, "dm-room", "Top level one", 25);
  const two = message(h.alice, "dm-room", "Top level two", 26);
  const dm = seedDm(h, [root, reply, one, two]);
  render(h.view);
  await waitFor(() =>
    expect(dm.row()).toMatchObject({ messageId: reply.id, unreadCount: 3 }),
  );
  expect(dm.row()?.threadOnly).toBeUndefined();
  // Reading the row reads the whole DM, so its tab shows the top-level messages.
  dm.open();
  await dmTabShows("whole");
  // Read, the row resumes at its newest, top-level message.
  await waitFor(() =>
    expect(dm.row()).toMatchObject({ messageId: two.id, unreadCount: 0 }),
  );
  dm.open();
  await act(async () => {});
  await dmTabShows("whole");
  expect(h.open).not.toHaveBeenCalled();
});

it("opens a DM whole when an older unread top-level message precedes a newer thread reply, and re-clicking keeps it whole once read", async () => {
  const h = fixture();
  const root = message(h.viewer, "dm-room", "Our DM topic", 23);
  const top = message(h.alice, "dm-room", "A top-level message", 24);
  const reply = message(h.alice, "dm-room", "A DM thread reply", 25, [
    ["e", root.id, "", "reply"],
  ]);
  const dm = seedDm(h, [root, top, reply]);
  render(h.view);
  await waitFor(() =>
    expect(dm.row()).toMatchObject({ messageId: top.id, unreadCount: 2 }),
  );
  dm.open();
  await dmTabShows("whole");
  // Read, the row would now open its newest message's thread, but
  // re-clicking keeps the whole DM it opened.
  await waitFor(() =>
    expect(dm.row()).toMatchObject({
      messageId: reply.id,
      threadOnly: true,
      unreadCount: 0,
    }),
  );
  dm.open();
  await act(async () => {});
  await dmTabShows("whole");
});

it("re-clicking a DM row opened as a thread opens the whole DM once a top-level message arrives", async () => {
  const h = fixture();
  const root = message(h.viewer, "dm-room", "Our DM topic", 23);
  const reply = message(h.alice, "dm-room", "A DM thread reply", 24, [
    ["e", root.id, "", "reply"],
  ]);
  const dm = seedDm(h, [root, reply]);
  render(h.view);
  await waitFor(() => expect(dm.row()?.threadOnly).toBe(true));
  dm.open();
  const thread = await dmTabShows("thread");
  await waitFor(() =>
    expect(
      thread.querySelector(`[data-message-id="${reply.id}"]`),
    ).toBeInTheDocument(),
  );
  const top = message(h.alice, "dm-room", "A new top-level message", 25);
  h.addEvent(top);
  act(() => h.emit([top]));
  await waitFor(() => expect(dm.row()?.messageIds).toContain(top.id));
  expect(dm.row()?.threadOnly).toBeUndefined();
  // The captured thread would hide the row's current message.
  dm.open();
  await dmTabShows("whole");
});

it.each([false, true])(
  "a DM thread tab's dwell reads only up to a top-level message it never showed (returned to Activity: %s)",
  async (returned) => {
    const h = fixture();
    const root = message(h.viewer, "dm-room", "Our DM topic", 23);
    const reply = message(h.alice, "dm-room", "A DM thread reply", 24, [
      ["e", root.id, "", "reply"],
    ]);
    const dm = seedDm(h, [root, reply]);
    const dwellIn = threadLayout();
    const view = render(h.view);
    await waitFor(() => expect(dm.row()?.threadOnly).toBe(true));
    dm.open();
    await dmTabShows("thread");
    // The row's own read covers the DM through the click.
    await waitFor(() => expect(dm.row()?.unreadCount).toBe(0));
    if (returned) view.unmount();
    // Alice then replies in the thread and posts at the top level.
    const now = Math.floor(Date.now() / 1000);
    const later = message(h.alice, "dm-room", "A later thread reply", now + 5, [
      ["e", root.id, "", "reply"],
    ]);
    const top = message(
      h.alice,
      "dm-room",
      "A new top-level message",
      now + 10,
    );
    for (const event of [later, top]) h.addEvent(event);
    act(() => h.emit([later, top]));
    await waitFor(() => expect(dm.row()?.messageIds).toContain(top.id));
    // Returning to Activity restores the thread tab, which still reads.
    if (returned) render(h.view);
    const tab = await dmTabShows("thread");
    // The thread shows its new reply, but never `top`.
    await waitFor(() =>
      expect(
        tab.querySelector(`[data-message-id="${later.id}"]`),
      ).toBeInTheDocument(),
    );
    expect(
      tab.querySelector(`[data-message-id="${top.id}"]`),
    ).not.toBeInTheDocument();
    // A dwell reads the thread's new reply, but stops just before `top`.
    await dwellIn(
      within(tab).getByRole("region", { name: "Thread messages" }),
      () => expect(h.journal()?.state.frontiers["dm-room"]).toBe(now + 9),
    );
    expect(dm.row()).toMatchObject({
      messageId: top.id,
      previewMessageId: top.id,
      unreadCount: 1,
    });
    const row = rows().find((item) =>
      item.textContent?.includes("A new top-level message"),
    );
    if (!row) throw new Error("Missing DM row");
    expect(
      within(row).getByRole("img", { name: "Unread" }),
    ).toBeInTheDocument();
    // Re-clicking opens the whole DM, which shows it.
    dm.open();
    await dmTabShows("whole");
  },
);

it("a DM row opened as its thread reads only up to a top-level message it never showed", async () => {
  const h = fixture();
  const root = message(h.viewer, "dm-room", "Our DM topic", 23);
  const reply = message(h.alice, "dm-room", "A DM thread reply", 24, [
    ["e", root.id, "", "reply"],
  ]);
  const dm = seedDm(h, [root, reply]);
  render(h.view);
  const shown = () =>
    rows().find((row) => row.textContent?.includes("DM · Alice"))?.textContent;
  await waitFor(() => expect(shown()).toContain("A DM thread reply"));
  expect(dm.row()?.threadOnly).toBe(true);
  // Alice's top-level message reaches the unread owner after the row's last
  // render, and the click comes before the next one: the row still opens as
  // the thread.
  const top = message(h.alice, "dm-room", "A new top-level message", 25);
  h.addEvent(top);
  act(() => {
    h.emit([top]);
    expect(dm.row()?.messageIds).toContain(top.id);
    expect(dm.row()?.threadOnly).toBeUndefined();
    expect(shown()).toContain("A DM thread reply");
    dm.open();
  });
  await dmTabShows("thread");
  // The click reads the thread, but stops just before `top`.
  await waitFor(() => expect(h.journal()?.state.frontiers["dm-room"]).toBe(24));
  expect(dm.row()).toMatchObject({ messageId: top.id, unreadCount: 1 });
  // Re-clicking opens the whole DM, which shows it.
  dm.open();
  await dmTabShows("whole");
});

it.each([false, true])(
  "opening a conversation's tab preserves channel forced-unread intent (left channel: %s)",
  async (leftChannel) => {
    const h = fixture();
    render(h.view);
    await waitFor(() => expect(rows()).toHaveLength(2));
    await waitFor(() =>
      expect(screen.getByRole("list", { name: "Activity" })).toHaveAttribute(
        "aria-busy",
        "false",
      ),
    );
    await act(async () => {
      await h.owner.session.unread.enterChannel("room");
      await h.owner.session.unread.markMessageUnread("room", h.mention.id);
    });
    if (leftChannel) act(() => h.owner.session.unread.leaveChannel("room"));
    const force = h.journal()?.localUnread["message-force:room"];
    expect(force).toBeDefined();
    const thread = rows().find((row) =>
      row.textContent?.includes("A thread update"),
    );
    if (!thread) throw Error("Missing thread row");
    fireEvent.click(within(thread).getByRole("button", { name: /^Open / }));
    const tab = await findReader();
    await waitFor(() =>
      expect(
        tab.querySelector(`[data-message-id="${h.reply.id}"]`),
      ).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByRole("list", { name: "Activity" })).toHaveAttribute(
        "aria-busy",
        "false",
      ),
    );
    expect(h.journal()?.localUnread["message-force:room"]).toBe(force);
    if (!leftChannel)
      expect(
        h.owner.session.unread.attention("room", h.mention.id).forced,
      ).toBe(true);
  },
);

it("Undo returns the row unread even after Activity has closed", async () => {
  const h = fixture();
  const view = render(<ToastProvider>{h.view}</ToastProvider>);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  await chooseFilter("Unread only", "Attention");
  const row = rows()[0];
  if (!row) throw new Error("Missing inbox row");
  fireEvent.click(within(row).getByRole("button", { name: /^Mark as read / }));
  const undo = await screen.findByRole("button", {
    name: "Undo",
    hidden: true,
  });
  await waitFor(() => expect(rows()).toHaveLength(0));
  const unread = vi.spyOn(h.session.unread, "markUnreadLocal");
  view.rerender(<ToastProvider>{null}</ToastProvider>);
  expect(screen.queryByRole("list", { name: "Activity" })).toBeNull();
  fireEvent.click(undo);
  await waitFor(() => expect(unread).toHaveBeenCalledTimes(1));
  await act(async () => {
    await unread.mock.results[0]?.value;
  });
  expect(screen.queryByText("Couldn't mark unread")).toBeNull();
  view.rerender(<ToastProvider>{h.view}</ToastProvider>);
  await waitFor(() => expect(rows()).toHaveLength(1));
  expect(
    within(rows()[0] as HTMLElement).getByRole("img", { name: "Unread" }),
  ).toBeInTheDocument();
});

it("Undo runs while another read is still saving", async () => {
  const h = fixture();
  render(h.view, { wrapper: ToastProvider });
  await waitFor(() => expect(rows()).toHaveLength(2));
  await chooseFilter("Unread only", "Attention");
  const mention = rows().find((row) =>
    row.textContent?.includes("Please review"),
  );
  if (!mention) throw new Error("Missing mention row");
  fireEvent.click(
    within(mention).getByRole("button", { name: /^Mark as read / }),
  );
  const undo = await screen.findByRole("button", {
    name: "Undo",
    hidden: true,
  });
  await waitFor(() => expect(rows()).toHaveLength(1));
  const [thread] = rows();
  if (!thread) throw new Error("Missing thread row");
  const unread = vi.spyOn(h.session.unread, "markUnreadLocal");
  const release = h.holdSave();
  try {
    fireEvent.click(
      within(thread).getByRole("button", { name: /^Mark as read / }),
    );
    await waitFor(() => expect(h.saveStarted()).toBe(true));
    fireEvent.click(undo);
    expect(unread).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => release());
  }
  await waitFor(() =>
    expect(
      rows().some((row) => row.textContent?.includes("Please review")),
    ).toBe(true),
  );
  expect(screen.queryByText("Couldn't mark unread")).toBeNull();
});

it("a failed Undo says it couldn't mark the row unread", async () => {
  const h = fixture();
  render(h.view, { wrapper: ToastProvider });
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  await chooseFilter("Unread only", "Attention");
  const row = rows()[0];
  if (!row) throw new Error("Missing inbox row");
  fireEvent.click(within(row).getByRole("button", { name: /^Mark as read / }));
  const undo = await screen.findByRole("button", {
    name: "Undo",
    hidden: true,
  });
  vi.spyOn(h.session.unread, "markUnreadLocal").mockRejectedValue(
    Error("disk full"),
  );
  fireEvent.click(undo);
  expect(await screen.findByText("Couldn't mark unread")).toBeInTheDocument();
  expect(rows()).toHaveLength(0);
});

it("decides on Undo when the read lands, so turning Unread off first shows no toast", async () => {
  const h = fixture();
  render(h.view, { wrapper: ToastProvider });
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  await chooseFilter("Unread only", "Attention");
  const row = rows()[0];
  if (!row) throw new Error("Missing inbox row");
  const release = h.holdSave();
  try {
    fireEvent.click(
      within(row).getByRole("button", { name: /^Mark as read / }),
    );
    await waitFor(() => expect(h.saveStarted()).toBe(true));
    await chooseFilter("All", "Attention");
  } finally {
    await act(async () => release());
  }
  await waitFor(() =>
    expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBe(21),
  );
  await waitFor(() =>
    expect(within(row).queryByRole("img", { name: "Unread" })).toBeNull(),
  );
  expect(rows()).toEqual([row]);
  expect(screen.queryByText("Marked as read")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Undo", hidden: true }),
  ).not.toBeInTheDocument();
});

it("a failed Mark as read under Unread keeps focus on its own row", async () => {
  const h = fixture();
  render(h.view, { wrapper: ToastProvider });
  await waitFor(() => expect(rows()).toHaveLength(2));
  await chooseFilter("Unread only", "Attention");
  const [first, second] = rows();
  if (!first || !second) throw new Error("Missing inbox rows");
  h.failSave();
  const check = within(first).getByRole("button", { name: /^Mark as read / });
  check.focus();
  fireEvent.click(check);
  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
  expect(rows()).toEqual([first, second]);
  await waitFor(() =>
    expect([
      within(first).getByRole("button", { name: /^Open / }),
      screen.getByRole("button", { name: "Retry activity" }),
    ]).toContain(document.activeElement),
  );
  expect(document.activeElement).not.toBe(document.body);
  expect(screen.queryByText("Marked as read")).not.toBeInTheDocument();
});

it("shows All caught up only while the unread list is complete", async () => {
  const h = fixture();
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  await act(async () => {
    await h.owner.session.unread.markChannelRead("room");
  });
  const real = h.session.unread.inbox;
  const retained = new WeakMap<object, ReturnType<typeof real>>();
  let stale = false;
  vi.spyOn(h.session.unread, "inbox").mockImplementation(() => {
    const snapshot = real();
    if (!stale) return snapshot;
    const held = retained.get(snapshot) ?? {
      ...snapshot,
      freshness: "stale",
    };
    retained.set(snapshot, held);
    return held;
  });
  await chooseFilter("Unread only", "Attention");
  await screen.findByText("All caught up");
  // Retained (stale) evidence may hide unread activity: no all-clear then.
  stale = true;
  await chooseFilter("All", "Attention");
  await chooseFilter("Unread only", "Attention");
  await screen.findByText("Showing retained activity.");
  expect(screen.queryByText("All caught up")).not.toBeInTheDocument();
});

it("shows no All caught up while recent activity is still loading", async () => {
  const h = fixture();
  writeView(h.owner.session.scope, "inbox:filters", {
    activity: "all",
    sender: "everyone",
    attention: "unread",
  });
  const release = h.holdUnread();
  try {
    render(h.view);
    await screen.findByText("Checking recent activity…");
    expect(screen.queryByText("All caught up")).not.toBeInTheDocument();
  } finally {
    await act(async () => release());
  }
});

it("a failed send keeps its draft and its row", async () => {
  const h = fixture({ withWriter: true });
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  const row = rows().find((entry) =>
    entry.textContent?.includes("A thread update"),
  );
  if (!row) throw Error("Missing thread row");
  fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
  const editor = (await screen.findByRole("textbox")) as ComposerInputElement;
  vi.spyOn(h.session.messages, "reply").mockImplementation(() => {
    throw Error("Send rejected");
  });
  act(() => {
    editor.insertText("Retain failed response");
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Send rejected");
  expect(rows()).toHaveLength(2);
  expect(rows()).toContain(row);
  expect(screen.getByRole("textbox")).toBe(editor);
  expect(editor).toHaveValue("Retain failed response");
});

it("moves through the Activity type tabs with arrows, Home and End, then tabs out to From", async () => {
  const h = fixture();
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  const user = userEvent.setup();
  const list = screen.getByRole("tablist", { name: "Activity type" });
  const tab = () => within(list).getAllByRole("tab");
  const focusable = () => tab().filter((item) => item.tabIndex === 0);
  expect(focusable()).toHaveLength(1);
  expect(focusable()[0]).toHaveAttribute("aria-selected", "true");
  const [all, , , , last] = tab();
  if (!all || !last) throw new Error("Missing Activity type tabs");
  act(() => all.focus());
  await user.keyboard("{ArrowRight}");
  expect(tab()[1]).toHaveFocus();
  await user.keyboard("{ArrowLeft}");
  expect(all).toHaveFocus();
  await user.keyboard("{End}");
  expect(last).toHaveFocus();
  await user.keyboard("{Home}");
  expect(all).toHaveFocus();
  expect(focusable()).toEqual([all]);
  await user.tab();
  expect(fromTrigger()).toHaveFocus();
});

it.each([
  ["button", "saves"],
  ["menu", "saves"],
  ["button", "fails"],
  ["menu", "fails"],
] as const)(
  "a pending Mark as read via %s that %s leaves focus in the composer the user moved to",
  async (path, outcome) => {
    const h = fixture({ withWriter: true });
    render(h.view);
    await waitFor(() => expect(rows()).toHaveLength(2));
    const thread = rows().find((row) =>
      row.textContent?.includes("A thread update"),
    );
    const mention = rows().find((row) =>
      row.textContent?.includes("Please review"),
    );
    if (!thread || !mention) throw new Error("Missing fixture rows");
    fireEvent.click(within(thread).getByRole("button", { name: /^Open / }));
    const editor = await screen.findByRole("textbox");
    await waitFor(() =>
      expect(
        reader().querySelector(`[data-message-id="${h.reply.id}"]`),
      ).toHaveFocus(),
    );
    const list = screen.getByRole("list", { name: "Activity" });
    await waitFor(() => expect(list).toHaveAttribute("aria-busy", "false"));
    if (outcome === "fails") h.failSave();
    const release = h.holdSave();
    try {
      if (path === "button") {
        const check = within(mention).getByRole("button", {
          name: /^Mark as read /,
        });
        check.focus();
        fireEvent.click(check);
      } else {
        const open = within(mention).getByRole("button", { name: /^Open / });
        open.focus();
        fireEvent.contextMenu(open, { clientX: 20, clientY: 20 });
        fireEvent.click(
          await screen.findByRole("menuitem", { name: "Mark as read" }),
        );
      }
      await waitFor(() => expect(h.saveStarted()).toBe(true));
      editor.focus();
      expect(editor).toHaveFocus();
    } finally {
      await act(async () => release());
    }
    if (outcome === "fails")
      expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    await waitFor(() => expect(list).toHaveAttribute("aria-busy", "false"));
    expect(editor).toHaveFocus();
  },
);

it("shows reactions without unread actions and turns Unread off when selecting Reactions", async () => {
  const h = fixture();
  const root = h.root;
  if (!root) throw new Error("Missing fixture root");
  h.addEvent(
    signed(h.alice, {
      kind: 7,
      content: "❤️",
      created_at: 30,
      tags: [
        ["e", root.id],
        ["p", h.viewer.pubkey],
      ],
    }),
  );
  render(h.view);
  const reaction = await screen.findByRole("button", {
    name: /Alice reacted with heart to your message: Our discussion/,
  });
  expect(reaction.closest("li")).not.toHaveAttribute("data-unread");
  const row = reaction.closest("li");
  if (!row) throw new Error("Missing reaction row");
  expect(
    within(row).queryByRole("button", {
      name: /Mark as read/,
    }),
  ).not.toBeInTheDocument();
  await chooseFilter("Unread only", "Attention");
  expect(
    screen.queryByRole("button", { name: /reacted with/ }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Reactions" }));
  expect(screen.getByRole("switch", { name: "Unread" })).not.toBeChecked();
  fireEvent.click(
    await screen.findByRole("button", { name: /Alice reacted with/ }),
  );
  await findReader();
  await waitFor(() =>
    expect(
      reader().querySelector(`[data-message-id="${root.id}"]`),
    ).toBeInTheDocument(),
  );
});

it("explains an empty Reactions tab", async () => {
  const h = fixture();
  render(h.view);
  fireEvent.click(screen.getByRole("tab", { name: "Reactions" }));
  expect(await screen.findByText("No reactions yet.")).toBeInTheDocument();
  expect(
    screen.getByText(
      "When someone reacts to your messages, you’ll see it here.",
    ),
  ).toBeInTheDocument();
});

it("names all three reactors instead of saying one others", async () => {
  const h = fixture();
  if (!h.root) throw new Error("Missing fixture root");
  const reactors = [h.alice, h.agent, h.unknown];
  for (const [index, person] of reactors.entries()) {
    h.addEvent(
      profile(
        person,
        { name: ["Alice", "Bob", "Carol"][index], is_agent: index === 1 },
        29,
      ),
    );
    h.addEvent(
      signed(person, {
        kind: 7,
        content: "❤️",
        created_at: 30 + index,
        tags: [
          ["e", h.root.id],
          ["p", h.viewer.pubkey],
        ],
      }),
    );
  }
  h.addEvent(
    signed(h.alice, {
      kind: 7,
      content: "👍",
      created_at: 33,
      tags: [
        ["e", h.root.id],
        ["p", h.viewer.pubkey],
      ],
    }),
  );
  render(h.view);
  const row = await screen.findByRole("button", {
    name: /reacted with heart to your message: Our discussion/,
  });
  expect(row).toHaveTextContent(/Carol, Bob and Alice reacted/);
  expect(row).not.toHaveTextContent("1 others");
  const solo = await screen.findByRole("button", {
    name: /Alice reacted with \+1/,
  });
  fireEvent.click(solo);
  expect(solo).toHaveAttribute("aria-current", "page");
  expect(row).not.toHaveAttribute("aria-current");
  await chooseFilter("Agents", "Sender");
  expect(
    await screen.findByRole("button", { name: /Bob reacted with heart/ }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Alice reacted with/ }),
  ).not.toBeInTheDocument();
});

it.each(["solo", "dm", "thread"] as const)(
  "opens a reaction in its existing %s context and places context after the preview",
  async (kind) => {
    const h = fixture({
      soloChannel: kind === "solo",
      withDm: kind === "dm",
      withWriter: true,
    });
    const channelId = kind === "dm" ? "dm-room" : "room";
    const target = message(
      h.viewer,
      channelId,
      "My acknowledged message",
      25,
      kind === "thread" ? [["e", h.root?.id ?? "", "", "reply"]] : [],
    );
    h.addEvent(target);
    h.addEvent(
      signed(h.alice, {
        kind: 7,
        content: "❤️",
        created_at: 30,
        tags: [
          ["e", target.id],
          ["p", h.viewer.pubkey],
        ],
      }),
    );
    render(h.view);
    const row = await screen.findByRole("button", {
      name: /Alice reacted with heart/,
    });
    const context = within(row).getByText(
      kind === "dm"
        ? "in DM with Alice"
        : kind === "solo"
          ? "in Design"
          : "in #Design",
    );
    const preview = within(row).getByText("My acknowledged message");
    expect(
      preview.compareDocumentPosition(context) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(row);
    const detail = await findReader();
    const history = await within(detail).findByRole("region", {
      name: kind === "thread" ? "Thread messages" : "Channel message history",
    });
    if (kind !== "thread") {
      // jsdom has no layout, so the virtualized timeline's message visibility
      // is exercised in inbox-tabs.spec.mjs in both real browser engines.
      expect(history).toHaveAttribute("data-channel-timeline", channelId);
      expect(
        within(detail).queryByRole("region", { name: "Thread messages" }),
      ).not.toBeInTheDocument();
      await waitFor(() => expect(h.historyRequests).toContain(channelId));
    } else {
      await waitFor(() =>
        expect(
          history.querySelector(`[data-message-id="${target.id}"]`),
        ).toBeInTheDocument(),
      );
      expect(
        history.querySelector(`[data-message-id="${h.root?.id}"]`),
      ).toBeInTheDocument();
    }
  },
);

it("mixes hover reactions by time, preserves unread filtering, and opens the exact target", async () => {
  const h = fixture();
  const target = message(h.viewer, "room", "Acknowledged reply", 24, [
    ["e", h.root?.id ?? "", "", "reply"],
  ]);
  h.addEvent(target);
  h.addEvent(
    signed(h.alice, {
      kind: 7,
      content: "❤️",
      created_at: 30,
      tags: [
        ["e", target.id],
        ["p", h.viewer.pubkey],
      ],
    }),
  );
  const close = vi.fn();
  render(previewAt(h, close));
  const reaction = await screen.findByRole("button", {
    name: /Alice reacted with heart/,
  });
  await waitFor(() => expect(previewRows()).toHaveLength(3));
  expect(previewRows()[0]).toContainElement(reaction);
  fireEvent.click(screen.getByRole("switch", { name: "Unread only" }));
  expect(
    screen.queryByRole("button", { name: /reacted with/ }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("switch", { name: "Unread only" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /Alice reacted with heart/ }),
  );
  expect(close).toHaveBeenCalledOnce();
  expect(h.open).toHaveBeenLastCalledWith({
    version: 1,
    kind: "conversation",
    scope: h.scope,
    channelId: "room",
    messageId: target.id,
    threadRootId: h.root?.id,
  });
});

it("bounds mixed hover activity to 50 rows after sorting", async () => {
  const h = fixture();
  for (let index = 0; index < 50; index++) {
    const target = message(
      h.viewer,
      "room",
      `Acknowledged ${index}`,
      100 + index,
    );
    h.addEvent(target);
    h.addEvent(
      signed(h.alice, {
        kind: 7,
        content: "❤️",
        created_at: 200 + index,
        tags: [
          ["e", target.id],
          ["p", h.viewer.pubkey],
        ],
      }),
    );
  }
  render(previewAt(h));
  await screen.findByRole("button", {
    name: /Alice reacted with heart to your message: Acknowledged 49$/,
  });
  expect(previewRows()).toHaveLength(50);
  expect(previewRows()[0]).toHaveTextContent("Acknowledged 49");
  expect(previewRows()[49]).toHaveTextContent("Acknowledged 0");
});

it("retries failed reaction settlement from the hover card", async () => {
  const h = fixture();
  h.addEvent(
    signed(h.alice, {
      kind: 7,
      content: "❤️",
      created_at: 30,
      tags: [
        ["e", h.root?.id ?? ""],
        ["p", h.viewer.pubkey],
      ],
    }),
  );
  h.failAux();
  render(previewAt(h));
  await screen.findByRole("alert");
  expect(
    screen.queryByRole("button", { name: /reacted with/ }),
  ).not.toBeInTheDocument();
  h.failAux(false);
  fireEvent.click(screen.getByRole("button", { name: "Retry activity" }));
  await screen.findByRole("button", { name: /Alice reacted with heart/ });
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
});

it("moves solo emoji into a shared row and back after a live removal", async () => {
  const h = fixture();
  const root = h.root;
  if (!root) throw new Error("Missing root");
  const reaction = (person: typeof h.alice, content: string, at: number) =>
    signed(person, {
      kind: 7,
      content,
      created_at: at,
      tags: [
        ["e", root.id],
        ["p", h.viewer.pubkey],
      ],
    });
  h.addEvent(reaction(h.alice, "❤️", 30));
  h.addEvent(reaction(h.alice, "👍", 31));
  render(h.view);
  const label = /Alice reacted with heart, \+1/;
  expect(
    await screen.findByRole("button", { name: label }),
  ).toBeInTheDocument();
  const shared = reaction(h.agent, "❤️", 32);
  h.addEvent(shared);
  act(() => h.emit([shared]));
  await waitFor(() =>
    expect(
      screen.getAllByRole("button", { name: /reacted with/ }),
    ).toHaveLength(2),
  );
  const deletion = signed(h.agent, {
    kind: 5,
    content: "",
    created_at: 33,
    tags: [["e", shared.id]],
  });
  h.addEvent(deletion);
  act(() => h.emit([deletion]));
  expect(
    await screen.findByRole("button", { name: label }),
  ).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: /reacted with/ })).toHaveLength(
    1,
  );
});
