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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { verifyEvent, type EventTemplate } from "nostr-tools";
import { nativeIdentityEnabled } from "../../features/identity/service";
import type { Role } from "../../features/communities/roster";
import type { RelayEvent } from "../../features/relay/events";
import { keypair, signed, type Key } from "../../features/relay/testing";
import type { RelayData } from "../../features/relay/service";
import { CommunityAdmin } from "./CommunityAdmin";
import { apply } from "./index";
import { createCommunityMembership } from "./membership";

const { relayKey } = vi.hoisted(() => ({ relayKey: "f".repeat(64) }));

// Exercise the retained direct-add implementation while its shipping UI is hidden.
vi.mock("./features", () => ({ DIRECT_MEMBER_ADD_ENABLED: true }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("unexpected native call");
  }),
  isTauri: () => true,
}));

const ownerKey = keypair();
const adminKey = keypair();
const owner = ownerKey.pubkey;
const admin = adminKey.pubkey;
const member = "2".repeat(64);
const added = "3".repeat(64);
const INITIAL: [string, Role][] = [
  [owner, "owner"],
  [admin, "admin"],
  [member, "member"],
];
/** The relay's persisted roster: accepted commands change it, reads see it. */
let roster = new Map(INITIAL);
const snapshot = () => ({
  id: "e".repeat(64),
  kind: 13534,
  pubkey: relayKey,
  created_at: 1,
  content: "",
  sig: "",
  tags: [
    ["-"],
    ...[...roster].map(([pubkey, role]) => ["member", pubkey, role]),
  ],
});

type Answer = { status?: number; body?: unknown } | Error;
/** Host stand-in: signs with the viewer's key and applies accepted commands. */
function host(viewer: Key, answer: (event: RelayEvent) => Answer | undefined) {
  const published: RelayEvent[] = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "identity_restore") return viewer.pubkey;
    if (command === "relay_sign")
      return signed(viewer, (args as { event: EventTemplate }).event);
    expect(command).toBe("relay_http");
    const { community, path, method, body } = args as {
      community: string;
      path: string;
      method: string;
      body: string;
    };
    expect({ community, path, method }).toEqual({
      community: "https://primary.example",
      path: "/events",
      method: "POST",
    });
    const event = JSON.parse(body) as RelayEvent;
    expect(verifyEvent(event)).toBe(true);
    published.push(event);
    const result = answer(event) ?? {
      body: { event_id: event.id, accepted: true, message: "" },
    };
    if (result instanceof Error) throw result;
    if ((result.status ?? 200) === 200) {
      const target = event.tags[0]?.[1] as string;
      const role = event.tags[1]?.[1] as Role | undefined;
      if (event.kind === 9031) roster.delete(target);
      else roster.set(target, role as Role);
    }
    return {
      status: result.status ?? 200,
      headers: {},
      body: JSON.stringify(result.body),
    };
  });
  return published;
}

const NAMES = new Map([
  [owner, "Olive"],
  [admin, "Ada"],
  [member, "Mo"],
  [added, "Nia"],
]);
/** The visible role line of one roster row, or null once it is gone. */
function shownRole(pubkey: string) {
  const name = NAMES.get(pubkey) as string;
  const row = within(screen.getByRole("list", { name: "Members" }))
    .queryAllByRole("listitem")
    // Labels are `Name · key`: every target carries a key qualifier.
    .find((item) => within(item).queryByText(new RegExp(`^${name} · `)));
  return row
    ? (within(row).queryByText(/^(Owner|Admin|Member)( · You)?$/)
        ?.textContent ?? "")
    : null;
}
const actions = (pubkey: string) =>
  screen.queryByRole("button", {
    name: new RegExp(`^Actions for ${NAMES.get(pubkey)} · `),
  });

function relay(viewer: string) {
  const read = vi.fn(async () => [snapshot()]);
  const profiles = new Map(
    [...NAMES].map(([pubkey, name]) => [pubkey, { name }]),
  );
  const live = new Set<
    (batch: { events: ReturnType<typeof snapshot>[] }) => void
  >();
  const session = {
    relayAuthor: relayKey,
    read,
    subscribeLive: (
      listener: (batch: { events: ReturnType<typeof snapshot>[] }) => void,
    ) => {
      live.add(listener);
      return () => live.delete(listener);
    },
    viewer,
    media: () => undefined,
    directMessages: { people: async () => ({ people: [], hasMore: false }) },
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
      for (const listener of live) listener({ events: [snapshot()] });
    },
    read,
    relay: {
      snapshot: () => value,
      subscribe: () => () => {},
    } as unknown as RelayData,
  };
}

