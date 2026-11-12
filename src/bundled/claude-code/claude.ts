import {
  isTextSource,
  snapshotJSON,
  writeJSON,
} from "../../features/agent-protection/json-stream";
import { CLAUDE_HOOK_EVENTS, type ClaudeHook } from "./hooks";
// One `claude` process driven over its stream-json protocol: the protocol the
// Claude Agent SDK speaks to the same binary, so no Node runtime is needed. The
// process stays alive between turns; messages sent while it works are folded
// into the running turn at its next tool call. Buzz tools are served over the
// same pipe, as the SDK serves an in-process MCP server, so the process holds
// no Buzz key.
import { MESSAGE_TOOLS } from "../../buzz-mcp/session-tools";
import { limited } from "../../features/agents/session-usage";
import type {
  HostProcess,
  HostProcessOptions,
} from "../../features/host/service";
import {
  PROTECTED_CLAUDE_ROOT,
  protectedRuntime,
  protectionSources,
  retainProtectionHistory,
  type ClaudeProtection,
} from "./security";

export type ActivityReceipt = Readonly<{
  /** Presentation destination; channel-shared sessions may handle several threads. */
  activityScope?: string;
  step?: (tool: string, target?: string) => void;
  acknowledged?: () => void;
  superseded?: () => void;
}>;

export type Spawn = (
  id: string,
  options?: HostProcessOptions,
) => Promise<HostProcess>;

export type ClaudeLaunch = Readonly<{
  protection?: ClaudeProtection;
  cwd: string;
  /** Folders besides `cwd` that the session may work in and stay in. */
  directories?: readonly string[];
  /** Read-only catalog probe, without workspace customizations or tools. */
  discovery?: boolean;
  /** Runs the protected release, as the host verified it, without protection
   * hooks: a temporary review. A protected launch always does. */
  pinned?: boolean;
  /** Native validation for a temporary review's structured result. */
  outputSchema?: Readonly<Record<string, unknown>>;
  /** A security review's own Claude folder (absolute), in place of
   * `~/.claude`, which contained agents can write, and the environment it
   * authenticates with (`ClaudeAuth.review`). */
  review?: Readonly<{
    home: string;
    env: Readonly<Record<string, string | null>>;
  }>;
  /** Appended to Claude's own system prompt. */
  systemPrompt: string;
  model?: string;
  /** The session's own effort level; absent is Claude's default. */
  effort?: string;
  /** A saved session to continue. */
  resume?: string;
  /** The id a new session takes, so it is known before its first turn. */
  sessionId?: string;
  /** The in-process MCP server's tools. */
  tools?: ToolServer;
  hook?: ClaudeHook;
  /** The agent it works for: the `buzz` it runs acts as that agent. */
  agent?: Readonly<{ pubkey: string; relay: string }>;
}>;

/** Answers the in-process server's JSON-RPC for the conversation a process
 * serves. A `send` or `reply_in_subthread` with `final: true` ends the turn when it succeeds. */
export type ToolServer = (
  conversation: string | undefined,
  message: unknown,
  /** Aborts when the process stops, so a stopped turn's tool does not act. */
  signal: AbortSignal,
) => Promise<unknown>;
/** Its tools are `mcp__buzz__<name>`. */
export const TOOL_SERVER = "buzz";
/** The tools that take `final`, as a hook matcher pattern. */
const FINAL_TOOL = `mcp__${TOOL_SERVER}__(${MESSAGE_TOOLS.join("|")})`;
const FINAL_NAME = new RegExp(`^${FINAL_TOOL}$`);

type Message = Record<string, unknown> & { type?: string; subtype?: string };

/** A model Claude lists as one a session can switch to. */
export type ClaudeModel = Readonly<{
  /** What `set_model` takes: an alias such as `opus`, or a model id. */
  value: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: readonly string[];
}>;
/** What the next turn is asked to run with; absent is the session's own. */
export type TurnPick = Readonly<{ model?: string; effort?: string }>;

/** How a burst of work ended: every message sent so far has been answered,
 * or the process is gone. */
export type Settled = Readonly<{
  ok: boolean;
  /** Why it failed, for the person waiting. */
  error?: string;
  /** The message failed before any turn took it in. */
  undelivered?: true;
  /** The owner's interrupt ended the turn. */
  stopped?: true;
}>;

const STDERR_LIMIT = 4_000;
/** What `claude` is started with: as the SDK starts it, reporting when it is
 * idle, and never as part of a Claude session that started the app. Its
 * credentials come from `ClaudeAuth`. */
