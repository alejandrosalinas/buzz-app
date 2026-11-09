// Pi's New agent choices and agent settings. Providers, their keys and their
// models are Pi's own: listed from it, and keys saved with its login.
import {
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { errorText } from "../../buzz-mcp/rpc";
import { isRetryableRead, retryRead } from "../../features/relay/read-retry";
import { PiStopped } from "./pi";
import activityStyles from "../../features/agents/ActivityLayout.module.css";
import {
  TranscriptPanel,
  whenShown,
} from "../../features/agents/TranscriptPanel";
import { AgentInstructions } from "../../features/agents/AgentInstructions";
import { AgentSaveButton } from "../../features/agents/AgentSaveButton";
import { ModelPicker } from "../../features/agents/ModelPicker";
import {
  ConversationName,
  OpenedConversation,
  useOpenedSession,
  useOpenTranscript,
} from "../../features/agents/OpenedConversation";
import type {
  AgentCreateProps,
  AgentViewProps,
} from "../../features/agents/service";
import { PanelSubview } from "../../features/panels/PanelSubview";
import {
  ClaudeLogoIcon,
  type DefinedIcon,
  OpenAILogoIcon,
  PiLogoIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { formatItemTimestamp } from "../../shared/datetime";
import { useClockFormat } from "../../shared/clock-preference";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { effortLabel } from "../claude-code/runtime";
import {
  type Config,
  DEFAULT_CONFIG,
  type PiRuntime,
  type Place,
  config as readConfig,
} from "./runtime";
import {
  DEFAULT_THINKING,
  type PiModel,
  type PiSetup,
  type Provider,
  type Providers,
  runsAt,
  type Tested,
} from "./setup";
import { TURN_LIMIT } from "./transcript";

const SCOPES = [
  {
    label: "",
    options: [
      { value: "thread", label: "One conversation per thread" },
      { value: "channel", label: "One conversation per channel" },
    ],
  },
];

type Choice = Readonly<{ provider: string; model: string }>;

/** Marks for the providers Buzz has one for, by Pi's provider ID. */
const PROVIDER_ICONS: ReadonlyMap<string, DefinedIcon> = new Map([
  ["anthropic", ClaudeLogoIcon],
  ["openai", OpenAILogoIcon],
]);
/** The provider's mark, or undefined for one without a mark. */
const providerIcon = (id: string | undefined) => {
  const Icon = id ? PROVIDER_ICONS.get(id) : undefined;
  return Icon && <Icon size={18} aria-hidden="true" />;
};
const CONVERSATION_LIMIT = 30;
const label = ({ channelId, name, root }: Place) =>
  `${name || channelId.slice(0, 8)} · ${root ? `thread ${root.slice(0, 8)}` : "channel"}`;
type Read<T> = (
  | { status: "loading"; value?: T }
  | { status: "ready"; value: T }
  | { status: "error"; error: string; value?: T }
) & { scope?: string };

/** `read()` as it settles, read again when `key` changes or on `retry`, which
 * abort the one before, and with `focus` when the window gets focus. A value
 * already shown for the same `scope` stays while it is read again, and when
 * that read fails. */
function useRead<T>(
  read: (signal: AbortSignal) => Promise<T>,
  key: string,
  scope = key,
  focus = false,
) {
  const [state, setState] = useState<Read<T>>({ status: "loading" });
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!focus) return;
    const again = () => setRound((value) => value + 1);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [focus]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `read` follows `key`.
  useEffect(() => {
    const abort = new AbortController();
    const kept = (prior: Read<T>) =>
      prior.value === undefined || prior.scope !== scope
        ? {}
        : { value: prior.value, scope };
    setState((prior) => ({ status: "loading", ...kept(prior) }));
    retryRead(
      read,
      abort.signal,
      // The next request starts another host.
      (error) => error instanceof PiStopped || isRetryableRead(error),
    ).then(
      (value) => {
        if (!abort.signal.aborted) setState({ status: "ready", value, scope });
      },
      (error: unknown) => {
        if (!abort.signal.aborted)
          setState((prior) => ({
            status: "error",
            error: errorText(error),
            ...kept(prior),
          }));
      },
    );
    return () => abort.abort();
  }, [key, round]);
  return [state, () => setRound((value) => value + 1)] as const;
}

/** The model Pi's settings give a choice without one: only for the provider
 * those settings name. */
const defaultModel = (
  { provider }: Choice,
  defaults: Providers["defaults"] | undefined,
) =>
  (provider || defaults?.provider) === defaults?.provider
    ? defaults?.model
    : undefined;
/** Whether a choice names no model, nor has Pi's default one, once Pi's
 * settings are known. */
const modelless = (
  choice: Choice,
  defaults: Providers["defaults"] | undefined,
) => Boolean(defaults && !choice.model && !defaultModel(choice, defaults));
/** The provider a choice runs on, once Pi's providers are known, when Buzz's
 * Pi doesn't have it: not built in, and added by no Pi package Buzz loaded. */
const unknownProvider = (choice: Choice, providers: Providers | undefined) => {
  const id = choice.provider || providers?.defaults.provider;
  return id && providers && !providers.providers.some((item) => item.id === id)
    ? id
    : undefined;
};
/** Whether a choice can't run, as far as Pi's providers say. */
const unusable = (choice: Choice, providers: Providers | undefined) =>
  Boolean(unknownProvider(choice, providers)) ||
  modelless(choice, providers?.defaults);
/** The thinking levels of a choice's model, once its provider's are read. */
const levelsOf = (
  choice: Choice,
  defaults: Providers["defaults"] | undefined,
  models: readonly PiModel[] | undefined,
) =>
  models?.find(
    (model) => model.id === (choice.model || defaultModel(choice, defaults)),
  )?.thinking;
/** The saved thinking level once `next` is chosen: kept while its model has
 * it, else Pi's. `models` are `current`'s provider's; another provider's
 * aren't read yet. */
const effortAfter = (
  current: Config,
  next: Choice,
  defaults: Providers["defaults"] | undefined,
  models: readonly PiModel[] | undefined,
) => {
  const levels =
    next.provider === current.provider ? levelsOf(next, defaults, models) : [];
  return !levels || levels.includes(current.effort) ? current.effort : "";
};

export function createTabs({
  setup,
  runtime,
}: Readonly<{
  setup: PiSetup;
  runtime: Pick<
    PiRuntime,
    | "places"
    | "working"
    | "transcript"
    | "subscribe"
    | "channelLabel"
    | "subscribeChannels"
  >;
}>) {
  /** The provider, its key and its model, and a test that they answer. As
   * `rows` of the agent's settings, only the provider and model: the rest is
   * `ProviderSetup`'s. `listing` is the surface's own read, so what it gates
   * agrees with this. */
  function ProviderFields({
    value,
    onChange,
    listing,
    reload,
    rows = false,
  }: Readonly<{
    value: Choice;
    onChange(value: Choice): void;
    listing: Read<Providers>;
    reload(): void;
    rows?: boolean;
  }>) {
    const providers = listing.value;
    const fallback = providers?.defaults.provider;
    const id = value.provider || fallback || "";
    const provider = providers?.providers.find((item) => item.id === id);
    const [models] = useRead(
      () => (id ? setup.models(id) : Promise.resolve([] as PiModel[])),
      id,
    );
    const named = (key: string | undefined) =>
      providers?.providers.find((item) => item.id === key)?.name ?? key;
    const modelDefault = defaultModel(value, providers?.defaults);
    const missing = modelless(value, providers?.defaults);
    const unknown = unknownProvider(value, providers);
    return (
      <>
        <Select
          label="Provider"
          variant={rows ? "preference" : "field"}
          value={value.provider}
          leading={providerIcon(id)}
          {...(rows && !value.provider && fallback
            ? { valueLabel: named(fallback) }
            : {})}
          disabled={!providers}
          {...(listing.status === "error"
            ? { error: listing.error }
            : unknown
              ? {
                  error: `${unknown} isn't one of Pi's built-in providers, and no Pi package Buzz loaded adds it. Choose another.`,
                }
              : listing.status === "loading" && !providers
                ? { description: "Loading Pi's providers…" }
                : !id
                  ? {
                      description:
                        "Pi's settings name no provider. Choose one.",
                    }
                  : rows && provider && !provider.configured
                    ? { description: `Set up ${provider.name} in Settings.` }
                    : {})}
          groups={[
            {
              label: "",
              options: [
                {
                  value: "",
                  label: fallback
                    ? `From Pi settings (${named(fallback)})`
                    : "From Pi settings",
                },
                ...(providers?.providers ?? []).map((item) => ({
                  value: item.id,
                  label: item.name,
                  leading: providerIcon(item.id),
                  ...(item.configured ? { description: "Set up" } : {}),
                })),
              ],
            },
          ]}
          onValueChange={(provider) => onChange({ provider, model: "" })}
        />
        {listing.status === "error" && (
          <div>
            <Button onClick={reload}>Try again</Button>
          </div>
        )}
        {!rows && provider && (
          <ProviderKey key={provider.id} provider={provider} onSaved={reload} />
        )}
        <ModelPicker
          allowCustomModel={false}
          models={models.value ?? []}
          loading={models.status === "loading"}
          value={value.model}
          defaultLabel={
            modelDefault ? `Pi default (${modelDefault})` : "Pi default"
          }
          {...(models.status === "error"
            ? { description: `Could not list models: ${models.error}` }
            : missing && id && !unknown
              ? {
                  description: `Pi's settings name no model for ${named(id)}. Choose one.`,
                }
              : {})}
          disabled={Boolean(unknown)}
          onChange={(model) => onChange({ ...value, model })}
        />
        {!rows && (
          <TestConnection
            choice={value}
            disabled={unusable(value, providers)}
          />
        )}
      </>
    );
  }

  /** The agent's provider's key, and a test that it answers. */
  function ProviderSetup({
    choice,
    listing,
    reload,
  }: Readonly<{
    choice: Choice;
    listing: Read<Providers>;
    reload(): void;
  }>) {
    const id = choice.provider || listing.value?.defaults.provider;
    const provider = listing.value?.providers.find((item) => item.id === id);
    return (
      <>
        {listing.status === "error" && (
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={reload}>Try again</Button>
            <p role="alert" className="buzz-field-error m-0">
              {listing.error}
            </p>
          </div>
        )}
        {provider && (
          <ProviderKey key={provider.id} provider={provider} onSaved={reload} />
        )}
        <TestConnection
          choice={choice}
          disabled={unusable(choice, listing.value)}
        />
      </>
    );
  }

  /** Asks the provider and model for one short reply. */
  function TestConnection({
    choice,
    disabled,
  }: Readonly<{ choice: Choice; disabled: boolean }>) {
    // A result belongs to the choice it tested.
    const key = `${choice.provider}\u0000${choice.model}`;
    const [result, setResult] = useState<{
      key: string;
      tested: Tested | "testing";
    }>();
    const tested = result?.key === key ? result.tested : undefined;
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={disabled || tested === "testing"}
          loading={tested === "testing"}
          onClick={async () => {
            setResult({ key, tested: "testing" });
            setResult({
              key,
              tested: await setup.test(choice).catch((error: unknown) => ({
                ok: false,
                message: errorText(error),
              })),
            });
          }}
        >
          Test connection
        </Button>
        {tested && tested !== "testing" && (
          <p
            role={tested.ok ? "status" : "alert"}
            className={tested.ok ? "m-0 text-body-sm" : "buzz-field-error m-0"}
          >
            {tested.message}
          </p>
        )}
      </div>
    );
  }

  /** A provider's API key, saved with Pi's login. One that signs in without
   * a key is set up with the `pi` command. */
  function ProviderKey({
    provider,
    onSaved,
  }: Readonly<{ provider: Provider; onSaved(): void }>) {
    const [key, setKey] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [changing, setChanging] = useState(false);
    const saveKey = async () => {
      setSaving(true);
      setError("");
      try {
        await setup.login(provider.id, key.trim());
        setKey("");
        setChanging(false);
        onSaved();
      } catch (reason) {
        setError(errorText(reason));
      } finally {
        setSaving(false);
      }
    };
    if (provider.configured && (!provider.key || !changing))
      return (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="m-0 text-body-sm text-subtle">
            {provider.name} is set up in Pi.
          </p>
          {provider.key && (
            <Button onClick={() => setChanging(true)}>Change</Button>
          )}
        </div>
      );
    if (!provider.key)
      return (
        <p className="m-0 text-body-sm">
          {provider.name} signs in through Pi. Run <code>pi</code>, then{" "}
          <code>/login</code>, to set it up, then choose it here.
        </p>
      );
    return (
      <>
        <Field
          label="API key"
          description={`Saved in ~/.pi/agent/auth.json, for every Pi agent and the pi command.${provider.signsIn ? " Or sign in with the pi command's /login." : ""}`}
        >
          <Input
            type="password"
            autoComplete="off"
            value={key}
            disabled={saving}
            onValueChange={setKey}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing)
                return;
              // The key's own save, not the settings form's.
              event.preventDefault();
              if (key.trim()) void saveKey();
            }}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={!key.trim()} loading={saving} onClick={saveKey}>
            Save to Pi
          </Button>
          {error && (
            <p role="alert" className="buzz-field-error m-0">
              {error}
            </p>
          )}
        </div>
      </>
    );
  }

  /** The instructions a new agent starts with. */
  function Create({ config, onChange, disabled }: AgentCreateProps<Config>) {
    const current = readConfig(config);
    return (
      <AgentInstructions
        creation
        value={current.instructions}
        disabled={disabled}
        onChange={(instructions) => onChange({ ...current, instructions })}
      />
    );
  }

  /** A provider, its key and its model, chosen apart from the card. */
  function ChooseDialog({
    value,
    listing,
    reload,
    onChange,
    onClose,
  }: Readonly<{
    value: Choice;
    /** The card's read of Pi's providers, so both show one result. */
    listing: Read<Providers>;
    reload(): void;
    onChange(choice: Choice): void;
    onClose(): void;
  }>) {
    const [draft, setDraft] = useState<Choice>({
      provider: value.provider,
      model: value.model,
    });
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title="Provider and model"
        description="Pi's own settings are the default. Keys are saved in Pi, for every Pi agent and the pi command."
        actions={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="prominent"
              disabled={unusable(draft, listing.value)}
              focusableWhenDisabled
              onClick={() => onChange(draft)}
            >
              Use
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <ProviderFields
            value={draft}
            onChange={setDraft}
            listing={listing}
            reload={reload}
          />
        </div>
      </Dialog>
    );
  }

  /** The agent's model in New agent and on its library card, marked with Pi
   * and its provider. It opens the provider dialog to set up, test and use
   * another provider or model. */
  function CreateModel({
    config,
    onChange,
    onReadyChange,
    disabled,
    modelAppearance,
  }: AgentCreateProps<Config>) {
    const current = readConfig(config);
    const [listing, reload] = useRead(
      () => setup.providers(),
      "providers",
      // Signing in or choosing defaults with the `pi` command changes them.
      "providers",
      true,
    );
    const [choosing, setChoosing] = useState(false);
    const providers = listing.value;
    const id = current.provider || providers?.defaults.provider || "";
    const [models] = useRead(
      () => (id ? setup.models(id) : Promise.resolve([] as PiModel[])),
      id,
    );
    const unknown = unknownProvider(current, providers);
    const fallback = defaultModel(current, providers?.defaults);
    const ready =
      listing.status === "ready" &&
      !unknown &&
      !!id.trim() &&
      !!(current.model || fallback)?.trim();
    useEffect(() => onReadyChange?.(ready), [onReadyChange, ready]);
    const named = (model: string) =>
      models.value?.find((item) => item.id === model)?.label ?? model;
    const provider =
      providers?.providers.find((item) => item.id === id)?.name ?? id;
    const label = current.model
      ? named(current.model)
      : fallback
        ? `Pi default (${provider} · ${named(fallback)})`
        : !providers
          ? "Pi default"
          : id
            ? "Choose a model"
            : "Choose a provider";
    const mark = providerIcon(id);
    const error =
      listing.status === "error"
        ? listing.error
        : unknown && `Pi has no provider ${unknown}`;
    return (
      <>
        {/* The compact select recipe ellipsizes long model names in cards. */}
        <div className="buzz-select" data-variant="compact">
          <Button
            size="sm"
            variant={modelAppearance ?? "outline"}
            disabled={disabled}
            aria-label={`Model: ${label}`}
            aria-haspopup="dialog"
            onClick={() => setChoosing(true)}
          >
            <span className="buzz-select-value-content">
              <span className="buzz-select-leading" aria-hidden="true">
                <PiLogoIcon size={18} />
              </span>
              {mark && (
                <span className="buzz-select-leading" aria-hidden="true">
                  {mark}
                </span>
              )}
              <span className="buzz-select-value" title={label}>
                {label}
              </span>
            </span>
          </Button>
        </div>
        {error && (
          <span role="alert" className="text-body-sm text-danger">
            {error}
          </span>
        )}
        {listing.status === "error" && (
          <Button size="sm" disabled={disabled} onClick={reload}>
            Try again
          </Button>
        )}
        {choosing && (
          <ChooseDialog
            value={current}
            listing={listing}
            reload={reload}
            onClose={() => setChoosing(false)}
            onChange={(choice) => {
              onChange({
                ...current,
                ...choice,
                effort: effortAfter(
                  current,
                  choice,
                  providers?.defaults,
                  models.value,
                ),
              });
              setChoosing(false);
            }}
          />
        )}
      </>
    );
  }

  /** One conversation's turns, kept current while Pi works. */
  function TranscriptView({
    agent,
    place,
    working,
  }: {
    agent: AgentViewProps<Config>["agent"];
    place: Place;
    working: boolean;
  }) {
    return (
      <TranscriptPanel
        agent={agent}
        read={(signal) => {
          let tries = 0;
          return retryRead(
            // A retry waits for a hidden window to show.
            async (signal) => {
              if (tries++) await whenShown(signal);
              return runtime.transcript(agent.key, place, working, signal);
            },
            signal,
            // The next request starts another host.
            (error) => error instanceof PiStopped || isRetryableRead(error),
          );
        }}
        readKey={`${agent.key}\u0000${place.key}\u0000${place.conversation}`}
        working={working}
        reading="Reading the Pi conversation…"
        failed="Could not read the Pi conversation"
        missing={null}
        notes={(transcript) =>
          transcript.more && (
            <p className="m-0 text-body-sm text-subtle">
              Showing the latest {TURN_LIMIT} turns.
            </p>
          )
        }
      />
    );
  }

  /** The Pi conversation of the place the profile was opened from, and the
   * agent's other recent ones, each with its transcript. Pi's storage is
   * shared by every Buzz build here, so the list is the whole history. */
  function ActivityTab({
    agent,
    conversation,
    initialTranscript,
  }: {
    agent: AgentViewProps<Config>["agent"];
    conversation?: AgentViewProps<Config>["conversation"];
    initialTranscript?: AgentViewProps<Config>["initialTranscript"];
  }) {
    const working = useSyncExternalStore(
      (listener) => runtime.subscribe(listener),
      () => runtime.working(agent.key),
    );
    // Read again as turns start and end, which can add a conversation.
    const [listing, reload] = useRead(
      () => runtime.places(agent.key),
      `${agent.key}\u0000${working.join()}`,
      agent.key,
    );
    // The channels' names and kinds are the community's now, not Pi's
    // history's: a channel made private shows its lock here as it does in
    // the sidebar, without reading Pi again.
    const [, relabel] = useReducer((count: number) => count + 1, 0);
    useEffect(() => runtime.subscribeChannels(agent.key, relabel), [agent.key]);
    const places = listing.value?.map((place) => ({
      ...place,
      ...runtime.channelLabel(agent.key, place.channelId),
    }));
    // Pi lists its conversations only after the tab shows, so its transcript
    // would open late, under whatever the reader turned to meanwhile. The
    // request is settled without opening it.
    const opening = initialTranscript?.opening;
    // biome-ignore lint/correctness/useExhaustiveDependencies: once per opening.
    useEffect(() => initialTranscript?.done(), [opening]);
    if (!places)
      return listing.status === "error" ? (
        <div className="grid gap-2">
          <p role="alert" className="buzz-field-error m-0">
            Could not list Pi's conversations: {listing.error}
          </p>
          <div>
            <Button type="button" onClick={reload}>
              Try again
            </Button>
          </div>
        </div>
      ) : (
        <p role="status" className="m-0 text-body-sm text-subtle">
          Reading Pi's conversations…
        </p>
      );
    return (
      <PlaceList
        agent={agent}
        conversation={conversation}
        places={places}
        working={working}
      />
    );
  }

  function PlaceList({
    agent,
    conversation,
    places,
    working,
  }: {
    agent: AgentViewProps<Config>["agent"];
    conversation?: AgentViewProps<Config>["conversation"];
    places: readonly Place[];
    working: readonly number[];
  }) {
    useClockFormat();
    const { session: here } = useOpenedSession(
      places,
      conversation,
      async () => undefined,
    );
    const status = (place: Place) =>
      working.includes(place.conversation) ? "Working" : undefined;
    const { open, show, back } = useOpenTranscript(conversation, label);
    const recent = places
      .filter((place) => place.key !== here?.key)
      .slice(0, CONVERSATION_LIMIT);
    return (
      <div className={activityStyles.activity}>
        {conversation && (
          <OpenedConversation
            conversation={conversation}
            harness="Pi"
            session={here}
            status={here && status(here)}
            onView={() => here && show(here)}
          />
        )}
        <section className={activityStyles.section}>
          <InlineHeader title="Recent conversations" />
          {recent.length ? (
            <SettingsGroup layout="form">
              <ul className={activityStyles.list}>
                {recent.map((place) => (
                  <li key={place.key} className={activityStyles.entry}>
                    <div className={activityStyles.row}>
                      <span className={activityStyles.copy}>
                        <ConversationName
                          session={place}
                          title={label(place)}
                          className="text-label-sm"
                        />
                        <span className="block text-body-sm text-subtle">
                          {[
                            place.root
                              ? `Thread ${place.root.slice(0, 8)}`
                              : "Channel",
                            status(place),
                            formatItemTimestamp(place.at / 1000, {
                              withTime: true,
                            }),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                      <Button
                        type="button"
                        variant="subtle"
                        size="sm"
                        aria-label={`View transcript: ${label(place)}`}
                        onClick={() => show(place)}
                      >
                        View transcript
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </SettingsGroup>
          ) : (
            <p className="m-0 text-body-sm text-subtle">
              None. A conversation starts when the agent is mentioned.
            </p>
          )}
        </section>
        {open && (
          <PanelSubview
            title={label(open)}
            backLabel="Back to profile"
            onBack={back}
          >
            <TranscriptView
              key={open.key}
              agent={agent}
              place={open}
              working={working.includes(open.conversation)}
            />
          </PanelSubview>
        )}
      </div>
    );
  }

  function SettingsTab({
    agent,
    save,
    settingsHost,
    settingsSection,
    settingsContent,
  }: AgentViewProps<Config>) {
    const form = useId();
    const saved = readConfig(agent.config);
    const [draft, setDraft] = useState(saved);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const saveErrorRef = useRef<HTMLParagraphElement>(null);
    useEffect(() => {
      if (error) saveErrorRef.current?.focus();
    }, [error]);
    const [listing, reload] = useRead(
      () => setup.providers(),
      "providers",
      // Signing in or choosing defaults with the `pi` command changes them.
      "providers",
      true,
    );
    const defaults = listing.value?.defaults;
    const id = draft.provider || defaults?.provider || "";
    const [models] = useRead(
      () => (id ? setup.models(id) : Promise.resolve([] as PiModel[])),
      id,
    );
    const configChanged = JSON.stringify(draft) !== JSON.stringify(saved);
    const changed = configChanged || Boolean(settingsHost?.pendingSave);
    const submit = async () => {
      setSaving(true);
      setError("");
      try {
        await save({
          ...draft,
          workspace: draft.workspace.trim() || DEFAULT_CONFIG.workspace,
        });
      } catch (reason) {
        setError(errorText(reason));
      } finally {
        setSaving(false);
      }
    };
    // Undefined until the model's levels are read.
    const levels = levelsOf(draft, defaults, models.value);
    const level = defaults?.thinking ?? DEFAULT_THINKING;
    const resting = effortLabel(levels ? runsAt(levels, level) : level);
    const efforts = [
      { value: "", label: `${resting} · Default` },
      // A saved level the model doesn't have, or not yet read.
      ...(draft.effort && !levels?.includes(draft.effort)
        ? [
            {
              value: draft.effort,
              label: levels
                ? `${effortLabel(draft.effort)} (unavailable)`
                : effortLabel(draft.effort),
            },
          ]
        : []),
      ...(levels ?? []).map((id) => ({ value: id, label: effortLabel(id) })),
    ];
    return (
      <form
        id={form}
        className="grid gap-4 [container-type:inline-size]"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {error && (
          <p
            ref={saveErrorRef}
            tabIndex={-1}
            role="alert"
            className="buzz-field-error"
          >
            {error}
          </p>
        )}
        {settingsSection !== "runtime" && (
          <>
            <SettingsGroup>
              {settingsHost?.typeControl?.(configChanged)}
              <ProviderFields
                rows
                value={draft}
                onChange={(choice) =>
                  setDraft({
                    ...draft,
                    ...choice,
                    effort: effortAfter(draft, choice, defaults, models.value),
                  })
                }
                listing={listing}
                reload={reload}
              />
              <Select
                label="Thinking"
                variant="preference"
                value={draft.effort}
                {...(!draft.effort ? { valueLabel: resting } : {})}
                groups={[{ label: "", options: efforts }]}
                onValueChange={(effort) => setDraft({ ...draft, effort })}
              />
            </SettingsGroup>
            <AgentInstructions
              value={draft.instructions}
              disabled={false}
              onChange={(instructions) => setDraft({ ...draft, instructions })}
            />
          </>
        )}
        {settingsSection !== "identity" && (
          <>
            <ProviderSetup choice={draft} listing={listing} reload={reload} />
            <Field
              label="Workspace"
              description="The folder Pi works in. Use ~/ for your home folder."
            >
              <Input
                value={draft.workspace}
                onValueChange={(workspace) => setDraft({ ...draft, workspace })}
              />
            </Field>
            <Select
              label="Conversations"
              variant="preference"
              value={draft.scope}
              groups={SCOPES}
              onValueChange={(value) =>
                setDraft({
                  ...draft,
                  scope: value === "channel" ? "channel" : "thread",
                })
              }
            />
          </>
        )}
        <AgentSaveButton
          form={form}
          saving={saving}
          disabled={!changed || unusable(draft, listing.value)}
          dirty={changed}
        />
        {settingsSection !== "identity" && settingsContent}
      </form>
    );
  }

  return { ActivityTab, Create, CreateModel, SettingsTab };
}
