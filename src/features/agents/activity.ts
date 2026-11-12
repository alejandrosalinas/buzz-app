import type { LocalAgentSource, LocalWork } from "./local-activity";
import { activityPromptThread } from "./activity-transcript";
import type { EventData } from "../relay/events";
import { threadReference } from "../relay/thread-reference";
import type { LiveSnapshot } from "../relay/live";
import { freshTurnTriggers, turnTriggerIds } from "./turn-triggers";
import {
  ACTIVITY_HISTORY_AGE_MS,
  observerFrame,
  terminalOutcome,
  type ObserverFrame,
} from "./observer";

export const ACTIVITY_RECORD_LIMIT = 200;
export const ACTIVITY_BYTE_LIMIT = 2 * 1024 * 1024;
export const ACTIVITY_TURN_LIMIT = 512;
export const ACTIVITY_FRESH_MS = 30_000;
type RawRecord = ObserverFrame &
  Readonly<{
    receivedAt: number;
    kind: string;
    /** Recognized envelope/child channel metadata; plaintext stays unmodified. */
    channelIds: readonly string[];
  }>;
export type ActivityTurn = Readonly<{
  agent: string;
  turnId: string;
  sessionId?: string;
  threadRootId?: string;
  channelId: string | null;
  timestamp: number;
  state: "working" | "unknown" | "ended";
  /** Retained independently of the bounded raw activity buffer. */
  outcome?: ReturnType<typeof terminalOutcome>;
  triggeringEventIds?: readonly string[];
  /** Multiple distinct starts reused this turn ID; request identity is ambiguous. */
  ambiguous?: boolean;
  /** Roots established from retained signed triggering messages, not typing. */
  requests?: readonly Readonly<{ messageId: string; threadRootId: string }>[];
}>;
type Typing = Readonly<{
  agent: string;
  channelId: string;
  threadRootId: string | undefined;
  timestamp: number;
  /** First observed working signal in this uninterrupted typing run. */
  startedAt: number;
  working: boolean;
  expiresAt: number;
}>;
/** Published typing: a pulse that only refreshes its clock changes nothing. */
type TypingEntry = Omit<Typing, "timestamp" | "expiresAt">;
const TYPING_FRESH_MS = 8000;
type Snapshot = Readonly<{
  status:
    | "unavailable"
    | "disabled"
    | "connecting"
    | "listening"
    | "interrupted";
  records: readonly RawRecord[];
  turns: readonly ActivityTurn[];
  local?: readonly LocalWork[];
  typing: readonly TypingEntry[];
  trimmed: number;
  /** Unlike raw-record trimming, losing a turn can lose request completeness. */
  turnsTrimmed?: boolean;
}>;
type Turn = Omit<ActivityTurn, "state" | "requests"> & {
  requests?: ActivityTurn["requests"];
  triggeringEventIds?: readonly string[];
  ended: boolean;
  epoch: number;
  unresolvedTriggers?: readonly string[];
  /** A turn_started frame set triggers; a second one makes the turn ambiguous. */
  started?: boolean;
};
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
const starts = new Set([
  "turn_started",
  // A message the agent's harness added to this running turn (remote steering).
  "turn_steered",
  "turn_liveness",
  "acp_read",
  "acp_write",
  "session_resolved",
]);
const ends = new Set(["turn_completed", "turn_error", "agent_panic"]);
/** A start's or steer's messages join the turn's triggers; nothing removes one. */
function triggerFields(
  previous: Turn | undefined,
  added: readonly string[] | undefined,
): Required<
  Pick<Turn, "triggeringEventIds" | "requests" | "unresolvedTriggers">
