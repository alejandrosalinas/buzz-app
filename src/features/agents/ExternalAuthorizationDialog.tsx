import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ExternalApps } from "./external-connection";
import { externalMcpEnabled } from "./external-connection";
import type { Agents } from "./service";
import type { Communities } from "../communities/service";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import { useAgentChoices } from "./use-choices";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Select } from "../../shared/design-system/ui/Select";
import { ToastNotice } from "../../shared/design-system/ui/Toast";

type ConsentProps = { connection: ExternalApps; communities: Communities };
export function ExternalAuthorizationDialog({
  connection,
  agents,
  communities,
  relay,
}: ConsentProps & { agents: Agents; relay: RelayData }) {
  const state = useSyncExternalStore(connection.subscribe, connection.snapshot);
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const transport = useSyncExternalStore(relay.subscribe, relay.snapshot);
  const pending = state.pending;
  useEffect(() => {
    if (pending && client.viewer !== pending.viewer)
      void connection.deny().catch(() => {});
  }, [pending, client.viewer, connection]);
  return (
    <>
      {pending &&
        (transport.status === "ready" &&
        client.viewer === pending.viewer &&
        externalMcpEnabled(client.selected) ? (
          <ReadyConsent
            key={transport.scope}
            session={transport.session}
            agents={agents}
            connection={connection}
            communities={communities}
          />
        ) : (
          <ConsentDialog connection={connection} communities={communities}>
            <p role="status" className="m-0 text-body-sm text-secondary">
              {externalMcpEnabled(client.selected)
                ? "Select a connected community to authorize this app."
                : "External apps are not enabled for this community. Select an enabled community."}
            </p>
          </ConsentDialog>
        ))}
      {state.error && (
        <ToastNotice
          title="External app authorization failed"
          description={state.error}
          onDismiss={connection.clearError}
        />
      )}
    </>
  );
}
function ConsentDialog({
  connection,
  communities,
  actions,
  children,
}: ConsentProps & { actions?: ReactNode; children: ReactNode }) {
  const state = useSyncExternalStore(connection.subscribe, connection.snapshot);
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const request = state.pending?.request;
  const deny = (
    <Button
      variant="outline"
      onClick={() => void connection.deny().catch(() => {})}
    >
      Deny
    </Button>
  );
  return (
    <Dialog
      open={!!request}
      title="Authorize app"
      description={request ? `${request.client} requests access.` : undefined}
      size="compact"
      actions={actions ?? deny}
      onOpenChange={(open) => {
        if (!open) void connection.deny().catch(() => {});
      }}
    >
      {request && (
        <div className="grid gap-4">
          <p className="m-0 text-body-sm text-secondary">
            The requesting app supplies its name. Authorize it only if you
            started setup in that app.
          </p>
          {state.grant && state.grant.phase !== "ended" && (
            <p className="m-0 text-body-sm text-secondary">
              Authorization replaces access for {state.grant.client}. Switching
              communities ends that access immediately, even if you then select
              Deny.
            </p>
          )}
          <Select
            label="Community"
            variant="field"
            value={client.selected ?? ""}
            placeholder="Select a community"
            groups={[
              {
                label: "Your communities",
                options: client.memberships.map((membership) => ({
                  value: membership.id,
                  label: membership.name,
                  disabled: !externalMcpEnabled(membership.id),
                  description: externalMcpEnabled(membership.id)
                    ? undefined
                    : "External apps are not enabled here.",
                })),
              },
            ]}
            onValueChange={(id) => communities.select(id)}
          />
          <p className="m-0 text-body-sm text-secondary">
            Requested access:{" "}
            {request.scope
              .map((scope) =>
                scope === "read"
                  ? "read channels, messages and threads"
                  : scope === "post"
                    ? "post text as the selected agent"
                    : "create private Solo chats with you, the selected agent and your saved Bestie",
              )
              .join("; ")}
            . Keys stay in Buzz.
            {request.version === 2 &&
              " The app can renew valid approval for another 30 days. Approval expires after 30 days without renewal. The app can restore this access after either app restarts. You can revoke it in External apps."}
          </p>
          {children}
          {!state.available && (
            <p role="alert" className="m-0 text-body-sm text-danger">
              Enable Agents in Buzz desktop to authorize external apps.
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
function ReadyConsent({
  session,
  agents,
  connection,
  communities,
}: ConsentProps & { session: RelaySession; agents: Agents }) {
  const choices = useAgentChoices(session, false, true);
  const inventory = useSyncExternalStore(agents.subscribe, agents.snapshot);
  const availability = useSyncExternalStore(agents.subscribe, () =>
    JSON.stringify(
      agents
        .snapshot()
        .agents.filter((agent) => agents.canConnectExternal(agent.key))
        .map((agent) => agent.key),
    ),
  );
  const available = new Set<string>(JSON.parse(availability));
  const state = useSyncExternalStore(connection.subscribe, connection.snapshot);
  const [selected, setSelected] = useState("");
  const eligible = inventory.agents.filter(
    (agent) =>
      agent.place === "here" &&
      !agent.deleting &&
      !agent.protection &&
      choices.selectable.some((choice) => choice.pubkey === agent.pubkey),
  );
  const usable = eligible.filter((agent) => available.has(agent.key));
  const chosen = selected
    ? usable.find((agent) => agent.key === selected)
    : usable.length === 1
      ? usable[0]
      : undefined;
  return (
    <ConsentDialog
      connection={connection}
      communities={communities}
      actions={
        <>
          <Button
            variant="outline"
            onClick={() => void connection.deny().catch(() => {})}
          >
            Deny
          </Button>
          <Button
            disabled={!chosen || !state.available}
            onClick={() => {
              if (chosen && agents.canConnectExternal(chosen.key))
                void connection.approve(chosen.key);
            }}
          >
            Authorize
          </Button>
        </>
      }
    >
      <Select
        label="Agent"
        variant="field"
        placeholder="Select an agent"
        value={chosen?.key ?? ""}
        groups={[
          {
            label: "Agents on this device",
            options: eligible.map((agent) => ({
              value: agent.key,
              label: agent.name,
              disabled: !available.has(agent.key),
              description: available.has(agent.key)
                ? undefined
                : "Unavailable in this copy of Buzz.",
            })),
          },
        ]}
        onValueChange={setSelected}
      />
      {usable.length < eligible.length && (
        <p className="m-0 text-body-sm text-secondary">
          Enable its runtime plugin, or use the Buzz copy that runs this agent.
          You can deny this request and start setup there.
        </p>
      )}
      {!eligible.length && (
        <p className="m-0 text-body-sm text-secondary">
          No eligible agent runs here. Start an agent in this community.
          Protected agents cannot use external connections.
        </p>
      )}
    </ConsentDialog>
  );
}