export const ENV: Readonly<Record<string, string | null>> = {
  CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
  CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
  // Buzz keeps its own copy current; Claude must not install itself elsewhere.
  DISABLE_AUTOUPDATER: "1",
  // Only `ClaudeAuth` gives a key: one in the shell that launched the app
  // would outrank it, and stream-json mode uses it without asking.
  ANTHROPIC_API_KEY: null,
  CLAUDECODE: null,
  CLAUDE_CODE_SESSION_ID: null,
  CLAUDE_CODE_CHILD_SESSION: null,
  CLAUDE_CODE_MESSAGING_SOCKET: null,
  CLAUDE_CODE_MESSAGING_TOKEN: null,
  CLAUDE_CODE_SESSION_ATTENDED: null,
  CLAUDE_AGENT_SDK_VERSION: null,
  CLAUDE_PID: null,
};

export class ClaudeProcess {
  private protection: ClaudeProtection | undefined;
  private protectionLifetime = new AbortController();
  private protectedInstructions = "";
  private protectedHistory: unknown = [];
  private readonly protectedEvents: Message[] = [];
  private resuming = false;
  private reviewText = "";
  private reviewOutput: unknown;
  get result() {
    return this.reviewText;
  }
  get structuredResult() {
    if (this.reviewOutput === undefined)
      throw new Error("The security model returned no structured result");
    return JSON.stringify(this.reviewOutput);
  }
  captureProtectionContext() {
    const release = retainProtectionHistory(this.protectedHistory);
    return {
      value: snapshotJSON({
        transcript: this.protectedHistory,
        events: this.protectedEvents,
      }),
      release,
    };
  }
  /** Its session, known once the first turn starts (or at once when resuming). */
  sessionId: string | undefined;
  /** The conversation it serves, set when a spare is put to use. */
  conversation: string | undefined;
  /** Messages sent and not yet answered. */
  private pending = 0;
  /** It has begun a turn, so its session loaded. */
  private began = false;
  /** The model the session reported when it began. */
  private reported: string | undefined;
  private waiters: ((settled: Settled) => void)[] = [];
  private buffer = "";
  private stderr = "";
  private lastError: string | undefined;
  /** A `/compact` was sent: its failure fails the turn, unlike an automatic
   * compaction's mid-turn. */
  private compacting = false;
  private alive = true;
  /** The owner stopped the running turn, so how it ends is not a failure. */
  private stopping = false;
  /** Claude ended a turn aborted while the owner was stopping it. */
  private stopped = false;
  /** Aborts when the owner stops the work. The next turn, sent or its own,
   * starts anew, so a stopped turn's tool calls stay stopped. */
  private workLifetime = new AbortController();
  /** The owner's Stop awaiting Claude's answer, for the work it stopped;
   * another Stop of that work shares it. */
  private stopRequest:
    | Readonly<{ work: AbortController; done: Promise<void> }>
    | undefined;
  /** It reports idle; an older `claude` that does not is settled per result. */
  private reportsState = false;
  /** It runs a turn of its own, such as one a finished background task starts. */
  private working = false;
  /** Its live background tasks that are activity, as Claude last listed them. */
  private tasks = 0;
  /** Called when it was active and is no longer. */
  onActivity: (() => void) | undefined;
  onQuiet?: () => void;
  private requests = 0;
  /** Control requests awaiting Claude's answer, by request id. */
  private calls = new Map<string, (response: Message) => void>();
  /** The models Claude lists, from its answer to `initialize`. */
  private listed: Promise<readonly ClaudeModel[]> = Promise.resolve([]);
  /** The model the next turn runs on; undefined is the session's own. */
  private pickedModel: string | undefined;
  /** The effort the next turn runs at; undefined is the session's own. */
  private effort: string | undefined;
  /** The session's own effort, read before the first change to restore it. */
  private ownEffort: string | undefined;
  private readingEffort: Promise<void> | undefined;
  readonly exited: Promise<number | null>;

  private constructor(
    private readonly process: HostProcess,
    resume: string | undefined,
    private tools: ToolServer | undefined,
    /** The session's own model, as launched; undefined is Claude's default. */
    private readonly ownModel: string | undefined,
    private hook?: ClaudeHook,
  ) {
    this.sessionId = resume;
    this.exited = process.exited.then((code) => {
      this.protectionLifetime.abort();
      this.alive = false;
      for (const resolve of this.calls.values())
        resolve({ subtype: "error", error: "Claude exited" });
      this.calls.clear();
      const error =
        this.lastError ??
        (this.stderr.trim().split("\n").at(-1) ||
          `Claude exited (${code ?? "signal"})`);
      this.settle(
        this.stopped && !this.lastError
          ? { ok: true, stopped: true }
          : { ok: false, error },
      );
      return code;
    });
  }

