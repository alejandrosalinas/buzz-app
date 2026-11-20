// Avatar selection above the agent identity and type-owned setup fields.
import {
  type AriaAttributes,
  type ReactElement,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { sessionScope } from "../../features/agent-harness/session-scope";
import type { AgentCardDraft } from "../../features/agents/agent-card";
import {
  agentAvatars,
  randomAgentAvatar,
} from "../../features/agents/avatar-packs";
import {
  AISettings,
  Checking,
  UsesLine,
} from "../../features/agents/AISettings";
import {
  bounded,
  followRecommended,
  onRecommended,
  recommendedCandidates,
  type RecommendedCandidate,
  withRecommended,
} from "../../features/agents/recommended";
import { useRecommendedPick } from "../../features/agents/useRecommendedPick";
import type {
  Agent,
  AgentViewProps,
  Agents,
  RegisteredAgentType,
  NewAgent,
  AgentCreationRequest,
  AgentUpdateRequest,
} from "../../features/agents/service";
import { compactAt } from "../../features/agents/compact-at";
import { AgentSaveFooter } from "../../features/agents/AgentSaveButton";
import {
  applySettingsProposal,
  type AgentSettingsProposal,
} from "../../features/agents/settings-proposal";
import { PlugIcon, RobotIcon } from "../../shared/design-system/icons";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Select } from "../../shared/design-system/ui/Select";
import { AgentAvatarPicker, type AvatarSelection } from "./AgentAvatarPicker";
import styles from "./AgentCreate.module.css";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Field } from "../../shared/design-system/ui/Field";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { Input } from "../../shared/design-system/ui/Input";
import { useNamePrompt, useShake } from "./useNamePrompt";
import { MigrationPreview } from "./AgentSettingsHost";
import { RemoteAgentIntroduction } from "./RemoteAgentIntroduction";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
// Focused controls and save errors must clear the dialog's sticky chrome.
const reveal = (element: HTMLElement | null) => {
  if (!element) return;
  if (typeof element.scrollIntoView === "function") {
    element.scrollIntoView({ block: "nearest" });
  }
  const popup = element.closest<HTMLElement>(".buzz-dialog");
  const footer = popup?.querySelector<HTMLElement>(".buzz-dialog-actions");
  if (!popup || !footer) return;
  const covered =
    element.getBoundingClientRect().bottom - footer.getBoundingClientRect().top;
  if (covered > 0) popup.scrollTop += covered;
};

/** Use each registered provider's icon in creation and library cards. */
export function TypeIcon({
  type,
  size = 16,
}: {
  type: RegisteredAgentType | undefined;
  size?: number;
}) {
  const Icon = type?.icon ?? RobotIcon;
  return <Icon size={size} aria-hidden="true" />;
}

/** Create agent's reason, while nothing is set up to run an agent. */
const SetUpFirst = ({
  when,
  children,
}: Readonly<{
  when: boolean;
  children: ReactElement<Pick<AriaAttributes, "aria-describedby">>;
}>) =>
  when ? (
    <Tooltip content="Set up Goose, Codex or Claude first.">{children}</Tooltip>
  ) : (
    children
  );

const startingConfig = (type: RegisteredAgentType | undefined) => {
  try {
    return type?.defaults().config;
  } catch {
    return undefined;
  }
};

