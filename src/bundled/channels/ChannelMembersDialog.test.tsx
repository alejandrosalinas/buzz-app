// @vitest-environment jsdom
import { SOLO_LABEL } from "../../features/solo/labels";
import type { Agents } from "../../features/agents/service";
import type { CommunityReader } from "../../features/communities/service";
import { emptySync } from "../../features/communities/known-communities";
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { npubEncode } from "nostr-tools/nip19";
import userEvent from "@testing-library/user-event";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useEffect } from "react";
import type { LiveCallbacks } from "../../features/relay/live";
import { createRelaySession } from "../../features/relay/session";
import type { VerifiedProfileAuthority } from "../../features/relay/verified-profile";
import {
  keypair,
  metadata,
  profile,
  roster,
  signed,
} from "../../features/relay/testing";
import { personKey } from "../../features/search/people-rank";
import {
  pickerText,
  readSearchUsage,
  recordChoice,
  recordVisit,
} from "../../features/search/usage";
import { matchesEvent } from "../../features/relay/projection";
import { eventDto, type RelayEvent } from "../../features/relay/events";
import { PublishRejected } from "../../features/relay/outbox";
import type { AgentLibrary } from "../../features/agents/library";
import { localAgentsFixture } from "../../features/agents/local-testing";
import { SEARCH_DEBOUNCE_MS } from "../../shared/search-debounce";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { profileTarget } from "../../features/profiles/target";
import { ChannelMembersButton } from "./ChannelMembersDialog";
import { Context } from "@deepseek-ai/cordis";
import { ShortcutsService } from "../../features/shortcuts/service";
import { createNavigationController } from "../../features/navigation/controller";
import { createMemoryHistory } from "../../features/navigation/history";
import { registerNavigationShortcuts } from "../../app/shortcuts";
const stops: (() => void)[] = [];
const memberData = () => screen.getByRole("region", { name: "Member list" });
// Vitest globals are disabled; join owned tasks before this file's explicit cleanup.
const tasks: {
  controller: AbortController;
  outcome: Promise<PromiseSettledResult<void>[]>;
}[] = [];
function ownedTask(
  signal: AbortSignal,
  work: (step: <T>(action: () => Promise<T>) => Promise<T>) => Promise<void>,
) {
  const controller = new AbortController();
  const lifetime = AbortSignal.any([signal, controller.signal]);
  const step = async <T,>(action: () => Promise<T>): Promise<T> => {
    lifetime.throwIfAborted();
    const result = await action();
    lifetime.throwIfAborted();
    return result;
  };
  const task = work(step);
  tasks.push({ controller, outcome: Promise.allSettled([task]) });
  return task;
}
// jsdom lacks scrollIntoView; the search highlight keeps its row in view.
beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(async () => {
  // First, so a failed paging test cannot leak its fake clock into the next setup().
  vi.useRealTimers();
  for (const task of tasks) task.controller.abort();
  await Promise.all(tasks.splice(0).map(({ outcome }) => outcome));
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  for (const stop of stops.splice(0)) stop();
});
/** Matches a name whose typed letters are underlined in their own element. */
const nameText = (text: string) => (_: string, element: Element | null) =>
  element?.textContent === text &&
  ![...element.children].some((child) => child.textContent === text);
async function setup(
  type = "stream",
  missingNames = false,
  localAgent = false,
  navigation?: {
    canOpenLink(target: string): boolean;
    onOpenLink(target: string, returnFocus?: HTMLElement): boolean;
  },
  agents?: Agents,
  options: {
    archivedAgent?: boolean;
    extraMembers?: number;
    memberProfiles?: RelayEvent[];
    pendingMemberNames?: Promise<void>;
    channelCreation?: boolean;
    memberWrites?: boolean;
    searchProfiles?: (
      query: string,
      limit: number,
      page: number,
    ) => Promise<RelayEvent[]>;
    communities?: CommunityReader;
    relay?: ReturnType<typeof keypair>;
    verifiedProfiles?: VerifiedProfileAuthority;
    visibility?: "private" | "public";
    joinRole?: "member" | "guest";
  } = {},
) {
  const viewer = keypair(),
    relay = options.relay ?? keypair(),
    person = keypair();
  const agent = {
    pubkey: "ab".repeat(32),
    name: "Fixture agent",
    relayUrl: "wss://relay.example.test",
    owner: viewer.pubkey,
  };
  const control = localAgentsFixture([agent]);
  const id = "11111111-1111-4111-8111-111111111111";
  const target = localAgent ? agent.pubkey : person.pubkey;
  const members = [
    viewer.pubkey,
    ...Array.from({ length: options.extraMembers ?? 0 }, (_, i) =>
      (i + 10000).toString(16).padStart(64, "0"),
    ),
    ...(options.memberProfiles ?? []).map((event) => event.pubkey),
  ];
  let live: LiveCallbacks | undefined;
  let clock = 1700000000;
  let failure = "";
  let applyAddition = true;
  let searchFailure = false;
  let nameRetry: Promise<void> | undefined;
  let rosterRead: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const publish = vi.fn(async (_event: RelayEvent) => {
    if (failure) throw new PublishRejected(failure);
    if (release)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    if (applyAddition)
      members.push(_event.tags.find((tag) => tag[0] === "p")?.[1] ?? target);
    clock++;
  });
  const personProfile = profile(person, { name: "Morgan" });
  const stableEvents = [
    signed(relay, {
      kind: 39000,
      content: "",
      tags: [
        ["d", id],
        ["t", type.includes("solo") ? "stream" : type],
        [options.visibility ?? "private"],
        ...(options.joinRole ? [["join_role", options.joinRole]] : []),
        ["name", "Design"],
        ...(type.includes("solo")
          ? [
              ["t", SOLO_LABEL],
              ["P", type === "solo" ? viewer.pubkey : person.pubkey],
            ]
          : []),
      ],
    }),
    signed(relay, {
      kind: 13535,
      content: "",
      tags: [["-"], ...(options.archivedAgent ? [["p", agent.pubkey]] : [])],
    }),
    ...(options.memberProfiles ?? []),
    profile(viewer, { name: "Carl" }),
    personProfile,
  ];
  const query = vi.fn(async (filters: Parameters<typeof matchesEvent>[1][]) => {
    if (filters.some((filter) => filter.search)) {
      if (searchFailure) throw new Error("Search offline");
      return [personProfile];
    }
    if (
      missingNames &&
      filters.some(
        (filter) =>
          filter.kinds?.includes(0) &&
          filter.authors?.includes(
            options.extraMembers
              ? (members[1] ?? viewer.pubkey)
              : viewer.pubkey,
          ),
      )
    ) {
      await nameRetry;
      throw new Error("Names unavailable");
    }
    if (filters.some((filter) => filter.kinds?.includes(0)))
      await options.pendingMemberNames;
    if (filters.some((filter) => filter.kinds?.includes(39002)))
      await rosterRead;
    return [roster(relay, id, members, clock), ...stableEvents].filter(
      (event) => filters.some((filter) => matchesEvent(event, filter)),
    );
  });
  const readAgentLibrary = vi.fn(
    async (): Promise<AgentLibrary> => ({
      definitions: [],
      identities: [],
    }),
  );
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      archiveAuthority: relay.pubkey,
      scope: "https://relay.example.test",
      media: () => undefined,
      query,
      subscribe: (callbacks) => {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
      ...(options.searchProfiles
        ? { searchProfiles: options.searchProfiles }
        : {}),
      ...(options.verifiedProfiles
        ? { verifiedProfiles: options.verifiedProfiles }
        : {}),
      readAgentLibrary,
      writer: {
        kinds: [
          9,
          ...(options.memberWrites === false ? [] : [9000]),
          ...(options.channelCreation === false ? [] : [9007]),
        ],
        sign: async (template) => signed(viewer, template),
        publish,
      },
    },
    {
      outboxStorage: { load: () => [], save: () => {} },
      agentChoices: control,
    },
  );
  stops.push(owner.dispose);
  owner.session.channels.ensureList();
  await vi.waitFor(
    () => expect(owner.session.channels.list().status).toBe("ready"),
    { interval: vi.isFakeTimers() ? 50 : 1 },
  );
  render(
    <ToastProvider>
      <ChannelMembersButton
        session={owner.session}
        channelId={id}
        communities={options.communities}
        {...navigation}
        {...(agents ? { agents } : {})}
      />
    </ToastProvider>,
  );
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Access" });
  await user.click(trigger);
  if (
    options.pendingMemberNames &&
    !options.extraMembers &&
    !options.memberProfiles
  )
    await screen.findByRole("status", { name: "Loading members" });
  else if (
    options.pendingMemberNames ||
    options.extraMembers ||
    options.memberProfiles
  )
    await within(
      await screen.findByRole("region", { name: "Member list" }),
    ).findAllByRole("listitem");
  else if (missingNames) await screen.findByText(/Some names could not load/);
  else await screen.findByText("Carl (you)");
  return {
    user,
    trigger,
    agent,
    control,
    dispose: owner.dispose,
    publish,
    query,
    readAgentLibrary,
    session: owner.session,
    relay,
    person,
    viewer,
    replaceRoster: (keys: string[]) => {
      members.splice(0, members.length, ...keys);
      live?.receive([roster(relay, id, members, ++clock)]);
    },
    delayRoster: () => {
      applyAddition = false;
    },
    confirmRoster: () => {
      members.push(target);
      clock++;
    },
    removeTarget: () => {
      members.splice(members.indexOf(target), 1);
      clock++;
    },
    fail: (value: string) => {
      failure = value;
    },
    holdRoster: (pending: Promise<void> | undefined) => {
      rosterRead = pending;
    },
    holdNames: (pending: Promise<void>) => {
      nameRetry = pending;
    },
    recoverNames: () => {
      missingNames = false;
    },
    failSearch: (value = true) => {
      searchFailure = value;
    },
    hold: () => {
      release = () => {};
    },
    release: () => release?.(),
    async search() {
      await user.type(
        screen.getByRole("searchbox"),
        localAgent ? "Fixture agent" : "Morgan",
      );
      return screen.findByRole("button", {
        name: localAgent ? /Add Fixture agent/ : /Add Morgan/,
      });
    },
  };
}
it.each(["Saving access…", "Searching…"])(
  "keeps %s outside busy member data during a refresh",
  async (announcement) => {
    const h = await setup("stream", true);
    cleanup();
    const id = "11111111-1111-4111-8111-111111111111";
    let finishRefresh!: () => void;
    let finishOperation!: () => void;
    const refresh = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    const operation = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });
    const save = vi.fn(async () => operation);
    const query = h.query.getMockImplementation();
    if (!query) throw new Error("Missing query fixture");
    h.query.mockImplementation(async (filters) => {
      if (filters.some((filter) => filter.search)) await operation;
      return query(filters);
    });
    render(
      <ToastProvider>
        <ChannelMembersButton
          session={{
            ...h.session,
            channelDetails: {
              available: true,
              load: async () => ({
                channelId: id,
                version: "v1",
                name: "Design",
                description: "",
                visibility: "private",
                joinRole: "member",
                canEdit: true,
              }),
              save,
              check: async () => {},
              snapshot: () => undefined,
              subscribe: () => () => {},
            },
          }}
          channelId={id}
        />
      </ToastProvider>,
    );
    await h.user.click(screen.getByRole("button", { name: "Access" }));
    await screen.findByText(/Some names could not load/);
    await vi.waitFor(() =>
      expect(memberData()).toHaveAttribute("data-refreshing", "false"),
    );
    const nameReads = () =>
      h.query.mock.calls.filter(([filters]) =>
        filters.some(
          (filter) =>
            filter.kinds?.includes(0) &&
            filter.authors?.includes(h.viewer.pubkey),
        ),
      ).length;
    const beforeRefresh = nameReads();
    h.holdNames(refresh);
    try {
      await h.user.click(
        screen.getByRole("button", { name: "Retry member data" }),
      );
      await vi.waitFor(() => expect(nameReads()).toBe(beforeRefresh + 1));
      expect(memberData()).toHaveAttribute("data-refreshing", "true");
      expect(
        within(screen.getByRole("region", { name: "People" })).getByRole(
          "list",
        ),
      ).toHaveAttribute("aria-busy", "true");
      if (announcement === "Saving access…") {
        const access = screen.getByRole("combobox", { name: "General access" });
        await vi.waitFor(() => expect(access).toBeEnabled());
        await h.user.click(access);
        await h.user.click(
          await screen.findByRole("option", { name: "Public" }),
        );
        await h.user.click(
          screen.getByRole("button", { name: "Change access" }),
        );
        await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
      } else {
        await h.user.type(screen.getByRole("searchbox"), "Morgan");
        await vi.waitFor(() =>
          expect(
            h.query.mock.calls.some(([filters]) =>
              filters.some((filter) => filter.search === "Morgan"),
            ),
          ).toBe(true),
        );
      }
      const status = await screen.findByText(announcement);
      expect(status).toHaveAttribute("role", "status");
      expect(status.closest("[aria-busy]")).toBeNull();
    } finally {
      await act(async () => {
        finishRefresh();
        finishOperation();
      });
    }
    await vi.waitFor(() =>
      expect(memberData()).toHaveAttribute("data-refreshing", "false"),
    );
    expect(h.publish).not.toHaveBeenCalled();
  },
);

it("keeps the same focused search input when a cached roster is confirmed", async () => {
  const viewer = keypair(),
    relay = keypair();
  const id = "11111111-1111-4111-8111-111111111111";
  const events = [
    roster(relay, id, [viewer.pubkey]),
    metadata(relay, id, "Cached channel", 1700000000, [
      ["private"],
      ["t", "stream"],
    ]),
    signed(relay, {
      kind: 39001,
      tags: [
        ["d", id],
        ["p", viewer.pubkey, "owner"],
      ],
      content: "",
    }),
    profile(viewer, { name: "Carl" }),
  ];
  let confirm!: () => void;
  const confirmation = new Promise<void>((resolve) => {
    confirm = resolve;
  });
  const publish = vi.fn(async () => {});
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: "https://relay.example.test",
      media: () => undefined,
      query: async (filters) => {
        if (filters.some((filter) => filter.kinds?.includes(39002)))
          await confirmation;
        return events.filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
      },
      channelDetails: {
        sign: async (template) => signed(viewer, template),
        publish,
      },
    },
    {
      prepared: true,
      persistence: {
        readStartup: async () => ({
          discovery: {
            savedAt: Date.now(),
            relayAuthor: relay.pubkey,
            events: events.slice(0, 2),
          },
        }),
        writeStartup: async () => {},
        read: async () => [],
        write: async () => {},
        retain: async () => {},
        remove: async () => {},
        clear: async () => {},
        close() {},
      },
    },
  );
  stops.push(owner.dispose);
  try {
    await owner.restore();
    owner.session.channels.ensureList();
    await vi.waitFor(() =>
      expect(owner.session.channels.get?.(id)?.cached).toBe(true),
    );
    render(
      <ToastProvider>
        <ChannelMembersButton session={owner.session} channelId={id} />
      </ToastProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Access" }));
    const input = screen.getByRole("searchbox");
    await user.type(input, "Mor");
    expect(input).toHaveFocus();
    expect(
      screen.queryByRole("combobox", { name: "General access" }),
    ).toBeNull();
    await act(async () => {
      confirm();
      await confirmation;
    });
    await screen.findByRole("combobox", { name: "General access" });
    expect(owner.session.channels.get?.(id)?.cached).toBeUndefined();
    expect(screen.getByRole("searchbox")).toBe(input);
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Mor");
    expect(
      screen.getByRole("region", { name: "General access" }),
    ).not.toContainElement(input);
    await user.keyboard("gan");
    expect(input).toHaveValue("Morgan");
    expect(publish).not.toHaveBeenCalled();
  } finally {
    confirm();
  }
});

it("offers your agents when you are the only member and adds one without a directory search", async () => {
  const t = await setup();
  const yours = await screen.findByRole("region", {
    name: "Your agents",
  });
  const add = within(yours).getByRole("button", { name: /^Add Fixture agent/ });
  expect(screen.getByRole("searchbox")).toHaveValue("");
  await t.user.click(add);
  await screen.findByText("Fixture agent is in the channel.");
  expect(
    screen.queryByRole("button", { name: /^Add Fixture agent/ }),
  ).toBeNull();
  expect(
    t.query.mock.calls
      .flatMap(([filters]) => filters)
      .filter((filter) => filter.search),
  ).toEqual([]);
});

