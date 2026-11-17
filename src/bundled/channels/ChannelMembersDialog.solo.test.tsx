// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { SOLO_LABEL } from "../../features/solo/labels";
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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import {
  keypair,
  metadata,
  profile,
  signed,
} from "../../features/relay/testing";
import { Context } from "@deepseek-ai/cordis";
import { ShortcutsService } from "../../features/shortcuts/service";
import { createNavigationController } from "../../features/navigation/controller";
import { createMemoryHistory } from "../../features/navigation/history";
import { registerNavigationShortcuts } from "../../app/shortcuts";
import { matchesEvent } from "../../features/relay/projection";
import type { RelayEvent } from "../../features/relay/events";
import { PublishRejected } from "../../features/relay/outbox";
import { ChatSharedMark, soloSharedMarkId } from "./ChatSharedMark";
import { ChannelMembersDialog } from "./ChannelMembersDialog";
import { useRef, useState, useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";
import {
  formatPublicKey,
  publicKeyLabels,
} from "../../shared/identity/public-key";

/** The Solo header entry point: the people icon opens the shared access dialog. */
function SoloShare({
  session,
  channel,
  signal,
  onClose,
}: {
  session: RelaySession;
  channel: { id: string };
  signal?: AbortSignal;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  return (
    <>
      <button ref={trigger} type="button" onClick={() => setOpen(true)}>
        Access
      </button>
      <ChatSharedMark
        session={session}
        channel={list.channels.find((item) => item.id === channel.id)}
        onOpen={() => setOpen(true)}
      />
      {open && (
        <ChannelMembersDialog
          session={session}
          channelId={channel.id}
          signal={signal}
          trigger={trigger}
          close={() => {
            setOpen(false);
            onClose?.();
          }}
        />
      )}
    </>
  );
}

const source = "11111111-1111-4111-8111-111111111111";
const destination = "22222222-2222-4222-8222-222222222222";
const owners: ReturnType<typeof createRelaySession>[] = [];
// jsdom lacks scrollIntoView; the search highlight keeps its row in view.
// The share result is a host toast; the shared Toast owns how it shows.
const notify = vi.hoisted(() => vi.fn());
vi.mock("../../shared/design-system/ui/Toast", async (original) => ({
  ...(await original<typeof import("../../shared/design-system/ui/Toast")>()),
  useToastNotification: () => notify,
}));

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  notify.mockReset();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  localStorage.clear();
  for (const owner of owners.splice(0)) owner.dispose();
});
function fixture(
  direct = false,
  access?: { visibility: "private" | "public"; joinRole: "member" | "guest" },
) {
  const viewer = keypair(),
    relay = keypair(),
    aria = keypair(),
    dev = keypair();
  const profiles = [
    profile(aria, { name: "Aria" }),
    profile(dev, { name: "Dev" }),
  ];
  let clock = 1_700_000_000;
  const members = new Map([
    [source, [viewer.pubkey]],
    [destination, [viewer.pubkey]],
  ]);
  const metadataEvents = new Map([
    [
      source,
      metadata(relay, source, "Work", clock, [
        ["t", "stream"],
        ["t", SOLO_LABEL],
        [access?.visibility ?? "private"],
        ...(access ? [["join_role", access.joinRole]] : []),
        // The owner's own Solo chat, or one shared with them as a guest.
        ["P", direct ? viewer.pubkey : relay.pubkey],
      ]),
    ],
    [
      destination,
      metadata(relay, destination, "Planning", clock, [
        ["t", "stream"],
        ["private"],
      ]),
    ],
  ]);
  const published: RelayEvent[] = [];
  let failLink = false;
  let holdLink: Promise<void> | undefined;
  let failGrant = false;
  let failDetails = false;
  let failRoster = false;
  let holdRoster: Promise<void> | undefined;
  let holdRoles: Promise<void> | undefined;
  const roles = new Map<string, string>();
  let loseDetailsResponse = false;
  const projects = (assignments: Record<string, string>) => ({
    status: "ready" as const,
    data: {
      sections: [{ id: "g", name: "Project", order: 0 }],
      assignments,
      starred: [],
      muted: [],
    },
  });
  const filedProjects = projects({ [source]: "g" });
  const unfiledProjects = projects({});
  let filed = direct;
  const placement = vi.fn(async (_id: string, _sectionId?: string) => {
    filed = false;
    return { sections: [], assignments: {}, starred: [], muted: [] };
  });
  let records: readonly import("../../features/relay/outbox").OutgoingEvent[] =
    [];
  const publish = vi.fn(async (event: RelayEvent) => {
    if (event.kind === 9) await holdLink;
    if (event.kind === 9 && failLink) throw new PublishRejected("Post refused");
    if (event.kind === 9000 && failGrant)
      throw new PublishRejected("Chat invite refused");
    if (event.kind === 9002 && failDetails)
      throw new PublishRejected("Settings refused");
    published.push(event);
    if (event.kind === 9002) {
      const value = (tag: string) =>
        event.tags.find(([name]) => name === tag)?.[1];
      const previous = metadataEvents.get(source)?.tags ?? [];
      const ttl = value("ttl") ?? previous.find(([tag]) => tag === "ttl")?.[1];
      const visibility = value("visibility");
      const joinRole =
        value("join_role") ??
        previous.find(([tag]) => tag === "join_role")?.[1];
      const written = event.tags.flatMap(([tag, label]) =>
        tag === "t" ? [label ?? ""] : [],
      );
      const labels = written.length
        ? written.filter(Boolean)
        : previous.flatMap(([tag, label]) =>
            tag === "t" && label !== "stream" ? [label ?? ""] : [],
          );
      metadataEvents.set(
        source,
        metadata(relay, source, value("name") ?? "Work", ++clock, [
          ["t", "stream"],
          ...labels.map((label) => ["t", label]),
          ...previous.filter(([tag]) => tag === "P"),
          [
            visibility
              ? visibility === "open"
                ? "public"
                : "private"
              : previous.some(([tag]) => tag === "public")
                ? "public"
                : "private",
          ],
          [
            "about",
            value("about") ??
              previous.find(([tag]) => tag === "about")?.[1] ??
              "",
          ],
          ...(ttl && ttl !== "0" ? [["ttl", ttl]] : []),
          ...(joinRole ? [["join_role", joinRole]] : []),
        ]),
      );
      if (loseDetailsResponse) throw new Error("Lost settings response");
    }
    if (event.kind === 9000) {
      const id = event.tags.find(([name]) => name === "h")?.[1] ?? "";
      const key = event.tags.find(([name]) => name === "p")?.[1] ?? "";
      members.set(id, [...new Set([...(members.get(id) ?? []), key])]);
      clock++;
    }
    if (event.kind === 9001) {
      const id = event.tags.find(([name]) => name === "h")?.[1] ?? "";
      const key = event.tags.find(([name]) => name === "p")?.[1] ?? "";
      members.set(
        id,
        (members.get(id) ?? []).filter((member) => member !== key),
      );
      clock++;
    }
  });
  const detailsSign = vi.fn(
    async (event: import("nostr-tools").EventTemplate) => signed(viewer, event),
  );
  const owner = createRelaySession(
    {
      channelIdentity: true,
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: "https://community.test",
      media: () => undefined,
      query: async (filters) => {
        if (filters.some((filter) => filter.consistency === "strong")) {
          // Hold this explicit administration refresh, not independent signed
          // access reads started while its member-role UI is still loading.
          const held = holdRoles;
          holdRoles = undefined;
          await held;
        }
        if (
          filters.some(
            (filter) => filter.kinds?.length === 1 && filter.kinds[0] === 39002,
          )
        ) {
          await holdRoster;
          if (failRoster) throw new Error("Roster unavailable");
        }
        if (filters.some((filter) => filter.search))
          return profiles.filter((item) =>
            item.content
              .toLowerCase()
              .includes(filters[0]?.search?.toLowerCase() ?? ""),
          );
        const events = [
          ...metadataEvents.values(),
          ...[...members.keys()].map((id) =>
            signed(relay, {
              kind: 39001,
              created_at: clock,
              content: "",
              tags: [
                ["d", id],
                ["p", viewer.pubkey, "owner"],
              ],
            }),
          ),
          ...[...members].map(([id, keys]) =>
            signed(relay, {
              kind: 39002,
              created_at: clock,
              content: "",
              tags: [
                ["d", id],
                ...keys.map((key) => [
                  "p",
                  key,
                  "",
                  roles.get(key) ??
                    (key === viewer.pubkey
                      ? "owner"
                      : profiles.some(
                            (event) =>
                              event.pubkey === key &&
                              JSON.parse(event.content).is_agent,
                          )
                        ? "bot"
                        : "member"),
                ]),
              ],
            }),
          ),
          ...published,
          ...profiles,
        ];
        return events.filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
      },
      channelDetails: {
        sign: detailsSign,
        publish,
      },
      memberAdministration: {
        sign: async (event) => signed(viewer, event),
        publish,
      },
      writer: {
        kinds: [9, 9000, 9002],
        sign: async (event) => signed(viewer, event),
        publish: async (event) => {
          await publish(event);
        },
      },
    },
    {
      outboxStorage: {
        load: () => records,
        save: (next) => {
          records = structuredClone(next);
        },
      },
    },
  );
  owners.push(owner);
  const session = direct
    ? {
        ...owner.session,
        messages: { ...owner.session.messages },
        soloPreferences: {
          ...owner.session.soloPreferences,
          snapshot: () => (filed ? filedProjects : unfiledProjects),
          refresh: async () => {},
          assign: placement,
        },
      }
    : owner.session;
  const channel = () =>
    owner.session.channels.list().channels.find((item) => item.id === source);
  return {
    session,
    placement,
    failDetails(value: boolean) {
      failDetails = value;
    },
    loseDetailsResponse(value: boolean) {
      loseDetailsResponse = value;
    },
    failRoster(value: boolean) {
      failRoster = value;
    },
    holdRoster(value: Promise<void> | undefined) {
      holdRoster = value;
    },
    addProfile(key: ReturnType<typeof keypair>, name: string, agent = false) {
      profiles.push(
        profile(key, { name, ...(agent ? { is_agent: true } : {}) }),
      );
    },
    holdRoles(value: Promise<void> | undefined) {
      holdRoles = value;
    },
    roles,
    viewer,
    aria,
    dev,
    members,
    setArchived(archived: boolean) {
      metadataEvents.set(
        source,
        metadata(relay, source, "Work", ++clock, [
          ["t", "stream"],
          ["t", SOLO_LABEL],
          ["private"],
          ["P", direct ? viewer.pubkey : relay.pubkey],
          ["archived", String(archived)],
        ]),
      );
      session.channels.refreshList?.();
    },
    published,
    publish,
    detailsSign,
    channel,
    failLink(value: boolean) {
      failLink = value;
    },
    holdLink(value: Promise<void> | undefined) {
      holdLink = value;
    },
    failGrant(value: boolean) {
      failGrant = value;
    },
    setSourceMembers(keys: string[]) {
      members.set(source, keys);
      clock++;
    },
    setDestinationMembers(keys: string[]) {
      members.set(destination, keys);
      clock++;
    },
    addDestination(key: string) {
      members.set(destination, [
        ...new Set([...(members.get(destination) ?? []), key]),
      ]);
      clock++;
    },
    addChannel(id: string, name: string) {
      members.set(id, [viewer.pubkey]);
      metadataEvents.set(
        id,
        metadata(relay, id, name, ++clock, [["t", "stream"], ["private"]]),
      );
    },
    async ready() {
      owner.session.channels.ensureList();
      await waitFor(() => expect(channel()?.channelType).toBe("solo"), {
        interval: 1,
      });
    },
    mount(props: { signal?: AbortSignal; onClose?: () => void } = {}) {
      const initial = channel();
      if (!initial) throw new Error("Chat not loaded");
      return render(
        <SoloShare session={session} channel={initial} {...props} />,
      );
    },
  };
}

