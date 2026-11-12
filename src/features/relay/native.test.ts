import { networkRecorder } from "../developer/network-diagnostics";
import { networkMetrics } from "../developer/network-metrics";
import { abortNetwork, bindNetworkContext } from "../developer/network-context";
import {
  ARTIFACT_INCREMENTAL_LIMITS,
  ArtifactIncrementalError,
} from "./artifact-incremental-reader";
import {
  ReadStateTimestampRejected,
  READ_STATE_TIMESTAMP_REFUSAL,
} from "./read-state-host";
import memberContract from "../channel-members/administration-contract.json";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  type EventTemplate,
  type VerifiedEvent,
  verifyEvent,
} from "nostr-tools";
import {
  connectNativeTransport,
  nativeRelayRequest,
  nativeRelaySigner,
  nativeWriteKinds,
  verifyNativeStored,
} from "./native";
import { keypair, message, nativeSignatureChecks, signed } from "./testing";
import { createOutbox, type OutgoingEvent, PublishRejected } from "./outbox";
import { createMessages } from "./messages";
import { createRelaySession } from "./session";

const progressChannels = new Map<string, (message: unknown) => void>();
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    readonly id = `__CHANNEL__:${progressChannels.size}`;
    constructor(onmessage: (message: unknown) => void) {
      progressChannels.set(this.id, onmessage);
    }
    toJSON() {
      return this.id;
    }
  },
  invoke: vi.fn(),
  isTauri: () => true,
  convertFileSrc: (path: string, protocol: string) =>
    `${protocol}://localhost/${encodeURIComponent(path)}`,
}));
const viewer = keypair(),
  relay = keypair();
const community = "https://packaged.test";
type Request = {
  community: string;
  path: string;
  method: string;
  body: string | null;
};
let discovery: Record<string, unknown> = {};
let respond: (
  request: Request,
) =>
  | { status?: number; body: unknown }
  | Promise<{ status?: number; body: unknown }>;
const requests: Request[] = [];
const uploads: { bytes: Uint8Array; headers: Record<string, string> }[] = [];
const received = new Map<string, Uint8Array[]>();
let uploadResponse: () => { status?: number; body: unknown };
const cancels: string[] = [];
let hangUploads = false;
let preparedResponse: (() => { status?: number; body: unknown }) | undefined;
const owners: ReturnType<typeof createOutbox>[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  networkRecorder.setEnabled(true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1700000010000);
  requests.length = 0;
  discovery = {};
  respond = () => ({ body: [] });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Packaged connections must not call the dev broker");
    }),
  );
  uploads.length = 0;
  received.clear();
  cancels.length = 0;
  hangUploads = false;
  preparedResponse = undefined;
  uploadResponse = () => ({ status: 500, body: "" });
  vi.mocked(invoke).mockImplementation(async (command, args, options) => {
    if (command === "relay_socket_connect") return "public";
    if (command === "relay_socket_close") return;
    if (command === "identity_restore") return viewer.pubkey;
    if (command === "relay_verify_signatures")
      return nativeSignatureChecks(args);
    if (command === "relay_sign") {
      expect(
        Object.keys((args as { event: EventTemplate }).event).sort(),
      ).toEqual(["content", "created_at", "kind", "tags"]);
      return signed(viewer, (args as { event: EventTemplate }).event);
    }
    if (command === "relay_http") {
      const request = args as Request;
      requests.push(request);
      const result =
        request.path === "/"
          ? { body: { self: relay.pubkey, ...discovery } }
          : await respond(request);
      return {
        status: result.status ?? 200,
        headers: {},
        body: JSON.stringify(result.body),
      };
    }
    if (command === "relay_upload_begin") {
      received.set((args as { id: string }).id, []);
      return null;
    }
    if (command === "relay_upload_chunk") {
      const { headers } = options as { headers: Record<string, string> };
      received
        .get(headers["x-buzz-upload-id"] ?? "")
        ?.push(new Uint8Array(args as ArrayBuffer));
      return null;
    }
    if (command === "relay_upload_cancel") {
      cancels.push((args as { id: string }).id);
      return null;
    }
    if (command === "relay_upload") {
      if (hangUploads) return new Promise(() => {});
      const { headers } = options as { headers: Record<string, string> };
      const chunks = received.get(headers["x-buzz-upload-id"] ?? "") ?? [];
      const bytes = new Uint8Array(
        chunks.reduce((total, chunk) => total + chunk.length, 0),
      );
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      uploads.push({ bytes, headers });
      const report = progressChannels.get(
        headers["x-buzz-upload-progress"] ?? "",
      );
      report?.({ sent: 0, total: 3 });
      report?.({ sent: 2, total: 3 });
      const result = (options as { headers: Record<string, string> }).headers[
        "x-buzz-preparation"
      ]
        ? (preparedResponse?.() ?? uploadResponse())
        : uploadResponse();
      return {
        status: result.status ?? 200,
        headers: {},
        body:
          typeof result.body === "string"
            ? result.body
            : JSON.stringify(result.body),
      };
    }
    throw new Error(`Unexpected native command: ${command}`);
  });
});

it("verifies stored events through native signature checks without connecting", async () => {
  vi.mocked(invoke).mockClear();
  const profile = signed(viewer, { kind: 0, tags: [], content: "{}" });
  const restored = await verifyNativeStored([
    JSON.parse(JSON.stringify(profile)),
  ]);
  expect(restored.map((event) => event.id)).toEqual([profile.id]);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "relay_verify_signatures",
  ]);
  await expect(
    verifyNativeStored([{ ...profile, content: "changed" }]),
  ).rejects.toThrow();
  expect(requests).toEqual([]);
});
it("requires the relay self key, never its operator contact pubkey", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({
    status: 200,
    headers: {},
    body: JSON.stringify({ pubkey: relay.pubkey }),
  });
  await expect(connectNativeTransport(community)).rejects.toThrow(
    "advertise its identity",
  );
});