it.each([false, true])(
  "shows idle suggestions only while the viewer is alone (second member is an agent: %s)",
  async (localAgent) => {
    const t = await setup("stream", false, localAgent);
    await act(async () =>
      t.control.set({
        agents: [
          t.agent,
          { ...t.agent, pubkey: keypair().pubkey, name: "Fixture helper" },
          {
            ...t.agent,
            pubkey: keypair().pubkey,
            name: localAgent ? t.agent.name : "Morgan",
          },
        ],
      }),
    );
    expect(
      screen.getByRole("button", { name: "Retry member data" }),
    ).toBeVisible();
    const settled = () =>
      vi.waitFor(() =>
        expect(memberData()).toHaveAttribute("data-refreshing", "false"),
      );
    const suggestions = () =>
      screen.queryByRole("region", { name: "Not in this channel" });
    const search = screen.getByRole("searchbox");
    await settled();
    expect(suggestions()).toBeVisible();

    t.confirmRoster();
    await t.user.click(
      screen.getByRole("button", { name: "Retry member data" }),
    );
    await settled();
    const roster = () =>
      screen.getByRole("region", {
        name: localAgent ? "Agents" : "People",
      });
    expect(
      within(roster()).getByText(localAgent ? "Fixture agent" : "Morgan"),
    ).toBeVisible();
    expect(suggestions()).toBeNull();
    expect(within(roster()).queryByText(/^npub…/)).toBeNull();

    await t.user.type(search, "Fixture");
    await screen.findByRole("button", { name: /^Add Fixture helper/ });
    expect(suggestions()).toBeVisible();
    if (localAgent) expect(within(roster()).getByText(/^npub…/)).toBeVisible();
    await t.user.clear(search);
    await settled();
    expect(suggestions()).toBeNull();
    expect(within(roster()).queryByText(/^npub…/)).toBeNull();
    await t.user.type(search, "   ");
    expect(suggestions()).toBeNull();
    await t.user.clear(search);

    t.removeTarget();
    await t.user.click(
      screen.getByRole("button", { name: "Retry member data" }),
    );
    await settled();
    expect(suggestions()).toBeVisible();
    expect(
      screen.getByRole("button", { name: /^Add Fixture helper/ }),
    ).toBeVisible();
    expect(search).toHaveValue("");
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it("explains imported agents with the current community's badge and nested popover", async () => {
  const snapshot: ReturnType<CommunityReader["snapshot"]> = {
    status: "ready",
    relayAvailable: true,
    profile: { name: "Carl", picture: "" },
    memberships: [
      {
        id: "https://relay.example.test",
        name: "Fixture community",
        publishedIcon: "https://images.example/community.png",
      },
    ],
    selected: "https://other.example.test",
    sync: emptySync(),
  };
  const t = await setup("stream", false, false, undefined, undefined, {
    communities: { snapshot: () => snapshot, subscribe: () => () => {} },
  });
  const group = await screen.findByRole("region", { name: "Your agents" });
  const badge = within(group).getByRole("button", {
    name: "Agents scope: Fixture community",
  });
  expect(badge.querySelector("img")).toHaveAttribute(
    "src",
    "https://images.example/community.png",
  );
  expect(screen.queryByRole("dialog", { name: "Agents scope" })).toBeNull();
  await t.user.click(badge);
  expect(
    await screen.findByRole("dialog", { name: "Agents scope" }),
  ).toHaveTextContent(
    "These are your agents imported into this community on this device.",
  );
  await t.user.keyboard("{Escape}");
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Agents scope" })).toBeNull(),
  );
  expect(screen.getByRole("dialog", { name: "Manage members" })).toBeVisible();
  // A locally opened Members is not a navigation visit: Back stays blocked.
  const members = screen.getByRole("dialog", { name: "Manage members" });
  expect(members).not.toHaveAttribute("data-navigation-visit");
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const shortcuts = new ShortcutsService(ctx, window);
  const controller = createNavigationController(createMemoryHistory());
  const remove = registerNavigationShortcuts(shortcuts, controller.navigation);
  try {
    const behind = { version: 1, kind: "settings" } as const;
    void controller.navigation.open({ version: 1, kind: "home" });
    void controller.navigation.open(behind);
    await vi.waitFor(() =>
      expect(controller.navigation.snapshot().canGoBack).toBe(true),
    );
    fireEvent.keyDown(members, { key: "[", ctrlKey: true });
    await act(async () => {});
    expect(controller.navigation.snapshot().attempt.entry.target).toEqual(
      behind,
    );
  } finally {
    remove();
    controller.dispose();
    await ctx.fiber.dispose();
  }
  await vi.waitFor(() => expect(badge).toHaveFocus());
  expect(t.publish).not.toHaveBeenCalled();
});

it("keeps setup guidance behind its information popover", async () => {
  const t = await setup();
  t.readAgentLibrary.mockResolvedValue({
    definitions: [],
    identities: [{ pubkey: keypair().pubkey, name: "Fixture old agent" }],
  });
  await act(async () => {
    await t.session.agentChoices.refresh();
  });
  await t.user.type(screen.getByRole("searchbox"), "Fixture");
  const group = await screen.findByRole("region", {
    name: "Your other agents",
  });
  const hint = "Your agents from other devices or earlier setups.";
  expect(within(group).queryByText(hint)).toBeNull();
  const info = within(group).getByRole("button", {
    name: "About your other agents",
  });
  await t.user.click(info);
  expect(
    await screen.findByRole("dialog", { name: "About your other agents" }),
  ).toHaveTextContent(hint);
  await t.user.keyboard("{Escape}");
  await vi.waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "About your other agents" }),
    ).toBeNull(),
  );
  expect(screen.getByRole("dialog", { name: "Manage members" })).toBeVisible();
  await vi.waitFor(() => expect(info).toHaveFocus());
  expect(t.publish).not.toHaveBeenCalled();
});

it("distinguishes invitation and roster People regions while retaining the caption", async () => {
  const t = await setup();
  expect(
    screen.getByRole("button", { name: "Retry member data" }),
  ).toBeVisible();
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  t.confirmRoster();
  await t.user.click(screen.getByRole("button", { name: "Retry member data" }));
  await screen.findByText("Morgan");
  const guest = profile(keypair(), { name: "Morgan Guest" });
  const query = t.query.getMockImplementation();
  if (!query) throw new Error("Missing query fixture");
  t.query.mockImplementation(async (filters) =>
    filters.some((filter) => filter.search) ? [guest] : query(filters),
  );
  await t.user.type(screen.getByRole("searchbox"), "Morgan");
  const invitations = await screen.findByRole("region", {
    name: "People not in this channel",
  });
  const roster = screen.getByRole("region", { name: "People" });
  expect(within(roster).getByText(nameText("Morgan"))).toBeVisible();
  expect(
    within(invitations).getByRole("heading", { name: "People" }),
  ).toBeVisible();
  expect(
    within(invitations).getByRole("button", { name: /^Add Morgan Guest/ }),
  ).toBeVisible();
  expect(t.publish).not.toHaveBeenCalled();
});

it("orders matches by client agents, people, other agents, then your non-client agents", async () => {
  const t = await setup();
  const other = profile(keypair(), { name: "Fixture", is_agent: true });
  const person = profile(t.person, { name: "Fixture person" });
  const saved = { pubkey: keypair().pubkey, name: "Fixture saved" };
  t.readAgentLibrary.mockResolvedValue({
    definitions: [],
    identities: [saved],
  });
  await act(async () => {
    await t.session.agentChoices.refresh();
  });
  const query = t.query.getMockImplementation();
  if (!query) throw new Error("Missing query fixture");
  t.query.mockImplementation(async (filters) =>
    filters.some((filter) => filter.search) ? [other, person] : query(filters),
  );
  recordChoice(
    t.session.scope,
    pickerText("channel-members", "fixture"),
    personKey(saved.pubkey),
  );
  await t.user.type(screen.getByRole("searchbox"), "Fixture");
  await screen.findByRole("button", { name: /^Add Fixture person/ });
  const results = screen.getByRole("region", { name: "Not in this channel" });
  const rows = within(results).getAllByRole("button", { name: /^Add / });
  const sections = [
    "Your agents",
    "People not in this channel",
    "Other agents",
    "Your other agents",
  ];
  expect(rows).toHaveLength(4);
  expect(
    sections.map((name) =>
      within(within(results).getByRole("region", { name })).getByRole(
        "button",
        { name: /^Add / },
      ),
    ),
  ).toEqual(rows);
  expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
    expect.stringMatching(/^Add Fixture agent/),
    expect.stringMatching(/^Add Fixture person/),
    expect.stringMatching(/^Add Fixture \(/),
    expect.stringMatching(/^Add Fixture saved/),
  ]);
  expect(
    screen.queryByRole("checkbox", { name: "Include other agents" }),
  ).toBeNull();
  expect(t.publish).not.toHaveBeenCalled();
});

async function relationshipInvitations() {
  const t = await setup();
  const people = [
    { ...keypair(), name: "Sam A stranger" },
    { ...keypair(), name: "Sam B shared" },
    { ...keypair(), name: "Sam C group" },
    { ...keypair(), name: "Sam D direct" },
    { ...keypair(), name: "Sam E direct" },
    { ...keypair(), name: "Sam" },
  ];
  const key = (index: number) => people[index]?.pubkey ?? "";
  const directId = "22222222-2222-4222-8222-222222222222";
  const otherDirectId = "33333333-3333-4333-8333-333333333333";
  const groupId = "44444444-4444-4444-8444-444444444444";
  const sharedId = "55555555-5555-4555-8555-555555555555";
  const events = [
    metadata(t.relay, directId, "Direct", undefined, [["t", "dm"]]),
    roster(t.relay, directId, [t.viewer.pubkey, key(3)]),
    metadata(t.relay, otherDirectId, "Other direct", undefined, [["t", "dm"]]),
    roster(t.relay, otherDirectId, [t.viewer.pubkey, key(4)]),
    metadata(t.relay, groupId, "Group", undefined, [["t", "dm"]]),
    roster(t.relay, groupId, [t.viewer.pubkey, key(2), t.person.pubkey]),
    metadata(t.relay, sharedId, "Shared"),
    roster(t.relay, sharedId, [t.viewer.pubkey, key(1)]),
  ];
  const query = t.query.getMockImplementation();
  if (!query) throw new Error("Missing query fixture");
  t.query.mockImplementation(async (filters) =>
    filters.some((filter) => filter.search)
      ? people.map((person) => profile(person, { name: person.name }))
      : [
          ...(await query(filters)),
          ...events.filter((event) =>
            filters.some((filter) => matchesEvent(event, filter)),
          ),
        ],
  );
  await act(async () => t.session.channels.refreshList?.());
  await vi.waitFor(() =>
    expect(
      t.session.channels
        .list()
        .channels.find((channel) => channel.id === directId)?.participants,
    ).toEqual([key(3)]),
  );
  const rows = () =>
    within(
      within(
        screen.getByRole("region", { name: "Not in this channel" }),
      ).getByRole("region", { name: "People not in this channel" }),
    )
      .getAllByRole("button", { name: /^Add / })
      .map((row) => row.getAttribute("aria-label"));
  return { ...t, people, key, directId, otherDirectId, rows };
}

it("orders empty-channel invitations by shared relationships and usage before the four-row limit", async () => {
  const t = await setup();
  await t.user.click(screen.getByRole("button", { name: "Done" }));
  const agents = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"].map(
    (name) => ({ ...t.agent, pubkey: keypair().pubkey, name }),
  );
  const directId = "22222222-2222-4222-8222-222222222222";
  const direct = agents[5]?.pubkey ?? "";
  const used = agents[4]?.pubkey ?? "";
  const events = [
    metadata(t.relay, directId, "Direct", undefined, [["t", "dm"]]),
    roster(t.relay, directId, [t.viewer.pubkey, direct]),
  ];
  const query = t.query.getMockImplementation();
  if (!query) throw new Error("Missing query fixture");
  t.query.mockImplementation(async (filters) => [
    ...(await query(filters)),
    ...events.filter((event) =>
      filters.some((filter) => matchesEvent(event, filter)),
    ),
  ]);
  await act(async () => {
    t.control.set({ agents });
    await t.session.channels.refreshList?.();
  });
  await vi.waitFor(() =>
    expect(
      t.session.channels
        .list()
        .channels.find((channel) => channel.id === directId)?.participants,
    ).toEqual([direct]),
  );
  recordChoice(t.session.scope, "", personKey(used));
  await t.user.click(t.trigger);
  const group = await screen.findByRole("region", { name: "Your agents" });
  await vi.waitFor(() =>
    expect(
      within(group)
        .getAllByRole("button", { name: /^Add / })
        .map((row) => row.getAttribute("aria-label")),
    ).toEqual([
      expect.stringMatching(/^Add Foxtrot/),
      expect.stringMatching(/^Add Echo/),
      expect.stringMatching(/^Add Alpha/),
      expect.stringMatching(/^Add Bravo/),
    ]),
  );
  expect(screen.getByRole("searchbox")).toHaveValue("");
  expect(
    within(group).getByRole("button", { name: "Show more" }),
  ).toBeVisible();
  expect(t.publish).not.toHaveBeenCalled();
});

it("uses shared relationship bands inside People while exact names stay first", async () => {
  const t = await relationshipInvitations();
  await t.user.type(screen.getByRole("searchbox"), "Sa");
  await screen.findByRole("button", { name: /^Add Sam D direct/ });
  expect(t.rows()).toEqual([
    expect.stringMatching(/^Add Sam D direct/),
    expect.stringMatching(/^Add Sam E direct/),
    expect.stringMatching(/^Add Sam C group/),
    expect.stringMatching(/^Add Sam B shared/),
  ]);
  await t.user.type(screen.getByRole("searchbox"), "m");
  await screen.findByRole("button", { name: /^Add Sam \(/ });
  expect(t.rows()).toEqual([
    expect.stringMatching(/^Add Sam \(/),
    expect.stringMatching(/^Add Sam D direct/),
    expect.stringMatching(/^Add Sam E direct/),
    expect.stringMatching(/^Add Sam C group/),
  ]);
});

it("uses shared DM visit usage and picker-specific earlier choices", async () => {
  const t = await relationshipInvitations();
  recordVisit(t.session.scope, `channel:${t.otherDirectId}`);
  recordChoice(t.session.scope, pickerText("dm", "sa"), personKey(t.key(0)));
  await t.user.type(screen.getByRole("searchbox"), "Sa");
  await screen.findByRole("button", { name: /^Add Sam E direct/ });
  expect(t.rows()[0]).toMatch(/^Add Sam E direct/);
  recordChoice(
    t.session.scope,
    pickerText("channel-members", "sam"),
    personKey(t.key(0)),
  );
  await t.user.type(screen.getByRole("searchbox"), "m ");
  await screen.findByRole("button", { name: /^Add Sam \(/ });
  // Exact still leads; the earlier Add choice precedes the relationship bands.
  expect(t.rows()).toEqual([
    expect.stringMatching(/^Add Sam \(/),
    expect.stringMatching(/^Add Sam A stranger/),
    expect.stringMatching(/^Add Sam E direct/),
    expect.stringMatching(/^Add Sam D direct/),
  ]);
});

it("remembers successful channel additions without learning from failed writes", async () => {
  const t = await setup();
  t.fail("Only the owner can add this agent");
  const add = await t.search();
  await t.user.click(add);
  await screen.findByText(/Only the owner can add this agent/);
  const typed = pickerText("channel-members", "morgan");
  const key = personKey(t.person.pubkey);
  expect(
    readSearchUsage(t.session.scope).pick(typed, new Set([key])),
  ).toBeUndefined();
  t.fail("");
  await t.user.click(screen.getByRole("button", { name: /^Retry adding / }));
  await screen.findByText("Morgan is in the channel.");
  expect(readSearchUsage(t.session.scope).pick(typed, new Set([key]))).toBe(
    key,
  );
});

it("keeps public-key lookup results whose names do not match the key text", async () => {
  const t = await setup();
  for (const value of [t.person.pubkey, npubEncode(t.person.pubkey)]) {
    fireEvent.change(screen.getByRole("searchbox"), { target: { value } });
    const add = await screen.findByRole("button", { name: /^Add Morgan/ });
    expect(add).toBeEnabled();
    expect(
      within(
        screen.getByRole("region", { name: "Not in this channel" }),
      ).getAllByRole("button", { name: /^Add / }),
    ).toEqual([add]);
  }
  expect(t.publish).not.toHaveBeenCalled();
});

it("finds a local agent the relay has no profile for by a nostr: npub", async () => {
  const t = await setup("stream", false, true);
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: `nostr:${npubEncode(t.agent.pubkey)}` },
  });
  expect(
    await screen.findByRole("button", { name: /^Add Fixture agent/ }),
  ).toBeEnabled();
});

it("ranks a matching username with the shared people matcher", async () => {
  const t = await setup();
  const handle = profile(keypair(), { display_name: "Alpha", name: "robin" });
  const named = profile(t.person, { name: "Robin Person" });
  const query = t.query.getMockImplementation();
  if (!query) throw new Error("Missing query fixture");
  t.query.mockImplementation(async (filters) =>
    filters.some((filter) => filter.search) ? [named, handle] : query(filters),
  );
  await t.user.type(screen.getByRole("searchbox"), "robin");
  await screen.findByRole("button", { name: /^Add Alpha/ });
  const rows = within(
    screen.getByRole("region", { name: "Not in this channel" }),
  ).getAllByRole("button", { name: /^Add / });
  expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
    expect.stringMatching(/^Add Alpha/),
    expect.stringMatching(/^Add Robin Person/),
  ]);
});

