import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownIcon,
  CalendarIcon,
  ChatCircleIcon,
  GitPullRequestIcon,
  PlusIcon,
  SmileyIcon,
  TrashIcon,
  TimerIcon,
  WebhooksLogoIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import {
  MenuItem,
  MenuIcon,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { Select } from "../../shared/design-system/ui/Select";
import { Switch } from "../../shared/design-system/ui/Switch";
import { WorkflowMessageText } from "./WorkflowMessageText";
import { WorkflowConditions } from "./WorkflowConditions";
import { WorkflowWebhookFields } from "./WorkflowWebhookFields";
import { WorkflowScheduleFields } from "./WorkflowScheduleFields";
import { formWithStep, type WorkflowDraftIssue } from "./editor-model";
import {
  ACTION_LABELS,
  isThreadReplyEligibleTrigger,
  isTriggerType,
  nextStepId,
  withTriggerType,
  type ActionType,
  type StepFormState,
  type TriggerType,
  type WorkflowFormState,
} from "./workflowFormTypes";
import { defaultScheduleTrigger } from "./workflowSchedule";

const TRIGGERS: Record<
  TriggerType,
  { label: string; icon: typeof CalendarIcon }
> = {
  message_posted: { label: "Message posted", icon: ChatCircleIcon },
  reaction_added: { label: "Reaction added", icon: SmileyIcon },
  diff_posted: { label: "Diff posted", icon: GitPullRequestIcon },
  schedule: { label: "Schedule", icon: CalendarIcon },
  webhook: { label: "Webhook", icon: WebhooksLogoIcon },
};
export type WorkflowSelection =
  | { type: "trigger" }
  | { type: "step"; id: string }
  | null;

export function WorkflowForm({
  state,
  onChange,
  disabled,
  issue,
  selection,
  onSelect,
  overview,
}: {
  state: WorkflowFormState;
  onChange: (next: WorkflowFormState) => void;
  disabled: boolean;
  issue?: WorkflowDraftIssue | null | undefined;
  selection: WorkflowSelection;
  onSelect: (selection: WorkflowSelection) => void;
  overview?: ReactNode;
}) {
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const triggerNode = useRef<HTMLElement>(null);
  const stepNodes = useRef(new Map<string, HTMLElement>());
  const inspectorReturnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (selection) {
      inspectorReturnFocus.current =
        selection.type === "trigger"
          ? triggerNode.current
          : (stepNodes.current.get(selection.id) ?? null);
      // Selection can replace or disable the control that opened the inspector
      // (the empty draft's footer action, for example). Keep focus on its node.
      if (!narrow) inspectorReturnFocus.current?.focus();
    } else if (!narrow) {
      inspectorReturnFocus.current?.focus();
      inspectorReturnFocus.current = null;
    }
  }, [selection, narrow]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        setNarrow(
          entry.contentRect.width <=
            44 *
              parseFloat(getComputedStyle(document.documentElement).fontSize),
        );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const stepIndex =
    selection?.type === "step"
      ? state.steps.findIndex((step) => step.id === selection.id)
      : -1;
  const selectedStep = state.steps[stepIndex];
  const inspectorOpen = selection?.type === "trigger" || !!selectedStep;
  const TriggerIcon = TRIGGERS[state.trigger.on].icon;
  const addStep = (after: number, action: ActionType) => {
    if (disabled) return;
    const step: StepFormState = {
      id: nextStepId(state.steps),
      action,
      ...(action === "send_message"
        ? { text: "" }
        : action === "delay"
          ? { duration: "5m" }
          : { url: "" }),
    };
    const steps = [...state.steps];
    steps.splice(after + 1, 0, step);
    onChange({ ...state, steps });
    onSelect({ type: "step", id: step.id });
  };
  const addMenu = (after: number) => (
    <div
      className="workflow-connector"
      data-terminal={after === state.steps.length - 1 || undefined}
    >
      {after < state.steps.length - 1 && (
        <ArrowDownIcon size={18} aria-hidden="true" />
      )}
      <MenuRoot>
        <MenuTrigger
          render={
            <IconButton
              aria-label={
                after < 0 ? "Add step" : `Add after Step ${after + 1}`
              }
              icon={<PlusIcon size={16} aria-hidden="true" />}
              size="sm"
              variant="subtle"
              disabled={disabled}
            />
          }
        />
        <MenuPopup size="compact">
          <MenuItem onClick={() => addStep(after, "send_message")}>
            <MenuIcon>
              <ChatCircleIcon size={14} />
            </MenuIcon>
            Add Send Message
          </MenuItem>
          <MenuItem onClick={() => addStep(after, "delay")}>
            <MenuIcon>
              <TimerIcon size={14} />
            </MenuIcon>
            Add Delay
          </MenuItem>
          <MenuItem onClick={() => addStep(after, "call_webhook")}>
            <MenuIcon>
              <WebhooksLogoIcon size={14} />
            </MenuIcon>
            Add Call Webhook
          </MenuItem>
        </MenuPopup>
      </MenuRoot>
    </div>
  );
  const removeStep = () => {
    if (!selectedStep || disabled) return;
    onChange({
      ...state,
      steps: state.steps.filter((step) => step.id !== selectedStep.id),
    });
    const neighbor = state.steps[stepIndex - 1] ?? state.steps[stepIndex + 1];
    onSelect(
      neighbor ? { type: "step", id: neighbor.id } : { type: "trigger" },
    );
  };
  const inspector = (
    <>
      <div className="workflow-inspector-heading">
        <div>
          {selectedStep && (
            <p className="text-caption text-subtle">STEP {stepIndex + 1}</p>
          )}
          {selectedStep ? (
            <Select
              key="step-action"
              label="Step action"
              variant="field"
              disabled={disabled}
              value={selectedStep.action}
              groups={[
                {
                  label: "",
                  options: Object.entries(ACTION_LABELS).map(
                    ([value, label]) => ({ value, label }),
                  ),
                },
              ]}
              onValueChange={(action) => {
                if (
                  disabled ||
                  (action !== "delay" &&
                    action !== "send_message" &&
                    action !== "call_webhook") ||
                  action === selectedStep.action
                )
                  return;
                onChange({
                  ...state,
                  steps: state.steps.map((step) =>
                    step.id === selectedStep.id
                      ? {
                          id: step.id,
                          name: step.name,
                          timeoutSecs: step.timeoutSecs,
                          condition: step.condition,
                          action,
                          ...(action === "delay"
                            ? { duration: "5m" }
                            : action === "send_message"
                              ? { text: "" }
                              : { url: "" }),
                        }
                      : step,
                  ),
                });
              }}
            />
          ) : (
            <Select
              key="trigger-type"
              label="Trigger"
              variant="field"
              disabled={disabled}
              value={state.trigger.on}
              groups={[
                {
                  label: "",
                  options: Object.entries(TRIGGERS).map(
                    ([value, { label }]) => ({ value, label }),
                  ),
                },
              ]}
              onValueChange={(value) => {
                if (
                  disabled ||
                  !isTriggerType(value) ||
                  value === state.trigger.on
                )
                  return;
                const next = withTriggerType(state, value);
                onChange(
                  value === "schedule"
                    ? { ...next, trigger: defaultScheduleTrigger() }
                    : next,
                );
              }}
            />
          )}
        </div>
        <div className="workflow-inspector-actions">
          {selectedStep && (
            <IconButton
              hint="familiar"
              aria-label={`Remove step ${stepIndex + 1}`}
              title="Remove step"
              icon={<TrashIcon size={16} aria-hidden="true" />}
              disabled={disabled}
              onClick={removeStep}
            />
          )}
          {!narrow && (
            <IconButton
              aria-label="Close inspector"
              icon={<XIcon size={16} aria-hidden="true" />}
              onClick={() => onSelect(null)}
            />
          )}
        </div>
      </div>
      <fieldset className="workflow-form" disabled={disabled}>
        {selectedStep ? (
          <StepFields
            key={selectedStep.id}
            state={state}
            step={selectedStep}
            index={stepIndex}
            onChange={onChange}
            disabled={disabled}
            issue={issue}
          />
        ) : (
          <>
            {state.trigger.on === "reaction_added" && (
              <Field label="Emoji (optional)">
                <Input
                  id={`${id}-emoji`}
                  value={state.trigger.emoji ?? ""}
                  onValueChange={(emoji) =>
                    onChange({ ...state, trigger: { ...state.trigger, emoji } })
                  }
                />
              </Field>
            )}
            {state.trigger.on === "schedule" ? (
              <WorkflowScheduleFields
                disabled={disabled}
                trigger={state.trigger}
                onUpdate={(trigger) => onChange({ ...state, trigger })}
              />
            ) : state.trigger.on === "webhook" ? (
              <p className="text-body-sm text-subtle">
                A unique URL is generated after creation. Its address and
                one-time secret are shown once, after the first save.
              </p>
            ) : (
              <WorkflowConditions
                key={state.trigger.on}
                trigger={state.trigger}
                disabled={disabled}
                onChange={(patch) =>
                  onChange({
                    ...state,
                    trigger: { ...state.trigger, ...patch },
                  })
                }
              />
            )}
          </>
        )}
      </fieldset>
    </>
  );
  return (
    <div
      ref={container}
      className="workflow-builder"
      data-inspector={((inspectorOpen || !!overview) && !narrow) || undefined}
    >
      <div className="workflow-canvas">
        <ol className="workflow-flow" aria-label="Workflow sequence">
          <li className="workflow-flow-item">
            <NavigationItem
              ref={triggerNode}
              variant="row"
              aria-label={`Edit trigger: ${TRIGGERS[state.trigger.on].label}`}
              aria-current={false}
              aria-pressed={selection?.type === "trigger"}
              selected={selection?.type === "trigger"}
              icon={
                <span className="workflow-node-icon">
                  <TriggerIcon size={20} aria-hidden="true" />
                </span>
              }
              label={
                <span className="workflow-node-copy">
                  <span className="text-caption text-subtle">TRIGGER</span>
                  <span className="text-label">
                    {TRIGGERS[state.trigger.on].label}
                  </span>
                </span>
              }
              onClick={() => onSelect({ type: "trigger" })}
            />
            {addMenu(-1)}
          </li>
          {state.steps.map((step, index) => (
            <li key={step.id} className="workflow-flow-item">
              <NavigationItem
                ref={(node) => {
                  if (node) stepNodes.current.set(step.id, node);
                  else stepNodes.current.delete(step.id);
                }}
                variant="row"
                aria-label={`Edit step ${index + 1}: ${ACTION_LABELS[step.action]}`}
                aria-current={false}
                aria-pressed={
                  selection?.type === "step" && selection.id === step.id
                }
                selected={
                  selection?.type === "step" && selection.id === step.id
                }
                icon={
                  <span className="workflow-node-icon text-body-sm">
                    {index + 1}
                  </span>
                }
                label={
                  <span className="workflow-node-copy">
                    <span className="text-caption text-subtle">
                      {ACTION_LABELS[step.action].toUpperCase()}
                    </span>
                    <span className="workflow-node-summary text-label">
                      {step.action === "send_message"
                        ? step.text?.trim()
                          ? `“${step.text}”`
                          : "Write a message…"
                        : step.action === "delay"
                          ? step.duration || "Set a duration…"
                          : step.url || "Set a URL…"}
                    </span>
                  </span>
                }
                onClick={() => onSelect({ type: "step", id: step.id })}
              />
              {addMenu(index)}
            </li>
          ))}
        </ol>
        {!state.steps.length && (
          <p className="text-body-sm text-subtle">
            Add a step to decide what happens next.
          </p>
        )}
        {issue &&
          "stepIndex" in issue &&
          state.steps[issue.stepIndex] &&
          issue.stepIndex !== stepIndex && (
            <Button
              variant="ghost"
              onClick={() =>
                onSelect({
                  type: "step",
                  id: state.steps[issue.stepIndex]?.id ?? "",
                })
              }
            >
              Review step {issue.stepIndex + 1}: {issue.message}
            </Button>
          )}
      </div>
      {inspectorOpen && narrow && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) onSelect(null);
          }}
          title={
            selectedStep ? `Step ${stepIndex + 1} settings` : "Trigger settings"
          }
          placement="right"
          finalFocus={() => inspectorReturnFocus.current}
          motion="none"
          dismissOnOutsideClick
          closeLabel="Close inspector"
        >
          {inspector}
        </Dialog>
      )}
      {inspectorOpen && !narrow ? (
        <aside
          className="workflow-inspector"
          aria-label={
            selectedStep ? `Step ${stepIndex + 1} settings` : "Trigger settings"
          }
        >
          {inspector}
        </aside>
      ) : (
        overview && (
          <aside className="workflow-inspector" aria-label="Workflow settings">
            {overview}
          </aside>
        )
      )}
    </div>
  );
}

