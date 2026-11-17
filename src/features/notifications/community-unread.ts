import type { Communities } from "../communities/service";
import { communityDestination } from "../communities/destination";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import { rowUnread } from "../relay/unread";
import type { OpenTarget } from "../navigation/targets";

/** Notification gates: only conversations they allow count as unread. */
export type UnreadGates = Readonly<{
  allows(target: OpenTarget): boolean;
  subscribe(listener: () => void): () => void;
}>;

/** One community's unread, as its sidebar rows show it. `attention` counts
 * the rows' mentions, DMs and followed-thread replies. */
export type CommunityUnread = Readonly<{ unread: boolean; attention: number }>;

/** Observes one community session's existing unread evidence, never a new read
 * owner. `publish` gets `undefined` until confirmed mutes are known, so an
 * unknown community never reads as all read. With `known`, it also gets
 * `undefined` while the session's live connection is not up (HTTP reads can
 * still succeed without it), while its unread is stale (its connection dropped
 * and no fresh evidence has arrived since, which the reconnect's read or a newly
 * arrived event provides) or no counted channel has observed evidence; channels without it are left out of the count. */
export function observeCommunityUnread(
  session: RelaySession,
  viewer: string,
  communityOrigin: string,
  publish: (state: CommunityUnread | undefined) => void,
  gates?: UnreadGates,
  known = false,
) {
  let closed = false;
  const channels = new Map<string, () => void>();
  const dms = new Set<string>();
  const scope = { viewer, communityOrigin };
  const changed = () => {
    if (closed) return;
    const preferences = session.sidebarPreferences.snapshot();
    if (preferences.status !== "ready" && preferences.status !== "unsupported")
      return publish(undefined);
    if (known && session.live.snapshot().status !== "connected")
      return publish(undefined);
    const muted = new Set(preferences.data?.muted ?? []);
    let unread = false;
    let attention = 0;
    let observed = 0;
    for (const channelId of channels.keys()) {
      const snapshot = session.unread.snapshot({ kind: "channel", channelId });
      if (known) {
        if (snapshot.freshness === "stale") return publish(undefined);
        if (snapshot.coverage !== "observed") continue;
        observed++;
      }
      // Count what the channel's sidebar row shows.
      if (rowUnread(snapshot, dms.has(channelId), muted.has(channelId)))
        unread = true;
      attention += (snapshot.row ?? snapshot).attentionCount ?? 0;
    }
    if (known && !observed) return publish(undefined);
    publish({ unread, attention });
  };
  const roster = () => {
    if (closed) return;
    const ids = new Set(
      session.channels
        .list()
        .channels.filter(
          (channel) =>
            !channel.huddle &&
            !channel.metadataPending &&
            channel.members?.includes(viewer) &&
            (!gates ||
              gates.allows({
                version: 1,
                kind: "conversation",
                scope,
                channelId: channel.id,
              })),
        )
        .map((channel) => {
          if (channel.channelType === "dm") dms.add(channel.id);
          else dms.delete(channel.id);
          return channel.id;
        }),
    );
    for (const [id, stop] of channels) {
      if (ids.has(id)) continue;
      stop();
      channels.delete(id);
    }
    for (const channelId of ids)
      if (!channels.has(channelId))
        channels.set(
          channelId,
          session.unread.subscribe({ kind: "channel", channelId }, changed),
        );
    changed();
  };
  const stopPreferences = session.sidebarPreferences.subscribe(changed);
  const stopRoster = session.channels.subscribeList(roster);
  const stopGates = gates?.subscribe(roster) ?? (() => {});
  const stopLive = known ? session.live.subscribe(changed) : () => {};
  roster();
  return () => {
    if (closed) return;
    closed = true;
    stopPreferences();
    stopRoster();
    stopGates();
    stopLive();
    for (const stop of channels.values()) stop();
    channels.clear();
  };
}

/** Starts `session`'s unread repair once its roster has loaded or failed, or
 * already lists a fresh channel `viewer` belongs to: repair reads only those,
 * and the roster's later channels start another itself. */
function repairOnRoster(
  session: RelaySession,
  viewer: string,
  repaired: () => void,
) {
  const settled = () => {
    const { status, channels } = session.channels.list();
    return (
      status === "ready" ||
      status === "error" ||
      channels.some(
        (channel) => !channel.cached && channel.members?.includes(viewer),
      )
    );
  };
  let stop = () => {};
  const check = () => {
    if (!settled()) return;
    stop();
    void session.unread
      .ensure()
      .catch(() => {})
      .then(repaired);
  };
  stop = session.channels.subscribeList(check);
  check();
  return () => stop();
}

/** Background sessions opened for unread. The native host refuses a 33rd
 * relay socket (`socket.rs`), and each session holds one; the remainder keeps
 * room for the selected community, agents' communities and visits. */
export const BACKGROUND_UNREAD_LIMIT = 24;

/** Background sessions open at a random point in this window, so a fleet of
 * clients restarting together doesn't connect every community in one tick. */
export const BACKGROUND_JITTER_MS = 3000;

/** Unread for joined communities, keyed by community id. It opens the first
 * `BACKGROUND_UNREAD_LIMIT` in the background, plus every community selected
 * this launch, and starts each one's unread repair once, as visiting it would.
 * Each background community opens after its own random delay of up to
 * `BACKGROUND_JITTER_MS`; the selected community opens at once.
 * Communities without a ready session, or whose unread is stale or
 * unobserved, are absent. */
