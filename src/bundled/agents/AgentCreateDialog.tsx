// Avatar selection above the agent identity and type-owned setup fields.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { AgentCardDraft } from "../../features/agents/agent-card";
import {
  agentAvatars,
  randomAgentAvatar,
} from "../../features/agents/avatar-packs";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
  NewAgent,
  AgentCreationRequest,
  AgentUpdateRequest,
} from "../../features/agents/service";
import { RobotIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Select } from "../../shared/design-system/ui/Select";
import { AgentAvatarPicker, type AvatarSelection } from "./AgentAvatarPicker";
import styles from "./AgentCreate.module.css";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Field } from "../../shared/design-system/ui/Field";
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

const startingConfig = (type: RegisteredAgentType | undefined) => {
  try {
    return type?.defaults().config;
  } catch {
    return undefined;
  }
};

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
  /** Edits `agent` instead, starting from its settings with the request's
   * changes. */
  update?: Readonly<{
    agent: Agent;
    request: AgentUpdateRequest;
    onSave(input: NewAgent): Promise<void>;
  }>;
}) {
  const edited = update?.agent;
  const [open, setOpen] = useState(true);
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
  const [typeKey, setTypeKey] = useState(
    (update ? (update.request.type ?? update.agent.type) : request?.type) ??
      types[0]?.key ??
      "",
  );
  const type = types.find((item) => item.key === typeKey) ?? types[0];
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
  const preview = migration(type);
  const [dirty, setDirty] = useState(Boolean(update));
  const [pending, setPending] = useState(false);
  const [showRemoteIntro, setShowRemoteIntro] = useState(false);
  const [error, setError] = useState("");
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [configurationReady, setConfigurationReady] = useState(false);
  const avatarRef = useRef<{ prepare(): Promise<string> }>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
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
  const canCreate = !Configuration || configurationReady;
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
  const choose = (key: string) => {
    const item = types.find((candidate) => candidate.key === key);
    if (!item || key === type?.key) return;
    // A creation request seeds only the first harness, not later choices.
    const next = seed(item, false);
    // Carry the owner's edits, including an explicit clear, across harnesses.
    const carried =
      update || !type?.carry ? undefined : type.carry(config).instructions;
    const instructions =
      carried || ((draft || request) && type?.carry ? "" : undefined);
    restoreHarnessFocus.current = item.key;
    setConfigurationReady(false);
    chooseModel(
      item,
      instructions !== undefined && item.adopt
        ? item.adopt({ instructions }, next)
        : next,
    );
  };
  const create = async (introduced = false) => {
    if (!type || pending || avatarBusy || !canCreate) return;
    if (!name.trim()) {
      namePrompt.prompt();
      return;
    }
    if (!update && type.remote && !introduced) {
      setShowRemoteIntro(true);
      return;
    }
    setPending(true);
    setError("");
    try {
      const picture =
        (await avatarRef.current?.prepare()) ??
        (avatar.kind === "emoji" ? "" : avatar.picture);
      const input = {
        type: type.key,
        name: name.trim(),
        ...(picture ? { picture } : {}),
        ...(config !== undefined ? { config } : {}),
      };
      if (update) await update.onSave(input);
      else onCreated(await (onCreate ? onCreate(input) : agents.create(input)));
    } catch (reason) {
      setError(message(reason));
      setPending(false);
    }
  };
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
            disabled={pending || types.length < 2}
            groups={[true, false]
              .map((remote) => ({
                label: remote ? "Remote" : "Local",
                options: types
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
          {CreateAction && (
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
      initialFocus={nameField}
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
        ) : (
          <Button
            ref={createButton}
            variant="primary"
            type="submit"
            form={form}
            loading={pending}
            disabled={
              avatarBusy || pending || !type || !canCreate || !name.trim()
            }
          >
            {update ? "Save changes" : "Create agent"}
          </Button>
        )
      }
    >
      {/* Preserve the draft and avatar preparation while showing the introduction. */}
      <form
        hidden={showRemoteIntro}
        id={form}
        className={styles.form}
        data-error={error ? "" : undefined}
        aria-label={edited ? `Edit ${edited.name}` : "New agent"}
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <div className={styles.createStack}>
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
            {Configuration ? (
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
              <SettingsGroup>
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
              </SettingsGroup>
            )}
          </section>
          {Create ? (
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
      </form>
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
