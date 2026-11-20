import { useState, useSyncExternalStore } from "react";
import { communityDestination } from "../../features/communities/destination";
import {
  compactionProposalProblem,
  settingsProposalProblem,
} from "../../features/agents/settings-proposal";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { AgentCreateDialog } from "./AgentCreateDialog";
import type {
  Agent,
  Agents,
  AgentUpdateRequest,
} from "../../features/agents/service";

/** Review proposed changes in the owner dialog, seeded from the target agent. */
export function UpdateReview({ agents }: { agents: Agents }) {
  const requests = useSyncExternalStore(
    agents.subscribe,
    agents.updateRequests,
  );
  const types = useSyncExternalStore(agents.subscribe, agents.types);
  // Agents in every connected community, so a target outside the selected
  // one, or one whose community is offline for now, doesn't block the rest.
  const { running } = useSyncExternalStore(agents.subscribe, agents.snapshot);
  // The one shown stays until saved or closed, even if its agent goes offline
  // or an earlier request's comes back, so the owner's edits aren't lost.
  const [held, hold] = useState<Readonly<{ id: string; agent: Agent }>>();
  const kept = held && requests.find((item) => item.id === held.id);
  const target = (request: AgentUpdateRequest) =>
    running.find((agent) => {
      if (agent.pubkey !== request.agent || agent.owner !== request.owner)
        return false;
      try {
        return communityDestination(agent.relay).url === request.community;
      } catch {
        return false;
      }
    });
  const [request, agent] =
    kept && held
      ? [kept, kept.settings ? held.agent : (target(kept) ?? held.agent)]
      : (requests
          .map((item) => [item, target(item)] as const)
          .find(([, target]) => target) ?? []);
  if (request && agent && (held?.id !== request.id || held.agent !== agent))
    hold({ id: request.id, agent });
  if (!request || !agent) return null;
  const type = types.find(
    (type) => type.key === (request.type ?? request.agentType),
  );
  const problem =
    request.settings &&
    (settingsProposalProblem(
      request.settings,
      agent,
      agent.executionBinding,
      type?.settingsProposal,
      request.agentType,
    ) ??
      (type &&
        compactionProposalProblem(
          request.settings,
          type,
          Boolean(agent.protection),
        )));
  if (problem)
    return (
      <Dialog
        key={request.id}
        open
        title={`Edit ${agent.name}`}
        size="compact"
        closeLabel="Close"
        dismissOnOutsideClick={false}
        onOpenChange={(open) => {
          if (!open) agents.dismissUpdate(request.id);
        }}
      >
        <p role="alert" className="m-0 text-body-sm text-danger">
          {problem} Close this review and ask the agent for a new proposal.
        </p>
      </Dialog>
    );
  return (
    <AgentCreateDialog
      key={request.id}
      agents={agents}
      types={types.filter((type) => !type.remote)}
      community={request.community}
      update={{
        agent,
        request,
        onSave: (input) =>
          request.settings
            ? agents.approveUpdate(request.id, input, agent)
            : agents.approveUpdate(request.id, input),
      }}
      onClose={() => agents.dismissUpdate(request.id)}
      onCreated={() => {}}
    />
  );
}
