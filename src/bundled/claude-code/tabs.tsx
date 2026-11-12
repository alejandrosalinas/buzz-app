import { ModelDiscoveryRecovery } from "../../features/agents/ModelDiscoveryRecovery";
import activityStyles from "../../features/agents/ActivityLayout.module.css";
import { formatItemTimestamp } from "../../shared/datetime";
import { useClockFormat } from "../../shared/clock-preference";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { AgentSaveButton } from "../../features/agents/AgentSaveButton";
import { ProviderDialogActions } from "../../features/agents/ProviderDialogActions";
// Claude's provider controls, New agent choices, and agent settings.
import {
  type ReactNode,
  useEffect,
  useRef,
  useId,
  useState,
  useSyncExternalStore,
} from "react";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { TranscriptPanel } from "../../features/agents/TranscriptPanel";
import { AgentInstructions } from "../../features/agents/AgentInstructions";
import { CreateModelChoices } from "../../features/agents/CreateModelChoices";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { Accordion } from "../../shared/design-system/ui/Accordion";
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
import { CircleNotchIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import {
  type ClaudeRuntime,
  type Config,
  config as readConfig,
  effortChoices,
  effortLabel,
  effortLevels,
  type SavedConversation,
  modelName as resolvedModelName,
} from "./runtime";
import { Missing, SignedIn, SignIn } from "./auth";
import type { ClaudeModel } from "./claude";
import type { ClaudeSetup } from "./setup";
import type { ClaudeDefaults } from "./defaults";
import {
  settingLabels,
  useSettingsDraft,
  type SettingGroup,
} from "./settings-draft";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const label = ({ channelId, name, root }: SavedConversation) =>
  `${name || channelId.slice(0, 8)} · ${root ? `thread ${root.slice(0, 8)}` : "channel"}`;
const CONVERSATION_LIMIT = 30;

const options = (choices: readonly (readonly [string, string])[]) => [
  { label: "", options: choices.map(([value, label]) => ({ value, label })) },
];
const modelOptionCopy = (model: ClaudeModel) => {
  const label = model.resolvedModel
    ? resolvedModelName(model.resolvedModel)
    : (model.displayName ?? model.value);
  const descriptionPrefix = `${label} · `;
  const description = model.description?.startsWith(descriptionPrefix)
    ? model.description.slice(descriptionPrefix.length)
    : model.description;

  return { label, description };
};
/** The models Claude lists; `default` is the picker's own default row. */
const modelChoices = (models: readonly ClaudeModel[]) =>
  models
    .filter((model) => model.value !== "default")
    .map((model) => ({ id: model.value, ...modelOptionCopy(model) }));
const modelName = (model: string, models: readonly ClaudeModel[]) =>
  modelChoices(models).find((choice) => choice.id === model)?.label ??
  resolvedModelName(model);
const providerDefaultModel = (
  model: string,
  models: readonly ClaudeModel[],
) => {
  if (model)
    return (
      models.find(
        (candidate) =>
          candidate.value !== "default" &&
          (candidate.value === model || candidate.resolvedModel === model),
      )?.value ?? model
    );
  const resolved = models.find(
    (candidate) => candidate.value === "default",
  )?.resolvedModel;
  return resolved
    ? models.find(
        (candidate) =>
          candidate.value !== "default" &&
          (candidate.resolvedModel === resolved ||
            candidate.value === resolved),
      )?.value
    : undefined;
};
const providerDefaultLabel = (
  model: string,
  models: readonly ClaudeModel[],
) => {
  if (model) return modelName(model, models);
  const native = models.find((candidate) => candidate.value === "default");
  return native?.resolvedModel
    ? resolvedModelName(native.resolvedModel)
    : "Model unavailable";
};
/** The effort levels of the model a run uses, `""` being Claude's default;
 * a model Claude does not list may run at any level a listed one has. */
const effortsFor = (model: string, models: readonly ClaudeModel[]) => {
  const id = model || "default";
  const listed = models.find(
    (candidate) => candidate.value === id || candidate.resolvedModel === id,
  );
  return effortChoices(
    listed ? effortLevels(listed) : models.flatMap(effortLevels),
  );
};
/** New agents only offer levels Claude lists for the effective model. */
const createEffortsFor = (model: string, models: readonly ClaudeModel[]) => {
  const id = model || "default";
  const listed = models.find(
    (candidate) => candidate.value === id || candidate.resolvedModel === id,
  );
  return effortChoices(listed ? effortLevels(listed) : []);
};
const thinkingOptions = (
  efforts: ReturnType<typeof effortChoices>,
  models: readonly ClaudeModel[],
  effort: string,
) => {
  return [
    { value: "", label: "Automatic · Default" },
    ...(effort && !efforts.some((level) => level.id === effort)
      ? [
          {
            value: effort,
            label: models.length
              ? `${effortLabel(effort)} (unavailable)`
              : effortLabel(effort),
          },
        ]
      : []),
    ...efforts.map(({ id, label }) => ({ value: id, label })),
  ];
};
const SCOPES = options([
  ["thread", "One session per thread"],
  ["channel", "One session per channel"],
]);

/** A model field's stand-in while Claude cannot run. `inline` asks for
 * sign-in in place; otherwise, as in a row, a button opens setup. */
function ClaudeSignIn({
  setup,
  disabled,
  inline = false,
}: {
  setup: ClaudeSetup;
  disabled: boolean;
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const state = useSyncExternalStore(setup.subscribe, setup.snapshot);
  const missing = state.status?.state === "missing";
  const outdated = state.status?.state === "outdated";
  const signedOut =
    state.status?.state === "signed-out" && state.running !== "install";
  if (signedOut && inline)
    return <SignIn setup={setup} disabled={disabled} variant="compact" />;
  return (
    <>
      <Button
        size="sm"
        variant="prominent"
        disabled={disabled || !!state.running}
        onClick={() => {
          if (setup.snapshot().running) return;
          setOpen(true);
          if (missing || outdated) void setup.run("install");
        }}
      >
        {missing
          ? "Install integration"
          : outdated
            ? "Update Claude"
            : signedOut
              ? setup.auth.attentionLabel
              : "Set up"}
      </Button>
      <Dialog
        open={open}
        title={missing || outdated ? "Claude integration" : "Set up Claude"}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) void setup.cancel();
        }}
      >
        <ClaudeSetupPanel
          setup={setup}
          disabled={disabled}
          variant="compact"
          onSaved={() => setOpen(false)}
        />
      </Dialog>
    </>
  );
}

