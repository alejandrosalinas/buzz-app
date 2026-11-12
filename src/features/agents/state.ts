// Agent storage: each agent's settings, the owner's teams, unfinished setups,
// and the sessions agent types save. In the desktop app it lives in the
// `agents/state` folder beside the agent identities, one file per key, so the
// standalone agent host (`buzz-agent-host`) reads and writes the same state.
// Elsewhere, as in a browser, it is this page's localStorage.
//
// Storage reads are synchronous, so the app reads every file once before it
// starts, and then keeps a copy in memory. Each write changes the copy at once
// and is then saved, in order, to its key's file. Another program's later
// writes reach this copy only when the app starts again. `read` reads saved
// state without changing this copy.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { CONFIG_STORAGE_KEY } from "./agent-config";
import { CATCH_UP_KEY, CATCH_UP_PREFIX } from "./catch-up";
import { INTERRUPTED_PREFIX } from "./interrupted";
import { PROMPTS_PREFIX } from "./session-prompts";
import { SYNCED_TEAMS_KEY } from "./team-config";
import { TEAM_MOVES_KEY } from "./team-migration";
import {
  localStore,
  type AgentStore,
  ARCHIVE_UNCHECKED_KEY,
  RECORD_PREFIX,
  STORAGE_KEY,
  TEAMS_KEY,
  UNFINISHED_KEY,
} from "./store";

export { localStore, type AgentStore } from "./store";

/** The localStorage keys of agent state, moved into agent storage once. */
export function isAgentKey(key: string) {
  return (
    key === STORAGE_KEY ||
    key === TEAMS_KEY ||
    key === UNFINISHED_KEY ||
    key === ARCHIVE_UNCHECKED_KEY ||
    key === CATCH_UP_KEY ||
    key.startsWith(CATCH_UP_PREFIX) ||
    key.startsWith(INTERRUPTED_PREFIX) ||
    key.startsWith(RECORD_PREFIX) ||
    key.startsWith("buzz.agent.execution.v1:") ||
    key.startsWith("buzz.agents.session-admission.v1:") ||
    // The sessions the bundled agent types save.
    key.startsWith("buzz.claude-code.sessions.") ||
    key.startsWith("buzz.codex.sessions.") ||
    // What each session started with, for its activity.
    key.startsWith(PROMPTS_PREFIX) ||
    // The relay-synced copies of agent settings that starts use.
    key === CONFIG_STORAGE_KEY ||
    // The synced team rosters that starts use.
    key === SYNCED_TEAMS_KEY ||
    // Local teams' moves to their community, under way.
    key === TEAM_MOVES_KEY ||
    // The device-wide defaults that blank agent settings inherit.
    key === "buzz.claude-code.provider-defaults.v1" ||
    key === "buzz.codex.provider-defaults.v1" ||
    // TEMPORARY agents rename: see migrate-storage.ts.
    key.startsWith("buzz.agents2.")
  );
}

let loaded: AgentStore | undefined;

/** Agent storage, once `loadAgentStorage` has read it; localStorage before
 * that, and outside the desktop app. */
export function agentStorage(): AgentStore {
  return loaded ?? localStore();
}

/** A window without native storage cannot know which agents are bound. */
export function executionStorage(fallback: AgentStore): AgentStore {
  if (!isTauri()) return fallback;
  if (loaded) return loaded;
  return Object.freeze({
    ...fallback,
    read: async () => {
      throw new Error(
        "Native agent storage is unavailable. Restart Buzz before running agents.",
      );
    },
    add: async () => {
      throw new Error(
        "Native agent storage is unavailable. Restart Buzz before running agents.",
      );
    },
  });
}

type Native = Readonly<{
  load(key?: string): Promise<Record<string, string>>;
  set(key: string, value: string | null): Promise<void>;
  /** Saves `value` only if no file holds `key`, in one step; resolves with
   * what the file held when one did, else null. */
  add?(key: string, value: string): Promise<string | null>;
}>;

const native: Native = {
  load: (key) => invoke("app_agent_state_load", { key }),
  set: async (key, value) => {
    await invoke("app_agent_state_set", { key, value });
  },
  add: (key, value) =>
    invoke("app_agent_state_set", { key, value, absent: true }),
};

/** Agent storage holds this key once every agent key in localStorage was
 * moved into it. */
export const MOVED_KEY = "buzz.agents.state-moved.v1";

/** Reads agent storage before the app starts. It moves agent state the app
 * kept in localStorage into it. Before the first move finishes, agent keys in
 * localStorage are the newer copy and replace what agent storage has. After
 * it, agent storage is the full copy: agent keys in localStorage come from a
 * start that could not use agent storage and began with none, so they fill
 * in only keys agent storage does not have. Agent keys leave localStorage
 * only once every one is saved; if agent storage cannot be read, a copy
 * fails, or this takes longer than `timeoutMs`, the app uses localStorage
 * until the next start. */