it("sends combined search operators through packaged native signed HTTP without a dev broker", async () => {
  const transport = await connectNativeTransport(community);
  const hit = message(viewer, "channel", "deploy matched", 1700000000);
  respond = () => ({ body: [hit] });
  const filters = [
    {
      kinds: [9, 40002, 40008],
      search: "deploy",
      search_mode: "prefix" as const,
      authors: [viewer.pubkey],
      "#h": ["channel"],
      since: 1699920000,
      until: 1700006399,
      limit: 20,
    },
  ];
  await expect(transport.query(filters)).resolves.toEqual([hit]);
  expect(requests.at(-1)).toMatchObject({
    community,
    path: "/query",
    method: "POST",
    body: JSON.stringify(filters),
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("reads back expired delivery with strong consistency without re-signing or publishing it", async () => {
  const transport = await connectNativeTransport(community);
  assert.exists(transport.writer);
  const event = message(viewer, "channel", "old delivery", 1699999000);
  respond = () => ({ body: [event] });
  await transport.writer.publish(event, new AbortController().signal);
  expect(JSON.parse(requests.at(-1)?.body ?? "null")).toEqual([
    {
      kinds: [9],
      ids: [event.id],
      authors: [viewer.pubkey],
      limit: 1,
      consistency: "strong",
    },
  ]);
  respond = () => ({ body: [] });
  await expect(
    transport.writer.publish(event, new AbortController().signal),
  ).rejects.toThrow("too old to retry");
  respond = () => ({ status: 503, body: { error: "offline" } });
  await expect(
    transport.writer.publish(event, new AbortController().signal),
  ).rejects.not.toBeInstanceOf(PublishRejected);
  expect(requests.every((request) => request.path !== "/events")).toBe(true);
  expect(
    vi.mocked(invoke).mock.calls.some(([command]) => command === "relay_sign"),
  ).toBe(false);
});
it.each([
  {},
  { supported_extensions: null },
  { supported_extensions: [] },
  { supported_extensions: ["nip-cl"] },
  { supported_extensions: "nip-ar" },
])(
  "does not offer artifact writes without NIP-AR advertisement: %o",
  async (extensions) => {
    discovery = extensions;
    expect(
      (await connectNativeTransport(community)).configArtifacts,
    ).toBeUndefined();
  },
);
it("publishes config artifacts straight to the relay, re-sending identical bytes and keeping typed refusals", async () => {
  discovery = { supported_extensions: ["nip-ar"] };
  const transport = await connectNativeTransport(community);
  assert.exists(transport.configArtifacts);
  expect(transport.configArtifacts.kinds).toEqual([45010]);
  const signal = new AbortController().signal;
  const template = {
    kind: 45010,
    created_at: 1700000000,
    content: "{}",
    tags: [["ar", "1"]],
  };
  const revision = await transport.configArtifacts.sign(template, signal);
  expect(verifyEvent(revision)).toBe(true);
  expect(revision.pubkey).toBe(viewer.pubkey);
  await expect(
    transport.configArtifacts.sign({ ...template, kind: 9 }, signal),
  ).rejects.toThrow("Not an artifact");
  // Older than the message writer's 15-minute retry block.
  const event = signed(viewer, {
    kind: 45010,
    created_at: 1699990000,
    content: "{}",
    tags: [
      ["h", "channel"],
      ["d", "agent"],
    ],
  });
  respond = () => ({
    body: { accepted: true, event_id: event.id, message: "" },
  });
  await transport.configArtifacts.publish(event, signal);
  await transport.configArtifacts.publish(event, signal);
  const sent = requests.filter((request) => request.path === "/events");
  expect(sent).toHaveLength(2);
  expect(sent[0]?.body).toBe(sent[1]?.body);
  expect(JSON.parse(sent[0]?.body ?? "null")).toEqual(
    JSON.parse(JSON.stringify(event)),
  );
  respond = () => ({
    body: {
      accepted: false,
      event_id: event.id,
      message: "rate-limited: quota exceeded; retry in 9s",
    },
  });
  const refused = await transport.configArtifacts
    .publish(event, signal)
    .catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(PublishRejected);
  expect(transport.configArtifacts.isNotSent?.(refused)).toBe(true);
  expect(
    transport.configArtifacts.isNotSent?.(
      new Error((refused as Error).message),
    ),
  ).toBe(false);
  expect(
    transport.configArtifacts.isNotSent?.(new PublishRejected("denied")),
  ).toBe(false);
  expect((refused as Error).message).toBe(
    "rate-limited: quota exceeded; retry in 9s",
  );
  respond = () => ({ status: 409, body: { error: "conflict" } });
  await expect(
    transport.configArtifacts.publish(event, signal),
  ).rejects.toThrow(/^conflict:/);
  await expect(
    transport.configArtifacts.publish({ ...event, kind: 9 }, signal),
  ).rejects.toThrow("Not this viewer's artifact");
});
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each([
  ["deadline", "response"],
  ["deadline", "rejection"],
  ["caller", "response"],
  ["caller", "rejection"],
] as const)(
  "counts %s separately from cancellation after IPC %s",
  async (initiator, result) => {
    const deadline = new AbortController(),
      caller = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(deadline.signal);
    const gate = deferred<void>();
    respond = async () => {
      await gate.promise;
      if (result === "rejection") throw new Error("native transport failure");
      return { body: [] };
    };
    networkMetrics.setEnabled(true);
    networkMetrics.reset();
    const request = nativeRelayRequest(
      community,
      "/query",
      [],
      caller.signal,
    ).catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      (initiator === "deadline" ? deadline : caller).abort();
      expect(networkMetrics.snapshot().relays[0]?.inFlight).toBe(1);
      gate.resolve();
      await request;
      expect(networkMetrics.snapshot().relays[0]).toMatchObject({
        inFlight: 0,
        session: {
          latency: { http: { count: 0 } },
          counts: {
            requestOk: 0,
            requestFailed: initiator === "deadline" ? 1 : 0,
            requestCancelled: initiator === "caller" ? 1 : 0,
          },
        },
      });
    } finally {
      gate.resolve();
      await request;
      timeout.mockRestore();
      networkMetrics.setEnabled(false);
      networkMetrics.reset();
    }
  },
);

it.each(["ok", "refused", "clear", "enable", "resume"] as const)(
  "samples native HTTP response latency only for a current captured response (%s)",
  async (outcome) => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    respond = async () => {
      await gate.promise;
      return { status: outcome === "refused" ? 503 : 200, body: [] };
    };
    networkMetrics.setEnabled(outcome !== "enable");
    networkMetrics.reset();
    const request = nativeRelayRequest(community, "/query", []);
    try {
      expect(requests).toHaveLength(1);
      if (outcome === "clear") networkMetrics.reset();
      if (outcome === "resume") networkMetrics.setEnabled(false);
      if (outcome === "enable" || outcome === "resume")
        networkMetrics.setEnabled(true);
      await vi.advanceTimersByTimeAsync(50);
      gate.resolve();
      await request;
      const sample = networkMetrics.snapshot().relays[0]?.session.latency.http;
      if (outcome === "ok" || outcome === "refused")
        expect(sample).toMatchObject({ count: 1, mean: 50 });
      else expect(sample?.count ?? 0).toBe(0);
    } finally {
      gate.resolve();
      await request;
      networkMetrics.setEnabled(false);
      networkMetrics.reset();
    }
  },
);

it("discovers the relay, verifies reads and publishes through the same native identity and destination", async () => {
  const incoming = message(viewer, "channel", "hello", 1700000000);
  respond = (r) =>
    r.path === "/query"
      ? { body: [incoming] }
      : {
          body: {
            accepted: true,
            event_id: JSON.parse(r.body ?? "{}").id,
            message: "confirmed",
          },
        };
  const transport = await connectNativeTransport(community);
  expect(transport.viewer).toBe(viewer.pubkey);
  expect(transport.relayAuthor).toBe(relay.pubkey);
  expect(
    await transport.query([{ kinds: [9], "#h": ["channel"], limit: 10 }]),
  ).toEqual([incoming]);
  assert.exists(transport.writer);
  const event = await transport.writer.sign(
    {
      kind: 9,
      content: "native send",
      tags: [["h", "channel"]],
      created_at: 1700000001,
    },
    new AbortController().signal,
  );
  expect(
    await transport.writer.publish(event, new AbortController().signal),
  ).toBe("confirmed");
  expect(requests.map((r) => [r.community, r.path])).toEqual([
    [community, "/"],
    [community, "/query"],
    [community, "/events"],
  ]);
  expect(JSON.parse(requests[2]?.body ?? "null")).toEqual(
    JSON.parse(JSON.stringify(event)),
  );
  expect(fetch).not.toHaveBeenCalled();
});

it.each([true, false])(
  "publishes owner-signed managed-agent registrations through the session outbox (accepted: %s)",
  async (accepted) => {
    const transport = await connectNativeTransport(community);
    const owner = createRelaySession(transport, {
      outboxStorage: { load: () => [], save: () => {} },
    });
    try {
      const outbox = owner.session.outbox;
      assert.exists(outbox);
      await outbox.ready();
      const agent = keypair().pubkey;
      const content = JSON.stringify({
        name: "Remote agent",
        parallelism: 1,
        respond_to: "owner-only",
      });
      respond = (request) => ({
        status: accepted ? 200 : 403,
        body: accepted
          ? { accepted: true, event_id: JSON.parse(request.body ?? "{}").id }
          : { error: "restricted: registration denied" },
      });
      expect(outbox.supports(30177)).toBe(true);
      const id = outbox.send({ kind: 30177, tags: [["d", agent]], content });
      await vi.waitFor(() =>
        expect(
          outbox.snapshot().find((item) => item.event.id === id),
        ).toMatchObject({
          delivery: accepted ? "accepted" : "failed",
          ...(accepted ? {} : { error: "Registration denied" }),
        }),
      );
      const publishes = requests.filter(
        (request) => request.path === "/events",
      );
      expect(publishes).toHaveLength(1);
      expect(publishes[0]).toMatchObject({ community, method: "POST" });
      const event = JSON.parse(publishes[0]?.body ?? "null");
      expect(event).toMatchObject({
        id,
        kind: 30177,
        pubkey: viewer.pubkey,
        content,
      });
      expect(event.tags).toEqual([
        ["d", agent],
        ["client-id", expect.any(String)],
      ]);
      expect(verifyEvent(event)).toBe(true);
      expect(invoke).toHaveBeenCalledWith("relay_sign", {
        community,
        event: {
          kind: 30177,
          created_at: event.created_at,
          tags: event.tags,
          content,
        },
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      owner.dispose();
    }
  },
);

it.each([true, false])(
  "delivers managed-agent unregister through the native outbox (accepted: %s)",
  async (accepted) => {
    const transport = await connectNativeTransport(community);
    assert.exists(transport.writer);
    const owner = createOutbox(viewer.pubkey, transport.writer, {
      load: () => [],
      save: () => {},
    });
    owners.push(owner);
    await owner.outbox.ready();
    respond = (request) => ({
      body: {
        accepted,
        event_id: JSON.parse(request.body ?? "{}").id,
        message: accepted ? "" : "denied",
      },
    });
    const coordinate = `30177:${viewer.pubkey}:${"02".repeat(32)}`;
    const id = owner.outbox.send({
      kind: 5,
      content: "",
      tags: [["a", coordinate]],
    });
    await vi.waitFor(() =>
      expect(
        owner.outbox.snapshot().find((item) => item.event.id === id)?.delivery,
      ).toBe(accepted ? "accepted" : "failed"),
    );
    const event = JSON.parse(
      requests.find((request) => request.path === "/events")?.body ?? "null",
    );
    expect(event).toMatchObject({
      id,
      kind: 5,
      pubkey: viewer.pubkey,
      content: "",
    });
    expect(event.tags).toEqual([
      ["a", coordinate],
      ["client-id", expect.any(String)],
    ]);
    expect(vi.mocked(invoke).mock.calls).toContainEqual([
      "relay_sign",
      {
        community,
        event: {
          kind: 5,
          created_at: event.created_at,
          content: "",
          tags: event.tags,
        },
      },
    ]);
  },
);

it("rejects tampered reads and keeps refusals distinct from uncertain receipts", async () => {
  const transport = await connectNativeTransport(community);
  const event = message(viewer, "channel", "original", 1700000000);
  respond = () => ({ body: [{ ...event, content: "tampered" }] });
  await expect(transport.query([{ kinds: [9], limit: 10 }])).rejects.toThrow();
  respond = () => ({ body: [event, { ...event, sig: "0".repeat(128) }] });
  await expect(transport.query([{ kinds: [9], limit: 10 }])).rejects.toThrow(
    "invalidly signed",
  );
  assert.exists(transport.writer);
  respond = () => ({ status: 403, body: { error: "denied" } });
  await expect(
    transport.writer.publish(event, new AbortController().signal),
  ).rejects.toBeInstanceOf(PublishRejected);
  respond = () => ({ body: { accepted: true, event_id: "wrong" } });
  await expect(
    transport.writer.publish(event, new AbortController().signal),
  ).rejects.not.toBeInstanceOf(PublishRejected);
});

it("a captured signer cannot send a request to a different community", async () => {
  const signer = nativeRelaySigner(community);
  expect(() =>
    signer.request?.(
      "https://other.test/events",
      "{}",
      new AbortController().signal,
    ),
  ).toThrow("changed community");
  expect(invoke).not.toHaveBeenCalled();
});

it("authenticates live traffic with the native signer and verifies incoming channel events", async () => {
  const sockets: Socket[] = [];
  class Socket {
    readyState = 1;
    onopen?: (event: Event) => unknown;
    onmessage?: (event: { data: string }) => Promise<void>;
    onclose?: () => void;
    sent: unknown[][] = [];
    constructor(readonly url: string) {
      sockets.push(this);
    }
    send(raw: string) {
      this.sent.push(JSON.parse(raw));
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    async receive(value: unknown) {
      await this.onmessage?.({ data: JSON.stringify(value) });
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const transport = await connectNativeTransport(community);
  const receive = vi.fn();
  const traffic = transport.subscribe?.({
    receive,
    state: vi.fn(),
    established: vi.fn(),
    denied: vi.fn(),
  });
  assert.exists(traffic);
  try {
    traffic.update(["channel"]);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    assert.exists(socket);
    socket.onopen?.(new Event("open"));
    expect(socket.url).toBe("wss://packaged.test");
    await socket.receive(["AUTH", "nonce"]);
    const proof = socket.sent.find(
      ([kind]) => kind === "AUTH",
    )?.[1] as VerifiedEvent;
    expect(proof.pubkey).toBe(viewer.pubkey);
    expect(proof.tags).toEqual([
      ["relay", "wss://packaged.test"],
      ["challenge", "nonce"],
    ]);
    await socket.receive(["OK", proof.id, true]);
    const route = socket.sent.find(
      ([kind, , filter]) =>
        kind === "REQ" &&
        (filter as { "#h"?: string[] })["#h"]?.includes("channel"),
    );
    assert.exists(route);
    await socket.receive(["EOSE", route[1]]);
    const incoming = message(keypair(), "channel", "Live reply", 1700000002);
    await socket.receive(["EVENT", route[1], incoming]);
    await vi.waitFor(() => expect(receive).toHaveBeenCalled());
    expect(receive).toHaveBeenCalledWith([incoming], {
      phase: "live",
      channelId: "channel",
    });
    expect(vi.mocked(invoke).mock.calls).toContainEqual([
      "relay_verify_signatures",
      {
        claims: [
          { id: incoming.id, pubkey: incoming.pubkey, sig: incoming.sig },
        ],
      },
    ]);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([command]) => command === "identity_export"),
    ).toBe(false);
  } finally {
    traffic.dispose();
  }
});

it("cancellation fences a late native response and prevents undispatched work", async () => {
  networkRecorder.configure("debug");
  networkRecorder.clear();
  const gate = deferred<{ body: unknown }>();
  respond = () => gate.promise;
  const controller = new AbortController();
  bindNetworkContext(controller.signal, {
    operationId: "read:causal-test",
    owner: "channel-head",
  });
  const request = nativeRelayRequest(
    community,
    "/query",
    [],
    controller.signal,
  );
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toMatchObject({
    diagnostic: { operationId: "read:causal-test" },
  });
  abortNetwork(controller, "superseded", "channel-head");
  try {
    await expect(
      nativeRelayRequest(community, "/query", [], controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toHaveLength(1);
  } finally {
    gate.resolve({ body: [] });
  }
  await expect(request).rejects.toMatchObject({ name: "AbortError" });
  expect(networkRecorder.snapshot().events).toContainEqual(
    expect.objectContaining({
      event: "native.result-discarded",
      operationId: "read:causal-test",
      status: 200,
      cancellation: { initiator: "superseded", owner: "channel-head" },
    }),
  );
  networkRecorder.configure("info");
  networkRecorder.clear();
});

it("cancelled native reads retain the six-request admission bound until IPC settles", async () => {
  vi.useFakeTimers();
  const transport = await connectNativeTransport(
    "https://cancelled-native.test",
  );
  const gate = deferred<{ body: unknown }>();
  let active = 0,
    maximum = 0;
  respond = async () => {
    active++;
    maximum = Math.max(maximum, active);
    try {
      return await gate.promise;
    } finally {
      active--;
    }
  };
  const controllers = Array.from({ length: 12 }, () => new AbortController());
  const reads = controllers.map((controller) =>
    transport
      .query([{ kinds: [0], limit: 5 }], controller.signal)
      .catch((error: unknown) => error),
  );
  try {
    await vi.waitFor(() =>
      expect(requests.filter((r) => r.path === "/query")).toHaveLength(6),
    );
    for (const controller of controllers) controller.abort();
    // A further request has entered the same lane, but cannot dispatch past cancelled native work.
    const last = transport.query([{ kinds: [0], limit: 5 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests.filter((r) => r.path === "/query")).toHaveLength(6);
    gate.resolve({ body: [] });
    await last;
    expect(requests.filter((r) => r.path === "/query")).toHaveLength(7);
    for (const error of await Promise.all(reads))
      expect(error).toMatchObject({ name: "AbortError" });
    expect(maximum).toBe(6);
  } finally {
    gate.resolve({ body: [] });
    await Promise.all(reads);
  }
});

it("restores uncertain native delivery and retries the exact signed event without signing it again", async () => {
  let records: readonly OutgoingEvent[] = [];
  const storage = {
    load: () => structuredClone(records),
    save: (next: readonly OutgoingEvent[]) => {
      records = structuredClone(next);
    },
  };
  const first = await connectNativeTransport(community);
  assert.exists(first.writer);
  respond = () => {
    throw new Error("Receipt lost after dispatch");
  };
  const one = createOutbox(viewer.pubkey, first.writer, storage);
  owners.push(one);
  await one.outbox.ready();
  const id = one.outbox.send({
    kind: 9,
    content: "recover me",
    tags: [["h", "channel"]],
  });
  await vi.waitFor(() => expect(records[0]?.delivery).toBe("unknown"));
  const published = JSON.parse(
    requests.find((r) => r.path === "/events")?.body ?? "null",
  );
  one.dispose();
  vi.mocked(invoke).mockClear();
  const second = await connectNativeTransport(community);
  assert.exists(second.writer);
  respond = () => ({ body: { accepted: true, event_id: published.id } });
  const two = createOutbox(viewer.pubkey, second.writer, storage);
  owners.push(two);
  await two.outbox.ready();
  expect(two.outbox.snapshot()[0]?.delivery).toBe("unknown");
  two.outbox.retry(id);
  await vi.waitFor(() =>
    expect(two.outbox.snapshot()[0]?.delivery).toBe("accepted"),
  );
  expect(
    requests
      .filter((r) => r.path === "/events")
      .map((r) => JSON.parse(r.body ?? "null")),
  ).toEqual([published, published]);
  expect(
    vi.mocked(invoke).mock.calls.some(([command]) => command === "relay_sign"),
  ).toBe(false);
});

it.each(["missing", "offline"])(
  "keeps expired delivery unknown after %s readback",
  async (failure) => {
    const event = message(viewer, "channel", "expired intent", 1699999000);
    let records: readonly OutgoingEvent[] = [
      { event, signed: event, delivery: "unknown" },
    ];
    const transport = await connectNativeTransport(community);
    assert.exists(transport.writer);
    respond = () =>
      failure === "missing"
        ? { body: [] }
        : { status: 503, body: { error: "offline" } };
    const owner = createOutbox(viewer.pubkey, transport.writer, {
      load: () => structuredClone(records),
      save: (next) => {
        records = structuredClone(next);
      },
    });
    owners.push(owner);
    await owner.outbox.ready();
    owner.outbox.retry(event.id);
    await vi.waitFor(() =>
      expect(records[0]?.error).toMatch(
        failure === "missing"
          ? /too old to retry/
          : /Relay request failed \(503\)/,
      ),
    );
    expect(records[0]).toMatchObject({ signed: event, delivery: "unknown" });
    expect(requests.some((request) => request.path === "/events")).toBe(false);
  },
);

it.each(["online", "tampered", "wrong-author", "empty"] as const)(
  "native presence snapshot uses bounded authenticated query and verifies authority (%s)",
  async (result) => {
    const origin = `https://presence-${result}.test`;
    const event = signed(result === "wrong-author" ? viewer : relay, {
      kind: 20001,
      created_at: 1700000010,
      tags: [["p", viewer.pubkey]],
      content: "online",
    });
    respond = () => ({
      body:
        result === "empty"
          ? []
          : [result === "tampered" ? { ...event, content: "away" } : event],
    });
    const transport = await connectNativeTransport(origin);
    const pending = transport.presenceSnapshot?.(
      [viewer.pubkey],
      new AbortController().signal,
    );
    if (result === "tampered" || result === "wrong-author")
      await expect(pending).rejects.toThrow();
    else
      expect((await pending)?.get(viewer.pubkey)).toBe(
        result === "empty" ? "offline" : "online",
      );
    expect(JSON.parse(requests.at(-1)?.body ?? "null")).toEqual([
      { kinds: [20001], authors: [viewer.pubkey], limit: 1 },
    ]);
    expect(requests.at(-1)?.path).toBe("/query");
    expect(
      await transport.presenceSnapshot?.(
        [viewer.pubkey],
        new AbortController().signal,
      ),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each(["message", "reaction"] as const)(
  "publishes native %s removal with the broker's kind-5 tags",
  async (target) => {
    const transport = await connectNativeTransport(community);
    assert.exists(transport.writer);
    const original = message(viewer, "channel", "remove me", 1700000000);
    const reaction = signed(viewer, {
      kind: 7,
      content: "👍",
      tags: [
        ["h", "channel"],
        ["e", original.id],
      ],
    });
    const chosen = target === "message" ? original : reaction;
    const owner = createOutbox(viewer.pubkey, transport.writer, {
      load: () => [],
      save: () => {},
    });
    owners.push(owner);
    await owner.outbox.ready();
    const messages = createMessages(
      owner.outbox,
      viewer.pubkey,
      (id) => [original, reaction].find((event) => event.id === id),
      () => [],
      () => {},
    );
    respond = (request) => ({
      body: {
        accepted: true,
        event_id: JSON.parse(request.body ?? "{}").id,
      },
    });
    messages.remove([chosen.id]);
    await vi.waitFor(() =>
      expect(
        requests.filter((request) => request.path === "/events"),
      ).toHaveLength(1),
    );
    const event = JSON.parse(requests.at(-1)?.body ?? "null");
    expect(event).toMatchObject({
      kind: 5,
      pubkey: viewer.pubkey,
      content: "",
    });
    expect(event.tags).toEqual([
      ["h", "channel"],
      ["e", chosen.id],
      ["k", String(chosen.kind)],
      ["client-id", expect.any(String)],
    ]);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(
          ([command, args]) =>
            command === "relay_sign" &&
            (args as { event: EventTemplate }).event.kind === 5,
        ),
    ).toBe(true);
  },
);

it("exposes workflow history over the purpose-bound native route and workflow write kinds", async () => {
  const transport = await connectNativeTransport(community);
  expect(nativeWriteKinds).toEqual(
    expect.arrayContaining([30620, 46020, 5, 48103]),
  );
  expect(transport.writer?.kinds).toEqual(nativeWriteKinds);
  assert.exists(transport.workflows);
  const id = "11111111-1111-4111-8111-111111111111";
  const cursor = { before: "2026-09-29T20:00:00Z", beforeId: id };
  const runs = { runs: [], next: null };
  vi.mocked(invoke).mockImplementationOnce(async (command, args) => {
    expect(command).toBe("relay_workflow_runs");
    expect(args).toEqual({ community, id, cursor });
    return { status: 200, headers: {}, body: JSON.stringify(runs) };
  });
  expect(
    await transport.workflows.runs(id, cursor, new AbortController().signal),
  ).toEqual(runs);
  await expect(
    transport.workflows.runs("../", undefined, new AbortController().signal),
  ).rejects.toThrow("Invalid workflow ID");
  const controller = new AbortController();
  controller.abort();
  await expect(
    transport.workflows.runs(id, undefined, controller.signal),
  ).rejects.toThrow();
  expect(requests).toEqual([
    expect.objectContaining({
      community,
      path: "/",
      method: "GET",
      body: null,
    }),
  ]);
});

it("workflow history surfaces bounded host refusals and fences late native results", async () => {
  const transport = await connectNativeTransport(community);
  assert.exists(transport.workflows);
  const id = "11111111-1111-4111-8111-111111111111";
  const pending = deferred<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }>();
  vi.mocked(invoke).mockImplementationOnce(() => pending.promise);
  const controller = new AbortController();
  const read = transport.workflows.runs(id, undefined, controller.signal);
  controller.abort();
  pending.resolve({
    status: 200,
    headers: {},
    body: '{"runs":[],"next":null}',
  });
  await expect(read).rejects.toThrow();
  vi.mocked(invoke).mockResolvedValueOnce({
    status: 403,
    headers: {},
    body: '{"error":"denied"}',
  });
  await expect(
    transport.workflows.runs(id, undefined, new AbortController().signal),
  ).rejects.toMatchObject({ kind: "denied" });
});

it("reads project Git through the signed native command and fences late results", async () => {
  const transport = await connectNativeTransport(community);
  assert.exists(transport.projectGit);
  const owner = "a".repeat(64);
  const empty = {
    head: null,
    commits: [],
    files: [],
    readme: null,
    file: null,
    diff: null,
  };
  vi.mocked(invoke).mockImplementationOnce(async (command, args) => {
    expect(command).toBe("relay_project_git");
    expect(args).toEqual({
      community,
      id: expect.any(String),
      read: { owner, dtag: "repo" },
    });
    return { status: 200, headers: {}, body: JSON.stringify(empty) };
  });
  expect(
    await transport.projectGit.read(
      { owner: owner.toUpperCase(), dtag: "repo" },
      new AbortController().signal,
    ),
  ).toEqual(empty);
  const calls = vi.mocked(invoke).mock.calls.length;
  await expect(
    transport.projectGit.read(
      { owner, dtag: "../repo" },
      new AbortController().signal,
    ),
  ).rejects.toThrow("Invalid Git read");
  expect(vi.mocked(invoke).mock.calls.length).toBe(calls);
  vi.mocked(invoke).mockResolvedValueOnce({
    status: 403,
    headers: {},
    body: '{"error":"denied"}',
  });
  await expect(
    transport.projectGit.read(
      { owner, dtag: "repo" },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ kind: "denied" });
  const pending = deferred<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }>();
  vi.mocked(invoke).mockImplementationOnce(() => pending.promise);
  const controller = new AbortController();
  const read = transport.projectGit.read(
    { owner, dtag: "repo" },
    controller.signal,
  );
  await vi.waitFor(() =>
    expect(vi.mocked(invoke).mock.calls.at(-1)?.[0]).toBe("relay_project_git"),
  );
  const { id } = (vi.mocked(invoke).mock.lastCall ?? [])[1] as { id: string };
  controller.abort();
  expect(vi.mocked(invoke)).toHaveBeenLastCalledWith(
    "relay_project_git_cancel",
    { id },
  );
  pending.resolve({ status: 200, headers: {}, body: JSON.stringify(empty) });
  await expect(read).rejects.toThrow();
});

it("shares workflow history admission and cooldown with signed queries", async () => {
  const transport = await connectNativeTransport("https://workflow-quota.test");
  assert.exists(transport.workflows);
  const id = "11111111-1111-4111-8111-111111111111";
  const quota = '{"error":"rate-limited: quota exceeded; retry in 60s"}';
  vi.mocked(invoke).mockResolvedValueOnce({
    status: 429,
    headers: {},
    body: quota,
  });
  await expect(
    transport.workflows.runs(id, undefined, new AbortController().signal),
  ).rejects.toMatchObject({ status: 429 });
  const calls = vi.mocked(invoke).mock.calls.length;
  await expect(transport.query([{ kinds: [9], limit: 1 }])).rejects.toThrow(
    "paused",
  );
  expect(vi.mocked(invoke).mock.calls.length).toBe(calls);
});

it("holds the shared admission lease until a cancelled native history request settles", async () => {
  const scope = "https://packaged-admission.test";
  const transport = await connectNativeTransport(scope);
  const workflows = transport.workflows;
  assert.exists(workflows);
  const id = "11111111-1111-4111-8111-111111111111";
  const pending = Array.from({ length: 6 }, () =>
    deferred<{
      status: number;
      headers: Record<string, string>;
      body: string;
    }>(),
  );
  const historyCalls: number[] = [];
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "relay_workflow_runs") {
      const index = historyCalls.push(1) - 1;
      return (
        pending[index]?.promise ??
        Promise.reject(new Error("Unexpected history request"))
      );
    }
    if (command === "relay_http" && (args as Request).path === "/query") {
      requests.push(args as Request);
      return Promise.resolve({ status: 200, headers: {}, body: "[]" });
    }
    return Promise.reject(new Error(`Unexpected command: ${command}`));
  });
  const controllers = pending.map(() => new AbortController());
  const reads = controllers.map((controller) =>
    workflows.runs(id, undefined, controller.signal),
  );
  await vi.waitFor(() => expect(historyCalls).toHaveLength(6));
  const outcomes = reads.map((read) => expect(read).rejects.toThrow());
  for (const controller of controllers) controller.abort();
  const query = transport.query([{ kinds: [9], limit: 1 }]);
  await Promise.resolve();
  expect(requests).toHaveLength(1); // Discovery only; all six IPC requests still hold slots.
  for (const request of pending) {
    request.resolve({
      status: 200,
      headers: {},
      body: '{"runs":[],"next":null}',
    });
  }
  await Promise.all(outcomes);
  await expect(query).resolves.toEqual([]);
  expect(requests.at(-1)?.path).toBe("/query");
});

it("advertises purpose-bound channel capabilities and gates creation on NIP-29", async () => {
  const transport = await connectNativeTransport(community);
  expect(transport.archiveAuthority).toBe(relay.pubkey);
  expect(transport.writer?.kinds).toContain(30078);
  expect(transport.writer?.kinds).not.toContain(9007);
  assert.exists(transport.channelLifecycle);
  assert.exists(transport.channelDetails);
  assert.exists(transport.identityArchive);
  assert.exists(transport.channelKit);
  assert.exists(transport.openDirectMessage);
  vi.mocked(invoke).mockResolvedValueOnce({
    status: 200,
    headers: {},
    body: JSON.stringify({ self: relay.pubkey, supported_nips: [29] }),
  });
  expect((await connectNativeTransport(community)).writer?.kinds).toContain(
    9007,
  );
});

it("routes lifecycle sign/publish separately from the message writer and preserves definitive rejection", async () => {
  const transport = await connectNativeTransport(community);
  assert.exists(transport.channelLifecycle);
  const signal = new AbortController().signal;
  const id = "11111111-1111-4111-8111-111111111111";
  const template = {
    kind: 9002,
    created_at: 1700000010,
    content: "",
    tags: [
      ["h", id],
      ["archived", "true"],
    ],
  };
  const event = signed(viewer, template);
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "identity_restore") return viewer.pubkey;
    if (command === "relay_verify_signatures")
      return nativeSignatureChecks(args);
    if (command === "relay_http")
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ self: relay.pubkey }),
      };
    if (command === "relay_channel_sign") {
      expect(args).toEqual({
        community,
        route: "channel-lifecycle",
        event: template,
      });
      return event;
    }
    if (command === "relay_channel_publish") {
      expect(args).toEqual({ community, route: "channel-lifecycle", event });
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          accepted: true,
          event_id: event.id,
          message: "confirmed",
        }),
      };
    }
    throw new Error(`Unexpected native command: ${command}`);
  });
  expect(await transport.channelLifecycle.sign(template, signal)).toEqual(
    event,
  );
  expect(await transport.channelLifecycle.publish(event, signal)).toBe(
    "confirmed",
  );
  expect(
    vi.mocked(invoke).mock.calls.some(([command]) => command === "relay_sign"),
  ).toBe(false);
  vi.mocked(invoke).mockResolvedValueOnce({
    status: 403,
    headers: {},
    body: JSON.stringify({ error: "denied" }),
  });
  await expect(
    transport.channelLifecycle.publish(event, signal),
  ).rejects.toBeInstanceOf(PublishRejected);
  vi.mocked(invoke).mockResolvedValueOnce({
    status: 429,
    headers: {},
    body: JSON.stringify({ sent: false, error: "rate-limited: try later" }),
  });
  await expect(
    transport.channelLifecycle.publish(event, signal),
  ).rejects.toThrow("rate-limited: unrecognized reason");
});