it("ranks local usernames and hidden agent names through the shared matcher", async () => {
  const t = await setup();
  const exact = keypair(),
    word = keypair(),
    shown = keypair(),
    handle = keypair();
  const profiles = [
    profile(word, { name: "Helper Alpha", is_agent: true }),
    profile(exact, { name: "Helper Zed", is_agent: true }),
    profile(shown, { name: "Robin Visible", is_agent: true }),
    profile(handle, {
      display_name: "Handle Agent",
      name: "robin",
      is_agent: true,
    }),
  ];
  const query = t.query.getMockImplementation();
  if (!query) throw new Error("Missing query fixture");
  t.query.mockImplementation(async (filters) =>
    filters.some((filter) => filter.search)
      ? []
      : [
          ...(await query(filters)),
          ...profiles.filter((event) =>
            filters.some((filter) => matchesEvent(event, filter)),
          ),
        ],
  );
  await act(async () => {
    t.control.set({
      agents: [
        { ...t.agent, pubkey: word.pubkey, name: "Red Robin" },
        { ...t.agent, pubkey: exact.pubkey, name: "Robin" },
        { ...t.agent, pubkey: shown.pubkey, name: "Robin Visible" },
        { ...t.agent, pubkey: handle.pubkey, name: "Local Handle" },
      ],
    });
    await t.session.profiles.ensure(
      [word.pubkey, exact.pubkey, shown.pubkey, handle.pubkey],
      "foreground",
    );
  });
  await t.user.type(screen.getByRole("searchbox"), "robin");
  const yours = await screen.findByRole("region", { name: "Your agents" });
  const rows = within(yours).getAllByRole("button", { name: /^Add / });
  expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
    expect.stringMatching(/^Add Handle Agent/),
    expect.stringMatching(/^Add Robin Visible/),
    expect.stringMatching(/^Add Helper Zed/),
    expect.stringMatching(/^Add Helper Alpha/),
  ]);
});

it("keeps relay-only matches after shared-ranked names without duplicating rows", async () => {
  const t = await setup();
  const relayOnly = profile(keypair(), { name: "A different name" });
  const named = profile(t.person, { name: "Robin" });
  const query = t.query.getMockImplementation();
  if (!query) throw new Error("Missing query fixture");
  t.query.mockImplementation(async (filters) =>
    filters.some((filter) => filter.search)
      ? [relayOnly, named]
      : query(filters),
  );
  await t.user.type(screen.getByRole("searchbox"), "robin");
  await screen.findByRole("button", { name: /^Add Robin/ });
  const rows = within(
    screen.getByRole("region", { name: "Not in this channel" }),
  ).getAllByRole("button", { name: /^Add / });
  expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
    expect.stringMatching(/^Add Robin/),
    expect.stringMatching(/^Add A different name/),
  ]);
});

it.each(["name", "npub"] as const)(
  "finds a verified person who has no kind:0 by their verified %s and adds them",
  async (by) => {
    const relay = keypair(),
      gabi = keypair();
    const head = signed(relay, {
      kind: 30382,
      created_at: 1_000_000,
      content: "",
      tags: [
        ["d", gabi.pubkey],
        ["p", gabi.pubkey],
        ["active", "true"],
        ["display_name", "glilienfeld"],
        ["username", "glilienfeld"],
        ["full_name", "Gabi Lilienfeld"],
        ["issuer_label", "Example"],
        ["verified_at", "1000000"],
      ],
    });
    const t = await setup("stream", false, false, undefined, undefined, {
      relay,
      searchProfiles: async () => [eventDto(head)],
      verifiedProfiles: {
        pubkey: relay.pubkey,
        multipleIssuers: false,
        searchable: true,
      },
    });
    // A pasted key reads no kind:0; the verified name comes from a head read.
    const query = t.query.getMockImplementation();
    if (!query) throw new Error("Missing query fixture");
    t.query.mockImplementation(async (filters) =>
      filters.some((filter) => filter.kinds?.includes(30382))
        ? [eventDto(head)]
        : query(filters),
    );
    await t.user.type(
      screen.getByRole("searchbox"),
      by === "name" ? "gabi" : npubEncode(gabi.pubkey),
    );
    await t.user.click(
      await screen.findByRole("button", { name: /^Add glilienfeld/ }),
    );
    await vi.waitFor(() =>
      expect(
        t.publish.mock.calls.some(([event]) =>
          event.tags.some((tag) => tag[0] === "p" && tag[1] === gabi.pubkey),
        ),
      ).toBe(true),
    );
  },
);

it("names a pasted key once a later search returns its new verified head", async () => {
  const relay = keypair(),
    gabi = keypair();
  const head = signed(relay, {
    kind: 30382,
    created_at: 1_000_000,
    content: "",
    tags: [
      ["d", gabi.pubkey],
      ["p", gabi.pubkey],
      ["active", "true"],
      ["display_name", "glilienfeld"],
      ["username", "glilienfeld"],
      ["full_name", "Gabi Lilienfeld"],
      ["issuer_label", "Example"],
      ["verified_at", "1000000"],
    ],
  });
  // Neither a kind:0 nor a head exists yet; the head is published later.
  let published = false;
  const t = await setup("stream", false, false, undefined, undefined, {
    relay,
    searchProfiles: async () => (published ? [eventDto(head)] : []),
    verifiedProfiles: {
      pubkey: relay.pubkey,
      multipleIssuers: false,
      searchable: true,
    },
  });
  const query = t.query.getMockImplementation();
  if (!query) throw new Error("Missing query fixture");
  t.query.mockImplementation(async (filters) =>
    filters.some((filter) => filter.kinds?.includes(30382))
      ? published
        ? [eventDto(head)]
        : []
      : query(filters),
  );
  const search = screen.getByRole("searchbox");
  await t.user.type(search, npubEncode(gabi.pubkey));
  // The missing-head lookup finishes: the row keeps its key label.
  const label = new RegExp(`^Add ${gabi.pubkey.slice(0, 10)}`);
  await screen.findByRole("button", { name: label });
  await vi.waitFor(() =>
    expect(
      t.query.mock.calls.some(([filters]) =>
        filters.some(
          (filter) =>
            filter.kinds?.includes(30382) &&
            filter["#d"]?.includes(gabi.pubkey),
        ),
      ),
    ).toBe(true),
  );
  published = true;
  await t.user.clear(search);
  await t.user.type(search, "gabi");
  await t.user.click(
    await screen.findByRole("button", { name: /^Add glilienfeld/ }),
  );
  await vi.waitFor(() =>
    expect(
      t.publish.mock.calls.some(([event]) =>
        event.tags.some((tag) => tag[0] === "p" && tag[1] === gabi.pubkey),
      ),
    ).toBe(true),
  );
});

it("starts every invitation group at four and expands only the selected group", async () => {
  const t = await setup();
  const client = Array.from({ length: 5 }, (_, index) => ({
    ...t.agent,
    pubkey: keypair().pubkey,
    name: `Helper client ${index}`,
  }));
  const saved = Array.from({ length: 5 }, (_, index) => ({
    pubkey: keypair().pubkey,
    name: `Helper saved ${index}`,
  }));
  const people = Array.from({ length: 5 }, (_, index) =>
    profile(keypair(), { name: `Helper person ${index}` }),
  );
  const other = Array.from({ length: 5 }, (_, index) =>
    profile(keypair(), { name: `Helper other ${index}`, is_agent: true }),
  );
  t.readAgentLibrary.mockResolvedValue({ definitions: [], identities: saved });
  await act(async () => {
    t.control.set({ agents: client });
    await t.session.agentChoices.refresh();
  });
  const query = t.query.getMockImplementation();
  if (!query) throw new Error("Missing query fixture");
  t.query.mockImplementation(async (filters) =>
    filters.some((filter) => filter.search)
      ? [...other, ...people]
      : query(filters),
  );
  const groups = [
    "Your agents",
    "People not in this channel",
    "Other agents",
    "Your other agents",
  ];
  const rows = (name: string) =>
    within(screen.getByRole("region", { name })).getAllByRole("button", {
      name: /^Add /,
    });
  expect(rows(groups[0] ?? "")).toHaveLength(4);
  await t.user.type(screen.getByRole("searchbox"), "Helper");
  await screen.findByRole("button", { name: /^Add Helper person 0/ });
  for (const name of groups) {
    expect(rows(name)).toHaveLength(4);
    expect(
      within(screen.getByRole("region", { name })).getByRole("button", {
        name: "Show more",
      }),
    ).toBeVisible();
  }
  await t.user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
  expect(
    screen
      .getByRole("region", { name: "Not in this channel" })
      .querySelector("[data-highlighted]"),
  ).toContainElement(rows("People not in this channel")[0] ?? null);
  await t.user.click(
    within(
      screen.getByRole("region", { name: "People not in this channel" }),
    ).getByRole("button", {
      name: "Show more",
    }),
  );
  expect(rows("People not in this channel")).toHaveLength(5);
  expect(
    within(
      screen.getByRole("region", { name: "People not in this channel" }),
    ).queryByRole("button", { name: "Show more" }),
  ).toBeNull();
  for (const name of groups.filter(
    (name) => name !== "People not in this channel",
  ))
    expect(rows(name)).toHaveLength(4);
  expect(t.publish).not.toHaveBeenCalled();
});

it("keeps library-only agents out of the default list and the client group", async () => {
  const t = await setup();
  const old = profile(keypair(), { name: "Fixture old agent", is_agent: true });
  t.readAgentLibrary.mockResolvedValue({
    definitions: [],
    identities: [t.agent, { pubkey: old.pubkey, name: "Fixture old agent" }],
  });
  await act(async () => {
    await t.session.agentChoices.refresh();
  });
  const yours = screen.getByRole("region", {
    name: "Your agents",
  });
  expect(within(yours).getAllByRole("button", { name: /^Add / })).toHaveLength(
    1,
  );
  expect(
    screen.queryByRole("button", { name: /^Add Fixture old agent/ }),
  ).toBeNull();
  const query = t.query.getMockImplementation();
  if (!query) throw new Error("Missing query fixture");
  t.query.mockImplementation(async (filters) =>
    filters.some((filter) => filter.search) ? [old] : query(filters),
  );
  await t.user.type(screen.getByRole("searchbox"), "Fixture");
  await within(
    await screen.findByRole("region", { name: "Your other agents" }),
  ).findByRole("button", { name: /^Add Fixture old agent/ });
  expect(within(yours).getAllByRole("button", { name: /^Add / })).toHaveLength(
    1,
  );
  await t.user.clear(screen.getByRole("searchbox"));
  await act(async () => t.control.set({ agents: [] }));
  expect(screen.queryByRole("region", { name: "Your agents" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Add Fixture/ })).toBeNull();
  expect(t.publish).not.toHaveBeenCalled();
});

it("does not promote saved agents after a client inventory failure and recovers", async () => {
  const t = await setup();
  t.readAgentLibrary.mockResolvedValue({
    definitions: [],
    identities: [t.agent],
  });
  await act(async () => {
    await t.session.agentChoices.refresh();
    t.control.set({ status: "error", error: "Client inventory offline" });
  });
  await screen.findByText("Some agents could not load.");
  expect(screen.queryByRole("region", { name: "Your agents" })).toBeNull();
  await act(async () => t.control.set({ status: "ready" }));
  expect(
    within(screen.getByRole("region", { name: "Your agents" })).getByRole(
      "button",
      { name: /^Add Fixture agent/ },
    ),
  ).toBeVisible();
  expect(screen.queryByText("Some agents could not load.")).toBeNull();
});

it("keeps archived agents out of the default invitations", async () => {
  const t = await setup("stream", false, true, undefined, undefined, {
    archivedAgent: true,
  });
  await vi.waitFor(() =>
    expect(t.session.archives.snapshot().status).toBe("ready"),
  );
  expect(screen.queryByRole("region", { name: "Your agents" })).toBeNull();
  await t.user.type(screen.getByRole("searchbox"), "Fixture");
  await vi.waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Retry member data" }),
    ).toHaveAttribute("aria-busy", "false"),
  );
  expect(
    screen.queryByRole("button", { name: /^Add Fixture agent/ }),
  ).toBeNull();
});

