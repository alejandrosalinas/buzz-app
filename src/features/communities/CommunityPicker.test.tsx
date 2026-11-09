// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SettingsCardsService } from "../settings/service";
import type { RelayData, RelaySnapshot } from "../relay/service";
import type { UnreadCapability } from "../relay/unread";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { CommunityPicker } from "./CommunityPicker";
import { CommunityAddress } from "../../app/CommunityAddress";
import { MEMBERSHIP_SECTION } from "./CommunityPickerItem";
import type { PurgeFailure } from "./device-state";
import { MEMBERSHIP_KIND, type Role } from "./roster";
import {
  createCommunities,
  type Communities,
  type ClientSnapshot,
} from "./service";

const render = (ui: ReactElement) => {
  const result = rtlRender(ui, { wrapper: ToastProvider });
  if (!screen.queryByRole("dialog")) openSwitcher();
  return result;
};
const switcher = () =>
  screen.getByRole("button", { name: /^Community switcher:/ });
function openSwitcher() {
  if (switcher().getAttribute("aria-expanded") !== "true")
    fireEvent.click(switcher());
}
const settingsCards = {
  subscribe: () => () => {},
  has: () => true,
};
const viewer = "a".repeat(64);
const relayKey = "f".repeat(64);
const primary = "https://primary.example";
const secondary = "https://secondary.example";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const accepted = () =>
  Response.json({ accepted: true, event_id: "1".repeat(64), message: "" });

