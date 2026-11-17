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
 * previous snapshot. Read `preview` and `lastActivityAt` from useChannelList.
 */
export function useChannelRoster(queries: ChannelQueries) {
  useEffect(() => queries.ensureList(), [queries]);
  const last = useRef<{ queries: ChannelQueries; list: ChannelList }>(
    undefined,
  );
  const snapshot = useCallback(() => {
    const next = queries.list();
    const previous = last.current;
    if (previous?.queries === queries && sameRoster(previous.list, next))
      return previous.list;
    last.current = { queries, list: next };
    return next;
  }, [queries]);
  return useSyncExternalStore(queries.subscribeList, snapshot, snapshot);
}
const activityFields = new Set(["preview", "lastActivityAt", "activityKnown"]);
function sameRoster(a: ChannelList, b: ChannelList) {
  return (
    a.status === "ready" &&
    b.status === "ready" &&
    a.coverage === b.coverage &&
    a.asOf === b.asOf &&
    a.rosterAsOf === b.rosterAsOf &&
    a.channels.length === b.channels.length &&
    a.channels.every((channel, index) =>
      sameRosterEntry(channel, b.channels[index]),
    )
  );
}
function sameRosterEntry(a: ChannelSummary, b: ChannelSummary | undefined) {
  if (a === b) return true;
  if (!b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys)
    if (
      !activityFields.has(key) &&
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
