import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  UserIcon,
  ChatCircleIcon,
  RobotIcon,
} from "../../shared/design-system/icons";
import { useProfileMessage } from "./useProfileMessage";
import {
  useState,
  useSyncExternalStore,
  useEffect,
  useRef,
  useId,
  cloneElement,
  type ReactElement,
  type FocusEvent,
} from "react";
import { PreviewCard } from "../../shared/design-system/ui/PreviewCard";
import { AgentAvatar } from "../agents/AgentAvatar";
import { usePresenceStatus } from "../presence/react";
import type { RelaySession } from "../relay/session";
import { UserStatusDisplay } from "../user-status/StatusDisplay";
import { ProfileBackdrop } from "./ProfileBackdrop";
import styles from "./ProfilePeek.module.css";
import {
  otherVerifiedName,
  useNamePreference,
  verifiedLabel,
} from "./name-preference";

type ProfilePeekProps = {
  trigger: ReactElement;
  name: string;
  picture: string | undefined;
  pubkey: string;
  agent: boolean;
  session: RelaySession | undefined;
  channelId: string;
  viewer: string | undefined;
  target: string;
  onOpen(target: string): boolean;
  onFocusChange?(focused: boolean): void;
};

/** The verified name this reader does not go by. Mounted only in an open
 * preview, so closed rows never subscribe to the directory. */
function OtherName({
  session,
  pubkey,
}: {
  session: RelaySession;
  pubkey: string;
}) {
  const verified = useSyncExternalStore(
    session.profiles.subscribe,
    () => session.profiles.snapshot().get(pubkey)?.verified,
  );
  const preference = useNamePreference();
  const otherName =
    verified &&
    otherVerifiedName(verifiedLabel(verified, preference), verified);
  return otherName ? (
    <div className="text-caption text-secondary">{otherName}</div>
  ) : null;
}

