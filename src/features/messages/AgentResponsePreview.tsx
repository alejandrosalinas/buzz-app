import type { ReactNode } from "react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { RobotIcon } from "../../shared/design-system/icons";
import { useMessageDensity } from "../../shared/theme/message-density";
import styles from "./Messages.module.css";

/** Incoming message geometry for work that has not published a response yet. */
export function AgentResponsePreview({
  name,
  picture,
  participants = [],
  layout = "timeline",
  children,
  stackPrevious = false,
  bylineHint,
}: {
  bylineHint?: ReactNode;
  stackPrevious?: boolean;
  name: string;
  picture?: string | undefined;
  participants?: readonly {
    id: string;
    name: string;
    picture?: string | undefined;
  }[];
  layout?: "timeline" | "thread" | "continuation" | undefined;
  children: ReactNode;
}) {
  // A flat list's group avatar is on its first row; a continuation keeps only
  // the label, which names the row while its byline is omitted.
  const flat = useMessageDensity() === "compact";
  const hiddenAvatar = stackPrevious && flat;
  const avatars: typeof participants = participants.length
    ? participants.slice(0, 3)
    : [{ id: "primary", name, picture }];
  return (
    <div
      className={styles.message}
      data-stack-previous={stackPrevious || undefined}
      data-layout={layout}
      data-agent-response-preview=""
    >
      <span className={styles.messageGutter} />
      <div className={styles.messageBody}>
        <div className={styles.messageContent}>
          <div className={hiddenAvatar ? "sr-only" : styles.messageAvatar}>
            <span
              className={styles.agentAvatarGroup}
              data-count={Math.max(1, Math.min(participants.length, 3))}
              role="img"
              aria-label={
                participants.length
                  ? participants.map((agent) => agent.name).join(", ")
                  : name
              }
            >
              {avatars.map((agent) => (
                <span
                  key={agent.id}
                  className={styles.agentAvatarGroupItem}
                  title={agent.name}
                >
                  <Avatar
                    src={agent.picture}
                    alt=""
                    fallback={agent.name}
                    shape="squircle"
                    size="fill"
                  />
                </span>
              ))}
            </span>
          </div>
          {!stackPrevious && (
            <div className={styles.messageHeader}>
              <div className={styles.byline}>
                <strong className={styles.author}>
                  <RobotIcon
                    aria-hidden="true"
                    className={styles.authorAgentIcon}
                  />
                  {name}
                </strong>
                {bylineHint}
              </div>
            </div>
          )}
          <div className={styles.messageBubble}>{children}</div>
        </div>
      </div>
    </div>
  );
}
