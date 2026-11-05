import { networkRecorder } from "../developer/network-diagnostics";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { nativeSocket } from "./native-socket";
import { subscribeRelayTraffic, type LiveCallbacks } from "./live";
import { keypair, signed } from "./testing";

const channels = vi.hoisted(() => [] as ((event: unknown) => void)[]);
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    constructor(handler: (event: unknown) => void) {
      channels.push(handler);
    }
  },
  invoke: vi.fn(),
}));
beforeEach(() => networkRecorder.setEnabled(true));

afterEach(() => {
  networkRecorder.configure("info");
  networkRecorder.clear();
  vi.useRealTimers();
  vi.resetAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function connect() {
  const key = keypair();
  const callbacks = {
    receive: vi.fn(),
    state: vi.fn<LiveCallbacks["state"]>(),
    established: vi.fn(),
    denied: vi.fn(),
  } satisfies LiveCallbacks;
  const owner = subscribeRelayTraffic(
    "wss://relay.test",
    async (event) => signed(key, event),
    key.pubkey,
    callbacks,
    nativeSocket,
  );
  return { owner, callbacks };
}
it.each([
  "Federated community discovery failed",
  "Native sockets are busy",
  "Native socket timed out",
  "Native socket upgrade refused",
  "relay-unauthorized",
  "relay-unavailable",
])(
  "re-enters live reconnect after transient native admission: %s",
  async (error) => {
    vi.useFakeTimers();
    // Pin reconnect jitter to its full base delay.
    vi.spyOn(Math, "random").mockReturnValue(1);
    const first = deferred<"public">();
    const next = deferred<"public">();
    let attempts = 0;
    vi.mocked(invoke).mockImplementation((command) =>
      command === "relay_socket_connect"
        ? (++attempts === 1 ? first : next).promise
        : Promise.resolve(),
    );
    const h = connect();
    try {
      expect(attempts).toBe(1);
      expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("connecting");
      first.reject(error);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("retrying");
      await vi.advanceTimersByTimeAsync(499);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(2);
    } finally {
      h.owner.dispose();
      next.resolve("public");
      await vi.advanceTimersByTimeAsync(0);
    }
  },
);
it("reconnects when native admission succeeds but starting the worker fails", async () => {
  vi.useFakeTimers();
  const start = deferred<void>();
  const next = deferred<"public">();
  let attempts = 0;
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "relay_socket_connect")
      return ++attempts === 1 ? Promise.resolve("native") : next.promise;
    if (command === "relay_socket_start") return start.promise;
    return Promise.resolve();
  });
  const h = connect();
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledWith(
      "relay_socket_start",
      expect.any(Object),
    );
    start.reject("Native socket retired");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("retrying");
    await vi.advanceTimersByTimeAsync(500);
    expect(attempts).toBe(2);
  } finally {
    h.owner.dispose();
    start.resolve();
    next.resolve("public");
    await vi.advanceTimersByTimeAsync(0);
  }
});
// A relay's sign-in refusal backs off instead; see live.test.ts.
it.each([
  "binding-mismatch",
  "authorization-denied",
  "grant-refused",
  "invalid-proof",
  "relay-forbidden",
])(
  "keeps native credential refusal explicit without reconnect: %s",
  async (error) => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockImplementation((command) =>
      command === "relay_socket_connect"
        ? Promise.reject(error)
        : Promise.resolve(),
    );
    const h = connect();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(h.callbacks.state.mock.lastCall?.[0]).toMatchObject({
        status: "error",
        error,
      });
      await vi.advanceTimersByTimeAsync(60000);
      expect(
        vi
          .mocked(invoke)
          .mock.calls.filter(([command]) => command === "relay_socket_connect"),
      ).toHaveLength(1);
    } finally {
      h.owner.dispose();
    }
  },
);
it("backs off a sign-in refusal after the upgrade like its 401", async () => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockImplementation((command) =>
    Promise.resolve(command === "relay_socket_connect" ? "native" : undefined),
  );
  const h = connect();
  const connects = () =>
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "relay_socket_connect")
      .length;
  try {
    await vi.advanceTimersByTimeAsync(0);
    channels.at(-1)?.({
      type: "refused",
      reason: "Federated sign-in is required",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.callbacks.state.mock.lastCall?.[0]).toMatchObject({
      status: "error",
      error: "Federated sign-in is required",
    });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(connects()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connects()).toBe(2);
  } finally {
    h.owner.dispose();
  }
});
it("keeps the public fallback's close code, so repeated 1008s stop", async () => {
  vi.useFakeTimers();
  const browsers: { onclose: ((event: CloseEvent) => void) | null }[] = [];
  vi.stubGlobal(
    "WebSocket",
    class {
      onopen = null;
      onmessage = null;
      onerror = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      constructor() {
        browsers.push(this);
      }
      close() {}
    },
  );
  vi.mocked(invoke).mockImplementation((command) =>
    command === "relay_socket_connect"
      ? Promise.resolve("public")
      : Promise.resolve(),
  );
  const h = connect();
  const deny = () =>
    browsers
      .at(-1)
      ?.onclose?.(new CloseEvent("close", { code: 1008, reason: "denied" }));
  try {
    await vi.advanceTimersByTimeAsync(0);
    deny();
    expect(h.callbacks.state.mock.lastCall?.[0]).toMatchObject({
      status: "retrying",
      error: "Live connection closed (1008: denied)",
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(browsers).toHaveLength(2);
    deny();
    expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("error");
    await vi.advanceTimersByTimeAsync(60000);
    expect(browsers).toHaveLength(2);
  } finally {
    h.owner.dispose();
    vi.unstubAllGlobals();
  }
});
it("renews an admitted socket at once without a reconnecting state", async () => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockImplementation((command) =>
    Promise.resolve(command === "relay_socket_connect" ? "native" : undefined),
  );
  const h = connect();
  const connects = () =>
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "relay_socket_connect")
      .length;
  const relay = (
    channel: ((event: unknown) => void) | undefined,
    frame: unknown[],
  ) => channel?.({ type: "text", data: JSON.stringify(frame) });
  const admit = async () => {
    const channel = channels.at(-1);
    vi.mocked(invoke).mockClear();
    relay(channel, ["AUTH", "challenge"]);
    await vi.advanceTimersByTimeAsync(0);
    const auth = vi
      .mocked(invoke)
      .mock.calls.map(([command, args]) =>
        command === "relay_socket_send"
          ? JSON.parse((args as { data: string }).data)
          : undefined,
      )
      .find((frame) => frame?.[0] === "AUTH");
    relay(channel, ["OK", auth[1].id, true]);
    await vi.advanceTimersByTimeAsync(0);
  };
  try {
    await vi.advanceTimersByTimeAsync(0);
    await admit();
    expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("connected");
    const old = channels.at(-1);
    h.callbacks.state.mockClear();
    vi.mocked(invoke).mockClear();
    old?.({ type: "renew" });
    expect(connects()).toBe(1);
    // A planned renewal is not an outage: the session stays connected.
    expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("connected");
    await vi.advanceTimersByTimeAsync(0);
    expect(channels.at(-1)).not.toBe(old);
    // The retired socket's late frames no longer reach the live layer.
    relay(old, ["AUTH", "stale"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "relay_socket_send"),
    ).toHaveLength(0);
    await admit();
    expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("connected");
    expect(
      new Set(h.callbacks.state.mock.calls.map(([state]) => state.status)),
    ).toEqual(new Set(["connected"]));
  } finally {
    h.owner.dispose();
  }
});
it("backs off a renewal before admission like any other close", async () => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockImplementation((command) =>
    Promise.resolve(command === "relay_socket_connect" ? "native" : undefined),
  );
  const h = connect();
  try {
    await vi.advanceTimersByTimeAsync(0);
    channels.at(-1)?.({ type: "renew" });
    expect(h.callbacks.state.mock.lastCall?.[0].status).toBe("retrying");
  } finally {
    h.owner.dispose();
  }
});

