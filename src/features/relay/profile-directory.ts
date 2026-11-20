import { createVerifiedProfileDirectory } from "./verified-profile-directory";
import {
  namePreference,
  subscribeNamePreference,
  verifiedLabel,
  type NamePreference,
} from "../profiles/name-preference";
import {
  verifiedProfileSubject,
  type VerifiedProfileAuthority,
  type VerifiedProfileFilter,
  type VerifiedProfileSink,
} from "./verified-profile";
import { isRetryableRead, retryRead } from "./read-retry";
import { readErrorKind } from "./errors";
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
import type { ReadFilter, RelayEvent } from "./events";
import { newer } from "./events";
import { foldProfiles } from "./profiles";
import type { Priority, RelayReader } from "./reader";
import { archiveHides, type IdentityArchives } from "./identity-archives";

/** Shared profile reads for any feature, independent of channel history. */
export interface ProfileQueries {
  snapshot(): ReadonlyMap<string, Profile>;
  subscribe(listener: () => void): () => void;
  /** Fetch missing profiles; optional enrichment can yield to conversation reads.
   * A view that shows these people's statuses gets them too: in the same
   * request as their profiles, or alone when the profiles are already known. */
  ensure(
    ids: readonly string[],
    priority?: Priority,
    options?: { withStatuses?: boolean },
  ): Promise<void>;
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
   * next task cancels the departing view's background reads; 30 seconds
   * later, the limit returns to the largest remaining reservation and evicts
   * the least recently used profiles past it. */
  reserve?(members: number): () => void;
  /** The base plus the room open views reserved; one ensure may ask for at
   * most this many. A released view's hold keeps more profiles cached but
   * does not count here, so reads sized by it do not evict the held names. */
  limit?(): number;
  /** Moves when the budget drops loaded profiles or a shrink cancels
   * background reads asked for before the release. A view that requested names
   * once and skips repeats must request again after it moves. */
  evictions?(): number;
  /** The community's current verified-profile authority, or undefined while
   * it advertises none. Subscribers are notified when it changes. */
  verifiedAuthority?(): VerifiedProfileAuthority | undefined;
  /** Whether the published shared snapshot holds a head for `pubkey`. Its
   * profile's `verified`, present or not, then outranks a search's answer:
   * a newer inactive or malformed head revokes an older name. */
  verifiedHeld?(pubkey: string): boolean;
  /** Moves with published authority/head evidence, including a first inactive
   * head that leaves profiles unchanged. Checked/cached status alone does not
   * move it; subscribers still receive those profile status updates. */
  verifiedRevision?(): number;
  /** Whether a `verifiedRevision()` after `revision` accepted a head for
   * `pubkey`, even one the cache evicted before publishing it. Past what it
   * remembers it answers yes, never no for a head it accepted. */
  verifiedSince?(pubkey: string, revision: number): boolean;
}

/** Authors per profile read, the reader's largest page. A page that fills it
 * may have left out authors who do have a profile. */
const PROFILE_PAGE = 500;
/** How long a released reservation holds the limit up. */
const RELEASE_HOLD_MS = 30_000;

