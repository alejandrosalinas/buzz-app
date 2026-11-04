import { useProfileGeneration } from "../../features/relay/react";
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import {
  ConversationChannel,
  ConversationThread,
} from "../../features/conversation/Conversation";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import { ChannelPreview } from "./ChannelPreview";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { Navigation } from "../../features/navigation/controller";
import type { NavigationScope } from "../../features/navigation/targets";
import { selectProfiles } from "../../features/relay/profile-selection";
import { useIdentityNames } from "../../features/identity-names/react";
import { mentionDraft } from "../../features/messages/mention-draft";
import { listComposerDrafts } from "../../features/messages/draft-presence";
import {
  clearAttachmentDraft,
  subscribeAttachmentDraftCounts,
} from "../../features/messages/attachment-draft";
import {
  clearView,
  draftCoordinates,
  subscribeView,
} from "../../shared/view-state";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { Button } from "../../shared/design-system/ui/Button";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import {
  ArrowSquareOutIcon,
  ChatCircleIcon,
  TrashIcon,
  XIcon,
} from "../../shared/design-system/icons/index";
import styles from "./Inbox.module.css";
import { dmLabel } from "./dm-label";
import { channelIcon, channelText } from "../../features/channels/channel-icon";
import { avatarMedia } from "../../shared/avatar-source";

