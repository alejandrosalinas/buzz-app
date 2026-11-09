import { addChannelMember } from "../channel-members/members";
vi.mock("../channel-members/members", () => ({
  addChannelMember: vi.fn(async () => {}),
}));
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it, vi } from "vitest";
import type { ChannelSummary } from "../relay/contracts";
import type { RelayData, RelaySnapshot } from "../relay/service";
import { keypair, signed } from "../relay/testing";
import { createRelaySession } from "../relay/session";
import type { HuddleAudio, OpenHuddleAudio } from "./audio";
import type { HuddleBridge, HuddleDestination, HuddleUpdate } from "./bridge";
import { createHuddles, provideHuddleStatus } from "./service";

const destination: HuddleDestination = {
  channelId: "00000000-0000-4000-8000-000000000001",
  channelName: "Design",
  scope: "https://relay.example:viewer",
  relayUrl: "wss://relay.example",
  viewer: "ab".repeat(32),
};
function deferred<T>() {
  let resolve = (_: T) => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function harness(
  initialChannels: ChannelSummary[] = [
    {
      id: destination.channelId,
      name: "Design",
      members: [destination.viewer],
    },
  ],
  dmAgent?: Parameters<typeof createHuddles>[3],
) {
  let channels = initialChannels;
  let partial = false;
  const accessListeners = new Set<() => void>();
  const store = createRelaySession(null);
  const read = vi.fn<typeof store.session.read>(async () => []);
  let connection: RelaySnapshot = {
    status: "ready",
    generation: 1,
    scope: destination.scope,
    viewer: destination.viewer,
    session: {
      ...store.session,
      read,
      channels: {
        ...store.session.channels,
        subscribeList(fn: () => void) {
          accessListeners.add(fn);
          return () => {
            accessListeners.delete(fn);
          };
        },
        resolve: async () => {},
        get: (id) => channels.find((channel) => channel.id === id),
        list: () => ({
          status: "ready",
          channels,
          ...(partial ? { coverage: "partial" as const } : {}),
        }),
      },
    },
  };
  const changes = new Set<() => void>();
  const relay: RelayData = {
    snapshot: () => connection,
    subscribe(fn) {
      changes.add(fn);
      return () => {
        changes.delete(fn);
      };
    },
    retry() {},
    disconnect() {},
    async clearCache() {},
  };
  const audio: HuddleAudio = {
    close: vi.fn(),
    mute: vi.fn(),
    play: vi.fn(),
    participants: vi.fn(),
  };
  let receive = (_: HuddleUpdate) => {};
  let send = (_: number[]) => {};
  const bridge: HuddleBridge = {
    available: true,
    open: vi.fn(async (_id, _context, _room, fn) => {
      receive = fn;
    }),
    close: vi.fn(async () => {}),
    touch: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
  };
  const openAudio = vi.fn<OpenHuddleAudio>(async (fn) => {
    send = fn;
    return audio;
  });
  const service = createHuddles(relay, bridge, openAudio, dmAgent);
  return {
    service,
    read,
    bridge,
    audio,
    openAudio,
    receive: (e: HuddleUpdate) => receive(e),
    send: (pcm: number[]) => send(pcm),
    access(next: ChannelSummary[], incomplete = false) {
      channels = next;
      partial = incomplete;
      for (const fn of accessListeners) fn();
    },
    replace() {
      connection = { ...connection, generation: 2, status: "disconnected" };
      for (const fn of changes) fn();
    },
    async dispose() {
      await service.dispose();
      store.dispose();
    },
  };
}
describe("Huddle lifetime", () => {
  it("keeps arrival order across unordered roster snapshots and treats rejoining as new", async () => {
    const h = harness();
    await h.service.join(destination);
    h.receive({ type: "connected", room: "room", participants: ["first"] });
    h.receive({ type: "participants", participants: ["new", "first"] });
    expect(h.service.snapshot().participants).toEqual([
      destination.viewer,
      "first",
      "new",
    ]);
    h.receive({
      type: "participants",
      participants: ["first", "new", "first"],
    });
    expect(h.service.snapshot().participants).toEqual([
      destination.viewer,
      "first",
      "new",
    ]);
    h.receive({ type: "participants", participants: ["new"] });
    expect(h.service.snapshot().participants).toEqual([
      destination.viewer,
      "new",
    ]);
    h.receive({ type: "participants", participants: ["first", "new"] });
    expect(h.service.snapshot().participants).toEqual([
      destination.viewer,
      "new",
      "first",
    ]);
    await h.dispose();
  });
  it.each(["not a member", "huddle has ended"])(
    "removes an unavailable candidate after relay admission rejection: %s",
    async (error) => {
      const h = harness();
      await h.service.join(destination, "archived-room");
      h.receive({ type: "ended", error });
      await vi.waitFor(() => expect(h.service.snapshot().phase).toBe("error"));
      expect(h.service.canJoin(destination.scope, "archived-room")).toBe(false);
      expect(h.service.canJoin("other-community", "archived-room")).toBe(true);
      await h.dispose();
    },
  );
  it("sends only while connected/unmuted and releases capture on leave", async () => {
    const h = harness();
    await h.service.join(destination);
    h.send([1]);
    expect(h.bridge.send).not.toHaveBeenCalled();
    h.receive({ type: "connected", room: "room", participants: [] });
    h.send([1]);
    expect(h.bridge.send).toHaveBeenCalledTimes(1);
    h.service.mute();
    expect(h.audio.mute).toHaveBeenCalledWith(true);
    h.send([2]);
    expect(h.bridge.send).toHaveBeenCalledTimes(1);
    await h.service.leave();
    expect(h.audio.close).toHaveBeenCalledTimes(1);
    expect(h.bridge.close).toHaveBeenCalledTimes(1);
    expect(h.service.snapshot().phase).toBe("idle");
    h.receive({ type: "connected", room: "late", participants: [] });
    expect(h.service.snapshot().phase).toBe("idle");
    await h.dispose();
  });
  it("cancels an outstanding permission prompt and allows another attempt", async () => {
    const h = harness();
    const pending = deferred<HuddleAudio>();
    h.openAudio.mockImplementationOnce(() => pending.promise);
    const joining = h.service.join(destination);
    await h.service.leave();
    expect(h.service.snapshot().phase).toBe("idle");
    pending.resolve(h.audio);
    await joining;
    expect(h.audio.close).toHaveBeenCalledTimes(1);
    expect(h.bridge.open).not.toHaveBeenCalled();
    await h.service.join(destination);
    expect(h.bridge.open).toHaveBeenCalledTimes(1);
    await h.dispose();
  });
  it("closes the exact late native opening on community replacement", async () => {
    const h = harness();
    const opening = deferred<void>();
    vi.mocked(h.bridge.open).mockReturnValueOnce(opening.promise);
    const joining = h.service.join(destination);
    await vi.waitFor(() => expect(h.bridge.open).toHaveBeenCalled());
    h.replace();
    expect(h.audio.close).toHaveBeenCalled();
    opening.resolve();
    await joining;
    await vi.waitFor(() => expect(h.bridge.close).toHaveBeenCalled());
    expect(h.service.snapshot().phase).toBe("error");
    await h.dispose();
  });
  it("plugin disposal ends the call even with no mounted panel", async () => {
    const h = harness();
    await h.service.join(destination);
    h.receive({
      type: "connected",
      room: "room",
      participants: ["cd".repeat(32)],
    });
    await h.dispose();
    expect(h.bridge.close).toHaveBeenCalledTimes(1);
    expect(h.audio.close).toHaveBeenCalledTimes(1);
    h.receive({ type: "audio", peer: "late", samples: [1] });
    expect(h.audio.play).not.toHaveBeenCalled();
  });
  it("permission rejection never starts a remote call", async () => {
    const h = harness();
    h.openAudio.mockRejectedValueOnce(new Error("Microphone access denied"));
    await h.service.join(destination);
    expect(h.bridge.open).not.toHaveBeenCalled();
    expect(h.service.snapshot().error).toBe("Microphone access denied");
    await h.dispose();
  });
  it("rejects stale destination context before accessing the microphone", async () => {
    const h = harness();
    await h.service.join({ ...destination, scope: "other" });
    expect(h.openAudio).not.toHaveBeenCalled();
    expect(h.bridge.open).not.toHaveBeenCalled();
    await h.dispose();
  });
});

it("direct start joins the newest discovered room, or creates one if none exists", async () => {
  const h = harness();
  const creator = keypair();
  const room = "00000000-0000-4000-8000-000000000002";
  h.read.mockResolvedValueOnce([
    signed(creator, {
      kind: 48100,
      tags: [["h", destination.channelId]],
      created_at: Math.floor(Date.now() / 1000),
      content: JSON.stringify({ ephemeral_channel_id: room }),
    }),
  ]);
  try {
    await h.service.start(destination);
    expect(h.bridge.open).toHaveBeenLastCalledWith(
      expect.any(String),
      destination,
      room,
      expect.any(Function),
    );
    await h.service.leave();
    await h.service.start(destination);
    expect(h.bridge.open).toHaveBeenLastCalledWith(
      expect.any(String),
      destination,
      undefined,
      expect.any(Function),
    );
  } finally {
    await h.dispose();
  }
});
it("cancelling during discovery prevents microphone and native call creation", async () => {
  const h = harness();
  const reading = deferred<[]>();
  h.read.mockReturnValueOnce(reading.promise);
  try {
    const starting = h.service.start(destination);
    expect(h.service.snapshot().phase).toBe("connecting");
    await h.service.leave();
    reading.resolve([]);
    await starting;
    expect(h.openAudio).not.toHaveBeenCalled();
    expect(h.bridge.open).not.toHaveBeenCalled();
    expect(h.service.snapshot().phase).toBe("idle");
  } finally {
    await h.dispose();
  }
});

it("tracks simultaneous speakers independently and clears mute, departure, silence and teardown", async () => {
  vi.useFakeTimers();
  const h = harness();
  try {
    await h.service.join(destination);
    h.receive({
      type: "connected",
      room: "room",
      participants: ["alex", "sam"],
    });
    h.send([0.2]);
    h.receive({ type: "audio", peer: "alex", samples: [0.1] });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.service.snapshot().speakers).toEqual({
      [destination.viewer]: 1,
      alex: 0.6,
    });
    h.service.mute();
    expect(h.service.snapshot().speakers).toEqual({ alex: 0.6 });
    h.receive({ type: "audio", peer: "sam", samples: [0.2] });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.service.snapshot().speakers).toEqual({ alex: 0.6, sam: 1 });
    h.receive({ type: "participants", participants: ["sam"] });
    expect(h.service.snapshot().speakers).toEqual({ sam: 1 });
    h.receive({ type: "audio", peer: "alex", samples: [1] });
    expect(h.service.snapshot().speakers).toEqual({ sam: 1 });
    await vi.advanceTimersByTimeAsync(300);
    expect(h.service.snapshot().speakers).toEqual({});
    expect(h.service.snapshot().level).toBe(0);
    h.receive({ type: "audio", peer: "sam", samples: [0.2] });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.service.snapshot().speakers).toEqual({ sam: 1 });
    await h.service.leave();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.service.snapshot().phase).toBe("idle");
    expect(h.service.snapshot().speakers).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await h.dispose();
    vi.useRealTimers();
  }
});

