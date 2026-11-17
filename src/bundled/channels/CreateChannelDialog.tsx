import type { ChannelCreationInput } from "../../features/channel-templates/setup";
import type { RelaySession } from "../../features/relay/session";
import type { Agents } from "../../features/agents/service";
import {
  templateAgents,
  useChannelTemplates,
} from "../../features/channel-templates/local";
import { Select } from "../../shared/design-system/ui/Select";
import { useTeams } from "../../features/agents/react";
import { useAgentChoices } from "../../features/agents/use-choices";
import {
  templateAgentChoices,
  type AgentChoicesSnapshot,
} from "../../features/agents/choices";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import {
  ChannelPrivacyConfirmation,
  skipPrivacyConfirmation,
  rememberPrivacyConfirmation,
} from "./ChannelPrivacyConfirmation";
import { ChannelDurationField } from "./ChannelDurationField";
import { ChannelTextField } from "./ChannelTextField";
import { SidebarGroupIcon } from "./SidebarGroupIcon";
import { SidebarStarIcon } from "./SidebarStarIcon";
import {
  canonicalDetailsName,
  detailsDraftErrors,
} from "../../features/relay/channel-details-protocol";
import { Switch } from "../../shared/design-system/ui/Switch";
import { DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS } from "../../features/relay/channel-writes";
import styles from "./CreateChannelDialog.module.css";

export type CreateChannelInput = ChannelCreationInput;

