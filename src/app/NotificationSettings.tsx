import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { Header, InlineHeader } from "../shared/design-system/ui/Header";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { SwitchPreferenceRow } from "../shared/design-system/ui/SwitchPreferenceRow";
import { Button } from "../shared/design-system/ui/Button";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { Select } from "../shared/design-system/ui/Select";
import { UnreadIndicatorSettings } from "./UnreadIndicatorSettings";
import { usePermissionCheck } from "./usePermissionCheck";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { NotificationsService } from "../features/notifications/service";
import type { NotificationCategory } from "../features/notifications/preferences";
import {
  CATEGORY_SOUND_LABELS,
  RECOMMENDED_SOUND_BY_CATEGORY,
  SOUND_NAMES,
  type SoundName,
  type NotificationSoundPlayback,
  createNotificationSoundPlayback,
} from "../features/notifications/sound";
import styles from "./NotificationSettings.module.css";

// Reference row order: direct messages, mentions, thread replies.
const SOUND_ROWS: readonly NotificationCategory[] = [
  "direct",
  "mention",
  "thread",
  "agent",
];

function AlertSoundRow({
  category,
  value,
  disabled,
  onChange,
}: {
  category: NotificationCategory;
  value: SoundName;
  disabled: boolean;
  onChange: (next: SoundName) => void;
}) {
  const recommended = RECOMMENDED_SOUND_BY_CATEGORY[category];

  const names = [
    "silent",
    recommended,
    ...SOUND_NAMES.filter((name) => name !== recommended).sort(),
  ];
  return (
    <PreferenceRow
      title={CATEGORY_SOUND_LABELS[category]}
      disabled={disabled}
      trailing={
        <Select
          label={CATEGORY_SOUND_LABELS[category]}
          variant="compact"
          disabled={disabled}
          value={value}
          valueLabel={value === "silent" ? "Silent" : value}
          groups={[
            {
              label: "",
              options: names.map((name) => ({
                value: name,
                label:
                  name === "silent"
                    ? "Silent"
                    : name === recommended
                      ? `${name} rec.`
                      : name,
              })),
            },
          ]}
          onValueChange={(next) => onChange(next as SoundName)}
        />
      }
    />
  );
}

