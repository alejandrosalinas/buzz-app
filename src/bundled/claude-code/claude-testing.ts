// A stand-in for the `claude` binary's stream-json protocol, and the
// manifest's other processes run for real, for tests.
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import type {
  HostProcess,
  HostProcessOptions,
} from "../../features/host/service";
import manifest from "./manifest.json";

export type FakeClaude = {
  id: string;
  options: HostProcessOptions;
  /** Every JSON message written to its stdin. */
  received: Record<string, unknown>[];
  /** User messages it has taken, in order. */
  prompts: string[];
  /** The session's effort, which `apply_flag_settings` changes. */
  effort: string;
  /** The effort each user message was taken at. */
  efforts: string[];
  /** The session's model, which `set_model` changes. */
  model: string;
  /** The model each user message was taken on. */
  models: string[];
  /** When set, a turn stays open until `finish()`. */
  hold: boolean;
  killed: boolean;
  /** When set, an `interrupt` request is answered with this error. */
  interruptError?: string;
  /** When false, a kill is only a request; the test calls `exit()`. */
  exitOnKill: boolean;
  /** The agents its Buzz credential was asked to act as, in order. */
  actedAs: Readonly<{ pubkey: string; relay: string }>[];
  emit(message: Record<string, unknown>): void;
  finish(result?: Readonly<{ error?: string }>): void;
  exit(code: number | null, stderr?: string): void;
};

/** The models the fake lists, as Claude's `initialize` answer does. */
export const MODELS = [
  { value: "default", resolvedModel: "claude-opus-5-5" },
  {
    value: "opus",
    resolvedModel: "claude-opus-5-5",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-5-5",
    supportsEffort: true,
    supportedEffortLevels: ["low", "high"],
  },
  { value: "legacy", resolvedModel: "claude-legacy-1", supportsEffort: false },
];
const resolved = (model: string) =>
  MODELS.find((item) => item.value === model)?.resolvedModel ?? model;

/** The processes that run Claude: Buzz's copy, and the pinned protected
 * release on the Mac `platform` reports. */
export const CLAUDES: ReadonlySet<string> = new Set([
  "claude",
  "claude-protected-arm64",
]);

/** A spawn whose Claude processes answer like Claude, on an Apple silicon
 * Mac. Sessions named in `known` (or created by a process) can be resumed;
 * others fail to load. */
