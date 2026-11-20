// One agent's goose sessions, in that agent's own `goose-acp` process. The
// sessions themselves live in the shared ACP client.
import {
  AgentSessions as AcpAgentSessions,
  type SessionsOptions as AcpSessionsOptions,
  savedConversation,
} from "../../features/agent-harness/acp/agent-sessions";
import type { AgentProtection } from "../../features/agent-protection/service";
import { nativeProtectionBridge } from "../../features/agent-protection/native-bridge";
import { GooseProcess, type GooseHost, type ServeMcp } from "./goose";
import type {
  SavedConversation,
  SessionStore,
} from "../../features/agent-harness/acp/agent-sessions";

export {
  abortable,
  absolute,
  IDLE_MS,
  POOL_LIMIT,
  ServerPool,
  type Launch,
  type SavedConversation,
  type SessionStore,
} from "../../features/agent-harness/acp/agent-sessions";

/** The `goose-acp` one agent's sessions open in, started in the home folder
 * when a session first needs it, and again after it exits. Its own process,
 * so its environment carries only this agent's Buzz credential. */
export class AgentProcess {
  /** The start new sessions use. */
  private current: Start | undefined;
  /** Every start whose process has not exited, even when its start failed
   * or a newer one replaced it, so `shutdown` stops each. */
  private readonly starts = new Set<Start>();
  constructor(
    private readonly host: GooseHost,
    /** Starts a session's MCP server for its agent's tools. */
    private readonly serve: ServeMcp,
    private readonly protection?: AgentProtection,
    /** The agent as its latest delivery named it, once known. */
    private readonly agent: () =>
      | Readonly<{ pubkey: string; relay: string }>
      | undefined = () => undefined,
    /** The context size, in tokens, its sessions compact at. */
    private readonly compactAt: () => number | undefined = () => undefined,
  ) {}

  /** The running process. One that failed to start is started again on the
   * next call once it has exited. One started with another compaction limit
   * is left to its sessions, which stop it once none needs it, or stopped
   * first when `drained` says none does, so it holds no process slot. */
  get(
    drained: (process: GooseProcess) => boolean = () => false,
  ): Promise<GooseProcess> {
    this.protection?.assertAvailable();
    const limit = this.compactAt();
    if (this.current && limit === this.current.limit) return this.current.ready;
    const previous = this.current;
    const old = previous?.process;
    const stopped =
      old && drained(old)
        ? old
            .kill()
            .then(() => old.exited)
            .catch(() => undefined)
        : undefined;
    const agent = this.agent();
    const start: Start = {
      limit,
      previous,
      ready: (async () => {
        await stopped;
        const bridge =
          this.protection &&
          (await nativeProtectionBridge(this.serve, this.protection));
        try {
          const goose = await GooseProcess.start(
            (id, options) =>
              this.protection
                ? this.protection.spawn(options ?? {})
                : this.host.spawn(id, options),
            {
              ...(limit && { compactAt: limit }),
              cwd: await this.host.resolveDirectory("~"),
              serve: this.serve,
              onProcess: (goose) => {
                start.process = goose;
              },
              ...(agent && {
                agent: { pubkey: agent.pubkey, relay: agent.relay },
              }),
              ...(bridge && {
                protected: true,
                env: {
                  ...bridge.env,
                  BASH_ENV: null,
                  ENV: null,
                  DYLD_INSERT_LIBRARIES: null,
                  DYLD_LIBRARY_PATH: null,
                  DYLD_FRAMEWORK_PATH: null,
                  LD_PRELOAD: null,
                  LD_LIBRARY_PATH: null,
                },
              }),
            },
          );
          void goose.exited.finally(() => bridge?.close());
          return goose;
        } catch (error) {
          await bridge?.close();
          throw error;
        }
      })(),
    };
    const forget = () => {
      this.starts.delete(start);
      if (this.current !== start) return;
      // One that failed leaves the latest it replaced still running current,
      // so the next start retires it once drained.
      let kept = start.previous;
      while (kept && !this.starts.has(kept)) kept = kept.previous;
      this.current = kept;
    };
    void start.ready.then(
      (goose) => {
        delete start.previous;
        return goose.exited.then(forget);
      },
      () => (start.process ? start.process.exited.then(forget) : forget()),
    );
    this.starts.add(start);
    this.current = start;
    return start.ready;
  }
  /** Stops it, failing every session in it. */
  stop() {
    void this.shutdown().catch(() => undefined);
  }
  /** Stops every process it started and resolves once each has exited,
   * whether or not its start succeeded. Each stays here until then, so a
   * failed stop is repeated. */
  async shutdown() {
    await Promise.all(
      [...this.starts].map(async (start) => {
        await start.ready.catch(() => undefined);
        await start.process?.kill();
        await start.process?.exited;
      }),
    );
  }
}

/** One start of `goose-acp`, the token limit goose read at it, and its
 * process once spawned. Until it succeeds, it keeps the start it replaced. */
type Start = {
  ready: Promise<GooseProcess>;
  limit: number | undefined;
  previous?: Start | undefined;
  process?: GooseProcess;
};

export type SessionsOptions = Omit<AcpSessionsOptions, "label">;

/** An agent's sessions, in its own process. */
export class AgentSessions extends AcpAgentSessions {
  constructor(options: SessionsOptions) {
    super({ ...options, label: "goose" });
  }
}

/** Saved conversations per agent; the least recently used are forgotten. */
const SAVED_LIMIT = 200;

/** Conversations saved in local storage, by agent and then conversation. */
export function localSessions(
  storage: Storage,
  agent: string,
  name = "buzz.goose.sessions.v1",
): SessionStore & {
  /** Saved conversations, most recently used first. */
  list(): [string, SavedConversation][];
} {
  const readAll = (): Record<string, Record<string, SavedConversation>> => {
    try {
      const value = JSON.parse(storage.getItem(name) ?? "{}");
      if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
      // Each agent's damaged conversations are dropped, keeping the rest.
      return Object.fromEntries(
        Object.entries(value).map(([agent, saved]) => [
          agent,
          Object.fromEntries(
            Object.entries(
              saved && typeof saved === "object" ? saved : {},
            ).flatMap(([key, conversation]) => {
              const kept = savedConversation(conversation);
              return kept ? [[key, kept]] : [];
            }),
          ),
        ]),
      );
    } catch {
      return {};
    }
  };
  const list = (saved: Record<string, SavedConversation> = {}) =>
    Object.entries(saved).sort(([, a], [, b]) => b.at - a.at);
  return {
    list: () => list(readAll()[agent]),
    get: (key) => readAll()[agent]?.[key],
    set: (key, saved) => {
      const all = readAll();
      const kept = list({ ...all[agent], [key]: saved }).slice(0, SAVED_LIMIT);
      all[agent] = Object.fromEntries(kept);
      try {
        storage.setItem(name, JSON.stringify(all));
      } catch (error) {
        console.warn("goose sessions were not saved", error);
      }
    },
  };
}
