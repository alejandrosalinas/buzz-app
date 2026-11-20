import {
  sessionScope,
  type SessionScope,
} from "../agent-harness/session-scope";
import { compactAt, withCompactAt } from "./compact-at";
import {
  offRecommended,
  onRecommended,
  type RecommendedCandidate,
} from "./recommended";
import type { Agent } from "./service";

export type AgentSettingsProposal = Readonly<{
  model?: string;
  effort?: string;
  scope?: SessionScope;
  workspace?: string;
  voice?: string;
  apps?: boolean;
  compactAt?: string;
}>;

export type AgentSettingsProposalSupport = Readonly<{
  voice?: true;
  apps?: true;
  compactAt?: true | "unprotected";
  adapterModelAndEffort?: true;
  resolveRecommended?(): Promise<RecommendedCandidate | null>;
}>;

/** Explain when the current agent can no longer accept a proposal. */
export function settingsProposalProblem(
  { apps, workspace, voice, model, effort }: AgentSettingsProposal,
  agent: Pick<Agent, "type" | "protection">,
  executionBinding: Agent["executionBinding"],
  support: AgentSettingsProposalSupport | undefined,
  proposedFromType = agent.type,
) {
  if (agent.type !== proposedFromType)
    return "The agent changed harnesses after this proposal.";
  if (apps === true && agent.protection)
    return "Protected agents cannot enable Codex apps and plugins.";
  if (executionBinding && (apps !== undefined || workspace !== undefined))
    return "The execution adapter manages apps and workspace.";
  if (executionBinding && voice)
    return "Agents using an execution adapter can only propose the default Huddle voice.";
  if (
    executionBinding &&
    !support?.adapterModelAndEffort &&
    (model !== undefined || effort !== undefined)
  )
    return "The execution target for this harness does not support model or thinking proposals.";
}

/** Check the target harness's existing Auto-compact policy. */
export function compactionProposalProblem(
  settings: AgentSettingsProposal,
  target: Readonly<{
    title: string;
    settingsProposal?: AgentSettingsProposalSupport;
  }>,
  protectedAgent: boolean,
) {
  if (settings.compactAt === undefined) return;
  const support = target.settingsProposal?.compactAt;
  if (!support)
    return `${target.title} does not offer an Auto-compact threshold`;
  if (protectedAgent && support === "unprotected")
    return "Protected agents cannot set an Auto-compact threshold in this harness.";
}

/** A model or effort override also turns off Recommended. */
export function settingsProposalMatches(
  config: unknown,
  {
    model,
    effort,
    scope,
    workspace,
    voice,
    apps,
    compactAt: threshold,
  }: AgentSettingsProposal,
) {
  const saved = (config ?? {}) as AgentSettingsProposal;
  const workspacePath = (value: unknown) =>
    (typeof value === "string" && value.trim()) || "~/.buzz";
  return (
    ((model === undefined && effort === undefined) || !onRecommended(saved)) &&
    (model === undefined || model === (saved.model ?? "")) &&
    (effort === undefined || effort === (saved.effort ?? "")) &&
    (scope === undefined || scope === sessionScope(saved.scope)) &&
    (workspace === undefined ||
      workspacePath(workspace) === workspacePath(saved.workspace)) &&
    (voice === undefined || voice === (saved.voice ?? "")) &&
    (apps === undefined || apps === (saved.apps === true)) &&
    (threshold === undefined ||
      compactAt(threshold) === compactAt(saved.compactAt))
  );
}

/** Seed the normal Settings form. The form owns validation and its Save. */
export function applySettingsProposal(
  config: unknown,
  {
    model,
    effort,
    scope,
    workspace,
    voice,
    apps,
    compactAt,
  }: AgentSettingsProposal,
) {
  const draft = {
    ...(config as AgentSettingsProposal),
    ...(model !== undefined && { model }),
    ...(effort !== undefined && { effort }),
    ...(scope !== undefined && { scope }),
    ...(workspace !== undefined && { workspace }),
    ...(voice !== undefined && { voice }),
    ...(apps !== undefined && { apps }),
  };
  const configured =
    compactAt === undefined ? draft : withCompactAt(draft, compactAt);
  return model !== undefined || effort !== undefined
    ? offRecommended(configured)
    : configured;
}