export function fakeSpawn(known = new Set<string>()) {
  const processes: FakeClaude[] = [];
  const spawn = async (id: string, options: HostProcessOptions = {}) => {
    if (id === "platform") {
      options.onStdout?.("Darwin arm64\n");
      return {
        write: async () => {},
        end: async () => {},
        kill: async () => {},
        exited: Promise.resolve(0),
      };
    }
    let resolveExit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    const args = options.args ?? [];
    const flag = (name: string) => {
      const index = args.indexOf(name);
      return index >= 0 ? args[index + 1] : undefined;
    };
    const resume = flag("--resume");
    const session = resume ?? flag("--session-id") ?? "fresh";
    let open = 0;
    let started = false;
    let alive = true;
    const fake: FakeClaude = {
      id,
      options,
      received: [],
      prompts: [],
      effort: "high",
      efforts: [],
      model: flag("--model") ?? "default",
      models: [],
      hold: false,
      killed: false,
      exitOnKill: true,
      actedAs: [],
      emit(message) {
        if (alive) options.onStdout?.(`${JSON.stringify(message)}\n`);
      },
      finish(result = {}) {
        if (!open) return;
        open = 0;
        fake.emit({
          type: "result",
          subtype: result.error ? "error_during_execution" : "success",
          is_error: !!result.error,
          ...(result.error ? { result: result.error } : {}),
          session_id: session,
        });
        // Claude reports idle only when asked to.
        if (options.env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS === "1")
          fake.emit({
            type: "system",
            subtype: "session_state_changed",
            state: "idle",
            session_id: session,
          });
      },
      exit(code, stderr) {
        if (!alive) return;
        if (stderr) options.onStderr?.(stderr);
        alive = false;
        resolveExit(code);
      },
    };
    processes.push(fake);
    const take = (message: Record<string, unknown>) => {
      fake.received.push(message);
      if (message.type === "control_request") {
        const request = message.request as Record<string, unknown>;
        const level = (request.settings as Record<string, unknown> | undefined)
          ?.effortLevel;
        if (
          request.subtype === "apply_flag_settings" &&
          typeof level === "string"
        )
          fake.effort = level;
        if (request.subtype === "set_model")
          fake.model = flag("--model") ?? "default";
        if (
          request.subtype === "set_model" &&
          typeof request.model === "string"
        )
          fake.model = request.model;
        if (request.subtype === "interrupt" && fake.interruptError) {
          fake.emit({
            type: "control_response",
            response: {
              subtype: "error",
              request_id: message.request_id,
              error: fake.interruptError,
            },
          });
          return;
        }
        fake.emit({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id,
            ...(request.subtype === "get_settings"
              ? {
                  response: {
                    applied: {
                      effort: fake.effort,
                      model: resolved(fake.model),
                    },
                  },
                }
              : {}),
            ...(request.subtype === "initialize"
              ? { response: { models: MODELS } }
              : {}),
          },
        });
        return;
      }
      if (message.type !== "user") return;
      if (resume && !known.has(resume)) {
        fake.exit(1, `No conversation found with session ID: ${resume}\n`);
        return;
      }
      const content = (message.message as { content: string }).content;
      fake.prompts.push(content);
      fake.efforts.push(fake.effort);
      fake.models.push(fake.model);
      if (!started) {
        started = true;
        known.add(session);
        fake.emit({
          type: "system",
          subtype: "init",
          session_id: session,
          model: resolved(fake.model),
        });
      }
      open++;
      if (args.includes("--replay-user-messages"))
        fake.emit({ ...message, isReplay: true, session_id: session });
      fake.emit({
        type: "assistant",
        session_id: session,
        message: { content: [{ type: "text", text: `ok: ${content}` }] },
      });
      if (!fake.hold) fake.finish();
    };
    const process: HostProcess = {
      write: async (data) => {
        if (!alive) throw new Error("Process has exited");
        for (const line of data.split("\n").filter(Boolean))
          take(JSON.parse(line));
      },
      end: async () => undefined,
      kill: async () => {
        fake.killed = true;
        if (fake.exitOnKill) fake.exit(null);
      },
      ...(options.agentCredential && {
        actAs: async (agent: Readonly<{ pubkey: string; relay: string }>) => {
          fake.actedAs.push(agent);
        },
      }),
      exited,
    };
    // Output that arrives before spawn returns is buffered by the caller.
    // Claude answers `--version` and exits, as other processes do.
    if (!CLAUDES.has(id) || args[0] === "--version")
      queueMicrotask(() => fake.exit(0));
    return process;
  };
  return { spawn, processes, known };
}

/** Lets queued promise callbacks run. */
/** Claude's full list of live background tasks, as it sends one on each change. */
export const backgroundTasks = (
  fake: FakeClaude | undefined,
  ...tasks: Readonly<{ ambient?: boolean }>[]
) =>
  fake?.emit({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: tasks.map((task, index) => ({
      task_id: `task-${index}`,
      task_type: "local_bash",
      description: "sleep",
      ...task,
    })),
  });
/** Claude reporting whether it is in a turn, its own ones included. */
export const sessionState = (fake: FakeClaude | undefined, state: string) =>
  fake?.emit({ type: "system", subtype: "session_state_changed", state });

export const flush = async (times = 5) => {
  for (let index = 0; index < times; index++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Runs the manifest's processes for real, `~` being `home`; the workspace
 * resolves to /Users/me/.buzz. */
export function manifestProcesses(home: string) {
  return async (id: string, options: HostProcessOptions = {}) => {
    const declared = manifest.host.processes.find(
      (process) => process.id === id,
    );
    if (!declared) throw new Error(`undeclared process ${id}`);
    if (id === "workspace") options.onStdout?.("/Users/me/.buzz\n");
    // As the app's host does, a missing directory is created.
    const cwd = options.cwd?.replace(/^~/, home);
    if (cwd && id !== "workspace") mkdirSync(cwd, { recursive: true });
    const exited =
      id === "workspace"
        ? Promise.resolve(0)
        : new Promise<number>((resolve) => {
            const child = execFile(
              declared.program,
              [...(declared.args ?? []), ...(options.args ?? [])],
              { cwd, maxBuffer: 1 << 26 },
              (error) => resolve(error ? Number(error.code) || 1 : 0),
            );
            child.stdout?.on("data", (data) =>
              options.onStdout?.(String(data)),
            );
            child.stderr?.on("data", (data) =>
              options.onStderr?.(String(data)),
            );
          });
    return {
      write: async () => undefined,
      end: async () => undefined,
      kill: async () => undefined,
      exited,
    };
  };
}