function ProposedSettings({
  headingRef,
  saved,
  proposed,
  draft,
}: {
  headingRef: Ref<HTMLHeadingElement>;
  saved: unknown;
  proposed: AgentSettingsProposal;
  draft: unknown;
}) {
  const headingId = useId();
  const current = (saved ?? {}) as AgentSettingsProposal;
  const next = (draft ?? {}) as AgentSettingsProposal;
  const leavingRecommended = onRecommended(current) && !onRecommended(next);
  const labels = {
    model: "Model",
    effort: "Thinking",
    scope: "Session scope",
    workspace: "Workspace",
    voice: "Huddle voice",
    apps: "Codex apps and plugins",
    compactAt: "Auto-compact at",
  } as const;
  const value = (settings: AgentSettingsProposal, key: keyof typeof labels) => {
    if (key === "scope")
      return `One session per ${sessionScope(settings.scope)}`;
    if (key === "apps") return settings.apps === true ? "On" : "Off";
    if (key === "compactAt") {
      const tokens = compactAt(settings.compactAt);
      return tokens ? `${tokens / 1000}K tokens` : "Harness default";
    }
    if (key === "workspace")
      return typeof settings.workspace === "string" && settings.workspace.trim()
        ? settings.workspace.trim()
        : "~/.buzz";
    if ((key === "model" || key === "effort") && onRecommended(settings))
      return "Recommended";
    const text = settings[key];
    return typeof text === "string" && text ? text : "Default";
  };
  const rows = (Object.keys(labels) as (keyof typeof labels)[]).flatMap(
    (key) => {
      if (
        proposed[key] === undefined &&
        !(leavingRecommended && key === "model")
      )
        return [];
      const before = value(current, key);
      const after = value(next, key);
      return before === after ? [] : [{ label: labels[key], before, after }];
    },
  );
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <InlineHeader
        ref={headingRef}
        id={headingId}
        level={2}
        title="Proposed settings"
        tabIndex={-1}
      />
      {rows.length ? (
        <SettingsGroup>
          {rows.map(({ label, before, after }) => (
            <PreferenceRow
              key={label}
              title={label}
              subtitle={
                <>
                  {before}
                  <span aria-hidden="true"> → </span>
                  <span className="sr-only"> to </span>
                  {after}
                </>
              }
            />
          ))}
        </SettingsGroup>
      ) : (
        <p className="m-0 text-body-sm text-subtle">
          The proposed settings match the saved settings.
        </p>
      )}
    </section>
  );
}