it("searches outside the roster, prevents double submission, and moves confirmed additions into Members", async () => {
  const t = await setup();
  const add = await t.search();
  t.hold();
  await t.user.click(add);
  await vi.waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
  expect(add).toHaveAttribute("aria-disabled", "true");
  await t.user.click(add);
  expect(t.publish).toHaveBeenCalledOnce();
  await act(async () => t.release());
  await screen.findByText("Morgan is in the channel.");
  expect(
    screen.queryByRole("button", { name: /Add Morgan/ }),
  ).not.toBeInTheDocument();
  expect(t.session.channels.list().channels[0]?.members).toContain(
    t.person.pubkey,
  );
});
it("sends a relay member search only from two typed characters", async () => {
  const t = await setup();
  const searches = () =>
    t.query.mock.calls.filter(([filters]) =>
      filters.some((filter) => filter.search),
    );
  // user-event awaits a real setTimeout(0), so these steps drive fireEvent.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const input = screen.getByRole("searchbox");
  fireEvent.change(input, { target: { value: "M" } });
  await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  expect(searches()).toHaveLength(0);
  // No search ran, so the dialog asks for more text rather than reporting none.
  expect(
    screen.getByText("Type at least 2 characters to search people."),
  ).toBeVisible();
  expect(screen.queryByText(/^No other matching/)).toBeNull();
  fireEvent.change(input, { target: { value: "Mo" } });
  await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  expect(searches()).toHaveLength(1);
});
it("highlights the first person not in the channel so Enter adds them once", async () => {
  const t = await setup();
  const add = await t.search();
  const input = screen.getByRole("searchbox");
  const row = add.closest("[data-highlighted]");
  expect(row).not.toBeNull();
  expect(row?.querySelector("mark")).toBeNull();
  expect(screen.getByText("Morgan. Press Enter to add.")).toHaveAttribute(
    "role",
    "status",
  );
  t.hold();
  await t.user.keyboard("{Enter}");
  await vi.waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
  await t.user.keyboard("{Enter}");
  expect(t.publish).toHaveBeenCalledOnce();
  await act(async () => t.release());
  await screen.findByText("Morgan is in the channel.");
  expect(input).toHaveFocus();
});
it("ranks a matching agent of yours by name and keeps the highlight on its row as it arrives", async () => {
  const t = await setup();
  const agent = { pubkey: keypair().pubkey, name: "Mor" };
  await t.user.type(screen.getByRole("searchbox"), "Mor");
  const morgan = await screen.findByRole("button", { name: /^Add Morgan/ });
  const highlighted = () =>
    screen
      .getByRole("region", { name: "Not in this channel" })
      .querySelector("[data-highlighted]");
  expect(highlighted()).toContainElement(morgan);
  await act(async () => {
    t.control.set({ agents: [{ ...t.agent, ...agent }] });
  });
  const rows = within(
    screen.getByRole("region", { name: "Not in this channel" }),
  ).getAllByRole("button", { name: /^Add / });
  expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
    expect.stringMatching(/^Add Mor \(/),
    expect.stringMatching(/^Add Morgan \(/),
  ]);
  expect(highlighted()).toContainElement(morgan);
  await t.user.keyboard("{ArrowUp}");
  expect(highlighted()).toContainElement(rows[0] ?? null);
  expect(t.publish).not.toHaveBeenCalled();
});
it("shows the real rejection and retries without discarding the query", async () => {
  const t = await setup();
  t.fail("Only the owner can add this agent");
  await t.user.click(await t.search());
  await screen.findByText(/Only the owner/);
  expect(screen.getByRole("searchbox")).toHaveValue("Morgan");
  t.fail("");
  await t.user.click(screen.getByRole("button", { name: /^Retry adding / }));
  await screen.findByText("Morgan is in the channel.");
});
it("DMs are view-only and never search outside their members", async () => {
  const t = await setup("dm");
  await t.user.type(screen.getByRole("searchbox"), "Morgan");
  expect(
    screen.getByText("DM membership cannot be changed here."),
  ).toBeVisible();
  expect(
    screen.queryByRole("region", { name: "Not in this channel" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Retry member data" }),
  ).toBeVisible();
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  await t.user.click(screen.getByRole("button", { name: "Retry member data" }));
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  expect(
    t.query.mock.calls.some(([filters]) =>
      filters.some((filter) => filter.search),
    ),
  ).toBe(false);
});
it("Escape closes the dialog and restores focus to its header button", async () => {
  const t = await setup();
  // Visible content can precede Base UI's queued initial-focus handoff.
  await vi.waitFor(() => expect(screen.getByRole("searchbox")).toHaveFocus());
  await t.user.keyboard("{Escape}");
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("button", { name: "Access" })).toHaveFocus();
});
it("failed directory searches recover through the shared refresh, not a false empty result", async () => {
  const t = await setup();
  t.failSearch();
  await t.user.type(screen.getByRole("searchbox"), "Morgan");
  const section = screen.getByRole("region", { name: "Not in this channel" });
  await within(section).findByText("Search offline");
  expect(
    within(section).queryByText("No other matching people or agents."),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Retry member data" }),
  ).toBeVisible();
  t.failSearch(false);
  expect(
    screen.getByRole("button", { name: "Retry member data" }),
  ).toBeVisible();
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  await t.user.click(screen.getByRole("button", { name: "Retry member data" }));
  await within(section).findByRole("button", { name: /Add Morgan/ });
  expect(screen.getByRole("searchbox")).toHaveValue("Morgan");
  expect(screen.getByRole("searchbox")).toHaveFocus();
  expect(within(section).queryByText("Search offline")).not.toBeInTheDocument();
});

it.each([
  ["npub", (pubkey: string) => npubEncode(pubkey)],
  ["nostr: npub", (pubkey: string) => `nostr:${npubEncode(pubkey)}`],
])("finds an existing member by their %s", async (_case, typed) => {
  const t = await setup("dm");
  await t.user.type(screen.getByRole("searchbox"), typed(t.viewer.pubkey));
  expect(screen.getByText("Carl (you)")).toBeVisible();
});

it("optional member-name failure does not block a verified addition", async () => {
  const t = await setup("stream", true);
  const add = await t.search();
  expect(add).toBeEnabled();
  await t.user.click(add);
  await screen.findByText("Morgan is in the channel.");
  expect(t.publish).toHaveBeenCalledOnce();
});

it.each(["pending", "failed"])(
  "shared refresh retries missing names without blocking verified additions while names are %s",
  async (state) => {
    const t = await setup("stream", true);
    await t.search();
    expect(
      screen.getByRole("button", { name: "Retry member data" }),
    ).toBeVisible();
    await vi.waitFor(() =>
      expect(memberData()).toHaveAttribute("data-refreshing", "false"),
    );
    const nameReads = () =>
      t.query.mock.calls.filter(([filters]) =>
        filters.some(
          (filter) =>
            filter.kinds?.includes(0) &&
            filter.authors?.includes(t.viewer.pubkey),
        ),
      ).length;
    const beforeNames = nameReads();
    let release!: () => void;
    t.holdNames(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    try {
      await t.user.click(
        screen.getByRole("button", { name: "Retry member data" }),
      );
      await vi.waitFor(() => expect(nameReads()).toBe(beforeNames + 1));
      const add = await screen.findByRole("button", { name: /Add Morgan/ });
      await vi.waitFor(() => expect(add).toBeEnabled());
      expect(memberData()).toHaveAttribute("data-refreshing", "true");
      expect(
        screen.queryByRole("button", { name: "Retry member data" }),
      ).not.toBeEnabled();
      if (state === "failed") {
        await act(async () => release());
        await screen.findByText(/Some names could not load/);
        await vi.waitFor(() =>
          expect(memberData()).toHaveAttribute("data-refreshing", "false"),
        );
        expect(add).toBeEnabled();
      }
      await t.user.click(add);
      await screen.findByText("Morgan is in the channel.");
      expect(t.publish).toHaveBeenCalledOnce();
    } finally {
      await act(async () => release());
    }
  },
);

it("one refresh retries every failed data source and never replays a failed invitation", async () => {
  const t = await setup("stream", true);
  t.fail("Invitation denied");
  await t.user.click(await t.search());
  await screen.findByText(/Invitation denied/);
  expect(
    screen.getByRole("button", { name: "Retry member data" }),
  ).toBeVisible();
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  const query = t.query.getMockImplementation();
  if (!query) throw new Error("Missing query fixture");
  t.query.mockRejectedValue(new Error("Reads offline"));
  t.readAgentLibrary.mockRejectedValueOnce(new Error("Agents offline"));
  await t.user.click(screen.getByRole("button", { name: "Retry member data" }));
  await screen.findByText(/The member list could not load/);
  await screen.findByText(/Some agents could not load/);
  await screen.findByText(/Archived identities could not be checked/);
  await within(
    screen.getByRole("region", { name: "Not in this channel" }),
  ).findByText("Reads offline");
  await screen.findByText(/Some names could not load/);
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  // Read recovery and invitation replay remain separate deliberate actions.
  expect(screen.getAllByRole("button", { name: /^Retry/ })).toHaveLength(2);
  t.query.mockImplementation(query);
  t.query.mockClear();
  t.readAgentLibrary.mockClear();
  t.recoverNames();
  await t.user.click(screen.getByRole("button", { name: "Retry member data" }));
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  const filters = t.query.mock.calls.flatMap(([filters]) => filters);
  expect(filters.some((filter) => filter.kinds?.includes(39002))).toBe(true);
  expect(filters.some((filter) => filter.kinds?.includes(39001))).toBe(true);
  expect(filters.some((filter) => filter.kinds?.includes(13535))).toBe(true);
  expect(
    filters.some((filter) => filter.authors?.includes(t.viewer.pubkey)),
  ).toBe(true);
  expect(filters.some((filter) => filter.search === "Morgan")).toBe(true);
  expect(t.readAgentLibrary).toHaveBeenCalledOnce();
  expect(t.session.archives.snapshot().status).toBe("ready");
  expect(t.session.profiles.snapshot().get(t.viewer.pubkey)?.name).toBe("Carl");
  expect(screen.getByRole("searchbox")).toHaveValue("Morgan");
  expect(
    screen.queryByText(
      /The member list could not load|Some agents could not load|Archived identities could not be checked|Some names could not load/,
    ),
  ).not.toBeInTheDocument();
  expect(t.publish).toHaveBeenCalledOnce();
  expect(screen.getByText(/Invitation denied/)).toBeVisible();
});

it.each(["search", "archives", "agents"])(
  "keeps the shared refresh busy until %s settle, then permits recovery",
  async (source) => {
    const t = await setup();
    await t.search();
    expect(
      screen.getByRole("button", { name: "Retry member data" }),
    ).toBeVisible();
    await vi.waitFor(() =>
      expect(memberData()).toHaveAttribute("data-refreshing", "false"),
    );
    const query = t.query.getMockImplementation();
    if (!query) throw new Error("Missing query fixture");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const hold = async () => {
      started++;
      await gate;
      throw new Error("Held read failed");
    };
    if (source === "agents") t.readAgentLibrary.mockImplementationOnce(hold);
    else
      t.query.mockImplementation(async (filters) => {
        if (
          filters.some((filter) =>
            source === "search"
              ? !!filter.search
              : filter.kinds?.includes(13535),
          )
        )
          await hold();
        return query(filters);
      });
    try {
      await t.user.click(
        screen.getByRole("button", { name: "Retry member data" }),
      );
      await vi.waitFor(() => expect(started).toBe(1));
      await vi.waitFor(() =>
        expect(
          t.session.memberAdministration.snapshot(
            "11111111-1111-4111-8111-111111111111",
          ).status,
        ).toBe("error"),
      );
      expect(memberData()).toHaveAttribute("data-refreshing", "true");
      expect(
        screen.queryByRole("button", { name: "Retry member data" }),
      ).not.toBeEnabled();
      await t.user.click(
        screen.getByRole("button", { name: "Retry member data" }),
      );
    } finally {
      await act(async () => release());
    }
    await vi.waitFor(() =>
      expect(memberData()).toHaveAttribute("data-refreshing", "false"),
    );
    expect(started).toBe(1);
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it("refresh restarts the current directory query from page one instead of mixing stale pages", async () => {
  const t = await setup();
  const query = t.query.getMockImplementation();
  if (!query) throw new Error("Missing query fixture");
  const pageOne = Array.from({ length: 30 }, (_, index) =>
    profile(keypair(), { name: `Morgan ${index}` }),
  );
  const pageTwo = profile(keypair(), { name: "Morgan stale" });
  let fresh = false;
  t.query.mockImplementation(async (filters) => {
    const search = filters.find((filter) => filter.search);
    return search
      ? fresh
        ? pageOne.slice(0, 1)
        : search.page === 2
          ? [pageTwo]
          : pageOne
      : query(filters);
  });
  await t.user.type(screen.getByRole("searchbox"), "Morgan");
  const more = await screen.findByRole("button", { name: "Find more matches" });
  expect(more).toHaveAttribute("data-size", "sm");
  expect(more.parentElement).toHaveClass("flex", "justify-center");
  await t.user.click(more);
  const people = within(
    screen.getByRole("region", { name: "Not in this channel" }),
  ).getByRole("region", { name: "People not in this channel" });
  await screen.findByText(nameText("Morgan stale"));
  expect(within(people).getAllByRole("button", { name: /^Add / })).toHaveLength(
    31,
  );
  expect(
    screen.getByRole("button", { name: "Retry member data" }),
  ).toBeVisible();
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  fresh = true;
  t.query.mockClear();
  await t.user.click(screen.getByRole("button", { name: "Retry member data" }));
  await screen.findByText(nameText("Morgan 0"));
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  expect(screen.queryByText(nameText("Morgan stale"))).not.toBeInTheDocument();
  expect(
    t.query.mock.calls
      .flatMap(([filters]) => filters)
      .filter((filter) => filter.search)
      .map((filter) => filter.page),
  ).toEqual([1]);
  expect(screen.getByRole("searchbox")).toHaveValue("Morgan");
});

it("keeps known members quiet while rechecking membership without enabling unverified additions", async () => {
  const t = await setup();
  await vi.waitFor(() =>
    expect(screen.queryByText("Loading members…")).toBeNull(),
  );
  expect(await t.search()).toBeEnabled();
  await t.user.keyboard("{Escape}");
  // Roster availability and role verification are independent reads: missing
  // role metadata must not block ordinary invitations or hide cached members.
  const rosterReads = () =>
    t.query.mock.calls.filter(
      ([filters]) =>
        filters.length === 1 &&
        filters[0]?.kinds?.length === 1 &&
        filters[0].kinds[0] === 39002,
    ).length;
  const authorityReads = () =>
    t.query.mock.calls.filter(([filters]) =>
      filters.some((filter) => filter.kinds?.includes(39001)),
    ).length;
  const beforeAuthority = authorityReads();
  const before = rosterReads();
  let release!: () => void;
  t.holdRoster(
    new Promise<void>((_resolve, reject) => {
      release = () => reject(new Error("Roster unavailable"));
    }),
  );
  try {
    await t.user.click(screen.getByRole("button", { name: "Access" }));
    await vi.waitFor(() => expect(rosterReads()).toBe(before + 1));
    expect(authorityReads()).toBe(beforeAuthority + 1);
    expect(screen.getByText("Carl (you)")).toBeVisible();
    expect(screen.queryByText("Loading members…")).not.toBeInTheDocument();
    const add = await t.search();
    expect(add).toBeDisabled();
    // No matching members is not an empty roster.
    expect(screen.queryByText("Loading members…")).not.toBeInTheDocument();
    await act(async () => release());
    const retry = await screen.findByRole("button", {
      name: "Retry member data",
    });
    expect(add).toBeDisabled();
    await vi.waitFor(() => expect(retry).toHaveAttribute("aria-busy", "false"));
    t.holdRoster(undefined);
    await t.user.click(retry);
    // Shared refresh replaces directory results; assert on the current control,
    // not the detached Add button from the failed read.
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: /Add Morgan/ })).toBeEnabled(),
    );
    expect(t.publish).not.toHaveBeenCalled();
  } finally {
    await act(async () => release());
  }
});

beforeEach(() => {
  // jsdom hides [popover] but has no native top layer. Browser tests own paint.
  HTMLElement.prototype.showPopover = function () {
    this.style.display = "block";
  };
});
afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
});

