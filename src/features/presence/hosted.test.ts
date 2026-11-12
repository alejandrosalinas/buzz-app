import { afterEach, expect, it, vi } from "vitest";
import type { EventData, ReadFilter } from "../relay/events";
import type { PresenceActivity } from "./activity";
import { createHostedAgents, withHostedAgents } from "./hosted";
import { createPresence, type Presence } from "./presence";

const key = (n: number) => n.toString(16).padStart(64, "0");
const AGENT = key(10);
const OWNER = key(20);
const STRANGER = key(30);
const REMOTE = "example.remote/hosted";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

let ids = 0;
function record(
  author: string,
  agent: string,
  runtime: string,
  created_at = 100,
): EventData {
  return {
    id: (++ids).toString(16).padStart(64, "0"),
    pubkey: author,
    kind: 30177,
    created_at,
    content: "{}",
    tags: [
      ["d", agent],
      ["runtime", runtime],
    ],
    sig: "",
  } as EventData;
}

/** The real demand window with no relay behind it: it reads nothing and
 * shows everyone unknown, but admits and limits subjects as in production. */
const observing = () =>
  createPresence(
    null,
    undefined,
    async () => false,
    (listener) => listener(),
  );

function setup(
  events: EventData[],
  owners = new Map([[AGENT, OWNER]]),
  observed?: Presence,
) {
  vi.useFakeTimers();
  const ownerListeners = new Set<() => void>();
  const activityListeners = new Set<() => void>();
  let visible = true;
  const activity: PresenceActivity = {
    visible: () => visible,
    status: () => "online",
    subscribe(listener) {
      activityListeners.add(listener);
      return () => {
        activityListeners.delete(listener);
      };
    },
    dispose() {},
  };
  const read = vi.fn(
    async (filters: readonly ReadFilter[], _signal: AbortSignal) => {
      // The production reader's limits (reader.ts).
      if (!filters.length || filters.length > 4)
        throw new Error("A read needs 1–4 filters");
      if (filters.some((filter) => filter.limit < 1 || filter.limit > 500))
        throw new Error("Relay read limit must be between 1 and 500");
      return events.filter((event) =>
        filters.some(
          (filter) =>
            filter.authors?.includes(event.pubkey) &&
            filter["#d"]?.includes(
              event.tags.find((tag) => tag[0] === "d")?.[1] ?? "",
            ),
        ),
      );
    },
  );
  /** Observed presence that shows everyone offline and limits no one. */
  const base =
    observed ??
    ({
      status: () => "offline" as const,
      limited: () => false,
      subscribeSelection: () => () => {},
      subscribe: () => () => {},
      connected: () => {},
      clear: () => {},
      refresh: () => {},
      dispose: () => {},
    } satisfies Presence);
  const presence = withHostedAgents(
    base,
    createHostedAgents({
      owner: (pubkey) => owners.get(pubkey),
      subscribeOwners(listener) {
        ownerListeners.add(listener);
        return () => ownerListeners.delete(listener);
      },
      limited: base.limited,
      subscribeSelection: base.subscribeSelection,
      activity,
      read,
      notify: (listener) => listener(),
    }),
  );
  presence.connected(true);
  presence.remoteRuntimes?.([REMOTE]);
  return {
    presence,
    read,
    owners,
    ownersChanged: () => {
      for (const listener of ownerListeners) listener();
    },
    hide() {
      visible = false;
      for (const listener of activityListeners) listener();
    },
    show() {
      visible = true;
      for (const listener of activityListeners) listener();
    },
  };
}
/** When each read started, relative to the start of the test. */
function timing(t: ReturnType<typeof setup>, failing: (n: number) => boolean) {
  const start = Date.now();
  const times: number[] = [];
  const real = t.read.getMockImplementation();
  t.read.mockImplementation(async (filters, signal) => {
    times.push(Date.now() - start);
    if (failing(times.length)) throw new Error("offline");
    return (await real?.(filters, signal)) ?? [];
  });
  return times;
}

