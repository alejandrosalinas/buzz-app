import styles from "./DeveloperSettings.module.css";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { Header, InlineHeader } from "../shared/design-system/ui/Header";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Select } from "../shared/design-system/ui/Select";
import {
  developerSettings,
  isLogLevel,
  logLevel,
  LOG_LEVELS,
  subscribeLogLevel,
} from "../features/developer/logging";
import { clientMetrics } from "../features/developer/client-metrics";
import { ClientMetricsPanel } from "./ClientMetricsPanel";
import { SwitchPreferenceRow } from "../shared/design-system/ui/SwitchPreferenceRow";
import {
  importScenario,
  setImportScenario,
  subscribeImportScenario,
  type ImportScenario,
} from "../features/developer/agent-import-scenario";

const IMPORT_SCENARIOS: readonly { value: ImportScenario; label: string }[] = [
  { value: "off", label: "Real data" },
  { value: "none", label: "Nothing to import" },
  { value: "both", label: "Other communities and old Buzz" },
  { value: "communities", label: "Other communities only" },
  { value: "old", label: "Buzz (Legacy) only" },
];

type BrokerStats = {
  queries: number;
  errors: number;
  media: number;
  connects: number;
};

const STATS_POLL_MS = 5000;

/** Only the pinned development broker serves /api/relay/*. Missing stats in
 * that environment are normal, not an error. */
async function fetchStats(): Promise<BrokerStats | undefined> {
  try {
    const res = await fetch("/api/relay/stats");
    if (!res.ok) return undefined;
    return (await res.json()) as BrokerStats;
  } catch {
    return undefined;
  }
}

export function DeveloperSettings() {
  const level = useSyncExternalStore(subscribeLogLevel, logLevel);
  const scenario = useSyncExternalStore(
    subscribeImportScenario,
    importScenario,
  );
  const [settingsReady, setSettingsReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string>();
  useEffect(() => {
    let alive = true;
    void developerSettings()
      .then(() => {
        if (alive) setSettingsReady(true);
      })
      .catch(() => {
        if (alive)
          setSettingsError(
            "Runtime settings require the local development server.",
          );
      });
    return () => {
      alive = false;
    };
  }, []);
  async function saveLevel(value: string) {
    if (!isLogLevel(value)) return;
    setSaving(true);
    setSettingsError(undefined);
    try {
      await developerSettings(value);
    } catch {
      setSettingsError("Log level wasn’t saved. Try again.");
    } finally {
      setSaving(false);
    }
  }
  const brokerAvailable = import.meta.env.VITE_BUZZ_LIVE === "1";
  const [stats, setStats] = useState<BrokerStats>();

  useEffect(() => {
    if (!brokerAvailable) return;
    let alive = true;
    async function poll() {
      const next = await fetchStats();
      if (alive) setStats(next);
    }
    void poll();
    const timer = setInterval(poll, STATS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <section aria-labelledby="developer-settings-title">
      <Header
        id="developer-settings-title"
        title="Developer"
        subtitle="Activity and diagnostics for this session."
      />
      <div className="grid grid-cols-1 gap-section-gap">
        {brokerAvailable && (
          <section aria-labelledby="broker-activity-title">
            <InlineHeader
              id="broker-activity-title"
              title="Broker activity"
              subtitle="Running totals from the local relay broker. Updates every 5 seconds."
            />
            <SettingsGroup layout="form">
              {stats ? (
                <dl className={styles.metrics}>
                  {(
                    [
                      ["Queries", stats.queries],
                      ["Errors", stats.errors],
                      ["Media", stats.media],
                      ["Connections", stats.connects],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-body-sm text-muted">{label}</dt>
                      <dd className="m-0 text-heading tabular-nums">
                        {Number.isFinite(value) ? value.toLocaleString() : "–"}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p role="status" className="m-0 text-body-sm text-muted">
                  Broker stats aren’t available. Start the development relay
                  broker on this origin to view them.
                </p>
              )}
            </SettingsGroup>
          </section>
        )}
        {clientMetrics.enabled && <ClientMetricsPanel />}
        <div className="space-y-2">
          <InlineHeader title="Runtime settings" />
          <SettingsGroup layout="form">
            <PreferenceRow
              title="Log level"
              subtitle="Saved for this worktree, including browser relay diagnostics."
              trailing={
                <Select
                  label="Log level"
                  variant="compact"
                  value={level}
                  disabled={!settingsReady || saving}
                  onValueChange={(value) => void saveLevel(value)}
                  groups={[
                    {
                      label: "",
                      options: Object.keys(LOG_LEVELS).map((value) => ({
                        value,
                        label: value.charAt(0).toUpperCase() + value.slice(1),
                      })),
                    },
                  ]}
                />
              }
            />
            <p className="m-0 text-body-sm text-subtle">
              Info shows lifecycle messages; Debug shows every broker HTTP
              request and relay WebSocket frame; Trace adds safe protocol
              metadata. Message bodies and credentials are never included.
            </p>
            {settingsError && (
              <p role="alert" className="m-0 text-body-sm text-muted">
                {settingsError}
              </p>
            )}
          </SettingsGroup>
        </div>
        <div className="space-y-2">
          <InlineHeader
            title="Agent import"
            subtitle="Simulated findings leave agents unchanged. Real data uses actual imports, even when shown as a new community."
          />
          <SettingsGroup layout="form">
            <PreferenceRow
              title="What Import finds"
              trailing={
                <Select
                  label="What Import finds"
                  variant="compact"
                  value={scenario.scenario}
                  onValueChange={(value) => {
                    const next = IMPORT_SCENARIOS.find(
                      (item) => item.value === value,
                    );
                    if (next) setImportScenario({ scenario: next.value });
                  }}
                  groups={[{ label: "", options: [...IMPORT_SCENARIOS] }]}
                />
              }
            />
            <SwitchPreferenceRow
              label="Show as a new community"
              description="The Agents page shows no agents or teams here, as a first visit would."
              checked={scenario.empty}
              onCheckedChange={(empty) => setImportScenario({ empty })}
            />
          </SettingsGroup>
        </div>
      </div>
    </section>
  );
}
