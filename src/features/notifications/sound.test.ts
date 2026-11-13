import { afterEach, assert, expect, it, vi } from "vitest";
import { isSoundName, playNotificationSound } from "./sound";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

function harness() {
  const contexts: ReturnType<typeof makeContext>[] = [];
  const started = vi.fn();
  const resume = vi.fn(async () => {});
  function makeContext() {
    const source = {
      buffer: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(() => started()),
      stop: vi.fn(),
      onended: null as (() => void) | null,
    };
    return {
      source,
      destination: {},
      resume,
      close: vi.fn(async () => {}),
      decodeAudioData: vi.fn(async (_bytes: ArrayBuffer) => ({})),
      createBufferSource: vi.fn(() => source),
    };
  }
  vi.stubGlobal(
    "AudioContext",
    vi.fn(function AudioContext() {
      const context = makeContext();
      contexts.push(context);
      return context;
    }),
  );
  const bytes = new ArrayBuffer(4);
  const fetch = vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => bytes,
  }));
  vi.stubGlobal("fetch", fetch);
  const audio = vi.fn();
  vi.stubGlobal("Audio", audio);
  return { contexts, fetch, audio, bytes, started, resume };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("stays silent without Web Audio or for Silent, without falling back to a media element", () => {
  const audio = vi.fn();
  vi.stubGlobal("Audio", audio);
  expect(playNotificationSound("doong")).toBeNull();
  const env = harness();
  expect(isSoundName("silent")).toBe(true);
  expect(playNotificationSound("silent")).toBeNull();
  expect(env.contexts).toHaveLength(0);
  expect(audio).not.toHaveBeenCalled();
  expect(env.audio).not.toHaveBeenCalled();
});

it("plays a one-shot buffer, restarts the same sound, and releases audio resources on completion", async () => {
  const env = harness();
  const first = playNotificationSound("ping");
  assert(first);
  await vi.waitFor(() => expect(env.started).toHaveBeenCalledOnce());
  expect(env.fetch).toHaveBeenCalledWith("/sounds/ping.mp3", {
    signal: expect.any(AbortSignal),
  });
  const context = env.contexts[0];
  assert(context);
  expect(context.decodeAudioData).toHaveBeenCalledWith(env.bytes);
  expect(context.source.connect).toHaveBeenCalledWith(context.destination);
  const second = playNotificationSound("ping");
  assert(second);
  await first.finished;
  expect(context.source.stop).toHaveBeenCalledOnce();
  expect(context.close).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(env.started).toHaveBeenCalledTimes(2));
  const next = env.contexts[1];
  assert(next);
  next.source.onended?.();
  await second.finished;
  second.stop();
  expect(next.source.onended).toBeNull();
  expect(next.source.disconnect).toHaveBeenCalledOnce();
  expect(next.close).toHaveBeenCalledOnce();
  expect(env.audio).not.toHaveBeenCalled();
});

