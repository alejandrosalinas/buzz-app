// The session of the conversation an agent's profile was opened from, set
// apart above the agent's other conversations. Types list their own sessions.
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { formatItemTimestamp } from "../../shared/datetime";
import { useClockFormat } from "../../shared/clock-preference";
import styles from "./ActivityLayout.module.css";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { usePanelTabHost } from "../panels/PanelWorkspace";
import { type ChannelLabel, channelIcon } from "../channels/channel-icon";
import type { AgentConversation } from "./service";

type Saved = Readonly<
  Partial<ChannelLabel> & {
    channelId: string;
    root?: string;
    at?: number;
  }
>;

type Place = Readonly<{ channelId: string; root?: string }>;

/** The session for `conversation`: its thread's, else its channel's, which is
 * the one session a channel-scoped agent or a DM keeps. This build's saved
 * session comes first; `find` looks in the type's own history for one another
 * build of the app started, since each build saves its own. That one has no
 * channel name or kind; `label` gives it the channel's current ones each
 * render. */
export function useOpenedSession<T extends Saved>(
  saved: readonly T[],
  conversation: AgentConversation | undefined,
  find: (place: Place, signal: AbortSignal) => Promise<T | undefined>,
  label?: (channelId: string) => ChannelLabel | undefined,
): { session?: T; searching?: boolean; error?: string } {
  const places: Place[] = conversation
    ? [
        ...(conversation.rootId
          ? [{ channelId: conversation.channelId, root: conversation.rootId }]
          : []),
        { channelId: conversation.channelId },
      ]
    : [];
  const bound = (place: Place) =>
    saved.find(
      (item) => item.channelId === place.channelId && item.root === place.root,
    );
  const exact = places[0] && bound(places[0]);
  const key = conversation
    ? `${conversation.channelId}/${conversation.rootId ?? ""}`
    : "";
  const [found, setFound] = useState<{
    key: string;
    session?: T;
    error?: string;
  }>();
  const latest = useRef({ bound, find });
  latest.current = { bound, find };
  // biome-ignore lint/correctness/useExhaustiveDependencies: places follow key; bound and find are read when it runs.
  useEffect(() => {
    if (!key || exact) return;
    const abort = new AbortController();
    void (async () => {
      for (const place of places) {
        let session: T | undefined;
        try {
          session =
            latest.current.bound(place) ??
            (await latest.current.find(place, abort.signal));
        } catch (reason) {
          if (abort.signal.aborted) return;
          return setFound({
            key,
            error: reason instanceof Error ? reason.message : String(reason),
          });
        }
        if (abort.signal.aborted) return;
        if (session) return setFound({ key, session });
      }
      setFound({ key });
    })();
    return () => abort.abort();
  }, [key, !!exact]);
  if (!conversation) return {};
  if (exact) return { session: exact };
  if (found?.key !== key) return { searching: true };
  // The place found stays; its row is the one saved now, since a type gives
  // each render its channel's current name and kind, else the one found,
  // labelled now in the same way.
  const { key: _, session, ...result } = found;
  return session
    ? {
        ...result,
        session: bound(session) ?? {
          ...session,
          ...label?.(session.channelId),
        },
      }
    : result;
}

/** The transcript a type's tab shows over itself as a panel subview, titled
 * `title(row)`. It closes when the profile is retargeted to another
 * conversation, and viewing it again brings its tab back in a tabbed host.
 * `request` asks for the conversation's transcript first. While its session
 * is still `searching`, the transcript opens once found, unless the reader
 * clicks, types or scrolls first, so a late result never takes their place;
 * `request.done` reports that it was offered. A new `request.opening` asks
 * again, even for the conversation already shown. Closing that tab calls
 * `close`, since it was all that was asked for, unless the host is only
 * clearing the profile's own detail tabs. */