export function createCommunityUnreads(
  communities: Communities,
  gates?: UnreadGates,
) {
  type Entry = {
    relay: RelayData;
    stopRelay: () => void;
    session?: RelaySession | undefined;
    stop?: (() => void) | undefined;
    stopRoster?: (() => void) | undefined;
  };
  const entries = new Map<string, Entry>();
  // Selected communities are retained already; observing them costs no socket.
  const visited = new Set<string>();
  const listeners = new Set<() => void>();
  let states: ReadonlyMap<string, CommunityUnread> = new Map();
  let closed = false;
  // Badges wait for the selected community's first repair: they share its
  // host's connections, so loading them alongside would delay its own unread.
  let foreground = false;
  // Background communities whose start delay has elapsed, for `admittedViewer`.
  const admitted = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let admittedViewer: string | undefined;
  const cancel = (id: string) => {
    clearTimeout(timers.get(id));
    timers.delete(id);
    admitted.delete(id);
  };
  const yieldDone = () => {
    if (foreground) return;
    foreground = true;
    update();
  };
  const set = (id: string, state: CommunityUnread | undefined) => {
    const previous = states.get(id);
    if (
      previous === state ||
      (previous &&
        state &&
        previous.unread === state.unread &&
        previous.attention === state.attention)
    )
      return;
    const next = new Map(states);
    if (state) next.set(id, state);
    else next.delete(id);
    states = next;
    for (const fn of listeners) fn();
  };
  const bind = (id: string, entry: Entry, viewer: string | undefined) => {
    const relay = entry.relay.snapshot();
    const session =
      relay.status === "ready" && viewer && relay.viewer === viewer
        ? relay.session
        : undefined;
    if (session === entry.session) return;
    entry.stop?.();
    entry.stop = undefined;
    entry.stopRoster?.();
    entry.stopRoster = undefined;
    entry.session = session;
    set(id, undefined);
    // Without it, unread holds only messages that arrived since connecting.
    // Repair reads the roster's channels, so it waits for them: one started
    // earlier would settle with no channels read.
    if (session && viewer) {
      entry.stopRoster = repairOnRoster(
        session,
        viewer,
        id === communities.snapshot().selected ? yieldDone : () => {},
      );
      entry.stop = observeCommunityUnread(
        session,
        viewer,
        communityDestination(id).url,
        (state) => set(id, state),
        gates,
        true,
      );
    }
  };
  const drop = (id: string, entry: Entry) => {
    entry.stopRelay();
    entry.stop?.();
    entry.stopRoster?.();
    entries.delete(id);
    set(id, undefined);
  };
  const update = () => {
    if (closed) return;
    const { viewer, memberships, selected, status } = communities.snapshot();
    // Another account's allowances never carry over, even for the same ids.
    if (viewer !== admittedViewer) {
      for (const id of [...timers.keys(), ...admitted]) cancel(id);
      for (const [id, entry] of entries) if (id !== selected) drop(id, entry);
      admittedViewer = viewer;
    }
    if (selected) visited.add(selected);
    // Nothing to yield to when the selected community has no session coming;
    // while restoring, the saved selection is not known yet.
    const relay = selected && communities.relay.snapshot().status;
    if (
      status !== "loading" &&
      (!relay ||
        relay === "error" ||
        relay === "disconnected" ||
        !memberships.some((m) => m.id === selected))
    )
      foreground = true;
    const ids = viewer ? memberships.map((m) => m.id) : [];
    const joined = new Set(
      ids.filter(
        (id, index) => index < BACKGROUND_UNREAD_LIMIT || visited.has(id),
      ),
    );
    for (const id of [...timers.keys(), ...admitted])
      if (!joined.has(id)) cancel(id);
    for (const [id, entry] of entries)
      if (!joined.has(id) || communities.open(id, true) !== entry.relay)
        drop(id, entry);
    for (const id of joined) {
      if (!foreground && id !== selected) continue;
      let entry = entries.get(id);
      if (id === selected) {
        clearTimeout(timers.get(id));
        timers.delete(id);
        admitted.add(id);
      } else if (!entry && !admitted.has(id)) {
        if (!timers.has(id))
          timers.set(
            id,
            setTimeout(() => {
              timers.delete(id);
              if (communities.snapshot().viewer !== viewer) return;
              admitted.add(id);
              update();
            }, Math.random() * BACKGROUND_JITTER_MS),
          );
        continue;
      }
      if (!entry) {
        const relay = communities.open(id, true);
        if (!relay) continue;
        const created: Entry = { relay, stopRelay: () => {} };
        created.stopRelay = relay.subscribe(() =>
          bind(id, created, communities.snapshot().viewer),
        );
        entries.set(id, created);
        entry = created;
      }
      bind(id, entry, viewer);
    }
  };
  const stopCommunities = communities.subscribe(update);
  const stopRelay = communities.relay.subscribe(update);
  update();
  return {
    snapshot: () => states,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (closed) return;
      closed = true;
      stopCommunities();
      stopRelay();
      for (const [id, entry] of entries) drop(id, entry);
      for (const id of [...timers.keys()]) cancel(id);
      listeners.clear();
    },
  };
}

export type CommunityUnreads = ReturnType<typeof createCommunityUnreads>;