it("prepares and decodes only verified community-scoped recipe records", async () => {
  const transport = await connectNativeTransport(community);
  assert.exists(transport.channelKit);
  const signal = new AbortController().signal;
  const record = {
    version: 1 as const,
    community,
    deleted: false,
    value: { type: "team" as const, id: "mine", name: "Mine", agents: [] },
  };
  const { coordinate, KIT_TAG } = await import("../channel-templates/model");
  const event = signed(viewer, {
    kind: 30078,
    created_at: 1700000010,
    content: "encrypted",
    tags: [
      ["d", coordinate(record)],
      ["t", KIT_TAG],
    ],
  });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "relay_kit_prepare") {
      expect(args).toEqual({ community, record });
      return "encrypted";
    }
    if (command === "relay_kit_decode") {
      expect(args).toEqual({ community, events: [event] });
      return [{ eventId: event.id, record }];
    }
    throw new Error(`Unexpected native command: ${command}`);
  });
  expect(await transport.channelKit.prepare(record, signal)).toBe("encrypted");
  expect(await transport.channelKit.decode([event], signal)).toEqual([
    { eventId: event.id, record },
  ]);
  await expect(
    transport.channelKit.decode(
      [{ ...event, content: "changed" } as VerifiedEvent],
      signal,
    ),
  ).rejects.toThrow();
});

