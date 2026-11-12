import { useEffect, useSyncExternalStore } from "react";
import { useAgentPortraitSource } from "../agents/AgentCard";
import messageStyles from "../../features/messages/Messages.module.css";
import { RobotIcon } from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import {
  replaceView,
  subscribeView,
  viewRevision,
  writeView,
} from "../../shared/view-state";
import styles from "./PinnedBestie.module.css";

const key = (agent: string) => `bestie-first-agent.v1:${agent}`;

/** Capture creation provenance before the saved choice can unmount its chooser.
 * Optional local decoration: storage failure must not block agent creation. */
export function rememberFirstAgent(scope: string, agent: string) {
  writeView(scope, key(agent), { channel: null });
}

export function useFirstAgentWelcome(
  scope: string,
  agent: string,
  channel: string,
) {
  const revision = useSyncExternalStore(
    (listener) => subscribeView(scope, listener),
    () => viewRevision(scope, key(agent)),
  );
  let savedChannel: string | null | undefined;
  try {
    const receipt: unknown = JSON.parse(revision ?? "null");
    if (receipt && typeof receipt === "object" && "channel" in receipt) {
      if (receipt.channel === null || typeof receipt.channel === "string")
        savedChannel = receipt.channel;
    }
  } catch {
    // A malformed or unavailable receipt supplies no first-creation evidence.
  }
  useEffect(() => {
    if (savedChannel === null)
      replaceView(scope, key(agent), revision, { channel });
  }, [scope, agent, channel, revision, savedChannel]);
  return savedChannel === channel;
}

/** Local app content using incoming-message presentation, never a relay row. */
export function FirstAgentWelcome({
  name,
  picture,
  community,
}: {
  name: string;
  picture?: string | undefined;
  community?: string | undefined;
}) {
  const { src } = useAgentPortraitSource({ name, picture }, community);
  return (
    <article
      className={`${messageStyles.message} ${styles.welcome}`}
      data-layout="timeline"
      aria-label="Welcome to Buzz"
    >
      <span className={messageStyles.messageGutter} />
      <div className={messageStyles.messageBody}>
        <div className={messageStyles.messageContent}>
          <div className={messageStyles.messageAvatar}>
            <Avatar
              src={src}
              alt={`${name} avatar`}
              fallback={name}
              shape="squircle"
            />
          </div>
          <div className={messageStyles.byline}>
            <strong className={messageStyles.author}>
              <RobotIcon
                aria-hidden="true"
                className={messageStyles.authorAgentIcon}
              />
              {name}
            </strong>
          </div>
          <div className={messageStyles.messageBubble}>
            <div className={messageStyles.text}>
              <h3>Welcome to Buzz!</h3>
              <p>
                Since I’m your first agent, you can find me at the top of the
                left sidebar. As you create more agents, you can change who
                shows up there by making a different one your Bestie.
              </p>
              <p>
                In addition to any instructions you’ve given me during setup, I
                can also answer questions about working in Buzz.
              </p>
              <p>Ask away, or tell me what you’d like to work on.</p>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
