import { createVerifiedProfileDirectory } from "./verified-profile-directory";
import type {
  VerifiedProfileAuthority,
  VerifiedProfileFilter,
  VerifiedProfileSink,
} from "./verified-profile";
import { retryRead } from "./read-retry";
import { attestedOwner } from "../agents/owner-attestation";
import { hasEventProof } from "./events";
import type { Outbox } from "./outbox";
import {
  ByteLru,
  PROFILE_CACHE_BASE,
  PROFILE_CACHE_MAX,
  PROFILE_ENTRY_BYTES,
} from "./budget";
import type { Profile } from "./contracts";
import type { RelayEvent } from "./events";
import { newer } from "./events";
import { foldProfiles } from "./profiles";
import type { Priority, RelayReader } from "./reader";

/** Shared profile reads for any feature, independent of channel history. */
export interface ProfileQueries {
  snapshot(): ReadonlyMap<string, Profile>;
  subscribe(listener: () => void): () => void;
  /** Fetch missing profiles; optional enrichment can yield to conversation reads. */
  ensure(ids: readonly string[], priority?: Priority): Promise<void>;
  /** The winning signed kind 0 retained for one identity, for provenance checks. */
  event?(pubkey: string): RelayEvent | undefined;
  /** Identities a completed read found no profile for, until one arrives. */
  unnamed?(): ReadonlySet<string>;
  /** Cryptographically verified owner of the retained signed profile head. */
  owner?(pubkey: string): string | undefined;
  /** Moves each time a full cache clear or dispose drops every loaded profile.
   * A channel access change keeps profiles, so it does not move this. A view
   * that ensured the identities it shows must ensure them again: the clear
   * notifies after it removes content, so only names still on screen are
   * reread. */
  generation?(): number;
  /** Room for `members` more profiles while a view of that many people is
   * open, within the hard limit. Growth is immediate. After a release, the
   * next task returns the limit to the largest remaining reservation and
   * evicts the least recently used profiles past it. */
  reserve?(members: number): () => void;
  /** Profiles the cache can hold now; one ensure may ask for at most this many. */
  limit?(): number;
  /** Moves when the budget drops loaded profiles or a shrink cancels
   * background reads asked for before the release. A view that requested names
   * once and skips repeats must request again after it moves. */
  evictions?(): number;
  /** The community's current verified-profile authority, or undefined while
   * it advertises none. Subscribers are notified when it changes. */
  verifiedAuthority?(): VerifiedProfileAuthority | undefined;
  /** Whether the shared verified directory holds a head for `pubkey`. Its
   * profile's `verified`, present or not, then outranks a search's answer:
   * a newer inactive or malformed head revokes an older name. */
  verifiedHeld?(pubkey: string): boolean;
  /** Moves with every change to the shared verified heads, including one that
   * leaves every profile as it was (a first inactive head), and notifies. */
  verifiedRevision?(): number;
  /** Whether a `verifiedRevision()` after `revision` accepted a head for
   * `pubkey`, even one the cache evicted before publishing it. Past what it
   * remembers it answers yes, never no for a head it accepted. */
  verifiedSince?(pubkey: string, revision: number): boolean;
}

/** Authors per profile read, the reader's largest page. A page that fills it
 * may have left out authors who do have a profile. */
const PROFILE_PAGE = 500;

