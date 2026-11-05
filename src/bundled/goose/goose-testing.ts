// A stand-in for `goose-acp`'s ACP over stdio, for tests.
import {
  answerMcp,
  type HostMcpServer,
  type HostProcess,
  type HostProcessOptions,
  type McpHandler,
} from "../../features/host/service";

type Message = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};

export type FakeTurn = {
  sessionId: string;
  runId: string;
  text: string;
  /** Texts steered into it. */
  steered: string[];
  finish(stopReason?: string): void;
};

export type FakeGoose = {
  id: string;
  options: HostProcessOptions;
  /** Every message written to its stdin. */
  received: Message[];
  /** Each `session/new`'s params. */
  opened: Record<string, unknown>[];
  /** Each system prompt set, by session. */
  prompts: Map<string, string>;
  /** Turns, in the order they began. */
  turns: FakeTurn[];
  closed: string[];
  cancelled: string[];
  deleted: string[];
  /** Each `session/set_config_option`, as `sessionId configId=value`. */
  configured: string[];
  /** When set, `session/set_config_option` fails with it. */
  configError?: string;
  /** The environment it started with. */
  env: Readonly<Record<string, string | null>>;
  /** When set, a turn stays open until it is finished. */
  hold: boolean;
  /** When set, a turn takes a steer and ends before goose answers the steer. */
  endOnSteer: boolean;
  /** Requests it never answers, as a goose that hangs. */
  silent: Set<string>;
  killed: boolean;
  /** Asks the client a request and resolves with its response. */
  ask(method: string, params: Record<string, unknown>): Promise<Message>;
  /** An MCP message for the Buzz tools from `sessionId`, sent to the server
   * its `session/new` declared. */
  mcp(
    sessionId: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Message>;
  update(sessionId: string, update: Record<string, unknown>): void;
  exit(code: number | null, stderr?: string): void;
};

/** A session goose saved, with its messages as goose exports them. */
export type FakeSession = Readonly<{
  sessionId: string;
  title: string;
  cwd: string;
  updatedAt: string;
  conversation: readonly Record<string, unknown>[];
}>;

/** A loopback MCP server `serve` started, as the app's host would. */
export type FakeMcpServer = {
  url: string;
  token: string;
  handler: McpHandler;
  closed: boolean;
  /** Stops it from the host's side, as when a second client initializes. */
  stop(): void;
};

/** A spawn whose `goose` processes answer like `goose-acp`; a
 * `resolveDirectory` that puts `home` for `~`; and a `serve` that starts
 * in-memory MCP servers those processes reach. */
export function fakeSpawn(
  options: Readonly<{
    /** Whether goose says it can reach HTTP MCP servers. */
    http?: boolean;
    home?: string;
    hold?: boolean;
    /** What a turn writes before it ends. */
    reply?: string;
    /** `providers/list` entries, and goose's default provider and model. */
    providers?: readonly Record<string, unknown>[];
    defaults?: Readonly<{ providerId?: string; modelId?: string }>;
    /** Provider fields saved, by provider; `config/save` adds to it. */
    saved?: Map<string, Set<string>>;
    /** What `supported-models/list` returns. */
    supported?: readonly string[];
    /** Saved sessions `session/list` and `session/export` read. */
    history?: readonly FakeSession[];
    /** How many sessions a `session/list` page holds; all by default. */
    page?: number;
    /** Whether goose's config turns session naming off. */
    namingDisabled?: boolean;
    /** goose's `DATABRICKS_MODEL_FILTER`, as its config reads it. */
    modelFilter?: unknown;
    /** Requests each process never answers. */
    silent?: readonly string[];
    /** The thinking levels a session lists on each model, `""` being the
     * one it opens on; one not here lists none. `grouped` lists them in one
     * ACP option group. */
    thinking?: Readonly<
      Record<
        string,
        Readonly<{ current: string; levels: readonly string[]; grouped?: true }>
      >
    >;
  }> = {},
) {
  let defaults = options.defaults;
  // Stored provider models are distinct from catalog defaultModel metadata.
  const providerModels = new Map<string, string>();
  if (defaults?.providerId && defaults.modelId)
    providerModels.set(defaults.providerId, defaults.modelId);
  const processes: FakeGoose[] = [];
  const servers: FakeMcpServer[] = [];
  const serve = async (handler: McpHandler): Promise<HostMcpServer> => {
    const index = servers.length + 1;
    let stopped!: () => void;
    const closed = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    const server: FakeMcpServer = {
      url: `http://127.0.0.1:${40_000 + index}/mcp`,
      token: `token-${index}`,
      handler,
      closed: false,
      stop: () => {
        server.closed = true;
        stopped();
      },
    };
    servers.push(server);
    return {
      url: server.url,
      headers: [{ name: "Authorization", value: `Bearer ${server.token}` }],
      close: async () => server.stop(),
      closed,
    };
  };
  const spawn = async (
    id: string,
    process: HostProcessOptions = {},
  ): Promise<HostProcess> => {
    let resolveExit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    let alive = true;
    let sessions = 0;
    let requests = 0;
    let mcpRequests = 0;
    /** The Buzz MCP server each session was given. */
    const declared = new Map<string, string>();
    /** The model each session was put on; `""` is the one it opened on. */
    const models = new Map<string, string>();
    const configOptions = (sessionId: string) => {
      const thinking = options.thinking?.[models.get(sessionId) ?? ""];
      if (!thinking) return [];
      const levels = thinking.levels.map((level) => ({
        value: level,
        name: level,
      }));
      return [
        {
          id: "thinking_effort",
          category: "thought_level",
          currentValue: thinking.current,
          options: thinking.grouped
            ? [{ group: "levels", name: "Levels", options: levels }]
            : levels,
        },
      ];
    };
    const answers = new Map<number | string, (message: Message) => void>();
    const send = (message: Message) =>
      queueMicrotask(() => {
        if (alive) process.onStdout?.(`${JSON.stringify(message)}\n`);
      });
    const reply = (id: number | string | undefined, result: unknown) =>
      send({ jsonrpc: "2.0", ...(id !== undefined && { id }), result });
    const running = new Map<string, FakeTurn>();
    const fake: FakeGoose = {
      id,
      options: process,
      received: [],
      opened: [],
      prompts: new Map(),
      turns: [],
      closed: [],
      cancelled: [],
      deleted: [],
      configured: [],
      env: process.env ?? {},
      hold: options.hold ?? false,
      endOnSteer: false,
      silent: new Set(options.silent),
      killed: false,
      ask: (method, params) => {
        const requestId = `goose-${++requests}`;
        const answer = new Promise<Message>((resolve) =>
          answers.set(requestId, resolve),
        );
        send({ jsonrpc: "2.0", id: requestId, method, params });
        return answer;
      },
      mcp: async (sessionId, method, params = {}) => {
        const server = servers.find(
          (item) => item.url === declared.get(sessionId),
        );
        if (!server || server.closed)
          throw new Error(`No Buzz MCP server for ${sessionId}`);
        const body = { jsonrpc: "2.0", id: ++mcpRequests, method, params };
        return (await answerMcp(
          server.handler,
          JSON.stringify(body),
        )) as Message;
      },
      update: (sessionId, update) =>
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId, update },
        }),
      exit: (code, stderr = "") => {
        if (!alive) return;
        if (stderr) process.onStderr?.(stderr);
        alive = false;
        resolveExit(code);
      },
    };
    processes.push(fake);
    const handle = (message: Message) => {
      fake.received.push(message);
      const { id, method, params = {} } = message;
      if (method === undefined) {
        if (id !== undefined) answers.get(id)?.(message);
        answers.delete(id ?? "");
        return;
      }
      if (fake.silent.has(method)) return;
      const sessionId = String(params.sessionId ?? "");
      switch (method) {
        case "_buzz/security/capabilities":
          return reply(id, { version: 2 });
        case "initialize":
          return reply(id, {
            protocolVersion: 1,
            agentCapabilities: {
              mcpCapabilities: { http: options.http ?? true, sse: false },
            },
          });
        case "session/new": {
          fake.opened.push(params);
          const sessionId = `session-${++sessions}`;
          const extensions = ((params._meta as Record<string, unknown>)
            ?.enabledExtensions ?? []) as { server?: { url?: string } }[];
          const url = extensions.find((item) => item.server?.url)?.server?.url;
          if (url) declared.set(sessionId, url);
          return reply(id, {
            sessionId,
            configOptions: configOptions(sessionId),
          });
        }
        case "_goose/unstable/session/system-prompt/set":
          fake.prompts.set(sessionId, String(params.text));
          return reply(id, {});
        case "session/prompt": {
          const runId = `run-${fake.turns.length + 1}`;
          const text = (params.prompt as { text: string }[])
            .map((block) => block.text)
            .join("");
          const turn: FakeTurn = {
            sessionId,
            runId,
            text,
            steered: [],
            finish: (stopReason = "end_turn") => {
              if (running.get(sessionId) !== turn) return;
              running.delete(sessionId);
              fake.update(sessionId, {
                sessionUpdate: "session_info_update",
                _meta: { goose: { activeRunId: null } },
              });
              reply(id, { stopReason });
            },
          };
          fake.turns.push(turn);
          running.set(sessionId, turn);
          fake.update(sessionId, {
            sessionUpdate: "session_info_update",
            _meta: { goose: { activeRunId: runId } },
          });
          if (options.reply)
            fake.update(sessionId, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: options.reply },
            });
          if (!fake.hold) queueMicrotask(() => turn.finish());
          return;
        }
        case "_goose/unstable/session/steer": {
          const turn = running.get(sessionId);
          if (!turn || turn.runId !== params.expectedRunId)
            return send({
              jsonrpc: "2.0",
              ...(id !== undefined && { id }),
              error: { code: -32602, message: "No active run" },
            });
          turn.steered.push(
            (params.prompt as { text: string }[])
              .map((block) => block.text)
              .join(""),
          );
          if (fake.endOnSteer) turn.finish();
          return reply(id, { runId: turn.runId, messageId: "m" });
        }
        case "session/set_config_option":
          if (fake.configError)
            return send({
              jsonrpc: "2.0",
              ...(id !== undefined && { id }),
              error: { code: -32603, message: fake.configError },
            });
          fake.configured.push(
            `${sessionId} ${String(params.configId)}=${String(params.value)}`,
          );
          if (params.configId === "model")
            models.set(sessionId, String(params.value));
          if (params.configId === "provider") models.delete(sessionId);
          return reply(id, { configOptions: configOptions(sessionId) });
        case "session/cancel":
          fake.cancelled.push(sessionId);
          running.get(sessionId)?.finish("cancelled");
          return;
        case "_goose/unstable/providers/list":
          // Saving a provider's fields sets it up, as goose lists it after.
          return reply(id, {
            entries: (options.providers ?? []).map((entry) => ({
              ...entry,
              configured:
                Boolean(entry.configured) ||
                Boolean(options.saved?.get(String(entry.providerId))?.size),
            })),
          });
        case "_goose/unstable/config/read":
          return reply(id, {
            value:
              params.key === "providers"
                ? Object.fromEntries(
                    [...providerModels].map(([id, model]) => [id, { model }]),
                  )
                : params.key === "GOOSE_DISABLE_SESSION_NAMING"
                  ? (options.namingDisabled ?? null)
                  : params.key === "DATABRICKS_MODEL_FILTER"
                    ? (options.modelFilter ?? null)
                    : null,
          });
        case "_goose/unstable/defaults/read":
          return reply(id, defaults ?? {});
        case "_goose/unstable/defaults/save": {
          const providerId = String(params.providerId);
          const modelId = String(
            params.modelId || providerModels.get(providerId) || "",
          );
          providerModels.set(providerId, modelId);
          defaults = { providerId, ...(modelId ? { modelId } : {}) };
          return reply(id, {
            providerId,
            ...(params.modelId ? { modelId: String(params.modelId) } : {}),
          });
        }
        case "_goose/unstable/providers/config/read": {
          const set = options.saved?.get(String(params.providerId));
          return reply(id, {
            fields: [...(set ?? [])].map((key) => ({ key, isSet: true })),
          });
        }
        case "_goose/unstable/providers/config/save": {
          const providerId = String(params.providerId);
          const set = options.saved?.get(providerId) ?? new Set<string>();
          for (const field of params.fields as { key: string }[])
            set.add(field.key);
          options.saved?.set(providerId, set);
          return reply(id, { status: { providerId, isConfigured: true } });
        }
        case "_goose/unstable/providers/supported-models/list":
          return reply(id, {
            providerId: params.providerId,
            models: options.supported ?? [],
          });
        case "session/list": {
          const query = String(
            (params._meta as { query?: string } | undefined)?.query ?? "",
          );
          const mentions = (session: FakeSession) =>
            JSON.stringify(session.conversation).includes(query);
          const listed = (options.history ?? []).filter(
            (session) =>
              session.cwd === params.cwd && (!query || mentions(session)),
          );
          const from = Number(params.cursor ?? 0);
          const to = from + (options.page ?? listed.length);
          return reply(id, {
            sessions: listed
              .slice(from, to)
              .map(({ sessionId, title, cwd, updatedAt }) => ({
                sessionId,
                title,
                cwd,
                updatedAt,
              })),
            nextCursor: to < listed.length ? String(to) : null,
          });
        }
        case "_goose/unstable/session/export": {
          const session = options.history?.find(
            (item) => item.sessionId === params.sessionId,
          );
          if (!session)
            return send({
              jsonrpc: "2.0",
              ...(id !== undefined && { id }),
              error: { code: -32603, message: "Session not found" },
            });
          return reply(id, {
            data: JSON.stringify({ id: session.sessionId, ...session }),
          });
        }
        case "session/delete":
          fake.deleted.push(sessionId);
          return reply(id, {});
        case "session/close":
          fake.closed.push(sessionId);
          return reply(id, {});
        default:
          return send({
            jsonrpc: "2.0",
            ...(id !== undefined && { id }),
            error: { code: -32601, message: `Unknown ${method}` },
          });
      }
    };
    let buffer = "";
    return {
      write: async (data) => {
        if (!alive) throw new Error("goose is not running");
        buffer += data;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          handle(JSON.parse(line));
        }
      },
      end: async () => undefined,
      kill: async () => {
        fake.killed = true;
        fake.exit(null);
      },
      exited,
    };
  };
  return {
    spawn,
    resolveDirectory: async (path: string) =>
      path.replace(/^~/, options.home ?? "/home/test"),
    serve,
    processes,
    /** The MCP servers `serve` started, in order. */
    servers,
    /** The `goose` processes started, without `workspace` lookups. */
    get geese() {
      return processes.filter((process) => process.id === "goose");
    },
  };
}

