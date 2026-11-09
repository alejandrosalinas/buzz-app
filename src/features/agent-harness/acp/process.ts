// One ACP harness process, driven over line-delimited JSON-RPC. Each
// conversation is one ACP session in it. Each session gets its own loopback
// HTTP MCP server for its agent's Buzz tools, which the app serves and
// answers: the harness is given its address and token in `session/new`, never
// a Buzz key. What a harness adds to plain ACP comes from its `AcpHooks`.
import { isFinalMessage, MESSAGE_TOOLS } from "../../../buzz-mcp/session-tools";
import type { HostMcpServer, HostProcess } from "../../host/service";
import { AcpSession, type ConfigOptions } from "./session";
import { allow, errorMessage } from "./steps";
import type {
  AcpHooks,
  Choice,
  McpServer,
  PlatformTools,
  ServeMcp,
  Spawn,
  ToolServer,
} from "./types";

/** The Buzz tools that answer where people see it. A read, or a send that
 * failed, still leaves the harness's text to post. */
const ANSWERS = new Set<string>([...MESSAGE_TOOLS, "edit", "react"]);
const STOPPED =
  "Buzz stopped this session's tools: another program used their token";

/** How long a harness has to answer a request that starts it or opens or
 * closes a session. One that does not is stopped. A turn's prompt is never
 * timed. */
export const REQUEST_TIMEOUT_MS = 60_000;

/** The HTTP MCP server every session declares; its tools are named
 * `buzz__<name>`. */
export const TOOL_SERVER = "buzz";

/** How long a harness that failed to start has to exit once stopped. */
export const STOP_TIMEOUT_MS = 5_000;

const STDERR_LIMIT = 4_000;

/** Never reaches a harness, whatever its hooks or launch say: its Buzz tools
 * come over HTTP MCP, never a Buzz key. */
export const PROTECTED_ENV: Readonly<Record<string, null>> = {
  BUZZ_PRIVATE_KEY: null,
  BUZZ_AUTH_TAG: null,
  BUZZ_RELAY_URL: null,
};

/** Exit codes for a program that cannot be found or run, as `env` reports
 * them. */
const MISSING_CODES = new Set([126, 127]);

type Wire = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message: string; data?: unknown };
};
type Pending = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

export class AcpProcess {
  readonly exited: Promise<number | null>;
  private readonly sessions = new Map<string, AcpSession>();
  /** Sessions whose close is in flight or failed, by id. */
  private readonly closing = new Map<string, Promise<Error | undefined>>();
  private readonly calls = new Map<number, Pending>();
  private requests = 0;
  private buffer = "";
  private stderr = "";
  private alive = true;
  private code: number | null | undefined;
  private capabilities: Readonly<Record<string, unknown>> = {};
  /** Whether the harness names untitled sessions, read once. */
  private naming: Promise<boolean> | undefined;

  private constructor(
    private readonly process: HostProcess,
    readonly hooks: AcpHooks,
    private readonly serve: ServeMcp | undefined,
  ) {
    this.exited = process.exited.then((code) => {
      this.alive = false;
      this.code = code;
      const error = new Error(
        this.stderr.trim().split("\n").at(-1) ||
          `${hooks.label} exited (${code ?? "signal"})`,
      );
      for (const call of this.calls.values()) call.reject(error);
      this.calls.clear();
      for (const session of this.sessions.values()) {
        session.fail(error.message);
        void session.server?.close();
      }
      this.sessions.clear();
      return code;
    });
  }

