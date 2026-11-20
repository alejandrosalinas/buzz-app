import { afterEach, expect, it, vi } from "vitest";
import { openVoice } from "./voice";
import { createHuddleVoices } from "../../features/huddle/voice";
import type { Agents } from "../../features/agents/service";
import type { RelayData } from "../../features/relay/service";
import type { AppServer, Wire } from "./rpc";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function fixture(resume = Promise.resolve()) {
  const decoder = {
    muted: false,
    srcObject: null as unknown,
    play: vi.fn(async () => {}),
    pause: vi.fn(),
  };
  vi.stubGlobal(
    "Audio",
    vi.fn(function AudioMock() {
      return decoder;
    }),
  );
  vi.stubGlobal(
    "MediaStream",
    vi.fn(function MediaStreamMock(tracks) {
      return { tracks };
    }),
  );
  const tracks = [{ stop: vi.fn() }];
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const source = {
    ...node(),
    start: vi.fn(),
    stop: vi.fn(),
    buffer: undefined,
  };
  const context = {
    ...node(),
    createBuffer: vi.fn((_channels: number, length: number, rate: number) => ({
      duration: length / rate,
      copyToChannel: vi.fn(),
    })),
    createBufferSource: vi.fn(() => source),
    currentTime: 0,
    sampleRate: 48000,
    destination: {},
    resume: vi.fn(() => resume),
    close: vi.fn(async () => {}),
    audioWorklet: { addModule: vi.fn(async () => {}) },
    createMediaStreamDestination: () => ({
      ...node(),
      stream: { getTracks: () => tracks },
    }),
    createMediaStreamSource: () => node(),
  };
  const events = {
    onmessage: null as null | ((event: { data: string }) => void),
  };
  const thinking = vi.fn();
  const peer = {
    connectionState: "new",
    onconnectionstatechange: () => {},
    ontrack: (_event: { track: { kind: string } }) => {},
    close: vi.fn(),
    addTrack: vi.fn(),
    createDataChannel: vi.fn(() => events),
    createOffer: async () => ({ type: "offer", sdp: "offer" }),
    setLocalDescription: vi.fn(async () => {}),
    localDescription: { sdp: "offer" },
    setRemoteDescription: vi.fn(async () => {
      peer.connectionState = "connected";
      peer.onconnectionstatechange();
    }),
  };
  const capture = {
    ...node(),
    port: {
      onmessage: null as null | ((event: { data: Float32Array }) => void),
      close: vi.fn(),
    },
  };
  vi.stubGlobal(
    "AudioContext",
    vi.fn(function AudioContextMock() {
      return context;
    }),
  );
  vi.stubGlobal(
    "RTCPeerConnection",
    vi.fn(function RTCPeerConnectionMock() {
      return peer;
    }),
  );
  vi.stubGlobal(
    "AudioWorkletNode",
    vi.fn(function AudioWorkletNodeMock() {
      return capture;
    }),
  );
  const listeners = new Set<(wire: Wire) => void>();
  const emit = (wire: Wire) => {
    for (const listener of listeners) listener(wire);
  };
  const rpc = {
    onMessage: (listener: (wire: Wire) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request: vi.fn(async (method: string) => {
      if (method === "thread/realtime/start")
        emit({
          method: "thread/realtime/sdp",
          params: { threadId: "thread", sdp: "answer" },
        });
      return {};
    }),
  };
  const abort = new AbortController();
  const ended = vi.fn();
  const output = vi.fn(async (_samples: number[]) => {});
  const open = (
    send: (samples: number[]) => Promise<void> = output,
    voice?: string,
  ) =>
    openVoice(
      rpc as unknown as AppServer,
      "thread",
      abort.signal,
      send,
      ended,
      "instructions",
      thinking,
      voice,
    );
  return {
    open,
    events,
    thinking,
    abort,
    ended,
    output,
    rpc,
    context,
    source,
    peer,
    capture,
    tracks,
    listeners,
    decoder,
  };
}
it("keeps incoming WebRTC audio decoding and releases its muted sink on close", async () => {
  const f = fixture();
  const connection = await f.open();
  f.peer.ontrack({ track: { kind: "audio" } });
  expect(f.decoder.muted).toBe(true);
  expect(f.decoder.play).toHaveBeenCalledOnce();
  expect(f.decoder.srcObject).toEqual({ tracks: [{ kind: "audio" }] });
  await connection.close();
  expect(f.decoder.pause).toHaveBeenCalledOnce();
  expect(f.decoder.srcObject).toBeNull();
});
it("forwards output while the seat is busy and cuts it on close", async () => {
  const f = fixture();
  const connection = await f.open();
  expect(f.rpc.request).toHaveBeenCalledWith(
    "thread/realtime/start",
    expect.objectContaining({
      clientManagedHandoffs: false,
      version: "v3",
      transport: { type: "webrtc", sdp: "offer" },
    }),
  );
  const sending = deferred<void>();
  f.output.mockImplementationOnce(() => sending.promise);
  const frame = { data: new Float32Array(960).fill(0.2) };
  f.capture.port.onmessage?.(frame);
  f.capture.port.onmessage?.(frame);
  expect(f.output).toHaveBeenCalledTimes(2);
  f.abort.abort();
  await connection.close();
  sending.resolve();
  expect(f.capture.port.onmessage).toBeNull();
  expect(f.peer.close).toHaveBeenCalledTimes(1);
  expect(f.listeners.size).toBe(0);
  expect(f.rpc.request).toHaveBeenCalledWith("thread/realtime/stop", {
    threadId: "thread",
  });
  expect(f.ended).not.toHaveBeenCalled();
});
it("abort settles startup even when autoplay resume never resolves", async () => {
  const f = fixture(new Promise(() => {}));
  const opening = f.open();
  f.abort.abort();
  await expect(opening).rejects.toThrow("closed");
  expect(f.context.close).toHaveBeenCalledTimes(1);
  expect(f.rpc.request).not.toHaveBeenCalled();
});
it("times out a stalled audio graph and reports one failure", async () => {
  vi.useFakeTimers();
  const f = fixture(new Promise(() => {}));
  const opening = expect(f.open()).rejects.toThrow("closed");
  await vi.advanceTimersByTimeAsync(30_000);
  await opening;
  expect(f.ended).toHaveBeenCalledTimes(1);
  expect(f.ended).toHaveBeenCalledWith(
    expect.objectContaining({ message: "Codex voice connection timed out" }),
  );
});
it("awaits a late start before stopping and releasing an aborted open", async () => {
  const f = fixture();
  const started = deferred<void>();
  const release = deferred<void>();
  f.rpc.request.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
    return {};
  });
  let settled = false;
  const opening = f.open().finally(() => {
    settled = true;
  });
  const rejected = expect(opening).rejects.toThrow("closed");
  await started.promise;
  f.abort.abort();
  expect(f.peer.close).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  expect(f.rpc.request).not.toHaveBeenCalledWith(
    "thread/realtime/stop",
    expect.anything(),
  );
  release.resolve();
  await rejected;
  expect(f.rpc.request).toHaveBeenLastCalledWith("thread/realtime/stop", {
    threadId: "thread",
  });
});

