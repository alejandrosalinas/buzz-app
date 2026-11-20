// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { npubEncode } from "nostr-tools/nip19";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayData } from "../../features/relay/service";
import { mediaUrl } from "../../features/relay/transport";
import { publicKeyLabels } from "../../shared/identity/public-key";
import { allowedActions, membersFromSnapshot } from "./api";
import { CommunityAdmin } from "./CommunityAdmin";

// Exercise the retained direct-add implementation while its shipping UI is hidden.
vi.mock("./features", () => ({ DIRECT_MEMBER_ADD_ENABLED: true }));

const relayKey = "f".repeat(64);
const owner = "0".repeat(64);
const admin = "1".repeat(64);
const member = "2".repeat(64);
const snapshot = (tags: string[][], pubkey = relayKey) => ({
  id: "e".repeat(64),
  kind: 13534,
  pubkey,
  created_at: 1,
  content: "",
  sig: "",
  tags,
});
const roster = [
  ["-"],
  ["member", owner, "owner"],
  ["member", admin, "admin"],
  ["member", member, "member"],
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("reads roles only from the relay-signed member list", () => {
  expect(membersFromSnapshot(snapshot(roster), relayKey)).toEqual([
    { pubkey: owner, role: "owner" },
    { pubkey: admin, role: "admin" },
    { pubkey: member, role: "member" },
  ]);
  expect(() =>
    membersFromSnapshot(snapshot(roster, owner), relayKey),
  ).toThrow();
  expect(
    membersFromSnapshot(
      snapshot([
        ["p", admin, "", "owner"],
        ["member", "A".repeat(64), "owner"],
      ]),
      relayKey,
    ),
  ).toEqual([]);
});

it("offers only actions the relay permission matrix allows", () => {
  const m = (role: "owner" | "admin" | "member") => ({ pubkey: member, role });
  expect(allowedActions("owner", m("member"), false)).toEqual([
    "promote",
    "remove",
  ]);
  expect(allowedActions("owner", m("admin"), false)).toEqual([
    "demote",
    "remove",
  ]);
  expect(allowedActions("owner", m("owner"), false)).toEqual([]);
  expect(allowedActions("owner", m("admin"), true)).toEqual([]);
  expect(allowedActions("admin", m("member"), false)).toEqual(["remove"]);
  expect(allowedActions("admin", m("admin"), false)).toEqual([]);
  expect(allowedActions("member", m("member"), false)).toEqual([]);
  expect(allowedActions(undefined, m("member"), false)).toEqual([]);
});

function relay(
  viewer: string,
  events = [snapshot(roster)],
  profiles = new Map<string, { name: string; picture?: string }>(),
  people: { pubkey: string; name: string }[] = [],
) {
  const read = vi.fn(async () => events);
  const live = new Set<
    (batch: { events: ReturnType<typeof snapshot>[] }) => void
  >();
  const session = {
    relayAuthor: relayKey,
    subscribeLive: (
      listener: (batch: { events: ReturnType<typeof snapshot>[] }) => void,
    ) => {
      live.add(listener);
      return () => live.delete(listener);
    },
    read,
    viewer,
    // The real sizing rewrite behind a pass-through proxy, as the session applies it.
    media: (url: string, size?: "small") =>
      mediaUrl(url, (proxied) => proxied, "https://primary.example", size),
    directMessages: {
      people: async () => ({ people, hasMore: false }),
    },
    profiles: {
      subscribe: () => () => {},
      snapshot: () => profiles,
      ensure: async () => {},
    },
  };
  const value = {
    status: "ready",
    generation: 1,
    scope: `https://primary.example:${viewer}`,
    viewer,
    session,
  };
  return {
    emit: () => {
      for (const listener of live) listener({ events });
    },
    read,
    relay: {
      snapshot: () => value,
      subscribe: () => () => {},
    } as unknown as RelayData,
  };
}

function broker(
  routes: Record<string, (body: unknown) => Response | Promise<Response>>,
) {
  const calls: { route: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const route = String(url).split("/").at(-1) ?? "";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ route, body });
      if (route === "session") return Response.json({ relayAuthor: relayKey });
      // Scoped requests register their community with the broker first.
      if (route === "register") return new Response(null, { status: 204 });
      return routes[route]?.(body) ?? Response.json({}, { status: 404 });
    }),
  );
  return calls;
}

it("gates administration to owners and admins by the verified roster", async () => {
  broker({});
  const { relay: data, read } = relay(member);
  render(<CommunityAdmin relay={data} active={() => true} />);
  expect(
    await screen.findByText(
      "Only community owners and admins can invite people or manage members.",
    ),
  ).toBeVisible();
  expect(read).toHaveBeenCalledWith(
    [{ kinds: [13534], authors: [relayKey], limit: 1 }],
    expect.objectContaining({ fresh: true }),
  );
  expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
});

