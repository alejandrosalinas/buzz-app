import { retryRead } from "./read-retry";
import { getEventHash } from "nostr-tools";
import { authTagOwner, withinTimeBounds } from "../agents/owner-attestation";
import { byteSize } from "./budget";
import { newer, type RelayEvent } from "./events";
import {
  archiveRequestTemplate,
  type IdentityArchiveAction,
} from "./identity-archive-protocol";
import { PublishRejected } from "./outbox";
import type { RelayReader } from "./reader";
import type { RelayWriter } from "./transport";

export type IdentityArchiveSnapshot = Readonly<{
  status: "unavailable" | "idle" | "loading" | "ready" | "error";
  archived: readonly string[];
  eventId?: string;
  createdAt?: number;
  readAt?: number;
  error?: string;
}>;
export type IdentityArchives = ReturnType<
  typeof createIdentityArchives
>["queries"];

/** Base Buzz discovery rule: known-archived identities leave forward-looking
 * choices, fail open while archive state is unknown, and never hide the viewer
 * from themself (NIP-IA archival stays visible to its subject). Visibility
 * uses the last known archives; `state()` answers only from a fresh read. */
/** The relay archives an owned identity only when its latest profile names
 * its owner, and the caller can't publish that profile. */
export class UnattestedProfile extends Error {
  constructor() {
    super("Its profile doesn't name you as its owner");
  }
}

/** Publishes an identity's profile as that identity. */
/** Republishes an identity's own profile, naming its saved owner. */
export type IdentityAttest = (signal: AbortSignal) => Promise<unknown>;

export function archiveHides(
  archives: Pick<IdentityArchives, "snapshot"> | undefined,
  pubkey: string,
  viewer: string | undefined,
) {
  if (pubkey === viewer || !archives) return false;
  const archived = archives.snapshot().archived;
  let lookup = archivedSets.get(archived);
  if (!lookup) {
    lookup = new Set(archived);
    archivedSets.set(archived, lookup);
  }
  return lookup.has(pubkey);
}
// Search and choosers ask once per candidate; snapshots freeze their list.
const archivedSets = new WeakMap<readonly string[], ReadonlySet<string>>();
const empty: readonly string[] = Object.freeze([]);
const HEX = /^[0-9a-f]{64}$/;
const MAX_BYTES = 2 * 1024 * 1024;

/** Relay-scoped NIP-IA visibility, never access, membership or liveness evidence.
 * The caller supplies only explicit NIP-11 self, never the contact-key fallback.
 * Reads are lazy finite snapshots, not a live archive subscription.
 * Requests are optional NIP-IA 9035/9036 writes; the relay re-verifies consent. */
