// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { localAgentsFixture } from "../../features/agents/local-testing";
import { bindNames } from "../../features/identity-names/service";
import { createAgentDirectory } from "../../features/identity-names/testing";
import { profileTarget } from "../../features/profiles/target";
import type { RelayData } from "../../features/relay/service";
import { createRelaySession } from "../../features/relay/session";
import { keypair, profile } from "../../features/relay/testing";
import { mediaUrl, type ReadTransport } from "../../features/relay/transport";
import { ProfilePanel } from "./ProfilePanel";
import { formatPublicKey } from "../../shared/identity/public-key";

afterEach(cleanup);

function fixture(configuredNames = false) {
  const person = keypair();
  const viewer = keypair().pubkey;
  const agent = {
    pubkey: person.pubkey,
    name: "Fixture agent",
    relayUrl: "wss://relay.example.test",
    owner: viewer,
  };
  // Agents lists this machine's agents once it loads.
  const control = localAgentsFixture(configuredNames ? [agent] : []);
  const provider = createAgentDirectory(control);
  const query = vi.fn<ReadTransport["query"]>(async () => []);
  const owner = createRelaySession(
    {
      viewer,
      scope: "https://relay.example.test",
      relayAuthor: keypair().pubkey,
      query,
      // The real sizing rewrite behind a pass-through proxy, so relay-hosted
      // pictures resolve to the variant the panel actually requested.
      media: (url, size) =>
        mediaUrl(url, (proxied) => proxied, "https://relay.example.test", size),
      readAgentLibrary: async () => ({ definitions: [], identities: [] }),
    },
    {
      agentChoices: control,
      identityNames: configuredNames
        ? {
            register() {},
            bind: (source) =>
              bindNames(source, {
                snapshot: () => [provider],
                subscribe: () => () => {},
              }),
          }
        : undefined,
    },
  );
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope: `https://relay.example.test:${viewer}`,
    viewer,
    session: owner.session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    tryAgain() {},
    disconnect() {},
    clearCache: async () => {},
  };
  return {
    agent,
    person,
    control,
    /** Agents lists the person as one of this machine's agents. */
    known: (relayUrl = agent.relayUrl) =>
      act(() => control.set({ agents: [{ ...agent, relayUrl }] })),
    query,
    relay,
    session: owner.session,
    panel: (pubkey = person.pubkey) => (
      <StrictMode>
        <ProfilePanel
          relay={relay}
          target={profileTarget(pubkey) ?? ""}
          close={() => {}}
        />
      </StrictMode>
    ),
    dispose() {
      cleanup();
      owner.dispose();
    },
  };
}

it("identifies unnamed profiles by public key and scopes shared agent hints to the exact community", async () => {
  const f = fixture();
  const label = formatPublicKey(f.person.pubkey) ?? "";
  try {
    const view = render(f.panel());
    await screen.findByText(
      "No profile metadata is available in this community.",
    );
    expect(screen.getByRole("heading", { name: label })).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: `${label} avatar` }),
    ).toHaveAttribute("data-avatar-shape", "circle");

    f.known();
    expect(
      screen.getByRole("heading", { name: "Unknown agent" }),
    ).toBeInTheDocument();
    expect(
      screen
        .getByRole("img", { name: "Unknown agent avatar" })
        .querySelector("[data-avatar-shape]"),
    ).toHaveAttribute("data-avatar-shape", "squircle");

    const stranger = keypair().pubkey;
    view.rerender(f.panel(stranger));
    await screen.findByText(
      "No profile metadata is available in this community.",
    );
    expect(
      screen.getByRole("heading", { name: formatPublicKey(stranger) ?? "" }),
    ).toBeInTheDocument();

    view.rerender(f.panel());
    await screen.findByRole("heading", { name: "Unknown agent" });
    f.known("wss://other.example.test");
    expect(screen.getByRole("heading", { name: label })).toBeInTheDocument();
  } finally {
    f.dispose();
  }
});

