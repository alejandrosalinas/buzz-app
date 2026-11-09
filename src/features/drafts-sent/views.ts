import { useEffect, useRef, useState } from "react";
import type { ReadFilter } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";
import {
  CONTEXT_KINDS,
  DELETION_IDS,
  DELETION_KINDS,
  DELETION_VIEWS,
  ROOM_LIMIT,
  THREAD_LIMIT,
  coverageFloor,
  deletionFilters,
  retentionFloor,
} from "./context";
import {
  SENT_LIMIT,
  UPDATE_KINDS,
  UPDATE_LIMIT,
  type ReadEvent,
} from "./model";

type View = ReturnType<RelaySession["observe"]>;
export type ViewState = {
  status: "idle" | "loading" | "ready" | "error";
  events: readonly ReadEvent[];
  error?: string | undefined;
};
const noop = () => {};

/** A live view of the viewer's own messages: new sends arrive without a refresh. */
export function useSent(session: RelaySession, viewer: string) {
  const [sent, setSent] = useState<ViewState>({
    status: "loading",
    events: [],
  });
  const refresh = useRef<() => void>(noop);
  useEffect(() => {
    let view: View;
    try {
      // Own edits and deletions ride along, so each message reads as it does in Buzz now.
      view = session.observe([
        { kinds: [9], authors: [viewer], limit: SENT_LIMIT },
        { kinds: UPDATE_KINDS, authors: [viewer], limit: UPDATE_LIMIT },
      ]);
    } catch {
      setSent({ status: "error", events: [], error: "unavailable" });
      return;
    }
    const update = () => setSent(view.snapshot());
    const stop = view.subscribe(update);
    update();
    refresh.current = () => void view.refresh();
    void view.refresh();
    return () => {
      refresh.current = noop;
      stop();
      view.dispose();
    };
  }, [session, viewer]);
  return { sent, refresh };
}

type Group = {
  filters: ReadFilter[];
  keys: string[];
  of: (event: ReadEvent) => string[];
  floor: (
    events: readonly ReadEvent[],
    conversation: readonly ReadEvent[],
  ) => number;
};
const isMessage = (event: ReadEvent) => CONTEXT_KINDS.includes(event.kind);
const tagValues = (event: ReadEvent, name: string) =>
  event.tags.flatMap((tag) => (tag[0] === name && tag[1] ? [tag[1]] : []));

/**
 * Live, bounded views of the conversations around the listed messages: threads and replies
 * in one, DM and Solo chats four to a view. Re-created only when the set of conversations changes.
 *
 * Readiness is per conversation and tied to the evidence shown for it: a conversation is
 * `ready` only once a view covering it has fully loaded, and its events are kept from that
 * load. While a re-created view reloads (or if it fails), each conversation keeps its last
 * loaded events, and one it has never loaded shows no status rather than a guess.
 *
 * A read is bounded, so `ready` also gives each conversation's coverage floor: its events
 * are complete only for times after it (`-Infinity` when the read didn't reach its limit,
 * and the host's byte and event caps didn't evict any).
 */
