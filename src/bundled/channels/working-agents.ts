import {
  localActivity,
  localWorkLabel,
  localWorkRoot,
} from "../../features/agents/local-activity";
import type { RelaySession } from "../../features/relay/session";
import { activityRecords } from "../../features/agents/activity-records";

type Snapshot = ReturnType<RelaySession["agentActivity"]["snapshot"]>;

/** Channel-wide evidence only. A thread typing signal stays in its thread. */
export function workingAgents(snapshot: Snapshot, channelId: string): string[] {
  const local = localActivity(snapshot, channelId);
  const localKeys = [...local.values()]
    .filter((row) => row.state === "waiting" || row.state === "working")
    .map((row) => row.agent);
  if (snapshot.status !== "listening") return localKeys.sort();
  return [
    ...new Set([
      ...localKeys,
      ...snapshot.turns
        .filter(
          (turn) =>
            turn.channelId === channelId &&
            turn.state === "working" &&
            !local.has(turn.agent),
        )
        .map((turn) => turn.agent),
      ...snapshot.typing
        .filter(
          (entry) =>
            entry.channelId === channelId &&
            !entry.threadRootId &&
            !local.has(entry.agent),
        )
        .map((entry) => entry.agent),
    ]),
  ].sort();
}

/** A current turn's start gives its age; only one captured trigger gives a destination. */
export function workingAgentDetails(
  snapshot: Snapshot,
  channelId: string,
  agent: string,
): { startedAt: number; messageId?: string; label?: string } | undefined {
  const work = localActivity(snapshot, channelId).get(agent);
  if (work) {
    if (work.state !== "waiting" && work.state !== "working") return;
    const active = (snapshot.local ?? []).filter(
      (row) =>
        row.channelId === channelId &&
        row.agent === agent &&
        (row.state === "waiting" || row.state === "working"),
    );
    const messageId = work.syntheticMessage
      ? localWorkRoot(work)
      : work.messageId;
    return {
      startedAt: Math.min(...active.map((row) => row.startedAt)),
      ...(active.length === 1 && messageId ? { messageId } : {}),
      label: localWorkLabel(work),
    };
  }
  if (snapshot.status !== "listening") return;
  const turns = snapshot.turns
    .filter(
      (turn) =>
        turn.agent === agent &&
        turn.channelId === channelId &&
        turn.state === "working",
    )
    .sort((a, b) => b.timestamp - a.timestamp);
  const latest = turns[0];
  if (!latest) {
    const typing = snapshot.typing.find(
      (entry) =>
        entry.agent === agent &&
        entry.channelId === channelId &&
        !entry.threadRootId,
    );
    return typing ? { startedAt: typing.startedAt } : undefined;
  }
  if (turns[1]?.timestamp === latest.timestamp) return;
  const starts = activityRecords(snapshot.records, agent, channelId).flatMap(
    (record) => {
      if (record.kind !== "turn_started") return [];
      try {
        const value = JSON.parse(record.plaintext);
        const ids = value?.payload?.triggeringEventIds;
        const timestamp = Date.parse(value?.timestamp);
        if (
          typeof value?.turnId !== "string" ||
          !Number.isFinite(timestamp) ||
          timestamp > record.receivedAt + 5000
        )
          return [];
        const messageId =
          Array.isArray(ids) &&
          ids.length === 1 &&
          typeof ids[0] === "string" &&
          /^[0-9a-f]{64}$/.test(ids[0])
            ? (ids[0] as string)
            : undefined;
        return [{ turnId: value.turnId, startedAt: timestamp, messageId }];
      } catch {
        return [];
      }
    },
  );
  const matches = starts.filter((start) => start.turnId === latest.turnId);
  const start = matches.length === 1 ? matches[0] : undefined;
  const typing = snapshot.typing.find(
    (entry) =>
      entry.agent === agent &&
      entry.channelId === channelId &&
      !entry.threadRootId,
  );
  return start
    ? {
        startedAt: start.startedAt,
        ...(start.messageId ? { messageId: start.messageId } : {}),
      }
    : typing
      ? { startedAt: typing.startedAt }
      : undefined;
}

export function workingAgentMessage(
  snapshot: Snapshot,
  channelId: string,
  agent: string,
): string | undefined {
  return workingAgentDetails(snapshot, channelId, agent)?.messageId;
}

/** The one conversation whose transcript the sidebar's View activity opens:
 * a Solo chat or DM is one conversation, as agent runtimes key them, and
 * elsewhere a loaded request message names its thread. Anything else opens the Activity overview. */
export function activityTranscript(
  channels: Pick<RelaySession["channels"], "list" | "window">,
  channelId: string,
  messageId: string | undefined,
): { rootId?: string } | undefined {
  const channel = channels
    .list()
    .channels.find((item) => item.id === channelId);
  if (channel?.channelType === "solo" || channel?.channelType === "dm")
    return {};
  const row =
    messageId &&
    channels.window(channelId).rows.find((item) => item.id === messageId);
  return row ? { rootId: row.threadRootId ?? row.id } : undefined;
}