export async function loadAgentStorage(
  local: Storage = globalThis.localStorage,
  files: Native | undefined = isTauri() ? native : undefined,
  timeoutMs = 15_000,
): Promise<AgentStore> {
  loaded = undefined;
  if (!files) return localStore(local);
  let late = false;
  const move = async () => {
    const storage = fileStore(
      new Map(Object.entries(await files.load())),
      files.set,
      files.add,
      async (key) => (await files.load(key))[key] ?? null,
      async (prefix) =>
        Object.fromEntries(
          Object.entries(await files.load()).filter(([key]) =>
            key.startsWith(prefix),
          ),
        ),
    );
    const moved: string[] = [];
    for (let index = 0; index < local.length; index++) {
      const key = local.key(index);
      if (key && isAgentKey(key)) moved.push(key);
    }
    const finished = storage.get(MOVED_KEY) !== null;
    const copies: Promise<void>[] = [];
    for (const key of moved) {
      const value = local.getItem(key);
      if (value === null || storage.get(key) === value) continue;
      if (finished && storage.get(key) !== null) {
        console.warn(
          `Agent state ${key} from a start without agent storage was not kept`,
        );
        continue;
      }
      copies.push(storage.set(key, value));
    }
    await Promise.all(copies);
    if (!finished) await storage.set(MOVED_KEY, "1");
    // Too late: the app already started with localStorage, which keeps them.
    // So this start's keys are again the newer copy.
    if (late) {
      if (!finished)
        void storage.set(MOVED_KEY, null).catch(() => {
          // Logged by the store; the next start copies the keys again.
        });
      throw new Error("Agent storage took too long");
    }
    for (const key of moved) local.removeItem(key);
    loaded = storage;
    return storage;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      late = true;
      reject(new Error("Agent storage took too long"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([move(), timeout]);
  } catch (error) {
    console.error(
      "Agent storage could not be used; using this window's",
      error,
    );
    return localStore(local);
  } finally {
    clearTimeout(timer);
  }
}

/** Agent storage holds a copy in memory and saves updates in order.
 * Atomic inserts wait only for writes to the same key. A failed write puts
 * back the saved value, so callers can retry it. */
export function fileStore(
  items: Map<string, string>,
  save: Native["set"],
  add: NonNullable<Native["add"]> = async (key, value) => {
    await save(key, value);
    return null;
  },
  read?: (key: string) => Promise<string | null>,
  scan?: AgentStore["scan"],
): AgentStore {
  /** What each key's file holds, as far as this program saved it. */
  const durable = new Map(items);
  /** Each key's last write, until it is saved. */
  const pending = new Map<string, Promise<unknown>>();
  let queue: Promise<unknown> = Promise.resolve();
  const write = (key: string, value: string | null, absent = false) => {
    const same = pending.get(key)?.catch(() => {});
    const before = absent
      ? (same ?? Promise.resolve())
      : Promise.all([queue, same]);
    const next = before.then(async () =>
      absent && value !== null ? add(key, value) : save(key, value),
    );
    pending.set(key, next);
    const done = next.then(
      (held) => {
        const kept = held ?? value;
        if (kept === null) durable.delete(key);
        else durable.set(key, kept);
        if (pending.get(key) !== next) return kept;
        pending.delete(key);
        if (kept !== null) items.set(key, kept);
        return kept;
      },
      (error: unknown) => {
        console.error(`Agent state ${key} was not saved`, error);
        if (pending.get(key) === next) {
          pending.delete(key);
          const kept = durable.get(key);
          if (kept === undefined) items.delete(key);
          else items.set(key, kept);
        }
        throw error;
      },
    );
    if (!absent) queue = done.catch(() => {});
    return done;
  };
  return Object.freeze({
    keys: () => [...items.keys()],
    get: (key: string) => items.get(key) ?? null,
    read: async (key: string) => {
      await pending.get(key);
      return read ? read(key) : (durable.get(key) ?? null);
    },
    scan: async (prefix: string) => {
      await Promise.all(
        [...pending]
          .filter(([key]) => key.startsWith(prefix))
          .map(([, saved]) => saved),
      );
      return scan
        ? scan(prefix)
        : Object.fromEntries(
            [...durable].filter(([key]) => key.startsWith(prefix)),
          );
    },
    set: async (key: string, value: string | null) => {
      if (value === null) items.delete(key);
      else items.set(key, value);
      await write(key, value);
    },
    add: async (key: string, value: string) => {
      const held = items.get(key);
      if (held !== undefined) {
        await pending.get(key);
        return durable.get(key) ?? held;
      }
      items.set(key, value);
      return (await write(key, value, true)) ?? value;
    },
  });
}
