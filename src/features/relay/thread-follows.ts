/** Explicit thread choices on this device, keyed `channel:root`: `true`
 * follows without replying, `false` unfollows even after participating.
 * Threads without a choice keep automatic participation. */
export type ThreadFollows = ReadonlyMap<string, boolean>;
export type ThreadFollowStorage = Readonly<{
  read(): ThreadFollows;
  /** Throws when the choices were not saved. */
  write(choices: ThreadFollows): void;
  /** Synced stores: saves one choice, resolving only once it is durable. */
  set?(key: string, follow: boolean): Promise<void>;
  /** Synced stores: publication health after the tap, for the sync notice.
   * `complete: false` means some peer's choices could not be read. */
  syncHealth?(): Readonly<{
    status: string;
    complete?: boolean;
    error?: string;
  }>;
  retry?(): Promise<void>;
  /** Another window saved new choices. */
  subscribe(listener: () => void): () => void;
}>;

/** Newest choices win, as the reference keeps its newest roots. */
export const THREAD_FOLLOW_LIMIT = 1000;
const key = (scope: string) => `buzz.thread-follows.v1:${scope}`;

export function memoryThreadFollows(): ThreadFollowStorage {
  let saved: ThreadFollows = new Map();
  return {
    read: () => saved,
    write: (choices) => {
      saved = new Map(choices);
    },
    subscribe: () => () => {},
  };
}

/** Device-local and partitioned by community and viewer, like read state. */
export function browserThreadFollows(scope: string): ThreadFollowStorage {
  return {
    read() {
      try {
        const value: unknown = JSON.parse(
          localStorage.getItem(key(scope)) ?? "[]",
        );
        if (!Array.isArray(value)) return new Map();
        return new Map(
          value
            .filter(
              (entry): entry is [string, boolean] =>
                Array.isArray(entry) &&
                typeof entry[0] === "string" &&
                typeof entry[1] === "boolean",
            )
            .slice(-THREAD_FOLLOW_LIMIT),
        );
      } catch {
        return new Map();
      }
    },
    write(choices) {
      localStorage.setItem(key(scope), JSON.stringify([...choices]));
    },
    subscribe(listener) {
      if (typeof window === "undefined") return () => {};
      const storage = (event: StorageEvent) => {
        if (event.key === key(scope) || event.key === null) listener();
      };
      window.addEventListener("storage", storage);
      return () => window.removeEventListener("storage", storage);
    },
  };
}

/** Forgets one community's thread choices once the viewer has left it. */
export function forgetThreadFollows(scope: string) {
  localStorage.removeItem(key(scope));
}
