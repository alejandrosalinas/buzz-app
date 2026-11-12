// biome-ignore-all lint/a11y/noNoninteractiveTabindex: The history region must support keyboard scrolling.
import { AgentConnectionSetup } from "../agents/AgentConnectionSetup";
import { TypingIndicator, useLiveConversationAgents } from "./TypingIndicator";
import { ActivityGroupPreview } from "./ActivityGroupPreview";
import { ActivityExpansion } from "./ActivityExpansion";
import { useChannelIdentityNames } from "../identity-names/react";
import { useMessageSelectionCopy } from "./selection-copy";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { ChatCircleIcon } from "../../shared/design-system/icons";
import { MembershipRow } from "./MembershipRow";
import {
  membershipRows,
  renderedRowIndex,
  withoutStartingAgents,
} from "./membership-rows";
import {
  useActivityPresentation,
  useStableRowActivity,
} from "./activity-presentation";
import { DayDivider } from "./MessageTimestamp";
import type { ConversationExtensions } from "../conversation/contracts";
import type { RelaySession } from "../relay/session";
import type { MessageAttention } from "../relay/unread";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Virtualizer, type VirtualizerHandle } from "virtua";
import { MessageRow, type MessageLinkOrigin } from "./MessageRow";
import {
  continuesMessageGroup,
  publicMessageNeighbor,
} from "./message-grouping";
import { calendarDay } from "../../shared/datetime";
import type {
  Attachment,
  ChannelMessage,
  ChannelWindow,
} from "../relay/contracts";
import { useRowProfiles } from "../relay/react";
import { useRecovery } from "../relay/RecoveryNotice";
import { geometryFor, geometrySignature } from "./geometry";
import { readView, writeView } from "../../shared/view-state";
import styles from "./Messages.module.css";
import { correctScrollTop } from "./scroll-correction";
import { readingPositioned, useReading } from "./use-reading";
import { useMessageReveal } from "./use-message-reveal";
import type { PageNavigation } from "../navigation/service";
import { messageViewKey } from "./view-key";
import { useKnownAgentPubkeys } from "../agents/use-known";
import { JumpToLatestButton } from "./JumpToLatestButton";
import { moveMessageSelection } from "./message-selection";
import { useMessageSelection } from "./use-message-selection";
import { useMessageVisit } from "./MessageManagement";

// Native upward scrolling can start on a focused message link or button.
// Inner scrollports own the key while they can move. At their top boundary,
// native keyboard chaining differs by engine/OS, even with CSS containment.
// Admit a candidate there; only observed history movement can leave follow.
function scrollsHistoryUp(event: KeyboardEvent<HTMLElement>): boolean {
  if (event.defaultPrevented) return false;
  const modified = event.altKey || event.ctrlKey || event.metaKey;
  // ArrowUp includes native Command/Option/Control+Up variants; Control+Home
  // is the Windows/Linux start chord. These are intent candidates: only an
  // observed upward history scroll can actually leave bottom follow.
  const upward =
    event.key === "ArrowUp" ||
    (!modified &&
      (["PageUp", "Home"].includes(event.key) ||
        (event.key === " " && event.shiftKey))) ||
    (event.key === "Home" && event.ctrlKey && !event.altKey && !event.metaKey);
  if (!upward) return false;
  let target = event.target instanceof HTMLElement ? event.target : null;
  if (!target || !event.currentTarget.contains(target)) return false;
  while (target && target !== event.currentTarget) {
    if (
      target.matches(
        "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='combobox'], [role='listbox'], [role='slider'], [role='spinbutton']",
      ) ||
      (event.key === " " && target.matches("button, [role='button']"))
    )
      return false;
    const style = getComputedStyle(target);
    if (
      ["auto", "scroll", "overlay"].includes(style.overflowY) &&
      target.scrollTop > 0
    )
      return false;
    target = target.parentElement;
  }
  return target === event.currentTarget;
}

type ReadingPosition = {
  bottom: boolean;
  anchor?: { id: string; y: number };
};
type NewMessageBoundary = {
  token: object;
  session: RelaySession;
  scope: string;
  channelId: string;
  captured: boolean;
  messageId?: string;
};
type NewMessageBoundaryBaseline = {
  token: object;
  session: RelaySession;
  scope: string;
  channelId: string;
  revision?: number;
  messageIds: ReadonlySet<string>;
  attention: Map<string, Pick<MessageAttention, "unread" | "forced"> | null>;
};
// Inline message seeks can unmount the timeline without ending its channel visit.
// Weak keys retain entry evidence only for the existing MessageManagement token.
const visitBoundaries = new WeakMap<
  object,
  { boundary: NewMessageBoundary; baseline: NewMessageBoundaryBaseline }
>();
const unknownUnreadSync = Object.freeze({ completeness: "unknown" as const });
const TIMELINE_PLACE = "timeline";
// Older pages a visit reads unasked to fill a screen its head leaves empty.
const FILL_PAGES = 5;
function positionAt(
  element: HTMLElement,
  restoredAnchor?: string,
): ReadingPosition {
  const top = element.getBoundingClientRect().top;
  const mounted = Array.from(
    element.querySelectorAll<HTMLElement>("[data-message-id]"),
  );
  // A resize restoration keeps its chosen message even if wrapping makes its
  // paragraph taller than the viewport. Only a new gesture chooses a new anchor.
  const restored = mounted.find((row) => {
    const rect = row.getBoundingClientRect();
    return (
      row.dataset.messageId === restoredAnchor &&
      rect.bottom > top &&
      rect.top < top + element.clientHeight
    );
  });
  // Otherwise prefer a whole visible message over a partly clipped row.
  const row =
    restored ??
    mounted.find((row) => {
      const text = row.querySelector("p")?.getBoundingClientRect();
      return (
        text && text.top >= top && text.bottom <= top + element.clientHeight
      );
    }) ??
    mounted.find((row) => row.getBoundingClientRect().bottom > top);
  return {
    bottom:
      element.scrollHeight - element.clientHeight - element.scrollTop < 80,
    ...(row?.dataset.messageId
      ? {
          anchor: {
            id: row.dataset.messageId,
            y: row.getBoundingClientRect().top - top,
          },
        }
      : {}),
  };
}
export type ChannelTimelineProps = {
  extensions?: ConversationExtensions | undefined;
  channelId: string;
  scope: string;
  viewer?: string | undefined;
  queries: RelaySession;
  /** A parent keyed by connection generation can preserve its timeline on cache promotion. */
  continuityKey?: string | undefined;
  window: ChannelWindow;
  /** Local presentation at the known history start, outside message semantics. */
  intro?: ReactNode;
  launchPending?: boolean | undefined;
  /** Solo chats page history on scroll; retain an explicit button for errors. */
  historyControl?: "button" | "scroll";
  /** Personal chats keep their compact initial history spacing. */
  chatPresentation?: boolean | undefined;
  /** False: rows open existing threads but offer none to start; see MessageRow. */
  startsThreads?: boolean | undefined;
  onOpenLink(url: string, origin?: MessageLinkOrigin): boolean;
  canOpenLink?: ((target: string) => boolean) | undefined;
  revealMessageId?: string | undefined;
  /** One inline exact visit: focus the verified mounted row, without a page
   * navigation. `focus: false` marks it beside a reader that owns focus. */
  inlineTarget?:
    | Readonly<{ messageId: string; signal: AbortSignal; focus?: false }>
    | undefined;
  /** Draft context starts at the returned tail, never reads/writes canonical scroll. */
  transient?: boolean | undefined;
  /** False: viewing rows marks nothing read; the owner decides what was read. */
  marksRead?: boolean | undefined;
  navigation?: PageNavigation | undefined;
  onOpenThread?(
    messageId: string,
    threadRootId: string,
    intent?: "reply",
  ): void;
  onOpenMediaReview?(
    messageId: string,
    attachment: Attachment,
    seconds: number,
    hasComments?: boolean,
    initialAttachments?: readonly Attachment[],
  ): void;
};

