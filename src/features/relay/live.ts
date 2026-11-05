import {
  VERIFIED_PROFILE_MAX_SYNCS,
  verifiedProfileFilter,
  type VerifiedProfileFilter,
  type VerifiedProfileSink,
} from "./verified-profile.ts";
import { getLogger } from "../developer/logging.ts";
import { networkMetrics, utf8Bytes } from "../developer/network-metrics.ts";
import { networkRecorder } from "../developer/network-diagnostics.ts";
import { logSocketFrame, relayLabel } from "../developer/traffic.ts";

import {
  createSocketPublications,
  SocketRequestError,
} from "./socket-requests.ts";
import {
  OBSERVER_KIND,
  observerGeneration,
  type ObserverFrame,
} from "../agents/observer.ts";
import type { EventTemplate, VerifiedEvent } from "nostr-tools";
import {
  createEventVerifier,
  eventDto,
  type PreparedEvent,
  type RelayEvent,
  type SignatureVerifier,
} from "./events.ts";
import { yieldToHost } from "./yield.ts";
import { EMOJI_SET } from "./emoji.ts";
import {
  ARTIFACT_SYNC_MAX_VIEWS,
  type ArtifactSyncFilter,
  type ArtifactSyncSink,
} from "./artifact-sync-filter.ts";

export const LIVE_CHANNEL_CAPACITY = 1022;
export const LIVE_BATCH_SIZE = 2048; // Relay limit for explicit channel IDs per REQ.
const REPLAY_BATCH_SIZE = 10; // Relay limit for filters per REQ.
/** Channels one combined replay filter names. A combined replay that reaches
 * `LIVE_REPLAY_LIMIT` delivered everything after its oldest event, so the next
 * page asks for the rest from there, without the channels that already have
 * `LIVE_REPLAY_LIMIT` events: each channel still replays its newest ones. */
const COMBINED_REPLAY_CHANNELS = 256;
export const LIVE_REPLAY_LIMIT = 500;
export const LIVE_RECOVERY_INTERVAL = 60_000;
/** A live batch is re-sent after this long even with no grant, in case a
 * grant notice never arrived (a dropped frame, or a duplicate notice the
 * relay stored once and did not fan out again). */
export const LIVE_BATCH_REFRESH_INTERVAL = 15 * 60_000;
/** Channel REQs awaiting EOSE at once. `scripts/live-setup-probe.mjs` compares others. */
export const SETUP_CONCURRENCY = 4;
/** How long one channel REQ may wait for EOSE before its route fails. */
export const SETUP_TIMEOUT_MS = 10_000;
// Include the in-flight batch. Four 10-channel setup REQs can replay 20,000
// events before globals/syncs; allow that burst while bounding retained payloads.
const VERIFY_QUEUE_FRAMES = 32_768;
const VERIFY_QUEUE_BYTES = 64 * 1024 * 1024;
const VERIFY_BATCH_SIZE = 12; // Same hash-work slice as finite reads.
const MAX_QUOTA_RETRIES = 3;
const BASE_RECONNECT_DELAY = 500;
const MAX_RECONNECT_DELAY = 30_000;
/** The relay rejects an event whose created_at is further than this from its own
 * clock (block/buzz `crates/buzz-relay/src/handlers/ingest.rs`,
 * `MAX_TIMESTAMP_DRIFT_SECS`), so an event stored at time T can carry any
 * created_at in [T - 900, T + 900]. */
export const RELAY_TIMESTAMP_DRIFT_SECS = 900;
/** A route that reached EOSE was delivered live until its connection last heard
 * the relay. An event stored just after that can be backdated by the full drift,
 * so resume this far before it, plus one minute shared by everything else the
 * clocks disagree on: fan-out still in flight when the relay closed (a draining
 * pod can trail its peers), the client clock's skew from the relay's, and the
 * relay's replica read budget for the unread repair, which uses the same margin. */
export const LIVE_RESUME_LAG = RELAY_TIMESTAMP_DRIFT_SECS + 60;
/** Signature proofs a live subscription keeps across its reconnects. Each resume
 * replays `LIVE_RESUME_LAG` of events the subscription already verified; a
 * fresh signature check costs about 1 ms of main thread per event, a proof hit
 * only the hash. A resume whose window holds more distinct events than this
 * (about 17 a second for 16 minutes, or 33 channels at `LIVE_REPLAY_LIMIT`)
 * evicts each proof before its replay reaches it and gains nothing. Artifact
 * sync events share the memo, so that rate is an upper bound, not a proven fit
 * for a typical community. About 3 MiB of IDs and signatures, about 5 MiB of
 * heap. */
export const LIVE_PROOF_ENTRIES = 16_384;
/** Close codes for a relay that is going away on purpose (a rolling deploy
 * sends 1012 to every client at once): 1001 Going Away, 1012 Service Restart. */
const RESTART_CLOSE_CODES = [1001, 1012];
/** The first reconnect after such a close waits a uniform random time up to
 * this, so a fleet the relay closed at once does not return at once. */
export const LIVE_RESTART_SPREAD_MS = 10_000;
/** What a route knew when its authenticated connection ended (unix seconds). */
export type LiveCursor = Readonly<{ liveUntil: number }>;
/** Where a route with a cursor resumes: `LIVE_RESUME_LAG` before its connection
 * last heard the relay, never before `original`, the first window of the session.
 * The cursor exists only for a route that reached EOSE, so everything after the
 * EOSE was delivered live until `liveUntil`; the lag keeps the overlap. */
export function liveResumeSince(original: number, cursor: LiveCursor): number {
  return Math.max(original, cursor.liveUntil - LIVE_RESUME_LAG);
}
/** Delay before the next connection attempt. A restarting relay (1001/1012)
 * gets full jitter over the spread window, widening once repeated bounces have
 * grown the backoff past it. Anything else waits half to all of the backoff.
 * `random` is in [0, 1). */
export function liveReconnectDelay(
  closeCode: number | undefined,
  backoff: number,
  random: () => number,
): number {
  return closeCode !== undefined && RESTART_CLOSE_CODES.includes(closeCode)
    ? random() * Math.max(LIVE_RESTART_SPREAD_MS, backoff)
    : backoff * (0.5 + random() / 2);
}
/** Wait before retrying a refusal that needs someone to act (a rejected AUTH, a
 * route CLOSED as blocked). It can still clear: access changes, a relay restarts,
 * a locked signer unlocks. One recovery tick first, doubling to 10 minutes, so
 * a relay that keeps refusing sees at most 6 attempts an hour per route. */
/** A relay's missing-evidence refusal of a connection sent without a token. */
const FEDERATED_SIGN_IN_REFUSALS = new Set([
  "Federated sign-in is required",
  "Federated identity is not configured for this community",
]);
export const liveSlowRetryDelay = (failures: number) =>
  Math.min(LIVE_RECOVERY_INTERVAL * 2 ** (failures - 1), 600_000);
/** Host-owned server cooldown survives socket/POST replacement.
 * Healthy traffic has no inter-request delay; outstanding work is bounded below. */
export function createLiveAdmission() {
  let cooldown = 0;
  let presenceBusy = false,
    presenceNext = 0;
  const pending = new Set<object>();
  return {
    delay: () => Math.max(0, cooldown - performance.now()),
    setup(owner: object, busy: boolean) {
      if (busy) pending.add(owner);
      else pending.delete(owner);
    },
    presenceReady: () => performance.now() >= Math.max(cooldown, presenceNext),
    presenceDelay: () =>
      Math.ceil(
        Math.max(0, Math.max(cooldown, presenceNext) - performance.now()),
      ),
    tryPresence() {
      if (presenceBusy || !this.presenceReady()) return;
      presenceBusy = true;
      return () => {
        presenceBusy = false;
      };
    },
    presenceSent() {
      presenceNext = performance.now() + 5000;
    },
    presenceIdle: () =>
      !presenceBusy && performance.now() >= presenceNext && !pending.size,
    pause(seconds: number) {
      networkRecorder.record({
        level: "trace",
        event: "admission.cooldown",
        delayMs: (seconds + 1) * 1000,
      });
      // Redis reports whole seconds; include a second rather than retry before expiry.
      cooldown = Math.max(cooldown, performance.now() + (seconds + 1) * 1000);
    },
  };
}
export type LiveAdmission = ReturnType<typeof createLiveAdmission>;
export type LiveRoute = Readonly<{
  id: string;
  channelId?: string;
  status: "pending" | "live" | "error" | "limited";
  /** EOSE establishes a stream, never proves historical completeness. */
  replay: "unknown" | "limited";
  error?: string;
}>;
export type LiveSnapshot = Readonly<{
  status: "unavailable" | "connecting" | "connected" | "retrying" | "error";
  routes: readonly LiveRoute[];
  error?: string;
}>;
/** Transport provenance, not a history-completeness claim or permission to alert. */
export type LiveProvenance = Readonly<{
  phase: "replay" | "live";
  channelId?: string;
  /** Original wire scope for ambiguous channel traffic; never alert attribution. */
  sourceChannels?: readonly string[];
}>;
export function liveProvenance(value: unknown): LiveProvenance {
  if (!value || typeof value !== "object")
    throw new Error("Invalid live provenance");
  const input = value as Record<string, unknown>;
  if (input.phase !== "replay" && input.phase !== "live")
    throw new Error("Invalid live provenance");
  if (
    input.channelId !== undefined &&
    (typeof input.channelId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(input.channelId))
  )
    throw new Error("Invalid live provenance channel");
  const sourceChannels =
    input.sourceChannels === undefined
      ? undefined
      : liveChannels(input.sourceChannels);
  if (
    sourceChannels &&
    (!sourceChannels.length || sourceChannels.length > LIVE_BATCH_SIZE)
  )
    throw new Error("Invalid live source scope");
  return Object.freeze({
    ...(sourceChannels
      ? { sourceChannels: Object.freeze(sourceChannels) }
      : {}),
    phase: input.phase,
    ...(typeof input.channelId === "string"
      ? { channelId: input.channelId }
      : {}),
  });
}
/** A global route's establishment. `continuous`: the route resumed from the
 * cursor an earlier connection left, and its replay ended below the limit, so
 * it replayed every stored change since that connection last heard the relay.
 * A frame the relay dropped silently before then is not replayed. */
