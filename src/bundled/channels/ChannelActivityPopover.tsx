import { workflowLabel } from "../../features/relay/workflow-attribution";
import { useIsPresent } from "motion/react";
import { LightningIcon } from "../../shared/design-system/icons";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { EnvelopeOpenIcon } from "../../shared/design-system/icons";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ComponentProps,
} from "react";
import { selectProfiles } from "../../features/relay/profile-selection";
import type { Profile } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import type {
  MentionActivityItem,
  ThreadActivityItem,
} from "../../features/relay/unread";
import { Avatar } from "../../shared/Avatar";
import { Avatar as WorkflowAvatar } from "../../shared/design-system/ui/Avatar";
import { publicKeyLabels } from "../../shared/identity/public-key";
import styles from "./Channels.module.css";
import activityStyles from "../../features/agents/ActivityRows.module.css";
import { AgentActivityRow } from "../../features/agents/AgentActivityRow";
import { workingAgentDetails } from "./working-agents";
import { avatarMedia } from "../../shared/avatar-source";
import { incompletePreview } from "../inbox/InboxRow";

const elapsed = (createdAt: number, now = Date.now()) => {
  const seconds = Math.max(0, Math.floor(now / 1000) - createdAt);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};
const workingDuration = (startedAt: number, now: number) => {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
};
const noSubscribe = () => () => {};