it("treats a roster signed by anyone else as unavailable", async () => {
  broker({});
  const { relay: data } = relay(owner, [snapshot(roster, owner)]);
  render(<CommunityAdmin relay={data} active={() => true} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not load members",
  );
});

it("mints a bounded invite and surfaces relay refusals", async () => {
  const user = userEvent.setup();
  let refuse = false;
  const calls = broker({
    invite: (body) =>
      refuse
        ? Response.json(
            { error: "only relay owners and admins can create invites" },
            { status: 403 },
          )
        : Response.json({
            code: "abc",
            url: "https://primary.example/invite/abc",
            expires_at: 1700003600,
            max_uses: (body as { max_uses: number | null }).max_uses,
            uses_remaining: (body as { max_uses: number | null }).max_uses,
          }),
  });
  const { relay: data } = relay(admin);
  render(<CommunityAdmin relay={data} active={() => true} />);
  await user.click(await screen.findByRole("tab", { name: "Invite" }));
  // Opening the dialog creates the link with the default settings.
  expect(
    await screen.findByDisplayValue("https://primary.example/invite/abc"),
  ).toBeVisible();
  expect(calls.filter((c) => c.route === "invite")).toEqual([
    { route: "invite", body: { ttl_secs: 3 * 24 * 60 * 60, max_uses: null } },
  ]);
  // QR codes come from the native renderer; the browser host has none.
  expect(screen.queryByRole("img")).toBeNull();
  // Admins cannot grant admin, so direct addition has no role choice.
  await user.click(screen.getByRole("tab", { name: "Add directly" }));
  await user.type(
    screen.getByRole("textbox", { name: "Public identity" }),
    "3".repeat(64),
  );
  expect(screen.getByRole("button", { name: "Add member" })).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "Choose member role" }),
  ).toBeNull();
  await user.click(screen.getByRole("tab", { name: "Invite" }));
  refuse = true;
  await user.click(
    screen.getByRole("button", { name: "Choose maximum invite uses" }),
  );
  await user.click(await screen.findByRole("menuitemradio", { name: "1 use" }));
  expect(screen.queryByRole("menuitemradio")).toBeNull();
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "only relay owners and admins can create invites",
    ),
  );
  expect(calls.filter((c) => c.route === "invite").at(-1)?.body).toEqual({
    ttl_secs: 3 * 24 * 60 * 60,
    max_uses: 1,
  });
  expect(
    screen.queryByDisplayValue("https://primary.example/invite/abc"),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
});

it("confirms member removal and shows the relay's refusal", async () => {
  const user = userEvent.setup();
  const calls = broker({
    member: () =>
      Response.json(
        { error: "invalid: cannot remove the relay owner" },
        { status: 400 },
      ),
  });
  const { relay: data } = relay(owner);
  render(<CommunityAdmin relay={data} active={() => true} />);
  expect(
    screen.queryByRole("button", { name: `Actions for ${owner.slice(0, 8)}` }),
  ).toBeNull();
  const menus = await screen.findAllByRole("button", { name: /^Actions for / });
  expect(menus).toHaveLength(2); // Admin and member; never the viewer/owner.
  await user.click(menus[1] as HTMLElement);
  await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
  expect(calls.some((c) => c.route === "member")).toBe(false);
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Remove",
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "invalid: cannot remove the relay owner",
    ),
  );
  expect(calls.find((c) => c.route === "member")?.body).toEqual({
    action: "remove",
    pubkey: member,
  });
});

it("keeps an accepted removal when the refresh fails and retries read-only", async () => {
  const user = userEvent.setup();
  const calls = broker({
    member: () => Response.json({ accepted: true, message: "" }),
  });
  const { relay: data, read } = relay(owner);
  render(<CommunityAdmin relay={data} active={() => true} />);
  const menus = await screen.findAllByRole("button", { name: /^Actions for / });
  read.mockRejectedValueOnce(new Error("relay unavailable"));
  await user.click(menus[1] as HTMLElement);
  await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Remove",
    }),
  );
  expect(
    await screen.findByText("Change accepted by the relay."),
  ).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not load members: relay unavailable The list below may be out of date.",
  );
  // A stale list offers no further destructive commands.
  expect(screen.queryAllByRole("button", { name: /^Actions for / })).toEqual(
    [],
  );
  expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  read.mockResolvedValueOnce([
    snapshot([
      ["member", owner, "owner"],
      ["member", admin, "admin"],
    ]),
  ]);
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getAllByRole("button", { name: /^Actions for / })).toHaveLength(
    1,
  );
  expect(calls.filter((c) => c.route === "member")).toHaveLength(1);
});

