import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  type StatusInput,
  type UserStatus,
  USER_STATUS_KIND,
} from "../../features/relay/user-status";
import type { Focus, FocusStatusRecord } from "./state";

export const FOCUS_STATUS = Object.freeze({ text: "Focusing", emoji: "🔭" });

const isFocusStatus = (status: UserStatus | undefined) =>
  status?.text === FOCUS_STATUS.text && status.emoji === FOCUS_STATUS.emoji;

/** The viewer's newest status event, including a clear or an expired one. The
 * Buzz relay keeps expired events. */
async function latestStatusEvent(session: RelaySession, viewer: string) {
  const events = await session.readRemote([
    {
      kinds: [USER_STATUS_KIND],
      "#d": ["general"],
      authors: [viewer],
      limit: 1,
    },
  ]);
  // Same replacement order as the status store: newest, then lowest id.
  return events
    .filter(
      (event) =>
        event.pubkey === viewer && !event.tags.some(([key]) => key === "h"),
    )
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))[0];
}
type StatusEvent = Awaited<ReturnType<typeof latestStatusEvent>>;

const isFocusEvent = (event: NonNullable<StatusEvent>) =>
  event.content.trim() === FOCUS_STATUS.text &&
  (event.tags.find(([key]) => key === "emoji")?.[1] ?? "").trim() ===
    FOCUS_STATUS.emoji;

/** Whether the newest status event is still the telescope `record` set. No
 * event counts as Focus's, so on a relay that drops expired events a newer
 * status that also expired cannot be told apart. */
const focusOwnsStatus = (latest: StatusEvent, record: FocusStatusRecord) =>
  !latest ||
  (isFocusEvent(latest) &&
    (record.published === undefined || latest.created_at === record.published));

/** Sets the telescope status in the selected community when Focus starts and
 * puts back what it replaced when Focus ends, if 🔭 is still the latest status.
 * The status expires on its own at the deadline even if this app is closed. */
export function bindFocusStatus(
  focus: Focus,
  relay: RelayData,
  report: (error: unknown) => void = (error) =>
    console.warn("Focus status", error),
) {
  let closed = false;
  let again = false;
  // One attempt per Focus deadline and connection: a failed set is retried
  // when the connection comes back, not on every relay change.
  let failedUntil: number | undefined;
  let savedUntil: number | undefined;
  const connected = () => {
    const { status, cached } = relay.snapshot();
    return status === "ready" && !cached;
  };
  let wasConnected = connected();
  const step = async () => {
    const { session, status, scope, viewer, cached } = relay.snapshot();
    if (status !== "ready" || cached || !scope || !viewer) return;
    const statuses = session.statuses;
    if (!statuses.writable) return;
    const { until, status: record } = focus.snapshot();
    // This community's record, from this Focus or one still waiting to restore.
    const carried = record?.scope === scope ? record : undefined;
    // A record from an earlier Focus that never got back to its community does
    // not block this one. A set that may not have landed is tried again.
    if (
      until !== undefined &&
      failedUntil !== until &&
      savedUntil !== until &&
      (record?.until !== until ||
        (carried?.until === until && carried.published === undefined))
    ) {
      failedUntil = until;
      const latest = await latestStatusEvent(session, viewer);
      if (closed || focus.snapshot().until !== until) return;
      let previous: StatusInput | null;
      if (carried?.until === until && latest?.id !== carried.replaced) {
        // Something was published since the earlier set for this Focus. If it
        // is that set's telescope, which landed without an answer, adopt it;
        // a status from another device is left alone.
        const landed =
          latest &&
          isFocusEvent(latest) &&
          latest.tags.find(([key]) => key === "expiration")?.[1] ===
            String(until);
        focus.recordStatus(
          landed
            ? { ...carried, published: latest.created_at }
            : { ...carried, previous: null },
        );
        failedUntil = undefined;
        savedUntil = until;
        return;
      }
      if (carried?.until === until) {
        // The earlier set never landed and nothing replaced what it would.
        previous = carried.previous;
      } else if (carried && focusOwnsStatus(latest, carried)) {
        // An earlier Focus's telescope, expired or not: keep what it replaced.
        previous = carried.previous;
      } else {
        const current = await statuses.current(viewer);
        if (closed || focus.snapshot().until !== until) return;
        previous =
          !isFocusStatus(current) && current && (current.text || current.emoji)
            ? {
                text: current.text,
                emoji: current.emoji,
                ...(current.expiresAt === undefined
                  ? {}
                  : { expiresAt: current.expiresAt }),
              }
            : null;
      }
      // Remember first: a crash or a failed save that still reached the
      // relay keeps the old status to restore.
      // `replaced` tells a retry whether anything was published since.
      focus.recordStatus({
        until,
        scope,
        previous,
        ...(latest ? { replaced: latest.id } : {}),
      });
      await statuses.save({ ...FOCUS_STATUS, expiresAt: until });
      failedUntil = undefined;
      savedUntil = until;
      // Remember which event is Focus's, so a later status is never undone.
      const published = statuses.snapshot().get(viewer);
      const saved = focus.snapshot().status;
      if (published && isFocusStatus(published) && saved?.until === until)
        focus.recordStatus({ ...saved, published: published.updatedAt });
    } else if (until === undefined && record?.scope === scope) {
      const owned = focusOwnsStatus(
        await latestStatusEvent(session, viewer),
        record,
      );
      if (closed || focus.snapshot().until !== undefined) return;
      if (owned) {
        const now = Date.now() / 1000;
        const previous = record.previous;
        const live =
          previous &&
          (previous.expiresAt === undefined || previous.expiresAt > now)
            ? previous
            : undefined;
        // An expired telescope already shows nothing; one ended early is cleared.
        if (live) await statuses.save(live);
        else if (isFocusStatus(statuses.snapshot().get(viewer)))
          await statuses.save({ text: "", emoji: "" });
      }
      focus.recordStatus(undefined);
    }
  };
  let loop: Promise<void> | undefined;
  const sync = (): Promise<void> => {
    if (loop) {
      again = true;
      return loop;
    }
    loop = (async () => {
      do {
        again = false;
        try {
          await step();
        } catch (error) {
          if (!closed) report(error);
        }
      } while (again && !closed);
    })().finally(() => {
      loop = undefined;
      if (again && !closed) void sync();
    });
    return loop;
  };
  const stopFocus = focus.subscribe(() => void sync());
  const stopRelay = relay.subscribe(() => {
    const now = connected();
    if (now && !wasConnected) failedUntil = undefined;
    wasConnected = now;
    void sync();
  });
  void sync();
  const stop = () => {
    closed = true;
    stopFocus();
    stopRelay();
  };
  return Object.assign(stop, {
    /** Finishes the status work Focus's current state calls for, then stops. */
    async settle() {
      await sync();
      // A change during the last step reruns the loop; finish that too.
      while (loop) await loop;
      stop();
    },
  });
}

/** Focus lets through only conversations their own community lists as Solo;
 * `community` is that community's retained session state, if any. */
export function soloConversation(
  community: RelaySnapshot | undefined,
  target: { kind: string; channelId?: string },
) {
  if (target.kind !== "conversation" || !target.channelId) return false;
  return (
    community?.status === "ready" &&
    community.session.channels
      .list()
      .channels.some(
        (channel) =>
          channel.id === target.channelId && channel.channelType === "solo",
      )
  );
}
