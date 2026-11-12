import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  type ExternalApps,
  fullAgentAccess,
} from "../../features/agents/external-connection";
import { Header } from "../../shared/design-system/ui/Header";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Button } from "../../shared/design-system/ui/Button";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";

/** The grant an open confirmation names, as it was when the dialog opened. */
type Confirming = Readonly<{ id: number; client: string; live: boolean }>;

export function ExternalConnectionSettings({
  connection,
}: {
  connection: ExternalApps;
}) {
  const state = useSyncExternalStore(connection.subscribe, connection.snapshot);
  // Takes focus when the Revoke button has gone but the row remains, which
  // happens when the app exits while the confirmation is open.
  const section = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const empty = useRef<HTMLParagraphElement>(null);
  const grant = state.grant;
  // Captured at open, it outlives the row, so the dialog closes only once
  // revoke settles and focus has somewhere to land.
  const [confirming, setConfirming] = useState<Confirming>();
  const [revoking, setRevoking] = useState(false);
  const id = grant?.id;
  // A fresh approval, under any name, can replace the grant while the dialog
  // is open. It was confirmed in its own consent dialog, not this one, so
  // this one closes rather than revoke it.
  useEffect(() => {
    if (confirming && !revoking && id !== confirming.id)
      setConfirming(undefined);
  }, [confirming, revoking, id]);
  const revoke = async () => {
    // The grant can also change between a render and the click.
    if (connection.snapshot().grant?.id !== confirming?.id) {
      setConfirming(undefined);
      return;
    }
    // Cleared first, so a repeated failure is announced again.
    connection.clearError();
    setRevoking(true);
    await connection.revoke();
    setRevoking(false);
    // A refused revoke reports through state.error and keeps the row.
    if (!connection.snapshot().grant) setConfirming(undefined);
  };
  // Shown inside the dialog while it is open, otherwise under the row.
  const error = state.error && (
    <p role="alert" className="m-0 text-body-sm text-danger">
      {state.error}
    </p>
  );
  return (
    <section ref={section} tabIndex={-1} aria-labelledby="external-apps-title">
      <Header
        id="external-apps-title"
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
        {grant ? (
          <PreferenceRow
            title={grant.client}
            subtitle={
              state.pairing && !fullAgentAccess(state.pairing.approval.scopes)
                ? "This older approval gives limited access, which no longer works. Update the app and start setup again to approve full agent access."
                : grant.phase === "connected"
                  ? "Connected"
                  : grant.phase === "waiting"
                    ? "Authorized. Waiting for the app to connect."
                    : grant.phase === "starting"
                      ? "Authorizing…"
                      : state.pairing
                        ? "Approved. The app can restore this connection."
                        : "Connection ended. Start setup again in the external app."
            }
            trailing={
              state.pairing || grant.phase !== "ended" ? (
                <Button
                  ref={trigger}
                  variant="outline"
                  onClick={() => {
                    // An earlier error would otherwise read as a revoke failure.
                    connection.clearError();
                    setConfirming({
                      id: grant.id,
                      client: grant.client,
                      live: grant.phase !== "ended",
                    });
                  }}
                >
                  Revoke access
                </Button>
              ) : undefined
            }
          />
        ) : (
          // Takes focus when a confirmed revoke unmounts the Revoke button.
          <p
            ref={empty}
            tabIndex={-1}
            role="status"
            className="m-0 text-body-sm text-secondary"
          >
            No external app has access.
          </p>
        )}
        {!confirming && error}
      </SettingsGroup>
      {confirming && (
        <AlertDialog
          title={`Revoke access for ${confirming.client}?`}
          description={
            confirming.live
              ? "This ends the connection now. The app must ask for access again before it can use Buzz."
              : "This removes the saved approval. The app must ask for access again before it can use Buzz."
          }
          pending={revoking}
          initialFocus={cancel}
          finalFocus={() =>
            trigger.current?.isConnected
              ? trigger.current
              : (empty.current ?? section.current)
          }
          onClose={() => setConfirming(undefined)}
          actions={
            <>
              <Button
                ref={cancel}
                disabled={revoking}
                onClick={() => setConfirming(undefined)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={revoking}
                onClick={() => void revoke()}
              >
                Revoke access
              </Button>
            </>
          }
        >
          {error}
        </AlertDialog>
      )}
    </section>
  );
}