it("picks up a promotion made elsewhere from the live roster stream", async () => {
  broker({});
  const { relay: data, read, emit } = relay(member);
  render(<CommunityAdmin relay={data} active={() => true} />);
  await screen.findByText(
    "Only community owners and admins can invite people or manage members.",
  );
  read.mockResolvedValueOnce([
    snapshot([
      ["member", owner, "owner"],
      ["member", member, "admin"],
    ]),
  ]);
  act(() => emit());
  expect(await screen.findByRole("tab", { name: "Invite" })).toBeVisible();
});

it("recovers from an initial read failure on retry", async () => {
  const user = userEvent.setup();
  broker({});
  const { relay: data, read } = relay(owner);
  read.mockRejectedValueOnce(new Error("offline"));
  render(<CommunityAdmin relay={data} active={() => true} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not load members: offline",
  );
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("tab", { name: "Invite" })).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("disables an open confirmation when a pending refresh fails", async () => {
  const user = userEvent.setup();
  const calls = broker({
    member: () => Response.json({ accepted: true, message: "" }),
  });
  const { relay: data, read, emit } = relay(owner);
  render(<CommunityAdmin relay={data} active={() => true} />);
  const menus = await screen.findAllByRole("button", { name: /^Actions for / });
  await user.click(menus[1] as HTMLElement);
  await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
  const dialog = await screen.findByRole("alertdialog");
  const confirm = within(dialog).getByRole("button", { name: "Remove" });
  expect(confirm).toBeEnabled();
  const held = deferred<ReturnType<typeof snapshot>[]>();
  read.mockReturnValueOnce(held.promise);
  // Refresh stays reachable behind the modal in the browser; drive it directly.
  act(() => emit());
  await waitFor(() => expect(confirm).toBeDisabled());
  held.reject(new Error("relay unavailable"));
  expect(
    await within(dialog).findByText(
      "The member list is out of date. Retry before making changes.",
    ),
  ).toBeVisible();
  expect(confirm).toBeDisabled();
  confirm.click();
  await Promise.resolve();
  expect(calls.filter((c) => c.route === "member")).toHaveLength(0);
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(calls.filter((c) => c.route === "member")).toHaveLength(0);
});

it("locks sharing tabs after an accepted add whose refresh fails", async () => {
  const user = userEvent.setup();
  const calls = broker({
    member: () => Response.json({ accepted: true, message: "" }),
    invite: () =>
      Response.json({
        code: "abc",
        url: "https://primary.example/invite/abc",
        expires_at: 1700003600,
        max_uses: null,
        uses_remaining: null,
      }),
  });
  const { relay: data, read } = relay(owner);
  render(<CommunityAdmin relay={data} active={() => true} />);
  await user.click(await screen.findByRole("tab", { name: "Invite" }));
  const dialog = screen.getByRole("region", { name: "Membership" });
  await within(dialog).findByDisplayValue("https://primary.example/invite/abc");
  await user.click(screen.getByRole("tab", { name: "Add directly" }));
  read.mockRejectedValueOnce(new Error("relay unavailable"));
  // The field resets after a confirmed direct addition.
  const search = () =>
    within(dialog).getByRole("textbox", {
      name: "Public identity",
    });
  await user.type(search(), "3".repeat(64));
  await user.click(within(dialog).getByRole("button", { name: "Add member" }));
  expect(
    await within(dialog).findByText("Member added directly."),
  ).toBeVisible();
  expect(
    await within(dialog).findByText(
      "The member list is out of date. Retry before making changes.",
    ),
  ).toBeVisible();
  await user.type(search(), "4".repeat(64));
  expect(
    within(dialog).getByRole("button", { name: "Add member" }),
  ).toBeDisabled();
  await user.click(screen.getByRole("tab", { name: "Invite" }));
  expect(
    within(dialog).getByRole("button", { name: "Choose maximum invite uses" }),
  ).toBeDisabled();
  await user.click(screen.getByRole("tab", { name: "Add directly" }));
  expect(calls.filter((c) => c.route === "member")).toHaveLength(1);
  expect(calls.filter((c) => c.route === "invite")).toHaveLength(1);
  // Read-only recovery inside the modal re-enables new writes.
  await user.click(within(dialog).getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Add member" }),
    ).toBeEnabled(),
  );
  expect(calls.filter((c) => c.route === "member")).toHaveLength(1);
  // Recovery keeps the existing link rather than minting another.
  expect(calls.filter((c) => c.route === "invite")).toHaveLength(1);
});