export type LiveGlobal = Readonly<{
  route: "profiles" | "membership";
  continuous: boolean;
}>;
/** Host-relayed global establishment; anything else reports nothing, so the
 * session reads again as if the replay was cut. */
export function liveGlobal(value: unknown): LiveGlobal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { route, continuous } = value as Record<string, unknown>;
  if (
    (route !== "profiles" && route !== "membership") ||
    typeof continuous !== "boolean"
  )
    return undefined;
  return Object.freeze({ route, continuous });
}
export type LiveCallbacks = {
  /** Legacy/missing provenance reconciles quietly; it is never implicitly fresh. */
  receive(events: readonly VerifiedEvent[], provenance?: LiveProvenance): void;
  /** Host-only encrypted telemetry route; never ordinary history reconciliation. */
  telemetry?(event: VerifiedEvent, generation: number): void;
  /** Decoded host DTO on the browser transport. */
  observer?(frame: ObserverFrame, generation: number): void;
  presence?(event: VerifiedEvent): void;
  state(snapshot: LiveSnapshot): void;
  /** A global route (no channels) also reports whether it stayed continuous. */
  established(channels?: string | readonly string[], global?: LiveGlobal): void;
  /** Periodic repair hint, not membership or historical-completeness evidence. */
  recover?(): void;
  denied(channelId: string, reason: string): void;
};
export type LiveSubscription = {
  /** Local broker handle; not a relay subscription ID. */
  identity?(): string | undefined;
  publish?(event: VerifiedEvent, signal: AbortSignal): Promise<string>;
  /** Purpose-bound host path when generic socket publication is unavailable. */
  publishTyping?(event: VerifiedEvent, signal: AbortSignal): Promise<string>;
  update(channels: readonly string[], joined?: readonly string[]): void;
  /** Host demand only: reorder existing pending routes, never grant new interests. */
  prioritize?(channels: readonly string[]): void;
  observe?(generation: number | null): void;
  /** Ephemeral status: true = accepted, false = unconfirmed/refused, null = unsent.
   * Admission skips report their remaining delay; no durable queue is created. */
  publishPresence?(
    status: "online" | "away" | "offline",
    signal: AbortSignal,
  ): Promise<boolean | null | { retryAfterMs: number }>;
  watchPresence?(authors: readonly string[]): void;
  /** One NIP-AR sync REQ on this socket. Sent once authenticated; a lost
   * socket ends it with `disconnected:`. The caller owns restart. */
  syncArtifacts?(
    filter: ArtifactSyncFilter,
    sink: ArtifactSyncSink,
  ): () => void;
  /** Bounded NIP-FI projection REQ on this community socket. */
  syncVerifiedProfiles?(
    filter: VerifiedProfileFilter,
    sink: VerifiedProfileSink,
  ): () => void;
  retry(): void;
  dispose(): void;
};
/** Demand-scoped ephemeral authors, never a channel/history interest. */
export function livePresenceAuthors(input: unknown): string[] {
  if (
    !Array.isArray(input) ||
    input.length > 256 ||
    input.some((key) => typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key))
  )
    throw new Error("Invalid live presence authors");
  return [...new Set(input as string[])].sort();
}
/** IDs, not names/previews, define interest identity. Never silently truncate. */
export function liveChannels(input: unknown): string[] {
  if (
    !Array.isArray(input) ||
    input.some(
      (id) => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id),
    )
  )
    throw new Error("Invalid live channel interests");
  return [...new Set(input as string[])].sort();
}

/** Batchability is part of the same interest snapshot, not a priority hint. */
export function liveJoined(
  channels: readonly string[],
  input: unknown,
): string[] {
  const joined = liveChannels(input);
  const interests = new Set(channels);
  if (joined.some((id) => !interests.has(id)))
    throw new Error("Joined scope outside live interests");
  return joined;
}

type ReplayPage = {
  /** Events each channel received on earlier pages of this replay. */
  counts: ReadonlyMap<string, number>;
  /** Only events at or before this time; absent on the first page. */
  until?: number;
  /** This page's oldest event and its newer-than-`until` events per channel. */
  oldest: number;
  got: Map<string, number>;
};
type SubscriptionTiming = {
  first?: (() => void) | undefined;
  eose?: (() => void) | undefined;
};
type Route = {
  operationId: string;
  id: string;
  channelId?: string;
  channelIds?: readonly string[];
  history?: boolean;
  /** A history route that replays its channels through one filter. */
  page?: ReplayPage;
  status: LiveRoute["status"];
  replay: LiveRoute["replay"];
  error?: string;
  wire?: string;
  count: number;
  since: number;
  liveOnly?: boolean;
  replayChannels?: readonly string[];
  previous?: Route;
  previousChannels?: readonly string[];
  retryRenewal?: boolean;
  /** Live on the socket a planned renewal replaced, over the same scope. Its
   * replay resumes from the cursor, so its EOSE needs no catch-up. */
  carried?: boolean;
  /** Every key had a cursor when the route was created, so its replay starts
   * where an earlier connection's delivery could have stopped. */
  resumed?: boolean;
  quotaRetries: number;
  /** Its REQ was sent before a grant for one of its channels arrived, so the
   * relay may have left that channel out. Re-send at its EOSE. */
  regranted?: boolean;
  /** When its REQ was sent (ms), for the slow batch refresh. */
  sentAt?: number;
  /** Consecutive refusals that need action, and when the recover tick may retry. */
  refusals?: number;
  retryAt?: number;
  deadline?: ReturnType<typeof setTimeout>;
  timing?: SubscriptionTiming | undefined;
};
export const CHANNEL_KINDS = [
  9, 40002, 40008, 45001, 45003, 40099, 40100, 40003, 5, 9005, 7, 39000, 39002,
  39005, 20002, 45010, 48100, 48101, 48102, 48103,
];
/** The browser socket and native header-capable facade share only frame transport. */
export interface LiveSocket {
  readonly readyState: number;
  readonly connectionTimeoutMs?: number;
  readonly diagnosticId?: string;
  readonly nativeTransport?: boolean;
  onopen: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  onclose: ((event: CloseEvent) => unknown) | null;
  send(data: string, diagnostic?: { operationId: string }): void;
  close(): void;
}
/** One authenticated socket, bounded joined-channel batches, singleton previews and two globals.
 * Recent replay is opportunistic: finite reads own catch-up and history bounds. */
