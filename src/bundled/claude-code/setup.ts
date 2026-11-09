// Claude on this computer: Buzz's own copy, whether it can run (`auth.tsx`),
// and keeping that copy on the latest release. Each step runs as a declared
// process; the copy lives apart from any `claude` the user installed, and
// shares their `~/.claude` settings.
import type { AgentProviderSnapshot } from "../../features/agents/service";
import type { ReviewPrompt } from "../../features/agent-protection/models";
import type {
  HostProcess,
  HostRequest,
  HostResponse,
} from "../../features/host/service";
import { ClaudeAuth } from "./auth";
import { ClaudeProcess, ENV, type ClaudeModel, type Spawn } from "./claude";
import script from "./claude.sh?raw";
import {
  PROTECTED_CLAUDE_ROOT,
  PROTECTED_CLAUDE_VERSION,
  protectedRuntime,
} from "./security";

export type ClaudeStatus =
  | Readonly<{ state: "missing" }>
  /** Older than Buzz drives; Install updates it. */
  | Readonly<{ state: "outdated"; version: string }>
  | Readonly<{ state: "signed-out"; version: string }>
  | Readonly<{ state: "ready"; version: string; account?: string }>
  | Readonly<{ state: "error"; message: string }>;

const CHECK_TIMEOUT_MS = 15_000;
export type Request = (input: HostRequest) => Promise<HostResponse>;

/** Where Anthropic publishes each release with its checksums. */
const RELEASES = "https://downloads.claude.ai/claude-code-releases";
/** Model discovery disables customizations with --safe-mode (2.1.169+). */
export const MIN_VERSION = "2.1.169";
/** `uname -sm` to the release's platform name. */
const PLATFORMS: Readonly<Record<string, string>> = {
  "Darwin arm64": "darwin-arm64",
  "Darwin x86_64": "darwin-x64",
  "Linux aarch64": "linux-arm64",
  "Linux x86_64": "linux-x64",
};

/** The `claude.sh` step behind each process the plugin starts by name. */
const STEPS: Readonly<Record<string, string>> = {
  claude: "run",
  install: "install",
  use: "use",
  review: "review",
};
/** Starts `claude` and its other steps as steps of `claude.sh`, which the
 * manifest grants as `bash -c`; other processes start as declared. */
export const withScript =
  (spawn: Spawn): Spawn =>
  (id, options) => {
    const step = STEPS[id];
    return step
      ? spawn("claude-sh", {
          ...options,
          args: [script, "claude.sh", step, ...(options?.args ?? [])],
        })
      : spawn(id, options);
  };

/** Orders `a.b.c` versions; negative when `a` is older. */
export function compareVersions(a: string, b: string) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

async function queryModels(spawn: Spawn, signal: AbortSignal) {
  let child: HostProcess | undefined;
  let process: ClaudeProcess | undefined;
  const request = new AbortController();
  const abort = () => {
    request.abort();
    void child?.kill();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => {
    request.abort(new Error("Claude Code model discovery timed out"));
    void child?.kill();
  }, CHECK_TIMEOUT_MS);
  try {
    process = await ClaudeProcess.start(
      async (id, options) => {
        request.signal.throwIfAborted();
        child = await spawn(id, options);
        if (request.signal.aborted) await child.kill();
        request.signal.throwIfAborted();
        return child;
      },
      { cwd: "~", systemPrompt: "", discovery: true },
    );
    request.signal.throwIfAborted();
    const models = await process.models();
    request.signal.throwIfAborted();
    return models;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    if (process) await process.kill().catch(() => undefined);
    else await child?.kill().catch(() => undefined);
  }
}

/** Runs a short process and returns its exit code and output. */
async function collect(spawn: Spawn, id: string, args: readonly string[]) {
  let stdout = "";
  let stderr = "";
  const process = await spawn(id, {
    args,
    env: ENV,
    onStdout: (data) => {
      stdout += data;
    },
    onStderr: (data) => {
      stderr += data;
    },
  });
  const timer = setTimeout(() => void process.kill(), CHECK_TIMEOUT_MS);
  const code = await process.exited;
  clearTimeout(timer);
  return { code, stdout, stderr };
}

