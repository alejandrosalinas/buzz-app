// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  emptySync,
  enqueue,
  type PendingOp,
  type SyncState,
} from "../../../features/communities/known-communities";
import type {
  ClientSnapshot,
  KnownCommunities,
} from "../../../features/communities/service";
import type { Host } from "../../../features/host/service";
import { deferred, createTestSession } from "../test-helpers";
import {
  createKnownCommunitiesClient,
  type KnownCommunitiesClient,
  type ListResult,
  type UpdateResult,
} from "./client";
import { startKnownCommunitiesSync } from "./sync";

const viewer = "ab".repeat(32);
const primary = "wss://primary.example";
const secondary = "wss://secondary.example";
const reachError = () => new Error("Couldn’t reach Builderlab.");
const accepted: UpdateResult = { kind: "accepted" };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Settles pending promise chains without moving the fake clock. */
const until = (check: () => void) =>
  vi.waitFor(check, { interval: 0, timeout: 2000 });
/** The pass has failed and its retry is scheduled. */
const retrying = () => until(() => expect(vi.getTimerCount()).toBe(1));
const queued = (...urls: string[]) =>
  urls.reduce((state, url) => enqueue(state, url, false), emptySync());
/** The account service: a set of destinations with idempotent edits. */
function fakeService(...held: string[]) {
  const rows = new Set(held);
  return {
    rows,
    list: (): ListResult => ({ kind: "listed", communities: [...rows] }),
    add(url: string): UpdateResult {
      rows.add(url);
      return accepted;
    },
    remove(url: string): UpdateResult {
      rows.delete(url);
      return accepted;
    },
  };
}

/** The capability as the service provides it: the record, the queue, and the
 * writes back. `apply` keeps only the sync state; membership changes are the
 * service's business and are asserted as the changes handed to it. */
function store(initial: Partial<ClientSnapshot> = {}) {
  let snapshot: ClientSnapshot = {
    status: "ready",
    relayAvailable: true,
    profile: { name: "", picture: "" },
    sync: emptySync(),
    viewer,
    selected: null,
    memberships: [],
    ...initial,
  };
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const apply = vi.fn(async (next: SyncState, _add?: string[]) => {
    snapshot = { ...snapshot, sync: next };
    notify();
  });
  const knownCommunities: KnownCommunities = {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    pending: () => snapshot.sync.outbox,
    apply,
  };
  return {
    knownCommunities,
    apply,
    set(change: Partial<ClientSnapshot>) {
      snapshot = { ...snapshot, ...change };
      notify();
    },
    enqueue(url: string, removed = false) {
      this.set({ sync: enqueue(snapshot.sync, url, removed) });
    },
    outbox: () => snapshot.sync.outbox,
    known: () => snapshot.sync.known,
  };
}
function fakeClient() {
  return {
    list: vi.fn<KnownCommunitiesClient["list"]>(async () => ({
      kind: "listed",
      communities: [],
    })),
    add: vi.fn<KnownCommunitiesClient["add"]>(async () => accepted),
    remove: vi.fn<KnownCommunitiesClient["remove"]>(async () => accepted),
  };
}
/** `arrange` sets the service's answers before the sign-in starts the drain,
 * which reaches the first upload without yielding to the test. */
async function fixture({
  snapshot = {} as Partial<ClientSnapshot>,
  signedIn = true,
  arrange = (_client: ReturnType<typeof fakeClient>) => {},
} = {}) {
  const s = store(snapshot);
  const client = fakeClient();
  arrange(client);
  // Which Builderlab account the next sign-in is for.
  const account = { subject: "user" };
  const session = createTestSession(async () => ({
    revision: "secret",
    account: {
      subject: account.subject,
      email: "a@example.com",
      canUseRemoteAgents: false,
      canUseBuilderlabDecisions: false,
    },
  }));
  const dispose = startKnownCommunitiesSync({
    client,
    session,
    knownCommunities: s.knownCommunities,
  });
  if (signedIn) await session.signIn();
  /** Every edit sent, in order, as the intent it carried. */
  const sent = () =>
    [
      ...client.add.mock.invocationCallOrder,
      ...client.remove.mock.invocationCallOrder,
    ]
      .sort((x, y) => x - y)
      .map((order): PendingOp => {
        const added = client.add.mock.invocationCallOrder.indexOf(order);
        return added >= 0
          ? { url: client.add.mock.calls[added]?.[0] ?? "", removed: false }
          : {
              url:
                client.remove.mock.calls[
                  client.remove.mock.invocationCallOrder.indexOf(order)
                ]?.[0] ?? "",
              removed: true,
            };
      });
  return { ...s, account, client, session, dispose, sent };
}

