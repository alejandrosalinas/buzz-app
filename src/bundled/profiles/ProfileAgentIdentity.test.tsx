// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { bytesToHex } from "nostr-tools/utils";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { attestedOwner } from "../../features/agents/owner-attestation";
import { profileTarget } from "../../features/profiles/target";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import type { LiveCallbacks } from "../../features/relay/live";
import type { RelayData } from "../../features/relay/service";
import {
  createRelaySession,
  type RelaySession,
} from "../../features/relay/session";
import type {
  HeadPersistence,
  SavedHead,
} from "../../features/relay/persistence";
import {
  bounds,
  keypair,
  type Key,
  message,
  metadata,
  profile,
  roster,
  signed,
} from "../../features/relay/testing";
import { formatPublicKey } from "../../shared/identity/public-key";
import { ProfilePanel } from "./ProfilePanel";

vi.mock("../../features/agents/owner-attestation", async (original) => {
  const actual =
    await original<typeof import("../../features/agents/owner-attestation")>();
  return { attestedOwner: vi.fn(actual.attestedOwner) };
});
const verify = vi.mocked(attestedOwner);
/** Completion barrier: verification of exactly `event` (after call `since`) has
 * finished and React has committed its result. */
async function verifiedFor(event: RelayEvent, since = 0) {
  await waitFor(() =>
    expect(
      verify.mock.calls
        .slice(since)
        .some(([seen]) => (seen as RelayEvent).id === event.id),
    ).toBe(true),
  );
  await act(async () => {
    await Promise.all(
      verify.mock.results.slice(since).map((result) => result.value),
    );
  });
}
const identityRegion = () =>
  screen.queryByRole("region", { name: "Agent identity" });

const relayKey = keypair();
const owners: { dispose(): void }[] = [];
afterEach(() => {
  cleanup();
  verify.mockClear();
  for (const owner of owners.splice(0)) owner.dispose();
});

function auth(agent: Key, owner: Key, sign = owner) {
  const digest = new Uint8Array(
    createHash("sha256").update(`nostr:agent-auth:${agent.pubkey}:`).digest(),
  );
  return [
    "auth",
    owner.pubkey,
    "",
    bytesToHex(schnorr.sign(digest, sign.secret)),
  ];
}
function agentProfile(agent: Key, tags: string[][]) {
  return signed(agent, {
    kind: 0,
    content: JSON.stringify({ name: "Helper" }),
    tags,
  });
}
function mount(
  target: Key,
  respond: (filter: ReadFilter) => RelayEvent[],
  {
    wrap,
    library,
    viewer = keypair().pubkey,
  }: {
    wrap?: (session: RelaySession) => RelaySession;
    library?: string;
    viewer?: string;
  } = {},
) {
  const query = vi.fn(async (filters: readonly ReadFilter[]) =>
    filters.flatMap((filter) => respond(filter)),
  );
  const owner = createRelaySession({
    viewer,
    relayAuthor: relayKey.pubkey,
    scope: "wss://relay.example.test",
    query,
    media: () => undefined,
    ...(library
      ? {
          readAgentLibrary: async () => ({
            definitions: [],
            identities: [{ pubkey: library, name: "Library agent" }],
          }),
        }
      : {}),
    subscribe: () => ({ update() {}, retry() {}, dispose() {} }),
  });
  owners.push(owner);
  if (library) void owner.session.agentLibrary.refresh();
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    viewer,
    session: wrap ? wrap(owner.session) : owner.session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    tryAgain() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const open = vi.fn(() => true);
  render(
    <ProfilePanel
      relay={relay}
      target={profileTarget(target.pubkey) ?? ""}
      close={() => {}}
      context={{ channelId: "c", canOpen: () => true, open }}
    />,
  );
  return { query, open };
}
const kind0 = (filter: ReadFilter) => filter.kinds?.includes(0);

