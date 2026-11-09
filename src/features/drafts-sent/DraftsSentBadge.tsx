import type { RelayData } from "../relay/service";
import { useChannelList, useRelayConnection } from "../relay/react";
import { CountBadge } from "../../shared/design-system/ui/CountBadge";
import styles from "./DraftsSent.module.css";
import { useDrafts } from "./drafts";
import { listed } from "./scope";

/** Sidebar count of unsent drafts in the current community. */
export function DraftsSentBadge({ relay }: { relay: RelayData }) {
  const connection = useRelayConnection(relay);
  const session =
    connection.status === "ready" ? connection.session : undefined;
  const drafts = useDrafts(session);
  const { channels } = useChannelList(connection.session.channels);
  const count = session
    ? drafts.entries.filter((entry) =>
        listed(channels.find((channel) => channel.id === entry.channelId)),
      ).length
    : 0;
  return count ? (
    <span className={styles.badge}>
      <CountBadge
        count={count}
        label={`${count} draft${count === 1 ? "" : "s"}`}
      />
    </span>
  ) : null;
}