it("waits for sign-in and a ready identity, then lists, merges and drains", async () => {
  const h = await fixture({
    signedIn: false,
    snapshot: {
      status: "loading",
      memberships: [{ id: "https://primary.example", name: "Primary" }],
      sync: queued(primary),
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(h.client.list).not.toHaveBeenCalled();
  await h.session.signIn();
  // Signed in, but the device record is still loading: nothing to send yet.
  await vi.advanceTimersByTimeAsync(0);
  expect(h.client.list).not.toHaveBeenCalled();
  h.client.list.mockResolvedValueOnce({
    kind: "listed",
    communities: [secondary],
  });
  const op = h.outbox()[0];
  h.set({ status: "ready" });
  await until(() => expect(h.outbox()).toEqual([]));
  expect(h.client.list).toHaveBeenCalledWith(expect.any(AbortSignal));
  // The complete list replaces what is known; the destination saved elsewhere
  // is handed to the service to add, and the queued add keeps its place.
  expect(h.apply).toHaveBeenNthCalledWith(
    1,
    { known: [secondary], outbox: [op], account: "user" },
    [secondary],
  );
  expect(h.client.add).toHaveBeenCalledTimes(1);
  expect(h.client.add).toHaveBeenCalledWith(primary, expect.any(AbortSignal));
  expect(h.client.remove).not.toHaveBeenCalled();
  expect(h.apply).toHaveBeenLastCalledWith({
    known: [secondary, primary],
    outbox: [],
    account: "user",
  });
  h.dispose();
});

it("merges nothing more than once per sign-in, and sends a newly queued intent at once", async () => {
  const h = await fixture();
  await until(() => expect(h.apply).toHaveBeenCalledTimes(1));
  h.enqueue(primary);
  await until(() => expect(h.client.add).toHaveBeenCalledTimes(1));
  expect(h.client.add.mock.calls[0]?.[0]).toBe(primary);
  await until(() => expect(h.known()).toEqual([primary]));
  expect(h.outbox()).toEqual([]);
  h.enqueue(primary, true);
  await until(() => expect(h.client.remove).toHaveBeenCalledTimes(1));
  await until(() => expect(h.known()).toEqual([]));
  expect(h.outbox()).toEqual([]);
  expect(h.client.list).toHaveBeenCalledTimes(1);
  h.dispose();
});

it.each([
  {
    name: "the list route refuses the account",
    arrange: (h: Awaited<ReturnType<typeof fixture>>) =>
      h.client.list.mockResolvedValue({ kind: "forbidden" }),
    requests: 1,
  },
  {
    name: "the list route rejects the request as sent",
    arrange: (h: Awaited<ReturnType<typeof fixture>>) =>
      h.client.list.mockResolvedValue({ kind: "rejected", status: 405 }),
    requests: 1,
  },
  {
    name: "the list cannot be read",
    arrange: (h: Awaited<ReturnType<typeof fixture>>) =>
      h.client.list.mockResolvedValue({ kind: "invalid_response" }),
    requests: 1,
  },
  {
    // Routes not yet deployed.
    name: "the service has no known-communities routes",
    arrange: (h: Awaited<ReturnType<typeof fixture>>) =>
      h.client.list.mockResolvedValue({ kind: "rejected", status: 404 }),
    requests: 1,
  },
  {
    name: "an upload is forbidden",
    arrange: (h: Awaited<ReturnType<typeof fixture>>) =>
      h.client.add.mockResolvedValue({ kind: "forbidden" }),
    requests: 2,
  },
  {
    // A partly routed service halts like one without any route.
    name: "an upload meets no route",
    arrange: (h: Awaited<ReturnType<typeof fixture>>) =>
      h.client.add.mockResolvedValue({ kind: "rejected", status: 404 }),
    requests: 2,
  },
])("halts until the next sign-in when $name", async ({ arrange, requests }) => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const h = await fixture({
    signedIn: false,
    snapshot: { sync: queued(primary) },
  });
  arrange(h);
  await h.session.signIn();
  const calls = () =>
    h.client.list.mock.calls.length +
    h.client.add.mock.calls.length +
    h.client.remove.mock.calls.length;
  await until(() => expect(calls()).toBe(requests));
  await vi.advanceTimersByTimeAsync(0);
  // Halted, not failed: no retry is scheduled, and the device says why.
  expect(vi.getTimerCount()).toBe(0);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]?.[0]).toMatch(
    /^Builderlab (list|add wss:\/\/primary\.example) answered (forbidden|invalid_response|HTTP 40[45]); .* stops until the next sign-in\.$/,
  );
  window.dispatchEvent(new Event("online"));
  h.enqueue(secondary);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(calls()).toBe(requests);
  expect(h.outbox()).toHaveLength(2);
  h.session.signOut();
  h.client.list.mockResolvedValue({ kind: "listed", communities: [] });
  h.client.add.mockResolvedValue(accepted);
  await h.session.signIn();
  await until(() => expect(h.outbox()).toEqual([]));
  h.dispose();
});

