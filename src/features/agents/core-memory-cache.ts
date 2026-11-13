// Each agent's `core` memory as this session last read it, held in memory
// only: it is never saved, so a restart starts empty. The host keeps it
// current, so any agent type starts a session or turn from it without asking
// the relay: the agents service refreshes it when an agent's community
// connects or its connection recovers, and the runner when the agent writes
// memory and when a run ends.
import { coreOf, MemoryReads } from "../agent-harness/core-memory";
import type { AgentReads } from "./reads";

/** How long a start waits on the one read a device with nothing cached makes. */
const FIRST_READ_MS = 5_000;
/** How long a refresh nothing waits on may take. */
const REFRESH_MS = 10_000;
/** Every cache on this page, so leaving a community can clear their copies.
 * Held weakly: nothing tears a cache down, so one its owner dropped (a rebuilt
 * service) is collected and pruned here rather than kept alive. */
const caches = new Set<WeakRef<CoreMemoryCache>>();

/** Forgets every cache's copy of each agent's `core` memory for one community
 * and viewer (`origin:viewer`). A read still under way cannot put it back. */
export function forgetCoreMemory(scope: string) {
  const prefix = `${scope}:`;
  for (const ref of caches) {
    const cache = ref.deref();
    if (cache) cache.forget(prefix);
    else caches.delete(ref);
  }
}

export class CoreMemoryCache {
  private readonly memoryReads = new MemoryReads();
  /** Each entry's latest writer; an older read finishing later is dropped. */
  private readonly writers = new Map<string, number>();
  private writer = 0;
  private readonly latest = new Map<string, string | null>();
  /** Each agent's community as it last read it, whose copy answers while
   * it is disconnected. Leaving that community forgets the copy itself. */
  private readonly scopes = new Map<string, string>();

  constructor(
    /** The reads of each agent's community, while it can be read. */
    private readonly reads: (pubkey: string) => AgentReads | undefined,
  ) {
    caches.add(new WeakRef(this));
  }

  /** Drops the in-memory copies under `prefix` and fences reads under way. */
  forget(prefix: string) {
    for (const key of [...this.latest.keys()])
      if (key.startsWith(prefix)) this.latest.delete(key);
    for (const key of [...this.writers.keys()])
      if (key.startsWith(prefix)) this.claim(key);
  }

  /** The agent's `core` memory: its text, `null` when it has none, or
   * undefined when it could not be read. The cached copy needs no relay
   * request; with none cached yet, this waits on one read. Rejects only when
   * `signal` aborts. */
  async core(
    pubkey: string,
    signal?: AbortSignal,
  ): Promise<string | null | undefined> {
    const timeout = AbortSignal.timeout(FIRST_READ_MS);
    try {
      const reads = this.reads(pubkey);
      if (reads) this.scopes.set(pubkey, reads.scope);
      const cached = this.cached(pubkey);
      if (cached !== undefined) return cached;
      if (!reads) throw new Error("Buzz is not connected");
      return await this.read(
        reads,
        pubkey,
        signal ? AbortSignal.any([signal, timeout]) : timeout,
      );
    } catch (error) {
      signal?.throwIfAborted();
      console.warn("Could not read the agent's core memory", error);
      // Another read or write may have kept a copy while this one waited.
      return this.cached(pubkey);
    }
  }

  /** Reads it again for the agent's next start, which does not wait on it; a
   * failure only leaves the cached copy as it is. Settles when it is done. */
  async refresh(pubkey: string): Promise<void> {
    const reads = this.reads(pubkey);
    if (!reads) return;
    await this.read(reads, pubkey, AbortSignal.timeout(REFRESH_MS)).catch(
      (error: unknown) =>
        console.warn("Could not refresh the agent's core memory", error),
    );
  }

  /** Keeps what the agent just wrote, ahead of any read still under way. */
  wrote(pubkey: string, slug: string, body: string | null) {
    const reads = this.reads(pubkey);
    if (!reads) return;
    this.memoryReads.forget(reads.connection, pubkey);
    if (slug !== "core" || body === null) return;
    this.scopes.set(pubkey, reads.scope);
    const key = this.key(reads.scope, pubkey);
    this.claim(key);
    this.latest.set(key, body);
  }

  /** Reads and keeps the `core` memory, unless a partial listing missed it or
   * a later read or write started since. When the connection was replaced or
   * the agent left it, only the copy kept for its current community: a new
   * one may read as someone else. */
  private async read(reads: AgentReads, pubkey: string, signal: AbortSignal) {
    this.scopes.set(pubkey, reads.scope);
    const key = this.key(reads.scope, pubkey);
    const writer = this.claim(key);
    const memory = coreOf(
      await this.memoryReads.read(reads, pubkey, signal, "core"),
    );
    if (this.reads(pubkey)?.connection !== reads.connection)
      return this.cached(pubkey);
    if (this.writers.get(key) !== writer) {
      // A later write or read took over: answer with what it kept, if anything.
      const current = this.latest.get(key);
      return current === undefined ? memory : current;
    }
    if (memory !== undefined) this.latest.set(key, memory);
    return memory;
  }

  /** The copy kept for the agent's current community, or the one it last
   * read while it is disconnected. */
  private cached(pubkey: string) {
    const scope = this.reads(pubkey)?.scope ?? this.scopes.get(pubkey);
    return scope === undefined
      ? undefined
      : this.latest.get(this.key(scope, pubkey));
  }

  private claim(key: string) {
    this.writer += 1;
    this.writers.set(key, this.writer);
    return this.writer;
  }

  private key(scope: string, pubkey: string) {
    return `${scope}:${pubkey}`;
  }
}
