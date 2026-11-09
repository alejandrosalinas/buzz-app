// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Context } from "@deepseek-ai/cordis";
import { invoke } from "@tauri-apps/api/core";
import type { EventTemplate } from "nostr-tools";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommunityDialog } from "./CommunityDialog";
import { createCommunities } from "./service";
import { createJoinJournal } from "./join-journal";
import { connectNativeTransport } from "../relay/native";
import { keypair, nativeSignatureChecks, signed } from "../relay/testing";
import type { RelayEvent } from "../relay/events";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
const viewer = keypair(),
  relay = keypair();
const community = "https://native-join.test";
let requestedCommunity = community;
const roots: Context[] = [];
const calls: Array<{ path: string; body: unknown }> = [];
let admitted: boolean;
let profile: RelayEvent | undefined;
let claim: () => Promise<void>;
let publish: () => Promise<void>;
let readProfile: () => Promise<void>;
let query: () => Promise<void>;
const journal = () => createJoinJournal(viewer.pubkey);
beforeEach(() => {
  localStorage.clear();
  admitted = false;
  profile = undefined;
  calls.length = 0;
  requestedCommunity = community;
  claim = async () => {};
  publish = async () => {};
  readProfile = async () => {};
  query = async () => {};
  vi.stubEnv("VITE_BUZZ_LIVE", "0");
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubGlobal(
    "WebSocket",
    class {
      close() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No development broker");
    }),
  );
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "get_os_idle_seconds") return 0;
    if (command === "identity_restore") return viewer.pubkey;
    if (command === "relay_verify_signatures")
      return nativeSignatureChecks(args);
    if (command === "relay_sign")
      return signed(viewer, (args as { event: EventTemplate }).event);
    if (command !== "relay_http")
      throw new Error(`Unexpected command ${command}`);
    const request = args as {
      community: string;
      path: string;
      body: string | null;
    };
    expect(request.community).toBe(requestedCommunity);
    const body = request.body ? JSON.parse(request.body) : undefined;
    calls.push({ path: request.path, body });
    const response = (value: unknown, status = 200) => ({
      status,
      headers: {},
      body: JSON.stringify(value),
    });
    switch (request.path) {
      case "/":
        return response({
          self: relay.pubkey,
          pubkey: viewer.pubkey,
          name: "Native community",
          supported_nips: [1, 42, 43],
        });
      case "/api/join-policy":
        return response({
          policy: {
            version: "v1",
            terms_markdown: "Terms",
            privacy_markdown: null,
            age_attestation_required: true,
          },
        });
      case "/api/invites/accept-policy":
        return response({ receipt: "fixture-receipt" });
      case "/api/invites/claim":
        expect(journal().get(community)).toBeDefined();
        admitted = true;
        await claim();
        return response({ status: "joined" });
      case "/query":
        await query();
        if (!admitted) return response({ error: "membership required" }, 403);
        if (
          body.some((filter: { kinds?: number[] }) => filter.kinds?.includes(0))
        ) {
          expect(body).toContainEqual(
            expect.objectContaining({ consistency: "strong" }),
          );
          await readProfile();
        }
        return response(
          body.some((filter: { kinds?: number[] }) =>
            filter.kinds?.includes(0),
          ) && profile
            ? [profile]
            : [],
        );
      case "/events":
        expect(journal().get(community)?.profile).toBeDefined();
        if (
          !profile ||
          body.created_at > profile.created_at ||
          (body.created_at === profile.created_at && body.id < profile.id)
        )
          profile = body;
        await publish();
        return response({ accepted: true, event_id: body.id });
      default:
        throw new Error(`Unexpected path ${request.path}`);
    }
  });
});
afterEach(async () => {
  vi.useRealTimers();
  cleanup();
  for (const root of roots.splice(0)) await root.fiber.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function open(invite?: { community: string; code: string }) {
  const ctx = new Context();
  roots.push(ctx);
  const communities = createCommunities(
    ctx,
    false,
    undefined,
    "",
    undefined,
    Promise.resolve(viewer.pubkey),
    connectNativeTransport,
  );
  await waitFor(() => expect(communities.snapshot().status).toBe("ready"));
  const close = vi.fn();
  const view = render(
    <CommunityDialog
      communities={communities}
      mode="join"
      close={close}
      invite={invite}
    />,
  );
  return {
    communities,
    close,
    async stop() {
      view.unmount();
      await ctx.fiber.dispose();
    },
  };
}
async function start(user: ReturnType<typeof userEvent.setup>) {
  await user.clear(screen.getByLabelText("Community URL"));
  await user.type(screen.getByLabelText("Community URL"), community);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.type(await screen.findByLabelText("Invite code"), "v2.fixture");
  await user.click(screen.getByRole("checkbox", { name: /I agree/ }));
  await user.click(screen.getByRole("checkbox", { name: /at least 18/ }));
}
/** A claim or publish in flight can't be abandoned: Back, Close and Escape wait. */
async function expectWriteLocked(
  user: ReturnType<typeof userEvent.setup>,
  close: () => void,
  action: string,
) {
  expect(screen.getByRole("button", { name: action })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  await user.keyboard("{Escape}");
  expect(close).not.toHaveBeenCalled();
}

it("resumes after an uncertain claim, saves the profile, and restores only the selected native session", async () => {
  const user = userEvent.setup();
  claim = async () => {
    throw new Error("Claim receipt lost");
  };
  const first = await open();
  await start(user);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Claim receipt lost",
  );
  expect(first.communities.snapshot().memberships).toEqual([]);
  const saved = localStorage.getItem(
    `buzz-community-joins.v1:${viewer.pubkey}`,
  );
  expect(saved).toContain(community);
  expect(saved).not.toMatch(/v2.fixture|fixture-receipt/);
  await first.stop();
  const second = await open();
  expect(screen.getByLabelText("Community URL")).toHaveValue(community);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.type(
    await screen.findByLabelText("Display name"),
    "Recovered identity",
  );
  await user.click(
    screen.getByRole("button", { name: "Publish profile & open" }),
  );
  await waitFor(() => expect(second.close).toHaveBeenCalledOnce());
  expect(second.communities.snapshot().selected).toBe(community);
  expect(journal().latest()).toBeUndefined();
  expect(
    calls.filter((call) => call.path === "/api/invites/claim"),
  ).toHaveLength(1);
  expect(
    calls.find((call) => call.path === "/api/invites/claim")?.body,
  ).toEqual({ code: "v2.fixture", policy_receipt: "fixture-receipt" });
  expect(calls.filter((call) => call.path === "/events")).toHaveLength(1);
  await second.stop();
  calls.length = 0;
  const stored = JSON.parse(
    localStorage.getItem(`buzz-client.v1:${viewer.pubkey}`) ?? "null",
  );
  // The completed join queued its upload in the same device record.
  expect(stored.sync).toEqual({
    known: [],
    outbox: [{ url: "wss://native-join.test", removed: false }],
  });
  stored.memberships.push({ id: "https://unopened.test", name: "Unopened" });
  localStorage.setItem(
    `buzz-client.v1:${viewer.pubkey}`,
    JSON.stringify(stored),
  );
  const third = await open();
  await waitFor(() =>
    expect(third.communities.relay.snapshot().status).toBe("ready"),
  );
  expect(third.communities.relay.snapshot().viewer).toBe(viewer.pubkey);
  expect(third.communities.relay.snapshot().scope).toBe(
    `${community}:${viewer.pubkey}`,
  );
  expect(third.communities.snapshot().memberships).toHaveLength(2);
  expect(fetch).not.toHaveBeenCalled();
});

it("retains submitted profile progress through publication and local membership-save failures", async () => {
  admitted = true;
  journal().begin(community);
  const user = userEvent.setup();
  const first = await open();
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.type(
    await screen.findByLabelText("Display name"),
    "Durable draft",
  );
  publish = async () => {
    throw new Error("Profile receipt lost");
  };
  await user.click(
    screen.getByRole("button", { name: "Publish profile & open" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Profile receipt lost",
  );
  await first.stop();
  const second = await open();
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByLabelText("Display name")).toHaveValue(
    "Durable draft",
  );
  const setItem = Storage.prototype.setItem;
  const writes = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith("buzz-client.v1:")) throw new Error("Full disk");
      setItem.call(this, key, value);
    });
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not save this community",
  );
  expect(second.close).not.toHaveBeenCalled();
  expect(second.communities.snapshot().memberships).toEqual([]);
  expect(journal().get(community)?.profile?.name).toBe("Durable draft");
  writes.mockRestore();
  await second.stop();
  const third = await open();
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByLabelText("Display name");
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  await waitFor(() => expect(third.close).toHaveBeenCalledOnce());
  expect(calls.filter((call) => call.path === "/events")).toHaveLength(1);
  expect(calls.some((call) => call.path === "/api/invites/claim")).toBe(false);
});