  /** Starts the harness with `args` and checks it can reach the Buzz tools.
   * Sessions with tools need `serve`, which starts their MCP server. Once
   * `signal` aborts, it stops the harness and rejects. */
  static async start(
    spawn: Spawn,
    hooks: AcpHooks,
    launch: Readonly<{
      cwd: string;
      args?: readonly string[];
      env?: Readonly<Record<string, string | null>>;
      serve?: ServeMcp;
      signal?: AbortSignal;
      /** The one agent the harness runs: its tools get its Buzz credential. */
      agent?: Readonly<{ pubkey: string; relay: string }>;
      /** Given the harness as soon as it has started, before `initialize`, so
       * a caller can keep one whose start fails until it has exited. */
      onProcess?: (acp: AcpProcess) => void;
    }>,
  ) {
    const { signal } = launch;
    signal?.throwIfAborted();
    let acp: AcpProcess | undefined;
    const early: string[] = [];
    const earlyErrors: string[] = [];
    const spawning = spawn(hooks.program, {
      cwd: launch.cwd,
      ...(launch.args ? { args: launch.args } : {}),
      env: { ...hooks.env, ...launch.env, ...PROTECTED_ENV },
      agentCredential: !!launch.agent,
      onStdout: (data) => (acp ? acp.read(data) : early.push(data)),
      onStderr: (data) => {
        if (acp) acp.readError(data);
        else if (hooks.diagnoseStartup) earlyErrors.push(data);
      },
    }).catch((error: unknown) => {
      throw /os error 2|no such file|not found/i.test(errorMessage(error))
        ? new Error(hooks.missing)
        : error;
    });
    // A cancel while the host starts it rejects at once; the harness that
    // starts after it is stopped.
    const process = await new Promise<HostProcess>((resolve, reject) => {
      const cancel = () => {
        reject(signal?.reason);
        void spawning.then((late) => late.kill()).catch(() => undefined);
      };
      signal?.addEventListener("abort", cancel, { once: true });
      void spawning
        .then(resolve, reject)
        .finally(() => signal?.removeEventListener("abort", cancel));
    });
    if (launch.agent)
      await process.actAs?.(launch.agent).catch((error: unknown) => {
        void process.kill();
        throw error;
      });
    acp = new AcpProcess(process, hooks, launch.serve);
    launch.onProcess?.(acp);
    for (const data of earlyErrors) acp.readError(data);
    for (const data of early) acp.read(data);
    // A cancel rejects the pending `initialize` at once, clearing its
    // deadline, whether or not the harness ever exits.
    const abort = () => {
      for (const call of acp.calls.values()) call.reject(signal?.reason);
      acp.calls.clear();
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      const init = (await acp.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "buzz", version: "1" },
        },
        REQUEST_TIMEOUT_MS,
      )) as {
        agentCapabilities?: Record<string, unknown> & {
          mcpCapabilities?: { http?: boolean };
        };
      };
      signal?.throwIfAborted();
      acp.capabilities = init.agentCapabilities ?? {};
      if (init.agentCapabilities?.mcpCapabilities?.http !== true)
        throw new Error(
          `This ${hooks.label} cannot reach Buzz tools (no HTTP MCP support)`,
        );
    } catch (error) {
      if (signal?.aborted) {
        void acp.stop(STOP_TIMEOUT_MS);
        throw signal.reason;
      }
      // Rejects once it has exited or the time limit has passed; a caller
      // that must keep one still running takes it through `onProcess`.
      await acp.stop(STOP_TIMEOUT_MS);
      // A program `env` cannot find or run exits before it answers.
      if (hooks.diagnoseStartup && MISSING_CODES.has(acp.code ?? 0))
        throw new Error(hooks.missing);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
    return acp;
  }

  get running() {
    return this.alive;
  }
  get busy() {
    return [...this.sessions.values()].some((session) => session.busy);
  }
  /** The `agentCapabilities` the harness answered `initialize` with. */
  get agentCapabilities() {
    return this.capabilities;
  }
  /** Whether `initialize` advertised `sessionCapabilities[name]`. */
  advertises(name: string) {
    const session = this.capabilities.sessionCapabilities as
      | Record<string, unknown>
      | null
      | undefined;
    const value = session?.[name];
    return typeof value === "object" && value !== null;
  }

  /** Opens a new session in `cwd`, named `title`, whose system prompt has
   * `systemPrompt` appended. With `named`, the harness names it instead when
   * it names sessions, and `named` takes that name. `tools` answers its Buzz
   * tools; without them it has no tools at all. Each turn runs on the
   * provider and model `choice` gives as it starts. */
  async open(
    launch: Readonly<{
      cwd: string;
      systemPrompt: string;
      title?: string;
      named?: (title: string) => void;
      tools?: ToolServer;
      choice?: () => Choice;
      /** Built-ins beside the Buzz tools, for harnesses that take them. */
      platform?: PlatformTools;
      /** Replaces the harness's own base prompt with `systemPrompt` instead
       * of appending it, for small models that a long prompt throws off. */
      replacePrompt?: boolean;
      /** Given the session as soon as the harness has opened it, before it
       * is set up, so a caller can close one whose open then fails. */
      onSession?: (session: AcpSession) => void;
    }>,
  ): Promise<AcpSession> {
    const { hooks } = this;
    const named =
      launch.named && (await this.names()) ? launch.named : undefined;
    const title = named ? undefined : launch.title;
    const provider = launch.choice?.().provider ?? "";
    const { systemPrompt } = launch;
    const prompting = !!systemPrompt && !hooks.systemPrompt;
    const standard = prompting && this.advertises("systemPrompt");
    let server: HostMcpServer | undefined;
    // The harness connects while it opens the session, before it is known here.
    let session: AcpSession | undefined;
    const { tools } = launch;
    if (tools) {
      if (!this.serve)
        throw new Error(`This ${hooks.label} serves no Buzz tools`);
      server = await this.serve((message) => this.mcp(tools, session, message));
    }
    const buzz: McpServer | undefined = server && {
      type: "http",
      name: TOOL_SERVER,
      url: server.url,
      headers: server.headers,
    };
    // The host stops a server whose token a second client used, so the
    // session's tools may be someone else's. A session closed here has
    // already left `sessions`.
    let stopped = false;
    void server?.closed.then(() => {
      stopped = true;
      if (session && this.sessions.get(session.id) === session) {
        session.fail(STOPPED);
        void this.close(session);
      }
    });
    let sessionId: string;
    let opened: ConfigOptions;
    try {
      ({ sessionId, ...opened } = (await this.request(
        "session/new",
        {
          cwd: launch.cwd,
          mcpServers: buzz ? [buzz] : [],
          ...(standard && {
            systemPrompt: {
              mode: "append",
              content: [{ type: "text", text: systemPrompt }],
            },
          }),
          ...(hooks.newSessionMeta && {
            _meta: hooks.newSessionMeta(buzz, {
              ...(title ? { title } : {}),
              provider,
              ...(launch.platform ? { platform: launch.platform } : {}),
            }),
          }),
        },
        REQUEST_TIMEOUT_MS,
      )) as ConfigOptions & { sessionId: string });
    } catch (error) {
      void server?.close();
      throw error;
    }
    session = new AcpSession(
      this,
      sessionId,
      server,
      launch.choice,
      { provider, model: "" },
      prompting && !standard ? systemPrompt : "",
    );
    session.offer(opened);
    session.named = named;
    this.sessions.set(sessionId, session);
    launch.onSession?.(session);
    if (stopped) {
      void this.close(session);
      throw new Error(STOPPED);
    }
    try {
      if (systemPrompt && hooks.systemPrompt)
        await hooks.systemPrompt(
          this,
          sessionId,
          systemPrompt,
          launch.replacePrompt,
        );
    } catch (error) {
      void this.close(session);
      throw error;
    }
    return session;
  }

  private names() {
    const { names } = this.hooks;
    this.naming ??= names ? names(this) : Promise.resolve(false);
    return this.naming;
  }

  /** Ends a session. Its turn, if any, is cancelled first. The harness is
   * asked to close it only when it says it can. A close already started is
   * shared, and one that failed stays failed while the harness runs: `strict`
   * rejects with it, as with a harness that cannot acknowledge one. Once the
   * harness has exited the session counts as closed. */
  async close(session: AcpSession, strict = false) {
    let ending = this.closing.get(session.id);
    if (!ending) {
      if (!this.sessions.delete(session.id)) return;
      ending = this.end(session);
      this.closing.set(session.id, ending);
      const settled = (failure?: unknown) => {
        if (!failure) this.closing.delete(session.id);
      };
      void ending.then(settled, settled);
    }
    const failure = await ending;
    if (failure && strict && this.alive) throw failure;
  }
  private async end(session: AcpSession) {
    session.fail("The session was closed");
    void session.server?.close();
    if (!this.alive) return;
    this.notify("session/cancel", { sessionId: session.id });
    if (this.hooks.closeSession !== "always" && !this.advertises("close"))
      return new Error("The harness cannot acknowledge session retirement");
    try {
      await this.request(
        "session/close",
        { sessionId: session.id },
        REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      console.warn(`${this.hooks.label} did not close a session`, error);
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  kill() {
    return this.process.kill();
  }

  /** Stops the harness, and resolves once it has exited or `timeout` ms
   * have passed, whichever is first. */
  async stop(timeout = REQUEST_TIMEOUT_MS) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.kill()
        .catch(() => undefined)
        .then(() => this.exited),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeout);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /** Sends a request and resolves with its result. When the harness does not
   * answer within `timeout` ms it is stopped, which fails its sessions. */
  request(method: string, params: Record<string, unknown>, timeout?: number) {
    const { label } = this.hooks;
    if (!this.alive)
      return Promise.reject(new Error(`${label} is not running`));
    const id = ++this.requests;
    const answer = new Promise<unknown>((resolve, reject) => {
      if (timeout === undefined) return this.calls.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(
          new Error(
            `${label} did not answer ${method} in ${Math.round(timeout / 1000)}s`,
          ),
        );
        void this.kill();
      }, timeout);
      this.calls.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    this.write({ jsonrpc: "2.0", id, method, params }).catch((error) => {
      this.calls.get(id)?.reject(new Error(String(error)));
      this.calls.delete(id);
    });
    return answer;
  }
  notify(method: string, params: Record<string, unknown>) {
    void this.write({ jsonrpc: "2.0", method, params }).catch(() => undefined);
  }

  private write(message: Wire) {
    return this.process.write(`${JSON.stringify(message)}\n`);
  }
  private readError(data: string) {
    this.stderr = (this.stderr + data).slice(-STDERR_LIMIT);
  }
  private read(data: string) {
    this.buffer += data;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line) continue;
      let message: Wire;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.handle(message);
    }
  }
  private handle(message: Wire) {
    const { id, method } = message;
    if (method === undefined) {
      if (typeof id !== "number") return;
      const call = this.calls.get(id);
      this.calls.delete(id);
      if (message.error)
        call?.reject(
          Object.assign(new Error(errorMessage(message.error)), {
            code: message.error.code,
          }),
        );
      else call?.resolve(message.result);
      return;
    }
    if (id === undefined || id === null) {
      if (method === "session/update") this.update(message.params ?? {});
      return;
    }
    void this.answer(id, method, message.params ?? {});
  }
  private update(params: Record<string, unknown>) {
    const session = this.sessions.get(String(params.sessionId));
    const update = params.update as Record<string, unknown> | undefined;
    if (session && update) session.update(update);
  }
  /** Answers what the harness asks its client: since tools run without
   * asking, any permission prompt with allow. */
  private async answer(
    id: number | string,
    method: string,
    params: Record<string, unknown>,
  ) {
    let reply: Wire;
    if (method === "session/request_permission")
      reply = { jsonrpc: "2.0", id, result: { outcome: allow(params) } };
    else
      reply = {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Buzz does not handle ${method}` },
      };
    return this.write(reply).catch(() => undefined);
  }
  /** One MCP message for a session's Buzz tools, answered with its JSON-RPC
   * response; a notification gets none. A final message that succeeded ends
   * its turn. The host answers a throw with an internal error. */
  private async mcp(
    tools: ToolServer,
    session: AcpSession | undefined,
    message: unknown,
  ): Promise<Wire | undefined> {
    const { id, method = "", params } = (message ?? {}) as Wire;
    if (id === undefined || id === null) return undefined;
    const response = (await tools(session?.conversation, {
      id,
      method,
      params,
    })) as Wire;
    const call = (params ?? {}) as {
      name?: unknown;
      arguments?: { final?: unknown };
      _meta?: Record<string, unknown>;
    };
    const worked =
      method === "tools/call" &&
      !response.error &&
      !(response.result as { isError?: unknown } | undefined)?.isError;
    if (worked && ANSWERS.has(String(call.name))) session?.answered();
    // goose names the ACP tool call behind an MCP call in its `_meta`.
    const toolCall = call._meta?.["agent-tool-call-request-id"];
    if (worked && isFinalMessage(call.name, call.arguments))
      session?.finished(typeof toolCall === "string" ? toolCall : undefined);
    return response;
  }
}