export function subscribeRelayTraffic(
  url: string,
  sign: (event: EventTemplate) => Promise<VerifiedEvent>,
  viewer: string,
  callbacks: LiveCallbacks,
  socketFactory: (url: string) => LiveSocket = (url) => new WebSocket(url),
  admission: LiveAdmission = createLiveAdmission(),
  setupConcurrency = SETUP_CONCURRENCY,
  setupTimeoutMs = SETUP_TIMEOUT_MS,
  channelBatchSize = LIVE_BATCH_SIZE,
  random: () => number = Math.random,
  signatures?: SignatureVerifier,
): LiveSubscription {
  if (
    !Number.isInteger(channelBatchSize) ||
    channelBatchSize < 1 ||
    channelBatchSize > LIVE_BATCH_SIZE
  )
    throw new Error("Invalid channel batch size");
  const replaySlots =
    channelBatchSize > REPLAY_BATCH_SIZE ? setupConcurrency : 0;
  const log = getLogger("relay-ws");
  const peer = relayLabel(url);
  const metrics = networkMetrics.relay(url);
  const startSubscriptionTiming = () =>
    networkMetrics.enabled()
      ? {
          first: metrics.timer("subscriptionFirst"),
          eose: metrics.timer("subscriptionEose"),
        }
      : undefined;
  const subscriptionResponse = (
    owner: { timing?: SubscriptionTiming | undefined },
    eose = false,
  ) => {
    if (!owner.timing) return;
    owner.timing.first?.();
    delete owner.timing.first;
    if (eose) {
      owner.timing.eose?.();
      delete owner.timing;
    }
  };
  let connectionMetric: ReturnType<typeof metrics.connection> | undefined;
  let openedAt: number | undefined;
  let attemptPending = false;
  let probeAt: number | undefined;
  let probeCapture: number | undefined;
  let attemptCapture: number | undefined;
  const diagnosticId = crypto.randomUUID();
  let attemptDiagnosticId: string | undefined;
  const report = (
    event: string,
    fields: {
      reason?: string | undefined;
      delayMs?: number | undefined;
      ms?: number | undefined;
      status?: number | undefined;
      count?: number | undefined;
      operationId?: string | undefined;
    } = {},
  ) =>
    networkRecorder.collecting() &&
    networkRecorder.record({
      level:
        event === "socket.refused"
          ? "error"
          : fields.reason
            ? "warn"
            : event === "socket.route-established"
              ? "debug"
              : "info",
      event,
      relay: url,
      connection: diagnosticConnection(),
      operationId: `live:${diagnosticId}`,
      ...fields,
    });
  const diagnosticConnection = () => attemptDiagnosticId ?? diagnosticId;
  let closed = false;
  let socket: LiveSocket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let dispatchTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectDelay = BASE_RECONNECT_DELAY;
  let authFailures = 0;
  let generation = 0,
    serial = 0;
  let authenticated = false;
  let pendingSince: number | undefined;
  let clearIncoming = () => {};
  // Whether the relay sent anything since the last recovery tick, the probe
  // that asks it to when it did not, and the current socket's reconnect.
  let heard = false;
  // When the current socket last proved it reaches the relay (ms). A silent
  // stall ends at the detecting tick, so this, not the close, bounds liveness.
  let heardAt = 0;
  // A frame handled after a sleep may have waited through it, so the time it is
  // handled proves nothing. A recovery tick proves the app was running, and a
  // frame that arrived before one is handled by the next, so a frame proves the
  // relay reached the socket only up to the tick before the latest (or the AUTH).
  let tickedAt = 0;
  let provenAt = 0;
  let probe: string | undefined;
  let unresponsive: ((reason: string) => void) | undefined;
  // A policy close (1008) gets one fresh-evidence reconnect; only NIP-42
  // admission restores it, so a post-admission denial cannot loop.
  let policyRecovery = true;
  let connection: LiveSnapshot["status"] = "connecting";
  // A planned renewal of an admitted socket is not an outage: until the new
  // socket fails, it reports the connection and its carried routes as live.
  let renewing = false;
  // While a renewal rebuilds its routes: the cursor keys live on the old socket.
  let carrying: ReadonlySet<string> | undefined;
  // A carried route lost continuity before its replay completed (see `settle`).
  let broken = false;
  let connectionError: string | undefined;
  let interests: string[] = [];
  let joined: string[] = [];
  // Keep denial callbacks in one scheduling transaction; updates can retire
  // individual lifetimes without admitting a replacement mid-denial.
  let denying: Set<string> | undefined;
  let priority: string[] = [];
  let priorityRanks = new WeakMap<Route, number>();
  let observer: number | null = null;
  let presenceAuthors: readonly string[] = [];
  let presenceReceipt:
    | { id: string; finish(accepted: boolean): void }
    | undefined;
  const routes = new Map<string, Route>();
  const wires = new Map<string, Route>();
  // What the first connect replayed; a resume never reaches back past it.
  const original = Math.floor(Date.now() / 1000) - 300;
  // Per channel (`channel:<id>`) or global route id: when a connection that had
  // established it last heard the relay. A later connection that never
  // establishes it leaves the cursor, so flapping does not lose it.
  const cursors = new Map<string, LiveCursor>();
  // Outlives each socket, so a reconnect's replay reuses the proofs.
  const verify = createEventVerifier(LIVE_PROOF_ENTRIES, signatures);
  const cursorKeys = (route: Route) =>
    scope(route).length
      ? scope(route).map((id) => `channel:${id}`)
      : [route.id];
  // A new route replays the last five minutes; one over channels a connection
  // established resumes from their cursors instead, whenever it is created. A
  // batch needs every channel, so it starts at the earliest.
  const resumeSince = (route: Route) =>
    Math.min(
      ...cursorKeys(route).map((key) => {
        const cursor = cursors.get(key);
        return cursor ? liveResumeSince(original, cursor) : route.since;
      }),
    );
  type SyncWire = {
    operationId: string;
    filter: ArtifactSyncFilter | VerifiedProfileFilter;
    sink: ArtifactSyncSink;
    wire?: string;
    timing?: SubscriptionTiming | undefined;
  };
  const syncs = new Set<SyncWire>();
  // Artifact and verified-profile syncs share the wire budget but are admitted
  // from separate pools, so a large roster cannot refuse an artifact view.
  const profileSyncs = new Set<SyncWire>();
  const syncWires = new Map<string, SyncWire>();
  function endSync(sync: SyncWire, reason: string) {
    profileSyncs.delete(sync);
    if (!syncs.delete(sync)) return;
    if (sync.wire) syncWires.delete(sync.wire);
    sync.sink.closed(reason);
    syncInterests();
  }
  const replayQueue = new Map<string, number>();
  // Channels whose combined replay reached the limit; they replay one filter each.
  const splitReplay = new Set<string>();
  let routeSnapshots = new Map<string, LiveRoute>();
  let replayStopped = false;
  const setupState = () => {
    admission.setup(
      routes,
      !closed &&
        connection !== "error" &&
        ((!replayStopped && replayQueue.size > 0) ||
          [...routes.values()].some((route) => route.status === "pending")),
    );
  };
  const notify = () => {
    setupState();
    if (closed) return;
    const replayFailures = new Map(
      [...routes.values()]
        .filter((route) => route.history && route.error !== undefined)
        .flatMap((route) => scope(route).map((id) => [id, route] as const)),
    );
    const next = new Map<string, LiveRoute>();
    for (const route of routes.values()) {
      if (route.history) continue;
      const retained =
        route.status === "pending" && route.previous?.status === "live"
          ? new Set(route.previousChannels)
          : undefined;
      for (const channelId of route.channelIds ?? [route.channelId]) {
        const id = channelId ? `channel:${channelId}` : route.id;
        const replayFailure = channelId
          ? replayFailures.get(channelId)
          : undefined;
        const sourceStatus =
          (route.carried && route.status === "pending") ||
          (channelId !== undefined && retained?.has(channelId))
            ? "live"
            : route.status;
        const status =
          sourceStatus === "live" && replayFailure
            ? replayFailure.status
            : sourceStatus;
        const error = route.error ?? replayFailure?.error;
        const previous = routeSnapshots.get(id);
        next.set(
          id,
          previous &&
            previous.status === status &&
            previous.replay === route.replay &&
            previous.error === error
            ? previous
            : Object.freeze({
                id,
                ...(channelId ? { channelId } : {}),
                status,
                replay: route.replay,
                ...(error ? { error } : {}),
              }),
        );
      }
    }
    routeSnapshots = next;
    callbacks.state(
      Object.freeze({
        status:
          renewing && connection === "connecting" ? "connected" : connection,
        routes: Object.freeze([...next.values()]),
        ...(connectionError ? { error: connectionError } : {}),
      }),
    );
  };
  const frameContext = (value: unknown, localOperation?: string) => {
    const data = Array.isArray(value) ? value : [];
    const subscriptionId =
      ["REQ", "CLOSE", "CLOSED", "EOSE", "EVENT", "COUNT"].includes(data[0]) &&
      typeof data[1] === "string" &&
      /^[a-zA-Z0-9_-]{1,128}$/.test(data[1])
        ? data[1]
        : undefined;
    const owner = subscriptionId
      ? (wires.get(subscriptionId) ?? syncWires.get(subscriptionId))
      : undefined;
    if (owner && !owner.operationId)
      owner.operationId = `subscription:${crypto.randomUUID()}`;
    return {
      parentId: `live:${diagnosticId}`,
      operationId: owner?.operationId ?? `socket:${diagnosticConnection()}`,
      subscriptionId:
        owner || subscriptionId === probe || localOperation
          ? subscriptionId
          : undefined,
    };
  };
  const send = (value: unknown, operationId?: string) => {
    if (!closed && socket?.readyState === 1) {
      const raw = JSON.stringify(value);
      const context = networkRecorder.enabled("debug")
        ? {
            ...frameContext(value, operationId),
            ...(operationId ? { operationId } : {}),
          }
        : undefined;
      socket.send(
        raw,
        context ? { operationId: context.operationId } : undefined,
      );
      if (networkMetrics.enabled() && !socket.nativeTransport)
        metrics.frame(true, utf8Bytes(raw));
      logSocketFrame(peer, "→", raw, value, diagnosticConnection(), context);
    }
  };
  const requests = createSocketPublications(() => queueMicrotask(pump), url);
  function closeWire(route: Route) {
    clearTimeout(route.deadline);
    delete route.timing;
    if (route.wire) {
      wires.delete(route.wire); // Fence before CLOSE, including reentrant callbacks.
      send(["CLOSE", route.wire], route.operationId);
      delete route.wire;
    }
    if (route.previous) closeWire(route.previous);
    delete route.previous;
  }
  function remove(route: Route) {
    if (route.carried) broken = true;
    closeWire(route);
    routes.delete(route.id);
  }
  const scope = (route: Route) =>
    route.channelIds ?? (route.channelId ? [route.channelId] : []);
  function replace(route: Route, ids = scope(route)) {
    // A sent replacement is not yet established. Keep the established source
    // through repeated removals; retire the pending intermediate, not a survivor.
    const previous = route.previous ?? (route.wire ? route : undefined);
    const previousChannels = previous
      ? (previous === route
          ? scope(route)
          : (route.previousChannels ?? scope(previous))
        ).filter((id) => ids.includes(id))
      : [];
    const replayChannels =
      route.status !== "live"
        ? route.replayChannels?.filter((id) => ids.includes(id))
        : undefined;
    delete route.previous;
    if (previous !== route) closeWire(route); // Never retain a third wire.
    clearTimeout(route.deadline);
    const next: Route = {
      ...route,
      ...(route.channelIds ? { channelIds: ids } : {}),
      status: "pending",
      liveOnly: !replayChannels?.length,
      count: 0,
      quotaRetries: 0,
      ...(previous ? { previous, previousChannels } : {}),
    };
    delete next.replayChannels;
    if (replayChannels?.length) next.replayChannels = replayChannels;
    delete next.wire;
    delete next.deadline;
    delete next.timing;
    delete next.retryRenewal;
    // A narrowed replacement is live-only, so it has no replay to rely on.
    if (route.carried) broken = true;
    delete next.carried;
    routes.set(next.id, next);
    return next;
  }
  // The relay leaves a channel it cannot serve out of a multi-channel REQ
  // without a CLOSED, both when the REQ arrives and when access ends later. A
  // batch then stays narrower than the client thinks. Access comes back only
  // through a grant, and every grant sends the viewer a 44100 (add, join,
  // create, DM open or add, unarchive), so re-send each batch that holds a
  // granted channel. A batch whose REQ is in flight may have been checked
  // before the grant, so it is re-sent once at its EOSE. A forged notice
  // costs one extra REQ, nothing more.
  function grant(id: string) {
    let sent = false;
    for (const route of [...routes.values()]) {
      if (!route.channelIds?.includes(id)) continue;
      if (route.status === "live" && !route.previous) {
        replace(route);
        sent = true;
      } else if (route.status === "pending" && route.wire)
        route.regranted = true;
    }
    if (!sent) return;
    pump();
    notify();
  }
  function recover() {
    if (closed || !authenticated) return;
    provenAt = tickedAt;
    tickedAt = Date.now();
    // An open socket can stop delivering without an error or close, and its
    // routes then only time out. A minute of silence asks for an empty answer;
    // no answer at all means the socket is dead, so replace it. A probe is a
    // request too: during a relay cooldown it waits for a later silent minute.
    if (!heard && admission.delay()) metrics.count("probeDeferred");
    if (!heard && !admission.delay()) {
      if (probeAt !== undefined && networkMetrics.current(probeCapture))
        metrics.count("probeCancelled");
      metrics.count("probeSent");
      probeCapture = networkMetrics.epoch();
      probeAt = networkMetrics.enabled() ? performance.now() : undefined;
      report("socket.probe");
      if (probe) send(["CLOSE", probe]);
      probe = `probe-${++serial}`;
      send(["REQ", probe, { kinds: [44100], "#p": [viewer], limit: 0 }]);
      clearTimeout(deadline);
      deadline = setTimeout(() => {
        if (networkMetrics.current(probeCapture)) metrics.count("probeTimeout");
        probeAt = undefined;
        unresponsive?.("Live connection stopped answering");
      }, setupTimeoutMs);
    }
    heard = false;
    // A minute authenticated restores prompt recovery for the next rollout;
    // opening/authenticating alone must not reset backoff on a flapping relay.
    reconnectDelay = BASE_RECONNECT_DELAY;
    const current = generation;
    // `grant` re-sends a batch when access to one of its channels comes back,
    // the only time a re-send can change its scope. A lost grant would leave
    // the batch narrow for good, so a batch not sent for a long time is
    // re-sent here too.
    for (const route of routes.values()) {
      if (
        !route.history &&
        route.channelIds &&
        route.status === "live" &&
        !route.previous &&
        route.sentAt !== undefined &&
        tickedAt - route.sentAt >= LIVE_BATCH_REFRESH_INTERVAL
      )
        replace(route);
      else if (
        route.status === "error" &&
        route.retryRenewal &&
        route.previous?.wire
      ) {
        route.status = "pending";
        delete route.retryRenewal;
      } else if (
        route.status === "error" &&
        route.retryAt !== undefined &&
        route.retryAt <= Date.now()
      ) {
        route.status = "pending";
        delete route.retryAt;
      }
    }
    pump();
    notify();
    settle();
    if (closed || generation !== current) return;
    try {
      callbacks.recover?.();
    } catch (error) {
      // The chain must outlive a failing hook: log it and keep recovering.
      log.error(`${peer} live recovery hook failed`, error);
    }
    if (!closed && authenticated && generation === current)
      recoveryTimer = setTimeout(recover, LIVE_RECOVERY_INTERVAL);
  }
  function syncInterests() {
    if (denying || closed) return;
    const interested = new Set(interests);
    const members = new Set(joined);
    for (const id of replayQueue.keys())
      if (!interested.has(id) || !members.has(id)) {
        replayQueue.delete(id);
        splitReplay.delete(id);
      }
    const ranked = [
      ...new Set([
        ...priority.filter((id) => interested.has(id)),
        ...interests,
      ]),
    ];
    const retainedBatches = [...routes.values()].filter(
      (route) =>
        !route.history && route.channelIds?.some((id) => members.has(id)),
    ).length;
    const batchCount = Math.max(
      retainedBatches,
      Math.ceil(joined.length / channelBatchSize),
    );
    const previewCapacity = Math.max(
      0,
      LIVE_CHANNEL_CAPACITY -
        batchCount -
        syncs.size -
        1 - // Keep one wire for the silence probe.
        (joined.length ? setupConcurrency + replaySlots : 0) -
        (observer !== null ? 1 : 0) -
        (presenceAuthors.length ? 1 : 0),
    );
    const joinedSlots = Math.max(
      0,
      LIVE_CHANNEL_CAPACITY -
        syncs.size -
        1 -
        (setupConcurrency + replaySlots) -
        (observer !== null ? 1 : 0) -
        (presenceAuthors.length ? 1 : 0),
    );
    const admitted = new Set([
      ...joined.slice(0, joinedSlots * channelBatchSize),
      ...ranked.filter((id) => !members.has(id)).slice(0, previewCapacity),
    ]);
    const remaining = new Set(interests);
    const globals = new Set([
      "profiles",
      "membership",
      ...(observer !== null ? ["observer"] : []),
      ...(presenceAuthors.length ? ["presence"] : []),
    ]);
    // Scope is immutable for a wire. Retirement rebuilds only the affected batch;
    // navigation is scheduling, never a reason to rebalance healthy subscriptions.
    for (const route of routes.values()) {
      const ids = scope(route);
      if (route.history) {
        if (ids.some((id) => !interested.has(id) || !members.has(id))) {
          remove(route);
          for (const id of ids)
            if (interested.has(id) && members.has(id))
              replayQueue.set(id, route.since);
        }
        continue;
      }
      if (
        ids.length
          ? ids.some(
              (id) =>
                !remaining.has(id) ||
                (route.status === "limited") === admitted.has(id) ||
                (!!route.channelIds && !members.has(id)) ||
                (!route.channelIds && members.has(id)),
            )
          : !globals.has(route.id)
      ) {
        const survivors = ids.filter(
          (id) => remaining.has(id) && admitted.has(id) && members.has(id),
        );
        if (
          route.channelIds &&
          survivors.length &&
          (route.status === "live" ||
            route.liveOnly ||
            route.previous?.status === "live")
        ) {
          replace(route, survivors);
          for (const id of survivors) remaining.delete(id);
        } else remove(route);
      } else {
        for (const id of ids) remaining.delete(id);
        globals.delete(route.id);
      }
    }
    const add = (id: string, ids: readonly string[] = [], batch = false) => {
      const route: Route = {
        operationId: networkRecorder.enabled("debug")
          ? `subscription:${crypto.randomUUID()}`
          : "",
        id,
        ...(batch ? { channelIds: ids } : ids[0] ? { channelId: ids[0] } : {}),
        status: "pending",
        replay: "unknown",
        count: 0,
        quotaRetries: 0,
        since: Math.floor(Date.now() / 1000) - 300,
      };
      route.since = resumeSince(route);
      if (ids.length > REPLAY_BATCH_SIZE) {
        route.liveOnly = true;
        for (const id of ids) replayQueue.set(id, route.since);
      }
      route.resumed = cursorKeys(route).every((key) => cursors.has(key));
      // Presence and observer feeds establish nothing, so carry no obligation.
      if (
        carrying &&
        id !== "presence" &&
        id !== "observer" &&
        cursorKeys(route).every((key) => carrying?.has(key))
      )
        route.carried = true;
      routes.set(id, route);
      return route;
    };
    for (const id of globals) {
      const route = add(id);
      if (id === "presence") route.liveOnly = true;
    }
    const batch: string[] = [];
    for (const id of remaining) {
      if (!admitted.has(id)) {
        const route = add(`channel:${id}`, [id]);
        route.status = "limited";
        route.error =
          "Live channel capacity reached; finite reads remain available";
      } else if (!members.has(id)) add(`channel:${id}`, [id]);
      else batch.push(id);
    }
    let offset = 0;
    for (const route of routes.values()) {
      if (
        route.history ||
        !route.channelIds ||
        route.channelIds.length >= channelBatchSize ||
        offset === batch.length
      )
        continue;
      const added = batch.slice(
        offset,
        offset + channelBatchSize - route.channelIds.length,
      );
      offset += added.length;
      const expanded = [...route.channelIds, ...added];
      const next = replace(route, expanded);
      next.replayChannels = expanded.filter(
        (id) =>
          !(
            next.previous?.status === "live" &&
            next.previousChannels?.includes(id)
          ),
      );
      next.liveOnly = !next.replayChannels.length;
      next.since = resumeSince({
        ...next,
        since: Math.floor(Date.now() / 1000) - 300,
      });
      if (expanded.length > REPLAY_BATCH_SIZE) {
        for (const id of next.replayChannels) replayQueue.set(id, next.since);
        delete next.replayChannels;
        next.liveOnly = true;
      }
    }
    for (let i = offset; i < batch.length; i += channelBatchSize)
      add(`batch:${++serial}`, batch.slice(i, i + channelBatchSize), true);
    pump();
    notify();
    settle();
  }
  /** A stop waits for manual Retry, so an earlier refusal's deadline must not revive it. */
  function stop(route: Route, reason: string) {
    if (route.carried) broken = true;
    delete route.carried;
    route.status = "error";
    route.error = reason;
    delete route.retryAt;
  }
  function fail(route: Route, reason: string, transient = false) {
    report("socket.route-failed", {
      reason,
      count: scope(route).length,
      operationId: route.operationId,
    });
    const denial = reason === "restricted: not a channel member";
    const previous = route.previous;
    // A failure can retain the old source only while its full scope remains allowed.
    const retain =
      transient &&
      previous?.status === "live" &&
      previous.wire &&
      wires.get(previous.wire) === previous &&
      JSON.stringify(scope(previous)) ===
        JSON.stringify(route.previousChannels ?? scope(route));
    if (retain) delete route.previous;
    closeWire(route);
    if (route.carried) broken = true;
    delete route.carried;
    delete route.retryRenewal;
    delete route.retryAt;
    if (retain) {
      route.previous = previous;
      // Quota owns its existing bounded retries; the minute timer cannot reset it.
      route.retryRenewal = !reason.startsWith("rate-limited:");
    }
    route.status = "error";
    route.error = reason;
    // A denial belongs to the session's membership flow. Any other refusal can
    // still clear, so the recover tick retries it with backoff.
    if (!transient && !denial) {
      route.refusals = (route.refusals ?? 0) + 1;
      route.retryAt = Date.now() + liveSlowRetryDelay(route.refusals);
    }
    if (reason.startsWith("rate-limited:")) {
      const hint = /^rate-limited: quota exceeded; retry in (\d+)s$/.exec(
        reason,
      );
      const seconds = hint ? Number(hint[1]) : 5;
      if (!Number.isSafeInteger(seconds) || seconds > 60) {
        replayStopped = true;
        for (const queued of routes.values())
          if (queued.status === "pending" && !queued.wire)
            stop(queued, "Unsupported live cooldown; automatic setup stopped");
        // Conservative shared pause survives replacement; never overflow a timer.
        admission.pause(
          Number.isSafeInteger(seconds) && seconds <= 86400 ? seconds : 86400,
        );
      } else {
        admission.pause(seconds);
        if (++route.quotaRetries <= MAX_QUOTA_RETRIES) route.status = "pending";
        else {
          replayStopped = true;
          // Stop the unsent queue too: rejection must never drain it into an exhausted budget.
          for (const queued of routes.values())
            if (queued.status === "pending" && !queued.wire)
              stop(
                queued,
                "Live request cooldown retries exhausted; retry available",
              );
        }
      }
    }
    if (denial) {
      const current = generation;
      const denied = new Set(scope(route));
      denying = denied;
      try {
        notify();
        for (const id of denied) {
          if (closed || generation !== current) break;
          callbacks.denied(id, reason);
        }
      } finally {
        denying = undefined;
        syncInterests();
      }
    } else notify();
    pump();
    settle();
  }
  const establish = (route: Route) => {
    if (route.id === "profiles" || route.id === "membership")
      callbacks.established(
        undefined,
        Object.freeze({
          route: route.id,
          // The count covers every filter of the route, so any filter the
          // limit cut marks it. A retry keeps the route's original since; a
          // live-only replacement replays nothing.
          continuous:
            !!route.resumed && !route.liveOnly && route.replay !== "limited",
        }),
      );
    else if (route.id !== "observer" && route.id !== "presence")
      callbacks.established(route.channelIds ?? route.channelId);
  };
  /** A renewal stays quiet only while every carried route keeps continuity.
   * Once one fails or stops, is replaced or replays a cut window, no
   * consumer may rely on it: report the drop the renewal hid, as after any
   * outage, and establish every live route again. Before AUTH, the state still due
   * reports the drop, and each route establishes at its own EOSE. */
  function settle() {
    if (!broken || closed) return;
    broken = false;
    for (const route of routes.values()) delete route.carried;
    if (renewing) {
      renewing = false;
      notify();
      return;
    }
    if (!authenticated) return;
    const current = generation;
    connection = "connecting";
    notify();
    if (closed || generation !== current) return;
    connection = "connected";
    notify();
    for (const route of [...routes.values()]) {
      if (closed || generation !== current) return;
      if (route.status === "live" && routes.get(route.id) === route)
        establish(route);
    }
  }
  function pump() {
    setupState();
    clearTimeout(dispatchTimer);
    if (closed || denying || !authenticated || socket?.readyState !== 1) return;
    for (let request = requests.next(); request; request = requests.next()) {
      const delay = admission.delay();
      if (delay > 0) {
        dispatchTimer = setTimeout(pump, delay);
        return;
      }
      requests.dispatch(request, send);
    }
    for (const sync of syncs) {
      if (sync.wire) continue;
      if (wires.size + syncWires.size + (probe ? 1 : 0) >= 1024) break;
      const delay = admission.delay();
      if (delay > 0) {
        dispatchTimer = setTimeout(pump, delay);
        return;
      }
      sync.wire = `sync-${++serial}`;
      syncWires.set(sync.wire, sync);
      sync.timing = startSubscriptionTiming();
      send(["REQ", sync.wire, sync.filter]);
    }
    let active = [...routes.values()].filter(
      (route) => route.wire && route.status === "pending",
    ).length;
    // Persistent streams get their setup slots first. Replay retains only IDs
    // in the queue, and each request keeps a separate allowance per channel.
    if (
      !replayStopped &&
      ![...routes.values()].some(
        (route) =>
          route.status === "pending" && (!route.history || !route.wire),
      )
    ) {
      for (
        let slot = active;
        slot < setupConcurrency &&
        wires.size + syncWires.size + (probe ? 1 : 0) + (slot - active) < 1024;
        slot++
      ) {
        const ids: string[] = [];
        let since = Infinity;
        let split: boolean | undefined;
        for (const [id, time] of replayQueue) {
          const single = splitReplay.has(id);
          split ??= single;
          if (single !== split) continue;
          if (
            ids.length >= (split ? REPLAY_BATCH_SIZE : COMBINED_REPLAY_CHANNELS)
          )
            break;
          replayQueue.delete(id);
          splitReplay.delete(id);
          ids.push(id);
          since = Math.min(since, time);
        }
        if (!ids.length) break;
        const id = `replay:${++serial}`;
        routes.set(id, {
          operationId: networkRecorder.enabled("debug")
            ? `subscription:${crypto.randomUUID()}`
            : "",
          id,
          channelIds: ids,
          history: true,
          ...(split
            ? {}
            : {
                page: { counts: new Map(), oldest: Infinity, got: new Map() },
              }),
          status: "pending",
          replay: "limited",
          count: 0,
          quotaRetries: 0,
          since,
        });
      }
    }
    const rank = (route: Route) => {
      const known = priorityRanks.get(route);
      if (known !== undefined) return known;
      const value = !scope(route).length
        ? -2
        : !priority.length
          ? 0
          : Math.min(
              priority.length,
              ...scope(route).map((id) =>
                priority.includes(id) ? priority.indexOf(id) : priority.length,
              ),
            );
      priorityRanks.set(route, value);
      return value;
    };
    for (const route of [...routes.values()].sort(
      (a, b) =>
        Number(a.previous?.status === "live") -
          Number(b.previous?.status === "live") || rank(a) - rank(b),
    )) {
      if (active >= setupConcurrency) break;
      if (route.status !== "pending" || route.wire) continue;
      if (wires.size + syncWires.size + (probe ? 1 : 0) >= 1024) break;
      const delay = admission.delay();
      if (delay > 0) {
        dispatchTimer = setTimeout(pump, delay);
        break;
      }
      // A retry being sent is not recovery. Retain its last failure until EOSE.
      const wire = `live-${++serial}`;
      route.wire = wire;
      delete route.regranted; // This REQ is sent after every earlier grant.
      route.sentAt = Date.now();
      if (route.page) {
        route.page.oldest = Infinity;
        route.page.got = new Map();
      }
      wires.set(wire, route);
      route.deadline = setTimeout(() => {
        if (wires.get(wire) === route)
          fail(
            route,
            "Live subscription setup timed out; retry available",
            true,
          );
      }, setupTimeoutMs);
      active++;
      if (route.id === "observer") route.since = Math.floor(Date.now() / 1000);
      const filters = scope(route).length
        ? (route.liveOnly || route.page
            ? [scope(route)]
            : scope(route).map((id) => [id])
          ).map((ids) => ({ kinds: CHANNEL_KINDS, "#h": ids }))
        : route.id === "presence"
          ? [{ kinds: [20001], authors: presenceAuthors }]
          : route.id === "profiles"
            ? [{ kinds: [0, 10100, 30177] }]
            : route.id === "observer"
              ? [{ kinds: [OBSERVER_KIND], "#p": [viewer] }]
              : [
                  { kinds: [44100, 44101], "#p": [viewer] },
                  // NIP-CL: the relay sends a system channel's notices only
                  // to a filter that asks for them with #t.
                  { kinds: [44100, 44101], "#p": [viewer], "#t": ["system"] },
                ];
      route.timing = startSubscriptionTiming();
      send([
        "REQ",
        wire,
        ...filters.map((filter) => ({
          ...filter,
          // Survivor filters stay live-only so replay cannot suppress a fresh alert.
          since: route.since,
          ...(route.page?.until !== undefined
            ? { until: route.page.until }
            : {}),
          ...(route.id === "observer"
            ? {}
            : {
                limit:
                  route.liveOnly ||
                  (route.replayChannels &&
                    "#h" in filter &&
                    !filter["#h"].some((id) =>
                      route.replayChannels?.includes(id),
                    ))
                    ? 0
                    : LIVE_REPLAY_LIMIT,
              }),
        })),
        ...(route.id === "membership"
          ? [
              {
                kinds: [30078],
                authors: [viewer],
                "#t": ["read-state"],
                since: route.since,
                limit: LIVE_REPLAY_LIMIT,
              },
              // Edits from another device; history and due times come from the reader.
              {
                kinds: [30300],
                authors: [viewer],
                since: route.since,
                limit: LIVE_REPLAY_LIMIT,
              },
            ]
          : []),
        ...(route.id === "profiles"
          ? [
              {
                kinds: [30315],
                "#d": ["general"],
                since: route.since,
                limit: LIVE_REPLAY_LIMIT,
              },
              {
                kinds: [30030],
                "#d": [EMOJI_SET],
                since: route.since,
                limit: LIVE_REPLAY_LIMIT,
              },
            ]
          : []),
      ]);
    }
  }
  function clearSocket() {
    if (authenticated) {
      // EOSE on this connection is the only evidence a route was live. A
      // renewal, pending or failed, still streams through the established wire
      // it kept, but only for the channels the route still covers.
      // Receiving a frame is not delivery while its native check is pending.
      const liveUntil = Math.floor(
        Math.min(heardAt, pendingSince ?? heardAt) / 1000,
      );
      for (const route of routes.values()) {
        const { previous } = route;
        const source =
          route.status === "live"
            ? route
            : previous?.status === "live" &&
                previous.wire &&
                wires.get(previous.wire) === previous
              ? previous
              : undefined;
        if (!source) continue;
        const kept = new Set(cursorKeys(source));
        for (const key of cursorKeys(route))
          if (kept.has(key)) cursors.set(key, { liveUntil });
      }
    }
    generation++;
    clearIncoming();
    authenticated = false;
    presenceReceipt?.finish(false);
    admission.setup(routes, false);
    clearTimeout(dispatchTimer);
    clearTimeout(recoveryTimer);
    clearTimeout(deadline);
    for (const route of routes.values()) clearTimeout(route.deadline);
    replayQueue.clear();
    splitReplay.clear();
    replayStopped = false;
    wires.clear();
    requests.clear();
    // A sync has no resume: every sent one ends; unsent ones wait for the next socket.
    const lost = [...syncs].filter((sync) => sync.wire);
    syncWires.clear();
    for (const sync of lost)
      endSync(sync, "disconnected: live connection lost");
    if (attemptPending && networkMetrics.current(attemptCapture))
      metrics.count("connectCancelled");
    attemptPending = false;
    connectionMetric?.("closed");
    connectionMetric = undefined;
    if (probeAt !== undefined && networkMetrics.current(probeCapture))
      metrics.count("probeCancelled");
    probeAt = undefined;
    if (socket) log.info(`${peer} disconnect`);
    socket?.close();
    socket = undefined;
  }
  function connect(
    renewal = false,
    trigger: "initial" | "failure" | "renewal" | "manual" = "failure",
  ) {
    if (closed) return;
    attemptDiagnosticId = undefined;
    // A renewal before the last one's carried routes completed their replay
    // cannot prove continuity for them: it is an ordinary reconnect.
    if ([...routes.values()].some((route) => route.carried)) renewal = false;
    broken = false;
    // Only a route live on the admitted socket, with no pending replacement,
    // is carried: its cursor is current and its scope is unchanged.
    const carried = renewal
      ? new Set(
          [...routes.values()]
            .filter((route) => route.status === "live" && !route.previous)
            .flatMap(cursorKeys),
        )
      : undefined;
    clearSocket();
    routes.clear();
    renewing = renewal;
    connection = "connecting";
    connectionError = undefined;
    carrying = carried;
    try {
      syncInterests();
    } finally {
      carrying = undefined;
    }
    const used = new Set([...routes.values()].flatMap(cursorKeys));
    for (const key of cursors.keys()) if (!used.has(key)) cursors.delete(key);
    const current = generation;
    attemptDiagnosticId = `${diagnosticId}:${current}`;
    const valid = () => !closed && current === generation;
    heard = false;
    probe = undefined;
    const reconnect = (reason: string, closeCode?: number) => {
      if (!valid()) return;
      if (!attemptPending || networkMetrics.current(attemptCapture))
        metrics.count(attemptPending ? "connectFailed" : "disconnects");
      attemptPending = false;
      log.warn(`${peer} ${reason}`);
      clearSocket();
      renewing = false;
      broken = false;
      for (const route of routes.values()) delete route.carried;
      connection = "retrying";
      connectionError = reason;
      for (const route of routes.values())
        if (route.status !== "limited") route.status = "pending";
      notify();
      // Transient outages must recover without manual retry. Jitter spreads
      // reconnects while retaining a minimum delay under sustained failure.
      const delay = liveReconnectDelay(closeCode, reconnectDelay, random);
      report("socket.retry", { reason, delayMs: delay, status: closeCode });
      reconnectDelay = Math.min(MAX_RECONNECT_DELAY, reconnectDelay * 2);
      retryTimer = setTimeout(() => connect(), delay);
    };
    unresponsive = reconnect;
    // The error stays in state. Recovery treats it as settled, so only this
    // slow timer retries it; a signer/viewer mismatch cannot clear and never does.
    const terminal = (reason: string, retryable = true) => {
      if (!valid()) return;
      if (!attemptPending || networkMetrics.current(attemptCapture))
        metrics.count(attemptPending ? "connectFailed" : "disconnects");
      attemptPending = false;
      log.error(`${peer} ${reason}`);
      clearSocket();
      renewing = false;
      broken = false;
      for (const route of routes.values()) delete route.carried;
      connection = "error";
      connectionError = reason;
      notify();
      report("socket.refused", {
        reason,
        delayMs: retryable ? liveSlowRetryDelay(authFailures + 1) : undefined,
      });
      if (retryable)
        retryTimer = setTimeout(
          () => connect(),
          liveSlowRetryDelay(++authFailures),
        );
    };
    metrics.count("connects");
    attemptPending = true;
    attemptCapture = networkMetrics.epoch();
    if (trigger === "failure") metrics.count("reconnects");
    if (trigger === "renewal") metrics.count("renewals");
    if (trigger === "manual") metrics.count("manual");
    connectionMetric = metrics.connection();
    openedAt = undefined;
    let ws: LiveSocket;
    const started = performance.now();
    try {
      log.info(`${peer} connecting`);
      ws = socketFactory(url);
      socket = ws;
      attemptDiagnosticId = ws.diagnosticId ?? attemptDiagnosticId;
      report("socket.connect");
    } catch {
      reconnect("Live connection unavailable");
      return;
    }
    let authId: string | undefined;
    let authenticating = false;
    deadline = setTimeout(
      () => reconnect("Live authentication timed out"),
      ws.connectionTimeoutMs ?? 10000,
    );
    ws.onopen = () => {
      if (!valid()) return;
      openedAt = performance.now();
      connectionMetric?.("open");
      if (networkMetrics.current(attemptCapture))
        metrics.duration("opening", openedAt - started);
      report("socket.open", { ms: openedAt - started });
      log.info(`${peer} connected`);
      if (ws.connectionTimeoutMs !== undefined) {
        clearTimeout(deadline);
        deadline = setTimeout(
          () => reconnect("Live authentication timed out"),
          10000,
        );
      }
    };
    const incoming: {
      data: unknown[];
      bytes: number;
      receivedAt: number;
      done: () => void;
    }[] = [];
    let incomingBytes = 0;
    let draining = false;
    clearIncoming = () => {
      for (const frame of incoming) frame.done();
      incoming.length = 0;
      incomingBytes = 0;
      pendingSince = undefined;
    };
    const active = (data: unknown[]) =>
      authenticated &&
      typeof data[1] === "string" &&
      (wires.has(data[1]) || syncWires.has(data[1]));
    const drain = async () => {
      const native = verify.native;
      if (!native) return;
      draining = true;
      try {
        while (valid() && incoming.length) {
          // Coalesce a burst and let rendering/input run between hash batches.
          await yieldToHost();
          if (!valid()) return;
          const batch = incoming.slice(0, VERIFY_BATCH_SIZE);
          const prepared = new Map<unknown[], PreparedEvent>();
          for (const { data } of batch) {
            if (data[0] !== "EVENT" || !active(data)) continue;
            try {
              prepared.set(data, native.prepare(data[2]));
            } catch {
              // Delivery retains each stream's existing invalid-event policy.
            }
          }
          const checked = await native.settle([...prepared.values()]);
          if (!valid()) return;
          const events = new Map(
            [...prepared.keys()].map((data, index) => [data, checked[index]]),
          );
          // Keep the batch in the queue through callbacks: a callback can close
          // the connection, and its resume must include any undelivered frames.
          for (const frame of batch) {
            if (!valid()) return;
            receive(frame.data, events.get(frame.data));
            if (!valid()) return;
            incoming.shift();
            incomingBytes -= frame.bytes;
            pendingSince = incoming[0]?.receivedAt;
            frame.done();
          }
        }
      } catch {
        reconnect("Live event verification failed");
      } finally {
        draining = false;
      }
    };
    ws.onmessage = async (event) => {
      if (!valid()) return;
      if (authenticated) {
        // Any frame proves the socket still reaches the relay, as of the tick
        // before the latest.
        heard = true;
        heardAt = provenAt;
        clearTimeout(deadline);
      }
      if (typeof event.data !== "string" || event.data.length > 1024 * 1024) {
        logSocketFrame(
          peer,
          "←",
          event.data,
          undefined,
          diagnosticConnection(),
        );
        return;
      }
      if (networkMetrics.enabled() && !ws.nativeTransport)
        metrics.frame(false, utf8Bytes(event.data));
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        logSocketFrame(
          peer,
          "←",
          event.data,
          undefined,
          diagnosticConnection(),
        );
        return;
      }
      logSocketFrame(peer, "←", event.data, data, diagnosticConnection(), {
        ...(networkRecorder.enabled("debug") ? frameContext(data) : {}),
        ...(
          event as MessageEvent & {
            diagnostic?: { nativeAt: number; frameSequence: number };
          }
        ).diagnostic,
      });
      if (!Array.isArray(data)) return;
      if (
        probe &&
        data[1] === probe &&
        (data[0] === "EOSE" || data[0] === "CLOSED")
      ) {
        if (data[0] === "EOSE") {
          if (networkMetrics.current(probeCapture))
            metrics.count("probeAnswered");
          if (probeAt !== undefined && networkMetrics.current(probeCapture))
            metrics.duration("rtt", performance.now() - probeAt);
          send(["CLOSE", probe]);
        } else if (
          typeof data[2] === "string" &&
          data[2].startsWith("rate-limited:")
        ) {
          const hint = /retry in (\d+)s$/.exec(data[2]);
          admission.pause(hint ? Math.min(Number(hint[1]), 86400) : 5);
        }
        probeAt = undefined;
        probe = undefined;
        return;
      }
      if (
        data[0] === "AUTH" &&
        typeof data[1] === "string" &&
        !authenticating
      ) {
        authenticating = true;
        try {
          const auth = await sign({
            kind: 22242,
            content: "",
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ["relay", url],
              ["challenge", data[1]],
            ],
          });
          if (!valid()) return;
          if (auth.pubkey !== viewer) {
            terminal("Live signer does not match viewer", false);
            return;
          }
          authId = auth.id;
          send(["AUTH", auth]);
        } catch {
          terminal("Live authentication signing failed");
        }
        return;
      }
      if (data[0] === "OK" && authId && data[1] === authId && !authenticated) {
        if (data[2] !== true) {
          terminal("Relay rejected live authentication");
          return;
        }
        clearTimeout(deadline);
        authenticated = true;
        connectionMetric?.("authenticated");
        if (networkMetrics.current(attemptCapture)) metrics.count("connectOk");
        attemptPending = false;
        if (networkMetrics.current(attemptCapture))
          metrics.duration("ready", performance.now() - started);
        if (openedAt !== undefined && networkMetrics.current(attemptCapture))
          metrics.duration("authentication", performance.now() - openedAt);
        if (trigger === "failure" && networkMetrics.current(attemptCapture))
          metrics.count("restored");
        report("socket.authenticated", { ms: performance.now() - started });
        heardAt = provenAt = tickedAt = Date.now();
        authFailures = 0;
        policyRecovery = true;
        renewing = false;
        connection = "connected";
        recoveryTimer = setTimeout(recover, LIVE_RECOVERY_INTERVAL);
        pump();
        notify();
        return;
      }
      if (data[0] === "OK" && presenceReceipt?.id === data[1]) {
        if (
          data[2] === false &&
          typeof data[3] === "string" &&
          data[3].startsWith("rate-limited:")
        ) {
          const hint = /^rate-limited: quota exceeded; retry in (\d+)s$/.exec(
            data[3],
          );
          const seconds = hint ? Number(hint[1]) : 86400;
          admission.pause(
            Number.isSafeInteger(seconds) && seconds <= 86400 ? seconds : 86400,
          );
        }
        presenceReceipt?.finish(data[2] === true);
        return;
      }
      if (authenticated && requests.receive(data)) {
        if (data[2] === false) {
          const reason = data[3];
          if (
            typeof reason === "string" &&
            reason.startsWith("rate-limited:")
          ) {
            const hint = /retry in (\d+)s$/.exec(reason);
            admission.pause(hint ? Math.min(Number(hint[1]), 86400) : 5);
          }
        }
        return;
      }
      if (
        !active(data) ||
        !["EVENT", "EOSE", "CLOSED"].includes(data[0] as string)
      )
        return;
      if (!verify.native) {
        let checked: RelayEvent | undefined;
        if (data[0] === "EVENT") {
          try {
            checked = verify(data[2]);
          } catch {
            // The receiving stream decides whether an invalid event ends it.
          }
        }
        receive(data, checked);
        return;
      }
      const bytes = event.data.length * 2;
      if (
        incoming.length >= VERIFY_QUEUE_FRAMES ||
        incomingBytes + bytes > VERIFY_QUEUE_BYTES
      ) {
        reconnect("Live event verification backlog exceeded");
        return;
      }
      await new Promise<void>((done) => {
        incoming.push({ data, bytes, receivedAt: heardAt, done });
        incomingBytes += bytes;
        pendingSince ??= heardAt;
        if (!draining) void drain();
      });
    };
    function receive(data: unknown[], checked?: RelayEvent) {
      if (!valid()) return;
      const sync =
        typeof data[1] === "string" ? syncWires.get(data[1]) : undefined;
      if (sync) {
        if (!authenticated) return;
        if (data[0] === "EVENT") {
          if (!checked) {
            send(["CLOSE", data[1]]);
            endSync(sync, "error: relay supplied an invalid event");
            return;
          }
          subscriptionResponse(sync);
          sync.sink.event(checked);
        } else if (data[0] === "EOSE") {
          subscriptionResponse(sync, true);
          sync.sink.eose();
        } else if (data[0] === "CLOSED") {
          // `disconnected:` is reserved for local socket loss.
          const reason =
            typeof data[2] === "string" && !data[2].startsWith("disconnected:")
              ? data[2].slice(0, 512)
              : "error: relay closed the sync";
          // The quota is shared: the view's restart and every other queued
          // dispatch wait for the server cooldown.
          if (reason.startsWith("rate-limited:")) {
            const hint = /retry in (\d+)s$/.exec(reason);
            admission.pause(hint ? Math.min(Number(hint[1]), 86400) : 5);
          }
          endSync(sync, reason);
        }
        return;
      }
      const route =
        typeof data[1] === "string" ? wires.get(data[1]) : undefined;
      if (!authenticated || !route) return;
      const currentRoute = routes.get(route.id);
      const previous = currentRoute?.previous === route;
      if (currentRoute !== route && !previous) return;
      if (previous && data[0] !== "EVENT") {
        if (data[0] === "CLOSED") {
          closeWire(route);
          delete currentRoute.previous;
        }
        return;
      }
      if (data[0] === "EVENT") {
        if (!checked) {
          // One undecodable event must not take the route (or its batch) down.
          log.warn(`${peer} dropped an undecodable live event`);
          // It still took a slot in the relay's limit, so a full replay must
          // not look complete.
          if (route.status === "pending" && !route.liveOnly) route.count++;
          return;
        }
        const incoming = checked;
        const ids = scope(route);
        const tags = incoming.tags.filter(([name]) => name === "h");
        const destination =
          tags.length === 1
            ? tags[0]?.[1]
            : !tags.length && [39000, 39002].includes(incoming.kind)
              ? incoming.tags.find(([name]) => name === "d")?.[1]
              : undefined;
        const channelId =
          destination && ids.includes(destination)
            ? destination
            : !tags.length && route.channelId
              ? route.channelId
              : undefined;
        if (
          ids.length &&
          tags.length &&
          !tags.some(([, id]) => id && ids.includes(id))
        )
          return;
        if (previous) {
          const retained = currentRoute.previousChannels ?? scope(currentRoute);
          // Untagged auxiliary events cannot inherit a narrowed scope. Preserve
          // the original source fence; the replacement can deliver fresh copies.
          if (
            channelId
              ? !retained.includes(channelId)
              : ids.some((id) => !retained.includes(id))
          )
            return;
        }
        // The session still verifies access and auxiliary target evidence.
        if (incoming.kind === 20002 && !channelId) return;
        const replaying =
          route.status === "pending" &&
          !route.liveOnly &&
          (!route.replayChannels ||
            !channelId ||
            route.replayChannels.includes(channelId));
        if (replaying) route.count++;
        if (replaying && route.page) {
          const { page } = route;
          page.oldest = Math.min(page.oldest, incoming.created_at);
          // An event at `until` may repeat the last page; never count it twice.
          if (
            channelId &&
            (page.until === undefined || incoming.created_at < page.until)
          )
            page.got.set(channelId, (page.got.get(channelId) ?? 0) + 1);
        }
        if (route.id === "presence") {
          if (
            incoming.kind === 20001 &&
            presenceAuthors.includes(incoming.pubkey)
          ) {
            subscriptionResponse(route);
            callbacks.presence?.(incoming);
          }
        } else if (route.id === "observer") {
          if (
            observer !== null &&
            incoming.kind === OBSERVER_KIND &&
            incoming.created_at >= route.since
          ) {
            subscriptionResponse(route);
            callbacks.telemetry?.(incoming, observer);
          }
        } else if (incoming.kind !== OBSERVER_KIND) {
          subscriptionResponse(route);
          callbacks.receive(
            [incoming],
            Object.freeze({
              phase: replaying ? "replay" : "live",
              ...(channelId
                ? { channelId }
                : ids.length
                  ? { sourceChannels: ids }
                  : {}),
            }),
          );
          if (
            valid() &&
            route.id === "membership" &&
            incoming.kind === 44100 &&
            destination
          )
            grant(destination);
        }
      } else if (data[0] === "EOSE" && route.status === "pending") {
        subscriptionResponse(route, true);
        if (route.history) {
          const { page } = route;
          if (page && route.count >= LIVE_REPLAY_LIMIT) {
            const counts = new Map(page.counts);
            for (const [id, n] of page.got)
              counts.set(id, (counts.get(id) ?? 0) + n);
            const rest = scope(route).filter(
              (id) =>
                route.count > LIVE_REPLAY_LIMIT ||
                (counts.get(id) ?? 0) < LIVE_REPLAY_LIMIT,
            );
            // Extra frames may be live fan-out (including duplicates or
            // backdated events), so neither counts nor cutoff prove a prefix.
            // A full page within one second, or without a decodable event,
            // also cannot move the cutoff.
            if (
              route.count > LIVE_REPLAY_LIMIT ||
              !(page.oldest < (page.until ?? Infinity))
            )
              for (const id of rest) {
                replayQueue.set(id, route.since);
                splitReplay.add(id);
              }
            else if (rest.length) {
              const id = `replay:${++serial}`;
              routes.set(id, {
                operationId: networkRecorder.enabled("debug")
                  ? `subscription:${crypto.randomUUID()}`
                  : "",
                id,
                channelIds: rest,
                history: true,
                page: {
                  counts,
                  until: page.oldest,
                  oldest: Infinity,
                  got: new Map(),
                },
                status: "pending",
                replay: "limited",
                count: 0,
                quotaRetries: 0,
                since: route.since,
              });
            }
          }
          const failed = route.error !== undefined;
          remove(route);
          if (failed) notify();
          pump();
          return;
        }
        report("socket.route-established", {
          count: scope(route).length,
          operationId: route.operationId,
        });
        clearTimeout(route.deadline);
        if (route.previous) closeWire(route.previous);
        delete route.previous;
        route.status = "live";
        delete route.error;
        delete route.refusals;
        route.replay =
          route.count >= LIVE_REPLAY_LIMIT ||
          (route.liveOnly && scope(route).length > REPLAY_BATCH_SIZE)
            ? "limited"
            : "unknown";
        // A carried route's replay covered the renewal unless the limit cut it.
        const caughtUp = route.carried && route.replay !== "limited";
        if (route.carried && !caughtUp) broken = true;
        delete route.carried;
        notify();
        if (!valid()) return;
        // A cut replay establishes every live route, this one included, even
        // if a listener retired it meanwhile.
        if (broken) settle();
        else if (!caughtUp && wires.get(route.wire ?? "") === route)
          establish(route);
        if (
          valid() &&
          route.regranted &&
          routes.get(route.id) === route &&
          route.status === "live"
        ) {
          replace(route);
          notify();
        }
        if (valid()) pump();
      } else if (data[0] === "CLOSED") {
        const reason =
          typeof data[2] === "string"
            ? data[2].slice(0, 512)
            : "Relay closed live subscription";
        fail(
          route,
          reason,
          reason.startsWith("rate-limited:") || reason.startsWith("error:"),
        );
      }
    }
    ws.onerror = (event) => {
      const failure = event as Event & { terminal?: boolean; message?: string };
      if (failure.terminal)
        terminal(
          failure.message || "Federated relay authorization unavailable",
          // The relay refused a connection without a token. Back off slowly
          // while signed out; signing in retries at once (onSignedIn).
          FEDERATED_SIGN_IN_REFUSALS.has(failure.message ?? ""),
        );
      else reconnect("Live connection interrupted");
    };
    // Keep the relay's close detail. A 1008 also ends a normally expired
    // assertion, so the first reconnects with fresh evidence. The relay denies
    // after the upgrade and NIP-42, so a second 1008 before admission stops.
    ws.onclose = (event) => {
      // A replaced socket's late close must not spend the current budget.
      if (!valid()) return;
      // A planned federated renewal of an admitted connection reconnects at
      // once and quietly; routes resume from their cursors. One that never
      // authenticated takes the ordinary backoff, so it cannot spin.
      if (authenticated && (event as { renew?: true } | undefined)?.renew) {
        report("socket.renew");
        log.info(`${peer} renewing federated authorization`);
        return connect(true, "renewal");
      }
      const reason = event?.code
        ? `Live connection closed (${event.code}${event.reason ? `: ${event.reason}` : ""})`
        : "Live connection closed";
      if (event?.code !== 1008) return reconnect(reason, event?.code);
      if (!policyRecovery) return terminal(reason, false);
      policyRecovery = false;
      reconnect(reason);
    };
  }
  connect(false, "initial");
  return {
    syncArtifacts(filter, sink) {
      const sync: SyncWire = {
        operationId: networkRecorder.enabled("debug")
          ? `subscription:${crypto.randomUUID()}`
          : "",
        filter,
        sink,
      };
      if (closed) {
        queueMicrotask(() =>
          sink.closed("unsupported: relay session disposed"),
        );
        return () => {};
      }
      if (syncs.size - profileSyncs.size >= ARTIFACT_SYNC_MAX_VIEWS) {
        queueMicrotask(() =>
          sink.closed("error: artifact sync capacity reached"),
        );
        return () => {};
      }
      syncs.add(sync);
      syncInterests();
      return () => {
        if (!syncs.delete(sync)) return;
        if (sync.wire) {
          syncWires.delete(sync.wire);
          send(["CLOSE", sync.wire], sync.operationId);
        }
        syncInterests();
      };
    },
    syncVerifiedProfiles(filter, sink) {
      const checked = verifiedProfileFilter(filter.authors[0], filter["#d"]);
      const sync: SyncWire = {
        operationId: networkRecorder.enabled("debug")
          ? `subscription:${crypto.randomUUID()}`
          : "",
        filter: checked,
        sink,
      };
      if (closed) {
        queueMicrotask(() =>
          sink.closed("unsupported: relay session disposed"),
        );
        return () => {};
      }
      if (profileSyncs.size >= VERIFIED_PROFILE_MAX_SYNCS) {
        queueMicrotask(() =>
          sink.closed("error: profile sync capacity reached"),
        );
        return () => {};
      }
      syncs.add(sync);
      profileSyncs.add(sync);
      syncInterests();
      return () => {
        profileSyncs.delete(sync);
        if (!syncs.delete(sync)) return;
        if (sync.wire) {
          syncWires.delete(sync.wire);
          send(["CLOSE", sync.wire], sync.operationId);
        }
        syncInterests();
      };
    },
    watchPresence(authors) {
      const next = livePresenceAuthors(authors);
      if (closed || JSON.stringify(next) === JSON.stringify(presenceAuthors))
        return;
      presenceAuthors = next;
      const route = routes.get("presence");
      if (route) {
        if (next.length) replace(route);
        else remove(route);
      }
      syncInterests();
    },
    async publishPresence(status, signal) {
      if (
        (status !== "online" && status !== "away" && status !== "offline") ||
        signal.aborted ||
        closed ||
        !authenticated
      )
        return null;
      const release = admission.tryPresence();
      // Busy alone is not a retry deadline; only actual gates get boundary retries.
      if (!release)
        return admission.presenceReady()
          ? null
          : { retryAfterMs: admission.presenceDelay() };
      const current = generation;
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
      try {
        const event = eventDto(
          await sign({
            kind: 20001,
            content: status,
            tags: [],
            created_at: Math.floor(Date.now() / 1000),
          }),
        );
        if (
          bounded.aborted ||
          closed ||
          current !== generation ||
          !authenticated ||
          socket?.readyState !== 1
        )
          return null;
        if (!admission.presenceReady())
          return { retryAfterMs: admission.presenceDelay() };
        if (
          event.pubkey !== viewer ||
          event.kind !== 20001 ||
          event.content !== status ||
          event.tags.length
        )
          throw new Error("Presence signer changed intent");
        return await new Promise<boolean>((resolve, reject) => {
          const finish = (accepted: boolean) => {
            clearTimeout(receiptTimeout);
            presenceReceipt = undefined;
            resolve(accepted);
          };
          // Once sent, retain the correlated receipt even if the caller leaves:
          // a late quota refusal still belongs to the shared host cooldown.
          const receiptTimeout = setTimeout(() => finish(false), 10000);
          presenceReceipt = { id: event.id, finish };
          try {
            admission.presenceSent();
            send(["EVENT", event]);
          } catch (error) {
            finish(false);
            reject(error);
          }
        });
      } finally {
        release();
      }
    },
    publish(event, signal) {
      if (closed)
        return Promise.reject(
          new SocketRequestError("Relay session disposed", false),
        );
      if (event.pubkey !== viewer)
        return Promise.reject(
          new SocketRequestError(
            "Publication signer does not match viewer",
            false,
          ),
        );
      return requests.publish(event, signal);
    },
    observe(value) {
      const next = observerGeneration(value);
      if (closed || observer === next) return;
      observer = next;
      const route = routes.get("observer");
      if (route) remove(route); // Fence the old wire before enabling a new generation.
      syncInterests();
    },
    prioritize(input) {
      liveChannels(input); // Same bounded ID validation, but preserve demand order.
      priority = [...new Set(input)].slice(0, 64);
      priorityRanks = new WeakMap();
      if (!closed) syncInterests();
    },
    update(input, batchable = []) {
      const next = liveChannels(input);
      const nextJoined = liveJoined(next, batchable);
      if (
        closed ||
        (JSON.stringify(next) === JSON.stringify(interests) &&
          JSON.stringify(nextJoined) === JSON.stringify(joined))
      )
        return;
      if (denying) {
        const nextIds = new Set(next),
          oldMembers = new Set(joined),
          nextMembers = new Set(nextJoined);
        for (const id of denying)
          if (!nextIds.has(id) || oldMembers.has(id) !== nextMembers.has(id))
            denying.delete(id);
      }
      interests = next;
      joined = nextJoined;
      syncInterests();
    },
    retry() {
      if (closed) return;
      clearTimeout(retryTimer);
      reconnectDelay = BASE_RECONNECT_DELAY;
      if (authenticated) {
        replayStopped = false;
        for (const route of routes.values()) {
          if (route.status !== "error") continue;
          route.status = "pending";
          route.count = 0;
          route.quotaRetries = 0;
        }
        pump();
        notify();
      } else connect(false, "manual");
    },
    dispose() {
      if (closed) return;
      closed = true;
      clearTimeout(retryTimer);
      const ending = [...syncs];
      syncs.clear();
      profileSyncs.clear();
      clearSocket();
      routes.clear();
      routeSnapshots.clear();
      for (const sync of ending)
        sync.sink.closed("unsupported: relay session disposed");
    },
  };
}
