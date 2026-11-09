// Typed decisions for app code and plugins. A caller asks yes/no, choice or
// score questions about a piece of text; the provider this device chose in
// Settings answers them in one call. Providers are plugins: each registers
// with `ctx.decisions.registerProvider`. The host owns the choice, the
// request limits, the deadline and the answer checks, so every provider is
// held to the same rules and returns the same checked answers.
import { Service, type Context } from "@deepseek-ai/cordis";
import type { ComponentType } from "react";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";

export type DecisionQuestion =
  /** Answered with the probability that the statement holds. */
  | Readonly<{ type: "yes_no"; instructions: string }>
  /** One of 2 to 255 options: value -> when to pick it. */
  | Readonly<{
      type: "choice";
      instructions: string;
      options: Readonly<Record<string, string>>;
    }>
  /** A place on a scale of 2 to 10 level labels, lowest first. */
  | Readonly<{
      type: "score";
      instructions: string;
      levels: readonly string[];
    }>;

export type DecisionRequest = Readonly<{
  /** The text to judge. The provider sees it, so send only what it needs. */
  state: string;
  /** 1 to 32 questions keyed by answer name (at most 64 characters). */
  questions: Readonly<Record<string, DecisionQuestion>>;
  /** How long to wait, 1 to 30 seconds. Defaults to 30. */
  timeoutMs?: number;
  /** The Buzz community (its relay URL) the text comes from. A provider
   * that bills the community, such as Builderlab, refuses a request
   * without one. */
  community?: string;
}>;

export type DecisionAnswer =
  | Readonly<{ type: "yes_no"; probability: number }>
  | Readonly<{
      type: "choice";
      choice: string;
      confidence: number;
      /** Option value -> probability, where the provider reports them. */
      probabilities: Readonly<Record<string, number>>;
    }>
  | Readonly<{
      type: "score";
      /** Where the answer falls on the 0-based scale; it can be fractional. */
      score: number;
      confidence: number;
      /** Level index ("0", "1", …) -> probability. */
      probabilities: Readonly<Record<string, number>>;
    }>;

/**
 * - `unavailable`: no decision provider is registered.
 * - `missing_credentials`: the provider has no saved key or sign-in.
 * - `unauthorized`: the provider refused the key or sign-in.
 * - `invalid_request`: the questions are malformed or were rejected.
 */
export type DecisionFailure =
  | "unavailable"
  | "missing_credentials"
  | "unauthorized"
  | "invalid_request"
  | "input_limit"
  | "timeout"
  | "service_error"
  | "invalid_response";
const FAILURES: readonly DecisionFailure[] = [
  "unavailable",
  "missing_credentials",
  "unauthorized",
  "invalid_request",
  "input_limit",
  "timeout",
  "service_error",
  "invalid_response",
];

export type DecisionResult =
  | Readonly<{
      outcome: "answered";
      /** The key of the provider that answered. */
      backend: string;
      model: string;
      /** One answer per question, of the question's type. */
      answers: Readonly<Record<string, DecisionAnswer>>;
    }>
  | Readonly<{
      outcome: "failed";
      /** The provider that was asked; undefined when none is registered. */
      backend: string | undefined;
      reason: DecisionFailure;
    }>;

/** What a provider's `decide` resolves with. The host checks it. */
export type DecisionReply =
  | Readonly<{
      outcome: "answered";
      model: string;
      answers: Readonly<Record<string, DecisionAnswer>>;
    }>
  | Readonly<{ outcome: "failed"; reason: DecisionFailure }>;

/**
 * - `checking`: not known yet, for example while a saved key is read.
 *   Callers that need an answer wait.
 * - `ready`: it can answer.
 * - `unconfirmed`: it may be able to answer, but could not check, for
 *   example when the keychain is locked.
 * - `needs-setup`: it cannot answer until the user sets it up in Settings.
 */
export type DecisionProviderStatus =
  | "checking"
  | "ready"
  | "unconfirmed"
  | "needs-setup";

