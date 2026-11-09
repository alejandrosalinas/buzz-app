// Regression controls contributed by Brain; see WS_RETRY_REVIEW_2026_09_09.
import { assert, afterEach, expect, it, vi } from "vitest";
import { keypair, message, signed } from "./testing";
import { connectBrokerTransport } from "./transport";
function required<T>(value: T | undefined): T {
  assert.exists(value);
  return value;
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function fixture() {
  const headers: ReturnType<typeof deferred<Response>>[] = [];
  const controls: ReturnType<typeof deferred<Response>>[] = [];
  const interests: ReturnType<typeof deferred<Response>>[] = [];
  const signals: AbortSignal[] = [];
  const snapshots: unknown[] = [];
  const bodyControllers: ReadableStreamDefaultController[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit = {}) => {
      if (url.endsWith("/session"))
        return Promise.resolve(
          Response.json({
            viewer: "a".repeat(64),
            relayAuthor: "b".repeat(64),
            live: true,
          }),
        );
      if (url.endsWith("/stream-interests")) {
        const d = deferred<Response>();
        interests.push(d);
        return d.promise;
      }
      if (
        url.endsWith("/stream-retry") ||
        url.endsWith("/stream-observer") ||
        url.endsWith("/stream-presence")
      ) {
        const d = deferred<Response>();
        controls.push(d);
        signals.push(init.signal as AbortSignal);
        return d.promise;
      }
      if (url.endsWith("/stream")) {
        const d = deferred<Response>();
        headers.push(d);
        return d.promise;
      }
      throw Error(`unexpected fetch ${url}`);
    }),
  );
  function accept(index: number) {
    const body = new ReadableStream({
      start(c) {
        bodyControllers[index] = c;
      },
    });
    required(headers[index]).resolve(
      new Response(body, {
        headers: {
          "Content-Type": "text/event-stream",
          "X-Buzz-Live-ID": String(index + 1).padStart(32, "0"),
        },
      }),
    );
  }
  function publish(
    index: number,
    snapshot: unknown = { status: "connected", routes: [] },
  ) {
    required(bodyControllers[index]).enqueue(
      new TextEncoder().encode(
        `event: state\ndata: ${JSON.stringify(snapshot)}\n\n`,
      ),
    );
  }
  return {
    headers,
    controls,
    interests,
    disconnect(index: number) {
      required(bodyControllers[index]).error(new Error("fixture disconnect"));
    },
    signals,
    snapshots,
    accept,
    publish,
    frame(kind: string, value: unknown) {
      required(bodyControllers[0]).enqueue(
        new TextEncoder().encode(
          `event: ${kind}\ndata: ${JSON.stringify(value)}\n\n`,
        ),
      );
    },
    callbacks: {
      state(s: unknown) {
        snapshots.push(s);
      },
      receive: vi.fn(),
      established() {},
      denied() {},
    },
  };
}
it("rejects status deltas beyond the bounded frame size", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)(f.callbacks);
  try {
    f.accept(0);
    await tick();
    f.frame("state-delta", {
      status: "connected",
      removed: [],
      interestRevision: 0,
      routes: Array.from({ length: 513 }, (_, i) => ({
        id: `route-${i}`,
        status: "pending",
        replay: "unknown",
      })),
    });
    await tick();
    expect(f.snapshots.at(-1)).toEqual({
      status: "retrying",
      routes: [],
      error: "Invalid live status delta",
    });
  } finally {
    owner.dispose();
  }
});

it("pre-header clicks preserve in-progress POST; duplicate controls coalesce", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)(f.callbacks);
  try {
    owner.retry();
    owner.retry();
    await tick();
    expect(f.headers).toHaveLength(1);
    expect(f.controls).toHaveLength(0);
    f.accept(0);
    await tick();
    f.publish(0);
    await tick();
    owner.retry();
    owner.retry();
    await tick();
    expect(f.controls).toHaveLength(1);
    expect(f.headers).toHaveLength(1);
    required(f.controls[0]).resolve(new Response(null, { status: 200 }));
    await tick();
    owner.retry();
    await tick();
    expect(f.controls).toHaveLength(2);
    expect(f.headers).toHaveLength(1);
    required(f.controls[1]).resolve(new Response(null, { status: 200 }));
    await tick();
  } finally {
    owner.dispose();
  }
});
it.each([false, true])(
  "successful retry clears its old control error without erasing a newer failure: %s",
  async (newerFailure) => {
    vi.useFakeTimers();
    const f = fixture();
    const transport = await connectBrokerTransport();
    const owner = required(transport.subscribe)(f.callbacks);
    try {
      f.accept(0);
      await tick();
      f.publish(0);
      await tick();
      owner.retry();
      required(f.controls[0]).resolve(new Response(null, { status: 503 }));
      await tick();
      expect(f.snapshots.at(-1)).toMatchObject({
        error: "Live retry control failed (503)",
      });
      if (newerFailure) {
        f.publish(0, {
          status: "connected",
          routes: [],
          error: "restricted: account needs attention",
        });
        await tick();
      }
      owner.retry();
      required(f.controls[1]).resolve(new Response(null, { status: 200 }));
      await tick();
      expect(f.snapshots.at(-1)).toEqual({
        status: "connected",
        routes: [],
        ...(newerFailure
          ? { error: "restricted: account needs attention" }
          : {}),
      });
    } finally {
      owner.dispose();
    }
  },
);

