import type { Host } from "../../features/host/service";

export type PreviewHost = Pick<Host, "request" | "requestBytes">;
const LIMIT = 1024 * 1024;
const BUDGET = 4 * LIMIT;
const recordings = new Map<string, Uint8Array>();
const pending = new Map<string, Promise<Uint8Array>>();
let bytes = 0;

function previewUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.origin === "https://persistent.oaistatic.com" &&
      !url.username &&
      !url.password &&
      url.pathname.startsWith("/voice/previews/") &&
      url.pathname.endsWith(".m4a")
    );
  } catch {
    return false;
  }
}

/** Refresh with the settings catalog; only ChatGPT credentials go to ChatGPT. */
export type PreviewAuth = { authMethod?: string; authToken?: string };
export async function discoverPreviews(
  auth: PreviewAuth | undefined,
  host: PreviewHost,
) {
  if (auth?.authMethod !== "chatgpt" || !auth.authToken) return {};
  const response = await host.request({
    url: "https://chatgpt.com/backend-api/settings/voices?spoken_language=en&voice_mode=wingman",
    headers: { Authorization: `Bearer ${auth.authToken}` },
  });
  if (response.status !== 200)
    throw new Error("Voice previews could not be discovered. Try again.");
  const data: {
    voices?: {
      voice?: unknown;
      name?: unknown;
      preview_url?: unknown;
      accent?: unknown;
    }[];
  } = JSON.parse(response.body);
  if (!Array.isArray(data.voices))
    throw new Error("Voice preview catalog is invalid.");
  const previews: Record<string, string> = {};
  const accents: Record<string, string> = {};
  for (const entry of data.voices) {
    if (!entry) continue;
    for (const key of [entry.voice, entry.name])
      if (typeof key === "string") {
        const id = key.toLowerCase();
        if (previewUrl(entry.preview_url)) previews[id] = entry.preview_url;
        if (typeof entry.accent === "string" && entry.accent.trim())
          accents[id] = entry.accent.trim();
      }
  }
  return { previews, accents };
}

/** URL-keyed, size-bounded session memory, like attachment media caches. */
export async function preloadPreview(
  host: PreviewHost | undefined,
  url: string,
) {
  if (!previewUrl(url))
    throw new Error("No recording is available for this voice.");
  const cached = recordings.get(url);
  if (cached) {
    recordings.delete(url);
    recordings.set(url, cached);
    return cached;
  }
  const running = pending.get(url);
  if (running) return running;
  const read = host?.requestBytes;
  if (!read) throw new Error("Voice previews are unavailable on this device.");
  const load = (async () => {
    const response = await read({ url, maxBytes: LIMIT });
    if (
      response.status !== 200 ||
      !response.body.byteLength ||
      response.body.byteLength > LIMIT
    )
      throw new Error("Voice recording could not be loaded. Try again.");
    recordings.set(url, response.body);
    bytes += response.body.byteLength;
    for (const [oldest, recording] of recordings) {
      if (bytes <= BUDGET) break;
      recordings.delete(oldest);
      bytes -= recording.byteLength;
    }
    return response.body;
  })();
  pending.set(url, load);
  try {
    return await load;
  } finally {
    pending.delete(url);
  }
}

/** A recording only: no conversation, generation, or microphone. */
export async function previewVoice(
  host: PreviewHost | undefined,
  url: string | Promise<string>,
  signal: AbortSignal,
  started?: () => void,
) {
  signal.throwIfAborted();
  const context = new AudioContext();
  const source = context.createBufferSource();
  const gain = context.createGain();
  gain.gain.value = 0.8;
  let finish!: () => void;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop = () => {
    finish();
    void context.close().catch(() => {});
  };
  signal.addEventListener("abort", stop, { once: true });
  const wait = <T>(operation: Promise<T>) =>
    Promise.race([
      operation,
      stopped.then(() => {
        throw new Error("Voice preview stopped");
      }),
    ]);
  source.onended = finish;
  try {
    const [recording] = await wait(
      Promise.all([
        Promise.resolve(url).then((value) => preloadPreview(host, value)),
        context.resume(),
      ]),
    );
    source.buffer = await wait(
      context.decodeAudioData(recording.slice().buffer as ArrayBuffer),
    );
    signal.throwIfAborted();
    source.connect(gain);
    gain.connect(context.destination);
    source.start();
    started?.();
    await stopped;
  } finally {
    signal.removeEventListener("abort", stop);
    source.onended = null;
    source.disconnect();
    gain.disconnect();
    await context.close().catch(() => {});
  }
}