it("shows Public without offering Public and changes its admission to Guest", async () => {
  const t = fixture(true, { visibility: "public", joinRole: "member" });
  await t.ready();
  t.mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const audience = await screen.findByRole("combobox", {
    name: "General access",
  });
  await waitFor(() => expect(audience).toBeEnabled());
  expect(audience).toHaveTextContent("Public");
  await user.click(audience);
  expect(
    (await screen.findAllByRole("option")).map((option) =>
      option.getAttribute("aria-label"),
    ),
  ).toEqual(["View only", "Private"]);
  await user.click(screen.getByRole("option", { name: "View only" }));
  expect(screen.getByRole("alertdialog")).toHaveAccessibleDescription(
    "Everyone in this community will be able to read this chat’s full history and Canvas, including its workspace folders and agent instructions. People already in the chat keep their access. You won’t be able to switch back to Public here.",
  );
  expect(t.published).toEqual([]);
  await user.click(screen.getByRole("button", { name: "Change access" }));
  await waitFor(() => expect(audience).toBeEnabled());
  expect(audience).toHaveTextContent("View only");
  expect(t.published).toHaveLength(1);
  expect(t.published[0]).toMatchObject({ kind: 9002 });
  expect(t.published[0]?.tags).toContainEqual(["join_role", "guest"]);
  expect(t.channel()).toMatchObject({
    channelType: "solo",
    visibility: "public",
    joinRole: "guest",
    labels: [SOLO_LABEL],
  });
  expect(t.members.get(source)).toEqual([t.viewer.pubkey]);
  expect(t.placement).not.toHaveBeenCalled();
});