it.each([
  ["equal", "Bob"],
  ["visually identical", "Bob\u200B"],
])(
  "qualifies %s namesakes through roster actions, confirmation and the write",
  async (_, nameB) => {
    const user = userEvent.setup();
    const bobA = "a".repeat(64);
    const bobB = "b".repeat(64);
    const calls = broker({
      member: () => Response.json({ accepted: true, message: "" }),
    });
    const { relay: data } = relay(
      owner,
      [
        snapshot([
          ["member", owner, "owner"],
          ["member", bobA, "member"],
          ["member", bobB, "member"],
        ]),
      ],
      new Map([
        [
          bobA,
          {
            name: "Bob",
            picture: `https://primary.example/media/${bobA}.png`,
          },
        ],
        [bobB, { name: nameB }],
      ]),
    );
    render(<CommunityAdmin relay={data} active={() => true} />);
    const keys = publicKeyLabels([owner, bobA, bobB]);
    const labelB = `${nameB} · ${keys.get(bobB)}`;
    expect(keys.get(bobA)).not.toBe(keys.get(bobB));
    const actionsA = await screen.findByRole("button", {
      name: `Actions for Bob · ${keys.get(bobA)}`,
    });
    expect(actionsA).toBeVisible();
    // A relay-hosted picture goes through the session proxy as the thumbnail;
    // the raw URL would be an unsigned request the relay refuses.
    expect(actionsA.closest("li")?.querySelector("img")).toHaveAttribute(
      "src",
      `https://primary.example/media/${bobA}.thumb.webp`,
    );
    await user.click(
      screen.getByRole("button", { name: `Actions for ${labelB}` }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Make admin" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(`Make admin: ${labelB}?`);
    await user.click(
      within(dialog).getByRole("button", { name: "Make admin" }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.route === "member")?.body).toEqual({
        action: "role",
        pubkey: bobB,
        role: "admin",
      }),
    );
  },
);

it("accepts only an exact identity and never searches the people directory", async () => {
  const user = userEvent.setup();
  const calls = broker({
    member: () => Response.json({ accepted: true, message: "" }),
    invite: () =>
      Response.json({
        code: "abc",
        url: "https://primary.example/invite/abc",
        expires_at: 1700003600,
        max_uses: null,
        uses_remaining: null,
      }),
  });
  const people = vi.fn(async () => ({ people: [], hasMore: false }));
  const { relay: data } = relay(owner);
  (
    data.snapshot().session.directMessages as unknown as {
      people: typeof people;
    }
  ).people = people;
  render(<CommunityAdmin relay={data} active={() => true} />);
  await user.click(await screen.findByRole("tab", { name: "Add directly" }));
  const dialog = screen.getByRole("tabpanel");
  const identity = within(dialog).getByRole("textbox", {
    name: "Public identity",
  });
  const add = within(dialog).getByRole("button", { name: "Add member" });
  await user.type(identity, "Carol");
  expect(add).toBeDisabled();
  expect(people).not.toHaveBeenCalled();
  await user.clear(identity);
  await user.type(identity, "c".repeat(64));
  expect(add).toBeEnabled();
  await user.click(add);
  await waitFor(() =>
    expect(calls.find((call) => call.route === "member")?.body).toEqual({
      action: "add",
      pubkey: "c".repeat(64),
      role: "member",
    }),
  );
  expect(people).not.toHaveBeenCalled();
});

it("adds a member by a nostr: npub and refuses an npub that is not a 32-byte key", async () => {
  const user = userEvent.setup();
  const calls = broker({
    member: () => Response.json({ accepted: true, message: "" }),
  });
  render(<CommunityAdmin relay={relay(owner).relay} active={() => true} />);
  await user.click(await screen.findByRole("tab", { name: "Add directly" }));
  const dialog = screen.getByRole("tabpanel");
  const identity = within(dialog).getByRole("textbox", {
    name: "Public identity",
  });
  const add = within(dialog).getByRole("button", { name: "Add member" });
  // A valid checksum over a 20-byte payload, which nip19 decodes to 40 hex.
  await user.click(identity);
  await user.paste("npub1qurswpc8qurswpc8qurswpc8qurswpc86nz8sw");
  const refusal = "Enter an npub or 64-character hex public key.";
  expect(within(dialog).getByText(refusal)).toBeVisible();
  expect(add).toBeDisabled();
  await user.keyboard("{Enter}");
  expect(calls.some((call) => call.route === "member")).toBe(false);
  await user.clear(identity);
  await user.paste(`nostr:${npubEncode("3".repeat(64))}`);
  expect(within(dialog).queryByText(refusal)).toBeNull();
  await user.click(add);
  await waitFor(() =>
    expect(calls.find((call) => call.route === "member")?.body).toEqual({
      action: "add",
      pubkey: "3".repeat(64),
      role: "member",
    }),
  );
});

it("clears an unsubmitted confirmation when history leaves Members", async () => {
  const user = userEvent.setup();
  const calls = broker({});
  const { relay: data } = relay(owner);
  const view = render(
    <CommunityAdmin
      relay={data}
      active={() => true}
      selectedMethod="members"
    />,
  );
  const menus = await screen.findAllByRole("button", { name: /^Actions for / });
  await user.click(menus[1] as HTMLElement);
  await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
  expect(await screen.findByRole("alertdialog")).toBeVisible();
  view.rerender(
    <CommunityAdmin relay={data} active={() => true} selectedMethod="invite" />,
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.getByRole("tab", { name: "Members" })).toBeEnabled();
  view.rerender(
    <CommunityAdmin
      relay={data}
      active={() => true}
      selectedMethod="members"
    />,
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(calls.some((call) => call.route === "member")).toBe(false);
});

it("creates a fresh invite with unchanged limits after leaving the tab", async () => {
  const user = userEvent.setup();
  let minted = 0;
  const calls = broker({
    invite: (body) =>
      Response.json({
        code: String(++minted),
        url: `https://primary.example/invite/${minted}`,
        expires_at: 1700003600,
        max_uses: (body as { max_uses: number | null }).max_uses,
        uses_remaining: (body as { max_uses: number | null }).max_uses,
      }),
  });
  const { relay: data } = relay(owner);
  render(<CommunityAdmin relay={data} active={() => true} />);
  await user.click(await screen.findByRole("tab", { name: "Invite" }));
  await screen.findByDisplayValue("https://primary.example/invite/1");
  await user.click(
    screen.getByRole("button", { name: "Choose maximum invite uses" }),
  );
  await user.click(
    await screen.findByRole("menuitemradio", { name: /^1 use$/ }),
  );
  await screen.findByDisplayValue("https://primary.example/invite/2");
  await user.click(screen.getByRole("tab", { name: "Members" }));
  await user.click(screen.getByRole("tab", { name: "Invite" }));
  expect(
    await screen.findByDisplayValue("https://primary.example/invite/3"),
  ).toBeVisible();
  expect(
    calls
      .filter((call) => call.route === "invite")
      .slice(-2)
      .map((call) => call.body),
  ).toEqual([
    { ttl_secs: 3 * 24 * 60 * 60, max_uses: 1 },
    { ttl_secs: 3 * 24 * 60 * 60, max_uses: 1 },
  ]);
});

it("ignores a late mint from a previous Invite visit", async () => {
  let finish!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  let count = 0;
  const response = (code: string) =>
    Response.json({
      code,
      url: `https://primary.example/invite/${code}`,
      expires_at: 1700003600,
      max_uses: null,
      uses_remaining: null,
    });
  const calls = broker({
    invite: () => (++count === 1 ? held : response("new")),
  });
  const { relay: data } = relay(owner);
  const active = () => true;
  const view = render(
    <CommunityAdmin relay={data} active={active} selectedMethod="invite" />,
  );
  await waitFor(() =>
    expect(calls.filter((call) => call.route === "invite")).toHaveLength(1),
  );
  view.rerender(
    <CommunityAdmin relay={data} active={active} selectedMethod="members" />,
  );
  view.rerender(
    <CommunityAdmin relay={data} active={active} selectedMethod="invite" />,
  );
  await screen.findByDisplayValue("https://primary.example/invite/new");
  await act(async () => {
    finish(response("old"));
    await held;
  });
  expect(
    screen.getByDisplayValue("https://primary.example/invite/new"),
  ).toBeVisible();
  expect(
    screen.queryByDisplayValue("https://primary.example/invite/old"),
  ).toBeNull();
});

it("lists invite links and revokes one by row or by pasted link", async () => {
  const user = userEvent.setup();
  const permanent = "0b9c8f7e-1d2a-4b3c-9e8f-7a6b5c4d3e2f";
  let revoked = false;
  const calls = broker({
    invites: () =>
      Response.json({
        invites: [
          {
            id: permanent,
            created_by: owner,
            created_at: 1700000000,
            expires_at: 4102444800,
            max_uses: null,
            use_count: 2,
            revoked_at: revoked ? 1700000100 : null,
            status: revoked ? "revoked" : "active",
          },
          {
            id: "1b9c8f7e-1d2a-4b3c-9e8f-7a6b5c4d3e2f",
            created_by: admin,
            created_at: 1690000000,
            expires_at: 1690003600,
            max_uses: 5,
            use_count: 5,
            revoked_at: null,
            status: "exhausted",
          },
        ],
        next_before: null,
      }),
    "invite-revoke": (body) => {
      revoked = true;
      return Response.json({
        id: (body as { id?: string }).id ?? permanent,
        revoked_at: 1700000100,
      });
    },
  });
  const { relay: data } = relay(owner);
  render(<CommunityAdmin relay={data} active={() => true} />);
  await user.click(await screen.findByRole("tab", { name: "Links" }));
  const list = await screen.findByRole("list", { name: "Invite links" });
  expect(list).toHaveTextContent("Active · 2 uses · Expires");
  expect(list).toHaveTextContent("Used up · 5 of 5 uses · Expired");
  expect(calls.find((c) => c.route === "invites")?.body).toEqual({});

  const [rowRevoke] = screen.getAllByRole("button", { name: /^Revoke Link/ });
  await user.click(rowRevoke as HTMLElement);
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog).toHaveTextContent(/Link 0b9c8f7e by .+, created /);
  await user.click(
    within(dialog).getByRole("button", {
      name: "Revoke",
    }),
  );
  await waitFor(() =>
    expect(list).toHaveTextContent("Revoked · 2 uses · Expires"),
  );
  expect(calls.filter((c) => c.route === "invite-revoke")).toEqual([
    { route: "invite-revoke", body: { id: permanent } },
  ]);

  const field = screen.getByRole("textbox", { name: "Revoke a link" });
  await user.type(field, "https://other.example/invite/abc");
  expect(field).toHaveAccessibleDescription(
    "This invite link is for a different community.",
  );
  expect(field).toHaveAttribute("aria-invalid", "true");
  await user.clear(field);
  await user.type(field, "https://primary.example/invite/abc");
  await user.click(screen.getByRole("button", { name: "Revoke" }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Revoke",
    }),
  );
  await waitFor(() =>
    expect(
      calls.filter((c) => c.route === "invite-revoke").at(-1)?.body,
    ).toEqual({ code: "abc" }),
  );
});