it("opens direct messages through a purpose-bound command and validates the result", async () => {
  const transport = await connectNativeTransport(community);
  assert.exists(transport.openDirectMessage);
  const id = "11111111-1111-4111-8111-111111111111";
  vi.mocked(invoke).mockResolvedValueOnce(id);
  expect(
    await transport.openDirectMessage(
      [relay.pubkey],
      new AbortController().signal,
    ),
  ).toBe(id);
  expect(vi.mocked(invoke).mock.lastCall).toEqual([
    "relay_direct_message",
    { community, pubkeys: [relay.pubkey] },
  ]);
  vi.mocked(invoke).mockResolvedValueOnce("invalid");
  await expect(
    transport.openDirectMessage([relay.pubkey], new AbortController().signal),
  ).rejects.toThrow("invalid direct message");
});

it("discards a pending observer decode after disconnect and reconnect", async () => {
  const sockets: Socket[] = [];
  class Socket {
    readyState = 1;
    onopen?: (event: Event) => unknown;
    onmessage?: (event: { data: string }) => Promise<void>;
    onclose?: () => void;
    sent: unknown[][] = [];
    constructor() {
      sockets.push(this);
    }
    send(raw: string) {
      this.sent.push(JSON.parse(raw));
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    async receive(value: unknown) {
      await this.onmessage?.({ data: JSON.stringify(value) });
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const decoded = deferred<unknown>();
  const dispatch = vi.mocked(invoke);
  const original = dispatch.getMockImplementation();
  let observerCalls = 0;
  dispatch.mockImplementation(async (command, args) => {
    if (command === "relay_agent_observer") {
      if (++observerCalls === 1) return decoded.promise;
      const event = (args as { event: VerifiedEvent }).event;
      return {
        id: event.id,
        agent: event.pubkey,
        createdAt: event.created_at,
        plaintext: "{}",
      };
    }
    return original?.(command, args);
  });
  const transport = await connectNativeTransport(community);
  const observer = vi.fn();
  const traffic = transport.subscribe?.({
    receive: vi.fn(),
    state: vi.fn(),
    established: vi.fn(),
    denied: vi.fn(),
    observer,
  });
  assert.exists(traffic);
  try {
    const authenticate = async (socket: Socket) => {
      socket.onopen?.(new Event("open"));
      await socket.receive(["AUTH", "nonce"]);
      const proof = socket.sent.find(
        ([kind]) => kind === "AUTH",
      )?.[1] as VerifiedEvent;
      await socket.receive(["OK", proof.id, true]);
    };
    traffic.observe?.(1);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const old = sockets[0];
    assert.exists(old);
    await authenticate(old);
    const route = old.sent.find(
      ([kind, , filter]) =>
        kind === "REQ" &&
        (filter as { kinds?: number[] }).kinds?.includes(24200),
    );
    assert.exists(route);
    await old.receive(["EOSE", route[1]]);
    const frame = signed(keypair(), {
      kind: 24200,
      created_at: 1700000010,
      tags: [["p", viewer.pubkey]],
      content: "cipher",
    });
    await old.receive(["EVENT", route[1], frame]);
    expect(
      dispatch.mock.calls.some(
        ([command]) => command === "relay_agent_observer",
      ),
    ).toBe(true);
    old.onclose?.();
    vi.useRealTimers();
    await vi.waitFor(() => expect(sockets.length).toBe(2));
    const current = sockets[1];
    assert.exists(current);
    await authenticate(current);
    const nextRoute = current.sent.find(
      ([kind, , filter]) =>
        kind === "REQ" &&
        (filter as { kinds?: number[] }).kinds?.includes(24200),
    );
    assert.exists(nextRoute);
    await current.receive(["EOSE", nextRoute[1]]);
    decoded.resolve({
      id: frame.id,
      agent: frame.pubkey,
      createdAt: frame.created_at,
      plaintext: "{}",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(observer).not.toHaveBeenCalled();
    const fresh = signed(keypair(), {
      kind: 24200,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", viewer.pubkey]],
      content: "cipher",
    });
    await current.receive(["EVENT", nextRoute[1], fresh]);
    await vi.waitFor(() => expect(observer).toHaveBeenCalledTimes(1));
    expect(observer.mock.calls[0]?.[0].id).toBe(fresh.id);
  } finally {
    traffic.dispose();
  }
});

it("sorts host memory projections with the same locale collation as the broker", async () => {
  const transport = await connectNativeTransport(community);
  const agent = keypair();
  const entries = ["mem/b", "mem/b_c", "mem/b-c", "mem/b/c", "mem/bc"]
    .reverse()
    .map((slug, i) => ({
      slug,
      body: slug,
      eventId: i.toString(16).padStart(64, "0"),
      createdAt: 1,
    }));
  vi.mocked(invoke).mockResolvedValueOnce({ entries, partial: false });
  expect(
    (
      await transport.readAgentMemories?.(
        agent.pubkey,
        new AbortController().signal,
      )
    )?.entries.map((entry) => entry.slug),
  ).toEqual(["mem/b", "mem/b_c", "mem/b-c", "mem/b/c", "mem/bc"]);
});

it("streams memory pages as they land and cancels native paging on abort", async () => {
  const transport = await connectNativeTransport(community);
  const agent = keypair();
  const entry = (slug: string, i: number) => ({
    slug,
    body: slug,
    eventId: i.toString(16).padStart(64, "0"),
    createdAt: 1,
  });
  let finish: (value: unknown) => void = () => {};
  let readId = "";
  const dispatch = vi.mocked(invoke);
  dispatch.mockImplementationOnce(async (command, args) => {
    expect(command).toBe("relay_agent_memories_read");
    const { id, onPage } = args as { id: string; onPage: { id: string } };
    readId = id;
    progressChannels.get(onPage.id)?.({
      entries: [entry("mem/a", 1)],
      partial: false,
    });
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const pages: string[][] = [];
  const controller = new AbortController();
  const read = transport.readAgentMemories?.(
    agent.pubkey,
    controller.signal,
    undefined,
    (page) => pages.push(page.entries.map((e) => e.slug)),
  );
  await vi.waitFor(() => expect(pages).toEqual([["mem/a"]]));
  // Leaving mid-stream cancels the native read by its ID.
  dispatch.mockResolvedValueOnce(undefined);
  controller.abort();
  expect(dispatch).toHaveBeenLastCalledWith("relay_http_cancel", {
    id: readId,
  });
  finish({ entries: [entry("mem/a", 1), entry("mem/b", 2)], partial: false });
  await expect(read).rejects.toThrow();
});

it("skips a streamed Memory page that fails validation and still answers", async () => {
  const transport = await connectNativeTransport(community);
  const agent = keypair();
  const entry = {
    slug: "mem/a",
    body: "a",
    eventId: "1".padStart(64, "0"),
    createdAt: 1,
  };
  vi.mocked(invoke).mockImplementationOnce(async (_command, args) => {
    const { onPage } = args as { onPage: { id: string } };
    const page = progressChannels.get(onPage.id);
    expect(() => page?.({ entries: [null], partial: true })).not.toThrow();
    page?.({ entries: [entry], partial: true });
    return { entries: [entry], partial: false };
  });
  const pages: string[][] = [];
  await expect(
    transport.readAgentMemories?.(
      agent.pubkey,
      new AbortController().signal,
      undefined,
      (page) => pages.push(page.entries.map((e) => e.slug)),
    ),
  ).resolves.toEqual({ entries: [entry], partial: false });
  expect(pages).toEqual([["mem/a"]]);
});

it("exposes purpose-bound agent readers and fences obsolete observer decoding", async () => {
  const transport = await connectNativeTransport(community);
  expect(transport.agentActivity).toBe(true);
  const signal = new AbortController().signal;
  const agent = keypair();
  const dispatch = vi.mocked(invoke);
  dispatch.mockImplementationOnce(async (command, args) => {
    expect(command).toBe("relay_agent_library");
    expect(args).toEqual({ community });
    return { definitions: [], identities: [] };
  });
  expect(await transport.readAgentLibrary?.(signal)).toEqual({
    definitions: [],
    identities: [],
  });
  dispatch.mockImplementationOnce(async (command, args) => {
    expect(command).toBe("relay_agent_memories_read");
    expect(args).toEqual({
      community,
      agent: agent.pubkey,
      slug: null,
      id: expect.any(String),
      onPage: null,
    });
    return { entries: [], partial: true };
  });
  expect(await transport.readAgentMemories?.(agent.pubkey, signal)).toEqual({
    entries: [],
    partial: true,
  });
  await expect(
    transport.readAgentMemories?.(viewer.pubkey, signal),
  ).rejects.toThrow("Invalid memory target");
  dispatch.mockImplementationOnce(async (command, args) => {
    expect(command).toBe("relay_agent_log_proof");
    expect(args).toEqual({
      community,
      target: {
        id: "id",
        pubkey: agent.pubkey,
        relayUrl: "wss://packaged.test",
        nonce: "nonce",
      },
    });
    return "a".repeat(128);
  });
  expect(
    await transport.authorizeAgentLog?.(
      { id: "id", pubkey: agent.pubkey, relayUrl: "wss://packaged.test" },
      "nonce",
    ),
  ).toBe("a".repeat(128));
  await expect(
    transport.authorizeAgentLog?.(
      { id: "id", pubkey: agent.pubkey, relayUrl: "wss://other.test" },
      "nonce",
    ),
  ).rejects.toThrow("Log authorization unavailable");
  const repository = `${community}/git/${agent.pubkey}/plugins`;
  dispatch.mockImplementationOnce(async (command, args) => {
    expect(command).toBe("relay_git_authorization");
    expect(args).toEqual({ community, repository });
    return "dG9rZW4=";
  });
  expect(await transport.authorizeGit?.(repository)).toEqual({
    repository,
    token: "dG9rZW4=",
  });
  const calls = dispatch.mock.calls.length;
  expect(
    await transport.authorizeGit?.(`https://other.test/git/${agent.pubkey}/x`),
  ).toBeNull();
  expect(dispatch).toHaveBeenCalledTimes(calls);
});

const hash = "c".repeat(64);
it("routes relay media through the authenticated native scheme only", async () => {
  const transport = await connectNativeTransport(community);
  const media = `${community}/media/${hash}.png`;
  expect(transport.media(media)).toBe(
    `buzz-media://localhost/${encodeURIComponent(media)}`,
  );
  expect(transport.media(media, "small")).toBe(
    `buzz-media://localhost/${encodeURIComponent(`${community}/media/${hash}.thumb.webp`)}`,
  );
  expect(transport.media("https://images.test/cat.png")).toBe(
    "https://images.test/cat.png",
  );
  expect(transport.media("http://images.test/cat.png")).toBeUndefined();
});

it("publishes custom emoji sets", async () => {
  const transport = await connectNativeTransport(community);
  expect(transport.writer?.kinds).toContain(30030);
});

it("uploads exact bytes natively and validates the relay descriptor", async () => {
  const transport = await connectNativeTransport(community);
  assert(transport.uploadAttachment);
  uploadResponse = () => ({
    body: {
      url: `${community}/media/${hash}.png`,
      type: "image/png",
      size: 3,
      sha256: hash,
    },
  });
  const file = new File([new Uint8Array([1, 2, 3])], "a.png", {
    type: "image/png",
  });
  await expect(
    transport.uploadAttachment(file, new AbortController().signal),
  ).resolves.toEqual({
    name: "a.png",
    url: `${community}/media/${hash}.png`,
    type: "image/png",
    size: 3,
    sha256: hash,
  });
  expect(uploads).toEqual([
    {
      bytes: new Uint8Array([1, 2, 3]),
      headers: {
        "x-buzz-upload-id": expect.stringMatching(/^[0-9a-f-]{36}$/),
        "x-buzz-community": community,
        "x-buzz-content-type": "image/png",
      },
    },
  ]);
  uploadResponse = () => ({
    body: {
      url: `https://other.test/media/${hash}.png`,
      type: "image/png",
      size: 3,
      sha256: hash,
    },
  });
  await expect(
    transport.uploadAttachment(file, new AbortController().signal),
  ).rejects.toMatchObject({ code: "invalid" });
});

it.each([
  [422, { error: "metadata forbidden" }, "metadata"],
  [415, { error: "unsupported container" }, "rejected"],
  [500, "internal error", "failed"],
])(
  "maps relay upload status %i to a user-facing failure",
  async (status, body, code) => {
    const transport = await connectNativeTransport(community);
    assert(transport.uploadAttachment);
    uploadResponse = () => ({ status, body });
    await expect(
      transport.uploadAttachment(
        new File(["x"], "a.bin"),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code });
  },
);

it("reports native upload bytes through a progress channel only when asked", async () => {
  const transport = await connectNativeTransport(community);
  assert(transport.uploadAttachment);
  uploadResponse = () => ({
    body: {
      url: `${community}/media/${hash}.png`,
      type: "image/png",
      size: 3,
      sha256: hash,
    },
  });
  const file = new File([new Uint8Array([1, 2, 3])], "a.png", {
    type: "image/png",
  });
  const progress = vi.fn();
  await transport.uploadAttachment(
    file,
    new AbortController().signal,
    progress,
  );
  expect(uploads.at(-1)?.headers["x-buzz-upload-progress"]).toMatch(
    /^__CHANNEL__:\d+$/,
  );
  expect(progress.mock.calls).toEqual([
    [0, 3],
    [2, 3],
  ]);
  await transport.uploadAttachment(file, new AbortController().signal);
  expect(uploads.at(-1)?.headers).not.toHaveProperty("x-buzz-upload-progress");
});

it("settles a cancelled native upload at once and cancels it natively", async () => {
  const transport = await connectNativeTransport(community);
  assert(transport.uploadAttachment);
  hangUploads = true;
  const controller = new AbortController();
  const pending = transport.uploadAttachment(
    new File(["x"], "a.bin"),
    controller.signal,
  );
  await vi.waitFor(() =>
    expect(vi.mocked(invoke).mock.calls.at(-1)?.[0]).toBe("relay_upload"),
  );
  const [, , options] = vi.mocked(invoke).mock.calls.at(-1) ?? [];
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(cancels).toEqual([
    (options as { headers: Record<string, string> }).headers[
      "x-buzz-upload-id"
    ],
  ]);
});

it("exposes read-state only for advertised snapshots and keeps signing purpose-bound", async () => {
  const unsupported = await connectNativeTransport(community);
  expect(unsupported.readState).toBeDefined();
  expect(unsupported.readStateSnapshot).toBeUndefined();
  discovery = {
    read_state_snapshot: {
      version: 1,
      community_id: "11111111-1111-4111-8111-111111111111",
    },
  };
  const transport = await connectNativeTransport(community);
  assert.exists(transport.readState);
  assert.exists(transport.readStateSnapshot);
  const signal = new AbortController().signal;
  const blob = {
    v: 1,
    client_id: "fixture",
    contexts: { channel: 1 },
  } as const;
  const event = signed(viewer, {
    kind: 30078,
    created_at: 1700000010,
    tags: [
      ["d", `read-state:${"a".repeat(32)}`],
      ["t", "read-state"],
    ],
    content: "ciphertext",
  });
  vi.mocked(invoke).mockImplementationOnce(async (command, args) => {
    expect(command).toBe("relay_sign_read_state");
    expect(args).toEqual({
      community,
      intent: { slot: "a".repeat(32), createdAt: 1700000010, blob },
    });
    return event;
  });
  expect(
    await transport.readState.sign?.(
      { slot: "a".repeat(32), createdAt: 1700000010, blob },
      signal,
    ),
  ).toEqual(event);
  vi.mocked(invoke).mockImplementationOnce(async (command) => {
    expect(command).toBe("relay_decode_read_state");
    return [{ eventId: event.id, blob }];
  });
  expect(await transport.readState.decode([event], signal)).toEqual([
    { eventId: event.id, blob },
  ]);
  vi.mocked(invoke).mockImplementationOnce(async (command, args) => {
    expect(command).toBe("relay_publish_read_state");
    expect(args).toEqual({ community, event });
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({ accepted: true, event_id: event.id }),
    };
  });
  await transport.readState.publish?.(event, signal);
  expect(requests.every((r) => r.path !== "/events")).toBe(true);
});

it.each([[400, READ_STATE_TIMESTAMP_REFUSAL, true]])(
  "native read-state preserves only definitive timestamp refusal (%s %s)",
  async (status, error, timestamp) => {
    const transport = await connectNativeTransport("https://read-expiry.test");
    assert.exists(transport.readState);
    const event = signed(viewer, {
      kind: 30078,
      created_at: 1700000010,
      tags: [
        ["d", `read-state:${"a".repeat(32)}`],
        ["t", "read-state"],
      ],
      content: "ciphertext",
    });
    vi.mocked(invoke).mockResolvedValueOnce({
      status,
      headers: {},
      body: JSON.stringify({ error }),
    });
    const failure = await transport.readState
      .publish?.(event, new AbortController().signal)
      .catch((value: unknown) => value);
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof ReadStateTimestampRejected).toBe(timestamp);
  },
);

it("native snapshot quota pauses reads and publication on the same principal", async () => {
  discovery = {
    read_state_snapshot: {
      version: 1,
      community_id: "11111111-1111-4111-8111-111111111111",
    },
  };
  const transport = await connectNativeTransport("https://snapshot-quota.test");
  assert.exists(transport.readState);
  const signal = new AbortController().signal;
  const event = signed(viewer, {
    kind: 30078,
    created_at: 1700000010,
    tags: [
      ["d", `read-state:${"a".repeat(32)}`],
      ["t", "read-state"],
    ],
    content: "ciphertext",
  });
  respond = () => ({
    status: 429,
    body: { error: "rate-limited: quota exceeded; retry in 30s" },
  });
  await expect(
    transport.readStateSnapshot?.(signal, "read", "foreground"),
  ).rejects.toThrow("rate-limited: quota exceeded");
  const dispatched = requests.length;
  await expect(
    transport.query([{ kinds: [9], limit: 1 }], signal),
  ).rejects.toThrow("Relay requests paused");
  await expect(transport.readState.publish?.(event, signal)).rejects.toThrow(
    "Relay requests paused",
  );
  expect(requests).toHaveLength(dispatched);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "relay_publish_read_state"),
  ).toBe(false);
});

it("native publication shares quota admission and preserves receipt and IPC failures", async () => {
  discovery = {
    read_state_snapshot: {
      version: 1,
      community_id: "11111111-1111-4111-8111-111111111111",
    },
  };
  const transport = await connectNativeTransport(
    "https://publication-quota.test",
  );
  assert.exists(transport.readState);
  const signal = new AbortController().signal;
  const event = signed(viewer, {
    kind: 30078,
    created_at: 1700000010,
    tags: [
      ["d", `read-state:${"a".repeat(32)}`],
      ["t", "read-state"],
    ],
    content: "ciphertext",
  });
  vi.mocked(invoke).mockResolvedValueOnce({
    status: 200,
    headers: {},
    body: JSON.stringify({
      accepted: false,
      event_id: event.id,
      message: "blocked: read-state quota",
    }),
  });
  await expect(transport.readState.publish?.(event, signal)).rejects.toThrow(
    "blocked: read-state quota",
  );
  vi.mocked(invoke).mockRejectedValueOnce("Relay response was interrupted");
  await expect(transport.readState.publish?.(event, signal)).rejects.toThrow(
    "Relay response was interrupted",
  );
  vi.mocked(invoke).mockResolvedValueOnce({
    status: 429,
    headers: {},
    body: JSON.stringify({
      error: "rate-limited: quota exceeded; retry in 30s",
    }),
  });
  await expect(transport.readState.publish?.(event, signal)).rejects.toThrow(
    "rate-limited: quota exceeded",
  );
  const dispatched = requests.length;
  const publications = vi
    .mocked(invoke)
    .mock.calls.filter(
      ([command]) => command === "relay_publish_read_state",
    ).length;
  await expect(
    transport.query([{ kinds: [9], limit: 1 }], signal),
  ).rejects.toThrow("Relay requests paused");
  await expect(
    transport.readStateSnapshot?.(signal, "read", "foreground"),
  ).rejects.toThrow("Relay requests paused");
  expect(requests).toHaveLength(dispatched);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "relay_publish_read_state"),
  ).toHaveLength(publications);
});

it("holds native publication admission until cancelled IPC settles", async () => {
  const transport = await connectNativeTransport(
    "https://publication-slots.test",
  );
  const readState = transport.readState;
  assert.exists(readState);
  const event = signed(viewer, {
    kind: 30078,
    created_at: 1700000010,
    tags: [
      ["d", `read-state:${"a".repeat(32)}`],
      ["t", "read-state"],
    ],
    content: "ciphertext",
  });
  const gates = Array.from({ length: 6 }, () =>
    deferred<{
      status: number;
      headers: Record<string, string>;
      body: string;
    }>(),
  );
  for (const gate of gates)
    vi.mocked(invoke).mockImplementationOnce(() => gate.promise);
  vi.mocked(invoke).mockResolvedValueOnce({
    status: 200,
    headers: {},
    body: JSON.stringify({ accepted: true, event_id: event.id }),
  });
  const controllers = gates.map(() => new AbortController());
  const publications = controllers.map((controller) =>
    readState.publish?.(event, controller.signal),
  );
  const settled = Promise.allSettled(publications);
  try {
    await vi.waitFor(() =>
      expect(
        vi
          .mocked(invoke)
          .mock.calls.filter(
            ([command]) => command === "relay_publish_read_state",
          ),
      ).toHaveLength(6),
    );
    controllers[0]?.abort();
    const queued = readState.publish?.(event, new AbortController().signal);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(
          ([command]) => command === "relay_publish_read_state",
        ),
    ).toHaveLength(6);
    gates[0]?.resolve({
      status: 200,
      headers: {},
      body: JSON.stringify({ accepted: true, event_id: event.id }),
    });
    await vi.waitFor(() =>
      expect(
        vi
          .mocked(invoke)
          .mock.calls.filter(
            ([command]) => command === "relay_publish_read_state",
          ),
      ).toHaveLength(7),
    );
    await expect(queued).resolves.toBeUndefined();
  } finally {
    for (const gate of gates)
      gate.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify({ accepted: true, event_id: event.id }),
      });
    await settled;
  }
});