it("opens a Solo chat for view-only visitors and makes it private again without conversion or grants", async () => {
  const t = fixture(true);
  await t.ready();
  t.mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const audience = await screen.findByRole("combobox", {
    name: "General access",
  });
  await waitFor(() => expect(audience).toBeEnabled());
  expect(audience).toHaveTextContent("Private");
  await user.click(audience);
  expect(
    (await screen.findAllByRole("option")).map((option) =>
      option.getAttribute("aria-label"),
    ),
  ).toEqual(["View only", "Private"]);
  await user.click(await screen.findByRole("option", { name: "View only" }));
  const confirmation = screen.getByRole("alertdialog", {
    name: "Change general access?",
  });
  expect(confirmation).toHaveAccessibleDescription(
    "Everyone in this community will be able to read this chat’s full history and Canvas, including its workspace folders and agent instructions.",
  );
  expect(
    screen.queryByRole("combobox", { name: "New people can" }),
  ).not.toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(audience).toHaveFocus());
  expect(t.published).toEqual([]);
  await user.click(audience);
  await user.click(await screen.findByRole("option", { name: "View only" }));
  await user.click(screen.getByRole("button", { name: "Change access" }));
  await waitFor(() => expect(audience).toBeEnabled());
  expect(audience).toHaveTextContent("View only");
  expect(t.published).toHaveLength(1);
  expect(t.published[0]).toMatchObject({ kind: 9002 });
  expect(t.published[0]?.tags).toContainEqual(["visibility", "open"]);
  expect(t.published[0]?.tags).toContainEqual(["join_role", "guest"]);
  expect(t.channel()).toMatchObject({
    channelType: "solo",
    visibility: "public",
    joinRole: "guest",
    labels: [SOLO_LABEL],
  });
  expect(
    screen.queryByRole("combobox", { name: "New people can" }),
  ).not.toBeInTheDocument();
  expect(t.session.soloPreferences.snapshot().data?.assignments).toEqual({
    [source]: "g",
  });
  expect(t.placement).not.toHaveBeenCalled();
  expect(t.members.get(source)).toEqual([t.viewer.pubkey]);
  await user.click(audience);
  await user.click(await screen.findByRole("option", { name: "Private" }));
  await user.click(screen.getByRole("button", { name: "Change access" }));
  await waitFor(() => expect(audience).toBeEnabled());
  expect(audience).toHaveTextContent("Private");
  expect(t.channel()).toMatchObject({
    channelType: "solo",
    visibility: "private",
    joinRole: "guest",
    labels: [SOLO_LABEL],
  });
  expect(t.published.map(({ kind }) => kind)).toEqual([9002, 9002]);
  expect(t.published[1]?.tags).toContainEqual(["visibility", "private"]);
  expect(t.placement).not.toHaveBeenCalled();
});

it.each(["guest", "member"] as const)(
  "warns about retained viewers only with a verified %s in a View-only chat",
  async (role) => {
    const t = fixture(true, { visibility: "public", joinRole: "guest" });
    t.setSourceMembers([t.viewer.pubkey, t.aria.pubkey]);
    t.roles.set(t.aria.pubkey, role);
    await t.ready();
    t.mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Access" }));
    const audience = await screen.findByRole("combobox", {
      name: "General access",
    });
    await waitFor(() => expect(audience).toBeEnabled());
    await waitFor(() =>
      expect(t.session.memberAdministration.snapshot(source).status).toBe(
        "ready",
      ),
    );
    await user.click(audience);
    await user.click(await screen.findByRole("option", { name: "Private" }));
    expect(screen.getByRole("alertdialog")).toHaveAccessibleDescription(
      `Only chat members will have access.${role === "guest" ? " People who joined while it was View only are members and keep reading until you remove them in People." : ""}`,
    );
    expect(t.published).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Change access" }));
    await waitFor(() => expect(audience).toBeEnabled());
    expect(audience).toHaveTextContent("Private");
    expect(t.published.map(({ kind }) => kind)).toEqual([9002]);
    expect(t.members.get(source)).toEqual([t.viewer.pubkey, t.aria.pubkey]);
    expect(
      t.session.memberAdministration.snapshot(source).authority.roles[
        t.aria.pubkey
      ],
    ).toBe(role);
  },
);

