import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AgentSaveButton } from "../../../features/agents/AgentSaveButton";
import { ModelFamilyMenu } from "../../../features/agents/ModelFamilyMenu";
import { BuilderlabLogoIcon } from "../../../shared/design-system/icons";
import { Button } from "../../../shared/design-system/ui/Button";
import { Field } from "../../../shared/design-system/ui/Field";
import { LoadingRegion } from "../../../shared/design-system/ui/LoadingRegion";
import { PreferenceRow } from "../../../shared/design-system/ui/PreferenceRow";
import { Select } from "../../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../../shared/design-system/ui/SettingsGroup";
import { Textarea } from "../../../shared/design-system/ui/Textarea";
import { useToastNotification } from "../../../shared/design-system/ui/Toast";
import {
  MAX_INSTRUCTIONS_LENGTH,
  validInstructions,
  type AgentClient,
  type RemoteAgent,
  type RemoteAgentModel,
} from "../agents/client";
import type { BuilderlabSession } from "../session";
import { AccountRecoverySheet, SettingsErrorSheet } from "./SignInFooter";
import { SignInAction } from "./SignInAction";
import { effortLabel, modelChoice } from "./models";

const statuses = {
  "setup-required": "Choose a model and thinking level to finish setup.",
  "model-unavailable":
    "The saved model is no longer available. Choose another model and thinking level.",
  "effort-unsupported":
    "The saved thinking level is no longer supported. Choose a supported level.",
  unknown:
    "The server has not confirmed the saved model selection. Choose a model and thinking level.",
};
const message = (reason: unknown) =>
  reason instanceof Error
    ? reason.message
    : typeof reason === "string"
      ? reason
      : "Could not load model settings.";
const accessDenied = (reason: unknown) =>
  reason instanceof Error && "status" in reason && reason.status === 403;
const accountMismatchMessage =
  "Sign in to the Builderlab account that loaded these settings.";