it("shows a verified owner as Managed by with profile ingress", async () => {
  const agent = keypair();
  const owner = keypair();
  const { open } = mount(agent, (filter) =>
    filter.authors?.includes(owner.pubkey)
      ? [profile(owner, { name: "Owner Olivia" })]
      : kind0(filter)
        ? [agentProfile(agent, [auth(agent, owner)])]
        : [],
  );
  const ownerLink = await screen.findByRole("button", {
    name: "Open owner profile: Owner Olivia",
  });
  expect(identityRegion()).toHaveTextContent("Managed byOwner Olivia");
  expect(identityRegion()).not.toHaveTextContent("(you)");
  await userEvent.setup().click(ownerLink);
  expect(open).toHaveBeenCalledWith(profileTarget(owner.pubkey));
});

it("marks the owner as you when the viewer owns the agent", async () => {
  const agent = keypair();
  const owner = keypair();
  mount(
    agent,
    (filter) =>
      filter.authors?.includes(owner.pubkey)
        ? [profile(owner, { name: "Owner Olivia" })]
        : kind0(filter)
          ? [agentProfile(agent, [auth(agent, owner)])]
          : [],
    { viewer: owner.pubkey },
  );
  await screen.findByRole("button", {
    name: "Open owner profile: Owner Olivia (you)",
  });
  expect(identityRegion()).toHaveTextContent("Managed byOwner Olivia (you)");
});

it("does not trust a well-formed attestation with an invalid signature", async () => {
  const agent = keypair();
  const owner = keypair();
  const forged = agentProfile(agent, [auth(agent, owner, keypair())]);
  mount(agent, (filter) => (kind0(filter) ? [forged] : []));
  await verifiedFor(forged);
  expect(identityRegion()).toBeNull();
  expect(screen.queryByRole("button", { name: /owner profile/ })).toBeNull();
});

it("adds no agent section or owner read for a profile without an agent hint", async () => {
  const person = keypair();
  const { query } = mount(person, (filter) =>
    kind0(filter) ? [profile(person, { name: "Person" })] : [],
  );
  await screen.findByRole("heading", { name: "Person" });
  expect(screen.queryByRole("region", { name: "Agent identity" })).toBeNull();
  // Status discovery can race the heading. Wait for those reads,
  // then ensure they did not start observing an owner profile.
  await waitFor(() =>
    expect(query.mock.calls.flatMap(([filters]) => filters)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ authors: [person.pubkey], kinds: [0] }),
        expect.objectContaining({ authors: [person.pubkey], kinds: [30315] }),
      ]),
    ),
  );
  const reads = query.mock.calls.flatMap(([filters]) => filters);
  expect(reads).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        authors: [person.pubkey],
        kinds: [0],
        limit: 1,
      }),
    ]),
  );
});

