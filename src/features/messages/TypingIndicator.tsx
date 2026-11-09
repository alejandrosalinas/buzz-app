import { useActivityFocusHandoff } from "./use-activity-focus-handoff";
import messageStyles from "./Messages.module.css";
import {
  usePresentedAgents,
  useReplacedTypers,
} from "../conversation/typing-presentation";
import { useChannelIdentityNames } from "../identity-names/react";
import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  openProfileTranscript,
  profileActivityViewKey,
  profileActivityViewTarget,
} from "../profiles/target";
import {
  currentActivity,
  type CurrentActivity,
} from "../agents/current-activity";
import { localWorkLabel, type LocalWork } from "../agents/local-activity";
import { AgentResponsePreview } from "./AgentResponsePreview";
import { RemoteAgentHint, RemoteWorkIcon } from "./RemoteAgentHint";
import { remoteWorkDetail } from "../agents/execution-location";
import { ActivityStepPreview, activityStepLabel } from "./ActivityStepPreview";
import { AgentActivityRow } from "../agents/AgentActivityRow";
import { NavigationCard } from "../../shared/design-system/ui/NavigationItem";
import { OctagonIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { AgentsContext, useAgentsSnapshot } from "../agents/react";
import { conversationWorkStops } from "../agents/work-stop";
import { useWorkStops } from "../agents/use-work-stops";
import activityStyles from "../agents/ActivityRows.module.css";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import type { RelaySession } from "../relay/session";
import type { ComposerSession } from "./composer-session";
import type { MessageLinkOrigin } from "./MessageRow";
import styles from "./TypingIndicator.module.css";
import { avatarMedia } from "../../shared/avatar-source";

const noSubscribe = () => () => {};
const noActivity = () => undefined;
const noRows: readonly never[] = [];
const sameActivity = (
  a: ReadonlyMap<string, CurrentActivity>,
  b: ReadonlyMap<string, CurrentActivity>,
) =>
  a.size === b.size &&
  [...a].every(([agent, value]) => {
    const other = b.get(agent);
    return (
      other?.label === value.label &&
      other.detailAvailability === value.detailAvailability &&
      other.roots.length === value.roots.length &&
      other.roots.every((root, i) => root === value.roots[i])
    );
  });

type AgentSession = ComposerSession &
  Partial<Pick<RelaySession, "agentActivity">>;
// Public identity classifies typing only; it grants no access to step details.
function knownAgentsOf(
  choices: ReturnType<AgentSession["agentChoices"]["snapshot"]>,
  entries: ReturnType<AgentSession["typing"]["snapshot"]>,
  profiles: ReturnType<AgentSession["profiles"]["snapshot"]>,
) {
  const known = new Set(choices.identities.map(({ pubkey }) => pubkey));
  for (const entry of entries)
    if (profiles.get(entry.pubkey)?.isAgent) known.add(entry.pubkey);
  return known;
}
const threadRootsOf = (rows: readonly { id: string; replyCount: number }[]) =>
  new Set(rows.filter((row) => row.replyCount > 0).map((row) => row.id));
function channelRowsOf(
  session: AgentSession,
  channelId: string,
  watchChannel: boolean,
) {
  return watchChannel
    ? (session.channels?.window?.(channelId).rows ?? noRows)
    : noRows;
}

/** The working agents' keys only, for hosts that do not show their details:
 * re-render when that list changes, not on every typing or profile update. */
export function useLiveConversationAgents(
  session: AgentSession,
  channelId: string,
  threadRootId: string | undefined,
  includeThreads = true,
): readonly string[] {
  const presented = usePresentedAgents(session, channelId, threadRootId);
  const watchChannel = !threadRootId && !includeThreads;
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = [
        session.typing.subscribe(listener),
        session.agentChoices.subscribe(listener),
        session.profiles.subscribe(listener),
        session.agentActivity?.subscribe(listener),
        watchChannel
          ? session.channels?.subscribeWindow?.(channelId, listener)
          : undefined,
      ];
      return () => {
        for (const stop of stops) stop?.();
      };
    },
    [session, channelId, watchChannel],
  );
  const getKey = () => {
    const entries = session.typing.snapshot();
    const details = currentActivity(
      (session.agentActivity?.snapshot ?? noActivity)(),
      entries,
      knownAgentsOf(
        session.agentChoices.snapshot(),
        entries,
        session.profiles.snapshot(),
      ),
      channelId,
      threadRootId,
      includeThreads,
      threadRootsOf(channelRowsOf(session, channelId, watchChannel)),
    );
    return [...details.keys()]
      .filter((key) => !presented.has(key))
      .sort()
      .join(",");
  };
  const key = useSyncExternalStore(subscribe, getKey, getKey);
  return useMemo(() => (key ? key.split(",") : []), [key]);
}

