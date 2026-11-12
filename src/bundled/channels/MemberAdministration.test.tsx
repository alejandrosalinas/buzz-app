// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { canonicalPublicKey } from "../../shared/identity/public-key";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import { keypair, profile, signed } from "../../features/relay/testing";
import { matchesEvent } from "../../features/relay/projection";
import type { RelayEvent } from "../../features/relay/events";
import { PublishRejected } from "../../features/relay/outbox";
import type {
  Presence,
  PresenceStatus,
} from "../../features/presence/presence";
import { ChannelMembersButton } from "./ChannelMembersDialog";
import { ToastProvider } from "../../shared/design-system/ui/Toast";

const stops: (() => void)[] = [];
const memberData = () => screen.getByRole("region", { name: "Member list" });
beforeEach(() => {
  // jsdom has no top layer; browser tests own popup paint and hit testing.
  HTMLElement.prototype.showPopover = function () {
    this.style.display = "block";
  };
  // jsdom lacks scrollIntoView; the search highlight keeps its row in view.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  for (const stop of stops.splice(0)) stop();
});
const id = "11111111-1111-4111-8111-111111111111";
async function setup(
  actor = "owner",
  targetRole = "member",
  supported = true,
  roleRead?: Promise<void>,
  targetAgent = false,
  presence?: Presence,
  messageSupport = false,
  messageNavigation = true,
  initialReads?: { names?: Promise<void>; roster?: Promise<void> },
  ownership?: "own" | "other" | "invalid",
  visibility: "private" | "public" = "private",
  targetPicture?: string,
) {
  const viewer = keypair(),
    relay = keypair(),
    target = keypair(),
    owner = keypair();
  const manager = ownership === "other" ? owner : viewer;
  const digest = new Uint8Array(
    createHash("sha256").update(`nostr:agent-auth:${target.pubkey}:`).digest(),
  );
  const profileBody = {
    name: "Morgan",
    is_agent: targetAgent,
    picture: targetPicture,
  };
  const targetProfile = ownership
    ? signed(target, {
        kind: 0,
        content: JSON.stringify(profileBody),
        tags: [
          [
            "auth",
            manager.pubkey,
            "",
            bytesToHex(
              schnorr.sign(
                digest,
                ownership === "invalid" ? target.secret : manager.secret,
              ),
            ),
          ],
        ],
      })
    : profile(target, profileBody);
  const viewerProfile = profile(viewer, { name: "Carl" });
  const ownerProfile = profile(owner, { name: "Owner" });
  let role: string | undefined =
    targetRole === "absent" ? undefined : targetRole;
  let tick = 1700000000;
  let lag = false;
  const members = () => [
    [viewer.pubkey, actor],
    [owner.pubkey, "owner"],
    ...(role ? [[target.pubkey, role]] : []),
  ];
  const events = () => [
    signed(relay, {
      kind: 39000,
      created_at: tick,
      content: "",
      tags: [["d", id], ["t", "stream"], [visibility], ["name", "Design"]],
    }),
    signed(relay, {
      kind: 39001,
      created_at: tick,
      content: "",
      tags: [
        ["d", id],
        ...members()
          .filter(([, r]) => r === "owner" || r === "admin")
          .map(([key, r]) => ["p", key ?? "", r ?? ""]),
      ],
    }),
    signed(relay, {
      kind: 39002,
      created_at: tick,
      content: "",
      tags: [
        ["d", id],
        ...members().map(([key, r]) => ["p", key ?? "", "", r ?? ""]),
      ],
    }),
    viewerProfile,
    targetProfile,
    ownerProfile,
  ];
  const publish = vi.fn(async (event: RelayEvent) => {
    if (!lag)
      role =
        event.kind === 9001
          ? undefined
          : event.tags.find(([key]) => key === "role")?.[1];
    tick++;
  });
  const write = vi.fn();
  let dialogReads = false;
  const query = vi.fn(async (filters: Parameters<typeof matchesEvent>[1][]) => {
    if (targetRole === "absent" && filters.some((filter) => filter.search))
      return [targetProfile];
    if (filters.some((filter) => filter.kinds?.includes(39001))) await roleRead;
    if (filters.some((filter) => filter.kinds?.includes(0)))
      await initialReads?.names;
    if (dialogReads && filters.some((filter) => filter.kinds?.includes(39002)))
      await initialReads?.roster;
    return events().filter((event) =>
      filters.some((filter) => matchesEvent(event, filter)),
    );
  });
  const media = vi.fn(
    (url: string, size?: "small") =>
      `https://media.example/${size ?? "original"}?url=${encodeURIComponent(url)}`,
  );
  const sessionOwner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media,
      query,
      ...(supported
        ? {
            memberAdministration: {
              sign: async (template) => signed(viewer, template),
              publish,
            },
          }
        : {}),
      writer: {
        kinds: [9, 9000],
        sign: async (template) => signed(viewer, template),
        publish: write,
      },
    },
    // jsdom has no IndexedDB; plain Add needs a loadable outbox.
    { outboxStorage: { load: () => [], save: () => {} } },
  );
  stops.push(sessionOwner.dispose);
  const session = sessionOwner.session;
  session.channels.ensureList();
  await vi.waitFor(() => expect(session.channels.list().status).toBe("ready"), {
    interval: vi.isFakeTimers() ? 50 : 1,
  });
  const onOpenLink = vi.fn(() => true);
  const onOpenConversation = vi.fn(() => true);
  const openMessage = vi.fn(
    async (_keys: readonly string[], _signal: AbortSignal) => "dm-1",
  );
  const presentedSession = {
    ...session,
    ...(presence ? { presence } : {}),
    directMessages: {
      ...session.directMessages,
      available: messageSupport,
      open: openMessage,
    },
  };
  const button = (shown: typeof presentedSession) => (
    <ToastProvider>
      <ChannelMembersButton
        session={shown}
        channelId={id}
        canOpenLink={() => true}
        onOpenLink={onOpenLink}
        onOpenConversation={messageNavigation ? onOpenConversation : undefined}
      />
    </ToastProvider>
  );
  const view = render(button(presentedSession));
  const user = userEvent.setup();
  dialogReads = true;
  await user.click(screen.getByRole("button", { name: "Access" }));
  if (roleRead || initialReads)
    await screen.findByRole("status", { name: "Loading members" });
  else
    await screen.findByText(targetRole === "absent" ? "Carl (you)" : "Morgan");
  if (!initialReads)
    await vi.waitFor(() =>
      expect(session.memberAdministration.snapshot(id).status).toBe(
        roleRead ? "loading" : "ready",
      ),
    );
  return {
    user,
    session,
    publish,
    write,
    query,
    onOpenLink,
    onOpenConversation,
    openMessage,
    target,
    viewer,
    relay,
    /** A replaced session keeps the dialog mounted, as unkeyed hosts do. */
    replaceSession: () => view.rerender(button({ ...presentedSession })),
    lag: () => {
      lag = true;
    },
    confirm: (next: string | undefined) => {
      role = next;
      tick++;
    },
    choose: async (name: string) => {
      await user.click(
        screen.getByRole("button", { name: /^Actions for Morgan$/ }),
      );
      const roleChoice =
        name === "Set as admin"
          ? "Admin"
          : name === "Set to participating"
            ? "Participating"
            : name === "Set to viewing only"
              ? "Viewing only"
              : undefined;
      await user.click(
        roleChoice
          ? await screen.findByRole("menuitemradio", { name: roleChoice })
          : await screen.findByRole("menuitem", { name }),
      );
      expect(onOpenLink).not.toHaveBeenCalled();
      return screen.findByRole("dialog", {
        name:
          name === "Remove from channel"
            ? `Remove ${targetAgent ? "agent" : "member"} from channel`
            : `Change access to ${name === "Set to viewing only" ? "Viewing only" : name === "Set to participating" ? "Participating" : "Admin"}?`,
      });
    },
  };
}
it.each([
  ["owner", "member", true],
  ["owner", "guest", true],
  ["owner", "admin", true],
  ["admin", "guest", false],
  ["admin", "member", false],
  ["admin", "admin", false],
] as const)(
  "lets an %s add someone directly as %s from the split menu (Agent: %s)",
  async (actor, role, agent) => {
    const t = await setup(actor, "absent", true, undefined, agent);
    await t.user.type(screen.getByRole("searchbox"), "Morgan");
    await t.user.click(
      await screen.findByRole("button", { name: /^Add Morgan .* as$/ }),
    );
    await t.user.click(
      await screen.findByRole("menuitem", {
        name:
          role === "guest"
            ? "View only Read messages and threads."
            : role === "member"
              ? "Participate Send messages, reply, and react."
              : "Admin Manage this channel and its members.",
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Add member?" });
    expect(dialog).toHaveAccessibleDescription("Morgan");
    expect(t.publish).not.toHaveBeenCalled();
    const add = within(dialog).getByRole("button", {
      name:
        role === "guest"
          ? "Add with view-only access"
          : role === "member"
            ? "Add to participate"
            : "Add as admin",
    });
    await vi.waitFor(() => expect(add).toHaveFocus());
    await t.user.click(add);
    await vi.waitFor(() =>
      expect(
        t.session.memberAdministration.snapshot(id).operation?.status,
      ).toBe("confirmed"),
    );
    expect(t.publish).toHaveBeenCalledOnce();
    expect(t.publish.mock.calls[0]?.[0].tags).toEqual([
      ["h", id],
      ["p", t.target.pubkey],
      ["role", role],
    ]);
    await vi.waitFor(() => {
      const row = required(screen.getByText("Morgan").closest("li"));
      expect(
        within(row).getByRole("button", { name: /Open profile/ }),
      ).toHaveAccessibleName(new RegExp(`, ${role}$`));
      if (role === "member")
        expect(
          within(row).queryByText("Participating"),
        ).not.toBeInTheDocument();
      else
        expect(row).toHaveTextContent(
          role === "guest" ? "Viewing only" : "Admin",
        );
    });
  },
);

it("cancels an addition from the split menu and retains the search and keyboard focus", async () => {
  const t = await setup("owner", "absent");
  await t.user.type(screen.getByRole("searchbox"), "Morgan");
  const trigger = await screen.findByRole("button", {
    name: /^Add Morgan .* as$/,
  });
  trigger.focus();
  await t.user.keyboard("{Enter}");
  await t.user.click(
    await screen.findByRole("menuitem", {
      name: "Admin Manage this channel and its members.",
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Add member?" });
  await t.user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await vi.waitFor(() => expect(screen.getByRole("searchbox")).toHaveFocus());
  expect(screen.getByRole("searchbox")).toHaveValue("Morgan");
  expect(t.publish).not.toHaveBeenCalled();
  await t.user.click(
    screen.getByRole("button", { name: /^Add Morgan .* as$/ }),
  );
  await t.user.keyboard("{Escape}");
  await vi.waitFor(() =>
    expect(
      screen.getByRole("button", { name: /^Add Morgan .* as$/ }),
    ).toHaveFocus(),
  );
});

it.each(["member", "guest"])(
  "hides role additions from a %s",
  async (actor) => {
    const t = await setup(actor, "absent");
    await t.user.type(screen.getByRole("searchbox"), "Morgan");
    if (actor === "member")
      await screen.findByRole("button", { name: /^Add Morgan \(/ });
    expect(
      screen.queryByRole("button", { name: /^Add Morgan .* as$/ }),
    ).not.toBeInTheDocument();
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it("disables an addition confirmation if the person joins with a different role", async () => {
  const t = await setup("owner", "absent");
  await t.user.type(screen.getByRole("searchbox"), "Morgan");
  await t.user.click(
    await screen.findByRole("button", { name: /^Add Morgan .* as$/ }),
  );
  await t.user.click(
    await screen.findByRole("menuitem", {
      name: "Admin Manage this channel and its members.",
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Add member?" });
  await act(async () => {
    t.confirm("member");
    await t.session.memberAdministration.refresh(id);
  });
  expect(
    within(dialog).getByRole("button", { name: "Add as admin" }),
  ).toBeDisabled();
  expect(t.publish).not.toHaveBeenCalled();
});

it.each([
  ["member", "admin"],
  ["admin", "member"],
  ["owner", "owner"],
  ["admin", "admin"],
  ["member", "guest"],
] as const)(
  "lists people alphabetically with elevated role labels (viewer: %s, target: %s)",
  async (actor, target) => {
    const t = await setup(actor, target);
    expect(memberOrder()).toEqual(["Carl", "Morgan", "Owner"]);
    for (const [name, role] of [
      ["Carl", actor],
      ["Morgan", target],
      ["Owner", "owner"],
    ]) {
      const row = screen.getByRole("button", {
        name: new RegExp(`^Open profile for ${name}`),
      });
      expect(row.closest("section")).toHaveAttribute("aria-label", "People");
      const labels = within(required(row.closest("li")));
      if (role === "owner" || role === "admin")
        expect(
          labels.getAllByText(role === "owner" ? "Owner" : "Admin").length,
        ).toBeGreaterThan(0);
      else {
        expect(labels.queryByText("Admin")).not.toBeInTheDocument();
        expect(labels.queryByText("Owner")).not.toBeInTheDocument();
      }
    }
    await t.user.type(screen.getByRole("searchbox"), "o");
    expect(memberOrder()).toEqual(["Morgan", "Owner"]);
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it.each([
  [true, "owner", "Agents"],
  [true, "admin", "Agents"],
  [true, "member", "Agents"],
  [false, "bot", "People"],
] as const)(
  "groups by identity regardless of role (agent: %s, role: %s)",
  async (agent, role, expected) => {
    const t = await setup("member", role, true, undefined, agent);
    const row = screen.getByRole("button", {
      name: /^Open profile for Morgan/,
    });
    expect(row.closest("section")).toHaveAttribute("aria-label", expected);
    expect(memberOrder()).toEqual(
      agent ? ["Carl", "Owner", "Morgan"] : ["Carl", "Morgan", "Owner"],
    );
    await t.user.type(screen.getByRole("searchbox"), "Morgan");
    expect(memberOrder()).toEqual(["Morgan"]);
    expect(
      screen.getByRole("heading", { name: `${expected} · 1` }),
    ).toBeVisible();
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it("updates an agent's role label after refresh while keeping it under Agents", async () => {
  const t = await setup("member", "member", true, undefined, true);
  for (const role of ["admin", "owner", "member"]) {
    await vi.waitFor(() =>
      expect(memberData()).toHaveAttribute("data-refreshing", "false"),
    );
    t.confirm(role);
    await act(async () => {
      await t.session.memberAdministration.refresh(id);
    });
    await vi.waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Open profile for Morgan/ }),
      ).toHaveAccessibleName(new RegExp(`, ${role}$`)),
    );
    const row = screen.getByRole("button", { name: /Open profile for Morgan/ });
    expect(row.closest("section")).toHaveAttribute("aria-label", "Agents");
    const labels = within(required(row.closest("li")));
    if (role === "member") {
      expect(labels.queryByText("Admin")).not.toBeInTheDocument();
      expect(labels.queryByText("Owner")).not.toBeInTheDocument();
    } else
      expect(
        labels.getByText(role === "owner" ? "Owner" : "Admin"),
      ).toBeVisible();
  }
  expect(t.publish).not.toHaveBeenCalled();
});

it("withholds initial rows until roles settle, then preserves content through refresh", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const t = await setup("member", "member", true, gate);
  try {
    expect(
      screen.getByRole("status", { name: "Loading members" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /^Open profile for/ }),
    ).toBeNull();
  } finally {
    await act(async () => release());
  }

  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  expect(memberOrder()).toEqual(["Carl", "Morgan", "Owner"]);
  t.confirm("admin");
  await act(async () => {
    await t.session.memberAdministration.refresh(id);
  });
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  expect(memberOrder()).toEqual(["Carl", "Morgan", "Owner"]);
  const query = required(t.query.getMockImplementation());
  t.query.mockRejectedValue(new Error("Read failed"));
  await act(async () => {
    await t.session.memberAdministration.refresh(id);
  });
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  expect(memberOrder()).toEqual(["Carl", "Morgan", "Owner"]);
  t.query.mockImplementation(query);
  t.confirm("member");
  await t.user.click(screen.getByRole("button", { name: "Retry member data" }));
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  expect(memberOrder()).toEqual(["Carl", "Morgan", "Owner"]);
  expect(t.publish).not.toHaveBeenCalled();
});

function memberOrder() {
  return within(screen.getByRole("region", { name: "Member list" }))
    .getAllByRole("button", { name: /^Open profile for/ })
    .map((row) =>
      required(row.getAttribute("aria-label"))
        .split(" (")[0]
        ?.replace("Open profile for ", ""),
    );
}

it.each([false, true])(
  "withholds rows during the initial role read, then shows the result (failure: %s)",
  async (failure) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    }).then(() => {
      if (failure) throw new Error("Roles unavailable");
    });
    try {
      const t = await setup("owner", "member", true, gate);
      await vi.waitFor(() =>
        expect(
          t.query.mock.calls.some(([filters]) =>
            filters.some((filter) => filter.kinds?.includes(39001)),
          ),
        ).toBe(true),
      );
      expect(
        screen.getByRole("status", { name: "Loading members" }),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: /^Open profile for/ }),
      ).toBeNull();
      await act(async () => release());
      await vi.waitFor(() =>
        expect(t.session.memberAdministration.snapshot(id).status).toBe(
          failure ? "error" : "ready",
        ),
      );
      const row = await screen.findByRole("button", {
        name: /Open profile for Morgan/,
      });
      expect(
        screen.queryByRole("status", { name: "Loading members" }),
      ).toBeNull();
      expect(row.closest("li")).not.toHaveTextContent(
        /Role unverified|^member$/,
      );
      expect(row).toHaveAccessibleName(
        failure ? /Role unverified/ : /, member$/,
      );
      expect(t.publish).not.toHaveBeenCalled();
    } finally {
      await act(async () => release());
    }
  },
);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["names", "roles", "roster"] as const)(
  "shows only a list spinner until the last required read settles: %s",
  async (last) => {
    const gates = { names: deferred(), roles: deferred(), roster: deferred() };
    try {
      const t = await setup(
        "member",
        "member",
        true,
        gates.roles.promise,
        false,
        undefined,
        false,
        true,
        { names: gates.names.promise, roster: gates.roster.promise },
      );
      const list = screen.getByRole("region", { name: "Member list" });
      const search = screen.getByRole("searchbox");
      await vi.waitFor(() => {
        for (const kind of [0, 39001, 39002])
          expect(
            t.query.mock.calls.some(([filters]) =>
              filters.some((filter) => filter.kinds?.includes(kind)),
            ),
          ).toBe(true);
      });
      await act(async () => {
        for (const [key, gate] of Object.entries(gates))
          if (key !== last) gate.resolve();
      });
      expect(
        within(list).getByRole("status", { name: "Loading members" }),
      ).toBeVisible();
      expect(
        within(list).queryByRole("button", { name: /^Open profile for/ }),
      ).toBeNull();
      expect(within(list).queryByRole("heading")).toBeNull();
      expect(screen.getByRole("searchbox")).toBe(search);
      await act(async () => gates[last].resolve());
      await screen.findByText("Morgan");
      expect(memberOrder()).toEqual(["Carl", "Morgan", "Owner"]);
      expect(
        screen.queryByRole("status", { name: "Loading members" }),
      ).toBeNull();
      expect(screen.getByRole("region", { name: "Member list" })).toBe(list);
      expect(screen.getByRole("searchbox")).toHaveFocus();
      expect(t.publish).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        for (const gate of Object.values(gates)) gate.resolve();
      });
    }
  },
);

it("keeps resolved rows and focus while refreshing, and reopens warm without a spinner", async () => {
  const t = await setup();
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  const gate = deferred();
  const query = required(t.query.getMockImplementation());
  t.query.mockImplementation(async (filters) => {
    await gate.promise;
    return query(filters);
  });
  try {
    const search = screen.getByRole("searchbox");
    search.focus();
    const row = screen.getByRole("button", { name: /Open profile for Morgan/ });
    const list = screen.getByRole("region", { name: "Member list" });
    list.scrollTop = 24;
    await act(async () => {
      void t.session.memberAdministration.refresh(id);
    });
    expect(
      screen.queryByRole("status", { name: "Loading members" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: /Open profile for Morgan/ }),
    ).toBe(row);
    expect(search).toHaveFocus();
    expect(list.scrollTop).toBe(24);
    await act(async () => gate.resolve());
    await vi.waitFor(() =>
      expect(memberData()).toHaveAttribute("data-refreshing", "false"),
    );
    await t.user.click(screen.getByRole("button", { name: "Close" }));
    const reopen = deferred();
    t.query.mockImplementation(async (filters) => {
      await reopen.promise;
      return query(filters);
    });
    try {
      await t.user.click(screen.getByRole("button", { name: "Access" }));
      expect(
        screen.queryByRole("status", { name: "Loading members" }),
      ).toBeNull();
      expect(memberOrder()).toEqual(["Carl", "Morgan", "Owner"]);
    } finally {
      await act(async () => reopen.resolve());
    }
  } finally {
    await act(async () => gate.resolve());
  }
});

it("presents verified roles, protects owners/self, and confirms a separate deliberate role intent", async () => {
  const t = await setup();
  await expectProfileOnly(t.user, "Carl");
  await expectProfileOnly(t.user, "Owner");
  const row = required(screen.getByText("Morgan").closest("li"));
  expect(row.closest("section")).toHaveAttribute("aria-label", "People");
  let dialog = await t.choose("Set as admin");
  await vi.waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Set as admin" }),
    ).toHaveFocus(),
  );
  expect(
    within(dialog).getByRole("button", { name: "Cancel" }),
  ).toHaveAttribute("data-variant", "subtle");
  expect(
    within(dialog).getByRole("button", { name: "Set as admin" }),
  ).toHaveAttribute("data-variant", "prominent");
  expect(t.publish).not.toHaveBeenCalled();
  await t.user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(t.publish).not.toHaveBeenCalled();
  dialog = await t.choose("Set as admin");
  await t.user.click(
    within(dialog).getByRole("button", { name: "Set as admin" }),
  );
  await vi.waitFor(() =>
    expect(t.session.memberAdministration.snapshot(id).operation?.status).toBe(
      "confirmed",
    ),
  );
  expect(
    screen.queryByText("Member change confirmed."),
  ).not.toBeInTheDocument();
  expect(
    screen
      .getByRole("button", { name: /Open profile for Morgan/ })
      .closest("section"),
  ).toHaveAttribute("aria-label", "People");
  expect(t.publish).toHaveBeenCalledOnce();
});
it.each(["cancel", "close", "escape", "outside"])(
  "returns from confirmation with %s without losing the search or sending a write",
  async (dismiss) => {
    const t = await setup();
    const original = screen.getByRole("dialog", { name: "Manage members" });
    await t.user.type(screen.getByRole("searchbox"), "Morgan");
    const dialog = await t.choose("Remove from channel");
    expect(dialog).toBe(original);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await vi.waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Cancel" }),
      ).toHaveFocus(),
    );
    if (dismiss === "escape") await t.user.keyboard("{Escape}");
    else if (dismiss === "outside")
      await t.user.click(
        required(document.querySelector<HTMLElement>(".buzz-dialog-backdrop")),
      );
    else
      await t.user.click(
        within(dialog).getByRole("button", {
          name: dismiss === "cancel" ? "Cancel" : "Back to members",
        }),
      );
    const search = await screen.findByRole("searchbox");
    expect(search).toHaveValue("Morgan");
    await vi.waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Actions for Morgan" }),
      ).toHaveFocus(),
    );
    expect(screen.getByRole("dialog", { name: "Manage members" })).toBe(
      original,
    );
    expect(t.publish).not.toHaveBeenCalled();
  },
);