it("joins an explicitly invited room without parent access, then leaves on revoked room membership", async () => {
  const room = "00000000-0000-4000-8000-000000000002";
  const memberRoom: ChannelSummary = {
    id: room,
    name: "Huddle",
    huddle: true as const,
    parentChannelId: destination.channelId,
    members: [destination.viewer],
  };
  const h = harness([memberRoom]);
  await h.service.join(destination, room);
  expect(h.bridge.open).toHaveBeenCalledWith(
    expect.any(String),
    destination,
    room,
    expect.any(Function),
  );
  h.receive({ type: "connected", room, participants: [] });
  h.access([{ ...memberRoom, members: [] }], true);
  await vi.waitFor(() => expect(h.audio.close).toHaveBeenCalled());
  await h.dispose();
});
it.each(["wrong-parent", "archived", "cached", "not-member", "new-call"])(
  "rejects %s room admission before microphone capture",
  async (failure) => {
    const room = "00000000-0000-4000-8000-000000000002";
    const h = harness([
      {
        id: room,
        name: "Huddle",
        huddle: true,
        parentChannelId:
          failure === "wrong-parent" ? "other" : destination.channelId,
        ...(failure === "archived" ? { archived: true as const } : {}),
        ...(failure === "cached" ? { cached: true as const } : {}),
        members: failure === "not-member" ? [] : [destination.viewer],
      },
    ]);
    await h.service.join(
      destination,
      failure === "new-call" ? undefined : room,
    );
    expect(h.openAudio).not.toHaveBeenCalled();
    expect(h.bridge.open).not.toHaveBeenCalled();
    await h.dispose();
  },
);