it("joins subscription frames across native send and renderer delivery without logging payloads", async () => {
  vi.useFakeTimers();
  networkRecorder.configure("debug");
  networkRecorder.clear();
  vi.mocked(invoke).mockImplementation((command) =>
    Promise.resolve(command === "relay_socket_connect" ? "native" : undefined),
  );
  const h = connect();
  h.owner.update(["a"]);
  try {
    await vi.advanceTimersByTimeAsync(0);
    const channel = channels.at(-1);
    channel?.({
      type: "text",
      data: JSON.stringify(["AUTH", "private-challenge"]),
    });
    await vi.advanceTimersByTimeAsync(0);
    const sends = () =>
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "relay_socket_send")
        .map(
          ([, args]) =>
            args as {
              id: string;
              data: string;
              diagnostic: { operationId: string };
              frameSequence: number;
            },
        );
    const auth = sends().find((args) => JSON.parse(args.data)[0] === "AUTH");
    expect(auth).toBeDefined();
    channel?.({
      type: "text",
      data: JSON.stringify(["OK", JSON.parse(auth?.data ?? "[]")[1].id, true]),
    });
    await vi.advanceTimersByTimeAsync(750);
    const req = sends().find((args) => JSON.parse(args.data)[0] === "REQ");
    expect(req).toMatchObject({
      diagnostic: { operationId: expect.stringMatching(/^subscription:/) },
      frameSequence: expect.any(Number),
    });
    const wire = JSON.parse(req?.data ?? "[]")[1];
    channel?.({
      type: "text",
      data: JSON.stringify(["EOSE", wire]),
      nativeAt: Date.now() - 25,
      frameSequence: 42,
    });
    await vi.advanceTimersByTimeAsync(0);
    channel?.({
      type: "text",
      data: JSON.stringify(["EOSE", "foreign-subscription-secret"]),
      nativeAt: Date.now(),
      frameSequence: 43,
    });
    await vi.advanceTimersByTimeAsync(0);
    const events = networkRecorder.snapshot().events;
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "socket.delivered",
        connection: req?.id,
        frameSequence: 42,
        ms: 25,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "ws.frame",
        operationId: req?.diagnostic.operationId,
        subscriptionId: wire,
        frameSequence: 42,
      }),
    );
    expect(JSON.stringify(events)).not.toContain("private-challenge");
    expect(JSON.stringify(events)).not.toContain("subscription-secret");
  } finally {
    h.owner.dispose();
  }
});
