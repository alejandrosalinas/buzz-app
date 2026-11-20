import { afterEach, expect, it, vi } from "vitest";
import { createPresence } from "./presence";
import type { PresenceActivity } from "./activity";
import type { ReadTransport } from "../relay/transport";
import { createRelaySession } from "../relay/session";
import { createApiAdmission } from "../relay/http-admission";
import { createLiveAdmission, type LiveCallbacks } from "../relay/live";
const key = (n: number) => n.toString(16).padStart(64, "0");
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup() {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const listeners = new Set<() => void>();
  let visible = true;
  const activity: PresenceActivity = {
    visible: () => visible,
    status: () => "online",
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    dispose() {},
  };
  const read = vi.fn<NonNullable<ReadTransport["presenceSnapshot"]>>(
    async (authors) => new Map(authors.map((key) => [key, "online"])),
  );
  const transport = {
    viewer: key(1),
    relayAuthor: key(2),
    query: async () => [],
    media: () => undefined,
    presenceSnapshot: read,
  };
  const owner = createPresence(
    transport,
    activity,
    async () => true,
    (fn) => fn(),
  );
  owner.connected(true);
  return {
    owner,
    read,
    activity,
    transport,
    hide() {
      visible = false;
      for (const fn of listeners) fn();
    },
    show() {
      visible = true;
      for (const fn of listeners) fn();
    },
  };
}
it("deduplicates, bounds mounted demand and prioritizes an explicit profile", async () => {
  const h = setup();
  const releases = Array.from({ length: 260 }, (_, i) =>
    h.owner.subscribe(key(i), () => {}),
  );
  const duplicate = h.owner.subscribe(key(0), () => {});
  const profile = h.owner.subscribe(key(259), () => {}, true);
  await vi.advanceTimersByTimeAsync(100);
  expect(h.read).toHaveBeenCalledOnce();
  const authors = h.read.mock.calls[0]?.[0];
  expect(authors).toHaveLength(256);
  expect(new Set(authors).size).toBe(256);
  expect(authors).toContain(key(259));
  expect(h.owner.status(key(259))).toBe("online");
  expect(h.owner.status(key(258))).toBe("unknown");
  for (const release of releases) release();
  duplicate();
  profile();
  await vi.advanceTimersByTimeAsync(180000);
  expect(h.read).toHaveBeenCalledOnce();
  h.owner.dispose();
});
it("fences remove/re-add, hide and cache invalidation while a snapshot is held", async () => {
  const h = setup();
  let release!: (value: ReadonlyMap<string, "online">) => void;
  h.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const remove = h.owner.subscribe(key(3), () => {});
  await vi.advanceTimersByTimeAsync(100);
  remove();
  h.owner.subscribe(key(3), () => {});
  release(new Map([[key(3), "online"]]));
  await vi.advanceTimersByTimeAsync(0);
  expect(h.owner.status(key(3))).toBe("unknown");
  await vi.advanceTimersByTimeAsync(5000);
  expect(h.owner.status(key(3))).toBe("online");
  h.hide();
  expect(h.owner.status(key(3))).toBe("unknown");
  const calls = h.read.mock.calls.length;
  await vi.advanceTimersByTimeAsync(120000);
  expect(h.read).toHaveBeenCalledTimes(calls);
  h.show();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.owner.status(key(3))).toBe("online");
  h.owner.clear();
  expect(h.owner.status(key(3))).toBe("unknown");
  h.owner.dispose();
});
it.each([false, true])(
  "keeps the five-second start gate and prior evidence across remount (timeline retained: %s)",
  async (retainTimeline) => {
    const h = setup();
    try {
      if (retainTimeline) h.owner.subscribe(key(2), () => {});
      const remove = h.owner.subscribe(key(3), () => {});
      await vi.advanceTimersByTimeAsync(100);
      expect(h.read).toHaveBeenCalledOnce();
      expect(h.owner.status(key(3))).toBe("online");
      remove();
      expect(h.owner.status(key(3))).toBe("online");
      h.owner.subscribe(key(3), () => {});
      expect(h.owner.status(key(3))).toBe("online");
      await vi.advanceTimersByTimeAsync(4999);
      expect(h.read).toHaveBeenCalledOnce();
      expect(h.owner.status(key(3))).toBe("online");
      await vi.advanceTimersByTimeAsync(1);
      expect(h.read).toHaveBeenCalledTimes(2);
      expect(h.owner.status(key(3))).toBe("online");
    } finally {
      h.owner.dispose();
    }
  },
);

