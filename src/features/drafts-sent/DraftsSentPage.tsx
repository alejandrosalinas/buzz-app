import { DraftPreview } from "./DraftPreview";
import type { ConversationHostServices } from "../conversation/ConversationHost";
import type { ConversationExtensions } from "../conversation/contracts";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { PageNavigation } from "../navigation/service";
import { PanelFrame } from "../panels/PanelFrame";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import { messageAuthor } from "../../features/relay/fold";
import type { Navigation } from "../../features/navigation/controller";
import { useIdentityNames } from "../../features/identity-names/react";
import { channelIcon } from "../channels/channel-icon";
import { avatarMedia } from "../../shared/avatar-source";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import {
  ArrowsClockwiseIcon,
  MessageReplyIcon,
  SendIcon,
  CheckIcon,
  TrashIcon,
} from "../../shared/design-system/icons/index";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { NavigationCard } from "../../shared/design-system/ui/NavigationItem";
import { MessageListRow } from "../messages/MessageListRow";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { readView, writeView } from "../../shared/view-state";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import {
  DELETION_KINDS,
  activityOf,
  contextFilters,
  indexContext,
  shapeOf,
  type Activity,
  type Shape,
} from "./context";
import { clearDraft, useDrafts } from "./drafts";
import {
  SENT_LIMIT,
  clockTime,
  dayLabel,
  fullTime,
  matches,
  preview,
  sentEntries,
  type Entry,
} from "./model";
import { listed, scopeOf } from "./scope";
import { useActivity, useDeletions, useSent } from "./views";
import styles from "./DraftsSent.module.css";

/** Labels change by the minute, so half a minute keeps them current. */
const TICK_MS = 30_000;
type Place = {
  title: string;
  kind: "channel" | "dm" | "solo" | "unknown";
  /** Everyone else in a DM or Solo chat. */
  members: readonly string[];
  available: boolean;
};
type Status = {
  tone: "new" | "last" | "quiet";
  icon?: "reply" | "check";
  label: string;
  detail: string;
};
type Row = {
  entry: Entry;
  place: Place;
  shape: Shape;
  activity?: Activity | undefined;
  status?: Status | undefined;
  placeholder?: boolean | undefined;
};

/** The conversation a row's status is read from: its thread, its DM or Solo chat, or its post's replies. */
const conversationOf = ({ entry, shape }: { entry: Entry; shape: Shape }) =>
  shape === "thread"
    ? (entry.threadRootId ?? entry.id)
    : shape === "room"
      ? entry.channelId
      : entry.id;
const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function DraftsSentPage({
  relay,
  navigator,
  navigation,
  companion,
  panels,
  extensions,
}: {
  relay: RelayData;
  navigator: Navigation;
  navigation?: PageNavigation | undefined;
  companion?: ReactNode;
  panels: ConversationHostServices["panels"];
  extensions?: ConversationExtensions | undefined;
}) {
  const connection = useRelayConnection(relay);
  const scope = scopeOf(connection);
  useEffect(() => {
    navigation?.complete({ status: "opened" });
  }, [navigation]);
  return (
    <PanelFrame scope={connection.scope} companion={companion}>
      <FullPageSurface aria-label="Drafts & sent">
        {connection.status === "ready" && scope ? (
          <ScopedPage
            key={`${connection.generation}:${connection.scope}`}
            session={connection.session}
            viewer={scope.viewer}
            origin={scope.communityOrigin}
            navigator={navigator}
            host={{ relay, navigation: navigator, panels }}
            extensions={extensions}
          />
        ) : (
          <div data-buzz-ui="" className={styles.page}>
            <Header />
            <div className={styles.sections}>
              <EmptyState
                icon={<SendIcon size={24} />}
                title="Choose a community"
                description="Your drafts and sent messages appear once a community is selected."
              />
            </div>
          </div>
        )}
      </FullPageSurface>
    </PanelFrame>
  );
}

function Header({ actions }: { actions?: React.ReactNode }) {
  return (
    <PanelHeader
      title={
        <PanelHeaderLabel
          title="Drafts & sent"
          icon={<SendIcon size="1rem" />}
        />
      }
      actions={actions}
    />
  );
}