it("keeps the known-agent fallback on profile failure and replaces it with relay metadata on retry", async () => {
  const f = fixture();
  try {
    f.known();
    f.query.mockImplementation(async (filters) => {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        throw new Error("Profile unavailable");
      return [];
    });
    render(f.panel());
    await screen.findByText("Could not load this profile.");
    expect(
      screen.getByRole("heading", {
        name: "Unknown agent",
      }),
    ).toBeInTheDocument();

    const publicProfile = profile(f.person, {
      name: "Relay agent",
      picture: "https://relay.example.test/avatar.png",
      about: "Public agent bio",
      is_agent: true,
    });
    f.query.mockImplementation(async (filters) =>
      filters.some((filter) => filter.kinds?.includes(0))
        ? [publicProfile]
        : [],
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Retry profile" }));
    await screen.findByRole("heading", { name: "Relay agent" });
    expect(screen.getByText("Public agent bio")).toBeInTheDocument();
    expect(
      screen
        .getByRole("img", { name: "Relay agent avatar" })
        .querySelector("img"),
    ).toHaveAttribute("src", "https://relay.example.test/avatar.png");
    expect(
      screen.queryByText("Could not load this profile."),
    ).not.toBeInTheDocument();
  } finally {
    f.dispose();
  }
});

it("keeps an agent-avatar hint without granting ownership or native controls", async () => {
  const f = fixture();
  const name = "Unknown agent";
  try {
    const show = (hint: boolean) => (
      <StrictMode>
        <ProfilePanel
          relay={f.relay}
          target={profileTarget(f.person.pubkey, { agent: hint }) ?? ""}
          close={() => {}}
        />
      </StrictMode>
    );
    const view = render(show(true));
    await screen.findByText(
      "No profile metadata is available in this community.",
    );
    expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    expect(
      screen
        .getByRole("img", { name: `${name} avatar` })
        .querySelector("[data-avatar-shape]"),
    ).toHaveAttribute("data-avatar-shape", "squircle");
    expect(
      screen.queryByRole("tab", { name: "Runtime" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: "Memories" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /^(Start|Stop|Restart|Delete agent)$/,
      }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Managed by")).not.toBeInTheDocument();
    expect(f.session.agentChoices.snapshot().identities).toEqual([]);

    view.rerender(show(false));
    expect(
      screen.getByRole("heading", {
        name: formatPublicKey(f.person.pubkey) ?? "",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: `${formatPublicKey(f.person.pubkey)} avatar`,
      }),
    ).toHaveAttribute("data-avatar-shape", "circle");
  } finally {
    f.dispose();
  }
});

it("loads public agent names, avatars and bios without a local agent", async () => {
  const f = fixture();
  const sha = "b".repeat(64);
  try {
    const publicProfile = profile(f.person, {
      name: "Remote agent",
      picture: `https://relay.example.test/media/${sha}.png`,
      about: "Remote agent bio",
      is_agent: true,
    });
    f.query.mockImplementation(async (filters) =>
      filters.some((filter) => filter.kinds?.includes(0))
        ? [publicProfile]
        : [],
    );
    render(f.panel());
    await screen.findByRole("heading", { name: "Remote agent" });
    expect(screen.getByText("Remote agent bio")).toBeInTheDocument();
    const avatar = screen.getByRole("img", { name: "Remote agent avatar" });
    expect(avatar.querySelector("[data-avatar-shape]")).toHaveAttribute(
      "data-avatar-shape",
      "squircle",
    );
    // The portrait (and the tab avatar fed from the same value) asks for the
    // relay thumbnail the message row already loaded, not the original blob.
    expect(avatar.querySelector("img")).toHaveAttribute(
      "src",
      `https://relay.example.test/media/${sha}.thumb.webp`,
    );
  } finally {
    f.dispose();
  }
});

it("preserves the configured name of a stopped local agent without a relay profile", async () => {
  const f = fixture(true);
  try {
    render(f.panel());
    await screen.findByText(
      "No profile metadata is available in this community.",
    );
    await screen.findByRole("heading", { name: f.agent.name });
  } finally {
    f.dispose();
  }
});

it("keeps a focused Retry through a purge reread and hands focus to the region on success", async () => {
  const f = fixture();
  try {
    f.query.mockImplementation(async (filters) => {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        throw new Error("Profile unavailable");
      return [];
    });
    // The session's own purge generation, moved by hand: a real purge also
    // empties the directory, which has nothing for this person anyway.
    let purges = 0;
    const listeners = new Set<() => void>();
    const base = f.session.profiles;
    const profiles = {
      ...base,
      generation: () => purges,
      subscribe(listener: () => void) {
        listeners.add(listener);
        const stop = base.subscribe(listener);
        return () => {
          listeners.delete(listener);
          stop();
        };
      },
    };
    const session = { ...f.session, profiles };
    const snapshot = { ...f.relay.snapshot(), session };
    const relay: RelayData = { ...f.relay, snapshot: () => snapshot };
    render(
      <ProfilePanel
        relay={relay}
        target={profileTarget(f.person.pubkey) ?? ""}
        close={() => {}}
      />,
    );
    await screen.findByText("Could not load this profile.");
    const retryButton = screen.getByRole("button", { name: "Retry profile" });
    act(() => retryButton.focus());

    const reads = f.query.mock.calls.length;
    let answer: (() => void) | undefined;
    f.query.mockImplementation((filters) =>
      filters.some((filter) => filter.kinds?.includes(0))
        ? new Promise((resolve) => {
            answer = () => resolve([profile(f.person, { name: "Alice" })]);
          })
        : Promise.resolve([]),
    );
    act(() => {
      purges++;
      for (const listener of listeners) listener();
    });
    await vi.waitFor(() =>
      expect(f.query.mock.calls.length).toBeGreaterThan(reads),
    );
    expect(retryButton).toHaveFocus();
    expect(retryButton).toHaveAttribute("aria-busy", "true");

    await act(async () => answer?.());
    expect(await screen.findByRole("heading", { name: "Alice" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry profile" })).toBeNull();
    expect(
      screen.getByRole("region", { name: "Profile details" }),
    ).toHaveFocus();
  } finally {
    f.dispose();
  }
});
