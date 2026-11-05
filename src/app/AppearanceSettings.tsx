import { Select } from "../shared/design-system/ui/Select";
import { ACCENTS, accentButtonStyle } from "../shared/theme/accent";

import { IconButton } from "../shared/design-system/ui/IconButton";
import {
  ArrowCounterClockwiseIcon,
  CircleIcon,
} from "../shared/design-system/icons";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { Header, InlineHeader } from "../shared/design-system/ui/Header";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { AppearancePreview } from "./AppearancePreview";
import { Button } from "../shared/design-system/ui/Button";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import type { Appearance } from "../shared/theme/service";

import {
  setThreadPlacementPreference,
  useThreadPlacementPreference,
} from "../features/messages/thread-preferences";

import {
  useFollowUpBehaviorPreference,
  setFollowUpBehaviorPreference,
} from "../features/messages/follow-up-preference";
import {
  setMessageAutocorrectPreference,
  useMessageAutocorrectPreference,
} from "../features/messages/autocorrect-preference";
import {
  setUnreadFirstPreference,
  useUnreadFirstPreference,
} from "../features/search/unread-first-preference";
import { macWebKit } from "../features/messages/mac-webkit";
import { SwitchPreferenceRow } from "../shared/design-system/ui/SwitchPreferenceRow";
import {
  setClockPreference,
  useClockPreference,
} from "../shared/clock-preference";

