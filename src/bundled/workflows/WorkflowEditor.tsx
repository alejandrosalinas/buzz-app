import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { DotsThreeIcon } from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Button } from "../../shared/design-system/ui/Button";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
} from "../../shared/design-system/ui/Menu";
import { SwitchPreferenceRow } from "../../shared/design-system/ui/SwitchPreferenceRow";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { ConfirmAction } from "./ConfirmAction";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { WorkflowForm, type WorkflowSelection } from "./WorkflowForm";
import { conditionRowError } from "./workflowConditionExpression";
import { draftIssue } from "./editor-model";
import { getWorkflowActivationWarning } from "./workflowActivationWarning";
import {
  formStateToYaml,
  yamlToFormState,
  type WorkflowFormState,
} from "./workflowFormTypes";
import {
  readWorkflowDocumentFields,
  yamlWithWorkflowEnabled,
  yamlWithWorkflowName,
} from "./workflowYamlDocument";

export function WorkflowEditor({
  yaml,
  initialYaml,
  onChange,
  onSave,
  onLocalDraftRiskChange,
  readOnly = false,
  blocked,
  enableBlocked,
  busy = false,
  locked = false,
  onCancel,
  scope,
  actions,
  run,
  runs,
  details,
  status,
  children,
  create = false,
  chooseChannel = false,
}: {
  yaml: string;
  initialYaml?: string | undefined;
  onChange: (yaml: string) => void;
  onSave: () => void;
  onLocalDraftRiskChange?: (atRisk: boolean) => void;
  readOnly?: boolean;
  blocked?: string | undefined;
  /** Why a draft that is off can't be turned on; turning off stays available. */
  enableBlocked?: string | undefined;
  busy?: boolean;
  locked?: boolean;
  onCancel?: () => void;
  scope?: ReactNode;
  actions?: ReactNode;
  run?: ReactNode;
  runs?: ReactNode;
  details?: ReactNode;
  status?: ReactNode;
  children?: ReactNode;
  create?: boolean;
  chooseChannel?: boolean;
}) {
  const id = useId();
  const heading = useRef<HTMLSpanElement>(null);
  const [selection, setSelection] = useState<WorkflowSelection>(
    create && !chooseChannel ? { type: "trigger" } : null,
  );
  const [mode, setMode] = useState<"form" | "yaml" | "runs">(() =>
    yamlToFormState(yaml).ok ? "form" : "yaml",
  );
  const [formDraft, setFormDraft] = useState<WorkflowFormState | null>(null);
  const [formYaml, setFormYaml] = useState(yaml);
  const [activating, setActivating] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const fields = readWorkflowDocumentFields(yaml);
  const parsed = yamlToFormState(yaml);
  // An incomplete form is still an editable draft. An external YAML change must
  // be reparsed instead of reviving stale form state.
  const form =
    formYaml === yaml && formDraft
      ? formDraft
      : parsed.ok
        ? parsed.state
        : null;
  const issue = draftIssue(yaml);
  const conditionError = form?.trigger.conditionRows
    ?.map(conditionRowError)
    .find(Boolean);
  const headerError = form?.steps.some(
    (step) =>
      step.headers &&
      new Set(step.headers.map((header) => header.name)).size !==
        step.headers.length,
  )
    ? "Header names must be unique."
    : undefined;
  // Invalid form-only values may serialize to unchanged YAML. Keep them in
  // the channel's existing leave/unload guard without creating another draft owner.
  const localDraftAtRisk =
    formYaml === yaml && !!formDraft && !!(conditionError || headerError);
  useEffect(() => {
    onLocalDraftRiskChange?.(localDraftAtRisk);
    return () => onLocalDraftRiskChange?.(false);
  }, [localDraftAtRisk, onLocalDraftRiskChange]);
  const error = issue?.message || conditionError || headerError;
  const showingForm = mode === "form" && !!form;
  const mutateForm = (state: WorkflowFormState) => {
    const next = formStateToYaml(state);
    setFormDraft(state);
    setFormYaml(next);
    onChange(next);
  };
  const changeHeader = (
    next: string | null,
    patch: Partial<WorkflowFormState>,
  ) => {
    if (next === null) return;
    if (form) {
      setFormDraft({ ...form, ...patch });
      setFormYaml(next);
    }
    onChange(next);
  };
  const warning = getWorkflowActivationWarning(yaml);
  const submit = () => {
    if (readOnly || busy || locked || blocked || error) return;
    const wasEnabled =
      initialYaml !== undefined &&
      readWorkflowDocumentFields(initialYaml).enabled !== false;
    if (fields.enabled !== false && !wasEnabled && warning) setActivating(true);
    else onSave();
  };
  const disabled = readOnly || busy || locked || chooseChannel;
  const controlReason = readOnly
    ? "Only the author can change this workflow."
    : (blocked ??
      (busy || locked
        ? "Review Recent activity before editing."
        : chooseChannel
          ? "Choose a channel before editing."
          : !fields.editable
            ? "Correct the YAML before changing the name or configuration."
            : undefined));
  const enableReason = fields.enabled === false ? enableBlocked : undefined;
  const enableSwitch = fields.editable ? (
    <SwitchPreferenceRow
      label="Enabled in configuration"
      description={
        enableReason ??
        // In YAML view the status line directly below already shows the reason.
        (mode === "form" || readOnly ? controlReason : undefined) ??
        "Configuration changes apply on save. Turning off does not confirm runs have stopped or cancel active runs."
      }
      checked={fields.enabled !== false}
      disabled={disabled || !!enableReason}
      onCheckedChange={(enabled) =>
        changeHeader(yamlWithWorkflowEnabled(yaml, enabled), { enabled })
      }
    />
  ) : (
    <span className="text-body-sm text-secondary">
      Unreadable configuration
    </span>
  );
  const modeTabs = (
    <Tabs
      variant="panel"
      label="Editor mode"
      value={mode}
      items={[
        { value: "form", label: "Form" },
        { value: "yaml", label: "YAML" },
        ...(runs ? [{ value: "runs" as const, label: "Runs" }] : []),
      ]}
      onValueChange={(next) => {
        if (next === "runs") {
          setModeError(null);
          setSelection(null);
          setMode(next);
          return;
        }
        if (next === "yaml" && (conditionError || headerError)) {
          setModeError(
            "Correct the invalid condition or duplicate header before switching views.",
          );
          return;
        }
        if (next === "form" && !form) {
          setModeError(parsed.ok ? null : parsed.error);
          return;
        }
        setModeError(null);
        setSelection(null);
        setMode(next);
      }}
    />
  );
  return (
    <Dialog
      open
      initialFocus={heading}
      title={
        <span ref={heading} tabIndex={-1}>
          {create ? "Create workflow" : fields.name || "Untitled workflow"}
        </span>
      }
      closeLabel="Close editor"
      size="wide"
      height="stable-tall"
      onOpenChange={(open) => {
        if (!open) onCancel?.();
      }}
      onEscape={() => {
        if (!selection) return false;
        setSelection(null);
        return true;
      }}
      headerActions={
        !create && (
          <>
            {run}
            {actions && (
              <MenuRoot>
                <MenuTrigger
                  render={
                    <IconButton
                      aria-label="Workflow actions"
                      icon={<DotsThreeIcon size={20} aria-hidden="true" />}
                    />
                  }
                />
                <MenuPopup align="end">{actions}</MenuPopup>
              </MenuRoot>
            )}
          </>
        )
      }
      actions={
        !readOnly && (
          <>
            {onCancel && <Button onClick={onCancel}>Cancel</Button>}
            <Button
              variant="prominent"
              focusableWhenDisabled={busy || locked}
              disabled={
                disabled ||
                (!!blocked && !chooseChannel) ||
                (!!error && !(showingForm && form?.steps.length === 0))
              }
              onClick={() => {
                if (showingForm && form && !form.steps.length) {
                  mutateForm({
                    ...form,
                    steps: [{ id: "step_1", action: "send_message", text: "" }],
                  });
                  setSelection({ type: "step", id: "step_1" });
                } else submit();
              }}
            >
              {busy
                ? create
                  ? "Creating…"
                  : "Saving…"
                : showingForm && !form?.steps.length
                  ? "Add step"
                  : create
                    ? "Create workflow"
                    : "Save changes"}
            </Button>
          </>
        )
      }
    >
      <section aria-label="Workflow editor" className="workflow-editor">
        {!chooseChannel && (
          <div className="workflow-editor-tabs">{modeTabs}</div>
        )}
        {readOnly && (
          <span id={`${id}-control-reason`} hidden>
            {controlReason}
          </span>
        )}
        <div className="workflow-editor-body">
          {modeError && (
            <p role="alert" className="text-danger">
              Cannot switch editor view: {modeError}
            </p>
          )}
          {chooseChannel ? (
            scope
          ) : mode === "runs" ? (
            runs
          ) : mode === "form" && form ? (
            <WorkflowForm
              state={form}
              issue={issue}
              onChange={mutateForm}
              disabled={disabled}
              selection={selection}
              onSelect={setSelection}
              overview={
                <div className="workflow-form">
                  <Field
                    label="Workflow name"
                    error={issue?.field === "name" ? error : undefined}
                  >
                    <Input
                      id={`${id}-1`}
                      value={fields.name ?? ""}
                      disabled={disabled || !fields.editable}
                      autoCapitalize="off"
                      aria-describedby={
                        controlReason ? `${id}-control-reason` : undefined
                      }
                      onValueChange={(name) =>
                        changeHeader(yamlWithWorkflowName(yaml, name), {
                          name,
                        })
                      }
                    />
                  </Field>
                  <Field label="Description">
                    <Textarea
                      value={form.description}
                      rows={2}
                      placeholder="What does this workflow do?"
                      disabled={disabled}
                      onChange={(event) =>
                        mutateForm({
                          ...form,
                          description: event.currentTarget.value,
                        })
                      }
                    />
                  </Field>
                  {scope && (
                    <Field label="Channel">
                      <span className="text-body">{scope}</span>
                    </Field>
                  )}
                  {enableSwitch}
                  {details}
                </div>
              }
            />
          ) : (
            <div className="workflow-form">
              <Field
                label="Workflow YAML"
                error={error}
                description="Original text is kept until you edit. Form changes may reformat YAML. Schedules use UTC."
              >
                <Textarea
                  id={`${id}-yaml`}
                  variant="code"
                  rows={18}
                  spellCheck={false}
                  autoCapitalize="off"
                  readOnly={disabled}
                  value={yaml}
                  onChange={(event) => {
                    setFormDraft(null);
                    setModeError(null);
                    onChange(event.currentTarget.value);
                  }}
                />
              </Field>
              {enableSwitch}
              {details}
            </div>
          )}
          {error &&
            // Runs and step settings hide the field an error belongs to.
            (mode === "runs" ||
              (showingForm &&
                !!form?.steps.length &&
                (!issue?.field ||
                  conditionError ||
                  headerError ||
                  (!!selection && issue.field === "name")))) && (
              <p role="status" className="text-danger">
                {error}
              </p>
            )}
        </div>
        <div className="workflow-editor-status">
          {!readOnly && controlReason && (
            <p
              id={`${id}-control-reason`}
              role="status"
              className="text-body-sm text-secondary"
            >
              {controlReason}
            </p>
          )}
          {status}
        </div>
        {activating && (
          <ConfirmAction
            title={warning?.title ?? "Save this workflow enabled?"}
            description={
              warning?.description ??
              "The relay may run this workflow automatically when its trigger matches. Saving does not prove a run succeeded."
            }
            action="Save enabled workflow"
            onCancel={() => setActivating(false)}
            onConfirm={() => {
              setActivating(false);
              onSave();
            }}
          />
        )}
        {children}
      </section>
    </Dialog>
  );
}
