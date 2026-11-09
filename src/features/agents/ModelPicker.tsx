// A type's model choice, shared by agent types for the New agent dialog and
// their settings. Each type decides whether its catalog accepts custom IDs.
import {
  useId,
  useRef,
  useState,
  type ReactNode,
  type ComponentProps,
} from "react";
import {
  ClaudeLogoIcon,
  GoogleLogoIcon,
  MetaLogoIcon,
  CodexLogoIcon,
  DeepSeekLogoIcon,
  GrokLogoIcon,
  ZaiLogoIcon,
  KimiLogoIcon,
  RobotIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { ModelFamilyMenu } from "./ModelFamilyMenu";
import { formatModelChoices } from "./formatModelDisplayName";
import { Select } from "../../shared/design-system/ui/Select";

export type ModelChoice = Readonly<{
  /** The model ID saved in the type's config. */
  id: string;
  label: string;
  /** Absent from the listed models; the family menu shows its description. */
  unlisted?: boolean;
  /** Catalog-owned family, when the plugin knows more than the ID/name matcher. */
  family?: string;
  description?: string | undefined;
  /** Served on low-latency inference hardware; the family menu marks it Fast. */
  fast?: boolean;
  efforts?: readonly { id: string; label: string }[];
  effortScope?: string;
  loadEfforts?: () => Promise<readonly { id: string; label: string }[]>;
}>;

const CUSTOM_MODEL_ACTION: ModelChoice = {
  id: "\0custom-model",
  label: "Custom model",
  description: "Enter a model ID",
};

/** Resolve artwork before passing an optional leading slot to a control. */
export function modelLogo(model: string, className?: string) {
  const name = model.toLowerCase();
  const Icon = /claude|anthropic|opus|sonnet|haiku/.test(name)
    ? ClaudeLogoIcon
    : /(?:^|[\s/._-])(?:gpt|codex|o[134](?:[\s/._-]|$))|openai/.test(name)
      ? CodexLogoIcon
      : /gemini/.test(name)
        ? GoogleLogoIcon
        : /llama/.test(name)
          ? MetaLogoIcon
          : /deepseek/.test(name)
            ? DeepSeekLogoIcon
            : /grok/.test(name)
              ? GrokLogoIcon
              : /(?:^|[\s/._-])glm(?:[\s/._-]|\d|$)|zhipu|z[.-]ai/.test(name)
                ? ZaiLogoIcon
                : /kimi|moonshot/.test(name)
                  ? KimiLogoIcon
                  : null;
  return Icon ? (
    <Icon className={className} size={20} aria-hidden="true" />
  ) : null;
}

/** Browse surfaces retain the generic mark when the vendor is unknown. */
export function ModelIcon({ model }: { model: string }) {
  return modelLogo(model) ?? <RobotIcon size={20} aria-hidden="true" />;
}

/** The custom-model form. Create hosts it outside its closing menu; Settings
 * renders it beside the field that opened it. */
export function CustomModelDialog({
  initialValue,
  onSubmit,
  onClose,
  finalFocus = false,
}: {
  initialValue: string;
  onSubmit(model: string): void;
  onClose(): void;
  finalFocus?: ComponentProps<typeof Dialog>["finalFocus"];
}) {
  const [model, setModel] = useState(initialValue);
  const input = useRef<HTMLInputElement>(null);
  const form = useId();
  return (
    <Dialog
      size="compact"
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Custom model"
      headerGap="compact"
      initialFocus={input}
      finalFocus={finalFocus}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            form={form}
            type="submit"
            variant="prominent"
            disabled={!model.trim()}
          >
            Use model
          </Button>
        </>
      }
    >
      <form
        id={form}
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const value = model.trim();
          if (value) onSubmit(value);
        }}
      >
        <Field label="Model ID" labelVisibility="hidden">
          <Input
            ref={input}
            value={model}
            placeholder="Enter a model ID"
            required
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => setModel(event.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}

