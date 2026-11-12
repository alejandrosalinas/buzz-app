import { newer, type EventData, type ReadFilter } from "../relay/events";
import type { PresenceActivity } from "./activity";
import type { Presence, PresenceStatus } from "./presence";

/** Kind 30177: an owner's record of one agent, `d` its pubkey. */
const AGENT_RECORD = 30177;
/** The reader's most filters per read; each filter is one owner's agents. */
const FILTERS = 4;
/** Agents per filter, within the reader's limit. */
const AGENTS = 100;
/** Evidence kept for agents no longer shown, so a remount reads nothing. */
const RETAINED = 1024;
/** Hosted agents publish no presence, so records are read again this often,
 * spread so a fleet that reconnected together does not refresh together. */
const refreshMs = () => 5 * 60_000 + Math.floor(Math.random() * 60_000);
/** The first retry after a failure waits about a minute. Each further failure
 * in a row doubles the wait, to the cap, so a relay outage does not have the
 * whole fleet asking again every minute; jitter spreads the retries. */
const RETRY_MS = 60_000;
const RETRY_CAP_MS = 30 * 60_000;
const retryMs = (failures: number) => {
  const base = Math.min(
    RETRY_CAP_MS,
    RETRY_MS * 2 ** Math.max(0, failures - 1),
  );
  return base + Math.floor(Math.random() * base * 0.1);
};
/** Reads a reconnect or a return to the foreground wants are spread, so a
 * fleet that reconnected together does not read together. */
const spreadMs = () => 1000 + Math.floor(Math.random() * 4000);

type Deps = {
  /** The verified NIP-OA owner of an agent's winning kind 0, if any. */
  owner(pubkey: string): string | undefined;
  /** Notifies when profile heads, and so owners, change. */
  subscribeOwners(listener: () => void): () => void;
  /** Whether observed presence holds a shown subject past its demand limit.
   * Such an agent is neither read nor marked, so the limit stays one. */
  limited(pubkey: string): boolean;
  /** Notifies when demand moves subjects within or past that limit. */
  subscribeSelection(listener: () => void): () => void;
  /** App visibility. No read starts while hidden; absent, the app is shown. */
  activity?: PresenceActivity | undefined;
  read(
    filters: readonly ReadFilter[],
    signal: AbortSignal,
  ): Promise<readonly EventData[]>;
  notify(listener: () => void): void;
};
/** What one read found: the attested owner it asked, and the runtime its
 * newest record of the agent names, if any. */
type Evidence = { owner: string; runtime: string | undefined };

/** Agents a remote runtime runs. They wake on mentions and hold no socket, so
 * relay presence cannot show them; the owner's record is the evidence. Only a
 * record signed by the owner the agent's own profile attests counts. Display
 * only: it grants nothing and does not prove the agent is running. */