it("retains unmounted evidence only within its lease, demand limit and connection", async () => {
  const h = setup();
  try {
    h.read.mockImplementation(async () => null);
    let remove = h.owner.subscribe(key(3), () => {});
    h.read.mockImplementationOnce(async () => new Map([[key(3), "away"]]));
    await vi.advanceTimersByTimeAsync(100);
    remove();
    // The read started at 100ms, so its lease ends at 75,100ms.
    await vi.advanceTimersByTimeAsync(74999);
    expect(h.owner.status(key(3))).toBe("away");
    await vi.advanceTimersByTimeAsync(1);
    expect(h.owner.status(key(3))).toBe("unknown");

    h.read.mockImplementationOnce(async () => new Map([[key(3), "away"]]));
    remove = h.owner.subscribe(key(3), () => {});
    await vi.advanceTimersByTimeAsync(10000);
    remove();
    expect(h.owner.status(key(3))).toBe("away");
    const full = Array.from({ length: 256 }, (_, i) =>
      h.owner.subscribe(key(1000 + i), () => {}),
    );
    const changed = vi.fn();
    h.owner.subscribe(key(3), changed);
    expect(h.owner.limited(key(3))).toBe(true);
    expect(h.owner.status(key(3))).toBe("unknown");
    expect(changed).toHaveBeenCalled();
    for (const release of full) release();

    // The viewer's own status changes by publication, so it is not retained.
    h.read.mockImplementationOnce(async () => new Map([[key(1), "online"]]));
    remove = h.owner.subscribe(key(1), () => {});
    await vi.advanceTimersByTimeAsync(10000);
    expect(h.owner.status(key(1))).toBe("online");
    remove();
    expect(h.owner.status(key(1))).toBe("unknown");

    h.read.mockImplementationOnce(async () => new Map([[key(4), "online"]]));
    remove = h.owner.subscribe(key(4), () => {});
    await vi.advanceTimersByTimeAsync(10000);
    remove();
    expect(h.owner.status(key(4))).toBe("online");
    h.owner.connected(false);
    expect(h.owner.status(key(4))).toBe("unknown");
  } finally {
    h.owner.dispose();
  }
});

it.each(["during", "after", "reconnect"])(
  "paces demand from settlement with first-flight ordering: %s",
  async (demand) => {
    const h = setup();
    const lane = createApiAdmission();
    let releaseTransit!: () => void;
    const transit = new Promise<void>((resolve) => {
      releaseTransit = resolve;
    });
    const skipped = vi.fn();
    let first = true;
    h.read.mockImplementation(async (authors) => {
      if (first) {
        first = false;
        await transit;
      }
      const release = lane.tryPresence();
      if (!release) {
        skipped();
        return null;
      }
      release();
      return new Map(authors.map((author) => [author, "online"]));
    });
    try {
      h.owner.subscribe(key(3), () => {});
      await vi.advanceTimersByTimeAsync(100);
      expect(h.read).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(200);
      if (demand !== "after") h.owner.subscribe(key(4), () => {});
      if (demand === "reconnect") {
        h.owner.connected(false);
        h.owner.connected(true);
      }
      releaseTransit();
      await vi.advanceTimersByTimeAsync(0);
      if (demand === "after") h.owner.subscribe(key(4), () => {});
      expect(h.owner.status(key(4))).toBe("unknown");
      await vi.advanceTimersByTimeAsync(4999);
      expect(h.read).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.read).toHaveBeenCalledTimes(2);
      expect(skipped).not.toHaveBeenCalled();
      expect(h.owner.status(key(3))).toBe("online");
      expect(h.owner.status(key(4))).toBe("online");
    } finally {
      releaseTransit();
      h.owner.dispose();
    }
  },
);