/** `value` is a model ID, or "" for the type's default, `defaultLabel`. */
export function ModelPicker({
  label = "Model",
  groupByFamily = false,
  leading,
  onConfigure,
  resetLabel,
  modelLabelPrefixes,
  effort,
  effortLabel,
  onEffortChange,
  models,
  allowCustomModel = false,
  value,
  defaultLabel,
  defaultModel,
  defaultDescription,
  onChange,
  loading = false,
  pending = false,
  disabled = false,
  compact = false,
  appearance = "outlined",
  includeDefault = true,
  description,
}: {
  label?: string;
  resetLabel?: string;
  groupByFamily?: boolean;
  leading?: ReactNode;
  onConfigure?: (() => void) | undefined;
  modelLabelPrefixes?: readonly string[] | undefined;
  effort?: string | undefined;
  effortLabel?: string | undefined;
  onEffortChange?: ((model: string, effort: string) => void) | undefined;
  models: readonly ModelChoice[];
  /** Whether text absent from `models` may be committed as its model ID. */
  allowCustomModel?: boolean;
  compact?: boolean;
  appearance?: "outlined" | "glass-ghost" | "inverted";
  includeDefault?: boolean;
  value: string;
  defaultLabel: string;
  defaultModel?: string | undefined;
  defaultDescription?: string;
  onChange(value: string): void;
  loading?: boolean;
  /** A pending write retains the selected label while blocking new choices. */
  pending?: boolean;
  disabled?: boolean;
  description?: string | undefined;
}) {
  const [customModel, setCustomModel] = useState<string | null>(null);
  const control = useRef<HTMLDivElement>(null);
  const defaultChoice = models.find((model) => model.id === defaultModel);
  const efforts = models.find(
    (model) => model.id === (value || defaultModel),
  )?.efforts;
  const fallback: ModelChoice = {
    id: "",
    label: defaultChoice?.label ?? defaultLabel,
    description: defaultChoice?.description ?? defaultDescription,
  };
  const listed: ModelChoice[] = includeDefault
    ? models.filter((model) => model.id !== defaultModel || model.id === value)
    : [...models];
  if (value && !listed.some((model) => model.id === value))
    listed.push({
      id: value,
      label: value,
      description: allowCustomModel ? "Custom model" : "Unavailable model",
      unlisted: true,
    });
  // The default takes part in telling names apart, even when it is not a row.
  const [shownDefault = fallback, ...shownListed] = formatModelChoices(
    [fallback, ...listed],
    modelLabelPrefixes,
  );
  const shown = includeDefault ? [shownDefault, ...shownListed] : shownListed;
  const selected =
    shown.find((model) => model.id === (value || defaultModel)) ?? shownDefault;
  const inherited = value === "";
  const selectedLabel = inherited
    ? `${selected.label} · Default`
    : selected.label;
  const discovering = loading && !pending;
  const choices =
    allowCustomModel && !compact ? [...shown, CUSTOM_MODEL_ACTION] : shown;
  const optionLogos = choices.map((model) =>
    modelLogo(`${model.id} ${model.label}`),
  );
  const hasOptionLogos = optionLogos.some(Boolean);
  const openCustomDialog = () => {
    const listed = !value || models.some((model) => model.id === value);
    const initialValue = listed ? "" : value;
    setCustomModel(initialValue);
  };
  return (
    <>
      {/* Preference rows stack at full width; only compact triggers share a line. */}
      <div
        ref={control}
        className={
          compact ? "flex max-w-full flex-wrap items-center gap-3" : undefined
        }
      >
        {groupByFamily ? (
          <ModelFamilyMenu
            leading={leading}
            appearance={appearance}
            resetLabel={resetLabel}
            effort={effort}
            effortLabel={effortLabel}
            onEffortChange={
              onEffortChange
                ? (model, level) =>
                    onEffortChange(
                      inherited && model === defaultModel ? "" : model,
                      level,
                    )
                : undefined
            }
            inherited={!discovering && inherited}
            label={label}
            compact={compact}
            onConfigure={onConfigure}
            models={shown.filter((model) => model.id !== "")}
            selected={
              discovering ? { ...selected, label: "Loading models…" } : selected
            }
            defaultChoice={includeDefault ? shownDefault : undefined}
            disabled={disabled}
            loading={loading || pending}
            description={description}
            onChange={onChange}
            onCustom={allowCustomModel ? openCustomDialog : undefined}
          />
        ) : (
          <Select
            label={label}
            value={selected.id}
            valueLabel={discovering ? "Loading models…" : selected.label}
            valueSuffix={!discovering && inherited ? " · Default" : undefined}
            valueTitle={discovering ? "Loading models…" : selectedLabel}
            leading={modelLogo(`${selected.id} ${selected.label}`)}
            variant={compact ? "compact" : "preference"}
            appearance={appearance}
            {...(appearance === "glass-ghost" ? { size: "xs" as const } : {})}
            align={compact ? "end" : "start"}
            groups={[
              {
                label: "",
                options: choices.map((model, index) => ({
                  value: model.id,
                  label:
                    includeDefault && model.id === ""
                      ? `${model.label} · Default`
                      : model.label,
                  description: model.description,
                  // The empty fragment reserves Select's icon column only in mixed lists.
                  leading: hasOptionLogos
                    ? (optionLogos[index] ?? <></>)
                    : undefined,
                })),
              },
            ]}
            disabled={disabled || loading || pending}
            description={description}
            onValueChange={(model) => {
              if (model === CUSTOM_MODEL_ACTION.id) openCustomDialog();
              else onChange(model);
            }}
          />
        )}
        {!groupByFamily && onEffortChange && efforts && efforts.length > 1 && (
          <Select
            label="Thinking effort"
            value={effort ?? ""}
            valueLabel={effortLabel}
            variant={compact ? "compact" : "preference"}
            appearance={appearance}
            {...(appearance === "glass-ghost" ? { size: "xs" as const } : {})}
            groups={[
              {
                label: "",
                options: efforts.map((level) => ({
                  value: level.id,
                  label: level.label,
                })),
              },
            ]}
            disabled={disabled || loading || pending}
            onValueChange={(level) => onEffortChange(value, level)}
          />
        )}
      </div>
      {allowCustomModel && customModel !== null && (
        <CustomModelDialog
          initialValue={customModel}
          onClose={() => setCustomModel(null)}
          onSubmit={(model) => {
            onChange(model);
            setCustomModel(null);
          }}
          finalFocus={() =>
            control.current?.querySelector<HTMLElement>(
              "[role=combobox], [aria-haspopup=menu]",
            ) ?? false
          }
        />
      )}
    </>
  );
}