/** Waits for `work` until `signal` aborts; the work itself carries on. */
const abortable = <T>(work: Promise<T>, signal: AbortSignal) =>
  new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function checkClaude(
  spawn: Spawn,
  auth: ClaudeAuth,
): Promise<ClaudeStatus> {
  let version: string;
  try {
    const result = await collect(spawn, "claude", ["--version"]);
    // The launcher's answer when Buzz has no copy yet.
    if (result.code === 127) return { state: "missing" };
    if (result.code !== 0)
      return {
        state: "error",
        message: result.stderr.trim() || "Claude did not start",
      };
    version = result.stdout.trim().split(/\s/)[0] ?? "";
  } catch (error) {
    return { state: "error", message: message(error) };
  }
  if (compareVersions(version, MIN_VERSION) < 0)
    return { state: "outdated", version };
  try {
    const signedIn = await auth.check();
    if (!signedIn) return { state: "signed-out", version };
    return { state: "ready", version, ...signedIn };
  } catch {
    return { state: "signed-out", version };
  }
}

/** Runs `claude` as the given release rather than the one in use. */
const pinned =
  (spawn: Spawn, version: string): Spawn =>
  (id, options) =>
    spawn(id, {
      ...options,
      env: { ...options?.env, BUZZ_CLAUDE_VERSION: version },
    });

/** A downloaded release must start and answer the protocol Buzz drives it
 * with, listing its models without a turn, before any session uses it. */
async function testRelease(spawn: Spawn, version: string) {
  const release = pinned(spawn, version);
  const { code, stdout, stderr } = await collect(release, "claude", [
    "--version",
  ]);
  if (code !== 0 || !stdout.startsWith(version))
    throw new Error(stderr.trim() || "it did not report its version");
  const claude = await ClaudeProcess.start(release, {
    cwd: "~",
    systemPrompt: "",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const models = await Promise.race([
      claude.models(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("it did not list its models")),
          CHECK_TIMEOUT_MS,
        );
      }),
    ]);
    if (!models.length) throw new Error("it did not list its models");
  } finally {
    clearTimeout(timer);
    void claude.kill();
  }
}

export type SetupState = Readonly<{
  status: ClaudeStatus | undefined;
  models: readonly ClaudeModel[];
  modelsChecking: boolean;
  modelsError: string;
  checking: boolean;
  running: "install" | "sign-in" | undefined;
  /** The running or last step's output. */
  output: string;
  /** Why the latest release is not the one in use, after it failed its test. */
  notice: string | undefined;
}>;
const OUTPUT_LIMIT = 20_000;

/** The plugin's one view of Claude on this computer. */
export class ClaudeSetup {
  private state: SetupState = {
    status: undefined,
    models: [],
    modelsChecking: false,
    modelsError: "",
    checking: false,
    running: undefined,
    output: "",
    notice: undefined,
  };
  private readonly listeners = new Set<() => void>();
  private health: AgentProviderSnapshot = { readiness: "checking" };
  private process: HostProcess | undefined;
  private modelRequest: AbortController | undefined;
  private modelWork: Promise<void> | undefined;
  private cataloging: Promise<SetupState["models"]> | undefined;
  private modelsLoaded = false;
  /** Cancel was asked for before the running step's process was returned. */
  private cancelled = false;
  /** Releases that failed their test, not downloaded again until restart. */
  private readonly refused = new Set<string>();
  /** Looking for Buzz's copy or downloading one, which deliveries wait for
   * while Buzz has found no copy to run. */
  private holding: Promise<void> | undefined;

  /** Starts `claude` with the credentials when there are any. */
  private readonly spawn: Spawn | undefined;
  constructor(
    spawn: Spawn | undefined,
    private readonly request?: Request,
    readonly auth = new ClaudeAuth(spawn),
  ) {
    this.spawn = spawn && auth.authorize(spawn);
  }

