import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { requestWork, isSettledWork } from "../agents/request-work";
import { continuesMessageGroup } from "./message-grouping";
import { activityRuns } from "./activity-groups";

type Activity = RelaySession["agentActivity"];
type Snapshot = ReturnType<Activity["snapshot"]>;
type ActivityRun = {
  ids: string[];
  history: ChannelMessage[];
  latest: ChannelMessage;
  participants: string[];
  requestId: string | undefined;
  followingMessage: ChannelMessage | undefined;
};
export type ActivityPresentation = ActivityRun & {
  /** Retires the live treatment only; coordination history remains readable. */
  retired: boolean;
  outcomes: Pick<
    ReturnType<typeof requestWork>[number],
    "agent" | "state" | "reason"
  >[];
  /** Only the latest update run for an agent/request owns live work and Stop. */
  liveParticipants: string[];
  /** Agents whose current work or outcome this group can actually present. */
  presentedParticipants: string[];
  working: boolean;
  /** Latest recorded update belonging to a participant still working here. */
  workingUpdate: ChannelMessage | undefined;
  standalone: boolean;
};
export type ActivityRowPresentation = {
  requestId: string | undefined;
  active: boolean;
  ownsLive: boolean;
  /** Keep a failure's author visible in history shared with other agents. */
  showAuthor?: boolean;
  container: "history" | "bubble" | "standalone";
};
const noSubscribe = () => () => {};

const sameItems = <T>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((item, index) => item === b[index]);
/** Whether two snapshots agree on everything a request projection in these
 * channels reads: their records, turns and local work, status and trimming. */
function sameChannelActivity(
  a: Snapshot | undefined,
  b: Snapshot | undefined,
  channels: ReadonlySet<string>,
) {
  if (a === b) return true;
  if (!a || !b || a.status !== b.status || a.trimmed !== b.trimmed)
    return false;
  const records = (snapshot: Snapshot) =>
    snapshot.records.filter((record) =>
      record.channelIds.some((id) => channels.has(id)),
    );
  const local = (snapshot: Snapshot) =>
    (snapshot.local ?? []).filter((work) => channels.has(work.channelId));
  const turns = (snapshot: Snapshot) =>
    JSON.stringify(
      snapshot.turns.filter(
        (turn) => !!turn.channelId && channels.has(turn.channelId),
      ),
    );
  return (
    sameItems(records(a), records(b)) &&
    sameItems(local(a), local(b)) &&
    turns(a) === turns(b)
  );
}
/** The activity snapshot, changing only when these channels' evidence does:
 * work elsewhere in the session does not re-render this conversation. */
export function useChannelActivitySnapshot(
  activity: Activity | undefined,
  channels: ReadonlySet<string>,
) {
  const held = useRef<Snapshot | undefined>(undefined);
  const read = () => {
    const live = activity?.snapshot();
    if (!sameChannelActivity(held.current, live, channels)) held.current = live;
    return held.current;
  };
  return useSyncExternalStore(activity?.subscribe ?? noSubscribe, read, read);
}

/** Status belongs to the triggering request, never to all work in its thread. */
function activityStatus(
  group: ActivityRun,
  snapshot: Snapshot | undefined,
  agents: ReadonlySet<string> | undefined,
  requests: ReadonlyMap<string, string>,
) {
  const { latest, participants, followingMessage: response, requestId } = group;
  const followedByReply =
    !!response &&
    response.audience !== "agents" &&
    !response.membership &&
    response.channelId === latest.channelId &&
    response.threadRootId === latest.threadRootId &&
    response.createdAt >= latest.createdAt &&
    requests.get(response.id) === requestId &&
    (participants.includes(response.authorId) ||
      // A helper can hand its result back to the replying coordinator without
      // the coordinator having authored a message in this activity run.
      ((response.agentEnvelope || agents?.has(response.authorId)) &&
        latest.mentions.includes(response.authorId)));
  // Only signed immediate reply links and activity IDs bind lifecycle evidence.
  // The preceding human message/thread root is useful for layout, not proof
  // that these updates came from that request's turn.
  const work = snapshot
    ? participants.flatMap((agent) => {
        const ids = group.history
          .filter((row) => row.authorId === agent)
          .flatMap((row) => [
            row.id,
            ...(row.replyParentId ? [row.replyParentId] : []),
          ]);
        return requestWork(snapshot, latest.channelId, ids).filter(
          (entry) => entry.agent === agent,
        );
      })
    : [];
  // A layout-associated request may prove ongoing work, but cannot prove
  // completion for an unlinked update. Keep those two evidence paths separate.
  const pending =
    snapshot && requestId
      ? requestWork(snapshot, latest.channelId, requestId).filter(
          (entry) =>
            participants.includes(entry.agent) && !isSettledWork(entry),
        )
      : [];
  const complete = participants.every((agent) =>
    work.some((entry) => entry.agent === agent && isSettledWork(entry)),
  );
  // Known pending, failed or uncertain work wins over the historical fallback.
  // Without lifecycle evidence, a related public reply only retires the live treatment.
  const retired =
    !pending.length &&
    (complete || (!!followedByReply && work.every(isSettledWork)));
  const working = new Set(
    [...work, ...pending]
      .filter((entry) => entry.working)
      .map((entry) => entry.agent),
  );
  const known = new Map(
    [...work, ...pending].map((entry) => [entry.agent, entry]),
  );
  const outcomes: ActivityPresentation["outcomes"] = [...known.values()].filter(
    (entry) => !entry.dismissed && ["error", "stopped"].includes(entry.state),
  );
  // The signed failure message remains evidence after live lifecycle data expires.
  for (const row of group.history)
    if (
      row.notice === "execution-failure" &&
      !row.edited &&
      !row.attachments.length &&
      (!known.has(row.authorId) || known.get(row.authorId)?.state === "unknown")
    )
      outcomes.push({
        agent: row.authorId,
        state: "error",
        reason: row.content,
      });
  return { retired, working, outcomes };
}