function ClaudeSetupPanel({
  setup,
  disabled = false,
  variant = "full",
  onSaved,
}: {
  setup: ClaudeSetup;
  disabled?: boolean;
  variant?: "full" | "compact";
  /** Follows saved credentials, so the panel's dialog can close. */
  onSaved?: (() => void) | undefined;
}) {
  const state = useSyncExternalStore(setup.subscribe, setup.snapshot);
  useEffect(() => {
    if (!setup.snapshot().status) void setup.check();
  }, [setup]);
  const status = state.status;
  const signingIn =
    state.running === "sign-in" ||
    (status?.state === "signed-out" && !state.running);
  const line =
    !status || state.checking
      ? "Checking Claude…"
      : status.state === "missing"
        ? "The Claude integration isn't installed yet."
        : status.state === "outdated"
          ? `Claude ${status.version} is older than Buzz needs.`
          : status.state === "signed-out"
            ? `Claude ${status.version} ${setup.auth.needs}.`
            : status.state === "ready"
              ? `Claude ${status.version} is ready${status.account ? ` (${status.account})` : ""}.`
              : status.message;
  // One button per slot, so focus stays put as Install becomes Check again.
  const action =
    status?.state === "missing"
      ? ({ step: "install", label: "Install integration" } as const)
      : status?.state === "outdated"
        ? ({ step: "install", label: "Update Claude" } as const)
        : undefined;
  return (
    <section className="grid gap-2">
      {!(variant === "compact" && status?.state === "signed-out") && (
        <p role="status" className="m-0">
          {line}
        </p>
      )}
      {signingIn && (
        <SignIn
          setup={setup}
          disabled={disabled}
          variant={variant}
          onSaved={onSaved}
        />
      )}
      <div className="flex flex-wrap gap-2">
        {action && (
          <Button
            variant="prominent"
            size={variant === "compact" ? "sm" : "md"}
            loading={state.running === action.step}
            disabled={
              disabled || (!!state.running && state.running !== action.step)
            }
            onClick={() => void setup.run(action.step)}
          >
            {action.label}
          </Button>
        )}
        {/* A running sign-in has its own controls. */}
        {(variant !== "compact" ||
          status?.state !== "signed-out" ||
          state.running) &&
          state.running !== "sign-in" && (
            <Button
              variant="ghost"
              disabled={!state.running && state.checking}
              focusableWhenDisabled
              onClick={() =>
                void (state.running ? setup.cancel() : setup.check(true))
              }
            >
              {state.running ? "Cancel" : "Check again"}
            </Button>
          )}
      </div>
      {status?.state === "missing" && (
        <p className="m-0 text-body-sm text-subtle">
          Downloads Buzz's own copy of Claude (about 250 MB) and keeps it on the
          latest release. Your own installation of Claude will be unaffected,
          and uses the same settings.
        </p>
      )}
      {state.output && (
        <Accordion
          items={[
            {
              value: "details",
              title: "Setup details",
              content: (
                <pre
                  role="log"
                  aria-label="Setup output"
                  className="m-0 max-h-60 overflow-auto whitespace-pre-wrap break-all text-caption"
                >
                  {state.output}
                </pre>
              ),
            },
          ]}
        />
      )}
    </section>
  );
}

