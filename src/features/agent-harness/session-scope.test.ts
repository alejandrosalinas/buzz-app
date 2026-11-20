import { SessionControls } from "./session-control";
import { expect, it, vi } from "vitest";
import { localStore } from "../agents/store";
import {
  COMMUNITY_SESSION,
  communityTurn,
  standaloneTurn,
  scopedSessionKey,
  sessionScope,
  rememberCommunitySource,
  sessionSource,
} from "./session-scope";

it("keeps old thread and channel keys and selects one community key across every source", () => {
  expect(scopedSessionKey("thread", "a", "root")).toBe("a/root");
  expect(scopedSessionKey("thread", "a")).toBe("a");
  expect(scopedSessionKey("channel", "a", "root")).toBe("a");
  for (const channel of ["a", "dm", "solo", "huddle"])
    expect(scopedSessionKey("community", channel, "root")).toBe(
      COMMUNITY_SESSION,
    );
  expect(sessionScope("community")).toBe("community");
  expect(sessionScope("unknown")).toBe("thread");
});

it("persists the navigation source separately for each community membership", async () => {
  const values = new Map<string, string>();
  const backing = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  } as Storage;
  const store = localStore(backing);
  await rememberCommunitySource(store, "agent", COMMUNITY_SESSION, "a");
  await rememberCommunitySource(
    store,
    "agent@other.example",
    COMMUNITY_SESSION,
    "b",
  );
  const reloaded = localStore(backing);
  expect(sessionSource(reloaded, "agent", COMMUNITY_SESSION)).toEqual({
    channelId: "a",
    community: true,
  });
  expect(
    sessionSource(reloaded, "agent@other.example", COMMUNITY_SESSION),
  ).toEqual({ channelId: "b", community: true });
});

it("releases an expired admission while preserving the prior ordering barrier", async () => {
  let release!: () => void;
  const previous = new Promise<void>((resolve) => {
    release = resolve;
  });
  const policies = new Map([
    [
      COMMUNITY_SESSION,
      { solo: false, handed: previous, settled: previous, cancel() {} },
    ],
  ]);
  const signal = new AbortController();
  const controls = new SessionControls(() => {});
  const run = vi.fn(async () => "ran");
  const first = communityTurn(policies, signal.signal, controls, "shared", run);
  const rejected = vi.fn();
  void first.catch(rejected);
  signal.abort(new Error("expired"));
  try {
    await vi.waitFor(() => expect(rejected).toHaveBeenCalled());
    const next = communityTurn(
      policies,
      new AbortController().signal,
      controls,
      "shared",
      run,
    );
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    release();
    await expect(next).resolves.toBe("ran");
    expect(run).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await first.catch(() => {});
  }
});

it("cancels prior queued policies when the shared session is interrupted", async () => {
  let release!: () => void;
  const previous = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cancel = vi.fn();
  const independentCancel = vi.fn();
  const policies = new Map([
    [
      COMMUNITY_SESSION,
      { solo: false, handed: previous, settled: previous, cancel },
    ],
  ]);
  policies.set("channel/thread", {
    solo: false,
    handed: previous,
    settled: previous,
    cancel: independentCancel,
  });
  const turn = communityTurn(
    policies,
    new AbortController().signal,
    new SessionControls(() => {}),
    "shared",
    async () => {},
  );
  void turn.catch(() => {});
  try {
    policies.get(COMMUNITY_SESSION)?.cancel();
    expect(cancel).toHaveBeenCalledOnce();
    expect(independentCancel).not.toHaveBeenCalled();
  } finally {
    release();
    await turn.catch(() => {});
  }
});

it("does not fail native delivery when navigation metadata cannot be saved", async () => {
  const store = localStore({
    getItem: () => null,
    setItem: () => {
      throw new Error("disk full");
    },
    removeItem: () => {},
  } as unknown as Storage);
  await expect(
    rememberCommunitySource(store, "agent", COMMUNITY_SESSION, "a"),
  ).resolves.toBeUndefined();
});

it("notifies when a cancelled wake's retained ordering policy finally drains", async () => {
  let release!: () => void;
  const prior = new Promise<void>((resolve) => {
    release = resolve;
  });
  const policies = new Map([
    [
      COMMUNITY_SESSION,
      { solo: false, handed: prior, settled: prior, cancel() {} },
    ],
  ]);
  const states: boolean[] = [];
  const changed = () => {
    states.push(policies.has(COMMUNITY_SESSION));
  };
  const abort = new AbortController();
  const work = communityTurn(
    policies,
    abort.signal,
    new SessionControls(changed),
    "shared",
    async () => {},
    changed,
  );
  const rejected = expect(work).rejects.toThrow("expired");
  abort.abort(new Error("expired"));
  await rejected;
  expect(policies.has(COMMUNITY_SESSION)).toBe(true);
  release();
  await vi.waitFor(() => expect(policies.has(COMMUNITY_SESSION)).toBe(false));
  expect(states.at(-1)).toBe(false);
});

it.each([false, true])(
  "drains an independent wake before community work, including failure=%s",
  async (fails) => {
    const policies = new Map();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const once = standaloneTurn(
      policies,
      new AbortController().signal,
      async () => {
        await gate;
        if (fails) throw new Error("wake failed");
        return "independent";
      },
    );
    const outcome = fails
      ? expect(once).rejects.toThrow("wake failed")
      : expect(once).resolves.toBe("independent");
    const run = vi.fn(async () => "community");
    const shared = communityTurn(
      policies,
      new AbortController().signal,
      new SessionControls(() => {}),
      "shared",
      run,
    );
    expect(policies.size).toBe(2);
    expect(run).not.toHaveBeenCalled();
    release();
    await outcome;
    await expect(shared).resolves.toBe("community");
    await vi.waitFor(() => expect(policies.size).toBe(0));
  },
);

it("retains an aborted independent wake in the drain until native work settles", async () => {
  const policies = new Map();
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const signal = new AbortController();
  const once = standaloneTurn(policies, signal.signal, async () => {
    started();
    await gate;
  });
  await entered;
  const stopped = vi.fn();
  void once.then(stopped);
  signal.abort(new Error("stop"));
  expect(stopped).not.toHaveBeenCalled();
  expect(policies.size).toBe(1);
  const run = vi.fn(async () => {});
  const shared = communityTurn(
    policies,
    new AbortController().signal,
    new SessionControls(() => {}),
    "shared",
    run,
  );
  expect(run).not.toHaveBeenCalled();
  release();
  await once;
  await shared;
  expect(stopped).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(policies.size).toBe(0));
});
