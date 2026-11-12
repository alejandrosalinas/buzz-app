import { ModelDiscoveryRecovery } from "../../features/agents/ModelDiscoveryRecovery";
// goose's New agent choices and agent settings. Providers, their keys and
// their models are goose's own: listed from it, and saved into its config.
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ProviderDialogActions } from "../../features/agents/ProviderDialogActions";
import activityStyles from "../../features/agents/ActivityLayout.module.css";
import { TranscriptPanel } from "../../features/agents/TranscriptPanel";
import { AgentSaveButton } from "../../features/agents/AgentSaveButton";
import { AgentInstructions } from "../../features/agents/AgentInstructions";
import {
  type ModelChoice,
  ModelPicker,
} from "../../features/agents/ModelPicker";
import {
  OpenedConversation,
  useOpenTranscript,
} from "../../features/agents/OpenedConversation";
import type {
  AgentCreateProps,
  AgentViewProps,
} from "../../features/agents/service";
import { PanelSubview } from "../../features/panels/PanelSubview";

import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Combobox } from "../../shared/design-system/ui/Combobox";
import { Select } from "../../shared/design-system/ui/Select";
import { formatItemTimestamp } from "../../shared/datetime";
import { useClockFormat } from "../../shared/clock-preference";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { GooseLogoIcon } from "../../shared/design-system/icons";
import { validWorkspace } from "../codex/config";
import {
  type Config,
  DEFAULT_CONFIG,
  type GooseRuntime,
  config as readConfig,
} from "./runtime";
import {
  type GooseSetup,
  keyLabel,
  type Provider,
  type Providers,
  type Tested,
} from "./setup";
import {
  type GooseHistory,
  type Place,
  RECENT_LIMIT,
  TURN_LIMIT,
} from "./transcript";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const SCOPES = [
  {
    label: "",
    options: [
      { value: "thread", label: "One session per thread" },
      { value: "channel", label: "One session per channel" },
    ],
  },
];

type Choice = Readonly<{ provider: string; model: string }>;

type Read<T> = (
  | { status: "loading"; value?: T }
  | { status: "ready"; value: T }
  | { status: "error"; error: string; value?: T }
) & { scope?: string };

/** `read()` as it settles, read again when `key` changes or on `retry`. A
 * value already shown stays while it is read again, even when that read
 * fails, but only for the same `scope`; another scope's value is never shown. */
function useRead<T>(read: () => Promise<T>, key: string, scope = key) {
  const [state, setState] = useState<Read<T>>({ status: "loading" });
  const [round, setRound] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `read` follows `key`.
  useEffect(() => {
    let current = true;
    const kept = (prior: Read<T>) =>
      prior.value === undefined || prior.scope !== scope
        ? {}
        : { value: prior.value, scope };
    setState((prior) => ({ status: "loading", ...kept(prior) }));
    read().then(
      (value) => current && setState({ status: "ready", value, scope }),
      (error: unknown) =>
        current &&
        setState((prior) => ({
          status: "error",
          error: message(error),
          ...kept(prior),
        })),
    );
    return () => {
      current = false;
    };
  }, [key, round]);
  return [state, () => setRound((value) => value + 1)] as const;
}

/** A session the profile can show: one found for a place, or one goose
 * listed by its title. */
type Row = Readonly<{
  key: string;
  sessionId: string;
  title: string;
  channelId: string;
  root?: string;
  at?: number;
  /** The goose sessions saved for its place. */
  sessions?: readonly string[];
  /** Its channel's name, when the community lists it. */
  name?: string;
}>;
const placeOf = (key: string): Place => {
  const [channelId = key, root] = key.split("/");
  return { channelId, ...(root ? { root } : {}) };
};
/** Each conversation's row, from its saved sessions and any still running,
 * read by id with no search of goose, newest first; and the sessions started
 * outside any conversation, newest first. */