/** A picker over two saved communities; only the selected one has a session. */
function harness({
  selected = primary,
  role = "owner" as Role,
  status = "ready" as RelaySnapshot["status"],
  capability = "frontier-sync" as UnreadCapability["sync"] extends () => {
    capability: infer C;
  }
    ? C
    : never,
  /** What the community's relay answers to the broker leave route. */
  leaveResponse = accepted as () => Response | Promise<Response>,
  /** Stores the service could not clear after forgetting the community. */
  leaveResidue = [] as PurgeFailure[],
  /** The service's own failure to save the device record, before it changes. */
  leaveError = undefined as Error | undefined,
  /** The relay signing key the session contract carries; null while offline. */
  relayAuthor = relayKey as string | null,
} = {}) {
  let snapshot: ClientSnapshot = {
    status: "ready",
    relayAvailable: true,
    profile: { name: "", picture: "" },
    sync: { known: [], outbox: [] },
    viewer,
    selected,
    memberships: [
      { id: primary, name: "Primary" },
      { id: secondary, name: "Secondary" },
    ],
  };
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const select = vi.fn((id: string | null) => {
    snapshot = { ...snapshot, selected: id };
    notify();
  });
  // Mirrors the service: the membership goes, and a left selection lands on
  // Personal space without the picker selecting anything. Only the save can
  // throw, and it does so before anything changes. The purge option is
  // recorded for the assertions on which outcomes clear device state.
  const leave = vi.fn(async (id: string) => {
    if (leaveError) throw leaveError;
    snapshot = {
      ...snapshot,
      memberships: snapshot.memberships.filter((m) => m.id !== id),
      selected: snapshot.selected === id ? null : snapshot.selected,
    };
    notify();
    return leaveResidue;
  });
  const read = vi.fn(async () => [
    {
      id: "e".repeat(64),
      kind: MEMBERSHIP_KIND,
      pubkey: relayKey,
      created_at: 1,
      content: "",
      sig: "",
      tags: [["-"], ["member", viewer, role]],
    },
  ]);
  const markAllChannelsRead = vi.fn(async () => []);
  const session = {
    relayAuthor: relayAuthor ?? undefined,
    read,
    unread: {
      sync: () => ({ capability }),
      subscribeSync: () => () => {},
      markAllChannelsRead,
    },
  };
  const connection = {
    status,
    generation: 1,
    scope: `${selected}:${viewer}`,
    viewer,
    session,
  } as unknown as RelaySnapshot;
  const relay = {
    snapshot: () => connection,
    subscribe: () => () => {},
  } as unknown as RelayData;
  const communities = {
    retainPresentation: () => () => {},
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    select,
    leave,
    relay,
  } as unknown as Communities;
  // The broker's session contract is deliberately unanswered: the picker holds
  // the session already and must not ask for it again.
  const fetch = vi.fn(async (url: string) => {
    const path = String(url);
    if (path === "/api/relay/register") return Response.json({});
    if (path.endsWith("/leave")) return leaveResponse();
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  const onOpenTarget = vi.fn();
  // The host's selection path: selects through the service, then navigates.
  const onSelect = vi.fn((id: string | null) => select(id));
  return {
    communities,
    select,
    leave,
    read,
    fetch,
    markAllChannelsRead,
    onOpenTarget,
    onSelect,
    leaveRequests: () =>
      fetch.mock.calls
        .map(([url]) => String(url))
        .filter((url) => url.endsWith("/leave")),
    update(change: Partial<ClientSnapshot>) {
      act(() => {
        snapshot = { ...snapshot, ...change };
        notify();
      });
    },
  };
}

const button = (name: string) => {
  openSwitcher();
  return screen.getByRole("button", { name: `Switch to ${name}` });
};
async function openMenu(name: string) {
  fireEvent.contextMenu(button(name), { clientX: 20, clientY: 20 });
  return await screen.findByRole("menu", { name: `Actions for ${name}` });
}
const items = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("menuitem")
    .map((item) => item.textContent);
/** Session contract requests to the broker. The picker verifies the roster
 * against the relay authority its session already holds, so it makes none;
 * icon discovery is separate. */
const sessionRequests = (fetch: ReturnType<typeof vi.fn>) =>
  fetch.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.endsWith("/session"));

it("switches using the shared membership owner without acquiring other sessions on render", () => {
  const h = harness();
  render(<CommunityPicker communities={h.communities} />);
  expect(h.select).not.toHaveBeenCalled();
  expect(
    screen.getByRole("navigation", { name: "Communities" }),
  ).toBeInTheDocument();
  expect(button("Primary")).toHaveAttribute("aria-current", "true");
  fireEvent.click(button("Secondary"));
  expect(h.select).toHaveBeenCalledWith(secondary);
  expect(button("Secondary")).toHaveAttribute("aria-current", "true");
  fireEvent.click(screen.getByRole("button", { name: "Personal space" }));
  expect(h.select).toHaveBeenCalledWith(null);
  openSwitcher();
  expect(
    screen.getByRole("button", { name: "Personal space" }),
  ).toHaveAttribute("aria-current", "true");
  const add = screen.getByRole("button", { name: "Join a community" });
  fireEvent.click(add);
  expect(
    screen.getByRole("heading", { name: "Join a community" }),
  ).toBeInTheDocument();
  expect(h.select).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(button("Primary")).toBeInTheDocument();

  h.update({ memberships: [{ id: secondary, name: "Secondary" }] });
  expect(
    screen.queryByRole("button", { name: "Switch to Primary" }),
  ).not.toBeInTheDocument();
  // Without host navigation there is no Settings to open, so no roster was read
  // for a picker that only switches communities.
  expect(h.read).not.toHaveBeenCalled();
  expect(sessionRequests(h.fetch)).toEqual([]);
});

it("offers the original's actions on the selected community and only reads its roster", async () => {
  const h = harness();
  render(
    <CommunityPicker
      communities={h.communities}
      onOpenTarget={h.onOpenTarget}
      settingsCards={settingsCards}
    />,
  );
  const menu = await openMenu("Primary");
  await within(menu).findByRole("menuitem", { name: "Invite to community" });
  expect(items(menu)).toEqual([
    "Mark all as read",
    "Copy community URL",
    "Invite to community",
    "Leave community",
  ]);
  expect(within(menu).getAllByRole("separator")).toHaveLength(2);
  expect(
    within(menu).getByRole("menuitem", { name: "Mark all as read" }),
  ).not.toHaveAttribute("aria-disabled");
  // Role comes from the relay-signed roster, exactly as the Membership card
  // reads it, verified against the authority the session already carries: the
  // read adds no session contract request to the connection.
  expect(h.read).toHaveBeenCalledWith(
    [{ kinds: [MEMBERSHIP_KIND], authors: [relayKey], limit: 1 }],
    expect.objectContaining({ fresh: true }),
  );
  expect(sessionRequests(h.fetch)).toEqual([]);
  expect(h.select).not.toHaveBeenCalled();
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  // An inactive community exposes the same menu without a session behind it.
  const reads = h.read.mock.calls.length;
  const inactive = await openMenu("Secondary");
  expect(items(inactive)).toEqual([
    "Mark all as read",
    "Copy community URL",
    "Leave community",
  ]);
  expect(within(inactive).getAllByRole("separator")).toHaveLength(2);
  const markAll = within(inactive).getByRole("menuitem", {
    name: "Mark all as read",
  });
  expect(markAll).toHaveAttribute("aria-disabled", "true");
  expect(markAll).toHaveAccessibleDescription(
    "Only the selected community can be marked as read.",
  );
  fireEvent.click(markAll);
  expect(h.markAllChannelsRead).not.toHaveBeenCalled();
  expect(h.read).toHaveBeenCalledTimes(reads);
  expect(sessionRequests(h.fetch)).toEqual([]);
  expect(h.select).not.toHaveBeenCalled();
});

it("offers no Invite and reads nothing while the session carries no relay authority", async () => {
  const h = harness({ relayAuthor: null });
  render(
    <CommunityPicker
      communities={h.communities}
      onOpenTarget={h.onOpenTarget}
      settingsCards={settingsCards}
    />,
  );
  const menu = await openMenu("Primary");
  await act(async () => {});
  expect(items(menu)).toEqual([
    "Mark all as read",
    "Copy community URL",
    "Leave community",
  ]);
  // Without the session's authority there is nothing to verify a roster
  // against, and the broker is not asked to supply one.
  expect(h.read).not.toHaveBeenCalled();
  expect(sessionRequests(h.fetch)).toEqual([]);
});

it.each(["ContextMenu", "F10"])(
  "opens from the keyboard with %s and returns focus to the community",
  async (key) => {
    const h = harness();
    render(
      <CommunityPicker
        communities={h.communities}
        onOpenTarget={h.onOpenTarget}
        settingsCards={settingsCards}
      />,
    );
    const target = button("Secondary");
    target.focus();
    fireEvent.keyDown(target, { key, shiftKey: key === "F10" });
    const menu = await screen.findByRole("menu", {
      name: "Actions for Secondary",
    });
    expect(h.select).not.toHaveBeenCalled();
    // Anchored beside the picker item, not at a cursor point.
    expect(menu).toHaveAttribute("data-side", "right");
    await waitFor(() =>
      expect(menu.contains(document.activeElement)).toBe(true),
    );
    fireEvent.keyDown(document.activeElement ?? menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(target));
  },
);

it("keeps the keyboard anchor when a synthesised contextmenu event re-enters the open", async () => {
  const h = harness();
  render(
    <CommunityPicker
      communities={h.communities}
      onOpenTarget={h.onOpenTarget}
      settingsCards={settingsCards}
    />,
  );
  await waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
  const target = button("Primary");
  target.focus();
  fireEvent.keyDown(target, { key: "F10", shiftKey: true });
  const menu = await screen.findByRole("menu", { name: "Actions for Primary" });
  await waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
  expect(menu).toHaveAttribute("data-side", "right");
  // Chromium and Firefox synthesise a contextmenu event for Shift+F10 unless the
  // keydown is cancelled; Base UI turns it into a second open request. The
  // menu is already open by then, so that request neither moves the anchor
  // to the synthesised pointer coordinates nor reads the roster a second time.
  fireEvent.contextMenu(target, { clientX: 20, clientY: 20 });
  await act(async () => {});
  expect(menu).toHaveAttribute("data-side", "right");
  expect(h.read).toHaveBeenCalledTimes(2);
  // A read scheduled by the re-entrant request would land after this flush.
  await act(async () => {});
  expect(h.read).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(document.activeElement ?? menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(target));
});

it("re-reads the roster for a keyboard open exactly as for a pointer open", async () => {
  const h = harness();
  render(
    <CommunityPicker
      communities={h.communities}
      onOpenTarget={h.onOpenTarget}
      settingsCards={settingsCards}
    />,
  );
  // The selected community's roster is read once on mount.
  await waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
  const target = button("Primary");
  target.focus();
  fireEvent.keyDown(target, { key: "F10", shiftKey: true });
  const menu = await screen.findByRole("menu", { name: "Actions for Primary" });
  await waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
  await within(menu).findByRole("menuitem", { name: "Invite to community" });
  fireEvent.keyDown(document.activeElement ?? menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await openMenu("Primary");
  await waitFor(() => expect(h.read).toHaveBeenCalledTimes(3));
});

it("returns focus after a pointer open to the field the right-click interrupted, not to the picker", async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const h = harness();
  const ui = (composer: boolean) => (
    <>
      {composer && <input aria-label="Composer" />}
      <CommunityPicker communities={h.communities} />
    </>
  );
  const { rerender } = render(ui(true));
  const composer = screen.getByRole("textbox", { name: "Composer" });
  const target = button("Primary");
  // Browsers focus the picker button on the right-click's mousedown, before the
  // contextmenu event opens the menu; jsdom only moves focus when asked to.
  const rightClick = () => {
    fireEvent.pointerDown(target, { button: 2 });
    target.focus();
    return openMenu("Primary");
  };
  composer.focus();
  const menu = await rightClick();
  expect(menu).toHaveAttribute("data-side", "bottom");
  await waitFor(() => expect(menu).toHaveFocus());
  await user.click(
    within(menu).getByRole("menuitem", { name: "Copy community URL" }),
  );
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  // Right-clicking a community while typing must not leave the caret on the
  // picker, where the click itself put focus.
  await waitFor(() => expect(composer).toHaveFocus());
  expect(target).not.toHaveFocus();

  // A field gone by the time the menu closes cannot take focus back; Base UI's
  // default then lands on the picker button the right-click focused.
  composer.focus();
  const reopened = await rightClick();
  await waitFor(() =>
    expect(reopened.contains(document.activeElement)).toBe(true),
  );
  rerender(ui(false));
  expect(screen.queryByRole("textbox", { name: "Composer" })).toBeNull();
  fireEvent.keyDown(document.activeElement ?? reopened, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(target).toHaveFocus());
});

it("copies the canonical community origin and reports the outcome", async () => {
  const user = userEvent.setup();
  const write = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error("denied"));
  const h = harness({ selected: secondary });
  render(<CommunityPicker communities={h.communities} />);
  let menu = await openMenu("Primary");
  await user.click(
    within(menu).getByRole("menuitem", { name: "Copy community URL" }),
  );
  expect(write).toHaveBeenCalledWith(primary);
  const copied = await screen.findByText("Community URL copied.");
  expect(copied.closest(".buzz-toast")).not.toBeNull();
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  menu = await openMenu("Primary");
  await user.click(
    within(menu).getByRole("menuitem", { name: "Copy community URL" }),
  );
  await screen.findByText("Couldn’t copy the community URL.");
  expect(write).toHaveBeenCalledTimes(2);
  // Copying an inactive community's URL never acquired its session.
  expect(h.read).not.toHaveBeenCalled();
  expect(h.select).not.toHaveBeenCalled();
});