it("schedules native 480-sample owner frames for 10 ms", async () => {
  const f = fixture();
  const connection = await f.open();
  connection.input(Array(480).fill(0.2));
  expect(f.context.createBuffer).toHaveBeenCalledWith(1, 480, 48000);
  expect(f.context.createBuffer.mock.results[0]?.value.duration).toBe(0.01);
  expect(f.source.start).toHaveBeenNthCalledWith(1, 0.02);
  connection.input(Array(480).fill(0.2));
  expect(f.source.start).toHaveBeenNthCalledWith(2, 0.03);
  await connection.close();
});
it("keeps owner frames contiguous while audio remains queued", async () => {
  const f = fixture();
  const connection = await f.open();
  connection.input(Array(480).fill(0.2));
  f.context.currentTime = 0.023;
  connection.input(Array(480).fill(0.2));
  expect(f.source.start.mock.calls[1]?.[0]).toBeCloseTo(0.03);
  await connection.close();
});
it("rejects empty and oversized owner frames before allocating audio", async () => {
  const f = fixture();
  const connection = await f.open();
  connection.input([]);
  connection.input(Array(5761).fill(0.2));
  expect(f.context.createBuffer).not.toHaveBeenCalled();
  expect(f.source.start).not.toHaveBeenCalled();
  await connection.close();
});