export function AgentCreateDialog({
  agents,
  types,
  community,
  onClose,
  onCreated,
  request,
  draft,
  onCreate,
  update,
  openSettings,
}: {
  agents: Agents;
  types: readonly RegisteredAgentType[];
  community?: string | undefined;
  onClose(): void;
  onCreated(agent: Agent): void;
  request?: AgentCreationRequest;
  /** Starts from an agent card's name, picture and instructions. */
  draft?: AgentCardDraft;
  onCreate?(input: NewAgent): Promise<Agent>;
  /** Opens a Settings section, such as Agent setup. */
  openSettings?: ((section: string) => void) | undefined;
  /** Edits `agent` instead, starting from its settings with the request's
   * changes. */
  update?: Readonly<{
    agent: Agent;
    request: AgentUpdateRequest;
    onSave(input: NewAgent): Promise<void>;
  }>;
}) {
  const edited = update?.agent;
  const reviewingSettings = !!update?.request.settings;
  const [open, setOpen] = useState(true);
  const [settingsActions, setSettingsActions] = useState<HTMLDivElement | null>(
    null,
  );
  const [name, setName] = useState(
    update
      ? (update.request.name ?? update.agent.name)
      : (request?.name ?? draft?.name ?? ""),
  );
  const [avatar, setAvatar] = useState<AvatarSelection>(() => {
    const picture = update
      ? (update.request.picture ?? update.agent.picture ?? "")
      : (request?.picture ?? draft?.picture);
    if (picture === undefined)
      return { kind: "gloopie", picture: randomAgentAvatar().url };
    // A card or request can name a pack avatar, which then animates.
    return agentAvatars.some((avatar) => avatar.url === picture)
      ? { kind: "gloopie", picture }
      : { kind: "image", picture };
  });
  // A new agent starts on Recommended when this build has candidates and
  // this computer can run one; until that is known, the choice waits.
  const recommendable =
    !update && !request && recommendedCandidates().length > 0;
  const [typeKey, setTypeKey] = useState(
    (update ? (update.request.type ?? update.agent.type) : request?.type) ??
      // Automatic is for local harnesses; it starts on one.
      (recommendable ? types.find((item) => !item.remote) : types[0])?.key ??
      types[0]?.key ??
      "",
  );
  const choices = reviewingSettings
    ? types.filter((item) => item.settingsProposal)
    : types;
  const type =
    choices.find((item) => item.key === typeKey) ??
    (reviewingSettings ? undefined : types[0]);
  const migration = (item: RegisteredAgentType | undefined) => {
    if (!edited || !item || item.key === edited.type) return undefined;
    try {
      return agents.previewRetype(edited.key, item.key);
    } catch {
      return undefined;
    }
  };
  /** The agent's settings in `item`, or a new agent's defaults, with the
   * requested instructions. */
  const seed = (item: RegisteredAgentType | undefined, initial = true) => {
    if (!update) {
      const config = startingConfig(item);
      const instructions =
        (initial ? request?.instructions : undefined) ?? draft?.instructions;
      return instructions && item?.adopt
        ? item.adopt({ instructions }, config)
        : config;
    }
    const { agent, request: proposed } = update;
    const config =
      item?.key === agent.type
        ? agent.config
        : (migration(item)?.config ?? startingConfig(item));
    return proposed.instructions !== undefined && item?.adopt
      ? item.adopt({ instructions: proposed.instructions }, config)
      : config;
  };
  const [config, setConfig] = useState(() => seed(type));
  const proposedSettings =
    update && type?.key === (update.request.type ?? update.request.agentType)
      ? update.request.settings
      : undefined;
  const modelProposal =
    proposedSettings?.model !== undefined ||
    proposedSettings?.effort !== undefined;
  const recommendedType = types.find((item) => item.key === update?.agent.type);
  const resolveRecommended =
    update &&
    !update.agent.executionBinding &&
    onRecommended(update.agent.config) &&
    (update.request.settings?.model !== undefined ||
      update.request.settings?.effort !== undefined)
      ? recommendedType?.settingsProposal?.resolveRecommended
      : undefined;
  const [candidate, setCandidate] = useState<RecommendedCandidate | null>();
  useEffect(() => {
    if (!resolveRecommended) return;
    let current = true;
    void resolveRecommended().then(
      (value) => current && setCandidate(value),
      () => current && setCandidate(null),
    );
    return () => {
      current = false;
    };
  }, [resolveRecommended]);
  const checkingProposal =
    modelProposal && Boolean(resolveRecommended) && candidate === undefined;
  const proposedConfig = useMemo(() => {
    if (!proposedSettings) return config;
    const manual =
      candidate && modelProposal
        ? followRecommended(
            config,
            config as { model: string; effort: string },
            candidate,
          )
        : config;
    return applySettingsProposal(manual, proposedSettings);
  }, [candidate, config, modelProposal, proposedSettings]);
  const Settings = reviewingSettings
    ? type?.tabs?.find((tab) => tab.role === "settings")?.component
    : undefined;
  const settingsAgent = useMemo(
    () =>
      edited && type
        ? { ...edited, type: type.key, config: proposedConfig }
        : undefined,
    [edited, type, proposedConfig],
  );
  const Form = reviewingSettings ? "div" : "form";
  const [automatic, setAutomatic] = useState(recommendable);
  // Asked again when Automatic is chosen again, or its pick stopped being
  // ready: a harness may have been signed in or out since the dialog opened.
  const [asked, setAsked] = useState(0);
  const recommendation = useRecommendedPick(types, recommendable, asked);
  const { pick } = recommendation.status === "found" ? recommendation : {};
  // No local harness can run an Automatic agent here: one thing to set up.
  const nothingSetUp =
    automatic && recommendable && recommendation.status === "none";
  const preview = migration(type);
  const [dirty, setDirty] = useState(Boolean(update));
  const [pending, setPending] = useState(false);
  const [showRemoteIntro, setShowRemoteIntro] = useState(false);
  const [error, setError] = useState("");
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [configurationReady, setConfigurationReady] = useState(false);
  const avatarRef = useRef<{ prepare(): Promise<string> }>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const proposalHeading = useRef<HTMLHeadingElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const settingsSaveButton = useRef<HTMLButtonElement>(null);
  const introContinue = useRef<HTMLButtonElement>(null);
  const previousIntro = useRef(false);
  useLayoutEffect(() => {
    if (previousIntro.current === showRemoteIntro) return;
    previousIntro.current = showRemoteIntro;
    const target = showRemoteIntro
      ? introContinue.current
      : pending
        ? nameField.current?.closest<HTMLElement>('[role="dialog"]')
        : createButton.current;
    target?.focus({ preventScroll: true });
  }, [showRemoteIntro, pending]);
  const namePrompt = useNamePrompt(nameField);
  const nameControl = useRef<HTMLDivElement>(null);
  useShake(nameControl, namePrompt.attempts);
  const form = useId();
  const harnessId = useId();
  const restoreHarnessFocus = useRef<string | null>(null);
  const Create = type?.Create;
  const Model = type?.CreateModel;
  const Configuration = type?.CreateConfiguration;
  const Thinking = type?.CreateThinking;
  useEffect(() => {
    if (restoreHarnessFocus.current !== type?.key) return;
    restoreHarnessFocus.current = null;
    document
      .getElementById(harnessId)
      ?.querySelector<HTMLElement>('[role="combobox"]')
      ?.focus();
  }, [harnessId, type?.key]);
  const CreateAction = type?.CreateAction;
  // The harness's own setup rows say when it is ready. Automatic shows none:
  // its pick already found the harness ready, and `waiting` covers no pick.
  const picked = automatic && !!pick && pick.type.key === type?.key;
  const canCreate = !Configuration || configurationReady || picked;
  const close = () => setOpen(false);
  const chooseModel = (
    item: RegisteredAgentType,
    next: unknown,
    options?: { suggested?: boolean },
  ) => {
    setTypeKey(item.key);
    setConfig(next);
    if (options?.suggested) return;
    setDirty(true);
    setError("");
  };
  /** `item`'s config for the agent, carrying the owner's edits, including an
   * explicit clear, across harnesses. */
  const carried = (item: RegisteredAgentType) => {
    // A creation request seeds only the first harness, not later choices.
    const next = seed(item, false);
    const kept =
      update || !type?.carry ? undefined : type.carry(config).instructions;
    const instructions =
      kept || ((draft || request) && type?.carry ? "" : undefined);
    return instructions !== undefined && item.adopt
      ? item.adopt({ instructions }, next)
      : next;
  };
  // Once known, Automatic on this computer takes its harness.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Follows only the pick.
  useEffect(() => {
    if (!pick || !automatic) return;
    if (pick.type.key !== type?.key) {
      setTypeKey(pick.type.key);
      setConfig(carried(pick.type));
    }
  }, [pick]);
  const choose = (key: string) => {
    const item = types.find((candidate) => candidate.key === key);
    if (!item || key === type?.key) return;
    restoreHarnessFocus.current = item.key;
    setConfigurationReady(false);
    chooseModel(item, carried(item));
  };
  /** Automatic, or the harness and model chosen manually. */
  const chooseAutomatic = (on: boolean) => {
    if (on === automatic) return;
    setAutomatic(on);
    if (on) setAsked((count) => count + 1);
    setDirty(true);
    setError("");
    // While the pick runs, its effect takes the harness once known.
    if (on && pick && pick.type.key !== type?.key)
      chooseModel(pick.type, carried(pick.type));
    // Manual starts from what Automatic picked.
    if (!on && pick && pick.type.key === type?.key)
      setConfig(
        followRecommended(
          withRecommended(config as object),
          config as { model: string; effort: string },
          pick.candidate,
        ),
      );
  };
  // Automatic has nothing to create with until, and unless, a pick is found.
  const waiting = automatic && !type?.remote && !pick;
  const create = async (introduced = false, settings?: { config: unknown }) => {
    if (!type || pending || waiting || (!settings && !canCreate)) return;
    if (avatarBusy) {
      if (settings) throw new Error("Wait for the picture to finish preparing");
      return;
    }
    if (!name.trim()) {
      namePrompt.prompt();
      if (settings) throw new Error("Name the agent");
      return;
    }
    if (!update && type.remote && !introduced) {
      setShowRemoteIntro(true);
      return;
    }
    setPending(true);
    setError("");
    try {
      // The pick was ready when found; it may have been signed out since.
      // A check that fails or takes too long counts as not ready.
      if (picked && !(await bounded(pick.type.recommends?.(pick.candidate)))) {
        setAsked((count) => count + 1);
        setError(`${pick.type.title} isn’t ready on this computer.`);
        setPending(false);
        return;
      }
      const picture =
        (await avatarRef.current?.prepare()) ??
        (avatar.kind === "emoji" ? "" : avatar.picture);
      const input = {
        type: type.key,
        name: name.trim(),
        ...(picture ? { picture } : {}),
        ...(settings
          ? { config: settings.config }
          : config !== undefined
            ? {
                config:
                  automatic && pick?.type.key === type.key
                    ? withRecommended(config as object)
                    : config,
              }
            : {}),
      };
      if (update) await update.onSave(input);
      else onCreated(await (onCreate ? onCreate(input) : agents.create(input)));
    } catch (reason) {
      setPending(false);
      if (settings) throw reason;
      setError(message(reason));
    }
  };
  const saveSettings: AgentViewProps["save"] = (config) =>
    create(false, { config });
  const harnessControl = (
    <PreferenceRow
      id={harnessId}
      title="Harness"
      trailing={
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <Select
            label="Harness"
            variant="compact"
            align="end"
            value={type?.key ?? ""}
            leading={<TypeIcon type={type} size={20} />}
            disabled={pending || choices.length < 2}
            groups={[true, false]
              .map((remote) => ({
                label: remote ? "Remote" : "Local",
                options: choices
                  .filter((item) => Boolean(item.remote) === remote)
                  .map((item) => ({
                    value: item.key,
                    leading: <TypeIcon type={item} size={20} />,
                    label: item.title,
                  })),
              }))
              .filter((group) => group.options.length > 0)}
            onValueChange={choose}
          />
          {CreateAction && !reviewingSettings && (
            <CreateAction
              key={type.key}
              {...(edited ? { agent: edited } : {})}
              disabled={pending || avatarBusy}
            />
          )}
        </div>
      }
    />
  );
  const errorMessage = error && (
    <p
      key={error}
      ref={reveal}
      role="alert"
      className="m-0 text-body-sm text-danger"
    >
      {error}
    </p>
  );
  // Harness, Model and Thinking: main's rows, and Manual's under AI settings.
  const localRows = (
    <>
      {harnessControl}
      {Model && (
        <PreferenceRow
          title="Model"
          trailing={
            <Model
              key={type.key}
              config={config}
              // Thinking has its own row beside it.
              {...(Thinking && { showEffort: false })}
              disabled={pending}
              onChange={(next) => chooseModel(type, next)}
            />
          }
        />
      )}
      {Thinking && (
        <PreferenceRow
          title="Thinking"
          trailing={
            <Thinking
              key={type.key}
              {...(edited ? { agent: edited } : {})}
              config={config}
              disabled={pending}
              onChange={(next) => chooseModel(type, next)}
            />
          }
        />
      )}
    </>
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) showRemoteIntro ? setShowRemoteIntro(false) : close();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClose();
      }}
      title={
        showRemoteIntro
          ? "Meet your remote agent"
          : edited
            ? `Edit ${edited.name}`
            : "Create agent"
      }
      description={
        showRemoteIntro
          ? undefined
          : update
            ? `${update.request.requesterName} proposed these changes. Nothing changes until you save.`
            : request
              ? `${request.requesterName} requested this agent. Review its settings before creating it.`
              : draft
                ? "From an agent card. Review its settings before creating it."
                : undefined
      }
      size={showRemoteIntro ? "compact" : "default"}
      closeLabel={showRemoteIntro ? "Back to agent settings" : "Close"}
      height="content"
      chromeSpacing="padded"
      initialFocus={reviewingSettings ? proposalHeading : nameField}
      // A started draft only closes from the close button.
      dismissOnOutsideClick={!dirty}
      onEscape={() => {
        if (showRemoteIntro) return false;
        if (pending || avatarBusy) return true;
        return dirty || pending;
      }}
      preventClose={pending || avatarBusy}
      actions={
        showRemoteIntro ? (
          <>
            <Button
              disabled={pending}
              onClick={() => setShowRemoteIntro(false)}
            >
              Back
            </Button>
            <Button
              ref={introContinue}
              variant="primary"
              loading={pending}
              disabled={!canCreate || avatarBusy}
              onClick={() => void create(true)}
            >
              Let’s go
            </Button>
          </>
        ) : reviewingSettings ? (
          <div ref={setSettingsActions} />
        ) : (
          <SetUpFirst when={nothingSetUp}>
            <Button
              ref={createButton}
              variant="primary"
              type="submit"
              form={form}
              loading={pending}
              // Still focusable, so its reason can be read.
              focusableWhenDisabled={nothingSetUp}
              disabled={
                avatarBusy ||
                pending ||
                !type ||
                !canCreate ||
                waiting ||
                !name.trim()
              }
            >
              {update ? "Save changes" : "Create agent"}
            </Button>
          </SetUpFirst>
        )
      }
    >
      {/* Preserve the draft and avatar preparation while showing the introduction. */}
      <Form
        hidden={showRemoteIntro}
        id={reviewingSettings ? undefined : form}
        className={styles.form}
        data-error={error ? "" : undefined}
        aria-label={
          reviewingSettings
            ? undefined
            : edited
              ? `Edit ${edited.name}`
              : "New agent"
        }
        onFocusCapture={
          reviewingSettings
            ? (event) =>
                reveal(
                  event.target instanceof HTMLElement ? event.target : null,
                )
            : undefined
        }
        onSubmit={
          reviewingSettings
            ? undefined
            : (event) => {
                event.preventDefault();
                void create();
              }
        }
      >
        <div className={styles.createStack}>
          {update && proposedSettings && !checkingProposal && (
            <ProposedSettings
              headingRef={proposalHeading}
              saved={update.agent.config}
              proposed={proposedSettings}
              draft={proposedConfig}
            />
          )}
          <section aria-label="Identity" className={styles.profileIdentity}>
            <div>
              <AgentAvatarPicker
                name={name}
                selection={avatar}
                disabled={pending}
                community={community}
                onBusyChange={setAvatarBusy}
                onChange={(selection) => {
                  setAvatar(selection);
                  setDirty(true);
                  setError("");
                }}
                avatarRef={avatarRef}
              />
            </div>
          </section>
          <div>
            <Field
              label="Name"
              error={
                namePrompt.attempts
                  ? update
                    ? "Name the agent"
                    : "Add a name to create your agent"
                  : undefined
              }
            >
              <div ref={nameControl}>
                <Input
                  ref={nameField}
                  placeholder="Name"
                  value={name}
                  disabled={pending}
                  onKeyDown={
                    reviewingSettings
                      ? (event) => {
                          if (
                            event.key !== "Enter" ||
                            event.nativeEvent.isComposing
                          )
                            return;
                          event.preventDefault();
                          settingsSaveButton.current?.click();
                        }
                      : undefined
                  }
                  onChange={(event) => {
                    setName(event.target.value);
                    namePrompt.named(event.target.value);
                    setDirty(true);
                    setError("");
                  }}
                />
              </div>
            </Field>
          </div>
          <section
            aria-label="AI configuration"
            className={styles.configuration}
            onFocusCapture={(event) =>
              reveal(event.target instanceof HTMLElement ? event.target : null)
            }
          >
            {reviewingSettings ? (
              <SettingsGroup>{harnessControl}</SettingsGroup>
            ) : recommendable && !type?.remote ? (
              // Local harnesses only. A hosted type, chosen under Manual's
              // Harness, keeps its own group below, as on main.
              <SettingsGroup>
                <AISettings
                  automatic={automatic}
                  harnessIcon={automatic ? pick?.type.icon : type?.icon}
                  modelName={pick?.candidate.label}
                  disabled={pending}
                  onChange={chooseAutomatic}
                  summary={
                    recommendation.status === "checking" ? (
                      <Checking />
                    ) : undefined
                  }
                  model={
                    pick && (
                      <UsesLine
                        icon={pick.type.icon}
                        title={pick.type.title}
                        candidate={pick.candidate}
                        skipped={pick.skipped[0]?.title}
                      />
                    )
                  }
                >
                  {Configuration ? (
                    // Its own Model and Thinking rows, which wait on its
                    // setup, such as a sign-in, and report when it is ready.
                    <Configuration
                      key={type.key}
                      rowsOnly
                      config={config}
                      disabled={pending}
                      harnessControl={harnessControl}
                      onReadyChange={setConfigurationReady}
                      onChange={(next, options) =>
                        chooseModel(type, next, options)
                      }
                    />
                  ) : (
                    localRows
                  )}
                </AISettings>
                {nothingSetUp && (
                  <PreferenceRow
                    icon={<PlugIcon size={20} aria-hidden="true" />}
                    title="One thing to set up first"
                    subtitle="Set up a local harness for Automatic, or choose Custom to select another harness."
                    trailing={
                      openSettings && (
                        <Button
                          variant="prominent"
                          size="sm"
                          onClick={() => openSettings("agents")}
                        >
                          Set up
                        </Button>
                      )
                    }
                  />
                )}
              </SettingsGroup>
            ) : Configuration ? (
              <Configuration
                key={type.key}
                {...(edited ? { agent: edited } : {})}
                config={config}
                disabled={pending}
                harnessControl={harnessControl}
                onReadyChange={setConfigurationReady}
                onChange={(next, options) => chooseModel(type, next, options)}
              />
            ) : (
              <SettingsGroup>{localRows}</SettingsGroup>
            )}
          </section>
          {reviewingSettings ? (
            checkingProposal ? (
              <Checking />
            ) : Settings && settingsAgent && !edited?.configProblem ? (
              <AgentSaveFooter.Provider
                value={{
                  target: settingsActions,
                  dialog: true,
                  submitButton: settingsSaveButton,
                }}
              >
                <Settings
                  key={settingsAgent.type}
                  agent={settingsAgent}
                  save={saveSettings}
                  settingsHost={{
                    pendingSave: saveSettings,
                    proposedModelOrEffort: modelProposal,
                    proposedVoice: proposedSettings?.voice !== undefined,
                  }}
                />
              </AgentSaveFooter.Provider>
            ) : (
              <p role="alert" className="m-0 text-body-sm text-danger">
                {edited?.configProblem ??
                  "Settings are unavailable for this harness."}
              </p>
            )
          ) : Create ? (
            <Create
              key={type.key}
              config={config}
              disabled={pending}
              onChange={(next) => {
                setConfig(next);
                setDirty(true);
              }}
            />
          ) : (
            <p className="m-0 text-body-sm text-secondary">
              Set it up after it is made.
            </p>
          )}
          {preview && type && (
            <MigrationPreview
              source={types.find((item) => item.key === edited?.type)}
              target={type}
              preview={preview}
              discardDraft={false}
            />
          )}
        </div>
        {!showRemoteIntro && errorMessage}
      </Form>
      {showRemoteIntro && (
        <div className="grid gap-3">
          <RemoteAgentIntroduction
            name={name.trim()}
            avatar={avatar}
            community={community}
            builderlab={type?.key === "block.builderlab/builderlab"}
          />
          {errorMessage}
        </div>
      )}
    </Dialog>
  );
}