/** Shared projection for timeline and thread; hosts own scrolling and disclosure state. */
export function activityPresentation(
  rows: readonly ChannelMessage[],
  snapshot: Snapshot | undefined,
  agents: ReadonlySet<string> | undefined,
  rootId?: string,
  canAbsorbFailure: (failure: ChannelMessage) => boolean = () => true,
) {
  const following = new Map(
    rows.map((row, index) => [row.id, rows[index + 1]]),
  );
  const preceding = new Map(
    rows.map((row, index) => [row.id, rows[index - 1]]),
  );
  const requests = new Map<string, string>();
  if (rootId) requests.set(rootId, rootId);
  const representedAgents = new Map<string, string[]>();
  // Each request's latest public reply row per agent.
  const publicReplies = new Map<string, Map<string, string>>();
  const activityAuthors = new Set(
    rows
      .filter((row) => row.audience === "agents" || row.agentEnvelope)
      .map((row) => row.authorId),
  );
  let request = rootId;
  for (const row of rows) {
    const isAgent =
      activityAuthors.has(row.authorId) || agents?.has(row.authorId);
    if (
      row.audience !== "agents" &&
      !isAgent &&
      !row.membership &&
      agents &&
      !agents.has(row.authorId)
    )
      request = row.id;
    // A thread root is a scope, not necessarily the latest triggering request.
    // Preserve explicit reply links; otherwise follow the preceding request.
    const parentRequest = row.replyParentId
      ? (requests.get(row.replyParentId) ?? row.replyParentId)
      : undefined;
    const rowRequest = isAgent ? (parentRequest ?? request) : request;
    if (rowRequest) requests.set(row.id, rowRequest);
    if (rowRequest && !row.membership && isAgent) {
      const represented = representedAgents.get(rowRequest) ?? [];
      if (!represented.includes(row.authorId)) represented.push(row.authorId);
      representedAgents.set(rowRequest, represented);
      if (row.audience !== "agents") {
        const replies = publicReplies.get(rowRequest) ?? new Map();
        replies.set(row.authorId, row.id);
        publicReplies.set(rowRequest, replies);
      }
    }
  }
  const repliedAgents = new Map<string, string[]>();
  const replyRequests = new Map<string, string>();
  for (const [requestId, replies] of publicReplies) {
    repliedAgents.set(requestId, [...replies.keys()]);
    for (const id of replies.values()) replyRequests.set(id, requestId);
  }
  const groups: ActivityPresentation[] = [];
  const activityKey = (row: ChannelMessage) =>
    JSON.stringify([
      row.channelId,
      row.threadRootId,
      requests.get(row.id) ?? row.threadRootId,
      row.authorId,
    ]);
  const latestUpdates = new Map(
    rows
      .filter((row) => row.audience === "agents" && !row.membership)
      .map((row) => [activityKey(row), row.id]),
  );
  const bubbleAnchors = new Set<string>();
  const byRow = new Map<string, ActivityRowPresentation>();
  for (const run of activityRuns(rows, requests)) {
    const end = run.at(-1);
    const failure = end && following.get(end.id);
    const history =
      failure?.notice === "execution-failure" &&
      !failure.edited &&
      !failure.attachments.length &&
      failure.replyParentId &&
      canAbsorbFailure(failure) &&
      end &&
      run.some((row) => row.authorId === failure.authorId) &&
      failure.channelId === end.channelId &&
      failure.threadRootId === end.threadRootId &&
      new Date(failure.createdAt * 1000).toDateString() ===
        new Date(end.createdAt * 1000).toDateString() &&
      requests.get(failure.id) === requests.get(end.id)
        ? [...run, failure]
        : run;
    const first = history[0];
    const latest = history.at(-1);
    if (!first || !latest) continue;
    const participants = [...new Set(history.map((row) => row.authorId))];
    const liveParticipants = participants.filter((agent) =>
      history.some(
        (row) =>
          row.authorId === agent &&
          latestUpdates.get(activityKey(row)) === row.id,
      ),
    );
    const group: ActivityRun = {
      ids: history.map((row) => row.id),
      history,
      latest,
      participants,
      requestId: requests.get(first.id) ?? first.threadRootId,
      followingMessage: following.get(latest.id),
    };
    const { retired, working, outcomes } = activityStatus(
      group,
      snapshot,
      agents,
      requests,
    );
    const anchor = preceding.get(first.id);
    const standalone =
      !anchor ||
      !!anchor.membership ||
      anchor.audience === "agents" ||
      anchor.authorId !== first.authorId ||
      anchor.threadRootId !== first.threadRootId ||
      !continuesMessageGroup(anchor, first);
    if (!standalone && anchor) bubbleAnchors.add(anchor.id);
    const lastByAgent = new Map(history.map((row) => [row.authorId, row.id]));
    for (const row of history) {
      const last = lastByAgent.get(row.authorId) === row.id;
      byRow.set(row.id, {
        requestId: group.requestId,
        active:
          last &&
          liveParticipants.includes(row.authorId) &&
          working.has(row.authorId),
        ownsLive:
          last &&
          liveParticipants.includes(row.authorId) &&
          !retired &&
          (working.has(row.authorId) || !group.followingMessage),
        container: row.id === first.id && standalone ? "standalone" : "bubble",
        showAuthor:
          participants.length > 1 && row.notice === "execution-failure",
      });
    }
    groups.push({
      ...group,
      retired,
      liveParticipants,
      outcomes: outcomes.filter((entry) =>
        liveParticipants.includes(entry.agent),
      ),
      presentedParticipants: liveParticipants.filter(
        (agent) =>
          working.has(agent) || outcomes.some((entry) => entry.agent === agent),
      ),
      working: liveParticipants.some((agent) => working.has(agent)),
      workingUpdate: history
        .filter(
          (row) =>
            row.audience === "agents" &&
            liveParticipants.includes(row.authorId) &&
            working.has(row.authorId),
        )
        .at(-1),
      standalone,
    });
  }
  return {
    groups,
    byRow,
    representedAgents,
    repliedAgents,
    replyRequests,
    bubbleAnchors,
  };
}
export function useActivityPresentation(
  rows: readonly ChannelMessage[],
  activity: Activity | undefined,
  agents: ReadonlySet<string> | undefined,
  rootId?: string,
) {
  const channels = useMemo(
    () => new Set(rows.map((row) => row.channelId)),
    [rows],
  );
  const snapshot = useChannelActivitySnapshot(activity, channels);
  return useMemo(
    () => activityPresentation(rows, snapshot, agents, rootId),
    [rows, snapshot, agents, rootId],
  );
}

/** Each activity projection allocates fresh row values. Reuse the previous ones
 * while they are equal, so memoized rows skip unrelated activity updates. */
export function useStableRowActivity() {
  const [stable] = useState(() => {
    const activities = new Map<string, ActivityRowPresentation>();
    const agents = new Map<string, readonly string[]>();
    return {
      activity(
        id: string,
        next: ActivityRowPresentation | undefined,
        container = next?.container,
      ) {
        if (!next || !container) {
          activities.delete(id);
          return undefined;
        }
        const prior = activities.get(id);
        if (
          prior &&
          prior.requestId === next.requestId &&
          prior.active === next.active &&
          prior.ownsLive === next.ownsLive &&
          prior.showAuthor === next.showAuthor &&
          prior.container === container
        )
          return prior;
        const value = { ...next, container };
        activities.set(id, value);
        return value;
      },
      agents(id: string, next: readonly string[] | undefined) {
        if (!next) {
          agents.delete(id);
          return undefined;
        }
        const prior = agents.get(id);
        if (
          prior &&
          prior.length === next.length &&
          prior.every((agent, index) => agent === next[index])
        )
          return prior;
        agents.set(id, next);
        return next;
      },
    };
  });
  return stable;
}
