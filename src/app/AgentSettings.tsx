import { useState } from "react";
import type { PageNavigation } from "../features/navigation/service";
import type { Agents } from "../features/agents/service";
import { AgentDefaults } from "../bundled/agents/AgentDefaults";
import { BaseInstructions } from "../features/agents/BaseInstructions";
import { Header, InlineHeader } from "../shared/design-system/ui/Header";

import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { SwitchPreferenceRow } from "../shared/design-system/ui/SwitchPreferenceRow";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { Button } from "../shared/design-system/ui/Button";
import {
  setRememberAgentsPreference,
  useRememberAgentsPreference,
} from "../features/messages/mention-preferences";
import { isTauri } from "@tauri-apps/api/core";
import { isApplePlatform } from "../features/shortcuts/format";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { Select } from "../shared/design-system/ui/Select";
import {
  keepAwakeDelays,
  retryKeepAwake,
  setKeepAwakePreference,
  useKeepAwakeApplyError,
  useKeepAwakePreference,
  type KeepAwake,
} from "../features/agents/keep-awake";

const keepAwakeModes = [
  { value: "off", label: "Off" },
  { value: "auto", label: "While agents work" },
  { value: "on", label: "Always" },
] as const;
const delayLabel = (minutes: number) =>
  minutes < 60
    ? `${minutes} minutes`
    : `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;

export function AgentSettings({
  agents,
  active = true,
  navigation,
  onProvider,
  sectionPlugins,
  keepAwakeAvailable = isTauri() && isApplePlatform(navigator.platform),
}: {
  agents?: Agents | undefined;
  active?: boolean;
  navigation?: PageNavigation | undefined;
  onProvider?: ((provider?: string) => void) | undefined;
  /** The names of the plugins that can replace a base instruction section. */
  sectionPlugins?: ((section: string) => readonly string[]) | undefined;
  /** Only the macOS app can keep the computer awake. */
  keepAwakeAvailable?: boolean;
}) {
  const rememberAgents = useRememberAgentsPreference();
  const keepAwake = useKeepAwakePreference();
  const keepAwakeApplyError = useKeepAwakeApplyError();
  const [mentionError, setMentionError] = useState<string | null>(null);
  const [keepAwakeError, setKeepAwakeError] = useState<string | null>(null);
  const changeRememberAgents = (enabled: boolean) =>
    setMentionError(setRememberAgentsPreference(enabled));
  const changeKeepAwake = (change: Partial<KeepAwake>) =>
    setKeepAwakeError(setKeepAwakePreference({ ...keepAwake, ...change }));
  return (
    <section aria-labelledby="agent-settings-title">
      <Header id="agent-settings-title" title="Agent setup" />
      {agents && active && (
        <AgentDefaults
          agents={agents}
          navigation={navigation}
          onProvider={onProvider}
        />
      )}
      <div className="mt-section-gap">
        <InlineHeader title="Agent behavior" />
        <SettingsGroup>
          <SwitchPreferenceRow
            label="Remember mentioned agents"
            description="Keep the same agents selected for your next message in this channel or thread."
            checked={rememberAgents}
            onCheckedChange={changeRememberAgents}
          />
          {keepAwakeAvailable && (
            <PreferenceRow
              title="Keep this Mac awake"
              subtitle="So agents can keep answering. Closing the lid still puts it to sleep."
              trailing={
                <Select
                  label="Keep this Mac awake"
                  variant="compact"
                  value={keepAwake.mode}
                  groups={[{ label: "", options: keepAwakeModes }]}
                  onValueChange={(mode) =>
                    changeKeepAwake({ mode: mode as KeepAwake["mode"] })
                  }
                />
              }
            />
          )}
          {keepAwakeAvailable && keepAwake.mode === "auto" && (
            <PreferenceRow
              title="Stay awake after agents finish"
              trailing={
                <Select
                  label="Stay awake after agents finish"
                  variant="compact"
                  value={String(keepAwake.after)}
                  groups={[
                    {
                      label: "",
                      options: keepAwakeDelays.map((minutes) => ({
                        value: String(minutes),
                        label: delayLabel(minutes),
                      })),
                    },
                  ]}
                  onValueChange={(after) =>
                    changeKeepAwake({ after: Number(after) })
                  }
                />
              }
            />
          )}
        </SettingsGroup>
      </div>
      {agents && (
        <BaseInstructions store={agents.storage} replacedBy={sectionPlugins} />
      )}
      {active && mentionError && (
        <ToastNotice
          title="Agent preference wasn’t saved"
          description={mentionError}
        >
          <Button
            type="button"
            size="sm"
            onClick={() => changeRememberAgents(rememberAgents)}
          >
            Retry saving mentioned agents
          </Button>
        </ToastNotice>
      )}
      {/* One notice at a time; whether the Mac sleeps matters more than
          whether the choice outlives a restart. */}
      {active &&
        (keepAwakeAvailable && keepAwakeApplyError ? (
          <ToastNotice title={keepAwakeApplyError}>
            <Button type="button" size="sm" onClick={retryKeepAwake}>
              Try again
            </Button>
          </ToastNotice>
        ) : (
          keepAwakeError && (
            <ToastNotice
              title="Keep-awake setting wasn’t saved"
              description={keepAwakeError}
            >
              <Button
                type="button"
                size="sm"
                onClick={() => changeKeepAwake(keepAwake)}
              >
                Try again
              </Button>
            </ToastNotice>
          )
        ))}
    </section>
  );
}