it.each(["guest", "member"] as const)(
  "keeps the retained-viewer warning while previous %s roles are loading or unavailable",
  async (role) => {
    const t = fixture(true, { visibility: "public", joinRole: "guest" });
    t.setSourceMembers([t.viewer.pubkey, t.aria.pubkey]);
    t.roles.set(t.aria.pubkey, role);
    await t.ready();
    t.mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Access" }));
    const audience = await screen.findByRole("combobox", {
      name: "General access",
    });
    await waitFor(() => expect(audience).toBeEnabled());
    await waitFor(() =>
      expect(t.session.memberAdministration.snapshot(source).status).toBe(
        "ready",
      ),
    );
    let release!: () => void;
    let reject!: (reason: Error) => void;
    t.holdRoles(
      new Promise<void>((resolve, fail) => {
        release = resolve;
        reject = fail;
      }),
    );
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = t.session.memberAdministration.refresh(source);
    });
    try {
      await waitFor(() =>
        expect(t.session.memberAdministration.snapshot(source).status).toBe(
          "loading",
        ),
      );
      expect(
        t.session.memberAdministration.snapshot(source).authority.roles[
          t.aria.pubkey
        ],
      ).toBe(role);
      await user.click(audience);
      await user.click(await screen.findByRole("option", { name: "Private" }));
      expect(
        await screen.findByRole("alertdialog"),
      ).toHaveAccessibleDescription(
        "Only chat members will have access. People who joined while it was View only are members and keep reading until you remove them in People.",
      );
      await act(async () => {
        reject(new Error("Roles unavailable"));
        await refreshing;
      });
      expect(t.session.memberAdministration.snapshot(source).status).toBe(
        "error",
      );
      expect(
        await screen.findByRole("alertdialog"),
      ).toHaveAccessibleDescription(
        "Only chat members will have access. People who joined while it was View only are members and keep reading until you remove them in People.",
      );
      await user.keyboard("{Escape}");
      expect(t.published).toEqual([]);
    } finally {
      release();
      await act(async () => {
        await refreshing;
      });
    }
  },
);

const search = (dialog: HTMLElement) =>
  within(dialog).getByRole("searchbox", { name: "Search people and channels" });
async function findDestination(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
) {
  await user.clear(search(dialog));
  await user.type(search(dialog), "Plan");
  return within(dialog).findByRole("button", { name: "Share Planning" });
}
const waitForAccess = (dialog: HTMLElement) =>
  waitFor(() =>
    expect(
      within(dialog).queryByRole("status", { name: "Loading members" }),
    ).toBeNull(),
  );

it("adds a person at once under the chat's share rule, by Add or Enter", async () => {
  const t = fixture();
  await t.ready();
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Share access" });
  await waitForAccess(dialog);
  await user.type(search(dialog), "Aria");
  const results = await within(dialog).findByRole("region", {
    name: "Not in this chat",
  });
  await within(results).findByRole("button", { name: /^Add Aria/ });
  expect(results).not.toHaveTextContent(formatPublicKey(t.aria.pubkey) ?? "");
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(t.published.map((event) => event.kind)).toEqual([9000]),
  );
  expect(t.published[0]?.tags).toContainEqual(["p", t.aria.pubkey]);
  expect(await within(dialog).findByText("Aria is in the chat.")).toBeVisible();
  await user.clear(search(dialog));
  expect(
    await within(dialog).findByRole("region", { name: "People" }),
  ).toHaveTextContent("Aria");
  await user.type(search(dialog), "Dev");
  await user.click(
    await within(dialog).findByRole("button", { name: /^Add Dev/ }),
  );
  await waitFor(() => expect(t.members.get(source)).toContain(t.dev.pubkey));
  // People are added; nothing waits for a footer Share.
  expect(within(dialog).getByRole("button", { name: "Done" })).toBeEnabled();
});

it("Copy alone neither saves selections nor grants access", async () => {
  const t = fixture();
  await t.ready();
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Share access" });
  const clipboard = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockResolvedValue();
  await findDestination(user, dialog);
  await user.click(within(dialog).getByRole("button", { name: "Copy link" }));
  expect(clipboard).toHaveBeenCalledWith(`buzz://channel/${source}`);
  const copied = within(dialog).getByRole("button", { name: "Link copied" });
  expect(copied).toHaveFocus();
  expect(within(dialog).getAllByText("Link copied")).toHaveLength(1);
  clipboard.mockRejectedValueOnce(new Error("Clipboard unavailable"));
  await user.click(copied);
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Couldn’t copy the link.",
  );
  await user.click(within(dialog).getByRole("button", { name: "Copy link" }));
  expect(
    within(dialog).getByRole("button", { name: "Link copied" }),
  ).toHaveFocus();
  expect(within(dialog).queryByRole("alert")).toBeNull();
  expect(t.publish).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  await user.click(screen.getByRole("button", { name: "Access" }));
  expect(
    search(screen.getByRole("dialog", { name: "Share access" })),
  ).toHaveValue("");
  expect(
    within(screen.getByRole("dialog", { name: "Share access" })).getByRole(
      "button",
      { name: "Copy link" },
    ),
  ).toBeEnabled();
  expect(t.publish).not.toHaveBeenCalled();
});

it.each(["member", "guest"] as const)(
  "shares a Private chat (%s) as View only after disclosure, without adding channel members",
  async (joinRole) => {
    const t = fixture(true, { visibility: "private", joinRole });
    await t.ready();
    t.addDestination(t.aria.pubkey);
    const before = [...(t.members.get(source) ?? [])];
    const user = userEvent.setup();
    t.mount();
    await user.click(screen.getByRole("button", { name: "Access" }));
    const dialog = screen.getByRole("dialog", { name: "Share access" });
    await findDestination(user, dialog);
    const share = within(dialog).getByRole("button", {
      name: "Share Planning",
    });
    await user.click(share);
    let confirmation = await screen.findByRole("alertdialog");
    expect(confirmation).toHaveAccessibleName("Share this chat?");
    expect(confirmation).toHaveAccessibleDescription(
      /^This changes the chat from Private to View only and posts its link in Planning\./,
    );
    expect(confirmation).toHaveTextContent(
      "Everyone in this community can read its full history, Canvas, workspace folders, and agent instructions.",
    );
    expect(t.published).toHaveLength(0);
    await user.click(
      within(confirmation).getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() => expect(share).toHaveFocus());
    expect(dialog).toBeVisible();
    expect(t.published).toHaveLength(0);
    await user.click(share);
    confirmation = await screen.findByRole("alertdialog");
    await user.click(
      within(confirmation).getByRole("button", {
        name: "Share",
      }),
    );
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() =>
      expect(t.published.map((event) => event.kind)).toEqual([9002, 9]),
    );
    expect(t.published[0]?.tags).toContainEqual(["visibility", "open"]);
    if (joinRole === "member")
      expect(t.published[0]?.tags).toContainEqual(["join_role", "guest"]);
    expect(t.published[1]?.content).toContain(`buzz://channel/${source}`);
    expect(t.published[1]?.tags).toContainEqual(["h", destination]);
    expect(t.published[1]?.tags.some(([name]) => name === "p")).toBe(false);
    expect(t.members.get(source)).toEqual(before);
    expect(t.channel()).toMatchObject({
      channelType: "solo",
      visibility: "public",
      joinRole: "guest",
    });
    expect(t.placement).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Chat changed to View only. Shared in Planning",
      "success",
      undefined,
    );
  },
);

