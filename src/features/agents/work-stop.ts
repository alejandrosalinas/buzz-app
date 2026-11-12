import type { RelaySession } from "../relay/session";
import type { Agents } from "./service";
import type { RequestWork } from "./request-work";
import type { LocalWork } from "./local-activity";
import { localWorkRoot } from "./local-activity";
import { activityTranscript } from "./activity-transcript";

export type WorkStopAgents = Pick<Agents, "interruptible" | "interrupt">;
export type WorkStop = {
  key: string;
  lifecycle: boolean;
  interrupt: () => Promise<boolean> | Promise<void>;
};
type Scope = {
  channelId: string;
  messageId: string;
  threadRootId?: string | undefined;
};
type Activity = RelaySession["agentActivity"];

/** Capability and exact scope are shared by request and conversation popovers. */
export function workStop(
  work: Pick<
    RequestWork,
    "agent" | "lifecycle" | "stoppable" | "state" | "working"
  >,
  scope: Scope,
  activity: Activity | undefined,
  agents: WorkStopAgents | undefined,
): WorkStop | undefined {
  const key = JSON.stringify([work.agent, scope.channelId, scope.messageId]);
  if (work.lifecycle) {
    if (
      !activity ||
      !work.stoppable ||
      (work.state !== "working" && work.state !== "waiting")
    )
      return;
    return {
      key,
      lifecycle: true,
      interrupt: () =>
        activity.interrupt(work.agent, scope.channelId, scope.messageId),
    };
  }
  const root = scope.threadRootId ?? scope.messageId;
  if (!root || !work.working || !agents?.interruptible(work.agent)) return;
  return {
    key,
    lifecycle: false,
    interrupt: () =>
      agents.interrupt(work.agent, {
        channelId: scope.channelId,
        threadRootId: root,
      }),
  };
}

export function conversationWorkStops(
  snapshot: ReturnType<Activity["snapshot"]> | undefined,
  agent: string,
  channelId: string,
  threadRootId: string | undefined,
  activity: Activity | undefined,
  agents: WorkStopAgents | undefined,
): {
  control: WorkStop;
  work?: LocalWork;
  threadRootId?: string | undefined;
}[] {
  if (!snapshot) return [];
  const local = (snapshot.local ?? []).filter(
    (work) =>
      work.agent === agent &&
      work.channelId === channelId &&
      (!threadRootId || work.threadRootId === threadRootId),
  );
  const result = local.flatMap((work) => {
    const control = workStop(
      { ...work, lifecycle: true, working: work.state === "working" },
      work,
      activity,
      agents,
    );
    return control
      ? [{ control, work, threadRootId: localWorkRoot(work) }]
      : [];
  });
  // Local lifecycle evidence owns this agent's state, including settled work.
  if (local.length || snapshot.status !== "listening") return result;
  const turns = activityTranscript(snapshot.records, {
    agent,
    channelId,
  }).turns;
  const roots = new Set(
    turns.flatMap((turn) =>
      !turn.endedAt &&
      typeof turn.threadRootId === "string" &&
      (!threadRootId || turn.threadRootId === threadRootId) &&
      snapshot.turns.some(
        (live) =>
          live.agent === agent &&
          live.channelId === channelId &&
          live.turnId === turn.turnId &&
          live.state === "working",
      )
        ? [turn.threadRootId]
        : [],
    ),
  );
  return [...roots].flatMap((root) => {
    const control = workStop(
      { agent, lifecycle: false, working: true, state: "working" },
      { channelId, messageId: root, threadRootId: root },
      activity,
      agents,
    );
    return control ? [{ control, threadRootId: root }] : [];
  });
}