for (const finish of ["replacement", "dispose"] as const)
  for (const outcome of ["status", "reject"] as const)
    it(`late retry ${outcome} cannot update ${finish}`, async () => {
      vi.useFakeTimers();
      const f = fixture();
      const t = await connectBrokerTransport();
      const owner = required(t.subscribe)(f.callbacks);
      try {
        f.accept(0);
        await tick();
        f.publish(0);
        await tick();
        owner.retry();
        await tick();
        expect(f.controls).toHaveLength(1);
        if (finish === "replacement") {
          f.disconnect(0);
          await vi.advanceTimersByTimeAsync(500);
          f.accept(1);
          await tick();
          f.publish(1);
          await tick();
        } else owner.dispose();
        expect(required(f.signals[0]).aborted).toBe(true);
        const before = f.snapshots.length;
        // Deliberately uncooperative completion despite abort, proving callback fence.
        if (outcome === "status")
          required(f.controls[0]).resolve(new Response(null, { status: 500 }));
        else
          required(f.controls[0]).reject(
            new Error("deliberately late network rejection"),
          );
        await tick();
        expect(f.snapshots).toHaveLength(before);
        expect(f.headers).toHaveLength(finish === "replacement" ? 2 : 1);
      } finally {
        owner.dispose();
      }
    });

it("late observer 404 from a retired stream cannot interrupt its replacement", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)(f.callbacks);
  try {
    f.accept(0);
    await tick();
    f.publish(0);
    await tick();
    required(owner.observe)(1);
    await tick();
    expect(f.controls).toHaveLength(1);
    f.disconnect(0);
    await vi.advanceTimersByTimeAsync(500);
    f.accept(1);
    await tick();
    f.publish(1);
    await tick();
    expect(required(f.signals[0]).aborted).toBe(true);
    const before = f.snapshots.length;
    required(f.controls[0]).resolve(new Response(null, { status: 404 }));
    await tick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.snapshots).toHaveLength(before);
    expect(f.headers).toHaveLength(2);
    required(owner.observe)(2);
    await tick();
    expect(f.controls).toHaveLength(2);
    expect(required(f.signals[1]).aborted).toBe(false);
    required(f.controls[1]).resolve(new Response(null, { status: 200 }));
    await tick();
  } finally {
    owner.dispose();
  }
});

it("preserves validated replay/live provenance through production broker transport; legacy traffic stays unknown", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)(f.callbacks);
  try {
    f.accept(0);
    await tick();
    owner.update(["a"]);
    required(f.interests[0]).resolve(new Response(null, { status: 200 }));
    await tick();
    const event = message(keypair(), "a", "incoming", 1700000000);
    f.frame("message", event);
    await tick();
    expect(f.callbacks.receive).toHaveBeenLastCalledWith([event]);
    for (const phase of ["replay", "live"]) {
      f.frame("traffic", { event, provenance: { phase, channelId: "a" } });
      await tick();
      expect(f.callbacks.receive).toHaveBeenLastCalledWith([event], {
        phase,
        channelId: "a",
      });
    }
    expect(f.callbacks.receive).toHaveBeenCalledTimes(3);
  } finally {
    owner.dispose();
  }
});
it.each([undefined, { phase: "fresh" }, { phase: "live", channelId: ["a"] }])(
  "rejects malformed traffic provenance instead of calling it fresh: %j",
  async (provenance) => {
    vi.useFakeTimers();
    const f = fixture();
    const t = await connectBrokerTransport();
    const owner = required(t.subscribe)(f.callbacks);
    try {
      f.accept(0);
      await tick();
      f.frame("traffic", {
        event: message(keypair(), "a", "incoming", 1700000000),
        provenance,
      });
      await tick();
      expect(f.callbacks.receive).not.toHaveBeenCalled();
      expect(f.snapshots.at(-1)).toMatchObject({ status: "retrying" });
    } finally {
      owner.dispose();
    }
  },
);

