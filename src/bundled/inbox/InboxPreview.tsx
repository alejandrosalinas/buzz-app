import { reactionRows } from "./reaction-rows";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import type { Navigation } from "../../features/navigation/controller";
import type { NavigationScope } from "../../features/navigation/targets";
import type { PagePreviewProps } from "../../features/pages/service";
import { useIdentityNames } from "../../features/identity-names/react";
import { selectProfiles } from "../../features/relay/profile-selection";
import {
  useChannelList,
  useProfileGeneration,
  useRelayConnection,
} from "../../features/relay/react";
import { communityRefusalTitle } from "../../features/federated-identity/CommunitySignIn";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { ArrowRightIcon, ChecksIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { Switch } from "../../shared/design-system/ui/Switch";
import { readView, writeView } from "../../shared/view-state";
import {
  hasUnread,
  InboxRowButton,
  ReactionRowButton,
  rowIdentity,
  rowProfileIds,
} from "./InboxRow";
import { inboxTarget } from "./route";
import styles from "./InboxPreview.module.css";

/** Rows the card renders and enriches; the Activity page holds the rest. */
const maxRows = 50;
/** The card's own Unread only choice, separate from the Activity page filters. */
const unreadOnlyKey = "inbox:preview-unread-only";

// The card is narrower than the Activity page, so it abbreviates its timestamps
// as the channel activity preview does, with a date after a week.
const shortAge = (createdAt: number, now = Date.now()) => {
  const seconds = Math.max(0, Math.floor(now / 1000) - createdAt);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  return new Date(createdAt * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
};

/** Recent activity, shown while the pointer rests on the sidebar's Activity row. */
export function InboxPreview({
  relay,
  navigator,
  close,
}: PagePreviewProps & { relay: RelayData; navigator: Navigation }) {
  const connection = useRelayConnection(relay);
  const { viewer, scope } = connection;
  if (connection.status === "ready" && viewer && scope?.endsWith(`:${viewer}`))
    return (
      <InboxPreviewCard
        key={`${scope}:${connection.generation}`}
        session={connection.session}
        scope={{
          viewer,
          communityOrigin: scope.slice(0, -(viewer.length + 1)),
        }}
        navigator={navigator}
        close={close}
      />
    );
  return (
    <Card navigator={navigator} close={close}>
      <p className={`text-body text-subtle ${styles.notice}`} role="status">
        {connection.status === "connecting"
          ? "Connecting to your activity…"
          : connection.denied
            ? // Its notice, on every page, offers what fixes it.
              communityRefusalTitle(connection.refusal)
            : (connection.error ?? "Choose a community to see your activity.")}
      </p>
      {connection.status === "error" && !connection.denied && (
        <div className={styles.notice}>
          <Button size="sm" onClick={relay.tryAgain}>
            Retry connection
          </Button>
        </div>
      )}
    </Card>
  );
}

function InboxPreviewCard({
  session,
  scope,
  navigator,
  close,
}: PagePreviewProps & {
  session: RelaySession;
  scope: NavigationScope;
  navigator: Navigation;
}) {
  const list = useChannelList(session.channels);
  const inbox = useSyncExternalStore(
    session.unread.subscribeInbox,
    session.unread.inbox,
    session.unread.inbox,
  );
  const feed = useSyncExternalStore(
    session.inboxFeed.subscribe,
    session.inboxFeed.snapshot,
    session.inboxFeed.snapshot,
  );
  const reactions = useSyncExternalStore(
    session.inboxFeed.reactions.subscribe,
    session.inboxFeed.reactions.snapshot,
    session.inboxFeed.reactions.snapshot,
  );
  const sync = useSyncExternalStore(
    session.unread.subscribeSync,
    session.unread.sync,
    session.unread.sync,
  );
  const viewScope = session.scope;
  const [unreadOnly, setUnreadOnlyState] = useState(
    () => readView<unknown>(viewScope, unreadOnlyKey, false) === true,
  );
  const setUnreadOnly = (value: boolean) => {
    setUnreadOnlyState(value);
    writeView(viewScope, unreadOnlyKey, value);
  };
  const [refreshAfterRoster, setRefreshAfterRoster] = useState(false);
  useEffect(() => {
    // As on the page, a completed discovery revision can retire a feed attempt.
    void list.asOf;
    if (list.status !== "ready") return;
    // Retry after a roster failure also refreshes activity that failed meanwhile.
    if (refreshAfterRoster) {
      setRefreshAfterRoster(false);
      void Promise.all([
        session.unread.refresh(),
        session.inboxFeed.refresh(),
        session.inboxFeed.reactions.refresh(),
      ]);
    } else {
      void session.unread.ensure();
      void session.inboxFeed.ensure();
      void session.inboxFeed.reactions.ensure();
    }
  }, [session, list.status, list.asOf, refreshAfterRoster]);
  const channelOf = (channelId: string) =>
    list.channels.find((channel) => channel.id === channelId);
  const recent = [...inbox.items].sort(
    (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
  );
  const unread = recent.filter(hasUnread);
  const rows = [
    ...(unreadOnly ? unread : recent).map((item) => ({
      kind: "conversation" as const,
      item,
    })),
    ...(!unreadOnly ? reactionRows(reactions.items) : []).map((item) => ({
      kind: "reaction" as const,
      item,
    })),
  ]
    .sort(
      (a, b) =>
        b.item.createdAt - a.item.createdAt ||
        a.item.id.localeCompare(b.item.id),
    )
    .slice(0, maxRows);
  const profileKey = [
    ...new Set(
      rows.flatMap((row) => [
        ...(row.kind === "reaction"
          ? row.item.events.map((event) => event.pubkey)
          : [row.item.authorId]),
        ...rowProfileIds(
          row.kind === "reaction" ? {} : row.item,
          channelOf(row.item.channelId),
        ),
      ]),
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
    void profileGeneration;
    if (profileIds.length && list.status === "ready")
      void session.profiles.ensure(profileIds, "background").catch(() => {});
  }, [session, profileIds, list.status, profileGeneration]);

  const loading =
    list.status === "idle" ||
    list.status === "loading" ||
    inbox.status === "loading" ||
    feed.status === "loading" ||
    reactions.status === "loading";
  // As on the page, an empty result is only shown once activity was checked.
  const checked =
    inbox.status === "ready" ||
    feed.status === "ready" ||
    reactions.status === "ready";
  const failure =
    list.error ?? inbox.error ?? feed.error ?? reactions.error ?? sync.error;
  const retry = async () => {
    if (list.status !== "ready") {
      setRefreshAfterRoster(true);
      session.channels.ensureList();
    } else
      await Promise.all([
        session.unread.refresh(),
        session.inboxFeed.refresh(),
        session.inboxFeed.reactions.refresh(),
      ]);
    await session.unread.retrySync();
  };
  const unreadOnlyControl = useRef<HTMLElement>(null);
  const retryFocus = useRef(false);
  const retryButton = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    // Capture ownership before removal, not after focus has fallen to body.
    return () => {
      retryFocus.current = document.activeElement === button;
    };
  }, []);
  useLayoutEffect(() => {
    if (!retryFocus.current) return;
    retryFocus.current = false;
    // A recovered Retry hands its focus to the card, as on the page.
    if (failure || document.activeElement !== document.body) return;
    unreadOnlyControl.current?.focus({ preventScroll: true });
  }, [failure]);
  // Each conversation counts once, under its most specific kind, as the
  // page's filters with Unread only would list it. A Solo chat's own row has
  // no kind, so the total leads.
  let dms = 0;
  let mentions = 0;
  let threads = 0;
  for (const item of unread) {
    if (channelOf(item.channelId)?.channelType === "dm") dms++;
    else if (item.mention && hasUnread(item.mention)) mentions++;
    else if (item.thread) threads++;
  }
  const kinds = [
    mentions && `${mentions} ${mentions === 1 ? "mention" : "mentions"}`,
    threads && `${threads} ${threads === 1 ? "thread" : "threads"}`,
    dms && `${dms} ${dms === 1 ? "DM" : "DMs"}`,
  ].filter(Boolean);
  const summary = loading
    ? "Checking recent activity…"
    : unread.length
      ? [`${unread.length} unread`, ...kinds].join(" · ")
      : checked
        ? "Nothing unread"
        : undefined;
  const open = (row: (typeof rows)[number]) => {
    const item =
      row.kind === "reaction"
        ? {
            channelId: row.item.channelId,
            messageId: row.item.message.id,
            rootId: row.item.message.threadRootId,
          }
        : row.item;
    close();
    void navigator.open({
      version: 1,
      kind: "conversation",
      scope,
      channelId: item.channelId,
      messageId: item.messageId,
      ...(item.rootId && { threadRootId: item.rootId }),
    });
  };
  return (
    <Card
      navigator={navigator}
      close={close}
      summary={summary}
      unreadOnly={unreadOnly}
      onUnreadOnlyChange={setUnreadOnly}
      unreadOnlyRef={unreadOnlyControl}
    >
      {failure && (
        <div className={styles.notice} role="alert">
          <p className="text-body">{failure}</p>
          <Button ref={retryButton} size="sm" onClick={() => void retry()}>
            Retry activity
          </Button>
        </div>
      )}
      {rows.length ? (
        <ul className={styles.list} aria-label="Recent activity">
          {rows.map((row) => {
            const item = row.item;
            return (
              <li key={item.id}>
                {row.kind === "reaction" ? (
                  <ReactionRowButton
                    item={row.item}
                    session={session}
                    profiles={profiles}
                    name={name}
                    channel={channelOf(item.channelId)}
                    time={shortAge(item.createdAt)}
                    onClick={() => open(row)}
                  />
                ) : (
                  <InboxRowButton
                    item={row.item}
                    identity={rowIdentity(
                      row.item,
                      channelOf(item.channelId),
                      profiles,
                      name,
                    )}
                    media={session.media}
                    feed={feed}
                    time={shortAge(item.createdAt)}
                    onClick={() => open(row)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      ) : loading ? (
        [0, 1, 2].map((row) => (
          <div className={styles.placeholderRow} key={row} aria-hidden="true">
            <span className={styles.placeholderAvatar} />
            <span className={styles.placeholderLines}>
              <span className={styles.placeholderLine} />
              <span className={styles.placeholderLine} />
              <span className={styles.placeholderLine} />
            </span>
          </div>
        ))
      ) : failure || !checked ? null : (
        <div className={styles.empty} role="status">
          {unreadOnly ? (
            <EmptyState
              frame="none"
              level={4}
              icon={<ChecksIcon />}
              title="You're all caught up"
              description="No unread mentions, direct messages, or thread replies."
              action={
                recent.length || reactions.items.length ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setUnreadOnly(false)}
                  >
                    Show recent activity
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <EmptyState
              frame="none"
              level={4}
              icon={<ChecksIcon />}
              title="No recent activity"
              description="Mentions, direct messages, thread replies, and reactions to your messages appear here."
            />
          )}
        </div>
      )}
    </Card>
  );
}

/** The card's frame: title and Unread only above, Open Activity below. */
function Card({
  navigator,
  close,
  summary,
  unreadOnly,
  onUnreadOnlyChange,
  unreadOnlyRef,
  children,
}: PagePreviewProps & {
  navigator: Navigation;
  summary?: string | undefined;
  unreadOnly?: boolean;
  onUnreadOnlyChange?: (value: boolean) => void;
  unreadOnlyRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const switchId = useId();
  return (
    <div className={styles.card}>
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <h2 className={`text-label ${styles.title}`}>Activity</h2>
          <p
            className={`text-caption text-subtle ${styles.summary}`}
            role="status"
          >
            {summary ?? " "}
          </p>
        </div>
        <div className={styles.toggle}>
          <Switch
            ref={unreadOnlyRef}
            id={switchId}
            aria-label="Unread only"
            checked={!!unreadOnly}
            onCheckedChange={onUnreadOnlyChange}
            disabled={!onUnreadOnlyChange}
          />
          <label
            htmlFor={switchId}
            className={`text-caption ${onUnreadOnlyChange ? "text-subtle" : "text-disabled"}`}
          >
            Unread only
          </label>
        </div>
      </header>
      <div className={styles.body}>{children}</div>
      <footer className={styles.footer}>
        <NavigationItem
          label="Open Activity"
          trailing={<ArrowRightIcon size="1rem" aria-hidden="true" />}
          onClick={() => {
            close();
            void navigator.open(inboxTarget);
          }}
        />
      </footer>
    </div>
  );
}