export function activityRows(
  saved: readonly { key: string; at: number; sessions: readonly string[] }[],
  live: readonly { key: string; sessionId?: string; at?: number }[],
  starts: readonly {
    id: string;
    at?: number;
    title?: string;
    conversation?: string | null;
  }[],
  label: (channelId: string) => { name?: string } | undefined = () => undefined,
) {
  const running = new Map(
    live.flatMap((session) =>
      session.sessionId ? [[session.key, session] as const] : [],
    ),
  );
  const byKey = new Map(
    saved.map(({ key, at, sessions }) => [key, { at, sessions }]),
  );
  for (const [key, session] of running)
    if (!byKey.has(key))
      byKey.set(key, { at: session.at ?? Date.now(), sessions: [] });
  const conversations = [...byKey]
    .sort(([, a], [, b]) => b.at - a.at)
    .map(([key, { at, sessions }]): Row => {
      const id = running.get(key)?.sessionId;
      const ids = [...new Set([...(id ? [id] : []), ...sessions])];
      const place = placeOf(key);
      return {
        key,
        sessionId: ids[0] ?? "",
        title: "",
        ...place,
        at,
        sessions: ids,
        ...label(place.channelId),
      };
    });
  // A session started outside any conversation, such as a watch's or
  // timer's turn, by what it saved as it started. One saved before that was
  // kept is never taken as one.
  const standalone = starts
    .flatMap(({ id, at, title = "", conversation }): Row[] =>
      conversation === null && at !== undefined
        ? [{ key: id, sessionId: id, title, at, channelId: "" }]
        : [],
    )
    .reverse()
    .slice(0, RECENT_LIMIT);
  return { conversations, standalone };
}
/** The recent rows: the opened conversation's channel first and the rest
 * newest first, each kind then kept to its own limit so neither crowds out
 * the other, and the opened conversation left out. */
export function recentRows(
  kinds: readonly (readonly Row[])[],
  here: string | undefined,
  channel: string | undefined,
) {
  const order = (a: Row, b: Row) =>
    Number(b.channelId === channel) - Number(a.channelId === channel) ||
    (b.at ?? 0) - (a.at ?? 0);
  return kinds
    .flatMap((rows) =>
      rows
        .filter((row) => row.key !== here)
        .sort(order)
        .slice(0, RECENT_LIMIT),
    )
    .sort(order);
}
/** Buzz titles a session `Agent · place · root`; the agent's name is the
 * profile's own. */
const titled = (name: string, title: string) =>
  title.startsWith(`${name} · `) ? title.slice(name.length + 3) : title;

