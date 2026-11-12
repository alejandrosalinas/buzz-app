import { activityTranscript } from "../../features/agents/activity-transcript";
import { useRecordedActivityAgents } from "../../features/conversation/typing-presentation";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { useProfileGeneration } from "../../features/relay/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import type { ComposerAccessoryProps } from "../../features/conversation/contracts";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import type { activityRecords } from "../../features/agents/activity-records";
import {
  openProfileTranscript,
  profileActivityViewTarget,
} from "../../features/profiles/target";
import { publicKeyLabels } from "../../shared/identity/public-key";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  OctagonIcon,
  WarningCircleIcon,
  XIcon,
} from "../../shared/design-system/icons";
import {
  NavigationCard,
  NavigationItem,
} from "../../shared/design-system/ui/NavigationItem";
import { ShimmerText } from "../../shared/design-system/ui/ShimmerText";
import { ActivityDisclosure } from "../../features/messages/ActivityDisclosure";
import {
  ActivityOutcome,
  activityOutcomeReason,
} from "../../features/messages/ActivityOutcome";
import { ActivityStepPreview } from "../../features/messages/ActivityStepPreview";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import { currentActivity } from "./current-activity";
import { messageWork } from "./message-activity";
import type { ActivityTurn } from "../../features/agents/activity";
import { workStop, type WorkStopAgents } from "../../features/agents/work-stop";
import { useWorkStops } from "../../features/agents/use-work-stops";
import {
  requestWork,
  type RequestWork,
} from "../../features/agents/request-work";
import {
  localWorkLabel,
  type WorkStep,
} from "../../features/agents/local-activity";
import {
  useTypingReplacement,
  useActivityTypingReplacement,
} from "../../features/conversation/typing-presentation";
import styles from "./ActivityAccessory.module.css";
import messageStyles from "../../features/messages/Messages.module.css";
import { avatarMedia } from "../../shared/avatar-source";
import { AgentResponsePreview } from "../../features/messages/AgentResponsePreview";
import { RemoteAgentHint } from "../../features/messages/RemoteAgentHint";
import { remoteWorkDetail } from "../../features/agents/execution-location";

const noSubscribe = () => () => {};
export type ActivityAgents = WorkStopAgents;
type ActivityProps = ComposerAccessoryProps & { agents?: ActivityAgents };
const noWork: RequestWork[] = [];
/** Activity belongs to the exact triggering message, not the composer. Once an
 * agent has publicly replied, its outcome follows that reply instead. */
