import { useContext, useSyncExternalStore } from "react";
import { AgentsContext, useTeams } from "../agents/react";
import { useAgentChoices } from "../agents/use-choices";
import {
  templateAgentChoices,
  type AgentChoicesSnapshot,
} from "../agents/choices";
import type { RelaySession } from "../relay/session";
import { templateAgents, type ChannelTemplate } from "./local";

/** Templates add members only from ready inventory and archive evidence. */
export function templateEvidence(choices: AgentChoicesSnapshot) {
  const ready =
    choices.templates.status === "ready" && choices.archives.status === "ready";
  return {
    ready,
    // Still being read, as opposed to failed or unavailable.
    checking:
      !ready &&
      (choices.templates.pending ||
        choices.archives.status === "idle" ||
        choices.archives.status === "loading"),
  };
}

/** A channel template's agents that are the owner's in this community, under
 * New channel's policy. Members not yet checked are neither added nor
 * dropped, so a save waits while `pending`. */
export function useTemplateAgents(
  session: RelaySession,
  template: ChannelTemplate | undefined,
) {
  const teams = useTeams(useContext(AgentsContext));
  const needsAgents =
    !!template?.agents.length ||
    !!template?.teams.some(
      (id) => teams.find((team) => team.id === id)?.members.length,
    );
  const choices = useAgentChoices(session, false, needsAgents);
  const roster = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const evidence = templateEvidence(choices);
  // Workspace defaults apply to every later chat, so a partial read waits
  // too, as chat setup does.
  const ready = evidence.ready && choices.templates.complete;
  const available = new Set(
    ready
      ? templateAgentChoices(choices, roster).map(({ pubkey }) => pubkey)
      : [],
  );
  return {
    agents: template ? templateAgents(template, teams, available) : [],
    pending: needsAgents && !ready,
    checking: needsAgents && evidence.checking,
    retry: () => session.agentChoices.refresh("templates"),
  };
}