function ActivityRow({
  item,
  noun,
  previewId,
  session,
  agents,
  onOpen,
  read,
}: {
  item: ThreadActivityItem | MentionActivityItem;
  noun: "thread" | "mention";
  /** A message whose body Activity must not show until its edits and
   * deletions are checked. */
  previewId?: string;
  session: RelaySession;
  agents: readonly string[];
  onOpen(): void;
  read(): Promise<unknown>;
}) {
  const selection = useMemo(
    () =>
      selectProfiles(session.profiles, [item.workflowOwnerId ?? item.authorId]),
    [session.profiles, item.authorId, item.workflowOwnerId],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const displayId = item.workflowOwnerId ?? item.authorId;
  const profile = profiles.get(displayId);
  const resolveName = useChannelIdentityNames(session, item.channelId);
  const resolved = resolveName(
    displayId,
    profile?.name ?? displayId.slice(0, 10),
  );
  const name = item.workflowOwnerId ? workflowLabel(resolved) : resolved;
  const feed = useSyncExternalStore(
    session.inboxFeed.subscribe,
    session.inboxFeed.snapshot,
    session.inboxFeed.snapshot,
  );
  const preview = incompletePreview(feed, [previewId]) ?? item.preview;
  const isAgent =
    agents.includes(item.authorId) ||
    !!profile?.isAgent ||
    session.agentChoices
      .snapshot()
      .identities.some(({ pubkey }) => pubkey === item.authorId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const markRead = async () => {
    if (pending) return;
    setPending(true);
    setError(false);
    try {
      await read();
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  };
  return (
    <div
      className={`${activityStyles.activityItem} ${activityStyles.activityItemWithAction}`}
    >
      <NavigationItem
        type="button"
        aria-label={`Open unread ${noun} from ${name}: ${preview}`}
        onClick={onOpen}
        icon={
          item.workflowOwnerId ? (
            <WorkflowAvatar
              alt="Workflow"
              fallback="Workflow"
              fallbackContent={<LightningIcon size={20} />}
              shape="squircle"
            />
          ) : (
            <Avatar
              name={name}
              src={avatarMedia(profile?.picture, session.media)}
              shape={isAgent ? "squircle" : "circle"}
              className={activityStyles.activityAvatar ?? ""}
            />
          )
        }
        label={
          <span className={activityStyles.activityItemBody}>
            <span className={activityStyles.activityItemHeading}>
              <strong>{name}</strong>
              <span className={activityStyles.activityTimestamp}>
                {elapsed(item.createdAt)}
              </span>
            </span>
            <span className={styles.activityItemPreview}>{preview}</span>
          </span>
        }
      />
      <span className={activityStyles.activityItemAction}>
        <IconButton
          size="toolbar"
          icon={<EnvelopeOpenIcon />}
          aria-label={`Mark ${noun} from ${name} as read`}
          title="Mark as read"
          loading={pending}
          onClick={() => void markRead()}
        />
      </span>
      {error && (
        <p className={styles.activityReadError} role="alert">
          Could not mark this {noun} as read. Try again.
        </p>
      )}
    </div>
  );
}

export function ChannelActivityPopover({
  session,
  channelId,
  channelName,
  trigger,
  agents,
  agentProfiles,
  onOpenWorkingAgent,
  onOpenAgentActivity,
  onOpenThread,
  onOpenMention,
}: {
  session: RelaySession;
  channelId: string;
  channelName: string;
  trigger: ReactElement;
  agents?: readonly string[];
  agentProfiles?: ReadonlyMap<string, Profile>;
  onOpenWorkingAgent?: (
    channelId: string,
    agent: string,
    messageId: string | undefined,
  ) => void;
  onOpenAgentActivity?: (
    channelId: string,
    agent: string,
    messageId: string | undefined,
  ) => void;
  onOpenThread(item: ThreadActivityItem): void;
  onOpenMention(item: MentionActivityItem): void;
}) {
  const present = useIsPresent();
  const subscribe = useCallback(
    (listener: () => void) =>
      session.unread.subscribeActivity(channelId, listener),
    [session, channelId],
  );
  const get = useCallback(
    () => session.unread.activity(channelId),
    [session, channelId],
  );
  const snapshot = useSyncExternalStore(subscribe, get, get);
  const items = snapshot.items ?? [];
  const mentions = snapshot.mentions ?? [];
  const activeAgents = agents ?? [];
  const agentIds = activeAgents.join(",");
  const [open, setOpen] = useState(false);
  // Re-entry during the row's exit must not resurrect its old popup.
  if (!present && open) setOpen(false);
  const triggerPointerType = useRef<string | null>(null);
  const actions =
    useRef<
      NonNullable<ComponentProps<typeof PopoverRoot>["actionsRef"]>["current"]
    >(null);
  const pressedOpen = useRef(false);
  // An opened thread or mention takes focus itself. Base UI returns focus to
  // the trigger in a microtask after closing, which can land after, and steal
  // it from, what opened.
  const handoff = useRef(false);
  // Hover opens a transient preview. Selecting its row may still take focus.
  const [preview, setPreview] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open || !activeAgents.length) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open, activeAgents.length]);
  const getTargets = useCallback(() => {
    if (!agentIds) return "[]";
    const activity = session.agentActivity.snapshot();
    return JSON.stringify(
      agentIds
        .split(",")
        .map(
          (agent) => workingAgentDetails(activity, channelId, agent) ?? null,
        ),
    );
  }, [session, channelId, agentIds]);
  const details = JSON.parse(
    useSyncExternalStore(
      open && activeAgents.length
        ? session.agentActivity.subscribe
        : noSubscribe,
      getTargets,
      getTargets,
    ),
  ) as ({
    startedAt: number;
    messageId?: string;
    label?: string;
  } | null)[];
  const keyLabels = publicKeyLabels(activeAgents);
  const unread = items.length + mentions.length;
  const hasActivity = unread > 0 || activeAgents.length > 0;
  useEffect(() => {
    if (!hasActivity && open) actions.current?.close();
  }, [hasActivity, open]);
  const stale = unread > 0 && snapshot.freshness === "stale";
  // Row actions close through Base UI so its hover/press state resets; the
  // sidebar trigger stays mounted after the navigation they start.
  const close = () => {
    if (actions.current) actions.current.close();
    else setOpen(false);
  };
  return (
    <PopoverRoot
      modal={false}
      open={open && present}
      actionsRef={actions}
      onOpenChange={(next, details) => {
        if (next && !hasActivity) return details.cancel();
        if (details.reason === "trigger-press") {
          const mousePress =
            triggerPointerType.current === "mouse" &&
            details.event instanceof MouseEvent &&
            details.event.detail > 0;
          triggerPointerType.current = null;
          if (mousePress) {
            details.cancel();
            return;
          }
        }
        // A queued hover dismissal must not close a newer keyboard/touch opening.
        if (
          !next &&
          details.reason === "trigger-hover" &&
          pressedOpen.current
        ) {
          details.cancel();
          return;
        }
        pressedOpen.current = next && details.reason === "trigger-press";
        setPreview(next && details.reason === "trigger-hover");
        setOpen(next);
        if (next) {
          handoff.current = false;
          setNow(Date.now());
        }
        if (next && unread)
          void session.profiles
            .ensure(
              [
                ...new Set(
                  [...mentions, ...items].map(
                    ({ authorId, workflowOwnerId }) =>
                      workflowOwnerId ?? authorId,
                  ),
                ),
              ],
              "background",
            )
            .catch(() => {});
      }}
    >
      <PopoverTrigger
        render={trigger}
        data-popup-preview={preview ? "" : undefined}
        openOnHover={hasActivity && "preview"}
        onPointerDown={(event) => {
          triggerPointerType.current = event.pointerType;
        }}
      />
      <PopoverPopup
        data-channel-activity=""
        side="right"
        align="start"
        sideOffset={6}
        size="wide"
        padding="list"
        aria-label={`Activity in ${channelName}`}
        finalFocus={() => !handoff.current}
      >
        {open && (
          <div className={activityStyles.activityList}>
            {stale && (
              <p className={styles.activityStale}>May be out of date</p>
            )}
            {activeAgents.length > 0 && (
              <section aria-label="Agents working now">
                <h2 className={activityStyles.activitySectionLabel}>
                  Working now
                </h2>
                {activeAgents.map((agent, index) => {
                  const profile = agentProfiles?.get(agent);
                  const name = profile?.name ?? keyLabels.get(agent) ?? "Agent";
                  const { messageId, startedAt, label } = details[index] ?? {};
                  return (
                    <AgentActivityRow
                      key={agent}
                      name={name}
                      picture={avatarMedia(profile?.picture, session.media)}
                      status={label ?? "Working"}
                      meta={
                        startedAt === undefined
                          ? "—"
                          : workingDuration(startedAt, now)
                      }
                      openLabel={`Open ${messageId ? "thread" : "conversation"} for ${name} in ${channelName}`}
                      onOpen={() => {
                        close();
                        onOpenWorkingAgent?.(channelId, agent, messageId);
                      }}
                      onOpenActivity={
                        onOpenAgentActivity
                          ? () => {
                              close();
                              onOpenAgentActivity(channelId, agent, messageId);
                            }
                          : undefined
                      }
                    />
                  );
                })}
              </section>
            )}
            {mentions.length > 0 && (
              <section aria-label="Mentions">
                <h2 className={activityStyles.activitySectionLabel}>
                  Mentions
                </h2>
                {mentions.map((mention) => (
                  <ActivityRow
                    key={mention.messageId}
                    item={mention}
                    noun="mention"
                    previewId={mention.messageId}
                    session={session}
                    agents={activeAgents}
                    onOpen={() => {
                      handoff.current = true;
                      close();
                      onOpenMention(mention);
                    }}
                    read={() =>
                      session.unread.markThrough(
                        {
                          kind: "message",
                          channelId: mention.channelId,
                          messageId: mention.messageId,
                        },
                        mention.messageId,
                      )
                    }
                  />
                ))}
              </section>
            )}
            {items.length > 0 && (
              <section aria-label="Unread threads">
                <h2 className={activityStyles.activitySectionLabel}>
                  Unread threads
                </h2>
                {items.map((item) => (
                  <ActivityRow
                    key={item.rootId}
                    item={item}
                    noun="thread"
                    session={session}
                    agents={activeAgents}
                    onOpen={() => {
                      handoff.current = true;
                      close();
                      onOpenThread(item);
                    }}
                    read={() =>
                      session.unread.markThrough(
                        {
                          kind: "thread",
                          channelId: item.channelId,
                          rootId: item.rootId,
                        },
                        item.latestMessageId,
                      )
                    }
                  />
                ))}
              </section>
            )}
          </div>
        )}
      </PopoverPopup>
    </PopoverRoot>
  );
}
