import type {
  ChannelQueries,
  ChannelMessage,
  ChannelSummary,
} from "./contracts";
import type { RelayEvent } from "./events";
import type { RelayReader } from "./reader";
import { byteSize } from "./budget";
import { eventVisibility } from "./event-access";
import { foldMessages, messageAuthor } from "./fold";
import { validReactionContent } from "./emoji";

export type InboxReaction = Readonly<{
  id: string;
  channelId: string;
  message: ChannelMessage;
  events: readonly RelayEvent[];
  createdAt: number;
}>;
export type ReactionFeedSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  items: readonly InboxReaction[];
  error?: string | undefined;
}>;
const newest = (a: RelayEvent, b: RelayEvent) =>
  b.created_at - a.created_at || a.id.localeCompare(b.id);
const targetOf = (event: RelayEvent) => {
  const refs = event.tags.filter(([name]) => name === "e");
  return refs.length === 1 && /^[0-9a-f]{64}$/.test(refs[0]?.[1] ?? "")
    ? refs[0]?.[1]
    : undefined;
};

/** Bounded addressed reaction evidence. No message reading intent or counters.
 * The reader supplies verified events; reference/access admission happens only
 * after exact targets and their edit/deletion closure have been resolved. */
export function createInboxReactions({
  reader,
  viewer,
  channels,
  relayAuthor = "",
  signingAuthority,
  notify,
}: {
  reader: RelayReader;
  viewer: string;
  channels: ChannelQueries;
  relayAuthor?: string | undefined;
  signingAuthority?: string | undefined;
  notify: (listener: () => void) => void;
}) {
  let snapshot: ReactionFeedSnapshot = { status: "idle", items: [] };
  const listeners = new Set<() => void>();
  const arrivals = new Set<(event: RelayEvent) => void>();
  const seen = new Set<string>();
  const pending = new Map<string, RelayEvent>();
  const live = new Set<string>();
  let retained: readonly RelayEvent[] = [];
  const overlays = new Map<string, RelayEvent>();
  let known = new Set<string>();
  let controller: AbortController | undefined;
  let work: Promise<void> | undefined;
  let closed = false;
  let requested = false;
  let dirty = false;
  const eligible = (event: RelayEvent) =>
    event.kind === 7 &&
    event.pubkey !== viewer &&
    !!targetOf(event) &&
    validReactionContent(event.content) &&
    event.tags.some(([name, value]) => name === "p" && value === viewer);
  const allowedChannel = (channel: ChannelSummary) =>
    !channel.cached &&
    !channel.archived &&
    !channel.huddle &&
    !channel.metadataPending &&
    channel.members?.includes(viewer);
  const allowed = (id: string) =>
    channels
      .list()
      .channels.some((channel) => channel.id === id && allowedChannel(channel));
  function publish(next: ReactionFeedSnapshot) {
    if (closed) return;
    snapshot = Object.freeze(next);
    for (const listener of listeners) notify(listener);
  }
  async function closure(
    ids: readonly string[],
    kinds: number[],
    signal: AbortSignal,
  ) {
    if (!ids.length) return [];
    const result: RelayEvent[] = [];
    let cursor: { until: number; before_id: string } | undefined;
    for (;;) {
      const page = [
        ...(await reader.read([{ kinds, "#e": ids, limit: 500, ...cursor }], {
          signal,
        })),
      ].sort(newest);
      signal.throwIfAborted();
      const previous = cursor;
      if (
        previous &&
        page.some(
          (event) =>
            event.created_at > previous.until ||
            (event.created_at === previous.until &&
              event.id <= previous.before_id),
        )
      )
        throw new Error("Reaction updates did not advance. Retry activity.");
      result.push(...page);
      if (result.length > 2000 || byteSize(result) > 4 * 1024 * 1024)
        throw new Error(
          "Reaction updates exceed the read budget. Retry activity.",
        );
      const last = page.at(-1);
      if (!last) return result;
      cursor = { until: last.created_at, before_id: last.id };
    }
  }
  async function load(signal: AbortSignal) {
    const candidates = [
      ...(await reader.read([{ kinds: [7], "#p": [viewer], limit: 50 }], {
        signal,
      })),
      ...pending.values(),
      ...retained,
    ].filter(eligible);
    signal.throwIfAborted();
    const reactions = [
      ...new Map(candidates.map((event) => [event.id, event])).values(),
    ]
      .sort(newest)
      .slice(0, 100);
    const ids = [...new Set(reactions.map((event) => targetOf(event) ?? ""))];
    const targets = ids.length
      ? await reader.read(
          [{ ids, kinds: [9, 40002, 40008], limit: ids.length }],
          { signal },
        )
      : [];
    signal.throwIfAborted();
    // Missing, foreign and revoked targets never establish a reaction row.
    const owned = targets.filter(
      (event) =>
        ids.includes(event.id) &&
        messageAuthor(event, signingAuthority) === viewer &&
        event.tags.filter(([name]) => name === "h").length === 1 &&
        allowed(event.tags.find(([name]) => name === "h")?.[1] ?? ""),
    );
    const ownedIds = new Set(owned.map((event) => event.id));
    const relevant = reactions.filter((event) => {
      const target = owned.find((target) => target.id === targetOf(event));
      const hs = event.tags.filter(([name]) => name === "h");
      return (
        !!target &&
        (hs.length === 0 ||
          (hs.length === 1 &&
            hs[0]?.[1] === target.tags.find(([name]) => name === "h")?.[1]))
      );
    });
    const updates = await closure(
      [...ownedIds, ...relevant.map((event) => event.id)],
      [40003, 5, 9005],
      signal,
    );
    const edits = updates.filter((event) => event.kind === 40003);
    const editDeletes = await closure(
      edits.map((event) => event.id),
      [5, 9005],
      signal,
    );
    signal.throwIfAborted();
    const evidence = [...owned, ...relevant, ...updates, ...editDeletes];
    const closureIds = new Set(evidence.map((event) => event.id));
    const currentOverlays: RelayEvent[] = [];
    // Retain only overlays connected to this candidate window. A deletion
    // spanning a current and an unknown target still fails closed below.
    for (;;) {
      const connected = [...overlays.values()].filter(
        (event) =>
          !closureIds.has(event.id) &&
          event.tags.some(
            ([name, id]) => name === "e" && closureIds.has(id ?? ""),
          ),
      );
      if (!connected.length) break;
      for (const event of connected) closureIds.add(event.id);
      currentOverlays.push(...connected);
    }
    evidence.push(...currentOverlays);
    if (byteSize(evidence) > 8 * 1024 * 1024)
      throw new Error(
        "Reaction activity exceeds the read budget. Retry activity.",
      );
    const byId = new Map(evidence.map((event) => [event.id, event]));
    const visible = eventVisibility(allowed, (id) => byId.get(id));
    if (
      [...updates, ...editDeletes, ...currentOverlays].some(
        (event) => !visible(event),
      )
    )
      throw new Error("Reaction updates are incomplete. Retry activity.");
    const admitted = evidence.filter(visible);
    const items: InboxReaction[] = [];
    for (const channelId of new Set(
      owned.map((event) => event.tags.find(([n]) => n === "h")?.[1] ?? ""),
    )) {
      for (const message of foldMessages(channelId, relayAuthor, admitted, {
        includeReplies: true,
        signingAuthority,
      })) {
        const active = new Set(
          message.reactions.flatMap((group) =>
            group.events.map((event) => event.id),
          ),
        );
        const events = relevant.filter(
          (event) => targetOf(event) === message.id && active.has(event.id),
        );
        const latest = events[0];
        if (latest)
          items.push(
            Object.freeze({
              id: `reaction:${message.id}`,
              channelId,
              message,
              events: Object.freeze(events),
              createdAt: latest.created_at,
            }),
          );
      }
    }
    items.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    known = new Set(evidence.map((event) => event.id));
    retained = reactions;
    for (const reaction of reactions) pending.delete(reaction.id);
    publish({ status: "ready", items: Object.freeze(items) });
    signal.throwIfAborted();
    for (const item of items)
      for (const event of item.events) {
        signal.throwIfAborted();
        if (live.delete(event.id) && !seen.has(event.id)) {
          seen.add(event.id);
          for (const listener of arrivals) notify(() => listener(event));
        }
        seen.add(event.id);
      }
    // Dedupe memory is bounded to the retained window, not a durable read marker.
    if (seen.size > 1000)
      for (const id of [...seen].slice(0, seen.size - 1000)) seen.delete(id);
    for (const event of reactions) live.delete(event.id);
  }
  function refresh() {
    if (closed) return Promise.resolve();
    requested = true;
    if (work) {
      dirty = true;
      return work;
    }
    const owned = new AbortController();
    controller = owned;
    work = Promise.resolve()
      .then(async () => {
        do {
          dirty = false;
          await load(owned.signal);
        } while (dirty && !owned.signal.aborted);
      })
      .catch((error: unknown) => {
        if (closed || owned.signal.aborted) return;
        // Never retain a potentially deleted preview after settlement fails.
        publish({
          status: "error",
          items: [],
          error:
            error instanceof Error
              ? error.message
              : "Reaction activity unavailable",
        });
        live.clear();
      })
      .finally(() => {
        if (controller === owned) {
          controller = undefined;
          work = undefined;
        }
      });
    publish({ ...snapshot, status: "loading", error: undefined });
    return work;
  }
  function clear() {
    controller?.abort();
    controller = undefined;
    work = undefined;
    pending.clear();
    live.clear();
    overlays.clear();
    known.clear();
    retained = [];
    seen.clear();
    publish({ status: "idle", items: [] });
  }
  const availableChannels = () =>
    new Set(
      channels
        .list()
        .channels.filter(allowedChannel)
        .map((channel) => channel.id),
    );
  let available = availableChannels();
  const stop = channels.subscribeList(() => {
    const next = availableChannels();
    const restored = [...next].some((id) => !available.has(id));
    available = next;
    const items = snapshot.items.filter((item) => next.has(item.channelId));
    if (items.length !== snapshot.items.length) publish({ ...snapshot, items });
    if (requested && restored) void refresh();
  });
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeArrival(listener: (event: RelayEvent) => void) {
      arrivals.add(listener);
      return () => {
        arrivals.delete(listener);
      };
    },
    ensure: () =>
      work ?? (snapshot.status === "idle" ? refresh() : Promise.resolve()),
    refresh,
    receive(events: readonly RelayEvent[], phase?: "live" | "replay") {
      if (closed) return;
      let changed = false;
      const ids = new Set([
        ...known,
        ...pending.keys(),
        ...events
          .filter(eligible)
          .flatMap((event) => [event.id, targetOf(event) ?? ""]),
        ...retained.map((event) => event.id),
        ...retained.map((event) => targetOf(event) ?? ""),
        ...[...pending.values()].map((event) => targetOf(event) ?? ""),
      ]);
      for (const event of events) {
        if (eligible(event)) {
          if (seen.has(event.id) || pending.has(event.id)) continue;
          pending.set(event.id, event);
          if (phase === "live") live.add(event.id);
          changed = true;
        } else if (
          [5, 9005, 40003].includes(event.kind) &&
          event.tags.some(([name, id]) => name === "e" && ids.has(id ?? ""))
        ) {
          overlays.set(event.id, event);
          const oldest = overlays.keys().next().value;
          if (overlays.size > 2000 && oldest) overlays.delete(oldest);
          // Withhold stale previews immediately, before asynchronous settlement.
          publish({ ...snapshot, items: [] });
          changed = true;
        }
      }
      if (pending.size > 100) {
        for (const event of [...pending.values()].sort(newest).slice(100)) {
          pending.delete(event.id);
          live.delete(event.id);
        }
      }
      if (changed) void refresh();
    },
    clear,
    reconnect() {
      if (requested) void refresh();
    },
    dispose() {
      clear();
      closed = true;
      stop();
      listeners.clear();
      arrivals.clear();
    },
  };
}