/** Safe to retarget through ordinary props; callers do not own internal remount keys. */
export function ChannelTimeline(props: ChannelTimelineProps) {
  return (
    <Timeline
      key={
        props.continuityKey
          ? JSON.stringify([props.continuityKey, props.scope, props.channelId])
          : messageViewKey(props.queries, props.scope, props.channelId)
      }
      {...props}
    />
  );
}
function Timeline({
  channelId,
  extensions,
  scope,
  viewer,
  queries,
  window,
  launchPending,
  intro,
  historyControl = "button",
  onOpenLink,
  canOpenLink,
  revealMessageId,
  inlineTarget,
  transient = false,
  marksRead = true,
  navigation,
  onOpenThread,
  onOpenMediaReview,
  chatPresentation = false,
  startsThreads = true,
}: ChannelTimelineProps) {
  useMessageSelectionCopy();
  const shownIntro =
    !window.hasMore && !window.historyLimited ? intro : undefined;
  const [initialPosition] = useState(() =>
    transient
      ? null
      : readView<ReadingPosition | null>(scope, `scroll:${channelId}`, null),
  );
  const savedPosition = useRef(initialPosition);
  // The place a reveal left: for its visit, with the exact follow state; for
  // the channel, with the 80 px rule every other place is saved with. The
  // channel's applies until a newer place replaces the reveal's.
  const revealedPlace = useRef<{
    visit: ReadingPosition;
    channel: ReadingPosition;
  }>(undefined);
  // Reload and quit never unmount: also save where scrolling settles. Only a
  // changed place is written; a following reader's own end scrolls are not.
  const written = useRef<string | undefined>(undefined);
  const savePosition = useCallback(() => {
    const position =
      revealedPlace.current?.visit === savedPosition.current
        ? revealedPlace.current.channel
        : savedPosition.current;
    // A bottom place restores at the latest message; its row is noise.
    const place = position?.bottom ? { bottom: true } : position;
    const revision = JSON.stringify(place);
    if (transient || revision === written.current) return;
    if (writeView(scope, `scroll:${channelId}`, place))
      written.current = revision;
  }, [channelId, scope, transient]);
  const restoredAnchor = useRef<ReadingPosition["anchor"]>(undefined);
  // The intent under which a saved row absent from the loaded rows still waits
  // for them: the saved IndexedDB head precedes the network head and notice
  // rows. The reader follows the bottom meanwhile; their input retires it.
  const pendingRestore = useRef<number | undefined>(undefined);
  const profiles = useRowProfiles(queries.profiles, window.rows);
  const agentPubkeys = useKnownAgentPubkeys(queries, profiles);
  const visibleRows = useMemo(
    () =>
      chatPresentation
        ? withoutStartingAgents(
            window.rows,
            viewer,
            agentPubkeys,
            // Live trimming can drop the chat's start without restoring hasMore.
            !window.hasMore && !window.historyLimited,
          )
        : window.rows,
    [
      window.rows,
      window.hasMore,
      window.historyLimited,
      chatPresentation,
      viewer,
      agentPubkeys,
    ],
  );
  const chronologicalRows = useMemo(
    () => membershipRows(visibleRows),
    [visibleRows],
  );
  const messageVisit = useMessageVisit(queries, channelId);
  const ownsMessageVisit = messageVisit !== undefined && messageVisit !== null;
  const [timelineVisit] = useState<object>(() => ({}));
  const visitToken = messageVisit?.token ?? timelineVisit;
  const retainedBoundary = visitBoundaries.get(visitToken);
  const retainedVisit =
    retainedBoundary?.baseline.session === queries &&
    retainedBoundary.baseline.scope === scope &&
    retainedBoundary.baseline.channelId === channelId
      ? retainedBoundary
      : undefined;
  const [newMessageBoundary, setNewMessageBoundary] =
    useState<NewMessageBoundary>(
      () =>
        retainedVisit?.boundary ?? {
          token: visitToken,
          session: queries,
          scope,
          channelId,
          captured: false,
        },
    );
  const boundaryMatchesVisit =
    newMessageBoundary.token === visitToken &&
    newMessageBoundary.session === queries &&
    newMessageBoundary.scope === scope &&
    newMessageBoundary.channelId === channelId;
  const boundaryPending = !boundaryMatchesVisit || !newMessageBoundary.captured;
  const unreadTarget = useMemo(
    () => ({ kind: "channel" as const, channelId }),
    [channelId],
  );
  const subscribeUnread = useCallback(
    (listener: () => void) =>
      messageVisit?.active === true &&
      messageVisit?.failed === false &&
      boundaryPending
        ? queries.unread.subscribe(unreadTarget, listener)
        : () => {},
    [
      boundaryPending,
      messageVisit?.active,
      messageVisit?.failed,
      queries.unread,
      unreadTarget,
    ],
  );
  const getUnreadSnapshot = useCallback(
    () =>
      ownsMessageVisit ? queries.unread.snapshot(unreadTarget) : undefined,
    [ownsMessageVisit, queries.unread, unreadTarget],
  );
  const unreadSnapshot = useSyncExternalStore(
    subscribeUnread,
    getUnreadSnapshot,
    getUnreadSnapshot,
  );
  const [, setUnreadEvidenceRevision] = useState(0);
  const subscribeUnreadSync = useCallback(
    (listener: () => void) =>
      messageVisit?.active === true &&
      messageVisit?.failed === false &&
      boundaryPending
        ? queries.unread.subscribeSync(() => {
            listener();
            setUnreadEvidenceRevision((revision) => revision + 1);
          })
        : () => {},
    [
      boundaryPending,
      messageVisit?.active,
      messageVisit?.failed,
      queries.unread,
    ],
  );
  const getUnreadSync = useCallback(
    () => (ownsMessageVisit ? queries.unread.sync() : unknownUnreadSync),
    [ownsMessageVisit, queries.unread],
  );
  const unreadSync = useSyncExternalStore(
    subscribeUnreadSync,
    getUnreadSync,
    getUnreadSync,
  );
  const boundaryBaseline = useRef<NewMessageBoundaryBaseline | undefined>(
    retainedVisit?.baseline,
  );
  if (
    !boundaryBaseline.current ||
    boundaryBaseline.current.token !== visitToken ||
    boundaryBaseline.current.session !== queries ||
    boundaryBaseline.current.scope !== scope ||
    boundaryBaseline.current.channelId !== channelId
  )
    boundaryBaseline.current = retainedVisit?.baseline ?? {
      token: visitToken,
      session: queries,
      scope,
      channelId,
      ...(ownsMessageVisit && messageVisit?.active
        ? { revision: messageVisit.entryReadRevision }
        : {}),
      messageIds: messageVisit?.entryMessageIds ?? new Set(),
      attention: new Map(messageVisit?.entryAttention),
    };
  const baseline = boundaryBaseline.current;
  const entryAttention =
    boundaryPending &&
    ownsMessageVisit &&
    messageVisit?.active === true &&
    unreadSync.completeness === "snapshot"
      ? chronologicalRows
          .filter(
            (row) =>
              // Backdated live arrivals and older pages must neither define
              // nor erase the entry boundary, so only entry rows are classified.
              baseline.messageIds.has(row.id) &&
              !row.membership &&
              !row.huddle &&
              row.audience !== "agents" &&
              row.authorId !== queries.viewer,
          )
          .map((row) => ({
            row,
            attention: queries.unread.attention(channelId, row.id),
          }))
      : [];
  // An unread count without a loaded, classifiable row is not an exact boundary.
  const noUnreadEvidence =
    unreadSnapshot?.observedCount === 0 && unreadSnapshot?.attentionCount === 0;
  const boundaryCandidate = (() => {
    if (!boundaryPending || !ownsMessageVisit || messageVisit?.active !== true)
      return { ready: false };
    if (
      baseline.revision !== undefined &&
      queries.unread.revision() !== baseline.revision
    )
      return { ready: true };
    if (
      window.status !== "ready" ||
      window.freshness !== "verified" ||
      window.refreshing ||
      window.loadingOlder ||
      unreadSync.completeness !== "snapshot"
    )
      return { ready: false };
    if (
      unreadSnapshot?.coverage !== "observed" ||
      unreadSnapshot?.freshness !== "observed"
    )
      return { ready: false };
    // Entry history is complete only when the visit captured a ready, verified,
    // idle window with no more history. Otherwise (history above the entry
    // rows, or a cached, refreshing or still-paging window, so a short channel
    // entered from cache lands here too) the boundary is the store's oldest
    // unread message, and only when it is an entry row. Later paging cannot
    // recover entry-time read evidence for rows that were not loaded.
    if (!messageVisit.entryHistoryComplete) {
      // Every relay read feeds the store, so until its repair has sampled
      // history it may know only the loaded rows, and its oldest unread one
      // can sit in the window below any read row while older ones are unread.
      // This is the only gate that holds this list's own reading: every
      // earlier one has passed, so the repair alone is awaited. A repair that
      // ended without sampling (failed, overflowed, abandoned) settles the
      // visit with no line, so reading never waits for a later retry.
      if (!unreadSnapshot.sampled)
        return unreadSnapshot.sampling
          ? { ready: false, awaitingRepair: true }
          : { ready: true };
      const oldest = unreadSnapshot.oldestUnreadId;
      if (!oldest || !baseline.messageIds.has(oldest)) return { ready: true };
    }
    if (!chronologicalRows.length) return { ready: noUnreadEvidence };
    // A repair batch that fills its limit can stop inside the window, leaving
    // the first loaded row the oldest unread message the store knows. So the
    // line needs an entry row above it that a channel-wide read reaches, which
    // reads every older ordinary row; one read only by its own msg: or thread:
    // mark says nothing about them. That still leaves mentions, broadcasts,
    // broadcast replies and messages marked unread, which catch-up's activity:
    // mark never reads, so a short sample can hide an unread one of those
    // above the window.
    let afterRead = messageVisit.entryHistoryComplete;
    for (const { row, attention } of entryAttention) {
      if (attention.status === "unknown" || attention.pending)
        return { ready: false };
      // Remote merges do not advance the local revision. Only this prefix can
      // determine entry's boundary; later rows cannot invalidate it.
      // Null preserves unresolved entry evidence instead of adopting its later state.
      const previous = baseline.attention.get(row.id);
      if (
        previous !== undefined &&
        (previous === null ||
          previous.unread !== attention.unread ||
          previous.forced !== attention.forced)
      )
        return { ready: true };
      // Ineligible means no attention category, not that an incoming row is read.
      if (attention.forced || attention.unread)
        return afterRead ? { ready: true, messageId: row.id } : { ready: true };
      if (attention.prefixRead) afterRead = true;
    }
    return { ready: true };
  })();
  // The store repairs only once something has asked it to. The desktop shell
  // asks on startup; a host that mounts a timeline alone must not hold reading
  // forever. A finished repair answers at once, so this adds no relay reads.
  useEffect(() => {
    if (boundaryCandidate.awaitingRepair) void queries.unread.ensure();
  }, [boundaryCandidate.awaitingRepair, queries.unread]);
  if (!boundaryMatchesVisit)
    setNewMessageBoundary(
      retainedVisit?.boundary ?? {
        token: visitToken,
        session: queries,
        scope,
        channelId,
        captured: false,
      },
    );
  else if (
    !newMessageBoundary.captured &&
    boundaryCandidate.ready &&
    messageVisit?.active === true &&
    messageVisit?.ready === true &&
    messageVisit?.failed === false
  )
    setNewMessageBoundary({
      token: visitToken,
      session: queries,
      scope,
      channelId,
      captured: true,
      ...(boundaryCandidate.messageId
        ? { messageId: boundaryCandidate.messageId }
        : {}),
    });
  useLayoutEffect(() => {
    if (!ownsMessageVisit || !boundaryMatchesVisit || !messageVisit?.active)
      return;
    for (const { row, attention } of entryAttention) {
      if (!baseline.attention.has(row.id))
        baseline.attention.set(
          row.id,
          attention.status === "unknown" || attention.pending
            ? null
            : { unread: attention.unread, forced: attention.forced },
        );
    }
    visitBoundaries.set(visitToken, { boundary: newMessageBoundary, baseline });
  }, [
    ownsMessageVisit,
    boundaryMatchesVisit,
    messageVisit?.active,
    entryAttention,
    baseline,
    visitToken,
    newMessageBoundary,
  ]);
  const newMessageBoundaryId =
    boundaryMatchesVisit &&
    newMessageBoundary.captured &&
    messageVisit?.active === true &&
    messageVisit?.ready === true &&
    messageVisit?.failed === false
      ? newMessageBoundary.messageId
      : undefined;
  const [expandedActivity, setExpandedActivity] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Holders are counted per row: a report notice and an image viewer can hold
  // the same row, and releasing one must not drop the other's pin.
  const [pinnedIds, setPinnedIds] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const keepRowMounted = useCallback((id: string) => {
    setPinnedIds((ids) => new Map(ids).set(id, (ids.get(id) ?? 0) + 1));
    return () =>
      setPinnedIds((ids) => {
        const next = new Map(ids);
        const count = (ids.get(id) ?? 0) - 1;
        if (count > 0) next.set(id, count);
        else next.delete(id);
        return next;
      });
  }, []);
  const presentation = useActivityPresentation(
    chronologicalRows,
    queries.agentActivity,
    agentPubkeys,
  );
  const activity = presentation.groups;
  const stableActivity = useStableRowActivity();
  const rowsById = useMemo(
    () => new Map(chronologicalRows.map((row) => [row.id, row])),
    [chronologicalRows],
  );
  const stoppedRequest = (id: string) => {
    const request = presentation.replyRequests.get(id);
    return request ? rowsById.get(request) : undefined;
  };
  const liveAgents = useLiveConversationAgents(
    queries,
    channelId,
    undefined,
    false,
  );
  // Back/Forward to a link's visit returns to where the reader left it instead
  // of replaying the link, unless that place can no longer be shown.
  const [lostPlace, setLostPlace] = useState<AbortSignal>();
  const returning =
    !inlineTarget &&
    !!navigation?.traversal &&
    lostPlace !== navigation.signal &&
    navigation.position(TIMELINE_PLACE) !== undefined;
  const targetId =
    inlineTarget?.messageId ??
    (navigation?.target.kind === "conversation" && !returning
      ? navigation.target.messageId
      : undefined);
  const rows = chronologicalRows;
  const lastPublicMessage = publicMessageNeighbor(rows, rows.length, -1);
  const intent = useRef(0);
  // Keep expansion pending with scroll restoration until the saved row arrives.
  // Any newer reader intent cancels both, even before the next history update.
  const [activityRestore, setActivityRestore] = useState(
    initialPosition?.bottom ? undefined : initialPosition?.anchor?.id,
  );
  if (activityRestore) {
    if (intent.current !== 0) setActivityRestore(undefined);
    else if (chronologicalRows.some((row) => row.id === activityRestore)) {
      setActivityRestore(undefined);
      const older = activity.find((group) =>
        group.ids.includes(activityRestore),
      )?.ids;
      if (older)
        setExpandedActivity((expanded) => new Set([...expanded, ...older]));
    }
  }
  const disclosures = new Map(
    activity.map((group) => [
      group.ids[0],
      {
        ...group,
        expanded: group.ids.some((id) => expandedActivity.has(id)),
      },
    ]),
  );
  const containedOwnerCache = useRef(new Map<string, string | undefined>());
  const nextContainedOwners = new Map(
    activity
      .filter((group) => group.ids.some((id) => expandedActivity.has(id)))
      .flatMap((group) => group.ids.map((id) => [id, group.ids[0]] as const)),
  );
  // Profile/status refreshes can rebuild the projection without moving rows.
  // Only restart positioning effects when their virtual ownership changes.
  if (
    nextContainedOwners.size !== containedOwnerCache.current.size ||
    [...nextContainedOwners].some(
      ([id, owner]) => containedOwnerCache.current.get(id) !== owner,
    )
  )
    containedOwnerCache.current = nextContainedOwners;
  const containedOwners = containedOwnerCache.current;
  const hiddenActivity = new Set(
    [...disclosures.values()].flatMap((group) =>
      group.expanded ? [] : group.ids,
    ),
  );
  const resolveName = useChannelIdentityNames(queries, channelId);
  const [geometry] = useState(() => geometryFor(queries.channels));
  const [focusedMessageId, setFocusedMessageId] = useState<string>();
  const [focusedActivityId, setFocusedActivityId] = useState<string>();
  // Folding, stacking, and cached measurements share the same visibility.
  const foldedActivity = new Set(
    [...hiddenActivity].filter(
      (id) => id !== focusedMessageId && !pinnedIds.has(id),
    ),
  );
  useLayoutEffect(() => {
    const element = scroller.current;
    if (
      !element ||
      !focusedActivityId ||
      !rows.some((row) => row.id === focusedActivityId) ||
      element.ownerDocument.activeElement !== element.ownerDocument.body
    )
      return;
    const group = [
      ...element.querySelectorAll<HTMLElement>("[data-activity-group-id]"),
    ].find((node) => node.dataset.activityGroupId === focusedActivityId);
    group
      ?.querySelector<HTMLButtonElement>("button")
      ?.focus({ preventScroll: true });
  }, [rows, focusedActivityId]);
  // Only read at mount and unmount, so build it on demand.
  const signature = () =>
    `${geometrySignature(visibleRows, profiles, resolveName)}:${JSON.stringify([...foldedActivity].sort())}`;
  // Mount the saved boundary before restoration measures its divider inset.
  const keptIndices = rows.flatMap((row, index) =>
    row.id === focusedMessageId ||
    row.id === focusedActivityId ||
    (disclosures.get(row.id)?.ids[0] === focusedActivityId &&
      !!focusedActivityId) ||
    pinnedIds.has(row.id) ||
    disclosures
      .get(row.id)
      ?.ids.some((id) => pinnedIds.has(id) || id === focusedMessageId) ||
    (row.id === newMessageBoundaryId &&
      !savedPosition.current?.bottom &&
      row.id === savedPosition.current?.anchor?.id)
      ? [index]
      : [],
  );
  const scroller = useRef<HTMLElement>(null);
  const edge = useRef<HTMLDivElement>(null);
  const activityTail = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const tail = activityTail.current;
    const element = scroller.current;
    if (!tail || !element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (settled.current && follow.current) {
        layoutCorrection.current = true;
        element.scrollTop = element.scrollHeight;
      }
    });
    observer.observe(tail);
    return () => observer.disconnect();
  }, []);
  useMessageSelection(scroller, rows, queries);
  // While the connection recovers, its notice is the one report, so the
  // history edge does not repeat the reason. Recovery does not retry older
  // history, and paging stops on a failed read, so Retry stays either way.
  const { recovering } = useRecovery(queries.recovery);
  const edgeError = recovering ? undefined : window.error;
  // Keep pagination space through EOF so removing its control cannot change
  // Virtua's start margin in the same measurement cycle as a prepend.
  const [reserveHistorySpace, setReserveHistorySpace] = useState(false);
  if (
    !reserveHistorySpace &&
    (window.hasMore ||
      window.loadingOlder ||
      window.historyLimited ||
      window.error)
  )
    setReserveHistorySpace(true);
  const handle = useRef<VirtualizerHandle>(null);
  const [size, setSize] = useState({ width: 0, height: 0, edgeHeight: 0 });
  const width = size.width;
  const latest = useRef({ signature, width, edgeHeight: size.edgeHeight });
  latest.current = { signature, width, edgeHeight: size.edgeHeight };
  const initialCache = useRef<VirtualizerHandle["cache"] | undefined>(
    undefined,
  );
  const edges = useRef<{
    order: readonly string[];
    containedOwners: ReadonlyMap<string, string | undefined>;
    ids: ReadonlySet<string>;
    floor: number;
    paging: boolean;
  }>({
    order: [],
    containedOwners: new Map(),
    ids: new Set(),
    floor: 0,
    paging: false,
  });
  // The reader's anchor row and its offset before this render's rows.
  const reader = useRef<{ id: string | undefined; top: number; y: number }>({
    id: undefined,
    top: 0,
    y: 0,
  });
  const heldReader = useRef<
    { id: string; y: number; intent: number; ended: boolean } | undefined
  >(undefined);
  const previousBoundaryId = useRef<string | undefined>(undefined);
  const upwardGesture = useRef<false | "candidate" | "moving">(false);
  const gestureFrame = useRef<number | undefined>(undefined);
  const touchY = useRef<number | undefined>(undefined);
  const measuredPosition = useRef<{
    offset: number;
    height: number;
    width: number;
    viewport: number;
  } | null>(null);
  const olderDemand = useRef(false);
  // A page read to fill the opening screen lands as part of that opening: the
  // follower's bottom positioning owns it, not prepend anchoring.
  const fillLanding = useRef(false);
  const settled = useRef(false),
    userScrolled = useRef(false),
    follow = useRef(true);
  // Set when the timeline itself positions a following reader, until the next
  // reader input. Its own end alignment and Virtua's offset corrections can
  // scroll upward before rows re-measure; only reader input may cancel follow.
  const layoutCorrection = useRef(false);
  // A held pointer can drag the scrollbar without directional input events.
  const pointerHeld = useRef(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const recordPosition = useCallback(
    (element: HTMLElement, layoutOwned = false) => {
      // A delayed membership event can replace a group's rendered representative.
      // Keep the restored event anchored through that change until reader input.
      const anchor = restoredAnchor.current;
      const renderedAnchor = anchor
        ? rows.find(
            (row) =>
              row.id === anchor.id ||
              row.membershipRows?.some((member) => member.id === anchor.id),
          )?.id
        : undefined;
      const position = positionAt(element, renderedAnchor);
      // A removed saved row cannot keep a restoration alive once a visible row
      // replaces it. A temporarily unmounted row is still pending measurement.
      if (anchor && !renderedAnchor && position.anchor)
        restoredAnchor.current = undefined;
      // A settled standalone row no longer needs correction. Membership groups
      // retain the logical anchor even when their representative is in place.
      if (
        anchor &&
        position.anchor?.id === renderedAnchor &&
        position.anchor?.y === anchor.y &&
        element.scrollHeight - element.clientHeight - element.scrollTop > 1 &&
        !rows.some((row) =>
          row.membershipRows?.some((member) => member.id === anchor.id),
        )
      )
        restoredAnchor.current = undefined;
      // Virtua can emit the restoration scroll before mounting its visible
      // range. An anchorless observation must not erase the saved reading intent.
      // A reader gesture clears restoredAnchor before recording a new position.
      if (anchor && !position.anchor) return;
      // Cold estimates can leave too little height to reach the saved row/Y.
      // A bottom clamp with that row still below its target is restoration,
      // not reader intent. Reachable positions and new gestures remain free.
      if (
        anchor &&
        position.anchor &&
        position.anchor.id === renderedAnchor &&
        position.anchor.y > anchor.y + 1 &&
        element.scrollHeight - element.clientHeight - element.scrollTop <= 1
      )
        return;
      const previous = measuredPosition.current;
      // Reflow can move the offset twice: the browser clamps a shrinking list,
      // then Virtua corrects its measured rows. That combined movement can exceed
      // the height delta, so a contracting list is not evidence of reader input.
      // A measured list-height mutation or the timeline's own end alignment can
      // likewise move the offset upward; until reader input, only explicit
      // upward input may cancel follow.
      // Explicit upward input wins even when shrink and reader movement share
      // one observation. A link-opening click is not directional scroll intent.
      const movedUp =
        previous &&
        (upwardGesture.current ||
          (!layoutOwned &&
            edge.current?.clientWidth === previous.width &&
            element.clientHeight === previous.viewport &&
            element.scrollHeight >= previous.height)) &&
        element.scrollTop < previous.offset;
      // One smooth key scroll or scrollbar drag can cross several frames.
      // Keep observed upward movement until scrollend or a newer intent, even
      // when its first event has not left the near-bottom threshold yet.
      if (movedUp) upwardGesture.current = "moving";
      if (follow.current && !movedUp && (previous || !userScrolled.current))
        position.bottom = true;
      // Restoration can scroll before Virtua measures rows beneath the anchor,
      // briefly reaching the estimated bottom. Only reader input may follow.
      if (restoredAnchor.current) position.bottom = false;
      if (pendingRestore.current !== intent.current)
        savedPosition.current = position;
      follow.current = position.bottom;
      measuredPosition.current = {
        offset: element.scrollTop,
        height: element.scrollHeight,
        width: edge.current?.clientWidth ?? 0,
        viewport: element.clientHeight,
      };
    },
    [rows],
  );
  const updateJumpToLatest = useCallback((element: HTMLElement) => {
    const bottom =
      element.scrollHeight - element.clientHeight - element.scrollTop < 80;
    setShowJumpToLatest(!bottom);
    if (bottom) setNewMessageCount(0);
  }, []);
  const jumpToLatest = useCallback(() => {
    if (!handle.current || !rows.length) return;
    intent.current++;
    follow.current = true;
    restoredAnchor.current = undefined;
    userScrolled.current = false;
    upwardGesture.current = false;
    scroller.current?.focus({ preventScroll: true });
    setShowJumpToLatest(false);
    setNewMessageCount(0);
    layoutCorrection.current = true;
    const tailHeight =
      activityTail.current?.getBoundingClientRect().height ?? 0;
    handle.current.scrollToIndex(rows.length - 1, {
      align: "end",
      ...(tailHeight ? { offset: tailHeight } : {}),
    });
  }, [rows.length]);
  const inlineSignal = inlineTarget?.signal;
  const targetIndex = rows.findIndex(
    (row) => row.id === (containedOwners.get(targetId ?? "") ?? targetId),
  );
  // The reveal keeps its row in place through late measurement until any newer
  // intent: reader input, a send or Jump to latest.
  const targetIntent = useRef<number | undefined>(undefined);
  const holdTarget = useCallback(
    () => intent.current === targetIntent.current,
    [],
  );
  // The visit last revealed or returned to. A relay rebind brings it back with
  // a new signal, and a thread visit leaves it shown; neither moves the reader.
  const presentedVisit = useRef<{ entryId: string; signal: AbortSignal }>(
    undefined,
  );
  const prepareTarget = useCallback(() => {
    if (!handle.current) return;
    // A reveal moves the reader off the visit last presented, even an inline
    // one that presents none, so a return to that visit restores its place.
    presentedVisit.current = undefined;
    targetIntent.current = ++intent.current;
    follow.current = false;
    upwardGesture.current = false;
    restoredAnchor.current = undefined;
    settled.current = false;
    handle.current.scrollToIndex(targetIndex, { align: "center" });
  }, [targetIndex]);
  const targetPlaced = useCallback(() => {
    const list = handle.current;
    const element = scroller.current;
    if (!list || !element) return;
    // Replace the mounting request with the reveal's exact position. Retain
    // that same item-relative offset through Virtua's late measurements.
    list.scrollToIndex(targetIndex, {
      align: "start",
      offset:
        element.scrollTop -
        latest.current.edgeHeight -
        list.getItemOffset(targetIndex),
    });
  }, [targetIndex]);
  const targetSignal = inlineSignal ?? navigation?.signal;
  const activityReveal = useRef<AbortSignal | string | undefined>(undefined);
  useLayoutEffect(() => {
    const id = targetId ?? revealMessageId;
    const request = targetSignal ?? revealMessageId;
    if (!id || !request || request === activityReveal.current) return;
    if (!rows.some((row) => row.id === id)) return;
    activityReveal.current = request;
    const older = activity.find((group) => group.ids.includes(id))?.ids;
    if (older?.includes(id) && foldedActivity.has(id))
      setExpandedActivity((expanded) => new Set([...expanded, ...older]));
  }, [activity, rows, targetId, targetSignal, revealMessageId, foldedActivity]);
  // Positioning waits for the exact reveal, then must run again: a reveal that
  // leaves the reader at the bottom keeps following late row measurement.
  const [revealedSignal, setRevealedSignal] = useState<AbortSignal>();
  // The row the last reveal focused; a return may take focus back from it.
  const revealedRow = useRef<string | undefined>(undefined);
  // The attempt that presented it; leaving records that visit's place.
  const [presented, setPresented] = useState<AbortSignal>();
  const present = useCallback((visit: PageNavigation) => {
    presentedVisit.current = { entryId: visit.entryId, signal: visit.signal };
    setPresented(visit.signal);
  }, []);
  const completeTarget = useCallback(() => {
    const element = scroller.current;
    // Only a reveal clamped at the scroll limit follows. A near-bottom reveal
    // keeps its row where it placed it instead of re-aligning to the end.
    if (
      element &&
      element.scrollHeight - element.clientHeight - element.scrollTop > 1
    )
      follow.current = false;
    // The reveal's placement is the reader's place even when it moved nothing
    // and so no scroll event records it. Its visit keeps the follow state, so
    // Back doesn't re-align the row; the channel's place keeps the 80 px rule.
    if (element) {
      const channel = positionAt(element);
      savedPosition.current = { ...channel, bottom: follow.current };
      revealedPlace.current = { visit: savedPosition.current, channel };
    }
    revealedRow.current = targetId;
    if (navigation && targetSignal === navigation.signal) present(navigation);
    navigation?.complete({ status: "opened" });
    setRevealedSignal(targetSignal);
  }, [navigation, targetId, targetSignal, present]);
  // A covering Members dialog owns focus, and hides the target's mark.
  const focusesTarget = !(
    navigation?.target.kind === "conversation" &&
    navigation.target.panel === "members"
  );
  useMessageReveal({
    scroller,
    focus: focusesTarget && inlineTarget?.focus !== false,
    mark: focusesTarget,
    settled,
    messageId: targetId,
    signal: targetSignal,
    ready: !!size.width && !!size.height && targetIndex >= 0,
    prepare: prepareTarget,
    placed: targetPlaced,
    complete: completeTarget,
    hold: holdTarget,
  });
  // A return restores its visit's place the way an opening restores the
  // channel's, whether the timeline mounts for it or showed another visit. The
  // visit still presented only completes. A place whose row isn't loaded opens
  // as the link first did.
  useLayoutEffect(() => {
    if (!navigation || navigation.signal.aborted) return;
    if (presentedVisit.current?.entryId !== navigation.entryId)
      presentedVisit.current = undefined;
    const prior = presentedVisit.current;
    if (!returning || prior?.signal === navigation.signal) return;
    if (prior) {
      present(navigation);
      navigation.complete({ status: "opened" });
      return;
    }
    const place = navigation.position(TIMELINE_PLACE) as ReadingPosition;
    const id = place.anchor?.id ?? "";
    if (
      place.anchor &&
      !place.bottom &&
      renderedRowIndex(rows, visibleRows, containedOwners.get(id) ?? id) < 0
    ) {
      setLostPlace(navigation.signal);
      return;
    }
    present(navigation);
    // A place inside agent activity opens its group, as an opening's place does.
    const steps =
      place.anchor && !place.bottom
        ? activity.find((group) => group.ids.includes(id))?.ids
        : undefined;
    if (steps)
      setExpandedActivity((expanded) => new Set([...expanded, ...steps]));
    intent.current++;
    savedPosition.current = place;
    follow.current = place.bottom;
    restoredAnchor.current = undefined;
    measuredPosition.current = null;
    userScrolled.current = false;
    upwardGesture.current = false;
    settled.current = false;
    navigation.complete({ status: "opened" });
    // Focus left on the page, or on the row the last reveal focused, moves to
    // the restored reading. Focus placed anywhere else stays.
    const element = scroller.current;
    const focused = document.activeElement;
    if (
      element &&
      focusesTarget &&
      navigation.focus !== "preserve" &&
      (!focused ||
        focused === document.body ||
        (focused instanceof HTMLElement &&
          revealedRow.current !== undefined &&
          element.contains(focused) &&
          focused.dataset.messageId === revealedRow.current))
    )
      element.focus({ preventScroll: true });
  }, [
    navigation,
    returning,
    rows,
    visibleRows,
    containedOwners,
    activity,
    focusesTarget,
    present,
  ]);
  // Leaving a link's visit once it was presented, revealed or returned to, by
  // navigating on or unmounting, records where the reader was for Back/Forward.
  useLayoutEffect(() => {
    if (
      navigation?.target.kind !== "conversation" ||
      !navigation.target.messageId ||
      presented !== navigation.signal
    )
      return;
    return () => {
      if (savedPosition.current)
        navigation.savePosition(TIMELINE_PLACE, savedPosition.current);
    };
  }, [navigation, presented]);
  // A pending saved row is the reader's place: following the latest message
  // until it loads is not catching up past it.
  const restoring = useCallback(
    () => pendingRestore.current === intent.current,
    [],
  );
  useReading({
    session: queries,
    channelId,
    scroller,
    settled,
    restoring,
    latestMessageId: window.rows
      .filter((row) => !row.membership && !row.huddle)
      .at(-1)?.id,
    // Reading before the entry boundary settles would erase the evidence it
    // waits for: catch-up reads every loaded row and observe the unread ones,
    // and either advances the read revision that settles it with no line.
    // Hold reading while the boundary waits for the repair; re-enabling
    // schedules dwell at once. A failed repair marks freshness stale, which
    // an earlier gate catches, so the hold ends with the repair either way.
    enabled: marksRead && !boundaryCandidate.awaitingRepair,
  });
  // Shift keeps the distance from the end, so it holds the reader only while
  // the rows from their first visible item to the end are kept. Relay pages
  // break same-second ties by id, rows by send time: a page can land below the
  // first row, or around the reader, who is then scrolled back to their row.
  const previous = edges.current.order;
  const reading = previous.slice(
    handle.current?.findItemIndex(handle.current.scrollOffset) ?? 0,
  );
  const retained =
    heldReader.current?.intent === intent.current
      ? heldReader.current
      : undefined;
  const heldId = retained?.id ?? savedPosition.current?.anchor?.id;
  // Nested activity is measured by its disclosure, in both snapshots. Keep
  // the inner ID/Y for the exact reading anchor, but compare owner offsets.
  const held = previous.indexOf(
    edges.current.containedOwners.get(heldId ?? "") ?? heldId ?? "",
  );
  reader.current = {
    id: held < 0 ? undefined : heldId,
    top: held < 0 ? 0 : (handle.current?.getItemOffset(held) ?? 0),
    y: retained?.y ?? savedPosition.current?.anchor?.y ?? 0,
  };
  const prepend =
    !!previous.length &&
    (previous[0] !== rows[0]?.id || rows.length !== previous.length) &&
    reading.every(
      (id, index) => rows[rows.length - reading.length + index]?.id === id,
    );
  // Without shift, rows landing above the reader push them down. Scroll by
  // that height before paint, so input that follows starts from the reader's
  // row. Rows that moved keep another row's size until they measure; hold the
  // reader's latest row through those measurements, until reader input that
  // follows them ends.
  useLayoutEffect(() => {
    const boundaryChanged = previousBoundaryId.current !== newMessageBoundaryId;
    previousBoundaryId.current = newMessageBoundaryId;
    const element = scroller.current;
    const list = element?.querySelector("ol");
    const index = rows.findIndex(
      (row) =>
        row.id ===
        (containedOwners.get(reader.current.id ?? "") ?? reader.current.id),
    );
    if (index < 0) heldReader.current = undefined;
    if (
      prepend ||
      !settled.current ||
      follow.current ||
      index < 0 ||
      !element ||
      !list ||
      !handle.current
    )
      return;
    const moved = handle.current.getItemOffset(index) - reader.current.top;
    const id = reader.current.id;
    if (
      !id ||
      (!moved &&
        !boundaryChanged &&
        rows.length <= edges.current.order.length &&
        !(
          heldReader.current?.id === id &&
          heldReader.current.intent === intent.current
        ))
    )
      return;
    // New rows can leave the initial offset unchanged. Hold through their
    // measurements, but leave ordinary prepend follow-up renders to Virtua.
    const row = element.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(id)}"]`,
    );
    // A divider changes the anchor's inset inside its virtual item before
    // Virtua commits the new item height. Hold the same message through both.
    const delta =
      boundaryChanged && row
        ? row.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          reader.current.y
        : moved;
    // WebKit truncates fractional scrollTop writes; use the nearest pixel
    // when a caption's fractional line height changes the message inset.
    correctScrollTop(element, boundaryChanged ? Math.round(delta) : delta);
    // The row's offset from the viewport, as last placed by the reader.
    // A live append must not choose a newly inserted row while the older
    // page is still measuring; keep the reader's original row and offset.
    // A later render holds the row again under the same input. Input that
    // ended during an earlier hold sends no further pointerup to end this one.
    const anchor = {
      id,
      y: reader.current.y,
      intent: intent.current,
      ended:
        heldReader.current?.intent === intent.current &&
        heldReader.current.ended,
    };
    heldReader.current = anchor;
    const top = () =>
      element
        .querySelector(`[data-message-id="${CSS.escape(anchor.id)}"]`)
        ?.getBoundingClientRect().top;
    const logicalTop = () => {
      const index = rows.findIndex((row) => row.id === anchor.id);
      const virtualizer = handle.current;
      return index < 0 || !virtualizer
        ? undefined
        : virtualizer.getItemOffset(index) - element.scrollTop;
    };
    let logical = logicalTop();
    let lastScrollTop = element.scrollTop;
    let readerMoved = false;
    const consumeMovement = (offset = element.scrollTop) => {
      // Browser clamping after shrink is layout, not reader movement.
      const baseline = Math.min(
        lastScrollTop,
        Math.max(0, element.scrollHeight - element.clientHeight, offset),
      );
      const delta = offset - baseline;
      if (delta) readerMoved = true;
      anchor.y -= delta;
      if (logical !== undefined) logical -= delta;
      lastScrollTop = offset;
    };
    const corrected = (event: Event) => {
      const { before, after } = (
        event as CustomEvent<{ before: number; after: number }>
      ).detail;
      consumeMovement(before);
      // Native scroll events can coalesce this correction with reader input.
      lastScrollTop = after;
    };
    // A drag can carry the reader away from that row, and Virtua unmounts
    // rows the reader leaves. Hold the row they read instead, or correcting
    // for the old one would move the rows in view.
    const read = () => {
      consumeMovement();
      if (!readerMoved) return;
      // A virtualizer correction can scroll before its new height reaches the
      // DOM or this observer. Reconcile that resize before accepting a new Y.
      const measuredHeight = handle.current?.scrollSize;
      // CSSOM can round fractional heights (e.g. 5940.734375 to 5940.73px).
      if (
        measuredHeight === undefined ||
        list.style.height !== height ||
        Math.abs(measuredHeight - Number.parseFloat(list.style.height)) >= 1
      )
        return;
      const position = positionAt(element, anchor.id).anchor;
      // consumeMovement keeps the ideal Y through scrollTop rounding. Only a
      // handover to another row adopts rendered geometry.
      if (position) {
        if (position.id !== anchor.id) Object.assign(anchor, position);
        readerMoved = false;
      }
      logical = logicalTop();
    };
    let height = list.style.height;
    const since = intent.current;
    // Virtua re-observes moved rows in the next frame and, as patched, applies
    // their sizes in the frame after (patches/README.md), whether or not their
    // height changed. Input that ended before then releases the frame after.
    let measured = false;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        measured = true;
        if (anchor.ended) frame = requestAnimationFrame(() => release());
      });
    });
    const hold = new MutationObserver((mutations) => {
      consumeMovement();
      // Ignore list-only pointer-events changes during input. A row's offsets
      // can change even when the sum of its siblings' heights does not.
      if (
        list.style.height === height &&
        !mutations.some((mutation) => mutation.target.parentNode === list)
      )
        return;
      height = list.style.height;
      const row = top();
      const next = logicalTop();
      if (settled.current && !follow.current) {
        let delta =
          row === undefined
            ? 0
            : row - element.getBoundingClientRect().top - anchor.y;
        // The range can evict the reader before the correction's scroll event.
        // Follow the same item's delta without mixing its inner DOM offset in.
        if (row === undefined && next !== undefined && logical !== undefined)
          delta = next - logical;
        correctScrollTop(element, boundaryChanged ? Math.round(delta) : delta);
        lastScrollTop = element.scrollTop;
      }
      logical = logicalTop();
    });
    const release = (keepAnchor = false) => {
      if (!keepAnchor && heldReader.current === anchor)
        heldReader.current = undefined;
      cancelAnimationFrame(frame);
      hold.disconnect();
      element.removeEventListener("scroll", read);
      element.removeEventListener("virtua-scroll-correction", corrected);
      element.removeEventListener("scrollend", end);
      element.ownerDocument.removeEventListener("pointerup", done);
      element.ownerDocument.removeEventListener("pointercancel", done);
    };
    const done = () => {
      if (measured) release();
      else anchor.ended = true;
    };
    // A held pointer can drag across more moved rows; it ends when released.
    const end = () => {
      if (intent.current !== since && !pointerHeld.current) done();
    };
    // Row measurements can redistribute offsets without changing total height.
    hold.observe(list, {
      attributes: true,
      attributeFilter: ["style"],
      subtree: true,
    });
    element.addEventListener("scroll", read);
    element.addEventListener("virtua-scroll-correction", corrected);
    element.addEventListener("scrollend", end);
    // A drag can end outside the scroller.
    element.ownerDocument.addEventListener("pointerup", done);
    element.ownerDocument.addEventListener("pointercancel", done);
    return () => release(true);
  }, [rows, prepend, containedOwners, newMessageBoundaryId]);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    // The observed spacer shares the message column's capped width. Using the
    // outer scrollport misses rewraps caused by the Appearance preference.
    const measured = edge.current?.clientWidth ?? 0;
    initialCache.current = geometry.get(
      channelId,
      latest.current.signature(),
      measured,
    );
    let measuredSize = { width: 0, height: 0, edgeHeight: 0 };
    const measure = () => {
      const next = {
        width: edge.current?.clientWidth ?? 0,
        height: element.clientHeight,
        edgeHeight: edge.current?.getBoundingClientRect().height ?? 0,
      };
      if (
        next.width === measuredSize.width &&
        next.height === measuredSize.height &&
        next.edgeHeight === measuredSize.edgeHeight
      )
        return;
      // A growing composer shrinks the viewport. Pin a reader who was at the
      // bottom before paint so history rises with it; the restore lands later.
      if (
        follow.current &&
        settled.current &&
        next.height < measuredSize.height &&
        element.scrollHeight - measuredSize.height - element.scrollTop < 2
      )
        element.scrollTop = element.scrollHeight;
      measuredSize = next;
      settled.current = false;
      setSize(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (edge.current) observer.observe(edge.current);
    const page = element.ownerDocument.defaultView;
    page?.addEventListener("pagehide", savePosition);
    return () => {
      if (gestureFrame.current !== undefined)
        cancelAnimationFrame(gestureFrame.current);
      gestureFrame.current = undefined;
      upwardGesture.current = false;
      olderDemand.current = false;
      settled.current = false;
      page?.removeEventListener("pagehide", savePosition);
      savePosition();
      observer.disconnect();
      if (handle.current)
        geometry.set(
          channelId,
          latest.current.signature(),
          latest.current.width,
          handle.current.cache,
        );
    };
    // Initial signature only; mutations invalidate the saved cache on remount.
  }, [channelId, geometry, savePosition]);
  // A reveal completes when its scroll runs. Until then it stays pending under
  // the intent that scheduled it: a row update that cancels its frame (an echo,
  // an edit, an older-history prepend) reschedules it, while any newer intent
  // (reader input, jump to latest, a message target) retires it for good.
  const revealed = useRef<string | undefined>(undefined);
  const pendingReveal = useRef<{ id: string; intent: number } | undefined>(
    undefined,
  );
  // A page lands in the commit that ends its load. Track loading apart from
  // positioning, which must not rerun when a load starts.
  const loadingOlder = useRef(false);
  useLayoutEffect(() => {
    loadingOlder.current = window.loadingOlder;
    if (window.loadingOlder) edges.current.paging = true;
  }, [window.loadingOlder]);
  useLayoutEffect(() => {
    if (
      pendingReveal.current &&
      pendingReveal.current.intent !== intent.current
    ) {
      revealed.current = pendingReveal.current.id;
      pendingReveal.current = undefined;
    }
    // Row updates include edits/reactions/replies, not only new message IDs.
    // Above-bottom reading and prepend anchoring remain Virtua's responsibility.
    const revealIndex =
      revealMessageId && revealed.current !== revealMessageId
        ? rows.findIndex(
            (row) =>
              row.id ===
                (containedOwners.get(revealMessageId) ?? revealMessageId) ||
              row.membershipRows?.some(
                (member) => member.id === revealMessageId,
              ),
          )
        : -1;
    const previousIds = edges.current.ids;
    // Rows before the loaded first row's second are history. A page also
    // returns rows of that second, and can land after a retained first row:
    // when one lands, only rows after the previous last row are new.
    const { floor, order } = edges.current;
    const paged = edges.current.paging && !loadingOlder.current;
    const tail = rows.findIndex((row) => row.id === order.at(-1));
    const arrivals = rows.filter(
      (row, index) =>
        !previousIds.has(row.id) &&
        (!paged || index > tail) &&
        (row.createdAt > floor || (row.createdAt === floor && !paged)),
    ).length;
    edges.current = {
      order: rows.map((row) => row.id),
      containedOwners,
      ids: new Set(rows.map((row) => row.id)),
      floor: rows[0]?.createdAt ?? 0,
      paging: loadingOlder.current,
    };
    if (
      arrivals > 0 &&
      previousIds.size > 0 &&
      !follow.current &&
      (!targetId || revealedSignal === targetSignal)
    ) {
      setNewMessageCount((count) => count + arrivals);
    }
    if (
      (targetId && targetSignal && revealedSignal !== targetSignal) ||
      !size.width ||
      !size.height ||
      !rows.length ||
      (revealIndex < 0 &&
        settled.current &&
        (!follow.current ||
          (prepend &&
            pendingRestore.current !== intent.current &&
            !fillLanding.current)))
    )
      return;
    if (prepend) fillLanding.current = false;
    // A send supersedes saved reading intent before the first scroll event.
    // This effect also retains its height observer through late measurements.
    if (revealIndex >= 0 && revealMessageId) {
      intent.current++;
      pendingReveal.current = { id: revealMessageId, intent: intent.current };
      follow.current = true;
      restoredAnchor.current = undefined;
      savedPosition.current = { bottom: true };
      measuredPosition.current = null;
      userScrolled.current = false;
      upwardGesture.current = false;
    }
    // virtua attaches its scroller in an effect; wait through the StrictMode probe.
    // A new gesture wins over restoration queued before that gesture.
    const scheduledIntent = intent.current;
    const saved =
      (!settled.current || pendingRestore.current === scheduledIntent) &&
      savedPosition.current &&
      !savedPosition.current.bottom
        ? savedPosition.current
        : null;
    const anchor = saved?.anchor;
    const restoreIndex = anchor
      ? renderedRowIndex(
          rows,
          visibleRows,
          containedOwners.get(anchor.id) ?? anchor.id,
        )
      : -1;
    // Only a loaded row is a place to return to. Until it loads, an opening
    // reader follows the latest message and the saved row stays pending; a
    // place without a row to wait for is forgotten. A placed reader stays put.
    const restore = restoreIndex >= 0 ? saved : null;
    if (saved && !restore && follow.current) {
      if (anchor) pendingRestore.current = scheduledIntent;
      else savedPosition.current = { bottom: true };
    }
    let observer: MutationObserver | undefined;
    const restorePosition = () => {
      if (intent.current !== scheduledIntent || !handle.current) return;
      const row = rows[restoreIndex];
      if (anchor && row) {
        pendingRestore.current = undefined;
        restoredAnchor.current = {
          id: containedOwners.has(anchor.id) ? anchor.id : row.id,
          y: anchor.y,
        };
        const element = scroller.current;
        const target =
          containedOwners.has(anchor.id) || row.id === newMessageBoundaryId
            ? element?.querySelector<HTMLElement>(
                `[data-message-id="${CSS.escape(restoredAnchor.current.id)}"]`,
              )
            : undefined;
        // Contained history and an unread divider precede the saved message
        // inside its virtual row. Include that inner offset only once.
        const innerOffset =
          target && element
            ? target.getBoundingClientRect().top -
              element.getBoundingClientRect().top +
              element.scrollTop -
              size.edgeHeight -
              handle.current.getItemOffset(restoreIndex)
            : 0;
        handle.current.scrollToIndex(restoreIndex, {
          align: "start",
          offset: innerOffset - anchor.y,
        });
        follow.current = false;
      } else if (follow.current) {
        layoutCorrection.current = true;
        const index = revealIndex >= 0 ? revealIndex : rows.length - 1;
        const tailHeight =
          index === rows.length - 1
            ? (activityTail.current?.getBoundingClientRect().height ?? 0)
            : 0;
        handle.current.scrollToIndex(index, {
          align: "end",
          ...(tailHeight ? { offset: tailHeight } : {}),
        });
        if (revealIndex >= 0) {
          revealed.current = revealMessageId;
          pendingReveal.current = undefined;
        }
      }
    };
    let frame = requestAnimationFrame(() => {
      if (intent.current === scheduledIntent && handle.current) {
        // Input can move the DOM before its scroll event is delivered.
        if (!restore && scroller.current && measuredPosition.current)
          recordPosition(scroller.current);
        if (!restore && !follow.current) {
          settled.current = true;
          readingPositioned(scroller.current);
          return;
        }
        restorePosition();
        // Width changes can measure after Virtua's imperative-scroll scheduler
        // expires. Retain the same reading anchor (or bottom intent) through
        // those late measurements, never through a new reader gesture.
        const list = scroller.current?.querySelector("ol");
        if (list) {
          // Virtua measures children in ResizeObserver and synchronously writes
          // this parent height. Observing the parent box would create skipped
          // resize notifications; watch only Virtua's committed height instead.
          let height = list.style.height;
          observer = new MutationObserver((records) => {
            if (
              list.style.height === height &&
              !records.some((record) => record.type === "childList")
            )
              return;
            height = list.style.height;
            // Capture a native clamp while its shrink is still observable.
            // Another append can grow the list before the queued scroll event.
            if (
              !restore &&
              measuredPosition.current &&
              intent.current === scheduledIntent &&
              scroller.current
            ) {
              recordPosition(scroller.current, true);
              layoutCorrection.current = true;
            }
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(restorePosition);
          });
          observer.observe(list, {
            attributes: true,
            attributeFilter: ["style"],
            childList:
              !!restore?.anchor && containedOwners.has(restore.anchor.id),
            subtree:
              !!restore?.anchor && containedOwners.has(restore.anchor.id),
          });
        }
      }
      settled.current = true;
      readingPositioned(scroller.current);
      if (scroller.current) updateJumpToLatest(scroller.current);
    });
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      // A row refresh can arrive before the first deferred measurement or
      // cancel its correction. Keep restoration until newer reader input.
      if (restore && !follow.current && intent.current === scheduledIntent) {
        // Carry the original geometry with the resolved membership identity.
        savedPosition.current =
          restore.anchor && restoredAnchor.current
            ? {
                ...restore,
                anchor: { ...restore.anchor, id: restoredAnchor.current.id },
              }
            : restore;
        settled.current = false;
      }
    };
  }, [
    rows,
    visibleRows,
    size,
    prepend,
    recordPosition,
    targetId,
    targetSignal,
    revealedSignal,
    updateJumpToLatest,
    revealMessageId,
    containedOwners,
    newMessageBoundaryId,
  ]);
  // After positioning reads it: a load that ends without rows lands no page.
  useLayoutEffect(() => {
    if (!window.loadingOlder) edges.current.paging = false;
  }, [window.loadingOlder]);
  const loadNearTop = useCallback(
    (element: HTMLElement, resume = false) => {
      olderDemand.current = false;
      if (
        !handle.current ||
        !userScrolled.current ||
        window.status !== "ready" ||
        !window.hasMore ||
        window.historyLimited ||
        window.loadingOlder ||
        window.error ||
        element.scrollTop >= Math.max(3000, element.clientHeight * 4)
      )
        return;
      // Cached does not mean blocked: disconnected windows can still page over
      // HTTP. Try ordinary demand first, retaining only a blocked cached gesture.
      // A retained gesture waits for verification, not every cached row update.
      if (resume && window.freshness === "cached") {
        olderDemand.current = true;
        return;
      }
      queries.channels.loadOlder(channelId);
      const after = queries.channels.window(channelId);
      olderDemand.current =
        window.freshness === "cached" &&
        after.status === "ready" &&
        after.hasMore &&
        !after.loadingOlder &&
        !after.historyLimited &&
        !after.error;
    },
    [window, queries, channelId],
  );
  useLayoutEffect(() => {
    if (olderDemand.current && scroller.current)
      loadNearTop(scroller.current, true);
  }, [loadNearTop]);
  // A head of folded agent activity can paint less than a screen, leaving no
  // range to scroll: no reader input would ask for older history. A settled
  // reader at the bottom fills it from verified history, a few pages a visit.
  // Past that, or after a failed read, the edge control and gestures page.
  const fillPages = useRef(0);
  const fillFrame = useRef<number | undefined>(undefined);
  const fillViewport = useCallback(() => {
    const element = scroller.current;
    if (
      !element ||
      !settled.current ||
      !follow.current ||
      pendingRestore.current === intent.current ||
      pendingReveal.current ||
      (targetId && revealedSignal !== targetSignal) ||
      fillPages.current >= FILL_PAGES ||
      recovering ||
      queries.channels.cachedOnly ||
      window.freshness === "cached" ||
      window.status !== "ready" ||
      !window.hasMore ||
      window.historyLimited ||
      window.loadingOlder ||
      window.error ||
      element.scrollHeight > element.clientHeight
    )
      return;
    queries.channels.loadOlder(channelId);
    if (!queries.channels.window(channelId).loadingOlder) return;
    fillPages.current++;
    fillLanding.current = true;
  }, [
    window,
    queries,
    channelId,
    recovering,
    targetId,
    targetSignal,
    revealedSignal,
  ]);
  // After positioning's frame, and again once Virtua measures estimated rows.
  const scheduleFill = useCallback(() => {
    if (fillFrame.current !== undefined)
      cancelAnimationFrame(fillFrame.current);
    fillFrame.current = requestAnimationFrame(() => {
      fillFrame.current = undefined;
      fillViewport();
    });
  }, [fillViewport]);
  // Window updates carry each page; positioning settles once the viewport is
  // measured.
  useLayoutEffect(() => {
    if (!size.height) return;
    scheduleFill();
    return () => {
      if (fillFrame.current !== undefined)
        cancelAnimationFrame(fillFrame.current);
      fillFrame.current = undefined;
    };
  }, [scheduleFill, size]);
  const gesture = (upward = false) => {
    const restoring = pendingRestore.current === intent.current;
    restoredAnchor.current = undefined;
    layoutCorrection.current = false;
    intent.current++;
    userScrolled.current = true;
    if (scroller.current) recordPosition(scroller.current);
    // Retiring a pending restore lets the bottom be caught up. Wake dwell: a
    // wheel or touch at the end cannot scroll, so nothing else would.
    if (restoring) readingPositioned(scroller.current);
    upwardGesture.current = upward ? "candidate" : false;
    if (gestureFrame.current !== undefined)
      cancelAnimationFrame(gestureFrame.current);
    gestureFrame.current = undefined;
    if (upward)
      gestureFrame.current = requestAnimationFrame(() => {
        gestureFrame.current = undefined;
        // Input is only a candidate: an inner scrollport can consume it without
        // moving history or emitting scrollend. Sample native movement before
        // retiring the candidate so input+shrink still wins in this observation,
        // even when the browser has not delivered its scroll event yet.
        if (upwardGesture.current && scroller.current)
          recordPosition(scroller.current);
        if (upwardGesture.current === "candidate")
          upwardGesture.current = false;
      });
    // At a restored top edge, input cannot move the DOM and emits no scroll.
    if (scroller.current && scroller.current.scrollTop <= 0)
      loadNearTop(scroller.current);
  };
  return (
    <section
      ref={scroller}
      data-message-scroller
      data-chat-presentation={chatPresentation || undefined}
      className={styles.feed}
      data-channel-timeline={channelId}
      data-activity-history-scope=""
      data-buzz-launch-pending={launchPending ? "settling" : undefined}
      data-jump-visible={showJumpToLatest || undefined}
      onWheel={(event) => gesture(event.deltaY < 0 && !event.ctrlKey)}
      onTouchStart={(event) => {
        touchY.current = event.touches[0]?.clientY;
      }}
      onTouchMove={(event) => {
        const next = event.touches[0]?.clientY;
        gesture(
          next !== undefined &&
            touchY.current !== undefined &&
            next > touchY.current,
        );
        touchY.current = next;
      }}
      onKeyDown={(event) => {
        moveMessageSelection(event);
        gesture(scrollsHistoryUp(event));
      }}
      onPointerDown={() => {
        pointerHeld.current = true;
        // A press can end outside history.
        const document = scroller.current?.ownerDocument;
        const up = () => {
          pointerHeld.current = false;
          document?.removeEventListener("pointerup", up);
          document?.removeEventListener("pointercancel", up);
        };
        document?.addEventListener("pointerup", up);
        document?.addEventListener("pointercancel", up);
        gesture();
      }}
      onPointerUp={() => {
        pointerHeld.current = false;
      }}
      onPointerCancel={() => {
        pointerHeld.current = false;
      }}
      onScrollEnd={(event) => {
        // Virtual rows can finish measuring after the last scroll event,
        // especially at the top where reflow cannot change scrollTop.
        const element = event.currentTarget;
        if (
          settled.current &&
          edge.current?.clientWidth === size.width &&
          element.clientHeight === size.height
        )
          recordPosition(
            element,
            layoutCorrection.current && !pointerHeld.current,
          );
        upwardGesture.current = false;
        savePosition();
      }}
      onFocus={(event) => {
        setFocusedActivityId(
          event.target.closest<HTMLElement>("[data-activity-group-id]")?.dataset
            .activityGroupId,
        );
        setFocusedMessageId(
          event.target.closest<HTMLElement>("[data-message-id]")?.dataset
            .messageId,
        );
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocusedMessageId(undefined);
          setFocusedActivityId(undefined);
        }
      }}
      tabIndex={0}
      aria-label="Channel message history"
      onScroll={(event) => {
        // React may receive this event before Virtua updates its handle metrics.
        const element = event.currentTarget;
        const v = handle.current;
        if (
          v &&
          settled.current &&
          edge.current?.clientWidth === size.width &&
          element.clientHeight === size.height
        ) {
          recordPosition(
            element,
            layoutCorrection.current && !pointerHeld.current,
          );
          updateJumpToLatest(element);
        }
        loadNearTop(element);
      }}
    >
      <div
        ref={edge}
        className={styles.edge}
        data-history-space={reserveHistorySpace || undefined}
        data-intro={!!shownIntro || undefined}
      >
        {shownIntro}
        {edgeError && <span role="alert">{edgeError}</span>}
        {window.historyLimited ? (
          <span>History window limit reached</span>
        ) : window.hasMore && queries.channels.cachedOnly ? (
          <span>You can load older messages once Buzz reconnects.</span>
        ) : window.hasMore && (historyControl === "button" || window.error) ? (
          <Button
            type="button"
            disabled={window.loadingOlder}
            onClick={() => {
              queries.channels.loadOlder(channelId);
              const after = queries.channels.window(channelId);
              if (after.loadingOlder || after.error || after.status !== "ready")
                olderDemand.current = false;
            }}
          >
            {window.loadingOlder
              ? "Loading older…"
              : window.error
                ? "Retry older messages"
                : "Load older messages"}
          </Button>
        ) : window.loadingOlder ? (
          <span role="status">Loading older…</span>
        ) : null}
      </div>
      <JumpToLatestButton
        visible={showJumpToLatest}
        newMessageCount={newMessageCount}
        onClick={jumpToLatest}
      />
      {width > 0 && (
        <Virtualizer
          ref={handle}
          scrollRef={scroller}
          // Before Virtua measures its viewport there is no reading position
          // to preserve; shifting then can freeze its initial empty range.
          shift={prepend && !!handle.current?.viewportSize}
          bufferSize={1600}
          // Reflow must not evict the focused control or a row's open report.
          keepMounted={keptIndices}
          onResize={() => {
            scheduleFill();
            const element = scroller.current;
            // Rows can measure after native scrollend without moving the
            // scroll offset. Do not carry their estimated Y into the next hold.
            if (
              element &&
              settled.current &&
              edge.current?.clientWidth === size.width &&
              element.clientHeight === size.height &&
              !follow.current &&
              !restoredAnchor.current &&
              pendingRestore.current !== intent.current &&
              heldReader.current?.intent !== intent.current
            )
              // A size change refreshes geometry, never bottom-follow intent.
              savedPosition.current = { ...positionAt(element), bottom: false };
          }}
          as="ol"
          item="li"
          startMargin={size.edgeHeight}
          {...(initialCache.current ? { cache: initialCache.current } : {})}
        >
          {rows.map((row, index) => {
            const disclosure = disclosures.get(row.id);
            const hidden = foldedActivity.has(row.id);
            const previousRow =
              row.audience === "agents"
                ? rows[index - 1]
                : publicMessageNeighbor(rows, index, -1);
            const nextRow =
              row.audience === "agents"
                ? rows[index + 1]
                : publicMessageNeighbor(rows, index, 1);
            const day =
              index === 0
                ? true
                : calendarDay(rows[index - 1]?.createdAt ?? 0) !==
                  calendarDay(row.createdAt);
            const renderMessage = (row: ChannelMessage, inside = false) => {
              return (
                <MessageRow
                  representedAgents={stableActivity.agents(
                    row.id,
                    presentation.representedAgents.get(row.id),
                  )}
                  repliedAgents={stableActivity.agents(
                    `replied:${row.id}`,
                    presentation.repliedAgents.get(row.id),
                  )}
                  stoppedRequest={stoppedRequest(row.id)}
                  recordedActivity={stableActivity.activity(
                    row.id,
                    presentation.byRow.get(row.id),
                    "history",
                  )}
                  stackPrevious={
                    inside ||
                    (!!previousRow &&
                      !foldedActivity.has(previousRow.id) &&
                      continuesMessageGroup(previousRow, row))
                  }
                  stackNext={
                    inside ||
                    presentation.bubbleAnchors.has(row.id) ||
                    (row.id === lastPublicMessage?.id &&
                      row.audience !== "agents" &&
                      !row.membership &&
                      row.authorId === liveAgents[0]) ||
                    (!!nextRow &&
                      !foldedActivity.has(nextRow.id) &&
                      continuesMessageGroup(row, nextRow))
                  }
                  session={queries}
                  scope={scope}
                  row={row}
                  unread={queries.unread}
                  extensions={extensions}
                  profile={profiles.get(row.authorId)}
                  participantProfiles={profiles}
                  agentPubkeys={agentPubkeys}
                  media={queries.media}
                  onOpenLink={onOpenLink}
                  canOpenLink={canOpenLink}
                  onOpenThread={onOpenThread}
                  startsThreads={startsThreads}
                  {...(onOpenMediaReview ? { onOpenMediaReview } : {})}
                  retry={queries.outbox?.retry}
                  keepMounted={keepRowMounted}
                  day={!inside && day && !disclosure}
                />
              );
            };
            return (
              <Fragment key={row.id}>
                {disclosure && (
                  <div
                    className={styles.activityDisclosure}
                    data-activity-group-id={disclosure.ids[0]}
                  >
                    {!disclosure.expanded &&
                      (() => {
                        const first = rows.findIndex(
                          (item) => item.id === disclosure.ids[0],
                        );
                        const before = rows[first - 1];
                        return (
                          (!before ||
                            calendarDay(before.createdAt) !==
                              calendarDay(row.createdAt)) && (
                            <DayDivider createdAt={row.createdAt} />
                          )
                        );
                      })()}
                    <ActivityGroupPreview
                      session={queries}
                      group={disclosure}
                      openActivity={onOpenLink}
                      canOpenActivity={canOpenLink}
                      renderHistory={(entry) => renderMessage(entry, true)}
                      profiles={profiles}
                      media={queries.media}
                      expanded={disclosure.expanded}
                      onToggle={() => {
                        intent.current++;
                        follow.current = false;
                        userScrolled.current = true;
                        restoredAnchor.current = undefined;
                        const next = new Set(expandedActivity);
                        for (const id of disclosure.ids) {
                          if (disclosure.expanded) next.delete(id);
                          else next.add(id);
                        }
                        setExpandedActivity(next);
                      }}
                    />
                  </div>
                )}
                {row.id === newMessageBoundaryId && (
                  <div
                    className={styles.newMessages}
                    data-new-messages-boundary
                  >
                    <hr
                      className="sr-only select-none"
                      aria-label="New messages"
                    />
                    <span className="select-none" aria-hidden="true">
                      New messages
                    </span>
                  </div>
                )}
                <ActivityExpansion
                  open={!hidden && !containedOwners.has(row.id)}
                  enabled={row.audience === "agents"}
                >
                  {row.membership ? (
                    <MembershipRow
                      resolveName={resolveName}
                      names={queries.names}
                      row={row}
                      profiles={profiles}
                      viewer={viewer}
                      media={queries.media}
                      agentPubkeys={agentPubkeys}
                      day={day}
                      onOpenLink={onOpenLink}
                      canOpenLink={canOpenLink}
                    />
                  ) : (
                    renderMessage(row)
                  )}
                </ActivityExpansion>
              </Fragment>
            );
          })}
        </Virtualizer>
      )}
      <div ref={activityTail}>
        <AgentConnectionSetup
          key={channelId}
          session={queries}
          rows={window.rows}
          channel={queries.channels.get?.(channelId)}
        />
        <TypingIndicator
          audience="agents"
          inFlow
          session={queries}
          channelId={channelId}
          previousAuthor={
            lastPublicMessage && !lastPublicMessage.membership
              ? lastPublicMessage.authorId
              : undefined
          }
          openActivity={onOpenLink}
          canOpenActivity={canOpenLink}
        />
        <div className={styles.timelineEnd} aria-hidden="true" />
      </div>
      {!rows.length &&
        !shownIntro &&
        !window.hasMore &&
        window.status === "ready" &&
        !window.error &&
        !window.loadingOlder && (
          <div className={styles.emptyConversation}>
            <EmptyState
              icon={<ChatCircleIcon />}
              title="No messages yet."
              description={
                queries.channels.get?.(channelId)?.readOnly
                  ? undefined
                  : "Start the conversation below."
              }
            />
          </div>
        )}
    </section>
  );
}
