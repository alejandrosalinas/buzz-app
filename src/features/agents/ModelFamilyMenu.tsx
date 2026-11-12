import { useState, type ReactNode } from "react";
import { modelLogo, type ModelChoice } from "./ModelPicker";
import {
  CaretDownIcon,
  CheckIcon,
  LightningIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import styles from "./ModelFamilyMenu.module.css";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuGroup,
  MenuGroupLabel,
  MenuSeparator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSubmenu,
  MenuSubmenuTrigger,
  MenuSubmenuPopup,
} from "../../shared/design-system/ui/Menu";

/** A bolt after the name marks a low-latency model; its text stays for
 * screen readers and the trigger's accessible name. */
function FastMark() {
  return (
    <span className={styles.fast} title="Fast">
      <LightningIcon size={14} aria-hidden="true" />
      <span className="sr-only">Fast</span>
    </span>
  );
}

/** Menu rows space their children apart; one inline run keeps the mark
 * attached to the name instead of floating as its own column. */
function ModelName({
  model,
  label,
  mark = true,
}: {
  model: ModelChoice;
  label: string;
  mark?: boolean;
}) {
  return model.fast && mark ? (
    <span className={styles.name}>
      {label} <FastMark />
    </span>
  ) : (
    label
  );
}

/** Catalogs expose IDs, not a common family field. Unknown IDs remain available. */
export function modelFamily(model: ModelChoice): string {
  if (model.family) return model.family;
  const name = `${model.id} ${model.label}`.toLowerCase();
  for (const [family, pattern] of [
    ["OpenAI", /codex|gpt|openai|(?:^|[\s/._-])o[134](?:[\s/._-]|$)/],
    ["Claude", /claude|anthropic|sonnet|opus|haiku|fable/],
    ["Kimi", /kimi|moonshot/],
    ["Gemini", /gemini/],
    ["DeepSeek", /deepseek/],
    ["Qwen", /qwen/],
    ["Llama", /llama/],
    ["Mistral", /mistral|mixtral|codestral/],
    ["Grok", /grok/],
    ["GLM", /(?:^|[\s/._-])glm(?:[\s/._-]|\d|$)|zhipu|z[.-]ai/],
  ] as const)
    if (pattern.test(name)) return family;
  return "Other";
}

