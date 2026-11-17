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
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { EventTemplate } from "nostr-tools";
import { App } from "./App";
import { createServices, type AppServices } from "./services";
import type { JoinPolicy } from "../features/communities/join-policy";
import type { RelayEvent } from "../features/relay/events";
import {
  keypair,
  nativeSignatureChecks,
  profile,
  signed,
} from "../features/relay/testing";

// A first run whose Builderlab account saved one community and whose landing
// named another: the real gate lifts on the restored community and the rail's
// Add-a-community dialog takes the typed address over. Setup outlasts the
// startup visit's 15 s deadline, as a real sign-in does; that deadline runs only
// once the gate lifts and a presenter exists, so the app opens without a notice.
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  isTauri: vi.fn(() => true),
  invoke: vi.fn(),
  Channel: class {
    id = 1;
    onmessage = () => {};
  },
}));
vi.mock("../bundled", async () => ({
  bundledPlugins: [
    {
      manifest: { id: "buzz.channels", name: "Channels", apiVersion: 1 },
      module: await import("../bundled/channels"),
    },
  ],
}));
// The NIP-FI sign-in, whose seeded account below never sends anywhere.
vi.mock("../bundled/builderlab/oauth/first-run", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../bundled/builderlab/oauth/first-run")
  >()),
  firstRunCredential: vi.fn(async () => ({
    revision: "private-token",
    account: {
      subject: "user",
      email: "a@example.com",
      canUseRemoteAgents: false,
    },
  })),
}));
// jsdom has no IndexedDB.
vi.mock("../features/relay/outbox-storage", () => ({
  browserOutboxStorage: () => ({ load: () => [], save: () => {} }),
}));