it("local skips expire evidence; network failures enforce a minute delay even for new demand", async () => {
  const h = setup();
  h.owner.subscribe(key(3), () => {});
  await vi.advanceTimersByTimeAsync(100);
  h.read.mockResolvedValue(null);
  await vi.advanceTimersByTimeAsync(74999);
  expect(h.owner.status(key(3))).toBe("online");
  await vi.advanceTimersByTimeAsync(1);
  expect(h.owner.status(key(3))).toBe("unknown");
  h.read.mockRejectedValue(new Error("network"));
  await vi.advanceTimersByTimeAsync(5000);
  const calls = h.read.mock.calls.length;
  h.owner.subscribe(key(4), () => {});
  await vi.advanceTimersByTimeAsync(59999);
  expect(h.read).toHaveBeenCalledTimes(calls);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.read).toHaveBeenCalledTimes(calls + 1);
  h.owner.dispose();
});
it("real session wiring owns publication, snapshot lifetime and ordinary retention separately", async () => {
  const h = setup();
  h.owner.dispose();
  const publish = vi.fn(async () => true);
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _name: string,
        _options: unknown,
        work: () => Promise<void>,
      ) => work(),
    },
  });
  let callbacks!: LiveCallbacks;
  const store = createRelaySession(
    {
      ...h.transport,
      subscribe(value) {
        callbacks = value;
        return {
          update() {},
          retry() {},
          dispose() {},
          publishPresence: publish,
        };
      },
    },
    { presenceActivity: h.activity },
  );
  store.session.presence.subscribe(key(3), () => {}, true);
  callbacks.state({ status: "connected", routes: [] });
  await vi.advanceTimersByTimeAsync(1000);
  expect(publish).toHaveBeenCalledWith("online", expect.any(AbortSignal));
  expect(store.session.presence.status(key(3))).toBe("online");
  expect(h.read).toHaveBeenCalledOnce();
  await store.clearCache();
  expect(store.session.presence.status(key(3))).toBe("unknown");
  callbacks.state({ status: "retrying", routes: [] });
  const calls = publish.mock.calls.length;
  await vi.advanceTimersByTimeAsync(120000);
  expect(publish).toHaveBeenCalledTimes(calls);
  store.dispose();
});