it("delivers every captured frame through the real seat during a slow bridge send", async () => {
  const f = fixture();
  const gate = deferred<void>();
  const send = vi.fn(async (_id: string, _samples: number[]) => gate.promise);
  const subscribe = () => () => {};
  const destination = {
    viewer: "owner",
    scope: "scope",
    relayUrl: "https://relay.example.com",
    channelId: "parent",
    channelName: "Parent",
  };
  const dispose = createHuddleVoices(
    {
      snapshot: () => ({
        phase: "connected",
        id: "call",
        room: "room",
        muted: false,
        participants: ["owner"],
        destination,
      }),
      subscribe,
      voiceListening: vi.fn(),
      voiceThinking: vi.fn(),
    },
    {
      snapshot: () => ({
        status: "ready",
        running: [
          {
            pubkey: "agent",
            key: "agent",
            owner: "owner",
            name: "Agent",
            type: "codex",
            place: "here",
            relay: destination.relayUrl,
          },
        ],
      }),
      subscribe,
      types: () => [
        {
          key: "codex",
          voice: (seat: { output(samples: number[]): Promise<void> }) =>
            f.open(seat.output),
        },
      ],
    } as unknown as Agents,
    {
      snapshot: () => ({
        status: "ready",
        scope: "scope",
        viewer: "owner",
        session: {
          channels: {
            subscribeList: subscribe,
            get: () => ({ members: ["agent"] }),
          },
        },
      }),
      subscribe,
    } as unknown as RelayData,
    {
      available: true,
      open: async () => {},
      close: async () => {},
      touch: async () => {},
      send,
    },
    vi.fn(),
  );
  try {
    await vi.waitFor(() => expect(f.peer.connectionState).toBe("connected"));
    // Five worklet frames (100 ms) arrive before the first invoke completes.
    for (let i = 0; i < 5; i++)
      f.capture.port.onmessage?.({ data: new Float32Array(960).fill(i / 8) });
    expect(send).toHaveBeenCalledTimes(1);
    gate.resolve();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(5));
    expect(send.mock.calls.map(([, samples]) => samples[0])).toEqual([
      0,
      1 / 8,
      2 / 8,
      3 / 8,
      4 / 8,
    ]);
  } finally {
    gate.resolve();
    await dispose();
  }
});

it("projects realtime thinking until speech, completion or interruption, and ignores closed events", async () => {
  const f = fixture();
  const connection = await f.open();
  for (const end of [
    "output_audio_buffer.started",
    "response.done",
    "input_audio_buffer.speech_started",
  ]) {
    f.events.onmessage?.({
      data: JSON.stringify({ type: "response.created" }),
    });
    expect(f.thinking).toHaveBeenLastCalledWith(true);
    f.events.onmessage?.({ data: JSON.stringify({ type: end }) });
    expect(f.thinking).toHaveBeenLastCalledWith(false);
  }
  f.events.onmessage?.({ data: "invalid" });
  await connection.close();
  f.thinking.mockClear();
  f.events.onmessage?.({ data: JSON.stringify({ type: "response.created" }) });
  expect(f.thinking).not.toHaveBeenCalled();
});

it.each(["cove", "maple", ""])(
  "starts realtime with the assigned voice %s",
  async (voice) => {
    const f = fixture();
    const connection = await f.open(f.output, voice);
    const start = vi
      .mocked(f.rpc.request as unknown as AppServer["request"])
      .mock.calls.find(([method]) => method === "thread/realtime/start");
    expect(start?.[1]).toEqual(expect.objectContaining({ threadId: "thread" }));
    if (voice) expect(start?.[1]).toHaveProperty("voice", voice);
    else expect(start?.[1]).not.toHaveProperty("voice");
    await connection.close();
  },
);
