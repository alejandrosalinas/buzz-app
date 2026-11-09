import { useSyncExternalStore } from "react";
import type { ChannelList, ChannelQueries, ChannelSummary } from "./contracts";

const unlisted = () => () => {};
const listed = new WeakMap<ChannelList, Map<string, ChannelSummary>>();
/** One roster fact about one channel. Previews and activity replace the list and
 * its summaries on every message, so `select` must return a primitive or a
 * reference the store retains (such as `members`); the caller then renders only
 * when that fact changes. */
export function useListedChannel<T>(
  queries: Partial<Pick<ChannelQueries, "list" | "subscribeList">> | undefined,
  channelId: string | undefined,
  select: (channel: ChannelSummary | undefined) => T,
): T {
  const snapshot = () => {
    const list = queries?.list?.();
    if (!list || channelId === undefined) return select(undefined);
    let index = listed.get(list);
    if (!index) {
      index = new Map();
      for (const channel of list.channels)
        if (!index.has(channel.id)) index.set(channel.id, channel);
      listed.set(list, index);
    }
    return select(index.get(channelId));
  };
  return useSyncExternalStore(
    queries?.subscribeList ?? unlisted,
    snapshot,
    snapshot,
  );
}

/** `useListedChannel` that, like the store, falls back to `get` for a channel
 * the list does not hold (a preview or a starting Solo chat). `select` must
 * return stable values; for the fallback that relies on `get` keeping `members`
 * referentially stable. */
export function useHeaderChannel<T>(
  queries: Pick<ChannelQueries, "list" | "get" | "subscribeList">,
  channelId: string,
  select: (channel: ChannelSummary | undefined) => T,
): T {
  return useListedChannel(queries, channelId, (listed) =>
    select(listed ?? queries.get?.(channelId)),
  );
}