it("marks every channel read through the selected session and reports failures", async () => {
  const user = userEvent.setup();
  const h = harness();
  h.markAllChannelsRead
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error("disk full"));
  render(<CommunityPicker communities={h.communities} />);
  let menu = await openMenu("Primary");
  await user.click(
    within(menu).getByRole("menuitem", { name: "Mark all as read" }),
  );
  expect(h.markAllChannelsRead).toHaveBeenCalledTimes(1);
  await screen.findByText("Marked all as read.");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  menu = await openMenu("Primary");
  await user.click(
    within(menu).getByRole("menuitem", { name: "Mark all as read" }),
  );
  await screen.findByText("Couldn’t mark everything as read.");
  expect(h.select).not.toHaveBeenCalled();
});

it.each([
  {
    name: "the connection is not ready",
    options: { status: "connecting" as const },
    note: "Waiting for Primary to connect.",
  },
  {
    name: "read state cannot sync",
    options: { capability: "unsupported" as const },
    note: "Read state can’t sync on this connection.",
  },
])("disables Mark all as read while $name", async ({ options, note }) => {
  const h = harness(options);
  render(<CommunityPicker communities={h.communities} />);
  const menu = await openMenu("Primary");
  const markAll = within(menu).getByRole("menuitem", {
    name: "Mark all as read",
  });
  expect(markAll).toHaveAttribute("aria-disabled", "true");
  expect(markAll).toHaveAccessibleDescription(note);
  fireEvent.click(markAll);
  expect(h.markAllChannelsRead).not.toHaveBeenCalled();
});

it("opens Invites scoped to the community, with no duplicate Settings entry", async () => {
  const user = userEvent.setup();
  const h = harness();
  render(
    <CommunityPicker
      communities={h.communities}
      onOpenTarget={h.onOpenTarget}
      settingsCards={settingsCards}
    />,
  );
  let menu = await openMenu("Primary");
  await user.click(
    await within(menu).findByRole("menuitem", { name: "Invite to community" }),
  );
  expect(h.onOpenTarget).toHaveBeenLastCalledWith({
    version: 1,
    kind: "settings",
    section: MEMBERSHIP_SECTION,
    scope: { viewer, communityOrigin: primary },
  });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  menu = await openMenu("Secondary");
  expect(
    within(menu).queryByRole("menuitem", { name: "Community settings" }),
  ).toBeNull();
  expect(h.onOpenTarget).toHaveBeenCalledTimes(1);
  expect(h.select).not.toHaveBeenCalled();
});