const linkId = (n: number) => `${n}b9c8f7e-1d2a-4b3c-9e8f-7a6b5c4d3e2f`;
const link = (n: number, extra: Record<string, unknown> = {}) => ({
  id: linkId(n),
  created_by: owner,
  created_at: 1700000000 - n,
  expires_at: 4102444800,
  max_uses: null,
  use_count: 0,
  revoked_at: null,
  status: "active",
  ...extra,
});
const unavailable = () =>
  Response.json(
    { error: "community writes are temporarily unavailable" },
    { status: 503 },
  );

it("shows a revoke from its receipt and keeps older pages on refresh", async () => {
  const user = userEvent.setup();
  let reads = 0;
  const calls = broker({
    invites: (body) => {
      reads++;
      if ((body as { before?: string }).before)
        return Response.json({ invites: [link(2)], next_before: null });
      // The read after the first page fails; the receipt alone shows the revoke.
      if (reads === 3) return unavailable();
      return Response.json({
        invites: [link(1)],
        next_before: `1699999999_${linkId(1)}`,
      });
    },
    "invite-revoke": (body) =>
      Response.json({
        id: (body as { id: string }).id,
        revoked_at: 1700000100,
      }),
  });
  const { relay: data } = relay(owner);
  render(<CommunityAdmin relay={data} active={() => true} />);
  await user.click(await screen.findByRole("tab", { name: "Links" }));
  const list = await screen.findByRole("list", { name: "Invite links" });
  await user.click(screen.getByRole("button", { name: "Show more" }));
  await waitFor(() =>
    expect(calls.filter((c) => c.route === "invites").at(-1)?.body).toEqual({
      before: `1699999999_${linkId(1)}`,
    }),
  );
  await waitFor(() =>
    expect(within(list).getAllByRole("listitem")).toHaveLength(2),
  );

  await user.click(
    screen.getAllByRole("button", {
      name: /^Revoke Link 1b9c8f7e/,
    })[0] as HTMLElement,
  );
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Revoke",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(list).toHaveFocus());
  const [first] = within(list).getAllByRole("listitem");
  expect(first).toHaveTextContent("Revoked");
  expect(within(first as HTMLElement).queryByRole("button")).toBeNull();

  await user.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "community writes are temporarily unavailable",
  );
  // The receipt still wins, and Retry works with the list loaded.
  expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("Revoked");
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("Revoked");
  expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
});