it("halts on a 200 list the real client cannot read, forgetting no membership", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const s = store({
    memberships: [{ id: "https://primary.example", name: "Primary" }],
    sync: { known: [primary], outbox: [] },
  });
  const session = createTestSession(
    async () => ({
      revision: "secret",
      account: {
        subject: "user",
        email: "a@example.com",
        canUseRemoteAgents: false,
        canUseBuilderlabDecisions: false,
      },
    }),
    undefined,
    { request: (input) => host.request(input) },
  );
  // A proxy's block page, a truncated or an empty body: a 200 that is no list.
  const host: Host = {
    runCommand: vi.fn(),
    request: vi.fn(async () => ({ status: 200, headers: {}, body: "" })),
  };
  const dispose = startKnownCommunitiesSync({
    client: createKnownCommunitiesClient(session),
    session,
    knownCommunities: s.knownCommunities,
  });
  await session.signIn();
  await until(() => expect(host.request).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(0);
  // Nothing merged: the account was not taken to hold nothing.
  expect(s.apply).not.toHaveBeenCalled();
  expect(s.known()).toEqual([primary]);
  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(host.request).toHaveBeenCalledTimes(1);
  dispose();
});

it("neither lists again nor resends on a trigger once synced, and still sends a new intent", async () => {
  const h = await fixture({ snapshot: { sync: queued(primary) } });
  await until(() => expect(h.outbox()).toEqual([]));
  window.dispatchEvent(new Event("online"));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.client.list).toHaveBeenCalledTimes(1);
  expect(h.client.add).toHaveBeenCalledTimes(1);
  h.enqueue(secondary);
  await until(() => expect(h.client.add).toHaveBeenCalledTimes(2));
  expect(h.client.add.mock.calls[1]?.[0]).toBe(secondary);
  await until(() => expect(h.outbox()).toEqual([]));
  h.dispose();
});

it("keeps syncing when the list left out addresses this device cannot save, and says so once", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const h = await fixture({
    arrange: (client) =>
      client.list.mockResolvedValue({
        kind: "listed",
        communities: [secondary],
        dropped: 2,
      }),
  });
  await until(() => expect(h.apply).toHaveBeenCalledTimes(1));
  expect(h.apply).toHaveBeenCalledWith(
    { known: [secondary], outbox: [], account: "user" },
    [secondary],
  );
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]?.[0]).toContain("2 community address(es)");
  h.dispose();
});