const member = keypair();
const relayA = "https://relay-a.example";
const relayB = "https://relay-b.example";
type Relay = {
  self: string;
  profile?: RelayEvent;
  /** Whether a signed read admits the key; an accepted claim admits it. */
  admitted: boolean;
  policy?: JoinPolicy;
  /** The relay's error code for every claim; unset, a claim admits the key. */
  refusal?: string;
  /** Holds kind-0 publishes until it settles. */
  holdPublish?: Promise<void>;
};
/** Both relays admit the key; only relay-a holds its profile. */
let relays: Record<string, Relay>;
/** Every `relay_http` request in order, its JSON body parsed (`null` for a GET). */
let requests: Array<{ community: string; path: string; body: unknown }>;
let services: AppServices | undefined;
beforeEach(() => {
  relays = {
    [relayA]: {
      self: keypair().pubkey,
      profile: profile(member, { name: "Ada", picture: "" }),
      admitted: true,
    },
    [relayB]: { self: keypair().pubkey, admitted: true },
  };
  requests = [];
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubEnv("VITE_BUZZ_LIVE", "0");
  // First run signs in to Builderlab only in an FI build.
  vi.stubEnv("VITE_BUZZ_FEDERATED_IDENTITY", "1");
  vi.stubEnv("VITE_BUZZ_OPEN_RELAY", "");
  vi.stubEnv(
    "VITE_BUZZ_FIRST_RUN_ACCOUNT",
    JSON.stringify({ known: ["relay-a.example"] }),
  );
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "WebSocket",
    class {
      close() {}
    },
  );
  vi.mocked(isTauri).mockReturnValue(true);
  let created = false;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "identity_restore") return created ? member.pubkey : null;
    if (command === "identity_legacy_available") return false;
    if (command === "identity_create") {
      created = true;
      return member.pubkey;
    }
    if (command === "get_os_idle_seconds") return 0;
    if (command === "deep_link_take") return [];
    if (command === "deep_link_watch") return null;
    if (command === "relay_sign")
      return signed(member, (args as { event: EventTemplate }).event);
    if (command === "relay_http") return relayAnswer(args);
    if (command === "relay_verify_signatures")
      return nativeSignatureChecks(args);
    if (command === "plugin_catalog")
      return {
        status: "ready",
        externalPluginsPaused: false,
        catalog: {
          profile: "fixture",
          location: "fixture",
          plugins: [
            {
              manifest: {
                id: "buzz.channels",
                name: "Channels",
                apiVersion: 1,
              },
              source: "bundled",
              revision: "bundled",
              enabled: true,
              previous: null,
              reloadable: false,
              error: null,
            },
          ],
        },
      };
    // Other native owners may initialize, but no actual native operations run.
    throw new Error(`Fixture native capability unavailable: ${command}`);
  });
});
afterEach(async () => {
  cleanup();
  await services?.dispose();
  services = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

/**
 * Each relay answers discovery, its join policy, invite acceptance and claims,
 * its kind-0 reads and a kind-0 publish; nothing else is held.
 */
function relayAnswer(args: unknown) {
  const request = args as {
    community: string;
    path: string;
    body: string | null;
  };
  const body: unknown = request.body === null ? null : JSON.parse(request.body);
  requests.push({ community: request.community, path: request.path, body });
  const answer = (status: number, value?: unknown) => ({
    status,
    headers: {},
    body: value === undefined ? "" : JSON.stringify(value),
  });
  const relay = relays[request.community];
  if (!relay) return answer(404);
  if (request.path === "/")
    return answer(200, {
      name: "Buzz Relay",
      self: relay.self,
      icon: "https://cdn.example.com/icon.png",
    });
  if (request.path === "/api/join-policy")
    return relay.policy ? answer(200, { policy: relay.policy }) : answer(404);
  if (request.path === "/api/invites/accept-policy")
    return answer(200, { receipt: "policy-receipt" });
  if (request.path === "/api/invites/claim") {
    if (relay.refusal) return answer(403, { error: relay.refusal });
    relay.admitted = true;
    return answer(200, { status: "joined" });
  }
  if (request.path === "/query") {
    if (!relay.admitted) return answer(403, { error: "membership required" });
    const filters = body as Array<{ kinds?: number[] }>;
    const reads = filters.some((filter) => filter.kinds?.includes(0));
    return answer(200, reads && relay.profile ? [relay.profile] : []);
  }
  if (request.path === "/events") {
    const event = body as RelayEvent;
    const accept = () => {
      if (event.kind === 0) relay.profile = event;
      return answer(200, { accepted: true, event_id: event.id });
    };
    return event.kind === 0 && relay.holdPublish
      ? relay.holdPublish.then(accept)
      : accept();
  }
  return answer(404);
}

const notice = () => screen.queryByText("This destination couldn’t open");
const joinDialog = () =>
  screen.queryByRole("dialog", { name: "Join a community" });
/** Landing address → Connect from the choice → setup runs on its own → the restore lifts the gate. */
async function firstRunWithAddress(
  user: ReturnType<typeof userEvent.setup>,
  address = "relay-b.example",
  code = "",
) {
  const current = createServices();
  services = current;
  render(<App services={current} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  await user.click(
    await screen.findByRole("button", { name: "Other options" }),
  );
  await user.type(
    await screen.findByRole("textbox", {
      name: "Community address or invite link",
    }),
    `${address}{Enter}`,
  );
  await user.click(
    await screen.findByRole("button", { name: "Sign in with Builderlab" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Join a community",
  });
  // Entered on the restored community with the typed address prefilled; the
  // startup visit presents normally beneath the dialog, no notice.
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  expect(notice()).toBeNull();
  expect(current.communities.snapshot()).toMatchObject({
    memberships: [{ id: relayA }],
    selected: relayA,
  });
  expect(within(dialog).getByLabelText("Community URL")).toHaveValue(relayB);
  // The dialog is a visit over the restored one; its code stays in memory.
  const visit = current.navigation.snapshot().entry.target;
  expect(visit.join).toEqual({
    viewer: member.pubkey,
    visit: expect.any(String),
    community: relayB,
  });
  expect(current.invites.state(visit, member.pubkey)?.code).toBe(code);
  if (code) {
    expect(JSON.stringify(visit)).not.toContain(code);
    expect(window.location.href).not.toContain(code);
    expect(
      Object.keys(sessionStorage).map((key) => sessionStorage.getItem(key)),
    ).not.toContainEqual(expect.stringContaining(code));
  }
  // First run itself sends nothing but unauthenticated lookups to relay-b.
  expect(
    requests.filter((r) => r.community === relayB).map((r) => r.path),
  ).toEqual(["/", "/api/join-policy"]);
  return { current, dialog };
}

it("hands a typed address the restore did not admit to the Add-a-community dialog, which joins and opens it", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const { current, dialog } = await firstRunWithAddress(user);
  await user.click(within(dialog).getByRole("button", { name: "Continue" }));
  await user.click(
    await within(dialog).findByRole("button", { name: "Continue" }),
  );
  // The profile starts from the local default the restore adopted.
  expect(
    await within(dialog).findByRole("textbox", { name: "Display name" }),
  ).toHaveValue("Ada");
  await user.click(
    within(dialog).getByRole("button", { name: "Publish profile & open" }),
  );
  await waitFor(() =>
    expect(current.communities.snapshot()).toMatchObject({
      memberships: [{ id: relayA }, { id: relayB }],
      selected: relayB,
    }),
  );
  expect(current.navigation.snapshot().entry.target.join).toBeUndefined();
  expect(joinDialog()).toBeNull();
  // Opening the joined community is a visit of its own, presented at once.
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  expect(notice()).toBeNull();
  expect(current.navigation.snapshot().entry.target).toMatchObject({
    kind: "page",
    pluginId: "buzz.channels",
    pageId: "channels",
  });
});

it("closing the handed-off dialog clears the intent and stays on the restored community", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const { current, dialog } = await firstRunWithAddress(user);
  await user.click(within(dialog).getByRole("button", { name: "Back" }));
  await waitFor(() => expect(joinDialog()).toBeNull());
  expect(current.navigation.snapshot().entry.target.join).toBeUndefined();
  expect(current.communities.snapshot()).toMatchObject({
    memberships: [{ id: relayA }],
    selected: relayA,
  });
  // The startup visit stays presented: the channels page, no notice to retry.
  expect(current.navigation.snapshot()).toMatchObject({
    status: "opened",
    entry: {
      target: { kind: "page", pluginId: "buzz.channels", pageId: "channels" },
    },
  });
  expect(notice()).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry navigation" })).toBeNull();
});

/** First run with its handed-off dialog closed: the restored community's page. */
async function onRestoredCommunity(user: ReturnType<typeof userEvent.setup>) {
  const { current, dialog } = await firstRunWithAddress(user);
  await user.click(within(dialog).getByRole("button", { name: "Back" }));
  await waitFor(() => expect(joinDialog()).toBeNull());
  return current;
}
const relayBRequests = () =>
  requests.filter((r) => r.community === relayB).length;
const profileStep = () =>
  screen.queryByRole("textbox", { name: "Display name" });

it("Back closes a join opened over a page and Forward restores its address without connecting again", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const current = await onRestoredCommunity(user);
  const page = current.navigation.snapshot().entry;
  act(() =>
    current.invites.open(
      { community: relayB, code: "", submitted: true },
      member.pubkey,
    ),
  );
  // Opened from the app, it connects at once: past the address, to access.
  const joining = await screen.findByRole("dialog", {
    name: "Join a community",
  });
  await waitFor(() =>
    expect(within(joining).getByText(relayB)).toBeInTheDocument(),
  );
  expect(within(joining).queryByLabelText("Community URL")).toBeNull();
  expect(current.navigation.snapshot().entry.id).not.toBe(page.id);
  const sent = relayBRequests();
  expect(sent).toBeGreaterThan(2);
  act(() => current.navigation.back());
  await waitFor(() => expect(joinDialog()).toBeNull());
  expect(current.navigation.snapshot().entry).toEqual(page);
  // The page beneath kept its visit: no new opening, no notice.
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  expect(notice()).toBeNull();
  act(() => current.navigation.forward());
  const restored = await screen.findByRole("dialog", {
    name: "Join a community",
  });
  expect(within(restored).getByLabelText("Community URL")).toHaveValue(relayB);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  // Restoring shows the address and waits for Continue: nothing is sent.
  expect(relayBRequests()).toBe(sent);
  expect(within(restored).getByLabelText("Community URL")).toHaveValue(relayB);
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
});

it("an explicitly closed join stays closed through Back and Forward", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const current = await onRestoredCommunity(user);
  const page = current.navigation.snapshot().entry;
  act(() =>
    current.invites.open({ community: relayB, code: "" }, member.pubkey),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Join a community",
  });
  await user.click(within(dialog).getByRole("button", { name: "Back" }));
  await waitFor(() => expect(joinDialog()).toBeNull());
  // Close returns to the visit beneath rather than adding one.
  expect(current.navigation.snapshot().entry).toEqual(page);
  expect(current.navigation.snapshot().canGoForward).toBe(false);
  act(() => current.navigation.forward());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(joinDialog()).toBeNull();
  expect(current.navigation.snapshot().entry.target.join).toBeUndefined();
});