it("lands a held revoke after Back and Forward", async () => {
  const user = userEvent.setup();
  let finish!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  broker({
    invites: () => Response.json({ invites: [link(1)], next_before: null }),
    "invite-revoke": () => held,
  });
  const { relay: data } = relay(owner);
  const active = () => true;
  const view = render(
    <CommunityAdmin relay={data} active={active} selectedMethod="links" />,
  );
  await user.click(await screen.findByRole("button", { name: /^Revoke Link/ }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Revoke",
    }),
  );
  view.rerender(
    <CommunityAdmin relay={data} active={active} selectedMethod="members" />,
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
  view.rerender(
    <CommunityAdmin relay={data} active={active} selectedMethod="links" />,
  );
  await act(async () => {
    finish(Response.json({ id: linkId(1), revoked_at: 1700000100 }));
    await held;
  });
  const list = await screen.findByRole("list", { name: "Invite links" });
  await waitFor(() => expect(list).toHaveTextContent("Revoked"));
  expect(screen.queryByRole("button", { name: /^Revoke Link/ })).toBeNull();
});

it("keeps the confirmation open with a retry when revoke fails", async () => {
  const user = userEvent.setup();
  let attempts = 0;
  const calls = broker({
    invites: () => Response.json({ invites: [link(1)], next_before: null }),
    "invite-revoke": () =>
      ++attempts === 1
        ? Response.json({ error: "invite_not_found" }, { status: 404 })
        : Response.json({ id: linkId(1), revoked_at: 1700000100 }),
  });
  const { relay: data } = relay(owner);
  render(
    <CommunityAdmin relay={data} active={() => true} selectedMethod="links" />,
  );
  await user.click(await screen.findByRole("button", { name: /^Revoke Link/ }));
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Revoke" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "No invite link in this community matches that link.",
  );
  expect(dialog).not.toHaveTextContent("invite_not_found");
  expect(dialog).toHaveTextContent(/Link 1b9c8f7e/);
  await user.click(within(dialog).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(
    calls.filter((c) => c.route === "invite-revoke").map((c) => c.body),
  ).toEqual([{ id: linkId(1) }, { id: linkId(1) }]);
  expect(screen.getByRole("list", { name: "Invite links" })).toHaveTextContent(
    "Revoked",
  );
});