it("shares to the current result after cancelling a different destination", async () => {
  const t = fixture(true);
  const other = "33333333-3333-4333-8333-333333333333";
  t.addChannel(other, "Review");
  await t.ready();
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Share access" });
  await user.click(await findDestination(user, dialog));
  const first = await screen.findByRole("alertdialog", {
    name: "Share this chat?",
  });
  expect(first).toHaveTextContent("posts its link in Planning");
  await user.click(within(first).getByRole("button", { name: "Cancel" }));
  const search = within(dialog).getByRole("searchbox", {
    name: "Search people and channels",
  });
  await user.clear(search);
  await user.type(search, "Review");
  await user.click(
    await within(dialog).findByRole("button", { name: "Share Review" }),
  );
  const confirmation = await screen.findByRole("alertdialog", {
    name: "Share this chat?",
  });
  expect(confirmation).toHaveTextContent("posts its link in Review");
  await user.click(within(confirmation).getByRole("button", { name: "Share" }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  await waitFor(() =>
    expect(t.published.map((event) => event.kind)).toEqual([9002, 9]),
  );
  expect(t.published[1]?.tags).toContainEqual(["h", other]);
});

it.each(["member", "guest"] as const)(
  "an already open chat (%s) preserves access and confirms View only delivery",
  async (joinRole) => {
    const t = fixture(true, { visibility: "public", joinRole });
    await t.ready();
    t.addDestination(t.aria.pubkey);
    const user = userEvent.setup();
    t.mount();
    await user.click(screen.getByRole("button", { name: "Access" }));
    const dialog = screen.getByRole("dialog", { name: "Share access" });
    await findDestination(user, dialog);
    await user.click(
      within(dialog).getByRole("button", { name: "Share Planning" }),
    );
    if (joinRole === "guest") {
      let confirmation = await screen.findByRole("alertdialog");
      expect(confirmation).toHaveAccessibleDescription(
        /^This chat is already View only\. Its link will be posted in Planning\./,
      );
      expect(t.published).toHaveLength(0);
      await user.click(
        within(confirmation).getByRole("button", { name: "Cancel" }),
      );
      const share = within(dialog).getByRole("button", {
        name: "Share Planning",
      });
      await waitFor(() => expect(share).toHaveFocus());
      expect(t.published).toHaveLength(0);
      await user.click(share);
      confirmation = await screen.findByRole("alertdialog");
      await user.click(
        within(confirmation).getByRole("button", { name: "Share" }),
      );
    }
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() =>
      expect(t.published.map((event) => event.kind)).toEqual([9]),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(t.channel()?.joinRole).toBe(joinRole);
    expect(t.members.get(source)).toEqual([t.viewer.pubkey]);
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Shared in Planning",
      "success",
      undefined,
    );
  },
);

it("a refused access change posts nothing and retry asks for confirmation again", async () => {
  const t = fixture(true);
  await t.ready();
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Share access" });
  await findDestination(user, dialog);
  await user.click(
    within(dialog).getByRole("button", { name: "Share Planning" }),
  );
  t.failDetails(true);
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Share",
    }),
  );
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Settings refused",
  );
  expect(t.published).toHaveLength(0);
  expect(notify).not.toHaveBeenCalled();
  t.failDetails(false);
  await user.click(
    within(dialog).getByRole("button", { name: "Retry share Planning" }),
  );
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Share",
    }),
  );
  await waitFor(() =>
    expect(t.published.map((event) => event.kind)).toEqual([9002, 9]),
  );
});

it("checks an uncertain access save before posting, without resending the access change", async () => {
  const t = fixture(true);
  await t.ready();
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Share access" });
  await findDestination(user, dialog);
  await user.click(
    within(dialog).getByRole("button", { name: "Share Planning" }),
  );
  t.loseDetailsResponse(true);
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Share",
    }),
  );
  await within(dialog).findByRole("button", {
    name: "Check access and share Planning",
  });
  expect(t.published.map((event) => event.kind)).toEqual([9002]);
  t.loseDetailsResponse(false);
  await user.click(
    within(dialog).getByRole("button", {
      name: "Check access and share Planning",
    }),
  );
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Share",
    }),
  );
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  await waitFor(() =>
    expect(t.published.map((event) => event.kind)).toEqual([9002, 9]),
  );
  expect(t.members.get(source)).toEqual([t.viewer.pubkey]);
  expect(notify).toHaveBeenCalledExactlyOnceWith(
    "Chat changed to View only. Shared in Planning",
    "success",
    undefined,
  );
});

it("retains View only when link enqueue fails and retries just the link", async () => {
  const t = fixture(true);
  await t.ready();
  const send = vi
    .spyOn(t.session.messages, "send")
    .mockImplementationOnce(() => {
      throw new Error("Link unavailable");
    });
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Share access" });
  await findDestination(user, dialog);
  await user.click(
    within(dialog).getByRole("button", { name: "Share Planning" }),
  );
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Share",
    }),
  );
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Link unavailable",
  );
  expect(t.channel()?.joinRole).toBe("guest");
  expect(t.published.map((event) => event.kind)).toEqual([9002]);
  expect(notify).not.toHaveBeenCalled();
  send.mockRestore();
  await user.click(
    within(dialog).getByRole("button", { name: "Retry share Planning" }),
  );
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Share",
    }),
  );
  await waitFor(() =>
    expect(t.published.map((event) => event.kind)).toEqual([9002, 9]),
  );
  expect(notify).toHaveBeenCalledExactlyOnceWith(
    "Chat changed to View only. Shared in Planning",
    "success",
    undefined,
  );
});

