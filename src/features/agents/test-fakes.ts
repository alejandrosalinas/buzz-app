import type { AgentChoicesSnapshot } from "./choices";
import { fileStore } from "./state";
import { localStore, type AgentStore } from "./store";

/** Storage held in memory. It is also agent storage over the same items,
 * which saves as it is set, so a test can seed and read it either way. */
export function memoryStorage(): Storage & AgentStore {
  const items = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
  return Object.assign(storage, localStore(storage));
}

/** Agent storage files that programs share. Each program loads its own copy
 * once, as the app does at start, and then saves into them, adding a key
 * only where none is, as the native files do. A held program's saves wait
 * until it is released. */
export function sharedFiles(initial: Record<string, string> = {}) {
  const disk = new Map(Object.entries(initial));
  const open = (hold?: Promise<void>) =>
    fileStore(
      new Map(disk),
      async (key, value) => {
        await hold;
        if (value === null) disk.delete(key);
        else disk.set(key, value);
      },
      async (key, value) => {
        await hold;
        const held = disk.get(key);
        if (held !== undefined) return held;
        disk.set(key, value);
        return null;
      },
      async (key) => disk.get(key) ?? null,
      async (prefix) =>
        Object.fromEntries([...disk].filter(([key]) => key.startsWith(prefix))),
    );
  return { disk, open };
}

/** A complete, ready agent selection with these managed agents. */
export function readyAgentChoices(
  agents: readonly { pubkey: string; name: string }[],
): AgentChoicesSnapshot {
  const identities = agents.map((agent) => ({
    ...agent,
    managed: true,
    managedName: agent.name,
  }));
  return {
    status: "ready",
    identities,
    selectable: identities,
    archives: { status: "ready", archived: [] },
    templates: { status: "ready", identities, complete: true, pending: false },
    definitions: [],
    complete: true,
    pending: false,
  };
}
