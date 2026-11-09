import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { EmojiArtwork } from "../../features/profiles/AvatarEditor";
import { BuilderlabLogoIcon } from "../../shared/design-system/icons";
import type { AvatarSelection } from "./AgentAvatarPicker";
import { AgentPortrait } from "./AgentCard";
import styles from "./AgentCreate.module.css";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const endings = [
  "So… what are we getting into?",
  "Got a weird idea? I’m listening.",
  "Big plans? Tiny question? Hit me.",
  "What’s our first side quest?",
  "I’m new here. What should I know?",
  "Tell me your most ‘hear me out’ idea.",
  "Your next rabbit hole has a plus-one.",
  "You bring the half-baked idea. We’ll figure out the rest.",
  "Go on, I’m all ears. Metaphorically.",
  "All right. What’s the plot?",
] as const;

export function RemoteAgentIntroduction({
  name,
  avatar,
  community,
  builderlab,
}: {
  name: string;
  avatar: AvatarSelection;
  community?: string | undefined;
  builderlab: boolean;
}) {
  const [finish] = useState(
    () => endings[Math.floor(Math.random() * endings.length)] ?? endings[0],
  );
  const hello = `Hi, I’m ${name}.`;
  const opening = builderlab
    ? "Since I’m a remote agent hosted by "
    : "I work on another computer";
  const provider = builderlab ? "Builderlab" : "";
  const ready = builderlab ? ", I’m always ready for you." : ".";
  const online = builderlab
    ? "You can chat with me from your phone, even when this computer is off. "
    : "My availability and file access depend on that computer’s setup.";
  const files = builderlab
    ? "I just won’t be able to open files on this computer."
    : "";
  const openingStart = hello.length;
  const providerStart = openingStart + opening.length;
  const readyStart = providerStart + provider.length;
  const onlineStart = readyStart + ready.length;
  const filesStart = onlineStart + online.length;
  const finishStart = filesStart + files.length;
  const reducedMotion = useReducedMotion();
  const entrance = (at: number) => ({
    initial: { opacity: 0, filter: "blur(0.5px)", scale: 1.05 },
    animate: { opacity: 1, filter: "blur(0px)", scale: 1 },
    transition: {
      duration: 0.18,
      delay: 0.56 + at * 0.0107,
      ease: "easeOut" as const,
    },
  });
  const text = (value: string, start: number, animate: boolean) => {
    if (!animate) return value;
    let offset = start;
    return value.split(/(\s+)/).map((word) => {
      const at = offset;
      offset += word.length;
      if (!word.trim()) return word;
      // Keep words together while each glyph has its own transform box.
      return (
        <span key={at} className={styles.remoteSpeechWord}>
          {Array.from(graphemes.segment(word), ({ segment }, index) => (
            <motion.span
              // biome-ignore lint/suspicious/noArrayIndexKey: immutable prose has a stable character order.
              key={at + index}
              className={styles.remoteSpeechCharacter}
              {...entrance(at + index)}
            >
              {segment}
            </motion.span>
          ))}
        </span>
      );
    });
  };
  const logo = <BuilderlabLogoIcon size="1em" aria-hidden="true" />;
  const copy = (animate: boolean) => (
    <>
      <p>{text(hello, 0, animate)}</p>
      <p>
        {text(opening, openingStart, animate)}
        {builderlab && (
          <span className={`${styles.remoteProvider} text-label-sm`}>
            {animate ? (
              <motion.span
                className={`${styles.remoteSpeechCharacter} ${styles.remoteProviderLogo}`}
                {...entrance(providerStart)}
              >
                {logo}
              </motion.span>
            ) : (
              <span className={styles.remoteProviderLogo}>{logo}</span>
            )}
            {text(provider, providerStart, animate)}
          </span>
        )}
        {text(ready, readyStart, animate)}
      </p>
      <p>
        {text(online, onlineStart, animate)}
        {text(files, filesStart, animate)}
      </p>
      <p>{text(finish, finishStart, animate)}</p>
    </>
  );

  return (
    <div className={styles.remoteIntroduction}>
      <motion.div
        className={`${styles.remoteSpeech} text-body`}
        initial={reducedMotion ? false : { opacity: 0, y: 24, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{
          duration: reducedMotion ? 0 : 0.24,
          delay: reducedMotion ? 0 : 0.28,
          ease: "easeOut",
        }}
      >
        {/* AT gets the full disclosure once, without per-character announcements. */}
        <div className={reducedMotion ? styles.remoteSpeechCopy : "sr-only"}>
          {copy(false)}
        </div>
        {!reducedMotion && (
          <div className={styles.remoteSpeechCopy} aria-hidden="true">
            {/* Every glyph is laid out from the start; only its paint animates. */}
            {copy(true)}
          </div>
        )}
      </motion.div>
      <motion.div
        className={styles.remotePortrait}
        role="img"
        aria-label={`${name}’s avatar`}
        initial={reducedMotion ? false : { opacity: 0, scale: 0.75 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: reducedMotion ? 0 : 0.28, ease: "easeOut" }}
      >
        {avatar.kind === "emoji" ? (
          <div
            data-avatar-shape="squircle"
            className={styles.remoteEmoji}
            style={{ backgroundColor: avatar.color }}
          >
            <EmojiArtwork emoji={avatar.emoji} animate={false} />
          </div>
        ) : (
          <AgentPortrait
            agent={{ name, picture: avatar.picture }}
            community={community}
          />
        )}
      </motion.div>
    </div>
  );
}