it("a finished join retires its visits, so Back does not offer it again", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const current = await onRestoredCommunity(user);
  act(() =>
    current.invites.open(
      { community: relayB, code: "", submitted: true },
      member.pubkey,
    ),
  );
  const joining = await screen.findByRole("dialog", {
    name: "Join a community",
  });
  await waitFor(() =>
    expect(within(joining).getByText(relayB)).toBeInTheDocument(),
  );
  await user.click(within(joining).getByRole("button", { name: "Continue" }));
  await user.click(
    await screen.findByRole("button", { name: "Publish profile & open" }),
  );
  await waitFor(() =>
    expect(current.communities.snapshot()).toMatchObject({
      memberships: [{ id: relayA }, { id: relayB }],
      selected: relayB,
    }),
  );
  await waitFor(() => expect(profileStep()).toBeNull());
  act(() => current.navigation.back());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(joinDialog()).toBeNull();
  expect(profileStep()).toBeNull();
  expect(current.navigation.snapshot().entry.target.join).toBeUndefined();
});

it("Join a community from the picker is a visit: Back closes it and Forward reopens it with the typed address", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const current = await onRestoredCommunity(user);
  const page = current.navigation.snapshot().entry;
  await user.click(
    screen.getByRole("button", { name: /^Community switcher:/ }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Join a community" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Join a community",
  });
  expect(within(dialog).getByLabelText("Community URL")).toHaveValue("");
  expect(current.navigation.snapshot().entry.target).toEqual({
    ...page.target,
    join: { viewer: member.pubkey, visit: expect.any(String) },
  });
  await user.type(within(dialog).getByLabelText("Community URL"), relayB);
  act(() => current.navigation.back());
  await waitFor(() => expect(joinDialog()).toBeNull());
  expect(current.navigation.snapshot().entry).toEqual(page);
  act(() => current.navigation.forward());
  const restored = await screen.findByRole("dialog", {
    name: "Join a community",
  });
  // The running app keeps what was typed; nothing is sent for it.
  expect(within(restored).getByLabelText("Community URL")).toHaveValue(relayB);
  await user.click(within(restored).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(joinDialog()).toBeNull());
  expect(current.navigation.snapshot().entry).toEqual(page);
});

