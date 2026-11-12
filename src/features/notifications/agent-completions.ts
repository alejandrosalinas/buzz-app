import type {
  LocalAgentSource,
  LocalWork,
  LocalWorkState,
} from "../agents/local-activity";
import type { OpenTarget } from "../navigation/targets";
import { localWorkRoot } from "../agents/local-activity";

const running = (state: LocalWorkState | undefined) =>
  state === "waiting" || state === "working";
const completed = (state: LocalWorkState) =>
  state === "done" || state === "error";
const keyOf = (work: LocalWork) =>
  JSON.stringify([work.scope, work.agent, work.messageId]);

export const completionSourceKey = (
  work: Pick<LocalWork, "agent" | "messageId" | "state" | "startedAt">,
) => `${work.agent}:${work.messageId}:${work.startedAt}:${work.state}`;

export function completionTarget(
  work: LocalWork,
  scope: { viewer: string; communityOrigin: string } | undefined,
): OpenTarget | undefined {
  if (!scope) return;
  const messageId = work.syntheticMessage
    ? localWorkRoot(work)
    : work.messageId;
  return {
    version: 1,
    kind: "conversation",
    scope,
    channelId: work.channelId,
    ...(work.thread ? { threadRootId: work.threadRootId } : {}),
    ...(messageId ? { messageId } : {}),
  };
}

export function completionTitle(
  agentName: string,
  work: Pick<LocalWork, "state">,
) {
  return work.state === "error"
    ? `${agentName} encountered an error`
    : `${agentName} is done`;
}

export function completionBody(
  work: Pick<LocalWork, "state" | "error" | "conversationName">,
) {
  const destination = work.conversationName
    ? `View in ${work.conversationName}`
    : "View conversation";
  return work.state === "error" && work.error
    ? `${destination} · ${work.error}`
    : destination;
}

export function completionToast(
  agentName: string,
  work: Pick<LocalWork, "state" | "conversationName">,
) {
  const title = completionTitle(agentName, work);
  return work.conversationName ? `${title} in ${work.conversationName}` : title;
}

export function shouldShowForegroundCompletion(state: {
  developmentPaused: boolean;
  preferences: {
    enabled: boolean;
    categories: Readonly<Record<string, boolean>>;
  };
}) {
  return (
    !state.developmentPaused &&
    state.preferences.enabled &&
    state.preferences.categories.agent !== false
  );
}

export function isViewingCompletedWork(
  active: OpenTarget,
  completed: OpenTarget,
) {
  return (
    active.kind === "conversation" &&
    completed.kind === "conversation" &&
    active.scope.viewer === completed.scope.viewer &&
    active.scope.communityOrigin === completed.scope.communityOrigin &&
    active.channelId === completed.channelId &&
    active.threadRootId === completed.threadRootId
  );
}

/** One completion observer over the app-owned local work lifecycle. */
export function bindAgentCompletionNotifications(
  activity: LocalAgentSource,
  options: {
    focused(): boolean | Promise<boolean>;
    target(work: LocalWork): OpenTarget | undefined;
    active(): OpenTarget;
    desktop(work: LocalWork, target: OpenTarget): void;
    foreground(work: LocalWork, target: OpenTarget): void;
  },
) {
  let previous = new Map(
    activity
      .work()
      .map(
        (work) =>
          [keyOf(work), { state: work.state, solo: !!work.soloChat }] as const,
      ),
  );
  let disposed = false;
  const stop = activity.subscribeWork(() => {
    const next = new Map<string, { state: LocalWorkState; solo: boolean }>();
    for (const work of activity.work()) {
      const key = keyOf(work);
      const before = previous.get(key);
      next.set(key, { state: work.state, solo: !!work.soloChat });
      const completedNow =
        (running(before?.state) && completed(work.state)) ||
        (!before?.solo && !!work.soloChat && completed(work.state));
      if (!completedNow || !work.soloChat) continue;
      const target = options.target(work);
      if (!target) continue;
      const present = (focused: boolean) => {
        if (disposed) return;
        const current = activity
          .work()
          .find(
            (item) => keyOf(item) === key && item.startedAt === work.startedAt,
          );
        if (!current || current.state !== work.state || !current.soloChat)
          return;
        if (!focused) options.desktop(current, target);
        else if (!isViewingCompletedWork(options.active(), target))
          options.foreground(current, target);
      };
      const focused = options.focused();
      if (typeof focused === "boolean") present(focused);
      else void focused.then(present, () => present(false));
    }
    previous = next;
  });
  return () => {
    disposed = true;
    stop();
  };
}