/** Agents working in one conversation, over existing stores; no reads or capture. */
export function useConversationAgents(
  session: AgentSession,
  channelId: string,
  threadRootId: string | undefined,
  includeThreads = true,
) {
  const replaced = useReplacedTypers(session, channelId, threadRootId);
  const presented = usePresentedAgents(session, channelId, threadRootId);
  const entries = useSyncExternalStore(
    session.typing.subscribe,
    session.typing.snapshot,
  );
  const choices = useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const watchChannel = !threadRootId && !includeThreads;
  const subscribeChannel = useCallback(
    (listener: () => void) =>
      watchChannel
        ? (session.channels?.subscribeWindow?.(channelId, listener) ??
          (() => {}))
        : () => {},
    [session, channelId, watchChannel],
  );
  const channelRows = useSyncExternalStore(subscribeChannel, () =>
    channelRowsOf(session, channelId, watchChannel),
  );
  const channelThreadRoots = useMemo(
    () => threadRootsOf(channelRows),
    [channelRows],
  );
  const knownAgents = useMemo(
    () => knownAgentsOf(choices, entries, profiles),
    [choices, entries, profiles],
  );
  // Subscribe to what this indicator shows, not every observer frame.
  const last = useRef<ReadonlyMap<string, CurrentActivity>>(new Map());
  const getDetails = () => {
    const next = currentActivity(
      (session.agentActivity?.snapshot ?? noActivity)(),
      entries,
      knownAgents,
      channelId,
      threadRootId,
      includeThreads,
      channelThreadRoots,
    );
    if (!sameActivity(last.current, next)) last.current = next;
    return last.current;
  };
  const details = useSyncExternalStore(
    session.agentActivity?.subscribe ?? noSubscribe,
    getDetails,
    getDetails,
  );
  // A message's live bubble is the agent's working indicator. Recorded history
  // may own only the step details; then the conversation keeps its busy cue.
  const agents = [...details.keys()]
    .filter((key) => !presented.has(key))
    .sort();
  return {
    activity: (session.agentActivity?.snapshot ?? noActivity)(),
    details,
    entries,
    replaced,
    agents,
    knownAgents,
    choices,
  };
}

// Base UI mounts popup content only while open; building the rows inside a
// component keeps their per-request activity lookups off closed renders.
function ChooserItems({ items }: { items: () => ReactNode }) {
  return items();
}

