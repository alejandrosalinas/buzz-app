import { StatusTicker } from "./StatusTicker";
import { useUserStatus } from "./useUserStatus";
import type { RelaySession } from "../relay/session";
import type { UserStatus } from "../relay/user-status";
import { StatusEmoji } from "./StatusEmoji";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import styles from "./Status.module.css";

export function StatusDisplay({
  status,
  session,
  compact = false,
  focusable = true,
  size = "default",
}: {
  status: UserStatus | undefined;
  session: RelaySession;
  compact?: boolean;
  focusable?: boolean;
  size?: "default" | "caption";
}) {
  if (!status || (!status.emoji && !status.text)) return null;
  const label = [status.emoji, status.text].filter(Boolean).join(" ");
  if (!compact)
    return (
      <span className={styles.status} data-size={size}>
        {size === "caption" ? (
          <StatusTicker key={label} text={label}>
            <StatusEmoji
              value={status.emoji}
              url={status.emojiUrl}
              session={session}
              hint
            />
            {status.emoji && status.text && " "}
            {status.text}
          </StatusTicker>
        ) : (
          <>
            <StatusEmoji
              value={status.emoji}
              url={status.emojiUrl}
              session={session}
              hint
            />
            {status.emoji && status.text && " "}
            <span className={styles.text}>{status.text}</span>
          </>
        )}
      </span>
    );
  return (
    <Tooltip
      content={
        <span className={styles.tooltipContent}>
          <StatusEmoji
            value={status.emoji}
            url={status.emojiUrl}
            session={session}
          />
          {status.text && <span>{status.text}</span>}
        </span>
      }
    >
      <span
        className={styles.status}
        data-compact
        role="img"
        aria-label={label}
        tabIndex={focusable ? 0 : undefined}
      >
        <StatusEmoji
          decorative
          value={status.emoji}
          url={status.emojiUrl}
          fallback="💬"
          session={session}
        />
      </span>
    </Tooltip>
  );
}

export function UserStatusDisplay({
  session,
  userId,
  compact = false,
  focusable = true,
  size = "default",
}: {
  session: RelaySession;
  userId: string;
  compact?: boolean;
  focusable?: boolean;
  size?: "default" | "caption";
}) {
  const status = useUserStatus(session.statuses, userId);
  return (
    <StatusDisplay
      session={session}
      status={status}
      compact={compact}
      focusable={focusable}
      size={size}
    />
  );
}
