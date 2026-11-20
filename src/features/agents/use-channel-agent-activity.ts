import { useCallback, useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";

type Activity = RelaySession["agentActivity"];
const noop = () => {};

export function useChannelActivitySubscription(
  activity: Activity | undefined,
  channelId: string | undefined,
) {
  return useCallback(
    (listener: () => void) =>
      channelId === undefined
        ? noop
        : (activity?.subscribe(listener, channelId) ?? noop),
    [activity, channelId],
  );
}

export function useChannelActivitySnapshot(
  activity: Activity | undefined,
  channelId: string | undefined,
) {
  const subscribe = useChannelActivitySubscription(activity, channelId);
  const read = () =>
    channelId === undefined ? undefined : activity?.snapshot(channelId);
  return useSyncExternalStore(subscribe, read, read);
}