export function createTabs({
  setup,
  defaults,
  runtime,
  openSetup,
}: Readonly<{
  setup: ClaudeSetup;
  defaults: ClaudeDefaults;
  runtime: ClaudeRuntime;
  /** Opens Claude's setup in Settings → Agent setup. */
  openSetup?: () => void;
}>) {
  /** Whether `agent` runs on an execution target; undefined while that is
   * being resolved, and for no agent. */
  function useRemote(agent: AgentViewProps<Config>["agent"] | undefined) {
    const key = agent?.key;
    const selection = JSON.stringify(agent?.executionBinding ?? null);
    const [state, setState] = useState<{
      agent: string;
      selection: string;
      remote?: boolean;
      error?: string;
    }>();
    useEffect(() => {
      if (!key) return;
      let current = true;
      void runtime.isRemote(key).then(
        (remote) => {
          if (current) setState({ agent: key, selection, remote });
        },
        (error) => {
          if (current)
            setState({ agent: key, selection, error: message(error) });
        },
      );
      return () => {
        current = false;
      };
    }, [key, selection]);
    return key && state?.agent === key && state.selection === selection
      ? state
      : undefined;
  }
  function useSetupCatalog(enabled = true) {
    const state = useSyncExternalStore(
      setup.subscribe,
      setup.snapshot,
      setup.snapshot,
    );
    useEffect(() => {
      if (enabled && !state.status && !state.checking) void setup.check();
    }, [enabled, state.status, state.checking]);
    // Once per change of readiness: a failed load waits for Try again.
    useEffect(() => {
      if (
        enabled &&
        !state.checking &&
        state.status?.state === "ready" &&
        state.models.length === 0
      )
        void setup.loadModels();
    }, [enabled, state.status, state.checking, state.models.length]);
    return enabled
      ? state
      : { ...state, models: [], modelsChecking: false, modelsError: "" };
  }

  function CreateModel({
    config,
    onChange,
    onReadyChange,
    ...props
  }: AgentCreateProps<Config>) {
    const current = readConfig(config);
    const state = useSetupCatalog();
    const providerDefaults = useSyncExternalStore(
      defaults.subscribe,
      defaults.snapshot,
    );
    const ready =
      state.status?.state === "ready" &&
      !state.running &&
      !state.modelsChecking &&
      !state.modelsError &&
      !!providerDefaultModel(
        current.model || providerDefaults.model,
        state.models,
      )?.trim();
    useEffect(() => onReadyChange?.(ready), [onReadyChange, ready]);
    if (!state.status)
      return (
        <span role="status" className="text-body-sm text-secondary">
          Checking sign-in…
        </span>
      );
    // A library card is one agent's: the key is added once, in Settings.
    if (
      props.modelAppearance === "glass-ghost" &&
      state.status.state === "signed-out" &&
      !state.running
    )
      return <Missing openSettings={openSetup} />;
    if (state.status.state !== "ready" || state.running)
      return (
        <ClaudeSignIn
          setup={setup}
          disabled={props.disabled}
          inline={props.modelAppearance === "inverted"}
        />
      );
    return (
      <CreateModelChoices
        {...props}
        models={modelChoices(state.models)}
        value={current.model}
        defaultModel={providerDefaultModel(
          providerDefaults.model,
          state.models,
        )}
        defaultLabel={providerDefaultLabel(
          providerDefaults.model,
          state.models,
        )}
        defaultDescription="Following the provider's model default"
        loading={state.modelsChecking}
        error={state.modelsError}
        retry={() => void setup.loadModels(true)}
        onChange={(model) => {
          const efforts = createEffortsFor(
            model || providerDefaults.model,
            state.models,
          );
          onChange({
            ...current,
            model,
            effort:
              state.models.length === 0 ||
              efforts.some((level) => level.id === current.effort)
                ? current.effort
                : "",
          });
        }}
      />
    );
  }

  function CreateThinking({
    agent,
    config,
    onChange,
    disabled,
  }: AgentCreateProps<Config>) {
    const current = readConfig(config);
    const { effort, model } = current;
    const state = useSetupCatalog();
    const providerDefaults = useSyncExternalStore(
      defaults.subscribe,
      defaults.snapshot,
    );
    useEffect(() => {
      if (
        agent ||
        disabled ||
        state.checking ||
        state.status?.state !== "ready" ||
        state.running ||
        state.modelsChecking ||
        state.modelsError ||
        !state.models.length ||
        !effort
      )
        return;
      const efforts = createEffortsFor(
        model || providerDefaults.model,
        state.models,
      );
      if (!efforts.some((level) => level.id === effort))
        onChange(readConfig({ ...config, effort: "" }));
    }, [
      agent,
      config,
      disabled,
      effort,
      model,
      onChange,
      providerDefaults.model,
      state.checking,
      state.models,
      state.modelsChecking,
      state.modelsError,
      state.running,
      state.status?.state,
    ]);
    const effortOptions = thinkingOptions(
      createEffortsFor(model || providerDefaults.model, state.models),
      state.models,
      current.effort,
    );
    return (
      <Select
        label="Thinking"
        valueLabel={current.effort ? undefined : "Automatic"}
        valueSuffix={current.effort ? undefined : " · Default"}
        variant="compact"
        value={current.effort}
        groups={[{ label: "", options: effortOptions }]}
        disabled={
          disabled ||
          state.status?.state !== "ready" ||
          Boolean(state.running) ||
          state.modelsChecking ||
          Boolean(state.modelsError) ||
          state.models.length === 0
        }
        onValueChange={(effort) => onChange({ ...current, effort })}
      />
    );
  }

  /** Whether a new or edited agent waits for this computer's credentials.
   * An agent being edited may run on an execution target, which brings its
   * own: only one that runs here needs them. One whose place can't be told
   * is taken to run here. */
  function useCredentials(agent: AgentCreateProps<Config>["agent"]) {
    const state = useSetupCatalog();
    const execution = useRemote(agent);
    const resolving = !!agent && !execution;
    const local = !agent || (!!execution && execution.remote !== true);
    const signedOut =
      local &&
      state.status?.state === "signed-out" &&
      state.running !== "install";
    return { state, resolving, signedOut };
  }

  /** Beside Harness while Claude has no credentials, as Builderlab's Sign in
   * is: opens Set up Claude. Credentials close it and say so; closing it
   * stops a sign-in it started. */
  function CreateAction({
    agent,
    disabled,
  }: {
    agent?: AgentCreateProps<Config>["agent"];
    disabled: boolean;
  }) {
    const { state, signedOut } = useCredentials(agent);
    const notify = useToastNotification();
    // Passive Back may have hidden the action while its provider kept working.
    const [open, setOpen] = useState(
      () => signedOut && state.running === "sign-in",
    );
    const openNow = useRef(open);
    openNow.current = open;
    const notifyNow = useRef(notify);
    notifyNow.current = notify;
    useEffect(() => {
      if (signedOut || !openNow.current) return;
      setOpen(false);
      notifyNow.current(
        "Claude is set up",
        "success",
        openSetup && { label: "Manage in Settings", onClick: openSetup },
      );
    }, [signedOut]);
    const signingIn = state.running === "sign-in";
    return (
      <>
        {signedOut && (
          <Button
            size="sm"
            variant="subtle"
            shape="capsule"
            disabled={disabled}
            aria-label={setup.auth.attentionLabel}
            title={setup.auth.attentionLabel}
            onClick={() => setOpen(true)}
          >
            {setup.auth.signIn ? "Sign in" : "Add key"}
          </Button>
        )}
        <Dialog
          open={open && signedOut}
          title="Set up Claude"
          actions={
            signingIn && (
              <Button variant="ghost" onClick={() => void setup.cancel()}>
                Cancel
              </Button>
            )
          }
          onOpenChange={(next) => {
            setOpen(next);
            if (!next && setup.snapshot().running === "sign-in")
              void setup.cancel();
          }}
        >
          <div className="grid gap-3">
            {/* A build that signs in interactively (`auth.signIn`) starts
             * it here, as Claude's Settings dialog does; a key's form saves
             * on its own. */}
            {setup.auth.signIn && !signingIn && (
              <div>
                <Button
                  size="sm"
                  variant="prominent"
                  disabled={disabled || !!state.running}
                  onClick={() => void setup.run("sign-in")}
                >
                  Sign in
                </Button>
              </div>
            )}
            <SignIn setup={setup} disabled={disabled} />
          </div>
        </Dialog>
      </>
    );
  }

  /** New agent's Harness, Model and Thinking. While Claude has no
   * credentials, Model and Thinking wait, disabled, for CreateAction's
   * setup beside Harness, and so does the agent. */
  function CreateConfiguration({
    harnessControl,
    onReadyChange,
    agent,
    ...props
  }: AgentCreateProps<Config> & {
    harnessControl: ReactNode;
    onReadyChange?: (ready: boolean) => void;
  }) {
    const { state, resolving, signedOut } = useCredentials(agent);
    // Only missing credentials hold creation: an agent made before Claude is
    // installed waits for the download, as it did with the Model row alone.
    const ready = !!state.status && !signedOut && !resolving;
    useEffect(() => onReadyChange?.(ready), [onReadyChange, ready]);
    return (
      <SettingsGroup>
        {harnessControl}
        <PreferenceRow
          title="Model"
          trailing={
            signedOut ? (
              <Select
                label="Model"
                variant="compact"
                value=""
                groups={options([["", "Default"]])}
                disabled
                onValueChange={() => {}}
              />
            ) : (
              <CreateModel {...props} />
            )
          }
        />
        <PreferenceRow
          title="Thinking"
          trailing={<CreateThinking {...(agent && { agent })} {...props} />}
        />
      </SettingsGroup>
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

  /** Claude Code installation and account readiness on this computer. */
  function DefaultControl({ onConfigure }: { onConfigure(): void }) {
    const state = useSetupCatalog();
    const saved = useSyncExternalStore(
      defaults.subscribe,
      defaults.snapshot,
      defaults.snapshot,
    );
    const [error, setError] = useState("");
    return (
      <>
        <ModelDiscoveryRecovery
          error={state.modelsError}
          loading={state.modelsChecking}
          retry={() => void setup.loadModels(true)}
        >
          <ModelPicker
            includeDefault={false}
            resetLabel="Use Claude default"
            compact
            groupByFamily
            label="Claude default model"
            models={modelChoices(state.models).map((choice) => ({
              ...choice,
              efforts: (() => {
                const model = state.models.find(
                  (item) => item.value === choice.id,
                );
                const levels = model ? effortChoices(effortLevels(model)) : [];
                return levels.length
                  ? [{ id: "", label: "Automatic" }, ...levels]
                  : [];
              })(),
            }))}
            effort={saved.effort ?? ""}
            effortLabel={saved.effort ? effortLabel(saved.effort) : "Automatic"}
            onEffortChange={(model, effort) => {
              defaults.save({ model, effort }).then(
                () => setError(""),
                (reason) => setError(String(reason)),
              );
            }}
            value={
              saved.model
                ? (providerDefaultModel(saved.model, state.models) ??
                  saved.model)
                : ""
            }
            defaultModel={providerDefaultModel("", state.models)}
            defaultLabel={providerDefaultLabel("", state.models)}
            onConfigure={onConfigure}
            onChange={(model) => {
              defaults.save({ model }).then(
                () => setError(""),
                (reason) => setError(String(reason)),
              );
            }}
          />
        </ModelDiscoveryRecovery>
        {error && <span role="alert">{error}</span>}
      </>
    );
  }

  function ProviderDialogBody({ onClose }: { onClose(): void }) {
    const state = useSetupCatalog();
    const status = state.status;
    const ready = status?.state === "ready" && !state.checking;
    const signingIn =
      state.running === "sign-in" ||
      (status?.state === "signed-out" && !state.running);
    // Credentials pasted here, not an interactive sign-in.
    const keyEntry = !setup.auth.signIn;
    const line =
      !status || state.checking
        ? "Checking Claude…"
        : status.state === "missing"
          ? "The Claude integration isn't installed yet."
          : status.state === "outdated"
            ? `Claude ${status.version} is older than Buzz needs.`
            : status.state === "signed-out"
              ? `Claude ${status.version} ${setup.auth.needs}.`
              : status.state === "error"
                ? status.message
                : undefined;
    const action =
      status?.state === "missing"
        ? ({ step: "install", label: "Install integration" } as const)
        : status?.state === "outdated"
          ? ({ step: "install", label: "Update Claude" } as const)
          : status?.state === "signed-out" && setup.auth.signIn
            ? ({ step: "sign-in", label: "Sign in" } as const)
            : undefined;
    const latestOutputLine = state.output
      .replaceAll("\r", "\n")
      .split("\n")
      .map((candidate) => candidate.trim())
      .filter(Boolean)
      .at(-1);
    return (
      <div className="grid gap-6">
        {state.notice && (
          <p role="status" className="m-0 text-body-sm">
            {state.notice}
          </p>
        )}
        <div className="grid gap-2" hidden={ready}>
          {/* A key's own form takes the dialog over: it says what is missing. */}
          {!state.running && !(keyEntry && status?.state === "signed-out") && (
            <p
              role={status?.state === "error" ? "alert" : "status"}
              className="m-0 text-body-sm text-primary"
            >
              <strong>{line}</strong>
            </p>
          )}
          {state.running === "install" && (
            <div className="flex flex-wrap items-center gap-2">
              <p
                role="status"
                className="m-0 flex items-center gap-2 text-body-sm"
              >
                <CircleNotchIcon
                  size={16}
                  aria-hidden="true"
                  className="motion-safe:animate-spin"
                />
                {latestOutputLine ?? "Installing Claude Code…"}
              </p>
            </div>
          )}
          {status?.state === "missing" && !state.running && (
            <p className="m-0 text-body-sm text-subtle">
              Downloads Buzz's own copy of Claude (about 250 MB) and keeps it on
              the latest release. Your own installation of Claude will be
              unaffected, and uses the same settings.
            </p>
          )}
          {state.output && state.running !== "install" && (
            <div
              role="log"
              aria-label="Setup output"
              className="m-0 max-h-60 overflow-auto whitespace-pre-wrap text-body-sm text-subtle"
            >
              {state.output}
            </div>
          )}
          {signingIn && <SignIn setup={setup} onSaved={onClose} />}
          {status?.state === "error" && (
            <p className="m-0 text-body-sm text-subtle">
              Open Claude Code in a terminal for more details, then please try
              again.
            </p>
          )}
        </div>
        {/* Kept through a routine check, so a paste or save goes on. Saving
            the key closes the dialog while the key is all it edits; once it
            has other settings, saving should leave it open. */}
        {status?.state === "ready" && (
          <SignedIn setup={setup} onSaved={onClose} />
        )}
        <ProviderDialogActions>
          <Button
            onClick={() =>
              state.running && !ready ? void setup.cancel() : onClose()
            }
          >
            {ready ? "Done" : "Cancel"}
          </Button>
          {!ready && action && !state.running && !state.checking && (
            <Button
              autoFocus
              variant="prominent"
              onClick={() => void setup.run(action.step)}
            >
              {action.label}
            </Button>
          )}
        </ProviderDialogActions>
      </div>
    );
  }

  /** One conversation's session file, kept current while Claude works. */
  function TranscriptView({
    agent,
    conversation,
    working,
  }: {
    agent: AgentViewProps<Config>["agent"];
    conversation: SavedConversation;
    working: boolean;
  }) {
    const workspace = readConfig(agent.config).workspace;
    return (
      <TranscriptPanel
        agent={agent}
        read={(signal) =>
          runtime.transcript(conversation, workspace, working, signal)
        }
        readLatest={(signal, held) =>
          runtime.latestTurns(conversation, workspace, working, signal, held)
        }
        readKey={`${conversation.key}\u0000${workspace}`}
        readAgain={conversation.sessionId ?? ""}
        working={working}
        reading="Reading the Claude session…"
        failed="Could not read the Claude session"
        missing={
          <p className="m-0 text-body-sm text-subtle">
            Claude has no transcript for this conversation on this computer. It
            may have been deleted, or the session ran in a different workspace.
          </p>
        }
        notes={(transcript) => (
          <>
            {transcript.incomplete && (
              <p role="status" className="m-0 text-body-sm">
                Some of this conversation’s sessions may be missing. Refresh to
                try again.{" "}
                <span className="text-subtle">
                  ({transcript.incomplete.split("\n")[0]})
                </span>
              </p>
            )}
            {transcript.more && (
              <p className="m-0 text-body-sm text-subtle">
                {transcript.turns.length
                  ? `Showing the latest ${transcript.turns.length === 1 ? "turn" : `${transcript.turns.length} turns`}.`
                  : "The latest turn is too large to show."}
              </p>
            )}
          </>
        )}
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
    const sessions = useSyncExternalStore(
      (listener) => runtime.subscribe(listener),
      () => runtime.sessions(agent.key),
    );
    const conversations = runtime.conversations(agent.key);
    const busy = new Map(
      sessions.map((session) => [session.key, session.busy]),
    );
    const workspace = readConfig(agent.config).workspace;
    const {
      session: here,
      searching,
      error: lookupError,
    } = useOpenedSession(
      conversations,
      conversation,
      (place, signal) => runtime.find(agent.key, place, workspace, signal),
      (channelId) => runtime.channelLabel(agent.key, channelId),
    );
    // Newest first, the opened conversation's channel above the rest.
    const recent = conversations
      .filter((item) => item.key !== here?.key)
      .sort(
        (a, b) =>
          Number(b.channelId === conversation?.channelId) -
          Number(a.channelId === conversation?.channelId),
      )
      .slice(0, CONVERSATION_LIMIT);
    const activity = (key: string) => {
      const running = busy.get(key);
      return running === undefined ? undefined : running ? "Working" : "Idle";
    };
    const { open, show, back } = useOpenTranscript(
      conversation,
      label,
      initialTranscript && { initial: here, searching, ...initialTranscript },
      close,
    );
    return (
      <div className={activityStyles.activity}>
        {conversation && (
          <OpenedConversation
            conversation={conversation}
            harness="Claude"
            session={here}
            searching={searching}
            error={lookupError}
            status={here && activity(here.key)}
            onView={() => here && show(here)}
          />
        )}
        <section className={activityStyles.section}>
          <InlineHeader title="Recent conversations" />
          <SettingsGroup layout="form">
            {recent.length ? (
              <ul className={activityStyles.list}>
                {recent.map((item) => (
                  <li key={item.key} className={activityStyles.entry}>
                    <div className={activityStyles.row}>
                      <span className={activityStyles.copy}>
                        <ConversationName
                          session={item}
                          title={label(item)}
                          className="text-label-sm"
                        />
                        <span className="block text-body-sm text-subtle">
                          {[
                            item.root
                              ? `Thread ${item.root.slice(0, 8)}`
                              : "Channel",
                            activity(item.key),
                            formatItemTimestamp(item.at / 1000, {
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
                        aria-label={`View transcript: ${label(item)}`}
                        onClick={() => show(item)}
                      >
                        View transcript
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 text-body-sm text-subtle">
                No other conversations saved in this app yet.
              </p>
            )}
          </SettingsGroup>
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
              conversation={
                conversations.find((item) => item.key === open.key) ?? open
              }
              working={busy.get(open.key) ?? false}
            />
          </PanelSubview>
        )}
      </div>
    );
  }

  /** What the agent runs with. Saving restarts idle sessions with the change. */
  function SettingsTab({
    agent,
    save,
    settingsHost,
    settingsSection,
    settingsContent,
  }: AgentViewProps<Config>) {
    const form = useId();
    const saved = readConfig(agent.config);
    const unavailable = !!agent.configProblem && !settingsHost?.pendingSave;
    const execution = useRemote(agent);
    const remote = execution?.remote === true;
    const setupState = useSetupCatalog(execution?.remote === false);
    const providerDefaults = useSyncExternalStore(
      defaults.subscribe,
      defaults.snapshot,
      defaults.snapshot,
    );
    const {
      draft,
      latest,
      setDraft,
      conflicts,
      resolve,
      submitted,
      changed: configChanged,
    } = useSettingsDraft(`${agent.key}:${agent.type}`, saved, !unavailable);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const saveErrorRef = useRef<HTMLParagraphElement>(null);
    useEffect(() => {
      if (error) saveErrorRef.current?.focus();
    }, [error]);
    const changed = configChanged || Boolean(settingsHost?.pendingSave);
    const submit = async () => {
      if (saving || conflicts.length || !changed || unavailable) return;
      setSaving(true);
      setError("");
      const config = {
        ...draft,
        workspace: draft.workspace.trim() || "~/.buzz",
      };
      submitted(config);
      try {
        // This draft incorporates the current props; revise that exact snapshot.
        // The host routes staged provider changes through pendingSave instead.
        await save(config, { base: agent.configBase ?? {} });
      } catch (reason) {
        setError(message(reason));
      } finally {
        setSaving(false);
      }
    };
    const effortOptions = thinkingOptions(
      effortsFor(
        draft.model || (remote ? "" : providerDefaults.model),
        setupState.models,
      ),
      setupState.models,
      draft.effort,
    );
    const describe = (config: Config, group: SettingGroup) => {
      if (group === "model") {
        const model = config.model
          ? modelName(config.model, setupState.models)
          : remote
            ? "Target default"
            : `${providerDefaultLabel(providerDefaults.model, setupState.models)} · Default`;
        return `${model} · ${config.effort ? effortLabel(config.effort) : "Automatic"} thinking`;
      }
      if (group === "scope")
        return config.scope === "channel"
          ? "One session per channel"
          : "One session per thread";
      return config[group];
    };
    const conflict = (group: SettingGroup) =>
      conflicts.includes(group) ? (
        <fieldset
          aria-label={`${settingLabels[group]} conflict`}
          className="m-0 grid min-w-0 gap-2 border-0 px-0 py-3"
        >
          <p role="alert" className="m-0 text-body-sm text-warning">
            {settingLabels[group]} changed elsewhere. Choose which changes to
            keep.
          </p>
          {group === "instructions" ? (
            <Accordion
              items={[
                {
                  value: "latest-instructions",
                  title: "View latest instructions",
                  content: (
                    <p className="m-0 whitespace-pre-wrap break-words text-body-sm">
                      {latest.instructions || "No instructions"}
                    </p>
                  ),
                },
              ]}
            />
          ) : (
            <div className="text-body-sm break-words">
              <p className="m-0">Latest: {describe(latest, group)}</p>
              <p className="m-0">Yours: {describe(draft, group)}</p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={saving || unavailable}
              onClick={() => resolve(group, true)}
            >
              Use latest
            </Button>
            <Button
              disabled={saving || unavailable}
              onClick={() => resolve(group, false)}
            >
              Keep mine
            </Button>
          </div>
        </fieldset>
      ) : null;
    const modelControl = (
      <>
        <ModelPicker
          allowCustomModel
          models={modelChoices(setupState.models)}
          value={draft.model}
          defaultModel={
            remote
              ? undefined
              : providerDefaultModel(providerDefaults.model, setupState.models)
          }
          defaultLabel={
            remote
              ? "Target default"
              : providerDefaultLabel(providerDefaults.model, setupState.models)
          }
          defaultDescription={
            remote
              ? "Use the model configured on the target"
              : "Following the provider's model default"
          }
          loading={setupState.modelsChecking}
          onChange={(model) => {
            // An effort the new model does not list goes back to the default;
            // without Claude's list, the effort is kept.
            const next = effortsFor(
              model || providerDefaults.model,
              setupState.models,
            );
            setDraft({
              ...draft,
              model,
              effort:
                setupState.models.length === 0 ||
                next.some((level) => level.id === draft.effort)
                  ? draft.effort
                  : "",
            });
          }}
        />
        <Select
          label="Thinking"
          valueLabel={draft.effort ? undefined : "Automatic"}
          valueSuffix={draft.effort ? undefined : " · Default"}
          variant="preference"
          value={draft.effort}
          groups={[{ label: "", options: effortOptions }]}
          onValueChange={(effort) => setDraft({ ...draft, effort })}
        />
      </>
    );
    return (
      <form
        id={form}
        className="grid gap-4 [container-type:inline-size]"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {execution?.error && (
          <p role="alert" className="buzz-field-error">
            {execution.error}
          </p>
        )}
        {unavailable && (
          <p className="m-0 text-body-sm text-muted">
            Your edits stay in this form. You can save them, including Workspace
            changes, when configuration is available again.
          </p>
        )}
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
              {conflict("model")}
              {modelControl}
            </SettingsGroup>
            <div className="grid gap-2">
              {conflict("instructions")}
              <AgentInstructions
                value={draft.instructions}
                disabled={false}
                onChange={(instructions) =>
                  setDraft({ ...draft, instructions })
                }
              />
            </div>
          </>
        )}
        {settingsSection !== "identity" && (
          <>
            <div className="grid gap-2">
              {conflict("workspace")}
              <Field
                label="Workspace"
                description={
                  remote
                    ? "The execution provider sets the remote workspace."
                    : "The folder Claude works in. Use ~/ for your home folder."
                }
              >
                <Input
                  value={draft.workspace}
                  disabled={execution?.remote !== false}
                  onValueChange={(workspace) =>
                    setDraft({ ...draft, workspace })
                  }
                />
              </Field>
            </div>
            <div className="grid gap-2">
              {conflict("scope")}
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
            </div>
          </>
        )}
        <AgentSaveButton
          form={form}
          saving={saving}
          dirty={changed}
          disabled={
            !changed ||
            conflicts.length > 0 ||
            unavailable ||
            execution?.remote === undefined
          }
        />
        {settingsSection !== "identity" && settingsContent}
      </form>
    );
  }

  return {
    CreateModel,
    CreateConfiguration,
    CreateAction,
    CreateThinking,
    Create,
    ProviderDialogBody,
    DefaultControl,
    SettingsTab,
    ActivityTab,
  };
}