> {
  const known = previous?.triggeringEventIds ?? [];
  const fresh = freshTurnTriggers(known, added);
  return {
    triggeringEventIds: fresh.length ? [...known, ...fresh] : known,
    requests: previous?.requests ?? [],
    unresolvedTriggers: [...(previous?.unresolvedTriggers ?? []), ...fresh],
  };
}
function withTriggers(previous: Turn, added: readonly string[]): Turn {
  const fields = triggerFields(previous, added);
  return fields.triggeringEventIds.length ===
    (previous.triggeringEventIds?.length ?? 0)
    ? previous
    : { ...previous, ...fields };
}

/** Session-owned live evidence. Plugin activation owns demand, not sockets or keys. */
export function createAgentActivity(
  available: boolean,
  observe: (generation: number | null) => void,
  canAccess: (channel: string) => boolean,
  notify = (listener: () => void) => listener(),
  findMessage?: (id: string) => EventData | undefined,
  local?: { source: LocalAgentSource; scope: string },
) {
  let closed = false,
    leases = 0,
    generation = 0,
    epoch = 0;
  const liveAgents = new Set<string>();
  let status: Snapshot["status"] = available ? "disabled" : "unavailable";
  let records: RawRecord[] = [],
    bytes = 0,
    trimmed = 0,
    evidenceFloor = 0;
  let turnsTrimmed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const turns = new Map<string, Turn>();
  const typing = new Map<string, Typing>();
  const listeners = new Set<() => void>();
  const workingListeners = new Set<() => void>();
  let workingChannels = "[]";
  let snapshot: Snapshot = Object.freeze({
    status,
    records: [],
    turns: [],
    typing: [],
    trimmed,
  });
  function associate(turn: Turn) {
    const unresolved: string[] = [];
    const requests = [...(turn.requests ?? [])];
    for (const id of turn.unresolvedTriggers ?? []) {
      const event = findMessage?.(id);
      if (!event) {
        unresolved.push(id);
        continue;
      }
      if (![9, 40002, 40008].includes(event.kind)) continue;
      const channels = event.tags.filter(([key]) => key === "h");
      if (channels.length !== 1 || channels[0]?.[1] !== turn.channelId)
        continue;
      const reference = threadReference(event);
      if (event.tags.some(([key]) => key === "e") && !reference) continue;
      requests.push(
        Object.freeze({
          messageId: id,
          threadRootId: reference?.rootId ?? event.id,
        }),
      );
    }
    turn.unresolvedTriggers = unresolved;
    turn.requests = Object.freeze(requests);
  }
  function typingKey(entries: readonly TypingEntry[]) {
    return JSON.stringify(entries.map((entry) => JSON.stringify(entry)).sort());
  }
  function publish() {
    const localWork =
      local && !closed
        ? local.source
            .work()
            .filter(
              (row) => row.scope === local.scope && canAccess(row.channelId),
            )
        : [];
    const now = Date.now();
    const fresh = records.filter(
      (record) => now - record.receivedAt < ACTIVITY_HISTORY_AGE_MS,
    );
    if (fresh.length !== records.length) {
      trimmed += records.length - fresh.length;
      records = fresh;
      bytes = records.reduce(
        (total, record) =>
          total + new TextEncoder().encode(record.plaintext).length,
        0,
      );
    }
    const retained = new Set(records.map((record) => record.agent));
    for (const agent of liveAgents)
      if (!retained.has(agent)) liveAgents.delete(agent);
    const known = liveAgents;
    for (const [key, entry] of typing)
      if (now >= entry.expiresAt || !known.has(entry.agent)) typing.delete(key);
    const typers = [...typing.values()]
      .filter((entry) => entry.working)
      .map(
        ({ agent, channelId, threadRootId, startedAt, working }): TypingEntry =>
          Object.freeze({ agent, channelId, threadRootId, startedAt, working }),
      );
    const visible = [...turns.values()].map(
      (turn): ActivityTurn =>
        Object.freeze({
          agent: turn.agent,
          turnId: turn.turnId,
          ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
          ...(turn.threadRootId ? { threadRootId: turn.threadRootId } : {}),
          ...(turn.ambiguous ? { ambiguous: true } : {}),
          channelId: turn.channelId,
          timestamp: turn.timestamp,
          ...(turn.outcome ? { outcome: turn.outcome } : {}),
          ...(turn.triggeringEventIds
            ? { triggeringEventIds: turn.triggeringEventIds }
            : {}),
          ...(turn.triggeringEventIds ? { requests: turn.requests ?? [] } : {}),
          state: turn.ended
            ? "ended"
            : status === "listening" &&
                turn.epoch === epoch &&
                now - turn.timestamp <= ACTIVITY_FRESH_MS &&
                turn.timestamp <= now + 5000
              ? "working"
              : "unknown",
        }),
    );
    // A primitive snapshot lets workspace subscribers ignore observer records and
    // refreshed typing timestamps. The existing publish timer also drives expiry.
    const nextWorking = JSON.stringify(
      [
        ...new Set([
          ...localWork
            .filter((row) => row.state === "waiting" || row.state === "working")
            .map((row) => row.channelId),
          ...visible
            .filter((turn) => turn.state === "working")
            .map((turn) => turn.channelId)
            .filter((id): id is string => !!id),
          ...typers
            .filter((entry) => !entry.threadRootId)
            .map((entry) => entry.channelId),
        ]),
      ].sort(),
    );
    const workingChanged = nextWorking !== workingChannels;
    if (workingChanged) workingChannels = nextWorking;
    if (
      !workingChanged &&
      snapshot.status === status &&
      (snapshot.local ?? []).length === localWork.length &&
      (snapshot.local ?? []).every((row, index) => row === localWork[index]) &&
      snapshot.records === records &&
      snapshot.trimmed === trimmed &&
      JSON.stringify(snapshot.turns) === JSON.stringify(visible) &&
      // Each pulse re-inserts its key for eviction recency: compare as a set.
      typingKey(snapshot.typing) === typingKey(typers)
    )
      return;
    snapshot = Object.freeze({
      status,
      records: Object.freeze(records),
      turns: Object.freeze(visible),
      local: Object.freeze(localWork),
      typing: Object.freeze(typers),
      trimmed,
      turnsTrimmed,
    });
    for (const listener of listeners) notify(listener);
    if (workingChanged)
      for (const listener of workingListeners) notify(listener);
  }
  function reset() {
    records = [];
    bytes = 0;
    trimmed = 0;
    evidenceFloor = 0;
    turnsTrimmed = false;
    turns.clear();
    typing.clear();
    liveAgents.clear();
    epoch++;
  }
  function restart() {
    generation++;
    reset();
    if (available && !closed && leases > 0) {
      status = "connecting";
      observe(generation);
    } else status = closed || !available ? "unavailable" : "disabled";
    publish();
  }
  function fold(agent: string, value: unknown) {
    const item = object(value);
    if (
      !item ||
      !text(item.kind) ||
      !text(item.turnId) ||
      !(item.channelId === null || text(item.channelId)) ||
      typeof item.timestamp !== "string"
    )
      return;
    if (item.channelId && !canAccess(item.channelId)) return;
    if (!starts.has(item.kind) && !ends.has(item.kind)) return;
    const timestamp = Date.parse(item.timestamp);
    if (!Number.isFinite(timestamp) || timestamp > Date.now() + 5000) return;
    const key = `${agent}:${item.turnId}`;
    const previous = turns.get(key);
    const payload = object(item.payload);
    const added =
      item.kind === "turn_started" || item.kind === "turn_steered"
        ? turnTriggerIds(payload?.triggeringEventIds)
        : undefined;
    // Terminal evidence wins even when a delayed earlier heartbeat arrives later.
    if (
      previous?.ended ||
      (previous && previous.timestamp > timestamp && !ends.has(item.kind))
    ) {
      // Membership is not progress: a late start or steer still names the
      // messages its turn ran for, without reviving or refreshing it. A late
      // second start makes the turn ambiguous, as one in order would.
      if (!added || !previous) return;
      let merged: Turn;
      if (item.kind === "turn_steered") merged = withTriggers(previous, added);
      else if (item.kind !== "turn_started") return;
      else if (previous.started)
        merged = previous.ambiguous
          ? previous
          : { ...previous, ambiguous: true };
      else merged = { ...withTriggers(previous, added), started: true };
      if (merged === previous) return;
      associate(merged);
      turns.set(key, merged);
      return;
    }
    if (!previous && timestamp <= evidenceFloor) return;
    const root = payload?.threadRootEventId;
    const legacyRoot =
      item.kind === "acp_write" && !previous?.threadRootId
        ? activityPromptThread(payload)
        : undefined;
    const sessionId =
      item.kind === "session_resolved" && text(payload?.sessionId)
        ? payload.sessionId
        : item.sessionId;
    const turn: Turn = {
      ...(previous?.triggeringEventIds || added
        ? triggerFields(previous, added)
        : {}),
      ...(previous?.started || (item.kind === "turn_started" && added)
        ? { started: true }
        : {}),
      agent,
      turnId: item.turnId,
      ...(previous?.ambiguous ||
      (item.kind === "turn_started" && previous?.started)
        ? { ambiguous: true }
        : {}),
      ...(typeof root === "string" && /^[0-9a-f]{64}$/.test(root)
        ? { threadRootId: root }
        : previous?.threadRootId
          ? { threadRootId: previous.threadRootId }
          : typeof legacyRoot === "string"
            ? { threadRootId: legacyRoot }
            : {}),
      ...(text(sessionId)
        ? { sessionId }
        : previous?.sessionId
          ? { sessionId: previous.sessionId }
          : {}),
      channelId: item.channelId,
      // Completion may precede liveness on a rolled-back producer clock. Keep
      // the highest observed time so eventual eviction cannot weaken the fence.
      timestamp: Math.max(timestamp, previous?.timestamp ?? timestamp),
      ended: ends.has(item.kind),
      outcome: terminalOutcome(item.kind, payload?.outcome),
      epoch,
    };
    associate(turn);
    turns.set(key, turn);
    if (turns.size > ACTIVITY_TURN_LIMIT) {
      const oldest = [...turns].sort(
        (a, b) => a[1].timestamp - b[1].timestamp,
      )[0];
      if (oldest) {
        turns.delete(oldest[0]);
        // Forgetting a tombstone must not let older evidence resurrect that turn.
        evidenceFloor = Math.max(evidenceFloor, oldest[1].timestamp);
        turnsTrimmed = true;
        trimmed++;
      }
    }
  }
  function channelsAllowed(
    raw: unknown,
    allowed: (channel: string) => boolean,
  ) {
    const envelope = object(raw);
    const children =
      envelope?.kind === "batch" ? object(envelope.payload)?.events : undefined;
    return ![raw, ...(Array.isArray(children) ? children : [])].some(
      (value) => {
        const channel = object(value)?.channelId;
        return text(channel) && !allowed(channel);
      },
    );
  }
  function admit(input: ObserverFrame, receivedAt: number) {
    let frame: ObserverFrame, raw: unknown;
    try {
      frame = observerFrame(input);
      raw = JSON.parse(frame.plaintext);
    } catch {
      return;
    }

    const envelope = object(raw);
    // Management requests belong only to live owner review, never the activity
    // display.
    if (envelope?.kind === "agent_management_request") return;
    const children =
      envelope?.kind === "batch" ? object(envelope.payload)?.events : undefined;
    const items = Array.isArray(children) ? children : [raw];
    // A denied child cannot leak through an otherwise visible raw batch.
    if (!channelsAllowed(raw, canAccess)) return;
    if (records.some((record) => record.id === frame.id)) {
      publish();
      return;
    }
    liveAgents.add(frame.agent);
    for (const item of items) fold(frame.agent, item);
    const record = Object.freeze({
      id: frame.id,
      agent: frame.agent,
      createdAt: frame.createdAt,
      plaintext: frame.plaintext,
      receivedAt,
      kind: text(envelope?.kind) ? envelope.kind : "unknown",
      channelIds: Object.freeze([
        ...new Set(
          [raw, ...items].flatMap((value) => {
            const channelId = object(value)?.channelId;
            return text(channelId) ? [channelId] : [];
          }),
        ),
      ]),
    });
    records = [...records, record].sort((a, b) => a.receivedAt - b.receivedAt);
    bytes += new TextEncoder().encode(frame.plaintext).length;
    while (
      records.length > ACTIVITY_RECORD_LIMIT ||
      bytes > ACTIVITY_BYTE_LIMIT
    ) {
      const first = records.shift();
      if (first) bytes -= new TextEncoder().encode(first.plaintext).length;
      trimmed++;
    }
    publish();
  }

  const stopLocal = local?.source.subscribeWork(publish);
  return {
    queries: Object.freeze({
      snapshot: () => snapshot,
      /** Owner-authorized status readback for an exact retained remote task.
       * Never invent raw telemetry or replace an already received terminal. */
      reconcile(turn: ActivityTurn, outcome: "ended" | "error" | "stopped") {
        if (closed || !leases || !turn.channelId || !canAccess(turn.channelId))
          return;
        const current = turns.get(`${turn.agent}:${turn.turnId}`);
        if (
          !current ||
          current.ended ||
          !turn.sessionId ||
          current.sessionId !== turn.sessionId ||
          current.channelId !== turn.channelId
        )
          return;
        turns.set(`${turn.agent}:${turn.turnId}`, {
          ...current,
          ended: true,
          outcome,
        });
        publish();
      },
      /** Display-only local acknowledgement, scoped to this session and access. */
      dismissError(agent: string, channelId: string, messageId: string) {
        if (!local || closed || !canAccess(channelId)) return false;
        local.source.dismissError?.({ scope: local.scope, agent, messageId });
        return true;
      },
      /** Stops the turn a local request is in, scoped to this session and access. */
      interrupt(agent: string, channelId: string, messageId: string) {
        if (!local?.source.interrupt || closed || !canAccess(channelId))
          return Promise.reject(new Error("This work can't be stopped here"));
        return local.source.interrupt({
          scope: local.scope,
          agent,
          messageId,
        });
      },
      /** Asks again for a failed local request, scoped to this session and access. */
      retry(agent: string, channelId: string, messageId: string) {
        if (!local?.source.retry || closed || !canAccess(channelId))
          throw new Error("This request can't be retried here");
        local.source.retry({ scope: local.scope, agent, messageId });
      },
      workingSnapshot: () => workingChannels,
      subscribeWorking(listener: () => void) {
        if (closed) return () => {};
        workingListeners.add(listener);
        return () => workingListeners.delete(listener);
      },
      subscribe(listener: () => void) {
        if (closed) return () => {};
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      activate() {
        if (closed || !available) return () => {};
        if (++leases === 1) {
          restart();
          timer = setInterval(publish, 1000);
        }
        let released = false;
        return () => {
          if (released || closed) return;
          released = true;
          if (--leases === 0) {
            observe(null);
            clearInterval(timer);
            restart();
          }
        };
      },
    }),
    receive(input: ObserverFrame, current: number) {
      if (closed || !available || leases === 0 || current !== generation)
        return;
      let frame: ObserverFrame, raw: unknown;
      try {
        frame = observerFrame(input);
        raw = JSON.parse(frame.plaintext);
      } catch {
        return;
      }
      const envelope = object(raw);
      const children =
        envelope?.kind === "batch"
          ? object(envelope.payload)?.events
          : undefined;
      const items = Array.isArray(children) ? children : [raw];
      // A denied child cannot leak through an otherwise visible raw batch.
      if (
        [raw, ...items].some((value) => {
          const item = object(value);
          return text(item?.channelId) && !canAccess(item.channelId);
        })
      )
        return;
      if (leases > 0) admit(frame, Date.now());
    },
    /** Trigger messages may arrive after telemetry. Resolve at content admission,
     * not on the freshness timer, without retaining or fetching more messages. */
    messagesChanged(events: readonly EventData[]) {
      if (closed || !leases) return;
      const ids = new Set(events.map((event) => event.id));
      let changed = false;
      for (const turn of turns.values()) {
        if (!turn.unresolvedTriggers?.some((id) => ids.has(id))) continue;
        associate(turn);
        changed = true;
      }
      if (changed) publish();
    },
    /** Public typing is scope/freshness evidence only, never ownership evidence. */
    channelEvents(events: readonly EventData[]) {
      if (closed || !leases || status !== "listening") return;
      const known = liveAgents;
      const now = Date.now();
      let changed = false;
      for (const event of events) {
        if (![9, 20002].includes(event.kind) || !known.has(event.pubkey))
          continue;
        const channels = event.tags.filter(([name]) => name === "h");
        const channelId = channels[0]?.[1];
        const timestamp = event.created_at * 1000;
        if (
          channels.length !== 1 ||
          !text(channelId) ||
          !canAccess(channelId) ||
          !Number.isSafeInteger(event.created_at) ||
          event.created_at * 1000 > now + 5000 ||
          now - timestamp >= TYPING_FRESH_MS
        )
          continue;
        const reference = threadReference(event);
        // Malformed thread tags must not become channel-wide working evidence.
        if (event.tags.some(([name]) => name === "e") && !reference) continue;
        const threadRootId = reference?.rootId;
        // A reply in a thread also ends the agent's channel-level typing: its
        // pulses and replies can be filed apart for the same turn. Other
        // threads keep theirs.
        const scopes =
          event.kind === 9 && threadRootId
            ? [threadRootId, undefined]
            : [threadRootId];
        for (const threadRootId of scopes) {
          const key = JSON.stringify([event.pubkey, channelId, threadRootId]);
          const previous = typing.get(key);
          if (
            previous &&
            (timestamp < previous.timestamp ||
              (event.kind === 20002 &&
                !previous.working &&
                timestamp <= previous.timestamp + 2000))
          )
            continue;
          changed = true;
          typing.delete(key);
          typing.set(
            key,
            Object.freeze({
              agent: event.pubkey,
              channelId,
              threadRootId,
              timestamp,
              startedAt:
                previous?.working && now < previous.expiresAt
                  ? previous.startedAt
                  : timestamp,
              working: event.kind === 20002,
              expiresAt: Math.min(timestamp, now) + TYPING_FRESH_MS,
            }),
          );
        }
        while (typing.size > ACTIVITY_TURN_LIMIT) {
          const oldest = typing.keys().next().value;
          if (oldest) typing.delete(oldest);
        }
      }
      // Expiry and freshness ride the publish timer; other traffic changes nothing.
      if (changed) publish();
    },
    state(live: LiveSnapshot) {
      if (closed || !available || !leases) return;
      const route = live.routes.find((route) => route.id === "observer");
      const next =
        live.status === "connected" && route?.status === "live"
          ? "listening"
          : live.status === "error" ||
              live.status === "retrying" ||
              route?.status === "error"
            ? "interrupted"
            : "connecting";
      if (status === "listening" && next !== status) epoch++;
      if (next !== "listening") typing.clear();
      else
        for (const [key, entry] of typing) {
          const route = live.routes.find(
            (route) => route.channelId === entry.channelId,
          );
          if (route && route.status !== "live") typing.delete(key);
        }
      status = next;
      publish();
    },
    accessChanged() {
      restart();
    },
    clear: restart,
    dispose() {
      if (closed) return;
      closed = true;
      stopLocal?.();
      leases = 0;
      observe(null);
      clearInterval(timer);
      restart();
      listeners.clear();
      workingListeners.clear();
    },
  };
}
