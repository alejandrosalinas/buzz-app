import { useSyncExternalStore } from "react";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import { CountBadge } from "../../shared/design-system/ui/CountBadge";
import { hasUnread } from "./InboxRow";
import { activityConversation, useActivityMutes } from "./useActivityMutes";

/** Sidebar count of unread Activity conversations, the total the hover card
 * leads with. It reads the unread evidence the sidebar already loads. */
export function InboxBadge({ relay }: { relay: RelayData }) {
  const connection = useRelayConnection(relay);
  const { unread } = connection.session;
  const muted = useActivityMutes(connection.session);
  const inbox = useSyncExternalStore(
    unread.subscribeInbox,
    unread.inbox,
    unread.inbox,
  );
  const count =
    connection.status === "ready"
      ? inbox.items.filter((item) => {
          const visible = activityConversation(item, muted);
          return visible && hasUnread(visible);
        }).length
      : 0;
  return <CountBadge count={count} label={`${count} unread`} />;
}
