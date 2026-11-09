import { useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import type { ChannelMessage } from "../relay/contracts";
import { currentActivity } from "../agents/current-activity";
import { useActivityTypingReplacement } from "../conversation/typing-presentation";
const noSubscribe = () => () => {};
const noActivity = () => undefined;
const empty: ReturnType<RelaySession["typing"]["snapshot"]> = [];
const noTyping = () => empty;

/** A current, rendered activity row owns the live signal for its exact scope. */
export function useActivityIndicator(
  session: RelaySession | undefined,
  row: ChannelMessage,
  eligible: boolean,
  participants?: readonly string[],
  requestId?: string,
) {
  // Only the row that owns the live signal reads it; other rows must not
  // re-render on every typing pulse or activity step.
  const typing = useSyncExternalStore(
    (eligible && session?.typing?.subscribe) || noSubscribe,
    (eligible && session?.typing?.snapshot) || noTyping,
  );
  const activity = useSyncExternalStore(
    (eligible && session?.agentActivity?.subscribe) || noSubscribe,
    (eligible && session?.agentActivity?.snapshot) || noActivity,
  );
  const represented = new Set(participants ?? [row.authorId]);
  const detail = eligible
    ? currentActivity(
        activity,
        typing,
        represented,
        row.channelId,
        row.threadRootId,
      )
    : undefined;
  // Top-level harness work uses its triggering request as the root, while its
  // published channel activity has no thread root. Match that known request,
  // never an arbitrary working thread in the same channel.
  const matches = (root: string | null | undefined) =>
    root === (row.threadRootId ?? null) ||
    (!row.threadRootId && !!requestId && root === requestId);
  const requestIds = new Set([row.id, row.replyParentId, requestId]);
  const liveDetails = [...(detail ?? [])].filter(([agent, value]) => {
    if (!represented.has(agent) || !value.roots.some(matches)) return false;
    // Known local requests take precedence over conversation-only typing.
    // Yesterday's last activity row must not represent today's different turn.
    const local = (activity?.local ?? []).filter(
      (work) =>
        work.agent === agent &&
        work.channelId === row.channelId &&
        (!row.threadRootId || work.threadRootId === row.threadRootId),
    );
    return (
      !requestId ||
      !local.length ||
      local.some(
        (work) =>
          requestIds.has(work.messageId) &&
          (work.state === "waiting" || work.state === "working"),
      )
    );
  });
  const liveAgents = liveDetails
    .filter(([, value]) => value.roots.every(matches))
    .map(([agent]) => agent);
  const live = liveDetails.length > 0;
  useActivityTypingReplacement(
    session
      ? {
          session,
          channelId: row.channelId,
          threadRootId: row.threadRootId,
          pubkey: row.authorId,
        }
      : undefined,
    live,
    liveAgents,
  );
  return live;
}
