import { afterEach, expect, it, vi } from "vitest";
import type { Agent, Agents } from "../agents/service";
import type { RelayData, RelaySnapshot } from "../relay/service";
import type { EventData } from "../relay/events";
import { remoteDmVoiceCalls, withRemoteDmVoiceCalls } from "./remote-dm-voice";
import { createHuddleVoices } from "./voice";
import type { Huddles, HuddleSnapshot } from "./service";
import type { HuddleBridge, HuddleUpdate } from "./bridge";

const owner = "a".repeat(64),
  peer = "b".repeat(64),
  authority = "c".repeat(64);
const parent = "00000000-0000-4000-8000-000000000001",
  room = "00000000-0000-4000-8000-000000000002";
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanups.splice(0).reverse()) await stop();
});
function fixture() {
  const channels = new Set<() => void>(),
    views = new Set<() => void>(),
    connections = new Set<() => void>(),
    local = new Set<() => void>();
  const subscribe = (set: Set<() => void>) => (fn: () => void) => {
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  };
  const now = Math.floor(Date.now() / 1000);
  const event = (
    kind: number,
    author: string,
    at = now,
    member = owner,
    admission = "phone",
    generation = "1",
  ): EventData => ({
    id: `${kind}-${at}-${author}`,
    pubkey: author,
    kind,
    created_at: at,
    content: JSON.stringify({
      ephemeral_channel_id: room,
      generation,
      admission_id: admission,
    }),
    tags: [
      ["h", parent],
      ["p", member],
    ],
  });
  let events = [event(48100, owner, now - 2)];
  const dm = {
    id: parent,
    name: "Codex",
    channelType: "dm",
    members: [owner, peer],
  };
  const backing = {
    id: room,
    name: "Huddle",
    huddle: true,
    parentChannelId: parent,
    members: [owner, peer],
  };
  const agent = {
    pubkey: peer,
    key: peer,
    owner,
    relay: "https://example.org",
    type: "buzz.codex/codex",
    place: "here",
    name: "Codex",
  } as Agent;
  const input = vi.fn(),
    close = vi.fn();
  const voice = vi.fn(async () => ({ input, close }));
  const agents = {
    snapshot: () => ({ status: "ready", running: [agent] }),
    subscribe: subscribe(channels),
    types: () => [{ key: agent.type, voice }],
  } as unknown as Agents;
  const view = {
    snapshot: () => ({ events, status: "ready" }),
    subscribe: subscribe(views),
    refresh: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  let connection = {
    status: "ready",
    scope: "scope",
    viewer: owner,
    origin: "https://example.org",
    session: {
      viewer: owner,
      relayAuthor: authority,
      observe: vi.fn(() => view),
      channels: {
        list: () => ({ channels: [dm, backing] }),
        get: (id: string) => (id === room ? backing : dm),
        resolve: vi.fn(async () => {}),
        subscribeList: subscribe(channels),
      },
      agentChoices: {
        snapshot: () => ({ selectable: [{ pubkey: peer }] }),
        subscribe: subscribe(channels),
        ensure: vi.fn(),
      },
    },
  } as unknown as RelaySnapshot;
  const relay = {
    snapshot: () => connection,
    subscribe: subscribe(connections),
  } as RelayData;
  let localCall: HuddleSnapshot = {
    phase: "idle",
    muted: false,
    participants: [],
  };
  const huddles = {
    snapshot: () => localCall,
    subscribe: subscribe(local),
    voiceListening: vi.fn(),
    voiceThinking: vi.fn(),
  } as unknown as Huddles;
  const remote = remoteDmVoiceCalls(relay, agents);
  cleanups.push(() => remote.dispose());
  let receive: ((event: HuddleUpdate) => void) | undefined;
  const bridge: HuddleBridge = {
    available: true,
    open: vi.fn(async (_id, _target, _room, callback) => {
      receive = callback;
      callback({ type: "connected", room, participants: [owner, peer] });
    }),
    close: vi.fn(async () => {}),
    touch: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
  };
  const report = vi.fn();
  const stop = createHuddleVoices(
    withRemoteDmVoiceCalls(huddles, remote),
    agents,
    relay,
    bridge,
    report,
  );
  cleanups.push(stop);
  return {
    remote,
    bridge,
    voice,
    close,
    input,
    report,
    resolve: connection.session.channels.resolve as ReturnType<typeof vi.fn>,
    backing,
    agent,
    emit(
      kind: number,
      author = authority,
      at = now,
      member = owner,
      admission = "phone",
      generation = "1",
    ) {
      events = [
        ...events,
        event(kind, author, at, member, admission, generation),
      ];
      for (const f of views) f();
    },
    notify() {
      for (const f of [...channels]) f();
    },
    disconnect() {
      connection = { ...connection, status: "disconnected" } as RelaySnapshot;
      for (const f of connections) f();
    },
    local(phase: HuddleSnapshot["phase"]) {
      localCall = { ...localCall, phase };
      for (const f of local) f();
    },
    audio(sender: string) {
      receive?.({ type: "audio", peer: sender, samples: [0] });
    },
    now,
    stop,
  };
}
it("seats a phone caller's Codex peer without opening a desktop human call, and stops on leave", async () => {
  const f = fixture();
  expect(f.bridge.open).not.toHaveBeenCalled();
  f.emit(48101);
  await vi.waitFor(() => expect(f.voice).toHaveBeenCalledOnce());
  expect(f.bridge.open).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ channelId: parent, viewer: owner }),
    room,
    expect.any(Function),
    peer,
  );
  f.audio("stranger");
  f.audio(owner);
  expect(f.input).toHaveBeenCalledExactlyOnceWith([0]);
  f.emit(48102, authority, f.now + 1);
  await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
});
it.each([
  "forged",
  "other-owner",
  "not-in-room",
  "wrong-parent",
  "protected",
  "unsupported",
])("does not seat %s", async (reason) => {
  const f = fixture();
  if (reason === "not-in-room") f.backing.members = [owner];
  if (reason === "wrong-parent") f.backing.parentChannelId = "other";
  if (reason === "protected") Object.assign(f.agent, { protection: {} });
  if (reason === "unsupported")
    Object.assign(f.agent, { type: "buzz.claude/claude" });
  f.emit(
    48101,
    reason === "forged" ? owner : authority,
    f.now,
    reason === "other-owner" ? peer : owner,
  );
  if (reason === "not-in-room" || reason === "wrong-parent") {
    await vi.waitFor(() =>
      expect(f.resolve.mock.settledResults[0]?.type).toBe("fulfilled"),
    );
  } else expect(f.remote.snapshot().phase).toBe("idle");
  expect(f.voice).not.toHaveBeenCalled();
  await f.stop();
});
it("tears down on community disconnection", async () => {
  const f = fixture();
  f.emit(48101);
  await vi.waitFor(() => expect(f.voice).toHaveBeenCalledOnce());
  f.disconnect();
  await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
});
it("does not race the local connection while it is opening", async () => {
  const f = fixture();
  f.local("connecting");
  f.emit(48101);
  await f.stop();
  expect(f.voice).not.toHaveBeenCalled();
});

