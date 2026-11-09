import { createInboxReactions } from "./inbox-reactions";
import { byteSize } from "./budget";
import type { ChannelQueries } from "./contracts";
import type { RelayEvent, ReadFilter } from "./events";
import type { RelayReader } from "./reader";

const mentionKinds = [9, 40002];
const cursorOf = (event: RelayEvent) => ({
  until: event.created_at,
  before_id: event.id,
});
const older = (event: RelayEvent, cursor: ReturnType<typeof cursorOf>) =>
  event.created_at < cursor.until ||
  (event.created_at === cursor.until && event.id > cursor.before_id);
export type InboxFeedSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  error?: string | undefined;
  /** Exact addressed targets whose stored edits/deletions are not settled. */
  incomplete: readonly string[];
}>;

/** The session owns finite, verified, viewer-addressed history. No new live route,
 * polling, or parallel channel store. Current membership gates completeness targets. */
export function createInboxFeed({
  viewer,
  reactionReader,
  relayAuthor,
  signingAuthority,
  channels,
  reader,
  addressedRead,
  retainedEvent,
  retainedEditIds,
  notify = (listener) => listener(),
}: {
  viewer: string;
  reactionReader?: RelayReader;
  relayAuthor?: string | undefined;
  signingAuthority?: string | undefined;
  channels: ChannelQueries;
  reader: RelayReader;
  /** Private lookups in the existing bounded unread evidence owner. */
  retainedEvent: (id: string) => RelayEvent | undefined;
  retainedEditIds: (ids: readonly string[]) => readonly string[];
  /** Verified session admission calls prepare before publishing unread evidence. */
  addressedRead: (
    filter: ReadFilter,
    signal: AbortSignal,
    prepare: (events: readonly RelayEvent[]) => void,
  ) => Promise<readonly RelayEvent[]>;
  notify?: (listener: () => void) => void;
}) {
  const reactions = createInboxReactions({
    reader: reactionReader ?? reader,
    viewer,
    channels,
    relayAuthor,
    signingAuthority,
    notify,
  });
  let closed = false;
  let epoch = 0;
  let work: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let requested = false;
  let snapshot: InboxFeedSnapshot = Object.freeze({
    status: "idle",
    incomplete: [],
  });
  const listeners = new Set<() => void>();
  // Metadata can hide a row without revoking access. Settle its overlays before
  // later ordinary metadata can reveal the retained mention.
  const admitted = (event: RelayEvent) => {
    if (!event.tags.some(([name, value]) => name === "p" && value === viewer))
      return false;
    const hs = event.tags.filter(([name]) => name === "h");
    return (
      hs.length === 0 ||
      (hs.length === 1 &&
        channels
          .list()
          .channels.some(
            (channel) =>
              channel.id === hs[0]?.[1] &&
              !channel.huddle &&
              !channel.cached &&
              channel.members?.includes(viewer),
          ))
    );
  };
  function project(events: readonly RelayEvent[]) {
    return Object.freeze(
      events.filter(
        (event) => mentionKinds.includes(event.kind) && admitted(event),
      ),
    );
  }
  function publish(patch: Partial<InboxFeedSnapshot>) {
    if (closed) return;
    snapshot = Object.freeze({
      ...snapshot,
      ...patch,
    });
    for (const listener of listeners) notify(listener);
  }
  async function overlays(
    ids: readonly string[],
    kinds: readonly number[],
    signal: AbortSignal,
  ) {
    if (!ids.length) return [];
    const collected: RelayEvent[] = [];
    let cursor: ReturnType<typeof cursorOf> | undefined;
    for (;;) {
      const page = [
        ...(await reader.read(
          [
            {
              kinds,
              "#e": ids,
              limit: 500,
              ...(cursor ?? {}),
            },
          ],
          { signal },
        )),
      ].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
      const previous = cursor;
      if (previous && page.some((event) => !older(event, previous)))
        throw new Error("Inbox message updates did not advance. Retry inbox.");
      collected.push(...page);
      if (collected.length > 2000 || byteSize(collected) > 4 * 1024 * 1024)
        throw new Error(
          "Inbox message updates exceed the read budget. Retry inbox.",
        );
      const last = page.at(-1);
      if (!last) return collected;
      cursor = cursorOf(last);
      // Authorized responses can have short pages. Only empty ends the walk.
    }
  }
  async function refresh() {
    if (closed) return;
    if (work) return work;
    requested = true;
    const generation = epoch;
    const owned = new AbortController();
    controller = owned;
    // Do not clear incomplete targets on retry: the new first read can re-admit
    // the old body before its stored overlays are checked again.
    work = (async () => {
      try {
        // Bounded addressed chat history; nonchat and approvals belong elsewhere.
        const mentionFilter: ReadFilter = {
          kinds: mentionKinds,
          "#p": [viewer],
          limit: 50,
        };
        const mentions = await addressedRead(
          mentionFilter,
          owned.signal,
          (events) => {
            if (closed || generation !== epoch || owned.signal.aborted) return;
            const ids = project(events).map((event) => event.id);
            if (ids.length)
              publish({
                incomplete: Object.freeze([
                  ...new Set([...snapshot.incomplete, ...ids]),
                ]),
              });
          },
        );
        if (closed || generation !== epoch) return;
        // Retry older failed targets even when newer addressed rows pushed them
        // beyond the latest page; never clear an unchecked exact ID.
        const targets = [
          ...new Set([
            ...snapshot.incomplete,
            ...project(mentions).map((event) => event.id),
          ]),
        ];
        const updates = await overlays(targets, [40003, 5, 9005], owned.signal);
        const edits = updates.filter((event) => event.kind === 40003);
        await overlays(
          [
            ...new Set([
              ...retainedEditIds(targets),
              ...edits.map((event) => event.id),
            ]),
          ],
          [5, 9005],
          owned.signal,
        );
        if (closed || generation !== epoch) return;
        publish({
          status: "ready",
          incomplete: [],
          error: undefined,
        });
      } catch (error) {
        if (closed || generation !== epoch || owned.signal.aborted) return;
        publish({
          status: "error",
          error:
            error instanceof Error
              ? error.message
              : "Inbox history unavailable",
        });
      }
    })().finally(() => {
      if (controller === owned) {
        controller = undefined;
        work = undefined;
      }
    });
    if (generation === epoch && controller === owned)
      publish({ status: "loading", error: undefined });
    return work;
  }
  function clear(incomplete: readonly string[] = []) {
    reactions.clear();
    epoch++;
    controller?.abort();
    controller = undefined;
    work = undefined;
    // Previously demanded data recovers explicitly or through reconnect.
    publish({ status: "idle", incomplete, error: undefined });
  }
  const retainedIncomplete = () =>
    Object.freeze(snapshot.incomplete.filter((id) => retainedEvent(id)));
  return Object.freeze({
    reactions,
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ensure: () =>
      work ?? (snapshot.status === "idle" ? refresh() : Promise.resolve()),
    refresh,
    stale() {
      epoch++;
      controller?.abort();
      controller = undefined;
      work = undefined;
      publish({
        status: "idle",
        incomplete: retainedIncomplete(),
        error: undefined,
      });
    },
    reconnect() {
      reactions.reconnect();
      if (requested) void refresh();
    },
    clear: () => clear(),
    purge: () => clear(retainedIncomplete()),
    dispose() {
      reactions.dispose();
      closed = true;
      epoch++;
      controller?.abort();
      controller = undefined;
      work = undefined;
      // Retained capabilities expose no retired content; do not notify dead consumers.
      snapshot = Object.freeze({
        status: "idle",
        incomplete: [],
      });
      listeners.clear();
    },
  });
}
