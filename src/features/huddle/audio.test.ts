import { afterEach, assert, expect, it, vi } from "vitest";
import { openHuddleAudio } from "./audio";
afterEach(() => vi.unstubAllGlobals());
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function stream() {
  const track = { enabled: true, onended: null, stop: vi.fn() };
  return { track, getTracks: () => [track], getAudioTracks: () => [track] };
}
function harness() {
  const initial = stream();
  const getUserMedia = vi.fn(async () => initial);
  const media = Object.assign(new EventTarget(), {
    getUserMedia,
    enumerateDevices: async () => [
      { kind: "audioinput", deviceId: "mic", label: "USB mic" },
      { kind: "audiooutput", deviceId: "speaker", label: "Speaker" },
    ],
  });
  vi.stubGlobal("navigator", { mediaDevices: media });
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const output = node();
  const routed = { ...node(), stream: stream() };
  const sources: ReturnType<typeof node>[] = [];
  const bufferSource = () => ({
    ...node(),
    buffer: null,
    onended: null,
    start: vi.fn(),
    stop: vi.fn(),
  });
  const context = {
    currentTime: 0,
    createBuffer: vi.fn((_channels: number, length: number, rate: number) => ({
      duration: length / rate,
      copyToChannel: vi.fn(),
    })),
    createBufferSource: vi.fn(bufferSource),
    sampleRate: 48000,
    destination: {},
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    createGain: () => output,
    createMediaStreamDestination: () => routed,
    createMediaStreamSource: vi.fn(() => {
      const value = node();
      sources.push(value);
      return value;
    }),
    audioWorklet: { addModule: async () => {} },
  };
  vi.stubGlobal(
    "AudioContext",
    vi.fn(function AudioContext() {
      return context;
    }),
  );
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      connect = vi.fn();
      disconnect = vi.fn();
      port = { onmessage: null, close: vi.fn() };
    },
  );
  const elements: FakeAudio[] = [];
  class FakeAudio {
    srcObject: unknown;
    setSinkId = vi.fn(async (_id: string) => {});
    play = vi.fn(async () => {});
    pause = vi.fn();
    constructor() {
      elements.push(this);
    }
  }
  vi.stubGlobal(
    "HTMLMediaElement",
    class {
      setSinkId() {}
    },
  );
  vi.stubGlobal("Audio", FakeAudio);
  const abort = new AbortController();
  const open = async () => {
    const audio = await openHuddleAudio(vi.fn(), vi.fn(), abort.signal);
    assert.exists(audio.settings);
    await audio.settings.refresh();
    return { ...audio, settings: audio.settings };
  };
  return {
    initial,
    getUserMedia,
    sources,
    context,
    output,
    routed,
    elements,
    abort,
    open,
  };
}
it("switches microphone only after acquisition, preserving mute and the old input on failure", async () => {
  const h = harness();
  const audio = await h.open();
  try {
    audio.mute(true);
    const next = stream();
    const pending = deferred<typeof next>();
    h.getUserMedia.mockReturnValueOnce(pending.promise);
    const change = audio.settings.select("input", "mic");
    expect(h.initial.track.stop).not.toHaveBeenCalled();
    pending.resolve(next);
    await change;
    expect(h.getUserMedia).toHaveBeenLastCalledWith({
      audio: expect.objectContaining({ deviceId: { exact: "mic" } }),
    });
    expect(next.track.enabled).toBe(false);
    expect(h.initial.track.stop).toHaveBeenCalledOnce();
    expect(h.sources[0]?.disconnect).toHaveBeenCalledOnce();
    h.getUserMedia.mockRejectedValueOnce(new Error("device removed"));
    await audio.settings.select("input", "");
    expect(audio.settings.snapshot().input).toBe("mic");
    expect(next.track.stop).not.toHaveBeenCalled();
    audio.mute(false);
    expect(next.track.enabled).toBe(true);
    audio.close();
    expect(next.track.stop).toHaveBeenCalledOnce();
  } finally {
    audio.close();
  }
});
it("releases a replacement microphone that arrives after leaving", async () => {
  const h = harness();
  const audio = await h.open();
  const next = stream();
  const pending = deferred<typeof next>();
  h.getUserMedia.mockReturnValueOnce(pending.promise);
  const change = audio.settings.select("input", "mic");
  h.abort.abort();
  pending.resolve(next);
  await change;
  expect(next.track.stop).toHaveBeenCalledOnce();
  expect(h.context.createMediaStreamSource).toHaveBeenCalledTimes(1);
});
it("routes playback through the selected speaker and releases the route on close", async () => {
  const h = harness();
  const audio = await h.open();
  await audio.settings.select("output", "speaker");
  expect(h.elements[0]?.setSinkId).toHaveBeenCalledWith("speaker");
  expect(h.elements[0]?.play).toHaveBeenCalledOnce();
  expect(h.output.connect).toHaveBeenCalledWith(h.routed);
  expect(h.output.disconnect).toHaveBeenCalledWith(h.context.destination);
  await audio.settings.select("output", "");
  expect(h.elements[0]?.setSinkId).toHaveBeenLastCalledWith("");
  audio.close();
  expect(h.elements[0]?.pause).toHaveBeenCalledOnce();
  expect(h.elements[0]?.srcObject).toBeNull();
  expect(h.routed.stream.track.stop).toHaveBeenCalledOnce();
});
it("cleans up a speaker route that completes after leaving", async () => {
  const h = harness();
  const audio = await h.open();
  // Intercept the newly created element's permission before it starts playing.
  const permission = deferred<void>();
  vi.stubGlobal(
    "Audio",
    class {
      srcObject: unknown;
      setSinkId = () => permission.promise;
      play = vi.fn(async () => {});
      pause = vi.fn();
    },
  );
  const changing = audio.settings.select("output", "speaker");
  audio.close();
  permission.resolve();
  await changing;
  expect(h.output.connect).not.toHaveBeenCalledWith(h.routed);
  expect(h.routed.stream.track.stop).toHaveBeenCalledOnce();
});

