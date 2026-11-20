import type { WorkStep } from "./local-activity";
import type { LocalWorkState } from "./local-activity";
import type { RelaySession } from "../relay/session";
import { requestActivity, requestActivityState } from "./request-activity";

type Snapshot = ReturnType<RelaySession["agentActivity"]["snapshot"]>;
export type RequestWork = {
  agent: string;
  state: LocalWorkState | ReturnType<typeof requestActivityState>;
  reason: string | undefined;
  /** Latest live local step, such as a tool name. */
  step?: WorkStep;
  lifecycle: boolean;
  /** A settled error the owner dismissed on this device. */
  dismissed?: boolean;
  /** Its harness can stop the turn this local request is in. */
  stoppable?: boolean;
  /** This local request can be asked again once it fails. */
  retryable?: boolean;
  /** How this local request's turn ran, such as without its gateway. */
  notice?: string;
  selected: ReturnType<typeof requestActivity>;
  turns: Snapshot["turns"];
  working: boolean;
};
/** Work that no longer needs a pending activity presentation. Errors remain visible. */
export function isSettledWork(entry: Pick<RequestWork, "state">): boolean {
  return ["done", "ended", "superseded", "stopped"].includes(entry.state);
}

// Snapshot record arrays are frozen and replaced on change, and every mounted
// row asks about the same channels: index each array's agents once.
const recordAgents = new WeakMap<object, Map<string, string[]>>();
function channelAgents(records: Snapshot["records"], channelId: string) {
  if (!Object.isFrozen(records))
    return records
      .filter((record) => record.channelIds.includes(channelId))
      .map((record) => record.agent);
  let byChannel = recordAgents.get(records);
  if (!byChannel) {
    byChannel = new Map();
    for (const record of records)
      for (const id of record.channelIds) {
        const agents = byChannel.get(id);
        if (!agents) byChannel.set(id, [record.agent]);
        else if (!agents.includes(record.agent)) agents.push(record.agent);
      }
    recordAgents.set(records, byChannel);
  }
  return byChannel.get(channelId) ?? [];
}

/** Only explicit triggering IDs associate work with a message. Typing is not
 * message evidence, and a sibling request must never inherit the same bubble. */
export function requestWork(
  snapshot: Snapshot,
  channelId: string,
  messageId: string | readonly string[],
) {
  const { records } = snapshot;
  const ids = new Set(typeof messageId === "string" ? [messageId] : messageId);
  const requests = (snapshot.local ?? []).filter(
    (request) => request.channelId === channelId && ids.has(request.messageId),
  );
  const agents = new Set([
    ...channelAgents(records, channelId),
    ...requests.map((request) => request.agent),
    ...snapshot.turns
      .filter(
        (turn) =>
          turn.channelId === channelId &&
          turn.triggeringEventIds?.some((id) => ids.has(id)),
      )
      .map((turn) => turn.agent),
  ]);
  return [...agents].sort().flatMap<RequestWork>((agent) => {
    const local = requests.filter((entry) => entry.agent === agent);
    if (local.length) {
      const chosen =
        local.find((row) => row.state === "working") ??
        local.find((row) => row.state === "waiting") ??
        local.find((row) => row.state === "error") ??
        local[0];
      if (!chosen) return [];
      return [
        {
          agent,
          state: chosen.state,
          reason: chosen.error,
          ...(chosen.step ? { step: chosen.step } : {}),
          turns: [],
          selected: {
            records: [],
            turnIds: new Set<string>(),
            terminal: new Map<string, "ended" | "error">(),
            uncertain: false,
          },
          working: chosen.state === "working",
          lifecycle: true,
          ...(chosen.dismissed ? { dismissed: true } : {}),
          ...(chosen.stoppable ? { stoppable: true } : {}),
          ...(chosen.retryable ? { retryable: true } : {}),
          ...(chosen.notice ? { notice: chosen.notice } : {}),
        },
      ];
    }
    const selected = requestActivity(
      records,
      agent,
      channelId,
      messageId,
      snapshot.turns,
    );
    if (!selected.turnIds.size) return [];
    if (snapshot.turnsTrimmed) selected.uncertain = true;
    const turns = snapshot.turns.filter(
      (turn) =>
        turn.agent === agent &&
        turn.channelId === channelId &&
        selected.turnIds.has(turn.turnId),
    );
    const state = requestActivityState(selected, turns, snapshot.trimmed);
    return [
      {
        agent,
        state,
        reason: undefined,
        lifecycle: false,
        selected,
        turns,
        working: snapshot.status === "listening" && state === "working",
      },
    ];
  });
}
