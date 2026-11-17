import { pluginCategoryDefinitions } from "../plugin-categories";
import { GearIcon, SquaresFourIcon } from "../../shared/design-system/icons";
import { useEffect, useSyncExternalStore } from "react";
import type { AppServices } from "../services";
import type { SearchDestination, SearchGroup } from "./SearchChoices";
import { MatchRank, matchName, matchRank } from "../../features/search/match";
import { settingsSections } from "../settings-sections";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SwitchPreferenceRow } from "../../shared/design-system/ui/SwitchPreferenceRow";
import { Select } from "../../shared/design-system/ui/Select";
import { Button } from "../../shared/design-system/ui/Button";

const entries = [
  {
    id: "mode",
    label: "Color mode",
    section: "Appearance",
    keywords: "theme light dark system",
  },
  {
    id: "sound",
    label: "Sound",
    section: "Notifications",
    keywords: "audio mute alerts",
  },
  {
    id: "viewing",
    label: "Notify while viewing",
    section: "Notifications",
    keywords: "direct messages conversation alerts",
  },
] as const;

const noSubscribe = () => () => {};
const noSnapshot = () => null;

/** A section opens Settings on Enter, so letters merely in order do not match
 * it: "wes" would find Software updates before a person Wes is found. Word
 * runs still do, as in channel completion. */
function matchSection(label: string, needle: string) {
  const found = matchName(label, needle);
  return found && found.rank <= MatchRank.wordRuns ? found : undefined;
}

function controlDestination(
  key: string,
  label: string,
  detail: string,
  content: import("react").ReactNode,
  rank: number,
): SearchDestination {
  return {
    key,
    label,
    detail,
    icon: GearIcon,
    content,
    rank,
    run: () => {
      const control = document
        .getElementById(key)
        ?.querySelector<HTMLElement>('[role="switch"], [role="combobox"]');
      if (
        control?.getAttribute("aria-disabled") === "true" ||
        control?.hasAttribute("disabled")
      )
        return;
      control?.focus();
    },
  };
}