// Leave a step only after the other one's exit: within the crossfade the
// Dialog re-enters the exiting list node, which keeps its offset by itself.
const settledStep = () =>
  vi.waitFor(
    () =>
      expect(document.querySelectorAll(".buzz-dialog-step")).toHaveLength(1),
    { timeout: 3_000 },
  );
const actionsFor = (name: string) =>
  screen.getByRole("button", { name: `Actions for ${name}` });
// Holds the next member write until released; a rejected one fails as a relay would.
function holdPublish(t: Awaited<ReturnType<typeof setup>>, rejected = false) {
  const gate = deferred();
  const publish = required(t.publish.getMockImplementation());
  t.publish.mockImplementation(async (event) => {
    await gate.promise;
    if (rejected) throw new PublishRejected("Permission changed");
    return publish(event);
  });
  return gate;
}
it("returns from a member change to the same place in the list", async () => {
  const t = await setup();
  memberData().scrollTop = 24;
  let dialog = await t.choose("Set to viewing only");
  await settledStep();
  await t.user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(memberData().scrollTop).toBe(24);
  expect(actionsFor("Morgan")).toHaveFocus();
  expect(t.publish).not.toHaveBeenCalled();
  await settledStep();
  memberData().scrollTop = 48;
  dialog = await t.choose("Remove from channel");
  await settledStep();
  const gate = holdPublish(t);
  try {
    await t.user.click(
      within(dialog).getByRole("button", { name: "Remove member" }),
    );
    await vi.waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
    // The member keeps focus until the removal takes its row.
    expect(memberData().scrollTop).toBe(48);
    expect(actionsFor("Morgan")).toHaveFocus();
  } finally {
    await act(async () => gate.resolve());
  }
  await vi.waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Actions for Morgan" }),
    ).not.toBeInTheDocument(),
  );
  expect(actionsFor("Owner")).toHaveFocus();
});
it.each(["agents", "filtered"] as const)(
  "after a removal from the %s list, hands focus to the member in its place across groups, or Search",
  async (list) => {
    const t = await setup(
      "owner",
      "member",
      true,
      undefined,
      list === "agents",
    );
    if (list === "filtered")
      await t.user.type(screen.getByRole("searchbox"), "Morgan");
    const dialog = await t.choose("Remove from channel");
    await settledStep();
    await t.user.click(
      within(dialog).getByRole("button", {
        name: list === "agents" ? "Remove agent" : "Remove member",
      }),
    );
    await vi.waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Actions for Morgan" }),
      ).not.toBeInTheDocument(),
    );
    // The agent was the last row, alone in Agents; People's last row precedes it.
    expect(
      list === "agents" ? actionsFor("Owner") : screen.getByRole("searchbox"),
    ).toHaveFocus();
  },
);
it("keeps a focus move made while a removal is pending", async () => {
  const t = await setup();
  const dialog = await t.choose("Remove from channel");
  await settledStep();
  const gate = holdPublish(t);
  try {
    await t.user.click(
      within(dialog).getByRole("button", { name: "Remove member" }),
    );
    await vi.waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
    expect(actionsFor("Morgan")).toHaveFocus();
    await t.user.click(screen.getByRole("searchbox"));
  } finally {
    await act(async () => gate.resolve());
  }
  await vi.waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Actions for Morgan" }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("searchbox")).toHaveFocus();
});
it.each(["kept", "scrolled", "unrelated"] as const)(
  "keeps the member's Actions in view only for its own change's error (%s)",
  async (outcome) => {
    const t = await setup();
    const scrolls = vi.mocked(HTMLElement.prototype.scrollIntoView);
    memberData().scrollTop = 24;
    const dialog = await t.choose("Set to viewing only");
    await settledStep();
    const gate = holdPublish(t, outcome !== "unrelated");
    try {
      await t.user.click(
        within(dialog).getByRole("button", { name: "Set to viewing only" }),
      );
      await vi.waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
      // The person scrolls the list before the rejection arrives.
      if (outcome === "scrolled") memberData().scrollTop = 30;
    } finally {
      await act(async () => gate.resolve());
    }
    if (outcome === "unrelated") {
      await vi.waitFor(() =>
        expect(
          t.session.memberAdministration.snapshot(id).operation?.status,
        ).toBe("confirmed"),
      );
      t.query.mockRejectedValue(new Error("Read failed"));
      await act(async () => t.session.memberAdministration.refresh(id));
    }
    await screen.findAllByText(
      outcome === "unrelated" ? "Read failed" : "Permission changed",
    );
    const actions = actionsFor("Morgan");
    expect(actions).toHaveFocus();
    expect(memberData().scrollTop).toBe(outcome === "scrolled" ? 30 : 24);
    expect(
      scrolls.mock.calls.filter(
        (_, call) => scrolls.mock.contexts[call] === actions,
      ),
    ).toEqual(outcome === "kept" ? [[{ block: "nearest" }]] : []);
  },
);
it("does not restore a list place into another session's list", async () => {
  const t = await setup();
  memberData().scrollTop = 24;
  await t.choose("Remove from channel");
  await settledStep();
  t.replaceSession();
  const search = await screen.findByRole("searchbox");
  expect(memberData().scrollTop).toBe(0);
  expect(search).toHaveFocus();
  expect(t.publish).not.toHaveBeenCalled();
});