/** A decision provider, as a plugin registers it. */
export type DecisionProvider = Readonly<{
  /** Unique within the plugin. */
  id: string;
  /** The name Settings shows, such as "TypeSafe". */
  label: string;
  /** One line about what it uses, such as "Use your own API key." */
  description: string;
  status(): DecisionProviderStatus;
  subscribe(listener: () => void): () => void;
  /** Answers the request. The request is already checked against the
   * limits, and its `timeoutMs` is set. The host stops waiting at the
   * deadline and aborts `signal`. */
  decide(
    request: DecisionRequest & { timeoutMs: number },
    options: { signal: AbortSignal },
  ): Promise<DecisionReply>;
  /** Its settings, shown under Settings > Decisions API while it is
   * selected. */
  Settings?: ComponentType<{ active(): boolean }>;
  /** Lower comes first in Settings. Default 0. */
  order?: number;
}>;

/** What plugins get as `ctx.decisions`. `decide` never rejects. */
export interface Decisions {
  decide(request: DecisionRequest): Promise<DecisionResult>;
  /** The key of the provider that answers this device's decisions, or
   * undefined when none is registered. */
  backend(): string | undefined;
  /** That provider's status, or `unavailable` when there is none. */
  status(): DecisionProviderStatus | "unavailable";
  subscribe(listener: () => void): () => void;
  /** Offers a provider while the calling plugin runs, or until the returned
   * function removes it. `Decisions` exposes no way to choose the provider;
   * the user does in Settings. */
  registerProvider(provider: DecisionProvider): () => void;
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    decisions: Decisions;
  }
}

export type RegisteredProvider = Contribution<DecisionProvider>;

export const DECISION_BACKEND_KEY = "buzz-decision-backend.v1";
const MAX_QUESTIONS = 32;
const NAME_LIMIT = 64;
const INPUT_LIMIT = 128 * 1024;
const MAX_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;

const orderOf = (provider: DecisionProvider) =>
  Number.isFinite(provider.order) ? (provider.order as number) : 0;
