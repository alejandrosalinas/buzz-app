// Codex on this computer: Buzz's own copy, whether it is signed in, and
// keeping that copy on the latest release. Each step runs as a declared
// process; the copy lives apart from any `codex` the user installed, and
// shares their `~/.codex` sign-in and settings.
import { withProviderWords } from "../../features/agents/failure-words";
import type {
  HostProcess,
  HostRequest,
  HostResponse,
} from "../../features/host/service";
import script from "./codex.sh?raw";
import { AppServer, listModels, needsSignIn, type Spawn } from "./rpc";

export type CodexStatus =
  | Readonly<{ state: "missing" }>
  | Readonly<{ state: "signed-out"; version: string }>
  | Readonly<{ state: "ready"; version: string }>
  | Readonly<{ state: "error"; message: string }>;

const CHECK_TIMEOUT_MS = 15_000;
export type Request = (input: HostRequest) => Promise<HostResponse>;

/** Where OpenAI publishes each release with its checksums. */
const RELEASES = "https://releases.openai.com/codex";
/** `uname -sm` to the release's target name. Linux builds are static (musl). */
const TARGETS: Readonly<Record<string, string>> = {
  "Darwin arm64": "aarch64-apple-darwin",
  "Darwin x86_64": "x86_64-apple-darwin",
  "Linux aarch64": "aarch64-unknown-linux-musl",
  "Linux x86_64": "x86_64-unknown-linux-musl",
};

/** The `codex.sh` step, and its first arguments, behind each process the
 * plugin starts by name. */
const STEPS: Readonly<Record<string, readonly string[]>> = {
  codex: ["run"],
  "app-server": ["run", "app-server"],
  install: ["install"],
  use: ["use"],
  adopt: ["adopt"],
  home: ["home"],
  "read-from": ["read-from"],
  login: ["login"],
  review: ["review"],
};
/** Starts `codex`, `app-server`, `install`, `use`, `adopt`, `home`,
 * `read-from`, `login` and `review` as steps of `codex.sh`, which the manifest grants as `bash -c`; other
 * processes start as declared. */
export const withScript =
  (spawn: Spawn): Spawn =>
  (id, options) => {
    const step = STEPS[id];
    return step
      ? spawn("codex-sh", {
          ...options,
          args: [script, "codex.sh", ...step, ...(options?.args ?? [])],
        })
      : spawn(id, options);
  };

/** Runs a short process and returns its exit code and output. */
async function collect(spawn: Spawn, id: string, args: readonly string[]) {
  let stdout = "";
  let stderr = "";
  const process = await spawn(id, {
    args,
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

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The `count` lines a `codex.sh` step prints, which must succeed. */
async function printed(spawn: Spawn, id: string, count: number) {
  const { code, stdout, stderr } = await collect(spawn, id, []);
  const lines = stdout.trim().split("\n");
  if (code !== 0 || lines.length < count || lines.some((line) => !line))
    throw new Error(stderr.trim() || `Buzz's Codex ${id} is unavailable`);
  return lines;
}

const homes = new WeakMap<Spawn, Promise<string>>();
/** Buzz's Codex home, where protected agents run as `codex.sh run` does. Only
 * a success is kept: a failure is looked up again. */
export function buzzHome(spawn: Spawn) {
  const known = homes.get(spawn);
  if (known) return known;
  const found = printed(spawn, "home", 1).then(([home = ""]) => home);
  homes.set(spawn, found);
  found.catch(() => {
    if (homes.get(spawn) === found) homes.delete(spawn);
  });
  return found;
}

/** Makes Buzz's review home again, which holds only the sign-in and links to
 * the state folder, and returns both with the ChatGPT workspace a Buzz sign-in
 * recorded, while the sign-in still names it. Each review starts with it. */
export async function reviewHome(spawn: Spawn) {
  const [home = "", state = "", workspace] = await printed(spawn, "review", 2);
  return { home, state, workspace };
}

export async function checkCodex(spawn: Spawn): Promise<CodexStatus> {
  let version: string;
  try {
    const result = await collect(spawn, "codex", ["--version"]);
    // The launcher's answer when Buzz has no copy yet.
    if (result.code === 127) return { state: "missing" };
    if (result.code !== 0)
      return {
        state: "error",
        message: result.stderr.trim() || "Codex did not start",
      };
    // `codex-cli 0.162.1`
    version = result.stdout.trim().split(/\s/)[1] ?? "";
  } catch (error) {
    return { state: "error", message: message(error) };
  }
  try {
    const { code } = await collect(spawn, "codex", ["login", "status"]);
    if (code === 0) return { state: "ready", version };
    // `login status` ignores the model provider, which may need no OpenAI sign-in.
    const rpc = new AppServer();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const signedOut = await Promise.race([
        rpc.open(spawn).then(() => needsSignIn(rpc)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Codex did not answer")),
            CHECK_TIMEOUT_MS,
          );
        }),
      ]);
      return { state: signedOut ? "signed-out" : "ready", version };
    } finally {
      clearTimeout(timer);
      await rpc.close();
    }
  } catch {
    return { state: "signed-out", version };
  }
}