function StepFields({
  state,
  step,
  index,
  onChange,
  disabled,
  issue,
}: {
  state: WorkflowFormState;
  step: StepFormState;
  index: number;
  onChange: (next: WorkflowFormState) => void;
  disabled: boolean;
  issue?: WorkflowDraftIssue | null | undefined;
}) {
  const id = useId();
  const error = (field: "text" | "duration" | "timeout" | "url" | "headers") =>
    issue &&
    "stepIndex" in issue &&
    issue.stepIndex === index &&
    issue.field === field
      ? issue.message
      : undefined;
  const update = (patch: Partial<StepFormState>) =>
    onChange(formWithStep(state, step.id, patch));
  const [expanded, setExpanded] = useState<string[]>([]);
  const timeoutError = error("timeout");
  useEffect(() => {
    if (timeoutError)
      setExpanded((current) =>
        current.includes("run") ? current : [...current, "run"],
      );
  }, [timeoutError]);
  return (
    <>
      {step.action === "call_webhook" ? (
        <WorkflowWebhookFields
          step={step}
          disabled={disabled}
          update={update}
          urlError={error("url")}
          headersError={error("headers")}
        />
      ) : step.action === "send_message" ? (
        <Field
          label="Message text"
          error={error("text")}
          description="Messages post to the workflow channel unless a destination is set below."
        >
          <WorkflowMessageText
            id={`${id}-text`}
            value={step.text ?? ""}
            rows={4}
            autoCapitalize="off"
            onValueChange={(text) => update({ text })}
          />
        </Field>
      ) : (
        <Field label="Delay duration" error={error("duration")}>
          <Input
            id={`${id}-duration`}
            value={step.duration ?? ""}
            placeholder="5m"
            onValueChange={(duration) => update({ duration })}
          />
        </Field>
      )}
      <Accordion
        variant="form"
        keepMounted
        value={expanded}
        onValueChange={setExpanded}
        items={[
          {
            value: "run",
            title: (
              <span className="workflow-disclosure-title">
                Run controls
                <span className="text-caption text-subtle">
                  {step.timeoutSecs || step.replyInThread || step.condition
                    ? [
                        step.condition && "Conditional",
                        step.replyInThread && "Thread reply",
                        step.timeoutSecs,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : "Default"}
                </span>
              </span>
            ),
            content: (
              <div className="workflow-options">
                {step.action === "send_message" &&
                  isThreadReplyEligibleTrigger(state.trigger.on) && (
                    <Switch
                      label="Reply in the triggering thread"
                      checked={step.replyInThread === true}
                      disabled={disabled}
                      onCheckedChange={(replyInThread) =>
                        update({ replyInThread })
                      }
                    />
                  )}
                <Field
                  label="Step condition (optional)"
                  description="An evalexpr expression evaluated before this step."
                >
                  <Input
                    value={step.condition ?? ""}
                    onValueChange={(condition) =>
                      update({
                        condition: condition.trim() ? condition : undefined,
                      })
                    }
                  />
                </Field>
                <Field label="Step timeout (optional)" error={error("timeout")}>
                  <Input
                    id={`${id}-timeout`}
                    value={step.timeoutSecs ?? ""}
                    placeholder="30s"
                    onValueChange={(timeoutSecs) => update({ timeoutSecs })}
                  />
                </Field>
              </div>
            ),
          },
          {
            value: "details",
            title: (
              <span className="workflow-disclosure-title">
                Step details
                <span className="text-caption text-subtle">
                  {step.name || step.id}
                </span>
              </span>
            ),
            content: (
              <div className="workflow-options">
                <p className="text-mono-sm text-subtle">{step.id}</p>
                <Field label="Step name (optional)">
                  <Input
                    id={`${id}-name`}
                    value={step.name ?? ""}
                    onValueChange={(name) => update({ name })}
                  />
                </Field>
                {step.action === "send_message" && (
                  <Field
                    label="Destination channel UUID (optional)"
                    description="Blank uses this workflow’s channel. The relay checks destination access."
                  >
                    <Input
                      id={`${id}-channel`}
                      value={step.channel ?? ""}
                      onValueChange={(channel) => update({ channel })}
                    />
                  </Field>
                )}
              </div>
            ),
          },
        ]}
      />
    </>
  );
}