it("reads the complete snapshot and activity through the native query route", async () => {
  discovery = {
    read_state_snapshot: {
      version: 1,
      community_id: "11111111-1111-4111-8111-111111111111",
    },
  };
  const transport = await connectNativeTransport(community);
  const signal = new AbortController().signal;
  respond = () => ({
    body: {
      read_state_snapshot: 1,
      complete: true,
      pubkey: viewer.pubkey,
      community_id: "11111111-1111-4111-8111-111111111111",
      snapshot_id: "a".repeat(64),
      events: [],
    },
  });
  await expect(
    transport.readStateSnapshot?.(signal, "read", "foreground"),
  ).resolves.toEqual([]);
  expect(JSON.parse(requests.at(-1)?.body ?? "null")).toEqual([
    {
      kinds: [30078],
      authors: [viewer.pubkey],
      read_state_snapshot: 1,
    },
  ]);
  const activity = message(viewer, "channel", "recent", 1700000000);
  respond = () => ({ body: [activity] });
  await expect(
    transport.channelActivity?.(["channel"], signal),
  ).resolves.toEqual([activity]);
  expect(JSON.parse(requests.at(-1)?.body ?? "null")).toEqual([
    {
      kinds: [9, 40002, 40008, 45001, 45003],
      "#h": ["channel"],
      limit: 1,
    },
  ]);
  await expect(
    transport.channelActivity?.(["bad/channel"], signal),
  ).rejects.toThrow("Activity filter rejected");
});