export function ModelSettings({
  client,
  session,
  settings,
  harnessControl,
}: {
  client: AgentClient;
  session: BuilderlabSession;
  harnessControl?: (action: ReactNode) => ReactNode;
  settings:
    | { agent: RemoteAgent; subject: string; email?: string }
    | { pending: boolean; error: unknown; retry(): void };
}) {
  const login = useSyncExternalStore(session.subscribe, session.snapshot);
  const [retrySignIn, setRetrySignIn] = useState<
    "switching" | "waiting" | "ready"
  >();
  const reducedMotion = useReducedMotion();
  const signedIn = login.status === "signed-in";
  useEffect(() => {
    // Native sign-out completes asynchronously; only its published state
    // starts the browser account-switch wait.
    if (retrySignIn === "switching") {
      if (login.status === "signed-out") setRetrySignIn("waiting");
      return;
    }
    if (signedIn) {
      setRetrySignIn(undefined);
      return;
    }
    if (retrySignIn !== "waiting") return;
    const timer = setTimeout(() => setRetrySignIn("ready"), 3000);
    return () => clearTimeout(timer);
  }, [login.status, signedIn, retrySignIn]);
  const agent = "agent" in settings ? settings.agent : undefined;
  const subject = "subject" in settings ? settings.subject : undefined;
  const mismatch =
    signedIn && subject !== undefined && login.account?.subject !== subject;
  const email = mismatch && "email" in settings ? settings.email : undefined;
  const form = useId();
  const notify = useToastNotification();
  const [saved, setSaved] = useState(agent);
  const [models, setModels] = useState<readonly RemoteAgentModel[]>();
  const [modelId, setModelId] = useState(agent?.modelId ?? "");
  const [effort, setEffort] = useState(agent?.reasoningEffort ?? "");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>("");
  const [catalogError, setCatalogError] = useState<unknown>("");
  const loadError = "error" in settings ? settings.error : "";
  const accessError = [loadError, error, catalogError].find(accessDenied);
  const accountProblem =
    signedIn &&
    (mismatch || login.account?.canUseRemoteAgents === false || !!accessError);
  const hasAccess = signedIn && !accountProblem;
  const busy = !saved || loading || saving || !hasAccess;
  useEffect(() => {
    if (!signedIn) {
      setError("");
      setCatalogError("");
    }
  }, [signedIn]);
  const [revision, setRevision] = useState(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    return () => current.abort();
  }, []);
  useEffect(() => {
    if (!agent) return;
    setSaved(agent);
    setModelId(agent.modelId ?? "");
    setEffort(agent.reasoningEffort ?? "");
    setInstructions(agent.instructions ?? "");
  }, [agent]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision retries a failed catalog request while keeping the draft.
  useEffect(() => {
    if (!agent || login.status !== "signed-in") return;
    if (!hasAccess) {
      setLoading(false);
      return;
    }
    const current = new AbortController();
    setLoading(true);
    setCatalogError("");
    void client
      .modelCatalog(current.signal)
      .then(
        (catalog) => {
          if (!current.signal.aborted) setModels(catalog);
        },
        (reason) => {
          if (!current.signal.aborted) setCatalogError(reason);
        },
      )
      .finally(() => {
        if (!current.signal.aborted) setLoading(false);
      });
    return () => current.abort();
  }, [client, agent, revision, login, hasAccess]);
  const model = models?.find((choice) => choice.id === modelId);
  const valid = !!model?.supportedReasoningEfforts.includes(effort);
  const modelChanged =
    modelId !== (saved?.modelId ?? "") ||
    effort !== (saved?.reasoningEffort ?? "");
  const instructionsChanged = instructions !== (saved?.instructions ?? "");
  const saveModel =
    modelChanged ||
    (!instructionsChanged && saved?.modelSelectionStatus !== "valid");
  const disabled =
    !hasAccess ||
    !saved ||
    saving ||
    !validInstructions(instructions) ||
    (!instructionsChanged && !saveModel) ||
    (saveModel && (loading || !valid));
  const save = async () => {
    if (disabled || !saved) return;
    const signal = controller.current?.signal;
    if (!signal) return;
    setSaving(true);
    setError("");
    try {
      if (session.credential().account.subject !== subject)
        throw new Error(accountMismatchMessage);
      if (saved.status !== "Active")
        throw new Error("Only Active agents can have their settings edited.");
      if (saveModel && instructionsChanged)
        await client.configure(
          saved.pubkey,
          {
            instructions,
            modelId,
            reasoningEffort: effort,
          },
          signal,
        );
      else if (saveModel)
        await client.updateModel(saved, modelId, effort, signal);
      else await client.updateInstructions(saved, instructions, signal);
      signal.throwIfAborted();
      if (!saveModel) {
        setSaved({ ...saved, instructions });
        return;
      }
      const remote = (await client.list(signal)).find(
        (row) => row.pubkey === saved.pubkey,
      );
      signal.throwIfAborted();
      if (!remote)
        throw new Error("Agent not found in this Builderlab account.");
      // Model readback must not replace the instructions draft with an omitted
      // or stale value. Only model fields need server validity confirmation.
      setSaved({ ...remote, instructions });
      setModelId(remote.modelId ?? "");
      setEffort(remote.reasoningEffort ?? "");
      if (remote.modelSelectionStatus === "valid")
        notify("Model preferences saved", "success");
    } catch (reason) {
      if (!signal.aborted && session.snapshot().status === "signed-in")
        setError(reason);
    } finally {
      if (!signal.aborted) setSaving(false);
    }
  };
  const pending =
    hasAccess && ("pending" in settings ? settings.pending : loading);
  const [slow, setSlow] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each agent/catalog retry starts a new loading phase, even if pending stays true.
  useEffect(() => {
    setSlow(false);
    if (!pending) return;
    const timer = setTimeout(() => setSlow(true), 3000);
    return () => clearTimeout(timer);
  }, [pending, agent, revision]);
  const placeholder =
    login.status !== "signed-in"
      ? ""
      : pending
        ? slow
          ? "Still loading…"
          : "…"
        : "—";
  const failure = hasAccess ? loadError || error || catalogError : "";
  return (
    <LoadingRegion
      pending={pending}
      label={agent ? "Loading models…" : "Loading settings…"}
      statusVisibility="screen-reader"
      feedback={
        hasAccess && !failure && slow && pending ? (
          <div className="grid justify-items-start gap-2">
            <p role="status" className="m-0 text-body-sm text-secondary">
              {agent
                ? "Models are taking longer to load."
                : "Settings are taking longer to load."}
            </p>
            <Button
              onClick={() => {
                if ("retry" in settings) settings.retry();
                else setRevision((value) => value + 1);
              }}
            >
              {agent ? "Retry models" : "Retry"}
            </Button>
          </div>
        ) : undefined
      }
    >
      <AccountRecoverySheet
        session={session}
        active={accountProblem}
        onSwitchAccount={() => setRetrySignIn("switching")}
        email={email}
        mismatch={mismatch}
        detail={accessError ? message(accessError) : undefined}
      />
      <SettingsErrorSheet
        active={!!failure}
        title={
          loadError
            ? "Couldn’t load settings"
            : error
              ? "Couldn’t save changes"
              : "Couldn’t load models"
        }
        message={message(failure)}
        action={{
          label: loadError ? "Retry" : error ? "Try again" : "Retry models",
          disabled: loadError ? false : error ? disabled : busy,
          run: () => {
            if (loadError && "retry" in settings) settings.retry();
            else if (error) void save();
            else setRevision((value) => value + 1);
          },
        }}
      />
      <form
        id={form}
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {hasAccess && saved && saved.modelSelectionStatus !== "valid" && (
          <p role="status" className="m-0 text-body-sm text-warning">
            {statuses[saved.modelSelectionStatus ?? "unknown"]}
            {saved.modelId &&
              ` Saved model: ${models?.find((choice) => choice.id === saved.modelId)?.displayName ?? saved.modelId}.`}
            {saved.reasoningEffort &&
              ` Saved thinking: ${effortLabel(saved.reasoningEffort)}.`}
          </p>
        )}
        <SettingsGroup>
          <SignInAction
            session={session}
            automatic
            retry={
              retrySignIn
                ? {
                    waiting: retrySignIn === "waiting",
                    cancel: () => setRetrySignIn("ready"),
                  }
                : undefined
            }
            render={(action, feedback) => (
              <div>
                {harnessControl?.(action) ?? (
                  <PreferenceRow
                    title="Harness"
                    trailing={
                      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                        <span className="flex min-w-0 items-center gap-2">
                          <BuilderlabLogoIcon size={20} aria-hidden="true" />
                          Builderlab
                        </span>
                        {action}
                      </div>
                    }
                  />
                )}
                {login.status === "signed-out" && retrySignIn !== "waiting" && (
                  <p className="m-0 pb-3 text-body-sm text-secondary">
                    Sign in to edit settings. You can still message this agent.
                  </p>
                )}
                {feedback && <div className="pb-3">{feedback}</div>}
              </div>
            )}
          />
          <ModelFamilyMenu
            label="Model"
            align="end"
            selected={
              model
                ? modelChoice(model)
                : {
                    id: "",
                    label: models?.length ? "Choose a model" : placeholder,
                  }
            }
            models={(models ?? []).map(modelChoice)}
            disabled={busy || !models?.length}
            onChange={(next) => {
              setModelId(next);
              setEffort("");
            }}
          />
          <Select
            label="Thinking"
            variant="preference"
            align="end"
            value={valid ? effort : ""}
            placeholder={models?.length ? "Choose thinking" : placeholder}
            disabled={busy || !model}
            groups={[
              {
                label: "",
                options: (model?.supportedReasoningEfforts ?? []).map(
                  (value) => ({ value, label: effortLabel(value) }),
                ),
              },
            ]}
            onValueChange={setEffort}
          />
        </SettingsGroup>
        {hasAccess && models?.length === 0 && (
          <p className="m-0 text-body-sm text-secondary">
            No models are available. Retry when the catalog is available.
          </p>
        )}
        <AnimatePresence initial={false}>
          {signedIn && (
            <motion.div
              key="instructions"
              initial={{
                opacity: reducedMotion ? 1 : 0,
                y: reducedMotion ? 0 : 8,
              }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reducedMotion ? 0 : 0.22 }}
            >
              <Field
                label="Instructions"
                error={
                  hasAccess && !validInstructions(instructions)
                    ? "Use text or leave this empty."
                    : undefined
                }
              >
                <Textarea
                  appearance="outlined"
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                  disabled={!saved || saving || !hasAccess}
                  rows={8}
                  maxLength={MAX_INSTRUCTIONS_LENGTH}
                />
              </Field>
            </motion.div>
          )}
        </AnimatePresence>
        <AgentSaveButton
          form={form}
          saving={saving}
          disabled={disabled}
          dirty={modelChanged || instructionsChanged}
        />
        {hasAccess && !failure && models?.length === 0 && (
          <div>
            <Button
              disabled={busy}
              onClick={() => setRevision((value) => value + 1)}
            >
              Retry models
            </Button>
          </div>
        )}
      </form>
    </LoadingRegion>
  );
}