  static async start(spawn: Spawn, launch: ClaudeLaunch) {
    const claude = await ClaudeProcess.spawn(spawn, launch);
    await claude.initialize(launch);
    return claude;
  }

  /** Starts `claude` without its prompt. This is most of what a start costs,
   * and fixes nothing about the agent it serves but its folder, model and
   * effort. */
  static async spawn(
    spawn: Spawn,
    launch: Omit<ClaudeLaunch, "systemPrompt"> & { systemPrompt?: string },
  ) {
    launch.protection?.gate.assertAvailable();
    const security = launch.protection;
    const pinned =
      security || launch.pinned ? await protectedRuntime(spawn) : undefined;
    let claude: ClaudeProcess | undefined;
    const early: string[] = [];
    const earlyErrors: string[] = [];
    const process = await spawn(pinned ?? "claude", {
      args: [
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--verbose",
        "--replay-user-messages",
        // Recent models return empty thinking unless asked for summaries.
        "--thinking-display",
        "summarized",
        // Settings files can set env, hooks and apiKeyHelper, and a contained
        // worker can write them: no pinned launch reads them. Claude still
        // reads its folder's sign-in and cached managed settings: a review's
        // own folder (`review`), and `~/.claude` for protected runs.
        ...(pinned ? ["--setting-sources", ""] : []),
        ...(security
          ? [
              "--system-prompt",
              launch.systemPrompt ?? "",
              "--strict-mcp-config",
              "--disable-slash-commands",
            ]
          : []),
        ...(launch.discovery
          ? [
              "--safe-mode",
              "--tools",
              "",
              "--strict-mcp-config",
              "--no-session-persistence",
            ]
          : ["--permission-mode", "bypassPermissions"]),
        ...(launch.directories ?? []).flatMap((folder) => [
          "--add-dir",
          folder,
        ]),
        ...(launch.model ? ["--model", launch.model] : []),
        ...(launch.outputSchema
          ? ["--json-schema", JSON.stringify(launch.outputSchema)]
          : []),
        ...(launch.effort ? ["--effort", launch.effort] : []),
        ...(launch.resume ? ["--resume", launch.resume] : []),
        ...(!launch.resume && launch.sessionId
          ? ["--session-id", launch.sessionId]
          : []),
        ...(launch.tools
          ? [
              "--mcp-config",
              JSON.stringify({
                mcpServers: {
                  // Its tools load on search, but for those it marks with
                  // `_meta["anthropic/alwaysLoad"]`.
                  [TOOL_SERVER]: { type: "sdk", name: TOOL_SERVER },
                },
              }),
            ]
          : []),
      ],
      cwd: launch.cwd,
      // A spare is started before the agent it serves is known.
      agentCredential: !launch.discovery,
      env: {
        ...ENV,
        ...(launch.discovery
          ? {
              CLAUDE_CODE_DISABLE_FILE_MENTIONS: "1",
              CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
              CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
              CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
            }
          : {}),
        ...(security
          ? {
              CLAUDE_CODE_EAGER_FLUSH: "1",
              DISABLE_COMPACT: "1",
              CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
              ANTHROPIC_BETAS: null,
              CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1",
              CLAUDE_CODE_DISABLE_REFUSAL_RETRY: "1",
              CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
              CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
              CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
              CLAUDE_CODE_DISABLE_FILE_MENTIONS: "1",
              CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
              CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
              CLAUDE_CODE_DISABLE_CRON: "1",
              BASH_ENV: null,
              ENV: null,
              DYLD_INSERT_LIBRARIES: null,
              DYLD_LIBRARY_PATH: null,
              DYLD_FRAMEWORK_PATH: null,
              LD_PRELOAD: null,
              LD_LIBRARY_PATH: null,
            }
          : {}),
        ...(launch.review
          ? {
              CLAUDE_CONFIG_DIR: launch.review.home,
              // What would pick other credentials or an endpoint over them:
              // the pinned release's variables as read from 2.1.312's
              // strings, as hygiene for the person's own environment. Never
              // set CLAUDE_CODE_SIMPLE, which ignores an OAuth token.
              ANTHROPIC_AUTH_TOKEN: null,
              ANTHROPIC_BASE_URL: null,
              CLAUDE_CODE_API_BASE_URL: null,
              CLAUDE_CODE_SIMPLE: null,
              ANTHROPIC_UNIX_SOCKET: null,
              CLAUDE_CODE_REMOTE_SESSION_ID: null,
              CLAUDE_CODE_USE_BEDROCK: null,
              CLAUDE_CODE_USE_VERTEX: null,
              CLAUDE_CODE_USE_FOUNDRY: null,
              CLAUDE_CODE_USE_GATEWAY: null,
              CLAUDE_CODE_USE_MANTLE: null,
              CLAUDE_CODE_USE_ANTHROPIC_AWS: null,
              CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: null,
              ...launch.review.env,
            }
          : {}),
      },
      // Contained, so the host runs its verified copy, never the folder's.
      ...(pinned
        ? {
            protection: {
              readOnlyPaths: [
                ...(security?.gate.processProtection.readOnlyPaths ?? []),
                PROTECTED_CLAUDE_ROOT,
              ],
              hiddenPaths: security?.gate.processProtection.hiddenPaths ?? [],
            },
          }
        : {}),
      onStdout: (data) => (claude ? claude.read(data) : early.push(data)),
      onStderr: (data) =>
        claude ? claude.readError(data) : earlyErrors.push(data),
    });
    claude = new ClaudeProcess(
      process,
      launch.resume ?? launch.sessionId,
      launch.tools,
      launch.model,
      launch.hook,
    );
    claude.protection = launch.protection;
    claude.resuming = !!launch.resume;
    claude.protectedInstructions = launch.systemPrompt ?? "";
    for (const data of earlyErrors) claude.readError(data);
    for (const data of early) claude.read(data);
    return claude;
  }