beforeEach(() => {
  roster = new Map(INITIAL);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubEnv("VITE_BUZZ_LIVE", "");
  // Native builds ship no broker; any fetch would be a routing mistake.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("unexpected broker request");
    }),
  );
});
afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.colorMode;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(invoke).mockClear();
});

it("keeps the Membership card registered in a native build", () => {
  expect(nativeIdentityEnabled()).toBe(true);
  const settingsCards = { register: vi.fn() };
  const data = relay(owner).relay;
  const membership = createCommunityMembership(data);
  apply({
    relay: data,
    adminAccess: { membership },
    settingsCards,
    effect: vi.fn(),
  } as unknown as Parameters<typeof apply>[0]);
  expect(settingsCards.register).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      id: "membership",
      title: "Membership",
      section: "administration",
      component: expect.any(Function),
    }),
  );
  membership.dispose();
});

it("lets a native owner add, promote, demote and remove through the host signer", async () => {
  const user = userEvent.setup();
  const published = host(ownerKey, () => undefined);
  const { relay: data, read } = relay(owner);
  render(<CommunityAdmin relay={data} active={() => true} />);
  await screen.findByRole("list", { name: "Members" });
  // The owner row and the viewer's own row carry no actions.
  expect(actions(owner)).toBeNull();
  expect(actions(admin)).toBeVisible();

  await user.click(screen.getByRole("tab", { name: "Add directly" }));
  // Invite minting is not part of this host stand-in; only the add is exercised.
  const dialog = screen.getByRole("region", { name: "Membership" });
  await user.type(
    within(dialog).getByRole("textbox", { name: "Public identity" }),
    added,
  );
  await user.click(within(dialog).getByRole("button", { name: "Add member" }));
  expect(
    await within(dialog).findByText("Member added directly."),
  ).toBeVisible();
  await user.click(screen.getByRole("tab", { name: "Members" }));
  await waitFor(() => expect(shownRole(added)).toBe("Member"));

  const change = async (pubkey: string, item: string) => {
    await user.click(actions(pubkey) as HTMLElement);
    await user.click(await screen.findByRole("menuitem", { name: item }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: item,
      }),
    );
    expect(
      await screen.findByText("Change accepted by the relay."),
    ).toBeVisible();
  };
  await change(member, "Make admin");
  await waitFor(() => expect(shownRole(member)).toBe("Admin"));
  await change(admin, "Make member");
  await waitFor(() => expect(shownRole(admin)).toBe("Member"));
  await change(added, "Remove");
  await waitFor(() => expect(shownRole(added)).toBeNull());

  // Each write is one owner-signed NIP-43 command, followed by a roster re-read.
  expect(
    published.map(({ kind, pubkey, content, tags }) => ({
      kind,
      pubkey,
      content,
      tags,
    })),
  ).toEqual([
    {
      kind: 9030,
      pubkey: owner,
      content: "",
      tags: [
        ["p", added],
        ["role", "member"],
      ],
    },
    {
      kind: 9032,
      pubkey: owner,
      content: "",
      tags: [
        ["p", member],
        ["role", "admin"],
      ],
    },
    {
      kind: 9032,
      pubkey: owner,
      content: "",
      tags: [
        ["p", admin],
        ["role", "member"],
      ],
    },
    { kind: 9031, pubkey: owner, content: "", tags: [["p", added]] },
  ]);
  expect(read).toHaveBeenCalledTimes(5);
  expect(fetch).not.toHaveBeenCalled();
});