  snapshot = () => this.state;
  providerSnapshot = () => this.health;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(change: Partial<SetupState>) {
    this.state = { ...this.state, ...change };
    const status = this.state.status;
    const blocking = this.state.running ? { blocking: true as const } : {};
    this.health = Object.freeze(
      !status
        ? { readiness: "checking", ...blocking }
        : status.state === "ready"
          ? { readiness: "ready", ...blocking }
          : {
              readiness: "attention",
              ...blocking,
              attentionLabel:
                status.state === "missing"
                  ? "Install Claude Code"
                  : status.state === "outdated"
                    ? "Update Claude Code"
                    : status.state === "signed-out"
                      ? this.auth.attentionLabel
                      : "Claude Code needs attention",
            },
    );
    for (const listener of this.listeners) listener();
  }
  private log(text: string) {
    this.set({ output: (this.state.output + text).slice(-OUTPUT_LIMIT) });
  }

  async check(refreshModels = false) {
    if (!this.spawn) {
      this.set({
        status: {
          state: "error",
          message: "Claude agents run only in the desktop app",
        },
      });
      return;
    }
    if (this.state.checking || this.state.running) return;
    const previous = this.state.status;
    this.set({ checking: true });
    const status = await checkClaude(this.spawn, this.auth);
    const invalidate =
      refreshModels || JSON.stringify(previous) !== JSON.stringify(status);
    if (invalidate) {
      this.modelRequest?.abort();
      this.modelRequest = undefined;
      this.modelsLoaded = false;
    }
    this.set({
      status,
      ...(invalidate
        ? { models: [], modelsChecking: false, modelsError: "" }
        : {}),
      checking: false,
    });
  }