it("Back from a join opened over Settings returns to the same Settings section", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const current = await onRestoredCommunity(user);
  await act(async () => {
    void current.navigation.open({
      version: 1,
      kind: "settings",
      section: "appearance",
    });
  });
  await screen.findByRole("dialog", { name: "Settings" });
  const settings = current.navigation.snapshot().entry;
  act(() =>
    current.invites.open(
      { community: relayB, code: "", submitted: true },
      member.pubkey,
    ),
  );
  const joining = await screen.findByRole("dialog", {
    name: "Join a community",
  });
  await waitFor(() =>
    expect(within(joining).getByText(relayB)).toBeInTheDocument(),
  );
  expect(current.navigation.snapshot().entry.target).toEqual({
    ...settings.target,
    join: {
      viewer: member.pubkey,
      visit: expect.any(String),
      community: relayB,
    },
  });
  act(() => current.navigation.back());
  await waitFor(() => expect(joinDialog()).toBeNull());
  expect(current.navigation.snapshot().entry).toEqual(settings);
  expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
});

it("a join address arriving as navigation shows only to its viewer and never connects", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const current = await onRestoredCommunity(user);
  const page = current.navigation.snapshot().entry.target;
  const sent = relayBRequests();
  // As reload or a link restores it: the address alone, no code in memory.
  await act(async () => {
    void current.navigation.open({
      ...page,
      join: {
        viewer: keypair().pubkey,
        visit: "restored-1",
        community: relayB,
      },
    });
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(joinDialog()).toBeNull();
  await act(async () => {
    void current.navigation.open({
      ...page,
      join: { viewer: member.pubkey, visit: "restored-2", community: relayB },
    });
    await vi.advanceTimersByTimeAsync(2_000);
  });
  const restored = await screen.findByRole("dialog", {
    name: "Join a community",
  });
  expect(within(restored).getByLabelText("Community URL")).toHaveValue(relayB);
  expect(relayBRequests()).toBe(sent);
});

it("a join restored with the Settings beneath it opens above Settings", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const current = await onRestoredCommunity(user);
  // As reload restores it: Settings and its join arrive together.
  await act(async () => {
    void current.navigation.open({
      version: 1,
      kind: "settings",
      section: "appearance",
      join: { viewer: member.pubkey, visit: "restored-1", community: relayB },
    });
    await vi.advanceTimersByTimeAsync(2_000);
  });
  // The join is the reachable modal; Settings is open but hidden beneath it.
  const restored = await screen.findByRole("dialog", {
    name: "Join a community",
  });
  expect(within(restored).getByLabelText("Community URL")).toHaveValue(relayB);
  expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  expect(
    screen.getByRole("dialog", { name: "Settings", hidden: true }),
  ).toBeInTheDocument();
});