export function useSearchSettings({
  query,
  appearance,
  notifications,
  plugins,
  adminAccess,
  settingsCards,
  communities,
  navigation,
  close,
  openSection,
}: {
  navigation: AppServices["navigation"];
  close: () => void;
  /** Opens Settings at a section, scoped to the selected community. */
  openSection: (section: string) => void;
  settingsCards?: AppServices["settingsCards"] | undefined;
  communities?: AppServices["communities"] | undefined;
  plugins?: AppServices["plugins"] | undefined;
  adminAccess?: AppServices["adminAccess"] | undefined;
  query: string;
  appearance?: AppServices["appearance"] | undefined;
  notifications?: AppServices["notifications"] | undefined;
}): SearchGroup[] {
  const pluginState = useSyncExternalStore(
    plugins?.subscribe ?? noSubscribe,
    plugins?.snapshot ?? noSnapshot,
  );
  useEffect(() => adminAccess?.ensure(), [adminAccess]);
  // The cards snapshot lists only cards whose visibility has settled visible.
  useEffect(() => settingsCards?.retainVisibility(), [settingsCards]);
  const cards = useSyncExternalStore(
    settingsCards?.subscribe ?? noSubscribe,
    settingsCards?.snapshot ?? noSnapshot,
  );
  const client = useSyncExternalStore(
    communities?.subscribe ?? noSubscribe,
    communities?.snapshot ?? noSnapshot,
  );
  const moderationAccess = useSyncExternalStore(
    adminAccess?.subscribe ?? noSubscribe,
    () => adminAccess?.status("buzz.moderation") ?? "unavailable",
  );
  const staffAccess = useSyncExternalStore(
    adminAccess?.subscribe ?? noSubscribe,
    () => adminAccess?.status("buzz.relay-staff") ?? "unavailable",
  );
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  // The same sections as the Settings sidebar, ahead of their own controls.
  const sections: SearchDestination[] = cards
    ? settingsSections(
        cards,
        client?.memberships.find(({ id }) => id === client.selected),
      ).groups.flatMap((group) =>
        group.sections.flatMap((section) => {
          const match = matchSection(section.label, needle);
          // A group label such as "Buzz" or "Community" names many sections,
          // so it ranks a step behind a section's own label, as a plugin's
          // category does.
          const rank = Math.min(
            match?.rank ?? Infinity,
            (matchSection(group.label, needle)?.rank ?? Infinity) + 1,
          );
          if (!Number.isFinite(rank)) return [];
          return [
            {
              key: "search-section-" + section.id,
              label: section.label,
              detail: group.label,
              icon: section.icon ?? GearIcon,
              rank,
              ...(match?.positions.length ? { matches: match.positions } : {}),
              run: () => openSection(section.id),
            },
          ];
        }),
      )
    : [];
  const controls = entries.flatMap((entry) => {
    if (!(entry.id === "mode" ? appearance : notifications)) return [];
    const rank = Math.min(
      matchRank(entry.label, needle) ?? Infinity,
      matchRank(entry.section, needle) ?? Infinity,
      (matchRank(entry.keywords + " settings", needle) ?? Infinity) + 1,
    );
    if (!Number.isFinite(rank)) return [];
    const key = "search-setting-" + entry.id;
    return [
      {
        ...controlDestination(
          key,
          entry.section,
          entry.label,
          entry.id === "mode" && appearance ? (
            <ColorMode appearance={appearance} />
          ) : notifications && entry.id !== "mode" ? (
            <NotificationPreference
              notifications={notifications}
              entry={entry}
            />
          ) : null,
          rank,
        ),
        run: () => {
          close();
          const section = entry.id === "mode" ? "appearance" : "notifications";
          void navigation
            .open({ version: 1, kind: "settings", section })
            .then((result) => {
              if (result.status !== "opened") return;
              const target = document.getElementById(`setting-${entry.id}`);
              const row =
                target?.closest<HTMLElement>(".buzz-preference-row") ??
                document.getElementById("setting-delivery");
              if (
                !row ||
                row.closest('[hidden], [inert], [aria-hidden="true"]')
              )
                return;
              row.scrollIntoView({ block: "center", behavior: "instant" });
              const control = row.querySelector<HTMLElement>(
                '[role="switch"]:not([aria-disabled="true"]), [role="combobox"]:not([aria-disabled="true"]), button:not(:disabled), input:not(:disabled)',
              );
              if (!control) row.tabIndex = -1;
              (control ?? row).focus({ preventScroll: true });
              row.classList.remove("settings-search-highlight");
              void row.offsetWidth;
              row.classList.add("settings-search-highlight");
              row.addEventListener(
                "animationend",
                () => row.classList.remove("settings-search-highlight"),
                { once: true },
              );
            });
        },
      },
    ];
  });
  const settings = [...sections, ...controls].sort(
    (a, b) => (a.rank ?? 0) - (b.rank ?? 0),
  );
  const pluginRows =
    plugins && pluginState?.configuration.status === "ready"
      ? pluginState.configuration.catalog.plugins
          .flatMap((plugin) => {
            const category =
              pluginCategoryDefinitions.find(
                (item) => item.id === plugin.manifest.discovery?.category,
              )?.label ?? "Other";
            const rank = Math.min(
              matchRank(plugin.manifest.name, needle) ?? Infinity,
              (matchRank(category, needle) ?? Infinity) + 1,
              (matchRank("plugins " + plugin.manifest.description, needle) ??
                Infinity) + 2,
            );
            if (!Number.isFinite(rank)) return [];
            const restricted =
              plugin.source === "bundled" &&
              (plugin.manifest.id === "buzz.moderation" ||
                plugin.manifest.id === "buzz.relay-staff");
            const access =
              plugin.manifest.id === "buzz.moderation"
                ? moderationAccess
                : staffAccess;
            const blocked =
              pluginState.busy ||
              (!plugin.enabled && restricted && access !== "allowed");
            const key = "search-plugin-" + plugin.manifest.id;
            const failure =
              plugin.error ??
              (pluginState.activation[plugin.manifest.id]?.revision ===
              plugin.revision
                ? pluginState.activation[plugin.manifest.id]?.error
                : null);
            return [
              controlDestination(
                key,
                category,
                plugin.manifest.name,
                <>
                  {plugin.manifest.id === "buzz.channels" ? (
                    <PreferenceRow
                      variant="search"
                      icon={<SquaresFourIcon size={21} />}
                      title={category}
                      subtitle={plugin.manifest.name}
                      trailing={
                        <span className="text-body-sm text-subtle">
                          Required
                        </span>
                      }
                    />
                  ) : (
                    <SwitchPreferenceRow
                      variant="search"
                      icon={<SquaresFourIcon size={21} />}
                      label={category}
                      description={plugin.manifest.name}
                      aria-label={`Enable ${plugin.manifest.name}`}
                      checked={plugin.enabled}
                      readOnly={blocked}
                      aria-disabled={blocked}
                      onCheckedChange={() => {
                        if (
                          !pluginState.busy &&
                          (plugin.enabled ||
                            !restricted ||
                            adminAccess?.status(plugin.manifest.id) ===
                              "allowed")
                        )
                          void plugins.change(
                            plugin.enabled ? "disable" : "enable",
                            plugin.manifest.id,
                          );
                      }}
                    />
                  )}
                  {failure && (
                    <p role="alert" className="text-body-sm text-subtle">
                      {failure}
                    </p>
                  )}
                </>,
                rank,
              ),
            ];
          })
          .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
      : [];
  // Each group ranks by its best row, not by its own label, which is just as
  // generic: "plugins" leads with Manage plugins, not the Plugins switches.
  return [
    {
      label: "Settings",
      tone: "page",
      rank: settings[0]?.rank ?? Infinity,
      destinations: settings,
    },
    {
      label: "Plugins",
      tone: "plugin",
      rank: pluginRows[0]?.rank ?? Infinity,
      destinations: pluginRows,
      notice: (
        <>
          {pluginState?.error && (
            <p role="alert" className="text-body-sm text-subtle">
              {pluginState.error}
            </p>
          )}
          {pluginState?.configuration.status === "ready" &&
            pluginState.configuration.externalPluginsPaused && (
              <p className="text-body-sm text-subtle">
                External plugins are paused in safe mode.
              </p>
            )}
        </>
      ),
    },
  ];
}