export function createTabs({
  setup,
  runtime,
  history,
}: Readonly<{
  setup: GooseSetup;
  runtime: GooseRuntime;
  history: GooseHistory;
}>) {
  function DefaultControl({ onConfigure }: { onConfigure(): void }) {
    const state = useSyncExternalStore(setup.subscribe, setup.snapshot);
    const [listing, reload] = useRead(
      () => setup.providers(),
      `${state.readiness}:${!!state.blocking}`,
      "providers",
    );
    const current = listing.value?.defaults;
    const id = current?.provider ?? "";
    const [models, reloadModels] = useRead(
      () => (id ? setup.models(id) : Promise.resolve([] as ModelChoice[])),
      `${id}:${state.readiness}:${!!state.blocking}`,
      id,
    );
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    return (
      <>
        <ModelDiscoveryRecovery
          error={models.status === "error" ? models.error : undefined}
          loading={models.status === "loading"}
          // Shown only when ready, so its provider is set up. A recheck could
          // settle on attention, and the host would unmount this, focus and all.
          retry={reloadModels}
        >
          <ModelPicker
            includeDefault={false}
            compact
            groupByFamily
            label="Goose default model"
            models={models.value ?? []}
            value={
              current?.model ||
              listing.value?.providers.find((item) => item.id === id)
                ?.defaultModel ||
              ""
            }
            modelLabelPrefixes={
              id.startsWith("databricks")
                ? ["databricks-", "goose-"]
                : undefined
            }
            defaultLabel="Provider default"
            disabled={!id}
            loading={models.status === "loading"}
            pending={saving || !!state.blocking}
            onConfigure={onConfigure}
            onChange={(model) => {
              setSaving(true);
              void setup
                .saveDefaults({ provider: id, model })
                .then(
                  () => {
                    setError("");
                    reload();
                  },
                  (reason) => setError(String(reason)),
                )
                .finally(() => setSaving(false));
            }}
          />
        </ModelDiscoveryRecovery>
        {error && <span role="alert">{error}</span>}
      </>
    );
  }

  function ProviderDialogBody({ onClose }: { onClose(): void }) {
    const [listing, reload] = useRead(() => setup.providers(), "defaults");
    const [draft, setDraft] = useState<Choice>();
    const state = useSyncExternalStore(setup.subscribe, setup.snapshot);
    const [keys, setKeys] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const value = draft ?? {
      provider: listing.value?.defaults.provider ?? "",
      model: listing.value?.defaults.model ?? "",
    };
    return (
      <div className="grid gap-4">
        {listing.status === "error" ? (
          <>
            <p role="alert">{listing.error}</p>
            <p className="m-0 text-body-sm">
              Run <code>goose configure</code> to set up Goose.
            </p>
            <Button
              onClick={() => {
                void setup.check().then(reload);
              }}
            >
              Try again
            </Button>
          </>
        ) : listing.value ? (
          <ProviderFields
            deviceDefaults
            value={value}
            onChange={(next) => {
              if (next.provider !== value.provider) setKeys({});
              setDraft(next);
            }}
            keyDraft={{ value: keys, onChange: setKeys }}
            disabled={!!state.blocking || saving}
          />
        ) : (
          <p role="status">Loading Goose defaults…</p>
        )}
        {error && <p role="alert">{error}</p>}
        <ProviderDialogActions>
          <Button disabled={!!state.blocking || saving} onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            disabled={
              !listing.value || !value.provider || !!state.blocking || saving
            }
            loading={!!state.blocking || saving}
            onClick={async () => {
              setError("");
              setSaving(true);
              try {
                const entered = Object.fromEntries(
                  Object.entries(keys).filter(([, text]) => text.trim()),
                );
                await setup.saveDefaults(value, entered);
                onClose();
              } catch (reason) {
                setError(message(reason));
              } finally {
                setSaving(false);
              }
            }}
          >
            Save defaults
          </Button>
        </ProviderDialogActions>
      </div>
    );
  }

  /** The provider, its key and its model. */
  function ProviderFields({
    value,
    onChange,
    disabled = false,
    deviceDefaults = false,
    hideModel = deviceDefaults,
    keyDraft,
    rows = false,
    revision = 0,
  }: Readonly<{
    deviceDefaults?: boolean;
    hideModel?: boolean;
    keyDraft?: {
      value: Record<string, string>;
      onChange(value: Record<string, string>): void;
    };
    value: Choice;
    onChange(value: Choice): void;
    disabled?: boolean;
    rows?: boolean;
    revision?: number;
  }>) {
    const [listing, reload] = useRead(
      () => setup.providers(),
      `providers:${revision}`,
      "providers",
    );
    // A new key or host can offer other models, so each save reads them again.
    const [saves, setSaves] = useState(0);
    const [providerSearch, setProviderSearch] = useState("");
    const providers: Providers | undefined = listing.value;
    const fallback = providers?.defaults.provider;
    const id = value.provider || (deviceDefaults ? "" : fallback) || "";
    const provider = providers?.providers.find((item) => item.id === id);
    const [models] = useRead(
      () =>
        provider?.configured
          ? setup.models(id)
          : Promise.resolve([] as ModelChoice[]),
      `${id}:${provider?.configured ?? false}:${saves}:${revision}`,
      id,
    );
    const named = (key: string | undefined) =>
      providers?.providers.find((item) => item.id === key)?.name ?? key;
    const modelDefault = value.provider
      ? provider?.defaultModel
      : (providers?.defaults.model ?? provider?.defaultModel);
    const providerChoices = [
      ...(!deviceDefaults
        ? [
            {
              id: "",
              name: fallback
                ? `From goose config (${named(fallback)})`
                : "From goose config",
            },
          ]
        : []),
      ...(providers?.providers ?? []).map(({ id, name }) => ({ id, name })),
    ];
    return (
      <>
        {rows ? (
          <Select
            label="Provider"
            variant={rows ? "preference" : "field"}
            value={value.provider}
            {...(rows && !value.provider && fallback
              ? { valueLabel: named(fallback) }
              : {})}
            disabled={disabled || !providers}
            {...(listing.status === "error"
              ? { error: listing.error }
              : listing.status === "loading" && !providers
                ? { description: "Loading goose's providers…" }
                : rows && provider && !provider.configured
                  ? {
                      description: `Set up ${provider.name} on the Settings tab.`,
                    }
                  : {})}
            groups={[
              {
                label: "",
                options: [
                  {
                    value: "",
                    label: fallback
                      ? `From goose config (${named(fallback)})`
                      : "From goose config",
                  },
                  ...(providers?.providers ?? []).map((item) => ({
                    value: item.id,
                    label: item.name,
                  })),
                ],
              },
            ]}
            onValueChange={(provider) => onChange({ provider, model: "" })}
          />
        ) : (
          <Combobox.Root
            items={providerChoices}
            inputValue={providerSearch}
            onInputValueChange={setProviderSearch}
            onOpenChange={(open) => {
              if (open) setProviderSearch("");
            }}
            value={
              providerChoices.find((item) => item.id === value.provider) ?? null
            }
            itemToStringLabel={(item) => item.name}
            itemToStringValue={(item) => item.id}
            disabled={disabled || !providers}
            autoHighlight
            onValueChange={(item) => {
              if (item) onChange({ provider: item.id, model: "" });
            }}
          >
            <Combobox.Trigger
              label="Provider"
              disabled={disabled || !providers}
              {...(listing.status === "error" ? { error: listing.error } : {})}
            >
              {providerChoices.find((item) => item.id === value.provider)
                ?.name ?? "Choose a provider"}
            </Combobox.Trigger>
            <Combobox.Popup search empty="No matching providers.">
              <Combobox.List>
                {(item: { id: string; name: string }) => (
                  <Combobox.Item key={item.id} value={item}>
                    {item.name}
                  </Combobox.Item>
                )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Root>
        )}
        {listing.status === "error" && (
          <div>
            <Button onClick={reload}>Try again</Button>
          </div>
        )}
        {!rows && provider && (
          <ProviderKeys
            key={provider.id}
            provider={provider}
            keyDraft={keyDraft}
            disabled={disabled}
            onSaved={() => {
              reload();
              setSaves((count) => count + 1);
            }}
          />
        )}
        {/* The profile keeps the row, so an unready provider says why. */}
        {!hideModel && provider && (provider.configured || rows) && (
          <ModelPicker
            key={`models:${id}`}
            groupByFamily
            modelLabelPrefixes={
              id.startsWith("databricks")
                ? ["databricks-", "goose-"]
                : undefined
            }
            label="Model"
            allowCustomModel
            models={models.value ?? []}
            loading={models.status === "loading"}
            value={value.model}
            defaultLabel={modelDefault || "Provider model"}
            {...(!provider.configured
              ? { description: `Available once ${provider.name} is set up.` }
              : models.status === "error"
                ? { description: `Could not list models: ${models.error}` }
                : {})}
            disabled={disabled || !provider.configured}
            onChange={(model) => onChange({ ...value, model })}
          />
        )}
      </>
    );
  }

  /** The agent's provider's key, and a test that it answers. */
  function ProviderSetup({
    choice,
    onSaved,
  }: Readonly<{ choice: Choice; onSaved(): void }>) {
    const [listing, reload] = useRead(() => setup.providers(), "providers");
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
          <ProviderKeys
            key={provider.id}
            provider={provider}
            disabled={false}
            onSaved={() => {
              reload();
              onSaved();
            }}
          />
        )}
        <TestConnection choice={choice} disabled={false} />
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
            setResult({ key, tested: await setup.test(choice) });
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

  /** The thinking level turns run on: goose's default, or one goose offers
   * for the provider and model. */
  function ThinkingField({
    revision = 0,
    choice,
    value,
    compact = false,
    disabled = false,
    onChange,
  }: Readonly<{
    choice: Choice;
    revision?: number;
    value: string;
    /** A trailing choice in a host's row, as Create agent places it. */
    compact?: boolean;
    disabled?: boolean;
    onChange(effort: string): void;
  }>) {
    const [efforts, retry] = useRead(
      () => setup.efforts(choice),
      `${choice.provider}\u0000${choice.model.trim()}:${revision}`,
    );
    const failed =
      efforts.status === "error"
        ? `Could not read goose's levels: ${efforts.error}`
        : undefined;
    const levels = efforts.value?.levels ?? [];
    const named = (level: string) =>
      level.charAt(0).toUpperCase() + level.slice(1);
    // goose reports "off" both for a level set to off and for none set. With
    // none set it often sends no level, leaving the model on its own default,
    // so "off" cannot name what turns run on; any other level can.
    const current = efforts.value?.current;
    const fallback = current && current !== "off" ? named(current) : undefined;
    const select = (
      <Select
        label="Thinking"
        variant={compact ? "compact" : "preference"}
        {...(compact && { align: "end" as const })}
        value={value}
        {...(!value
          ? {
              valueLabel: fallback ?? "Default",
              ...(compact && fallback ? { valueSuffix: " · Default" } : {}),
            }
          : {})}
        disabled={disabled}
        {...(failed && !compact ? { description: failed } : {})}
        groups={[
          {
            label: "",
            options: [
              {
                value: "",
                label: fallback ? `${fallback} · Default` : "Default",
              },
              // A saved level the model does not offer, or not yet read.
              ...(value && !levels.includes(value)
                ? [
                    {
                      value,
                      label:
                        efforts.status === "ready"
                          ? `${named(value)} (unavailable)`
                          : named(value),
                    },
                  ]
                : []),
              ...levels.map((level) => ({ value: level, label: named(level) })),
            ],
          },
        ]}
        onValueChange={onChange}
      />
    );
    // A compact choice shows no description, so a failed read says so beside
    // it and offers another try, as the model field does.
    return compact ? (
      <ModelDiscoveryRecovery
        error={failed}
        loading={efforts.status === "loading"}
        retry={retry}
        disabled={disabled}
      >
        {select}
      </ModelDiscoveryRecovery>
    ) : (
      select
    );
  }

  /** A provider's key and other fields, saved into goose's config. One that
   * signs in through goose is set up there. */
  function ProviderKeys({
    provider,
    disabled,
    onSaved,
    keyDraft,
  }: Readonly<{
    provider: Provider;
    disabled: boolean;
    onSaved(): void;
    keyDraft?:
      | {
          value: Record<string, string>;
          onChange(value: Record<string, string>): void;
        }
      | undefined;
  }>) {
    const [saved, reread] = useRead(
      () => setup.saved(provider.id),
      provider.id,
    );
    const [localDraft, setLocalDraft] = useState<Record<string, string>>({});
    const draft = keyDraft?.value ?? localDraft;
    const setDraft = keyDraft?.onChange ?? setLocalDraft;
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const entered = Object.fromEntries(
      Object.entries(draft).filter(([, text]) => text.trim()),
    );
    const ready = !disabled && !saving && Object.keys(entered).length > 0;
    const submit = async () => {
      setSaving(true);
      setError("");
      try {
        await setup.save(provider.id, entered);
        setDraft({});
        reread();
        onSaved();
      } catch (reason) {
        setError(message(reason));
      } finally {
        setSaving(false);
      }
    };
    return (
      <>
        {provider.signsIn && !provider.configured && (
          <p className="m-0 text-body-sm">
            {provider.name} signs in through goose. Run{" "}
            <code>goose configure</code> to sign in.
          </p>
        )}
        {provider.keys.map((key) => {
          const isSet = saved.value?.has(key.name);
          return (
            <Field
              key={key.name}
              label={
                key.required
                  ? keyLabel(key.name)
                  : `${keyLabel(key.name)} (optional)`
              }
              description={
                isSet
                  ? undefined
                  : key.default
                    ? `Default: ${key.default}`
                    : key.secret
                      ? provider.steps.join(" · ") || undefined
                      : undefined
              }
            >
              <Input
                type={key.secret ? "password" : "text"}
                autoComplete="off"
                value={draft[key.name] ?? ""}
                disabled={disabled || saving}
                placeholder={
                  isSet
                    ? "Saved in goose. Enter a new value to replace it."
                    : (key.default ?? undefined)
                }
                onValueChange={(text) =>
                  setDraft({ ...draft, [key.name]: text })
                }
                // Enter saves the key, not the agent settings around it.
                onKeyDown={(event) => {
                  if (keyDraft || event.key !== "Enter") return;
                  event.preventDefault();
                  if (ready) void submit();
                }}
              />
            </Field>
          );
        })}
        {!keyDraft && provider.keys.length > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={!ready} loading={saving} onClick={submit}>
              Save to goose
            </Button>
            {error && (
              <p role="alert" className="buzz-field-error m-0">
                {error}
              </p>
            )}
          </div>
        )}
      </>
    );
  }

  /** One session's turns, or a place's across its sessions, kept current
   * while goose works. */
  function TranscriptView({
    agent,
    row,
    working,
  }: {
    agent: AgentViewProps<Config>["agent"];
    row: Row;
    working?: string | undefined;
  }) {
    const workspace = readConfig(agent.config).workspace;
    // Read again when the conversation saves or opens another session.
    const ids = [row.sessionId, ...(row.sessions ?? [])].join(" ");
    /** With `reuse`, sessions that aren't working keep their last export. */
    const read = async (signal: AbortSignal, reuse = false) => {
      const transcript = await history.transcript(
        {
          agent: agent.key,
          workspace,
          ...(row.sessionId ? { sessionId: row.sessionId } : {}),
          ...(row.sessions ? { sessions: row.sessions } : {}),
          ...(row.channelId ? { place: placeOf(row.key) } : {}),
          ...(working ? { working } : {}),
        },
        signal,
        (pubkey) => runtime.name(agent.key, pubkey),
        reuse,
      );
      return (
        transcript && {
          ...transcript,
          turns: runtime.prompts(agent.key).shown(transcript.turns),
        }
      );
    };
    return (
      <TranscriptPanel
        agent={agent}
        read={read}
        // Automatic reads while working; open, Refresh and a turn starting
        // or ending export every session.
        readLatest={async (signal) => (await read(signal, true))?.turns}
        readKey={`${row.key}\u0000${workspace}`}
        readAgain={ids}
        working={Boolean(working)}
        reading="Reading the goose session…"
        failed="Could not read the goose session"
        missing={
          <p className="m-0 text-body-sm text-subtle">
            goose has no session for this conversation on this computer. It may
            have been deleted, or it ran in a different workspace.
          </p>
        }
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

  /** The agent's sessions: the one it was opened from, recent ones, and their
   * transcripts. */
  function ActivityTab({
    agent,
    conversation,
    initialTranscript,
    close,
  }: {
    agent: AgentViewProps<Config>["agent"];
    conversation?: AgentViewProps<Config>["conversation"];
    initialTranscript?: AgentViewProps<Config>["initialTranscript"];
    close?: AgentViewProps<Config>["close"];
  }) {
    useClockFormat();
    const live = useSyncExternalStore(
      (listener) => runtime.subscribe(listener),
      () => runtime.sessions(agent.key),
    );
    // Each read again only when a session changes.
    // biome-ignore lint/correctness/useExhaustiveDependencies: a session change can save one.
    const saved = useMemo(
      () => runtime.conversations(agent.key),
      [agent.key, live],
    );
    // biome-ignore lint/correctness/useExhaustiveDependencies: a session change can save one.
    const starts = useMemo(
      () => runtime.prompts(agent.key).sessions(),
      [agent.key, live],
    );
    const { conversations, standalone } = activityRows(
      saved,
      live,
      starts,
      (id) => runtime.channelLabel(agent.key, id),
    );
    // The opened conversation's session: a thread's saved or live one, else
    // its channel's, read again each render so a first save is picked up.
    // With neither, its transcript finds the place's sessions by their goose
    // tags, in the place the agent keeps its sessions.
    const match = (channelId: string, root?: string) =>
      conversations.find(
        (row) =>
          row.sessionId && row.channelId === channelId && row.root === root,
      );
    const here =
      conversation &&
      (() => {
        const { channelId, rootId } = conversation;
        const found = (rootId && match(channelId, rootId)) || match(channelId);
        if (found) return found;
        const root =
          readConfig(agent.config).scope === "channel" ? undefined : rootId;
        return {
          key: root ? `${channelId}/${root}` : channelId,
          sessionId: "",
          title: "",
          channelId,
          ...(root && { root }),
          ...runtime.channelLabel(agent.key, channelId),
        } satisfies Row;
      })();
    const busy = (sessionId: string) =>
      live.find((session) => session.sessionId === sessionId)?.busy;
    const status = (sessionId: string) => {
      const working = busy(sessionId);
      return working === undefined ? undefined : working ? "Working" : "Idle";
    };
    const label = (row: Row) =>
      row.title
        ? titled(agent.name, row.title)
        : `${row.name || row.channelId.slice(0, 8)} · ${row.root ? `thread ${row.root.slice(0, 8)}` : "channel"}`;
    const { open, show, back } = useOpenTranscript(
      conversation,
      label,
      initialTranscript && { initial: here, ...initialTranscript },
      close,
    );
    const rows = recentRows(
      [conversations, standalone],
      here?.key,
      conversation?.channelId,
    );
    // The open transcript follows its conversation's current sessions.
    const shown =
      open &&
      ([...conversations, ...standalone, ...(here ? [here] : [])].find(
        (row) => row.key === open.key,
      ) ??
        open);
    return (
      <div className={activityStyles.activity}>
        {conversation && (
          <OpenedConversation
            conversation={conversation}
            harness="goose"
            session={here}
            status={here && status(here.sessionId)}
            onView={() => here && show(here)}
          />
        )}
        <section className={activityStyles.section}>
          <InlineHeader title="Recent sessions" />
          {rows.length ? (
            <SettingsGroup layout="form">
              <ul className={activityStyles.list}>
                {rows.map((row) => (
                  <li key={row.key} className={activityStyles.entry}>
                    <div className={activityStyles.row}>
                      <span className={activityStyles.copy}>
                        <span
                          className="block truncate text-label-sm"
                          title={label(row)}
                        >
                          {label(row)}
                        </span>
                        <span className="block text-body-sm text-subtle">
                          {[
                            status(row.sessionId),
                            row.at &&
                              formatItemTimestamp(row.at / 1000, {
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
                        aria-label={`View transcript: ${label(row)}`}
                        onClick={() => show(row)}
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
              None. A conversation's session starts when the agent is mentioned.
            </p>
          )}
        </section>
        {shown && (
          <PanelSubview
            title={label(shown)}
            backLabel="Back to profile"
            onBack={back}
          >
            <TranscriptView
              key={shown.key}
              agent={agent}
              row={shown}
              working={busy(shown.sessionId) ? shown.sessionId : undefined}
            />
          </PanelSubview>
        )}
      </div>
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
    onChange,
    onClose,
  }: Readonly<{
    value: Choice;
    onChange(choice: Choice): void;
    onClose(): void;
  }>) {
    const [draft, setDraft] = useState<Choice>({
      provider: value.provider,
      model: value.model,
    });
    const [keys, setKeys] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !saving) onClose();
        }}
        height="stable"
        title="Edit configuration"
        actions={
          <>
            <Button disabled={saving} onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="prominent"
              loading={saving}
              onClick={async () => {
                setSaving(true);
                setError("");
                try {
                  const listing = await setup.providers();
                  const provider = draft.provider || listing.defaults.provider;
                  const entered = Object.fromEntries(
                    Object.entries(keys).filter(([, text]) => text.trim()),
                  );
                  if (provider && Object.keys(entered).length)
                    await setup.save(provider, entered);
                  onChange(draft);
                } catch (reason) {
                  setError(message(reason));
                } finally {
                  setSaving(false);
                }
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <ProviderFields
            hideModel
            value={draft}
            disabled={saving}
            keyDraft={{ value: keys, onChange: setKeys }}
            onChange={(choice) => {
              if (choice.provider !== draft.provider) setKeys({});
              setDraft(choice);
            }}
          />
          {error && <p role="alert">{error}</p>}
        </div>
      </Dialog>
    );
  }

  function CreateModel({
    config,
    onChange,
    onReadyChange,
    disabled,
    modelAppearance,
    showEffort = true,
  }: AgentCreateProps<Config>) {
    const current = readConfig(config);
    const [open, setOpen] = useState(false);
    const [listing, reload] = useRead(() => setup.providers(), "providers");
    const provider = current.provider || listing.value?.defaults.provider || "";
    const [models, reloadModels] = useRead(
      () => (provider ? setup.models(provider) : Promise.resolve([])),
      provider,
    );
    const refresh = () => {
      reload();
      reloadModels();
    };
    const fallback =
      (current.provider
        ? listing.value?.providers.find((item) => item.id === provider)
            ?.defaultModel
        : listing.value?.defaults.model) || "";
    const selectedModel = current.model || fallback;
    const ready =
      listing.status === "ready" &&
      !!listing.value.providers.find((item) => item.id === provider) &&
      !!selectedModel.trim();
    useEffect(() => onReadyChange?.(ready), [onReadyChange, ready]);
    const [thinking] = useRead(
      () =>
        provider && selectedModel
          ? setup.efforts({ provider, model: selectedModel })
          : Promise.resolve({ current: "", levels: [] }),
      `${provider}\u0000${selectedModel}`,
    );
    const choices = (models.value ?? []).map((model) => ({
      ...model,
      effortScope: provider,
      loadEfforts: async () => {
        const offered = await setup.efforts({ provider, model: model.id });
        if (!offered.levels.length) return [];
        return [
          { id: "", label: "Automatic" },
          ...offered.levels.map((id) => ({
            id,
            label: id.charAt(0).toUpperCase() + id.slice(1),
          })),
        ];
      },
    }));
    return (
      <>
        <ModelDiscoveryRecovery
          error={models.status === "error" ? models.error : undefined}
          loading={models.status === "loading"}
          // `goose configure` can set it up meanwhile, on another default
          // model. The check starts a fresh read at once, which these share.
          retry={() => {
            void setup.check();
            refresh();
          }}
          disabled={disabled}
        >
          <ModelPicker
            compact
            groupByFamily
            includeDefault={false}
            resetLabel="Use Goose default"
            allowCustomModel
            label="Goose model"
            appearance={modelAppearance ?? "outlined"}
            // A card names its harness before the model, as Pi's does.
            {...(modelAppearance === "glass-ghost" && {
              leading: <GooseLogoIcon size={18} />,
            })}
            models={choices}
            value={current.model}
            defaultModel={fallback}
            defaultLabel={fallback || "Choose model"}
            effort={current.effort}
            // A card's chip keeps its room for the model name; its menu
            // still shows and sets the level.
            effortLabel={
              showEffort &&
              modelAppearance !== "glass-ghost" &&
              thinking.value?.levels.length
                ? current.effort
                  ? current.effort.charAt(0).toUpperCase() +
                    current.effort.slice(1)
                  : "Automatic"
                : undefined
            }
            modelLabelPrefixes={
              provider.startsWith("databricks")
                ? ["databricks-", "goose-"]
                : undefined
            }
            disabled={disabled}
            loading={models.status === "loading"}
            onConfigure={() => setOpen(true)}
            onChange={(model) => onChange({ ...current, model, effort: "" })}
            onEffortChange={
              showEffort
                ? (model, effort) => onChange({ ...current, model, effort })
                : undefined
            }
          />
        </ModelDiscoveryRecovery>
        {open && (
          <ChooseDialog
            value={current}
            onClose={() => setOpen(false)}
            onChange={(choice) => {
              onChange({
                ...current,
                ...choice,
                effort:
                  choice.provider === current.provider ? current.effort : "",
              });
              refresh();
              setOpen(false);
            }}
          />
        )}
      </>
    );
  }

  /** Create agent's Thinking row: goose's levels for the chosen model. */
  function CreateThinking({
    config,
    onChange,
    disabled,
  }: AgentCreateProps<Config>) {
    const current = readConfig(config);
    // A setup check, such as the model field's Try again, clears goose's
    // levels; read them again once it settles.
    const checking =
      useSyncExternalStore(setup.subscribe, setup.snapshot).readiness ===
      "checking";
    const wasChecking = useRef(checking);
    const [checks, setChecks] = useState(0);
    useEffect(() => {
      if (wasChecking.current && !checking) setChecks((count) => count + 1);
      wasChecking.current = checking;
    }, [checking]);
    return (
      <ThinkingField
        compact
        revision={checks}
        choice={current}
        value={current.effort}
        disabled={disabled}
        onChange={(effort) => onChange({ ...current, effort })}
      />
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
    const [providerRevision, setProviderRevision] = useState(0);
    const saved = readConfig(agent.config);
    const [draft, setDraft] = useState(saved);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const saveErrorRef = useRef<HTMLParagraphElement>(null);
    useEffect(() => {
      if (error) saveErrorRef.current?.focus();
    }, [error]);
    const configChanged = JSON.stringify(draft) !== JSON.stringify(saved);
    const changed = configChanged || Boolean(settingsHost?.pendingSave);
    const submit = async () => {
      setSaving(true);
      setError("");
      try {
        const workspace = draft.workspace.trim() || DEFAULT_CONFIG.workspace;
        if (!validWorkspace(workspace))
          throw new Error("Enter an absolute or ~/… workspace path.");
        await save({ ...draft, model: draft.model.trim(), workspace });
      } catch (reason) {
        setError(message(reason));
      } finally {
        setSaving(false);
      }
    };
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
                revision={providerRevision}
                rows
                value={draft}
                onChange={(choice) => setDraft({ ...draft, ...choice })}
              />
              <ThinkingField
                revision={providerRevision}
                choice={draft}
                value={draft.effort}
                onChange={(effort) => setDraft({ ...draft, effort })}
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
            <ProviderSetup
              choice={draft}
              onSaved={() => setProviderRevision((value) => value + 1)}
            />
            <Field
              label="Workspace"
              description="The folder goose works in. Use ~/ for your home folder."
            >
              <Input
                value={draft.workspace}
                onValueChange={(workspace) => setDraft({ ...draft, workspace })}
              />
            </Field>
            <Select
              label="Sessions"
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
        <AgentSaveButton form={form} saving={saving} disabled={!changed} />
        {settingsSection !== "identity" && settingsContent}
      </form>
    );
  }

  return {
    ProviderDialogBody,
    DefaultControl,
    Create,
    CreateModel,
    CreateThinking,
    SettingsTab,
    ActivityTab,
  };
}