it("shows an agent its attested owner records as remote online, whatever presence says", async () => {
  const t = setup([record(OWNER, AGENT, REMOTE)]);
  const listener = vi.fn();
  t.presence.subscribe(AGENT, listener);
  expect(t.presence.status(AGENT)).toBe("offline");
  await vi.advanceTimersByTimeAsync(100);
  expect(t.read).toHaveBeenCalledWith(
    [{ kinds: [30177], authors: [OWNER], "#d": [AGENT], limit: 1 }],
    expect.any(AbortSignal),
  );
  expect(t.presence.status(AGENT)).toBe("online");
  expect(listener).toHaveBeenCalled();
});

it("ignores a remote record signed by anyone but the attested owner", async () => {
  const t = setup([record(STRANGER, AGENT, REMOTE)]);
  // Even a read that returns the forged record must not count it.
  t.read.mockResolvedValue([record(STRANGER, AGENT, REMOTE)]);
  t.presence.subscribe(AGENT, () => {});
  await vi.advanceTimersByTimeAsync(100);
  expect(t.read).toHaveBeenCalled();
  expect(t.presence.status(AGENT)).toBe("offline");
});

it("keeps observed presence for local agents and agents without an attested owner", async () => {
  const human = key(40);
  const t = setup([
    record(OWNER, AGENT, "example.local/harness"),
    record(OWNER, human, REMOTE),
  ]);
  t.presence.subscribe(AGENT, () => {});
  t.presence.subscribe(human, () => {});
  await vi.advanceTimersByTimeAsync(100);
  expect(t.presence.status(AGENT)).toBe("offline");
  expect(t.presence.status(human)).toBe("offline");
});

it("follows the owner's newest record of the agent", async () => {
  const t = setup([
    record(OWNER, AGENT, REMOTE, 100),
    record(OWNER, AGENT, "example.local/harness", 200),
  ]);
  t.presence.subscribe(AGENT, () => {});
  await vi.advanceTimersByTimeAsync(100);
  expect(t.presence.status(AGENT)).toBe("offline");
});

it("reads once an owner is attested and again when the record is gone", async () => {
  const events = [record(OWNER, AGENT, REMOTE)];
  const t = setup(events, new Map());
  t.presence.subscribe(AGENT, () => {});
  await vi.advanceTimersByTimeAsync(100);
  expect(t.read).not.toHaveBeenCalled();
  t.owners.set(AGENT, OWNER);
  t.ownersChanged();
  await vi.advanceTimersByTimeAsync(100);
  expect(t.presence.status(AGENT)).toBe("online");
  // Deleting the agent deletes its record; the next refresh drops it.
  events.length = 0;
  await vi.advanceTimersByTimeAsync(6 * 60_000);
  expect(t.presence.status(AGENT)).toBe("offline");
});

it("tells subscribers when an online agent's attested owner is removed or replaced", async () => {
  const t = setup([record(OWNER, AGENT, REMOTE)]);
  const listener = vi.fn();
  t.presence.subscribe(AGENT, listener);
  await vi.advanceTimersByTimeAsync(100);
  expect(t.presence.status(AGENT)).toBe("online");
  // The directory has already changed when it tells the tracker.
  listener.mockClear();
  t.owners.delete(AGENT);
  t.ownersChanged();
  expect(listener).toHaveBeenCalledTimes(1);
  expect(t.presence.status(AGENT)).toBe("offline");
  // The owner's evidence is kept, so attesting it again needs no read.
  listener.mockClear();
  t.owners.set(AGENT, OWNER);
  t.ownersChanged();
  expect(listener).toHaveBeenCalledTimes(1);
  expect(t.presence.status(AGENT)).toBe("online");
  expect(t.read).toHaveBeenCalledTimes(1);
  // A replacement owner with no record: the badge drops at once, and the
  // read that confirms it finds nothing new to tell.
  listener.mockClear();
  t.owners.set(AGENT, STRANGER);
  t.ownersChanged();
  expect(listener).toHaveBeenCalledTimes(1);
  expect(t.presence.status(AGENT)).toBe("offline");
  await vi.advanceTimersByTimeAsync(100);
  expect(t.read).toHaveBeenCalledTimes(2);
  expect(t.read.mock.calls[1]?.[0][0]?.authors).toEqual([STRANGER]);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(t.presence.status(AGENT)).toBe("offline");
});