it("shows a listed link without an expiry as never expiring", async () => {
  broker({
    invites: () =>
      Response.json({
        invites: [link(1, { expires_at: null })],
        next_before: null,
      }),
  });
  const { relay: data } = relay(owner);
  render(
    <CommunityAdmin relay={data} active={() => true} selectedMethod="links" />,
  );
  expect(
    await screen.findByRole("list", { name: "Invite links" }),
  ).toHaveTextContent("Active · 0 uses · Never expires");
});

it("refresh re-reads loaded pages and resolves a lost page-two receipt", async () => {
  const user = userEvent.setup();
  let committed = false;
  // Same creation second, UUIDs in the opposite order to the relay's cursor order.
  const later = link(1, { created_at: 1700000000 });
  const earlier = link(9, { created_at: 1700000000 });
  const calls = broker({
    invites: (body) =>
      (body as { before?: string }).before
        ? Response.json({
            invites: [
              {
                ...earlier,
                ...(committed && { status: "revoked", revoked_at: 1700000100 }),
              },
            ],
            next_before: null,
          })
        : Response.json({
            invites: [later],
            next_before: `1700000000000001_${linkId(1)}`,
          }),
    "invite-revoke": () => {
      committed = true;
      return unavailable();
    },
  });
  const { relay: data } = relay(owner);
  render(
    <CommunityAdmin relay={data} active={() => true} selectedMethod="links" />,
  );
  const list = await screen.findByRole("list", { name: "Invite links" });
  await user.click(screen.getByRole("button", { name: "Show more" }));
  await waitFor(() =>
    expect(within(list).getAllByRole("listitem")).toHaveLength(2),
  );
  await user.click(
    screen.getByRole("button", { name: /^Revoke Link 9b9c8f7e/ }),
  );
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Revoke" }));
  await within(dialog).findByRole("alert");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(within(list).getAllByRole("listitem")[1]).toHaveTextContent(
      "Revoked",
    ),
  );
  const rows = within(list).getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent("Link 1b9c8f7e");
  expect(rows[0]).toHaveTextContent("Active");
  expect(
    calls
      .filter((c) => c.route === "invites")
      .slice(-2)
      .map((c) => c.body),
  ).toEqual([{}, { before: `1700000000000001_${linkId(1)}` }]);
});

it("keeps the shown list when a refresh read fails partway", async () => {
  const user = userEvent.setup();
  let failOlder = false;
  broker({
    invites: (body) =>
      (body as { before?: string }).before
        ? failOlder
          ? unavailable()
          : Response.json({ invites: [link(2)], next_before: null })
        : Response.json({
            invites: [link(1, { use_count: failOlder ? 7 : 0 })],
            next_before: `1699999999_${linkId(1)}`,
          }),
  });
  const { relay: data } = relay(owner);
  render(
    <CommunityAdmin relay={data} active={() => true} selectedMethod="links" />,
  );
  const list = await screen.findByRole("list", { name: "Invite links" });
  await user.click(screen.getByRole("button", { name: "Show more" }));
  await waitFor(() =>
    expect(within(list).getAllByRole("listitem")).toHaveLength(2),
  );
  failOlder = true;
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByRole("alert");
  const rows = within(list).getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent("0 uses");
  expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
});