it.each(["superseded", "missing"])(
  "retains the draft across restart when an acknowledged profile is %s, then completes on verified retry",
  async (result) => {
    admitted = true;
    const future = Math.floor(Date.now() / 1000) + 60;
    profile = signed(viewer, {
      kind: 0,
      created_at: future,
      tags: [],
      content: JSON.stringify({
        name: "Existing",
        about: "Before",
        custom: "Preserved",
      }),
    });
    const draft = {
      name: "Requested",
      picture: "https://images.test/avatar.png",
      about: "After",
    };
    journal().begin(community, draft);
    if (result === "missing")
      publish = async () => {
        profile = undefined;
      };
    const user = userEvent.setup();
    const first = await open();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(
      await screen.findByRole("button", { name: "Publish profile & open" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your profile change is not current",
    );
    expect(first.close).not.toHaveBeenCalled();
    expect(first.communities.snapshot().memberships).toEqual([]);
    expect(first.communities.snapshot().profile.name).toBe("");
    expect(journal().get(community)?.profile).toEqual(draft);
    expect(calls.filter((call) => call.path === "/events")).toHaveLength(1);
    if (result === "superseded")
      expect(JSON.parse(profile?.content ?? "null").name).toBe("Existing");
    await first.stop();

    publish = async () => {};
    vi.spyOn(Date, "now").mockReturnValue((future + 1) * 1000);
    const second = await open();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByLabelText("Display name")).toHaveValue(
      draft.name,
    );
    expect(screen.getByLabelText("Profile description (optional)")).toHaveValue(
      draft.about,
    );
    await user.click(
      screen.getByRole("button", { name: "Publish profile & open" }),
    );
    await waitFor(() => expect(second.close).toHaveBeenCalledOnce());
    expect(second.communities.snapshot().selected).toBe(community);
    expect(journal().latest()).toBeUndefined();
    expect(JSON.parse(profile?.content ?? "null")).toMatchObject(draft);
    if (result === "superseded")
      expect(JSON.parse(profile?.content ?? "null").custom).toBe("Preserved");
    expect(calls.filter((call) => call.path === "/events")).toHaveLength(2);
    expect(calls.some((call) => call.path === "/api/invites/claim")).toBe(
      false,
    );
  },
);

it.each(["before", "after"])(
  "retains the submitted draft when profile reads fail %s publication and recovers without duplicate writes",
  async (when) => {
    admitted = true;
    const draft = {
      name: "  Durable draft  ",
      picture: "",
      about: "  Keep this  ",
    };
    journal().begin(community, draft);
    const user = userEvent.setup();
    const first = await open();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByLabelText("Display name");
    const failRead = async () => {
      throw new Error("Profile read unavailable");
    };
    if (when === "before") readProfile = failRead;
    else
      publish = async () => {
        readProfile = failRead;
      };
    await user.click(
      screen.getByRole("button", { name: "Publish profile & open" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Profile read unavailable",
    );
    expect(first.close).not.toHaveBeenCalled();
    expect(first.communities.snapshot().memberships).toEqual([]);
    expect(journal().get(community)?.profile).toEqual(draft);
    expect(calls.filter((call) => call.path === "/events")).toHaveLength(
      when === "before" ? 0 : 1,
    );
    await first.stop();

    readProfile = async () => {};
    publish = async () => {};
    const second = await open();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByLabelText("Display name")).toHaveValue(
      draft.name,
    );
    await user.click(
      screen.getByRole("button", {
        name: "Publish profile & open",
      }),
    );
    await waitFor(() => expect(second.close).toHaveBeenCalledOnce());
    expect(journal().latest()).toBeUndefined();
    expect(calls.filter((call) => call.path === "/events")).toHaveLength(1);
    expect(calls.some((call) => call.path === "/api/invites/claim")).toBe(
      false,
    );
  },
);

it("verifies the normalized published fields before completing setup", async () => {
  admitted = true;
  journal().begin(community, {
    name: "  Name  ",
    picture: "",
    about: "  About  ",
  });
  const user = userEvent.setup();
  const app = await open();
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(
    await screen.findByRole("button", { name: "Publish profile & open" }),
  );
  await waitFor(() => expect(app.close).toHaveBeenCalledOnce());
  expect(app.communities.snapshot().profile).toEqual({
    name: "Name",
    picture: "",
    about: "About",
  });
  expect(journal().latest()).toBeUndefined();
});

it.each(["current", "unmounted", "replaced"])(
  "waits for profile verification and only completes the current transaction (%s)",
  async (state) => {
    admitted = true;
    journal().begin(community, { name: "Submitted", picture: "" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const confirm = vi.fn(() => gate);
    publish = async () => {
      readProfile = confirm;
    };
    const user = userEvent.setup();
    const app = await open();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(
      await screen.findByRole("button", { name: "Publish profile & open" }),
    );
    try {
      await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
      await expectWriteLocked(user, app.close, "Publishing…");
      expect(app.communities.snapshot().memberships).toEqual([]);
      expect(journal().get(community)?.profile?.name).toBe("Submitted");
      if (state === "unmounted") await app.stop();
      if (state === "replaced")
        journal().begin(community, { name: "New draft", picture: "" });
      await act(async () => release());
      if (state === "current") {
        await waitFor(() => expect(app.close).toHaveBeenCalledOnce());
        expect(journal().latest()).toBeUndefined();
      } else {
        expect(app.close).not.toHaveBeenCalled();
        expect(app.communities.snapshot().memberships).toEqual([]);
        expect(journal().get(community)?.profile?.name).toBe(
          state === "replaced" ? "New draft" : "Submitted",
        );
      }
    } finally {
      release();
    }
  },
);

it("does not dispatch admission when its recovery record cannot be persisted", async () => {
  const user = userEvent.setup();
  await open();
  await start(user);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Full disk");
  });
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not save community setup",
  );
  expect(calls.some((call) => call.path.startsWith("/api/invites/"))).toBe(
    false,
  );
});

it("restores a configured alias as a usable relay URL", async () => {
  journal().begin("primary");
  await open();
  expect(screen.getByLabelText("Community URL")).toHaveValue(
    "https://primary.example",
  );
});

it("retains pending admission during network failure without redeeming the invite again", async () => {
  journal().begin(community);
  // Fail the membership read, not unrelated native startup work.
  query = async () => {
    throw new Error("Relay offline");
  };
  const user = userEvent.setup();
  await open();
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Relay offline");
  expect(journal().get(community)).toBeDefined();
  expect(calls.some((call) => call.path === "/api/invites/claim")).toBe(false);
  admitted = true;
  query = async () => {};
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByLabelText("Display name");
  expect(calls.some((call) => call.path === "/api/invites/claim")).toBe(false);
});

it("names a relay it couldn't reach while resuming an interrupted join", async () => {
  admitted = true;
  journal().begin(community);
  readProfile = () => Promise.reject("Relay request could not be confirmed");
  await open();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // user-event and waitFor drain through a timer that fake timers would hold.
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  // The profile read retries on backoff timers within its 12 s budget.
  await act(() => vi.advanceTimersByTimeAsync(12_000));
  expect(screen.getByLabelText("Community URL")).toHaveAccessibleDescription(
    "Couldn’t reach native-join.test. Check the address, or try again.",
  );
  expect(journal().get(community)).toBeDefined();
});

it("fences a late claim completion after the dialog is replaced", async () => {
  let release!: () => void;
  claim = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const user = userEvent.setup();
  const first = await open();
  await start(user);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(calls.some((call) => call.path === "/api/invites/claim")).toBe(true),
  );
  try {
    await expectWriteLocked(user, first.close, "Joining…");
    await first.stop();
    await open();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByLabelText("Display name");
    const queries = calls.filter((call) => call.path === "/query").length;
    await act(async () => release());
    expect(calls.filter((call) => call.path === "/query")).toHaveLength(
      queries,
    );
    expect(first.close).not.toHaveBeenCalled();
    expect(first.communities.snapshot().memberships).toEqual([]);
  } finally {
    release();
  }
});