  /** Loads optional model copy only for surfaces that display the catalog.
   * Callers during a load wait for it. */
  loadModels(retry = false) {
    if (this.modelRequest) return this.modelWork;
    if (
      !this.spawn ||
      this.state.status?.state !== "ready" ||
      this.state.checking ||
      (this.modelsLoaded && !retry)
    )
      return Promise.resolve();
    const request = new AbortController();
    this.modelRequest = request;
    this.set({ modelsChecking: true, modelsError: "" });
    this.modelWork = this.discoverModels(this.spawn, request);
    return this.modelWork;
  }
  private async discoverModels(spawn: Spawn, request: AbortController) {
    try {
      const models = await queryModels(spawn, request.signal);
      if (!models.length) throw new Error("Claude did not list its models");
      if (this.modelRequest === request) this.set({ models });
    } catch (error) {
      if (this.modelRequest === request && !request.signal.aborted)
        this.set({
          modelsError: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (this.modelRequest === request) {
        this.modelRequest = undefined;
        this.modelsLoaded = true;
        this.set({ modelsChecking: false });
      }
    }
  }
  /** The catalog for a surface that opens without the model picker: found
   * once, and looked for again only after a discovery that listed nothing. */
  catalog() {
    this.cataloging ??= (async () => {
      if (!this.state.status) await this.check();
      await this.loadModels(!this.state.models.length);
      return this.state.models;
    })().finally(() => {
      this.cataloging = undefined;
    });
    return this.cataloging;
  }

  /** Moves Buzz's copy to the latest release. Unless `needed`, a computer
   * without a copy is left without one: the download is large. */
  update(needed: boolean) {
    const spawn = this.spawn;
    if (!spawn || this.state.running) return Promise.resolve();
    // Held from the first check: until it answers, there may be no copy.
    return this.hold(
      (async () => {
        const status = await checkClaude(spawn, this.auth);
        this.set({ status });
        if (!needed && status.state === "missing") return;
        await this.run("install", false);
      })(),
    );
  }

  /** Holds a delivery while Buzz looks for its copy and downloads a first
   * one, so a mention sent meanwhile is answered rather than lost to a
   * missing copy. Once a copy is found, updating it holds nothing. */
  async installed(signal: AbortSignal) {
    const found = () => {
      const status = this.state.status;
      return status !== undefined && status.state !== "missing";
    };
    // After a first download failed, a mention tries it again.
    if (!this.holding && this.state.status?.state === "missing")
      void this.update(true);
    for (let work = this.holding; work && !found(); work = this.holding) {
      const ended = work;
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          off();
          signal.removeEventListener("abort", abort);
        };
        const abort = () => {
          done();
          reject(signal.reason);
        };
        const off = this.subscribe(() => {
          if (!found()) return;
          done();
          resolve();
        });
        signal.addEventListener("abort", abort, { once: true });
        void ended.then(() => {
          done();
          resolve();
        });
        if (signal.aborted) abort();
      });
    }
  }
  /** Makes `work` what deliveries wait on, until it ends. */
  private hold(work: Promise<void>) {
    const held = work.finally(() => {
      if (this.holding === held) this.holding = undefined;
    });
    this.holding = held;
    return held;
  }

  /** Installs or updates Buzz's copy, or runs the interactive sign-in when
   * there is one; then checks again. Asked for by the person, it also
   * retries a release that failed its test, and shows only this step's
   * output. */
  run(step: "install" | "sign-in", asked = true) {
    if (!this.spawn || this.state.running) return Promise.resolve();
    const work = this.perform(this.spawn, step, asked);
    return step === "install" ? this.hold(work) : work;
  }
  private async perform(
    spawn: Spawn,
    step: "install" | "sign-in",
    asked: boolean,
  ) {
    this.cancelled = false;
    if (asked) this.refused.clear();
    this.set({ running: step, ...(asked ? { output: "" } : {}) });
    try {
      if (step === "install") await this.install(spawn);
      else
        await this.auth.signIn?.((id, args, label) =>
          this.step(spawn, id, args, label),
        );
    } catch (error) {
      this.log(`\n${message(error)}`);
    } finally {
      this.process = undefined;
      this.set({ running: undefined });
    }
    await this.check(asked);
  }

  /** Runs one process with its output shown; throws unless it succeeds. */
  private async step(
    spawn: Spawn,
    id: string,
    args: readonly string[],
    label: string,
  ) {
    if (this.cancelled) throw new Error(`${label} ended (stopped).`);
    this.process = await spawn(id, {
      args,
      env: ENV,
      onStdout: (text) => this.log(text),
      onStderr: (text) => this.log(text),
    });
    if (this.cancelled) void this.process.kill();
    const code = await this.process.exited;
    this.process = undefined;
    if (code !== 0) throw new Error(`${label} ended (${code ?? "stopped"}).`);
  }

  private async fetch(path: string) {
    if (!this.request) throw new Error("Claude downloads need the desktop app");
    const response = await this.request({ url: `${RELEASES}/${path}` });
    if (response.status !== 200)
      throw new Error(`downloads.claude.ai answered ${response.status}`);
    return response.body;
  }

  /** Downloads the latest release, checks it against its published checksum,
   * tests it, and only then makes it the one new sessions start. */
  private async install(spawn: Spawn) {
    const status = await checkClaude(spawn, this.auth);
    const current = "version" in status ? status.version : undefined;
    const latest = (await this.fetch("latest")).trim();
    if (!/^\d+\.\d+\.\d+$/.test(latest))
      throw new Error("downloads.claude.ai did not name a release");
    if (latest === current || this.refused.has(latest) || this.cancelled)
      return;
    if (compareVersions(latest, MIN_VERSION) < 0)
      throw new Error(
        `Claude ${latest} is older than Buzz needs (${MIN_VERSION}).`,
      );
    const platform =
      PLATFORMS[(await collect(spawn, "platform", [])).stdout.trim()];
    if (!platform) throw new Error("Claude is not available for this computer");
    const manifest = JSON.parse(
      await this.fetch(`${latest}/manifest.json`),
    ) as {
      platforms?: Record<string, { checksum?: unknown } | undefined>;
    };
    const checksum = manifest.platforms?.[platform]?.checksum;
    if (typeof checksum !== "string" || !/^[0-9a-f]{64}$/.test(checksum))
      throw new Error(`Claude ${latest} lists no checksum for ${platform}`);
    this.log(`Downloading Claude ${latest}…\n`);
    await this.step(spawn, "install", [latest, platform, checksum], "Download");
    this.log(`Testing Claude ${latest}…\n`);
    try {
      await testRelease(spawn, latest);
    } catch (error) {
      this.refused.add(latest);
      const reason = `Claude ${latest} failed its test: ${message(error)}`;
      this.set({
        notice: current ? `${reason}. Buzz keeps using ${current}.` : reason,
      });
      throw new Error(reason);
    }
    await this.step(spawn, "use", [latest], "Switching");
    this.set({ notice: undefined });
    this.log(`Claude ${latest} is installed.\n`);
  }

  async review(
    model: { provider?: string; id: string },
    prompt: ReviewPrompt,
    signal: AbortSignal,
  ) {
    if (model.provider)
      throw new Error(
        "Claude uses its configured native provider; choose another runtime for an explicit provider ID",
      );
    if (!this.spawn) throw new Error("Claude review needs the desktop app");
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    // Its own folder in place of `~/.claude`, which contained agents can
    // write; and without credentials, closed before any download or model.
    const review = await abortable(this.auth.review(), timeout);
    // A verdict comes only from the release the host verified.
    await this.protectedInstalled(timeout);
    const worker = await ClaudeProcess.start(this.spawn, {
      cwd: "~",
      systemPrompt: prompt.system,
      discovery: true,
      pinned: true,
      review,
      ...(prompt.outputSchema ? { outputSchema: prompt.outputSchema } : {}),
      ...(model.id ? { model: model.id } : {}),
    });
    const cancel = () => void worker.kill();
    timeout.addEventListener("abort", cancel, { once: true });
    try {
      timeout.throwIfAborted();
      const result = await worker.send(prompt.input);
      timeout.throwIfAborted();
      if (!result.ok)
        throw new Error(
          result.error
            ? this.auth.explain(result.error)
            : "The security model did not complete",
        );
      return {
        text: prompt.outputSchema ? worker.structuredResult : worker.result,
        model: { id: worker.model ?? model.id },
      };
    } finally {
      timeout.removeEventListener("abort", cancel);
      await worker.kill();
      await worker.exited;
    }
  }

  private protectedDownload: Promise<void> | undefined;
  async protectedInstalled(signal: AbortSignal) {
    signal.throwIfAborted();
    const spawn = this.spawn;
    if (!spawn) throw new Error("Protected Claude needs the desktop app");
    const pinned = await protectedRuntime(spawn);
    // Contained, the host starts only its own copy, once that matches the
    // manifest's pin; it never runs the download folder's file. Its hook
    // guard stops a `--version` answer, so starting is the check.
    const verified = async () => {
      const process = await spawn(pinned, {
        args: ["--version"],
        protection: { readOnlyPaths: [PROTECTED_CLAUDE_ROOT], hiddenPaths: [] },
      });
      await process.kill();
    };
    try {
      await abortable(verified(), signal);
      return;
    } catch {
      signal.throwIfAborted();
    }
    this.protectedDownload ??= (async () => {
      const platform =
        PLATFORMS[(await collect(spawn, "platform", [])).stdout.trim()];
      if (!platform)
        throw new Error("Claude is not available for this computer");
      const manifest = JSON.parse(
        await this.fetch(`${PROTECTED_CLAUDE_VERSION}/manifest.json`),
      ) as { platforms?: Record<string, { checksum?: string }> };
      const checksum = manifest.platforms?.[platform]?.checksum;
      if (!checksum || !/^[a-f0-9]{64}$/.test(checksum))
        throw new Error("The protected Claude release has no valid checksum");
      const process = await spawn("install", {
        args: [PROTECTED_CLAUDE_VERSION, platform, checksum],
      });
      if ((await process.exited) !== 0)
        throw new Error("The protected Claude runtime could not be installed");
      await verified();
    })().finally(() => {
      this.protectedDownload = undefined;
    });
    await abortable(this.protectedDownload, signal);
  }

  /** Sends a line to the running step, such as a sign-in code. */
  answer(text: string) {
    return this.process?.write(`${text}\n`);
  }
  cancel() {
    this.cancelled = true;
    return this.process?.kill();
  }
  dispose() {
    this.modelRequest?.abort();
    this.modelRequest = undefined;
    void this.cancel();
  }
}
