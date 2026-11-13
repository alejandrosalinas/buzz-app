import type { NotificationCategory } from "./preferences";

/** Bundled alert sounds under public/sounds, shared with the reference client. */
export const SOUND_NAMES = [
  "bong",
  "boo",
  "dng",
  "doo",
  "doodone",
  "doong",
  "doop",
  "flirl",
  "flutter",
  "oh-no",
  "ping",
  "soft",
  "unison",
] as const;
export type SoundName = (typeof SOUND_NAMES)[number] | "silent";
const SOUND_NAME_SET: ReadonlySet<string> = new Set(SOUND_NAMES);
export function isSoundName(value: unknown): value is SoundName {
  return (
    value === "silent" ||
    (typeof value === "string" && SOUND_NAME_SET.has(value))
  );
}

export const DEFAULT_SOUND: SoundName = "flutter";

export type CategorySounds = Readonly<Record<NotificationCategory, SoundName>>;
export const DEFAULT_CATEGORY_SOUNDS: CategorySounds = Object.freeze({
  mention: DEFAULT_SOUND,
  direct: DEFAULT_SOUND,
  thread: DEFAULT_SOUND,
  agent: DEFAULT_SOUND,
});

/** Row copy and recommendations reuse the reference client's event rows. */
export const CATEGORY_SOUND_LABELS: Record<NotificationCategory, string> = {
  direct: "Direct messages",
  mention: "@Mentions",
  thread: "Thread replies",
  agent: "Solo chat completions",
};
export const RECOMMENDED_SOUND_BY_CATEGORY: Record<
  NotificationCategory,
  SoundName
> = {
  direct: "unison",
  mention: "ping",
  thread: "doop",
  agent: "doodone",
};

/** Plugin categories have no per-category choice; they use the default sound. */
export function resolveCategorySound(
  sounds: CategorySounds,
  category: string,
): SoundName {
  return (
    (sounds as Partial<Record<string, SoundName>>)[category] ?? DEFAULT_SOUND
  );
}

export type NotificationSoundPlayback = {
  stop(): void;
  finished: Promise<void>;
};

const playing = new Map<SoundName, NotificationSoundPlayback>();

export function playNotificationSound(
  name: SoundName,
): NotificationSoundPlayback | null {
  const playback = createNotificationSoundPlayback(name);
  if (!playback) return null;
  playing.get(name)?.stop();
  playing.set(name, playback);
  void playback.finished.then(() => {
    if (playing.get(name) === playback) playing.delete(name);
  });
  return playback;
}

export function createNotificationSoundPlayback(
  name: SoundName,
): NotificationSoundPlayback | null {
  if (name === "silent") return null;
  let context: AudioContext;
  try {
    // Alerts must not become resumable media players for the system's media keys.
    context = new AudioContext();
  } catch {
    return null;
  }
  const controller = new AbortController();
  let source: AudioBufferSourceNode | undefined;
  let started = false;
  let finish!: () => void;
  const playback: NotificationSoundPlayback = {
    finished: new Promise<void>((resolve) => {
      finish = resolve;
    }),
    stop() {
      if (controller.signal.aborted) return;
      controller.abort();
      clearTimeout(startupTimeout);
      if (source) {
        source.onended = null;
        if (started) source.stop();
        source.disconnect();
      }
      void context.close().catch(() => {});
      finish();
    },
  };
  const startupTimeout = setTimeout(playback.stop, 1_000);
  void (async () => {
    const [, response] = await Promise.all([
      context.resume().then(() => clearTimeout(startupTimeout)),
      fetch(`/sounds/${name}.mp3`, { signal: controller.signal }),
    ]);
    if (!response.ok) throw new Error("Could not load notification sound");
    const buffer = await context.decodeAudioData(await response.arrayBuffer());
    if (controller.signal.aborted) return;
    source = context.createBufferSource();
    source.buffer = buffer;
    source.onended = playback.stop;
    source.connect(context.destination);
    source.start();
    started = true;
  })().catch(playback.stop);
  return playback;
}
