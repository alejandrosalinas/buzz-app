import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { InboxItem } from "../../features/relay/inbox";
import type {
  PageTabsProps,
  PageTabTarget,
} from "../../features/conversation/contracts";
import type { Navigation } from "../../features/navigation/controller";
import type { NavigationScope } from "../../features/navigation/targets";
import type { PageNavigation } from "../../features/navigation/service";
import { reactionRows } from "./reaction-rows";
import { routeOf } from "./route";
import {
  hasUnread,
  InboxRowButton,
  ReactionRowButton,
  rowIdentity,
  rowProfileIds,
} from "./InboxRow";
import {
  useChannelList,
  useProfileGeneration,
  useRelayConnection,
} from "../../features/relay/react";
import { selectProfiles } from "../../features/relay/profile-selection";
import { useIdentityNames } from "../../features/identity-names/react";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { Button } from "../../shared/design-system/ui/Button";
import {
  InboxFilters,
  type ActivityFilter,
  type SenderFilter,
} from "./InboxFilters";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { BellIcon, CheckIcon } from "../../shared/design-system/icons";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuItem,
  MenuPopup,
} from "../../shared/design-system/ui/Menu";
import { communityRefusalTitle } from "../../features/federated-identity/CommunitySignIn";
import styles from "./Inbox.module.css";
import {
  readView,
  subscribeView,
  viewRevision,
  writeView,
} from "../../shared/view-state";

type AttentionFilter = "all" | "unread";
// Saved values, defaults first.
const activities = ["all", "dms", "threads", "mentions", "reactions"] as const;
const senders = ["everyone", "humans", "agents"] as const;
const attentions = ["all", "unread"] as const;
type Filters = {
  activity: ActivityFilter;
  sender: SenderFilter;
  attention: AttentionFilter;
};
const filtersKey = "inbox:filters";
/** Saved choices are per device/viewer/community; unknown or missing fields use
 * defaults, and retired fields (a saved Archived view) are ignored. */
function readFilters(scope: string): Filters {
  const saved = readView<unknown>(scope, filtersKey, undefined);
  const field = <T extends string>(
    key: keyof Filters,
    options: readonly [T, ...T[]],
  ): T => {
    const value: unknown =
      saved && typeof saved === "object"
        ? (saved as Record<string, unknown>)[key]
        : undefined;
    return options.find((option) => option === value) ?? options[0];
  };
  return {
    activity: field("activity", activities),
    sender: field("sender", senders),
    attention: field("attention", attentions),
  };
}
const matchesActivity = (
  item: InboxItem,
  filter: ActivityFilter,
  isDm: boolean,
) => {
  switch (filter) {
    case "all":
      return true;
    case "reactions":
      return false;
    case "dms":
      return isDm;
    case "mentions":
      return item.mentioned;
    case "threads":
      return item.thread;
  }
};
const targetOf = (item: InboxItem) => ({
  channelId: item.channelId,
  messageId: item.messageId,
  ...(item.rootId ? { rootId: item.rootId } : {}),
});

/** DMs, including their reactions, and a Solo chat's own messages open whole;
 * others open at their message. A DM row opens as its thread only when that
 * thread alone shows its unread messages; its read then stops before any
 * message outside the thread. */
const tabTarget = (
  item: Pick<
    InboxItem,
    "channelId" | "messageId" | "rootId" | "thread" | "threadOnly"
  > & {
    target?: InboxItem["target"];
  },
  channel: { channelType?: string } | undefined,
): PageTabTarget =>
  ((item.target?.kind === "channel" || channel?.channelType === "dm") &&
    !item.threadOnly) ||
  (channel?.channelType === "solo" && !item.thread)
    ? { channelId: item.channelId }
    : {
        channelId: item.channelId,
        threadId: item.rootId ?? item.messageId,
        messageId: item.messageId,
      };

type Selection = {
  channelId: string;
  messageId: string;
  rootId?: string;
  reaction?: string;
};
// The row a tab opened and the list's offset, kept as long as the session's
// tabs so returning to Activity still selects the conversation it restores,
// at the place it left. A relaunch starts at the top.
const selections = new WeakMap<
  RelaySession,
  {
    opened?: PageTabTarget | undefined;
    target?: Selection | undefined;
    scrollTop?: number | undefined;
    /** Whether the selected row overlapped the list's visible box. */
    selectedShown?: boolean | undefined;
  }