it.each([false, true])(
  "cancelling a checked share ends its toast attempt before sharing again (different target: %s)",
  async (differentTarget) => {
    const t = fixture(true);
    const other = "33333333-3333-4333-8333-333333333333";
    if (differentTarget) t.addChannel(other, "Review");
    await t.ready();
    const user = userEvent.setup();
    t.mount();
    await user.click(screen.getByRole("button", { name: "Access" }));
    const dialog = screen.getByRole("dialog", { name: "Share access" });
    await user.click(await findDestination(user, dialog));
    t.loseDetailsResponse(true);
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Share",
      }),
    );
    const check = await within(dialog).findByRole("button", {
      name: "Check access and share Planning",
    });
    t.loseDetailsResponse(false);
    await user.click(check);
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    const name = differentTarget ? "Review" : "Planning";
    if (differentTarget) {
      await user.clear(search(dialog));
      await user.type(search(dialog), name);
    }
    await user.click(
      await within(dialog).findByRole("button", { name: `Share ${name}` }),
    );
    const confirmation = await screen.findByRole("alertdialog");
    expect(confirmation).toHaveTextContent("This chat is already View only.");
    await user.click(
      within(confirmation).getByRole("button", { name: "Share" }),
    );
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() =>
      expect(t.published.map((event) => event.kind)).toEqual([9002, 9]),
    );
    expect(t.published[1]?.tags).toContainEqual([
      "h",
      differentTarget ? other : destination,
    ]);
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      `Shared in ${name}`,
      "success",
      undefined,
    );
  },
);

it("a different target after link enqueue rejection starts a new toast attempt", async () => {
  const t = fixture(true);
  const other = "33333333-3333-4333-8333-333333333333";
  t.addChannel(other, "Review");
  await t.ready();
  vi.spyOn(t.session.messages, "send").mockImplementationOnce(() => {
    throw new Error("Link unavailable");
  });
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Share access" });
  await user.click(await findDestination(user, dialog));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Share",
    }),
  );
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Link unavailable",
  );
  await user.clear(search(dialog));
  await user.type(search(dialog), "Review");
  await user.click(
    await within(dialog).findByRole("button", { name: "Share Review" }),
  );
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Share",
    }),
  );
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(notify).toHaveBeenCalledExactlyOnceWith(
    "Shared in Review",
    "success",
    undefined,
  );
});

it.each(["abort", "unmount"] as const)(
  "stops before posting if the access dialog's visit ends during an access save (%s)",
  async (mode) => {
    const t = fixture(true);
    await t.ready();
    const controller = new AbortController();
    let release!: () => void;
    let started!: () => void;
    const signingStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = t.detailsSign.getMockImplementation();
    if (!original) throw new Error("Missing signer fixture");
    t.detailsSign.mockImplementationOnce(async (...args) => {
      started();
      await gate;
      return original(...args);
    });
    const user = userEvent.setup();
    const mounted = t.mount(
      mode === "abort" ? { signal: controller.signal } : {},
    );
    try {
      await user.click(screen.getByRole("button", { name: "Access" }));
      const dialog = screen.getByRole("dialog", { name: "Share access" });
      await findDestination(user, dialog);
      await user.click(
        within(dialog).getByRole("button", { name: "Share Planning" }),
      );
      await user.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", {
          name: "Share",
        }),
      );
      await signingStarted;
      if (mode === "abort") act(() => controller.abort());
      mounted.unmount();
      release();
      await waitFor(() =>
        expect(t.session.channelDetails.snapshot(source)).toBeUndefined(),
      );
      expect(t.published).toHaveLength(0);
    } finally {
      release();
    }
  },
);

it("rejects a destination that became read only before making the chat readable", async () => {
  const t = fixture(true);
  await t.ready();
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Share access" });
  await findDestination(user, dialog);
  t.setDestinationMembers([t.aria.pubkey]);
  await user.click(
    within(dialog).getByRole("button", { name: "Share Planning" }),
  );
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Destination membership could not be confirmed",
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(t.published).toHaveLength(0);
});

it.each(["settings", "authority"] as const)(
  "does not publish a share after %s changed during confirmation",
  async (change) => {
    const t = fixture(true);
    await t.ready();
    const user = userEvent.setup();
    t.mount();
    await user.click(screen.getByRole("button", { name: "Access" }));
    const dialog = screen.getByRole("dialog", { name: "Share access" });
    await findDestination(user, dialog);
    await user.click(
      within(dialog).getByRole("button", { name: "Share Planning" }),
    );
    const confirmation = await screen.findByRole("alertdialog");
    if (change === "settings")
      t.setArchived(false); // New signed metadata revision.
    else t.setSourceMembers([t.aria.pubkey]);
    await user.click(
      within(confirmation).getByRole("button", {
        name: "Share",
      }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      change === "settings" ? "Channel details changed" : "access",
    );
    expect(t.published).toHaveLength(0);
  },
);

it("Done never promotes or removes a Solo chat, and conversion stays in the chat menu", async () => {
  const t = fixture(true);
  await t.ready();
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Share access" });
  expect(within(dialog).queryByRole("textbox", { name: "Name" })).toBeNull();
  expect(within(dialog).queryByRole("switch")).toBeNull();
  expect(
    within(dialog).queryByRole("button", { name: "Convert to channel" }),
  ).toBeNull();
  await user.click(within(dialog).getByRole("button", { name: "Done" }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(t.publish).not.toHaveBeenCalled();
  expect(t.placement).not.toHaveBeenCalled();
  expect(t.channel()?.channelType).toBe("solo");
});

it("leaves agents to mentions and shares a view-only link without enrolling or waking channel bots", async () => {
  const t = fixture(true, { visibility: "public", joinRole: "guest" });
  await t.ready();
  const bot = keypair();
  t.addProfile(bot, "Helper Bot", true);
  t.addDestination(bot.pubkey);
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Share access" });
  await waitForAccess(dialog);
  await user.type(search(dialog), "Helper");
  const results = await within(dialog).findByRole("region", {
    name: "Not in this chat",
  });
  await within(results).findByText("To add an agent, mention it in the chat.");
  expect(results).toHaveTextContent("No other matching people.");
  expect(within(results).queryByRole("button", { name: /Helper/ })).toBeNull();
  await findDestination(user, dialog);
  await user.click(
    within(dialog).getByRole("button", { name: "Share Planning" }),
  );
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Share",
    }),
  );
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  // Planning is private, so the toast names it without a hash like the sidebar.
  expect(notify).toHaveBeenCalledExactlyOnceWith(
    "Shared in Planning",
    "success",
    undefined,
  );
  expect(t.published.map((event) => event.kind)).toEqual([9]);
  expect(t.members.get(source)).not.toContain(bot.pubkey);
  expect(t.published[0]?.tags.some(([name]) => name === "p")).toBe(false);
  expect(document.querySelector("[data-solo-shared]")).toBeNull();
});