it("in-place interests fence removed/readded channel frames but retain unchanged-channel traffic", async () => {
  const f = fixture();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)(f.callbacks);
  try {
    owner.update(["a", "b"]);
    f.accept(0);
    await tick();
    required(f.interests[0]).resolve(new Response(null, { status: 200 }));
    await tick();
    owner.update(["b"]);
    owner.update(["a", "b"]);
    const event = message(keypair(), "a", "stale", 1700000000);
    f.frame("traffic", {
      event,
      provenance: { phase: "live", channelId: "a" },
      interestRevision: 1,
    });
    f.frame("traffic", {
      event: message(keypair(), "b", "unchanged", 1700000000),
      provenance: { phase: "live", channelId: "b" },
      interestRevision: 1,
    });
    await tick();
    expect(f.callbacks.receive).toHaveBeenCalledTimes(1);
    expect(f.callbacks.receive.mock.lastCall?.[1]).toEqual({
      phase: "live",
      channelId: "b",
    });
    required(f.interests[1]).resolve(new Response(null, { status: 200 }));
    await tick();
    expect(f.interests).toHaveLength(3);
    required(f.interests[2]).resolve(new Response(null, { status: 200 }));
    await tick();
    f.frame("traffic", {
      event,
      provenance: { phase: "live", channelId: "a" },
      interestRevision: 3,
    });
    await tick();
    expect(f.callbacks.receive).toHaveBeenCalledTimes(2);
    expect(f.headers).toHaveLength(1);
  } finally {
    owner.dispose();
  }
});

it("atomically carries joined classification and fences h-less traffic while the update is held", async () => {
  const f = fixture();
  const established = vi.fn();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)({ ...f.callbacks, established });
  try {
    owner.update(["a", "b"], ["a", "b"]);
    f.accept(0);
    await tick();
    const bodies = () =>
      vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => String(url).endsWith("/stream-interests"))
        .map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies()[0]).toMatchObject({
      channels: ["a", "b"],
      joined: ["a", "b"],
      interestRevision: 1,
    });
    required(f.interests[0]).resolve(new Response(null, { status: 200 }));
    await tick();
    const event = signed(keypair(), {
      kind: 5,
      tags: [["e", "f".repeat(64)]],
      content: "",
    });
    const traffic = {
      event,
      provenance: { phase: "live", sourceChannels: ["a", "b"] },
      interestRevision: 1,
    };
    f.frame("traffic", traffic);
    await tick();
    expect(f.callbacks.receive).toHaveBeenCalledTimes(1);
    // Same interest IDs, changed a's membership class. Keep this HTTP update
    // pending while old SSE traffic and establishment arrive.
    owner.update(["a", "b"], ["b"]);
    expect(bodies()[1]).toMatchObject({
      channels: ["a", "b"],
      joined: ["b"],
      removed: ["a"],
      interestRevision: 2,
    });
    f.frame("traffic", traffic);
    f.frame("established", { channels: ["a", "b"], interestRevision: 1 });
    await tick();
    expect(f.callbacks.receive).toHaveBeenCalledTimes(1);
    expect(established).toHaveBeenCalledExactlyOnceWith(["b"]);
    required(f.interests[1]).resolve(new Response(null, { status: 200 }));
    await tick();
    f.frame("traffic", {
      ...traffic,
      provenance: { phase: "live", channelId: "a" },
      interestRevision: 2,
    });
    f.frame("established", { channelId: "a", interestRevision: 2 });
    await tick();
    expect(f.callbacks.receive).toHaveBeenCalledTimes(2);
    expect(established).toHaveBeenLastCalledWith("a");
    expect(f.headers).toHaveLength(1);
  } finally {
    owner.dispose();
  }
});

it("passes a global route's continuity through, and reports none for a malformed one", async () => {
  const f = fixture();
  const established = vi.fn();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)({ ...f.callbacks, established });
  try {
    f.accept(0);
    await tick();
    f.frame("established", {
      global: { route: "profiles", continuous: true },
      interestRevision: 0,
    });
    f.frame("established", {
      global: { route: "membership", continuous: "yes" },
      interestRevision: 0,
    });
    await tick();
    expect(established.mock.calls).toEqual([
      [undefined, { route: "profiles", continuous: true }],
      [undefined, undefined],
    ]);
  } finally {
    owner.dispose();
  }
});

