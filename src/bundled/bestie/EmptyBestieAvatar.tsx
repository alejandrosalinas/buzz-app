import { useEffect, useRef, useState } from "react";
import { agentAvatars, avatarPacks } from "../../features/agents/avatar-packs";
import { RobotIcon } from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import styles from "./EmptyBestieAvatar.module.css";

// Follow mobile's alternating character packs, using bundled stills offline.
const packs = ["fuzzies", "gloopies", "figgies"].map(
  (id) => avatarPacks.find((pack) => pack.id === id)?.avatarIds ?? [],
);
const characters = Array.from(
  { length: Math.max(...packs.map((pack) => pack.length)) },
  (_, index) => packs.flatMap((pack) => pack[index] ?? []),
)
  .flat()
  .flatMap((id) => {
    const avatar = agentAvatars.find((item) => item.id === id);
    return avatar ? [avatar] : [];
  });

/** An invitation, not an agent identity. Never plays videos or starts setup. */
export function EmptyBestieAvatar({ compact = false }: { compact?: boolean }) {
  const [index, setIndex] = useState(0);
  const container = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let timer: ReturnType<typeof setInterval> | undefined;
    const update = () => {
      clearInterval(timer);
      if (media?.matches || document.hidden) return;
      timer = setInterval(() => {
        if (!container.current?.closest("[data-covered]"))
          setIndex((value) => (value + 1) % characters.length);
      }, 5_000);
    };
    update();
    media?.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(timer);
      media?.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return (
    <span
      ref={container}
      className={compact ? styles.compact : styles.portrait}
      aria-hidden="true"
    >
      <span key={index} className={styles.character}>
        <Avatar
          src={characters[index]?.preview}
          alt=""
          fallback="Bestie"
          fallbackContent={<RobotIcon />}
          shape="squircle"
          size="fill"
          loading="eager"
        />
      </span>
    </span>
  );
}