it("leaves immediately for an archived parent even while discovery is partial", async () => {
  const h = harness();
  await h.service.join(destination);
  h.access(
    [{ id: destination.channelId, name: "Design", archived: true }],
    true,
  );
  await vi.waitFor(() => expect(h.audio.close).toHaveBeenCalled());
  await h.dispose();
});

it.each(["readOnly", "cached", "not-member", "missing"])(
  "does not replace revoked %s parent access with automatic room membership",
  async (reason) => {
    const room = "00000000-0000-4000-8000-000000000002";
    const h = harness();
    await h.service.join(destination, room);
    h.receive({ type: "connected", room, participants: [] });
    const parent = {
      id: destination.channelId,
      name: "Design",
      members: [destination.viewer],
    };
    const invited = {
      id: room,
      name: "Huddle",
      huddle: true as const,
      parentChannelId: destination.channelId,
      members: [destination.viewer],
    };
    h.access([parent, invited]);
    expect(h.audio.close).not.toHaveBeenCalled();
    h.access(
      reason === "missing"
        ? [invited]
        : [
            invited,
            {
              ...parent,
              ...(reason === "not-member"
                ? { members: [] }
                : { [reason]: true }),
            },
          ],
      reason !== "missing",
    );
    await vi.waitFor(() => expect(h.audio.close).toHaveBeenCalledOnce());
    await h.dispose();
  },
);
it.each([
  { readOnly: true as const },
  { cached: true as const },
  { members: [] },
])(
  "rejects invalid parent admission before microphone capture: %j",
  async (invalid) => {
    const h = harness([
      {
        id: destination.channelId,
        name: "Design",
        members: [destination.viewer],
        ...invalid,
      },
    ]);
    await h.service.join(destination);
    expect(h.openAudio).not.toHaveBeenCalled();
    await h.dispose();
  },
);