it("passes the channels whose replay was continuous through, only among those established", async () => {
  const f = fixture();
  const established = vi.fn();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)({ ...f.callbacks, established });
  try {
    owner.update(["a", "b", "c"], ["a", "b"]);
    f.accept(0);
    await tick();
    required(f.interests[0]).resolve(new Response(null, { status: 200 }));
    await tick();
    f.frame("established", {
      channels: ["a", "b"],
      // c is not in this establishment; 7 is not an ID.
      continuous: ["b", "c", 7, "b"],
      interestRevision: 1,
    });
    f.frame("established", {
      channelId: "c",
      continuous: ["c"],
      interestRevision: 1,
    });
    // A malformed list reports none.
    f.frame("established", {
      channels: ["a", "b"],
      continuous: "a",
      interestRevision: 1,
    });
    await tick();
    expect(established.mock.calls).toEqual([
      [["a", "b"], undefined, ["b"]],
      ["c", undefined, ["c"]],
      [["a", "b"]],
    ]);
  } finally {
    owner.dispose();
  }
});

it("reports no channel of a batch continuous once one of its channels is no longer current", async () => {
  const f = fixture();
  const established = vi.fn();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)({ ...f.callbacks, established });
  try {
    owner.update(["a", "b"], ["a", "b"]);
    f.accept(0);
    await tick();
    required(f.interests[0]).resolve(new Response(null, { status: 200 }));
    await tick();
    // a changes membership class while the batch replays: the broker drops
    // the batch's untagged traffic, so b's replay may be incomplete too.
    owner.update(["a", "b"], ["b"]);
    f.frame("established", {
      channels: ["a", "b"],
      continuous: ["a", "b"],
      interestRevision: 1,
    });
    await tick();
    expect(established.mock.calls).toEqual([[["b"]]]);
  } finally {
    owner.dispose();
  }
});

it("coalesced remove/re-add with the same final IDs still advances host interest revision", async () => {
  const f = fixture();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)(f.callbacks);
  try {
    owner.update(["a"]);
    f.accept(0);
    await tick();
    owner.update([]);
    owner.update(["a"]);
    required(f.interests[0]).resolve(new Response(null, { status: 200 }));
    await tick();
    expect(f.interests).toHaveLength(2);
    const calls = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).endsWith("/stream-interests"));
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toMatchObject({
      channels: ["a"],
      removed: ["a"],
      interestRevision: 3,
    });
    required(f.interests[1]).resolve(new Response(null, { status: 200 }));
    await tick();
    expect(f.headers).toHaveLength(1);
  } finally {
    owner.dispose();
  }
});

it("preserves locally-unsent presence separately from refusal and unknown responses", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)(f.callbacks);
  try {
    expect(
      await owner.publishPresence?.("online", new AbortController().signal),
    ).toBeNull();
    f.accept(0);
    await tick();
    f.publish(0);
    await tick();
    for (const retryAfterMs of [
      0,
      250,
      3800,
      86401000,
      -1,
      1.5,
      86401001,
      "250",
      null,
    ]) {
      const result = owner.publishPresence?.(
        "away",
        new AbortController().signal,
      );
      required(f.controls.at(-1)).resolve(
        Response.json({ accepted: null, retryAfterMs }),
      );
      expect(await result).toEqual(
        typeof retryAfterMs === "number" &&
          Number.isInteger(retryAfterMs) &&
          retryAfterMs >= 0 &&
          retryAfterMs <= 86401000
          ? { retryAfterMs }
          : null,
      );
    }
    for (const accepted of [null, false, true, undefined, "null"]) {
      const result = owner.publishPresence?.(
        "online",
        new AbortController().signal,
      );
      required(f.controls.at(-1)).resolve(Response.json({ accepted }));
      expect(await result).toBe(accepted === null ? null : accepted === true);
    }
  } finally {
    owner.dispose();
  }
});

it("in-place channel interests preserve an outstanding presence publication", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)(f.callbacks);
  try {
    f.accept(0);
    await tick();
    f.publish(0);
    await tick();
    const identity = owner.identity?.();
    const result = required(owner.publishPresence)(
      "online",
      new AbortController().signal,
    );
    owner.update(["a"]);
    expect(owner.identity?.()).toBe(identity);
    expect(required(f.signals[0]).aborted).toBe(false);
    required(f.interests[0]).resolve(new Response(null, { status: 200 }));
    await tick();
    required(f.controls[0]).resolve(Response.json({ accepted: true }));
    expect(await result).toBe(true);
    expect(f.headers).toHaveLength(1);
  } finally {
    owner.dispose();
  }
});