it("Back cannot leave a join while it publishes, as its Close cannot", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const current = await onRestoredCommunity(user);
  const page = current.navigation.snapshot().entry;
  let release = () => {};
  const held = relays[relayB];
  if (!held) throw new Error("Missing relay-b");
  held.holdPublish = new Promise((resolve) => {
    release = resolve;
  });
  act(() =>
    current.invites.open(
      { community: relayB, code: "", submitted: true },
      member.pubkey,
    ),
  );
  const joining = await screen.findByRole("dialog", {
    name: "Join a community",
  });
  await waitFor(() =>
    expect(within(joining).getByText(relayB)).toBeInTheDocument(),
  );
  await user.click(within(joining).getByRole("button", { name: "Continue" }));
  await user.click(
    await screen.findByRole("button", { name: "Publish profile & open" }),
  );
  await waitFor(() =>
    expect(
      requests.some((r) => r.community === relayB && r.path === "/events"),
    ).toBe(true),
  );
  const visit = current.navigation.snapshot().entry;
  expect(visit.target.join).toBeDefined();
  act(() => current.navigation.back());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(current.navigation.snapshot().entry).toEqual(visit);
  expect(profileStep()).not.toBeNull();
  release();
  await waitFor(() =>
    expect(current.communities.snapshot()).toMatchObject({
      memberships: [{ id: relayA }, { id: relayB }],
      selected: relayB,
    }),
  );
  await waitFor(() => expect(profileStep()).toBeNull());
  // Finished, Back is free again and does not reach the join.
  act(() => current.navigation.back());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(current.navigation.snapshot().entry.id).not.toBe(visit.id);
  expect(current.navigation.snapshot().entry.target.join).toBeUndefined();
  expect(page.target.join).toBeUndefined();
});

const code = "b-Invite_2.x";
const policy: JoinPolicy = {
  version: "2026-10",
  age_attestation_required: true,
  terms_markdown: "# Terms",
};
const httpsInvite = `${relayB}/invite/${code}`;
const appInvite = `buzz://join?relay=${encodeURIComponent("wss://relay-b.example")}&code=${code}`;
const inviteRequests = () =>
  requests.filter(
    (r) => r.community === relayB && r.path.startsWith("/api/invites/"),
  );
/** Continue past the prefilled address to the access step, which holds the code. */
async function accessStep(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
) {
  await user.click(within(dialog).getByRole("button", { name: "Continue" }));
  const field = await within(dialog).findByLabelText("Invite code");
  expect(field).toHaveValue(code);
  // Nothing is claimed until the user continues from this step.
  expect(inviteRequests()).toEqual([]);
}

it.each([
  { form: "relay invite page", address: httpsInvite, published: policy },
  { form: "buzz://join link", address: appInvite, published: undefined },
])(
  "hands a $form's code to the dialog, which claims it and joins",
  async ({ address, published }) => {
    relays[relayB] = {
      self: keypair().pubkey,
      admitted: false,
      ...(published ? { policy: published } : {}),
    };
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { current, dialog } = await firstRunWithAddress(user, address, code);
    await accessStep(user, dialog);
    if (published) {
      await user.click(
        within(dialog).getByRole("checkbox", {
          name: "I agree to this community’s Terms of Service.",
        }),
      );
      await user.click(
        within(dialog).getByRole("checkbox", {
          name: "I confirm that I am at least 18 years old.",
        }),
      );
    }
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(
      await within(dialog).findByRole("textbox", { name: "Display name" }),
    ).toHaveValue("Ada");
    expect(inviteRequests()).toEqual([
      ...(published
        ? [
            {
              community: relayB,
              path: "/api/invites/accept-policy",
              body: {
                code,
                policy_version: published.version,
                age_confirmed: true,
              },
            },
          ]
        : []),
      {
        community: relayB,
        path: "/api/invites/claim",
        body: published ? { code, policy_receipt: "policy-receipt" } : { code },
      },
    ]);
    await user.click(
      within(dialog).getByRole("button", { name: "Publish profile & open" }),
    );
    await waitFor(() =>
      expect(current.communities.snapshot()).toMatchObject({
        memberships: [{ id: relayA }, { id: relayB }],
        selected: relayB,
      }),
    );
    expect(current.navigation.snapshot().entry.target.join).toBeUndefined();
    expect(joinDialog()).toBeNull();
  },
);