it("offers a native admin only member removal and surfaces the relay's refusal", async () => {
  const user = userEvent.setup();
  const refusal =
    "invalid: actor not authorized: admins can only remove members";
  const published = host(adminKey, () => ({
    status: 403,
    body: { error: refusal },
  }));
  const { relay: data } = relay(admin);
  render(<CommunityAdmin relay={data} active={() => true} />);
  await screen.findByRole("list", { name: "Members" });
  // Protected rows: the owner and the admin's own row are untouchable.
  expect(actions(owner)).toBeNull();
  expect(actions(admin)).toBeNull();
  await user.click(actions(member) as HTMLElement);
  expect(
    (await screen.findAllByRole("menuitem")).map((item) => item.textContent),
  ).toEqual(["Remove"]);
  await user.click(screen.getByRole("menuitem", { name: "Remove" }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Remove",
    }),
  );
  // Authority is the relay's: its exact refusal shows and nothing changes.
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(refusal),
  );
  expect(shownRole(member)).toBe("Member");
  expect(published.map((event) => event.kind)).toEqual([9031]);

  // An admin adds only plain members: no role choice is offered.
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("tab", { name: "Add directly" }));
  const dialog = screen.getByRole("region", { name: "Membership" });
  expect(
    within(dialog).queryByRole("button", { name: "Choose member role" }),
  ).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

// `applied` is whether the fake relay persisted the command despite the error.
it.each([
  [
    "a host transport failure",
    new Error("Relay unreachable"),
    "Relay unreachable",
    false,
  ],
  [
    "an unlisted relay refusal",
    { status: 500, body: { error: "database: connection reset" } },
    "Community request failed (500)",
    false,
  ],
  [
    // The relay applied it, but the receipt names another event.
    "an unconfirmed receipt",
    { body: { event_id: "0".repeat(64), accepted: true } },
    "Member change could not be confirmed",
    true,
  ],
])(
  "recovers from %s and refreshes to the relay's roster",
  async (_, failure, shown, applied) => {
    const user = userEvent.setup();
    let fail = true;
    const published = host(ownerKey, () => (fail ? failure : undefined));
    const { relay: data, read, emit } = relay(owner);
    render(<CommunityAdmin relay={data} active={() => true} />);
    await screen.findByRole("list", { name: "Members" });
    const promote = async () => {
      await user.click(actions(member) as HTMLElement);
      await user.click(
        await screen.findByRole("menuitem", { name: "Make admin" }),
      );
      await user.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", {
          name: "Make admin",
        }),
      );
    };
    await promote();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(shown),
    );
    // An unconfirmed write claims nothing: the list is not re-read or changed.
    expect(read).toHaveBeenCalledOnce();
    expect(shownRole(member)).toBe("Member");
    expect(roster.get(member)).toBe(applied ? "admin" : "member");
    fail = false;
    await user.keyboard("{Escape}");
    // Refresh shows whatever the relay actually holds.
    act(() => emit());
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(shownRole(member)).toBe(applied ? "Admin" : "Member"),
    );
    if (!applied) {
      // The controls stay usable; a retry goes through.
      await promote();
      await waitFor(() => expect(shownRole(member)).toBe("Admin"));
      expect(screen.queryByRole("alert")).toBeNull();
    }
    expect(published).toHaveLength(applied ? 1 : 2);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("still mints invite links natively", async () => {
  const user = userEvent.setup();
  const url = "https://primary.example/invite/native";
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "qr_code") return "<svg/>";
    expect(command).toBe("relay_http");
    expect(args).toEqual({
      community: "https://primary.example",
      path: "/api/invites",
      method: "POST",
      body: JSON.stringify({ ttl_secs: 3 * 24 * 60 * 60, max_uses: null }),
    });
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({ code: "native", url }),
    };
  });
  render(<CommunityAdmin relay={relay(admin).relay} active={() => true} />);
  await user.click(await screen.findByRole("tab", { name: "Invite" }));
  const dialog = screen.getByRole("region", { name: "Membership" });
  expect(await within(dialog).findByDisplayValue(url)).toBeVisible();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "relay_http"),
  ).toHaveLength(1);
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps the invite picker focused and the code in place while a new link is made", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const minted = new Map<string, () => void>();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "qr_code") return "<svg/>";
    expect(command).toBe("relay_http");
    const { max_uses } = JSON.parse((args as { body: string }).body) as {
      max_uses: number | null;
    };
    const code = max_uses ? "limited" : "open";
    const answer = {
      status: 200,
      headers: {},
      body: JSON.stringify({
        code,
        url: `https://primary.example/invite/${code}`,
      }),
    };
    if (code === "open") return answer;
    return new Promise((resolve) => minted.set(code, () => resolve(answer)));
  });
  render(<CommunityAdmin relay={relay(admin).relay} active={() => true} />);
  await user.click(await screen.findByRole("tab", { name: "Invite" }));
  const dialog = screen.getByRole("region", { name: "Membership" });
  await within(dialog).findByDisplayValue(
    "https://primary.example/invite/open",
  );
  // The code's place, which must never leave the layout: dropping it for a
  // render shrank the dialog and scrolled it back to the top.
  const slot = (
    await within(dialog).findByRole("img", {
      name: "Scan this QR code to open the invite link",
    })
  ).parentElement;
  const picker = within(dialog).getByRole("button", {
    name: "Choose maximum invite uses",
  });
  await user.click(picker);
  await user.click(await screen.findByRole("menuitemradio", { name: "1 use" }));
  await waitFor(() => expect(minted.has("limited")).toBe(true));
  // Both pickers stay usable while the new link is made, so the closing menu
  // returns focus to the one just used rather than losing it.
  expect(picker).toBeEnabled();
  expect(
    within(dialog).getByRole("button", { name: "Choose invite expiry" }),
  ).toBeEnabled();
  await waitFor(() => expect(picker).toHaveFocus());
  minted.get("limited")?.();
  await within(dialog).findByDisplayValue(
    "https://primary.example/invite/limited",
  );
  expect(
    await within(dialog).findByRole("img", {
      name: "Scan this QR code to open the invite link",
    }),
  ).toBeVisible();
  expect(slot).toBeInTheDocument();
  expect(picker).toHaveFocus();
});