/** Incoming conversation activity over existing stores; no reads or capture. */
export function TypingIndicator({
  session,
  channelId,
  threadRootId,
  canOpenActivity,
  openActivity,
  previousAuthor,
  inFlow = false,
  audience = "all",
}: {
  audience?: "all" | "humans" | "agents";
  previousAuthor?: string | undefined;
  inFlow?: boolean;
  session: ComposerSession & Partial<Pick<RelaySession, "agentActivity">>;
  channelId: string;
  threadRootId?: string | undefined;
  canOpenActivity?: ((target: string) => boolean) | undefined;
  openActivity?:
    | ((target: string, origin?: MessageLinkOrigin) => boolean)
    | undefined;
}) {
  const {
    activity,
    details,
    entries,
    replaced,
    agents: activeAgents,
    knownAgents,
    choices,
  } = useConversationAgents(
    session,
    channelId,
    threadRootId,
    !inFlow && audience !== "humans",
  );
  const lastLocal = useRef(activity?.local ?? noRows);
  const getLocal = () => {
    const next = session.agentActivity?.snapshot().local ?? noRows;
    if (
      next.length !== lastLocal.current.length ||
      next.some((work, index) => work !== lastLocal.current[index])
    )
      lastLocal.current = next;
    return lastLocal.current;
  };
  useSyncExternalStore(
    session.agentActivity?.subscribe ?? noSubscribe,
    getLocal,
    getLocal,
  );
  const agents = audience === "humans" ? [] : activeAgents;
  const hostedAgents = useContext(AgentsContext);
  useAgentsSnapshot(hostedAgents);
  const controls = new Map(
    agents.map((agent) => [
      agent,
      conversationWorkStops(
        activity,
        agent,
        channelId,
        threadRootId,
        session.agentActivity,
        hostedAgents,
      ),
    ]),
  );
  const { pending, stop } = useWorkStops(
    [...controls.values()].flatMap((rows) => rows.map((row) => row.control)),
  );
  const resolveName = useChannelIdentityNames(session, channelId);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  // Read only the already-loaded channel window to name threads. No ensure/read.
  const needsRows = agents.length > 0 && !threadRootId;
  const subscribeRows = useCallback(
    (listener: () => void) =>
      needsRows
        ? (session.channels.subscribeWindow?.(channelId, listener) ??
          (() => {}))
        : () => {},
    [session, channelId, needsRows],
  );
  const getRows = useCallback(
    () =>
      needsRows
        ? (session.channels.window?.(channelId).rows ?? noRows)
        : noRows,
    [session, channelId, needsRows],
  );
  const rows = useSyncExternalStore(subscribeRows, getRows);
  const firstAgent = agents[0];
  const humans = entries.filter(
    (entry) =>
      audience !== "agents" &&
      entry.channelId === channelId &&
      entry.threadRootId === threadRootId &&
      !knownAgents.has(entry.pubkey) &&
      !details.has(entry.pubkey) &&
      !replaced.has(entry.pubkey),
  );
  const name = (pubkey: string) =>
    resolveName(pubkey, profiles.get(pubkey)?.name ?? pubkey.slice(0, 10));
  const scopeLabel = (pubkey: string, workRoot?: string) => {
    if (threadRootId) return undefined;
    const roots = workRoot ? [workRoot] : (details.get(pubkey)?.roots ?? []);
    const labels = roots.slice(0, 2).map((root) => {
      if (root === null) return "Channel conversation";
      if (!root) return "Work with unconfirmed thread";
      const text = rows
        .find((row) => row.id === root)
        ?.content.replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);
      return `Thread · ${text || root.slice(0, 8)}`;
    });
    return [
      ...labels,
      ...(roots.length > 2 ? [`+${roots.length - 2} more`] : []),
    ].join(" / ");
  };
  // Unknown or multiple scopes open channel activity, never an inferred transcript.
  const activityOrigin = (pubkey: string): MessageLinkOrigin | undefined => {
    const roots = details.get(pubkey)?.roots ?? [];
    const rootId = threadRootId ?? (roots.length === 1 ? roots[0] : undefined);
    return rootId ? { rootId } : undefined;
  };
  // Only work in one known conversation opens straight to its transcript.
  const knownConversation = (pubkey: string) => {
    const roots = details.get(pubkey)?.roots ?? [];
    return (
      !!threadRootId ||
      (roots.length === 1 && (roots[0] === null || !!roots[0]))
    );
  };
  const directTarget = firstAgent
    ? profileActivityViewTarget(firstAgent)
    : undefined;
  const agentStatus = (
    pubkey: string,
    navigate: (target: string, origin?: MessageLinkOrigin) => void,
    work?: LocalWork,
    workRoot?: string,
  ) => {
    const detail = workRoot
      ? currentActivity(
          activity,
          entries,
          knownAgents,
          channelId,
          workRoot,
        ).get(pubkey)
      : details.get(pubkey);
    if (!detail) return null;
    const target = profileActivityViewTarget(pubkey);
    const canOpen = !!target && !!openActivity && !!canOpenActivity?.(target);
    const knownRoots = detail.roots.filter(
      (value) => typeof value === "string",
    );
    const conversationRoot =
      workRoot ??
      work?.threadRootId ??
      threadRootId ??
      (knownRoots.length === 1 ? knownRoots[0] : undefined);
    const conversation = conversationRoot
      ? `buzz://message?${new URLSearchParams({ channel: channelId, id: conversationRoot, thread: conversationRoot })}`
      : `buzz://channel/${encodeURIComponent(channelId)}`;
    const picture = profiles.get(pubkey)?.picture;
    const agent = choices.identities.find((choice) => choice.pubkey === pubkey);
    const remoteDetail = session.viewer
      ? remoteWorkDetail(agent?.execution, agent?.runtime)
      : undefined;
    const status = work
      ? localWorkLabel(work)
      : detail.detailAvailability === "available"
        ? detail.label
        : detail.detailAvailability === "no-current-step"
          ? (remoteDetail ?? "No current step details received.")
          : "Only typing updates are reaching this app.";
    const scope =
      detail.roots.length === 1 && detail.roots[0] === null
        ? undefined
        : scopeLabel(pubkey, workRoot);
    // The row is the way into an agent's transcript for this work.
    if (canOpen && target)
      return (
        <AgentActivityRow
          name={name(pubkey)}
          picture={avatarMedia(picture, session.media)}
          status={status}
          scope={scope}
          openLabel={`View ${name(pubkey)} activity`}
          onOpen={() =>
            navigate(
              target,
              workRoot ? { rootId: workRoot } : activityOrigin(pubkey),
            )
          }
        />
      );
    return (
      <AgentActivityRow
        name={name(pubkey)}
        picture={avatarMedia(picture, session.media)}
        status={status}
        scope={scope}
        openLabel={`Open ${conversationRoot ? "thread" : "conversation"} for ${name(pubkey)}`}
        onOpen={openActivity ? () => navigate(conversation) : undefined}
      />
    );
  };
  const workingText = activeAgents.length
    ? `${activeAgents.map(name).join(", ")}${activeAgents.length === 1 ? " is working" : " are working"}`
    : "";
  const typingText = humans.length
    ? `${humans
        .slice(0, 2)
        .map(({ pubkey }) => name(pubkey))
        .join(
          ", ",
        )}${humans.length > 2 ? ` and ${humans.length - 2} others` : ""}${humans.length === 1 ? " is typing" : " are typing"}`
    : "";
  const firstStep = firstAgent ? details.get(firstAgent)?.label : undefined;
  const previewText =
    (firstAgent && replaced.has(firstAgent)) ||
    firstStep === "Working" ||
    firstStep === "Received · waiting to start" ||
    firstStep === "Starting"
      ? undefined
      : firstStep;
  const visibleStep = activityStepLabel(previewText);
  return (
    <>
      {/* Establish the live region before the first working/typing transition. */}
      {audience !== "agents" && (
        <span
          className="sr-only"
          role="status"
          aria-label="Conversation activity"
          data-agent-working-status=""
        >
          {[workingText, typingText].filter(Boolean).join(". ")}
        </span>
      )}
      {(agents.length > 0 || humans.length > 0) && (
        <div
          className={styles.typing}
          data-audience={audience}
          data-in-flow={inFlow || undefined}
          data-layout={threadRootId ? "thread" : "timeline"}
          data-conversation-activity=""
        >
          {firstAgent && (
            <AgentResponsePreview
              stackPrevious={previousAuthor === firstAgent}
              name={name(firstAgent)}
              bylineHint={
                <RemoteAgentHint
                  session={session}
                  viewer={session.viewer}
                  pubkey={firstAgent}
                />
              }
              participants={agents.map((id) => ({
                id,
                name: name(id),
                picture: avatarMedia(profiles.get(id)?.picture, session.media),
              }))}
              picture={avatarMedia(
                profiles.get(firstAgent)?.picture,
                session.media,
              )}
              layout={threadRootId ? "thread" : "timeline"}
            >
              <AgentChooser
                key={`${channelId}:${threadRootId ?? ""}`}
                label={
                  visibleStep ||
                  (agents.length === 1 && firstAgent
                    ? `Activity: ${name(firstAgent)} working`
                    : `Activity: ${agents.length} agents working`)
                }
                content={
                  <ActivityStepPreview
                    icon={
                      visibleStep && (
                        <RemoteWorkIcon
                          session={session}
                          viewer={session.viewer}
                          pubkey={firstAgent}
                          active
                        />
                      )
                    }
                    state={
                      details.get(firstAgent)?.label ===
                        "Received · waiting to start" ||
                      details.get(firstAgent)?.label === "Starting"
                        ? "waiting"
                        : "working"
                    }
                    text={previewText}
                  />
                }
                openTarget={
                  openActivity &&
                  ((target, origin) => {
                    const agent = profileActivityViewKey(target);
                    const show = (next: string) => openActivity(next, origin);
                    return agent && (origin?.rootId || knownConversation(agent))
                      ? openProfileTranscript(target, show)
                      : show(target);
                  })
                }
                directTarget={
                  directTarget && canOpenActivity?.(directTarget)
                    ? directTarget
                    : undefined
                }
              >
                {(navigate) =>
                  agents.flatMap((pubkey) => {
                    const requests = controls.get(pubkey) ?? [];
                    if (!requests.length)
                      return (
                        <div key={pubkey}>{agentStatus(pubkey, navigate)}</div>
                      );
                    return requests.map(
                      ({ control, work, threadRootId: root }) => (
                        <NavigationCard key={control.key}>
                          {agentStatus(pubkey, navigate, work, root)}
                          <span className={styles.stopAction}>
                            <Button
                              size="sm"
                              variant="plain"
                              aria-label={`Stop ${name(pubkey)}${root && !threadRootId ? ` in ${scopeLabel(pubkey, root)}` : ""}`}
                              loading={pending.has(control.key)}
                              onClick={() => void stop(control, name(pubkey))}
                            >
                              <OctagonIcon
                                className={styles.stopIcon}
                                aria-hidden="true"
                              />
                              {pending.has(control.key) ? "Stopping…" : "Stop"}
                            </Button>
                          </span>
                        </NavigationCard>
                      ),
                    );
                  })
                }
              </AgentChooser>
            </AgentResponsePreview>
          )}
          {humans.length > 0 && (
            <span className={styles.humans} aria-hidden="true">
              <span className={styles.dots} aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span className={styles.label}>{typingText}</span>
            </span>
          )}
        </div>
      )}
    </>
  );
}