it("prepares HEIC and video in the native upload without dev-broker fetches", async () => {
  const transport = await connectNativeTransport(community);
  assert(transport.uploadAttachment);
  preparedResponse = () => ({
    body: {
      url: `${community}/media/${hash}.jpg`,
      type: "image/jpeg",
      size: 5,
      sha256: hash,
    },
  });
  const heic = new File(
    [new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99])],
    "a.heic",
    { type: "image/heic" },
  );
  await expect(
    transport.uploadAttachment(heic, new AbortController().signal),
  ).resolves.toMatchObject({
    name: "a.jpg",
    type: "image/jpeg",
    size: 5,
  });
  expect(uploads.at(-1)?.headers).toMatchObject({
    "x-buzz-preparation": "image:mov",
    "x-buzz-community": community,
  });
  preparedResponse = () => ({
    body: {
      url: `${community}/media/${hash}.mp4`,
      type: "video/mp4",
      size: 7,
      sha256: hash,
    },
  });
  const avi = new File(
    [new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 65, 86, 73, 32])],
    "b.avi",
    { type: "video/avi" },
  );
  await expect(
    transport.uploadAttachment(avi, new AbortController().signal),
  ).resolves.toMatchObject({
    name: "b.mp4",
    type: "video/mp4",
    size: 7,
  });
  expect(uploads.at(-1)?.headers["x-buzz-preparation"]).toBe("video:avi");
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  [403, { error: "no access" }, "denied"],
  [400, { code: "io" }, "io"],
])(
  "maps prepared-upload response %i through the shared policy",
  async (status, body, code) => {
    const transport = await connectNativeTransport(community);
    assert(transport.uploadAttachment);
    preparedResponse = () => ({ status, body });
    const avi = new File(
      [new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 65, 86, 73, 32])],
      "b.avi",
      { type: "video/avi" },
    );
    await expect(
      transport.uploadAttachment(avi, new AbortController().signal),
    ).rejects.toMatchObject({ code });
  },
);

