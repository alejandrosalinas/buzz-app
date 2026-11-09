import {
  createAudioSettings,
  type HuddleAudioSettings,
} from "./audio-settings";
import workletUrl from "./capture.worklet.js?url&no-inline";
import { createPlayout } from "./playout";

export type HuddleAudio = {
  settings?: HuddleAudioSettings;
  mute(muted: boolean): void;
  play(peer: string, samples: readonly number[]): void;
  participants(peers: readonly string[]): void;
  close(): void;
};
export type OpenHuddleAudio = (
  send: (samples: number[]) => void,
  ended: () => void,
  signal: AbortSignal,
) => Promise<HuddleAudio>;

export const openHuddleAudio: OpenHuddleAudio = async (send, ended, signal) => {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error("Microphone access is unavailable in this app.");
  const context = new AudioContext({
    sampleRate: 48000,
    latencyHint: "interactive",
  });
  let stream: MediaStream | undefined;
  let capture: AudioWorkletNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let closed = false;
  let muted = false;
  let settings: HuddleAudioSettings | undefined;
  const output = context.createGain();
  output.connect(context.destination);
  let speaker: HTMLAudioElement | undefined;
  let speakerStream: MediaStreamAudioDestinationNode | undefined;
  const stopStream = (value: MediaStream | undefined) => {
    for (const track of value?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
  };
  const microphone = (id = "") =>
    navigator.mediaDevices.getUserMedia({
      audio: {
        ...(id ? { deviceId: { exact: id } } : {}),
        channelCount: 1,
        sampleRate: 48000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  const playback = new Map<string, ReturnType<typeof createPlayout>>();
  const clear = (peer: string) => {
    playback.get(peer)?.close();
    playback.delete(peer);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", close);
    if (capture) {
      capture.port.onmessage = null;
      capture.disconnect();
      capture.port.close();
    }
    source?.disconnect();
    settings?.close();
    stopStream(stream);
    output.disconnect();
    speaker?.pause();
    if (speaker) speaker.srcObject = null;
    stopStream(speakerStream?.stream);
    for (const peer of playback.keys()) clear(peer);
    void context.close().catch(() => {});
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    signal.throwIfAborted();
    await context.resume();
    if (context.sampleRate !== 48000)
      throw new Error("This audio device does not support Huddle audio.");
    stream = await microphone();
    // Permission can finish after Cancel or plugin disposal. Release the late track.
    if (closed || signal.aborted) {
      for (const track of stream.getTracks()) track.stop();
      throw new DOMException("Huddle cancelled", "AbortError");
    }
    for (const track of stream.getAudioTracks()) track.onended = ended;
    await context.audioWorklet.addModule(workletUrl);
    signal.throwIfAborted();
    capture = new AudioWorkletNode(context, "buzz-huddle-capture");
    capture.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
      if (!closed && !muted) send(Array.from(data));
    };
    source = context.createMediaStreamSource(stream);
    source.connect(capture);
    // The worklet's output is silent; the connection keeps capture processing alive.
    capture.connect(context.destination);
    const activeCapture = capture;
    settings = createAudioSettings(
      async (id) => {
        const next = await microphone(id);
        if (closed || signal.aborted) {
          stopStream(next);
          throw new DOMException("Huddle cancelled", "AbortError");
        }
        let nextSource: MediaStreamAudioSourceNode;
        try {
          for (const track of next.getAudioTracks()) track.enabled = !muted;
          nextSource = context.createMediaStreamSource(next);
          nextSource.connect(activeCapture);
        } catch (error) {
          stopStream(next);
          throw error;
        }
        source?.disconnect();
        stopStream(stream);
        source = nextSource;
        stream = next;
        for (const track of next.getAudioTracks()) track.onended = ended;
      },
      typeof HTMLMediaElement.prototype.setSinkId === "function"
        ? async (id) => {
            if (closed) return;
            // WebKit exposes speaker routing on media elements, not AudioContext.
            // Keep the direct output until the selected route is successfully playing.
            if (!speaker) {
              const destination = context.createMediaStreamDestination();
              const element = new Audio();
              element.srcObject = destination.stream;
              try {
                await element.setSinkId(id);
                await element.play();
                signal.throwIfAborted();
                if (closed)
                  throw new DOMException("Huddle cancelled", "AbortError");
                output.connect(destination);
              } catch (error) {
                element.pause();
                element.srcObject = null;
                stopStream(destination.stream);
                throw error;
              }
              output.disconnect(context.destination);
              speaker = element;
              speakerStream = destination;
            } else {
              await speaker.setSinkId(id);
            }
          }
        : undefined,
    );
    return {
      settings,
      close,
      mute(value) {
        muted = value;
        for (const track of stream?.getAudioTracks() ?? [])
          track.enabled = !value;
      },
      participants(peers) {
        for (const peer of playback.keys())
          if (!peers.includes(peer)) clear(peer);
      },
      play(peer, samples) {
        if (closed) return;
        let entry = playback.get(peer);
        if (!entry) {
          entry = createPlayout(context, output, 0.06);
          playback.set(peer, entry);
        }
        entry.play(samples);
      },
    };
  } catch (error) {
    close();
    throw error;
  }
};
