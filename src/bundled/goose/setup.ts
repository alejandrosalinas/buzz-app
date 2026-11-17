// goose's providers, as its own config holds them: the ones it offers, their
// models, saving a provider's key, and testing that a provider answers. Each
// call runs a short-lived `goose-acp`; keys go to goose's secret store, never
// into Buzz.
import type { ModelChoice } from "../../features/agents/ModelPicker";
import { withProviderWords } from "../../features/agents/failure-words";
import type {
  ProtectedSpawn,
  ReviewPrompt,
} from "../../features/agent-protection/models";
import type {
  AgentProviderSnapshot,
  Models,
} from "../../features/agents/service";
import {
  GooseProcess,
  REQUEST_TIMEOUT_MS,
  type Choice,
  type GooseHost,
} from "./goose";
import {
  type ConfigValue,
  valuesOf,
} from "../../features/agent-harness/acp/session";

export type ConfigKey = Readonly<{
  name: string;
  required: boolean;
  secret: boolean;
  default?: string | null;
}>;

export type Provider = Readonly<{
  id: string;
  name: string;
  description: string;
  defaultModel: string;
  configured: boolean;
  /** The fields a key or host is entered in. */
  keys: readonly ConfigKey[];
  /** Signs in through goose rather than with a key entered here. */
  signsIn: boolean;
  steps: readonly string[];
  models: readonly ModelChoice[];
  /** Why it isn't set up to run, or "" when it is. */
  needs: string;
}>;

export type Providers = Readonly<{
  providers: readonly Provider[];
  /** What goose's config picks when an agent names no provider or model. */
  defaults: Readonly<{ provider?: string; model?: string }>;
}>;

export type Tested = Readonly<{ ok: boolean; message: string }>;

/** The thinking levels goose offers for a provider and model. */
export type Efforts = Readonly<{
  /** The level goose runs it on when none is chosen. */
  current: string;
  levels: readonly string[];
}>;

/** A session's settings, as `session/new` and `session/set_config_option`
 * return them. */
type ConfigOptions = {
  configOptions?: {
    category?: string | null;
    currentValue?: string;
    options?: ConfigValue[];
  }[];
};

type Entry = {
  providerId: string;
  providerName: string;
  description?: string;
  defaultModel?: string;
  configured?: boolean;
  visibleInSetup?: boolean;
  deprecated?: boolean;
  acp?: boolean;
  setupSteps?: string[];
  configKeys?: (ConfigKey & {
    oauthFlow?: boolean;
    deviceCodeFlow?: boolean;
  })[];
  models?: { id: string; recommended?: boolean }[];
};

/** A special case for the goose plugin's Databricks provider: goose's catalog
 * keeps one endpoint per model name, which can be another team's
 * (`auto-labeler-…-gpt-6-luna` for GPT-6 Luna). Offer the provider's own list,
 * only the workspace's endpoints and goose's own. */
const PREFIXES: Readonly<Record<string, readonly string[]>> = {
  databricks: ["databricks-", "goose-"],
};

const MODEL_FILTER = "DATABRICKS_MODEL_FILTER";

/** Which Databricks models are listed, from goose's `DATABRICKS_MODEL_FILTER`
 * (its environment, else its config): comma-separated patterns, each matched
 * against a whole model ID, case-sensitively, with `*` for any characters and
 * `?` for one. A model matching any pattern is listed; without patterns every
 * model is. It only hides models: Databricks still decides access. */