it("refuses native preparation failures and does not accept a mismatched prepared type", async () => {
  const transport = await connectNativeTransport(community);
  assert(transport.uploadAttachment);
  const heic = new File(
    [new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99])],
    "a.heic",
  );
  preparedResponse = () => ({ status: 503, body: { code: "ffmpeg" } });
  await expect(
    transport.uploadAttachment(heic, new AbortController().signal),
  ).rejects.toMatchObject({ code: "ffmpeg" });
  preparedResponse = () => ({
    body: {
      url: `${community}/media/${hash}.mp4`,
      type: "video/mp4",
      size: 3,
      sha256: hash,
    },
  });
  await expect(
    transport.uploadAttachment(heic, new AbortController().signal),
  ).rejects.toMatchObject({ code: "invalid" });
});

it("routes member administration through the native purpose-bound writer, never the generic signer", async () => {
  const transport = await connectNativeTransport(community);
  const writer = transport.memberAdministration;
  assert.exists(writer);
  const signal = new AbortController().signal;
  for (const { event: template } of memberContract.accepted) {
    const event = signed(viewer, template);
    vi.mocked(invoke).mockResolvedValueOnce(event);
    expect(await writer.sign(template, signal)).toEqual(event);
    expect(vi.mocked(invoke).mock.lastCall).toEqual([
      "relay_channel_sign",
      { community, route: "member-administration", event: template },
    ]);
    vi.mocked(invoke).mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: JSON.stringify({
        accepted: true,
        event_id: event.id,
        message: "confirmed",
      }),
    });
    await writer.publish(event, signal);
    expect(vi.mocked(invoke).mock.lastCall).toEqual([
      "relay_channel_publish",
      { community, route: "member-administration", event },
    ]);
  }
  const calls = vi.mocked(invoke).mock.calls.length;
  for (const { event } of memberContract.rejected)
    await expect(writer.sign(event, signal)).rejects.toThrow();
  const template = memberContract.accepted[0]?.event;
  assert.exists(template);
  const channelTag = template.tags[0];
  assert.exists(channelTag);
  await expect(
    writer.sign(
      { ...template, tags: [channelTag, ["p", viewer.pubkey]] },
      signal,
    ),
  ).rejects.toThrow();
  await expect(
    writer.publish(signed(relay, template), signal),
  ).rejects.toThrow();
  const aborted = AbortSignal.abort();
  await expect(writer.sign(template, aborted)).rejects.toThrow();
  expect(vi.mocked(invoke).mock.calls).toHaveLength(calls);
  vi.mocked(invoke).mockResolvedValueOnce(signed(relay, template));
  await expect(writer.sign(template, signal)).rejects.toThrow();
  vi.mocked(invoke).mockResolvedValueOnce({
    status: 403,
    headers: {},
    body: JSON.stringify({ error: "denied" }),
  });
  await expect(
    writer.publish(signed(viewer, template), signal),
  ).rejects.toBeInstanceOf(PublishRejected);
  expect(
    vi.mocked(invoke).mock.calls.some(([command]) => command === "relay_sign"),
  ).toBe(false);
});