const byOrder = (a: RegisteredProvider, b: RegisteredProvider) =>
  orderOf(a) - orderOf(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
/** A provider's status; one that throws is unconfirmed. Host code reads
 * provider status only through this. */
export const statusOf = (
  provider: DecisionProvider,
): DecisionProviderStatus => {
  try {
    return provider.status();
  } catch {
    return "unconfirmed";
  }
};

/** The provider that answers when no other default is registered. */
export const DEFAULT_DECISION_PROVIDER = "buzz.typesafe/typesafe";
/** Bundled providers that answer, in this order, while the user has not
 * chosen one or their choice is not registered. The first that can answer
 * does; see `DecisionsService.route`. */
export const DEFAULT_DECISION_PROVIDERS: readonly string[] = [
  "block.builderlab/builderlab",
  DEFAULT_DECISION_PROVIDER,
];

/** Answers come from the provider the user chose, or the first registered
 * default until they choose. Decision text can include private messages, so
 * no other provider gets it without that choice: while a chosen provider
 * that is not a default is not registered, decisions are unavailable rather
 * than sent somewhere else. */
export class DecisionsService extends Service implements Decisions {
  private readonly registry;
  /** The user's choice in Settings; undefined until they make one. */
  private chosen: string | undefined;
  private sorted: readonly RegisteredProvider[] = [];
  private readonly listeners = new Set<() => void>();
  constructor(
    ctx: Context,
    private readonly storage: Storage | undefined = typeof window ===
    "undefined"
      ? undefined
      : window.localStorage,
    private readonly setTimer: (run: () => void, ms: number) => () => void = (
      run,
      ms,
    ) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
  ) {
    super(ctx, "decisions");
    this.registry = createContributions<DecisionProvider>(ctx);
    try {
      this.chosen = storage?.getItem(DECISION_BACKEND_KEY) ?? undefined;
    } catch {
      // Unreadable storage means no choice.
    }
    let stops: (() => void)[] = [];
    const watch = () => {
      for (const stop of stops) stop();
      this.sorted = Object.freeze([...this.registry.snapshot()].sort(byOrder));
      stops = this.sorted.map((provider) => {
        try {
          return provider.subscribe(() => this.notify());
        } catch {
          return () => {};
        }
      });
      this.notify();
    };
    ctx.effect(() => {
      const stop = this.registry.subscribe(watch);
      watch();
      return () => {
        stop();
        for (const each of stops) each();
        stops = [];
      };
    });
  }
  registerProvider(provider: DecisionProvider): () => void {
    // Registered under the calling plugin's scope, which `this.ctx` is when
    // a plugin calls through its injected `ctx.decisions`.
    return this.registry.register(this.ctx, provider);
  }
  /** Host-only: every registered provider, in Settings order. */
  providers = (): readonly RegisteredProvider[] => this.sorted;
  /** The provider that answers now, and its status. Without a registered
   * choice, the first default that can answer does; otherwise TypeSafe,
   * whose setup the user can do, `checking` while another default is still
   * finding out whether it can answer. */
  private route():
    | Readonly<{
        provider: RegisteredProvider;
        status: DecisionProviderStatus;
      }>
    | undefined {
    const find = (key: string) =>
      this.sorted.find((provider) => provider.key === key);
    const chosen = this.chosen === undefined ? undefined : find(this.chosen);
    if (chosen) return { provider: chosen, status: statusOf(chosen) };
    if (
      this.chosen !== undefined &&
      !DEFAULT_DECISION_PROVIDERS.includes(this.chosen)
    )
      return undefined;
    const defaults = DEFAULT_DECISION_PROVIDERS.flatMap((key) => {
      const provider = find(key);
      return provider ? [{ provider, status: statusOf(provider) }] : [];
    });
    const answering = defaults.find(
      ({ status }) => status === "ready" || status === "unconfirmed",
    );
    if (answering) return answering;
    const fallback =
      defaults.find(
        ({ provider }) => provider.key === DEFAULT_DECISION_PROVIDER,
      ) ?? defaults[0];
    if (!fallback) return undefined;
    return defaults.some(({ status }) => status === "checking")
      ? { provider: fallback.provider, status: "checking" }
      : fallback;
  }
  private current(): RegisteredProvider | undefined {
    return this.route()?.provider;
  }
  /** Resolves once the routed provider is not `checking`, or on `signal`. */
  private known(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const settle = () => {
        if (!signal.aborted && this.status() === "checking") return;
        stop();
        signal.removeEventListener("abort", settle);
        resolve();
      };
      const stop = this.subscribe(settle);
      signal.addEventListener("abort", settle, { once: true });
      settle();
    });
  }
  // Bound, so a caller can pass these on, as React's external stores do.
  backend = (): string | undefined => this.current()?.key;
  status = (): DecisionProviderStatus | "unavailable" =>
    this.route()?.status ?? "unavailable";
  /** Host-only: Settings chooses the provider. Not part of `Decisions`. */
  setBackend(key: string): void {
    if (!this.sorted.some((provider) => provider.key === key)) return;
    const before = this.backend();
    this.chosen = key;
    try {
      this.storage?.setItem(DECISION_BACKEND_KEY, key);
    } catch {
      // Still in effect for this session.
    }
    if (before !== key) this.notify();
  }
  private notify() {
    for (const listener of [...this.listeners]) listener();
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  async decide(request: DecisionRequest): Promise<DecisionResult> {
    let provider = this.current();
    let backend = provider?.key;
    const failed = (reason: DecisionFailure): DecisionResult =>
      Object.freeze({ outcome: "failed", backend, reason });
    if (!provider) return failed("unavailable");
    const invalid = checkRequest(request);
    if (invalid) return failed(invalid);
    const timeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(
        MIN_TIMEOUT_MS,
        Number.isFinite(request.timeoutMs)
          ? (request.timeoutMs as number)
          : MAX_TIMEOUT_MS,
      ),
    );
    const abort = new AbortController();
    let stopTimer = () => {};
    const deadline = new Promise<"timeout">((resolve) => {
      stopTimer = this.setTimer(() => resolve("timeout"), timeoutMs);
    });
    let reply: unknown;
    try {
      reply = await Promise.race([
        // A provider still checking its setup may stop answering, or a
        // default may start to: route once it knows, within the deadline.
        this.known(abort.signal).then(
          (): DecisionReply | Promise<DecisionReply> => {
            // Past the deadline: never send the request anywhere.
            if (abort.signal.aborted)
              return { outcome: "failed", reason: "timeout" };
            provider = this.current();
            backend = provider?.key;
            if (!provider) return { outcome: "failed", reason: "unavailable" };
            return provider.decide(Object.freeze({ ...request, timeoutMs }), {
              signal: abort.signal,
            });
          },
        ),
        deadline,
      ]);
    } catch {
      return failed("service_error");
    } finally {
      stopTimer();
    }
    if (reply === "timeout") {
      abort.abort();
      return failed("timeout");
    }
    if (!reply || typeof reply !== "object") return failed("invalid_response");
    const { outcome, reason, model, answers } = reply as Record<
      string,
      unknown
    >;
    if (outcome === "failed")
      return FAILURES.includes(reason as DecisionFailure)
        ? failed(reason as DecisionFailure)
        : failed("invalid_response");
    if (outcome !== "answered" || typeof model !== "string" || !model)
      return failed("invalid_response");
    const checked = checkAnswers(request.questions, answers);
    if (!checked || backend === undefined) return failed("invalid_response");
    return Object.freeze({
      outcome: "answered",
      backend,
      model,
      answers: checked,
    });
  }
}

