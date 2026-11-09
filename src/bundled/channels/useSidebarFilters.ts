import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { DEFAULT_ACTIVE_WINDOW_SECONDS } from "../../features/relay/sidebar-preferences";
import type {
  ThreadActivityItem,
  UnreadCapability,
} from "../../features/relay/unread";
import type { sidebarSections } from "./sidebar-sections";

export type { SidebarFilterMode as SidebarFilter } from "../../features/relay/sidebar-preferences";
import type { SidebarFilterMode as SidebarFilter } from "../../features/relay/sidebar-preferences";
export const SIDEBAR_ACTIVE_WINDOW = DEFAULT_ACTIVE_WINDOW_SECONDS * 1000;

/** Filter only the existing section roster; the current destination always stays. */
export function useSidebarFilters(
  sections: ReturnType<typeof sidebarSections>,
  filters: Readonly<Record<string, SidebarFilter>>,
  current: string | undefined,
  unread: UnreadCapability,
  windows: Readonly<Record<string, number>> = {},
  activityReady = true,
) {
  const ids = JSON.stringify(
    sections.flatMap((section) =>
      filters[section.key] === "unreads"
        ? section.rows.map((row) => row.id)
        : [],
    ),
  );
  const unreadSet = useUnreadChannelIds(unread, ids, true);
  const [clock, tick] = useState(0);
  const now = Date.now();
  let nextExpiry = Infinity;
  // Unknown activity is not inactivity. Keep those rows during loading or a
  // failed read; a successful read can establish that a channel has no activity.
  const visible = sections.map((section) => {
    const mode = filters[section.key] ?? "all";
    const activeWindow =
      (windows[section.key] ?? DEFAULT_ACTIVE_WINDOW_SECONDS) * 1000;
    const rows = section.rows.filter((channel) => {
      if (mode === "active" && channel.lastActivityAt !== undefined) {
        const expiry = channel.lastActivityAt * 1000 + activeWindow;
        if (expiry > now) nextExpiry = Math.min(nextExpiry, expiry);
      }
      return (
        channel.id === current ||
        mode === "all" ||
        (mode === "unreads" && unreadSet.has(channel.id)) ||
        (mode === "active" &&
          (channel.lastActivityAt === undefined
            ? !channel.activityKnown && !activityReady
            : channel.lastActivityAt * 1000 + activeWindow > now))
      );
    });
    const visibleIds = new Set(rows.map(({ id }) => id));
    return {
      ...section,
      allRows: section.rows,
      rows,
      hiddenRows: section.rows.filter(({ id }) => !visibleIds.has(id)),
    };
  });
  // One owned deadline keeps an idle sidebar correct when activity ages out.
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(
      () => tick(clock + 1),
      Math.min(Math.max(0, nextExpiry - Date.now()), 2_147_483_647),
    );
    return () => window.clearTimeout(timer);
  }, [nextExpiry, clock]);
  return visible;
}

/** Whether a channel has unread messages, a manual mark or unread threads.
 * `shown` asks what its row shows instead, which opening the channel quiets. */
export function channelHasUnread(
  unread: UnreadCapability,
  channelId: string,
  shown = false,
) {
  const state = unread.snapshot({ kind: "channel", channelId });
  if (state.manual !== "none") return true;
  if (shown && state.row) return state.row.observedCount > 0;
  return (
    (state.observedCount ?? 0) > 0 ||
    (unread.activity(channelId).items?.length ?? 0) > 0
  );
}

/** Channels among `ids` (a JSON id array) with unread messages or threads.
 * `shown` asks what their rows show instead: the sidebar's Unreads filter
 * follows the rows, while search still leads with every unread conversation. */
export function useUnreadChannelIds(
  unread: UnreadCapability,
  ids: string,
  shown = false,
) {
  const targets = useMemo(
    () =>
      (JSON.parse(ids) as string[]).map((channelId) => ({
        kind: "channel" as const,
        channelId,
      })),
    [ids],
  );
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = targets.flatMap((target) => [
        unread.subscribe(target, listener),
        unread.subscribeActivity(target.channelId, listener),
      ]);
      return () => {
        for (const stop of stops) stop();
      };
    },
    [targets, unread],
  );
  const snapshot = useCallback(
    () =>
      JSON.stringify(
        targets
          .filter((target) => channelHasUnread(unread, target.channelId, shown))
          .map((target) => target.channelId),
      ),
    [targets, unread, shown],
  );
  const unreadIds = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(() => new Set<string>(JSON.parse(unreadIds)), [unreadIds]);
}

/** The newest unread thread reply of each channel among `targets` (a JSON
 * array of `[id, dm]` pairs) whose unread is only thread replies: no manual
 * mark and no unread message outside the listed threads. A DM shares one read
 * marker across its threads, so it qualifies only with a single unread thread. */
export function useUnreadThreadOnly(unread: UnreadCapability, targets: string) {
  const channels = useMemo(
    () => JSON.parse(targets) as [string, boolean][],
    [targets],
  );
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = channels.flatMap(([channelId]) => [
        unread.subscribe({ kind: "channel", channelId }, listener),
        unread.subscribeActivity(channelId, listener),
      ]);
      return () => {
        for (const stop of stops) stop();
      };
    },
    [channels, unread],
  );
  const snapshot = useCallback(
    () =>
      JSON.stringify(
        channels.flatMap(([channelId, dm]) => {
          const items = unread.activity(channelId).items ?? [];
          const state = unread.snapshot({ kind: "channel", channelId });
          const replies = items.reduce(
            (sum, item) => sum + item.unreadCount,
            0,
          );
          return items[0] &&
            (!dm || items.length === 1) &&
            state.manual === "none" &&
            (state.observedCount ?? 0) <= replies
            ? [items[0]]
            : [];
        }),
      ),
    [channels, unread],
  );
  const threads = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(
    () =>
      new Map(
        (JSON.parse(threads) as ThreadActivityItem[]).map((item) => [
          item.channelId,
          item,
        ]),
      ),
    [threads],
  );
}
