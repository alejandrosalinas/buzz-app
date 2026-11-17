import referenceStyles from "../../shared/InlineReference.module.css";
import { workflowLabel } from "../relay/workflow-attribution";
import {
  useCallback,
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { RelaySession } from "../relay/session";
import type { ForwardSnapshot } from "../relay/forwarded-message";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { LockIcon, RobotIcon } from "../../shared/design-system/icons";
import { avatarMedia } from "../../shared/avatar-source";
import { useForwardSource } from "./use-forward-source";
import styles from "./ForwardedMessage.module.css";

const noop = () => () => {};
const noProfile = () => undefined;
export function ForwardedMessage({
  snapshot,
  session,
  children,
  attachments,
  onOpenLink,
  compact = false,
  fill = false,
}: {
  snapshot: ForwardSnapshot;
  session: RelaySession | undefined;
  children: ReactNode;
  attachments?: ReactNode;
  onOpenLink?(url: string): void;
  compact?: boolean;
  fill?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const source = useForwardSource(session, snapshot.channelId, snapshot.id);
  const profile = useSyncExternalStore(
    session?.profiles.subscribe ?? noop,
    session
      ? () => session.profiles.snapshot().get(snapshot.authorId)
      : noProfile,
    noProfile,
  );
  useEffect(() => {
    void session?.profiles
      .ensure?.([snapshot.authorId], "background")
      .catch(() => {});
  }, [session, snapshot.authorId]);
  const authorLabel = snapshot.workflow
    ? workflowLabel(snapshot.authorName)
    : snapshot.authorName;
  const date = new Date(snapshot.createdAt * 1000);
  const time = date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const reference = source.reference;
  const known = reference.state === "found" && reference.readable !== false;
  const sourceName = known
    ? reference.channelType === "dm"
      ? "Direct message"
      : reference.channelType === "solo"
        ? "Solo chat"
        : `#${reference.name}`
    : "Private conversation";
  // Collapse by rendered height so wrapped prose and code follow the same limit.
  const [overflows, setOverflows] = useState(false);
  const measureBody = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const measure = () =>
      setOverflows(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    // biome-ignore lint/a11y/useSemanticElements: This labelled message group is content, not a fieldset of form controls.
    <section
      role="group"
      className={styles.card}
      data-fill={fill || undefined}
      aria-label={`Forwarded message from ${authorLabel}, ${time}`}
    >
      <span className="text-label-sm">
        <span aria-hidden="true">↪ </span>Forwarded
      </span>
      <div className={styles.byline}>
        <Avatar
          alt=""
          fallback={authorLabel}
          src={
            snapshot.workflow
              ? null
              : avatarMedia(profile?.picture, session?.media)
          }
          size="small"
          shape={profile?.isAgent ? "squircle" : "circle"}
        />
        <span className={`${styles.byline} text-label-sm`}>
          {profile?.isAgent && <RobotIcon size={14} aria-label="Agent" />}{" "}
          {authorLabel}
        </span>
        <time
          className="text-body-sm text-subtle"
          dateTime={date.toISOString()}
        >
          {time}
        </time>
      </div>
      <span className={`${styles.source} text-body-sm text-subtle`}>
        {!known && <LockIcon size={14} aria-hidden="true" />} {sourceName}
      </span>
      <div
        id={contentId}
        className={styles.body}
        data-compact={compact || undefined}
        data-expanded={expanded || undefined}
        data-overflows={overflows || undefined}
        ref={measureBody}
        onFocusCapture={() => setExpanded(true)}
      >
        {children}
      </div>
      {(overflows || expanded) && (
        <Button
          size="inline"
          variant="subtle"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Show full message"}
        </Button>
      )}
      {attachments}
      {source.row && onOpenLink && (
        <span className="text-caption">
          <button
            type="button"
            className={referenceStyles.link}
            onClick={() =>
              onOpenLink(
                `buzz://message?${new URLSearchParams({ channel: snapshot.channelId, id: snapshot.id })}`,
              )
            }
          >
            View original
          </button>
        </span>
      )}
      {reference.state === "found" && source.unavailable && (
        <span className="text-body-sm text-subtle">Original unavailable</span>
      )}
    </section>
  );
}