it.each(["avatar", "row", "keyboard"])(
  "opens the exact member profile from the %s and supplies the stable header return target",
  async (activation) => {
    const onOpenLink = vi.fn(() => true);
    const t = await setup("stream", false, false, {
      canOpenLink: () => true,
      onOpenLink,
    });
    const row = screen.getByRole("button", { name: /Open profile for Carl/ });
    if (activation === "keyboard") {
      row.focus();
      await t.user.keyboard("{Enter}");
    } else if (activation === "avatar") {
      const avatar = row.parentElement?.parentElement?.querySelector(
        "[data-avatar-shape]",
      );
      if (!avatar) throw new Error("Missing member avatar");
      await t.user.click(avatar);
    } else await t.user.click(row);
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith(
      profileTarget(t.viewer.pubkey),
      screen.getByRole("button", { name: "Access" }),
    );
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it("keeps Members open when the profile dispatcher declines the target", async () => {
  const onOpenLink = vi.fn(() => false);
  const t = await setup("stream", false, false, {
    canOpenLink: () => true,
    onOpenLink,
  });
  await t.user.click(
    screen.getByRole("button", { name: /Open profile for Carl/ }),
  );
  expect(onOpenLink).toHaveBeenCalledOnce();
  expect(screen.getByRole("dialog", { name: "Manage members" })).toBeVisible();
  expect(
    screen.queryByRole("dialog", { name: /identity$/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /Open profile for Carl/ }),
  ).toHaveFocus();
  await t.user.keyboard("{Escape}");
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("button", { name: "Access" })).toHaveFocus();
  expect(t.publish).not.toHaveBeenCalled();
});

it("does not offer profile controls without an available Profiles contribution", async () => {
  const onOpenLink = vi.fn(() => true);
  const t = await setup("stream", false, false, {
    canOpenLink: () => false,
    onOpenLink,
  });
  expect(
    screen.queryByRole("button", { name: /Open profile for/ }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Carl (you)")).toBeVisible();
  expect(onOpenLink).not.toHaveBeenCalled();
  expect(t.publish).not.toHaveBeenCalled();
});

it("refreshes membership even when verified role metadata is unavailable", async () => {
  const t = await setup();
  expect(
    screen.getByRole("button", {
      name: "Retry member data",
    }),
  ).toBeVisible();
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  t.confirmRoster();
  await t.user.click(screen.getByRole("button", { name: "Retry member data" }));
  await screen.findByText("Morgan");
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  expect(screen.getByRole("region", { name: "People" })).toHaveTextContent(
    "People · 2",
  );
  expect(
    t.session.memberAdministration.snapshot(
      "11111111-1111-4111-8111-111111111111",
    ).status,
  ).toBe("error");
  expect(t.publish).not.toHaveBeenCalled();
});

it("shares the identity presentation with invitation rows without assigning a channel role", async () => {
  const t = await setup("stream", false, true);
  const add = await t.search();
  const row = screen.getByRole("region", { name: "Not in this channel" });
  expect(within(row).getByText("Fixture agent", { exact: true })).toBeVisible();
  expect(
    within(row).queryByText("Agent", { exact: true }),
  ).not.toBeInTheDocument();
  expect(within(row).queryByText(/Managed by/)).not.toBeInTheDocument();
  expect(
    row.querySelector('[data-avatar-shape="squircle"]'),
  ).toBeInTheDocument();
  // Rows never reveal public keys on hover.
  expect(row).not.toHaveTextContent(/npub/);
  expect(
    within(row).queryByRole("button", { name: /Copy/ }),
  ).not.toBeInTheDocument();
  expect(
    within(row).queryByRole("button", { name: "Actions for Fixture agent" }),
  ).not.toBeInTheDocument();
  add.focus();
  await t.user.keyboard("{Shift>}{F10}{/Shift}");
  expect(
    (await screen.findAllByRole("menuitem")).map((item) => item.textContent),
  ).toEqual(["View profile"]);
  const menu = screen.getByRole("menu", { name: "Actions for Fixture agent" });
  await vi.waitFor(() => expect(menu).toHaveFocus());
  await t.user.keyboard("{Escape}");
  await vi.waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(row.querySelector("[title]")).not.toBeInTheDocument();
  expect(within(row).queryByText("Role unverified")).not.toBeInTheDocument();
  expect(
    within(screen.getByRole("button", { name: /Add Fixture agent/ })).getByText(
      "Add",
      { exact: true },
    ),
  ).toBeVisible();
  expect(t.publish).not.toHaveBeenCalled();
});

it.each(["row"])(
  "opens a non-member profile from the %s without inviting them",
  async (activation) => {
    const onOpenLink = vi.fn(() => true);
    const t = await setup("stream", false, false, {
      canOpenLink: () => true,
      onOpenLink,
    });
    const add = await t.search();
    const row = screen.getByRole("button", { name: /Open profile for Morgan/ });
    expect(row).not.toContainElement(add);
    expect(add).not.toContainElement(row);
    if (activation === "keyboard") {
      row.focus();
      await t.user.keyboard("{Enter}");
    } else if (activation === "avatar") {
      const avatar = row.parentElement?.parentElement?.querySelector(
        "[data-avatar-shape]",
      );
      if (!avatar) throw new Error("Missing invitation avatar");
      await t.user.click(avatar);
    } else await t.user.click(row);
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith(
      profileTarget(t.person.pubkey),
      screen.getByRole("button", { name: "Access" }),
    );
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it("invites only through the separate prominent Add button and leaves profile navigation available while pending", async () => {
  const onOpenLink = vi.fn(() => true);
  const t = await setup("stream", false, false, {
    canOpenLink: () => true,
    onOpenLink,
  });
  const add = await t.search();
  expect(add).toHaveAttribute("data-variant", "prominent");
  expect(add).toHaveAttribute("data-size", "xs");
  t.hold();
  try {
    await t.user.click(add);
    await vi.waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
    expect(onOpenLink).not.toHaveBeenCalled();
    expect(add).toHaveTextContent("Adding…");
    await t.user.click(add);
    expect(t.publish).toHaveBeenCalledOnce();
    await t.user.click(
      screen.getByRole("button", { name: /Open profile for Morgan/ }),
    );
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith(
      profileTarget(t.person.pubkey),
      screen.getByRole("button", { name: "Access" }),
    );
  } finally {
    await act(async () => t.release());
  }
});

it("keeps Add separate and usable when non-member profile navigation is declined or unavailable", async () => {
  const onOpenLink = vi.fn(() => false);
  let supported = true;
  const t = await setup("stream", false, false, {
    canOpenLink: () => supported,
    onOpenLink,
  });
  await t.search();
  await t.user.click(
    screen.getByRole("button", { name: /Open profile for Morgan/ }),
  );
  expect(screen.getByRole("dialog", { name: "Manage members" })).toBeVisible();
  expect(t.publish).not.toHaveBeenCalled();
  supported = false;
  await t.user.clear(screen.getByRole("searchbox"));
  await t.search();
  expect(
    screen.queryByRole("button", { name: /Open profile for Morgan/ }),
  ).not.toBeInTheDocument();
  await t.user.click(screen.getByRole("button", { name: /Add Morgan/ }));
  await screen.findByText("Morgan is in the channel.");
  expect(t.publish).toHaveBeenCalledOnce();
  expect(onOpenLink).toHaveBeenCalledOnce();
});

function managedProfile(
  agent: ReturnType<typeof keypair>,
  manager: ReturnType<typeof keypair>,
  time: number,
  valid = true,
) {
  const digest = new Uint8Array(
    createHash("sha256").update(`nostr:agent-auth:${agent.pubkey}:`).digest(),
  );
  return signed(agent, {
    kind: 0,
    created_at: time,
    content: JSON.stringify({ name: "Morgan", is_agent: true }),
    tags: [
      [
        "auth",
        manager.pubkey,
        "",
        bytesToHex(schnorr.sign(digest, (valid ? manager : agent).secret)),
      ],
    ],
  });
}

it.each([
  [false, "hint"],
  [true, "hint"],
  [false, "menu"],
  [true, "menu"],
] as const)(
  "opens the verified manager without inviting or opening the agent (member: %s, source: %s)",
  async (member, source) => {
    const onOpenLink = vi.fn(() => true);
    const t = await setup("stream", false, false, {
      canOpenLink: () => true,
      onOpenLink,
    });
    const agent = managedProfile(t.person, t.viewer, 1800000000);
    const original = t.query.getMockImplementation();
    if (!original) throw new Error("Missing query");
    t.query.mockImplementation(async (filters) =>
      (await original(filters)).map((event) =>
        event.pubkey === t.person.pubkey && event.kind === 0 ? agent : event,
      ),
    );
    if (member) {
      t.confirmRoster();
      await vi.waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Retry member data" }),
        ).toHaveAttribute("aria-busy", "false"),
      );
      await t.user.click(
        screen.getByRole("button", { name: "Retry member data" }),
      );
    } else await t.search();
    const owner = await screen.findByRole("button", {
      name: "Open owner profile: Carl (you)",
    });
    const profileButton = screen.getByRole("button", {
      name: /Open profile for Morgan/,
    });
    expect(profileButton).not.toContainElement(owner);
    expect(owner.closest("button button")).toBeNull();
    expect(
      screen.queryByText("Agent", { exact: true }),
    ).not.toBeInTheDocument();
    expect(owner.parentElement).toHaveTextContent("Managed by Carl (you)");
    if (source === "hint") {
      owner.focus();
      await t.user.keyboard("{Enter}");
    } else {
      if (member) {
        await t.user.click(
          screen.getByRole("button", { name: "Actions for Morgan" }),
        );
      } else {
        expect(
          screen.queryByRole("button", { name: "Actions for Morgan" }),
        ).toBeNull();
        profileButton.focus();
        await t.user.keyboard("{Shift>}{F10}{/Shift}");
      }
      expect(
        (await screen.findAllByRole("menuitem")).map(
          (item) => item.textContent,
        ),
      ).toEqual(["View profile", "View owner profile"]);
      await t.user.click(
        screen.getByRole("menuitem", { name: "View owner profile" }),
      );
    }
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith(
      profileTarget(t.viewer.pubkey),
      screen.getByRole("button", { name: "Access" }),
    );
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it.each(["unavailable", "declined"] as const)(
  "keeps Members usable when owner profile navigation is %s",
  async (navigation) => {
    const onOpenLink = vi.fn(() => false);
    const t = await setup("stream", false, false, {
      canOpenLink: () => navigation !== "unavailable",
      onOpenLink,
    });
    const agent = managedProfile(t.person, t.viewer, 1800000000);
    const original = t.query.getMockImplementation();
    if (!original) throw new Error("Missing query");
    t.query.mockImplementation(async (filters) =>
      (await original(filters)).map((event) =>
        event.pubkey === t.person.pubkey && event.kind === 0 ? agent : event,
      ),
    );
    await t.search();
    await screen.findByText(/Managed by/);
    const actions = screen.getByRole("button", { name: /Add Morgan/ });
    expect(
      screen.queryByRole("button", { name: "Actions for Morgan" }),
    ).toBeNull();
    actions.focus();
    await t.user.keyboard("{Shift>}{F10}{/Shift}");
    const menu = await screen.findByRole("menu", {
      name: "Actions for Morgan",
    });
    await vi.waitFor(() => expect(menu).toHaveFocus());
    if (navigation === "unavailable") {
      expect(
        screen.queryByRole("menuitem", { name: "View owner profile" }),
      ).toBeNull();
      expect(onOpenLink).not.toHaveBeenCalled();
      await t.user.keyboard("{Escape}");
    } else {
      await t.user.click(
        screen.getByRole("menuitem", { name: "View owner profile" }),
      );
      expect(onOpenLink).toHaveBeenCalledExactlyOnceWith(
        profileTarget(t.viewer.pubkey),
        t.trigger,
      );
      await vi.waitFor(() => expect(actions).toHaveFocus());
    }
    expect(
      screen.getByRole("dialog", { name: "Manage members" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /Add Morgan/ })).toBeEnabled();
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it("removes ownership on a newer invalid signed head and never restores it from an older read", async () => {
  const t = await setup("stream", false, false, {
    canOpenLink: () => true,
    onOpenLink: () => true,
  });
  const original = t.query.getMockImplementation();
  if (!original) throw new Error("Missing query");
  let head = managedProfile(t.person, t.viewer, 1800000000);
  const first = head;
  t.query.mockImplementation(async (filters) =>
    (await original(filters)).map((event) =>
      event.pubkey === t.person.pubkey && event.kind === 0 ? head : event,
    ),
  );
  await t.search();
  await screen.findByRole("button", { name: "Open owner profile: Carl (you)" });
  expect(
    screen.getByRole("button", { name: "Retry member data" }),
  ).toBeVisible();
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  head = managedProfile(t.person, t.viewer, 1800000001, false);
  await t.user.click(screen.getByRole("button", { name: "Retry member data" }));
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  expect(
    screen.queryByText("managed by", { exact: false }),
  ).not.toBeInTheDocument();
  head = first;
  await t.user.click(screen.getByRole("button", { name: "Retry member data" }));
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  expect(
    screen.queryByRole("button", { name: /Open owner profile/ }),
  ).not.toBeInTheDocument();
  screen.getByRole("button", { name: /Add Morgan/ }).focus();
  await t.user.keyboard("{Shift>}{F10}{/Shift}");
  await screen.findByRole("menu", { name: "Actions for Morgan" });
  expect(
    screen.queryByRole("menuitem", { name: "View owner profile" }),
  ).toBeNull();

  expect(t.publish).not.toHaveBeenCalled();
});

it("retries ownership admission and failed owner names through the shared refresh", async () => {
  const t = await setup("stream", false, false, {
    canOpenLink: () => true,
    onOpenLink: () => true,
  });
  // Leave no default invitation view to release a slot during this budget test.
  await act(async () => t.control.set({ agents: [] }));
  const manager = keypair();
  const agent = managedProfile(t.person, manager, 1800000000);
  const original = t.query.getMockImplementation();
  if (!original) throw new Error("Missing query");
  let failName = true;
  t.query.mockImplementation(async (filters) => {
    if (filters.some((f) => f.authors?.includes(manager.pubkey))) {
      if (failName) throw new Error("Name unavailable");
      return [profile(manager, { name: "Manager" })];
    }
    return (await original(filters)).map((event) =>
      event.pubkey === t.person.pubkey && event.kind === 0 ? agent : event,
    );
  });
  const held: ReturnType<typeof t.session.observe>[] = [];
  try {
    for (let i = 0; i < 64; i++)
      held.push(
        t.session.observe([
          { kinds: [0], authors: [t.viewer.pubkey], limit: 1 },
        ]),
      );
  } catch {
    /* Fill the actual session view budget. */
  }
  stops.push(() => {
    for (const view of held) view.dispose();
  });
  await t.search();
  await screen.findByText(/Some agent managers or their names could not load/);
  expect(
    screen.queryByRole("button", { name: /Open owner profile/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Retry member data" }),
  ).toBeVisible();
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  for (const view of held) view.dispose();
  await t.user.click(screen.getByRole("button", { name: "Retry member data" }));
  await screen.findByRole("button", { name: /Open owner profile: npub/ });
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  expect(
    screen.getByText(/Some agent managers or their names could not load/),
  ).toBeVisible();
  failName = false;
  await t.user.click(screen.getByRole("button", { name: "Retry member data" }));
  await screen.findByRole("button", { name: "Open owner profile: Manager" });
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  expect(
    screen.queryByText(/Some agent managers or their names could not load/),
  ).not.toBeInTheDocument();
  expect(t.publish).not.toHaveBeenCalled();
});

/** Searches "Helper" over 30 relay matches plus a second relay page and `localCount` local agents. */
async function pagedInvitations(
  step: <T>(action: () => Promise<T>) => Promise<T>,
  localCount: number,
) {
  const t = await step(() => setup());
  const remote = Array.from({ length: 30 }, (_, index) =>
    profile(keypair(), { name: `Helper remote ${index}` }),
  );
  const lastRemote = profile(keypair(), { name: "Helper final" });
  const local = Array.from({ length: localCount }, (_, index) => ({
    pubkey: keypair().pubkey,
    name: `Helper local ${index}`,
    owner: t.viewer.pubkey,
    relayUrl: t.agent.relayUrl,
  }));
  const firstRemote = remote[0];
  if (!firstRemote) throw new Error("Missing first remote fixture");
  t.readAgentLibrary.mockResolvedValue({
    definitions: [],
    identities: [
      ...local,
      { pubkey: firstRemote.pubkey, name: "Helper remote 0" },
    ],
  });
  await step(() =>
    act(async () => {
      t.control.set({
        agents: [
          ...local,
          { ...t.agent, pubkey: firstRemote.pubkey, name: "Helper remote 0" },
        ],
      });
      await t.session.agentChoices.refresh();
    }),
  );
  const query = t.query.getMockImplementation();
  if (!query) throw new Error("Missing query fixture");
  t.query.mockImplementation(async (filters) => {
    const search = filters.find((filter) => filter.search);
    return search
      ? search.page === 2
        ? [lastRemote]
        : remote
      : query(filters);
  });
  // The 200 ms search debounce runs on a controlled clock. user-event awaits a
  // real setTimeout(0) after every action, so these steps drive fireEvent.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const input = screen.getByRole("searchbox");
  const refresh = screen.getByRole("button", { name: "Retry member data" });
  const idle = () =>
    step(async () => {
      await act(() => vi.advanceTimersByTimeAsync(200));
      await vi.waitFor(() =>
        expect(memberData()).toHaveAttribute("data-refreshing", "false"),
      );
    });
  const search = (value: string) =>
    step(async () => {
      fireEvent.change(input, { target: { value } });
    });
  const click = (button: HTMLElement) =>
    step(async () => {
      fireEvent.click(button);
    });
  const more = () =>
    click(screen.getByRole("button", { name: "Find more matches" }));
  const groupRows = (name: string) =>
    within(screen.getByRole("region", { name })).getAllByRole("button", {
      name: /^Add /,
    });
  // React retains the group's control while it expands. Resolve it once rather
  // than recomputing every growing row's accessible name before each click.
  const moreButtons = new Map<string, HTMLElement>();
  const moreIn = (name: string) => {
    let button = moreButtons.get(name);
    if (!button?.isConnected) {
      button = within(screen.getByRole("region", { name })).getByRole(
        "button",
        {
          name: "Show more",
        },
      );
      moreButtons.set(name, button);
    }
    return click(button);
  };
  const rows = () =>
    within(
      screen.getByRole("region", { name: "Not in this channel" }),
    ).getAllByRole("button", { name: /^Add / });
  const pages = () =>
    t.query.mock.calls
      .flatMap(([filters]) => filters)
      .filter((filter) => filter.search)
      .map((filter) => filter.page);
  await search("Helper");
  await idle();
  return {
    t,
    local,
    remote,
    refresh,
    idle,
    search,
    click,
    more,
    moreIn,
    groupRows,
    rows,
    pages,
  };
}

it("expands local and relay groups independently without losing paged matches", async ({
  signal,
}) => {
  return ownedTask(signal, async (step) => {
    const { t, idle, more, moreIn, groupRows, rows, pages } =
      await pagedInvitations(step, 65);
    expect(rows()).toHaveLength(8);
    expect(groupRows("Your agents")).toHaveLength(4);
    expect(groupRows("People not in this channel")).toHaveLength(4);
    for (let index = 0; index < 16; index++) await moreIn("Your agents");
    expect(groupRows("Your agents")).toHaveLength(66);
    expect(groupRows("People not in this channel")).toHaveLength(4);
    for (let index = 0; index < 7; index++)
      await moreIn("People not in this channel");
    expect(rows()).toHaveLength(95);
    expect(pages()).toEqual([1]);
    await more();
    await idle();
    expect(
      screen.getByRole("button", { name: /^Add Helper final/ }),
    ).toBeVisible();
    expect(rows()).toHaveLength(96);
    expect(pages()).toEqual([1, 2]);
    expect(
      screen.queryByRole("button", { name: "Find more matches" }),
    ).toBeNull();
    expect(t.publish).not.toHaveBeenCalled();
  });
});

it("reveals fetched relay pages while local-only rows keep their own limit", async ({
  signal,
}) => {
  return ownedTask(signal, async (step) => {
    const { t, idle, more, moreIn, groupRows, rows, pages } =
      await pagedInvitations(step, 65);
    expect(rows()).toHaveLength(8);
    await more();
    await idle();
    expect(
      screen.getByRole("button", { name: /^Add Helper final/ }),
    ).toBeVisible();
    expect(groupRows("People not in this channel")).toHaveLength(30);
    expect(groupRows("Your agents")).toHaveLength(4);
    await moreIn("Your agents");
    expect(groupRows("Your agents")).toHaveLength(8);
    expect(groupRows("People not in this channel")).toHaveLength(30);
    expect(pages()).toEqual([1, 2]);
    expect(t.publish).not.toHaveBeenCalled();
  });
});

it("expands a mixed group from its revealed relay boundary", async ({
  signal,
}) => {
  return ownedTask(signal, async (step) => {
    const { t, local, remote, idle, more, moreIn, groupRows } =
      await pagedInvitations(step, 5);
    t.readAgentLibrary.mockResolvedValue({
      definitions: [],
      identities: [
        ...local,
        ...remote.map((event, index) => ({
          pubkey: event.pubkey,
          name: `Helper remote ${index}`,
        })),
      ],
    });
    await step(() =>
      act(async () => {
        t.control.set({ agents: [] });
        await t.session.agentChoices.refresh();
      }),
    );
    await idle();
    expect(groupRows("Your other agents")).toHaveLength(4);
    await more();
    await idle();
    expect(groupRows("Your other agents")).toHaveLength(30);
    await moreIn("Your other agents");
    expect(groupRows("Your other agents")).toHaveLength(34);
    expect(t.publish).not.toHaveBeenCalled();
  });
});

it("resets every invitation group's expansion on refresh or query change", async ({
  signal,
}) => {
  return ownedTask(signal, async (step) => {
    const {
      t,
      refresh,
      idle,
      search,
      click,
      more,
      moreIn,
      groupRows,
      rows,
      pages,
    } = await pagedInvitations(step, 31);
    for (let index = 0; index < 7; index++) await moreIn("Your agents");
    for (let index = 0; index < 7; index++)
      await moreIn("People not in this channel");
    await more();
    await idle();
    expect(
      screen.getByRole("button", { name: /^Add Helper final/ }),
    ).toBeVisible();
    expect(rows()).toHaveLength(62);
    expect(pages()).toEqual([1, 2]);
    await click(refresh);
    await idle();
    expect(rows()).toHaveLength(8);
    expect(pages()).toEqual([1, 2, 1]);
    await moreIn("Your agents");
    expect(groupRows("Your agents")).toHaveLength(8);
    expect(groupRows("People not in this channel")).toHaveLength(4);
    await search("Helper local");
    await idle();
    expect(rows()).toHaveLength(8);
    await search("");
    expect(groupRows("Your agents")).toHaveLength(4);
    expect(rows()).toHaveLength(4);
    expect(pages()).toEqual([1, 2, 1, 1]);
    expect(t.publish).not.toHaveBeenCalled();
  });
});

it("adds a team's members not in the channel with one button", async () => {
  const ada = "ab".repeat(32);
  const cy = "cd".repeat(32);
  const snapshot = {
    status: "ready",
    agents: [
      { pubkey: ada, name: "Ada" },
      { pubkey: cy, name: "Cy" },
    ],
    running: [],
    teams: [
      { id: "crew", name: "Crew", instructions: "", members: [ada, cy] },
      {
        id: "far",
        name: "Far",
        instructions: "",
        members: ["ef".repeat(32)],
      },
    ],
  };
  const agents = {
    subscribe: () => () => {},
    snapshot: () => snapshot,
  } as unknown as Agents;
  const t = await setup("stream", false, false, undefined, agents);
  await screen.findByRole("region", { name: "Your agents" });
  expect(screen.queryByRole("list", { name: "Teams" })).toBeNull();
  await t.user.type(screen.getByRole("searchbox"), "Cr");
  const teams = await screen.findByRole("list", { name: "Teams" });
  expect(within(teams).getByText("Ada, Cy")).toBeInTheDocument();
  await t.user.type(screen.getByRole("searchbox"), "ew");
  await t.user.click(screen.getByRole("button", { name: "Add team Crew" }));
  await screen.findByText("Crew is in the channel.");
  const added = t.publish.mock.calls
    .map(([event]) => event)
    .filter((event) => event.kind === 9000)
    .map((event) => event.tags.find((tag) => tag[0] === "p")?.[1]);
  expect(added.sort()).toEqual([ada, cy]);
  // Once all its members are in, a team is not offered again.
  await vi.waitFor(() =>
    expect(
      screen.queryByRole("list", { name: "Teams" }),
    ).not.toBeInTheDocument(),
  );
  // A team with no agents in this community is never offered.
  await t.user.clear(screen.getByRole("searchbox"));
  await t.user.type(screen.getByRole("searchbox"), "Far");
  expect(
    screen.queryByRole("button", { name: "Add team Far" }),
  ).not.toBeInTheDocument();
});

async function teamSetup(names = ["Ada", "Cy"]) {
  const keys = names.map((_name, index) => `${index}${index}`.repeat(32));
  const ada = keys[0] ?? "";
  const cy = keys[1] ?? "";
  // useSyncExternalStore needs one stable snapshot object.
  const snapshot = {
    status: "ready",
    agents: names.map((name, index) => ({ pubkey: keys[index], name })),
    running: [],
    teams: [{ id: "crew", name: "Crew", instructions: "", members: keys }],
  };
  const agents = {
    subscribe: () => () => {},
    snapshot: () => snapshot,
  } as unknown as Agents;
  const t = await setup("stream", false, false, undefined, agents);
  await t.user.type(screen.getByRole("searchbox"), "Crew");
  await screen.findByRole("button", { name: "Add team Crew" });
  return { ...t, ada, cy };
}
it("groups a team's refusals with one reason into one alert whose Retry adds them all", async () => {
  const t = await teamSetup();
  t.fail("Invitation denied");
  await t.user.click(screen.getByRole("button", { name: "Add team Crew" }));
  const refusals = () =>
    screen
      .getAllByRole("alert")
      .map((item) => item.textContent ?? "")
      .filter((content) => content.includes("denied"));
  await screen.findByText(/^Ada and Cy: Invitation denied/);
  expect(refusals()).toHaveLength(1);
  const retry = screen.getByRole("button", { name: "Retry adding Ada and Cy" });
  expect(retry).toHaveTextContent("Retry");
  t.fail("");
  await t.user.click(retry);
  expect(screen.getByRole("searchbox")).toHaveFocus();
  await vi.waitFor(() => expect(refusals()).toHaveLength(0));
  // One combined notice, instead of each retry announcing its own.
  await screen.findByText("Ada and Cy are in the channel.");
  const added = t.publish.mock.calls
    .filter(([event]) => event.tags.filter(([tag]) => tag === "p").length === 1)
    .map(([event]) => event.tags.find((tag) => tag[0] === "p")?.[1])
    .sort();
  expect(added).toEqual([t.ada, t.ada, t.cy, t.cy].sort());
});
it("keeps only the still-refused member in the alert after a partial retry", async () => {
  const t = await teamSetup();
  t.fail("Invitation denied");
  await t.user.click(screen.getByRole("button", { name: "Add team Crew" }));
  await screen.findByText(/^Ada and Cy: Invitation denied/);
  const base = t.publish.getMockImplementation();
  if (!base) throw new Error("Missing publish fixture");
  t.fail("");
  t.publish.mockImplementation(async (event) => {
    if (event.tags.find((tag) => tag[0] === "p")?.[1] === t.cy)
      throw new PublishRejected("Invitation denied");
    return base(event);
  });
  await t.user.click(
    screen.getByRole("button", { name: "Retry adding Ada and Cy" }),
  );
  await screen.findByText(/^Cy: Invitation denied/);
  expect(
    screen
      .getAllByRole("alert")
      .map((item) => item.textContent)
      .filter((content) => content?.includes("denied")),
  ).toEqual([expect.stringMatching(/^Cy: Invitation denied/)]);
  expect(screen.getByRole("button", { name: "Retry adding Cy" })).toBeEnabled();
  // Ada's addition has landed; the group still announces nothing.
  await vi.waitFor(() =>
    expect(t.session.memberAdditions.snapshot()).toEqual([
      expect.objectContaining({ pubkey: t.cy, pending: false }),
    ]),
  );
  expect(screen.queryByText(/are in the channel/)).not.toBeInTheDocument();
});
it("names three refused members and counts the rest", async () => {
  const t = await teamSetup(["Di", "Ada", "Cy", "Bo"]);
  t.fail("Invitation denied");
  await t.user.click(screen.getByRole("button", { name: "Add team Crew" }));
  await screen.findByText(/^Ada, Bo, Cy, and 1 more: Invitation denied/);
  expect(
    screen.getByRole("button", {
      name: "Retry adding Ada, Bo, Cy, and 1 more",
    }),
  ).toBeEnabled();
});
it("shows a team's refusals with different reasons as separate alerts", async () => {
  const t = await teamSetup();
  const base = t.publish.getMockImplementation();
  if (!base) throw new Error("Missing publish fixture");
  t.publish.mockImplementation(async (event) => {
    const recipients = event.tags.filter(([tag]) => tag === "p");
    if (recipients.length === 1 && recipients[0]?.[1] === t.ada)
      throw new PublishRejected("Agent is archived");
    return base(event);
  });
  t.fail("Invitation denied");
  await t.user.click(screen.getByRole("button", { name: "Add team Crew" }));
  const refusals = () =>
    screen
      .getAllByRole("alert")
      .map((item) => item.textContent ?? "")
      .filter((content) => /^(Ada|Cy): /.test(content));
  await vi.waitFor(() => expect(refusals()).toHaveLength(2));
  expect(refusals().sort()).toEqual([
    expect.stringMatching(/^Ada: Agent is archived/),
    expect.stringMatching(/^Cy: Invitation denied/),
  ]);
  expect(
    screen.getAllByRole("button", { name: /^Retry adding (Ada|Cy)$/ }),
  ).toHaveLength(2);
});
it("offers local agents to add by the shared name rule", async () => {
  const t = await setup();
  await act(async () => {
    t.control.set({
      agents: [
        { ...t.agent, pubkey: keypair().pubkey, name: "José" },
        { ...t.agent, pubkey: keypair().pubkey, name: "Honey" },
      ],
    });
  });
  const query = t.query.getMockImplementation();
  if (!query) throw new Error("Missing query fixture");
  t.query.mockImplementation(async (filters) =>
    filters.some((filter) => filter.search) ? [] : query(filters),
  );
  const input = screen.getByRole("searchbox");
  expect(
    screen.getByRole("button", { name: "Retry member data" }),
  ).toBeVisible();
  const offered = () =>
    screen
      .queryAllByRole("button", { name: /^Add / })
      .map((row) => row.getAttribute("aria-label"));
  // Accents fold, so `jose` finds the agent José.
  await t.user.type(input, "jose");
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  expect(offered()).toEqual([expect.stringMatching(/^Add José/)]);
  // Text inside a word does not match: `oney` does not find Honey.
  await t.user.clear(input);
  await t.user.type(input, "oney");
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  expect(offered()).toEqual([]);
});

it("controlled presentation restores the dialog without retaining its search or issuing writes", async () => {
  const t = await setup();
  cleanup();
  const onOpenChange = vi.fn();
  const button = (open: boolean) => (
    <ToastProvider>
      <ChannelMembersButton
        session={t.session}
        channelId="11111111-1111-4111-8111-111111111111"
        presentation={{ open, onOpenChange }}
      />
    </ToastProvider>
  );
  const view = render(button(false));
  await t.user.click(screen.getByRole("button", { name: "Access" }));
  expect(onOpenChange).toHaveBeenLastCalledWith(true);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  view.rerender(button(true));
  await screen.findByText("Carl (you)");
  await t.user.type(screen.getByRole("searchbox"), "Carl");
  await t.user.keyboard("{Escape}");
  expect(onOpenChange).toHaveBeenLastCalledWith(false);
  view.rerender(button(false));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  view.rerender(button(true));
  await screen.findByText("Carl (you)");
  expect(screen.getByRole("searchbox")).toHaveValue("");
  expect(t.publish).not.toHaveBeenCalled();
});

for (const mode of ["cancellation", "early assertion failure"] as const) {
  it(`drains a gated action through the real teardown after ${mode}`, async ({
    onTestFinished,
  }) => {
    const events: string[] = [];
    let rejection: unknown;
    let teardownReason: unknown;
    const reason = new Error(mode);
    onTestFinished(() => {
      expect(events).toEqual([
        "action:start",
        ...(mode === "early assertion failure" ? ["assertion:rejected"] : []),
        "teardown:abort",
        "action:settled",
        "task:settled",
        "cleanup",
        "dispose",
      ]);
      if (mode === "cancellation") expect(rejection).toBe(reason);
      else expect(rejection).toBe(teardownReason);
      expect(screen.queryByTestId("owned-action")).toBeNull();
    });
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    function CleanupProbe() {
      useEffect(
        () => () => {
          events.push("cleanup");
        },
        [],
      );
      return (
        <button type="button" data-testid="owned-action">
          Owned action
        </button>
      );
    }
    render(<CleanupProbe />);
    stops.push(() => {
      events.push("dispose");
    });
    const user = userEvent.setup();
    const task = ownedTask(controller.signal, async (step) => {
      await step(async () => {
        events.push("action:start");
        await gate;
        await user.click(screen.getByTestId("owned-action"));
        events.push("action:settled");
      });
      events.push("late-action");
      screen.getByTestId("owned-action");
    });
    void Promise.allSettled([task]).then(([outcome]) => {
      if (outcome?.status === "rejected") rejection = outcome.reason;
      events.push("task:settled");
    });
    // Release from fixture abort during afterEach, not from callback finally.
    const owned = tasks.at(-1);
    if (!owned) throw new Error("Missing owned task");
    owned.controller.signal.addEventListener("abort", () => {
      teardownReason = owned.controller.signal.reason;
      events.push(
        screen.queryByTestId("owned-action")
          ? "teardown:abort"
          : "premature-cleanup",
      );
      release();
    });
    if (mode === "cancellation") {
      controller.abort(reason);
    } else {
      let assertionReason: unknown;
      const failed = ownedTask(new AbortController().signal, async () => {
        expect("early failure").toBe("completed action");
      });
      await expect(failed).rejects.toThrow("early failure");
      await Promise.allSettled([failed]).then(([outcome]) => {
        if (outcome?.status === "rejected") assertionReason = outcome.reason;
      });
      expect(assertionReason).toMatchObject({ name: "AssertionError" });
      events.push("assertion:rejected");
    }
    expect(events).not.toContain("cleanup");
    expect(events).not.toContain("task:settled");
  });
}

it("lets the Solo owner add an agent without sending a message", async () => {
  const t = await setup("solo", false, true);
  const input = screen.getByRole("searchbox", {
    name: "Search people, agents and channels",
  });
  expect(input).toHaveAttribute(
    "placeholder",
    "Add people, agents or a channel",
  );
  expect(screen.queryByText(/Join this channel/)).not.toBeInTheDocument();
  expect(input).not.toHaveAttribute("aria-describedby");
  expect(screen.getByRole("dialog")).not.toHaveAccessibleDescription();
  expect(
    screen.queryByRole("region", { name: "Not in this chat" }),
  ).toBeVisible();
  expect(screen.getByRole("region", { name: "Your agents" })).toBeVisible();
  await t.user.type(input, "Fixture");
  await screen.findByRole("button", { name: /Add Fixture agent/ });
  await t.user.clear(input);
  expect(
    screen.queryByRole("region", { name: "Not in this chat" }),
  ).toBeVisible();
  const add = await t.search();
  t.hold();
  await t.user.click(add);
  await vi.waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
  expect(add).toHaveAttribute("aria-disabled", "true");
  await t.user.click(add);
  expect(t.publish).toHaveBeenCalledOnce();
  await act(async () => t.release());
  const notice = await screen.findByText("Fixture agent added.");
  expect(notice).toHaveClass("sr-only");
  expect(input).toHaveValue("");
  expect(input).toHaveFocus();
  expect(screen.getByRole("heading", { name: "People · 1" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Agents · 1" })).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /Add Fixture agent/ }),
  ).not.toBeInTheDocument();
  expect(t.session.channels.list().channels[0]?.members).toContain(
    t.agent.pubkey,
  );
  expect(t.publish.mock.calls.map(([event]) => event.kind)).toEqual([9000]);
  expect(
    t.publish.mock.calls[0]?.[0].tags.filter(([tag]) => tag !== "client-id"),
  ).toEqual([
    ["h", "11111111-1111-4111-8111-111111111111"],
    ["p", t.agent.pubkey],
    ["role", "bot"],
  ]);
  await t.user.click(screen.getByRole("button", { name: "Close" }));
  await t.user.click(t.trigger);
  await screen.findByRole("heading", { name: "Agents · 1" });
  expect(t.publish).toHaveBeenCalledOnce();
});

it("keeps Solo channel sharing search-only while suggesting your agents when alone", async () => {
  const t = await setup("solo", false, true);
  const destination = "22222222-2222-4222-8222-222222222222";
  const events = [
    metadata(t.relay, destination, "Planning", 1700000000, [
      ["t", "stream"],
      ["public"],
    ]),
    roster(t.relay, destination, [t.viewer.pubkey], 1700000000),
  ];
  const query = t.query.getMockImplementation();
  if (!query) throw new Error("Missing query fixture");
  t.query.mockImplementation(async (filters) => [
    ...(await query(filters)),
    ...events.filter((event) =>
      filters.some((filter) => matchesEvent(event, filter)),
    ),
  ]);
  await act(async () => t.session.channels.refreshList?.());
  await vi.waitFor(() =>
    expect(
      t.session.channels.list().channels.find((item) => item.id === destination)
        ?.members,
    ).toContain(t.viewer.pubkey),
  );
  expect(screen.getByRole("region", { name: "Your agents" })).toBeVisible();
  expect(screen.queryByRole("region", { name: "Channels" })).toBeNull();
  const input = screen.getByRole("searchbox");
  await t.user.type(input, "Plan");
  const channels = await screen.findByRole("region", { name: "Channels" });
  expect(
    within(channels).getByRole("button", { name: "Share #Planning" }),
  ).toBeVisible();
  await t.user.clear(input);
  expect(screen.queryByRole("region", { name: "Channels" })).toBeNull();
  expect(screen.getByRole("region", { name: "Your agents" })).toBeVisible();
  await t.user.type(input, " ");
  expect(screen.queryByRole("region", { name: "Channels" })).toBeNull();
  expect(t.publish).not.toHaveBeenCalled();
});

it("gives Solo the channel invitation groups, ranking and independent four-row expansion", async () => {
  const t = await setup("solo", false, true);
  const client = Array.from({ length: 5 }, (_, index) => ({
    ...t.agent,
    pubkey: keypair().pubkey,
    name: `Helper client ${index}`,
  }));
  const saved = Array.from({ length: 5 }, (_, index) => ({
    pubkey: keypair().pubkey,
    name: `Helper saved ${index}`,
  }));
  const chosen = saved[4];
  const admitted = saved[0];
  if (!chosen || !admitted) throw new Error("Missing saved agent fixture");
  const outsider = profile(keypair(), {
    name: "Helper outsider",
    is_agent: true,
  });
  const person = profile(t.person, { name: "Helper person" });
  t.readAgentLibrary.mockResolvedValue({ definitions: [], identities: saved });
  recordChoice(
    t.session.scope,
    pickerText("channel-members", "helper"),
    personKey(chosen.pubkey),
  );
  await act(async () => {
    t.control.set({ agents: client });
    await t.session.agentChoices.refresh();
  });
  const query = t.query.getMockImplementation();
  if (!query) throw new Error("Missing query fixture");
  t.query.mockImplementation(async (filters) =>
    filters.some((filter) => filter.search)
      ? [outsider, person]
      : query(filters),
  );
  const rows = (name: string) =>
    within(screen.getByRole("region", { name })).getAllByRole("button", {
      name: /^Add /,
    });
  expect(rows("Your agents")).toHaveLength(4);
  expect(
    screen.queryByRole("region", { name: "Your other agents" }),
  ).toBeNull();
  expect(
    t.query.mock.calls
      .flatMap(([filters]) => filters)
      .some((filter) => filter.search),
  ).toBe(false);
  const input = screen.getByRole("searchbox");
  await t.user.type(input, "Helper");
  await screen.findByRole("region", { name: "People not in this chat" });
  const invitations = screen.getByRole("region", { name: "Not in this chat" });
  expect(
    within(invitations)
      .getAllByRole("region")
      .map((region) => region.getAttribute("aria-label")),
  ).toEqual(["Your agents", "People not in this chat", "Your other agents"]);
  expect(rows("Your agents")).toHaveLength(4);
  expect(rows("Your other agents")).toHaveLength(4);
  expect(rows("Your other agents")[0]).toHaveAccessibleName(
    /^Add Helper saved 4/,
  );
  expect(
    within(invitations).queryByRole("button", { name: /outsider/ }),
  ).toBeNull();
  await t.user.click(
    within(screen.getByRole("region", { name: "Your agents" })).getByRole(
      "button",
      { name: "Show more" },
    ),
  );
  expect(rows("Your agents")).toHaveLength(5);
  expect(rows("Your other agents")).toHaveLength(4);
  await t.user.click(
    within(screen.getByRole("region", { name: "Your other agents" })).getByRole(
      "button",
      { name: "Show more" },
    ),
  );
  expect(rows("Your other agents")).toHaveLength(5);
  await t.user.clear(input);
  expect(rows("Your agents")).toHaveLength(4);
  expect(
    screen.queryByRole("region", { name: "Your other agents" }),
  ).toBeNull();
  await t.user.type(input, "Helper saved");
  await t.user.click(
    await screen.findByRole("button", { name: /^Add Helper saved 0/ }),
  );
  await screen.findByText("Helper saved 0 added.");
  expect(
    readSearchUsage(t.session.scope).pick(
      pickerText("channel-members", "helper saved"),
      new Set(saved.map((agent) => personKey(agent.pubkey))),
    ),
  ).toBe(personKey(admitted.pubkey));
  expect(input).toHaveValue("");
  expect(screen.queryByRole("region", { name: "Not in this chat" })).toBeNull();
  expect(t.publish.mock.calls.map(([event]) => event.kind)).toEqual([9000]);
});

it("reveals Solo directory continuations in their group and resets expansion on refresh", async () => {
  const t = await setup("solo", false, true);
  const people = Array.from({ length: 31 }, (_, index) =>
    profile(keypair(), { name: `Helper person ${index}` }),
  );
  const query = t.query.getMockImplementation();
  if (!query) throw new Error("Missing query fixture");
  t.query.mockImplementation(async (filters) => {
    const search = filters.find((filter) => filter.search);
    return search
      ? search.page === 2
        ? people.slice(30)
        : people.slice(0, 30)
      : query(filters);
  });
  await t.user.type(screen.getByRole("searchbox"), "Helper");
  const peopleGroup = await screen.findByRole("region", {
    name: "People not in this chat",
  });
  const rows = () =>
    within(peopleGroup).getAllByRole("button", { name: /^Add / });
  expect(rows()).toHaveLength(4);
  await t.user.click(
    within(peopleGroup).getByRole("button", { name: "Show more" }),
  );
  expect(rows()).toHaveLength(8);
  await t.user.click(screen.getByRole("button", { name: "Find more matches" }));
  await vi.waitFor(() => expect(rows()).toHaveLength(31));
  expect(
    screen.queryByRole("button", { name: "Find more matches" }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "Retry member data" }),
  ).toBeVisible();
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  await t.user.click(screen.getByRole("button", { name: "Retry member data" }));
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  expect(rows()).toHaveLength(4);
  expect(t.publish).not.toHaveBeenCalled();
});

it.each([false, true])(
  "hides Solo idle invitations with a second member (agent: %s), while search still offers them",
  async (agent) => {
    const t = await setup("solo", false, agent);
    t.confirmRoster();
    await act(async () => {
      await t.session.channels.refreshRoster?.(
        "11111111-1111-4111-8111-111111111111",
      );
    });
    expect(
      screen.queryByRole("region", { name: "Not in this chat" }),
    ).toBeNull();
    await act(async () =>
      t.control.set({
        agents: [
          { ...t.agent, pubkey: keypair().pubkey, name: "Fixture helper" },
        ],
      }),
    );
    const input = screen.getByRole("searchbox");
    await t.user.type(input, "Fixture");
    await screen.findByRole("region", { name: "Your agents" });
    await t.user.clear(input);
    expect(
      screen.queryByRole("region", { name: "Not in this chat" }),
    ).toBeNull();
    await t.user.type(input, " ");
    expect(
      screen.queryByRole("region", { name: "Not in this chat" }),
    ).toBeNull();
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it.each(["private", "public"] as const)(
  "adds the Solo owner's agent as Bot in a %s chat with a Guest default",
  async (visibility) => {
    const t = await setup("solo", false, true, undefined, undefined, {
      visibility,
      joinRole: "guest",
    });
    await t.user.type(screen.getByRole("searchbox"), "Fixture agent");
    await t.user.click(
      await screen.findByRole("button", { name: /Add Fixture agent/ }),
    );
    await screen.findByText("Fixture agent added.");
    expect(t.publish).toHaveBeenCalledOnce();
    expect(t.publish.mock.calls[0]?.[0].tags).toContainEqual(["role", "bot"]);
  },
);

it("routes a Solo owner's person and agent additions through their own paths", async () => {
  const t = await setup("solo", false, true);
  const input = screen.getByRole("searchbox", {
    name: "Search people, agents and channels",
  });
  await t.user.type(input, "Morgan");
  await t.user.click(
    await screen.findByRole("button", { name: /^Add Morgan/ }),
  );
  await screen.findByText(/Morgan is in the chat\./);
  await t.user.clear(input);
  await t.user.type(input, "Fixture agent");
  await t.user.click(
    await screen.findByRole("button", { name: /Add Fixture agent/ }),
  );
  await screen.findByText("Fixture agent added.");
  expect(
    t.publish.mock.calls.map(([event]) => [
      event.kind,
      event.tags.find(([tag]) => tag === "p")?.[1],
    ]),
  ).toEqual([
    [9000, t.person.pubkey],
    [9000, t.agent.pubkey],
  ]);
});

it("Solo agent search keeps the query after a rejected addition, then retries the same event", async () => {
  const t = await setup("solo", false, true);
  const input = screen.getByRole("searchbox");
  await t.user.type(input, "Fixture");
  t.fail("Permission denied");
  await t.user.click(
    await screen.findByRole("button", { name: /Add Fixture agent/ }),
  );
  await screen.findByText(/Fixture agent: Permission denied/);
  expect(input).toHaveValue("Fixture");
  expect(screen.queryByText("Fixture agent added.")).not.toBeInTheDocument();
  const original = t.publish.mock.calls[0]?.[0].id;
  t.fail("");
  await t.user.click(screen.getByRole("button", { name: /^Retry adding / }));
  await screen.findByText("Fixture agent added.");
  expect(t.publish.mock.calls.map(([event]) => event.kind)).toEqual([
    9000, 9000,
  ]);
  expect(t.publish.mock.calls[1]?.[0].id).toBe(original);
});

it("withholds Solo agent additions from a shared viewer", async () => {
  const t = await setup("shared-solo", false, true);
  expect(
    screen.queryByText(/Adding an agent won’t start a run/),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("region", { name: "Not in this chat" }),
  ).not.toBeInTheDocument();
  await t.user.type(screen.getByRole("searchbox"), "Fixture");
  expect(
    screen.queryByRole("button", { name: /Add Fixture agent/ }),
  ).not.toBeInTheDocument();
  expect(t.publish).not.toHaveBeenCalled();
});

it("closing Solo members during an addition keeps the confirmed roster discoverable on reopen without a message", async () => {
  const t = await setup("solo", false, true);
  await t.search();
  t.hold();
  await t.user.click(
    await screen.findByRole("button", { name: /Add Fixture agent/ }),
  );
  await vi.waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
  await t.user.click(screen.getByRole("button", { name: "Close" }));
  await act(async () => t.release());
  await t.user.click(t.trigger);
  // The add's receipt can settle after close; Refresh reads the authoritative roster.
  expect(
    screen.getByRole("button", { name: "Retry member data" }),
  ).toBeVisible();
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  await t.user.click(screen.getByRole("button", { name: "Retry member data" }));
  await screen.findByRole("heading", { name: "Agents · 1" });
  expect(t.publish.mock.calls.map(([event]) => event.kind)).toEqual([9000]);
});

it("does not offer archived agents for Solo admission", async () => {
  const t = await setup("solo", false, true, undefined, undefined, {
    archivedAgent: true,
  });
  await vi.waitFor(() =>
    expect(t.session.archives.snapshot().status).toBe("ready"),
  );
  expect(
    screen.queryByRole("button", { name: /Add Fixture agent/ }),
  ).not.toBeInTheDocument();
  await t.user.type(screen.getByRole("searchbox"), "Fixture");
  expect(
    screen.queryByRole("button", { name: /Add Fixture agent/ }),
  ).not.toBeInTheDocument();
  expect(t.publish).not.toHaveBeenCalled();
});

it("does not offer Solo agent additions when the existing admission API is unavailable", async () => {
  const t = await setup("solo", false, true, undefined, undefined, {
    channelCreation: false,
  });
  expect(
    screen.queryByText(/Adding an agent won’t start a run/),
  ).not.toBeInTheDocument();
  await t.user.type(screen.getByRole("searchbox"), "Fixture");
  expect(
    screen.queryByRole("button", { name: /Add Fixture agent/ }),
  ).not.toBeInTheDocument();
  expect(t.publish).not.toHaveBeenCalled();
});

it.each([false, true])(
  "reads roster and general access after sign-in without replaying writes (sign-in before access refusal: %s)",
  async (signInBeforeRefusal) => {
    const t = await setup("stream", true);
    t.fail("Invitation denied");
    await t.user.click(await t.search());
    await screen.findByText(/Invitation denied/);
    const publishes = t.publish.mock.calls.length;
    const query = t.query.getMockImplementation();
    if (!query) throw new Error("Missing query fixture");
    t.query.mockImplementation(async (filters, ...rest) => {
      if (filters.some((filter) => filter.kinds?.includes(39002)))
        throw new Error("Federated sign-in is required");
      return query(filters, ...rest);
    });
    const id = "11111111-1111-4111-8111-111111111111";
    const details = {
      channelId: id,
      version: "v1",
      name: "Design",
      description: "",
      visibility: "private" as const,
      joinRole: "guest" as const,
      canEdit: true,
    };
    let refuse!: (reason: Error) => void;
    const initial = new Promise<typeof details>((_, reject) => {
      refuse = reject;
    });
    const load = vi
      .fn(async () => details)
      .mockImplementationOnce(() => initial);
    const save = vi.fn(async () => {});
    const check = vi.fn(async () => {});
    cleanup();
    try {
      render(
        <ToastProvider>
          <ChannelMembersButton
            session={{
              ...t.session,
              channelDetails: {
                available: true,
                load,
                save,
                check,
                snapshot: () => undefined,
                subscribe: () => () => {},
              },
            }}
            channelId={id}
          />
        </ToastProvider>,
      );
      await t.user.click(screen.getByRole("button", { name: "Access" }));
      await screen.findByText(/The member list could not load/);
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
      const control = screen.getByRole("combobox", { name: "General access" });
      expect(control).toBeDisabled();
      t.query.mockImplementation(query);
      if (signInBeforeRefusal) act(() => t.session.recovery?.retryAll());
      act(() => refuse(new Error("Federated sign-in is required")));
      if (!signInBeforeRefusal) {
        await screen.findByText("Federated sign-in is required");
        act(() => t.session.recovery?.retryAll());
      }
      await vi.waitFor(() => expect(control).toBeEnabled());
      expect(control).toHaveTextContent("Private");
      expect(load).toHaveBeenCalledTimes(2);
      await vi.waitFor(() =>
        expect(
          screen.queryByText(/The member list could not load/),
        ).not.toBeInTheDocument(),
      );
      expect(
        screen.queryByRole("group", { name: "General access recovery" }),
      ).not.toBeInTheDocument();
      expect(t.publish.mock.calls.length).toBe(publishes);
      expect(save).not.toHaveBeenCalled();
      expect(check).not.toHaveBeenCalled();
    } finally {
      refuse(new Error("Fixture released"));
    }
  },
);

it.each(["public", "private"] as const)(
  "shows personal contribution roles and %s General access in the members dialog",
  async (visibility) => {
    const h = await setup();
    cleanup();
    const id = "11111111-1111-4111-8111-111111111111";
    let role = "member";
    const query = h.query.getMockImplementation();
    if (!query) throw new Error("Missing query");
    h.query.mockImplementation(async (filters) => [
      ...(await query(filters)).map((event) =>
        event.kind === 39002
          ? signed(h.relay, {
              ...event,
              created_at: event.created_at + (role === "member" ? 1 : 2),
              tags: [
                ["d", id],
                ["p", h.viewer.pubkey, "", role],
              ],
            })
          : event,
      ),
      signed(h.relay, { kind: 39001, content: "", tags: [["d", id]] }),
    ]);
    const details = {
      channelId: id,
      version: "v1",
      name: "Channel",
      description: "",
      visibility,
      joinRole: "guest" as const,
      canEdit: true,
    };
    const save = vi.fn(async () => {});
    render(
      <ToastProvider>
        <ChannelMembersButton
          session={{
            ...h.session,
            channelDetails: {
              available: true,
              load: async () => details,
              save,
              check: async () => {},
              snapshot: () => undefined,
              subscribe: () => () => {},
            },
          }}
          channelId={id}
        />
      </ToastProvider>,
    );
    await h.user.click(screen.getByRole("button", { name: "Access" }));
    expect(
      await screen.findByRole("region", { name: "General access" }),
    ).toBeVisible();
    await vi.waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "General access" }),
      ).toBeEnabled(),
    );
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    expect(
      screen.getByRole("combobox", { name: "General access" }),
    ).toHaveTextContent(visibility === "public" ? "View only" : "Private");
    const access = screen.getByRole("combobox", { name: "General access" });
    const done = screen.getByRole("button", { name: "Done" });
    const copy = screen.getByRole("button", { name: "Copy link" });
    expect(copy.closest("footer")).toContainElement(done);
    expect(access.closest("footer")).toBeNull();
    const search = screen.getByRole("searchbox");
    expect(
      screen.getByRole("region", { name: "General access" }).parentElement,
    ).toBe(screen.getByRole("region", { name: "Member list" }));
    expect(
      search.compareDocumentPosition(access) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(access).toHaveAttribute("data-size", "sm");
    expect(
      access.compareDocumentPosition(done) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    if (visibility === "private") {
      expect(
        screen.queryByText("Only people you add can read this channel."),
      ).not.toBeInTheDocument();
    }
    await vi.waitFor(() => {
      const members = h.session.memberAdministration.snapshot(id);
      expect(members.status).toBe("ready");
      expect(members.authority.roles[h.viewer.pubkey]).toBe("member");
      expect(memberData()).toHaveAttribute("data-refreshing", "false");
      expect(within(memberData()).getByText("Carl (you)")).toBeVisible();
    });
    expect(within(memberData()).queryAllByText("Participating")).toHaveLength(
      0,
    );
    role = "guest";
    await h.user.click(screen.getByRole("button", { name: "Close" }));
    await h.user.click(screen.getByRole("button", { name: "Access" }));
    expect(
      await within(
        screen.getByRole("region", { name: "Member list" }),
      ).findByText("Viewing only"),
    ).toBeVisible();
    expect(save).not.toHaveBeenCalled();
  },
);

it.each([
  { solo: false, guest: false, joinRole: "guest" },
  { solo: false, guest: true, joinRole: "guest" },
  { solo: true, guest: false, joinRole: "guest" },
  { solo: true, guest: true, joinRole: "guest" },
  { solo: true, guest: false, joinRole: "member" },
] as const)(
  "reads preview rosters without joining or editing (Solo: $solo, Guest: $guest, admission: $joinRole)",
  async ({ solo, guest, joinRole }) => {
    const participation =
      guest || joinRole === "guest"
        ? "Viewing only. Ask an owner or admin to participate."
        : "New people can participate. People already in the channel keep their access.";
    const id = "11111111-1111-4111-8111-111111111111";
    const viewer = keypair(),
      relay = keypair(),
      owner = keypair();
    const events = [
      signed(relay, {
        kind: 39000,
        content: "",
        tags: [
          ["d", id],
          ["t", "stream"],
          ["public"],
          ["name", "Reading room"],
          ["join_role", joinRole],
          ...(solo
            ? [
                ["t", SOLO_LABEL],
                ["P", owner.pubkey],
              ]
            : []),
        ],
      }),
      signed(relay, {
        kind: 39001,
        content: "",
        tags: [
          ["d", id],
          ["p", owner.pubkey, "owner"],
        ],
      }),
      signed(relay, {
        kind: 39002,
        content: "",
        tags: [
          ["d", id],
          ["p", owner.pubkey, "", "owner"],
          ...(guest ? [["p", viewer.pubkey, "", "guest"]] : []),
        ],
      }),
      profile(owner, { name: "Channel owner" }),
    ];
    const publish = vi.fn(async () => {});
    const sign = async (template: Parameters<typeof signed>[1]) =>
      signed(viewer, template);
    const connection = createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        media: () => undefined,
        query: async (filters) =>
          events.filter((event) =>
            filters.some((filter) => matchesEvent(event, filter)),
          ),
        writer: { kinds: [9, 9000], sign, publish },
        channelDetails: { sign, publish },
        readAgentLibrary: async () => ({ definitions: [], identities: [] }),
      },
      {
        outboxStorage: { load: () => [], save: () => {} },
        agentChoices: localAgentsFixture([]),
      },
    );
    stops.push(connection.dispose);
    const session = connection.session;
    session.channels.ensureList();
    await vi.waitFor(() =>
      expect(session.channels.list().status).toBe("ready"),
    );
    await session.channels.resolve?.([id]);
    expect(session.channels.get?.(id)?.readOnly).toBe(true);
    const load = vi.fn(session.channelDetails.load);
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <ChannelMembersButton
          session={{
            ...session,
            channelDetails: { ...session.channelDetails, load },
          }}
          channelId={id}
        />
      </ToastProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Access" }));
    expect(await screen.findByText(participation)).toBeVisible();
    expect(
      screen.queryByText("You have read-only access to this channel."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Join this channel/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reload access" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "General access" }),
    ).toHaveTextContent("Anyone in the community can read.");
    expect(
      screen.getByRole("region", { name: "General access" }),
    ).toHaveTextContent(participation);
    // Finish the roster read before checking that the dialog cannot invite or mutate.
    await vi.waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Member list" }),
      ).toHaveAttribute("data-refreshing", "false"),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "People" })).toHaveTextContent(
      "Channel owner",
    );
    expect(
      screen.getByRole("searchbox", {
        name: solo ? "Search people and channels" : "Search people and agents",
      }),
    ).toHaveAttribute("placeholder", "Search members");
    expect(load).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  },
);

it("pages a large roster without waiting for optional names or exceeding the profile request budget", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const t = await setup("stream", false, false, undefined, undefined, {
      extraMembers: 1024,
      pendingMemberNames: pending,
    });
    const list = screen.getByRole("region", {
      name: "Member list",
    });
    expect(within(list).getAllByRole("listitem")).toHaveLength(50);
    expect(screen.queryByText("Loading members…")).not.toBeInTheDocument();
    const pages = within(list).getByRole("navigation", {
      name: "People member pages",
    });
    expect(
      within(pages).getByRole("button", { name: "Previous" }),
    ).toBeDisabled();
    await t.user.click(within(pages).getByRole("button", { name: "Next" }));
    expect(within(pages).getByText("2 of 21")).toBeVisible();
    expect(within(list).getAllByRole("listitem")).toHaveLength(50);
    await act(async () => release());
    await vi.waitFor(() =>
      expect(memberData()).toHaveAttribute("data-refreshing", "false"),
    );
    const batches = t.query.mock.calls
      .flatMap(([filters]) => filters)
      .filter((filter) => filter.kinds?.includes(0) && filter.authors?.length);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every((filter) => (filter.authors?.length ?? 0) <= 50)).toBe(
      true,
    );
    expect(
      screen.queryByText(/Some names could not load/),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: (11023).toString(16).padStart(64, "0") },
    });
    await vi.waitFor(() =>
      expect(within(list).getAllByRole("listitem")).toHaveLength(1),
    );
    await t.user.clear(screen.getByRole("searchbox"));
    await vi.waitFor(() =>
      expect(within(list).getByText("1 of 21")).toBeVisible(),
    );
  } finally {
    await act(async () => release());
  }
});

