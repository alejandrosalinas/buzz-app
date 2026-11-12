import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { AgentInstructions } from "../../../features/agents/AgentInstructions";
import { ModelFamilyMenu } from "../../../features/agents/ModelFamilyMenu";
import type { AgentCreateProps } from "../../../features/agents/service";
import { focusWithKeyboard } from "../../../shared/design-system/useKeyboardFocusVisibility";
import { Button } from "../../../shared/design-system/ui/Button";
import { Select } from "../../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../../shared/design-system/ui/SettingsGroup";
import inlineStyles from "../../../shared/InlineReference.module.css";
import {
  type AgentClient,
  MAX_INSTRUCTIONS_LENGTH,
  type RemoteAgentModelCatalog,
  validInstructions,
} from "../agents/client";
import { oauthTarget } from "../oauth/browser";
import type { BuilderlabSession } from "../session";
import { SignInAction } from "./SignInAction";
import { effortLabel, modelChoice } from "./models";

export type CreationConfig = {
  instructions: string;
  modelId: string;
  reasoningEffort: string;
  subject?: string;
};
export const EMPTY_CREATION: CreationConfig = {
  instructions: "",
  modelId: "",
  reasoningEffort: "",
};

export function creationConfig(value: unknown): CreationConfig {
  const config = value as Partial<CreationConfig> | undefined;
  if (
    !config ||
    !validInstructions(config.instructions) ||
    typeof config.modelId !== "string" ||
    !config.modelId.trim() ||
    typeof config.reasoningEffort !== "string" ||
    !config.reasoningEffort.trim() ||
    typeof config.subject !== "string"
  )
    throw new Error(
      "Choose a model and thinking level and check the instructions.",
    );
  return config as CreationConfig;
}

export function createCreationAction(session: BuilderlabSession) {
  return function CreationAction({ disabled }: { disabled: boolean }) {
    return <SignInAction session={session} disabled={disabled} />;
  };
}

