import captureUrl from "../../features/huddle/capture.worklet.js?url&no-inline";
import { createPlayout } from "../../features/huddle/playout";
import type { AppServer } from "./rpc";

/** Codex owns voice; this graph only carries the seat's 48 kHz mono PCM. */
export async function openVoice(
  rpc: AppServer,
  threadId: string,
  signal: AbortSignal,
  output: (samples: number[]) => Promise<void>,
  ended: (error?: Error) => void,
  instructions: string,
  thinking?: (active: boolean) => void,
) {
  signal.throwIfAborted();
  const peer = new RTCPeerConnection();
  let context: AudioContext;
  try {
    context = new AudioContext({ sampleRate: 48000 });
  } catch (error) {
    peer.close();
    throw error;
  }
  const destination = context.createMediaStreamDestination();
  const playout = createPlayout(context, destination, 0.02);
  let capture: AudioWorkletNode | undefined;
  let remote: MediaStreamAudioSourceNode | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let starting: Promise<unknown> | undefined;
  let cancel!: (error: Error) => void;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = reject;
  });
  void cancelled.catch(() => {});
  const wait = <T>(operation: Promise<T>) =>
    Promise.race([operation, cancelled]);
  let off = () => {};
  let rejectConnected!: (error: Error) => void;
  const close = () => {
    if (closed) return closing;
    closed = true;
    signal.removeEventListener("abort", close);
    off();
    cancel(new Error("Voice connection closed"));
    rejectConnected(new Error("Voice connection closed"));
    peer.close();
    remote?.disconnect();
    if (capture) {
      capture.port.onmessage = null;
      capture.port.close();
      capture.disconnect();
    }
    playout.close();
    for (const track of destination.stream.getTracks()) track.stop();
    destination.disconnect();
    closing = Promise.all([
      context.close().catch(() => {}),
      starting
        ?.catch(() => {})
        .then(() =>
          rpc.request("thread/realtime/stop", { threadId }).catch(() => {}),
        ),
    ]).then(() => {});
    return closing;
  };
  const fail = (error: Error) => {
    if (closed) return;
    close();
    ended(error);
  };
  const connected = new Promise<void>((resolve, reject) => {
    rejectConnected = reject;
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "connected") resolve();
      if (["failed", "disconnected"].includes(peer.connectionState))
        fail(new Error("Codex voice disconnected"));
    };
  });
  void connected.catch(() => {});
  signal.addEventListener("abort", close, { once: true });
  const timeout = setTimeout(
    () => fail(new Error("Codex voice connection timed out")),
    30_000,
  );
  try {
    await wait(context.resume());
    await wait(context.audioWorklet.addModule(captureUrl));
    signal.throwIfAborted();
    if (closed) throw new Error("Voice connection closed");
    if (context.sampleRate !== 48000)
      throw new Error("Agent voice requires 48 kHz audio");
    capture = new AudioWorkletNode(context, "buzz-huddle-capture");
    capture.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
      if (closed) return;
      // The Huddle seat owns bounded buffering and serial native sends.
      void output(Array.from(data)).catch(fail);
    };
    capture.connect(context.destination); // Existing capture worklet emits silence.
    peer.ontrack = ({ track }) => {
      if (closed || track.kind !== "audio" || !capture) return;
      remote?.disconnect();
      remote = context.createMediaStreamSource(new MediaStream([track]));
      remote.connect(capture);
    };
    for (const track of destination.stream.getTracks())
      peer.addTrack(track, destination.stream);
    const events = peer.createDataChannel("oai-events");
    events.onmessage = ({ data }) => {
      if (closed || typeof data !== "string") return;
      try {
        const event = JSON.parse(data);
        if (event.type === "response.created") thinking?.(true);
        if (
          event.type === "response.done" ||
          event.type === "output_audio_buffer.started" ||
          event.type === "input_audio_buffer.speech_started"
        )
          thinking?.(false);
      } catch {
        /* Ignore non-protocol data. */
      }
    };
    off = rpc.onMessage(({ method, params }) => {
      const p = params as
        | { threadId?: string; sdp?: string; message?: string }
        | undefined;
      if (method === "connection/closed")
        return fail(new Error(p?.message ?? "Codex closed"));
      if (p?.threadId !== threadId || closed) return;
      if (method === "thread/realtime/sdp" && p.sdp)
        void peer
          .setRemoteDescription({ type: "answer", sdp: p.sdp })
          .catch(fail);
      if (
        method === "thread/realtime/error" ||
        method === "thread/realtime/closed"
      )
        fail(new Error(p.message ?? "Codex voice ended"));
    });
    await wait(peer.setLocalDescription(await wait(peer.createOffer())));
    signal.throwIfAborted();
    const sdp = peer.localDescription?.sdp;
    if (!sdp) throw new Error("Codex voice offer is missing");
    starting = rpc.request("thread/realtime/start", {
      threadId,
      transport: { type: "webrtc", sdp },
      version: "v3",
      outputModality: "audio",
      clientManagedHandoffs: false,
      realtimeStartInstructions: instructions,
    });
    await wait(starting);
    await connected;
    signal.throwIfAborted();
    return {
      close,
      input(samples: number[]) {
        if (!closed) playout.play(samples);
      },
    };
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
