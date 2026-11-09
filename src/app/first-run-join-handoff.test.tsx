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
    if (event.kind === 0) relay.profile = event;
    return answer(200, { accepted: true, event_id: event.id });
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
  expect(current.invites.snapshot()).toMatchObject({
    community: relayB,
    code,
    viewer: member.pubkey,
  });
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
  expect(current.invites.snapshot()).toBeUndefined();
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
  expect(current.invites.snapshot()).toBeUndefined();
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
    expect(current.invites.snapshot()).toBeUndefined();
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