  /** Gives a started process its prompt, and its tools to whoever it now
   * works for. Loads settings and tools now rather than on the first message. */
  async initialize(
    launch: Pick<
      ClaudeLaunch,
      "systemPrompt" | "tools" | "protection" | "hook" | "agent"
    >,
  ) {
    if (launch.agent)
      // An inherited token that acts for nobody fails every `buzz` call, so a
      // process that cannot act as its agent is stopped, as other harnesses do.
      await this.process.actAs?.(launch.agent).catch((error: unknown) => {
        void this.kill();
        throw error;
      });
    try {
      if (launch.tools) this.tools = launch.tools;
      this.hook = launch.protection ? undefined : launch.hook;
      const { written, answer } = this.request({
        subtype: "initialize",
        ...(!launch.protection
          ? { appendSystemPrompt: launch.systemPrompt }
          : {}),
        ...(launch.tools || launch.protection
          ? {
              ...(launch.tools ? { sdkMcpServers: [TOOL_SERVER] } : {}),
              hooks: {
                ...(launch.protection
                  ? {
                      PreToolUse: [
                        { hookCallbackIds: ["security-tool"], timeout: 600 },
                      ],
                      PreCompact: [
                        {
                          hookCallbackIds: ["security-incomplete"],
                          timeout: 600,
                        },
                      ],
                      SessionStart: [
                        { hookCallbackIds: ["security-session"], timeout: 600 },
                      ],
                      UserPromptSubmit: [
                        {
                          hookCallbackIds: ["security-incoming"],
                          timeout: 600,
                        },
                      ],
                      PostToolBatch: [
                        {
                          hookCallbackIds: ["security-incoming"],
                          timeout: 600,
                        },
                      ],
                      PostToolUseFailure: [
                        {
                          hookCallbackIds: ["security-incoming"],
                          timeout: 600,
                        },
                      ],
                    }
                  : Object.fromEntries(
                      CLAUDE_HOOK_EVENTS.map((event) => [
                        event,
                        [{ hookCallbackIds: [`buzz:${event}`] }],
                      ]),
                    )),
                PostToolUse: [
                  ...(launch.protection
                    ? [{ hookCallbackIds: ["security-incoming"], timeout: 600 }]
                    : [{ hookCallbackIds: ["buzz:PostToolUse"] }]),
                  ...(launch.tools
                    ? [{ matcher: FINAL_TOOL, hookCallbackIds: ["final"] }]
                    : []),
                ],
              },
            }
          : {}),
      });
      await written;
      if (launch.protection) {
        const timer = setTimeout(() => void this.kill(), 15_000);
        try {
          const response = await answer;
          if (response.subtype !== "success")
            throw new Error(
              `Claude did not register protection hooks: ${String(response.error)}`,
            );
        } finally {
          clearTimeout(timer);
        }
      }
      this.listed = answer.then((response) => {
        const models = (response.response as Message | undefined)?.models;
        return Array.isArray(models)
          ? models.filter(
              (model): model is ClaudeModel => typeof model?.value === "string",
            )
          : [];
      });
    } catch (error) {
      await this.kill();
      await this.exited;
      throw error;
    }
  }

