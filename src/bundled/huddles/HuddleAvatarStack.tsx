import { TypingDots } from "../../shared/design-system/ui/TypingDots";
import { useProfileGeneration } from "../../features/relay/react";
import { HuddleAvatarMotion } from "./HuddleAvatarMotion";
import { useEffect, useSyncExternalStore, type CSSProperties } from "react";
import type { RelayData } from "../../features/relay/service";
import { formatPublicKey } from "../../shared/identity/public-key";
import { avatarMedia } from "../../shared/avatar-source";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import styles from "./Huddles.module.css";

export function HuddleAvatarStack({
  participants,
  relay,
  transition = false,
  thinking = [],
  speakers,
}: {
  participants: readonly string[];
  relay: RelayData;
  transition?: boolean;
  thinking?: readonly string[] | undefined;
  speakers?: Readonly<Record<string, number>> | undefined;
}) {
  const { session } = useSyncExternalStore(relay.subscribe, relay.snapshot);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const keys = participants.join(":");
  const profileGeneration = useProfileGeneration(session.profiles);
  useEffect(() => {
    void profileGeneration;
    if (keys)
      void session.profiles
        .ensure(keys.split(":"), "background")
        .catch(() => {});
  }, [keys, session, profileGeneration]);
  const name = (key: string) =>
    profiles.get(key)?.name || formatPublicKey(key) || "Participant";
  const isThinking = (key: string) =>
    thinking.includes(key) && !speakers?.[key];
  const label = participants
    .map((key) => `${name(key)}${isThinking(key) ? ", thinking" : ""}`)
    .join(", ");
  const visible = participants.slice(-4);
  const hidden = participants.length - visible.length;
  const slots = visible.length + (hidden ? 1 : 0);
  return (
    <span
      className={styles.avatarStack}
      role="img"
      aria-label={`In this Huddle: ${label}`}
      title={label}
      style={{ width: `${1.25 + Math.max(0, slots - 1) * 0.875}rem` }}
    >
      {visible.map((key, index) => {
        const profile = profiles.get(key);
        return (
          <span
            key={key}
            className={`${styles.stackAvatar} text-caption`}
            data-participant={key}
            style={
              {
                "--avatar-offset": `${index * 0.875}rem`,
                zIndex: index + 1,
              } as CSSProperties
            }
          >
            <HuddleAvatarMotion participant={key} enabled={transition}>
              <Avatar
                size="fill"
                src={avatarMedia(profile?.picture, session.media)}
                fallback={name(key)}
                alt=""
              />
            </HuddleAvatarMotion>
            {isThinking(key) && (
              <span className={styles.thinkingDots} aria-hidden="true">
                <TypingDots size="small" />
              </span>
            )}
          </span>
        );
      })}
      {hidden > 0 && (
        <span
          className={`${styles.avatarOverflow} text-caption`}
          data-avatar-overflow=""
          style={{ zIndex: visible.length + 1 }}
        >
          <Avatar
            size="fill"
            fallback=""
            fallbackContent={`+${hidden}`}
            alt=""
          />
        </span>
      )}
    </span>
  );
}