export function useActivity(
  session: RelaySession,
  threads: ReadFilter[],
  rooms: ReadFilter[][],
) {
  const key = JSON.stringify([threads, rooms]);
  const [state, setState] = useState<{
    events: readonly ReadEvent[];
    ready: ReadonlyMap<string, number>;
  }>({ events: [], ready: new Map() });
  // Conversation key (thread root, post id or chat id) → its events and coverage floor from the latest complete load.
  const evidence = useRef<{
    session?: RelaySession;
    byKey: Map<string, { events: readonly ReadEvent[]; floor: number }>;
  }>({ byKey: new Map() });
  const refresh = useRef<() => void>(noop);
  useEffect(() => {
    if (evidence.current.session !== session)
      evidence.current = { session, byKey: new Map() };
    const known = evidence.current.byKey;
    const [threadFilters, roomGroups] = JSON.parse(key) as [
      ReadFilter[],
      ReadFilter[][],
    ];
    const groups: Group[] = [];
    if (threadFilters.length) {
      const keys = threadFilters.flatMap((filter) => filter["#e"] ?? []);
      const wanted = new Set(keys);
      groups.push({
        filters: threadFilters,
        keys,
        of: (event) => [event.id, ...tagValues(event, "e")],
        // One limit is shared by every thread: the whole reply read sets each one's floor.
        floor: (events) =>
          coverageFloor(
            events.filter(
              (event) =>
                isMessage(event) &&
                tagValues(event, "e").some((id) => wanted.has(id)),
            ),
            THREAD_LIMIT,
          ),
      });
    }
    for (const filters of roomGroups)
      groups.push({
        filters,
        keys: filters.flatMap((filter) => filter["#h"] ?? []),
        of: (event) => tagValues(event, "h"),
        // Each chat has its own limit.
        floor: (_, conversation) =>
          coverageFloor(conversation.filter(isMessage), ROOM_LIMIT),
      });
    const covered = new Set(groups.flatMap((group) => group.keys));
    for (const stale of [...known.keys()])
      if (!covered.has(stale)) known.delete(stale);
    const views = groups.map((group) => {
      try {
        return session.observe(group.filters);
      } catch {
        return undefined;
      }
    });
    const update = () => {
      const events: ReadEvent[] = [];
      views.forEach((view, i) => {
        const group = groups[i];
        if (!group) return;
        const snapshot = view?.snapshot();
        const live = new Map(group.keys.map((k) => [k, [] as ReadEvent[]]));
        for (const event of snapshot?.events ?? [])
          for (const k of new Set(group.of(event))) live.get(k)?.push(event);
        for (const [k, list] of live) {
          if (snapshot?.status === "ready")
            known.set(k, {
              events: list,
              floor: Math.max(
                group.floor(snapshot.events, list),
                retentionFloor(snapshot.events),
              ),
            });
          // Not loaded yet: the last complete load, or what's arrived so far (shown without a status).
          events.push(...(known.get(k)?.events ?? list));
        }
      });
      setState({
        events,
        ready: new Map(
          [...known]
            .filter(([k]) => covered.has(k))
            .map(([k, { floor }]) => [k, floor]),
        ),
      });
    };
    const stops = views.map((view) => view?.subscribe(update));
    update();
    refresh.current = () => {
      for (const view of views) void view?.refresh();
    };
    refresh.current();
    return () => {
      refresh.current = noop;
      for (const stop of stops) stop?.();
      for (const view of views) view?.dispose();
    };
  }, [session, key]);
  return { ...state, refresh };
}

type Read = { targets: ReadonlySet<string>; view?: View; stop?: () => void };
const close = (read: Read) => {
  read.stop?.();
  read.view?.dispose();
};

/**
 * Live deletions of the given messages, so a reply someone deleted stops counting. Views are
 * kept as messages come and go: a new message gets a view of its own, and reads already in
 * flight carry on, so a busy conversation can't keep restarting them. When too many small
 * views pile up they're rebuilt as a few full ones. Deletions already seen are kept.
 */
export function useDeletions(session: RelaySession, ids: readonly string[]) {
  const key = ids.slice(0, DELETION_IDS).join(",");
  const [deletions, setDeletions] = useState<readonly ReadEvent[]>([]);
  const reads = useRef<{
    session?: RelaySession;
    views: Read[];
    kept: Map<string, ReadEvent>;
  }>({ views: [], kept: new Map() });
  const refresh = useRef<() => void>(noop);
  useEffect(() => {
    if (reads.current.session !== session) {
      reads.current.views.forEach(close);
      reads.current = { session, views: [], kept: new Map() };
    }
    const state = reads.current;
    const wanted = new Set(key ? key.split(",") : []);
    const update = () => {
      for (const { view } of state.views)
        for (const event of view?.snapshot().events ?? [])
          if (DELETION_KINDS.includes(event.kind))
            state.kept.set(event.id, event);
      setDeletions([...state.kept.values()]);
    };
    const open = (filters: ReadFilter[]): Read => {
      const read: Read = {
        targets: new Set(filters.flatMap((filter) => filter.ids ?? [])),
      };
      try {
        read.view = session.observe(filters);
        read.stop = read.view.subscribe(update);
        void read.view.refresh();
      } catch {
        // Unavailable: that view's deletions stay unknown.
      }
      return read;
    };
    // Drop views whose messages have all left; keep every other read running.
    state.views = state.views.filter((read) => {
      const keep = [...read.targets].some((id) => wanted.has(id));
      if (!keep) close(read);
      return keep;
    });
    const covered = new Set(state.views.flatMap((read) => [...read.targets]));
    const missing = [...wanted].filter((id) => !covered.has(id));
    if (missing.length) {
      const added = deletionFilters(missing);
      if (state.views.length + added.length > DELETION_VIEWS) {
        state.views.forEach(close);
        state.views = deletionFilters([...wanted]).map(open);
      } else state.views.push(...added.map(open));
    }
    for (const [id, deletion] of [...state.kept])
      if (
        !deletion.tags.some(
          ([name, value]) => name === "e" && wanted.has(value ?? ""),
        )
      )
        state.kept.delete(id);
    refresh.current = () => {
      for (const { view } of state.views) void view?.refresh();
    };
    update();
  }, [session, key]);
  useEffect(
    () => () => {
      reads.current.views.forEach(close);
      reads.current = { views: [], kept: new Map() };
      refresh.current = noop;
    },
    [],
  );
  return { deletions, refresh };
}