>();
/** Whether the selected row overlaps the list's visible box, once rendered. */
function selectedInView(list: HTMLElement) {
  const row = list.querySelector("li[data-selected]");
  if (!row) return undefined;
  const bounds = list.getBoundingClientRect();
  const rect = row.getBoundingClientRect();
  return rect.bottom > bounds.top && rect.top < bounds.bottom;
}
/** Whether another tab covers the list, or it is hidden; neither is measured. */
const covered = (list: HTMLElement) => !!list.closest("[hidden], [inert]");

type InboxPageTabs = (props: PageTabsProps) => ReactNode;

// Each presentation of a visit (a new open, even of the same address) is a fresh
// navigation object, so a route is applied once per object and never re-applied
// by a remount or re-render of the same one.
const appliedRoutes = new WeakSet<object>();

export function InboxPage({
  relay,
  navigator,
  tabs,
  navigation,
}: {
  relay: RelayData;
  navigator: Navigation;
  navigation?: PageNavigation | undefined;
  /** The host tab workspace, `conversation.ui.Tabs`, while a plugin provides it. */
  tabs?: InboxPageTabs | undefined;
}) {
  const connection = useRelayConnection(relay);
  const { viewer, scope } = connection;
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Activity">
        {connection.status === "ready" &&
        viewer &&
        scope?.endsWith(`:${viewer}`) ? (
          <InboxView
            key={`${scope}:${connection.generation}`}
            session={connection.session}
            scope={{
              viewer,
              communityOrigin: scope.slice(0, -(viewer.length + 1)),
            }}
            navigator={navigator}
            tabs={tabs}
            navigation={navigation}
          />
        ) : (
          <div data-buzz-ui="" className={styles.page}>
            <PanelHeader
              title={
                <PanelHeaderLabel
                  title="Activity"
                  icon={<BellIcon size="1rem" />}
                />
              }
            />
            <div className={styles.notice} role="status">
              <p className="text-body text-subtle">
                {connection.status === "connecting"
                  ? "Connecting to your activity…"
                  : connection.denied
                    ? // Its notice, on every page, offers what fixes it.
                      communityRefusalTitle(connection.refusal)
                    : (connection.error ??
                      "Choose a community to see your activity.")}
              </p>
              {connection.status === "error" && !connection.denied && (
                <Button onClick={relay.retry}>Retry connection</Button>
              )}
            </div>
          </div>
        )}
      </FullPageSurface>
    </div>
  );
}

type InboxViewProps = {
  session: RelaySession;
  scope: NavigationScope;
  navigator: Navigation;
  tabs?: InboxPageTabs | undefined;
  navigation?: PageNavigation | undefined;
};

const never = () => false;

/** The conversation list is Inbox's first tab; conversations open beside it. */
export function InboxView({ tabs: Tabs, ...props }: InboxViewProps) {
  const list = (
    open: (target: PageTabTarget) => boolean,
    close: (target: PageTabTarget) => boolean,
    isOpen: (target: PageTabTarget) => boolean,
  ) => <InboxList {...props} open={open} close={close} isOpen={isOpen} />;
  // Without the host tab workspace, rows have nowhere to open.
  if (!Tabs) return list(never, never, never);
  return (
    <Tabs
      id="inbox"
      session={props.session}
      scope={props.session.scope}
      label="Activity"
      icon={<BellIcon size="1rem" />}
      // Opening reveals a conversation; reading is earned as it is seen.
      visits={false}
    >
      {list}
    </Tabs>
  );
}