export function modelFilter(value: unknown): (id: string) => boolean {
  const patterns = String(value ?? "")
    .split(",")
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  if (!patterns.length) return () => true;
  const glob = (pattern: string) =>
    pattern
      .replace(/[\\^$.+()[\]{}|/]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
  const matcher = new RegExp(`^(?:${patterns.map(glob).join("|")})$`, "s");
  return (id) => matcher.test(id);
}

/** Providers Goose reviews refuse: contained agents can write Copilot's sign-in
 * cache, which sets its API address, and, going by their source, the settings
 * the `codex` and `cursor-agent` command-line agents run on. */
export const REVIEW_REFUSED: ReadonlySet<string> = new Set([
  "github_copilot",
  "codex",
  "cursor-agent",
]);
const refused = (provider = "") =>
  new Error(
    provider
      ? `Goose reviews cannot use ${provider}, whose settings contained agents may be able to change`
      : "Goose has no default provider and model to review with",
  );

const TEST_PROMPT = "Reply with exactly: OK";
const TEST_TIMEOUT_MS = 60_000;

export class GooseSetup {
  private listing: Promise<Providers> | undefined;
  private readonly live = new Map<string, Promise<readonly ModelChoice[]>>();
  private readonly thinking = new Map<string, Promise<Efforts>>();

  private state: AgentProviderSnapshot = { readiness: "checking" };
  private readonly listeners = new Set<() => void>();
  private checkedDefaults: string | undefined;
  private checking: Promise<void> | undefined;

  constructor(
    private readonly host: GooseHost | undefined,
    private readonly defaultsChanged: () => void = () => {},
  ) {}

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(state: AgentProviderSnapshot) {
    this.state = {
      ...state,
      blocking: state.blocking ?? this.state.blocking ?? false,
    };
    for (const listener of this.listeners) listener();
  }

  /** A fresh read also notices changes made by `goose configure`. */
  check = (): Promise<void> => {
    if (this.checking) return this.checking;
    this.listing = undefined;
    this.live.clear();
    this.thinking.clear();
    this.update({ readiness: "checking" });
    this.checking = this.providers()
      .then(
        ({ defaults, providers }) => {
          const key = JSON.stringify(defaults);
          if (
            this.checkedDefaults !== undefined &&
            this.checkedDefaults !== key
          )
            this.defaultsChanged();
          this.checkedDefaults = key;
          const ready = providers.some(
            (provider) =>
              provider.id === defaults.provider &&
              provider.configured &&
              Boolean(defaults.model?.trim()),
          );
          this.update(
            ready
              ? { readiness: "ready" }
              : { readiness: "attention", attentionLabel: "Set up Goose" },
          );
        },
        () =>
          this.update({
            readiness: "attention",
            attentionLabel: "Check Goose setup",
          }),
      )
      .finally(() => {
        this.checking = undefined;
      });
    return this.checking;
  };

  /** Writes Goose's own defaults, never a parallel Buzz preference. */
  async saveDefaults(
    choice: Choice,
    fields: Readonly<Record<string, string>> = {},
  ) {
    await this.checking;
    this.update({ ...this.state, blocking: true });
    try {
      if (Object.keys(fields).length) await this.save(choice.provider, fields);
      const providerId = choice.provider.trim();
      const { defaults, providers } = await this.providers();
      await this.with(async (goose) => {
        let modelId =
          choice.model.trim() ||
          (providerId === defaults.provider ? defaults.model?.trim() : "");
        if (!modelId) {
          // Goose stores per-provider choices separately from catalog metadata.
          const { value } = (await goose.request(
            "_goose/unstable/config/read",
            {
              key: "providers",
              isSecret: false,
            },
          )) as { value?: Record<string, { model?: unknown }> | null };
          const stored = value?.[providerId]?.model;
          modelId =
            (typeof stored === "string" ? stored.trim() : "") ||
            providers
              .find((provider) => provider.id === providerId)
              ?.defaultModel.trim();
        }
        if (!modelId)
          throw new Error(
            "Choose a default model with goose configure, then try again.",
          );
        await goose.request("_goose/unstable/defaults/save", {
          providerId,
          modelId,
        });
      });
      this.defaultsChanged();
      this.checkedDefaults = undefined;
      await this.check();
    } finally {
      this.update({ ...this.state, blocking: false });
    }
  }

  /** The models an agent on `choice` can be asked to run a turn on: those of
   * its provider, or goose's config's, and the one it runs on without. Each
   * has the thinking levels goose offers on it, resting on the agent's own
   * level, or else goose's. */
  async picks(choice: Choice): Promise<Models> {
    const provider = choice.provider.trim();
    const { providers, defaults } = await this.providers();
    const id = provider || defaults.provider;
    const listed = providers.find((item) => item.id === id);
    const current =
      choice.model.trim() ||
      (provider ? listed?.defaultModel : defaults.model) ||
      "";
    // A provider not set up offers only the model the agent names.
    const ready = Boolean(id && !listed?.needs);
    const offered = ready ? await this.models(id ?? "") : [];
    // A model its provider does not list is still the one it runs on.
    const named =
      !current || offered.some((model) => model.id === current)
        ? offered
        : [{ id: current, label: current }, ...offered];
    // Without levels a model offers no slider, so a failed read costs only it.
    const levels = ready
      ? await Promise.all(
          this.levels(
            provider,
            named.map((model) => model.id),
          ).map((read) => read.catch(() => undefined)),
        )
      : [];
    const models = named.map(({ id, label }, index) => {
      const offers = levels[index] ?? { current: "", levels: [] };
      const resting = [choice.effort ?? "", offers.current].find(
        (level) => level && offers.levels.includes(level),
      );
      return {
        id,
        label,
        efforts: offers.levels.map((level) => ({
          id: level,
          label: level.charAt(0).toUpperCase() + level.slice(1),
        })),
        ...(resting ? { effort: resting } : {}),
      };
    });
    return { current, models };
  }

  /** goose's providers, read once until something is saved. */
  providers(): Promise<Providers> {
    this.listing ??= this.with(async (goose) => {
      const [{ entries }, defaults] = (await Promise.all([
        goose.request(
          "_goose/unstable/providers/list",
          { providerIds: [] },
          REQUEST_TIMEOUT_MS,
        ),
        goose.request("_goose/unstable/defaults/read", {}, REQUEST_TIMEOUT_MS),
      ])) as [
        { entries: Entry[] },
        { providerId?: string | null; modelId?: string | null },
      ];
      return {
        // Providers that are other agents (`claude-acp`, …) are not offered.
        providers: entries
          .filter(
            (entry) => entry.visibleInSetup && !entry.deprecated && !entry.acp,
          )
          .map(provider)
          .sort((a, b) => a.name.localeCompare(b.name)),
        defaults: {
          ...(defaults.providerId ? { provider: defaults.providerId } : {}),
          ...(defaults.modelId ? { model: defaults.modelId } : {}),
        },
      };
    });
    this.listing.catch(() => {
      this.listing = undefined;
    });
    return this.listing;
  }

  review(
    model: { provider?: string; id: string },
    prompt: ReviewPrompt,
    signal: AbortSignal,
    spawn?: ProtectedSpawn,
  ) {
    signal.throwIfAborted();
    const host = this.host;
    if (!spawn || !host)
      throw new Error("Protected Goose review worker is unavailable");
    if (REVIEW_REFUSED.has(model.provider ?? "")) throw refused(model.provider);
    return (async () => {
      const cwd = await host.resolveDirectory("~");
      signal.throwIfAborted();
      const goose = await GooseProcess.start(
        (_id, options) => spawn(options ?? {}),
        { cwd, protected: true, signal },
      );
      const cancel = () => void goose.kill();
      signal.addEventListener("abort", cancel, { once: true });
      try {
        // goose's defaults, read in this worker, name an unnamed provider.
        const defaults = model.provider
          ? {}
          : ((await goose.request(
              "_goose/unstable/defaults/read",
              {},
              REQUEST_TIMEOUT_MS,
            )) as { providerId?: string | null; modelId?: string | null });
        const provider = model.provider || defaults.providerId || "";
        const id = model.provider ? model.id : model.id || defaults.modelId;
        if (REVIEW_REFUSED.has(provider)) throw refused(provider);
        if (!provider || (!id && !model.provider)) throw refused();
        signal.throwIfAborted();
        const result = (await goose.request(
          "_buzz/security/review",
          {
            provider,
            id,
            // Goose's native review takes text only and rejects other fields,
            // so the schema can only be stated in the trusted instructions.
            prompt: {
              system: prompt.outputSchema
                ? `${prompt.system}\n\nReply with only JSON that matches this JSON Schema, and no other text:\n${JSON.stringify(prompt.outputSchema)}`
                : prompt.system,
              input: prompt.input,
            },
          },
          65_000,
        )) as { text: string; model: { provider: string; id: string } };
        signal.throwIfAborted();
        return result;
      } finally {
        signal.removeEventListener("abort", cancel);
        await goose.kill();
        await goose.exited;
      }
    })();
  }

  /** Whether `provider` is set up here, lists `model` in its live list, as
   * the model picker reads it, and offers `effort` on it, which goose would
   * otherwise refuse each turn. */
  async offers({
    provider = "",
    model,
    effort,
  }: Readonly<{ provider?: string; model: string; effort: string }>) {
    const listed = (await this.providers()).providers.find(
      (item) => item.id === provider,
    );
    return (
      !!listed?.configured &&
      (await this.models(provider)).some((item) => item.id === model) &&
      (await this.efforts({ provider, model })).levels.includes(effort)
    );
  }

  /** Databricks catalogs can lag its endpoints and AI Gateway services;
   * configured providers use live discovery for both Databricks versions.
   * A provider not set up offers none: its catalog's would not run. */
  async models(id: string): Promise<readonly ModelChoice[]> {
    const listed = (await this.providers()).providers.find(
      (item) => item.id === id,
    );
    if (listed?.needs) throw new Error(listed.needs);
    const prefixes = PREFIXES[id];
    const models =
      listed?.configured &&
      (prefixes || id === "databricks_v2" || !listed.models.length)
        ? await this.supported(id)
        : (listed?.models ?? []);
    return prefixes
      ? models.filter((model) =>
          prefixes.some((prefix) => model.id.startsWith(prefix)),
        )
      : models;
  }

  private supported(id: string): Promise<readonly ModelChoice[]> {
    let models = this.live.get(id);
    if (!models) {
      models = this.with(async (goose) => {
        const [{ models }, filter] = (await Promise.all([
          goose.request(
            "_goose/unstable/providers/supported-models/list",
            { providerId: id },
            REQUEST_TIMEOUT_MS,
          ),
          id.startsWith("databricks")
            ? goose.request(
                "_goose/unstable/config/read",
                {
                  key: MODEL_FILTER,
                  isSecret: false,
                },
                REQUEST_TIMEOUT_MS,
              )
            : undefined,
        ])) as [{ models: string[] }, { value?: unknown } | undefined];
        const listed = modelFilter(filter?.value);
        return models
          .filter(listed)
          .map((model) => ({ id: model, label: model }));
      });
      models.catch(() => this.live.delete(id));
      this.live.set(id, models);
    }
    return models;
  }

  /** The thinking levels goose offers on `choice`'s provider and model, as a
   * session opened on them lists. goose without them offers none.
   *
   * ACP lists config options only per session, and only for the model the
   * session is on, so this opens a throwaway session and moves it to the
   * model to read them. */
  efforts(choice: Choice): Promise<Efforts> {
    const [efforts] = this.levels(choice.provider, [choice.model]);
    return efforts as Promise<Efforts>;
  }

  /** `efforts` for each of `models` on `provider`. Those not read yet are
   * read together, in one throwaway session moved from model to model.
   * goose carries a level across models only once one is set, and this
   * session sets none, so each model reports its own default: a session per
   * model read the same levels and defaults, six times slower. */
  private levels(
    provider: string,
    models: readonly string[],
  ): Promise<Efforts>[] {
    provider = provider.trim();
    const key = (model: string) => `${provider}\u0000${model}`;
    const wanted = [...new Set(models.map((model) => model.trim()))]
      .filter((model) => !this.thinking.has(key(model)))
      // The session opens on goose's model for "", so it is read first.
      .sort((a, b) => Number(Boolean(a)) - Number(Boolean(b)));
    if (wanted.length) {
      const read = this.with(async (goose, cwd) => {
        const opened = (await goose.request(
          "session/new",
          {
            cwd,
            mcpServers: [],
            _meta: { enabledExtensions: [], ...(provider ? { provider } : {}) },
          },
          REQUEST_TIMEOUT_MS,
        )) as ConfigOptions & { sessionId: string };
        try {
          const found = new Map<string, Efforts | Error>();
          for (const model of wanted) {
            try {
              const { configOptions = [] } = model
                ? ((await goose.request(
                    "session/set_config_option",
                    {
                      sessionId: opened.sessionId,
                      configId: "model",
                      value: model,
                    },
                    REQUEST_TIMEOUT_MS,
                  )) as ConfigOptions)
                : opened;
              const option = configOptions.find(
                (item) => item.category === "thought_level",
              );
              found.set(model, {
                current: option?.currentValue ?? "",
                levels: valuesOf(option?.options),
              });
            } catch (error) {
              // One model goose cannot move to does not cost the others.
              found.set(
                model,
                error instanceof Error ? error : new Error(String(error)),
              );
            }
          }
          return found;
        } finally {
          // goose keeps every session; this one is not worth keeping.
          await goose
            .request(
              "session/delete",
              { sessionId: opened.sessionId },
              REQUEST_TIMEOUT_MS,
            )
            .catch(() => undefined);
        }
      });
      for (const model of wanted) {
        const one = read.then((found) => {
          const efforts = found.get(model);
          if (!efforts || efforts instanceof Error)
            throw efforts ?? new Error(`goose listed no levels for ${model}`);
          return efforts;
        });
        // A failed read is tried again; a recheck may have replaced it.
        one.catch(() => {
          if (this.thinking.get(key(model)) === one)
            this.thinking.delete(key(model));
        });
        this.thinking.set(key(model), one);
      }
    }
    return models.map(
      (model) => this.thinking.get(key(model.trim())) as Promise<Efforts>,
    );
  }

  /** Which of a provider's fields goose already holds. */
  saved(id: string): Promise<ReadonlySet<string>> {
    return this.with(async (goose) => {
      const { fields } = (await goose.request(
        "_goose/unstable/providers/config/read",
        { providerId: id },
      )) as { fields: { key: string; isSet: boolean }[] };
      return new Set(
        fields.filter((field) => field.isSet).map((field) => field.key),
      );
    });
  }

  /** Saves a provider's fields in goose's config and secret store. */
  async save(id: string, fields: Readonly<Record<string, string>>) {
    await this.with((goose) =>
      goose.request("_goose/unstable/providers/config/save", {
        providerId: id,
        fields: Object.entries(fields).map(([key, value]) => ({ key, value })),
      }),
    );
    this.listing = undefined;
    this.live.delete(id);
    this.thinking.clear();
  }

  /** Asks the provider for one short reply, without tools. goose reports a
   * failed call as its reply, so only the expected answer passes. */
  test(choice: Choice): Promise<Tested> {
    const env = { GOOSE_MODE: "chat" };
    return this.with(async (goose, cwd) => {
      const session = await goose.open({
        cwd,
        // A titled session spares the provider a naming call.
        title: "Buzz connection test",
        systemPrompt: "",
        choice: () => choice,
      });
      try {
        const settled = await Promise.race([
          session.send(TEST_PROMPT),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("The provider did not answer in time")),
              TEST_TIMEOUT_MS,
            ),
          ),
        ]);
        const reply = settled.text?.trim() ?? "";
        if (/^\W*ok\W*$/i.test(reply))
          return { ok: true, message: "Connected" };
        return {
          ok: false,
          message: reply || settled.error || "The provider sent no reply",
        };
      } finally {
        await goose.close(session);
        // goose keeps every session; this one is not worth keeping.
        await goose
          .request("session/delete", { sessionId: session.id })
          .catch(() => undefined);
      }
    }, env).catch((error: unknown) => ({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }));
  }

  private with<T>(
    run: (goose: GooseProcess, cwd: string) => Promise<T>,
    env: Readonly<Record<string, string>> = {},
  ): Promise<T> {
    return briefly(this.host, run, env);
  }
}

