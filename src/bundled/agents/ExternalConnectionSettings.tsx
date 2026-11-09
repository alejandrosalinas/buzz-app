import { useSyncExternalStore } from "react";
import {
  type ExternalApps,
  fullAgentAccess,
} from "../../features/agents/external-connection";
import { Header } from "../../shared/design-system/ui/Header";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Button } from "../../shared/design-system/ui/Button";

export function ExternalConnectionSettings({
  connection,
}: {
  connection: ExternalApps;
}) {
  const state = useSyncExternalStore(connection.subscribe, connection.snapshot);
  return (
    <section>
      <Header
        title="External apps"
        subtitle="Apps you authorize can use Buzz through this copy of the app."
      />
      <SettingsGroup layout="form">
        <p className="m-0 text-body-sm text-secondary">
          Start setup in the external app. Buzz asks you to select an agent and
          authorize access. Apps can renew valid approval for another 30 days.
          Approval expires after 30 days without renewal. Apps can restore valid
          access after a restart. Keys stay in Buzz. Keep Buzz open.
        </p>
        {state.grant ? (
          <PreferenceRow
            title={state.grant.client}
            subtitle={
              state.pairing && !fullAgentAccess(state.pairing.approval.scopes)
                ? "This older approval gives limited access, which no longer works. Update the app and start setup again to approve full agent access."
                : state.grant.phase === "connected"
                  ? "Connected"
                  : state.grant.phase === "waiting"
                    ? "Authorized. Waiting for the app to connect."
                    : state.grant.phase === "starting"
                      ? "Authorizing…"
                      : state.pairing
                        ? "Approved. The app can restore this connection."
                        : "Connection ended. Start setup again in the external app."
            }
            trailing={
              state.pairing || state.grant.phase !== "ended" ? (
                <Button
                  variant="outline"
                  onClick={() => void connection.revoke()}
                >
                  Revoke access
                </Button>
              ) : undefined
            }
          />
        ) : (
          <p role="status" className="m-0 text-body-sm text-secondary">
            No external app has access.
          </p>
        )}
        {state.error && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {state.error}
          </p>
        )}
      </SettingsGroup>
    </section>
  );
}