  get running() {
    return this.alive;
  }
  get busy() {
    return this.pending > 0;
  }
  /** Busy, in a turn of its own, or running background work that may call back. */
  get active() {
    return this.busy || this.working || this.tasks > 0;
  }
  get started() {
    return this.began;
  }
  get model() {
    return this.reported;
  }
  /** The models this session can switch to, without sending a turn. */
  models() {
    return this.listed;
  }
  /** The effort a turn without a pick runs at, when Claude reports it. */
  async readEffort() {
    await this.readOwnEffort();
    return this.ownEffort;
  }
  /** Settings resolve the default model without sending a paid user turn. */
  async readModel() {
    // Settings report a picked model, which is not the session's own.
    if (this.reported || this.pickedModel !== undefined) return this.reported;
    const answer = await this.call({ subtype: "get_settings" });
    const applied = (answer.response as Message | undefined)?.applied as
      | Message
      | undefined;
    if (typeof applied?.model === "string") this.reported = applied.model;
    return this.reported;
  }

  /** Sends one user message. Resolves when it, and anything sent after it, has
   * been answered and the session is idle again. A new turn runs with the
   * picked model and effort, or the session's own without them; a message
   * folded into a running turn changes only what it asks for. */
  send(
    text: import("../../features/agent-protection/json-stream").ReviewText,
    { model, effort, ...activity }: TurnPick & ActivityReceipt = {},
  ): Promise<Settled> {
    if (!this.alive)
      return Promise.resolve({
        ok: false,
        error: "Claude is not running",
      });
    // The model first: effort applies to whichever model runs.
    this.setModel(model !== undefined || !this.busy ? model : this.pickedModel);
    this.setEffort(effort !== undefined || !this.busy ? effort : this.effort);
    // A message folded into a running turn shares its lifetime.
    if (!this.busy && !this.working) this.renew();
    const uuid = crypto.randomUUID();
    this.receipts.set(uuid, activity);
    this.pending++;
    if (text === "/compact") this.compacting = true;
    const settled = new Promise<Settled>((resolve) =>
      this.waiters.push(resolve),
    );
    this.write({
      type: "user",
      uuid,
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
    }).catch((error) =>
      this.settle({
        ok: false,
        error: `Claude did not take the message: ${error}`,
      }),
    );
    return settled;
  }

  /** Stops the running turn, as the SDK's `interrupt` does; messages folded
   * into it end with it. The turn then settles as Claude ends it. */
  interrupt() {
    // One answer for every Stop of the same work, so one's failure cannot
    // revive work another stopped; newer work is stopped anew.
    const work = this.workLifetime;
    if (this.stopRequest?.work === work) return this.stopRequest.done;
    const done: Promise<void> = this.stop().finally(() => {
      if (this.stopRequest?.done === done) this.stopRequest = undefined;
    });
    this.stopRequest = { work, done };
    return done;
  }
  private async stop() {
    if (!this.alive || !this.active) return;
    this.stopping = true;
    const work = this.workLifetime;
    const fresh = !work.signal.aborted;
    work.abort(new Error("The owner stopped the turn"));
    if (this.protection) {
      this.protectionLifetime.abort();
      this.stopped = true;
      await this.process.kill();
      await this.exited;
      return;
    }
    const answer = await this.call({ subtype: "interrupt" });
    // The turn goes on, and so do its calls, unless an earlier Stop stopped it.
    if (answer.subtype === "error" && this.alive) {
      if (fresh && this.workLifetime === work) {
        this.stopping = false;
        this.workLifetime = new AbortController();
      }
      throw new Error(`Claude did not stop: ${String(answer.error)}`);
    }
  }

  private renew() {
    if (this.workLifetime.signal.aborted)
      this.workLifetime = new AbortController();
  }

  kill() {
    this.protectionLifetime.abort();
    return this.process.kill();
  }