it("uploads one intent at a time, in queue order", async () => {
  const first = deferred<UpdateResult>();
  const h = await fixture({
    snapshot: { sync: queued(primary, secondary) },
    arrange: (client) => client.add.mockReturnValueOnce(first.promise),
  });
  await until(() => expect(h.client.add).toHaveBeenCalledTimes(1));
  expect(h.client.add.mock.calls[0]?.[0]).toBe(primary);
  await vi.advanceTimersByTimeAsync(5000);
  expect(h.client.add).toHaveBeenCalledTimes(1);
  first.resolve(accepted);
  await until(() => expect(h.client.add).toHaveBeenCalledTimes(2));
  expect(h.client.add.mock.calls[1]?.[0]).toBe(secondary);
  await until(() => expect(h.outbox()).toEqual([]));
  h.dispose();
});

it("retries a failed upload with the identical request at doubling delays, capped at a minute", async () => {
  const h = await fixture({
    snapshot: { sync: queued(primary) },
    arrange: (client) => client.add.mockRejectedValue(reachError()),
  });
  await retrying();
  let attempts = 1;
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(h.client.add).toHaveBeenCalledTimes(attempts);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.client.add).toHaveBeenCalledTimes(++attempts);
    expect(h.client.add.mock.calls.at(-1)?.[0]).toBe(primary);
    await retrying();
  }
  // A success resets the backoff for the next failure.
  h.client.add.mockResolvedValueOnce(accepted);
  await vi.advanceTimersByTimeAsync(60000);
  await until(() => expect(h.outbox()).toEqual([]));
  h.enqueue(secondary);
  await until(() =>
    expect(h.client.add.mock.calls.at(-1)?.[0]).toBe(secondary),
  );
  await retrying();
  const count = h.client.add.mock.calls.length;
  await vi.advanceTimersByTimeAsync(999);
  expect(h.client.add).toHaveBeenCalledTimes(count);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.client.add).toHaveBeenCalledTimes(count + 1);
  h.dispose();
});

it("runs again at once when the window comes online or becomes visible, resetting the backoff", async () => {
  const h = await fixture({
    snapshot: { sync: queued(primary) },
    arrange: (client) => client.add.mockRejectedValue(reachError()),
  });
  await retrying();
  expect(h.client.add).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new Event("online"));
  await until(() => expect(h.client.add).toHaveBeenCalledTimes(2));
  // The trigger's own failure starts the backoff over at one second.
  await retrying();
  await vi.advanceTimersByTimeAsync(999);
  expect(h.client.add).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.client.add).toHaveBeenCalledTimes(3);
  await retrying();
  let visibility = "hidden";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility as DocumentVisibilityState,
  );
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(h.client.add).toHaveBeenCalledTimes(3);
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  await until(() => expect(h.client.add).toHaveBeenCalledTimes(4));
  h.dispose();
});

it.each([
  { kind: "invalid_request" } as const,
  { kind: "limit_reached" } as const,
  { kind: "rejected", status: 415 } as const,
])(
  "parks an add the service answers $kind, keeps sending others, and sends the intent that replaces it",
  async (refusal) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = await fixture({
      snapshot: { sync: queued(primary, secondary) },
      arrange: (client) =>
        client.add.mockImplementation(async (url) =>
          url === primary ? refusal : accepted,
        ),
    });
    await until(() =>
      expect(h.outbox()).toEqual([{ url: primary, removed: false }]),
    );
    expect(h.client.add).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe(
      `Builderlab add ${primary} answered ${
        refusal.kind === "rejected" ? "HTTP 415" : refusal.kind
      }; known-communities sync skips it until it is replaced or the next sign-in.`,
    );
    // Triggers and time pass it over, and the same intent queued again is
    // the same request: still parked.
    window.dispatchEvent(new Event("online"));
    h.enqueue(primary);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.client.add).toHaveBeenCalledTimes(2);
    // A fresh intent for another destination still goes.
    h.enqueue(secondary, true);
    await until(() => expect(h.client.remove).toHaveBeenCalledTimes(1));
    expect(h.client.remove.mock.calls[0]?.[0]).toBe(secondary);
    await until(() =>
      expect(h.outbox()).toEqual([{ url: primary, removed: false }]),
    );
    // Leaving the refused community replaces the parked add with a removal,
    // which is a different request and goes out; nothing then remains parked.
    h.enqueue(primary, true);
    await until(() => expect(h.client.remove).toHaveBeenCalledTimes(2));
    expect(h.client.remove.mock.calls[1]?.[0]).toBe(primary);
    await until(() => expect(h.outbox()).toEqual([]));
    h.dispose();
  },
);