it.each([
  { role: "admin" as const, invites: true },
  { role: "member" as const, invites: false },
])(
  "shows Invite to community for a $role: $invites",
  async ({ role, invites }) => {
    const h = harness({ role });
    render(
      <CommunityPicker
        communities={h.communities}
        onOpenTarget={h.onOpenTarget}
        settingsCards={settingsCards}
      />,
    );
    await waitFor(() => expect(h.read).toHaveBeenCalled());
    const menu = await openMenu("Primary");
    if (invites)
      await within(menu).findByRole("menuitem", {
        name: "Invite to community",
      });
    else {
      await within(menu).findByRole("menuitem", { name: "Leave community" });
      expect(
        within(menu).queryByRole("menuitem", { name: "Invite to community" }),
      ).toBeNull();
    }
  },
);

/** Opens the community's menu, picks Leave and waits for the confirmation. */
async function askToLeave(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  const menu = await openMenu(name);
  expect(items(menu).at(-1)).toBe("Leave community");
  await user.click(
    within(menu).getByRole("menuitem", { name: "Leave community" }),
  );
  const dialog = await screen.findByRole("alertdialog", {
    name: `Leave ${name}?`,
  });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  return dialog;
}
const confirmLeave = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", { name: "Leave community" });

it("leaves an inactive community after confirming: the relay releases it before the device forgets it", async () => {
  const user = userEvent.setup();
  const h = harness();
  render(<CommunityPicker communities={h.communities} />);
  const dialog = await askToLeave(user, "Secondary");
  expect(dialog).toHaveTextContent(
    "removes Secondary from this device along with its saved drafts and reading positions",
  );
  // Nothing is sent until the viewer confirms.
  expect(h.leaveRequests()).toEqual([]);
  expect(h.leave).not.toHaveBeenCalled();
  await user.click(confirmLeave(dialog));
  await screen.findByText("Left Secondary — https://secondary.example.");
  const route = `/api/relay/${encodeURIComponent(secondary)}/leave`;
  expect(h.leaveRequests()).toEqual([route]);
  expect(h.fetch).toHaveBeenCalledWith(
    route,
    expect.objectContaining({ method: "POST", body: "{}" }),
  );
  // The relay released the membership, so the device state goes with it.
  expect(h.leave).toHaveBeenCalledWith(secondary, { purge: true });
  const published =
    h.fetch.mock.invocationCallOrder[
      h.fetch.mock.calls.findIndex(([url]) => String(url) === route)
    ] ?? Infinity;
  expect(h.leave.mock.invocationCallOrder[0]).toBeGreaterThan(published);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(
    screen.queryByRole("button", { name: "Switch to Secondary" }),
  ).toBeNull();
  // The request went to the relay by origin; the community was never acquired
  // and the selection was never touched.
  expect(sessionRequests(h.fetch)).toEqual([]);
  expect(h.read).not.toHaveBeenCalled();
  expect(h.select).not.toHaveBeenCalled();
  expect(h.onSelect).not.toHaveBeenCalled();
  await waitFor(() => expect(switcher()).toHaveFocus());
  expect(switcher()).toHaveAccessibleName("Community switcher: Primary");
  expect(button("Primary")).toHaveAttribute("aria-current", "true");
});

it("leaving the selected community tells the host to select Personal space; an inactive one does not", async () => {
  const user = userEvent.setup();
  const h = harness();
  render(<CommunityPicker communities={h.communities} onSelect={h.onSelect} />);
  let dialog = await askToLeave(user, "Primary");
  await user.click(confirmLeave(dialog));
  await screen.findByText("Left Primary — https://primary.example.");
  // The service owns the store state; the host adds the navigation and ingress
  // recovery that clicking Personal space would, so a Settings card scoped to
  // the gone community is not left open.
  expect(h.leave).toHaveBeenCalledWith(primary, { purge: true });
  expect(h.onSelect).toHaveBeenCalledTimes(1);
  expect(h.onSelect).toHaveBeenCalledWith(null);
  expect(h.leave.mock.invocationCallOrder[0]).toBeLessThan(
    h.onSelect.mock.invocationCallOrder[0] ?? 0,
  );
  await waitFor(() => expect(switcher()).toHaveFocus());
  expect(switcher()).toHaveAccessibleName("Community switcher: Personal space");

  h.update({ selected: secondary });
  dialog = await askToLeave(user, "Secondary");
  await user.click(confirmLeave(dialog));
  await screen.findByText("Left Secondary — https://secondary.example.");
  expect(h.onSelect).toHaveBeenCalledTimes(2);
  expect(h.onSelect).toHaveBeenLastCalledWith(null);

  // Leaving a community that is not selected changes nothing about selection.
  h.update({
    memberships: [
      { id: primary, name: "Primary" },
      { id: secondary, name: "Secondary" },
    ],
    selected: primary,
  });
  dialog = await askToLeave(user, "Secondary");
  await user.click(confirmLeave(dialog));
  // The earlier "Left Secondary — https://secondary.example." toast is still showing, so wait on the
  // leave itself rather than on a second copy of the same text.
  await waitFor(() => expect(h.leave).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(
    await screen.findAllByText("Left Secondary — https://secondary.example."),
  ).toHaveLength(2);
  expect(h.onSelect).toHaveBeenCalledTimes(2);
  expect(button("Primary")).toHaveAttribute("aria-current", "true");
  await waitFor(() => expect(switcher()).toHaveFocus());
});

it("cancelling the confirmation keeps the membership and returns focus to the community", async () => {
  const user = userEvent.setup();
  const h = harness();
  render(<CommunityPicker communities={h.communities} />);
  let dialog = await askToLeave(user, "Secondary");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(switcher()).toHaveFocus());
  // Escape cancels the same way.
  dialog = await askToLeave(user, "Secondary");
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(h.leaveRequests()).toEqual([]);
  expect(h.leave).not.toHaveBeenCalled();
  expect(button("Secondary")).toBeInTheDocument();
  expect(sessionRequests(h.fetch)).toEqual([]);
  expect(h.select).not.toHaveBeenCalled();
});