it("draws theme-aware invite QR codes and rejects stale renderer answers", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const drawn = new Map<string, (svg: string) => void>();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "qr_code") {
      const { value } = args as { value: string };
      if (value.endsWith("/1-day")) throw "Couldn’t create the QR code.";
      return new Promise((resolve) => drawn.set(value, resolve));
    }
    expect(command).toBe("relay_http");
    const { ttl_secs, max_uses } = JSON.parse(
      (args as { body: string }).body,
    ) as { ttl_secs: number; max_uses: number | null };
    const code =
      ttl_secs === 24 * 60 * 60 ? "1-day" : max_uses ? "limited" : "open";
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({
        code,
        url: `https://primary.example/invite/${code}`,
      }),
    };
  });
  render(<CommunityAdmin relay={relay(admin).relay} active={() => true} />);
  await user.click(await screen.findByRole("tab", { name: "Invite" }));
  const dialog = screen.getByRole("region", { name: "Membership" });
  await within(dialog).findByDisplayValue(
    "https://primary.example/invite/open",
  );
  // No toggle: the host draws the code as soon as the link exists, light in
  // light mode.
  expect(within(dialog).queryByRole("button", { name: /QR code/ })).toBeNull();
  expect(invoke).toHaveBeenLastCalledWith("qr_code", {
    value: "https://primary.example/invite/open",
    variant: "light",
  });
  expect(within(dialog).queryByRole("img")).toBeNull();
  // A new link draws its own code; the old link's code, arriving late, never
  // replaces it.
  await user.click(
    within(dialog).getByRole("button", { name: "Choose maximum invite uses" }),
  );
  await user.click(await screen.findByRole("menuitemradio", { name: "1 use" }));
  await within(dialog).findByDisplayValue(
    "https://primary.example/invite/limited",
  );
  drawn.get("https://primary.example/invite/limited")?.("<svg>limited</svg>");
  const code = await within(dialog).findByRole("img", {
    name: "Scan this QR code to open the invite link",
  });
  const limited = `data:image/svg+xml,${encodeURIComponent("<svg>limited</svg>")}`;
  expect(code).toHaveAttribute("src", limited);
  drawn.get("https://primary.example/invite/open")?.("<svg>open</svg>");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(
    within(dialog).getByRole("img", {
      name: "Scan this QR code to open the invite link",
    }),
  ).toHaveAttribute("src", limited);
  // Back to no limit: a fresh /invite/open link waits for its own code and
  // never shows the limited link's.
  await user.click(
    within(dialog).getByRole("button", { name: "Choose maximum invite uses" }),
  );
  await user.click(
    await screen.findByRole("menuitemradio", { name: "No limit" }),
  );
  await within(dialog).findByDisplayValue(
    "https://primary.example/invite/open",
  );
  expect(within(dialog).queryByRole("img")).toBeNull();
  drawn.get("https://primary.example/invite/open")?.("<svg>open</svg>");
  expect(
    await within(dialog).findByRole("img", {
      name: "Scan this QR code to open the invite link",
    }),
  ).toHaveAttribute(
    "src",
    `data:image/svg+xml,${encodeURIComponent("<svg>open</svg>")}`,
  );
  act(() => {
    document.documentElement.dataset.colorMode = "dark";
  });
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith("qr_code", {
      value: "https://primary.example/invite/open",
      variant: "dark",
    }),
  );
  expect(within(dialog).queryByRole("img")).toBeNull();
  drawn.get("https://primary.example/invite/open")?.("<svg>dark</svg>");
  expect(
    await within(dialog).findByRole("img", {
      name: "Scan this QR code to open the invite link",
    }),
  ).toHaveAttribute(
    "src",
    `data:image/svg+xml,${encodeURIComponent("<svg>dark</svg>")}`,
  );
  // A renderer failure shows its error and no stale code.
  await user.click(
    within(dialog).getByRole("button", { name: "Choose invite expiry" }),
  );
  await user.click(await screen.findByRole("menuitemradio", { name: "1 day" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Couldn’t create the QR code.",
  );
  expect(
    within(dialog).getByRole("textbox", { name: "Community invite link" }),
  ).toHaveValue("https://primary.example/invite/1-day");
  expect(within(dialog).queryByRole("img")).toBeNull();
  // Neither the code nor its placeholder (both size-60) holds the space.
  expect(dialog.querySelector(".size-60")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it("draws the invite code in the color mode's variant and redraws it when the mode changes", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  document.documentElement.dataset.colorMode = "dark";
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "qr_code") {
      const { variant } = args as { variant: string };
      return `<svg>${variant}</svg>`;
    }
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({
        code: "open",
        url: "https://primary.example/invite/open",
      }),
    };
  });
  try {
    render(<CommunityAdmin relay={relay(admin).relay} active={() => true} />);
    await user.click(await screen.findByRole("tab", { name: "Invite" }));
    const dialog = await screen.findByRole("region", {
      name: "Membership",
    });
    const name = { name: "Scan this QR code to open the invite link" };
    const src = (variant: string) =>
      `data:image/svg+xml,${encodeURIComponent(`<svg>${variant}</svg>`)}`;
    expect(await within(dialog).findByRole("img", name)).toHaveAttribute(
      "src",
      src("dark"),
    );
    act(() => {
      document.documentElement.dataset.colorMode = "light";
    });
    await waitFor(() =>
      expect(within(dialog).getByRole("img", name)).toHaveAttribute(
        "src",
        src("light"),
      ),
    );
    expect(invoke).toHaveBeenLastCalledWith("qr_code", {
      value: "https://primary.example/invite/open",
      variant: "light",
    });
  } finally {
    delete document.documentElement.dataset.colorMode;
  }
});

it("shares the current invite on macOS and recovers when the native menu fails", async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      decode = async () => {};
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage() {},
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    "data:image/png;base64,cG5n",
  );
  let fail = true;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "qr_code") return "<svg/>";
    if (command === "share_image") {
      if (fail) throw new Error("unavailable");
      return;
    }
    expect(command).toBe("relay_http");
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({
        code: "share",
        url: "https://primary.example/invite/share",
      }),
    };
  });
  render(<CommunityAdmin relay={relay(admin).relay} active={() => true} />);
  await user.click(await screen.findByRole("tab", { name: "Invite" }));
  const share = await screen.findByRole("button", { name: "Share" });
  await waitFor(() => expect(share).toBeEnabled());
  await user.click(share);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not open sharing. Try again or copy the link.",
  );
  expect(screen.getByRole("button", { name: "Copy link" })).toBeEnabled();
  fail = false;
  await user.click(share);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(invoke).toHaveBeenCalledWith(
    "share_image",
    expect.objectContaining({
      url: "https://primary.example/invite/share",
      png: "cG5n",
    }),
  );
  expect(share).toBeEnabled();
});
