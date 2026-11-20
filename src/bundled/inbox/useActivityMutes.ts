import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { InboxItem } from "../../features/relay/inbox";
import type { RelaySession } from "../../features/relay/session";

/** Apply confirmed mutes to Activity without changing shared unread evidence. */
export function useActivityMutes({ sidebarPreferences }: RelaySession) {
  const readMutes = useCallback(() => {
    const snapshot = sidebarPreferences.snapshot();
    return snapshot.cached ? undefined : snapshot.data?.muted;
  }, [sidebarPreferences]);
  const muted = useSyncExternalStore(
    sidebarPreferences.subscribe,
    readMutes,
    readMutes,
  );
  return useMemo(() => new Set(muted), [muted]);
}

/** DM rows target their channel. A muted non-DM row shows only its direct
 * mention projection. */
export function activityConversation(
  item: InboxItem,
  muted: ReadonlySet<string>,
): InboxItem | undefined {
  return item.target.kind === "channel" || !muted.has(item.channelId)
    ? item
    : item.mention;
}