it("standard lock ownership serializes windows; hidden observation does not stop renewal and disposal transfers ownership", async () => {
  const h = setup();
  h.owner.dispose();
  // A faithful exclusive-lock queue, not an app-owned election/retry mechanism.
  let occupied = false;
  const queue: (() => void)[] = [];
  const locks = {
    request: vi.fn(
      (
        _name: string,
        options: { signal: AbortSignal },
        work: () => Promise<void>,
      ) =>
        new Promise<void>((resolve, reject) => {
          const start = () => {
            if (options.signal.aborted) {
              reject(options.signal.reason);
              return;
            }
            occupied = true;
            void work()
              .then(resolve, reject)
              .finally(() => {
                occupied = false;
                queue.shift()?.();
              });
          };
          if (occupied) queue.push(start);
          else start();
        }),
    ),
  };
  vi.stubGlobal("navigator", { locks });
  const firstPublish = vi.fn(async () => true),
    nextPublish = vi.fn(async () => true);
  const first = createPresence(h.transport, h.activity, firstPublish, (fn) =>
    fn(),
  );
  const next = createPresence(h.transport, h.activity, nextPublish, (fn) =>
    fn(),
  );
  first.connected(true);
  next.connected(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(firstPublish).toHaveBeenCalledOnce();
  expect(nextPublish).not.toHaveBeenCalled();
  h.hide();
  await vi.advanceTimersByTimeAsync(60000);
  expect(firstPublish).toHaveBeenCalledTimes(2);
  expect(nextPublish).not.toHaveBeenCalled();
  first.dispose();
  await vi.advanceTimersByTimeAsync(1000);
  expect(nextPublish).toHaveBeenCalledOnce();
  next.dispose();
  await vi.advanceTimersByTimeAsync(0);
  expect(occupied).toBe(false);
});

it("bounds continuous mounted-author churn without deferring the first batch or replaying released demand", async () => {
  const h = setup();
  const started: number[] = [];
  h.read.mockImplementation(async (authors) => {
    started.push(Date.now());
    return new Map(authors.map((author) => [author, "online"]));
  });
  const mounted = Array.from({ length: 256 }, (_, i) =>
    h.owner.subscribe(key(i), () => {}),
  );
  const start = Date.now();
  let next = 256;
  // 2,000 author replacements in ten seconds, not an unchanged-demand timer test.
  for (let step = 0; step < 100; step++) {
    for (let count = 0; count < 20; count++) {
      mounted.shift()?.();
      mounted.push(h.owner.subscribe(key(next++), () => {}));
    }
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(started.map((at) => at - start)).toEqual([100, 5100]);
  for (const [authors] of h.read.mock.calls) {
    expect(authors).toHaveLength(256);
    expect(new Set(authors).size).toBe(256);
  }
  for (const release of mounted) release();
  await vi.advanceTimersByTimeAsync(120000);
  expect(h.read).toHaveBeenCalledTimes(2);
  h.owner.dispose();
});

it("duplicate demand and unchanged refreshes do not notify existing status subscribers", async () => {
  const h = setup();
  const changed = vi.fn();
  h.owner.subscribe(key(3), changed);
  await vi.advanceTimersByTimeAsync(100);
  expect(h.owner.status(key(3))).toBe("online");
  changed.mockClear();
  const duplicates = Array.from({ length: 1000 }, () =>
    h.owner.subscribe(key(3), () => {}),
  );
  await vi.advanceTimersByTimeAsync(60000);
  expect(h.read).toHaveBeenCalledTimes(2);
  expect(changed).not.toHaveBeenCalled();
  for (const release of duplicates) release();
  expect(changed).not.toHaveBeenCalled();
  h.owner.dispose();
});

it("starts a fresh 100ms coalescing window when first demand arrives after connection has been idle", async () => {
  const h = setup();
  await vi.advanceTimersByTimeAsync(10000);
  const first = h.owner.subscribe(key(3), () => {}, true);
  await vi.advanceTimersByTimeAsync(50);
  const second = h.owner.subscribe(key(4), () => {});
  await vi.advanceTimersByTimeAsync(49);
  expect(h.read).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.read).toHaveBeenCalledOnce();
  expect(h.read.mock.calls[0]?.[0]).toEqual([key(3), key(4)]);
  first();
  second();
  await vi.advanceTimersByTimeAsync(10000);
  h.owner.subscribe(key(5), () => {});
  await vi.advanceTimersByTimeAsync(99);
  expect(h.read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.read).toHaveBeenCalledTimes(2);
  h.owner.dispose();
});

it("retains profile priority across duplicate cleanup and refills released slots before the next task", async () => {
  const h = setup();
  const releases = Array.from({ length: 260 }, (_, i) =>
    h.owner.subscribe(key(i), () => {}),
  );
  const row = h.owner.subscribe(key(259), () => {});
  const first = h.owner.subscribe(key(259), () => {}, true);
  const second = h.owner.subscribe(key(259), () => {}, true);
  expect(h.owner.limited(key(259))).toBe(false);
  first();
  releases[0]?.();
  row();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.owner.status(key(259))).toBe("online");
  expect(h.owner.status(key(255))).toBe("online");
  expect(h.read.mock.calls[0]?.[0]).toHaveLength(256);
  second();
  for (const release of releases) release();
  await vi.advanceTimersByTimeAsync(120000);
  expect(h.read).toHaveBeenCalledOnce();
  h.owner.dispose();
});