it("a refused handed-off code keeps the dialog open with the refusal and stays on the restored community", async () => {
  relays[relayB] = {
    self: keypair().pubkey,
    admitted: false,
    refusal: "invite_expired",
  };
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const { current, dialog } = await firstRunWithAddress(
    user,
    httpsInvite,
    code,
  );
  await accessStep(user, dialog);
  await user.click(within(dialog).getByRole("button", { name: "Continue" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "This invite code has expired — ask for a new one.",
  );
  expect(inviteRequests()).toEqual([
    { community: relayB, path: "/api/invites/claim", body: { code } },
  ]);
  // The refusal ends the attempt: no read follows the claim.
  expect(requests.filter((r) => r.community === relayB).at(-1)?.path).toBe(
    "/api/invites/claim",
  );
  expect(joinDialog()).toBe(dialog);
  expect(within(dialog).getByLabelText("Invite code")).toHaveValue(code);
  expect(current.communities.snapshot()).toMatchObject({
    memberships: [{ id: relayA }],
    selected: relayA,
  });
});

/** Open a join from the app with a code and wait for its dialog. */
async function openCoded(current: AppServices, invite: string) {
  act(() =>
    current.invites.open({ community: relayB, code: invite }, member.pubkey),
  );
  await waitFor(() =>
    expect(
      current.invites.state(
        current.navigation.snapshot().entry.target,
        member.pubkey,
      )?.code,
    ).toBe(invite),
  );
  return screen.findByRole("dialog", { name: "Join a community" });
}
async function codeAtAccess(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
) {
  await user.click(within(dialog).getByRole("button", { name: "Continue" }));
  return (await within(dialog).findByLabelText("Invite code")).getAttribute(
    "value",
  );
}

it("an invite's code stays with its dialog through Back and Forward in the running app", async () => {
  relays[relayB] = { self: keypair().pubkey, admitted: false };
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const current = await onRestoredCommunity(user);
  const page = current.navigation.snapshot().entry;
  const dialog = await openCoded(current, code);
  expect(within(dialog).getByLabelText("Community URL")).toHaveValue(relayB);
  act(() => current.navigation.back());
  await waitFor(() => expect(joinDialog()).toBeNull());
  expect(current.navigation.snapshot().entry).toEqual(page);
  act(() => current.navigation.forward());
  const restored = await screen.findByRole("dialog", {
    name: "Join a community",
  });
  expect(await codeAtAccess(user, restored)).toBe(code);
  expect(inviteRequests()).toEqual([]);
});

it("two invites to one community each keep their own code", async () => {
  relays[relayB] = { self: keypair().pubkey, admitted: false };
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const current = await onRestoredCommunity(user);
  const first = "first-Invite_1.x";
  const second = "second-Invite_2.x";
  await openCoded(current, first);
  const firstVisit = current.navigation.snapshot().entry;
  await openCoded(current, second);
  expect(current.navigation.snapshot().entry.id).not.toBe(firstVisit.id);
  act(() => current.navigation.back());
  await waitFor(() =>
    expect(current.navigation.snapshot().entry).toEqual(firstVisit),
  );
  expect(
    await codeAtAccess(
      user,
      await screen.findByRole("dialog", { name: "Join a community" }),
    ),
  ).toBe(first);
  act(() => current.navigation.forward());
  await waitFor(() =>
    expect(current.navigation.snapshot().entry.id).not.toBe(firstVisit.id),
  );
  expect(
    await codeAtAccess(
      user,
      await screen.findByRole("dialog", { name: "Join a community" }),
    ),
  ).toBe(second);
});

it("joining a community by its typed address retires an earlier opening for it", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const current = await onRestoredCommunity(user);
  act(() =>
    current.invites.open({ community: relayB, code: "" }, member.pubkey),
  );
  await screen.findByRole("dialog", { name: "Join a community" });
  const earlier = current.navigation.snapshot().entry;
  act(() => current.invites.start(member.pubkey));
  await waitFor(() =>
    expect(current.navigation.snapshot().entry.id).not.toBe(earlier.id),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Join a community",
  });
  const field = within(dialog).getByLabelText("Community URL");
  expect(field).toHaveValue("");
  await user.type(field, relayB);
  await user.click(within(dialog).getByRole("button", { name: "Continue" }));
  await user.click(
    await within(dialog).findByRole("button", { name: "Continue" }),
  );
  await user.click(
    await within(dialog).findByRole("button", {
      name: "Publish profile & open",
    }),
  );
  await waitFor(() =>
    expect(current.communities.snapshot()).toMatchObject({
      memberships: [{ id: relayA }, { id: relayB }],
      selected: relayB,
    }),
  );
  await waitFor(() => expect(profileStep()).toBeNull());
  act(() => current.navigation.back());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(joinDialog()).toBeNull();
  expect(current.navigation.snapshot().entry.id).not.toBe(earlier.id);
  expect(current.navigation.snapshot().entry.target.join).toBeUndefined();
});