function ColorMode({ appearance }: { appearance: AppServices["appearance"] }) {
  const state = useSyncExternalStore(appearance.subscribe, appearance.snapshot);
  return (
    <>
      <PreferenceRow
        variant="search"
        icon={<GearIcon size={21} />}
        title="Appearance"
        subtitle="Color mode"
        trailing={
          <Select
            label="Color mode"
            variant="compact"
            value={state.preference}
            groups={[
              {
                label: "",
                options: [
                  { value: "system", label: "System" },
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                ],
              },
            ]}
            onValueChange={(value) => {
              if (value === "system" || value === "light" || value === "dark")
                appearance.setMode(value);
            }}
          />
        }
      />
      {state.error && (
        <p role="alert" className="text-body-sm text-subtle">
          {state.error}{" "}
          <Button
            size="sm"
            onClick={() => appearance.setMode(state.preference)}
          >
            Retry saving
          </Button>
        </p>
      )}
    </>
  );
}

function NotificationPreference({
  notifications,
  entry,
}: {
  notifications: AppServices["notifications"];
  entry: (typeof entries)[1] | (typeof entries)[2];
}) {
  const state = useSyncExternalStore(
    notifications.subscribe,
    notifications.snapshot,
  );
  const key = entry.id === "sound" ? "sound" : "notifyWhileViewing";
  return (
    <>
      <SwitchPreferenceRow
        variant="search"
        icon={<GearIcon size={21} />}
        label="Notifications"
        aria-label={entry.label}
        description={
          state.developmentPaused
            ? entry.label + " · Paused in this development build"
            : entry.label
        }
        checked={state.preferences[key]}
        disabled={state.developmentPaused || !state.preferences.enabled}
        onCheckedChange={(value) =>
          notifications.updatePreferences({ [key]: value })
        }
      />
      {state.preferencesError && (
        <p role="alert" className="text-body-sm text-subtle">
          {state.preferencesError}{" "}
          <Button size="sm" onClick={() => notifications.updatePreferences({})}>
            Retry saving
          </Button>
        </p>
      )}
    </>
  );
}