it.each([null, true, "error"] as const)(
  "renewal retries only locally unsent status promptly: %s",
  async (result) => {
    const h = setup();
    h.owner.dispose();
    vi.stubGlobal("navigator", {
      locks: {
        request: async (
          _name: string,
          _options: unknown,
          work: () => Promise<void>,
        ) => work(),
      },
    });
    const publish = vi.fn(async (): Promise<boolean | null> => {
      if (result === "error") throw new Error("unconfirmed");
      return result;
    });
    const owner = createPresence(h.transport, h.activity, publish, (fn) =>
      fn(),
    );
    owner.connected(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(publish).toHaveBeenCalledOnce();
    const delay = result === null ? 5000 : 60000;
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(publish).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(publish).toHaveBeenCalledTimes(2);
    owner.dispose();
    await vi.advanceTimersByTimeAsync(60000);
    expect(publish).toHaveBeenCalledTimes(2);
  },
);
it("refreshes early at the start gate without discarding current evidence", async () => {
  const h = setup();
  const statuses: string[] = [];
  const release = h.owner.subscribe(key(3), () =>
    statuses.push(h.owner.status(key(3))),
  );
  h.read.mockResolvedValueOnce(new Map([[key(3), "offline"]]));
  await vi.advanceTimersByTimeAsync(100);
  expect(h.read).toHaveBeenCalledOnce();
  expect(h.owner.status(key(3))).toBe("offline");
  h.owner.refresh();
  await vi.advanceTimersByTimeAsync(4999);
  expect(h.read).toHaveBeenCalledOnce();
  expect(h.owner.status(key(3))).toBe("offline");
  await vi.advanceTimersByTimeAsync(1);
  expect(h.read).toHaveBeenCalledTimes(2);
  expect(h.owner.status(key(3))).toBe("online");
  // Selection notifies once; the refresh never passes back through Unknown.
  expect(statuses).toEqual(["unknown", "offline", "online"]);
  release();
  h.owner.dispose();
});

it.each([true, false, null, "error"] as const)(
  "reconciles only accepted publication, fences the pre-write read and accepts later snapshots (%s)",
  async (result) => {
    const h = setup();
    h.owner.dispose();
    vi.stubGlobal("navigator", {
      locks: {
        request: async (
          _name: string,
          _options: unknown,
          work: () => Promise<void>,
        ) => work(),
      },
    });
    let release!: (values: ReadonlyMap<string, "offline">) => void;
    h.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const publish = vi.fn(async () => {
      if (result === "error") throw new Error("unconfirmed");
      return result;
    });
    const owner = createPresence(h.transport, h.activity, publish, (fn) =>
      fn(),
    );
    owner.subscribe(h.transport.viewer, () => {}, true);
    owner.connected(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(publish).toHaveBeenCalledOnce();
    expect(owner.status(h.transport.viewer)).toBe(
      result === true ? "online" : "unknown",
    );
    release(new Map([[h.transport.viewer, "offline"]]));
    await vi.advanceTimersByTimeAsync(0);
    expect(owner.status(h.transport.viewer)).toBe(
      result === true ? "online" : "offline",
    );
    h.read.mockResolvedValue(new Map([[h.transport.viewer, "away"]]));
    owner.refresh();
    await vi.advanceTimersByTimeAsync(5000);
    expect(owner.status(h.transport.viewer)).toBe("away");
    owner.dispose();
  },
);

it("live evidence fences held snapshots and invalidation retires observation", async () => {
  const h = setup();
  h.owner.dispose();
  let receive!: (event: import("../relay/events").RelayEvent) => void;
  const stop = vi.fn();
  const observe = vi.fn((_keys, listener) => {
    receive = listener;
    return stop;
  });
  const owner = createPresence(
    { ...h.transport, observePresence: observe },
    h.activity,
    async () => false,
    (fn) => fn(),
  );
  let release!: (values: ReadonlyMap<string, "offline">) => void;
  h.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  owner.subscribe(key(3), () => {});
  owner.connected(true);
  await vi.advanceTimersByTimeAsync(100);
  expect(observe.mock.calls[0]?.[0]).toEqual([key(3)]);
  const event = (pubkey: string, content: string) =>
    ({ kind: 20001, pubkey, content }) as import("../relay/events").RelayEvent;
  receive(event(key(4), "online"));
  expect(owner.status(key(4))).toBe("unknown");
  receive(event(key(3), "away"));
  expect(owner.status(key(3))).toBe("away");
  release(new Map([[key(3), "offline"]]));
  await vi.advanceTimersByTimeAsync(0);
  expect(owner.status(key(3))).toBe("away");
  owner.connected(false);
  expect(stop).toHaveBeenCalledOnce();
  receive(event(key(3), "online"));
  expect(owner.status(key(3))).toBe("unknown");
  owner.dispose();
});

it.each([undefined, true])(
  "keeps late viewer demand within the 256 subject cap (profile: %s)",
  async (profile) => {
    const h = setup();
    try {
      for (let i = 3; i < 259; i++) h.owner.subscribe(key(i), () => {}, true);
      await vi.advanceTimersByTimeAsync(100);
      expect(h.owner.status(key(258))).toBe("online");
      const displaced = vi.fn();
      h.owner.subscribe(key(258), displaced, true);
      h.owner.subscribe(h.transport.viewer, () => {}, profile);
      expect(h.owner.limited(h.transport.viewer)).toBe(false);
      expect(h.owner.limited(key(258))).toBe(true);
      expect(h.owner.status(key(258))).toBe("unknown");
      expect(displaced).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.read).toHaveBeenCalledTimes(2);
      const authors = h.read.mock.lastCall?.[0];
      expect(authors).toHaveLength(256);
      expect(new Set(authors).size).toBe(256);
      expect(authors).toContain(h.transport.viewer);
      expect(authors).not.toContain(key(258));
      expect(h.owner.status(h.transport.viewer)).toBe("online");
    } finally {
      h.owner.dispose();
    }
  },
);

it("starts commands without jitter and retries at the real gate, including same-value commands", async () => {
  const h = setup();
  h.owner.dispose();
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _name: string,
        _options: unknown,
        work: () => Promise<void>,
      ) => work(),
    },
  });
  const listeners = new Set<() => void>();
  let status: "online" | "away" = "online",
    command = 0;
  const admission = createLiveAdmission();
  const sent: number[] = [];
  const activity = {
    ...h.activity,
    status: () => status,
    command: () => command,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  const publish = vi.fn(async () => {
    const release = admission.tryPresence();
    if (!release) return { retryAfterMs: admission.presenceDelay() };
    admission.presenceSent();
    sent.push(performance.now());
    release();
    return true;
  });
  const owner = createPresence(h.transport, activity, publish, (fn) => fn());
  try {
    owner.subscribe(h.transport.viewer, () => {});
    owner.connected(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(sent).toEqual([250]);
    await vi.advanceTimersByTimeAsync(1000);
    status = "away";
    command++;
    for (const fn of listeners) fn();
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenCalledTimes(2); // No initial command jitter.
    expect(owner.status(h.transport.viewer)).toBe("online");
    await vi.advanceTimersByTimeAsync(4049);
    expect(sent).toEqual([250]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([250, 5300]);
    expect(owner.status(h.transport.viewer)).toBe("away");
    command++; // Explicit reassertion, though derived status did not change.
    for (const fn of listeners) fn();
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(5050);
    expect(sent).toEqual([250, 5300, 10350]);
  } finally {
    owner.dispose();
  }
});
