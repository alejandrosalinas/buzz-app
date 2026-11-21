// One goose turn through the agent gateway: a generation of its own, opened at
// the route the turn was dispatched with, given to a dedicated `goose-acp`
// started on the generation's URL, never the shared one, and one session in
// it. Nothing is retried: a turn that can't open, start or load fails. Every
// exit retires it in order (seal, interrupt, close, stop), and the generation
// is closed only once its process has exited, so nothing of the turn runs on
// after it, and no other turn's runs on its generation.
import {
  type Generation,
  UNREACHED,
} from "../../features/agents/gateway/forwarding";
import { STOP_TIMEOUT_MS } from "../../features/agent-harness/acp/process";
import type { AcpSession } from "../../features/agent-harness/acp/session";
import { forwardChildren } from "./forward-children";
import type {
  ActivityReceipt,
  Choice,
  GooseProcess,
  Settled,
  ToolServer,
} from "./goose";
import { abortable } from "./sessions";

export const NOT_KEPT =
  "goose couldn't save this conversation's session, so the turn didn't run.";
export const NOT_STOPPED =
  "goose didn't stop after the turn; this conversation waits until it has.";
export const NOT_CLOSED =
  "Buzz couldn't confirm the agent gateway closed this turn's forwarding.";

export type GatewayProvider = "databricks" | "databricks_v2";

export type ForwardedTurn = Readonly<{
  /** Opens the turn's generation; it throws, spawning nothing, when it
   * can't. */
  open(signal: AbortSignal): Promise<Generation>;
  /** Starts the turn's own goose with `env`, handing it to `onProcess` as
   * soon as it runs, so one whose start fails is retired too. */
  start(
    env: Readonly<Record<string, string>>,
    onProcess: (goose: GooseProcess) => void,
  ): Promise<GooseProcess>;
  launch(): Promise<Readonly<{ cwd: string; systemPrompt: string }>>;
  tools: ToolServer;
  /** The resolved provider, even when ACP inherits the configured choice. */
  provider: GatewayProvider;
  choice: () => Choice;
  /** The conversation (or one-off label) its Buzz tools act for. */
  conversation: string;
  title?: string;
  /** Keys goose indexes a new session by, so its conversation finds it. */
  tags?: Readonly<Record<string, string>>;
  /** The saved session to resume; it never falls back to a new one. */
  load?: string;
  /** The turn's text once its session is open, `fresh` for a new session
   * shown nothing yet; undefined sends nothing. */
  prompt(fresh: boolean): Promise<string | undefined>;
  /** Saves the session before its first prompt: whether it was. */
  keep?(session: string): boolean;
  /** Told of a new session once it is kept, before its first prompt. */
  started?(session: string): void;
  /** Told the turn's retirement before it ends: `retired` settles once the
   * process has exited and native has closed the generation, `exited` once
   * the process has, and never rejects. */
  outlives(retired: Promise<void>, exited: Promise<void>): void;
  /** Ends the turn: interrupt or dispose. */
  signal: AbortSignal;
  activity?: ActivityReceipt;
  model?: string;
  effort?: string;
  kept?: string;
}>;

/** Runs `turn`, and settles once it has retired, or as far as it could:
 * a route change wins (`changed`), then a cancel, then the turn's own
 * error, then a retirement that could not be confirmed. */