it("accepts listening state only for the current connected call", async () => {
  const h = harness();
  await h.service.join(destination, "room");
  h.receive({ type: "connected", room: "room", participants: [] });
  const id = h.service.snapshot().id;
  if (!id) throw new Error("Missing call id");
  h.service.voiceListening("stale", "agent", true);
  expect(h.service.snapshot().listening).toBeUndefined();
  h.service.voiceListening(id, "agent", true);
  expect(h.service.snapshot().listening).toEqual(["agent"]);
  h.service.voiceListening("stale", "agent", false);
  expect(h.service.snapshot().listening).toEqual(["agent"]);
  h.service.voiceListening(id, "agent", false);
  expect(h.service.snapshot().listening).toEqual([]);
  await h.service.leave();
  h.service.voiceListening(id, "agent", true);
  expect(h.service.snapshot().listening).toBeUndefined();
  await h.service.dispose();
});

it("ignores voice errors and dismissals from a previous call", async () => {
  const h = harness();
  try {
    await h.service.join(destination, "room");
    h.receive({ type: "connected", room: "room", participants: [] });
    const previous = h.service.snapshot().id;
    if (!previous) throw new Error("Missing previous call id");
    await h.service.leave();
    await h.service.join(destination, "room");
    h.receive({ type: "connected", room: "room", participants: [] });
    const current = h.service.snapshot().id;
    if (!current) throw new Error("Missing current call id");
    expect(current).not.toBe(previous);
    h.service.voiceError(previous, "Late close failure");
    expect(h.service.snapshot().error).toBeUndefined();
    h.service.voiceError(current, "Current voice failure");
    expect(h.service.snapshot().error).toBe("Current voice failure");
    h.service.voiceError(previous);
    expect(h.service.snapshot().error).toBe("Current voice failure");
    h.service.voiceError(current);
    expect(h.service.snapshot().error).toBeUndefined();
  } finally {
    await h.dispose();
  }
});