it("keeps confirmation read-only when the verified target role changes", async () => {
  const t = await setup();
  const dialog = await t.choose("Remove from channel");
  t.confirm("owner");
  await act(async () => t.session.memberAdministration.refresh(id));
  const remove = within(dialog).getByRole("button", { name: "Remove member" });
  expect(remove).toBeDisabled();
  await t.user.click(remove);
  expect(t.publish).not.toHaveBeenCalled();
  await t.user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await screen.findByRole("searchbox");
});

it("confirms removal and removes only the confirmed roster entry", async () => {
  const t = await setup();
  const membersDialog = screen.getByRole("dialog", { name: "Manage members" });
  const dialog = await t.choose("Remove from channel");
  expect(dialog).toBe(membersDialog);
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  expect(
    within(dialog).getByRole("button", { name: "Cancel" }),
  ).toHaveAttribute("data-variant", "subtle");
  expect(
    within(dialog).getByRole("button", { name: "Remove member" }),
  ).toHaveAttribute("data-variant", "destructive");
  expect(screen.getAllByText("Morgan").length).toBeGreaterThan(0);
  await t.user.click(
    within(dialog).getByRole("button", { name: "Remove member" }),
  );
  await vi.waitFor(() =>
    expect(t.session.memberAdministration.snapshot(id).operation?.status).toBe(
      "confirmed",
    ),
  );
  expect(
    screen.queryByText("Member change confirmed."),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Open profile for Morgan/ }),
  ).not.toBeInTheDocument();
  expect(t.session.channels.get?.(id)?.members).not.toContain(t.target.pubkey);
});
it.each(["member", "guest"])(
  "keeps the %s member directory usable without admin controls",
  async (actor) => {
    const t = await setup(actor);
    await expectProfileOnly(t.user, "Morgan");
    expect(screen.getByRole("searchbox")).toHaveAttribute(
      "placeholder",
      actor === "guest" ? "Search members" : "Add people and agents",
    );
  },
);
it.each(["member", "bot", "admin", "guest"] as const)(
  "labels only exceptions in the %s row while retaining its checked role-menu choice",
  async (role) => {
    const t = await setup("owner", role, true, undefined, role === "bot");
    const row = required(screen.getByText("Morgan").closest("li"));
    const caption =
      role === "member" || role === "bot"
        ? "Participating"
        : role === "guest"
          ? "Viewing only"
          : "Admin";
    const actions = within(row).getByRole("button", {
      name: "Actions for Morgan",
    });
    if (role === "member" || role === "bot")
      expect(within(row).queryByText(caption)).not.toBeInTheDocument();
    else expect(within(row).getByText(caption)).toBeVisible();
    expect(actions).not.toHaveTextContent(caption);
    expect(
      within(row).queryByRole("button", { name: "Access for Morgan" }),
    ).not.toBeInTheDocument();
    expect(
      within(row).queryByText(role === "guest" ? "Guest" : "Member"),
    ).not.toBeInTheDocument();
    await t.user.click(actions);
    await screen.findByRole("menuitem", { name: "Remove from channel" });
    expect(
      screen.getAllByRole("menuitemradio").map((item) => item.textContent),
    ).toEqual(["Admin", "Participating", "Viewing only"]);
    expect(
      screen.getByRole("menuitemradio", { name: caption }),
    ).toHaveAttribute("aria-checked", "true");
    await t.user.keyboard("{Escape}");
    await vi.waitFor(() => expect(actions).toHaveFocus());
    expect(
      within(row).getByRole("button", { name: /Open profile/ }),
    ).toHaveAccessibleName(
      new RegExp(`, ${role === "bot" ? "member" : role}$`),
    );
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it("makes a member a guest only after explicit confirmation", async () => {
  const t = await setup("owner", "member");
  const dialog = await t.choose("Set to viewing only");
  expect(dialog).toHaveTextContent("from Participating to Viewing only");
  expect(t.publish).not.toHaveBeenCalled();
  await t.user.click(
    within(dialog).getByRole("button", { name: "Set to viewing only" }),
  );
  await vi.waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
  expect(t.publish.mock.calls[0]?.[0].tags).toContainEqual(["role", "guest"]);
});

it("changes an existing Guest to Member only after explicit confirmation", async () => {
  const t = await setup("owner", "guest");
  const dialog = await t.choose("Set to participating");
  expect(dialog).toHaveTextContent("from Viewing only to Participating");
  expect(t.publish).not.toHaveBeenCalled();
  await t.user.click(
    within(dialog).getByRole("button", { name: "Set to participating" }),
  );
  await vi.waitFor(() =>
    expect(t.session.memberAdministration.snapshot(id).operation?.status).toBe(
      "confirmed",
    ),
  );
  expect(
    screen.queryByText("Member change confirmed."),
  ).not.toBeInTheDocument();
  expect(
    screen
      .getByRole("button", { name: /Open profile for Morgan/ })
      .closest("section"),
  ).toHaveAttribute("aria-label", "People");
  expect(t.publish).toHaveBeenCalledOnce();
});
it.each([false, true])(
  "groups Bot by identity while retaining its accessible role and explicit role controls (Agent: %s)",
  async (agent) => {
    const t = await setup("owner", "bot", true, undefined, agent);
    const row = screen.getByRole("button", { name: /Open profile for Morgan/ });
    if (agent) {
      expect(
        row.closest("li")?.querySelector('[data-avatar-shape="squircle"]'),
      ).toBeInTheDocument();
      expect(row.closest("section")).toHaveAttribute("aria-label", "Agents");
      expect(
        within(required(row.closest("li"))).queryByText("bot"),
      ).not.toBeInTheDocument();
      expect(row).toHaveAccessibleName(/, member$/);
      expect(row).not.toHaveAccessibleName(/, bot/);
    } else {
      expect(
        within(required(row.closest("li"))).queryByText("Agent"),
      ).not.toBeInTheDocument();
      expect(row.closest("section")).toHaveAttribute("aria-label", "People");
      expect(row).toHaveAccessibleName(/, bot/);
    }
    expect(
      t.session.memberAdministration.snapshot(id).authority.roles[
        t.target.pubkey
      ],
    ).toBe("bot");
    await t.user.click(
      screen.getByRole("button", { name: /^Actions for Morgan$/ }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Remove from channel" }),
    ).toBeVisible();
    expect(screen.getByRole("menuitemradio", { name: "Admin" })).toBeVisible();
    expect(
      screen.getByRole("menuitemradio", { name: "Participating" }),
    ).toBeVisible();
    expect(t.publish).not.toHaveBeenCalled();
    await t.user.click(
      screen.getByRole("menuitem", { name: "Remove from channel" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: `Remove ${agent ? "agent" : "member"} from channel`,
    });
    await vi.waitFor(() =>
      expect(
        within(dialog).getByRole("button", {
          name: `Remove ${agent ? "agent" : "member"}`,
        }),
      ).toBeVisible(),
    );
    expect(dialog).toHaveAccessibleDescription("Morgan");
    const avatar = required(
      dialog.querySelector(".buzz-dialog-description .buzz-avatar"),
    );
    expect(avatar).toHaveAttribute(
      "data-avatar-shape",
      agent ? "squircle" : "circle",
    );
    expect(avatar).toHaveAttribute("data-size", "small");
    expect(avatar).toHaveTextContent("M");
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveAttribute("data-variant", "subtle");
    expect(t.publish).not.toHaveBeenCalled();
  },
);
it.each([false, true])(
  "uses the row's member picture beside the accessible confirmation name (Agent: %s)",
  async (agent) => {
    const picture = "https://profiles.example/morgan.png";
    const t = await setup(
      "owner",
      "member",
      true,
      undefined,
      agent,
      undefined,
      false,
      true,
      undefined,
      undefined,
      "private",
      picture,
    );
    const row = required(screen.getByText("Morgan").closest("li"));
    const rowPicture = required(
      row.querySelector(".buzz-avatar img"),
    ).getAttribute("src");
    expect(rowPicture).toBe(
      `https://media.example/small?url=${encodeURIComponent(picture)}`,
    );
    const dialog = await t.choose("Remove from channel");
    const avatar = required(
      dialog.querySelector(".buzz-dialog-description .buzz-avatar"),
    );
    const image = required(avatar.querySelector("img"));
    expect(image).toHaveAttribute("src", rowPicture);
    expect(avatar).toHaveAttribute(
      "data-avatar-shape",
      agent ? "squircle" : "circle",
    );
    expect(dialog).toHaveAccessibleDescription("Morgan");
    expect(t.publish).not.toHaveBeenCalled();
  },
);
it.each(["admin", "owner", "guest"])(
  "keeps an Agent under Agents with its verified %s role",
  async (role) => {
    const t = await setup("owner", role, true, undefined, true);
    const row = screen.getByRole("button", { name: /Open profile for Morgan/ });
    expect(
      row.closest("li")?.querySelector('[data-avatar-shape="squircle"]'),
    ).toBeInTheDocument();
    expect(
      within(required(row.closest("li"))).queryByText(role),
    ).not.toBeInTheDocument();
    expect(row.closest("section")).toHaveAttribute("aria-label", "Agents");
    expect(row).toHaveAccessibleName(new RegExp(`, ${role}$`));
    expect(t.publish).not.toHaveBeenCalled();
  },
);
it("reads roles on hosts without the narrow writer", async () => {
  const t = await setup("owner", "guest", false);
  expect(
    screen.getByRole("button", { name: /Open profile for Morgan/ }),
  ).toHaveAccessibleName(/, guest$/);
  await expectProfileOnly(t.user, "Morgan");
});
it("keeps unconfirmed roles and session recovery across close/reopen without replay", async () => {
  const t = await setup();
  t.lag();
  const dialog = await t.choose("Set as admin");
  await t.user.click(
    within(dialog).getByRole("button", { name: "Set as admin" }),
  );
  await screen.findByText(/This request may have taken effect/);
  expect(
    screen
      .getByRole("button", { name: /Open profile for Morgan/ })
      .closest("section"),
  ).toHaveAttribute("aria-label", "People");
  await expectProfileOnly(t.user, "Morgan");
  await t.user.click(screen.getByRole("button", { name: "Close" }));
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await t.user.click(screen.getByRole("button", { name: "Access" }));
  await screen.findByText(/This request may have taken effect/);
  await vi.waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Retry member data" }),
    ).not.toHaveAttribute("aria-disabled", "true"),
  );
  t.confirm("admin");
  await t.user.click(screen.getByRole("button", { name: "Retry member data" }));
  await vi.waitFor(() =>
    expect(t.session.memberAdministration.snapshot(id).operation?.status).toBe(
      "confirmed",
    ),
  );
  expect(
    screen.queryByText("Member change confirmed."),
  ).not.toBeInTheDocument();
  expect(t.publish).toHaveBeenCalledOnce();
});
it("pending operations survive closing while suppressing duplicate actions", async () => {
  const t = await setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const publish = required(t.publish.getMockImplementation());
  t.publish.mockImplementationOnce(async (event) => {
    await gate;
    await publish(event);
  });
  try {
    const dialog = await t.choose("Set as admin");
    await t.user.click(
      within(dialog).getByRole("button", { name: "Set as admin" }),
    );
    await vi.waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
    await expectProfileOnly(t.user, "Morgan");
    await t.user.click(screen.getByRole("button", { name: "Close" }));
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await t.user.click(screen.getByRole("button", { name: "Access" }));
    expect(
      screen.queryByText(/Checking permissions and waiting/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry member data" }),
    ).toBeNull();
    expect(t.session.memberAdministration.snapshot(id).operation?.status).toBe(
      "pending",
    );
  } finally {
    await act(async () => release());
  }
  await vi.waitFor(() =>
    expect(t.session.memberAdministration.snapshot(id).operation?.status).toBe(
      "confirmed",
    ),
  );
  expect(
    screen.queryByText("Member change confirmed."),
  ).not.toBeInTheDocument();
  expect(t.publish).toHaveBeenCalledOnce();
});
it("retains roster and displays rejection with explicit refresh recovery", async () => {
  const t = await setup();
  t.publish.mockRejectedValueOnce(new PublishRejected("Permission changed"));
  const dialog = await t.choose("Remove from channel");
  await t.user.click(
    within(dialog).getByRole("button", { name: "Remove member" }),
  );
  const error = await screen.findByText("Permission changed");
  expect(error).toHaveAttribute("role", "alert");
  expect(error.closest(".buzz-toast")).toBeNull();
  // A failed removal leaves its member, and focus, in place.
  expect(actionsFor("Morgan")).toHaveFocus();
  expect(
    within(screen.getByRole("region", { name: "Member list" })).queryByText(
      "Permission changed",
    ),
  ).not.toBeInTheDocument();
  await vi.waitFor(() =>
    expect(
      screen.getByRole("button", { name: /Open profile for Morgan/ }),
    ).toBeVisible(),
  );
  await t.user.click(screen.getByRole("button", { name: "Retry member data" }));
  await screen.findByRole("button", { name: /^Actions for Morgan$/ });
  expect(t.publish).toHaveBeenCalledOnce();
});

it.each(["failed", "uncertain"])(
  "hides the previous %s error during refresh without replaying the write",
  async (outcome) => {
    const t = await setup();
    if (outcome === "uncertain") t.lag();
    else
      t.publish.mockRejectedValueOnce(
        new PublishRejected("Permission changed"),
      );
    const confirmation = await t.choose("Remove from channel");
    await t.user.click(
      within(confirmation).getByRole("button", { name: "Remove member" }),
    );
    const message =
      outcome === "uncertain"
        ? /This request may have taken effect/
        : "Permission changed";
    await screen.findByText(message);
    await vi.waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Retry member data" }),
      ).toBeVisible(),
    );
    await vi.waitFor(() =>
      expect(memberData()).toHaveAttribute("data-refreshing", "false"),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const query = required(t.query.getMockImplementation());
    t.query.mockImplementation(async (...args) => {
      await gate;
      return query(...args);
    });
    try {
      await t.user.click(
        screen.getByRole("button", { name: "Retry member data" }),
      );
      await vi.waitFor(() =>
        expect(t.session.memberAdministration.snapshot(id).status).toBe(
          "loading",
        ),
      );
      expect(screen.queryByText(message)).not.toBeInTheDocument();
      expect(t.publish).toHaveBeenCalledOnce();
    } finally {
      await act(async () => release());
    }
    await vi.waitFor(() =>
      expect(t.session.memberAdministration.snapshot(id).status).toBe("ready"),
    );
    if (outcome === "uncertain")
      expect(screen.getByText(message)).toHaveAttribute("role", "alert");
    else expect(screen.queryByText(message)).not.toBeInTheDocument();
    expect(t.publish).toHaveBeenCalledOnce();
  },
);

it.each([true, false])(
  "applies live roster and role reads without writes (writer: %s)",
  async (supported) => {
    const t = await setup("owner", "member", supported);
    const section = screen.getByRole("region", { name: "People" });
    expect(
      screen.queryByRole("button", { name: "Refresh member data" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Retry member data" }),
    ).toBeNull();
    await t.user.type(screen.getByRole("searchbox"), "Morgan");
    await vi.waitFor(() =>
      expect(memberData()).toHaveAttribute("data-refreshing", "false"),
    );
    t.confirm("admin");
    await act(async () => {
      await t.session.memberAdministration.refresh(id);
    });
    await vi.waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Open profile for Morgan/ }),
      ).toHaveAccessibleName(/, admin$/),
    );
    await vi.waitFor(() =>
      expect(memberData()).toHaveAttribute("data-refreshing", "false"),
    );
    t.confirm(undefined);
    await act(async () => {
      await t.session.memberAdministration.refresh(id);
    });
    await vi.waitFor(() =>
      expect(memberData()).toHaveAttribute("data-refreshing", "false"),
    );
    // An empty role group is hidden; search results say why it is empty.
    expect(section).not.toBeInTheDocument();
    expect(
      screen.queryByText("No members match your search."),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/^No other matching people/)).toBeVisible();
    expect(screen.getByRole("searchbox")).toHaveValue("Morgan");
    expect(t.publish).not.toHaveBeenCalled();
  },
);
it.each([false, true])(
  "recovers visible roles after an unrelated access change (read fails: %s)",
  async (failure) => {
    const t = await setup();
    const other = "22222222-2222-4222-8222-222222222222";
    const query = required(t.query.getMockImplementation());
    let joined = true;
    let failRead = failure;
    t.query.mockImplementation(async (filters) => {
      if (
        !joined &&
        failRead &&
        filters.some((filter) => filter.kinds?.includes(39001))
      )
        throw new Error("Roles unavailable");
      if (filters.some((filter) => filter["#d"]?.includes(other)))
        return [
          signed(t.relay, {
            kind: 39000,
            content: "",
            tags: [
              ["d", other],
              ["t", "stream"],
              ["private"],
              ["name", "Other"],
            ],
          }),
          signed(t.relay, {
            kind: 39002,
            created_at: joined ? 1700000100 : 1700000101,
            content: "",
            tags: [["d", other], ...(joined ? [["p", t.viewer.pubkey]] : [])],
          }),
        ].filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
      return query(filters);
    });
    const readOther = () =>
      t.session.read([{ kinds: [39000, 39002], "#d": [other], limit: 2 }], {
        fresh: true,
      });
    await act(async () => {
      await readOther();
    });
    const before = t.query.mock.calls.filter(([filters]) =>
      filters.some((filter) => filter.kinds?.includes(39001)),
    ).length;
    joined = false;
    await act(async () => {
      await readOther();
    });
    await vi.waitFor(() =>
      expect(t.session.memberAdministration.snapshot(id).status).toBe(
        failure ? "error" : "ready",
      ),
    );

    await vi.waitFor(() =>
      expect(memberData()).toHaveAttribute("data-refreshing", "false"),
    );
    expect(
      t.query.mock.calls.filter(([filters]) =>
        filters.some((filter) => filter.kinds?.includes(39001)),
      ),
    ).toHaveLength(before + 1);
    // Session revocation also clears optional names; identify the row by its stable key.
    // Labels lengthen the npub suffix until visible keys differ, and these keys are random.
    const npub = required(canonicalPublicKey(t.target.pubkey));
    const targetRow = () =>
      required(
        screen
          .getAllByRole("button", { name: /^Open profile for/ })
          .find((button) => {
            const suffix = button
              .getAttribute("aria-label")
              ?.match(/\(npub…(\w+)\)/)?.[1];
            return !!suffix && npub.endsWith(suffix);
          })
          ?.closest("li"),
      );
    if (failure) {
      expect(screen.getByText("Roles unavailable")).toBeVisible();
      expect(
        within(targetRow()).getByRole("button", { name: /Open profile/ }),
      ).toHaveAccessibleName(/Role unverified/);
      failRead = false;
      await t.user.click(
        screen.getByRole("button", { name: "Retry member data" }),
      );
      await vi.waitFor(() =>
        expect(t.session.memberAdministration.snapshot(id).status).toBe(
          "ready",
        ),
      );
    }
    expect(targetRow().closest("section")).toHaveAttribute(
      "aria-label",
      "People",
    );
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it("does not reload roles after this channel's access is revoked", async () => {
  const t = await setup();
  const query = required(t.query.getMockImplementation());
  const before = t.query.mock.calls.filter(([filters]) =>
    filters.some((filter) => filter.kinds?.includes(39001)),
  ).length;
  t.query.mockImplementation(async (filters) => {
    if (filters.some((filter) => filter.kinds?.includes(39002)))
      return [
        signed(t.relay, {
          kind: 39002,
          created_at: 1700000100,
          content: "",
          tags: [
            ["d", id],
            ["p", t.target.pubkey, "", "member"],
          ],
        }),
      ];
    return query(filters);
  });
  await act(async () => {
    await t.session.read([{ kinds: [39002], "#d": [id], limit: 1 }], {
      fresh: true,
    });
  });
  expect(t.session.memberAdministration.snapshot(id).status).toBe("idle");
  expect(
    t.query.mock.calls.filter(([filters]) =>
      filters.some((filter) => filter.kinds?.includes(39001)),
    ),
  ).toHaveLength(before);
  expect(
    screen.queryByRole("button", { name: /Open profile for Morgan/ }),
  ).not.toBeInTheDocument();
  expect(t.publish).not.toHaveBeenCalled();
});

it("holds duplicate refreshes, retains the roster on read failure, and recovers explicitly", async () => {
  const t = await setup();
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  const query = required(t.query.getMockImplementation());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  t.query.mockImplementation(async (filters) => {
    if (filters.some((filter) => filter.kinds?.includes(39002))) {
      started++;
      await gate;
      throw new Error("Member reads offline");
    }
    return query(filters);
  });
  try {
    await act(async () => {
      void t.session.memberAdministration.refresh(id);
    });
    await vi.waitFor(() => expect(started).toBe(1));
    expect(memberData()).toHaveAttribute("data-refreshing", "true");
    expect(
      screen.queryByRole("button", { name: "Retry member data" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Refresh member data" }),
    ).toBeNull();
    expect(screen.queryByText("Loading members…")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Open profile for Morgan/ }),
    ).toBeVisible();
    await act(async () => {
      void t.session.memberAdministration.refresh(id);
    });
  } finally {
    await act(async () => release());
  }
  await screen.findByText("Member reads offline");
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  expect(started).toBe(1);
  expect(
    screen
      .getByRole("button", { name: /Open profile for Morgan/ })
      .closest("section"),
  ).toHaveAttribute("aria-label", "People");
  const recovery = deferred();
  t.query.mockImplementation(async (filters) => {
    await recovery.promise;
    return query(filters);
  });
  t.confirm("admin");
  try {
    await t.user.click(
      screen.getByRole("button", { name: "Retry member data" }),
    );
    expect(memberData()).toHaveAttribute("data-refreshing", "true");
    expect(screen.getByRole("searchbox")).toHaveFocus();
    // The error-only action retires while the read is pending; it cannot replay.
    expect(
      screen.queryByRole("button", { name: "Retry member data" }),
    ).toBeNull();
    expect(t.publish).not.toHaveBeenCalled();
  } finally {
    await act(async () => recovery.resolve());
  }
  await vi.waitFor(() =>
    expect(
      screen.getByRole("button", { name: /Open profile for Morgan/ }),
    ).toHaveAccessibleName(/, admin$/),
  );
  await vi.waitFor(() =>
    expect(memberData()).toHaveAttribute("data-refreshing", "false"),
  );
  expect(screen.queryByText("Member reads offline")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Retry member data" }),
  ).toBeNull();
  expect(screen.getByRole("searchbox")).toHaveFocus();
  expect(t.publish).not.toHaveBeenCalled();
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture value");
  return value;
}

async function expectProfileOnly(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.click(
    screen.getByRole("button", {
      name: new RegExp(`^Actions for ${name}$`),
    }),
  );
  expect(
    (await screen.findAllByRole("menuitem")).map((item) => item.textContent),
  ).toEqual(["View profile"]);
  await vi.waitFor(() => expect(screen.getByRole("menu")).toHaveFocus());
  await user.keyboard("{Escape}");
  await vi.waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
}

it.each(["ellipsis", "context", "keyboard", "context-key"])(
  "opens the same profile-first member menu via %s",
  async (entry) => {
    const t = await setup();
    const row = required(screen.getByText("Morgan").closest("li"));
    if (entry === "ellipsis") {
      await t.user.click(
        screen.getByRole("button", { name: /^Actions for Morgan$/ }),
      );
    } else if (entry === "context") {
      fireEvent.contextMenu(row, { clientX: 100, clientY: 100, button: 2 });
    } else {
      fireEvent.keyDown(
        within(required(row.closest("li"))).getByRole("button", {
          name: /^Open profile/,
        }),
        entry === "keyboard"
          ? { key: "F10", shiftKey: true }
          : { key: "ContextMenu" },
      );
    }
    expect(
      (await screen.findAllByRole("menuitem")).map((item) => item.textContent),
    ).toEqual(["View profile", "Remove from channel"]);
    expect(t.onOpenLink).not.toHaveBeenCalled();
    expect(t.publish).not.toHaveBeenCalled();
    await t.user.click(screen.getByRole("menuitem", { name: "View profile" }));
    expect(t.onOpenLink).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it.each(["button", "context"])(
  "keeps a %s menu through a queued pre-opening scroll, then dismisses on new scrolling",
  async (entry) => {
    const t = await setup();
    const list = memberData();
    list.scrollTop = 24;
    if (entry === "button") {
      await t.user.click(
        screen.getByRole("button", { name: /^Actions for Morgan$/ }),
      );
    } else {
      const row = required(screen.getByText("Morgan").closest("li"));
      fireEvent.contextMenu(row, { clientX: 100, clientY: 100, button: 2 });
    }
    const menu = await screen.findByRole("menu");
    // The browser can deliver the scroll that revealed the row after opening.
    fireEvent.scroll(list);
    expect(menu).toHaveAttribute("data-open", "");
    list.scrollTop = 48;
    fireEvent.scroll(list);
    await vi.waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("dialog", { name: "Manage members" }),
    ).toBeVisible();
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it("keeps Members and restores the menu trigger when profile navigation is declined", async () => {
  const t = await setup();
  t.onOpenLink.mockReturnValue(false);
  const actions = screen.getByRole("button", {
    name: /^Actions for Morgan$/,
  });
  await t.user.click(actions);
  await t.user.click(
    await screen.findByRole("menuitem", { name: "View profile" }),
  );
  await vi.waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("dialog", { name: "Manage members" })).toBeVisible();
  await vi.waitFor(() => expect(actions).toHaveFocus());
  expect(t.onOpenLink).toHaveBeenCalledOnce();
  expect(t.onOpenLink).toHaveBeenCalledWith(
    expect.any(String),
    screen.getByRole("button", { name: "Access", hidden: true }),
  );
  expect(t.publish).not.toHaveBeenCalled();
});

it.each([false, true])(
  "reuses mounted presence for human/agent avatars without inventing offline state (agent: %s)",
  async (agent) => {
    let status: PresenceStatus = "unknown";
    const listeners = new Map<string, Set<() => void>>();
    const presence = {
      status: () => status,
      limited: () => false,
      subscribeSelection: () => () => {},
      subscribe(key, listener) {
        const current = listeners.get(key) ?? new Set();
        current.add(listener);
        listeners.set(key, current);
        return () => {
          current.delete(listener);
          if (!current.size) listeners.delete(key);
        };
      },
      connected() {},
      clear() {},
      refresh() {},
      dispose() {},
    } satisfies Presence;
    const t = await setup("owner", "member", true, undefined, agent, presence);
    const profile = screen.getByRole("button", {
      name: /Open profile for Morgan/,
    });
    const avatar = required(profile.querySelector(".buzz-avatar-status"));
    expect(avatar).not.toHaveAttribute("data-status");
    expect(profile).not.toHaveAttribute("title");
    expect(profile).not.toHaveAccessibleDescription(/Presence:/);
    expect(avatar).toHaveAttribute("data-shape", agent ? "squircle" : "circle");
    expect(listeners.get(t.target.pubkey)?.size).toBe(1);
    for (const next of ["online", "away", "offline", "unknown"] as const) {
      act(() => {
        status = next;
        for (const callbacks of listeners.values())
          for (const callback of callbacks) callback();
      });
      if (next === "unknown") {
        expect(avatar).not.toHaveAttribute("data-status");
        expect(profile).not.toHaveAccessibleDescription(/Presence:/);
      } else {
        expect(avatar).toHaveAttribute("data-status", next);
        expect(profile).toHaveAccessibleDescription(`Presence: ${next}`);
      }
    }
    await t.user.type(screen.getByRole("searchbox"), "Carl");
    expect(listeners.has(t.target.pubkey)).toBe(false);
    await t.user.click(screen.getByRole("button", { name: "Close" }));
    await vi.waitFor(() => expect(listeners.size).toBe(0));
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it.each(["Carl", "Owner", "Morgan"])(
  "offers profile navigation instead of Copy npub for %s",
  async (name) => {
    const t = await setup();
    await t.user.click(
      screen.getByRole("button", {
        name: new RegExp(`^Actions for ${name}$`),
      }),
    );
    const view = await screen.findByRole("menuitem", { name: "View profile" });
    expect(
      screen.queryByRole("menuitem", { name: "Copy npub" }),
    ).not.toBeInTheDocument();
    await t.user.click(view);
    expect(t.onOpenLink).toHaveBeenCalledOnce();
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it.each([
  [false, "member", true, true, true],
  [true, "member", true, true, false],
  [false, "bot", true, true, false],
  [false, "member", false, true, false],
  [false, "member", true, false, false],
] as const)(
  "gates Send message by human identity, capability and navigation (%s/%s/%s/%s)",
  async (agent, role, available, navigation, offered) => {
    const t = await setup(
      "member",
      role,
      true,
      undefined,
      agent,
      undefined,
      available,
      navigation,
    );
    await t.user.click(
      screen.getByRole("button", { name: /^Actions for Morgan$/ }),
    );
    expect(
      (await screen.findAllByRole("menuitem")).map((item) => item.textContent),
    ).toEqual(offered ? ["View profile", "Send message"] : ["View profile"]);
    await t.user.keyboard("{Escape}");
    await t.user.click(
      screen.getByRole("button", { name: /^Actions for Carl$/ }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "View profile" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("menuitem", { name: "Send message" }),
    ).not.toBeInTheDocument();
    expect(t.openMessage).not.toHaveBeenCalled();
  },
);

it("opens a confirmed human DM once, then hands navigation off without a membership write", async () => {
  const t = await setup(
    "member",
    "member",
    true,
    undefined,
    false,
    undefined,
    true,
  );
  let release!: (id: string) => void;
  t.openMessage.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const actions = screen.getByRole("button", {
    name: /^Actions for Morgan$/,
  });
  await t.user.click(actions);
  await t.user.click(
    await screen.findByRole("menuitem", { name: "Send message" }),
  );
  expect(t.openMessage).toHaveBeenCalledExactlyOnceWith(
    [t.target.pubkey],
    expect.any(AbortSignal),
  );
  expect(await screen.findByText("Opening conversation…")).toBeVisible();
  await t.user.click(actions);
  expect(
    await screen.findByRole("menuitem", { name: "Send message" }),
  ).toHaveAttribute("aria-disabled", "true");
  await t.user.click(screen.getByRole("menuitem", { name: "Send message" }));
  expect(t.openMessage).toHaveBeenCalledOnce();
  await t.user.keyboard("{Escape}");
  await act(async () => release("dm-1"));
  expect(t.onOpenConversation).toHaveBeenCalledExactlyOnceWith("dm-1");
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(t.onOpenLink).not.toHaveBeenCalled();
  expect(t.publish).not.toHaveBeenCalled();
});

it.each(["read", "navigation"])(
  "retains Members after DM %s failure and allows explicit retry",
  async (failure) => {
    const t = await setup(
      "member",
      "member",
      true,
      undefined,
      false,
      undefined,
      true,
    );
    if (failure === "read")
      t.openMessage.mockRejectedValueOnce(new Error("DM unavailable"));
    else t.onOpenConversation.mockReturnValueOnce(false);
    const actions = screen.getByRole("button", {
      name: /^Actions for Morgan$/,
    });
    await t.user.click(actions);
    await t.user.click(
      await screen.findByRole("menuitem", { name: "Send message" }),
    );
    expect(
      await screen.findByText(
        failure === "read"
          ? "DM unavailable"
          : "Could not open the conversation. Try Send message again.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("dialog", { name: "Manage members" }),
    ).toBeVisible();
    await t.user.click(actions);
    await t.user.click(
      await screen.findByRole("menuitem", { name: "Send message" }),
    );
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(t.openMessage).toHaveBeenCalledTimes(2);
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it("closing Members aborts the DM waiter and prevents late navigation", async () => {
  const t = await setup(
    "member",
    "member",
    true,
    undefined,
    false,
    undefined,
    true,
  );
  let release!: (id: string) => void;
  t.openMessage.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await t.user.click(
    screen.getByRole("button", { name: /^Actions for Morgan$/ }),
  );
  await t.user.click(
    await screen.findByRole("menuitem", { name: "Send message" }),
  );
  const signal = required(t.openMessage.mock.calls[0]?.[1]);
  expect(signal.aborted).toBe(false);
  await t.user.click(screen.getByRole("button", { name: "Close" }));
  expect(signal.aborted).toBe(true);
  await act(async () => release("dm-1"));
  expect(t.onOpenConversation).not.toHaveBeenCalled();
  expect(t.publish).not.toHaveBeenCalled();
});

it("shows action feedback above the member list so a long roster cannot hide it", async () => {
  const t = await setup(
    "member",
    "absent",
    true,
    undefined,
    false,
    undefined,
    true,
  );
  const list = memberData();
  const aboveList = (element: HTMLElement) => {
    expect(list).not.toContainElement(element);
    expect(
      element.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  };
  let fail!: (reason: Error) => void;
  t.openMessage.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  await t.user.click(
    screen.getByRole("button", { name: /^Actions for Owner$/ }),
  );
  await t.user.click(
    await screen.findByRole("menuitem", { name: "Send message" }),
  );
  aboveList(await screen.findByText("Opening conversation…"));
  await act(async () => fail(new Error("DM unavailable")));
  aboveList(await screen.findByText("DM unavailable"));
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(
    new Error("Clipboard unavailable"),
  );
  await t.user.click(screen.getByRole("button", { name: "Copy link" }));
  aboveList(await screen.findByText("Couldn’t copy the link."));
  t.write.mockRejectedValueOnce(
    new PublishRejected(
      "blocked: you are not allowed to add members to this channel",
    ),
  );
  await t.user.type(screen.getByRole("searchbox"), "Morgan");
  await t.user.click(
    await screen.findByRole("button", { name: /^Add Morgan \(/ }),
  );
  const refusal = await screen.findByText(/blocked: you are not allowed/);
  aboveList(refusal);
  expect(
    within(refusal).getByRole("button", { name: "Retry adding Morgan" }),
  ).toBeEnabled();
  expect(within(list).queryByRole("alert")).toBeNull();
  expect(screen.getAllByRole("alert")).toHaveLength(3);
  expect(t.publish).not.toHaveBeenCalled();
});

it("filters by present groups and resets to All on any search input", async () => {
  const t = await setup("admin", "member", true, undefined, true);
  const list = screen.getByRole("region", { name: "Member list" });
  const filter = () =>
    screen.getByRole("button", { name: /^Filter people and agents:/ });
  expect(filter()).toHaveAccessibleName("Filter people and agents: All");
  expect(filter()).toHaveAttribute("data-variant", "ghost");
  expect(filter().closest(".buzz-input-group")).toContainElement(
    screen.getByRole("searchbox"),
  );
  await t.user.click(filter());
  await screen.findByRole("menuitemradio", { name: /^All/ });
  expect(
    screen.getAllByRole("menuitemradio").map((item) => item.textContent),
  ).toEqual(["All · 3", "People · 2", "Agents · 1"]);
  expect(
    screen.getByRole("menuitemradio", { name: "All · 3" }),
  ).toHaveAttribute("aria-checked", "true");
  await t.user.click(screen.getByRole("menuitemradio", { name: "Agents · 1" }));
  expect(within(list).getByText("Morgan")).toBeVisible();
  expect(within(list).queryByText("Carl (you)")).not.toBeInTheDocument();
  expect(within(list).queryByText("Owner")).not.toBeInTheDocument();
  expect(filter()).toHaveAccessibleName("Filter people and agents: Agents");
  expect(filter()).toHaveAttribute("data-variant", "prominent");
  // Whitespace still starts search mode, even though matching trims it.
  await t.user.type(screen.getByRole("searchbox"), " ");
  expect(
    screen.queryByRole("button", { name: /^Filter people and agents:/ }),
  ).not.toBeInTheDocument();
  expect(within(list).getByText("Carl (you)")).toBeVisible();
  await t.user.clear(screen.getByRole("searchbox"));
  expect(filter()).toHaveAccessibleName("Filter people and agents: All");
  await t.user.click(filter());
  await t.user.click(
    await screen.findByRole("menuitemradio", { name: "Agents · 1" }),
  );
  await t.user.type(screen.getByRole("searchbox"), "Carl");
  expect(
    screen.queryByRole("button", { name: /^Filter people and agents:/ }),
  ).not.toBeInTheDocument();
  const carl = within(list).getByText("Carl (you)");
  expect(carl).toBeVisible();
  // Only rows you can add show the typed letters; members stay unchanged.
  expect(carl.querySelector("mark")).toBeNull();
  expect(within(list).queryByText("Morgan")).not.toBeInTheDocument();
  await t.user.clear(screen.getByRole("searchbox"));
  expect(within(list).getByText("Carl (you)")).toBeVisible();
  expect(within(list).getByText("Morgan")).toBeVisible();
  expect(
    within(list).getByRole("button", { name: /^Open profile for Owner/ }),
  ).toBeVisible();
  expect(t.publish).not.toHaveBeenCalled();
});

it("hides the identity filter when everyone is a person, including owners", async () => {
  await setup("owner", "owner");
  expect(
    screen.queryByRole("button", { name: /^Filter people and agents:/ }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "People · 3" })).toBeVisible();
});

it("keeps agent owners in the Agents filter", async () => {
  const t = await setup("owner", "owner", true, undefined, true);
  await t.user.click(
    screen.getByRole("button", { name: /^Filter people and agents:/ }),
  );
  await t.user.click(
    await screen.findByRole("menuitemradio", { name: "Agents · 1" }),
  );
  expect(
    screen.getByRole("button", { name: /^Open profile for Morgan/ }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /^Open profile for Carl/ }),
  ).not.toBeInTheDocument();
});

it("preserves the identity filter through role changes and resets on reopen", async () => {
  const t = await setup("admin", "member", true, undefined, true);
  const filter = () =>
    screen.getByRole("button", { name: /^Filter people and agents:/ });
  await t.user.click(filter());
  await t.user.click(
    await screen.findByRole("menuitemradio", { name: "Agents · 1" }),
  );
  t.confirm("admin");
  await act(async () => {
    await t.session.memberAdministration.refresh(id);
  });
  expect(filter()).toHaveAccessibleName("Filter people and agents: Agents");
  expect(
    screen.getByRole("button", { name: /Open profile for Morgan/ }),
  ).toHaveAccessibleName(/, admin$/);
  await t.user.click(screen.getByRole("button", { name: "Close" }));
  await t.user.click(screen.getByRole("button", { name: "Access" }));
  await screen.findByText("Morgan");
  expect(filter()).toHaveAccessibleName("Filter people and agents: All");
});

it.each(["bot", "member"])(
  "lets a regular member confirm/cancel removal of their own %s agent, without role controls",
  async (role) => {
    const t = await setup(
      "member",
      role,
      true,
      undefined,
      true,
      undefined,
      false,
      true,
      undefined,
      "own",
    );
    await screen.findByRole("button", {
      name: "Open owner profile: Carl (you)",
    });
    await t.user.click(
      screen.getByRole("button", { name: /^Actions for Morgan$/ }),
    );
    const remove = await screen.findByRole("menuitem", {
      name: "Remove from channel",
    });
    expect(screen.queryByRole("menuitemradio")).not.toBeInTheDocument();
    await t.user.click(remove);
    const dialog = await screen.findByRole("dialog", {
      name: "Remove agent from channel",
    });
    expect(dialog).toHaveAccessibleDescription("Morgan");
    expect(
      within(dialog).getByRole("button", { name: "Remove agent" }),
    ).toHaveAttribute("data-variant", "destructive");
    await vi.waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Cancel" }),
      ).toHaveFocus(),
    );
    await t.user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(t.publish).not.toHaveBeenCalled();
    const confirm = await t.choose("Remove from channel");
    await t.user.click(
      within(confirm).getByRole("button", { name: "Remove agent" }),
    );
    await vi.waitFor(() =>
      expect(
        t.session.memberAdministration.snapshot(id).operation?.status,
      ).toBe("confirmed"),
    );
    expect(
      screen.queryByText("Member change confirmed."),
    ).not.toBeInTheDocument();
    expect(t.publish).toHaveBeenCalledOnce();
    expect(t.publish.mock.calls[0]?.[0]).toMatchObject({
      kind: 9001,
      tags: [
        ["h", id],
        ["p", t.target.pubkey],
      ],
    });
  },
);
it.each(["other", "invalid"] as const)(
  "does not expose removal for %s ownership to a regular member",
  async (ownership) => {
    const t = await setup(
      "member",
      "bot",
      true,
      undefined,
      true,
      undefined,
      false,
      true,
      undefined,
      ownership,
    );
    await vi.waitFor(() =>
      expect(memberData()).toHaveAttribute("data-refreshing", "false"),
    );
    await t.user.click(
      screen.getByRole("button", { name: /^Actions for Morgan$/ }),
    );
    await screen.findByRole("menuitem", { name: "View profile" });
    expect(
      screen.queryByRole("menuitem", { name: "Remove from channel" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitemradio")).not.toBeInTheDocument();
  },
);

it.each(["owner", "admin"])(
  "lets %s explicitly promote a bot while preserving verified agent identity",
  async (actor) => {
    const t = await setup(actor, "bot", true, undefined, true);
    await t.user.click(
      screen.getByRole("button", { name: "Actions for Morgan" }),
    );
    expect(
      await screen.findByRole("menuitemradio", { name: "Participating" }),
    ).toHaveAttribute("aria-checked", "true");
    await t.user.keyboard("{Escape}");
    const dialog = await t.choose("Set as admin");
    expect(dialog).toHaveTextContent("from Participating to Admin");
    expect(t.publish).not.toHaveBeenCalled();
    await t.user.click(
      within(dialog).getByRole("button", { name: "Set as admin" }),
    );
    await vi.waitFor(() =>
      expect(
        t.session.memberAdministration.snapshot(id).operation?.status,
      ).toBe("confirmed"),
    );
    expect(
      screen.queryByText("Member change confirmed."),
    ).not.toBeInTheDocument();
    const row = screen.getByRole("button", { name: /Open profile for Morgan/ });
    expect(row.closest("section")).toHaveAttribute("aria-label", "Agents");
    expect(
      row.closest("li")?.querySelector('[data-avatar-shape="squircle"]'),
    ).toBeInTheDocument();
    expect(row).toHaveAccessibleName(/, admin$/);
    expect(t.publish).toHaveBeenCalledOnce();
  },
);