/** One bounded source of signed profile events. Display values are derived from it. */
export function createProfileDirectory(
  reader: RelayReader,
  local?: Pick<Outbox, "snapshot" | "subscribe">,
  notify = (listener: () => void) => listener(),
  verification?: {
    authority?: VerifiedProfileAuthority | undefined;
    refresh?:
      | ((signal: AbortSignal) => Promise<VerifiedProfileAuthority | null>)
      | undefined;
    subscribe(
      filter: VerifiedProfileFilter,
      sink: VerifiedProfileSink,
    ): (() => void) | undefined;
  },
) {
  let limit = PROFILE_CACHE_BASE;
  const events = new ByteLru<RelayEvent>(limit, limit * PROFILE_ENTRY_BYTES);
  // One entry per open view; the largest sets the limit.
  const reservations = new Set<{ members: number }>();
  let shrinking: ReturnType<typeof setTimeout> | undefined;
  const owners = new WeakMap<RelayEvent, string>();
  type Batch = {
    work: Promise<void>;
    authors: string[];
    priority: Priority;
    reading: boolean;
    refresh: boolean;
    cancel: AbortController;
    // The release count when it was asked for; a shrink cancels a background
    // read once a release follows.
    readonly releases: number;
  };
  const pending = new Map<string, Batch>();
  // The batch each read attempt's signal belongs to, so the session's accept
  // of that read's answer can be told apart from live traffic.
  const attempts = new WeakMap<AbortSignal, Batch>();
  // Background reads a shrink cancelled; counted with evictions.
  let cancelled = 0;
  // Reservations released so far.
  let releases = 0;
  // Whether a shrink cancels this read: a background read, not a reconnect
  // refresh, asked for before the latest release.
  function shrinkCancels(batch: Batch) {
    return (
      batch.priority === "background" &&
      !batch.refresh &&
      batch.releases !== releases
    );
  }
  const listeners = new Set<() => void>();
  let snapshot: ReadonlyMap<string, Profile> = new Map();
  // Replaced, never mutated, so stores can compare it like `snapshot`.
  let unnamed: ReadonlySet<string> = new Set();
  // Absences this connection has read. Background enrichment does not
  // reread them: the live profiles route delivers a later kind 0. Scheduling
  // state only; `unnamed` is what consumers see, and it survives reconnect.
  const absent = new Set<string>();
  // Keys with kind-0 metadata. A verified-only overlay must not satisfy ensure.
  let loaded: ReadonlySet<string> = new Set();
  let controller = new AbortController();
  let closed = false;
  let generation = 0;
  // Verified heads arrive one relay frame at a time, and each publish refolds
  // every profile. Coalesce them to one publish per macrotask so socket frames,
  // input and paint run between refolds instead of behind a burst.
  let verifiedFlush: ReturnType<typeof setTimeout> | undefined;
  let verifiedRevision = 0;
  // The revision that published each subject's latest accepted head, oldest
  // first, so a search can tell a head the cache has already dropped.
  const acceptedAt = new Map<string, number>();
  let forgottenAt = 0;
  const verified =
    verification &&
    createVerifiedProfileDirectory(
      verification.authority,
      verification.subscribe,
      () => {
        verifiedFlush ??= setTimeout(() => {
          verifiedFlush = undefined;
          verifiedRevision++;
          for (const subject of verified?.takeAccepted() ?? []) {
            acceptedAt.delete(subject);
            acceptedAt.set(subject, verifiedRevision);
          }
          for (const [subject, revision] of acceptedAt) {
            if (acceptedAt.size <= PROFILE_CACHE_MAX) break;
            acceptedAt.delete(subject);
            forgottenAt = revision;
          }
          if (!closed) publish();
        });
      },
      verification.refresh,
    );
  // A background read of many pages publishes once, when its pages settle:
  // every publish refolds all profiles and wakes every listener, and an open
  // mention menu re-ranks its whole roster on each one. The session accepts
  // each page before the read returns it, with that read's signal. Live
  // traffic has no read signal and publishes at once.
  let folded = false;
  function flush() {
    if (folded && !closed) publish(true);
  }
  function accept(incoming: readonly RelayEvent[], read?: AbortSignal) {
    take(incoming, !!read && attempts.get(read)?.priority === "background");
  }
  function take(incoming: readonly RelayEvent[], fold: boolean) {
    if (closed) return;
    let changed = false;
    const attested: Promise<boolean>[] = [];
    for (const event of incoming) {
      if (event.kind !== 0) continue;
      const previous = events.peek(event.pubkey);
      if (newer(previous, event) === previous) continue;
      events.set(event.pubkey, event);
      absent.delete(event.pubkey);
      if (hasEventProof(event))
        attested.push(
          attestedOwner(event).then((owner) => {
            if (closed || events.peek(event.pubkey) !== event || !owner)
              return false;
            owners.set(event, owner);
            return true;
          }),
        );
      changed = true;
    }
    if (changed && fold) folded = true;
    else if (changed) publish(true);
    // One notification per batch: every publish refolds all profiles, and
    // listeners refold every cached channel.
    if (attested.length)
      void Promise.all(attested).then((settled) => {
        if (!closed && settled.some(Boolean)) publish(true);
      });
  }
  let publishedAuthority: VerifiedProfileAuthority | undefined;
  let publishedRevision = 0;
  /** Notifies on display changes, on winning-event changes for `event()`
   * readers, and on verified-authority and head changes for
   * `verifiedAuthority()`, `verifiedHeld()` and `verifiedRevision()`. */
  function publish(headChanged = false) {
    folded = false;
    const next = foldProfiles([
      ...events.keys().flatMap((id) => {
        const event = events.peek(id);
        return event ? [event] : [];
      }),
      ...((closed ? undefined : local)
        ?.snapshot()
        .filter((item) => item.event.kind === 0 && item.delivery !== "failed")
        .map((item) => item.event) ?? []),
    ]);
    loaded = new Set(next.keys());
    for (const [id, value] of verified?.snapshot() ?? []) {
      const { nameIsFallback: _fallback, ...base } = next.get(id) ?? {};
      next.set(
        id,
        Object.freeze({
          ...base,
          name: value.displayName,
          username: value.username,
          verified: value,
        }),
      );
    }
    // Qualify all namesakes in the shared directory, including self-declared
    // names that imitate a verified name. This carries through string consumers.
    // Counted once per publish: a pairwise scan is quadratic in a large roster.
    const verifiedNames = new Map<string, number>();
    const verifiedUsernames = new Map<string | undefined, number>();
    for (const [, { verified, username }] of next)
      if (verified) {
        const name = verified.displayName;
        verifiedNames.set(name, (verifiedNames.get(name) ?? 0) + 1);
        verifiedUsernames.set(
          username,
          (verifiedUsernames.get(username) ?? 0) + 1,
        );
      }
    for (const [id, profile] of next) {
      const own = profile.verified ? 1 : 0;
      const duplicate =
        (verifiedNames.get(profile.verified?.displayName ?? profile.name) ??
          0) > own ||
        (!!profile.verified &&
          (verifiedUsernames.get(profile.username) ?? 0) > own);
      if (duplicate)
        next.set(
          id,
          Object.freeze({
            ...profile,
            name: `${profile.name} (${id.slice(0, 10)})`,
          }),
        );
    }
    for (const [id, value] of next) {
      const old = snapshot.get(id);
      if (
        old?.name === value.name &&
        old?.nameIsFallback === value.nameIsFallback &&
        old?.username === value.username &&
        old?.picture === value.picture &&
        old?.about === value.about &&
        old?.nip05 === value.nip05 &&
        old?.isAgent === value.isAgent &&
        old?.ownerPubkey === value.ownerPubkey &&
        (old?.verified === value.verified ||
          JSON.stringify(old?.verified) === JSON.stringify(value.verified))
      )
        next.set(id, old);
    }
    if (
      next.size !== snapshot.size ||
      [...next].some(([id, value]) => snapshot.get(id) !== value)
    ) {
      snapshot = next;
      if ([...unnamed].some((id) => next.has(id)))
        unnamed = new Set([...unnamed].filter((id) => !next.has(id)));
    } else if (
      !headChanged &&
      publishedAuthority === verified?.authority() &&
      publishedRevision === verifiedRevision
    )
      return;
    publishedAuthority = verified?.authority();
    publishedRevision = verifiedRevision;
    for (const listener of listeners) notify(listener);
  }
  /** A completed read that returned no kind 0 is evidence too: the identity is known unnamed. */
  function missed(
    ids: readonly string[],
    returned: ReadonlySet<string>,
    fold = false,
  ) {
    // The cache may already have evicted a returned kind 0; it is not absent.
    // A folded page is accepted but not yet published.
    for (const id of ids)
      if (!loaded.has(id) && !events.peek(id) && !returned.has(id)) {
        // Re-adding moves a reconfirmed absence to the end of the trim order.
        absent.delete(id);
        absent.add(id);
      }
    for (const id of absent) {
      if (absent.size <= 1024) break;
      absent.delete(id);
    }
    const fresh = ids.filter(
      (id) =>
        !snapshot.has(id) &&
        !events.peek(id) &&
        !unnamed.has(id) &&
        !returned.has(id),
    );
    if (!fresh.length) return;
    unnamed = new Set([...unnamed, ...fresh].slice(-limit));
    if (fold) folded = true;
    else for (const listener of listeners) notify(listener);
  }
  async function ensure(
    ids: readonly string[],
    priority: Priority = "foreground",
    refresh = false,
  ) {
    if (closed) throw new DOMException("Session closed", "AbortError");
    const unique = [...new Set(ids)];
    if (!refresh && unique.length > limit)
      throw new Error("Profile request exceeds the directory budget");
    // A hit marks the profile recently used, so the budget evicts profiles
    // nobody has asked for rather than the oldest ones still on screen.
    for (const id of unique) events.get(id);
    verified?.ensure(unique);
    const signal = controller.signal;
    const waiting = new Set<Promise<void>>();
    const missing = unique.filter((id) => {
      let batch = pending.get(id);
      // Don't join a read a waiting shrink would cancel: this name gets its own
      // read, and the rest of that page is still cancelled.
      if (batch && shrinking !== undefined && shrinkCancels(batch))
        batch = undefined;
      if (batch) {
        // Rejoin the equal read so the reader promotes it if still queued;
        // waiting on the old promise alone would leave it behind background work.
        if (priority === "foreground" && batch.priority === "background") {
          batch.priority = priority;
          if (batch.reading)
            void reader
              .read(
                [{ kinds: [0], authors: batch.authors, limit: PROFILE_PAGE }],
                { signal, priority },
              )
              .catch(() => {});
        }
        waiting.add(batch.work);
      }
      return (
        !batch &&
        (refresh ||
          !(
            // A folded page is loaded before its publish.
            loaded.has(id) ||
            events.peek(id) ||
            // Only while still reported unnamed, so a skip never leaves an
            // identity neither named nor unnamed.
            (priority === "background" && absent.has(id) && unnamed.has(id))
          ))
      );
    });
    for (let offset = 0; offset < missing.length; offset += PROFILE_PAGE) {
      const authors = missing.slice(offset, offset + PROFILE_PAGE);
      let answered = false;
      const batch = {
        authors,
        priority,
        reading: false,
        refresh,
        cancel: new AbortController(),
        releases,
        work: Promise.resolve(),
      };
      batch.work = retryRead(
        async (signal) => {
          // A promotion during backoff applies to the next attempt instead.
          batch.reading = true;
          attempts.set(signal, batch);
          try {
            const result = await reader.read(
              [{ kinds: [0], authors, limit: PROFILE_PAGE }],
              { signal, priority: batch.priority },
            );
            answered = true;
            return result;
          } finally {
            batch.reading = false;
          }
        },
        AbortSignal.any([signal, batch.cancel.signal]),
      )
        .then((result) => {
          if (signal.aborted || batch.cancel.signal.aborted) return;
          // A foreground reader that joined this read gets its names at once.
          const fold = batch.priority === "background";
          const profiles = result.filter((event) =>
            authors.includes(event.pubkey),
          );
          take(profiles, fold);
          // A page at the limit may have left out authors who do have one.
          if (result.length < PROFILE_PAGE)
            missed(
              authors,
              new Set(profiles.map((event) => event.pubkey)),
              fold,
            );
        })
        .catch((error: unknown) => {
          // A shrink cancels a background read quietly; evictions() tells its
          // requester to ask again.
          if (batch.cancel.signal.aborted) return;
          // The old directory contract silently discards a retired success.
          if (!signal.aborted || !answered) throw error;
        })
        .finally(() => {
          for (const id of authors)
            if (pending.get(id) === batch) pending.delete(id);
          // A failed page ends its ensure early; publish the rest once idle.
          if (!pending.size) flush();
        });
      for (const id of authors) pending.set(id, batch);
      waiting.add(batch.work);
    }
    await Promise.all(waiting);
    // Every caller sees its names published when its ensure resolves, also
    // one that joined another caller's read.
    flush();
  }
  function clear() {
    controller.abort();
    controller = new AbortController();
    pending.clear();
    absent.clear();
    events.clear();
    verified?.clear();
    unnamed = new Set();
    generation++;
    // Notify even when nothing was loaded: an aborted read still needs a retry.
    publish(true);
  }
  function resize() {
    clearTimeout(shrinking);
    shrinking = undefined;
    let reserved = 0;
    for (const { members } of reservations)
      reserved = Math.max(reserved, members);
    const next = Math.min(PROFILE_CACHE_MAX, PROFILE_CACHE_BASE + reserved);
    if (next === limit) return;
    const shrink = next < limit;
    limit = next;
    verified?.resize(limit);
    let dropped = events.resize(limit, limit * PROFILE_ENTRY_BYTES) > 0;
    // A read asked for before the release would land as the newest entries
    // and push out names the next view just loaded. The next view's own reads,
    // foreground reads and reconnect refreshes keep going.
    if (shrink)
      for (const batch of new Set(pending.values())) {
        if (!shrinkCancels(batch)) continue;
        batch.cancel.abort();
        for (const id of batch.authors)
          if (pending.get(id) === batch) pending.delete(id);
        cancelled++;
        dropped = true;
      }
    if (unnamed.size > limit) {
      unnamed = new Set([...unnamed].slice(-limit));
      dropped = true;
    }
    if (dropped) publish(true);
  }
  function reserve(members: number) {
    const reservation = {
      members: Number.isFinite(members) ? Math.max(0, Math.floor(members)) : 0,
    };
    reservations.add(reservation);
    resize();
    return () => {
      if (!reservations.delete(reservation) || closed) return;
      releases++;
      // Shrink after the current task: a view that releases and reserves again
      // in one commit (a roster count change, a remount) keeps its profiles.
      shrinking ??= setTimeout(resize);
    };
  }
  const queries: ProfileQueries = Object.freeze({
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ensure,
    event: (pubkey: string) => events.peek(pubkey),
    unnamed: () => unnamed,
    generation: () => generation,
    reserve,
    limit: () => limit,
    evictions: () => events.evictions + cancelled,
    verifiedAuthority: () => verified?.authority(),
    verifiedHeld: (pubkey: string) => !!verified?.holds(pubkey),
    verifiedRevision: () => verifiedRevision,
    verifiedSince: (pubkey: string, revision: number) =>
      (acceptedAt.get(pubkey) ?? (revision < forgottenAt ? Infinity : 0)) >
      revision,
    owner: (pubkey: string) => {
      const event = events.peek(pubkey);
      return event ? owners.get(event) : undefined;
    },
  });
  let localProfiles = "";
  const unsubscribeLocal = local?.subscribe(() => {
    const signature = local
      .snapshot()
      .filter((item) => item.event.kind === 0 && item.delivery !== "failed")
      .map((item) => item.event.id)
      .join(":");
    if (signature === localProfiles) return;
    localProfiles = signature;
    publish();
  });
  publish();
  return {
    queries,
    ensure,
    accept,
    clear,
    connected(value: boolean) {
      verified?.connected(value);
    },
    reconnect() {
      verified?.connected(true);
      // Keep winning signed heads: a lagging or failed read must not roll them back.
      const ids = [...new Set([...events.keys(), ...pending.keys()])];
      controller.abort();
      controller = new AbortController();
      pending.clear();
      // A kind 0 published while offline was not delivered live.
      absent.clear();
      return ensure(ids, "background", true);
    },
    event: (id: string) => events.peek(id),
    stats: () => events.stats(),
    dispose() {
      closed = true;
      verified?.dispose();
      unsubscribeLocal?.();
      clear();
      // After clear(): disposing the verified directory schedules a flush.
      clearTimeout(verifiedFlush);
      clearTimeout(shrinking);
      listeners.clear();
    },
  };
}
export type ProfileDirectory = ReturnType<typeof createProfileDirectory>;