it("shows loading and failed current access with refresh, never an empty roster", async () => {
  const t = fixture(true);
  await t.ready();
  let release!: () => void;
  t.holdRoster(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  t.failRoster(true);
  const user = userEvent.setup();
  t.mount();
  try {
    await user.click(screen.getByRole("button", { name: "Access" }));
    const dialog = screen.getByRole("dialog", { name: "Share access" });
    const access = within(dialog).getByRole("region", { name: "Member list" });
    expect(
      within(access).getByRole("status", { name: "Loading members" }),
    ).toBeVisible();
    release();
    expect(await within(access).findByRole("alert")).toHaveTextContent(
      "Roster unavailable",
    );
    // A failed roster read never presents verified roles.
    expect(within(access).queryByText("Owner", { exact: true })).toBeNull();
    t.failRoster(false);
    t.holdRoster(undefined);
    const refresh = within(dialog).getByRole("button", {
      name: "Retry member data",
    });
    await waitFor(() =>
      expect(refresh).not.toHaveAttribute("aria-disabled", "true"),
    );
    await user.click(refresh);
    await within(access).findByRole("region", { name: "People" });
    // General access has its own failed metadata read and explicit recovery.
    const recovery = within(access).getByRole("group", {
      name: "General access recovery",
    });
    expect(within(recovery).getByRole("alert")).toHaveTextContent(
      "Roster unavailable",
    );
    await user.click(
      within(recovery).getByRole("button", { name: "Reload access" }),
    );
    await waitFor(() => expect(within(access).queryByRole("alert")).toBeNull());
    t.failRoster(true);
    await findDestination(user, dialog);
    await user.click(
      within(dialog).getByRole("button", { name: "Share Planning" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Roster unavailable",
    );
    t.failRoster(false);
    await user.click(
      within(dialog).getByRole("button", { name: "Retry share Planning" }),
    );
    const confirmation = await screen.findByRole("alertdialog");
    await user.click(
      within(confirmation).getByRole("button", { name: "Cancel" }),
    );
    expect(t.publish).not.toHaveBeenCalled();
  } finally {
    release();
    t.holdRoster(undefined);
  }
});

it("groups agents and people by role while only verified additional humans mark the chat Shared", async () => {
  const t = fixture();
  const bot = keypair(),
    unknown = keypair();
  t.addProfile(bot, "Helper Bot", true);
  t.members.set(source, [t.viewer.pubkey, bot.pubkey]);
  await t.ready();
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  let dialog = screen.getByRole("dialog", { name: "Share access" });
  const agents = await within(dialog).findByRole("region", { name: "Agents" });
  await within(agents).findByText("Helper Bot");
  expect(within(agents).getByRole("heading")).toHaveTextContent("Agents · 1");
  const people = within(dialog).getByRole("region", { name: "People" });
  expect(people).toHaveTextContent("(you)");
  expect(people).not.toHaveTextContent("Helper Bot");

  t.setSourceMembers([t.viewer.pubkey, bot.pubkey, unknown.pubkey]);
  await act(async () => {
    await t.session.channels.refreshRoster?.(source, { consistency: "strong" });
  });
  await waitFor(() =>
    expect(
      within(
        within(dialog).getByRole("region", { name: "People" }),
      ).getAllByRole("listitem"),
    ).toHaveLength(2),
  );
  expect(within(dialog).getAllByText("Helper Bot")).toHaveLength(1);
  await user.click(within(dialog).getByRole("button", { name: "Done" }));
  expect(document.querySelector("[data-solo-shared]")).toBeNull();
  t.addProfile(unknown, "Guest Human");
  await t.session.profiles.ensure([unknown.pubkey], "foreground");
  await waitFor(() =>
    expect(document.querySelector("[data-solo-shared]")).not.toBeNull(),
  );
  await user.click(screen.getByRole("button", { name: "Access" }));
  dialog = screen.getByRole("dialog", { name: "Share access" });
  expect(
    await within(dialog).findByRole("region", { name: "People" }),
  ).toHaveTextContent("Guest Human");
  expect(t.publish).not.toHaveBeenCalled();

  await user.click(within(dialog).getByRole("button", { name: "Done" }));
});

it("shows Shared on cold render from verified members and cached human evidence without administration demand", async () => {
  const t = fixture();
  t.members.set(source, [t.viewer.pubkey, t.aria.pubkey]);
  await t.ready();
  await t.session.profiles.ensure([t.aria.pubkey], "foreground");
  const channel = t.channel();
  expect(t.session.memberAdministration.snapshot(source)?.status).not.toBe(
    "ready",
  );
  expect(channel?.cached).not.toBe(true);
  // The sidebar's mark describes the row and opens its access list.
  const onOpen = vi.fn();
  render(
    <>
      <button type="button" aria-describedby={soloSharedMarkId(source)}>
        Row
      </button>
      <ChatSharedMark session={t.session} channel={channel} onOpen={onOpen} />
    </>,
  );
  expect(
    screen.getByRole("button", { name: "Row" }),
  ).toHaveAccessibleDescription("Shared");
  await userEvent.click(screen.getByRole("button", { name: "Shared" }));
  expect(onOpen).toHaveBeenCalledOnce();
  expect(t.session.memberAdministration.snapshot(source)?.status).not.toBe(
    "ready",
  );
});

it("offers matching people and channels as labelled results without public keys", async () => {
  const t = fixture(true);
  const planningPerson = keypair();
  t.addProfile(planningPerson, "Planning Person");
  t.members.set(source, [t.viewer.pubkey, t.aria.pubkey]);
  await t.ready();
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Share access" });
  expect(
    await within(dialog).findByRole("region", { name: "People" }),
  ).toHaveTextContent("Aria");
  await user.type(search(dialog), "Planning");
  const people = await within(dialog).findByRole("region", {
    name: "Not in this chat",
  });
  await within(people).findByRole("button", { name: /^Add Planning Person/ });
  const channels = within(dialog).getByRole("region", { name: "Channels" });
  expect(
    within(channels).getByRole("button", { name: "Share Planning" }),
  ).toHaveTextContent("Share");
  expect(dialog).not.toHaveTextContent(formatPublicKey(t.aria.pubkey) ?? "");
  expect(dialog).not.toHaveTextContent(
    formatPublicKey(planningPerson.pubkey) ?? "",
  );
  await user.click(
    within(channels).getByRole("button", { name: "Share Planning" }),
  );
  const confirmation = await screen.findByRole("alertdialog");
  expect(confirmation).toHaveTextContent("Planning");
  await user.click(
    within(confirmation).getByRole("button", { name: "Cancel" }),
  );
  expect(search(dialog)).toHaveValue("Planning");
  expect(
    within(dialog).queryByRole("region", { name: "Selected channel" }),
  ).toBeNull();
  expect(
    within(channels).getByRole("button", { name: "Share Planning" }),
  ).toHaveFocus();
  expect(within(dialog).getByRole("button", { name: "Done" })).toBeEnabled();
  expect(t.publish).not.toHaveBeenCalled();
});

it("distinguishes namesakes in results and adds only the chosen identity", async () => {
  const t = fixture();
  const first = keypair(),
    second = keypair();
  t.addProfile(first, "Morgan");
  t.addProfile(second, "Morgan");
  await t.ready();
  const labels = publicKeyLabels([first.pubkey, second.pubkey]);
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Share access" });
  await waitForAccess(dialog);
  await user.type(search(dialog), "Morgan");
  const firstAdd = await within(dialog).findByRole("button", {
    name: `Add Morgan (${labels.get(first.pubkey)})`,
  });
  expect(
    within(dialog).getByRole("button", {
      name: `Add Morgan (${labels.get(second.pubkey)})`,
    }),
  ).toBeVisible();
  // Without a naming plugin the rows still differ visibly, by key only.
  const shown = within(dialog)
    .getAllByText(/^npub…/)
    .map((node) => node.textContent);
  expect(shown).toHaveLength(2);
  expect(new Set(shown).size).toBe(2);
  expect(shown).toContain(
    firstAdd.getAttribute("aria-label")?.match(/\((npub…\w+)\)/)?.[1],
  );
  await user.click(firstAdd);
  await waitFor(() =>
    expect(t.published.map((event) => event.kind)).toEqual([9000]),
  );
  expect(t.published[0]?.tags).toContainEqual(["p", first.pubkey]);
  expect(t.published[0]?.tags).not.toContainEqual(["p", second.pubkey]);
});

it("lets the chat owner remove someone with access from the row menu", async () => {
  const t = fixture(true);
  t.members.set(source, [t.viewer.pubkey, t.aria.pubkey]);
  await t.ready();
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Share access" });
  const people = await within(dialog).findByRole("region", { name: "People" });
  await user.click(
    await within(people).findByRole("button", { name: "Actions for Aria" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Remove from chat" }),
  );
  const confirm = await within(dialog).findByRole("button", {
    name: "Remove member",
  });
  expect(dialog).toHaveAccessibleName("Remove member from chat");
  await waitFor(() => expect(confirm).toBeEnabled());
  await user.click(confirm);
  await waitFor(() =>
    expect(t.published.map((event) => event.kind)).toEqual([9001]),
  );
  expect(t.members.get(source)).toEqual([t.viewer.pubkey]);
});

it("Back never walks history behind a pending Share, and the dialog still closes afterwards", async () => {
  const t = fixture(true);
  await t.ready();
  t.addDestination(t.aria.pubkey);
  t.failDetails(true);
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Share access" });
  await findDestination(user, dialog);
  // Local Share access is not a navigation visit.
  expect(dialog).not.toHaveAttribute("data-navigation-visit");
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const shortcuts = new ShortcutsService(ctx, window);
  const controller = createNavigationController(createMemoryHistory());
  const remove = registerNavigationShortcuts(shortcuts, controller.navigation);
  let release!: () => void;
  try {
    const behind = { version: 1, kind: "settings" } as const;
    void controller.navigation.open({ version: 1, kind: "home" });
    void controller.navigation.open(behind);
    await waitFor(() =>
      expect(controller.navigation.snapshot().canGoBack).toBe(true),
    );
    // Share reads the destination's roster; hold it so Share stays pending.
    t.holdRoster(new Promise<void>((resolve) => (release = resolve)));
    await user.click(
      within(dialog).getByRole("button", { name: "Share Planning" }),
    );
    fireEvent.keyDown(dialog, { key: "[", ctrlKey: true });
    // The history-request.js route for mouse back.
    window.dispatchEvent(new Event("buzz:history-back"));
    await act(async () => {});
    expect(controller.navigation.snapshot().attempt.entry.target).toEqual(
      behind,
    );
    expect(dialog).toBeInTheDocument();
    t.holdRoster(undefined);
    release();
    await user.click(await screen.findByRole("button", { name: "Share" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Settings refused",
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Access" }));
    const again = screen.getByRole("dialog", { name: "Share access" });
    await user.click(within(again).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(again).not.toBeInTheDocument());
    expect(controller.navigation.snapshot().attempt.entry.target).toEqual(
      behind,
    );
  } finally {
    release?.();
    t.holdRoster(undefined);
    remove();
    controller.dispose();
    await ctx.fiber.dispose();
  }
});
