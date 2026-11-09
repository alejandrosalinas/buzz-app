import { expect, it, vi } from "vitest";
import { createAgentLibrary, type AgentLibrary } from "./library";
import { combineInventory } from "./inventory";
import { createRelaySession } from "../relay/session";
import { keypair, metadata, roster } from "../relay/testing";
const library: AgentLibrary = {
  definitions: [
    { id: "brain", name: "Brain" },
    { id: "other", name: "Brain" },
  ],
  identities: [
    { pubkey: "a".repeat(64), name: "Brain", definitionId: "brain" },
    { pubkey: "b".repeat(64), name: "Brain", definitionId: "brain" },
    { pubkey: "c".repeat(64), name: "Custom" },
    { pubkey: "d".repeat(64), name: "Other setup", definitionId: "unselected" },
  ],
};
it("lazy fresh reads replace, fail visibly, retry, and fence late results", async () => {
  const read = vi.fn().mockResolvedValue(library);
  const owner = createAgentLibrary(read);
  expect(read).not.toHaveBeenCalled();
  await owner.queries.refresh();
  expect(owner.queries.snapshot().identities).toHaveLength(4);
  read.mockRejectedValueOnce(new Error("private error"));
  await owner.queries.refresh();
  expect(owner.queries.snapshot().status).toBe("error");
  expect(JSON.stringify(owner.queries.snapshot())).not.toContain(
    "private error",
  );
  await owner.queries.refresh();
  expect(owner.queries.snapshot().status).toBe("ready");
  let release!: (value: AgentLibrary) => void;
  read.mockImplementationOnce(
    () =>
      new Promise<AgentLibrary>((resolve) => {
        release = resolve;
      }),
  );
  const pending = owner.queries.refresh();
  expect(owner.queries.snapshot().identities).toEqual(library.identities);
  await Promise.resolve();
  owner.clear();
  release(library);
  await pending;
  expect(owner.queries.snapshot().status).toBe("idle");
  owner.dispose();
  expect(owner.queries.snapshot().identities).toEqual([]);
});
it.each([false, true])(
  "session establishment reuses inventory with a pending read=%s and refreshes after disconnect",
  async (pendingRead) => {
    vi.useFakeTimers();
    let live!: import("../relay/live").LiveCallbacks;
    let release!: (value: AgentLibrary) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<AgentLibrary>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(library);
    const viewer = keypair(),
      relay = keypair();
    const events = [
      roster(relay, "channel", [viewer.pubkey]),
      metadata(relay, "channel", "Channel"),
    ];
    const owner = createRelaySession({
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query: async (filters) =>
        events.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      readAgentLibrary: read,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, prioritize() {}, retry() {}, dispose() {} };
      },
    });
    const stop = owner.session.agentLibrary.retain();
    try {
      const pending = owner.session.agentLibrary.refresh();
      await Promise.resolve();
      if (!pendingRead) {
        release(library);
        await pending;
      }
      live.state({ status: "connected", routes: [] });
      live.established();
      await vi.advanceTimersByTimeAsync(0);
      if (pendingRead) {
        release(library);
        await pending;
      }
      expect(read).toHaveBeenCalledTimes(1);
      expect(owner.session.agentLibrary.snapshot().status).toBe("ready");
      expect(owner.session.channels.list().channels).toHaveLength(1);
      // Signed channel access loss still removes the channel, not host-local names.
      live.receive([roster(relay, "channel", [], 1_700_000_001)]);
      expect(owner.session.channels.list().channels).toHaveLength(0);
      expect(owner.session.agentLibrary.snapshot().identities).toEqual(
        combineInventory(library, { definitions: [], identities: [] })
          .identities,
      );
      live.state({ status: "retrying", routes: [] });
      expect(owner.session.agentLibrary.snapshot().status).toBe("idle");
      live.state({ status: "connected", routes: [] });
      live.established();
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledTimes(2);
      expect(owner.session.agentLibrary.snapshot().status).toBe("ready");
      stop();
      live.state({ status: "retrying", routes: [] });
      live.state({ status: "connected", routes: [] });
      live.established();
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      release(library);
      stop();
      owner.dispose();
      vi.useRealTimers();
    }
  },
);

it("establishment retries a failed retained read without turning idle inventory into demand", async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(library);
  const owner = createAgentLibrary(read);
  owner.reconnect();
  await Promise.resolve();
  expect(read).not.toHaveBeenCalled();
  const stop = owner.queries.retain();
  await owner.queries.refresh();
  expect(owner.queries.snapshot().status).toBe("error");
  owner.reconnect();
  await owner.queries.refresh();
  expect(read).toHaveBeenCalledTimes(2);
  expect(owner.queries.snapshot().status).toBe("ready");
  stop();
  owner.dispose();
});

