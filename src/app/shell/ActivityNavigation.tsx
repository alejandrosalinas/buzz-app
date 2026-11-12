import {
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { RegisteredPage } from "../../features/pages/service";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  useRelayConnection,
  useChannelRoster,
} from "../../features/relay/react";
import { emojiTags } from "../../features/relay/emoji";
import { isUnicodeEmojiOnly } from "../../features/messages/emoji-size";
import {
  ACTIVITY_PAGE,
  ActivityEmojiContext,
  type ActivityEmoji,
} from "./activity-context";
import styles from "./ActivityNavigation.module.css";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function ActivityNavigationProvider({
  relay,
  pages,
  children,
}: {
  relay: RelayData;
  pages: readonly RegisteredPage[];
  children: ReactNode;
}) {
  const connection = useRelayConnection(relay);
  return (
    <ActivityReactionScope
      session={connection.session}
      enabled={
        connection.status === "ready" &&
        pages.some((page) => page.key === ACTIVITY_PAGE)
      }
    >
      {children}
    </ActivityReactionScope>
  );
}

/** One lifetime and one hold for every placement of the Activity icon. */
export function ActivityReactionScope({
  session,
  enabled,
  children,
}: {
  session: RelaySession;
  enabled: boolean;
  children: ReactNode;
}) {
  const [emoji, setEmoji] = useState<ActivityEmoji>();
  const channels = useChannelRoster(session.channels);
  const feed = session.inboxFeed.reactions;
  const snapshot = useSyncExternalStore(feed.subscribe, feed.snapshot);
  useEffect(() => {
    if (enabled && channels.status === "ready" && snapshot.status === "idle")
      void feed.ensure();
  }, [enabled, channels.status, snapshot.status, feed]);
  useEffect(() => {
    if (!enabled) {
      setEmoji(undefined);
      return;
    }
    setEmoji(undefined);
    let busy = false;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let image: HTMLImageElement | undefined;
    const cancel = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (image) {
        image.onload = null;
        image.onerror = null;
        image = undefined;
      }
      busy = false;
    };
    const hide = () => {
      if (document.visibilityState !== "visible") {
        cancel();
        setEmoji(undefined);
      }
    };
    const stop = feed.subscribeArrival((event) => {
      if (disposed || busy || document.visibilityState !== "visible") return;
      const custom = emojiTags(event).find(
        (entry) => event.content.toLowerCase() === `:${entry.shortcode}:`,
      );
      const source = custom ? session.media(custom.url) : undefined;
      if (
        custom
          ? !source
          : !isUnicodeEmojiOnly(event.content) ||
            [...graphemes.segment(event.content)].length !== 1
      )
        return;
      busy = true;
      const show = () => {
        if (disposed || !busy || document.visibilityState !== "visible") {
          cancel();
          return;
        }
        if (timer !== undefined) clearTimeout(timer);
        setEmoji({ content: event.content, source, active: true });
        timer = setTimeout(() => {
          cancel();
          setEmoji((current) =>
            current ? { ...current, active: false } : undefined,
          );
        }, 3000);
      };
      if (!source) {
        show();
        return;
      }
      image = new Image();
      image.onload = show;
      image.onerror = cancel;
      timer = setTimeout(cancel, 1000);
      image.src = source;
    });
    document.addEventListener("visibilitychange", hide);
    return () => {
      disposed = true;
      stop();
      cancel();
      document.removeEventListener("visibilitychange", hide);
    };
  }, [enabled, feed, session]);
  return (
    <ActivityEmojiContext value={enabled ? emoji : undefined}>
      {children}
    </ActivityEmojiContext>
  );
}

/** Activity is a Messages sidebar row (presentation.ts), so its icon, and
 * the latest reaction emoji that replaces it, fill the row's icon slot. */
export function ActivityNavigationIcon({ children }: { children: ReactNode }) {
  const emoji = useContext(ActivityEmojiContext);
  return (
    <span
      className={styles.icon}
      data-active={emoji?.active || undefined}
      aria-hidden="true"
    >
      <span className={styles.bell}>{children}</span>
      {emoji && (
        <span className={styles.emoji}>
          {emoji.source ? (
            <img src={emoji.source} alt="" draggable={false} />
          ) : (
            emoji.content
          )}
        </span>
      )}
    </span>
  );
}