it("publishes this document's call phase to optional consumers until Huddles unloads", async () => {
  const h = harness();
  const leaving = deferred<void>();
  vi.mocked(h.bridge.close).mockReturnValueOnce(leaving.promise);
  const root = new Context();
  const provider = root.plugin({
    apply: (ctx: Context) => provideHuddleStatus(ctx, h.service),
  });
  await provider;
  const seen: string[] = [];
  let withdrawn = false;
  const consumer = root.plugin({
    apply(ctx: Context) {
      ctx.inject(["huddleStatus"], (scope) => {
        const status = scope.huddleStatus;
        if (!status) throw new Error("inject ran without the service");
        expect(status.version).toBe(1);
        const record = () => {
          const phase = status.phase();
          if (seen.at(-1) !== phase) seen.push(phase);
        };
        record();
        scope.effect(() => status.subscribe(record));
        scope.effect(() => () => {
          withdrawn = true;
        });
      });
    },
  });
  await consumer;
  await h.service.join(destination);
  h.receive({ type: "connected", room: "room", participants: [] });
  const left = h.service.leave();
  expect(h.service.snapshot().phase).toBe("leaving");
  leaving.resolve();
  await left;
  expect(seen).toEqual(["idle", "connecting", "connected", "leaving", "idle"]);
  expect(Object.isFrozen(root.reflect.get("huddleStatus"))).toBe(true);
  await provider.dispose();
  expect(root.reflect.get("huddleStatus")).toBeUndefined();
  await vi.waitFor(() => expect(withdrawn).toBe(true));
  await consumer.dispose();
  await h.dispose();
});

it("preserves a five-frame capture burst while IPC is in flight", async () => {
  const h = harness();
  const gate = deferred<void>();
  const send = vi.mocked(h.bridge.send);
  send.mockImplementationOnce(() => gate.promise);
  try {
    await h.service.join(destination);
    h.receive({
      type: "connected",
      room: "room",
      participants: [destination.viewer],
    });
    for (let i = 0; i < 5; i++) h.send(Array(960).fill(i / 10));
    expect(send).toHaveBeenCalledTimes(1);
    gate.resolve();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(5));
    expect(send.mock.calls.map(([, pcm]) => pcm[0])).toEqual([
      0, 0.1, 0.2, 0.3, 0.4,
    ]);
  } finally {
    gate.resolve();
    await h.dispose();
  }
});

it.each(["mute", "leave", "failure"])(
  "discards pending human audio on %s",
  async (action) => {
    const h = harness();
    const gate = deferred<void>();
    const send = vi.mocked(h.bridge.send);
    send.mockImplementationOnce(async () => {
      await gate.promise;
      if (action === "failure") throw new Error("send failed");
    });
    try {
      await h.service.join(destination);
      h.receive({
        type: "connected",
        room: "room",
        participants: [destination.viewer],
      });
      h.send(Array(960).fill(0.1));
      h.send(Array(960).fill(0.2));
      if (action === "mute") {
        h.service.mute();
        h.send(Array(960).fill(0.3));
        h.service.mute();
        h.send(Array(960).fill(0.4));
      } else if (action === "leave") await h.service.leave();
      gate.resolve();
      if (action === "mute") {
        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
        expect(send.mock.calls.map(([, pcm]) => pcm[0])).toEqual([0.1, 0.4]);
      } else {
        if (action === "failure")
          await vi.waitFor(() =>
            expect(h.service.snapshot().phase).toBe("error"),
          );
        await send.mock.results[0]?.value.catch(() => {});
        h.send(Array(960).fill(0.5));
        expect(send).toHaveBeenCalledTimes(1);
      }
    } finally {
      gate.resolve();
      await h.dispose();
    }
  },
);