export function AppearanceSettings({
  appearance,
  active = true,
  autocorrectAvailable = macWebKit(),
}: {
  appearance: Appearance;
  active?: boolean;
  /** Only Mac WebKit applies the composer's autocorrect attribute. */
  autocorrectAvailable?: boolean;
}) {
  const followUp = useFollowUpBehaviorPreference();
  const autocorrect = useMessageAutocorrectPreference();
  const unreadFirst = useUnreadFirstPreference();
  const clock = useClockPreference();
  const { placement, unsaved } = useThreadPlacementPreference();
  const increaseButton = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<HTMLButtonElement | null>(null);
  const resetRef = useCallback((node: HTMLButtonElement | null) => {
    if (!node) return;
    return () => {
      if (document.activeElement === node)
        pendingFocus.current = increaseButton.current;
    };
  }, []);
  useLayoutEffect(() => {
    // At 200%, Increase is still disabled during Reset's ref cleanup.
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target?.isConnected) target.focus();
  });
  const {
    preference,
    mode,
    error,
    fontScale,
    fontError,
    accent,
    accentError,
    contrast,
    contrastError,
  } = useSyncExternalStore(appearance.subscribe, appearance.snapshot);
  return (
    <section aria-labelledby="appearance-settings-title">
      <Header id="appearance-settings-title" title="Appearance" />
      <AppearancePreview />
      <div>
        <InlineHeader title="Interface" />
        <SettingsGroup>
          <PreferenceRow
            id="setting-mode"
            title="Mode"
            trailing={
              <Select
                variant="compact"
                label="Mode"
                value={preference}
                groups={[
                  {
                    label: "Mode",
                    options: [
                      { value: "system", label: "System" },
                      { value: "light", label: "Light" },
                      { value: "dark", label: "Dark" },
                    ],
                  },
                ]}
                onValueChange={(value) => {
                  if (
                    value === "system" ||
                    value === "light" ||
                    value === "dark"
                  )
                    appearance.setMode(value);
                }}
              />
            }
          />
          <PreferenceRow
            title="Interface size"
            trailing={
              <fieldset
                aria-label="Interface size"
                className="m-0 flex min-w-0 flex-wrap items-center gap-3 border-0 p-0"
              >
                <Button
                  type="button"
                  size="sm"
                  aria-label="Decrease interface size"
                  disabled={fontScale <= 0.8}
                  onClick={() => appearance.setFontScale(fontScale - 0.1)}
                >
                  −
                </Button>
                <output
                  aria-label="Interface size"
                  className="text-body-sm tabular-nums"
                >
                  {Math.round(fontScale * 100)}%
                </output>
                <Button
                  type="button"
                  size="sm"
                  ref={increaseButton}
                  aria-label="Increase interface size"
                  disabled={fontScale >= 2}
                  onClick={() => appearance.setFontScale(fontScale + 0.1)}
                >
                  +
                </Button>
                {fontScale !== 1 && (
                  <IconButton
                    icon={<ArrowCounterClockwiseIcon aria-hidden="true" />}
                    title="Reset interface size"
                    size="sm"
                    type="button"
                    ref={resetRef}
                    aria-label="Reset interface size"
                    onClick={() => appearance.setFontScale(1)}
                  />
                )}
              </fieldset>
            }
          />
          <PreferenceRow
            title="Accent color"
            trailing={(label) => (
              <fieldset
                {...label}
                className="m-0 min-w-0 max-w-full border-0 p-0"
              >
                <div
                  data-accent-colors
                  className="grid auto-cols-max grid-flow-col gap-2 overflow-x-auto p-1 scroll-p-1 [&>button]:scroll-m-1"
                >
                  {ACCENTS.map((color) => {
                    const colorLabel =
                      color === "bee"
                        ? "Honey"
                        : `${color.charAt(0).toUpperCase()}${color.slice(1)}`;
                    return (
                      <IconButton
                        key={color}
                        data-color-swatch=""
                        data-accent={color}
                        data-color-mode={mode}
                        style={accentButtonStyle}
                        variant="primary"
                        size="sm"
                        shape="round"
                        aria-label={`${colorLabel} accent color`}
                        title={colorLabel}
                        aria-pressed={accent === color}
                        onFocus={(event) =>
                          event.currentTarget.scrollIntoView({
                            block: "nearest",
                            inline: "nearest",
                          })
                        }
                        onClick={() => appearance.setAccent(color)}
                        icon={
                          <CircleIcon
                            size={24}
                            strokeWidth={3}
                            aria-hidden="true"
                            className={
                              accent === color ? "opacity-100" : "opacity-0"
                            }
                          />
                        }
                      />
                    );
                  })}
                </div>
              </fieldset>
            )}
          />
          <PreferenceRow
            title="Vibe level"
            trailing={
              <Select
                variant="compact"
                label="Vibe level"
                value={contrast}
                groups={[
                  {
                    label: "Vibe level",
                    options: [
                      { value: "low", label: "Chillin’" },
                      { value: "high", label: "Buzzin’" },
                    ],
                  },
                ]}
                onValueChange={(value) => {
                  if (value === "low" || value === "high")
                    appearance.setContrast(value);
                }}
              />
            }
          />
          <PreferenceRow
            title="Clock"
            subtitle="System uses your device’s time format."
            trailing={
              <Select
                variant="compact"
                label="Clock"
                value={clock.hourCycle}
                groups={[
                  {
                    label: "Clock",
                    options: [
                      { value: "system", label: "System" },
                      { value: "h12", label: "12-hour" },
                      { value: "h23", label: "24-hour" },
                    ],
                  },
                ]}
                onValueChange={(value) => {
                  if (value === "system" || value === "h12" || value === "h23")
                    setClockPreference({ hourCycle: value });
                }}
              />
            }
          />
          <SwitchPreferenceRow
            label="Show seconds"
            checked={clock.seconds}
            onCheckedChange={(seconds) => setClockPreference({ seconds })}
          />
        </SettingsGroup>
      </div>
      <div className="mt-section-gap">
        <InlineHeader title="Conversations" />
        <SettingsGroup>
          <PreferenceRow
            title="Follow-up behavior"
            subtitle="In Solo, send follow-ups immediately or queue them until the agent finishes its previous response."
            trailing={
              <Select
                variant="compact"
                label="Follow-up behavior"
                value={followUp.behavior}
                groups={[
                  {
                    label: "Behavior",
                    options: [
                      { value: "immediate", label: "Send immediately" },
                      { value: "queue", label: "Queue" },
                    ],
                  },
                ]}
                onValueChange={(value) => {
                  if (value === "immediate" || value === "queue")
                    setFollowUpBehaviorPreference(value);
                }}
              />
            }
          />

          <PreferenceRow
            title="Open threads in"
            subtitle="New threads open here. Already-open threads stay where you placed them."
            trailing={
              <Select
                variant="compact"
                label="Open threads in"
                value={placement}
                groups={[
                  {
                    label: "Pane",
                    options: [
                      { value: "side", label: "Side pane" },
                      { value: "main", label: "Main pane" },
                    ],
                  },
                ]}
                onValueChange={(value) => {
                  if (value === "main" || value === "side")
                    setThreadPlacementPreference(value);
                }}
              />
            }
          />
          <PreferenceRow
            title="Message timestamps"
            subtitle="Hidden times stay available to screen readers."
            trailing={
              <Select
                variant="compact"
                label="Message timestamps"
                value={clock.messageTimestamps}
                groups={[
                  {
                    label: "Timestamps",
                    options: [
                      { value: "show", label: "Show" },
                      { value: "hide-solo", label: "Hide in Solo chats" },
                      { value: "hide", label: "Hide" },
                    ],
                  },
                ]}
                onValueChange={(value) => {
                  if (
                    value === "show" ||
                    value === "hide-solo" ||
                    value === "hide"
                  )
                    setClockPreference({ messageTimestamps: value });
                }}
              />
            }
          />
          {autocorrectAvailable && (
            <SwitchPreferenceRow
              label="Allow automatic spelling correction"
              description="Lets macOS correct misspelled words in messages. Turn correction on or off from the message box’s Spelling and Grammar menu."
              checked={autocorrect.enabled}
              onCheckedChange={setMessageAutocorrectPreference}
            />
          )}
          <SwitchPreferenceRow
            label="Show unread first in search"
            description="With nothing typed, search leads with unread channels and DMs and selects the newest."
            checked={unreadFirst.enabled}
            onCheckedChange={setUnreadFirstPreference}
          />
        </SettingsGroup>
        {active && followUp.unsaved && (
          <ToastNotice
            title="Follow-up preference wasn’t saved"
            description="This choice is active, but could not be saved on this device."
          >
            <Button
              size="sm"
              onClick={() => setFollowUpBehaviorPreference(followUp.behavior)}
            >
              Retry saving follow-up behavior
            </Button>
          </ToastNotice>
        )}
        {active && clock.unsaved && (
          <ToastNotice
            title="Clock preference wasn’t saved"
            description="This choice is active, but could not be saved on this device. Try again."
          >
            <Button
              type="button"
              size="sm"
              onClick={() => setClockPreference({})}
            >
              Retry saving clock preference
            </Button>
          </ToastNotice>
        )}
        {active && autocorrect.unsaved && (
          <ToastNotice
            title="Spelling preference wasn’t saved"
            description="This choice is active, but could not be saved on this device. Try again."
          >
            <Button
              type="button"
              size="sm"
              onClick={() =>
                setMessageAutocorrectPreference(autocorrect.enabled)
              }
            >
              Retry saving spelling correction
            </Button>
          </ToastNotice>
        )}
        {active && unreadFirst.unsaved && (
          <ToastNotice
            title="Search preference wasn’t saved"
            description="This choice is active, but could not be saved on this device. Try again."
          >
            <Button
              type="button"
              size="sm"
              onClick={() => setUnreadFirstPreference(unreadFirst.enabled)}
            >
              Retry saving search preference
            </Button>
          </ToastNotice>
        )}
        {active && unsaved && (
          <ToastNotice
            title="Thread preference wasn’t saved"
            description="This choice is active, but could not be saved on this device. Try again."
          >
            <Button
              type="button"
              size="sm"
              onClick={() => setThreadPlacementPreference(placement)}
            >
              Retry saving thread placement
            </Button>
          </ToastNotice>
        )}
        {active && contrastError && (
          <ToastNotice
            title="Vibe level wasn’t saved"
            description={contrastError}
          >
            <Button size="sm" onClick={() => appearance.setContrast(contrast)}>
              Retry saving vibe level
            </Button>
          </ToastNotice>
        )}
        {active && accentError && (
          <ToastNotice
            title="Accent color wasn’t saved"
            description={accentError}
          >
            <Button size="sm" onClick={() => appearance.setAccent(accent)}>
              Retry saving accent color
            </Button>
          </ToastNotice>
        )}

        {active && fontError && (
          <ToastNotice
            title="Interface size wasn’t saved"
            description={fontError}
          >
            <Button
              type="button"
              size="sm"
              onClick={() => appearance.setFontScale(fontScale)}
            >
              Retry saving interface size
            </Button>
          </ToastNotice>
        )}
        {active && error && (
          <ToastNotice title="Appearance wasn’t saved" description={error}>
            <Button
              type="button"
              size="sm"
              onClick={() => appearance.setMode(preference)}
            >
              Retry saving appearance
            </Button>
          </ToastNotice>
        )}
      </div>
    </section>
  );
}