export function createIdentityArchives(
  reader: RelayReader,
  authority: string | undefined,
  notify = (listener: () => void) => listener(),
  write?: { writer: RelayWriter | undefined; viewer: string | undefined },
) {
  const available = !!authority && HEX.test(authority);
  const writer = available ? write?.writer : undefined;
  const viewer = write?.viewer;
  const requests = new Set<AbortController>();
  const listeners = new Set<() => void>();
  let closed = false;
  let controller: AbortController | undefined;
  let pending: Promise<void> | undefined;
  // Keep only the ordering fence across cache clears; never revive old contents.
  // This is session-local rollback resistance, not a cross-device durable fence.
  let head: Pick<RelayEvent, "id" | "created_at"> | undefined;
  let snapshot: IdentityArchiveSnapshot = Object.freeze({
    status: available ? "idle" : "unavailable",
    archived: empty,
  });
  function publish(next: IdentityArchiveSnapshot) {
    snapshot = Object.freeze(next);
    for (const listener of listeners) notify(listener);
  }
  function refresh(): Promise<void> {
    if (closed || !available || !authority) return Promise.resolve();
    if (pending) return pending;
    const owned = new AbortController();
    controller = owned;
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    pending = completion;
    // Rereads keep the last known archives until the new snapshot replaces
    // them, so a known-archived identity never briefly looks live.
    const { error: _, ...known } = snapshot;
    publish({ ...known, status: "loading" });
    void (async () => {
      try {
        if (closed || owned.signal.aborted) return;
        const events = await retryRead(
          (signal) =>
            reader.read([{ kinds: [13535], authors: [authority], limit: 1 }], {
              signal,
              priority: "background",
              fresh: true,
            }),
          owned.signal,
        );
        if (closed || owned.signal.aborted) return;
        // The relay publishes its first snapshot with its first archive, so
        // none means no one is archived, unless this session read one.
        if (!events.length && !head) {
          publish({ status: "ready", archived: empty, readAt: Date.now() });
          return;
        }
        const event = events[0];
        const markers = event?.tags.filter(([name]) => name === "-");
        if (
          events.length !== 1 ||
          !event ||
          event.kind !== 13535 ||
          event.pubkey !== authority ||
          event.content !== "" ||
          markers?.length !== 1 ||
          markers[0]?.length !== 1 ||
          byteSize(event) > MAX_BYTES
        )
          throw new Error("Invalid archive snapshot");
        // NIP-01 ordering also applies when the relay replays an older snapshot.
        // Re-reading the identical head is valid; a losing equal-time id is not.
        if (
          head &&
          (event.created_at < head.created_at ||
            (event.created_at === head.created_at && event.id > head.id))
        )
          throw new Error("Stale archive snapshot");
        const archived = [
          ...new Set(
            event.tags.flatMap(([name, key]) =>
              name === "p" && key && HEX.test(key) ? [key] : [],
            ),
          ),
        ].sort();
        head = { id: event.id, created_at: event.created_at };
        publish({
          status: "ready",
          archived: Object.freeze(archived),
          eventId: event.id,
          createdAt: event.created_at,
          readAt: Date.now(),
        });
      } catch {
        if (!closed && !owned.signal.aborted)
          publish({
            ...snapshot,
            status: "error",
            error:
              "Archive visibility is unknown. Retry to obtain a valid current relay snapshot (2 MiB limit).",
          });
      } finally {
        if (controller === owned) {
          controller = undefined;
          pending = undefined;
        }
        finish();
      }
    })();
    return completion;
  }
  /** Render and submit guard: self, relay owner/admin from the relay-signed
   * 13534 roster, or verified NIP-OA owner. `auth` is ownership evidence even
   * when `admin` is the path used to sign. Null means no path. */
  async function consent(
    target: string,
    signal: AbortSignal,
  ): Promise<{ auth?: readonly string[]; admin?: true } | null> {
    if (closed || !writer || !viewer || !authority || !HEX.test(target))
      return null;
    if (target === viewer) return {};
    const events = await reader.read(
      [
        { kinds: [0], authors: [target], limit: 1 },
        { kinds: [13534], authors: [authority], limit: 1 },
      ],
      { signal, priority: "foreground", fresh: true },
    );
    signal.throwIfAborted();
    const profile = events
      .filter((event) => event.kind === 0 && event.pubkey === target)
      .reduce<RelayEvent | undefined>(newer, undefined);
    // NIP-IA ownership ignores kind clauses; request time bounds apply at signing.
    const [tag, ...extra] =
      profile?.tags.filter(([name]) => name === "auth") ?? [];
    const auth =
      tag && !extra.length && (await authTagOwner(target, tag)) === viewer
        ? tag
        : undefined;
    signal.throwIfAborted();
    const roster = events
      .filter((event) => event.kind === 13534 && event.pubkey === authority)
      .reduce<RelayEvent | undefined>(newer, undefined);
    const role = roster?.tags.find(
      ([name, key]) => name === "member" && key === viewer,
    )?.[2];
    const admin = role === "owner" || role === "admin";
    if (!auth && !admin) return null;
    return { ...(auth && { auth }), ...(admin && { admin: true as const }) };
  }
  async function request(
    action: IdentityArchiveAction,
    target: string,
    caller?: AbortSignal,
    /** For an identity the caller owns: a fresh owner proof (NIP-OA), used
     * when no consent path is usable now, as when its profile has none. */
    issue?: (target: string, signal: AbortSignal) => Promise<readonly string[]>,
    /** For an identity whose key the caller holds: republishes its own
     * profile with its saved owner proof. The relay also needs a proof naming
     * the owner on the latest profile, so a missing one is restored first. */
    attest?: IdentityAttest,
  ): Promise<void> {
    if (!writer) throw new Error("Archive is unavailable on this connection");
    const owned = new AbortController();
    let uncertain: unknown;
    requests.add(owned);
    const signal = AbortSignal.any([
      owned.signal,
      AbortSignal.timeout(20_000),
      ...(caller ? [caller] : []),
    ]);
    try {
      const path = await consent(target, signal);
      // Relay order: role authority stands alone, so never attach a credential
      // whose time bounds could fail it.
      let auth = path?.admin ? undefined : path?.auth;
      let template = path && archiveRequestTemplate(action, target, auth);
      if (
        !template ||
        (auth && !withinTimeBounds(auth[2] ?? "", template.created_at))
      ) {
        if (!issue) throw new Error("You can no longer archive this identity");
        // The relay ignores a profile proof's time bounds, not its absence.
        if (!path && !attest) throw new UnattestedProfile();
        auth = await issue(target, signal);
        signal.throwIfAborted();
        template = archiveRequestTemplate(action, target, auth);
        if (
          (await authTagOwner(target, auth)) !== viewer ||
          !withinTimeBounds(auth[2] ?? "", template.created_at)
        )
          throw new Error(
            "The owner proof issued for this identity is invalid",
          );
        if (!path && attest) {
          // The app's own profile, carrying the saved owner proof; it replaces
          // whatever else the relay's latest profile had.
          await attest(signal);
          signal.throwIfAborted();
          // Only the relay's latest profile counts: read it back.
          if (!(await consent(target, signal))?.auth)
            throw new Error(
              "The relay didn't accept its profile with your owner proof",
            );
          template = archiveRequestTemplate(action, target, auth);
        }
      }
      const signed = await writer.sign(structuredClone(template), signal);
      signal.throwIfAborted();
      if (
        signed.pubkey !== viewer ||
        signed.kind !== template.kind ||
        signed.created_at !== template.created_at ||
        signed.content !== template.content ||
        JSON.stringify(signed.tags) !== JSON.stringify(template.tags) ||
        getEventHash(signed) !== signed.id
      )
        throw new Error("Signer changed the archive request");
      try {
        await writer.publish(signed, signal);
      } catch (error) {
        // A definitive rejection changed nothing; an unknown outcome may have applied.
        if (error instanceof PublishRejected) throw error;
        uncertain = error;
      }
    } finally {
      requests.delete(owned);
    }
    // A read started before acceptance cannot confirm it; a failed re-read stays unknown.
    await pending;
    await refresh();
    if (closed) throw new Error("Archive request was interrupted");
    const expected = action === "archive" ? "archived" : "not-archived";
    if (state(target) !== expected)
      throw (
        uncertain ?? new Error("The relay did not confirm the change. Retry.")
      );
  }
  /** From the latest successful read only, so deletion and confirmation never
   * act on retained evidence. */
  function state(pubkey: string): "unknown" | "archived" | "not-archived" {
    if (snapshot.status !== "ready" || !HEX.test(pubkey)) return "unknown";
    return snapshot.archived.includes(pubkey) ? "archived" : "not-archived";
  }
  function stop() {
    for (const owned of requests) owned.abort();
    controller?.abort();
    controller = undefined;
    pending = undefined;
    return closed || !available ? "unavailable" : "idle";
  }
  /** Forgets everything known, for a new identity or access. */
  function clear() {
    publish({ status: stop(), archived: empty });
  }
  /** After a reconnect: the next ensure() rereads, and until it replaces them
   * the last known archives stay known. */
  function stale() {
    const { error: _, ...known } = snapshot;
    publish({ ...known, status: stop() });
  }
  return {
    queries: Object.freeze({
      snapshot: () => snapshot,
      subscribe(listener: () => void) {
        if (closed) return () => {};
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      state,
      ensure: () =>
        snapshot.status === "idle" ? refresh() : (pending ?? Promise.resolve()),
      refresh,
      /** Whether this community advertises an archive authority; fixed per session. */
      supported: available,
      writable: !!writer,
      consent,
      request,
    }),
    clear,
    stale,
    dispose() {
      closed = true;
      clear();
      listeners.clear();
    },
  };
}
