import { rowProfileIds } from "./membership";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type {
  ChannelList,
  ChannelMessage,
  ChannelQueries,
  ChannelSummary,
  Profile,
} from "./contracts";
import type { ProfileQueries } from "./profile-directory";
import { selectProfiles } from "./profile-selection";

export function useChannelList(queries: ChannelQueries) {
  useEffect(() => queries.ensureList(), [queries]);
  return useSyncExternalStore(
    queries.subscribeList,
    queries.list,
    queries.list,
  );
}
/**
 * The roster without its live activity: previews and activity replace the list
 * on every message, so a ready list that changed only those fields keeps the
 * previous snapshot. `activity` keeps `lastActivityAt` and `activityKnown`
 * changes for all rows or for rows that match a predicate. With `rank`, those
 * changes are kept only when they change how the rows `activity` selects rank:
 * their order by rank, or which of them tie, since callers break ties by keys
 * this hook cannot see. `preview` keeps `preview` changes. Rows
 * can read their own preview with useLiveChannelSummary.
 */
export function useChannelRoster(
  queries: ChannelQueries,
  {
    activity = false,
    preview = false,
    rank,
  }: {
    activity?: boolean | ((channel: ChannelSummary) => boolean);
    preview?: boolean;
    rank?: Rank;
  } = {},
) {
  useEffect(() => queries.ensureList(), [queries]);
  const ignoredWithActivity = preview ? noFields : previewField;
  const ignoredWithoutActivity = preview ? activityTimes : activityFields;
  const ignored =
    activity === true ? ignoredWithActivity : ignoredWithoutActivity;
  const activityFilter = typeof activity === "function" ? activity : undefined;
  const last = useRef<{
    queries: ChannelQueries;
    ignored: ReadonlySet<string>;
    activityFilter: typeof activityFilter;
    rank: typeof rank;
    list: ChannelList;
  }>(undefined);
  const snapshot = useCallback(() => {
    const next = queries.list();
    const previous = last.current;
    if (
      previous?.queries === queries &&
      previous.ignored === ignored &&
      previous.activityFilter === activityFilter &&
      previous.rank === rank &&
      previous.list.activityStatus === next.activityStatus &&
      previous.list.error === next.error &&
      (sameRoster(previous.list, next, (channel) =>
        activityFilter?.(channel) ? ignoredWithActivity : ignored,
      ) ||
        (rank !== undefined &&
          activity !== false &&
          sameRoster(previous.list, next, () => ignoredWithoutActivity) &&
          rankingOf(previous.list, activityFilter, rank) ===
            rankingOf(next, activityFilter, rank)))
    )
      return previous.list;
    last.current = { queries, ignored, activityFilter, rank, list: next };
    return next;
  }, [
    queries,
    ignored,
    activityFilter,
    rank,
    activity,
    ignoredWithActivity,
    ignoredWithoutActivity,
  ]);
  return useSyncExternalStore(queries.subscribeList, snapshot, snapshot);
}
type Rank = (channel: ChannelSummary) => number | undefined;
type Select = ((channel: ChannelSummary) => boolean) | undefined;
const rankings = new WeakMap<ChannelList, Map<Rank, Map<Select, string>>>();
/** Selected ids highest rank first, grouped by tie; unranked last. */
function rankingOf(list: ChannelList, select: Select, rank: Rank) {
  let byRank = rankings.get(list);
  if (!byRank) {
    byRank = new Map();
    rankings.set(list, byRank);
  }
  let bySelect = byRank.get(rank);
  if (!bySelect) {
    bySelect = new Map();
    byRank.set(rank, bySelect);
  }
  let key = bySelect.get(select);
  if (key === undefined) {
    const groups = new Map<number, string[]>();
    for (const channel of list.channels) {
      if (select && !select(channel)) continue;
      const value = rank(channel) ?? Number.NEGATIVE_INFINITY;
      const group = groups.get(value);
      if (group) group.push(channel.id);
      else groups.set(value, [channel.id]);
    }
    key = [...groups]
      .sort(([a], [b]) => b - a)
      .map(([, ids]) => ids.sort().join(","))
      .join("\n");
    bySelect.set(select, key);
  }
  return key;
}
const listIndexes = new WeakMap<ChannelList, Map<string, ChannelSummary>>();
function listEntry(list: ChannelList, id: string) {
  let index = listIndexes.get(list);
  if (!index) {
    index = new Map(list.channels.map((channel) => [channel.id, channel]));
    listIndexes.set(list, index);
  }
  return index.get(id);
}
/**
 * One row's live preview and activity, so a message re-renders that row only.
 * Everything else, including the host's resolved DM name, stays `channel`'s.
 */
