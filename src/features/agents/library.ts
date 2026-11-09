/** A display-only projection of the local and owner-authored relay inventory, not proof of
 * ownership, membership, custody or running state. No prompts/configuration. */
export type AgentLibrary = Readonly<{
  definitions: readonly Readonly<{
    id: string;
    name: string;
    avatar?: string;
  }>[];
  identities: readonly Readonly<{
    pubkey: string;
    name: string;
    avatar?: string;
    definitionId?: string;
  }>[];
}>;
export type AgentLibraryReader = (signal: AbortSignal) => Promise<AgentLibrary>;
export type AgentLibrarySnapshot = AgentLibrary &
  Readonly<{
    status: "unavailable" | "idle" | "loading" | "ready" | "error";
    error?: string;
  }>;
const empty = { definitions: Object.freeze([]), identities: Object.freeze([]) };

/** One artwork rule for every agent surface: an identity without its own art
 * shows its linked definition's art. Applied once where the snapshot is made. */
export function inheritDefinitionAvatars<T extends AgentLibrary>(
  library: T,
): T {
  const art = new Map(
    library.definitions.flatMap((row) =>
      row.avatar ? [[row.id, row.avatar] as const] : [],
    ),
  );
  // Keep reader extras such as a partial-source error.
  return {
    ...library,
    identities: library.identities.map((row) => {
      const avatar = row.avatar ?? art.get(row.definitionId ?? "");
      return avatar && avatar !== row.avatar ? { ...row, avatar } : row;
    }),
  };
}
export function createAgentLibrary(
  read: AgentLibraryReader | undefined,
  notify = (listener: () => void) => listener(),
) {
  let closed = false;
  const demands = new Set<object>();
  let controller: AbortController | undefined;
  let pending: Promise<void> | undefined;
  /** Counts clears, so a read joined before a disconnect stays its own. */
  let generation = 0;
  let snapshot: AgentLibrarySnapshot = {
    ...empty,
    status: read ? "idle" : "unavailable",
  };
  const listeners = new Set<() => void>();
  function publish(next: AgentLibrarySnapshot) {
    snapshot = Object.freeze(next);
    for (const listener of listeners) notify(listener);
  }
  /** Joins a read in flight, unless `fresh`: then it supersedes that read,
   * which may predate a change the caller just made, and that read's waiters
   * wait for the new one. */
  function refresh({ fresh = false } = {}): Promise<void> {
    if (closed || !read) return Promise.resolve();
    if (pending && !fresh) return pending;
    controller?.abort();
    const owned = new AbortController();
    controller = owned;
    publish({ ...snapshot, status: "loading" });
    pending = Promise.resolve()
      .then(() => {
        if (closed || owned.signal.aborted)
          throw new Error("Library read cancelled");
        return read(owned.signal);
      })
      .then((library) => {
        if (!closed && !owned.signal.aborted)
          publish({ ...inheritDefinitionAvatars(library), status: "ready" });
      })
      .catch(() => {
        if (!closed && !owned.signal.aborted)
          publish({
            ...snapshot,
            status: "error",
            error:
              "Could not read agent inventory. Check the community connection and local library, then retry; saved data is unchanged.",
          });
      })
      .finally(() => {
        if (controller === owned) {
          controller = undefined;
          pending = undefined;
        }
      })
      // A superseded read's waiters follow the read that replaced it, so a
      // finished refresh always means current inventory.
      .then(() => (controller !== owned && pending ? pending : undefined));
    return pending;
  }
  function clear() {
    generation++;
    controller?.abort();
    controller = undefined;
    pending = undefined;
    publish({ ...empty, status: closed || !read ? "unavailable" : "idle" });
  }
  return {
    queries: Object.freeze({
      snapshot: () => snapshot,
      refresh,
      retain({ refresh: refreshOnRetain = true } = {}) {
        const demand = {};
        demands.add(demand);
        if (refreshOnRetain) void refresh();
        return () => {
          demands.delete(demand);
        };
      },
      subscribe(listener: () => void) {
        if (closed) return () => {};
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    }),
    clear,
    reconnect() {
      // Initial establishment can follow a completed activation read. A real
      // disconnect clears this snapshot; only then is fresh inventory needed,
      // unless a source failed: a partial result is ready but not current.
      if (!demands.size) return;
      const failed = () =>
        snapshot.status === "error" ||
        (snapshot.status === "ready" && !!snapshot.error);
      // A read in flight began before this connection: reuse it, and reread
      // once if it fails.
      const joined = generation;
      if (pending)
        void pending.then(() => {
          if (joined === generation && demands.size && failed()) void refresh();
        });
      else if (snapshot.status !== "ready" || snapshot.error) void refresh();
    },
    dispose() {
      closed = true;
      demands.clear();
      clear();
      listeners.clear();
    },
  };
}