// Hidden characters must not defeat verified-name qualification. Strip them
// before trimming so e.g. "Alice \u200b" still matches "Alice". Display text stays intact.
const collisionName = (name: string) =>
  name.replace(/\p{Default_Ignorable_Code_Point}/gu, "").trim();

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
  archives?: Pick<IdentityArchives, "snapshot" | "subscribe" | "ensure">,
  statuses?: {
    prefetch(
      authors: readonly string[],
    ):
      | { filter: ReadFilter; settle(events?: readonly RelayEvent[]): void }
      | undefined;
  },
) {
  let limit = PROFILE_CACHE_BASE;
  // DM partners: eviction takes them last, so a large roster cannot turn a
  // DM label back into a key. Bounded to half the base entry count.
  let kept: ReadonlySet<string> = new Set();
  const events = new ByteLru<RelayEvent>(
    limit,
    limit * PROFILE_ENTRY_BYTES,
    (id) => kept.has(id),
  );
  // One entry per open view; the largest sets the limit.
  const reservations = new Set<{ members: number }>();
  let shrinking: ReturnType<typeof setTimeout> | undefined;
  // A released view's room holds the limit up for a while, so a reader who
  // switches back finds the names it showed instead of reading them again.
  let held = 0;
  let holding: ReturnType<typeof setTimeout> | undefined;
  // The limit open views alone set; a drop means a view left.
  let opened = PROFILE_CACHE_BASE;
  const owners = new WeakMap<RelayEvent, string>();
  type Batch = {
    work: Promise<void>;
    authors: string[];
    filters: ReadFilter[];
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
  let publishedVerifiedHeads: ReadonlySet<string> = new Set();
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
  // Offline, a collision waits: a read started now could fail and stick.
  let online = true;
  // A collision whose archive read was skipped offline, run on reconnect.
  let waiting = false;
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
        verifiedFlush ??= setTimeout(flushVerified);
      },
      verification.refresh,
    );
  function flushVerified() {
    clearTimeout(verifiedFlush);
    verifiedFlush = undefined;
    if (!closed) publish();
  }
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
  // Read when first needed and on change, so publishing an empty or closing
  // directory never reads storage.
  let preference: NamePreference | undefined;
  let publishedAuthority: VerifiedProfileAuthority | undefined;
  let publishedRevision = 0;
  /** Notifies on display changes, on winning-event changes for `event()`
   * readers, and on verified-authority and head changes for
   * `verifiedAuthority()`, `verifiedHeld()` and `verifiedRevision()`. */
  function publish(headChanged = false) {
    // After the snapshot is out: the read's synchronous `loading` may reenter.
    const collision = fold(headChanged);
    waiting = collision && !online;
    if (collision && online && archives?.snapshot().status === "idle")
      void archives.ensure();
  }
  /** Publishes the snapshot; true when a verified collision wants archives. */
  function fold(headChanged = false): boolean {
    folded = false;
    const authority = verified?.authority();
    const held = new Set(
      (verified?.heads(limit) ?? []).flatMap((event) => {
        const subject = authority && verifiedProfileSubject(event, authority);
        return subject ? [subject] : [];
      }),
    );
    const headsChanged =
      held.size !== publishedVerifiedHeads.size ||
      [...held].some((pubkey) => !publishedVerifiedHeads.has(pubkey));
    const accepted = verified?.takeAccepted() ?? [];
    // Search retries follow evidence, not failure-only sync notifications or
    // checked/cached status changes. Those still publish their profile state.
    if (accepted.length || headsChanged || publishedAuthority !== authority)
      verifiedRevision++;
    for (const subject of accepted) {
      acceptedAt.delete(subject);
      acceptedAt.set(subject, verifiedRevision);
    }
    for (const [subject, revision] of acceptedAt) {
      if (acceptedAt.size <= PROFILE_CACHE_MAX) break;
      acceptedAt.delete(subject);
      forgottenAt = revision;
    }
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
    const verifiedProfiles = verified?.snapshot() ?? new Map();
    if (verifiedProfiles.size) preference ??= namePreference();
    for (const [id, value] of verifiedProfiles) {
      const { nameIsFallback: _fallback, ...base } = next.get(id) ?? {};
      next.set(
        id,
        Object.freeze({
          ...base,
          name: verifiedLabel(value, preference),
          username: value.username,
          verified: value,
        }),
      );
    }
    // Qualify all namesakes in the shared directory, including self-declared
    // names that imitate a verified name. This carries through string consumers.
    // Counted once per publish: a pairwise scan is quadratic in a large roster.
    // An archived identity is no namesake of an active one, but keeps its own
    // suffix beside any namesake, since it can still post.
    const archived = (id: string) => archiveHides(archives, id, undefined);
    const verifiedNames = new Map<string, number>();
    const verifiedUsernames = new Map<string | undefined, number>();
    const activeNames = new Map<string, number>();
    const activeUsernames = new Map<string | undefined, number>();
    const count = (
      names: Map<string, number>,
      usernames: Map<string | undefined, number>,
      name: string,
      username: string | undefined,
    ) => {
      names.set(name, (names.get(name) ?? 0) + 1);
      usernames.set(username, (usernames.get(username) ?? 0) + 1);
    };
    for (const [id, { verified, username }] of next)
      if (verified) {
        const name = collisionName(verifiedLabel(verified, preference));
        count(verifiedNames, verifiedUsernames, name, username);
        if (!archived(id)) count(activeNames, activeUsernames, name, username);
      }
    // Only a verified collision needs the lazy archive read; it refolds on arrival.
    const collision =
      [...verifiedNames.values()].some((n) => n > 1) ||
      [...verifiedUsernames].some(([u, n]) => u !== undefined && n > 1);
    for (const [id, profile] of next) {
      const own = profile.verified ? 1 : 0;
      // Only an active verified profile discounts archived namesakes.
      const [names, usernames] =
        profile.verified && !archived(id)
          ? [activeNames, activeUsernames]
          : [verifiedNames, verifiedUsernames];
      const duplicate =
        (names.get(
          collisionName(
            profile.verified
              ? verifiedLabel(profile.verified, preference)
              : profile.name,
          ),
        ) ?? 0) > own ||
        (!!profile.verified && (usernames.get(profile.username) ?? 0) > own);
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
        old?.tz === value.tz &&
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
      !headsChanged &&
      publishedAuthority === verified?.authority() &&
      publishedRevision === verifiedRevision
    )
      return collision;
    publishedVerifiedHeads = held;
    publishedAuthority = verified?.authority();
    publishedRevision = verifiedRevision;
    for (const listener of listeners) notify(listener);
    return collision;
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
    withStatuses = false,
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
              .read(batch.filters, { signal, priority })
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
      const status = withStatuses ? statuses?.prefetch(authors) : undefined;
      let answered = false;
      // Set once a combined read fails, for one more attempt with names alone.
      let namesAlone = false;
      const batch = {
        authors,
        filters: [
          { kinds: [0], authors, limit: PROFILE_PAGE },
          ...(status ? [status.filter] : []),
        ],
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
            const result = await reader.read(batch.filters, {
              signal,
              priority: batch.priority,
            });
            answered = true;
            return result;
          } catch (error) {
            // Names never wait on statuses: a relay refusing the status
            // query still answers names, and rows read their own statuses.
            if (batch.filters.length > 1) {
              batch.filters = batch.filters.slice(0, 1);
              namesAlone = true;
              status?.settle();
            }
            throw error;
          } finally {
            batch.reading = false;
          }
        },
        AbortSignal.any([signal, batch.cancel.signal]),
        (error) => {
          const retry = namesAlone && readErrorKind(error) !== "cancelled";
          namesAlone = false;
          return retry || isRetryableRead(error);
        },
      )
        .then((result) => {
          // Statuses stay valid when a shrink drops these names.
          status?.settle(result);
          if (signal.aborted || batch.cancel.signal.aborted) return;
          // A foreground reader that joined this read gets its names at once.
          const fold = batch.priority === "background";
          const profiles = result.filter(
            (event) => event.kind === 0 && authors.includes(event.pubkey),
          );
          take(profiles, fold);
          // A page at the limit may have left out authors who do have one.
          if (result.filter((event) => event.kind === 0).length < PROFILE_PAGE)
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
    // Names already known need no profile read, but their statuses still do.
    const reading = new Set(missing);
    const status = withStatuses
      ? statuses?.prefetch(unique.filter((id) => !reading.has(id)))
      : undefined;
    // Waited on so the caller can warm status images with avatars.
    if (status)
      waiting.add(
        reader.read([status.filter], { signal, priority: "background" }).then(
          (events) => status.settle(events),
          () => status.settle(),
        ),
      );
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
    const open = Math.min(PROFILE_CACHE_MAX, PROFILE_CACHE_BASE + reserved);
    const departed = open < opened;
    opened = open;
    const next = Math.max(open, held);
    if (next === limit && !departed) return;
    limit = next;
    verified?.resize(limit);
    let dropped = events.resize(limit, limit * PROFILE_ENTRY_BYTES) > 0;
    // A read asked for before the release would land as the newest entries
    // and push out names the next view just loaded. The next view's own reads,
    // foreground reads and reconnect refreshes keep going.
    if (departed)
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
      // Only the largest room held so far restarts the hold, so closing
      // smaller views cannot keep a large channel's room up indefinitely.
      const room = Math.min(
        PROFILE_CACHE_MAX,
        PROFILE_CACHE_BASE + reservation.members,
      );
      if (room >= held) {
        held = room;
        clearTimeout(holding);
        holding = setTimeout(() => {
          held = 0;
          resize();
        }, RELEASE_HOLD_MS);
      }
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
    ensure: (
      ids: readonly string[],
      priority?: Priority,
      options?: { withStatuses?: boolean },
    ) => ensure(ids, priority, false, options?.withStatuses),
    event: (pubkey: string) => events.peek(pubkey),
    unnamed: () => unnamed,
    generation: () => generation,
    reserve,
    limit: () => opened,
    evictions: () => events.evictions + cancelled,
    verifiedAuthority: () => verified?.authority(),
    // Held evidence and its projection become visible in the same publication.
    verifiedHeld: (pubkey: string) => publishedVerifiedHeads.has(pubkey),
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
  // Archiving or unarchiving refolds namesake labels. An archive notification
  // never starts a read: a disconnect's `idle` must not read while offline.
  const unsubscribeArchives = archives?.subscribe(() => {
    if (!closed) fold();
  });
  // Each reader's own choice of name for verified people refolds every label.
  const unsubscribePreference = subscribeNamePreference(() => {
    if (closed) return;
    preference = undefined;
    publish(true);
  });
  publish();
  return {
    queries,
    ensure,
    accept,
    clear,
    connected(value: boolean) {
      online = value;
      verified?.connected(value);
      if (value && waiting) publish();
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
    /** Keep these identities' profiles through eviction. */
    protect(ids: Iterable<string>) {
      kept = new Set([...ids].slice(0, PROFILE_CACHE_BASE / 2));
    },
    /** Up to `count` held kind 0 events, least valued first: protected
     * identities last, the rest by least recent use. */
    recent: (count: number) => {
      const ids = events.keys();
      return [
        ...ids.filter((id) => !kept.has(id)),
        ...ids.filter((id) => kept.has(id)),
      ]
        .slice(-count)
        .flatMap((id) => {
          const event = events.peek(id);
          return event ? [event] : [];
        });
    },
    /** Up to `count` held verified heads, for the device mirror. */
    verifiedHeads: (count: number) => verified?.heads(count) ?? [],
    /** Verified heads an earlier session saved, shown as cached until checked. */
    restoreVerified(saved: readonly RelayEvent[]) {
      verified?.restore(saved);
      // Published now, so a restored session never starts without them.
      if (verifiedFlush !== undefined) flushVerified();
    },
    stats: () => events.stats(),
    dispose() {
      closed = true;
      verified?.dispose();
      unsubscribeLocal?.();
      unsubscribePreference();
      unsubscribeArchives?.();
      clear();
      // After clear(): disposing the verified directory schedules a flush.
      clearTimeout(verifiedFlush);
      clearTimeout(shrinking);
      clearTimeout(holding);
      listeners.clear();
    },
  };
}
export type ProfileDirectory = ReturnType<typeof createProfileDirectory>;
