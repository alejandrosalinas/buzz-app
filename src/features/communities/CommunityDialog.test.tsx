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
import { afterEach, expect, it, vi } from "vitest";
import { CommunityDialog } from "./CommunityDialog";
import { Context } from "@deepseek-ai/cordis";
import { createCommunities, type Communities } from "./service";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
import { federatedFixture } from "../federated-identity/testing";

stubAvatarBrowserApis();

const api = vi.hoisted(() => ({
  inspectProfile: vi.fn<typeof import("./api").inspectProfile>(),
  publishProfile: vi.fn<typeof import("./api").publishProfile>(),
}));
api.inspectProfile.mockRejectedValue(new Error("Relay read failed (403)"));
api.publishProfile.mockResolvedValue();
vi.mock("./api", async (actual) => ({
  ...(await actual<typeof import("./api")>()),
  inspectProfile: api.inspectProfile,
  publishProfile: api.publishProfile,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("publishes a description-only edit to an existing community profile", async () => {
  api.inspectProfile
    .mockResolvedValueOnce({
      exists: true,
      existing: { name: "Fixture", about: "Before" },
      profile: { name: "Fixture", picture: "", about: "Before" },
    })
    .mockResolvedValueOnce({
      exists: true,
      existing: { name: "Fixture", about: "After" },
      profile: { name: "Fixture", picture: "", about: "After" },
    });
  const user = userEvent.setup();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const route = String(url).split("/").at(-1);
      if (route === "register") return Response.json({ id: "x" });
      if (route === "info")
        return Response.json({ name: "Fixture", membershipRequired: true });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const communities = {
    snapshot: () => ({
      status: "ready",
      relayAvailable: true,
      profile: { name: "Local", picture: "" },
    }),
    joined: vi.fn(),
  } as unknown as Communities;
  const close = vi.fn();
  render(
    <CommunityDialog communities={communities} mode="join" close={close} />,
  );
  expect(
    screen.getByRole("dialog", { name: "Join a community" }),
  ).toHaveAccessibleDescription(
    "Use your identity across communities. Your profile and conversations stay separate in each one.",
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Community URL")).toHaveFocus(),
  );
  // Continue contacts the destination with the viewer's identity before joining.
  expect(screen.getByLabelText("Community URL")).toHaveAccessibleDescription(
    "Paste your community link. Continue shares your Buzz identity with the community so you can preview it before joining.",
  );
  await user.type(
    screen.getByLabelText("Community URL"),
    "wss://relay.example",
  );
  await user.click(screen.getByRole("button", { name: "Continue" }));
  const description = await screen.findByLabelText(
    "Profile description (optional)",
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Display name")).toHaveFocus(),
  );
  expect(screen.queryByText("https://relay.example")).not.toBeInTheDocument();
  await user.clear(description);
  await user.type(description, "After");
  // A stray outside click keeps the dialog and the typed profile.
  const backdrop = document.querySelector(".buzz-dialog-backdrop") as Element;
  fireEvent.pointerDown(backdrop);
  fireEvent.mouseDown(backdrop);
  fireEvent.click(backdrop);
  await Promise.resolve();
  expect(close).not.toHaveBeenCalled();
  expect(description).toHaveValue("After");
  await user.click(
    screen.getByRole("button", { name: "Publish profile & open" }),
  );
  expect(api.publishProfile).toHaveBeenCalledWith(
    "https://relay.example",
    { name: "Fixture", picture: "", about: "After" },
    { name: "Fixture", about: "Before" },
  );
  await waitFor(() => expect(communities.joined).toHaveBeenCalledOnce());
});

it.each([false, true])(
  "opens with an unchanged over-limit profile and allows correction (onboarding=%s)",
  async (onboarding) => {
    const about = "a".repeat(800);
    api.inspectProfile.mockResolvedValueOnce({
      exists: true,
      existing: { name: "Fixture", about },
      profile: { name: "Fixture", picture: "", about },
    });
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const route = String(url).split("/").at(-1);
        if (route === "register") return Response.json({ id: "x" });
        if (route === "info")
          return Response.json({ name: "Fixture", membershipRequired: true });
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const communities = {
      snapshot: () => ({
        status: "ready",
        relayAvailable: true,
        profile: { name: "Local", picture: "" },
      }),
      joined: vi.fn(),
    } as unknown as Communities;
    render(
      <CommunityDialog
        communities={communities}
        mode="join"
        onboarding={onboarding}
        close={() => {}}
      />,
    );
    await user.type(
      screen.getByLabelText("Community URL"),
      "wss://relay.example",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    const name = await screen.findByLabelText("Display name");
    await user.type(name, " Renamed");
    expect(
      screen.getByRole("button", { name: "Publish profile & open" }),
    ).toBeDisabled();
    const description = screen.getByLabelText("Profile description (optional)");
    expect(description).toHaveValue(about);
    expect(
      screen.getByText(
        "Shorten the description to 500 characters before saving.",
      ),
    ).toBeVisible();
    await user.clear(description);
    await user.type(description, "Repaired");
    expect(
      screen.getByRole("button", { name: "Publish profile & open" }),
    ).toBeEnabled();
    // The correction field remains available after its validation error clears.
    expect(description).toBeVisible();
    await user.clear(description);
    fireEvent.change(description, { target: { value: about } });
    await user.clear(name);
    await user.type(name, "Fixture");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(api.publishProfile).not.toHaveBeenCalled();
    expect(communities.joined).toHaveBeenCalledWith(
      expect.objectContaining({ id: "https://relay.example" }),
      { name: "Fixture", picture: "", about },
    );
  },
);

it("names exact relay claim refusals and keeps other failures generic", async () => {
  const user = userEvent.setup();
  let refusal = "invite_exhausted";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const route = String(url).split("/").at(-1);
      if (route === "register") return Response.json({ id: "x" });
      if (route === "info")
        return Response.json({ name: "Fixture", membershipRequired: true });
      if (route === "claim")
        return Response.json({ error: refusal }, { status: 403 });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const communities = {
    snapshot: () => ({
      status: "ready",
      relayAvailable: true,
      profile: { name: "", picture: "" },
    }),
  } as unknown as Communities;
  render(
    <CommunityDialog communities={communities} mode="join" close={() => {}} />,
  );
  await user.type(
    screen.getByLabelText("Community URL"),
    "wss://relay.example",
  );
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.type(await screen.findByLabelText("Invite code"), "v2.abc");
  expect(screen.getByText("https://relay.example")).toBeVisible();
  for (const [code, shown] of [
    [
      "invite_exhausted",
      "This invite has reached its use limit. Ask for a new invite.",
    ],
    ["invite_expired", "This invite code has expired — ask for a new one."],
    ["invite_invalid", "This invite code is not valid for this community."],
    ["Relay request failed (403)", "Relay request failed (403)"],
  ] as const) {
    refusal = code;
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(shown);
  }
});

it.each([
  "https://relay.example/media/avatar.png",
  "https://RELAY.example:443/media/avatar.png",
])(
  "keeps %s out of first-join local defaults without changing the published profile",
  async (picture) => {
    api.inspectProfile.mockResolvedValueOnce({
      exists: true,
      existing: { name: "Fixture", membershipRequired: true },
      profile: {
        name: "Fixture",
        picture,
        about: "",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const route = String(url).split("/").at(-1);
        if (route === "register") return Response.json({ id: "x" });
        if (route === "info")
          return Response.json({ name: "Fixture", membershipRequired: true });
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const communities = {
      snapshot: () => ({
        status: "ready",
        relayAvailable: true,
        profile: { name: "", picture: "" },
      }),
      joined: vi.fn(),
    } as unknown as Communities;
    render(
      <CommunityDialog
        communities={communities}
        mode="join"
        close={() => {}}
      />,
    );
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("Community URL"),
      "wss://relay.example",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByLabelText("Display name");
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    expect(api.publishProfile).not.toHaveBeenCalled();
    expect(communities.joined).toHaveBeenCalledWith(
      expect.objectContaining({ id: "https://relay.example" }),
      { name: "Fixture", picture: "", about: "" },
    );
  },
);

it("explains an inherited invalid avatar when editing at join and recovers on replacement", async () => {
  const picture = "http://images.example/avatar.png";
  api.inspectProfile
    .mockResolvedValueOnce({
      exists: true,
      existing: { name: "Fixture", picture },
      profile: { name: "Fixture", picture, about: "" },
    })
    .mockResolvedValueOnce({
      exists: true,
      existing: {},
      profile: {
        name: "Fixture changed",
        picture: "https://images.example/new.png",
        about: "",
      },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/register")) return Response.json({ id: "x" });
      if (url.endsWith("/info"))
        return Response.json({ name: "Fixture", membershipRequired: true });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const communities = {
    snapshot: () => ({
      status: "ready",
      relayAvailable: true,
      profile: { name: "", picture: "" },
    }),
    joined: vi.fn(),
  } as unknown as Communities;
  render(
    <CommunityDialog communities={communities} mode="join" close={() => {}} />,
  );
  const user = userEvent.setup();
  await user.type(
    screen.getByLabelText("Community URL"),
    "wss://relay.example",
  );
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.type(await screen.findByLabelText("Display name"), " changed");
  expect(
    screen.getByRole("button", { name: "Publish profile & open" }),
  ).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("Use an HTTPS image URL");
  await user.click(screen.getByRole("button", { name: "Edit avatar" }));
  const input = await screen.findByLabelText("Picture URL (optional)");
  expect(input).toHaveAccessibleDescription(/Use an HTTPS image URL/);
  await user.clear(input);
  await user.type(input, "https://images.example/new.png");
  await user.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Publish profile & open" }),
  );
  expect(api.publishProfile).toHaveBeenCalledWith(
    "https://relay.example",
    {
      name: "Fixture changed",
      picture: "https://images.example/new.png",
      about: "",
    },
    { name: "Fixture", picture },
  );
  await waitFor(() => expect(communities.joined).toHaveBeenCalledOnce());
});

it("keeps join unavailable after native identity hydration, but still saves a local profile", async () => {
  const ctx = new Context();
  vi.stubGlobal("fetch", vi.fn());
  const communities = createCommunities(
    ctx,
    false,
    undefined,
    "",
    undefined,
    Promise.resolve("d".repeat(64)),
  );
  try {
    await waitFor(() => expect(communities.snapshot().status).toBe("ready"));
    const view = render(
      <CommunityDialog
        communities={communities}
        mode="join"
        close={() => {}}
      />,
    );
    expect(
      screen.getByText(/connecting to communities is not available/),
    ).toBeVisible();
    expect(screen.queryByLabelText("Community URL")).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    const form = screen.getByRole("dialog").querySelector("form");
    if (!form) throw new Error("Join dialog form is missing");
    fireEvent.submit(form);
    expect(fetch).not.toHaveBeenCalled();
    expect(api.inspectProfile).not.toHaveBeenCalled();
    view.unmount();
    const close = vi.fn();
    const user = userEvent.setup();
    render(
      <CommunityDialog
        communities={communities}
        mode="profile"
        close={close}
      />,
    );
    await user.type(screen.getByLabelText("Display name"), "Local only");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(communities.snapshot().profile.name).toBe("Local only");
    expect(fetch).not.toHaveBeenCalled();
    expect(api.publishProfile).not.toHaveBeenCalled();
  } finally {
    cleanup();
    await ctx.fiber.dispose();
    localStorage.clear();
  }
});

const unreadable = "Enter a community address or invite link.";
const bareCode = "Paste the whole invite link, not only its code.";

it.each([
  ["", unreadable],
  ["not a relay", unreadable],
  ["v2.acTJgVMn-cEaz84r5g7Az40Vz_JB5nAURtFFSq1oUIo", bareCode],
  // A sentence-ending dot copied with the code still normalizes to it.
  ["v2.acTJgVMn-cEaz84r5g7Az40Vz_JB5nAURtFFSq1oUIo.", bareCode],
])(
  "shows inline relay validation for %j without contacting a relay",
  async (value, message) => {
    const user = userEvent.setup();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const communities = {
      snapshot: () => ({
        status: "ready",
        relayAvailable: true,
        profile: { name: "Local", picture: "" },
      }),
    } as unknown as Communities;
    render(
      <CommunityDialog
        communities={communities}
        mode="join"
        close={() => {}}
      />,
    );
    const input = screen.getByLabelText("Community URL");
    if (value) {
      await user.click(input);
      await user.paste(value);
    }
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(expect.stringContaining(message));
    expect(fetch).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, "wss://relay.example");
    expect(screen.queryByRole("alert")).toBeNull();
  },
);

it.each([
  [
    "an invite link",
    "https://Relay.Example/invite/v2.abc",
    "https://relay.example",
    "v2.abc",
  ],
  ["a bare host", "relay.example", "https://relay.example", undefined],
  // Only a code-length label after `v2.` is refused as a bare invite code.
  ["a short v2 host", "v2.dev", "https://v2.dev", undefined],
])(
  "looks up the community for %s and prefills only an invite link's code",
  async (_, value, origin, code) => {
    const user = userEvent.setup();
    const requests = vi.fn(async (url: string) => {
      const route = String(url).split("/").at(-1);
      if (route === "register") return Response.json({ id: "x" });
      if (route === "info")
        return Response.json({ name: "Fixture", membershipRequired: false });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", requests);
    const communities = {
      snapshot: () => ({
        status: "ready",
        relayAvailable: true,
        profile: { name: "", picture: "" },
      }),
    } as unknown as Communities;
    render(
      <CommunityDialog
        communities={communities}
        mode="join"
        close={() => {}}
      />,
    );
    await user.click(screen.getByLabelText("Community URL"));
    await user.paste(value);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    // The access step names the canonical origin the lookup went to.
    expect(await screen.findByText(origin)).toBeVisible();
    expect(requests).toHaveBeenCalledWith(
      `/api/relay/${encodeURIComponent(origin)}/info`,
      expect.anything(),
    );
    if (code) expect(screen.getByLabelText("Invite code")).toHaveValue(code);
    else expect(screen.queryByLabelText("Invite code")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  },
);

it("prefills an invite but requires explicit discovery and claim before membership", async () => {
  const user = userEvent.setup();
  const requests = vi.fn(async (url: string, init?: RequestInit) => {
    const route = String(url).split("/").at(-1);
    if (route === "register") return Response.json({ id: "x" });
    if (route === "info")
      return Response.json({ name: "Fixture", membershipRequired: true });
    if (route === "claim") {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        code: "v2.abc",
      });
      return Response.json({ error: "invite_expired" }, { status: 403 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", requests);
  const communities = {
    snapshot: () => ({
      status: "ready",
      relayAvailable: true,
      profile: { name: "", picture: "" },
    }),
    joined: vi.fn(),
  } as unknown as Communities;
  render(
    <CommunityDialog
      communities={communities}
      mode="join"
      close={() => {}}
      invite={{
        community: "https://relay.example",
        code: "v2.abc",
      }}
    />,
  );
  expect(screen.getByLabelText("Community URL")).toHaveValue(
    "https://relay.example",
  );
  expect(requests).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByLabelText("Invite code")).toHaveValue("v2.abc");
  expect(
    requests.mock.calls.some(([url]) => String(url).endsWith("/claim")),
  ).toBe(false);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This invite code has expired — ask for a new one.",
  );
  expect(communities.joined).not.toHaveBeenCalled();
});

/** A signed-in account whose server hosts relay.example (`federatedFixture`). */
async function signedInAccount() {
  const h = federatedFixture();
  await h.service.signIn();
  return h.service;
}

const pastedInvite = "https://relay.example/invite/v2.abc";
const openedInvite = { community: "https://relay.example", code: "v2.abc" };

it.each([
  ["an opened invite", "denied", undefined],
  // The link's code is claimed on the submission that parses it, before any
  // render shows it in Invite code.
  ["a pasted invite link", "denied", pastedInvite],
  ["a pasted invite link", "new-profile", pastedInvite],
])(
  "a signed-in account's consent skips the access step for %s after a %s read: the invite claim confirms the holder's age, with no boxes to tick",
  async (_, read, pasted) => {
    const found = {
      exists: false,
      existing: {},
      profile: { name: "", picture: "" },
    };
    (read === "denied"
      ? api.inspectProfile.mockRejectedValueOnce(
          new Error("Relay read failed (403)"),
        )
      : api.inspectProfile.mockResolvedValueOnce(found)
    ).mockResolvedValueOnce(found);
    const user = userEvent.setup();
    const accepted: unknown[] = [];
    const claimed: unknown[] = [];
    const requests = vi.fn(async (url: string, init?: RequestInit) => {
      const route = String(url).split("/").at(-1);
      if (route === "register") return Response.json({ id: "x" });
      if (route === "info")
        return Response.json({
          name: "Fixture",
          membershipRequired: true,
          policy: {
            version: "v1",
            terms_markdown: "Terms",
            age_attestation_required: true,
          },
        });
      if (route === "accept-policy") {
        accepted.push(JSON.parse(String(init?.body)));
        return Response.json({ receipt: "receipt-1" });
      }
      if (route === "claim") {
        claimed.push(JSON.parse(String(init?.body)));
        return Response.json({ status: "joined" });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", requests);
    const communities = {
      snapshot: () => ({
        status: "ready",
        relayAvailable: true,
        profile: { name: "", picture: "" },
      }),
    } as unknown as Communities;
    render(
      <CommunityDialog
        communities={communities}
        federatedIdentity={await signedInAccount()}
        mode="join"
        close={() => {}}
        {...(pasted ? {} : { invite: openedInvite })}
      />,
    );
    if (pasted) {
      await user.click(screen.getByLabelText("Community URL"));
      await user.paste(pasted);
    }
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByLabelText("Display name")).toBeVisible();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByLabelText("Invite code")).toBeNull();
    expect(accepted).toEqual([
      { code: "v2.abc", policy_version: "v1", age_confirmed: true },
    ]);
    expect(claimed).toEqual([{ code: "v2.abc", policy_receipt: "receipt-1" }]);
  },
);

it.each([
  ["an opened invite", undefined],
  ["a pasted invite link", pastedInvite],
])(
  "a signed-in account's refused claim for %s lands on the access step, where another code can be entered",
  async (_, pasted) => {
    const user = userEvent.setup();
    const requests = vi.fn(async (url: string) => {
      const route = String(url).split("/").at(-1);
      if (route === "register") return Response.json({ id: "x" });
      if (route === "info")
        return Response.json({ name: "Fixture", membershipRequired: true });
      if (route === "claim")
        return Response.json({ error: "invite_expired" }, { status: 403 });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", requests);
    const communities = {
      snapshot: () => ({
        status: "ready",
        relayAvailable: true,
        profile: { name: "", picture: "" },
      }),
    } as unknown as Communities;
    render(
      <CommunityDialog
        communities={communities}
        federatedIdentity={await signedInAccount()}
        mode="join"
        close={() => {}}
        {...(pasted ? {} : { invite: openedInvite })}
      />,
    );
    if (pasted) {
      await user.click(screen.getByLabelText("Community URL"));
      await user.paste(pasted);
    }
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This invite code has expired — ask for a new one.",
    );
    expect(screen.getByLabelText("Invite code")).toHaveValue("v2.abc");
  },
);

it("without a signed-in account a relay's policy is still asked on the access step", async () => {
  const user = userEvent.setup();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const route = String(url).split("/").at(-1);
      if (route === "register") return Response.json({ id: "x" });
      if (route === "info")
        return Response.json({
          name: "Fixture",
          policy: {
            version: "v1",
            terms_markdown: "Terms",
            age_attestation_required: true,
          },
        });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const communities = {
    snapshot: () => ({
      status: "ready",
      relayAvailable: true,
      profile: { name: "", picture: "" },
    }),
  } as unknown as Communities;
  render(
    <CommunityDialog
      communities={communities}
      federatedIdentity={federatedFixture().service}
      mode="join"
      close={() => {}}
      invite={{ community: "https://relay.example", code: "v2.abc" }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(
    await screen.findByRole("checkbox", {
      name: "I confirm that I am at least 18 years old.",
    }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
});

it("renews policy acceptance after an expired receipt instead of replaying it", async () => {
  const user = userEvent.setup();
  let version = "v1";
  let acceptance = 0;
  const receipts: string[] = [];
  const requests = vi.fn(async (url: string, init?: RequestInit) => {
    const route = String(url).split("/").at(-1);
    if (route === "register") return Response.json({ id: "x" });
    if (route === "info")
      return Response.json({
        name: "Fixture",
        policy: {
          version,
          terms_markdown: "Terms",
          age_attestation_required: false,
        },
      });
    if (route === "accept-policy") {
      expect(JSON.parse(String(init?.body)).policy_version).toBe(version);
      return Response.json({ receipt: `fresh-${++acceptance}` });
    }
    if (route === "claim") {
      const body = JSON.parse(String(init?.body));
      expect(body.code).toBe("v2.abc");
      receipts.push(body.policy_receipt);
      return acceptance === 1
        ? Response.json({ error: "join_policy_required" }, { status: 403 })
        : Response.json({ status: "joined" });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", requests);
  const communities = {
    snapshot: () => ({
      status: "ready",
      relayAvailable: true,
      profile: { name: "", picture: "" },
    }),
  } as unknown as Communities;
  render(
    <CommunityDialog
      communities={communities}
      mode="join"
      close={() => {}}
      invite={{ community: "https://relay.example", code: "v2.abc" }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByLabelText("Invite code");
  await user.click(screen.getByRole("checkbox", { name: /I agree/ }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "current policy acceptance",
  );
  version = "v2";
  await user.click(screen.getByRole("button", { name: "Back" }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByLabelText("Invite code");
  await user.click(screen.getByRole("checkbox", { name: /I agree/ }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(receipts).toEqual(["fresh-1", "fresh-2"]));
  expect(
    requests.mock.calls.filter(([url]) =>
      String(url).endsWith("/accept-policy"),
    ),
  ).toHaveLength(2);
  expect(screen.queryByText(/current policy acceptance/)).toBeNull();
});

it("opens a checked connection address separately without replacing or removing the original", async () => {
  const viewer = "e".repeat(64);
  const original = "https://old.example";
  const ctx = new Context();
  const profile = { name: "You", picture: "", about: "" };
  api.inspectProfile.mockResolvedValueOnce({
    exists: true,
    existing: profile,
    profile,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const route = String(url).split("/").at(-1);
      if (route === "register") return Response.json({});
      if (route === "info")
        return Response.json({ name: "New community", policy: null });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
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
    communities.joined({ id: original, name: "Original" }, profile);
    const connected = {
      ...communities,
      snapshot: () => ({ ...communities.snapshot(), relayAvailable: true }),
    };
    const user = userEvent.setup();
    render(
      <CommunityDialog
        communities={connected}
        mode="join"
        connectionFrom={original}
        close={() => {}}
      />,
    );
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
      "Enter a wss:// or https:// relay address without a path. Changing the connection URL does not rename or move this community.",
    );
    const address = screen.getByLabelText("Community URL");
    expect(address).toHaveValue(original);
    fireEvent.change(address, { target: { value: "wss://new.example" } });
    expect(address).toHaveValue("wss://new.example");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(communities.snapshot().selected).toBe(original);
    await screen.findByLabelText("Display name");
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(communities.snapshot().selected).toBe("https://new.example"),
    );
    expect(communities.snapshot().memberships.map((entry) => entry.id)).toEqual(
      [original, "https://new.example"],
    );
    expect(api.publishProfile).not.toHaveBeenCalled();
  } finally {
    cleanup();
    await ctx.fiber.dispose();
    localStorage.clear();
  }
});

it("offers federated sign-in when joining refuses for it, then lets Continue run the current step", async () => {
  const user = userEvent.setup();
  let refuse = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const route = String(url).split("/").at(-1);
      if (route === "register") return Response.json({ id: "x" });
      if (route === "info" && refuse)
        return Response.json(
          { error: "Federated sign-in is required" },
          { status: 401 },
        );
      if (route === "info")
        return Response.json({ name: "Fixture", membershipRequired: true });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const communities = {
    snapshot: () => ({
      status: "ready",
      relayAvailable: true,
      profile: { name: "Local", picture: "" },
    }),
  } as unknown as Communities;
  const h = federatedFixture();
  render(
    <CommunityDialog
      communities={communities}
      federatedIdentity={h.service}
      mode="join"
      close={() => {}}
    />,
  );
  await user.type(
    screen.getByLabelText("Community URL"),
    "wss://relay.example",
  );
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(
    await screen.findByText(
      "This community requires builderlab.example sign-in.",
    ),
  ).toBeVisible();
  const signIn = await screen.findByRole("button", {
    name: "Sign in with builderlab.example",
  });
  refuse = false;
  const requests = vi.mocked(fetch).mock.calls.length;
  await user.click(signIn);
  expect(h.service.signIn).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Sign in with builderlab.example" }),
    ).toBeNull(),
  );
  // Completing login replays nothing captured before it.
  expect(vi.mocked(fetch).mock.calls.length).toBe(requests);
  await user.clear(screen.getByLabelText("Community URL"));
  await user.type(
    screen.getByLabelText("Community URL"),
    "wss://other.example",
  );
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(String(vi.mocked(fetch).mock.calls.at(-1)?.[0])).toContain(
    "other.example",
  );
  expect(await screen.findByLabelText("Invite code")).toBeInTheDocument();
});

it.each(["edit", "close"])(
  "replays nothing captured before a pending sign-in (%s)",
  async (change) => {
    const user = userEvent.setup();
    const requests = vi.fn(async (url: string) => {
      const route = String(url).split("/").at(-1);
      if (route === "register") return Response.json({ id: "x" });
      if (route === "info" && requests.mock.calls.length < 3)
        return Response.json(
          { error: "Federated sign-in is required" },
          { status: 401 },
        );
      if (route === "info")
        return Response.json({ name: "Fixture", membershipRequired: true });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", requests);
    const communities = {
      snapshot: () => ({
        status: "ready",
        relayAvailable: true,
        profile: { name: "Local", picture: "" },
      }),
    } as unknown as Communities;
    const h = federatedFixture();
    let finish = () => {};
    vi.mocked(h.service.signIn).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => {
            h.publish({ status: "signed-in" });
            resolve(h.service.snapshot());
          };
        }),
    );
    const view = render(
      <CommunityDialog
        communities={communities}
        federatedIdentity={h.service}
        mode="join"
        close={() => {}}
      />,
    );
    const field = screen.getByLabelText("Community URL");
    await user.type(field, "wss://old.example");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(
      await screen.findByRole("button", {
        name: "Sign in with builderlab.example",
      }),
    );
    if (change === "close") view.unmount();
    else {
      await user.clear(field);
      await user.type(field, "wss://new.example");
    }
    const before = requests.mock.calls.length;
    await act(async () => finish());
    expect(requests.mock.calls.length).toBe(before);
    expect(api.publishProfile).not.toHaveBeenCalled();
    if (change === "edit") {
      await user.click(screen.getByRole("button", { name: "Continue" }));
      await waitFor(() =>
        expect(String(requests.mock.calls.at(-1)?.[0])).toContain(
          "new.example",
        ),
      );
    }
  },
);

const lookupCommunities = {
  snapshot: () => ({
    status: "ready",
    relayAvailable: true,
    profile: { name: "Local", picture: "" },
  }),
} as unknown as Communities;

/** A host that accepts the request and never answers, until it is abandoned. */
function silentHost() {
  const lookups: AbortSignal[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const route = String(url).split("/").at(-1);
      if (route === "register") return Response.json({ id: "x" });
      if (route === "info")
        return new Promise<Response>((_, reject) => {
          const signal = init?.signal as AbortSignal;
          lookups.push(signal);
          signal.addEventListener("abort", () => reject(signal.reason));
        });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  return lookups;
}

it("lets Cancel, Close and Escape leave a lookup the host never answers", async () => {
  const lookups = silentHost();
  const close = vi.fn();
  const user = userEvent.setup();
  const view = render(
    <CommunityDialog
      communities={lookupCommunities}
      mode="join"
      close={close}
    />,
  );
  const field = screen.getByLabelText("Community URL");
  await user.type(field, "wss://quiet.example");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(lookups).toHaveLength(1));
  expect(screen.getByRole("button", { name: "Connecting…" })).toBeDisabled();
  expect(field).toBeDisabled();
  expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(lookups[0]?.aborted).toBe(true);
  expect(field).toHaveValue("wss://quiet.example");
  expect(field).toHaveFocus();
  expect(field).not.toHaveAttribute("aria-invalid", "true");
  expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  expect(close).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(lookups).toHaveLength(2));
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledOnce();
  expect(lookups[1]?.aborted).toBe(true);

  view.unmount();
  close.mockClear();
  render(
    <CommunityDialog
      communities={lookupCommunities}
      mode="join"
      close={close}
    />,
  );
  await user.type(
    screen.getByLabelText("Community URL"),
    "wss://quiet.example",
  );
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(lookups).toHaveLength(3));
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(close).toHaveBeenCalledOnce();
  expect(lookups[2]?.aborted).toBe(true);
});

// jsdom's DOMException is not an Error, so each engine's rejection is built
// with the name and message the engine gives it.
it.each([
  ["Chromium’s timeout", "TimeoutError", "signal timed out"],
  ["WebKit’s timeout", "AbortError", "Fetch is aborted"],
  ["an unreachable network", "TypeError", "Failed to fetch"],
])(
  "names a host that never answered instead of %s text",
  async (_, name, message) => {
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const route = String(url).split("/").at(-1);
        if (route === "register") return Response.json({ id: "x" });
        if (route === "info" && fail)
          throw name === "TypeError"
            ? new TypeError(message)
            : Object.assign(new Error(message), { name });
        if (route === "info")
          return Response.json({ name: "Fixture", membershipRequired: true });
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(
      <CommunityDialog
        communities={lookupCommunities}
        mode="join"
        close={() => {}}
      />,
    );
    const field = screen.getByLabelText("Community URL");
    await user.type(field, "wss://quiet.example");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(field).toHaveAccessibleDescription(
        "Couldn’t reach quiet.example. Check the address, or try again.",
      ),
    );
    expect(screen.queryByText(message)).not.toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveValue("wss://quiet.example");
    // Continue is the retry.
    fail = false;
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByLabelText("Invite code")).toBeVisible();
  },
);

it("reads no profile from a host whose late answer arrives after Cancel", async () => {
  let answer: (() => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const route = String(url).split("/").at(-1);
      if (route === "register") return Response.json({ id: "x" });
      // A transport that ignores the abort and answers anyway.
      if (route === "info")
        return new Promise<Response>((resolve) => {
          answer = () => resolve(Response.json({ name: "Late" }));
        });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const user = userEvent.setup();
  render(
    <CommunityDialog
      communities={lookupCommunities}
      mode="join"
      close={() => {}}
    />,
  );
  await user.type(
    screen.getByLabelText("Community URL"),
    "wss://quiet.example",
  );
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(answer).toBeDefined());
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => answer?.());
  expect(api.inspectProfile).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
});

it("keeps a cancelled lookup's late profile refusal off the corrected address", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const route = String(url).split("/").at(-1);
      if (route === "register") return Response.json({ id: "x" });
      if (route === "info")
        return Response.json(
          String(url).includes("closed.example")
            ? { name: "Closed", membershipRequired: true }
            : { name: "Open" },
        );
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const refusals: Array<(reason: unknown) => void> = [];
  const held = () =>
    new Promise<never>((_, reject) => {
      refusals.push(reject);
    });
  api.inspectProfile.mockImplementationOnce(held).mockImplementationOnce(held);
  const user = userEvent.setup();
  render(
    <CommunityDialog
      communities={lookupCommunities}
      mode="join"
      close={() => {}}
    />,
  );
  const field = screen.getByLabelText("Community URL");
  await user.type(field, "wss://closed.example");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(refusals).toHaveLength(1));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.clear(field);
  await user.type(field, "wss://open.example");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(refusals).toHaveLength(2));
  // The closed community refuses the abandoned profile read only now.
  await act(async () => refusals[0]?.(new Error("Relay read failed (403)")));
  expect(screen.getByRole("button", { name: "Connecting…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  await act(async () => refusals[1]?.(new Error("Relay read failed (403)")));
  expect(await screen.findByText("https://open.example")).toBeVisible();
  expect(screen.queryByLabelText("Invite code")).not.toBeInTheDocument();
});

it.each([
  [502, "Relay unreachable", true],
  [500, "Local relay broker failed", true],
  [503, "Community discovery failed", true],
  [400, "Destination rejected", false],
  [401, "Sign in required", false],
  [403, "Membership required", false],
])(
  "preserves broker HTTP %s classification through the destination lookup",
  async (status, message, transient) => {
    let failed = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const route = String(url).split("/").at(-1);
        if (route === "register") return Response.json({});
        if (route === "info")
          return failed
            ? Response.json({ error: message }, { status })
            : Response.json({ name: "Fixture", membershipRequired: true });
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(
      <CommunityDialog
        communities={lookupCommunities}
        mode="join"
        close={() => {}}
      />,
    );
    const field = screen.getByLabelText("Community URL");
    await user.type(field, "wss://quiet.example");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(field).toHaveAccessibleDescription(
        transient
          ? "Couldn’t reach quiet.example. Check the address, or try again."
          : message,
      ),
    );
    expect(field).toHaveValue("wss://quiet.example");
    expect(api.inspectProfile).not.toHaveBeenCalled();
    failed = false;
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByLabelText("Invite code")).toBeVisible();
  },
);