it("releases an autoplay-blocked context at the startup deadline and ignores late resume", async () => {
  vi.useFakeTimers();
  const env = harness();
  const resumed = deferred<void>();
  env.resume.mockImplementationOnce(() => resumed.promise);
  const playback = playNotificationSound("ping");
  assert(playback);
  const context = env.contexts[0];
  assert(context);
  const finished = vi.fn();
  void playback.finished.then(finished);
  await vi.advanceTimersByTimeAsync(999);
  expect(finished).not.toHaveBeenCalled();
  expect(context.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(finished).toHaveBeenCalledOnce();
  await playback.finished;
  expect(context.close).toHaveBeenCalledOnce();
  expect(env.fetch).toHaveBeenCalledWith("/sounds/ping.mp3", {
    signal: expect.objectContaining({ aborted: true }),
  });
  expect(vi.getTimerCount()).toBe(0);
  resumed.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(env.started).not.toHaveBeenCalled();
  playback.stop();
  expect(context.close).toHaveBeenCalledOnce();

  const retry = playNotificationSound("ping");
  assert(retry);
  await vi.advanceTimersByTimeAsync(0);
  expect(env.contexts[1]?.source.start).toHaveBeenCalledOnce();
  env.contexts[1]?.source.onended?.();
  await retry.finished;
});

it("clears the startup deadline when cancelled before resume", async () => {
  vi.useFakeTimers();
  const env = harness();
  const resumed = deferred<void>();
  env.resume.mockImplementationOnce(() => resumed.promise);
  const playback = playNotificationSound("doo");
  assert(playback);
  playback.stop();
  await playback.finished;
  expect(vi.getTimerCount()).toBe(0);
  expect(env.contexts[0]?.close).toHaveBeenCalledOnce();
  resumed.resolve();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(env.started).not.toHaveBeenCalled();
  expect(env.contexts[0]?.close).toHaveBeenCalledOnce();
});

it("clears the startup deadline after resume, even while the sound is loading", async () => {
  vi.useFakeTimers();
  const env = harness();
  const response = deferred<Awaited<ReturnType<typeof env.fetch>>>();
  env.fetch.mockImplementationOnce(() => response.promise);
  const playback = playNotificationSound("boo");
  assert(playback);
  const context = env.contexts[0];
  assert(context);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(vi.getTimerCount()).toBe(0);
  expect(context.close).not.toHaveBeenCalled();
  response.resolve({ ok: true, arrayBuffer: async () => env.bytes });
  await vi.advanceTimersByTimeAsync(0);
  expect(context.source.start).toHaveBeenCalledOnce();
  context.source.onended?.();
  await playback.finished;
  expect(context.close).toHaveBeenCalledOnce();
});

it.each(["fetch", "decode"] as const)(
  "cancels pending %s work without allowing a late sound to play",
  async (stage) => {
    const env = harness();
    const response = deferred<Awaited<ReturnType<typeof env.fetch>>>();
    env.fetch.mockImplementationOnce(() => response.promise);
    const playback = playNotificationSound("boo");
    assert(playback);
    const context = env.contexts[0];
    assert(context);
    const decoding = deferred<object>();
    const decodeStarted = deferred<void>();
    context.decodeAudioData.mockImplementationOnce(() => {
      decodeStarted.resolve();
      return decoding.promise;
    });
    const finishFetch = () =>
      response.resolve({ ok: true, arrayBuffer: async () => env.bytes });
    if (stage === "decode") {
      finishFetch();
      await decodeStarted.promise;
    }
    playback.stop();
    await playback.finished;
    if (stage === "fetch") {
      finishFetch();
      await decodeStarted.promise;
    }
    decoding.resolve({});
    await decoding.promise;
    // Flush the continuation after decodeAudioData has settled.
    await Promise.resolve();
    expect(env.started).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledOnce();
  },
);

it.each(["resume", "fetch", "http", "decode", "start"] as const)(
  "keeps %s failure best-effort, releases its context, and permits a later alert",
  async (stage) => {
    const env = harness();
    const response = deferred<Awaited<ReturnType<typeof env.fetch>>>();
    env.fetch.mockImplementationOnce(() => response.promise);
    const error = new Error("unavailable");
    if (stage === "resume") env.resume.mockRejectedValueOnce(error);
    const playback = playNotificationSound("doo");
    assert(playback);
    const context = env.contexts[0];
    assert(context);
    if (stage === "fetch") response.reject(error);
    else {
      if (stage === "decode")
        context.decodeAudioData.mockRejectedValueOnce(error);
      if (stage === "start")
        context.source.start.mockImplementationOnce(() => {
          throw error;
        });
      response.resolve({
        ok: stage !== "http",
        arrayBuffer: async () => env.bytes,
      });
    }
    await playback.finished;
    expect(context.close).toHaveBeenCalledOnce();
    const retry = playNotificationSound("doo");
    assert(retry);
    await vi.waitFor(() =>
      expect(env.contexts[1]?.source.start).toHaveBeenCalledOnce(),
    );
    env.contexts[1]?.source.onended?.();
    await retry.finished;
  },
);
