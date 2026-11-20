import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());
const url = (name: string) =>
  `https://persistent.oaistatic.com/voice/previews/${name}.en.test.m4a`;
const response = (bytes = 12) => ({
  status: 200,
  headers: {},
  body: new Uint8Array(bytes),
});
function fixture(authMethod = "chatgpt") {
  const auth = { authMethod, authToken: "test-token" };
  const host = {
    request: vi.fn(),
    requestBytes: vi.fn(async () => response()),
  };
  return { auth, host };
}

it("discovers aliases from returned names and refreshes URLs on every request", async () => {
  const { discoverPreviews } = await import("./voice-preview");
  const f = fixture();
  vi.mocked(f.host.request)
    .mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: JSON.stringify({
        voices: [
          {
            voice: "orbit",
            name: "Spruce",
            preview_url: url("orbit"),
            accent: "American English",
          },
          {
            voice: "invalid",
            name: "Invalid",
            preview_url: "https://example.org/sample.m4a",
          },
        ],
      }),
    })
    .mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: JSON.stringify({
        voices: [
          { voice: "orbit", name: "Spruce", preview_url: url("new-orbit") },
        ],
      }),
    });
  expect(await discoverPreviews(f.auth, f.host)).toEqual({
    previews: { orbit: url("orbit"), spruce: url("orbit") },
    accents: { orbit: "American English", spruce: "American English" },
  });
  expect(await discoverPreviews(f.auth, f.host)).toEqual({
    previews: { orbit: url("new-orbit"), spruce: url("new-orbit") },
    accents: {},
  });
  expect(f.host.request).toHaveBeenCalledTimes(2);
  expect(f.host.request).toHaveBeenCalledWith(
    expect.objectContaining({
      url: "https://chatgpt.com/backend-api/settings/voices?spoken_language=en&voice_mode=wingman",
      headers: { Authorization: "Bearer test-token" },
    }),
  );
});

it("never sends an API key to ChatGPT", async () => {
  const { discoverPreviews } = await import("./voice-preview");
  const f = fixture("apikey");
  expect(await discoverPreviews(f.auth, f.host)).toEqual({});
  expect(f.host.request).not.toHaveBeenCalled();
});

it("shares concurrent downloads, caches bytes by URL and refetches changed URLs", async () => {
  const { preloadPreview } = await import("./voice-preview");
  const f = fixture();
  let release!: (value: ReturnType<typeof response>) => void;
  vi.mocked(f.host.requestBytes).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = preloadPreview(f.host, url("cove"));
  const second = preloadPreview(f.host, url("cove"));
  expect(f.host.requestBytes).toHaveBeenCalledTimes(1);
  release(response());
  expect(await first).toBe(await second);
  await preloadPreview(f.host, url("cove"));
  expect(f.host.requestBytes).toHaveBeenCalledTimes(1);
  await preloadPreview(f.host, url("cove-v2"));
  expect(f.host.requestBytes).toHaveBeenCalledTimes(2);
});

it("evicts least recently used bytes at the budget and retries failed downloads", async () => {
  const { preloadPreview } = await import("./voice-preview");
  const f = fixture();
  vi.mocked(f.host.requestBytes).mockResolvedValue(response(1024 * 1024));
  for (const name of ["a", "b", "c", "d"])
    await preloadPreview(f.host, url(name));
  await preloadPreview(f.host, url("a"));
  await preloadPreview(f.host, url("e"));
  await preloadPreview(f.host, url("a"));
  expect(f.host.requestBytes).toHaveBeenCalledTimes(5);
  await preloadPreview(f.host, url("b"));
  expect(f.host.requestBytes).toHaveBeenCalledTimes(6);
  vi.mocked(f.host.requestBytes).mockRejectedValueOnce(new Error("offline"));
  await expect(preloadPreview(f.host, url("retry"))).rejects.toThrow("offline");
  await preloadPreview(f.host, url("retry"));
  expect(f.host.requestBytes).toHaveBeenCalledTimes(8);
});

it("rejects foreign URLs and oversized recordings before caching", async () => {
  const { preloadPreview } = await import("./voice-preview");
  const f = fixture();
  await expect(
    preloadPreview(f.host, "https://example.org/sample.m4a"),
  ).rejects.toThrow("No recording");
  expect(f.host.requestBytes).not.toHaveBeenCalled();
  vi.mocked(f.host.requestBytes).mockResolvedValueOnce(
    response(1024 * 1024 + 1),
  );
  await expect(preloadPreview(f.host, url("huge"))).rejects.toThrow(
    "could not be loaded",
  );
  await preloadPreview(f.host, url("huge"));
  expect(f.host.requestBytes).toHaveBeenCalledTimes(2);
});

function audio() {
  let began!: () => void;
  const playing = new Promise<void>((resolve) => {
    began = resolve;
  });
  const source = {
    buffer: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(began),
    onended: null as (() => void) | null,
  };
  const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  const context = {
    destination: {},
    createGain: () => gain,
    createBufferSource: () => source,
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    decodeAudioData: vi.fn(async () => ({})),
  };
  vi.stubGlobal(
    "AudioContext",
    vi.fn(function AudioContextMock() {
      return context;
    }),
  );
  return { source, context, gain, playing };
}
it("plays decoded recording bytes and ends on the source event", async () => {
  const { previewVoice } = await import("./voice-preview");
  const f = fixture();
  const a = audio();
  const started = vi.fn();
  const done = previewVoice(
    f.host,
    url("cove"),
    new AbortController().signal,
    started,
  );
  await a.playing;
  expect(started).toHaveBeenCalledOnce();
  expect(a.gain.gain.value).toBe(0.8);
  expect(a.source.connect).toHaveBeenCalledWith(a.gain);
  expect(a.gain.connect).toHaveBeenCalledWith(a.context.destination);
  expect(a.context.decodeAudioData).toHaveBeenCalledOnce();
  a.source.onended?.();
  await done;
  expect(a.context.close).toHaveBeenCalled();
  expect(a.gain.disconnect).toHaveBeenCalledOnce();
});
it("cancels while loading without starting audio, then reuses the completed download", async () => {
  const { previewVoice, preloadPreview } = await import("./voice-preview");
  const f = fixture();
  const a = audio();
  let release!: (value: ReturnType<typeof response>) => void;
  vi.mocked(f.host.requestBytes).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const abort = new AbortController();
  const done = expect(
    previewVoice(f.host, url("cove"), abort.signal),
  ).rejects.toThrow("stopped");
  abort.abort();
  await done;
  expect(a.source.start).not.toHaveBeenCalled();
  expect(a.context.close).toHaveBeenCalled();
  release(response());
  await preloadPreview(f.host, url("cove"));
  expect(f.host.requestBytes).toHaveBeenCalledOnce();
});

it("unlocks audio synchronously but waits for the saved recording before playback", async () => {
  const { previewVoice } = await import("./voice-preview");
  const f = fixture();
  const a = audio();
  let release!: (url: string) => void;
  const ready = new Promise<string>((resolve) => {
    release = resolve;
  });
  const done = previewVoice(f.host, ready, new AbortController().signal);
  expect(a.context.resume).toHaveBeenCalledOnce();
  expect(a.source.start).not.toHaveBeenCalled();
  release(url("cove"));
  await a.playing;
  a.source.onended?.();
  await done;
});