it("closing Settings after Back from its join leaves no join to Forward to", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const current = await onRestoredCommunity(user);
  await act(async () => {
    void current.navigation.open({
      version: 1,
      kind: "settings",
      section: "appearance",
    });
  });
  await screen.findByRole("dialog", { name: "Settings" });
  const opening = await openCoded(current, code);
  expect(opening).toBeVisible();
  const joining = current.navigation.snapshot().entry.target;
  act(() => current.navigation.back());
  await waitFor(() => expect(joinDialog()).toBeNull());
  const settings = screen.getByRole("dialog", { name: "Settings" });
  await user.click(
    within(settings).getByRole("button", { name: "Close Settings" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull(),
  );
  expect(current.navigation.snapshot().canGoForward).toBe(false);
  // The retired opening's code is released with its visit.
  expect(current.invites.state(joining, member.pubkey)).toBeUndefined();
  act(() => current.navigation.forward());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(joinDialog()).toBeNull();
  expect(current.navigation.snapshot().entry.target.join).toBeUndefined();
});

it("a new visit after Back from a join releases that join's code", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const current = await onRestoredCommunity(user);
  await openCoded(current, code);
  const joining = current.navigation.snapshot().entry.target;
  act(() => current.navigation.back());
  await waitFor(() => expect(joinDialog()).toBeNull());
  // Back alone keeps it for Forward.
  expect(current.invites.state(joining, member.pubkey)?.code).toBe(code);
  await act(async () => {
    void current.navigation.open({
      version: 1,
      kind: "settings",
      section: "appearance",
    });
  });
  expect(current.navigation.snapshot().canGoForward).toBe(false);
  expect(current.invites.state(joining, member.pubkey)).toBeUndefined();
});

/** Back, then Forward, to the same join opening. */
async function backAndForward(current: AppServices) {
  const shown = current.navigation.snapshot().entry;
  act(() => current.navigation.back());
  await waitFor(() => expect(joinDialog()).toBeNull());
  act(() => current.navigation.forward());
  await waitFor(() =>
    expect(current.navigation.snapshot().entry.id).toBe(shown.id),
  );
  return screen.findByRole("dialog", { name: "Join a community" });
}