export function createHostedAgents(deps: Deps) {
  const listeners = new Map<string, Set<() => void>>();
  /** The badge each shown agent's subscribers last saw. Whatever decides it
   * may change outside this module, so changes are found by comparison. */
  const emitted = new Map<string, boolean>();
  /** By agent, in least recently read order. */
  const evidence = new Map<string, Evidence>();
  /** Agents a read stopped short of when the app was hidden; the next read
   * asks about them whatever evidence they hold. */
  const deferred = new Set<string>();
  let runtimes: ReadonlySet<string> = new Set();
  let connected = false,
    closed = false;
  let controller: AbortController | undefined;
  /** One timer for the next read, whether demand, retry or refresh. */
  let timer: ReturnType<typeof setTimeout> | undefined;
  let due = Infinity;
  /** When the next read asks about every shown agent again. */
  let refreshAt = 0;
  /** After a failure, no read starts before this, whatever asked for it. */
  let backoffUntil = 0;
  /** Failures in a row; each lengthens the wait before the next retry. */
  let failures = 0;
  const visible = () => deps.activity?.visible() ?? true;
  const shown = (key: string) => {
    const owner = connected ? deps.owner(key) : undefined;
    const found = owner ? evidence.get(key) : undefined;
    return (
      !!found &&
      found.owner === owner &&
      !!found.runtime &&
      runtimes.has(found.runtime) &&
      !deps.limited(key)
    );
  };
  /** Notifies each shown agent whose badge differs from the one its
   * subscribers last saw. */
  function sync() {
    for (const [key, was] of emitted) {
      const now = shown(key);
      if (was === now) continue;
      emitted.set(key, now);
      for (const listener of listeners.get(key) ?? []) deps.notify(listener);
    }
  }
  /** Shown agents within the demand limit with an attested owner whose
   * evidence is missing, was read for another owner or was deferred; on a
   * refresh, every such agent with an owner. */
  function wanted(refreshing = false) {
    const found = new Map<string, string>();
    for (const key of listeners.keys()) {
      const owner = deps.owner(key);
      if (
        owner &&
        owner !== key &&
        !deps.limited(key) &&
        (refreshing || deferred.has(key) || evidence.get(key)?.owner !== owner)
      )
        found.set(key, owner);
    }
    return found;
  }
  /** Moves the next read earlier, never later, and never while hidden. */
  function schedule(at: number) {
    if (closed || !listeners.size || !visible() || at >= due) return;
    clearTimeout(timer);
    due = at;
    timer = setTimeout(
      () => {
        timer = undefined;
        due = Infinity;
        void read();
      },
      Math.max(0, at - Date.now()),
    );
  }
  function unschedule() {
    clearTimeout(timer);
    timer = undefined;
    due = Infinity;
  }
  /** Coalesces demand and owner changes into one read. A read under way is
   * not cancelled: the next one asks only about what it did not. */
  function queue(delay = 100) {
    if (wanted().size) schedule(Math.max(Date.now() + delay, backoffUntil));
  }
  /** Keeps the refresh scheduled while agents are shown. */
  const arm = () => refreshAt && schedule(refreshAt);
  /** Reads what a reconnect or a return to the foreground wants, spread. */
  function resume() {
    const spread = spreadMs();
    queue(spread);
    if (refreshAt) schedule(Math.max(refreshAt, Date.now() + spread));
  }
  async function read() {
    if (closed || controller || !connected || !runtimes.size || !visible())
      return;
    // A timer set before a failure can fire inside its cooldown; it holds.
    if (Date.now() + 5 < backoffUntil) {
      schedule(backoffUntil);
      return;
    }
    // Timers may fire a moment early; a read that close to the refresh is it.
    const refreshing = Date.now() + 5 >= refreshAt;
    const wants = wanted(refreshing);
    if (refreshing) refreshAt = Date.now() + refreshMs();
    const owned = new AbortController();
    controller = owned;
    try {
      const owners = new Map<string, string[]>();
      for (const [key, owner] of wants)
        owners.set(owner, [...(owners.get(owner) ?? []), key]);
      const filters: ReadFilter[] = [];
      for (const [owner, agents] of owners)
        for (let at = 0; at < agents.length; at += AGENTS) {
          const chunk = agents.slice(at, at + AGENTS);
          filters.push({
            kinds: [AGENT_RECORD],
            authors: [owner],
            "#d": chunk,
            limit: chunk.length,
          });
        }
      for (let at = 0; at < filters.length; at += FILTERS) {
        // Hidden, the read stops before its next batch and keeps what it has
        // read; the return to the foreground reads the rest.
        if (!visible()) {
          for (const filter of filters.slice(at))
            for (const key of filter["#d"] ?? []) deferred.add(key);
          break;
        }
        const batch = filters.slice(at, at + FILTERS);
        const events = await deps.read(batch, owned.signal);
        if (owned.signal.aborted) return;
        // The newest record of each agent by its attested owner decides.
        const heads = new Map<string, EventData>();
        for (const event of events) {
          const d = event.tags.find((tag) => tag[0] === "d")?.[1];
          if (event.kind === AGENT_RECORD && d && wants.get(d) === event.pubkey)
            heads.set(d, newer(heads.get(d), event));
        }
        for (const filter of batch)
          for (const key of filter["#d"] ?? []) {
            deferred.delete(key);
            evidence.delete(key);
            evidence.set(key, {
              owner: filter.authors?.[0] ?? "",
              runtime: heads
                .get(key)
                ?.tags.find((tag) => tag[0] === "runtime")?.[1],
            });
          }
        for (const key of evidence.keys()) {
          if (evidence.size <= RETAINED) break;
          if (!listeners.has(key)) evidence.delete(key);
        }
        sync();
      }
      failures = 0;
      backoffUntil = 0;
    } catch {
      // A failed read keeps prior evidence and waits for the retry, so
      // neither demand nor profile changes turn a failing relay into a loop.
      if (owned.signal.aborted) return;
      backoffUntil = refreshAt = Date.now() + retryMs(++failures);
      // A read queued meanwhile would start inside the cooldown; it waits.
      if (due < backoffUntil) unschedule();
    } finally {
      if (controller === owned) controller = undefined;
    }
    queue();
    arm();
  }
  const stopOwners = deps.subscribeOwners(() => {
    // The directory changed before telling us, so a lost or replaced owner is
    // found by comparison and hides the badge at once; a new owner is read.
    sync();
    queue();
  });
  const stopSelection = deps.subscribeSelection(() => {
    // An agent admitted within the limit is read; one pushed past it is not.
    sync();
    queue();
  });
  let wasVisible = visible();
  const stopActivity = deps.activity?.subscribe(() => {
    const now = visible();
    if (now === wasVisible) return;
    wasVisible = now;
    // Hidden, no read starts, and evidence stays. Shown, reads resume spread.
    if (now) resume();
    else unschedule();
  });
  return {
    hosted: shown,
    /** The runtimes, by agent type key, that run agents remotely. */
    remoteRuntimes(keys: Iterable<string>) {
      const next = new Set(keys);
      if (
        next.size === runtimes.size &&
        [...next].every((key) => runtimes.has(key))
      )
        return;
      runtimes = next;
      sync();
      queue();
      arm();
    },
    subscribe(key: string, listener: () => void) {
      if (closed || !/^[0-9a-f]{64}$/.test(key)) return () => {};
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
        emitted.set(key, shown(key));
      }
      set.add(listener);
      queue();
      arm();
      return () => {
        const current = listeners.get(key);
        if (!current?.delete(listener) || current.size) return;
        // Evidence stays, so showing the agent again reads nothing.
        listeners.delete(key);
        emitted.delete(key);
        deferred.delete(key);
        if (!listeners.size) unschedule();
      };
    },
    connected(value: boolean) {
      if (connected === value || closed) return;
      connected = value;
      sync();
      if (!value) {
        controller?.abort();
        controller = undefined;
        return;
      }
      // A reconnect keeps evidence and spreads its reads.
      resume();
    },
    /** Drops evidence read under earlier access and reads again. */
    clear() {
      controller?.abort();
      controller = undefined;
      evidence.clear();
      sync();
      queue();
    },
    dispose() {
      closed = true;
      stopOwners();
      stopSelection();
      stopActivity?.();
      clearTimeout(timer);
      controller?.abort();
      listeners.clear();
      emitted.clear();
      deferred.clear();
      evidence.clear();
    },
  };
}
export type HostedAgents = ReturnType<typeof createHostedAgents>;

/** Presence that shows hosted agents online whatever the relay reports. Every
 * other subject, the viewer included, keeps its observed status. `limited`
 * passes through: an agent past the demand limit is neither read nor marked. */
export function withHostedAgents(
  presence: Presence,
  hosted: HostedAgents,
): HostedPresence {
  return {
    ...presence,
    status(key: string): PresenceStatus {
      return hosted.hosted(key) ? "online" : presence.status(key);
    },
    subscribe(key: string, listener: () => void, profile = false) {
      const stopPresence = presence.subscribe(key, listener, profile);
      const stopHosted = hosted.subscribe(key, listener);
      return () => {
        stopPresence();
        stopHosted();
      };
    },
    connected(value: boolean) {
      presence.connected(value);
      hosted.connected(value);
    },
    clear(publication?: boolean) {
      presence.clear(publication);
      hosted.clear();
    },
    dispose() {
      presence.dispose();
      hosted.dispose();
    },
    remoteRuntimes: hosted.remoteRuntimes,
  };
}
/** Presence that can learn which runtimes are remote; absent in test doubles. */
export type HostedPresence = Presence & {
  remoteRuntimes?(keys: Iterable<string>): void;
};