it("sends a parked intent again on the next sign-in", async () => {
  const h = await fixture({
    snapshot: { sync: queued(primary) },
    arrange: (client) =>
      client.add.mockResolvedValueOnce({ kind: "limit_reached" }),
  });
  await until(() => expect(h.client.add).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(0);
  expect(h.outbox()).toHaveLength(1);
  h.session.signOut();
  await h.session.signIn();
  await until(() => expect(h.outbox()).toEqual([]));
  expect(h.client.add).toHaveBeenCalledTimes(2);
  h.dispose();
});

it("sends a withdrawn parked intent again when it is queued anew", async () => {
  const h = await fixture({
    snapshot: { sync: queued(primary) },
    arrange: (client) =>
      client.add.mockResolvedValueOnce({ kind: "limit_reached" }),
  });
  await until(() => expect(h.client.add).toHaveBeenCalledTimes(1));
  // Leaving withdraws the parked add; rejoining queues the same add again,
  // which is no longer parked and goes out.
  h.enqueue(primary, true);
  await until(() => expect(h.client.remove).toHaveBeenCalledTimes(1));
  await until(() => expect(h.outbox()).toEqual([]));
  h.enqueue(primary);
  await until(() => expect(h.client.add).toHaveBeenCalledTimes(2));
  await until(() => expect(h.outbox()).toEqual([]));
  expect(h.sent()).toEqual([
    { url: primary, removed: false },
    { url: primary, removed: true },
    { url: primary, removed: false },
  ]);
  h.dispose();
});

it.each([
  { name: "join, lost acknowledgement, leave", first: false },
  { name: "leave, lost acknowledgement, rejoin", first: true },
])(
  "converges on the latest intent after $name: the retry sends only the newer intent",
  async ({ first }) => {
    const service = fakeService(...(first ? [primary] : []));
    const h = await fixture({
      signedIn: false,
      snapshot: {
        memberships: first
          ? [{ id: "https://primary.example", name: "Primary" }]
          : [],
      },
    });
    h.client.list.mockImplementation(async () => service.list());
    let lost = true;
    const edit =
      (apply: (url: string) => UpdateResult) => async (url: string) => {
        const result = apply(url);
        // The service applied it, but its answer never arrived.
        if (lost) {
          lost = false;
          throw reachError();
        }
        return result;
      };
    h.client.add.mockImplementation(edit((url) => service.add(url)));
    h.client.remove.mockImplementation(edit((url) => service.remove(url)));
    await h.session.signIn();
    await until(() => expect(h.apply).toHaveBeenCalledTimes(1));
    h.enqueue(primary, first);
    await retrying();
    expect(service.rows.has(primary)).toBe(!first);
    // The user changes their mind during the backoff: the newer intent
    // replaces the one whose answer was lost, and is what the retry sends.
    h.enqueue(primary, !first);
    await until(() => expect(h.outbox()).toEqual([]));
    expect(h.sent()).toEqual([
      { url: primary, removed: first },
      { url: primary, removed: !first },
    ]);
    expect(service.rows.has(primary)).toBe(first);
    expect(h.known()).toEqual(first ? [primary] : []);
    expect(h.outbox()).toEqual([]);
    // No membership change was ever reported against the user's own change
    // of mind.
    expect(h.apply.mock.calls.flatMap(([, add]) => add ?? [])).toEqual([]);
    h.dispose();
  },
);

it("backs off when the device record will not save, then replays the identical request", async () => {
  const h = await fixture();
  await until(() => expect(h.apply).toHaveBeenCalledTimes(1));
  h.apply.mockRejectedValueOnce(
    new Error("Could not save this community on this device. Try again."),
  );
  h.enqueue(primary);
  await retrying();
  expect(h.client.add).toHaveBeenCalledTimes(1);
  // The service accepted it; only the record did not take the answer. The
  // intent stays, and the idempotent request goes again.
  expect(h.outbox()).toEqual([{ url: primary, removed: false }]);
  await vi.advanceTimersByTimeAsync(999);
  expect(h.client.add).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.client.add).toHaveBeenCalledTimes(2);
  expect(h.client.add.mock.calls[1]?.[0]).toBe(primary);
  await until(() => expect(h.outbox()).toEqual([]));
  expect(h.known()).toEqual([primary]);
  h.dispose();
});