export function useLiveChannelSummary(
  queries: ChannelQueries,
  channel: ChannelSummary,
) {
  const snapshot = useCallback(
    () => listEntry(queries.list(), channel.id),
    [queries, channel.id],
  );
  const live = useSyncExternalStore(queries.subscribeList, snapshot, snapshot);
  return useMemo(
    () =>
      !live ||
      [...activityFields].every(
        (key) =>
          live[key as keyof ChannelSummary] ===
          channel[key as keyof ChannelSummary],
      )
        ? channel
        : withActivity(channel, live),
    [channel, live],
  );
}
function withActivity(channel: ChannelSummary, live: ChannelSummary) {
  const merged: Record<string, unknown> = { ...channel };
  for (const key of activityFields) {
    const value = live[key as keyof ChannelSummary];
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged as ChannelSummary;
}
const activityFields = new Set(["preview", "lastActivityAt", "activityKnown"]);
const previewField = new Set(["preview"]);
const activityTimes = new Set(["lastActivityAt", "activityKnown"]);
const noFields = new Set<string>();
function sameRoster(
  a: ChannelList,
  b: ChannelList,
  ignoredFields: (channel: ChannelSummary) => ReadonlySet<string>,
) {
  return (
    a.status === "ready" &&
    b.status === "ready" &&
    a.coverage === b.coverage &&
    a.asOf === b.asOf &&
    a.rosterAsOf === b.rosterAsOf &&
    a.channels.length === b.channels.length &&
    a.channels.every(
      (channel, index) =>
        channel === b.channels[index] ||
        sameRosterEntry(channel, b.channels[index], ignoredFields(channel)),
    )
  );
}
function sameRosterEntry(
  a: ChannelSummary,
  b: ChannelSummary | undefined,
  ignored: ReadonlySet<string>,
) {
  if (!b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys)
    if (
      !ignored.has(key) &&
      a[key as keyof ChannelSummary] !== b[key as keyof ChannelSummary]
    )
      return false;
  return true;
}
export function useChannelWindow(queries: ChannelQueries, channelId: string) {
  useEffect(() => queries.ensure(channelId), [queries, channelId]);
  const subscribe = useCallback(
    (listener: () => void) => queries.subscribeWindow(channelId, listener),
    [queries, channelId],
  );
  const snapshot = useCallback(
    () => queries.window(channelId),
    [queries, channelId],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
const noSubscribe = () => () => {};
/** The directory's purge generation. Read it in an effect that ensures the
 * profiles a view shows, so the view ensures them again after an access purge. */
export function useProfileGeneration(queries: ProfileQueries | undefined) {
  const read = () => queries?.generation?.() ?? 0;
  return useSyncExternalStore(queries?.subscribe ?? noSubscribe, read, read);
}

export function useRowProfiles(
  queries: ProfileQueries,
  rows: readonly ChannelMessage[],
) {
  const ids = [...new Set(rows.flatMap(rowProfileIds))].sort().join(":");
  // New rows usually add authors whose profiles are still loading. Keep the map
  // identity then, so memoized rows do not all re-render for each page.
  const last = useRef<ReadonlyMap<string, Profile>>(undefined);
  const selection = useMemo(
    () => selectProfiles(queries, ids ? ids.split(":") : [], last.current),
    [queries, ids],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  last.current = profiles;
  return profiles;
}

/** Subscribe to replacement as well as connection readiness; never capture a startup session once. */
export function useRelayConnection(relay: import("./service").RelayData) {
  return useSyncExternalStore(relay.subscribe, relay.snapshot, relay.snapshot);
}