it("keeps the current member page through live removals and clamps a shortened roster", async () => {
  const t = await setup("stream", false, false, undefined, undefined, {
    extraMembers: 125,
  });
  await act(async () => t.session.profiles.ensure([t.viewer.pubkey]));
  const keys = Array.from({ length: 125 }, (_, i) =>
    (i + 10000).toString(16).padStart(64, "0"),
  );
  const pages = () =>
    screen.getByRole("navigation", { name: "People member pages" });
  const rows = () =>
    within(screen.getByRole("region", { name: "Member list" }))
      .getAllByRole("listitem")
      .map((row) => row.textContent);
  await t.user.click(within(pages()).getByRole("button", { name: "Next" }));
  expect(within(pages()).getByText("2 of 3")).toBeVisible();
  expect(within(pages()).getByText("2 of 3")).toHaveTextContent("Page 2 of 3");
  await act(async () => t.replaceRoster([t.viewer.pubkey, ...keys.slice(1)]));
  expect(within(pages()).getByText("2 of 3")).toBeVisible();
  await t.user.click(within(pages()).getByRole("button", { name: "Next" }));
  expect(within(pages()).getByText("3 of 3")).toBeVisible();
  await act(async () =>
    t.replaceRoster([t.viewer.pubkey, ...keys.slice(1, 75)]),
  );
  expect(within(pages()).getByText("2 of 2")).toBeVisible();
  expect(within(pages()).getByRole("button", { name: "Next" })).toBeDisabled();
  const clampedRows = rows();
  await act(async () => t.replaceRoster([t.viewer.pubkey, ...keys.slice(1)]));
  expect(within(pages()).getByText("2 of 3")).toBeVisible();
  expect(rows()).toHaveLength(50);
  expect(rows().slice(0, clampedRows.length)).toEqual(clampedRows);
  await t.user.click(within(pages()).getByRole("button", { name: "Previous" }));
  await t.user.click(within(pages()).getByRole("button", { name: "Next" }));
  await act(async () =>
    t.replaceRoster([t.viewer.pubkey, ...keys.slice(1, 25)]),
  );
  const shortenedRows = rows();
  await act(async () => t.replaceRoster([t.viewer.pubkey, ...keys.slice(1)]));
  expect(within(pages()).getByText("1 of 3")).toBeVisible();
  expect(rows()).toHaveLength(50);
  expect(rows().slice(0, shortenedRows.length)).toEqual(shortenedRows);
});

