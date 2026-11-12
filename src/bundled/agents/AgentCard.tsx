// An agent as a card: its portrait large, its name, and one line about it.
// Pack avatars play their animation; any other picture shows still.
import type { ComponentProps, ReactNode } from "react";
import { agentAvatars } from "../../features/agents/avatar-packs";
import { StarFilledIcon } from "../../shared/design-system/icons";
import { SurfaceButton } from "../../shared/design-system/ui/SurfaceButton";
import { useAvatarPreview } from "../../features/profiles/use-avatar-preview";
import { ProfileBackdrop } from "../../features/profiles/ProfileBackdrop";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import styles from "./AgentCard.module.css";
import { PackedAgentAvatar } from "./PackedAgentAvatar";

type Portrayed = Readonly<{ name: string; picture?: string | undefined }>;

/** Static artwork shares the portrait's pack lookup and protected media path. */
export function useAgentPortraitSource(agent: Portrayed, community?: string) {
  const pack = agentAvatars.find((avatar) => avatar.url === agent.picture);
  const src = useAvatarPreview(
    pack ? "" : (agent.picture ?? ""),
    community,
    "small",
  );
  return { pack, src: pack?.preview ?? src };
}

/** An agent's picture: a pack avatar animates, any other shows through its
 * community's media access. */
export function AgentPortrait({
  agent,
  community,
}: {
  agent: Portrayed;
  community?: string | undefined;
}) {
  const { pack, src } = useAgentPortraitSource(agent, community);
  if (pack) return <PackedAgentAvatar avatar={pack} />;
  return (
    <Avatar
      src={src}
      alt=""
      fallback={agent.name}
      size="fill"
      shape="squircle"
    />
  );
}

/** Cards share the profile header's decorative artwork and media access. */
export function AgentCardBackdrop({
  agent,
  community,
}: {
  agent: Portrayed;
  community?: string | undefined;
}) {
  const pack = agentAvatars.find((avatar) => avatar.url === agent.picture);
  const src = useAvatarPreview(
    pack ? "" : (agent.picture ?? ""),
    community,
    "small",
  );
  const backdrop = pack?.preview ?? src;
  if (!backdrop) return null;
  return (
    <>
      <ProfileBackdrop src={backdrop} />
      <span className={styles.grain} aria-hidden="true" />
    </>
  );
}

export function AgentCard({
  agent,
  community,
  detail,
  icon,
  isBestie,
  celebrateBestie,
  onBestieCelebrated,
  children,
  menu,
  ...props
}: Omit<ComponentProps<"div">, "className" | "children"> & {
  /** Marks the explicitly saved Bestie without adding another card action. */
  isBestie?: boolean;
  celebrateBestie?: boolean;
  onBestieCelebrated?: (() => void) | undefined;
  agent: Portrayed;
  community?: string | undefined;
  /** One line under the name, such as its model. */
  detail?: ReactNode;
  icon?: ReactNode;
  /** Actions below the detail. */
  children?: ReactNode;
  menu?: ReactNode;
}) {
  return (
    <div {...props} className={`${styles.card} ${styles.agentCard}`}>
      <AgentCardBackdrop agent={agent} community={community} />
      {isBestie && (
        <span
          className={`${styles.bestie} buzz-button`}
          data-variant="glass-clear"
          data-size="sm"
          aria-hidden="true"
          data-celebrating={celebrateBestie || undefined}
        >
          <span className="buzz-button-label">
            <span
              className={styles.bestieStars}
              data-accent="bee"
              data-color-mode="light"
            >
              <span
                className={styles.bestieStar}
                onAnimationEnd={(event) => {
                  if (event.target === event.currentTarget)
                    onBestieCelebrated?.();
                }}
              >
                <StarFilledIcon size={16} />
              </span>
              {celebrateBestie && (
                <>
                  <StarFilledIcon className={styles.bestieSpark} size={10} />
                  <StarFilledIcon className={styles.bestieSpark} size={9} />
                  <span
                    className={`${styles.bestieSpark} ${styles.bestieDot}`}
                  />
                  <span
                    className={`${styles.bestieSpark} ${styles.bestieDot}`}
                  />
                  <svg
                    className={`${styles.bestieSpark} ${styles.bestieTriangle}`}
                    viewBox="0 0 12 12"
                    aria-hidden="true"
                  >
                    <path
                      d="M5.1 1.5Q6 0 6.9 1.5L11 9Q12 11 10 11H2Q0 11 1 9Z"
                      fill="currentColor"
                    />
                  </svg>
                  <svg
                    className={`${styles.bestieSpark} ${styles.bestieTriangle}`}
                    viewBox="0 0 12 12"
                    aria-hidden="true"
                  >
                    <path
                      d="M5.1 1.5Q6 0 6.9 1.5L11 9Q12 11 10 11H2Q0 11 1 9Z"
                      fill="currentColor"
                    />
                  </svg>
                </>
              )}
            </span>
            Bestie
          </span>
        </span>
      )}
      {menu && <div className={styles.menu}>{menu}</div>}
      <span className={styles.portrait} aria-hidden="true">
        <AgentPortrait agent={agent} community={community} />
      </span>
      <span className={styles.identity}>
        <span className={`${styles.name} text-label`}>{agent.name}</span>
        {detail && (
          <span className={styles.detail}>
            {icon}
            <span className={styles.detailText}>{detail}</span>
          </span>
        )}
        {children && <span className={styles.actions}>{children}</span>}
      </span>
    </div>
  );
}

/** A team as a card: its first members' portraits overlapped, its name, and
 * who is on it. */
export function TeamCard({
  name,
  members,
  ...props
}: Omit<ComponentProps<typeof SurfaceButton>, "className" | "children"> & {
  name: string;
  members: readonly (Portrayed & { community?: string | undefined })[];
}) {
  return (
    <SurfaceButton {...props} type="button" className={styles.card}>
      <span className={styles.crew} aria-hidden="true">
        {members.slice(0, 3).map((member, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: members may share names; order is stable.
          <span key={index} className={styles.crewPortrait}>
            <AgentPortrait agent={member} community={member.community} />
          </span>
        ))}
      </span>
      <span className={`${styles.name} text-label`}>{name}</span>
      <span className={styles.detail}>
        <span className={styles.detailText}>
          {members.map((member) => member.name).join(", ") || "No members"}
        </span>
      </span>
    </SurfaceButton>
  );
}