export function ActivityAccessory(props: ActivityProps) {
  if (
    props.message?.notice === "execution-failure" &&
    !props.message.edited &&
    !props.message.attachments.length
  )
    return null;
  const request = props.stoppedRequest;
  const author = props.message?.authorId;
  return (
    <>
      <MessageActivity {...props} />
      {request && author && (
        <MessageActivity
          {...props}
          message={request}
          threadRootId={request.threadRootId}
          representedAgents={undefined}
          repliedAgents={undefined}
          stoppedRequest={undefined}
          stoppedAgent={author}
          // Visibility follows the request's scope, not the reply row's layout.
          threadScoped={
            props.messageLayout === "thread" || !!props.message?.threadRootId
          }
        />
      )}
    </>
  );
}
/** With `stoppedAgent`, only that agent's outcome for `message`. */
function MessageActivity(
  props: ActivityProps & { stoppedAgent?: string; threadScoped?: boolean },
) {
  const { session, channelId, message, canOpen, stoppedAgent } = props;
  const messageId = message?.id;
  const recorded = useRecordedActivityAgents(session, channelId, messageId);
  // Every row mounts this; only rows with work subscribe to each activity
  // step, profile and choice change. Others read once and wait for work.
  const hasWork = useSyncExternalStore(session.agentActivity.subscribe, () => {
    if (!messageId) return false;
    const work = messageWork(
      session.agentActivity.snapshot(),
      channelId,
      messageId,
    );
    return work.live.length > 0 || work.stopped.length > 0;
  });
  const snapshot = useSyncExternalStore(
    hasWork ? session.agentActivity.subscribe : noSubscribe,
    session.agentActivity.snapshot,
  );
  const work = useMemo(
    () =>
      messageId && hasWork
        ? messageWork(snapshot, channelId, messageId)
        : { live: noWork, stopped: noWork },
    [snapshot, channelId, messageId, hasWork],
  );
  const entries = [...work.live, ...work.stopped].filter((entry) => {
    const outcome = entry.state === "error" || entry.state === "stopped";
    return stoppedAgent
      ? outcome && entry.agent === stoppedAgent
      : !outcome || !props.repliedAgents?.includes(entry.agent);
  });
  const profiles = useSyncExternalStore(
    hasWork ? session.profiles.subscribe : noSubscribe,
    session.profiles.snapshot,
  );
  const choices = useSyncExternalStore(
    hasWork ? session.agentChoices.subscribe : noSubscribe,
    session.agentChoices.snapshot,
  );
  const resolveName = useChannelIdentityNames(session, channelId);
  const keys = entries.map((entry) => entry.agent);
  const identityKeys = keys.join(":");
  const profileGeneration = useProfileGeneration(session.profiles);
  useEffect(() => {
    void profileGeneration;
    if (identityKeys)
      void session.profiles
        .ensure(identityKeys.split(":"), "background")
        .catch(() => {});
  }, [session.profiles, identityKeys, profileGeneration]);
  const suffixes = publicKeyLabels(keys);
  const names = keys.map((key) =>
    resolveName(
      key,
      profiles.get(key)?.name ??
        choices.identities.find((row) => row.pubkey === key)?.name ??
        suffixes.get(key) ??
        "Agent",
    ),
  );
  const named = (agent: string) => {
    const name = names[keys.indexOf(agent)] ?? "Agent";
    return names.filter((value) => value === name).length > 1
      ? `${name} · ${suffixes.get(agent)}`
      : name;
  };
  const visible = (entry: RequestWork) => {
    if (!canOpen(profileActivityViewTarget(entry.agent) ?? "")) return false;
    if (recorded.has(entry.agent)) return false;
    const threadScoped =
      props.threadScoped ??
      (props.messageLayout === "thread" || !!message?.threadRootId);
    if (!threadScoped) {
      const local = (snapshot.local ?? []).filter(
        (work) =>
          work.agent === entry.agent &&
          work.channelId === channelId &&
          work.messageId === messageId,
      );
      if (local.length)
        return local.some(
          (work) =>
            !work.thread &&
            !(
              message &&
              message.replyCount > 0 &&
              work.threadRootId === message.id
            ),
        );
      const turns = activityTranscript(entry.selected.records, {
        agent: entry.agent,
        channelId,
      }).turns;
      if (
        entry.turns.length
          ? entry.turns.every(
              (turn) =>
                !!turn.threadRootId ||
                turns.some(
                  (raw) => raw.turnId === turn.turnId && !!raw.threadRootId,
                ),
            )
          : turns.length && turns.every((turn) => !!turn.threadRootId)
      )
        return false;
    }
    return true;
  };
  const shown: Entry[] = entries
    // Published replies do not end work. Only a mounted history owner can
    // replace this indicator (via recorded), including when Stop is unavailable.
    .filter(visible)
    .map((entry) => {
      const choice = choices.identities.find(
        (row) => row.pubkey === entry.agent,
      );
      return {
        agent: entry.agent,
        name: named(entry.agent),
        picture: profiles.get(entry.agent)?.picture,
        remoteStatus: session.viewer
          ? remoteWorkDetail(choice?.execution, choice?.runtime)
          : undefined,
        working: entry.working,
        state: entry.state,
        reason: entry.reason,
        ...(entry.step ? { step: entry.step } : {}),
        ...(entry.stoppable ? { stoppable: true } : {}),
        ...(entry.retryable ? { retryable: true } : {}),
        lifecycle: entry.lifecycle,
        records: entry.selected.records,
        turns: entry.turns,
      };
    });
  // When work ends (not when access is revoked), keep the last bubble long
  // enough for the shared leave recipe, then remove it.
  const section = useRef<HTMLElement>(null);
  const focusAfterRetry = () =>
    section.current
      ?.querySelector<HTMLButtonElement>(
        'button[aria-label^="View agent activity:"]',
      )
      ?.focus();
  const retained = useRef<Entry[]>([]);
  const [leaving, setLeaving] = useState<Entry[] | null>(null);
  const ended = !entries.length;
  useLayoutEffect(() => {
    // Child closes its portal and restores focus before this subtree is inert.
    if (section.current) section.current.inert = !shown.length;
    if (shown.length) {
      retained.current = shown;
      if (leaving) setLeaving(null);
      return;
    }
    if (ended && retained.current.length) setLeaving(retained.current);
    retained.current = [];
  });
  useLayoutEffect(() => {
    if (!leaving) return;
    const animations = section.current?.getAnimations?.() ?? [];
    if (!animations.length) {
      setLeaving(null);
      return;
    }
    let live = true;
    const done = () => {
      if (live) setLeaving(null);
    };
    void Promise.all(animations.map((animation) => animation.finished)).then(
      done,
      done,
    );
    return () => {
      live = false;
    };
  }, [leaving]);
  // The render where work ends keeps the same element (from the last shown
  // entries) so the list never loses and regains its height mid-handoff.
  const bubble = (
    shown.length ? shown : (leaving ?? (ended ? retained.current : []))
  ).filter((entry) => !recorded.has(entry.agent));
  if (!bubble.length) return null;
  const primary = bubble[0];
  if (!primary) return null;
  const compact = bubble.every((entry) =>
    ["error", "stopped"].includes(entry.state),
  );
  return (
    <section
      ref={section}
      className={`${styles.root} buzz-arrive`}
      data-message-activity=""
      data-arrive="grow"
      data-leaving={shown.length ? undefined : ""}
      data-buzz-ui=""
      aria-label="Agent activity on this message"
      aria-hidden={shown.length ? undefined : true}
    >
      <AgentResponsePreview
        name={primary.name}
        bylineHint={
          <RemoteAgentHint
            session={session}
            viewer={session.viewer}
            pubkey={primary.agent}
          />
        }
        participants={bubble.map((entry) => ({
          id: entry.agent,
          name: entry.name,
          picture: avatarMedia(entry.picture, session.media),
        }))}
        picture={avatarMedia(primary.picture, session.media)}
        layout={props.messageLayout}
      >
        {shown.map((entry) => (
          <TypingReplacement
            // A settled outcome is not working, so it leaves the cue alone.
            shared={entry.working || entry.state === "waiting"}
            key={entry.agent}
            {...props}
            agent={entry.agent}
          />
        ))}
        <ActivityBubble
          key={`${channelId}:${message?.id ?? ""}`}
          {...props}
          entries={bubble}
          compact={compact}
          interactive={shown.length > 0}
          onRetried={focusAfterRetry}
        />
      </AgentResponsePreview>
    </section>
  );
}