it("reports the relay owner's refusal without offering device removal", async () => {
  const user = userEvent.setup();
  const h = harness({
    leaveResponse: () =>
      Response.json(
        { error: "invalid: relay owner cannot leave" },
        { status: 400 },
      ),
  });
  render(<CommunityPicker communities={h.communities} />);
  const dialog = await askToLeave(user, "Secondary");
  await user.click(confirmLeave(dialog));
  await screen.findByText(
    "The relay owner can’t leave Secondary — https://secondary.example.",
  );
  expect(h.leave).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(button("Secondary")).toBeInTheDocument();
  await waitFor(() => expect(switcher()).toHaveFocus());
});

/** Leaves through a relay that never settles the request and waits for the
 * dialog to offer device removal instead. */
async function failLeave(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.click(confirmLeave(await askToLeave(user, name)));
  return await screen.findByRole("alertdialog", {
    name: `Couldn’t leave ${name}`,
  });
}
const confirmRemove = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", { name: "Remove from this device" });

it.each([
  {
    name: "the domain no longer resolves",
    response: () => Promise.reject(new TypeError("Failed to fetch")),
  },
  {
    name: "the relay is unreachable",
    response: () => Response.json({ error: "upstream" }, { status: 503 }),
  },
  {
    name: "the relay rejects the request for an unknown reason",
    response: () =>
      Response.json(
        { error: "invalid: database error: secret" },
        { status: 400 },
      ),
  },
  {
    name: "the request times out",
    response: () =>
      Promise.reject(new DOMException("timed out", "TimeoutError")),
  },
])(
  "offers device removal when $name, and Cancel keeps the membership",
  async ({ response }) => {
    const user = userEvent.setup();
    const h = harness({ leaveResponse: response });
    render(<CommunityPicker communities={h.communities} />);
    const dialog = await failLeave(user, "Secondary");
    expect(dialog).toHaveTextContent(
      "Its relay didn’t confirm the leave, so you may still be a member.",
    );
    expect(dialog).toHaveTextContent("This doesn’t change your membership.");
    // The confirm button held focus through the leave; a repeated Enter must
    // not remove the community without a fresh choice.
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toHaveFocus());
    expect(screen.queryByText(/Check your connection/)).toBeNull();
    expect(h.leaveRequests()).toHaveLength(1);
    expect(h.leave).not.toHaveBeenCalled();
    await user.click(cancel);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(h.leave).not.toHaveBeenCalled();
    expect(button("Secondary")).toBeInTheDocument();
    await waitFor(() => expect(switcher()).toHaveFocus());
    // The item is back to its resting label for a retry.
    const menu = await openMenu("Secondary");
    const item = within(menu).getByRole("menuitem", {
      name: "Leave community",
    });
    expect(item).not.toHaveAttribute("aria-disabled");
    expect(sessionRequests(h.fetch)).toEqual([]);
  },
);

it("removes a community whose relay cannot be reached from this device without contacting it again", async () => {
  const user = userEvent.setup();
  const h = harness({
    leaveResponse: () => Promise.reject(new TypeError("Failed to fetch")),
  });
  render(<CommunityPicker communities={h.communities} onSelect={h.onSelect} />);
  const dialog = await failLeave(user, "Secondary");
  await user.click(confirmRemove(dialog));
  const notice = await screen.findByText(
    "Secondary — https://secondary.example was removed from this device. Its relay didn’t confirm the leave, so you may still be a member.",
  );
  expect(notice.closest(".buzz-toast")).toHaveAttribute("data-type", "success");
  // Only the failed leave reached for the relay.
  expect(h.leaveRequests()).toHaveLength(1);
  expect(h.leave).toHaveBeenCalledExactlyOnceWith(secondary, { purge: true });
  expect(h.onSelect).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(
    screen.queryByRole("button", { name: "Switch to Secondary" }),
  ).toBeNull();
  expect(sessionRequests(h.fetch)).toEqual([]);
  await waitFor(() => expect(switcher()).toHaveFocus());
});

it("keeps the membership uncertain when the relay may have applied a leave whose answer was lost", async () => {
  const user = userEvent.setup();
  // The request reached the relay, which may have applied it; only its answer
  // was lost to the timeout.
  const h = harness({
    leaveResponse: () =>
      Promise.reject(new DOMException("timed out", "TimeoutError")),
    leaveResidue: [{ store: "outbox", error: new Error("blocked") }],
  });
  render(<CommunityPicker communities={h.communities} />);
  await user.click(confirmRemove(await failLeave(user, "Secondary")));
  await screen.findByText(
    "Secondary — https://secondary.example was removed from this device. Its relay didn’t confirm the leave, so you may still be a member. Some saved data couldn’t be cleared.",
  );
  expect(h.leaveRequests()).toHaveLength(1);
  expect(screen.queryByText(/membership wasn’t changed/)).toBeNull();
});

it("removing the selected community from this device tells the host to select Personal space", async () => {
  const user = userEvent.setup();
  const h = harness({
    leaveResponse: () => Promise.reject(new TypeError("Failed to fetch")),
  });
  render(<CommunityPicker communities={h.communities} onSelect={h.onSelect} />);
  await user.click(confirmRemove(await failLeave(user, "Primary")));
  await screen.findByText(
    "Primary — https://primary.example was removed from this device. Its relay didn’t confirm the leave, so you may still be a member.",
  );
  expect(h.leave).toHaveBeenCalledWith(primary, { purge: true });
  expect(h.onSelect).toHaveBeenCalledExactlyOnceWith(null);
  await waitFor(() => expect(switcher()).toHaveFocus());
  expect(switcher()).toHaveAccessibleName("Community switcher: Personal space");
});

