import { isTransientFailure } from "./errors";
import { createRecovery } from "./recovery";
import type { UploadedAttachment } from "./attachments";
import { byteSize } from "./budget";
import {
  EMOJI_SET,
  EMOJI_SET_KIND,
  communityEmoji,
  contentEmojiTags,
  emojiTags,
  normalizeShortcode,
  referencedEmoji,
  type CustomEmoji,
} from "./emoji";
import { eventDto, newer, type RelayEvent } from "./events";
import type { Priority, RelayReader } from "./reader";
import type { RelayWriter } from "./transport";

export type EmojiSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  entries: readonly CustomEmoji[];
  /** The viewer's own latest set: the only one this client may republish. */
  mine: readonly CustomEmoji[];
  error?: string | undefined;
  /** The error is a failure session recovery retries; see recovery.ts. */
  transient?: true | undefined;
}>;
export type EmojiAuthoring = Readonly<{
  writer: RelayWriter;
  upload?(file: File, signal: AbortSignal): Promise<UploadedAttachment>;
}>;
const LIMIT = 500;
const MAX_BYTES = 2 * 1024 * 1024;
/** Community-owned latest complete member sets, including empty replacement evidence.
 * No LRU eviction: forgetting a replacement can resurrect a removed shortcode. */
export function createEmojiDirectory(
  reader: RelayReader,
  notify = (listener: () => void) => listener(),
  viewer?: string,
  authoring?: EmojiAuthoring,
) {
  const sets = new Map<string, { event: RelayEvent; bytes: number }>();
  const listeners = new Set<() => void>();
  let bytes = 0,
    closed = false,
    requested = false,
    limited = false;
  let controller: AbortController | undefined;
  let pending: Promise<void> | undefined;
  let pendingPriority: Priority = "background";
  /** Recovery hears when a read ends, even one that publishes nothing. */
  const settled = new Set<() => void>();
  const lifetime = new AbortController();
  let editing: Promise<unknown> = Promise.resolve();
  let snapshot: EmojiSnapshot = Object.freeze({
    status: "idle",
    entries: Object.freeze([]),
    mine: Object.freeze([]),
  });
  function publish(patch: Partial<EmojiSnapshot> = {}) {
    snapshot = Object.freeze({ ...snapshot, ...patch });
    for (const listener of listeners) notify(listener);
  }
  function accept(incoming: readonly RelayEvent[]) {
    if (closed || limited) return;
    let changed = false;
    for (const event of incoming) {
      if (
        event.kind !== 30030 ||
        event.tags.find(([name]) => name === "d")?.[1] !== EMOJI_SET
      )
        continue;
      const old = sets.get(event.pubkey);
      if (newer(old?.event, event) === old?.event) continue;
      const size = byteSize(event);
      if (
        (!old && sets.size >= LIMIT) ||
        bytes - (old?.bytes ?? 0) + size > MAX_BYTES
      ) {
        limited = true;
        publish({
          status: "error",
          entries: Object.freeze([]),
          mine: Object.freeze([]),
          transient: undefined,
          error:
            "Community emoji exceeds the catalog budget. Retry after reducing the catalog.",
        });
        return;
      }
      sets.set(event.pubkey, { event, bytes: size });
      bytes += size - (old?.bytes ?? 0);
      changed = true;
    }
    if (!changed) return;
    publish({
      entries: Object.freeze(
        communityEmoji([...sets.values()].map(({ event }) => event)),
      ),
      mine: viewer
        ? emojiTags(sets.get(viewer)?.event ?? { tags: [] })
        : snapshot.mine,
    });
  }
  /** Passive demand yields to other reads. An explicit retry runs in the
   * foreground and supersedes a passive load, which can spend its whole deadline
   * queued behind background profile reads without reaching the relay. */
  function load(priority: Priority): Promise<void> {
    if (closed) return Promise.resolve();
    requested = true;
    if (pending && (priority === "background" || pendingPriority === priority))
      return pending;
    controller?.abort();
    pendingPriority = priority;
    // Explicit recovery starts a new bounded read after overflow. Never expose a
    // partially retained set as ready; live replacements during this read still win.
    if (limited) {
      sets.clear();
      bytes = 0;
      limited = false;
    }
    const owned = new AbortController();
    controller = owned;
    // A loaded catalog stays ready while it revalidates: sends keep their tags
    // and pickers their custom category. Only a cold catalog shows loading.
    if (snapshot.status !== "ready")
      publish({ status: "loading", error: undefined, transient: undefined });
    else if (snapshot.error)
      publish({ error: undefined, transient: undefined });
    pending = (async () => {
      try {
        const events = await reader.read(
          [{ kinds: [30030], "#d": [EMOJI_SET], limit: LIMIT }],
          { signal: owned.signal, priority },
        );
        if (closed || owned.signal.aborted) return;
        accept(events);
        if (closed || owned.signal.aborted || limited) return;
        // NIP-01 relays return the newest events first under a limit, so a
        // capped read holds the latest sets and still resolves their shortcodes.
        publish({
          status: "ready",
          error:
            events.length >= LIMIT
              ? "Community emoji catalog may be incomplete (500-set read limit). Retry after reducing the catalog."
              : undefined,
        });
      } catch (error) {
        // A failed revalidation keeps the loaded catalog, with its error.
        if (!closed && !owned.signal.aborted)
          publish({
            status: snapshot.status === "ready" ? "ready" : "error",
            error: String(error),
            transient: isTransientFailure(error) || undefined,
          });
      } finally {
        if (controller === owned) {
          controller = undefined;
          pending = undefined;
          for (const listener of [...settled]) listener();
        }
      }
    })();
    return pending;
  }
  const refresh = () => load("foreground");
  function ensure(priority: Priority = "background") {
    // Active controls may remount on every keystroke. Promote passive demand
    // once; after an active failure, keep the error and explicit Retry stable.
    if (
      !limited &&
      (snapshot.status === "idle" ||
        (priority === "foreground" &&
          pendingPriority === "background" &&
          snapshot.status !== "ready"))
    )
      return load(priority);
    return pending ?? Promise.resolve();
  }
  /** Read-modify-write of the viewer's own set; an absent URL removes the shortcode. */
  async function publishEdit(
    writer: RelayWriter,
    shortcode: string,
    url?: string,
  ): Promise<string> {
    const failure =
      url === undefined ? "Failed to remove emoji." : "Failed to add emoji.";
    if (!viewer) throw new Error(failure);
    const timeout = AbortSignal.timeout(12_000);
    const signal = AbortSignal.any([lifetime.signal, timeout]);
    try {
      const own = await reader.read(
        [
          {
            kinds: [EMOJI_SET_KIND],
            "#d": [EMOJI_SET],
            authors: [viewer],
            limit: 1,
          },
        ],
        { signal, fresh: true },
      );
      signal.throwIfAborted();
      accept(own);
      // A capped or refused catalog must not hide the latest own set from replacement.
      let current = sets.get(viewer)?.event;
      for (const event of own)
        if (
          event.pubkey === viewer &&
          event.kind === EMOJI_SET_KIND &&
          event.tags.find(([name]) => name === "d")?.[1] === EMOJI_SET
        )
          current = newer(current, event);
      const ownEntries = emojiTags(current ?? { tags: [] });
      const entries = ownEntries.filter(
        (entry) => entry.shortcode !== shortcode,
      );
      if (url === undefined && entries.length === ownEntries.length)
        return shortcode;
      if (url !== undefined) entries.push({ shortcode, url });
      const template = {
        kind: EMOJI_SET_KIND,
        created_at: Math.max(
          Math.floor(Date.now() / 1000),
          (current?.created_at ?? 0) + 1,
        ),
        content: "",
        tags: [
          ["d", EMOJI_SET],
          ...entries.map((entry) => ["emoji", entry.shortcode, entry.url]),
        ],
      };
      const event = eventDto(await writer.sign(template, signal));
      if (
        event.pubkey !== viewer ||
        event.kind !== template.kind ||
        event.created_at !== template.created_at ||
        event.content !== template.content ||
        JSON.stringify(event.tags) !== JSON.stringify(template.tags)
      )
        throw new Error(failure);
      signal.throwIfAborted();
      await writer.publish(event, signal);
      signal.throwIfAborted();
      accept([event]);
      return shortcode;
    } catch {
      throw new Error(
        timeout.aborted
          ? url === undefined
            ? "Timed out while removing emoji."
            : "Timed out while adding emoji."
          : failure,
      );
    }
  }
  const queries = Object.freeze({
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ensure,
    refresh,
    ...(authoring
      ? {
          /** Removes only from the viewer's set; absent or invalid names are no-ops. */
          remove(name: string): Promise<void> {
            const shortcode = normalizeShortcode(name);
            if (!shortcode) return Promise.resolve();
            if (closed)
              return Promise.reject(new Error("Failed to remove emoji."));
            const run = editing.then(() =>
              publishEdit(authoring.writer, shortcode),
            );
            editing = run.catch(() => undefined);
            return run.then(() => undefined);
          },
        }
      : {}),
    ...(authoring?.upload
      ? {
          upload: authoring.upload,
          /** Adds or replaces one shortcode; returns the normalized shortcode. */
          add(name: string, url: string): Promise<string> {
            const shortcode = normalizeShortcode(name);
            if (!shortcode)
              return Promise.reject(
                new Error(
                  "Invalid emoji name. Use letters, numbers, hyphen, or underscore.",
                ),
              );
            if (closed)
              return Promise.reject(new Error("Failed to add emoji."));
            // Serialize edits so a stale relay read cannot undo an earlier edit.
            const run = editing.then(() =>
              publishEdit(authoring.writer, shortcode, url),
            );
            editing = run.catch(() => undefined);
            return run;
          },
        }
      : {}),
  });
  function clear() {
    controller?.abort();
    controller = undefined;
    pending = undefined;
    sets.clear();
    bytes = 0;
    limited = false;
    publish({
      status: "idle",
      entries: Object.freeze([]),
      mine: Object.freeze([]),
      error: undefined,
      transient: undefined,
    });
    // Authority can cancel the initial optional read. Restart once per clear, not per render.
    if (requested && !closed)
      queueMicrotask(() => {
        if (!closed) void ensure();
      });
  }
  function reconnect() {
    if (!requested || closed) return;
    controller?.abort();
    controller = undefined;
    pending = undefined;
    void load("background");
  }
  // The catalog's only retry owner: a transient failure, cold or of a ready
  // catalog's refresh, retries with the shared capped backoff until it loads.
  // A read in flight is busy, so a ready catalog's refresh keeps the backoff.
  // Session recovery stays out of it; its state and notice describe the
  // relay connection. Equal jitter keeps clients that failed together, as on
  // a relay restart, from retrying in step.
  const recovery = createRecovery(
    [
      {
        status: () =>
          snapshot.transient ? "failed" : pending ? "busy" : "settled",
        subscribe(listener) {
          const stop = queries.subscribe(listener);
          settled.add(listener);
          return () => {
            stop();
            settled.delete(listener);
          };
        },
        retry: () => void refresh(),
      },
    ],
    {
      setTimeout: (callback, ms) =>
        globalThis.setTimeout(callback, ms * (0.5 + Math.random() / 2)),
      clearTimeout: (handle) =>
        globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  );
  return {
    queries,
    accept,
    clear,
    reconnect,
    /** A continuous profiles replay delivered every set change since the last
     * connection heard the relay, so a complete ready catalog stays as it is.
     * Anything else, a read still out from before the drop included, reads
     * again as on any reconnect. */
    resume() {
      if (pending || snapshot.status !== "ready" || snapshot.error || limited)
        reconnect();
    },
    tags(content: string): string[][] {
      const codes = referencedEmoji(content);
      if (!codes.length) return [];
      if (closed) throw new Error("Community session is closed");
      if (snapshot.status !== "ready") {
        // A send retries a cold failure, but passive mounts cannot repeat
        // reads; refresh() shares a pending one. Overflow would repeat on every
        // read, so it waits for an explicit retry. The composer keeps this text
        // after the read settles, so it must not claim the read is still running.
        void (snapshot.status === "error" && !limited ? refresh() : ensure());
        throw new Error(
          snapshot.status === "error"
            ? `Community emoji unavailable. Retry message preparation or open the emoji picker. ${snapshot.error ?? ""}`
            : "Community emoji isn't ready. Your draft is kept; try sending again shortly.",
        );
      }
      return contentEmojiTags(content, snapshot.entries);
    },
    dispose() {
      closed = true;
      recovery.dispose();
      lifetime.abort();
      clear();
      listeners.clear();
    },
  };
}