it.each([true, false])(
  "finds an unvisited member by name (member writes: %s)",
  async (memberWrites) => {
    const matches: RelayEvent[] = [];
    const otherMatches = Array.from({ length: 30 }, (_, i) =>
      profile(keypair(), { name: `Aardvark outsider ${i}` }),
    );
    const memberProfiles = Array.from({ length: 75 }, (_, i) =>
      profile(keypair(), { name: `Aardvark member ${i}` }),
    );
    const t = await setup("stream", false, false, undefined, undefined, {
      memberProfiles,
      memberWrites,
      searchProfiles: async (_query, _limit, page) =>
        !memberWrites && page === 1 ? otherMatches : matches,
    });
    await vi.waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Member list" }),
      ).toHaveAttribute("data-refreshing", "false"),
    );
    const target =
      memberProfiles.find(
        (event) => !t.session.profiles.snapshot().has(event.pubkey),
      ) ?? memberProfiles[0];
    if (!target) throw new Error("Missing member fixture");
    const name = JSON.parse(target.content).name as string;
    matches.push(target);
    await t.user.type(screen.getByRole("searchbox"), name);
    if (!memberWrites)
      await t.user.click(
        await screen.findByRole("button", { name: "Find more matches" }),
      );
    await within(
      screen.getByRole("region", { name: "Member list" }),
    ).findByText(nameText(name));
  },
);