it("keeps voice while another owner device leaves, and accepts a same-second rejoin", async () => {
  const f = fixture();
  f.emit(48101);
  await vi.waitFor(() => expect(f.voice).toHaveBeenCalledOnce());
  f.emit(48101, authority, f.now, owner, "tablet");
  f.emit(48102, authority, f.now, owner, "phone");
  expect(f.remote.snapshot().phase).toBe("connected");
  expect(f.close).not.toHaveBeenCalled();
  f.emit(48102, authority, f.now, owner, "tablet");
  await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
  f.emit(48101, authority, f.now, owner, "new-phone");
  await vi.waitFor(() => expect(f.voice).toHaveBeenCalledTimes(2));
});
it.each([
  ["2", "1"],
  [
    "22222222-2222-4222-8222-222222222222",
    "11111111-1111-4111-8111-111111111111",
  ],
])(
  "ignores delayed departures from an older relay generation %s",
  async (current, previous) => {
    const f = fixture();
    f.emit(48101, authority, f.now, owner, "new", current);
    await vi.waitFor(() => expect(f.voice).toHaveBeenCalledOnce());
    f.emit(48102, authority, f.now + 1, owner, "old", previous);
    expect(f.close).not.toHaveBeenCalled();
    expect(f.remote.snapshot().phase).toBe("connected");
  },
);
it("rechecks a near-future start when the phone clock is ahead", async () => {
  vi.useFakeTimers();
  const f = fixture();
  vi.setSystemTime((f.now - 3) * 1000);
  f.emit(48101, authority, f.now - 2);
  expect(f.remote.snapshot().phase).toBe("idle");
  await vi.advanceTimersByTimeAsync(1100);
  expect(f.remote.snapshot().phase).toBe("connected");
  await f.stop();
  vi.useRealTimers();
});