export function useOpenTranscript<T>(
  conversation: AgentConversation | undefined,
  title: (row: T) => string,
  request?: {
    initial: T | undefined;
    searching?: boolean | undefined;
    opening: number;
    done(): void;
  },
  close?: () => void,
) {
  const place = conversation
    ? `${conversation.channelId}/${conversation.rootId ?? ""}`
    : "";
  const [shown, setShown] = useState<{
    place: string;
    row: T;
    initial?: true;
  }>();
  // Forgotten, not just hidden: returning to the first conversation must not
  // reopen it unasked. A new request opens it again in the same one.
  const opening = request?.opening;
  const [offered, setOffered] = useState<{ place: string; opening?: number }>({
    place: "",
  });
  // The place whose asked-for session is still being looked up.
  const [waiting, setWaiting] = useState<string>();
  const moved = offered.place !== place;
  const fresh = opening !== undefined && opening !== offered.opening;
  if (moved || fresh) {
    setOffered({ place, ...(opening !== undefined && { opening }) });
    // Only a new opening asks; moving to another conversation drops it.
    const asked =
      fresh && place && request?.initial !== undefined
        ? { place, row: request.initial, initial: true as const }
        : undefined;
    if (moved || asked) setShown(asked);
    setWaiting(
      fresh && !asked && place && request?.searching ? place : undefined,
    );
  } else if (waiting !== undefined) {
    if (waiting !== place || !request) setWaiting(undefined);
    else if (request.initial !== undefined) {
      setWaiting(undefined);
      setShown({ place, row: request.initial, initial: true });
    } else if (!request.searching) setWaiting(undefined);
  }
  const pending = !!place && waiting === place;
  // The reader's own click, key press or scroll wins over a lookup still
  // finishing.
  useEffect(() => {
    if (!pending) return;
    const cancel = () => setWaiting(undefined);
    const events = ["pointerdown", "keydown", "wheel"] as const;
    for (const type of events)
      document.addEventListener(type, cancel, { capture: true, passive: true });
    return () => {
      for (const type of events)
        document.removeEventListener(type, cancel, true);
    };
  }, [pending]);
  const tabs = usePanelTabHost();
  // A transcript already open in its tab is brought forward when asked again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opening, after its lookup.
  useEffect(() => {
    if (!request || pending) return;
    if (tabs && shown?.initial && shown.place === place)
      tabs.activate(tabs.owner, title(shown.row));
    request.done();
  }, [opening, pending]);
  return {
    open: shown?.place === place ? shown.row : undefined,
    show(row: T) {
      setWaiting(undefined);
      setShown({ place, row });
      tabs?.activate(tabs.owner, title(row));
    },
    back(options?: { keepOwner?: boolean }) {
      if (tabs && close && shown?.initial && !options?.keepOwner) close();
      else setShown(undefined);
    },
  };
}

/** A session's channel as the sidebar shows it: its icon and plain name, or
 * the start of its id alone when the community does not list it, since its
 * kind is unknown then. */
export function ConversationName({
  session,
  title,
  className = "",
}: {
  session: Saved;
  /** The hover text; the name alone by default. */
  title?: string;
  className?: string;
}) {
  const Icon = session.name === undefined ? undefined : channelIcon(session);
  return (
    <span
      className={`flex min-w-0 items-center gap-1 overflow-hidden ${className}`}
      title={title ?? (session.name || session.channelId)}
    >
      {Icon && <Icon size={16} className="shrink-0" aria-hidden="true" />}
      <span className="truncate">
        {session.name || session.channelId.slice(0, 8)}
      </span>
    </span>
  );
}

export function OpenedConversation({
  conversation,
  harness,
  session,
  searching,
  error,
  status,
  detail,
  onView,
}: {
  conversation: AgentConversation;
  /** The type's name for its sessions, e.g. Codex. */
  harness: string;
  session: Saved | undefined;
  /** Still looking for a session another build of the app started. */
  searching?: boolean | undefined;
  /** Why the search failed. */
  error?: string | undefined;
  /** The session's live state, when it is running. */
  status?: string | undefined;
  /** More about that state, as the type shows it for its other sessions. */
  detail?: ReactNode;
  onView(): void;
}) {
  useClockFormat();
  const id = useId();
  const place = (session ? session.root : conversation.rootId)
    ? "thread"
    : "channel";
  return (
    <section aria-labelledby={id} className={styles.section}>
      <InlineHeader id={id} title={`This ${place}`} />
      <SettingsGroup layout="form">
        {/* The detail sits with its row, as in a type's own session lists. */}
        <div className="grid gap-2">
          <div className={styles.row}>
            {session ? (
              <>
                <span className={styles.copy}>
                  <ConversationName
                    session={session}
                    className="text-label-sm"
                  />
                  <span className="block text-body-sm text-subtle">
                    {[
                      status,
                      session.at &&
                        `Last active ${formatItemTimestamp(session.at / 1000, { withTime: true })}`,
                    ]
                      .filter(Boolean)
                      .join(" · ") || `${harness} session`}
                  </span>
                </span>
                <Button
                  variant="subtle"
                  size="sm"
                  aria-label={`View transcript: ${session.name || session.channelId.slice(0, 8)}`}
                  onClick={onView}
                >
                  View transcript
                </Button>
              </>
            ) : searching ? (
              <span role="status" className="text-body-sm text-subtle">
                Looking for a {harness} session…
              </span>
            ) : error ? (
              <span role="alert" className="text-body-sm">
                Could not look for a {harness} session: {error}
              </span>
            ) : (
              <span className="grid gap-1">
                <span className="text-label">
                  No {harness} session here yet
                </span>
                <span className="text-body-sm text-subtle">
                  One starts when you mention the agent in this {place}.
                </span>
              </span>
            )}
          </div>
          {session && detail}
        </div>
      </SettingsGroup>
    </section>
  );
}