type Entry = {
  agent: string;
  name: string;
  picture: string | undefined;
  /** Active fallback for a known remote agent without current step details. */
  remoteStatus: string | undefined;
  working: boolean;
  state: RequestWork["state"];
  reason: string | undefined;
  step?: WorkStep;
  stoppable?: boolean;
  retryable?: boolean;
  lifecycle: boolean;
  records: ReturnType<typeof activityRecords>;
  turns: readonly ActivityTurn[];
};

function ActivityBubble({
  entries,
  interactive,
  compact = false,
  onRetried,
  agents,
  ...props
}: ActivityProps & {
  entries: Entry[];
  interactive: boolean;
  compact?: boolean;
  onRetried: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    if (entries.length === 1 && !compact) setExpanded(false);
  }, [entries.length, compact]);
  const message = props.message;
  const controls = new Map(
    entries.flatMap((entry) => {
      const control =
        message &&
        workStop(
          entry,
          {
            channelId: props.channelId,
            messageId: message.id,
            threadRootId: message.threadRootId ?? message.id,
          },
          props.session.agentActivity,
          agents,
        );
      return control ? [[entry.agent, control] as const] : [];
    }),
  );
  const { pending: stops, stop } = useWorkStops([...controls.values()]);
  const notify = useToastNotification();
  // A retried request begins again; its popup closes on the new row.
  const retry = (entry: Entry) => {
    if (!message) return;
    try {
      props.session.agentActivity.retry(
        entry.agent,
        props.channelId,
        message.id,
      );
      setExpanded(false);
      // Retry replaces the compact failure trigger with the active work row.
      queueMicrotask(onRetried);
    } catch (error) {
      notify(
        `Couldn’t retry ${entry.name}. ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  };
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const controlsRoot = useRef<HTMLDivElement>(null);
  const restoreFocusOnRemoval = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    return () => {
      if (node.contains(node.ownerDocument.activeElement))
        trigger.current?.focus({ preventScroll: true });
    };
  }, []);
  const stoppedFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const source = stoppedFocus.current;
    if (!compact || !source) return;
    stoppedFocus.current = null;
    const active = source.ownerDocument.activeElement;
    // Stop replaces the live popup with an inline outcome. Restore focus only
    // when that action still owns it; an intervening user move wins.
    if (active === source || active === source.ownerDocument.body)
      trigger.current?.focus({ preventScroll: true });
  }, [compact]);
  const retirement = useRef({
    interactive,
    onFocusedRemoval: props.onFocusedRemoval,
  });
  useLayoutEffect(() => {
    retirement.current = {
      interactive,
      onFocusedRemoval: props.onFocusedRemoval,
    };
  });
  useLayoutEffect(
    () => () => {
      // Published content removes this preview immediately, without a leave phase.
      // Ordinary completion uses the existing interactive=false handoff below.
      if (!retirement.current.interactive) return;
      const focused = trigger.current?.ownerDocument.activeElement;
      if (
        focused &&
        (controlsRoot.current?.contains(focused) ||
          trigger.current?.contains(focused) ||
          popup.current?.contains(focused))
      )
        retirement.current.onFocusedRemoval?.();
    },
    [],
  );
  useLayoutEffect(() => {
    if (interactive) return;
    const source = popup.current;
    const button = controlsRoot.current ?? trigger.current;
    const document = (source ?? button)?.ownerDocument;
    const active = document?.activeElement;
    setExpanded(false);
    if (active && (button?.contains(active) || source?.contains(active))) {
      // Commit closure before handing off: its overlay currently hides the
      // host's target. DOM observers release that target at this checkpoint.
      // Keep the retired nodes so unmount does not erase focus ownership.
      queueMicrotask(() => {
        const current = document?.activeElement;
        if (
          current === document?.body ||
          (current && (button?.contains(current) || source?.contains(current)))
        )
          props.onFocusedRemoval?.();
      });
    }
  }, [interactive, props.onFocusedRemoval]);
  const working = entries.some((entry) => entry.working);
  // Local work breathes until its first step ("Starting"), like the sidebar and thread.
  const starting = (entry: Entry) =>
    entry.lifecycle &&
    (entry.state === "waiting" || (entry.state === "working" && !entry.step));
  const waiting = entries.some(starting);
  const stepping = entries.some((entry) => entry.working && !starting(entry));

  const failedCount = entries.filter((entry) => entry.state === "error").length;
  const label = (entry: Entry) =>
    entry.lifecycle
      ? localWorkLabel({
          state:
            entry.state === "ended"
              ? "done"
              : entry.state === "unknown"
                ? "error"
                : entry.state,
          ...(entry.reason ? { error: entry.reason } : {}),
          ...(entry.step ? { step: entry.step } : {}),
        })
      : entry.state === "error"
        ? "failed"
        : entry.state === "stopped"
          ? "Stopped"
          : entry.working
            ? "working"
            : "status unknown";
  const failedEntries = entries.filter((entry) => entry.state === "error");
  const otherEntries = entries.filter(
    (entry) => !failedEntries.includes(entry),
  );
  const current =
    otherEntries.find((entry) => entry.working && entry.step) ??
    otherEntries.find((entry) => entry.working);
  const currentPreview =
    current && !current.lifecycle
      ? currentActivity(current.records, current.turns)
      : undefined;
  const stepText = current?.step
    ? label(current)
    : currentPreview
      ? [currentPreview.title, currentPreview.detail]
          .filter(Boolean)
          .join(" · ")
      : entries.length === 1
        ? current?.remoteStatus
        : undefined;
  const avatars = (group: Entry[]) => (
    <AvatarStack
      size="mini"
      items={group.map((entry) => ({
        id: entry.agent,
        name: entry.name,
        src: avatarMedia(entry.picture, props.session.media),
        shape: "squircle",
      }))}
    />
  );
  const content = (
    <span className={styles.summaryGroups}>
      {otherEntries.length > 0 && (
        <span className={styles.summaryActivity} data-thread-working="">
          {(working || waiting) && (
            <ActivityStepPreview
              text={stepText}
              state={stepping ? "working" : "waiting"}
            />
          )}
          {entries
            .filter((entry) => entry.state === "stopped")
            .map((entry) => (
              <ActivityOutcome
                key={entry.agent}
                state="stopped"
                name={entries.length > 1 ? entry.name : undefined}
              />
            ))}
        </span>
      )}
      {failedCount > 0 && (
        <span
          className={`${styles.summaryActivity} ${styles.failure}`}
          data-activity-failure=""
        >
          {avatars(
            failedEntries.filter((entry) => entry.agent !== entries[0]?.agent),
          )}
          <WarningCircleIcon size={12} aria-hidden="true" />
          <span>
            {failedCount === 1 ? "Couldn’t finish" : `${failedCount} failed`}
          </span>
        </span>
      )}
    </span>
  );
  if (!entries.length) return null;
  const stopAction = (entry: Entry) => {
    const control = controls.get(entry.agent);
    if (!control) return null;
    const stopping = stops.has(control.key);
    return (
      <Button
        size="sm"
        variant="plain"
        aria-label={`Stop ${entry.name}`}
        loading={stopping}
        tabIndex={interactive ? undefined : -1}
        onClick={(event) => {
          event.stopPropagation();
          if (!interactive) return;
          if (
            event.currentTarget ===
            event.currentTarget.ownerDocument.activeElement
          )
            stoppedFocus.current = event.currentTarget;
          stop(control, entry.name);
        }}
      >
        <OctagonIcon className={styles.stopIcon} aria-hidden="true" />
        <span>Stop</span>
      </Button>
    );
  };
  const activityLabel = `View agent activity: ${entries
    .map((entry) => {
      const control = controls.get(entry.agent);
      const status =
        control && stops.has(control.key) ? "Stopping…" : label(entry);
      return `${entry.name}, ${entry.remoteStatus ? "remote, " : ""}${status}`;
    })
    .join("; ")}`;
  const single = entries.length === 1 ? entries[0] : undefined;
  const singleControl = single && controls.get(single.agent);
  const singleStopping = !!singleControl && stops.has(singleControl.key);
  const details = (
    <div ref={restoreFocusOnRemoval} className={styles.previews}>
      {entries.map((entry) => {
        // Opens the agent's Activity on this message's transcript.
        const target = profileActivityViewTarget(entry.agent);
        const preview = entry.working
          ? currentActivity(entry.records, entry.turns)
          : undefined;
        const control = controls.get(entry.agent);
        const stopping = !!control && stops.has(control.key);
        return (
          <div key={entry.agent} className={styles.previews}>
            {compact && (
              <p className="text-body-sm">
                {activityOutcomeReason(entry.state, entry.reason)}
              </p>
            )}
            <NavigationCard>
              <NavigationItem
                variant="option"
                aria-label={`View activity for ${entry.name}`}
                disabled={!target || !props.canOpen(target)}
                onClick={() => {
                  if (
                    target &&
                    props.canOpen(target) &&
                    openProfileTranscript(target, props.open)
                  )
                    setExpanded(false);
                }}
                icon={
                  <ActivityAvatar
                    session={props.session}
                    entry={entry}
                    size="small"
                  />
                }
                label={
                  <span
                    className={`text-body-sm ${styles.preview}`}
                    data-error={
                      !compact && entry.state === "error" ? "" : undefined
                    }
                  >
                    <ShimmerText
                      active={stopping || entry.working || starting(entry)}
                    >
                      {(stopping ? "Stopping…" : undefined) ??
                        (compact
                          ? "View activity"
                          : entry.lifecycle || entry.state === "error"
                            ? label(entry)
                            : !entry.working
                              ? "Activity interrupted or out of date"
                              : (preview?.title ??
                                entry.remoteStatus ??
                                "Waiting for activity details"))}
                    </ShimmerText>
                    {preview?.detail && (
                      <span className={styles.detail}>
                        <ShimmerText active={entry.working}>
                          {preview.detail}
                        </ShimmerText>
                      </span>
                    )}
                  </span>
                }
              />
              {entry.lifecycle && entry.state === "error" ? (
                <span className={styles.action}>
                  {entry.retryable && (
                    <Button
                      size="sm"
                      variant="subtle"
                      aria-label={`Retry ${entry.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        retry(entry);
                      }}
                    >
                      Retry
                    </Button>
                  )}
                  <IconButton
                    size="sm"
                    variant="ghost"
                    aria-label={`Dismiss error from ${entry.name}`}
                    icon={<XIcon />}
                    onClick={(event) => {
                      event.stopPropagation();
                      // Retirement owns the last popup's close and focus
                      // handoff; keep its focused contents until that effect.
                      if (props.message)
                        props.session.agentActivity.dismissError?.(
                          entry.agent,
                          props.channelId,
                          props.message.id,
                        );
                    }}
                  />
                </span>
              ) : control ? (
                <span className={styles.action}>{stopAction(entry)}</span>
              ) : undefined}
            </NavigationCard>
          </div>
        );
      })}
    </div>
  );
  if (compact)
    return (
      <ActivityDisclosure
        expanded={expanded}
        onToggle={() => setExpanded((open) => !open)}
        trigger={trigger}
        container={popup}
        interactive={interactive}
        label={`${expanded ? "Collapse" : "Show"} activity history: ${entries.map((entry) => `${entry.name}, ${label(entry)}`).join("; ")}`}
        summary={content}
        expandedSummary={content}
      >
        {details}
      </ActivityDisclosure>
    );
  return (
    <PopoverRoot
      open={!single && expanded}
      onOpenChange={(open) => setExpanded(!single && interactive && open)}
    >
      <div
        ref={controlsRoot}
        className={`${messageStyles.activityBubbleControls} ${singleControl ? styles.overlayControls : ""}`}
        data-activity-controls=""
      >
        <PopoverTrigger
          openOnHover={!single && interactive && "preview"}
          {...(!interactive || single
            ? {
                "aria-haspopup": undefined,
                "aria-expanded": undefined,
                "aria-controls": undefined,
              }
            : {})}
          onClick={(event) => {
            if (!interactive) {
              event.preventBaseUIHandler();
              return;
            }
            if (single) {
              event.preventBaseUIHandler();
              const target = profileActivityViewTarget(single.agent);
              if (target && props.canOpen(target))
                openProfileTranscript(target, props.open);
            }
          }}
          render={
            <button
              ref={trigger}
              tabIndex={interactive ? undefined : -1}
              type="button"
              className={messageStyles.activityBubbleTrigger}
              data-activity-summary=""
              aria-label={activityLabel}
            >
              {singleControl ? (
                <span className={styles.overlayContent}>
                  {singleStopping ? (
                    <ShimmerText active>Stopping…</ShimmerText>
                  ) : (
                    content
                  )}
                </span>
              ) : (
                content
              )}
            </button>
          }
        />
        {single && singleControl && (
          <span
            ref={restoreFocusOnRemoval}
            className={styles.inlineStop}
            data-stopping={singleStopping || undefined}
          >
            {stopAction(single)}
          </span>
        )}
      </div>
      <PopoverPopup
        ref={popup}
        finalFocus={() =>
          retirement.current.interactive ? trigger.current : false
        }
        side="top"
        padding="list"
        aria-label="Agent activity"
      >
        {expanded && details}
      </PopoverPopup>
    </PopoverRoot>
  );
}