/** Lets queued microtasks and the timers they start run. */
export const flush = async (rounds = 10) => {
  for (let index = 0; index < rounds; index++) await Promise.resolve();
};

/** Holds each goose's requests for `method` until they are released, as a
 * slow goose's answers are; those whose session `rejects` names are answered
 * with an error instead. `wrap` makes the spawn that hands them out. */
export function gated(
  method: string,
  rejects: (sessionId: string) => boolean = () => false,
) {
  const held: { sessionId: string; resume(): void }[] = [];
  return {
    wrap:
      (spawn: ReturnType<typeof fakeSpawn>["spawn"]) =>
      async (id: string, options: HostProcessOptions = {}) => {
        const process = await spawn(id, options);
        return {
          ...process,
          write: async (data: string) => {
            if (id !== "goose" || !data.includes(`"method":"${method}"`))
              return process.write(data);
            const { id: requestId, params } = JSON.parse(data);
            const sessionId = String(params?.sessionId ?? "");
            await new Promise<void>((resume) =>
              held.push({ sessionId, resume }),
            );
            if (!rejects(sessionId)) return process.write(data);
            options.onStdout?.(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: requestId,
                error: { code: -32602, message: "No active run" },
              })}\n`,
            );
          },
        };
      },
    /** The sessions whose request is held. */
    waiting: () => held.map((request) => request.sessionId),
    /** Lets the request of `sessionId` go, or every held one. */
    release: (sessionId?: string) => {
      for (const request of held.splice(0))
        if (sessionId === undefined || request.sessionId === sessionId)
          request.resume();
        else held.push(request);
    },
  };
}