export function createCreationFields(
  client: AgentClient,
  session: BuilderlabSession,
) {
  function CreateConfiguration({
    config,
    onChange,
    disabled,
    harnessControl,
    onReadyChange,
  }: AgentCreateProps & {
    harnessControl: ReactNode;
    onReadyChange?: (ready: boolean) => void;
  }) {
    const draft = config as CreationConfig;
    const login = useSyncExternalStore(session.subscribe, session.snapshot);
    const [catalog, setCatalog] = useState<
      RemoteAgentModelCatalog & { login: typeof login }
    >();
    const loaded = catalog?.login === login ? catalog : undefined;
    const models = loaded?.models;
    const [error, setError] = useState("");
    const [revision, setRevision] = useState(0);
    const controls = useRef<HTMLDivElement>(null);
    // The account's own site: the configured Builderlab server, deployment
    // path kept. oauthTarget validates it as the server creation signs in to.
    oauthTarget();
    const portal = new URL(import.meta.env.VITE_BUZZ_BUILDERLAB_URL ?? "");
    // biome-ignore lint/correctness/useExhaustiveDependencies: revision retries catalog loading without changing the draft.
    useEffect(() => {
      if (login.status !== "signed-in") return;
      const controller = new AbortController();
      setCatalog(undefined);
      setError("");
      void client.modelCatalog(controller.signal).then(
        (next) => {
          if (!controller.signal.aborted) setCatalog({ ...next, login });
        },
        (reason) => {
          if (!controller.signal.aborted)
            setError(
              reason instanceof Error
                ? reason.message
                : "Could not load models.",
            );
        },
      );
      return () => controller.abort();
    }, [client, login, revision]);
    const suggestion = useRef<CreationConfig>(undefined);
    // biome-ignore lint/correctness/useExhaustiveDependencies: each loaded catalog suggests once; later draft edits are the person's.
    useEffect(() => {
      if (!loaded || !login.account) return;
      const last = suggestion.current;
      const suggested =
        draft.modelId === last?.modelId &&
        draft.reasoningEffort === last.reasoningEffort &&
        draft.subject === last.subject;
      const blank = !draft.modelId && !draft.reasoningEffort;
      // Only blank or still-suggested choices follow a newly loaded catalog.
      if (!suggested && !(blank && loaded.recommended)) return;
      const next = {
        ...draft,
        modelId: "",
        reasoningEffort: "",
        ...loaded.recommended,
        subject: login.account.subject,
      };
      suggestion.current = next;
      onChange(next, { suggested: true });
    }, [catalog]);
    const signedIn = login.status === "signed-in";
    const choicesDisabled = disabled || !signedIn || !models?.length;
    const model = models?.find((choice) => choice.id === draft.modelId);
    const supported = !!model?.supportedReasoningEfforts.includes(
      draft.reasoningEffort,
    );
    const wrongAccount =
      draft.subject && draft.subject !== login.account?.subject;
    const ready =
      login.status === "signed-in" &&
      !login.checking &&
      !!model &&
      supported &&
      draft.subject === login.account?.subject &&
      validInstructions(draft.instructions);
    useLayoutEffect(() => {
      onReadyChange?.(ready);
    }, [onReadyChange, ready]);
    return (
      <div ref={controls} className="grid gap-4">
        {login.status === "signed-in" && !!models?.length && (
          <input
            className="sr-only"
            name="builderlab-model"
            value={model ? draft.modelId : ""}
            required
            disabled={disabled}
            tabIndex={-1}
            aria-hidden="true"
            onChange={() => {}}
            onFocus={() => {
              const trigger =
                controls.current?.querySelector<HTMLButtonElement>(
                  'button[aria-haspopup="menu"]',
                );
              if (trigger) focusWithKeyboard(trigger);
            }}
          />
        )}
        <SettingsGroup>
          {harnessControl}
          <ModelFamilyMenu
            label="Model"
            align="end"
            selected={
              model ? modelChoice(model) : { id: "", label: "Choose a model" }
            }
            models={(models ?? []).map(modelChoice)}
            disabled={choicesDisabled}
            onChange={(modelId) => {
              suggestion.current = undefined;
              onChange({
                ...draft,
                modelId,
                reasoningEffort: "",
                subject: login.account?.subject,
              });
            }}
          />
          <Select
            label="Thinking"
            variant="preference"
            align="end"
            name="builderlab-effort"
            required
            value={supported ? draft.reasoningEffort : ""}
            placeholder="Choose thinking"
            disabled={choicesDisabled || !model || !!wrongAccount}
            groups={[
              {
                label: "",
                options: (model?.supportedReasoningEfforts ?? []).map(
                  (value) => ({ value, label: effortLabel(value) }),
                ),
              },
            ]}
            onValueChange={(reasoningEffort) => {
              suggestion.current = undefined;
              onChange({ ...draft, reasoningEffort });
            }}
          />
        </SettingsGroup>
        <p className="m-0 text-body-sm text-secondary">
          Runs on your Builderlab account. Usage and billing are at{" "}
          <a
            className={inlineStyles.link}
            href={portal.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {`${portal.host}${portal.pathname.replace(/\/$/, "")}`}
          </a>
          .
        </p>
        {signedIn && wrongAccount && (
          <p role="status" className="m-0 text-body-sm text-secondary">
            These choices belong to another Builderlab account. Choose a model
            and thinking level again.
          </p>
        )}
        {signedIn && !models?.length && (
          <p
            role={error ? "alert" : "status"}
            className={`m-0 text-body-sm ${error ? "text-danger" : "text-secondary"}`}
          >
            {models
              ? "No models are available. Retry when the catalog is available."
              : error || "Loading models…"}
          </p>
        )}
        {login.status === "signed-in" && (error || models?.length === 0) && (
          <div>
            <Button
              disabled={disabled}
              onClick={() => setRevision((value) => value + 1)}
            >
              Retry models
            </Button>
          </div>
        )}
      </div>
    );
  }

  function Create({ config, onChange, disabled }: AgentCreateProps) {
    const draft = config as CreationConfig;
    return (
      <AgentInstructions
        creation
        description={`Up to ${MAX_INSTRUCTIONS_LENGTH.toLocaleString("en-US")} characters.`}
        value={draft.instructions}
        disabled={disabled}
        onChange={(instructions) => onChange({ ...draft, instructions })}
      />
    );
  }

  return { Create, CreateConfiguration };
}