it("keeps the original speaker route if selection is rejected", async () => {
  const h = harness();
  const audio = await h.open();
  const pause = vi.fn();
  vi.stubGlobal(
    "Audio",
    class {
      srcObject: unknown;
      setSinkId = async () => {
        throw new Error("permission denied");
      };
      pause = pause;
    },
  );
  try {
    await audio.settings.select("output", "speaker");
    expect(audio.settings.snapshot().output).toBe("");
    expect(audio.settings.snapshot().error).toContain("previous device");
    expect(h.output.disconnect).not.toHaveBeenCalled();
    expect(h.output.connect).not.toHaveBeenCalledWith(h.routed);
    expect(pause).toHaveBeenCalledOnce();
    expect(h.routed.stream.track.stop).toHaveBeenCalledOnce();
  } finally {
    audio.close();
  }
});

it("keeps near-miss playback contiguous while audio remains queued", async () => {
  const h = harness();
  const audio = await h.open();
  try {
    const frame = Array(480).fill(0.25);
    audio.play("peer", frame);
    expect(
      h.context.createBufferSource.mock.results[0]?.value.start,
    ).toHaveBeenCalledWith(0.06);
    h.context.currentTime = 0.065;
    audio.play("peer", frame);
    expect(
      h.context.createBufferSource.mock.results[1]?.value.start.mock
        .calls[0]?.[0],
    ).toBeCloseTo(0.07);
  } finally {
    audio.close();
  }
});

it("restarts a real playback underrun at 20 ms and keeps catch-up frames contiguous", async () => {
  const h = harness();
  const audio = await h.open();
  try {
    const frame = Array(480).fill(0.25);
    audio.play("peer", frame);
    h.context.currentTime = 0.1;
    audio.play("peer", frame);
    audio.play("peer", frame);
    expect(
      h.context.createBufferSource.mock.results[1]?.value.start.mock
        .calls[0]?.[0],
    ).toBeCloseTo(0.12);
    expect(
      h.context.createBufferSource.mock.results[2]?.value.start.mock
        .calls[0]?.[0],
    ).toBeCloseTo(0.13);
  } finally {
    audio.close();
  }
});

it("drops frames beyond the 200 ms queue cap and resumes as the queue drains", async () => {
  const h = harness();
  const audio = await h.open();
  try {
    const frame = Array(4800).fill(0.25);
    audio.play("peer", frame);
    audio.play("peer", frame);
    // The two 100 ms buffers end at 260 ms, beyond the cap.
    audio.play("peer", frame);
    expect(h.context.createBufferSource).toHaveBeenCalledTimes(2);
    expect(h.context.createBuffer).toHaveBeenCalledTimes(2);
    h.context.currentTime = 0.1;
    audio.play("peer", frame);
    expect(h.context.createBufferSource).toHaveBeenCalledTimes(3);
    expect(
      h.context.createBufferSource.mock.results[2]?.value.start.mock
        .calls[0]?.[0],
    ).toBeCloseTo(0.26);
  } finally {
    audio.close();
  }
});