  private write(message: Message) {
    return writeJSON(this.process, message);
  }
  /** Writes a control request: `written` settles with the write, `answer`
   * with Claude's response. */
  private request(request: Message) {
    const id = `buzz-${++this.requests}`;
    const answer = new Promise<Message>((resolve) =>
      this.calls.set(id, resolve),
    );
    const written = this.write({
      type: "control_request",
      request_id: id,
      request,
    });
    return { written, answer };
  }
  /** Sends a control request and resolves with Claude's response. */
  private call(request: Message): Promise<Message> {
    const { written, answer } = this.request(request);
    return written.then(() => answer);
  }
  /** Switches model without restarting, as the SDK's `setModel` does. Back to
   * the session's own is the model it was launched with, or the default. A
   * new model misses the prompt cache, which the owner accepts by picking. */
  private setModel(model: string | undefined) {
    if (model === this.pickedModel) return;
    this.pickedModel = model;
    const next = model ?? this.ownModel;
    void this.call({
      subtype: "set_model",
      ...(next ? { model: next } : {}),
    }).then((answer) => {
      if (answer.subtype !== "success")
        console.warn("Claude did not change its model", answer.error);
    });
  }
  /** Changes effort without restarting, which keeps the prompt cache: Claude
   * Code sends effort per message. Clearing the flag setting would not restore
   * the session's own level, so that is read before the first change and set
   * back explicitly. Written ahead of the message without waiting, as Claude
   * Code takes its input in order, so a turn never waits on it. */
  private setEffort(effort: string | undefined) {
    if (effort === this.effort) return;
    void this.readOwnEffort();
    const level = effort ?? this.ownEffort;
    if (!level) {
      console.warn("Claude's own effort is unknown; keeping the last one");
      return;
    }
    this.effort = effort;
    void this.call({
      subtype: "apply_flag_settings",
      settings: { effortLevel: level },
    }).then((answer) => {
      if (answer.subtype !== "success")
        console.warn("Claude did not change its effort", answer.error);
    });
  }
  /** Read once, ahead of the first change, so it is the session's own. */
  private readOwnEffort() {
    this.readingEffort ??= this.call({ subtype: "get_settings" }).then(
      (answer) => {
        const applied = (answer.response as Message | undefined)?.applied as
          | Message
          | undefined;
        if (typeof applied?.effort === "string")
          this.ownEffort = applied.effort;
      },
    );
    return this.readingEffort;
  }
  private settle(settled: Settled) {
    this.pending = 0;
    this.receipts.clear();
    this.activeReceipts.clear();
    this.lastError = undefined;
    this.stopping = false;
    this.stopped = false;
    this.compacting = false;
    for (const resolve of this.waiters.splice(0)) resolve(settled);
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
      let message: Message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.handle(message);
    }
  }
  // Replay acknowledgments are correlated by the UUID we supplied, never by
  // prompt text or tool-result user messages. Only the latest acknowledged
  // request gets steps; settling ends all requests, not just the latest one.
  private readonly receipts = new Map<string, ActivityReceipt>();
  private readonly activeReceipts = new Map<string, ActivityReceipt>();
  private handle(message: Message) {
    // The CLI may emit a tool callback before its asynchronous transcript write.
    // Keep native protocol evidence alongside persisted history, without replacing it.
    if (this.protection && ["user", "assistant"].includes(String(message.type)))
      this.protectedEvents.push(structuredClone(message));
    if (message.type === "result") {
      this.reviewOutput = message.structured_output;
      if (typeof message.result === "string") this.reviewText = message.result;
    }
    if (typeof message.session_id === "string" && message.session_id)
      this.sessionId = message.session_id;
    if (message.type === "system" && message.subtype === "init") {
      this.began = true;
      // A picked model is not the session's own.
      if (typeof message.model === "string" && this.pickedModel === undefined)
        this.reported = message.model;
    }
    if (message.type === "control_request") {
      void this.answer(message);
      return;
    }
    if (message.type === "control_response") {
      const response = (message.response ?? {}) as Message;
      const id = String(response.request_id);
      this.calls.get(id)?.(response);
      this.calls.delete(id);
      return;
    }
    if (
      message.type === "system" &&
      message.subtype === "session_state_changed"
    ) {
      this.reportsState = true;
      const active = this.active;
      const starts = !this.working && !this.busy && message.state !== "idle";
      this.working = message.state !== "idle";
      // A turn of its own, such as a background task's, is new work.
      if (starts) this.renew();
      if (!this.working && this.pending) this.done();
      if (!this.active) this.stopping = false;
      if (active !== this.active) this.onActivity?.();
      if (active && !this.active) this.onQuiet?.();
      return;
    }
    // The whole set each time; ambient tasks, such as watchers, are not activity.
    if (
      message.type === "system" &&
      message.subtype === "background_tasks_changed" &&
      Array.isArray(message.tasks)
    ) {
      const active = this.active;
      this.tasks = message.tasks.filter(
        (task) => !(task as Message | null)?.ambient,
      ).length;
      if (!this.active) this.stopping = false;
      if (active !== this.active) this.onActivity?.();
      if (active && !this.active) this.onQuiet?.();
      return;
    }
    // `/compact` ends in a successful result even when compacting failed.
    if (
      this.compacting &&
      message.type === "system" &&
      message.subtype === "status" &&
      message.compact_result === "failed"
    ) {
      this.lastError =
        typeof message.compact_error === "string" && message.compact_error
          ? message.compact_error
          : "Claude could not compact the session";
      return;
    }
    if (
      message.type === "user" &&
      message.isReplay === true &&
      typeof message.uuid === "string"
    ) {
      const receipt = this.receipts.get(message.uuid);
      if (receipt) {
        this.receipts.delete(message.uuid);
        // Watches/timers have no message activity: they must not hide a mention.
        if (receipt.step) {
          const scope = receipt.activityScope ?? "conversation";
          this.activeReceipts.get(scope)?.superseded?.();
          this.activeReceipts.set(scope, receipt);
          receipt.acknowledged?.();
        }
      }
      return;
    }
    if (message.type === "assistant") {
      const step = stepLabel(message);
      if (step)
        for (const receipt of this.activeReceipts.values())
          receipt.step?.(step.tool, step.target);
      return;
    }
    if (message.type !== "result") return;
    // A turn that finished before the interrupt took effect is not stopped,
    // and a stopped turn of its own has no message to settle.
    if (
      this.pending &&
      this.stopping &&
      (message.is_error || message.terminal_reason === "aborted_streaming")
    )
      this.stopped = true;
    // An interrupt is not a failure to report: Claude ends a turn stopped
    // mid-tool as `error_during_execution`.
    if (
      message.is_error &&
      !this.stopping &&
      message.terminal_reason !== "aborted_streaming"
    )
      this.lastError =
        typeof message.result === "string" && message.result
          ? message.result
          : `Claude stopped (${String(message.subtype)})`;
    if (!this.reportsState && this.pending) this.done();
  }
  private done() {
    const error = this.lastError;
    this.settle(
      error
        ? { ok: false, error }
        : this.stopped
          ? { ok: true, stopped: true }
          : { ok: true },
    );
  }
  /** Answers what Claude asks its host: calls to the Buzz tools, the
   * hook after `send`, and, since permissions are bypassed, anything else only
   * so an unexpected request does not stall the turn. */
  private async answer(message: Message) {
    const id = message.request_id;
    const request = (message.request ?? {}) as Message;
    const success = (response: unknown) => ({
      subtype: "success",
      request_id: id,
      response,
    });
    let response: Message;
    if (request.subtype === "mcp_message" && this.tools)
      response = success({
        mcp_response: await this.tools(
          this.conversation,
          request.message,
          AbortSignal.any([
            this.protectionLifetime.signal,
            this.workLifetime.signal,
          ]),
        ).catch((error) => ({
          jsonrpc: "2.0",
          id: (request.message as Message | undefined)?.id ?? 0,
          error: { code: -32603, message: String(error?.message ?? error) },
        })),
      });
    else if (
      request.subtype === "hook_callback" &&
      this.protection &&
      [
        "security-tool",
        "security-incoming",
        "security-incomplete",
        "security-session",
      ].includes(String(request.callback_id))
    ) {
      let releaseHistory = () => {};
      try {
        const input = request.input as Message;
        if (
          request.callback_id === "security-incomplete" ||
          (request.callback_id === "security-session" &&
            !["startup", "resume"].includes(String(input.source)))
        )
          throw new Error(
            "Protected Claude cannot rewrite its reviewed conversation; start a new conversation",
          );
        if (
          request.callback_id === "security-session" &&
          input.source === "startup" &&
          !this.resuming
        )
          return this.write({
            type: "control_response",
            response: success({}),
          });
        const tool = request.callback_id === "security-tool";
        const kind = tool
          ? "tool"
          : ["UserPromptSubmit", "SessionStart"].includes(
                String(input.hook_event_name),
              )
            ? "context"
            : "tool-result";
        if (tool && ["Agent", "Task"].includes(String(input.tool_name)))
          throw new Error(
            "Protected Claude does not delegate outside its reviewed conversation",
          );
        if (this.protection.gate.phases?.[kind] === false) {
          this.protectionLifetime.signal.throwIfAborted();
          this.protection.gate.assertAvailable();
          return this.write({
            type: "control_response",
            response: success(
              tool
                ? {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "allow",
                    },
                  }
                : {},
            ),
          });
        }
        if (typeof input.transcript_path !== "string")
          throw new Error("Claude omitted the protected conversation");
        const history = await this.protection
          .history(input.transcript_path, this.protectionLifetime.signal)
          .catch((error) => {
            if (
              input.hook_event_name === "UserPromptSubmit" &&
              !this.resuming &&
              !this.began &&
              /no such file/i.test(String(error))
            )
              return [];
            throw error;
          });
        releaseHistory = retainProtectionHistory(history);
        if (isTextSource(this.protectedHistory))
          (this.protectedHistory as { dispose?: () => void }).dispose?.();
        this.protectedHistory = isTextSource(history)
          ? history
          : structuredClone(history);
        const content = {
          ...(tool
            ? { title: input.tool_name, arguments: input.tool_input }
            : {}),
          instructions: this.protectedInstructions,
          conversation: history,
          events: structuredClone(this.protectedEvents),
          input,
        };
        // Tool authority needs the combined conversation. Injection detection
        // inspects native sources individually, without duplicating the envelope.
        const incoming = { ...input };
        for (const key of [
          "session_id",
          "transcript_path",
          "cwd",
          "permission_mode",
          "hook_event_name",
        ])
          delete incoming[key]; // Native transport metadata is not model content.
        const sources = tool
          ? [{ kind: "tool" as const, content }]
          : [
              {
                kind: "context" as const,
                content: {
                  source: "instructions",
                  value: this.protectedInstructions,
                },
              },
              ...(Array.isArray(history)
                ? history.flatMap((value) => protectionSources(value))
                : (["context", "tool-result"] as const).map((phase) => ({
                    kind: phase,
                    content: { source: "message", value: history.phase(phase) },
                  }))),
              ...this.protectedEvents.flatMap((value) =>
                protectionSources(value),
              ),
              ...protectionSources(
                incoming,
                "hook",
                kind === "tool-result" ? "tool-result" : "context",
              ),
            ];
        // One hook must answer within the native watchdog, so check sources
        // together, below the provider's limit of 16 in-flight checks. The
        // first denial cancels the rest before another can start.
        const session = this.sessionId ?? "initial";
        const denied = new AbortController();
        const signal = AbortSignal.any([
          this.protectionLifetime.signal,
          denied.signal,
        ]);
        const { gate } = this.protection;
        const slot = limited(4);
        await Promise.all(
          sources.map((source) =>
            slot(async () => {
              signal.throwIfAborted();
              try {
                await gate.check({ ...source, session }, signal);
              } catch (error) {
                denied.abort();
                throw error;
              }
            }),
          ),
        );
        this.protectionLifetime.signal.throwIfAborted();
        response = success(
          tool
            ? {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "allow",
                },
              }
            : {},
        );
      } catch (error) {
        this.protectionLifetime.abort();
        this.lastError =
          error instanceof Error ? error.message : "Security review failed";
        await this.process.kill();
        await this.exited;
        return;
      } finally {
        releaseHistory();
      }
    } else if (request.subtype === "can_use_tool")
      response = success({
        behavior: this.protection ? "deny" : "allow",
        updatedInput: request.input ?? {},
      });
    else if (request.subtype === "hook_callback") {
      const event =
        typeof request.callback_id === "string" &&
        request.callback_id.startsWith("buzz:")
          ? request.callback_id.slice(5)
          : undefined;
      try {
        response = success(
          event && CLAUDE_HOOK_EVENTS.includes(event as never)
            ? ((await this.hook?.(
                this.sessionId ?? "",
                event,
                request.input,
              )) ?? {})
            : request.callback_id === "final" && this.final(request.input)
              ? { continue: false }
              : {},
        );
      } catch (error) {
        response = { subtype: "error", request_id: id, error: String(error) };
      }
    } else
      response = {
        subtype: "error",
        request_id: id,
        error: `Buzz does not handle ${String(request.subtype)}`,
      };
    return this.write({ type: "control_response", response }).catch(
      () => undefined,
    );
  }
  /** A message marked final succeeded (a failed call runs no PostToolUse
   * hook), so the turn can end without a closing model call. Not when another
   * message came in meanwhile: that one still needs an answer. */
  private final(input: unknown) {
    const { tool_name, tool_input } = (input ?? {}) as Message;
    return (
      FINAL_NAME.test(String(tool_name)) &&
      (tool_input as Message | undefined)?.final === true &&
      this.pending === 1
    );
  }
}

/** The last content block of an assistant message as the tool it names and its target. */
export function stepLabel(
  message: Message,
): { tool: string; target?: string } | undefined {
  const content = (message.message as { content?: unknown } | undefined)
    ?.content;
  if (!Array.isArray(content)) return undefined;
  const block = content.at(-1) as {
    type?: unknown;
    name?: unknown;
    input?: Record<string, unknown>;
  } | null;
  if (block?.type === "tool_use" && typeof block.name === "string") {
    const tool = block.name.split("__").at(-1);
    if (!tool) return undefined;
    const input = block.input ?? {};
    const target = [
      "description",
      "file_path",
      "notebook_path",
      "pattern",
      "url",
      "query",
      "command",
    ]
      .map((key) => input[key])
      .find((value): value is string => typeof value === "string" && !!value);
    return target ? { tool, target: shortTarget(target) } : { tool };
  }
  if (block?.type === "thinking") return { tool: "Thinking" };
  if (block?.type === "text") return { tool: "Writing reply" };
  return undefined;
}

/** File paths show their name; everything else is passed through for trimming. */
function shortTarget(value: string) {
  return value.startsWith("/") ? (value.split("/").at(-1) ?? value) : value;
}
