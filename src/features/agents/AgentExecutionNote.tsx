import type { ReactNode } from "react";
import { CloudIcon } from "../../shared/design-system/icons";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";

/** Execution guidance sits outside the settings container it explains. */
export function AgentExecutionNote({
  runtime,
  description,
}: {
  runtime?: string;
  description?: ReactNode;
}) {
  // Keep the cue compact; the composer explains where remote work happens.
  return (
    <div role="note">
      <SettingsGroup>
        <PreferenceRow
          icon={<CloudIcon />}
          title="Remote agent"
          subtitle={
            description ??
            (runtime === "block.builderlab/builderlab"
              ? "Runs on a Builderlab machine"
              : undefined)
          }
        />
      </SettingsGroup>
    </div>
  );
}
