import { describe, expect, it, vi } from "vitest";
import type { RelayData, RelaySnapshot } from "../relay/service";
import { readyOwnerReads } from "./reads";

const owner = "a".repeat(64);
const agent = { relay: "wss://relay.example", owner, pubkey: "b".repeat(64) };
const ready = (session: object, over: Partial<RelaySnapshot> = {}) =>
  ({
    status: "ready",
    generation: 1,
    origin: "https://relay.example",
    viewer: owner,
    scope: `https://relay.example:${owner}`,
    session,
    ...over,
  }) as unknown as RelaySnapshot;
const connecting = { status: "connecting", generation: 2 } as RelaySnapshot;

/** A community connection whose snapshot the test publishes. */
function community(first: RelaySnapshot) {
  let snapshot = first;
  const listeners = new Set<() => void>();
  const relay = {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  } as unknown as RelayData;
  return {
    relay,
    listeners,
    publish(next: RelaySnapshot) {
      snapshot = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

/** A session listing `channels`, which the test relists. */
function session(
  channels: { id: string; channelType?: string }[] = [],
  status = "ready",
) {
  const listeners = new Set<() => void>();
  return {
    workflowAuthority: "c".repeat(64),
    listeners,
    channels: {
      list: () => ({ status, channels }),
      subscribeList: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    },
    relist(next = channels) {
      status = "ready";
      channels = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

const lost =
  "Workflow request could not start: its community is no longer connected.";

describe("readyOwnerReads", () => {
  it.each([
    ["connecting", connecting],
    ["a cached snapshot", ready(session(), { cached: true })],
  ])(
    "waits through %s for the replacement session's channel list",
    async (_name, first) => {
      const c = community(first);
      const reads = readyOwnerReads(
        c.relay,
        agent,
        new AbortController().signal,
      );
      const settled = vi.fn();
      void reads.then(settled);
      const replacement = session([], "loading");
      c.publish(ready(replacement, { generation: 3 }));
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      replacement.relist();
      expect((await reads).connection).toBe(replacement);
      expect((await reads).workflowAuthority()).toBe("c".repeat(64));
      expect(replacement.listeners.size).toBe(0);
      expect(c.listeners.size).toBe(0);
    },
  );

  it.each([
    [
      "a disconnect",
      { ...connecting, status: "disconnected" } as RelaySnapshot,
    ],
    [
      "another community",
      ready(session(), {
        origin: "https://other.example",
        scope: `https://other.example:${owner}`,
      }),
    ],
  ])("rejects after %s", async (_name, next) => {
    const c = community(connecting);
    const reads = readyOwnerReads(c.relay, agent, new AbortController().signal);
    c.publish(next);
    await expect(reads).rejects.toThrow(lost);
    expect(c.listeners.size).toBe(0);
  });

  it("rejects on the deadline and stops listening", async () => {
    const c = community(connecting);
    const deadline = new AbortController();
    const reads = readyOwnerReads(c.relay, agent, deadline.signal);
    deadline.abort(new DOMException("timed out", "TimeoutError"));
    await expect(reads).rejects.toThrow(
      "Workflow request could not start: its community did not reconnect before the delivery deadline.",
    );
    expect(c.listeners.size).toBe(0);
  });

  it("waits until the destination is listed and typed", async () => {
    const first = session();
    const c = community(ready(first));
    const settled = vi.fn();
    const reads = readyOwnerReads(
      c.relay,
      agent,
      new AbortController().signal,
      "dm",
    );
    void reads.then(settled);
    first.relist([{ id: "dm" }]);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    first.relist([{ id: "dm", channelType: "dm" }]);
    expect((await reads).connection).toBe(first);
    expect(first.listeners.size).toBe(0);
  });

  it("finds a destination the list lacks through the session's get", async () => {
    const live = session();
    const get = vi.fn(() => ({ id: "dm", channelType: "dm" }));
    Object.assign(live.channels, { get });
    const reads = readyOwnerReads(
      community(ready(live)).relay,
      agent,
      new AbortController().signal,
      "dm",
    );
    expect((await reads).connection).toBe(live);
    expect(get).toHaveBeenCalledWith("dm");
  });
});