it("keeps the community when this device cannot save its removal", async () => {
  const user = userEvent.setup();
  const h = harness({
    leaveResponse: () => Promise.reject(new TypeError("Failed to fetch")),
    leaveError: new Error(
      "Could not save this community on this device. Try again.",
      { cause: new Error("Setting the value exceeded the quota.") },
    ),
  });
  render(<CommunityPicker communities={h.communities} onSelect={h.onSelect} />);
  await user.click(confirmRemove(await failLeave(user, "Secondary")));
  const notice = await screen.findByText(
    "Couldn’t remove Secondary — https://secondary.example from this device (Setting the value exceeded the quota). Try again.",
  );
  expect(notice.closest(".buzz-toast")).toHaveAttribute("data-type", "error");
  expect(h.onSelect).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(button("Secondary")).toBeInTheDocument();
  await waitFor(() => expect(switcher()).toHaveFocus());
});

const absent =
  "You were no longer a member of Secondary — https://secondary.example, so it was removed from this device.";
it.each([
  // The relay holds no membership, so nothing keyed to it is worth keeping.
  { error: "invalid: you are not a relay member", toast: absent, purge: true },
  {
    error: "invalid: relay membership is not enabled",
    toast: absent,
    purge: true,
  },
  {
    // The relay refuses a banned identity before any leave handler runs, so a
    // retry can do nothing while the ban lasts. Bans can be timed or lifted
    // and the relay keeps the membership meanwhile, so the device forgets the
    // community without purging the drafts and reading positions it would
    // reuse after a re-add, and the notice promises nothing permanent.
    error: "blocked: you are banned from this community",
    toast:
      "You’re currently banned from Secondary — https://secondary.example, so the leave was refused. It was removed from this device and can be added again by its URL if access is restored.",
    purge: false,
  },
])(
  "forgets a community whose relay answers $error and says so (purge: $purge)",
  async ({ error, toast, purge }) => {
    const user = userEvent.setup();
    const h = harness({
      leaveResponse: () => Response.json({ error }, { status: 400 }),
    });
    render(<CommunityPicker communities={h.communities} />);
    const dialog = await askToLeave(user, "Secondary");
    await user.click(confirmLeave(dialog));
    const notice = await screen.findByText(toast);
    expect(notice.closest(".buzz-toast")).not.toBeNull();
    expect(notice.closest(".buzz-toast")).toHaveAttribute("data-type", "info");
    expect(h.leave).toHaveBeenCalledTimes(1);
    expect(h.leave).toHaveBeenCalledWith(secondary, { purge });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Switch to Secondary" }),
      ).toBeNull(),
    );
    expect(sessionRequests(h.fetch)).toEqual([]);
  },
);

it("reports a device that could not finish forgetting a left community without blaming the connection, naming the storage error", async () => {
  const user = userEvent.setup();
  const h = harness({
    // The service's wrapped save failure, with the storage error as its cause.
    leaveError: new Error(
      "Could not save this community on this device. Try again.",
      { cause: new Error("Setting the value exceeded the quota.") },
    ),
  });
  render(<CommunityPicker communities={h.communities} onSelect={h.onSelect} />);
  const dialog = await askToLeave(user, "Secondary");
  await user.click(confirmLeave(dialog));
  // A store that never saves would otherwise show the identical promise on
  // every attempt; the storage error's own words tell the viewer why.
  const notice = await screen.findByText(
    "Left Secondary — https://secondary.example, but this device couldn’t finish cleaning up (Setting the value exceeded the quota). Leave it again to finish.",
  );
  expect(notice.closest(".buzz-toast")).toHaveAttribute("data-type", "error");
  expect(
    screen.queryByText(
      "Couldn’t leave Secondary — https://secondary.example. Check your connection and try again.",
    ),
  ).toBeNull();
  // The relay released the membership; only the device record failed, so the
  // community stays in the picker for the retry that reaches the absent path.
  expect(h.leaveRequests()).toHaveLength(1);
  expect(h.leave).toHaveBeenCalledWith(secondary, { purge: true });
  expect(h.onSelect).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(button("Secondary")).toBeInTheDocument();
  await waitFor(() => expect(switcher()).toHaveFocus());
});

it("falls back to the save failure's own message when it carries no cause", async () => {
  const user = userEvent.setup();
  const h = harness({ leaveError: new Error("Storage is read-only.") });
  render(<CommunityPicker communities={h.communities} />);
  const dialog = await askToLeave(user, "Secondary");
  await user.click(confirmLeave(dialog));
  await screen.findByText(
    "Left Secondary — https://secondary.example, but this device couldn’t finish cleaning up (Storage is read-only). Leave it again to finish.",
  );
  expect(button("Secondary")).toBeInTheDocument();
});

it("still reports a successful leave when the host's selection callback throws", async () => {
  const user = userEvent.setup();
  const h = harness();
  const hostError = new Error("Navigation failed");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const onSelect = vi.fn(() => {
    throw hostError;
  });
  render(<CommunityPicker communities={h.communities} onSelect={onSelect} />);
  const dialog = await askToLeave(user, "Primary");
  await user.click(confirmLeave(dialog));
  // The device did finish: the community is gone and the relay released it.
  // A host that cannot navigate afterwards must not read as a device failure.
  const notice = await screen.findByText(
    "Left Primary — https://primary.example.",
  );
  expect(notice.closest(".buzz-toast")).toHaveAttribute("data-type", "success");
  expect(screen.queryByText(/couldn’t finish cleaning up/)).toBeNull();
  expect(onSelect).toHaveBeenCalledWith(null);
  expect(error).toHaveBeenCalledWith(
    "Couldn't select Personal space after removing Primary",
    hostError,
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(
    screen.queryByRole("button", { name: "Switch to Primary" }),
  ).toBeNull();
  await waitFor(() => expect(switcher()).toHaveFocus());
  expect(switcher()).toHaveAccessibleName("Community switcher: Personal space");
});

it("says when some saved data outlived the purge", async () => {
  const user = userEvent.setup();
  const h = harness({
    leaveResidue: [{ store: "outbox", error: new Error("blocked") }],
  });
  render(<CommunityPicker communities={h.communities} />);
  const dialog = await askToLeave(user, "Secondary");
  await user.click(confirmLeave(dialog));
  const notice = await screen.findByText(
    "Left Secondary — https://secondary.example. Some saved data couldn’t be cleared.",
  );
  expect(notice.closest(".buzz-toast")).toHaveAttribute("data-type", "success");
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Switch to Secondary" }),
    ).toBeNull(),
  );
});