function timedProfile(
  agent: Key,
  tags: string[][],
  time: number,
  name = "Helper",
) {
  return signed(agent, {
    kind: 0,
    content: JSON.stringify({ name, is_agent: true }),
    tags,
    created_at: time,
  });
}
function live(agent: Key, first: RelayEvent) {
  let latest = first;
  let callbacks!: LiveCallbacks;
  const query = vi.fn(async (filters: readonly ReadFilter[]) =>
    filters.flatMap((filter) =>
      kind0(filter) && filter.authors?.includes(agent.pubkey) ? [latest] : [],
    ),
  );
  const viewer = keypair().pubkey;
  const owner = createRelaySession({
    viewer,
    relayAuthor: relayKey.pubkey,
    scope: "wss://relay.example.test",
    query,
    media: () => undefined,
    subscribe: (next) => {
      callbacks = next;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  owners.push(owner);
  const snapshot = {
    status: "ready" as const,
    generation: 1,
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
  const props = {
    relay,
    target: profileTarget(agent.pubkey) ?? "",
    close() {},
    context: { channelId: "c", canOpen: () => true, open: () => true },
  };
  let mounted = render(<ProfilePanel {...props} />);
  return {
    session: owner.session,
    viewer,
    query,
    receive: (...events: RelayEvent[]) =>
      act(async () => {
        callbacks.receive(events);
      }),
    close() {
      mounted.unmount();
    },
    open() {
      mounted = render(<ProfilePanel {...props} />);
    },
    setLatest(event: RelayEvent) {
      latest = event;
    },
    reopen() {
      mounted.unmount();
      render(<ProfilePanel {...props} />);
    },
    rerender() {
      mounted.rerender(<ProfilePanel {...props} />);
    },
  };
}
const ownerButton = (owner: Key) => ({
  name: `Open owner profile: ${formatPublicKey(owner.pubkey)}`,
});
const agentReads = (query: ReturnType<typeof live>["query"]) =>
  query.mock.calls.filter(([filters]) =>
    filters.some((filter) => filter.kinds?.includes(0)),
  ).length;

it.each(["remove", "duplicate", "replace"])(
  "follows the current signed profile after an auth-only %s",
  async (mode) => {
    const agent = keypair();
    const a = keypair();
    const b = keypair();
    const h = live(agent, timedProfile(agent, [auth(agent, a)], 100));
    await screen.findByRole("button", ownerButton(a));
    const before = h.session.profiles.snapshot().get(agent.pubkey);
    const tags =
      mode === "remove"
        ? []
        : mode === "duplicate"
          ? [auth(agent, a), auth(agent, a)]
          : [auth(agent, b)];
    const next = timedProfile(agent, tags, 101);
    h.setLatest(next);
    await h.receive(next);
    // A duplicate keeps the projected owner, so only event provenance can drive it.
    if (mode === "duplicate")
      expect(h.session.profiles.snapshot().get(agent.pubkey)).toBe(before);
    h.rerender();
    if (mode === "replace") await screen.findByRole("button", ownerButton(b));
    else {
      await verifiedFor(next);
      expect(identityRegion()).toBeNull();
    }
    expect(screen.queryByRole("button", ownerButton(a))).toBeNull();
  },
);

it("does not resurrect older provenance from a lagging finite read", async () => {
  const agent = keypair();
  const a = keypair();
  const h = live(agent, timedProfile(agent, [auth(agent, a)], 100));
  await screen.findByRole("button", ownerButton(a));
  // Live knows the newer profile; the finite replica still serves the older head.
  const renamed = timedProfile(agent, [], 101, "Renamed");
  await h.receive(renamed);
  await screen.findByRole("heading", { name: "Renamed" });
  await verifiedFor(renamed);
  expect(identityRegion()).toBeNull();
  expect(screen.queryByRole("button", ownerButton(a))).toBeNull();
});

it("uses the lower event id between equal-time profiles", async () => {
  const agent = keypair();
  const a = keypair();
  const b = keypair();
  const first = timedProfile(agent, [auth(agent, a)], 100);
  const second = timedProfile(agent, [auth(agent, b)], 100);
  const [low, high] = first.id < second.id ? [first, second] : [second, first];
  const [winner, loser] = low === first ? [a, b] : [b, a];
  const h = live(agent, high);
  await screen.findByRole("button", ownerButton(loser));
  await h.receive(low);
  await screen.findByRole("button", ownerButton(winner));
  await h.receive(high);
  h.rerender();
  expect(screen.getByRole("button", ownerButton(winner))).toBeInTheDocument();
  expect(screen.queryByRole("button", ownerButton(loser))).toBeNull();
});

it("shows no owner for a known agent with no public profile", async () => {
  const agent = keypair();
  const owner = createRelaySession({
    viewer: keypair().pubkey,
    relayAuthor: relayKey.pubkey,
    scope: "wss://relay.example.test",
    query: async () => [],
    media: () => undefined,
    readAgentLibrary: async () => ({
      definitions: [],
      identities: [{ pubkey: agent.pubkey, name: "Unpublished agent" }],
    }),
    subscribe: () => ({ update() {}, retry() {}, dispose() {} }),
  });
  owners.push(owner);
  await owner.session.agentLibrary.refresh();
  let observed: ReturnType<RelaySession["observe"]> | undefined;
  const session: RelaySession = Object.create(owner.session, {
    observe: {
      value: (filters: readonly ReadFilter[]) => {
        observed = owner.session.observe(filters);
        return observed;
      },
    },
  });
  const snapshot = { status: "ready" as const, generation: 1, session };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    tryAgain() {},
    disconnect() {},
    clearCache: async () => {},
  };
  render(
    <StrictMode>
      <ProfilePanel
        relay={relay}
        target={profileTarget(agent.pubkey) ?? ""}
        close={() => {}}
      />
    </StrictMode>,
  );
  await waitFor(() => expect(observed?.snapshot().status).toBe("ready"));
  expect(observed?.snapshot().events).toHaveLength(0);
  await act(async () => {});
  expect(identityRegion()).toBeNull();
  expect(verify).not.toHaveBeenCalled();
});

it("keeps the newer signed head after closing, cache eviction and a stale reopen read", async () => {
  const agent = keypair();
  const a = keypair();
  const sender = keypair();
  const h = live(agent, timedProfile(agent, [auth(agent, a)], 100));
  await screen.findByRole("button", ownerButton(a));
  // The relay keeps serving the older attested head; live saw its removal.
  await h.receive(roster(relayKey, "c", [h.viewer, sender.pubkey]));
  const removed = timedProfile(agent, [], 101);
  await h.receive(removed);
  await verifiedFor(removed);
  expect(identityRegion()).toBeNull();
  h.close();
  // Churn the session's 8 MiB recent-event cache past the t=101 profile.
  for (let batch = 0; batch < 9; batch++)
    await h.receive(
      ...Array.from({ length: 80 }, (_, index) =>
        signed(sender, {
          kind: 9,
          created_at: 200 + batch * 80 + index,
          content: "x".repeat(12000),
          tags: [["h", "c"]],
        }),
      ),
    );
  const probe = h.session.observe([
    { kinds: [0], authors: [agent.pubkey], limit: 1 },
  ]);
  expect(probe.snapshot().events).toHaveLength(0);
  probe.dispose();
  const reads = agentReads(h.query);
  const since = verify.mock.calls.length;
  h.open();
  // The reopened view's read returns the stale t=100 attested profile.
  await waitFor(() => expect(agentReads(h.query)).toBeGreaterThan(reads));
  await act(async () => {});
  await verifiedFor(removed, since);
  expect(identityRegion()).toBeNull();
  expect(screen.queryByRole("button", ownerButton(a))).toBeNull();
});

it("shows no owner without a relay view even when the directory holds a head", async () => {
  const agent = keypair();
  const owner = keypair();
  mount(
    agent,
    (filter) =>
      kind0(filter) ? [agentProfile(agent, [auth(agent, owner)])] : [],
    {
      wrap: (session) =>
        Object.create(session, {
          observe: {
            value: () => {
              throw new Error("Relay view capacity unavailable");
            },
          },
        }),
    },
  );
  await screen.findByRole("heading", { name: "Helper" });
  await act(async () => {});
  // No view can signal an auth-only removal, so the directory head is not trusted here.
  expect(identityRegion()).toBeNull();
  expect(verify).not.toHaveBeenCalled();
});

it("follows an auth-only head restored from disk while the pane is mounted", async () => {
  const agent = keypair();
  const a = keypair();
  const viewer = keypair();
  const attested = timedProfile(agent, [auth(agent, a)], 100);
  // Same owner key, forged signature: the displayed profile is identical, so only
  // the directory's winning-event notification can drive the pane.
  const removed = timedProfile(agent, [auth(agent, a, keypair())], 101);
  let releaseDisk!: (records: SavedHead[]) => void;
  const disk = new Promise<SavedHead[]>((resolve) => {
    releaseDisk = resolve;
  });
  let readStarted!: () => void;
  const reading = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  const persistence: HeadPersistence = {
    read: () => {
      readStarted();
      return disk;
    },
    write: async () => {},
    retain: async () => {},
    remove: async () => {},
    clear: async () => {},
    close() {},
  };
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relayKey.pubkey,
      scope: "wss://relay.example.test",
      // The relay keeps serving the older, owner-attested profile.
      query: async (filters: readonly ReadFilter[]) =>
        filters.some((filter) => filter.kinds?.includes(39002))
          ? [
              roster(relayKey, "a", [viewer.pubkey]),
              metadata(relayKey, "a", "A"),
            ]
          : filters.some(
                (filter) =>
                  kind0(filter) && filter.authors?.includes(agent.pubkey),
              )
            ? [attested]
            : [],
      media: () => undefined,
      subscribe: () => ({ update() {}, retry() {}, dispose() {} }),
    },
    { prepared: true, persistence },
  );
  owners.push(owner);
  const connection = {
    status: "ready" as const,
    generation: 1,
    session: owner.session,
  };
  const relay: RelayData = {
    snapshot: () => connection,
    subscribe: () => () => {},
    retry() {},
    tryAgain() {},
    disconnect() {},
    clearCache: async () => {},
  };
  owner.session.channels.ensureList();
  await reading;
  render(
    <ProfilePanel
      relay={relay}
      target={profileTarget(agent.pubkey) ?? ""}
      close={() => {}}
      context={{ channelId: "a", canOpen: () => true, open: () => true }}
    />,
  );
  await screen.findByRole("button", ownerButton(a));
  releaseDisk([
    {
      channelId: "a",
      savedAt: Date.now(),
      events: [
        message(agent, "a", "hi", 90),
        bounds(relayKey, "a", "head", { has_more: false, next_cursor: null }),
      ],
      profiles: [removed],
    },
  ]);
  await verifiedFor(removed);
  expect(identityRegion()).toBeNull();
  expect(owner.session.profiles.event?.(agent.pubkey)?.id).toBe(removed.id);
  expect(screen.queryByRole("button", ownerButton(a))).toBeNull();
});

it.each(["remove", "replace", "equal-time removal"])(
  "shows no owner at the real view cap through an auth-only %s, then a reopen recovers",
  async (mode) => {
    const agent = keypair();
    const a = keypair();
    const b = keypair();
    let first = timedProfile(agent, [auth(agent, a)], 100);
    let next = timedProfile(
      agent,
      mode === "replace" ? [auth(agent, b)] : [],
      101,
    );
    if (mode === "equal-time removal")
      // Both ids are uniform hashes, so redrawing both halves the miss chance
      // each round. Redrawing only `next` against a fixed `first` left a
      // 1/(k+1) tail of synchronous signing that once blocked a CI worker
      // for 19 s. `first` gets a new id each round only because schnorr
      // signing draws fresh auxiliary randomness for its auth tag.
      for (let nonce = 0; ; nonce++) {
        if (nonce === 64)
          throw new Error(
            "No lower-id equal-time removal in 64 rounds: auth() signatures no longer vary",
          );
        next = timedProfile(agent, [["nonce", String(nonce)]], 100);
        if (next.id < first.id) break;
        first = timedProfile(agent, [auth(agent, a)], 100);
      }
    const h = live(agent, first);
    await screen.findByRole("button", ownerButton(a));
    h.close();
    const fillers: ReturnType<RelaySession["observe"]>[] = [];
    try {
      for (;;) fillers.push(h.session.observe([{ kinds: [1], limit: 1 }]));
    } catch {}
    const atCap = verify.mock.calls.length;
    try {
      h.open();
      // Without a view nothing is verified, so no owner can appear later either.
      const empty = async () => {
        await screen.findByRole("heading", { name: "Helper" });
        await act(async () => {});
        expect(identityRegion()).toBeNull();
        expect(verify.mock.calls.length).toBe(atCap);
      };
      await empty();
      // The relay keeps serving the older attested head; live delivers the change.
      await h.receive(next);
      expect(h.session.profiles.event?.(agent.pubkey)?.id).toBe(next.id);
      await empty();
      h.close();
      h.open();
      await empty();
      fillers.pop()?.dispose();
      h.close();
      const since = verify.mock.calls.length;
      h.open();
      if (mode === "replace") await screen.findByRole("button", ownerButton(b));
      else {
        await verifiedFor(next, since);
        expect(identityRegion()).toBeNull();
      }
      expect(screen.queryByRole("button", ownerButton(a))).toBeNull();
      // The recovered view keeps following later auth-only changes.
      const later = timedProfile(agent, [], 102);
      await h.receive(later);
      await verifiedFor(later, since);
      expect(identityRegion()).toBeNull();
    } finally {
      for (const filler of fillers) filler.dispose();
    }
  },
);