function AgentChooser({
  label,
  content,
  openTarget,
  directTarget,
  children,
}: {
  label: string;
  content: ReactNode;
  openTarget?:
    | ((target: string, origin?: MessageLinkOrigin) => boolean)
    | undefined;
  directTarget?: string | undefined;
  children(
    navigate: (target: string, origin?: MessageLinkOrigin) => void,
  ): ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useActivityFocusHandoff(trigger);
  const popup = useRef<HTMLDivElement>(null);
  const keyboardPreview = useRef(false);
  const actions =
    useRef<
      NonNullable<ComponentProps<typeof PopoverRoot>["actionsRef"]>["current"]
    >(null);
  useEffect(() => {
    if (!open) {
      keyboardPreview.current = false;
      return;
    }
    // Hover leaves focus in the composer. Consume Escape before its panel's
    // React handler; Base UI's document-bubble dismissal would arrive too late.
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229)
        return;
      event.preventDefault();
      event.stopPropagation();
      actions.current?.close();
    };
    document.addEventListener("keydown", dismiss, true);
    return () => document.removeEventListener("keydown", dismiss, true);
  }, [open]);
  const navigate = (target: string, origin?: MessageLinkOrigin) => {
    const previous = document.activeElement;
    // The popup action unmounts after navigation. Existing panel navigation
    // captures activeElement, so give it the retained avatar control instead.
    trigger.current?.focus({ preventScroll: true });
    // Close through Base UI so its hover/press state resets too. A retained
    // conversation keeps this control mounted after navigation.
    if (openTarget?.(target, origin)) {
      if (actions.current) actions.current.close();
      else setOpen(false);
    } else if (previous instanceof HTMLElement)
      previous.focus({ preventScroll: true });
  };
  return (
    <PopoverRoot
      modal={false}
      open={open}
      onOpenChange={(nextOpen, details) => {
        // Base UI tracks compositionstart/end; also honor the native key flags
        // when composition began before this hover popup mounted.
        if (
          details.reason === "escape-key" &&
          details.event instanceof KeyboardEvent &&
          (details.event.isComposing || details.event.keyCode === 229)
        ) {
          details.cancel();
          return;
        }
        setOpen(nextOpen);
      }}
      actionsRef={actions}
    >
      <PopoverTrigger
        ref={trigger}
        openOnHover="preview"
        render={
          <button
            type="button"
            data-buzz-ui=""
            className={messageStyles.activityBubbleTrigger}
            aria-label={label}
            data-agent-activity-trigger=""
            aria-keyshortcuts={directTarget ? "ArrowDown" : undefined}
            aria-description={
              directTarget
                ? "Press Down Arrow for working agents and conversation actions."
                : undefined
            }
            onKeyDown={(event) => {
              if (
                !directTarget ||
                event.key !== "ArrowDown" ||
                event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229 ||
                event.altKey ||
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey
              )
                return;
              event.preventDefault();
              event.stopPropagation();
              keyboardPreview.current = true;
              setOpen(true);
              popup.current?.focus();
            }}
          >
            {content}
          </button>
        }
      />
      <PopoverPopup
        ref={popup}
        initialFocus={keyboardPreview.current ? popup : undefined}
        size="wide"
        padding="list"
        side="top"
        align="start"
        aria-label="Working now"
      >
        <section
          className={activityStyles.activityList}
          aria-label="Agents working now"
        >
          <ChooserItems items={() => children(navigate)} />
        </section>
      </PopoverPopup>
    </PopoverRoot>
  );
}