it("ignores an older list response that arrives after a newer one", async () => {
  let finish!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  let reads = 0;
  broker({
    invites: () =>
      ++reads === 1
        ? held
        : Response.json({ invites: [link(2)], next_before: null }),
  });
  const { relay: data } = relay(owner);
  const active = () => true;
  const view = render(
    <CommunityAdmin relay={data} active={active} selectedMethod="links" />,
  );
  await waitFor(() => expect(reads).toBe(1));
  view.rerender(
    <CommunityAdmin relay={data} active={active} selectedMethod="members" />,
  );
  view.rerender(
    <CommunityAdmin relay={data} active={active} selectedMethod="links" />,
  );
  const list = await screen.findByRole("list", { name: "Invite links" });
  await waitFor(() => expect(list).toHaveTextContent("Link 2b9c8f7e"));
  await act(async () => {
    finish(Response.json({ invites: [link(1)], next_before: null }));
    await held;
  });
  expect(list).toHaveTextContent("Link 2b9c8f7e");
  expect(list).not.toHaveTextContent("Link 1b9c8f7e");
});

it("keeps Links hidden on Members and drops only an unsent confirmation", async () => {
  const user = userEvent.setup();
  const calls = broker({
    invites: () => Response.json({ invites: [link(1)], next_before: null }),
  });
  const { relay: data } = relay(owner);
  const active = () => true;
  const view = render(
    <CommunityAdmin relay={data} active={active} selectedMethod="links" />,
  );
  await user.click(await screen.findByRole("button", { name: /^Revoke Link/ }));
  expect(await screen.findByRole("alertdialog")).toBeVisible();
  view.rerender(
    <CommunityAdmin relay={data} active={active} selectedMethod="members" />,
  );
  expect(
    screen.getByRole("list", { name: "Invite links", hidden: true }),
  ).not.toBeVisible();
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  view.rerender(
    <CommunityAdmin relay={data} active={active} selectedMethod="links" />,
  );
  expect(
    await screen.findByRole("list", { name: "Invite links" }),
  ).toBeVisible();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(calls.some((c) => c.route === "invite-revoke")).toBe(false);
});

it("shows a revoke failure that arrived while Links was hidden", async () => {
  const user = userEvent.setup();
  let finish!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  broker({
    invites: () => Response.json({ invites: [link(1)], next_before: null }),
    "invite-revoke": () => held,
  });
  const { relay: data } = relay(owner);
  const active = () => true;
  const view = render(
    <CommunityAdmin relay={data} active={active} selectedMethod="links" />,
  );
  await user.click(await screen.findByRole("button", { name: /^Revoke Link/ }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Revoke",
    }),
  );
  view.rerender(
    <CommunityAdmin relay={data} active={active} selectedMethod="members" />,
  );
  await act(async () => {
    finish(unavailable());
    await held.catch(() => {});
  });
  view.rerender(
    <CommunityAdmin relay={data} active={active} selectedMethod="links" />,
  );
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "community writes are temporarily unavailable",
  );
  expect(within(dialog).getByRole("button", { name: "Retry" })).toBeEnabled();
  // The open modal hides the list from the accessibility tree.
  expect(
    screen.getByRole("list", { name: "Invite links", hidden: true }),
  ).toHaveTextContent("Active");
});

it("keeps focus on the confirm action after a refused revoke", async () => {
  const user = userEvent.setup();
  let finish!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const calls = broker({
    invites: () => Response.json({ invites: [link(1)], next_before: null }),
    "invite-revoke": () => held,
  });
  const { relay: data } = relay(owner);
  render(
    <CommunityAdmin relay={data} active={() => true} selectedMethod="links" />,
  );
  await user.click(await screen.findByRole("button", { name: /^Revoke Link/ }));
  const dialog = await screen.findByRole("alertdialog");
  const action = within(dialog).getByRole("button", { name: "Revoke" });
  action.focus();
  await user.keyboard("{Enter}");
  const revokes = () => calls.filter((c) => c.route === "invite-revoke");
  await waitFor(() => expect(revokes()).toHaveLength(1));
  // A second Enter and a click on the busy action send nothing more.
  await user.keyboard("{Enter}");
  await user.click(action);
  expect(revokes()).toHaveLength(1);
  // While loading, the action stays focusable (a disabled button drops focus to
  // the body in browsers) and blocks a second submit.
  await waitFor(() => expect(action).toHaveAttribute("aria-busy", "true"));
  expect(action).not.toHaveAttribute("disabled");
  await act(async () => {
    finish(unavailable());
    await held;
  });
  await within(dialog).findByRole("alert");
  expect(action).toHaveFocus();
  expect(action).toHaveTextContent("Retry");
});