it("establishment rereads a retained partial result, and leaves a complete one", async () => {
  const partial = { ...library, error: "Relay inventory unavailable" };
  const read = vi
    .fn()
    .mockResolvedValueOnce(partial)
    .mockResolvedValue(library);
  const owner = createAgentLibrary(read);
  const stop = owner.queries.retain();
  await owner.queries.refresh();
  expect(owner.queries.snapshot()).toMatchObject({
    status: "ready",
    error: "Relay inventory unavailable",
  });
  owner.reconnect();
  await vi.waitFor(() =>
    expect(owner.queries.snapshot()).toMatchObject({ status: "ready" }),
  );
  expect(read).toHaveBeenCalledTimes(2);
  expect(owner.queries.snapshot().error).toBeUndefined();
  owner.reconnect();
  expect(owner.queries.snapshot().status).toBe("ready");
  expect(read).toHaveBeenCalledTimes(2);
  stop();
  owner.dispose();
});

it("establishment reuses a read in flight and rereads once if it ends partial", async () => {
  let finish!: (value: AgentLibrary) => void;
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<AgentLibrary>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(library);
  const owner = createAgentLibrary(read);
  const stop = owner.queries.retain();
  const early = owner.queries.refresh();
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  owner.reconnect();
  // The early read ends partial after establishment; it must not stick.
  const partial = { ...library, error: "Relay inventory unavailable" };
  finish(partial);
  await early;
  await vi.waitFor(() => {
    const { status, error } = owner.queries.snapshot();
    expect([status, error]).toEqual(["ready", undefined]);
  });
  expect(read).toHaveBeenCalledTimes(2);
  owner.reconnect();
  expect(owner.queries.snapshot().status).toBe("ready");
  expect(read).toHaveBeenCalledTimes(2);
  stop();
  owner.dispose();
});

it("a read joined at establishment does not reread after a disconnect clears it", async () => {
  let finish!: (value: AgentLibrary) => void;
  let finishLater!: (value: AgentLibrary) => void;
  const partial = { ...library, error: "Relay inventory unavailable" };
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<AgentLibrary>((resolve) => {
          finish = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<AgentLibrary>((resolve) => {
          finishLater = resolve;
        }),
    )
    .mockResolvedValue(library);
  const owner = createAgentLibrary(read);
  const stop = owner.queries.retain();
  void owner.queries.refresh();
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  owner.reconnect();
  // A disconnect clears it; a new read starts before the next connection.
  owner.clear();
  finish(library);
  const later = owner.queries.refresh();
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  finishLater(partial);
  await later;
  await Promise.resolve();
  expect(owner.queries.snapshot()).toMatchObject({ status: "ready" });
  expect(read).toHaveBeenCalledTimes(2);
  stop();
  owner.dispose();
});

it("every library snapshot carries definition art to identities without their own", async () => {
  const owner = createAgentLibrary(async () => ({
    definitions: [{ id: "local:brain", name: "Brain", avatar: "art" }],
    identities: [
      { pubkey: "a".repeat(64), name: "One", definitionId: "local:brain" },
      {
        pubkey: "b".repeat(64),
        name: "Two",
        definitionId: "local:brain",
        avatar: "own",
      },
      { pubkey: "c".repeat(64), name: "Custom" },
    ],
  }));
  await owner.queries.refresh();
  expect(owner.queries.snapshot().identities.map((row) => row.avatar)).toEqual([
    "art",
    "own",
    undefined,
  ]);
});

it("a fresh refresh supersedes a read in flight, and its waiters wait for the new one", async () => {
  const reads: ((rows: string[]) => void)[] = [];
  const library = createAgentLibrary(
    (signal) =>
      new Promise((resolve) => {
        reads.push((rows) => {
          if (!signal.aborted)
            resolve({
              definitions: [],
              identities: rows.map((pubkey) => ({ pubkey, name: pubkey })),
            });
          else resolve({ definitions: [], identities: [] });
        });
      }),
  );
  let joinedDone = false;
  const joined = library.queries.refresh().then(() => {
    joinedDone = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  const fresh = library.queries.refresh({ fresh: true });
  await Promise.resolve();
  await Promise.resolve();
  // The stale read settles first; it publishes nothing and its waiter waits.
  reads[0]?.(["stale"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(joinedDone).toBe(false);
  expect(library.queries.snapshot().status).toBe("loading");
  reads[1]?.(["current"]);
  await Promise.all([joined, fresh]);
  expect(library.queries.snapshot()).toMatchObject({
    status: "ready",
    identities: [{ pubkey: "current" }],
  });
});