/** A lightweight look at the same identity the avatar opens in the profile panel. */
export function ProfilePeek({
  trigger,
  target,
  onOpen,
  name,
  picture,
  pubkey,
  agent,
  session,
  channelId,
  viewer,
  onFocusChange,
}: ProfilePeekProps) {
  const [open, setOpen] = useState(false);
  const [hoveredAction, setHoveredAction] = useState<"profile" | "message">();
  const profileButton = useRef<HTMLButtonElement>(null);
  const returningFromProfile = useRef<"pending" | "returned" | null>(null);
  const [watchReturnPointer, setWatchReturnPointer] = useState(false);
  const pointerLeft = useRef(false);
  const triggerId = useId();
  const previewId = useId();
  useEffect(() => {
    if (!watchReturnPointer) return;
    // The profile can obscure its trigger, so a real pointer exit may not
    // reach the avatar's leave handler. Observe only during this handoff.
    const track = (event: globalThis.PointerEvent) => {
      const rect = document.getElementById(triggerId)?.getBoundingClientRect();
      // Once the pointer has left, a later return is a fresh visit, even when
      // the hover opens only after the pointer rests back on the avatar.
      if (rect && !pointerLeft.current)
        pointerLeft.current =
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom;
    };
    document.addEventListener("pointermove", track, {
      capture: true,
      passive: true,
    });
    return () => document.removeEventListener("pointermove", track, true);
  }, [watchReturnPointer, triggerId]);
  const focusRegion = {
    onFocus: () => onFocusChange?.(true),
    onBlur: (event: FocusEvent<HTMLElement>) => {
      const next = event.relatedTarget;
      // Window blur retains the browser's return-focus target.
      if (!next && document.activeElement === event.target) return;
      if (
        next instanceof Node &&
        (document.getElementById(triggerId)?.contains(next) ||
          document.getElementById(previewId)?.contains(next))
      )
        return;
      if (returningFromProfile.current === "returned") {
        returningFromProfile.current = null;
        setWatchReturnPointer(false);
      }
      onFocusChange?.(false);
    },
  };
  const presence = usePresenceStatus(
    open ? session?.presence : undefined,
    pubkey,
    true,
  );
  const message = useProfileMessage({
    session,
    pubkey,
    viewer,
    agent,
    enabled: open,
    onOpened(channelId) {
      if (!onOpen(`buzz://channel/${encodeURIComponent(channelId)}`))
        throw new Error("Could not open the conversation. Try again.");
      setOpen(false);
    },
  });
  const openProfile = () => {
    const avatar = document.getElementById(triggerId);
    avatar?.focus();
    setOpen(false);
    returningFromProfile.current = "pending";
    pointerLeft.current = !avatar?.matches(":hover");
    setWatchReturnPointer(true);
    if (!onOpen(target)) {
      returningFromProfile.current = null;
      setWatchReturnPointer(false);
    }
  };
  return (
    <PreviewCard
      trigger={cloneElement(
        trigger as ReactElement<
          {
            id?: string;
            onClick?: () => void;
          } & typeof focusRegion
        >,
        {
          id: triggerId,
          onClick: openProfile,
          ...focusRegion,
          onFocus: () => {
            if (returningFromProfile.current === "pending")
              returningFromProfile.current = "returned";
            focusRegion.onFocus();
          },
        },
      )}
      id={previewId}
      open={open}
      onOpenChange={(next, details) => {
        // Crossing an avatar on the active toolbar's safe pointer route must
        // not put a new preview between the message and its actions.
        const avatar = document.getElementById(triggerId);
        if (
          next &&
          details.reason === "trigger-hover" &&
          document.activeElement !== avatar &&
          avatar?.closest("[data-actions-revealed]")
        ) {
          details.cancel();
          return;
        }
        // Return focus is not a fresh request to preview the same identity.
        if (next && returningFromProfile.current) {
          if (
            returningFromProfile.current === "returned" &&
            details.reason === "trigger-hover" &&
            pointerLeft.current
          ) {
            returningFromProfile.current = null;
            setWatchReturnPointer(false);
          } else {
            details.cancel();
            return;
          }
        }
        if (!next && message.opening && details.reason === "trigger-hover") {
          details.cancel();
          return;
        }
        if (next) setHoveredAction(undefined);
        setOpen(next);
      }}
      side="right"
      className={styles.card ?? ""}
      aria-label={`${name} profile preview`}
      actionRef={profileButton}
    >
      <div className={styles.content} {...focusRegion}>
        <div className={styles.lockup} data-no-picture={!picture || undefined}>
          <div className={styles.backdrop}>
            <ProfileBackdrop src={picture} />
          </div>
          <div className={styles.artwork}>
            <div className={styles.portrait}>
              <AgentAvatar
                session={session}
                agentPubkey={pubkey}
                channelId={channelId}
                src={picture}
                alt=""
                fallback={name}
                size="fill"
                shape={agent ? "squircle" : "circle"}
                statusBadge={presence === "unknown" ? undefined : presence}
              />
            </div>
          </div>
          <div className={styles.identity}>
            <div className={`${styles.name} text-label-sm`}>
              {agent && <RobotIcon aria-label="Agent" size={14} />}
              {name}
            </div>
            {session && <OtherName session={session} pubkey={pubkey} />}
            {session && (
              <UserStatusDisplay
                session={session}
                userId={pubkey}
                size="caption"
              />
            )}
          </div>
        </div>
        <div
          className={styles.actions}
          data-hovered-action={hoveredAction}
          onPointerLeave={() => setHoveredAction(undefined)}
        >
          <IconButton
            ref={profileButton}
            data-profile-action="profile"
            onPointerEnter={(event) => {
              if (event.pointerType !== "touch") setHoveredAction("profile");
            }}
            size="sm"
            shape="round"
            variant="subtle"
            aria-label="View profile"
            onClick={openProfile}
            icon={
              <span className={styles.actionContent}>
                {agent ? <RobotIcon size={16} /> : <UserIcon size={16} />}
                <span className={styles.actionText} aria-hidden="true">
                  Profile
                </span>
              </span>
            }
          />
          {message.available && (
            <IconButton
              size="sm"
              shape="round"
              variant="subtle"
              data-profile-action="message"
              onPointerEnter={(event) => {
                if (event.pointerType !== "touch") setHoveredAction("message");
              }}
              aria-label="Message"
              loading={message.opening}
              onClick={() => void message.open()}
              icon={
                <span className={styles.actionContent}>
                  <ChatCircleIcon size={16} />
                  <span className={styles.actionText} aria-hidden="true">
                    Message
                  </span>
                </span>
              }
            />
          )}
        </div>
        {message.error && (
          <p role="alert" className="text-body-sm text-danger">
            {message.error}
          </p>
        )}
      </div>
    </PreviewCard>
  );
}