it("keeps a new invite bound to its relay despite another unfinished join", async () => {
  const other = "https://other-join.test";
  journal().begin(community);
  requestedCommunity = other;
  const user = userEvent.setup();
  await open({ community: other, code: "v2.other" });
  expect(screen.getByLabelText("Community URL")).toHaveValue(other);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByLabelText("Invite code")).toHaveValue("v2.other");
  await user.click(screen.getByRole("checkbox", { name: /I agree/ }));
  await user.click(screen.getByRole("checkbox", { name: /at least 18/ }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(calls.some((call) => call.path === "/api/invites/claim")).toBe(true),
  );
  expect(
    calls.find((call) => call.path === "/api/invites/claim")?.body,
  ).toEqual({
    code: "v2.other",
    policy_receipt: "fixture-receipt",
  });
  expect(journal().get(community)).toBeDefined();
});

it("recovers the invite's own unfinished join without claiming again", async () => {
  journal().begin(community, { name: "Saved", picture: "" });
  admitted = true;
  const user = userEvent.setup();
  await open({ community, code: "v2.new" });
  expect(screen.getByLabelText("Community URL")).toHaveValue(community);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByLabelText("Display name")).toHaveValue("Saved");
  expect(calls.some((call) => call.path === "/api/invites/claim")).toBe(false);
});