it("keeps an intent queued while the list is in flight: the merge reads the record again", async () => {
  const list = deferred<ListResult>();
  const h = await fixture({ signedIn: false });
  h.client.list.mockReturnValueOnce(list.promise);
  await h.session.signIn();
  await until(() => expect(h.client.list).toHaveBeenCalledTimes(1));
  h.enqueue(primary);
  const op = h.outbox()[0];
  list.resolve({ kind: "listed", communities: [] });
  await until(() => expect(h.outbox()).toEqual([]));
  expect(h.apply).toHaveBeenNthCalledWith(
    1,
    { known: [], outbox: [op], account: "user" },
    [],
  );
  expect(h.client.add).toHaveBeenCalledTimes(1);
  expect(h.client.add.mock.calls[0]?.[0]).toBe(primary);
  expect(h.outbox()).toEqual([]);
  h.dispose();
});

it("follows the account on the next sign-in: a membership never uploaded is sent, one removed elsewhere is kept and not re-sent", async () => {
  const service = fakeService(secondary);
  const h = await fixture({
    signedIn: false,
    snapshot: {
      memberships: [
        { id: "https://primary.example", name: "Primary" },
        { id: "https://secondary.example", name: "Secondary" },
      ],
      sync: { known: [secondary], outbox: [], account: "user" },
    },
  });
  h.client.list.mockImplementation(async () => service.list());
  h.client.add.mockImplementation(async (url) => service.add(url));
  // Another device removed the secondary and added a third community. The
  // removal is ignored for now: the secondary stays saved and known, so only
  // the primary, which the service has never seen, is uploaded.
  service.rows.delete(secondary);
  service.rows.add("wss://third.example");
  await h.session.signIn();
  await until(() => expect(h.outbox()).toEqual([]));
  expect(h.apply).toHaveBeenNthCalledWith(
    1,
    {
      known: [secondary, "wss://third.example"],
      outbox: [{ url: primary, removed: false }],
      account: "user",
    },
    ["wss://third.example"],
  );
  expect(h.sent()).toEqual([{ url: primary, removed: false }]);
  expect(h.known()).toEqual([secondary, "wss://third.example", primary]);
  expect([...service.rows]).toEqual(["wss://third.example", primary]);
  h.dispose();
});

const both = [
  { id: "https://primary.example", name: "Primary" },
  { id: "https://secondary.example", name: "Secondary" },
];

it("keeps what it knows across sign-ins as the same account: a membership removed elsewhere meanwhile is kept, never removed here and never uploaded again", async () => {
  const service = fakeService(primary, secondary);
  const h = await fixture({
    snapshot: { memberships: both },
    arrange: (client) => {
      client.list.mockImplementation(async () => service.list());
      client.add.mockImplementation(async (url) => service.add(url));
    },
  });
  await until(() => expect(h.apply).toHaveBeenCalledTimes(1));
  expect(h.known()).toEqual([primary, secondary]);
  h.session.signOut();
  service.rows.delete(secondary);
  // The sign-in that first reads the shorter list, and the one after it:
  // neither forgets the secondary, and neither re-adds it to the account.
  for (const signIn of [2, 3]) {
    await h.session.signIn();
    // Each sign-in merges once and, with nothing to upload, writes nothing else.
    await until(() => expect(h.apply).toHaveBeenCalledTimes(signIn));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.client.list).toHaveBeenCalledTimes(signIn);
    expect(h.apply).toHaveBeenLastCalledWith(
      { known: [primary, secondary], outbox: [], account: "user" },
      [],
    );
    expect(h.sent()).toEqual([]);
    expect(h.outbox()).toEqual([]);
    expect([...service.rows]).toEqual([primary]);
    expect(h.knownCommunities.snapshot().memberships).toEqual(both);
    h.session.signOut();
  }
  h.dispose();
});