const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The limits every provider accepts, or why the request breaks them. */
export function checkRequest(
  request: DecisionRequest,
): DecisionFailure | undefined {
  if (!record(request) || !text(request.state) || !record(request.questions))
    return "invalid_request";
  if (request.community !== undefined && !text(request.community))
    return "invalid_request";
  const questions = Object.entries(request.questions);
  if (questions.length === 0 || questions.length > MAX_QUESTIONS)
    return "invalid_request";
  for (const [name, question] of questions) {
    if (!text(name) || [...name].length > NAME_LIMIT) return "invalid_request";
    if (!record(question) || !text(question.instructions))
      return "invalid_request";
    const ok =
      question.type === "yes_no" ||
      (question.type === "choice" &&
        record(question.options) &&
        Object.keys(question.options).length >= 2 &&
        Object.keys(question.options).length <= 255 &&
        Object.entries(question.options).every(
          ([value, when]) => text(value) && typeof when === "string",
        )) ||
      (question.type === "score" &&
        Array.isArray(question.levels) &&
        question.levels.length >= 2 &&
        question.levels.length <= 10 &&
        question.levels.every(text));
    if (!ok) return "invalid_request";
  }
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(request)).length;
  } catch {
    return "invalid_request";
  }
  return size > INPUT_LIMIT ? "input_limit" : undefined;
}

const unit = (value: unknown): value is number =>
  typeof value === "number" && value >= 0 && value <= 1;
/** Every key known and every value a probability; missing means none. */
function probabilities(
  value: unknown,
  known: (key: string) => boolean,
): Readonly<Record<string, number>> | undefined {
  if (value === undefined || value === null) return Object.freeze({});
  if (!record(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([key, p]) => known(key) && unit(p))) return undefined;
  return Object.freeze(Object.fromEntries(entries) as Record<string, number>);
}

/** The answers, checked against the questions: every question answered with
 * its own type, a known choice, a place on the scale, values within 0–1.
 * Answers to questions not asked are dropped. */
export function checkAnswers(
  questions: DecisionRequest["questions"],
  answers: unknown,
): Readonly<Record<string, DecisionAnswer>> | undefined {
  if (!record(answers)) return undefined;
  // Collected as entries: assigning `checked["__proto__"]` on a plain object
  // would set its prototype instead of keeping the answer.
  const checked: [string, DecisionAnswer][] = [];
  for (const [name, question] of Object.entries(questions)) {
    const answer = Object.hasOwn(answers, name) ? answers[name] : undefined;
    if (!record(answer) || answer.type !== question.type) return undefined;
    if (question.type === "yes_no") {
      if (!unit(answer.probability)) return undefined;
      checked.push([
        name,
        Object.freeze({
          type: "yes_no",
          probability: answer.probability,
        }),
      ]);
    } else if (question.type === "choice") {
      const known = (key: string) => Object.hasOwn(question.options, key);
      const p = probabilities(answer.probabilities, known);
      if (
        typeof answer.choice !== "string" ||
        !known(answer.choice) ||
        !unit(answer.confidence) ||
        !p
      )
        return undefined;
      checked.push([
        name,
        Object.freeze({
          type: "choice",
          choice: answer.choice,
          confidence: answer.confidence,
          probabilities: p,
        }),
      ]);
    } else {
      const top = question.levels.length - 1;
      const known = (key: string) =>
        /^(0|[1-9][0-9]*)$/.test(key) && Number(key) <= top;
      const p = probabilities(answer.probabilities, known);
      if (
        typeof answer.score !== "number" ||
        !(answer.score >= 0 && answer.score <= top) ||
        !unit(answer.confidence) ||
        !p
      )
        return undefined;
      checked.push([
        name,
        Object.freeze({
          type: "score",
          score: answer.score,
          confidence: answer.confidence,
          probabilities: p,
        }),
      ]);
    }
  }
  return Object.freeze(
    Object.fromEntries(checked) as Record<string, DecisionAnswer>,
  );
}
