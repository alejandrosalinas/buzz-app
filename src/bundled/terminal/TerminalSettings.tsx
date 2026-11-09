import { useRef, useSyncExternalStore } from "react";
import { Header, InlineHeader } from "../../shared/design-system/ui/Header";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Button } from "../../shared/design-system/ui/Button";
import { SwitchPreferenceRow } from "../../shared/design-system/ui/SwitchPreferenceRow";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { isApplePlatform } from "../../features/shortcuts/format";
import { useFontAvailability } from "./font-availability";
import {
  parseFontFamily,
  parseFontSize,
  DEFAULT_FONT_SIZE,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  type TerminalFontPreference,
} from "./font-preference";
import { optionMetaPreference } from "./option-meta-preference";

/** Unsaved form state belongs to the plugin, across Settings card mounts. */
export function createTerminalSettingsDraft() {
  let state = {
    family: null as string | null,
    size: null as string | null,
    blurredValue: null as string | null,
  };
  const listeners = new Set<() => void>();
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(next: Partial<typeof state>) {
      state = { ...state, ...next };
      for (const listener of listeners) listener();
    },
  };
}

export function TerminalSettings({
  font,
  drafts,
  active,
}: {
  font: TerminalFontPreference;
  drafts: ReturnType<typeof createTerminalSettingsDraft>;
  active(): boolean;
}) {
  const { family, size, error } = useSyncExternalStore(
    font.subscribe,
    font.snapshot,
  );
  const {
    family: draft,
    size: sizeDraft,
    blurredValue,
  } = useSyncExternalStore(drafts.subscribe, drafts.snapshot);
  const familyInput = useRef<HTMLInputElement>(null);
  const value = draft ?? family ?? "";
  const parsed = parseFontFamily(value);
  const invalid = draft !== null && parsed === null;
  const availability = useFontAvailability(parsed);
  const savedAvailability = useFontAvailability(
    family === parsed ? null : family,
  );
  const savedStatus =
    family === parsed ? availability.status : savedAvailability.status;
  const unavailable =
    availability.status === "unavailable" &&
    (draft === null || blurredValue === value);
  const canApply =
    !invalid && (parsed === family || availability.status === "available");
  const sizeValue = sizeDraft ?? String(size);
  const parsedSize = parseFontSize(Number(sizeValue));
  const sizeInvalid = parsedSize === null;
  return (
    <section aria-labelledby="terminal-settings-title">
      <Header
        id="terminal-settings-title"
        title="Terminal"
        subtitle="Customize your terminal."
      />
      <InlineHeader title="Font" />
      <SettingsGroup layout="form">
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            drafts.update({ blurredValue: value });
            if (!canApply || parsedSize === null) return;
            font.set(parsed, parsedSize);
            drafts.update({ family: null, size: null, blurredValue: null });
          }}
        >
          <div className="flex flex-col gap-4">
            <Field
              label="Font family"
              description="Type an installed font family name. For Nerd Fonts, use a Mono variant for cell alignment."
              error={
                invalid
                  ? "Enter one font family name, up to 64 characters, without quotes, commas, or CSS syntax. Use default to clear this choice."
                  : unavailable
                    ? `Couldn’t load “${parsed}”. Check the font name or install it, then try again.`
                    : undefined
              }
            >
              <Input
                ref={familyInput}
                value={value}
                onValueChange={(next) => {
                  drafts.update({ family: next, blurredValue: null });
                }}
                onBlur={() => drafts.update({ blurredValue: value })}
                aria-busy={availability.status === "checking"}
                placeholder="JetBrains Mono"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </Field>
            {unavailable && (
              <Button
                type="button"
                size="sm"
                variant="subtle"
                onClick={() => {
                  familyInput.current?.focus();
                  availability.retry();
                }}
              >
                Retry font check
              </Button>
            )}
            {family && savedStatus === "unavailable" && (
              <p role="status" className="text-body-sm text-subtle">
                Couldn’t load your saved font “{family}”. The terminal is using
                JetBrains Mono.
              </p>
            )}
            <Field
              label="Font size (px)"
              description={`Terminal text size, independent of interface text size. Default: ${DEFAULT_FONT_SIZE} px.`}
              error={
                sizeInvalid
                  ? `Enter a number from ${MIN_FONT_SIZE} to ${MAX_FONT_SIZE}.`
                  : undefined
              }
            >
              <Input
                type="number"
                min={MIN_FONT_SIZE}
                max={MAX_FONT_SIZE}
                step="any"
                value={sizeValue}
                onValueChange={(next) => drafts.update({ size: next })}
              />
            </Field>
          </div>
          <p
            className="mt-4 text-mono"
            style={{
              fontSize: `${parsedSize ?? DEFAULT_FONT_SIZE}px`,
              letterSpacing: 0,
              fontFamily: parsed
                ? `"${parsed}", var(--font-system-mono)`
                : "var(--font-system-mono)",
            }}
          >
            Preview: ABC 0123
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
            <Button
              type="button"
              variant="subtle"
              onClick={() => {
                font.reset();
                drafts.update({ family: null, size: null, blurredValue: null });
              }}
            >
              Use default
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={
                !canApply ||
                sizeInvalid ||
                (parsed === family && parsedSize === size)
              }
            >
              Apply
            </Button>
          </div>
        </form>
      </SettingsGroup>
      {/* Only macOS keyboards choose between Option characters and Meta. */}
      {isApplePlatform(navigator.platform) && <OptionMetaSetting />}
      {active() && error && (
        <ToastNotice
          title="Terminal font preference needs attention"
          description={error}
        >
          <Button type="button" size="sm" onClick={font.retry}>
            Retry terminal font preference
          </Button>
        </ToastNotice>
      )}
    </section>
  );
}

function OptionMetaSetting() {
  const checked = optionMetaPreference.usePreference();
  const error = optionMetaPreference.useSaveError();
  return (
    <section className="mt-section-gap">
      <InlineHeader title="Keyboard" />
      <SettingsGroup>
        <SwitchPreferenceRow
          label="Use Option as Meta key"
          description="Treat the Option key as the Meta key in the terminal."
          checked={checked}
          onCheckedChange={optionMetaPreference.set}
        />
      </SettingsGroup>
      {error && (
        <div role="alert" className="grid gap-3 text-body-sm text-standard">
          <p className="m-0">{error}</p>
          <div>
            <Button
              type="button"
              onClick={() => optionMetaPreference.set(checked)}
            >
              Retry saving
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