it("does not recover another viewer's unfinished join", async () => {
  createJoinJournal("f".repeat(64)).begin(community, {
    name: "Other viewer",
    picture: "",
  });
  const user = userEvent.setup();
  await open({ community, code: "v2.new" });
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByLabelText("Invite code")).toHaveValue("v2.new");
  expect(screen.queryByLabelText("Display name")).toBeNull();
});

it("clears invite material when the prefilled relay is edited", async () => {
  const user = userEvent.setup();
  const other = "https://other-join.test";
  await open({ community, code: "v2.original" });
  await user.clear(screen.getByLabelText("Community URL"));
  await user.type(screen.getByLabelText("Community URL"), other);
  expect(screen.getByLabelText("Community URL")).toHaveValue(other);
  requestedCommunity = other;
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByLabelText("Invite code")).toHaveValue("");
  expect(calls.some((call) => call.path === "/api/invites/claim")).toBe(false);
});

it("leaves a native lookup the relay never answers, then names a relay it couldn't reach", async () => {
  await open();
  const answer = vi.mocked(invoke).getMockImplementation();
  let discovery: "held" | "failed" = "held";
  let discovered = 0;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Native discovery is a GET, which has no cancel id: Cancel can only fence it.
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "relay_http" && (args as { path: string }).path === "/") {
      discovered++;
      if (discovery === "failed")
        return Promise.reject("Relay request could not be confirmed");
      await held;
    }
    return answer?.(command, args);
  });
  const user = userEvent.setup();
  const field = screen.getByLabelText("Community URL");
  await user.type(field, community);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(discovered).toBe(1));
  expect(screen.getByRole("button", { name: "Connecting…" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(field).toHaveFocus();
  expect(field).toHaveValue(community);
  expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
  // The relay answers only after the lookup was left.
  await act(async () => release());
  await waitFor(() =>
    expect(calls.some((call) => call.path === "/")).toBe(true),
  );
  expect(field).toBeEnabled();
  expect(field).not.toHaveAttribute("aria-invalid", "true");
  expect(screen.queryByLabelText("Invite code")).not.toBeInTheDocument();

  discovery = "failed";
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(field).toHaveAccessibleDescription(
      "Couldn’t reach native-join.test. Check the address, or try again.",
    ),
  );
  expect(field).toHaveAttribute("aria-invalid", "true");
  expect(discovered).toBe(2);
});