function ScopedPage({
  session,
  viewer,
  origin,
  navigator,
  host,
  extensions,
}: {
  session: RelaySession;
  viewer: string;
  origin: string;
  navigator: Navigation;
  host: ConversationHostServices;
  extensions?: ConversationExtensions | undefined;
}) {
  type Visit = {
    entry: Entry;
    draft: boolean;
    trigger: HTMLButtonElement;
    autoFocus: boolean;
  };
  const [selected, setSelected] = useState<Visit>();
  const visit = useRef<Visit | undefined>(undefined);
  const focusAfterClose = useRef<HTMLElement | null>(null);
  const selectedIndex = useRef(0);
  const neighborAfterClose = useRef<HTMLElement | null>(null);
  const [announcement, setAnnouncement] = useState("");
  useLayoutEffect(() => {
    if (!selected && focusAfterClose.current) {
      const target = focusAfterClose.current;
      focusAfterClose.current = null;
      (target.isConnected
        ? target
        : neighborAfterClose.current?.isConnected
          ? neighborAfterClose.current
          : searchInput.current
      )?.focus();
      neighborAfterClose.current = null;
    }
  }, [selected]);
  const drafts = useDrafts(session);
  const { channels, status: channelListStatus } = useChannelList(
    session.channels,
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const resolveName = useIdentityNames(session.names);
  const now = useNow();
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"drafts" | "sent">(() =>
    readView<unknown>(session.scope, "drafts-sent-tab", "drafts") === "sent"
      ? "sent"
      : "drafts",
  );
  const [notice, setNotice] = useState<string>();
  const searchInput = useRef<HTMLInputElement>(null);
  const { sent, refresh: refreshSent } = useSent(session, viewer);

  const byId = useMemo(
    () => new Map(channels.map((channel) => [channel.id, channel])),
    [channels],
  );
  const selectedExcluded =
    selected && !listed(byId.get(selected.entry.channelId));
  useLayoutEffect(() => {
    if (!selectedExcluded) return;
    visit.current = undefined;
    focusAfterClose.current = searchInput.current;
    setSelected(undefined);
  }, [selectedExcluded]);
  const isRoom = (id: string) =>
    ["dm", "solo"].includes(byId.get(id)?.channelType ?? "");
  const nameOf = (key: string, candidates?: readonly string[]) =>
    key === viewer
      ? "You"
      : resolveName(
          key,
          profiles.get(key)?.name || "Unknown person",
          candidates,
        );

  function place(channelId: string): Place {
    const channel = byId.get(channelId);
    if (!channel)
      return {
        title: "Unavailable conversation",
        kind: "unknown",
        members: [],
        available: false,
      };
    const available = !channel.cached && !channel.pending;
    const members = [
      ...new Set([...(channel.participants ?? []), ...(channel.members ?? [])]),
    ].filter((key) => key !== viewer);
    if (channel.channelType === "dm") {
      if (!members.length)
        return {
          title: "Notes to self",
          kind: "dm",
          members,
          available,
        };
      const names = members.map((key) => nameOf(key, members));
      return {
        title:
          names.slice(0, 3).join(", ") +
          (names.length > 3 ? ` +${names.length - 3}` : ""),
        kind: "dm",
        members,
        available,
      };
    }
    if (channel.channelType === "solo")
      return { title: channel.name, kind: "solo", members, available };
    return {
      title: channel.private ? channel.name : `#${channel.name}`,
      kind: "channel",
      members: [],
      available,
    };
  }

  // Keep an emptied editor in its last list position until it is closed.
  const currentIndex = selected?.draft
    ? drafts.entries.findIndex((entry) => entry.id === selected.entry.id)
    : -1;
  useLayoutEffect(() => {
    if (currentIndex >= 0) selectedIndex.current = currentIndex;
  }, [currentIndex]);
  const entries: (Entry & { placeholder?: boolean })[] = [...drafts.entries];
  if (selected?.draft && currentIndex < 0)
    entries.splice(selectedIndex.current, 0, {
      ...selected.entry,
      text: "Empty draft",
      placeholder: true,
    });
  const shownDrafts = entries.filter((entry) =>
    listed(byId.get(entry.channelId)),
  );
  const sentList = useMemo(
    () =>
      sentEntries(sent.events, viewer).filter(
        (entry) =>
          byId.has(entry.channelId) && listed(byId.get(entry.channelId)),
      ),
    [sent.events, viewer, byId],
  );

  const { threads, rooms } = contextFilters(
    [...sentList, ...shownDrafts.filter((entry) => entry.threadRootId)],
    isRoom,
  );
  const context = useActivity(session, threads, rooms);
  // Others' messages, newest first, so a cap on deletion reads drops the oldest. Yours,
  // including ones the relay signed for you, are covered by your own deletions below.
  const othersKey = useMemo(
    () =>
      [
        ...new Map(
          context.events
            .filter(
              (event) => messageAuthor(event, session.relayAuthor) !== viewer,
            )
            .map((event) => [event.id, event]),
        ).values(),
      ]
        .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
        .map((event) => event.id)
        .join(","),
    [context.events, viewer, session],
  );
  const { deletions, refresh: refreshDeletions } = useDeletions(
    session,
    useMemo(() => (othersKey ? othersKey.split(",") : []), [othersKey]),
  );
  // Your own deletions come with Sent: a reply you deleted stops counting in its post's thread too.
  const ownDeletions = useMemo(
    () =>
      sent.events.filter(
        (event) =>
          event.pubkey === viewer && DELETION_KINDS.includes(event.kind),
      ),
    [sent.events, viewer],
  );
  const index = useMemo(
    () =>
      indexContext(
        context.events,
        [...deletions, ...ownDeletions],
        session.relayAuthor,
      ),
    [context.events, deletions, ownDeletions, session],
  );

  function status(row: Row, newest: boolean): Status | undefined {
    const { activity, shape, entry } = row;
    if (!activity) return undefined;
    // Only from a complete read of this conversation: no evidence, no status.
    const floor = context.ready.get(conversationOf(row));
    if (floor === undefined) return undefined;
    // The read is complete back to its floor. Before it, there may be more than it shows:
    // a count is a minimum, and "You're last" can't be known.
    const complete = entry.createdAt !== undefined && entry.createdAt > floor;
    const latest = activity.after[activity.after.length - 1];
    const from = latest
      ? `latest from ${nameOf(latest.author)}, ${relativeTimestamp(latest.created_at, now / 1000)}`
      : "";
    if (shape === "post") {
      if (!activity.replies) return undefined;
      const label = complete
        ? plural(activity.replies, "reply").replace("replys", "replies")
        : `${activity.replies}+ replies`;
      // The count stays, but your newer reply in its thread settles whether it's waiting on you.
      return {
        tone: newest && activity.after.length ? "new" : "quiet",
        icon: "reply",
        label,
        detail: from ? `${label}, ${from}` : label,
      };
    }
    // Older messages in a conversation you posted in again are settled by the newer one.
    if (!newest) return undefined;
    const word = shape === "thread" ? "reply" : "message";
    const words = shape === "thread" ? "replies" : "messages";
    const count = activity.after.length;
    if (!count)
      return complete
        ? {
            tone: "last",
            icon: "check",
            label: "You’re last",
            detail: `No ${words} after yours`,
          }
        : undefined;
    const shown = count > 99 ? "99+" : complete ? String(count) : `${count}+`;
    return {
      tone: "new",
      label: `${shown} after you`,
      detail: `${complete ? count : `At least ${count}`} ${count === 1 && complete ? word : words} after yours, ${from}`,
    };
  }

  const draftRows: Row[] = shownDrafts.map((entry) => {
    const where = place(entry.channelId);
    const shape = shapeOf(entry, isRoom(entry.channelId));
    // A draft has no send time: others' messages never count as "after" it.
    const { createdAt: _, ...unsent } = entry;
    return {
      entry,
      place: where,
      shape,
      placeholder: "placeholder" in entry ? entry.placeholder : undefined,
      activity:
        shape === "post"
          ? undefined
          : activityOf(unsent, shape, index, viewer, where.members),
    };
  });
  const seen = new Set<string>();
  const sentRows: Row[] = sentList.map((entry) => {
    const where = place(entry.channelId);
    const shape = shapeOf(entry, isRoom(entry.channelId));
    const row: Row = {
      entry,
      place: where,
      shape,
      activity: activityOf(entry, shape, index, viewer, where.members),
    };
    const conversation = conversationOf(row);
    row.status = status(row, !seen.has(conversation));
    seen.add(conversation);
    return row;
  });
  // Everyone shown in a row, so their names and pictures load.
  const people = new Set<string>();
  for (const row of [...draftRows, ...sentRows])
    for (const key of row.activity?.people.slice(0, 4) ??
      row.place.members.slice(0, 3))
      people.add(key);
  const missing = [...people]
    .sort()
    .filter((key) => !profiles.has(key))
    .slice(0, 200)
    .join(",");
  useEffect(() => {
    if (missing)
      void session.profiles.ensure(missing.split(",")).catch(() => {});
  }, [session, missing]);

  const text = (row: Row) =>
    row.placeholder ? row.entry.text : preview(row.entry.text, "Attachment");
  const visibleDrafts = draftRows.filter((row) =>
    matches(text(row), row.place.title, search),
  );
  const visibleSent = sentRows.filter((row) =>
    matches(text(row), row.place.title, search),
  );
  const sentLoading =
    (sent.status === "loading" || sent.status === "idle") &&
    !sent.events.length;

  async function open(entry: Entry, draft: boolean) {
    setNotice(undefined);
    try {
      const result = await navigator.open({
        version: 1,
        kind: "conversation",
        scope: { viewer, communityOrigin: origin },
        channelId: entry.channelId,
        ...(entry.threadRootId ? { threadRootId: entry.threadRootId } : {}),
        ...(draft
          ? entry.threadRootId
            ? { messageId: entry.threadRootId }
            : {}
          : { messageId: entry.id }),
      });
      if (result.status === "failed")
        setNotice(
          "This conversation could not be opened. It may have been removed, or your access may have changed.",
        );
    } catch {
      setNotice("This conversation could not be opened. Try again.");
    }
  }

  function closePreview(current: Visit, sent = false, restoreFocus = true) {
    if (visit.current !== current) return;
    const row = current.trigger.closest("li");
    const neighbor = (
      row?.nextElementSibling ?? row?.previousElementSibling
    )?.querySelector<HTMLElement>("[data-preview-row]");
    neighborAfterClose.current = restoreFocus ? (neighbor ?? null) : null;
    focusAfterClose.current = !restoreFocus
      ? null
      : !sent && current.trigger.isConnected
        ? current.trigger
        : (neighbor ?? searchInput.current);
    visit.current = undefined;
    setSelected(undefined);
    if (sent)
      setAnnouncement(`Sent to ${place(current.entry.channelId).title}.`);
  }

  /** Clears one draft and keeps keyboard focus in the list: the next row's clear
   * action, else the previous one's, else search. */
  function clear(entry: Entry, button: HTMLElement) {
    setNotice(undefined);
    const row = button.closest("li");
    const neighbor = (
      row?.nextElementSibling ?? row?.previousElementSibling
    )?.querySelector<HTMLElement>("[data-clear-draft]");
    try {
      clearDraft(session, entry.id);
    } catch {
      setNotice("This draft could not be cleared. Try again.");
      return;
    }
    if (visit.current?.entry.id === entry.id) {
      visit.current = undefined;
      setSelected(undefined);
      focusAfterClose.current = neighbor ?? searchInput.current;
    }
    (neighbor ?? searchInput.current)?.focus();
  }

  function row(item: Row, draft: boolean) {
    const { entry, place, status } = item;
    const destinationIcon = place.kind !== "dm";
    const person = place.kind === "dm" ? (place.members[0] ?? viewer) : viewer;
    const profile = profiles.get(person);
    const Icon = channelIcon(byId.get(entry.channelId));
    const context = entry.threadRootId ? "· Thread" : undefined;
    const line = text(item);
    const time = entry.createdAt
      ? draft
        ? relativeTimestamp(entry.createdAt, now / 1000)
        : clockTime(entry.createdAt)
      : "";
    const where = `${place.title}${entry.threadRootId ? ", thread" : ""}`;
    const label = [
      `${draft ? "Continue draft" : "View message"} in ${where}: ${line}`,
      status?.detail,
    ]
      .filter(Boolean)
      .join(". ");
    const destination = (
      <MessageListRow
        aria-label={label}
        disabled={!draft && !place.available}
        selected={selected?.entry.id === entry.id}
        aria-current={selected?.entry.id === entry.id ? "true" : undefined}
        data-preview-row=""
        title={
          draft || place.available
            ? undefined
            : "This conversation is not available right now"
        }
        onClick={(event) => {
          if (visit.current?.entry.id === entry.id) return;
          const next = {
            entry,
            draft,
            trigger: event.currentTarget,
            autoFocus:
              (event.nativeEvent as PointerEvent).pointerType !== "touch",
          };
          selectedIndex.current = drafts.entries.findIndex(
            (draft) => draft.id === entry.id,
          );
          visit.current = next;
          setSelected(next);
          setAnnouncement("");
          setNotice(undefined);
        }}
        avatar={
          <Avatar
            size="fill"
            alt=""
            fallback={place.title}
            src={
              destinationIcon
                ? undefined
                : avatarMedia(profile?.picture, session.media)
            }
            fallbackContent={destinationIcon ? <Icon size={16} /> : undefined}
            shape={destinationIcon || profile?.isAgent ? "squircle" : "circle"}
          />
        }
        sender={<span className={styles.destinationName}>{place.title}</span>}
        source={context}
        time={
          <span className={styles.rowMeta}>
            <span className={styles.deliveryMeta}>
              {status && (
                <span
                  className={`text-caption ${styles.pill}`}
                  data-tone={status.tone}
                  title={status.detail}
                >
                  {status.icon === "reply" ? (
                    <MessageReplyIcon size={12} />
                  ) : status.icon === "check" ? (
                    <CheckIcon size={12} />
                  ) : (
                    <span className={styles.dot} />
                  )}
                  {status.label}
                </span>
              )}
              {time && entry.createdAt !== undefined && (
                <time
                  dateTime={new Date(entry.createdAt * 1000).toISOString()}
                  title={fullTime(entry.createdAt)}
                >
                  {time}
                </time>
              )}
            </span>
          </span>
        }
        preview={line}
      />
    );
    return (
      <li className={styles.row} key={entry.id}>
        {draft ? (
          <NavigationCard>
            {destination}
            <span className={styles.clear}>
              <IconButton
                variant="bare"
                icon={<TrashIcon size={16} aria-hidden="true" />}
                aria-label={`Clear draft in ${where}: ${line}`}
                title="Clear draft"
                data-clear-draft=""
                onClick={(event) => clear(entry, event.currentTarget)}
              />
            </span>
          </NavigationCard>
        ) : (
          destination
        )}
      </li>
    );
  }

  const groups: { label: string; rows: Row[] }[] = [];
  for (const item of visibleSent) {
    const label = dayLabel(item.entry.createdAt ?? 0, now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.rows.push(item);
    else groups.push({ label, rows: [item] });
  }
  const refresh = () => {
    session.channels.refreshList?.();
    refreshSent.current();
    context.refresh.current();
    refreshDeletions.current();
  };

  const previewPanel =
    selected && !selectedExcluded ? (
      <DraftPreview
        key={selected.entry.id}
        entry={selected.entry}
        mode={selected.draft ? "draft" : "sent"}
        title={place(selected.entry.channelId).title}
        channel={byId.get(selected.entry.channelId)}
        session={session}
        host={host}
        extensions={extensions}
        autoFocus={selected.autoFocus}
        onClose={() => closePreview(selected)}
        onOpen={() => void open(selected.entry, selected.draft)}
        loading={
          !byId.get(selected.entry.channelId) &&
          (channelListStatus === "idle" || channelListStatus === "loading")
        }
        onSaved={(restoreFocus) => closePreview(selected, true, restoreFocus)}
      />
    ) : null;

  const searchField = (
    <div className={styles.toolbar}>
      <SearchField
        variant="default"
        value={search}
        onValueChange={setSearch}
        label="Search drafts and sent messages"
        placeholder="Search drafts and sent messages"
        inputRef={searchInput}
      />
    </div>
  );

  return (
    <div data-buzz-ui="" className={styles.page}>
      <Header
        actions={
          <IconButton
            icon={<ArrowsClockwiseIcon size={16} />}
            aria-label="Refresh"
            title="Refresh"
            disabled={sent.status === "loading"}
            onClick={refresh}
          />
        }
      />
      <div className={styles.tabsToolbar}>
        <div className={styles.typeTabs}>
          <Tabs
            label="Drafts and sent"
            variant="panel"
            size="sm"
            value={view}
            items={[
              {
                value: "drafts",
                label: "Drafts",
                panelId: "drafts-view",
                trailing: shownDrafts.length ? (
                  <span className="text-caption text-subtle">
                    {shownDrafts.length}
                  </span>
                ) : undefined,
              },
              { value: "sent", label: "Sent", panelId: "sent-view" },
            ]}
            onValueChange={(next) => {
              visit.current = undefined;
              setSelected(undefined);
              setView(next);
              writeView(session.scope, "drafts-sent-tab", next);
            }}
          />
        </div>
      </div>
      {notice && (
        <p role="alert" className={styles.notice}>
          {notice}
        </p>
      )}
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <div className={styles.sections}>
        <section
          role="tabpanel"
          id="drafts-view"
          aria-labelledby="drafts-view-tab"
          hidden={view !== "drafts"}
          className={styles.draftWorkspace}
          data-selected={!!selected || undefined}
        >
          <div className={styles.draftList}>
            {view === "drafts" && searchField}
            <div className={styles.section}>
              {drafts.unavailable && (
                <p
                  role="alert"
                  className={`text-body-sm text-subtle ${styles.sectionCopy}`}
                >
                  Some saved drafts could not be read. They are unchanged.
                </p>
              )}
              {visibleDrafts.length ? (
                <ul className={styles.list} aria-label="Drafts">
                  {visibleDrafts.map((item) => row(item, true))}
                </ul>
              ) : (
                <EmptyState
                  icon={<SendIcon size={24} />}
                  title={
                    search ? `No drafts match “${search.trim()}”.` : "No drafts"
                  }
                  description={
                    search
                      ? undefined
                      : "Messages you start and don’t send wait here."
                  }
                  action={
                    search ? (
                      <Button
                        size="sm"
                        onClick={() => {
                          setSearch("");
                          searchInput.current?.focus();
                        }}
                      >
                        Clear search
                      </Button>
                    ) : undefined
                  }
                />
              )}
              {drafts.limited && (
                <p className={`text-caption text-subtle ${styles.sectionCopy}`}>
                  Showing 500 drafts.
                </p>
              )}
            </div>
          </div>
          {view === "drafts" && previewPanel}
        </section>
        <section
          role="tabpanel"
          data-selected={!!selected || undefined}
          id="sent-view"
          aria-labelledby="sent-view-tab"
          hidden={view !== "sent"}
          className={styles.draftWorkspace}
        >
          <div className={styles.draftList}>
            {view === "sent" && searchField}
            <div className={styles.section}>
              {sent.status === "error" && (
                <div
                  role="alert"
                  className={`${styles.notice} ${styles.sectionCopy}`}
                >
                  <p>Sent messages could not be loaded.</p>
                  <Button size="sm" onClick={() => refreshSent.current()}>
                    Retry
                  </Button>
                </div>
              )}
              <LoadingRegion
                pending={sentLoading}
                label="Loading sent messages…"
                statusVisibility={
                  sentLoading && !groups.length ? "visible" : "screen-reader"
                }
              >
                {groups.length ? (
                  groups.map((group) => (
                    <section
                      key={group.label}
                      aria-label={group.label}
                      className={styles.dayGroup}
                    >
                      <h3 className={`text-caption text-subtle ${styles.day}`}>
                        {group.label}
                      </h3>
                      <ul className={styles.list}>
                        {group.rows.map((item) => row(item, false))}
                      </ul>
                    </section>
                  ))
                ) : sentLoading || sent.status === "error" ? null : search ? (
                  <EmptyState
                    icon={<SendIcon size={24} />}
                    title={`No sent messages match “${search.trim()}”`}
                    description={`Search covers your latest ${SENT_LIMIT} messages.`}
                    action={
                      <Button
                        size="sm"
                        onClick={() => {
                          setSearch("");
                          searchInput.current?.focus();
                        }}
                      >
                        Clear search
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState
                    icon={<SendIcon size={24} />}
                    title="Nothing sent yet"
                    description="Messages you send in this community show up here."
                  />
                )}
              </LoadingRegion>
              {sentRows.length >= SENT_LIMIT && (
                <p className={`text-caption text-subtle ${styles.sectionCopy}`}>
                  Showing your latest {SENT_LIMIT} messages.
                </p>
              )}
            </div>
          </div>
          {view === "sent" && previewPanel}
        </section>
      </div>
    </div>
  );
}