export function DraftsView({
  session,
  scope,
  navigator,
  extensions,
  host,
  onEmptyRetire,
  toolbar,
  resizeHandle,
}: {
  session: RelaySession;
  scope: NavigationScope;
  navigator: Navigation;
  extensions?: ConversationExtensions | undefined;
  host: ConversationHostServices;
  onEmptyRetire(): void;
  toolbar: ReactNode;
  resizeHandle?: ReactNode;
}) {
  const [revision, update] = useState(0);
  useEffect(() => {
    const refresh = () => update((value) => value + 1);
    const stopViews = subscribeView(session.scope, refresh);
    const stopFiles = subscribeAttachmentDraftCounts(session, refresh);
    return () => {
      stopViews();
      stopFiles();
    };
  }, [session]);
  const [selected, setSelected] = useState<string>();
  const invoking = useRef<{
    key: string;
    row: HTMLButtonElement;
    focus: { current: HTMLElement | null };
  }>(undefined);
  const fallbackRow = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<HTMLButtonElement>(null);
  const visit = invoking.current;
  const coarse = !!window.matchMedia?.("(pointer: coarse)").matches;
  const autoFocus = coarse ? false : (visit?.focus ?? false);
  const detailRef = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    // Ref cleanup runs before removal, while focus ownership is still observable.
    return () => {
      if (invoking.current)
        restoreFocus.current = node.contains(document.activeElement)
          ? invoking.current.row
          : null;
    };
  }, []);
  useLayoutEffect(() => {
    if (selected || !restoreFocus.current) return;
    const row = restoreFocus.current.isConnected
      ? restoreFocus.current
      : fallbackRow.current;
    restoreFocus.current = null;
    if (row) row.focus();
    else onEmptyRetire();
  }, [selected, onEmptyRetire]);
  // Keep an emptied selected draft mounted while its composer is being edited.
  // The composer owns draft contents and storage; Inbox only enumerates its scope.
  const saved = listComposerDrafts(session, selected);
  void revision;
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const channels = list.channels;
  // Keep private-room drafts stored for their Huddle composer, outside Inbox.
  const excluded = (channelId: string) =>
    channels.some(
      (item) => item.id === channelId && (item.huddle || item.metadataPending),
    );
  const entries = saved.entries.flatMap(({ key, value }) => {
    const coordinates = draftCoordinates(key);
    return coordinates && !excluded(coordinates.channelId)
      ? [{ key, draft: mentionDraft(value), coordinates }]
      : [];
  });
  const [limit, setLimit] = useState(50);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const closeControl = useRef<HTMLButtonElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const entry = invoking.current;
    if (!selected || !entry) return;
    // The visit owns cancellation before a delayed root can mount its editor.
    const moved = (event: FocusEvent) => {
      if (event.target !== entry.focus.current) entry.focus.current = null;
    };
    document.addEventListener("focusin", moved, true);
    if (coarse && entry.focus.current === entry.row)
      closeControl.current?.focus({ preventScroll: true });
    return () => document.removeEventListener("focusin", moved, true);
  }, [selected, coarse]);
  const [error, setError] = useState<string>();
  // Selection owns editor lifetime, not the bounded list summary's eligibility.
  const coordinates = selected && draftCoordinates(selected);
  const active =
    selected && coordinates && !excluded(coordinates.channelId)
      ? { key: selected, coordinates }
      : undefined;
  useLayoutEffect(() => {
    if (!selected || active) return;
    invoking.current = undefined;
    setSelected(undefined);
    setConfirmDelete(false);
    setError(undefined);
  }, [selected, active]);
  const channelFor = (channelId: string) =>
    channels.find(
      (item) =>
        item.id === channelId &&
        !item.huddle &&
        !item.metadataPending &&
        !item.cached &&
        !item.archived &&
        !item.readOnly &&
        item.members?.includes(scope.viewer),
    );
  const visible = entries.slice(0, limit);
  const profileKey = [
    ...new Set(
      [
        ...visible,
        ...(active && !visible.some((entry) => entry.key === active.key)
          ? [active]
          : []),
      ].flatMap(({ coordinates }) => {
        const channel = channelFor(coordinates.channelId);
        return channel?.channelType === "dm"
          ? (channel.participants?.slice(0, 3) ?? [])
          : [];
      }),
    ),
  ]
    .sort()
    .join(":");
  const profileIds = useMemo(
    () => (profileKey ? profileKey.split(":") : []),
    [profileKey],
  );
  const selection = useMemo(
    () => selectProfiles(session.profiles, profileIds),
    [session, profileIds],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const name = useIdentityNames(session.names);
  const profileGeneration = useProfileGeneration(session.profiles);
  useEffect(() => {
    // An access/cache reset retires old profile work; a ready roster starts
    // a fresh bounded read for the visible DM destinations.
    void list.asOf;
    void profileGeneration;
    if (list.status === "ready" && profileIds.length)
      void session.profiles.ensure(profileIds, "background").catch(() => {});
  }, [session, profileIds, list.status, list.asOf, profileGeneration]);
  const destination = (channel: ChannelSummary | undefined) => {
    if (!channel) return "Unavailable conversation";
    if (channel.channelType !== "dm") return channelText(channel);
    return dmLabel(channel.participants, profiles, name);
  };
  const activeChannel = active
    ? channelFor(active.coordinates.channelId)
    : undefined;
  useEffect(() => {
    if (selected && !activeChannel)
      closeControl.current?.focus({ preventScroll: true });
  }, [selected, activeChannel]);
  const ActiveIcon = channelIcon(activeChannel);
  const title = !activeChannel
    ? "Unavailable conversation"
    : activeChannel.channelType === "dm"
      ? "Direct message"
      : activeChannel.name;
  const open = async () => {
    if (!active) return;
    const channel = channelFor(active.coordinates.channelId);
    if (!channel) {
      setError("This conversation is no longer available.");
      return;
    }
    try {
      const result = await navigator.open({
        version: 1,
        kind: "conversation",
        scope,
        channelId: channel.id,
        ...(active.coordinates.threadRootId
          ? {
              messageId: active.coordinates.threadRootId,
              threadRootId: active.coordinates.threadRootId,
            }
          : {}),
      });
      if (result.status === "failed")
        setError("Could not open the conversation. Try again.");
    } catch {
      setError("Could not open the conversation. Try again.");
    }
  };
  const originAction = (
    <IconButton
      size="sm"
      aria-label="Open in origin"
      title="Open in origin"
      onClick={() => void open()}
      icon={<ArrowSquareOutIcon size="1rem" aria-hidden="true" />}
    />
  );
  const retire = () => {
    // A saved-send callback belongs to this visit, not a later selection of
    // even the same key. Restore focus only after the surviving list commits.
    if (!visit || invoking.current !== visit) return;
    invoking.current = undefined;
    restoreFocus.current = visit.row;
    setSelected(undefined);
    setConfirmDelete(false);
    setError(undefined);
  };
  const remove = () => {
    if (!active || !confirmDelete) return;
    try {
      clearView(session.scope, active.key);
      clearAttachmentDraft(session, `${session.scope}:${active.key}`);
      retire();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not delete the draft. Try again.",
      );
    }
  };
  return (
    <div className={styles.workspace} data-selected={!!active || undefined}>
      {toolbar}
      <div className={styles.draftList}>
        {!entries.length && !saved.unavailable && !active && (
          <div role="status" className={styles.empty}>
            <EmptyState
              icon={<ChatCircleIcon />}
              title="No drafts"
              description="Messages you start writing appear here."
            />
          </div>
        )}
        <ul className={styles.list} aria-label="Drafts">
          {visible.map((entry) => {
            const channel = channelFor(entry.coordinates.channelId);
            const label = destination(channel);
            const dm = channel?.channelType === "dm";
            const Icon = channelIcon(channel);
            const first = dm ? channel.participants?.[0] : undefined;
            const artwork = first && profiles.get(first)?.picture;
            return (
              <li
                key={entry.key}
                className={styles.row}
                data-selected={selected === entry.key || undefined}
              >
                <NavigationItem
                  ref={entry === visible[0] ? fallbackRow : undefined}
                  aria-label={`Open draft for ${label}`}
                  selected={selected === entry.key}
                  icon={
                    dm && first ? (
                      <Avatar
                        size="default"
                        alt=""
                        fallback={label}
                        src={avatarMedia(artwork, session.media)}
                        shape={
                          profiles.get(first)?.isAgent ? "squircle" : "circle"
                        }
                      />
                    ) : (
                      <Icon size={20} aria-hidden="true" />
                    )
                  }
                  label={
                    <span className={styles.content}>
                      <strong
                        className={`text-label-sm text-standard ${styles.sender}`}
                      >
                        {label}
                      </strong>
                      <span className={styles.sourceLine}>
                        <span
                          className={`text-caption ${styles.source}`}
                          data-inbox-source=""
                        >
                          <span className={styles.sourceName}>
                            {entry.coordinates.threadRootId
                              ? "Reply"
                              : "Message"}{" "}
                            · {dm ? "DM" : "Channel"}
                          </span>
                        </span>
                      </span>
                      <span
                        className={`text-body text-subtle ${styles.preview}`}
                      >
                        {entry.draft.text.trim()
                          ? entry.draft.text
                          : entry.draft.gifs?.length &&
                              !entry.draft.chatCards?.length
                            ? "GIF"
                            : entry.draft.chatCards?.length
                              ? "Chat attachment"
                              : "Attachment"}
                      </span>
                    </span>
                  }
                  onClick={(event) => {
                    if (invoking.current?.key !== entry.key)
                      invoking.current = {
                        key: entry.key,
                        row: event.currentTarget,
                        focus: { current: event.currentTarget },
                      };
                    setSelected(entry.key);
                    setConfirmDelete(false);
                    setError(undefined);
                  }}
                />
              </li>
            );
          })}
        </ul>
        {!!saved.unavailable && (
          <p className={styles.notice} role="status">
            {saved.unavailable} saved drafts exceed the preview size limit. They
            remain in their conversations.
          </p>
        )}
        {saved.limited && (
          <p className={styles.notice} role="status">
            Showing the first 500 saved drafts. Other drafts remain in their
            conversations.
          </p>
        )}
        {entries.length > limit && (
          <div className={styles.notice}>
            <Button onClick={() => setLimit((value) => value + 50)}>
              Show more
            </Button>
          </div>
        )}
      </div>
      {active && (
        <section
          ref={detailRef}
          aria-label="Draft detail"
          className={styles.detail}
          onKeyDown={(event) => {
            if (
              event.key !== "Escape" ||
              event.defaultPrevented ||
              !event.currentTarget.contains(event.target as Node)
            )
              return;
            event.stopPropagation();
            retire();
          }}
        >
          {resizeHandle}
          <PanelHeader
            title={
              <PanelHeaderLabel
                title={title}
                icon={<ActiveIcon size="1rem" />}
              />
            }
            actions={
              <>
                <IconButton
                  hint="familiar"
                  size="sm"
                  ref={deleteTrigger}
                  aria-label="Delete draft…"
                  title="Delete draft"
                  aria-expanded={confirmDelete}
                  onClick={() => setConfirmDelete(true)}
                  icon={<TrashIcon size="1rem" />}
                />
                {activeChannel && originAction}
                <IconButton
                  ref={closeControl}
                  size="sm"
                  aria-label="Close detail"
                  onClick={retire}
                  icon={<XIcon size="1rem" />}
                />
              </>
            }
          />
          <div className={styles.detailBody}>
            {error && !confirmDelete && (
              <p role="alert" className="text-body">
                {error}
              </p>
            )}
            <div className={styles.draftEditor}>
              {activeChannel ? (
                <ConversationChannel
                  key={active.key}
                  session={session}
                  scope={session.scope}
                  extensions={extensions}
                  host={host}
                  threadId={active.coordinates.threadRootId}
                  channel={activeChannel}
                  active={false}
                >
                  {active.coordinates.threadRootId ? (
                    <ConversationThread
                      messageId={active.coordinates.threadRootId}
                      requireReadyRoot
                      autoFocus={autoFocus}
                      onDraftSaved={retire}
                    />
                  ) : (
                    <ChannelPreview
                      channelName={
                        activeChannel.channelType === "dm"
                          ? `DM with ${destination(activeChannel)}`
                          : activeChannel.name
                      }
                      draft
                      autoFocus={autoFocus}
                      onDraftSaved={retire}
                    />
                  )}
                </ConversationChannel>
              ) : (
                <p role="status" className="text-body text-subtle">
                  This conversation is unavailable. Your draft is unchanged.
                </p>
              )}
            </div>
            {confirmDelete && (
              <AlertDialog
                title="Delete draft?"
                initialFocus={cancelDelete}
                description="Delete this saved draft and its attachments on this device? This cannot be undone."
                onClose={() => setConfirmDelete(false)}
                // On deletion, retirement restores the surviving list control.
                // On cancel, Base UI restores the still-mounted delete trigger.
                finalFocus={() =>
                  invoking.current === visit ? deleteTrigger.current : false
                }
                actions={
                  <>
                    <Button size="sm" variant="destructive" onClick={remove}>
                      Delete draft
                    </Button>
                    <Button
                      size="sm"
                      ref={cancelDelete}
                      variant="ghost"
                      onClick={() => setConfirmDelete(false)}
                    >
                      Cancel
                    </Button>
                  </>
                }
              >
                {error && (
                  <p role="alert" className="text-body text-danger">
                    {error}
                  </p>
                )}
              </AlertDialog>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