/** Runs `run` against a `goose-acp` started for it in the home folder, and
 * stops it after. It serves no Buzz tools; `signal` stops its startup. */
export async function briefly<T>(
  host: GooseHost | undefined,
  run: (goose: GooseProcess, cwd: string) => Promise<T>,
  env: Readonly<Record<string, string>> = {},
  signal?: AbortSignal,
): Promise<T> {
  if (!host) throw new Error("goose runs only in the desktop app");
  const cwd = await host.resolveDirectory("~");
  signal?.throwIfAborted();
  const goose = await GooseProcess.start(host.spawn, {
    cwd,
    env,
    ...(signal && { signal }),
  });
  try {
    return await run(goose, cwd);
  } finally {
    await goose.kill();
  }
}

function provider(entry: Entry): Provider {
  const keys = entry.configKeys ?? [];
  const models = [...(entry.models ?? [])].sort(
    (a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)),
  );
  const listed = {
    id: entry.providerId,
    name: entry.providerName,
    description: entry.description ?? "",
    defaultModel: entry.defaultModel ?? "",
    configured: Boolean(entry.configured),
    keys: keys
      .filter((key) => !key.oauthFlow && !key.deviceCodeFlow)
      .map(({ name, required, secret, default: fallback }) => ({
        name,
        required,
        secret,
        default: fallback ?? null,
      })),
    signsIn: keys.some((key) => key.oauthFlow || key.deviceCodeFlow),
    steps: entry.setupSteps ?? [],
    // The exact ID: a catalog name can stand for several models.
    models: models.map((model) => ({ id: model.id, label: model.id })),
  };
  return { ...listed, needs: needs(listed) };
}

