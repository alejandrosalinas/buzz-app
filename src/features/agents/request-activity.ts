import type { ActivityTurn } from "./activity";
import { activityRecords, type ActivityRecord } from "./activity-records";
import { terminalOutcome } from "./observer";
import { freshTurnTriggers, turnTriggerIds } from "./turn-triggers";

type Parsed = Readonly<{
  record: ActivityRecord;
  value: {
    kind: string;
    turnId: string;
    seq: number;
    timestamp?: unknown;
    payload?: { triggeringEventIds?: unknown; outcome?: unknown };
  };
}>;
// Snapshot record arrays are immutable and every mounted message row asks about
// the same agent/channel. Admitted record objects are frozen and reused across
// snapshots, and a record's projection depends on no other record, so parse each
// record once per scope and assemble each array from those results.
const parsedRecords = new WeakMap<object, Map<string, readonly Parsed[]>>();
const parsedArrays = new WeakMap<object, Map<string, readonly Parsed[]>>();

function parseRecord(
  record: Omit<ActivityRecord, "envelopeId">,
  agent: string,
  channelId: string,
  scope: string,
): readonly Parsed[] {
  // Only a frozen record can be cached by identity.
  let byScope = parsedRecords.get(record);
  if (!byScope && Object.isFrozen(record)) {
    byScope = new Map();
    parsedRecords.set(record, byScope);
  }
  const cached = byScope?.get(scope);
  if (cached) return cached;
  const parsed = activityRecords([record], agent, channelId).flatMap(
    (projected): Parsed[] => {
      try {
        const value = JSON.parse(projected.plaintext);
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          typeof value.turnId !== "string" ||
          !value.turnId ||
          value.turnId.length > 256
        )
          return [];
        return [{ record: projected, value }];
      } catch {
        return [];
      }
    },
  );
  byScope?.set(scope, parsed);
  return parsed;
}

function parseRecords(
  records: readonly Omit<ActivityRecord, "envelopeId">[],
  agent: string,
  channelId: string,
): readonly Parsed[] {
  let byScope = parsedArrays.get(records);
  if (!byScope) {
    byScope = new Map();
    parsedArrays.set(records, byScope);
  }
  const scope = `${agent}\n${channelId}`;
  const cached = byScope.get(scope);
  if (cached) return cached;
  const parsed = records.flatMap((record) =>
    parseRecord(record, agent, channelId, scope),
  );
  byScope.set(scope, parsed);
  return parsed;
}

/** Live request association from explicit captured trigger IDs only. No time/name
 * inference, backfill, or broader channel fallback when the start is missing. */