it("keeps the pending leave modal and prevents another submission until the relay answers", async () => {
  const user = userEvent.setup();
  let release!: (response: Response) => void;
  const h = harness({
    leaveResponse: () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  });
  render(<CommunityPicker communities={h.communities} />);
  const dialog = await askToLeave(user, "Secondary");
  const confirm = confirmLeave(dialog);
  await user.click(confirm);
  await waitFor(() => expect(h.leaveRequests()).toHaveLength(1));
  expect(confirm).toHaveAttribute("aria-busy", "true");
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
  // Closing is refused while the request runs.
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.getByRole("alertdialog")).toBe(dialog);
  // The dropdown closes before confirmation, so a second leave action is
  // unavailable. The pending confirm also cannot submit twice.
  expect(
    screen.queryByRole("dialog", { name: "Switch community", hidden: true }),
  ).toBeNull();
  fireEvent.click(confirm);
  expect(h.leaveRequests()).toHaveLength(1);
  release(accepted());
  await screen.findByText("Left Secondary — https://secondary.example.");
  expect(h.leave).toHaveBeenCalledTimes(1);
});

it("does not discover saved community icons without a relay host", async () => {
  const viewer = "e".repeat(64);
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "Local", picture: "" },
      memberships: [{ id: "https://saved.example", name: "Saved" }],
      selected: "https://saved.example",
    }),
  );
  const ctx = new Context();
  vi.stubGlobal("fetch", vi.fn());
  const communities = createCommunities(
    ctx,
    false,
    undefined,
    "",
    undefined,
    Promise.resolve(viewer),
  );
  try {
    await waitFor(() => expect(communities.snapshot().status).toBe("ready"));
    render(<CommunityPicker communities={communities} />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Switch to Saved" }),
      ).toBeVisible(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Join a community" }));
    expect(
      screen.getByText(/connecting to communities is not available/),
    ).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    cleanup();
    await ctx.fiber.dispose();
  }
});

it("removes the Invite shortcut with its Settings contribution and restores it on re-enable", async () => {
  const h = harness();
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const cards = new SettingsCardsService(root);
  const register = () =>
    root
      .extend({ pluginOwner: { id: "buzz.moderation", revision: "bundled" } })
      .plugin((ctx) => {
        ctx.settingsCards.register({
          id: "membership",
          title: "Membership",
          component: () => null,
          visibility: {
            snapshot: () => false,
            subscribe: () => () => {},
            ensure: () => () => {},
          },
        });
      });
  try {
    render(
      <CommunityPicker
        communities={h.communities}
        onOpenTarget={h.onOpenTarget}
        settingsCards={cards}
      />,
    );
    const menu = await openMenu("Primary");
    expect(
      within(menu).queryByRole("menuitem", { name: "Invite to community" }),
    ).toBeNull();
    expect(h.read).not.toHaveBeenCalled();
    let fiber: ReturnType<typeof register>;
    await act(async () => {
      fiber = register();
      await fiber.await();
    });
    await within(menu).findByRole("menuitem", { name: "Invite to community" });
    await act(async () => {
      await fiber.dispose();
    });
    expect(
      within(menu).queryByRole("menuitem", { name: "Invite to community" }),
    ).toBeNull();
    expect(
      within(menu).getByRole("menuitem", { name: "Leave community" }),
    ).toBeInTheDocument();
    expect(h.onOpenTarget).not.toHaveBeenCalled();
    await act(async () => {
      fiber = register();
      await fiber.await();
    });
    fireEvent.click(
      await within(menu).findByRole("menuitem", {
        name: "Invite to community",
      }),
    );
    expect(h.onOpenTarget).toHaveBeenCalledWith({
      version: 1,
      kind: "settings",
      section: MEMBERSHIP_SECTION,
      scope: { viewer, communityOrigin: primary },
    });
  } finally {
    cleanup();
    await root.fiber.dispose();
  }
});

it("opens a deep-link invite on Personal space without claiming until the user continues", async () => {
  const t = harness();
  t.update({ selected: null });
  const onInviteClose = vi.fn();
  render(
    <CommunityPicker
      communities={t.communities}
      invite={{
        community: "https://invited.example",
        code: "v2.invite",
        requestId: 1,
      }}
      onInviteClose={onInviteClose}
      onSelect={t.onSelect}
    />,
  );
  expect(screen.getByLabelText("Community URL")).toHaveValue(
    "https://invited.example",
  );
  expect(
    t.fetch.mock.calls.some(([url]) => String(url).includes("/claim")),
  ).toBe(false);
  expect(t.select).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(onInviteClose).toHaveBeenCalledWith(1);
  expect(t.select).not.toHaveBeenCalled();
});

it("connects at once to a community the person asked to join from the app", async () => {
  const t = harness();
  render(
    <CommunityPicker
      communities={t.communities}
      invite={{
        community: "https://created.example",
        code: "",
        submitted: true,
        requestId: 2,
      }}
      onInviteClose={vi.fn()}
      onSelect={t.onSelect}
    />,
  );
  // No Continue: the dialog looks the community up as soon as it opens.
  await waitFor(() =>
    expect(t.fetch).toHaveBeenCalledWith(
      `/api/relay/${encodeURIComponent("https://created.example")}/info`,
      expect.anything(),
    ),
  );
  expect(t.select).not.toHaveBeenCalled();
});