type Props = {
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreate(input: CreateChannelInput): Promise<void>;
  finalFocus?: RefObject<HTMLElement | null> | undefined;
  session: RelaySession;
  /** Supplies the agents and teams a template adds. */
  agents?: Agents | undefined;
  destinations: readonly Readonly<{
    id: string;
    name: string;
    icon?: string;
  }>[];
  initialGroup: string;
  initialStarred?: boolean;
  groupsReady: boolean;
};
export function CreateChannelDialog(props: Props) {
  // Each opening owns its callbacks. Closing/reopening cannot revive an old editor.
  return props.open ? <OpenCreateChannelDialog {...props} /> : null;
}
/** Templates add members only from ready inventory and archive evidence. */
function templateEvidence(choices: AgentChoicesSnapshot) {
  const ready =
    choices.templates.status === "ready" && choices.archives.status === "ready";
  return {
    ready,
    // Still being read, as opposed to failed or unavailable.
    checking:
      !ready &&
      (choices.templates.pending ||
        choices.archives.status === "idle" ||
        choices.archives.status === "loading"),
  };
}
function OpenCreateChannelDialog({
  open,
  onOpenChange,
  onCreate,
  finalFocus,
  session,
  agents,
  destinations,
  initialGroup,
  initialStarred = false,
  groupsReady,
}: Props) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const previousDiscard = useRef(confirmDiscard);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (confirmDiscard !== previousDiscard.current)
      (confirmDiscard ? keepEditing.current : input.current)?.focus();
    previousDiscard.current = confirmDiscard;
  }, [confirmDiscard]);
  const privateControlId = useId();
  const privateSwitch = useRef<HTMLSpanElement>(null);
  const privacyCancel = useRef<HTMLButtonElement>(null);
  const [privacyChoice, setPrivacyChoice] = useState<"private" | "public">();
  const [skipWarning, setSkipWarning] = useState(false);
  const previousPrivacyChoice = useRef(privacyChoice);
  useLayoutEffect(() => {
    if (privacyChoice !== previousPrivacyChoice.current)
      (privacyChoice ? privacyCancel.current : privateSwitch.current)?.focus();
    previousPrivacyChoice.current = privacyChoice;
  }, [privacyChoice]);
  const mounted = useRef(true);
  const previousOpen = useRef(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [lifetime, setLifetime] = useState<"ongoing" | "temporary">("ongoing");
  const [temporaryTtl, setTemporaryTtl] = useState(
    DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS,
  );
  const [privateChannel, setPrivateChannel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [groupId, setGroupId] = useState("");
  const [starred, setStarred] = useState(false);
  const templates = useChannelTemplates();
  const teams = useTeams(agents);
  const [chosenTemplate, setTemplateId] = useState("");
  // A template deleted meanwhile, here or in another window, is no choice.
  const template = templates.find((item) => item.id === chosenTemplate);
  const templateId = template?.id ?? "";
  // A template names agents and teams' members; which are the owner's agents in
  // this community is the shared selection's call, under the policy session
  // setup applies.
  const needsAgents =
    !!template?.agents.length ||
    !!template?.teams.some(
      (id) => teams.find((team) => team.id === id)?.members.length,
    );
  const choices = useAgentChoices(session, false, needsAgents);
  const roster = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const evidence = templateEvidence(choices);
  const agentNames = new Map(
    (evidence.ready ? templateAgentChoices(choices, roster) : []).map(
      (agent) => [agent.pubkey, agent.name],
    ),
  );
  // Members not yet checked are neither added nor dropped: creation waits.
  const unresolved = needsAgents && !evidence.ready;
  const checkingAgents = unresolved && evidence.checking;
  // A failed read offers the same refresh the session preflight applies. Its
  // Retry stays mounted while the read runs so focus keeps a home.
  const [retrying, setRetrying] = useState(false);
  const templateField = useRef<HTMLDivElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const retryAgents = async () => {
    setRetrying(true);
    try {
      await session.agentChoices.refresh("templates");
    } finally {
      if (mounted.current) {
        // A resolved field unmounts Retry with its error; hand focus back.
        const after = templateEvidence(session.agentChoices.snapshot());
        if (
          (after.ready || after.checking) &&
          document.activeElement === retryButton.current
        )
          templateField.current
            ?.querySelector<HTMLElement>('[role="combobox"]')
            ?.focus();
        setRetrying(false);
      }
    }
  };
  const templateSetup = template && {
    agents: templateAgents(template, teams, new Set(agentNames.keys())),
    canvas: template.canvas,
  };
  const templateNote =
    templateSetup &&
    !unresolved &&
    ([
      templateSetup.agents.length
        ? `Adds ${templateSetup.agents.map((key) => agentNames.get(key)).join(", ")}`
        : "",
      templateSetup.canvas.trim() ? "Starts the Canvas" : "",
    ]
      .filter(Boolean)
      .join(" · ") ||
      "None of its agents are in this community, and it has no Canvas.");
  const destination = destinations.find((g) => g.id === groupId);
  const editing = useRef(false);
  editing.current = !busy && !privacyChoice && !confirmDiscard;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Closing forgets an unconfirmed attempt; nothing restores it later.
      session.channelCreation.forget();
    };
  }, [session]);
  useEffect(() => {
    const opening = open && !previousOpen.current;
    previousOpen.current = open;
    if (!opening) return;
    setName("");
    setDescription("");
    setLifetime("ongoing");
    setTemporaryTtl(DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS);
    setPrivateChannel(false);
    setPrivacyChoice(undefined);
    setConfirmDiscard(false);
    setError("");
    setGroupId(initialGroup);
    setStarred(initialStarred);
    setTemplateId("");
  }, [open, initialGroup, initialStarred]);

  const normalizedName = canonicalDetailsName(name);
  const errors = detailsDraftErrors({
    name: normalizedName,
    description,
    visibility: privateChannel ? "private" : "public",
  });
  const invalid = Object.values(errors).some(Boolean) || unresolved;

  const dirty =
    name !== "" ||
    description !== "" ||
    privateChannel ||
    lifetime !== "ongoing" ||
    templateId !== "";
  const requestClose = () => {
    if (busy) return;
    if (privacyChoice) setPrivacyChoice(undefined);
    else if (confirmDiscard) setConfirmDiscard(false);
    else if (dirty) setConfirmDiscard(true);
    else onOpenChange(false);
  };

  const submit = async () => {
    if (invalid || busy || privacyChoice || confirmDiscard) return;
    editing.current = false;
    setBusy(true);
    setError("");
    try {
      if (
        groupId &&
        (!groupsReady || !destinations.some((g) => g.id === groupId))
      )
        throw new Error(
          groupsReady
            ? "This group is no longer available. Close this dialog and create from another sidebar group or Channels."
            : "Wait for saved sidebar groups to load, then try again.",
        );
      await onCreate({
        name: normalizedName,
        visibility: privateChannel ? "private" : "open",
        ...(lifetime === "temporary" ? { ttlSeconds: temporaryTtl } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        // The selected template stays part of the request even when it
        // currently resolves to nothing, so a retry still matches it.
        ...(groupId || starred || templateId
          ? {
              setup: {
                agents: templateSetup?.agents ?? [],
                canvas: templateSetup?.canvas ?? "",
                groupId,
                ...(starred ? { starred: true } : {}),
                templateId,
              },
            }
          : {}),
      });
      if (mounted.current) onOpenChange(false);
    } catch (reason) {
      if (mounted.current)
        setError(
          reason instanceof Error
            ? reason.message
            : "The channel could not be created.",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
      dismissOnOutsideClick
      step={
        confirmDiscard
          ? { key: "discard", scale: 0.95 }
          : privacyChoice
            ? { key: "privacy", scale: 0.95 }
            : { key: "details", scale: 1.05 }
      }
      footerGap={privacyChoice ? "compact" : "default"}
      preventClose={busy}
      title={
        confirmDiscard ? (
          "Discard changes?"
        ) : privacyChoice ? (
          privacyChoice === "private" ? (
            "Make channel private?"
          ) : (
            "Make channel public?"
          )
        ) : (
          <span className={styles.title}>
            Create a channel
            {(groupId || starred) && (
              <>
                {" in "}
                {starred ? (
                  <>
                    <SidebarStarIcon />{" "}
                  </>
                ) : destination?.icon ? (
                  <>
                    <SidebarGroupIcon
                      icon={destination.icon}
                      session={session}
                    />{" "}
                  </>
                ) : null}
                {starred ? "Starred" : (destination?.name ?? "saved group")}
              </>
            )}
          </span>
        )
      }
      description={
        confirmDiscard ? "Your channel draft has unsaved changes." : undefined
      }
      closeLabel={
        confirmDiscard || privacyChoice
          ? "Back to channel creation"
          : "Close channel creation"
      }
      initialFocus={input}
      finalFocus={finalFocus}
      actions={
        confirmDiscard ? (
          <>
            <Button ref={keepEditing} onClick={() => setConfirmDiscard(false)}>
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!busy) onOpenChange(false);
              }}
            >
              Discard changes
            </Button>
          </>
        ) : privacyChoice ? (
          <>
            <Button
              ref={privacyCancel}
              onClick={() => setPrivacyChoice(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant="prominent"
              disabled={busy}
              onClick={() => {
                if (busy) return;
                if (skipWarning) rememberPrivacyConfirmation(session.scope);
                setPrivateChannel(privacyChoice === "private");
                setPrivacyChoice(undefined);
                setError("");
              }}
            >
              Continue
            </Button>
          </>
        ) : (
          <>
            <span className={styles.privateAction}>
              <Switch
                id={privateControlId}
                ref={privateSwitch}
                aria-label="Private"
                checked={privateChannel}
                readOnly={busy}
                aria-disabled={busy || undefined}
                onCheckedChange={(checked) => {
                  if (!editing.current) return;
                  const choice = checked ? "private" : "public";
                  if (skipPrivacyConfirmation(session.scope)) {
                    setPrivateChannel(checked);
                    setError("");
                  } else {
                    setSkipWarning(false);
                    setPrivacyChoice(choice);
                  }
                }}
              />
              <label className="text-label-sm" htmlFor={privateControlId}>
                Private
              </label>
            </span>
            <Button
              variant="prominent"
              type="submit"
              form="create-channel-form"
              loading={busy}
              disabled={invalid}
            >
              Create channel
            </Button>
          </>
        )
      }
    >
      {confirmDiscard ? null : privacyChoice ? (
        <ChannelPrivacyConfirmation
          visibility={privacyChoice}
          checked={skipWarning}
          onCheckedChange={setSkipWarning}
        />
      ) : (
        <form
          id="create-channel-form"
          className={styles.form}
          inert={busy}
          aria-busy={busy || undefined}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <ChannelTextField
            field="name"
            creation
            inputRef={input}
            value={name}
            error={name ? errors.name : undefined}
            onChange={(value) => {
              setName(value);
              setError("");
            }}
          />
          <ChannelTextField
            field="description"
            value={description}
            error={errors.description}
            onChange={(value) => {
              setDescription(value);
              setError("");
            }}
          />
          {templates.length > 0 && (
            <div ref={templateField} style={{ display: "contents" }}>
              <Select
                label="Template"
                variant="field"
                value={templateId}
                description={
                  checkingAgents
                    ? "Checking which of its agents are in this community…"
                    : templateNote
                }
                error={
                  (unresolved && !checkingAgents) ||
                  (needsAgents && retrying) ? (
                    <>
                      Its agents can’t be checked right now, so they can’t be
                      added. Retry, or choose None to create the channel without
                      them.{" "}
                      <Button
                        ref={retryButton}
                        size="xs"
                        variant="outline"
                        loading={retrying}
                        onClick={() => void retryAgents()}
                      >
                        Retry
                      </Button>
                    </>
                  ) : undefined
                }
                groups={[
                  {
                    label: "",
                    options: [
                      { value: "", label: "None" },
                      ...templates.map((item) => ({
                        value: item.id,
                        label: item.name,
                      })),
                    ],
                  },
                ]}
                onValueChange={(value) => {
                  if (!editing.current) return;
                  setTemplateId(value);
                  setError("");
                }}
              />
            </div>
          )}
          <ChannelDurationField
            temporary={lifetime === "temporary"}
            ttlSeconds={temporaryTtl}
            onChange={(ttlSeconds) => {
              if (!editing.current) return;
              setLifetime(ttlSeconds === undefined ? "ongoing" : "temporary");
              if (ttlSeconds !== undefined) setTemporaryTtl(ttlSeconds);
              setError("");
            }}
          />
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
        </form>
      )}
    </Dialog>
  );
}