it("shows nothing remote before the runtimes are known", async () => {
  const t = setup([record(OWNER, AGENT, REMOTE)]);
  t.presence.remoteRuntimes?.([]);
  t.presence.subscribe(AGENT, () => {});
  await vi.advanceTimersByTimeAsync(100);
  expect(t.read).not.toHaveBeenCalled();
  expect(t.presence.status(AGENT)).toBe("offline");
  t.presence.remoteRuntimes?.([REMOTE]);
  await vi.advanceTimersByTimeAsync(100);
  expect(t.presence.status(AGENT)).toBe("online");
});

it("keeps prior evidence when a refresh fails", async () => {
  const t = setup([record(OWNER, AGENT, REMOTE)]);
  t.presence.subscribe(AGENT, () => {});
  await vi.advanceTimersByTimeAsync(100);
  expect(t.presence.status(AGENT)).toBe("online");
  t.read.mockRejectedValueOnce(new Error("offline"));
  await vi.advanceTimersByTimeAsync(6 * 60_000);
  expect(t.read).toHaveBeenCalledTimes(2);
  expect(t.presence.status(AGENT)).toBe("online");
});

it("retries a failed read after a minute, not on every profile change", async () => {
  const t = setup([record(OWNER, AGENT, REMOTE)]);
  const times = timing(t, (n) => n === 1);
  t.presence.subscribe(AGENT, () => {});
  await vi.advanceTimersByTimeAsync(100);
  expect(times).toEqual([100]);
  for (let n = 0; n < 5; n++) {
    t.ownersChanged();
    t.presence.subscribe(key(50 + n), () => {});
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(times).toEqual([100]);
  await vi.advanceTimersByTimeAsync(66_000);
  expect(times).toHaveLength(2);
  expect(t.presence.status(AGENT)).toBe("online");
});

it("waits longer after each failure in a row, and a success resets the wait", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const t = setup([record(OWNER, AGENT, REMOTE)]);
  // Three failures, a success, then the next refresh fails again.
  const times = timing(t, (n) => n <= 3 || n === 5);
  t.presence.subscribe(AGENT, () => {});
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(times.length).toBeGreaterThanOrEqual(6);
  const waits = times.slice(1, 6).map((at, n) => at - (times[n] ?? 0));
  expect(waits.slice(0, 3)).toEqual([60_000, 120_000, 240_000]);
  expect(waits[2]).toBeGreaterThan(waits[1] ?? 0);
  expect(waits[1]).toBeGreaterThan(waits[0] ?? 0);
  // The success is followed by an ordinary refresh; its failure starts over.
  expect(waits[3]).toBe(5 * 60_000);
  expect(waits[4]).toBe(60_000);
  expect(t.presence.status(AGENT)).toBe("online");
});

it("caps the wait between retries", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const t = setup([record(OWNER, AGENT, REMOTE)]);
  const times = timing(t, () => true);
  t.presence.subscribe(AGENT, () => {});
  await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);
  const waits = times.slice(1).map((at, n) => at - (times[n] ?? 0));
  expect(Math.max(...waits)).toBe(30 * 60_000);
  expect(waits.filter((wait) => wait === 30 * 60_000).length).toBeGreaterThan(
    1,
  );
});