describe("automatic DM voice invitation", () => {
  const room = {
    id: "room",
    name: "Huddle",
    channelType: "stream" as const,
    huddle: true as const,
    parentChannelId: destination.channelId,
    members: [destination.viewer],
  };
  const parent = {
    id: destination.channelId,
    name: "DM",
    channelType: "dm" as const,
    members: [destination.viewer, "agent"],
  };
  it("adds the eligible agent once to the verified room after connection", async () => {
    vi.mocked(addChannelMember).mockClear();
    const h = harness([parent, room], () => "agent");
    try {
      await h.service.start(destination);
      expect(addChannelMember).not.toHaveBeenCalled();
      h.receive({ type: "connected", room: "room", participants: [] });
      await vi.waitFor(() => expect(addChannelMember).toHaveBeenCalledTimes(1));
      expect(addChannelMember).toHaveBeenCalledWith(
        expect.anything(),
        "room",
        "agent",
        expect.any(AbortSignal),
      );
      h.receive({ type: "connected", room: "room", participants: [] });
      await Promise.resolve();
      expect(addChannelMember).toHaveBeenCalledTimes(1);
    } finally {
      await h.dispose();
    }
  });
  it.each(["leave", "ineligible", "wrong-parent", "already-member"])(
    "does not grant access after %s",
    async (scenario) => {
      vi.mocked(addChannelMember).mockClear();
      let eligible = true;
      const h = harness(
        [
          parent,
          {
            ...room,
            parentChannelId:
              scenario === "wrong-parent" ? "other" : destination.channelId,
            members:
              scenario === "already-member"
                ? [destination.viewer, "agent"]
                : room.members,
          },
        ],
        () => (eligible ? "agent" : undefined),
      );
      try {
        await h.service.start(destination);
        h.receive({ type: "connected", room: "room", participants: [] });
        if (scenario === "leave") await h.service.leave();
        if (scenario === "ineligible") eligible = false;
        await Promise.resolve();
        await Promise.resolve();
        expect(addChannelMember).not.toHaveBeenCalled();
      } finally {
        await h.dispose();
      }
    },
  );
  it.each([
    ["explicit room", "room"],
    ["discovered room", undefined],
  ])("never invites when joining an existing call (%s)", async (_, joined) => {
    vi.mocked(addChannelMember).mockClear();
    const h = harness([parent, room], () => "agent");
    try {
      await h.service.join(destination, joined);
      h.receive({ type: "connected", room: "room", participants: [] });
      await Promise.resolve();
      await Promise.resolve();
      expect(addChannelMember).not.toHaveBeenCalled();
    } finally {
      await h.dispose();
    }
  });
  it("clears only its own invitation warning once the agent is in the room", async () => {
    vi.mocked(addChannelMember).mockRejectedValueOnce(new Error("Offline"));
    const h = harness([parent, room], () => "agent");
    try {
      await h.service.start(destination);
      h.receive({ type: "connected", room: "room", participants: [] });
      await vi.waitFor(() =>
        expect(h.service.snapshot().error).toContain("Couldn’t add the agent"),
      );
      h.access([parent, { ...room, members: [destination.viewer, "agent"] }]);
      expect(h.service.snapshot().error).toBeUndefined();
      const id = h.service.snapshot().id ?? "";
      h.service.voiceError(id, "Agent: Voice disconnected");
      h.access([parent, { ...room, members: [destination.viewer, "agent"] }]);
      expect(h.service.snapshot().error).toBe("Agent: Voice disconnected");
    } finally {
      await h.dispose();
    }
  });
  it("does not resurrect a warning when the agent joins before the rejected invite settles", async () => {
    let reject = (_: Error) => {};
    vi.mocked(addChannelMember).mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const h = harness([parent, room], () => "agent");
    try {
      await h.service.start(destination);
      h.receive({ type: "connected", room: "room", participants: [] });
      await vi.waitFor(() => expect(addChannelMember).toHaveBeenCalled());
      h.access([parent, { ...room, members: [destination.viewer, "agent"] }]);
      reject(new Error("Timed out"));
      await new Promise((resolve) => setTimeout(resolve));
      expect(h.service.snapshot().error).toBeUndefined();
    } finally {
      await h.dispose();
    }
  });
  it("keeps the human connected and exposes a failed invitation", async () => {
    vi.mocked(addChannelMember).mockRejectedValueOnce(new Error("Offline"));
    const h = harness([parent, room], () => "agent");
    try {
      await h.service.start(destination);
      h.receive({ type: "connected", room: "room", participants: [] });
      await vi.waitFor(() =>
        expect(h.service.snapshot().error).toContain(
          "Couldn’t add the agent: Offline",
        ),
      );
      expect(h.service.snapshot().phase).toBe("connected");
    } finally {
      await h.dispose();
    }
  });
});

it("clears thinking on leave and ignores callbacks from an old call", async () => {
  const h = harness();
  try {
    await h.service.join(destination);
    h.receive({ type: "connected", room: "room", participants: ["agent"] });
    const id = h.service.snapshot().id;
    if (!id) throw new Error("Missing call id");
    h.service.voiceThinking("old", "agent", true);
    expect(h.service.snapshot().thinking).toBeUndefined();
    h.service.voiceThinking(id, "agent", true);
    expect(h.service.snapshot().thinking).toEqual(["agent"]);
    await h.service.leave();
    h.service.voiceThinking(id, "agent", true);
    expect(h.service.snapshot().thinking).toBeUndefined();
  } finally {
    await h.dispose();
  }
});