function InboxList({
  session,
  scope,
  navigator,
  navigation,
  open: openTab,
  close: closeTab,
  isOpen,
}: InboxViewProps & {
  open(target: PageTabTarget): boolean;
  close(target: PageTabTarget): boolean;
  isOpen(target: PageTabTarget): boolean;
}) {
  const previewId = useId();
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
  const reactionFeed = useSyncExternalStore(
    session.inboxFeed.reactions.subscribe,
    session.inboxFeed.reactions.snapshot,
  );
  const choices = useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
    session.agentChoices.snapshot,
  );
  const sync = useSyncExternalStore(
    session.unread.subscribeSync,
    session.unread.sync,
    session.unread.sync,
  );
  const viewScope = session.scope;
  const [filters, setFilters] = useState(() => readFilters(viewScope));
  const { activity, sender: senderFilter } = filters;
  const unreadOnly = filters.attention === "unread";
  // Each list returns to the session's last offset once its rows show,
  // unless the user has already scrolled it. The offset they chose wins,
  // unless the selected row they could see has since left the view.
  const scroller = useRef<HTMLDivElement | null>(null);
  const placed = useRef<HTMLDivElement | null>(null);
  function setFilter(patch: Partial<Filters>) {
    const next = {
      ...filters,
      ...patch,
      ...(patch.activity === "reactions" ? { attention: "all" as const } : {}),
    };
    setFilters(next);
    writeView(viewScope, filtersKey, next);
    // A filter change keeps the list's current offset. A mounted list stays
    // where it is, even empty at 0, rather than taking the saved offset when
    // rows show.
    placed.current = scroller.current;
  }
  // A shortcut's open carries filters; a plain open carries none and changes nothing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a new presentation applies its route; later filter edits are the user's.
  useEffect(() => {
    const route = routeOf(navigation?.target);
    // Back/Forward returns to the view as the user left it, not the opening filters.
    if (
      !navigation ||
      !route ||
      navigation.traversal ||
      appliedRoutes.has(navigation)
    )
      return;
    appliedRoutes.add(navigation);
    setFilter(route);
  }, [navigation]);
  const subscribeFilters = useCallback(
    (listener: () => void) => subscribeView(viewScope, listener),
    [viewScope],
  );
  const filtersRevision = useSyncExternalStore(subscribeFilters, () =>
    viewRevision(viewScope, filtersKey),
  );
  useEffect(() => {
    void filtersRevision;
    setFilters(readFilters(viewScope));
  }, [viewScope, filtersRevision]);
  // The tab a row opened, kept even after its row regroups.
  // Selection lasts as long as that tab.
  const [opened, setOpened] = useState(() => selections.get(session)?.opened);
  const openRow = (item: InboxItem, channel?: { channelType?: string }) => {
    const tab = tabTarget(item, channel);
    const shown = openTab(tab);
    setOpened(shown ? tab : undefined);
    return shown;
  };
  const showing = !!opened && isOpen(opened);
  const [selectedTarget, setSelectedTarget] = useState(
    () => selections.get(session)?.target,
  );
  useEffect(() => {
    selections.set(session, {
      ...selections.get(session),
      opened,
      target: selectedTarget,
    });
  }, [session, opened, selectedTarget]);
  const fallbackControl = useRef<HTMLButtonElement | null>(null);
  const focusToolbar = useCallback(
    () => fallbackControl.current?.focus({ preventScroll: true }),
    [],
  );
  // Row to focus after its predecessor leaves the list ("" means the toolbar).
  const focusRow = useRef<string | undefined>(undefined);
  const workspace = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const retryFocus = useRef(false);
  const retiredFocus = useRef(false);
  const retryButton = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    // Capture ownership before removal, not after focus has fallen to body.
    return () => {
      retryFocus.current = document.activeElement === button;
    };
  }, []);

  const [pending, setPending] = useState(false);
  const [refreshAfterRoster, setRefreshAfterRoster] = useState(false);
  const [error, setError] = useState<string>();
  const [menu, setMenu] = useState<{ id: string; anchor?: HTMLElement }>();
  const active = useRef(false);
  const busy = useRef(false);
  const failedMutation = useRef<
    | {
        work: () => Promise<unknown>;
        valid: () => boolean;
        onSuccess: (() => void) | undefined;
      }
    | undefined
  >(undefined);
  const intentRevision = useRef(0);
  const notify = useToastNotification();
  function cancelRetry() {
    intentRevision.current++;
    failedMutation.current = undefined;
    setError(undefined);
  }
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    // A completed discovery revision can retire an earlier feed attempt.
    void list.asOf;
    if (list.status !== "ready") return;
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
      session.agentChoices.ensure();
    }
  }, [session, list.status, list.asOf, refreshAfterRoster]);
  const items = inbox.items;
  const activityItems = items
    .map((item) => (activity === "mentions" ? item.mention : item))
    .filter(
      (item): item is InboxItem =>
        !!item &&
        matchesActivity(
          item,
          activity,
          list.channels.some(
            (channel) =>
              channel.id === item.channelId && channel.channelType === "dm",
          ),
        ),
    )
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  // A late verified root can legitimately regroup channel:reply into
  // channel:root. Keep the captured visit by exact key, never by a namesake.
  const selected = items.find(
    (item) =>
      !selectedTarget?.reaction &&
      item.channelId === selectedTarget?.channelId &&
      item.messageIds.includes(selectedTarget.messageId),
  );
  const selectedReaction = reactionFeed.items.find(
    (item) =>
      selectedTarget?.reaction &&
      item.message.id === selectedTarget?.messageId &&
      item.channelId === selectedTarget.channelId,
  );
  const selectedId =
    selected?.id ?? (selectedReaction ? selectedTarget?.reaction : undefined);
  // A room reclassified as a Huddle belongs to its Huddle composer, not Inbox.
  const selectedRetired = list.channels.some(
    (channel) =>
      channel.id === selectedTarget?.channelId &&
      (channel.archived || channel.huddle || channel.metadataPending),
  );
  useEffect(() => {
    if (
      selectedTarget &&
      (selectedRetired ||
        !showing ||
        (!selected && !selectedReaction && inbox.status !== "loading"))
    ) {
      // Restoring the channel does not reopen its conversation.
      if (selectedRetired && opened && closeTab(opened))
        retiredFocus.current = true;
      // A closed tab ends its visit, so reopening the row reads it again.
      if (selectedRetired || !showing) {
        intentRevision.current++;
        failedMutation.current = undefined;
        setError(undefined);
      }
      setSelectedTarget(undefined);
    }
  }, [
    selectedTarget,
    selected,
    selectedReaction,
    selectedRetired,
    showing,
    opened,
    closeTab,
    inbox.status,
  ]);
  useLayoutEffect(() => {
    if (!retiredFocus.current) return;
    retiredFocus.current = false;
    // Focus the retired tab held, removed or leaving with it, returns to the
    // filters; focus elsewhere stays.
    const focused = document.activeElement;
    if (
      !(focused instanceof HTMLElement) ||
      focused === document.body ||
      !focused.isConnected ||
      focused.closest('[inert], [hidden], [aria-hidden="true"]')
    )
      focusToolbar();
  });
  useEffect(() => {
    if (menu && !items.some((item) => item.id === menu.id)) setMenu(undefined);
  }, [items, menu]);
  // Enrich bounded activity candidates before applying Sender: unknown authors
  // must be able to appear after their profiles arrive, even in an empty view.
  // Keep main's bounded optional profile demand, independent of presentation.
  const candidateIds = [
    ...activityItems.slice(0, 50).map((item) => item.authorId),
    ...reactionFeed.items
      .slice(0, 50)
      .flatMap((item) => item.events.map((event) => event.pubkey)),
  ];
  const matchingAuthors = [...new Set(candidateIds)].sort().join(":");
  const authorIds = useMemo(
    () => (matchingAuthors ? matchingAuthors.split(":") : []),
    [matchingAuthors],
  );
  const cachedProfiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  // Classification covers every evaluated author, independently of bounded demand.
  // Winning events can change without changing folded display values.
  useSyncExternalStore(session.profiles.subscribe, () =>
    activityItems
      .map(({ authorId }) => session.profiles.event?.(authorId)?.id ?? "")
      .join(":"),
  );
  const agentIds = new Set(choices.identities.map((agent) => agent.pubkey));
  const senderKind = (authorId: string) => {
    if (agentIds.has(authorId) || cachedProfiles.get(authorId)?.isAgent)
      return "agent";
    // foldProfiles supplies a fallback for malformed kind 0; require a valid
    // signed, parsed object before treating absent agent hints as human display evidence.
    const event = session.profiles.event?.(authorId);
    if (event) {
      try {
        const body: unknown = JSON.parse(event.content);
        if (body !== null && typeof body === "object" && !Array.isArray(body))
          return "human";
      } catch {
        /* Missing or malformed profile is unknown. */
      }
    }
    return "unknown";
  };
  const visible = activityItems.filter(
    (item) =>
      (senderFilter === "everyone" ||
        senderKind(item.authorId) ===
          (senderFilter === "agents" ? "agent" : "human")) &&
      (!unreadOnly ||
        hasUnread(item) ||
        (item.id === selectedId &&
          item.messageIds.includes(selectedTarget?.messageId ?? ""))),
  );
  const reactionItems =
    !unreadOnly && (activity === "all" || activity === "reactions")
      ? reactionRows(
          reactionFeed.items,
          (authorId) =>
            senderFilter === "everyone" ||
            senderKind(authorId) ===
              (senderFilter === "agents" ? "agent" : "human"),
        )
      : [];
  const rows = [
    ...visible.map((item) => ({ kind: "conversation" as const, item })),
    ...reactionItems.map((item) => ({ kind: "reaction" as const, item })),
  ].sort(
    (a, b) =>
      b.item.createdAt - a.item.createdAt || a.item.id.localeCompare(b.item.id),
  );
  const listView = useRef(visible);
  // The view a read's success is judged against, not the one it was clicked in.
  const readView = useRef({ unreadOnly, selectedId });
  useLayoutEffect(() => {
    listView.current = visible;
    readView.current = { unreadOnly, selectedId };
  });
  useLayoutEffect(() => {
    const list = scroller.current;
    // A covered list skips layout: measuring it forces that layout, and
    // revealing a row in it scrolls nothing. It is placed on the commit that
    // uncovers it; what showed before it was covered still holds.
    if (!list || covered(list)) return;
    // Compositor scrolling may update the position before its scroll event.
    if (placed.current !== list && visible.length && list.scrollTop === 0) {
      const saved = selections.get(session);
      if (saved?.scrollTop) list.scrollTop = saved.scrollTop;
      if (saved?.selectedShown && selectedInView(list) === false)
        list
          .querySelector("li[data-selected]")
          ?.scrollIntoView({ block: "nearest" });
    }
    if (visible.length) placed.current = list;
    // Selecting a row, or rows arriving above it, moves nothing the scroll
    // handler sees, so record whether it shows after each commit too.
    const shown = selectedInView(list);
    if (typeof shown === "boolean")
      selections.set(session, {
        ...selections.get(session),
        selectedShown: shown,
      });
  });
  const profileKey = [
    ...new Set([
      ...authorIds,
      ...reactionItems.slice(0, 50).flatMap((item) =>
        rowProfileIds(
          {},
          list.channels.find((entry) => entry.id === item.channelId),
        ),
      ),
      ...visible.slice(0, 50).flatMap((item) =>
        rowProfileIds(
          item,
          list.channels.find((entry) => entry.id === item.channelId),
        ),
      ),
    ]),
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
    // A settled discovery revision can retire earlier optional profile reads.
    void list.asOf;
    void profileGeneration;
    if (profileIds.length && list.status === "ready")
      void session.profiles.ensure(profileIds, "background").catch(() => {});
  }, [session, profileIds, list.status, list.asOf, profileGeneration]);
  useLayoutEffect(() => {
    const id = focusRow.current;
    if (id === undefined || pending) return;
    focusRow.current = undefined;
    const row = [
      ...(workspace.current?.querySelectorAll<HTMLElement>(
        "li[data-inbox-row]",
      ) ?? []),
    ].find((entry) => entry.dataset.inboxRow === id);
    (
      row?.querySelector<HTMLElement>("button") ?? fallbackControl.current
    )?.focus({
      preventScroll: true,
    });
  });
  async function run(
    work: () => Promise<unknown>,
    valid?: () => boolean,
    onSuccess?: () => void,
    onFailure?: () => void,
  ) {
    if (!active.current || busy.current) return;
    busy.current = true;
    setPending(true);
    failedMutation.current = undefined;
    let succeeded = false;
    try {
      if (valid && !valid())
        throw new Error(
          "This action expired. Close and reopen the conversation.",
        );
      await work();
      succeeded = true;
      if (active.current) setError(undefined);
    } catch (cause) {
      if (active.current) {
        if (valid?.()) failedMutation.current = { work, valid, onSuccess };
        setError(
          cause instanceof Error
            ? cause.message
            : "That action failed. Try again.",
        );
        onFailure?.();
      }
    } finally {
      busy.current = false;
      if (active.current) setPending(false);
    }
    // Follow-up reads must run after the mutation releases the busy guard, on Retry too.
    if (succeeded && active.current) onSuccess?.();
  }
  function refresh(retrySync = false) {
    void run(async () => {
      if (list.status !== "ready") {
        setRefreshAfterRoster(true);
        session.channels.ensureList();
      } else {
        await Promise.all([
          session.unread.refresh(),
          session.inboxFeed.refresh(),
          session.inboxFeed.reactions.refresh(),
        ]);
      }
      if (retrySync && active.current) await session.unread.retrySync();
    });
  }
  /** The row to focus once this one leaves ("" for the filters), if it held focus. */
  function focusAfter(item: InboxItem): string | null {
    // The open conversation's composer and reader keep their own focus.
    const focused = document.activeElement;
    const row = [
      ...(workspace.current?.querySelectorAll<HTMLElement>(
        "li[data-inbox-row]",
      ) ?? []),
    ].find((entry) => entry.dataset.inboxRow === item.id);
    if (
      menu?.id !== item.id &&
      focused &&
      focused !== document.body &&
      !row?.contains(focused)
    )
      return null;
    const visible = listView.current;
    const index = visible.findIndex(
      (entry) =>
        entry.channelId === item.channelId &&
        (entry.id === item.id || entry.messageIds.includes(item.messageId)),
    );
    if (index < 0) return "";
    return (visible[index + 1] ?? visible[index - 1])?.id ?? "";
  }
  /** Under Unread the row leaves the list, so focus moves on and Undo is offered;
   * otherwise it only stops being bold and its ✓ goes, so focus stays on the
   * row. Whether it leaves is judged when the read lands, against the view
   * then; the open conversation always stays. A failed read keeps focus on
   * its row. */
  /** Whether focus is still the list's to move, read from the live DOM when the
   * read settles: nothing focused (the row or its ✓ left), or inside the list.
   * The row menu closes on choosing, returning focus to its row. Anywhere else,
   * such as the composer the user moved to while the read saved, keeps it. */
  function listOwnsFocus() {
    const focused = document.activeElement;
    if (!focused || focused === document.body) return true;
    return !!listRef.current?.contains(focused);
  }
  function markRead(item: InboxItem) {
    // Captured at click: the successor, if this row held focus.
    const held = focusAfter(item);
    mutate(
      item,
      false,
      () => {
        const view = readView.current;
        const leaves = view.unreadOnly && item.id !== view.selectedId;
        if (held != null && listOwnsFocus())
          focusRow.current = leaves ? held : item.id;
        if (!leaves) return;
        notify("Marked as read", "success", {
          label: "Undo",
          onClick: () => undoRead(item),
        });
      },
      () => {
        if (held != null && listOwnsFocus()) focusRow.current = item.id;
      },
    );
  }
  /** Undo outlives the page and the busy guard: unread again on this device
   * (saved read state is not rewound), on the same local path as Mark unread. */
  function undoRead(item: InboxItem) {
    void (async () => {
      try {
        await session.unread.markUnreadLocal(item.target);
      } catch {
        notify("Couldn't mark unread", "error");
      }
    })();
  }

  /** `threadId` is the thread an opened tab shows, which bounds a DM read. */
  function mutate(
    item: InboxItem,
    unread: boolean,
    onSuccess?: () => void,
    onFailure?: () => void,
    threadId?: string,
  ) {
    // An open menu is not authority: recheck the current session at action entry.
    if (
      !active.current ||
      busy.current ||
      session.unread.sync().capability !== "frontier-sync"
    )
      return;
    // Capture the admitted row and access evidence. Retry is explicit and cannot
    // reuse the intent after retargeting, access changes, or newer read/activity intent.
    const intent = ++intentRevision.current;
    const channel = session.channels
      .list()
      .channels.find((entry) => entry.id === item.channelId);
    const generation = session.unread.generation();
    const membership = channel?.members
      ? [...channel.members].sort().join(":")
      : undefined;
    let revision = session.unread.revision();
    const remaining = [...item.readThrough];
    const valid = () => {
      const current = session.channels
        .list()
        .channels.find((entry) => entry.id === item.channelId);
      return (
        active.current &&
        intentRevision.current === intent &&
        session.unread.sync().capability === "frontier-sync" &&
        !!channel &&
        !!current &&
        !current.cached &&
        (!current.readOnly || current.viewerRole === "guest") &&
        !current.archived &&
        current.channelType === channel.channelType &&
        !!current.members?.includes(scope.viewer) &&
        [...current.members].sort().join(":") === membership &&
        session.unread.generation() === generation &&
        session.unread
          .inbox()
          .items.some(
            (row) =>
              row.channelId === item.channelId &&
              row.messageIds.includes(item.messageId),
          ) &&
        session.unread.revision() === revision
      );
    };
    // Prepare once per click, not once per Retry: later arrivals are a new intent.
    let readChannel: (() => Promise<unknown>) | undefined;
    const work = async () => {
      if (unread) await session.unread.markUnreadLocal(item.target);
      else if (item.target.kind === "channel") {
        readChannel ??= session.unread.prepareChannelRead(
          item.channelId,
          threadId,
        );
        await readChannel();
      } else if (item.timeline)
        await session.unread.markTimelineRead(item.channelId, item.messageIds);
      else
        while (remaining.length) {
          // Close/Escape retires undispatched steps, not the admitted save.
          // Its genuine storage/access rejection still propagates through run.
          if (intentRevision.current !== intent) return;
          if (!valid())
            throw new Error(
              "This action expired. Close and reopen the conversation.",
            );
          const step = remaining[0];
          if (!step) break;
          await session.unread.markThrough(step.target, step.messageId);
          remaining.shift();
          revision = session.unread.revision();
        }
    };
    // An interrupted read (Close, Escape, a newer intent) does not continue.
    void run(
      work,
      valid,
      () => {
        if (intentRevision.current === intent) onSuccess?.();
      },
      onFailure,
    );
  }
  function retry() {
    // Keep source errors mounted too while their refresh clears live evidence.
    setError(failure);
    const mutation = failedMutation.current;
    if (mutation) {
      void run(mutation.work, mutation.valid, mutation.onSuccess);
      return;
    }
    refresh(true);
  }
  const canRead = sync.capability === "frontier-sync";
  const loading =
    reactionFeed.status === "loading" ||
    list.status === "idle" ||
    list.status === "loading" ||
    inbox.status === "loading" ||
    feed.status === "loading";
  const failure =
    reactionFeed.error ??
    error ??
    list.error ??
    inbox.error ??
    feed.error ??
    sync.error;
  useLayoutEffect(() => {
    if (!retryFocus.current) return;
    retryFocus.current = false;
    if (failure || pending || document.activeElement !== document.body) return;
    focusToolbar();
  }, [failure, pending, focusToolbar]);
  const filtered =
    activity !== "all" || senderFilter !== "everyone" || unreadOnly;
  // Nothing unread anywhere: say so, rather than suggest a filter hid it.
  // Only when the list is complete: both sources ready and nothing retained.
  const caughtUp =
    unreadOnly &&
    activity === "all" &&
    senderFilter === "everyone" &&
    inbox.status === "ready" &&
    feed.status === "ready" &&
    inbox.freshness !== "stale";
  const toolbar = (
    <header className={styles.toolbar}>
      <InboxFilters
        view={activity}
        sender={senderFilter}
        unreadOnly={unreadOnly}
        triggerRef={fallbackControl}
        onViewChange={(view) => setFilter({ activity: view })}
        onSenderChange={(sender) => setFilter({ sender })}
        onUnreadChange={(checked) =>
          setFilter({ attention: checked ? "unread" : "all" })
        }
        status={
          <div className={styles.refreshSlot}>
            {loading && (
              <span
                className={`${styles.refreshStatus} text-caption text-subtle`}
                role="status"
              >
                Checking recent activity…
              </span>
            )}
          </div>
        }
      />
    </header>
  );
  return (
    <div data-buzz-ui="" className={styles.page}>
      {failure && (
        <div className={styles.notice} role="alert">
          <p className="text-body">{failure}</p>
          <Button ref={retryButton} size="sm" loading={pending} onClick={retry}>
            Retry activity
          </Button>
        </div>
      )}
      <div ref={workspace} className={styles.workspace}>
        <div className={styles.listPane}>
          {toolbar}
          <div
            ref={scroller}
            className={styles.scroll}
            onScroll={(event) => {
              // Saved as it moves, so any teardown keeps the last offset.
              // Rows arriving above a covered list can still anchor it,
              // which saves only the offset.
              const list = event.currentTarget;
              selections.set(session, {
                ...selections.get(session),
                scrollTop: list.scrollTop,
                ...(!covered(list) && {
                  selectedShown: selectedInView(list),
                }),
              });
            }}
          >
            {inbox.freshness === "stale" && !failure && (
              <div className={styles.notice} role="status">
                <span className="text-body text-subtle">
                  Showing retained activity.
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={pending}
                  onClick={() => refresh()}
                >
                  Refresh
                </Button>
              </div>
            )}
            {(inbox.status === "idle" || feed.status === "idle") &&
              !loading &&
              !failure && (
                <div className={styles.notice} role="status">
                  <span className="text-body text-subtle">
                    Check recent activity.
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={pending}
                    onClick={() => refresh()}
                  >
                    Refresh
                  </Button>
                </div>
              )}
            {!rows.length &&
              (inbox.status === "ready" || feed.status === "ready") &&
              !loading &&
              !failure && (
                <div className={styles.empty} role="status">
                  <EmptyState
                    icon={caughtUp ? <CheckIcon /> : <BellIcon />}
                    title={
                      activity === "reactions" && senderFilter === "everyone"
                        ? "No reactions yet."
                        : caughtUp
                          ? "All caught up"
                          : unreadOnly
                            ? "No unread activity in this view"
                            : "No recent activity in this view"
                    }
                    description={
                      activity === "reactions"
                        ? "When someone reacts to your messages, you’ll see it here."
                        : caughtUp
                          ? "New replies, mentions and DMs show up here."
                          : "Mentions, direct messages, and replies in threads you participate in appear here."
                    }
                    action={
                      filtered ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setFilter(
                              caughtUp
                                ? { attention: "all" }
                                : {
                                    activity: "all",
                                    sender: "everyone",
                                    attention: "all",
                                  },
                            );
                            focusToolbar();
                          }}
                        >
                          {caughtUp ? "Show all" : "Clear filters"}
                        </Button>
                      ) : undefined
                    }
                  />
                </div>
              )}
            <ul
              ref={listRef}
              className={styles.list}
              aria-label="Activity"
              aria-busy={pending}
            >
              {rows.map((row) => {
                if (row.kind === "reaction") {
                  const item = row.item;
                  return (
                    <li
                      key={item.id}
                      className={styles.row}
                      data-inbox-row={item.id}
                    >
                      <ReactionRowButton
                        item={item}
                        session={session}
                        profiles={profiles}
                        name={name}
                        channel={list.channels.find(
                          (channel) => channel.id === item.channelId,
                        )}
                        selected={selectedId === item.id}
                        onClick={() => {
                          const target: PageTabTarget = {
                            ...tabTarget(
                              {
                                channelId: item.channelId,
                                messageId: item.message.id,
                                ...(item.message.threadRootId && {
                                  rootId: item.message.threadRootId,
                                }),
                                thread: !!item.message.threadRootId,
                              },
                              list.channels.find(
                                (channel) => channel.id === item.channelId,
                              ),
                            ),
                            messageId: item.message.id,
                          };
                          const shown = openTab(target);
                          setOpened(shown ? target : undefined);
                          cancelRetry();
                          setSelectedTarget({
                            channelId: item.channelId,
                            messageId: item.message.id,
                            reaction: item.id,
                          });
                          if (!shown)
                            void navigator.open({
                              version: 1,
                              kind: "conversation",
                              scope,
                              channelId: item.channelId,
                              messageId: item.message.id,
                              ...(item.message.threadRootId
                                ? { threadRootId: item.message.threadRootId }
                                : {}),
                            });
                        }}
                      />
                    </li>
                  );
                }
                const item = row.item;
                const channel = list.channels.find(
                  (candidate) => candidate.id === item.channelId,
                );
                const identity = rowIdentity(item, channel, profiles, name);
                const { sender, context } = identity;
                const unread = hasUnread(item);
                const readable = unread && canRead;
                return (
                  <li
                    key={item.id}
                    data-inbox-row={item.id}
                    className={styles.row}
                    data-unread={unread || undefined}
                    data-action={readable || undefined}
                    data-selected={selectedId === item.id || undefined}
                  >
                    <ContextMenuRoot
                      open={menu?.id === item.id}
                      onOpenChange={(open) =>
                        setMenu(open ? { id: item.id } : undefined)
                      }
                    >
                      <ContextMenuTrigger
                        render={<div className={styles.rowSurface} />}
                        onKeyDown={(event) => {
                          if (
                            event.key === "ContextMenu" ||
                            (event.shiftKey && event.key === "F10")
                          ) {
                            event.preventDefault();
                            setMenu({
                              id: item.id,
                              anchor: event.target as HTMLElement,
                            });
                          }
                        }}
                      >
                        <InboxRowButton
                          item={item}
                          identity={identity}
                          media={session.media}
                          feed={feed}
                          time={relativeTimestamp(item.createdAt)}
                          previewId={`${previewId}-${item.id}`}
                          disabled={pending}
                          selected={selectedId === item.id}
                          onClick={() => {
                            if (busy.current) return;
                            // The selected row reveals its current message in
                            // its captured tab, even after regrouping or
                            // reading would open a whole conversation as a
                            // thread. A captured thread follows the row,
                            // which may now open whole.
                            const reselect =
                              selectedId === item.id &&
                              opened &&
                              !opened.threadId &&
                              tabTarget(item, channel).threadId
                                ? opened
                                : undefined;
                            if (
                              reselect
                                ? !openTab(reselect)
                                : !openRow(item, channel)
                            )
                              void navigator.open({
                                version: 1,
                                kind: "conversation",
                                scope,
                                channelId: item.channelId,
                                messageId: item.messageId,
                                ...(item.rootId && {
                                  threadRootId: item.rootId,
                                }),
                              });
                            // The selected row is the same visit, even when its
                            // current representative changed after reading.
                            if (selectedId === item.id) return;
                            cancelRetry();
                            setSelectedTarget(targetOf(item));
                            if (unread && canRead)
                              mutate(
                                item,
                                false,
                                undefined,
                                undefined,
                                tabTarget(item, channel).threadId,
                              );
                          }}
                        />
                        {readable && (
                          <span className={styles.rowAction}>
                            <IconButton
                              size="sm"
                              variant="ghost"
                              disabled={pending}
                              aria-label={`Mark as read ${sender} in ${context}`}
                              title="Mark as read"
                              onClick={() => markRead(item)}
                              icon={<CheckIcon size={16} aria-hidden="true" />}
                            />
                          </span>
                        )}
                      </ContextMenuTrigger>
                      <MenuPopup
                        size="compact"
                        aria-label={`Actions for ${sender} in ${context}`}
                        anchor={menu?.id === item.id ? menu.anchor : undefined}
                      >
                        <MenuItem
                          disabled={pending || !unread || !canRead}
                          onClick={() => markRead(item)}
                        >
                          Mark as read
                        </MenuItem>
                        <MenuItem
                          disabled={pending || unread || !canRead}
                          onClick={() => mutate(item, true)}
                        >
                          Mark unread
                        </MenuItem>
                      </MenuPopup>
                    </ContextMenuRoot>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
