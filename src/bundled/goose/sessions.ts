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
  private ready: Promise<GooseProcess> | undefined;
  /** The process `ready` started, kept until it exits, even when its start
   * failed. */
  private process: GooseProcess | undefined;
  constructor(
    private readonly host: GooseHost,
    /** Starts a session's MCP server for its agent's tools. */
    private readonly serve: ServeMcp,
    private readonly protection?: AgentProtection,
    /** The agent as its latest delivery named it, once known. */
    private readonly agent: () =>
      | Readonly<{ pubkey: string; relay: string }>
      | undefined = () => undefined,
  ) {}

  /** The running process. One that failed to start is started again on the
   * next call once it has exited. */
  get(): Promise<GooseProcess> {
    this.protection?.assertAvailable();
    if (this.ready) return this.ready;
    const agent = this.agent();
    const ready = (async () => {
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
            cwd: await this.host.resolveDirectory("~"),
            serve: this.serve,
            onProcess: (goose) => (this.process = goose),
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
    })();
    const forget = () => {
      if (this.ready !== ready) return;
      this.ready = undefined;
      this.process = undefined;
    };
    // `process` is still this start's: only `forget` lets another begin.
    void ready.then(
      (goose) => goose.exited.then(forget),
      () => (this.process ? this.process.exited.then(forget) : forget()),
    );
    this.ready = ready;
    return ready;
  }
  /** Stops it, failing every session in it. */
  stop() {
    void this.shutdown().catch(() => undefined);
  }
  /** Stops it and resolves once it has exited, whether or not its start
   * succeeded. It stays here until then, so a failed stop is repeated. */
  async shutdown() {
    await this.ready?.catch(() => undefined);
    const goose = this.process;
    await goose?.kill();
    await goose?.exited;
  }
}

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