it("holds a read queued during a failing read until the cooldown ends", async () => {
  const other = key(11);
  const t = setup(
    [record(OWNER, AGENT, REMOTE), record(OWNER, other, REMOTE)],
    new Map([
      [AGENT, OWNER],
      [other, OWNER],
    ]),
  );
  const times = timing(t, () => false);
  t.read.mockImplementationOnce(async () => {
    times.push(0);
    // Fails 100ms after it started.
    await new Promise((resolve) => setTimeout(resolve, 100));
    throw new Error("offline");
  });
  t.presence.subscribe(AGENT, () => {});
  // The read starts at 100ms; demand at 150ms would read at 250ms.
  await vi.advanceTimersByTimeAsync(150);
  t.presence.subscribe(other, () => {});
  await vi.advanceTimersByTimeAsync(100);
  expect(t.read).toHaveBeenCalledTimes(1);
  // The failure at 200ms holds that read for the cooldown too.
  await vi.advanceTimersByTimeAsync(59_000);
  expect(t.read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(11_000);
  expect(t.read).toHaveBeenCalledTimes(2);
  expect(times[1]).toBeGreaterThanOrEqual(60_200);
  expect(t.presence.status(AGENT)).toBe("online");
  expect(t.presence.status(other)).toBe("online");
});

it("starts no read while the app is hidden and resumes, spread, when shown", async () => {
  const other = key(11);
  const t = setup(
    [record(OWNER, AGENT, REMOTE), record(OWNER, other, REMOTE)],
    new Map([
      [AGENT, OWNER],
      [other, OWNER],
    ]),
  );
  t.presence.subscribe(AGENT, () => {});
  await vi.advanceTimersByTimeAsync(100);
  expect(t.read).toHaveBeenCalledTimes(1);
  t.hide();
  // No refresh, and no read for an agent shown meanwhile; evidence stays.
  t.presence.subscribe(other, () => {});
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(t.read).toHaveBeenCalledTimes(1);
  expect(t.presence.status(AGENT)).toBe("online");
  expect(t.presence.status(other)).toBe("offline");
  t.show();
  await vi.advanceTimersByTimeAsync(999);
  expect(t.read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(4_001);
  // The overdue refresh and the new demand make one read.
  expect(t.read).toHaveBeenCalledTimes(2);
  expect(t.read.mock.calls[1]?.[0][0]?.["#d"]).toEqual([AGENT, other]);
  expect(t.presence.status(other)).toBe("online");
  // Hidden again, the refresh waits again.
  t.hide();
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(t.read).toHaveBeenCalledTimes(2);
});

it("stops a read of several batches before its next batch while hidden and finishes it when shown", async () => {
  const agents = Array.from({ length: 9 }, (_, n) => key(100 + n));
  const owners = new Map(agents.map((agent, n) => [agent, key(200 + n)]));
  const t = setup(
    agents.map((agent) => record(owners.get(agent) ?? "", agent, REMOTE)),
    owners,
  );
  const asked = (from: number) =>
    t.read.mock.calls
      .slice(from)
      .flatMap(([filters]) => filters.flatMap((filter) => filter["#d"] ?? []));
  // Nine owners are nine filters: three batches. The first is held.
  const real = t.read.getMockImplementation();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.read.mockImplementationOnce(async (filters, signal) => {
    await held;
    return (await real?.(filters, signal)) ?? [];
  });
  for (const agent of agents) t.presence.subscribe(agent, () => {});
  await vi.advanceTimersByTimeAsync(100);
  expect(t.read).toHaveBeenCalledTimes(1);
  t.hide();
  release();
  // Hidden for less than a refresh, so what is shown later reads only the
  // rest. The held batch counts; no further batch started while hidden.
  await vi.advanceTimersByTimeAsync(60_000);
  expect(t.read).toHaveBeenCalledTimes(1);
  for (const agent of agents.slice(0, 4))
    expect(t.presence.status(agent)).toBe("online");
  for (const agent of agents.slice(4))
    expect(t.presence.status(agent)).toBe("offline");
  t.show();
  await vi.advanceTimersByTimeAsync(999);
  expect(t.read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(4_001);
  // The spread read asks about the five agents the hidden read left, not
  // the four it read.
  expect(t.read).toHaveBeenCalledTimes(3);
  expect(asked(1).sort()).toEqual([...agents.slice(4)].sort());
  for (const agent of agents) expect(t.presence.status(agent)).toBe("online");
});

it("reads agents of more owners than one read's filters allow", async () => {
  const agents = Array.from({ length: 9 }, (_, n) => key(100 + n));
  const owners = new Map(agents.map((agent, n) => [agent, key(200 + n)]));
  const t = setup(
    agents.map((agent) => record(owners.get(agent) ?? "", agent, REMOTE)),
    owners,
  );
  for (const agent of agents) t.presence.subscribe(agent, () => {});
  await vi.advanceTimersByTimeAsync(100);
  expect(t.read).toHaveBeenCalledTimes(3);
  for (const agent of agents) expect(t.presence.status(agent)).toBe("online");
});

it("keeps evidence through a remount, reading nothing again", async () => {
  const t = setup([record(OWNER, AGENT, REMOTE)]);
  for (let n = 0; n < 10; n++) {
    const stop = t.presence.subscribe(AGENT, () => {});
    await vi.advanceTimersByTimeAsync(100);
    expect(t.presence.status(AGENT)).toBe("online");
    stop();
  }
  expect(t.read).toHaveBeenCalledTimes(1);
});

it("reads each agent once as they appear, without cancelling reads under way", async () => {
  const agents = Array.from({ length: 30 }, (_, n) => key(300 + n));
  const owners = new Map(agents.map((agent) => [agent, OWNER]));
  const t = setup(
    agents.map((agent) => record(OWNER, agent, REMOTE)),
    owners,
  );
  const aborted: boolean[] = [];
  t.read.mockImplementation(async (filters, signal) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    aborted.push(signal.aborted);
    return agents
      .filter((agent) =>
        filters.some((filter) => filter["#d"]?.includes(agent)),
      )
      .map((agent) => record(OWNER, agent, REMOTE));
  });
  for (const agent of agents) {
    t.presence.subscribe(agent, () => {});
    await vi.advanceTimersByTimeAsync(120);
  }
  await vi.advanceTimersByTimeAsync(1_000);
  const asked = t.read.mock.calls.flatMap(([filters]) =>
    filters.flatMap((filter) => filter["#d"] ?? []),
  );
  expect([...asked].sort()).toEqual([...agents].sort());
  expect(aborted.every((value) => !value)).toBe(true);
  for (const agent of agents) expect(t.presence.status(agent)).toBe("online");
});

it("refreshes on a spread schedule", async () => {
  const t = setup([record(OWNER, AGENT, REMOTE)]);
  t.presence.subscribe(AGENT, () => {});
  await vi.advanceTimersByTimeAsync(100);
  expect(t.read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5 * 60_000 - 1_000);
  expect(t.read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(62_000);
  expect(t.read).toHaveBeenCalledTimes(2);
});

it("does not mark a hosted agent within the presence demand limit as past it", async () => {
  const t = setup([record(OWNER, AGENT, REMOTE)], undefined, observing());
  t.presence.subscribe(AGENT, () => {});
  await vi.advanceTimersByTimeAsync(100);
  expect(t.presence.status(AGENT)).toBe("online");
  expect(t.presence.limited(AGENT)).toBe(false);
});

it("neither reads nor marks agents past the presence demand limit until demand admits them", async () => {
  const agents = Array.from({ length: 257 }, (_, n) => key(1000 + n));
  const owners = new Map(agents.map((agent) => [agent, OWNER]));
  const t = setup(
    agents.map((agent) => record(OWNER, agent, REMOTE)),
    owners,
    observing(),
  );
  const overflow = agents[256] ?? "";
  const listener = vi.fn();
  const stops = agents.map((agent) =>
    t.presence.subscribe(agent, agent === overflow ? listener : () => {}),
  );
  await vi.advanceTimersByTimeAsync(100);
  // 256 agents of one owner fit one read of three filters.
  expect(t.read).toHaveBeenCalledTimes(1);
  const asked = t.read.mock.calls.flatMap(([filters]) =>
    filters.flatMap((filter) => filter["#d"] ?? []),
  );
  expect(asked).toHaveLength(256);
  expect(asked).not.toContain(overflow);
  expect(t.presence.status(agents[0] ?? "")).toBe("online");
  expect(t.presence.limited(agents[0] ?? "")).toBe(false);
  expect(t.presence.status(overflow)).toBe("unknown");
  expect(t.presence.limited(overflow)).toBe(true);
  // Nor does a refresh read it.
  await vi.advanceTimersByTimeAsync(6 * 60_000);
  expect(t.read).toHaveBeenCalledTimes(2);
  expect(t.read.mock.calls[1]?.[0].flatMap((f) => f["#d"] ?? [])).not.toContain(
    overflow,
  );
  // Releasing one admits it; it is then read and its subscriber told.
  listener.mockClear();
  stops[0]?.();
  await vi.advanceTimersByTimeAsync(100);
  expect(t.read).toHaveBeenCalledTimes(3);
  expect(t.read.mock.calls[2]?.[0][0]?.["#d"]).toEqual([overflow]);
  expect(t.presence.status(overflow)).toBe("online");
  expect(t.presence.limited(overflow)).toBe(false);
  expect(listener).toHaveBeenCalled();
});