it("labels the existing picker Communities only while no community is saved", async () => {
  const h = harness();
  h.update({ selected: null, memberships: [] });
  rtlRender(<CommunityPicker communities={h.communities} />, {
    wrapper: ToastProvider,
  });
  const user = userEvent.setup();
  const picker = switcher();
  expect(picker).toHaveAccessibleName("Community switcher: Communities");
  expect(
    within(
      screen.getByRole("navigation", { name: "Communities" }),
    ).getAllByRole("button"),
  ).toHaveLength(1);
  await user.click(picker);
  await user.click(screen.getByRole("button", { name: "Join a community" }));
  expect(
    screen.getByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(picker).toHaveFocus());

  h.update({ memberships: [{ id: primary, name: "Primary" }] });
  expect(switcher()).toHaveAccessibleName("Community switcher: Personal space");
  h.update({ selected: primary });
  expect(switcher()).toHaveAccessibleName("Community switcher: Primary");
  h.update({ selected: null, memberships: [] });
  expect(switcher()).toHaveAccessibleName("Community switcher: Communities");
});

it("shows only the active community until opened and routes creation through Hosted communities", async () => {
  const h = harness();
  const onOpenTarget = vi.fn();
  rtlRender(
    <CommunityPicker
      communities={h.communities}
      onOpenTarget={onOpenTarget}
      settingsCards={{
        subscribe: () => () => {},
        has: (key) => key === "block.builderlab/login",
      }}
    />,
    { wrapper: ToastProvider },
  );
  expect(
    within(
      screen.getByRole("navigation", { name: "Communities" }),
    ).getAllByRole("button"),
  ).toHaveLength(1);
  expect(switcher()).toHaveAccessibleName("Community switcher: Primary");
  expect(
    screen.queryByRole("button", { name: "Switch to Secondary" }),
  ).toBeNull();
  const user = userEvent.setup();
  await user.click(switcher());
  const popup = await screen.findByRole("dialog", { name: "Switch community" });
  expect(within(popup).getAllByRole("button").at(-1)).toHaveTextContent(
    "Create community",
  );
  await user.keyboard("{End}");
  expect(
    screen.getByRole("button", { name: "Create community" }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(onOpenTarget).toHaveBeenCalledWith({
    version: 1,
    kind: "settings",
    section: "block.builderlab/login",
  });
  expect(h.select).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Switch community" }),
    ).toBeNull(),
  );
});

it("returns focus to the trigger when the host reopens the switcher after a choice navigated", async () => {
  const h = harness();
  function Host() {
    const [open, setOpen] = useState(false);
    return (
      <>
        {/* The shell's content, which focus follows after a choice navigates. */}
        <main id="main-content" tabIndex={-1} />
        <button type="button" onClick={() => setOpen(true)}>
          Choose a community
        </button>
        <CommunityPicker
          communities={h.communities}
          onOpenTarget={h.onOpenTarget}
          settingsCards={{
            subscribe: () => () => {},
            has: (key) => key === "block.builderlab/login",
          }}
          open={open}
          onOpenChange={setOpen}
        />
      </>
    );
  }
  rtlRender(<Host />, { wrapper: ToastProvider });
  const user = userEvent.setup();
  await user.click(switcher());
  await user.click(
    await screen.findByRole("button", { name: "Create community" }),
  );
  expect(h.onOpenTarget).toHaveBeenCalledWith({
    version: 1,
    kind: "settings",
    section: "block.builderlab/login",
  });
  await waitFor(() =>
    expect(document.getElementById("main-content")).toHaveFocus(),
  );

  // The host opens the switcher without its trigger; a dismissal without a
  // choice still returns focus to the trigger, not to the earlier destination.
  await user.click(screen.getByRole("button", { name: "Choose a community" }));
  await screen.findByRole("dialog", { name: "Switch community" });
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Switch community" }),
    ).toBeNull(),
  );
  await waitFor(() => expect(switcher()).toHaveFocus());
});

it("shares discovered community artwork with an already-open Settings address without another read", async () => {
  const root = new Context();
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "You", picture: "" },
      selected: null,
      memberships: [{ id: primary, name: "Primary" }],
    }),
  );
  let finish!: (response: Response) => void;
  const pendingIcon = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const artwork = "https://images.example/bee.png";
  const communityId = "primary";
  const fetch = vi.fn(async (url: string) => {
    if (url === "/api/relay/identity") return Response.json({ viewer });
    if (url === "/api/relay/register") return Response.json({});
    if (url === `/api/relay/${communityId}/icon-info`) return pendingIcon;
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  const communities = createCommunities(root, true);
  try {
    await waitFor(() => expect(communities.snapshot().status).toBe("ready"));
    render(
      <>
        <CommunityPicker communities={communities} />
        <CommunityAddress
          communities={communities}
          community={{ id: communityId, name: "Primary" }}
        />
      </>,
    );
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        `/api/relay/${communityId}/icon-info`,
        expect.anything(),
      ),
    );
    await act(async () => finish(Response.json({ icon: artwork })));
    await waitFor(() =>
      expect(button("Primary").querySelector("img")).toHaveAttribute(
        "src",
        artwork,
      ),
    );
    expect(
      screen
        .getByRole("button", { name: "Copy community URL, primary.example" })
        .querySelector("img"),
    ).toHaveAttribute("src", artwork);
    expect(
      fetch.mock.calls.filter(
        ([url]) => url === `/api/relay/${communityId}/icon-info`,
      ),
    ).toHaveLength(1);
    expect(fetch.mock.calls.some(([url]) => url.endsWith("/session"))).toBe(
      false,
    );
  } finally {
    await act(async () => finish(Response.json({ icon: artwork })));
    cleanup();
    await root.fiber.dispose();
  }
});
