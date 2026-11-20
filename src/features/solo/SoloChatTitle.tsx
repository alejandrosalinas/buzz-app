import {
  AnimatePresence,
  motion,
  stagger,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { ChannelDetailsCapability } from "../relay/channel-details";
import styles from "./SoloChatTitle.module.css";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ease = [0.25, 0.1, 0.25, 1] as const;
// Keep RTL blocks, including shared punctuation and numerals, in one text run.
const bidiText =
  /[\p{Bidi_Control}\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u;
// Other scripts can also need shaping across grapheme boundaries. Only split
// familiar scripts, plus shared punctuation, symbols, and combining marks.
const splitSafeScripts =
  /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Common}\p{Script=Inherited}]*$/u;
const revealTransition = { duration: 0.18, ease };
const character = {
  hidden: { opacity: 0, filter: "blur(3px)", transform: "translateX(-3px)" },
  visible: {
    opacity: 1,
    filter: "blur(0px)",
    transform: "translateX(0px)",
    transition: revealTransition,
  },
};

/** Key by chat id at the call site: renames animate, navigation starts at rest. */
export function SoloChatTitle({
  title,
  channelId,
  details,
}: {
  title: string;
  channelId?: string;
  details?: Pick<ChannelDetailsCapability, "localRename"> | undefined;
}) {
  const reducedMotion = useReducedMotion();
  const localRename = channelId
    ? details?.localRename?.(channelId, title)
    : undefined;
  const [presenceKey, setPresenceKey] = useState(localRename);
  // Start a new presence group at rest for this editor's save. Keep its key
  // for the next incoming title so that title can still animate.
  if (localRename !== undefined && localRename !== presenceKey)
    setPresenceKey(localRename);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  return (
    <span className={styles.title} data-solo-chat-title="">
      <span className="sr-only">{title}</span>
      {reducedMotion ? (
        <span className={styles.value} aria-hidden="true">
          {title}
        </span>
      ) : (
        <AnimatePresence key={presenceKey} initial={false} mode="wait">
          <TitleValue
            key={title}
            title={title}
            reveal={mounted.current && localRename === undefined}
          />
        </AnimatePresence>
      )}
    </span>
  );
}

function TitleValue({ title, reveal }: { title: string; reveal: boolean }) {
  const present = useIsPresent();
  const [revealing, setRevealing] = useState(reveal);
  const wholeTitle = bidiText.test(title) || !splitSafeScripts.test(title);
  const characters =
    revealing && !wholeTitle ? [...graphemes.segment(title)] : [];
  return (
    <motion.span
      className={styles.value}
      data-exiting={!present || undefined}
      aria-hidden="true"
      initial={reveal ? "hidden" : false}
      animate="visible"
      exit="exit"
      variants={{
        ...(wholeTitle ? { hidden: { opacity: 0, filter: "blur(3px)" } } : {}),
        visible: {
          opacity: 1,
          filter: "blur(0px)",
          transform: "translateX(0px)",
          transition: wholeTitle
            ? revealTransition
            : {
                // Bound the full reveal even for long titles.
                delayChildren: stagger(
                  Math.min(0.025, 0.28 / Math.max(1, characters.length - 1)),
                ),
              },
        },
        exit: {
          opacity: 0,
          filter: "blur(3px)",
          transform: "translateX(-8px)",
          transition: { duration: 0.15, ease },
        },
      }}
      onAnimationComplete={(phase) => {
        if (phase === "visible" && present) setRevealing(false);
      }}
    >
      {characters.length
        ? characters.map(({ segment, index }) => (
            <motion.span
              key={index}
              className={styles.character}
              variants={character}
            >
              {segment}
            </motion.span>
          ))
        : title}
    </motion.span>
  );
}