it("loads another member page after a previous page fails", async () => {
  const t = await setup("stream", false, false, undefined, undefined, {
    extraMembers: 749,
  });
  const data = memberData();
  await vi.waitFor(() =>
    expect(data).toHaveAttribute("data-refreshing", "false"),
  );
  const original = t.query.getMockImplementation();
  if (!original) throw new Error("Missing query fixture");
  t.query.mockImplementation(async (filters) => {
    if (filters.some((filter) => filter.kinds?.includes(0)))
      throw new Error("Names unavailable");
    return original(filters);
  });
  const next = within(
    screen.getByRole("navigation", { name: "People member pages" }),
  ).getByRole("button", { name: "Next" });
  await t.user.click(next);
  await screen.findByText(/Some names could not load/);
  await vi.waitFor(() =>
    expect(data).toHaveAttribute("data-refreshing", "false"),
  );
  const before = t.query.mock.calls.length;
  t.query.mockImplementation(original);
  await t.user.click(next);
  await vi.waitFor(() =>
    expect(data).toHaveAttribute("data-refreshing", "false"),
  );
  expect(t.query.mock.calls.length).toBeGreaterThan(before);
  expect(
    screen.queryByText(/Some names could not load/),
  ).not.toBeInTheDocument();
});

it("keeps the visible member page and focus stable while names arrive", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const memberProfiles = Array.from({ length: 125 }, (_, i) =>
    profile(keypair(), {
      name: `Member ${String(i).padStart(3, "0")}`,
      is_agent: true,
    }),
  );
  try {
    const t = await setup("stream", false, false, undefined, undefined, {
      memberProfiles,
      pendingMemberNames: pending,
    });
    const list = screen.getByRole("region", { name: "Member list" });
    const pages = within(list).getByRole("navigation", {
      name: "People member pages",
    });
    await t.user.click(within(pages).getByRole("button", { name: "Next" }));
    const rows = within(list).getAllByRole("listitem");
    const first = rows[0];
    if (!first) throw new Error("Missing first member row");
    const focused = within(first).getAllByRole("button")[0];
    if (!focused) throw new Error("Missing member action");
    focused.focus();
    await act(async () => release());
    await vi.waitFor(() =>
      expect(memberData()).toHaveAttribute("data-refreshing", "false"),
    );
    expect(
      [...t.session.profiles.snapshot().values()].some((profile) =>
        profile.name.startsWith("Member "),
      ),
    ).toBe(true);
    const loadedRows = within(list).getAllByRole("listitem");
    expect(loadedRows).toHaveLength(rows.length);
    expect(loadedRows.every((row, i) => row === rows[i])).toBe(true);
    expect(focused).toHaveFocus();
    expect(within(list).getAllByText(/^Member /).length).toBeGreaterThan(0);
    await t.user.click(screen.getByRole("button", { name: "Close" }));
    await t.user.click(screen.getByRole("button", { name: "Access" }));
    await within(memberData()).findByRole("heading", { name: /^Agents ·/ });
  } finally {
    await act(async () => release());
  }
});

const retainedMemberProfiles = Array.from({ length: 1100 }, (_, i) =>
  profile(keypair(), { name: `Member ${String(i).padStart(4, "0")}` }),
);
it("keeps named members in order through live roster changes", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const t = await setup("stream", false, false, undefined, undefined, {
      memberProfiles: retainedMemberProfiles,
      pendingMemberNames: pending,
    });
    const pages = screen.getByRole("navigation", {
      name: "People member pages",
    });
    await t.user.click(within(pages).getByRole("button", { name: "Next" }));
    await act(async () => release());
    await vi.waitFor(() =>
      expect(memberData()).toHaveAttribute("data-refreshing", "false"),
    );
    const rows = () => within(memberData()).getAllByRole("listitem");
    const before = rows();
    const first = before[0];
    if (!first) throw new Error("Missing member row");
    const focused = within(first).getAllByRole("button")[0];
    if (!focused) throw new Error("Missing member action");
    focused.focus();
    const removed = retainedMemberProfiles.find(
      (event) => !t.session.profiles.snapshot().has(event.pubkey),
    );
    if (!removed) throw new Error("Missing off-page member");
    const keys = [
      t.viewer.pubkey,
      ...retainedMemberProfiles.map((event) => event.pubkey),
    ];
    await act(async () =>
      t.replaceRoster(keys.filter((key) => key !== removed.pubkey)),
    );
    await vi.waitFor(() =>
      expect(memberData()).toHaveAttribute("data-refreshing", "false"),
    );
    expect(within(pages).getByText("2 of 22")).toBeVisible();
    expect(rows().every((row, i) => row === before[i])).toBe(true);
    expect(focused).toHaveFocus();
    await act(async () => t.replaceRoster(keys));
    await vi.waitFor(() =>
      expect(memberData()).toHaveAttribute("data-refreshing", "false"),
    );
    expect(rows().every((row, i) => row === before[i])).toBe(true);
    expect(focused).toHaveFocus();
  } finally {
    await act(async () => release());
  }
});

const retainedTimelineProfiles = Array.from({ length: 20 }, (_, i) =>
  profile(keypair(), { name: `Timeline ${i}` }),
);

it("retains visible and unrelated profiles when opening a roster above directory capacity", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const memberProfiles = retainedMemberProfiles;
  const timeline = retainedTimelineProfiles;
  try {
    const t = await setup("stream", false, false, undefined, undefined, {
      memberProfiles,
      pendingMemberNames: pending,
    });
    const original = t.query.getMockImplementation();
    if (!original) throw new Error("Missing query fixture");
    t.query.mockImplementation(async (filters) =>
      filters.some((filter) =>
        filter.authors?.includes(timeline[0]?.pubkey ?? ""),
      )
        ? timeline
        : original(filters),
    );
    await act(async () => {
      await t.session.profiles.ensure(timeline.map((event) => event.pubkey));
    });
    await act(async () => release());
    await vi.waitFor(() =>
      expect(memberData()).toHaveAttribute("data-refreshing", "false"),
    );
    expect(
      timeline.every((event) =>
        t.session.profiles.snapshot().has(event.pubkey),
      ),
    ).toBe(true);
    const list = screen.getByRole("region", { name: "Member list" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .every((row) => /Member |Carl/.test(row.textContent ?? "")),
    ).toBe(true);
    const pages = within(list).getByRole("navigation", {
      name: "People member pages",
    });
    await t.user.click(within(pages).getByRole("button", { name: "Next" }));
    await vi.waitFor(() =>
      expect(memberData()).toHaveAttribute("data-refreshing", "false"),
    );
    expect(
      within(list)
        .getAllByRole("listitem")
        .every((row) => /Member |Carl/.test(row.textContent ?? "")),
    ).toBe(true);
    await t.user.click(within(pages).getByRole("button", { name: "Previous" }));
    await vi.waitFor(() =>
      expect(memberData()).toHaveAttribute("data-refreshing", "false"),
    );
    expect(
      within(list)
        .getAllByRole("listitem")
        .every((row) => /Member |Carl/.test(row.textContent ?? "")),
    ).toBe(true);
    expect(
      timeline.every((event) =>
        t.session.profiles.snapshot().has(event.pubkey),
      ),
    ).toBe(true);
  } finally {
    await act(async () => release());
  }
});

it("hides search feedback until the initial roster is available", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const results = Array.from({ length: 30 }, (_, i) =>
    profile(keypair(), { name: `Zed ${i}` }),
  );
  const searchProfiles = vi.fn(async () => results);
  try {
    const t = await setup("stream", false, false, undefined, undefined, {
      pendingMemberNames: pending,
      searchProfiles,
    });
    await t.user.type(screen.getByRole("searchbox"), "Zed");
    await vi.waitFor(() => expect(searchProfiles).toHaveBeenCalled());
    // Flush the completed search while the independent roster read stays held.
    await act(async () => {
      await searchProfiles.mock.results[0]?.value;
    });
    expect(
      screen.getByRole("status", { name: "Loading members" }),
    ).toBeVisible();
    expect(screen.queryByText("Searching…")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Find more matches" }),
    ).not.toBeInTheDocument();
    await act(async () => release());
    expect(
      await screen.findByRole("button", { name: "Find more matches" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("status", { name: "Loading members" }),
    ).not.toBeInTheDocument();
  } finally {
    await act(async () => release());
  }
});

it.each([0, 75])(
  "filters broad relay hits by member name fields (extra members: %s)",
  async (extraMembers) => {
    const unrelated = profile(keypair(), {
      name: "Unrelated member",
      about: "ZeldaUnique in biography",
    });
    const named = profile(keypair(), { name: "ZeldaUnique Person" });
    const alias = profile(keypair(), {
      name: "ZeldaUniqueHandle",
      display_name: "Different display",
    });
    const memberProfiles = [unrelated, named, alias];
    const t = await setup("stream", false, false, undefined, undefined, {
      extraMembers,
      memberProfiles,
      searchProfiles: async (query) =>
        query === "ZeldaUnique" ? memberProfiles : [],
    });
    await vi.waitFor(() =>
      expect(memberData()).toHaveAttribute("data-refreshing", "false"),
    );
    await t.user.type(screen.getByRole("searchbox"), "ZeldaUnique");
    const list = screen.getByRole("region", { name: "Member list" });
    await within(list).findByText(nameText("Different display"));
    expect(
      within(list).getByText(nameText("ZeldaUnique Person")),
    ).toBeVisible();
    expect(
      within(list).queryByText(nameText("Unrelated member")),
    ).not.toBeInTheDocument();
  },
);