export async function forwardedTurn(
  turn: ForwardedTurn,
  changed: string,
): Promise<Settled> {
  const { signal } = turn;
  let generation: Generation;
  try {
    generation = await turn.open(signal);
  } catch (error) {
    if (signal.aborted) return { ok: true, undelivered: true };
    return { ok: false, error: message(error) };
  }
  // Interrupted, or the route moved on, which revokes it natively.
  const halt = new AbortController();
  const stop = () => halt.abort(new Error(changed));
  if (signal.aborted) stop();
  signal.addEventListener("abort", stop, { once: true });
  void generation.revoked.then(stop);
  let process: GooseProcess | undefined;
  let exit: Promise<void> = Promise.resolve();
  let exited = true;
  let session: AcpSession | undefined;
  let sent = false;
  let starting: Promise<GooseProcess> | undefined;
  const kill = () => void process?.kill();
  let outcome: Settled;
  try {
    halt.signal.throwIfAborted();
    starting = turn.start(forwardedEnv(generation, turn), (goose) => {
      process = goose;
      exited = false;
      exit = goose.exited.then(() => {
        exited = true;
      });
      // Ended while it starts, or before: it is stopped at once. Once
      // started, it is retired in order instead.
      if (halt.signal.aborted) void goose.kill();
      else halt.signal.addEventListener("abort", kill, { once: true });
    });
    // Never abandoned: retirement waits for whatever it started.
    void starting.catch(() => undefined);
    const goose = await abortable(starting, halt.signal).finally(() =>
      halt.signal.removeEventListener("abort", kill),
    );
    const { cwd, systemPrompt } = await abortable(turn.launch(), halt.signal);
    session = await abortable(
      goose.open({
        cwd,
        systemPrompt,
        tools: turn.tools,
        choice: turn.choice,
        ...(turn.load === undefined
          ? {
              ...(turn.title ? { title: turn.title } : {}),
              ...(turn.tags ? { tags: turn.tags } : {}),
            }
          : { load: turn.load }),
        onSession: (opened) => {
          session = opened;
        },
      }),
      halt.signal,
    );
    session.conversation = turn.conversation;
    outcome = await (async (open: AcpSession): Promise<Settled> => {
      if (turn.keep && !turn.keep(open.id))
        return { ok: false, error: NOT_KEPT };
      if (turn.load === undefined) turn.started?.(open.id);
      await abortable(generation.associate(open.id), halt.signal);
      const children = forwardChildren({
        register: (call, child) => generation.registerChild(call, child),
        failed: (reason) =>
          console.warn("goose could not register a delegated session", reason),
      });
      open.observe = children.observe;
      const text = await abortable(
        turn.prompt(turn.load === undefined),
        halt.signal,
      );
      if (text === undefined) return { ok: true, undelivered: true };
      sent = true;
      const result = await abortable(
        open.send(text, turn.activity, turn.model, turn.effort, turn.kept),
        halt.signal,
      );
      const failure = await abortable(children.settled(), halt.signal);
      if (!result.ok) return result;
      return failure === undefined ? result : { ok: false, error: failure };
    })(session);
  } catch (error) {
    outcome = { ok: false, error: message(error) };
  }
  // Retired in order, each step whatever the one before did.
  signal.removeEventListener("abort", stop);
  generation.seal();
  // A start still running is waited out: what it starts is retired too.
  await starting?.then(noop, noop);
  const live = session;
  if (live?.working) live.interrupt();
  if (process && live)
    await process
      .close(live, true)
      .catch((error) =>
        console.warn("goose did not close a forwarded session", error),
      );
  if (process) await process.stop(STOP_TIMEOUT_MS);
  const retired = exit.then(() => generation.close());
  turn.outlives(retired, exit);
  let retirement: string | undefined;
  if (!exited) retirement = NOT_STOPPED;
  else
    await retired.catch((error) => {
      console.warn("The agent gateway did not close a generation", error);
      retirement = NOT_CLOSED;
    });
  if (generation.isRevoked()) return { ok: false, error: changed };
  if (signal.aborted)
    return sent ? { ok: true, stopped: true } : { ok: true, undelivered: true };
  // Sent, yet no model request reached the gateway: said before goose's own
  // error, which may not name the routing.
  if (!outcome.ok && sent && !generation.admitted())
    return {
      ...outcome,
      error: outcome.error ? `${UNREACHED} ${outcome.error}` : UNREACHED,
    };
  if (!outcome.ok || !retirement) return outcome;
  return { ok: false, error: retirement };
}

const noop = () => {};

/** The bearer every forwarded goose sends: a fixed value, not a secret.
 * goose's Databricks provider needs one to send anything; without one it
 * tries OAuth discovery, which never reaches the gateway. Set in the
 * process's own environment, it is the one goose reads first (goose 1.59.2
 * `Config::get_secret`), ahead of a token the app's environment passes on
 * or the owner's goose keeps in its keyring or `secrets.yaml`. So no
 * Databricks token of theirs reaches the gateway. Delegates run in the same
 * process on the same provider, so they send it too. */
export const GATEWAY_TOKEN = "buzz-agent-gateway-placeholder";

/** A forwarded goose's environment on `generation`. */
export function forwardedEnv(
  generation: Pick<Generation, "url" | "noProxy">,
  turn: Pick<ForwardedTurn, "model" | "provider" | "choice">,
): Record<string, string> {
  const choice = turn.choice();
  const model = turn.model || choice.model;
  return {
    DATABRICKS_HOST: generation.url,
    DATABRICKS_TOKEN: GATEWAY_TOKEN,
    // Keep an inherited provider's configured model and freeze its provider
    // to the one used for routing. An explicit ACP choice selects its own.
    ...(!choice.provider && { GOOSE_PROVIDER: turn.provider }),
    // goose 1.57.0 sends even loopback requests to an inherited proxy
    // unless these name it; both, as either may be read.
    NO_PROXY: generation.noProxy,
    no_proxy: generation.noProxy,
    // Its one prompt is the turn's: no model call names the session.
    GOOSE_DISABLE_SESSION_NAMING: "true",
    // A delegate runs on these, not a provider the model or config names
    // (goose 1.57.0 `resolve_provider_config`); a recipe's own still wins.
    GOOSE_SUBAGENT_PROVIDER: turn.provider,
    ...(model ? { GOOSE_SUBAGENT_MODEL: model } : {}),
  };
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