/** Message-linked work replaces the composer control; unassociated work keeps
 * main's existing presentation rather than disappearing without a bubble. */
export function ActivityTypingReplacement(props: ComposerAccessoryProps) {
  // Subscribe to which agents are replaced, not every observer frame.
  const agents = useSyncExternalStore(
    props.session.agentActivity.subscribe,
    () => replacedAgents(props),
  );
  return (
    <>
      {agents
        .split(",")
        .filter(Boolean)
        .map((agent) => (
          <TypingReplacement key={agent} {...props} agent={agent} />
        ))}
    </>
  );
}
function replacedAgents(props: ComposerAccessoryProps) {
  const activity = props.session.agentActivity.snapshot();
  const ids = [
    ...(props.threadRootId ? [props.threadRootId] : []),
    ...(activity.local ?? [])
      .filter(
        (request) =>
          request.channelId === props.channelId &&
          (!props.threadRootId ||
            (request.threadRootId ?? request.messageId) === props.threadRootId),
      )
      .map((request) => request.messageId),
    ...activity.turns.flatMap((turn) =>
      turn.channelId === props.channelId
        ? (turn.requests ?? [])
            .filter(
              (request) =>
                !props.threadRootId ||
                request.threadRootId === props.threadRootId,
            )
            .map((request) => request.messageId)
        : [],
    ),
  ];
  return requestWork(activity, props.channelId, ids)
    .map(({ agent }) => agent)
    .join(",");
}
function TypingReplacement({
  session,
  channelId,
  threadRootId,
  message,
  messageLayout,
  agent,
  shared = false,
}: ComposerAccessoryProps & {
  agent: string;
  /** Only the live bubble shares its registration. It shows the agent working,
   * so the conversation shows no second cue (presence). */
  shared?: boolean;
}) {
  // A thread's root row has no thread root of its own, but its bubble shows in
  // that thread's conversation, so it owns that thread's indicator.
  const shownIn =
    threadRootId ?? (messageLayout === "thread" ? message?.id : undefined);
  useActivityTypingReplacement(
    {
      session,
      channelId,
      threadRootId: shownIn,
      pubkey: agent,
      presence: shared,
    },
    shared,
  );
  useTypingReplacement(
    { session, channelId, threadRootId, pubkey: agent },
    true,
  );
  return null;
}

function ActivityAvatar({
  session,
  entry,
  size = "compact",
}: Pick<ComposerAccessoryProps, "session"> & {
  entry: Entry;
  size?: "compact" | "small";
}) {
  return (
    <Avatar
      src={avatarMedia(entry.picture, session.media)}
      alt={entry.name}
      fallback={entry.name}
      size={size}
      shape="squircle"
    />
  );
}