/** A failed turn's notice as the conversation reads it, in Markdown: a
 * missing or refused sign-in links to `settings`, where Codex signs in once
 * for every Codex agent. Signed out, Codex reaches OpenAI with no credentials
 * and is told "Missing bearer or basic authentication"; a refused API key ends
 * in "Incorrect API key provided", and a ChatGPT sign-in that stopped working
 * in one of Codex's "… could not be refreshed …. Please [log out and] sign in
 * again" messages, read as one sentence and the next so that two errors can't
 * join into one. An MCP server's OAuth refresh failing is not Codex's sign-in,
 * and says otherwise. The explanation comes first, then Codex's own words,
 * without the notice's "Codex could not finish: " and the period it adds. */
export function explainTurn(notice: string, settings: string) {
  const explanation = /Missing bearer or basic authentication/i.test(notice)
    ? `Codex isn't signed in. Head to [Settings](${settings}) to sign in.`
    : /Incorrect API key provided|could not be refreshed\b[^.\n]*\. Please (?:log out and )?sign in again/i.test(
          notice,
        )
      ? `OpenAI rejected Codex's sign-in. It may have expired or been revoked. Head to [Settings](${settings}) to sign in again.`
      : undefined;
  if (!explanation) return notice;
  const said =
    /^Codex could not (?:start|finish): ([\s\S]*)\.$/.exec(notice)?.[1] ??
    notice;
  return withProviderWords(explanation, "Codex", said);
}

/** Runs `codex` as the given release rather than the one in use. */
const pinned =
  (spawn: Spawn, version: string): Spawn =>
  (id, options) =>
    spawn(id, {
      ...options,
      env: { ...options?.env, BUZZ_CODEX_VERSION: version },
    });

/** A downloaded release must start and answer the protocol Buzz drives it
 * with, listing its models without a turn, before any session uses it. */