it("reads nothing into another account's sign-in on this device: the first account's communities are uploaded to it, never forgotten", async () => {
  const alice = fakeService(primary, secondary);
  const bob = fakeService();
  let service = alice;
  const h = await fixture({
    snapshot: { memberships: both },
    arrange: (client) => {
      client.list.mockImplementation(async () => service.list());
      client.add.mockImplementation(async (url) => service.add(url));
    },
  });
  await until(() => expect(h.apply).toHaveBeenCalledTimes(1));
  expect(h.known()).toEqual([primary, secondary]);
  h.session.signOut();
  h.account.subject = "bob";
  service = bob;
  await h.session.signIn();
  await until(() =>
    expect(h.knownCommunities.snapshot().sync).toEqual({
      known: [primary, secondary],
      outbox: [],
      account: "bob",
    }),
  );
  // The device record outlived Alice's sign-out, but her list says nothing
  // about Bob's: neither membership was removed elsewhere, and both are ones
  // Bob's account has never seen.
  expect(h.apply).toHaveBeenNthCalledWith(
    2,
    {
      known: [],
      outbox: [
        { url: primary, removed: false },
        { url: secondary, removed: false },
      ],
      account: "bob",
    },
    [],
  );
  expect(h.sent()).toEqual([
    { url: primary, removed: false },
    { url: secondary, removed: false },
  ]);
  expect([...bob.rows]).toEqual([primary, secondary]);
  expect(h.knownCommunities.snapshot().sync).toEqual({
    known: [primary, secondary],
    outbox: [],
    account: "bob",
  });
  h.dispose();
});

it("signing out abandons the upload in flight and keeps the outbox for the next sign-in", async () => {
  const gate = deferred<UpdateResult>();
  const h = await fixture({
    snapshot: { sync: queued(primary) },
    arrange: (client) => client.add.mockReturnValueOnce(gate.promise),
  });
  await until(() => expect(h.client.add).toHaveBeenCalledTimes(1));
  const [, signal] = h.client.add.mock.calls[0] as [string, AbortSignal];
  const op = h.outbox()[0];
  const applied = h.apply.mock.calls.length;
  h.session.signOut();
  expect(signal.aborted).toBe(true);
  gate.resolve(accepted);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.apply).toHaveBeenCalledTimes(applied);
  expect(h.outbox()).toEqual([op]);
  await h.session.signIn();
  await until(() => expect(h.outbox()).toEqual([]));
  // A fresh sign-in reads the list again, then resends.
  expect(h.client.list).toHaveBeenCalledTimes(2);
  expect(h.client.add).toHaveBeenCalledTimes(2);
  expect(h.client.add.mock.calls[1]?.[0]).toBe(primary);
  h.dispose();
});

it("stops without a retry when the service ends the session", async () => {
  const h = await fixture({
    signedIn: false,
    snapshot: { sync: queued(primary) },
  });
  h.client.add.mockImplementation(async () => {
    h.session.signOut();
    throw new DOMException("Builderlab session changed.", "AbortError");
  });
  await h.session.signIn();
  await until(() => expect(h.session.snapshot().status).toBe("signed-out"));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.client.add).toHaveBeenCalledTimes(1);
  expect(h.outbox()).toHaveLength(1);
  h.dispose();
});

it("disposal stops listening", async () => {
  const h = await fixture();
  await until(() => expect(h.apply).toHaveBeenCalledTimes(1));
  h.dispose();
  h.enqueue(primary);
  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.client.add).not.toHaveBeenCalled();
});
