import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { EmojiArtwork } from "../../features/profiles/AvatarEditor";
import {
  type AvatarCrop,
  emojiAvatarScale,
} from "../../features/profiles/avatar-upload";
import styles from "./AgentCreate.module.css";

const settings = {
  rotation: 32,
  scale: 1,
  blur: 12,
  duration: 0.32,
  bounce: 0.49,
  exitDuration: 0.36,
  fadeDuration: 0.11,
  blurDuration: 0.13,
};

export function EmojiSwap({
  emoji,
  crop,
  animate,
}: {
  emoji: string;
  crop?: AvatarCrop | undefined;
  animate: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const activeSettings = animate && !reducedMotion ? settings : null;
  return (
    <span className={styles.emojiSwap} aria-hidden="true">
      <AnimatePresence initial={false} custom={activeSettings}>
        <motion.span
          key={emoji}
          className={styles.emojiSwapLayer}
          initial={{
            opacity: 0,
            scale: settings.scale,
            rotate: -settings.rotation,
            filter: `blur(${settings.blur}px)`,
          }}
          animate={{
            opacity: 1,
            scale: 1,
            rotate: 0,
            filter: "blur(0px)",
          }}
          exit="exit"
          variants={{
            exit: (exitSettings: typeof settings | null) => ({
              opacity: 0,
              scale: exitSettings?.scale ?? settings.scale,
              rotate: exitSettings?.rotation ?? settings.rotation,
              filter: `blur(${exitSettings?.blur ?? settings.blur}px)`,
              transition: {
                type: "tween" as const,
                duration: exitSettings?.exitDuration ?? 0,
                ease: [0.22, 1, 0.36, 1] as const,
              },
            }),
          }}
          transition={
            reducedMotion || !animate
              ? { duration: 0 }
              : {
                  type: "spring",
                  duration: settings.duration,
                  bounce: settings.bounce,
                  opacity: { type: "tween", duration: settings.fadeDuration },
                  filter: { type: "tween", duration: settings.blurDuration },
                }
          }
        >
          <EmojiArtwork
            emoji={emoji}
            scale={crop && emojiAvatarScale * crop.zoom}
            offset={crop?.y}
            x={crop?.x}
            animate={false}
          />
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