export function requestActivity(
  records: readonly Omit<ActivityRecord, "envelopeId">[],
  agent: string,
  channelId: string,
  requestId: string | readonly string[],
  turns: readonly ActivityTurn[] = [],
) {
  const parsed = parseRecords(records, agent, channelId);
  const turnIds = new Set<string>();
  const selected: ActivityRecord[] = [];
  const terminal = new Map<
    string,
    NonNullable<ReturnType<typeof terminalOutcome>>
  >();
  let uncertain = false;
  const result = () => ({ records: selected, turnIds, terminal, uncertain });
  const triggersWanted = new Set(
    (typeof requestId === "string" ? [requestId] : requestId).filter((id) =>
      /^[0-9a-f]{64}$/.test(id),
    ),
  );
  if (!triggersWanted.size) return result();
  const ambiguous = new Set(
    turns
      .filter(
        (turn) =>
          turn.agent === agent &&
          turn.channelId === channelId &&
          turn.ambiguous,
      )
      .map((turn) => turn.turnId),
  );
  // The lifecycle's membership of a turn it still holds is authoritative: a
  // start or steer anchors the turn only for messages the lifecycle admitted.
  // A turn it no longer holds, or holds without membership, is replayed from
  // the raw records, admitting each start's and steer's messages in arrival
  // order by the lifecycle's rules, so a list it rejected cannot associate a
  // message here.
  const retained = new Map<string, readonly string[]>();
  for (const turn of turns)
    if (
      turn.agent === agent &&
      turn.channelId === channelId &&
      turn.triggeringEventIds
    )
      retained.set(turn.turnId, turn.triggeringEventIds);
  const replayed = new Map<string, string[]>();
  const anchors: Parsed[] = [];
  for (const anchor of parsed) {
    const { kind, turnId, payload } = anchor.value;
    if (kind !== "turn_started" && kind !== "turn_steered") continue;
    const listed = turnTriggerIds(payload?.triggeringEventIds);
    const members = retained.get(turnId);
    let joined: readonly string[];
    if (members) joined = (listed ?? []).filter((id) => members.includes(id));
    else {
      const known = replayed.get(turnId) ?? [];
      replayed.set(turnId, known);
      joined = freshTurnTriggers(known, listed);
      known.push(...joined);
    }
    if (joined.some((id) => triggersWanted.has(id))) anchors.push(anchor);
  }
  // A steered message joined a turn that started for another message, so it
  // shares that turn's records from its start, or from the steer when the start
  // is not loaded.
  for (const anchor of anchors) {
    if (turnIds.has(anchor.value.turnId)) continue;
    if (ambiguous.has(anchor.value.turnId)) {
      uncertain = true;
      continue;
    }
    const turn = parsed.filter(
      ({ value }) => value.turnId === anchor.value.turnId,
    );
    const starts = turn.filter(({ value }) => value.kind === "turn_started");
    const start =
      anchor.value.kind === "turn_started" ? anchor : (starts[0] ?? anchor);
    // Duplicate starts/sequence resets leave identity ambiguous. Do not mix runs.
    if (
      starts.length > 1 ||
      turn.some(
        ({ value }) => !Number.isSafeInteger(value.seq) || value.seq < 0,
      )
    ) {
      uncertain = true;
      continue;
    }
    const after = turn
      .filter(({ value }) => value.seq >= start.value.seq)
      .sort((a, b) => a.value.seq - b.value.seq);
    if (new Set(after.map(({ value }) => value.seq)).size !== after.length) {
      uncertain = true;
      continue;
    }
    turnIds.add(start.value.turnId);
    selected.push(...after.map(({ record }) => record));
    // Match the lifecycle owner's timestamp admission. Raw future/malformed
    // terminal-looking records remain inspectable but cannot classify outcome.
    const admitted = ({ value, record }: Parsed) =>
      typeof value.timestamp === "string" &&
      Number.isFinite(Date.parse(value.timestamp)) &&
      Date.parse(value.timestamp) <= record.receivedAt + 5000;
    if (!admitted(start)) {
      uncertain = true;
      continue;
    }
    // The lifecycle owner latches the first admitted terminal frame in receipt
    // order, not the largest seq. A later error must not rewrite an earlier end.
    const end = turn.find(
      (item) =>
        ["turn_completed", "turn_error", "agent_panic"].includes(
          item.value.kind,
        ) && admitted(item),
    );
    if (end && end.value.seq >= start.value.seq)
      terminal.set(
        start.value.turnId,
        terminalOutcome(end.value.kind, end.value.payload?.outcome) ??
          "unknown",
      );
  }
  // The lifecycle owns bounded request associations and the first terminal
  // receipt. Raw-buffer eviction must not erase either fact.
  for (const turn of turns) {
    if (
      turn.agent !== agent ||
      turn.ambiguous ||
      turn.channelId !== channelId ||
      !turn.triggeringEventIds?.some((id) => triggersWanted.has(id))
    )
      continue;
    turnIds.add(turn.turnId);
    if (turn.outcome) terminal.set(turn.turnId, turn.outcome);
  }
  return result();
}

/** Already scoped lifecycle evidence, never a claim that a reply was delivered.
 * Working dominates; all linked turns must agree before an aggregate end label.
 * Retained request associations survive raw feed trimming. */
export function requestActivityState(
  selected: ReturnType<typeof requestActivity>,
  turns: readonly ActivityTurn[],
  trimmed = 0,
): "waiting" | "working" | "unknown" | "ended" | "error" | "stopped" {
  const linked = [...selected.turnIds].map((id) =>
    turns.find((turn) => turn.turnId === id),
  );
  if (linked.some((turn) => turn?.state === "working")) return "working";
  if (
    (trimmed > 0 &&
      (!linked.length || !linked.every((turn) => turn?.triggeringEventIds))) ||
    selected.uncertain ||
    linked.some((turn) => !turn || turn.state === "unknown")
  )
    return "unknown";
  if (!linked.length) return "waiting";
  if (
    linked.some(
      (turn) => turn?.state !== "ended" || !selected.terminal.has(turn.turnId),
    )
  )
    return "unknown";
  const outcomes = [...selected.terminal.values()];
  if (outcomes.includes("unknown")) return "unknown";
  if (outcomes.includes("error")) return "error";
  return outcomes.includes("stopped") ? "stopped" : "ended";
}