it("keeps current status when old delta frames follow a removed and re-added channel", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const t = await connectBrokerTransport();
  const established = vi.fn();
  const owner = required(t.subscribe)({ ...f.callbacks, established });
  const row = {
    id: "channel:a",
    channelId: "a",
    status: "live",
    replay: "unknown",
  };
  const delta = (revision: number, routes: unknown[], removed: string[] = []) =>
    f.frame("state-delta", {
      status: "connected",
      routes,
      removed,
      interestRevision: revision,
    });
  try {
    owner.update(["a"], ["a"]);
    f.accept(0);
    await tick();
    delta(1, [row]);
    f.frame("established", { channels: ["a"], interestRevision: 1 });
    await tick();
    expect(established).toHaveBeenCalledExactlyOnceWith(["a"]);
    owner.update([]);
    owner.update(["a"], ["a"]);
    delta(1, [row]);
    await tick();
    expect(f.snapshots.at(-1)).toMatchObject({
      routes: [expect.objectContaining({ channelId: "a", status: "pending" })],
    });
    delta(3, [row]);
    f.frame("established", { channels: ["a"], interestRevision: 3 });
    await tick();
    delta(1, [], ["channel:a"]);
    await tick();
    expect(f.snapshots.at(-1)).toMatchObject({
      routes: [expect.objectContaining({ channelId: "a", status: "live" })],
    });
    expect(established).toHaveBeenCalledTimes(2);
  } finally {
    owner.dispose();
  }
});

it.each([
  { id: "unknown", status: "live", replay: "unknown" },
  { id: "fake-channel:a", channelId: "a", status: "live", replay: "unknown" },
])(
  "rejects a delta key outside the current route namespace: $id",
  async (route) => {
    vi.useFakeTimers();
    const f = fixture();
    const t = await connectBrokerTransport();
    const owner = required(t.subscribe)(f.callbacks);
    try {
      f.accept(0);
      await tick();
      f.frame("state-delta", {
        status: "connected",
        interestRevision: 0,
        removed: [],
        routes: [route],
      });
      await tick();
      expect(f.snapshots.at(-1)).toMatchObject({
        status: "retrying",
        error: "Invalid live status delta",
      });
    } finally {
      owner.dispose();
    }
  },
);

it("keeps the reconnect backoff growing for streams that drop right after their first frame", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)(f.callbacks);
  try {
    // Every accepted stream sends its state at once, so that proves nothing.
    for (const [index, wait] of [500, 1000, 2000].entries()) {
      f.accept(index);
      await tick();
      f.publish(index);
      await tick();
      f.disconnect(index);
      await tick();
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(f.headers).toHaveLength(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.headers).toHaveLength(index + 2);
    }
  } finally {
    owner.dispose();
  }
});
it("resets the reconnect backoff once a stream stayed up a minute", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)(f.callbacks);
  try {
    // Two drops without a healthy stream: 500 ms, then 1 s.
    f.accept(0);
    await tick();
    f.disconnect(0);
    await tick();
    await vi.advanceTimersByTimeAsync(500);
    f.accept(1);
    await tick();
    f.disconnect(1);
    await tick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.headers).toHaveLength(3);
    // A minute up proves the broker is back: the next drop is quick.
    f.accept(2);
    await tick();
    for (let second = 0; second < 60; second += 30) {
      f.publish(2);
      await vi.advanceTimersByTimeAsync(30_000);
    }
    f.disconnect(2);
    await tick();
    await vi.advanceTimersByTimeAsync(500);
    expect(f.headers).toHaveLength(4);
  } finally {
    owner.dispose();
  }
});
it.each([400, 401, 403, 413])(
  "keeps a %s stream rejection visible and retries it slowly, doubling the wait",
  async (status) => {
    vi.useFakeTimers();
    const f = fixture();
    const t = await connectBrokerTransport();
    const owner = required(t.subscribe)(f.callbacks);
    try {
      for (const [index, wait] of [60_000, 120_000].entries()) {
        required(f.headers[index]).resolve(new Response(null, { status }));
        await tick();
        expect(f.snapshots.at(-1)).toMatchObject({
          status: "error",
          error: `Live broker rejected subscription (${status})`,
        });
        await vi.advanceTimersByTimeAsync(wait - 1);
        expect(f.headers).toHaveLength(index + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(f.headers).toHaveLength(index + 2);
      }
      f.accept(2);
      await tick();
      f.publish(2);
      await tick();
      expect(f.snapshots.at(-1)).toMatchObject({ status: "connected" });
    } finally {
      owner.dispose();
    }
  },
);
