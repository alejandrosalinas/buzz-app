import { addChannelMember } from "../channel-members/members";
import { endLastHumanHuddle } from "./ending";
import { createPcmSender } from "./sender";
import type { ChannelSummary } from "../relay/contracts";
import type { AudioSettingsState } from "./audio-settings";
import { createHuddleRequests } from "./requests";
import { discoverHuddles } from "./discovery";
import type { RelayData, RelaySnapshot } from "../relay/service";
import type { HuddleBridge, HuddleDestination, HuddleUpdate } from "./bridge";
import type { HuddleAudio, OpenHuddleAudio } from "./audio";
import type { Context } from "@deepseek-ai/cordis";

export type HuddleSnapshot = Readonly<{
  id?: string;
  level?: number;
  audioSettings?: AudioSettingsState;
  speakers?: Readonly<Record<string, number>>;
  requester?: string;
  phase: "idle" | "incoming" | "connecting" | "connected" | "leaving" | "error";
  destination?: HuddleDestination;
  room?: string;
  muted: boolean;
  participants: readonly string[];
  listening?: readonly string[];
  thinking?: readonly string[];
  error?: string;
}>;
type Attempt = {
  id: string;
  connection: RelaySnapshot;
  abort: AbortController;
  audio?: HuddleAudio;
  opening?: Promise<void>;
  admissions?: readonly string[];
  heartbeat?: ReturnType<typeof setInterval>;
  stopAccess?: () => void;
  stopAudioSettings?: () => void;
  sender: ReturnType<typeof createPcmSender>;
};
const idle: HuddleSnapshot = { phase: "idle", muted: false, participants: [] };
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Call lifetime belongs to the plugin activation, never to its mounted panel. */
export function createHuddles(
  relay: RelayData,
  bridge: HuddleBridge,
  openAudio: OpenHuddleAudio,
  dmAgent?: (
    connection: RelaySnapshot,
    destination: HuddleDestination,
  ) => string | undefined,
) {
  let snapshot = idle;
  let requests: ReturnType<typeof createHuddleRequests> | undefined;
  let current: Attempt | undefined;
  let disposed = false;
  const speakers = new Map<
    string,
    { level: number; heard: number; measured: number }
  >();
  let activityTimer: ReturnType<typeof setInterval> | undefined;
  let closing: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const unavailable = new Set<string>();
  const update = (next: HuddleSnapshot) => {
    snapshot = next;
    if (next.phase !== "incoming") requests?.resetSelection();
    for (const listener of listeners) listener();
    requests?.refresh();
  };
  const activitySnapshot = () => {
    const levels = Object.fromEntries(
      [...speakers]
        .filter(([, value]) => value.level > 0)
        .map(([key, value]) => [key, value.level]),
    );
    return { speakers: levels, level: Math.max(0, ...Object.values(levels)) };
  };
  const publishActivity = () => {
    const next = activitySnapshot();
    const previous = snapshot.speakers ?? {};
    if (
      Object.keys(previous).length !== Object.keys(next.speakers).length ||
      Object.entries(next.speakers).some(
        ([key, level]) => previous[key] !== level,
      )
    )
      update({ ...snapshot, ...next });
  };
  const resetActivity = () => {
    clearInterval(activityTimer);
    activityTimer = undefined;
    speakers.clear();
  };
  const activity = (peer: string, samples: readonly number[]) => {
    if (
      snapshot.phase !== "connected" ||
      !snapshot.participants.includes(peer) ||
      (snapshot.muted && peer === snapshot.destination?.viewer)
    )
      return;
    const now = performance.now();
    const previous = speakers.get(peer);
    if (previous) previous.heard = now;
    if (previous && now - previous.measured < 100) return;
    const rms = Math.sqrt(
      samples.reduce((sum, n) => sum + n * n, 0) / (samples.length || 1),
    );
    const level = Number.isFinite(rms)
      ? Math.min(1, Math.round(rms * 30) / 5)
      : 0;
    speakers.set(peer, { level, heard: now, measured: now });
    if (!activityTimer) {
      publishActivity();
      activityTimer = setInterval(() => {
        const now = performance.now();
        for (const [peer, state] of speakers)
          if (now - state.heard >= 220) speakers.delete(peer);
        publishActivity();
        if (!speakers.size) {
          clearInterval(activityTimer);
          activityTimer = undefined;
        }
      }, 100);
    }
  };
  const valid = (attempt: Attempt) =>
    !disposed && current === attempt && !attempt.abort.signal.aborted;
  async function leave(error?: string, remote = false) {
    if (closing) return closing;
    if (snapshot.phase === "incoming" && snapshot.room) {
      requests?.dismiss(snapshot.room);
      return;
    }
    if (!error && snapshot.phase === "connecting" && snapshot.room)
      requests?.dismiss(snapshot.room);
    const failedRoom = snapshot.room;
    const previous = current;
    const ending =
      !error && !remote && snapshot.phase === "connected"
        ? snapshot
        : undefined;
    current = undefined;
    resetActivity();
    previous?.abort.abort();
    previous?.stopAudioSettings?.();
    previous?.audio?.close();
    clearInterval(previous?.heartbeat);
    previous?.stopAccess?.();
    if (!previous) {
      update(
        error
          ? {
              ...idle,
              phase: "error",
              error,
              ...(failedRoom ? { room: failedRoom } : {}),
            }
          : idle,
      );
      return;
    }
    update({
      ...snapshot,
      ...activitySnapshot(),
      phase: "leaving",
      participants: [],
    });
    closing = Promise.resolve().then(async () => {
      try {
        // A command that was dispatched may arrive after Cancel; close its exact ID.
        if (previous.opening) {
          await previous.opening.catch(() => {});
          await bridge.close(previous.id);
        }
        if (ending?.room && ending.destination && previous.admissions)
          await endLastHumanHuddle(
            previous.connection.session,
            ending.destination,
            ending.room,
            previous.admissions,
            () => {
              const next = relay.snapshot();
              return (
                !disposed &&
                next.status === "ready" &&
                next.session === previous.connection.session &&
                next.scope === previous.connection.scope
              );
            },
          );
        update(
          error
            ? {
                ...idle,
                phase: "error",
                error,
                ...(failedRoom ? { room: failedRoom } : {}),
              }
            : idle,
        );
      } catch (failure) {
        update({ ...idle, phase: "error", error: message(failure) });
      } finally {
        closing = undefined;
        requests?.refresh();
      }
    });
    return closing;
  }
  const unsubscribe = relay.subscribe(() => {
    if (current && relay.snapshot() !== current.connection) {
      const next = relay.snapshot();
      if (
        next.status !== "ready" ||
        next.session !== current.connection.session ||
        next.scope !== current.connection.scope
      )
        void leave(
          "The connection changed. Join the Huddle again when connected.",
        );
    }
  });
  async function join(
    destination: HuddleDestination,
    room?: string,
    discover = false,
  ) {
    if (disposed || current || closing) return;
    const connection = relay.snapshot();
    // The originating DM stays private. Explicit room members can join using
    // its verified parent marker without access to the original conversation.
    const member = (channel: ChannelSummary | undefined) =>
      !!channel &&
      !channel.archived &&
      !channel.readOnly &&
      !channel.cached &&
      !!channel.members?.includes(destination.viewer);
    // Admission through a parent must never become room-only admission merely
    // because the audio join subsequently adds the viewer to the temporary room.
    const parentAdmission = member(
      connection.session.channels
        .list()
        .channels.find((channel) => channel.id === destination.channelId),
    );
    const accessible = () => {
      const channels = connection.session.channels.list().channels;
      const parent = channels.find((c) => c.id === destination.channelId);
      const invited = room ? channels.find((c) => c.id === room) : undefined;
      if (parent?.archived || invited?.archived) return "denied";
      if (parentAdmission)
        return parent ? (member(parent) ? "allowed" : "denied") : "unknown";
      if (!invited) return "unknown";
      return member(invited) &&
        invited.huddle &&
        invited.parentChannelId === destination.channelId
        ? "allowed"
        : "denied";
    };
    if (
      !bridge.available ||
      connection.status !== "ready" ||
      connection.scope !== destination.scope ||
      connection.viewer !== destination.viewer ||
      accessible() !== "allowed"
    ) {
      update({
        ...idle,
        phase: "error",
        error: "Connect to this channel before starting a Huddle.",
      });
      return;
    }
    const incoming =
      snapshot.phase === "incoming" &&
      snapshot.room === room &&
      snapshot.destination?.scope === destination.scope &&
      snapshot.destination.channelId === destination.channelId
        ? snapshot
        : undefined;
    const id = crypto.randomUUID();
    const abort = new AbortController();
    const attempt: Attempt = {
      id,
      connection,
      abort,
      sender: createPcmSender(
        (samples) => bridge.send(id, samples),
        abort.signal,
        (error) => {
          if (valid(attempt)) void leave(message(error));
        },
      ),
    };
    current = attempt;
    // Only a fresh start invites; joining someone else's room never adds a listener.
    const key = discover ? dmAgent?.(connection, destination) : undefined;
    let invited = false;
    let inviteError: string | undefined;
    const seated = (roomId: string) =>
      !!key &&
      !!connection.session.channels.get?.(roomId)?.members?.includes(key);
    // Clear only this invitation's warning, once the room roster shows the agent.
    const confirmInvite = () => {
      if (!inviteError || snapshot.error !== inviteError) return;
      if (!snapshot.room || !seated(snapshot.room)) return;
      inviteError = undefined;
      const { error: _invite, ...rest } = snapshot;
      update(rest);
    };
    const inviteAgent = async (roomId: string) => {
      if (!key || invited) return;
      invited = true;
      try {
        await connection.session.channels.resolve?.([roomId]);
        if (!valid(attempt)) return;
        if (dmAgent?.(connection, destination) !== key)
          throw new Error("The agent is no longer available for voice");
        const channel = connection.session.channels.get?.(roomId);
        if (
          !channel?.huddle ||
          channel.parentChannelId !== destination.channelId
        )
          throw new Error("Couldn’t verify the Huddle room");
        if (!seated(roomId))
          await addChannelMember(
            connection.session,
            roomId,
            key,
            attempt.abort.signal,
          );
      } catch (error) {
        if (!valid(attempt) || seated(roomId)) return;
        inviteError = `Couldn’t add the agent: ${message(error)}. Use Huddle options → Add someone to retry.`;
        update({ ...snapshot, error: inviteError });
      }
    };
    attempt.stopAccess = connection.session.channels.subscribeList(() => {
      const list = connection.session.channels.list();
      if (
        valid(attempt) &&
        (accessible() === "denied" ||
          (accessible() === "unknown" &&
            list.status === "ready" &&
            list.coverage !== "partial"))
      )
        void leave("You no longer have access to this channel.");
      else if (valid(attempt)) confirmInvite();
    });
    update({
      ...idle,
      phase: "connecting",
      id: attempt.id,
      destination,
      ...(room ? { room } : {}),
      ...(incoming
        ? { requester: incoming.requester, participants: incoming.participants }
        : {}),
    });
    const receive = (event: HuddleUpdate) => {
      if (!valid(attempt)) return;
      if (event.type === "ended") {
        // The relay intentionally reports archived/inaccessible rooms as
        // "not a member"; do not claim to know which admission rule failed.
        if (
          room &&
          event.error &&
          /not a member|huddle has ended|channel is archived/.test(event.error)
        ) {
          if (unavailable.size >= 100) unavailable.clear();
          unavailable.add(`${destination.scope}:${room}`);
          requests?.dismiss(room);
        }
        void leave(event.error ?? undefined, true);
        return;
      }
      if (event.type === "audio") {
        activity(event.peer, event.samples);
        attempt.audio?.play(event.peer, event.samples);
        return;
      }
      // Native roster snapshots are unordered. Keep arrival order for the stack;
      // a participant who leaves and returns is a new arrival.
      attempt.admissions = event.participants;
      const present = new Set([destination.viewer, ...event.participants]);
      const participants = snapshot.participants.filter((key) =>
        present.has(key),
      );
      for (const key of participants) present.delete(key);
      participants.push(...present);
      attempt.audio?.participants(participants);
      for (const peer of speakers.keys())
        if (!participants.includes(peer)) speakers.delete(peer);
      if (event.type === "connected") requests?.dismiss(event.room);
      update({
        ...snapshot,
        participants,
        ...activitySnapshot(),
        ...(event.type === "connected"
          ? { phase: "connected", room: event.room }
          : {}),
      });
      if (event.type === "connected") void inviteAgent(event.room);
    };
    try {
      if (discover) {
        const rooms = await discoverHuddles(
          connection.session,
          destination.channelId,
          attempt.abort.signal,
        );
        if (!valid(attempt)) return;
        room = rooms.find(
          (candidate) =>
            !unavailable.has(`${destination.scope}:${candidate.id}`),
        )?.id;
      }
      const audio = await openAudio(
        (samples) => {
          if (
            !valid(attempt) ||
            snapshot.phase !== "connected" ||
            snapshot.muted
          )
            return;
          activity(destination.viewer, samples);
          void attempt.sender.send(samples);
        },
        () => {
          if (valid(attempt))
            void leave(
              "The microphone disconnected. Check your device and join again.",
            );
        },
        attempt.abort.signal,
      );
      if (!valid(attempt)) {
        audio.close();
        return;
      }
      attempt.audio = audio;
      if (audio.settings) {
        const settings = audio.settings;
        const syncSettings = () => {
          if (valid(attempt))
            update({ ...snapshot, audioSettings: settings.snapshot() });
        };
        attempt.stopAudioSettings = settings.subscribe(syncSettings);
        syncSettings();
      }
      attempt.opening = bridge.open(attempt.id, destination, room, receive);
      await attempt.opening;
      if (valid(attempt))
        attempt.heartbeat = setInterval(() => {
          void bridge.touch(attempt.id).catch((error) => {
            if (valid(attempt)) void leave(message(error));
          });
        }, 5000);
    } catch (error) {
      if (valid(attempt)) await leave(message(error));
    }
  }
  if (bridge.available)
    requests = createHuddleRequests(
      relay,
      () =>
        !disposed &&
        !current &&
        !closing &&
        ["idle", "error", "incoming"].includes(snapshot.phase),
      (request) => {
        if (request)
          update({
            ...idle,
            ...(snapshot.room === request.room && snapshot.error
              ? { error: snapshot.error }
              : {}),
            phase: "incoming",
            id: request.room,
            room: request.room,
            requester: request.creator,
            destination: request.destination,
            participants: [request.creator],
          });
        else if (snapshot.phase === "incoming") update(idle);
      },
    );
  // Seat presentation for this call only; old calls and inactive phases are ignored.
  const voiceSeat =
    (field: "listening" | "thinking") =>
    (id: string, key: string, active: boolean) => {
      if (snapshot.id !== id || (active && snapshot.phase !== "connected"))
        return;
      const keys = snapshot[field] ?? [];
      if (keys.includes(key) === active) return;
      update({
        ...snapshot,
        [field]: active ? [...keys, key] : keys.filter((peer) => peer !== key),
      });
    };
  return {
    snapshot: () => snapshot,
    voiceListening: voiceSeat("listening"),
    voiceThinking: voiceSeat("thinking"),
    remoteVoiceError(error: string) {
      if (snapshot.phase !== "idle" && snapshot.phase !== "error") return;
      update({ ...idle, phase: "error", error });
    },
    voiceError(call: string, error?: string) {
      if (snapshot.id !== call) return;
      const { error: _previous, ...rest } = snapshot;
      update(error ? { ...rest, error } : rest);
    },
    canJoin(scope: string, room: string) {
      return !unavailable.has(`${scope}:${room}`);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    join,
    start: (destination: HuddleDestination) =>
      join(destination, undefined, true),
    mute() {
      if (!current || snapshot.phase !== "connected") return;
      const muted = !snapshot.muted;
      if (muted) current.sender.clear();
      current.audio?.mute(muted);
      if (muted && snapshot.destination)
        speakers.delete(snapshot.destination.viewer);
      update({ ...snapshot, muted, ...activitySnapshot() });
    },
    refreshAudioSettings() {
      if (snapshot.phase === "connected")
        void current?.audio?.settings?.refresh();
    },
    selectAudioDevice(kind: "input" | "output", id: string) {
      if (snapshot.phase === "connected")
        void current?.audio?.settings?.select(kind, id);
    },
    leave,
    async dispose() {
      disposed = true;
      requests?.dispose();
      unsubscribe();
      await leave();
      listeners.clear();
    },
  };
}
export type Huddles = ReturnType<typeof createHuddles>;

/** Read-only call phase of this document for other plugins, such as a music
 * player that pauses for a Huddle. No destination, roster, audio or controls. */
export type HuddleStatus = Readonly<{
  version: 1;
  phase(): HuddleSnapshot["phase"];
  subscribe(listener: () => void): () => void;
}>;
/** Provided while Huddles is active; unloading Huddles withdraws it. */
export function provideHuddleStatus(
  ctx: Context,
  huddles: Pick<Huddles, "snapshot" | "subscribe">,
) {
  ctx.provide(
    "huddleStatus",
    Object.freeze({
      version: 1,
      phase: () => huddles.snapshot().phase,
      subscribe: (listener: () => void) => huddles.subscribe(listener),
    }) satisfies HuddleStatus,
  );
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Optional: consumers read it with `ctx.inject(["huddleStatus"], …)`. */
    huddleStatus?: HuddleStatus;
  }
}