export function ModelFamilyMenu({
  leading,
  inherited = false,
  appearance = "outlined",
  resetLabel,
  label,
  effort,
  effortLabel,
  onEffortChange,
  compact = false,
  onConfigure,
  models,
  selected,
  defaultChoice,
  disabled,
  loading = false,
  description,
  align = "start",
  onChange,
  onCustom,
}: {
  leading?: ReactNode;
  inherited?: boolean;
  appearance?: "outlined" | "glass-ghost" | "inverted";
  resetLabel?: string | undefined;
  label: string;
  effort?: string | undefined;
  effortLabel?: string | undefined;
  onEffortChange?: ((model: string, effort: string) => void) | undefined;
  compact?: boolean;
  onConfigure?: (() => void) | undefined;
  models: readonly ModelChoice[];
  selected: ModelChoice;
  defaultChoice?: ModelChoice | undefined;
  disabled: boolean;
  loading?: boolean;
  description?: string | undefined;
  align?: "start" | "center" | "end";
  onChange(id: string): void;
  onCustom?: (() => void) | undefined;
}) {
  const families = new Map<string, ModelChoice[]>();
  for (const model of models) {
    const family = modelFamily(model);
    families.set(family, [...(families.get(family) ?? []), model]);
  }
  const hasFamilyLogos = [...families.keys()].some((family) =>
    modelLogo(family),
  );
  // Fast models get their own section up front, so the quick choices are one
  // click away; they stay in their families too. A catalog of only fast (or
  // no fast) models gains nothing from a separate section.
  const fastModels = models.filter((model) => model.fast);
  const fastSection =
    fastModels.length > 0 && fastModels.length < models.length;
  const selectedLabel = `${selected.label}${selected.fast ? " · Fast" : ""}${inherited ? " · Default" : ""}`;
  const choiceRow = (model: ModelChoice, inFastSection: boolean) => {
    const leading = inFastSection && hasFamilyLogos && (
      <span className="buzz-select-leading" aria-hidden="true">
        {modelLogo(modelFamily(model))}
      </span>
    );
    return onEffortChange && (model.efforts?.length || model.loadEfforts) ? (
      <EffortMenu
        key={`${model.effortScope ?? ""}:${model.id}`}
        model={model}
        leading={leading}
        mark={!inFastSection}
        selected={selected.id === model.id}
        effort={effort ?? ""}
        onChange={onEffortChange}
      />
    ) : (
      <MenuRadioItem key={model.id} value={model.id} closeOnClick>
        {leading}
        <ModelName
          model={model}
          mark={!inFastSection}
          label={
            model.unlisted && model.description
              ? `${model.label} · ${model.description}`
              : model.label
          }
        />
      </MenuRadioItem>
    );
  };
  const menu = (
    <MenuRoot>
      <MenuTrigger
        disabled={disabled || loading}
        render={(props) => (
          <Button
            {...props}
            disabled={disabled}
            loading={loading}
            focusableWhenDisabled={loading && !disabled}
            variant={appearance === "outlined" ? "outline" : appearance}
            shape="control"
            size={appearance === "glass-ghost" ? "xs" : "sm"}
            aria-label={`${label}: ${selectedLabel}${effortLabel ? `, ${effortLabel}` : ""}`}
            title={selectedLabel}
          >
            {leading && (
              <span className="buzz-select-leading" aria-hidden="true">
                {leading}
              </span>
            )}
            {modelLogo(modelFamily(selected), "buzz-select-leading")}
            {/* Card labels keep Default accessible without crowding the model. */}
            <span className={styles.value}>
              <span className={`buzz-select-value ${styles.model}`}>
                {selected.label}
              </span>
              {selected.fast && <FastMark />}
              {inherited && appearance !== "glass-ghost" && (
                <span className="buzz-select-value-suffix text-subtle">
                  {" · Default"}
                </span>
              )}
              {effortLabel && (
                <span className={`${styles.effort} text-body-sm text-subtle`}>
                  {effortLabel}
                </span>
              )}
            </span>
            <CaretDownIcon size={16} aria-hidden="true" />
          </Button>
        )}
      />
      <MenuPopup aria-label={label} align={align}>
        {defaultChoice && (
          <MenuRadioGroup
            value={inherited ? "" : selected.id}
            onValueChange={(id) => onChange(id)}
          >
            <MenuRadioItem value="" closeOnClick>
              {hasFamilyLogos && (
                <span className="buzz-select-leading" aria-hidden="true" />
              )}
              {defaultChoice.label} · Default
            </MenuRadioItem>
          </MenuRadioGroup>
        )}
        {fastSection && (
          <>
            <MenuGroup>
              <MenuGroupLabel emphasis="quiet">
                <span className={styles.name}>
                  <LightningIcon size={14} aria-hidden="true" />
                  Fast
                </span>
              </MenuGroupLabel>
              <MenuRadioGroup
                value={selected.id}
                onValueChange={(id) => onChange(id)}
              >
                {fastModels.map((model) => choiceRow(model, true))}
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
          </>
        )}
        {[...families]
          .sort(([a], [b]) =>
            a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b),
          )
          .map(([family, choices]) => (
            <MenuSubmenu key={family}>
              <MenuSubmenuTrigger>
                {hasFamilyLogos && (
                  <span className="buzz-select-leading" aria-hidden="true">
                    {modelLogo(family)}
                  </span>
                )}
                {family}
              </MenuSubmenuTrigger>
              <MenuSubmenuPopup aria-label={`${family} models`}>
                <MenuRadioGroup
                  value={selected.id}
                  onValueChange={(id) => onChange(id)}
                >
                  {choices.map((model) => choiceRow(model, false))}
                </MenuRadioGroup>
              </MenuSubmenuPopup>
            </MenuSubmenu>
          ))}
        {resetLabel && (
          <MenuItem onClick={() => onChange("")}>{resetLabel}</MenuItem>
        )}
        {onConfigure && (
          <MenuItem onClick={onConfigure}>Edit configuration</MenuItem>
        )}
        {onCustom && <MenuItem onClick={onCustom}>Custom model</MenuItem>}
      </MenuPopup>
    </MenuRoot>
  );
  // Like Select's preference variant, rows hold the compact recipe, which
  // bounds the trigger and ellipsizes long model names.
  const control = (
    <div className="buzz-select" data-variant="compact">
      {menu}
    </div>
  );
  return compact ? (
    control
  ) : (
    <PreferenceRow title={label} subtitle={description} trailing={control} />
  );
}

function EffortMenu({
  model,
  leading,
  mark,
  selected,
  effort,
  onChange,
}: {
  model: ModelChoice;
  leading?: ReactNode;
  mark: boolean;
  selected: boolean;
  effort: string;
  onChange(model: string, effort: string): void;
}) {
  const [levels, setLevels] = useState(model.efforts);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  return (
    <MenuSubmenu
      onOpenChange={(open) => {
        if (!open || levels || loading || !model.loadEfforts) return;
        setLoading(true);
        setError("");
        void model
          .loadEfforts()
          .then(setLevels, (reason) => setError(String(reason)))
          .finally(() => setLoading(false));
      }}
    >
      <MenuSubmenuTrigger role="menuitemradio" aria-checked={selected}>
        {leading}
        <ModelName model={model} label={model.label} mark={mark} />
        {selected && <CheckIcon size={16} aria-hidden="true" />}
      </MenuSubmenuTrigger>
      <MenuSubmenuPopup aria-label={`${model.label} thinking effort`}>
        {loading && <MenuItem disabled>Loading thinking levels…</MenuItem>}
        {error && <MenuItem disabled>Could not load thinking levels</MenuItem>}
        {(!levels?.length || error) && (
          <MenuItem onClick={() => onChange(model.id, "")}>Use model</MenuItem>
        )}
        <MenuRadioGroup
          value={selected ? effort : null}
          onValueChange={(level) => onChange(model.id, level)}
        >
          {(levels ?? []).map((level) => (
            <MenuRadioItem key={level.id} value={level.id} closeOnClick>
              {level.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSubmenuPopup>
    </MenuSubmenu>
  );
}