/** What `provider` still needs before it runs, or "" for nothing: a required
 * field without a default, or signing in. goose lists Ollama as not configured
 * without `OLLAMA_HOST`, though it runs on the host's default. */
function needs(provider: Omit<Provider, "needs">) {
  if (provider.configured) return "";
  const fields = provider.keys
    .filter((key) => key.required && !key.default)
    .map((key) => `${keyLabel(key.name)} (${key.name})`);
  const step = fields.length
    ? `Add ${fields.join(", ")} in Edit configuration, or run goose configure.`
    : provider.signsIn
      ? "Run goose configure to sign in."
      : "";
  return step && `${provider.name} isn't set up in goose. ${step}`;
}

/** A failed turn's error as its report in the conversation says it, in
 * Markdown: a key goose lacks or its provider refused links to `settings`,
 * where goose's providers are set up. Without the key goose fails the turn
 * with "Configuration value not found: ANTHROPIC_API_KEY"; a provider that
 * refuses its key or sign-in ends it with ACP's "Authentication required",
 * which a failed start or handover reports after "goose could not start: " or
 * "Error: ". A turn doesn't say which kind of provider refused, and a sign-in
 * is redone outside Buzz, so the report asks only to check the provider. The
 * explanation comes first, then goose's own words. */
export function explainTurn(error: string, settings: string) {
  const missing = /Configuration value not found: (\w*API_KEY)\b/.exec(error);
  const explanation = missing
    ? `Goose is missing an API key (${missing[1]}). Head to [Settings](${settings}) to add it.`
    : /(?:^|: )Authentication required\b/.test(error)
      ? `Goose's provider rejected its API key or sign-in. Head to [Settings](${settings}) to check its provider.`
      : undefined;
  return explanation ? withProviderWords(explanation, "goose", error) : error;
}

/** `ANTHROPIC_API_KEY` reads as `API key`, `OPENAI_HOST` as `Host`. */
export function keyLabel(name: string) {
  const words = name.split("_").slice(1);
  const text = (words.length ? words : [name]).join(" ").toLowerCase();
  return (text.charAt(0).toUpperCase() + text.slice(1))
    .replace(/\bapi\b/i, "API")
    .replace(/\burl\b/i, "URL");
}