it("reads only bounded slices and waits for chunk acknowledgement", async () => {
  const transport = await connectNativeTransport(community);
  assert(transport.uploadAttachment);
  const file = new File([new Uint8Array(2 * 64 * 1024 + 3)], "large.bin");
  const wholeRead = vi
    .spyOn(file, "arrayBuffer")
    .mockRejectedValue(new Error("whole-file reads forbidden"));
  const slices = vi.spyOn(file, "slice");
  const original = vi.mocked(invoke).getMockImplementation();
  assert(original);
  const first = deferred<null>();
  let chunkCalls = 0;
  vi.mocked(invoke).mockImplementation(async (command, args, options) => {
    if (command === "relay_upload_chunk" && ++chunkCalls === 1)
      await first.promise;
    return original(command, args, options);
  });
  uploadResponse = () => ({
    body: {
      url: `${community}/media/${"a".repeat(64)}`,
      type: "application/octet-stream",
      size: file.size,
      sha256: "a".repeat(64),
    },
  });
  const pending = transport.uploadAttachment(
    file,
    new AbortController().signal,
  );
  try {
    await vi.waitFor(() => expect(chunkCalls).toBe(1));
    expect(slices.mock.calls).toEqual([
      [0, 4096],
      [0, 64 * 1024],
    ]);
  } finally {
    first.resolve(null);
  }
  await pending;
  expect(wholeRead).not.toHaveBeenCalled();
  const chunks = vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "relay_upload_chunk");
  expect(chunks.map(([, bytes]) => (bytes as ArrayBuffer).byteLength)).toEqual([
    64 * 1024,
    64 * 1024,
    3,
  ]);
});

it("cancellation during ingress prevents further chunks and final upload", async () => {
  const transport = await connectNativeTransport(community);
  assert(transport.uploadAttachment);
  const original = vi.mocked(invoke).getMockImplementation();
  assert(original);
  const gate = deferred<null>();
  let entered = false;
  vi.mocked(invoke).mockImplementation(async (command, args, options) => {
    if (command === "relay_upload_chunk") {
      entered = true;
      await gate.promise;
    }
    return original(command, args, options);
  });
  const controller = new AbortController();
  const pending = transport.uploadAttachment(
    new File([new Uint8Array(128 * 1024)], "large.bin"),
    controller.signal,
  );
  await vi.waitFor(() => expect(entered).toBe(true));
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  gate.resolve(null);
  await vi.waitFor(() =>
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "relay_upload_cancel"),
    ).toHaveLength(1),
  );
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "relay_upload_chunk"),
  ).toHaveLength(1);
  expect(uploads).toHaveLength(0);
});

it.each([
  { live: false, incremental: false },
  { live: true, incremental: false },
  { live: false, incremental: true },
  { live: true, incremental: true },
])(
  "keeps live and incremental artifact capabilities separate: %j",
  async ({ live, incremental }) => {
    discovery = {
      artifacts: {
        ...(live ? { sync: { version: 1 } } : {}),
        ...(incremental ? { incremental: ARTIFACT_INCREMENTAL_LIMITS } : {}),
      },
    };
    const transport = await connectNativeTransport(community);
    expect(transport.artifactSync).toBe(live ? true : undefined);
    expect(transport.artifactIncremental !== undefined).toBe(incremental);
  },
);

it.each([
  "incremental_limit",
  "incremental_reset",
  "incremental_invalid",
  "incremental_unsupported_scope",
  "incremental_unavailable",
])("preserves %s through native admission", async (code) => {
  discovery = { artifacts: { incremental: ARTIFACT_INCREMENTAL_LIMITS } };
  const transport = await connectNativeTransport(community);
  respond = () => ({
    status: 422,
    body: { error: "scope or capacity", code },
  });
  assert.exists(transport.artifactIncremental);
  const work = transport.artifactIncremental.delta(
    { artifact: "current", kinds: [45010], "#type": ["task"] },
    {},
    new AbortController().signal,
  );
  await expect(work).rejects.toBeInstanceOf(ArtifactIncrementalError);
  await expect(work).rejects.toMatchObject({ code });
});

it.each([
  ["sign-in", 401, "authentication required\n"],
  ["access", 403, "authorization denied\n"],
  ["access", 403, JSON.stringify({ error: "relay_membership_required" })],
])(
  "a refused response reports its %s refusal to the community's observer without the window event",
  async (kind, status, body) => {
    // This test environment has no Tauri window, so the event listener never
    // installs: only the response itself can report the refusal.
    const transport = await connectNativeTransport(community);
    const refusals: string[] = [];
    const stop = transport.observeRefusal?.((refusal) =>
      refusals.push(refusal),
    );
    const answer = vi.mocked(invoke).getMockImplementation();
    vi.mocked(invoke).mockImplementation(async (command, args, options) =>
      command === "relay_http" && (args as Request).path === "/query"
        ? { status, headers: {}, body }
        : answer?.(command, args, options),
    );
    await expect(
      transport.query([{ kinds: [9], "#h": ["channel"], limit: 10 }]),
    ).rejects.toThrow();
    expect(refusals).toEqual([kind]);
    stop?.();
  },
);

it("an ordinary 403 reports no community refusal", async () => {
  const transport = await connectNativeTransport(community);
  const refusals: string[] = [];
  const stop = transport.observeRefusal?.((refusal) => refusals.push(refusal));
  respond = () => ({
    status: 403,
    body: { error: "restricted: not a channel member" },
  });
  await expect(
    transport.query([{ kinds: [9], "#h": ["channel"], limit: 10 }]),
  ).rejects.toThrow();
  expect(refusals).toEqual([]);
  stop?.();
});

it("a refused unsigned GET reports no community refusal", async () => {
  // Native signs only POST and reports refusals only for signed requests.
  const transport = await connectNativeTransport(community);
  const refusals: string[] = [];
  const stop = transport.observeRefusal?.((refusal) => refusals.push(refusal));
  const answer = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation(async (command, args, options) =>
    command === "relay_http" && (args as Request).method === "GET"
      ? { status: 401, headers: {}, body: "authentication required\n" }
      : answer?.(command, args, options),
  );
  const response = await nativeRelayRequest(community, "/gated");
  expect(response.status).toBe(401);
  expect(refusals).toEqual([]);
  stop?.();
});