it("an invite whose address was edited restores without its code", async () => {
  relays[relayB] = { self: keypair().pubkey, admitted: false };
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const current = await onRestoredCommunity(user);
  const dialog = await openCoded(current, code);
  const field = within(dialog).getByLabelText("Community URL");
  // The same community, spelled another way: the code no longer applies.
  await user.clear(field);
  await user.type(field, "wss://relay-b.example");
  const restored = await backAndForward(current);
  expect(within(restored).getByLabelText("Community URL")).toHaveValue(
    "wss://relay-b.example",
  );
  await user.click(within(restored).getByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(within(restored).queryByLabelText("Community URL")).toBeNull(),
  );
  // The access step offers no code, and admission sends none.
  expect(within(restored).queryByLabelText("Invite code")).toBeNull();
  await user.click(within(restored).getByRole("button", { name: "Continue" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(JSON.stringify(requests)).not.toContain(code);
});

it("an edited invite code restores as edited", async () => {
  relays[relayB] = { self: keypair().pubkey, admitted: false };
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const current = await onRestoredCommunity(user);
  const dialog = await openCoded(current, code);
  await user.click(within(dialog).getByRole("button", { name: "Continue" }));
  const field = await within(dialog).findByLabelText("Invite code");
  await user.clear(field);
  await user.type(field, "edited-Invite_9.x");
  const restored = await backAndForward(current);
  expect(await codeAtAccess(user, restored)).toBe("edited-Invite_9.x");
  expect(inviteRequests()).toEqual([]);
});

it.each([
  ["edited", "replacement-Invite_3.x"],
  ["cleared", ""],
])(
  "a pasted invite link's code restores as %s, not as the link's",
  async (_, edited) => {
    relays[relayB] = { self: keypair().pubkey, admitted: false };
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const current = await onRestoredCommunity(user);
    act(() => current.invites.start(member.pubkey));
    const dialog = await screen.findByRole("dialog", {
      name: "Join a community",
    });
    await user.click(within(dialog).getByLabelText("Community URL"));
    await user.paste(`${relayB}/invite/${code}`);
    expect(await codeAtAccess(user, dialog)).toBe(code);
    const field = within(dialog).getByLabelText("Invite code");
    await user.clear(field);
    if (edited) await user.type(field, edited);
    const restored = await backAndForward(current);
    // The link's code moved to Invite code; the address is the community's.
    expect(within(restored).getByLabelText("Community URL")).toHaveValue(
      relayB,
    );
    if (edited) expect(await codeAtAccess(user, restored)).toBe(edited);
    else {
      await user.click(
        within(restored).getByRole("button", { name: "Continue" }),
      );
      await waitFor(() =>
        expect(within(restored).queryByLabelText("Community URL")).toBeNull(),
      );
      await user.click(
        within(restored).getByRole("button", { name: "Continue" }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }
    expect(JSON.stringify(requests)).not.toContain(code);
  },
);

it("a profile edited before publishing is restored for the same community", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const current = await onRestoredCommunity(user);
  act(() =>
    current.invites.open({ community: relayB, code: "" }, member.pubkey),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Join a community",
  });
  await user.click(within(dialog).getByRole("button", { name: "Continue" }));
  await user.click(
    await within(dialog).findByRole("button", { name: "Continue" }),
  );
  const name = await within(dialog).findByRole("textbox", {
    name: "Display name",
  });
  await user.clear(name);
  await user.type(name, "Grace");
  const restored = await backAndForward(current);
  // Restoring waits for Continue; the edited profile returns at its step.
  expect(within(restored).getByLabelText("Community URL")).toHaveValue(relayB);
  // Admission already happened, so Continue goes straight to the profile.
  await user.click(within(restored).getByRole("button", { name: "Continue" }));
  expect(
    await within(restored).findByRole("textbox", { name: "Display name" }),
  ).toHaveValue("Grace");
});

it("an emptied address keeps its dialog through re-renders, Back and Forward", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const current = await onRestoredCommunity(user);
  act(() =>
    current.invites.open({ community: relayB, code: "" }, member.pubkey),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Join a community",
  });
  await user.clear(within(dialog).getByLabelText("Community URL"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(joinDialog()).toBe(dialog);
  const restored = await backAndForward(current);
  expect(within(restored).getByLabelText("Community URL")).toHaveValue("");
});

it("finishing a join leaves an older opening edited to another community", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const current = await onRestoredCommunity(user);
  act(() =>
    current.invites.open({ community: relayB, code: "" }, member.pubkey),
  );
  const older = await screen.findByRole("dialog", {
    name: "Join a community",
  });
  const olderVisit = current.navigation.snapshot().entry;
  const field = within(older).getByLabelText("Community URL");
  await user.clear(field);
  await user.type(field, "https://relay-c.example");
  act(() => current.invites.start(member.pubkey));
  await waitFor(() =>
    expect(current.navigation.snapshot().entry.id).not.toBe(olderVisit.id),
  );
  await waitFor(() => expect(joinDialog()).not.toBe(older));
  const dialog = await screen.findByRole("dialog", {
    name: "Join a community",
  });
  await user.type(within(dialog).getByLabelText("Community URL"), relayB);
  await user.click(within(dialog).getByRole("button", { name: "Continue" }));
  await user.click(
    await within(dialog).findByRole("button", { name: "Continue" }),
  );
  await user.click(
    await within(dialog).findByRole("button", {
      name: "Publish profile & open",
    }),
  );
  await waitFor(() =>
    expect(current.communities.snapshot()).toMatchObject({
      memberships: [{ id: relayA }, { id: relayB }],
      selected: relayB,
    }),
  );
  await waitFor(() => expect(profileStep()).toBeNull());
  // The older opening now offers relay-c, not the community just joined.
  act(() => current.navigation.back());
  await waitFor(() =>
    expect(current.navigation.snapshot().entry.id).toBe(olderVisit.id),
  );
  expect(
    within(
      await screen.findByRole("dialog", { name: "Join a community" }),
    ).getByLabelText("Community URL"),
  ).toHaveValue("https://relay-c.example");
});
