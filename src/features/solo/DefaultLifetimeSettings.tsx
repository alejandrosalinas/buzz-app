import { useState } from "react";
import {
  CHANNEL_DURATIONS,
  channelDurationLabel,
} from "../../bundled/channels/ChannelDurationField";
import { Select } from "../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { useDefaultLifetime, writeDefaultLifetime } from "./default-lifetime";

/** The lifetime New chat starts Solo chats with, saved as soon as it
 * changes. The same choices as a chat's own lifetime setting. */
export function DefaultLifetimeSettings({ scope }: { scope: string }) {
  const ttlSeconds = useDefaultLifetime(scope);
  const [error, setError] = useState("");
  return (
    <SettingsGroup>
      <Select
        variant="preference"
        label="New Solo chats"
        description="Chats you start with New chat in this community begin with this lifetime. You can change it in a chat’s settings."
        value={ttlSeconds === undefined ? "ongoing" : String(ttlSeconds)}
        valueLabel={
          ttlSeconds === undefined
            ? "Ongoing"
            : `Temporary, ${channelDurationLabel(ttlSeconds)}`
        }
        error={error || undefined}
        groups={[
          {
            label: "",
            options: [
              {
                value: "ongoing",
                label: "Ongoing",
                description: "No automatic archive.",
              },
              ...CHANNEL_DURATIONS.map((seconds) => ({
                value: String(seconds),
                label: `Temporary, ${channelDurationLabel(seconds)}`,
                description: `Archives after ${channelDurationLabel(seconds)} without activity.`,
              })),
            ],
          },
        ]}
        onValueChange={(value) => {
          setError(
            writeDefaultLifetime(
              scope,
              value === "ongoing" ? undefined : Number(value),
            )
              ? ""
              : "Couldn’t save this on this device. Try again.",
          );
        }}
      />
    </SettingsGroup>
  );
}