async function testRelease(spawn: Spawn, version: string) {
  const release = pinned(spawn, version);
  const { code, stdout, stderr } = await collect(release, "codex", [
    "--version",
  ]);
  if (code !== 0 || stdout.trim() !== `codex-cli ${version}`)
    throw new Error(stderr.trim() || "it did not report its version");
  const rpc = new AppServer();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const models = await Promise.race([
      rpc.open(release).then(() => listModels(rpc)),
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
    await rpc.close();
  }
}

export type SetupState = Readonly<{
  status: CodexStatus | undefined;
  checking: boolean;
  running: "install" | "login" | undefined;
  /** The running or last step's output. */
  output: string;
  /** Why the latest release is not the one in use, after it failed its test. */
  notice: string | undefined;
}>;
const OUTPUT_LIMIT = 20_000;

/** The plugin's one view of Codex on this computer. */
export class CodexSetup {
  private state: SetupState = {
    status: undefined,
    checking: false,
    running: undefined,
    output: "",
    notice: undefined,
  };
  private readonly listeners = new Set<() => void>();
  private process: HostProcess | undefined;
  /** Cancel was asked for before the running step's process was returned. */
  private cancelled = false;
  /** Releases that failed their test, not downloaded again until restart. */
  private readonly refused = new Set<string>();
  /** Looking for Buzz's copy or downloading one, which deliveries wait for
   * while Buzz has found no copy to run. */
  private holding: Promise<void> | undefined;
  private checked: Promise<CodexStatus> | undefined;

  constructor(
    private readonly spawn: Spawn | undefined,
    private readonly request?: Request,
  ) {}

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(change: Partial<SetupState>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
  private log(text: string) {
    this.set({ output: (this.state.output + text).slice(-OUTPUT_LIMIT) });
  }

  /** Looks again, or joins the look in progress, and returns what it found. */
  check(): Promise<CodexStatus> {
    const spawn = this.spawn;
    if (!spawn) {
      const status = {
        state: "error",
        message: "Codex agents run only in the desktop app",
      } as const;
      this.set({ status });
      return Promise.resolve(status);
    }
    this.checked ??= (async () => {
      this.set({ checking: true });
      const status = await checkCodex(spawn);
      this.checked = undefined;
      this.set({ status, checking: false });
      return status;
    })();
    return this.checked;
  }

  /** Moves Buzz's copy to the latest release. Unless `needed`, a computer
   * without a copy is left without one: the download is large. */
  update(needed: boolean) {
    const spawn = this.spawn;
    if (!spawn || this.state.running) return Promise.resolve();
    // Held from the first check: until it answers, there may be no copy.
    return this.hold(
      (async () => {
        const status = await checkCodex(spawn);
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

  /** Installs or updates Buzz's copy, or runs sign-in; then checks again.
   * Asked for by the person, it also retries a release that failed its test,
   * and shows only this step's output. */
  run(step: "install" | "login", asked = true) {
    if (!this.spawn || this.state.running) return Promise.resolve();
    const work = this.perform(this.spawn, step, asked);
    return step === "install" ? this.hold(work) : work;
  }
  private async perform(
    spawn: Spawn,
    step: "install" | "login",
    asked: boolean,
  ) {
    this.cancelled = false;
    if (asked) this.refused.clear();
    this.set({ running: step, ...(asked ? { output: "" } : {}) });
    try {
      if (step === "install") await this.install(spawn);
      else await this.step(spawn, "login", [], "Sign-in");
    } catch (error) {
      this.log(`\n${message(error)}`);
    } finally {
      this.process = undefined;
      this.set({ running: undefined });
    }
    await this.check();
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
      onStdout: (text) => this.log(text),
      onStderr: (text) => this.log(text),
    });
    if (this.cancelled) void this.process.kill();
    const code = await this.process.exited;
    this.process = undefined;
    if (code !== 0) throw new Error(`${label} ended (${code ?? "stopped"}).`);
  }

  /** Downloads the latest release, checks it against its published checksum,
   * tests it, and only then makes it the one new sessions start. */
  private async install(spawn: Spawn) {
    if (!this.request) throw new Error("Codex downloads need the desktop app");
    const status = await checkCodex(spawn);
    const current = "version" in status ? status.version : undefined;
    const response = await this.request({ url: `${RELEASES}/channels/latest` });
    if (response.status !== 200)
      throw new Error(`releases.openai.com answered ${response.status}`);
    const release = JSON.parse(response.body) as {
      tag_name?: unknown;
      assets?: { name?: unknown; digest?: unknown }[];
    };
    const latest =
      typeof release.tag_name === "string"
        ? release.tag_name.replace(/^rust-v/, "")
        : "";
    if (!/^\d+\.\d+\.\d+$/.test(latest))
      throw new Error("releases.openai.com did not name a release");
    if (latest === current || this.refused.has(latest) || this.cancelled)
      return;
    const target =
      TARGETS[(await collect(spawn, "platform", [])).stdout.trim()];
    if (!target) throw new Error("Codex is not available for this computer");
    const asset = `codex-package-${target}.tar.gz`;
    const digest = release.assets?.find((item) => item.name === asset)?.digest;
    const checksum =
      typeof digest === "string" ? digest.replace(/^sha256:/, "") : "";
    if (!/^[0-9a-f]{64}$/.test(checksum))
      throw new Error(`Codex ${latest} lists no checksum for ${target}`);
    this.log(`Downloading Codex ${latest}…\n`);
    await this.step(spawn, "install", [latest, target, checksum], "Download");
    this.log(`Testing Codex ${latest}…\n`);
    try {
      await testRelease(spawn, latest);
    } catch (error) {
      this.refused.add(latest);
      const reason = `Codex ${latest} failed its test: ${message(error)}`;
      this.set({
        notice: current ? `${reason}. Buzz keeps using ${current}.` : reason,
      });
      throw new Error(reason);
    }
    await this.step(spawn, "use", [latest], "Switching");
    this.set({ notice: undefined });
    this.log(`Codex ${latest} is installed.\n`);
  }

  cancel() {
    this.cancelled = true;
    return this.process?.kill();
  }
  dispose() {
    void this.cancel();
  }
}