export function NotificationSettings({
  notifications,
  active = true,
}: {
  notifications: NotificationsService;
  active?: boolean;
}) {
  const state = useSyncExternalStore(
    notifications.subscribe,
    notifications.snapshot,
  );
  const { preferences, permission } = state;
  const [checking, checkPermission] = usePermissionCheck(() =>
    notifications.refreshPermission(),
  );
  const preview = useRef<{
    category: NotificationCategory;
    name: SoundName;
  } | null>(null);
  const previewAudio = useRef<NotificationSoundPlayback | null>(null);
  const stopPreview = useCallback((owner?: NotificationSoundPlayback) => {
    const audio = previewAudio.current;
    if (owner && audio !== owner) return;
    previewAudio.current = null;
    audio?.stop();
    preview.current = null;
  }, []);
  const previewSound = useCallback(
    (category: NotificationCategory, name: SoundName) => {
      stopPreview();
      const audio = createNotificationSoundPlayback(name);
      if (!audio) return;
      previewAudio.current = audio;
      preview.current = { category, name };
      void audio.finished.then(() => stopPreview(audio));
    },
    [stopPreview],
  );
  useEffect(() => () => stopPreview(), [stopPreview]);
  useEffect(() => {
    if (
      preview.current &&
      (!active ||
        !preferences.enabled ||
        !preferences.sound ||
        preferences.categories[preview.current.category] === false ||
        preferences.sounds[preview.current.category] !== preview.current.name)
    )
      stopPreview();
  }, [active, preferences, stopPreview]);
  const desktopAlertsEnabled = !state.developmentPaused && preferences.enabled;
  const permissionStatus = state.developmentPaused
    ? "Notifications are paused by your local development setting. Remove BUZZ_DEV_NOTIFICATIONS=0 from .env.local and restart the dev server to resume normal behavior. Your saved alert choices are unchanged."
    : state.requesting
      ? "Waiting for system permission…"
      : permission === "denied"
        ? "Notifications are off. Turn them on in your browser or system settings."
        : permission === "unsupported"
          ? "This build can’t show system notifications."
          : permission === "default"
            ? "Allow notifications to receive alerts."
            : null;
  return (
    <section
      className={styles.root}
      aria-labelledby="notification-settings-title"
    >
      <Header id="notification-settings-title" title="Notifications" />
      <div className="grid grid-cols-1 gap-section-gap">
        <section aria-labelledby="notification-categories-title">
          <InlineHeader
            id="notification-categories-title"
            title="Notify me about"
          />
          <SettingsGroup>
            {state.categories.map(({ key, label }) => (
              <SwitchPreferenceRow
                key={key}
                label={label}
                checked={preferences.categories[key] !== false}
                onCheckedChange={(enabled) =>
                  notifications.updatePreferences({
                    categories: { ...preferences.categories, [key]: enabled },
                  })
                }
              />
            ))}
          </SettingsGroup>
        </section>
        <section id="setting-delivery" aria-label="Desktop delivery">
          <InlineHeader title="Delivery" />
          <SettingsGroup>
            <SwitchPreferenceRow
              label="Desktop alerts"
              checked={desktopAlertsEnabled}
              disabled={state.developmentPaused}
              onCheckedChange={(enabled) =>
                notifications.updatePreferences({ enabled })
              }
            />
            {(desktopAlertsEnabled || state.developmentPaused) &&
              (permissionStatus ||
                (!state.systemManaged && !state.developmentPaused)) && (
                <div
                  className={styles.permission}
                  data-warning={
                    state.developmentPaused ||
                    permission === "denied" ||
                    permission === "default" ||
                    permission === "unsupported" ||
                    undefined
                  }
                >
                  {permissionStatus && (
                    <p role="status" className="text-body-sm">
                      {permissionStatus}
                    </p>
                  )}
                  {!state.systemManaged && !state.developmentPaused && (
                    <div className={styles.actions}>
                      {permission === "default" && (
                        <Button
                          type="button"
                          size="sm"
                          variant="link"
                          disabled={state.requesting}
                          onClick={() => void notifications.requestPermission()}
                        >
                          Allow notifications
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="link"
                        disabled={state.requesting}
                        loading={checking}
                        onClick={checkPermission}
                      >
                        Check permission
                      </Button>
                    </div>
                  )}
                </div>
              )}
            {desktopAlertsEnabled && (
              <div className={styles.nestedPreferences}>
                <SwitchPreferenceRow
                  id="setting-viewing"
                  label="Notify while viewing"
                  description="Include direct messages in the conversation you’re viewing."
                  checked={preferences.notifyWhileViewing}
                  onCheckedChange={(notifyWhileViewing) =>
                    notifications.updatePreferences({ notifyWhileViewing })
                  }
                />
                <SwitchPreferenceRow
                  id="setting-sound"
                  label="Sound"
                  description="Choose a sound to preview it."
                  checked={preferences.sound}
                  onCheckedChange={(sound) =>
                    notifications.updatePreferences({ sound })
                  }
                />
                {preferences.sound && (
                  <div className={styles.soundRows}>
                    {SOUND_ROWS.map((category) => (
                      <AlertSoundRow
                        key={category}
                        category={category}
                        disabled={preferences.categories[category] === false}
                        value={preferences.sounds[category]}
                        onChange={(next) => {
                          if (next === preferences.sounds[category]) return;
                          notifications.updatePreferences({
                            sounds: {
                              ...preferences.sounds,
                              [category]: next,
                            },
                          });
                          previewSound(category, next);
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </SettingsGroup>
        </section>
        <UnreadIndicatorSettings
          indicator={notifications.indicator}
          active={active}
        />
        {active && state.preferencesError && (
          <ToastNotice
            title="Notification choices weren’t saved"
            description={state.preferencesError}
          >
            <Button
              type="button"
              size="sm"
              onClick={() => notifications.updatePreferences({})}
            >
              Retry saving choices
            </Button>{" "}
            <Button
              type="button"
              size="sm"
              onClick={() => notifications.reloadPreferences()}
            >
              Reload saved choices
            </Button>
          </ToastNotice>
        )}
        {active && state.error && (
          <ToastNotice
            title="Buzz couldn’t send the notification"
            description={state.error}
          />
        )}
      </div>
    </section>
  );
}
